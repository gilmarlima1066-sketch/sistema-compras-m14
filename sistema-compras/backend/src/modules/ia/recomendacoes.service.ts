/**
 * Central de recomendacoes (secoes 20, 21, 31, 32 e 36).
 *
 * Tres compromissos que o codigo abaixo respeita literalmente:
 *
 * 1. Nada de caixa-preta (secao 46). Cada recomendacao guarda congelada a
 *    conta que a gerou e as evidencias que a sustentam. Explicar depois
 *    recalculando daria outro numero - o dado terá mudado - e a explicacao
 *    deixaria de explicar a decisao que foi tomada.
 *
 * 2. A IA nao executa (secao 48). Nenhuma funcao aqui emite pedido, altera
 *    preco, bloqueia fornecedor ou mexe em estoque. Ela grava um texto e uma
 *    conta em `ia_recomendacoes`. Quem executa e o usuario, no modulo que tem
 *    a alcada para isso.
 *
 * 3. Sem base, nao recomenda (secoes 26 e 27). A porta de qualidade roda antes;
 *    produto com lacuna BLOQUEIA nao gera recomendacao, gera limitacao
 *    declarada.
 */
import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { hojeLocal } from '../../core/datas.js';
import {
  ajustarQuantidade, calcularPrioridade, diferencaDias, estimarEconomia, projetarRuptura,
} from './calculos.js';
import {
  calculo, confiancaAtende, fato, previsao,
  type Confianca, type Evidencia, type Explicacao,
} from './evidencias.js';
import { auditarProdutos, type QualidadeDados } from './qualidade.js';
import {
  confiancaProduto, lacunasCadastro, produtosEmFoco, situacaoProdutos,
  type SituacaoProduto,
} from './analise.service.js';
import type { ConfigIA } from './contexto.js';

const num = (v: unknown) => Number(v ?? 0);
const arred = (v: number, c = 2) => Math.round(v * 10 ** c) / 10 ** c;

export type TipoRecomendacao =
  | 'COMPRA' | 'ANTECIPAR_COMPRA' | 'REDUZIR_COMPRA' | 'NEGOCIACAO'
  | 'TROCA_FORNECEDOR' | 'HOMOLOGAR_ALTERNATIVA' | 'TRANSFERENCIA'
  | 'REDUZIR_EXCESSO' | 'ESCOAR_VALIDADE' | 'ACOMPANHAR_PEDIDO'
  | 'COBRAR_FORNECEDOR' | 'REVISAR_PARAMETROS' | 'REVISAR_PREVISAO'
  | 'QUALIDADE' | 'CONSOLIDAR_PEDIDOS' | 'CORRIGIR_CADASTRO';

export interface Recomendacao {
  tipo: TipoRecomendacao;
  origem: string;
  titulo: string;
  problema: string;
  recomendacao: string;
  produto_id?: number | null;
  fornecedor_id?: number | null;
  ordem_compra_id?: number | null;
  confianca: Confianca;
  impacto_estimado: number | null;
  impacto_descricao: string;
  urgencia_dias: number | null;
  evidencias: Evidencia[];
  calculo: Record<string, unknown> | null;
  premissas: string[];
  dados_usados: string[];
  explicacao: Explicacao;
  chave_dedup: string;
}

// ---------------------------------------------------------------------------
// Geradores
// ---------------------------------------------------------------------------

/**
 * Recomendacao de compra a partir do risco de ruptura (secoes 5, 10 e 19).
 *
 * A quantidade sugerida cobre a demanda do lead time mais o estoque de
 * seguranca, descontado o que ja esta disponivel e o que ja foi pedido. O
 * desconto do pedido em aberto e o que impede a recomendacao classica errada:
 * mandar comprar de novo o que ja esta a caminho.
 */
