import { z } from 'zod';
import { paginacaoSchema } from '../../core/paginacao.js';
import { dataCalendario } from '../../core/datas.js';

const id = z.coerce.number().int().positive();
const idOpcional = id.optional();
const naoNegativo = z.coerce.number().nonnegative();
const data = dataCalendario;

export const STATUS_LOGISTICO = [
  'AGUARDANDO_CONFIRMACAO', 'AGUARDANDO_PRODUCAO', 'EM_PRODUCAO',
  'PRONTO_EXPEDICAO', 'EXPEDIDO', 'EM_TRANSITO', 'CHEGOU_DESTINO',
  'AGUARDANDO_RECEBIMENTO', 'RECEBIDO', 'ENTREGA_PARCIAL',
  'ATRASADO', 'CANCELADO',
] as const;

export const STATUS_ENTREGA = [
  'PENDENTE', 'CONFIRMADA', 'EM_TRANSITO', 'PARCIAL', 'ENTREGUE', 'ATRASADA', 'CANCELADA',
] as const;

export const STATUS_OCORRENCIA = [
  'ABERTA', 'EM_TRATAMENTO', 'AGUARDANDO_FORNECEDOR', 'RESOLVIDA', 'CANCELADA',
] as const;

export const PRIORIDADES = ['CRITICA', 'ALTA', 'MEDIA', 'BAIXA'] as const;

export const MODAIS = [
  'RODOVIARIO', 'MARITIMO', 'AEREO', 'FERROVIARIO', 'MULTIMODAL', 'OUTRO',
] as const;

export const CANAIS = ['EMAIL', 'TELEFONE', 'WHATSAPP', 'PORTAL', 'REUNIAO', 'OUTRO'] as const;

export const TIPOS_ACAO = [
  'COBRAR_FORNECEDOR', 'SOLICITAR_NOVA_PREVISAO', 'SOLICITAR_ENTREGA_PARCIAL',
  'ALTERAR_TRANSPORTADORA', 'BUSCAR_FORNECEDOR_ALTERNATIVO', 'CRIAR_NOVA_COTACAO',
  'ANTECIPAR_PRODUCAO', 'TRANSFERIR_ESTOQUE', 'PRIORIZAR_RECEBIMENTO', 'OUTRA',
] as const;

export const TIPOS_DOCUMENTO = [
  'PEDIDO', 'CONFIRMACAO', 'NOTA_FISCAL', 'CONHECIMENTO_TRANSPORTE',
  'COMPROVANTE', 'DOCUMENTO_EMBARQUE', 'EMAIL', 'OUTRO',
] as const;

// --- Acompanhamento ---------------------------------------------------------

export const listarAcompanhamentoSchema = paginacaoSchema.extend({
  fornecedor_id: idOpcional,
  produto_id: idOpcional,
  categoria_id: idOpcional,
  comprador_id: idOpcional,
  status: z.enum([
    'RASCUNHO', 'AGUARDANDO_APROVACAO', 'APROVADA', 'ENVIADA', 'CONFIRMADA',
    'EM_PRODUCAO', 'EM_TRANSITO', 'RECEBIMENTO_PARCIAL', 'RECEBIDA',
    'FINALIZADA', 'CANCELADA', 'REJEITADA', 'BLOQUEADA',
  ]).optional(),
  status_logistico: z.enum(STATUS_LOGISTICO).optional(),
  situacao: z.enum(['NO_PRAZO', 'EM_RISCO', 'ATRASADO', 'ENTREGUE', 'SEM_DADOS']).optional(),
  prioridade: z.enum(PRIORIDADES).optional(),
  origem: z.enum(['NACIONAL', 'IMPORTADO']).optional(),
  data_necessaria_ate: data.optional(),
  data_prometida_ate: data.optional(),
  data_inicio: data.optional(),
  data_fim: data.optional(),
  apenas_atrasados: z.coerce.boolean().optional(),
  apenas_em_risco: z.coerce.boolean().optional(),
  apenas_parciais: z.coerce.boolean().optional(),
  apenas_sem_confirmacao: z.coerce.boolean().optional(),
  apenas_sem_previsao: z.coerce.boolean().optional(),
  apenas_em_transito: z.coerce.boolean().optional(),
  dias_atraso_minimo: z.coerce.number().int().optional(),
});

