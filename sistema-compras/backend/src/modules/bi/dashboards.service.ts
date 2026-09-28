/**
 * Dashboards.
 *
 * Um dashboard aqui e uma LISTA DE CODIGOS DE KPI mais alguns blocos de
 * contexto. Ele nao calcula nada: pede tudo ao catalogo. E isso que garante
 * que o OTIF do executivo seja o mesmo do de logistica (secao 67).
 *
 * Cada dashboard responde as cinco perguntas da secao 4: o que esta
 * acontecendo (os KPIs), por que (os detalhes de cada um), qual o impacto
 * (valor associado), o que precisa de atencao (semaforo e alertas) e qual a
 * origem do dado (fonte e formula, que vem junto de cada KPI).
 */
import { query } from '../../config/database.js';
import { naoEncontrado } from '../../core/errors.js';
import { classificarRisco, pareto, type FatorRisco } from './calculos.js';
import { resolverPeriodo, type FiltroGlobal } from './filtros.js';
import { apurarVarios, configuracoes, numeroConfig, type ResultadoKpi } from './kpi.service.js';

const num = (v: unknown) => Number(v ?? 0);

/** Composicao oficial de cada dashboard (secoes 6 e 26 a 34). */
export const COMPOSICAO: Record<string, { titulo: string; kpis: string[]; perfil: string }> = {
  EXECUTIVO: {
    titulo: 'Dashboard executivo',
    perfil: 'DIRETORIA',
    kpis: [
      'VALOR_COMPRADO', 'COMPRAS_EM_ABERTO', 'PEDIDOS_ATRASADOS', 'SAVING',
      'PRECO_MEDIO', 'VARIACAO_PRECO',
      'VALOR_ESTOQUE', 'COBERTURA_MEDIA', 'GIRO_ESTOQUE', 'PRODUTOS_RUPTURA',
      'PRODUTOS_EXCESSO', 'ESTOQUE_CRITICO', 'ESTOQUE_PARADO',
      'OTIF', 'OTD', 'TAXA_APROVACAO', 'TAXA_NC',
      'FORNECEDORES_MONITORADOS', 'FORNECEDORES_BLOQUEADOS',
      'ENTREGAS_ATRASADAS', 'LEAD_TIME_REAL',
      'TAXA_DEVOLUCAO', 'ESTOQUE_QUARENTENA',
    ],
  },
  COMPRAS: {
    titulo: 'Dashboard de compras',
    perfil: 'GESTOR_COMPRAS',
    kpis: [
      'VALOR_COMPRADO', 'QUANTIDADE_COMPRADA', 'PRECO_MEDIO', 'VARIACAO_PRECO',
      'SAVING', 'COMPRAS_EM_ABERTO', 'PEDIDOS_ATRASADOS', 'PRAZO_MEDIO_PAGAMENTO',
      'NECESSIDADE_TOTAL', 'NECESSIDADE_URGENTE',
    ],
  },
  ESTOQUE: {
    titulo: 'Dashboard de estoque',
    perfil: 'ESTOQUE',
    kpis: [
      'VALOR_ESTOQUE', 'ESTOQUE_DISPONIVEL', 'ESTOQUE_QUARENTENA', 'COBERTURA_MEDIA',
      'GIRO_ESTOQUE', 'PRODUTOS_RUPTURA', 'VALOR_RUPTURA', 'PRODUTOS_EXCESSO',
      'VALOR_EXCESSO', 'ESTOQUE_PARADO', 'ESTOQUE_CRITICO',
    ],
  },
  DEMANDA: {
    titulo: 'Dashboard de demanda',
    perfil: 'COMERCIAL',
    kpis: ['DEMANDA_MEDIA_DIARIA', 'ACURACIDADE_PREVISAO', 'PRODUTOS_SAZONAIS',
      'PRODUTOS_RUPTURA', 'COBERTURA_MEDIA'],
  },
  FORNECEDORES: {
    titulo: 'Dashboard de fornecedores',
    perfil: 'GESTOR_COMPRAS',
    kpis: [
      'SCORE_FORNECEDOR', 'OTIF', 'OTD', 'IN_FULL', 'ATRASO_MEDIO', 'LEAD_TIME_REAL',
      'TAXA_APROVACAO', 'TAXA_NC', 'TAXA_DEVOLUCAO', 'NC_CRITICAS',
      'FORNECEDORES_MONITORADOS', 'FORNECEDORES_BLOQUEADOS',
    ],
  },
  LOGISTICA: {
    titulo: 'Dashboard de logistica',
    perfil: 'GESTOR_COMPRAS',
    kpis: ['OTIF', 'OTD', 'IN_FULL', 'ATRASO_MEDIO', 'LEAD_TIME_REAL',
      'ENTREGAS_ATRASADAS', 'PEDIDOS_ATRASADOS', 'COMPRAS_EM_ABERTO'],
  },
  RECEBIMENTO: {
    titulo: 'Dashboard de recebimento',
    perfil: 'ESTOQUE',
    kpis: ['RECEBIMENTOS_PENDENTES', 'TAXA_APROVACAO', 'TAXA_DIVERGENCIA',
      'TEMPO_CONFERENCIA', 'ESTOQUE_QUARENTENA', 'TAXA_DEVOLUCAO', 'VALOR_RECEBIDO'],
  },
  QUALIDADE: {
    titulo: 'Dashboard de qualidade',
    perfil: 'QUALIDADE',
    kpis: ['TAXA_APROVACAO', 'TAXA_NC', 'NC_CRITICAS', 'TAXA_DEVOLUCAO',
      'ESTOQUE_QUARENTENA', 'TAXA_DIVERGENCIA'],
  },
  FINANCEIRO: {
    titulo: 'Dashboard financeiro de compras',
    perfil: 'FINANCEIRO',
    kpis: ['VALOR_COMPRADO', 'VALOR_RECEBIDO', 'COMPRAS_EM_ABERTO', 'COMPROMISSO_FUTURO',
      'PRAZO_MEDIO_PAGAMENTO', 'SAVING', 'VALOR_ESTOQUE', 'VALOR_IMPORTACAO'],
  },
  RISCOS: {
    titulo: 'Mapa de riscos de compras',
    perfil: 'GESTOR_COMPRAS',
    kpis: ['PRODUTOS_RUPTURA', 'VALOR_RUPTURA', 'PRODUTOS_EXCESSO', 'VALOR_EXCESSO',
      'PRODUTOS_MONOPROVEDOR', 'FORNECEDORES_MONITORADOS', 'FORNECEDORES_BLOQUEADOS',
      'PEDIDOS_ATRASADOS', 'NC_CRITICAS', 'QUALIDADE_DADOS'],
  },
  COMPRADOR: {
    titulo: 'Painel do comprador',
    perfil: 'COMPRADOR',
    kpis: ['NECESSIDADE_URGENTE', 'NECESSIDADE_TOTAL', 'PEDIDOS_ATRASADOS',
      'ENTREGAS_ATRASADAS', 'RECEBIMENTOS_PENDENTES', 'COMPRAS_EM_ABERTO'],
  },
  IMPORTACOES: {
    titulo: 'Dashboard de importacoes',
    perfil: 'GESTOR_COMPRAS',
    kpis: ['PEDIDOS_IMPORTACAO', 'VALOR_IMPORTACAO', 'LEAD_TIME_REAL',
      'PEDIDOS_ATRASADOS'],
  },
};