function recomendarCompra(
  s: SituacaoProduto, cfg: ConfigIA, confianca: Confianca, qualidade: QualidadeDados,
): Recomendacao | null {
  const hoje = hojeLocal();
  const chegadaDias = s.proxima_chegada ? diferencaDias(hoje, s.proxima_chegada) : null;
  const proj = projetarRuptura(s.disponivel, s.demanda_diaria, hoje, chegadaDias);

  if (proj.diasAteRuptura === null) return null;
  if (proj.diasAteRuptura > cfg.horizonteRupturaDias) return null;
  if (proj.cobertoPorPedido) return null;

  const leadTime = s.lead_time ?? 15;
  const demandaLeadTime = s.demanda_diaria * leadTime;
  const seguranca = s.estoque_seguranca > 0
    ? s.estoque_seguranca
    : s.demanda_diaria * 7;

  const bruta = demandaLeadTime + seguranca - s.disponivel - s.quantidade_pendente;
  if (bruta <= 0) return null;

  const { quantidade, ajustes } = ajustarQuantidade(bruta, null, null);
  const valor = quantidade * (s.preco_atual ?? s.custo);

  // Comprar no dia da ruptura ja e tarde: a data ideal desconta o lead time.
  const diasAteComprar = Math.max(0, (proj.diasAteRuptura ?? 0) - leadTime);
  const impactoRuptura = s.demanda_diaria * s.custo * 7;

  const evidencias: Evidencia[] = [
    fato(`Estoque disponivel de ${arred(s.disponivel, 3)}`, 'Modulo 03 - vw_estoque_atual',
      { valor: arred(s.disponivel, 3) }),
    fato(`Demanda media de ${arred(s.demanda_diaria, 3)} por dia`,
      'Modulo 04 - parametros de estoque', { valor: arred(s.demanda_diaria, 3) }),
    fato(`Lead time de ${leadTime} dias`,
      s.lead_time ? 'Modulo 02 - produto x fornecedor' : 'Padrao do sistema (nao cadastrado)',
      { valor: leadTime, unidade: 'dias' }),
    previsao(proj.jaEmRuptura
      ? 'Produto ja sem estoque disponivel'
      : `No ritmo atual o saldo acaba em ${proj.diasAteRuptura} dia(s), por volta de ${proj.dataProvavel}`,
    'Modulo 12 - projecao sobre demanda media',
    { valor: proj.diasAteRuptura, unidade: 'dias' }),
    calculo(`Necessidade de ${arred(quantidade, 3)}: demanda do lead time `
      + `(${arred(demandaLeadTime, 3)}) + seguranca (${arred(seguranca, 3)}) `
      + `- disponivel (${arred(s.disponivel, 3)}) - ja pedido (${arred(s.quantidade_pendente, 3)})`,
    'Modulo 12 - calculo de reposicao', { valor: arred(quantidade, 3) }),
  ];

  if (s.quantidade_pendente > 0) {
    evidencias.push(fato(
      `${arred(s.quantidade_pendente, 3)} ja pedido(s) em ${s.pedidos_abertos} pedido(s) em aberto`,
      'Modulo 07 - pedidos de compra', { valor: arred(s.quantidade_pendente, 3) }));
  }

  return {
    tipo: proj.diasAteRuptura <= leadTime ? 'ANTECIPAR_COMPRA' : 'COMPRA',
    origem: 'Analise de risco de ruptura',
    titulo: `Comprar ${s.codigo} - ${s.descricao}`,
    problema: proj.jaEmRuptura
      ? `Produto sem estoque disponivel e com demanda de ${arred(s.demanda_diaria, 2)} por dia`
      : `Estoque projetado para acabar em ${proj.diasAteRuptura} dia(s), `
        + `com lead time de ${leadTime} dias`,
    recomendacao: `Comprar ${arred(quantidade, 3)} unidade(s)`
      + (diasAteComprar === 0 ? ' com urgencia' : ` nos proximos ${diasAteComprar} dia(s)`)
      + (ajustes.length ? ` (${ajustes.join('; ')})` : ''),
    produto_id: s.produto_id,
    confianca,
    impacto_estimado: arred(impactoRuptura),
    impacto_descricao: `Cada semana sem estoque deixa de atender cerca de `
      + `${arred(impactoRuptura)} em demanda valorizada`,
    urgencia_dias: diasAteComprar,
    evidencias,
    calculo: {
      demanda_lead_time: arred(demandaLeadTime, 3),
      estoque_seguranca: arred(seguranca, 3),
      disponivel: arred(s.disponivel, 3),
      ja_pedido: arred(s.quantidade_pendente, 3),
      quantidade_sugerida: arred(quantidade, 3),
      valor_estimado: arred(valor),
      lead_time_dias: leadTime,
      dias_ate_ruptura: proj.diasAteRuptura,
      data_ideal_compra: proj.dataProvavel,
      formula: 'demanda x lead time + estoque de seguranca - disponivel - ja pedido',
    },
    premissas: [
      'A demanda se mantem no ritmo medio apurado',
      s.lead_time ? 'O lead time cadastrado sera cumprido'
        : 'Lead time nao cadastrado: usado o padrao de 15 dias',
      'Os pedidos em aberto chegarao nas datas prometidas',
    ],
    dados_usados: ['vw_estoque_atual', 'parametros_estoque', 'produto_fornecedor',
      'ordem_compra_itens', 'produtos'],
    explicacao: {
      o_que_aconteceu: proj.jaEmRuptura
        ? `${s.descricao} esta sem estoque disponivel.`
        : `${s.descricao} tem ${arred(s.disponivel, 2)} em estoque para uma demanda de `
          + `${arred(s.demanda_diaria, 2)} por dia.`,
      por_que_aconteceu: s.pedidos_atrasados > 0
        ? `Ha ${s.pedidos_atrasados} pedido(s) com promessa de entrega vencida.`
        : s.pedidos_abertos === 0
          ? 'Nao ha pedido de compra em aberto para este produto.'
          : 'O consumo avancou mais rapido que a reposicao programada.',
      qual_o_impacto: `Cerca de ${arred(impactoRuptura)} por semana em demanda nao atendida, `
        + `considerando o custo de referencia de ${arred(s.custo)}.`,
      o_que_pode_acontecer: proj.jaEmRuptura
        ? 'A falta continua enquanto nao houver reposicao.'
        : `Sem compra, a falta comeca por volta de ${proj.dataProvavel}.`,
      o_que_recomendo: `Comprar ${arred(quantidade, 3)} unidade(s)`
        + (diasAteComprar === 0 ? ' com urgencia.' : ` ate ${diasAteComprar} dia(s).`),
      quais_dados_foram_utilizados: [
        'Posicao de estoque (modulo 03)',
        'Demanda media diaria (modulo 04)',
        'Lead time do fornecedor (modulo 02)',
        'Pedidos em aberto (modulo 07)',
        qualidade.limitacao ? `Limitacao: ${qualidade.limitacao}` : 'Cadastro completo',
      ],
    },
    chave_dedup: `COMPRA:${s.produto_id}`,
  };
}

