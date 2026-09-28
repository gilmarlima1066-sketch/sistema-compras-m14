-- =============================================================================
-- 009_triggers.sql  |  Regras protegidas pelo banco
-- Principio: o banco garante o que nunca pode ser violado (integridade e
-- historico). Regras complexas (forecast, cotacao, IA) ficam no service layer.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. updated_at automatico em toda tabela que possua a coluna
-- -----------------------------------------------------------------------------
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name = c.table_name AND t.table_schema = c.table_schema
     WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
       AND t.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I
         FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at()', r.table_name);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 2. created_by / updated_by automaticos a partir da sessao
-- -----------------------------------------------------------------------------
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'created_by'
     INTERSECT
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'updated_by'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_autoria BEFORE INSERT OR UPDATE ON %1$I
         FOR EACH ROW EXECUTE FUNCTION fn_set_autoria()', r.table_name);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Auditoria das alteracoes criticas
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r TEXT;
  tabelas TEXT[] := ARRAY[
    'usuarios','perfis','perfil_permissoes','configuracoes',
    'produtos','fornecedores','produto_fornecedor','parametros_estoque',
    'lotes','locais',  -- saldo de estoque nao entra: a razao completa esta em movimentacoes_estoque
    'necessidades_compra','cotacoes','cotacao_itens','negociacoes',
    'ordens_compra','ordem_compra_itens',
    'entregas','recebimentos','recebimento_itens',
    'inspecoes_qualidade','nao_conformidades'];
BEGIN
  FOREACH r IN ARRAY tabelas LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_auditoria AFTER INSERT OR UPDATE OR DELETE ON %1$I
         FOR EACH ROW EXECUTE FUNCTION fn_auditoria()', r);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Coerencia categoria x subcategoria no produto
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_validar_subcategoria_produto() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_categoria BIGINT;
BEGIN
  IF NEW.subcategoria_id IS NULL THEN RETURN NEW; END IF;
  SELECT categoria_id INTO v_categoria FROM subcategorias WHERE id = NEW.subcategoria_id;
  IF v_categoria IS DISTINCT FROM NEW.categoria_id THEN
    RAISE EXCEPTION 'Subcategoria % nao pertence a categoria % informada no produto.',
      NEW.subcategoria_id, NEW.categoria_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_produtos_valida_subcategoria
  BEFORE INSERT OR UPDATE OF categoria_id, subcategoria_id ON produtos
  FOR EACH ROW EXECUTE FUNCTION fn_validar_subcategoria_produto();

-- -----------------------------------------------------------------------------
-- 5. Lote: bloqueio de entrada vencida e marcacao automatica de vencimento
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_validar_lote() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     AND NEW.data_validade IS NOT NULL
     AND NEW.data_validade < CURRENT_DATE
     AND NOT fn_config_bool('estoque.permitir_entrada_lote_vencido', FALSE) THEN
    RAISE EXCEPTION 'Lote % do produto % esta vencido em % e nao pode ser recebido.',
      NEW.numero_lote, NEW.produto_id, NEW.data_validade
      USING ERRCODE = 'check_violation',
            HINT = 'Habilite a configuracao estoque.permitir_entrada_lote_vencido para excecoes autorizadas.';
  END IF;

  IF NEW.data_validade IS NOT NULL AND NEW.data_validade < CURRENT_DATE
     AND NEW.status = 'DISPONIVEL' THEN
    NEW.status := 'VENCIDO';
  END IF;

  IF NEW.quantidade_atual = 0 AND NEW.status = 'DISPONIVEL' AND TG_OP = 'UPDATE'
     AND OLD.quantidade_atual > 0 THEN
    NEW.status := 'CONSUMIDO';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_lotes_validacao
  BEFORE INSERT OR UPDATE ON lotes
  FOR EACH ROW EXECUTE FUNCTION fn_validar_lote();

-- -----------------------------------------------------------------------------
-- 6. Movimentacao de estoque -> atualiza saldo e lote (transacional)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_aplicar_movimentacao_estoque() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_sinal SMALLINT := fn_sinal_movimentacao(NEW.tipo_movimentacao);
  v_delta NUMERIC(14,3);
  v_saldo NUMERIC(14,3);
  v_codigo TEXT;
