-- ===========================================================================
-- MODULO 09 - Parte 2 de 2: estruturas do recebimento, conferencia, qualidade,
-- divergencias, quarentena, devolucao e nao conformidades.
--
-- Sobre ESTOQUES: quantidade_disponivel era (fisica - reservada). As secoes 20
-- e 33 exigem que quarentena e bloqueio NAO contem como disponivel - produto
-- em quarentena nao pode ser vendido, nem atender necessidade de compra, nem
-- ser reservado. Sem separar essas quantidades, "disponivel" mentiria para o
-- planejamento inteiro (modulos 04, 05 e 08 leem essa coluna).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Tipos proprios do modulo
-- ---------------------------------------------------------------------------
CREATE TYPE severidade_nc_enum AS ENUM ('CRITICA', 'ALTA', 'MEDIA', 'BAIXA');

CREATE TYPE situacao_validade_enum AS ENUM (
  'ADEQUADA', 'PROXIMA', 'CRITICA', 'INSUFICIENTE', 'VENCIDO', 'SEM_CONTROLE'
);

CREATE TYPE tipo_divergencia_enum AS ENUM (
  'QUANTIDADE_MENOR', 'QUANTIDADE_MAIOR', 'PRODUTO_DIFERENTE', 'PRECO_DIVERGENTE',
  'LOTE_DIVERGENTE', 'LOTE_AUSENTE', 'VALIDADE_DIVERGENTE', 'EMBALAGEM_DANIFICADA',
  'PRODUTO_CONTAMINADO', 'PRODUTO_VENCIDO', 'DOCUMENTACAO_DIVERGENTE', 'NF_DIVERGENTE'
);

CREATE TYPE decisao_divergencia_enum AS ENUM (
  'PENDENTE', 'ACEITAR', 'ACEITAR_PARCIAL', 'DEVOLVER', 'RECUSAR', 'AUTORIZAR_COMERCIAL'
);

CREATE TYPE destino_recebimento_enum AS ENUM (
  'DISPONIVEL', 'QUARENTENA', 'BLOQUEADO', 'AREA_RECEBIMENTO', 'RECUSADO'
);

CREATE TYPE status_quarentena_enum AS ENUM ('ABERTA', 'LIBERADA', 'REJEITADA', 'DEVOLVIDA');

CREATE TYPE motivo_devolucao_enum AS ENUM (
  'QUALIDADE', 'VALIDADE', 'QUANTIDADE', 'PRODUTO_INCORRETO', 'AVARIA',
  'DOCUMENTACAO', 'CONDICAO_COMERCIAL', 'DIVERGENCIA_FISCAL'
);

CREATE TYPE status_devolucao_enum AS ENUM (
  'RASCUNHO', 'AUTORIZADA', 'EM_TRANSITO', 'CONCLUIDA', 'CANCELADA'
);

CREATE TYPE resposta_checklist_enum AS ENUM ('APROVADO', 'REPROVADO', 'NAO_APLICAVEL');

CREATE TYPE tipo_anexo_enum AS ENUM (
  'FOTO', 'NOTA_FISCAL', 'LAUDO', 'CERTIFICADO_ANALISE', 'DOCUMENTO',
  'COMPROVANTE', 'EVIDENCIA_AVARIA', 'EVIDENCIA_DIVERGENCIA', 'OUTRO'
);

CREATE TYPE tipo_excecao_recebimento_enum AS ENUM (
  'VALIDADE_ABAIXO_MINIMO', 'EXCESSO_QUANTIDADE', 'PRECO_DIVERGENTE',
  'PRODUTO_DIVERGENTE', 'QUALIDADE_COM_RESTRICAO', 'LIBERACAO_QUARENTENA',
  'DEVOLUCAO', 'FORA_TOLERANCIA'
);

CREATE TYPE tipo_amostragem_enum AS ENUM ('TOTAL', 'AMOSTRAGEM', 'LOTE', 'PERCENTUAL');

-- ---------------------------------------------------------------------------
-- 2. ESTOQUES - quarentena e bloqueio saem do disponivel (secoes 20, 31 e 33)
--
-- As views dependem da coluna gerada, entao sao derrubadas e recriadas iguais:
-- a definicao delas nao muda, o que muda e a conta por tras de
-- quantidade_disponivel - e com isso elas passam a estar certas.
-- ---------------------------------------------------------------------------
-- vw_produtos_criticos le vw_estoque_atual, entao entra na fila da derrubada e
-- e recriada igual mais adiante.
DROP VIEW IF EXISTS vw_produtos_criticos;
DROP VIEW IF EXISTS vw_base_planejamento;
DROP VIEW IF EXISTS vw_estoque_atual;

ALTER TABLE estoques DROP COLUMN quantidade_disponivel;

ALTER TABLE estoques
  ADD COLUMN quantidade_quarentena NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN quantidade_bloqueada  NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN quantidade_recebimento NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD CONSTRAINT ck_estoques_quarentena CHECK (quantidade_quarentena >= 0),
  ADD CONSTRAINT ck_estoques_bloqueada CHECK (quantidade_bloqueada >= 0),
  ADD CONSTRAINT ck_estoques_recebimento CHECK (quantidade_recebimento >= 0);

ALTER TABLE estoques
  ADD COLUMN quantidade_disponivel NUMERIC(14, 3)
  GENERATED ALWAYS AS (
    quantidade_fisica - quantidade_reservada - quantidade_quarentena
      - quantidade_bloqueada - quantidade_recebimento
  ) STORED;

COMMENT ON COLUMN estoques.quantidade_disponivel IS
  'Fisico menos reservado, quarentena, bloqueado e area de recebimento. Produto em quarentena nao e disponivel (PROMPT 09, secoes 20 e 33)';

