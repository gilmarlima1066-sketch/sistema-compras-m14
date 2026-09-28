-- =========================================================================
-- MODULO 14 - ESTRUTURAS DA CAMADA DE INTEGRACAO (secao 38)
--
-- A secao 38 lista sete estruturas e manda "criar somente se nao houver
-- estruturas equivalentes". Auditado o banco (129 tabelas):
--
--   INTEGRACOES  -> JA EXISTE (modulo 13). E evoluida aqui, nao recriada:
--                   ganha sistema, modo de sincronizacao, conector, timeout,
--                   retry, limite e proxima sincronizacao. Os tres registros
--                   ja cadastrados (ERP, TRANSPORTADORA, FORNECEDOR_PORTAL)
--                   continuam valendo, com as mesmas chaves.
--   INTEGRACAO_MENSAGENS -> a FILA da secao 29, com retry (30) e dead letter
--                   (31), JA EXISTE como `automacao_fila` + `eventos`
--                   (modulo 13), testada e em uso. Criar uma segunda fila
--                   daria duas verdades sobre "o que esta pendente" e dois
--                   lugares para procurar quando algo some. A tabela criada
--                   aqui guarda o REGISTRO EXTERNO em si - o payload que
--                   chegou e o que virou - e delega o transporte a fila que
--                   ja funciona.
--   INTEGRACAO_ERROS -> `alertas` (modulos 02/11/12) ja notifica; `auditoria`
--                   (modulo 01) ja registra quem fez o que. Nenhuma das duas
--                   guarda payload de erro com tentativa e causa provavel,
--                   que e o que a secao 35 pede. Esta e nova.
--
-- As demais (CONECTORES, CREDENCIAIS, MAPEAMENTOS, EXECUCOES, TEMPLATES) nao
-- tem equivalente e sao criadas.
--
-- SOBRE IDEMPOTENCIA (secao 28)
--
-- "Nunca criar duas vezes produto, fornecedor, pedido, item, recebimento,
-- cotacao, evento." Como no modulo 13, a garantia e INDICE UNIQUE, nao
-- verificacao no codigo: duas execucoes simultaneas leem ao mesmo tempo, as
-- duas nao acham nada, as duas inserem. O banco e quem recusa a segunda.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. INTEGRACOES - evolucao da tabela do modulo 13
-- -------------------------------------------------------------------------

ALTER TABLE integracoes
  ADD COLUMN IF NOT EXISTS sistema             sistema_integrado_enum,
  ADD COLUMN IF NOT EXISTS conector            tipo_conector_enum,
  ADD COLUMN IF NOT EXISTS modo_sincronizacao  modo_sincronizacao_enum
                                               NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS status              status_conector_enum
                                               NOT NULL DEFAULT 'NAO_CONFIGURADO',
  ADD COLUMN IF NOT EXISTS versao              text NOT NULL DEFAULT '1.0',
  ADD COLUMN IF NOT EXISTS endpoint            text,
  ADD COLUMN IF NOT EXISTS configuracao        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS timeout_segundos    integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS max_tentativas      integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS backoff_base_segundos integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS limite_por_minuto   integer,
  ADD COLUMN IF NOT EXISTS limite_por_execucao integer NOT NULL DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS intervalo_minutos   integer,
  ADD COLUMN IF NOT EXISTS proxima_sincronizacao timestamptz,
  ADD COLUMN IF NOT EXISTS ultima_execucao_id  bigint,
  ADD COLUMN IF NOT EXISTS registros_enviados  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS registros_rejeitados integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS observacao          text,
  ADD COLUMN IF NOT EXISTS created_by          bigint REFERENCES usuarios(id),
  ADD COLUMN IF NOT EXISTS updated_by          bigint REFERENCES usuarios(id);

/*
 * `direcao` nasceu como texto livre no modulo 13. Vira enum agora, depois de
 * conferir que os tres valores gravados cabem - texto livre em coluna de
 * dominio fechado e um erro de digitacao esperando para virar filtro que nao
 * acha nada.
 */
ALTER TABLE integracoes
  ALTER COLUMN direcao DROP DEFAULT,
  ALTER COLUMN direcao TYPE direcao_integracao_enum
    USING upper(direcao)::direcao_integracao_enum,
  ALTER COLUMN direcao SET DEFAULT 'ENTRADA';

