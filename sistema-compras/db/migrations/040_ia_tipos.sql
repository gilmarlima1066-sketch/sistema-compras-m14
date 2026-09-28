-- =========================================================================
-- MODULO 12 - TIPOS DA CAMADA DE INTELIGENCIA
--
-- ALTER TYPE ... ADD VALUE nao pode dividir transacao com o uso do valor
-- novo, entao os acrescimos aos enums existentes ficam neste arquivo, e as
-- estruturas que os usam vao no seguinte.
--
-- Os alertas da IA (secao 19) entram na MESMA central do modulo 11. Nao
-- existe AI_ALERTAS: existe alerta, com um tipo a mais. A deduplicacao que o
-- modulo 11 construiu ja atende o "evitar alertas duplicados" da secao 19 -
-- construir uma segunda central seria repetir o problema que a primeira
-- resolveu.
-- =========================================================================

ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'ANOMALIA_DETECTADA';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'RUPTURA_PREVISTA';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'PRECO_ACIMA_DA_MEDIA';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'DEMANDA_FORA_DO_PADRAO';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'PREVISAO_DIVERGENTE';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'OPORTUNIDADE_ECONOMIA';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'CONCENTRACAO_CRITICA';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'LEAD_TIME_CRESCENDO';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'DADOS_INSUFICIENTES_IA';
