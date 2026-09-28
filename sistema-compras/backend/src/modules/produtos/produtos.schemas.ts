import { z } from 'zod';
import { paginacaoSchema } from '../../core/paginacao.js';

const naoNegativo = z.coerce.number().nonnegative();
const positivoOpcional = z.coerce.number().positive().nullish();

export const listarProdutosSchema = paginacaoSchema.extend({
  categoria_id: z.coerce.number().int().positive().optional(),
  subcategoria_id: z.coerce.number().int().positive().optional(),
  ativo: z.enum(['true', 'false']).optional(),
  classificacao_abc: z.enum(['A', 'B', 'C']).optional(),
});

export const produtoBaseSchema = z.object({
  codigo: z.string().trim().min(1).max(40),
  ean: z.string().trim().regex(/^[0-9]{8,14}$/, 'EAN deve ter de 8 a 14 digitos').nullish(),
  descricao: z.string().trim().min(3).max(200),
  descricao_completa: z.string().trim().max(2000).nullish(),
  categoria_id: z.coerce.number().int().positive(),
  subcategoria_id: z.coerce.number().int().positive().nullish(),
  marca_id: z.coerce.number().int().positive().nullish(),
  unidade_compra_id: z.coerce.number().int().positive().nullish(),
  unidade_estoque_id: z.coerce.number().int().positive(),
  unidade_venda_id: z.coerce.number().int().positive().nullish(),
  fator_conversao: z.coerce.number().positive().default(1),
  peso: naoNegativo.nullish(),
  dias_validade: z.coerce.number().int().positive().nullish(),
  origem: z.string().trim().max(80).nullish(),
  produto_importado: z.coerce.boolean().default(false),
  ativo: z.coerce.boolean().default(true),
  estoque_minimo: naoNegativo.default(0),
  estoque_maximo: naoNegativo.nullish(),
  estoque_seguranca: naoNegativo.default(0),
  ponto_pedido: naoNegativo.default(0),
  lead_time_padrao_dias: z.coerce.number().int().nonnegative().default(0),
  moq: positivoOpcional,
  multiplo_compra: positivoOpcional,
  classificacao_abc: z.enum(['A', 'B', 'C']).nullish(),
  classificacao_xyz: z.enum(['X', 'Y', 'Z']).nullish(),
});

export const criarProdutoSchema = produtoBaseSchema;
export const atualizarProdutoSchema = produtoBaseSchema.partial();

export const idSchema = z.object({ id: z.coerce.number().int().positive() });

export type FiltroProdutos = z.infer<typeof listarProdutosSchema>;
export type NovoProduto = z.infer<typeof criarProdutoSchema>;
export type EdicaoProduto = z.infer<typeof atualizarProdutoSchema>;
