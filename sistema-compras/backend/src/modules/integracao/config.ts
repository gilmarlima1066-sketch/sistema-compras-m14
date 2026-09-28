/**
 * Configuracoes do grupo `integracao`.
 *
 * Mesma forma do modulo 13: os limites moram no banco porque quem opera precisa
 * ajustar timeout ou tolerancia de conciliacao sem esperar por deploy. O cache
 * curto existe porque o worker le estes valores a cada ciclo.
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
    "SELECT chave, valor FROM configuracoes WHERE grupo = 'integracao' AND ativo");
  cache = new Map(rows.map((r) => [r.chave, r.valor]));
  carregadoEm = Date.now();
  return cache;
}

export async function texto(chave: string, padrao: string): Promise<string> {
  const mapa = await carregar();
  return mapa.get(`integracao.${chave}`) ?? padrao;
}

export async function numero(chave: string, padrao: number): Promise<number> {
  const valor = Number(await texto(chave, String(padrao)));
  return Number.isFinite(valor) ? valor : padrao;
}

export async function ligado(chave: string, padrao: boolean): Promise<boolean> {
  const bruto = (await texto(chave, String(padrao))).trim().toLowerCase();
  return bruto === 'true' || bruto === '1' || bruto === 'sim';
}

export async function todas(): Promise<Record<string, string>> {
  return Object.fromEntries(await carregar());
}

/**
 * Hosts de rede interna que o operador liberou para endpoint de integracao.
 *
 * Vazio por padrao: nenhum endereco interno passa. Liberar e um ato consciente,
 * host a host, em `integracao.hosts_internos_permitidos` - e nao um efeito
 * colateral de desligar a protecao inteira.
 */
export async function hostsInternosPermitidos(): Promise<string[]> {
  const bruto = await texto('hosts_internos_permitidos', '');
  return bruto.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}