/** Excesso de estoque parado (secoes 6 e 32). */
function recomendarExcesso(
  s: SituacaoProduto, cfg: ConfigIA, confianca: Confianca,
): Recomendacao | null {
  const maximoPorCobertura = s.demanda_diaria > 0 ? s.demanda_diaria * 90 : null;
  const maximoCadastro = s.estoque_maximo > 0 ? s.estoque_maximo : null;
  const maximo = maximoPorCobertura !== null && maximoCadastro !== null
    ? Math.min(maximoPorCobertura, maximoCadastro)
    : maximoPorCobertura ?? maximoCadastro;

  if (maximo === null || s.disponivel <= maximo) return null;

  const excedente = s.disponivel - maximo;
  const valorParado = excedente * s.custo;
  if (valorParado < cfg.economiaMinima) return null;

  const economia = estimarEconomia(
    valorParado, 0,
    ['O excedente e escoavel pelos canais atuais',
      'O custo de referencia reflete o valor imobilizado'],
    `excedente (${arred(excedente, 3)}) x custo de referencia (${arred(s.custo)})`);

  const criterio = maximoPorCobertura !== null && maximo === maximoPorCobertura
    ? 'cobertura maxima de 90 dias' : 'estoque maximo cadastrado';

  return {
    tipo: 'REDUZIR_EXCESSO',
    origem: 'Analise de excesso de estoque',
    titulo: `Excesso de ${s.codigo} - ${s.descricao}`,
    problema: `Estoque de ${arred(s.disponivel, 3)} contra maximo aceitavel de `
      + `${arred(maximo, 3)} pelo criterio de ${criterio}`,
    recomendacao: `Suspender novas compras e escoar ${arred(excedente, 3)} unidade(s) `
      + 'antes de repor',
    produto_id: s.produto_id,
    confianca,
    impacto_estimado: arred(valorParado),
    impacto_descricao: `${arred(valorParado)} imobilizados acima do necessario`,
    urgencia_dias: null,
    evidencias: [
      fato(`Estoque disponivel de ${arred(s.disponivel, 3)}`, 'Modulo 03 - vw_estoque_atual',
        { valor: arred(s.disponivel, 3) }),
      calculo(`Maximo aceitavel de ${arred(maximo, 3)} pelo criterio de ${criterio}`,
        'Modulo 12 - criterio de excesso', { valor: arred(maximo, 3) }),
      calculo(`Excedente de ${arred(excedente, 3)}, equivalente a ${arred(valorParado)}`,
        'Modulo 12 - excedente x custo', { valor: arred(valorParado), unidade: 'R$' }),
    ],
    calculo: { ...economia, excedente: arred(excedente, 3), maximo: arred(maximo, 3), criterio },
    premissas: economia.premissas,
    dados_usados: ['vw_estoque_atual', 'produtos', 'parametros_estoque'],
    explicacao: {
      o_que_aconteceu: `${s.descricao} tem ${arred(s.disponivel, 2)} em estoque, `
        + `acima do maximo aceitavel de ${arred(maximo, 2)}.`,
      por_que_aconteceu: s.demanda_diaria === 0
        ? 'O produto nao registra saida, mas tem saldo em estoque.'
        : 'A compra ficou acima do ritmo de consumo.',
      qual_o_impacto: `${arred(valorParado)} de capital imobilizado acima do necessario.`,
      o_que_pode_acontecer: s.quantidade_vencendo > 0
        ? `Parte do saldo vence nos proximos ${cfg.diasValidadeRisco} dias.`
        : 'O capital segue parado enquanto o excedente nao escoa.',
      o_que_recomendo: `Nao repor ate consumir ${arred(excedente, 3)} unidade(s).`,
      quais_dados_foram_utilizados: [
        'Posicao de estoque (modulo 03)',
        'Demanda media diaria (modulo 04)',
        'Estoque maximo cadastrado (modulo 03)',
      ],
    },
    chave_dedup: `EXCESSO:${s.produto_id}`,
  };
}

/** Risco de validade (secoes 6, 16 e 19). */
function recomendarValidade(
  s: SituacaoProduto, cfg: ConfigIA, confianca: Confianca,
): Recomendacao | null {
  if (s.quantidade_vencendo <= 0) return null;

  const valor = s.quantidade_vencendo * s.custo;
  const diasParaEscoar = s.demanda_diaria > 0
    ? Math.ceil(s.quantidade_vencendo / s.demanda_diaria) : null;
  const escoaATempo = diasParaEscoar !== null && diasParaEscoar <= cfg.diasValidadeRisco;

  return {
    tipo: 'ESCOAR_VALIDADE',
    origem: 'Analise de validade de lotes',
    titulo: `Validade proxima em ${s.codigo} - ${s.descricao}`,
    problema: `${s.lotes_vencendo} lote(s) com ${arred(s.quantidade_vencendo, 3)} `
      + `unidade(s) vencendo em ate ${cfg.diasValidadeRisco} dias`,
    recomendacao: escoaATempo
      ? `O ritmo atual escoa o saldo em ${diasParaEscoar} dia(s): acompanhar sem acao extra`
      : 'Priorizar o escoamento destes lotes ou negociar destinacao antes do vencimento',
    produto_id: s.produto_id,
    confianca,
    impacto_estimado: escoaATempo ? 0 : arred(valor),
    impacto_descricao: escoaATempo
      ? 'Sem perda prevista no ritmo atual de consumo'
      : `${arred(valor)} sob risco de perda por vencimento`,
    urgencia_dias: cfg.diasValidadeRisco,
    evidencias: [
      fato(`${s.lotes_vencendo} lote(s) vencendo em ate ${cfg.diasValidadeRisco} dias`,
        'Modulo 03 - lotes', { valor: s.lotes_vencendo }),
      fato(`${arred(s.quantidade_vencendo, 3)} unidade(s) nesses lotes`,
        'Modulo 03 - lotes', { valor: arred(s.quantidade_vencendo, 3) }),
      diasParaEscoar === null
        ? fato('Produto sem demanda apurada: nao da para projetar escoamento',
          'Modulo 04 - parametros de estoque')
        : previsao(`No ritmo atual o saldo escoa em ${diasParaEscoar} dia(s)`,
          'Modulo 12 - quantidade / demanda diaria',
          { valor: diasParaEscoar, unidade: 'dias' }),
    ],
    calculo: {
      quantidade_vencendo: arred(s.quantidade_vencendo, 3),
      custo_referencia: arred(s.custo),
      valor_sob_risco: arred(valor),
      dias_para_escoar: diasParaEscoar,
      janela_dias: cfg.diasValidadeRisco,
      escoa_a_tempo: escoaATempo,
    },
    premissas: ['A demanda se mantem no ritmo medio apurado',
      'Os lotes sao consumidos por ordem de validade'],
    dados_usados: ['lotes', 'vw_estoque_atual', 'parametros_estoque', 'produtos'],
    explicacao: {
      o_que_aconteceu: `${s.lotes_vencendo} lote(s) de ${s.descricao} vencem em ate `
        + `${cfg.diasValidadeRisco} dias.`,
      por_que_aconteceu: s.demanda_diaria === 0
        ? 'O produto nao registra saida.'
        : 'O saldo acumulado supera o consumo dentro da validade restante.',
      qual_o_impacto: escoaATempo
        ? 'Sem perda prevista: o consumo cobre o saldo antes do vencimento.'
        : `${arred(valor)} sob risco de perda.`,
      o_que_pode_acontecer: escoaATempo
        ? 'Se a demanda cair, parte do saldo pode vencer.'
        : 'Sem escoamento, o saldo vence e vira perda.',
      o_que_recomendo: escoaATempo
        ? 'Acompanhar; nenhuma acao extra necessaria agora.'
        : 'Priorizar a saida destes lotes.',
      quais_dados_foram_utilizados: ['Lotes e validades (modulo 03)',
        'Demanda media diaria (modulo 04)', 'Custo de referencia (modulo 02)'],
    },
    chave_dedup: `VALIDADE:${s.produto_id}`,
  };
}

