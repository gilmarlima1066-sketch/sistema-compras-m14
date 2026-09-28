-- ===========================================================================
-- Corrige a unicidade das previsoes.
--
-- A migration 005 impedia duas previsoes do mesmo produto, periodo e metodo.
-- Isso conflita com a regra do modulo 04 (secao 50): previsao anterior nao e
-- sobrescrita, uma nova execucao gera uma nova VERSAO. A unicidade correta ja
-- existe em uq_previsoes_versao (produto, periodo, versao).
-- ===========================================================================

ALTER TABLE previsoes_demanda DROP CONSTRAINT IF EXISTS uq_previsao_produto_periodo;

-- Consultar "a previsao vigente de cada produto" e a operacao mais frequente
-- do modulo; sem este indice ela varre a tabela inteira.
CREATE INDEX IF NOT EXISTS ix_previsoes_vigente
  ON previsoes_demanda (produto_id, periodo_inicio DESC, versao DESC);
