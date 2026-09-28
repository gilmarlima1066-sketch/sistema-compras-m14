/**
 * Matematica do recebimento: diferenca, tolerancia, vida util, semaforo,
 * amostragem e custo de entrada.
 *
 * Puro de proposito: sem banco e sem request. A secao 58 do PROMPT 09 lista
 * dez regras criticas, e quase todas viram uma decisao de "pode ou nao pode"
 * baseada nestas contas - dar para conferir a aritmetica isoladamente e o que
 * torna essas regras confiaveis.
 *
 * Regra que atravessa o arquivo: dado ausente devolve `null` com motivo, nunca
 * um numero inventado. Produto sem controle de validade nao tem "0% de vida
 * util"; ele nao tem vida util a avaliar.
 */

const DIA = 86400000;

const dia = (valor: string): number => Date.parse(`${valor.slice(0, 10)}T00:00:00Z`);

export const diferencaDias = (de: string | null, ate: string | null): number | null =>
  de === null || ate === null ? null : Math.round((dia(ate) - dia(de)) / DIA);

// ---------------------------------------------------------------------------
// Conferencia de quantidade (secoes 10, 12, 13, 27 e 28)
// ---------------------------------------------------------------------------

export interface Tolerancia {
  quantidadePercentual: number;
  pesoPercentual: number;
  valorPercentual: number;
  validadeDias: number;
  origem: string;
}

export interface ConferenciaQuantidade {
  pedida: number;
  recebida: number;
  /** Recebida menos pedida. Negativo = falta, positivo = sobra. */
  diferenca: number;
  diferencaPercentual: number | null;
  percentualAtendimento: number | null;
  situacao: 'EXATA' | 'FALTA' | 'SOBRA';
  dentroTolerancia: boolean;
  toleranciaAplicada: number;
  /** Quanto passou do limite, quando passou. */
  excedente: number | null;
  faltante: number | null;
}

/**
 * Compara o que chegou com o que foi pedido.
 *
 * A tolerancia e simetrica: vale tanto para sobra quanto para falta. O que
 * muda e o tratamento - sobra fora da tolerancia exige decisao (secao 27),
 * falta gera saldo pendente que volta para o modulo 08 (secao 28).
 */
export function conferirQuantidade(
  pedida: number, recebida: number, tolerancia: number,
): ConferenciaQuantidade {
  const diferenca = recebida - pedida;
  const percentual = pedida > 0 ? (diferenca / pedida) * 100 : null;

  const situacao: ConferenciaQuantidade['situacao'] =
    diferenca === 0 ? 'EXATA' : diferenca < 0 ? 'FALTA' : 'SOBRA';

  const limite = pedida * (tolerancia / 100);
  const dentro = Math.abs(diferenca) <= limite + 1e-9;

  return {
    pedida,
    recebida,
    diferenca,
    diferencaPercentual: percentual,
    percentualAtendimento: pedida > 0 ? (recebida / pedida) * 100 : null,
    situacao,
    dentroTolerancia: dentro,
    toleranciaAplicada: tolerancia,
    excedente: situacao === 'SOBRA' && !dentro ? diferenca - limite : null,
    faltante: situacao === 'FALTA' ? -diferenca : null,
  };
}

/**
 * Conversao de unidade (secao 12): nunca converter sem o fator cadastrado.
 * Fator ausente ou invalido devolve null em vez de assumir 1 - assumir 1 num
 * produto vendido em caixa de 12 erraria a entrada por doze vezes.
 */
export function converterQuantidade(
  quantidade: number, fatorConversao: number | null,
): { convertida: number | null; motivo?: string } {
  if (fatorConversao === null || !Number.isFinite(fatorConversao) || fatorConversao <= 0) {
    return { convertida: null, motivo: 'Produto sem fator de conversao cadastrado' };
  }
  return { convertida: quantidade * fatorConversao };
}

// ---------------------------------------------------------------------------
// Validade e vida util (secoes 15 e 16)
// ---------------------------------------------------------------------------