/** Pedido atrasado com impacto em estoque (secoes 15 e 19). */
function recomendarPedidoAtrasado(
  s: SituacaoProduto, cfg: ConfigIA, confianca: Confianca,
): Recomendacao | null {
  if (s.pedidos_atrasados <= 0) return null;

  const hoje = hojeLocal();
  const proj = projetarRuptura(s.disponivel, s.demanda_diaria, hoje, null);
  const critico = proj.jaEmRuptura
    || (proj.diasAteRuptura !== null && proj.diasAteRuptura <= cfg.horizonteRupturaDias);
  const impacto = s.demanda_diaria * s.custo * 7;

  return {
    tipo: 'COBRAR_FORNECEDOR',
    origem: 'Analise de atrasos',
    titulo: `Pedido atrasado de ${s.codigo} - ${s.descricao}`,
    problema: `${s.pedidos_atrasados} item(ns) de pedido com promessa vencida`
      + (critico ? ', com o estoque proximo do fim' : ''),
    recomendacao: critico
      ? 'Cobrar a entrega e avaliar compra emergencial em fornecedor alternativo'
      : 'Cobrar a confirmacao de nova data de entrega',
    produto_id: s.produto_id,
    confianca,
    impacto_estimado: critico ? arred(impacto) : 0,
    impacto_descricao: critico
      ? `${arred(impacto)} por semana em demanda nao atendida se a falta se concretizar`
      : 'Sem impacto imediato no atendimento',
    urgencia_dias: proj.diasAteRuptura,
    evidencias: [
      fato(`${s.pedidos_atrasados} item(ns) de pedido com data prometida vencida`,
        'Modulo 08 - acompanhamento de pedidos', { valor: s.pedidos_atrasados }),
      fato(`${arred(s.quantidade_pendente, 3)} unidade(s) pendente(s) de entrega`,
        'Modulo 07 - pedidos de compra', { valor: arred(s.quantidade_pendente, 3) }),
      proj.diasAteRuptura === null
        ? fato('Produto sem demanda apurada: o atraso nao projeta falta',
          'Modulo 04 - parametros de estoque')
        : previsao(proj.jaEmRuptura
          ? 'Produto ja sem estoque disponivel'
          : `Saldo projetado para ${proj.diasAteRuptura} dia(s)`,
        'Modulo 12 - projecao', { valor: proj.diasAteRuptura, unidade: 'dias' }),
    ],
    calculo: {
      pedidos_atrasados: s.pedidos_atrasados,
      quantidade_pendente: arred(s.quantidade_pendente, 3),
      dias_ate_ruptura: proj.diasAteRuptura,
      impacto_semanal: arred(impacto),
      fornecedores_alternativos: Math.max(0, s.fornecedores - 1),
    },
    premissas: ['A quantidade pendente ainda sera entregue',
      'A demanda se mantem no ritmo medio apurado'],
    dados_usados: ['ordem_compra_itens', 'ordens_compra', 'vw_estoque_atual',
      'parametros_estoque'],
    explicacao: {
      o_que_aconteceu: `${s.pedidos_atrasados} item(ns) de pedido de ${s.descricao} `
        + 'passaram da data prometida.',
      por_que_aconteceu: 'O fornecedor nao entregou na data que assumiu.',
      qual_o_impacto: critico
        ? `O estoque cobre ${proj.diasAteRuptura ?? 0} dia(s); o atraso pode virar falta.`
        : 'O estoque atual ainda cobre a demanda.',
      o_que_pode_acontecer: critico
        ? 'Sem entrega ou compra alternativa, a falta se concretiza.'
        : 'O atraso segue sem efeito no atendimento enquanto houver saldo.',
      o_que_recomendo: critico
        ? 'Cobrar a entrega hoje e cotar alternativa em paralelo.'
        : 'Cobrar nova data de entrega.',
      quais_dados_foram_utilizados: ['Pedidos e datas prometidas (modulos 07 e 08)',
        'Posicao de estoque (modulo 03)', 'Demanda media diaria (modulo 04)'],
    },
    chave_dedup: `ATRASO:${s.produto_id}`,
  };
}

