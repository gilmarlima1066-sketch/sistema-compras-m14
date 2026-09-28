-- ---------------------------------------------------------------------------
-- 046 - Execucao autocontida: a rastreabilidade da secao 35 sem depender do pai
--
-- Depois da 045 o historico sobrevive a exclusao do evento e da regra, mas
-- sobrevive MUDO: com regra_id anulado, ninguem mais responde "qual regra
-- decidiu isso". E a secao 35 exige exatamente isso - reconstruir, meses
-- depois, o que aconteceu, quando, por que, qual regra e qual usuario.
--
-- Ha um segundo furo, independente de exclusao: `automacao_regras.versao` sobe
-- a cada edicao. Guardar so o id significa que a auditoria de hoje descreve a
-- execucao de marco com o texto da regra como ela esta AGORA. Duas versoes da
-- mesma regra podem ter condicoes opostas.
--
-- A correcao e gravar a identidade no momento da execucao: codigo, versao e
-- tipo de evento viram colunas de texto na propria linha. O id continua, para
-- navegar quando o pai existe; o texto responde quando ele nao existe mais.
-- ---------------------------------------------------------------------------

ALTER TABLE automacao_execucoes
  ADD COLUMN IF NOT EXISTS regra_codigo text,
  ADD COLUMN IF NOT EXISTS regra_versao integer,
  ADD COLUMN IF NOT EXISTS evento_tipo  text;

COMMENT ON COLUMN automacao_execucoes.regra_codigo IS
  'Codigo da regra no momento da execucao. Sobrevive a exclusao da regra.';
COMMENT ON COLUMN automacao_execucoes.regra_versao IS
  'Versao da regra que rodou. A regra pode ter sido editada depois.';
COMMENT ON COLUMN automacao_execucoes.evento_tipo IS
  'Tipo do evento que originou a execucao. Sobrevive ao expurgo de eventos.';

-- Preenche o que ja existe, onde o pai ainda esta la. Onde nao esta, fica NULL
-- e isso e honesto: o dado nao foi capturado na epoca e nao se inventa.
--
-- O gatilho da 045 recusa este UPDATE, e esta certo em recusar: do ponto de
-- vista dele e uma reescrita de historico. A alternativa seria abrir no gatilho
-- uma excecao permanente do tipo "coluna nula pode ser preenchida" - o que
-- deixaria um furo aberto para sempre em troca de uma correcao de uma vez so.
-- Suspender o gatilho aqui dentro e mais seguro: vale somente nesta transacao,
-- esta escrito no arquivo que fica versionado, e o proprio migrate.ts roda cada
-- migration em uma unica transacao, entao se algo falhar o gatilho volta junto.
ALTER TABLE automacao_execucoes DISABLE TRIGGER trg_execucoes_imutavel;

UPDATE automacao_execucoes x
   SET regra_codigo = r.codigo,
       regra_versao = r.versao
  FROM automacao_regras r
 WHERE r.id = x.regra_id
   AND x.regra_codigo IS NULL;

UPDATE automacao_execucoes x
   SET evento_tipo = e.tipo
  FROM eventos e
 WHERE e.id = x.evento_id
   AND x.evento_tipo IS NULL;

ALTER TABLE automacao_execucoes ENABLE TRIGGER trg_execucoes_imutavel;

-- O gatilho da 045 compara o jsonb inteiro, entao as colunas novas ja entram
-- na protecao sem mudanca nenhuma: alterar regra_codigo depois e recusado.

CREATE INDEX IF NOT EXISTS ix_execucoes_regra_codigo
  ON automacao_execucoes (regra_codigo, created_at DESC)
  WHERE regra_codigo IS NOT NULL;
