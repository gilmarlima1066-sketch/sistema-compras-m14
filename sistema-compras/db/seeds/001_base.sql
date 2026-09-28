-- =============================================================================
-- 001_base.sql (seed)  |  Dados estruturais do sistema. Idempotente.
-- =============================================================================

-- ---------------------------------------------------------------- perfis ----
INSERT INTO perfis (nome, descricao) VALUES
  ('ADMIN',          'Administrador do sistema, acesso total'),
  ('GESTOR_COMPRAS', 'Gestor de compras: aprova, negocia e acompanha indicadores'),
  ('COMPRADOR',      'Comprador: cotacoes, negociacao e ordens de compra'),
  ('ESTOQUE',        'Operacao de estoque: movimentacoes, recebimento e inventario'),
  ('QUALIDADE',      'Inspecao de recebimento e nao conformidades'),
  ('FINANCEIRO',     'Condicoes de pagamento e compromissos de compra'),
  ('COMERCIAL',      'Consulta de estoque, demanda e disponibilidade'),
  ('DIRETORIA',      'Visao executiva e aprovacao de alcada')
ON CONFLICT (nome) DO NOTHING;

-- ----------------------------------------------------------- permissoes ----
INSERT INTO permissoes (codigo, modulo, descricao)
SELECT m.modulo || '.' || a.acao, m.modulo,
       initcap(a.acao) || ' em ' || replace(m.modulo, '_', ' ')
  FROM (VALUES
        ('dashboard'), ('produtos'), ('fornecedores'), ('estoque'), ('demanda'),
        ('compras'), ('cotacoes'), ('ordens_compra'), ('entregas'), ('recebimentos'),
        ('qualidade'), ('financeiro'), ('indicadores'), ('alertas'),
        ('usuarios'), ('auditoria'), ('configuracoes')
       ) AS m(modulo)
 CROSS JOIN (VALUES ('ler'), ('criar'), ('editar'), ('excluir')) AS a(acao)
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO permissoes (codigo, modulo, descricao) VALUES
  ('estoque.movimentar',     'estoque',       'Registrar movimentacoes de estoque'),
  ('ordens_compra.aprovar',  'ordens_compra', 'Aprovar ordens de compra'),
  ('cotacoes.negociar',      'cotacoes',      'Registrar rodadas de negociacao'),
  ('recebimentos.conferir',  'recebimentos',  'Conferir e finalizar recebimentos'),
  ('qualidade.inspecionar',  'qualidade',     'Registrar inspecoes de qualidade')
ON CONFLICT (codigo) DO NOTHING;

-- ------------------------------------------------- vinculo perfil x permissao
-- ADMIN: acesso total
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, p.id FROM perfis pf CROSS JOIN permissoes p WHERE pf.nome = 'ADMIN'
ON CONFLICT DO NOTHING;

-- DIRETORIA: leitura de tudo + aprovacao de OC
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, p.id FROM perfis pf JOIN permissoes p
    ON p.codigo LIKE '%.ler' OR p.codigo = 'ordens_compra.aprovar'
 WHERE pf.nome = 'DIRETORIA'
ON CONFLICT DO NOTHING;

-- GESTOR_COMPRAS
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, p.id FROM perfis pf JOIN permissoes p
    ON p.modulo IN ('dashboard','produtos','fornecedores','demanda','compras',
                    'cotacoes','ordens_compra','indicadores','alertas')
    OR p.codigo IN ('estoque.ler','entregas.ler','entregas.editar','recebimentos.ler',
                    'qualidade.ler','financeiro.ler','auditoria.ler')
 WHERE pf.nome = 'GESTOR_COMPRAS'
ON CONFLICT DO NOTHING;

-- COMPRADOR
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, p.id FROM perfis pf JOIN permissoes p
    ON p.codigo IN (
       'dashboard.ler','produtos.ler','produtos.criar','produtos.editar',
       'fornecedores.ler','fornecedores.criar','fornecedores.editar',
       'estoque.ler','demanda.ler','indicadores.ler','alertas.ler','alertas.editar',
       'compras.ler','compras.criar','compras.editar',
       'cotacoes.ler','cotacoes.criar','cotacoes.editar','cotacoes.negociar',
       'ordens_compra.ler','ordens_compra.criar','ordens_compra.editar',
       'entregas.ler','entregas.editar','recebimentos.ler')
 WHERE pf.nome = 'COMPRADOR'
ON CONFLICT DO NOTHING;

-- ESTOQUE
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, p.id FROM perfis pf JOIN permissoes p
    ON p.codigo IN (
       'dashboard.ler','produtos.ler','estoque.ler','estoque.editar','estoque.movimentar',
       'recebimentos.ler','recebimentos.criar','recebimentos.editar','recebimentos.conferir',
       'entregas.ler','entregas.editar','alertas.ler','indicadores.ler')
 WHERE pf.nome = 'ESTOQUE'
ON CONFLICT DO NOTHING;

-- QUALIDADE
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, p.id FROM perfis pf JOIN permissoes p
    ON p.modulo = 'qualidade'
    OR p.codigo IN ('dashboard.ler','produtos.ler','fornecedores.ler','estoque.ler',
                    'recebimentos.ler','alertas.ler','alertas.editar','indicadores.ler')
 WHERE pf.nome = 'QUALIDADE'
