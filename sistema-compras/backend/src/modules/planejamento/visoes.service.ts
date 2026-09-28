import { query } from '../../config/database.js';
import { naoEncontrado } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import { planejamentoVigente, carregarConfig } from './planejamento.service.js';

/** Todas as visoes deste arquivo olham para o planejamento vigente. */
async function planejamento(id?: number): Promise<number | null> {
  return id ?? await planejamentoVigente();
}

// ---------------------------------------------------------------------------
// Dashboard de compras (secao 4)
// ---------------------------------------------------------------------------

export async function dashboard(planejamentoId?: number) {
  const id = await planejamento(planejamentoId);
  if (!id) return { planejamento: null, aviso: 'Nenhum planejamento calculado ainda' };

  const [cabecalho, indicadores, porCategoria, porFornecedor, porPrioridade, porSemana] = await Promise.all([
    query(`SELECT pl.*, u.nome AS usuario, l.nome AS local
             FROM planejamentos_compra pl
             LEFT JOIN usuarios u ON u.id = pl.usuario_id
             LEFT JOIN locais l ON l.id = pl.local_id
            WHERE pl.id = $1`, [id]),
    query(`
      SELECT
        count(*)::int                                                  AS itens,
        count(DISTINCT n.produto_id)::int                              AS produtos,
        coalesce(sum(n.quantidade_sugerida), 0)                        AS quantidade_total,
        coalesce(sum(n.valor_estimado), 0)                             AS valor_total,
        coalesce(sum(n.custo_total_estimado), 0)                       AS custo_total,
        count(*) FILTER (WHERE n.prioridade = 'RUPTURA')::int          AS ruptura,
        count(*) FILTER (WHERE n.prioridade = 'CRITICA')::int          AS risco_ruptura,
        count(*) FILTER (WHERE n.prioridade = 'ALTA')::int             AS abaixo_ponto_pedido,
        count(*) FILTER (WHERE n.excesso IS NOT NULL)::int             AS com_excesso,
        count(*) FILTER (WHERE n.pedido_atrasado)::int                 AS com_pedido_atrasado,
        count(*) FILTER (WHERE n.transferencia_possivel IS NOT NULL)::int AS atendiveis_por_transferencia,
        count(*) FILTER (WHERE n.fornecedor_id IS NULL)::int           AS sem_fornecedor,
        count(*) FILTER (WHERE n.origem_demanda = 'SEM_BASE')::int     AS sem_base_de_demanda,
        count(*) FILTER (WHERE n.status = 'APROVADA')::int             AS aprovadas,
        count(*) FILTER (WHERE n.status = 'PENDENTE')::int             AS pendentes,
        coalesce(sum(n.valor_estimado) FILTER (WHERE n.data_ideal_compra <= CURRENT_DATE + 7), 0)  AS valor_7d,
        coalesce(sum(n.valor_estimado) FILTER (WHERE n.data_ideal_compra <= CURRENT_DATE + 15), 0) AS valor_15d,
        coalesce(sum(n.valor_estimado) FILTER (WHERE n.data_ideal_compra <= CURRENT_DATE + 30), 0) AS valor_30d,
        count(*) FILTER (WHERE n.data_ideal_compra <= CURRENT_DATE + 7)::int  AS itens_7d,
        count(*) FILTER (WHERE n.data_ideal_compra <= CURRENT_DATE + 15)::int AS itens_15d,
        count(*) FILTER (WHERE n.data_ideal_compra <= CURRENT_DATE + 30)::int AS itens_30d
      FROM necessidades_compra n
      WHERE n.planejamento_id = $1 AND n.quantidade_sugerida > 0`, [id]),
    query(`
      SELECT c.nome AS categoria, count(*)::int AS itens,
             coalesce(sum(n.quantidade_sugerida), 0) AS quantidade,
             coalesce(sum(n.valor_estimado), 0) AS valor
        FROM necessidades_compra n
        JOIN produtos p ON p.id = n.produto_id
        JOIN categorias c ON c.id = p.categoria_id
       WHERE n.planejamento_id = $1 AND n.quantidade_sugerida > 0
       GROUP BY c.nome ORDER BY valor DESC LIMIT 15`, [id]),
    query(`
      SELECT coalesce(f.razao_social, 'SEM FORNECEDOR') AS fornecedor,
             n.fornecedor_id, count(*)::int AS itens,
             coalesce(sum(n.valor_estimado), 0) AS valor
        FROM necessidades_compra n
        LEFT JOIN fornecedores f ON f.id = n.fornecedor_id
       WHERE n.planejamento_id = $1 AND n.quantidade_sugerida > 0
       GROUP BY 1, 2 ORDER BY valor DESC LIMIT 15`, [id]),
    query(`
      SELECT n.prioridade, count(*)::int AS itens,
             coalesce(sum(n.valor_estimado), 0) AS valor
        FROM necessidades_compra n
       WHERE n.planejamento_id = $1 AND n.quantidade_sugerida > 0
       GROUP BY n.prioridade
       ORDER BY CASE n.prioridade WHEN 'RUPTURA' THEN 1 WHEN 'CRITICA' THEN 2
                                  WHEN 'ALTA' THEN 3 WHEN 'MEDIA' THEN 4
                                  WHEN 'BAIXA' THEN 5 ELSE 6 END`, [id]),
    query(`
      SELECT date_trunc('week', n.data_ideal_compra)::date AS semana,
             count(*)::int AS itens, coalesce(sum(n.valor_estimado), 0) AS valor
        FROM necessidades_compra n
       WHERE n.planejamento_id = $1 AND n.quantidade_sugerida > 0
         AND n.data_ideal_compra IS NOT NULL
         AND n.data_ideal_compra <= CURRENT_DATE + 90
       GROUP BY 1 ORDER BY 1`, [id]),
  ]);

  return {
    planejamento: cabecalho.rows[0] ?? null,
    indicadores: indicadores.rows[0],
    por_categoria: porCategoria.rows,
    por_fornecedor: porFornecedor.rows,
    por_prioridade: porPrioridade.rows,
    por_semana: porSemana.rows,
  };
}

