-- =========================================================================
-- MODULO 13 - ESTRUTURAS DA CAMADA DE ORQUESTRACAO (secao 37)
--
-- A secao 37 lista oito estruturas e manda "criar somente estruturas que
-- realmente nao existam". Auditado o banco, quatro ja tinham dono:
--
--   NOTIFICACOES -> `notificacoes` (modulo 02). Nao e recriada; ganha canal,
--                   tipo, status e prazo de envio, porque so conhecia o canal
--                   "sistema".
--   APROVACOES   -> `pedido_aprovacoes`, `recebimento_aprovacoes` e
--                   `alcadas_aprovacao` (modulos 05, 07 e 09) ja cuidam do
--                   fluxo de pedido e de recebimento, COM as faixas de valor
--                   por perfil que a secao 15 pede. A tabela nova aqui cobre
--                   o que nao tem dono: excecao (secao 16) e acao de
--                   automacao que exige aprovacao formal (secao 33, nivel 3).
--   AUDITORIA    -> `auditoria` (modulo 01), com autor, data, valor anterior
--                   e novo. A secao 35 pede exatamente isso.
--   ALERTAS      -> `alertas` (modulos 02, 11 e 12), ja com deduplicacao.
--
-- IDEMPOTENCIA (secao 22) nao e codigo, e restricao.
--
-- A secao 22 exige que reexecutar o mesmo evento nao duplique pedido,
-- recebimento, estoque, alerta, notificacao nem tarefa. Confiar no "if ja
-- existe" da aplicacao falha sob concorrencia: duas execucoes leem ao mesmo
-- tempo, as duas nao acham nada, as duas inserem. Por isso a garantia esta em
-- indice UNIQUE - `eventos.chave_idempotencia`, `tarefas.chave_dedup`,
-- `aprovacoes.chave_dedup` -, onde o banco recusa a segunda.
-- =========================================================================

-- -------------------------------------------------------------------------
-- Enums
-- -------------------------------------------------------------------------

CREATE TYPE origem_evento_enum AS ENUM (
  'ESTOQUE', 'COMPRAS', 'COTACOES', 'PEDIDOS', 'LOGISTICA', 'RECEBIMENTO',
  'QUALIDADE', 'FORNECEDORES', 'DEMANDA', 'BI', 'IA', 'INTEGRACAO', 'SISTEMA'
);

CREATE TYPE status_evento_enum AS ENUM (
  'NOVO', 'PROCESSADO', 'IGNORADO', 'ERRO'
);

CREATE TYPE status_execucao_automacao_enum AS ENUM (
  'PENDENTE', 'PROCESSANDO', 'CONCLUIDO', 'ERRO', 'RETRY', 'CANCELADO'
);

CREATE TYPE status_tarefa_enum AS ENUM (
  'PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDA', 'CANCELADA'
);

CREATE TYPE prioridade_tarefa_enum AS ENUM ('CRITICA', 'ALTA', 'MEDIA', 'BAIXA');

/*
 * Os tres niveis da secao 33.
 *
 * AUTOMATICO executa sozinho; ASSISTIDO cria tarefa para alguem confirmar;
 * APROVACAO cria uma aprovacao formal. O nivel e propriedade da REGRA, nao da
 * acao - a mesma acao pode ser automatica numa empresa e exigir aprovacao em
 * outra, e isso e configuracao, nao codigo.
 */
CREATE TYPE nivel_automacao_enum AS ENUM ('AUTOMATICO', 'ASSISTIDO', 'APROVACAO');

CREATE TYPE status_job_enum AS ENUM ('OCIOSO', 'EXECUTANDO', 'ERRO', 'DESATIVADO');

CREATE TYPE frequencia_job_enum AS ENUM (
  'MINUTO', 'HORA', 'DIARIO', 'SEMANAL', 'MENSAL', 'MANUAL'
);

CREATE TYPE canal_notificacao_enum AS ENUM ('SISTEMA', 'EMAIL', 'WHATSAPP', 'WEBHOOK');

CREATE TYPE status_notificacao_enum AS ENUM (
  'PENDENTE', 'ENVIADA', 'FALHOU', 'DESCARTADA'
);

