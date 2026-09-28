import { z } from 'zod';
import { paginacaoSchema } from '../../core/paginacao.js';
import { dataCalendario } from '../../core/datas.js';

const id = z.coerce.number().int().positive();
const idOpcional = id.optional();
const naoNegativo = z.coerce.number().nonnegative();
const data = dataCalendario;

export const STATUS_RECEBIMENTO = [
  'AGUARDANDO_CHEGADA', 'CHEGOU', 'EM_CONFERENCIA', 'AGUARDANDO_QUALIDADE',
  'APROVADO', 'APROVADO_PARCIALMENTE', 'REJEITADO', 'QUARENTENA',
  'DEVOLVIDO', 'CONCLUIDO', 'DIVERGENTE', 'CANCELADO',
] as const;

export const RESPOSTAS = ['APROVADO', 'REPROVADO', 'NAO_APLICAVEL'] as const;

export const TIPOS_DIVERGENCIA = [
  'QUANTIDADE_MENOR', 'QUANTIDADE_MAIOR', 'PRODUTO_DIFERENTE', 'PRECO_DIVERGENTE',
  'LOTE_DIVERGENTE', 'LOTE_AUSENTE', 'VALIDADE_DIVERGENTE', 'EMBALAGEM_DANIFICADA',
  'PRODUTO_CONTAMINADO', 'PRODUTO_VENCIDO', 'DOCUMENTACAO_DIVERGENTE', 'NF_DIVERGENTE',
] as const;

export const DECISOES_DIVERGENCIA = [
  'ACEITAR', 'ACEITAR_PARCIAL', 'DEVOLVER', 'RECUSAR', 'AUTORIZAR_COMERCIAL',
] as const;

export const TIPOS_NC = [
  'QUALIDADE', 'QUANTIDADE', 'PRECO', 'EMBALAGEM', 'VALIDADE', 'DOCUMENTACAO',
  'PRODUTO_INCORRETO', 'LOTE', 'PESO', 'IMPOSTO', 'AVARIA', 'TRANSPORTE',
  'TEMPERATURA', 'DIVERGENCIA_FISCAL', 'DIVERGENCIA_COMERCIAL',
  'ESPECIFICACAO_TECNICA', 'OUTRO',
] as const;

export const STATUS_NC = [
  'ABERTA', 'EM_ANALISE', 'ACAO_DEFINIDA', 'AGUARDANDO_FORNECEDOR',
  'EM_TRATATIVA', 'RESOLVIDA', 'VALIDADA', 'ENCERRADA', 'CANCELADA',
] as const;

export const SEVERIDADES = ['CRITICA', 'ALTA', 'MEDIA', 'BAIXA'] as const;

export const ACOES_NC = [
  'DEVOLUCAO', 'ABATIMENTO', 'RETRABALHO', 'ACEITE_CONDICIONAL',
  'DESCARTE', 'SUBSTITUICAO', 'NENHUMA',
] as const;

export const MOTIVOS_DEVOLUCAO = [
  'QUALIDADE', 'VALIDADE', 'QUANTIDADE', 'PRODUTO_INCORRETO', 'AVARIA',
  'DOCUMENTACAO', 'CONDICAO_COMERCIAL', 'DIVERGENCIA_FISCAL',
] as const;

export const TIPOS_ANEXO = [
  'FOTO', 'NOTA_FISCAL', 'LAUDO', 'CERTIFICADO_ANALISE', 'DOCUMENTO',
  'COMPROVANTE', 'EVIDENCIA_AVARIA', 'EVIDENCIA_DIVERGENCIA', 'OUTRO',
] as const;

export const TIPOS_EXCECAO = [
  'VALIDADE_ABAIXO_MINIMO', 'EXCESSO_QUANTIDADE', 'PRECO_DIVERGENTE',
  'PRODUTO_DIVERGENTE', 'QUALIDADE_COM_RESTRICAO', 'LIBERACAO_QUARENTENA',
  'DEVOLUCAO', 'FORA_TOLERANCIA',
] as const;

