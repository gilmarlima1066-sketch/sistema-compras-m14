-- ---------------------------------------------------------------------------
-- 065 - Historico de industrializados
--
-- Lancamentos de industrializacao do ERP: o produto sai de um estoque
-- (ESTOQUESAI) e entra em outro (ESTOQUEENTRA) para ser processado -
-- fracionado, embalado, misturado. E consumo interno: nao aparece como
-- venda, mas tira produto do estoque e precisa entrar na conta de quem
-- compra.
--
-- O ID do ERP e o DOCUMENTO, nao a linha: um documento leva varios produtos,
-- e o mesmo produto pode aparecer duas vezes nele (com quantidades
-- diferentes). A chave e documento + produto + ordem do item (1, 2, ...) no
-- documento: reimportar atualiza, nada e somado nem perdido.
-- PESOLIQ e o peso por unidade: o peso do lancamento e QTDE x PESOLIQ.
-- SITUACAO: OK (efetivado), AB e AL vem como o ERP manda.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS historico_industrializacao (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  documento_erp      TEXT NOT NULL,
  item               SMALLINT NOT NULL DEFAULT 1,
  estoque_saida      TEXT,
  estoque_entrada    TEXT,
  situacao           TEXT,
  data_inclusao      DATE NOT NULL,
  usuario            TEXT,
  produto_codigo     TEXT NOT NULL,
  produto_descricao  TEXT,
  produto_id         BIGINT REFERENCES produtos(id) ON DELETE SET NULL,
  quantidade         NUMERIC(14,3) NOT NULL,
  peso_liquido       NUMERIC(14,4),
  importacao_id      BIGINT REFERENCES importacoes(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_historico_industrializacao_item UNIQUE (documento_erp, produto_codigo, item),
  CONSTRAINT ck_historico_industrializacao_quantidade CHECK (quantidade >= 0)
);

COMMENT ON TABLE historico_industrializacao IS
  'Itens de industrializacao importados do ERP (saida de um estoque para outro). Chave: documento + produto + item.';
COMMENT ON COLUMN historico_industrializacao.peso_liquido IS
  'Peso liquido por unidade (PESOLIQ); peso do lancamento = quantidade x peso_liquido.';

CREATE INDEX IF NOT EXISTS ix_historico_industrializacao_data
  ON historico_industrializacao (data_inclusao DESC);
CREATE INDEX IF NOT EXISTS ix_historico_industrializacao_produto
  ON historico_industrializacao (produto_id, data_inclusao DESC);
CREATE INDEX IF NOT EXISTS ix_historico_industrializacao_produto_codigo
  ON historico_industrializacao (produto_codigo);
CREATE INDEX IF NOT EXISTS ix_historico_industrializacao_importacao
  ON historico_industrializacao (importacao_id);

INSERT INTO integracao_templates
  (codigo, nome, descricao, entidade, formato, linha_cabecalho, configuracao)
SELECT 'HISTORICO_INDUSTRIALIZACAO',
       'ERP - Historico de industrializados',
       'Itens de industrializacao (saida de um estoque para outro). Excel ou CSV.',
       'industrializacao', 'XLSX'::formato_arquivo_enum, 1,
       jsonb_build_object('chave_natural', jsonb_build_array('ID', 'CODPRODUTO'))
 WHERE NOT EXISTS (
   SELECT 1 FROM integracao_templates WHERE upper(codigo) = 'HISTORICO_INDUSTRIALIZACAO');

INSERT INTO integracao_mapeamentos
  (template_id, campo_externo, campo_interno, transformacao, obrigatorio, ordem, observacao)
SELECT t.id, m.externo, m.interno, m.transf, m.obrig, m.ord, m.obs
  FROM integracao_templates t,
  (VALUES
    ('ID',           'industrializacao.documento',       'texto',           true,  1, 'Documento no ERP (varios produtos por ID)'),
    ('ESTOQUESAI',   'industrializacao.estoque_saida',   'texto',           false, 2, NULL),
    ('ESTOQUEENTRA', 'industrializacao.estoque_entrada', 'texto',           false, 3, NULL),
    ('SITUACAO',     'industrializacao.situacao',        'texto_maiusculo', false, 4, NULL),
    ('DTINCLUSAO',   'industrializacao.data',            'data',            true,  5, NULL),
    ('USUARIOINC',   'industrializacao.usuario',         'texto',           false, 6, NULL),
    ('QTDE',         'industrializacao.quantidade',      'decimal',         true,  7, NULL),
    ('CODPRODUTO',   'produto.codigo',                   'texto_maiusculo', true,  8, NULL),
    ('DESCRICAO',    'produto.descricao',                'texto',           false, 9, NULL),
    ('PESOLIQ',      'industrializacao.peso_liquido',    'decimal',         false, 10, 'Peso por unidade')
  ) AS m(externo, interno, transf, obrig, ord, obs)
 WHERE upper(t.codigo) = 'HISTORICO_INDUSTRIALIZACAO'
   AND NOT EXISTS (
     SELECT 1 FROM integracao_mapeamentos x
      WHERE x.template_id = t.id AND upper(x.campo_externo) = upper(m.externo));

COMMIT;
