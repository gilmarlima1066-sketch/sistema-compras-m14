/**
 * Validacao de entrada do modulo 13 (secao 36).
 *
 * A validacao aqui nao substitui a do banco - substitui a confianca no
 * frontend. Os CHECKs, os indices UNIQUE e os gatilhos continuam sendo a ultima
 * palavra; estes esquemas existem para a mensagem de erro ser util e para que
 * um campo com nome errado nao chegue a virar SQL.
 */
import { z } from 'zod';

const paginacao = {
  limite: z.coerce.number().int().min(1).max(200).optional(),
  pagina: z.coerce.number().int().min(1).optional(),
};

const texto = (min: number, max: number) => z.string().trim().min(min).max(max);

export const idParam = z.object({ id: z.coerce.number().int().positive() });
export const codigoParam = z.object({ codigo: texto(2, 60) });
export const correlationParam = z.object({ correlation_id: z.string().uuid() });

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

export const listarEventosSchema = z.object({
  tipo: texto(2, 60).optional(),
  origem: texto(2, 30).optional(),
  status: z.enum(['NOVO', 'PROCESSADO', 'ERRO', 'IGNORADO']).optional(),
  entidade: texto(2, 40).optional(),
  correlation_id: z.string().uuid().optional(),
  ...paginacao,
});

export const registrarEventoSchema = z.object({
  tipo: texto(2, 60),
  origem: z.enum(['ESTOQUE', 'COMPRAS', 'COTACOES', 'PEDIDOS', 'LOGISTICA',
    'RECEBIMENTO', 'QUALIDADE', 'FORNECEDORES', 'DEMANDA', 'BI', 'IA',
    'INTEGRACAO', 'SISTEMA']),
  entidade: texto(2, 40).optional(),
  entidade_id: z.coerce.number().int().positive().optional(),
  payload: z.record(z.unknown()).optional(),
  chave: texto(4, 200).optional(),
});

// ---------------------------------------------------------------------------
// Regras
// ---------------------------------------------------------------------------

const condicaoSchema = z.object({
  campo: texto(1, 80),
  operador: z.enum(['=', '!=', '>', '>=', '<', '<=', 'in', 'nin',
    'contem', 'existe', 'vazio', 'entre']),
  valor: z.unknown().optional(),
});

export const listarRegrasSchema = z.object({
  evento: texto(2, 60).optional(),
  ativo: z.coerce.boolean().optional(),
  acao: texto(2, 40).optional(),
});

export const criarRegraSchema = z.object({
  codigo: texto(2, 60).regex(/^[A-Za-z0-9_]+$/,
    'Use apenas letras, numeros e sublinhado'),
  nome: texto(3, 120),
  descricao: texto(3, 500).optional(),
  evento: texto(2, 60),
  condicao: z.array(condicaoSchema).max(20).optional(),
  acao: texto(2, 40),
  parametros: z.record(z.unknown()).optional(),
  nivel: z.enum(['AUTOMATICO', 'ASSISTIDO', 'APROVACAO']).optional(),
  prioridade: z.coerce.number().int().min(1).max(1000).optional(),
  perfil_autorizado: texto(2, 40).optional(),
  max_tentativas: z.coerce.number().int().min(1).max(10).optional(),
  ativo: z.coerce.boolean().optional(),
});

export const atualizarRegraSchema = criarRegraSchema.partial().omit({ codigo: true });

export const simularRegraSchema = z.object({
  payload: z.record(z.unknown()),
});

// ---------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------

export const listarFilaSchema = z.object({
  status: z.enum(['PENDENTE', 'PROCESSANDO', 'CONCLUIDO', 'ERRO', 'RETRY', 'CANCELADO'])
    .optional(),
  acao: texto(2, 40).optional(),
  dead_letter: z.coerce.boolean().optional(),
  correlation_id: z.string().uuid().optional(),
  ...paginacao,
});

export const processarSchema = z.object({
  lote: z.coerce.number().int().min(1).max(200).optional(),
});

export const cancelarSchema = z.object({
  motivo: texto(3, 500),
});

// ---------------------------------------------------------------------------
// Acoes avulsas
// ---------------------------------------------------------------------------

