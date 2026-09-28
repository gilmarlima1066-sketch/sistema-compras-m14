-- =========================================================================
-- MODULO 13 - TIPOS DA CAMADA DE ORQUESTRACAO
--
-- ALTER TYPE ... ADD VALUE nao pode dividir transacao com o uso do valor
-- novo, entao os acrescimos aos enums existentes ficam neste arquivo.
-- =========================================================================

ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'AUTOMACAO_FALHOU';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'SLA_VENCIDO';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'TAREFA_ATRASADA';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'INTEGRACAO_FALHOU';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'JOB_FALHOU';
