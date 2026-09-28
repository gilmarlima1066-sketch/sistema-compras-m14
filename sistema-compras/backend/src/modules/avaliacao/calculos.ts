/**
 * Matematica da avaliacao de fornecedores.
 *
 * Sem banco e sem request: e onde a nota nasce, e precisa ser conferivel
 * isoladamente. Tres regras organizam este arquivo inteiro:
 *
 *   - dado que nao existe vira `null`, nunca zero (regra 2 da secao 67);
 *   - toda nota sai acompanhada da formula e dos eventos que a sustentam
 *     (secao 3);
 *   - criterio sem dado nao e "nota zero", e "nao calculavel" - a diferenca
 *     entre um fornecedor ruim e um fornecedor novo (secao 28).
 */

export type Direcao = 'MAIOR_MELHOR' | 'MENOR_MELHOR';

export type Grupo =
  | 'LOGISTICA' | 'QUALIDADE' | 'COMERCIAL' | 'ATENDIMENTO'
  | 'PRECO' | 'PAGAMENTO' | 'FLEXIBILIDADE';

export type Completude =
  | 'COMPLETA' | 'DADOS_PARCIAIS' | 'DADOS_INSUFICIENTES' | 'SEM_HISTORICO';

export type Confiabilidade = 'ALTA' | 'MEDIA' | 'BAIXA' | 'INSUFICIENTE';

const arredondar = (v: number, casas = 2) => {
  const f = 10 ** casas;
  return Math.round((v + Number.EPSILON) * f) / f;
};

// ---------------------------------------------------------------------------
// Normalizacao: numero cru vira nota de 0 a 100 (secao 26)
// ---------------------------------------------------------------------------

export interface FaixaIndicador {
  direcao: Direcao;
  /** Valor a partir do qual a nota e 0. */
  valorPior: number | null;
  /** Valor a partir do qual a nota e 100. */
  valorMelhor: number | null;
}

export interface NotaIndicador {
  nota: number | null;
  calculavel: boolean;
  motivo?: string;
  formula: string;
}

/**
 * Interpola linearmente entre o pior e o melhor valor da faixa.
 *
 * A faixa vive na metodologia, nao aqui: transformar 8% de nao conformidade
 * em nota e uma decisao de negocio, e decisao de negocio tem de ser visivel e
 * versionada. O codigo so aplica a regra que a metodologia declarou.
 */
export function normalizar(valor: number | null, faixa: FaixaIndicador): NotaIndicador {
  if (valor === null || !Number.isFinite(valor)) {
    return {
      nota: null, calculavel: false,
      motivo: 'Sem valor apurado no periodo',
      formula: 'sem dados',
    };
  }
  if (faixa.valorPior === null || faixa.valorMelhor === null
      || faixa.valorPior === faixa.valorMelhor) {
    return {
      nota: null, calculavel: false,
      motivo: 'Faixa de normalizacao nao configurada na metodologia',
      formula: 'faixa ausente',
    };
  }

  const { valorPior: pior, valorMelhor: melhor } = faixa;
  const proporcao = (valor - pior) / (melhor - pior);
  const nota = Math.min(100, Math.max(0, proporcao * 100));

  const sinal = faixa.direcao === 'MAIOR_MELHOR' ? '>=' : '<=';
  return {
    nota: arredondar(nota),
    calculavel: true,
    formula: `nota = (valor - ${pior}) / (${melhor} - ${pior}) x 100, limitada a [0, 100]`
      + ` (${sinal} ${melhor} vale 100)`,
  };
}

// ---------------------------------------------------------------------------
// Indicador apurado
// ---------------------------------------------------------------------------

export interface IndicadorApurado {
  codigo: string;
  nome: string;
  grupo: Grupo;
  valor: number | null;
  unidade: string | null;
  eventos: number;
  minimoEventos: number;
  formula: string;
  fonte: string;
}

export interface IndicadorAvaliado extends IndicadorApurado {
  nota: number | null;
  peso: number;
  direcao: Direcao;
  calculavel: boolean;
  motivo?: string;
  formulaNota: string;
}

export interface DefinicaoIndicador {
  codigo: string;
  nome: string;
  peso: number;
  direcao: Direcao;
  valorPior: number | null;
  valorMelhor: number | null;
  unidade: string | null;
  minimoEventos: number;
}

