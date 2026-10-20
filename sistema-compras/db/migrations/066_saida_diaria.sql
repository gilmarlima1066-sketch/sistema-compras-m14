-- ---------------------------------------------------------------------------
-- 066 - Saida diaria: venda + industrializado
--
-- O que sai da prateleira e o que precisa ser reposto: a venda (Rel 7104,
-- liquida de devolucao, em mv_demanda_diaria) mais o produto que saiu para
-- industrializacao (fracionados, situacao OK). Cobertura, media de consumo
-- e sugestao de compra leem daqui; faturamento e o dashboard de vendas
-- continuam em mv_demanda_diaria, porque industrializado nao e receita.
--
-- View comum (nao materializada): a industrializacao importada aparece na
-- hora, sem depender do refresh das views de demanda.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE OR REPLACE VIEW vw_saida_diaria AS
SELECT produto_id,
       data,
       sum(venda)                 AS quantidade_venda,
       sum(industrializada)       AS quantidade_industrializada,
       sum(venda + industrializada) AS quantidade
  FROM (
    SELECT d.produto_id, d.data_venda AS data, d.quantidade AS venda, 0::numeric AS industrializada
      FROM mv_demanda_diaria d
    UNION ALL
    SELECT h.produto_id, h.data_inclusao, 0::numeric, h.quantidade
      FROM historico_industrializacao h
     WHERE h.situacao = 'OK' AND h.produto_id IS NOT NULL
  ) x
 GROUP BY produto_id, data;

COMMENT ON VIEW vw_saida_diaria IS
  'Saida por produto e dia: venda liquida + industrializado (situacao OK). Base de cobertura e sugestao de compra.';

-- A busca por produto e por periodo na industrializacao ja tem indice
-- (ix_historico_industrializacao_produto); este cobre o filtro por situacao.
CREATE INDEX IF NOT EXISTS ix_historico_industrializacao_ok
  ON historico_industrializacao (produto_id, data_inclusao) WHERE situacao = 'OK';

COMMIT;