// ---------------------------------------------------------------------------
// Compras por fornecedor (secao 28) e consolidacao (secao 29)
// ---------------------------------------------------------------------------

export async function porFornecedor(planejamentoId?: number) {
  const id = await planejamento(planejamentoId);
  if (!id) return [];

  const { rows } = await query(`
    SELECT n.fornecedor_id,
           coalesce(f.razao_social, 'SEM FORNECEDOR') AS fornecedor,
           f.origem_fornecedor, f.prazo_medio_pagamento,
           count(*)::int                              AS itens,
           coalesce(sum(n.quantidade_sugerida), 0)    AS quantidade,
           coalesce(sum(n.valor_estimado), 0)         AS valor_produtos,
           coalesce(sum(n.frete_estimado), 0)         AS frete_estimado,
           coalesce(sum(n.custo_total_estimado), 0)   AS custo_total,
           max(n.lead_time_total_dias)                AS lead_time_maximo,
           min(n.data_ideal_compra)                   AS data_ideal_mais_proxima,
           max(n.data_prevista_chegada)               AS chegada_mais_distante,
           min(CASE n.prioridade WHEN 'RUPTURA' THEN 1 WHEN 'CRITICA' THEN 2
                                 WHEN 'ALTA' THEN 3 WHEN 'MEDIA' THEN 4
                                 WHEN 'BAIXA' THEN 5 ELSE 6 END) AS prioridade_ordem,
           count(*) FILTER (WHERE n.moq IS NOT NULL AND n.quantidade_sugerida < n.moq)::int AS itens_abaixo_moq
      FROM necessidades_compra n
      LEFT JOIN fornecedores f ON f.id = n.fornecedor_id
     WHERE n.planejamento_id = $1 AND n.quantidade_sugerida > 0
     GROUP BY n.fornecedor_id, f.razao_social, f.origem_fornecedor, f.prazo_medio_pagamento
     ORDER BY prioridade_ordem, custo_total DESC`, [id]);

  const PRIORIDADES = ['RUPTURA', 'CRITICA', 'ALTA', 'MEDIA', 'BAIXA', 'SEM_NECESSIDADE'];
  return rows.map((r) => ({
    ...r,
    prioridade: PRIORIDADES[Number(r.prioridade_ordem) - 1] ?? 'SEM_NECESSIDADE',
  }));
}

/**
 * Consolidacao (secao 29). O agrupamento e escolhido por quem consulta:
 * fornecedor, categoria, local, data ideal ou origem nacional/importado.
 */
