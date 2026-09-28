-- ---------------------------------------------------------------------------
-- 029 - sinal da devolucao ao fornecedor
--
-- Fecha a migration 028: DEVOLUCAO_FORNECEDOR baixa o estoque (-1), enquanto
-- DEVOLUCAO (de cliente) continua somando (+1).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_sinal_movimentacao(p_tipo tipo_movimentacao_enum)
RETURNS SMALLINT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_tipo
    WHEN 'ENTRADA_COMPRA'        THEN 1
    WHEN 'DEVOLUCAO'             THEN 1
    WHEN 'AJUSTE_POSITIVO'       THEN 1
    WHEN 'TRANSFERENCIA_ENTRADA' THEN 1
    WHEN 'PRODUCAO'              THEN 1
    WHEN 'SAIDA_VENDA'           THEN -1
    WHEN 'AJUSTE_NEGATIVO'       THEN -1
    WHEN 'TRANSFERENCIA_SAIDA'   THEN -1
    WHEN 'PERDA'                 THEN -1
    WHEN 'AVARIA'                THEN -1
    WHEN 'CONSUMO_PRODUCAO'      THEN -1
    WHEN 'DEVOLUCAO_FORNECEDOR'  THEN -1
    WHEN 'INVENTARIO'            THEN 0
  END::SMALLINT;
$$;

COMMENT ON FUNCTION fn_sinal_movimentacao(tipo_movimentacao_enum) IS
  'Sinal da movimentacao no saldo: DEVOLUCAO e de cliente (+1), DEVOLUCAO_FORNECEDOR sai do estoque (-1).';
