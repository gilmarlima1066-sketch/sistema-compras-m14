import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { query } from '../../config/database.js';
import { naoAutenticado } from '../../core/errors.js';
import type { PayloadToken, UsuarioAutenticado } from './auth.types.js';

export const gerarHashSenha = (senha: string) => bcrypt.hash(senha, env.BCRYPT_ROUNDS);

/** Cache curto das permissoes por perfil: evita 2 queries por request. */
const cachePermissoes = new Map<number, { permissoes: string[]; expiraEm: number }>();
const TTL_CACHE_MS = 60_000;

export function limparCachePermissoes(perfilId?: number) {
  if (perfilId) cachePermissoes.delete(perfilId);
  else cachePermissoes.clear();
}

export async function permissoesDoPerfil(perfilId: number): Promise<string[]> {
  const cacheado = cachePermissoes.get(perfilId);
  if (cacheado && cacheado.expiraEm > Date.now()) return cacheado.permissoes;

  const { rows } = await query<{ codigo: string }>(
    `SELECT p.codigo
       FROM perfil_permissoes pp
       JOIN permissoes p ON p.id = pp.permissao_id
      WHERE pp.perfil_id = $1
      ORDER BY p.codigo`,
    [perfilId],
  );
  const permissoes = rows.map((r) => r.codigo);
  cachePermissoes.set(perfilId, { permissoes, expiraEm: Date.now() + TTL_CACHE_MS });
  return permissoes;
}

interface LinhaUsuario {
  id: number;
  nome: string;
  email: string;
  senha_hash: string;
  perfil_id: number;
  ativo: boolean;
  perfil: string;
  perfil_ativo: boolean;
}

async function buscarPorEmail(email: string): Promise<LinhaUsuario | null> {
  const { rows } = await query<LinhaUsuario>(
    `SELECT u.id, u.nome, u.email, u.senha_hash, u.perfil_id, u.ativo,
            pf.nome AS perfil, pf.ativo AS perfil_ativo
       FROM usuarios u
       JOIN perfis pf ON pf.id = u.perfil_id
      WHERE lower(u.email) = lower($1) AND u.deleted_at IS NULL`,
    [email],
  );
  return rows[0] ?? null;
}

export async function autenticar(email: string, senha: string): Promise<{ token: string; usuario: UsuarioAutenticado }> {
  const usuario = await buscarPorEmail(email);

  // Mesmo sem usuario rodamos um compare para nao vazar quais emails existem
  const hashReferencia = usuario?.senha_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali';
  const senhaConfere = await bcrypt.compare(senha, hashReferencia);

  if (!usuario || !senhaConfere) throw naoAutenticado();
  if (!usuario.ativo) throw naoAutenticado('Usuario inativo. Procure o administrador do sistema.');
  if (!usuario.perfil_ativo) throw naoAutenticado('Perfil de acesso desativado.');

  const permissoes = await permissoesDoPerfil(usuario.perfil_id);
  const payload: PayloadToken = { sub: usuario.id, perfil: usuario.perfil, perfil_id: usuario.perfil_id };
  const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as SignOptions);

  await query('UPDATE usuarios SET ultimo_login = now() WHERE id = $1', [usuario.id]);

  return {
    token,
    usuario: {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      perfil_id: usuario.perfil_id,
      perfil: usuario.perfil,
      permissoes,
    },
  };
}

/** Revalida o usuario a cada request: desativar alguem encerra o acesso na hora. */
export async function carregarUsuarioDoToken(token: string): Promise<UsuarioAutenticado> {
  let payload: PayloadToken;
  try {
    payload = jwt.verify(token, env.JWT_SECRET) as unknown as PayloadToken;
  } catch {
    throw naoAutenticado('Sessao invalida ou expirada');
  }

  const { rows } = await query<LinhaUsuario>(
    `SELECT u.id, u.nome, u.email, u.senha_hash, u.perfil_id, u.ativo,
            pf.nome AS perfil, pf.ativo AS perfil_ativo
       FROM usuarios u
       JOIN perfis pf ON pf.id = u.perfil_id
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [payload.sub],
  );
  const usuario = rows[0];
  if (!usuario || !usuario.ativo || !usuario.perfil_ativo) throw naoAutenticado('Usuario sem acesso ativo');

  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    perfil_id: usuario.perfil_id,
    perfil: usuario.perfil,
    permissoes: await permissoesDoPerfil(usuario.perfil_id),
  };
}

export async function alterarSenha(usuarioId: number, senhaAtual: string, novaSenha: string): Promise<void> {
  const { rows } = await query<{ senha_hash: string }>(
    'SELECT senha_hash FROM usuarios WHERE id = $1 AND deleted_at IS NULL',
    [usuarioId],
  );
  const atual = rows[0];
  if (!atual || !(await bcrypt.compare(senhaAtual, atual.senha_hash))) {
    throw naoAutenticado('Senha atual incorreta');
  }
  await query('UPDATE usuarios SET senha_hash = $2 WHERE id = $1', [usuarioId, await gerarHashSenha(novaSenha)]);
}