/** Agrupa os KPIs em blocos, como a secao 6 pede no executivo. */
const BLOCOS: Record<string, Record<string, string[]>> = {
  EXECUTIVO: {
    compras: ['VALOR_COMPRADO', 'COMPRAS_EM_ABERTO', 'PEDIDOS_ATRASADOS', 'SAVING',
      'PRECO_MEDIO', 'VARIACAO_PRECO'],
    estoque: ['VALOR_ESTOQUE', 'COBERTURA_MEDIA', 'GIRO_ESTOQUE', 'PRODUTOS_RUPTURA',
      'PRODUTOS_EXCESSO', 'ESTOQUE_CRITICO', 'ESTOQUE_PARADO'],
    fornecedores: ['OTIF', 'OTD', 'TAXA_APROVACAO', 'TAXA_NC',
      'FORNECEDORES_MONITORADOS', 'FORNECEDORES_BLOQUEADOS'],
    logistica: ['ENTREGAS_ATRASADAS', 'LEAD_TIME_REAL'],
    qualidade: ['TAXA_APROVACAO', 'TAXA_DEVOLUCAO', 'ESTOQUE_QUARENTENA'],
  },
};

export interface Dashboard {
  codigo: string;
  titulo: string;
  perfil: string;
  periodo: ReturnType<typeof resolverPeriodo>;
  filtros_aplicados: Record<string, unknown>;
  /** Dimensoes que algum KPI do painel nao soube aplicar. */
  filtros_ignorados: string[];
  kpis: ResultadoKpi[];
  blocos?: Record<string, ResultadoKpi[]>;
  resumo: {
    total: number;
    calculaveis: number;
    sem_dados: number;
    verde: number;
    amarelo: number;
    vermelho: number;
    cinza: number;
  };
  extras?: Record<string, unknown>;
  atualizado_em: string;
  /** Secao 54: o painel diz se o dado e do momento. */
  tempo_real: boolean;
}

