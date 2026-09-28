import { z } from 'zod';
import { paginacaoSchema } from '../../core/paginacao.js';
import { dataCalendario } from '../../core/datas.js';

const id = z.coerce.number().int().positive();
const idOpcional = id.optional();
const naoNegativo = z.coerce.number().nonnegative();

export const STATUS_NEGOCIACAO = [
  'RASCUNHO', 'ABERTA', 'EM_NEGOCIACAO', 'AGUARDANDO_FORNECEDOR',
  'CONTRAPROPOSTA_RECEBIDA', 'EM_ANALISE', 'ACORDADA', 'APROVADA',
  'CONVERTIDA_PEDIDO', 'REJEITADA', 'CANCELADA',
] as const;

export const STATUS_PEDIDO = [
  'RASCUNHO', 'AGUARDANDO_APROVACAO', 'APROVADA', 'ENVIADA', 'CONFIRMADA',
  'EM_PRODUCAO', 'EM_TRANSITO', 'RECEBIMENTO_PARCIAL', 'RECEBIDA',
  'FINALIZADA', 'CANCELADA', 'REJEITADA', 'BLOQUEADA',
] as const;

export const MOTIVOS_REJEICAO = [
  'PRECO', 'PRAZO', 'CONDICAO_COMERCIAL', 'ORCAMENTO', 'ESTOQUE',
  'PLANEJAMENTO', 'QUALIDADE', 'FORNECEDOR', 'OUTRO',
] as const;

export const MOTIVOS_CANCELAMENTO = [
  'ERRO', 'FORNECEDOR', 'PRECO', 'ESTOQUE', 'DEMANDA',
  'MUDANCA_COMERCIAL', 'NECESSIDADE_CANCELADA', 'OUTRO',
] as const;

export const criarNegociacaoSchema = z.object({
  origem: z.enum(['COTACAO', 'PROPOSTA', 'MANUAL']).default('COTACAO'),
  cotacao_id: idOpcional,
  fornecedor_id: idOpcional,
  data_limite: dataCalendario.optional(),
  prioridade: z.enum(['RUPTURA', 'CRITICA', 'ALTA', 'MEDIA', 'BAIXA']).optional(),
  itens: z.array(z.object({
    produto_id: id,
    quantidade: z.coerce.number().positive(),
    preco_unitario: naoNegativo,
    preco_alvo: naoNegativo.nullish(),
    moq: naoNegativo.nullish(),
    multiplo: naoNegativo.nullish(),
    prazo_entrega_dias: z.coerce.number().int().nonnegative().nullish(),
  })).max(500).optional(),
  frete: naoNegativo.optional(),
  impostos: naoNegativo.optional(),
  prazo_pagamento_dias: z.coerce.number().int().nonnegative().optional(),
  observacao: z.string().trim().max(2000).optional(),
}).refine((v) => v.cotacao_id || (v.fornecedor_id && v.itens?.length), {
  message: 'Informe a cotacao aprovada, ou fornecedor e itens para negociacao manual',
});

export const listarNegociacoesSchema = paginacaoSchema.extend({
  status: z.enum(STATUS_NEGOCIACAO).optional(),
  fornecedor_id: idOpcional,
  comprador_id: idOpcional,
  apenas_paradas: z.coerce.boolean().optional(),
});

export const rodadaSchema = z.object({
  autor: z.enum(['COMPRADOR', 'FORNECEDOR']),
  justificativa: z.string().trim().max(2000).optional(),
  frete: naoNegativo.optional(),
  impostos: naoNegativo.optional(),
  outros: naoNegativo.optional(),
  prazo_entrega_dias: z.coerce.number().int().nonnegative().optional(),
  prazo_pagamento_dias: z.coerce.number().int().nonnegative().optional(),
  condicao_pagamento_id: idOpcional,
  itens: z.array(z.object({
    negociacao_item_id: id,
    quantidade: z.coerce.number().positive().optional(),
    preco_unitario: naoNegativo.optional(),
    desconto: naoNegativo.optional(),
    quantidade_bonificada: naoNegativo.optional(),
    prazo_entrega_dias: z.coerce.number().int().nonnegative().optional(),
    observacao: z.string().trim().max(500).optional(),
  })).max(500).default([]),
}).refine(
  (v) => v.itens.length > 0 || v.frete !== undefined || v.impostos !== undefined
    || v.outros !== undefined || v.prazo_entrega_dias !== undefined
    || v.prazo_pagamento_dias !== undefined || v.condicao_pagamento_id !== undefined,
  { message: 'Uma rodada precisa alterar alguma condicao' },
);

