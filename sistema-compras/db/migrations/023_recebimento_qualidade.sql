-- ===========================================================================
-- MODULO 09 - Recebimento, conferencia, qualidade e nao conformidades
-- Parte 1 de 2: valores novos nos enums que ja existiam.
--
-- Esta migration so acrescenta valores. O Postgres nao deixa USAR um valor de
-- enum na mesma transacao em que ele foi adicionado, e o runner envolve cada
-- arquivo numa transacao - por isso as tabelas que dependem desses valores
-- ficam na migration 024.
-- ===========================================================================

-- Workflow do recebimento (secao 6). O enum original so cobria o meio do
-- caminho: faltavam a chegada, as tres formas de fecho e a quarentena.
ALTER TYPE status_recebimento_enum ADD VALUE IF NOT EXISTS 'AGUARDANDO_CHEGADA' BEFORE 'EM_CONFERENCIA';
ALTER TYPE status_recebimento_enum ADD VALUE IF NOT EXISTS 'CHEGOU' BEFORE 'EM_CONFERENCIA';
ALTER TYPE status_recebimento_enum ADD VALUE IF NOT EXISTS 'APROVADO';
ALTER TYPE status_recebimento_enum ADD VALUE IF NOT EXISTS 'APROVADO_PARCIALMENTE';
ALTER TYPE status_recebimento_enum ADD VALUE IF NOT EXISTS 'REJEITADO';
ALTER TYPE status_recebimento_enum ADD VALUE IF NOT EXISTS 'QUARENTENA';
ALTER TYPE status_recebimento_enum ADD VALUE IF NOT EXISTS 'DEVOLVIDO';

ALTER TYPE status_recebimento_item_enum ADD VALUE IF NOT EXISTS 'EM_QUARENTENA';
ALTER TYPE status_recebimento_item_enum ADD VALUE IF NOT EXISTS 'DEVOLVIDO';

-- Secao 21: a inspecao comeca PENDENTE e pode terminar em quarentena.
ALTER TYPE resultado_inspecao_enum ADD VALUE IF NOT EXISTS 'PENDENTE' BEFORE 'APROVADO';
ALTER TYPE resultado_inspecao_enum ADD VALUE IF NOT EXISTS 'QUARENTENA';

-- Secao 22: os 16 tipos de nao conformidade.
ALTER TYPE tipo_nao_conformidade_enum ADD VALUE IF NOT EXISTS 'PRODUTO_INCORRETO';
ALTER TYPE tipo_nao_conformidade_enum ADD VALUE IF NOT EXISTS 'LOTE';
ALTER TYPE tipo_nao_conformidade_enum ADD VALUE IF NOT EXISTS 'PESO';
ALTER TYPE tipo_nao_conformidade_enum ADD VALUE IF NOT EXISTS 'IMPOSTO';
ALTER TYPE tipo_nao_conformidade_enum ADD VALUE IF NOT EXISTS 'AVARIA';
ALTER TYPE tipo_nao_conformidade_enum ADD VALUE IF NOT EXISTS 'TRANSPORTE';
ALTER TYPE tipo_nao_conformidade_enum ADD VALUE IF NOT EXISTS 'TEMPERATURA';
ALTER TYPE tipo_nao_conformidade_enum ADD VALUE IF NOT EXISTS 'DIVERGENCIA_FISCAL';
ALTER TYPE tipo_nao_conformidade_enum ADD VALUE IF NOT EXISTS 'DIVERGENCIA_COMERCIAL';
ALTER TYPE tipo_nao_conformidade_enum ADD VALUE IF NOT EXISTS 'ESPECIFICACAO_TECNICA';

-- Fluxo da secao 24, que tem mais estagios do que o enum original previa.
ALTER TYPE status_nao_conformidade_enum ADD VALUE IF NOT EXISTS 'EM_ANALISE' AFTER 'ABERTA';
ALTER TYPE status_nao_conformidade_enum ADD VALUE IF NOT EXISTS 'ACAO_DEFINIDA';
ALTER TYPE status_nao_conformidade_enum ADD VALUE IF NOT EXISTS 'AGUARDANDO_FORNECEDOR';
ALTER TYPE status_nao_conformidade_enum ADD VALUE IF NOT EXISTS 'VALIDADA';
ALTER TYPE status_nao_conformidade_enum ADD VALUE IF NOT EXISTS 'ENCERRADA';

-- Alertas da secao 53.
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'RECEBIMENTO_DIVERGENTE';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'VALIDADE_INSUFICIENTE';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'LOTE_NAO_INFORMADO';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'PRODUTO_VENCIDO';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'QUALIDADE_REPROVADA';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'QUARENTENA_ABERTA';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'NC_CRITICA';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'DEVOLUCAO_PENDENTE';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'APROVACAO_PENDENTE';

-- A movimentacao de quarentena e um documento proprio: entrada em quarentena
-- e liberacao posterior nao sao a mesma coisa que a entrada de compra.
ALTER TYPE documento_movimentacao_enum ADD VALUE IF NOT EXISTS 'QUARENTENA';
