-- ---------------------------------------------------------------------------
-- 047 - Idempotencia de webhook so vale para o que foi ACEITO
--
-- Falha encontrada pela bateria do modulo 13, e das silenciosas:
--
--   1. O parceiro envia o webhook com a assinatura errada (segredo trocado,
--      relogio fora de hora, configuracao nova). E recusado - corretamente - e
--      a tentativa fica gravada com a chave de idempotencia dele.
--   2. O parceiro corrige e reenvia o MESMO aviso, com a MESMA chave.
--   3. O indice UNIQUE (integracao, chave_idempotencia) ja estava ocupado pela
--      tentativa recusada, entao o sistema respondia "ja recebido" e nao
--      processava nada.
--
-- Resultado: o aviso legitimo nunca entrava, e os dois lados achavam que sim -
-- o parceiro porque recebeu 202, o sistema porque tinha o registro. Uma entrega
-- que some entre dois sistemas que se dizem de acordo e o pior tipo de falha de
-- integracao, porque ninguem procura.
--
-- A correcao: a chave so e reservada pelo que foi ACEITO. Tentativas recusadas
-- continuam todas registradas - varias com a mesma chave, se o parceiro insistir
-- errado - e nao bloqueiam a boa. O indice parcial diz isso em uma linha e nao
-- depende de o codigo lembrar da regra.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS uq_webhook_idempotencia;

CREATE UNIQUE INDEX uq_webhook_idempotencia
  ON webhooks_recebidos (integracao, chave_idempotencia)
  WHERE status IN ('RECEBIDO', 'PROCESSADO', 'DUPLICADO');

COMMENT ON INDEX uq_webhook_idempotencia IS
  'Idempotencia de entrada. Parcial de proposito: uma tentativa REJEITADO ou '
  'ERRO nao reserva a chave, para o reenvio corrigido do parceiro ser aceito.';

-- Para investigar um parceiro que esta errando a assinatura em serie.
CREATE INDEX IF NOT EXISTS ix_webhooks_chave
  ON webhooks_recebidos (integracao, chave_idempotencia, created_at DESC);