CREATE TYPE status_webhook_enum AS ENUM (
  'RECEBIDO', 'PROCESSADO', 'REJEITADO', 'DUPLICADO', 'ERRO'
);

CREATE TYPE status_sla_enum AS ENUM ('DENTRO', 'EM_RISCO', 'VENCIDO', 'CUMPRIDO');

-- -------------------------------------------------------------------------
-- Eventos (secoes 6 e 7)
-- -------------------------------------------------------------------------

/*
 * `chave_idempotencia` e o coracao da secao 22.
 *
 * O mesmo fato do mundo - "o produto 42 cruzou o ponto de pedido hoje" -
 * produz sempre a mesma chave. O indice UNIQUE faz a segunda tentativa de
 * registrar esse fato ser recusada pelo BANCO, nao pela aplicacao. E a
 * diferenca importa: duas execucoes simultaneas do detector passariam juntas
 * por qualquer verificacao em codigo.
 *
 * `correlation_id` amarra tudo o que descende de um mesmo evento - regra,
 * execucao, tarefa, aprovacao, notificacao -, que e o que a secao 35 pede para
 * reconstruir o que aconteceu.
 */
CREATE TABLE eventos (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo                text   NOT NULL,
  origem              origem_evento_enum NOT NULL,
  entidade            text,
  entidade_id         bigint,
  payload             jsonb  NOT NULL DEFAULT '{}'::jsonb,
  chave_idempotencia  text   NOT NULL,
  correlation_id      uuid   NOT NULL DEFAULT gen_random_uuid(),
  status              status_evento_enum NOT NULL DEFAULT 'NOVO',
  usuario_id          bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  regras_disparadas   integer NOT NULL DEFAULT 0,
  processado_em       timestamptz,
  erro                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_evento_tipo CHECK (btrim(tipo) <> ''),
  CONSTRAINT ck_evento_chave CHECK (btrim(chave_idempotencia) <> '')
);

COMMENT ON COLUMN eventos.chave_idempotencia IS
  'Identidade do FATO, nao do registro: o mesmo fato gera a mesma chave e so entra uma vez (secao 22).';

CREATE UNIQUE INDEX uq_evento_idempotencia ON eventos (chave_idempotencia);
CREATE INDEX ix_eventos_novos ON eventos (created_at) WHERE status = 'NOVO';
CREATE INDEX ix_eventos_tipo ON eventos (tipo, created_at DESC);
CREATE INDEX ix_eventos_entidade ON eventos (entidade, entidade_id)
  WHERE entidade IS NOT NULL;
CREATE INDEX ix_eventos_correlation ON eventos (correlation_id);

-- -------------------------------------------------------------------------
-- Regras (secao 8)
-- -------------------------------------------------------------------------

/*
 * Condicao e acao ficam em jsonb, interpretados por um avaliador em codigo.
 *
 * A alternativa seria guardar expressao executavel - e ai a tabela de regras
 * viraria uma porta de execucao de codigo arbitrario para quem tiver acesso de
 * escrita nela. O avaliador entende um conjunto fechado de operadores sobre um
 * conjunto fechado de campos; o que nao esta no conjunto nao roda.
 */
CREATE TABLE automacao_regras (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo         text NOT NULL,
  nome           text NOT NULL,
  descricao      text,
  evento         text NOT NULL,
  condicao       jsonb NOT NULL DEFAULT '[]'::jsonb,
  acao           text NOT NULL,
  parametros     jsonb NOT NULL DEFAULT '{}'::jsonb,
  nivel          nivel_automacao_enum NOT NULL DEFAULT 'ASSISTIDO',
  prioridade     integer NOT NULL DEFAULT 100,
  perfil_autorizado text,
  versao         integer NOT NULL DEFAULT 1,
  ativo          boolean NOT NULL DEFAULT TRUE,
  vigencia_inicio date NOT NULL DEFAULT CURRENT_DATE,
  vigencia_fim    date,
  max_tentativas integer NOT NULL DEFAULT 3,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     bigint REFERENCES usuarios(id),
  updated_by     bigint REFERENCES usuarios(id),
  CONSTRAINT ck_regra_vigencia CHECK (vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio),
  CONSTRAINT ck_regra_tentativas CHECK (max_tentativas BETWEEN 1 AND 10)
);

