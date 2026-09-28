/**
 * Matematica do BI.
 *
 * Sem banco e sem request. Tres regras organizam o arquivo inteiro:
 *
 *   - zero e ausencia de dado sao coisas DIFERENTES (regra 6 da secao 71).
 *     Valor nulo viaja como nulo ate a tela, que escreve "sem dados";
 *   - comparacao de percentual sai em pontos percentuais (secao 52);
 *   - nada aqui decide: classifica, compara e explica. A decisao e do usuario
 *     (secao 72).
 */

export type Semaforo = 'VERDE' | 'AMARELO' | 'VERMELHO' | 'CINZA';
export type Direcao = 'MAIOR_MELHOR' | 'MENOR_MELHOR';
export type Tendencia = 'CRESCIMENTO' | 'ESTAVEL' | 'QUEDA' | 'SEM_DADOS';

export type Unidade =
  | 'PERCENTUAL' | 'MOEDA' | 'QUANTIDADE' | 'DIAS' | 'HORAS' | 'INDICE' | 'CONTAGEM';

const arredondar = (v: number, casas = 2) => {
  const f = 10 ** casas;
  return Math.round((v + Number.EPSILON) * f) / f;
};

// ---------------------------------------------------------------------------
// Divisao segura (secoes 17 e 56)
// ---------------------------------------------------------------------------

/**
 * Divisao que devolve `null` em vez de dividir por zero.
 *
 * O ponto nao e evitar `Infinity`: e que "cobertura de zero dias" e
 * "cobertura nao calculavel" significam coisas opostas para quem compra.
 */
export function dividir(
  numerador: number | null, denominador: number | null, casas = 2,
): number | null {
  if (numerador === null || denominador === null) return null;
  if (!Number.isFinite(numerador) || !Number.isFinite(denominador)) return null;
  if (denominador === 0) return null;
  return arredondar(numerador / denominador, casas);
}

/** Proporcao em percentual. Denominador zero devolve null, nunca 0. */
export const percentual = (parte: number, total: number, casas = 2): number | null =>
  total > 0 ? arredondar((parte / total) * 100, casas) : null;

// ---------------------------------------------------------------------------
// Semaforo (secoes 11 e 51)
// ---------------------------------------------------------------------------

export interface Meta {
  meta: number;
  limiteAtencao: number | null;
  limiteCritico: number | null;
  direcao: Direcao;
}

export interface Avaliacao {
  semaforo: Semaforo;
  /** Diferenca crua entre realizado e meta. */
  desvio: number | null;
  /**
   * Como o desvio deve ser lido. Percentual comparado com percentual sai em
   * pontos percentuais (secao 52); o resto sai na unidade do proprio KPI.
   */
  desvioUnidade: 'PONTOS_PERCENTUAIS' | 'ABSOLUTO';
  atingiuMeta: boolean | null;
  motivo?: string;
}

/**
 * Compara realizado com meta e devolve o semaforo.
 *
 * O `direcao` importa: em OTIF, 97 contra meta 95 e verde; em taxa de NC,
 * 12 contra meta 5 e vermelho. Os limites tambem invertem - num KPI onde
 * menor e melhor, o limite critico e MAIOR que a meta.
 *
 * Sem realizado, o semaforo e CINZA. Nunca verde por omissao.
 */
export function avaliarMeta(
  realizado: number | null, meta: Meta | null, unidade: Unidade,
): Avaliacao {
  const desvioUnidade = unidade === 'PERCENTUAL' ? 'PONTOS_PERCENTUAIS' : 'ABSOLUTO';

  if (realizado === null || !Number.isFinite(realizado)) {
    return {
      semaforo: 'CINZA', desvio: null, desvioUnidade, atingiuMeta: null,
      motivo: 'Sem dados suficientes para apurar o indicador',
    };
  }
  if (!meta) {
    return {
      semaforo: 'CINZA', desvio: null, desvioUnidade, atingiuMeta: null,
      motivo: 'Indicador sem meta configurada',
    };
  }

  const desvio = arredondar(realizado - meta.meta, 4);
  const maiorMelhor = meta.direcao === 'MAIOR_MELHOR';
  const atingiuMeta = maiorMelhor ? realizado >= meta.meta : realizado <= meta.meta;

  if (atingiuMeta) {
    return { semaforo: 'VERDE', desvio, desvioUnidade, atingiuMeta: true };
  }

  // Fora da meta: o quanto fora decide entre amarelo e vermelho.
  const critico = meta.limiteCritico;
  const atencao = meta.limiteAtencao;

  const passouCritico = critico === null ? false
    : maiorMelhor ? realizado < critico : realizado > critico;
  if (passouCritico) {
    return { semaforo: 'VERMELHO', desvio, desvioUnidade, atingiuMeta: false };
  }

  const passouAtencao = atencao === null ? true
    : maiorMelhor ? realizado < atencao : realizado > atencao;

  return {
    semaforo: passouAtencao ? (critico === null ? 'VERMELHO' : 'AMARELO') : 'AMARELO',
    desvio,
    desvioUnidade,
    atingiuMeta: false,
  };
}