export type SituacaoValidade =
  | 'ADEQUADA' | 'PROXIMA' | 'CRITICA' | 'INSUFICIENTE' | 'VENCIDO' | 'SEM_CONTROLE';

export interface AvaliacaoValidade {
  avaliavel: boolean;
  motivo?: string;
  diasRestantes: number | null;
  vidaUtilTotalDias: number | null;
  /** Dias restantes sobre a vida util total, em percentual. */
  vidaUtilRestantePercentual: number | null;
  minimoExigidoPercentual: number | null;
  situacao: SituacaoValidade;
  atendeMinimo: boolean | null;
  memoria: Record<string, unknown>;
}

export interface LimiaresValidade {
  /** Abaixo disso a validade ja e "proxima". */
  proximaPercentual: number;
  /** Abaixo disso e "critica". */
  criticaPercentual: number;
}

/**
 * Regra dos 80% da vida util (secao 16).
 *
 * ```
 * vida util restante = dias ate a validade / vida util total x 100
 * ```
 *
 * A vida util total vem do cadastro do produto (dias_validade). Quando existe
 * data de fabricacao, ela manda: o intervalo fabricacao->validade e a vida
 * util real daquele lote, que pode diferir do padrao do cadastro.
 */
export function avaliarValidade(dados: {
  controlaValidade: boolean;
  dataValidade: string | null;
  dataFabricacao: string | null;
  diasValidadeProduto: number | null;
  minimoPercentual: number | null;
  limiares: LimiaresValidade;
  hoje: string;
}): AvaliacaoValidade {
  const vazio = {
    diasRestantes: null, vidaUtilTotalDias: null, vidaUtilRestantePercentual: null,
    minimoExigidoPercentual: dados.minimoPercentual, atendeMinimo: null,
  };

  if (!dados.controlaValidade) {
    return {
      ...vazio, avaliavel: false, situacao: 'SEM_CONTROLE',
      motivo: 'Produto nao controla validade',
      memoria: { regra: 'Produto sem controle de validade no cadastro' },
    };
  }

  if (!dados.dataValidade) {
    return {
      ...vazio, avaliavel: false, situacao: 'SEM_CONTROLE',
      motivo: 'Validade nao informada na conferencia',
      memoria: { regra: 'Produto controla validade, mas a data nao foi informada' },
    };
  }

  const diasRestantes = diferencaDias(dados.hoje, dados.dataValidade)!;

  if (diasRestantes < 0) {
    return {
      ...vazio,
      avaliavel: true,
      diasRestantes,
      situacao: 'VENCIDO',
      atendeMinimo: false,
      memoria: {
        regra: 'Data de validade anterior a data de hoje',
        data_validade: dados.dataValidade, hoje: dados.hoje,
      },
    };
  }

  // Vida util do lote: fabricacao -> validade quando houver; senao, o padrao
  // do cadastro do produto.
  const vidaUtilLote = dados.dataFabricacao
    ? diferencaDias(dados.dataFabricacao, dados.dataValidade)
    : null;
  const vidaUtilTotal = vidaUtilLote && vidaUtilLote > 0
    ? vidaUtilLote
    : (dados.diasValidadeProduto && dados.diasValidadeProduto > 0
      ? dados.diasValidadeProduto : null);

  if (vidaUtilTotal === null) {
    return {
      ...vazio,
      avaliavel: false,
      diasRestantes,
      situacao: diasRestantes <= 0 ? 'VENCIDO' : 'SEM_CONTROLE',
      motivo: 'Sem vida util total: produto sem dias de validade e lote sem fabricacao',
      memoria: {
        regra: 'Percentual de vida util exige a vida util total do produto ou do lote',
        dias_restantes: diasRestantes,
      },
    };
  }

  const percentual = (diasRestantes / vidaUtilTotal) * 100;
  const minimo = dados.minimoPercentual;
  const atende = minimo === null ? null : percentual >= minimo - 1e-9;

  let situacao: SituacaoValidade;
  if (atende === false) situacao = 'INSUFICIENTE';
  else if (percentual < dados.limiares.criticaPercentual) situacao = 'CRITICA';
  else if (percentual < dados.limiares.proximaPercentual) situacao = 'PROXIMA';
  else situacao = 'ADEQUADA';

  return {
    avaliavel: true,
    diasRestantes,
    vidaUtilTotalDias: vidaUtilTotal,
    vidaUtilRestantePercentual: percentual,
    minimoExigidoPercentual: minimo,
    situacao,
    atendeMinimo: atende,
    memoria: {
      regra: 'vida util restante = dias ate a validade / vida util total x 100',
      dias_restantes: diasRestantes,
      vida_util_total_dias: vidaUtilTotal,
      origem_vida_util: vidaUtilLote && vidaUtilLote > 0 ? 'FABRICACAO_VALIDADE' : 'CADASTRO_PRODUTO',
      percentual: percentual,
      minimo_exigido: minimo,
    },
  };
}

