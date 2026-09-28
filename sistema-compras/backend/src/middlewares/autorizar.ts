import type { RequestHandler } from 'express';
import { naoAutenticado, semPermissao } from '../core/errors.js';

/**
 * Autorizacao por permissao granular (<modulo>.<acao>).
 * A interface esconde botoes, mas quem realmente decide e este middleware.
 */
export const exigirPermissao =
  (...permissoes: string[]): RequestHandler =>
  (req, _res, next) => {
    const usuario = req.usuario;
    if (!usuario) return next(naoAutenticado());

    // ADMIN tem acesso total por definicao do perfil
    const autorizado =
      usuario.permissoes.includes('*') || permissoes.some((p) => usuario.permissoes.includes(p));

    if (!autorizado) {
      return next(semPermissao(`Permissao necessaria: ${permissoes.join(' ou ')}`));
    }
    return next();
  };

export const exigirPerfil =
  (...perfis: string[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.usuario) return next(naoAutenticado());
    if (!perfis.includes(req.usuario.perfil)) return next(semPermissao());
    return next();
  };
