import { z } from 'zod';
import { paginacaoSchema } from '../../core/paginacao.js';
import { dataCalendario } from '../../core/datas.js';

const id = z.coerce.number().int().positive();
const idOpcional = id.optional();
const data = dataCalendario;

export const GRUPOS = [
  'LOGISTICA', 'QUALIDADE', 'COMERCIAL', 'ATENDIMENTO',
  'PRECO', 'PAGAMENTO', 'FLEXIBILIDADE',
] as const;

export const FREQUENCIAS = [
  'MENSAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL', 'SOB_DEMANDA',
] as const;

export const ESCOPOS = ['EMPRESA', 'CATEGORIA', 'FORNECEDOR', 'TIPO_COMPRA'] as const;

export const STATUS_HOMOLOGACAO = [
  'EM_HOMOLOGACAO', 'HOMOLOGADO', 'HOMOLOGADO_COM_RESTRICAO',
  'EM_MONITORAMENTO', 'BLOQUEADO', 'INATIVO',
] as const;

export const MOTIVOS_BLOQUEIO = [
  'QUALIDADE_GRAVE', 'DOCUMENTACAO_IRREGULAR', 'PROBLEMA_COMERCIAL',
  'DECISAO_ADMINISTRATIVA', 'RISCO_OPERACIONAL', 'NAO_CONFORMIDADE_CRITICA',
] as const;

export const STATUS_PLANO = [
  'ABERTO', 'EM_ANALISE', 'ACAO_DEFINIDA', 'EM_EXECUCAO',
  'AGUARDANDO_FORNECEDOR', 'VALIDACAO', 'ENCERRADO', 'CANCELADO',
] as const;

export const SEVERIDADES = ['CRITICA', 'ALTA', 'MEDIA', 'BAIXA'] as const;

export const DIRECOES = ['MAIOR_MELHOR', 'MENOR_MELHOR'] as const;

/** Atalhos de periodo da secao 7. */
export const ROTULOS_PERIODO = [
  'ULTIMOS_30', 'ULTIMOS_60', 'ULTIMOS_90', 'ULTIMOS_180', 'ULTIMOS_365',
  'ANO_ATUAL', 'ANO_ANTERIOR', 'PERSONALIZADO',
] as const;

// --- Periodo ----------------------------------------------------------------

export const periodoSchema = z.object({
  periodo: z.enum(ROTULOS_PERIODO).optional(),
  dias: z.coerce.number().int().min(1).max(1825).optional(),
  data_inicio: data.optional(),
  data_fim: data.optional(),
  categoria_id: idOpcional,
  produto_id: idOpcional,
  local_id: idOpcional,
});

// --- Metodologia ------------------------------------------------------------

export const criterioSchema = z.object({
  grupo: z.enum(GRUPOS),
  nome: z.string().trim().min(2).max(80),
  descricao: z.string().trim().max(400).optional(),
  peso_percentual: z.coerce.number().min(0).max(100),
  minimo_eventos: z.coerce.number().int().min(0).max(1000).default(1),
  indicadores: z.array(z.object({
    codigo: z.string().trim().min(2).max(60),
    nome: z.string().trim().min(2).max(120),
    peso_percentual: z.coerce.number().min(0).max(100),
    direcao: z.enum(DIRECOES).default('MAIOR_MELHOR'),
    valor_pior: z.coerce.number().optional(),
    valor_melhor: z.coerce.number().optional(),
    unidade: z.string().trim().max(20).optional(),
    minimo_eventos: z.coerce.number().int().min(0).max(1000).default(1),
  })).max(20).optional(),
});

export const metodologiaSchema = z.object({
  versao: z.string().trim().min(1).max(20),
  nome: z.string().trim().min(3).max(120),
  descricao: z.string().trim().max(1000).optional(),
  escopo: z.enum(ESCOPOS).default('EMPRESA'),
  categoria_id: idOpcional,
  fornecedor_id: idOpcional,
  tipo_compra: z.string().trim().max(40).optional(),
  frequencia: z.enum(FREQUENCIAS).default('TRIMESTRAL'),
  escala_maxima: z.coerce.number().positive().max(1000).default(100),
  observacoes: z.string().trim().max(1000).optional(),
  criterios: z.array(criterioSchema).min(1).max(7),
});

export const publicarMetodologiaSchema = z.object({
  vigente: z.coerce.boolean().default(true),
});

export const listarMetodologiasSchema = paginacaoSchema.extend({
  escopo: z.enum(ESCOPOS).optional(),
  vigente: z.coerce.boolean().optional(),
  fornecedor_id: idOpcional,
  categoria_id: idOpcional,
});

// --- Avaliacao --------------------------------------------------------------

export const avaliarSchema = periodoSchema.extend({
  metodologia_id: idOpcional,
  frequencia: z.enum(FREQUENCIAS).optional(),
  extraordinaria: z.coerce.boolean().default(false),
  observacoes: z.string().trim().max(2000).optional(),
  /** Quando falso, calcula e devolve sem gravar: e a previa da tela. */
  gravar: z.coerce.boolean().default(true),
});

export const validarAvaliacaoSchema = z.object({
  observacoes: z.string().trim().max(2000).optional(),
});