/** Dependencia de fornecedor unico (secoes 13 e 14). */
function recomendarMonoprovedor(
  s: SituacaoProduto, confianca: Confianca,
): Recomendacao | null {
  if (s.fornecedores !== 1) return null;
  if (s.demanda_diaria <= 0) return null;

  const impactoAnual = s.demanda_diaria * s.custo * 365;

  return {
    tipo: 'HOMOLOGAR_ALTERNATIVA',
    origem: 'Analise de concentracao',
    titulo: `Fornecedor unico em ${s.codigo} - ${s.descricao}`,
    problema: 'Produto com demanda ativa e um unico fornecedor homologado',
    recomendacao: 'Prospectar e homologar ao menos um fornecedor alternativo',
    produto_id: s.produto_id,
    confianca,
    impacto_estimado: arred(impactoAnual),
    impacto_descricao: `${arred(impactoAnual)} de demanda anual dependem de um unico fornecedor`,
    urgencia_dias: null,
    evidencias: [
      fato('Um unico fornecedor ativo vinculado ao produto',
        'Modulo 02 - produto x fornecedor', { valor: 1 }),
      calculo(`Demanda anual valorizada em ${arred(impactoAnual)}`,
        'Modulo 12 - demanda diaria x custo x 365',
        { valor: arred(impactoAnual), unidade: 'R$' }),
    ],
    calculo: {
      fornecedores_ativos: 1,
      demanda_diaria: arred(s.demanda_diaria, 3),
      custo_referencia: arred(s.custo),
      exposicao_anual: arred(impactoAnual),
    },
    premissas: ['A demanda anual se mantem no ritmo medio apurado',
      'O custo de referencia reflete o valor de reposicao'],
    dados_usados: ['produto_fornecedor', 'fornecedores', 'parametros_estoque', 'produtos'],
    explicacao: {
      o_que_aconteceu: `${s.descricao} tem demanda ativa e um unico fornecedor homologado.`,
      por_que_aconteceu: 'Nenhum fornecedor alternativo foi vinculado ou homologado.',
      qual_o_impacto: `${arred(impactoAnual)} de demanda anual sem alternativa de fornecimento.`,
      o_que_pode_acontecer: 'Falha, atraso ou bloqueio desse fornecedor interrompe o '
        + 'abastecimento sem plano B.',
      o_que_recomendo: 'Prospectar e homologar ao menos um fornecedor alternativo.',
      quais_dados_foram_utilizados: ['Vinculos produto x fornecedor (modulo 02)',
        'Demanda media diaria (modulo 04)'],
    },
    chave_dedup: `MONOPROVEDOR:${s.produto_id}`,
  };
}

/**
 * Lacuna de cadastro, AGREGADA por tipo (secao 27).
 *
 * Uma recomendacao por lacuna, nao por produto. A diferenca nao e cosmetica:
 * com 2.256 produtos sem fornecedor, a versao por produto geraria 2.256 linhas
 * identicas e a central de compras abriria com elas - enterrando as compras que
 * precisam sair hoje sob uma tarefa de cadastro que e uma so.
 */
const CORRECAO: Record<string, { titulo: string; problema: string; acao: string; efeito: string }> = {
  SEM_FORNECEDOR: {
    titulo: 'Produtos com demanda e sem fornecedor vinculado',
    problema: 'tem demanda ativa mas nenhum fornecedor ativo vinculado',
    acao: 'Vincular fornecedores a estes produtos no cadastro produto x fornecedor',
    efeito: 'Sem fornecedor, a IA nao pode recomendar compra: nao ha a quem comprar',
  },
  SEM_CUSTO: {
    titulo: 'Produtos com demanda e sem custo de referencia',
    problema: 'tem demanda ativa mas nenhum custo de referencia cadastrado',
    acao: 'Preencher o custo de referencia no cadastro do produto',
    efeito: 'Sem custo, o impacto financeiro de ruptura e excesso fica em zero',
  },
  SEM_PARAMETROS: {
    titulo: 'Produtos com demanda e sem parametros de estoque',
    problema: 'tem demanda ativa mas nao tem estoque minimo nem maximo definidos',
    acao: 'Definir estoque minimo e maximo, ou recalcular os parametros no modulo 05',
    efeito: 'Sem parametros, falta e excesso ficam sem referencia de comparacao',
  },
};

function recomendarLacuna(
  lacuna: string,
  produtos: number,
  impactoDiario: number,
  exemplos: Array<{ produto_id: number; codigo: string; descricao: string; impacto: number }>,
): Recomendacao | null {
  const c = CORRECAO[lacuna];
  if (!c || produtos === 0) return null;

  const listaExemplos = exemplos
    .map((e) => `${e.codigo} - ${e.descricao}`)
    .slice(0, 5);

  return {
    tipo: 'CORRIGIR_CADASTRO',
    origem: 'Porta de qualidade dos dados',
    titulo: `${c.titulo} (${produtos})`,
    problema: `${produtos} produto(s) ${c.problema}`,
    recomendacao: c.acao,
    confianca: 'ALTA', // a ausencia do dado e um fato, nao uma estimativa
    impacto_estimado: lacuna === 'SEM_CUSTO' ? null : arred(impactoDiario),
    impacto_descricao: lacuna === 'SEM_CUSTO'
      ? 'Impacto nao mensuravel justamente por faltar o custo'
      : `${arred(impactoDiario)} de demanda diaria valorizada fora das analises`,
    urgencia_dias: null,
    evidencias: [
      fato(`${produtos} produto(s) com esta lacuna`, 'Modulo 12 - porta de qualidade',
        { valor: produtos }),
      calculo(`Demanda diaria valorizada afetada: ${arred(impactoDiario)}`,
        'Modulo 12 - soma de demanda x custo dos afetados',
        { valor: arred(impactoDiario), unidade: 'R$' }),
    ],
    calculo: {
      lacuna,
      produtos_afetados: produtos,
      impacto_diario: arred(impactoDiario),
      maiores_impactos: exemplos,
    },
    premissas: [],
    dados_usados: ['produtos', 'produto_fornecedor', 'parametros_estoque', 'vw_estoque_atual'],
    explicacao: {
      o_que_aconteceu: `${produtos} produto(s) ${c.problema}.`,
      por_que_aconteceu: 'O cadastro nao foi completado para estes itens.',
      qual_o_impacto: c.efeito + '.',
      o_que_pode_acontecer: 'Estes produtos seguem fora das analises de reposicao, '
        + 'mesmo que entrem em ruptura.',
      o_que_recomendo: `${c.acao}. Maiores impactos: ${listaExemplos.join('; ')}.`,
      quais_dados_foram_utilizados: ['Cadastro do produto (modulo 02)',
        'Parametros de estoque (modulo 03)', 'Vinculos com fornecedores (modulo 02)',
        'Demanda media diaria (modulo 04)'],
    },
    chave_dedup: `LACUNA:${lacuna}`,
  };
}