CREATE UNIQUE INDEX uq_regra_codigo ON automacao_regras (upper(codigo));
CREATE INDEX ix_regras_evento ON automacao_regras (evento, prioridade) WHERE ativo;

-- -------------------------------------------------------------------------
-- Fila e execucoes (secoes 23 e 24)
-- -------------------------------------------------------------------------

/*
 * A fila mora no PostgreSQL, e nao em Redis, por uma razao concreta:
 * enfileirar a tarefa e gravar o dado que a originou acontecem na MESMA
 * transacao. Se a compra nao for gravada, a tarefa dela nao existe. Com uma
 * fila externa as duas coisas podem divergir - e divergem justamente quando
 * algo da errado.
 *
 * `disponivel_em` implementa o backoff: em vez de dormir, a tarefa que falhou
 * volta para a fila com data futura. Assim o worker nunca fica bloqueado
 * esperando, e reiniciar o processo nao perde o atraso combinado.
 *
 * O consumo usa FOR UPDATE SKIP LOCKED (no codigo), que da concorrencia real
 * entre varios workers sem corrida e sem lock global.
 */
CREATE TABLE automacao_fila (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evento_id       bigint REFERENCES eventos(id) ON DELETE CASCADE,
  regra_id        bigint REFERENCES automacao_regras(id) ON DELETE CASCADE,
  acao            text NOT NULL,
  parametros      jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id  uuid NOT NULL,
  prioridade      integer NOT NULL DEFAULT 100,
  status          status_execucao_automacao_enum NOT NULL DEFAULT 'PENDENTE',
  tentativa       integer NOT NULL DEFAULT 0,
  max_tentativas  integer NOT NULL DEFAULT 3,
  disponivel_em   timestamptz NOT NULL DEFAULT now(),
  iniciado_em     timestamptz,
  concluido_em    timestamptz,
  duracao_ms      integer,
  resultado       jsonb,
  erro            text,
  /* Fila morta: esgotou as tentativas e espera decisao humana (secao 23). */
  dead_letter     boolean NOT NULL DEFAULT FALSE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_fila_tentativa CHECK (tentativa >= 0)
);

CREATE INDEX ix_fila_pendente ON automacao_fila (prioridade, disponivel_em, id)
  WHERE status IN ('PENDENTE', 'RETRY') AND NOT dead_letter;
CREATE INDEX ix_fila_correlation ON automacao_fila (correlation_id);
CREATE INDEX ix_fila_dead_letter ON automacao_fila (created_at DESC) WHERE dead_letter;
CREATE INDEX ix_fila_regra ON automacao_fila (regra_id, created_at DESC);

/*
 * O historico de execucao e separado da fila, e append-only.
 *
 * A linha da fila e mutavel por natureza: muda de status, conta tentativa,
 * sai. Se o historico morasse nela, cada retry apagaria o registro do erro
 * anterior - e a secao 24 pede justamente "registrar numero de tentativas" e
 * "preservar contexto". Duas responsabilidades, duas tabelas.
 */
