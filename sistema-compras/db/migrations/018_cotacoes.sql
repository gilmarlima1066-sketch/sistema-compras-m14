-- ===========================================================================
-- MODULO 06 - Cotacoes, comparacao e analise de fornecedores
--
-- Reaproveita COTACOES, COTACAO_FORNECEDORES, COTACAO_ITENS, NEGOCIACOES,
-- HISTORICO_PRECOS, PRODUTO_FORNECEDOR, AVALIACOES_FORNECEDORES,
-- NECESSIDADES_COMPRA e REQUISICOES_COMPRA.
--
-- A mudanca estrutural importante: `cotacao_itens` guardava ao mesmo tempo o
-- que foi PEDIDO e o que foi OFERTADO. Isso impede pedir um produto sem ter
-- resposta (secao 10 do prompt: resposta parcial nao e preco zero). Entao a
-- linha do pedido passa a morar em `cotacao_produtos`, e `cotacao_itens` fica
-- sendo so a proposta de cada fornecedor, apontando para ela.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Estados do fluxo (secoes 33 e 44)
-- ---------------------------------------------------------------------------
ALTER TYPE status_cotacao_enum ADD VALUE IF NOT EXISTS 'ENVIADA';
ALTER TYPE status_cotacao_enum ADD VALUE IF NOT EXISTS 'AGUARDANDO_RESPOSTAS';
ALTER TYPE status_cotacao_enum ADD VALUE IF NOT EXISTS 'EM_ANALISE';
ALTER TYPE status_cotacao_enum ADD VALUE IF NOT EXISTS 'NEGOCIACAO_NECESSARIA';
ALTER TYPE status_cotacao_enum ADD VALUE IF NOT EXISTS 'APROVADA_NEGOCIACAO';
ALTER TYPE status_cotacao_enum ADD VALUE IF NOT EXISTS 'ENCAMINHADA';
ALTER TYPE status_cotacao_enum ADD VALUE IF NOT EXISTS 'REJEITADA';

ALTER TYPE status_cotacao_fornecedor_enum ADD VALUE IF NOT EXISTS 'NAO_ENVIADO';
ALTER TYPE status_cotacao_fornecedor_enum ADD VALUE IF NOT EXISTS 'VISUALIZADO';
ALTER TYPE status_cotacao_fornecedor_enum ADD VALUE IF NOT EXISTS 'PARCIALMENTE_RESPONDIDA';
ALTER TYPE status_cotacao_fornecedor_enum ADD VALUE IF NOT EXISTS 'EXPIRADO';

CREATE TYPE origem_cotacao_enum AS ENUM ('REQUISICAO', 'NECESSIDADES', 'MANUAL');
CREATE TYPE incoterm_enum AS ENUM
  ('EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP');
CREATE TYPE disponibilidade_enum AS ENUM
  ('IMEDIATA', 'PARCIAL', 'PRODUCAO', 'INDISPONIVEL');
CREATE TYPE direcao_criterio_enum AS ENUM ('MAIOR_MELHOR', 'MENOR_MELHOR');
CREATE TYPE tipo_cenario_cotacao_enum AS ENUM
  ('MENOR_CUSTO', 'MENOR_PRAZO', 'MAIOR_PRAZO_PAGAMENTO', 'FORNECEDOR_UNICO',
   'COMPRA_DIVIDIDA', 'MELHOR_SCORE', 'PERSONALIZADO');
CREATE TYPE referencia_economia_enum AS ENUM
  ('ULTIMA_COMPRA', 'PRECO_MEDIO', 'ORCAMENTO', 'PRECO_ALVO', 'MELHOR_PROPOSTA_ANTERIOR');

