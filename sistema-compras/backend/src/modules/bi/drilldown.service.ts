/**
 * Drill-down (secoes 43 a 46 e 72).
 *
 * O caminho e sempre: dashboard -> indicador -> lista -> registro. Cada nivel
 * devolve linhas COM o identificador do registro original, para a tela poder
 * abrir o pedido, o recebimento ou a NC de verdade (secao 73).
 *
 * Regra 9 da secao 71: este arquivo so le. Nenhum atalho executa acao.
 */
import { query } from '../../config/database.js';
import { naoEncontrado } from '../../core/errors.js';
import { condicoes, resolverPeriodo, type FiltroGlobal } from './filtros.js';
import { configuracoes, numeroConfig } from './kpi.service.js';

const num = (v: unknown) => Number(v ?? 0);

export interface Drilldown {
  codigo: string;
  titulo: string;
  /** O que cada linha representa, para a tela nomear o registro. */
  entidade: string;
  /** Rota do modulo operacional que abre o registro (secao 73). */
  rota: string | null;
  periodo: ReturnType<typeof resolverPeriodo>;
  colunas: Array<{ campo: string; titulo: string; tipo: string }>;
  linhas: Array<Record<string, unknown>>;
  /** Quantos registros existem no recorte - nao quantos couberam na lista. */
  total: number;
  /** Quantos vieram nesta resposta. */
  exibidas: number;
  truncado: boolean;
  origem: string;
}

type Consulta = (
  filtro: FiltroGlobal, periodo: ReturnType<typeof resolverPeriodo>, limite: number,
) => Promise<{ linhas: Array<Record<string, unknown>>; total: number }>;

interface Definicao {
  titulo: string;
  entidade: string;
  rota: string | null;
  origem: string;
  colunas: Array<{ campo: string; titulo: string; tipo: string }>;
  consulta: Consulta;
}

const coluna = (campo: string, titulo: string, tipo = 'texto') => ({ campo, titulo, tipo });

