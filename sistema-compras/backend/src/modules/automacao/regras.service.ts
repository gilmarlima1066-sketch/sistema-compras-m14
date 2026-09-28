/**
 * Motor de regras (secao 8) e avaliador de condicoes.
 *
 * A condicao e dado, nao codigo: uma lista de comparacoes sobre campos do
 * payload do evento. O avaliador entende um conjunto FECHADO de operadores.
 *
 * Por que fechado: a alternativa obvia seria guardar uma expressao e avalia-la
 * - com `eval`, `Function`, ou uma mini-linguagem. Qualquer uma dessas
 * transforma a tabela de regras numa porta de execucao de codigo para quem
 * tiver escrita nela, e uma tabela de configuracao nao deveria ter esse poder.
 * Com operadores fechados, o pior que uma regra malformada faz e nao disparar.
 */
import { query } from '../../config/database.js';

export type Operador =
  | '=' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'nin'
  | 'contem' | 'existe' | 'vazio' | 'entre';

export interface Condicao {
  campo: string;
  operador: Operador;
  valor?: unknown;
}

export interface Regra {
  id: number;
  codigo: string;
  nome: string;
  descricao: string | null;
  evento: string;
  condicao: Condicao[];
  acao: string;
  parametros: Record<string, unknown>;
  nivel: 'AUTOMATICO' | 'ASSISTIDO' | 'APROVACAO';
  prioridade: number;
  perfil_autorizado: string | null;
  versao: number;
  max_tentativas: number;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Lê um campo do payload, aceitando caminho com ponto.
 *
 * `produto.classe_abc` funciona, e um campo ausente devolve `undefined` - o
 * que faz a comparacao falhar em vez de explodir. Regra que aponta para campo
 * inexistente simplesmente nao dispara, que e o comportamento seguro.
 */
function ler(payload: Record<string, unknown>, caminho: string): unknown {
  return caminho.split('.').reduce<unknown>((atual, parte) => {
    if (atual === null || atual === undefined) return undefined;
    return (atual as Record<string, unknown>)[parte];
  }, payload);
}

/** Avalia uma condicao. Operador desconhecido devolve false, nunca dispara. */
export function avaliarCondicao(
  c: Condicao, payload: Record<string, unknown>,
): boolean {
  const atual = ler(payload, c.campo);
  const alvo = c.valor;

  switch (c.operador) {
    case '=':  return String(atual) === String(alvo);
    case '!=': return String(atual) !== String(alvo);
    case '>':  { const a = num(atual); const b = num(alvo); return a !== null && b !== null && a > b; }
    case '>=': { const a = num(atual); const b = num(alvo); return a !== null && b !== null && a >= b; }
    case '<':  { const a = num(atual); const b = num(alvo); return a !== null && b !== null && a < b; }
    case '<=': { const a = num(atual); const b = num(alvo); return a !== null && b !== null && a <= b; }
    case 'in':  return Array.isArray(alvo) && alvo.map(String).includes(String(atual));
    case 'nin': return Array.isArray(alvo) && !alvo.map(String).includes(String(atual));
    case 'contem':
      return typeof atual === 'string'
        && atual.toLowerCase().includes(String(alvo).toLowerCase());
    case 'existe': return atual !== undefined && atual !== null && atual !== '';
    case 'vazio':  return atual === undefined || atual === null || atual === '';
    case 'entre': {
      const a = num(atual);
      const faixa = Array.isArray(alvo) ? alvo.map(num) : [];
      return a !== null && faixa.length === 2 && faixa[0] !== null && faixa[1] !== null
        && a >= faixa[0] && a <= faixa[1];
    }
    default:
      return false;
  }
}

/**
 * Todas as condicoes precisam passar (E logico).
 *
 * Lista vazia dispara sempre - uma regra sem condicao e uma regra que vale
 * para todo evento daquele tipo, e ha varias assim no catalogo (ruptura, por
 * exemplo: o proprio evento ja e a condicao).
 */
export function avaliar(
  condicoes: Condicao[], payload: Record<string, unknown>,
): { aprovada: boolean; detalhes: Array<{ condicao: Condicao; passou: boolean; valor: unknown }> } {
  const detalhes = condicoes.map((c) => ({
    condicao: c,
    passou: avaliarCondicao(c, payload),
    valor: ler(payload, c.campo),
  }));
  return { aprovada: detalhes.every((d) => d.passou), detalhes };
}

/** Regras ativas e vigentes para um tipo de evento, em ordem de prioridade. */
export async function paraEvento(tipo: string): Promise<Regra[]> {
  const { rows } = await query<Record<string, unknown>>(`
    SELECT id, codigo, nome, descricao, evento, condicao, acao, parametros,
           nivel::text AS nivel, prioridade, perfil_autorizado, versao, max_tentativas
      FROM automacao_regras
     WHERE ativo
       AND upper(evento) = upper($1)
       AND vigencia_inicio <= CURRENT_DATE
       AND (vigencia_fim IS NULL OR vigencia_fim >= CURRENT_DATE)
     ORDER BY prioridade, id`, [tipo]);

  return rows.map((r) => ({
    id: Number(r.id),
    codigo: String(r.codigo),
    nome: String(r.nome),
    descricao: (r.descricao as string) ?? null,
    evento: String(r.evento),
    condicao: (r.condicao as Condicao[]) ?? [],
    acao: String(r.acao),
    parametros: (r.parametros as Record<string, unknown>) ?? {},
    nivel: r.nivel as Regra['nivel'],
    prioridade: Number(r.prioridade),
    perfil_autorizado: (r.perfil_autorizado as string) ?? null,
    versao: Number(r.versao),
    max_tentativas: Number(r.max_tentativas),
  }));
}

export async function listar(filtro: { evento?: string; ativo?: boolean; acao?: string }) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const add = (sql: string, valor: unknown) => {
    if (valor === undefined || valor === null || valor === '') return;
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };
  add('upper(r.evento) = upper($?)', filtro.evento);
  add('r.acao = $?', filtro.acao);
  if (filtro.ativo !== undefined) {
    valores.push(filtro.ativo);
    cond.push(`r.ativo = $${valores.length}`);
  }