// ---------------------------------------------------------------------------
// Geracao
// ---------------------------------------------------------------------------

export interface ResultadoGeracao {
  analisados: number;
  geradas: number;
  novas: number;
  reincidentes: number;
  bloqueadas_por_dados: number;
  por_tipo: Record<string, number>;
  recomendacoes: Array<Recomendacao & {
    id: number; nova: boolean; ocorrencias: number;
    prioridade: string; score: number;
  }>;
  limitacoes: string[];
}

/**
 * Varre os produtos em foco e grava as recomendacoes.
 *
 * A prioridade so pode ser calculada DEPOIS de gerar o lote inteiro, porque a
 * normalizacao do impacto usa o maior impacto do proprio lote (secao 31). Por
 * isso sao duas passadas: gerar, depois priorizar e gravar.
 */
export async function gerar(
  cfg: ConfigIA, contexto: ContextoSessao, limiteProdutos = 150,
): Promise<ResultadoGeracao> {
  // Produtos ANALISAVEIS: os que tem a quem comprar. Os demais viram lacuna
  // agregada logo abaixo, em vez de entupir a central com o mesmo aviso.
  const ids = await produtosEmFoco(limiteProdutos, true);
  const [situacoes, qualidades, lacunas] = await Promise.all([
    situacaoProdutos(ids, cfg),
    auditarProdutos(ids),
    lacunasCadastro(10),
  ]);

  const candidatas: Recomendacao[] = [];
  const limitacoes: string[] = [];
  let bloqueadas = 0;

  // Uma recomendacao por LACUNA, com a contagem e os maiores impactos.
  for (const l of lacunas) {
    const rec = recomendarLacuna(l.lacuna, l.produtos, l.impacto_diario, l.exemplos);
    if (rec) candidatas.push(rec);
    if (limitacoes.length < 10) {
      limitacoes.push(`${l.produtos} produto(s) com lacuna ${l.lacuna}: `
        + 'fora das analises de reposicao');
    }
  }

  for (const s of situacoes) {
    const q = qualidades.get(s.produto_id) ?? {
      apto: true, completude: 100, achados: [], limitacao: null,
    };

    if (!q.apto) {
      bloqueadas += 1;
      continue;
    }

    const conf = await confiancaProduto(s.produto_id, cfg);
    if (!confiancaAtende(conf.nivel, cfg.confiancaMinima)) {
      bloqueadas += 1;
      if (limitacoes.length < 10) {
        limitacoes.push(`${s.codigo}: confianca ${conf.nivel} - ${conf.motivos.join('; ')}`);
      }
      continue;
    }

    for (const gerador of [
      () => recomendarCompra(s, cfg, conf.nivel, q),
      () => recomendarExcesso(s, cfg, conf.nivel),
      () => recomendarValidade(s, cfg, conf.nivel),
      () => recomendarPedidoAtrasado(s, cfg, conf.nivel),
      () => recomendarMonoprovedor(s, conf.nivel),
    ]) {
      const rec = gerador();
      if (rec) candidatas.push(rec);
    }
  }

  // Segunda passada: prioridade relativa ao lote.
  const maiorImpacto = Math.max(1, ...candidatas.map((c) => c.impacto_estimado ?? 0));
  const situacaoPorId = new Map(situacoes.map((s) => [s.produto_id, s]));

  const gravadas: ResultadoGeracao['recomendacoes'] = [];
  const porTipo: Record<string, number> = {};
  let novas = 0;
  let reincidentes = 0;

  for (const c of candidatas) {
    const s = c.produto_id ? situacaoPorId.get(c.produto_id) : undefined;
    const p = calcularPrioridade({
      impactoFinanceiro: c.impacto_estimado ?? 0,
      maiorImpacto,
      urgenciaDias: c.urgencia_dias,
      horizonteDias: cfg.horizonteRupturaDias,
      classeAbc: s?.classe_abc ?? null,
      temAlternativa: s ? s.fornecedores > 1 : undefined,
    }, {
      impacto: cfg.pesoImpacto,
      urgencia: cfg.pesoUrgencia,
      criticidade: cfg.pesoCriticidade,
    });

    const registro = await registrar(c, p, cfg, contexto);
    gravadas.push({
      ...c, id: registro.id, nova: registro.nova,
      ocorrencias: registro.ocorrencias, prioridade: p.prioridade, score: p.score,
    });
    porTipo[c.tipo] = (porTipo[c.tipo] ?? 0) + 1;
    if (registro.nova) novas += 1; else reincidentes += 1;
  }

  gravadas.sort((a, b) => b.score - a.score);

  return {
    analisados: situacoes.length,
    geradas: gravadas.length,
    novas,
    reincidentes,
    bloqueadas_por_dados: bloqueadas,
    por_tipo: porTipo,
    recomendacoes: gravadas,
    limitacoes,
  };
}

/**
 * Grava a recomendacao, deduplicando pela chave enquanto estiver aberta.
 *
 * Mesma mecanica da central de alertas do modulo 11: a mesma condicao nao vira
 * duas recomendacoes abertas. Quem ja analisou e rejeitou nao ve a sugestao
 * renascer todo dia como se fosse nova.
 */
