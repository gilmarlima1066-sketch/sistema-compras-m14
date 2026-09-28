-- =========================================================================
-- MODULO 14 - CATALOGO INICIAL DE INTEGRACOES, TEMPLATES E JOBS
--
-- O catalogo nasce DESATIVADO, de proposito.
--
-- Uma integracao ativa aponta para um sistema real e tenta falar com ele. Vir
-- ligada de fabrica significaria o sistema tentando alcancar um ERP que nao
-- existe, acumulando erro de conexao no painel desde o primeiro minuto e
-- treinando quem opera a ignorar a tela de erros. Cada uma e ligada quando o
-- endpoint e a credencial existirem - e o painel mostra NAO_CONFIGURADO, que
-- e a verdade.
-- =========================================================================

-- -------------------------------------------------------------------------
-- Integracoes
-- -------------------------------------------------------------------------

/*
 * As tres do modulo 13 sao COMPLETADAS, nao recriadas: elas ja tem codigo,
 * historico de webhook e, no caso do ERP, 129 mil vendas apontando para o
 * codigo `ERP:REL7104`. Recria-las quebraria essa ligacao.
 */
UPDATE integracoes SET
  conector = 'REST', direcao = 'BIDIRECIONAL', modo_sincronizacao = 'AGENDADO',
  intervalo_minutos = 60, timeout_segundos = 60, max_tentativas = 3,
  limite_por_execucao = 10000,
  configuracao = jsonb_build_object(
    'entidades', jsonb_build_array('produtos', 'fornecedores', 'vendas',
                                   'estoque', 'compras', 'recebimentos'),
    'formato_data', 'YYYY-MM-DD',
    'paginacao', jsonb_build_object('tipo', 'offset', 'tamanho', 500)),
  observacao = 'Entrada de cadastros, vendas, estoque e compras; saida de '
    || 'requisicoes e pedidos aprovados (secoes 8 e 9). Endpoint e credencial '
    || 'a definir com o fornecedor do ERP.'
 WHERE upper(codigo) = 'ERP';

UPDATE integracoes SET
  conector = 'REST', direcao = 'ENTRADA', modo_sincronizacao = 'AGENDADO',
  intervalo_minutos = 120, timeout_segundos = 30,
  configuracao = jsonb_build_object(
    'entidades', jsonb_build_array('rastreamento', 'ocorrencias', 'previsao_entrega'),
    'atualiza_modulo', '08'),
  observacao = 'Rastreamento e previsao de entrega. Atualiza o modulo 08 '
    || 'pelas regras dele, nunca escrevendo direto na entrega (secao 21).'
 WHERE upper(codigo) = 'TRANSPORTADORA';

UPDATE integracoes SET
  conector = 'WEBHOOK', direcao = 'ENTRADA', modo_sincronizacao = 'TEMPO_REAL',
  configuracao = jsonb_build_object(
    'nivel_fornecedor', 3,
    'entidades', jsonb_build_array('cotacao_resposta', 'confirmacao_pedido', 'eta')),
  observacao = 'Portal do fornecedor: nivel 3 da secao 19. O fornecedor so '
    || 'enxerga os proprios dados (secao 20).'
 WHERE upper(codigo) = 'FORNECEDOR_PORTAL';

/* As que faltam para cobrir os sistemas das secoes 15, 19, 22 e 23. */
INSERT INTO integracoes
  (codigo, nome, tipo, sistema, conector, direcao, modo_sincronizacao, ativo,
   timeout_segundos, max_tentativas, limite_por_execucao, intervalo_minutos,
   configuracao, observacao)
