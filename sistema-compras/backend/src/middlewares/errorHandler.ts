import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ErroApp } from '../core/errors.js';
import { env } from '../config/env.js';

interface ErroPostgres extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
  hint?: string;
}

/** Traduz erros do PostgreSQL para a resposta padrao da API. */
function traduzirErroBanco(erro: ErroPostgres): ErroApp | null {
  switch (erro.code) {
    case '23505': // unique_violation
      return new ErroApp('CONFLICT', 'Ja existe um registro com este valor unico', 409, [
        { constraint: erro.constraint, detalhe: erro.detail },
      ]);
    case '23503': // foreign_key_violation
      return new ErroApp('BUSINESS_RULE', 'Registro relacionado inexistente ou em uso', 422, [
        { constraint: erro.constraint, detalhe: erro.detail },
      ]);
    case '23502': // not_null_violation
      return new ErroApp('VALIDATION_ERROR', 'Campo obrigatorio nao informado', 422, [
        { detalhe: erro.detail ?? erro.message },
      ]);
    case '23514': // check_violation
    case 'P0001': // raise exception das triggers de regra de negocio
      return new ErroApp('BUSINESS_RULE', erro.message.replace(/^.*?:\s*/, ''), 422, [
        { constraint: erro.constraint, dica: erro.hint },
      ]);
    default:
      return null;
  }
}

export const errorHandler: ErrorRequestHandler = (erro, _req, res, _next) => {
  const appErro =
    erro instanceof ErroApp ? erro : traduzirErroBanco(erro as ErroPostgres);

  if (appErro) {
    return res.status(appErro.status).json({
      success: false,
      error: { code: appErro.codigo, message: appErro.message, details: appErro.detalhes },
    });
  }

  console.error('[erro-nao-tratado]', erro);
  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Erro interno do servidor',
      details: env.isProduction ? [] : [{ mensagem: (erro as Error).message }],
    },
  });
};

export const rotaNaoEncontrada: RequestHandler = (req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `Rota ${req.method} ${req.path} nao existe`, details: [] },
  });
};
