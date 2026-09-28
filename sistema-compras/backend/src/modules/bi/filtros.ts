/**
 * Filtros globais (secoes 7 e 8).
 *
 * Um unico objeto de filtro atravessa todos os KPIs. Cada resolvedor declara
 * quais dimensoes ele sabe aplicar; o que ele nao sabe aplicar aparece na
 * resposta como `filtros_ignorados`, em vez de ser silenciosamente descartado.
 *
 * Essa honestidade importa: um numero que ignorou o filtro de categoria e
 * responde como se tivesse aplicado e pior do que um numero ausente.
 */
import { hojeLocal, paraDataCalendario } from '../../core/datas.js';

export interface FiltroGlobal {
  periodo?: string;
  dias?: number;
  data_inicio?: string;
  data_fim?: string;
  categoria_id?: number | null;
  produto_id?: number | null;
  fornecedor_id?: number | null;
  local_id?: number | null;
  comprador_id?: number | null;
  origem?: 'NACIONAL' | 'IMPORTADO' | null;
  status?: string | null;
}

export type Dimensao =
  | 'categoria' | 'produto' | 'fornecedor' | 'local' | 'comprador' | 'origem' | 'status';

export interface Periodo {
  inicio: string;
  fim: string;
  dias: number;
  rotulo: string;
}

const DIAS_POR_ROTULO: Record<string, number> = {
  HOJE: 1, SEMANA: 7, MES: 30, TRIMESTRE: 90, SEMESTRE: 180, ANO: 365,
};

const somar = (data: string, dias: number) =>
  paraDataCalendario(new Date(Date.parse(`${data}T00:00:00Z`) + dias * 86400000))!;

/** Resolve o periodo a partir do atalho, dos dias ou do intervalo. */
export function resolverPeriodo(filtro: FiltroGlobal, padraoDias = 90): Periodo {
  const hoje = hojeLocal();
  const ano = Number(hoje.slice(0, 4));
  const rotulo = (filtro.periodo ?? '').toUpperCase();

  if (rotulo === 'ANO_ANTERIOR') {
    return { inicio: `${ano - 1}-01-01`, fim: `${ano - 1}-12-31`, dias: 365, rotulo };
  }
  if (rotulo === 'ANO_ATUAL' || rotulo === 'ANO') {
    return { inicio: `${ano}-01-01`, fim: hoje, dias: 365, rotulo: rotulo || 'ANO_ATUAL' };
  }
  if (filtro.data_inicio && filtro.data_fim) {
    const dias = Math.max(1, Math.round(
      (Date.parse(`${filtro.data_fim}T00:00:00Z`)
        - Date.parse(`${filtro.data_inicio}T00:00:00Z`)) / 86400000));
    return {
      inicio: filtro.data_inicio, fim: filtro.data_fim, dias,
      rotulo: rotulo || 'PERSONALIZADO',
    };
  }

  const dias = filtro.dias ?? DIAS_POR_ROTULO[rotulo] ?? padraoDias;
  const fim = filtro.data_fim ?? hoje;
  return {
    inicio: filtro.data_inicio ?? somar(fim, -dias),
    fim,
    dias,
    rotulo: rotulo || `ULTIMOS_${dias}`,
  };
}

/**
 * Periodo imediatamente anterior, do mesmo tamanho (secao 49).
 *
 * Comparar 90 dias com 30 daria uma queda que nao existe.
 */
export function periodoAnterior(periodo: Periodo): Periodo {
  const fim = somar(periodo.inicio, -1);
  return {
    inicio: somar(fim, -periodo.dias),
    fim,
    dias: periodo.dias,
    rotulo: 'PERIODO_ANTERIOR',
  };
}

/** Mesmo periodo do ano passado (secao 49). */
export function mesmoPeriodoAnoAnterior(periodo: Periodo): Periodo {
  const recuar = (d: string) => {
    const [a, m, dia] = d.split('-');
    return `${Number(a) - 1}-${m}-${dia}`;
  };
  return {
    inicio: recuar(periodo.inicio),
    fim: recuar(periodo.fim),
    dias: periodo.dias,
    rotulo: 'ANO_ANTERIOR',
  };
}

/** Quais dimensoes o filtro pediu, independente de serem aplicaveis. */
export function dimensoesPedidas(filtro: FiltroGlobal): Dimensao[] {
  const pedidas: Dimensao[] = [];
  if (filtro.categoria_id) pedidas.push('categoria');
  if (filtro.produto_id) pedidas.push('produto');
  if (filtro.fornecedor_id) pedidas.push('fornecedor');
  if (filtro.local_id) pedidas.push('local');
  if (filtro.comprador_id) pedidas.push('comprador');
  if (filtro.origem) pedidas.push('origem');
  if (filtro.status) pedidas.push('status');
  return pedidas;
}

/** O que o resolvedor nao soube aplicar. Vai na resposta, nao some. */
export function dimensoesIgnoradas(
  filtro: FiltroGlobal, suportadas: Dimensao[],
): Dimensao[] {
  return dimensoesPedidas(filtro).filter((d) => !suportadas.includes(d));
}

/**
 * Monta as condicoes SQL das dimensoes suportadas.
 *
 * `colunas` mapeia cada dimensao para a coluna daquela consulta. Dimensao sem
 * coluna declarada nao entra - e o resolvedor a reporta como ignorada.
 */
export function condicoes(
  filtro: FiltroGlobal,
  colunas: Partial<Record<Dimensao, string>>,
  valores: unknown[],
): string {
  const cond: string[] = [];
  const aplicar = (dimensao: Dimensao, valor: unknown) => {
    const coluna = colunas[dimensao];
    if (!coluna || valor === null || valor === undefined) return;
    valores.push(valor);
    cond.push(`${coluna} = $${valores.length}`);
  };

  aplicar('categoria', filtro.categoria_id);
  aplicar('produto', filtro.produto_id);
  aplicar('fornecedor', filtro.fornecedor_id);
  aplicar('local', filtro.local_id);
  aplicar('comprador', filtro.comprador_id);

  // Origem nao e igualdade simples: importado e qualquer coisa diferente de
  // nacional na origem do fornecedor.
  if (filtro.origem && colunas.origem) {
    valores.push(filtro.origem === 'NACIONAL' ? 'NACIONAL' : 'NACIONAL');
    cond.push(filtro.origem === 'NACIONAL'
      ? `${colunas.origem} = $${valores.length}`
      : `${colunas.origem} <> $${valores.length}`);
  }

  if (filtro.status && colunas.status) {
    valores.push(filtro.status);
    cond.push(`${colunas.status}::text = $${valores.length}`);
  }

  return cond.length ? ` AND ${cond.join(' AND ')}` : '';
}

/** Resumo dos filtros aplicados, para a tela e para o registro do resultado. */
export function resumo(filtro: FiltroGlobal, periodo: Periodo) {
  return {
    periodo,
    categoria_id: filtro.categoria_id ?? null,
    produto_id: filtro.produto_id ?? null,
    fornecedor_id: filtro.fornecedor_id ?? null,
    local_id: filtro.local_id ?? null,
    comprador_id: filtro.comprador_id ?? null,
    origem: filtro.origem ?? null,
    status: filtro.status ?? null,
  };
}
