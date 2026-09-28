-- =============================================================================
-- 008_alertas.sql  |  Alertas e notificacoes
-- =============================================================================

BEGIN;

CREATE TABLE alertas (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo                   tipo_alerta_enum NOT NULL,
  severidade             severidade_enum  NOT NULL DEFAULT 'MEDIA',
  produto_id             BIGINT REFERENCES produtos(id)      ON DELETE CASCADE,
  fornecedor_id          BIGINT REFERENCES fornecedores(id)  ON DELETE CASCADE,
  ordem_compra_id        BIGINT REFERENCES ordens_compra(id) ON DELETE CASCADE,
  lote_id                BIGINT REFERENCES lotes(id)         ON DELETE CASCADE,
  mensagem               TEXT NOT NULL,
  detalhes               JSONB,
  status                 status_alerta_enum NOT NULL DEFAULT 'ABERTO',
  data_geracao           TIMESTAMPTZ NOT NULL DEFAULT now(),
  data_resolucao         TIMESTAMPTZ,
  usuario_responsavel_id BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_alertas_mensagem CHECK (btrim(mensagem) <> ''),
  CONSTRAINT ck_alertas_resolucao CHECK (status <> 'RESOLVIDO' OR data_resolucao IS NOT NULL)
);
CREATE INDEX ix_alertas_status     ON alertas (status);
CREATE INDEX ix_alertas_abertos    ON alertas (severidade, data_geracao DESC) WHERE status = 'ABERTO';
CREATE INDEX ix_alertas_produto    ON alertas (produto_id);
CREATE INDEX ix_alertas_fornecedor ON alertas (fornecedor_id);
CREATE INDEX ix_alertas_tipo       ON alertas (tipo);

CREATE TABLE notificacoes (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario_id   BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  alerta_id    BIGINT REFERENCES alertas(id) ON DELETE CASCADE,
  titulo       TEXT NOT NULL,
  mensagem     TEXT,
  lida         BOOLEAN NOT NULL DEFAULT FALSE,
  data_leitura TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_notificacoes_leitura CHECK (NOT lida OR data_leitura IS NOT NULL)
);
CREATE INDEX ix_notificacoes_usuario ON notificacoes (usuario_id, created_at DESC);
CREATE INDEX ix_notificacoes_nao_lidas ON notificacoes (usuario_id) WHERE NOT lida;

COMMIT;
