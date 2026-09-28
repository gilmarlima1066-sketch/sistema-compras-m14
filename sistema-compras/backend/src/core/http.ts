import type { Response, RequestHandler } from 'express';

export interface RespostaSucesso<T> {
  success: true;
  data: T;
  message: string;
  meta?: Record<string, unknown>;
}

export function ok<T>(res: Response, data: T, message = 'Operacao realizada com sucesso', meta?: Record<string, unknown>) {
  const corpo: RespostaSucesso<T> = { success: true, data, message };
  if (meta) corpo.meta = meta;
  return res.status(200).json(corpo);
}

export function criado<T>(res: Response, data: T, message = 'Registro criado com sucesso') {
  return res.status(201).json({ success: true, data, message });
}

/** Encapsula handlers async para que rejeicoes caiam no middleware de erro. */
export const rota =
  (handler: RequestHandler): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
