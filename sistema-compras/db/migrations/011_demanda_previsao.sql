-- ===========================================================================
-- MODULO 04 - Analise de vendas, demanda, sazonalidade e previsao
--
-- Reaproveita VENDAS, ITENS_VENDA, PREVISOES_DEMANDA e PARAMETROS_ESTOQUE.
-- Cria apenas o que faltava: governanca da previsao, sazonalidade, outliers,
-- demanda reprimida, calendario e agregados de performance.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Documento de venda x documento de devolucao
--
-- A quantidade continua sempre positiva (ck_itens_venda_qtd segue valendo).
-- Quem carrega o sinal e o tipo do documento, e a demanda liquida sai de
-- VENDA menos DEVOLUCAO. Isso evita contar devolucao duas vezes.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tipo_documento_venda_enum') THEN
    CREATE TYPE tipo_documento_venda_enum AS ENUM ('VENDA', 'DEVOLUCAO');
  END IF;
END $$;

ALTER TABLE vendas
  ADD COLUMN IF NOT EXISTS tipo_documento tipo_documento_venda_enum NOT NULL DEFAULT 'VENDA';

CREATE INDEX IF NOT EXISTS ix_vendas_data_tipo ON vendas (data_venda, tipo_documento);
CREATE INDEX IF NOT EXISTS ix_itens_venda_produto_venda ON itens_venda (produto_id, venda_id);

-- ---------------------------------------------------------------------------
-- 2. Metodos de previsao que faltavam no enum existente
-- ---------------------------------------------------------------------------
ALTER TYPE metodo_previsao_enum ADD VALUE IF NOT EXISTS 'MEDIA_SIMPLES';
ALTER TYPE metodo_previsao_enum ADD VALUE IF NOT EXISTS 'SUAVIZACAO_EXPONENCIAL';
ALTER TYPE metodo_previsao_enum ADD VALUE IF NOT EXISTS 'COMBINADO';
ALTER TYPE metodo_previsao_enum ADD VALUE IF NOT EXISTS 'MANUAL';

CREATE TYPE confiabilidade_previsao_enum AS ENUM ('ALTA', 'MEDIA', 'BAIXA', 'INSUFICIENTE');
CREATE TYPE origem_previsao_enum AS ENUM ('CALCULADA', 'MANUAL', 'PRODUTO_SIMILAR', 'MEDIA_CATEGORIA');
CREATE TYPE status_execucao_previsao_enum AS ENUM ('EM_ANDAMENTO', 'CONCLUIDA', 'FALHOU', 'CANCELADA');
CREATE TYPE tendencia_enum AS ENUM ('CRESCIMENTO', 'ESTAVEL', 'QUEDA', 'INDETERMINADA');
CREATE TYPE classificacao_reprimida_enum AS ENUM ('POSSIVEL', 'PROVAVEL', 'CONFIRMADA');
CREATE TYPE tratamento_outlier_enum AS ENUM ('PENDENTE', 'MANTER', 'EXCLUIR', 'TRATAR_SEPARADO');
CREATE TYPE tipo_evento_calendario_enum AS ENUM
  ('FERIADO', 'DATA_COMEMORATIVA', 'CAMPANHA', 'PROMOCAO', 'EVENTO', 'SEM_OPERACAO');

-- ---------------------------------------------------------------------------
-- 3. Execucoes de previsao - quem rodou, quando, com quais parametros
-- ---------------------------------------------------------------------------
CREATE TABLE execucoes_previsao (
  id                BIGSERIAL PRIMARY KEY,
  disparada_por     TEXT NOT NULL DEFAULT 'MANUAL',      -- MANUAL | AGENDADA | API
  usuario_id        BIGINT REFERENCES usuarios (id),
  status            status_execucao_previsao_enum NOT NULL DEFAULT 'EM_ANDAMENTO',
  periodo_inicio    DATE NOT NULL,
  periodo_fim       DATE NOT NULL,
  horizonte_dias    INTEGER NOT NULL,
  metodo_solicitado metodo_previsao_enum,
  parametros        JSONB NOT NULL DEFAULT '{}'::jsonb,
  produtos_avaliados INTEGER NOT NULL DEFAULT 0,
  previsoes_geradas  INTEGER NOT NULL DEFAULT 0,
  produtos_sem_historico INTEGER NOT NULL DEFAULT 0,
  erro_mensagem     TEXT,
  iniciada_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluida_em      TIMESTAMPTZ,
  CONSTRAINT ck_execucoes_previsao_periodo CHECK (periodo_fim >= periodo_inicio),
  CONSTRAINT ck_execucoes_previsao_horizonte CHECK (horizonte_dias BETWEEN 1 AND 730)
);
CREATE INDEX ix_execucoes_previsao_status ON execucoes_previsao (status, iniciada_em DESC);

