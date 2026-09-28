-- =========================================================================
-- MODULO 11 - CLASSIFICACAO DA CENTRAL DE ALERTAS (secoes 40 e 41)
--
-- A secao 40 pede UMA central de alertas, com categoria e prioridade em
-- todo alerta. A tabela `alertas` ja existe desde o modulo 02 e e alimentada
-- pelos modulos 02 a 10, que nao conhecem esses campos.
--
-- Em vez de editar dez modulos - e de aceitar que qualquer modulo futuro
-- esqueca de preencher -, a classificacao vira dado: uma tabela que diz, por
-- tipo de alerta, a que categoria e prioridade ele pertence, e uma trigger
-- que preenche o que veio nulo. Quem insere continua informando apenas o
-- tipo; a central recebe o alerta ja classificado.
--
-- A trigger so preenche NULO. Um alerta que chega com prioridade explicita
-- (os do modulo 11 chegam) mantem a sua - o padrao nao sobrepoe a decisao de
-- quem gerou o alerta.
-- =========================================================================

CREATE TABLE alertas_tipos (
  tipo          tipo_alerta_enum       PRIMARY KEY,
  categoria     text                   NOT NULL,
  prioridade    prioridade_alerta_enum NOT NULL,
  titulo_padrao text                   NOT NULL,
  origem_padrao text                   NOT NULL,
  CONSTRAINT ck_alertas_tipos_categoria CHECK (categoria IN (
    'ruptura', 'estoque', 'compra', 'fornecedor', 'atraso', 'qualidade',
    'recebimento', 'preco', 'demanda', 'importacao', 'governanca'))
);

COMMENT ON TABLE alertas_tipos IS
  'Classificacao oficial de cada tipo de alerta em categoria e prioridade (secoes 40 e 41).';

INSERT INTO alertas_tipos (tipo, categoria, prioridade, titulo_padrao, origem_padrao) VALUES
  ('RUPTURA',                   'ruptura',     'CRITICO', 'Produto em ruptura',                'Modulo 03 - Estoque'),
  ('RISCO_RUPTURA',             'ruptura',     'ALTO',    'Risco de ruptura',                  'Modulo 05 - Planejamento'),
  ('EXCESSO',                   'estoque',     'MEDIO',   'Excesso de estoque',                'Modulo 03 - Estoque'),
  ('ESTOQUE_EXCESSIVO',         'estoque',     'MEDIO',   'Estoque acima do maximo',           'Modulo 11 - BI'),
  ('ESTOQUE_PARADO',            'estoque',     'MEDIO',   'Estoque sem movimentacao',          'Modulo 03 - Estoque'),
  ('COBERTURA_BAIXA',           'estoque',     'ALTO',    'Cobertura abaixo do minimo',        'Modulo 11 - BI'),
  ('GIRO_BAIXO',                'estoque',     'MEDIO',   'Giro de estoque baixo',             'Modulo 11 - BI'),
  ('PRODUTO_CRITICO',           'estoque',     'ALTO',    'Produto critico',                   'Modulo 11 - BI'),
  ('VALIDADE_PROXIMA',          'estoque',     'ALTO',    'Lote proximo do vencimento',        'Modulo 03 - Estoque'),
  ('PEDIDO_ATRASADO',           'atraso',      'ALTO',    'Pedido de compra atrasado',         'Modulo 08 - Acompanhamento'),
  ('ENTREGA_ATRASADA',          'atraso',      'ALTO',    'Entrega atrasada',                  'Modulo 08 - Acompanhamento'),
  ('ENTREGA_EM_RISCO',          'atraso',      'MEDIO',   'Entrega em risco de atraso',        'Modulo 08 - Acompanhamento'),
  ('ALTERACAO_PRAZO',           'atraso',      'MEDIO',   'Prazo de entrega alterado',         'Modulo 08 - Acompanhamento'),
  ('PEDIDO_SEM_CONFIRMACAO',    'compra',      'MEDIO',   'Pedido sem confirmacao do fornecedor', 'Modulo 08 - Acompanhamento'),
  ('APROVACAO_PENDENTE',        'compra',      'MEDIO',   'Aprovacao pendente',                'Modulo 07 - Pedido'),
  ('PRECO_AUMENTOU',            'preco',       'MEDIO',   'Aumento de preco',                  'Modulo 06 - Cotacoes'),
  ('QUALIDADE_REPROVADA',       'qualidade',   'ALTO',    'Inspecao reprovada',                'Modulo 09 - Qualidade'),
  ('PRODUTO_VENCIDO',           'qualidade',   'CRITICO', 'Produto vencido em estoque',        'Modulo 09 - Qualidade'),
  ('QUARENTENA_ABERTA',         'qualidade',   'ALTO',    'Quarentena em aberto',              'Modulo 09 - Qualidade'),
  ('NC_CRITICA',                'qualidade',   'CRITICO', 'Nao conformidade critica',          'Modulo 09 - Qualidade'),
  ('RECEBIMENTO_DIVERGENTE',    'recebimento', 'ALTO',    'Divergencia no recebimento',        'Modulo 09 - Recebimento'),
  ('VALIDADE_INSUFICIENTE',     'recebimento', 'ALTO',    'Validade insuficiente no recebimento', 'Modulo 09 - Recebimento'),
  ('LOTE_NAO_INFORMADO',        'recebimento', 'MEDIO',   'Lote nao informado',                'Modulo 09 - Recebimento'),
  ('DEVOLUCAO_PENDENTE',        'recebimento', 'MEDIO',   'Devolucao pendente',                'Modulo 09 - Recebimento'),
  ('FORNECEDOR_BAIXO_DESEMPENHO','fornecedor', 'ALTO',    'Fornecedor com baixo desempenho',   'Modulo 10 - Avaliacao'),
  ('FORNECEDOR_MONITORADO',     'fornecedor',  'MEDIO',   'Fornecedor em monitoramento',       'Modulo 10 - Avaliacao'),
  ('FORNECEDOR_BLOQUEADO',      'fornecedor',  'ALTO',    'Fornecedor bloqueado',              'Modulo 10 - Avaliacao'),
  ('FORNECEDOR_UNICO',          'fornecedor',  'BAIXO',   'Produto com fornecedor unico',      'Modulo 10 - Avaliacao'),
  ('CONCENTRACAO_FORNECIMENTO', 'fornecedor',  'MEDIO',   'Concentracao de fornecimento',      'Modulo 10 - Avaliacao'),
  ('AVALIACAO_VENCIDA',         'fornecedor',  'MEDIO',   'Avaliacao de fornecedor vencida',   'Modulo 10 - Avaliacao'),
  ('PLANO_ACAO_ATRASADO',       'fornecedor',  'ALTO',    'Plano de acao atrasado',            'Modulo 10 - Avaliacao'),
  ('TENDENCIA_NEGATIVA',        'fornecedor',  'MEDIO',   'Tendencia negativa de performance', 'Modulo 10 - Avaliacao'),
  ('MELHORIA_PERFORMANCE',      'fornecedor',  'BAIXO',   'Melhoria de performance',           'Modulo 10 - Avaliacao'),
  ('SLA_OCORRENCIA',            'fornecedor',  'MEDIO',   'Ocorrencia de SLA',                 'Modulo 08 - Acompanhamento'),
  ('ETA_ALTERADA',              'importacao',  'MEDIO',   'ETA de importacao alterada',        'Modulo 08 - Importacao'),
  ('IMPORTACAO_ATRASADA',       'importacao',  'ALTO',    'Importacao atrasada',               'Modulo 11 - BI'),
  ('KPI_FORA_DA_META',          'governanca',  'ALTO',    'Indicador fora da meta',            'Modulo 11 - BI'),
  ('KPI_SEM_DADOS',             'governanca',  'MEDIO',   'Indicador sem dados',               'Modulo 11 - BI'),
  ('QUALIDADE_DADOS',           'governanca',  'MEDIO',   'Qualidade do cadastro',             'Modulo 11 - BI'),
  ('DADOS_INSUFICIENTES',       'governanca',  'BAIXO',   'Dados insuficientes para avaliar',  'Modulo 10 - Avaliacao');