  const { rows } = await query(`
    SELECT r.*, r.nivel::text AS nivel,
           (SELECT count(*) FROM automacao_execucoes x WHERE x.regra_id = r.id) AS execucoes,
           (SELECT count(*) FROM automacao_execucoes x
             WHERE x.regra_id = r.id AND x.status = 'ERRO')                     AS falhas,
           (SELECT max(x.iniciado_em) FROM automacao_execucoes x
             WHERE x.regra_id = r.id)                                          AS ultima_execucao
      FROM automacao_regras r
     ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
     ORDER BY r.prioridade, r.codigo`, valores);
  return rows;
}

export interface EntradaRegra {
  codigo?: string;
  nome?: string;
  descricao?: string;
  evento?: string;
  condicao?: Condicao[];
  acao?: string;
  parametros?: Record<string, unknown>;
  nivel?: string;
  prioridade?: number;
  ativo?: boolean;
  max_tentativas?: number;
  vigencia_fim?: string | null;
}

const OPERADORES_VALIDOS = new Set<string>([
  '=', '!=', '>', '>=', '<', '<=', 'in', 'nin', 'contem', 'existe', 'vazio', 'entre',
]);

/** Valida a condicao antes de gravar: operador fora do conjunto e recusado. */
export function validarCondicao(condicoes: Condicao[]): string | null {
  for (const c of condicoes) {
    if (!c.campo || typeof c.campo !== 'string') {
      return 'Toda condicao precisa de um campo';
    }
    if (!OPERADORES_VALIDOS.has(c.operador)) {
      return `Operador nao permitido: ${c.operador}. Use um de: `
        + [...OPERADORES_VALIDOS].join(', ');
    }
    if (['in', 'nin', 'entre'].includes(c.operador) && !Array.isArray(c.valor)) {
      return `O operador ${c.operador} exige uma lista em "valor"`;
    }
  }
  return null;
}

/**
 * Altera a regra e incrementa a versao (secao 8).
 *
 * A versao sobe a cada alteracao porque a execucao guarda com qual versao ela
 * rodou. Sem isso, uma execucao de tres meses atras seria explicada pela regra
 * de hoje - que pode ter mudado justamente por causa dela.
 */
