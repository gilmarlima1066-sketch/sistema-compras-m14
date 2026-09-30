-- ---------------------------------------------------------------------------
-- 058 - Carga do saldo de estoque do ERP (Relatorio 9054)
--
-- O Rel 9054 e a "BASE ESTOQUE" da planilha de gestao de compras: uma linha
-- por produto com QTDE (saldo fisico) e QTDEVENDIDA (vendido e ainda nao
-- faturado). O saldo disponivel da planilha e QTDE - |QTDEVENDIDA|, que e
-- exatamente `estoques.quantidade_disponivel` (fisico - reservado).
--
-- O ERP nao informa local, entao o saldo vai para um local proprio, "ERP".
-- Assim a carga nunca mistura a sua razao com a de outro local.
-- ---------------------------------------------------------------------------

BEGIN;

INSERT INTO locais (codigo, nome, tipo)
SELECT 'ERP', 'Estoque do ERP', 'CD'::tipo_local_enum
 WHERE NOT EXISTS (SELECT 1 FROM locais WHERE upper(codigo) = 'ERP');

INSERT INTO integracao_templates
  (codigo, nome, descricao, entidade, formato, linha_cabecalho, configuracao)
SELECT 'REL9054_ESTOQUE',
       'ERP - Relatorio 9054 (saldo de estoque)',
       'Saldo por produto exportado pelo ERP. O arquivo .xls e uma tabela HTML '
       || 'em Windows-1252; o navegador decodifica antes de ler.',
       'estoque', 'XLSX'::formato_arquivo_enum, 1,
       jsonb_build_object(
         'chave_natural', jsonb_build_array('CODPRODUTO'),
         'local_codigo', 'ERP')
 WHERE NOT EXISTS (
   SELECT 1 FROM integracao_templates WHERE upper(codigo) = 'REL9054_ESTOQUE');

INSERT INTO integracao_mapeamentos
  (template_id, campo_externo, campo_interno, transformacao, obrigatorio, ordem, observacao)
SELECT t.id, m.externo, m.interno, m.transf, m.obrig, m.ord, m.obs
  FROM integracao_templates t,
  (VALUES
    ('CODPRODUTO',  'produto.codigo',               'texto_maiusculo', true,  1,
     'Zeros a esquerda sao removidos para casar com o codigo do Rel 7104'),
    ('QTDE',        'estoque.quantidade_fisica',    'decimal',         true,  2,
     'Saldo fisico; a diferenca para o saldo atual vira movimentacao INVENTARIO'),
    ('QTDEVENDIDA', 'estoque.quantidade_reservada', 'decimal',         false, 3,
     'Vendido e nao faturado; gravado como reservado'),
    ('DESCRICAO',   'produto.descricao',            'texto',           false, 4, NULL),
    ('CODBARRAS',   'produto.ean',                  'texto',           false, 5, NULL),
    ('UNIDADE',     'produto.unidade',              'texto',           false, 6, NULL),
    ('SITUACAO',    'produto.situacao',             'texto',           false, 7,
     'ATIVO/INATIVO no ERP; informativo, nao altera o cadastro')
  ) AS m(externo, interno, transf, obrig, ord, obs)
 WHERE upper(t.codigo) = 'REL9054_ESTOQUE'
   AND NOT EXISTS (
     SELECT 1 FROM integracao_mapeamentos x
      WHERE x.template_id = t.id AND upper(x.campo_externo) = upper(m.externo));

COMMIT;
