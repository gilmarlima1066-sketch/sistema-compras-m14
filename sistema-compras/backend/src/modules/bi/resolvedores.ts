/**
 * Resolvedores de KPI: onde cada codigo do catalogo vira um numero.
 *
 * Esta e a resposta a secao 67. Existe UM resolvedor por codigo de KPI, e
 * todo dashboard pede o KPI pelo codigo. O OTIF do executivo, o do painel de
 * fornecedores e o do de logistica sao literalmente a mesma funcao.
 *
 * Duas regras valem para todos:
 *
 *   1. quando a fonte e um modulo anterior, o resolvedor CHAMA aquele modulo.
 *      OTIF e do 08, taxa de NC e do 09, saving e do 07, MAPE e do 04.
 *      Reimplementar daria dois numeros para a mesma pergunta;
 *   2. sem dado, devolve `calculavel: false` com o motivo. Nunca zero
 *      (regra 6 da secao 71).
 */
import { query } from '../../config/database.js';
import * as entregas from '../entregas/indicadores.service.js';
import {
  calcularCobertura, calcularGiro, dividir, percentual, qualidadeDados,
} from './calculos.js';
import {
  condicoes, dimensoesIgnoradas, type Dimensao, type FiltroGlobal, type Periodo,
} from './filtros.js';

const num = (v: unknown) => Number(v ?? 0);
const ouNulo = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export interface Contexto {
  periodo: Periodo;
  filtro: FiltroGlobal;
  config: Record<string, string>;
}

export interface ValorKpi {
  valor: number | null;
  eventos: number;
  calculavel: boolean;
  motivo?: string;
  /** Dimensoes de filtro que este KPI sabe aplicar. */
  suportadas: Dimensao[];
  /** Numeros auxiliares que a tela usa para explicar o KPI. */
  detalhes?: Record<string, unknown>;
}

export type Resolvedor = (ctx: Contexto) => Promise<ValorKpi>;

const numeroConfig = (cfg: Record<string, string>, chave: string, padrao: number) => {
  const v = Number(cfg[chave]);
  return Number.isFinite(v) ? v : padrao;
};

/** Sem dado nao e zero: e ausencia, com motivo. */
const semDados = (motivo: string, suportadas: Dimensao[], eventos = 0): ValorKpi =>
  ({ valor: null, eventos, calculavel: false, motivo, suportadas });

const comValor = (
  valor: number | null, eventos: number, suportadas: Dimensao[],
  minimo = 1, detalhes?: Record<string, unknown>,
): ValorKpi => {
  if (eventos < minimo) {
    return {
      valor: null, eventos, calculavel: false, suportadas, detalhes,
      motivo: `Amostra insuficiente: ${eventos} evento(s) contra o minimo de ${minimo}`,
    };
  }
  if (valor === null || !Number.isFinite(valor)) {
    return {
      valor: null, eventos, calculavel: false, suportadas, detalhes,
      motivo: 'Indicador nao calculavel com os dados do periodo',
    };
  }
  return { valor, eventos, calculavel: true, suportadas, detalhes };
};

// ---------------------------------------------------------------------------
// Bases reaproveitadas
// ---------------------------------------------------------------------------

const DIM_PEDIDO: Dimensao[] = ['categoria', 'produto', 'fornecedor', 'local', 'comprador'];
const DIM_ESTOQUE: Dimensao[] = ['categoria', 'produto', 'local'];
/**
 * Posicao de estoque: consolidada por produto.
 *
 * Os KPIs de posicao leem `vw_estoque_atual` - a mesma visao oficial do modulo
 * 03 que o drill-down abre. Ela ja soma os locais, entao o filtro por local
 * NAO se aplica a eles e e devolvido em `filtros_ignorados`, em vez de ser
 * ignorado em silencio.
 */
const DIM_POSICAO: Dimensao[] = ['categoria', 'produto'];
const DIM_FORNECEDOR: Dimensao[] = ['fornecedor'];

/** Itens de pedido do periodo, com todas as dimensoes disponiveis. */
async function baseItensPedido(ctx: Contexto) {
  const valores: unknown[] = [ctx.periodo.inicio, ctx.periodo.fim];
  const onde = condicoes(ctx.filtro, {
    categoria: 'p.categoria_id',
    produto: 'oci.produto_id',
    fornecedor: 'oc.fornecedor_id',
    local: 'oc.local_entrega_id',
    comprador: 'oc.comprador_id',
    origem: 'f.origem_fornecedor',
    status: 'oc.status',
  }, valores);

  const { rows } = await query(`
    SELECT count(*)::int AS itens,
           count(DISTINCT oc.id)::int AS pedidos,
           coalesce(sum(oci.valor_total), 0)        AS valor,
           coalesce(sum(oci.quantidade_pedida), 0)  AS quantidade,
           coalesce(sum(oci.quantidade_pendente * oci.preco_unitario), 0) AS pendente,
           coalesce(sum(oc.economia_negociada), 0)  AS economia
      FROM ordem_compra_itens oci
      JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
      JOIN produtos p ON p.id = oci.produto_id
      JOIN fornecedores f ON f.id = oc.fornecedor_id
     WHERE oc.data_emissao BETWEEN $1::date AND $2::date
       AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA') ${onde}`, valores);

  return rows[0] ?? {};
}

/** Posicao de estoque com demanda, filtrada. */
async function baseEstoque(ctx: Contexto) {
  const valores: unknown[] = [];
  const onde = condicoes(ctx.filtro, {
    categoria: 'p.categoria_id',
    produto: 'v.produto_id',
  }, valores);

  const { rows } = await query(`
    SELECT v.produto_id, v.codigo, v.descricao,
           p.categoria_id, v.estoque_minimo, p.estoque_maximo,
           coalesce(p.custo_referencia, 0)     AS custo,
           v.estoque_fisico                    AS fisico,
           v.estoque_disponivel                AS disponivel,
           v.estoque_quarentena                AS quarentena,
           v.estoque_bloqueado                 AS bloqueada,
           v.estoque_em_transito               AS transito,
           coalesce(v.demanda_media_diaria, 0) AS demanda_diaria
      FROM vw_estoque_atual v
      JOIN produtos p ON p.id = v.produto_id
     WHERE p.ativo AND p.deleted_at IS NULL ${onde}`, valores);

  return rows;
}