CREATE TABLE automacao_execucoes (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fila_id         bigint REFERENCES automacao_fila(id) ON DELETE SET NULL,
  regra_id        bigint REFERENCES automacao_regras(id) ON DELETE SET NULL,
  evento_id       bigint REFERENCES eventos(id) ON DELETE SET NULL,
  correlation_id  uuid NOT NULL,
  acao            text NOT NULL,
  status          status_execucao_automacao_enum NOT NULL,
  tentativa       integer NOT NULL DEFAULT 1,
  iniciado_em     timestamptz NOT NULL DEFAULT now(),
  concluido_em    timestamptz,
  duracao_ms      integer,
  resultado       jsonb,
  erro            text,
  usuario_id      bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_execucoes_correlation ON automacao_execucoes (correlation_id, created_at);
CREATE INDEX ix_execucoes_status ON automacao_execucoes (status, created_at DESC);
CREATE INDEX ix_execucoes_regra ON automacao_execucoes (regra_id, created_at DESC);

CREATE OR REPLACE FUNCTION fn_execucao_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'automacao_execucoes e o historico de execucao: nao se altera nem se apaga';
END;
$$;

CREATE TRIGGER trg_execucoes_imutavel
  BEFORE UPDATE OR DELETE ON automacao_execucoes
  FOR EACH ROW EXECUTE FUNCTION fn_execucao_imutavel();

-- -------------------------------------------------------------------------
-- Tarefas (secao 18)
-- -------------------------------------------------------------------------

CREATE TABLE tarefas (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo           text NOT NULL,
  titulo         text NOT NULL,
  descricao      text,
  acao_sugerida  text,
  responsavel_id bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  perfil_destino text,
  prioridade     prioridade_tarefa_enum NOT NULL DEFAULT 'MEDIA',
  prazo          date,
  status         status_tarefa_enum NOT NULL DEFAULT 'PENDENTE',
  origem         text NOT NULL,
  entidade       text,
  entidade_id    bigint,
  link           text,
  correlation_id uuid,
  evento_id      bigint REFERENCES eventos(id) ON DELETE SET NULL,
  chave_dedup    text,
  /* SLA da tarefa (secoes 19 e 20). */
  sla_horas      integer,
  sla_vence_em   timestamptz,
  sla_status     status_sla_enum NOT NULL DEFAULT 'DENTRO',
  nivel_escalonamento integer NOT NULL DEFAULT 0,
  escalonado_em  timestamptz,
  concluida_em   timestamptz,
  concluida_por  bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  observacao     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_tarefa_titulo CHECK (btrim(titulo) <> ''),
  CONSTRAINT ck_tarefa_conclusao CHECK (
    status <> 'CONCLUIDA' OR concluida_em IS NOT NULL),
  CONSTRAINT ck_tarefa_escalonamento CHECK (nivel_escalonamento BETWEEN 0 AND 3)
);

-- A mesma pendencia nao vira duas tarefas enquanto a primeira estiver aberta.
CREATE UNIQUE INDEX uq_tarefa_dedup ON tarefas (chave_dedup)
  WHERE chave_dedup IS NOT NULL AND status IN ('PENDENTE', 'EM_ANDAMENTO');
CREATE INDEX ix_tarefas_abertas ON tarefas (prioridade, prazo NULLS LAST)
  WHERE status IN ('PENDENTE', 'EM_ANDAMENTO');
CREATE INDEX ix_tarefas_responsavel ON tarefas (responsavel_id, status);
CREATE INDEX ix_tarefas_sla ON tarefas (sla_vence_em)
  WHERE status IN ('PENDENTE', 'EM_ANDAMENTO') AND sla_vence_em IS NOT NULL;
CREATE INDEX ix_tarefas_correlation ON tarefas (correlation_id);

-- -------------------------------------------------------------------------
-- Aprovacoes genericas (secoes 15, 16 e 33)
-- -------------------------------------------------------------------------

/*
 * Esta tabela NAO substitui `pedido_aprovacoes` nem `recebimento_aprovacoes`.
 *
 * Aquelas continuam donas do fluxo de aprovacao de pedido e de recebimento,
 * com as regras dos modulos 07 e 09. Esta cobre o que nao tinha dono: a
 * aprovacao de EXCECAO da secao 16 (fornecedor nao principal, preco acima do
 * historico, MOQ superior...) e a acao de automacao de nivel APROVACAO da
 * secao 33.
 *
 * A faixa de alcada vem de `alcadas_aprovacao`, que ja existe desde o modulo
 * 05 - reimplementar as faixas aqui criaria duas respostas para "quem aprova
 * quanto".
 */
CREATE TABLE aprovacoes (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo           text NOT NULL,
  titulo         text NOT NULL,
  descricao      text,
  entidade       text NOT NULL,
  entidade_id    bigint,
  valor_avaliado numeric(16,2),
  alcada_id      bigint REFERENCES alcadas_aprovacao(id) ON DELETE SET NULL,
  perfil_exigido text,
  nivel          integer NOT NULL DEFAULT 1,
  status         status_aprovacao_enum NOT NULL DEFAULT 'PENDENTE',
  /* Excecao (secao 16): o motivo e obrigatorio, e a constraint garante. */
  excecao        boolean NOT NULL DEFAULT FALSE,
  motivo_excecao text,
  impacto        text,
  solicitante_id bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  aprovador_id   bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  justificativa  text,
  decidido_em    timestamptz,
  prazo          timestamptz,
  sla_status     status_sla_enum NOT NULL DEFAULT 'DENTRO',
  correlation_id uuid,
  fila_id        bigint REFERENCES automacao_fila(id) ON DELETE SET NULL,
  chave_dedup    text,
  contexto       jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_aprovacao_excecao CHECK (NOT excecao OR btrim(coalesce(motivo_excecao,'')) <> ''),
  CONSTRAINT ck_aprovacao_decisao CHECK (
    status = 'PENDENTE' OR decidido_em IS NOT NULL),
  CONSTRAINT ck_aprovacao_rejeicao CHECK (
    status <> 'REJEITADA' OR btrim(coalesce(justificativa,'')) <> '')
);

CREATE UNIQUE INDEX uq_aprovacao_dedup ON aprovacoes (chave_dedup)
  WHERE chave_dedup IS NOT NULL AND status = 'PENDENTE';
CREATE INDEX ix_aprovacoes_pendentes ON aprovacoes (nivel, created_at)
  WHERE status = 'PENDENTE';
CREATE INDEX ix_aprovacoes_entidade ON aprovacoes (entidade, entidade_id);
CREATE INDEX ix_aprovacoes_correlation ON aprovacoes (correlation_id);

-- -------------------------------------------------------------------------
-- Jobs (secao 21)
-- -------------------------------------------------------------------------

/*
 * `executando_desde` e `instancia` formam a trava distribuida.
 *
 * Duas instancias da API subindo ao mesmo tempo tentariam rodar o mesmo job.
 * A trava e adquirida por UPDATE condicional - quem conseguir mudar a linha
 * executa, quem nao conseguir segue adiante -, o que e atomico no banco sem
 * precisar de coordenacao externa.
 *
 * `executando_desde` tambem resolve o worker morto: uma trava mais velha que o
 * timeout e considerada orfa e pode ser tomada. Sem isso, um processo derrubado
 * no meio de um job o deixaria travado para sempre.
 */
CREATE TABLE jobs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo            text NOT NULL,
  nome              text NOT NULL,
  descricao         text,
  frequencia        frequencia_job_enum NOT NULL,
  /* Hora do dia para jobs diarios, semanais e mensais. */
  hora              smallint,
  minuto            smallint NOT NULL DEFAULT 0,
  dia_semana        smallint,
  dia_mes           smallint,
  intervalo_minutos integer,
  ativo             boolean NOT NULL DEFAULT TRUE,
  status            status_job_enum NOT NULL DEFAULT 'OCIOSO',
  ultima_execucao   timestamptz,
  proxima_execucao  timestamptz,
  executando_desde  timestamptz,
  instancia         text,
  timeout_segundos  integer NOT NULL DEFAULT 600,
  execucoes         integer NOT NULL DEFAULT 0,
  falhas            integer NOT NULL DEFAULT 0,
  ultimo_erro       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_job_hora CHECK (hora IS NULL OR hora BETWEEN 0 AND 23),
  CONSTRAINT ck_job_minuto CHECK (minuto BETWEEN 0 AND 59),
  CONSTRAINT ck_job_dia_semana CHECK (dia_semana IS NULL OR dia_semana BETWEEN 0 AND 6),
  CONSTRAINT ck_job_dia_mes CHECK (dia_mes IS NULL OR dia_mes BETWEEN 1 AND 28)
);