export const simularVolumeSchema = z.object({
  negociacao_item_id: id,
  faixas: z.array(z.object({
    quantidade: z.coerce.number().positive(),
    preco_unitario: naoNegativo,
  })).min(1).max(20),
});

export const decidirSchema = z.object({
  justificativa: z.string().trim().max(2000).optional(),
});

export const rejeitarSchema = z.object({
  motivo: z.enum(MOTIVOS_REJEICAO),
  justificativa: z.string().trim().min(5).max(2000),
});

export const converterPedidoSchema = z.object({
  local_entrega_id: idOpcional,
  condicao_pagamento_id: idOpcional,
  data_prevista_entrega: dataCalendario.optional(),
  numero_parcelas: z.coerce.number().int().min(1).max(36).default(1),
  percentual_entrada: z.coerce.number().min(0).max(100).default(0),
  metodo_rateio_frete: z.enum(['VALOR', 'PESO', 'QUANTIDADE', 'PERCENTUAL', 'MANUAL']).optional(),
  observacao: z.string().trim().max(2000).optional(),
});

export const listarPedidosSchema = paginacaoSchema.extend({
  status: z.enum(STATUS_PEDIDO).optional(),
  fornecedor_id: idOpcional,
  comprador_id: idOpcional,
  data_inicio: dataCalendario.optional(),
  data_fim: dataCalendario.optional(),
  apenas_atrasados: z.coerce.boolean().optional(),
  apenas_parciais: z.coerce.boolean().optional(),
});

export const aprovarPedidoSchema = z.object({
  justificativa: z.string().trim().max(2000).optional(),
  excecoes: z.array(z.object({
    tipo: z.string().trim().min(2).max(60),
    motivo: z.string().trim().min(5).max(1000),
  })).max(20).optional(),
});

export const enviarPedidoSchema = z.object({
  canal: z.string().trim().max(60).default('EMAIL'),
  observacao: z.string().trim().max(1000).optional(),
});

export const confirmarPedidoSchema = z.object({
  numero_pedido_fornecedor: z.string().trim().max(60).optional(),
  canal: z.string().trim().max(60).optional(),
  data_prometida: dataCalendario.optional(),
  observacao: z.string().trim().max(1000).optional(),
  itens: z.array(z.object({
    ordem_compra_item_id: id,
    quantidade_confirmada: naoNegativo,
    preco_unitario: naoNegativo.optional(),
    data_prometida: dataCalendario.optional(),
  })).min(1).max(500),
});

export const solicitarAlteracaoSchema = z.object({
  motivo: z.string().trim().min(5).max(1000),
  alteracoes: z.array(z.object({
    ordem_compra_item_id: idOpcional,
    campo: z.enum(['quantidade_pedida', 'preco_unitario', 'data_prevista_entrega', 'frete', 'observacao']),
    valor_novo: z.string().trim().min(1).max(200),
  })).min(1).max(100),
});

export const decidirAlteracaoSchema = z.object({
  aprovar: z.coerce.boolean(),
  observacao: z.string().trim().max(1000).optional(),
});

export const cancelarPedidoSchema = z.object({
  motivo: z.enum(MOTIVOS_CANCELAMENTO),
  justificativa: z.string().trim().min(5).max(2000),
});

export type CriarNegociacao = z.output<typeof criarNegociacaoSchema>;
export type Rodada = z.output<typeof rodadaSchema>;
export type ConverterPedido = z.output<typeof converterPedidoSchema>;
export type ConfirmarPedido = z.output<typeof confirmarPedidoSchema>;
