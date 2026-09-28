import { z } from 'zod';
import { paginacaoSchema } from '../../core/paginacao.js';
import { dataCalendario } from '../../core/datas.js';

const idOpcional = z.coerce.number().int().positive().optional();

export const ESTRATEGIAS = [
  'PONTO_PEDIDO', 'ESTOQUE_MINIMO', 'ESTOQUE_MAXIMO',
  'COBERTURA', 'DEMANDA_LEAD_TIME', 'MANUAL',
] as const;

export const PRIORIDADES = [
  'RUPTURA', 'CRITICA', 'ALTA', 'MEDIA', 'BAIXA', 'SEM_NECESSIDADE',
] as const;

export const executarPlanejamentoSchema = z.object({
  horizonte_dias: z.coerce.number().int().min(1).max(730).optional(),
  estrategia: z.enum(ESTRATEGIAS).optional(),
  local_id: idOpcional,
  categoria_id: idOpcional,
  produto_id: idOpcional,
  fornecedor_id: idOpcional,
  observacao: z.string().trim().max(500).optional(),
});

export const listarNecessidadesSchema = paginacaoSchema.extend({
  planejamento_id: idOpcional,
  produto_id: idOpcional,
  categoria_id: idOpcional,
  fornecedor_id: idOpcional,
  local_id: idOpcional,
  prioridade: z.enum(PRIORIDADES).optional(),
  status: z.enum([
    'PENDENTE', 'EM_ANALISE', 'APROVADA', 'REJEITADA', 'AJUSTADA',
    'CONVERTIDA_COTACAO', 'ATENDIDA', 'CANCELADA',
  ]).optional(),
  classificacao_abc: z.enum(['A', 'B', 'C']).optional(),
  classificacao_xyz: z.enum(['X', 'Y', 'Z']).optional(),
  apenas_com_necessidade: z.coerce.boolean().default(true),
  apenas_atrasados: z.coerce.boolean().optional(),
  apenas_ruptura: z.coerce.boolean().optional(),
  apenas_excesso: z.coerce.boolean().optional(),
  origem_fornecedor: z.enum(['NACIONAL', 'INTERNACIONAL']).optional(),
});

export const ajustarNecessidadeSchema = z.object({
  quantidade_aprovada: z.coerce.number().nonnegative().optional(),
  fornecedor_id: idOpcional,
  data_necessaria: dataCalendario.optional(),
  prioridade: z.enum(PRIORIDADES).optional(),
  justificativa: z.string().trim().min(10).max(1000),
});

export const decidirNecessidadeSchema = z.object({
  justificativa: z.string().trim().max(1000).optional(),
});

export const criarRequisicaoSchema = z.object({
  necessidade_ids: z.array(z.coerce.number().int().positive()).min(1).max(500),
  fornecedor_sugerido_id: idOpcional,
  local_id: idOpcional,
  comprador_id: idOpcional,
  data_necessaria: dataCalendario.optional(),
  observacao: z.string().trim().max(1000).optional(),
});

export const decidirRequisicaoSchema = z.object({
  motivo: z.string().trim().max(1000).optional(),
});

export const simularSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  tipo_cenario: z.enum(['BASE', 'CONSERVADOR', 'REDUZIDO', 'PERSONALIZADO']).default('PERSONALIZADO'),
  horizonte_dias: z.coerce.number().int().min(1).max(730).optional(),
  variacao_demanda_percentual: z.coerce.number().min(-90).max(300).default(0),
  lead_time_extra_dias: z.coerce.number().int().min(-60).max(365).default(0),
  variacao_seguranca_percentual: z.coerce.number().min(-90).max(300).default(0),
  cobertura_alvo_dias: z.coerce.number().int().min(1).max(730).optional(),
  estrategia: z.enum(ESTRATEGIAS).optional(),
  categoria_id: idOpcional,
  fornecedor_id: idOpcional,
  local_id: idOpcional,
});

export const compararSimulacoesSchema = z.object({
  ids: z.string().trim().min(1),
});

export const recalcularParametrosSchema = z.object({
  dias_historico: z.coerce.number().int().min(30).max(1095).default(365),
  nivel_servico: z.coerce.number().min(50).max(99.9).optional(),
  produto_id: idOpcional,
  categoria_id: idOpcional,
  sobrescrever_manual: z.coerce.boolean().default(false),
});

export const alcadaSchema = z.object({
  nome: z.string().trim().min(2).max(80),
  perfil_id: z.coerce.number().int().positive(),
  valor_minimo: z.coerce.number().nonnegative(),
  valor_maximo: z.coerce.number().positive().nullish(),
  ordem: z.coerce.number().int().min(1).max(20).default(1),
  ativo: z.coerce.boolean().default(true),
});

export const parametrosSchema = z.record(
  z.string().trim().min(1),
  z.union([z.string(), z.number(), z.boolean()]),
);

export const calendarioComprasSchema = z.object({
  planejamento_id: idOpcional,
  dias: z.coerce.number().int().min(1).max(365).default(30),
  // O calendario e uma fila de prioridade, nao um relatorio completo: o teto
  // evita devolver milhares de linhas que ninguem le.
  limite: z.coerce.number().int().min(1).max(1000).default(200),
});

export type ExecutarPlanejamento = z.output<typeof executarPlanejamentoSchema>;
export type FiltroNecessidades = z.output<typeof listarNecessidadesSchema>;
export type Simular = z.output<typeof simularSchema>;
