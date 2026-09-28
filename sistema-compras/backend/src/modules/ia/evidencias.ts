/**
 * A regra de ouro (secao 47) transformada em tipo.
 *
 * Toda afirmacao que a IA faz carrega a sua natureza. Isso nao e decoracao:
 * e a diferenca entre "o estoque e 850 kg" (FATO, esta no banco) e "o estoque
 * acabara em 6 dias" (PREVISAO, depende de a demanda se comportar como vinha
 * se comportando). Apresentadas do mesmo jeito, a segunda herda a autoridade
 * da primeira - e e exatamente assim que um sistema de apoio a decisao passa
 * a induzir decisao errada com ar de certeza.
 *
 * Por isso o tipo obriga: nao ha como construir uma evidencia sem declarar o
 * que ela e e de onde veio.
 *
 * Modulo puro: sem banco, sem request. Tudo aqui e testavel isoladamente.
 */

export type Natureza =
  | 'FATO'          // lido do banco
  | 'CALCULO'       // aritmetica sobre o que foi lido
  | 'PREVISAO'      // estimativa a partir de historico
  | 'HIPOTESE'      // explicacao possivel, nao confirmada
  | 'RECOMENDACAO'  // sugestao derivada dos dados
  | 'SIMULACAO';    // cenario hipotetico

export type Confianca = 'ALTA' | 'MEDIA' | 'BAIXA' | 'INSUFICIENTE';

export interface Evidencia {
  natureza: Natureza;
  /** O que se afirma, em uma frase. */
  afirmacao: string;
  valor?: number | string | null;
  unidade?: string;
  /** De onde veio: tabela, modulo ou indicador. Sem isto nao se confere nada. */
  fonte: string;
  periodo?: string;
  /** Quantas observacoes sustentam. Uma media de 2 pontos nao e uma media. */
  eventos?: number;
}

export const fato = (
  afirmacao: string, fonte: string,
  extra: Partial<Evidencia> = {},
): Evidencia => ({ natureza: 'FATO', afirmacao, fonte, ...extra });

export const calculo = (
  afirmacao: string, fonte: string,
  extra: Partial<Evidencia> = {},
): Evidencia => ({ natureza: 'CALCULO', afirmacao, fonte, ...extra });

export const previsao = (
  afirmacao: string, fonte: string,
  extra: Partial<Evidencia> = {},
): Evidencia => ({ natureza: 'PREVISAO', afirmacao, fonte, ...extra });

export const hipotese = (
  afirmacao: string, fonte: string,
  extra: Partial<Evidencia> = {},
): Evidencia => ({ natureza: 'HIPOTESE', afirmacao, fonte, ...extra });

export const simulacao = (
  afirmacao: string, fonte: string,
  extra: Partial<Evidencia> = {},
): Evidencia => ({ natureza: 'SIMULACAO', afirmacao, fonte, ...extra });

// ---------------------------------------------------------------------------
// Explicacao em seis perguntas (secao 21)
// ---------------------------------------------------------------------------

/**
 * As seis perguntas da secao 21.
 *
 * `o_que_pode_acontecer` e opcional porque nem toda observacao projeta futuro,
 * e inventar uma projecao para preencher o campo seria pior do que deixa-lo
 * vazio. As outras cinco sao obrigatorias: uma recomendacao sem impacto ou sem
 * dados usados e a "caixa preta" que a secao 46 proibe.
 */
export interface Explicacao {
  o_que_aconteceu: string;
  por_que_aconteceu: string;
  qual_o_impacto: string;
  o_que_pode_acontecer?: string;
  o_que_recomendo: string;
  quais_dados_foram_utilizados: string[];
}

// ---------------------------------------------------------------------------
// Confianca (secao 26)
// ---------------------------------------------------------------------------

export interface FatoresConfianca {
  /** Observacoes disponiveis contra o minimo exigido. */
  eventos: number;
  minimoEventos: number;
  /** Dias de historico contra o minimo exigido. */
  diasHistorico?: number;
  minimoDias?: number;
  /** Coeficiente de variacao da serie: quanto maior, menos estavel. */
  coeficienteVariacao?: number | null;
  /** Erro percentual medio do modelo, quando ha backtest. */
  mape?: number | null;
  /** Ha dado recente? Uma serie que parou ha tres meses nao descreve hoje. */
  dadoRecente?: boolean;
  /** Completude do cadastro envolvido, 0 a 100. */
  completude?: number | null;
}

