-- =========================================================================
-- MODULO 14 - TIPOS DA CAMADA DE INTEGRACAO
--
-- Em arquivo proprio porque `ALTER TYPE ... ADD VALUE` nao pode rodar na mesma
-- transacao que usa o valor novo, e o migrate.ts envolve cada arquivo em uma
-- transacao unica. Separar aqui evita o erro na migration seguinte.
-- =========================================================================

-- -------------------------------------------------------------------------
-- Conectores (secao 7)
-- -------------------------------------------------------------------------

/*
 * O tipo do conector e o PROTOCOLO, nao o sistema do outro lado.
 *
 * "ERP" nao e tipo: um ERP pode falar REST, expor um banco de leitura ou
 * cuspir um arquivo por SFTP - e o mesmo ERP pode fazer as tres coisas para
 * entidades diferentes. Quem muda o codigo do conector e o protocolo; quem
 * muda a configuracao e o sistema. Misturar os dois faria um conector por
 * fornecedor, que e exatamente o que a secao 6 manda evitar ao pedir que novas
 * integracoes entrem sem mexer nos modulos de negocio.
 */
CREATE TYPE tipo_conector_enum AS ENUM (
  'REST', 'SOAP', 'BANCO_SQL', 'ARQUIVO', 'EMAIL', 'WEBHOOK', 'SFTP', 'MANUAL'
);

/* O sistema do outro lado - isto sim e o "quem" (secoes 8, 19, 21 e 22). */
CREATE TYPE sistema_integrado_enum AS ENUM (
  'ERP', 'FORNECEDOR', 'TRANSPORTADORA', 'FISCAL', 'FINANCEIRO',
  'BANCO_DADOS', 'PLANILHA', 'EMAIL', 'OUTRO'
);

CREATE TYPE direcao_integracao_enum AS ENUM ('ENTRADA', 'SAIDA', 'BIDIRECIONAL');

CREATE TYPE status_conector_enum AS ENUM (
  'NAO_CONFIGURADO', 'OPERACIONAL', 'ATENCAO', 'ERRO', 'DESATIVADO'
);

/* Secao 10: os quatro modos de sincronizacao. */
CREATE TYPE modo_sincronizacao_enum AS ENUM (
  'TEMPO_REAL', 'AGENDADO', 'MANUAL', 'SOB_DEMANDA'
);

-- -------------------------------------------------------------------------
-- Credenciais (secao 25)
-- -------------------------------------------------------------------------

CREATE TYPE tipo_autenticacao_enum AS ENUM (
  'NENHUMA', 'API_KEY', 'BEARER', 'BASIC', 'OAUTH2', 'CERTIFICADO', 'BANCO'
);

-- -------------------------------------------------------------------------
-- Execucao, mensagem e erro (secoes 29 a 32)
-- -------------------------------------------------------------------------

CREATE TYPE tipo_execucao_integracao_enum AS ENUM (
  'SINCRONIZACAO', 'IMPORTACAO', 'EXPORTACAO', 'TESTE', 'CONCILIACAO', 'ENVIO'
);

CREATE TYPE status_execucao_integracao_enum AS ENUM (
  'EXECUTANDO', 'CONCLUIDA', 'CONCLUIDA_COM_ERROS', 'FALHOU', 'CANCELADA'
);

/*
 * O ciclo da secao 29, com DESCARTADA a mais.
 *
 * DESCARTADA e o registro que chegou, foi reconhecido como JA PROCESSADO e nao
 * virou nada - o caso normal da importacao incremental da secao 14. Sem um
 * estado proprio ele seria contado como sucesso (inflando o volume) ou como
 * erro (assustando quem olha o painel), e nenhum dos dois e verdade.
 */
CREATE TYPE status_mensagem_enum AS ENUM (
  'PENDENTE', 'PROCESSANDO', 'SUCESSO', 'ERRO', 'RETRY', 'DESCARTADA', 'CANCELADA'
);