export async function consolidar(criterio: string, planejamentoId?: number) {
  const id = await planejamento(planejamentoId);
  if (!id) return { criterio, grupos: [] };

  const colunas: Record<string, string> = {
    FORNECEDOR: "coalesce(f.razao_social, 'SEM FORNECEDOR')",
    CATEGORIA: 'c.nome',
    LOCAL: "coalesce(l.nome, 'SEM LOCAL')",
    DATA_IDEAL: "to_char(n.data_ideal_compra, 'YYYY-MM-DD')",
    SEMANA: "to_char(date_trunc('week', n.data_ideal_compra), 'YYYY-MM-DD')",
    ORIGEM: "coalesce(f.origem_fornecedor::text, 'SEM FORNECEDOR')",
    MOEDA: "coalesce(pf.moeda, 'BRL')",
  };
  const coluna = colunas[criterio] ?? colunas.FORNECEDOR;

  const { rows } = await query(`
    SELECT ${coluna} AS grupo,
           count(*)::int AS itens,
           coalesce(sum(n.quantidade_sugerida), 0) AS quantidade,
           coalesce(sum(n.valor_estimado), 0) AS valor,
           coalesce(sum(n.custo_total_estimado), 0) AS custo_total,
           min(n.data_ideal_compra) AS data_ideal,
           jsonb_agg(jsonb_build_object(
             'necessidade_id', n.id, 'produto_id', n.produto_id, 'codigo', p.codigo,
             'descricao', p.descricao, 'quantidade', n.quantidade_sugerida,
             'valor', n.valor_estimado, 'prioridade', n.prioridade
           ) ORDER BY n.indice_prioridade DESC) AS itens_detalhe
      FROM necessidades_compra n
      JOIN produtos p ON p.id = n.produto_id
      JOIN categorias c ON c.id = p.categoria_id
      LEFT JOIN fornecedores f ON f.id = n.fornecedor_id
      LEFT JOIN locais l ON l.id = n.local_id
      LEFT JOIN produto_fornecedor pf ON pf.produto_id = n.produto_id AND pf.fornecedor_id = n.fornecedor_id
     WHERE n.planejamento_id = $1 AND n.quantidade_sugerida > 0
     GROUP BY 1 ORDER BY custo_total DESC`, [id]);

  return { criterio, planejamento_id: id, grupos: rows };
}

// ---------------------------------------------------------------------------
// Calendario de compras (secao 41)
// ---------------------------------------------------------------------------

export async function calendario(dias: number, planejamentoId?: number, limite = 200) {
  const id = await planejamento(planejamentoId);
  if (!id) return { janelas: [], itens: [], itens_exibidos: 0, itens_totais: 0 };

  const JANELA = `CASE
             WHEN n.data_ideal_compra IS NULL THEN 'SEM_DATA'
             WHEN n.data_ideal_compra <= CURRENT_DATE THEN 'HOJE'
             WHEN n.data_ideal_compra <= CURRENT_DATE + 7 THEN 'PROXIMOS_7'
             WHEN n.data_ideal_compra <= CURRENT_DATE + 15 THEN 'PROXIMOS_15'
             WHEN n.data_ideal_compra <= CURRENT_DATE + 30 THEN 'PROXIMOS_30'
             ELSE 'FUTURO'
           END`;

  const FILTRO = `WHERE n.planejamento_id = $1 AND n.quantidade_sugerida > 0
       AND (n.data_ideal_compra IS NULL OR n.data_ideal_compra <= CURRENT_DATE + $2::int)`;

  // Os totais saem de uma agregacao no banco: contar no Node exigiria trazer
  // milhares de linhas so para soma-las.
  const { rows: agregado } = await query<{ janela: string; itens: number; valor: number }>(`
    SELECT ${JANELA} AS janela, count(*)::int AS itens,
           coalesce(sum(n.valor_estimado), 0) AS valor
      FROM necessidades_compra n
      ${FILTRO}
     GROUP BY 1`, [id, dias]);

  // A lista e so o topo da fila: o comprador nao rola 1.600 linhas no calendario.
  const { rows } = await query(`
    SELECT n.id, n.produto_id, p.codigo, p.descricao,
           coalesce(f.razao_social, 'SEM FORNECEDOR') AS fornecedor,
           n.quantidade_sugerida, n.valor_estimado, n.prioridade,
           n.data_ideal_compra, n.data_necessaria, n.data_prevista_chegada,
           ${JANELA} AS janela
      FROM necessidades_compra n
      JOIN produtos p ON p.id = n.produto_id
      LEFT JOIN fornecedores f ON f.id = n.fornecedor_id
      ${FILTRO}
     ORDER BY n.data_ideal_compra NULLS LAST, n.indice_prioridade DESC
     LIMIT $3`, [id, dias, limite]);

  const janelas = ['HOJE', 'PROXIMOS_7', 'PROXIMOS_15', 'PROXIMOS_30', 'FUTURO', 'SEM_DATA'];
  const mapa = new Map(agregado.map((a) => [a.janela, a]));
  const totais = agregado.reduce((a, x) => a + Number(x.itens), 0);

  return {
    planejamento_id: id,
    janelas: janelas.map((j) => ({
      janela: j,
      itens: Number(mapa.get(j)?.itens ?? 0),
      valor: Number(mapa.get(j)?.valor ?? 0),
    })),
    itens: rows,
    itens_exibidos: rows.length,
    itens_totais: totais,
  };
}

