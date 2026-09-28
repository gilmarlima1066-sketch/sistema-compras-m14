-- ===========================================================================
-- Separa "editar registros de compra" de "mudar as regras do planejamento".
--
-- A permissao `compras.editar` vem do modulo 01 e o COMPRADOR a tem - e deve
-- ter, porque edita necessidades. Mas ela estava servindo tambem de porteira
-- para os parametros do planejamento e para as alcadas de aprovacao, o que na
-- pratica deixava o comprador redefinir a propria alcada.
--
-- Secao 58 do PROMPT 05: quem altera o planejamento e o GESTOR_COMPRAS.
-- ===========================================================================

INSERT INTO permissoes (codigo, modulo, descricao) VALUES
  ('compras.parametrizar', 'compras',
   'Alterar parametros do planejamento e alcadas de aprovacao')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id
FROM perfis pf
JOIN permissoes pm ON pm.codigo = 'compras.parametrizar'
WHERE pf.nome IN ('ADMIN', 'GESTOR_COMPRAS')
ON CONFLICT DO NOTHING;
