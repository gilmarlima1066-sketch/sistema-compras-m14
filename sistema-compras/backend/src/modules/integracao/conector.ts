/**
 * Cliente de API configuravel (secoes 7, 24, 30 e 37).
 *
 * Um conector HTTP de integracao nao e um `fetch` com URL: e um `fetch` que
 * sabe desistir na hora certa, tentar de novo quando vale a pena, parar de
 * tentar quando nao vale, e nunca deixar um segredo cair no log.
 *
 * As quatro decisoes que sustentam isso:
 *
 * 1. **Timeout sempre.** `fetch` sem `AbortSignal` espera para sempre. Um ERP
 *    que aceita a conexao e nao responde prenderia o worker indefinidamente, e
 *    a fila pararia sem nenhum erro aparecer em lugar nenhum.
 *
 * 2. **Retry so no que e recuperavel** (secao 30). Timeout, conexao recusada,
 *    429 e 5xx merecem nova tentativa; 400, 401, 403 e 404 vao falhar igual nas
 *    proximas mil. Insistir no definitivo e o retry infinito que a secao 30
 *    proibe, com o agravante de esconder a causa real atras de tentativas.
 *
 * 3. **O log e higienizado na origem.** Cabecalho de autorizacao e parametro de
 *    chave nunca chegam a ser gravados - sao removidos antes, no unico ponto
 *    por onde toda requisicao passa. Depender de cada chamador lembrar seria
 *    uma questao de tempo ate um esquecer.
 *
 * 4. **DELETE exige autorizacao explicita** (secao 24). A configuracao
 *    `integracao.permitir_delete_externo` nasce falsa.
 */
import { setTimeout as esperar } from 'node:timers/promises';
import { regraNegocio, semPermissao } from '../../core/errors.js';
import { ligado, numero as configNumero } from './config.js';

export type Metodo = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type TipoErro =
  | 'AUTENTICACAO' | 'AUTORIZACAO' | 'TIMEOUT' | 'CONEXAO' | 'LIMITE_TAXA'
  | 'PAYLOAD_INVALIDO' | 'VALIDACAO' | 'MAPEAMENTO' | 'REFERENCIA_INEXISTENTE'
  | 'DUPLICIDADE' | 'INDISPONIVEL' | 'INTERNO';

export type ClasseErro = 'RECUPERAVEL' | 'DEFINITIVO' | 'DESCONHECIDO';

export interface ErroConector {
  tipo: TipoErro;
  classe: ClasseErro;
  mensagem: string;
  status?: number;
  corpo?: string;
}

export interface RespostaConector<T = unknown> {
  ok: boolean;
  status: number;
  dados?: T;
  bruto?: string;
  cabecalhos: Record<string, string>;
  duracao_ms: number;
  tentativas: number;
  erro?: ErroConector;
}

export interface Requisicao {
  url: string;
  metodo?: Metodo;
  cabecalhos?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  corpo?: unknown;
  timeout_segundos?: number;
  max_tentativas?: number;
  backoff_base_segundos?: number;
  /** Permite DELETE nesta chamada. Exige tambem a configuracao geral. */
  autorizar_delete?: boolean;
}

// ---------------------------------------------------------------------------
// Classificacao de erro (secao 30)
// ---------------------------------------------------------------------------

/**
 * Traduz status HTTP em tipo e classe.
 *
 * O 429 e recuperavel de proposito: e o servidor pedindo para esperar, nao
 * dizendo que a requisicao esta errada. Respeitar o `Retry-After` dele e o que
 * separa um cliente educado de um que apanha ate ser bloqueado.
 */
export function classificarStatus(status: number): { tipo: TipoErro; classe: ClasseErro } {
  if (status === 401) return { tipo: 'AUTENTICACAO', classe: 'DEFINITIVO' };
  if (status === 403) return { tipo: 'AUTORIZACAO', classe: 'DEFINITIVO' };
  if (status === 404) return { tipo: 'REFERENCIA_INEXISTENTE', classe: 'DEFINITIVO' };
  if (status === 409) return { tipo: 'DUPLICIDADE', classe: 'DEFINITIVO' };
  if (status === 408) return { tipo: 'TIMEOUT', classe: 'RECUPERAVEL' };
  if (status === 422) return { tipo: 'VALIDACAO', classe: 'DEFINITIVO' };
  if (status === 429) return { tipo: 'LIMITE_TAXA', classe: 'RECUPERAVEL' };
  if (status >= 500) return { tipo: 'INDISPONIVEL', classe: 'RECUPERAVEL' };
  if (status >= 400) return { tipo: 'PAYLOAD_INVALIDO', classe: 'DEFINITIVO' };
  return { tipo: 'INTERNO', classe: 'DESCONHECIDO' };
}

