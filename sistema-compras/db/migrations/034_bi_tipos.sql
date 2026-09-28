-- ---------------------------------------------------------------------------
-- 034 - tipos do modulo 11 (BI, KPIs e dashboards)
--
-- Arquivo separado: o Postgres nao permite usar um valor de enum na mesma
-- transacao em que ele e adicionado. As estruturas vem na 035.
-- ---------------------------------------------------------------------------

-- Alertas do BI (secao 40). Os tipos operacionais ja existem desde o modulo 03
-- e continuam valendo: a central do modulo 11 le a mesma tabela.
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'KPI_FORA_DA_META';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'KPI_SEM_DADOS';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'ESTOQUE_EXCESSIVO';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'COBERTURA_BAIXA';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'GIRO_BAIXO';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'PRODUTO_CRITICO';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'IMPORTACAO_ATRASADA';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'QUALIDADE_DADOS';
