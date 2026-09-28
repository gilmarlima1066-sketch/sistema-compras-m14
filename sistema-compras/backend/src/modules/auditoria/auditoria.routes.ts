import { Router } from 'express';
import { z } from 'zod';
import { ok, rota } from '../../core/http.js';
import { validar } from '../../core/validate.js';
import { paginacaoSchema, deslocamento, metaPaginacao } from '../../core/paginacao.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import { query } from '../../config/database.js';

const filtroSchema = paginacaoSchema.extend({
  tabela: z.string().trim().max(60).optional(),
  registro_id: z.coerce.number().int().positive().optional(),
  usuario_id: z.coerce.number().int().positive().optional(),
  acao: z.enum(['INSERT', 'UPDATE', 'DELETE']).optional(),
});

export const auditoriaRouter = Router();
auditoriaRouter.use(autenticar);

auditoriaRouter.get('/', exigirPermissao('auditoria.ler'), rota(async (req, res) => {
  const filtro = validar(req, 'query', filtroSchema);
  const condicoes: string[] = [];
  const valores: unknown[] = [];

  for (const [coluna, valor] of [
    ['a.tabela', filtro.tabela], ['a.registro_id', filtro.registro_id],
    ['a.usuario_id', filtro.usuario_id], ['a.acao', filtro.acao],
  ] as const) {
    if (valor !== undefined) {
      valores.push(valor);
      condicoes.push(`${coluna} = $${valores.length}`);
    }
  }
  const onde = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  const total = await query<{ total: number }>(`SELECT count(*)::int AS total FROM auditoria a ${onde}`, valores);
  const { rows } = await query(
    `SELECT a.id, a.tabela, a.registro_id, a.acao, a.valor_anterior, a.valor_novo,
            a.ip, a.created_at, u.nome AS usuario
       FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
       ${onde} ORDER BY a.created_at DESC LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)],
  );
  return ok(res, rows, 'Registros de auditoria', metaPaginacao(total.rows[0]?.total ?? 0, filtro));
}));
