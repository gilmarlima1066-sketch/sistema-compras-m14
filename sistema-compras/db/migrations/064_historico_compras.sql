-- ---------------------------------------------------------------------------
-- 064 - Historico de compras (entradas do ERP)
--
-- Relatorio de entradas do ERP: uma linha por item recebido, com data de
-- almoxarifado, pedido (PC), produto, caixas, kg, precos, aliquotas e o
-- parceiro (fornecedor). E a memoria de "quem ja me vendeu isto, quando e a
-- quanto": responde as duas perguntas da aba Historico de compras.
--
-- O codigo do produto e o ID do fornecedor ficam gravados como vieram, alem
-- das chaves estrangeiras: compra de produto ou fornecedor ainda nao
-- cadastrado nao se perde, e e ligada quando o cadastro chegar.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS historico_compras (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  data_entrada           DATE NOT NULL,
  pedido                 TEXT NOT NULL,
  produto_codigo         TEXT NOT NULL,
  produto_descricao      TEXT,
  produto_id             BIGINT REFERENCES produtos(id) ON DELETE SET NULL,
  fornecedor_codigo_erp  TEXT NOT NULL,
  fornecedor_nome        TEXT,
  fornecedor_id          BIGINT REFERENCES fornecedores(id) ON DELETE SET NULL,
  kg_caixa               NUMERIC(14,4),
  quantidade_caixas      NUMERIC(14,3) NOT NULL,
  total_kg               NUMERIC(16,3),
  preco_caixa            NUMERIC(14,4),
  preco_kg               NUMERIC(14,4),
  aliquota_icms          NUMERIC(7,4),
  aliquota_pis_cofins    NUMERIC(7,4),
  aliquota_icms_reduzida NUMERIC(7,4),
  tipo                   TEXT,
  importacao_id          BIGINT REFERENCES importacoes(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_historico_compras_quantidade CHECK (quantidade_caixas >= 0),
  CONSTRAINT ck_historico_compras_precos CHECK (
    (preco_caixa IS NULL OR preco_caixa >= 0) AND (preco_kg IS NULL OR preco_kg >= 0))
);

COMMENT ON TABLE historico_compras IS
  'Itens recebidos importados do ERP. Chave natural: pedido + produto + data + fornecedor + caixas + preco.';

-- Reimportar o mesmo relatorio atualiza a linha em vez de duplicar.
CREATE UNIQUE INDEX IF NOT EXISTS uq_historico_compras_item
  ON historico_compras (pedido, produto_codigo, data_entrada, fornecedor_codigo_erp,
                        quantidade_caixas, preco_caixa) NULLS NOT DISTINCT;

-- As duas consultas da tela: por produto e por fornecedor, mais recente primeiro.
CREATE INDEX IF NOT EXISTS ix_historico_compras_produto
  ON historico_compras (produto_id, data_entrada DESC);
CREATE INDEX IF NOT EXISTS ix_historico_compras_fornecedor
  ON historico_compras (fornecedor_id, data_entrada DESC);
CREATE INDEX IF NOT EXISTS ix_historico_compras_produto_codigo
  ON historico_compras (produto_codigo);
CREATE INDEX IF NOT EXISTS ix_historico_compras_fornecedor_codigo
  ON historico_compras (fornecedor_codigo_erp);
CREATE INDEX IF NOT EXISTS ix_historico_compras_data
  ON historico_compras (data_entrada DESC);
CREATE INDEX IF NOT EXISTS ix_historico_compras_importacao
  ON historico_compras (importacao_id);

INSERT INTO integracao_templates
  (codigo, nome, descricao, entidade, formato, linha_cabecalho, configuracao)
SELECT 'HISTORICO_COMPRAS',
       'ERP - Historico de compras (entradas)',
       'Itens recebidos no almoxarifado. PARCEIRO_ID e o ID do fornecedor no ERP.',
       'historico_compras', 'XLSX'::formato_arquivo_enum, 1,
       jsonb_build_object('chave_natural', jsonb_build_array('PC', 'COD', 'DTALMOXARIFADO', 'PARCEIRO_ID'))
 WHERE NOT EXISTS (
   SELECT 1 FROM integracao_templates WHERE upper(codigo) = 'HISTORICO_COMPRAS');

INSERT INTO integracao_mapeamentos
  (template_id, campo_externo, campo_interno, transformacao, obrigatorio, ordem, observacao)
SELECT t.id, m.externo, m.interno, m.transf, m.obrig, m.ord, m.obs
  FROM integracao_templates t,
  (VALUES
    ('DTALMOXARIFADO',  'compra.data_entrada',        'data',            true,  1, 'Data de entrada no almoxarifado'),
    ('PC',              'compra.pedido',              'texto',           true,  2, 'Pedido de compra no ERP'),
    ('COD',             'produto.codigo',             'texto_maiusculo', true,  3, NULL),
    ('DESC',            'produto.descricao',          'texto',           false, 4, NULL),
    ('KG_CX',           'compra.kg_caixa',            'decimal',         false, 5, NULL),
    ('QTD_CX',          'compra.quantidade_caixas',   'decimal',         true,  6, NULL),
    ('TOTAL_KG',        'compra.total_kg',            'decimal',         false, 7, NULL),
    ('PRECO_CX',        'compra.preco_caixa',         'decimal',         false, 8, NULL),
    ('PRECO_KG',        'compra.preco_kg',            'decimal',         false, 9, NULL),
    ('ALIQUOTAICMS',    'compra.aliquota_icms',          'decimal', false, 10, 'Fracao: 0,12 = 12%'),
    ('ALIQUOTA',        'compra.aliquota_icms',          'decimal', false, 10, 'Nome alternativo de ALIQUOTAICMS'),
    ('ALIQ_PIS_COFINS', 'compra.aliquota_pis_cofins',    'decimal', false, 11, NULL),
    ('ALIQ_ICMS_RED',   'compra.aliquota_icms_reduzida', 'decimal', false, 12, 'ICMS com reducao de base'),
    ('ALIQ_ICMS',       'compra.aliquota_icms_reduzida', 'decimal', false, 12, 'Nome alternativo de ALIQ_ICMS_RED'),
    ('TIPO',            'compra.tipo',                'texto',           false, 13, NULL),
    ('PARCEIRO_ID',     'fornecedor.codigo_erp',      'texto',           true,  14, 'Mesmo ID da base de fornecedores'),
    ('PARCEIRO_NOME',   'fornecedor.nome',            'texto',           false, 15, NULL)
  ) AS m(externo, interno, transf, obrig, ord, obs)
 WHERE upper(t.codigo) = 'HISTORICO_COMPRAS'
   AND NOT EXISTS (
     SELECT 1 FROM integracao_mapeamentos x
      WHERE x.template_id = t.id AND upper(x.campo_externo) = upper(m.externo));

COMMIT;
