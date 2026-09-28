-- ---------------------------------------------------------------------------
-- 033 - Metodologia 1.0: os sete criterios da secao 10
--
-- Os pesos vinham de cinco chaves soltas em `configuracoes`
-- (fornecedor.peso_otif, peso_qualidade, peso_preco, peso_atendimento,
-- peso_flexibilidade). Elas nunca foram lidas por codigo algum e nao davam
-- conta do que a secao 10 pede: sete grupos, pesos por escopo e versionamento.
--
-- Duas chaves soltas com o mesmo proposito seriam pior do que uma so: o
-- usuario mudaria uma e a outra continuaria valendo. Entao os pesos passam a
-- viver na metodologia, e as chaves antigas somem no fim deste arquivo.
--
-- Cada criterio recebe seus indicadores com faixa de normalizacao. A nota vai
-- de 0 a 100 por interpolacao entre `valor_pior` e `valor_melhor`: e o unico
-- ponto onde um numero cru (dias de atraso, percentual de NC) vira nota, e
-- fica explicito na metodologia em vez de escondido no codigo.
-- ---------------------------------------------------------------------------

WITH m AS (
  INSERT INTO metodologias_avaliacao
    (versao, nome, descricao, escopo, frequencia, publicada_em, vigente)
  VALUES ('1.0', 'Metodologia padrao de avaliacao de fornecedores',
          'Sete criterios da secao 10 do modulo 10, pesos somando 100%.',
          'EMPRESA', 'TRIMESTRAL', now(), TRUE)
  ON CONFLICT (versao) DO NOTHING
  RETURNING id
), c AS (
  INSERT INTO metodologia_criterios
    (metodologia_id, grupo, nome, descricao, peso_percentual, minimo_eventos, ordem)
  SELECT m.id, g.grupo::grupo_criterio_enum, g.nome, g.descricao, g.peso, g.minimo, g.ordem
    FROM m, (VALUES
      ('LOGISTICA', 'Logistica',
       'Pontualidade, integralidade e lead time. Fonte: modulo 08.', 25.00, 3, 1),
      ('QUALIDADE', 'Qualidade',
       'Aprovacao, nao conformidade e devolucao. Fonte: modulo 09.', 25.00, 3, 2),
      ('COMERCIAL', 'Comercial',
       'Cumprimento do preco e das condicoes acordadas. Fonte: modulos 06 e 07.', 20.00, 2, 3),
      ('ATENDIMENTO', 'Atendimento',
       'Resposta a cotacao, confirmacao de pedido e resolucao de ocorrencia.', 10.00, 2, 4),
      ('PRECO', 'Preco e competitividade',
       'Variacao do preprio preco e posicao diante dos demais fornecedores.', 10.00, 2, 5),
      ('PAGAMENTO', 'Condicoes de pagamento',
       'Prazo negociado contra prazo praticado.', 5.00, 2, 6),
      ('FLEXIBILIDADE', 'Flexibilidade',
       'Aceitacao de alteracao, antecipacao e parcelamento.', 5.00, 2, 7)
    ) AS g(grupo, nome, descricao, peso, minimo, ordem)
  RETURNING id, grupo
)
INSERT INTO metodologia_indicadores
  (metodologia_criterio_id, codigo, nome, peso_percentual, direcao,
   valor_pior, valor_melhor, unidade, minimo_eventos, ordem)
