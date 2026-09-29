/**
 * Validacao de entrada do modulo 14 (secao 37).
 *
 * A validacao aqui protege contra payload malicioso e contra engano honesto.
 * Os CHECKs e os indices do banco continuam sendo a ultima palavra; estes
 * esquemas existem para a recusa chegar com mensagem util e para que nada
 * inesperado chegue perto de virar SQL ou chamada externa.
 */
import { z } from 'zod';

const paginacao = {
  limite: z.coerce.number().int().min(1).max(200).optional(),
  pagina: z.coerce.number().int().min(1).optional(),
};

const texto = (min: number, max: number) => z.string().trim().min(min).max(max);

export const idParam = z.object({ id: z.coerce.number().int().positive() });
export const codigoParam = z.object({ codigo: texto(2, 60) });

// ---------------------------------------------------------------------------
// Integracoes e conectores
// ---------------------------------------------------------------------------

const CONECTORES = ['REST', 'SOAP', 'BANCO_SQL', 'ARQUIVO', 'EMAIL',
  'WEBHOOK', 'SFTP', 'MANUAL'] as const;
const SISTEMAS = ['ERP', 'FORNECEDOR', 'TRANSPORTADORA', 'FISCAL', 'FINANCEIRO',
  'BANCO_DADOS', 'PLANILHA', 'EMAIL', 'OUTRO'] as const;
const DIRECOES = ['ENTRADA', 'SAIDA', 'BIDIRECIONAL'] as const;
const MODOS = ['TEMPO_REAL', 'AGENDADO', 'MANUAL', 'SOB_DEMANDA'] as const;

/**
 * A URL do endpoint e validada contra endereco interno.
 *
 * Secao 37: "validacao de origem" e "protecao contra payload malicioso". Uma
 * integracao apontando para `http://169.254.169.254` ou `localhost` transforma
 * o servidor num proxy para a propria rede interna - e quem configura pode nao
 * ter essa intencao nem perceber o efeito.
 */
const HOSTS_PROIBIDOS = [
  /^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^\[?::1\]?$/,
  /^169\.254\./,                    // link-local e metadados de nuvem
  /^10\./, /^192\.168\./,           // redes privadas
  /^172\.(1[6-9]|2\d|3[01])\./,
  /\.internal$/i, /\.local$/i,
];

/**
 * O endereco e interno?
 *
 * Exportada porque a decisao sobre enderecos internos NAO e mais so do esquema:
 * ela depende de configuracao, e esquema zod e sincrono.
 */
export const hostInterno = (valor: string): boolean => {
  try {
    const host = new URL(valor).hostname;
    return HOSTS_PROIBIDOS.some((p) => p.test(host));
  } catch { return false; }
};

/**
 * URL de endpoint de integracao.
 *
 * Aqui o esquema valida apenas a FORMA - protocolo e tamanho. A recusa de
 * endereco interno migrou para `validarEndpoint`, no servico, e a razao e
 * concreta:
 *
 * bloquear toda rede privada e a regra certa para um sistema publico, onde um
 * endpoint interno so serve para o atacante pivotar para dentro (SSRF). Mas
 * este sistema roda na propria empresa, e o ERP de uma distribuidora fica quase
 * sempre na rede local - `192.168.x.x` ou `erp.local`. Com a regra rigida, o
 * caso de uso principal da secao 8 ficava impossivel: o usuario nunca
 * conseguiria apontar a integracao para o ERP dele.
 *
 * A saida nao e afrouxar, e tornar explicito: por padrao continua tudo
 * bloqueado, e o operador libera hosts nomeados em
 * `integracao.hosts_internos_permitidos`. Quem ataca nao escolhe o endereco;
 * quem administra escolhe, uma vez, com o nome do host escrito.
 */
