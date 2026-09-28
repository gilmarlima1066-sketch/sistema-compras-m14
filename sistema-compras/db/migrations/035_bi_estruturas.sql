-- ---------------------------------------------------------------------------
-- 035 - MODULO 11: KPIs, metas, dashboards e central de alertas
--
-- A decisao que organiza este arquivo vem da secao 67: se o OTIF aparece no
-- dashboard executivo, no de fornecedores e no de logistica, os tres precisam
-- usar a MESMA definicao. Entao existe um catalogo unico de KPIs, e o
-- dashboard nao calcula nada - ele pede o KPI ao catalogo.
--
-- O catalogo guarda a DEFINICAO (formula em texto, fonte, periodicidade,
-- responsavel, direcao, unidade). A EXECUCAO fica no codigo, num resolvedor
-- por codigo de KPI. Guardar SQL no banco para ser executado deixaria a
-- formula flexivel e o sistema inseguro; guardar so a definicao mantem o
-- dicionario honesto (secao 66) sem abrir essa porta.
--
-- Nenhuma tabela operacional e tocada: o modulo 11 e camada de leitura
-- (regras 9 e 10 da secao 71).
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- Tipos
-- ===========================================================================

DO $$ BEGIN
  CREATE TYPE modulo_kpi_enum AS ENUM (
    'COMPRAS', 'ESTOQUE', 'DEMANDA', 'FORNECEDORES', 'LOGISTICA',
    'RECEBIMENTO', 'QUALIDADE', 'FINANCEIRO', 'RISCOS', 'IMPORTACAO'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE periodicidade_kpi_enum AS ENUM (
    'DIARIA', 'SEMANAL', 'MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL', 'SOB_DEMANDA'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE unidade_kpi_enum AS ENUM (
    'PERCENTUAL', 'MOEDA', 'QUANTIDADE', 'DIAS', 'HORAS', 'INDICE', 'CONTAGEM'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Secao 11: o cinza e parte do padrao, nao um acidente. Sem dado suficiente o
-- semaforo nao fica verde nem vermelho.
DO $$ BEGIN
  CREATE TYPE semaforo_kpi_enum AS ENUM ('VERDE', 'AMARELO', 'VERMELHO', 'CINZA');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE escopo_meta_enum AS ENUM (
    'EMPRESA', 'FILIAL', 'CATEGORIA', 'PRODUTO', 'FORNECEDOR', 'COMPRADOR'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE prioridade_alerta_enum AS ENUM ('CRITICO', 'ALTO', 'MEDIO', 'BAIXO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tipo_widget_enum AS ENUM (
    'KPI', 'LINHA', 'BARRAS', 'PARETO', 'DONUT', 'TABELA', 'MATRIZ', 'LISTA'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===========================================================================
-- Catalogo de KPIs (secoes 9, 10, 65 e 66)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS kpi_definicoes (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo         TEXT NOT NULL,
  nome           TEXT NOT NULL,
  descricao      TEXT NOT NULL,
  objetivo       TEXT,
  modulo         modulo_kpi_enum NOT NULL,
  categoria      TEXT,
  -- A formula em texto: e o que o dicionario mostra e o que a tela exibe ao
  -- lado do numero. A execucao fica no resolvedor, pelo `codigo`.
  formula        TEXT NOT NULL,
  fonte          TEXT NOT NULL,
  tabelas        TEXT,
  unidade        unidade_kpi_enum NOT NULL,
  periodicidade  periodicidade_kpi_enum NOT NULL DEFAULT 'MENSAL',
  -- Direcao reaproveita o enum do modulo 06: define se subir e bom.
  direcao        direcao_criterio_enum NOT NULL DEFAULT 'MAIOR_MELHOR',
  casas_decimais SMALLINT NOT NULL DEFAULT 2,
  -- Quantos eventos o KPI precisa para ser calculavel (secao 56).
  minimo_eventos INTEGER NOT NULL DEFAULT 1,
  -- Para onde o drill-down leva (secao 43).
  drilldown      TEXT,
  interpretacao  TEXT,
  responsavel_id BIGINT REFERENCES usuarios(id),
  ativo          BOOLEAN NOT NULL DEFAULT TRUE,
  revisado_em    DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT REFERENCES usuarios(id),
  updated_by     BIGINT REFERENCES usuarios(id),
  CONSTRAINT ck_kpi_casas CHECK (casas_decimais BETWEEN 0 AND 6),
  CONSTRAINT ck_kpi_minimo CHECK (minimo_eventos >= 0)
);

-- Regra 1 da secao 71: nao duplicar KPIs. O codigo e a chave.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kpi_codigo ON kpi_definicoes (upper(codigo));
CREATE INDEX IF NOT EXISTS ix_kpi_modulo ON kpi_definicoes (modulo) WHERE ativo;

-- ===========================================================================
-- Metas (secoes 12 e 51)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS kpi_metas (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kpi_id         BIGINT NOT NULL REFERENCES kpi_definicoes(id) ON DELETE CASCADE,
  escopo         escopo_meta_enum NOT NULL DEFAULT 'EMPRESA',
  categoria_id   BIGINT REFERENCES categorias(id) ON DELETE CASCADE,
  produto_id     BIGINT REFERENCES produtos(id) ON DELETE CASCADE,
  fornecedor_id  BIGINT REFERENCES fornecedores(id) ON DELETE CASCADE,
  local_id       BIGINT REFERENCES locais(id) ON DELETE CASCADE,
  comprador_id   BIGINT REFERENCES usuarios(id) ON DELETE CASCADE,
  meta           NUMERIC(16,4) NOT NULL,
  limite_atencao NUMERIC(16,4),
  limite_critico NUMERIC(16,4),
  -- Vigencia: alterar a meta nao reescreve o passado (cenario 4 da secao 70).
  vigencia_inicio DATE NOT NULL DEFAULT CURRENT_DATE,
  vigencia_fim   DATE,
  observacao     TEXT,
  ativo          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT REFERENCES usuarios(id),
  updated_by     BIGINT REFERENCES usuarios(id),
  CONSTRAINT ck_kpi_meta_escopo CHECK (
    (escopo = 'EMPRESA'    AND categoria_id IS NULL AND produto_id IS NULL
                           AND fornecedor_id IS NULL AND comprador_id IS NULL)
    OR (escopo = 'CATEGORIA'  AND categoria_id IS NOT NULL)
    OR (escopo = 'PRODUTO'    AND produto_id IS NOT NULL)
    OR (escopo = 'FORNECEDOR' AND fornecedor_id IS NOT NULL)
    OR (escopo = 'FILIAL'     AND local_id IS NOT NULL)
    OR (escopo = 'COMPRADOR'  AND comprador_id IS NOT NULL)
  ),
  CONSTRAINT ck_kpi_meta_vigencia CHECK (vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio)
);

-- Uma meta vigente por KPI e escopo: duas deixariam o semaforo ambiguo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kpi_meta_vigente
  ON kpi_metas (kpi_id, escopo,
                coalesce(categoria_id, 0), coalesce(produto_id, 0),
                coalesce(fornecedor_id, 0), coalesce(local_id, 0),
                coalesce(comprador_id, 0))
  WHERE ativo AND vigencia_fim IS NULL;

CREATE INDEX IF NOT EXISTS ix_kpi_metas_kpi ON kpi_metas (kpi_id) WHERE ativo;

-- ===========================================================================
-- Resultados (secoes 10, 30 e 49)
-- ===========================================================================

-- Serie historica do KPI. Guardar o resultado permite comparar periodos sem
-- recalcular anos de historico a cada clique (secao 61), e preserva o numero
-- como ele foi apurado - inclusive a meta que valia na epoca.
CREATE TABLE IF NOT EXISTS kpi_resultados (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kpi_id         BIGINT NOT NULL REFERENCES kpi_definicoes(id) ON DELETE CASCADE,
  periodo_inicio DATE NOT NULL,
  periodo_fim    DATE NOT NULL,
  rotulo_periodo TEXT,
  -- Nulo quando nao ha dado suficiente. Regra 6 da secao 71: zero e ausencia
  -- sao coisas diferentes.
  valor          NUMERIC(18,4),
  eventos        INTEGER NOT NULL DEFAULT 0,
  calculavel     BOOLEAN NOT NULL DEFAULT TRUE,
  motivo         TEXT,
  meta           NUMERIC(16,4),
  desvio         NUMERIC(16,4),
  semaforo       semaforo_kpi_enum NOT NULL DEFAULT 'CINZA',
  -- Os filtros que produziram este numero, para ele poder ser reproduzido.
  filtros        JSONB,
  apurado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_kpi_resultado_periodo CHECK (periodo_fim >= periodo_inicio),
  -- Regra 6 de novo, agora como constraint: nao calculavel nao carrega valor.
  CONSTRAINT ck_kpi_resultado_calculavel CHECK (
    (calculavel AND valor IS NOT NULL) OR (NOT calculavel AND valor IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS ix_kpi_resultados_serie
  ON kpi_resultados (kpi_id, periodo_fim DESC);

-- ===========================================================================
-- Dashboards personalizaveis (secao 58)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS dashboards (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo        TEXT NOT NULL,
  nome          TEXT NOT NULL,
  descricao     TEXT,
  perfil        TEXT,
  usuario_id    BIGINT REFERENCES usuarios(id) ON DELETE CASCADE,
  -- Dashboard de sistema e o oficial; o do usuario e personalizacao.
  sistema       BOOLEAN NOT NULL DEFAULT FALSE,
  padrao        BOOLEAN NOT NULL DEFAULT FALSE,
  filtros       JSONB,
  ordem         INTEGER NOT NULL DEFAULT 0,
  ativo         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT REFERENCES usuarios(id),
  updated_by    BIGINT REFERENCES usuarios(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_sistema
  ON dashboards (upper(codigo)) WHERE sistema;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_usuario
  ON dashboards (usuario_id, upper(codigo)) WHERE NOT sistema;

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dashboard_id  BIGINT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  tipo          tipo_widget_enum NOT NULL DEFAULT 'KPI',
  -- Personalizar escolhe QUAIS KPIs aparecem, nunca o que eles significam
  -- (secao 58).
  kpi_id        BIGINT REFERENCES kpi_definicoes(id) ON DELETE CASCADE,
  titulo        TEXT,
  configuracao  JSONB,
  linha         INTEGER NOT NULL DEFAULT 0,
  coluna        INTEGER NOT NULL DEFAULT 0,
  largura       INTEGER NOT NULL DEFAULT 1,
  ordem         INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_widget_kpi CHECK (tipo <> 'KPI' OR kpi_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_dashboard_widgets ON dashboard_widgets (dashboard_id);

-- Filtros salvos e favoritos (secao 58).
CREATE TABLE IF NOT EXISTS dashboard_filtros (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario_id   BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  dashboard    TEXT NOT NULL,
  nome         TEXT NOT NULL,
  filtros      JSONB NOT NULL,
  favorito     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_filtro
  ON dashboard_filtros (usuario_id, dashboard, upper(nome));

-- ===========================================================================
-- Central de alertas: evolucao da tabela existente (secoes 40, 41 e 42)
-- ===========================================================================

-- `alertas` ja existe desde o modulo 03 e e alimentada pelos modulos 04 a 10.
-- A central do modulo 11 le a MESMA tabela: criar uma segunda faria o mesmo
-- evento aparecer duas vezes, com contagens diferentes.
ALTER TABLE alertas
  ADD COLUMN IF NOT EXISTS titulo          TEXT,
  ADD COLUMN IF NOT EXISTS prioridade      prioridade_alerta_enum,
  ADD COLUMN IF NOT EXISTS categoria       TEXT,
  ADD COLUMN IF NOT EXISTS origem          TEXT,
  ADD COLUMN IF NOT EXISTS entidade        TEXT,
  ADD COLUMN IF NOT EXISTS entidade_id     BIGINT,
  ADD COLUMN IF NOT EXISTS link            TEXT,
  -- Chave de deduplicacao (secao 42): o mesmo evento atualiza o alerta
  -- existente em vez de criar outro.
  ADD COLUMN IF NOT EXISTS chave_dedup     TEXT,
  ADD COLUMN IF NOT EXISTS ocorrencias     INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS primeira_ocorrencia TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ultima_ocorrencia   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS kpi_id          BIGINT REFERENCES kpi_definicoes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS valor           NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS limite          NUMERIC(18,4);

COMMENT ON COLUMN alertas.chave_dedup IS
  'Identidade do evento. Alerta aberto com a mesma chave e atualizado, nao duplicado (secao 42).';

-- Um alerta ABERTO por chave. Encerrado nao participa: o mesmo problema pode
-- voltar semanas depois e merece alerta novo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_alerta_dedup
  ON alertas (chave_dedup) WHERE chave_dedup IS NOT NULL AND status = 'ABERTO';

CREATE INDEX IF NOT EXISTS ix_alertas_prioridade
  ON alertas (prioridade, data_geracao DESC) WHERE status = 'ABERTO';
CREATE INDEX IF NOT EXISTS ix_alertas_categoria
  ON alertas (categoria) WHERE status = 'ABERTO';

-- Regras de alerta configuraveis (secao 40 e 42).
CREATE TABLE IF NOT EXISTS alertas_regras (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo        TEXT NOT NULL,
  nome          TEXT NOT NULL,
  descricao     TEXT,
  categoria     TEXT NOT NULL,
  kpi_id        BIGINT REFERENCES kpi_definicoes(id) ON DELETE CASCADE,
  tipo_alerta   tipo_alerta_enum NOT NULL,
  prioridade    prioridade_alerta_enum NOT NULL DEFAULT 'MEDIO',
  -- Condicao avaliada contra o valor do KPI.
  comparador    TEXT NOT NULL DEFAULT 'MENOR_QUE',
  limite        NUMERIC(18,4),
  janela_dias   INTEGER NOT NULL DEFAULT 30,
  responsavel_id BIGINT REFERENCES usuarios(id),
  ativo         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT REFERENCES usuarios(id),
  updated_by    BIGINT REFERENCES usuarios(id),
  CONSTRAINT ck_alerta_regra_comparador CHECK (
    comparador IN ('MENOR_QUE', 'MAIOR_QUE', 'IGUAL_A', 'FORA_DA_META', 'SEM_DADOS')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_alerta_regra_codigo
  ON alertas_regras (upper(codigo));

-- ===========================================================================
-- Indices de apoio as consultas agregadas (secao 61)
-- ===========================================================================

CREATE INDEX IF NOT EXISTS ix_oc_emissao_status
  ON ordens_compra (data_emissao DESC, status);
CREATE INDEX IF NOT EXISTS ix_oc_fornecedor_emissao
  ON ordens_compra (fornecedor_id, data_emissao DESC);
CREATE INDEX IF NOT EXISTS ix_oci_produto
  ON ordem_compra_itens (produto_id);
CREATE INDEX IF NOT EXISTS ix_mov_produto_data
  ON movimentacoes_estoque (produto_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_rec_data_status
  ON recebimentos (data_recebimento DESC, status);
CREATE INDEX IF NOT EXISTS ix_nc_criado
  ON nao_conformidades (created_at DESC, severidade);

-- ===========================================================================
-- Gatilhos
-- ===========================================================================

DROP TRIGGER IF EXISTS trg_kpi_definicoes_updated_at ON kpi_definicoes;
CREATE TRIGGER trg_kpi_definicoes_updated_at BEFORE UPDATE ON kpi_definicoes
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_kpi_metas_updated_at ON kpi_metas;
CREATE TRIGGER trg_kpi_metas_updated_at BEFORE UPDATE ON kpi_metas
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_dashboards_updated_at ON dashboards;
CREATE TRIGGER trg_dashboards_updated_at BEFORE UPDATE ON dashboards
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_dashboard_widgets_updated_at ON dashboard_widgets;
CREATE TRIGGER trg_dashboard_widgets_updated_at BEFORE UPDATE ON dashboard_widgets
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_dashboard_filtros_updated_at ON dashboard_filtros;
CREATE TRIGGER trg_dashboard_filtros_updated_at BEFORE UPDATE ON dashboard_filtros
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_alertas_regras_updated_at ON alertas_regras;
CREATE TRIGGER trg_alertas_regras_updated_at BEFORE UPDATE ON alertas_regras
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- Auditoria (secao 68): definicao de KPI, meta, dashboard e regra de alerta.
DROP TRIGGER IF EXISTS trg_kpi_definicoes_auditoria ON kpi_definicoes;
CREATE TRIGGER trg_kpi_definicoes_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON kpi_definicoes
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

DROP TRIGGER IF EXISTS trg_kpi_metas_auditoria ON kpi_metas;
CREATE TRIGGER trg_kpi_metas_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON kpi_metas
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

DROP TRIGGER IF EXISTS trg_dashboards_auditoria ON dashboards;
CREATE TRIGGER trg_dashboards_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON dashboards
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

DROP TRIGGER IF EXISTS trg_alertas_regras_auditoria ON alertas_regras;
CREATE TRIGGER trg_alertas_regras_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON alertas_regras
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

-- Resultado de KPI e fotografia: reescrever apagaria a comparacao de periodos.
CREATE OR REPLACE FUNCTION fn_kpi_resultado_imutavel() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Resultado de KPI e historico e nao pode ser alterado nem apagado.'
    USING ERRCODE = 'restrict_violation';
END; $$;

DROP TRIGGER IF EXISTS trg_kpi_resultados_imutavel ON kpi_resultados;
CREATE TRIGGER trg_kpi_resultados_imutavel
  BEFORE UPDATE OR DELETE ON kpi_resultados
  FOR EACH ROW EXECUTE FUNCTION fn_kpi_resultado_imutavel();

-- ===========================================================================
-- Configuracoes (grupo `bi`)
-- ===========================================================================

INSERT INTO configuracoes (chave, valor, tipo, grupo, descricao) VALUES
  ('bi.excesso_cobertura_dias', '90', 'NUMERO', 'bi',
   'Cobertura acima deste numero de dias e considerada excesso'),
  ('bi.estoque_parado_dias', '90', 'NUMERO', 'bi',
   'Dias sem movimentacao para o produto entrar em estoque parado'),
  ('bi.cobertura_critica_dias', '7', 'NUMERO', 'bi',
   'Cobertura abaixo deste numero de dias e critica'),
  ('bi.cobertura_atencao_dias', '15', 'NUMERO', 'bi',
   'Cobertura abaixo deste numero de dias pede atencao'),
  ('bi.giro_metodo', 'CUSTO', 'STRING', 'bi',
   'Base do giro de estoque: CUSTO (saidas valorizadas) ou QUANTIDADE'),
  ('bi.giro_baixo', '2', 'NUMERO', 'bi',
   'Giro anualizado abaixo deste valor e sinalizado'),
  ('bi.valor_estoque_metodo', 'CUSTO_REFERENCIA', 'STRING', 'bi',
   'Metodo de valorizacao do estoque: CUSTO_REFERENCIA ou ULTIMO_CUSTO'),
  ('bi.semaforo_tolerancia_percentual', '5', 'NUMERO', 'bi',
   'Distancia da meta, em percentual da propria meta, que ainda conta como atencao'),
  ('bi.lead_time_elevado_dias', '30', 'NUMERO', 'bi',
   'Lead time acima deste numero de dias entra no mapa de riscos'),
  ('bi.risco_concentracao_percentual', '70', 'NUMERO', 'bi',
   'Participacao de um fornecedor acima deste percentual conta como risco'),
  ('bi.qualidade_dados_minimo', '80', 'NUMERO', 'bi',
   'Completude minima aceitavel no indicador de qualidade dos dados'),
  ('bi.limite_drilldown', '500', 'NUMERO', 'bi',
   'Maximo de linhas devolvidas por um drill-down'),
  ('bi.dias_padrao', '90', 'NUMERO', 'bi',
   'Janela padrao dos dashboards quando nenhum periodo e informado')
ON CONFLICT (chave) DO NOTHING;

-- ===========================================================================
-- Permissoes (secoes 59 e 60)
-- ===========================================================================

INSERT INTO permissoes (codigo, modulo, descricao) VALUES
  ('bi.ler',           'bi', 'Consultar dashboards, KPIs e central de alertas'),
  ('bi.executivo',     'bi', 'Acessar o dashboard executivo e o financeiro'),
  ('bi.kpi',           'bi', 'Criar e editar definicoes de KPI'),
  ('bi.meta',          'bi', 'Definir e alterar metas de KPI'),
  ('bi.personalizar',  'bi', 'Montar dashboards proprios e salvar filtros'),
  ('bi.alertas',       'bi', 'Tratar e encerrar alertas da central')
ON CONFLICT (codigo) DO NOTHING;

-- ADMIN e GESTOR_COMPRAS: tudo.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo IN ('bi.ler','bi.executivo','bi.kpi','bi.meta','bi.personalizar','bi.alertas')
   AND p.nome IN ('ADMIN', 'GESTOR_COMPRAS')
ON CONFLICT DO NOTHING;

-- DIRETORIA: visao executiva, sem mexer em definicao nem meta.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo IN ('bi.ler', 'bi.executivo', 'bi.personalizar')
   AND p.nome = 'DIRETORIA'
ON CONFLICT DO NOTHING;

-- FINANCEIRO: precisa do financeiro de compras, que vive no executivo.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo IN ('bi.ler', 'bi.executivo')
   AND p.nome = 'FINANCEIRO'
ON CONFLICT DO NOTHING;

-- Operacao: le os dashboards do seu dominio e trata alerta, mas nao ve o
-- executivo nem altera a definicao oficial de nenhum KPI (secao 59).
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo IN ('bi.ler', 'bi.alertas', 'bi.personalizar')
   AND p.nome IN ('COMPRADOR', 'ESTOQUE', 'QUALIDADE')
ON CONFLICT DO NOTHING;

INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo = 'bi.ler' AND p.nome = 'COMERCIAL'
ON CONFLICT DO NOTHING;
