-- ---------------------------------------------------------------------------
-- 031 - tipos do modulo 10 (avaliacao de fornecedores)
--
-- Arquivo separado porque o Postgres nao permite usar um valor de enum na
-- mesma transacao em que ele e adicionado. As estruturas vem na 032.
-- ---------------------------------------------------------------------------

-- Alertas de performance de fornecedor (secoes 42, 43 e 44).
-- FORNECEDOR_BAIXO_DESEMPENHO ja existe e continua valendo.
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'TENDENCIA_NEGATIVA';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'MELHORIA_PERFORMANCE';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'AVALIACAO_VENCIDA';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'DADOS_INSUFICIENTES';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'PLANO_ACAO_ATRASADO';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'FORNECEDOR_MONITORADO';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'FORNECEDOR_BLOQUEADO';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'CONCENTRACAO_FORNECIMENTO';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'FORNECEDOR_UNICO';