// ---------------------------------------------------------------------------
// Semaforo (secao 52)
// ---------------------------------------------------------------------------

export type Semaforo = 'VERDE' | 'AMARELO' | 'VERMELHO' | 'CINZA';

export interface SemaforoItem {
  quantidade: Semaforo;
  validade: Semaforo;
  lote: Semaforo;
  qualidade: Semaforo;
  geral: Semaforo;
}

const PIOR: Semaforo[] = ['VERMELHO', 'AMARELO', 'CINZA', 'VERDE'];

const pior = (cores: Semaforo[]): Semaforo =>
  PIOR.find((c) => cores.includes(c)) ?? 'VERDE';

export function semaforoItem(dados: {
  conferido: boolean;
  quantidade: ConferenciaQuantidade | null;
  validade: AvaliacaoValidade;
  exigeLote: boolean;
  loteInformado: boolean;
  resultadoQualidade: string | null;
}): SemaforoItem {
  const qtd: Semaforo = !dados.conferido || dados.quantidade === null ? 'CINZA'
    : dados.quantidade.situacao === 'EXATA' ? 'VERDE'
      : dados.quantidade.dentroTolerancia ? 'AMARELO' : 'VERMELHO';

  const val: Semaforo = dados.validade.situacao === 'SEM_CONTROLE'
    ? (dados.validade.motivo === 'Produto nao controla validade' ? 'VERDE' : 'CINZA')
    : dados.validade.situacao === 'ADEQUADA' ? 'VERDE'
      : dados.validade.situacao === 'PROXIMA' ? 'AMARELO'
        : 'VERMELHO';

  // Antes da conferencia a falta de lote ainda nao e falha: e informacao
  // pendente. Vermelho so depois que o conferente fechou o item sem lote.
  const lote: Semaforo = !dados.exigeLote ? 'VERDE'
    : dados.loteInformado ? 'VERDE'
      : dados.conferido ? 'VERMELHO' : 'CINZA';

  const qual: Semaforo = dados.resultadoQualidade === null ? 'CINZA'
    : dados.resultadoQualidade === 'APROVADO' ? 'VERDE'
      : dados.resultadoQualidade === 'APROVADO_COM_RESSALVA' ? 'AMARELO'
        : dados.resultadoQualidade === 'PENDENTE' ? 'CINZA'
          : 'VERMELHO';

  return {
    quantidade: qtd,
    validade: val,
    lote,
    qualidade: qual,
    geral: pior([qtd, val, lote, qual]),
  };
}

// ---------------------------------------------------------------------------
// Amostragem (secao 19)
// ---------------------------------------------------------------------------

export interface Amostragem {
  tamanhoLote: number;
  quantidadeAmostrada: number;
  percentualAmostrado: number | null;
  suficiente: boolean;
  motivo?: string;
}