/** Recebimentos do periodo, filtrados. */
async function baseRecebimentos(ctx: Contexto) {
  const valores: unknown[] = [ctx.periodo.inicio, ctx.periodo.fim];
  const onde = condicoes(ctx.filtro, {
    fornecedor: 'r.fornecedor_id',
    local: 'r.local_id',
  }, valores);

  const { rows } = await query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE r.status = 'APROVADO')::int AS aprovados,
           count(*) FILTER (WHERE r.status = 'APROVADO_PARCIALMENTE')::int AS parciais,
           count(*) FILTER (WHERE r.status = 'REJEITADO')::int AS rejeitados,
           count(*) FILTER (WHERE r.status IN ('AGUARDANDO_CHEGADA','CHEGOU',
                                               'EM_CONFERENCIA','AGUARDANDO_QUALIDADE'))::int
             AS pendentes,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM nao_conformidades n WHERE n.recebimento_id = r.id))::int AS com_nc,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM recebimento_divergencias d WHERE d.recebimento_id = r.id))::int
             AS com_divergencia,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM devolucoes d
              WHERE d.recebimento_id = r.id AND d.status <> 'CANCELADA'))::int AS com_devolucao,
           coalesce(sum(r.valor_recebido), 0) AS valor_recebido,
           avg(EXTRACT(epoch FROM (r.conferencia_fim - r.conferencia_inicio)) / 3600)
             FILTER (WHERE r.conferencia_fim IS NOT NULL
                       AND r.conferencia_inicio IS NOT NULL) AS horas_conferencia,
           count(*) FILTER (WHERE r.conferencia_fim IS NOT NULL
                              AND r.conferencia_inicio IS NOT NULL)::int AS conferidos
      FROM recebimentos r
     WHERE r.data_recebimento BETWEEN $1::date AND $2::date
       AND r.status <> 'CANCELADO' ${onde}`, valores);

  return rows[0] ?? {};
}

// ---------------------------------------------------------------------------
// COMPRAS
// ---------------------------------------------------------------------------

const VALOR_COMPRADO: Resolvedor = async (ctx) => {
  const b = await baseItensPedido(ctx);
  return comValor(num(b.valor), num(b.pedidos), DIM_PEDIDO, 1,
    { pedidos: num(b.pedidos), itens: num(b.itens) });
};

const QUANTIDADE_COMPRADA: Resolvedor = async (ctx) => {
  const b = await baseItensPedido(ctx);
  return comValor(num(b.quantidade), num(b.itens), DIM_PEDIDO);
};

const PRECO_MEDIO: Resolvedor = async (ctx) => {
  const b = await baseItensPedido(ctx);
  const valor = dividir(num(b.valor), num(b.quantidade), 4);
  if (valor === null) {
    return semDados('Sem quantidade comprada no periodo: preco medio nao calculavel',
      DIM_PEDIDO, num(b.itens));
  }
  return comValor(valor, num(b.itens), DIM_PEDIDO, 1,
    { valor: num(b.valor), quantidade: num(b.quantidade) });
};

const VARIACAO_PRECO: Resolvedor = async (ctx) => {
  const valores: unknown[] = [ctx.periodo.inicio, ctx.periodo.fim];
  const onde = condicoes(ctx.filtro, {
    categoria: 'p.categoria_id',
    produto: 'h.produto_id',
    fornecedor: 'h.fornecedor_id',
  }, valores);

  const { rows } = await query(`
    SELECT count(*) FILTER (WHERE h.variacao_percentual IS NOT NULL)::int AS com_variacao,
           sum(h.variacao_percentual * h.quantidade)
             FILTER (WHERE h.variacao_percentual IS NOT NULL) AS soma,
           sum(h.quantidade) FILTER (WHERE h.variacao_percentual IS NOT NULL) AS peso
      FROM vw_historico_precos h
      JOIN produtos p ON p.id = h.produto_id
     WHERE h.data BETWEEN $1::date AND $2::date ${onde}`, valores);

  const r = rows[0] ?? {};
  const peso = num(r.peso);
  const valor = peso > 0 ? dividir(num(r.soma), peso, 2) : null;

  if (valor === null) {
    return semDados(
      'Sem preco anterior comparavel no periodo: variacao nao calculavel',
      ['categoria', 'produto', 'fornecedor'], num(r.com_variacao));
  }
  return comValor(valor, num(r.com_variacao), ['categoria', 'produto', 'fornecedor'], 2);
};

const SAVING: Resolvedor = async (ctx) => {
  const b = await baseItensPedido(ctx);
  // A economia e a que o modulo 07 gravou no pedido. Nao se recalcula aqui:
  // a metodologia de saving e daquele modulo.
  return comValor(num(b.economia), num(b.pedidos), DIM_PEDIDO);
};

const COMPRAS_EM_ABERTO: Resolvedor = async (ctx) => {
  const valores: unknown[] = [];
  const onde = condicoes(ctx.filtro, {
    categoria: 'p.categoria_id',
    produto: 'oci.produto_id',
    fornecedor: 'oc.fornecedor_id',
    local: 'oc.local_entrega_id',
    comprador: 'oc.comprador_id',
  }, valores);

  const { rows } = await query(`
    SELECT count(DISTINCT oc.id)::int AS pedidos,
           coalesce(sum(oci.quantidade_pendente * oci.preco_unitario), 0) AS valor,
           coalesce(sum(oci.quantidade_pendente), 0) AS quantidade
      FROM ordem_compra_itens oci
      JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
      JOIN produtos p ON p.id = oci.produto_id
     WHERE oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA','RECEBIDA')
       AND oci.quantidade_pendente > 0 ${onde}`, valores);

  const r = rows[0] ?? {};
  return comValor(num(r.valor), num(r.pedidos), DIM_PEDIDO, 1,
    { pedidos: num(r.pedidos), quantidade: num(r.quantidade) });
};

const PEDIDOS_ATRASADOS: Resolvedor = async (ctx) => {
  const valores: unknown[] = [];
  const onde = condicoes(ctx.filtro, {
    categoria: 'p.categoria_id',
    produto: 'oci.produto_id',
    fornecedor: 'oc.fornecedor_id',
    comprador: 'oc.comprador_id',
  }, valores);

  const { rows } = await query(`
    SELECT count(DISTINCT oc.id)::int AS pedidos,
           coalesce(sum(oci.quantidade_pendente * oci.preco_unitario), 0) AS valor
      FROM ordem_compra_itens oci
      JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
      JOIN produtos p ON p.id = oci.produto_id
     WHERE oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')
       AND oci.quantidade_pendente > 0
       AND oci.data_prometida IS NOT NULL
       AND oci.data_prometida < CURRENT_DATE ${onde}`, valores);

  const r = rows[0] ?? {};
  // Contagem: zero pedidos atrasados e uma boa noticia legitima, nao ausencia
  // de dado. Por isso este KPI nao exige amostra minima.
  return {
    valor: num(r.pedidos), eventos: num(r.pedidos), calculavel: true,
    suportadas: ['categoria', 'produto', 'fornecedor', 'comprador'],
    detalhes: { valor_pendente: num(r.valor) },
  };
};

const PRAZO_MEDIO_PAGAMENTO: Resolvedor = async (ctx) => {
  const valores: unknown[] = [ctx.periodo.inicio, ctx.periodo.fim];
  const onde = condicoes(ctx.filtro, {
    fornecedor: 'oc.fornecedor_id',
    comprador: 'oc.comprador_id',
  }, valores);

  const { rows } = await query(`
    SELECT avg(cp.dias) AS prazo, count(*)::int AS pedidos
      FROM ordens_compra oc
      JOIN condicoes_pagamento cp ON cp.id = oc.condicao_pagamento_id
     WHERE oc.data_emissao BETWEEN $1::date AND $2::date
       AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA') ${onde}`, valores);

  const r = rows[0] ?? {};
  return comValor(ouNulo(r.prazo), num(r.pedidos), ['fornecedor', 'comprador'], 2);
};

