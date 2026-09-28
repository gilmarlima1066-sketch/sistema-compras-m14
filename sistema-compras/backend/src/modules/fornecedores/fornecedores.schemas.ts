import { z } from 'zod';
import { paginacaoSchema } from '../../core/paginacao.js';

export const listarFornecedoresSchema = paginacaoSchema.extend({
  origem: z.enum(['NACIONAL', 'INTERNACIONAL']).optional(),
  tipo: z.enum(['FABRICANTE', 'DISTRIBUIDOR', 'PRODUTOR', 'IMPORTADOR', 'REPRESENTANTE', 'OUTRO']).optional(),
  ativo: z.enum(['true', 'false']).optional(),
});

const soDigitos = (valor: unknown) => (typeof valor === 'string' ? valor.replace(/\D/g, '') : valor);

export const fornecedorBaseSchema = z.object({
  razao_social: z.string().trim().min(3).max(200),
  nome_fantasia: z.string().trim().max(200).nullish(),
  cnpj: z.preprocess(soDigitos, z.string().regex(/^[0-9]{14}$/, 'CNPJ deve ter 14 digitos').nullish()),
  inscricao_estadual: z.string().trim().max(30).nullish(),
  email: z.string().email().nullish(),
  telefone: z.string().trim().max(30).nullish(),
  celular: z.string().trim().max(30).nullish(),
  endereco: z.string().trim().max(200).nullish(),
  numero: z.string().trim().max(20).nullish(),
  complemento: z.string().trim().max(100).nullish(),
  bairro: z.string().trim().max(100).nullish(),
  cidade: z.string().trim().max(100).nullish(),
  estado: z.string().trim().max(40).nullish(),
  cep: z.preprocess(soDigitos, z.string().max(10).nullish()),
  pais: z.string().trim().max(60).default('Brasil'),
  tipo_fornecedor: z.enum(['FABRICANTE', 'DISTRIBUIDOR', 'PRODUTOR', 'IMPORTADOR', 'REPRESENTANTE', 'OUTRO']).default('DISTRIBUIDOR'),
  origem_fornecedor: z.enum(['NACIONAL', 'INTERNACIONAL']).default('NACIONAL'),
  prazo_medio_pagamento: z.coerce.number().int().nonnegative().nullish(),
  lead_time_padrao_dias: z.coerce.number().int().nonnegative().nullish(),
  observacoes: z.string().trim().max(2000).nullish(),
  ativo: z.coerce.boolean().default(true),
}).refine(
  (d) => d.origem_fornecedor !== 'NACIONAL' || !!d.cnpj,
  { message: 'Fornecedor nacional exige CNPJ', path: ['cnpj'] },
);

export const criarFornecedorSchema = fornecedorBaseSchema;
export const atualizarFornecedorSchema = fornecedorBaseSchema.innerType().partial();

export const vinculoProdutoSchema = z.object({
  produto_id: z.coerce.number().int().positive(),
  codigo_produto_fornecedor: z.string().trim().max(60).nullish(),
  preco_atual: z.coerce.number().nonnegative().nullish(),
  moeda: z.string().length(3).toUpperCase().default('BRL'),
  moq: z.coerce.number().positive().nullish(),
  multiplo_compra: z.coerce.number().positive().nullish(),
  lead_time_dias: z.coerce.number().int().nonnegative().nullish(),
  prazo_pagamento_dias: z.coerce.number().int().nonnegative().nullish(),
  frete_estimado: z.coerce.number().nonnegative().nullish(),
  fornecedor_principal: z.coerce.boolean().default(false),
  ativo: z.coerce.boolean().default(true),
});

export const idSchema = z.object({ id: z.coerce.number().int().positive() });
export type FiltroFornecedores = z.infer<typeof listarFornecedoresSchema>;
export type NovoFornecedor = z.infer<typeof criarFornecedorSchema>;
export type VinculoProduto = z.infer<typeof vinculoProdutoSchema>;
