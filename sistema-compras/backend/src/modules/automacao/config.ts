/**
 * Leitura das configuracoes do grupo `automacao` (secao 43).
 *
 * As configuracoes moram no banco, nao no codigo, porque quem opera o sistema
 * precisa mudar um limite sem esperar por deploy. O cache existe porque o
 * worker le esses valores a cada ciclo - de cinco em cinco segundos - e ir ao
 * banco por um numero que muda uma vez por mes e desperdicio.
 *
 * O TTL e curto de proposito: uma mudanca feita na tela vale em meio minuto, o
 * que e rapido o bastante para quem esta ajustando e lento o bastante para nao
 * pesar. `invalidar()` existe para a propria tela chamar apos salvar, tornando
 * o efeito imediato quando o usuario esta olhando.
 */
import { query } from '../../config/database.js';

const TTL_MS = 30_000;

let cache: Map<string, string> | null = null;
let carregadoEm = 0;

export function invalidar(): void {
  cache = null;
  carregadoEm = 0;
}

async function carregar(): Promise<Map<string, string>> {
  if (cache && Date.now() - carregadoEm < TTL_MS) return cache;
  const { rows } = await query<{ chave: string; valor: string }>(
    "SELECT chave, valor FROM configuracoes WHERE grupo = 'automacao' AND ativo");
  cache = new Map(rows.map((r) => [r.chave, r.valor]));
  carregadoEm = Date.now();
  return cache;
}

export async function texto(chave: string, padrao: string): Promise<string> {
  const mapa = await carregar();
  return mapa.get(`automacao.${chave}`) ?? padrao;
}

export async function numero(chave: string, padrao: number): Promise<number> {
  const bruto = await texto(chave, String(padrao));
  const valor = Number(bruto);
  return Number.isFinite(valor) ? valor : padrao;
}

export async function ligado(chave: string, padrao: boolean): Promise<boolean> {
  const bruto = (await texto(chave, String(padrao))).trim().toLowerCase();
  return bruto === 'true' || bruto === '1' || bruto === 'sim';
}

/** Tudo de uma vez, para as telas de operacao. */
export async function todas(): Promise<Record<string, string>> {
  return Object.fromEntries(await carregar());
}
