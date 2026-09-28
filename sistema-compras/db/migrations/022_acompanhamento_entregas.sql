-- ===========================================================================
-- MODULO 08 - Acompanhamento de pedidos, entregas, atrasos e performance
--
-- Reaproveita ORDENS_COMPRA, ORDEM_COMPRA_ITENS, PEDIDO_CONFIRMACOES,
-- PEDIDO_HISTORICO, ENTREGAS, ESTOQUES, MOVIMENTACOES_ESTOQUE,
-- NECESSIDADES_COMPRA, PREVISOES_DEMANDA, MV_DEMANDA_DIARIA, FORNECEDORES,
-- PRODUTOS, ALERTAS, NOTIFICACOES, AUDITORIA e CONFIGURACOES.
--
-- Sobre a tabela ENTREGAS: ela ja existia, mas so no nivel de cabecalho - uma
-- linha por entrega, com quantidade total e sem saber QUAIS produtos vieram.
-- A secao 16 do prompt exige atraso por item e a 17 exige varias entregas por
-- pedido; as duas coisas precisam do nivel de item. Em vez de criar uma tabela
-- de entregas paralela, ENTREGAS ganha ENTREGA_ITENS e os campos que faltavam.
--
-- Sobre datas (secao 80): nada aqui sobrescreve data necessaria, promessa
-- original, promessa atual, ETA original, ETA atual ou data efetiva. Cada uma
-- tem a sua coluna e as alteracoes vao para tabelas append-only.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Estados
-- ---------------------------------------------------------------------------

-- Status logistico e diferente do status comercial do pedido: um pedido
-- CONFIRMADA (comercial) pode estar EM_PRODUCAO, EXPEDIDO ou EM_TRANSITO.
CREATE TYPE status_logistico_enum AS ENUM (
  'AGUARDANDO_CONFIRMACAO', 'AGUARDANDO_PRODUCAO', 'EM_PRODUCAO',
  'PRONTO_EXPEDICAO', 'EXPEDIDO', 'EM_TRANSITO', 'CHEGOU_DESTINO',
  'AGUARDANDO_RECEBIMENTO', 'RECEBIDO', 'ENTREGA_PARCIAL',
  'ATRASADO', 'CANCELADO'
);

CREATE TYPE status_confirmacao_enum AS ENUM (
  'NAO_CONFIRMADO', 'CONFIRMADO', 'CONFIRMADO_PARCIALMENTE', 'RECUSADO'
);

CREATE TYPE confianca_previsao_enum AS ENUM ('ALTA', 'MEDIA', 'BAIXA', 'SEM_DADOS');

CREATE TYPE fonte_previsao_enum AS ENUM (
  'DATA_PROMETIDA', 'TRANSPORTE', 'LEAD_TIME_HISTORICO', 'LEAD_TIME_CONTRATADO',
  'INFORMADA_FORNECEDOR', 'MANUAL'
);

CREATE TYPE status_ocorrencia_enum AS ENUM (
  'ABERTA', 'EM_TRATAMENTO', 'AGUARDANDO_FORNECEDOR', 'RESOLVIDA', 'CANCELADA'
);

CREATE TYPE prioridade_entrega_enum AS ENUM ('CRITICA', 'ALTA', 'MEDIA', 'BAIXA');

CREATE TYPE canal_contato_enum AS ENUM (
  'EMAIL', 'TELEFONE', 'WHATSAPP', 'PORTAL', 'REUNIAO', 'OUTRO'
);

CREATE TYPE modal_transporte_enum AS ENUM (
  'RODOVIARIO', 'MARITIMO', 'AEREO', 'FERROVIARIO', 'MULTIMODAL', 'OUTRO'
);

CREATE TYPE origem_alteracao_prazo_enum AS ENUM (
  'FORNECEDOR', 'TRANSPORTADORA', 'INTERNA', 'SISTEMA', 'OUTRO'
);

CREATE TYPE tipo_acao_atraso_enum AS ENUM (
  'COBRAR_FORNECEDOR', 'SOLICITAR_NOVA_PREVISAO', 'SOLICITAR_ENTREGA_PARCIAL',
  'ALTERAR_TRANSPORTADORA', 'BUSCAR_FORNECEDOR_ALTERNATIVO', 'CRIAR_NOVA_COTACAO',
  'ANTECIPAR_PRODUCAO', 'TRANSFERIR_ESTOQUE', 'PRIORIZAR_RECEBIMENTO', 'OUTRA'
);

