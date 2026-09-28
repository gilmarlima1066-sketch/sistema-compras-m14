import { Router } from 'express';
import { z } from 'zod';
import { criado, ok, rota } from '../../core/http.js';
import { validar } from '../../core/validate.js';
import { paginacaoSchema, deslocamento, metaPaginacao } from '../../core/paginacao.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import { comTransacao, query } from '../../config/database.js';
import { gerarHashSenha, limparCachePermissoes } from '../auth/auth.service.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';

const criarUsuarioSchema = z.object({
  nome: z.string().trim().min(3).max(120),
  email: z.string().email(),
  senha: z.string().min(8, 'A senha precisa de no minimo 8 caracteres'),
  perfil_id: z.coerce.number().int().positive(),
  ativo: z.coerce.boolean().default(true),
});

const atualizarUsuarioSchema = z.object({
  nome: z.string().trim().min(3).max(120).optional(),
  email: z.string().email().optional(),
  perfil_id: z.coerce.number().int().positive().optional(),
  ativo: z.coerce.boolean().optional(),
  senha: z.string().min(8).optional(),
});

const idSchema = z.object({ id: z.coerce.number().int().positive() });

export const usuariosRouter = Router();
usuariosRouter.use(autenticar);

usuariosRouter.get('/perfis', exigirPermissao('usuarios.ler'), rota(async (_req, res) => {
  const { rows } = await query(
    `SELECT pf.id, pf.nome, pf.descricao, pf.ativo,
            (SELECT count(*)::int FROM usuarios u WHERE u.perfil_id = pf.id AND u.deleted_at IS NULL) AS usuarios,
            COALESCE(array_agg(p.codigo ORDER BY p.codigo) FILTER (WHERE p.codigo IS NOT NULL), '{}') AS permissoes
       FROM perfis pf
       LEFT JOIN perfil_permissoes pp ON pp.perfil_id = pf.id
       LEFT JOIN permissoes p ON p.id = pp.permissao_id
      GROUP BY pf.id ORDER BY pf.nome`,
  );
  return ok(res, rows, 'Perfis listados');
}));

usuariosRouter.get('/', exigirPermissao('usuarios.ler'), rota(async (req, res) => {
  const filtro = validar(req, 'query', paginacaoSchema);
  const valores: unknown[] = [];
  let onde = 'WHERE u.deleted_at IS NULL';
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    onde += ` AND (u.nome ILIKE $1 OR u.email ILIKE $1)`;
  }
  const total = await query<{ total: number }>(`SELECT count(*)::int AS total FROM usuarios u ${onde}`, valores);
  const { rows } = await query(
    `SELECT u.id, u.nome, u.email, u.ativo, u.ultimo_login, u.created_at,
            u.perfil_id, pf.nome AS perfil
       FROM usuarios u JOIN perfis pf ON pf.id = u.perfil_id
       ${onde} ORDER BY u.nome LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)],
  );
  return ok(res, rows, 'Usuarios listados', metaPaginacao(total.rows[0]?.total ?? 0, filtro));
}));

usuariosRouter.post('/', exigirPermissao('usuarios.criar'), rota(async (req, res) => {
  const dados = validar(req, 'body', criarUsuarioSchema);
  const usuario = await comTransacao({ usuarioId: req.usuario!.id, ip: req.ipCliente }, async (cliente) => {
    const { rows } = await cliente.query(
      `INSERT INTO usuarios (nome, email, senha_hash, perfil_id, ativo)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, nome, email, perfil_id, ativo, created_at`,
      [dados.nome, dados.email, await gerarHashSenha(dados.senha), dados.perfil_id, dados.ativo],
    );
    return rows[0];
  });
  return criado(res, usuario, 'Usuario criado com sucesso');
}));

usuariosRouter.put('/:id', exigirPermissao('usuarios.editar'), rota(async (req, res) => {
  const { id } = validar(req, 'params', idSchema);
  const dados = validar(req, 'body', atualizarUsuarioSchema);

  if (id === req.usuario!.id && dados.ativo === false) {
    throw regraNegocio('Voce nao pode desativar o proprio usuario');
  }

  const campos: string[] = [];
  const valores: unknown[] = [id];
  for (const chave of ['nome', 'email', 'perfil_id', 'ativo'] as const) {
    if (dados[chave] !== undefined) {
      valores.push(dados[chave]);
      campos.push(`${chave} = $${valores.length}`);
    }
  }
  if (dados.senha) {
    valores.push(await gerarHashSenha(dados.senha));
    campos.push(`senha_hash = $${valores.length}`);
  }
  if (campos.length === 0) throw regraNegocio('Nenhum campo informado para atualizacao');

  const usuario = await comTransacao({ usuarioId: req.usuario!.id, ip: req.ipCliente }, async (cliente) => {
    const { rows } = await cliente.query(
      `UPDATE usuarios SET ${campos.join(', ')} WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, nome, email, perfil_id, ativo, ultimo_login`,
      valores,
    );
    if (!rows[0]) throw naoEncontrado('Usuario');
    return rows[0];
  });
  limparCachePermissoes();
  return ok(res, usuario, 'Usuario atualizado com sucesso');
}));

usuariosRouter.delete('/:id', exigirPermissao('usuarios.excluir'), rota(async (req, res) => {
  const { id } = validar(req, 'params', idSchema);
  if (id === req.usuario!.id) throw regraNegocio('Voce nao pode excluir o proprio usuario');

  await comTransacao({ usuarioId: req.usuario!.id, ip: req.ipCliente }, async (cliente) => {
    const { rows } = await cliente.query(
      'UPDATE usuarios SET deleted_at = now(), ativo = FALSE WHERE id = $1 AND deleted_at IS NULL RETURNING id',
      [id],
    );
    if (!rows[0]) throw naoEncontrado('Usuario');
  });
  return ok(res, { id }, 'Usuario removido');
}));
