-- ---------------------------------------------------------------------------
-- 036 - dicionario oficial de indicadores (secoes 13 a 38 e 66)
--
-- Cada linha aqui e a UNICA definicao daquele KPI no sistema. O dashboard
-- executivo, o de fornecedores e o de logistica pedem 'OTIF' ao catalogo e
-- recebem o mesmo numero, pela mesma formula (secao 67).
--
-- A coluna `fonte` diz de onde o numero vem. Onde ela aponta para um modulo
-- anterior, o resolvedor CHAMA aquele modulo em vez de refazer a conta: OTIF,
-- OTD e In Full sao do modulo 08; taxa de aprovacao e NC sao do modulo 09;
-- saving e do 06/07; MAPE e do 04. Refazer daria dois numeros diferentes para
-- a mesma pergunta.
--
-- `drilldown` diz para onde o clique leva (secao 43).
-- ---------------------------------------------------------------------------

INSERT INTO kpi_definicoes
  (codigo, nome, descricao, objetivo, modulo, categoria, formula, fonte, tabelas,
   unidade, periodicidade, direcao, casas_decimais, minimo_eventos, drilldown,
   interpretacao)
VALUES
-- =========================== COMPRAS (secao 13) ============================
('VALOR_COMPRADO', 'Valor comprado',
 'Soma do valor dos pedidos emitidos no periodo, exceto rascunho, cancelado e rejeitado.',
 'Acompanhar o volume financeiro de compras.',
 'COMPRAS', 'Volume',
 'soma de ordens_compra.valor_total dos pedidos emitidos no periodo',
 'Modulo 07 - pedidos de compra', 'ordens_compra',
 'MOEDA', 'MENSAL', 'MAIOR_MELHOR', 2, 1, 'compras',
 'Sozinho nao diz se a compra foi boa: leia junto com preco medio e saving.'),

('QUANTIDADE_COMPRADA', 'Quantidade comprada',
 'Soma das quantidades pedidas no periodo.',
 'Dimensionar o volume fisico comprado.',
 'COMPRAS', 'Volume',
 'soma de ordem_compra_itens.quantidade_pedida dos pedidos do periodo',
 'Modulo 07 - itens de pedido', 'ordem_compra_itens',
 'QUANTIDADE', 'MENSAL', 'MAIOR_MELHOR', 3, 1, 'compras', NULL),

('PRECO_MEDIO', 'Preco medio de compra',
 'Valor comprado dividido pela quantidade comprada no periodo.',
 'Acompanhar a evolucao do custo unitario medio.',
 'COMPRAS', 'Preco',
 'valor comprado / quantidade comprada',
 'Modulo 07 - itens de pedido', 'ordem_compra_itens',
 'MOEDA', 'MENSAL', 'MENOR_MELHOR', 4, 1, 'compras',
 'Mistura produtos diferentes: compare dentro da mesma categoria.'),

('VARIACAO_PRECO', 'Variacao de preco',
 'Variacao percentual media do preco, ponderada pela quantidade comprada.',
 'Detectar reajuste de fornecedor.',
 'COMPRAS', 'Preco',
 '(preco atual - preco anterior) / preco anterior x 100, ponderado pela quantidade',
 'Modulo 02 e 07 - historico de precos', 'historico_precos, vw_historico_precos',
 'PERCENTUAL', 'MENSAL', 'MENOR_MELHOR', 2, 2, 'precos',
 'Preco anterior zero nao entra na conta: percentual nao e calculavel.'),

('SAVING', 'Saving negociado',
 'Economia reconhecida nas negociacoes, pela metodologia dos modulos 06 e 07.',
 'Medir o resultado da negociacao.',
 'COMPRAS', 'Resultado',
 'soma de ordens_compra.economia_negociada dos pedidos do periodo',
 'Modulos 06 e 07 - negociacao (metodologia nao recalculada aqui)',
 'ordens_compra, negociacoes',
 'MOEDA', 'MENSAL', 'MAIOR_MELHOR', 2, 1, 'negociacoes',
 'Pedido sem negociacao fica fora do denominador, como no modulo 07.'),

