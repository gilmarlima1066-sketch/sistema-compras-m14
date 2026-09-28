-- =============================================================================
-- 007_logistica_qualidade.sql  |  Entregas, recebimento, qualidade, avaliacao
-- =============================================================================

BEGIN;

CREATE TABLE entregas (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ordem_compra_id     BIGINT NOT NULL REFERENCES ordens_compra(id) ON DELETE CASCADE,
  data_prevista       DATE,
  data_confirmada     DATE,
  data_real           DATE,
  quantidade_prevista NUMERIC(14,3),
  quantidade_entregue NUMERIC(14,3),
  status              status_entrega_enum NOT NULL DEFAULT 'PENDENTE',
  -- atraso derivado: so existe quando ha data real e prevista
  dias_atraso         INTEGER GENERATED ALWAYS AS (
                        CASE WHEN data_real IS NOT NULL AND data_prevista IS NOT NULL
                             THEN GREATEST(data_real - data_prevista, 0) END) STORED,
  transportadora      TEXT,
  codigo_rastreio     TEXT,
  observacao          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_entregas_quantidades CHECK (
    (quantidade_prevista IS NULL OR quantidade_prevista >= 0) AND
    (quantidade_entregue IS NULL OR quantidade_entregue >= 0))
);
CREATE INDEX ix_entregas_oc       ON entregas (ordem_compra_id);
CREATE INDEX ix_entregas_status   ON entregas (status);
CREATE INDEX ix_entregas_prevista ON entregas (data_prevista);

-- -----------------------------------------------------------------------------
-- recebimentos
-- -----------------------------------------------------------------------------
CREATE TABLE recebimentos (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero            TEXT NOT NULL,
  ordem_compra_id   BIGINT REFERENCES ordens_compra(id) ON DELETE RESTRICT,
  fornecedor_id     BIGINT NOT NULL REFERENCES fornecedores(id) ON DELETE RESTRICT,
  local_id          BIGINT REFERENCES locais(id) ON DELETE RESTRICT,
  numero_nota_fiscal TEXT,
  chave_nfe         TEXT,
  data_recebimento  DATE NOT NULL DEFAULT CURRENT_DATE,
  valor_nota        NUMERIC(16,4),
  usuario_id        BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  status            status_recebimento_enum NOT NULL DEFAULT 'EM_CONFERENCIA',
  observacao        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_recebimentos_numero UNIQUE (numero),
  CONSTRAINT ck_recebimentos_chave_nfe CHECK (chave_nfe IS NULL OR chave_nfe ~ '^[0-9]{44}$'),
  CONSTRAINT ck_recebimentos_valor CHECK (valor_nota IS NULL OR valor_nota >= 0)
);
CREATE UNIQUE INDEX uq_recebimentos_chave_nfe ON recebimentos (chave_nfe) WHERE chave_nfe IS NOT NULL;
CREATE INDEX ix_recebimentos_data       ON recebimentos (data_recebimento DESC);
CREATE INDEX ix_recebimentos_oc         ON recebimentos (ordem_compra_id);
CREATE INDEX ix_recebimentos_fornecedor ON recebimentos (fornecedor_id);
CREATE INDEX ix_recebimentos_status     ON recebimentos (status);

CREATE TABLE recebimento_itens (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recebimento_id        BIGINT NOT NULL REFERENCES recebimentos(id) ON DELETE CASCADE,
  ordem_compra_item_id  BIGINT REFERENCES ordem_compra_itens(id) ON DELETE RESTRICT,
  produto_id            BIGINT NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  lote_id               BIGINT REFERENCES lotes(id) ON DELETE RESTRICT,
  quantidade_pedida     NUMERIC(14,3),
  quantidade_recebida   NUMERIC(14,3) NOT NULL,
  quantidade_aceita     NUMERIC(14,3) NOT NULL DEFAULT 0,
  quantidade_rejeitada  NUMERIC(14,3) NOT NULL DEFAULT 0,
  preco_unitario        NUMERIC(14,4),
  motivo_divergencia    TEXT,
  status                status_recebimento_item_enum NOT NULL DEFAULT 'PENDENTE',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_receb_item_qtd CHECK (
        quantidade_recebida > 0
    AND quantidade_aceita >= 0
    AND quantidade_rejeitada >= 0
    AND quantidade_aceita + quantidade_rejeitada <= quantidade_recebida
    AND (quantidade_pedida IS NULL OR quantidade_pedida >= 0)),
  CONSTRAINT ck_receb_item_preco CHECK (preco_unitario IS NULL OR preco_unitario >= 0)
);
CREATE INDEX ix_receb_itens_recebimento ON recebimento_itens (recebimento_id);
CREATE INDEX ix_receb_itens_produto     ON recebimento_itens (produto_id);
CREATE INDEX ix_receb_itens_oc_item     ON recebimento_itens (ordem_compra_item_id);
CREATE INDEX ix_receb_itens_lote        ON recebimento_itens (lote_id);