-- ---------------------------------------------------------------------------
-- 4. Previsoes: governanca, intervalo, metricas e comparacao com o realizado
-- ---------------------------------------------------------------------------
ALTER TABLE previsoes_demanda
  ADD COLUMN execucao_id         BIGINT REFERENCES execucoes_previsao (id),
  ADD COLUMN versao              INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN origem              origem_previsao_enum NOT NULL DEFAULT 'CALCULADA',
  ADD COLUMN limite_inferior     NUMERIC(14, 3),
  ADD COLUMN limite_superior     NUMERIC(14, 3),
  ADD COLUMN demanda_diaria      NUMERIC(14, 4),
  ADD COLUMN tendencia           tendencia_enum NOT NULL DEFAULT 'INDETERMINADA',
  ADD COLUMN sazonal             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN indice_sazonal      NUMERIC(8, 4),
  ADD COLUMN meses_historico     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN confiabilidade      confiabilidade_previsao_enum NOT NULL DEFAULT 'INSUFICIENTE',
  ADD COLUMN mae                 NUMERIC(14, 4),
  ADD COLUMN mape                NUMERIC(8, 4),
  ADD COLUMN rmse                NUMERIC(14, 4),
  ADD COLUMN explicacao          TEXT,
  ADD COLUMN justificativa       TEXT,
  ADD COLUMN realizado           NUMERIC(14, 3),
  ADD COLUMN erro_percentual     NUMERIC(10, 4),
  ADD COLUMN avaliado_em         TIMESTAMPTZ;

CREATE INDEX ix_previsoes_produto_periodo ON previsoes_demanda (produto_id, periodo_inicio DESC);
CREATE INDEX ix_previsoes_execucao ON previsoes_demanda (execucao_id);
CREATE UNIQUE INDEX uq_previsoes_versao
  ON previsoes_demanda (produto_id, periodo_inicio, periodo_fim, versao);

-- O historico de previsao nao e reescrito. So o confronto com o realizado
-- pode ser preenchido depois que o periodo acontece.
CREATE OR REPLACE FUNCTION fn_previsao_append_only() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Previsao nao pode ser apagada. O historico de previsoes e permanente';
  END IF;

  IF NEW.produto_id IS DISTINCT FROM OLD.produto_id
     OR NEW.periodo_inicio IS DISTINCT FROM OLD.periodo_inicio
     OR NEW.periodo_fim IS DISTINCT FROM OLD.periodo_fim
     OR NEW.demanda_prevista IS DISTINCT FROM OLD.demanda_prevista
     OR NEW.metodo IS DISTINCT FROM OLD.metodo
     OR NEW.versao IS DISTINCT FROM OLD.versao
     OR NEW.parametros IS DISTINCT FROM OLD.parametros THEN
    RAISE EXCEPTION 'Previsao ja gravada nao pode ser alterada. Gere uma nova versao';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_previsoes_append_only
  BEFORE UPDATE OR DELETE ON previsoes_demanda
  FOR EACH ROW EXECUTE FUNCTION fn_previsao_append_only();

-- ---------------------------------------------------------------------------
-- 5. Sazonalidade - indice por produto e mes do ciclo
-- ---------------------------------------------------------------------------
CREATE TABLE indices_sazonais (
  id                BIGSERIAL PRIMARY KEY,
  produto_id        BIGINT NOT NULL REFERENCES produtos (id) ON DELETE CASCADE,
  mes               SMALLINT NOT NULL,
  indice            NUMERIC(8, 4) NOT NULL,
  demanda_media_mes NUMERIC(14, 3) NOT NULL,
  demanda_media_ciclo NUMERIC(14, 3) NOT NULL,
  ciclos_observados INTEGER NOT NULL,
  meses_historico   INTEGER NOT NULL,
  confirmado        BOOLEAN NOT NULL DEFAULT false,   -- false = "possivel sazonalidade"
  calculado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_indices_sazonais_mes CHECK (mes BETWEEN 1 AND 12),
  CONSTRAINT ck_indices_sazonais_indice CHECK (indice >= 0),
  CONSTRAINT uq_indices_sazonais UNIQUE (produto_id, mes)
);
CREATE INDEX ix_indices_sazonais_produto ON indices_sazonais (produto_id);

