/**
 * Apuracao de KPI: catalogo + resolvedor + meta + semaforo.
 *
 * Este e o unico caminho pelo qual um numero chega a um dashboard. Nenhuma
 * tela calcula indicador por conta propria - todas pedem o codigo aqui
 * (secao 67 e regra 2 da secao 71).
 */
import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { hojeLocal } from '../../core/datas.js';
import {
  avaliarMeta, compararPeriodos, textoDesvio,
  type Avaliacao, type Direcao, type Semaforo, type Unidade,
} from './calculos.js';
import {
  dimensoesIgnoradas, mesmoPeriodoAnoAnterior, periodoAnterior, resolverPeriodo, resumo,
  type FiltroGlobal, type Periodo,
} from './filtros.js';
import { RESOLVEDORES, type Contexto } from './resolvedores.js';

const num = (v: unknown) => Number(v ?? 0);
const ouNulo = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function configuracoes(): Promise<Record<string, string>> {
  const { rows } = await query<{ chave: string; valor: string }>(
    "SELECT chave, valor FROM configuracoes WHERE grupo = 'bi'");
  return Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
}

export const numeroConfig = (cfg: Record<string, string>, chave: string, padrao: number) => {
  const v = Number(cfg[chave]);
  return Number.isFinite(v) ? v : padrao;
};

// ---------------------------------------------------------------------------
// Catalogo
// ---------------------------------------------------------------------------

export interface Definicao {
  id: number;
  codigo: string;
  nome: string;
  descricao: string;
  objetivo: string | null;
  modulo: string;
  categoria: string | null;
  formula: string;
  fonte: string;
  tabelas: string | null;
  unidade: Unidade;
  periodicidade: string;
  direcao: Direcao;
  casasDecimais: number;
  minimoEventos: number;
  drilldown: string | null;
  interpretacao: string | null;
  responsavel: string | null;
  ativo: boolean;
  /**
   * Indicador de POSICAO, nao de periodo (secao 54).
   *
   * Reapurar um indicador pontual para um mes passado devolve a posicao de
   * hoje - o banco guarda a posicao atual, nao a de marco. Por isso a serie
   * reapurada e a comparacao entre periodos sao recusadas para eles: uma
   * linha reta de seis meses seria lida como estabilidade, e nao e.
   */
  pontual: boolean;
  /** Falso quando o catalogo tem a definicao mas nao existe resolvedor. */
  apuravel: boolean;
}

function paraDefinicao(r: Record<string, any>): Definicao {
  return {
    id: Number(r.id),
    codigo: r.codigo,
    nome: r.nome,
    descricao: r.descricao,
    objetivo: r.objetivo,
    modulo: r.modulo,
    categoria: r.categoria,
    formula: r.formula,
    fonte: r.fonte,
    tabelas: r.tabelas,
    unidade: r.unidade as Unidade,
    periodicidade: r.periodicidade,
    direcao: r.direcao as Direcao,
    casasDecimais: Number(r.casas_decimais),
    minimoEventos: Number(r.minimo_eventos),
    drilldown: r.drilldown,
    interpretacao: r.interpretacao,
    responsavel: r.responsavel ?? null,
    ativo: r.ativo,
    pontual: Boolean(r.pontual),
    apuravel: Boolean(RESOLVEDORES[String(r.codigo).toUpperCase()]),
  };
}

export async function carregarDefinicao(codigo: string): Promise<Definicao> {
  const { rows } = await query(`
    SELECT k.*, u.nome AS responsavel FROM kpi_definicoes k
    LEFT JOIN usuarios u ON u.id = k.responsavel_id
     WHERE upper(k.codigo) = upper($1)`, [codigo]);
  if (!rows.length) throw naoEncontrado(`KPI ${codigo}`);
  return paraDefinicao(rows[0]);
}