SELECT c.id, i.codigo, i.nome, i.peso, i.direcao::direcao_criterio_enum,
       i.pior, i.melhor, i.unidade, i.minimo, i.ordem
  FROM c JOIN (VALUES
    -- LOGISTICA (secao 12)
    ('LOGISTICA', 'OTIF', 'OTIF - no prazo e integral',
     40.00, 'MAIOR_MELHOR', 60.0, 100.0, '%', 3, 1),
    ('LOGISTICA', 'OTD', 'OTD - entregas no prazo',
     20.00, 'MAIOR_MELHOR', 60.0, 100.0, '%', 3, 2),
    ('LOGISTICA', 'IN_FULL', 'In Full - entregas integrais',
     20.00, 'MAIOR_MELHOR', 60.0, 100.0, '%', 3, 3),
    ('LOGISTICA', 'ATRASO_MEDIO', 'Atraso medio em dias',
     10.00, 'MENOR_MELHOR', 15.0, 0.0, 'dias', 3, 4),
    ('LOGISTICA', 'DESVIO_LEAD_TIME', 'Desvio do lead time contra o prometido',
     10.00, 'MENOR_MELHOR', 15.0, 0.0, 'dias', 3, 5),

    -- QUALIDADE (secoes 17, 18 e 19)
    ('QUALIDADE', 'TAXA_APROVACAO', 'Recebimentos aprovados',
     35.00, 'MAIOR_MELHOR', 70.0, 100.0, '%', 3, 1),
    ('QUALIDADE', 'TAXA_NC', 'Recebimentos com nao conformidade',
     25.00, 'MENOR_MELHOR', 25.0, 0.0, '%', 3, 2),
    ('QUALIDADE', 'TAXA_QUANTIDADE_NAO_CONFORME', 'Quantidade nao conforme sobre a recebida',
     15.00, 'MENOR_MELHOR', 15.0, 0.0, '%', 3, 3),
    ('QUALIDADE', 'INDICE_GRAVIDADE_NC', 'Indice de gravidade das nao conformidades',
     15.00, 'MENOR_MELHOR', 20.0, 0.0, 'pontos', 1, 4),
    ('QUALIDADE', 'TAXA_DEVOLUCAO', 'Recebimentos com devolucao',
     10.00, 'MENOR_MELHOR', 15.0, 0.0, '%', 3, 5),

    -- COMERCIAL (secao 20)
    ('COMERCIAL', 'CUMPRIMENTO_PRECO', 'Itens recebidos ao preco acordado',
     45.00, 'MAIOR_MELHOR', 80.0, 100.0, '%', 2, 1),
    ('COMERCIAL', 'CUMPRIMENTO_QUANTIDADE', 'Quantidade recebida sobre a pedida',
     30.00, 'MAIOR_MELHOR', 80.0, 100.0, '%', 2, 2),
    ('COMERCIAL', 'ESTABILIDADE_COMERCIAL', 'Pedidos sem alteracao comercial',
     25.00, 'MAIOR_MELHOR', 70.0, 100.0, '%', 2, 3),

    -- ATENDIMENTO (secao 24)
    ('ATENDIMENTO', 'TAXA_RESPOSTA_COTACAO', 'Cotacoes respondidas',
     40.00, 'MAIOR_MELHOR', 40.0, 100.0, '%', 2, 1),
    ('ATENDIMENTO', 'TAXA_CONFIRMACAO_PEDIDO', 'Pedidos confirmados pelo fornecedor',
     35.00, 'MAIOR_MELHOR', 50.0, 100.0, '%', 2, 2),
    ('ATENDIMENTO', 'RESOLUCAO_OCORRENCIAS', 'Ocorrencias logisticas resolvidas',
     25.00, 'MAIOR_MELHOR', 50.0, 100.0, '%', 1, 3),

    -- PRECO (secoes 21 e 22)
    ('PRECO', 'VARIACAO_PRECO', 'Variacao do preco no periodo',
     50.00, 'MENOR_MELHOR', 20.0, -5.0, '%', 2, 1),
    ('PRECO', 'POSICAO_COMPETITIVA', 'Preco diante do menor preco elegivel do produto',
     50.00, 'MENOR_MELHOR', 25.0, 0.0, '%', 2, 2),

    -- PAGAMENTO (secao 23)
    ('PAGAMENTO', 'PRAZO_MEDIO_PAGAMENTO', 'Prazo medio praticado',
     60.00, 'MAIOR_MELHOR', 0.0, 60.0, 'dias', 2, 1),
    ('PAGAMENTO', 'ADERENCIA_PRAZO', 'Prazo praticado contra o negociado',
     40.00, 'MAIOR_MELHOR', 70.0, 100.0, '%', 2, 2),

    -- FLEXIBILIDADE (secao 25)
    ('FLEXIBILIDADE', 'ACEITE_ALTERACOES', 'Alteracoes de pedido aceitas',
     50.00, 'MAIOR_MELHOR', 30.0, 100.0, '%', 2, 1),
    ('FLEXIBILIDADE', 'PARCELAMENTO_ENTREGA', 'Pedidos atendidos com entrega programada',
     50.00, 'MAIOR_MELHOR', 0.0, 60.0, '%', 2, 2)
  ) AS i(grupo, codigo, nome, peso, direcao, pior, melhor, unidade, minimo, ordem)
  ON i.grupo = c.grupo::text;

-- ---------------------------------------------------------------------------
-- Trava da regra 4 da secao 67: os pesos de uma metodologia publicada tem de
-- somar 100. Fica no banco, e nao so no service, porque carga e correcao
-- manual passariam por fora do service.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_validar_pesos_metodologia() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_metodologia BIGINT := COALESCE(NEW.metodologia_id, OLD.metodologia_id);
  v_publicada   BOOLEAN;
  v_soma        NUMERIC;
BEGIN
  SELECT publicada_em IS NOT NULL INTO v_publicada
    FROM metodologias_avaliacao WHERE id = v_metodologia;

  -- Enquanto a metodologia e rascunho, os pesos podem estar em qualquer
  -- estado: quem esta montando precisa poder digitar um criterio por vez.
  IF NOT COALESCE(v_publicada, FALSE) THEN RETURN NULL; END IF;

  SELECT COALESCE(sum(peso_percentual), 0) INTO v_soma
    FROM metodologia_criterios WHERE metodologia_id = v_metodologia;

  IF round(v_soma, 2) <> 100.00 THEN
    RAISE EXCEPTION 'Os pesos dos criterios somam %, e precisam somar 100.', round(v_soma, 2)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS trg_metodologia_pesos ON metodologia_criterios;
CREATE CONSTRAINT TRIGGER trg_metodologia_pesos
  AFTER INSERT OR UPDATE OR DELETE ON metodologia_criterios
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_validar_pesos_metodologia();

-- ---------------------------------------------------------------------------
-- As cinco chaves antigas saem: os pesos agora sao da metodologia.
-- ---------------------------------------------------------------------------

DELETE FROM configuracoes WHERE chave IN (
  'fornecedor.peso_otif', 'fornecedor.peso_qualidade', 'fornecedor.peso_preco',
  'fornecedor.peso_atendimento', 'fornecedor.peso_flexibilidade'
);