-- O mesmo para `tipo`, que no modulo 13 guardava o sistema ('ERP',
-- 'LOGISTICA', 'FORNECEDOR'). O valor migra para a coluna `sistema`, que e o
-- lugar certo dele, e `tipo` passa a guardar o protocolo.
UPDATE integracoes SET sistema = CASE upper(tipo)
    WHEN 'ERP'        THEN 'ERP'
    WHEN 'LOGISTICA'  THEN 'TRANSPORTADORA'
    WHEN 'FORNECEDOR' THEN 'FORNECEDOR'
    WHEN 'FISCAL'     THEN 'FISCAL'
    WHEN 'FINANCEIRO' THEN 'FINANCEIRO'
    ELSE 'OUTRO' END::sistema_integrado_enum
 WHERE sistema IS NULL;

-- As tres integracoes do modulo 13 nasceram como receptoras de webhook.
UPDATE integracoes SET conector = 'WEBHOOK' WHERE conector IS NULL;

ALTER TABLE integracoes
  ALTER COLUMN sistema  SET NOT NULL,
  ALTER COLUMN conector SET NOT NULL;

ALTER TABLE integracoes
  ADD CONSTRAINT ck_integracao_timeout
    CHECK (timeout_segundos BETWEEN 1 AND 600),
  ADD CONSTRAINT ck_integracao_tentativas
    CHECK (max_tentativas BETWEEN 1 AND 10),
  ADD CONSTRAINT ck_integracao_limite
    CHECK (limite_por_execucao BETWEEN 1 AND 1000000),
  -- Modo AGENDADO sem intervalo nunca roda, e o painel mostraria "proxima
  -- sincronizacao: nunca" sem explicar por que. O banco recusa a combinacao.
  ADD CONSTRAINT ck_integracao_agendamento
    CHECK (modo_sincronizacao <> 'AGENDADO' OR intervalo_minutos IS NOT NULL);

CREATE INDEX IF NOT EXISTS ix_integracoes_proxima
  ON integracoes (proxima_sincronizacao)
  WHERE ativo AND modo_sincronizacao = 'AGENDADO';

CREATE INDEX IF NOT EXISTS ix_integracoes_sistema ON integracoes (sistema, ativo);

COMMENT ON COLUMN integracoes.tipo IS
  'Coluna legada do modulo 14 em diante: o protocolo esta em `conector` e o '
  'sistema em `sistema`. Mantida porque o modulo 13 a gravava.';

-- -------------------------------------------------------------------------
-- 2. CREDENCIAIS (secoes 25 e 37)
-- -------------------------------------------------------------------------

/*
 * "Nunca armazenar credenciais em texto puro" (secao 25).
 *
 * A tabela guarda `referencia_segura` - um PONTEIRO para onde o segredo vive
 * (variavel de ambiente, arquivo do cofre, secrets manager), nunca o segredo.
 * Quem ler a tabela inteira descobre que existe uma credencial de API do ERP e
 * onde procurar por ela; nao descobre o valor.
 *
 * `impressao_digital` e um SHA-256 do segredo, guardado para duas coisas que
 * nao exigem conhecer o valor: confirmar que a credencial mudou de fato numa
 * rotacao, e detectar que dois ambientes estao usando o mesmo segredo.
 */
CREATE TABLE integracao_credenciais (
  id                  bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  integracao_id       bigint NOT NULL REFERENCES integracoes(id) ON DELETE CASCADE,
  nome                text NOT NULL,
  tipo                tipo_autenticacao_enum NOT NULL,
  ambiente            ambiente_enum NOT NULL DEFAULT 'DESENVOLVIMENTO',
  referencia_segura   text NOT NULL,
  impressao_digital   text,
  /* Campos NAO sigilosos da autenticacao: usuario do Basic, nome do header da
     API Key, URL do token OAuth2. O segredo correspondente continua fora. */
  parametros          jsonb NOT NULL DEFAULT '{}'::jsonb,
  expira_em           timestamptz,
  rotacionada_em      timestamptz,
  ultima_utilizacao   timestamptz,
  ativo               boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          bigint REFERENCES usuarios(id),

  -- Uma credencial ativa por tipo e ambiente. Duas ativas fariam o conector
  -- escolher em silencio, e a escolha mudaria com a ordem das linhas.
  CONSTRAINT ck_credencial_referencia
    CHECK (btrim(referencia_segura) <> ''),
  -- A referencia nao pode PARECER um segredo. E uma trava grosseira de
  -- proposito: pega o caso comum de alguem colar o token no campo errado.
  CONSTRAINT ck_credencial_nao_e_segredo
    CHECK (referencia_segura !~* '^(bearer|basic)\s' AND length(referencia_segura) <= 200)
);

