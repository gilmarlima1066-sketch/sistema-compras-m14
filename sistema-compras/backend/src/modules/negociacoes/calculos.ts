/**
 * Matematica da negociacao e do pedido de compra.
 *
 * Puro de proposito: custo total, economia, bonificacao, rateio de frete,
 * parcelas e as validacoes de quantidade moram aqui, sem banco e sem request.
 * A secao 81 do PROMPT 07 exige que se consiga responder "qual era o valor
 * anterior, qual passou a ser, por que mudou" - e isso comeca por ter a conta
 * num lugar so.
 */

export interface ComponentesNegociacao {
  valorProdutos: number;
  desconto: number;
  frete: number;
  impostos: number;
  seguro: number;
  desembaraco: number;
  taxas: number;
  outros: number;
}

export const custoTotal = (c: ComponentesNegociacao): number =>
  c.valorProdutos - c.desconto + c.frete + c.impostos + c.seguro + c.desembaraco + c.taxas + c.outros;

export interface Economia {
  absoluta: number;
  percentual: number | null;
}

/**
 * Economia = custo inicial menos custo negociado. Percentual sobre o inicial.
 * Custo inicial zero devolve percentual null em vez de dividir por zero.
 */
export function economia(custoInicial: number, custoNegociado: number): Economia {
  const absoluta = custoInicial - custoNegociado;
  return {
    absoluta,
    percentual: custoInicial > 0 ? (absoluta / custoInicial) * 100 : null,
  };
}

export interface Bonificacao {
  quantidadeComprada: number;
  quantidadeBonificada: number;
  quantidadeRecebida: number;
  percentualBonificacao: number | null;
  valorEquivalente: number;
  custoUnitarioEfetivo: number | null;
}

/**
 * Bonificacao nao vira desconto no preco: as duas quantidades ficam separadas
 * (secao 17). O que ela muda e o custo unitario EFETIVO, porque o mesmo
 * dinheiro passa a comprar mais mercadoria.
 */
export function bonificacao(
  quantidadeComprada: number,
  quantidadeBonificada: number,
  precoUnitario: number,
  custoTotalPedido: number,
): Bonificacao {
  const recebida = quantidadeComprada + quantidadeBonificada;
  return {
    quantidadeComprada,
    quantidadeBonificada,
    quantidadeRecebida: recebida,
    percentualBonificacao: quantidadeComprada > 0
      ? (quantidadeBonificada / quantidadeComprada) * 100 : null,
    valorEquivalente: quantidadeBonificada * precoUnitario,
    custoUnitarioEfetivo: recebida > 0 ? custoTotalPedido / recebida : null,
  };
}

// ---------------------------------------------------------------------------
// Rateio de frete (secao 41)
// ---------------------------------------------------------------------------

export type MetodoRateio = 'VALOR' | 'PESO' | 'QUANTIDADE' | 'PERCENTUAL' | 'MANUAL';

export interface ItemRateio {
  id: number;
  valor: number;
  peso: number | null;
  quantidade: number;
  percentualManual?: number | null;
}

/**
 * Distribui o frete entre os itens. O resto da divisao vai para o item de maior
 * base, para que a soma das parcelas bata com o frete informado ao centavo.
 */
export function ratearFrete(
  itens: ItemRateio[],
  freteTotal: number,
  metodo: MetodoRateio,
): Map<number, number> {
  const saida = new Map<number, number>();
  if (!itens.length || freteTotal <= 0) {
    itens.forEach((i) => saida.set(i.id, 0));
    return saida;
  }

  const base = (i: ItemRateio): number => {
    switch (metodo) {
      case 'PESO': return i.peso !== null && i.peso > 0 ? i.peso * i.quantidade : 0;
      case 'QUANTIDADE': return i.quantidade;
      case 'PERCENTUAL':
      case 'MANUAL': return i.percentualManual ?? 0;
      default: return i.valor;
    }
  };

  let total = itens.reduce((a, i) => a + base(i), 0);
  // Sem base utilizavel (por exemplo peso nao cadastrado), cai para o valor.
  const usarValor = total <= 0;
  if (usarValor) total = itens.reduce((a, i) => a + i.valor, 0);
  if (total <= 0) {
    const igual = freteTotal / itens.length;
    itens.forEach((i) => saida.set(i.id, arredondar(igual)));
    return saida;
  }

  let distribuido = 0;
  const ordenados = [...itens].sort((a, b) => (usarValor ? b.valor - a.valor : base(b) - base(a)));
  ordenados.forEach((i, idx) => {
    if (idx === ordenados.length - 1) {
      saida.set(i.id, arredondar(freteTotal - distribuido));
      return;
    }
    const parcela = arredondar(freteTotal * ((usarValor ? i.valor : base(i)) / total));
    saida.set(i.id, parcela);
    distribuido += parcela;
  });

  return saida;
}

const arredondar = (v: number) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Parcelas (secoes 44 e 45)
// ---------------------------------------------------------------------------

export interface Parcela {
  parcela: number;
  vencimento: string;
  valor: number;
  percentual: number;
  entrada: boolean;
}