CREATE OR REPLACE VIEW vw_estoque_atual AS
SELECT p.id AS produto_id,
       p.codigo,
       p.descricao,
       c.nome AS categoria,
       u.codigo AS unidade,
       coalesce(sum(e.quantidade_fisica), 0)      AS estoque_fisico,
       coalesce(sum(e.quantidade_reservada), 0)   AS estoque_reservado,
       coalesce(sum(e.quantidade_disponivel), 0)  AS estoque_disponivel,
       coalesce(sum(e.quantidade_em_transito), 0) AS estoque_em_transito,
       coalesce(sum(e.quantidade_quarentena), 0)  AS estoque_quarentena,
       coalesce(sum(e.quantidade_bloqueada), 0)   AS estoque_bloqueado,
       coalesce(sum(e.quantidade_recebimento), 0) AS estoque_em_recebimento,
       p.estoque_minimo,
       p.estoque_seguranca,
       p.ponto_pedido,
       pe.demanda_media_diaria,
       CASE WHEN coalesce(pe.demanda_media_diaria, 0) > 0
            THEN round(coalesce(sum(e.quantidade_disponivel), 0) / pe.demanda_media_diaria, 1)
       END AS cobertura_dias,
       count(e.id) FILTER (WHERE e.quantidade_fisica <> 0) AS locais_com_saldo,
       max(e.updated_at) AS atualizado_em
  FROM produtos p
  JOIN categorias c ON c.id = p.categoria_id
  JOIN unidades u ON u.id = p.unidade_estoque_id
  LEFT JOIN estoques e ON e.produto_id = p.id
  LEFT JOIN parametros_estoque pe ON pe.produto_id = p.id
 WHERE p.deleted_at IS NULL
 GROUP BY p.id, p.codigo, p.descricao, c.nome, u.codigo,
          p.estoque_minimo, p.estoque_seguranca, p.ponto_pedido, pe.demanda_media_diaria;

CREATE OR REPLACE VIEW vw_base_planejamento AS
SELECT p.id AS produto_id,
       p.codigo,
       p.descricao,
       p.categoria_id,
       p.classificacao_abc,
       p.classificacao_xyz,
       p.dias_validade,
       p.lead_time_padrao_dias,
       coalesce(sum(e.quantidade_fisica), 0)      AS estoque_fisico,
       coalesce(sum(e.quantidade_disponivel), 0)  AS estoque_disponivel,
       coalesce(sum(e.quantidade_reservada), 0)   AS estoque_reservado,
       coalesce(sum(e.quantidade_em_transito), 0) AS estoque_em_transito,
       coalesce(sum(e.quantidade_quarentena), 0)  AS estoque_quarentena,
       pe.demanda_media_diaria,
       pe.desvio_padrao_demanda,
       pe.lead_time_dias,
       pe.estoque_seguranca,
       pe.ponto_pedido,
       pe.estoque_maximo,
       pe.cobertura_alvo_dias,
       pe.estrategia_reposicao,
       pf.fornecedor_id       AS fornecedor_principal_id,
       pf.preco_atual,
       pf.moq                 AS moq_fornecedor,
       pf.multiplo_compra     AS multiplo_fornecedor,
       pf.lead_time_dias      AS lead_time_fornecedor
  FROM produtos p
  LEFT JOIN estoques e ON e.produto_id = p.id
  LEFT JOIN parametros_estoque pe ON pe.produto_id = p.id
  LEFT JOIN produto_fornecedor pf
         ON pf.produto_id = p.id AND pf.fornecedor_principal AND pf.ativo
 WHERE p.deleted_at IS NULL AND p.ativo
 GROUP BY p.id, p.codigo, p.descricao, p.categoria_id, p.classificacao_abc,
          p.classificacao_xyz, p.dias_validade, p.lead_time_padrao_dias,
          pe.demanda_media_diaria, pe.desvio_padrao_demanda, pe.lead_time_dias,
          pe.estoque_seguranca, pe.ponto_pedido, pe.estoque_maximo,
          pe.cobertura_alvo_dias, pe.estrategia_reposicao,
          pf.fornecedor_id, pf.preco_atual, pf.moq, pf.multiplo_compra, pf.lead_time_dias;

CREATE OR REPLACE VIEW vw_produtos_criticos AS
SELECT v.produto_id,
       v.codigo,
       v.descricao,
       v.categoria,
       v.estoque_disponivel,
       v.estoque_em_transito,
       v.estoque_quarentena,
       v.demanda_media_diaria,
       v.cobertura_dias,
       coalesce(pe.lead_time_dias, p.lead_time_padrao_dias) AS lead_time_dias,
       v.ponto_pedido,
       v.estoque_minimo,
       v.estoque_seguranca,
       CASE
         WHEN v.estoque_disponivel <= 0 THEN 'RUPTURA'
         WHEN v.estoque_disponivel < v.estoque_seguranca THEN 'ABAIXO_SEGURANCA'
         WHEN v.estoque_disponivel < v.estoque_minimo THEN 'ABAIXO_MINIMO'
         WHEN v.ponto_pedido > 0 AND v.estoque_disponivel <= v.ponto_pedido THEN 'PONTO_PEDIDO'
         WHEN p.estoque_maximo IS NOT NULL AND v.estoque_disponivel > p.estoque_maximo THEN 'EXCESSO'
         ELSE 'NORMAL'
       END AS situacao,
       p.classificacao_abc,
       p.classificacao_xyz
  FROM vw_estoque_atual v
  JOIN produtos p ON p.id = v.produto_id
  LEFT JOIN parametros_estoque pe ON pe.produto_id = v.produto_id
 WHERE p.ativo;