export async function listarDefinicoes(filtro: {
  modulo?: string; busca?: string; apenas_ativos?: boolean;
} = {}): Promise<Definicao[]> {
  const valores: unknown[] = [];
  const cond: string[] = [];
  if (filtro.modulo) {
    valores.push(filtro.modulo);
    cond.push(`k.modulo = $${valores.length}::modulo_kpi_enum`);
  }
  if (filtro.apenas_ativos !== false) cond.push('k.ativo');
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(k.codigo ILIKE $${valores.length} OR k.nome ILIKE $${valores.length}`
      + ` OR k.descricao ILIKE $${valores.length})`);
  }
  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const { rows } = await query(`
    SELECT k.*, u.nome AS responsavel FROM kpi_definicoes k
    LEFT JOIN usuarios u ON u.id = k.responsavel_id
    ${onde} ORDER BY k.modulo, k.codigo`, valores);

  return rows.map(paraDefinicao);
}

// ---------------------------------------------------------------------------
// Meta vigente (secoes 12 e 51)
// ---------------------------------------------------------------------------

export interface MetaVigente {
  id: number;
  escopo: string;
  meta: number;
  limiteAtencao: number | null;
  limiteCritico: number | null;
  vigenciaInicio: string;
  observacao: string | null;
}

/**
 * Meta do mais especifico para o mais geral.
 *
 * `referencia` e a data pela qual a vigencia e avaliada: apurar um periodo
 * passado usa a meta que valia NAQUELA epoca, nao a de hoje. E o que sustenta
 * o cenario 4 da secao 70 - mudar a meta nao reescreve o historico.
 */
export async function metaVigente(
  kpiId: number, filtro: FiltroGlobal, referencia: string,
): Promise<MetaVigente | null> {
  // O `id DESC` no fim da ordenacao nao e enfeite: duas metas do mesmo escopo
  // podem comecar no MESMO dia - corrigir uma meta no dia em que foi criada e
  // corriqueiro. Sem esse desempate, qual delas vale fica a criterio do plano
  // de execucao do banco, e o mesmo indicador pode mostrar metas diferentes em
  // duas consultas seguidas. Com ele, vale sempre a ultima definida.
  const { rows } = await query(`
    SELECT * FROM kpi_metas
     WHERE kpi_id = $1 AND ativo
       AND vigencia_inicio <= $2::date
       AND (vigencia_fim IS NULL OR vigencia_fim >= $2::date)
       AND (
         (escopo = 'PRODUTO'    AND produto_id = $3)
         OR (escopo = 'FORNECEDOR' AND fornecedor_id = $4)
         OR (escopo = 'CATEGORIA'  AND categoria_id = $5)
         OR (escopo = 'FILIAL'     AND local_id = $6)
         OR (escopo = 'COMPRADOR'  AND comprador_id = $7)
         OR escopo = 'EMPRESA'
       )
     ORDER BY CASE escopo WHEN 'PRODUTO' THEN 1 WHEN 'FORNECEDOR' THEN 2
                          WHEN 'CATEGORIA' THEN 3 WHEN 'FILIAL' THEN 4
                          WHEN 'COMPRADOR' THEN 5 ELSE 6 END,
              vigencia_inicio DESC, id DESC
     LIMIT 1`,
    [kpiId, referencia, filtro.produto_id ?? null, filtro.fornecedor_id ?? null,
      filtro.categoria_id ?? null, filtro.local_id ?? null, filtro.comprador_id ?? null]);

  if (!rows.length) return null;
  const m = rows[0];
  return {
    id: Number(m.id),
    escopo: m.escopo,
    meta: num(m.meta),
    limiteAtencao: ouNulo(m.limite_atencao),
    limiteCritico: ouNulo(m.limite_critico),
    vigenciaInicio: String(m.vigencia_inicio).slice(0, 10),
    observacao: m.observacao,
  };
}

// ---------------------------------------------------------------------------
// Apuracao
// ---------------------------------------------------------------------------

export interface ResultadoKpi {
  codigo: string;
  nome: string;
  modulo: string;
  categoria: string | null;
  unidade: Unidade;
  periodicidade: string;
  /** TRUE quando o numero e a posicao atual, nao o resultado do periodo. */
  pontual: boolean;
  direcao: Direcao;
  casas_decimais: number;
  valor: number | null;
  eventos: number;
  calculavel: boolean;
  motivo?: string;
  meta: MetaVigente | null;
  semaforo: Semaforo;
  desvio: number | null;
  desvio_texto: string | null;
  desvio_unidade: string;
  atingiu_meta: boolean | null;
  periodo: Periodo;
  formula: string;
  fonte: string;
  drilldown: string | null;
  interpretacao: string | null;
  filtros_aplicados: Record<string, unknown>;
  /** Dimensoes pedidas que este KPI nao sabe aplicar (secao 8). */
  filtros_ignorados: string[];
  detalhes?: Record<string, unknown>;
  atualizado_em: string;
}

/**
 * Apura um KPI.
 *
 * Quando o catalogo tem a definicao mas nao ha resolvedor, o KPI volta como
 * nao calculavel com esse motivo - em vez de sumir da tela ou aparecer zerado.
 */
export async function apurar(
  codigo: string, filtro: FiltroGlobal, cfg?: Record<string, string>,
): Promise<ResultadoKpi> {
  const definicao = await carregarDefinicao(codigo);
  const config = cfg ?? await configuracoes();
  const periodo = resolverPeriodo(filtro, numeroConfig(config, 'bi.dias_padrao', 90));
  const ctx: Contexto = { periodo, filtro, config };

  const resolvedor = RESOLVEDORES[definicao.codigo.toUpperCase()];

  const base = resolvedor
    ? await resolvedor(ctx)
    : {
      valor: null, eventos: 0, calculavel: false, suportadas: [],
      motivo: 'KPI catalogado, mas ainda sem apuracao automatica implementada',
    };

  const valor = base.calculavel && base.valor !== null
    ? Number(base.valor.toFixed(definicao.casasDecimais))
    : null;

  // A meta e lida pela data FINAL do periodo apurado.
  const meta = await metaVigente(definicao.id, filtro, periodo.fim);
  const avaliacao: Avaliacao = avaliarMeta(
    valor,
    meta ? {
      meta: meta.meta,
      limiteAtencao: meta.limiteAtencao,
      limiteCritico: meta.limiteCritico,
      direcao: definicao.direcao,
    } : null,
    definicao.unidade);

  return {
    codigo: definicao.codigo,
    nome: definicao.nome,
    modulo: definicao.modulo,
    categoria: definicao.categoria,
    unidade: definicao.unidade,
    periodicidade: definicao.periodicidade,
    pontual: definicao.pontual,
    direcao: definicao.direcao,
    casas_decimais: definicao.casasDecimais,
    valor,
    eventos: base.eventos,
    calculavel: base.calculavel && valor !== null,
    motivo: base.motivo,
    meta,
    semaforo: avaliacao.semaforo,
    desvio: avaliacao.desvio,
    desvio_texto: textoDesvio(avaliacao, definicao.casasDecimais),
    desvio_unidade: avaliacao.desvioUnidade,
    atingiu_meta: avaliacao.atingiuMeta,
    periodo,
    formula: definicao.formula,
    fonte: definicao.fonte,
    drilldown: definicao.drilldown,
    interpretacao: definicao.interpretacao,
    filtros_aplicados: resumo(filtro, periodo),
    filtros_ignorados: dimensoesIgnoradas(filtro, base.suportadas),
    detalhes: base.detalhes,
    atualizado_em: new Date().toISOString(),
  };
}

/** Apura varios KPIs de uma vez, compartilhando a configuracao. */
export async function apurarVarios(
  codigos: string[], filtro: FiltroGlobal,
): Promise<ResultadoKpi[]> {
  const config = await configuracoes();
  return Promise.all(codigos.map((c) => apurar(c, filtro, config)));
}

/**
 * Apura o KPI no periodo e nos dois comparativos da secao 49.
 *
 * O periodo anterior tem o MESMO tamanho: comparar 90 dias com 30 mostraria
 * uma queda que nao aconteceu.
 */
export async function apurarComComparacao(codigo: string, filtro: FiltroGlobal) {
  const config = await configuracoes();
  const atual = await apurar(codigo, filtro, config);

  // Comparar a posicao atual com "o periodo anterior" compararia o numero de
  // hoje com ele mesmo, e a variacao de 0% seria uma afirmacao falsa.
  if (atual.pontual) {
    return {
      ...atual,
      comparacao: null,
      motivo_comparacao: 'Indicador de posicao atual: nao ha posicao passada'
        + ' para comparar. Use o historico de resultados registrados.',
    };
  }

  const anterior = periodoAnterior(atual.periodo);
  const anoAnterior = mesmoPeriodoAnoAnterior(atual.periodo);

  const [rAnterior, rAno] = await Promise.all([
    apurar(codigo, {
      ...filtro, periodo: undefined, dias: undefined,
      data_inicio: anterior.inicio, data_fim: anterior.fim,
    }, config),
    apurar(codigo, {
      ...filtro, periodo: undefined, dias: undefined,
      data_inicio: anoAnterior.inicio, data_fim: anoAnterior.fim,
    }, config),
  ]);

  return {
    ...atual,
    comparacao: {
      periodo_anterior: {
        periodo: anterior,
        ...compararPeriodos(atual.valor, rAnterior.valor, atual.unidade, 1, atual.direcao),
      },
      ano_anterior: {
        periodo: anoAnterior,
        ...compararPeriodos(atual.valor, rAno.valor, atual.unidade, 1, atual.direcao),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Serie historica (secao 30)
// ---------------------------------------------------------------------------

/** Apura o KPI mes a mes, para a curva de tendencia. */
export async function serie(codigo: string, filtro: FiltroGlobal, meses = 6) {
  const definicaoBase = await carregarDefinicao(codigo);

  // Indicador de posicao nao tem serie reapuravel: cada mes devolveria o
  // numero de hoje. Devolver a recusa - com o motivo - e melhor do que
  // devolver seis pontos iguais que parecem uma tendencia estavel.
  if (definicaoBase.pontual) {
    return {
      codigo: definicaoBase.codigo,
      nome: definicaoBase.nome,
      unidade: definicaoBase.unidade,
      formula: definicaoBase.formula,
      meses,
      pontual: true,
      pontos: [] as Array<Record<string, unknown>>,
      motivo: 'Indicador de posicao atual: nao ha historico de posicao para reapurar.'
        + ' A serie passa a existir a partir dos resultados registrados em'
        + ' /kpis/' + definicaoBase.codigo + '/historico.',
    };
  }

  const config = await configuracoes();
  const base = resolverPeriodo(filtro, numeroConfig(config, 'bi.dias_padrao', 90));
  const [ano, mes] = base.fim.split('-').map(Number);

  const janelas: Array<{ inicio: string; fim: string; rotulo: string }> = [];
  for (let i = meses - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(ano, mes - 1 - i, 1));
    const a = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
    janelas.push({
      inicio: `${a}-${String(m).padStart(2, '0')}-01`,
      fim: `${a}-${String(m).padStart(2, '0')}-${ultimo}`,
      rotulo: `${a}-${String(m).padStart(2, '0')}`,
    });
  }

  const pontos = await Promise.all(janelas.map(async (j) => {
    const r = await apurar(codigo, {
      ...filtro, periodo: undefined, dias: undefined,
      data_inicio: j.inicio, data_fim: j.fim,
    }, config);
    return {
      periodo: j.rotulo,
      inicio: j.inicio,
      fim: j.fim,
      valor: r.valor,
      eventos: r.eventos,
      calculavel: r.calculavel,
      semaforo: r.semaforo,
      meta: r.meta?.meta ?? null,
    };
  }));

  const definicao = definicaoBase;
  return {
    codigo: definicao.codigo,
    nome: definicao.nome,
    unidade: definicao.unidade,
    formula: definicao.formula,
    meses,
    pontual: false,
    pontos,
  };
}

// ---------------------------------------------------------------------------
// Gravacao do resultado (secoes 49 e 61)
// ---------------------------------------------------------------------------

/**
 * Grava a apuracao na serie historica.
 *
 * Gravar permite comparar periodos sem recalcular anos de historico a cada
 * clique, e congela o numero como ele foi apurado - com a meta que valia na
 * epoca.
 */
export async function registrar(
  codigo: string, filtro: FiltroGlobal, contexto: ContextoSessao,
) {
  const r = await apurar(codigo, filtro);
  const definicao = await carregarDefinicao(codigo);

  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(`
      INSERT INTO kpi_resultados
        (kpi_id, periodo_inicio, periodo_fim, rotulo_periodo, valor, eventos,
         calculavel, motivo, meta, desvio, semaforo, filtros)
      VALUES ($1,$2::date,$3::date,$4,$5,$6,$7,$8,$9,$10,$11::semaforo_kpi_enum,$12::jsonb)
      RETURNING *`,
      [definicao.id, r.periodo.inicio, r.periodo.fim, r.periodo.rotulo,
        r.valor, r.eventos, r.calculavel, r.motivo ?? null,
        r.meta?.meta ?? null, r.desvio, r.semaforo,
        JSON.stringify(r.filtros_aplicados)]);
    return { ...r, resultado_id: Number(rows[0].id) };
  });
}

export async function historico(codigo: string, limite = 24) {
  const definicao = await carregarDefinicao(codigo);
  const { rows } = await query(`
    SELECT * FROM kpi_resultados WHERE kpi_id = $1
     ORDER BY periodo_fim DESC, id DESC LIMIT $2`, [definicao.id, limite]);

  return {
    codigo: definicao.codigo,
    nome: definicao.nome,
    unidade: definicao.unidade,
    formula: definicao.formula,
    fonte: definicao.fonte,
    registros: rows.reverse().map((r: Record<string, any>) => ({
      ...r,
      periodo_inicio: String(r.periodo_inicio).slice(0, 10),
      periodo_fim: String(r.periodo_fim).slice(0, 10),
    })),
  };
}

// ---------------------------------------------------------------------------
// Dicionario de indicadores (secao 66)
// ---------------------------------------------------------------------------

export async function dicionario() {
  const definicoes = await listarDefinicoes({ apenas_ativos: false });
  const { rows: metas } = await query(`
    SELECT m.kpi_id, m.escopo, m.meta, m.limite_atencao, m.limite_critico,
           m.vigencia_inicio, k.codigo
      FROM kpi_metas m JOIN kpi_definicoes k ON k.id = m.kpi_id
     WHERE m.ativo AND m.vigencia_fim IS NULL
     ORDER BY k.codigo`);

  const porCodigo = new Map<string, any[]>();
  for (const m of metas) {
    const lista = porCodigo.get(m.codigo) ?? [];
    lista.push({
      escopo: m.escopo, meta: num(m.meta),
      limite_atencao: ouNulo(m.limite_atencao),
      limite_critico: ouNulo(m.limite_critico),
      vigencia_inicio: String(m.vigencia_inicio).slice(0, 10),
    });
    porCodigo.set(m.codigo, lista);
  }

  const semApuracao = definicoes.filter((d) => !d.apuravel).map((d) => d.codigo);

  return {
    total: definicoes.length,
    apuraveis: definicoes.filter((d) => d.apuravel).length,
    sem_apuracao: semApuracao,
    por_modulo: [...new Set(definicoes.map((d) => d.modulo))].map((m) => ({
      modulo: m,
      kpis: definicoes.filter((d) => d.modulo === m).length,
    })),
    indicadores: definicoes.map((d) => ({
      ...d,
      metas: porCodigo.get(d.codigo) ?? [],
    })),
    atualizado_em: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Metas: manutencao
// ---------------------------------------------------------------------------

export interface EntradaMeta {
  codigo: string;
  escopo: string;
  categoria_id?: number;
  produto_id?: number;
  fornecedor_id?: number;
  local_id?: number;
  comprador_id?: number;
  meta: number;
  limite_atencao?: number;
  limite_critico?: number;
  observacao?: string;
}

/**
 * Define a meta.
 *
 * A meta anterior nao e apagada: recebe `vigencia_fim` de ontem. Assim o
 * historico continua explicavel - o semaforo de marco continua sendo o que o
 * numero de marco merecia (cenario 4 da secao 70).
 */
export async function definirMeta(entrada: EntradaMeta, contexto: ContextoSessao) {
  const definicao = await carregarDefinicao(entrada.codigo);

  // Em KPI onde menor e melhor, o limite critico fica ACIMA da meta. Validar
  // a ordem certa evita uma configuracao que nunca dispararia.
  const { meta, limite_atencao: atencao, limite_critico: critico } = entrada;
  if (atencao !== undefined && critico !== undefined) {
    const ordemCerta = definicao.direcao === 'MAIOR_MELHOR'
      ? meta >= atencao && atencao >= critico
      : meta <= atencao && atencao <= critico;
    if (!ordemCerta) {
      throw regraNegocio(definicao.direcao === 'MAIOR_MELHOR'
        ? `Em ${definicao.codigo} maior e melhor: a meta deve ser maior que o limite de`
          + ' atencao, e este maior que o critico'
        : `Em ${definicao.codigo} menor e melhor: a meta deve ser menor que o limite de`
          + ' atencao, e este menor que o critico');
    }
  }

  return comTransacao(contexto, async (cliente) => {
    // A meta anterior e encerrada na vespera da nova.
    //
    // Se ela comecou hoje, porem, nunca chegou a valer um dia inteiro: isso e
    // uma CORRECAO, nao uma troca de meta. Encerra-la em "ontem" produziria um
    // periodo de vigencia negativo - que o banco recusa, e com razao. Nesse
    // caso ela sai de cena como inativa, sem fingir que vigorou.
    await cliente.query(`
      UPDATE kpi_metas
         SET vigencia_fim = CASE WHEN vigencia_inicio < CURRENT_DATE
                                 THEN CURRENT_DATE - 1 END,
             ativo        = vigencia_inicio < CURRENT_DATE,
             updated_by = $2, updated_at = now()
       WHERE kpi_id = $1 AND ativo AND vigencia_fim IS NULL
         AND escopo = $3::escopo_meta_enum
         AND categoria_id IS NOT DISTINCT FROM $4
         AND produto_id IS NOT DISTINCT FROM $5
         AND fornecedor_id IS NOT DISTINCT FROM $6
         AND local_id IS NOT DISTINCT FROM $7
         AND comprador_id IS NOT DISTINCT FROM $8`,
      [definicao.id, contexto.usuarioId ?? null, entrada.escopo,
        entrada.categoria_id ?? null, entrada.produto_id ?? null,
        entrada.fornecedor_id ?? null, entrada.local_id ?? null,
        entrada.comprador_id ?? null]);

    const { rows } = await cliente.query(`
      INSERT INTO kpi_metas
        (kpi_id, escopo, categoria_id, produto_id, fornecedor_id, local_id, comprador_id,
         meta, limite_atencao, limite_critico, observacao, created_by, updated_by)
      VALUES ($1,$2::escopo_meta_enum,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
      RETURNING *`,
      [definicao.id, entrada.escopo, entrada.categoria_id ?? null,
        entrada.produto_id ?? null, entrada.fornecedor_id ?? null,
        entrada.local_id ?? null, entrada.comprador_id ?? null,
        entrada.meta, entrada.limite_atencao ?? null, entrada.limite_critico ?? null,
        entrada.observacao ?? null, contexto.usuarioId ?? null]);

    return { ...rows[0], kpi: definicao.codigo, avaliado_em: hojeLocal() };
  });
}

export async function listarMetas(codigo?: string) {
  const valores: unknown[] = [];
  const cond = ['m.ativo'];
  if (codigo) {
    valores.push(codigo);
    cond.push(`upper(k.codigo) = upper($${valores.length})`);
  }

  const { rows } = await query(`
    SELECT m.*, k.codigo, k.nome AS kpi, k.unidade, k.direcao,
           c.nome AS categoria, p.descricao AS produto, f.razao_social AS fornecedor,
           l.nome AS local, u.nome AS comprador
      FROM kpi_metas m
      JOIN kpi_definicoes k ON k.id = m.kpi_id
      LEFT JOIN categorias c ON c.id = m.categoria_id
      LEFT JOIN produtos p ON p.id = m.produto_id
      LEFT JOIN fornecedores f ON f.id = m.fornecedor_id
      LEFT JOIN locais l ON l.id = m.local_id
      LEFT JOIN usuarios u ON u.id = m.comprador_id
     WHERE ${cond.join(' AND ')}
     ORDER BY k.codigo, m.vigencia_inicio DESC`, valores);

  return rows.map((m: Record<string, any>) => ({
    ...m,
    vigencia_inicio: String(m.vigencia_inicio).slice(0, 10),
    vigencia_fim: m.vigencia_fim ? String(m.vigencia_fim).slice(0, 10) : null,
    vigente: m.vigencia_fim === null,
  }));
}