export const cancelarAvaliacaoSchema = z.object({
  justificativa: z.string().trim().min(5).max(2000),
});

export const listarAvaliacoesSchema = paginacaoSchema.extend({
  fornecedor_id: idOpcional,
  status: z.enum(['RASCUNHO', 'CALCULADA', 'VALIDADA', 'CANCELADA']).optional(),
  completude: z.enum(['COMPLETA', 'DADOS_PARCIAIS', 'DADOS_INSUFICIENTES', 'SEM_HISTORICO'])
    .optional(),
  metodologia_id: idOpcional,
  data_inicio: data.optional(),
  data_fim: data.optional(),
  score_minimo: z.coerce.number().min(0).max(100).optional(),
  score_maximo: z.coerce.number().min(0).max(100).optional(),
});

// --- Comparativo ------------------------------------------------------------

export const comparativoSchema = periodoSchema.extend({
  fornecedores: z.union([
    z.array(id).min(2).max(8),
    z.string().transform((v) => v.split(',').map((x) => Number(x.trim()))
      .filter((x) => Number.isInteger(x) && x > 0)),
  ]),
});

// --- Situacao do fornecedor -------------------------------------------------

export const situacaoSchema = z.object({
  status: z.enum(STATUS_HOMOLOGACAO),
  motivo: z.string().trim().min(5).max(2000),
  motivo_bloqueio: z.enum(MOTIVOS_BLOQUEIO).optional(),
  evidencias: z.string().trim().max(2000).optional(),
  indicadores_monitorados: z.array(z.string().trim().max(60)).max(20).optional(),
  avaliacao_id: idOpcional,
  prazo: data.optional(),
  autorizado_por: idOpcional,
}).refine((v) => v.status !== 'BLOQUEADO' || !!v.motivo_bloqueio, {
  message: 'Bloqueio exige o motivo do bloqueio',
  path: ['motivo_bloqueio'],
});

export const listarSituacoesSchema = paginacaoSchema.extend({
  fornecedor_id: idOpcional,
  status: z.enum(STATUS_HOMOLOGACAO).optional(),
  apenas_abertas: z.coerce.boolean().optional(),
});

// --- Plano de acao ----------------------------------------------------------

export const planoAcaoSchema = z.object({
  fornecedor_id: id,
  avaliacao_id: idOpcional,
  categoria_id: idOpcional,
  produto_id: idOpcional,
  grupo: z.enum(GRUPOS).optional(),
  indicador: z.string().trim().max(60).optional(),
  valor_indicador: z.coerce.number().optional(),
  meta_indicador: z.coerce.number().optional(),
  problema: z.string().trim().min(5).max(2000),
  causa: z.string().trim().max(2000).optional(),
  severidade: z.enum(SEVERIDADES).default('MEDIA'),
  responsavel_id: idOpcional,
  prazo: data.optional(),
  evidencia: z.string().trim().max(1000).optional(),
  acoes: z.array(z.object({
    acao: z.string().trim().min(5).max(1000),
    responsavel_id: idOpcional,
    prazo: data.optional(),
    evidencia: z.string().trim().max(500).optional(),
  })).max(30).optional(),
});

export const tratarPlanoSchema = z.object({
  status: z.enum(STATUS_PLANO),
  causa: z.string().trim().max(2000).optional(),
  responsavel_id: idOpcional,
  prazo: data.optional(),
  evidencia: z.string().trim().max(1000).optional(),
  resultado: z.string().trim().max(2000).optional(),
  observacao: z.string().trim().max(2000).optional(),
}).refine(
  (v) => v.status !== 'ENCERRADO' || (v.resultado && v.resultado.length >= 5),
  { message: 'Encerrar o plano exige descrever o resultado', path: ['resultado'] },
);

export const acaoPlanoSchema = z.object({
  acao: z.string().trim().min(5).max(1000),
  responsavel_id: idOpcional,
  prazo: data.optional(),
  evidencia: z.string().trim().max(500).optional(),
});

export const concluirAcaoSchema = z.object({
  status: z.enum(['EM_EXECUCAO', 'ENCERRADO', 'CANCELADO']),
  resultado: z.string().trim().max(1000).optional(),
});

export const listarPlanosSchema = paginacaoSchema.extend({
  fornecedor_id: idOpcional,
  status: z.enum(STATUS_PLANO).optional(),
  grupo: z.enum(GRUPOS).optional(),
  severidade: z.enum(SEVERIDADES).optional(),
  apenas_abertos: z.coerce.boolean().optional(),
  apenas_atrasados: z.coerce.boolean().optional(),
});

// --- Parametros -------------------------------------------------------------

export const parametrosSchema = z.object({
  parametros: z.array(z.object({
    chave: z.string().trim().min(3).max(80),
    valor: z.string().trim().min(1).max(200),
  })).min(1).max(40),
});

export const concentracaoSchema = z.object({
  categoria_id: idOpcional,
  produto_id: idOpcional,
  dias: z.coerce.number().int().min(1).max(1825).default(365),
  base: z.enum(['VALOR', 'QUANTIDADE']).default('VALOR'),
});

export type Avaliar = z.output<typeof avaliarSchema>;
export type Metodologia = z.output<typeof metodologiaSchema>;
export type PlanoAcao = z.output<typeof planoAcaoSchema>;