SELECT novo.* FROM (VALUES
  ('ERP_ARQUIVO', 'ERP por arquivo (relatorio exportado)', 'ERP',
   'ERP'::sistema_integrado_enum, 'ARQUIVO'::tipo_conector_enum,
   'ENTRADA'::direcao_integracao_enum, 'MANUAL'::modo_sincronizacao_enum,
   true, 300, 1, 1000000, NULL::integer,
   jsonb_build_object('formatos', jsonb_build_array('XLSX', 'CSV'),
                      'template_padrao', 'REL7104_VENDAS'),
   'Caminho que a empresa ja usa hoje: o ERP exporta o relatorio e ele e '
   || 'importado aqui. E o unico conector de ERP que funciona sem depender de '
   || 'endpoint publicado, e por isso nasce ATIVO.'),

  ('EMAIL_COMPRAS', 'Caixa de compras', 'EMAIL', 'EMAIL',
   'EMAIL', 'BIDIRECIONAL', 'AGENDADO', false, 60, 3, 200, 15,
   jsonb_build_object('pasta', 'INBOX',
                      'assuntos', jsonb_build_array('cotacao', 'proposta', 'pedido'),
                      'anexos', jsonb_build_array('XLSX', 'CSV', 'PDF', 'XML')),
   'Recebe cotacao e documento por e-mail (secoes 15 a 18). A extracao e '
   || 'apresentada para validacao antes de alterar registro critico.'),

  ('FISCAL_NFE', 'Documentos fiscais (NF-e)', 'FISCAL', 'FISCAL',
   'ARQUIVO', 'ENTRADA', 'MANUAL', false, 60, 3, 5000, NULL,
   jsonb_build_object('formatos', jsonb_build_array('XML'),
                      'exige_recebimento_modulo_09', true),
   'XML de NF-e. NAO altera estoque: gera pre-recebimento para o modulo 09 '
   || 'aplicar as regras dele (secao 22).'),

  ('BANCO_ANALITICO', 'Banco de dados externo (somente leitura)', 'BANCO',
   'BANCO_DADOS', 'BANCO_SQL', 'ENTRADA', 'AGENDADO', false, 120, 2, 50000, 1440,
   jsonb_build_object('somente_leitura', true,
                      'bancos_suportados', jsonb_build_array('postgresql', 'sqlserver', 'mysql')),
   'Leitura analitica. Exige usuario somente leitura do lado de la (secao 23).'),

  ('FORNECEDOR_API', 'Fornecedor com API propria', 'FORNECEDOR', 'FORNECEDOR',
   'REST', 'BIDIRECIONAL', 'AGENDADO', false, 30, 3, 2000, 240,
   jsonb_build_object('nivel_fornecedor', 4,
                      'entidades', jsonb_build_array('catalogo', 'preco', 'disponibilidade', 'pedido')),
   'Nivel 4 da secao 19. Um registro por fornecedor com API; este e o modelo.')
  ) AS novo(codigo, nome, tipo, sistema, conector, direcao, modo_sincronizacao,
            ativo, timeout_segundos, max_tentativas, limite_por_execucao,
            intervalo_minutos, configuracao, observacao)
 WHERE NOT EXISTS (
   SELECT 1 FROM integracoes i WHERE upper(i.codigo) = upper(novo.codigo));

-- -------------------------------------------------------------------------
-- Templates de mapeamento (secoes 12 e 26)
-- -------------------------------------------------------------------------

/*
 * REL7104 e o relatorio de faturamento que a empresa ja exporta do ERP.
 *
 * Este template nao e exemplo: e o layout real dos quatro arquivos que
 * alimentaram as 129 mil vendas do banco. Deixa-lo pronto significa que
 * importar o proximo mes e escolher o arquivo e confirmar - sem remapear 23
 * colunas toda vez, que e o trabalho que a secao 12 quer eliminar.
 */
INSERT INTO integracao_templates
  (codigo, nome, descricao, entidade, formato, linha_cabecalho, configuracao)
SELECT novo.* FROM (VALUES
  ('REL7104_VENDAS'::text,
   'ERP - Relatorio 7104 (faturamento por item)',
   'Layout real exportado pelo ERP. Uma linha por ITEM de nota; a venda e '
   || 'montada agrupando pelas colunas de documento.',
   'vendas', 'XLSX'::formato_arquivo_enum, 1,
   jsonb_build_object(
     -- A chave natural e composta: numero da nota sozinho repete entre
     -- clientes e entre anos.
     'chave_natural', jsonb_build_array('NUMNF', 'ID_CIENTE', 'DTFATURAMENTO'),
     'agrupar_por', jsonb_build_array('NUMNF', 'ID_CIENTE', 'DTFATURAMENTO'),
     'linha_e_item', true,
     'decimal', ',',
     'formato_data', 'DD/MM/YYYY',
     -- SITUACAO vem do ERP com notas canceladas misturadas.
     'filtro_situacao_excluir', jsonb_build_array('CANCELADA', 'CANCELADO'))),

  ('PRODUTOS_PADRAO', 'Cadastro de produtos', 'Layout generico de produtos',
   'produtos', 'XLSX', 1,
   jsonb_build_object('chave_natural', jsonb_build_array('codigo'))),

  ('FORNECEDORES_PADRAO', 'Cadastro de fornecedores',
   'Layout generico de fornecedores', 'fornecedores', 'XLSX', 1,
   jsonb_build_object('chave_natural', jsonb_build_array('cnpj'))),

  ('PRECOS_FORNECEDOR', 'Tabela de precos do fornecedor',
   'Planilha que o fornecedor envia com preco por produto (nivel 2 da secao 19)',
   'produto_fornecedor', 'XLSX', 1,
   jsonb_build_object('chave_natural',
                      jsonb_build_array('codigo_produto', 'cnpj_fornecedor')))
  ) AS novo(codigo, nome, descricao, entidade, formato, linha_cabecalho, configuracao)
 WHERE NOT EXISTS (
   SELECT 1 FROM integracao_templates t WHERE upper(t.codigo) = upper(novo.codigo));