-- -------------------------------------------------------------------------
-- Preenchimento automatico. So toca o que veio nulo.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_alerta_classificar() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  padrao alertas_tipos%ROWTYPE;
BEGIN
  SELECT * INTO padrao FROM alertas_tipos WHERE tipo = NEW.tipo;

  IF FOUND THEN
    NEW.categoria  := coalesce(NEW.categoria,  padrao.categoria);
    NEW.prioridade := coalesce(NEW.prioridade, padrao.prioridade);
    NEW.titulo     := coalesce(NEW.titulo,     padrao.titulo_padrao);
    NEW.origem     := coalesce(NEW.origem,     padrao.origem_padrao);
  END IF;

  -- Toda linha da central precisa de uma janela de ocorrencia, mesmo sem
  -- chave de deduplicacao: e o que a tela ordena.
  NEW.primeira_ocorrencia := coalesce(NEW.primeira_ocorrencia, NEW.data_geracao, now());
  NEW.ultima_ocorrencia   := coalesce(NEW.ultima_ocorrencia,   NEW.data_geracao, now());

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_alertas_classificar
  BEFORE INSERT ON alertas
  FOR EACH ROW EXECUTE FUNCTION fn_alerta_classificar();

-- -------------------------------------------------------------------------
-- Alertas ja existentes (modulos 02 a 10) entram na central classificados.
-- -------------------------------------------------------------------------
UPDATE alertas a
   SET categoria  = coalesce(a.categoria,  t.categoria),
       prioridade = coalesce(a.prioridade, t.prioridade),
       titulo     = coalesce(a.titulo,     t.titulo_padrao),
       origem     = coalesce(a.origem,     t.origem_padrao),
       primeira_ocorrencia = coalesce(a.primeira_ocorrencia, a.data_geracao),
       ultima_ocorrencia   = coalesce(a.ultima_ocorrencia,   a.data_geracao)
  FROM alertas_tipos t
 WHERE t.tipo = a.tipo
   AND (a.categoria IS NULL OR a.prioridade IS NULL OR a.titulo IS NULL
        OR a.origem IS NULL OR a.ultima_ocorrencia IS NULL);
