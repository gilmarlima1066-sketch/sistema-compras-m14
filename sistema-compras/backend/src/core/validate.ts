import type { Request } from 'express';
import type { ZodTypeAny, output } from 'zod';
import { erroValidacao } from './errors.js';

type Origem = 'body' | 'query' | 'params';

/**
 * Valida e tipa a entrada. Nenhum controller acessa req.body cru.
 * O retorno usa `output<S>`, ou seja, o tipo DEPOIS de defaults e coercoes,
 * garantindo que campos com `.default()` cheguem obrigatorios na camada de servico.
 */
export function validar<S extends ZodTypeAny>(req: Request, origem: Origem, schema: S): output<S> {
  const resultado = schema.safeParse(req[origem]);
  if (!resultado.success) {
    throw erroValidacao(
      'Dados invalidos',
      resultado.error.issues.map((i) => ({ campo: i.path.join('.') || origem, mensagem: i.message })),
    );
  }
  return resultado.data as output<S>;
}
