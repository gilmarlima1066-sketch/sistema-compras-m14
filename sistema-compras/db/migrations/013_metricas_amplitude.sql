-- ===========================================================================
-- Amplia as colunas de metricas percentuais.
--
-- NUMERIC(8,4) so aceita ate 9999,9999. Produto que vendeu 1 unidade num mes e
-- 900 no seguinte produz MAPE de dezenas de milhares por cento - um numero
-- estranho, mas verdadeiro, e que precisa caber para que a previsao registre
-- honestamente o proprio erro em vez de estourar.
-- ===========================================================================

ALTER TABLE previsoes_demanda
  ALTER COLUMN mape            TYPE NUMERIC(14, 4),
  ALTER COLUMN erro_percentual TYPE NUMERIC(14, 4),
  ALTER COLUMN indice_sazonal  TYPE NUMERIC(12, 4),
  ALTER COLUMN confianca       TYPE NUMERIC(8, 4);

ALTER TABLE indices_sazonais
  ALTER COLUMN indice TYPE NUMERIC(12, 4);

ALTER TABLE vendas_outliers
  ALTER COLUMN z_score TYPE NUMERIC(14, 4);