-- ---------------------------------------------------------------------------
-- 6. Outliers - identificados, nunca descartados sozinhos
-- ---------------------------------------------------------------------------
CREATE TABLE vendas_outliers (
  id              BIGSERIAL PRIMARY KEY,
  produto_id      BIGINT NOT NULL REFERENCES produtos (id) ON DELETE CASCADE,
  data_venda      DATE NOT NULL,
  quantidade      NUMERIC(14, 3) NOT NULL,
  media_periodo   NUMERIC(14, 3) NOT NULL,
  desvio_padrao   NUMERIC(14, 4),
  z_score         NUMERIC(10, 4),
  tratamento      tratamento_outlier_enum NOT NULL DEFAULT 'PENDENTE',
  justificativa   TEXT,
  decidido_por    BIGINT REFERENCES usuarios (id),
  decidido_em     TIMESTAMPTZ,
  detectado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_vendas_outliers UNIQUE (produto_id, data_venda)
);
CREATE INDEX ix_vendas_outliers_tratamento ON vendas_outliers (tratamento, produto_id);

-- ---------------------------------------------------------------------------
-- 7. Demanda reprimida - estimativa, nunca "venda perdida confirmada"
-- ---------------------------------------------------------------------------
CREATE TABLE demanda_reprimida (
  id                   BIGSERIAL PRIMARY KEY,
  produto_id           BIGINT NOT NULL REFERENCES produtos (id) ON DELETE CASCADE,
  periodo_inicio       DATE NOT NULL,
  periodo_fim          DATE NOT NULL,
  dias_ruptura         INTEGER NOT NULL,
  media_diaria_antes   NUMERIC(14, 4) NOT NULL,
  demanda_estimada     NUMERIC(14, 3) NOT NULL,
  preco_medio          NUMERIC(14, 4),
  valor_estimado       NUMERIC(16, 2),
  classificacao        classificacao_reprimida_enum NOT NULL DEFAULT 'POSSIVEL',
  evidencias           JSONB NOT NULL DEFAULT '[]'::jsonb,
  observacao           TEXT,
  detectado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_demanda_reprimida_periodo CHECK (periodo_fim >= periodo_inicio),
  CONSTRAINT ck_demanda_reprimida_dias CHECK (dias_ruptura > 0),
  CONSTRAINT uq_demanda_reprimida UNIQUE (produto_id, periodo_inicio)
);
CREATE INDEX ix_demanda_reprimida_produto ON demanda_reprimida (produto_id, periodo_inicio DESC);

-- ---------------------------------------------------------------------------
-- 8. Calendario - feriados, campanhas e periodos sem operacao
-- ---------------------------------------------------------------------------
CREATE TABLE calendario_eventos (
  id             BIGSERIAL PRIMARY KEY,
  nome           TEXT NOT NULL,
  tipo           tipo_evento_calendario_enum NOT NULL,
  data_inicio    DATE NOT NULL,
  data_fim       DATE NOT NULL,
  produto_id     BIGINT REFERENCES produtos (id) ON DELETE CASCADE,
  categoria_id   BIGINT REFERENCES categorias (id) ON DELETE CASCADE,
  desconto_percentual NUMERIC(6, 2),
  observacao     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT REFERENCES usuarios (id),
  CONSTRAINT ck_calendario_periodo CHECK (data_fim >= data_inicio)
);
CREATE INDEX ix_calendario_periodo ON calendario_eventos (data_inicio, data_fim);
CREATE INDEX ix_calendario_tipo ON calendario_eventos (tipo);