// ---------------------------------------------------------------------------
// Comparacao de periodos (secoes 49 e 52)
// ---------------------------------------------------------------------------

export interface Comparacao {
  atual: number | null;
  anterior: number | null;
  /** Diferenca absoluta: atual menos anterior. */
  diferenca: number | null;
  /**
   * Variacao relativa em percentual. Em KPI que JA e percentual isto nao e
   * usado na tela - ali vale a diferenca em pontos percentuais.
   */
  variacaoPercentual: number | null;
  unidadeDiferenca: 'PONTOS_PERCENTUAIS' | 'ABSOLUTO';
  tendencia: Tendencia;
  motivo?: string;
}

/**
 * Compara dois periodos.
 *
 * Quando o KPI ja e percentual, a diferenca sai em **pontos percentuais**:
 * dizer que o OTIF "caiu 4,2%" quando foi de 95% para 91% e errado - caiu
 * 4 p.p., que e 4,4% relativos. A secao 52 exige a leitura em p.p.
 */
export function compararPeriodos(
  atual: number | null, anterior: number | null, unidade: Unidade,
  variacaoMinima = 1, direcao: Direcao = 'MAIOR_MELHOR',
): Comparacao {
  const unidadeDiferenca = unidade === 'PERCENTUAL' ? 'PONTOS_PERCENTUAIS' : 'ABSOLUTO';

  if (atual === null || anterior === null) {
    return {
      atual, anterior, diferenca: null, variacaoPercentual: null, unidadeDiferenca,
      tendencia: 'SEM_DADOS',
      motivo: atual === null && anterior === null
        ? 'Sem dados nos dois periodos'
        : atual === null ? 'Sem dados no periodo atual' : 'Sem dados no periodo anterior',
    };
  }

  const diferenca = arredondar(atual - anterior, 4);
  const variacaoPercentual = anterior === 0 ? null
    : arredondar((diferenca / Math.abs(anterior)) * 100, 2);

  const referencia = unidade === 'PERCENTUAL'
    ? Math.abs(diferenca)
    : Math.abs(variacaoPercentual ?? 0);

  if (referencia < variacaoMinima) {
    return {
      atual, anterior, diferenca, variacaoPercentual, unidadeDiferenca,
      tendencia: 'ESTAVEL',
    };
  }

  const subiu = diferenca > 0;
  const melhorou = direcao === 'MAIOR_MELHOR' ? subiu : !subiu;

  return {
    atual, anterior, diferenca, variacaoPercentual, unidadeDiferenca,
    // A tendencia descreve o movimento do NUMERO, e `melhorou` diz se isso e
    // bom. Trocar uma coisa pela outra faria "queda da taxa de NC" parecer
    // ruim.
    tendencia: subiu ? 'CRESCIMENTO' : 'QUEDA',
    motivo: melhorou ? undefined : 'Movimento desfavoravel para este indicador',
  };
}

