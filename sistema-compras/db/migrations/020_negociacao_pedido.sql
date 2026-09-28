-- ===========================================================================
-- MODULO 07 - Negociacao + Pedido de Compra
--
-- Reaproveita ORDENS_COMPRA, ORDEM_COMPRA_ITENS, NEGOCIACOES,
-- COMPROMISSOS_COMPRA, COTACOES, COTACAO_ITENS, NECESSIDADES_COMPRA,
-- REQUISICOES_COMPRA, CONDICOES_PAGAMENTO, ALCADAS_APROVACAO e HISTORICO_PRECOS.
--
-- Sobre a tabela NEGOCIACOES: ela ja existia como registro de negociacao por
-- item de cotacao (preco anterior, preco negociado, saving). Em vez de criar
-- uma NEGOCIACAO_RODADA_ITENS paralela, ela passa a ser exatamente isso - o
-- item de uma rodada - ganhando os vinculos que faltavam. Nada e duplicado.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Estados
-- ---------------------------------------------------------------------------
ALTER TYPE status_ordem_compra_enum ADD VALUE IF NOT EXISTS 'REJEITADA';
ALTER TYPE status_ordem_compra_enum ADD VALUE IF NOT EXISTS 'BLOQUEADA';

CREATE TYPE status_negociacao_enum AS ENUM (
  'RASCUNHO', 'ABERTA', 'EM_NEGOCIACAO', 'AGUARDANDO_FORNECEDOR',
  'CONTRAPROPOSTA_RECEBIDA', 'EM_ANALISE', 'ACORDADA', 'APROVADA',
  'CONVERTIDA_PEDIDO', 'REJEITADA', 'CANCELADA'
);

CREATE TYPE origem_negociacao_enum AS ENUM ('COTACAO', 'PROPOSTA', 'MANUAL');
CREATE TYPE autor_rodada_enum AS ENUM ('COMPRADOR', 'FORNECEDOR');
CREATE TYPE metodo_rateio_frete_enum AS ENUM ('VALOR', 'PESO', 'QUANTIDADE', 'PERCENTUAL', 'MANUAL');
CREATE TYPE motivo_cancelamento_enum AS ENUM (
  'ERRO', 'FORNECEDOR', 'PRECO', 'ESTOQUE', 'DEMANDA',
  'MUDANCA_COMERCIAL', 'NECESSIDADE_CANCELADA', 'OUTRO'
);
CREATE TYPE motivo_rejeicao_enum AS ENUM (
  'PRECO', 'PRAZO', 'CONDICAO_COMERCIAL', 'ORCAMENTO', 'ESTOQUE',
  'PLANEJAMENTO', 'QUALIDADE', 'FORNECEDOR', 'OUTRO'
);
CREATE TYPE status_aprovacao_enum AS ENUM ('PENDENTE', 'APROVADA', 'REJEITADA', 'DISPENSADA');
CREATE TYPE status_alteracao_pedido_enum AS ENUM ('SOLICITADA', 'APROVADA', 'REJEITADA', 'APLICADA');