export const periodoSchema = z.object({
  dias: z.coerce.number().int().min(1).max(1095).default(90),
  data_inicio: data.optional(),
  data_fim: data.optional(),
  fornecedor_id: idOpcional,
  comprador_id: idOpcional,
  categoria_id: idOpcional,
});

export const calendarioSchema = z.object({
  data_inicio: data.optional(),
  data_fim: data.optional(),
  dias: z.coerce.number().int().min(1).max(180).default(30),
  fornecedor_id: idOpcional,
  produto_id: idOpcional,
  categoria_id: idOpcional,
  local_id: idOpcional,
  comprador_id: idOpcional,
  limite: z.coerce.number().int().min(1).max(500).default(300),
});

// --- Confirmacao e prazo ----------------------------------------------------

export const alterarPrazoSchema = z.object({
  ordem_compra_item_id: idOpcional,
  campo: z.enum(['DATA_PROMETIDA', 'DATA_PREVISTA_ENTREGA', 'ETA']).default('DATA_PROMETIDA'),
  data_nova: data,
  motivo_atraso_id: idOpcional,
  motivo_codigo: z.string().trim().max(40).optional(),
  justificativa: z.string().trim().min(5).max(2000),
  origem: z.enum(['FORNECEDOR', 'TRANSPORTADORA', 'INTERNA', 'SISTEMA', 'OUTRO']).default('FORNECEDOR'),
});

export const previsaoSchema = z.object({
  eta: data.optional(),
  justificativa: z.string().trim().max(2000).optional(),
  recalcular: z.coerce.boolean().default(false),
}).refine((v) => v.recalcular || v.eta !== undefined, {
  message: 'Informe a nova ETA ou peca o recalculo',
});

export const statusLogisticoSchema = z.object({
  status: z.enum(STATUS_LOGISTICO),
  justificativa: z.string().trim().max(1000).optional(),
  entrega_id: idOpcional,
});

// --- Entregas ---------------------------------------------------------------

export const registrarEntregaSchema = z.object({
  ordem_compra_id: id,
  data_real: data.optional(),
  data_prevista: data.optional(),
  horario_previsto: z.string().trim().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  local_id: idOpcional,
  programacao_id: idOpcional,
  transporte_id: idOpcional,
  transportadora: z.string().trim().max(160).optional(),
  codigo_rastreio: z.string().trim().max(80).optional(),
  numero_nota_fiscal: z.string().trim().max(60).optional(),
  chave_nfe: z.string().trim().max(60).optional(),
  motivo_atraso_id: idOpcional,
  motivo_codigo: z.string().trim().max(40).optional(),
  observacao: z.string().trim().max(2000).optional(),
  itens: z.array(z.object({
    ordem_compra_item_id: id,
    quantidade: z.coerce.number().positive(),
    lote_id: idOpcional,
    observacao: z.string().trim().max(500).optional(),
  })).min(1).max(500),
});

export const editarEntregaSchema = z.object({
  data_prevista: data.optional(),
  data_real: data.optional(),
  horario_previsto: z.string().trim().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  transportadora: z.string().trim().max(160).optional(),
  codigo_rastreio: z.string().trim().max(80).optional(),
  numero_nota_fiscal: z.string().trim().max(60).optional(),
  chave_nfe: z.string().trim().max(60).optional(),
  motivo_atraso_id: idOpcional,
  observacao: z.string().trim().max(2000).optional(),
});

export const listarEntregasSchema = paginacaoSchema.extend({
  ordem_compra_id: idOpcional,
  fornecedor_id: idOpcional,
  status: z.enum(STATUS_ENTREGA).optional(),
  data_inicio: data.optional(),
  data_fim: data.optional(),
  apenas_pendentes_recebimento: z.coerce.boolean().optional(),
});

export const programarSchema = z.object({
  ordem_compra_id: id,
  data_prevista: data,
  horario_previsto: z.string().trim().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  local_id: idOpcional,
  transportadora: z.string().trim().max(160).optional(),
  modal: z.enum(MODAIS).optional(),
  observacao: z.string().trim().max(2000).optional(),
  itens: z.array(z.object({
    ordem_compra_item_id: id,
    quantidade: z.coerce.number().positive(),
  })).min(1).max(500),
});

