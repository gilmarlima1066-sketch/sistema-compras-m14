-- ---------------------------------------------------------------------------
-- 059 - Categoria para produtos cadastrados pela carga de estoque do ERP
--
-- O Rel 9054 lista todos os produtos do ERP, inclusive os que ainda nao
-- venderam e por isso nunca entraram pelo Rel 7104. A carga de estoque os
-- cadastra para que a primeira venda ja encontre o produto. O relatorio nao
-- traz categoria, e jogar o produto na primeira categoria existente o
-- esconderia numa classificacao errada: ele fica aqui ate o comprador
-- classificar.
-- ---------------------------------------------------------------------------

BEGIN;

INSERT INTO categorias (nome, descricao, ativo)
SELECT 'A CLASSIFICAR (ERP)',
       'Produtos cadastrados pela carga de estoque do ERP, ainda sem categoria',
       true
 WHERE NOT EXISTS (SELECT 1 FROM categorias WHERE nome = 'A CLASSIFICAR (ERP)');

UPDATE integracao_mapeamentos m
   SET observacao = 'ATIVO/INATIVO no ERP; define se o produto novo nasce ativo'
  FROM integracao_templates t
 WHERE t.id = m.template_id
   AND upper(t.codigo) = 'REL9054_ESTOQUE'
   AND upper(m.campo_externo) = 'SITUACAO';

COMMIT;
