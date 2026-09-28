-- =============================================================================
-- 003_cadastros.sql  |  Categorias, marcas, unidades, produtos, fornecedores
-- =============================================================================

BEGIN;

CREATE TABLE categorias (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome       TEXT NOT NULL,
  descricao  TEXT,
  ativo      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_categorias_nome UNIQUE (nome),
  CONSTRAINT ck_categorias_nome CHECK (btrim(nome) <> '')
);

CREATE TABLE subcategorias (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  categoria_id BIGINT NOT NULL REFERENCES categorias(id) ON DELETE RESTRICT,
  nome         TEXT NOT NULL,
  descricao    TEXT,
  ativo        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_subcategorias_categoria_nome UNIQUE (categoria_id, nome)
);
CREATE INDEX ix_subcategorias_categoria ON subcategorias (categoria_id);

CREATE TABLE marcas (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome       TEXT NOT NULL,
  descricao  TEXT,
  ativo      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_marcas_nome UNIQUE (nome)
);

-- unidades de medida; fator_conversao_base normaliza para a unidade base do grupo
CREATE TABLE unidades (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo                TEXT NOT NULL,
  nome                  TEXT NOT NULL,
  fator_conversao_base  NUMERIC(18,6) NOT NULL DEFAULT 1,
  ativo                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_unidades_codigo UNIQUE (codigo),
  CONSTRAINT ck_unidades_fator CHECK (fator_conversao_base > 0)
);

