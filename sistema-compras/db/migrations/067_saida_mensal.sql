-- ---------------------------------------------------------------------------
-- 067 - Saida mensal: venda + industrializado por mes
--
-- Base mensal de previsao, sazonalidade e classificacao XYZ: a mesma conta
-- de vw_saida_diaria (venda liquida + industrializado com situacao OK),
-- agregada por mes. Faturamento e curva ABC continuam em mv_demanda_mensal.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE OR REPLACE VIEW vw_saida_mensal AS
SELECT produto_id,
       date_trunc('month', data)::date   AS mes,
       sum(quantidade)                   AS quantidade,
       sum(quantidade_venda)             AS quantidade_venda,
       sum(quantidade_industrializada)   AS quantidade_industrializada,
       count(*)                          AS dias_com_saida
  FROM vw_saida_diaria
 GROUP BY produto_id, date_trunc('month', data)::date;

COMMENT ON VIEW vw_saida_mensal IS
  'Saida por produto e mes (venda + industrializado). Base de previsao, sazonalidade e XYZ.';

COMMIT;