// ---------------------------------------------------------------------------
// PLANEJAMENTO
// ---------------------------------------------------------------------------

const NECESSIDADE_TOTAL: Resolvedor = async (ctx) => {
  const valores: unknown[] = [];
  const onde = condicoes(ctx.filtro, {
    categoria: 'p.categoria_id',
    produto: 'n.produto_id',
    fornecedor: 'n.fornecedor_id',
    local: 'n.local_id',
  }, valores);

  const { rows } = await query(`
    SELECT count(*)::int AS necessidades,
           coalesce(sum(n.valor_estimado), 0) AS valor
      FROM necessidades_compra n
      JOIN produtos p ON p.id = n.produto_id
     WHERE n.status IN ('PENDENTE','EM_ANALISE','APROVADA','AJUSTADA') ${onde}`, valores);

  const r = rows[0] ?? {};
  return comValor(num(r.valor), num(r.necessidades), DIM_ESTOQUE.concat('fornecedor'));
};

const NECESSIDADE_URGENTE: Resolvedor = async (ctx) => {
  const valores: unknown[] = [];
  const onde = condicoes(ctx.filtro, {
    categoria: 'p.categoria_id',
    produto: 'n.produto_id',
    fornecedor: 'n.fornecedor_id',
  }, valores);

  const { rows } = await query(`
    SELECT count(*)::int AS total,
           coalesce(sum(n.valor_estimado), 0) AS valor
      FROM necessidades_compra n
      JOIN produtos p ON p.id = n.produto_id
     WHERE n.status IN ('PENDENTE','EM_ANALISE','APROVADA','AJUSTADA')
       AND n.prioridade IN ('RUPTURA','CRITICA') ${onde}`, valores);

  const r = rows[0] ?? {};
  return {
    valor: num(r.total), eventos: num(r.total), calculavel: true,
    suportadas: ['categoria', 'produto', 'fornecedor'],
    detalhes: { valor: num(r.valor) },
  };
};

// ---------------------------------------------------------------------------
// ESTOQUE
// ---------------------------------------------------------------------------

const VALOR_ESTOQUE: Resolvedor = async (ctx) => {
  const linhas = await baseEstoque(ctx);
  const valor = linhas.reduce(
    (a: number, l: Record<string, any>) => a + num(l.fisico) * num(l.custo), 0);
  const semCusto = linhas.filter((l: Record<string, any>) => num(l.custo) <= 0).length;

  return comValor(valor, linhas.length, DIM_POSICAO, 1, {
    produtos: linhas.length,
    produtos_sem_custo: semCusto,
    metodo: ctx.config['bi.valor_estoque_metodo'] ?? 'CUSTO_REFERENCIA',
    // Produto sem custo entra no total como zero: dizer quantos sao evita que
    // o numero pareca mais completo do que e.
    observacao: semCusto > 0
      ? `${semCusto} produto(s) sem custo de referencia entraram como zero` : undefined,
  });
};

const ESTOQUE_DISPONIVEL: Resolvedor = async (ctx) => {
  const linhas = await baseEstoque(ctx);
  const total = linhas.reduce(
    (a: number, l: Record<string, any>) => a + num(l.disponivel), 0);
  return comValor(total, linhas.length, DIM_POSICAO);
};

const ESTOQUE_QUARENTENA: Resolvedor = async (ctx) => {
  const linhas = await baseEstoque(ctx);
  const total = linhas.reduce(
    (a: number, l: Record<string, any>) => a + num(l.quarentena), 0);
  return comValor(total, linhas.length, DIM_POSICAO);
};

