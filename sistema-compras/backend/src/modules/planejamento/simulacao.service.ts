import { query, comTransacao, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import { SQL_CALCULO, valoresCalculo } from './calculo.sql.js';
import { carregarConfig, planejamentoVigente } from './planejamento.service.js';
import type { Simular } from './planejamento.schemas.js';

/**
 * Cenarios pre-definidos (secao 32). Sao pontos de partida: o usuario pode
 * ajustar qualquer fator depois.
 */
const CENARIOS: Record<string, Partial<Simular>> = {
  BASE: { variacao_demanda_percentual: 0, lead_time_extra_dias: 0, variacao_seguranca_percentual: 0 },
  CONSERVADOR: { variacao_demanda_percentual: 20, lead_time_extra_dias: 10, variacao_seguranca_percentual: 30 },
  REDUZIDO: { variacao_demanda_percentual: -15, lead_time_extra_dias: 0, variacao_seguranca_percentual: -20 },
};

/**
 * A simulacao roda o MESMO SQL do planejamento oficial, so com os fatores
 * trocados, e grava em tabela propria. O planejamento oficial nao e tocado
 * (secao 31).
 */
export async function simular(entrada: Simular, contexto: ContextoSessao) {
  const cfg = await carregarConfig();
  const preset = CENARIOS[entrada.tipo_cenario] ?? {};
  const ajustes = { ...preset, ...entrada };

  const horizonte = ajustes.horizonte_dias ?? cfg.horizonteDias;
  const fatorDemanda = 1 + (ajustes.variacao_demanda_percentual ?? 0) / 100;
  const fatorSeguranca = 1 + (ajustes.variacao_seguranca_percentual ?? 0) / 100;

  const parametros = valoresCalculo({
    horizonteDias: horizonte,
    estrategiaPadrao: ajustes.estrategia ?? cfg.estrategiaPadrao,
    diasSeguranca: cfg.diasSeguranca,
    coberturaAlvoDias: ajustes.cobertura_alvo_dias ?? cfg.coberturaAlvoDias,
    leadTimePadrao: cfg.leadTimePadrao,
    diasRecebimento: cfg.diasRecebimento,
    usarDiasUteis: cfg.usarDiasUteis,
    limiteExcessoCobertura: cfg.limiteExcessoCobertura,
    somarSegurancaAoAlvo: cfg.somarSegurancaAoAlvo,
    fatorDemanda,
    leadTimeExtra: ajustes.lead_time_extra_dias ?? 0,
    fatorSeguranca,
    localId: ajustes.local_id ?? null,
    categoriaId: ajustes.categoria_id ?? null,
    produtoId: null,
    fornecedorId: ajustes.fornecedor_id ?? null,
    diasAtrasoAlerta: cfg.diasAtrasoAlerta,
    pesoRuptura: cfg.pesoRuptura,
    pesoCobertura: cfg.pesoCobertura,
    pesoAbc: cfg.pesoAbc,
    pesoLeadTime: cfg.pesoLeadTime,
  });

  const base = await planejamentoVigente();

  return comTransacao(contexto, async (cliente) => {
    const { rows: criada } = await cliente.query(`
      INSERT INTO simulacoes_compra
        (nome, tipo_cenario, planejamento_base_id, ajustes, horizonte_dias, usuario_id)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [entrada.nome, entrada.tipo_cenario, base,
        JSON.stringify({
          horizonte_dias: horizonte,
          variacao_demanda_percentual: ajustes.variacao_demanda_percentual ?? 0,
          lead_time_extra_dias: ajustes.lead_time_extra_dias ?? 0,
          variacao_seguranca_percentual: ajustes.variacao_seguranca_percentual ?? 0,
          cobertura_alvo_dias: ajustes.cobertura_alvo_dias ?? cfg.coberturaAlvoDias,
          estrategia: ajustes.estrategia ?? cfg.estrategiaPadrao,
        }),
        horizonte, contexto.usuarioId ?? null]);

    const simulacaoId = criada[0]!.id;

    const { rows: resumo } = await cliente.query(`
      WITH calculo AS (${SQL_CALCULO}),
      gravar AS (
        INSERT INTO simulacao_compra_itens
          (simulacao_id, produto_id, fornecedor_id, demanda_periodo, estoque_disponivel,
           necessidade_calculada, quantidade_sugerida, valor_estimado, prioridade, dias_cobertura)
        SELECT $22::bigint, c.produto_id, c.fornecedor_id,
               round(c.demanda_periodo::numeric, 3), round(c.estoque_disponivel::numeric, 3),
               round(c.necessidade_calculada::numeric, 3), round(c.quantidade_sugerida::numeric, 3),
               round((c.quantidade_sugerida * coalesce(c.preco_atual, 0))::numeric, 2),
               c.prioridade, round(c.dias_cobertura::numeric, 2)
          FROM calculo c
         WHERE c.quantidade_sugerida > 0
        RETURNING quantidade_sugerida, valor_estimado, prioridade
      )
      SELECT
        (SELECT count(*)::int FROM calculo)                                   AS analisados,
        (SELECT count(*)::int FROM gravar)                                     AS itens,
        (SELECT coalesce(sum(quantidade_sugerida), 0) FROM gravar)             AS quantidade,
        (SELECT coalesce(sum(valor_estimado), 0) FROM gravar)                  AS valor,
        (SELECT count(*)::int FROM gravar WHERE prioridade IN ('RUPTURA','CRITICA')) AS risco,
        (SELECT count(*)::int FROM calculo WHERE excesso IS NOT NULL)          AS excesso`,
      [...parametros, simulacaoId]);

    const r = resumo[0]!;
    const { rows: final } = await cliente.query(`
      UPDATE simulacoes_compra
         SET produtos_analisados = $2, itens_com_necessidade = $3,
             quantidade_total = $4, valor_total = $5,
             produtos_risco_ruptura = $6, produtos_excesso = $7
       WHERE id = $1 RETURNING *`,
      [simulacaoId, r.analisados, r.itens, r.quantidade, r.valor, r.risco, r.excesso]);

    return final[0];
  });
}

export async function listarSimulacoes(filtro: Paginacao) {
  const total = await query<{ total: number }>('SELECT count(*)::int AS total FROM simulacoes_compra');
  const { rows } = await query(`
    SELECT s.*, u.nome AS usuario, pl.numero AS planejamento_base
      FROM simulacoes_compra s
      LEFT JOIN usuarios u ON u.id = s.usuario_id
      LEFT JOIN planejamentos_compra pl ON pl.id = s.planejamento_base_id
     ORDER BY s.created_at DESC LIMIT $1 OFFSET $2`, [filtro.limite, deslocamento(filtro)]);
  return { dados: rows, meta: metaPaginacao(total.rows[0]?.total ?? 0, filtro) };
}

export async function detalharSimulacao(id: number, filtro: Paginacao) {
  const cabecalho = await query('SELECT * FROM simulacoes_compra WHERE id = $1', [id]);
  if (!cabecalho.rows.length) throw naoEncontrado('Simulacao');

  const total = await query<{ total: number }>(
    'SELECT count(*)::int AS total FROM simulacao_compra_itens WHERE simulacao_id = $1', [id]);
  const { rows } = await query(`
    SELECT i.*, p.codigo, p.descricao, f.razao_social AS fornecedor
      FROM simulacao_compra_itens i
      JOIN produtos p ON p.id = i.produto_id
      LEFT JOIN fornecedores f ON f.id = i.fornecedor_id
     WHERE i.simulacao_id = $1
     ORDER BY i.valor_estimado DESC NULLS LAST
     LIMIT $2 OFFSET $3`, [id, filtro.limite, deslocamento(filtro)]);

  return {
    simulacao: cabecalho.rows[0],
    itens: rows,
    meta: metaPaginacao(total.rows[0]?.total ?? 0, filtro),
  };
}

export async function compararSimulacoes(ids: number[]) {
  if (ids.length < 2) throw regraNegocio('Informe ao menos duas simulacoes para comparar');
  const { rows } = await query(`
    SELECT id, nome, tipo_cenario, horizonte_dias, ajustes,
           produtos_analisados, itens_com_necessidade, quantidade_total, valor_total,
           produtos_risco_ruptura, produtos_excesso, created_at
      FROM simulacoes_compra WHERE id = ANY($1) ORDER BY created_at`, [ids]);
  if (rows.length < 2) throw naoEncontrado('Simulacoes informadas');

  const referencia = rows[0]!;
  return {
    referencia: referencia.nome,
    cenarios: rows.map((r) => ({
      ...r,
      diferenca_valor: Number(r.valor_total) - Number(referencia.valor_total),
      diferenca_percentual: Number(referencia.valor_total) > 0
        ? ((Number(r.valor_total) - Number(referencia.valor_total)) / Number(referencia.valor_total)) * 100
        : null,
    })),
  };
}

export async function excluirSimulacao(id: number, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query('DELETE FROM simulacoes_compra WHERE id = $1 RETURNING id, nome', [id]);
    if (!rows.length) throw naoEncontrado('Simulacao');
    return rows[0];
  });
}