export const DESTINOS = [
  'DISPONIVEL', 'QUARENTENA', 'BLOQUEADO', 'AREA_RECEBIMENTO', 'RECUSADO',
] as const;

// --- Recebimento ------------------------------------------------------------

export const criarRecebimentoSchema = z.object({
  origem: z.enum(['ENTREGA', 'PEDIDO', 'PROGRAMACAO', 'NOTA_FISCAL', 'TRANSPORTE', 'MANUAL'])
    .default('ENTREGA'),
  entrega_id: idOpcional,
  ordem_compra_id: idOpcional,
  fornecedor_id: idOpcional,
  local_id: idOpcional,
  data_prevista: data.optional(),
  numero_nota_fiscal: z.string().trim().max(60).optional(),
  serie_nota_fiscal: z.string().trim().max(10).optional(),
  chave_nfe: z.string().trim().max(60).optional(),
  valor_nota: naoNegativo.optional(),
  volumes: z.coerce.number().int().positive().optional(),
  transportadora: z.string().trim().max(160).optional(),
  placa: z.string().trim().max(12).optional(),
  motorista: z.string().trim().max(120).optional(),
  doca: z.string().trim().max(40).optional(),
  tipo_operacao: z.string().trim().max(40).default('COMPRA'),
  observacao: z.string().trim().max(2000).optional(),
  itens: z.array(z.object({
    ordem_compra_item_id: idOpcional,
    entrega_item_id: idOpcional,
    produto_id: id,
    quantidade_pedida: naoNegativo.optional(),
    preco_unitario: naoNegativo.optional(),
  })).max(500).optional(),
}).refine(
  (v) => v.entrega_id || v.ordem_compra_id || (v.fornecedor_id && v.itens?.length),
  { message: 'Informe a entrega, o pedido, ou fornecedor e itens para recebimento manual' },
);

export const editarRecebimentoSchema = z.object({
  numero_nota_fiscal: z.string().trim().max(60).optional(),
  serie_nota_fiscal: z.string().trim().max(10).optional(),
  chave_nfe: z.string().trim().max(60).optional(),
  valor_nota: naoNegativo.optional(),
  volumes: z.coerce.number().int().positive().optional(),
  transportadora: z.string().trim().max(160).optional(),
  placa: z.string().trim().max(12).optional(),
  motorista: z.string().trim().max(120).optional(),
  doca: z.string().trim().max(40).optional(),
  local_id: idOpcional,
  observacao: z.string().trim().max(2000).optional(),
});

export const listarRecebimentosSchema = paginacaoSchema.extend({
  status: z.enum(STATUS_RECEBIMENTO).optional(),
  fornecedor_id: idOpcional,
  ordem_compra_id: idOpcional,
  produto_id: idOpcional,
  local_id: idOpcional,
  data_inicio: data.optional(),
  data_fim: data.optional(),
  numero_nota_fiscal: z.string().trim().max(60).optional(),
  numero_lote: z.string().trim().max(60).optional(),
  apenas_hoje: z.coerce.boolean().optional(),
  apenas_pendentes: z.coerce.boolean().optional(),
  apenas_divergentes: z.coerce.boolean().optional(),
  apenas_quarentena: z.coerce.boolean().optional(),
  apenas_validade_critica: z.coerce.boolean().optional(),
});

export const chegadaSchema = z.object({
  data_chegada: z.coerce.date().optional(),
  transportadora: z.string().trim().max(160).optional(),
  placa: z.string().trim().max(12).optional(),
  motorista: z.string().trim().max(120).optional(),
  doca: z.string().trim().max(40).optional(),
  volumes: z.coerce.number().int().positive().optional(),
  observacao: z.string().trim().max(1000).optional(),
});

// --- Conferencia ------------------------------------------------------------

