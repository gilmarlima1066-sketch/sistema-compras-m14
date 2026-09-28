import { z } from 'zod';
import { paginacaoSchema } from '../../core/paginacao.js';

const data = z.coerce.date();
const idOpcional = z.coerce.number().int().positive().optional();

/** Filtros comuns a praticamente todas as analises do modulo. */
export const filtroPeriodoSchema = z.object({
  data_inicio: data.optional(),
  data_fim: data.optional(),
  dias: z.coerce.number().int().min(1).max(3650).optional(),
  produto_id: idOpcional,
  categoria_id: idOpcional,
  subcategoria_id: idOpcional,
  marca_id: idOpcional,
  fornecedor_id: idOpcional,
  local_id: idOpcional,
  classificacao_abc: z.enum(['A', 'B', 'C']).optional(),
  classificacao_xyz: z.enum(['X', 'Y', 'Z']).optional(),
  incluir_devolucoes: z.coerce.boolean().default(true),
});

export type FiltroPeriodo = z.output<typeof filtroPeriodoSchema>;

export const listarVendasSchema = paginacaoSchema.merge(filtroPeriodoSchema).extend({
  cliente_id: idOpcional,
  tipo_documento: z.enum(['VENDA', 'DEVOLUCAO']).optional(),
});

export const analiseDemandaSchema = paginacaoSchema.merge(filtroPeriodoSchema);

export const comparacaoSchema = z.object({
  modo: z.enum(['MES_ANTERIOR', 'MESMO_MES_ANO_ANTERIOR', 'TRIMESTRE', 'PERSONALIZADO']).default('MES_ANTERIOR'),
  atual_inicio: data.optional(),
  atual_fim: data.optional(),
  anterior_inicio: data.optional(),
  anterior_fim: data.optional(),
  produto_id: idOpcional,
  categoria_id: idOpcional,
});

export const calcularPrevisaoSchema = z.object({
  produto_id: idOpcional,
  categoria_id: idOpcional,
  horizonte_dias: z.coerce.number().int().min(1).max(730).optional(),
  metodo: z.enum([
    'AUTOMATICO', 'MEDIA_SIMPLES', 'MEDIA_MOVEL', 'MEDIA_PONDERADA',
    'SUAVIZACAO_EXPONENCIAL', 'TENDENCIA', 'SAZONALIDADE', 'COMBINADO',
  ]).default('AUTOMATICO'),
  meses_historico: z.coerce.number().int().min(3).max(60).optional(),
  limite_produtos: z.coerce.number().int().min(1).max(5000).default(500),
  disparada_por: z.enum(['MANUAL', 'AGENDADA', 'API']).default('MANUAL'),
});

export const previsaoManualSchema = z.object({
  produto_id: z.coerce.number().int().positive(),
  periodo_inicio: data,
  periodo_fim: data,
  demanda_prevista: z.coerce.number().nonnegative(),
  origem: z.enum(['MANUAL', 'PRODUTO_SIMILAR', 'MEDIA_CATEGORIA']).default('MANUAL'),
  justificativa: z.string().trim().min(10).max(1000),
}).refine((v) => v.periodo_fim >= v.periodo_inicio, {
  message: 'Periodo final deve ser igual ou posterior ao inicial',
  path: ['periodo_fim'],
});

export const tratarOutlierSchema = z.object({
  tratamento: z.enum(['MANTER', 'EXCLUIR', 'TRATAR_SEPARADO']),
  justificativa: z.string().trim().min(5).max(500),
});

export const classificarReprimidaSchema = z.object({
  classificacao: z.enum(['POSSIVEL', 'PROVAVEL', 'CONFIRMADA']),
  observacao: z.string().trim().max(1000).optional(),
});

export const eventoCalendarioSchema = z.object({
  nome: z.string().trim().min(2).max(160),
  tipo: z.enum(['FERIADO', 'DATA_COMEMORATIVA', 'CAMPANHA', 'PROMOCAO', 'EVENTO', 'SEM_OPERACAO']),
  data_inicio: data,
  data_fim: data,
  produto_id: idOpcional,
  categoria_id: idOpcional,
  desconto_percentual: z.coerce.number().min(0).max(100).nullish(),
  observacao: z.string().trim().max(500).nullish(),
}).refine((v) => v.data_fim >= v.data_inicio, {
  message: 'Data final deve ser igual ou posterior a inicial',
  path: ['data_fim'],
});

export const configuracoesSchema = z.record(
  z.string().trim().min(1),
  z.union([z.string(), z.number(), z.boolean()]),
);

export const importarVendasSchema = z.object({
  origem: z.string().trim().min(2).max(60).default('IMPORTACAO_MANUAL'),
  confirmar: z.coerce.boolean().default(false),
  linhas: z.array(z.object({
    numero_documento: z.string().trim().min(1).max(60),
    data_venda: data,
    codigo_produto: z.string().trim().min(1).max(40),
    quantidade: z.coerce.number(),
    preco_unitario: z.coerce.number().nonnegative().default(0),
    valor_total: z.coerce.number().optional(),
    codigo_cliente: z.string().trim().max(40).optional(),
    cliente_nome: z.string().trim().max(200).optional(),
    canal: z.string().trim().max(60).optional(),
    tipo_documento: z.enum(['VENDA', 'DEVOLUCAO']).default('VENDA'),
  })).min(1).max(20000),
});

export const classificarAbcXyzSchema = z.object({
  dias: z.coerce.number().int().min(30).max(1095).default(365),
});
