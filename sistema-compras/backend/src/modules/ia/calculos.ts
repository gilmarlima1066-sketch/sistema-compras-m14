/**
 * Matematica da camada de inteligencia (secoes 8, 18, 28, 31, 32 e 33).
 *
 * Modulo puro: nao conhece banco nem request. Isso permite verificar a conta
 * sem subir nada - e, neste modulo em particular, a conta E o produto. Uma IA
 * que recomenda comprar 900 kg precisa que os 900 kg estejam certos antes de
 * precisar que a frase esteja bonita.
 *
 * O que NAO esta aqui, de proposito:
 *   - previsao de demanda -> modulo 04 (`previsao.metodos.ts`), que ja tem
 *     media movel, suavizacao, tendencia, sazonalidade, backtest e MAPE;
 *   - custo de aquisicao e pontuacao de proposta -> modulo 06 (`pontuacao.ts`);
 *   - necessidade de compra -> modulo 05, que roda o SQL oficial;
 *   - qualquer indicador (OTIF, giro, cobertura) -> modulo 11.
 *
 * Reimplementar qualquer um deles criaria um segundo numero oficial para a
 * mesma coisa, que e o problema que o modulo 11 passou inteiro resolvendo.
 */

export type Nivel = 'BAIXO' | 'MODERADO' | 'ALTO' | 'CRITICO';
export type Faixa = 'BAIXA' | 'MEDIA' | 'ALTA';

const arred = (v: number, casas = 2) => {
  const f = 10 ** casas;
  return Math.round(v * f) / f;
};