/**
 * Avalia um indicador contra a definicao da metodologia.
 *
 * O minimo de eventos vem antes da faixa: um fornecedor com uma unica entrega
 * pode ter OTIF de 100%, e esse 100% nao diz nada. Amostra insuficiente e
 * ausencia de dado, nao nota alta (secao 28).
 */
export function avaliarIndicador(
  apurado: IndicadorApurado, definicao: DefinicaoIndicador,
): IndicadorAvaliado {
  const base = {
    ...apurado,
    peso: definicao.peso,
    direcao: definicao.direcao,
    unidade: definicao.unidade ?? apurado.unidade,
    minimoEventos: definicao.minimoEventos,
  };

  if (apurado.eventos < definicao.minimoEventos) {
    return {
      ...base,
      nota: null,
      calculavel: false,
      motivo: `Amostra insuficiente: ${apurado.eventos} evento(s) contra o minimo de`
        + ` ${definicao.minimoEventos}`,
      formulaNota: 'nao calculada por amostra insuficiente',
    };
  }

  const { nota, calculavel, motivo, formula } = normalizar(apurado.valor, {
    direcao: definicao.direcao,
    valorPior: definicao.valorPior,
    valorMelhor: definicao.valorMelhor,
  });

  return { ...base, nota, calculavel, motivo, formulaNota: formula };
}

// ---------------------------------------------------------------------------
// Nota do criterio: media ponderada dos indicadores calculaveis
// ---------------------------------------------------------------------------

export interface CriterioAvaliado {
  grupo: Grupo;
  nome: string;
  nota: number | null;
  peso: number;
  contribuicao: number | null;
  calculavel: boolean;
  motivo?: string;
  eventos: number;
  minimoEventos: number;
  indicadores: IndicadorAvaliado[];
  formula: string;
}

/**
 * Nota do grupo a partir dos indicadores.
 *
 * Indicador nao calculavel **sai do denominador** em vez de entrar como zero.
 * Somar zero seria punir o fornecedor por uma lacuna de dados nossa - um
 * fornecedor sem inspecao registrada nao e um fornecedor de qualidade ruim.
 */
export function avaliarCriterio(dados: {
  grupo: Grupo;
  nome: string;
  peso: number;
  minimoEventos: number;
  indicadores: IndicadorAvaliado[];
}): CriterioAvaliado {
  const calculaveis = dados.indicadores.filter((i) => i.calculavel && i.nota !== null);
  const eventos = dados.indicadores.reduce((a, i) => Math.max(a, i.eventos), 0);

  if (!calculaveis.length) {
    const motivo = dados.indicadores.length
      ? 'Nenhum indicador do criterio pode ser calculado no periodo'
      : 'Criterio sem indicadores configurados na metodologia';
    return {
      grupo: dados.grupo, nome: dados.nome, nota: null, peso: dados.peso,
      contribuicao: null, calculavel: false, motivo, eventos,
      minimoEventos: dados.minimoEventos, indicadores: dados.indicadores,
      formula: 'nao calculado',
    };
  }

  const somaPesos = calculaveis.reduce((a, i) => a + i.peso, 0);
  if (somaPesos <= 0) {
    return {
      grupo: dados.grupo, nome: dados.nome, nota: null, peso: dados.peso,
      contribuicao: null, calculavel: false,
      motivo: 'Os indicadores calculaveis do criterio tem peso zero',
      eventos, minimoEventos: dados.minimoEventos, indicadores: dados.indicadores,
      formula: 'nao calculado',
    };
  }

  const nota = arredondar(
    calculaveis.reduce((a, i) => a + (i.nota as number) * i.peso, 0) / somaPesos);

  const ignorados = dados.indicadores.length - calculaveis.length;

  return {
    grupo: dados.grupo,
    nome: dados.nome,
    nota,
    peso: dados.peso,
    contribuicao: arredondar((nota * dados.peso) / 100, 4),
    calculavel: true,
    motivo: ignorados > 0
      ? `${ignorados} indicador(es) sem dados ficaram fora do calculo`
      : undefined,
    eventos,
    minimoEventos: dados.minimoEventos,
    indicadores: dados.indicadores,
    formula: `media ponderada de ${calculaveis.length} indicador(es),`
      + ` pesos somando ${arredondar(somaPesos)}%`,
  };
}