('COMPRAS_EM_ABERTO', 'Compras em aberto',
 'Valor dos pedidos emitidos que ainda tem saldo pendente de recebimento.',
 'Dimensionar o compromisso ja assumido e nao entregue.',
 'COMPRAS', 'Volume',
 'soma de (quantidade pendente x preco unitario) dos itens com saldo',
 'Modulo 07 e 08 - saldo de pedido', 'vw_compras_abertas',
 'MOEDA', 'SOB_DEMANDA', 'MENOR_MELHOR', 2, 1, 'compras-abertas', NULL),

('PEDIDOS_ATRASADOS', 'Pedidos atrasados',
 'Pedidos com item cuja data prometida ja passou e ainda tem saldo pendente.',
 'Priorizar cobranca de fornecedor.',
 'COMPRAS', 'Prazo',
 'contagem distinta de pedidos com item vencido e saldo pendente',
 'Modulo 08 - acompanhamento de entregas', 'ordem_compra_itens, entregas',
 'CONTAGEM', 'DIARIA', 'MENOR_MELHOR', 0, 1, 'pedidos-atrasados', NULL),

('PRAZO_MEDIO_PAGAMENTO', 'Prazo medio de pagamento',
 'Media dos dias da condicao de pagamento dos pedidos do periodo.',
 'Acompanhar o capital de giro negociado.',
 'FINANCEIRO', 'Pagamento',
 'media simples dos dias da condicao de pagamento dos pedidos',
 'Modulo 07 - condicao de pagamento do pedido', 'ordens_compra, condicoes_pagamento',
 'DIAS', 'MENSAL', 'MAIOR_MELHOR', 1, 2, 'compras', NULL),

-- ========================== PLANEJAMENTO (secao 14) ========================
('NECESSIDADE_TOTAL', 'Necessidade de compra',
 'Valor total das necessidades de compra em aberto.',
 'Dimensionar o que ainda precisa ser comprado.',
 'COMPRAS', 'Planejamento',
 'soma do valor estimado das necessidades nao atendidas',
 'Modulo 05 - planejamento de compras', 'necessidades_compra',
 'MOEDA', 'SOB_DEMANDA', 'MENOR_MELHOR', 2, 1, 'necessidades', NULL),

('NECESSIDADE_URGENTE', 'Necessidades urgentes',
 'Necessidades de compra classificadas como urgente ou critica.',
 'Separar o que nao pode esperar o proximo ciclo.',
 'COMPRAS', 'Planejamento',
 'contagem de necessidades com prioridade URGENTE ou CRITICA em aberto',
 'Modulo 05 - planejamento de compras', 'necessidades_compra',
 'CONTAGEM', 'DIARIA', 'MENOR_MELHOR', 0, 1, 'necessidades', NULL),

-- ============================ ESTOQUE (secoes 15 a 21) =====================
('VALOR_ESTOQUE', 'Valor do estoque',
 'Estoque fisico valorizado pelo metodo configurado em bi.valor_estoque_metodo.',
 'Dimensionar o capital parado em estoque.',
 'ESTOQUE', 'Valor',
 'soma de (quantidade fisica x custo de referencia do produto)',
 'Modulo 03 - posicao de estoque', 'estoques, produtos',
 'MOEDA', 'DIARIA', 'MENOR_MELHOR', 2, 1, 'estoque',
 'Nao e metodologia contabil nova: usa o custo que o modulo 03 ja mantem.'),

('ESTOQUE_DISPONIVEL', 'Estoque disponivel',
 'Quantidade livre para uso: fisico menos reservado, quarentena, bloqueado e em recebimento.',
 'Saber o que realmente pode ser vendido ou consumido.',
 'ESTOQUE', 'Posicao',
 'soma de estoques.quantidade_disponivel (coluna gerada no modulo 09)',
 'Modulos 03 e 09 - posicao de estoque', 'estoques',
 'QUANTIDADE', 'DIARIA', 'MAIOR_MELHOR', 3, 1, 'estoque', NULL),

('ESTOQUE_QUARENTENA', 'Estoque em quarentena',
 'Quantidade retida pela qualidade, que existe no deposito mas nao esta disponivel.',
 'Enxergar material preso na qualidade.',
 'ESTOQUE', 'Posicao',
 'soma de estoques.quantidade_quarentena',
 'Modulo 09 - recebimento e qualidade', 'estoques, quarentenas',
 'QUANTIDADE', 'DIARIA', 'MENOR_MELHOR', 3, 1, 'quarentenas', NULL),