export const urlExterna = z.string().trim().url().max(500)
  .refine((valor) => {
    try {
      const u = new URL(valor);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch { return false; }
  }, 'A URL precisa usar http ou https');

export const criarIntegracaoSchema = z.object({
  codigo: texto(2, 60).regex(/^[A-Za-z0-9_]+$/,
    'Use apenas letras, numeros e sublinhado'),
  nome: texto(3, 120),
  sistema: z.enum(SISTEMAS),
  conector: z.enum(CONECTORES),
  direcao: z.enum(DIRECOES).optional(),
  modo_sincronizacao: z.enum(MODOS).optional(),
  endpoint: urlExterna.optional().nullable(),
  configuracao: z.record(z.unknown()).optional(),
  timeout_segundos: z.coerce.number().int().min(1).max(600).optional(),
  max_tentativas: z.coerce.number().int().min(1).max(10).optional(),
  limite_por_minuto: z.coerce.number().int().min(1).max(10000).optional().nullable(),
  limite_por_execucao: z.coerce.number().int().min(1).max(1_000_000).optional(),
  intervalo_minutos: z.coerce.number().int().min(1).max(10080).optional().nullable(),
  observacao: texto(3, 1000).optional(),
  ativo: z.coerce.boolean().optional(),
}).refine((v) => v.modo_sincronizacao !== 'AGENDADO' || v.intervalo_minutos,
  { message: 'Modo AGENDADO exige intervalo em minutos', path: ['intervalo_minutos'] });

export const atualizarIntegracaoSchema = z.object({
  nome: texto(3, 120).optional(),
  direcao: z.enum(DIRECOES).optional(),
  modo_sincronizacao: z.enum(MODOS).optional(),
  endpoint: urlExterna.optional().nullable(),
  configuracao: z.record(z.unknown()).optional(),
  timeout_segundos: z.coerce.number().int().min(1).max(600).optional(),
  max_tentativas: z.coerce.number().int().min(1).max(10).optional(),
  limite_por_minuto: z.coerce.number().int().min(1).max(10000).optional().nullable(),
  limite_por_execucao: z.coerce.number().int().min(1).max(1_000_000).optional(),
  intervalo_minutos: z.coerce.number().int().min(1).max(10080).optional().nullable(),
  observacao: texto(3, 1000).optional(),
  ativo: z.coerce.boolean().optional(),
});

export const testarSchema = z.object({
  caminho: texto(1, 200).optional(),
});

export const sincronizarSchema = z.object({
  entidade: texto(2, 60),
  desde: z.string().optional().nullable(),
});

export const enviarSchema = z.object({
  entidade: texto(2, 60),
  registro_id: z.coerce.number().int().positive(),
  payload: z.record(z.unknown()),
  caminho: texto(1, 200).optional(),
  metodo: z.enum(['POST', 'PUT', 'PATCH']).optional(),
});

// ---------------------------------------------------------------------------
// Credenciais (secao 25)
// ---------------------------------------------------------------------------

export const credencialSchema = z.object({
  integracao_id: z.coerce.number().int().positive(),
  nome: texto(2, 80),
  tipo: z.enum(['NENHUMA', 'API_KEY', 'BEARER', 'BASIC', 'OAUTH2',
    'CERTIFICADO', 'BANCO']),
  ambiente: z.enum(['DESENVOLVIMENTO', 'HOMOLOGACAO', 'PRODUCAO']).optional(),
  /**
   * Nao aceita o segredo: aceita onde ele esta. O formato e conferido de novo
   * no servico, que e onde a regra mora - aqui e so para o erro sair como
   * validacao de campo.
   */
  referencia_segura: texto(4, 200).regex(/^(env|file):/,
    'A referencia precisa comecar com env: ou file:, apontando para onde o '
    + 'segredo esta guardado. O segredo em si nunca vai para o banco.'),
  parametros: z.record(z.unknown()).optional(),
  expira_em: z.string().optional().nullable(),
});

export const rotacionarSchema = z.object({
  referencia_segura: texto(4, 200).regex(/^(env|file):/,
    'A referencia precisa comecar com env: ou file:'),
});

// ---------------------------------------------------------------------------
// Templates e mapeamentos (secoes 12 e 26)
// ---------------------------------------------------------------------------

export const templateSchema = z.object({
  codigo: texto(2, 60).regex(/^[A-Za-z0-9_]+$/, 'Use letras, numeros e sublinhado'),
  nome: texto(3, 120),
  descricao: texto(3, 500).optional().nullable(),
  entidade: texto(2, 60),
  formato: z.enum(['XLSX', 'CSV', 'JSON', 'XML', 'PDF', 'TXT']).optional().nullable(),
  integracao_id: z.coerce.number().int().positive().optional().nullable(),
  linha_cabecalho: z.coerce.number().int().min(1).max(100).optional(),
  separador: z.string().max(3).optional().nullable(),
  codificacao: texto(2, 20).optional(),
  configuracao: z.record(z.unknown()).optional(),
  mapeamentos: z.array(z.object({
    campo_externo: texto(1, 120),
    campo_interno: texto(1, 120),
    transformacao: texto(2, 40).optional().nullable(),
    parametros: z.record(z.unknown()).optional(),
    obrigatorio: z.coerce.boolean().optional(),
    valor_padrao: z.string().max(200).optional().nullable(),
  })).min(1).max(200),
});

export const sugerirSchema = z.object({
  colunas: z.array(texto(1, 120)).min(1).max(200),
});

// ---------------------------------------------------------------------------
// Importacao (secoes 11 a 14)
// ---------------------------------------------------------------------------

export const importarSchema = z.object({
  nome_arquivo: texto(3, 255),
  entidade: texto(2, 60),
  /**
   * Caminho de arquivo ja presente no servidor. Limitado a diretorios
   * conhecidos no servico - aceitar caminho livre daqui seria leitura
   * arbitraria do disco.
   */
  caminho: texto(3, 500),
  template: texto(2, 60).optional().nullable(),
  linha_cabecalho: z.coerce.number().int().min(1).max(100).optional(),
  separador: z.string().max(3).optional().nullable(),
  integracao: texto(2, 60).optional().nullable(),
});

export const mapearImportacaoSchema = z.object({
  template: texto(2, 60),
});

export const listarImportacoesSchema = z.object({
  status: z.enum(['RECEBIDO', 'ANALISANDO', 'AGUARDANDO_MAPEAMENTO', 'VALIDANDO',
    'AGUARDANDO_CONFIRMACAO', 'PROCESSANDO', 'CONCLUIDA', 'CONCLUIDA_COM_ERROS',
    'REJEITADA', 'CANCELADA']).optional(),
  entidade: texto(2, 60).optional(),
  ...paginacao,
});

export const ocorrenciasSchema = z.object({
  severidade: z.enum(['ERRO', 'ALERTA', 'INFO']).optional(),
  limite: z.coerce.number().int().min(1).max(5000).optional(),
});

// ---------------------------------------------------------------------------
// Exportacao (secao 40)
// ---------------------------------------------------------------------------

export const exportarSchema = z.object({
  conjunto: texto(2, 60),
  formato: z.enum(['XLSX', 'CSV', 'JSON', 'PDF']).optional(),
  filtros: z.record(z.unknown()).optional(),
});

export const historicoExportacoesSchema = z.object({
  sensivel: z.coerce.boolean().optional(),
  limite: z.coerce.number().int().min(1).max(200).optional(),
});

// ---------------------------------------------------------------------------
// Log, erros e mensagens (secoes 31, 32 e 35)
// ---------------------------------------------------------------------------

export const execucoesSchema = z.object({
  integracao: texto(2, 60).optional(),
  status: z.enum(['EXECUTANDO', 'CONCLUIDA', 'CONCLUIDA_COM_ERROS', 'FALHOU',
    'CANCELADA']).optional(),
  tipo: z.enum(['SINCRONIZACAO', 'IMPORTACAO', 'EXPORTACAO', 'TESTE',
    'CONCILIACAO', 'ENVIO']).optional(),
  entidade: texto(2, 60).optional(),
  desde: z.string().optional(),
  ate: z.string().optional(),
  ...paginacao,
});

export const mensagensSchema = z.object({
  integracao: texto(2, 60).optional(),
  entidade: texto(2, 60).optional(),
  status: z.enum(['PENDENTE', 'PROCESSANDO', 'SUCESSO', 'ERRO', 'RETRY',
    'DESCARTADA', 'CANCELADA']).optional(),
  dead_letter: z.coerce.boolean().optional(),
  ...paginacao,
});

export const errosSchema = z.object({
  status: z.enum(['ABERTO', 'EM_ANALISE', 'RESOLVIDO', 'IGNORADO',
    'REPROCESSADO']).optional(),
  integracao: texto(2, 60).optional(),
  tipo: texto(2, 40).optional(),
  classe: z.enum(['RECUPERAVEL', 'DEFINITIVO', 'DESCONHECIDO']).optional(),
  ...paginacao,
});

export const resolverErroSchema = z.object({
  status: z.enum(['RESOLVIDO', 'IGNORADO', 'EM_ANALISE']),
  observacao: texto(3, 1000).optional().nullable(),
  confirmar_causa: z.coerce.boolean().optional(),
});

export const cancelarSchema = z.object({
  motivo: texto(3, 500),
});

export const iniciarClientSchema = z.object({
  nome_arquivo: texto(3, 255),
  entidade: texto(2, 60),
  colunas: z.array(z.string().trim().max(120)).min(1).max(500),
  amostra: z.array(z.record(z.unknown())).max(500),
  total_linhas: z.coerce.number().int().min(1),
  template: texto(2, 60).optional().nullable(),
  integracao: texto(2, 60).optional().nullable(),
});

export const processarLoteSchema = z.object({
  lote: z.coerce.number().int().min(0),
  total_lotes: z.coerce.number().int().min(1),
  linhas: z.array(z.record(z.unknown())).min(1).max(10000),
  is_last: z.coerce.boolean(),
});

// ---------------------------------------------------------------------------
// Conciliacao (secao 34)
// ---------------------------------------------------------------------------

export const conciliarEstoqueSchema = z.object({
  integracao: texto(2, 60),
  saldos: z.array(z.object({
    codigo_produto: texto(1, 60),
    saldo: z.coerce.number(),
    unidade: texto(1, 10).optional(),
  })).min(1).max(20000),
});

export const listarConciliacoesSchema = z.object({
  status: z.enum(['DIVERGENTE', 'CONCILIADO', 'ACEITO', 'EM_ANALISE',
    'IGNORADO']).optional(),
  entidade: texto(2, 60).optional(),
  integracao: texto(2, 60).optional(),
  ...paginacao,
});

export const decidirConciliacaoSchema = z.object({
  justificativa: texto(10, 1000),
});

// ---------------------------------------------------------------------------
// E-mail (secoes 15 a 18)
// ---------------------------------------------------------------------------

export const emailSchema = z.object({
  remetente: texto(5, 200),
  assunto: texto(1, 500),
  corpo: z.string().max(200_000),
  recebido_em: z.string().optional(),
  message_id: texto(3, 300).optional(),
  anexos: z.array(z.object({
    nome: texto(1, 255),
    tipo: texto(1, 100),
    tamanho: z.coerce.number().int().min(0).optional(),
    texto: z.string().max(500_000).optional(),
  })).max(20).optional(),
});

export const listarEmailsSchema = z.object({
  classificacao: texto(2, 40).optional(),
  ...paginacao,
});

export const solicitacaoCotacaoSchema = z.object({
  fornecedores: z.array(z.coerce.number().int().positive()).min(1).max(50),
});

// ---------------------------------------------------------------------------
// Monitoramento
// ---------------------------------------------------------------------------

export const periodoSchema = z.object({
  dias: z.coerce.number().int().min(1).max(365).optional(),
});

/**
 * Valor de configuracao.
 *
 * Aceita string VAZIA de proposito. Ha configuracoes cujo valor legitimo e
 * "nenhum" - a lista de hosts internos liberados e o caso obvio: vazia
 * significa "nada interno passa", que e justamente o padrao seguro. Com
 * `min(1)`, uma lista dessas podia ser preenchida pela API e nunca mais
 * esvaziada, o que deixava o sistema preso na configuracao mais permissiva.
 */
export const configuracaoSchema = z.object({
  valor: z.string().trim().max(500),
});

// ---------------------------------------------------------------------------
// Validacao de endpoint que depende de configuracao
// ---------------------------------------------------------------------------

/**
 * Recusa endereco interno, a menos que o operador tenha liberado aquele host.
 *
 * Chamada pelo servico, nao pelo esquema, porque precisa ler configuracao.
 * A mensagem diz exatamente o que fazer: quem esta configurando a integracao
 * com o ERP da empresa precisa saber que existe uma lista, e qual chave mexer.
 */
export async function validarEndpoint(
  url: string | null | undefined,
  permitidos: string[],
): Promise<void> {
  if (!url || !hostInterno(url)) return;

  const host = new URL(url).hostname.toLowerCase();
  if (permitidos.includes(host)) return;

  throw new Error(
    `O endereco ${host} e de rede interna. Para integrar com um sistema da `
    + 'propria rede (o caso comum de ERP), inclua o host em '
    + '`integracao.hosts_internos_permitidos`, nas configuracoes de integracao.');
}