/** Quanto inspecionar, conforme o tipo configurado no checklist. */
export function calcularAmostra(dados: {
  tipo: 'TOTAL' | 'AMOSTRAGEM' | 'LOTE' | 'PERCENTUAL';
  tamanhoLote: number;
  percentual: number | null;
  amostrado: number | null;
}): Amostragem {
  const exigida = dados.tipo === 'TOTAL'
    ? dados.tamanhoLote
    : dados.percentual !== null
      ? dados.tamanhoLote * (dados.percentual / 100)
      : null;

  const amostrado = dados.amostrado ?? 0;
  const percentualAmostrado = dados.tamanhoLote > 0
    ? (amostrado / dados.tamanhoLote) * 100 : null;

  if (exigida === null) {
    return {
      tamanhoLote: dados.tamanhoLote,
      quantidadeAmostrada: amostrado,
      percentualAmostrado,
      suficiente: amostrado > 0,
      motivo: amostrado > 0 ? undefined : 'Nenhuma quantidade foi amostrada',
    };
  }

  const suficiente = amostrado + 1e-9 >= exigida;
  return {
    tamanhoLote: dados.tamanhoLote,
    quantidadeAmostrada: amostrado,
    percentualAmostrado,
    suficiente,
    motivo: suficiente ? undefined
      : `Amostra de ${amostrado} abaixo do exigido (${exigida.toFixed(2)}) para ${dados.tipo}`,
  };
}

/**
 * Resultado da inspecao a partir das respostas do checklist (secao 18).
 *
 * Criterio eliminatorio reprovado reprova o lote inteiro - nao existe "media"
 * com um item eliminatorio: embalagem violada nao se compensa com peso certo.
 */
export function resultadoChecklist(
  respostas: Array<{ criterio: string; eliminatorio: boolean; resposta: string }>,
): {
  resultado: 'APROVADO' | 'APROVADO_COM_RESSALVA' | 'REPROVADO' | 'PENDENTE';
  reprovados: string[];
  eliminatoriosReprovados: string[];
  avaliados: number;
} {
  const avaliados = respostas.filter((r) => r.resposta !== 'NAO_APLICAVEL');
  if (!avaliados.length) {
    return { resultado: 'PENDENTE', reprovados: [], eliminatoriosReprovados: [], avaliados: 0 };
  }

  const reprovados = avaliados.filter((r) => r.resposta === 'REPROVADO');
  const eliminatorios = reprovados.filter((r) => r.eliminatorio);

  return {
    resultado: eliminatorios.length ? 'REPROVADO'
      : reprovados.length ? 'APROVADO_COM_RESSALVA' : 'APROVADO',
    reprovados: reprovados.map((r) => r.criterio),
    eliminatoriosReprovados: eliminatorios.map((r) => r.criterio),
    avaliados: avaliados.length,
  };
}

// ---------------------------------------------------------------------------
// Custo de entrada (secao 32)
// ---------------------------------------------------------------------------

export interface CustoEntrada {
  precoUnitario: number;
  descontoUnitario: number;
  freteUnitario: number;
  impostosUnitario: number;
  outrosUnitario: number;
  custoUnitario: number;
  memoria: Record<string, unknown>;
}

/**
 * Custo unitario de entrada. Frete e impostos vem rateados do item do pedido
 * (modulo 07 ja fez esse rateio), entao aqui so se divide pela quantidade
 * que realmente entrou - e nao pela quantidade pedida, senao o custo do que
 * chegou ficaria diluido pelo que nao chegou.
 */
export function calcularCustoEntrada(dados: {
  quantidadeEntrando: number;
  precoUnitario: number;
  descontoTotal: number;
  freteRateado: number;
  impostosRateados: number;
  outrosCustos: number;
  incluirFrete: boolean;
  incluirImpostos: boolean;
  taxaCambio: number | null;
}): CustoEntrada {
  const qtd = dados.quantidadeEntrando > 0 ? dados.quantidadeEntrando : 1;
  const cambio = dados.taxaCambio && dados.taxaCambio > 0 ? dados.taxaCambio : 1;

  const desconto = dados.descontoTotal / qtd;
  const frete = dados.incluirFrete ? dados.freteRateado / qtd : 0;
  const impostos = dados.incluirImpostos ? dados.impostosRateados / qtd : 0;
  const outros = dados.outrosCustos / qtd;

  const custo = (dados.precoUnitario - desconto + frete + impostos + outros) * cambio;

  return {
    precoUnitario: dados.precoUnitario,
    descontoUnitario: desconto,
    freteUnitario: frete,
    impostosUnitario: impostos,
    outrosUnitario: outros,
    custoUnitario: custo,
    memoria: {
      regra: 'custo = (preco - desconto + frete + impostos + outros) x cambio, tudo por unidade recebida',
      quantidade_base: qtd,
      frete_incluido: dados.incluirFrete,
      impostos_incluidos: dados.incluirImpostos,
      taxa_cambio: cambio,
    },
  };
}

