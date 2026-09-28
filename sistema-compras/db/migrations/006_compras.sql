-- =============================================================================
-- 006_compras.sql  |  Necessidades, cotacoes, negociacoes, ordens de compra
-- =============================================================================

BEGIN;

CREATE TABLE necessidades_compra (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  produto_id          BIGINT NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  data_geracao        DATE NOT NULL DEFAULT CURRENT_DATE,
  estoque_atual       NUMERIC(14,3),
  estoque_disponivel  NUMERIC(14,3),
  estoque_em_transito NUMERIC(14,3),
  demanda_prevista    NUMERIC(16,3),
  estoque_seguranca   NUMERIC(14,3),
  quantidade_sugerida NUMERIC(14,3) NOT NULL DEFAULT 0,
  quantidade_aprovada NUMERIC(14,3),
  urgencia            urgencia_enum NOT NULL DEFAULT 'NORMAL',
  status              status_necessidade_enum NOT NULL DEFAULT 'PENDENTE',
  observacao          TEXT,
  usuario_id          BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_necessidade_qtd CHECK (
    quantidade_sugerida >= 0 AND (quantidade_aprovada IS NULL OR quantidade_aprovada >= 0))
);
CREATE INDEX ix_necessidades_status  ON necessidades_compra (status);
CREATE INDEX ix_necessidades_produto ON necessidades_compra (produto_id);
CREATE INDEX ix_necessidades_urgencia ON necessidades_compra (urgencia) WHERE status IN ('PENDENTE','EM_ANALISE');

-- -----------------------------------------------------------------------------
-- cotacoes
-- -----------------------------------------------------------------------------
CREATE TABLE cotacoes (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero         TEXT NOT NULL,
  data_abertura  DATE NOT NULL DEFAULT CURRENT_DATE,
  data_limite    DATE,
  responsavel_id BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  status         status_cotacao_enum NOT NULL DEFAULT 'RASCUNHO',
  observacao     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  updated_by     BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  CONSTRAINT uq_cotacoes_numero UNIQUE (numero),
  CONSTRAINT ck_cotacoes_datas CHECK (data_limite IS NULL OR data_limite >= data_abertura)
);
CREATE INDEX ix_cotacoes_status ON cotacoes (status);
CREATE INDEX ix_cotacoes_data   ON cotacoes (data_abertura DESC);

CREATE TABLE cotacao_fornecedores (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cotacao_id    BIGINT NOT NULL REFERENCES cotacoes(id)     ON DELETE CASCADE,
  fornecedor_id BIGINT NOT NULL REFERENCES fornecedores(id) ON DELETE RESTRICT,
  data_envio    TIMESTAMPTZ,
  data_resposta TIMESTAMPTZ,
  status        status_cotacao_fornecedor_enum NOT NULL DEFAULT 'PENDENTE',
  observacao    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cotacao_fornecedor UNIQUE (cotacao_id, fornecedor_id),
  CONSTRAINT ck_cotacao_fornecedor_datas CHECK (
    data_resposta IS NULL OR data_envio IS NULL OR data_resposta >= data_envio)
);
CREATE INDEX ix_cotacao_fornecedores_fornecedor ON cotacao_fornecedores (fornecedor_id);

CREATE TABLE cotacao_itens (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cotacao_id            BIGINT NOT NULL REFERENCES cotacoes(id)     ON DELETE CASCADE,
  fornecedor_id         BIGINT NOT NULL REFERENCES fornecedores(id) ON DELETE RESTRICT,
  produto_id            BIGINT NOT NULL REFERENCES produtos(id)     ON DELETE RESTRICT,
  necessidade_compra_id BIGINT REFERENCES necessidades_compra(id)   ON DELETE SET NULL,
  quantidade_solicitada NUMERIC(14,3) NOT NULL,
  quantidade_ofertada   NUMERIC(14,3),
  preco_unitario        NUMERIC(14,4),
  desconto              NUMERIC(14,4) NOT NULL DEFAULT 0,
  frete                 NUMERIC(14,4) NOT NULL DEFAULT 0,
  impostos              NUMERIC(14,4) NOT NULL DEFAULT 0,
  outros_custos         NUMERIC(14,4) NOT NULL DEFAULT 0,
  custo_total           NUMERIC(16,4),
  -- custo efetivo por unidade: base para comparacao entre fornecedores (Modulo 07)
  custo_efetivo_unitario NUMERIC(16,6),
  prazo_entrega_dias    INTEGER,
  prazo_pagamento_dias  INTEGER,
  validade_proposta     DATE,
  moeda                 CHAR(3) NOT NULL DEFAULT 'BRL',
  observacao            TEXT,
  selecionado           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cotacao_item UNIQUE (cotacao_id, fornecedor_id, produto_id),
  CONSTRAINT ck_cotacao_item_qtd CHECK (
    quantidade_solicitada > 0 AND (quantidade_ofertada IS NULL OR quantidade_ofertada >= 0)),
  CONSTRAINT ck_cotacao_item_valores CHECK (
        (preco_unitario IS NULL OR preco_unitario >= 0)
    AND desconto >= 0 AND frete >= 0 AND impostos >= 0 AND outros_custos >= 0
    AND (prazo_entrega_dias   IS NULL OR prazo_entrega_dias >= 0)
    AND (prazo_pagamento_dias IS NULL OR prazo_pagamento_dias >= 0)),
  CONSTRAINT ck_cotacao_item_moeda CHECK (moeda ~ '^[A-Z]{3}$')
);
CREATE INDEX ix_cotacao_itens_cotacao    ON cotacao_itens (cotacao_id);
CREATE INDEX ix_cotacao_itens_produto    ON cotacao_itens (produto_id);
CREATE INDEX ix_cotacao_itens_fornecedor ON cotacao_itens (fornecedor_id);
-- um unico item selecionado por produto dentro da cotacao
CREATE UNIQUE INDEX uq_cotacao_item_selecionado ON cotacao_itens (cotacao_id, produto_id) WHERE selecionado;