-- -------------------------------------------------------------------------
-- Mapeamento do REL7104: coluna do Excel -> campo do sistema
-- -------------------------------------------------------------------------

INSERT INTO integracao_mapeamentos
  (template_id, campo_externo, campo_interno, transformacao, obrigatorio, ordem, observacao)
SELECT t.id, m.externo, m.interno, m.transf, m.obrig, m.ord, m.obs
  FROM integracao_templates t,
  (VALUES
    ('NUMNF',         'venda.numero_documento', 'texto',   true,  1,
     'Parte da chave natural'),
    ('ID_CIENTE',     'cliente.codigo_externo', 'texto',   true,  2,
     'Grafia do ERP mantida: o cabecalho vem sem o N'),
    ('DTFATURAMENTO', 'venda.data_venda',       'data',    true,  3,
     'Parte da chave natural'),
    ('APELIDO',       'venda.canal',            'texto',   false, 4,
     'Vendedor ou canal, conforme o cadastro do ERP'),
    ('TIPO',          'venda.tipo_documento',   'texto',   false, 5, NULL),
    ('SITUACAO',      'venda.status',           'texto',   false, 6, NULL),
    ('TOTAL',         'item.valor_total',       'decimal', true,  7, NULL),
    ('CODPRODUTO',    'produto.codigo',         'texto',   true,  8,
     'Casado com produtos.codigo; produto inexistente vira alerta, nao cadastro'),
    ('DESCRICAO',     'produto.descricao',      'texto',   false, 9, NULL),
    ('QTDE',          'item.quantidade',        'decimal', true, 10, NULL),
    ('VALORMEDIO',    'item.preco_unitario',    'decimal', false, 11, NULL),
    ('CUSTO',         'item.custo_unitario',    'decimal', false, 12, NULL),
    ('CUSTO_TOTAL',   'item.custo_total',       'decimal', false, 13, NULL),
    ('IMPOSTO',       'item.imposto',           'decimal', false, 14, NULL),
    ('NUMLOTE',       'item.numero_lote',       'texto',   false, 15, NULL),
    ('VALIDADECP',    'item.data_validade',     'data',    false, 16, NULL),
    ('FANTASIA',      'cliente.nome',           'texto',   false, 17, NULL),
    ('CIDADE',        'cliente.cidade',         'texto',   false, 18, NULL),
    ('ESTADO',        'cliente.estado',         'uf',      false, 19,
     'Normalizado para a sigla de dois caracteres'),
    ('SUBGRUPO',      'produto.subcategoria',   'texto',   false, 20, NULL),
    ('CFOP',          'venda.cfop',             'texto',   false, 21, NULL),
    ('CODOP',         'venda.codigo_operacao',  'texto',   false, 22, NULL),
    ('VENDA',         'venda.referencia',       'texto',   false, 23, NULL)
  ) AS m(externo, interno, transf, obrig, ord, obs)
 WHERE t.codigo = 'REL7104_VENDAS'
ON CONFLICT DO NOTHING;

-- -------------------------------------------------------------------------
-- Jobs (secao 10)
-- -------------------------------------------------------------------------

/*
 * Os jobs de integracao entram na tabela `jobs` do modulo 13, nao numa tabela
 * propria: o agendador, a trava de concorrencia, a liberacao de orfaos e o
 * historico ja existem e funcionam. Um segundo agendador seria outro relogio
 * para manter em dia.
 */
INSERT INTO jobs
  (codigo, nome, descricao, frequencia, hora, minuto, intervalo_minutos,
   timeout_segundos, ativo)
SELECT novo.* FROM (VALUES
  ('INTEGRACAO_SINCRONIZAR',
   'Sincronizar integracoes agendadas',
   'Roda as integracoes ativas cujo intervalo venceu (secao 10)',
   'MINUTO'::frequencia_job_enum, NULL::smallint, 0::smallint, 5, 600, true),

  ('INTEGRACAO_PROCESSAR',
   'Processar mensagens de integracao',
   'Aplica as mensagens pendentes e reprocessa as em retry (secoes 29 e 30)',
   'MINUTO', NULL, 0, 5, 600, true),

  ('INTEGRACAO_CONCILIAR',
   'Conciliar saldos com as origens externas',
   'Compara estoque e cadastros com a origem e gera divergencia (secao 34)',
   'DIARIO', 5, 50, NULL, 900, true),

  ('INTEGRACAO_SAUDE',
   'Verificar saude das integracoes',
   'Marca integracao parada, credencial vencendo e erro em serie',
   'HORA', NULL, 37, 60, 300, true)
  ) AS novo(codigo, nome, descricao, frequencia, hora, minuto,
            intervalo_minutos, timeout_segundos, ativo)
 WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE upper(j.codigo) = upper(novo.codigo));