('COBERTURA_MEDIA', 'Cobertura media',
 'Dias que o estoque disponivel cobre, pela demanda media diaria.',
 'Antecipar ruptura e excesso.',
 'ESTOQUE', 'Cobertura',
 'estoque disponivel / demanda media diaria (media dos produtos com demanda)',
 'Modulos 03 e 04 - estoque e demanda', 'vw_estoque_atual, mv_demanda_diaria',
 'DIAS', 'DIARIA', 'MAIOR_MELHOR', 1, 1, 'cobertura',
 'Produto sem demanda apurada fica FORA da media: cobertura infinita nao e cobertura boa.'),

('GIRO_ESTOQUE', 'Giro de estoque',
 'Quantas vezes o estoque se renova no ano, pelas saidas do periodo.',
 'Medir a velocidade do estoque.',
 'ESTOQUE', 'Giro',
 'saidas valorizadas no periodo / estoque medio valorizado, anualizado (x 365 / dias)',
 'Modulo 03 - movimentacoes de estoque', 'movimentacoes_estoque, estoques',
 'INDICE', 'MENSAL', 'MAIOR_MELHOR', 2, 1, 'giro',
 'Estoque medio zero torna o giro nao calculavel, nao infinito.'),

('PRODUTOS_RUPTURA', 'Produtos em ruptura',
 'Produtos com demanda apurada e estoque disponivel zerado.',
 'Priorizar reposicao.',
 'ESTOQUE', 'Ruptura',
 'contagem de produtos com demanda media diaria maior que zero e disponivel igual a zero',
 'Modulos 03 e 04 - estoque e demanda', 'vw_estoque_atual',
 'CONTAGEM', 'DIARIA', 'MENOR_MELHOR', 0, 1, 'ruptura',
 'Produto sem demanda e sem estoque nao e ruptura: e item que ninguem pede.'),

('VALOR_RUPTURA', 'Valor estimado da ruptura',
 'Demanda diaria nao atendida, valorizada, dos produtos em ruptura.',
 'Dimensionar o custo de nao ter o produto.',
 'ESTOQUE', 'Ruptura',
 'soma de (demanda media diaria x custo de referencia) dos produtos em ruptura',
 'Modulos 03 e 04 - estoque e demanda', 'vw_estoque_atual, produtos',
 'MOEDA', 'DIARIA', 'MENOR_MELHOR', 2, 1, 'ruptura',
 'E estimativa de venda deixada de atender por dia, nao prejuizo contabil.'),

('PRODUTOS_EXCESSO', 'Produtos em excesso',
 'Produtos com cobertura acima do limite configurado ou acima do estoque maximo.',
 'Liberar capital parado.',
 'ESTOQUE', 'Excesso',
 'contagem de produtos com cobertura acima de bi.excesso_cobertura_dias',
 'Modulos 03 e 04 - estoque e demanda', 'vw_estoque_atual, produtos',
 'CONTAGEM', 'SEMANAL', 'MENOR_MELHOR', 0, 1, 'excesso', NULL),

('VALOR_EXCESSO', 'Valor em excesso',
 'Valor da quantidade que passa da cobertura maxima configurada.',
 'Dimensionar o capital imobilizado sem necessidade.',
 'ESTOQUE', 'Excesso',
 'soma de ((disponivel - demanda diaria x cobertura maxima) x custo) quando positivo',
 'Modulos 03 e 04 - estoque e demanda', 'vw_estoque_atual, produtos',
 'MOEDA', 'SEMANAL', 'MENOR_MELHOR', 2, 1, 'excesso', NULL),

('ESTOQUE_PARADO', 'Produtos parados',
 'Produtos com saldo e sem movimentacao no periodo configurado.',
 'Encontrar estoque esquecido.',
 'ESTOQUE', 'Giro',
 'contagem de produtos com saldo e sem movimentacao ha mais de bi.estoque_parado_dias',
 'Modulo 03 - movimentacoes de estoque', 'estoques, movimentacoes_estoque',
 'CONTAGEM', 'MENSAL', 'MENOR_MELHOR', 0, 1, 'estoque-parado', NULL),