CREATE TYPE tipo_documento_entrega_enum AS ENUM (
  'PEDIDO', 'CONFIRMACAO', 'NOTA_FISCAL', 'CONHECIMENTO_TRANSPORTE',
  'COMPROVANTE', 'DOCUMENTO_EMBARQUE', 'EMAIL', 'OUTRO'
);

ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'ENTREGA_ATRASADA';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'ENTREGA_EM_RISCO';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'PEDIDO_SEM_CONFIRMACAO';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'ALTERACAO_PRAZO';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'ETA_ALTERADA';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'SLA_OCORRENCIA';

-- ---------------------------------------------------------------------------
-- 2. Motivos de atraso (secao 29) - cadastro, nao enum, porque o prompt
--    exige permitir incluir novos motivos sem migration.
-- ---------------------------------------------------------------------------
CREATE TABLE motivos_atraso (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo      TEXT NOT NULL UNIQUE,
  descricao   TEXT NOT NULL,
  categoria   TEXT NOT NULL DEFAULT 'FORNECEDOR',
  responsavel TEXT NOT NULL DEFAULT 'FORNECEDOR',
  ativo       BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_motivos_atraso_responsavel
    CHECK (responsavel IN ('FORNECEDOR', 'TRANSPORTADORA', 'INTERNO', 'EXTERNO'))
);

INSERT INTO motivos_atraso (codigo, descricao, categoria, responsavel) VALUES
  ('PRODUCAO',            'Atraso na producao do fornecedor',        'PRODUCAO',   'FORNECEDOR'),
  ('FALTA_MATERIA_PRIMA', 'Falta de materia-prima no fornecedor',    'PRODUCAO',   'FORNECEDOR'),
  ('FALTA_ESTOQUE',       'Fornecedor sem estoque do produto',       'PRODUCAO',   'FORNECEDOR'),
  ('LOGISTICO',           'Problema logistico',                      'LOGISTICA',  'TRANSPORTADORA'),
  ('TRANSPORTADORA',      'Falha da transportadora',                 'LOGISTICA',  'TRANSPORTADORA'),
  ('FISCAL',              'Pendencia fiscal',                        'DOCUMENTAL', 'FORNECEDOR'),
  ('DOCUMENTACAO',        'Documentacao incompleta ou incorreta',    'DOCUMENTAL', 'FORNECEDOR'),
  ('ADUANA',              'Retencao ou demora no desembaraco',       'IMPORTACAO', 'EXTERNO'),
  ('CLIMA',               'Condicoes climaticas',                    'EXTERNO',    'EXTERNO'),
  ('FORCA_MAIOR',         'Forca maior',                             'EXTERNO',    'EXTERNO'),
  ('INTERNO_FORNECEDOR',  'Problema interno do fornecedor',          'PRODUCAO',   'FORNECEDOR'),
  ('INTERNO_EMPRESA',     'Problema interno da empresa',             'INTERNO',    'INTERNO'),
  ('OUTRO',               'Outro motivo',                            'OUTRO',      'FORNECEDOR')
ON CONFLICT (codigo) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Transporte (secoes 34 e 47)
--
-- Opcional por desenho: pedido nacional sem transporte contratado nao tem
-- linha aqui, e isso nao e uma lacuna a preencher com dados inventados.
-- ---------------------------------------------------------------------------
CREATE TABLE transportes_pedido (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ordem_compra_id     BIGINT NOT NULL REFERENCES ordens_compra (id) ON DELETE CASCADE,
  transportadora      TEXT,
  modal               modal_transporte_enum,
  veiculo             TEXT,
  motorista           TEXT,
  documento           TEXT,
  codigo_rastreio     TEXT,
  origem              TEXT,
  destino             TEXT,
  data_coleta         DATE,
  data_prevista       DATE,
  data_efetiva        DATE,
  -- Importacao (secao 47). Nunca substituem as datas acima.
  incoterm            TEXT,
  porto_origem        TEXT,
  porto_destino       TEXT,
  data_embarque       DATE,
  eta_porto           DATE,
  data_desembaraco    DATE,
  eta_final           DATE,
  observacao          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          BIGINT REFERENCES usuarios (id)
);

CREATE INDEX ix_transportes_pedido_oc ON transportes_pedido (ordem_compra_id);
CREATE INDEX ix_transportes_pedido_rastreio ON transportes_pedido (codigo_rastreio)
  WHERE codigo_rastreio IS NOT NULL;

CREATE TRIGGER trg_transportes_pedido_updated_at
  BEFORE UPDATE ON transportes_pedido
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_transportes_pedido_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON transportes_pedido
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