-- ---------------------------------------------------------------------------
-- 2. Cabecalho da cotacao
-- ---------------------------------------------------------------------------
ALTER TABLE cotacoes
  ADD COLUMN requisicao_id        BIGINT REFERENCES requisicoes_compra (id),
  ADD COLUMN origem               origem_cotacao_enum NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN prioridade           prioridade_compra_enum NOT NULL DEFAULT 'MEDIA',
  ADD COLUMN solicitante_id       BIGINT REFERENCES usuarios (id),
  ADD COLUMN comprador_id         BIGINT REFERENCES usuarios (id),
  ADD COLUMN local_entrega_id     BIGINT REFERENCES locais (id),
  ADD COLUMN data_necessaria      DATE,
  ADD COLUMN moeda_base           CHAR(3) NOT NULL DEFAULT 'BRL',
  ADD COLUMN referencia_economia  referencia_economia_enum NOT NULL DEFAULT 'ULTIMA_COMPRA',
  ADD COLUMN pesos_utilizados     JSONB,
  ADD COLUMN analisada_em         TIMESTAMPTZ,
  ADD COLUMN recomendacao         JSONB,
  ADD COLUMN decisao_divergente   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN justificativa_decisao TEXT,
  ADD COLUMN decidido_por         BIGINT REFERENCES usuarios (id),
  ADD COLUMN decidido_em          TIMESTAMPTZ,
  ADD COLUMN aprovador_id         BIGINT REFERENCES usuarios (id),
  ADD COLUMN aprovado_em          TIMESTAMPTZ,
  ADD COLUMN nivel_aprovacao      TEXT,
  ADD COLUMN motivo_rejeicao      TEXT,
  ADD COLUMN valor_selecionado    NUMERIC(16, 2),
  ADD COLUMN economia_estimada    NUMERIC(16, 2);

CREATE INDEX ix_cotacoes_requisicao ON cotacoes (requisicao_id);
CREATE INDEX ix_cotacoes_comprador ON cotacoes (comprador_id);

-- ---------------------------------------------------------------------------
-- 3. Produtos pedidos na cotacao (secao 6)
--
-- Uma linha por produto cotado, independente de quantos fornecedores respondam.
-- E ela que permite dizer "3 produtos sem resposta" sem inventar preco zero.
-- ---------------------------------------------------------------------------
CREATE TABLE cotacao_produtos (
  id                    BIGSERIAL PRIMARY KEY,
  cotacao_id            BIGINT NOT NULL REFERENCES cotacoes (id) ON DELETE CASCADE,
  produto_id            BIGINT NOT NULL REFERENCES produtos (id) ON DELETE RESTRICT,
  necessidade_id        BIGINT REFERENCES necessidades_compra (id),
  quantidade            NUMERIC(14, 3) NOT NULL,
  quantidade_minima     NUMERIC(14, 3),
  unidade_id            BIGINT REFERENCES unidades (id),
  fator_conversao       NUMERIC(12, 4) NOT NULL DEFAULT 1,
  moq_esperado          NUMERIC(14, 3),
  multiplo_esperado     NUMERIC(14, 3),
  lead_time_esperado    INTEGER,
  data_necessaria       DATE,
  local_entrega_id      BIGINT REFERENCES locais (id),
  fornecedor_sugerido_id BIGINT REFERENCES fornecedores (id),
  valor_estimado        NUMERIC(16, 2),
  preco_alvo            NUMERIC(14, 4),
  preco_maximo          NUMERIC(14, 4),
  -- Requisitos obrigatorios (secao 21): nao sao compensaveis por preco.
  validade_minima_dias  INTEGER,
  especificacao         TEXT,
  observacao            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_cotacao_produto_qtd CHECK (quantidade > 0),
  CONSTRAINT uq_cotacao_produto UNIQUE (cotacao_id, produto_id)
);
CREATE INDEX ix_cotacao_produtos_cotacao ON cotacao_produtos (cotacao_id);
CREATE INDEX ix_cotacao_produtos_produto ON cotacao_produtos (produto_id);
CREATE INDEX ix_cotacao_produtos_necessidade ON cotacao_produtos (necessidade_id);

CREATE TRIGGER trg_cotacao_produtos_updated_at
  BEFORE UPDATE ON cotacao_produtos
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Proposta do fornecedor (secoes 9 a 13, 31, 32)
-- ---------------------------------------------------------------------------
ALTER TABLE cotacao_itens
  ADD COLUMN cotacao_produto_id   BIGINT REFERENCES cotacao_produtos (id) ON DELETE CASCADE,
  ADD COLUMN moq                  NUMERIC(14, 3),
  ADD COLUMN multiplo             NUMERIC(14, 3),
  ADD COLUMN disponibilidade      disponibilidade_enum,
  ADD COLUMN data_disponivel      DATE,
  ADD COLUMN data_prevista_entrega DATE,
  ADD COLUMN validade_produto_dias INTEGER,
  ADD COLUMN incoterm             incoterm_enum,
  ADD COLUMN seguro               NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN desembaraco          NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN taxas                NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN taxa_cambio          NUMERIC(14, 6),
  ADD COLUMN data_taxa_cambio     DATE,
  ADD COLUMN custo_total_base     NUMERIC(16, 2),
  ADD COLUMN preco_liquido        NUMERIC(14, 4),
  ADD COLUMN atendimento_percentual NUMERIC(8, 4),
  ADD COLUMN elegivel             BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN motivos_inelegibilidade JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN score                NUMERIC(8, 4),
  ADD COLUMN posicao              INTEGER,
  ADD COLUMN recomendado          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN alertas              JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN respondido_em        TIMESTAMPTZ;