('ESTOQUE_CRITICO', 'Produtos com estoque critico',
 'Produtos abaixo do ponto de pedido ou do estoque minimo.',
 'Disparar reposicao antes da ruptura.',
 'ESTOQUE', 'Ruptura',
 'contagem de produtos com disponivel abaixo do ponto de pedido',
 'Modulo 03 - posicao de estoque', 'vw_produtos_criticos',
 'CONTAGEM', 'DIARIA', 'MENOR_MELHOR', 0, 1, 'criticos', NULL),

-- ============================ DEMANDA (secoes 22 a 25) =====================
('DEMANDA_MEDIA_DIARIA', 'Demanda media diaria',
 'Media diaria de saida no periodo, pela apuracao do modulo 04.',
 'Base de cobertura, ruptura e necessidade.',
 'DEMANDA', 'Demanda',
 'media da demanda diaria apurada no modulo 04',
 'Modulo 04 - analise de demanda', 'mv_demanda_diaria',
 'QUANTIDADE', 'DIARIA', 'MAIOR_MELHOR', 3, 1, 'demanda', NULL),

('ACURACIDADE_PREVISAO', 'Acuracidade da previsao',
 'Acerto medio da previsao contra o realizado, pela metrica configurada no modulo 04.',
 'Saber o quanto a previsao pode ser usada para decidir.',
 'DEMANDA', 'Previsao',
 '100 menos o MAPE medio das previsoes com realizado apurado',
 'Modulo 04 - previsao (MAE, MAPE e RMSE ja implementados)', 'previsoes_demanda',
 'PERCENTUAL', 'MENSAL', 'MAIOR_MELHOR', 2, 3, 'previsoes',
 'Produto sem realizado suficiente fica de fora: MAPE com denominador zero nao existe.'),

('PRODUTOS_SAZONAIS', 'Produtos sazonais',
 'Produtos com sazonalidade confirmada pelo modulo 04.',
 'Antecipar pico e baixa.',
 'DEMANDA', 'Sazonalidade',
 'contagem de produtos com sazonalidade confirmada',
 'Modulo 04 - sazonalidade', 'sazonalidades',
 'CONTAGEM', 'TRIMESTRAL', 'MAIOR_MELHOR', 0, 1, 'sazonalidade', NULL),

-- ========================= FORNECEDORES (secao 26) =========================
('OTIF', 'OTIF',
 'Entregas no prazo e integrais sobre as entregas elegiveis, pela metodologia do modulo 08.',
 'Medir confiabilidade de entrega do fornecedor.',
 'LOGISTICA', 'Entrega',
 'entregas no prazo E integrais / entregas elegiveis x 100',
 'Modulo 08 - metodologia oficial de OTIF (nao recalculada aqui)',
 'entregas, ordem_compra_itens',
 'PERCENTUAL', 'MENSAL', 'MAIOR_MELHOR', 2, 3, 'entregas',
 'Entrega sem data de referencia nao e falha: fica fora do denominador.'),

('OTD', 'OTD',
 'Entregas dentro do prazo sobre as elegiveis, pela metodologia do modulo 08.',
 'Separar pontualidade de integralidade.',
 'LOGISTICA', 'Entrega',
 'entregas no prazo / entregas elegiveis x 100',
 'Modulo 08 - metodologia oficial de OTD', 'entregas',
 'PERCENTUAL', 'MENSAL', 'MAIOR_MELHOR', 2, 3, 'entregas', NULL),

('IN_FULL', 'In Full',
 'Entregas integrais sobre as elegiveis, pela metodologia do modulo 08.',
 'Medir atendimento de quantidade.',
 'LOGISTICA', 'Entrega',
 'entregas integrais / entregas elegiveis x 100',
 'Modulo 08 - metodologia oficial de In Full', 'entregas',
 'PERCENTUAL', 'MENSAL', 'MAIOR_MELHOR', 2, 3, 'entregas', NULL),

('ATRASO_MEDIO', 'Atraso medio',
 'Media de dias de atraso das entregas avaliadas no periodo.',
 'Dimensionar o tamanho do atraso, nao so a frequencia.',
 'LOGISTICA', 'Prazo',
 'media dos dias de atraso das entregas avaliadas',
 'Modulo 08 - acompanhamento de entregas', 'entregas',
 'DIAS', 'MENSAL', 'MENOR_MELHOR', 1, 3, 'entregas', NULL),