-- ---------------------------------------------------------------------------
-- 4. ENTREGAS - o que faltava
-- ---------------------------------------------------------------------------
ALTER TABLE entregas
  ADD COLUMN numero            TEXT,
  ADD COLUMN sequencia         INTEGER,
  ADD COLUMN data_prometida    DATE,
  ADD COLUMN data_necessaria   DATE,
  ADD COLUMN local_id          BIGINT REFERENCES locais (id),
  ADD COLUMN transporte_id     BIGINT REFERENCES transportes_pedido (id) ON DELETE SET NULL,
  ADD COLUMN programacao_id    BIGINT,
  ADD COLUMN horario_previsto  TIME,
  ADD COLUMN numero_nota_fiscal TEXT,
  ADD COLUMN chave_nfe         TEXT,
  ADD COLUMN motivo_atraso_id  BIGINT REFERENCES motivos_atraso (id),
  ADD COLUMN recebimento_id    BIGINT REFERENCES recebimentos (id) ON DELETE SET NULL,
  ADD COLUMN pronta_recebimento BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN created_by        BIGINT REFERENCES usuarios (id);

CREATE UNIQUE INDEX uq_entregas_numero ON entregas (numero) WHERE numero IS NOT NULL;
CREATE INDEX ix_entregas_real ON entregas (data_real) WHERE data_real IS NOT NULL;
CREATE INDEX ix_entregas_pronta ON entregas (pronta_recebimento) WHERE pronta_recebimento;

-- O item da entrega: sem ele nao existe atraso por item nem saldo por produto.
CREATE TABLE entrega_itens (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entrega_id            BIGINT NOT NULL REFERENCES entregas (id) ON DELETE CASCADE,
  ordem_compra_item_id  BIGINT NOT NULL REFERENCES ordem_compra_itens (id),
  produto_id            BIGINT NOT NULL REFERENCES produtos (id),
  lote_id               BIGINT REFERENCES lotes (id),
  quantidade            NUMERIC(14, 3) NOT NULL,
  quantidade_conferida  NUMERIC(14, 3),
  data_prometida        DATE,
  data_necessaria       DATE,
  data_efetiva          DATE,
  motivo_atraso_id      BIGINT REFERENCES motivos_atraso (id),
  observacao            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_entrega_itens_qtd CHECK (quantidade > 0),
  CONSTRAINT ck_entrega_itens_conferida
    CHECK (quantidade_conferida IS NULL OR quantidade_conferida >= 0)
);

CREATE INDEX ix_entrega_itens_entrega ON entrega_itens (entrega_id);
CREATE INDEX ix_entrega_itens_oci ON entrega_itens (ordem_compra_item_id);
CREATE INDEX ix_entrega_itens_produto ON entrega_itens (produto_id);

CREATE TRIGGER trg_entrega_itens_updated_at
  BEFORE UPDATE ON entrega_itens
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_entrega_itens_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON entrega_itens
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

-- ---------------------------------------------------------------------------
-- 5. Programacao de entrega (secao 19)
-- ---------------------------------------------------------------------------
CREATE TABLE entrega_programacoes (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ordem_compra_id   BIGINT NOT NULL REFERENCES ordens_compra (id) ON DELETE CASCADE,
  entrega_id        BIGINT REFERENCES entregas (id) ON DELETE SET NULL,
  data_prevista     DATE NOT NULL,
  horario_previsto  TIME,
  local_id          BIGINT REFERENCES locais (id),
  transportadora    TEXT,
  modal             modal_transporte_enum,
  status            TEXT NOT NULL DEFAULT 'PROGRAMADA',
  observacao        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        BIGINT REFERENCES usuarios (id),
  CONSTRAINT ck_entrega_programacoes_status
    CHECK (status IN ('PROGRAMADA', 'CONFIRMADA', 'REPROGRAMADA', 'CUMPRIDA', 'CANCELADA'))
);

CREATE TABLE entrega_programacao_itens (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  programacao_id        BIGINT NOT NULL REFERENCES entrega_programacoes (id) ON DELETE CASCADE,
  ordem_compra_item_id  BIGINT NOT NULL REFERENCES ordem_compra_itens (id),
  produto_id            BIGINT NOT NULL REFERENCES produtos (id),
  quantidade            NUMERIC(14, 3) NOT NULL,
  CONSTRAINT ck_entrega_programacao_itens_qtd CHECK (quantidade > 0)
);

CREATE INDEX ix_entrega_programacoes_oc ON entrega_programacoes (ordem_compra_id);
CREATE INDEX ix_entrega_programacoes_data ON entrega_programacoes (data_prevista);
CREATE INDEX ix_entrega_programacao_itens_prog ON entrega_programacao_itens (programacao_id);