/** Custo medio ponderado, a regra que o modulo 03 ja usa. */
export function custoMedioPonderado(
  saldoAtual: number, custoAtual: number, quantidadeEntrando: number, custoEntrada: number,
): number {
  const total = saldoAtual + quantidadeEntrando;
  if (total <= 0) return custoEntrada;
  if (saldoAtual <= 0) return custoEntrada;
  return (saldoAtual * custoAtual + quantidadeEntrando * custoEntrada) / total;
}

// ---------------------------------------------------------------------------
// Destino do item (secoes 30, 33 e 58)
// ---------------------------------------------------------------------------

export type Destino = 'DISPONIVEL' | 'QUARENTENA' | 'BLOQUEADO' | 'AREA_RECEBIMENTO' | 'RECUSADO';

export interface DecisaoDestino {
  destino: Destino;
  quantidadeAceita: number;
  quantidadeQuarentena: number;
  quantidadeRejeitada: number;
  motivos: string[];
}

/**
 * Para onde vai cada parte do que chegou.
 *
 * Regras 4 e 5 da secao 58: produto reprovado nao entra como disponivel e
 * produto em quarentena nao conta como disponivel. Aqui isso vira uma
 * separacao explicita de quantidades, para que a movimentacao de estoque
 * saiba exatamente o que creditar em cada bucket.
 */
export function decidirDestino(dados: {
  quantidadeRecebida: number;
  resultadoQualidade: string | null;
  quantidadeAprovadaQualidade: number | null;
  quantidadeReprovadaQualidade: number | null;
  quantidadeQuarentenaQualidade: number | null;
  validade: AvaliacaoValidade;
  exigeLote: boolean;
  loteInformado: boolean;
  destinoPadrao: Destino;
  excecaoValidadeAutorizada: boolean;
}): DecisaoDestino {
  const motivos: string[] = [];
  const total = dados.quantidadeRecebida;

  if (dados.exigeLote && !dados.loteInformado) {
    motivos.push('Produto controlado por lote sem lote informado');
    return {
      destino: 'AREA_RECEBIMENTO',
      quantidadeAceita: 0, quantidadeQuarentena: 0, quantidadeRejeitada: 0,
      motivos,
    };
  }

  if (dados.validade.situacao === 'VENCIDO') {
    motivos.push('Produto vencido');
    return {
      destino: 'RECUSADO',
      quantidadeAceita: 0, quantidadeQuarentena: 0, quantidadeRejeitada: total,
      motivos,
    };
  }

  if (dados.validade.situacao === 'INSUFICIENTE' && !dados.excecaoValidadeAutorizada) {
    motivos.push(
      `Vida util de ${dados.validade.vidaUtilRestantePercentual?.toFixed(2)}% abaixo do minimo`
      + ` de ${dados.validade.minimoExigidoPercentual}%`);
    return {
      destino: 'QUARENTENA',
      quantidadeAceita: 0, quantidadeQuarentena: total, quantidadeRejeitada: 0,
      motivos,
    };
  }
  if (dados.validade.situacao === 'INSUFICIENTE') {
    motivos.push('Vida util abaixo do minimo, liberada por excecao autorizada');
  }

  switch (dados.resultadoQualidade) {
    case 'REPROVADO':
      motivos.push('Reprovado na inspecao de qualidade');
      return {
        destino: 'RECUSADO',
        quantidadeAceita: 0, quantidadeQuarentena: 0, quantidadeRejeitada: total,
        motivos,
      };

    case 'QUARENTENA':
      motivos.push('Retido em quarentena pela inspecao');
      return {
        destino: 'QUARENTENA',
        quantidadeAceita: 0, quantidadeQuarentena: total, quantidadeRejeitada: 0,
        motivos,
      };

    case 'APROVADO_COM_RESSALVA': {
      // A inspecao pode aprovar parte e reprovar parte do mesmo lote.
      const reprovada = dados.quantidadeReprovadaQualidade ?? 0;
      const quarentena = dados.quantidadeQuarentenaQualidade ?? 0;
      const aceita = Math.max(0, total - reprovada - quarentena);
      motivos.push('Aprovado com ressalva na inspecao');
      return {
        destino: aceita > 0 ? dados.destinoPadrao : quarentena > 0 ? 'QUARENTENA' : 'RECUSADO',
        quantidadeAceita: aceita,
        quantidadeQuarentena: quarentena,
        quantidadeRejeitada: reprovada,
        motivos,
      };
    }

    default:
      return {
        destino: dados.destinoPadrao,
        quantidadeAceita: total, quantidadeQuarentena: 0, quantidadeRejeitada: 0,
        motivos,
      };
  }
}

