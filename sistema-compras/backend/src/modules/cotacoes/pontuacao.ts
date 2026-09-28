/**
 * Custo total de aquisicao, elegibilidade e pontuacao das propostas.
 *
 * Arquivo puro de proposito: nao conhece banco nem request. O comprador precisa
 * conseguir refazer a conta no papel (secoes 18, 19 e 63 do PROMPT 06), e isso
 * so e possivel se a matematica estiver num lugar so e sem efeito colateral.
 */

export type Direcao = 'MAIOR_MELHOR' | 'MENOR_MELHOR';

export interface ComponentesCusto {
  quantidadeOfertada: number;
  precoUnitario: number;
  desconto: number;
  frete: number;
  impostos: number;
  seguro: number;
  desembaraco: number;
  taxas: number;
  outrosCustos: number;
  taxaCambio: number | null;
}

export interface CustoAquisicao {
  valorProdutos: number;
  desconto: number;
  frete: number;
  impostos: number;
  seguro: number;
  desembaraco: number;
  taxas: number;
  outrosCustos: number;
  custoTotal: number;
  custoUnitario: number;
  precoLiquidoUnitario: number;
  moedaConvertida: boolean;
}

/**
 * CUSTO TOTAL = produtos + frete + impostos + seguro + desembaraco + taxas
 *               + outros - desconto
 *
 * Tudo convertido para a moeda base pela taxa registrada na proposta. A taxa
 * nao substitui o valor original: ela multiplica na hora de comparar.
 */
export function custoAquisicao(c: ComponentesCusto): CustoAquisicao {
  const taxa = c.taxaCambio && c.taxaCambio > 0 ? c.taxaCambio : 1;
  const qtd = c.quantidadeOfertada > 0 ? c.quantidadeOfertada : 0;

  const valorProdutos = c.precoUnitario * qtd * taxa;
  const desconto = c.desconto * taxa;
  const frete = c.frete * taxa;
  const impostos = c.impostos * taxa;
  const seguro = c.seguro * taxa;
  const desembaraco = c.desembaraco * taxa;
  const taxas = c.taxas * taxa;
  const outrosCustos = c.outrosCustos * taxa;

  const custoTotal = valorProdutos - desconto + frete + impostos + seguro
    + desembaraco + taxas + outrosCustos;

  return {
    valorProdutos,
    desconto,
    frete,
    impostos,
    seguro,
    desembaraco,
    taxas,
    outrosCustos,
    custoTotal,
    custoUnitario: qtd > 0 ? custoTotal / qtd : 0,
    precoLiquidoUnitario: qtd > 0 ? (valorProdutos - desconto) / qtd : 0,
    moedaConvertida: taxa !== 1,
  };
}

/** Faixa de desconto por volume aplicavel a uma quantidade (secao 29). */
export function precoPorFaixa(
  faixas: Array<{ quantidade_de: number; quantidade_ate: number | null; preco_unitario: number }>,
  quantidade: number,
): number | null {
  const aplicavel = faixas
    .filter((f) => quantidade >= Number(f.quantidade_de)
      && (f.quantidade_ate === null || quantidade <= Number(f.quantidade_ate)))
    .sort((a, b) => Number(b.quantidade_de) - Number(a.quantidade_de))[0];
  return aplicavel ? Number(aplicavel.preco_unitario) : null;
}

// ---------------------------------------------------------------------------
// Elegibilidade
// ---------------------------------------------------------------------------

export interface DadosElegibilidade {
  fornecedorAtivo: boolean;
  quantidadeOfertada: number | null;
  quantidadeSolicitada: number;
  validadeProdutoDias: number | null;
  validadeMinimaDias: number | null;
  dataPrevistaEntrega: string | null;
  dataNecessaria: string | null;
  disponibilidade: string | null;
  validadeProposta: string | null;
  moq: number | null;
  precoMaximo: number | null;
  custoUnitario: number;
  hoje: string;
}

export interface MotivoInelegibilidade {
  criterio: string;
  motivo: string;
}

/**
 * Criterios obrigatorios (secao 21): preco menor NAO compensa condicao
 * obrigatoria nao atendida. Cada motivo vem com o texto que a tela mostra.
 */