export const conferenciaDocumentosSchema = z.object({
  itens: z.array(z.object({
    item: z.string().trim().min(2).max(60),
    descricao: z.string().trim().max(200).optional(),
    resposta: z.enum(RESPOSTAS),
    observacao: z.string().trim().max(500).optional(),
  })).min(1).max(40),
});

export const conferirItemSchema = z.object({
  quantidade_recebida: naoNegativo,
  quantidade_conferida: naoNegativo.optional(),
  numero_lote: z.string().trim().max(60).optional(),
  data_fabricacao: data.optional(),
  data_validade: data.optional(),
  local_id: idOpcional,
  localizacao: z.string().trim().max(80).optional(),
  preco_unitario: naoNegativo.optional(),
  observacao: z.string().trim().max(1000).optional(),
});

export const conferenciaLoteSchema = z.object({
  itens: z.array(conferirItemSchema.extend({
    recebimento_item_id: id,
  })).min(1).max(500),
});

/** Conferencia por codigo de barras (secao 11). */
export const escanearSchema = z.object({
  codigo: z.string().trim().min(1).max(80),
  quantidade: z.coerce.number().positive().optional(),
});

// --- Qualidade --------------------------------------------------------------

export const inspecaoSchema = z.object({
  recebimento_item_id: idOpcional,
  checklist_id: idOpcional,
  checklist_codigo: z.string().trim().max(40).optional(),
  tipo_amostragem: z.enum(['TOTAL', 'AMOSTRAGEM', 'LOTE', 'PERCENTUAL']).optional(),
  quantidade_amostrada: naoNegativo.optional(),
  quantidade_aprovada: naoNegativo.optional(),
  quantidade_reprovada: naoNegativo.optional(),
  quantidade_quarentena: naoNegativo.optional(),
  restricao: z.string().trim().max(1000).optional(),
  observacoes: z.string().trim().max(2000).optional(),
  respostas: z.array(z.object({
    criterio: z.string().trim().min(2).max(60),
    resposta: z.enum(RESPOSTAS),
    observacao: z.string().trim().max(500).optional(),
  })).min(1).max(60),
});

export const quarentenaSchema = z.object({
  recebimento_item_id: id,
  quantidade: z.coerce.number().positive(),
  motivo: z.string().trim().min(5).max(1000),
});

export const decidirQuarentenaSchema = z.object({
  decisao: z.enum(['LIBERAR', 'REJEITAR', 'DEVOLVER']),
  quantidade: z.coerce.number().positive().optional(),
  justificativa: z.string().trim().min(5).max(2000),
});

// --- Divergencias -----------------------------------------------------------

export const divergenciaSchema = z.object({
  recebimento_item_id: idOpcional,
  tipo: z.enum(TIPOS_DIVERGENCIA),
  severidade: z.enum(SEVERIDADES).default('MEDIA'),
  descricao: z.string().trim().min(5).max(2000),
  valor_esperado: z.string().trim().max(200).optional(),
  valor_recebido: z.string().trim().max(200).optional(),
});

export const decidirDivergenciaSchema = z.object({
  decisao: z.enum(DECISOES_DIVERGENCIA),
  justificativa: z.string().trim().min(5).max(2000),
  abrir_nao_conformidade: z.coerce.boolean().default(false),
});

export const listarDivergenciasSchema = paginacaoSchema.extend({
  recebimento_id: idOpcional,
  fornecedor_id: idOpcional,
  tipo: z.enum(TIPOS_DIVERGENCIA).optional(),
  severidade: z.enum(SEVERIDADES).optional(),
  apenas_pendentes: z.coerce.boolean().optional(),
  data_inicio: data.optional(),
  data_fim: data.optional(),
});

// --- Aprovacao --------------------------------------------------------------