const COBERTURA_MEDIA: Resolvedor = async (ctx) => {
  const linhas = await baseEstoque(ctx);
  const limiares = {
    critica: numeroConfig(ctx.config, 'bi.cobertura_critica_dias', 7),
    atencao: numeroConfig(ctx.config, 'bi.cobertura_atencao_dias', 15),
    excesso: numeroConfig(ctx.config, 'bi.excesso_cobertura_dias', 90),
  };

  // Produto sem demanda fica FORA da media. Incluir com cobertura infinita
  // faria o painel parecer confortavel justamente por causa do estoque parado.
  const comDemanda = linhas
    .map((l: Record<string, any>) =>
      calcularCobertura(num(l.disponivel), num(l.demanda_diaria) > 0
        ? num(l.demanda_diaria) : null, limiares))
    .filter((c) => c.dias !== null);

  if (!comDemanda.length) {
    return semDados(
      'Nenhum produto do recorte tem demanda apurada: cobertura nao calculavel',
      DIM_POSICAO, linhas.length);
  }

  const media = comDemanda.reduce((a, c) => a + (c.dias as number), 0) / comDemanda.length;

  return comValor(Math.round(media * 10) / 10, comDemanda.length, DIM_POSICAO, 1, {
    produtos_avaliados: comDemanda.length,
    produtos_sem_demanda: linhas.length - comDemanda.length,
    em_ruptura: comDemanda.filter((c) => c.situacao === 'RUPTURA').length,
    criticos: comDemanda.filter((c) => c.situacao === 'CRITICA').length,
    em_excesso: comDemanda.filter((c) => c.situacao === 'EXCESSO').length,
  });
};

const GIRO_ESTOQUE: Resolvedor = async (ctx) => {
  const valores: unknown[] = [ctx.periodo.inicio, ctx.periodo.fim];
  const onde = condicoes(ctx.filtro, {
    categoria: 'p.categoria_id',
    produto: 'm.produto_id',
    local: 'm.local_id',
  }, valores);

  const { rows: saidas } = await query(`
    SELECT coalesce(sum(m.quantidade * coalesce(m.custo_unitario,
                                                 p.custo_referencia, 0)), 0) AS valor,
           coalesce(sum(m.quantidade), 0) AS quantidade,
           count(*)::int AS movimentos
      FROM movimentacoes_estoque m
      JOIN produtos p ON p.id = m.produto_id
     WHERE m.created_at >= $1::date AND m.created_at < ($2::date + interval '1 day')
       AND fn_sinal_movimentacao(m.tipo_movimentacao) = -1 ${onde}`, valores);

  const linhas = await baseEstoque(ctx);
  const estoqueAtual = linhas.reduce(
    (a: number, l: Record<string, any>) => a + num(l.fisico) * num(l.custo), 0);

  const s = saidas[0] ?? {};
  const base = (ctx.config['bi.giro_metodo'] ?? 'CUSTO') === 'QUANTIDADE';
  const saidaPeriodo = base ? num(s.quantidade) : num(s.valor);
  const estoqueBase = base
    ? linhas.reduce((a: number, l: Record<string, any>) => a + num(l.fisico), 0)
    : estoqueAtual;

  // O estoque inicial seria estoque atual + saidas - entradas. Sem historico
  // de saldo por dia, usa-se estoque atual + saidas como aproximacao do
  // inicial. A aproximacao esta declarada na formula do dicionario.
  const giro = calcularGiro({
    saidas: saidaPeriodo,
    estoqueInicial: estoqueBase + saidaPeriodo,
    estoqueFinal: estoqueBase,
    diasPeriodo: ctx.periodo.dias,
  });

  if (giro.giroAnualizado === null) {
    return semDados(giro.motivo ?? 'Giro nao calculavel', DIM_ESTOQUE, num(s.movimentos));
  }
  return comValor(giro.giroAnualizado, num(s.movimentos), DIM_ESTOQUE, 1, {
    base: base ? 'QUANTIDADE' : 'CUSTO',
    saidas: giro.saidas,
    estoque_medio: giro.estoqueMedio,
    dias_estoque: giro.diasEstoque,
    formula: giro.formula,
  });
};

/** Produtos em ruptura: demanda apurada e disponivel zerado. */
async function rupturas(ctx: Contexto) {
  const linhas = await baseEstoque(ctx);
  return linhas.filter((l: Record<string, any>) =>
    num(l.demanda_diaria) > 0 && num(l.disponivel) <= 0);
}

const PRODUTOS_RUPTURA: Resolvedor = async (ctx) => {
  const linhas = await baseEstoque(ctx);
  const emRuptura = linhas.filter((l: Record<string, any>) =>
    num(l.demanda_diaria) > 0 && num(l.disponivel) <= 0);
  const comDemanda = linhas.filter((l: Record<string, any>) => num(l.demanda_diaria) > 0);

  if (!comDemanda.length) {
    return semDados(
      'Nenhum produto do recorte tem demanda apurada: ruptura nao identificavel',
      DIM_POSICAO, linhas.length);
  }
  return {
    valor: emRuptura.length, eventos: comDemanda.length, calculavel: true,
    suportadas: DIM_POSICAO,
    detalhes: {
      produtos_com_demanda: comDemanda.length,
      percentual: percentual(emRuptura.length, comDemanda.length),
    },
  };
};

const VALOR_RUPTURA: Resolvedor = async (ctx) => {
  const emRuptura = await rupturas(ctx);
  const valor = emRuptura.reduce(
    (a: number, l: Record<string, any>) => a + num(l.demanda_diaria) * num(l.custo), 0);
  return {
    valor: Math.round(valor * 100) / 100,
    eventos: emRuptura.length, calculavel: true, suportadas: DIM_POSICAO,
    detalhes: { produtos: emRuptura.length, base: 'demanda diaria valorizada' },
  };
};

/** Produtos acima da cobertura maxima ou do estoque maximo. */
interface LinhaExcesso {
  produto_id: number;
  codigo: string;
  descricao: string;
  disponivel: number;
  demanda_diaria: number;
  custo: number;
  maximo: number;
  excedente: number;
  valor_excedente: number;
  cobertura: number | null;
}

