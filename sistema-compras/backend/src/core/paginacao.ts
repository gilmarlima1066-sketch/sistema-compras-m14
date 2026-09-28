import { z } from 'zod';

export const paginacaoSchema = z.object({
  pagina: z.coerce.number().int().min(1).default(1),
  limite: z.coerce.number().int().min(1).max(200).default(25),
  busca: z.string().trim().max(120).optional(),
  ordenar_por: z.string().trim().max(40).optional(),
  ordem: z.enum(['asc', 'desc']).default('asc'),
});

export type Paginacao = z.infer<typeof paginacaoSchema>;

export function metaPaginacao(total: number, { pagina, limite }: Paginacao) {
  return { total, pagina, limite, paginas: Math.max(1, Math.ceil(total / limite)) };
}

export const deslocamento = ({ pagina, limite }: Paginacao) => (pagina - 1) * limite;

/**
 * Ordenacao segura: so aceita colunas previamente declaradas pelo modulo,
 * o que elimina a superficie de SQL injection em ORDER BY.
 */
export function ordenacaoSegura(p: Paginacao, permitidas: string[], padrao: string): string {
  const coluna = p.ordenar_por && permitidas.includes(p.ordenar_por) ? p.ordenar_por : padrao;
  return `${coluna} ${p.ordem === 'desc' ? 'DESC' : 'ASC'}`;
}
