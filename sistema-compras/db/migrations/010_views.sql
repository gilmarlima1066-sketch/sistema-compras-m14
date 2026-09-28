-- =============================================================================
-- 010_views.sql  |  Views de consulta para dashboard e proximos modulos
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- vw_estoque_atual  |  posicao consolidada por produto
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_estoque_atual AS
SELECT
  p.id                                            AS produto_id,
  p.codigo,
  p.descricao,
  c.nome                                          AS categoria,
  u.codigo                                        AS unidade,
  COALESCE(SUM(e.quantidade_fisica), 0)           AS estoque_fisico,
  COALESCE(SUM(e.quantidade_reservada), 0)        AS estoque_reservado,
  COALESCE(SUM(e.quantidade_disponivel), 0)       AS estoque_disponivel,
  COALESCE(SUM(e.quantidade_em_transito), 0)      AS estoque_em_transito,
  p.estoque_minimo,
  p.estoque_seguranca,
  p.ponto_pedido,
  pe.demanda_media_diaria,
  -- cobertura em dias: quanto tempo o disponivel sustenta a demanda media
  CASE WHEN COALESCE(pe.demanda_media_diaria, 0) > 0
       THEN ROUND(COALESCE(SUM(e.quantidade_disponivel), 0) / pe.demanda_media_diaria, 1)
  END                                             AS cobertura_dias,
  count(e.id) FILTER (WHERE e.quantidade_fisica <> 0) AS locais_com_saldo,
  max(e.updated_at)                               AS atualizado_em
FROM produtos p
JOIN categorias c          ON c.id = p.categoria_id
JOIN unidades u            ON u.id = p.unidade_estoque_id
LEFT JOIN estoques e       ON e.produto_id = p.id
LEFT JOIN parametros_estoque pe ON pe.produto_id = p.id
WHERE p.deleted_at IS NULL
GROUP BY p.id, p.codigo, p.descricao, c.nome, u.codigo,
         p.estoque_minimo, p.estoque_seguranca, p.ponto_pedido, pe.demanda_media_diaria;

-- -----------------------------------------------------------------------------
-- vw_produtos_criticos  |  base do painel de ruptura e do motor de compra
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_produtos_criticos AS
SELECT
  v.produto_id,
  v.codigo,
  v.descricao,
  v.categoria,
  v.estoque_disponivel,
  v.estoque_em_transito,
  v.demanda_media_diaria,
  v.cobertura_dias,
  COALESCE(pe.lead_time_dias, p.lead_time_padrao_dias) AS lead_time_dias,
  v.ponto_pedido,
  v.estoque_minimo,
  v.estoque_seguranca,
  CASE
    WHEN v.estoque_disponivel <= 0                                    THEN 'RUPTURA'
    WHEN v.estoque_disponivel < v.estoque_seguranca                   THEN 'ABAIXO_SEGURANCA'
    WHEN v.estoque_disponivel < v.estoque_minimo                      THEN 'ABAIXO_MINIMO'
    WHEN v.ponto_pedido > 0 AND v.estoque_disponivel <= v.ponto_pedido THEN 'PONTO_PEDIDO'
    WHEN p.estoque_maximo IS NOT NULL
         AND v.estoque_disponivel > p.estoque_maximo                  THEN 'EXCESSO'
    ELSE 'NORMAL'
  END AS situacao,
  p.classificacao_abc,
  p.classificacao_xyz
FROM vw_estoque_atual v
JOIN produtos p                 ON p.id = v.produto_id
LEFT JOIN parametros_estoque pe ON pe.produto_id = v.produto_id
WHERE p.ativo;

-- -----------------------------------------------------------------------------
-- vw_compras_abertas  |  carteira de compras em andamento
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_compras_abertas AS
SELECT
  oc.id                     AS ordem_compra_id,
  oc.numero                 AS ordem_compra,
  oc.status,
  f.id                      AS fornecedor_id,
  COALESCE(f.nome_fantasia, f.razao_social) AS fornecedor,
  p.id                      AS produto_id,
  p.codigo                  AS produto_codigo,
  p.descricao               AS produto,
  i.quantidade_pedida,
  i.quantidade_recebida,
  (i.quantidade_pedida - i.quantidade_recebida) AS quantidade_pendente,
  i.preco_unitario,
  i.valor_total,
  COALESCE(i.data_prevista_entrega, oc.data_prevista_entrega) AS data_prevista_entrega,
  CASE WHEN COALESCE(i.data_prevista_entrega, oc.data_prevista_entrega) < CURRENT_DATE
            AND i.quantidade_recebida < i.quantidade_pedida
       THEN CURRENT_DATE - COALESCE(i.data_prevista_entrega, oc.data_prevista_entrega)
       ELSE 0 END AS dias_atraso