-- ---------------------------------------------------------------------------
-- 2. Negociacao (cabecalho)
-- ---------------------------------------------------------------------------
CREATE TABLE negociacoes_compra (
  id                     BIGSERIAL PRIMARY KEY,
  numero                 TEXT NOT NULL UNIQUE,
  origem                 origem_negociacao_enum NOT NULL DEFAULT 'COTACAO',
  cotacao_id             BIGINT REFERENCES cotacoes (id),
  fornecedor_id          BIGINT NOT NULL REFERENCES fornecedores (id),
  comprador_id           BIGINT REFERENCES usuarios (id),
  status                 status_negociacao_enum NOT NULL DEFAULT 'RASCUNHO',
  prioridade             prioridade_compra_enum NOT NULL DEFAULT 'MEDIA',
  data_abertura          DATE NOT NULL DEFAULT CURRENT_DATE,
  data_limite            DATE,
  rodada_atual           INTEGER NOT NULL DEFAULT 0,
  moeda                  CHAR(3) NOT NULL DEFAULT 'BRL',
  taxa_cambio            NUMERIC(14, 6),
  incoterm               incoterm_enum,
  -- Valores de abertura, congelados: sao a referencia da economia.
  valor_produtos_inicial NUMERIC(16, 2) NOT NULL DEFAULT 0,
  frete_inicial          NUMERIC(14, 2) NOT NULL DEFAULT 0,
  impostos_inicial       NUMERIC(14, 2) NOT NULL DEFAULT 0,
  outros_inicial         NUMERIC(14, 2) NOT NULL DEFAULT 0,
  custo_total_inicial    NUMERIC(16, 2) NOT NULL DEFAULT 0,
  prazo_entrega_inicial  INTEGER,
  prazo_pagamento_inicial INTEGER,
  -- Valores correntes, recalculados a cada rodada.
  valor_produtos_atual   NUMERIC(16, 2) NOT NULL DEFAULT 0,
  frete_atual            NUMERIC(14, 2) NOT NULL DEFAULT 0,
  impostos_atual         NUMERIC(14, 2) NOT NULL DEFAULT 0,
  outros_atual           NUMERIC(14, 2) NOT NULL DEFAULT 0,
  valor_bonificacao      NUMERIC(16, 2) NOT NULL DEFAULT 0,
  custo_total_atual      NUMERIC(16, 2) NOT NULL DEFAULT 0,
  prazo_entrega_atual    INTEGER,
  prazo_pagamento_atual  INTEGER,
  condicao_pagamento_id  BIGINT REFERENCES condicoes_pagamento (id),
  economia_potencial     NUMERIC(16, 2) NOT NULL DEFAULT 0,
  economia_negociada     NUMERIC(16, 2) NOT NULL DEFAULT 0,
  economia_percentual    NUMERIC(10, 4),
  -- Marca quando as condicoes mudaram tanto que a aprovacao da cotacao nao
  -- cobre mais o que esta sendo comprado (secao 23).
  desvio_relevante       BOOLEAN NOT NULL DEFAULT false,
  motivo_desvio          TEXT,
  acordada_em            TIMESTAMPTZ,
  aprovador_id           BIGINT REFERENCES usuarios (id),
  aprovado_em            TIMESTAMPTZ,
  nivel_aprovacao        TEXT,
  motivo_rejeicao        motivo_rejeicao_enum,
  justificativa_rejeicao TEXT,
  ordem_compra_id        BIGINT REFERENCES ordens_compra (id),
  observacao             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             BIGINT REFERENCES usuarios (id),
  CONSTRAINT ck_negociacao_valores CHECK (
    valor_produtos_inicial >= 0 AND custo_total_inicial >= 0
    AND valor_produtos_atual >= 0 AND custo_total_atual >= 0),
  CONSTRAINT ck_negociacao_datas CHECK (data_limite IS NULL OR data_limite >= data_abertura)
);
CREATE INDEX ix_negociacoes_compra_status ON negociacoes_compra (status, data_abertura DESC);
CREATE INDEX ix_negociacoes_compra_fornecedor ON negociacoes_compra (fornecedor_id);
CREATE INDEX ix_negociacoes_compra_cotacao ON negociacoes_compra (cotacao_id);

-- Uma negociacao nao pode virar dois pedidos oficiais (secoes 59 e 74).
CREATE UNIQUE INDEX uq_negociacao_ordem ON negociacoes_compra (ordem_compra_id)
  WHERE ordem_compra_id IS NOT NULL;

CREATE TRIGGER trg_negociacoes_compra_updated_at
  BEFORE UPDATE ON negociacoes_compra
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Itens da negociacao (valores correntes por produto)
-- ---------------------------------------------------------------------------
CREATE TABLE negociacao_itens (
  id                   BIGSERIAL PRIMARY KEY,
  negociacao_id        BIGINT NOT NULL REFERENCES negociacoes_compra (id) ON DELETE CASCADE,
  produto_id           BIGINT NOT NULL REFERENCES produtos (id) ON DELETE RESTRICT,
  cotacao_item_id      BIGINT REFERENCES cotacao_itens (id),
  necessidade_id       BIGINT REFERENCES necessidades_compra (id),
  unidade_id           BIGINT REFERENCES unidades (id),
  quantidade_inicial   NUMERIC(14, 3) NOT NULL,
  quantidade_atual     NUMERIC(14, 3) NOT NULL,
  quantidade_bonificada NUMERIC(14, 3) NOT NULL DEFAULT 0,
  preco_inicial        NUMERIC(14, 4) NOT NULL,
  preco_atual          NUMERIC(14, 4) NOT NULL,
  preco_alvo           NUMERIC(14, 4),
  preco_minimo_historico NUMERIC(14, 4),
  desconto             NUMERIC(14, 2) NOT NULL DEFAULT 0,
  frete_item           NUMERIC(14, 2) NOT NULL DEFAULT 0,
  impostos_item        NUMERIC(14, 2) NOT NULL DEFAULT 0,
  custo_total_inicial  NUMERIC(16, 2) NOT NULL DEFAULT 0,
  custo_total_atual    NUMERIC(16, 2) NOT NULL DEFAULT 0,
  economia             NUMERIC(16, 2) NOT NULL DEFAULT 0,
  economia_percentual  NUMERIC(10, 4),
  moq                  NUMERIC(14, 3),
  multiplo             NUMERIC(14, 3),
  prazo_entrega_dias   INTEGER,
  data_entrega         DATE,
  validade_dias        INTEGER,
  observacao           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_negociacao_item_qtd CHECK (
    quantidade_inicial > 0 AND quantidade_atual > 0 AND quantidade_bonificada >= 0),
  CONSTRAINT ck_negociacao_item_preco CHECK (preco_inicial >= 0 AND preco_atual >= 0),
  CONSTRAINT uq_negociacao_item UNIQUE (negociacao_id, produto_id)
);
CREATE INDEX ix_negociacao_itens_negociacao ON negociacao_itens (negociacao_id);