ON CONFLICT DO NOTHING;

-- FINANCEIRO
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, p.id FROM perfis pf JOIN permissoes p
    ON p.modulo = 'financeiro'
    OR p.codigo IN ('dashboard.ler','fornecedores.ler','ordens_compra.ler','indicadores.ler')
 WHERE pf.nome = 'FINANCEIRO'
ON CONFLICT DO NOTHING;

-- COMERCIAL
INSERT INTO perfil_permissoes (perfil_id, permissao_id)
SELECT pf.id, p.id FROM perfis pf JOIN permissoes p
    ON p.codigo IN ('dashboard.ler','produtos.ler','estoque.ler','demanda.ler','indicadores.ler')
 WHERE pf.nome = 'COMERCIAL'
ON CONFLICT DO NOTHING;

-- -------------------------------------------------------------- unidades ----
INSERT INTO unidades (codigo, nome, fator_conversao_base) VALUES
  ('UN',  'Unidade',  1),
  ('KG',  'Quilograma', 1),
  ('G',   'Grama',    0.001),
  ('TON', 'Tonelada', 1000),
  ('CX',  'Caixa',    1),
  ('PCT', 'Pacote',   1),
  ('FD',  'Fardo',    1),
  ('SC',  'Saco',     1),
  ('L',   'Litro',    1),
  ('ML',  'Mililitro', 0.001)
ON CONFLICT (codigo) DO NOTHING;

-- -------------------------------------------------- condicoes de pagamento ---
INSERT INTO condicoes_pagamento (nome, dias, descricao) VALUES
  ('A vista', 0,  'Pagamento no ato'),
  ('7 dias',  7,  'Pagamento em 7 dias'),
  ('14 dias', 14, 'Pagamento em 14 dias'),
  ('21 dias', 21, 'Pagamento em 21 dias'),
  ('28 dias', 28, 'Pagamento em 28 dias'),
  ('30 dias', 30, 'Pagamento em 30 dias'),
  ('45 dias', 45, 'Pagamento em 45 dias'),
  ('60 dias', 60, 'Pagamento em 60 dias')
ON CONFLICT (nome) DO NOTHING;

-- --------------------------------------------------------- configuracoes ----
INSERT INTO configuracoes (chave, valor, tipo, grupo, descricao) VALUES
  ('estoque.permitir_negativo',                'false', 'BOOLEANO', 'estoque',
   'Permite que movimentacoes deixem o saldo negativo'),
  ('estoque.permitir_entrada_lote_vencido',    'false', 'BOOLEANO', 'estoque',
   'Permite dar entrada em lote com validade expirada'),
  ('recebimento.tolerancia_excesso_percentual','5',     'NUMERO',   'recebimento',
   'Percentual aceito acima da quantidade pedida no recebimento'),
  ('qualidade.dias_alerta_validade',           '30',    'NUMERO',   'qualidade',
   'Dias de antecedencia para alertar validade proxima'),
  ('abc.limite_a',                             '80',    'NUMERO',   'classificacao',
   'Percentual acumulado de faturamento da classe A'),
  ('abc.limite_b',                             '95',    'NUMERO',   'classificacao',
   'Percentual acumulado de faturamento ate a classe B'),
  ('xyz.limite_x',                             '0.5',   'NUMERO',   'classificacao',
   'Coeficiente de variacao maximo da classe X'),
  ('xyz.limite_y',                             '1.0',   'NUMERO',   'classificacao',
   'Coeficiente de variacao maximo da classe Y'),
  ('compras.nivel_servico_padrao',             '95',    'NUMERO',   'compras',
   'Nivel de servico usado no calculo de estoque de seguranca'),
  ('compras.horizonte_planejamento_dias',      '60',    'NUMERO',   'compras',
   'Horizonte padrao do planejamento de compras'),
  ('compras.valor_limite_aprovacao_comprador', '20000', 'NUMERO',   'compras',
   'Valor de OC acima do qual e exigida aprovacao do gestor'),
  ('forecast.metodo_padrao',                   'MEDIA_MOVEL', 'STRING', 'forecast',
   'Metodo padrao de previsao de demanda'),
  ('forecast.periodos_media_movel',            '3',     'NUMERO',   'forecast',
   'Quantidade de periodos da media movel'),
  ('fornecedor.peso_otif',                     '30',    'NUMERO',   'fornecedor',
   'Peso do OTIF no score do fornecedor'),
  ('fornecedor.peso_qualidade',                '30',    'NUMERO',   'fornecedor',
   'Peso da qualidade no score do fornecedor'),
  ('fornecedor.peso_preco',                    '20',    'NUMERO',   'fornecedor',
   'Peso do preco no score do fornecedor'),
  ('fornecedor.peso_atendimento',              '10',    'NUMERO',   'fornecedor',
   'Peso do atendimento no score do fornecedor'),
  ('fornecedor.peso_flexibilidade',            '10',    'NUMERO',   'fornecedor',
   'Peso da flexibilidade no score do fornecedor'),
  ('estoque.dias_sem_giro_alerta',             '90',    'NUMERO',   'estoque',
   'Dias sem movimentacao para considerar estoque parado')
ON CONFLICT (chave) DO NOTHING;
