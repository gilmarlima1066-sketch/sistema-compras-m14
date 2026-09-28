import { z } from 'zod';
import { paginacaoSchema } from '../../core/paginacao.js';
import { dataCalendario } from '../../core/datas.js';

const idOpcional = z.coerce.number().int().positive().optional();
const id = z.coerce.number().int().positive();

export const STATUS_COTACAO = [
  'RASCUNHO', 'ENVIADA', 'AGUARDANDO_RESPOSTAS', 'EM_ANALISE',
  'NEGOCIACAO_NECESSARIA', 'APROVADA_NEGOCIACAO', 'ENCAMINHADA',
  'REJEITADA', 'CANCELADA',
] as const;

export const INCOTERMS = [
  'EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP',
] as const;

export const criarCotacaoSchema = z.object({
  origem: z.enum(['REQUISICAO', 'NECESSIDADES', 'MANUAL']).default('MANUAL'),
  requisicao_id: idOpcional,
  necessidade_ids: z.array(id).max(500).optional(),
  produtos: z.array(z.object({
    produto_id: id,
    quantidade: z.coerce.number().positive(),
    quantidade_minima: z.coerce.number().nonnegative().nullish(),
    data_necessaria: dataCalendario.optional(),
    validade_minima_dias: z.coerce.number().int().nonnegative().nullish(),
    preco_alvo: z.coerce.number().nonnegative().nullish(),
    preco_maximo: z.coerce.number().nonnegative().nullish(),
    especificacao: z.string().trim().max(2000).nullish(),
  })).max(500).optional(),
  fornecedor_ids: z.array(id).max(50).optional(),
  data_limite: dataCalendario.optional(),
  data_necessaria: dataCalendario.optional(),
  local_entrega_id: idOpcional,
  prioridade: z.enum(['RUPTURA', 'CRITICA', 'ALTA', 'MEDIA', 'BAIXA']).default('MEDIA'),
  moeda_base: z.string().trim().regex(/^[A-Z]{3}$/).default('BRL'),
  referencia_economia: z.enum([
    'ULTIMA_COMPRA', 'PRECO_MEDIO', 'ORCAMENTO', 'PRECO_ALVO', 'MELHOR_PROPOSTA_ANTERIOR',
  ]).default('ULTIMA_COMPRA'),
  observacao: z.string().trim().max(2000).optional(),
}).refine(
  (v) => v.requisicao_id || (v.necessidade_ids?.length) || (v.produtos?.length),
  { message: 'Informe uma requisicao, necessidades ou produtos para cotar' },
);

export const listarCotacoesSchema = paginacaoSchema.extend({
  status: z.enum(STATUS_COTACAO).optional(),
  fornecedor_id: idOpcional,
  comprador_id: idOpcional,
  prioridade: z.enum(['RUPTURA', 'CRITICA', 'ALTA', 'MEDIA', 'BAIXA']).optional(),
  data_inicio: dataCalendario.optional(),
  data_fim: dataCalendario.optional(),
  apenas_vencidas: z.coerce.boolean().optional(),
});

export const editarCotacaoSchema = z.object({
  data_limite: dataCalendario.optional(),
  data_necessaria: dataCalendario.optional(),
  local_entrega_id: idOpcional,
  prioridade: z.enum(['RUPTURA', 'CRITICA', 'ALTA', 'MEDIA', 'BAIXA']).optional(),
  comprador_id: idOpcional,
  referencia_economia: z.enum([
    'ULTIMA_COMPRA', 'PRECO_MEDIO', 'ORCAMENTO', 'PRECO_ALVO', 'MELHOR_PROPOSTA_ANTERIOR',
  ]).optional(),
  observacao: z.string().trim().max(2000).nullish(),
});

export const adicionarFornecedoresSchema = z.object({
  fornecedor_ids: z.array(id).min(1).max(50),
});

export const enviarCotacaoSchema = z.object({
  canal: z.string().trim().max(60).default('MANUAL'),
  data_limite: dataCalendario.optional(),
  observacao: z.string().trim().max(1000).optional(),
});

