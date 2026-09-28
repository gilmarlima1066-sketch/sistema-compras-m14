/**
 * Matematica do acompanhamento logistico.
 *
 * Puro de proposito: atraso, semaforo, lead time, OTD, In Full, OTIF, ETA,
 * risco de ruptura e impacto moram aqui, sem banco e sem request. A secao 79
 * do PROMPT 08 exige que todo indicador mostre a formula, o periodo e a base;
 * isso so e possivel se a conta estiver num lugar so, com a memoria do
 * calculo saindo junto do numero.
 *
 * Regra que atravessa o arquivo inteiro (secoes 24, 45 e 76): quando falta
 * dado, a resposta e `null` com um motivo - nunca um numero inventado.
 */

const DIA = 86400000;

/** Data em UTC puro: a comparacao e por dia de calendario, nao por instante. */
const dia = (valor: string | Date): number => {
  const d = typeof valor === 'string' ? new Date(`${valor.slice(0, 10)}T00:00:00Z`) : valor;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export const diferencaDias = (de: string | Date | null, ate: string | Date | null): number | null =>
  de === null || ate === null ? null : Math.round((dia(ate) - dia(de)) / DIA);

export const somarDias = (data: string, dias: number): string =>
  new Date(dia(data) + dias * DIA).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Atraso (secoes 14, 15 e 28)
// ---------------------------------------------------------------------------

export interface Atraso {
  /** Atraso JA incorrido contra a promessa do fornecedor. Positivo = atrasado. */
  contraPromessa: number | null;
  /** Atraso ja incorrido contra a necessidade interna do planejamento. */
  contraNecessidade: number | null;
  /** Qual data serviu de referencia: a entrega real ou hoje. */
  base: 'EFETIVA' | 'HOJE' | 'SEM_DADOS';
  dataAvaliada: string | null;
  atrasado: boolean;
  classificacao: 'NO_PRAZO' | 'LEVE' | 'MODERADO' | 'ALTO' | 'CRITICO' | 'SEM_DADOS';
  /**
   * O que a previsao aponta, se a entrega ainda nao aconteceu. E projecao, nao
   * fato: um pedido com promessa vencida ha 2 dias e ETA daqui a 6 esta
   * atrasado em 2 dias HOJE e caminha para 8 - e as duas leituras importam
   * para decidir o que fazer.
   */
  projetado: {
    contraPromessa: number | null;
    contraNecessidade: number | null;
    dataPrevista: string | null;
  } | null;
}

export interface FaixasAtraso {
  leveAte: number;
  moderadoAte: number;
  altoAte: number;
}

export function classificarAtraso(dias: number | null, faixas: FaixasAtraso): Atraso['classificacao'] {
  if (dias === null) return 'SEM_DADOS';
  if (dias <= 0) return 'NO_PRAZO';
  if (dias <= faixas.leveAte) return 'LEVE';
  if (dias <= faixas.moderadoAte) return 'MODERADO';
  if (dias <= faixas.altoAte) return 'ALTO';
  return 'CRITICO';
}

/**
 * O atraso do fornecedor e o impacto interno sao coisas diferentes (secao 15):
 * entregar 12/10 quando prometeu 12/10 nao e atraso dele, mas se a necessidade
 * era 10/10 o impacto interno existe do mesmo jeito.
 *
 * Enquanto a entrega nao aconteceu, a data avaliada e a prevista, ou hoje se
 * nao houver previsao - um pedido vencido sem ETA ja esta atrasado hoje.
 */
export function calcularAtraso(dados: {
  dataPrometida: string | null;
  dataNecessaria: string | null;
  dataEfetiva: string | null;
  dataPrevista: string | null;
  hoje: string;
  faixas: FaixasAtraso;
}): Atraso {
  if (!dados.dataPrometida && !dados.dataNecessaria) {
    return {
      contraPromessa: null, contraNecessidade: null, base: 'SEM_DADOS',
      dataAvaliada: null, atrasado: false, classificacao: 'SEM_DADOS', projetado: null,
    };
  }

  // Secao 14: o atraso e medido contra a DATA ATUAL enquanto nao ha entrega.
  // Usar a previsao aqui contaria como atraso de hoje um dia que ainda nao
  // chegou.
  const base: Atraso['base'] = dados.dataEfetiva ? 'EFETIVA' : 'HOJE';
  const avaliada = dados.dataEfetiva ?? dados.hoje;

  const contraPromessa = dados.dataPrometida === null
    ? null : diferencaDias(dados.dataPrometida, avaliada);
  const contraNecessidade = dados.dataNecessaria === null
    ? null : diferencaDias(dados.dataNecessaria, avaliada);

  const referencia = contraPromessa ?? contraNecessidade;

  // A projecao so existe enquanto a entrega nao aconteceu e ha previsao a
  // frente de hoje; previsao ja vencida nao projeta nada, ela virou o proprio
  // atraso corrente.
  const projeta = !dados.dataEfetiva && dados.dataPrevista !== null
    && diferencaDias(dados.hoje, dados.dataPrevista)! > 0;

  return {
    contraPromessa,
    contraNecessidade,
    base,
    dataAvaliada: avaliada,
    atrasado: referencia !== null && referencia > 0,
    classificacao: classificarAtraso(referencia, dados.faixas),
    projetado: projeta ? {
      contraPromessa: dados.dataPrometida === null
        ? null : diferencaDias(dados.dataPrometida, dados.dataPrevista!),
      contraNecessidade: dados.dataNecessaria === null
        ? null : diferencaDias(dados.dataNecessaria, dados.dataPrevista!),
      dataPrevista: dados.dataPrevista,
    } : null,
  };
}

// ---------------------------------------------------------------------------
// Saldo do pedido (secoes 10, 17 e 18)
// ---------------------------------------------------------------------------

export interface Saldo {
  pedida: number;
  confirmada: number;
  entregue: number;
  recebida: number;
  /** O que o fornecedor ainda nao confirmou. */
  pendenteConfirmacao: number;
  /** O que ainda nao chegou. */
  pendenteEntrega: number;
  percentualAtendido: number;
  percentualPendente: number;
  statusConfirmacao: 'NAO_CONFIRMADO' | 'CONFIRMADO' | 'CONFIRMADO_PARCIALMENTE' | 'RECUSADO';
  completo: boolean;
}

/** Confirmado nao e recebido (secao 18): as quatro quantidades andam separadas. */
export function calcularSaldo(dados: {
  pedida: number;
  confirmada: number | null;
  entregue: number;
  recebida: number;
  recusado?: boolean;
}): Saldo {
  const confirmada = dados.confirmada ?? 0;
  const pendenteConfirmacao = Math.max(0, dados.pedida - confirmada);
  const pendenteEntrega = Math.max(0, dados.pedida - dados.entregue);

  let statusConfirmacao: Saldo['statusConfirmacao'];
  if (dados.recusado) statusConfirmacao = 'RECUSADO';
  else if (dados.confirmada === null || confirmada === 0) statusConfirmacao = 'NAO_CONFIRMADO';
  else if (confirmada >= dados.pedida) statusConfirmacao = 'CONFIRMADO';
  else statusConfirmacao = 'CONFIRMADO_PARCIALMENTE';

  return {
    pedida: dados.pedida,
    confirmada,
    entregue: dados.entregue,
    recebida: dados.recebida,
    pendenteConfirmacao,
    pendenteEntrega,
    percentualAtendido: dados.pedida > 0 ? (dados.entregue / dados.pedida) * 100 : 0,
    percentualPendente: dados.pedida > 0 ? (pendenteEntrega / dados.pedida) * 100 : 0,
    statusConfirmacao,
    completo: pendenteEntrega <= 0,
  };
}

// ---------------------------------------------------------------------------
// Lead time (secao 36)
// ---------------------------------------------------------------------------

export interface LeadTime {
  contratado: number | null;
  real: number | null;
  desvio: number | null;
}

export function calcularLeadTime(dados: {
  dataPedido: string | null;
  dataPrometida: string | null;
  dataEfetiva: string | null;
}): LeadTime {
  const contratado = diferencaDias(dados.dataPedido, dados.dataPrometida);
  const real = diferencaDias(dados.dataPedido, dados.dataEfetiva);
  return {
    contratado,
    real,
    desvio: contratado !== null && real !== null ? real - contratado : null,
  };
}

/** Media, mediana, minimo, maximo e desvio-padrao (secao 43). */
export function estatisticas(valores: number[]) {
  const limpos = valores.filter((v) => Number.isFinite(v));
  if (!limpos.length) {
    return { n: 0, media: null, mediana: null, minimo: null, maximo: null, desvio: null };
  }
  const ordenados = [...limpos].sort((a, b) => a - b);
  const media = limpos.reduce((a, v) => a + v, 0) / limpos.length;
  const meio = Math.floor(ordenados.length / 2);
  const mediana = ordenados.length % 2
    ? ordenados[meio]!
    : (ordenados[meio - 1]! + ordenados[meio]!) / 2;
  const variancia = limpos.reduce((a, v) => a + (v - media) ** 2, 0) / limpos.length;
  return {
    n: limpos.length,
    media,
    mediana,
    minimo: ordenados[0]!,
    maximo: ordenados[ordenados.length - 1]!,
    desvio: Math.sqrt(variancia),
  };
}

// ---------------------------------------------------------------------------
// OTD, In Full e OTIF (secoes 37, 38, 39 e 82)
// ---------------------------------------------------------------------------

export interface RegraOtif {
  /** Contra qual data se mede pontualidade. */
  referencia: 'DATA_PROMETIDA' | 'DATA_NECESSARIA';
  toleranciaDias: number;
  toleranciaQuantidadePercentual: number;
  unidade: 'ITEM' | 'PEDIDO';
}

export interface LinhaOtif {
  dataReferencia: string | null;
  dataEfetiva: string | null;
  quantidadeEsperada: number;
  quantidadeEntregue: number;
}

export interface AvaliacaoOtif {
  avaliavel: boolean;
  motivo?: string;
  noPrazo: boolean | null;
  integral: boolean | null;
  otif: boolean | null;
  diasAtraso: number | null;
  percentualAtendido: number | null;
}

/**
 * Uma entrega so entra no indicador quando ha data de referencia E data
 * efetiva. Sem isso ela nao e "nao OTIF" - ela e nao avaliavel, e contar
 * como falha puniria o fornecedor por falta de cadastro nosso (secao 76).
 */
export function avaliarOtif(linha: LinhaOtif, regra: RegraOtif): AvaliacaoOtif {
  if (!linha.dataEfetiva) {
    return {
      avaliavel: false, motivo: 'Entrega ainda nao realizada',
      noPrazo: null, integral: null, otif: null, diasAtraso: null,
      percentualAtendido: linha.quantidadeEsperada > 0
        ? (linha.quantidadeEntregue / linha.quantidadeEsperada) * 100 : null,
    };
  }
  if (!linha.dataReferencia) {
    return {
      avaliavel: false, motivo: `Entrega sem ${regra.referencia === 'DATA_PROMETIDA' ? 'data prometida' : 'data necessaria'}`,
      noPrazo: null, integral: null, otif: null, diasAtraso: null,
      percentualAtendido: linha.quantidadeEsperada > 0
        ? (linha.quantidadeEntregue / linha.quantidadeEsperada) * 100 : null,
    };
  }

  const diasAtraso = diferencaDias(linha.dataReferencia, linha.dataEfetiva)!;
  const noPrazo = diasAtraso <= regra.toleranciaDias;

  const minimo = linha.quantidadeEsperada * (1 - regra.toleranciaQuantidadePercentual / 100);
  const integral = linha.quantidadeEsperada <= 0 || linha.quantidadeEntregue >= minimo;

  return {
    avaliavel: true,
    noPrazo,
    integral,
    otif: noPrazo && integral,
    diasAtraso,
    percentualAtendido: linha.quantidadeEsperada > 0
      ? (linha.quantidadeEntregue / linha.quantidadeEsperada) * 100 : null,
  };
}

export interface Indicadores {
  avaliadas: number;
  ignoradas: number;
  otd: number | null;
  inFull: number | null;
  otif: number | null;
  atrasoMedio: number | null;
  atrasoMaximo: number | null;
  amostraSuficiente: boolean;
  regra: RegraOtif;
  formula: { otd: string; inFull: string; otif: string };
}

/**
 * Agrega as linhas em OTD, In Full e OTIF. Devolve a regra usada junto dos
 * numeros porque a secao 82 proibe comparar fornecedores sem deixar explicito
 * periodo, metodologia e tolerancia.
 */
export function calcularIndicadores(
  linhas: LinhaOtif[], regra: RegraOtif, minimoEntregas = 5,
): Indicadores {
  const avaliacoes = linhas.map((l) => avaliarOtif(l, regra));
  const validas = avaliacoes.filter((a) => a.avaliavel);
  const n = validas.length;

  const atrasos = validas.map((a) => Math.max(0, a.diasAtraso ?? 0));
  const est = estatisticas(atrasos);

  const proporcao = (quantos: number) => (n > 0 ? (quantos / n) * 100 : null);

  return {
    avaliadas: n,
    ignoradas: avaliacoes.length - n,
    otd: proporcao(validas.filter((a) => a.noPrazo).length),
    inFull: proporcao(validas.filter((a) => a.integral).length),
    otif: proporcao(validas.filter((a) => a.otif).length),
    atrasoMedio: est.media,
    atrasoMaximo: est.maximo,
    amostraSuficiente: n >= minimoEntregas,
    regra,
    formula: {
      otd: `entregas com atraso <= ${regra.toleranciaDias}d contra ${regra.referencia} / entregas avaliadas`,
      inFull: `entregas com quantidade >= ${100 - regra.toleranciaQuantidadePercentual}% do esperado / entregas avaliadas`,
      otif: 'entregas no prazo E integrais / entregas avaliadas',
    },
  };
}

// ---------------------------------------------------------------------------
// ETA (secoes 44, 45 e 46)
// ---------------------------------------------------------------------------

export type FonteEta =
  | 'DATA_PROMETIDA' | 'TRANSPORTE' | 'LEAD_TIME_HISTORICO'
  | 'LEAD_TIME_CONTRATADO' | 'INFORMADA_FORNECEDOR' | 'MANUAL';

export interface Eta {
  eta: string | null;
  fonte: FonteEta | null;
  confianca: 'ALTA' | 'MEDIA' | 'BAIXA' | 'SEM_DADOS';
  memoria: Record<string, unknown>;
}

/**
 * Calcula a ETA pela melhor evidencia disponivel, em ordem de qualidade:
 * transporte em curso > promessa do fornecedor > lead time historico dele >
 * lead time contratado. Sem nenhuma dessas, a resposta e SEM_DADOS com ETA
 * nula - a secao 44 proibe apresentar estimativa como certeza e a 76 proibe
 * inventar data.
 */
export function calcularEta(dados: {
  dataPrometida: string | null;
  dataConfirmacao: string | null;
  dataEmissao: string | null;
  statusLogistico: string | null;
  transporteDataPrevista: string | null;
  transporteDataColeta: string | null;
  leadTimeHistoricoMedio: number | null;
  leadTimeHistoricoEntregas: number;
  leadTimeContratado: number | null;
  minimoEntregasHistorico: number;
  hoje: string;
}): Eta {
  const emTransito = ['EXPEDIDO', 'EM_TRANSITO', 'CHEGOU_DESTINO'].includes(
    dados.statusLogistico ?? '');

  if (dados.transporteDataPrevista && emTransito) {
    return {
      eta: dados.transporteDataPrevista,
      fonte: 'TRANSPORTE',
      confianca: 'ALTA',
      memoria: {
        regra: 'Data prevista informada pelo transporte, com a carga ja expedida',
        status_logistico: dados.statusLogistico,
        data_coleta: dados.transporteDataColeta,
      },
    };
  }

  if (dados.transporteDataPrevista) {
    return {
      eta: dados.transporteDataPrevista,
      fonte: 'TRANSPORTE',
      confianca: 'MEDIA',
      memoria: {
        regra: 'Data prevista do transporte, mas a carga ainda nao foi expedida',
        status_logistico: dados.statusLogistico,
      },
    };
  }

  if (dados.dataPrometida) {
    // A promessa vale mais quando o fornecedor confirmou o pedido.
    const confirmado = dados.dataConfirmacao !== null;
    const historicoRuim = dados.leadTimeHistoricoEntregas >= dados.minimoEntregasHistorico
      && (dados.leadTimeHistoricoMedio ?? 0) > (dados.leadTimeContratado ?? 0);

    // Historico do fornecedor pior que o contratado: a promessa dele sozinha
    // ja se mostrou otimista, entao a ETA leva o desvio medio junto.
    if (historicoRuim && dados.leadTimeContratado !== null) {
      const desvio = Math.round((dados.leadTimeHistoricoMedio ?? 0) - dados.leadTimeContratado);
      return {
        eta: somarDias(dados.dataPrometida, desvio),
        fonte: 'LEAD_TIME_HISTORICO',
        confianca: 'MEDIA',
        memoria: {
          regra: 'Promessa do fornecedor ajustada pelo desvio medio historico dele',
          data_prometida: dados.dataPrometida,
          lead_time_contratado: dados.leadTimeContratado,
          lead_time_historico_medio: dados.leadTimeHistoricoMedio,
          entregas_no_historico: dados.leadTimeHistoricoEntregas,
          desvio_aplicado_dias: desvio,
        },
      };
    }

    return {
      eta: dados.dataPrometida,
      fonte: 'DATA_PROMETIDA',
      confianca: confirmado ? 'ALTA' : 'MEDIA',
      memoria: {
        regra: confirmado
          ? 'Data prometida pelo fornecedor, com o pedido confirmado'
          : 'Data prometida no pedido, ainda sem confirmacao do fornecedor',
        data_confirmacao: dados.dataConfirmacao,
      },
    };
  }

  const base = dados.dataConfirmacao ?? dados.dataEmissao;
  if (base && dados.leadTimeHistoricoEntregas >= dados.minimoEntregasHistorico
      && dados.leadTimeHistoricoMedio !== null) {
    return {
      eta: somarDias(base, Math.round(dados.leadTimeHistoricoMedio)),
      fonte: 'LEAD_TIME_HISTORICO',
      confianca: 'BAIXA',
      memoria: {
        regra: 'Sem promessa: lead time medio historico do fornecedor sobre a data base',
        data_base: base,
        lead_time_historico_medio: dados.leadTimeHistoricoMedio,
        entregas_no_historico: dados.leadTimeHistoricoEntregas,
      },
    };
  }

  if (base && dados.leadTimeContratado !== null) {
    return {
      eta: somarDias(base, dados.leadTimeContratado),
      fonte: 'LEAD_TIME_CONTRATADO',
      confianca: 'BAIXA',
      memoria: {
        regra: 'Sem promessa e sem historico: lead time padrao do fornecedor',
        data_base: base,
        lead_time_contratado: dados.leadTimeContratado,
      },
    };
  }

  return {
    eta: null,
    fonte: null,
    confianca: 'SEM_DADOS',
    memoria: { regra: 'Sem promessa, sem transporte, sem historico e sem lead time contratado' },
  };
}

// ---------------------------------------------------------------------------
// Risco de ruptura e impacto (secoes 23, 24 e 25)
// ---------------------------------------------------------------------------

export interface RiscoRuptura {
  calculavel: boolean;
  motivo?: string;
  coberturaDias: number | null;
  dataProvavelRuptura: string | null;
  diasAteChegada: number | null;
  /** A chegada resolve antes da ruptura? */
  chegaATempo: boolean | null;
  nivel: 'SEM_RISCO' | 'BAIXO' | 'MEDIO' | 'ALTO' | 'CRITICO' | 'NAO_CALCULAVEL';
  memoria: Record<string, unknown>;
}

export interface FaixasRuptura {
  criticaAte: number;
  altaAte: number;
  mediaAte: number;
}

/**
 * Risco de ruptura do produto de um pedido atrasado ou em risco.
 *
 * O estoque em transito NAO entra na posicao: justamente o que esta atrasado
 * costuma estar contado ali, e somar isso esconderia a ruptura que estamos
 * tentando enxergar. Ele entra pela data de chegada, comparada com a data de
 * ruptura (secao 24).
 */
export function calcularRiscoRuptura(dados: {
  estoqueDisponivel: number;
  estoqueReservado: number;
  demandaDiaria: number | null;
  quantidadePendente: number;
  dataPrevistaChegada: string | null;
  hoje: string;
  faixas: FaixasRuptura;
}): RiscoRuptura {
  const posicao = dados.estoqueDisponivel;

  if (dados.demandaDiaria === null || dados.demandaDiaria <= 0) {
    return {
      calculavel: false,
      motivo: 'Produto sem demanda media apurada no periodo',
      coberturaDias: null, dataProvavelRuptura: null, diasAteChegada: null,
      chegaATempo: null, nivel: 'NAO_CALCULAVEL',
      memoria: {
        regra: 'Cobertura = estoque disponivel / demanda media diaria',
        estoque_disponivel: posicao,
        demanda_diaria: dados.demandaDiaria,
      },
    };
  }

  const cobertura = posicao / dados.demandaDiaria;
  const dataRuptura = somarDias(dados.hoje, Math.floor(cobertura));
  const diasAteChegada = diferencaDias(dados.hoje, dados.dataPrevistaChegada);
  const chegaATempo = diasAteChegada === null ? null : diasAteChegada <= cobertura;

  let nivel: RiscoRuptura['nivel'];
  if (dados.quantidadePendente <= 0) nivel = 'SEM_RISCO';
  else if (chegaATempo === true) nivel = 'BAIXO';
  else if (cobertura <= dados.faixas.criticaAte) nivel = 'CRITICO';
  else if (cobertura <= dados.faixas.altaAte) nivel = 'ALTO';
  else if (cobertura <= dados.faixas.mediaAte) nivel = 'MEDIO';
  else nivel = 'BAIXO';

  return {
    calculavel: true,
    coberturaDias: cobertura,
    dataProvavelRuptura: dataRuptura,
    diasAteChegada,
    chegaATempo,
    nivel,
    memoria: {
      regra: 'Cobertura = estoque disponivel / demanda media diaria; transito entra pela data de chegada, nao pela posicao',
      estoque_disponivel: posicao,
      estoque_reservado: dados.estoqueReservado,
      demanda_diaria: dados.demandaDiaria,
      quantidade_pendente: dados.quantidadePendente,
      data_prevista_chegada: dados.dataPrevistaChegada,
    },
  };
}

export type Impacto = 'BAIXO' | 'MEDIO' | 'ALTO' | 'CRITICO' | 'SEM_DADOS';

/**
 * Impacto do atraso (secao 25). Combina risco de ruptura com a importancia do
 * produto: um item A que vai romper e critico; um item C com cobertura folgada
 * nao e, por mais dias de atraso que tenha.
 */
export function classificarImpacto(dados: {
  risco: RiscoRuptura['nivel'];
  classificacaoAbc: string | null;
  quantidadePendente: number;
  valorPendente: number;
}): Impacto {
  if (dados.quantidadePendente <= 0) return 'BAIXO';
  if (dados.risco === 'NAO_CALCULAVEL') return 'SEM_DADOS';

  const importante = dados.classificacaoAbc === 'A';
  const medio = dados.classificacaoAbc === 'B';

  switch (dados.risco) {
    case 'CRITICO': return 'CRITICO';
    case 'ALTO': return importante ? 'CRITICO' : 'ALTO';
    case 'MEDIO': return importante ? 'ALTO' : medio ? 'MEDIO' : 'MEDIO';
    case 'BAIXO': return importante ? 'MEDIO' : 'BAIXO';
    default: return 'BAIXO';
  }
}

// ---------------------------------------------------------------------------
// Semaforo e matriz atraso x impacto (secoes 6 e 58)
// ---------------------------------------------------------------------------

export type Semaforo = 'VERDE' | 'AMARELO' | 'LARANJA' | 'VERMELHO' | 'CINZA';
export type SituacaoEntrega = 'NO_PRAZO' | 'EM_RISCO' | 'ATRASADO' | 'ENTREGUE' | 'SEM_DADOS';

const MATRIZ: Record<Exclude<SituacaoEntrega, 'ENTREGUE' | 'SEM_DADOS'>, Record<Impacto, Semaforo>> = {
  NO_PRAZO: { BAIXO: 'VERDE',   MEDIO: 'VERDE',    ALTO: 'AMARELO',  CRITICO: 'AMARELO',  SEM_DADOS: 'CINZA' },
  EM_RISCO: { BAIXO: 'VERDE',   MEDIO: 'AMARELO',  ALTO: 'LARANJA',  CRITICO: 'VERMELHO', SEM_DADOS: 'CINZA' },
  ATRASADO: { BAIXO: 'AMARELO', MEDIO: 'LARANJA',  ALTO: 'VERMELHO', CRITICO: 'VERMELHO', SEM_DADOS: 'AMARELO' },
};

export function semaforo(situacao: SituacaoEntrega, impacto: Impacto): Semaforo {
  if (situacao === 'ENTREGUE') return 'VERDE';
  if (situacao === 'SEM_DADOS') return 'CINZA';
  return MATRIZ[situacao][impacto];
}

export interface MotivoRisco { regra: string; detalhe: string }

export interface Situacao {
  situacao: SituacaoEntrega;
  motivos: MotivoRisco[];
  semaforo: Semaforo;
}

/**
 * Entrega em risco (secao 22). Nao e uma formula unica: e um conjunto de
 * sinais configuraveis, e o que sai junto sao os sinais que dispararam, para
 * o comprador ver POR QUE aquilo esta amarelo.
 */
export function avaliarSituacao(dados: {
  entregue: boolean;
  atraso: Atraso;
  impacto: Impacto;
  diasAteEntrega: number | null;
  confirmado: boolean;
  diasDesdeEnvio: number | null;
  alteracoesPrazo: number;
  atrasosRecentesFornecedor: number;
  semPrevisao: boolean;
  ocorrenciasAbertas: number;
  statusLogistico: string | null;
  parametros: { diasAntecedencia: number; diasSemConfirmacao: number };
}): Situacao {
  if (dados.entregue) {
    return { situacao: 'ENTREGUE', motivos: [], semaforo: semaforo('ENTREGUE', dados.impacto) };
  }

  if (dados.atraso.atrasado) {
    const motivos: MotivoRisco[] = [{
      regra: 'ATRASO',
      detalhe: `${dados.atraso.contraPromessa ?? dados.atraso.contraNecessidade} dia(s) de atraso`,
    }];
    if (dados.atraso.contraNecessidade !== null && dados.atraso.contraNecessidade > 0) {
      motivos.push({
        regra: 'IMPACTO_NECESSIDADE',
        detalhe: `${dados.atraso.contraNecessidade} dia(s) depois da data necessaria`,
      });
    }
    return { situacao: 'ATRASADO', motivos, semaforo: semaforo('ATRASADO', dados.impacto) };
  }

  const motivos: MotivoRisco[] = [];

  // Data no passado nao e "proxima": ou virou atraso (tratado acima) ou a
  // previsao esta vencida sem entrega, que e outro sinal.
  if (dados.diasAteEntrega !== null && dados.diasAteEntrega < 0) {
    motivos.push({
      regra: 'PREVISAO_VENCIDA',
      detalhe: `A previsao venceu ha ${Math.abs(dados.diasAteEntrega)} dia(s) e nada chegou`,
    });
  } else if (dados.diasAteEntrega !== null
             && dados.diasAteEntrega <= dados.parametros.diasAntecedencia) {
    motivos.push({
      regra: 'DATA_PROXIMA',
      detalhe: dados.diasAteEntrega === 0
        ? 'A entrega esta prevista para hoje'
        : `Faltam ${dados.diasAteEntrega} dia(s) para a data prevista`,
    });
  }
  if (!dados.confirmado) {
    if (dados.diasDesdeEnvio !== null && dados.diasDesdeEnvio >= dados.parametros.diasSemConfirmacao) {
      motivos.push({
        regra: 'SEM_CONFIRMACAO',
        detalhe: `Enviado ha ${dados.diasDesdeEnvio} dia(s) e o fornecedor nao confirmou`,
      });
    } else if (dados.diasAteEntrega !== null
               && dados.diasAteEntrega <= dados.parametros.diasAntecedencia) {
      motivos.push({ regra: 'SEM_CONFIRMACAO', detalhe: 'Entrega proxima e pedido nao confirmado' });
    }
  }
  if (dados.alteracoesPrazo > 0) {
    motivos.push({
      regra: 'PRAZO_ALTERADO',
      detalhe: `Fornecedor ja alterou o prazo ${dados.alteracoesPrazo} vez(es)`,
    });
  }
  if (dados.atrasosRecentesFornecedor > 0) {
    motivos.push({
      regra: 'HISTORICO_ATRASO',
      detalhe: `Fornecedor com ${dados.atrasosRecentesFornecedor} entrega(s) atrasada(s) no periodo recente`,
    });
  }
  if (dados.semPrevisao) {
    motivos.push({ regra: 'SEM_PREVISAO', detalhe: 'Pedido sem data prometida e sem ETA' });
  }
  if (dados.ocorrenciasAbertas > 0) {
    motivos.push({
      regra: 'OCORRENCIA_ABERTA',
      detalhe: `${dados.ocorrenciasAbertas} ocorrencia(s) logistica(s) em aberto`,
    });
  }
  if (dados.statusLogistico === 'AGUARDANDO_PRODUCAO'
      && dados.diasAteEntrega !== null && dados.diasAteEntrega <= dados.parametros.diasAntecedencia) {
    motivos.push({
      regra: 'TRANSPORTE_NAO_INICIADO',
      detalhe: 'Entrega proxima e a producao ainda nao comecou',
    });
  }

  if (dados.atraso.classificacao === 'SEM_DADOS' && dados.semPrevisao) {
    return { situacao: 'SEM_DADOS', motivos, semaforo: 'CINZA' };
  }

  const situacao: SituacaoEntrega = motivos.length ? 'EM_RISCO' : 'NO_PRAZO';
  return { situacao, motivos, semaforo: semaforo(situacao, dados.impacto) };
}

// ---------------------------------------------------------------------------
// Prioridade (secao 57)
// ---------------------------------------------------------------------------

export function calcularPrioridade(dados: {
  situacao: SituacaoEntrega;
  impacto: Impacto;
  risco: RiscoRuptura['nivel'];
}): 'CRITICA' | 'ALTA' | 'MEDIA' | 'BAIXA' {
  if (dados.risco === 'CRITICO' || dados.impacto === 'CRITICO') return 'CRITICA';
  if (dados.situacao === 'ATRASADO' && ['ALTO', 'MEDIO'].includes(dados.impacto)) return 'ALTA';
  if (dados.impacto === 'ALTO') return 'ALTA';
  if (dados.situacao === 'ATRASADO' || dados.impacto === 'MEDIO') return 'MEDIA';
  return 'BAIXA';
}

// ---------------------------------------------------------------------------
// SLA de ocorrencia (secao 31)
// ---------------------------------------------------------------------------

export interface Sla {
  prazo: string | null;
  horasRestantes: number | null;
  percentualConsumido: number | null;
  situacao: 'DENTRO' | 'EM_ALERTA' | 'VENCIDO' | 'ENCERRADA' | 'SEM_SLA';
}

export function avaliarSla(dados: {
  abertura: string;
  slaHoras: number | null;
  encerramento: string | null;
  agora: string;
  percentualAlerta: number;
}): Sla {
  if (dados.slaHoras === null || dados.slaHoras <= 0) {
    return { prazo: null, horasRestantes: null, percentualConsumido: null, situacao: 'SEM_SLA' };
  }

  const abertura = new Date(dados.abertura).getTime();
  const prazoMs = abertura + dados.slaHoras * 3600000;
  const prazo = new Date(prazoMs).toISOString();

  if (dados.encerramento) {
    const fim = new Date(dados.encerramento).getTime();
    return {
      prazo,
      horasRestantes: (prazoMs - fim) / 3600000,
      percentualConsumido: ((fim - abertura) / (dados.slaHoras * 3600000)) * 100,
      situacao: 'ENCERRADA',
    };
  }

  const agora = new Date(dados.agora).getTime();
  const consumido = ((agora - abertura) / (dados.slaHoras * 3600000)) * 100;

  return {
    prazo,
    horasRestantes: (prazoMs - agora) / 3600000,
    percentualConsumido: consumido,
    situacao: consumido >= 100 ? 'VENCIDO'
      : consumido >= dados.percentualAlerta ? 'EM_ALERTA' : 'DENTRO',
  };
}