-- -------------------------------------------------------------------------
-- Regras de automacao para os eventos de integracao (modulo 13)
-- -------------------------------------------------------------------------

/*
 * Os eventos de integracao entram no MESMO motor de regras do modulo 13. E o
 * que a secao 6 desenha: recebimento -> evento -> automacao -> modulos. Sem
 * isso, a integracao teria de saber o que fazer com cada fato - e passaria a
 * decidir, que e trabalho do motor de regras.
 *
 * Nenhuma delas e AUTOMATICO alem de alertar e abrir tarefa: a secao 34 proibe
 * corrigir divergencia sozinho, e a 22 manda o fiscal passar pelo modulo 09.
 */
INSERT INTO automacao_regras
  (codigo, nome, descricao, evento, condicao, acao, parametros, nivel, prioridade)
SELECT novo.* FROM (VALUES
  ('INT_DIVERGENCIA',
   'Divergencia de conciliacao',
   'Saldo do sistema difere da origem externa alem da tolerancia',
   'INTEGRATION_MISMATCH', '[]'::jsonb, 'ALERTAR_E_TAREFA',
   jsonb_build_object('tipo_alerta', 'INTEGRACAO_DIVERGENCIA', 'prioridade', 'ALTO',
                      'perfil', 'ESTOQUE', 'sla', 'CORRECAO'),
   'AUTOMATICO'::nivel_automacao_enum, 25),

  ('INT_FALHA',
   'Integracao falhando',
   'Execucao de integracao terminou em erro',
   'INTEGRATION_FAILED', '[]'::jsonb, 'ALERTAR_E_TAREFA',
   jsonb_build_object('tipo_alerta', 'INTEGRACAO_FALHOU', 'prioridade', 'ALTO',
                      'perfil', 'ADMIN', 'sla', 'CORRECAO'),
   'AUTOMATICO', 20),

  ('INT_IMPORTACAO_ERROS',
   'Importacao com linhas rejeitadas',
   'Arquivo importado deixou linhas para tras',
   'IMPORT_COMPLETED_WITH_ERRORS', '[]'::jsonb, 'ALERTAR',
   jsonb_build_object('tipo_alerta', 'IMPORTACAO_COM_ERROS', 'prioridade', 'MEDIO'),
   'AUTOMATICO', 60),

  ('INT_CREDENCIAL',
   'Credencial vencendo',
   'Credencial de integracao proxima do vencimento',
   'CREDENTIAL_EXPIRING', '[]'::jsonb, 'ALERTAR_E_TAREFA',
   jsonb_build_object('tipo_alerta', 'CREDENCIAL_VENCENDO', 'prioridade', 'ALTO',
                      'perfil', 'ADMIN', 'sla', 'CORRECAO'),
   'AUTOMATICO', 30),

  ('INT_PARADA',
   'Integracao sem sincronizar',
   'Integracao ativa nao sincroniza ha mais tempo que o configurado',
   'INTEGRATION_STALE', '[]'::jsonb, 'ALERTAR_E_TAREFA',
   jsonb_build_object('tipo_alerta', 'INTEGRACAO_SEM_SINCRONIZAR', 'prioridade', 'ALTO',
                      'perfil', 'ADMIN', 'sla', 'CORRECAO'),
   'AUTOMATICO', 30),

  ('INT_COTACAO_EMAIL',
   'Proposta recebida por e-mail',
   'Anexo de e-mail interpretado como proposta de fornecedor',
   'QUOTE_RECEIVED', '[]'::jsonb, 'TAREFA',
   jsonb_build_object('perfil', 'COMPRADOR', 'prioridade', 'ALTA', 'sla', 'COTACAO',
                      'acao', 'Conferir os dados extraidos antes de registrar a proposta'),
   'ASSISTIDO', 25),

  ('INT_NFE',
   'NF-e recebida',
   'Documento fiscal recebido; o recebimento segue o modulo 09',
   'FISCAL_DOCUMENT_RECEIVED', '[]'::jsonb, 'TAREFA',
   jsonb_build_object('perfil', 'ESTOQUE', 'prioridade', 'ALTA', 'sla', 'DIVERGENCIA',
                      'acao', 'Conferir a NF-e e dar entrada pelo modulo de recebimento'),
   'ASSISTIDO', 20)
  ) AS novo(codigo, nome, descricao, evento, condicao, acao, parametros,
            nivel, prioridade)
 WHERE NOT EXISTS (
   SELECT 1 FROM automacao_regras r WHERE upper(r.codigo) = upper(novo.codigo));
