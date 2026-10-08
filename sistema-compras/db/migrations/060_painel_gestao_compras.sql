-- ---------------------------------------------------------------------------
-- 060 - Painel de Gestao de Compras (a aba principal da planilha, no sistema)
--
-- Duas estruturas que a planilha mantinha a mao:
--
-- 1. Situacao de compra do produto (coluna SIT): FORA, NOVO, FRACIONA e a aba
--    INDUSTRIA VG. Nenhuma delas e "inativo" - o produto continua vendendo -,
--    mas nenhuma deve virar sugestao de compra.
--
-- 2. Politica de compra: horizonte, estoque minimo e lead time em dias. Na
--    planilha eram 30, 20 e 7 para quase tudo; aqui variam por curva, por
--    fornecedor ou por produto. Cada campo e resolvido separadamente, do mais
--    especifico ao mais geral: PRODUTO > FORNECEDOR > CURVA > GLOBAL.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TYPE situacao_compra_enum AS ENUM (
  'NORMAL',            -- entra no calculo
  'FORA_DE_LINHA',     -- planilha: FORA  ("nao trabalhamos mais")
  'SUBSTITUIDO',       -- planilha: NOVO  ("usando outro codigo")
  'FRACIONADO',        -- planilha: FRACIONA (sai do fracionamento de outro item)
  'PRODUCAO_PROPRIA'   -- planilha: aba INDUSTRIA VG
);

ALTER TABLE produtos
  ADD COLUMN situacao_compra situacao_compra_enum NOT NULL DEFAULT 'NORMAL';

CREATE TYPE escopo_politica_compra_enum AS ENUM ('GLOBAL', 'CURVA', 'FORNECEDOR', 'PRODUTO');

CREATE TABLE politicas_compra (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  escopo              escopo_politica_compra_enum NOT NULL,
  curva               classificacao_abc_enum,
  fornecedor_id       BIGINT REFERENCES fornecedores(id) ON DELETE CASCADE,
  produto_id          BIGINT REFERENCES produtos(id)     ON DELETE CASCADE,
  horizonte_dias      INTEGER,
  estoque_minimo_dias INTEGER,
  lead_time_dias      INTEGER,
  observacao          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,

  CONSTRAINT ck_politica_alvo CHECK (
       (escopo = 'GLOBAL'     AND curva IS NULL     AND fornecedor_id IS NULL     AND produto_id IS NULL)
    OR (escopo = 'CURVA'      AND curva IS NOT NULL AND fornecedor_id IS NULL     AND produto_id IS NULL)
    OR (escopo = 'FORNECEDOR' AND curva IS NULL     AND fornecedor_id IS NOT NULL AND produto_id IS NULL)
    OR (escopo = 'PRODUTO'    AND curva IS NULL     AND fornecedor_id IS NULL     AND produto_id IS NOT NULL)),
  CONSTRAINT ck_politica_faixas CHECK (
        (horizonte_dias      IS NULL OR horizonte_dias      BETWEEN 1 AND 365)
    AND (estoque_minimo_dias IS NULL OR estoque_minimo_dias BETWEEN 0 AND 365)
    AND (lead_time_dias      IS NULL OR lead_time_dias      BETWEEN 0 AND 365)),
  -- A politica global e o ultimo recurso: nao pode deixar campo sem valor.
  CONSTRAINT ck_politica_global_completa CHECK (
    escopo <> 'GLOBAL'
    OR (horizonte_dias IS NOT NULL AND estoque_minimo_dias IS NOT NULL AND lead_time_dias IS NOT NULL)),
  CONSTRAINT ck_politica_algum_valor CHECK (
    horizonte_dias IS NOT NULL OR estoque_minimo_dias IS NOT NULL OR lead_time_dias IS NOT NULL)
);

-- NULLS NOT DISTINCT: duas politicas GLOBAL (todos os alvos nulos) conflitam.
CREATE UNIQUE INDEX uq_politica_compra_alvo ON politicas_compra
  (escopo, curva, fornecedor_id, produto_id) NULLS NOT DISTINCT;

-- Os valores que a planilha usava para quase todos os itens.
INSERT INTO politicas_compra (escopo, horizonte_dias, estoque_minimo_dias, lead_time_dias, observacao)
SELECT 'GLOBAL', 30, 20, 7, 'Padrao herdado da planilha GESTAO DE COMPRAS'
 WHERE NOT EXISTS (SELECT 1 FROM politicas_compra WHERE escopo = 'GLOBAL');

COMMIT;