/**
 * Gera as parcelas a partir da data de emissao e do prazo. Com entrada, a
 * primeira parcela vence na emissao e as demais se distribuem pelo prazo.
 * O arredondamento sobra na ultima parcela para a soma fechar com o total.
 */
export function gerarParcelas(
  dataEmissao: string,
  valorTotal: number,
  prazoDias: number,
  numeroParcelas = 1,
  percentualEntrada = 0,
): Parcela[] {
  if (valorTotal <= 0) return [];
  const parcelas: Parcela[] = [];
  const emissao = new Date(`${dataEmissao}T00:00:00Z`);
  const somarDias = (d: number) =>
    new Date(emissao.getTime() + d * 86400000).toISOString().slice(0, 10);

  let restante = valorTotal;
  let indice = 1;

  if (percentualEntrada > 0) {
    const valorEntrada = arredondar(valorTotal * (percentualEntrada / 100));
    parcelas.push({
      parcela: indice, vencimento: somarDias(0), valor: valorEntrada,
      percentual: percentualEntrada, entrada: true,
    });
    restante -= valorEntrada;
    indice += 1;
  }

  // O prazo negociado e o intervalo entre parcelas, nao o total a dividir:
  // "35 dias em 2x" vence aos 35 e aos 70, como se cobra no mercado.
  const n = Math.max(1, numeroParcelas);

  for (let i = 0; i < n; i += 1) {
    const ultima = i === n - 1;
    const valor = ultima
      ? arredondar(restante - parcelas.slice(percentualEntrada > 0 ? 1 : 0).reduce((a, p) => a + p.valor, 0))
      : arredondar(restante / n);
    parcelas.push({
      parcela: indice,
      vencimento: somarDias(prazoDias * (i + 1)),
      valor,
      percentual: valorTotal > 0 ? (valor / valorTotal) * 100 : 0,
      entrada: false,
    });
    indice += 1;
  }

  return parcelas;
}

// ---------------------------------------------------------------------------
// Validacoes de quantidade (secao 28)
// ---------------------------------------------------------------------------

export interface ValidacaoQuantidade {
  atende: boolean;
  problemas: Array<{ regra: string; mensagem: string }>;
  quantidadeSugerida: number | null;
}

export function validarQuantidade(
  quantidade: number,
  moq: number | null,
  multiplo: number | null,
): ValidacaoQuantidade {
  const problemas: Array<{ regra: string; mensagem: string }> = [];
  let sugerida: number | null = null;

  if (quantidade <= 0) {
    problemas.push({ regra: 'QUANTIDADE', mensagem: 'Quantidade deve ser maior que zero' });
  }
  if (moq !== null && moq > 0 && quantidade < moq) {
    problemas.push({
      regra: 'MOQ',
      mensagem: `Quantidade de ${quantidade} abaixo do minimo do fornecedor (${moq})`,
    });
    sugerida = moq;
  }
  if (multiplo !== null && multiplo > 0) {
    const resto = Math.abs(quantidade % multiplo);
    if (resto > 1e-9 && Math.abs(resto - multiplo) > 1e-9) {
      problemas.push({
        regra: 'MULTIPLO',
        mensagem: `Quantidade de ${quantidade} nao e multipla de ${multiplo}`,
      });
      sugerida = Math.ceil(Math.max(quantidade, moq ?? 0) / multiplo) * multiplo;
    }
  }

  return { atende: problemas.length === 0, problemas, quantidadeSugerida: sugerida };
}

// ---------------------------------------------------------------------------
// Risco de excesso e de ruptura (secoes 64 e 65)
// ---------------------------------------------------------------------------

export interface ImpactoEstoque {
  estoqueDisponivel: number;
  estoqueEmTransito: number;
  quantidadePedido: number;
  demandaDiaria: number | null;
  coberturaAtualDias: number | null;
  coberturaAposCompraDias: number | null;
  limiteCoberturaDias: number;
  riscoExcesso: boolean;
  quantidadeExcedente: number | null;
  necessidadePlanejada: number | null;
  quantidadeFaltante: number | null;
  riscoRuptura: boolean;
  dataProvavelRuptura: string | null;
  percentualAcimaNecessidade: number | null;
}

