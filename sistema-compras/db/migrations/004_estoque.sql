-- =============================================================================
-- 004_estoque.sql  |  Locais, lotes, saldos, movimentacoes, inventarios
-- =============================================================================

BEGIN;

CREATE TABLE locais (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo     TEXT NOT NULL,
  nome       TEXT NOT NULL,
  tipo       tipo_local_enum NOT NULL DEFAULT 'CD',
  ativo      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_locais_codigo UNIQUE (codigo)
);

-- -----------------------------------------------------------------------------
-- lotes  |  rastreabilidade e controle de validade (FEFO)
-- -----------------------------------------------------------------------------
CREATE TABLE lotes (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  produto_id         BIGINT NOT NULL REFERENCES produtos(id)     ON DELETE RESTRICT,
  numero_lote        TEXT   NOT NULL,
  data_fabricacao    DATE,
  data_validade      DATE,
  quantidade_inicial NUMERIC(14,3) NOT NULL DEFAULT 0,
  quantidade_atual   NUMERIC(14,3) NOT NULL DEFAULT 0,
  fornecedor_id      BIGINT REFERENCES fornecedores(id) ON DELETE SET NULL,
  status             status_lote_enum NOT NULL DEFAULT 'DISPONIVEL',
  observacao         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  updated_by         BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  CONSTRAINT uq_lotes_produto_numero UNIQUE (produto_id, numero_lote),
  CONSTRAINT ck_lotes_numero CHECK (btrim(numero_lote) <> ''),
  CONSTRAINT ck_lotes_quantidades CHECK (quantidade_inicial >= 0 AND quantidade_atual >= 0),
  CONSTRAINT ck_lotes_datas CHECK (
    data_fabricacao IS NULL OR data_validade IS NULL OR data_validade >= data_fabricacao)
);
CREATE INDEX ix_lotes_produto   ON lotes (produto_id);
CREATE INDEX ix_lotes_validade  ON lotes (data_validade) WHERE status = 'DISPONIVEL';
CREATE INDEX ix_lotes_fornecedor ON lotes (fornecedor_id);

-- -----------------------------------------------------------------------------
-- estoques  |  saldo por produto x local
-- -----------------------------------------------------------------------------
CREATE TABLE estoques (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  produto_id             BIGINT NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  local_id               BIGINT NOT NULL REFERENCES locais(id)   ON DELETE RESTRICT,
  quantidade_fisica      NUMERIC(14,3) NOT NULL DEFAULT 0,
  quantidade_reservada   NUMERIC(14,3) NOT NULL DEFAULT 0,
  -- disponivel e sempre derivado: nao pode divergir do fisico - reservado
  quantidade_disponivel  NUMERIC(14,3) GENERATED ALWAYS AS (quantidade_fisica - quantidade_reservada) STORED,
  quantidade_em_transito NUMERIC(14,3) NOT NULL DEFAULT 0,
  estoque_minimo         NUMERIC(14,3),
  estoque_maximo         NUMERIC(14,3),
  estoque_seguranca      NUMERIC(14,3),
  ponto_pedido           NUMERIC(14,3),
  ultima_entrada         TIMESTAMPTZ,
  ultima_saida           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_estoques_produto_local UNIQUE (produto_id, local_id),
  CONSTRAINT ck_estoques_reservada CHECK (quantidade_reservada >= 0),
  CONSTRAINT ck_estoques_transito  CHECK (quantidade_em_transito >= 0),
  CONSTRAINT ck_estoques_parametros CHECK (
    estoque_maximo IS NULL OR estoque_minimo IS NULL OR estoque_maximo >= estoque_minimo)
);
CREATE INDEX ix_estoques_produto ON estoques (produto_id);
CREATE INDEX ix_estoques_local   ON estoques (local_id);

-- -----------------------------------------------------------------------------
-- movimentacoes_estoque  |  razao de todo movimento (append-only na pratica)
-- -----------------------------------------------------------------------------
CREATE TABLE movimentacoes_estoque (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  produto_id        BIGINT NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  local_id          BIGINT NOT NULL REFERENCES locais(id)   ON DELETE RESTRICT,
  lote_id           BIGINT REFERENCES lotes(id)             ON DELETE RESTRICT,
  tipo_movimentacao tipo_movimentacao_enum NOT NULL,
  quantidade        NUMERIC(14,3) NOT NULL,
  custo_unitario    NUMERIC(14,4),
  documento_tipo    documento_movimentacao_enum,
  documento_id      BIGINT,
  observacao        TEXT,
  usuario_id        BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- quantidade sempre positiva, exceto INVENTARIO (que registra a diferenca apurada)
  CONSTRAINT ck_mov_quantidade CHECK (
    quantidade <> 0 AND (quantidade > 0 OR tipo_movimentacao = 'INVENTARIO')),
  CONSTRAINT ck_mov_custo CHECK (custo_unitario IS NULL OR custo_unitario >= 0)
);
CREATE INDEX ix_mov_produto     ON movimentacoes_estoque (produto_id);
CREATE INDEX ix_mov_created_at  ON movimentacoes_estoque (created_at DESC);
CREATE INDEX ix_mov_produto_data ON movimentacoes_estoque (produto_id, created_at DESC);
CREATE INDEX ix_mov_local       ON movimentacoes_estoque (local_id);
CREATE INDEX ix_mov_lote        ON movimentacoes_estoque (lote_id);
CREATE INDEX ix_mov_documento   ON movimentacoes_estoque (documento_tipo, documento_id);
CREATE INDEX ix_mov_tipo        ON movimentacoes_estoque (tipo_movimentacao);

-- -----------------------------------------------------------------------------
-- inventarios
-- -----------------------------------------------------------------------------
CREATE TABLE inventarios (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero        TEXT NOT NULL,
  local_id      BIGINT NOT NULL REFERENCES locais(id) ON DELETE RESTRICT,
  data_inicio   DATE NOT NULL DEFAULT CURRENT_DATE,
  data_fim      DATE,
  status        status_inventario_enum NOT NULL DEFAULT 'ABERTO',
  responsavel_id BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  observacao    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inventarios_numero UNIQUE (numero),
  CONSTRAINT ck_inventarios_datas CHECK (data_fim IS NULL OR data_fim >= data_inicio)
);
CREATE INDEX ix_inventarios_status ON inventarios (status);

CREATE TABLE inventario_itens (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inventario_id     BIGINT NOT NULL REFERENCES inventarios(id) ON DELETE CASCADE,
  produto_id        BIGINT NOT NULL REFERENCES produtos(id)    ON DELETE RESTRICT,
  lote_id           BIGINT REFERENCES lotes(id)                ON DELETE RESTRICT,
  quantidade_sistema NUMERIC(14,3) NOT NULL DEFAULT 0,
  quantidade_contada NUMERIC(14,3),
  diferenca          NUMERIC(14,3) GENERATED ALWAYS AS (COALESCE(quantidade_contada,0) - quantidade_sistema) STORED,
  contado_em         TIMESTAMPTZ,
  contado_por        BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  observacao         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inventario_item UNIQUE NULLS NOT DISTINCT (inventario_id, produto_id, lote_id),
  CONSTRAINT ck_inventario_item_qtd CHECK (quantidade_contada IS NULL OR quantidade_contada >= 0)
);
CREATE INDEX ix_inventario_itens_inventario ON inventario_itens (inventario_id);
CREATE INDEX ix_inventario_itens_produto    ON inventario_itens (produto_id);

COMMIT;