export const aprovarSchema = z.object({
  justificativa: z.string().trim().max(2000).optional(),
  excecoes: z.array(z.object({
    tipo: z.enum(TIPOS_EXCECAO),
    recebimento_item_id: idOpcional,
    descricao: z.string().trim().min(5).max(500),
    justificativa: z.string().trim().min(5).max(1000),
  })).max(30).optional(),
});

export const rejeitarSchema = z.object({
  justificativa: z.string().trim().min(5).max(2000),
  abrir_nao_conformidade: z.coerce.boolean().default(true),
  severidade: z.enum(SEVERIDADES).default('ALTA'),
});

// --- Nao conformidades ------------------------------------------------------

export const ncSchema = z.object({
  recebimento_id: idOpcional,
  recebimento_item_id: idOpcional,
  divergencia_id: idOpcional,
  produto_id: idOpcional,
  fornecedor_id: idOpcional,
  lote_id: idOpcional,
  inspecao_id: idOpcional,
  tipo: z.enum(TIPOS_NC),
  severidade: z.enum(SEVERIDADES).default('MEDIA'),
  descricao: z.string().trim().min(5).max(2000),
  quantidade_afetada: naoNegativo.optional(),
  valor_impacto: naoNegativo.optional(),
  causa: z.string().trim().max(1000).optional(),
  prazo: data.optional(),
  responsavel_id: idOpcional,
}).refine((v) => v.recebimento_id || v.fornecedor_id, {
  message: 'Informe o recebimento ou o fornecedor da nao conformidade',
});

export const tratarNcSchema = z.object({
  status: z.enum(STATUS_NC),
  acao: z.enum(ACOES_NC).optional(),
  causa: z.string().trim().max(1000).optional(),
  observacao: z.string().trim().max(2000).optional(),
  responsavel_id: idOpcional,
}).refine(
  (v) => !['RESOLVIDA', 'VALIDADA', 'ENCERRADA'].includes(v.status)
    || (v.observacao && v.observacao.length >= 5),
  { message: 'Encerrar ou resolver a nao conformidade exige descrever o desfecho' },
);

export const acaoNcSchema = z.object({
  tipo: z.enum(['CORRETIVA', 'PREVENTIVA', 'CONTENCAO']),
  descricao: z.string().trim().min(5).max(1000),
  responsavel_id: idOpcional,
  prazo: data.optional(),
  evidencia: z.string().trim().max(500).optional(),
});

export const concluirAcaoNcSchema = z.object({
  status: z.enum(['EM_ANDAMENTO', 'CONCLUIDA', 'CANCELADA']),
  resultado: z.string().trim().max(1000).optional(),
});

export const listarNcSchema = paginacaoSchema.extend({
  recebimento_id: idOpcional,
  fornecedor_id: idOpcional,
  produto_id: idOpcional,
  tipo: z.enum(TIPOS_NC).optional(),
  severidade: z.enum(SEVERIDADES).optional(),
  status: z.enum(STATUS_NC).optional(),
  apenas_abertas: z.coerce.boolean().optional(),
  data_inicio: data.optional(),
  data_fim: data.optional(),
});

// --- Devolucao --------------------------------------------------------------

export const devolucaoSchema = z.object({
  recebimento_id: idOpcional,
  ordem_compra_id: idOpcional,
  fornecedor_id: idOpcional,
  motivo: z.enum(MOTIVOS_DEVOLUCAO),
  descricao: z.string().trim().max(2000).optional(),
  numero_nota_fiscal: z.string().trim().max(60).optional(),
  transportadora: z.string().trim().max(160).optional(),
  data_devolucao: data.optional(),
  itens: z.array(z.object({
    recebimento_item_id: idOpcional,
    produto_id: id,
    lote_id: idOpcional,
    quantidade: z.coerce.number().positive(),
    preco_unitario: naoNegativo.optional(),
    observacao: z.string().trim().max(500).optional(),
  })).min(1).max(500),
}).refine((v) => v.recebimento_id || v.fornecedor_id, {
  message: 'Informe o recebimento ou o fornecedor da devolucao',
});