const itemPropostaSchema = z.object({
  produto_id: id,
  quantidade_ofertada: z.coerce.number().nonnegative(),
  preco_unitario: z.coerce.number().nonnegative(),
  desconto: z.coerce.number().nonnegative().default(0),
  frete: z.coerce.number().nonnegative().default(0),
  impostos: z.coerce.number().nonnegative().default(0),
  seguro: z.coerce.number().nonnegative().default(0),
  desembaraco: z.coerce.number().nonnegative().default(0),
  taxas: z.coerce.number().nonnegative().default(0),
  outros_custos: z.coerce.number().nonnegative().default(0),
  moq: z.coerce.number().nonnegative().nullish(),
  multiplo: z.coerce.number().nonnegative().nullish(),
  prazo_entrega_dias: z.coerce.number().int().nonnegative().nullish(),
  prazo_pagamento_dias: z.coerce.number().int().nonnegative().nullish(),
  data_prevista_entrega: dataCalendario.optional(),
  disponibilidade: z.enum(['IMEDIATA', 'PARCIAL', 'PRODUCAO', 'INDISPONIVEL']).nullish(),
  data_disponivel: dataCalendario.optional(),
  validade_produto_dias: z.coerce.number().int().nonnegative().nullish(),
  validade_proposta: dataCalendario.optional(),
  incoterm: z.enum(INCOTERMS).nullish(),
  moeda: z.string().trim().regex(/^[A-Z]{3}$/).default('BRL'),
  taxa_cambio: z.coerce.number().positive().nullish(),
  data_taxa_cambio: dataCalendario.optional(),
  faixas_preco: z.array(z.object({
    quantidade_de: z.coerce.number().nonnegative(),
    quantidade_ate: z.coerce.number().positive().nullish(),
    preco_unitario: z.coerce.number().nonnegative(),
  })).max(20).optional(),
  observacao: z.string().trim().max(1000).nullish(),
});

export const registrarPropostaSchema = z.object({
  fornecedor_id: id,
  data_resposta: dataCalendario.optional(),
  recusou: z.coerce.boolean().default(false),
  motivo_recusa: z.string().trim().max(500).optional(),
  itens: z.array(itemPropostaSchema).max(500).default([]),
  observacao: z.string().trim().max(1000).optional(),
}).refine((v) => v.recusou || v.itens.length > 0, {
  message: 'Informe ao menos um item ou marque a recusa do fornecedor',
});

export const criteriosSchema = z.object({
  criterios: z.array(z.object({
    codigo: z.string().trim().min(2).max(40),
    peso: z.coerce.number().min(0).max(100),
    eliminatorio: z.coerce.boolean().default(false),
  })).min(1).max(30),
});

export const comparativoSchema = z.object({
  metrica: z.enum([
    'CUSTO_UNITARIO', 'PRECO_UNITARIO', 'PRECO_LIQUIDO', 'CUSTO_TOTAL',
    'PRAZO', 'PAGAMENTO', 'MOQ', 'SCORE', 'DISPONIBILIDADE',
  ]).default('CUSTO_UNITARIO'),
});

export const cenarioSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  tipo: z.enum([
    'MENOR_CUSTO', 'MENOR_PRAZO', 'MAIOR_PRAZO_PAGAMENTO',
    'FORNECEDOR_UNICO', 'COMPRA_DIVIDIDA', 'MELHOR_SCORE', 'PERSONALIZADO',
  ]),
  fornecedor_id: idOpcional,
  selecao: z.array(z.object({
    cotacao_produto_id: id,
    cotacao_item_id: id,
    quantidade: z.coerce.number().positive(),
  })).max(2000).optional(),
});

export const selecionarPropostaSchema = z.object({
  selecoes: z.array(z.object({
    cotacao_produto_id: id,
    cotacao_item_id: id,
  })).min(1).max(2000),
  justificativa: z.string().trim().max(2000).optional(),
});

export const decidirCotacaoSchema = z.object({
  justificativa: z.string().trim().max(2000).optional(),
});

export type CriarCotacao = z.output<typeof criarCotacaoSchema>;
export type RegistrarProposta = z.output<typeof registrarPropostaSchema>;
export type Cenario = z.output<typeof cenarioSchema>;