-- ---------------------------------------------------------------------------
-- 9. Agregados - o dashboard nunca varre itens_venda linha a linha
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_demanda_diaria AS
SELECT
  iv.produto_id,
  v.data_venda,
  sum(CASE WHEN v.tipo_documento = 'DEVOLUCAO' THEN -iv.quantidade ELSE iv.quantidade END) AS quantidade,
  sum(CASE WHEN v.tipo_documento = 'DEVOLUCAO' THEN -iv.valor_total ELSE iv.valor_total END) AS valor,
  count(DISTINCT v.id) AS documentos,
  count(DISTINCT v.cliente_id) AS clientes
FROM itens_venda iv
JOIN vendas v ON v.id = iv.venda_id
WHERE v.status <> 'CANCELADA'
GROUP BY iv.produto_id, v.data_venda;

CREATE UNIQUE INDEX uq_mv_demanda_diaria ON mv_demanda_diaria (produto_id, data_venda);
CREATE INDEX ix_mv_demanda_diaria_data ON mv_demanda_diaria (data_venda);

CREATE MATERIALIZED VIEW mv_demanda_mensal AS
SELECT
  produto_id,
  date_trunc('month', data_venda)::date AS mes,
  sum(quantidade) AS quantidade,
  sum(valor) AS valor,
  sum(documentos) AS documentos,
  count(*) AS dias_com_venda
FROM mv_demanda_diaria
GROUP BY produto_id, date_trunc('month', data_venda)::date;

CREATE UNIQUE INDEX uq_mv_demanda_mensal ON mv_demanda_mensal (produto_id, mes);
CREATE INDEX ix_mv_demanda_mensal_mes ON mv_demanda_mensal (mes);

-- ---------------------------------------------------------------------------
-- 10. Base para o modulo 05 - tudo que o planejamento precisa, em uma linha
-- ---------------------------------------------------------------------------
CREATE VIEW vw_base_planejamento AS
WITH ultima_previsao AS (
  SELECT DISTINCT ON (produto_id)
         produto_id, demanda_prevista, demanda_diaria, periodo_inicio, periodo_fim,
         metodo, confiabilidade, tendencia, sazonal, created_at
  FROM previsoes_demanda
  ORDER BY produto_id, periodo_inicio DESC, versao DESC
),
saldo AS (
  SELECT produto_id,
         sum(quantidade_fisica)     AS estoque_fisico,
         sum(quantidade_reservada)  AS estoque_reservado,
         sum(quantidade_disponivel) AS estoque_disponivel,
         sum(quantidade_em_transito) AS estoque_em_transito
  FROM estoques
  GROUP BY produto_id
),
historico AS (
  SELECT produto_id,
         sum(quantidade) FILTER (WHERE data_venda >= CURRENT_DATE - 90)  AS qtd_90d,
         sum(quantidade) FILTER (WHERE data_venda >= CURRENT_DATE - 365) AS qtd_365d,
         max(data_venda) AS ultima_venda
  FROM mv_demanda_diaria
  GROUP BY produto_id
)
SELECT
  p.id                                    AS produto_id,
  p.codigo,
  p.descricao,
  p.categoria_id,
  p.classificacao_abc,
  p.classificacao_xyz,
  p.peso,
  coalesce(s.estoque_fisico, 0)           AS estoque_fisico,
  coalesce(s.estoque_reservado, 0)        AS estoque_reservado,
  coalesce(s.estoque_disponivel, 0)       AS estoque_disponivel,
  coalesce(s.estoque_em_transito, 0)      AS estoque_em_transito,
  coalesce(h.qtd_90d, 0) / 90.0           AS demanda_diaria_90d,
  coalesce(h.qtd_365d, 0)                 AS demanda_365d,
  h.ultima_venda,
  up.demanda_prevista,
  up.demanda_diaria                       AS demanda_diaria_prevista,
  up.periodo_inicio                       AS previsao_periodo_inicio,
  up.periodo_fim                          AS previsao_periodo_fim,
  up.metodo                               AS previsao_metodo,
  up.confiabilidade                       AS previsao_confiabilidade,
  up.tendencia,
  up.sazonal,
  up.created_at                           AS previsao_calculada_em,
  pe.lead_time_dias,
  pe.estoque_seguranca,
  pe.ponto_pedido,
  pe.estoque_minimo,
  pe.estoque_maximo,
  pe.moq                                  AS moq_parametro,
  pe.multiplo_compra                      AS multiplo_parametro,
  pe.horizonte_planejamento_dias,
  p.moq                                   AS moq_produto,
  p.multiplo_compra                       AS multiplo_produto,
  p.lead_time_padrao_dias
