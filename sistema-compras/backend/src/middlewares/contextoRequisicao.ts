import type { RequestHandler } from 'express';

/** Normaliza o IP de origem usado na auditoria. */
export const contextoRequisicao: RequestHandler = (req, _res, next) => {
  const encaminhado = req.headers['x-forwarded-for'];
  const primeiro = Array.isArray(encaminhado) ? encaminhado[0] : encaminhado?.split(',')[0];
  req.ipCliente = (primeiro ?? req.ip ?? '').trim() || null as unknown as string;
  next();
};