async function registrar(
  r: Recomendacao,
  p: { score: number; prioridade: string; componentes: Record<string, number> },
  cfg: ConfigIA,
  contexto: ContextoSessao,
): Promise<{ id: number; nova: boolean; ocorrencias: number }> {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query<{
      id: string; ocorrencias: number; inserido: boolean;
    }>(`
      INSERT INTO ia_recomendacoes
        (tipo, origem, titulo, problema, recomendacao, produto_id, fornecedor_id,
         ordem_compra_id, prioridade, confianca, impacto_estimado, impacto_descricao,
         urgencia_dias, score_prioridade, evidencias, calculo, premissas, dados_usados,
         chave_dedup, expira_em, status)
      VALUES
        ($1::tipo_recomendacao_enum, $2, $3, $4, $5, $6, $7, $8,
         $9::prioridade_alerta_enum, $10::confiabilidade_previsao_enum,
         $11::numeric, $12, $13, $14::numeric, $15::jsonb, $16::jsonb, $17::jsonb,
         $18::jsonb, $19, CURRENT_DATE + $20::int, 'NOVA')
      ON CONFLICT (chave_dedup)
        WHERE chave_dedup IS NOT NULL AND status IN ('NOVA', 'EM_ANALISE')
      DO UPDATE SET
        ocorrencias      = ia_recomendacoes.ocorrencias + 1,
        problema         = EXCLUDED.problema,
        recomendacao     = EXCLUDED.recomendacao,
        impacto_estimado = EXCLUDED.impacto_estimado,
        impacto_descricao= EXCLUDED.impacto_descricao,
        urgencia_dias    = EXCLUDED.urgencia_dias,
        score_prioridade = EXCLUDED.score_prioridade,
        prioridade       = EXCLUDED.prioridade,
        confianca        = EXCLUDED.confianca,
        evidencias       = EXCLUDED.evidencias,
        calculo          = EXCLUDED.calculo,
        expira_em        = EXCLUDED.expira_em,
        updated_at       = now()
      RETURNING id, ocorrencias, (xmax = 0) AS inserido`,
    [r.tipo, r.origem, r.titulo, r.problema, r.recomendacao,
      r.produto_id ?? null, r.fornecedor_id ?? null, r.ordem_compra_id ?? null,
      p.prioridade, r.confianca, r.impacto_estimado, r.impacto_descricao,
      r.urgencia_dias, p.score,
      JSON.stringify(r.evidencias),
      JSON.stringify({ ...r.calculo, prioridade: p.componentes, explicacao: r.explicacao }),
      JSON.stringify(r.premissas), JSON.stringify(r.dados_usados),
      r.chave_dedup, cfg.expiraDias]);

    const linha = rows[0]!;
    return {
      id: Number(linha.id),
      nova: linha.inserido,
      ocorrencias: linha.ocorrencias,
    };
  });
}

// ---------------------------------------------------------------------------
// Consulta e tratativa
// ---------------------------------------------------------------------------

export interface FiltroRecomendacoes {
  status?: string;
  tipo?: string;
  prioridade?: string;
  produto_id?: number;
  fornecedor_id?: number;
  confianca?: string;
  limite?: number;
  pagina?: number;
}

export async function listar(filtro: FiltroRecomendacoes) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const add = (sql: string, valor: unknown) => {
    if (valor === undefined || valor === null || valor === '') return;
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  add('r.status = $?::status_recomendacao_enum', filtro.status ?? 'NOVA');
  add('r.tipo = $?::tipo_recomendacao_enum', filtro.tipo);
  add('r.prioridade = $?::prioridade_alerta_enum', filtro.prioridade);
  add('r.confianca = $?::confiabilidade_previsao_enum', filtro.confianca);
  add('r.produto_id = $?', filtro.produto_id);
  add('r.fornecedor_id = $?', filtro.fornecedor_id);

  const limite = Math.min(Math.max(filtro.limite ?? 50, 1), 200);
  const pagina = Math.max(filtro.pagina ?? 1, 1);
  valores.push(limite, (pagina - 1) * limite);

  const { rows } = await query(`
    SELECT r.id, r.tipo::text AS tipo, r.origem, r.titulo, r.problema, r.recomendacao,
           r.prioridade::text AS prioridade, r.confianca::text AS confianca,
           r.impacto_estimado, r.impacto_descricao, r.urgencia_dias, r.score_prioridade,
           r.status::text AS status, r.ocorrencias, r.created_at, r.expira_em,
           r.produto_id, r.fornecedor_id, r.ordem_compra_id,
           p.codigo AS produto_codigo, p.descricao AS produto,
           f.razao_social AS fornecedor, u.nome AS responsavel,
           count(*) OVER () AS total
      FROM ia_recomendacoes r
      LEFT JOIN produtos p     ON p.id = r.produto_id
      LEFT JOIN fornecedores f ON f.id = r.fornecedor_id
      LEFT JOIN usuarios u     ON u.id = r.usuario_responsavel_id
     ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
     ORDER BY r.score_prioridade DESC NULLS LAST, r.created_at DESC
     LIMIT $${valores.length - 1} OFFSET $${valores.length}`, valores);

  const total = rows.length ? Number((rows[0] as { total: string }).total) : 0;
  return {
    total,
    pagina,
    limite,
    recomendacoes: rows.map((r) => {
      const { total: _t, ...rec } = r as Record<string, unknown>;
      return rec;
    }),
  };
}

/** Detalhe com a conta inteira: evidencias, calculo, premissas e explicacao. */
export async function detalhar(id: number) {
  const { rows } = await query(`
    SELECT r.*, r.tipo::text AS tipo, r.prioridade::text AS prioridade,
           r.confianca::text AS confianca, r.status::text AS status,
           p.codigo AS produto_codigo, p.descricao AS produto,
           f.razao_social AS fornecedor, u.nome AS responsavel
      FROM ia_recomendacoes r
      LEFT JOIN produtos p     ON p.id = r.produto_id
      LEFT JOIN fornecedores f ON f.id = r.fornecedor_id
      LEFT JOIN usuarios u     ON u.id = r.usuario_responsavel_id
     WHERE r.id = $1`, [id]);
  if (!rows.length) throw naoEncontrado('Recomendacao');

  const r = rows[0] as Record<string, unknown>;
  const calc = (r.calculo ?? {}) as Record<string, unknown>;

  const { rows: feedback } = await query(`
    SELECT fb.id, fb.tipo::text AS tipo, fb.motivo, fb.observacao, fb.created_at,
           u.nome AS usuario
      FROM ia_feedback fb LEFT JOIN usuarios u ON u.id = fb.usuario_id
     WHERE fb.recomendacao_id = $1 ORDER BY fb.created_at`, [id]);

  return {
    ...r,
    explicacao: calc.explicacao ?? null,
    prioridade_componentes: calc.prioridade ?? null,
    feedback,
  };
}

