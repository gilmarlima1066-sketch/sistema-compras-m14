-- =========================================================================
-- MODULO 13 - CATALOGO PADRAO: REGRAS, JOBS E SLA
--
-- As automacoes das secoes 9 a 13 nascem como DADO, nao como codigo.
--
-- Cada regra e uma linha: evento, condicao, acao, nivel. Trocar um limiar, ou
-- decidir que criar cotacao deixa de ser assistido e passa a exigir aprovacao,
-- e uma alteracao de configuracao - com auditoria - e nao um deploy.
--
-- O NIVEL de cada regra segue a secao 33 e a regra dura da secao 9: nenhuma
-- automacao emite pedido de compra sem passar pelo fluxo de aprovacao. Por
-- isso nada que gere compromisso financeiro nasce AUTOMATICO.
-- =========================================================================

-- -------------------------------------------------------------------------
-- Regras (secoes 8 a 13)
-- -------------------------------------------------------------------------

INSERT INTO automacao_regras
  (codigo, nome, descricao, evento, condicao, acao, parametros, nivel, prioridade)
VALUES
  -- --- Estoque (secao 10) -------------------------------------------------
  ('EST_RUPTURA', 'Ruptura detectada',
   'Produto com demanda e sem estoque disponivel gera alerta critico e tarefa para o comprador',
   'STOCK_OUT', '[]'::jsonb, 'ALERTAR_E_TAREFA',
   '{"tipo_alerta":"RUPTURA","prioridade":"CRITICO","perfil":"COMPRADOR","sla":"RUPTURA"}'::jsonb,
   'AUTOMATICO', 10),

  ('EST_RISCO_RUPTURA', 'Risco de ruptura',
   'Saldo projetado para acabar dentro do horizonte configurado',
   'STOCK_LOW', '[{"campo":"dias_ate_ruptura","operador":"<=","valor":15}]'::jsonb,
   'ALERTAR_E_TAREFA',
   '{"tipo_alerta":"RISCO_RUPTURA","prioridade":"ALTO","perfil":"COMPRADOR","sla":"REPOSICAO"}'::jsonb,
   'AUTOMATICO', 20),

  ('EST_EXCESSO', 'Excesso de estoque',
   'Saldo acima do maximo aceitavel com capital imobilizado relevante',
   'STOCK_EXCESS', '[{"campo":"valor_parado","operador":">=","valor":500}]'::jsonb,
   'ALERTAR',
   '{"tipo_alerta":"ESTOQUE_EXCESSIVO","prioridade":"MEDIO"}'::jsonb,
   'AUTOMATICO', 60),

  ('EST_VALIDADE', 'Validade proxima',
   'Lote proximo do vencimento sem escoamento previsto no ritmo atual',
   'STOCK_EXPIRY', '[]'::jsonb, 'ALERTAR_E_TAREFA',
   '{"tipo_alerta":"VALIDADE_PROXIMA","prioridade":"ALTO","perfil":"ESTOQUE","sla":"VALIDADE"}'::jsonb,
   'AUTOMATICO', 30),

  ('EST_NEGATIVO', 'Estoque negativo',
   'Saldo inconsistente: qualquer conta sobre ele herda o erro',
   'STOCK_NEGATIVE', '[]'::jsonb, 'ALERTAR_E_TAREFA',
   '{"tipo_alerta":"ESTOQUE_PARADO","prioridade":"ALTO","perfil":"ESTOQUE","sla":"CORRECAO"}'::jsonb,
   'AUTOMATICO', 15),

  -- --- Compras (secao 9) --------------------------------------------------
  ('CMP_NECESSIDADE', 'Necessidade de compra detectada',
   'Produto cruzou o ponto de pedido: cria tarefa de analise para o comprador',
   'PURCHASE_NEED_CREATED', '[]'::jsonb, 'TAREFA',
   '{"perfil":"COMPRADOR","prioridade":"ALTA","sla":"ANALISE_NECESSIDADE"}'::jsonb,
   'ASSISTIDO', 25),

  ('CMP_AGRUPAR', 'Agrupar necessidades por fornecedor',
   'Varias necessidades do mesmo fornecedor: consolidar em uma cotacao reduz frete e esforco',
   'PURCHASE_NEED_CREATED', '[{"campo":"necessidades_do_fornecedor","operador":">=","valor":3}]'::jsonb,
   'SUGERIR_CONSOLIDACAO',
   '{"perfil":"COMPRADOR","prioridade":"MEDIA"}'::jsonb,
   'ASSISTIDO', 40),

  ('CMP_COTACAO', 'Sugerir abertura de cotacao',
   'Necessidade critica sem cotacao em aberto para o produto',
   'PURCHASE_NEED_CRITICAL', '[]'::jsonb, 'TAREFA',
   '{"perfil":"COMPRADOR","prioridade":"CRITICA","acao":"Abrir cotacao","sla":"COTACAO"}'::jsonb,
   'ASSISTIDO', 20),

  ('CMP_COTACAO_PENDENTE', 'Cotacao sem resposta',
   'Cotacao passou do prazo de resposta sem proposta de todos os fornecedores',
   'QUOTE_OVERDUE', '[]'::jsonb, 'ALERTAR_E_TAREFA',
   '{"tipo_alerta":"APROVACAO_PENDENTE","prioridade":"MEDIO","perfil":"COMPRADOR","sla":"COTACAO"}'::jsonb,
   'AUTOMATICO', 50),

  -- --- Pedidos (secao 12) -------------------------------------------------
  ('PED_ATRASADO', 'Pedido atrasado',
   'Data prometida vencida com saldo pendente: alerta, tarefa e impacto no estoque',
   'PO_LATE', '[]'::jsonb, 'ALERTAR_E_TAREFA',
   '{"tipo_alerta":"PEDIDO_ATRASADO","prioridade":"ALTO","perfil":"COMPRADOR","sla":"COBRANCA"}'::jsonb,
   'AUTOMATICO', 20),

  ('PED_SEM_CONFIRMACAO', 'Pedido sem confirmacao',
   'Pedido emitido ha mais de tres dias sem confirmacao do fornecedor',
   'PO_UNCONFIRMED', '[{"campo":"dias_sem_confirmacao","operador":">=","valor":3}]'::jsonb,
   'ALERTAR_E_TAREFA',
   '{"tipo_alerta":"PEDIDO_SEM_CONFIRMACAO","prioridade":"MEDIO","perfil":"COMPRADOR","sla":"CONFIRMACAO"}'::jsonb,
   'AUTOMATICO', 45),

  -- --- Fornecedores (secao 11) -------------------------------------------
  ('FOR_OTIF_BAIXO', 'OTIF abaixo da meta',
   'Fornecedor com pontualidade abaixo da meta no periodo avaliado',
   'SUPPLIER_PERFORMANCE_DROP', '[]'::jsonb, 'ALERTAR_E_TAREFA',
   '{"tipo_alerta":"FORNECEDOR_BAIXO_DESEMPENHO","prioridade":"ALTO","perfil":"GESTOR_COMPRAS","sla":"ANALISE_FORNECEDOR"}'::jsonb,
   'AUTOMATICO', 35),

  ('FOR_PRECO', 'Aumento anormal de preco',
   'Preco de compra acima da mediana historica alem do limite configurado',
   'PRICE_INCREASE', '[]'::jsonb, 'ALERTAR_E_TAREFA',
   '{"tipo_alerta":"PRECO_ACIMA_DA_MEDIA","prioridade":"MEDIO","perfil":"COMPRADOR","sla":"ANALISE_PRECO"}'::jsonb,
   'AUTOMATICO', 55),

  ('FOR_MONOPROVEDOR', 'Dependencia de fornecedor unico',
   'Produto com demanda ativa e um unico fornecedor homologado',
   'SUPPLIER_SINGLE_SOURCE', '[]'::jsonb, 'ALERTAR',
   '{"tipo_alerta":"FORNECEDOR_UNICO","prioridade":"BAIXO"}'::jsonb,
   'AUTOMATICO', 80),

  -- --- Qualidade e recebimento (secao 13) ---------------------------------
  ('QUA_NC_CRITICA', 'Nao conformidade critica',
   'NC de severidade critica registrada no recebimento',
   'QUALITY_NONCONFORMITY', '[{"campo":"severidade","operador":"=","valor":"CRITICA"}]'::jsonb,
   'ALERTAR_E_TAREFA',
   '{"tipo_alerta":"NC_CRITICA","prioridade":"CRITICO","perfil":"QUALIDADE","sla":"NAO_CONFORMIDADE"}'::jsonb,
   'AUTOMATICO', 10),

  ('REC_DIVERGENCIA', 'Divergencia no recebimento',
   'Quantidade ou qualidade recebida diferente do pedido',
   'RECEIPT_DIVERGENCE', '[]'::jsonb, 'ALERTAR_E_TAREFA',
   '{"tipo_alerta":"RECEBIMENTO_DIVERGENTE","prioridade":"ALTO","perfil":"ESTOQUE","sla":"DIVERGENCIA"}'::jsonb,
   'AUTOMATICO', 30),

  -- --- IA (secao 32) ------------------------------------------------------
  ('IA_RISCO', 'Risco detectado pela IA',
   'A IA classificou um risco como critico: vira tarefa priorizada',
   'AI_RISK_DETECTED', '[{"campo":"nivel","operador":"in","valor":["CRITICO","ALTO"]}]'::jsonb,
   'TAREFA',
   '{"perfil":"GESTOR_COMPRAS","prioridade":"ALTA","sla":"ANALISE_RISCO"}'::jsonb,
   'ASSISTIDO', 25),

  ('IA_RECOMENDACAO', 'Recomendacao da IA de alta prioridade',
   'Recomendacao critica ou alta gera tarefa para quem decide',
   'AI_RECOMMENDATION_CREATED',
   '[{"campo":"prioridade","operador":"in","valor":["CRITICO","ALTO"]}]'::jsonb,
   'TAREFA',
   '{"perfil":"GESTOR_COMPRAS","prioridade":"ALTA","sla":"DECISAO_RECOMENDACAO"}'::jsonb,
   'ASSISTIDO', 30),

  -- --- Excecoes (secao 16) ------------------------------------------------
  ('EXC_PRECO_ACIMA', 'Excecao: preco acima do historico',
   'Compra proposta com preco acima da mediana historica exige aprovacao formal',
   'EXCEPTION_PRICE_ABOVE', '[]'::jsonb, 'SOLICITAR_APROVACAO',
   '{"tipo":"EXCECAO_PRECO","perfil":"GESTOR_COMPRAS","sla":"APROVACAO"}'::jsonb,
   'APROVACAO', 15),

  ('EXC_FORNECEDOR_NAO_PRINCIPAL', 'Excecao: fornecedor nao principal',
   'Compra proposta a fornecedor que nao e o principal do produto',
   'EXCEPTION_SUPPLIER', '[]'::jsonb, 'SOLICITAR_APROVACAO',
   '{"tipo":"EXCECAO_FORNECEDOR","perfil":"GESTOR_COMPRAS","sla":"APROVACAO"}'::jsonb,
   'APROVACAO', 15)
