-- =========================================================================
-- MODULO 12 - ESTRUTURAS DA CAMADA DE INTELIGENCIA (secao 41)
--
-- A secao 41 lista oito estruturas possiveis e manda criar "somente se nao
-- houver equivalente". Auditado o banco, cinco ja tinham equivalente:
--
--   AI_ALERTAS       -> `alertas` (modulo 02, evoluida no 11). Ja tem
--                       categoria, prioridade, origem, evidencias em jsonb,
--                       responsavel, status e - o que mais importa para a
--                       secao 19 - deduplicacao por chave.
--   AI_SIMULACOES    -> `simulacoes_compra` + `simulacao_compra_itens`
--                       (modulo 05). Ja guardam ajustes em jsonb, horizonte
--                       e o resultado agregado, e rodam o MESMO SQL do
--                       planejamento oficial sem tocar nele.
--   AI_CONFIGURACOES -> `configuracoes` com grupo `ia`. O versionamento que
--                       a secao 37 pede ja existe: a tabela tem trigger de
--                       auditoria, entao cada alteracao fica em `auditoria`
--                       com autor, data, valor anterior e novo.
--   Deteccao de venda anormal -> `vendas_outliers` (modulo 04), com media,
--                       desvio padrao, z-score e tratativa.
--   Confianca (secao 26) -> `confiabilidade_previsao_enum`, que ja tem
--                       exatamente ALTA / MEDIA / BAIXA / INSUFICIENTE.
--
-- Sobraram quatro sem equivalente, criadas aqui, mais `ia_execucoes`, que a
-- secao 23 exige para registrar toda consulta executada.
--
-- A CENTRAL DE RISCOS da secao 17 tambem nao vira tabela. Risco e uma
-- condicao avaliada continuamente sobre o dado de agora - persistir a
-- avaliacao criaria uma terceira lista de coisas-para-tratar que envelhece
-- sozinha. O risco e calculado ao vivo, com os fatores a vista (secao 18), e
-- quando cruza o limiar ele VIRA UM ALERTA na central unica, que e onde a
-- tratativa ja mora.
-- =========================================================================

-- -------------------------------------------------------------------------
-- Enums proprios
-- -------------------------------------------------------------------------

/*
 * A regra de ouro da secao 47. Cada afirmacao da IA carrega a sua natureza,
 * e a interface nunca as mistura: um numero lido do banco e um numero
 * estimado por modelo nao podem parecer a mesma coisa.
 */
CREATE TYPE natureza_ia_enum AS ENUM (
  'FATO',           -- esta no banco
  'CALCULO',        -- aritmetica sobre o que esta no banco
  'PREVISAO',       -- estimativa a partir de historico
  'HIPOTESE',       -- explicacao possivel, nao confirmada
  'RECOMENDACAO',   -- sugestao derivada dos dados
  'SIMULACAO'       -- cenario hipotetico
);

CREATE TYPE tipo_recomendacao_enum AS ENUM (
  'COMPRA',            'ANTECIPAR_COMPRA',  'REDUZIR_COMPRA',
  'NEGOCIACAO',        'TROCA_FORNECEDOR',  'HOMOLOGAR_ALTERNATIVA',
  'TRANSFERENCIA',     'REDUZIR_EXCESSO',   'ESCOAR_VALIDADE',
  'ACOMPANHAR_PEDIDO', 'COBRAR_FORNECEDOR', 'REVISAR_PARAMETROS',
  'REVISAR_PREVISAO',  'QUALIDADE',         'CONSOLIDAR_PEDIDOS',
  'CORRIGIR_CADASTRO'
);

CREATE TYPE status_recomendacao_enum AS ENUM (
  'NOVA', 'EM_ANALISE', 'ACEITA', 'REJEITADA', 'EXECUTADA', 'EXPIRADA'
);

CREATE TYPE tipo_feedback_enum AS ENUM (
  'ACEITAR', 'REJEITAR', 'AJUSTAR', 'IGNORAR', 'EXECUTAR'
);