const TRANSICOES: Record<string, string[]> = {
  NOVA: ['EM_ANALISE', 'ACEITA', 'REJEITADA', 'EXPIRADA'],
  EM_ANALISE: ['ACEITA', 'REJEITADA', 'EXPIRADA'],
  ACEITA: ['EXECUTADA', 'REJEITADA'],
  REJEITADA: [],
  EXECUTADA: [],
  EXPIRADA: [],
};

const STATUS_DO_FEEDBACK: Record<string, string> = {
  ACEITAR: 'ACEITA',
  REJEITAR: 'REJEITADA',
  EXECUTAR: 'EXECUTADA',
  IGNORAR: 'REJEITADA',
  AJUSTAR: 'EM_ANALISE',
};

/**
 * Registra a decisao do usuario (secao 36).
 *
 * Muda o STATUS da recomendacao e nada mais. Marcar como EXECUTADA nao emite
 * pedido: significa que a pessoa foi ao modulo de compras e executou la, com a
 * alcada dela (secao 48). O registro serve para a cadeia
 * recomendacao -> decisao -> resultado da secao 35.
 */
export async function decidir(
  id: number,
  tipo: string,
  contexto: ContextoSessao,
  motivo?: string,
  observacao?: string,
) {
  if (tipo === 'REJEITAR' && !motivo) {
    throw regraNegocio('Rejeitar uma recomendacao exige o motivo: e ele que permite '
      + 'melhorar a regra depois');
  }

  const destino = STATUS_DO_FEEDBACK[tipo];
  if (!destino) throw regraNegocio(`Tipo de decisao desconhecido: ${tipo}`);

  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query<{ status: string }>(
      'SELECT status::text AS status FROM ia_recomendacoes WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) throw naoEncontrado('Recomendacao');

    const atual = rows[0]!.status;
    if (!(TRANSICOES[atual] ?? []).includes(destino)) {
      throw regraNegocio(`Recomendacao ${atual} nao pode ir para ${destino}`);
    }

    await cliente.query(`
      INSERT INTO ia_feedback (recomendacao_id, usuario_id, tipo, motivo, observacao)
      VALUES ($1, $2, $3::tipo_feedback_enum, $4, $5)`,
    [id, contexto.usuarioId ?? null, tipo, motivo ?? null, observacao ?? null]);

    const { rows: atualizada } = await cliente.query(`
      UPDATE ia_recomendacoes
         SET status = $2::status_recomendacao_enum,
             decidida_em = now(),
             usuario_responsavel_id = coalesce(usuario_responsavel_id, $3),
             updated_at = now()
       WHERE id = $1
      RETURNING id, status::text AS status, decidida_em`,
    [id, destino, contexto.usuarioId ?? null]);

    return {
      ...atualizada[0],
      observacao: 'A decisao foi registrada. A execucao continua sendo feita no modulo '
        + 'operacional, com a alcada do usuario.',
    };
  });
}

/** Expira recomendacoes nao decididas (secao 20). */
export async function expirarVencidas(contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query<{ id: string }>(`
      UPDATE ia_recomendacoes
         SET status = 'EXPIRADA', decidida_em = now(), updated_at = now()
       WHERE status IN ('NOVA', 'EM_ANALISE')
         AND expira_em IS NOT NULL AND expira_em < CURRENT_DATE
      RETURNING id`);
    return { expiradas: rows.length };
  });
}

/** Painel da central (secao 45). */
export async function resumo() {
  const { rows } = await query<Record<string, unknown>>(`
    SELECT status::text AS status, prioridade::text AS prioridade,
           count(*) AS quantidade,
           coalesce(sum(impacto_estimado), 0) AS impacto
      FROM ia_recomendacoes GROUP BY 1, 2`);

  const porStatus: Record<string, number> = {
    NOVA: 0, EM_ANALISE: 0, ACEITA: 0, REJEITADA: 0, EXECUTADA: 0, EXPIRADA: 0,
  };
  const porPrioridade: Record<string, number> = {
    CRITICO: 0, ALTO: 0, MEDIO: 0, BAIXO: 0,
  };
  let impactoAberto = 0;

  for (const r of rows) {
    const q = num(r.quantidade);
    porStatus[String(r.status)] = (porStatus[String(r.status)] ?? 0) + q;
    if (r.status === 'NOVA' || r.status === 'EM_ANALISE') {
      porPrioridade[String(r.prioridade)] = (porPrioridade[String(r.prioridade)] ?? 0) + q;
      impactoAberto += num(r.impacto);
    }
  }

  const { rows: tipos } = await query<Record<string, unknown>>(`
    SELECT tipo::text AS tipo, count(*) AS quantidade
      FROM ia_recomendacoes WHERE status IN ('NOVA','EM_ANALISE')
     GROUP BY 1 ORDER BY 2 DESC`);

  const { rows: fb } = await query<Record<string, unknown>>(`
    SELECT tipo::text AS tipo, count(*) AS quantidade FROM ia_feedback GROUP BY 1`);

  return {
    por_status: porStatus,
    por_prioridade: porPrioridade,
    por_tipo: tipos.map((t) => ({ tipo: String(t.tipo), quantidade: num(t.quantidade) })),
    impacto_em_aberto: arred(impactoAberto),
    feedback: fb.map((f) => ({ tipo: String(f.tipo), quantidade: num(f.quantidade) })),
    apurado_em: new Date().toISOString(),
  };
}
