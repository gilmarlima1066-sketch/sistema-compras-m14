-- =============================================================================
-- 005_demanda.sql  |  Clientes, vendas, previsoes e parametros de estoque
-- =============================================================================

BEGIN;

-- Cliente minimo: existe para dar integridade as vendas antes da integracao ERP
CREATE TABLE clientes (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo_externo TEXT,
  nome           TEXT NOT NULL,
  cnpj_cpf       TEXT,
  cidade         TEXT,
  estado         TEXT,
  canal          TEXT,
  ativo          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_clientes_codigo_externo UNIQUE (codigo_externo)
);
CREATE INDEX ix_clientes_nome ON clientes (lower(nome));

CREATE TABLE vendas (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero_documento TEXT NOT NULL,
  data_venda       DATE NOT NULL,
  cliente_id       BIGINT REFERENCES clientes(id) ON DELETE SET NULL,
  canal            TEXT,
  valor_total      NUMERIC(16,4) NOT NULL DEFAULT 0,
  status           status_venda_enum NOT NULL DEFAULT 'FATURADA',
  origem_integracao TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_vendas_numero UNIQUE (numero_documento),
  CONSTRAINT ck_vendas_valor CHECK (valor_total >= 0)
);
CREATE INDEX ix_vendas_data    ON vendas (data_venda DESC);
CREATE INDEX ix_vendas_cliente ON vendas (cliente_id);
CREATE INDEX ix_vendas_status  ON vendas (status);

CREATE TABLE itens_venda (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venda_id       BIGINT NOT NULL REFERENCES vendas(id)   ON DELETE CASCADE,
  produto_id     BIGINT NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  quantidade     NUMERIC(14,3) NOT NULL,
  preco_unitario NUMERIC(14,4) NOT NULL DEFAULT 0,
  desconto       NUMERIC(14,4) NOT NULL DEFAULT 0,
  valor_total    NUMERIC(16,4) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_itens_venda_qtd CHECK (quantidade > 0),
  CONSTRAINT ck_itens_venda_valores CHECK (preco_unitario >= 0 AND desconto >= 0 AND valor_total >= 0)
);
CREATE INDEX ix_itens_venda_venda   ON itens_venda (venda_id);
CREATE INDEX ix_itens_venda_produto ON itens_venda (produto_id);

-- -----------------------------------------------------------------------------
-- previsoes_demanda  |  estrutura pronta; o calculo entra no Modulo 04
-- -----------------------------------------------------------------------------
CREATE TABLE previsoes_demanda (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  produto_id        BIGINT NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  periodo_inicio    DATE NOT NULL,
  periodo_fim       DATE NOT NULL,
  demanda_historica NUMERIC(16,3),
  demanda_prevista  NUMERIC(16,3),
  metodo            metodo_previsao_enum NOT NULL DEFAULT 'MEDIA_MOVEL',
  confianca         NUMERIC(5,2),
  parametros        JSONB,
  gerado_por        BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_previsao_produto_periodo UNIQUE (produto_id, periodo_inicio, periodo_fim, metodo),
  CONSTRAINT ck_previsao_periodo CHECK (periodo_fim >= periodo_inicio),
  CONSTRAINT ck_previsao_confianca CHECK (confianca IS NULL OR (confianca >= 0 AND confianca <= 100)),
  CONSTRAINT ck_previsao_valores CHECK (
    (demanda_historica IS NULL OR demanda_historica >= 0) AND
    (demanda_prevista  IS NULL OR demanda_prevista  >= 0))
);
CREATE INDEX ix_previsoes_produto  ON previsoes_demanda (produto_id, periodo_inicio DESC);

-- -----------------------------------------------------------------------------
-- parametros_estoque  |  insumos do motor de necessidade de compra (Modulo 06)
-- -----------------------------------------------------------------------------
CREATE TABLE parametros_estoque (
  id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  produto_id                  BIGINT NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  demanda_media_diaria        NUMERIC(14,4),
  desvio_padrao_demanda       NUMERIC(14,4),
  lead_time_dias              INTEGER,
  desvio_padrao_lead_time     NUMERIC(10,4),
  nivel_servico               NUMERIC(5,2),
  estoque_seguranca           NUMERIC(14,3),
  ponto_pedido                NUMERIC(14,3),
  estoque_minimo              NUMERIC(14,3),
  estoque_maximo              NUMERIC(14,3),
  lote_economico              NUMERIC(14,3),
  moq                         NUMERIC(14,3),
  multiplo_compra             NUMERIC(14,3),
  horizonte_planejamento_dias INTEGER,
  calculado_automaticamente   BOOLEAN NOT NULL DEFAULT FALSE,
  atualizado_em               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                  BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  CONSTRAINT uq_parametros_estoque_produto UNIQUE (produto_id),
  CONSTRAINT ck_parametros_nivel_servico CHECK (
    nivel_servico IS NULL OR (nivel_servico > 0 AND nivel_servico <= 100)),
  CONSTRAINT ck_parametros_nao_negativos CHECK (
        (demanda_media_diaria        IS NULL OR demanda_media_diaria >= 0)
    AND (lead_time_dias              IS NULL OR lead_time_dias >= 0)
    AND (estoque_seguranca           IS NULL OR estoque_seguranca >= 0)
    AND (ponto_pedido                IS NULL OR ponto_pedido >= 0)
    AND (estoque_minimo              IS NULL OR estoque_minimo >= 0)
    AND (estoque_maximo              IS NULL OR estoque_maximo >= 0)
    AND (lote_economico              IS NULL OR lote_economico > 0)
    AND (horizonte_planejamento_dias IS NULL OR horizonte_planejamento_dias > 0))
);

COMMIT;