-- garante que o fornecedor do item foi de fato convidado para a cotacao
ALTER TABLE cotacao_itens
  ADD CONSTRAINT fk_cotacao_item_convite
  FOREIGN KEY (cotacao_id, fornecedor_id)
  REFERENCES cotacao_fornecedores (cotacao_id, fornecedor_id) ON DELETE CASCADE;

CREATE TABLE negociacoes (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cotacao_item_id    BIGINT NOT NULL REFERENCES cotacao_itens(id) ON DELETE CASCADE,
  data               TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario_id         BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  preco_anterior     NUMERIC(14,4),
  preco_negociado    NUMERIC(14,4),
  desconto           NUMERIC(14,4),
  prazo_anterior     INTEGER,
  prazo_negociado    INTEGER,
  condicao_anterior  TEXT,
  condicao_negociada TEXT,
  -- saving da rodada: positivo quando o preco caiu
  saving_unitario    NUMERIC(14,4) GENERATED ALWAYS AS (
                       COALESCE(preco_anterior,0) - COALESCE(preco_negociado,0)) STORED,
  observacao         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_negociacoes_valores CHECK (
        (preco_anterior  IS NULL OR preco_anterior >= 0)
    AND (preco_negociado IS NULL OR preco_negociado >= 0)
    AND (desconto        IS NULL OR desconto >= 0))
);
CREATE INDEX ix_negociacoes_item ON negociacoes (cotacao_item_id, data DESC);

-- -----------------------------------------------------------------------------
-- ordens_compra
-- -----------------------------------------------------------------------------
CREATE TABLE ordens_compra (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero                 TEXT NOT NULL,
  fornecedor_id          BIGINT NOT NULL REFERENCES fornecedores(id) ON DELETE RESTRICT,
  cotacao_id             BIGINT REFERENCES cotacoes(id) ON DELETE SET NULL,
  data_emissao           DATE NOT NULL DEFAULT CURRENT_DATE,
  data_prevista_entrega  DATE,
  valor_produtos         NUMERIC(16,4) NOT NULL DEFAULT 0,
  desconto               NUMERIC(16,4) NOT NULL DEFAULT 0,
  frete                  NUMERIC(16,4) NOT NULL DEFAULT 0,
  impostos               NUMERIC(16,4) NOT NULL DEFAULT 0,
  outros_custos          NUMERIC(16,4) NOT NULL DEFAULT 0,
  valor_total            NUMERIC(16,4) NOT NULL DEFAULT 0,
  moeda                  CHAR(3) NOT NULL DEFAULT 'BRL',
  condicao_pagamento_id  BIGINT REFERENCES condicoes_pagamento(id) ON DELETE RESTRICT,
  responsavel_id         BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  aprovador_id           BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  data_aprovacao         TIMESTAMPTZ,
  status                 status_ordem_compra_enum NOT NULL DEFAULT 'RASCUNHO',
  observacao             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  updated_by             BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  CONSTRAINT uq_ordens_compra_numero UNIQUE (numero),
  CONSTRAINT ck_oc_valores CHECK (
    valor_produtos >= 0 AND desconto >= 0 AND frete >= 0 AND impostos >= 0
    AND outros_custos >= 0 AND valor_total >= 0),
  CONSTRAINT ck_oc_datas CHECK (data_prevista_entrega IS NULL OR data_prevista_entrega >= data_emissao),
  CONSTRAINT ck_oc_moeda CHECK (moeda ~ '^[A-Z]{3}$'),
  -- OC aprovada exige aprovador registrado (segregacao de funcoes)
  CONSTRAINT ck_oc_aprovacao CHECK (
    status NOT IN ('APROVADA','ENVIADA','CONFIRMADA','EM_PRODUCAO','EM_TRANSITO',
                   'RECEBIMENTO_PARCIAL','RECEBIDA','FINALIZADA')
    OR aprovador_id IS NOT NULL)
);
CREATE INDEX ix_oc_status      ON ordens_compra (status);
CREATE INDEX ix_oc_fornecedor  ON ordens_compra (fornecedor_id);
CREATE INDEX ix_oc_prevista    ON ordens_compra (data_prevista_entrega);
CREATE INDEX ix_oc_emissao     ON ordens_compra (data_emissao DESC);
CREATE INDEX ix_oc_abertas     ON ordens_compra (data_prevista_entrega)
  WHERE status IN ('APROVADA','ENVIADA','CONFIRMADA','EM_PRODUCAO','EM_TRANSITO','RECEBIMENTO_PARCIAL');