// ---------------------------------------------------------------------------
// Score final (secoes 26 e 27)
// ---------------------------------------------------------------------------

export interface LimiaresCompletude {
  /** Abaixo deste percentual de peso calculavel, a avaliacao e parcial. */
  parcialPercentual: number;
  /** Abaixo deste, e insuficiente. */
  insuficientePercentual: number;
}

export interface LimiaresConfiabilidade {
  altaEventos: number;
  mediaEventos: number;
}

export interface Score {
  score: number | null;
  /** Soma dos pesos dos criterios que puderam ser calculados. */
  pesoCalculado: number;
  pesoTotal: number;
  completude: Completude;
  confiabilidade: Confiabilidade;
  eventos: number;
  criteriosCalculados: number;
  criteriosTotais: number;
  criterios: CriterioAvaliado[];
  formula: string;
  motivo?: string;
}

/**
 * Score final: soma das contribuicoes, reescalada pelo peso que sobreviveu.
 *
 * Se apenas 80% do peso pode ser calculado, somar as contribuicoes daria no
 * maximo 80 - e o fornecedor pareceria pior do que e por falta de dado nosso.
 * Entao o resultado e reescalado para a base calculavel, e o percentual de
 * peso usado sai junto para quem le saber sobre o que aquele numero repousa.
 */
export function calcularScore(
  criterios: CriterioAvaliado[],
  limiares: LimiaresCompletude,
  confiabilidade: LimiaresConfiabilidade,
): Score {
  const pesoTotal = criterios.reduce((a, c) => a + c.peso, 0);
  const calculaveis = criterios.filter((c) => c.calculavel && c.nota !== null);
  const pesoCalculado = calculaveis.reduce((a, c) => a + c.peso, 0);
  const eventos = criterios.reduce((a, c) => a + c.eventos, 0);

  const proporcao = pesoTotal > 0 ? (pesoCalculado / pesoTotal) * 100 : 0;

  const grau = (n: number): Confiabilidade =>
    n >= confiabilidade.altaEventos ? 'ALTA'
      : n >= confiabilidade.mediaEventos ? 'MEDIA'
        : n > 0 ? 'BAIXA' : 'INSUFICIENTE';

  const semDados = {
    score: null,
    pesoCalculado,
    pesoTotal,
    eventos,
    criteriosCalculados: calculaveis.length,
    criteriosTotais: criterios.length,
    criterios,
  };

  if (!calculaveis.length || pesoCalculado <= 0) {
    return {
      ...semDados,
      completude: eventos > 0 ? 'DADOS_INSUFICIENTES' : 'SEM_HISTORICO',
      confiabilidade: 'INSUFICIENTE',
      formula: 'score nao calculado',
      motivo: eventos > 0
        ? 'Nenhum criterio atingiu o minimo de eventos configurado'
        : 'Fornecedor sem historico no periodo avaliado',
    };
  }

  if (proporcao < limiares.insuficientePercentual) {
    return {
      ...semDados,
      completude: 'DADOS_INSUFICIENTES',
      confiabilidade: 'INSUFICIENTE',
      formula: 'score nao calculado',
      motivo: `Apenas ${arredondar(proporcao)}% do peso da metodologia pode ser calculado,`
        + ` abaixo do minimo de ${limiares.insuficientePercentual}%`,
    };
  }

  const soma = calculaveis.reduce((a, c) => a + (c.contribuicao as number), 0);
  const score = arredondar((soma / pesoCalculado) * 100);

  const completude: Completude = proporcao >= 100 ? 'COMPLETA'
    : proporcao < limiares.parcialPercentual ? 'DADOS_INSUFICIENTES' : 'DADOS_PARCIAIS';

  return {
    ...semDados,
    score,
    completude,
    confiabilidade: completude === 'DADOS_INSUFICIENTES' ? 'BAIXA' : grau(eventos),
    formula: pesoCalculado === pesoTotal
      ? 'score = soma das contribuicoes (nota x peso / 100)'
      : `score = soma das contribuicoes / ${arredondar(pesoCalculado)}% x 100`
        + ' (reescalado para o peso calculavel)',
    motivo: pesoCalculado === pesoTotal ? undefined
      : `${arredondar(proporcao)}% do peso da metodologia foi calculado`,
  };
}

// ---------------------------------------------------------------------------
// Indicadores brutos (secoes 13 a 23)
// ---------------------------------------------------------------------------

