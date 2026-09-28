-- ---------------------------------------------------------------------------
-- 045 - Historico imutavel: correcao de uma contradicao encontrada em teste
--
-- As tabelas de historico append-only (ia_execucoes, ia_feedback,
-- automacao_execucoes, webhooks_recebidos) tinham um gatilho que proibia
-- QUALQUER update ou delete, e ao mesmo tempo chaves estrangeiras declaradas
-- ON DELETE SET NULL. As duas coisas nao podem coexistir: o SET NULL e um
-- UPDATE, e o gatilho o rejeitava. O efeito pratico era grave e silencioso:
--
--   * nenhum evento, item de fila ou regra podia mais ser apagado depois de
--     ter uma execucao - nem por um DELETE autorizado, nem pelo expurgo;
--   * a retencao das secoes 43 e 44 (automacao.retencao_eventos_dias = 180,
--     ia.retencao_historico_dias = 365) era impossivel de aplicar;
--   * remover um usuario de verdade falharia com erro de gatilho.
--
-- A correcao mantem a garantia que interessa - ninguem reescreve historico -
-- abrindo exatamente duas excecoes, ambas verificaveis pelo proprio banco:
--
--   1. A referencia pode ser ANULADA (ir para NULL) quando o pai e apagado.
--      Trocar uma referencia por OUTRA continua proibido, que seria reescrever
--      a que regra ou que evento originou a execucao.
--   2. O registro pode ser apagado quando ja passou do periodo de retencao,
--      lido da propria tabela de configuracoes. Assim o expurgo nao precisa de
--      privilegio especial nem de desligar gatilho, e o limite fica auditavel
--      em vez de escondido no codigo do job.
--
-- Uma funcao unica substitui as quatro, porque a regra e a mesma nas quatro
-- tabelas e quatro copias divergiriam na primeira correcao.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_historico_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  dias    integer;
  antes   jsonb;
  depois  jsonb;
  coluna  text;
BEGIN
  dias := coalesce(
    (SELECT valor::integer FROM configuracoes
      WHERE chave = TG_ARGV[0] AND ativo), 365);

  IF TG_OP = 'DELETE' THEN
    IF OLD.created_at < now() - make_interval(days => dias) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION
      '% e historico imutavel: registros com menos de % dias nao podem ser apagados',
      TG_TABLE_NAME, dias
      USING ERRCODE = 'restrict_violation';
  END IF;

  antes  := to_jsonb(OLD);
  depois := to_jsonb(NEW);

  -- Anulacao de referencia e permitida; substituicao nao. Comparar o jsonb
  -- inteiro no fim garante que nenhuma outra coluna passou escondida junto.
  FOREACH coluna IN ARRAY TG_ARGV[1:] LOOP
    IF depois ? coluna AND depois -> coluna = 'null'::jsonb THEN
      antes  := antes  - coluna;
      depois := depois - coluna;
    END IF;
  END LOOP;

  IF antes <> depois THEN
    RAISE EXCEPTION
      '% e historico imutavel: o registro nao pode ser alterado',
      TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

COMMENT ON FUNCTION fn_historico_imutavel() IS
  'Historico append-only. Argumento 1: chave de configuracao com os dias de '
  'retencao. Argumentos seguintes: colunas de referencia que podem ser '
  'anuladas por ON DELETE SET NULL.';

-- ---------------------------------------------------------------------------
-- Troca dos gatilhos
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_execucoes_imutavel ON automacao_execucoes;
CREATE TRIGGER trg_execucoes_imutavel
  BEFORE UPDATE OR DELETE ON automacao_execucoes
  FOR EACH ROW EXECUTE FUNCTION fn_historico_imutavel(
    'automacao.retencao_eventos_dias',
    'fila_id', 'evento_id', 'regra_id', 'usuario_id');

DROP TRIGGER IF EXISTS trg_webhooks_imutavel ON webhooks_recebidos;
CREATE TRIGGER trg_webhooks_imutavel
  BEFORE UPDATE OR DELETE ON webhooks_recebidos
  FOR EACH ROW EXECUTE FUNCTION fn_historico_imutavel(
    'automacao.retencao_eventos_dias',
    'evento_id');

DROP TRIGGER IF EXISTS trg_ia_execucoes_imutavel ON ia_execucoes;
CREATE TRIGGER trg_ia_execucoes_imutavel
  BEFORE UPDATE OR DELETE ON ia_execucoes
  FOR EACH ROW EXECUTE FUNCTION fn_historico_imutavel(
    'ia.retencao_historico_dias',
    'usuario_id');

DROP TRIGGER IF EXISTS trg_ia_feedback_imutavel ON ia_feedback;
CREATE TRIGGER trg_ia_feedback_imutavel
  BEFORE UPDATE OR DELETE ON ia_feedback
  FOR EACH ROW EXECUTE FUNCTION fn_historico_imutavel(
    'ia.retencao_historico_dias',
    'usuario_id');

-- As funcoes antigas ficam sem uso. Removidas para nao induzirem a erro quem
-- for ler o schema depois.
DROP FUNCTION IF EXISTS fn_execucao_imutavel();
DROP FUNCTION IF EXISTS fn_webhook_imutavel();
DROP FUNCTION IF EXISTS fn_ia_execucao_imutavel();
DROP FUNCTION IF EXISTS fn_ia_feedback_imutavel();