CREATE TABLE ordem_compra_itens (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ordem_compra_id       BIGINT NOT NULL REFERENCES ordens_compra(id) ON DELETE CASCADE,
  produto_id            BIGINT NOT NULL REFERENCES produtos(id)      ON DELETE RESTRICT,
  cotacao_item_id       BIGINT REFERENCES cotacao_itens(id) ON DELETE SET NULL,
  quantidade_pedida     NUMERIC(14,3) NOT NULL,
  quantidade_confirmada NUMERIC(14,3),
  quantidade_recebida   NUMERIC(14,3) NOT NULL DEFAULT 0,
  preco_unitario        NUMERIC(14,4) NOT NULL DEFAULT 0,
  desconto              NUMERIC(14,4) NOT NULL DEFAULT 0,
  valor_total           NUMERIC(16,4) NOT NULL DEFAULT 0,
  data_prevista_entrega DATE,
  observacao            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_oc_item UNIQUE (ordem_compra_id, produto_id),
  CONSTRAINT ck_oc_item_qtd CHECK (
        quantidade_pedida > 0
    AND quantidade_recebida >= 0
    AND (quantidade_confirmada IS NULL OR quantidade_confirmada >= 0)),
  CONSTRAINT ck_oc_item_valores CHECK (preco_unitario >= 0 AND desconto >= 0 AND valor_total >= 0)
);
CREATE INDEX ix_oc_itens_oc      ON ordem_compra_itens (ordem_compra_id);
CREATE INDEX ix_oc_itens_produto ON ordem_compra_itens (produto_id);

-- -----------------------------------------------------------------------------
-- historico_precos  |  append-only, nunca apagado
-- -----------------------------------------------------------------------------
CREATE TABLE historico_precos (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  produto_id        BIGINT NOT NULL REFERENCES produtos(id)     ON DELETE RESTRICT,
  fornecedor_id     BIGINT NOT NULL REFERENCES fornecedores(id) ON DELETE RESTRICT,
  data              DATE NOT NULL DEFAULT CURRENT_DATE,
  quantidade        NUMERIC(14,3),
  preco_unitario    NUMERIC(14,4) NOT NULL,
  frete             NUMERIC(14,4) NOT NULL DEFAULT 0,
  impostos          NUMERIC(14,4) NOT NULL DEFAULT 0,
  outros_custos     NUMERIC(14,4) NOT NULL DEFAULT 0,
  custo_efetivo     NUMERIC(16,6),
  moeda             CHAR(3) NOT NULL DEFAULT 'BRL',
  condicao_pagamento TEXT,
  ordem_compra_id   BIGINT REFERENCES ordens_compra(id) ON DELETE SET NULL,
  origem            TEXT,
  usuario_id        BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_hist_precos_valores CHECK (
    preco_unitario >= 0 AND frete >= 0 AND impostos >= 0 AND outros_custos >= 0
    AND (quantidade IS NULL OR quantidade > 0))
);
CREATE INDEX ix_hist_precos_produto    ON historico_precos (produto_id, data DESC);
CREATE INDEX ix_hist_precos_fornecedor ON historico_precos (fornecedor_id, data DESC);
CREATE INDEX ix_hist_precos_par        ON historico_precos (produto_id, fornecedor_id, data DESC);

CREATE TRIGGER trg_historico_precos_append_only
  BEFORE UPDATE OR DELETE ON historico_precos
  FOR EACH ROW EXECUTE FUNCTION fn_bloquear_alteracao();

-- -----------------------------------------------------------------------------
-- compromissos_compra  |  ponte para o financeiro
-- -----------------------------------------------------------------------------
CREATE TABLE compromissos_compra (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ordem_compra_id BIGINT NOT NULL REFERENCES ordens_compra(id) ON DELETE CASCADE,
  fornecedor_id   BIGINT NOT NULL REFERENCES fornecedores(id)  ON DELETE RESTRICT,
  parcela         INTEGER NOT NULL DEFAULT 1,
  vencimento      DATE NOT NULL,
  valor           NUMERIC(16,4) NOT NULL,
  moeda           CHAR(3) NOT NULL DEFAULT 'BRL',
  status          status_compromisso_enum NOT NULL DEFAULT 'PREVISTO',
  data_pagamento  DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_compromisso_parcela UNIQUE (ordem_compra_id, parcela),
  CONSTRAINT ck_compromisso_valor CHECK (valor > 0 AND parcela > 0)
);
CREATE INDEX ix_compromissos_vencimento ON compromissos_compra (vencimento) WHERE status <> 'PAGO';
CREATE INDEX ix_compromissos_fornecedor ON compromissos_compra (fornecedor_id);

COMMIT;