('LEAD_TIME_REAL', 'Lead time real',
 'Dias entre a emissao do pedido e a entrega efetiva.',
 'Comparar o prazo praticado com o contratado.',
 'LOGISTICA', 'Prazo',
 'media de (data real da entrega - data de emissao do pedido)',
 'Modulo 08 - entregas', 'entregas, ordens_compra',
 'DIAS', 'MENSAL', 'MENOR_MELHOR', 1, 3, 'entregas', NULL),

('ENTREGAS_ATRASADAS', 'Entregas atrasadas',
 'Itens de pedido com promessa vencida e saldo pendente.',
 'Fila de cobranca do dia.',
 'LOGISTICA', 'Prazo',
 'contagem de itens com data prometida vencida e quantidade pendente',
 'Modulo 08 - acompanhamento', 'ordem_compra_itens',
 'CONTAGEM', 'DIARIA', 'MENOR_MELHOR', 0, 1, 'entregas-atrasadas', NULL),

('SCORE_FORNECEDOR', 'Score medio de fornecedor',
 'Media dos scores das avaliacoes validas do periodo, pela metodologia do modulo 10.',
 'Acompanhar a performance consolidada da base.',
 'FORNECEDORES', 'Performance',
 'media de avaliacoes_fornecedores.score_final das avaliacoes com score',
 'Modulo 10 - avaliacao de fornecedores', 'avaliacoes_fornecedores',
 'INDICE', 'TRIMESTRAL', 'MAIOR_MELHOR', 1, 1, 'avaliacoes',
 'Avaliacao sem dados suficientes tem score nulo e fica fora da media.'),

('FORNECEDORES_MONITORADOS', 'Fornecedores em monitoramento',
 'Fornecedores com status de homologacao em monitoramento.',
 'Acompanhar quem esta sob observacao.',
 'FORNECEDORES', 'Homologacao',
 'contagem de fornecedores com status_homologacao EM_MONITORAMENTO',
 'Modulo 10 - situacao do fornecedor', 'fornecedores',
 'CONTAGEM', 'SOB_DEMANDA', 'MENOR_MELHOR', 0, 1, 'fornecedores', NULL),

('FORNECEDORES_BLOQUEADOS', 'Fornecedores bloqueados',
 'Fornecedores com bloqueio ativo.',
 'Saber com quem nao se pode comprar.',
 'FORNECEDORES', 'Homologacao',
 'contagem de fornecedores com status_homologacao BLOQUEADO',
 'Modulo 10 - situacao do fornecedor', 'fornecedores',
 'CONTAGEM', 'SOB_DEMANDA', 'MENOR_MELHOR', 0, 1, 'fornecedores', NULL),

-- ========================= RECEBIMENTO (secao 28) ==========================
('RECEBIMENTOS_PENDENTES', 'Recebimentos pendentes',
 'Recebimentos aguardando chegada, conferencia ou qualidade.',
 'Fila da doca.',
 'RECEBIMENTO', 'Fila',
 'contagem de recebimentos em AGUARDANDO_CHEGADA, CHEGOU, EM_CONFERENCIA ou AGUARDANDO_QUALIDADE',
 'Modulo 09 - recebimento', 'recebimentos',
 'CONTAGEM', 'DIARIA', 'MENOR_MELHOR', 0, 1, 'recebimentos', NULL),

('TEMPO_CONFERENCIA', 'Tempo medio de conferencia',
 'Horas entre o inicio e o fim da conferencia.',
 'Medir a produtividade da doca.',
 'RECEBIMENTO', 'Produtividade',
 'media de (conferencia_fim - conferencia_inicio) em horas',
 'Modulo 09 - recebimento', 'recebimentos',
 'HORAS', 'MENSAL', 'MENOR_MELHOR', 2, 3, 'recebimentos', NULL),

('TAXA_DIVERGENCIA', 'Taxa de divergencia',
 'Recebimentos com ao menos uma divergencia sobre os recebimentos avaliados.',
 'Medir a confiabilidade do que chega.',
 'RECEBIMENTO', 'Divergencia',
 'recebimentos com divergencia / recebimentos avaliados x 100',
 'Modulo 09 - divergencias de recebimento', 'recebimentos, recebimento_divergencias',
 'PERCENTUAL', 'MENSAL', 'MENOR_MELHOR', 2, 3, 'divergencias', NULL),