CREATE UNIQUE INDEX uq_job_codigo ON jobs (upper(codigo));
CREATE INDEX ix_jobs_proxima ON jobs (proxima_execucao) WHERE ativo;

CREATE TABLE job_execucoes (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id          bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  correlation_id  uuid NOT NULL DEFAULT gen_random_uuid(),
  disparado_por   text NOT NULL DEFAULT 'AGENDADOR',
  usuario_id      bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  status          status_execucao_automacao_enum NOT NULL DEFAULT 'PROCESSANDO',
  iniciado_em     timestamptz NOT NULL DEFAULT now(),
  concluido_em    timestamptz,
  duracao_ms      integer,
  eventos_gerados integer NOT NULL DEFAULT 0,
  resultado       jsonb,
  erro            text
);

CREATE INDEX ix_job_execucoes_job ON job_execucoes (job_id, iniciado_em DESC);
CREATE INDEX ix_job_execucoes_status ON job_execucoes (status, iniciado_em DESC);

-- -------------------------------------------------------------------------
-- Webhooks (secao 27)
-- -------------------------------------------------------------------------

/*
 * Guarda tambem os REJEITADOS, com o motivo.
 *
 * Uma assinatura invalida chegando de madrugada e exatamente o que se quer
 * poder auditar depois. Por isso a tabela e append-only: um log que o proprio
 * sistema consegue reescrever nao e log.
 *
 * `chave_idempotencia` vem do cabecalho do emissor quando ele manda um; sem
 * ele, e derivada do corpo. Reentrega do mesmo webhook - comum quando o
 * emissor nao recebe o ACK a tempo - nao processa duas vezes.
 */
