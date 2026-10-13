-- ---------------------------------------------------------------------------
-- 062 - Marca da importacao na venda
--
-- O Rel 7104 traz uma linha por item e nao tem numero de item, entao os itens
-- de uma nota ja existente sao regravados inteiros. Isso precisa acontecer UMA
-- vez por nota por importacao: uma nota dividida entre dois lotes nao pode ter
-- os itens do primeiro lote apagados pelo segundo.
--
-- A importacao em lotes pelo navegador nao tem memoria entre requisicoes, entao
-- a marca fica na propria venda: o gravador so limpa os itens de uma nota cuja
-- ultima importacao nao e a atual.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE vendas
  ADD COLUMN ultima_importacao_id BIGINT REFERENCES importacoes(id) ON DELETE SET NULL;

COMMIT;