-- ========================== QUALIDADE (secao 29) ===========================
('TAXA_APROVACAO', 'Taxa de aprovacao',
 'Recebimentos aprovados sobre os recebimentos avaliados.',
 'Medir a qualidade do que entra.',
 'QUALIDADE', 'Aprovacao',
 'recebimentos aprovados / recebimentos avaliados x 100',
 'Modulo 09 - recebimento e qualidade', 'recebimentos',
 'PERCENTUAL', 'MENSAL', 'MAIOR_MELHOR', 2, 3, 'recebimentos', NULL),

('TAXA_NC', 'Taxa de nao conformidade',
 'Recebimentos com nao conformidade sobre os avaliados.',
 'Medir a frequencia de problema de qualidade.',
 'QUALIDADE', 'Nao conformidade',
 'recebimentos com NC / recebimentos avaliados x 100',
 'Modulo 09 - nao conformidades', 'recebimentos, nao_conformidades',
 'PERCENTUAL', 'MENSAL', 'MENOR_MELHOR', 2, 3, 'nao-conformidades',
 'Dez NCs no mesmo recebimento contam como um recebimento com problema.'),

('NC_CRITICAS', 'Nao conformidades criticas',
 'NCs de severidade critica abertas no periodo.',
 'Priorizar o que nao pode esperar.',
 'QUALIDADE', 'Nao conformidade',
 'contagem de nao_conformidades com severidade CRITICA no periodo',
 'Modulo 09 - nao conformidades', 'nao_conformidades',
 'CONTAGEM', 'MENSAL', 'MENOR_MELHOR', 0, 1, 'nao-conformidades', NULL),

('TAXA_DEVOLUCAO', 'Taxa de devolucao',
 'Recebimentos com devolucao ao fornecedor sobre os avaliados.',
 'Medir o retrabalho gerado pelo fornecedor.',
 'QUALIDADE', 'Devolucao',
 'recebimentos com devolucao / recebimentos avaliados x 100',
 'Modulo 09 - devolucoes', 'recebimentos, devolucoes',
 'PERCENTUAL', 'MENSAL', 'MENOR_MELHOR', 2, 3, 'devolucoes', NULL),

-- ========================= FINANCEIRO (secoes 30 e 31) =====================
('VALOR_RECEBIDO', 'Valor recebido',
 'Valor dos recebimentos aprovados no periodo.',
 'Base para conferencia com o financeiro.',
 'FINANCEIRO', 'Volume',
 'soma de recebimentos.valor_recebido dos recebimentos nao cancelados',
 'Modulo 09 - recebimento', 'recebimentos',
 'MOEDA', 'MENSAL', 'MAIOR_MELHOR', 2, 1, 'recebimentos', NULL),

('COMPROMISSO_FUTURO', 'Compromisso de compra',
 'Valor ja comprometido em pedidos com saldo pendente.',
 'Antecipar desembolso.',
 'FINANCEIRO', 'Compromisso',
 'soma do valor pendente dos pedidos em aberto',
 'Modulos 05 e 07 - compromissos de compra', 'compromissos_compra, vw_compras_abertas',
 'MOEDA', 'MENSAL', 'MENOR_MELHOR', 2, 1, 'compras-abertas', NULL),

-- ========================== IMPORTACAO (secao 32) ==========================
('PEDIDOS_IMPORTACAO', 'Pedidos de importacao',
 'Pedidos com incoterm definido ou fornecedor de origem importada.',
 'Acompanhar a carteira internacional.',
 'IMPORTACAO', 'Volume',
 'contagem de pedidos com incoterm preenchido ou fornecedor importado',
 'Modulos 07 e 08 - pedido e transporte', 'ordens_compra, fornecedores',
 'CONTAGEM', 'MENSAL', 'MAIOR_MELHOR', 0, 1, 'importacoes', NULL),

('VALOR_IMPORTACAO', 'Valor importado',
 'Valor convertido dos pedidos de importacao do periodo.',
 'Dimensionar a exposicao cambial.',
 'IMPORTACAO', 'Volume',
 'soma de ordens_compra.valor_total dos pedidos de importacao',
 'Modulo 07 - pedido, com a taxa de cambio ja registrada no pedido',
 'ordens_compra',
 'MOEDA', 'MENSAL', 'MENOR_MELHOR', 2, 1, 'importacoes',
 'Usa a taxa gravada no pedido. O sistema nao busca cotacao externa (secao 33).'),