ALTER TABLE entregas
  ADD CONSTRAINT entregas_programacao_id_fkey
  FOREIGN KEY (programacao_id) REFERENCES entrega_programacoes (id) ON DELETE SET NULL;

CREATE TRIGGER trg_entrega_programacoes_updated_at
  BEFORE UPDATE ON entrega_programacoes
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_entrega_programacoes_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON entrega_programacoes
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

-- ---------------------------------------------------------------------------
-- 6. Alteracoes de prazo (secoes 12, 13 e 80) - append-only
-- ---------------------------------------------------------------------------
CREATE TABLE alteracoes_prazo (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ordem_compra_id       BIGINT NOT NULL REFERENCES ordens_compra (id) ON DELETE CASCADE,
  ordem_compra_item_id  BIGINT REFERENCES ordem_compra_itens (id) ON DELETE CASCADE,
  campo                 TEXT NOT NULL,
  data_anterior         DATE,
  data_nova             DATE NOT NULL,
  diferenca_dias        INTEGER,
  motivo_atraso_id      BIGINT REFERENCES motivos_atraso (id),
  justificativa         TEXT,
  origem                origem_alteracao_prazo_enum NOT NULL DEFAULT 'FORNECEDOR',
  ultrapassa_necessidade BOOLEAN NOT NULL DEFAULT false,
  usuario_id            BIGINT REFERENCES usuarios (id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_alteracoes_prazo_campo
    CHECK (campo IN ('DATA_PROMETIDA', 'DATA_PREVISTA_ENTREGA', 'ETA', 'DATA_NECESSARIA'))
);

CREATE INDEX ix_alteracoes_prazo_oc ON alteracoes_prazo (ordem_compra_id, created_at);
CREATE INDEX ix_alteracoes_prazo_item ON alteracoes_prazo (ordem_compra_item_id)
  WHERE ordem_compra_item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION fn_alteracao_prazo_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Alteracao de prazo e historico permanente e nao aceita alteracao nem exclusao';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_alteracoes_prazo_append_only
  BEFORE UPDATE OR DELETE ON alteracoes_prazo
  FOR EACH ROW EXECUTE FUNCTION fn_alteracao_prazo_append_only();

-- ---------------------------------------------------------------------------
-- 7. Previsao de entrega / ETA (secoes 44, 45 e 46) - append-only
--
-- Cada linha e uma previsao feita num momento, com a fonte e a confianca.
-- A previsao atual e a ultima; a original e a primeira. Nenhuma se apaga.
-- ---------------------------------------------------------------------------
CREATE TABLE previsoes_entrega (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ordem_compra_id       BIGINT NOT NULL REFERENCES ordens_compra (id) ON DELETE CASCADE,
  ordem_compra_item_id  BIGINT REFERENCES ordem_compra_itens (id) ON DELETE CASCADE,
  eta                   DATE,
  eta_anterior          DATE,
  variacao_dias         INTEGER,
  fonte                 fonte_previsao_enum NOT NULL,
  confianca             confianca_previsao_enum NOT NULL,
  memoria               JSONB NOT NULL DEFAULT '{}'::jsonb,
  justificativa         TEXT,
  usuario_id            BIGINT REFERENCES usuarios (id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_previsoes_entrega_oc ON previsoes_entrega (ordem_compra_id, created_at DESC);

CREATE OR REPLACE FUNCTION fn_previsao_entrega_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Previsao de entrega e historico permanente e nao aceita alteracao nem exclusao';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_previsoes_entrega_append_only
  BEFORE UPDATE OR DELETE ON previsoes_entrega
  FOR EACH ROW EXECUTE FUNCTION fn_previsao_entrega_append_only();

-- ---------------------------------------------------------------------------
-- 8. Status logistico - historico (secao 35) - append-only
-- ---------------------------------------------------------------------------
CREATE TABLE status_logistico_historico (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ordem_compra_id  BIGINT NOT NULL REFERENCES ordens_compra (id) ON DELETE CASCADE,
  entrega_id       BIGINT REFERENCES entregas (id) ON DELETE CASCADE,
  status_anterior  status_logistico_enum,
  status_novo      status_logistico_enum NOT NULL,
  justificativa    TEXT,
  detalhes         JSONB NOT NULL DEFAULT '{}'::jsonb,
  usuario_id       BIGINT REFERENCES usuarios (id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_status_logistico_oc ON status_logistico_historico (ordem_compra_id, created_at);

CREATE OR REPLACE FUNCTION fn_status_logistico_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Historico de status logistico e permanente e nao aceita alteracao nem exclusao';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_status_logistico_append_only
  BEFORE UPDATE OR DELETE ON status_logistico_historico
  FOR EACH ROW EXECUTE FUNCTION fn_status_logistico_append_only();

-- ---------------------------------------------------------------------------
-- 9. Ocorrencias logisticas (secoes 30, 31 e 26)
-- ---------------------------------------------------------------------------
CREATE TABLE ocorrencias_entrega (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero                TEXT NOT NULL UNIQUE,
  ordem_compra_id       BIGINT NOT NULL REFERENCES ordens_compra (id) ON DELETE CASCADE,
  ordem_compra_item_id  BIGINT REFERENCES ordem_compra_itens (id) ON DELETE CASCADE,
  entrega_id            BIGINT REFERENCES entregas (id) ON DELETE SET NULL,
  fornecedor_id         BIGINT NOT NULL REFERENCES fornecedores (id),
  tipo                  TEXT NOT NULL,
  descricao             TEXT NOT NULL,
  motivo_atraso_id      BIGINT REFERENCES motivos_atraso (id),
  prioridade            prioridade_entrega_enum NOT NULL DEFAULT 'MEDIA',
  status                status_ocorrencia_enum NOT NULL DEFAULT 'ABERTA',
  data_abertura         TIMESTAMPTZ NOT NULL DEFAULT now(),
  prazo_resolucao       TIMESTAMPTZ,
  sla_horas             INTEGER,
  solucao               TEXT,
  data_encerramento     TIMESTAMPTZ,
  responsavel_id        BIGINT REFERENCES usuarios (id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            BIGINT REFERENCES usuarios (id)
);

CREATE INDEX ix_ocorrencias_entrega_oc ON ocorrencias_entrega (ordem_compra_id);
CREATE INDEX ix_ocorrencias_entrega_status ON ocorrencias_entrega (status);
CREATE INDEX ix_ocorrencias_entrega_prazo ON ocorrencias_entrega (prazo_resolucao)
  WHERE status IN ('ABERTA', 'EM_TRATAMENTO', 'AGUARDANDO_FORNECEDOR');

CREATE TRIGGER trg_ocorrencias_entrega_updated_at
  BEFORE UPDATE ON ocorrencias_entrega
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_ocorrencias_entrega_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON ocorrencias_entrega
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

-- Acoes sobre atraso (secao 26). Podem existir sem ocorrencia formal.
CREATE TABLE acoes_atraso (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ordem_compra_id  BIGINT NOT NULL REFERENCES ordens_compra (id) ON DELETE CASCADE,
  ocorrencia_id    BIGINT REFERENCES ocorrencias_entrega (id) ON DELETE CASCADE,
  tipo             tipo_acao_atraso_enum NOT NULL,
  descricao        TEXT,
  responsavel_id   BIGINT REFERENCES usuarios (id),
  prazo            DATE,
  status           TEXT NOT NULL DEFAULT 'PENDENTE',
  resultado        TEXT,
  concluida_em     TIMESTAMPTZ,
  observacao       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       BIGINT REFERENCES usuarios (id),
  CONSTRAINT ck_acoes_atraso_status
    CHECK (status IN ('PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDA', 'CANCELADA'))
);

CREATE INDEX ix_acoes_atraso_oc ON acoes_atraso (ordem_compra_id);
CREATE INDEX ix_acoes_atraso_status ON acoes_atraso (status);

CREATE TRIGGER trg_acoes_atraso_updated_at
  BEFORE UPDATE ON acoes_atraso
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- 10. Contatos com o fornecedor (secoes 32 e 33)
-- ---------------------------------------------------------------------------
CREATE TABLE contatos_fornecedor_pedido (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ordem_compra_id   BIGINT NOT NULL REFERENCES ordens_compra (id) ON DELETE CASCADE,
  fornecedor_id     BIGINT NOT NULL REFERENCES fornecedores (id),
  ocorrencia_id     BIGINT REFERENCES ocorrencias_entrega (id) ON DELETE SET NULL,
  data_contato      TIMESTAMPTZ NOT NULL DEFAULT now(),
  canal             canal_contato_enum NOT NULL,
  assunto           TEXT NOT NULL,
  resposta          TEXT,
  nova_previsao     DATE,
  observacao        TEXT,
  usuario_id        BIGINT REFERENCES usuarios (id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_contatos_fornecedor_pedido_oc ON contatos_fornecedor_pedido (ordem_compra_id, data_contato);

CREATE OR REPLACE FUNCTION fn_contato_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Contato com fornecedor e historico permanente e nao aceita exclusao';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_contatos_fornecedor_pedido_append_only
  BEFORE DELETE ON contatos_fornecedor_pedido
  FOR EACH ROW EXECUTE FUNCTION fn_contato_append_only();

-- ---------------------------------------------------------------------------
-- 11. Documentos (secao 48) - metadado e referencia; o arquivo em si fica
--     fora do banco, como ja acontece no resto do sistema.
-- ---------------------------------------------------------------------------
CREATE TABLE documentos_entrega (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ordem_compra_id  BIGINT NOT NULL REFERENCES ordens_compra (id) ON DELETE CASCADE,
  entrega_id       BIGINT REFERENCES entregas (id) ON DELETE CASCADE,
  fornecedor_id    BIGINT REFERENCES fornecedores (id),
  tipo             tipo_documento_entrega_enum NOT NULL,
  numero           TEXT,
  descricao        TEXT,
  referencia       TEXT,
  emitido_em       DATE,
  usuario_id       BIGINT REFERENCES usuarios (id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_documentos_entrega_oc ON documentos_entrega (ordem_compra_id);

-- ---------------------------------------------------------------------------
-- 12. ORDENS_COMPRA e ORDEM_COMPRA_ITENS - campos logisticos
--
-- As datas originais ganham coluna propria em vez de serem sobrescritas
-- (secao 80). O status logistico convive com o status comercial.
-- ---------------------------------------------------------------------------
ALTER TABLE ordens_compra
  ADD COLUMN status_logistico        status_logistico_enum,
  ADD COLUMN status_confirmacao      status_confirmacao_enum NOT NULL DEFAULT 'NAO_CONFIRMADO',
  ADD COLUMN data_prometida_original DATE,
  ADD COLUMN eta_original            DATE,
  ADD COLUMN eta_atual               DATE,
  ADD COLUMN eta_fonte               fonte_previsao_enum,
  ADD COLUMN eta_confianca           confianca_previsao_enum,
  ADD COLUMN eta_calculada_em        TIMESTAMPTZ,
  ADD COLUMN prioridade_entrega      prioridade_entrega_enum,
  ADD COLUMN motivo_atraso_id        BIGINT REFERENCES motivos_atraso (id),
  ADD COLUMN data_entrega_efetiva    DATE,
  ADD COLUMN alteracoes_prazo_total  INTEGER NOT NULL DEFAULT 0;

CREATE INDEX ix_ordens_compra_status_logistico ON ordens_compra (status_logistico)
  WHERE status_logistico IS NOT NULL;
CREATE INDEX ix_ordens_compra_eta ON ordens_compra (eta_atual) WHERE eta_atual IS NOT NULL;

-- Promessa original: quem ja tem promessa registrada mantem a primeira.
UPDATE ordens_compra SET data_prometida_original = data_prometida
 WHERE data_prometida IS NOT NULL AND data_prometida_original IS NULL;

ALTER TABLE ordem_compra_itens
  ADD COLUMN data_prometida_original DATE,
  ADD COLUMN quantidade_entregue     NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN data_entrega_efetiva    DATE,
  ADD COLUMN motivo_atraso_id        BIGINT REFERENCES motivos_atraso (id),
  ADD CONSTRAINT ck_oci_quantidade_entregue CHECK (quantidade_entregue >= 0);

UPDATE ordem_compra_itens SET data_prometida_original = data_prometida
 WHERE data_prometida IS NOT NULL AND data_prometida_original IS NULL;

-- ---------------------------------------------------------------------------
-- 13. Integridade (secao 63)
--
-- A entrega nunca pode entregar mais do que o pedido pediu, e um pedido
-- cancelado nao recebe entrega. As duas regras ficam no banco, nao so no
-- service: e a unica forma de valerem tambem para carga e correcao manual.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_validar_entrega_item() RETURNS TRIGGER AS $$
DECLARE
  v_pedida     NUMERIC;
  v_entregue   NUMERIC;
  v_status     status_ordem_compra_enum;
  v_tolerancia NUMERIC;
  v_oc         BIGINT;
BEGIN
  SELECT oci.quantidade_pedida, oci.ordem_compra_id INTO v_pedida, v_oc
    FROM ordem_compra_itens oci WHERE oci.id = NEW.ordem_compra_item_id;

  SELECT oc.status INTO v_status FROM ordens_compra oc WHERE oc.id = v_oc;
  IF v_status IN ('CANCELADA', 'REJEITADA') THEN
    RAISE EXCEPTION 'Pedido % esta % e nao aceita entrega', v_oc, v_status;
  END IF;

  SELECT coalesce(sum(ei.quantidade), 0) INTO v_entregue
    FROM entrega_itens ei
   WHERE ei.ordem_compra_item_id = NEW.ordem_compra_item_id
     AND ei.id <> coalesce(NEW.id, -1);

  SELECT coalesce((SELECT valor::numeric FROM configuracoes
                    WHERE chave = 'entrega.tolerancia_excedente_percentual'), 0)
    INTO v_tolerancia;

  IF v_entregue + NEW.quantidade > v_pedida * (1 + v_tolerancia / 100) THEN
    RAISE EXCEPTION
      'Entrega de % excede a quantidade pedida de % (ja entregue %) no item %',
      NEW.quantidade, v_pedida, v_entregue, NEW.ordem_compra_item_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entrega_itens_validar
  BEFORE INSERT OR UPDATE ON entrega_itens
  FOR EACH ROW EXECUTE FUNCTION fn_validar_entrega_item();

-- ---------------------------------------------------------------------------
-- 14. Visao de acompanhamento - uma linha por item de pedido em aberto,
--     com tudo que as telas de atraso e risco precisam ler junto.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_acompanhamento_itens AS
SELECT
  oc.id                        AS ordem_compra_id,
  oc.numero                    AS pedido,
  oc.status                    AS status_pedido,
  oc.status_logistico,
  oc.status_confirmacao,
  oc.data_emissao,
  oc.data_envio,
  oc.data_confirmacao,
  oc.prioridade_entrega,
  oc.eta_atual,
  oc.eta_original,
  oc.eta_confianca,
  oc.comprador_id,
  f.id                         AS fornecedor_id,
  f.razao_social               AS fornecedor,
  f.origem_fornecedor,
  oci.id                       AS ordem_compra_item_id,
  oci.produto_id,
  p.codigo                     AS produto_codigo,
  p.descricao                  AS produto,
  p.classificacao_abc,
  p.classificacao_xyz,
  p.categoria_id,
  oci.quantidade_pedida,
  oci.quantidade_confirmada,
  oci.quantidade_entregue,
  oci.quantidade_recebida,
  greatest(oci.quantidade_pedida - oci.quantidade_entregue, 0) AS quantidade_pendente_entrega,
  oci.preco_unitario,
  greatest(oci.quantidade_pedida - oci.quantidade_entregue, 0) * oci.preco_unitario AS valor_pendente,
  coalesce(oci.data_necessaria, oc.data_necessaria)     AS data_necessaria,
  coalesce(oci.data_prometida, oc.data_prometida)       AS data_prometida,
  coalesce(oci.data_prometida_original, oc.data_prometida_original) AS data_prometida_original,
  oci.data_entrega_efetiva,
  oci.necessidade_id
FROM ordens_compra oc
JOIN fornecedores f ON f.id = oc.fornecedor_id
JOIN ordem_compra_itens oci ON oci.ordem_compra_id = oc.id
JOIN produtos p ON p.id = oci.produto_id;

-- ---------------------------------------------------------------------------
-- 15. Configuracoes (grupo entrega)
-- ---------------------------------------------------------------------------
INSERT INTO configuracoes (chave, valor, tipo, grupo, descricao) VALUES
  ('entrega.tolerancia_excedente_percentual', '0', 'NUMERO', 'entrega',
   'Percentual que a soma das entregas pode exceder a quantidade pedida'),
  ('entrega.otif_referencia', 'DATA_PROMETIDA', 'STRING', 'entrega',
   'Data usada para medir pontualidade: DATA_PROMETIDA ou DATA_NECESSARIA'),
  ('entrega.otif_tolerancia_dias', '0', 'NUMERO', 'entrega',
   'Dias de atraso ainda considerados no prazo'),
  ('entrega.otif_tolerancia_quantidade_percentual', '0', 'NUMERO', 'entrega',
   'Percentual a menos na quantidade ainda considerado integral'),
  ('entrega.otif_unidade', 'ITEM', 'STRING', 'entrega',
   'Unidade de analise do OTIF: ITEM ou PEDIDO'),
  ('entrega.otif_minimo_entregas', '5', 'NUMERO', 'entrega',
   'Entregas minimas para publicar performance do fornecedor; abaixo disso, amostra insuficiente'),
  ('entrega.risco_dias_antecedencia', '7', 'NUMERO', 'entrega',
   'Dias antes da data prometida em que a entrega entra em risco'),
  ('entrega.risco_dias_sem_confirmacao', '3', 'NUMERO', 'entrega',
   'Dias desde o envio sem confirmacao que ja caracterizam risco'),
  ('entrega.atraso_leve_ate', '2', 'NUMERO', 'entrega', 'Ate quantos dias o atraso e leve'),
  ('entrega.atraso_moderado_ate', '5', 'NUMERO', 'entrega', 'Ate quantos dias o atraso e moderado'),
  ('entrega.atraso_alto_ate', '10', 'NUMERO', 'entrega', 'Ate quantos dias o atraso e alto'),
  ('entrega.ruptura_cobertura_critica', '3', 'NUMERO', 'entrega',
   'Dias de cobertura abaixo dos quais o risco de ruptura e critico'),
  ('entrega.ruptura_cobertura_alta', '7', 'NUMERO', 'entrega',
   'Dias de cobertura abaixo dos quais o risco de ruptura e alto'),
  ('entrega.ruptura_cobertura_media', '15', 'NUMERO', 'entrega',
   'Dias de cobertura abaixo dos quais o risco de ruptura e medio'),
  ('entrega.eta_minimo_entregas_historico', '3', 'NUMERO', 'entrega',
   'Entregas do fornecedor necessarias para a ETA usar lead time historico'),
  ('entrega.sla_ocorrencia_critica_horas', '4', 'NUMERO', 'entrega', 'SLA da ocorrencia critica'),
  ('entrega.sla_ocorrencia_alta_horas', '24', 'NUMERO', 'entrega', 'SLA da ocorrencia alta'),
  ('entrega.sla_ocorrencia_media_horas', '72', 'NUMERO', 'entrega', 'SLA da ocorrencia media'),
  ('entrega.sla_ocorrencia_baixa_horas', '120', 'NUMERO', 'entrega', 'SLA da ocorrencia baixa'),
  ('entrega.sla_alerta_percentual', '80', 'NUMERO', 'entrega',
   'Percentual do SLA consumido a partir do qual a ocorrencia entra em alerta'),
  ('entrega.prefixo_entrega', 'ENT', 'STRING', 'entrega', 'Prefixo do numero da entrega'),
  ('entrega.prefixo_ocorrencia', 'OCO', 'STRING', 'entrega', 'Prefixo do numero da ocorrencia')
ON CONFLICT (chave) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 16. Permissoes (secao 66)
-- ---------------------------------------------------------------------------
INSERT INTO permissoes (codigo, modulo, descricao) VALUES
  ('entregas.ler',          'entregas', 'Consultar acompanhamento, entregas e indicadores logisticos'),
  ('entregas.registrar',    'entregas', 'Registrar entregas, programacoes e status logistico'),
  ('entregas.previsao',     'entregas', 'Alterar previsao de entrega e prazo prometido'),
  ('entregas.ocorrencias',  'entregas', 'Abrir e tratar ocorrencias logisticas'),
  ('entregas.parametrizar', 'entregas', 'Alterar parametros de entrega, OTIF, risco e SLA')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo IN
  ('entregas.ler', 'entregas.registrar', 'entregas.previsao',
   'entregas.ocorrencias', 'entregas.parametrizar')
WHERE pf.nome IN ('ADMIN', 'GESTOR_COMPRAS')
ON CONFLICT DO NOTHING;

-- COMPRADOR acompanha, registra contato e ocorrencia e atualiza previsao.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo IN
  ('entregas.ler', 'entregas.registrar', 'entregas.previsao', 'entregas.ocorrencias')
WHERE pf.nome = 'COMPRADOR'
ON CONFLICT DO NOTHING;

-- ESTOQUE registra o que o recebimento precisa; nao mexe em prazo.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo IN ('entregas.ler', 'entregas.registrar')
WHERE pf.nome = 'ESTOQUE'
ON CONFLICT DO NOTHING;

-- QUALIDADE, FINANCEIRO e DIRETORIA consultam.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo = 'entregas.ler'
WHERE pf.nome IN ('QUALIDADE', 'FINANCEIRO', 'DIRETORIA')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE entrega_itens IS
  'Produto e quantidade de cada entrega. Sem este nivel nao existe atraso por item nem saldo por produto (secoes 16 e 17 do PROMPT 08)';
COMMENT ON TABLE previsoes_entrega IS
  'Historico de ETA. A primeira linha e a ETA original, a ultima e a atual; nenhuma se apaga (secoes 44 a 46)';
COMMENT ON TABLE alteracoes_prazo IS
  'Historico de mudanca de data prometida, prevista, ETA ou necessaria. Append-only (secoes 12, 13 e 80)';