/** Tendencia de uma serie curta, sem virar previsao (secao 50). */
export function analisarSerie(
  serie: Array<number | null>, variacaoMinima = 5, direcao: Direcao = 'MAIOR_MELHOR',
): { tendencia: Tendencia; variacao: number | null; pontos: number; serie: number[] } {
  const validos = serie.filter((v): v is number => v !== null && Number.isFinite(v));
  if (validos.length < 2) {
    return { tendencia: 'SEM_DADOS', variacao: null, pontos: validos.length, serie: validos };
  }

  const primeiro = validos[0];
  const ultimo = validos[validos.length - 1];
  const bruta = ultimo - primeiro;
  const variacao = primeiro !== 0
    ? arredondar((bruta / Math.abs(primeiro)) * 100, 2) : arredondar(bruta, 2);

  if (Math.abs(variacao) < variacaoMinima) {
    return { tendencia: 'ESTAVEL', variacao, pontos: validos.length, serie: validos };
  }
  void direcao;
  return {
    tendencia: bruta > 0 ? 'CRESCIMENTO' : 'QUEDA',
    variacao,
    pontos: validos.length,
    serie: validos,
  };
}

// ---------------------------------------------------------------------------
// Pareto (secao 48)
// ---------------------------------------------------------------------------

export interface LinhaPareto {
  rotulo: string;
  valor: number;
  percentual: number;
  acumulado: number;
  /** Entra na fatia que explica 80% do total. */
  vital: boolean;
  ordem: number;
}

export interface Pareto {
  linhas: LinhaPareto[];
  total: number;
  corte: number;
  /** Quantos itens explicam o corte. */
  vitais: number;
  /** Percentual de itens que explicam o corte - o "20" do 80/20. */
  percentualVitais: number | null;
  formula: string;
}

/**
 * Ordena por valor e acumula ate o corte (80% por padrao).
 *
 * O numero que interessa nao e a lista: e quantos itens, em percentual do
 * total de itens, respondem pela maior parte do problema. Se 45% dos
 * fornecedores explicam 80% dos atrasos, nao ha concentracao para atacar.
 */
export function pareto(
  dados: Array<{ rotulo: string; valor: number }>, corte = 80,
): Pareto {
  const positivos = dados.filter((d) => Number.isFinite(d.valor) && d.valor > 0);
  const total = positivos.reduce((a, d) => a + d.valor, 0);
  const formula = `acumulado ate ${corte}% do total, ordenado do maior para o menor`;

  if (total <= 0) {
    return { linhas: [], total: 0, corte, vitais: 0, percentualVitais: null, formula };
  }

  const ordenados = [...positivos].sort((a, b) => b.valor - a.valor);
  let acumulado = 0;
  let jaCobriu = false;

  const linhas = ordenados.map((d, i) => {
    const p = (d.valor / total) * 100;
    acumulado += p;
    // O item que ULTRAPASSA o corte ainda e vital: ele faz parte do conjunto
    // que explica os 80%. Cortar antes dele deixaria a conta abaixo do corte.
    const vital = !jaCobriu;
    if (acumulado >= corte) jaCobriu = true;
    return {
      rotulo: d.rotulo,
      valor: arredondar(d.valor, 2),
      percentual: arredondar(p),
      acumulado: arredondar(acumulado),
      vital,
      ordem: i + 1,
    };
  });

  const vitais = linhas.filter((l) => l.vital).length;

  return {
    linhas,
    total: arredondar(total, 2),
    corte,
    vitais,
    percentualVitais: percentual(vitais, linhas.length),
    formula,
  };
}

// ---------------------------------------------------------------------------
// Matriz de risco (secoes 35 e 36)
// ---------------------------------------------------------------------------

export type NivelRisco = 'BAIXO' | 'MODERADO' | 'ALTO' | 'CRITICO';
export type Faixa = 'BAIXA' | 'MEDIA' | 'ALTA';

export interface FatorRisco {
  codigo: string;
  descricao: string;
  /** Quanto este fator soma na probabilidade ou no impacto. */
  peso: number;
  dimensao: 'PROBABILIDADE' | 'IMPACTO';
}

export interface Risco {
  probabilidade: number;
  impacto: number;
  faixaProbabilidade: Faixa;
  faixaImpacto: Faixa;
  nivel: NivelRisco;
  fatores: FatorRisco[];
  formula: string;
}

const faixa = (v: number): Faixa => (v >= 67 ? 'ALTA' : v >= 34 ? 'MEDIA' : 'BAIXA');