export async function atualizar(id: number, entrada: EntradaRegra, usuarioId: number | null) {
  if (entrada.condicao) {
    const erro = validarCondicao(entrada.condicao);
    if (erro) throw new Error(erro);
  }

  const campos: string[] = [];
  const valores: unknown[] = [id];
  const set = (coluna: string, valor: unknown, cast = '') => {
    if (valor === undefined) return;
    valores.push(valor);
    campos.push(`${coluna} = $${valores.length}${cast}`);
  };

  set('nome', entrada.nome);
  set('descricao', entrada.descricao);
  set('evento', entrada.evento);
  set('condicao', entrada.condicao ? JSON.stringify(entrada.condicao) : undefined, '::jsonb');
  set('acao', entrada.acao);
  set('parametros', entrada.parametros ? JSON.stringify(entrada.parametros) : undefined, '::jsonb');
  set('nivel', entrada.nivel, '::nivel_automacao_enum');
  set('prioridade', entrada.prioridade);
  set('ativo', entrada.ativo);
  set('max_tentativas', entrada.max_tentativas);
  set('vigencia_fim', entrada.vigencia_fim);

  if (!campos.length) return null;

  valores.push(usuarioId);
  const { rows } = await query(`
    UPDATE automacao_regras
       SET ${campos.join(', ')},
           versao = versao + 1,
           updated_by = $${valores.length},
           updated_at = now()
     WHERE id = $1
    RETURNING *, nivel::text AS nivel`, valores);
  return rows[0] ?? null;
}

export async function criar(entrada: Required<Pick<EntradaRegra,
'codigo' | 'nome' | 'evento' | 'acao'>> & EntradaRegra, usuarioId: number | null) {
  const condicao = entrada.condicao ?? [];
  const erro = validarCondicao(condicao);
  if (erro) throw new Error(erro);

  const { rows } = await query(`
    INSERT INTO automacao_regras
      (codigo, nome, descricao, evento, condicao, acao, parametros, nivel,
       prioridade, max_tentativas, ativo, created_by, updated_by)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::nivel_automacao_enum,
            $9,$10,$11,$12,$12)
    RETURNING *, nivel::text AS nivel`,
  [entrada.codigo, entrada.nome, entrada.descricao ?? null, entrada.evento,
    JSON.stringify(condicao), entrada.acao,
    JSON.stringify(entrada.parametros ?? {}), entrada.nivel ?? 'ASSISTIDO',
    entrada.prioridade ?? 100, entrada.max_tentativas ?? 3,
    entrada.ativo ?? true, usuarioId]);
  return rows[0];
}

/**
 * Simula uma regra contra um payload, sem executar nada.
 *
 * Existe porque ajustar limiar no escuro e como calibrar balanca sem peso: o
 * operador muda o numero, espera o dia seguinte e descobre que disparou para a
 * base inteira. Aqui ele ve, condicao por condicao, o que passou e com que
 * valor.
 */
export async function simular(regraId: number, payload: Record<string, unknown>) {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, codigo, nome, evento, condicao, acao, nivel::text AS nivel, ativo
       FROM automacao_regras WHERE id = $1`, [regraId]);
  if (!rows.length) return null;

  const r = rows[0]!;
  const condicoes = (r.condicao as Condicao[]) ?? [];
  const resultado = avaliar(condicoes, payload);

  return {
    regra: { id: Number(r.id), codigo: r.codigo, nome: r.nome, evento: r.evento,
      acao: r.acao, nivel: r.nivel, ativo: r.ativo },
    payload,
    dispararia: resultado.aprovada && Boolean(r.ativo),
    ativa: Boolean(r.ativo),
    condicoes: resultado.detalhes.map((d) => ({
      campo: d.condicao.campo,
      operador: d.condicao.operador,
      esperado: d.condicao.valor,
      valor_no_payload: d.valor,
      passou: d.passou,
    })),
    observacao: resultado.aprovada && !r.ativo
      ? 'As condicoes passam, mas a regra esta inativa'
      : undefined,
  };
}
