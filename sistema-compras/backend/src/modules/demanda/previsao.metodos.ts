/**
 * Metodos de previsao e metricas de erro.
 *
 * Este arquivo e deliberadamente puro: nao conhece banco, request nem usuario.
 * Toda a matematica da previsao mora aqui para poder ser conferida isoladamente,
 * que e o que a secao 67 do prompt 04 exige ("nunca apresentar apenas um numero").
 */

export type MetodoPrevisao =
  | 'MEDIA_SIMPLES'
  | 'MEDIA_MOVEL'
  | 'MEDIA_PONDERADA'
  | 'SUAVIZACAO_EXPONENCIAL'
  | 'TENDENCIA'
  | 'SAZONALIDADE'
  | 'COMBINADO';

export type Tendencia = 'CRESCIMENTO' | 'ESTAVEL' | 'QUEDA' | 'INDETERMINADA';
export type Metrica = 'MAE' | 'MAPE' | 'RMSE';

export interface Erros {
  mae: number;
  mape: number | null;
  rmse: number;
  amostras: number;
}

const media = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

export function desvioPadrao(v: number[]): number {
  if (v.length < 2) return 0;
  const m = media(v);
  return Math.sqrt(v.reduce((acc, x) => acc + (x - m) ** 2, 0) / (v.length - 1));
}

/** Coeficiente de variacao. Base da curva XYZ e da confiabilidade. */
export function coeficienteVariacao(v: number[]): number | null {
  const m = media(v);
  if (m === 0) return null;
  return desvioPadrao(v) / Math.abs(m);
}

// ---------------------------------------------------------------------------
// Metodos
// ---------------------------------------------------------------------------

export const mediaSimples = (serie: number[]): number => media(serie);

export function mediaMovel(serie: number[], janela: number): number {
  if (!serie.length) return 0;
  const n = Math.min(Math.max(1, janela), serie.length);
  return media(serie.slice(-n));
}

/**
 * Pesos vem do mais recente para o mais antigo e sao normalizados.
 * Se houver menos historico que pesos, usa os pesos que couberem.
 */
export function mediaPonderada(serie: number[], pesos: number[]): number {
  if (!serie.length || !pesos.length) return 0;
  const n = Math.min(serie.length, pesos.length);
  const recentes = serie.slice(-n).reverse(); // [mais recente, ...]
  const usados = pesos.slice(0, n);
  const soma = usados.reduce((a, b) => a + b, 0);
  if (soma === 0) return media(recentes);
  return recentes.reduce((acc, valor, i) => acc + valor * (usados[i]! / soma), 0);
}

export function suavizacaoExponencial(serie: number[], alpha: number): number {
  if (!serie.length) return 0;
  const a = Math.min(0.99, Math.max(0.01, alpha));
  let nivel = serie[0]!;
  for (let i = 1; i < serie.length; i += 1) nivel = a * serie[i]! + (1 - a) * nivel;
  return nivel;
}

export interface Regressao {
  intercepto: number;
  inclinacao: number;
  r2: number;
}