export function classificarExcecao(erro: unknown): { tipo: TipoErro; classe: ClasseErro } {
  const mensagem = erro instanceof Error ? erro.message : String(erro);
  const nome = erro instanceof Error ? erro.name : '';

  if (nome === 'AbortError' || /abort|timeout/i.test(mensagem)) {
    return { tipo: 'TIMEOUT', classe: 'RECUPERAVEL' };
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|fetch failed/i
    .test(mensagem)) {
    return { tipo: 'CONEXAO', classe: 'RECUPERAVEL' };
  }
  if (/certificate|SSL|TLS/i.test(mensagem)) {
    return { tipo: 'CONEXAO', classe: 'DEFINITIVO' };
  }
  return { tipo: 'INTERNO', classe: 'DESCONHECIDO' };
}

export const recuperavel = (classe: ClasseErro): boolean => classe === 'RECUPERAVEL';

/** Backoff exponencial com teto. O mesmo formato do modulo 13, de proposito. */
export const intervaloBackoff = (tentativa: number, base: number, maximo: number): number =>
  Math.min(maximo, base * 2 ** Math.max(0, tentativa - 1));

// ---------------------------------------------------------------------------
// Higienizacao (secao 37)
// ---------------------------------------------------------------------------

const CABECALHOS_SIGILOSOS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'x-auth-token', 'x-access-token', 'api-key', 'x-webhook-secret',
]);

const PARAMETROS_SIGILOSOS = ['api_key', 'apikey', 'token', 'access_token',
  'secret', 'client_secret', 'password', 'senha', 'key'];

/** Remove cabecalho sigiloso antes de qualquer gravacao. */
export function higienizarCabecalhos(
  cabecalhos: Record<string, string>,
): Record<string, string> {
  const limpo: Record<string, string> = {};
  for (const [chave, valor] of Object.entries(cabecalhos)) {
    limpo[chave] = CABECALHOS_SIGILOSOS.has(chave.toLowerCase()) ? '[removido]' : valor;
  }
  return limpo;
}

/**
 * Mascara a URL para log: mantem endereco e caminho, apaga o valor de
 * parametro sigiloso. A URL inteira num log e o vazamento mais facil de
 * cometer, porque parece inofensiva.
 */
export function higienizarUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const chave of [...u.searchParams.keys()]) {
      if (PARAMETROS_SIGILOSOS.some((p) => chave.toLowerCase().includes(p))) {
        u.searchParams.set(chave, '[removido]');
      }
    }
    return u.toString();
  } catch {
    return url.split('?')[0] ?? url;
  }
}

/** Higieniza corpo de requisicao ou resposta antes de gravar. */
export function higienizarCorpo(valor: unknown, profundidade = 0): unknown {
  if (profundidade > 6 || valor === null || valor === undefined) return valor;
  if (Array.isArray(valor)) {
    return valor.slice(0, 50).map((v) => higienizarCorpo(v, profundidade + 1));
  }
  if (typeof valor === 'object') {
    const limpo: Record<string, unknown> = {};
    for (const [chave, v] of Object.entries(valor as Record<string, unknown>)) {
      limpo[chave] = PARAMETROS_SIGILOSOS.some((p) => chave.toLowerCase().includes(p))
        ? '[removido]' : higienizarCorpo(v, profundidade + 1);
    }
    return limpo;
  }
  return valor;
}

// ---------------------------------------------------------------------------
// Limite de taxa (secao 37)
// ---------------------------------------------------------------------------

/**
 * Janela deslizante por conector, em memoria.
 *
 * Em memoria porque o limite protege o sistema DO OUTRO LADO de um processo
 * nosso, e cada processo precisa se conter. Um contador compartilhado no banco
 * daria uma escrita por requisicao para controlar requisicoes - o remedio
 * custando mais que a doenca.
 */