CREATE UNIQUE INDEX uq_credencial_ativa
  ON integracao_credenciais (integracao_id, tipo, ambiente)
  WHERE ativo;

CREATE INDEX ix_credenciais_expiracao
  ON integracao_credenciais (expira_em)
  WHERE ativo AND expira_em IS NOT NULL;

COMMENT ON COLUMN integracao_credenciais.referencia_segura IS
  'PONTEIRO para o segredo (ex.: env:ERP_API_KEY), nunca o segredo.';

-- -------------------------------------------------------------------------
-- 3. MAPEAMENTOS (secoes 12 e 26)
-- -------------------------------------------------------------------------

/*
 * Um mapeamento pertence a um TEMPLATE, nao diretamente a integracao.
 *
 * A secao 12 pede "salvar modelos de mapeamento reutilizaveis". Se o
 * mapeamento pendurasse na integracao, o layout de planilha que o fornecedor A
 * manda nao poderia ser reaproveitado para o fornecedor B que usa o mesmo
 * layout - e na pratica eles usam, porque o layout costuma vir do mesmo ERP.
 */
CREATE TABLE integracao_templates (
  id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  codigo          text NOT NULL,
  nome            text NOT NULL,
  descricao       text,
  entidade        text NOT NULL,
  formato         formato_arquivo_enum,
  /* Null = template generico, utilizavel por qualquer integracao. */
  integracao_id   bigint REFERENCES integracoes(id) ON DELETE CASCADE,
  configuracao    jsonb NOT NULL DEFAULT '{}'::jsonb,
  /* Quantas linhas pular e onde esta o cabecalho: relatorio de ERP costuma ter
     titulo e filtros antes da primeira linha util. */
  linha_cabecalho integer NOT NULL DEFAULT 1,
  separador       text,
  codificacao     text NOT NULL DEFAULT 'utf8',
  ativo           boolean NOT NULL DEFAULT true,
  vezes_usado     integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      bigint REFERENCES usuarios(id),

  CONSTRAINT ck_template_cabecalho CHECK (linha_cabecalho BETWEEN 1 AND 100)
);

CREATE UNIQUE INDEX uq_template_codigo ON integracao_templates (upper(codigo));
CREATE INDEX ix_templates_entidade ON integracao_templates (entidade) WHERE ativo;

CREATE TABLE integracao_mapeamentos (
  id                bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  template_id       bigint NOT NULL REFERENCES integracao_templates(id) ON DELETE CASCADE,
  campo_externo     text NOT NULL,
  campo_interno     text NOT NULL,
  /* Nome da transformacao do catalogo (texto, numero, data, cnpj, ean...). */
  transformacao     text,
  parametros        jsonb NOT NULL DEFAULT '{}'::jsonb,
  obrigatorio       boolean NOT NULL DEFAULT false,
  valor_padrao      text,
  ordem             integer NOT NULL DEFAULT 0,
  observacao        text,
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- O mesmo campo externo nao pode apontar para dois destinos no mesmo
  -- template: qual venceria dependeria da ordem de leitura.
  CONSTRAINT ck_mapeamento_campos
    CHECK (btrim(campo_externo) <> '' AND btrim(campo_interno) <> '')
);

CREATE UNIQUE INDEX uq_mapeamento_externo
  ON integracao_mapeamentos (template_id, upper(campo_externo));

CREATE INDEX ix_mapeamentos_template ON integracao_mapeamentos (template_id, ordem);

-- -------------------------------------------------------------------------
-- 4. EXECUCOES (secoes 32 e 33)
-- -------------------------------------------------------------------------