CREATE TYPE tipo_mensagem_ia_enum AS ENUM ('PERGUNTA', 'RESPOSTA', 'SISTEMA');

CREATE TYPE status_execucao_ia_enum AS ENUM ('OK', 'BLOQUEADA', 'ERRO', 'VAZIA');

CREATE TYPE tipo_execucao_ia_enum AS ENUM (
  'PERGUNTA', 'CONSULTA_SQL', 'ANALISE', 'SIMULACAO', 'RECOMENDACAO', 'ROTINA'
);

-- -------------------------------------------------------------------------
-- Conversas e mensagens (secoes 22 e 35)
-- -------------------------------------------------------------------------

CREATE TABLE ia_conversas (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario_id  bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  titulo      text   NOT NULL,
  contexto    jsonb  NOT NULL DEFAULT '{}'::jsonb,
  arquivada   boolean NOT NULL DEFAULT FALSE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_ia_conversa_titulo CHECK (btrim(titulo) <> '')
);

COMMENT ON TABLE ia_conversas IS
  'Memoria operacional da IA (secao 35): uma conversa por linha de raciocinio do usuario.';

/*
 * A mensagem guarda a pergunta, a resposta E o que foi consultado para
 * respondê-la. Sem a terceira coluna a memoria seria um registro de conversa;
 * com ela, e um registro AUDITAVEL - da para voltar meses depois e conferir
 * de onde saiu cada numero que a IA afirmou.
 */