const janelas = new Map<string, number[]>();

export function limiteExcedido(chave: string, porMinuto: number): boolean {
  if (porMinuto <= 0) return false;
  const agora = Date.now();
  const corte = agora - 60_000;
  const marcas = (janelas.get(chave) ?? []).filter((t) => t > corte);

  if (marcas.length >= porMinuto) {
    janelas.set(chave, marcas);
    return true;
  }
  marcas.push(agora);
  janelas.set(chave, marcas);
  return false;
}

export function limparJanelas(): void {
  janelas.clear();
}

// ---------------------------------------------------------------------------
// A chamada
// ---------------------------------------------------------------------------

function montarUrl(
  base: string, parametros?: Record<string, string | number | boolean | undefined | null>,
): string {
  if (!parametros) return base;
  const u = new URL(base);
  for (const [chave, valor] of Object.entries(parametros)) {
    if (valor !== undefined && valor !== null && valor !== '') {
      u.searchParams.set(chave, String(valor));
    }
  }
  return u.toString();
}

export async function chamar<T = unknown>(
  requisicao: Requisicao,
): Promise<RespostaConector<T>> {
  const metodo = requisicao.metodo ?? 'GET';

  if (metodo === 'DELETE') {
    const permitido = await ligado('permitir_delete_externo', false);
    if (!permitido || !requisicao.autorizar_delete) {
      throw semPermissao(
        'DELETE em sistema externo exige autorizacao explicita: ligue '
        + '`integracao.permitir_delete_externo` E marque a chamada como autorizada '
        + '(secao 24).');
    }
  }

  const timeout = (requisicao.timeout_segundos
    ?? await configNumero('timeout_padrao_segundos', 30)) * 1000;
  const maxTentativas = requisicao.max_tentativas
    ?? await configNumero('max_tentativas', 3);
  const base = requisicao.backoff_base_segundos
    ?? await configNumero('backoff_base_segundos', 30);
  const maximo = await configNumero('backoff_maximo_segundos', 3600);

  const url = montarUrl(requisicao.url, requisicao.query);
  const inicio = Date.now();
  let ultimoErro: ErroConector | undefined;

  for (let tentativa = 1; tentativa <= maxTentativas; tentativa += 1) {
    const controlador = new AbortController();
    const relogio = setTimeout(() => controlador.abort(), timeout);

    try {
      const cabecalhos: Record<string, string> = {
        Accept: 'application/json',
        ...requisicao.cabecalhos,
      };
      if (requisicao.corpo !== undefined) {
        cabecalhos['Content-Type'] = cabecalhos['Content-Type'] ?? 'application/json';
      }

      const resposta = await fetch(url, {
        method: metodo,
        headers: cabecalhos,
        body: requisicao.corpo === undefined ? undefined
          : typeof requisicao.corpo === 'string' ? requisicao.corpo
            : JSON.stringify(requisicao.corpo),
        signal: controlador.signal,
      });
      clearTimeout(relogio);

      const bruto = await resposta.text();
      const cabecalhosResposta = higienizarCabecalhos(
        Object.fromEntries(resposta.headers.entries()));

      if (resposta.ok) {
        let dados: T | undefined;
        if (bruto) {
          try {
            dados = JSON.parse(bruto) as T;
          } catch {
            // Resposta sem JSON nao e erro por si: o conector devolve o texto
            // e quem chamou decide se sabe lidar.
            dados = undefined;
          }
        }
        return {
          ok: true,
          status: resposta.status,
          ...(dados !== undefined ? { dados } : {}),
          bruto: bruto.slice(0, 20000),
          cabecalhos: cabecalhosResposta,
          duracao_ms: Date.now() - inicio,
          tentativas: tentativa,
        };
      }

      const { tipo, classe } = classificarStatus(resposta.status);
      ultimoErro = {
        tipo,
        classe,
        mensagem: `HTTP ${resposta.status} ${resposta.statusText}`.trim(),
        status: resposta.status,
        corpo: bruto.slice(0, 2000),
      };

      if (!recuperavel(classe) || tentativa >= maxTentativas) {
        return {
          ok: false,
          status: resposta.status,
          bruto: bruto.slice(0, 20000),
          cabecalhos: cabecalhosResposta,
          duracao_ms: Date.now() - inicio,
          tentativas: tentativa,
          erro: ultimoErro,
        };
      }

      // O servidor disse quanto esperar: obedecer e melhor que adivinhar.
      const pedido = Number(resposta.headers.get('retry-after'));
      const espera = Number.isFinite(pedido) && pedido > 0
        ? Math.min(pedido, maximo)
        : intervaloBackoff(tentativa, base, maximo);
      await esperar(Math.min(espera, 30) * 1000);
    } catch (erro) {
      clearTimeout(relogio);
      const { tipo, classe } = classificarExcecao(erro);
      ultimoErro = {
        tipo,
        classe,
        mensagem: tipo === 'TIMEOUT'
          ? `Sem resposta em ${timeout / 1000}s`
          : (erro instanceof Error ? erro.message : String(erro)),
      };

      if (!recuperavel(classe) || tentativa >= maxTentativas) break;
      await esperar(Math.min(intervaloBackoff(tentativa, base, maximo), 30) * 1000);
    }
  }

  return {
    ok: false,
    status: 0,
    cabecalhos: {},
    duracao_ms: Date.now() - inicio,
    tentativas: maxTentativas,
    erro: ultimoErro ?? {
      tipo: 'INTERNO', classe: 'DESCONHECIDO', mensagem: 'Falha sem causa identificada',
    },
  };
}

