-- ---------------------------------------------------------------------------
-- 021 - Janela de alerta de vencimento de pedido (MODULO 07, secao 49)
--
-- O alerta "pedido proximo do vencimento" precisa de um limite configuravel,
-- como os demais parametros do modulo. Sem esta chave o servico cai num
-- padrao embutido de 3 dias, o que esconde a regra do gestor.
-- ---------------------------------------------------------------------------

INSERT INTO configuracoes (chave, valor, tipo, grupo, descricao) VALUES
  ('pedido.dias_alerta_vencimento', '3', 'NUMERO', 'pedido',
   'Dias antes da data de entrega em que o pedido passa a gerar alerta de vencimento')
ON CONFLICT (chave) DO NOTHING;