async function excessos(ctx: Contexto): Promise<LinhaExcesso[]> {
  const linhas = await baseEstoque(ctx);
  const limite = numeroConfig(ctx.config, 'bi.excesso_cobertura_dias', 90);

  return linhas
    .map((l: Record<string, any>): LinhaExcesso | null => {
      const demanda = num(l.demanda_diaria);
      const disponivel = num(l.disponivel);
      const maximoPorCobertura = demanda > 0 ? demanda * limite : null;
      const maximoCadastro = num(l.estoque_maximo) > 0 ? num(l.estoque_maximo) : null;

      const maximo = maximoPorCobertura !== null && maximoCadastro !== null
        ? Math.min(maximoPorCobertura, maximoCadastro)
        : maximoPorCobertura ?? maximoCadastro;

      if (maximo === null || disponivel <= maximo) return null;
      const excedente = disponivel - maximo;
      return {
        produto_id: Number(l.produto_id),
        codigo: l.codigo,
        descricao: l.descricao,
        disponivel,
        demanda_diaria: demanda,
        custo: num(l.custo),
        maximo,
        excedente,
        valor_excedente: excedente * num(l.custo),
        cobertura: demanda > 0 ? disponivel / demanda : null,
      };
    })
    .filter((l): l is LinhaExcesso => l !== null);
}

const PRODUTOS_EXCESSO: Resolvedor = async (ctx) => {
  const linhas = await baseEstoque(ctx);
  const emExcesso = await excessos(ctx);
  return {
    valor: emExcesso.length, eventos: linhas.length, calculavel: true,
    suportadas: DIM_POSICAO,
    detalhes: {
      limite_cobertura_dias: numeroConfig(ctx.config, 'bi.excesso_cobertura_dias', 90),
      produtos_avaliados: linhas.length,
    },
  };
};

const VALOR_EXCESSO: Resolvedor = async (ctx) => {
  const emExcesso = await excessos(ctx);
  const valor = emExcesso.reduce((a, l) => a + l.valor_excedente, 0);
  return {
    valor: Math.round(valor * 100) / 100,
    eventos: emExcesso.length, calculavel: true, suportadas: DIM_POSICAO,
  };
};

const ESTOQUE_PARADO: Resolvedor = async (ctx) => {
  const dias = numeroConfig(ctx.config, 'bi.estoque_parado_dias', 90);
  const valores: unknown[] = [dias];
  const onde = condicoes(ctx.filtro, {
    categoria: 'p.categoria_id',
    produto: 'e.produto_id',
    local: 'e.local_id',
  }, valores);

  const { rows } = await query(`
    SELECT count(*)::int AS parados,
           coalesce(sum(e.quantidade_fisica * coalesce(p.custo_referencia, 0)), 0) AS valor
      FROM estoques e
      JOIN produtos p ON p.id = e.produto_id
     WHERE e.quantidade_fisica > 0
       AND p.ativo AND p.deleted_at IS NULL
       AND (e.ultima_saida IS NULL
            OR e.ultima_saida < now() - make_interval(days => $1::int)) ${onde}`, valores);

  const r = rows[0] ?? {};
  return {
    valor: num(r.parados), eventos: num(r.parados), calculavel: true,
    suportadas: DIM_ESTOQUE,
    detalhes: { dias_sem_movimento: dias, valor_parado: num(r.valor) },
  };
};

const ESTOQUE_CRITICO: Resolvedor = async (ctx) => {
  const valores: unknown[] = [];
  const onde = condicoes(ctx.filtro, {
    categoria: 'p.categoria_id',
    produto: 'v.produto_id',
  }, valores);

  const { rows } = await query(`
    SELECT count(*)::int AS criticos
      FROM vw_produtos_criticos v
      JOIN produtos p ON p.id = v.produto_id
     WHERE v.situacao IN ('RUPTURA','CRITICO','ABAIXO_MINIMO','REPOR') ${onde}`, valores);

  return {
    valor: num(rows[0]?.criticos), eventos: num(rows[0]?.criticos), calculavel: true,
    suportadas: ['categoria', 'produto'],
  };
};

// ---------------------------------------------------------------------------
// DEMANDA - fonte: modulo 04
// ---------------------------------------------------------------------------

const DEMANDA_MEDIA_DIARIA: Resolvedor = async (ctx) => {
  const linhas = await baseEstoque(ctx);
  const comDemanda = linhas.filter((l: Record<string, any>) => num(l.demanda_diaria) > 0);
  if (!comDemanda.length) {
    return semDados('Nenhum produto do recorte tem demanda apurada',
      DIM_POSICAO, linhas.length);
  }
  const total = comDemanda.reduce(
    (a: number, l: Record<string, any>) => a + num(l.demanda_diaria), 0);
  return comValor(Math.round((total / comDemanda.length) * 1000) / 1000,
    comDemanda.length, DIM_POSICAO);
};

const ACURACIDADE_PREVISAO: Resolvedor = async (ctx) => {
  const valores: unknown[] = [ctx.periodo.inicio, ctx.periodo.fim];
  const onde = condicoes(ctx.filtro, {
    categoria: 'p.categoria_id',
    produto: 'pr.produto_id',
  }, valores);

  // O MAPE e do modulo 04 e ja esta gravado na previsao. Aqui so se le.
  const { rows } = await query(`
    SELECT avg(pr.mape) FILTER (WHERE pr.mape IS NOT NULL) AS mape,
           count(*) FILTER (WHERE pr.mape IS NOT NULL)::int AS avaliadas,
           count(*)::int AS previsoes
      FROM previsoes_demanda pr
      JOIN produtos p ON p.id = pr.produto_id
     WHERE pr.periodo_fim BETWEEN $1::date AND $2::date ${onde}`, valores);

  const r = rows[0] ?? {};
  const mape = ouNulo(r.mape);
  if (mape === null) {
    return semDados(
      'Nenhuma previsao do periodo tem realizado apurado: acuracidade nao calculavel',
      ['categoria', 'produto'], num(r.previsoes));
  }
  return comValor(Math.max(0, Math.round((100 - mape) * 100) / 100),
    num(r.avaliadas), ['categoria', 'produto'], 3,
    { mape: Math.round(mape * 100) / 100, previsoes_avaliadas: num(r.avaliadas) });
};