-- ---------------------------------------------------------------------------
-- 3. RECEBIMENTOS - os campos da secao 8
-- ---------------------------------------------------------------------------
ALTER TABLE recebimentos
  ADD COLUMN entrega_id            BIGINT REFERENCES entregas (id) ON DELETE SET NULL,
  ADD COLUMN origem                TEXT NOT NULL DEFAULT 'ENTREGA',
  ADD COLUMN data_prevista         DATE,
  ADD COLUMN data_chegada          TIMESTAMPTZ,
  ADD COLUMN conferencia_inicio    TIMESTAMPTZ,
  ADD COLUMN conferencia_fim       TIMESTAMPTZ,
  ADD COLUMN responsavel_id        BIGINT REFERENCES usuarios (id),
  ADD COLUMN transportadora        TEXT,
  ADD COLUMN placa                 TEXT,
  ADD COLUMN motorista             TEXT,
  ADD COLUMN serie_nota_fiscal     TEXT,
  ADD COLUMN volumes               INTEGER,
  ADD COLUMN tipo_operacao         TEXT NOT NULL DEFAULT 'COMPRA',
  ADD COLUMN doca                  TEXT,
  ADD COLUMN data_aprovacao        TIMESTAMPTZ,
  ADD COLUMN aprovador_id          BIGINT REFERENCES usuarios (id),
  ADD COLUMN justificativa_decisao TEXT,
  ADD COLUMN documentos_conferidos BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN quantidade_recebida   NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN quantidade_aceita     NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN quantidade_rejeitada  NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN quantidade_quarentena NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN valor_recebido        NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN created_by            BIGINT REFERENCES usuarios (id),
  ADD CONSTRAINT ck_recebimentos_origem
    CHECK (origem IN ('ENTREGA', 'PEDIDO', 'PROGRAMACAO', 'NOTA_FISCAL', 'TRANSPORTE', 'MANUAL')),
  ADD CONSTRAINT ck_recebimentos_conferencia
    CHECK (conferencia_fim IS NULL OR conferencia_inicio IS NULL
           OR conferencia_fim >= conferencia_inicio);

-- status, fornecedor, pedido e data ja tinham indice desde o modulo 03.
CREATE INDEX ix_recebimentos_entrega ON recebimentos (entrega_id) WHERE entrega_id IS NOT NULL;
CREATE INDEX ix_recebimentos_prevista ON recebimentos (data_prevista) WHERE data_prevista IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. RECEBIMENTO_ITENS - conferencia, lote, validade e destino
-- ---------------------------------------------------------------------------
ALTER TABLE recebimento_itens
  ADD COLUMN entrega_item_id       BIGINT REFERENCES entrega_itens (id) ON DELETE SET NULL,
  ADD COLUMN unidade_id            BIGINT REFERENCES unidades (id),
  ADD COLUMN fator_conversao       NUMERIC(14, 6) NOT NULL DEFAULT 1,
  ADD COLUMN quantidade_conferida  NUMERIC(14, 3),
  ADD COLUMN quantidade_quarentena NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN quantidade_devolvida  NUMERIC(14, 3) NOT NULL DEFAULT 0,
  ADD COLUMN numero_lote           TEXT,
  ADD COLUMN data_fabricacao       DATE,
  ADD COLUMN data_validade         DATE,
  ADD COLUMN vida_util_dias        INTEGER,
  ADD COLUMN vida_util_restante_percentual NUMERIC(8, 4),
  ADD COLUMN situacao_validade     situacao_validade_enum NOT NULL DEFAULT 'SEM_CONTROLE',
  ADD COLUMN destino               destino_recebimento_enum,
  ADD COLUMN local_id              BIGINT REFERENCES locais (id),
  ADD COLUMN localizacao           TEXT,
  ADD COLUMN conferido_por         BIGINT REFERENCES usuarios (id),
  ADD COLUMN conferido_em          TIMESTAMPTZ,
  ADD COLUMN observacao            TEXT,
  ADD CONSTRAINT ck_recebimento_itens_quantidades
    CHECK (quantidade_quarentena >= 0 AND quantidade_devolvida >= 0
           AND (quantidade_conferida IS NULL OR quantidade_conferida >= 0)),
  ADD CONSTRAINT ck_recebimento_itens_fator CHECK (fator_conversao > 0);

-- produto, lote, recebimento e item do pedido ja tinham indice.
CREATE INDEX ix_recebimento_itens_validade ON recebimento_itens (data_validade)
  WHERE data_validade IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. PRODUTOS e PRODUTO_FORNECEDOR - controle de lote e validade minima
-- ---------------------------------------------------------------------------
ALTER TABLE produtos
  ADD COLUMN controla_lote            BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN controla_validade        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN vida_util_minima_percentual NUMERIC(6, 2),
  ADD COLUMN exige_inspecao           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN checklist_qualidade_id   BIGINT,
  ADD CONSTRAINT ck_produtos_vida_util_minima
    CHECK (vida_util_minima_percentual IS NULL
           OR (vida_util_minima_percentual >= 0 AND vida_util_minima_percentual <= 100));

-- Produto com prazo de validade cadastrado passa a controlar lote e validade.
UPDATE produtos SET controla_lote = true, controla_validade = true
 WHERE dias_validade IS NOT NULL AND dias_validade > 0;

ALTER TABLE produto_fornecedor
  ADD COLUMN vida_util_minima_percentual NUMERIC(6, 2),
  ADD CONSTRAINT ck_produto_fornecedor_vida_util
    CHECK (vida_util_minima_percentual IS NULL
           OR (vida_util_minima_percentual >= 0 AND vida_util_minima_percentual <= 100));

