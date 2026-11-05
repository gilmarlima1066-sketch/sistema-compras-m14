-- ---------------------------------------------------------------------------
-- 068 - Orcamento para fornecedor (PDF enviado pelo WhatsApp)
--
-- O comprador monta o orcamento na tela - fornecedor, produtos, precos,
-- impostos e condicoes - e envia em PDF no layout do pedido do ERP.
--
-- O orcamento guarda uma COPIA dos dados do fornecedor e dos produtos como
-- foram enviados: o PDF reemitido amanha tem de sair igual ao de hoje, mesmo
-- que o cadastro mude. Os impostos de cada item ficam gravados porque o
-- proximo orcamento do produto parte deles ("sempre o ultimo imposto").
-- ---------------------------------------------------------------------------

BEGIN;

-- Cabecalho do PDF: dados da empresa compradora, editaveis em Configuracoes.
INSERT INTO configuracoes (chave, valor, tipo, grupo, descricao) VALUES
  ('empresa.razao_social', 'VIDA EM GRAOS COM E IND DE PRODS ALIMENT IMP EXP LTDA', 'STRING', 'empresa', 'Razao social no cabecalho do orcamento'),
  ('empresa.endereco',     'AV FORTE DO LEME 1150 GALPOES 8 E 9', 'STRING', 'empresa', 'Endereco'),
  ('empresa.bairro',       'PARQUE SÃO LOURENÇO', 'STRING', 'empresa', 'Bairro'),
  ('empresa.cidade',       'SÃO PAULO', 'STRING', 'empresa', 'Cidade'),
  ('empresa.cep',          '08340-010', 'STRING', 'empresa', 'CEP'),
  ('empresa.cnpj',         '18.285.535/0001-11', 'STRING', 'empresa', 'CNPJ'),
  ('empresa.telefone',     '11 3322-9145', 'STRING', 'empresa', 'Telefone'),
  ('empresa.site',         'www.vidaemgraos.com.br', 'STRING', 'empresa', 'Site no rodape'),
  ('empresa.email',        'luciana.campos@vidaemgraos.com.br', 'STRING', 'empresa', 'E-mail no rodape'),
  ('empresa.departamento', 'Departamento de Compras', 'STRING', 'empresa', 'Assinatura do orcamento')
ON CONFLICT (chave) DO NOTHING;

CREATE TABLE IF NOT EXISTS orcamentos_fornecedor (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status              TEXT NOT NULL DEFAULT 'RASCUNHO',
  fornecedor_id       BIGINT REFERENCES fornecedores(id) ON DELETE SET NULL,
  fornecedor          JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_emissao        DATE NOT NULL DEFAULT CURRENT_DATE,
  tipo_operacao       TEXT NOT NULL DEFAULT 'COMPRAS',
  condicao_pagamento  TEXT,
  data_entrega        DATE,
  transportadora      TEXT,
  observacoes         TEXT,
  desconto            NUMERIC(14,2) NOT NULL DEFAULT 0,
  frete               NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_mercadorias   NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_ipi           NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_st            NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_icms          NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_pis           NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_cofins        NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_pedido        NUMERIC(16,2) NOT NULL DEFAULT 0,
  comprador           TEXT,
  enviado_em          TIMESTAMPTZ,
  created_by          BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  updated_by          BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_orcamentos_fornecedor_status CHECK (status IN ('RASCUNHO', 'ENVIADO')),
  CONSTRAINT ck_orcamentos_fornecedor_valores CHECK (desconto >= 0 AND frete >= 0)
);

CREATE TABLE IF NOT EXISTS orcamento_fornecedor_itens (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  orcamento_id     BIGINT NOT NULL REFERENCES orcamentos_fornecedor(id) ON DELETE CASCADE,
  ordem            SMALLINT NOT NULL,
  produto_id       BIGINT REFERENCES produtos(id) ON DELETE SET NULL,
  produto_codigo   TEXT NOT NULL,
  descricao        TEXT NOT NULL,
  unidade          TEXT,
  quantidade       NUMERIC(14,3) NOT NULL,
  preco_unitario   NUMERIC(14,4) NOT NULL DEFAULT 0,
  desconto         NUMERIC(14,2) NOT NULL DEFAULT 0,
  st_valor         NUMERIC(14,2) NOT NULL DEFAULT 0,
  ipi_pct          NUMERIC(7,4) NOT NULL DEFAULT 0,
  icms_pct         NUMERIC(7,4) NOT NULL DEFAULT 0,
  pis_pct          NUMERIC(7,4) NOT NULL DEFAULT 0,
  cofins_pct       NUMERIC(7,4) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_orcamento_itens_valores CHECK (
    quantidade > 0 AND preco_unitario >= 0 AND desconto >= 0 AND st_valor >= 0
    AND ipi_pct >= 0 AND icms_pct >= 0 AND pis_pct >= 0 AND cofins_pct >= 0)
);

COMMENT ON COLUMN orcamento_fornecedor_itens.icms_pct IS 'Percentual (12 = 12%), como digitado no orcamento.';

CREATE INDEX IF NOT EXISTS ix_orcamentos_fornecedor_fornecedor ON orcamentos_fornecedor (fornecedor_id, data_emissao DESC);
CREATE INDEX IF NOT EXISTS ix_orcamentos_fornecedor_data ON orcamentos_fornecedor (data_emissao DESC, id DESC);
CREATE INDEX IF NOT EXISTS ix_orcamento_itens_orcamento ON orcamento_fornecedor_itens (orcamento_id, ordem);
-- "Ultimo imposto/preco do produto": item mais recente por produto.
CREATE INDEX IF NOT EXISTS ix_orcamento_itens_produto ON orcamento_fornecedor_itens (produto_id, id DESC);

COMMIT;