-- -----------------------------------------------------------------------------
-- produtos  |  tabela central do cadastro
-- -----------------------------------------------------------------------------
CREATE TABLE produtos (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo                TEXT NOT NULL,
  ean                   TEXT,
  descricao             TEXT NOT NULL,
  descricao_completa    TEXT,
  categoria_id          BIGINT NOT NULL REFERENCES categorias(id)    ON DELETE RESTRICT,
  subcategoria_id       BIGINT REFERENCES subcategorias(id)          ON DELETE RESTRICT,
  marca_id              BIGINT REFERENCES marcas(id)                 ON DELETE RESTRICT,
  unidade_compra_id     BIGINT REFERENCES unidades(id)               ON DELETE RESTRICT,
  unidade_estoque_id    BIGINT NOT NULL REFERENCES unidades(id)      ON DELETE RESTRICT,
  unidade_venda_id      BIGINT REFERENCES unidades(id)               ON DELETE RESTRICT,
  fator_conversao       NUMERIC(18,6) NOT NULL DEFAULT 1,
  peso                  NUMERIC(14,4),
  dias_validade         INTEGER,
  origem                TEXT,
  produto_importado     BOOLEAN NOT NULL DEFAULT FALSE,
  ativo                 BOOLEAN NOT NULL DEFAULT TRUE,
  estoque_minimo        NUMERIC(14,3) NOT NULL DEFAULT 0,
  estoque_maximo        NUMERIC(14,3),
  estoque_seguranca     NUMERIC(14,3) NOT NULL DEFAULT 0,
  ponto_pedido          NUMERIC(14,3) NOT NULL DEFAULT 0,
  lead_time_padrao_dias INTEGER NOT NULL DEFAULT 0,
  moq                   NUMERIC(14,3),
  multiplo_compra       NUMERIC(14,3),
  classificacao_abc     classificacao_abc_enum,
  classificacao_xyz     classificacao_xyz_enum,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ,
  created_by            BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  updated_by            BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  CONSTRAINT ck_produtos_codigo        CHECK (btrim(codigo) <> ''),
  CONSTRAINT ck_produtos_descricao     CHECK (btrim(descricao) <> ''),
  CONSTRAINT ck_produtos_ean           CHECK (ean IS NULL OR ean ~ '^[0-9]{8,14}$'),
  CONSTRAINT ck_produtos_fator         CHECK (fator_conversao > 0),
  CONSTRAINT ck_produtos_peso          CHECK (peso IS NULL OR peso >= 0),
  CONSTRAINT ck_produtos_validade      CHECK (dias_validade IS NULL OR dias_validade > 0),
  CONSTRAINT ck_produtos_nao_negativos CHECK (
        estoque_minimo    >= 0
    AND estoque_seguranca >= 0
    AND ponto_pedido      >= 0
    AND lead_time_padrao_dias >= 0
    AND (estoque_maximo   IS NULL OR estoque_maximo >= 0)
    AND (moq              IS NULL OR moq > 0)
    AND (multiplo_compra  IS NULL OR multiplo_compra > 0)),
  CONSTRAINT ck_produtos_min_max CHECK (estoque_maximo IS NULL OR estoque_maximo >= estoque_minimo),
  -- subcategoria precisa pertencer a categoria: validado por trigger (ver 009)
  CONSTRAINT ck_produtos_subcat_requer_cat CHECK (subcategoria_id IS NULL OR categoria_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_produtos_codigo ON produtos (upper(codigo)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_produtos_ean    ON produtos (ean) WHERE ean IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_produtos_categoria     ON produtos (categoria_id);
CREATE INDEX ix_produtos_subcategoria  ON produtos (subcategoria_id);
CREATE INDEX ix_produtos_marca         ON produtos (marca_id);
CREATE INDEX ix_produtos_ativo         ON produtos (ativo) WHERE deleted_at IS NULL;
CREATE INDEX ix_produtos_abc_xyz       ON produtos (classificacao_abc, classificacao_xyz);
-- busca textual por descricao (1.500+ SKUs, busca no frontend)
CREATE INDEX ix_produtos_descricao_trgm ON produtos USING gin (to_tsvector('portuguese', descricao));

-- -----------------------------------------------------------------------------
-- fornecedores
-- -----------------------------------------------------------------------------
CREATE TABLE fornecedores (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  razao_social          TEXT NOT NULL,
  nome_fantasia         TEXT,
  cnpj                  TEXT,
  inscricao_estadual    TEXT,
  email                 TEXT,
  telefone              TEXT,
  celular               TEXT,
  endereco              TEXT,
  numero                TEXT,
  complemento           TEXT,
  bairro                TEXT,
  cidade                TEXT,
  estado                TEXT,
  cep                   TEXT,
  pais                  TEXT NOT NULL DEFAULT 'Brasil',
  tipo_fornecedor       tipo_fornecedor_enum   NOT NULL DEFAULT 'DISTRIBUIDOR',
  origem_fornecedor     origem_fornecedor_enum NOT NULL DEFAULT 'NACIONAL',
  prazo_medio_pagamento INTEGER,
  lead_time_padrao_dias INTEGER,
  observacoes           TEXT,
  ativo                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ,
  created_by            BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  updated_by            BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  CONSTRAINT ck_fornecedores_razao   CHECK (btrim(razao_social) <> ''),
  CONSTRAINT ck_fornecedores_cnpj    CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$'),
  CONSTRAINT ck_fornecedores_email   CHECK (email IS NULL OR email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT ck_fornecedores_estado  CHECK (estado IS NULL OR length(estado) BETWEEN 2 AND 40),
  CONSTRAINT ck_fornecedores_prazos  CHECK (
        (prazo_medio_pagamento IS NULL OR prazo_medio_pagamento >= 0)
    AND (lead_time_padrao_dias IS NULL OR lead_time_padrao_dias >= 0)),
  -- fornecedor nacional precisa de CNPJ; internacional pode nao ter
  CONSTRAINT ck_fornecedores_cnpj_nacional CHECK (
    origem_fornecedor <> 'NACIONAL' OR cnpj IS NOT NULL OR deleted_at IS NOT NULL)
);
CREATE UNIQUE INDEX uq_fornecedores_cnpj ON fornecedores (cnpj) WHERE cnpj IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_fornecedores_nome_fantasia ON fornecedores (lower(nome_fantasia));
CREATE INDEX ix_fornecedores_razao_social  ON fornecedores (lower(razao_social));
CREATE INDEX ix_fornecedores_ativo ON fornecedores (ativo) WHERE deleted_at IS NULL;
CREATE INDEX ix_fornecedores_origem ON fornecedores (origem_fornecedor);

-- -----------------------------------------------------------------------------
-- condicoes_pagamento
-- -----------------------------------------------------------------------------
CREATE TABLE condicoes_pagamento (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome       TEXT NOT NULL,
  descricao  TEXT,
  dias       INTEGER NOT NULL DEFAULT 0,
  ativo      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_condicoes_pagamento_nome UNIQUE (nome),
  CONSTRAINT ck_condicoes_pagamento_dias CHECK (dias >= 0)
);

-- -----------------------------------------------------------------------------
-- produto_fornecedor  |  N:N com dados comerciais por par
-- -----------------------------------------------------------------------------
CREATE TABLE produto_fornecedor (
  id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  produto_id                BIGINT NOT NULL REFERENCES produtos(id)     ON DELETE CASCADE,
  fornecedor_id             BIGINT NOT NULL REFERENCES fornecedores(id) ON DELETE RESTRICT,
  codigo_produto_fornecedor TEXT,
  preco_atual               NUMERIC(14,4),
  preco_anterior            NUMERIC(14,4),
  moeda                     CHAR(3) NOT NULL DEFAULT 'BRL',
  moq                       NUMERIC(14,3),
  multiplo_compra           NUMERIC(14,3),
  lead_time_dias            INTEGER,
  prazo_pagamento_dias      INTEGER,
  frete_estimado            NUMERIC(14,4),
  fornecedor_principal      BOOLEAN NOT NULL DEFAULT FALSE,
  data_ultima_compra        DATE,
  ultima_quantidade         NUMERIC(14,3),
  ativo                     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by                BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  updated_by                BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  CONSTRAINT uq_produto_fornecedor UNIQUE (produto_id, fornecedor_id),
  CONSTRAINT ck_pf_moeda   CHECK (moeda ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_pf_valores CHECK (
        (preco_atual          IS NULL OR preco_atual >= 0)
    AND (preco_anterior       IS NULL OR preco_anterior >= 0)
    AND (moq                  IS NULL OR moq > 0)
    AND (multiplo_compra      IS NULL OR multiplo_compra > 0)
    AND (lead_time_dias       IS NULL OR lead_time_dias >= 0)
    AND (prazo_pagamento_dias IS NULL OR prazo_pagamento_dias >= 0)
    AND (frete_estimado       IS NULL OR frete_estimado >= 0)
    AND (ultima_quantidade    IS NULL OR ultima_quantidade >= 0))
);
CREATE INDEX ix_pf_produto    ON produto_fornecedor (produto_id);
CREATE INDEX ix_pf_fornecedor ON produto_fornecedor (fornecedor_id);
-- no maximo um fornecedor principal por produto
CREATE UNIQUE INDEX uq_pf_principal ON produto_fornecedor (produto_id) WHERE fornecedor_principal;

COMMIT;
