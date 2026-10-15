-- ---------------------------------------------------------------------------
-- 063 - Base de fornecedores do ERP
--
-- O cadastro de fornecedores do ERP sai numa planilha com ID, FANTASIA,
-- ATIVO, NOME, endereco, CNPJCPF, IERG, CONTATO, FONES, EMAILCONTATO,
-- DTULTIMOPEDIDO e VALORULTPEDIDO.
--
-- - O ID do ERP vira `codigo_erp`, a chave da reimportacao: o mesmo arquivo
--   carregado de novo atualiza, nao duplica.
-- - CNPJCPF pode ser CPF (produtor rural, pessoa fisica): a coluna `cnpj`
--   passa a aceitar 11 ou 14 digitos.
-- - Fornecedor que veio do ERP sem documento continua valido: a chave dele e
--   o codigo do ERP.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE fornecedores
  ADD COLUMN IF NOT EXISTS codigo_erp          TEXT,
  ADD COLUMN IF NOT EXISTS contato             TEXT,
  ADD COLUMN IF NOT EXISTS data_ultimo_pedido  DATE,
  ADD COLUMN IF NOT EXISTS valor_ultimo_pedido NUMERIC(14,2);

COMMENT ON COLUMN fornecedores.codigo_erp IS
  'ID do fornecedor no ERP; chave natural da importacao da base de fornecedores.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_fornecedores_codigo_erp
  ON fornecedores (codigo_erp) WHERE codigo_erp IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE fornecedores DROP CONSTRAINT IF EXISTS ck_fornecedores_cnpj;
ALTER TABLE fornecedores ADD CONSTRAINT ck_fornecedores_cnpj
  CHECK (cnpj IS NULL OR cnpj ~ '^([0-9]{11}|[0-9]{14})$');

ALTER TABLE fornecedores DROP CONSTRAINT IF EXISTS ck_fornecedores_cnpj_nacional;
ALTER TABLE fornecedores ADD CONSTRAINT ck_fornecedores_cnpj_nacional CHECK (
  origem_fornecedor <> 'NACIONAL' OR cnpj IS NOT NULL OR codigo_erp IS NOT NULL
  OR deleted_at IS NOT NULL);

INSERT INTO integracao_templates
  (codigo, nome, descricao, entidade, formato, linha_cabecalho, configuracao)
SELECT 'FORNECEDORES_ERP',
       'ERP - Base de fornecedores',
       'Cadastro de fornecedores exportado do ERP. A chave e o ID do ERP; o CNPJ '
       || 'casa com fornecedores ja cadastrados a mao.',
       'fornecedores', 'XLSX'::formato_arquivo_enum, 1,
       jsonb_build_object('chave_natural', jsonb_build_array('ID'))
 WHERE NOT EXISTS (
   SELECT 1 FROM integracao_templates WHERE upper(codigo) = 'FORNECEDORES_ERP');

INSERT INTO integracao_mapeamentos
  (template_id, campo_externo, campo_interno, transformacao, obrigatorio, ordem, observacao)
SELECT t.id, m.externo, m.interno, m.transf, m.obrig, m.ord, m.obs
  FROM integracao_templates t,
  (VALUES
    ('ID',             'fornecedor.codigo_erp',         'texto',    true,  1, 'Codigo do fornecedor no ERP'),
    ('NOME',           'fornecedor.nome',               'texto',    true,  2, 'Razao social'),
    ('FANTASIA',       'fornecedor.nome_fantasia',      'texto',    false, 3, NULL),
    ('ATIVO',          'fornecedor.ativo',              'booleano', false, 4, 'S/N'),
    ('ENDERECO',       'fornecedor.endereco',           'texto',    false, 5, NULL),
    ('NUMERO',         'fornecedor.numero',             'texto',    false, 6, NULL),
    ('BAIRRO',         'fornecedor.bairro',             'texto',    false, 7, NULL),
    ('CIDADE',         'fornecedor.cidade',             'texto',    false, 8, NULL),
    ('CEP',            'fornecedor.cep',                'texto',    false, 9,
     'O Excel guarda como numero e perde o zero a esquerda; o gravador repoe'),
    ('ESTADO',         'fornecedor.estado',             'texto',    false, 10, NULL),
    ('CNPJCPF',        'fornecedor.documento',          'texto',    false, 11,
     'CNPJ ou CPF; zeros a esquerda perdidos no Excel sao repostos pelo digito verificador'),
    ('IERG',           'fornecedor.inscricao_estadual', 'texto',    false, 12, NULL),
    ('CONTATO',        'fornecedor.contato',            'texto',    false, 13, NULL),
    ('FONES',          'fornecedor.telefone',           'texto',    false, 14, NULL),
    ('EMAILCONTATO',   'fornecedor.email',              'texto',    false, 15, NULL),
    ('DTULTIMOPEDIDO', 'fornecedor.data_ultimo_pedido', 'data',     false, 16, NULL),
    ('VALORULTPEDIDO', 'fornecedor.valor_ultimo_pedido','decimal',  false, 17, NULL)
  ) AS m(externo, interno, transf, obrig, ord, obs)
 WHERE upper(t.codigo) = 'FORNECEDORES_ERP'
   AND NOT EXISTS (
     SELECT 1 FROM integracao_mapeamentos x
      WHERE x.template_id = t.id AND upper(x.campo_externo) = upper(m.externo));

COMMIT;