export interface AvaliacaoConfianca {
  nivel: Confianca;
  pontos: number;
  motivos: string[];
}

/**
 * Calcula a confianca a partir de fatores objetivos (secao 26).
 *
 * A regra que importa esta na primeira linha: sem o minimo de observacoes, o
 * resultado e INSUFICIENTE e a funcao para por ali. Nao existe "confianca
 * baixa" para quem nao tem dado - existe ausencia de base, e chamar isso de
 * baixa confianca sugeriria que ha alguma.
 */
export function avaliarConfianca(f: FatoresConfianca): AvaliacaoConfianca {
  const motivos: string[] = [];

  if (f.eventos < f.minimoEventos) {
    return {
      nivel: 'INSUFICIENTE',
      pontos: 0,
      motivos: [`Apenas ${f.eventos} observacao(oes) - o minimo para analisar e `
        + `${f.minimoEventos}`],
    };
  }

  if (f.minimoDias !== undefined && f.diasHistorico !== undefined
    && f.diasHistorico < f.minimoDias) {
    return {
      nivel: 'INSUFICIENTE',
      pontos: 0,
      motivos: [`Historico de ${f.diasHistorico} dia(s) - o minimo para analisar e `
        + `${f.minimoDias}`],
    };
  }

  let pontos = 0;

  // Volume de observacoes: 3x o minimo ja e base sobrada.
  const folga = f.eventos / Math.max(f.minimoEventos, 1);
  if (folga >= 3) { pontos += 35; motivos.push(`${f.eventos} observacoes`); }
  else if (folga >= 2) { pontos += 25; motivos.push(`${f.eventos} observacoes`); }
  else { pontos += 12; motivos.push(`${f.eventos} observacoes, pouco acima do minimo`); }

  // Estabilidade da serie.
  if (f.coeficienteVariacao === null || f.coeficienteVariacao === undefined) {
    pontos += 10;
  } else if (f.coeficienteVariacao <= 0.25) {
    pontos += 30; motivos.push('serie estavel');
  } else if (f.coeficienteVariacao <= 0.5) {
    pontos += 18; motivos.push('serie com variacao moderada');
  } else {
    pontos += 5; motivos.push('serie muito irregular');
  }

  // Erro do modelo, quando existe backtest.
  if (f.mape !== null && f.mape !== undefined) {
    if (f.mape <= 15) { pontos += 20; motivos.push(`erro historico de ${f.mape.toFixed(1)}%`); }
    else if (f.mape <= 30) { pontos += 12; motivos.push(`erro historico de ${f.mape.toFixed(1)}%`); }
    else { pontos += 2; motivos.push(`erro historico alto: ${f.mape.toFixed(1)}%`); }
  } else {
    pontos += 8;
  }

  // Dado recente.
  if (f.dadoRecente === false) {
    pontos -= 20;
    motivos.push('sem movimentacao recente - o padrao pode ter mudado');
  } else if (f.dadoRecente === true) {
    pontos += 10;
  }

  // Completude do cadastro.
  if (f.completude !== null && f.completude !== undefined) {
    if (f.completude >= 90) { pontos += 5; }
    else if (f.completude < 60) {
      pontos -= 15;
      motivos.push(`cadastro ${f.completude.toFixed(0)}% completo`);
    }
  }

  const limitado = Math.max(0, Math.min(100, pontos));
  const nivel: Confianca = limitado >= 70 ? 'ALTA' : limitado >= 45 ? 'MEDIA' : 'BAIXA';

  return { nivel, pontos: limitado, motivos };
}

/** Ordem util para comparar niveis sem espalhar switch pelo codigo. */
export const ORDEM_CONFIANCA: Record<Confianca, number> = {
  INSUFICIENTE: 0, BAIXA: 1, MEDIA: 2, ALTA: 3,
};

export const confiancaAtende = (nivel: Confianca, minimo: Confianca): boolean =>
  ORDEM_CONFIANCA[nivel] >= ORDEM_CONFIANCA[minimo];