export const autorizarDevolucaoSchema = z.object({
  justificativa: z.string().trim().min(5).max(2000),
});

export const listarDevolucoesSchema = paginacaoSchema.extend({
  fornecedor_id: idOpcional,
  status: z.enum(['RASCUNHO', 'AUTORIZADA', 'EM_TRANSITO', 'CONCLUIDA', 'CANCELADA']).optional(),
  motivo: z.enum(MOTIVOS_DEVOLUCAO).optional(),
  data_inicio: data.optional(),
  data_fim: data.optional(),
});

// --- Anexos, checklists e parametros ---------------------------------------

export const anexoSchema = z.object({
  recebimento_id: idOpcional,
  recebimento_item_id: idOpcional,
  nao_conformidade_id: idOpcional,
  inspecao_id: idOpcional,
  lote_id: idOpcional,
  tipo: z.enum(TIPOS_ANEXO),
  nome: z.string().trim().min(1).max(200),
  descricao: z.string().trim().max(500).optional(),
  referencia: z.string().trim().max(500).optional(),
}).refine(
  (v) => v.recebimento_id || v.nao_conformidade_id || v.inspecao_id,
  { message: 'O anexo precisa estar vinculado a um recebimento, NC ou inspecao' },
);

export const checklistSchema = z.object({
  codigo: z.string().trim().min(2).max(40),
  nome: z.string().trim().min(2).max(120),
  descricao: z.string().trim().max(500).optional(),
  categoria_id: idOpcional,
  tipo_amostragem: z.enum(['TOTAL', 'AMOSTRAGEM', 'LOTE', 'PERCENTUAL']).default('AMOSTRAGEM'),
  percentual_amostra: z.coerce.number().positive().max(100).optional(),
  itens: z.array(z.object({
    criterio: z.string().trim().min(2).max(60),
    descricao: z.string().trim().max(200).optional(),
    eliminatorio: z.coerce.boolean().default(false),
  })).min(1).max(60),
});

export const toleranciaSchema = z.object({
  escopo: z.enum(['EMPRESA', 'CATEGORIA', 'PRODUTO', 'FORNECEDOR', 'OPERACAO']),
  produto_id: idOpcional,
  categoria_id: idOpcional,
  fornecedor_id: idOpcional,
  tipo_operacao: z.string().trim().max(40).optional(),
  quantidade_percentual: naoNegativo.max(100).default(0),
  peso_percentual: naoNegativo.max(100).default(0),
  valor_percentual: naoNegativo.max(100).default(0),
  validade_dias: z.coerce.number().int().nonnegative().default(0),
  observacao: z.string().trim().max(500).optional(),
});

export const parametrosSchema = z.object({
  parametros: z.array(z.object({
    chave: z.string().trim().min(3).max(80),
    valor: z.string().trim().min(1).max(200),
  })).min(1).max(40),
});

export const periodoSchema = z.object({
  dias: z.coerce.number().int().min(1).max(1095).default(90),
  data_inicio: data.optional(),
  data_fim: data.optional(),
  fornecedor_id: idOpcional,
  categoria_id: idOpcional,
});

export type CriarRecebimento = z.output<typeof criarRecebimentoSchema>;
export type ConferirItem = z.output<typeof conferirItemSchema>;
export type Inspecao = z.output<typeof inspecaoSchema>;
export type Devolucao = z.output<typeof devolucaoSchema>;

// --- Itens avulsos ----------------------------------------------------------

export const adicionarItemSchema = z.object({
  produto_id: id,
  ordem_compra_item_id: idOpcional,
  entrega_item_id: idOpcional,
  quantidade_pedida: naoNegativo.optional(),
  preco_unitario: naoNegativo.optional(),
  unidade_id: idOpcional,
  observacao: z.string().trim().max(500).optional(),
});
