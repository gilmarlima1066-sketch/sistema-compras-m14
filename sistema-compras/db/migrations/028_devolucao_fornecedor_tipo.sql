-- ---------------------------------------------------------------------------
-- 028 - tipo de movimentacao para devolucao AO FORNECEDOR
--
-- O enum tinha 'DEVOLUCAO' com sinal +1: e a devolucao de CLIENTE, que devolve
-- mercadoria para dentro do estoque. A devolucao do modulo 09 e o oposto - a
-- mercadoria sai e volta para o fornecedor - e usar o tipo existente somaria
-- ao saldo em vez de baixar.
--
-- Migration separada porque o Postgres nao permite usar um valor de enum na
-- mesma transacao em que ele foi adicionado. O sinal vem na 029.
-- ---------------------------------------------------------------------------

ALTER TYPE tipo_movimentacao_enum ADD VALUE IF NOT EXISTS 'DEVOLUCAO_FORNECEDOR';
