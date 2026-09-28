-- ---------------------------------------------------------------------------
-- 048 - Alinhar as condicoes das regras ao que os detectores realmente emitem
--
-- Falha encontrada olhando a tela de regras: cinco das oito regras com condicao
-- nunca dispararam. Nao por erro de logica - por nome de campo.
--
-- A regra EST_RISCO_RUPTURA exigia `dias_ate_ruptura <= 15`; o detector emite
-- `cobertura_dias`. Campo ausente no payload nao atende a condicao, entao a
-- regra ficava ativa, vigente, visivel na tela e completamente inerte. E a pior
-- forma de falhar deste modulo inteiro: o sistema parece configurado e nao faz
-- nada, e ninguem procura pelo alerta que nunca chegou.
--
-- A correcao tem dois lados. Do lado dos detectores (no codigo) passaram a ser
-- emitidos os campos que as regras pediam e que faziam sentido existir:
-- `valor_parado` no excesso, `necessidades_do_fornecedor` na necessidade de
-- compra, `dias_sem_confirmacao` no pedido sem confirmacao, `nivel` na
-- recomendacao da IA. Deste lado, aqui, corrigem-se os nomes que nao tinham
-- equivalente possivel.
--
-- Para o problema nao voltar em silencio, o Centro de Operacoes passou a
-- comparar as condicoes das regras com os campos vistos nos eventos daquele
-- tipo e a apontar quem pede campo que nunca chega.
-- ---------------------------------------------------------------------------

-- O detector de risco de ruptura mede COBERTURA: quantos dias o saldo atual
-- cobre a demanda. "Dias ate a ruptura" e a mesma grandeza com outro nome, e o
-- nome que vale e o que o evento carrega.
UPDATE automacao_regras
   SET condicao = '[{"campo": "cobertura_dias", "valor": 15, "operador": "<="}]'::jsonb,
       versao = versao + 1,
       updated_at = now()
 WHERE codigo = 'EST_RISCO_RUPTURA'
   AND condicao @> '[{"campo": "dias_ate_ruptura"}]'::jsonb;

-- A regra de risco da IA classificava por `nivel`; o evento de recomendacao
-- carrega `prioridade`, e o detector agora emite os dois. A condicao passa a
-- usar o nome canonico do evento, e o alias cobre quem ja dependia do outro.
UPDATE automacao_regras
   SET condicao = '[{"campo": "prioridade", "valor": ["CRITICA", "ALTA"], "operador": "in"}]'::jsonb,
       versao = versao + 1,
       updated_at = now()
 WHERE codigo = 'IA_RISCO'
   AND condicao @> '[{"campo": "nivel"}]'::jsonb;

-- ---------------------------------------------------------------------------
-- A verificacao permanente
-- ---------------------------------------------------------------------------

-- Cruza cada condicao de regra ativa com os campos ja vistos em eventos do
-- mesmo tipo. Um campo que a regra exige e que nunca apareceu significa uma de
-- duas coisas, ambas dignas de aviso: o nome esta errado, ou o evento ainda nao
-- foi produzido nenhuma vez. A visao nao decide qual - diz o que observou.
CREATE OR REPLACE VIEW vw_regras_contrato AS
WITH campos_regra AS (
  SELECT r.id, r.codigo, r.nome, r.evento, c ->> 'campo' AS campo
    FROM automacao_regras r,
         LATERAL jsonb_array_elements(r.condicao) c
   WHERE r.ativo
     AND r.vigencia_inicio <= CURRENT_DATE
     AND (r.vigencia_fim IS NULL OR r.vigencia_fim >= CURRENT_DATE)
),
campos_evento AS (
  SELECT DISTINCT e.tipo, jsonb_object_keys(e.payload) AS campo
    FROM eventos e
),
eventos_vistos AS (
  SELECT DISTINCT tipo FROM eventos
)
SELECT cr.id            AS regra_id,
       cr.codigo,
       cr.nome,
       cr.evento,
       cr.campo         AS campo_exigido,
       (ce.campo IS NOT NULL)                       AS campo_existe,
       (ev.tipo IS NOT NULL)                        AS evento_ja_ocorreu
  FROM campos_regra cr
  LEFT JOIN campos_evento   ce ON ce.tipo = cr.evento AND ce.campo = cr.campo
  LEFT JOIN eventos_vistos  ev ON ev.tipo = cr.evento;

COMMENT ON VIEW vw_regras_contrato IS
  'Contrato entre regras e detectores. Uma linha com campo_existe = false e '
  'evento_ja_ocorreu = true e uma regra que nunca vai disparar: ela pede um '
  'campo que os eventos daquele tipo nao carregam.';