CREATE TRIGGER trg_negociacao_itens_updated_at
  BEFORE UPDATE ON negociacao_itens
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Rodadas - o historico que nunca e sobrescrito (secao 10)
-- ---------------------------------------------------------------------------
CREATE TABLE negociacao_rodadas (
  id                    BIGSERIAL PRIMARY KEY,
  negociacao_id         BIGINT NOT NULL REFERENCES negociacoes_compra (id) ON DELETE CASCADE,
  rodada                INTEGER NOT NULL,
  autor                 autor_rodada_enum NOT NULL,
  usuario_id            BIGINT REFERENCES usuarios (id),
  valor_produtos        NUMERIC(16, 2) NOT NULL DEFAULT 0,
  frete                 NUMERIC(14, 2) NOT NULL DEFAULT 0,
  impostos              NUMERIC(14, 2) NOT NULL DEFAULT 0,
  outros                NUMERIC(14, 2) NOT NULL DEFAULT 0,
  valor_bonificacao     NUMERIC(16, 2) NOT NULL DEFAULT 0,
  custo_total           NUMERIC(16, 2) NOT NULL DEFAULT 0,
  prazo_entrega_dias    INTEGER,
  prazo_pagamento_dias  INTEGER,
  economia_acumulada    NUMERIC(16, 2) NOT NULL DEFAULT 0,
  justificativa         TEXT,
  alteracoes            JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_negociacao_rodada UNIQUE (negociacao_id, rodada)
);
CREATE INDEX ix_negociacao_rodadas_negociacao ON negociacao_rodadas (negociacao_id, rodada);

CREATE OR REPLACE FUNCTION fn_rodada_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Rodada de negociacao e historico permanente e nao aceita alteracao nem exclusao';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_negociacao_rodadas_append_only
  BEFORE UPDATE OR DELETE ON negociacao_rodadas
  FOR EACH ROW EXECUTE FUNCTION fn_rodada_append_only();

-- A tabela NEGOCIACOES ja existia guardando preco anterior, preco negociado e
-- saving por item de cotacao. Ela vira o ITEM DA RODADA: mesma semantica, com
-- os vinculos que faltavam.
ALTER TABLE negociacoes
  ADD COLUMN negociacao_id        BIGINT REFERENCES negociacoes_compra (id) ON DELETE CASCADE,
  ADD COLUMN rodada_id            BIGINT REFERENCES negociacao_rodadas (id) ON DELETE CASCADE,
  ADD COLUMN negociacao_item_id   BIGINT REFERENCES negociacao_itens (id) ON DELETE CASCADE,
  ADD COLUMN produto_id           BIGINT REFERENCES produtos (id),
  ADD COLUMN quantidade_anterior  NUMERIC(14, 3),
  ADD COLUMN quantidade_negociada NUMERIC(14, 3),
  ADD COLUMN frete_anterior       NUMERIC(14, 2),
  ADD COLUMN frete_negociado      NUMERIC(14, 2),
  ADD COLUMN bonificacao          NUMERIC(14, 3),
  ADD COLUMN autor                autor_rodada_enum,
  ADD COLUMN saving_total         NUMERIC(16, 2);

CREATE INDEX ix_negociacoes_rodada ON negociacoes (rodada_id);
CREATE INDEX ix_negociacoes_negociacao ON negociacoes (negociacao_id);

