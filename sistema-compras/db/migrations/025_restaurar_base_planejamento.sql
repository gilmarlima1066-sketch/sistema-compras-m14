-- ===========================================================================
-- MODULO 09 - Correcao: restaura vw_base_planejamento
--
-- A migration 024 precisou derrubar a view para poder redefinir a coluna
-- gerada quantidade_disponivel, e a recriou a partir de uma versao reduzida.
-- Com isso o modulo 05 perdeu colunas que usa: demanda_diaria_90d,
-- demanda_365d, ultima_venda e o bloco inteiro da ultima previsao.
--
-- Esta migration devolve a definicao original da migration 011, acrescentando
-- apenas o que o modulo 09 realmente precisava: quarentena e bloqueio como
-- quantidades proprias, fora do disponivel.
-- ===========================================================================

DROP VIEW IF EXISTS vw_base_planejamento;

CREATE VIEW vw_base_planejamento AS
WITH ultima_previsao AS (
  SELECT DISTINCT ON (produto_id)
         produto_id, demanda_prevista, demanda_diaria, periodo_inicio, periodo_fim,
         metodo, confiabilidade, tendencia, sazonal, created_at
  FROM previsoes_demanda
  ORDER BY produto_id, periodo_inicio DESC, versao DESC
),
saldo AS (
  SELECT produto_id,
         sum(quantidade_fisica)      AS estoque_fisico,
         sum(quantidade_reservada)   AS estoque_reservado,
         sum(quantidade_disponivel)  AS estoque_disponivel,
         sum(quantidade_em_transito) AS estoque_em_transito,
         sum(quantidade_quarentena)  AS estoque_quarentena,
         sum(quantidade_bloqueada)   AS estoque_bloqueado,
         sum(quantidade_recebimento) AS estoque_em_recebimento
  FROM estoques
  GROUP BY produto_id
),
historico AS (
  SELECT produto_id,
         sum(quantidade) FILTER (WHERE data_venda >= CURRENT_DATE - 90)  AS qtd_90d,
         sum(quantidade) FILTER (WHERE data_venda >= CURRENT_DATE - 365) AS qtd_365d,
         max(data_venda) AS ultima_venda
  FROM mv_demanda_diaria
  GROUP BY produto_id
)
SELECT
  p.id                                    AS produto_id,
  p.codigo,
  p.descricao,
  p.categoria_id,
  p.classificacao_abc,
  p.classificacao_xyz,
  p.peso,
  coalesce(s.estoque_fisico, 0)           AS estoque_fisico,
  coalesce(s.estoque_reservado, 0)        AS estoque_reservado,
  coalesce(s.estoque_disponivel, 0)       AS estoque_disponivel,
  coalesce(s.estoque_em_transito, 0)      AS estoque_em_transito,
  coalesce(s.estoque_quarentena, 0)       AS estoque_quarentena,
  coalesce(s.estoque_bloqueado, 0)        AS estoque_bloqueado,
  coalesce(s.estoque_em_recebimento, 0)   AS estoque_em_recebimento,
  coalesce(h.qtd_90d, 0) / 90.0           AS demanda_diaria_90d,
  coalesce(h.qtd_365d, 0)                 AS demanda_365d,
  h.ultima_venda,
  up.demanda_prevista,
  up.demanda_diaria                       AS demanda_diaria_prevista,
  up.periodo_inicio                       AS previsao_periodo_inicio,
  up.periodo_fim                          AS previsao_periodo_fim,
  up.metodo                               AS previsao_metodo,
  up.confiabilidade                       AS previsao_confiabilidade,
  up.tendencia,
  up.sazonal,
  up.created_at                           AS previsao_calculada_em,
  pe.lead_time_dias,
  pe.estoque_seguranca,
  pe.ponto_pedido,
  pe.estoque_minimo,
  pe.estoque_maximo,
  pe.moq                                  AS moq_parametro,
  pe.multiplo_compra                      AS multiplo_parametro,
  pe.horizonte_planejamento_dias,
  p.moq                                   AS moq_produto,
  p.multiplo_compra                       AS multiplo_produto,
  p.lead_time_padrao_dias
FROM produtos p
LEFT JOIN saldo s            ON s.produto_id = p.id
LEFT JOIN historico h        ON h.produto_id = p.id
LEFT JOIN ultima_previsao up ON up.produto_id = p.id
LEFT JOIN parametros_estoque pe ON pe.produto_id = p.id
WHERE p.deleted_at IS NULL;

COMMENT ON VIEW vw_base_planejamento IS
  'Base do modulo 05: estoque, demanda historica, previsao e parametros em uma linha por produto. Quarentena, bloqueio e area de recebimento saem separados do disponivel (PROMPT 09, secoes 20 e 33)';
