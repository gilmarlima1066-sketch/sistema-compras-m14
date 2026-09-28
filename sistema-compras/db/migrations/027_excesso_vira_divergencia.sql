-- ---------------------------------------------------------------------------
-- 027 - excesso de recebimento vira divergencia, nao erro de banco
--
-- Dois gatilhos do modulo 03 recusavam no banco qualquer quantidade acima do
-- pedido mais a tolerancia:
--
--   trg_receb_item_valida_quantidade  (fn_validar_quantidade_recebida)
--   trg_oc_item_valida_recebido       (fn_validar_oc_item_recebido)
--
-- Faziam sentido quando o recebimento era um lancamento unico e manual. Com o
-- modulo 09 eles atrapalham duas coisas que a secao 28 exige:
--
--   1. o conferente precisa poder REGISTRAR o que chegou de verdade. Se 110
--      caixas desembarcaram contra 100 pedidas, recusar a contagem apaga o
--      fato; o sistema tem de aceitar o numero e abrir divergencia
--      QUANTIDADE_MAIOR;
--   2. aceitar o excesso e uma decisao de negocio. Quando o comprador decide
--      ACEITAR a divergencia, com justificativa e responsavel gravados, o
--      saldo do pedido passa do pedido de proposito.
--
-- O controle nao desaparece, muda de lugar e fica melhor: passa a ser
-- conferirQuantidade + divergencia PENDENTE + bloqueio da aprovacao ate alguem
-- decidir. Antes era um erro sem rastro; agora e uma decisao com autor,
-- justificativa e historico - o que as regras 7 e 8 da secao 58 pedem.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_receb_item_valida_quantidade ON recebimento_itens;
DROP TRIGGER IF EXISTS trg_oc_item_valida_recebido ON ordem_compra_itens;

-- As funcoes ficam no banco: nenhuma outra migration as usa, mas apaga-las
-- quebraria qualquer rollback manual que as recrie por nome.
COMMENT ON FUNCTION fn_validar_quantidade_recebida() IS
  'Desativada na migration 027: o excesso de recebimento passou a ser tratado como divergencia no modulo 09.';
COMMENT ON FUNCTION fn_validar_oc_item_recebido() IS
  'Desativada na migration 027: o saldo do pedido acima do pedido depende da decisao da divergencia (modulo 09).';