const PRODUTOS_SAZONAIS: Resolvedor = async (ctx) => {
  const valores: unknown[] = [];
  const onde = condicoes(ctx.filtro, {
    categoria: 'p.categoria_id',
    produto: 'pr.produto_id',
  }, valores);

  const { rows } = await query(`
    SELECT count(DISTINCT pr.produto_id)::int AS sazonais
      FROM previsoes_demanda pr
      JOIN produtos p ON p.id = pr.produto_id
     WHERE pr.sazonal = true ${onde}`, valores);

  return {
    valor: num(rows[0]?.sazonais), eventos: num(rows[0]?.sazonais), calculavel: true,
    suportadas: ['categoria', 'produto'],
  };
};

// ---------------------------------------------------------------------------
// LOGISTICA - fonte: modulo 08 (metodologia oficial de OTIF)
// ---------------------------------------------------------------------------

/**
 * Chama o modulo 08 com a janela e o fornecedor do filtro.
 *
 * O modulo 08 aceita recorte por fornecedor. Categoria, produto e local NAO
 * sao aplicaveis pela funcao dele, entao saem como dimensoes ignoradas em vez
 * de serem aceitas de mentira.
 */
async function indicadoresEntrega(ctx: Contexto): Promise<Record<string, any>> {
  const filtro = {
    dias: ctx.periodo.dias,
    data_inicio: ctx.periodo.inicio,
    data_fim: ctx.periodo.fim,
  } as any;

  // As duas funcoes do modulo 08 devolvem o mesmo bloco de indicadores em
  // formatos diferentes: a de fornecedor aninha em `indicadores`, a geral
  // espalha no topo. A metodologia e a mesma - so o empacotamento muda.
  if (ctx.filtro.fornecedor_id) {
    const r = await entregas.performanceFornecedor(ctx.filtro.fornecedor_id, filtro);
    return r.indicadores as Record<string, any>;
  }
  return await entregas.indicadoresOtif(filtro) as unknown as Record<string, any>;
}

const kpiEntrega = (campo: 'otif' | 'otd' | 'inFull' | 'atrasoMedio'): Resolvedor =>
  async (ctx) => {
    const ind = await indicadoresEntrega(ctx);
    const avaliadas = num(ind.avaliadas);
    const valor = ouNulo(ind[campo]);

    if (valor === null) {
      return semDados(
        ind.motivo ?? 'Nenhuma entrega elegivel no periodo: indicador nao calculavel',
        DIM_FORNECEDOR, avaliadas);
    }
    return comValor(valor, avaliadas, DIM_FORNECEDOR, 3, {
      entregas_avaliadas: avaliadas,
      nao_avaliaveis: ouNulo(ind.naoAvaliaveis),
      formula: ind.formula,
    });
  };

const LEAD_TIME_REAL: Resolvedor = async (ctx) => {
  const valores: unknown[] = [ctx.periodo.inicio, ctx.periodo.fim];
  const onde = condicoes(ctx.filtro, {
    fornecedor: 'oc.fornecedor_id',
    local: 'e.local_id',
  }, valores);

  const { rows } = await query(`
    SELECT avg(e.data_real - oc.data_emissao) AS lead,
           count(*)::int AS entregas
      FROM entregas e
      JOIN ordens_compra oc ON oc.id = e.ordem_compra_id
     WHERE e.data_real BETWEEN $1::date AND $2::date ${onde}`, valores);

  const r = rows[0] ?? {};
  return comValor(ouNulo(r.lead), num(r.entregas), ['fornecedor', 'local'], 3);
};

const ENTREGAS_ATRASADAS: Resolvedor = async (ctx) => {
  const valores: unknown[] = [];
  const onde = condicoes(ctx.filtro, {
    categoria: 'p.categoria_id',
    produto: 'oci.produto_id',
    fornecedor: 'oc.fornecedor_id',
  }, valores);

  const { rows } = await query(`
    SELECT count(*)::int AS itens
      FROM ordem_compra_itens oci
      JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
      JOIN produtos p ON p.id = oci.produto_id
     WHERE oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')
       AND oci.quantidade_pendente > 0
       AND oci.data_prometida IS NOT NULL
       AND oci.data_prometida < CURRENT_DATE ${onde}`, valores);

  return {
    valor: num(rows[0]?.itens), eventos: num(rows[0]?.itens), calculavel: true,
    suportadas: ['categoria', 'produto', 'fornecedor'],
  };
};

// ---------------------------------------------------------------------------
// FORNECEDORES - fonte: modulo 10
// ---------------------------------------------------------------------------

const SCORE_FORNECEDOR: Resolvedor = async (ctx) => {
  const valores: unknown[] = [ctx.periodo.inicio, ctx.periodo.fim];
  const onde = condicoes(ctx.filtro, { fornecedor: 'a.fornecedor_id' }, valores);

  const { rows } = await query(`
    SELECT avg(a.score_final) FILTER (WHERE a.score_final IS NOT NULL) AS score,
           count(*) FILTER (WHERE a.score_final IS NOT NULL)::int AS com_score,
           count(*)::int AS avaliacoes
      FROM avaliacoes_fornecedores a
     WHERE a.periodo_fim BETWEEN $1::date AND $2::date
       AND a.status <> 'CANCELADA' ${onde}`, valores);

  const r = rows[0] ?? {};
  if (ouNulo(r.score) === null) {
    return semDados(
      'Nenhuma avaliacao do periodo tem score: dados insuficientes no modulo 10',
      DIM_FORNECEDOR, num(r.avaliacoes));
  }
  return comValor(Math.round(num(r.score) * 10) / 10, num(r.com_score), DIM_FORNECEDOR, 1,
    { avaliacoes: num(r.avaliacoes), sem_score: num(r.avaliacoes) - num(r.com_score) });
};

const contagemFornecedor = (status: string): Resolvedor => async () => {
  const { rows } = await query(`
    SELECT count(*)::int AS total FROM fornecedores
     WHERE deleted_at IS NULL AND status_homologacao = $1::status_homologacao_enum`,
    [status]);
  return {
    valor: num(rows[0]?.total), eventos: num(rows[0]?.total), calculavel: true,
    suportadas: [],
  };
};