/** Proporcao em percentual. Denominador zero devolve null, nunca 0. */
export const percentual = (parte: number, total: number): number | null =>
  total > 0 ? arredondar((parte / total) * 100) : null;

export interface Estatistica {
  media: number | null;
  mediana: number | null;
  minimo: number | null;
  maximo: number | null;
  desvio: number | null;
  amostra: number;
}

export function estatisticas(valores: number[]): Estatistica {
  const validos = valores.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = validos.length;
  if (!n) {
    return { media: null, mediana: null, minimo: null, maximo: null, desvio: null, amostra: 0 };
  }
  const media = validos.reduce((a, v) => a + v, 0) / n;
  const meio = Math.floor(n / 2);
  const mediana = n % 2 ? validos[meio] : (validos[meio - 1] + validos[meio]) / 2;
  const variancia = validos.reduce((a, v) => a + (v - media) ** 2, 0) / n;
  return {
    media: arredondar(media),
    mediana: arredondar(mediana),
    minimo: arredondar(validos[0]),
    maximo: arredondar(validos[n - 1]),
    desvio: arredondar(Math.sqrt(variancia)),
    amostra: n,
  };
}

/**
 * Variacao percentual entre dois precos (secao 21).
 *
 * Preco anterior zero ou ausente **nao gera percentual**: dividir por zero
 * daria infinito, e "aumentou infinito por cento" nao e informacao.
 */
export function variacaoPreco(
  precoAtual: number | null, precoAnterior: number | null,
): { variacao: number | null; motivo?: string; formula: string } {
  const formula = 'variacao = (preco atual - preco anterior) / preco anterior x 100';
  if (precoAtual === null || precoAnterior === null) {
    return { variacao: null, motivo: 'Falta preco atual ou anterior', formula };
  }
  if (precoAnterior === 0) {
    return { variacao: null, motivo: 'Preco anterior zero: percentual nao calculavel', formula };
  }
  return { variacao: arredondar(((precoAtual - precoAnterior) / precoAnterior) * 100, 4), formula };
}

/**
 * Posicao do preco do fornecedor diante do menor preco elegivel do produto
 * (secao 22).
 *
 * Devolve quanto por cento acima do menor preco o fornecedor esta. Zero
 * significa que ele **e** o menor preco - o que nao quer dizer que seja a
 * melhor decisao, e por isso o numero sai cru, para analise.
 */
export function posicaoCompetitiva(
  precoFornecedor: number | null, menorPreco: number | null,
): { posicao: number | null; motivo?: string; formula: string } {
  const formula = 'posicao = (preco do fornecedor - menor preco) / menor preco x 100';
  if (precoFornecedor === null || menorPreco === null) {
    return { posicao: null, motivo: 'Sem preco comparavel para o produto', formula };
  }
  if (menorPreco <= 0) {
    return { posicao: null, motivo: 'Menor preco invalido para comparacao', formula };
  }
  return {
    posicao: arredondar(((precoFornecedor - menorPreco) / menorPreco) * 100, 4),
    formula,
  };
}

/**
 * Indice de gravidade das nao conformidades (secao 19).
 *
 * Contar NCs sem peso trataria uma embalagem amassada e um lote contaminado
 * como o mesmo problema. O indice e a soma ponderada por gravidade dividida
 * pelos recebimentos avaliados - quanto maior, pior.
 */
export function indiceGravidade(
  contagem: { CRITICA: number; ALTA: number; MEDIA: number; BAIXA: number },
  pesos: { CRITICA: number; ALTA: number; MEDIA: number; BAIXA: number },
  recebimentos: number,
): { indice: number | null; motivo?: string; formula: string } {
  const formula = `indice = (criticas x ${pesos.CRITICA} + altas x ${pesos.ALTA}`
    + ` + medias x ${pesos.MEDIA} + baixas x ${pesos.BAIXA}) / recebimentos`;
  if (recebimentos <= 0) {
    return { indice: null, motivo: 'Sem recebimentos no periodo', formula };
  }
  const soma = contagem.CRITICA * pesos.CRITICA + contagem.ALTA * pesos.ALTA
    + contagem.MEDIA * pesos.MEDIA + contagem.BAIXA * pesos.BAIXA;
  return { indice: arredondar(soma / recebimentos, 4), formula };
}