export function avaliarElegibilidade(d: DadosElegibilidade): MotivoInelegibilidade[] {
  const motivos: MotivoInelegibilidade[] = [];

  if (!d.fornecedorAtivo) {
    motivos.push({ criterio: 'FORNECEDOR_ATIVO', motivo: 'Fornecedor inativo' });
  }

  if (d.quantidadeOfertada === null) {
    motivos.push({ criterio: 'SEM_RESPOSTA', motivo: 'Fornecedor nao respondeu este item' });
  } else if (d.quantidadeOfertada <= 0) {
    motivos.push({ criterio: 'QUANTIDADE', motivo: 'Quantidade ofertada igual a zero' });
  }

  if (d.validadeMinimaDias !== null && d.validadeProdutoDias !== null
      && d.validadeProdutoDias < d.validadeMinimaDias) {
    motivos.push({
      criterio: 'VALIDADE_MINIMA',
      motivo: `Validade inferior ao requisito minimo (${d.validadeProdutoDias} dias contra ${d.validadeMinimaDias} exigidos)`,
    });
  }

  if (d.dataNecessaria && d.dataPrevistaEntrega && d.dataPrevistaEntrega > d.dataNecessaria) {
    motivos.push({
      criterio: 'DATA_ENTREGA',
      motivo: `Entrega prevista para ${d.dataPrevistaEntrega}, depois da data necessaria ${d.dataNecessaria}`,
    });
  }

  if (d.disponibilidade === 'INDISPONIVEL') {
    motivos.push({ criterio: 'DISPONIBILIDADE', motivo: 'Produto indisponivel no fornecedor' });
  }

  if (d.validadeProposta && d.validadeProposta < d.hoje) {
    motivos.push({
      criterio: 'PROPOSTA_EXPIRADA',
      motivo: `Proposta expirou em ${d.validadeProposta}`,
    });
  }

  if (d.moq !== null && d.quantidadeOfertada !== null && d.moq > d.quantidadeSolicitada * 2) {
    motivos.push({
      criterio: 'MOQ_INVIAVEL',
      motivo: `MOQ de ${d.moq} e mais que o dobro da necessidade de ${d.quantidadeSolicitada}`,
    });
  }

  if (d.precoMaximo !== null && d.custoUnitario > d.precoMaximo) {
    motivos.push({
      criterio: 'PRECO_MAXIMO',
      motivo: `Custo unitario de ${d.custoUnitario.toFixed(4)} acima do maximo aceitavel de ${d.precoMaximo}`,
    });
  }

  return motivos;
}

// ---------------------------------------------------------------------------
// Pontuacao
// ---------------------------------------------------------------------------

/**
 * Normaliza um valor para 0..100 dentro da faixa observada entre as propostas
 * concorrentes. Quando todas empatam, todas ficam com 100: nao ha diferenca a
 * premiar nem a punir.
 */
export function normalizar(valor: number, minimo: number, maximo: number, direcao: Direcao): number {
  if (!Number.isFinite(valor)) return 0;
  if (maximo === minimo) return 100;
  const proporcao = (valor - minimo) / (maximo - minimo);
  const pontos = direcao === 'MENOR_MELHOR' ? 1 - proporcao : proporcao;
  return Math.max(0, Math.min(100, pontos * 100));
}

export interface EntradaCriterio {
  codigo: string;
  peso: number;
  direcao: Direcao;
  /** null = a proposta nao tem esse dado; o criterio nao pontua. */
  valor: number | null;
  valorTexto?: string;
  observacao?: string;
}

export interface PontuacaoCriterio {
  codigo: string;
  valorOriginal: number | null;
  valorTexto?: string;
  pontuacao: number | null;
  peso: number;
  pontuacaoPonderada: number | null;
  dadosInsuficientes: boolean;
  observacao?: string;
}

export interface ResultadoScore {
  score: number;
  pesoUtilizado: number;
  criterios: PontuacaoCriterio[];
}

/**
 * Score de uma proposta dentro de um conjunto de concorrentes.
 *
 *   score = Σ(pontuacao × peso) / Σ(pesos com dado) × 100 / 100
 *
 * O denominador e a soma dos pesos que tinham dado: se ninguem informou frete,
 * o peso do frete e redistribuido entre os demais em vez de zerar todo mundo.
 * Criterio sem dado aparece como DADOS INSUFICIENTES, nunca com nota inventada.
 */
