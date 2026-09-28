-- ===========================================================================
-- MODULO 05 - Planejamento de compras e necessidade de compra
--
-- Reaproveita NECESSIDADES_COMPRA, PARAMETROS_ESTOQUE, PRODUTO_FORNECEDOR,
-- ESTOQUES, ORDENS_COMPRA e a vw_base_planejamento do modulo 04.
-- Cria: planejamento, requisicao, simulacao, alcada e historico de decisao.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Vocabulario do modulo
-- ---------------------------------------------------------------------------
CREATE TYPE estrategia_reposicao_enum AS ENUM (
  'PONTO_PEDIDO',      -- comprar quando disponivel <= ponto de pedido
  'ESTOQUE_MINIMO',    -- comprar quando projetado < minimo
  'ESTOQUE_MAXIMO',    -- repor ate o maximo
  'COBERTURA',         -- comprar para atingir N dias de cobertura
  'DEMANDA_LEAD_TIME', -- comprar a demanda do ciclo de abastecimento
  'MANUAL'
);

CREATE TYPE prioridade_compra_enum AS ENUM (
  'RUPTURA', 'CRITICA', 'ALTA', 'MEDIA', 'BAIXA', 'SEM_NECESSIDADE'
);

CREATE TYPE status_planejamento_enum AS ENUM (
  'EM_CALCULO', 'CALCULADO', 'EM_ANALISE', 'APROVADO', 'CANCELADO', 'FALHOU'
);

CREATE TYPE status_requisicao_enum AS ENUM (
  'RASCUNHO', 'AGUARDANDO_APROVACAO', 'APROVADA', 'REJEITADA',
  'ENVIADA_COTACAO', 'ATENDIDA', 'CANCELADA'
);

CREATE TYPE ciclo_compra_enum AS ENUM (
  'DIARIO', 'SEMANAL', 'QUINZENAL', 'MENSAL', 'SOB_DEMANDA'
);

CREATE TYPE origem_demanda_enum AS ENUM (
  'PREVISAO_VALIDADA', 'DEMANDA_MEDIA', 'PARAMETRO_MANUAL', 'SEM_BASE'
);

-- O fluxo do modulo 05 tem estados que o enum original nao previa.
-- PENDENTE continua valendo como "recem calculada".
ALTER TYPE status_necessidade_enum ADD VALUE IF NOT EXISTS 'REJEITADA';
ALTER TYPE status_necessidade_enum ADD VALUE IF NOT EXISTS 'AJUSTADA';
ALTER TYPE status_necessidade_enum ADD VALUE IF NOT EXISTS 'ATENDIDA';