-- ---------------------------------------------------------------------------
-- 6. Tolerancias (secao 13) - por empresa, categoria, produto ou fornecedor
--
-- Uma linha por escopo. A resolucao vai do mais especifico para o mais geral;
-- a linha de escopo EMPRESA e o piso que sempre existe.
-- ---------------------------------------------------------------------------
CREATE TABLE parametros_tolerancia (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  escopo                TEXT NOT NULL,
  produto_id            BIGINT REFERENCES produtos (id) ON DELETE CASCADE,
  categoria_id          BIGINT REFERENCES categorias (id) ON DELETE CASCADE,
  fornecedor_id         BIGINT REFERENCES fornecedores (id) ON DELETE CASCADE,
  tipo_operacao         TEXT,
  quantidade_percentual NUMERIC(6, 2) NOT NULL DEFAULT 0,
  peso_percentual       NUMERIC(6, 2) NOT NULL DEFAULT 0,
  valor_percentual      NUMERIC(6, 2) NOT NULL DEFAULT 0,
  validade_dias         INTEGER NOT NULL DEFAULT 0,
  ativo                 BOOLEAN NOT NULL DEFAULT true,
  observacao            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            BIGINT REFERENCES usuarios (id),
  CONSTRAINT ck_parametros_tolerancia_escopo
    CHECK (escopo IN ('EMPRESA', 'CATEGORIA', 'PRODUTO', 'FORNECEDOR', 'OPERACAO')),
  CONSTRAINT ck_parametros_tolerancia_alvo CHECK (
    (escopo = 'EMPRESA'    AND produto_id IS NULL AND categoria_id IS NULL AND fornecedor_id IS NULL)
    OR (escopo = 'CATEGORIA'  AND categoria_id IS NOT NULL)
    OR (escopo = 'PRODUTO'    AND produto_id IS NOT NULL)
    OR (escopo = 'FORNECEDOR' AND fornecedor_id IS NOT NULL)
    OR (escopo = 'OPERACAO'   AND tipo_operacao IS NOT NULL)),
  CONSTRAINT ck_parametros_tolerancia_valores
    CHECK (quantidade_percentual >= 0 AND peso_percentual >= 0
           AND valor_percentual >= 0 AND validade_dias >= 0)
);

CREATE UNIQUE INDEX uq_parametros_tolerancia_empresa
  ON parametros_tolerancia ((1)) WHERE escopo = 'EMPRESA' AND ativo;
CREATE UNIQUE INDEX uq_parametros_tolerancia_produto
  ON parametros_tolerancia (produto_id) WHERE escopo = 'PRODUTO' AND ativo;
CREATE UNIQUE INDEX uq_parametros_tolerancia_categoria
  ON parametros_tolerancia (categoria_id) WHERE escopo = 'CATEGORIA' AND ativo;
CREATE UNIQUE INDEX uq_parametros_tolerancia_fornecedor
  ON parametros_tolerancia (fornecedor_id) WHERE escopo = 'FORNECEDOR' AND ativo;

CREATE TRIGGER trg_parametros_tolerancia_updated_at
  BEFORE UPDATE ON parametros_tolerancia
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

INSERT INTO parametros_tolerancia
  (escopo, quantidade_percentual, peso_percentual, valor_percentual, validade_dias, observacao)
VALUES ('EMPRESA', 2, 2, 1, 0, 'Tolerancia padrao da empresa')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 7. Conferencia documental (secao 9)
-- ---------------------------------------------------------------------------
CREATE TABLE recebimento_documentos (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recebimento_id   BIGINT NOT NULL REFERENCES recebimentos (id) ON DELETE CASCADE,
  item             TEXT NOT NULL,
  descricao        TEXT,
  resposta         resposta_checklist_enum NOT NULL,
  observacao       TEXT,
  conferido_por    BIGINT REFERENCES usuarios (id),
  conferido_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recebimento_id, item)
);

CREATE INDEX ix_recebimento_documentos_rec ON recebimento_documentos (recebimento_id);