/** Matriz probabilidade x impacto da secao 35. */
const MATRIZ: Record<Faixa, Record<Faixa, NivelRisco>> = {
  BAIXA: { BAIXA: 'BAIXO', MEDIA: 'BAIXO', ALTA: 'MODERADO' },
  MEDIA: { BAIXA: 'BAIXO', MEDIA: 'MODERADO', ALTA: 'ALTO' },
  ALTA: { BAIXA: 'MODERADO', MEDIA: 'ALTO', ALTA: 'CRITICO' },
};

/**
 * Classifica um risco pela soma dos fatores objetivos que o compoem.
 *
 * A secao 35 proibe criterio subjetivo sem parametro: por isso o risco nao
 * e digitado, e somado a partir de fatos verificaveis (ruptura, fornecedor
 * unico, atraso, lead time). Os fatores que somaram saem junto, para o
 * usuario ver POR QUE aquilo e critico (secao 36).
 */
export function classificarRisco(fatores: FatorRisco[]): Risco {
  const somar = (d: FatorRisco['dimensao']) => Math.min(100, Math.max(0,
    fatores.filter((f) => f.dimensao === d).reduce((a, f) => a + f.peso, 0)));

  const probabilidade = somar('PROBABILIDADE');
  const impacto = somar('IMPACTO');
  const fp = faixa(probabilidade);
  const fi = faixa(impacto);

  return {
    probabilidade: arredondar(probabilidade),
    impacto: arredondar(impacto),
    faixaProbabilidade: fp,
    faixaImpacto: fi,
    nivel: MATRIZ[fp][fi],
    fatores,
    formula: 'probabilidade e impacto somam os pesos dos fatores objetivos,'
      + ' limitados a 100; o nivel vem da matriz probabilidade x impacto',
  };
}

// ---------------------------------------------------------------------------
// Qualidade dos dados (secao 55)
// ---------------------------------------------------------------------------

export interface CampoCompletude {
  campo: string;
  preenchidos: number;
  total: number;
  percentual: number | null;
  obrigatorio: boolean;
}

export interface QualidadeDados {
  completude: number | null;
  campos: CampoCompletude[];
  registros: number;
  /** Campos obrigatorios abaixo do minimo aceitavel. */
  criticos: string[];
  formula: string;
}

/**
 * Completude dos cadastros.
 *
 * Campo obrigatorio vazio pesa; campo opcional vazio e informacao, nao falha.
 * A media considera so os obrigatorios - senao um cadastro cheio de campos
 * opcionais em branco pareceria ruim sem motivo.
 */
export function qualidadeDados(
  campos: Array<{ campo: string; preenchidos: number; total: number; obrigatorio: boolean }>,
  minimoAceitavel = 80,
): QualidadeDados {
  const linhas: CampoCompletude[] = campos.map((c) => ({
    ...c,
    percentual: percentual(c.preenchidos, c.total),
  }));

  const obrigatorios = linhas.filter((l) => l.obrigatorio && l.percentual !== null);
  const completude = obrigatorios.length
    ? arredondar(obrigatorios.reduce((a, l) => a + (l.percentual as number), 0)
      / obrigatorios.length)
    : null;

  return {
    completude,
    campos: linhas,
    registros: Math.max(0, ...linhas.map((l) => l.total)),
    criticos: obrigatorios
      .filter((l) => (l.percentual as number) < minimoAceitavel)
      .map((l) => l.campo),
    formula: 'media do percentual de preenchimento dos campos obrigatorios',
  };
}

// ---------------------------------------------------------------------------
// Giro de estoque (secao 18)
// ---------------------------------------------------------------------------

export interface Giro {
  giro: number | null;
  giroAnualizado: number | null;
  saidas: number;
  estoqueMedio: number;
  diasPeriodo: number;
  /** Dias que o estoque atual dura no ritmo do periodo. */
  diasEstoque: number | null;
  motivo?: string;
  formula: string;
}

/**
 * Giro de estoque.
 *
 * ATENCAO: a secao 18 manda "utilizar a metodologia existente no modulo 03".
 * Ela nao existe - o modulo 03 nunca implementou giro, so a configuracao
 * `estoque.dias_sem_giro_alerta`. Entao a metodologia nasce aqui, declarada:
 * saidas do periodo sobre estoque medio, anualizada. Fica registrada no
 * dicionario de indicadores para nao virar mais uma formula solta.
 */