// ---------------------------------------------------------------------------
// Compras prioritarias e por produto
// ---------------------------------------------------------------------------

export async function prioritarias(filtro: Paginacao, planejamentoId?: number) {
  const id = await planejamento(planejamentoId);
  if (!id) return { dados: [], meta: metaPaginacao(0, filtro) };

  const total = await query<{ total: number }>(`
    SELECT count(*)::int AS total FROM necessidades_compra
     WHERE planejamento_id = $1 AND quantidade_sugerida > 0
       AND prioridade IN ('RUPTURA', 'CRITICA', 'ALTA')`, [id]);

  const { rows } = await query(`
    SELECT n.id, n.produto_id, p.codigo, p.descricao, p.classificacao_abc,
           n.prioridade, n.indice_prioridade, n.fatores_prioridade,
           n.estoque_disponivel, n.dias_cobertura, n.lead_time_total_dias,
           n.quantidade_sugerida, n.valor_estimado, n.data_ideal_compra,
           coalesce(f.razao_social, 'SEM FORNECEDOR') AS fornecedor, n.alertas
      FROM necessidades_compra n
      JOIN produtos p ON p.id = n.produto_id
      LEFT JOIN fornecedores f ON f.id = n.fornecedor_id
     WHERE n.planejamento_id = $1 AND n.quantidade_sugerida > 0
       AND n.prioridade IN ('RUPTURA', 'CRITICA', 'ALTA')
     ORDER BY n.indice_prioridade DESC, n.valor_estimado DESC
     LIMIT $2 OFFSET $3`, [id, filtro.limite, deslocamento(filtro)]);

  return { dados: rows, meta: metaPaginacao(total.rows[0]?.total ?? 0, filtro) };
}

export async function comprasEmAberto(filtro: Paginacao) {
  const total = await query<{ total: number }>(`
    SELECT count(*)::int AS total
      FROM ordem_compra_itens i JOIN ordens_compra oc ON oc.id = i.ordem_compra_id
     WHERE oc.status IN ('APROVADA','ENVIADA','CONFIRMADA','EM_PRODUCAO','EM_TRANSITO','RECEBIMENTO_PARCIAL')
       AND i.quantidade_pedida > coalesce(i.quantidade_recebida, 0)`);

  const { rows } = await query(`
    SELECT oc.numero, oc.status, oc.data_emissao, oc.data_prevista_entrega,
           f.razao_social AS fornecedor,
           p.codigo, p.descricao,
           i.quantidade_pedida, coalesce(i.quantidade_recebida, 0) AS quantidade_recebida,
           i.quantidade_pedida - coalesce(i.quantidade_recebida, 0) AS saldo_pendente,
           i.preco_unitario,
           (i.quantidade_pedida - coalesce(i.quantidade_recebida, 0)) * i.preco_unitario AS valor_pendente,
           CASE
             WHEN oc.data_prevista_entrega IS NULL THEN 'SEM_PRAZO'
             WHEN oc.data_prevista_entrega < CURRENT_DATE - 15 THEN 'MUITO_ATRASADO'
             WHEN oc.data_prevista_entrega < CURRENT_DATE THEN 'ATRASADO'
             WHEN oc.data_prevista_entrega <= CURRENT_DATE + 7 THEN 'PROXIMO_VENCIMENTO'
             ELSE 'NO_PRAZO'
           END AS situacao
      FROM ordem_compra_itens i
      JOIN ordens_compra oc ON oc.id = i.ordem_compra_id
      JOIN produtos p ON p.id = i.produto_id
      LEFT JOIN fornecedores f ON f.id = oc.fornecedor_id
     WHERE oc.status IN ('APROVADA','ENVIADA','CONFIRMADA','EM_PRODUCAO','EM_TRANSITO','RECEBIMENTO_PARCIAL')
       AND i.quantidade_pedida > coalesce(i.quantidade_recebida, 0)
     ORDER BY oc.data_prevista_entrega NULLS LAST
     LIMIT $1 OFFSET $2`, [filtro.limite, deslocamento(filtro)]);

  return { dados: rows, meta: metaPaginacao(total.rows[0]?.total ?? 0, filtro) };
}