-- ---------------------------------------------------------------------------
-- 8. Divergencias (secoes 26, 27 e 28) - append-only na origem
-- ---------------------------------------------------------------------------
CREATE TABLE recebimento_divergencias (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recebimento_id        BIGINT NOT NULL REFERENCES recebimentos (id) ON DELETE CASCADE,
  recebimento_item_id   BIGINT REFERENCES recebimento_itens (id) ON DELETE CASCADE,
  produto_id            BIGINT REFERENCES produtos (id),
  tipo                  tipo_divergencia_enum NOT NULL,
  severidade            severidade_nc_enum NOT NULL DEFAULT 'MEDIA',
  descricao             TEXT NOT NULL,
  valor_esperado        TEXT,
  valor_recebido        TEXT,
  diferenca             NUMERIC(14, 3),
  diferenca_percentual  NUMERIC(10, 4),
  tolerancia_aplicada   NUMERIC(10, 4),
  dentro_tolerancia     BOOLEAN NOT NULL DEFAULT false,
  decisao               decisao_divergencia_enum NOT NULL DEFAULT 'PENDENTE',
  justificativa         TEXT,
  decidido_por          BIGINT REFERENCES usuarios (id),
  decidido_em           TIMESTAMPTZ,
  nao_conformidade_id   BIGINT REFERENCES nao_conformidades (id) ON DELETE SET NULL,
  detectada_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  detectada_por         BIGINT REFERENCES usuarios (id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_recebimento_divergencias_rec ON recebimento_divergencias (recebimento_id);
CREATE INDEX ix_recebimento_divergencias_tipo ON recebimento_divergencias (tipo);
CREATE INDEX ix_recebimento_divergencias_pendentes
  ON recebimento_divergencias (decisao) WHERE decisao = 'PENDENTE';

CREATE TRIGGER trg_recebimento_divergencias_updated_at
  BEFORE UPDATE ON recebimento_divergencias
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_recebimento_divergencias_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON recebimento_divergencias
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

-- Secao 58, regra 7: divergencia nao se apaga.
CREATE OR REPLACE FUNCTION fn_divergencia_sem_delete() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Divergencia de recebimento e historico permanente e nao pode ser apagada';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_recebimento_divergencias_sem_delete
  BEFORE DELETE ON recebimento_divergencias
  FOR EACH ROW EXECUTE FUNCTION fn_divergencia_sem_delete();

-- ---------------------------------------------------------------------------
-- 9. Checklists de qualidade (secoes 17 e 18)
-- ---------------------------------------------------------------------------
CREATE TABLE checklists_qualidade (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo        TEXT NOT NULL UNIQUE,
  nome          TEXT NOT NULL,
  descricao     TEXT,
  categoria_id  BIGINT REFERENCES categorias (id) ON DELETE SET NULL,
  tipo_amostragem tipo_amostragem_enum NOT NULL DEFAULT 'AMOSTRAGEM',
  percentual_amostra NUMERIC(6, 2),
  ativo         BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_checklists_amostra
    CHECK (percentual_amostra IS NULL
           OR (percentual_amostra > 0 AND percentual_amostra <= 100))
);

CREATE TABLE checklist_qualidade_itens (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  checklist_id  BIGINT NOT NULL REFERENCES checklists_qualidade (id) ON DELETE CASCADE,
  ordem         INTEGER NOT NULL DEFAULT 1,
  criterio      TEXT NOT NULL,
  descricao     TEXT,
  eliminatorio  BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (checklist_id, criterio)
);

CREATE INDEX ix_checklist_qualidade_itens_cl ON checklist_qualidade_itens (checklist_id, ordem);

ALTER TABLE produtos
  ADD CONSTRAINT produtos_checklist_qualidade_id_fkey
  FOREIGN KEY (checklist_qualidade_id) REFERENCES checklists_qualidade (id) ON DELETE SET NULL;

CREATE TRIGGER trg_checklists_qualidade_updated_at
  BEFORE UPDATE ON checklists_qualidade
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- Checklist padrao para produtos naturais (secao 18).
INSERT INTO checklists_qualidade (codigo, nome, descricao, tipo_amostragem, percentual_amostra)
VALUES ('NATURAIS', 'Produtos naturais',
        'Graos, cereais, frutas secas, oleaginosas, especiarias e sementes',
        'AMOSTRAGEM', 10)
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO checklist_qualidade_itens (checklist_id, ordem, criterio, descricao, eliminatorio)
SELECT c.id, v.ordem, v.criterio, v.descricao, v.eliminatorio
  FROM checklists_qualidade c,
       (VALUES
         (1, 'EMBALAGEM_INTEGRA',  'Embalagem sem rasgos, furos ou violacao', true),
         (2, 'SEM_UMIDADE',        'Sem sinais de umidade ou mofo',           true),
         (3, 'SEM_INFESTACAO',     'Sem insetos, larvas ou residuos',         true),
         (4, 'SEM_ODOR_ESTRANHO',  'Odor caracteristico do produto',          true),
         (5, 'LOTE_IDENTIFICADO',  'Lote legivel na embalagem',               false),
         (6, 'VALIDADE_ADEQUADA',  'Validade dentro do minimo acordado',      false),
         (7, 'PESO_CORRETO',       'Peso conforme a embalagem declara',       false),
         (8, 'CONFORME_ESPECIFICACAO', 'Aparencia, cor e textura conforme especificacao', false)
       ) AS v(ordem, criterio, descricao, eliminatorio)
 WHERE c.codigo = 'NATURAIS'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 10. Inspecao de qualidade - itens do checklist e amostragem
-- ---------------------------------------------------------------------------
ALTER TABLE inspecoes_qualidade
  ADD COLUMN checklist_id        BIGINT REFERENCES checklists_qualidade (id),
  ADD COLUMN tipo_amostragem     tipo_amostragem_enum NOT NULL DEFAULT 'AMOSTRAGEM',
  ADD COLUMN tamanho_lote        NUMERIC(14, 3),
  ADD COLUMN quantidade_amostrada NUMERIC(14, 3),
  ADD COLUMN quantidade_reprovada NUMERIC(14, 3),
  ADD COLUMN quantidade_quarentena NUMERIC(14, 3),
  ADD COLUMN restricao           TEXT,
  ADD COLUMN created_by          BIGINT REFERENCES usuarios (id);

-- recebimento, produto, fornecedor e resultado ja tinham indice; o que falta e
-- o par fornecedor + data, que e como o modulo 10 vai ler.
CREATE INDEX ix_inspecoes_fornecedor_data ON inspecoes_qualidade (fornecedor_id, data_inspecao);

CREATE TABLE inspecao_itens (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inspecao_id   BIGINT NOT NULL REFERENCES inspecoes_qualidade (id) ON DELETE CASCADE,
  checklist_item_id BIGINT REFERENCES checklist_qualidade_itens (id),
  criterio      TEXT NOT NULL,
  eliminatorio  BOOLEAN NOT NULL DEFAULT false,
  resposta      resposta_checklist_enum NOT NULL,
  observacao    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (inspecao_id, criterio)
);

CREATE INDEX ix_inspecao_itens_inspecao ON inspecao_itens (inspecao_id);

-- ---------------------------------------------------------------------------
-- 11. Quarentena (secao 20)
-- ---------------------------------------------------------------------------
CREATE TABLE quarentenas (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero               TEXT NOT NULL UNIQUE,
  recebimento_id       BIGINT REFERENCES recebimentos (id) ON DELETE CASCADE,
  recebimento_item_id  BIGINT REFERENCES recebimento_itens (id) ON DELETE CASCADE,
  produto_id           BIGINT NOT NULL REFERENCES produtos (id),
  lote_id              BIGINT REFERENCES lotes (id),
  local_id             BIGINT REFERENCES locais (id),
  fornecedor_id        BIGINT REFERENCES fornecedores (id),
  quantidade           NUMERIC(14, 3) NOT NULL,
  quantidade_liberada  NUMERIC(14, 3) NOT NULL DEFAULT 0,
  quantidade_rejeitada NUMERIC(14, 3) NOT NULL DEFAULT 0,
  motivo               TEXT NOT NULL,
  status               status_quarentena_enum NOT NULL DEFAULT 'ABERTA',
  aberta_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
  aberta_por           BIGINT REFERENCES usuarios (id),
  decidida_em          TIMESTAMPTZ,
  decidida_por         BIGINT REFERENCES usuarios (id),
  justificativa        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_quarentenas_quantidades
    CHECK (quantidade > 0 AND quantidade_liberada >= 0 AND quantidade_rejeitada >= 0
           AND quantidade_liberada + quantidade_rejeitada <= quantidade)
);

CREATE INDEX ix_quarentenas_status ON quarentenas (status);
CREATE INDEX ix_quarentenas_produto ON quarentenas (produto_id);

CREATE TRIGGER trg_quarentenas_updated_at
  BEFORE UPDATE ON quarentenas
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_quarentenas_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON quarentenas
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

-- ---------------------------------------------------------------------------
-- 12. Devolucao (secao 29)
-- ---------------------------------------------------------------------------
CREATE TABLE devolucoes (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero           TEXT NOT NULL UNIQUE,
  recebimento_id   BIGINT REFERENCES recebimentos (id) ON DELETE SET NULL,
  ordem_compra_id  BIGINT REFERENCES ordens_compra (id) ON DELETE SET NULL,
  fornecedor_id    BIGINT NOT NULL REFERENCES fornecedores (id),
  motivo           motivo_devolucao_enum NOT NULL,
  descricao        TEXT,
  status           status_devolucao_enum NOT NULL DEFAULT 'RASCUNHO',
  quantidade_total NUMERIC(14, 3) NOT NULL DEFAULT 0,
  valor_total      NUMERIC(14, 2) NOT NULL DEFAULT 0,
  numero_nota_fiscal TEXT,
  chave_nfe        TEXT,
  transportadora   TEXT,
  data_devolucao   DATE,
  autorizado_por   BIGINT REFERENCES usuarios (id),
  autorizado_em    TIMESTAMPTZ,
  justificativa    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       BIGINT REFERENCES usuarios (id)
);

CREATE TABLE devolucao_itens (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  devolucao_id         BIGINT NOT NULL REFERENCES devolucoes (id) ON DELETE CASCADE,
  recebimento_item_id  BIGINT REFERENCES recebimento_itens (id) ON DELETE SET NULL,
  produto_id           BIGINT NOT NULL REFERENCES produtos (id),
  lote_id              BIGINT REFERENCES lotes (id),
  quantidade           NUMERIC(14, 3) NOT NULL,
  preco_unitario       NUMERIC(14, 4),
  valor_total          NUMERIC(14, 2),
  observacao           TEXT,
  CONSTRAINT ck_devolucao_itens_qtd CHECK (quantidade > 0)
);

CREATE INDEX ix_devolucoes_fornecedor ON devolucoes (fornecedor_id);
CREATE INDEX ix_devolucoes_status ON devolucoes (status);
CREATE INDEX ix_devolucao_itens_dev ON devolucao_itens (devolucao_id);

CREATE TRIGGER trg_devolucoes_updated_at
  BEFORE UPDATE ON devolucoes
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_devolucoes_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON devolucoes
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

-- ---------------------------------------------------------------------------
-- 13. Nao conformidades - severidade, plano de acao e rastro
-- ---------------------------------------------------------------------------
ALTER TABLE nao_conformidades
  ADD COLUMN numero              TEXT,
  ADD COLUMN recebimento_item_id BIGINT REFERENCES recebimento_itens (id) ON DELETE SET NULL,
  ADD COLUMN divergencia_id      BIGINT REFERENCES recebimento_divergencias (id) ON DELETE SET NULL,
  ADD COLUMN severidade          severidade_nc_enum NOT NULL DEFAULT 'MEDIA',
  ADD COLUMN causa               TEXT,
  ADD COLUMN prazo               DATE,
  ADD COLUMN validado_por        BIGINT REFERENCES usuarios (id),
  ADD COLUMN validado_em         TIMESTAMPTZ,
  ADD COLUMN encerrado_em        TIMESTAMPTZ,
  ADD COLUMN created_by          BIGINT REFERENCES usuarios (id);

CREATE UNIQUE INDEX uq_nao_conformidades_numero ON nao_conformidades (numero)
  WHERE numero IS NOT NULL;
CREATE INDEX ix_nao_conformidades_severidade ON nao_conformidades (severidade);
CREATE INDEX ix_nao_conformidades_fornecedor_data
  ON nao_conformidades (fornecedor_id, created_at);

CREATE TABLE nao_conformidade_acoes (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nao_conformidade_id BIGINT NOT NULL REFERENCES nao_conformidades (id) ON DELETE CASCADE,
  tipo                TEXT NOT NULL,
  descricao           TEXT NOT NULL,
  responsavel_id      BIGINT REFERENCES usuarios (id),
  prazo               DATE,
  status              TEXT NOT NULL DEFAULT 'PENDENTE',
  evidencia           TEXT,
  concluida_em        TIMESTAMPTZ,
  resultado           TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          BIGINT REFERENCES usuarios (id),
  CONSTRAINT ck_nc_acoes_tipo CHECK (tipo IN ('CORRETIVA', 'PREVENTIVA', 'CONTENCAO')),
  CONSTRAINT ck_nc_acoes_status
    CHECK (status IN ('PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDA', 'CANCELADA'))
);

CREATE INDEX ix_nc_acoes_nc ON nao_conformidade_acoes (nao_conformidade_id);

CREATE TRIGGER trg_nc_acoes_updated_at
  BEFORE UPDATE ON nao_conformidade_acoes
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- 14. Aprovacoes de excecao (secao 44) e anexos (secao 35)
-- ---------------------------------------------------------------------------
CREATE TABLE recebimento_aprovacoes (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recebimento_id      BIGINT NOT NULL REFERENCES recebimentos (id) ON DELETE CASCADE,
  recebimento_item_id BIGINT REFERENCES recebimento_itens (id) ON DELETE CASCADE,
  tipo                tipo_excecao_recebimento_enum NOT NULL,
  descricao           TEXT NOT NULL,
  decisao             TEXT NOT NULL,
  justificativa       TEXT NOT NULL,
  usuario_id          BIGINT REFERENCES usuarios (id),
  perfil              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_recebimento_aprovacoes_decisao
    CHECK (decisao IN ('APROVADA', 'RECUSADA')),
  CONSTRAINT ck_recebimento_aprovacoes_justificativa
    CHECK (length(btrim(justificativa)) >= 5)
);

CREATE INDEX ix_recebimento_aprovacoes_rec ON recebimento_aprovacoes (recebimento_id);

-- Secao 58, regra 8: excecao tem responsavel e justificativa, e nao se apaga.
CREATE OR REPLACE FUNCTION fn_aprovacao_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Aprovacao de excecao e registro permanente e nao aceita alteracao nem exclusao';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_recebimento_aprovacoes_append_only
  BEFORE UPDATE OR DELETE ON recebimento_aprovacoes
  FOR EACH ROW EXECUTE FUNCTION fn_aprovacao_append_only();

CREATE TABLE recebimento_anexos (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recebimento_id      BIGINT REFERENCES recebimentos (id) ON DELETE CASCADE,
  recebimento_item_id BIGINT REFERENCES recebimento_itens (id) ON DELETE CASCADE,
  lote_id             BIGINT REFERENCES lotes (id) ON DELETE SET NULL,
  nao_conformidade_id BIGINT REFERENCES nao_conformidades (id) ON DELETE CASCADE,
  inspecao_id         BIGINT REFERENCES inspecoes_qualidade (id) ON DELETE CASCADE,
  tipo                tipo_anexo_enum NOT NULL,
  nome                TEXT NOT NULL,
  descricao           TEXT,
  referencia          TEXT,
  usuario_id          BIGINT REFERENCES usuarios (id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_recebimento_anexos_vinculo CHECK (
    recebimento_id IS NOT NULL OR nao_conformidade_id IS NOT NULL
    OR inspecao_id IS NOT NULL)
);

CREATE INDEX ix_recebimento_anexos_rec ON recebimento_anexos (recebimento_id);
CREATE INDEX ix_recebimento_anexos_nc ON recebimento_anexos (nao_conformidade_id);

-- ---------------------------------------------------------------------------
-- 15. Lotes - o que faltava para rastrear a origem (secao 62)
-- ---------------------------------------------------------------------------
ALTER TABLE lotes
  ADD COLUMN recebimento_id      BIGINT REFERENCES recebimentos (id) ON DELETE SET NULL,
  ADD COLUMN recebimento_item_id BIGINT REFERENCES recebimento_itens (id) ON DELETE SET NULL,
  ADD COLUMN ordem_compra_id     BIGINT REFERENCES ordens_compra (id) ON DELETE SET NULL,
  ADD COLUMN numero_nota_fiscal  TEXT,
  ADD COLUMN local_id            BIGINT REFERENCES locais (id),
  ADD COLUMN custo_unitario      NUMERIC(14, 4);

-- recebimento_itens.lote_id ja apontava para LOTES desde o modulo 03.

-- ---------------------------------------------------------------------------
-- 16. Rastreabilidade fornecedor -> pedido -> entrega -> NF -> recebimento ->
--     produto -> lote -> qualidade -> estoque (secao 62)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_rastreabilidade_recebimento AS
SELECT r.id                     AS recebimento_id,
       r.numero                 AS recebimento,
       r.status                 AS status_recebimento,
       r.data_recebimento,
       r.numero_nota_fiscal,
       r.chave_nfe,
       f.id                     AS fornecedor_id,
       f.razao_social           AS fornecedor,
       oc.id                    AS ordem_compra_id,
       oc.numero                AS pedido,
       e.id                     AS entrega_id,
       e.numero                 AS entrega,
       ri.id                    AS recebimento_item_id,
       p.id                     AS produto_id,
       p.codigo                 AS produto_codigo,
       p.descricao              AS produto,
       ri.quantidade_pedida,
       ri.quantidade_recebida,
       ri.quantidade_aceita,
       ri.quantidade_rejeitada,
       ri.quantidade_quarentena,
       ri.numero_lote,
       ri.data_validade,
       ri.situacao_validade,
       ri.destino,
       l.id                     AS lote_id,
       l.quantidade_atual       AS lote_saldo,
       l.status                 AS lote_status,
       iq.id                    AS inspecao_id,
       iq.resultado             AS resultado_qualidade,
       loc.nome                 AS local,
       (SELECT count(*) FROM movimentacoes_estoque m
         WHERE m.documento_tipo = 'RECEBIMENTO' AND m.documento_id = r.id
           AND m.produto_id = ri.produto_id) AS movimentacoes
  FROM recebimentos r
  JOIN fornecedores f ON f.id = r.fornecedor_id
  LEFT JOIN ordens_compra oc ON oc.id = r.ordem_compra_id
  LEFT JOIN entregas e ON e.id = r.entrega_id
  JOIN recebimento_itens ri ON ri.recebimento_id = r.id
  JOIN produtos p ON p.id = ri.produto_id
  LEFT JOIN lotes l ON l.id = ri.lote_id
  LEFT JOIN inspecoes_qualidade iq ON iq.recebimento_item_id = ri.id
  LEFT JOIN locais loc ON loc.id = coalesce(ri.local_id, r.local_id);

-- ---------------------------------------------------------------------------
-- 17. Configuracoes (grupo recebimento)
-- ---------------------------------------------------------------------------
INSERT INTO configuracoes (chave, valor, tipo, grupo, descricao) VALUES
  ('recebimento.prefixo_numero', 'REC', 'STRING', 'recebimento',
   'Prefixo do numero do recebimento'),
  ('recebimento.prefixo_quarentena', 'QUA', 'STRING', 'recebimento',
   'Prefixo do numero da quarentena'),
  ('recebimento.prefixo_devolucao', 'DEV', 'STRING', 'recebimento',
   'Prefixo do numero da devolucao'),
  ('recebimento.prefixo_nc', 'NC', 'STRING', 'recebimento',
   'Prefixo do numero da nao conformidade'),
  ('recebimento.vida_util_minima_percentual', '80', 'NUMERO', 'recebimento',
   'Percentual minimo de vida util restante exigido quando o produto nao define o seu'),
  ('recebimento.validade_proxima_percentual', '90', 'NUMERO', 'recebimento',
   'Abaixo deste percentual de vida util a validade ja e sinalizada como proxima'),
  ('recebimento.validade_critica_percentual', '85', 'NUMERO', 'recebimento',
   'Abaixo deste percentual de vida util a validade e critica'),
  ('recebimento.exigir_lote_produto_controlado', 'true', 'BOOLEANO', 'recebimento',
   'Bloqueia a aprovacao de item de produto controlado por lote sem lote informado'),
  ('recebimento.exigir_conferencia', 'true', 'BOOLEANO', 'recebimento',
   'Bloqueia entrada definitiva sem conferencia de todos os itens'),
  ('recebimento.exigir_documentos', 'false', 'BOOLEANO', 'recebimento',
   'Exige a conferencia documental concluida antes da aprovacao'),
  ('recebimento.destino_padrao', 'DISPONIVEL', 'STRING', 'recebimento',
   'Destino do item aprovado sem restricao: DISPONIVEL, QUARENTENA ou AREA_RECEBIMENTO'),
  ('recebimento.excesso_exige_aprovacao', 'true', 'BOOLEANO', 'recebimento',
   'Excesso acima da tolerancia exige decisao explicita antes de entrar'),
  ('recebimento.custo_inclui_frete', 'true', 'BOOLEANO', 'recebimento',
   'Rateia o frete do pedido no custo unitario de entrada'),
  ('recebimento.custo_inclui_impostos', 'false', 'BOOLEANO', 'recebimento',
   'Soma os impostos do item no custo unitario de entrada'),
  ('recebimento.dias_alerta_validade', '30', 'NUMERO', 'recebimento',
   'Dias de validade restante que disparam alerta no recebimento')
ON CONFLICT (chave) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 18. Permissoes (secao 43)
-- ---------------------------------------------------------------------------
INSERT INTO permissoes (codigo, modulo, descricao) VALUES
  ('recebimento.ler',           'recebimento', 'Consultar recebimentos, conferencias e indicadores'),
  ('recebimento.registrar',     'recebimento', 'Registrar chegada e realizar conferencia'),
  ('recebimento.aprovar',       'recebimento', 'Aprovar, reprovar ou aprovar parcialmente o recebimento'),
  ('qualidade.inspecionar',     'qualidade',   'Realizar inspecao de qualidade'),
  ('qualidade.liberar',         'qualidade',   'Liberar ou rejeitar produto em quarentena'),
  ('qualidade.nao_conformidade', 'qualidade',  'Abrir e tratar nao conformidades'),
  ('recebimento.devolucao',     'recebimento', 'Autorizar e registrar devolucao ao fornecedor'),
  ('recebimento.excecao',       'recebimento', 'Autorizar excecoes: validade, excesso e fora de tolerancia'),
  ('recebimento.parametrizar',  'recebimento', 'Alterar tolerancias, checklists e parametros de recebimento')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.modulo IN ('recebimento', 'qualidade')
WHERE pf.nome = 'ADMIN'
ON CONFLICT DO NOTHING;

-- GESTOR_COMPRAS aprova excecoes e devolucoes, mas nao inspeciona.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo IN
  ('recebimento.ler', 'recebimento.aprovar', 'recebimento.devolucao',
   'recebimento.excecao', 'recebimento.parametrizar', 'qualidade.nao_conformidade')
WHERE pf.nome = 'GESTOR_COMPRAS'
ON CONFLICT DO NOTHING;

-- ESTOQUE registra a chegada e confere. Nao aprova qualidade.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo IN ('recebimento.ler', 'recebimento.registrar')
WHERE pf.nome = 'ESTOQUE'
ON CONFLICT DO NOTHING;

-- QUALIDADE inspeciona, libera quarentena e trata NC. Nao confere quantidade.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo IN
  ('recebimento.ler', 'qualidade.inspecionar', 'qualidade.liberar',
   'qualidade.nao_conformidade')
WHERE pf.nome = 'QUALIDADE'
ON CONFLICT DO NOTHING;

-- COMPRADOR consulta e trata a divergencia comercial.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo IN ('recebimento.ler', 'qualidade.nao_conformidade')
WHERE pf.nome = 'COMPRADOR'
ON CONFLICT DO NOTHING;

-- FINANCEIRO e DIRETORIA consultam.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo = 'recebimento.ler'
WHERE pf.nome IN ('FINANCEIRO', 'DIRETORIA')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE parametros_tolerancia IS
  'Tolerancias de quantidade, peso, valor e validade por escopo. A resolucao vai do mais especifico (produto) ao mais geral (empresa), PROMPT 09 secao 13';
COMMENT ON TABLE quarentenas IS
  'Produto retido para analise. A quantidade sai de disponivel e so volta com liberacao autorizada (secao 20)';
COMMENT ON TABLE recebimento_aprovacoes IS
  'Excecao autorizada: quem, quando, decisao e justificativa. Append-only (secao 44 e regra 8 da secao 58)';