// ---------------------------------------------------------------------------
// Tendencia (secoes 43 e 44)
// ---------------------------------------------------------------------------

export type Tendencia = 'MELHORIA' | 'ESTAVEL' | 'PIORA' | 'SEM_DADOS';

export interface AnaliseTendencia {
  tendencia: Tendencia;
  variacao: number | null;
  serie: number[];
  periodos: number;
  motivo?: string;
}

/**
 * Compara o primeiro e o ultimo ponto de uma serie curta.
 *
 * Nao conclui causa - so diz que o numero andou para um lado. A secao 43 e
 * explicita: gerar o alerta de tendencia **sem** concluir automaticamente o
 * motivo.
 */
export function analisarTendencia(
  serie: Array<number | null>, variacaoMinima: number, direcao: Direcao = 'MAIOR_MELHOR',
): AnaliseTendencia {
  const validos = serie.filter((v): v is number => v !== null && Number.isFinite(v));
  if (validos.length < 2) {
    return {
      tendencia: 'SEM_DADOS', variacao: null, serie: validos, periodos: validos.length,
      motivo: 'Sao necessarios ao menos dois periodos para comparar',
    };
  }

  const primeiro = validos[0];
  const ultimo = validos[validos.length - 1];
  const bruta = ultimo - primeiro;
  const variacao = primeiro !== 0
    ? arredondar((bruta / Math.abs(primeiro)) * 100, 2) : arredondar(bruta, 2);

  if (Math.abs(variacao) < variacaoMinima) {
    return { tendencia: 'ESTAVEL', variacao, serie: validos, periodos: validos.length };
  }

  const melhorou = direcao === 'MAIOR_MELHOR' ? bruta > 0 : bruta < 0;
  return {
    tendencia: melhorou ? 'MELHORIA' : 'PIORA',
    variacao,
    serie: validos,
    periodos: validos.length,
  };
}

// ---------------------------------------------------------------------------
// Concentracao de fornecimento (secoes 48 e 49)
// ---------------------------------------------------------------------------

export interface Concentracao {
  participacoes: Array<{ fornecedorId: number; fornecedor: string; valor: number; percentual: number }>;
  /** Soma dos quadrados das participacoes: 10000 = um unico fornecedor. */
  hhi: number | null;
  fornecedorUnico: boolean;
  concentrado: boolean;
  limite: number;
  total: number;
}

/**
 * Participacao de cada fornecedor e indice de concentracao.
 *
 * O HHI e informativo: a secao 49 manda **informar o risco**, nunca bloquear
 * a compra. Fornecedor unico e um fato de cadastro, nao uma falha.
 */
export function calcularConcentracao(
  linhas: Array<{ fornecedorId: number; fornecedor: string; valor: number }>,
  limitePercentual: number,
): Concentracao {
  const total = linhas.reduce((a, l) => a + l.valor, 0);
  if (total <= 0) {
    return {
      participacoes: [], hhi: null, fornecedorUnico: linhas.length === 1,
      concentrado: false, limite: limitePercentual, total: 0,
    };
  }

  const participacoes = linhas
    .map((l) => ({ ...l, percentual: arredondar((l.valor / total) * 100) }))
    .sort((a, b) => b.percentual - a.percentual);

  const hhi = arredondar(participacoes.reduce((a, p) => a + p.percentual ** 2, 0));

  return {
    participacoes,
    hhi,
    fornecedorUnico: participacoes.length === 1,
    concentrado: participacoes.some((p) => p.percentual >= limitePercentual),
    limite: limitePercentual,
    total: arredondar(total),
  };
}

// ---------------------------------------------------------------------------
// Validacao da metodologia (secao 11)
// ---------------------------------------------------------------------------

export interface ValidacaoPesos {
  valido: boolean;
  soma: number;
  mensagem?: string;
}

/** Regra 4 da secao 67: pesos somam 100. Peso zero e permitido. */
export function validarPesos(pesos: number[]): ValidacaoPesos {
  const soma = arredondar(pesos.reduce((a, p) => a + p, 0));
  if (pesos.some((p) => p < 0)) {
    return { valido: false, soma, mensagem: 'Peso negativo nao e permitido' };
  }
  if (soma !== 100) {
    return {
      valido: false, soma,
      mensagem: `Os pesos somam ${soma}% e precisam somar 100%`,
    };
  }
  return { valido: true, soma };
}
