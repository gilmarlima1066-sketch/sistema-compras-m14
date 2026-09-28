-- ---------------------------------------------------------------------------
-- 054 - Os tres templates que o catalogo anunciava vazios
--
-- A migration 051 cadastrou quatro modelos de mapeamento e preencheu os campos
-- de um so: REL7104_VENDAS. PRODUTOS_PADRAO, FORNECEDORES_PADRAO e
-- PRECOS_FORNECEDOR ficaram como cascas - apareciam na lista, o usuario podia
-- selecionar, e o resultado era um mapeamento de zero campos.
--
-- O sintoma para quem usa e pior do que um erro: a importacao "funciona",
-- processa o arquivo inteiro e grava nada, porque nenhuma coluna foi mapeada
-- para lugar nenhum. Um erro ao menos manda conferir alguma coisa.
--
-- Os nomes de `campo_interno` abaixo nao sao escolhidos por bom senso: sao
-- exatamente as chaves que os gravadores leem em `gravadores.ts`
-- (`dados['produto.codigo']`, `dados['fornecedor.cnpj']`, ...). Esse e o mesmo
-- contrato implicito que, no modulo 13, deixou cinco regras inertes por um nome
-- trocado - e aqui ele fica conferido de uma vez, com a view de contrato no fim.
-- ---------------------------------------------------------------------------

INSERT INTO integracao_mapeamentos
  (template_id, campo_externo, campo_interno, transformacao, obrigatorio, ordem, observacao)
SELECT t.id, m.externo, m.interno, m.transf, m.obrig, m.ord, m.obs
  FROM integracao_templates t,
  (VALUES
    -- PRODUTOS_PADRAO -------------------------------------------------------
    ('PRODUTOS_PADRAO', 'CODIGO',    'produto.codigo',    'texto_maiusculo', true,  1,
     'Chave natural do produto'),
    ('PRODUTOS_PADRAO', 'DESCRICAO', 'produto.descricao', 'texto',           true,  2, NULL),
    ('PRODUTOS_PADRAO', 'EAN',       'produto.ean',       'ean',             false, 3,
     'EAN com digito verificador invalido vira alerta, nao erro'),
    ('PRODUTOS_PADRAO', 'CATEGORIA', 'produto.categoria', 'texto',           false, 4,
     'Casada pelo nome; categoria inexistente rejeita a linha'),
    ('PRODUTOS_PADRAO', 'UNIDADE',   'produto.unidade',   'unidade',         false, 5,
     'Normalizada para o codigo da tabela unidades (KG, UN, CX...)'),

    -- FORNECEDORES_PADRAO ---------------------------------------------------
    ('FORNECEDORES_PADRAO', 'CNPJ',      'fornecedor.cnpj',          'cnpj',  true,  1,
     'Chave natural; digito verificador conferido na normalizacao'),
    ('FORNECEDORES_PADRAO', 'RAZAOSOCIAL', 'fornecedor.nome',        'texto', true,  2, NULL),
    ('FORNECEDORES_PADRAO', 'FANTASIA',  'fornecedor.nome_fantasia', 'texto', false, 3, NULL),
    ('FORNECEDORES_PADRAO', 'CIDADE',    'fornecedor.cidade',        'texto', false, 4, NULL),
    ('FORNECEDORES_PADRAO', 'UF',        'fornecedor.estado',        'uf',    false, 5, NULL),
    ('FORNECEDORES_PADRAO', 'EMAIL',     'fornecedor.email',         'texto', false, 6,
     'Usado pela integracao de e-mail do nivel 1 (secao 19)'),
    ('FORNECEDORES_PADRAO', 'TELEFONE',  'fornecedor.telefone',      'texto', false, 7, NULL),

    -- PRECOS_FORNECEDOR -----------------------------------------------------
    ('PRECOS_FORNECEDOR', 'CNPJ',      'fornecedor.cnpj',                'cnpj',            true,  1,
     'Identifica de quem e a tabela de precos'),
    ('PRECOS_FORNECEDOR', 'CODIGO',    'produto.codigo',                 'texto_maiusculo', true,  2,
     'Produto ja cadastrado; desconhecido vira alerta'),
    ('PRECOS_FORNECEDOR', 'PRECO',     'produto_fornecedor.preco',       'decimal',         true,  3,
     'Preco novo; o anterior e preservado em preco_anterior'),
    ('PRECOS_FORNECEDOR', 'MOQ',       'produto_fornecedor.moq',         'decimal',         false, 4,
     'Quantidade minima de compra'),
    ('PRECOS_FORNECEDOR', 'MULTIPLO',  'produto_fornecedor.multiplo',    'decimal',         false, 5, NULL),
    ('PRECOS_FORNECEDOR', 'LEADTIME',  'produto_fornecedor.lead_time',   'inteiro',         false, 6,
     'Em dias')
  ) AS m(template, externo, interno, transf, obrig, ord, obs)
 WHERE upper(t.codigo) = upper(m.template)
   AND NOT EXISTS (
     SELECT 1 FROM integracao_mapeamentos x
      WHERE x.template_id = t.id AND upper(x.campo_externo) = upper(m.externo));

-- ---------------------------------------------------------------------------
-- A verificacao permanente
-- ---------------------------------------------------------------------------

-- Um template sem campo mapeado e uma armadilha: processa e nao grava nada.
-- A view deixa isso visivel na Central de Integracoes em vez de esperar o
-- usuario descobrir depois de importar um arquivo de 40 mil linhas.
CREATE OR REPLACE VIEW vw_templates_saude AS
SELECT t.id,
       t.codigo,
       t.nome,
       t.entidade,
       t.ativo,
       count(m.id)                                           AS campos,
       count(m.id) FILTER (WHERE m.obrigatorio)              AS campos_obrigatorios,
       (count(m.id) = 0)                                     AS sem_mapeamento,
       t.vezes_usado
  FROM integracao_templates t
  LEFT JOIN integracao_mapeamentos m ON m.template_id = t.id
 GROUP BY t.id, t.codigo, t.nome, t.entidade, t.ativo, t.vezes_usado;

COMMENT ON VIEW vw_templates_saude IS
  'Saude dos modelos de mapeamento. sem_mapeamento = true significa um template '
  'que processa o arquivo e nao grava nada, por nao ter nenhuma coluna mapeada.';