-- ============================ RISCOS (secao 34) ============================
('PRODUTOS_MONOPROVEDOR', 'Produtos monoprovedor',
 'Produtos com um unico fornecedor ativo cadastrado.',
 'Enxergar dependencia de fornecimento.',
 'RISCOS', 'Concentracao',
 'contagem de produtos com exatamente um fornecedor ativo em produto_fornecedor',
 'Modulos 02 e 10 - produto x fornecedor', 'produto_fornecedor',
 'CONTAGEM', 'SOB_DEMANDA', 'MENOR_MELHOR', 0, 1, 'monoprovedor',
 'E informacao de risco: nao bloqueia compra (secao 49 do modulo 10).'),

('QUALIDADE_DADOS', 'Qualidade dos dados',
 'Percentual de completude dos cadastros que alimentam os indicadores.',
 'Saber o quanto os numeros do painel podem ser usados.',
 'RISCOS', 'Governanca',
 'media da completude dos campos obrigatorios de produtos, fornecedores e produto x fornecedor',
 'Modulos 02 e 03 - cadastros', 'produtos, fornecedores, produto_fornecedor',
 'PERCENTUAL', 'SEMANAL', 'MAIOR_MELHOR', 2, 1, 'qualidade-dados',
 'Indicador sobre o proprio sistema: completude baixa explica KPI sem dados.')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Metas iniciais (secao 12). Apenas onde ha um numero defensavel: inventar
-- meta para todo KPI so encheria a tela de semaforos sem significado.
-- ---------------------------------------------------------------------------

INSERT INTO kpi_metas (kpi_id, escopo, meta, limite_atencao, limite_critico, observacao)
SELECT k.id, 'EMPRESA', m.meta, m.atencao, m.critico, m.observacao
  FROM kpi_definicoes k
  JOIN (VALUES
    ('OTIF',            95.0,  90.0,  85.0, 'Referencia usual de mercado para distribuicao'),
    ('OTD',             95.0,  90.0,  85.0, NULL),
    ('IN_FULL',         97.0,  93.0,  90.0, NULL),
    ('TAXA_APROVACAO',  95.0,  90.0,  85.0, NULL),
    ('TAXA_NC',          5.0,  10.0,  15.0, 'Menor e melhor: atencao e critico sao acima da meta'),
    ('TAXA_DEVOLUCAO',   2.0,   5.0,  10.0, NULL),
    ('TAXA_DIVERGENCIA',10.0,  20.0,  30.0, NULL),
    ('ATRASO_MEDIO',     2.0,   5.0,  10.0, NULL),
    ('QUALIDADE_DADOS', 90.0,  80.0,  70.0, NULL),
    ('ACURACIDADE_PREVISAO', 80.0, 70.0, 60.0, NULL)
  ) AS m(codigo, meta, atencao, critico, observacao) ON upper(m.codigo) = upper(k.codigo)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Regras de alerta (secoes 40 a 42)
-- ---------------------------------------------------------------------------

INSERT INTO alertas_regras
  (codigo, nome, descricao, categoria, kpi_id, tipo_alerta, prioridade,
   comparador, limite, janela_dias)
