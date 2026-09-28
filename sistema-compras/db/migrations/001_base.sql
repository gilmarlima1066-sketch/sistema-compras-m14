-- =============================================================================
-- 001_base.sql  |  Extensoes, tipos enumerados e funcoes utilitarias
-- Sistema de Gestao de Compras, Estoque, Fornecedores, Demanda e Recebimento
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Tipos enumerados (dominio fechado, validado pelo proprio banco)
-- -----------------------------------------------------------------------------

CREATE TYPE tipo_fornecedor_enum AS ENUM (
  'FABRICANTE','DISTRIBUIDOR','PRODUTOR','IMPORTADOR','REPRESENTANTE','OUTRO');

CREATE TYPE origem_fornecedor_enum AS ENUM ('NACIONAL','INTERNACIONAL');

CREATE TYPE classificacao_abc_enum AS ENUM ('A','B','C');
CREATE TYPE classificacao_xyz_enum AS ENUM ('X','Y','Z');

CREATE TYPE tipo_local_enum AS ENUM ('CD','ARMAZEM','LOJA','QUARENTENA','PRODUCAO','OUTRO');

CREATE TYPE tipo_movimentacao_enum AS ENUM (
  'ENTRADA_COMPRA','SAIDA_VENDA','AJUSTE_POSITIVO','AJUSTE_NEGATIVO','DEVOLUCAO',
  'TRANSFERENCIA_ENTRADA','TRANSFERENCIA_SAIDA','PERDA','AVARIA','INVENTARIO',
  'PRODUCAO','CONSUMO_PRODUCAO');

CREATE TYPE documento_movimentacao_enum AS ENUM (
  'RECEBIMENTO','VENDA','INVENTARIO','AJUSTE_MANUAL','TRANSFERENCIA',
  'ORDEM_PRODUCAO','DEVOLUCAO','OUTRO');

CREATE TYPE status_lote_enum AS ENUM ('DISPONIVEL','QUARENTENA','BLOQUEADO','VENCIDO','CONSUMIDO');

CREATE TYPE status_inventario_enum AS ENUM ('ABERTO','EM_CONTAGEM','CONCILIADO','FINALIZADO','CANCELADO');

CREATE TYPE status_venda_enum AS ENUM ('ABERTA','FATURADA','ENTREGUE','CANCELADA');

CREATE TYPE metodo_previsao_enum AS ENUM (
  'MEDIA_MOVEL','MEDIA_PONDERADA','SAZONALIDADE','TENDENCIA','ESTATISTICO','IA');

CREATE TYPE status_necessidade_enum AS ENUM (
  'PENDENTE','EM_ANALISE','APROVADA','CONVERTIDA_COTACAO','CANCELADA');

CREATE TYPE urgencia_enum AS ENUM ('NORMAL','ATENCAO','URGENTE','CRITICA','EXCESSO');

CREATE TYPE status_cotacao_enum AS ENUM ('RASCUNHO','ABERTA','EM_NEGOCIACAO','FINALIZADA','CANCELADA');

CREATE TYPE status_cotacao_fornecedor_enum AS ENUM (
  'PENDENTE','ENVIADA','RESPONDIDA','RECUSADA','CANCELADA');

CREATE TYPE status_ordem_compra_enum AS ENUM (
  'RASCUNHO','AGUARDANDO_APROVACAO','APROVADA','ENVIADA','CONFIRMADA','EM_PRODUCAO',
  'EM_TRANSITO','RECEBIMENTO_PARCIAL','RECEBIDA','CANCELADA','FINALIZADA');

CREATE TYPE status_entrega_enum AS ENUM (
  'PENDENTE','CONFIRMADA','EM_TRANSITO','PARCIAL','ENTREGUE','ATRASADA','CANCELADA');

CREATE TYPE status_recebimento_enum AS ENUM (
  'EM_CONFERENCIA','AGUARDANDO_QUALIDADE','CONCLUIDO','DIVERGENTE','CANCELADO');

CREATE TYPE status_recebimento_item_enum AS ENUM (
  'PENDENTE','ACEITO','ACEITO_PARCIAL','REJEITADO');