// ---------------------------------------------------------------------------
// Impacto financeiro (secao 40) e acuracidade (secao 56)
// ---------------------------------------------------------------------------

export async function impactoFinanceiro(planejamentoId?: number) {
  const id = await planejamento(planejamentoId);
  if (!id) return null;

  const [total, porCategoria, porPeriodo, emAberto] = await Promise.all([
    query(`
      SELECT coalesce(sum(valor_estimado), 0)       AS valor_planejado,
             coalesce(sum(custo_total_estimado), 0) AS custo_planejado,
             coalesce(sum(frete_estimado), 0)       AS frete,
             coalesce(sum(valor_estimado) FILTER (WHERE status = 'APROVADA'), 0) AS valor_aprovado,
             coalesce(sum(excesso * coalesce(preco_estimado, 0)), 0) AS valor_excesso
        FROM necessidades_compra WHERE planejamento_id = $1`, [id]),
    query(`
      SELECT c.nome AS categoria, coalesce(sum(n.valor_estimado), 0) AS valor
        FROM necessidades_compra n
        JOIN produtos p ON p.id = n.produto_id
        JOIN categorias c ON c.id = p.categoria_id
       WHERE n.planejamento_id = $1 GROUP BY c.nome ORDER BY valor DESC`, [id]),
    query(`
      SELECT to_char(date_trunc('month', data_ideal_compra), 'YYYY-MM') AS mes,
             coalesce(sum(valor_estimado), 0) AS valor
        FROM necessidades_compra
       WHERE planejamento_id = $1 AND data_ideal_compra IS NOT NULL
       GROUP BY 1 ORDER BY 1`, [id]),
    query(`
      SELECT coalesce(sum((i.quantidade_pedida - coalesce(i.quantidade_recebida, 0)) * i.preco_unitario), 0) AS valor_em_aberto,
             coalesce(sum(CASE WHEN oc.status = 'EM_TRANSITO'
                               THEN (i.quantidade_pedida - coalesce(i.quantidade_recebida, 0)) * i.preco_unitario
                               ELSE 0 END), 0) AS valor_em_transito
        FROM ordem_compra_itens i JOIN ordens_compra oc ON oc.id = i.ordem_compra_id
       WHERE oc.status IN ('APROVADA','ENVIADA','CONFIRMADA','EM_PRODUCAO','EM_TRANSITO','RECEBIMENTO_PARCIAL')`),
    ]);

  const capital = await query(`
    SELECT coalesce(sum(e.quantidade_fisica * coalesce(pf.preco_atual, 0)), 0) AS capital_em_estoque
      FROM estoques e
      LEFT JOIN LATERAL (
        SELECT preco_atual FROM produto_fornecedor
         WHERE produto_id = e.produto_id ORDER BY fornecedor_principal DESC LIMIT 1
      ) pf ON true`);

  return {
    planejamento_id: id,
    ...total.rows[0],
    ...emAberto.rows[0],
    ...capital.rows[0],
    por_categoria: porCategoria.rows,
    por_periodo: porPeriodo.rows,
  };
}

/**
 * Acuracidade do planejamento (secao 56): o que foi planejado contra o que
 * virou compra de verdade. Sem planejamentos antigos o suficiente, diz isso
 * em vez de mostrar um numero sem base.
 */