CREATE TABLE webhooks_recebidos (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  integracao         text NOT NULL,
  evento             text,
  payload            jsonb NOT NULL,
  cabecalhos         jsonb,
  assinatura         text,
  ip                 text,
  chave_idempotencia text NOT NULL,
  status             status_webhook_enum NOT NULL DEFAULT 'RECEBIDO',
  motivo_rejeicao    text,
  evento_id          bigint REFERENCES eventos(id) ON DELETE SET NULL,
  correlation_id     uuid,
  processado_em      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_webhook_idempotencia
  ON webhooks_recebidos (integracao, chave_idempotencia);
CREATE INDEX ix_webhooks_integracao ON webhooks_recebidos (integracao, created_at DESC);
CREATE INDEX ix_webhooks_rejeitados ON webhooks_recebidos (created_at DESC)
  WHERE status IN ('REJEITADO', 'ERRO');

CREATE OR REPLACE FUNCTION fn_webhook_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'webhooks_recebidos e o log de integracao: nao se apaga';
  END IF;
  -- Atualizar o status do processamento e legitimo; reescrever o que chegou, nao.
  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.assinatura IS DISTINCT FROM OLD.assinatura
     OR NEW.integracao IS DISTINCT FROM OLD.integracao
     OR NEW.chave_idempotencia IS DISTINCT FROM OLD.chave_idempotencia THEN
    RAISE EXCEPTION 'o conteudo recebido de um webhook nao pode ser alterado';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_webhooks_imutavel
  BEFORE UPDATE OR DELETE ON webhooks_recebidos
  FOR EACH ROW EXECUTE FUNCTION fn_webhook_imutavel();

/* Integracoes cadastradas: o segredo de assinatura por origem (secao 27). */
CREATE TABLE integracoes (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo         text NOT NULL,
  nome           text NOT NULL,
  tipo           text NOT NULL,
  direcao        text NOT NULL DEFAULT 'ENTRADA',
  ativo          boolean NOT NULL DEFAULT TRUE,
  /*
   * Guarda o HASH do segredo, nunca o segredo.
   *
   * O prompt e explicito em nao armazenar credencial em texto puro. Para
   * conferir uma assinatura HMAC seria preciso o segredo em claro - entao o
   * sistema nao confere HMAC com segredo guardado: ele compara o hash do
   * token apresentado com o hash guardado, que e o que da para fazer sem
   * manter o segredo recuperavel.
   */
  segredo_hash   text,
  ultima_sincronizacao timestamptz,
  ultimo_status  text,
  registros_processados integer NOT NULL DEFAULT 0,
  erros          integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_integracao_codigo ON integracoes (upper(codigo));

-- -------------------------------------------------------------------------
-- SLA (secao 19)
-- -------------------------------------------------------------------------

CREATE TABLE sla_politicas (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo          text NOT NULL,
  nome            text NOT NULL,
  etapa           text NOT NULL,
  horas           integer NOT NULL,
  /* Percentual do prazo a partir do qual entra em risco. */
  alerta_percentual smallint NOT NULL DEFAULT 80,
  escalonar_nivel1_horas integer,
  escalonar_nivel2_horas integer,
  escalonar_nivel3_horas integer,
  perfil_nivel1   text,
  perfil_nivel2   text,
  perfil_nivel3   text,
  ativo           boolean NOT NULL DEFAULT TRUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_sla_horas CHECK (horas > 0),
  CONSTRAINT ck_sla_alerta CHECK (alerta_percentual BETWEEN 1 AND 100)
);

CREATE UNIQUE INDEX uq_sla_codigo ON sla_politicas (upper(codigo));

-- -------------------------------------------------------------------------
-- Notificacoes: evolucao, nao substituicao (secao 17)
-- -------------------------------------------------------------------------

ALTER TABLE notificacoes
  ADD COLUMN canal          canal_notificacao_enum NOT NULL DEFAULT 'SISTEMA',
  ADD COLUMN tipo           text,
  ADD COLUMN status         status_notificacao_enum NOT NULL DEFAULT 'ENVIADA',
  ADD COLUMN enviada_em     timestamptz,
  ADD COLUMN erro           text,
  ADD COLUMN tentativas     integer NOT NULL DEFAULT 0,
  ADD COLUMN correlation_id uuid,
  ADD COLUMN chave_dedup    text,
  ADD COLUMN link           text;

COMMENT ON COLUMN notificacoes.canal IS
  'A tabela so conhecia o canal SISTEMA; os demais canais da secao 17 entram por aqui.';

-- A mesma notificacao nao e enviada duas vezes ao mesmo usuario (secao 22).
CREATE UNIQUE INDEX uq_notificacao_dedup ON notificacoes (chave_dedup)
  WHERE chave_dedup IS NOT NULL;
CREATE INDEX ix_notificacoes_pendentes ON notificacoes (created_at)
  WHERE status = 'PENDENTE';
CREATE INDEX ix_notificacoes_correlation ON notificacoes (correlation_id);

-- As notificacoes que ja existiam foram entregues na tela.
UPDATE notificacoes SET enviada_em = created_at WHERE enviada_em IS NULL;

-- -------------------------------------------------------------------------
-- updated_at e auditoria
-- -------------------------------------------------------------------------

CREATE TRIGGER trg_automacao_regras_updated_at BEFORE UPDATE ON automacao_regras
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_automacao_regras_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON automacao_regras
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();
CREATE TRIGGER trg_tarefas_updated_at BEFORE UPDATE ON tarefas
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_aprovacoes_updated_at BEFORE UPDATE ON aprovacoes
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_aprovacoes_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON aprovacoes
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();
CREATE TRIGGER trg_jobs_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_sla_updated_at BEFORE UPDATE ON sla_politicas
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_integracoes_updated_at BEFORE UPDATE ON integracoes
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- -------------------------------------------------------------------------
-- Classificacao dos alertas novos
-- -------------------------------------------------------------------------

INSERT INTO alertas_tipos (tipo, categoria, prioridade, titulo_padrao, origem_padrao) VALUES
  ('AUTOMACAO_FALHOU',  'governanca', 'ALTO',  'Automacao falhou',            'Modulo 13 - Orquestracao'),
  ('SLA_VENCIDO',       'governanca', 'ALTO',  'SLA vencido',                 'Modulo 13 - Orquestracao'),
  ('TAREFA_ATRASADA',   'governanca', 'MEDIO', 'Tarefa atrasada',             'Modulo 13 - Orquestracao'),
  ('INTEGRACAO_FALHOU', 'governanca', 'ALTO',  'Falha de integracao',         'Modulo 13 - Orquestracao'),
  ('JOB_FALHOU',        'governanca', 'ALTO',  'Job automatico falhou',       'Modulo 13 - Orquestracao')
ON CONFLICT (tipo) DO NOTHING;

-- -------------------------------------------------------------------------
-- Permissoes (secao 36)
-- -------------------------------------------------------------------------

INSERT INTO permissoes (codigo, modulo, descricao) VALUES
  ('automacao.ler',       'automacao', 'Consultar automacoes, eventos, execucoes e monitoramento'),
  ('automacao.regra',     'automacao', 'Criar e editar regras de automacao'),
  ('automacao.executar',  'automacao', 'Disparar automacoes e jobs manualmente'),
  ('automacao.reprocessar','automacao','Reprocessar falhas e itens da fila morta'),
  ('automacao.tarefa',    'automacao', 'Assumir e concluir tarefas'),
  ('automacao.aprovar',   'automacao', 'Aprovar ou rejeitar solicitacoes e excecoes'),
  ('automacao.integracao','automacao', 'Configurar integracoes e webhooks'),
  ('automacao.operacao',  'automacao', 'Acessar o Centro de Operacoes')
ON CONFLICT (codigo) DO NOTHING;

-- ADMIN e GESTOR_COMPRAS: tudo.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.modulo = 'automacao' AND p.nome IN ('ADMIN', 'GESTOR_COMPRAS')
ON CONFLICT DO NOTHING;

-- COMPRADOR: ve, executa o que e seu, trata tarefa. Nao aprova nem configura.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo IN ('automacao.ler', 'automacao.tarefa', 'automacao.operacao')
   AND p.nome = 'COMPRADOR'
ON CONFLICT DO NOTHING;

-- ESTOQUE e QUALIDADE: leem e tratam tarefa do proprio dominio.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo IN ('automacao.ler', 'automacao.tarefa')
   AND p.nome IN ('ESTOQUE', 'QUALIDADE')
ON CONFLICT DO NOTHING;

-- DIRETORIA: ve tudo, aprova, e tem o Centro de Operacoes.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo IN ('automacao.ler', 'automacao.aprovar', 'automacao.operacao')
   AND p.nome = 'DIRETORIA'
ON CONFLICT DO NOTHING;

-- FINANCEIRO: ve e aprova por valor.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo IN ('automacao.ler', 'automacao.aprovar')
   AND p.nome = 'FINANCEIRO'
ON CONFLICT DO NOTHING;

-- -------------------------------------------------------------------------
-- Configuracoes (secoes 21, 23, 24 e 39)
-- -------------------------------------------------------------------------

INSERT INTO configuracoes (chave, valor, tipo, grupo, descricao) VALUES
  ('automacao.worker_ativo', 'true', 'BOOLEANO', 'automacao',
   'Liga o consumo automatico da fila dentro do processo da API'),
  ('automacao.worker_intervalo_ms', '5000', 'NUMERO', 'automacao',
   'Intervalo entre ciclos do worker da fila'),
  ('automacao.worker_lote', '10', 'NUMERO', 'automacao',
   'Itens da fila consumidos por ciclo'),
  ('automacao.max_tentativas', '3', 'NUMERO', 'automacao',
   'Tentativas antes de a execucao ir para a fila morta'),
  ('automacao.backoff_base_segundos', '30', 'NUMERO', 'automacao',
   'Base do backoff exponencial entre tentativas'),
  ('automacao.backoff_maximo_segundos', '3600', 'NUMERO', 'automacao',
   'Teto do intervalo entre tentativas'),
  ('automacao.timeout_acao_segundos', '120', 'NUMERO', 'automacao',
   'Tempo maximo de uma acao antes de ser considerada travada'),
  ('automacao.agendador_ativo', 'true', 'BOOLEANO', 'automacao',
   'Liga o agendador de jobs dentro do processo da API'),
  ('automacao.job_timeout_orfao_minutos', '30', 'NUMERO', 'automacao',
   'Tempo apos o qual a trava de um job e considerada orfa e pode ser tomada'),
  ('automacao.sla_padrao_horas', '24', 'NUMERO', 'automacao',
   'SLA usado quando a etapa nao tem politica propria'),
  ('automacao.webhook_tolerancia_minutos', '5', 'NUMERO', 'automacao',
   'Diferenca maxima entre o timestamp do webhook e a hora do servidor'),
  ('automacao.retencao_eventos_dias', '180', 'NUMERO', 'automacao',
   'Dias de retencao dos eventos processados'),
  ('automacao.notificar_falhas', 'true', 'BOOLEANO', 'automacao',
   'Gera alerta na central quando uma automacao vai para a fila morta')
ON CONFLICT (chave) DO NOTHING;