ON CONFLICT DO NOTHING;

-- -------------------------------------------------------------------------
-- Politicas de SLA (secoes 19 e 20)
-- -------------------------------------------------------------------------

INSERT INTO sla_politicas
  (codigo, nome, etapa, horas, alerta_percentual,
   escalonar_nivel1_horas, escalonar_nivel2_horas, escalonar_nivel3_horas,
   perfil_nivel1, perfil_nivel2, perfil_nivel3)
VALUES
  ('RUPTURA', 'Ruptura ativa', 'ESTOQUE', 4, 50, 4, 8, 24,
   'COMPRADOR', 'GESTOR_COMPRAS', 'DIRETORIA'),
  ('REPOSICAO', 'Risco de ruptura', 'COMPRAS', 24, 70, 24, 48, 96,
   'COMPRADOR', 'GESTOR_COMPRAS', 'DIRETORIA'),
  ('ANALISE_NECESSIDADE', 'Analise de necessidade', 'COMPRAS', 48, 80, 48, 96, NULL,
   'COMPRADOR', 'GESTOR_COMPRAS', NULL),
  ('COTACAO', 'Resposta de cotacao', 'COTACOES', 72, 80, 72, 120, NULL,
   'COMPRADOR', 'GESTOR_COMPRAS', NULL),
  ('APROVACAO', 'Aprovacao pendente', 'APROVACAO', 24, 75, 24, 48, 72,
   'GESTOR_COMPRAS', 'DIRETORIA', 'DIRETORIA'),
  ('CONFIRMACAO', 'Confirmacao do pedido', 'PEDIDOS', 48, 80, 48, 96, NULL,
   'COMPRADOR', 'GESTOR_COMPRAS', NULL),
  ('COBRANCA', 'Cobranca de pedido atrasado', 'LOGISTICA', 8, 60, 8, 24, 72,
   'COMPRADOR', 'GESTOR_COMPRAS', 'DIRETORIA'),
  ('DIVERGENCIA', 'Divergencia de recebimento', 'RECEBIMENTO', 24, 75, 24, 48, NULL,
   'ESTOQUE', 'QUALIDADE', NULL),
  ('NAO_CONFORMIDADE', 'Resolucao de nao conformidade', 'QUALIDADE', 72, 70, 72, 120, 240,
   'QUALIDADE', 'GESTOR_COMPRAS', 'DIRETORIA'),
  ('VALIDADE', 'Escoamento de lote vencendo', 'ESTOQUE', 120, 70, 120, 240, NULL,
   'ESTOQUE', 'GESTOR_COMPRAS', NULL),
  ('CORRECAO', 'Correcao de inconsistencia', 'ESTOQUE', 24, 80, 24, 48, NULL,
   'ESTOQUE', 'GESTOR_COMPRAS', NULL),
  ('ANALISE_FORNECEDOR', 'Analise de performance', 'FORNECEDORES', 120, 80, 120, 240, NULL,
   'GESTOR_COMPRAS', 'DIRETORIA', NULL),
  ('ANALISE_PRECO', 'Analise de variacao de preco', 'COMPRAS', 72, 80, 72, 168, NULL,
   'COMPRADOR', 'GESTOR_COMPRAS', NULL),
  ('ANALISE_RISCO', 'Analise de risco da IA', 'IA', 24, 75, 24, 48, NULL,
   'GESTOR_COMPRAS', 'DIRETORIA', NULL),
  ('DECISAO_RECOMENDACAO', 'Decisao sobre recomendacao', 'IA', 72, 80, 72, 168, NULL,
   'GESTOR_COMPRAS', 'DIRETORIA', NULL)
