/**
 * Schemas do modulo 12.
 *
 * Nenhum controller acessa req.body cru - a validacao acontece aqui, antes de
 * qualquer coisa tocar o banco. Nas entradas de texto livre (pergunta, SQL) os
 * limites de tamanho sao a primeira barreira de seguranca, antes mesmo da
 * guarda de SQL.
 */
import { z } from 'zod';

const idOpcional = z.coerce.number().int().positive().optional();

export const perguntaSchema = z.object({
  pergunta: z.string().trim().min(3, 'A pergunta precisa de ao menos 3 caracteres').max(500),
  conversa_id: idOpcional,
  intencao: z.string().trim().max(60).optional(),
});

export const consultaSqlSchema = z.object({
  sql: z.string().trim().min(10).max(4000),
});

export const analisarSchema = z.object({
  tipo: z.enum(['PRECO', 'FORNECEDOR', 'PREVISAO', 'CONCENTRACAO', 'RISCOS', 'QUALIDADE'])
    .default('RISCOS'),
  limite: z.coerce.number().int().min(1).max(200).default(50),
  dias: z.coerce.number().int().min(1).max(1825).optional(),
});

export const gerarRecomendacoesSchema = z.object({
  limite_produtos: z.coerce.number().int().min(1).max(500).default(150),
});

export const listarRecomendacoesSchema = z.object({
  status: z.enum(['NOVA', 'EM_ANALISE', 'ACEITA', 'REJEITADA', 'EXECUTADA', 'EXPIRADA'])
    .optional(),
  tipo: z.string().trim().max(40).optional(),
  prioridade: z.enum(['CRITICO', 'ALTO', 'MEDIO', 'BAIXO']).optional(),
  confianca: z.enum(['ALTA', 'MEDIA', 'BAIXA', 'INSUFICIENTE']).optional(),
  produto_id: idOpcional,
  fornecedor_id: idOpcional,
  limite: z.coerce.number().int().min(1).max(200).default(50),
  pagina: z.coerce.number().int().min(1).default(1),
});

/**
 * Decisao sobre uma recomendacao (secao 36).
 *
 * `motivo` obrigatorio em REJEITAR: sem ele o feedback nao serve para melhorar
 * a regra depois, que e a razao de existir do registro.
 */
export const decidirSchema = z.object({
  tipo: z.enum(['ACEITAR', 'REJEITAR', 'AJUSTAR', 'IGNORAR', 'EXECUTAR']),
  motivo: z.string().trim().max(300).optional(),
  observacao: z.string().trim().max(1000).optional(),
}).superRefine((v, ctx) => {
  if (v.tipo === 'REJEITAR' && !v.motivo) {
    ctx.addIssue({
      code: 'custom',
      path: ['motivo'],
      message: 'Rejeitar exige o motivo',
    });
  }
});

export const simularSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  cenario: z.enum(['BASE', 'OTIMISTA', 'PESSIMISTA', 'RUPTURA', 'AUMENTO_PRECO',
    'ATRASO_FORNECEDOR', 'AUMENTO_DEMANDA', 'CAMBIO', 'PERSONALIZADO']).optional(),
  horizonte_dias: z.coerce.number().int().min(1).max(730).optional(),
  variacao_demanda_percentual: z.coerce.number().min(-90).max(300).optional(),
  lead_time_extra_dias: z.coerce.number().int().min(-60).max(365).optional(),
  variacao_seguranca_percentual: z.coerce.number().min(-90).max(300).optional(),
  variacao_preco_percentual: z.coerce.number().min(-90).max(300).optional(),
  variacao_cambio_percentual: z.coerce.number().min(-90).max(300).optional(),
  prazo_pagamento_dias: z.coerce.number().int().min(0).max(365).optional(),
  categoria_id: idOpcional,
  fornecedor_id: idOpcional,
});

export const compararCenariosSchema = z.object({
  cenarios: z.string().trim().min(1).max(200),
  horizonte_dias: z.coerce.number().int().min(1).max(730).optional(),
  categoria_id: idOpcional,
  fornecedor_id: idOpcional,
});

export const historicoSchema = z.object({
  status: z.enum(['OK', 'BLOQUEADA', 'ERRO', 'VAZIA']).optional(),
  tipo: z.enum(['PERGUNTA', 'CONSULTA_SQL', 'ANALISE', 'SIMULACAO', 'RECOMENDACAO', 'ROTINA'])
    .optional(),
  usuario_id: idOpcional,
  limite: z.coerce.number().int().min(1).max(200).default(50),
  pagina: z.coerce.number().int().min(1).default(1),
});

export const limiteSchema = z.object({
  limite: z.coerce.number().int().min(1).max(200).default(50),
});

export const configuracaoSchema = z.object({
  chave: z.string().trim().min(3).max(80).regex(/^ia\./, 'A chave precisa comecar com "ia."'),
  valor: z.string().trim().min(1).max(200),
});