/*
 * Secao 30: erro recuperavel nao e o mesmo que erro definitivo.
 *
 * Um timeout merece nova tentativa; um CNPJ invalido no payload vai falhar
 * igual nas proximas mil. Insistir em erro definitivo e o retry infinito que a
 * secao 30 proibe, com o agravante de esconder o erro real atras de tentativas.
 */
CREATE TYPE classe_erro_enum AS ENUM (
  'RECUPERAVEL', 'DEFINITIVO', 'DESCONHECIDO'
);

CREATE TYPE tipo_erro_integracao_enum AS ENUM (
  'AUTENTICACAO', 'AUTORIZACAO', 'TIMEOUT', 'CONEXAO', 'LIMITE_TAXA',
  'PAYLOAD_INVALIDO', 'VALIDACAO', 'MAPEAMENTO', 'REFERENCIA_INEXISTENTE',
  'DUPLICIDADE', 'INDISPONIVEL', 'INTERNO'
);

CREATE TYPE status_erro_integracao_enum AS ENUM (
  'ABERTO', 'EM_ANALISE', 'RESOLVIDO', 'IGNORADO', 'REPROCESSADO'
);

-- -------------------------------------------------------------------------
-- Importacao e exportacao (secoes 11 a 14 e 40)
-- -------------------------------------------------------------------------

/*
 * Os estados do fluxo da secao 11.
 *
 * AGUARDANDO_CONFIRMACAO existe porque a secao 11 poe PRE-VISUALIZACAO e
 * CONFIRMACAO entre a validacao e o processamento. Sem um estado parado ali, o
 * arquivo seria processado direto e a pre-visualizacao viraria enfeite.
 */
CREATE TYPE status_importacao_enum AS ENUM (
  'RECEBIDO', 'ANALISANDO', 'AGUARDANDO_MAPEAMENTO', 'VALIDANDO',
  'AGUARDANDO_CONFIRMACAO', 'PROCESSANDO', 'CONCLUIDA',
  'CONCLUIDA_COM_ERROS', 'REJEITADA', 'CANCELADA'
);

CREATE TYPE formato_arquivo_enum AS ENUM ('XLSX', 'CSV', 'JSON', 'XML', 'PDF', 'TXT');

CREATE TYPE formato_exportacao_enum AS ENUM ('XLSX', 'CSV', 'JSON', 'PDF');

/* Secao 14: de onde o registro veio. */
CREATE TYPE origem_registro_enum AS ENUM (
  'ERP', 'EXCEL', 'CSV', 'API', 'MANUAL', 'EMAIL', 'WEBHOOK', 'PORTAL'
);

CREATE TYPE severidade_validacao_enum AS ENUM ('ERRO', 'ALERTA', 'INFO');

-- -------------------------------------------------------------------------
-- Conciliacao (secao 34)
-- -------------------------------------------------------------------------

CREATE TYPE status_conciliacao_enum AS ENUM (
  'DIVERGENTE', 'CONCILIADO', 'ACEITO', 'EM_ANALISE', 'IGNORADO'
);

-- -------------------------------------------------------------------------
-- Ambientes (secao 42)
-- -------------------------------------------------------------------------

/*
 * O ambiente e propriedade da CREDENCIAL, nao do sistema.
 *
 * A secao 42 manda nunca usar credencial de producao em desenvolvimento. Marcar
 * o ambiente na credencial permite que o banco recuse a combinacao errada, em
 * vez de depender de alguem lembrar qual arquivo .env estava carregado.
 */
CREATE TYPE ambiente_enum AS ENUM ('DESENVOLVIMENTO', 'HOMOLOGACAO', 'PRODUCAO');

-- -------------------------------------------------------------------------
-- Novos tipos de alerta e de evento usados pela integracao
-- -------------------------------------------------------------------------

ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'INTEGRACAO_DIVERGENCIA';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'IMPORTACAO_COM_ERROS';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'CREDENCIAL_VENCENDO';
ALTER TYPE tipo_alerta_enum ADD VALUE IF NOT EXISTS 'INTEGRACAO_SEM_SINCRONIZAR';