/** Executa a consulta e informa se houve corte. */
async function executar(
  sql: string, valores: unknown[], limite: number,
): Promise<{ linhas: Array<Record<string, unknown>>; total: number }> {
  // Busca uma linha a mais do que o limite: e o que revela que a lista
  // estourou sem custar uma contagem em todo drill-down.
  const { rows } = await query(`${sql} LIMIT ${limite + 1}`, valores);
  if (rows.length <= limite) return { linhas: rows, total: rows.length };

  // Estourou. Agora vale contar de verdade: dizer "500 registros" quando o
  // indicador logo acima diz 1.439 faria a tela desmentir o proprio numero.
  // A ordenacao nao importa para um COUNT, entao envolver o SQL e seguro.
  const { rows: contagem } = await query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM (${sql}) AS _contagem`, valores);

  return { linhas: rows.slice(0, limite), total: Number(contagem[0]?.n ?? rows.length) };
}

const DESTINOS: Record<string, Definicao> = {

  // --- Compras (secao 45) --------------------------------------------------
  compras: {
    titulo: 'Pedidos do periodo',
    entidade: 'pedido',
    rota: '/ordens-compra',
    origem: 'Modulo 07 - pedidos de compra',
    colunas: [
      coluna('numero', 'Pedido'), coluna('fornecedor', 'Fornecedor'),
      coluna('data_emissao', 'Emissao', 'data'), coluna('status', 'Status', 'estado'),
      coluna('itens', 'Itens', 'numero'), coluna('valor_total', 'Valor', 'moeda'),
      coluna('pendente', 'Pendente', 'moeda'),
    ],
    consulta: async (filtro, periodo, limite) => {
      const valores: unknown[] = [periodo.inicio, periodo.fim];
      const onde = condicoes(filtro, {
        fornecedor: 'oc.fornecedor_id', comprador: 'oc.comprador_id',
        local: 'oc.local_entrega_id', status: 'oc.status',
      }, valores);
      return executar(`
        SELECT oc.id, oc.numero, f.razao_social AS fornecedor, oc.data_emissao,
               oc.status::text, oc.valor_total,
               (SELECT count(*)::int FROM ordem_compra_itens x
                 WHERE x.ordem_compra_id = oc.id) AS itens,
               (SELECT coalesce(sum(x.quantidade_pendente * x.preco_unitario), 0)
                  FROM ordem_compra_itens x WHERE x.ordem_compra_id = oc.id) AS pendente
          FROM ordens_compra oc
          JOIN fornecedores f ON f.id = oc.fornecedor_id
         WHERE oc.data_emissao BETWEEN $1::date AND $2::date
           AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA') ${onde}
         ORDER BY oc.valor_total DESC`, valores, limite);
    },
  },

  'compras-abertas': {
    titulo: 'Itens com saldo pendente',
    entidade: 'item de pedido',
    rota: '/ordens-compra',
    origem: 'Modulos 07 e 08 - saldo de pedido',
    colunas: [
      coluna('ordem_compra', 'Pedido'), coluna('fornecedor', 'Fornecedor'),
      coluna('produto', 'Produto'), coluna('quantidade_pendente', 'Pendente', 'numero'),
      coluna('valor_total', 'Valor', 'moeda'),
      coluna('data_prevista_entrega', 'Previsao', 'data'),
      coluna('dias_atraso', 'Atraso', 'numero'),
    ],
    consulta: async (filtro, _periodo, limite) => {
      const valores: unknown[] = [];
      const onde = condicoes(filtro, {
        fornecedor: 'v.fornecedor_id', produto: 'v.produto_id',
      }, valores);
      return executar(`
        SELECT v.* FROM vw_compras_abertas v
         WHERE v.quantidade_pendente > 0 ${onde}
         ORDER BY v.dias_atraso DESC NULLS LAST, v.valor_total DESC`, valores, limite);
    },
  },

  'pedidos-atrasados': {
    titulo: 'Itens de pedido com prazo vencido',
    entidade: 'item de pedido',
    rota: '/entregas',
    origem: 'Modulo 08 - acompanhamento de entregas',
    colunas: [
      coluna('numero', 'Pedido'), coluna('fornecedor', 'Fornecedor'),
      coluna('produto', 'Produto'), coluna('data_prometida', 'Prometida', 'data'),
      coluna('dias_atraso', 'Dias de atraso', 'numero'),
      coluna('quantidade_pendente', 'Pendente', 'numero'),
      coluna('valor_pendente', 'Valor', 'moeda'),
    ],
    consulta: async (filtro, _periodo, limite) => {
      const valores: unknown[] = [];
      const onde = condicoes(filtro, {
        categoria: 'p.categoria_id', produto: 'oci.produto_id',
        fornecedor: 'oc.fornecedor_id', comprador: 'oc.comprador_id',
      }, valores);
      return executar(`
        SELECT oc.id, oc.numero, f.razao_social AS fornecedor, p.descricao AS produto,
               oci.data_prometida,
               (CURRENT_DATE - oci.data_prometida) AS dias_atraso,
               oci.quantidade_pendente,
               (oci.quantidade_pendente * oci.preco_unitario) AS valor_pendente
          FROM ordem_compra_itens oci
          JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
          JOIN fornecedores f ON f.id = oc.fornecedor_id
          JOIN produtos p ON p.id = oci.produto_id
         WHERE oci.quantidade_pendente > 0
           AND oci.data_prometida IS NOT NULL AND oci.data_prometida < CURRENT_DATE
           AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA') ${onde}
         ORDER BY dias_atraso DESC`, valores, limite);
    },
  },

  // --- Estoque (secao 44) --------------------------------------------------
  ruptura: {
    titulo: 'Produtos em ruptura',
    entidade: 'produto',
    rota: '/estoque',
    origem: 'Modulos 03 e 04 - estoque e demanda',
    colunas: [
      coluna('codigo', 'Codigo'), coluna('descricao', 'Produto'),
      coluna('categoria', 'Categoria'), coluna('demanda_media_diaria', 'Demanda/dia', 'numero'),
      coluna('estoque_em_transito', 'Em transito', 'numero'),
      coluna('impacto_diario', 'Impacto/dia', 'moeda'),
      coluna('pedidos_abertos', 'Pedidos', 'numero'),
    ],
    consulta: async (filtro, _periodo, limite) => {
      const valores: unknown[] = [];
      const onde = condicoes(filtro, {
        categoria: 'p.categoria_id', produto: 'v.produto_id',
      }, valores);
      return executar(`
        SELECT v.produto_id, v.codigo, v.descricao, v.categoria,
               v.demanda_media_diaria, v.estoque_em_transito, v.estoque_disponivel,
               (v.demanda_media_diaria * coalesce(p.custo_referencia, 0)) AS impacto_diario,
               (SELECT count(*)::int FROM ordem_compra_itens oci
                  JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
                 WHERE oci.produto_id = v.produto_id AND oci.quantidade_pendente > 0
                   AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA'))
                 AS pedidos_abertos
          FROM vw_estoque_atual v
          JOIN produtos p ON p.id = v.produto_id
         WHERE v.demanda_media_diaria > 0 AND v.estoque_disponivel <= 0 ${onde}
         ORDER BY impacto_diario DESC`, valores, limite);
    },
  },

  excesso: {
    titulo: 'Produtos em excesso',
    entidade: 'produto',
    rota: '/estoque',
    origem: 'Modulos 03 e 04 - estoque e demanda',
    colunas: [
      coluna('codigo', 'Codigo'), coluna('descricao', 'Produto'),
      coluna('estoque_disponivel', 'Disponivel', 'numero'),
      coluna('maximo', 'Maximo aceitavel', 'numero'),
      coluna('criterio', 'Criterio'),
      coluna('cobertura_dias', 'Cobertura', 'numero'),
      coluna('excedente', 'Excedente', 'numero'),
      coluna('valor_excedente', 'Valor parado', 'moeda'),
    ],
    /**
     * Mesmo criterio do KPI PRODUTOS_EXCESSO (secao 67): o maximo aceitavel e
     * o MENOR entre a cobertura maxima e o estoque maximo cadastrado - e basta
     * um dos dois existir.
     *
     * Exigir demanda aqui deixaria de fora o pior caso: produto acima do
     * maximo cadastrado e SEM saida nenhuma.
     */
    consulta: async (filtro, _periodo, limite) => {
      const cfg = await configuracoes();
      const dias = numeroConfig(cfg, 'bi.excesso_cobertura_dias', 90);
      const valores: unknown[] = [dias];
      const onde = condicoes(filtro, {
        categoria: 'p.categoria_id', produto: 'v.produto_id',
      }, valores);
      return executar(`
        SELECT * FROM (
          SELECT v.produto_id, v.codigo, v.descricao, v.estoque_disponivel,
                 v.cobertura_dias, v.demanda_media_diaria,
                 least(nullif(v.demanda_media_diaria, 0) * $1::numeric,
                       nullif(p.estoque_maximo, 0))            AS maximo,
                 CASE
                   WHEN nullif(v.demanda_media_diaria, 0) IS NULL THEN 'Estoque maximo cadastrado'
                   WHEN nullif(p.estoque_maximo, 0) IS NULL      THEN 'Cobertura maxima'
                   WHEN v.demanda_media_diaria * $1::numeric <= p.estoque_maximo
                     THEN 'Cobertura maxima'
                   ELSE 'Estoque maximo cadastrado'
                 END                                            AS criterio,
                 v.estoque_disponivel
                   - least(nullif(v.demanda_media_diaria, 0) * $1::numeric,
                           nullif(p.estoque_maximo, 0))         AS excedente,
                 (v.estoque_disponivel
                   - least(nullif(v.demanda_media_diaria, 0) * $1::numeric,
                           nullif(p.estoque_maximo, 0)))
                   * coalesce(p.custo_referencia, 0)            AS valor_excedente
            FROM vw_estoque_atual v
            JOIN produtos p ON p.id = v.produto_id
           WHERE p.ativo AND p.deleted_at IS NULL ${onde}
        ) x
         WHERE x.maximo IS NOT NULL AND x.estoque_disponivel > x.maximo
         ORDER BY x.valor_excedente DESC`, valores, limite);
    },
  },

  'estoque-parado': {
    titulo: 'Produtos sem movimentacao',
    entidade: 'produto',
    rota: '/estoque',
    origem: 'Modulo 03 - movimentacoes de estoque',
    colunas: [
      coluna('codigo', 'Codigo'), coluna('descricao', 'Produto'),
      coluna('quantidade', 'Quantidade', 'numero'), coluna('valor', 'Valor', 'moeda'),
      coluna('ultima_saida', 'Ultima saida', 'data'),
      coluna('dias_parado', 'Dias parado', 'numero'),
    ],
    consulta: async (filtro, _periodo, limite) => {
      const cfg = await configuracoes();
      const dias = numeroConfig(cfg, 'bi.estoque_parado_dias', 90);
      const valores: unknown[] = [dias];
      const onde = condicoes(filtro, {
        categoria: 'p.categoria_id', produto: 'e.produto_id', local: 'e.local_id',
      }, valores);
      return executar(`
        SELECT p.id AS produto_id, p.codigo, p.descricao,
               sum(e.quantidade_fisica) AS quantidade,
               sum(e.quantidade_fisica * coalesce(p.custo_referencia, 0)) AS valor,
               max(e.ultima_saida) AS ultima_saida,
               CASE WHEN max(e.ultima_saida) IS NULL THEN NULL
                    ELSE EXTRACT(day FROM now() - max(e.ultima_saida))::int END AS dias_parado
          FROM estoques e JOIN produtos p ON p.id = e.produto_id
         WHERE e.quantidade_fisica > 0 AND p.ativo AND p.deleted_at IS NULL
           AND (e.ultima_saida IS NULL
                OR e.ultima_saida < now() - make_interval(days => $1::int)) ${onde}
         GROUP BY p.id, p.codigo, p.descricao
         ORDER BY valor DESC`, valores, limite);
    },
  },

  criticos: {
    titulo: 'Produtos com estoque critico',
    entidade: 'produto',
    rota: '/estoque',
    origem: 'Modulo 03 - posicao de estoque',
    colunas: [
      coluna('codigo', 'Codigo'), coluna('descricao', 'Produto'),
      coluna('situacao', 'Situacao', 'estado'),
      coluna('estoque_disponivel', 'Disponivel', 'numero'),
      coluna('ponto_pedido', 'Ponto de pedido', 'numero'),
      coluna('cobertura_dias', 'Cobertura', 'numero'),
      coluna('classificacao_abc', 'ABC'),
    ],
    consulta: async (filtro, _periodo, limite) => {
      const valores: unknown[] = [];
      const onde = condicoes(filtro, {
        categoria: 'p.categoria_id', produto: 'v.produto_id',
      }, valores);
      return executar(`
        SELECT v.* FROM vw_produtos_criticos v
          JOIN produtos p ON p.id = v.produto_id
         WHERE v.situacao IS NOT NULL ${onde}
         ORDER BY v.cobertura_dias NULLS FIRST`, valores, limite);
    },
  },

  cobertura: {
    titulo: 'Cobertura por produto',
    entidade: 'produto',
    rota: '/estoque',
    origem: 'Modulos 03 e 04 - estoque e demanda',
    colunas: [
      coluna('codigo', 'Codigo'), coluna('descricao', 'Produto'),
      coluna('estoque_disponivel', 'Disponivel', 'numero'),
      coluna('demanda_media_diaria', 'Demanda/dia', 'numero'),
      coluna('cobertura_dias', 'Cobertura', 'numero'),
    ],
    consulta: async (filtro, _periodo, limite) => {
      const valores: unknown[] = [];
      const onde = condicoes(filtro, {
        categoria: 'p.categoria_id', produto: 'v.produto_id',
      }, valores);
      return executar(`
        SELECT v.produto_id, v.codigo, v.descricao, v.estoque_disponivel,
               v.demanda_media_diaria, v.cobertura_dias
          FROM vw_estoque_atual v JOIN produtos p ON p.id = v.produto_id
         WHERE v.demanda_media_diaria > 0 ${onde}
         ORDER BY v.cobertura_dias`, valores, limite);
    },
  },

  giro: {
    titulo: 'Saidas do periodo por produto',
    entidade: 'produto',
    rota: '/estoque',
    origem: 'Modulo 03 - movimentacoes de estoque',
    colunas: [
      coluna('codigo', 'Codigo'), coluna('descricao', 'Produto'),
      coluna('saidas', 'Saidas', 'numero'), coluna('valor_saidas', 'Valor', 'moeda'),
      coluna('saldo_atual', 'Saldo atual', 'numero'),
    ],
    consulta: async (filtro, periodo, limite) => {
      const valores: unknown[] = [periodo.inicio, periodo.fim];
      const onde = condicoes(filtro, {
        categoria: 'p.categoria_id', produto: 'm.produto_id', local: 'm.local_id',
      }, valores);
      return executar(`
        SELECT p.id AS produto_id, p.codigo, p.descricao,
               sum(m.quantidade) AS saidas,
               sum(m.quantidade * coalesce(m.custo_unitario, p.custo_referencia, 0))
                 AS valor_saidas,
               (SELECT coalesce(sum(e.quantidade_fisica), 0) FROM estoques e
                 WHERE e.produto_id = p.id) AS saldo_atual
          FROM movimentacoes_estoque m JOIN produtos p ON p.id = m.produto_id
         WHERE m.created_at >= $1::date AND m.created_at < ($2::date + interval '1 day')
           AND fn_sinal_movimentacao(m.tipo_movimentacao) = -1 ${onde}
         GROUP BY p.id, p.codigo, p.descricao
         ORDER BY valor_saidas DESC`, valores, limite);
    },
  },

  estoque: {
    titulo: 'Posicao de estoque',
    entidade: 'produto',
    rota: '/estoque',
    origem: 'Modulo 03 - posicao de estoque',
    colunas: [
      coluna('codigo', 'Codigo'), coluna('descricao', 'Produto'),
      coluna('estoque_fisico', 'Fisico', 'numero'),
      coluna('estoque_disponivel', 'Disponivel', 'numero'),
      coluna('estoque_quarentena', 'Quarentena', 'numero'),
      coluna('valor', 'Valor', 'moeda'),
    ],
    consulta: async (filtro, _periodo, limite) => {
      const valores: unknown[] = [];
      const onde = condicoes(filtro, {
        categoria: 'p.categoria_id', produto: 'v.produto_id',
      }, valores);
      return executar(`
        SELECT v.produto_id, v.codigo, v.descricao, v.estoque_fisico,
               v.estoque_disponivel, v.estoque_quarentena,
               (v.estoque_fisico * coalesce(p.custo_referencia, 0)) AS valor
          FROM vw_estoque_atual v JOIN produtos p ON p.id = v.produto_id
         WHERE v.estoque_fisico > 0 ${onde}
         ORDER BY valor DESC`, valores, limite);
    },
  },

  // --- Entregas (secao 43) -------------------------------------------------
  entregas: {
    titulo: 'Entregas do periodo',
    entidade: 'entrega',
    rota: '/entregas',
    origem: 'Modulo 08 - entregas',
    colunas: [
      coluna('numero', 'Entrega'), coluna('pedido', 'Pedido'),
      coluna('fornecedor', 'Fornecedor'), coluna('data_prometida', 'Prometida', 'data'),
      coluna('data_real', 'Real', 'data'), coluna('dias_atraso', 'Atraso', 'numero'),
      coluna('status', 'Status', 'estado'),
    ],
    consulta: async (filtro, periodo, limite) => {
      const valores: unknown[] = [periodo.inicio, periodo.fim];
      const onde = condicoes(filtro, {
        fornecedor: 'oc.fornecedor_id', local: 'e.local_id',
      }, valores);
      return executar(`
        SELECT e.id, e.numero, oc.numero AS pedido, f.razao_social AS fornecedor,
               e.data_prometida, e.data_real, e.status::text,
               (e.data_real - e.data_prometida) AS dias_atraso
          FROM entregas e
          JOIN ordens_compra oc ON oc.id = e.ordem_compra_id
          JOIN fornecedores f ON f.id = oc.fornecedor_id
         WHERE e.data_real BETWEEN $1::date AND $2::date ${onde}
         ORDER BY dias_atraso DESC NULLS LAST`, valores, limite);
    },
  },

  'entregas-atrasadas': {
    titulo: 'Entregas em atraso',
    entidade: 'item de pedido',
    rota: '/entregas',
    origem: 'Modulo 08 - acompanhamento',
    colunas: [
      coluna('numero', 'Pedido'), coluna('fornecedor', 'Fornecedor'),
      coluna('produto', 'Produto'), coluna('data_prometida', 'Prometida', 'data'),
      coluna('dias_atraso', 'Dias', 'numero'),
      coluna('quantidade_pendente', 'Pendente', 'numero'),
    ],
    consulta: async (filtro, _periodo, limite) => {
      const valores: unknown[] = [];
      const onde = condicoes(filtro, {
        fornecedor: 'oc.fornecedor_id', produto: 'oci.produto_id',
        categoria: 'p.categoria_id',
      }, valores);
      return executar(`
        SELECT oc.id, oc.numero, f.razao_social AS fornecedor, p.descricao AS produto,
               oci.data_prometida, (CURRENT_DATE - oci.data_prometida) AS dias_atraso,
               oci.quantidade_pendente
          FROM ordem_compra_itens oci
          JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
          JOIN fornecedores f ON f.id = oc.fornecedor_id
          JOIN produtos p ON p.id = oci.produto_id
         WHERE oci.quantidade_pendente > 0 AND oci.data_prometida < CURRENT_DATE
           AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA') ${onde}
         ORDER BY dias_atraso DESC`, valores, limite);
    },
  },

  // --- Recebimento e qualidade (secao 46) ----------------------------------
  recebimentos: {
    titulo: 'Recebimentos do periodo',
    entidade: 'recebimento',
    rota: '/recebimentos',
    origem: 'Modulo 09 - recebimento',
    colunas: [
      coluna('numero', 'Recebimento'), coluna('fornecedor', 'Fornecedor'),
      coluna('data_recebimento', 'Data', 'data'), coluna('status', 'Status', 'estado'),
      coluna('quantidade_recebida', 'Recebida', 'numero'),
      coluna('valor_recebido', 'Valor', 'moeda'),
    ],
    consulta: async (filtro, periodo, limite) => {
      const valores: unknown[] = [periodo.inicio, periodo.fim];
      const onde = condicoes(filtro, {
        fornecedor: 'r.fornecedor_id', local: 'r.local_id', status: 'r.status',
      }, valores);
      return executar(`
        SELECT r.id, r.numero, f.razao_social AS fornecedor, r.data_recebimento,
               r.status::text, r.quantidade_recebida, r.valor_recebido
          FROM recebimentos r JOIN fornecedores f ON f.id = r.fornecedor_id
         WHERE r.data_recebimento BETWEEN $1::date AND $2::date
           AND r.status <> 'CANCELADO' ${onde}
         ORDER BY r.data_recebimento DESC`, valores, limite);
    },
  },

  divergencias: {
    titulo: 'Divergencias de recebimento',
    entidade: 'divergencia',
    rota: '/recebimentos',
    origem: 'Modulo 09 - divergencias',
    colunas: [
      coluna('recebimento', 'Recebimento'), coluna('fornecedor', 'Fornecedor'),
      coluna('produto', 'Produto'), coluna('tipo', 'Tipo', 'estado'),
      coluna('severidade', 'Severidade', 'estado'), coluna('decisao', 'Decisao', 'estado'),
    ],
    consulta: async (filtro, periodo, limite) => {
      const valores: unknown[] = [periodo.inicio, periodo.fim];
      const onde = condicoes(filtro, {
        fornecedor: 'r.fornecedor_id', produto: 'd.produto_id',
      }, valores);
      return executar(`
        SELECT d.id, r.numero AS recebimento, f.razao_social AS fornecedor,
               p.descricao AS produto, d.tipo::text, d.severidade::text, d.decisao::text,
               d.detectada_em
          FROM recebimento_divergencias d
          JOIN recebimentos r ON r.id = d.recebimento_id
          JOIN fornecedores f ON f.id = r.fornecedor_id
          LEFT JOIN produtos p ON p.id = d.produto_id
         WHERE d.detectada_em >= $1::date
           AND d.detectada_em < ($2::date + interval '1 day') ${onde}
         ORDER BY d.detectada_em DESC`, valores, limite);
    },
  },

  'nao-conformidades': {
    titulo: 'Nao conformidades',
    entidade: 'nao conformidade',
    rota: '/qualidade',
    origem: 'Modulo 09 - nao conformidades',
    colunas: [
      coluna('numero', 'NC'), coluna('fornecedor', 'Fornecedor'),
      coluna('produto', 'Produto'), coluna('tipo', 'Tipo', 'estado'),
      coluna('severidade', 'Severidade', 'estado'), coluna('status', 'Status', 'estado'),
      coluna('created_at', 'Aberta em', 'data'),
    ],
    consulta: async (filtro, periodo, limite) => {
      const valores: unknown[] = [periodo.inicio, periodo.fim];
      const onde = condicoes(filtro, {
        fornecedor: 'n.fornecedor_id', produto: 'n.produto_id',
      }, valores);
      return executar(`
        SELECT n.id, n.numero, f.razao_social AS fornecedor, p.descricao AS produto,
               n.tipo::text, n.severidade::text, n.status::text, n.created_at
          FROM nao_conformidades n
          LEFT JOIN fornecedores f ON f.id = n.fornecedor_id
          LEFT JOIN produtos p ON p.id = n.produto_id
         WHERE n.created_at >= $1::date
           AND n.created_at < ($2::date + interval '1 day') ${onde}
         ORDER BY CASE n.severidade WHEN 'CRITICA' THEN 1 WHEN 'ALTA' THEN 2
                                    WHEN 'MEDIA' THEN 3 ELSE 4 END,
                  n.created_at DESC`, valores, limite);
    },
  },

  devolucoes: {
    titulo: 'Devolucoes ao fornecedor',
    entidade: 'devolucao',
    rota: '/recebimentos',
    origem: 'Modulo 09 - devolucoes',
    colunas: [
      coluna('numero', 'Devolucao'), coluna('fornecedor', 'Fornecedor'),
      coluna('motivo', 'Motivo', 'estado'), coluna('status', 'Status', 'estado'),
      coluna('valor_total', 'Valor', 'moeda'), coluna('created_at', 'Criada em', 'data'),
    ],
    consulta: async (filtro, periodo, limite) => {
      const valores: unknown[] = [periodo.inicio, periodo.fim];
      const onde = condicoes(filtro, { fornecedor: 'd.fornecedor_id' }, valores);
      return executar(`
        SELECT d.id, d.numero, f.razao_social AS fornecedor, d.motivo::text,
               d.status::text, d.valor_total, d.created_at
          FROM devolucoes d JOIN fornecedores f ON f.id = d.fornecedor_id
         WHERE d.created_at >= $1::date
           AND d.created_at < ($2::date + interval '1 day')
           AND d.status <> 'CANCELADA' ${onde}
         ORDER BY d.created_at DESC`, valores, limite);
    },
  },

  quarentenas: {
    titulo: 'Material em quarentena',
    entidade: 'quarentena',
    rota: '/recebimentos',
    origem: 'Modulo 09 - quarentenas',
    colunas: [
      coluna('numero', 'Quarentena'), coluna('produto', 'Produto'),
      coluna('quantidade', 'Quantidade', 'numero'), coluna('motivo', 'Motivo'),
      coluna('status', 'Status', 'estado'), coluna('aberta_em', 'Aberta em', 'data'),
    ],
    consulta: async (filtro, _periodo, limite) => {
      const valores: unknown[] = [];
      const onde = condicoes(filtro, {
        fornecedor: 'q.fornecedor_id', produto: 'q.produto_id',
      }, valores);
      return executar(`
        SELECT q.id, q.numero, p.descricao AS produto, q.quantidade, q.motivo,
               q.status::text, q.aberta_em
          FROM quarentenas q JOIN produtos p ON p.id = q.produto_id
         WHERE q.status = 'ABERTA' ${onde}
         ORDER BY q.aberta_em DESC`, valores, limite);
    },
  },

  // --- Fornecedores e planejamento -----------------------------------------
  fornecedores: {
    titulo: 'Fornecedores',
    entidade: 'fornecedor',
    rota: '/avaliacao-fornecedores',
    origem: 'Modulos 02 e 10 - cadastro e avaliacao',
    colunas: [
      coluna('razao_social', 'Fornecedor'), coluna('status_homologacao', 'Homologacao', 'estado'),
      coluna('score_atual', 'Score', 'numero'),
      coluna('ultima_avaliacao_em', 'Ultima avaliacao', 'data'),
      coluna('lead_time_padrao_dias', 'Lead time', 'numero'),
    ],
    consulta: async (filtro, _periodo, limite) => {
      const valores: unknown[] = [];
      const onde = condicoes(filtro, { fornecedor: 'f.id' }, valores);
      return executar(`
        SELECT f.id, f.razao_social, f.status_homologacao::text, f.score_atual,
               f.ultima_avaliacao_em, f.lead_time_padrao_dias
          FROM fornecedores f
         WHERE f.ativo AND f.deleted_at IS NULL ${onde}
         ORDER BY f.score_atual DESC NULLS LAST`, valores, limite);
    },
  },

  avaliacoes: {
    titulo: 'Avaliacoes de fornecedor',
    entidade: 'avaliacao',
    rota: '/avaliacao-fornecedores',
    origem: 'Modulo 10 - avaliacao de fornecedores',
    colunas: [
      coluna('numero', 'Avaliacao'), coluna('fornecedor', 'Fornecedor'),
      coluna('periodo_fim', 'Periodo', 'data'), coluna('score_final', 'Score', 'numero'),
      coluna('completude', 'Completude', 'estado'), coluna('status', 'Status', 'estado'),
    ],
    consulta: async (filtro, periodo, limite) => {
      const valores: unknown[] = [periodo.inicio, periodo.fim];
      const onde = condicoes(filtro, { fornecedor: 'a.fornecedor_id' }, valores);
      return executar(`
        SELECT a.id, a.numero, f.razao_social AS fornecedor, a.periodo_fim,
               a.score_final, a.completude::text, a.status::text
          FROM avaliacoes_fornecedores a
          JOIN fornecedores f ON f.id = a.fornecedor_id
         WHERE a.periodo_fim BETWEEN $1::date AND $2::date
           AND a.status <> 'CANCELADA' ${onde}
         ORDER BY a.periodo_fim DESC`, valores, limite);
    },
  },

  necessidades: {
    titulo: 'Necessidades de compra em aberto',
    entidade: 'necessidade',
    rota: '/compras',
    origem: 'Modulo 05 - planejamento de compras',
    colunas: [
      coluna('produto', 'Produto'), coluna('prioridade', 'Prioridade', 'estado'),
      coluna('quantidade_sugerida', 'Sugerida', 'numero'),
      coluna('valor_estimado', 'Valor', 'moeda'),
      coluna('data_necessaria', 'Necessaria', 'data'),
      coluna('status', 'Status', 'estado'),
    ],
    consulta: async (filtro, _periodo, limite) => {
      const valores: unknown[] = [];
      const onde = condicoes(filtro, {
        categoria: 'p.categoria_id', produto: 'n.produto_id',
        fornecedor: 'n.fornecedor_id',
      }, valores);
      return executar(`
        SELECT n.id, p.descricao AS produto, n.prioridade::text, n.quantidade_sugerida,
               n.valor_estimado, n.data_necessaria, n.status::text
          FROM necessidades_compra n JOIN produtos p ON p.id = n.produto_id
         WHERE n.status IN ('PENDENTE','EM_ANALISE','APROVADA','AJUSTADA') ${onde}
         ORDER BY CASE n.prioridade WHEN 'RUPTURA' THEN 1 WHEN 'CRITICA' THEN 2
                                    WHEN 'ALTA' THEN 3 WHEN 'MEDIA' THEN 4 ELSE 5 END,
                  n.data_necessaria NULLS LAST`, valores, limite);
    },
  },

  precos: {
    titulo: 'Historico de precos',
    entidade: 'registro de preco',
    rota: '/avaliacao-fornecedores',
    origem: 'Modulos 02 e 07 - historico de precos',
    colunas: [
      coluna('data', 'Data', 'data'), coluna('produto', 'Produto'),
      coluna('fornecedor', 'Fornecedor'), coluna('preco_unitario', 'Preco', 'moeda'),
      coluna('preco_anterior', 'Anterior', 'moeda'),
      coluna('variacao_percentual', 'Variacao', 'numero'),
    ],
    consulta: async (filtro, periodo, limite) => {
      const valores: unknown[] = [periodo.inicio, periodo.fim];
      const onde = condicoes(filtro, {
        produto: 'h.produto_id', fornecedor: 'h.fornecedor_id',
      }, valores);
      return executar(`
        SELECT h.id, h.data, h.produto, h.fornecedor, h.preco_unitario,
               h.preco_anterior, h.variacao_percentual
          FROM vw_historico_precos h
         WHERE h.data BETWEEN $1::date AND $2::date ${onde}
         ORDER BY h.data DESC`, valores, limite);
    },
  },

  monoprovedor: {
    titulo: 'Produtos com fornecedor unico',
    entidade: 'produto',
    rota: '/produtos',
    origem: 'Modulos 02 e 10 - produto x fornecedor',
    colunas: [
      coluna('codigo', 'Codigo'), coluna('produto', 'Produto'),
      coluna('classificacao_abc', 'ABC'), coluna('fornecedor', 'Unico fornecedor'),
      coluna('status_homologacao', 'Homologacao', 'estado'),
      coluna('lead_time', 'Lead time', 'numero'),
    ],
    consulta: async (filtro, _periodo, limite) => {
      const valores: unknown[] = [];
      const onde = condicoes(filtro, {
        categoria: 'p.categoria_id', produto: 'p.id',
      }, valores);
      return executar(`
        SELECT p.id AS produto_id, p.codigo, p.descricao AS produto,
               p.classificacao_abc::text, f.razao_social AS fornecedor,
               f.status_homologacao::text,
               coalesce(pf.lead_time_dias, f.lead_time_padrao_dias) AS lead_time
          FROM produto_fornecedor pf
          JOIN produtos p ON p.id = pf.produto_id
          JOIN fornecedores f ON f.id = pf.fornecedor_id
         WHERE pf.ativo AND f.ativo AND f.deleted_at IS NULL
           AND p.ativo AND p.deleted_at IS NULL
           AND (SELECT count(*) FROM produto_fornecedor x
                  JOIN fornecedores xf ON xf.id = x.fornecedor_id
                 WHERE x.produto_id = p.id AND x.ativo AND xf.ativo
                   AND xf.deleted_at IS NULL) = 1 ${onde}
         ORDER BY p.classificacao_abc NULLS LAST, p.descricao`, valores, limite);
    },
  },

  'qualidade-dados': {
    titulo: 'Cadastros com campo obrigatorio vazio',
    entidade: 'produto',
    rota: '/produtos',
    origem: 'Modulos 02 e 03 - cadastros',
    colunas: [
      coluna('codigo', 'Codigo'), coluna('descricao', 'Produto'),
      coluna('sem_categoria', 'Sem categoria', 'estado'),
      coluna('sem_custo', 'Sem custo', 'estado'),
      coluna('sem_minimo', 'Sem minimo', 'estado'),
      coluna('sem_fornecedor', 'Sem fornecedor', 'estado'),
    ],
    consulta: async (filtro, _periodo, limite) => {
      const valores: unknown[] = [];
      const onde = condicoes(filtro, {
        categoria: 'p.categoria_id', produto: 'p.id',
      }, valores);
      return executar(`
        SELECT p.id AS produto_id, p.codigo, p.descricao,
               (p.categoria_id IS NULL) AS sem_categoria,
               (coalesce(p.custo_referencia, 0) <= 0) AS sem_custo,
               (coalesce(p.estoque_minimo, 0) <= 0) AS sem_minimo,
               NOT EXISTS (SELECT 1 FROM produto_fornecedor pf
                            WHERE pf.produto_id = p.id AND pf.ativo) AS sem_fornecedor
          FROM produtos p
         WHERE p.ativo AND p.deleted_at IS NULL
           AND (p.categoria_id IS NULL
                OR coalesce(p.custo_referencia, 0) <= 0
                OR coalesce(p.estoque_minimo, 0) <= 0
                OR NOT EXISTS (SELECT 1 FROM produto_fornecedor pf
                                WHERE pf.produto_id = p.id AND pf.ativo)) ${onde}
         ORDER BY p.descricao`, valores, limite);
    },
  },

  importacoes: {
    titulo: 'Pedidos de importacao',
    entidade: 'pedido',
    rota: '/ordens-compra',
    origem: 'Modulos 07 e 08 - pedido e transporte',
    colunas: [
      coluna('numero', 'Pedido'), coluna('fornecedor', 'Fornecedor'),
      coluna('incoterm', 'Incoterm'), coluna('moeda', 'Moeda'),
      coluna('taxa_cambio', 'Taxa', 'numero'), coluna('valor_total', 'Valor', 'moeda'),
      coluna('eta_atual', 'ETA', 'data'), coluna('status', 'Status', 'estado'),
    ],
    consulta: async (filtro, periodo, limite) => {
      const valores: unknown[] = [periodo.inicio, periodo.fim];
      const onde = condicoes(filtro, { fornecedor: 'oc.fornecedor_id' }, valores);
      return executar(`
        SELECT oc.id, oc.numero, f.razao_social AS fornecedor, oc.incoterm::text,
               oc.moeda, oc.taxa_cambio, oc.valor_total, oc.eta_atual, oc.status::text,
               oc.data_taxa_cambio
          FROM ordens_compra oc JOIN fornecedores f ON f.id = oc.fornecedor_id
         WHERE oc.data_emissao BETWEEN $1::date AND $2::date
           AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')
           AND (oc.incoterm IS NOT NULL OR f.origem_fornecedor <> 'NACIONAL') ${onde}
         ORDER BY oc.eta_atual NULLS LAST`, valores, limite);
    },
  },

  demanda: {
    titulo: 'Demanda por produto',
    entidade: 'produto',
    rota: '/demanda',
    origem: 'Modulo 04 - analise de demanda',
    colunas: [
      coluna('codigo', 'Codigo'), coluna('descricao', 'Produto'),
      coluna('demanda_media_diaria', 'Demanda/dia', 'numero'),
      coluna('estoque_disponivel', 'Disponivel', 'numero'),
      coluna('cobertura_dias', 'Cobertura', 'numero'),
    ],
    consulta: async (filtro, _periodo, limite) => {
      const valores: unknown[] = [];
      const onde = condicoes(filtro, {
        categoria: 'p.categoria_id', produto: 'v.produto_id',
      }, valores);
      return executar(`
        SELECT v.produto_id, v.codigo, v.descricao, v.demanda_media_diaria,
               v.estoque_disponivel, v.cobertura_dias
          FROM vw_estoque_atual v JOIN produtos p ON p.id = v.produto_id
         WHERE v.demanda_media_diaria > 0 ${onde}
         ORDER BY v.demanda_media_diaria DESC`, valores, limite);
    },
  },

  previsoes: {
    titulo: 'Previsao contra realizado',
    entidade: 'previsao',
    rota: '/demanda',
    origem: 'Modulo 04 - previsao de demanda',
    colunas: [
      coluna('produto', 'Produto'), coluna('periodo_fim', 'Periodo', 'data'),
      coluna('demanda_prevista', 'Previsto', 'numero'),
      coluna('realizado', 'Realizado', 'numero'),
      coluna('erro_percentual', 'Erro', 'numero'), coluna('metodo', 'Metodo'),
    ],
    consulta: async (filtro, periodo, limite) => {
      const valores: unknown[] = [periodo.inicio, periodo.fim];
      const onde = condicoes(filtro, {
        categoria: 'p.categoria_id', produto: 'pr.produto_id',
      }, valores);
      return executar(`
        SELECT pr.id, p.descricao AS produto, pr.periodo_fim, pr.demanda_prevista,
               pr.realizado, pr.erro_percentual, pr.metodo::text, pr.mape
          FROM previsoes_demanda pr JOIN produtos p ON p.id = pr.produto_id
         WHERE pr.periodo_fim BETWEEN $1::date AND $2::date ${onde}
         ORDER BY pr.periodo_fim DESC`, valores, limite);
    },
  },

  sazonalidade: {
    titulo: 'Produtos com sazonalidade detectada',
    entidade: 'produto',
    rota: '/demanda',
    origem: 'Modulo 04 - sazonalidade',
    colunas: [
      coluna('produto', 'Produto'), coluna('indice_sazonal', 'Indice', 'numero'),
      coluna('periodo_fim', 'Periodo', 'data'), coluna('metodo', 'Metodo'),
    ],
    consulta: async (filtro, _periodo, limite) => {
      const valores: unknown[] = [];
      const onde = condicoes(filtro, {
        categoria: 'p.categoria_id', produto: 'pr.produto_id',
      }, valores);
      return executar(`
        SELECT DISTINCT ON (pr.produto_id)
               pr.id, p.descricao AS produto, pr.indice_sazonal, pr.periodo_fim,
               pr.metodo::text
          FROM previsoes_demanda pr JOIN produtos p ON p.id = pr.produto_id
         WHERE pr.sazonal = true ${onde}
         ORDER BY pr.produto_id, pr.periodo_fim DESC`, valores, limite);
    },
  },

  negociacoes: {
    titulo: 'Negociacoes com economia registrada',
    entidade: 'pedido',
    rota: '/ordens-compra',
    origem: 'Modulos 06 e 07 - negociacao',
    colunas: [
      coluna('numero', 'Pedido'), coluna('fornecedor', 'Fornecedor'),
      coluna('valor_total', 'Valor', 'moeda'),
      coluna('economia_negociada', 'Economia', 'moeda'),
      coluna('data_emissao', 'Emissao', 'data'),
    ],
    consulta: async (filtro, periodo, limite) => {
      const valores: unknown[] = [periodo.inicio, periodo.fim];
      const onde = condicoes(filtro, { fornecedor: 'oc.fornecedor_id' }, valores);
      return executar(`
        SELECT oc.id, oc.numero, f.razao_social AS fornecedor, oc.valor_total,
               oc.economia_negociada, oc.data_emissao
          FROM ordens_compra oc JOIN fornecedores f ON f.id = oc.fornecedor_id
         WHERE oc.data_emissao BETWEEN $1::date AND $2::date
           AND coalesce(oc.economia_negociada, 0) <> 0
           AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA') ${onde}
         ORDER BY oc.economia_negociada DESC`, valores, limite);
    },
  },
};

export async function executarDrilldown(
  codigo: string, filtro: FiltroGlobal,
): Promise<Drilldown> {
  const definicao = DESTINOS[codigo];
  if (!definicao) throw naoEncontrado(`Drill-down ${codigo}`);

  const config = await configuracoes();
  const periodo = resolverPeriodo(filtro, numeroConfig(config, 'bi.dias_padrao', 90));
  const limite = numeroConfig(config, 'bi.limite_drilldown', 500);

  const { linhas, total } = await definicao.consulta(filtro, periodo, limite);

  return {
    codigo,
    titulo: definicao.titulo,
    entidade: definicao.entidade,
    rota: definicao.rota,
    periodo,
    colunas: definicao.colunas,
    linhas,
    total,
    exibidas: linhas.length,
    truncado: total > linhas.length,
    origem: definicao.origem,
  };
}

/** Destinos disponiveis, para a tela saber onde o clique pode levar. */
export const destinos = () =>
  Object.entries(DESTINOS).map(([codigo, d]) => ({
    codigo, titulo: d.titulo, entidade: d.entidade, rota: d.rota, origem: d.origem,
  }));

/**
 * Contexto de decisao de um produto (secao 72).
 *
 * Reune indicador, desvio, origem e registros relacionados num lugar so, para
 * a pessoa decidir. O sistema NAO decide nem executa (secao 73).
 */
export async function contextoDecisao(produtoId: number) {
  const { rows: produto } = await query(`
    SELECT p.id, p.codigo, p.descricao, p.classificacao_abc::text,
           c.nome AS categoria, coalesce(p.custo_referencia, 0) AS custo,
           p.estoque_minimo, p.estoque_maximo
      FROM produtos p LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE p.id = $1 AND p.deleted_at IS NULL`, [produtoId]);
  if (!produto.length) throw naoEncontrado('Produto');

  const [posicao, pedidos, necessidades, recebimentos, ncs, fornecedores] =
    await Promise.all([
      query('SELECT * FROM vw_estoque_atual WHERE produto_id = $1', [produtoId]),
      query(`
        SELECT oc.id, oc.numero, f.razao_social AS fornecedor, oci.quantidade_pendente,
               oci.data_prometida, oc.status::text,
               (CURRENT_DATE - oci.data_prometida) AS dias_atraso
          FROM ordem_compra_itens oci
          JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
          JOIN fornecedores f ON f.id = oc.fornecedor_id
         WHERE oci.produto_id = $1 AND oci.quantidade_pendente > 0
           AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')
         ORDER BY oci.data_prometida LIMIT 20`, [produtoId]),
      query(`
        SELECT id, prioridade::text, quantidade_sugerida, valor_estimado,
               data_necessaria, status::text
          FROM necessidades_compra
         WHERE produto_id = $1
           AND status IN ('PENDENTE','EM_ANALISE','APROVADA','AJUSTADA')
         ORDER BY data_necessaria LIMIT 10`, [produtoId]),
      query(`
        SELECT r.id, r.numero, r.data_recebimento, r.status::text,
               f.razao_social AS fornecedor
          FROM recebimentos r
          JOIN recebimento_itens ri ON ri.recebimento_id = r.id
          JOIN fornecedores f ON f.id = r.fornecedor_id
         WHERE ri.produto_id = $1
         ORDER BY r.data_recebimento DESC LIMIT 10`, [produtoId]),
      query(`
        SELECT id, numero, tipo::text, severidade::text, status::text, created_at
          FROM nao_conformidades WHERE produto_id = $1
         ORDER BY created_at DESC LIMIT 10`, [produtoId]),
      query(`
        SELECT f.id, f.razao_social, f.status_homologacao::text, f.score_atual,
               pf.preco_atual, coalesce(pf.lead_time_dias, f.lead_time_padrao_dias) AS lead_time,
               pf.fornecedor_principal
          FROM produto_fornecedor pf JOIN fornecedores f ON f.id = pf.fornecedor_id
         WHERE pf.produto_id = $1 AND pf.ativo AND f.deleted_at IS NULL
         ORDER BY pf.fornecedor_principal DESC, pf.preco_atual`, [produtoId]),
    ]);

  const p = posicao.rows[0] ?? {};
  const demanda = num(p.demanda_media_diaria);
  const disponivel = num(p.estoque_disponivel);
  const emRuptura = demanda > 0 && disponivel <= 0;
  const cobertura = demanda > 0 ? Math.round((disponivel / demanda) * 10) / 10 : null;

  /**
   * A ORIGEM da secao 72: por que a situacao esta assim.
   *
   * Sao fatos observados nos registros, nao hipoteses. Cada causa aponta o
   * registro que a sustenta, para a pessoa conferir em vez de acreditar.
   */
  const atrasados = pedidos.rows.filter((r: Record<string, unknown>) => num(r.dias_atraso) > 0);
  const semFornecedor = fornecedores.rows.length === 0;
  const origem: { causa: string; evidencia: string }[] = [];

  if (atrasados.length) {
    origem.push({
      causa: 'Pedido de compra em atraso',
      evidencia: `${atrasados.length} pedido(s) pendente(s) com data prometida vencida`,
    });
  }
  if (emRuptura && !pedidos.rows.length && !necessidades.rows.length) {
    origem.push({
      causa: 'Reposicao nao iniciada',
      evidencia: 'Sem pedido aberto e sem necessidade de compra registrada',
    });
  }
  if (semFornecedor) {
    origem.push({
      causa: 'Produto sem fornecedor ativo vinculado',
      evidencia: 'Nenhum fornecedor ativo em produto_fornecedor',
    });
  } else if (fornecedores.rows.length === 1) {
    origem.push({
      causa: 'Produto monoprovedor',
      evidencia: 'Um unico fornecedor ativo - sem alternativa em caso de falha',
    });
  }
  if (num(p.estoque_quarentena) > 0) {
    origem.push({
      causa: 'Parte do estoque retida em quarentena',
      evidencia: `${num(p.estoque_quarentena)} em quarentena, fora do disponivel`,
    });
  }
  if (ncs.rows.length) {
    origem.push({
      causa: 'Historico recente de nao conformidade',
      evidencia: `${ncs.rows.length} NC registrada(s) para o produto`,
    });
  }
  if (demanda > 0 && cobertura !== null && cobertura > 0 && cobertura < 7) {
    origem.push({
      causa: 'Demanda alta em relacao ao saldo',
      evidencia: `Cobertura de ${cobertura} dia(s) no ritmo atual de consumo`,
    });
  }

  return {
    produto: produto[0],
    // O que esta acontecendo
    situacao: {
      disponivel,
      em_transito: num(p.estoque_em_transito),
      quarentena: num(p.estoque_quarentena),
      demanda_diaria: demanda,
      cobertura_dias: cobertura,
      em_ruptura: emRuptura,
    },
    // Qual o impacto
    impacto: {
      valor_demanda_diaria: Math.round(demanda * num(produto[0].custo) * 100) / 100,
      classificacao_abc: produto[0].classificacao_abc,
    },
    // Qual a origem: causas observadas, com a evidencia de cada uma
    origem: origem.length ? origem : [{
      causa: 'Sem causa aparente nos registros consultados',
      evidencia: 'Pedidos, necessidades, fornecedores e qualidade sem apontamento',
    }],
    // Registros relacionados, agrupados: e a lista que a tela abre
    relacionados: {
      pedidos_abertos: pedidos.rows,
      necessidades: necessidades.rows,
      recebimentos_recentes: recebimentos.rows,
      nao_conformidades: ncs.rows,
      fornecedores: fornecedores.rows,
    },
    // O que da para fazer - atalhos de navegacao, nunca execucao (secao 73)
    acoes_disponiveis: [
      { rotulo: 'Abrir necessidade de compra', rota: '/compras', tipo: 'NAVEGAR' },
      { rotulo: 'Ver pedidos do produto', rota: '/ordens-compra', tipo: 'NAVEGAR' },
      { rotulo: 'Acompanhar entregas', rota: '/entregas', tipo: 'NAVEGAR' },
      { rotulo: 'Ver posicao de estoque', rota: '/estoque', tipo: 'NAVEGAR' },
    ],
    observacao: 'Contexto para decisao. O sistema nao executa acao automatica',
    atualizado_em: new Date().toISOString(),
  };
}