-- ---------------------------------------------------------------------------
-- 5. Pedido de compra - campos que faltavam
-- ---------------------------------------------------------------------------
ALTER TABLE ordens_compra
  ADD COLUMN negociacao_id          BIGINT REFERENCES negociacoes_compra (id),
  ADD COLUMN requisicao_id          BIGINT REFERENCES requisicoes_compra (id),
  ADD COLUMN comprador_id           BIGINT REFERENCES usuarios (id),
  ADD COLUMN local_entrega_id       BIGINT REFERENCES locais (id),
  ADD COLUMN prioridade             prioridade_compra_enum NOT NULL DEFAULT 'MEDIA',
  ADD COLUMN data_necessaria        DATE,
  ADD COLUMN incoterm               incoterm_enum,
  ADD COLUMN taxa_cambio            NUMERIC(14, 6),
  ADD COLUMN data_taxa_cambio       DATE,
  ADD COLUMN seguro                 NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN desembaraco            NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN taxas                  NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN valor_bonificacao      NUMERIC(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN metodo_rateio_frete    metodo_rateio_frete_enum NOT NULL DEFAULT 'VALOR',
  ADD COLUMN economia_negociada     NUMERIC(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN economia_realizada     NUMERIC(16, 2) NOT NULL DEFAULT 0,
  ADD COLUMN economia_reconhecida_em TIMESTAMPTZ,
  ADD COLUMN nivel_aprovacao        TEXT,
  ADD COLUMN data_envio             TIMESTAMPTZ,
  ADD COLUMN canal_envio            TEXT,
  ADD COLUMN data_confirmacao       TIMESTAMPTZ,
  ADD COLUMN numero_pedido_fornecedor TEXT,
  ADD COLUMN data_prometida         DATE,
  ADD COLUMN motivo_cancelamento    motivo_cancelamento_enum,
  ADD COLUMN justificativa_cancelamento TEXT,
  ADD COLUMN cancelado_por          BIGINT REFERENCES usuarios (id),
  ADD COLUMN cancelado_em           TIMESTAMPTZ,
  ADD COLUMN motivo_rejeicao        motivo_rejeicao_enum,
  ADD COLUMN justificativa_rejeicao TEXT,
  ADD COLUMN excecoes               JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN validacoes             JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN alertas                JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX ix_ordens_compra_negociacao ON ordens_compra (negociacao_id);
CREATE INDEX ix_ordens_compra_fornecedor_status ON ordens_compra (fornecedor_id, status);
CREATE INDEX ix_ordens_compra_comprador ON ordens_compra (comprador_id);

ALTER TABLE ordem_compra_itens
  ADD COLUMN negociacao_item_id    BIGINT REFERENCES negociacao_itens (id),
  ADD COLUMN necessidade_id        BIGINT REFERENCES necessidades_compra (id),
  ADD COLUMN unidade_id            BIGINT REFERENCES unidades (id),
  ADD COLUMN preco_original        NUMERIC(14, 4),
  ADD COLUMN quantidade_bonificada NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN impostos              NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN frete_rateado         NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN moq                   NUMERIC(14, 3),
  ADD COLUMN multiplo              NUMERIC(14, 3),
  ADD COLUMN data_necessaria       DATE,
  ADD COLUMN data_prometida        DATE,
  ADD COLUMN quantidade_pendente   NUMERIC(14, 3);

-- ---------------------------------------------------------------------------
-- 6. Aprovacoes, alteracoes e confirmacoes
-- ---------------------------------------------------------------------------
CREATE TABLE pedido_aprovacoes (
  id              BIGSERIAL PRIMARY KEY,
  ordem_compra_id BIGINT NOT NULL REFERENCES ordens_compra (id) ON DELETE CASCADE,
  nivel           TEXT NOT NULL,
  perfil_exigido  TEXT,
  valor_avaliado  NUMERIC(16, 2) NOT NULL,
  status          status_aprovacao_enum NOT NULL DEFAULT 'PENDENTE',
  usuario_id      BIGINT REFERENCES usuarios (id),
  decidido_em     TIMESTAMPTZ,
  observacao      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_pedido_aprovacoes_pedido ON pedido_aprovacoes (ordem_compra_id, created_at);

CREATE TABLE pedido_alteracoes (
  id              BIGSERIAL PRIMARY KEY,
  ordem_compra_id BIGINT NOT NULL REFERENCES ordens_compra (id) ON DELETE CASCADE,
  campo           TEXT NOT NULL,
  item_id         BIGINT REFERENCES ordem_compra_itens (id) ON DELETE CASCADE,
  valor_anterior  TEXT,
  valor_novo      TEXT,
  motivo          TEXT NOT NULL,
  status          status_alteracao_pedido_enum NOT NULL DEFAULT 'SOLICITADA',
  exige_reaprovacao BOOLEAN NOT NULL DEFAULT false,
  solicitado_por  BIGINT REFERENCES usuarios (id),
  solicitado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decidido_por    BIGINT REFERENCES usuarios (id),
  decidido_em     TIMESTAMPTZ,
  observacao_decisao TEXT
);
CREATE INDEX ix_pedido_alteracoes_pedido ON pedido_alteracoes (ordem_compra_id, solicitado_em DESC);

CREATE TABLE pedido_confirmacoes (
  id                    BIGSERIAL PRIMARY KEY,
  ordem_compra_id       BIGINT NOT NULL REFERENCES ordens_compra (id) ON DELETE CASCADE,
  numero_pedido_fornecedor TEXT,
  canal                 TEXT,
  data_confirmacao      TIMESTAMPTZ NOT NULL DEFAULT now(),
  data_prometida        DATE,
  divergencias          JSONB NOT NULL DEFAULT '[]'::jsonb,
  observacao            TEXT,
  usuario_id            BIGINT REFERENCES usuarios (id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_pedido_confirmacoes_pedido ON pedido_confirmacoes (ordem_compra_id, data_confirmacao DESC);

-- Timeline: toda mudanca relevante do pedido, imutavel (secoes 48 e 81).
CREATE TABLE pedido_historico (
  id              BIGSERIAL PRIMARY KEY,
  ordem_compra_id BIGINT NOT NULL REFERENCES ordens_compra (id) ON DELETE CASCADE,
  evento          TEXT NOT NULL,
  status_anterior status_ordem_compra_enum,
  status_novo     status_ordem_compra_enum,
  descricao       TEXT,
  detalhes        JSONB,
  usuario_id      BIGINT REFERENCES usuarios (id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_pedido_historico_pedido ON pedido_historico (ordem_compra_id, created_at DESC);

CREATE OR REPLACE FUNCTION fn_pedido_historico_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Historico do pedido e permanente e nao aceita alteracao nem exclusao';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_pedido_historico_append_only
  BEFORE UPDATE OR DELETE ON pedido_historico
  FOR EACH ROW EXECUTE FUNCTION fn_pedido_historico_append_only();

-- Parcelas usam COMPROMISSOS_COMPRA, que ja existe. Faltavam so os campos de
-- percentual de entrada e vinculo com a condicao.
ALTER TABLE compromissos_compra
  ADD COLUMN condicao_pagamento_id BIGINT REFERENCES condicoes_pagamento (id),
  ADD COLUMN percentual            NUMERIC(8, 4),
  ADD COLUMN entrada               BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN centro_custo          TEXT,
  ADD COLUMN observacao            TEXT;

-- ---------------------------------------------------------------------------
-- 7. Parametros
-- ---------------------------------------------------------------------------
INSERT INTO configuracoes (chave, valor, tipo, grupo, descricao) VALUES
  ('pedido.prefixo_numero', 'PC', 'STRING', 'pedido',
   'Prefixo da numeracao do pedido de compra'),
  ('pedido.evento_economia_realizada', 'RECEBIDA', 'STRING', 'pedido',
   'Evento que consolida a economia como realizada: APROVADA, ENVIADA, CONFIRMADA ou RECEBIDA'),
  ('pedido.percentual_acima_necessidade', '20', 'NUMERO', 'pedido',
   'Percentual acima da necessidade planejada que dispara o alerta de compra excessiva'),
  ('pedido.exigir_justificativa_excesso', 'true', 'BOOLEANO', 'pedido',
   'Exigir justificativa para aprovar pedido acima da necessidade'),
  ('pedido.limite_cobertura_dias', '120', 'NUMERO', 'pedido',
   'Cobertura em dias apos a compra a partir da qual o pedido entra em risco de excesso'),
  ('pedido.percentual_alteracao_reaprovacao', '10', 'NUMERO', 'pedido',
   'Variacao percentual de valor que obriga nova aprovacao apos alteracao do pedido'),
  ('pedido.metodo_rateio_frete', 'VALOR', 'STRING', 'pedido',
   'Metodo padrao de rateio do frete entre os itens'),
  ('pedido.dias_negociacao_parada', '5', 'NUMERO', 'pedido',
   'Dias sem rodada a partir dos quais a negociacao e marcada como parada'),
  ('pedido.tolerancia_divergencia_percentual', '2', 'NUMERO', 'pedido',
   'Diferenca percentual entre pedido e confirmacao do fornecedor considerada relevante')
ON CONFLICT (chave) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8. Permissoes
-- ---------------------------------------------------------------------------
INSERT INTO permissoes (codigo, modulo, descricao) VALUES
  ('compras.negociar',        'compras',       'Criar e conduzir negociacoes com fornecedores'),
  ('compras.aprovar_negociacao', 'compras',    'Aprovar negociacao concluida'),
  ('ordens_compra.enviar',    'ordens_compra', 'Enviar pedido ao fornecedor e registrar confirmacao'),
  ('ordens_compra.alterar',   'ordens_compra', 'Solicitar alteracao de pedido aprovado'),
  ('ordens_compra.cancelar',  'ordens_compra', 'Cancelar pedido de compra')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo IN
  ('compras.negociar', 'compras.aprovar_negociacao', 'ordens_compra.enviar',
   'ordens_compra.alterar', 'ordens_compra.cancelar')
WHERE pf.nome IN ('ADMIN', 'GESTOR_COMPRAS')
ON CONFLICT DO NOTHING;

-- COMPRADOR negocia, cria pedido e solicita alteracao - nao aprova.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo IN
  ('compras.negociar', 'ordens_compra.enviar', 'ordens_compra.alterar')
WHERE pf.nome = 'COMPRADOR'
ON CONFLICT DO NOTHING;

-- DIRETORIA aprova conforme alcada.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo IN ('compras.aprovar_negociacao', 'ordens_compra.aprovar')
WHERE pf.nome = 'DIRETORIA'
ON CONFLICT DO NOTHING;

-- FINANCEIRO, ESTOQUE e QUALIDADE consultam.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo = 'ordens_compra.ler'
WHERE pf.nome IN ('FINANCEIRO', 'ESTOQUE', 'QUALIDADE')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 9. Rastreabilidade: a cadeia inteira numa consulta so (secao 46)
-- ---------------------------------------------------------------------------
CREATE VIEW vw_rastreabilidade_compra AS
SELECT
  oci.id                      AS ordem_compra_item_id,
  oc.id                       AS ordem_compra_id,
  oc.numero                   AS pedido,
  oc.status                   AS pedido_status,
  oc.data_emissao,
  f.id                        AS fornecedor_id,
  f.razao_social              AS fornecedor,
  p.id                        AS produto_id,
  p.codigo                    AS produto_codigo,
  p.descricao                 AS produto,
  oci.quantidade_pedida,
  oci.quantidade_confirmada,
  oci.quantidade_recebida,
  oci.preco_unitario,
  n.id                        AS negociacao_id,
  n.numero                    AS negociacao,
  n.rodada_atual,
  n.economia_negociada,
  c.id                        AS cotacao_id,
  c.numero                    AS cotacao,
  ci.id                       AS cotacao_item_id,
  ci.score                    AS cotacao_score,
  nc.id                       AS necessidade_id,
  nc.quantidade_sugerida      AS necessidade_quantidade,
  nc.prioridade               AS necessidade_prioridade,
  r.id                        AS requisicao_id,
  r.numero                    AS requisicao,
  pl.id                       AS planejamento_id,
  pl.numero                   AS planejamento
FROM ordem_compra_itens oci
JOIN ordens_compra oc         ON oc.id = oci.ordem_compra_id
JOIN fornecedores f           ON f.id = oc.fornecedor_id
JOIN produtos p               ON p.id = oci.produto_id
LEFT JOIN negociacoes_compra n ON n.id = oc.negociacao_id
LEFT JOIN cotacoes c          ON c.id = coalesce(oc.cotacao_id, n.cotacao_id)
LEFT JOIN cotacao_itens ci    ON ci.id = oci.cotacao_item_id
LEFT JOIN necessidades_compra nc ON nc.id = oci.necessidade_id
LEFT JOIN requisicoes_compra r ON r.id = coalesce(oc.requisicao_id, c.requisicao_id)
LEFT JOIN planejamentos_compra pl ON pl.id = nc.planejamento_id;
