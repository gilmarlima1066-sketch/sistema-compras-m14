import type { UsuarioAutenticado } from '../modules/auth/auth.types.js';

declare global {
  namespace Express {
    interface Request {
      usuario?: UsuarioAutenticado;
      ipCliente?: string;
    }
  }
}

export {};