SELECT r.codigo, r.nome, r.descricao, r.categoria, k.id,
       r.tipo::tipo_alerta_enum, r.prioridade::prioridade_alerta_enum,
       r.comparador, r.limite, r.janela
  FROM (VALUES
    ('OTIF_BAIXO', 'OTIF abaixo da meta',
     'Dispara quando o OTIF do periodo fica abaixo do limite critico da meta.',
     'fornecedor', 'OTIF', 'FORNECEDOR_BAIXO_DESEMPENHO', 'ALTO', 'FORA_DA_META', NULL, 90),
    ('NC_ALTA', 'Taxa de nao conformidade acima do limite',
     'Dispara quando a taxa de NC ultrapassa o limite de atencao.',
     'qualidade', 'TAXA_NC', 'QUALIDADE_REPROVADA', 'ALTO', 'FORA_DA_META', NULL, 90),
    ('RUPTURA_ATIVA', 'Produtos em ruptura',
     'Dispara quando existem produtos com demanda e sem estoque disponivel.',
     'ruptura', 'PRODUTOS_RUPTURA', 'RUPTURA', 'CRITICO', 'MAIOR_QUE', 0, 1),
    ('EXCESSO_ESTOQUE', 'Produtos em excesso',
     'Dispara quando ha produtos acima da cobertura maxima configurada.',
     'estoque', 'PRODUTOS_EXCESSO', 'ESTOQUE_EXCESSIVO', 'MEDIO', 'MAIOR_QUE', 0, 7),
    ('GIRO_BAIXO', 'Giro de estoque baixo',
     'Dispara quando o giro anualizado fica abaixo do minimo configurado.',
     'estoque', 'GIRO_ESTOQUE', 'GIRO_BAIXO', 'MEDIO', 'MENOR_QUE', 2, 90),
    ('PEDIDOS_ATRASADOS', 'Pedidos atrasados',
     'Dispara quando existem pedidos com promessa vencida e saldo pendente.',
     'atraso', 'PEDIDOS_ATRASADOS', 'PEDIDO_ATRASADO', 'ALTO', 'MAIOR_QUE', 0, 1),
    ('MONOPROVEDOR', 'Dependencia de fornecedor unico',
     'Dispara quando existem produtos com um unico fornecedor ativo.',
     'fornecedor', 'PRODUTOS_MONOPROVEDOR', 'FORNECEDOR_UNICO', 'BAIXO', 'MAIOR_QUE', 0, 30),
    ('DADOS_INCOMPLETOS', 'Qualidade dos dados abaixo do minimo',
     'Dispara quando a completude dos cadastros fica abaixo do minimo aceitavel.',
     'governanca', 'QUALIDADE_DADOS', 'QUALIDADE_DADOS', 'MEDIO', 'FORA_DA_META', NULL, 7)
  ) AS r(codigo, nome, descricao, categoria, kpi, tipo, prioridade, comparador, limite, janela)
  LEFT JOIN kpi_definicoes k ON upper(k.codigo) = upper(r.kpi)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Dashboards de sistema (secoes 5 e 59)
-- ---------------------------------------------------------------------------

INSERT INTO dashboards (codigo, nome, descricao, perfil, sistema, padrao, ordem)
VALUES
  ('EXECUTIVO',   'Dashboard executivo',
   'Visao consolidada de compras, estoque, fornecedores, logistica e qualidade.',
   'DIRETORIA', TRUE, TRUE, 1),
  ('COMPRAS',     'Dashboard de compras',
   'Volume, preco, saving, carteira aberta e atrasos.', 'GESTOR_COMPRAS', TRUE, FALSE, 2),
  ('ESTOQUE',     'Dashboard de estoque',
   'Posicao, cobertura, giro, ruptura, excesso e estoque parado.', 'ESTOQUE', TRUE, FALSE, 3),
  ('DEMANDA',     'Dashboard de demanda',
   'Demanda, previsao contra realizado, acuracidade e sazonalidade.',
   'COMERCIAL', TRUE, FALSE, 4),
  ('FORNECEDORES','Dashboard de fornecedores',
   'Homologacao, OTIF, qualidade, NC e evolucao de performance.',
   'GESTOR_COMPRAS', TRUE, FALSE, 5),
  ('LOGISTICA',   'Dashboard de logistica',
   'Carteira, entregas previstas, atrasadas e em risco, lead time.',
   'GESTOR_COMPRAS', TRUE, FALSE, 6),
  ('RECEBIMENTO', 'Dashboard de recebimento',
   'Fila da doca, aprovacoes, divergencias e tempo de conferencia.',
   'ESTOQUE', TRUE, FALSE, 7),
  ('QUALIDADE',   'Dashboard de qualidade',
   'Aprovacao, NC por severidade, devolucoes e quarentena.', 'QUALIDADE', TRUE, FALSE, 8),
  ('FINANCEIRO',  'Dashboard financeiro de compras',
   'Valor comprado, recebido, pendente, compromissos e prazo de pagamento.',
   'FINANCEIRO', TRUE, FALSE, 9),
  ('RISCOS',      'Mapa de riscos de compras',
   'Ruptura, excesso, concentracao, fornecedor unico, atraso e qualidade.',
   'GESTOR_COMPRAS', TRUE, FALSE, 10),
  ('COMPRADOR',   'Painel do comprador',
   'Necessidades, cotacoes, pedidos, atrasos e problemas de recebimento do dia.',
   'COMPRADOR', TRUE, FALSE, 11)
ON CONFLICT DO NOTHING;