// ---------------------------------------------------------------------------
// RECEBIMENTO e QUALIDADE - fonte: modulo 09
// ---------------------------------------------------------------------------

const RECEBIMENTOS_PENDENTES: Resolvedor = async (ctx) => {
  const valores: unknown[] = [];
  const onde = condicoes(ctx.filtro, {
    fornecedor: 'r.fornecedor_id', local: 'r.local_id',
  }, valores);

  const { rows } = await query(`
    SELECT count(*)::int AS pendentes FROM recebimentos r
     WHERE r.status IN ('AGUARDANDO_CHEGADA','CHEGOU','EM_CONFERENCIA',
                        'AGUARDANDO_QUALIDADE') ${onde}`, valores);

  return {
    valor: num(rows[0]?.pendentes), eventos: num(rows[0]?.pendentes), calculavel: true,
    suportadas: ['fornecedor', 'local'],
  };
};

const TEMPO_CONFERENCIA: Resolvedor = async (ctx) => {
  const b = await baseRecebimentos(ctx);
  return comValor(ouNulo(b.horas_conferencia), num(b.conferidos), ['fornecedor', 'local'], 3);
};

const taxaRecebimento = (
  campo: 'aprovados' | 'com_nc' | 'com_divergencia' | 'com_devolucao',
): Resolvedor => async (ctx) => {
  const b = await baseRecebimentos(ctx);
  const total = num(b.total);
  if (total === 0) {
    return semDados('Sem recebimentos no periodo: taxa nao calculavel',
      ['fornecedor', 'local'], 0);
  }
  return comValor(percentual(num(b[campo]), total), total, ['fornecedor', 'local'], 3,
    { recebimentos: total, ocorrencias: num(b[campo]) });
};

const NC_CRITICAS: Resolvedor = async (ctx) => {
  const valores: unknown[] = [ctx.periodo.inicio, ctx.periodo.fim];
  const onde = condicoes(ctx.filtro, {
    fornecedor: 'n.fornecedor_id', produto: 'n.produto_id',
  }, valores);

  const { rows } = await query(`
    SELECT count(*)::int AS criticas FROM nao_conformidades n
     WHERE n.severidade = 'CRITICA'
       AND n.created_at >= $1::date
       AND n.created_at < ($2::date + interval '1 day') ${onde}`, valores);

  return {
    valor: num(rows[0]?.criticas), eventos: num(rows[0]?.criticas), calculavel: true,
    suportadas: ['fornecedor', 'produto'],
  };
};

const VALOR_RECEBIDO: Resolvedor = async (ctx) => {
  const b = await baseRecebimentos(ctx);
  return comValor(num(b.valor_recebido), num(b.total), ['fornecedor', 'local']);
};

const COMPROMISSO_FUTURO: Resolvedor = COMPRAS_EM_ABERTO;

// ---------------------------------------------------------------------------
// IMPORTACAO
// ---------------------------------------------------------------------------

async function baseImportacao(ctx: Contexto) {
  const valores: unknown[] = [ctx.periodo.inicio, ctx.periodo.fim];
  const onde = condicoes(ctx.filtro, {
    fornecedor: 'oc.fornecedor_id', comprador: 'oc.comprador_id',
  }, valores);

  const { rows } = await query(`
    SELECT count(*)::int AS pedidos,
           coalesce(sum(oc.valor_total), 0) AS valor,
           count(*) FILTER (WHERE oc.eta_atual IS NOT NULL
                              AND oc.eta_atual < CURRENT_DATE
                              AND oc.status NOT IN ('RECEBIDA','CANCELADA'))::int
             AS atrasados
      FROM ordens_compra oc
      JOIN fornecedores f ON f.id = oc.fornecedor_id
     WHERE oc.data_emissao BETWEEN $1::date AND $2::date
       AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')
       AND (oc.incoterm IS NOT NULL OR f.origem_fornecedor <> 'NACIONAL') ${onde}`, valores);

  return rows[0] ?? {};
}

const PEDIDOS_IMPORTACAO: Resolvedor = async (ctx) => {
  const b = await baseImportacao(ctx);
  return {
    valor: num(b.pedidos), eventos: num(b.pedidos), calculavel: true,
    suportadas: ['fornecedor', 'comprador'],
    detalhes: { atrasados: num(b.atrasados) },
  };
};

const VALOR_IMPORTACAO: Resolvedor = async (ctx) => {
  const b = await baseImportacao(ctx);
  return comValor(num(b.valor), num(b.pedidos), ['fornecedor', 'comprador']);
};

// ---------------------------------------------------------------------------
// RISCOS e GOVERNANCA
// ---------------------------------------------------------------------------

