-- =========================================================================
-- MODULO 11 - PAINEL DE IMPORTACOES
--
-- A composicao do painel de importacoes ja existia no codigo, mas o painel
-- nao estava no catalogo de dashboards - entao ele nao aparecia na lista e a
-- rota respondia 404. O catalogo e a lista sao a mesma verdade: o que nao
-- esta aqui nao existe para a tela.
-- =========================================================================

INSERT INTO dashboards (codigo, nome, descricao, perfil, sistema, padrao, ordem)
VALUES
  ('IMPORTACOES', 'Dashboard de importacoes',
   'Pedidos e valor em importacao, lead time e atrasos do fluxo internacional.',
   'GESTOR_COMPRAS', TRUE, FALSE, 12)
ON CONFLICT DO NOTHING;