export async function montar(
  codigo: string, filtro: FiltroGlobal,
): Promise<Dashboard> {
  const composicao = COMPOSICAO[codigo.toUpperCase()];
  if (!composicao) throw naoEncontrado(`Dashboard ${codigo}`);

  const config = await configuracoes();
  const periodo = resolverPeriodo(filtro, numeroConfig(config, 'bi.dias_padrao', 90));
  const kpis = await apurarVarios(composicao.kpis, filtro);

  const ignorados = [...new Set(kpis.flatMap((k) => k.filtros_ignorados))];
  const blocos = BLOCOS[codigo.toUpperCase()];

  return {
    codigo: codigo.toUpperCase(),
    titulo: composicao.titulo,
    perfil: composicao.perfil,
    periodo,
    filtros_aplicados: kpis[0]?.filtros_aplicados ?? {},
    filtros_ignorados: ignorados,
    kpis,
    blocos: blocos
      ? Object.fromEntries(Object.entries(blocos).map(([nome, codigos]) =>
        [nome, kpis.filter((k) => codigos.includes(k.codigo))]))
      : undefined,
    resumo: {
      total: kpis.length,
      calculaveis: kpis.filter((k) => k.calculavel).length,
      sem_dados: kpis.filter((k) => !k.calculavel).length,
      verde: kpis.filter((k) => k.semaforo === 'VERDE').length,
      amarelo: kpis.filter((k) => k.semaforo === 'AMARELO').length,
      vermelho: kpis.filter((k) => k.semaforo === 'VERMELHO').length,
      cinza: kpis.filter((k) => k.semaforo === 'CINZA').length,
    },
    atualizado_em: new Date().toISOString(),
    // Todos os KPIs sao apurados na hora da consulta, direto das tabelas
    // operacionais. Nao ha cache nem janela de atualizacao.
    tempo_real: true,
  };
}

