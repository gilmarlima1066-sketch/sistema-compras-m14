/**
 * Schemas do modulo 11.
 *
 * O filtro global (secoes 7 e 8) e um unico schema reaproveitado por todas as
 * rotas de leitura: o mesmo periodo e as mesmas dimensoes valem para
 * dashboard, KPI, serie, Pareto e drill-down. E o que impede a tela de
 * comparar um KPI de 90 dias com outro de 30 na mesma linha (regra 5 da
 * secao 71).
 */
import { z } from 'zod';

const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use o formato AAAA-MM-DD');

export const filtroSchema = z.object({
  periodo: z.enum([
    'HOJE', 'SEMANA', 'MES', 'TRIMESTRE', 'SEMESTRE', 'ANO',
    'ANO_ATUAL', 'ANO_ANTERIOR', 'PERSONALIZADO',
  ]).optional(),
  dias: z.coerce.number().int().min(1).max(1825).optional(),
  data_inicio: data.optional(),
  data_fim: data.optional(),
  categoria_id: z.coerce.number().int().positive().optional(),
  produto_id: z.coerce.number().int().positive().optional(),
  fornecedor_id: z.coerce.number().int().positive().optional(),
  local_id: z.coerce.number().int().positive().optional(),
  comprador_id: z.coerce.number().int().positive().optional(),
  origem: z.enum(['NACIONAL', 'IMPORTADO']).optional(),
  status: z.string().trim().max(40).optional(),
}).refine(
  (f) => !(f.data_inicio && f.data_fim) || f.data_inicio <= f.data_fim,
  { message: 'A data inicial nao pode ser posterior a final', path: ['data_inicio'] },
);

export const serieSchema = z.object({
  meses: z.coerce.number().int().min(2).max(36).default(6),
});

export const historicoSchema = z.object({
  limite: z.coerce.number().int().min(1).max(200).default(24),
});

export const listarKpisSchema = z.object({
  modulo: z.string().trim().max(30).optional(),
  categoria: z.string().trim().max(60).optional(),
  busca: z.string().trim().max(120).optional(),
  apenas_ativos: z.coerce.boolean().default(true),
});

export const compararSchema = z.object({
  codigos: z.string().trim().min(1).max(600),
});

/**
 * Meta (secao 12). O escopo decide qual coluna de dimensao e obrigatoria -
 * uma meta CATEGORIA sem categoria_id nao teria a quem se aplicar.
 */
export const metaSchema = z.object({
  codigo: z.string().trim().min(1).max(60),
  // Os nomes sao os do enum escopo_meta_enum, nao apelidos: EMPRESA e o
  // escopo geral e FILIAL e o escopo por local de estoque.
  escopo: z.enum(['EMPRESA', 'FILIAL', 'CATEGORIA', 'PRODUTO', 'FORNECEDOR', 'COMPRADOR'])
    .default('EMPRESA'),
  categoria_id: z.number().int().positive().optional(),
  produto_id: z.number().int().positive().optional(),
  fornecedor_id: z.number().int().positive().optional(),
  local_id: z.number().int().positive().optional(),
  comprador_id: z.number().int().positive().optional(),
  meta: z.number(),
  limite_atencao: z.number().optional(),
  limite_critico: z.number().optional(),
  observacao: z.string().trim().max(500).optional(),
}).superRefine((v, ctx) => {
  const exigido: Record<string, keyof typeof v> = {
    CATEGORIA: 'categoria_id', PRODUTO: 'produto_id', FORNECEDOR: 'fornecedor_id',
    FILIAL: 'local_id', COMPRADOR: 'comprador_id',
  };
  const campo = exigido[v.escopo];
  if (campo && v[campo] === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: [campo],
      message: `Meta de escopo ${v.escopo} exige ${campo}`,
    });
  }
});

export const listarAlertasSchema = z.object({
  status: z.enum(['ABERTO', 'EM_TRATATIVA', 'RESOLVIDO', 'IGNORADO']).optional(),
  prioridade: z.enum(['CRITICO', 'ALTO', 'MEDIO', 'BAIXO']).optional(),
  categoria: z.string().trim().max(40).optional(),
  origem: z.string().trim().max(80).optional(),
  produto_id: z.coerce.number().int().positive().optional(),
  fornecedor_id: z.coerce.number().int().positive().optional(),
  responsavel_id: z.coerce.number().int().positive().optional(),
  limite: z.coerce.number().int().min(1).max(200).default(50),
  pagina: z.coerce.number().int().min(1).default(1),
});

export const tratarAlertaSchema = z.object({
  status: z.enum(['EM_TRATATIVA', 'RESOLVIDO', 'IGNORADO', 'ABERTO']),
  observacao: z.string().trim().max(500).optional(),
  responsavel_id: z.number().int().positive().optional(),
});

export const avaliarRegrasSchema = z.object({
  regra: z.string().trim().max(60).optional(),
});

export const drilldownSchema = z.object({
  destino: z.string().trim().min(1).max(60),
  limite: z.coerce.number().int().min(1).max(500).default(100),
});

export const paretoSchema = z.object({
  analise: z.string().trim().min(1).max(60),
});
