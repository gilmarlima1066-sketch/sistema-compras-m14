-- ---------------------------------------------------------------------------
-- 032 - MODULO 10: avaliacao de fornecedores, scorecard e plano de acao
--
-- Duas decisoes de estrutura, ambas exigidas pelo enunciado:
--
-- 1. `avaliacoes_fornecedores` JA EXISTIA, com uma coluna fixa por criterio
--    (otif, qualidade, lead_time, preco, atendimento, flexibilidade). A secao
--    58 manda evoluir em vez de duplicar, entao a tabela e ampliada e os
--    criterios passam a viver em `avaliacao_criterios`, um por linha. As
--    colunas antigas continuam, preenchidas por compatibilidade - apagar
--    destruiria avaliacoes ja gravadas.
--
-- 2. A metodologia e VERSIONADA (secoes 35 e 36). A avaliacao guarda o id da
--    metodologia usada, e a metodologia e congelada quando publicada. Mudar
--    peso nao reescreve o passado: cria versao nova. E por isso que
--    `avaliacao_criterios` grava o peso aplicado na linha, e nao so aponta
--    para a metodologia.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- Tipos
-- ===========================================================================

DO $$ BEGIN
  CREATE TYPE grupo_criterio_enum AS ENUM (
    'LOGISTICA', 'QUALIDADE', 'COMERCIAL', 'ATENDIMENTO',
    'PRECO', 'PAGAMENTO', 'FLEXIBILIDADE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE status_avaliacao_enum AS ENUM (
    'RASCUNHO', 'CALCULADA', 'VALIDADA', 'CANCELADA'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Secao 28: o sistema diz o quanto a avaliacao vale, em vez de fingir que
-- toda avaliacao nasce igual.
DO $$ BEGIN
  CREATE TYPE completude_avaliacao_enum AS ENUM (
    'COMPLETA', 'DADOS_PARCIAIS', 'DADOS_INSUFICIENTES', 'SEM_HISTORICO'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE confiabilidade_avaliacao_enum AS ENUM (
    'ALTA', 'MEDIA', 'BAIXA', 'INSUFICIENTE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE status_homologacao_enum AS ENUM (
    'EM_HOMOLOGACAO', 'HOMOLOGADO', 'HOMOLOGADO_COM_RESTRICAO',
    'EM_MONITORAMENTO', 'BLOQUEADO', 'INATIVO'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE status_plano_acao_enum AS ENUM (
    'ABERTO', 'EM_ANALISE', 'ACAO_DEFINIDA', 'EM_EXECUCAO',
    'AGUARDANDO_FORNECEDOR', 'VALIDACAO', 'ENCERRADO', 'CANCELADO'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE frequencia_avaliacao_enum AS ENUM (
    'MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL', 'SOB_DEMANDA'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE escopo_metodologia_enum AS ENUM (
    'EMPRESA', 'CATEGORIA', 'FORNECEDOR', 'TIPO_COMPRA'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE motivo_bloqueio_enum AS ENUM (
    'QUALIDADE_GRAVE', 'DOCUMENTACAO_IRREGULAR', 'PROBLEMA_COMERCIAL',
    'DECISAO_ADMINISTRATIVA', 'RISCO_OPERACIONAL', 'NAO_CONFORMIDADE_CRITICA'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===========================================================================
-- Metodologia versionada (secoes 9, 11, 35, 36)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS metodologias_avaliacao (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  versao         TEXT NOT NULL,
  nome           TEXT NOT NULL,
  descricao      TEXT,
  escopo         escopo_metodologia_enum NOT NULL DEFAULT 'EMPRESA',
  categoria_id   BIGINT REFERENCES categorias(id) ON DELETE CASCADE,
  fornecedor_id  BIGINT REFERENCES fornecedores(id) ON DELETE CASCADE,
  tipo_compra    TEXT,
  escala_maxima  NUMERIC(6,2) NOT NULL DEFAULT 100,
  frequencia     frequencia_avaliacao_enum NOT NULL DEFAULT 'TRIMESTRAL',
  -- Congelada: publicada e ja usada em avaliacao. A partir dai, mudar peso
  -- exige versao nova (regra 8 da secao 67).
  publicada_em   TIMESTAMPTZ,
  vigente        BOOLEAN NOT NULL DEFAULT FALSE,
  ativo          BOOLEAN NOT NULL DEFAULT TRUE,
  observacoes    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT REFERENCES usuarios(id),
  updated_by     BIGINT REFERENCES usuarios(id),
  CONSTRAINT ck_metodologia_escopo CHECK (
    (escopo = 'EMPRESA'     AND categoria_id IS NULL AND fornecedor_id IS NULL AND tipo_compra IS NULL)
    OR (escopo = 'CATEGORIA'  AND categoria_id IS NOT NULL)
    OR (escopo = 'FORNECEDOR' AND fornecedor_id IS NOT NULL)
    OR (escopo = 'TIPO_COMPRA' AND tipo_compra IS NOT NULL)
  ),
  CONSTRAINT ck_metodologia_escala CHECK (escala_maxima > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_metodologia_versao
  ON metodologias_avaliacao (versao);

-- Uma unica metodologia vigente por escopo: senao o sistema nao saberia qual
-- aplicar e a escolha viraria sorte.
CREATE UNIQUE INDEX IF NOT EXISTS uq_metodologia_vigente_empresa
  ON metodologias_avaliacao ((1)) WHERE escopo = 'EMPRESA' AND vigente;
CREATE UNIQUE INDEX IF NOT EXISTS uq_metodologia_vigente_categoria
  ON metodologias_avaliacao (categoria_id) WHERE escopo = 'CATEGORIA' AND vigente;
CREATE UNIQUE INDEX IF NOT EXISTS uq_metodologia_vigente_fornecedor
  ON metodologias_avaliacao (fornecedor_id) WHERE escopo = 'FORNECEDOR' AND vigente;
CREATE UNIQUE INDEX IF NOT EXISTS uq_metodologia_vigente_tipo
  ON metodologias_avaliacao (tipo_compra) WHERE escopo = 'TIPO_COMPRA' AND vigente;

CREATE TABLE IF NOT EXISTS metodologia_criterios (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  metodologia_id  BIGINT NOT NULL REFERENCES metodologias_avaliacao(id) ON DELETE CASCADE,
  grupo           grupo_criterio_enum NOT NULL,
  nome            TEXT NOT NULL,
  descricao       TEXT,
  peso_percentual NUMERIC(6,2) NOT NULL,
  -- Minimo de eventos para o criterio ser calculavel (secao 28).
  minimo_eventos  INTEGER NOT NULL DEFAULT 1,
  ordem           INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_metodologia_criterio_peso CHECK (peso_percentual >= 0 AND peso_percentual <= 100),
  CONSTRAINT ck_metodologia_criterio_minimo CHECK (minimo_eventos >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_metodologia_criterio
  ON metodologia_criterios (metodologia_id, grupo);

-- Subcriterio: o indicador que alimenta a nota do grupo, com peso interno e
-- direcao (maior e melhor, ou menor e melhor). direcao_criterio_enum ja existe
-- desde o modulo 06 e e reaproveitado aqui.
CREATE TABLE IF NOT EXISTS metodologia_indicadores (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  metodologia_criterio_id BIGINT NOT NULL
                      REFERENCES metodologia_criterios(id) ON DELETE CASCADE,
  codigo              TEXT NOT NULL,
  nome                TEXT NOT NULL,
  peso_percentual     NUMERIC(6,2) NOT NULL,
  direcao             direcao_criterio_enum NOT NULL DEFAULT 'MAIOR_MELHOR',
  -- Faixa de normalizacao para nota 0-100. Valor <= pior vira 0, >= melhor
  -- vira 100, e no meio e linear.
  valor_pior          NUMERIC(14,4),
  valor_melhor        NUMERIC(14,4),
  unidade             TEXT,
  minimo_eventos      INTEGER NOT NULL DEFAULT 1,
  ordem               INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_metodologia_indicador_peso
    CHECK (peso_percentual >= 0 AND peso_percentual <= 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_metodologia_indicador
  ON metodologia_indicadores (metodologia_criterio_id, codigo);

-- ===========================================================================
-- Avaliacao - evolucao da tabela existente (secao 58)
-- ===========================================================================

ALTER TABLE avaliacoes_fornecedores
  ADD COLUMN IF NOT EXISTS metodologia_id    BIGINT REFERENCES metodologias_avaliacao(id),
  ADD COLUMN IF NOT EXISTS metodologia_versao TEXT,
  ADD COLUMN IF NOT EXISTS numero            TEXT,
  ADD COLUMN IF NOT EXISTS rotulo_periodo    TEXT,
  ADD COLUMN IF NOT EXISTS frequencia        frequencia_avaliacao_enum,
  ADD COLUMN IF NOT EXISTS extraordinaria    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS status            status_avaliacao_enum NOT NULL DEFAULT 'CALCULADA',
  ADD COLUMN IF NOT EXISTS completude        completude_avaliacao_enum,
  ADD COLUMN IF NOT EXISTS confiabilidade    confiabilidade_avaliacao_enum,
  ADD COLUMN IF NOT EXISTS eventos_avaliados INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS criterios_calculados INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS criterios_totais  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS peso_aplicado     NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS categoria_id      BIGINT REFERENCES categorias(id),
  ADD COLUMN IF NOT EXISTS local_id          BIGINT REFERENCES locais(id),
  ADD COLUMN IF NOT EXISTS valor_comprado    NUMERIC(16,2),
  ADD COLUMN IF NOT EXISTS validado_por      BIGINT REFERENCES usuarios(id),
  ADD COLUMN IF NOT EXISTS validado_em       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON COLUMN avaliacoes_fornecedores.otif IS
  'Mantida por compatibilidade com o modulo 02. A nota por criterio vive em avaliacao_criterios.';
COMMENT ON COLUMN avaliacoes_fornecedores.score_final IS
  'Nulo quando nao houve dado suficiente: o sistema nao inventa score (regra 2 da secao 67).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_avaliacao_numero
  ON avaliacoes_fornecedores (numero) WHERE numero IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_avaliacao_fornecedor_periodo
  ON avaliacoes_fornecedores (fornecedor_id, periodo_fim DESC);

-- Nota de cada criterio, com o peso que valia NAQUELE momento.
CREATE TABLE IF NOT EXISTS avaliacao_criterios (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  avaliacao_id    BIGINT NOT NULL REFERENCES avaliacoes_fornecedores(id) ON DELETE CASCADE,
  grupo           grupo_criterio_enum NOT NULL,
  nome            TEXT NOT NULL,
  nota            NUMERIC(6,2),
  peso_percentual NUMERIC(6,2) NOT NULL,
  contribuicao    NUMERIC(8,4),
  calculavel      BOOLEAN NOT NULL DEFAULT TRUE,
  motivo          TEXT,
  eventos         INTEGER NOT NULL DEFAULT 0,
  minimo_eventos  INTEGER NOT NULL DEFAULT 1,
  ordem           INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_avaliacao_criterio_nota
    CHECK (nota IS NULL OR (nota >= 0 AND nota <= 100)),
  -- Regra 6 da secao 67: criterio sem dado e identificado, nunca preenchido
  -- com um numero de consolo.
  CONSTRAINT ck_avaliacao_criterio_calculavel
    CHECK ((calculavel AND nota IS NOT NULL) OR (NOT calculavel AND nota IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_avaliacao_criterio
  ON avaliacao_criterios (avaliacao_id, grupo);

-- Indicador cru por tras da nota: valor, periodo, eventos, formula e fonte
-- (secao 3).
CREATE TABLE IF NOT EXISTS avaliacao_indicadores (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  avaliacao_id          BIGINT NOT NULL REFERENCES avaliacoes_fornecedores(id) ON DELETE CASCADE,
  avaliacao_criterio_id BIGINT REFERENCES avaliacao_criterios(id) ON DELETE CASCADE,
  grupo                 grupo_criterio_enum NOT NULL,
  codigo                TEXT NOT NULL,
  nome                  TEXT NOT NULL,
  valor                 NUMERIC(16,4),
  unidade               TEXT,
  nota                  NUMERIC(6,2),
  peso_percentual       NUMERIC(6,2),
  direcao               direcao_criterio_enum,
  eventos               INTEGER NOT NULL DEFAULT 0,
  minimo_eventos        INTEGER NOT NULL DEFAULT 1,
  calculavel            BOOLEAN NOT NULL DEFAULT TRUE,
  motivo                TEXT,
  formula               TEXT,
  fonte                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_avaliacao_indicador_nota
    CHECK (nota IS NULL OR (nota >= 0 AND nota <= 100))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_avaliacao_indicador
  ON avaliacao_indicadores (avaliacao_id, codigo);
CREATE INDEX IF NOT EXISTS ix_avaliacao_indicador_criterio
  ON avaliacao_indicadores (avaliacao_criterio_id);

-- Serie historica do score, para a evolucao da secao 30 sem varrer as
-- avaliacoes inteiras.
CREATE TABLE IF NOT EXISTS historico_score_fornecedor (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fornecedor_id  BIGINT NOT NULL REFERENCES fornecedores(id) ON DELETE CASCADE,
  avaliacao_id   BIGINT REFERENCES avaliacoes_fornecedores(id) ON DELETE SET NULL,
  periodo_inicio DATE NOT NULL,
  periodo_fim    DATE NOT NULL,
  score          NUMERIC(6,2),
  otif           NUMERIC(6,2),
  otd            NUMERIC(6,2),
  in_full        NUMERIC(6,2),
  qualidade      NUMERIC(6,2),
  nao_conformidades INTEGER,
  lead_time_real NUMERIC(8,2),
  variacao_preco NUMERIC(8,4),
  completude     completude_avaliacao_enum,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_historico_score_fornecedor
  ON historico_score_fornecedor (fornecedor_id, periodo_fim DESC);

-- ===========================================================================
-- Homologacao, monitoramento e bloqueio (secoes 39, 40, 41)
-- ===========================================================================

ALTER TABLE fornecedores
  ADD COLUMN IF NOT EXISTS status_homologacao status_homologacao_enum
    NOT NULL DEFAULT 'EM_HOMOLOGACAO',
  ADD COLUMN IF NOT EXISTS homologado_em      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS homologado_por     BIGINT REFERENCES usuarios(id),
  ADD COLUMN IF NOT EXISTS ultima_avaliacao_em DATE,
  ADD COLUMN IF NOT EXISTS proxima_avaliacao_em DATE,
  ADD COLUMN IF NOT EXISTS score_atual        NUMERIC(6,2);

COMMENT ON COLUMN fornecedores.status_homologacao IS
  'Nunca alterado automaticamente por score (regra 9 da secao 67): toda mudanca passa por decisao registrada.';

CREATE INDEX IF NOT EXISTS ix_fornecedores_status_homologacao
  ON fornecedores (status_homologacao) WHERE deleted_at IS NULL;

-- Historico de situacao: monitoramento, bloqueio, homologacao. Uma linha por
-- decisao, com responsavel e justificativa (regra 10 da secao 67).
CREATE TABLE IF NOT EXISTS situacoes_fornecedor (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fornecedor_id   BIGINT NOT NULL REFERENCES fornecedores(id) ON DELETE CASCADE,
  status_anterior status_homologacao_enum,
  status_novo     status_homologacao_enum NOT NULL,
  motivo_bloqueio motivo_bloqueio_enum,
  motivo          TEXT NOT NULL,
  evidencias      TEXT,
  indicadores_monitorados JSONB,
  avaliacao_id    BIGINT REFERENCES avaliacoes_fornecedores(id) ON DELETE SET NULL,
  prazo           DATE,
  iniciado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  encerrado_em    TIMESTAMPTZ,
  responsavel_id  BIGINT REFERENCES usuarios(id),
  autorizado_por  BIGINT REFERENCES usuarios(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_situacao_motivo CHECK (length(btrim(motivo)) >= 5),
  CONSTRAINT ck_situacao_bloqueio CHECK (
    status_novo <> 'BLOQUEADO' OR motivo_bloqueio IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS ix_situacoes_fornecedor
  ON situacoes_fornecedor (fornecedor_id, iniciado_em DESC);

-- ===========================================================================
-- Plano de acao (secoes 37 e 38)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS planos_acao_fornecedor (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero          TEXT NOT NULL,
  fornecedor_id   BIGINT NOT NULL REFERENCES fornecedores(id) ON DELETE CASCADE,
  avaliacao_id    BIGINT REFERENCES avaliacoes_fornecedores(id) ON DELETE SET NULL,
  categoria_id    BIGINT REFERENCES categorias(id) ON DELETE SET NULL,
  produto_id      BIGINT REFERENCES produtos(id) ON DELETE SET NULL,
  grupo           grupo_criterio_enum,
  indicador       TEXT,
  valor_indicador NUMERIC(16,4),
  meta_indicador  NUMERIC(16,4),
  problema        TEXT NOT NULL,
  causa           TEXT,
  status          status_plano_acao_enum NOT NULL DEFAULT 'ABERTO',
  severidade      severidade_nc_enum NOT NULL DEFAULT 'MEDIA',
  responsavel_id  BIGINT REFERENCES usuarios(id),
  prazo           DATE,
  evidencia       TEXT,
  resultado       TEXT,
  encerrado_em    TIMESTAMPTZ,
  encerrado_por   BIGINT REFERENCES usuarios(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      BIGINT REFERENCES usuarios(id),
  updated_by      BIGINT REFERENCES usuarios(id),
  CONSTRAINT ck_plano_problema CHECK (length(btrim(problema)) >= 5),
  -- Encerrar sem dizer o que aconteceu deixaria o historico inutil.
  CONSTRAINT ck_plano_encerramento CHECK (
    status <> 'ENCERRADO' OR (resultado IS NOT NULL AND length(btrim(resultado)) >= 5)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_plano_acao_numero
  ON planos_acao_fornecedor (numero);
CREATE INDEX IF NOT EXISTS ix_plano_acao_fornecedor
  ON planos_acao_fornecedor (fornecedor_id, status);
CREATE INDEX IF NOT EXISTS ix_plano_acao_prazo
  ON planos_acao_fornecedor (prazo) WHERE status NOT IN ('ENCERRADO', 'CANCELADO');

CREATE TABLE IF NOT EXISTS plano_acao_itens (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plano_id        BIGINT NOT NULL REFERENCES planos_acao_fornecedor(id) ON DELETE CASCADE,
  acao            TEXT NOT NULL,
  responsavel_id  BIGINT REFERENCES usuarios(id),
  prazo           DATE,
  status          status_plano_acao_enum NOT NULL DEFAULT 'ABERTO',
  evidencia       TEXT,
  resultado       TEXT,
  concluido_em    TIMESTAMPTZ,
  concluido_por   BIGINT REFERENCES usuarios(id),
  ordem           INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_plano_item_acao CHECK (length(btrim(acao)) >= 5)
);

CREATE INDEX IF NOT EXISTS ix_plano_acao_itens ON plano_acao_itens (plano_id);

-- Historico do plano: append-only, como os demais historicos do sistema.
CREATE TABLE IF NOT EXISTS plano_acao_historico (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plano_id    BIGINT NOT NULL REFERENCES planos_acao_fornecedor(id) ON DELETE CASCADE,
  evento      TEXT NOT NULL,
  status_anterior status_plano_acao_enum,
  status_novo status_plano_acao_enum,
  descricao   TEXT NOT NULL,
  detalhes    JSONB,
  usuario_id  BIGINT REFERENCES usuarios(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_plano_acao_historico
  ON plano_acao_historico (plano_id, created_at DESC);

-- ===========================================================================
-- Gatilhos
-- ===========================================================================

DROP TRIGGER IF EXISTS trg_metodologias_updated_at ON metodologias_avaliacao;
CREATE TRIGGER trg_metodologias_updated_at BEFORE UPDATE ON metodologias_avaliacao
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_avaliacoes_updated_at ON avaliacoes_fornecedores;
CREATE TRIGGER trg_avaliacoes_updated_at BEFORE UPDATE ON avaliacoes_fornecedores
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_planos_acao_updated_at ON planos_acao_fornecedor;
CREATE TRIGGER trg_planos_acao_updated_at BEFORE UPDATE ON planos_acao_fornecedor
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_plano_acao_itens_updated_at ON plano_acao_itens;
CREATE TRIGGER trg_plano_acao_itens_updated_at BEFORE UPDATE ON plano_acao_itens
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- Auditoria (secao 64).
DROP TRIGGER IF EXISTS trg_metodologias_auditoria ON metodologias_avaliacao;
CREATE TRIGGER trg_metodologias_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON metodologias_avaliacao
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

DROP TRIGGER IF EXISTS trg_metodologia_criterios_auditoria ON metodologia_criterios;
CREATE TRIGGER trg_metodologia_criterios_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON metodologia_criterios
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

DROP TRIGGER IF EXISTS trg_avaliacoes_auditoria ON avaliacoes_fornecedores;
CREATE TRIGGER trg_avaliacoes_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON avaliacoes_fornecedores
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

DROP TRIGGER IF EXISTS trg_situacoes_fornecedor_auditoria ON situacoes_fornecedor;
CREATE TRIGGER trg_situacoes_fornecedor_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON situacoes_fornecedor
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

DROP TRIGGER IF EXISTS trg_planos_acao_auditoria ON planos_acao_fornecedor;
CREATE TRIGGER trg_planos_acao_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON planos_acao_fornecedor
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

-- Historicos append-only.
CREATE OR REPLACE FUNCTION fn_plano_historico_imutavel() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'O historico do plano de acao nao pode ser alterado nem apagado.'
    USING ERRCODE = 'restrict_violation';
END; $$;

DROP TRIGGER IF EXISTS trg_plano_acao_historico_imutavel ON plano_acao_historico;
CREATE TRIGGER trg_plano_acao_historico_imutavel
  BEFORE UPDATE OR DELETE ON plano_acao_historico
  FOR EACH ROW EXECUTE FUNCTION fn_plano_historico_imutavel();

-- Regra 3 da secao 67: avaliacao validada nao se reescreve. Corrigir exige
-- cancelar e refazer, o que deixa rastro.
CREATE OR REPLACE FUNCTION fn_avaliacao_validada_imutavel() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'VALIDADA' AND NEW.status = 'VALIDADA'
     AND (NEW.score_final IS DISTINCT FROM OLD.score_final
          OR NEW.metodologia_id IS DISTINCT FROM OLD.metodologia_id
          OR NEW.periodo_inicio IS DISTINCT FROM OLD.periodo_inicio
          OR NEW.periodo_fim IS DISTINCT FROM OLD.periodo_fim) THEN
    RAISE EXCEPTION 'Avaliacao validada nao pode ter score, metodologia ou periodo alterados. Cancele e refaca.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_avaliacao_validada_imutavel ON avaliacoes_fornecedores;
CREATE TRIGGER trg_avaliacao_validada_imutavel
  BEFORE UPDATE ON avaliacoes_fornecedores
  FOR EACH ROW EXECUTE FUNCTION fn_avaliacao_validada_imutavel();

-- ===========================================================================
-- Configuracoes (grupo `avaliacao`)
-- ===========================================================================

INSERT INTO configuracoes (chave, valor, tipo, grupo, descricao) VALUES
  ('avaliacao.minimo_entregas', '3', 'NUMERO', 'avaliacao',
   'Entregas elegiveis minimas para calcular os indicadores logisticos'),
  ('avaliacao.minimo_recebimentos', '3', 'NUMERO', 'avaliacao',
   'Recebimentos minimos para calcular os indicadores de qualidade'),
  ('avaliacao.minimo_pedidos', '2', 'NUMERO', 'avaliacao',
   'Pedidos minimos para calcular os indicadores comerciais'),
  ('avaliacao.minimo_cotacoes', '2', 'NUMERO', 'avaliacao',
   'Respostas a cotacao minimas para avaliar atendimento'),
  ('avaliacao.minimo_precos', '2', 'NUMERO', 'avaliacao',
   'Registros de preco minimos para avaliar competitividade'),
  ('avaliacao.confiabilidade_alta_eventos', '20', 'NUMERO', 'avaliacao',
   'Eventos a partir dos quais a confiabilidade da avaliacao e alta'),
  ('avaliacao.confiabilidade_media_eventos', '8', 'NUMERO', 'avaliacao',
   'Eventos a partir dos quais a confiabilidade da avaliacao e media'),
  ('avaliacao.completude_parcial_percentual', '50', 'NUMERO', 'avaliacao',
   'Percentual de peso calculavel abaixo do qual a avaliacao e DADOS_PARCIAIS'),
  ('avaliacao.completude_insuficiente_percentual', '30', 'NUMERO', 'avaliacao',
   'Percentual de peso calculavel abaixo do qual a avaliacao e DADOS_INSUFICIENTES'),
  ('avaliacao.tendencia_periodos', '3', 'NUMERO', 'avaliacao',
   'Quantas avaliacoes entram na deteccao de tendencia'),
  ('avaliacao.tendencia_variacao_percentual', '5', 'NUMERO', 'avaliacao',
   'Variacao percentual que caracteriza tendencia negativa ou melhoria'),
  ('avaliacao.alerta_otif_minimo', '85', 'NUMERO', 'avaliacao',
   'OTIF abaixo deste percentual gera alerta'),
  ('avaliacao.alerta_nc_maximo', '10', 'NUMERO', 'avaliacao',
   'Taxa de nao conformidade acima deste percentual gera alerta'),
  ('avaliacao.alerta_variacao_preco', '10', 'NUMERO', 'avaliacao',
   'Variacao de preco acima deste percentual gera alerta'),
  ('avaliacao.concentracao_alerta_percentual', '70', 'NUMERO', 'avaliacao',
   'Participacao de um fornecedor acima deste percentual e sinalizada como concentracao'),
  ('avaliacao.prefixo_numero', 'AVF', 'STRING', 'avaliacao',
   'Prefixo do numero da avaliacao'),
  ('avaliacao.prefixo_plano', 'PAF', 'STRING', 'avaliacao',
   'Prefixo do numero do plano de acao')
ON CONFLICT (chave) DO NOTHING;

-- ===========================================================================
-- Permissoes (secao 63)
-- ===========================================================================

INSERT INTO permissoes (codigo, modulo, descricao) VALUES
  ('fornecedores.avaliar',     'fornecedores', 'Criar e calcular avaliacoes de fornecedor'),
  ('fornecedores.validar',     'fornecedores', 'Validar avaliacao de fornecedor'),
  ('fornecedores.metodologia', 'fornecedores', 'Configurar metodologia, criterios e pesos'),
  ('fornecedores.plano_acao',  'fornecedores', 'Criar e tratar plano de acao de fornecedor'),
  ('fornecedores.monitorar',   'fornecedores', 'Colocar e retirar fornecedor de monitoramento'),
  ('fornecedores.bloquear',    'fornecedores', 'Bloquear, desbloquear e homologar fornecedor')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo IN ('fornecedores.avaliar', 'fornecedores.validar',
                     'fornecedores.metodologia', 'fornecedores.plano_acao',
                     'fornecedores.monitorar', 'fornecedores.bloquear')
   AND p.nome IN ('ADMIN', 'GESTOR_COMPRAS')
ON CONFLICT DO NOTHING;

-- COMPRADOR avalia e conduz plano de acao, mas nao mexe na metodologia nem
-- bloqueia fornecedor (secao 63).
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo IN ('fornecedores.avaliar', 'fornecedores.plano_acao')
   AND p.nome = 'COMPRADOR'
ON CONFLICT DO NOTHING;

-- QUALIDADE alimenta os indicadores de qualidade e registra plano de acao.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo = 'fornecedores.plano_acao' AND p.nome = 'QUALIDADE'
ON CONFLICT DO NOTHING;