export async function listarDashboards(perfil?: string) {
  const valores: unknown[] = [];
  const cond = ['d.sistema', 'd.ativo'];
  if (perfil && perfil !== 'ADMIN') {
    valores.push(perfil);
    cond.push(`(d.perfil IS NULL OR d.perfil = $${valores.length})`);
  }

  const { rows } = await query(`
    SELECT d.codigo, d.nome, d.descricao, d.perfil, d.padrao, d.ordem
      FROM dashboards d WHERE ${cond.join(' AND ')} ORDER BY d.ordem`, valores);

  return rows.map((d: Record<string, any>) => ({
    ...d,
    kpis: COMPOSICAO[String(d.codigo).toUpperCase()]?.kpis.length ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Pareto (secao 48)
// ---------------------------------------------------------------------------

const ANALISES_PARETO: Record<string, { titulo: string; sql: string; rotulo: string }> = {
  COMPRAS_FORNECEDOR: {
    titulo: 'Fornecedores que concentram o valor comprado',
    rotulo: 'fornecedor',
    sql: `SELECT f.razao_social AS rotulo, sum(oc.valor_total)::numeric AS valor
            FROM ordens_compra oc JOIN fornecedores f ON f.id = oc.fornecedor_id
           WHERE oc.data_emissao BETWEEN $1::date AND $2::date
             AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')
           GROUP BY f.razao_social`,
  },
  COMPRAS_PRODUTO: {
    titulo: 'Produtos que concentram o valor comprado',
    rotulo: 'produto',
    sql: `SELECT p.descricao AS rotulo, sum(oci.valor_total)::numeric AS valor
            FROM ordem_compra_itens oci
            JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
            JOIN produtos p ON p.id = oci.produto_id
           WHERE oc.data_emissao BETWEEN $1::date AND $2::date
             AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')
           GROUP BY p.descricao`,
  },
  NC_FORNECEDOR: {
    titulo: 'Fornecedores que concentram as nao conformidades',
    rotulo: 'fornecedor',
    sql: `SELECT f.razao_social AS rotulo, count(*)::numeric AS valor
            FROM nao_conformidades n JOIN fornecedores f ON f.id = n.fornecedor_id
           WHERE n.created_at >= $1::date AND n.created_at < ($2::date + interval '1 day')
           GROUP BY f.razao_social`,
  },
  NC_TIPO: {
    titulo: 'Tipos de nao conformidade mais frequentes',
    rotulo: 'tipo',
    sql: `SELECT n.tipo::text AS rotulo, count(*)::numeric AS valor
            FROM nao_conformidades n
           WHERE n.created_at >= $1::date AND n.created_at < ($2::date + interval '1 day')
           GROUP BY n.tipo`,
  },
  ATRASO_FORNECEDOR: {
    titulo: 'Fornecedores que concentram os atrasos',
    rotulo: 'fornecedor',
    sql: `SELECT f.razao_social AS rotulo, count(*)::numeric AS valor
            FROM ordem_compra_itens oci
            JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
            JOIN fornecedores f ON f.id = oc.fornecedor_id
           WHERE oci.quantidade_pendente > 0 AND oci.data_prometida < CURRENT_DATE
             AND oc.data_emissao BETWEEN $1::date AND $2::date
           GROUP BY f.razao_social`,
  },
  DIVERGENCIA_TIPO: {
    titulo: 'Tipos de divergencia mais frequentes no recebimento',
    rotulo: 'tipo',
    sql: `SELECT d.tipo::text AS rotulo, count(*)::numeric AS valor
            FROM recebimento_divergencias d
           WHERE d.detectada_em >= $1::date
             AND d.detectada_em < ($2::date + interval '1 day')
           GROUP BY d.tipo`,
  },
  EXCESSO_PRODUTO: {
    titulo: 'Produtos que concentram o valor em excesso',
    rotulo: 'produto',
    sql: `SELECT p.descricao AS rotulo,
                 (sum(e.quantidade_fisica) * coalesce(p.custo_referencia, 0))::numeric AS valor
            FROM estoques e JOIN produtos p ON p.id = e.produto_id
           WHERE e.quantidade_fisica > 0 AND p.ativo AND p.deleted_at IS NULL
             AND $1::date IS NOT NULL AND $2::date IS NOT NULL
           GROUP BY p.id, p.descricao, p.custo_referencia`,
  },
};

export async function analisePareto(analise: string, filtro: FiltroGlobal) {
  const definicao = ANALISES_PARETO[analise.toUpperCase()];
  if (!definicao) throw naoEncontrado(`Analise de Pareto ${analise}`);

  const config = await configuracoes();
  const periodo = resolverPeriodo(filtro, numeroConfig(config, 'bi.dias_padrao', 90));

  const { rows } = await query(definicao.sql, [periodo.inicio, periodo.fim]);
  const resultado = pareto(
    rows.map((r: Record<string, any>) => ({ rotulo: r.rotulo, valor: num(r.valor) })));

  return {
    analise: analise.toUpperCase(),
    titulo: definicao.titulo,
    dimensao: definicao.rotulo,
    periodo,
    ...resultado,
    leitura: resultado.percentualVitais === null
      ? 'Sem dados no periodo'
      : `${resultado.vitais} de ${resultado.linhas.length} `
        + `(${resultado.percentualVitais}%) explicam ${resultado.corte}% do total`,
  };
}

export const analisesPareto = () =>
  Object.entries(ANALISES_PARETO).map(([codigo, d]) => ({
    codigo, titulo: d.titulo, dimensao: d.rotulo,
  }));

// ---------------------------------------------------------------------------
// Matriz ABC x XYZ (secao 37)
// ---------------------------------------------------------------------------

export async function matrizAbcXyz(filtro: FiltroGlobal) {
  const valores: unknown[] = [];
  const cond: string[] = ['p.ativo', 'p.deleted_at IS NULL'];
  if (filtro.categoria_id) {
    valores.push(filtro.categoria_id);
    cond.push(`p.categoria_id = $${valores.length}`);
  }

  const { rows } = await query(`
    SELECT coalesce(p.classificacao_abc::text, 'SEM_CLASSE') AS abc,
           coalesce(p.classificacao_xyz::text, 'SEM_CLASSE') AS xyz,
           count(*)::int AS produtos,
           coalesce(sum(e.fisico * coalesce(p.custo_referencia, 0)), 0) AS valor,
           coalesce(sum(e.disponivel), 0) AS disponivel,
           coalesce(avg(v.demanda_media_diaria) FILTER (
             WHERE v.demanda_media_diaria > 0), 0) AS demanda_diaria,
           count(*) FILTER (WHERE e.disponivel <= 0
                              AND v.demanda_media_diaria > 0)::int AS em_ruptura,
           coalesce(sum(n.valor_estimado), 0) AS necessidade
      FROM produtos p
      LEFT JOIN (
        SELECT produto_id, sum(quantidade_fisica) AS fisico,
               sum(quantidade_disponivel) AS disponivel
          FROM estoques GROUP BY produto_id
      ) e ON e.produto_id = p.id
      LEFT JOIN vw_estoque_atual v ON v.produto_id = p.id
      LEFT JOIN (
        SELECT produto_id, sum(valor_estimado) AS valor_estimado
          FROM necessidades_compra
         WHERE status IN ('PENDENTE','EM_ANALISE','APROVADA','AJUSTADA')
         GROUP BY produto_id
      ) n ON n.produto_id = p.id
     WHERE ${cond.join(' AND ')}
     GROUP BY 1, 2`, valores);

  const total = rows.reduce((a: number, r: Record<string, any>) => a + num(r.produtos), 0);

  return {
    total_produtos: total,
    // A coluna SEM_CLASSE existe de proposito: uma matriz que so mostra os
    // classificados esconde justamente os produtos que ninguem avaliou.
    observacao: 'Produtos sem classificacao aparecem em SEM_CLASSE, e nao sao omitidos',
    quadrantes: rows.map((r: Record<string, any>) => ({
      abc: r.abc,
      xyz: r.xyz,
      quadrante: `${r.abc}${r.xyz}`.replace(/SEM_CLASSE/g, '?'),
      produtos: num(r.produtos),
      valor: num(r.valor),
      disponivel: num(r.disponivel),
      demanda_diaria: num(r.demanda_diaria),
      em_ruptura: num(r.em_ruptura),
      necessidade: num(r.necessidade),
      percentual_produtos: total > 0
        ? Math.round((num(r.produtos) / total) * 10000) / 100 : null,
    })),
    atualizado_em: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Mapa de riscos (secoes 34, 35 e 36)
// ---------------------------------------------------------------------------

/**
 * Produtos criticos, com os fatores que produziram a criticidade.
 *
 * A secao 35 proibe criterio subjetivo: cada fator e um fato verificavel com
 * peso declarado. A secao 36 exige mostrar os fatores - por isso eles voltam
 * na resposta, nao so o nivel final.
 */
export async function mapaRiscos(filtro: FiltroGlobal) {
  const config = await configuracoes();
  const leadTimeElevado = numeroConfig(config, 'bi.lead_time_elevado_dias', 30);
  const coberturaCritica = numeroConfig(config, 'bi.cobertura_critica_dias', 7);
  const coberturaAtencao = numeroConfig(config, 'bi.cobertura_atencao_dias', 15);
  const excesso = numeroConfig(config, 'bi.excesso_cobertura_dias', 90);

  const valores: unknown[] = [];
  const cond = ['p.ativo', 'p.deleted_at IS NULL'];
  if (filtro.categoria_id) {
    valores.push(filtro.categoria_id);
    cond.push(`p.categoria_id = $${valores.length}`);
  }
  if (filtro.produto_id) {
    valores.push(filtro.produto_id);
    cond.push(`p.id = $${valores.length}`);
  }

  const { rows } = await query(`
    SELECT p.id AS produto_id, p.codigo, p.descricao,
           p.classificacao_abc::text AS abc, c.nome AS categoria,
           coalesce(p.custo_referencia, 0) AS custo,
           coalesce(e.disponivel, 0)       AS disponivel,
           coalesce(v.demanda_media_diaria, 0) AS demanda_diaria,
           coalesce(v.cobertura_dias, NULL) AS cobertura,
           coalesce(f.fornecedores, 0)::int AS fornecedores,
           coalesce(f.lead_time_max, 0)     AS lead_time,
           coalesce(f.monitorados, 0)::int  AS fornecedores_monitorados,
           coalesce(a.atrasados, 0)::int    AS itens_atrasados,
           coalesce(q.ncs, 0)::int          AS ncs
      FROM produtos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      LEFT JOIN (
        SELECT produto_id, sum(quantidade_disponivel) AS disponivel
          FROM estoques GROUP BY produto_id
      ) e ON e.produto_id = p.id
      LEFT JOIN vw_estoque_atual v ON v.produto_id = p.id
      LEFT JOIN (
        SELECT pf.produto_id,
               count(DISTINCT pf.fornecedor_id)::int AS fornecedores,
               max(coalesce(pf.lead_time_dias, fo.lead_time_padrao_dias, 0)) AS lead_time_max,
               count(DISTINCT pf.fornecedor_id) FILTER (
                 WHERE fo.status_homologacao IN ('EM_MONITORAMENTO','BLOQUEADO'))::int
                 AS monitorados
          FROM produto_fornecedor pf
          JOIN fornecedores fo ON fo.id = pf.fornecedor_id
         WHERE pf.ativo AND fo.ativo AND fo.deleted_at IS NULL
         GROUP BY pf.produto_id
      ) f ON f.produto_id = p.id
      LEFT JOIN (
        SELECT oci.produto_id, count(*)::int AS atrasados
          FROM ordem_compra_itens oci
          JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
         WHERE oci.quantidade_pendente > 0 AND oci.data_prometida < CURRENT_DATE
           AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')
         GROUP BY oci.produto_id
      ) a ON a.produto_id = p.id
      LEFT JOIN (
        SELECT produto_id, count(*)::int AS ncs
          FROM nao_conformidades
         WHERE created_at > now() - interval '180 days'
         GROUP BY produto_id
      ) q ON q.produto_id = p.id
     WHERE ${cond.join(' AND ')}`, valores);

  const avaliados = rows.map((r: Record<string, any>) => {
    const fatores: FatorRisco[] = [];
    const demanda = num(r.demanda_diaria);
    const disponivel = num(r.disponivel);
    const cobertura = demanda > 0 ? disponivel / demanda : null;

    // --- Probabilidade: o quanto o problema tende a acontecer
    if (demanda > 0 && disponivel <= 0) {
      fatores.push({
        codigo: 'RUPTURA', dimensao: 'PROBABILIDADE', peso: 45,
        descricao: 'Produto com demanda e sem estoque disponivel',
      });
    } else if (cobertura !== null && cobertura <= coberturaCritica) {
      fatores.push({
        codigo: 'COBERTURA_CRITICA', dimensao: 'PROBABILIDADE', peso: 35,
        descricao: `Cobertura de ${cobertura.toFixed(1)} dias, abaixo de ${coberturaCritica}`,
      });
    } else if (cobertura !== null && cobertura <= coberturaAtencao) {
      fatores.push({
        codigo: 'COBERTURA_BAIXA', dimensao: 'PROBABILIDADE', peso: 20,
        descricao: `Cobertura de ${cobertura.toFixed(1)} dias, abaixo de ${coberturaAtencao}`,
      });
    }
    if (num(r.fornecedores) === 1) {
      fatores.push({
        codigo: 'FORNECEDOR_UNICO', dimensao: 'PROBABILIDADE', peso: 25,
        descricao: 'Apenas um fornecedor ativo cadastrado',
      });
    }
    if (num(r.fornecedores) === 0) {
      fatores.push({
        codigo: 'SEM_FORNECEDOR', dimensao: 'PROBABILIDADE', peso: 35,
        descricao: 'Nenhum fornecedor ativo cadastrado para o produto',
      });
    }
    if (num(r.lead_time) >= leadTimeElevado) {
      fatores.push({
        codigo: 'LEAD_TIME_ELEVADO', dimensao: 'PROBABILIDADE', peso: 20,
        descricao: `Lead time de ${num(r.lead_time)} dias`,
      });
    }
    if (num(r.itens_atrasados) > 0) {
      fatores.push({
        codigo: 'PEDIDO_ATRASADO', dimensao: 'PROBABILIDADE', peso: 20,
        descricao: `${num(r.itens_atrasados)} item(ns) de pedido atrasado(s)`,
      });
    }
    if (num(r.fornecedores_monitorados) > 0) {
      fatores.push({
        codigo: 'FORNECEDOR_MONITORADO', dimensao: 'PROBABILIDADE', peso: 15,
        descricao: 'Fornecedor em monitoramento ou bloqueado',
      });
    }

    // --- Impacto: o quanto doi se acontecer
    if (r.abc === 'A') {
      fatores.push({
        codigo: 'CLASSE_A', dimensao: 'IMPACTO', peso: 45,
        descricao: 'Produto classe A na curva ABC',
      });
    } else if (r.abc === 'B') {
      fatores.push({
        codigo: 'CLASSE_B', dimensao: 'IMPACTO', peso: 25,
        descricao: 'Produto classe B na curva ABC',
      });
    }
    const valorDiario = demanda * num(r.custo);
    if (valorDiario > 0) {
      fatores.push({
        codigo: 'VALOR_DEMANDA', dimensao: 'IMPACTO',
        peso: Math.min(35, Math.round(Math.log10(valorDiario + 1) * 12)),
        descricao: `Demanda diaria valorizada em ${valorDiario.toFixed(2)}`,
      });
    }
    if (num(r.ncs) > 0) {
      fatores.push({
        codigo: 'HISTORICO_NC', dimensao: 'IMPACTO', peso: Math.min(20, num(r.ncs) * 5),
        descricao: `${num(r.ncs)} nao conformidade(s) nos ultimos 180 dias`,
      });
    }
    if (cobertura !== null && cobertura >= excesso) {
      fatores.push({
        codigo: 'EXCESSO', dimensao: 'IMPACTO', peso: 20,
        descricao: `Cobertura de ${cobertura.toFixed(0)} dias, acima de ${excesso}`,
      });
    }

    const risco = classificarRisco(fatores);
    return {
      produto_id: Number(r.produto_id),
      codigo: r.codigo,
      produto: r.descricao,
      categoria: r.categoria,
      abc: r.abc,
      disponivel,
      demanda_diaria: demanda,
      cobertura: cobertura === null ? null : Math.round(cobertura * 10) / 10,
      fornecedores: num(r.fornecedores),
      lead_time: num(r.lead_time),
      ...risco,
    };
  })
    .filter((r) => r.fatores.length > 0)
    .sort((a, b) => {
      const ordem = { CRITICO: 1, ALTO: 2, MODERADO: 3, BAIXO: 4 };
      return (ordem[a.nivel] - ordem[b.nivel])
        || (b.probabilidade + b.impacto) - (a.probabilidade + a.impacto);
    });

  const contar = (nivel: string) => avaliados.filter((r) => r.nivel === nivel).length;

  return {
    total: avaliados.length,
    por_nivel: {
      CRITICO: contar('CRITICO'), ALTO: contar('ALTO'),
      MODERADO: contar('MODERADO'), BAIXO: contar('BAIXO'),
    },
    matriz: ['ALTA', 'MEDIA', 'BAIXA'].map((prob) => ({
      probabilidade: prob,
      celulas: ['BAIXA', 'MEDIA', 'ALTA'].map((imp) => ({
        impacto: imp,
        produtos: avaliados.filter(
          (r) => r.faixaProbabilidade === prob && r.faixaImpacto === imp).length,
      })),
    })),
    parametros: {
      lead_time_elevado_dias: leadTimeElevado,
      cobertura_critica_dias: coberturaCritica,
      cobertura_atencao_dias: coberturaAtencao,
      excesso_cobertura_dias: excesso,
    },
    observacao: 'A classificacao vem de fatores objetivos com peso declarado;'
      + ' os fatores de cada produto acompanham a linha (secao 36)',
    produtos: avaliados.slice(0, 200),
    atualizado_em: new Date().toISOString(),
  };
}
