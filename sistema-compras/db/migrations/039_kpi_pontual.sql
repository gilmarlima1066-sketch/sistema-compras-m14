-- =========================================================================
-- MODULO 11 - INDICADOR PONTUAL x INDICADOR DE PERIODO (secoes 11 e 54)
--
-- Nem todo indicador se refere a um periodo. "Produtos em ruptura" e a
-- posicao de AGORA: reapura-lo para marco de 2015 devolve o mesmo numero de
-- hoje, porque nao existe historico de posicao no banco - existe a posicao
-- atual.
--
-- Sem essa distincao, a curva de evolucao mensal desses indicadores sai
-- perfeitamente plana, e uma linha reta em seis meses le-se como
-- estabilidade. Nao e: e o mesmo numero desenhado seis vezes. Marcar o
-- indicador como pontual permite recusar a serie e a comparacao entre
-- periodos, em vez de apresentar uma historia que o dado nao tem.
--
-- Para ter serie de verdade, esses indicadores dependem de apuracao
-- registrada dia a dia em KPI_RESULTADOS - que o historico ja suporta, e
-- que o agendamento do modulo 13 podera alimentar.
-- =========================================================================

ALTER TABLE kpi_definicoes
  ADD COLUMN pontual boolean NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN kpi_definicoes.pontual IS
  'TRUE quando o indicador mede a posicao atual e nao um periodo: nao admite serie historica reapurada nem comparacao entre periodos.';

UPDATE kpi_definicoes SET pontual = TRUE
 WHERE upper(codigo) IN (
   'COMPRAS_EM_ABERTO', 'NECESSIDADE_TOTAL', 'NECESSIDADE_URGENTE', 'PEDIDOS_ATRASADOS',
   'COBERTURA_MEDIA', 'ESTOQUE_CRITICO', 'ESTOQUE_DISPONIVEL', 'ESTOQUE_PARADO',
   'ESTOQUE_QUARENTENA', 'PRODUTOS_EXCESSO', 'PRODUTOS_RUPTURA', 'VALOR_ESTOQUE',
   'VALOR_EXCESSO', 'VALOR_RUPTURA', 'DEMANDA_MEDIA_DIARIA', 'PRODUTOS_SAZONAIS',
   'FORNECEDORES_BLOQUEADOS', 'FORNECEDORES_MONITORADOS', 'ENTREGAS_ATRASADAS',
   'RECEBIMENTOS_PENDENTES', 'COMPROMISSO_FUTURO', 'PRODUTOS_MONOPROVEDOR',
   'QUALIDADE_DADOS');