CREATE TABLE ia_mensagens (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversa_id    bigint NOT NULL REFERENCES ia_conversas(id) ON DELETE CASCADE,
  usuario_id     bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  tipo           tipo_mensagem_ia_enum NOT NULL,
  mensagem       text NOT NULL,
  intencao       text,
  entidades      jsonb,
  resposta       jsonb,
  dados_usados   jsonb,
  confianca      confiabilidade_previsao_enum,
  tempo_ms       integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_ia_mensagens_conversa ON ia_mensagens (conversa_id, created_at);
CREATE INDEX ix_ia_mensagens_intencao ON ia_mensagens (intencao) WHERE intencao IS NOT NULL;

-- -------------------------------------------------------------------------
-- Recomendacoes (secoes 20, 21, 31 e 32)
-- -------------------------------------------------------------------------

/*
 * `evidencias` e `calculo` sao o coracao da tabela, nao anexos.
 *
 * A secao 46 proibe recomendacao em caixa-preta e a secao 21 exige responder
 * seis perguntas. Guardar so o texto da recomendacao obrigaria a recalcular
 * tudo para explica-la depois - e o recalculo, dias depois, daria outro
 * numero. Entao a recomendacao carrega congelado o que a sustentou.
 *
 * `chave_dedup` faz aqui o mesmo papel que na central de alertas: a mesma
 * condicao nao vira duas recomendacoes abertas.
 */
CREATE TABLE ia_recomendacoes (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo              tipo_recomendacao_enum NOT NULL,
  origem            text NOT NULL,
  titulo            text NOT NULL,
  problema          text NOT NULL,
  recomendacao      text NOT NULL,
  produto_id        bigint REFERENCES produtos(id) ON DELETE CASCADE,
  fornecedor_id     bigint REFERENCES fornecedores(id) ON DELETE CASCADE,
  ordem_compra_id   bigint REFERENCES ordens_compra(id) ON DELETE CASCADE,
  prioridade        prioridade_alerta_enum NOT NULL DEFAULT 'MEDIO',
  confianca         confiabilidade_previsao_enum NOT NULL,
  -- Ordenacao da secao 31: impacto financeiro x urgencia, com os dois a vista.
  impacto_estimado  numeric(16,2),
  impacto_descricao text,
  urgencia_dias     integer,
  score_prioridade  numeric(10,4),
  evidencias        jsonb NOT NULL DEFAULT '[]'::jsonb,
  calculo           jsonb,
  premissas         jsonb,
  dados_usados      jsonb,
  status            status_recomendacao_enum NOT NULL DEFAULT 'NOVA',
  chave_dedup       text,
  ocorrencias       integer NOT NULL DEFAULT 1,
  usuario_responsavel_id bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  decidida_em       timestamptz,
  expira_em         date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_ia_rec_titulo CHECK (btrim(titulo) <> ''),
  CONSTRAINT ck_ia_rec_decidida CHECK (
    status IN ('NOVA', 'EM_ANALISE') OR decidida_em IS NOT NULL)
);

COMMENT ON COLUMN ia_recomendacoes.evidencias IS
  'Fatos que sustentam a recomendacao, cada um com natureza (secao 47), valor e fonte.';
COMMENT ON COLUMN ia_recomendacoes.calculo IS
  'A conta inteira, congelada como foi feita - para explicar depois sem recalcular.';

CREATE UNIQUE INDEX uq_ia_rec_dedup ON ia_recomendacoes (chave_dedup)
  WHERE chave_dedup IS NOT NULL AND status IN ('NOVA', 'EM_ANALISE');
CREATE INDEX ix_ia_rec_abertas ON ia_recomendacoes (prioridade, score_prioridade DESC)
  WHERE status IN ('NOVA', 'EM_ANALISE');
CREATE INDEX ix_ia_rec_produto ON ia_recomendacoes (produto_id) WHERE produto_id IS NOT NULL;
CREATE INDEX ix_ia_rec_fornecedor ON ia_recomendacoes (fornecedor_id) WHERE fornecedor_id IS NOT NULL;
CREATE INDEX ix_ia_rec_tipo ON ia_recomendacoes (tipo, status);

-- -------------------------------------------------------------------------
-- Feedback (secao 36)
-- -------------------------------------------------------------------------

/*
 * Append-only de proposito: o feedback e o registro de
 * RECOMENDACAO -> DECISAO -> RESULTADO da secao 35. Reescrever um "rejeitei
 * porque o fornecedor ja tinha sido trocado" apagaria a razao pela qual a
 * regra deveria mudar.
 */
CREATE TABLE ia_feedback (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recomendacao_id bigint NOT NULL REFERENCES ia_recomendacoes(id) ON DELETE CASCADE,
  usuario_id      bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  tipo            tipo_feedback_enum NOT NULL,
  motivo          text,
  observacao      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_ia_feedback_recomendacao ON ia_feedback (recomendacao_id, created_at);
CREATE INDEX ix_ia_feedback_tipo ON ia_feedback (tipo, created_at DESC);

CREATE OR REPLACE FUNCTION fn_ia_feedback_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ia_feedback e append-only: o registro de decisao nao se reescreve';
END;
$$;

CREATE TRIGGER trg_ia_feedback_imutavel
  BEFORE UPDATE OR DELETE ON ia_feedback
  FOR EACH ROW EXECUTE FUNCTION fn_ia_feedback_imutavel();

-- -------------------------------------------------------------------------
-- Execucoes (secoes 23 e 39)
-- -------------------------------------------------------------------------

/*
 * "Registrar todas as consultas executadas" (secao 23).
 *
 * Grava tambem as BLOQUEADAS, com o motivo - uma tentativa recusada e
 * justamente o que se quer poder auditar depois. Por isso tambem e
 * append-only: um log que o proprio sistema consegue reescrever nao e log.
 */
CREATE TABLE ia_execucoes (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario_id     bigint REFERENCES usuarios(id) ON DELETE SET NULL,
  tipo           tipo_execucao_ia_enum NOT NULL,
  entrada        text NOT NULL,
  intencao       text,
  consulta       text,
  parametros     jsonb,
  status         status_execucao_ia_enum NOT NULL,
  motivo_bloqueio text,
  linhas         integer,
  tempo_ms       integer,
  erro           text,
  ip             text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_ia_execucoes_usuario ON ia_execucoes (usuario_id, created_at DESC);
CREATE INDEX ix_ia_execucoes_status ON ia_execucoes (status, created_at DESC);
CREATE INDEX ix_ia_execucoes_bloqueadas ON ia_execucoes (created_at DESC)
  WHERE status = 'BLOQUEADA';

CREATE OR REPLACE FUNCTION fn_ia_execucao_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ia_execucoes e o log de seguranca do modulo 12: nao se altera nem se apaga';
END;
$$;

CREATE TRIGGER trg_ia_execucoes_imutavel
  BEFORE UPDATE OR DELETE ON ia_execucoes
  FOR EACH ROW EXECUTE FUNCTION fn_ia_execucao_imutavel();

-- -------------------------------------------------------------------------
-- updated_at
-- -------------------------------------------------------------------------

CREATE TRIGGER trg_ia_conversas_updated_at BEFORE UPDATE ON ia_conversas
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_ia_recomendacoes_updated_at BEFORE UPDATE ON ia_recomendacoes
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_ia_recomendacoes_auditoria AFTER INSERT OR UPDATE OR DELETE ON ia_recomendacoes
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

-- -------------------------------------------------------------------------
-- Classificacao dos alertas novos na central unica
-- -------------------------------------------------------------------------

INSERT INTO alertas_tipos (tipo, categoria, prioridade, titulo_padrao, origem_padrao) VALUES
  ('ANOMALIA_DETECTADA',     'governanca',  'MEDIO',   'Comportamento fora do padrao',      'Modulo 12 - IA'),
  ('RUPTURA_PREVISTA',       'ruptura',     'ALTO',    'Ruptura prevista',                  'Modulo 12 - IA'),
  ('PRECO_ACIMA_DA_MEDIA',   'preco',       'MEDIO',   'Preco acima da media historica',    'Modulo 12 - IA'),
  ('DEMANDA_FORA_DO_PADRAO', 'demanda',     'MEDIO',   'Demanda fora do padrao',            'Modulo 12 - IA'),
  ('PREVISAO_DIVERGENTE',    'demanda',     'MEDIO',   'Previsao divergindo do realizado',  'Modulo 12 - IA'),
  ('OPORTUNIDADE_ECONOMIA',  'compra',      'BAIXO',   'Oportunidade de economia',          'Modulo 12 - IA'),
  ('CONCENTRACAO_CRITICA',   'fornecedor',  'ALTO',    'Concentracao critica de fornecimento', 'Modulo 12 - IA'),
  ('LEAD_TIME_CRESCENDO',    'atraso',      'MEDIO',   'Lead time em crescimento',          'Modulo 12 - IA'),
  ('DADOS_INSUFICIENTES_IA', 'governanca',  'BAIXO',   'Dados insuficientes para analisar', 'Modulo 12 - IA')
ON CONFLICT (tipo) DO NOTHING;

-- -------------------------------------------------------------------------
-- Configuracoes de governanca (secao 37)
-- -------------------------------------------------------------------------

INSERT INTO configuracoes (chave, valor, tipo, grupo, descricao) VALUES
  ('ia.confianca_minima_recomendar', 'BAIXA', 'STRING', 'ia',
   'Confianca minima para gerar recomendacao; abaixo disso a IA informa a limitacao em vez de recomendar'),
  ('ia.minimo_eventos_analise', '5', 'NUMERO', 'ia',
   'Numero minimo de observacoes para a IA considerar um padrao analisavel'),
  ('ia.minimo_dias_historico', '30', 'NUMERO', 'ia',
   'Dias minimos de historico para a IA falar em tendencia'),
  ('ia.zscore_anomalia', '2.5', 'NUMERO', 'ia',
   'Desvios padrao a partir dos quais um valor e tratado como anomalia'),
  ('ia.variacao_preco_anormal', '15', 'NUMERO', 'ia',
   'Variacao percentual de preco a partir da qual a IA aponta aumento anormal'),
  ('ia.horizonte_ruptura_dias', '30', 'NUMERO', 'ia',
   'Janela em dias para projetar risco de ruptura'),
  ('ia.dias_validade_risco', '60', 'NUMERO', 'ia',
   'Dias ate o vencimento a partir dos quais o lote entra em risco de validade'),
  ('ia.concentracao_critica_percentual', '60', 'NUMERO', 'ia',
   'Percentual de compra em um unico fornecedor a partir do qual a concentracao e critica'),
  ('ia.mape_maximo_aceitavel', '30', 'NUMERO', 'ia',
   'Erro percentual medio acima do qual a previsao e considerada divergente'),
  ('ia.economia_minima_reportar', '500', 'NUMERO', 'ia',
   'Valor minimo de economia estimada para a IA reportar a oportunidade'),
  ('ia.limite_linhas_consulta', '500', 'NUMERO', 'ia',
   'Teto de linhas devolvidas por consulta do Pergunte aos Dados'),
  ('ia.timeout_consulta_ms', '8000', 'NUMERO', 'ia',
   'Tempo maximo de execucao de uma consulta analitica, aplicado pelo banco'),
  ('ia.retencao_historico_dias', '365', 'NUMERO', 'ia',
   'Dias de retencao do historico de conversas da IA'),
  ('ia.peso_impacto_financeiro', '0.5', 'NUMERO', 'ia',
   'Peso do impacto financeiro na priorizacao de recomendacoes (secao 31)'),
  ('ia.peso_urgencia', '0.3', 'NUMERO', 'ia',
   'Peso da urgencia na priorizacao de recomendacoes'),
  ('ia.peso_criticidade', '0.2', 'NUMERO', 'ia',
   'Peso da criticidade (classe ABC) na priorizacao de recomendacoes'),
  ('ia.recomendacao_expira_dias', '30', 'NUMERO', 'ia',
   'Dias ate uma recomendacao nao decidida expirar')
ON CONFLICT (chave) DO NOTHING;

-- -------------------------------------------------------------------------
-- Permissoes (secao 38)
-- -------------------------------------------------------------------------

INSERT INTO permissoes (codigo, modulo, descricao) VALUES
  ('ia.ler',         'ia', 'Consultar analises, recomendacoes e riscos da IA'),
  ('ia.perguntar',   'ia', 'Usar o Pergunte aos Dados'),
  ('ia.sql',         'ia', 'Executar consulta analitica propria sob a guarda de seguranca'),
  ('ia.simular',     'ia', 'Rodar simulacoes de cenario'),
  ('ia.decidir',     'ia', 'Aceitar, rejeitar ou executar recomendacoes'),
  ('ia.executivo',   'ia', 'Ver a Central de Decisao e o resumo estrategico'),
  ('ia.configurar',  'ia', 'Alterar parametros e limiares da IA')
ON CONFLICT (codigo) DO NOTHING;

-- ADMIN e GESTOR_COMPRAS: tudo.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.modulo = 'ia' AND p.nome IN ('ADMIN', 'GESTOR_COMPRAS')
ON CONFLICT DO NOTHING;

-- COMPRADOR: analisa, pergunta, simula e decide sobre o que compra.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo IN ('ia.ler', 'ia.perguntar', 'ia.simular', 'ia.decidir')
   AND p.nome = 'COMPRADOR'
ON CONFLICT DO NOTHING;

-- ESTOQUE: estoque, demanda e abastecimento.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo IN ('ia.ler', 'ia.perguntar', 'ia.simular')
   AND p.nome = 'ESTOQUE'
ON CONFLICT DO NOTHING;

-- QUALIDADE e COMERCIAL: leem e perguntam, dentro do proprio dominio.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo IN ('ia.ler', 'ia.perguntar')
   AND p.nome IN ('QUALIDADE', 'COMERCIAL')
ON CONFLICT DO NOTHING;

-- FINANCEIRO: leitura, pergunta e visao executiva de custo.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo IN ('ia.ler', 'ia.perguntar', 'ia.executivo')
   AND p.nome = 'FINANCEIRO'
ON CONFLICT DO NOTHING;

-- DIRETORIA: visao executiva, sem mexer em parametro nem rodar SQL proprio.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT p.id, pm.id FROM perfis p, permissoes pm
 WHERE pm.codigo IN ('ia.ler', 'ia.perguntar', 'ia.executivo', 'ia.simular')
   AND p.nome = 'DIRETORIA'
ON CONFLICT DO NOTHING;
