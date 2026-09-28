-- ---------------------------------------------------------------------------
-- 052 - `integracao_execucoes` tem ciclo de vida: o gatilho de imutabilidade
--       estava no lugar errado
--
-- Erro meu na migration 050. Copiei a protecao de `automacao_execucoes` (modulo
-- 13) sem notar que as duas tabelas guardam coisas diferentes:
--
--   automacao_execucoes  -> a linha nasce PRONTA. A acao rodou, deu certo ou
--                           errado, e o registro descreve um fato encerrado.
--                           Congelar faz todo sentido.
--
--   integracao_execucoes -> a linha nasce EXECUTANDO e precisa ser FECHADA
--                           quando a sincronizacao termina, com duracao,
--                           contagens e status final. Congelar impede o
--                           fechamento: toda execucao ficaria eternamente
--                           "executando", e o painel mostraria integracoes
--                           travadas que na verdade concluiram.
--
-- Encontrado na primeira importacao real do arquivo do ERP, que e exatamente
-- onde um erro desses tem de aparecer.
--
-- A protecao continua existindo, so que na forma certa para esta tabela: depois
-- de CONCLUIDA a execucao nao muda mais, e o que identifica a execucao
-- (integracao, tipo, direcao, inicio, correlacao) nao muda nunca. O que o
-- fechamento precisa escrever - status, fim, duracao, contagens, resumo, erro -
-- fica liberado enquanto ela estiver aberta.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_integracao_execucoes_imutavel ON integracao_execucoes;

CREATE OR REPLACE FUNCTION fn_execucao_integracao_protegida() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  dias integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    dias := coalesce((SELECT valor::integer FROM configuracoes
                       WHERE chave = 'integracao.retencao_logs_dias' AND ativo), 180);
    IF OLD.created_at < now() - make_interval(days => dias) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION
      'Execucao de integracao com menos de % dias nao pode ser apagada', dias
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Execucao ja encerrada e historico: nao se reabre nem se reescreve.
  IF OLD.status IN ('CONCLUIDA', 'CONCLUIDA_COM_ERROS', 'FALHOU', 'CANCELADA')
     AND OLD.concluido_em IS NOT NULL THEN
    RAISE EXCEPTION
      'A execucao % ja foi encerrada como % e nao pode ser alterada',
      OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Enquanto aberta, a identidade e imutavel; so o fechamento pode escrever.
  IF (NEW.integracao_codigo, NEW.tipo, NEW.direcao, NEW.iniciado_em,
      NEW.correlation_id, NEW.disparado_por, NEW.created_at)
     IS DISTINCT FROM
     (OLD.integracao_codigo, OLD.tipo, OLD.direcao, OLD.iniciado_em,
      OLD.correlation_id, OLD.disparado_por, OLD.created_at)
  THEN
    RAISE EXCEPTION
      'A identidade da execucao % nao pode ser alterada depois de criada', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

COMMENT ON FUNCTION fn_execucao_integracao_protegida() IS
  'Execucao de integracao: aberta pode ser fechada, encerrada nao muda mais, '
  'identidade nunca muda, exclusao so fora da retencao.';

CREATE TRIGGER trg_integracao_execucoes_protegida
  BEFORE UPDATE OR DELETE ON integracao_execucoes
  FOR EACH ROW EXECUTE FUNCTION fn_execucao_integracao_protegida();
