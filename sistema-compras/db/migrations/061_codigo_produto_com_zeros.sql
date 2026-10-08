-- ---------------------------------------------------------------------------
-- 061 - Codigo de produto com zeros a esquerda
--
-- A carga de estoque das migrations 058/059 removia os zeros a esquerda do
-- codigo ("00583" -> "583") supondo que o cadastro guardava sem eles. Errado:
-- o ERP exporta texto com cinco digitos ("00583", "01043") no Rel 7104 e no
-- Rel 9054, e e assim que o cadastro guarda. A consequencia, se a carga rodou:
--
--   1. produto que ja existia ("00583") ganhou uma duplicata ("583") com o
--      saldo do ERP;
--   2. produto novo foi criado como "5" em vez de "00005", e a primeira venda
--      ("00005") nao o encontraria.
--
-- So produtos da categoria "A CLASSIFICAR (ERP)" sao tocados: sao os criados
-- pela carga. Depois desta migration, reimporte o Rel 9054 para o saldo ir
-- para o produto certo.
-- ---------------------------------------------------------------------------

BEGIN;

-- 1. Duplicatas: exclusao logica. A razao de estoque e somente insercao, entao
--    o historico da duplicata fica; o planejamento ignora produto excluido.
UPDATE produtos d
   SET deleted_at = now(), ativo = false, updated_at = now()
  FROM categorias c
 WHERE c.id = d.categoria_id
   AND c.nome = 'A CLASSIFICAR (ERP)'
   AND d.deleted_at IS NULL
   AND d.codigo ~ '^[1-9][0-9]{0,3}$'
   AND EXISTS (
     SELECT 1 FROM produtos o
      WHERE o.id <> d.id
        AND o.deleted_at IS NULL
        AND o.codigo = lpad(d.codigo, 5, '0'));

-- 2. Os demais voltam ao formato do ERP.
UPDATE produtos d
   SET codigo = lpad(d.codigo, 5, '0'), updated_at = now()
  FROM categorias c
 WHERE c.id = d.categoria_id
   AND c.nome = 'A CLASSIFICAR (ERP)'
   AND d.deleted_at IS NULL
   AND d.codigo ~ '^[1-9][0-9]{0,3}$'
   AND NOT EXISTS (
     SELECT 1 FROM produtos o
      WHERE o.deleted_at IS NULL AND upper(o.codigo) = lpad(d.codigo, 5, '0'));

UPDATE integracao_mapeamentos m
   SET observacao = 'Codigo como o ERP exporta (texto com zeros a esquerda); '
                 || 'sem o codigo exato, casa ignorando os zeros'
  FROM integracao_templates t
 WHERE t.id = m.template_id
   AND upper(t.codigo) = 'REL9054_ESTOQUE'
   AND upper(m.campo_externo) = 'CODPRODUTO';

COMMIT;