/** Minimos quadrados sobre o indice do periodo. */
export function regressaoLinear(serie: number[]): Regressao {
  const n = serie.length;
  if (n < 2) return { intercepto: serie[0] ?? 0, inclinacao: 0, r2: 0 };

  const xs = serie.map((_, i) => i);
  const mx = media(xs);
  const my = media(serie);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i]! - mx) * (serie[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  const inclinacao = den === 0 ? 0 : num / den;
  const intercepto = my - inclinacao * mx;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const prev = intercepto + inclinacao * xs[i]!;
    ssRes += (serie[i]! - prev) ** 2;
    ssTot += (serie[i]! - my) ** 2;
  }
  return { intercepto, inclinacao, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
}

export function porTendencia(serie: number[], passosAdiante = 1): number {
  const { intercepto, inclinacao } = regressaoLinear(serie);
  return Math.max(0, intercepto + inclinacao * (serie.length - 1 + passosAdiante));
}

/**
 * Sazonalidade: nivel medio dessazonalizado x indice do periodo alvo.
 * `indices` e indexado por mes 1..12.
 */
export function porSazonalidade(
  serie: number[],
  indices: Map<number, number>,
  mesesDaSerie: number[],
  mesAlvo: number,
): number {
  if (!serie.length) return 0;
  const dessazonalizada = serie.map((valor, i) => {
    const indice = indices.get(mesesDaSerie[i] ?? 0) ?? 1;
    return indice > 0 ? valor / indice : valor;
  });
  const nivel = media(dessazonalizada);
  return Math.max(0, nivel * (indices.get(mesAlvo) ?? 1));
}

// ---------------------------------------------------------------------------
// Metricas de erro
// ---------------------------------------------------------------------------

/**
 * MAPE ignora periodos com realizado zero: dividir por zero produziria
 * infinito e um produto sem venda no mes nao deve invalidar a metrica.
 * Quando TODOS os periodos sao zero, o MAPE volta null em vez de mentir.
 */
export function calcularErros(realizados: number[], previstos: number[]): Erros {
  const n = Math.min(realizados.length, previstos.length);
  if (n === 0) return { mae: 0, mape: null, rmse: 0, amostras: 0 };

  let somaAbs = 0;
  let somaQuad = 0;
  let somaPerc = 0;
  let comPerc = 0;

  for (let i = 0; i < n; i += 1) {
    const real = realizados[i]!;
    const prev = previstos[i]!;
    const erro = prev - real;
    somaAbs += Math.abs(erro);
    somaQuad += erro ** 2;
    if (real !== 0) {
      somaPerc += Math.abs(erro / real);
      comPerc += 1;
    }
  }

  return {
    mae: somaAbs / n,
    mape: comPerc > 0 ? (somaPerc / comPerc) * 100 : null,
    rmse: Math.sqrt(somaQuad / n),
    amostras: n,
  };
}

// ---------------------------------------------------------------------------
// Backtest
// ---------------------------------------------------------------------------

export interface ParametrosPrevisao {
  janelaMediaMovel: number;
  pesos: number[];
  alpha: number;
  alphaAutomatico: boolean;
  metrica: Metrica;
}

export interface ResultadoMetodo {
  metodo: MetodoPrevisao;
  previsao: number;
  erros: Erros;
  parametros: Record<string, unknown>;
}

const ALPHAS_TESTADOS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

function preverCom(
  metodo: MetodoPrevisao,
  treino: number[],
  p: ParametrosPrevisao,
  indices: Map<number, number>,
  mesesTreino: number[],
  mesAlvo: number,
): number {
  switch (metodo) {
    case 'MEDIA_SIMPLES': return mediaSimples(treino);
    case 'MEDIA_MOVEL': return mediaMovel(treino, p.janelaMediaMovel);
    case 'MEDIA_PONDERADA': return mediaPonderada(treino, p.pesos);
    case 'SUAVIZACAO_EXPONENCIAL': return suavizacaoExponencial(treino, p.alpha);
    case 'TENDENCIA': return porTendencia(treino);
    case 'SAZONALIDADE': return porSazonalidade(treino, indices, mesesTreino, mesAlvo);
    default: return mediaSimples(treino);
  }
}

/**
 * Backtest com origem deslizante: para cada periodo do conjunto de teste,
 * treina com tudo que veio antes dele e compara a previsao com o realizado.
 * E o mais proximo do uso real (prever o proximo mes, mes apos mes).
 */
export function backtest(
  serie: number[],
  meses: number[],
  indices: Map<number, number>,
  p: ParametrosPrevisao,
  periodosTeste: number,
): ResultadoMetodo[] {
  const metodos: MetodoPrevisao[] = [
    'MEDIA_SIMPLES', 'MEDIA_MOVEL', 'MEDIA_PONDERADA',
    'SUAVIZACAO_EXPONENCIAL', 'TENDENCIA',
  ];
  if (indices.size === 12) metodos.push('SAZONALIDADE');

  const teste = Math.max(1, Math.min(periodosTeste, serie.length - 2));
  const inicioTeste = serie.length - teste;

  const resultados: ResultadoMetodo[] = [];

  for (const metodo of metodos) {
    // Para a suavizacao, o alpha tambem e escolhido por backtest quando pedido.
    const alphas = metodo === 'SUAVIZACAO_EXPONENCIAL' && p.alphaAutomatico
      ? ALPHAS_TESTADOS
      : [p.alpha];

    let melhor: ResultadoMetodo | null = null;

    for (const alpha of alphas) {
      const params = { ...p, alpha };
      const reais: number[] = [];
      const previstos: number[] = [];

      for (let i = inicioTeste; i < serie.length; i += 1) {
        const treino = serie.slice(0, i);
        if (treino.length < 2) continue;
        reais.push(serie[i]!);
        previstos.push(
          preverCom(metodo, treino, params, indices, meses.slice(0, i), meses[i] ?? 1),
        );
      }

      const erros = calcularErros(reais, previstos);
      const candidato: ResultadoMetodo = {
        metodo,
        previsao: 0,
        erros,
        parametros: metodo === 'SUAVIZACAO_EXPONENCIAL'
          ? { alpha }
          : metodo === 'MEDIA_MOVEL'
            ? { janela: params.janelaMediaMovel }
            : metodo === 'MEDIA_PONDERADA'
              ? { pesos: params.pesos }
              : {},
      };

      if (!melhor || compararErro(candidato.erros, melhor.erros, p.metrica) < 0) melhor = candidato;
    }

    if (melhor) resultados.push(melhor);
  }

  return resultados;
}

/** Negativo quando `a` e melhor que `b`. MAPE ausente perde para MAPE presente. */
export function compararErro(a: Erros, b: Erros, metrica: Metrica): number {
  if (metrica === 'MAPE') {
    if (a.mape === null && b.mape === null) return a.rmse - b.rmse;
    if (a.mape === null) return 1;
    if (b.mape === null) return -1;
    return a.mape - b.mape;
  }
  return metrica === 'MAE' ? a.mae - b.mae : a.rmse - b.rmse;
}

export function classificarTendencia(serie: number[], limitePercentual = 5): Tendencia {
  if (serie.length < 3) return 'INDETERMINADA';
  const { inclinacao, r2 } = regressaoLinear(serie);
  const m = media(serie);
  if (m === 0) return 'INDETERMINADA';

  // Variacao percentual por periodo. Exige um minimo de aderencia (r2) para
  // nao chamar de "tendencia" o que e so ruido.
  const variacaoPorPeriodo = (inclinacao / m) * 100;
  if (r2 < 0.3 || Math.abs(variacaoPorPeriodo) < limitePercentual) return 'ESTAVEL';
  return variacaoPorPeriodo > 0 ? 'CRESCIMENTO' : 'QUEDA';
}

export type Confiabilidade = 'ALTA' | 'MEDIA' | 'BAIXA' | 'INSUFICIENTE';

/**
 * Formula da confiabilidade (secao 69 do prompt 04), documentada porque o
 * comprador precisa saber por que o sistema confia mais em um numero que em outro.
 *
 *   pontos = historico (0-40) + erro (0-40) + estabilidade (0-20)
 *
 *   >= 75  ALTA | >= 50 MEDIA | >= 25 BAIXA | abaixo disso INSUFICIENTE
 */
export function classificarConfiabilidade(
  mesesHistorico: number,
  mape: number | null,
  cv: number | null,
): { nivel: Confiabilidade; pontos: number } {
  if (mesesHistorico < 3) return { nivel: 'INSUFICIENTE', pontos: 0 };

  const pHistorico = Math.min(40, (mesesHistorico / 24) * 40);
  const pErro = mape === null ? 10 : Math.max(0, 40 - Math.min(40, (mape / 50) * 40));
  const pEstabilidade = cv === null ? 5 : Math.max(0, 20 - Math.min(20, cv * 20));
  const pontos = Math.round(pHistorico + pErro + pEstabilidade);

  const nivel: Confiabilidade =
    pontos >= 75 ? 'ALTA' : pontos >= 50 ? 'MEDIA' : pontos >= 25 ? 'BAIXA' : 'INSUFICIENTE';
  return { nivel, pontos };
}

/**
 * Intervalo a partir do desvio dos residuos do backtest.
 * Sem residuos suficientes nao ha intervalo: melhor nenhum numero que um falso.
 */
export function intervalo(previsao: number, residuos: number[]): { inferior: number; superior: number } | null {
  if (residuos.length < 3) return null;
  const s = desvioPadrao(residuos);
  if (s === 0) return null;
  const margem = 1.96 * s;
  return { inferior: Math.max(0, previsao - margem), superior: previsao + margem };
}