// ---------------------------------------------------------------------------
// Indicadores (secao 37)
// ---------------------------------------------------------------------------

export interface IndicadoresRecebimento {
  total: number;
  aprovados: number;
  aprovadosParcialmente: number;
  rejeitados: number;
  comDivergencia: number;
  taxaAprovacao: number | null;
  taxaDivergencia: number | null;
  taxaRejeicao: number | null;
  tempoMedioRecebimentoHoras: number | null;
  tempoMedioConferenciaHoras: number | null;
  formula: Record<string, string>;
}

export function calcularIndicadores(
  linhas: Array<{
    status: string;
    temDivergencia: boolean;
    chegadaEm: string | null;
    concluidoEm: string | null;
    conferenciaInicio: string | null;
    conferenciaFim: string | null;
  }>,
): IndicadoresRecebimento {
  const total = linhas.length;
  const proporcao = (n: number) => (total > 0 ? (n / total) * 100 : null);

  const horas = (de: string | null, ate: string | null): number | null =>
    de && ate ? (Date.parse(ate) - Date.parse(de)) / 3600000 : null;

  const media = (valores: Array<number | null>) => {
    const validos = valores.filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0);
    return validos.length ? validos.reduce((a, v) => a + v, 0) / validos.length : null;
  };

  const aprovados = linhas.filter((l) => l.status === 'APROVADO').length;
  const parciais = linhas.filter((l) => l.status === 'APROVADO_PARCIALMENTE').length;
  const rejeitados = linhas.filter((l) => l.status === 'REJEITADO').length;

  return {
    total,
    aprovados,
    aprovadosParcialmente: parciais,
    rejeitados,
    comDivergencia: linhas.filter((l) => l.temDivergencia).length,
    taxaAprovacao: proporcao(aprovados),
    taxaDivergencia: proporcao(linhas.filter((l) => l.temDivergencia).length),
    taxaRejeicao: proporcao(rejeitados),
    tempoMedioRecebimentoHoras: media(linhas.map((l) => horas(l.chegadaEm, l.concluidoEm))),
    tempoMedioConferenciaHoras: media(
      linhas.map((l) => horas(l.conferenciaInicio, l.conferenciaFim))),
    formula: {
      taxa_aprovacao: 'recebimentos aprovados / total de recebimentos x 100',
      taxa_divergencia: 'recebimentos com divergencia / total de recebimentos x 100',
      taxa_rejeicao: 'recebimentos rejeitados / total de recebimentos x 100',
      tempo_recebimento: 'conclusao menos chegada, em horas',
      tempo_conferencia: 'fim da conferencia menos inicio da conferencia, em horas',
    },
  };
}