// ---------------------------------------------------------------------------
// Paginacao (secao 24)
// ---------------------------------------------------------------------------

export interface Paginacao {
  tipo: 'offset' | 'pagina' | 'cursor' | 'nenhuma';
  tamanho?: number;
  parametro_offset?: string;
  parametro_limite?: string;
  parametro_pagina?: string;
  parametro_cursor?: string;
  campo_dados?: string;
  campo_cursor?: string;
  campo_total?: string;
}

/**
 * Percorre todas as paginas ate acabar ou bater o teto.
 *
 * O teto nao e opcional. Uma API que devolve sempre a mesma pagina - por bug
 * ou por parametro ignorado - faria este laco rodar para sempre consumindo
 * memoria. O limite transforma um travamento silencioso em um resultado
 * truncado com aviso, que e recuperavel.
 */
export async function paginar<T = Record<string, unknown>>(
  requisicao: Requisicao,
  paginacao: Paginacao,
  limiteTotal: number,
): Promise<{
  registros: T[]; paginas: number; truncado: boolean; duracao_ms: number;
  erro?: ErroConector; aviso?: string;
}> {
  const inicio = Date.now();
  const registros: T[] = [];
  const tamanho = paginacao.tamanho ?? 500;
  const campoDados = paginacao.campo_dados ?? 'dados';

  let pagina = 0;
  let cursor: string | undefined;
  let aviso: string | undefined;

  const extrair = (dados: unknown): T[] => {
    if (Array.isArray(dados)) return dados as T[];
    if (dados && typeof dados === 'object') {
      const corpo = dados as Record<string, unknown>;
      // Aceita o campo configurado e os nomes mais comuns, nesta ordem.
      for (const nome of [campoDados, 'dados', 'data', 'items', 'results', 'registros']) {
        if (Array.isArray(corpo[nome])) return corpo[nome] as T[];
      }
    }
    return [];
  };

  for (;;) {
    const parametros: Record<string, string | number> = {};
    if (paginacao.tipo === 'offset') {
      parametros[paginacao.parametro_offset ?? 'offset'] = pagina * tamanho;
      parametros[paginacao.parametro_limite ?? 'limit'] = tamanho;
    } else if (paginacao.tipo === 'pagina') {
      parametros[paginacao.parametro_pagina ?? 'page'] = pagina + 1;
      parametros[paginacao.parametro_limite ?? 'limit'] = tamanho;
    } else if (paginacao.tipo === 'cursor' && cursor) {
      parametros[paginacao.parametro_cursor ?? 'cursor'] = cursor;
    }

    const resposta = await chamar({
      ...requisicao,
      query: { ...requisicao.query, ...parametros },
    });

    if (!resposta.ok) {
      return {
        registros, paginas: pagina, truncado: true,
        duracao_ms: Date.now() - inicio,
        ...(resposta.erro ? { erro: resposta.erro } : {}),
        ...(registros.length
          ? { aviso: `Falhou na pagina ${pagina + 1}; ${registros.length} registros `
            + 'obtidos antes disso foram mantidos' }
          : {}),
      };
    }

    const lote = extrair(resposta.dados);
    registros.push(...lote);
    pagina += 1;

    if (registros.length >= limiteTotal) {
      aviso = `Limite de ${limiteTotal} registros por execucao atingido; `
        + 'o restante entra na proxima sincronizacao';
      return {
        registros: registros.slice(0, limiteTotal),
        paginas: pagina, truncado: true, duracao_ms: Date.now() - inicio, aviso,
      };
    }

    if (paginacao.tipo === 'nenhuma' || lote.length === 0 || lote.length < tamanho) break;

    if (paginacao.tipo === 'cursor') {
      const corpo = resposta.dados as Record<string, unknown> | undefined;
      const proximo = corpo?.[paginacao.campo_cursor ?? 'proximo_cursor'];
      if (typeof proximo !== 'string' || !proximo || proximo === cursor) break;
      cursor = proximo;
    }

    // Trava contra API que ignora o parametro de pagina e devolve sempre o
    // mesmo lote: sem ela o laco so pararia no limite total, depois de muitas
    // chamadas inuteis.
    if (pagina > 2000) {
      aviso = 'Interrompido apos 2000 paginas: a API pode estar ignorando a paginacao';
      return {
        registros, paginas: pagina, truncado: true,
        duracao_ms: Date.now() - inicio, aviso,
      };
    }
  }

  return {
    registros, paginas: pagina, truncado: false, duracao_ms: Date.now() - inicio,
    ...(aviso ? { aviso } : {}),
  };
}

