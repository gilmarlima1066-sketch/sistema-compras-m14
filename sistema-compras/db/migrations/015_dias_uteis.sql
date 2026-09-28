-- ===========================================================================
-- Dias uteis para o calculo de datas do planejamento (secao 14 do prompt 05).
--
-- Sabado, domingo e o que estiver em calendario_eventos como FERIADO ou
-- SEM_OPERACAO nao contam. O calendario e o mesmo do modulo 04, entao o
-- comprador cadastra o feriado uma vez e vale para os dois.
-- ===========================================================================

CREATE OR REPLACE FUNCTION fn_dia_sem_operacao(p_data DATE) RETURNS BOOLEAN AS $$
  SELECT EXTRACT(isodow FROM p_data) >= 6
      OR EXISTS (
           SELECT 1 FROM calendario_eventos c
            WHERE c.tipo IN ('FERIADO', 'SEM_OPERACAO')
              AND p_data BETWEEN c.data_inicio AND c.data_fim
              AND c.produto_id IS NULL
              AND c.categoria_id IS NULL
         );
$$ LANGUAGE sql STABLE;

-- Soma dias uteis a uma data. Dias negativos andam para tras, que e o caso da
-- data ideal do pedido (data necessaria menos o lead time).
CREATE OR REPLACE FUNCTION fn_somar_dias_uteis(p_data DATE, p_dias INTEGER)
RETURNS DATE AS $$
DECLARE
  v_data      DATE := p_data;
  v_restantes INTEGER := abs(p_dias);
  v_passo     INTEGER := CASE WHEN p_dias < 0 THEN -1 ELSE 1 END;
  v_guarda    INTEGER := 0;
BEGIN
  IF p_dias = 0 THEN RETURN p_data; END IF;

  WHILE v_restantes > 0 LOOP
    v_data := v_data + v_passo;
    IF NOT fn_dia_sem_operacao(v_data) THEN
      v_restantes := v_restantes - 1;
    END IF;

    -- Guarda contra calendario mal cadastrado que marque tudo como sem operacao.
    v_guarda := v_guarda + 1;
    IF v_guarda > abs(p_dias) * 7 + 400 THEN
      RAISE EXCEPTION 'Calendario sem dias uteis suficientes a partir de %. Revise os eventos de FERIADO e SEM_OPERACAO', p_data;
    END IF;
  END LOOP;

  RETURN v_data;
END;
$$ LANGUAGE plpgsql STABLE;

-- Aplica o modo configurado (corridos ou uteis) num unico ponto, para que
-- nenhum calculo do planejamento precise decidir isso por conta propria.
CREATE OR REPLACE FUNCTION fn_somar_prazo(p_data DATE, p_dias INTEGER, p_uteis BOOLEAN)
RETURNS DATE AS $$
  SELECT CASE WHEN p_uteis THEN fn_somar_dias_uteis(p_data, p_dias) ELSE p_data + p_dias END;
$$ LANGUAGE sql STABLE;

INSERT INTO configuracoes (chave, valor, tipo, grupo, descricao) VALUES
  ('planejamento.somar_seguranca_ao_alvo', 'false', 'BOOLEANO', 'planejamento',
   'Somar o estoque de seguranca por fora do estoque alvo. Com false (padrao) a seguranca ja esta dentro do alvo e nao e contada duas vezes')
ON CONFLICT (chave) DO NOTHING;
