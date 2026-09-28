-- =============================================================================
-- 002_dados_teste.sql (seed)  |  MASSA DE TESTE - NAO USAR EM PRODUCAO
-- Todos os registros sao ficticios e identificados com o prefixo TST- / [TESTE].
-- Idempotente: se ja existir produto TST-, o bloco inteiro e ignorado.
-- =============================================================================

DO $$
DECLARE
  v_admin        BIGINT;
  v_cat_graos    BIGINT;
  v_cat_secos    BIGINT;
  v_sub_arroz    BIGINT;
  v_sub_cereais  BIGINT;
  v_sub_castanha BIGINT;
  v_marca        BIGINT;
  v_un_kg        BIGINT;
  v_un_sc        BIGINT;
  v_un_cx        BIGINT;
  v_local_cd     BIGINT;
  v_local_arm    BIGINT;
  v_cond_28      BIGINT;
  v_forn         BIGINT[] := '{}';
  v_prod         BIGINT[] := '{}';
  v_lote         BIGINT;
  v_venda        BIGINT;
  v_oc           BIGINT;
  v_oc2          BIGINT;
  v_oc3          BIGINT;
  i              INT;
BEGIN
  IF EXISTS (SELECT 1 FROM produtos WHERE codigo LIKE 'TST-%') THEN
    RAISE NOTICE 'Dados de teste ja carregados. Nada a fazer.';
    RETURN;
  END IF;

  SELECT id INTO v_admin FROM usuarios ORDER BY id LIMIT 1;
  SELECT id INTO v_un_kg FROM unidades WHERE codigo = 'KG';
  SELECT id INTO v_un_sc FROM unidades WHERE codigo = 'SC';
  SELECT id INTO v_un_cx FROM unidades WHERE codigo = 'CX';
  SELECT id INTO v_cond_28 FROM condicoes_pagamento WHERE dias = 28;

  -- ------------------------------------------------------------ categorias --
  INSERT INTO categorias (nome, descricao) VALUES
    ('Graos e Cereais [TESTE]', 'Arroz, feijao, aveia e similares'),
    ('Frutas Secas e Oleaginosas [TESTE]', 'Castanhas, nozes e frutas desidratadas');
  SELECT id INTO v_cat_graos FROM categorias WHERE nome = 'Graos e Cereais [TESTE]';
  SELECT id INTO v_cat_secos FROM categorias WHERE nome = 'Frutas Secas e Oleaginosas [TESTE]';

  INSERT INTO subcategorias (categoria_id, nome) VALUES
    (v_cat_graos, 'Arroz e Feijao [TESTE]'),
    (v_cat_graos, 'Cereais Integrais [TESTE]'),
    (v_cat_secos, 'Castanhas e Nozes [TESTE]');
  SELECT id INTO v_sub_arroz    FROM subcategorias WHERE nome = 'Arroz e Feijao [TESTE]';
  SELECT id INTO v_sub_cereais  FROM subcategorias WHERE nome = 'Cereais Integrais [TESTE]';
  SELECT id INTO v_sub_castanha FROM subcategorias WHERE nome = 'Castanhas e Nozes [TESTE]';

  INSERT INTO marcas (nome, descricao) VALUES ('Marca Propria [TESTE]', 'Marca ficticia')
  RETURNING id INTO v_marca;

  -- ---------------------------------------------------------------- locais --
  INSERT INTO locais (codigo, nome, tipo) VALUES
    ('TST-CD01',  'Centro de Distribuicao SP [TESTE]', 'CD'),
    ('TST-ARM01', 'Armazem Secundario [TESTE]',        'ARMAZEM');
  SELECT id INTO v_local_cd  FROM locais WHERE codigo = 'TST-CD01';
  SELECT id INTO v_local_arm FROM locais WHERE codigo = 'TST-ARM01';

  -- ---------------------------------------------------------- fornecedores --
  INSERT INTO fornecedores (razao_social, nome_fantasia, cnpj, email, cidade, estado,
                            tipo_fornecedor, origem_fornecedor, prazo_medio_pagamento,
                            lead_time_padrao_dias, observacoes)
  VALUES
    ('Cerealista Vale Verde LTDA [TESTE]',  'Vale Verde',   '11111111000101',
     'comercial@valeverde.teste', 'Sorriso', 'MT', 'PRODUTOR', 'NACIONAL', 28, 12, '[DADOS DE TESTE]'),
    ('Distribuidora Grao Nobre SA [TESTE]', 'Grao Nobre',   '22222222000102',
     'vendas@graonobre.teste', 'Campinas', 'SP', 'DISTRIBUIDOR', 'NACIONAL', 30, 7, '[DADOS DE TESTE]'),
    ('Beneficiadora Castanha Real [TESTE]', 'Castanha Real', '33333333000103',
     'contato@castanharreal.teste', 'Fortaleza', 'CE', 'FABRICANTE', 'NACIONAL', 21, 15, '[DADOS DE TESTE]'),
    ('Dried Fruits Anatolia Ltd [TESTE]',   'Anatolia',     NULL,
     'export@anatolia.teste', 'Izmir', 'Izmir', 'IMPORTADOR', 'INTERNACIONAL', 60, 55, '[DADOS DE TESTE]'),
    ('Andes Nuts Export SpA [TESTE]',       'Andes Nuts',   NULL,
     'sales@andesnuts.teste', 'Santiago', 'RM', 'IMPORTADOR', 'INTERNACIONAL', 45, 40, '[DADOS DE TESTE]');

  SELECT array_agg(id ORDER BY id) INTO v_forn FROM fornecedores WHERE razao_social LIKE '%[TESTE]%';

  -- -------------------------------------------------------------- produtos --
  INSERT INTO produtos (codigo, ean, descricao, categoria_id, subcategoria_id, marca_id,
                        unidade_compra_id, unidade_estoque_id, unidade_venda_id,
                        peso, dias_validade, origem, produto_importado,
                        estoque_minimo, estoque_maximo, estoque_seguranca, ponto_pedido,
                        lead_time_padrao_dias, moq, multiplo_compra,
                        classificacao_abc, classificacao_xyz)
  VALUES
    ('TST-GR0001','7891000000011','Arroz Integral Tipo 1 - 30 kg [TESTE]', v_cat_graos, v_sub_arroz,   v_marca, v_un_sc, v_un_kg, v_un_kg, 30, 365, 'Mato Grosso', FALSE, 3000, 12000, 1500, 4500, 12, 1000, 500, 'A','X'),
    ('TST-GR0002','7891000000028','Feijao Carioca Tipo 1 - 30 kg [TESTE]', v_cat_graos, v_sub_arroz,   v_marca, v_un_sc, v_un_kg, v_un_kg, 30, 300, 'Parana',      FALSE, 2000,  9000, 1000, 3200, 10,  900, 300, 'A','Y'),
    ('TST-GR0003','7891000000035','Aveia em Flocos Finos - 25 kg [TESTE]', v_cat_graos, v_sub_cereais, v_marca, v_un_sc, v_un_kg, v_un_kg, 25, 270, 'Rio Grande do Sul', FALSE, 1200, 5000, 600, 1800, 14, 500, 250, 'B','X'),
    ('TST-GR0004','7891000000042','Quinoa em Grao Branca - 20 kg [TESTE]', v_cat_graos, v_sub_cereais, v_marca, v_un_sc, v_un_kg, v_un_kg, 20, 365, 'Peru',        TRUE,   400,  2000,  200,  600, 45, 400, 200, 'B','Z'),
    ('TST-OL0001','7891000000059','Castanha de Caju W2 - 10 kg [TESTE]',   v_cat_secos, v_sub_castanha, v_marca, v_un_cx, v_un_kg, v_un_kg, 10, 240, 'Ceara',       FALSE,  600,  3000,  300,  900, 15, 200, 100, 'A','Y'),
    ('TST-OL0002','7891000000066','Amendoa Crua Inteira - 10 kg [TESTE]',  v_cat_secos, v_sub_castanha, v_marca, v_un_cx, v_un_kg, v_un_kg, 10, 300, 'California',  TRUE,   500,  2500,  250,  800, 50, 500, 250, 'A','Z'),
    ('TST-OL0003','7891000000073','Nozes Chilenas Metades - 10 kg [TESTE]',v_cat_secos, v_sub_castanha, v_marca, v_un_cx, v_un_kg, v_un_kg, 10, 210, 'Chile',       TRUE,   300,  1500,  150,  450, 40, 300, 150, 'B','Z'),
    ('TST-FS0001','7891000000080','Uva Passa Escura sem Semente - 12,5 kg [TESTE]', v_cat_secos, NULL, v_marca, v_un_cx, v_un_kg, v_un_kg, 12.5, 300, 'Chile', TRUE, 400, 2000, 200, 600, 42, 250, 125, 'B','Y'),
    ('TST-FS0002','7891000000097','Damasco Turco Seco n.4 - 10 kg [TESTE]',v_cat_secos, NULL, v_marca, v_un_cx, v_un_kg, v_un_kg, 10, 270, 'Turquia', TRUE, 250, 1200, 120, 380, 55, 200, 100, 'C','Z'),
    ('TST-SE0001','7891000000103','Semente de Chia Preta - 25 kg [TESTE]', v_cat_graos, v_sub_cereais, v_marca, v_un_sc, v_un_kg, v_un_kg, 25, 365, 'Paraguai', TRUE, 300, 1500, 150, 450, 35, 250, 125, 'C','Y');

  SELECT array_agg(id ORDER BY id) INTO v_prod FROM produtos WHERE codigo LIKE 'TST-%';

  -- --------------------------------------------- vinculo produto/fornecedor --
  INSERT INTO produto_fornecedor (produto_id, fornecedor_id, codigo_produto_fornecedor,
                                  preco_atual, moeda, moq, multiplo_compra, lead_time_dias,
                                  prazo_pagamento_dias, frete_estimado, fornecedor_principal)
  VALUES
    (v_prod[1], v_forn[1], 'VV-ARZ-INT', 4.85, 'BRL', 1000, 500, 12, 28, 0.18, TRUE),
    (v_prod[1], v_forn[2], 'GN-1001',    5.05, 'BRL',  600, 300,  7, 30, 0.12, FALSE),
    (v_prod[2], v_forn[1], 'VV-FJ-CAR',  6.40, 'BRL',  900, 300, 10, 28, 0.18, TRUE),
    (v_prod[3], v_forn[2], 'GN-3007',    3.95, 'BRL',  500, 250, 14, 30, 0.10, TRUE),
    (v_prod[4], v_forn[2], 'GN-4410',   19.80, 'BRL',  400, 200, 45, 30, 0.22, TRUE),
    (v_prod[5], v_forn[3], 'CR-W2',     42.50, 'BRL',  200, 100, 15, 21, 0.30, TRUE),
    (v_prod[6], v_forn[5], 'AN-ALM-01',  7.90, 'USD',  500, 250, 50, 45, 0.55, TRUE),
    (v_prod[7], v_forn[5], 'AN-WAL-05',  9.40, 'USD',  300, 150, 40, 45, 0.55, TRUE),
    (v_prod[8], v_forn[4], 'AT-RAIS-12', 3.10, 'USD',  250, 125, 42, 60, 0.48, TRUE),
    (v_prod[9], v_forn[4], 'AT-APR-04',  5.60, 'USD',  200, 100, 55, 60, 0.48, TRUE),
    (v_prod[10],v_forn[2], 'GN-CHIA',   11.20, 'BRL',  250, 125, 35, 30, 0.15, TRUE);

  -- -------------------------------------------------- parametros de estoque --
  INSERT INTO parametros_estoque (produto_id, demanda_media_diaria, lead_time_dias,
                                  nivel_servico, estoque_seguranca, ponto_pedido,
                                  estoque_minimo, estoque_maximo, horizonte_planejamento_dias)
  SELECT p.id,
         CASE p.classificacao_abc WHEN 'A' THEN 180 WHEN 'B' THEN 60 ELSE 18 END,
         p.lead_time_padrao_dias, 95, p.estoque_seguranca, p.ponto_pedido,
         p.estoque_minimo, p.estoque_maximo, 60
    FROM produtos p WHERE p.codigo LIKE 'TST-%';

  -- ----------------------------------------------------------------- lotes --
  FOR i IN 1..array_length(v_prod, 1) LOOP
    INSERT INTO lotes (produto_id, numero_lote, data_fabricacao, data_validade,
                       fornecedor_id, status)
    VALUES (v_prod[i], 'L' || to_char(CURRENT_DATE, 'YYMM') || lpad(i::TEXT, 3, '0'),
            CURRENT_DATE - 30,
            CURRENT_DATE + (CASE WHEN i = 9 THEN 20 ELSE 150 + i * 10 END),
            (SELECT fornecedor_id FROM produto_fornecedor
              WHERE produto_id = v_prod[i] AND fornecedor_principal LIMIT 1),
            'DISPONIVEL');
  END LOOP;

  -- ------------------------------------ 20 movimentacoes (10 entradas/saidas)
  FOR i IN 1..10 LOOP
    SELECT id INTO v_lote FROM lotes WHERE produto_id = v_prod[i] LIMIT 1;

    INSERT INTO movimentacoes_estoque (produto_id, local_id, lote_id, tipo_movimentacao,
                                       quantidade, custo_unitario, documento_tipo,
                                       observacao, usuario_id)
    VALUES (v_prod[i], CASE WHEN i % 3 = 0 THEN v_local_arm ELSE v_local_cd END, v_lote,
            'ENTRADA_COMPRA',
            CASE WHEN i <= 3 THEN 6000 WHEN i <= 6 THEN 1500 ELSE 700 END,
            CASE WHEN i <= 3 THEN 5.00 WHEN i <= 6 THEN 30.00 ELSE 9.00 END,
            'RECEBIMENTO', '[TESTE] Entrada inicial de carga', v_admin);
  END LOOP;

  FOR i IN 1..10 LOOP
    SELECT id INTO v_lote FROM lotes WHERE produto_id = v_prod[i] LIMIT 1;

    INSERT INTO movimentacoes_estoque (produto_id, local_id, lote_id, tipo_movimentacao,
                                       quantidade, documento_tipo, observacao, usuario_id)
    VALUES (v_prod[i], CASE WHEN i % 3 = 0 THEN v_local_arm ELSE v_local_cd END, v_lote,
            (CASE WHEN i = 7 THEN 'PERDA' ELSE 'SAIDA_VENDA' END)::tipo_movimentacao_enum,
            -- produtos 1 e 2 saem quase todo o saldo: geram alerta de ruptura no painel
            CASE WHEN i <= 2 THEN 5900 WHEN i <= 6 THEN 900 ELSE 400 END,
            'VENDA', '[TESTE] Consumo do periodo', v_admin);
  END LOOP;

  -- ---------------------------------------------------------------- vendas --
  FOR i IN 1..10 LOOP
    INSERT INTO vendas (numero_documento, data_venda, canal, valor_total, status, origem_integracao)
    VALUES ('TST-NF' || lpad(i::TEXT, 5, '0'), CURRENT_DATE - (i * 3),
            CASE WHEN i % 2 = 0 THEN 'ATACADO' ELSE 'VAREJO' END,
            0, 'FATURADA', '[TESTE]')
    RETURNING id INTO v_venda;

    INSERT INTO itens_venda (venda_id, produto_id, quantidade, preco_unitario, valor_total)
    VALUES (v_venda, v_prod[i], 100 + i * 10, 8.50 + i, (100 + i * 10) * (8.50 + i));

    UPDATE vendas SET valor_total = (SELECT SUM(valor_total) FROM itens_venda WHERE venda_id = v_venda)
     WHERE id = v_venda;
  END LOOP;

  -- ------------------------------------------------------ ordens de compra --
  -- OC 1: recebida (historico)
  INSERT INTO ordens_compra (numero, fornecedor_id, data_emissao, data_prevista_entrega,
                             valor_produtos, valor_total, condicao_pagamento_id,
                             responsavel_id, aprovador_id, data_aprovacao, status, observacao)
  VALUES ('TST-OC0001', v_forn[1], CURRENT_DATE - 45, CURRENT_DATE - 30,
          29100, 29100, v_cond_28, v_admin, v_admin, now() - interval '44 days',
          'RECEBIDA', '[TESTE] Compra concluida')
  RETURNING id INTO v_oc;

  INSERT INTO ordem_compra_itens (ordem_compra_id, produto_id, quantidade_pedida,
                                  quantidade_confirmada, quantidade_recebida,
                                  preco_unitario, valor_total, data_prevista_entrega)
  VALUES (v_oc, v_prod[1], 6000, 6000, 6000, 4.85, 29100, CURRENT_DATE - 30);

  -- OC 2: em transito e atrasada
  INSERT INTO ordens_compra (numero, fornecedor_id, data_emissao, data_prevista_entrega,
                             valor_produtos, frete, valor_total, condicao_pagamento_id,
                             responsavel_id, aprovador_id, data_aprovacao, status, observacao)
  VALUES ('TST-OC0002', v_forn[3], CURRENT_DATE - 20, CURRENT_DATE - 4,
          38250, 950, 39200, v_cond_28, v_admin, v_admin, now() - interval '19 days',
          'EM_TRANSITO', '[TESTE] Carga em transito com atraso')
  RETURNING id INTO v_oc2;

  INSERT INTO ordem_compra_itens (ordem_compra_id, produto_id, quantidade_pedida,
                                  quantidade_confirmada, quantidade_recebida,
                                  preco_unitario, valor_total, data_prevista_entrega)
  VALUES (v_oc2, v_prod[5], 900, 900, 0, 42.50, 38250, CURRENT_DATE - 4);

  -- OC 3: aguardando aprovacao (importacao)
  INSERT INTO ordens_compra (numero, fornecedor_id, data_emissao, data_prevista_entrega,
                             valor_produtos, frete, impostos, valor_total, moeda,
                             condicao_pagamento_id, responsavel_id, status, observacao)
  VALUES ('TST-OC0003', v_forn[5], CURRENT_DATE - 2, CURRENT_DATE + 48,
          3950, 420, 690, 5060, 'USD', v_cond_28, v_admin,
          'AGUARDANDO_APROVACAO', '[TESTE] Importacao aguardando alcada')
  RETURNING id INTO v_oc3;

  INSERT INTO ordem_compra_itens (ordem_compra_id, produto_id, quantidade_pedida,
                                  preco_unitario, valor_total, data_prevista_entrega)
  VALUES (v_oc3, v_prod[6], 500, 7.90, 3950, CURRENT_DATE + 48);

  -- -------------------------------------------------------------- entregas --
  INSERT INTO entregas (ordem_compra_id, data_prevista, data_confirmada, data_real,
                        quantidade_prevista, quantidade_entregue, status, transportadora, observacao)
  VALUES
    (v_oc,  CURRENT_DATE - 30, CURRENT_DATE - 32, CURRENT_DATE - 29, 6000, 6000,
     'ENTREGUE', 'Transportadora Teste LTDA', '[TESTE] Entregue com 1 dia de atraso'),
    (v_oc2, CURRENT_DATE - 4,  CURRENT_DATE - 10, NULL, 900, NULL,
     'ATRASADA', 'Transportadora Teste LTDA', '[TESTE] Aguardando reprogramacao');

  -- --------------------------------------------------------------- alertas --
  INSERT INTO alertas (tipo, severidade, produto_id, ordem_compra_id, mensagem, status)
  VALUES
    ('RISCO_RUPTURA', 'CRITICA', v_prod[1], NULL,
     '[TESTE] Arroz Integral Tipo 1 com cobertura abaixo do lead time de reposicao', 'ABERTO'),
    ('PEDIDO_ATRASADO', 'ALTA', v_prod[5], v_oc2,
     '[TESTE] OC TST-OC0002 esta 4 dias atrasada em relacao a data prevista', 'ABERTO');

  RAISE NOTICE 'Massa de teste carregada: % produtos, % fornecedores.',
    array_length(v_prod, 1), array_length(v_forn, 1);
END $$;