CREATE INDEX ix_cotacao_itens_produto_cot ON cotacao_itens (cotacao_produto_id);
CREATE INDEX ix_cotacao_itens_score ON cotacao_itens (cotacao_id, score DESC NULLS LAST);

-- Faixas de desconto por volume (secao 29)
CREATE TABLE cotacao_faixas_preco (
  id               BIGSERIAL PRIMARY KEY,
  cotacao_item_id  BIGINT NOT NULL REFERENCES cotacao_itens (id) ON DELETE CASCADE,
  quantidade_de    NUMERIC(14, 3) NOT NULL,
  quantidade_ate   NUMERIC(14, 3),
  preco_unitario   NUMERIC(14, 4) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_faixa_intervalo CHECK (quantidade_ate IS NULL OR quantidade_ate >= quantidade_de),
  CONSTRAINT ck_faixa_preco CHECK (preco_unitario >= 0)
);
CREATE INDEX ix_cotacao_faixas_item ON cotacao_faixas_preco (cotacao_item_id, quantidade_de);

-- Envio e lembrete por fornecedor (secoes 8 e 33)
ALTER TABLE cotacao_fornecedores
  ADD COLUMN canal_envio       TEXT,
  ADD COLUMN responsavel_id    BIGINT REFERENCES usuarios (id),
  ADD COLUMN data_prevista_resposta DATE,
  ADD COLUMN data_visualizacao TIMESTAMPTZ,
  ADD COLUMN lembretes         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN ultimo_lembrete   TIMESTAMPTZ,
  ADD COLUMN motivo_recusa     TEXT,
  ADD COLUMN itens_respondidos INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN itens_solicitados INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 5. Criterios de comparacao (secoes 14 a 19)
-- ---------------------------------------------------------------------------
CREATE TABLE criterios_cotacao (
  id           BIGSERIAL PRIMARY KEY,
  codigo       TEXT NOT NULL UNIQUE,
  nome         TEXT NOT NULL,
  descricao    TEXT,
  direcao      direcao_criterio_enum NOT NULL,
  peso_padrao  NUMERIC(6, 2) NOT NULL,
  -- Quando nao ha dado, o criterio e ignorado e o peso e redistribuido:
  -- inventar pontuacao seria pior que nao pontuar (secao 17).
  exige_dado   BOOLEAN NOT NULL DEFAULT true,
  ativo        BOOLEAN NOT NULL DEFAULT true,
  ordem        INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_criterio_peso CHECK (peso_padrao >= 0 AND peso_padrao <= 100)
);

-- Pesos por categoria (secao 16). categoria_id nulo = padrao da empresa.
CREATE TABLE criterios_categoria (
  id           BIGSERIAL PRIMARY KEY,
  categoria_id BIGINT REFERENCES categorias (id) ON DELETE CASCADE,
  origem       origem_fornecedor_enum,
  criterio_id  BIGINT NOT NULL REFERENCES criterios_cotacao (id) ON DELETE CASCADE,
  peso         NUMERIC(6, 2) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_criterio_categoria_peso CHECK (peso >= 0 AND peso <= 100),
  CONSTRAINT uq_criterio_categoria UNIQUE (categoria_id, origem, criterio_id)
);

-- Pesos efetivamente usados numa cotacao. Ficam gravados: refazer o calculo
-- meses depois tem que dar o mesmo numero (secao 65).
CREATE TABLE cotacao_criterios (
  id           BIGSERIAL PRIMARY KEY,
  cotacao_id   BIGINT NOT NULL REFERENCES cotacoes (id) ON DELETE CASCADE,
  criterio_id  BIGINT NOT NULL REFERENCES criterios_cotacao (id),
  peso         NUMERIC(6, 2) NOT NULL,
  eliminatorio BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_cotacao_criterio_peso CHECK (peso >= 0 AND peso <= 100),
  CONSTRAINT uq_cotacao_criterio UNIQUE (cotacao_id, criterio_id)
);

