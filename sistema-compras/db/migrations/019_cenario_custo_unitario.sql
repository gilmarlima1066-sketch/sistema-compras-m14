-- ===========================================================================
-- Custo por unidade atendida no cenario.
--
-- Comparar cenarios pelo custo total absoluto engana quando eles atendem
-- quantidades diferentes: o cenario que compra menos parece mais barato. Foi
-- exatamente o que a bateria pegou - o cenario "menor custo" somava mais que o
-- "menor prazo" porque atendia 6.000 unidades contra 4.000.
--
-- O custo por unidade atendida torna os cenarios comparaveis; o custo total e
-- o atendimento continuam visiveis lado a lado.
-- ===========================================================================

ALTER TABLE cotacao_cenarios
  ADD COLUMN IF NOT EXISTS quantidade_atendida NUMERIC(16, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantidade_total    NUMERIC(16, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS custo_por_unidade   NUMERIC(16, 6);

COMMENT ON COLUMN cotacao_cenarios.custo_por_unidade IS
  'Custo total dividido pela quantidade efetivamente atendida: e o numero que permite comparar cenarios de coberturas diferentes';
