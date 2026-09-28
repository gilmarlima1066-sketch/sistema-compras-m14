/** Erros de dominio com codigo estavel para o frontend. */
export type CodigoErro =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BUSINESS_RULE'
  | 'INTERNAL_ERROR';

export class ErroApp extends Error {
  constructor(
    public readonly codigo: CodigoErro,
    message: string,
    public readonly status: number,
    public readonly detalhes: unknown[] = [],
  ) {
    super(message);
    this.name = 'ErroApp';
  }
}

export const erroValidacao = (msg = 'Dados invalidos', detalhes: unknown[] = []) =>
  new ErroApp('VALIDATION_ERROR', msg, 422, detalhes);

export const naoAutenticado = (msg = 'Credenciais invalidas ou sessao expirada') =>
  new ErroApp('UNAUTHORIZED', msg, 401);

export const semPermissao = (msg = 'Seu perfil nao tem permissao para esta operacao') =>
  new ErroApp('FORBIDDEN', msg, 403);

export const naoEncontrado = (recurso = 'Registro') =>
  new ErroApp('NOT_FOUND', `${recurso} nao encontrado`, 404);

export const conflito = (msg: string, detalhes: unknown[] = []) =>
  new ErroApp('CONFLICT', msg, 409, detalhes);

export const regraNegocio = (msg: string, detalhes: unknown[] = []) =>
  new ErroApp('BUSINESS_RULE', msg, 422, detalhes);
