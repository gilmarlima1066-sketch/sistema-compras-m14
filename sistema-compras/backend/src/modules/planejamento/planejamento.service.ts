import { query, comTransacao, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import { SQL_CALCULO, valoresCalculo, type ParametrosCalculo } from './calculo.sql.js';
import type {
  ExecutarPlanejamento, FiltroNecessidades, Simular,
} from './planejamento.schemas.js';
import type { z } from 'zod';
import type { recalcularParametrosSchema, ajustarNecessidadeSchema } from './planejamento.schemas.js';

// ---------------------------------------------------------------------------
// Parametros do modulo
// ---------------------------------------------------------------------------

export interface ConfigPlanejamento {
  horizonteDias: number;
  estrategiaPadrao: string;
  diasSeguranca: number;
  coberturaAlvoDias: number;
  leadTimePadrao: number;
  diasRecebimento: number;
  usarDiasUteis: boolean;
  limiteExcessoCobertura: number;
  somarSegurancaAoAlvo: boolean;
  considerarTransferencia: boolean;
  bloquearComExcesso: boolean;
  diasAtrasoAlerta: number;
  pesoRuptura: number;
  pesoCobertura: number;
  pesoAbc: number;
  pesoLeadTime: number;
  nivelServicoPadrao: number;
}

export async function carregarConfig(): Promise<ConfigPlanejamento> {
  const { rows } = await query<{ chave: string; valor: string }>(
    "SELECT chave, valor FROM configuracoes WHERE grupo = 'planejamento' OR chave = 'compras.nivel_servico_padrao'",
  );
  const m = new Map(rows.map((r) => [r.chave, r.valor]));
  const num = (k: string, padrao: number) => {
    const v = Number(m.get(k));
    return Number.isFinite(v) ? v : padrao;
  };
  const bool = (k: string, padrao: boolean) => {
    const v = m.get(k);
    return v === undefined ? padrao : v === 'true';
  };

  return {
    horizonteDias: num('planejamento.horizonte_padrao_dias', 30),
    estrategiaPadrao: m.get('planejamento.estrategia_padrao') ?? 'PONTO_PEDIDO',
    diasSeguranca: num('planejamento.dias_seguranca_padrao', 7),
    coberturaAlvoDias: num('planejamento.cobertura_alvo_dias', 45),
    leadTimePadrao: num('planejamento.lead_time_padrao_dias', 15),
    diasRecebimento: num('planejamento.dias_recebimento', 2),
    usarDiasUteis: bool('planejamento.usar_dias_uteis', false),
    limiteExcessoCobertura: num('planejamento.limite_excesso_cobertura', 120),
    somarSegurancaAoAlvo: bool('planejamento.somar_seguranca_ao_alvo', false),
    considerarTransferencia: bool('planejamento.considerar_transferencia', true),
    bloquearComExcesso: bool('planejamento.bloquear_compra_com_excesso', true),
    diasAtrasoAlerta: num('planejamento.dias_atraso_alerta', 3),
    pesoRuptura: num('planejamento.peso_ruptura', 40),
    pesoCobertura: num('planejamento.peso_cobertura', 25),
    pesoAbc: num('planejamento.peso_abc', 20),
    pesoLeadTime: num('planejamento.peso_lead_time', 15),
    nivelServicoPadrao: num('compras.nivel_servico_padrao', 95),
  };
}

function parametrosCalculo(
  cfg: ConfigPlanejamento,
  extra: Partial<ParametrosCalculo> = {},
): ParametrosCalculo {
  return {
    horizonteDias: cfg.horizonteDias,
    estrategiaPadrao: cfg.estrategiaPadrao,
    diasSeguranca: cfg.diasSeguranca,
    coberturaAlvoDias: cfg.coberturaAlvoDias,
    leadTimePadrao: cfg.leadTimePadrao,
    diasRecebimento: cfg.diasRecebimento,
    usarDiasUteis: cfg.usarDiasUteis,
    limiteExcessoCobertura: cfg.limiteExcessoCobertura,
    somarSegurancaAoAlvo: cfg.somarSegurancaAoAlvo,
    fatorDemanda: 1,
    leadTimeExtra: 0,
    fatorSeguranca: 1,
    localId: null,
    categoriaId: null,
    produtoId: null,
    fornecedorId: null,
    diasAtrasoAlerta: cfg.diasAtrasoAlerta,
    pesoRuptura: cfg.pesoRuptura,
    pesoCobertura: cfg.pesoCobertura,
    pesoAbc: cfg.pesoAbc,
    pesoLeadTime: cfg.pesoLeadTime,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Parametros de estoque derivados da demanda (secoes 9 e 10)
// ---------------------------------------------------------------------------

/**
 * Deriva demanda media, desvio, estoque de seguranca e ponto de pedido a partir
 * do que o modulo 04 apurou. Sem isso o planejamento nao tem contra o que
 * comparar: o sistema nasceria com 2 mil produtos sem parametro nenhum.
 *
 * Estoque de seguranca estatistico:  z x desvio_demanda_diaria x sqrt(lead time)
 * Quando nao ha desvio (produto com pouco historico), cai para dias de cobertura.
 */
export async function recalcularParametros(
  entrada: z.output<typeof recalcularParametrosSchema>,
  contexto: ContextoSessao,
) {
  const cfg = await carregarConfig();
  const nivel = entrada.nivel_servico ?? cfg.nivelServicoPadrao;
  // z para os niveis de servico usuais; interpolar nao vale a complexidade aqui.
  const Z: Record<string, number> = { 90: 1.2816, 95: 1.6449, 97: 1.8808, 98: 2.0537, 99: 2.3263 };
  const z = Z[String(Math.round(nivel))] ?? 1.6449;

  const { rows } = await query<{ atualizados: number }>(`
    WITH referencia AS (SELECT max(data_venda) AS fim FROM mv_demanda_diaria),
    diaria AS (
      SELECT d.produto_id,
             avg(d.quantidade)          AS media,
             stddev_samp(d.quantidade)  AS desvio,
             count(*)                   AS dias_com_venda
        FROM mv_demanda_diaria d, referencia r
       WHERE d.data_venda > r.fim - $1::int
       GROUP BY d.produto_id
    ),
    total AS (
      SELECT d.produto_id, sum(d.quantidade) / $1::numeric AS diaria_corrida
        FROM mv_demanda_diaria d, referencia r
       WHERE d.data_venda > r.fim - $1::int
       GROUP BY d.produto_id
    ),
    forn AS (
      SELECT DISTINCT ON (pf.produto_id) pf.produto_id, pf.lead_time_dias, pf.moq, pf.multiplo_compra
        FROM produto_fornecedor pf
        JOIN fornecedores f ON f.id = pf.fornecedor_id
       WHERE pf.ativo AND f.ativo AND f.deleted_at IS NULL
       ORDER BY pf.produto_id, pf.fornecedor_principal DESC, pf.preco_atual ASC NULLS LAST
    ),
    calculado AS (
      SELECT p.id AS produto_id,
             -- Um produto pode fechar o periodo negativo (devolucao maior que
             -- venda). Para parametro de estoque isso significa "sem demanda".
             greatest(coalesce(t.diaria_corrida, 0), 0)             AS demanda_media_diaria,
             greatest(coalesce(d.desvio, 0), 0)                     AS desvio_demanda,
             coalesce(nullif(f.lead_time_dias, 0), nullif(p.lead_time_padrao_dias, 0), $2::int) AS lead_time,
             f.moq, f.multiplo_compra
        FROM produtos p
        LEFT JOIN diaria d ON d.produto_id = p.id
        LEFT JOIN total t  ON t.produto_id = p.id
        LEFT JOIN forn f   ON f.produto_id = p.id
       WHERE p.deleted_at IS NULL AND p.ativo
         AND ($5::bigint IS NULL OR p.id = $5::bigint)
         AND ($6::bigint IS NULL OR p.categoria_id = $6::bigint)
    ),
    derivado AS (
      SELECT c.*,
             CASE WHEN c.desvio_demanda > 0
                  THEN $3::numeric * c.desvio_demanda * sqrt(greatest(c.lead_time, 1))
                  ELSE c.demanda_media_diaria * $4::numeric END AS seguranca,
             c.demanda_media_diaria * c.lead_time AS demanda_lead_time
        FROM calculado c
    ),
    gravado AS (
      INSERT INTO parametros_estoque
        (produto_id, demanda_media_diaria, desvio_padrao_demanda, lead_time_dias,
         nivel_servico, estoque_seguranca, ponto_pedido, estoque_minimo, estoque_maximo,
         moq, multiplo_compra, horizonte_planejamento_dias, calculado_automaticamente,
         calculado_em, updated_by, metodo_estoque_seguranca, dias_seguranca)
      SELECT d.produto_id,
             round(d.demanda_media_diaria::numeric, 4),
             round(d.desvio_demanda::numeric, 4),
             d.lead_time,
             $7::numeric,
             round(d.seguranca::numeric, 3),
             round((d.demanda_lead_time + d.seguranca)::numeric, 3),
             round(d.seguranca::numeric, 3),
             round((d.demanda_lead_time + d.seguranca + d.demanda_media_diaria * $8::int)::numeric, 3),
             d.moq, d.multiplo_compra,
             $9::int, true, now(), $10::bigint,
             CASE WHEN d.desvio_demanda > 0 THEN 'ESTATISTICO' ELSE 'DIAS_COBERTURA' END,
             $4::int
        FROM derivado d
      ON CONFLICT (produto_id) DO UPDATE SET
             demanda_media_diaria = EXCLUDED.demanda_media_diaria,
             desvio_padrao_demanda = EXCLUDED.desvio_padrao_demanda,
             lead_time_dias = EXCLUDED.lead_time_dias,
             nivel_servico = EXCLUDED.nivel_servico,
             estoque_seguranca = EXCLUDED.estoque_seguranca,
             ponto_pedido = EXCLUDED.ponto_pedido,
             estoque_minimo = EXCLUDED.estoque_minimo,
             estoque_maximo = EXCLUDED.estoque_maximo,
             moq = coalesce(EXCLUDED.moq, parametros_estoque.moq),
             multiplo_compra = coalesce(EXCLUDED.multiplo_compra, parametros_estoque.multiplo_compra),
             calculado_automaticamente = true,
             calculado_em = now(),
             updated_by = EXCLUDED.updated_by,
             metodo_estoque_seguranca = EXCLUDED.metodo_estoque_seguranca,
             atualizado_em = now()
        WHERE $11::boolean OR parametros_estoque.calculado_automaticamente
      RETURNING produto_id
    )
    SELECT count(*)::int AS atualizados FROM gravado`,
    [entrada.dias_historico, cfg.leadTimePadrao, z, cfg.diasSeguranca,
      entrada.produto_id ?? null, entrada.categoria_id ?? null, nivel,
      cfg.coberturaAlvoDias, cfg.horizonteDias, contexto.usuarioId ?? null,
      entrada.sobrescrever_manual]);

  return {
    dias_historico: entrada.dias_historico,
    nivel_servico: nivel,
    z,
    metodo: 'z x desvio da demanda diaria x raiz(lead time); sem desvio, dias de cobertura',
    produtos_atualizados: rows[0]?.atualizados ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Execucao do planejamento
// ---------------------------------------------------------------------------

export async function executarPlanejamento(entrada: ExecutarPlanejamento, contexto: ContextoSessao) {
  const cfg = await carregarConfig();
  const horizonte = entrada.horizonte_dias ?? cfg.horizonteDias;
  const estrategia = entrada.estrategia ?? cfg.estrategiaPadrao;

  const parametros = parametrosCalculo(cfg, {
    horizonteDias: horizonte,
    estrategiaPadrao: estrategia,
    localId: entrada.local_id ?? null,
    categoriaId: entrada.categoria_id ?? null,
    produtoId: entrada.produto_id ?? null,
    fornecedorId: entrada.fornecedor_id ?? null,
  });

  const { rows: numero } = await query<{ numero: string }>(
    `SELECT 'PLN-' || to_char(now(), 'YYYYMMDD') || '-' ||
            lpad((count(*) + 1)::text, 3, '0') AS numero
       FROM planejamentos_compra WHERE data_planejamento = CURRENT_DATE`);

  const { rows: plano } = await query<{ id: number; numero: string }>(`
    INSERT INTO planejamentos_compra
      (numero, horizonte_dias, estrategia_padrao, local_id, parametros, observacao, usuario_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, numero`,
    [numero[0]!.numero, horizonte, estrategia, entrada.local_id ?? null,
      JSON.stringify({ ...cfg, ...entrada, horizonte_dias: horizonte, estrategia }),
      entrada.observacao ?? null, contexto.usuarioId ?? null]);

  const planejamentoId = plano[0]!.id;

  try {
    const { rows: resumo } = await query<{
      gravadas: number; sem_necessidade: number; analisados: number; valor: number;
    }>(`
      WITH calculo AS (${SQL_CALCULO}),
      gravar AS (
        INSERT INTO necessidades_compra (
          planejamento_id, produto_id, fornecedor_id, local_id, data_geracao,
          prioridade, estrategia, horizonte_dias, status,
          estoque_atual, estoque_disponivel, estoque_em_transito, compra_em_aberto,
          demanda_prevista, demanda_periodo, demanda_diaria, demanda_lead_time, origem_demanda,
          entradas_confirmadas, estoque_seguranca, estoque_alvo, ponto_pedido, estoque_maximo,
          necessidade_bruta, necessidade_calculada, moq, multiplo_compra,
          quantidade_sistema, quantidade_sugerida,
          unidade_compra_id, fator_conversao, quantidade_unidade_compra,
          lead_time_dias, lead_time_total_dias,
          data_necessaria, data_ideal_compra, data_prevista_chegada, dias_cobertura,
          preco_estimado, valor_estimado, frete_estimado, custo_total_estimado,
          pedido_atrasado, excesso, transferencia_possivel, transferencia_local_id,
          previsao_confiabilidade, indice_prioridade, fatores_prioridade,
          memoria_calculo, alertas, usuario_id
        )
        SELECT
          $22::bigint, c.produto_id, c.fornecedor_id, $13::bigint, CURRENT_DATE,
          c.prioridade, c.estrategia, c.horizonte, 'PENDENTE',
          c.estoque_fisico, c.estoque_disponivel, c.estoque_transito, c.compra_em_aberto,
          round(c.demanda_periodo::numeric, 3), round(c.demanda_periodo::numeric, 3),
          round(c.demanda_diaria::numeric, 4), round(c.demanda_lead_time::numeric, 3), c.origem_demanda,
          round(c.compra_em_aberto::numeric, 3), round(c.estoque_seguranca::numeric, 3),
          round(c.estoque_alvo::numeric, 3), round(c.ponto_pedido::numeric, 3), c.estoque_maximo,
          round(c.necessidade_bruta::numeric, 3), round(c.necessidade_calculada::numeric, 3),
          c.moq, c.multiplo,
          round(c.quantidade_sugerida::numeric, 3), round(c.quantidade_sugerida::numeric, 3),
          c.unidade_compra_id, c.fator_conversao,
          round((c.quantidade_sugerida / c.fator_conversao)::numeric, 3),
          c.lead_time_dias, c.lead_time_total,
          c.data_necessaria, c.data_ideal_compra, c.data_prevista_chegada,
          round(c.dias_cobertura::numeric, 2),
          c.preco_atual,
          round((c.quantidade_sugerida * coalesce(c.preco_atual, 0))::numeric, 2),
          c.frete_estimado,
          round((c.quantidade_sugerida * coalesce(c.preco_atual, 0) + coalesce(c.frete_estimado, 0))::numeric, 2),
          c.pedido_atrasado, round(c.excesso::numeric, 3),
          round(c.transferencia_possivel::numeric, 3), c.transferencia_local_id,
          c.previsao_confiabilidade, c.indice_prioridade, c.fatores_prioridade,
          c.memoria_calculo, c.alertas, $23::bigint
        FROM calculo c
        WHERE c.quantidade_sugerida > 0
        RETURNING valor_estimado
      )
      SELECT
        (SELECT count(*)::int FROM gravar)                                        AS gravadas,
        (SELECT coalesce(sum(valor_estimado), 0) FROM gravar)                     AS valor,
        (SELECT count(*)::int FROM calculo WHERE quantidade_sugerida <= 0)        AS sem_necessidade,
        (SELECT count(*)::int FROM calculo)                                       AS analisados`,
      [...valoresCalculo(parametros), planejamentoId, contexto.usuarioId ?? null]);

    const r = resumo[0]!;
    await query(`
      UPDATE planejamentos_compra
         SET status = 'CALCULADO', produtos_analisados = $2, necessidades_geradas = $3,
             produtos_sem_necessidade = $4, valor_total_estimado = $5
       WHERE id = $1`,
      [planejamentoId, r.analisados, r.gravadas, r.sem_necessidade, r.valor]);

    return {
      planejamento_id: planejamentoId,
      numero: plano[0]!.numero,
      horizonte_dias: horizonte,
      estrategia_padrao: estrategia,
      produtos_analisados: Number(r.analisados),
      necessidades_geradas: Number(r.gravadas),
      produtos_sem_necessidade: Number(r.sem_necessidade),
      valor_total_estimado: Number(r.valor),
    };
  } catch (erro) {
    await query(
      `UPDATE planejamentos_compra SET status = 'FALHOU', erro_mensagem = $2 WHERE id = $1`,
      [planejamentoId, erro instanceof Error ? erro.message : 'erro desconhecido']);
    throw erro;
  }
}

export async function listarPlanejamentos(filtro: Paginacao) {
  const total = await query<{ total: number }>('SELECT count(*)::int AS total FROM planejamentos_compra');
  const { rows } = await query(`
    SELECT pl.*, u.nome AS usuario, l.nome AS local
      FROM planejamentos_compra pl
      LEFT JOIN usuarios u ON u.id = pl.usuario_id
      LEFT JOIN locais l   ON l.id = pl.local_id
     ORDER BY pl.created_at DESC
     LIMIT $1 OFFSET $2`, [filtro.limite, deslocamento(filtro)]);
  return { dados: rows, meta: metaPaginacao(total.rows[0]?.total ?? 0, filtro) };
}

/** O planejamento vigente e o ultimo calculado com sucesso. */
export async function planejamentoVigente(): Promise<number | null> {
  const { rows } = await query<{ id: number }>(
    "SELECT id FROM planejamentos_compra WHERE status IN ('CALCULADO','EM_ANALISE','APROVADO') ORDER BY created_at DESC LIMIT 1");
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Consulta de necessidades
// ---------------------------------------------------------------------------

const ORDENAVEIS: Record<string, string> = {
  prioridade: 'n.indice_prioridade',
  valor: 'n.valor_estimado',
  quantidade: 'n.quantidade_sugerida',
  data_ideal: 'n.data_ideal_compra',
  cobertura: 'n.dias_cobertura',
  produto: 'p.descricao',
};

async function condicoesNecessidade(filtro: FiltroNecessidades) {
  const valores: unknown[] = [];
  const cond: string[] = ['p.deleted_at IS NULL'];
  const add = (sql: string, valor: unknown) => {
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  const planejamentoId = filtro.planejamento_id ?? await planejamentoVigente();
  if (planejamentoId) add('n.planejamento_id = $?', planejamentoId);
  if (filtro.produto_id) add('n.produto_id = $?', filtro.produto_id);
  if (filtro.categoria_id) add('p.categoria_id = $?', filtro.categoria_id);
  if (filtro.fornecedor_id) add('n.fornecedor_id = $?', filtro.fornecedor_id);
  if (filtro.local_id) add('n.local_id = $?', filtro.local_id);
  if (filtro.prioridade) add('n.prioridade = $?', filtro.prioridade);
  if (filtro.status) add('n.status = $?', filtro.status);
  if (filtro.classificacao_abc) add('p.classificacao_abc = $?', filtro.classificacao_abc);
  if (filtro.classificacao_xyz) add('p.classificacao_xyz = $?', filtro.classificacao_xyz);
  if (filtro.origem_fornecedor) add('f.origem_fornecedor = $?', filtro.origem_fornecedor);
  if (filtro.apenas_com_necessidade) cond.push('n.quantidade_sugerida > 0');
  if (filtro.apenas_atrasados) cond.push('n.pedido_atrasado');
  if (filtro.apenas_ruptura) cond.push("n.prioridade = 'RUPTURA'");
  if (filtro.apenas_excesso) cond.push('n.excesso IS NOT NULL');
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(p.descricao ILIKE $${valores.length} OR p.codigo ILIKE $${valores.length})`);
  }

  return { onde: `WHERE ${cond.join(' AND ')}`, valores, planejamentoId };
}

const DE_NECESSIDADE = `
  FROM necessidades_compra n
  JOIN produtos p        ON p.id = n.produto_id
  JOIN categorias cat    ON cat.id = p.categoria_id
  LEFT JOIN fornecedores f ON f.id = n.fornecedor_id
  LEFT JOIN unidades u   ON u.id = n.unidade_compra_id
  LEFT JOIN locais lt    ON lt.id = n.transferencia_local_id`;

export async function listarNecessidades(filtro: FiltroNecessidades) {
  const { onde, valores, planejamentoId } = await condicoesNecessidade(filtro);
  if (!planejamentoId) {
    return { dados: [], meta: { total: 0, pagina: 1, limite: filtro.limite, paginas: 1, planejamento_id: null } };
  }

  const ordem = ORDENAVEIS[filtro.ordenar_por ?? ''] ?? 'n.indice_prioridade';
  const direcao = filtro.ordem === 'asc' ? 'ASC' : 'DESC';

  const total = await query<{ total: number }>(
    `SELECT count(*)::int AS total ${DE_NECESSIDADE} ${onde}`, valores);

  const { rows } = await query(`
    SELECT n.id, n.produto_id, p.codigo, p.descricao, cat.nome AS categoria,
           p.classificacao_abc, p.classificacao_xyz, p.peso,
           n.prioridade, n.indice_prioridade, n.status, n.estrategia, n.origem_demanda,
           n.estoque_disponivel, n.estoque_em_transito, n.compra_em_aberto,
           n.demanda_diaria, n.demanda_periodo, n.demanda_lead_time,
           n.estoque_seguranca, n.estoque_alvo, n.ponto_pedido,
           n.necessidade_bruta, n.necessidade_calculada,
           n.moq, n.multiplo_compra, n.quantidade_sistema, n.quantidade_sugerida,
           n.quantidade_aprovada, n.quantidade_unidade_compra, u.codigo AS unidade_compra,
           n.lead_time_dias, n.lead_time_total_dias, n.dias_cobertura,
           n.data_necessaria, n.data_ideal_compra, n.data_prevista_chegada,
           n.preco_estimado, n.valor_estimado, n.custo_total_estimado,
           n.pedido_atrasado, n.excesso, n.transferencia_possivel, lt.nome AS transferencia_local,
           n.previsao_confiabilidade, n.alertas, n.justificativa,
           n.fornecedor_id, f.razao_social AS fornecedor, f.origem_fornecedor
      ${DE_NECESSIDADE} ${onde}
     ORDER BY ${ordem} ${direcao} NULLS LAST, p.descricao
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return {
    dados: rows,
    meta: { ...metaPaginacao(total.rows[0]?.total ?? 0, filtro), planejamento_id: planejamentoId },
  };
}

export async function detalharNecessidade(id: number) {
  const { rows } = await query(`
    SELECT n.*, p.codigo, p.descricao, cat.nome AS categoria,
           p.classificacao_abc, p.classificacao_xyz,
           f.razao_social AS fornecedor, f.origem_fornecedor,
           f.transit_time_dias, f.desembaraco_dias, f.incoterm,
           u.codigo AS unidade_compra, lt.nome AS transferencia_local,
           pl.numero AS planejamento_numero, pl.data_planejamento
      ${DE_NECESSIDADE}
      LEFT JOIN planejamentos_compra pl ON pl.id = n.planejamento_id
     WHERE n.id = $1`, [id]);
  if (!rows.length) throw naoEncontrado('Necessidade de compra');

  const historico = await query(`
    SELECT h.*, u.nome AS usuario
      FROM necessidade_historico h
      LEFT JOIN usuarios u ON u.id = h.usuario_id
     WHERE h.necessidade_id = $1 ORDER BY h.created_at DESC`, [id]);

  return { ...rows[0], historico: historico.rows };
}

// ---------------------------------------------------------------------------
// Decisoes sobre a necessidade
// ---------------------------------------------------------------------------

const TRANSICOES: Record<string, string[]> = {
  PENDENTE: ['EM_ANALISE', 'APROVADA', 'REJEITADA', 'AJUSTADA', 'CANCELADA'],
  EM_ANALISE: ['APROVADA', 'REJEITADA', 'AJUSTADA', 'CANCELADA'],
  AJUSTADA: ['APROVADA', 'REJEITADA', 'CANCELADA'],
  APROVADA: ['CONVERTIDA_COTACAO', 'CANCELADA', 'AJUSTADA'],
  CONVERTIDA_COTACAO: ['ATENDIDA', 'CANCELADA'],
  REJEITADA: [],
  ATENDIDA: [],
  CANCELADA: [],
};

async function mudarStatus(
  cliente: { query: (t: string, v?: unknown[]) => Promise<{ rows: any[] }> },
  id: number,
  novo: string,
  dados: {
    quantidade?: number | null; fornecedorId?: number | null;
    justificativa?: string | null; usuarioId?: number | null;
  },
) {
  const { rows: atual } = await cliente.query(
    'SELECT * FROM necessidades_compra WHERE id = $1 FOR UPDATE', [id]);
  if (!atual.length) throw naoEncontrado('Necessidade de compra');
  const n = atual[0];

  const permitidas = TRANSICOES[n.status] ?? [];
  if (!permitidas.includes(novo)) {
    throw regraNegocio(
      `Necessidade em ${n.status} nao pode ir para ${novo}. Transicoes possiveis - ${permitidas.join(', ') || 'nenhuma'}`,
    );
  }

  const quantidade = dados.quantidade ?? n.quantidade_aprovada ?? n.quantidade_sugerida;
  const fornecedor = dados.fornecedorId ?? n.fornecedor_id;

  // Os casts sao obrigatorios: $2 aparece como enum na atribuicao e como texto
  // na comparacao, e sem eles o Postgres recusa a consulta por tipo ambiguo.
  const { rows } = await cliente.query(`
    UPDATE necessidades_compra
       SET status = $2::status_necessidade_enum,
           quantidade_aprovada = $3::numeric,
           fornecedor_id = $4::bigint,
           justificativa = coalesce($5::text, justificativa),
           aprovado_por = CASE WHEN $2::text IN ('APROVADA','REJEITADA') THEN $6::bigint ELSE aprovado_por END,
           aprovado_em  = CASE WHEN $2::text IN ('APROVADA','REJEITADA') THEN now() ELSE aprovado_em END,
           updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, novo, quantidade, fornecedor, dados.justificativa ?? null, dados.usuarioId ?? null]);

  await cliente.query(`
    INSERT INTO necessidade_historico
      (necessidade_id, status_anterior, status_novo, quantidade_anterior, quantidade_nova,
       fornecedor_anterior, fornecedor_novo, justificativa, usuario_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, n.status, novo, n.quantidade_aprovada ?? n.quantidade_sugerida, quantidade,
      n.fornecedor_id, fornecedor, dados.justificativa ?? null, dados.usuarioId ?? null]);

  return rows[0];
}

export async function aprovarNecessidade(id: number, justificativa: string | undefined, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT excesso, quantidade_sugerida FROM necessidades_compra WHERE id = $1', [id]);
    if (!rows.length) throw naoEncontrado('Necessidade de compra');

    const cfg = await carregarConfig();
    // Secao 27: nao aprovar compra de item em excesso sem uma razao escrita.
    if (cfg.bloquearComExcesso && rows[0].excesso !== null && !justificativa) {
      throw regraNegocio('Produto com excesso de estoque. Informe a justificativa para aprovar mesmo assim');
    }
    return mudarStatus(cliente, id, 'APROVADA', {
      justificativa: justificativa ?? null, usuarioId: contexto.usuarioId ?? null,
    });
  });
}

export async function rejeitarNecessidade(id: number, justificativa: string | undefined, contexto: ContextoSessao) {
  if (!justificativa) throw regraNegocio('Rejeicao exige justificativa');
  return comTransacao(contexto, async (cliente) =>
    mudarStatus(cliente, id, 'REJEITADA', { justificativa, usuarioId: contexto.usuarioId ?? null }));
}

export async function ajustarNecessidade(
  id: number,
  entrada: z.output<typeof ajustarNecessidadeSchema>,
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const ajustada = await mudarStatus(cliente, id, 'AJUSTADA', {
      quantidade: entrada.quantidade_aprovada ?? null,
      fornecedorId: entrada.fornecedor_id ?? null,
      justificativa: entrada.justificativa,
      usuarioId: contexto.usuarioId ?? null,
    });

    if (entrada.data_necessaria || entrada.prioridade) {
      const { rows } = await cliente.query(`
        UPDATE necessidades_compra
           SET data_necessaria = coalesce($2::date, data_necessaria),
               prioridade = coalesce($3::prioridade_compra_enum, prioridade)
         WHERE id = $1 RETURNING *`,
        [id, entrada.data_necessaria ?? null, entrada.prioridade ?? null]);
      return rows[0];
    }
    return ajustada;
  });
}

export async function analisarNecessidade(id: number, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) =>
    mudarStatus(cliente, id, 'EM_ANALISE', { usuarioId: contexto.usuarioId ?? null }));
}

export async function cancelarNecessidade(id: number, justificativa: string | undefined, contexto: ContextoSessao) {
  if (!justificativa) throw regraNegocio('Cancelamento exige justificativa');
  return comTransacao(contexto, async (cliente) =>
    mudarStatus(cliente, id, 'CANCELADA', { justificativa, usuarioId: contexto.usuarioId ?? null }));
}