export const transporteSchema = z.object({
  transportadora: z.string().trim().max(160).optional(),
  modal: z.enum(MODAIS).optional(),
  veiculo: z.string().trim().max(60).optional(),
  motorista: z.string().trim().max(120).optional(),
  documento: z.string().trim().max(60).optional(),
  codigo_rastreio: z.string().trim().max(80).optional(),
  origem: z.string().trim().max(160).optional(),
  destino: z.string().trim().max(160).optional(),
  data_coleta: data.optional(),
  data_prevista: data.optional(),
  data_efetiva: data.optional(),
  incoterm: z.string().trim().max(10).optional(),
  porto_origem: z.string().trim().max(120).optional(),
  porto_destino: z.string().trim().max(120).optional(),
  data_embarque: data.optional(),
  eta_porto: data.optional(),
  data_desembaraco: data.optional(),
  eta_final: data.optional(),
  observacao: z.string().trim().max(2000).optional(),
});

// --- Ocorrencias, acoes e contatos ------------------------------------------

export const ocorrenciaSchema = z.object({
  ordem_compra_id: id,
  ordem_compra_item_id: idOpcional,
  entrega_id: idOpcional,
  tipo: z.string().trim().min(2).max(60),
  descricao: z.string().trim().min(5).max(2000),
  motivo_atraso_id: idOpcional,
  motivo_codigo: z.string().trim().max(40).optional(),
  prioridade: z.enum(PRIORIDADES).default('MEDIA'),
  responsavel_id: idOpcional,
});

export const tratarOcorrenciaSchema = z.object({
  status: z.enum(STATUS_OCORRENCIA),
  solucao: z.string().trim().max(2000).optional(),
  responsavel_id: idOpcional,
  observacao: z.string().trim().max(1000).optional(),
}).refine((v) => v.status !== 'RESOLVIDA' || (v.solucao && v.solucao.length >= 5), {
  message: 'Ocorrencia resolvida exige a descricao da solucao',
});

export const listarOcorrenciasSchema = paginacaoSchema.extend({
  ordem_compra_id: idOpcional,
  fornecedor_id: idOpcional,
  status: z.enum(STATUS_OCORRENCIA).optional(),
  prioridade: z.enum(PRIORIDADES).optional(),
  apenas_sla_vencido: z.coerce.boolean().optional(),
});

export const acaoSchema = z.object({
  ordem_compra_id: id,
  ocorrencia_id: idOpcional,
  tipo: z.enum(TIPOS_ACAO),
  descricao: z.string().trim().max(1000).optional(),
  responsavel_id: idOpcional,
  prazo: data.optional(),
  observacao: z.string().trim().max(1000).optional(),
});

export const concluirAcaoSchema = z.object({
  status: z.enum(['EM_ANDAMENTO', 'CONCLUIDA', 'CANCELADA']),
  resultado: z.string().trim().max(1000).optional(),
});

export const contatoSchema = z.object({
  ordem_compra_id: id,
  ocorrencia_id: idOpcional,
  canal: z.enum(CANAIS),
  assunto: z.string().trim().min(3).max(200),
  resposta: z.string().trim().max(2000).optional(),
  nova_previsao: data.optional(),
  observacao: z.string().trim().max(1000).optional(),
});

export const documentoSchema = z.object({
  ordem_compra_id: id,
  entrega_id: idOpcional,
  tipo: z.enum(TIPOS_DOCUMENTO),
  numero: z.string().trim().max(60).optional(),
  descricao: z.string().trim().max(500).optional(),
  referencia: z.string().trim().max(500).optional(),
  emitido_em: data.optional(),
});

export const parametrosSchema = z.object({
  parametros: z.array(z.object({
    chave: z.string().trim().min(3).max(80),
    valor: z.string().trim().min(1).max(200),
  })).min(1).max(40),
});

export type RegistrarEntrega = z.output<typeof registrarEntregaSchema>;
export type Programar = z.output<typeof programarSchema>;
export type AlterarPrazo = z.output<typeof alterarPrazoSchema>;
export type Ocorrencia = z.output<typeof ocorrenciaSchema>;
