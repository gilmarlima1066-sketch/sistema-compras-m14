import type { RequestHandler } from 'express';
import { carregarUsuarioDoToken } from '../modules/auth/auth.service.js';
import { naoAutenticado } from '../core/errors.js';

export const autenticar: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(naoAutenticado('Token nao informado'));

  carregarUsuarioDoToken(header.slice(7))
    .then((usuario) => {
      req.usuario = usuario;
      next();
    })
    .catch(next);
};