export const executarAcaoSchema = z.object({
  acao: texto(2, 40),
  nivel: z.enum(['AUTOMATICO', 'ASSISTIDO', 'APROVACAO']),
  evento_tipo: texto(2, 60),
  entidade: texto(2, 40).optional(),
  entidade_id: z.coerce.number().int().positive().optional(),
  payload: z.record(z.unknown()).optional(),
  parametros: z.record(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Tarefas
// ---------------------------------------------------------------------------

export const listarTarefasSchema = z.object({
  status: z.enum(['PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDA', 'CANCELADA']).optional(),
  tipo: texto(2, 60).optional(),
  prioridade: z.enum(['CRITICA', 'ALTA', 'MEDIA', 'BAIXA']).optional(),
  responsavel_id: z.coerce.number().int().positive().optional(),
  perfil_destino: texto(2, 40).optional(),
  sla_status: z.enum(['DENTRO', 'EM_RISCO', 'VENCIDO', 'CUMPRIDO']).optional(),
  abertas: z.coerce.boolean().optional(),
  correlation_id: z.string().uuid().optional(),
  ...paginacao,
});

export const criarTarefaSchema = z.object({
  tipo: texto(2, 60),
  titulo: texto(3, 200),
  descricao: texto(3, 2000).optional(),
  acao_sugerida: texto(3, 500).optional(),
  responsavel_id: z.coerce.number().int().positive().optional(),
  perfil_destino: texto(2, 40).optional(),
  prioridade: z.enum(['CRITICA', 'ALTA', 'MEDIA', 'BAIXA']).optional(),
  entidade: texto(2, 40).optional(),
  entidade_id: z.coerce.number().int().positive().optional(),
  link: texto(1, 300).optional(),
  sla: texto(2, 60).optional(),
  sla_horas: z.coerce.number().int().min(1).max(8760).optional(),
});

export const concluirTarefaSchema = z.object({
  observacao: texto(3, 1000).optional(),
});

export const reatribuirSchema = z.object({
  responsavel_id: z.coerce.number().int().positive().nullable().optional(),
  perfil_destino: texto(2, 40).optional(),
});

// ---------------------------------------------------------------------------
// Aprovacoes
// ---------------------------------------------------------------------------

export const listarAprovacoesSchema = z.object({
  status: z.enum(['PENDENTE', 'APROVADA', 'REJEITADA', 'DISPENSADA']).optional(),
  tipo: texto(2, 60).optional(),
  excecao: z.coerce.boolean().optional(),
  perfil_exigido: texto(2, 40).optional(),
  entidade: texto(2, 40).optional(),
  correlation_id: z.string().uuid().optional(),
  ...paginacao,
});

export const solicitarAprovacaoSchema = z.object({
  tipo: texto(2, 60),
  titulo: texto(3, 200),
  descricao: texto(3, 2000).optional(),
  entidade: texto(2, 40),
  entidade_id: z.coerce.number().int().positive().optional(),
  valor_avaliado: z.coerce.number().min(0).optional(),
  perfil_exigido: texto(2, 40).optional(),
  excecao: z.coerce.boolean().optional(),
  motivo_excecao: texto(5, 1000).optional(),
  impacto: texto(3, 1000).optional(),
  contexto: z.record(z.unknown()).optional(),
});

/** Aprovar aceita justificativa opcional; rejeitar e dispensar exigem motivo. */
export const aprovarSchema = z.object({
  justificativa: texto(3, 1000).optional(),
});

export const decidirSchema = z.object({
  justificativa: texto(3, 1000),
});

// ---------------------------------------------------------------------------
// Jobs, detectores e integracoes
// ---------------------------------------------------------------------------

export const historicoJobSchema = z.object({
  codigo: texto(2, 60).optional(),
  ...paginacao,
});

export const alternarSchema = z.object({
  ativo: z.coerce.boolean(),
});

export const rodarDetectoresSchema = z.object({
  detectores: z.array(texto(2, 40)).min(1).max(20).optional(),
  grupo: z.enum(['critico', 'estoque', 'pedidos', 'fornecedores', 'ia', 'todos'])
    .optional(),
});

export const segredoSchema = z.object({
  // O minimo de 16 e a mesma regra do servico. Repetida aqui so para o erro
  // chegar como validacao de campo, nao como erro de negocio generico.
  segredo: z.string().min(16).max(200),
});

export const webhookSchema = z.object({
  evento: texto(1, 80).optional(),
  chave_idempotencia: texto(4, 200).optional(),
  timestamp: z.string().optional(),
}).passthrough();

export const listarWebhooksSchema = z.object({
  integracao: texto(2, 60).optional(),
  status: z.enum(['RECEBIDO', 'PROCESSADO', 'REJEITADO', 'DUPLICADO', 'ERRO']).optional(),
  ...paginacao,
});

// ---------------------------------------------------------------------------
// Monitoramento e notificacoes
// ---------------------------------------------------------------------------

export const periodoSchema = z.object({
  dias: z.coerce.number().int().min(1).max(365).optional(),
});

export const listarNotificacoesSchema = z.object({
  lida: z.coerce.boolean().optional(),
  canal: z.enum(['SISTEMA', 'EMAIL', 'WHATSAPP', 'WEBHOOK']).optional(),
  status: z.enum(['PENDENTE', 'ENVIADA', 'FALHOU', 'DESCARTADA']).optional(),
  ...paginacao,
});

export const configuracaoSchema = z.object({
  valor: z.string().trim().min(1).max(500),
});