export function impactoEstoque(dados: {
  estoqueDisponivel: number;
  estoqueEmTransito: number;
  quantidadePedido: number;
  demandaDiaria: number | null;
  limiteCoberturaDias: number;
  necessidadePlanejada: number | null;
  hoje: string;
}): ImpactoEstoque {
  const posicaoAtual = dados.estoqueDisponivel + dados.estoqueEmTransito;
  const posicaoApos = posicaoAtual + dados.quantidadePedido;
  const d = dados.demandaDiaria;

  const coberturaAtual = d && d > 0 ? posicaoAtual / d : null;
  const coberturaApos = d && d > 0 ? posicaoApos / d : null;

  const riscoExcesso = coberturaApos !== null && coberturaApos > dados.limiteCoberturaDias;
  const quantidadeExcedente = riscoExcesso && d
    ? posicaoApos - d * dados.limiteCoberturaDias : null;

  const necessidade = dados.necessidadePlanejada;
  const faltante = necessidade !== null ? Math.max(0, necessidade - dados.quantidadePedido) : null;
  const riscoRuptura = faltante !== null && faltante > 0;

  let dataRuptura: string | null = null;
  if (riscoRuptura && d && d > 0) {
    const dias = Math.max(0, Math.floor(posicaoApos / d));
    dataRuptura = new Date(new Date(`${dados.hoje}T00:00:00Z`).getTime() + dias * 86400000)
      .toISOString().slice(0, 10);
  }

  return {
    estoqueDisponivel: dados.estoqueDisponivel,
    estoqueEmTransito: dados.estoqueEmTransito,
    quantidadePedido: dados.quantidadePedido,
    demandaDiaria: d,
    coberturaAtualDias: coberturaAtual,
    coberturaAposCompraDias: coberturaApos,
    limiteCoberturaDias: dados.limiteCoberturaDias,
    riscoExcesso,
    quantidadeExcedente,
    necessidadePlanejada: necessidade,
    quantidadeFaltante: faltante,
    riscoRuptura,
    dataProvavelRuptura: dataRuptura,
    percentualAcimaNecessidade: necessidade && necessidade > 0
      ? ((dados.quantidadePedido - necessidade) / necessidade) * 100 : null,
  };
}

// ---------------------------------------------------------------------------
// Divergencia entre pedido e confirmacao (secao 37)
// ---------------------------------------------------------------------------

export interface Divergencia {
  campo: string;
  pedido: unknown;
  confirmado: unknown;
  diferenca: number | null;
  relevante: boolean;
}

export function compararConfirmacao(
  pedido: { quantidade: number; preco: number; prazoDias: number | null; dataPrometida: string | null },
  confirmacao: { quantidade: number | null; preco: number | null; prazoDias: number | null; dataPrometida: string | null },
  toleranciaPercentual: number,
): Divergencia[] {
  const saida: Divergencia[] = [];

  const percentual = (a: number, b: number) => (a > 0 ? Math.abs((b - a) / a) * 100 : b > 0 ? 100 : 0);

  if (confirmacao.quantidade !== null && confirmacao.quantidade !== pedido.quantidade) {
    const dif = percentual(pedido.quantidade, confirmacao.quantidade);
    saida.push({
      campo: 'quantidade', pedido: pedido.quantidade, confirmado: confirmacao.quantidade,
      diferenca: confirmacao.quantidade - pedido.quantidade, relevante: dif > toleranciaPercentual,
    });
  }
  if (confirmacao.preco !== null && Math.abs(confirmacao.preco - pedido.preco) > 1e-9) {
    const dif = percentual(pedido.preco, confirmacao.preco);
    saida.push({
      campo: 'preco', pedido: pedido.preco, confirmado: confirmacao.preco,
      diferenca: confirmacao.preco - pedido.preco, relevante: dif > toleranciaPercentual,
    });
  }
  if (confirmacao.prazoDias !== null && pedido.prazoDias !== null
      && confirmacao.prazoDias !== pedido.prazoDias) {
    saida.push({
      campo: 'prazo_entrega_dias', pedido: pedido.prazoDias, confirmado: confirmacao.prazoDias,
      diferenca: confirmacao.prazoDias - pedido.prazoDias,
      relevante: confirmacao.prazoDias > pedido.prazoDias,
    });
  }
  if (confirmacao.dataPrometida && pedido.dataPrometida
      && confirmacao.dataPrometida !== pedido.dataPrometida) {
    saida.push({
      campo: 'data_prometida', pedido: pedido.dataPrometida, confirmado: confirmacao.dataPrometida,
      diferenca: null, relevante: confirmacao.dataPrometida > pedido.dataPrometida,
    });
  }

  return saida;
}

// ---------------------------------------------------------------------------
// Comparativo antes x depois (secao 21)
// ---------------------------------------------------------------------------

export interface LinhaComparativo {
  criterio: string;
  antes: number | null;
  depois: number | null;
  diferenca: number | null;
  diferencaPercentual: number | null;
  unidade: string;
}

export function comparativoAntesDepois(antes: {
  precoMedio: number; frete: number; pagamentoDias: number | null;
  prazoDias: number | null; quantidade: number; custoTotal: number;
}, depois: typeof antes): LinhaComparativo[] {
  const linha = (
    criterio: string, a: number | null, d: number | null, unidade: string,
  ): LinhaComparativo => ({
    criterio,
    antes: a,
    depois: d,
    diferenca: a !== null && d !== null ? d - a : null,
    diferencaPercentual: a !== null && d !== null && a !== 0 ? ((d - a) / a) * 100 : null,
    unidade,
  });

  return [
    linha('Preco medio', antes.precoMedio, depois.precoMedio, 'moeda'),
    linha('Frete', antes.frete, depois.frete, 'moeda'),
    linha('Pagamento', antes.pagamentoDias, depois.pagamentoDias, 'dias'),
    linha('Prazo de entrega', antes.prazoDias, depois.prazoDias, 'dias'),
    linha('Quantidade', antes.quantidade, depois.quantidade, 'unidade'),
    linha('Custo total', antes.custoTotal, depois.custoTotal, 'moeda'),
  ];
}