CREATE TYPE resultado_inspecao_enum AS ENUM ('APROVADO','APROVADO_COM_RESSALVA','REPROVADO');

CREATE TYPE tipo_nao_conformidade_enum AS ENUM (
  'QUALIDADE','QUANTIDADE','PRECO','EMBALAGEM','VALIDADE','DOCUMENTACAO','OUTRO');

CREATE TYPE acao_nao_conformidade_enum AS ENUM (
  'DEVOLUCAO','ABATIMENTO','RETRABALHO','ACEITE_CONDICIONAL','DESCARTE','SUBSTITUICAO','NENHUMA');

CREATE TYPE status_nao_conformidade_enum AS ENUM ('ABERTA','EM_TRATATIVA','RESOLVIDA','CANCELADA');

CREATE TYPE status_compromisso_enum AS ENUM ('PREVISTO','CONFIRMADO','PAGO','CANCELADO');

CREATE TYPE tipo_alerta_enum AS ENUM (
  'RUPTURA','RISCO_RUPTURA','EXCESSO','PEDIDO_ATRASADO','PRECO_AUMENTOU',
  'QUALIDADE_REPROVADA','FORNECEDOR_BAIXO_DESEMPENHO','ESTOQUE_PARADO','VALIDADE_PROXIMA');

CREATE TYPE severidade_enum AS ENUM ('INFO','BAIXA','MEDIA','ALTA','CRITICA');

CREATE TYPE status_alerta_enum AS ENUM ('ABERTO','EM_TRATATIVA','RESOLVIDO','IGNORADO');

CREATE TYPE acao_auditoria_enum AS ENUM ('INSERT','UPDATE','DELETE');

CREATE TYPE tipo_configuracao_enum AS ENUM ('STRING','NUMERO','BOOLEANO','JSON','DATA');

-- -----------------------------------------------------------------------------
-- 2. Funcoes utilitarias
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Usuario da sessao de aplicacao (definido pelo backend via set_config)
CREATE OR REPLACE FUNCTION fn_usuario_sessao() RETURNS BIGINT
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN NULLIF(current_setting('app.usuario_id', true), '')::BIGINT;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION fn_ip_sessao() RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN NULLIF(current_setting('app.ip', true), '');
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

-- Preenche created_by / updated_by a partir da sessao
CREATE OR REPLACE FUNCTION fn_set_autoria() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_usuario BIGINT := fn_usuario_sessao();
BEGIN
  IF v_usuario IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(NEW.created_by, v_usuario);
    NEW.updated_by := COALESCE(NEW.updated_by, v_usuario);
  ELSE
    NEW.updated_by := v_usuario;
  END IF;
  RETURN NEW;
END;
$$;

-- Tabelas append-only (historico de precos, auditoria)
CREATE OR REPLACE FUNCTION fn_bloquear_alteracao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Tabela % e somente-insercao: % nao permitido (registro historico).',
    TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;

-- Sinal da movimentacao (+1 entrada, -1 saida, 0 = usa o sinal informado na quantidade)
CREATE OR REPLACE FUNCTION fn_sinal_movimentacao(p_tipo tipo_movimentacao_enum) RETURNS SMALLINT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_tipo
    WHEN 'ENTRADA_COMPRA'        THEN 1
    WHEN 'DEVOLUCAO'             THEN 1
    WHEN 'AJUSTE_POSITIVO'       THEN 1
    WHEN 'TRANSFERENCIA_ENTRADA' THEN 1
    WHEN 'PRODUCAO'              THEN 1
    WHEN 'SAIDA_VENDA'           THEN -1
    WHEN 'AJUSTE_NEGATIVO'       THEN -1
    WHEN 'TRANSFERENCIA_SAIDA'   THEN -1
    WHEN 'PERDA'                 THEN -1
    WHEN 'AVARIA'                THEN -1
    WHEN 'CONSUMO_PRODUCAO'      THEN -1
    WHEN 'INVENTARIO'            THEN 0
  END::SMALLINT;
$$;

COMMIT;
