/**
 * Infraestrutura compartilhada das baterias de teste.
 *
 * As baterias conversam com a API pela rede, como um cliente real: e a unica
 * forma de provar que middleware, validacao, permissao e transacao estao todos
 * no lugar. Caminhos sao informados por inteiro, incluindo o prefixo /api.
 *
 *   npm run dev              (em um terminal)
 *   npm run test:m04         (em outro)
 */
import { env } from '../../config/env.js';

export const BASE = process.env.BASE_URL ?? `http://localhost:${env.PORT}`;

export interface Resposta<T = any> {
  status: number;
  corpo: T;
}

export interface Bateria {
  nome: string;
  passou: number;
  falhou: number;
  falhas: string[];
}

export function novaBateria(nome: string): Bateria {
  console.log(`\n=== ${nome} ===`);
  return { nome, passou: 0, falhou: 0, falhas: [] };
}

export function checar(b: Bateria, descricao: string, condicao: boolean, detalhe?: unknown) {
  if (condicao) {
    b.passou += 1;
    console.log(`  ok   ${descricao}`);
  } else {
    b.falhou += 1;
    b.falhas.push(descricao);
    const extra = detalhe === undefined ? '' : ` -> ${JSON.stringify(detalhe).slice(0, 400)}`;
    console.log(`  FALHOU  ${descricao}${extra}`);
  }
}

export function secao(titulo: string) {
  console.log(`\n[${titulo}]`);
}

export async function chamar<T = any>(
  metodo: string,
  caminho: string,
  opcoes: { token?: string; corpo?: unknown; cabecalhos?: Record<string, string> } = {},
): Promise<Resposta<T>> {
  const resposta = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(opcoes.token ? { Authorization: `Bearer ${opcoes.token}` } : {}),
      ...(opcoes.cabecalhos ?? {}),
    },
    body: opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo),
  });
  return { status: resposta.status, corpo: (await resposta.json().catch(() => null)) as T };
}

export async function loginAdmin(): Promise<string> {
  const { corpo } = await chamar('POST', '/api/auth/login', {
    corpo: { email: env.SEED_ADMIN_EMAIL, senha: env.SEED_ADMIN_SENHA },
  });
  const token = corpo?.data?.token;
  if (!token) throw new Error('Nao foi possivel autenticar o administrador do seed');
  return token;
}

/**
 * Cria (ou reaproveita) um usuario do perfil pedido e devolve o token dele.
 * O token do ADMIN vem primeiro porque e ele quem tem permissao de criar usuario.
 */
export async function tokenDoPerfil(tokenAdmin: string, perfil: string, marca = 'teste'): Promise<string | null> {
  const email = `${perfil.toLowerCase()}.${marca}@teste.local`;
  const senha = 'Teste@12345';

  const { corpo: perfis } = await chamar('GET', '/api/usuarios/perfis', { token: tokenAdmin });
  const lista: { id: number; nome: string }[] = perfis?.data ?? [];
  const encontrado = lista.find((p) => p.nome === perfil);
  if (!encontrado) return null;

  await chamar('POST', '/api/usuarios', {
    token: tokenAdmin,
    corpo: { nome: `Usuario ${perfil}`, email, senha, perfil_id: encontrado.id, ativo: true },
  });

  const { corpo } = await chamar('POST', '/api/auth/login', { corpo: { email, senha } });
  return corpo?.data?.token ?? null;
}

export function encerrar(baterias: Bateria[]): void {
  const passou = baterias.reduce((a, b) => a + b.passou, 0);
  const falhou = baterias.reduce((a, b) => a + b.falhou, 0);
  console.log(`\n${'='.repeat(64)}`);
  for (const b of baterias) {
    console.log(`${b.nome}: ${b.passou} ok, ${b.falhou} falhou`);
    b.falhas.forEach((f) => console.log(`   - ${f}`));
  }
  console.log(`TOTAL: ${passou + falhou} verificacoes | ${passou} passaram | ${falhou} falharam`);
  console.log('='.repeat(64));
  process.exitCode = falhou > 0 ? 1 : 0;
}