export function calcularGiro(dados: {
  saidas: number;
  estoqueInicial: number;
  estoqueFinal: number;
  diasPeriodo: number;
}): Giro {
  const formula = 'giro = saidas do periodo / estoque medio;'
    + ' anualizado = giro x 365 / dias do periodo';
  const estoqueMedio = (dados.estoqueInicial + dados.estoqueFinal) / 2;

  if (estoqueMedio <= 0) {
    return {
      giro: null, giroAnualizado: null, saidas: arredondar(dados.saidas, 3),
      estoqueMedio: arredondar(estoqueMedio, 3), diasPeriodo: dados.diasPeriodo,
      diasEstoque: null,
      motivo: 'Estoque medio zero no periodo: giro nao calculavel',
      formula,
    };
  }
  if (dados.diasPeriodo <= 0) {
    return {
      giro: null, giroAnualizado: null, saidas: arredondar(dados.saidas, 3),
      estoqueMedio: arredondar(estoqueMedio, 3), diasPeriodo: dados.diasPeriodo,
      diasEstoque: null,
      motivo: 'Periodo invalido',
      formula,
    };
  }

  const giro = dados.saidas / estoqueMedio;
  const anualizado = giro * (365 / dados.diasPeriodo);

  return {
    giro: arredondar(giro, 4),
    giroAnualizado: arredondar(anualizado, 4),
    saidas: arredondar(dados.saidas, 3),
    estoqueMedio: arredondar(estoqueMedio, 3),
    diasPeriodo: dados.diasPeriodo,
    diasEstoque: anualizado > 0 ? arredondar(365 / anualizado, 1) : null,
    formula,
  };
}

// ---------------------------------------------------------------------------
// Cobertura (secao 17)
// ---------------------------------------------------------------------------

export interface Cobertura {
  dias: number | null;
  situacao: 'RUPTURA' | 'CRITICA' | 'ATENCAO' | 'ADEQUADA' | 'EXCESSO' | 'SEM_DEMANDA';
  motivo?: string;
  formula: string;
}

/**
 * Cobertura em dias.
 *
 * Sem demanda apurada a resposta e SEM_DEMANDA, nao cobertura infinita: um
 * produto que ninguem pede nao esta "bem coberto", esta parado. E essa
 * diferenca que evita o excesso passar por conforto.
 */
export function calcularCobertura(
  disponivel: number, demandaDiaria: number | null,
  limiares: { critica: number; atencao: number; excesso: number },
): Cobertura {
  const formula = 'cobertura em dias = estoque disponivel / demanda media diaria';

  if (demandaDiaria === null || demandaDiaria <= 0) {
    return {
      dias: null, situacao: 'SEM_DEMANDA',
      motivo: 'Produto sem demanda apurada no periodo: cobertura nao calculavel',
      formula,
    };
  }
  if (disponivel <= 0) {
    return { dias: 0, situacao: 'RUPTURA', formula };
  }

  const dias = arredondar(disponivel / demandaDiaria, 1);
  const situacao = dias <= limiares.critica ? 'CRITICA'
    : dias <= limiares.atencao ? 'ATENCAO'
      : dias >= limiares.excesso ? 'EXCESSO' : 'ADEQUADA';

  return { dias, situacao, formula };
}

// ---------------------------------------------------------------------------
// Formatacao do KPI para a tela
// ---------------------------------------------------------------------------

/** Sufixo da unidade, para a tela nao precisar decidir. */
export function sufixo(unidade: Unidade): string {
  switch (unidade) {
    case 'PERCENTUAL': return '%';
    case 'DIAS': return ' d';
    case 'HORAS': return ' h';
    case 'MOEDA': return '';
    default: return '';
  }
}

/** Texto do desvio, ja na unidade certa (secao 52). */
export function textoDesvio(a: Avaliacao, casas = 2): string | null {
  if (a.desvio === null) return null;
  const sinal = a.desvio > 0 ? '+' : '';
  const valor = arredondar(a.desvio, casas);
  return a.desvioUnidade === 'PONTOS_PERCENTUAIS'
    ? `${sinal}${valor} p.p.`
    : `${sinal}${valor}`;
}
