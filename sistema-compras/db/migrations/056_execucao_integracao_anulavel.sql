-- ---------------------------------------------------------------------------
-- 056 - A execucao de integracao aceita ter a referencia anulada
--
-- Mesma contradicao que a migration 045 corrigiu no modulo 13, repetida aqui:
-- `integracao_execucoes` tem gatilho que proibe alterar execucao ja encerrada, e
-- ao mesmo tempo chaves estrangeiras `ON DELETE SET NULL` apontando para
-- `integracoes` e `usuarios`. O SET NULL e um UPDATE, e o gatilho o rejeitava.
--
-- Efeito pratico: **nenhuma integracao podia mais ser apagada** depois de ter
-- uma execucao, e **nenhum usuario podia ser removido** depois de disparar uma
-- sincronizacao. O erro so aparecia no DELETE, com uma mensagem sobre "execucao
-- encerrada" que nao explicava nada a quem tentava excluir outra coisa.
--
-- A correcao segue o que ja foi decidido na 045 e na 046: a referencia pode ser
-- ANULADA, e nada mais. Trocar uma referencia por OUTRA continua proibido, que
-- seria reescrever de qual integracao a execucao foi. E o historico nao perde
-- sentido ao perder o id, porque `integracao_codigo` guarda o codigo em texto
-- desde a criacao - foi exatamente para isso que ele existe.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_execucao_integracao_protegida() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  dias   integer;
  antes  jsonb;
  depois jsonb;
  coluna text;
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

  -- Anulacao de referencia, feita pelo ON DELETE SET NULL do pai: permitida, e
  -- verificada coluna a coluna. Se alguma OUTRA coluna mudou junto, as copias
  -- abaixo continuam diferentes e a regra seguinte recusa - entao esta excecao
  -- nao vira porta para reescrever historico "de carona".
  antes  := to_jsonb(OLD);
  depois := to_jsonb(NEW);

  FOREACH coluna IN ARRAY ARRAY['integracao_id', 'usuario_id'] LOOP
    IF depois -> coluna = 'null'::jsonb AND antes -> coluna <> 'null'::jsonb THEN
      antes  := antes  - coluna;
      depois := depois - coluna;
    END IF;
  END LOOP;

  IF antes = depois THEN
    RETURN NEW;   -- so houve anulacao de referencia
  END IF;

  IF OLD.status IN ('CONCLUIDA', 'CONCLUIDA_COM_ERROS', 'FALHOU', 'CANCELADA')
     AND OLD.concluido_em IS NOT NULL THEN
    RAISE EXCEPTION
      'A execucao % ja foi encerrada como % e nao pode ser alterada',
      OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

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