CREATE TABLE integracao_execucoes (
  id                  bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  integracao_id       bigint REFERENCES integracoes(id) ON DELETE SET NULL,
  integracao_codigo   text,
  tipo                tipo_execucao_integracao_enum NOT NULL,
  direcao             direcao_integracao_enum NOT NULL,
  entidade            text,
  status              status_execucao_integracao_enum NOT NULL DEFAULT 'EXECUTANDO',
  modo                modo_sincronizacao_enum NOT NULL DEFAULT 'MANUAL',
  ambiente            ambiente_enum NOT NULL DEFAULT 'DESENVOLVIMENTO',
  iniciado_em         timestamptz NOT NULL DEFAULT now(),
  concluido_em        timestamptz,
  duracao_ms          integer,
  registros_lidos     integer NOT NULL DEFAULT 0,
  registros_criados   integer NOT NULL DEFAULT 0,
  registros_atualizados integer NOT NULL DEFAULT 0,
  registros_descartados integer NOT NULL DEFAULT 0,
  registros_rejeitados  integer NOT NULL DEFAULT 0,
  /* Marca d'agua da sincronizacao incremental: ate onde esta execucao leu. */
  marca_inicio        text,
  marca_fim           text,
  correlation_id      uuid NOT NULL DEFAULT gen_random_uuid(),
  disparado_por       text NOT NULL DEFAULT 'MANUAL',
  usuario_id          bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  resumo              jsonb,
  erro                text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_integracao_execucoes_integracao
  ON integracao_execucoes (integracao_id, iniciado_em DESC);
CREATE INDEX ix_integracao_execucoes_status
  ON integracao_execucoes (status, iniciado_em DESC);
CREATE INDEX ix_integracao_execucoes_correlation
  ON integracao_execucoes (correlation_id);

ALTER TABLE integracoes
  ADD CONSTRAINT integracoes_ultima_execucao_fkey
  FOREIGN KEY (ultima_execucao_id) REFERENCES integracao_execucoes(id) ON DELETE SET NULL;

-- -------------------------------------------------------------------------
-- 5. MENSAGENS - o registro externo, nao o transporte (secoes 28, 29 e 32)
-- -------------------------------------------------------------------------

/*
 * Esta tabela NAO e uma segunda fila.
 *
 * A fila com retry, backoff e dead letter e a `automacao_fila` do modulo 13,
 * que ja funciona. O que falta la e o que sobra aqui: o payload externo como
 * chegou, a chave natural que o identifica no sistema de origem, e o registro
 * interno que ele virou.
 *
 * `chave_externa` + `hash_conteudo` sao o coracao da secao 14 (importacao
 * incremental) e da 28 (idempotencia). A chave diz QUEM e o registro la fora;
 * o hash diz se ele MUDOU. Com os dois: chave conhecida e hash igual -> nada a
 * fazer; chave conhecida e hash diferente -> atualizar; chave nova -> criar.
 */
CREATE TABLE integracao_mensagens (
  id                bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  integracao_id     bigint REFERENCES integracoes(id) ON DELETE SET NULL,
  integracao_codigo text,
  execucao_id       bigint REFERENCES integracao_execucoes(id) ON DELETE SET NULL,
  direcao           direcao_integracao_enum NOT NULL,
  entidade          text NOT NULL,
  origem            origem_registro_enum NOT NULL,

  chave_externa     text NOT NULL,
  hash_conteudo     text NOT NULL,
  versao_externa    text,
  atualizado_na_origem timestamptz,

  payload           jsonb NOT NULL,
  normalizado       jsonb,

  status            status_mensagem_enum NOT NULL DEFAULT 'PENDENTE',
  tentativa         integer NOT NULL DEFAULT 0,
  max_tentativas    integer NOT NULL DEFAULT 3,
  disponivel_em     timestamptz NOT NULL DEFAULT now(),
  dead_letter       boolean NOT NULL DEFAULT false,

  /* Para onde o registro foi, quando virou algo. */
  entidade_destino  text,
  registro_id       bigint,
  acao_aplicada     text,

  evento_id         bigint REFERENCES eventos(id) ON DELETE SET NULL,
  fila_id           bigint REFERENCES automacao_fila(id) ON DELETE SET NULL,
  correlation_id    uuid,
  erro              text,
  processado_em     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_mensagem_chave CHECK (btrim(chave_externa) <> ''),
  CONSTRAINT ck_mensagem_tentativa CHECK (tentativa >= 0 AND tentativa <= max_tentativas)
);

/*
 * A idempotencia da secao 28, no banco.
 *
 * Um registro externo e unico por integracao + entidade + chave. Reimportar o
 * mesmo arquivo nao cria a segunda linha: o INSERT colide e o codigo decide
 * entre descartar (hash igual) e atualizar (hash diferente).
 */
CREATE UNIQUE INDEX uq_mensagem_chave
  ON integracao_mensagens (integracao_codigo, entidade, chave_externa);

CREATE INDEX ix_mensagens_pendentes
  ON integracao_mensagens (disponivel_em)
  WHERE status IN ('PENDENTE', 'RETRY') AND NOT dead_letter;

CREATE INDEX ix_mensagens_execucao ON integracao_mensagens (execucao_id, status);
CREATE INDEX ix_mensagens_dead_letter
  ON integracao_mensagens (created_at DESC) WHERE dead_letter;
CREATE INDEX ix_mensagens_destino
  ON integracao_mensagens (entidade_destino, registro_id)
  WHERE registro_id IS NOT NULL;

-- -------------------------------------------------------------------------
-- 6. ERROS (secao 35)
-- -------------------------------------------------------------------------

CREATE TABLE integracao_erros (
  id                bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  integracao_id     bigint REFERENCES integracoes(id) ON DELETE SET NULL,
  integracao_codigo text,
  execucao_id       bigint REFERENCES integracao_execucoes(id) ON DELETE SET NULL,
  mensagem_id       bigint REFERENCES integracao_mensagens(id) ON DELETE SET NULL,
  entidade          text,
  linha             integer,
  tipo              tipo_erro_integracao_enum NOT NULL,
  classe            classe_erro_enum NOT NULL DEFAULT 'DESCONHECIDO',
  mensagem          text NOT NULL,
  detalhe           jsonb,
  /* O payload que causou o erro, ja higienizado: sem header de autorizacao e
     sem token, porque esta tabela e um log e a secao 37 proibe. */
  payload           jsonb,
  tentativa         integer NOT NULL DEFAULT 1,

  /*
   * Secao 35: a IA pode sugerir a causa provavel, "mas devera diferencia-la de
   * um erro confirmado". Por isso sao duas colunas e nao uma. `causa_provavel`
   * e palpite com origem declarada; `solucao_sugerida` e o que fazer. Nenhuma
   * das duas vira verdade sem alguem confirmar.
   */
  causa_provavel    text,
  origem_diagnostico text,
  confianca_diagnostico text,
  solucao_sugerida  text,
  confirmado        boolean NOT NULL DEFAULT false,

  status            status_erro_integracao_enum NOT NULL DEFAULT 'ABERTO',
  resolvido_em      timestamptz,
  resolvido_por     bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  observacao        text,
  ocorrencias       integer NOT NULL DEFAULT 1,
  chave_dedup       text,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_erro_resolucao
    CHECK (status NOT IN ('RESOLVIDO', 'IGNORADO') OR resolvido_em IS NOT NULL),
  -- Palpite sem origem declarada e palpite anonimo. A secao 35 exige saber de
  -- onde veio para poder pesar.
  CONSTRAINT ck_erro_diagnostico
    CHECK (causa_provavel IS NULL OR btrim(coalesce(origem_diagnostico, '')) <> '')
);

CREATE UNIQUE INDEX uq_erro_dedup
  ON integracao_erros (chave_dedup)
  WHERE chave_dedup IS NOT NULL AND status = 'ABERTO';

CREATE INDEX ix_erros_abertos
  ON integracao_erros (created_at DESC) WHERE status = 'ABERTO';
CREATE INDEX ix_erros_integracao ON integracao_erros (integracao_id, created_at DESC);
CREATE INDEX ix_erros_tipo ON integracao_erros (tipo, classe);

-- -------------------------------------------------------------------------
-- 7. IMPORTACOES (secoes 11 a 14)
-- -------------------------------------------------------------------------

CREATE TABLE importacoes (
  id                bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  nome_arquivo      text NOT NULL,
  formato           formato_arquivo_enum NOT NULL,
  entidade          text NOT NULL,
  origem            origem_registro_enum NOT NULL DEFAULT 'EXCEL',
  integracao_id     bigint REFERENCES integracoes(id) ON DELETE SET NULL,
  template_id       bigint REFERENCES integracao_templates(id) ON DELETE SET NULL,
  execucao_id       bigint REFERENCES integracao_execucoes(id) ON DELETE SET NULL,

  caminho           text,
  tamanho_bytes     bigint,
  /* SHA-256 do arquivo inteiro: reenviar o mesmo arquivo e reconhecido antes
     de ler uma linha sequer (secao 14). */
  hash_arquivo      text,

  status            status_importacao_enum NOT NULL DEFAULT 'RECEBIDO',
  linha_cabecalho   integer NOT NULL DEFAULT 1,
  colunas_detectadas jsonb,
  mapeamento        jsonb,

  total_linhas      integer NOT NULL DEFAULT 0,
  linhas_validas    integer NOT NULL DEFAULT 0,
  linhas_com_erro   integer NOT NULL DEFAULT 0,
  linhas_com_alerta integer NOT NULL DEFAULT 0,
  registros_criados integer NOT NULL DEFAULT 0,
  registros_atualizados integer NOT NULL DEFAULT 0,
  registros_descartados integer NOT NULL DEFAULT 0,

  amostra           jsonb,
  resumo            jsonb,
  erro              text,

  analisado_em      timestamptz,
  confirmado_em     timestamptz,
  confirmado_por    bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  concluido_em      timestamptz,
  duracao_ms        integer,

  usuario_id        bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- O processamento so acontece depois da confirmacao humana (secao 11).
  CONSTRAINT ck_importacao_confirmacao
    CHECK (status NOT IN ('PROCESSANDO', 'CONCLUIDA', 'CONCLUIDA_COM_ERROS')
           OR confirmado_em IS NOT NULL)
);

CREATE INDEX ix_importacoes_status ON importacoes (status, created_at DESC);
CREATE INDEX ix_importacoes_entidade ON importacoes (entidade, created_at DESC);
CREATE INDEX ix_importacoes_hash ON importacoes (hash_arquivo) WHERE hash_arquivo IS NOT NULL;

/* Erros por linha, para o relatorio baixavel da secao 13. */
CREATE TABLE importacao_ocorrencias (
  id             bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  importacao_id  bigint NOT NULL REFERENCES importacoes(id) ON DELETE CASCADE,
  linha          integer NOT NULL,
  coluna         text,
  campo          text,
  severidade     severidade_validacao_enum NOT NULL,
  regra          text NOT NULL,
  mensagem       text NOT NULL,
  valor          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_ocorrencias_importacao
  ON importacao_ocorrencias (importacao_id, severidade, linha);

-- -------------------------------------------------------------------------
-- 8. EXPORTACOES (secao 40)
-- -------------------------------------------------------------------------

CREATE TABLE exportacoes (
  id             bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  entidade       text NOT NULL,
  formato        formato_exportacao_enum NOT NULL,
  nome_arquivo   text NOT NULL,
  filtros        jsonb NOT NULL DEFAULT '{}'::jsonb,
  colunas        jsonb,
  total_linhas   integer NOT NULL DEFAULT 0,
  tamanho_bytes  bigint,
  /* Secao 40: exportacao sensivel vai para auditoria. A coluna marca quais
     sao, para o filtro da auditoria nao depender de adivinhar pelo nome. */
  sensivel       boolean NOT NULL DEFAULT false,
  motivo         text,
  duracao_ms     integer,
  usuario_id     bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  ip             text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_exportacoes_usuario ON exportacoes (usuario_id, created_at DESC);
CREATE INDEX ix_exportacoes_sensiveis
  ON exportacoes (created_at DESC) WHERE sensivel;

-- -------------------------------------------------------------------------
-- 9. CONCILIACAO (secao 34)
-- -------------------------------------------------------------------------

/*
 * "Nunca corrigir automaticamente sem regra autorizada" (secao 34).
 *
 * A tabela registra a divergencia e PARA. Nao ha coluna de "corrigido
 * automaticamente" porque nao existe esse caminho: quem aceita o valor externo
 * e uma pessoa, e a aceitacao fica registrada com nome e justificativa.
 */
CREATE TABLE conciliacoes (
  id                bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  integracao_id     bigint REFERENCES integracoes(id) ON DELETE SET NULL,
  execucao_id       bigint REFERENCES integracao_execucoes(id) ON DELETE SET NULL,
  entidade          text NOT NULL,
  chave_externa     text NOT NULL,
  referencia_id     bigint,
  campo             text NOT NULL,
  valor_interno     numeric(18,4),
  valor_externo     numeric(18,4),
  diferenca         numeric(18,4) GENERATED ALWAYS AS
                      (coalesce(valor_externo, 0) - coalesce(valor_interno, 0)) STORED,
  diferenca_percentual numeric(10,4),
  unidade           text,
  tolerancia        numeric(18,4),
  status            status_conciliacao_enum NOT NULL DEFAULT 'DIVERGENTE',
  alerta_id         bigint REFERENCES alertas(id) ON DELETE SET NULL,
  tarefa_id         bigint REFERENCES tarefas(id) ON DELETE SET NULL,
  decidido_por      bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  decidido_em       timestamptz,
  justificativa     text,
  chave_dedup       text,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_conciliacao_decisao
    CHECK (status = 'DIVERGENTE' OR status = 'EM_ANALISE' OR decidido_em IS NOT NULL),
  -- Aceitar o valor externo muda o que o sistema considera verdade. Exige
  -- justificativa escrita, como a aprovacao de excecao do modulo 13.
  CONSTRAINT ck_conciliacao_aceite
    CHECK (status <> 'ACEITO' OR btrim(coalesce(justificativa, '')) <> '')
);

CREATE UNIQUE INDEX uq_conciliacao_dedup
  ON conciliacoes (chave_dedup)
  WHERE chave_dedup IS NOT NULL AND status = 'DIVERGENTE';

CREATE INDEX ix_conciliacoes_abertas
  ON conciliacoes (entidade, created_at DESC) WHERE status = 'DIVERGENTE';

-- -------------------------------------------------------------------------
-- Gatilhos de updated_at
-- -------------------------------------------------------------------------

CREATE TRIGGER trg_credenciais_updated_at BEFORE UPDATE ON integracao_credenciais
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_templates_updated_at BEFORE UPDATE ON integracao_templates
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_importacoes_updated_at BEFORE UPDATE ON importacoes
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- -------------------------------------------------------------------------
-- Historico imutavel: execucoes e erros nao se reescrevem
-- -------------------------------------------------------------------------

/*
 * Reaproveita `fn_historico_imutavel` da migration 045, com a mesma regra: as
 * referencias podem ser ANULADAS pelo ON DELETE SET NULL, o conteudo nao muda,
 * e a exclusao so e liberada depois da retencao configurada.
 *
 * `integracao_erros` fica de FORA: o erro tem ciclo de vida (aberto, em
 * analise, resolvido) e precisa ser atualizado por quem o trata. Congela-lo
 * faria a central de erros da secao 35 virar somente leitura.
 */
CREATE TRIGGER trg_integracao_execucoes_imutavel
  BEFORE UPDATE OR DELETE ON integracao_execucoes
  FOR EACH ROW EXECUTE FUNCTION fn_historico_imutavel(
    'integracao.retencao_logs_dias',
    'integracao_id', 'usuario_id');

-- -------------------------------------------------------------------------
-- Permissoes (secoes 37 e 43)
-- -------------------------------------------------------------------------

INSERT INTO permissoes (codigo, modulo, descricao) VALUES
  ('integracao.ler',        'integracao', 'Consultar integracoes, execucoes, logs e monitoramento'),
  ('integracao.configurar', 'integracao', 'Criar e editar integracoes, conectores e mapeamentos'),
  ('integracao.credencial', 'integracao', 'Gerenciar credenciais e referencias seguras'),
  ('integracao.sincronizar','integracao', 'Disparar sincronizacao e teste de conexao'),
  ('integracao.importar',   'integracao', 'Enviar arquivo, mapear colunas e confirmar importacao'),
  ('integracao.exportar',   'integracao', 'Exportar dados em Excel, CSV, PDF ou JSON'),
  ('integracao.reprocessar','integracao', 'Reprocessar mensagens e dead letter da integracao'),
  ('integracao.conciliar',  'integracao', 'Analisar e decidir divergencias de conciliacao')
ON CONFLICT (codigo) DO NOTHING;

-- ADMIN recebe todas. Os demais perfis recebem o que cabe na funcao: o
-- comprador importa e exporta, mas nao mexe em credencial.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, x.id FROM perfis p CROSS JOIN permissoes x
 WHERE p.nome = 'ADMIN' AND x.codigo LIKE 'integracao.%'
ON CONFLICT DO NOTHING;

INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, x.id FROM perfis p CROSS JOIN permissoes x
 WHERE p.nome = 'GESTOR_COMPRAS'
   AND x.codigo IN ('integracao.ler', 'integracao.configurar',
                    'integracao.sincronizar', 'integracao.importar',
                    'integracao.exportar', 'integracao.reprocessar',
                    'integracao.conciliar')
ON CONFLICT DO NOTHING;

INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, x.id FROM perfis p CROSS JOIN permissoes x
 WHERE p.nome IN ('COMPRADOR', 'ESTOQUE')
   AND x.codigo IN ('integracao.ler', 'integracao.importar', 'integracao.exportar')
ON CONFLICT DO NOTHING;

INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, x.id FROM perfis p CROSS JOIN permissoes x
 WHERE p.nome IN ('QUALIDADE', 'FINANCEIRO', 'COMERCIAL', 'DIRETORIA')
   AND x.codigo IN ('integracao.ler', 'integracao.exportar')
ON CONFLICT DO NOTHING;

-- -------------------------------------------------------------------------
-- Configuracoes (secoes 30, 33, 37, 41 e 42)
-- -------------------------------------------------------------------------

INSERT INTO configuracoes (chave, valor, tipo, grupo, descricao, ativo) VALUES
  ('integracao.ambiente', 'DESENVOLVIMENTO', 'STRING', 'integracao',
   'Ambiente deste servidor. Credencial de outro ambiente e recusada (secao 42)', true),
  ('integracao.timeout_padrao_segundos', '30', 'NUMERO', 'integracao',
   'Timeout padrao de conector quando a integracao nao define o proprio', true),
  ('integracao.max_tentativas', '3', 'NUMERO', 'integracao',
   'Tentativas antes de mandar a mensagem para a dead letter (secao 30)', true),
  ('integracao.backoff_base_segundos', '30', 'NUMERO', 'integracao',
   'Intervalo da primeira reexecucao; dobra a cada tentativa', true),
  ('integracao.backoff_maximo_segundos', '3600', 'NUMERO', 'integracao',
   'Teto do backoff exponencial', true),
  ('integracao.lote_mensagens', '200', 'NUMERO', 'integracao',
   'Mensagens processadas por ciclo do worker', true),
  ('integracao.importacao_lote_linhas', '1000', 'NUMERO', 'integracao',
   'Linhas gravadas por transacao na importacao em streaming', true),
  ('integracao.importacao_max_linhas', '1000000', 'NUMERO', 'integracao',
   'Teto de linhas por arquivo importado', true),
  ('integracao.importacao_amostra_linhas', '20', 'NUMERO', 'integracao',
   'Linhas mostradas na pre-visualizacao antes da confirmacao (secao 11)', true),
  ('integracao.exportacao_max_linhas', '100000', 'NUMERO', 'integracao',
   'Teto de linhas por exportacao', true),
  ('integracao.retencao_logs_dias', '180', 'NUMERO', 'integracao',
   'Retencao de execucoes e mensagens de integracao (secao 41)', true),
  ('integracao.conciliacao_tolerancia_percentual', '1', 'NUMERO', 'integracao',
   'Divergencia abaixo disso nao gera alerta de conciliacao (secao 34)', true),
  ('integracao.rate_limit_por_minuto', '120', 'NUMERO', 'integracao',
   'Chamadas por minuto por conector, quando a integracao nao define (secao 37)', true),
  ('integracao.alerta_sem_sincronizar_horas', '48', 'NUMERO', 'integracao',
   'Horas sem sincronizar antes de a integracao virar ATENCAO no painel', true),
  ('integracao.credencial_aviso_dias', '15', 'NUMERO', 'integracao',
   'Antecedencia do aviso de credencial prestes a vencer', true),
  ('integracao.permitir_delete_externo', 'false', 'BOOLEANO', 'integracao',
   'DELETE em API externa somente quando explicitamente autorizado (secao 24)', true),
  ('integracao.sincronizacao_ativa', 'true', 'BOOLEANO', 'integracao',
   'Interruptor geral das sincronizacoes agendadas', true)
ON CONFLICT (chave) DO NOTHING;

-- Categoria dos alertas novos, para a central do modulo 11 saber classifica-los.
INSERT INTO alertas_tipos (tipo, categoria, prioridade, titulo_padrao, origem_padrao) VALUES
  ('INTEGRACAO_DIVERGENCIA', 'governanca', 'ALTO',
   'Divergencia entre o sistema e a origem externa', 'Modulo 14 - Integracoes'),
  ('IMPORTACAO_COM_ERROS', 'importacao', 'MEDIO',
   'Importacao concluida com linhas rejeitadas', 'Modulo 14 - Integracoes'),
  ('CREDENCIAL_VENCENDO', 'governanca', 'ALTO',
   'Credencial de integracao proxima do vencimento', 'Modulo 14 - Integracoes'),
  ('INTEGRACAO_SEM_SINCRONIZAR', 'governanca', 'ALTO',
   'Integracao ativa sem sincronizar ha muito tempo', 'Modulo 14 - Integracoes')
ON CONFLICT (tipo) DO NOTHING;
