-- ---------------------------------------------------------------------------
-- 026 - item de recebimento pode existir antes da conferencia
--
-- A restricao ck_receb_item_qtd veio do modulo 03, onde o recebimento era
-- lancado de uma vez: o item so nascia ja com a quantidade recebida.
--
-- O modulo 09 inverte isso. A regra 1 da secao 58 diz que sem conferencia nao
-- ha entrada definitiva, entao o item do recebimento nasce no momento em que a
-- carga e aberta - com quantidade zero - e so recebe quantidade quando o
-- conferente conta a mercadoria. Exigir quantidade_recebida > 0 na criacao
-- obrigaria o sistema a inventar um numero antes de alguem contar, que e
-- exatamente o que o modulo existe para impedir.
--
-- O resto da restricao continua valendo: nada negativo, e o que foi aceito
-- somado ao que foi rejeitado nunca ultrapassa o que chegou.
-- ---------------------------------------------------------------------------

ALTER TABLE recebimento_itens DROP CONSTRAINT IF EXISTS ck_receb_item_qtd;

ALTER TABLE recebimento_itens ADD CONSTRAINT ck_receb_item_qtd CHECK (
  quantidade_recebida >= 0
  AND quantidade_aceita >= 0
  AND quantidade_rejeitada >= 0
  AND (quantidade_aceita + quantidade_rejeitada) <= quantidade_recebida
  AND (quantidade_pedida IS NULL OR quantidade_pedida >= 0)
);

COMMENT ON CONSTRAINT ck_receb_item_qtd ON recebimento_itens IS
  'Quantidade zero e valida enquanto o item aguarda conferencia (modulo 09, secao 58 regra 1).';
