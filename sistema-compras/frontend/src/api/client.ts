import type { Meta, RespostaApi } from './tipos';

const BASE = import.meta.env.VITE_API_URL ?? '/api';
const CHAVE_TOKEN = 'compras.token';

export class ErroApi extends Error {
  constructor(
    public codigo: string,
    mensagem: string,
    public status: number,
    public detalhes: Array<{ campo?: string; mensagem: string }> = [],
  ) {
    super(mensagem);
  }
}

export const token = {
  ler: () => localStorage.getItem(CHAVE_TOKEN),
  gravar: (valor: string) => localStorage.setItem(CHAVE_TOKEN, valor),
  limpar: () => localStorage.removeItem(CHAVE_TOKEN),
};

/** Disparado quando a API recusa o token — o AuthContext escuta e desloga. */
const eventoSessaoExpirada = 'compras:sessao-expirada';
export const aoExpirarSessao = (fn: () => void) => {
  window.addEventListener(eventoSessaoExpirada, fn);
  return () => window.removeEventListener(eventoSessaoExpirada, fn);
};

interface Opcoes {
  metodo?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  corpo?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  semAutenticacao?: boolean;
}

/**
 * Cliente HTTP unico da aplicacao. Concentra o envelope padrao da API
 * ({success, data, message}), o envio do JWT e a traducao de erros —
 * nenhuma tela fala com `fetch` diretamente.
 */
export async function api<T>(caminho: string, opcoes: Opcoes = {}): Promise<{ data: T; meta?: Meta; message: string }> {
  const { metodo = 'GET', corpo, query, semAutenticacao } = opcoes;

  const url = new URL(`${BASE}${caminho}`, window.location.origin);
  if (query) {
    for (const [chave, valor] of Object.entries(query)) {
      if (valor !== undefined && valor !== null && valor !== '') url.searchParams.set(chave, String(valor));
    }
  }

  const cabecalhos: Record<string, string> = {};
  if (corpo !== undefined) cabecalhos['Content-Type'] = 'application/json';
  const jwt = token.ler();
  if (jwt && !semAutenticacao) cabecalhos.Authorization = `Bearer ${jwt}`;

  let resposta: Response;
  try {
    resposta = await fetch(url.toString(), {
      method: metodo,
      headers: cabecalhos,
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
  } catch {
    throw new ErroApi('NETWORK_ERROR', 'Nao foi possivel falar com a API. Verifique se o servidor esta no ar.', 0);
  }

  let json: RespostaApi<T> | { success: false; error: { code: string; message: string; details?: unknown[] } };
  try {
    json = await resposta.json();
  } catch {
    throw new ErroApi('INVALID_RESPONSE', `Resposta invalida da API (HTTP ${resposta.status})`, resposta.status);
  }

  if (!resposta.ok || !('success' in json) || json.success === false) {
    const erro = 'error' in json ? json.error : { code: 'ERROR', message: 'Erro inesperado' };
    if (resposta.status === 401 && !semAutenticacao) {
      token.limpar();
      window.dispatchEvent(new Event(eventoSessaoExpirada));
    }
    throw new ErroApi(
      erro.code,
      erro.message,
      resposta.status,
      (erro as { details?: Array<{ campo?: string; mensagem: string }> }).details ?? [],
    );
  }

  const sucesso = json as RespostaApi<T>;
  return { data: sucesso.data, meta: sucesso.meta, message: sucesso.message };
}