-- Pontuacao de cada proposta em cada criterio. E a tabela que permite abrir
-- "como esta proposta foi avaliada?" (secao 19).
CREATE TABLE cotacao_pontuacoes (
  id                 BIGSERIAL PRIMARY KEY,
  cotacao_item_id    BIGINT NOT NULL REFERENCES cotacao_itens (id) ON DELETE CASCADE,
  criterio_id        BIGINT NOT NULL REFERENCES criterios_cotacao (id),
  valor_original     NUMERIC(18, 4),
  valor_texto        TEXT,
  pontuacao          NUMERIC(8, 4),
  peso               NUMERIC(6, 2) NOT NULL,
  pontuacao_ponderada NUMERIC(10, 4),
  dados_insuficientes BOOLEAN NOT NULL DEFAULT false,
  observacao         TEXT,
  calculado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cotacao_pontuacao UNIQUE (cotacao_item_id, criterio_id)
);
CREATE INDEX ix_cotacao_pontuacoes_item ON cotacao_pontuacoes (cotacao_item_id);

-- ---------------------------------------------------------------------------
-- 6. Cenarios de comparacao (secoes 27, 28, 39)
-- ---------------------------------------------------------------------------
CREATE TABLE cotacao_cenarios (
  id              BIGSERIAL PRIMARY KEY,
  cotacao_id      BIGINT NOT NULL REFERENCES cotacoes (id) ON DELETE CASCADE,
  nome            TEXT NOT NULL,
  tipo            tipo_cenario_cotacao_enum NOT NULL,
  parametros      JSONB NOT NULL DEFAULT '{}'::jsonb,
  valor_produtos  NUMERIC(16, 2) NOT NULL DEFAULT 0,
  frete_total     NUMERIC(16, 2) NOT NULL DEFAULT 0,
  custo_total     NUMERIC(16, 2) NOT NULL DEFAULT 0,
  prazo_medio_dias NUMERIC(8, 2),
  prazo_maximo_dias INTEGER,
  pagamento_medio_dias NUMERIC(8, 2),
  score_medio     NUMERIC(8, 4),
  fornecedores    INTEGER NOT NULL DEFAULT 0,
  produtos_atendidos INTEGER NOT NULL DEFAULT 0,
  produtos_nao_atendidos INTEGER NOT NULL DEFAULT 0,
  atendimento_percentual NUMERIC(8, 4),
  economia        NUMERIC(16, 2),
  observacao      TEXT,
  criado_por      BIGINT REFERENCES usuarios (id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_cotacao_cenarios_cotacao ON cotacao_cenarios (cotacao_id);

CREATE TABLE cotacao_cenario_itens (
  id                 BIGSERIAL PRIMARY KEY,
  cenario_id         BIGINT NOT NULL REFERENCES cotacao_cenarios (id) ON DELETE CASCADE,
  cotacao_produto_id BIGINT NOT NULL REFERENCES cotacao_produtos (id) ON DELETE CASCADE,
  cotacao_item_id    BIGINT REFERENCES cotacao_itens (id) ON DELETE CASCADE,
  fornecedor_id      BIGINT REFERENCES fornecedores (id),
  quantidade         NUMERIC(14, 3) NOT NULL,
  preco_unitario     NUMERIC(14, 4),
  custo_total        NUMERIC(16, 2),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_cotacao_cenario_itens ON cotacao_cenario_itens (cenario_id);

-- ---------------------------------------------------------------------------
-- 7. Historico de status da cotacao (secao 65)
-- ---------------------------------------------------------------------------
CREATE TABLE cotacao_historico (
  id              BIGSERIAL PRIMARY KEY,
  cotacao_id      BIGINT NOT NULL REFERENCES cotacoes (id) ON DELETE CASCADE,
  status_anterior status_cotacao_enum,
  status_novo     status_cotacao_enum NOT NULL,
  justificativa   TEXT,
  detalhes        JSONB,
  usuario_id      BIGINT REFERENCES usuarios (id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_cotacao_historico_cotacao ON cotacao_historico (cotacao_id, created_at DESC);

-- O historico de uma cotacao nao se apaga nem se reescreve.
CREATE OR REPLACE FUNCTION fn_cotacao_historico_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Historico de cotacao e permanente e nao aceita alteracao nem exclusao';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cotacao_historico_append_only
  BEFORE UPDATE OR DELETE ON cotacao_historico
  FOR EACH ROW EXECUTE FUNCTION fn_cotacao_historico_append_only();

-- ---------------------------------------------------------------------------
-- 8. Catalogo de criterios (secao 15)
-- ---------------------------------------------------------------------------
INSERT INTO criterios_cotacao (codigo, nome, descricao, direcao, peso_padrao, exige_dado, ordem) VALUES
  ('CUSTO_TOTAL', 'Custo total de aquisicao',
   'Produto + frete + impostos + seguro + taxas - descontos, por unidade', 'MENOR_MELHOR', 35, true, 1),
  ('PRAZO_ENTREGA', 'Prazo de entrega',
   'Lead time ofertado, penalizado quando ultrapassa a data necessaria', 'MENOR_MELHOR', 20, true, 2),
  ('QUALIDADE', 'Qualidade do fornecedor',
   'Indice de qualidade da ultima avaliacao do fornecedor', 'MAIOR_MELHOR', 15, true, 3),
  ('OTIF', 'OTIF historico',
   'Entrega no prazo e completa, da ultima avaliacao do fornecedor', 'MAIOR_MELHOR', 10, true, 4),
  ('PAGAMENTO', 'Condicao de pagamento',
   'Prazo de pagamento ofertado', 'MAIOR_MELHOR', 10, true, 5),
  ('FRETE', 'Frete',
   'Participacao do frete no custo total', 'MENOR_MELHOR', 5, true, 6),
  ('MOQ_MULTIPLO', 'MOQ e multiplo',
   'Excesso gerado pelo minimo e pelo arredondamento do fornecedor', 'MENOR_MELHOR', 5, true, 7)
ON CONFLICT (codigo) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 9. Parametros do modulo
-- ---------------------------------------------------------------------------
INSERT INTO configuracoes (chave, valor, tipo, grupo, descricao) VALUES
  ('cotacao.dias_resposta_padrao', '5', 'NUMERO', 'cotacao',
   'Dias ate a data limite de resposta quando nao informada'),
  ('cotacao.minimo_fornecedores', '3', 'NUMERO', 'cotacao',
   'Fornecedores convidados abaixo dos quais a cotacao recebe alerta de fornecedor unico'),
  ('cotacao.limite_variacao_preco', '10', 'NUMERO', 'cotacao',
   'Variacao percentual contra o historico que dispara alerta de preco'),
  ('cotacao.limite_dispersao_propostas', '20', 'NUMERO', 'cotacao',
   'Diferenca percentual entre a melhor e a pior proposta que marca o item como divergente'),
  ('cotacao.dias_alerta_validade_proposta', '3', 'NUMERO', 'cotacao',
   'Dias restantes a partir dos quais a proposta e marcada como expirando'),
  ('cotacao.atendimento_minimo_percentual', '100', 'NUMERO', 'cotacao',
   'Percentual da quantidade abaixo do qual a proposta e considerada parcial'),
  ('cotacao.lead_time_risco_dias', '60', 'NUMERO', 'cotacao',
   'Lead time a partir do qual a proposta entra na analise de risco'),
  ('cotacao.permitir_score_sem_historico', 'true', 'BOOLEANO', 'cotacao',
   'Redistribuir o peso dos criterios sem dado em vez de zerar a pontuacao')
ON CONFLICT (chave) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 10. Permissoes (secao 50)
-- ---------------------------------------------------------------------------
INSERT INTO permissoes (codigo, modulo, descricao) VALUES
  ('cotacoes.responder',  'cotacoes', 'Registrar propostas recebidas dos fornecedores'),
  ('cotacoes.analisar',   'cotacoes', 'Calcular comparativo, score e cenarios'),
  ('cotacoes.aprovar',    'cotacoes', 'Aprovar cotacao e encaminhar para negociacao'),
  ('cotacoes.criterios',  'cotacoes', 'Alterar criterios e pesos de comparacao')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo IN
  ('cotacoes.responder', 'cotacoes.analisar', 'cotacoes.aprovar', 'cotacoes.criterios')
WHERE pf.nome IN ('ADMIN', 'GESTOR_COMPRAS')
ON CONFLICT DO NOTHING;

-- COMPRADOR cria, responde, compara e simula - mas nao aprova nem mexe nos pesos.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo IN ('cotacoes.responder', 'cotacoes.analisar')
WHERE pf.nome = 'COMPRADOR'
ON CONFLICT DO NOTHING;

-- DIRETORIA aprova conforme alcada.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo = 'cotacoes.aprovar'
WHERE pf.nome = 'DIRETORIA'
ON CONFLICT DO NOTHING;

-- Leitura para quem consulta: QUALIDADE, FINANCEIRO e ESTOQUE.
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, pm.id FROM perfis pf
JOIN permissoes pm ON pm.codigo = 'cotacoes.ler'
WHERE pf.nome IN ('QUALIDADE', 'FINANCEIRO', 'ESTOQUE', 'DIRETORIA')
ON CONFLICT DO NOTHING;