export const media = (v: number[]): number =>
  (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

export function desvioPadrao(v: number[]): number {
  if (v.length < 2) return 0;
  const m = media(v);
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
}

/** Mediana: resiste a outlier, ao contrario da media. */
export function mediana(v: number[]): number {
  if (!v.length) return 0;
  const o = [...v].sort((a, b) => a - b);
  const meio = Math.floor(o.length / 2);
  return o.length % 2 ? o[meio]! : (o[meio - 1]! + o[meio]!) / 2;
}

// ---------------------------------------------------------------------------
// Anomalias (secao 8)
// ---------------------------------------------------------------------------

export interface Anomalia {
  anomala: boolean;
  valorAtual: number;
  valorEsperado: number;
  diferenca: number;
  diferencaPercentual: number | null;
  zScore: number | null;
  direcao: 'ACIMA' | 'ABAIXO' | 'NORMAL';
  /** Por que nao deu para avaliar, quando for o caso. */
  motivo?: string;
}

/**
 * Compara um valor com o comportamento historico da propria serie.
 *
 * Usa z-score sobre media e desvio padrao. Duas salvaguardas importam:
 *
 * 1. Com menos observacoes que o minimo, devolve `anomala: false` com motivo.
 *    Chamar de anomalia o terceiro ponto de uma serie de tres e ruido, nao
 *    deteccao.
 *
 * 2. Desvio padrao zero (serie constante) nao vira divisao por zero nem
 *    z-score infinito: qualquer valor diferente e anomalo, e o z-score volta
 *    nulo porque nao existe escala para medi-lo.
 */
export function detectarAnomalia(
  valorAtual: number,
  historico: number[],
  limiteZ = 2.5,
  minimoEventos = 5,
): Anomalia {
  const esperado = media(historico);
  const base: Anomalia = {
    anomala: false,
    valorAtual: arred(valorAtual, 4),
    valorEsperado: arred(esperado, 4),
    diferenca: arred(valorAtual - esperado, 4),
    diferencaPercentual: esperado === 0 ? null : arred(((valorAtual - esperado) / esperado) * 100),
    zScore: null,
    direcao: 'NORMAL',
  };

  if (historico.length < minimoEventos) {
    return {
      ...base,
      motivo: `Historico de ${historico.length} observacao(oes); o minimo para `
        + `avaliar desvio e ${minimoEventos}`,
    };
  }

  const dp = desvioPadrao(historico);
  if (dp === 0) {
    const difere = valorAtual !== esperado;
    return {
      ...base,
      anomala: difere,
      direcao: difere ? (valorAtual > esperado ? 'ACIMA' : 'ABAIXO') : 'NORMAL',
      motivo: difere
        ? 'Serie historica constante: qualquer variacao foge do padrao observado'
        : undefined,
    };
  }

  const z = (valorAtual - esperado) / dp;
  return {
    ...base,
    zScore: arred(z, 3),
    anomala: Math.abs(z) >= limiteZ,
    direcao: Math.abs(z) < limiteZ ? 'NORMAL' : (z > 0 ? 'ACIMA' : 'ABAIXO'),
  };
}

// ---------------------------------------------------------------------------
// Risco (secoes 17 e 18)
// ---------------------------------------------------------------------------

export interface FatorRisco {
  codigo: string;
  descricao: string;
  dimensao: 'PROBABILIDADE' | 'IMPACTO';
  peso: number;
}

export interface Risco {
  probabilidade: number;
  impacto: number;
  faixaProbabilidade: Faixa;
  faixaImpacto: Faixa;
  nivel: Nivel;
  fatores: FatorRisco[];
  formula: string;
}

const faixa = (v: number): Faixa => (v >= 67 ? 'ALTA' : v >= 34 ? 'MEDIA' : 'BAIXA');

/** Matriz probabilidade x impacto (secao 18). */
const MATRIZ: Record<Faixa, Record<Faixa, Nivel>> = {
  ALTA:  { ALTA: 'CRITICO',  MEDIA: 'ALTO',     BAIXA: 'MODERADO' },
  MEDIA: { ALTA: 'ALTO',     MEDIA: 'MODERADO', BAIXA: 'BAIXO' },
  BAIXA: { ALTA: 'MODERADO', MEDIA: 'BAIXO',    BAIXA: 'BAIXO' },
};

/**
 * Classifica o risco somando pesos de fatores observados.
 *
 * "Nao criar um score oculto" (secao 18) e o requisito que desenha a
 * assinatura: a funcao devolve os fatores junto do nivel, sempre. Quem le
 * confere de onde saiu, em vez de receber um numero para acreditar.
 */
export function classificarRisco(fatores: FatorRisco[]): Risco {
  const somar = (d: FatorRisco['dimensao']) => Math.min(100, fatores
    .filter((f) => f.dimensao === d)
    .reduce((a, f) => a + f.peso, 0));

  const probabilidade = somar('PROBABILIDADE');
  const impacto = somar('IMPACTO');
  const fp = faixa(probabilidade);
  const fi = faixa(impacto);

  return {
    probabilidade,
    impacto,
    faixaProbabilidade: fp,
    faixaImpacto: fi,
    nivel: MATRIZ[fp][fi],
    fatores,
    formula: 'probabilidade e impacto somam os pesos dos fatores observados, '
      + 'limitados a 100; o nivel vem da matriz probabilidade x impacto',
  };
}

// ---------------------------------------------------------------------------
// Projecao de ruptura (secoes 6 e 19)
// ---------------------------------------------------------------------------

export interface ProjecaoRuptura {
  diasAteRuptura: number | null;
  dataProvavel: string | null;
  jaEmRuptura: boolean;
  cobertoPorPedido: boolean;
  motivo?: string;
}

/**
 * Em quantos dias o saldo acaba, no ritmo de consumo atual.
 *
 * Tres casos que nao podem virar um numero:
 *
 *   - demanda zero: o estoque nao acaba sozinho. Devolve nulo com motivo, e
 *     NAO "infinitos dias", que numa tela vira um numero gigante e sem sentido.
 *   - saldo zero ou negativo com demanda: ja esta em ruptura hoje, nao "em 0
 *     dias no futuro".
 *   - chegada prevista antes do fim do saldo: a ruptura projetada nao se
 *     concretiza, e dizer que se concretiza levaria a uma compra duplicada.
 */
export function projetarRuptura(
  disponivel: number,
  demandaDiaria: number,
  hoje: string,
  chegadaPrevistaDias?: number | null,
): ProjecaoRuptura {
  if (demandaDiaria <= 0) {
    return {
      diasAteRuptura: null,
      dataProvavel: null,
      jaEmRuptura: false,
      cobertoPorPedido: false,
      motivo: 'Produto sem demanda apurada: o saldo nao se esgota por consumo',
    };
  }

  if (disponivel <= 0) {
    return {
      diasAteRuptura: 0,
      dataProvavel: hoje,
      jaEmRuptura: true,
      cobertoPorPedido: chegadaPrevistaDias !== null && chegadaPrevistaDias !== undefined,
    };
  }

  const dias = Math.floor(disponivel / demandaDiaria);
  const coberto = chegadaPrevistaDias !== null && chegadaPrevistaDias !== undefined
    && chegadaPrevistaDias <= dias;

  return {
    diasAteRuptura: dias,
    dataProvavel: somarDias(hoje, dias),
    jaEmRuptura: false,
    cobertoPorPedido: coberto,
    motivo: coberto
      ? `Reposicao prevista em ${chegadaPrevistaDias} dia(s), antes do saldo acabar`
      : undefined,
  };
}

export function somarDias(data: string, dias: number): string {
  const base = Date.parse(`${data}T00:00:00Z`);
  return new Date(base + dias * 86400000).toISOString().slice(0, 10);
}

export function diferencaDias(de: string, ate: string): number {
  return Math.round(
    (Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86400000);
}

// ---------------------------------------------------------------------------
// Preco (secao 33)
// ---------------------------------------------------------------------------

export interface AnalisePreco {
  atual: number;
  anterior: number | null;
  minimo: number;
  maximo: number;
  medio: number;
  medianaHistorica: number;
  variacaoAnterior: number | null;
  variacaoMedia: number | null;
  posicao: 'ABAIXO_DA_MEDIA' | 'NA_MEDIA' | 'ACIMA_DA_MEDIA';
  anormal: boolean;
  observacoes: number;
  motivo?: string;
}

/**
 * Situa o preco atual dentro do proprio historico.
 *
 * Compara com a MEDIANA, nao com a media: uma unica compra emergencial cara
 * puxa a media e faz o preco normal seguinte parecer barato. A mediana ignora
 * o episodio.
 */
export function analisarPreco(
  atual: number,
  historico: number[],
  variacaoAnormalPercentual = 15,
  minimoEventos = 3,
): AnalisePreco {
  const serie = historico.filter((v) => v > 0);
  const anterior = serie.length ? serie[serie.length - 1]! : null;
  const med = serie.length ? mediana(serie) : atual;

  const base: AnalisePreco = {
    atual: arred(atual),
    anterior: anterior === null ? null : arred(anterior),
    minimo: serie.length ? arred(Math.min(...serie)) : arred(atual),
    maximo: serie.length ? arred(Math.max(...serie)) : arred(atual),
    medio: serie.length ? arred(media(serie)) : arred(atual),
    medianaHistorica: arred(med),
    variacaoAnterior: anterior && anterior > 0
      ? arred(((atual - anterior) / anterior) * 100) : null,
    variacaoMedia: med > 0 ? arred(((atual - med) / med) * 100) : null,
    posicao: 'NA_MEDIA',
    anormal: false,
    observacoes: serie.length,
  };

  if (serie.length < minimoEventos) {
    return {
      ...base,
      motivo: `Historico de ${serie.length} preco(s); o minimo para comparar e `
        + `${minimoEventos}`,
    };
  }

  const variacao = base.variacaoMedia ?? 0;
  return {
    ...base,
    posicao: variacao > 5 ? 'ACIMA_DA_MEDIA' : variacao < -5 ? 'ABAIXO_DA_MEDIA' : 'NA_MEDIA',
    anormal: Math.abs(variacao) >= variacaoAnormalPercentual,
  };
}

// ---------------------------------------------------------------------------
// Priorizacao (secao 31)
// ---------------------------------------------------------------------------

export interface FatoresPrioridade {
  impactoFinanceiro: number;
  /** Maior impacto financeiro do lote, para normalizar. */
  maiorImpacto: number;
  /** Dias ate a acao perder efeito. Menos dias, mais urgente. */
  urgenciaDias: number | null;
  horizonteDias: number;
  classeAbc?: string | null;
  temAlternativa?: boolean;
}

export interface Pesos {
  impacto: number;
  urgencia: number;
  criticidade: number;
}

export interface Prioridade {
  score: number;
  prioridade: 'CRITICO' | 'ALTO' | 'MEDIO' | 'BAIXO';
  componentes: { impacto: number; urgencia: number; criticidade: number };
}

/**
 * Ordena acoes por impacto, urgencia e criticidade (secao 31).
 *
 * A normalizacao do impacto e feita contra o MAIOR impacto do proprio lote,
 * nao contra uma escala fixa: R$ 50.000 e enorme numa lista onde o segundo
 * maior e R$ 2.000, e modesto numa onde ha varios de R$ 300.000. Escala fixa
 * classificaria os dois casos igual.
 *
 * Sem alternativa de fornecedor a criticidade sobe: o mesmo problema custa
 * mais caro quando nao ha para onde correr.
 */
export function calcularPrioridade(f: FatoresPrioridade, pesos: Pesos): Prioridade {
  const impacto = f.maiorImpacto > 0
    ? Math.min(100, (f.impactoFinanceiro / f.maiorImpacto) * 100)
    : 0;

  const urgencia = f.urgenciaDias === null
    ? 30 // sem prazo conhecido: nem urgente nem descartavel
    : Math.max(0, Math.min(100,
      ((f.horizonteDias - f.urgenciaDias) / Math.max(f.horizonteDias, 1)) * 100));

  let criticidade = f.classeAbc === 'A' ? 100 : f.classeAbc === 'B' ? 60 : f.classeAbc === 'C' ? 30 : 45;
  if (f.temAlternativa === false) criticidade = Math.min(100, criticidade + 25);

  const soma = pesos.impacto + pesos.urgencia + pesos.criticidade || 1;
  const score = (impacto * pesos.impacto + urgencia * pesos.urgencia
    + criticidade * pesos.criticidade) / soma;

  return {
    score: arred(score, 4),
    prioridade: score >= 75 ? 'CRITICO' : score >= 55 ? 'ALTO' : score >= 30 ? 'MEDIO' : 'BAIXO',
    componentes: {
      impacto: arred(impacto, 2),
      urgencia: arred(urgencia, 2),
      criticidade: arred(criticidade, 2),
    },
  };
}

// ---------------------------------------------------------------------------
// Economia (secao 32)
// ---------------------------------------------------------------------------

export interface Economia {
  situacaoAtual: number;
  situacaoPotencial: number;
  economia: number;
  economiaPercentual: number | null;
  premissas: string[];
  calculo: string;
}

/**
 * Estimativa de economia com a conta e as premissas juntas.
 *
 * Economia negativa continua sendo devolvida, nao zerada: se a "oportunidade"
 * na verdade custa mais caro, esconder o sinal transformaria a analise em
 * propaganda da propria sugestao.
 */
export function estimarEconomia(
  situacaoAtual: number,
  situacaoPotencial: number,
  premissas: string[],
  calculo: string,
): Economia {
  const economia = situacaoAtual - situacaoPotencial;
  return {
    situacaoAtual: arred(situacaoAtual),
    situacaoPotencial: arred(situacaoPotencial),
    economia: arred(economia),
    economiaPercentual: situacaoAtual > 0 ? arred((economia / situacaoAtual) * 100) : null,
    premissas,
    calculo,
  };
}

// ---------------------------------------------------------------------------
// Concentracao (secao 14)
// ---------------------------------------------------------------------------

export interface Concentracao {
  /** Indice de Herfindahl-Hirschman normalizado, 0 a 1. */
  hhi: number;
  maiorParticipacao: number;
  fornecedores: number;
  nivel: Nivel;
  interpretacao: string;
}

/**
 * Mede dependencia de fornecimento pelo HHI (secao 14).
 *
 * O HHI e a soma dos quadrados das participacoes: ele pune concentracao muito
 * mais do que uma simples "maior participacao" faria. Dez fornecedores com 10%
 * cada dao 0,10; um com 91% e nove com 1% dao 0,83 - e a diferenca de risco
 * entre os dois casos e exatamente essa.
 *
 * Fornecedor unico e tratado a parte: HHI 1,0 nao e "muito concentrado", e
 * ausencia de alternativa, que e outra categoria de problema.
 */
export function medirConcentracao(participacoes: number[]): Concentracao {
  const validas = participacoes.filter((p) => p > 0);
  if (!validas.length) {
    return {
      hhi: 0, maiorParticipacao: 0, fornecedores: 0, nivel: 'BAIXO',
      interpretacao: 'Sem compras no periodo para medir concentracao',
    };
  }

  const total = validas.reduce((a, b) => a + b, 0);
  const fracoes = validas.map((p) => p / total);
  const hhi = fracoes.reduce((a, f) => a + f * f, 0);
  const maior = Math.max(...fracoes) * 100;

  const nivel: Nivel = validas.length === 1 ? 'CRITICO'
    : hhi >= 0.5 ? 'ALTO'
      : hhi >= 0.25 ? 'MODERADO' : 'BAIXO';

  return {
    hhi: arred(hhi, 4),
    maiorParticipacao: arred(maior),
    fornecedores: validas.length,
    nivel,
    interpretacao: validas.length === 1
      ? 'Fornecedor unico: sem alternativa em caso de falha'
      : `${validas.length} fornecedores, maior com ${arred(maior, 1)}% do volume`,
  };
}

// ---------------------------------------------------------------------------
// Simulacao financeira (secoes 28 e 34)
// ---------------------------------------------------------------------------

export interface ImpactoFinanceiro {
  valorBase: number;
  valorSimulado: number;
  diferenca: number;
  diferencaPercentual: number | null;
  fatores: Array<{ fator: string; de: number; para: number; efeito: number }>;
}

/**
 * Aplica variacao de preco e de cambio sobre um valor de compra (secoes 28 e 34).
 *
 * Os dois fatores sao multiplicativos e a funcao mostra o efeito de cada um
 * separadamente. Importa: 10% de alta no preco somada a 10% de alta no cambio
 * nao da 20%, da 21%. Somar os percentuais seria o erro obvio, e num orcamento
 * de importacao ele aparece como uma diferenca real de caixa.
 */
export function simularImpactoFinanceiro(
  valorBase: number,
  variacaoPrecoPercentual = 0,
  variacaoCambioPercentual = 0,
): ImpactoFinanceiro {
  const fatorPreco = 1 + variacaoPrecoPercentual / 100;
  const fatorCambio = 1 + variacaoCambioPercentual / 100;

  const aposPreco = valorBase * fatorPreco;
  const aposCambio = aposPreco * fatorCambio;

  return {
    valorBase: arred(valorBase),
    valorSimulado: arred(aposCambio),
    diferenca: arred(aposCambio - valorBase),
    diferencaPercentual: valorBase > 0
      ? arred(((aposCambio - valorBase) / valorBase) * 100) : null,
    fatores: [
      {
        fator: 'preco',
        de: arred(valorBase),
        para: arred(aposPreco),
        efeito: arred(aposPreco - valorBase),
      },
      {
        fator: 'cambio',
        de: arred(aposPreco),
        para: arred(aposCambio),
        efeito: arred(aposCambio - aposPreco),
      },
    ],
  };
}

/** Quantidade ajustada a MOQ e multiplo do fornecedor (secoes 10 e 28). */
export function ajustarQuantidade(
  sugerida: number, moq?: number | null, multiplo?: number | null,
): { quantidade: number; ajustes: string[] } {
  const ajustes: string[] = [];
  let q = Math.max(0, sugerida);

  if (moq && q > 0 && q < moq) {
    ajustes.push(`elevada ao pedido minimo de ${moq}`);
    q = moq;
  }
  if (multiplo && multiplo > 0 && q > 0) {
    const arredondada = Math.ceil(q / multiplo) * multiplo;
    if (arredondada !== q) {
      ajustes.push(`arredondada ao multiplo de ${multiplo}`);
      q = arredondada;
    }
  }
  return { quantidade: arred(q, 3), ajustes };
}