BEGIN
  -- INVENTARIO usa o sinal da propria quantidade (diferenca apurada na contagem)
  v_delta := CASE WHEN v_sinal = 0 THEN NEW.quantidade ELSE v_sinal * NEW.quantidade END;

  INSERT INTO estoques (produto_id, local_id, quantidade_fisica, ultima_entrada, ultima_saida)
  VALUES (NEW.produto_id, NEW.local_id, v_delta,
          CASE WHEN v_delta > 0 THEN NEW.created_at END,
          CASE WHEN v_delta < 0 THEN NEW.created_at END)
  ON CONFLICT (produto_id, local_id) DO UPDATE
     SET quantidade_fisica = estoques.quantidade_fisica + v_delta,
         ultima_entrada = CASE WHEN v_delta > 0 THEN EXCLUDED.ultima_entrada ELSE estoques.ultima_entrada END,
         ultima_saida   = CASE WHEN v_delta < 0 THEN EXCLUDED.ultima_saida   ELSE estoques.ultima_saida   END,
         updated_at = now()
  RETURNING quantidade_fisica INTO v_saldo;

  IF v_saldo < 0 AND NOT fn_config_bool('estoque.permitir_negativo', FALSE) THEN
    SELECT codigo INTO v_codigo FROM produtos WHERE id = NEW.produto_id;
    RAISE EXCEPTION 'Movimentacao gera estoque negativo (%) para o produto % no local %.',
      v_saldo, COALESCE(v_codigo, NEW.produto_id::TEXT), NEW.local_id
      USING ERRCODE = 'check_violation',
            HINT = 'Ajuste a quantidade ou habilite estoque.permitir_negativo.';
  END IF;

  IF NEW.lote_id IS NOT NULL THEN
    UPDATE lotes
       SET quantidade_atual = quantidade_atual + v_delta,
           quantidade_inicial = CASE WHEN v_delta > 0 AND quantidade_inicial = 0
                                     THEN v_delta ELSE quantidade_inicial END
     WHERE id = NEW.lote_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_movimentacoes_aplica_estoque
  AFTER INSERT ON movimentacoes_estoque
  FOR EACH ROW EXECUTE FUNCTION fn_aplicar_movimentacao_estoque();

-- razao de estoque e append-only: estorno se faz com movimentacao inversa
CREATE TRIGGER trg_movimentacoes_append_only
  BEFORE UPDATE OR DELETE ON movimentacoes_estoque
  FOR EACH ROW EXECUTE FUNCTION fn_bloquear_alteracao();

-- -----------------------------------------------------------------------------
-- 7. Historico de preco do par produto x fornecedor
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_preco_anterior_produto_fornecedor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.preco_atual IS DISTINCT FROM OLD.preco_atual THEN
    NEW.preco_anterior := OLD.preco_atual;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pf_preco_anterior
  BEFORE UPDATE OF preco_atual ON produto_fornecedor
  FOR EACH ROW EXECUTE FUNCTION fn_preco_anterior_produto_fornecedor();

CREATE OR REPLACE FUNCTION fn_registrar_historico_preco() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.preco_atual IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.preco_atual IS NOT DISTINCT FROM OLD.preco_atual THEN
    RETURN NEW;
  END IF;

  INSERT INTO historico_precos (
    produto_id, fornecedor_id, data, preco_unitario, frete,
    custo_efetivo, moeda, origem, usuario_id)
  VALUES (
    NEW.produto_id, NEW.fornecedor_id, CURRENT_DATE, NEW.preco_atual,
    COALESCE(NEW.frete_estimado, 0),
    NEW.preco_atual + COALESCE(NEW.frete_estimado, 0),
    NEW.moeda, 'produto_fornecedor', fn_usuario_sessao());

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pf_historico_preco
  AFTER INSERT OR UPDATE OF preco_atual ON produto_fornecedor
  FOR EACH ROW EXECUTE FUNCTION fn_registrar_historico_preco();

-- -----------------------------------------------------------------------------
-- 8. Tolerancia de excesso no recebimento (parametrizavel)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_validar_quantidade_recebida() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tolerancia NUMERIC := fn_config_num('recebimento.tolerancia_excesso_percentual', 0);
  v_limite NUMERIC;
BEGIN
  IF NEW.quantidade_pedida IS NULL OR NEW.quantidade_pedida = 0 THEN RETURN NEW; END IF;
  v_limite := NEW.quantidade_pedida * (1 + v_tolerancia / 100.0);
  IF NEW.quantidade_recebida > v_limite THEN
    RAISE EXCEPTION 'Quantidade recebida (%) excede o pedido (%) alem da tolerancia de %%%.',
      NEW.quantidade_recebida, NEW.quantidade_pedida, v_tolerancia
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_receb_item_valida_quantidade
  BEFORE INSERT OR UPDATE ON recebimento_itens
  FOR EACH ROW EXECUTE FUNCTION fn_validar_quantidade_recebida();

-- -----------------------------------------------------------------------------
-- 9. Ordem de compra: quantidade recebida nunca ultrapassa o pedido + tolerancia
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_validar_oc_item_recebido() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tolerancia NUMERIC := fn_config_num('recebimento.tolerancia_excesso_percentual', 0);
BEGIN
  IF NEW.quantidade_recebida > NEW.quantidade_pedida * (1 + v_tolerancia / 100.0) THEN
    RAISE EXCEPTION 'Recebimento acumulado (%) excede a quantidade pedida (%) do item da OC.',
      NEW.quantidade_recebida, NEW.quantidade_pedida USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_oc_item_valida_recebido
  BEFORE UPDATE OF quantidade_recebida ON ordem_compra_itens
  FOR EACH ROW EXECUTE FUNCTION fn_validar_oc_item_recebido();

COMMIT;