export async function acuracidade() {
  const { rows } = await query(`
    SELECT pl.id, pl.numero, pl.data_planejamento, pl.horizonte_dias,
           count(n.*)::int                                        AS necessidades,
           coalesce(sum(n.quantidade_sugerida), 0)                AS quantidade_planejada,
           coalesce(sum(n.quantidade_aprovada), 0)                AS quantidade_aprovada,
           count(*) FILTER (WHERE n.status = 'AJUSTADA')::int      AS ajustes_manuais,
           count(*) FILTER (WHERE n.status = 'REJEITADA')::int     AS rejeitadas,
           coalesce(sum(
             CASE WHEN n.quantidade_aprovada IS NOT NULL
                  THEN abs(n.quantidade_aprovada - n.quantidade_sugerida) END), 0) AS desvio_absoluto
      FROM planejamentos_compra pl
      LEFT JOIN necessidades_compra n ON n.planejamento_id = pl.id
     GROUP BY pl.id ORDER BY pl.data_planejamento DESC LIMIT 12`);

  const comDecisao = rows.filter((r) => Number(r.quantidade_aprovada) > 0);
  if (comDecisao.length < 2) {
    return {
      dados_insuficientes: true,
      motivo: 'E preciso pelo menos dois planejamentos com necessidades decididas para medir acuracidade',
      planejamentos: rows,
    };
  }

  const planejada = comDecisao.reduce((a, r) => a + Number(r.quantidade_planejada), 0);
  const desvio = comDecisao.reduce((a, r) => a + Number(r.desvio_absoluto), 0);

  return {
    dados_insuficientes: false,
    planejamentos_avaliados: comDecisao.length,
    quantidade_planejada: planejada,
    desvio_absoluto: desvio,
    acuracidade_percentual: planejada > 0 ? Math.max(0, 100 - (desvio / planejada) * 100) : null,
    planejamentos: rows,
  };
}

// ---------------------------------------------------------------------------
// Alcadas
// ---------------------------------------------------------------------------

export async function listarAlcadas() {
  const { rows } = await query(`
    SELECT a.*, p.nome AS perfil
      FROM alcadas_aprovacao a JOIN perfis p ON p.id = a.perfil_id
     ORDER BY a.ordem, a.valor_minimo`);
  return rows;
}

/** Qual perfil precisa aprovar um valor. Nunca fixo no codigo (secao 57). */
export async function alcadaPara(valor: number) {
  const { rows } = await query<{ nome: string; perfil: string; perfil_id: number }>(`
    SELECT a.nome, p.nome AS perfil, a.perfil_id
      FROM alcadas_aprovacao a JOIN perfis p ON p.id = a.perfil_id
     WHERE a.ativo AND $1::numeric >= a.valor_minimo
       AND (a.valor_maximo IS NULL OR $1::numeric <= a.valor_maximo)
     ORDER BY a.ordem LIMIT 1`, [valor]);
  return rows[0] ?? null;
}

export async function historicoPlanejamento(id: number) {
  const { rows } = await query(`
    SELECT pl.*, u.nome AS usuario FROM planejamentos_compra pl
      LEFT JOIN usuarios u ON u.id = pl.usuario_id WHERE pl.id = $1`, [id]);
  if (!rows.length) throw naoEncontrado('Planejamento');

  const decisoes = await query(`
    SELECT h.*, p.codigo, p.descricao, u.nome AS usuario
      FROM necessidade_historico h
      JOIN necessidades_compra n ON n.id = h.necessidade_id
      JOIN produtos p ON p.id = n.produto_id
      LEFT JOIN usuarios u ON u.id = h.usuario_id
     WHERE n.planejamento_id = $1
     ORDER BY h.created_at DESC LIMIT 500`, [id]);

  return { planejamento: rows[0], decisoes: decisoes.rows };
}

export async function compararPlanejamentos(atualId: number, anteriorId: number) {
  const { rows } = await query(`
    WITH atual AS (
      SELECT produto_id, quantidade_sugerida, valor_estimado, prioridade
        FROM necessidades_compra WHERE planejamento_id = $1
    ),
    anterior AS (
      SELECT produto_id, quantidade_sugerida, valor_estimado, prioridade
        FROM necessidades_compra WHERE planejamento_id = $2
    )
    SELECT coalesce(a.produto_id, b.produto_id) AS produto_id,
           p.codigo, p.descricao,
           coalesce(a.quantidade_sugerida, 0) AS quantidade_atual,
           coalesce(b.quantidade_sugerida, 0) AS quantidade_anterior,
           coalesce(a.quantidade_sugerida, 0) - coalesce(b.quantidade_sugerida, 0) AS diferenca,
           a.prioridade AS prioridade_atual, b.prioridade AS prioridade_anterior
      FROM atual a
      FULL OUTER JOIN anterior b ON b.produto_id = a.produto_id
      JOIN produtos p ON p.id = coalesce(a.produto_id, b.produto_id)
     ORDER BY abs(coalesce(a.quantidade_sugerida, 0) - coalesce(b.quantidade_sugerida, 0)) DESC
     LIMIT 300`, [atualId, anteriorId]);
  return rows;
}

export async function listarParametros() {
  const { rows } = await query(
    "SELECT chave, valor, tipo, descricao FROM configuracoes WHERE grupo = 'planejamento' ORDER BY chave");
  return rows;
}