// ---------------------------------------------------------------------------
// Teste de conexao (secao 39: POST /integrations/{id}/test)
// ---------------------------------------------------------------------------

/**
 * Bate na URL e conta o que achou, sem processar nada.
 *
 * Existe para a pergunta "esta configurado certo?" ter resposta ANTES de a
 * primeira sincronizacao rodar e sujar o painel de erro.
 */
export async function testar(requisicao: Requisicao): Promise<{
  alcancavel: boolean; status: number; duracao_ms: number;
  url: string; diagnostico: string; erro?: ErroConector;
}> {
  const resposta = await chamar({ ...requisicao, max_tentativas: 1 });
  const url = higienizarUrl(montarUrl(requisicao.url, requisicao.query));

  if (resposta.ok) {
    return {
      alcancavel: true, status: resposta.status, duracao_ms: resposta.duracao_ms, url,
      diagnostico: `Respondeu ${resposta.status} em ${resposta.duracao_ms} ms`,
    };
  }

  const erro = resposta.erro!;
  const explicacao: Record<TipoErro, string> = {
    AUTENTICACAO: 'O servidor recusou a credencial. Confira a referencia segura '
      + 'e se a variavel de ambiente esta definida NESTE servidor.',
    AUTORIZACAO: 'A credencial e valida mas nao tem permissao para este recurso.',
    TIMEOUT: 'O servidor aceitou a conexao e nao respondeu no prazo. '
      + 'Aumente o timeout ou verifique a carga do lado de la.',
    CONEXAO: 'Nao foi possivel alcancar o endereco. Confira a URL, o DNS e se '
      + 'a saida de rede deste servidor permite chegar la.',
    LIMITE_TAXA: 'O servidor pediu para reduzir o ritmo. Ajuste o limite por minuto.',
    PAYLOAD_INVALIDO: 'O servidor recusou o formato da requisicao.',
    VALIDACAO: 'O servidor recebeu, entendeu e recusou o conteudo.',
    MAPEAMENTO: 'A resposta nao tem o formato que o mapeamento espera.',
    REFERENCIA_INEXISTENTE: 'O endereco respondeu 404: o caminho pode estar errado.',
    DUPLICIDADE: 'O servidor informou que o registro ja existe.',
    INDISPONIVEL: 'O servidor esta com problema interno. Tente mais tarde.',
    INTERNO: 'Falha sem causa identificada.',
  };

  return {
    alcancavel: false,
    status: resposta.status,
    duracao_ms: resposta.duracao_ms,
    url,
    diagnostico: `${erro.mensagem}. ${explicacao[erro.tipo]}`,
    erro,
  };
}
