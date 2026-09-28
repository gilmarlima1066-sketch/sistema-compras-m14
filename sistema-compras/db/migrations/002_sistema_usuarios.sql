-- =============================================================================
-- 002_sistema_usuarios.sql  |  Perfis, permissoes, usuarios, auditoria, config
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- perfis
-- -----------------------------------------------------------------------------
CREATE TABLE perfis (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome          TEXT        NOT NULL,
  descricao     TEXT,
  ativo         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_perfis_nome UNIQUE (nome),
  CONSTRAINT ck_perfis_nome_nao_vazio CHECK (btrim(nome) <> '')
);
COMMENT ON TABLE perfis IS 'Perfis de acesso (ADMIN, GESTOR_COMPRAS, COMPRADOR, ...)';

-- -----------------------------------------------------------------------------
-- permissoes  |  granularidade: <modulo>.<acao>
-- -----------------------------------------------------------------------------
CREATE TABLE permissoes (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo     TEXT        NOT NULL,
  modulo     TEXT        NOT NULL,
  descricao  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_permissoes_codigo UNIQUE (codigo),
  CONSTRAINT ck_permissoes_codigo CHECK (codigo ~ '^[a-z_]+\.[a-z_]+$')
);

CREATE TABLE perfil_permissoes (
  perfil_id    BIGINT NOT NULL REFERENCES perfis(id) ON DELETE CASCADE,
  permissao_id BIGINT NOT NULL REFERENCES permissoes(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (perfil_id, permissao_id)
);
CREATE INDEX ix_perfil_permissoes_permissao ON perfil_permissoes (permissao_id);

-- -----------------------------------------------------------------------------
-- usuarios
-- -----------------------------------------------------------------------------
CREATE TABLE usuarios (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome         TEXT        NOT NULL,
  email        TEXT        NOT NULL,
  senha_hash   TEXT        NOT NULL,
  perfil_id    BIGINT      NOT NULL REFERENCES perfis(id) ON DELETE RESTRICT,
  ativo        BOOLEAN     NOT NULL DEFAULT TRUE,
  ultimo_login TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  created_by   BIGINT,
  updated_by   BIGINT,
  CONSTRAINT ck_usuarios_email CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT ck_usuarios_nome CHECK (btrim(nome) <> ''),
  -- a senha NUNCA e armazenada em texto puro: apenas hash bcrypt ($2a/$2b/$2y)
  CONSTRAINT ck_usuarios_senha_hash CHECK (senha_hash ~ '^\$2[aby]\$\d{2}\$.{53}$')
);
-- email unico entre usuarios vivos (soft delete nao bloqueia recadastro)
CREATE UNIQUE INDEX uq_usuarios_email ON usuarios (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX ix_usuarios_perfil ON usuarios (perfil_id);
CREATE INDEX ix_usuarios_ativo ON usuarios (ativo) WHERE deleted_at IS NULL;

ALTER TABLE usuarios
  ADD CONSTRAINT fk_usuarios_created_by FOREIGN KEY (created_by) REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_usuarios_updated_by FOREIGN KEY (updated_by) REFERENCES usuarios(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- auditoria  |  append-only
-- -----------------------------------------------------------------------------
CREATE TABLE auditoria (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario_id      BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  tabela          TEXT   NOT NULL,
  registro_id     BIGINT,
  acao            acao_auditoria_enum NOT NULL,
  valor_anterior  JSONB,
  valor_novo      JSONB,
  ip              TEXT,
  origem          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_auditoria_tabela_registro ON auditoria (tabela, registro_id);
CREATE INDEX ix_auditoria_usuario ON auditoria (usuario_id);
CREATE INDEX ix_auditoria_created_at ON auditoria (created_at DESC);

CREATE TRIGGER trg_auditoria_append_only
  BEFORE UPDATE OR DELETE ON auditoria
  FOR EACH ROW EXECUTE FUNCTION fn_bloquear_alteracao();

-- -----------------------------------------------------------------------------
-- configuracoes  |  parametros do sistema (limites ABC/XYZ, tolerancias, etc.)
-- -----------------------------------------------------------------------------
CREATE TABLE configuracoes (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chave      TEXT NOT NULL,
  valor      TEXT NOT NULL,
  tipo       tipo_configuracao_enum NOT NULL DEFAULT 'STRING',
  grupo      TEXT,
  descricao  TEXT,
  ativo      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  CONSTRAINT uq_configuracoes_chave UNIQUE (chave)
);

-- Leitura tipada de configuracao booleana (usada pelas triggers de estoque)
CREATE OR REPLACE FUNCTION fn_config_bool(p_chave TEXT, p_default BOOLEAN DEFAULT FALSE)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT lower(valor) IN ('true','t','1','sim') FROM configuracoes
      WHERE chave = p_chave AND ativo), p_default);
$$;

CREATE OR REPLACE FUNCTION fn_config_num(p_chave TEXT, p_default NUMERIC DEFAULT 0)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT valor::NUMERIC FROM configuracoes
      WHERE chave = p_chave AND ativo), p_default);
$$;

-- -----------------------------------------------------------------------------
-- auditoria generica (registra apenas os campos que mudaram)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_auditoria() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_antes  JSONB;
  v_depois JSONB;
  v_id     BIGINT;
  v_ignorar TEXT[] := ARRAY['updated_at','updated_by'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_depois := to_jsonb(NEW) - v_ignorar;
    v_id := (to_jsonb(NEW)->>'id')::BIGINT;  -- NULL em tabelas de chave composta
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(o.key, o.value), jsonb_object_agg(o.key, n.value)
      INTO v_antes, v_depois
      FROM jsonb_each(to_jsonb(OLD) - v_ignorar) o
      JOIN jsonb_each(to_jsonb(NEW) - v_ignorar) n ON n.key = o.key
     WHERE o.value IS DISTINCT FROM n.value;
    IF v_antes IS NULL THEN
      RETURN NEW;  -- nada relevante mudou
    END IF;
    v_id := (to_jsonb(NEW)->>'id')::BIGINT;
  ELSE
    v_antes := to_jsonb(OLD) - v_ignorar;
    v_id := (to_jsonb(OLD)->>'id')::BIGINT;
  END IF;

  INSERT INTO auditoria (usuario_id, tabela, registro_id, acao, valor_anterior, valor_novo, ip)
  VALUES (fn_usuario_sessao(), TG_TABLE_NAME, v_id, TG_OP::acao_auditoria_enum,
          v_antes, v_depois, fn_ip_sessao());

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMIT;