FROM produtos p
LEFT JOIN saldo s            ON s.produto_id = p.id
LEFT JOIN historico h        ON h.produto_id = p.id
LEFT JOIN ultima_previsao up ON up.produto_id = p.id
LEFT JOIN parametros_estoque pe ON pe.produto_id = p.id
WHERE p.deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 11. Parametros de previsao (secao 48 do prompt 04)
-- ---------------------------------------------------------------------------
INSERT INTO configuracoes (chave, valor, tipo, grupo, descricao) VALUES
  ('forecast.meses_minimos_historico', '3',      'NUMERO', 'forecast',   'Meses de historico exigidos para calcular previsao'),
  ('forecast.meses_minimos_sazonalidade', '12',  'NUMERO', 'forecast',   'Meses de historico exigidos para afirmar sazonalidade'),
  ('forecast.janela_media_movel', '30',          'NUMERO', 'forecast',   'Janela em dias da media movel padrao'),
  ('forecast.metrica_erro', 'MAPE',              'STRING', 'forecast',   'Metrica usada para escolher o melhor metodo (MAE, MAPE, RMSE)'),
  ('forecast.alpha', '0.3',                      'NUMERO', 'forecast',   'Alpha da suavizacao exponencial quando definido manualmente'),
  ('forecast.alpha_automatico', 'true',          'BOOLEANO', 'forecast', 'Buscar o melhor alpha por backtest'),
  ('forecast.pesos_ponderada', '[0.5,0.3,0.2]',  'JSON', 'forecast',     'Pesos da media movel ponderada, do periodo mais recente para o mais antigo'),
  ('forecast.limite_outlier_z', '3',             'NUMERO', 'forecast',   'Z-score a partir do qual a venda e marcada como possivel outlier'),
  ('forecast.horizonte_padrao_dias', '30',       'NUMERO', 'forecast',   'Horizonte padrao da previsao'),
  ('forecast.base_dias', 'CORRIDOS',             'STRING', 'forecast',   'Base da media diaria: CORRIDOS, UTEIS ou COM_OPERACAO'),
  ('forecast.tratar_promocao', 'SEPARADO',       'STRING', 'forecast',   'Tratamento de periodo promocional: INCLUIR, EXCLUIR ou SEPARADO'),
  ('forecast.tratar_ruptura', 'EXCLUIR',         'STRING', 'forecast',   'Tratamento de dias em ruptura no calculo da media: INCLUIR ou EXCLUIR'),
  ('forecast.devolucao_reduz_demanda', 'true',   'BOOLEANO', 'forecast', 'Devolucao efetiva reduz a demanda realizada'),
  ('forecast.limite_alerta_crescimento', '30',   'NUMERO', 'forecast',   'Variacao percentual que dispara alerta de demanda crescente'),
  ('forecast.limite_alerta_queda', '30',         'NUMERO', 'forecast',   'Variacao percentual que dispara alerta de demanda em queda'),
  ('forecast.dias_previsao_desatualizada', '30', 'NUMERO', 'forecast',   'Dias sem recalculo para considerar a previsao desatualizada')
ON CONFLICT (chave) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 12. Permissoes do modulo
-- ---------------------------------------------------------------------------
INSERT INTO permissoes (codigo, modulo, descricao) VALUES
  ('demanda.importar', 'demanda', 'Importar historico de vendas'),
  ('demanda.prever',   'demanda', 'Executar calculo de previsao de demanda'),
  ('demanda.ajustar',  'demanda', 'Ajustar manualmente previsao, outlier ou demanda reprimida')
ON CONFLICT (codigo) DO NOTHING;

-- ADMIN recebe tudo; GESTOR_COMPRAS e COMPRADOR operam; os demais so leem.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id
FROM perfis pf
JOIN permissoes pm ON pm.codigo IN ('demanda.importar', 'demanda.prever', 'demanda.ajustar')
WHERE pf.nome IN ('ADMIN', 'GESTOR_COMPRAS')
ON CONFLICT DO NOTHING;

INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id
FROM perfis pf
JOIN permissoes pm ON pm.codigo IN ('demanda.prever')
WHERE pf.nome = 'COMPRADOR'
ON CONFLICT DO NOTHING;