export function calcularScore(
  propostas: Array<{ id: number; criterios: EntradaCriterio[] }>,
): Map<number, ResultadoScore> {
  const faixas = new Map<string, { minimo: number; maximo: number }>();

  for (const proposta of propostas) {
    for (const c of proposta.criterios) {
      if (c.valor === null || !Number.isFinite(c.valor)) continue;
      const atual = faixas.get(c.codigo);
      if (!atual) faixas.set(c.codigo, { minimo: c.valor, maximo: c.valor });
      else {
        atual.minimo = Math.min(atual.minimo, c.valor);
        atual.maximo = Math.max(atual.maximo, c.valor);
      }
    }
  }

  const saida = new Map<number, ResultadoScore>();

  for (const proposta of propostas) {
    const criterios: PontuacaoCriterio[] = [];
    let somaPonderada = 0;
    let somaPesos = 0;

    for (const c of proposta.criterios) {
      const faixa = faixas.get(c.codigo);
      const semDado = c.valor === null || !Number.isFinite(c.valor) || !faixa;

      if (semDado) {
        criterios.push({
          codigo: c.codigo,
          valorOriginal: null,
          valorTexto: c.valorTexto,
          pontuacao: null,
          peso: c.peso,
          pontuacaoPonderada: null,
          dadosInsuficientes: true,
          observacao: c.observacao ?? 'Sem dado disponivel para este criterio',
        });
        continue;
      }

      const pontuacao = normalizar(c.valor!, faixa!.minimo, faixa!.maximo, c.direcao);
      const ponderada = (pontuacao * c.peso) / 100;
      somaPonderada += ponderada;
      somaPesos += c.peso;

      criterios.push({
        codigo: c.codigo,
        valorOriginal: c.valor,
        valorTexto: c.valorTexto,
        pontuacao,
        peso: c.peso,
        pontuacaoPonderada: ponderada,
        dadosInsuficientes: false,
        observacao: c.observacao,
      });
    }

    // Reescala pelo peso efetivamente usado para que propostas com criterios
    // ausentes nao sejam punidas por algo que ninguem informou.
    const score = somaPesos > 0 ? (somaPonderada / somaPesos) * 100 : 0;
    saida.set(proposta.id, { score, pesoUtilizado: somaPesos, criterios });
  }

  return saida;
}

/** Os pesos de uma cotacao precisam somar 100 (secao 15). */
export function validarPesos(pesos: number[]): { valido: boolean; soma: number } {
  const soma = pesos.reduce((a, b) => a + b, 0);
  return { valido: Math.abs(soma - 100) < 0.01, soma };
}

// ---------------------------------------------------------------------------
// Recomendacao
// ---------------------------------------------------------------------------

export interface PropostaResumo {
  id: number;
  fornecedor: string;
  custoUnitario: number;
  custoTotal: number;
  prazoEntregaDias: number | null;
  prazoPagamentoDias: number | null;
  otif: number | null;
  qualidade: number | null;
  atendimentoPercentual: number;
  score: number;
  elegivel: boolean;
}

/**
 * Monta a frase que explica a recomendacao a partir dos fatos, nunca de
 * adjetivos soltos. Se a melhor por score nao for a mais barata, a frase diz
 * exatamente o que se esta trocando por que (secoes 35 e 36).
 */
export function explicarRecomendacao(propostas: PropostaResumo[]): {
  recomendada: PropostaResumo | null;
  texto: string;
  fatores: Array<{ fator: string; detalhe: string }>;
} {
  const elegiveis = propostas.filter((p) => p.elegivel);
  if (!elegiveis.length) {
    return {
      recomendada: null,
      texto: 'Nenhuma proposta elegivel. Verifique os motivos de inelegibilidade de cada fornecedor.',
      fatores: [],
    };
  }

  const porScore = [...elegiveis].sort((a, b) => b.score - a.score);
  const melhor = porScore[0]!;
  const maisBarata = [...elegiveis].sort((a, b) => a.custoTotal - b.custoTotal)[0]!;
  const maisRapida = [...elegiveis]
    .filter((p) => p.prazoEntregaDias !== null)
    .sort((a, b) => (a.prazoEntregaDias ?? 0) - (b.prazoEntregaDias ?? 0))[0];

  const fatores: Array<{ fator: string; detalhe: string }> = [];
  const partes: string[] = [];

  if (melhor.id === maisBarata.id) {
    partes.push(`${melhor.fornecedor} tem o menor custo total (${melhor.custoTotal.toFixed(2)})`);
    fatores.push({ fator: 'custo_total', detalhe: `menor entre ${elegiveis.length} propostas elegiveis` });
  } else {
    const diferenca = melhor.custoTotal - maisBarata.custoTotal;
    const percentual = maisBarata.custoTotal > 0 ? (diferenca / maisBarata.custoTotal) * 100 : 0;
    partes.push(
      `${melhor.fornecedor} nao e a proposta mais barata: custa ${diferenca.toFixed(2)} `
      + `(${percentual.toFixed(1)}%) a mais que ${maisBarata.fornecedor}`,
    );
    fatores.push({
      fator: 'custo_total',
      detalhe: `${melhor.custoTotal.toFixed(2)} contra ${maisBarata.custoTotal.toFixed(2)} da mais barata`,
    });
  }

  if (melhor.prazoEntregaDias !== null) {
    const nota = maisRapida && maisRapida.id !== melhor.id
      ? `${melhor.prazoEntregaDias} dias, contra ${maisRapida.prazoEntregaDias} do prazo mais curto`
      : `${melhor.prazoEntregaDias} dias, o prazo mais curto entre as elegiveis`;
    partes.push(`prazo de entrega de ${nota}`);
    fatores.push({ fator: 'prazo_entrega', detalhe: nota });
  }

  if (melhor.otif !== null) {
    partes.push(`OTIF historico de ${melhor.otif.toFixed(1)}%`);
    fatores.push({ fator: 'otif', detalhe: `${melhor.otif.toFixed(1)}% na ultima avaliacao` });
  }
  if (melhor.qualidade !== null) {
    fatores.push({ fator: 'qualidade', detalhe: `indice ${melhor.qualidade.toFixed(1)}` });
  }

  if (melhor.atendimentoPercentual < 100) {
    partes.push(
      `atende ${melhor.atendimentoPercentual.toFixed(1)}% da quantidade pedida, `
      + 'o restante precisa de outro fornecedor ou de nova cotacao',
    );
    fatores.push({
      fator: 'atendimento',
      detalhe: `${melhor.atendimentoPercentual.toFixed(1)}% da quantidade solicitada`,
    });
  }

  const texto = `${partes.join('; ')}. Score ${melhor.score.toFixed(1)} `
    + `entre ${elegiveis.length} propostas elegiveis. A decisao final e do comprador.`;

  return { recomendada: melhor, texto, fatores };
}