const PRODUTOS_MONOPROVEDOR: Resolvedor = async (ctx) => {
  const valores: unknown[] = [];
  const onde = condicoes(ctx.filtro, {
    categoria: 'p.categoria_id', produto: 'p.id',
  }, valores);

  const { rows } = await query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE x.fornecedores = 1)::int AS monoprovedor
      FROM (
        SELECT pf.produto_id, count(DISTINCT pf.fornecedor_id)::int AS fornecedores
          FROM produto_fornecedor pf
          JOIN fornecedores f ON f.id = pf.fornecedor_id
         WHERE pf.ativo AND f.ativo AND f.deleted_at IS NULL
         GROUP BY pf.produto_id
      ) x
      JOIN produtos p ON p.id = x.produto_id
     WHERE p.ativo AND p.deleted_at IS NULL ${onde}`, valores);

  const r = rows[0] ?? {};
  return {
    valor: num(r.monoprovedor), eventos: num(r.total), calculavel: true,
    suportadas: ['categoria', 'produto'],
    detalhes: {
      produtos_com_fornecedor: num(r.total),
      percentual: percentual(num(r.monoprovedor), num(r.total)),
      observacao: 'Informacao de risco de concentracao. Nao bloqueia compra',
    },
  };
};

const QUALIDADE_DADOS: Resolvedor = async (ctx) => {
  const minimo = numeroConfig(ctx.config, 'bi.qualidade_dados_minimo', 80);

  const { rows: produtos } = await query(`
    SELECT count(*)::int AS total,
           count(categoria_id)::int          AS com_categoria,
           count(*) FILTER (WHERE custo_referencia > 0)::int AS com_custo,
           count(*) FILTER (WHERE estoque_minimo > 0)::int   AS com_minimo,
           count(classificacao_abc)::int     AS com_abc,
           count(*) FILTER (WHERE lead_time_padrao_dias > 0)::int AS com_lead_time
      FROM produtos WHERE ativo AND deleted_at IS NULL`);

  const { rows: fornecedores } = await query(`
    SELECT count(*)::int AS total,
           count(cnpj)::int  AS com_cnpj,
           count(email)::int AS com_email,
           count(*) FILTER (WHERE lead_time_padrao_dias > 0)::int AS com_lead_time,
           count(*) FILTER (WHERE prazo_medio_pagamento > 0)::int AS com_prazo
      FROM fornecedores WHERE ativo AND deleted_at IS NULL`);

  const { rows: vinculo } = await query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE preco_atual > 0)::int  AS com_preco,
           count(*) FILTER (WHERE lead_time_dias > 0)::int AS com_lead_time
      FROM produto_fornecedor pf
      JOIN fornecedores f ON f.id = pf.fornecedor_id
     WHERE pf.ativo AND f.ativo AND f.deleted_at IS NULL`);

  const p = produtos[0]; const f = fornecedores[0]; const v = vinculo[0];

  const resultado = qualidadeDados([
    { campo: 'produto.categoria', preenchidos: num(p.com_categoria), total: num(p.total), obrigatorio: true },
    { campo: 'produto.custo_referencia', preenchidos: num(p.com_custo), total: num(p.total), obrigatorio: true },
    { campo: 'produto.estoque_minimo', preenchidos: num(p.com_minimo), total: num(p.total), obrigatorio: true },
    { campo: 'produto.classificacao_abc', preenchidos: num(p.com_abc), total: num(p.total), obrigatorio: false },
    { campo: 'produto.lead_time', preenchidos: num(p.com_lead_time), total: num(p.total), obrigatorio: false },
    { campo: 'fornecedor.cnpj', preenchidos: num(f.com_cnpj), total: num(f.total), obrigatorio: true },
    { campo: 'fornecedor.email', preenchidos: num(f.com_email), total: num(f.total), obrigatorio: false },
    { campo: 'fornecedor.lead_time', preenchidos: num(f.com_lead_time), total: num(f.total), obrigatorio: true },
    { campo: 'fornecedor.prazo_pagamento', preenchidos: num(f.com_prazo), total: num(f.total), obrigatorio: false },
    { campo: 'produto_fornecedor.preco', preenchidos: num(v.com_preco), total: num(v.total), obrigatorio: true },
    { campo: 'produto_fornecedor.lead_time', preenchidos: num(v.com_lead_time), total: num(v.total), obrigatorio: false },
  ], minimo);

  if (resultado.completude === null) {
    return semDados('Sem cadastros ativos para avaliar completude', [], 0);
  }
  return comValor(resultado.completude, resultado.registros, [], 1, {
    campos: resultado.campos,
    criticos: resultado.criticos,
    formula: resultado.formula,
  });
};

// ---------------------------------------------------------------------------
// Registro: codigo -> resolvedor
// ---------------------------------------------------------------------------

export const RESOLVEDORES: Record<string, Resolvedor> = {
  // Compras
  VALOR_COMPRADO,
  QUANTIDADE_COMPRADA,
  PRECO_MEDIO,
  VARIACAO_PRECO,
  SAVING,
  COMPRAS_EM_ABERTO,
  PEDIDOS_ATRASADOS,
  PRAZO_MEDIO_PAGAMENTO,
  NECESSIDADE_TOTAL,
  NECESSIDADE_URGENTE,
  // Estoque
  VALOR_ESTOQUE,
  ESTOQUE_DISPONIVEL,
  ESTOQUE_QUARENTENA,
  COBERTURA_MEDIA,
  GIRO_ESTOQUE,
  PRODUTOS_RUPTURA,
  VALOR_RUPTURA,
  PRODUTOS_EXCESSO,
  VALOR_EXCESSO,
  ESTOQUE_PARADO,
  ESTOQUE_CRITICO,
  // Demanda
  DEMANDA_MEDIA_DIARIA,
  ACURACIDADE_PREVISAO,
  PRODUTOS_SAZONAIS,
  // Logistica - todos pela metodologia do modulo 08
  OTIF: kpiEntrega('otif'),
  OTD: kpiEntrega('otd'),
  IN_FULL: kpiEntrega('inFull'),
  ATRASO_MEDIO: kpiEntrega('atrasoMedio'),
  LEAD_TIME_REAL,
  ENTREGAS_ATRASADAS,
  // Fornecedores
  SCORE_FORNECEDOR,
  FORNECEDORES_MONITORADOS: contagemFornecedor('EM_MONITORAMENTO'),
  FORNECEDORES_BLOQUEADOS: contagemFornecedor('BLOQUEADO'),
  // Recebimento e qualidade
  RECEBIMENTOS_PENDENTES,
  TEMPO_CONFERENCIA,
  TAXA_DIVERGENCIA: taxaRecebimento('com_divergencia'),
  TAXA_APROVACAO: taxaRecebimento('aprovados'),
  TAXA_NC: taxaRecebimento('com_nc'),
  TAXA_DEVOLUCAO: taxaRecebimento('com_devolucao'),
  NC_CRITICAS,
  // Financeiro
  VALOR_RECEBIDO,
  COMPROMISSO_FUTURO,
  // Importacao
  PEDIDOS_IMPORTACAO,
  VALOR_IMPORTACAO,
  // Riscos e governanca
  PRODUTOS_MONOPROVEDOR,
  QUALIDADE_DADOS,
};

/** Codigos sem resolvedor: o catalogo os mostra como nao apurados. */
export const semResolvedor = (codigos: string[]) =>
  codigos.filter((c) => !RESOLVEDORES[c.toUpperCase()]);

export { dimensoesIgnoradas, excessos, rupturas };