-- ---------------------------------------------------------------------------
-- 2. Planejamento - uma execucao do calculo
-- ---------------------------------------------------------------------------
CREATE TABLE planejamentos_compra (
  id                  BIGSERIAL PRIMARY KEY,
  numero              TEXT NOT NULL UNIQUE,
  data_planejamento   DATE NOT NULL DEFAULT CURRENT_DATE,
  horizonte_dias      INTEGER NOT NULL,
  estrategia_padrao   estrategia_reposicao_enum NOT NULL DEFAULT 'PONTO_PEDIDO',
  local_id            BIGINT REFERENCES locais (id),
  status              status_planejamento_enum NOT NULL DEFAULT 'EM_CALCULO',
  parametros          JSONB NOT NULL DEFAULT '{}'::jsonb,
  produtos_analisados INTEGER NOT NULL DEFAULT 0,
  necessidades_geradas INTEGER NOT NULL DEFAULT 0,
  produtos_sem_necessidade INTEGER NOT NULL DEFAULT 0,
  valor_total_estimado NUMERIC(16, 2) NOT NULL DEFAULT 0,
  observacao          TEXT,
  erro_mensagem       TEXT,
  usuario_id          BIGINT REFERENCES usuarios (id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_planejamento_horizonte CHECK (horizonte_dias BETWEEN 1 AND 730)
);
CREATE INDEX ix_planejamentos_data ON planejamentos_compra (data_planejamento DESC);
CREATE INDEX ix_planejamentos_status ON planejamentos_compra (status);
CREATE TRIGGER trg_planejamentos_updated_at BEFORE UPDATE ON planejamentos_compra
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Necessidade de compra - tudo que o comprador precisa ver numa linha
--
-- A tabela ja existia com 7 campos. O modulo 05 exige que cada numero possa ser
-- explicado (secao 49: "como essa quantidade foi calculada?"), entao cada
-- parcela da conta vira coluna. `urgencia` era do vocabulario de alertas e a
-- tabela estava vazia: trocada por `prioridade`, o vocabulario do planejamento.
-- ---------------------------------------------------------------------------
ALTER TABLE necessidades_compra DROP COLUMN urgencia;

ALTER TABLE necessidades_compra
  ADD COLUMN planejamento_id     BIGINT REFERENCES planejamentos_compra (id) ON DELETE CASCADE,
  ADD COLUMN fornecedor_id       BIGINT REFERENCES fornecedores (id),
  ADD COLUMN local_id            BIGINT REFERENCES locais (id),
  ADD COLUMN prioridade          prioridade_compra_enum NOT NULL DEFAULT 'SEM_NECESSIDADE',
  ADD COLUMN estrategia          estrategia_reposicao_enum NOT NULL DEFAULT 'PONTO_PEDIDO',
  ADD COLUMN horizonte_dias      INTEGER NOT NULL DEFAULT 30,
  -- parcelas da conta
  ADD COLUMN demanda_periodo     NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN demanda_diaria      NUMERIC(14, 4) NOT NULL DEFAULT 0,
  ADD COLUMN demanda_lead_time   NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN origem_demanda      origem_demanda_enum NOT NULL DEFAULT 'SEM_BASE',
  ADD COLUMN entradas_confirmadas NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN estoque_alvo        NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN ponto_pedido        NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN estoque_maximo      NUMERIC(14, 3),
  ADD COLUMN necessidade_bruta   NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN necessidade_calculada NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN moq                 NUMERIC(14, 3),
  ADD COLUMN multiplo_compra     NUMERIC(14, 3),
  ADD COLUMN quantidade_sistema  NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN unidade_compra_id   BIGINT REFERENCES unidades (id),
  ADD COLUMN fator_conversao     NUMERIC(14, 4) NOT NULL DEFAULT 1,
  ADD COLUMN quantidade_unidade_compra NUMERIC(14, 3),
  -- prazos
  ADD COLUMN lead_time_dias      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN lead_time_total_dias INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN data_necessaria     DATE,
  ADD COLUMN data_ideal_compra   DATE,
  ADD COLUMN data_prevista_chegada DATE,
  ADD COLUMN dias_cobertura      NUMERIC(10, 2),
  -- financeiro
  ADD COLUMN preco_estimado      NUMERIC(14, 4),
  ADD COLUMN valor_estimado      NUMERIC(16, 2),
  ADD COLUMN frete_estimado      NUMERIC(14, 2),
  ADD COLUMN custo_total_estimado NUMERIC(16, 2),
  -- sinalizacoes
  ADD COLUMN compra_em_aberto    NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN pedido_atrasado     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN excesso             NUMERIC(14, 3),
  ADD COLUMN transferencia_possivel NUMERIC(14, 3),
  ADD COLUMN transferencia_local_id BIGINT REFERENCES locais (id),
  ADD COLUMN previsao_confiabilidade TEXT,
  ADD COLUMN indice_prioridade   NUMERIC(10, 4) NOT NULL DEFAULT 0,
  ADD COLUMN fatores_prioridade  JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN memoria_calculo     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN alertas             JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN justificativa       TEXT,
  ADD COLUMN aprovado_por        BIGINT REFERENCES usuarios (id),
  ADD COLUMN aprovado_em         TIMESTAMPTZ;

ALTER TABLE necessidades_compra ALTER COLUMN status SET DEFAULT 'PENDENTE';

CREATE INDEX IF NOT EXISTS ix_necessidades_planejamento ON necessidades_compra (planejamento_id);
CREATE INDEX IF NOT EXISTS ix_necessidades_prioridade ON necessidades_compra (prioridade, indice_prioridade DESC);
CREATE INDEX IF NOT EXISTS ix_necessidades_fornecedor ON necessidades_compra (fornecedor_id);
-- ix_necessidades_status ja existe desde a migration 006.
CREATE UNIQUE INDEX uq_necessidade_planejamento_produto
  ON necessidades_compra (planejamento_id, produto_id, coalesce(local_id, 0));

-- ---------------------------------------------------------------------------
-- 4. Historico da decisao (secao 34 e 45)
-- ---------------------------------------------------------------------------
CREATE TABLE necessidade_historico (
  id                 BIGSERIAL PRIMARY KEY,
  necessidade_id     BIGINT NOT NULL REFERENCES necessidades_compra (id) ON DELETE CASCADE,
  status_anterior    status_necessidade_enum,
  status_novo        status_necessidade_enum NOT NULL,
  quantidade_anterior NUMERIC(14, 3),
  quantidade_nova    NUMERIC(14, 3),
  fornecedor_anterior BIGINT REFERENCES fornecedores (id),
  fornecedor_novo    BIGINT REFERENCES fornecedores (id),
  justificativa      TEXT,
  usuario_id         BIGINT REFERENCES usuarios (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_necessidade_historico ON necessidade_historico (necessidade_id, created_at DESC);

-- O historico nao se reescreve.
CREATE OR REPLACE FUNCTION fn_historico_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Historico de necessidade e permanente e nao pode ser alterado nem apagado';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_necessidade_historico_append_only
  BEFORE UPDATE OR DELETE ON necessidade_historico
  FOR EACH ROW EXECUTE FUNCTION fn_historico_append_only();

-- ---------------------------------------------------------------------------
-- 5. Requisicao de compra - a ponte para o modulo 06
-- ---------------------------------------------------------------------------
CREATE TABLE requisicoes_compra (
  id                 BIGSERIAL PRIMARY KEY,
  numero             TEXT NOT NULL UNIQUE,
  data_requisicao    DATE NOT NULL DEFAULT CURRENT_DATE,
  planejamento_id    BIGINT REFERENCES planejamentos_compra (id),
  fornecedor_sugerido_id BIGINT REFERENCES fornecedores (id),
  local_id           BIGINT REFERENCES locais (id),
  solicitante_id     BIGINT REFERENCES usuarios (id),
  comprador_id       BIGINT REFERENCES usuarios (id),
  prioridade         prioridade_compra_enum NOT NULL DEFAULT 'MEDIA',
  data_necessaria    DATE,
  valor_estimado     NUMERIC(16, 2) NOT NULL DEFAULT 0,
  status             status_requisicao_enum NOT NULL DEFAULT 'RASCUNHO',
  nivel_aprovacao    TEXT,
  aprovador_id       BIGINT REFERENCES usuarios (id),
  aprovado_em        TIMESTAMPTZ,
  motivo_rejeicao    TEXT,
  observacao         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         BIGINT REFERENCES usuarios (id),
  CONSTRAINT ck_requisicao_valor CHECK (valor_estimado >= 0)
);
CREATE INDEX ix_requisicoes_status ON requisicoes_compra (status, data_requisicao DESC);
CREATE INDEX ix_requisicoes_fornecedor ON requisicoes_compra (fornecedor_sugerido_id);
CREATE TRIGGER trg_requisicoes_updated_at BEFORE UPDATE ON requisicoes_compra
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TABLE requisicao_compra_itens (
  id                 BIGSERIAL PRIMARY KEY,
  requisicao_id      BIGINT NOT NULL REFERENCES requisicoes_compra (id) ON DELETE CASCADE,
  produto_id         BIGINT NOT NULL REFERENCES produtos (id),
  necessidade_id     BIGINT REFERENCES necessidades_compra (id),
  fornecedor_id      BIGINT REFERENCES fornecedores (id),
  quantidade         NUMERIC(14, 3) NOT NULL,
  unidade_id         BIGINT REFERENCES unidades (id),
  quantidade_original NUMERIC(14, 3),
  preco_estimado     NUMERIC(14, 4),
  valor_estimado     NUMERIC(16, 2),
  data_necessaria    DATE,
  justificativa      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_requisicao_item_qtd CHECK (quantidade > 0),
  CONSTRAINT uq_requisicao_item UNIQUE (requisicao_id, produto_id)
);
CREATE INDEX ix_requisicao_itens_produto ON requisicao_compra_itens (produto_id);
CREATE INDEX ix_requisicao_itens_necessidade ON requisicao_compra_itens (necessidade_id);

-- ---------------------------------------------------------------------------
-- 6. Simulacao - cenarios que nunca tocam o planejamento oficial
-- ---------------------------------------------------------------------------
CREATE TABLE simulacoes_compra (
  id                 BIGSERIAL PRIMARY KEY,
  nome               TEXT NOT NULL,
  tipo_cenario       TEXT NOT NULL DEFAULT 'PERSONALIZADO',
  planejamento_base_id BIGINT REFERENCES planejamentos_compra (id),
  ajustes            JSONB NOT NULL DEFAULT '{}'::jsonb,
  horizonte_dias     INTEGER NOT NULL,
  produtos_analisados INTEGER NOT NULL DEFAULT 0,
  itens_com_necessidade INTEGER NOT NULL DEFAULT 0,
  quantidade_total   NUMERIC(16, 3) NOT NULL DEFAULT 0,
  valor_total        NUMERIC(16, 2) NOT NULL DEFAULT 0,
  produtos_risco_ruptura INTEGER NOT NULL DEFAULT 0,
  produtos_excesso   INTEGER NOT NULL DEFAULT 0,
  usuario_id         BIGINT REFERENCES usuarios (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_simulacoes_data ON simulacoes_compra (created_at DESC);

CREATE TABLE simulacao_compra_itens (
  id                 BIGSERIAL PRIMARY KEY,
  simulacao_id       BIGINT NOT NULL REFERENCES simulacoes_compra (id) ON DELETE CASCADE,
  produto_id         BIGINT NOT NULL REFERENCES produtos (id),
  fornecedor_id      BIGINT REFERENCES fornecedores (id),
  demanda_periodo    NUMERIC(14, 3) NOT NULL DEFAULT 0,
  estoque_disponivel NUMERIC(14, 3) NOT NULL DEFAULT 0,
  necessidade_calculada NUMERIC(14, 3) NOT NULL DEFAULT 0,
  quantidade_sugerida NUMERIC(14, 3) NOT NULL DEFAULT 0,
  valor_estimado     NUMERIC(16, 2),
  prioridade         prioridade_compra_enum NOT NULL DEFAULT 'SEM_NECESSIDADE',
  dias_cobertura     NUMERIC(10, 2),
  CONSTRAINT uq_simulacao_item UNIQUE (simulacao_id, produto_id)
);

-- ---------------------------------------------------------------------------
-- 7. Alcada de aprovacao (secao 57) - configuravel, nunca fixa no codigo
-- ---------------------------------------------------------------------------
CREATE TABLE alcadas_aprovacao (
  id             BIGSERIAL PRIMARY KEY,
  nome           TEXT NOT NULL UNIQUE,
  perfil_id      BIGINT NOT NULL REFERENCES perfis (id),
  valor_minimo   NUMERIC(16, 2) NOT NULL DEFAULT 0,
  valor_maximo   NUMERIC(16, 2),
  ordem          INTEGER NOT NULL DEFAULT 1,
  ativo          BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_alcada_faixa CHECK (valor_maximo IS NULL OR valor_maximo > valor_minimo)
);
CREATE TRIGGER trg_alcadas_updated_at BEFORE UPDATE ON alcadas_aprovacao
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

INSERT INTO alcadas_aprovacao (nome, perfil_id, valor_minimo, valor_maximo, ordem)
SELECT 'Comprador', p.id, 0, 10000, 1 FROM perfis p WHERE p.nome = 'COMPRADOR'
UNION ALL
SELECT 'Gestor de compras', p.id, 10000, 50000, 2 FROM perfis p WHERE p.nome = 'GESTOR_COMPRAS'
UNION ALL
SELECT 'Diretoria', p.id, 50000, NULL, 3 FROM perfis p WHERE p.nome = 'DIRETORIA'
ON CONFLICT (nome) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8. Parametros por produto que o planejamento precisa
-- ---------------------------------------------------------------------------
ALTER TABLE parametros_estoque
  ADD COLUMN IF NOT EXISTS estrategia_reposicao estrategia_reposicao_enum NOT NULL DEFAULT 'PONTO_PEDIDO',
  ADD COLUMN IF NOT EXISTS cobertura_alvo_dias INTEGER,
  ADD COLUMN IF NOT EXISTS ciclo_compra ciclo_compra_enum NOT NULL DEFAULT 'SOB_DEMANDA',
  ADD COLUMN IF NOT EXISTS dias_seguranca INTEGER,
  ADD COLUMN IF NOT EXISTS metodo_estoque_seguranca TEXT NOT NULL DEFAULT 'DIAS_COBERTURA',
  ADD COLUMN IF NOT EXISTS calculado_em TIMESTAMPTZ;

-- Lead time total de importacao (secao 30): a composicao fica no fornecedor,
-- que e quem tem transporte internacional e desembaraco.
ALTER TABLE fornecedores
  ADD COLUMN IF NOT EXISTS transit_time_dias INTEGER,
  ADD COLUMN IF NOT EXISTS desembaraco_dias INTEGER,
  ADD COLUMN IF NOT EXISTS recebimento_dias INTEGER,
  ADD COLUMN IF NOT EXISTS incoterm TEXT,
  ADD COLUMN IF NOT EXISTS porto_origem TEXT;

-- ---------------------------------------------------------------------------
-- 9. Parametros gerais do planejamento
-- ---------------------------------------------------------------------------
INSERT INTO configuracoes (chave, valor, tipo, grupo, descricao) VALUES
  ('planejamento.horizonte_padrao_dias', '30',   'NUMERO',   'planejamento', 'Horizonte padrao do planejamento em dias'),
  ('planejamento.estrategia_padrao', 'PONTO_PEDIDO', 'STRING', 'planejamento', 'Estrategia de reposicao usada quando o produto nao define a sua'),
  ('planejamento.dias_seguranca_padrao', '7',    'NUMERO',   'planejamento', 'Dias de cobertura usados como estoque de seguranca quando nao ha parametro'),
  ('planejamento.cobertura_alvo_dias', '45',     'NUMERO',   'planejamento', 'Dias de cobertura alvo na estrategia COBERTURA'),
  ('planejamento.lead_time_padrao_dias', '15',   'NUMERO',   'planejamento', 'Lead time assumido quando produto e fornecedor nao informam'),
  ('planejamento.dias_recebimento', '2',         'NUMERO',   'planejamento', 'Dias entre a chegada e a disponibilidade no estoque'),
  ('planejamento.usar_dias_uteis', 'false',      'BOOLEANO', 'planejamento', 'Contar o lead time em dias uteis em vez de corridos'),
  ('planejamento.limite_excesso_cobertura', '120', 'NUMERO', 'planejamento', 'Dias de cobertura acima dos quais o item e marcado como excesso'),
  ('planejamento.considerar_transferencia', 'true', 'BOOLEANO', 'planejamento', 'Sinalizar quando outro local pode atender a necessidade'),
  ('planejamento.bloquear_compra_com_excesso', 'true', 'BOOLEANO', 'planejamento', 'Nao sugerir compra para item em excesso sem justificativa'),
  ('planejamento.dias_atraso_alerta', '3',       'NUMERO',   'planejamento', 'Dias de atraso a partir dos quais o pedido em aberto e considerado atrasado'),
  ('planejamento.peso_ruptura', '40',            'NUMERO',   'planejamento', 'Peso da ruptura no indice de prioridade'),
  ('planejamento.peso_cobertura', '25',          'NUMERO',   'planejamento', 'Peso da cobertura no indice de prioridade'),
  ('planejamento.peso_abc', '20',                'NUMERO',   'planejamento', 'Peso da curva ABC no indice de prioridade'),
  ('planejamento.peso_lead_time', '15',          'NUMERO',   'planejamento', 'Peso do lead time no indice de prioridade')
ON CONFLICT (chave) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 10. Permissoes
-- ---------------------------------------------------------------------------
INSERT INTO permissoes (codigo, modulo, descricao) VALUES
  ('compras.planejar',  'compras', 'Executar o calculo de necessidade de compra'),
  ('compras.aprovar',   'compras', 'Aprovar necessidades e requisicoes dentro da alcada'),
  ('compras.requisitar','compras', 'Gerar requisicao de compra a partir das necessidades'),
  ('compras.simular',   'compras', 'Criar e comparar cenarios de simulacao')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo IN ('compras.planejar', 'compras.aprovar', 'compras.requisitar', 'compras.simular')
WHERE pf.nome IN ('ADMIN', 'GESTOR_COMPRAS')
ON CONFLICT DO NOTHING;

INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo IN ('compras.planejar', 'compras.requisitar', 'compras.simular')
WHERE pf.nome = 'COMPRADOR'
ON CONFLICT DO NOTHING;

INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo IN ('compras.aprovar')
WHERE pf.nome = 'DIRETORIA'
ON CONFLICT DO NOTHING;