ON CONFLICT DO NOTHING;

-- -------------------------------------------------------------------------
-- Jobs (secao 21)
-- -------------------------------------------------------------------------

/*
 * Os horarios sao configuraveis por linha, como a secao 21 exige.
 *
 * Os jobs pesados rodam de madrugada, escalonados: dois deles no mesmo minuto
 * competiriam pelo banco justamente enquanto ninguem esta olhando para
 * perceber.
 */
INSERT INTO jobs
  (codigo, nome, descricao, frequencia, hora, minuto, dia_semana, dia_mes,
   intervalo_minutos, timeout_segundos)
VALUES
  ('DETECTAR_EVENTOS', 'Detectar eventos operacionais',
   'Varre estoque, pedidos, qualidade e fornecedores e registra os eventos do dia',
   'HORA', NULL, 7, NULL, NULL, 60, 600),

  ('PROCESSAR_FILA', 'Processar a fila de automacao',
   'Consome a fila; existe tambem como job para o caso de o worker do processo estar parado',
   'MINUTO', NULL, 0, NULL, NULL, 5, 300),

  ('VERIFICAR_SLA', 'Verificar SLA e escalonar',
   'Marca tarefas em risco e vencidas e escalona conforme a politica',
   'HORA', NULL, 17, NULL, NULL, 60, 300),

  ('ESTOQUE_DIARIO', 'Rotina diaria de estoque',
   'Cobertura, rupturas, excesso, validade e estoque parado',
   'DIARIO', 5, 10, NULL, NULL, NULL, 900),

  ('PEDIDOS_DIARIO', 'Rotina diaria de pedidos',
   'Atrasos, pedidos sem confirmacao e impacto no abastecimento',
   'DIARIO', 5, 25, NULL, NULL, NULL, 600),

  ('IA_RECOMENDACOES', 'Gerar recomendacoes da IA',
   'Roda a analise do modulo 12 e transforma o que e critico em tarefa',
   'DIARIO', 5, 40, NULL, NULL, NULL, 1200),

  ('FORNECEDORES_SEMANAL', 'Analise semanal de fornecedores',
   'Performance, OTIF, qualidade e variacao de preco',
   'SEMANAL', 6, 0, 1, NULL, NULL, 1200),

  ('OPORTUNIDADES_SEMANAL', 'Oportunidades de economia',
   'Excesso, consolidacao e renegociacao',
   'SEMANAL', 6, 30, 1, NULL, NULL, 900),

  ('KPI_MENSAL', 'Fechamento mensal de indicadores',
   'Congela os resultados de KPI do mes no historico',
   'MENSAL', 4, 0, NULL, 1, NULL, 1800),

  ('LIMPEZA', 'Limpeza de eventos antigos',
   'Remove eventos processados alem do prazo de retencao',
   'DIARIO', 3, 0, NULL, NULL, NULL, 600)
ON CONFLICT DO NOTHING;

-- -------------------------------------------------------------------------
-- Integracao de exemplo, desativada (secoes 26 e 27)
-- -------------------------------------------------------------------------

/*
 * Nasce INATIVA e sem segredo, de proposito.
 *
 * A secao 26 pede a arquitetura pronta e manda nao implementar integracao
 * especifica sem necessidade. Uma integracao ativa por padrao seria uma porta
 * aberta que ninguem pediu.
 */
INSERT INTO integracoes (codigo, nome, tipo, direcao, ativo)
VALUES
  ('ERP', 'ERP corporativo', 'ERP', 'BIDIRECIONAL', FALSE),
  ('TRANSPORTADORA', 'Rastreamento de transporte', 'LOGISTICA', 'ENTRADA', FALSE),
  ('FORNECEDOR_PORTAL', 'Portal de fornecedores', 'FORNECEDOR', 'ENTRADA', FALSE)
ON CONFLICT DO NOTHING;