FROM ordens_compra oc
JOIN ordem_compra_itens i ON i.ordem_compra_id = oc.id
JOIN fornecedores f       ON f.id = oc.fornecedor_id
JOIN produtos p           ON p.id = i.produto_id
WHERE oc.status IN ('AGUARDANDO_APROVACAO','APROVADA','ENVIADA','CONFIRMADA',
                    'EM_PRODUCAO','EM_TRANSITO','RECEBIMENTO_PARCIAL');

-- -----------------------------------------------------------------------------
-- vw_historico_precos  |  evolucao de custo com variacao entre compras
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_historico_precos AS
SELECT
  h.id,
  h.produto_id,
  p.codigo        AS produto_codigo,
  p.descricao     AS produto,
  h.fornecedor_id,
  COALESCE(f.nome_fantasia, f.razao_social) AS fornecedor,
  h.data,
  h.quantidade,
  h.preco_unitario,
  h.frete,
  h.impostos,
  h.outros_custos,
  COALESCE(h.custo_efetivo,
           h.preco_unitario + h.frete + h.impostos + h.outros_custos) AS custo_efetivo,
  h.moeda,
  LAG(h.preco_unitario) OVER w AS preco_anterior,
  ROUND(
    CASE WHEN LAG(h.preco_unitario) OVER w > 0
         THEN (h.preco_unitario - LAG(h.preco_unitario) OVER w)
              / LAG(h.preco_unitario) OVER w * 100 END, 2) AS variacao_percentual
FROM historico_precos h
JOIN produtos p     ON p.id = h.produto_id
JOIN fornecedores f ON f.id = h.fornecedor_id
WINDOW w AS (PARTITION BY h.produto_id, h.fornecedor_id ORDER BY h.data, h.id);

-- -----------------------------------------------------------------------------
-- vw_performance_fornecedores  |  insumos do scorecard (calculo no Modulo 13)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_performance_fornecedores AS
WITH entregas_agg AS (
  SELECT oc.fornecedor_id,
         count(*)                                               AS entregas_total,
         count(*) FILTER (WHERE e.status = 'ENTREGUE'
                            AND COALESCE(e.dias_atraso, 0) = 0
                            AND e.quantidade_entregue >= e.quantidade_prevista) AS entregas_otif,
         AVG(NULLIF(e.dias_atraso, NULL))                       AS media_dias_atraso
    FROM entregas e
    JOIN ordens_compra oc ON oc.id = e.ordem_compra_id
   GROUP BY oc.fornecedor_id
),
qualidade_agg AS (
  SELECT fornecedor_id,
         count(*)                                                    AS inspecoes_total,
         count(*) FILTER (WHERE resultado = 'APROVADO')               AS inspecoes_aprovadas,
         count(*) FILTER (WHERE resultado = 'REPROVADO')              AS inspecoes_reprovadas
    FROM inspecoes_qualidade
   WHERE fornecedor_id IS NOT NULL
   GROUP BY fornecedor_id
),
nc_agg AS (
  SELECT fornecedor_id, count(*) AS ocorrencias
    FROM nao_conformidades WHERE fornecedor_id IS NOT NULL GROUP BY fornecedor_id
),
compras_agg AS (
  SELECT fornecedor_id, count(*) AS ordens_total, SUM(valor_total) AS valor_comprado
    FROM ordens_compra
   WHERE status NOT IN ('RASCUNHO','CANCELADA')
   GROUP BY fornecedor_id
)
SELECT
  f.id AS fornecedor_id,
  COALESCE(f.nome_fantasia, f.razao_social) AS fornecedor,
  f.origem_fornecedor,
  f.ativo,
  COALESCE(c.ordens_total, 0)   AS ordens_total,
  COALESCE(c.valor_comprado, 0) AS valor_comprado,
  COALESCE(e.entregas_total, 0) AS entregas_total,
  CASE WHEN COALESCE(e.entregas_total, 0) > 0
       THEN ROUND(e.entregas_otif::NUMERIC / e.entregas_total * 100, 2) END AS otif_percentual,
  ROUND(e.media_dias_atraso, 1) AS media_dias_atraso,
  CASE WHEN COALESCE(q.inspecoes_total, 0) > 0
       THEN ROUND(q.inspecoes_aprovadas::NUMERIC / q.inspecoes_total * 100, 2) END AS qualidade_percentual,
  COALESCE(q.inspecoes_reprovadas, 0) AS inspecoes_reprovadas,
  COALESCE(n.ocorrencias, 0)          AS ocorrencias,
  f.lead_time_padrao_dias
FROM fornecedores f
LEFT JOIN entregas_agg  e ON e.fornecedor_id = f.id
LEFT JOIN qualidade_agg q ON q.fornecedor_id = f.id
LEFT JOIN nc_agg        n ON n.fornecedor_id = f.id
LEFT JOIN compras_agg   c ON c.fornecedor_id = f.id
WHERE f.deleted_at IS NULL;

COMMIT;