// ---------------------------------------------------------------------------
// Risco (secao 42)
// ---------------------------------------------------------------------------

export interface DadosRisco {
  fornecedoresElegiveis: number;
  disponibilidade: string | null;
  leadTimeDias: number | null;
  leadTimeRisco: number;
  otif: number | null;
  qualidade: number | null;
  moq: number | null;
  quantidadeSolicitada: number;
  variacaoPrecoPercentual: number | null;
  diasParaExpirar: number | null;
  diasAlertaValidade: number;
}

export function fatoresRisco(d: DadosRisco): Array<{ fator: string; nivel: string; detalhe: string }> {
  const riscos: Array<{ fator: string; nivel: string; detalhe: string }> = [];

  if (d.fornecedoresElegiveis <= 1) {
    riscos.push({ fator: 'FORNECEDOR_UNICO', nivel: 'ALTA', detalhe: 'Apenas uma proposta elegivel para este item' });
  }
  if (d.disponibilidade === 'PARCIAL' || d.disponibilidade === 'PRODUCAO') {
    riscos.push({
      fator: 'BAIXA_DISPONIBILIDADE', nivel: 'MEDIA',
      detalhe: d.disponibilidade === 'PRODUCAO' ? 'Depende de producao' : 'Disponibilidade parcial',
    });
  }
  if (d.leadTimeDias !== null && d.leadTimeDias >= d.leadTimeRisco) {
    riscos.push({ fator: 'LEAD_TIME_ELEVADO', nivel: 'MEDIA', detalhe: `${d.leadTimeDias} dias de entrega` });
  }
  if (d.otif !== null && d.otif < 80) {
    riscos.push({ fator: 'HISTORICO_ATRASO', nivel: 'ALTA', detalhe: `OTIF historico de ${d.otif.toFixed(1)}%` });
  }
  if (d.qualidade !== null && d.qualidade < 80) {
    riscos.push({ fator: 'HISTORICO_QUALIDADE', nivel: 'ALTA', detalhe: `Indice de qualidade ${d.qualidade.toFixed(1)}` });
  }
  if (d.moq !== null && d.moq > d.quantidadeSolicitada) {
    riscos.push({
      fator: 'MOQ_ELEVADO', nivel: 'MEDIA',
      detalhe: `MOQ de ${d.moq} acima da necessidade de ${d.quantidadeSolicitada}`,
    });
  }
  if (d.variacaoPrecoPercentual !== null && Math.abs(d.variacaoPrecoPercentual) > 25) {
    riscos.push({
      fator: 'PRECO_VOLATIL', nivel: 'MEDIA',
      detalhe: `${d.variacaoPrecoPercentual > 0 ? '+' : ''}${d.variacaoPrecoPercentual.toFixed(1)}% contra o historico`,
    });
  }
  if (d.diasParaExpirar !== null && d.diasParaExpirar <= d.diasAlertaValidade) {
    riscos.push({
      fator: 'PROPOSTA_EXPIRANDO', nivel: d.diasParaExpirar <= 0 ? 'ALTA' : 'MEDIA',
      detalhe: d.diasParaExpirar <= 0 ? 'Proposta expirada' : `Expira em ${d.diasParaExpirar} dias`,
    });
  }

  return riscos;
}