-- -----------------------------------------------------------------------------
-- qualidade
-- -----------------------------------------------------------------------------
CREATE TABLE inspecoes_qualidade (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recebimento_id      BIGINT REFERENCES recebimentos(id)       ON DELETE CASCADE,
  recebimento_item_id BIGINT REFERENCES recebimento_itens(id)  ON DELETE CASCADE,
  produto_id          BIGINT NOT NULL REFERENCES produtos(id)  ON DELETE RESTRICT,
  fornecedor_id       BIGINT REFERENCES fornecedores(id)       ON DELETE RESTRICT,
  lote_id             BIGINT REFERENCES lotes(id)              ON DELETE RESTRICT,
  data_inspecao       TIMESTAMPTZ NOT NULL DEFAULT now(),
  responsavel_id      BIGINT REFERENCES usuarios(id)           ON DELETE SET NULL,
  resultado           resultado_inspecao_enum NOT NULL,
  quantidade_avaliada NUMERIC(14,3),
  quantidade_aprovada NUMERIC(14,3),
  criterios           JSONB,
  observacoes         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_inspecao_quantidades CHECK (
    (quantidade_avaliada IS NULL OR quantidade_avaliada >= 0) AND
    (quantidade_aprovada IS NULL OR quantidade_aprovada >= 0) AND
    (quantidade_avaliada IS NULL OR quantidade_aprovada IS NULL
      OR quantidade_aprovada <= quantidade_avaliada))
);
CREATE INDEX ix_inspecoes_recebimento ON inspecoes_qualidade (recebimento_id);
CREATE INDEX ix_inspecoes_produto     ON inspecoes_qualidade (produto_id);
CREATE INDEX ix_inspecoes_fornecedor  ON inspecoes_qualidade (fornecedor_id, data_inspecao DESC);
CREATE INDEX ix_inspecoes_resultado   ON inspecoes_qualidade (resultado);

CREATE TABLE nao_conformidades (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  produto_id         BIGINT REFERENCES produtos(id)      ON DELETE RESTRICT,
  fornecedor_id      BIGINT REFERENCES fornecedores(id)  ON DELETE RESTRICT,
  lote_id            BIGINT REFERENCES lotes(id)         ON DELETE RESTRICT,
  recebimento_id     BIGINT REFERENCES recebimentos(id)  ON DELETE SET NULL,
  inspecao_id        BIGINT REFERENCES inspecoes_qualidade(id) ON DELETE SET NULL,
  tipo               tipo_nao_conformidade_enum NOT NULL,
  descricao          TEXT NOT NULL,
  quantidade_afetada NUMERIC(14,3),
  valor_impacto      NUMERIC(16,4),
  acao               acao_nao_conformidade_enum NOT NULL DEFAULT 'NENHUMA',
  status             status_nao_conformidade_enum NOT NULL DEFAULT 'ABERTA',
  responsavel_id     BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  data_resolucao     TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_nc_descricao CHECK (btrim(descricao) <> ''),
  CONSTRAINT ck_nc_quantidade CHECK (quantidade_afetada IS NULL OR quantidade_afetada >= 0),
  CONSTRAINT ck_nc_resolucao CHECK (status <> 'RESOLVIDA' OR data_resolucao IS NOT NULL)
);
CREATE INDEX ix_nc_fornecedor ON nao_conformidades (fornecedor_id, created_at DESC);
CREATE INDEX ix_nc_produto    ON nao_conformidades (produto_id);
CREATE INDEX ix_nc_status     ON nao_conformidades (status);

-- -----------------------------------------------------------------------------
-- avaliacoes_fornecedores  |  scorecard por periodo (calculo no Modulo 13)
-- -----------------------------------------------------------------------------
CREATE TABLE avaliacoes_fornecedores (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fornecedor_id  BIGINT NOT NULL REFERENCES fornecedores(id) ON DELETE CASCADE,
  periodo_inicio DATE NOT NULL,
  periodo_fim    DATE NOT NULL,
  otif           NUMERIC(5,2),
  qualidade      NUMERIC(5,2),
  lead_time      NUMERIC(5,2),
  preco          NUMERIC(5,2),
  atendimento    NUMERIC(5,2),
  flexibilidade  NUMERIC(5,2),
  score_final    NUMERIC(5,2),
  ocorrencias    INTEGER NOT NULL DEFAULT 0,
  observacoes    TEXT,
  calculado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  responsavel_id BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  CONSTRAINT uq_avaliacao_periodo UNIQUE (fornecedor_id, periodo_inicio, periodo_fim),
  CONSTRAINT ck_avaliacao_periodo CHECK (periodo_fim >= periodo_inicio),
  CONSTRAINT ck_avaliacao_notas CHECK (
        (otif          IS NULL OR otif          BETWEEN 0 AND 100)
    AND (qualidade     IS NULL OR qualidade     BETWEEN 0 AND 100)
    AND (lead_time     IS NULL OR lead_time     BETWEEN 0 AND 100)
    AND (preco         IS NULL OR preco         BETWEEN 0 AND 100)
    AND (atendimento   IS NULL OR atendimento   BETWEEN 0 AND 100)
    AND (flexibilidade IS NULL OR flexibilidade BETWEEN 0 AND 100)
    AND (score_final   IS NULL OR score_final   BETWEEN 0 AND 100)
    AND ocorrencias >= 0)
);
CREATE INDEX ix_avaliacoes_fornecedor ON avaliacoes_fornecedores (fornecedor_id, periodo_fim DESC);

COMMIT;
