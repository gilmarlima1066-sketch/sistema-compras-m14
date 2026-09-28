/**
 * Simulacao de cenarios (secoes 28, 29 e 34).
 *
 * A simulacao de REPOSICAO nao e reimplementada aqui: ela delega ao modulo 05,
 * que roda o MESMO SQL do planejamento oficial com os fatores trocados e grava
 * em `simulacoes_compra`. Reescrever esse calculo criaria um segundo numero
 * oficial para "quanto preciso comprar", que e exatamente o que a secao 2
 * proibe.
 *
 * O que este modulo acrescenta e a camada FINANCEIRA que o modulo 05 nao tem:
 * preco, cambio e prazo de pagamento (secoes 28 e 34). Sao dimensoes que nao
 * mudam a quantidade a comprar, mudam quanto ela custa e quando sai do caixa.
 *
 * E a regra que atravessa o arquivo inteiro: a simulacao nao altera dado real
 * (secao 28). Todo numero que sai daqui vem marcado como SIMULACAO (secao 47),
 * para nao ser confundido com a posicao de verdade.
 */
import { query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado } from '../../core/errors.js';
import { simular as simularReposicao } from '../planejamento/simulacao.service.js';
import { simularImpactoFinanceiro, type ImpactoFinanceiro } from './calculos.js';
import { simulacao as evidenciaSimulacao, type Evidencia } from './evidencias.js';
import type { ConfigIA } from './contexto.js';

const arred = (v: number, c = 2) => Math.round(v * 10 ** c) / 10 ** c;
const num = (v: unknown) => Number(v ?? 0);

/**
 * Cenarios nomeados da secao 29.
 *
 * Cada um combina fatores de reposicao (modulo 05) com fatores financeiros
 * (aqui). Sao pontos de partida configuraveis: o usuario pode ajustar qualquer
 * fator depois, e a resposta sempre devolve os fatores efetivamente aplicados.
 */
export const CENARIOS: Record<string, {
  titulo: string;
  descricao: string;
  demanda: number;
  leadTime: number;
  seguranca: number;
  preco: number;
  cambio: number;
}> = {
  BASE: {
    titulo: 'Cenario base',
    descricao: 'A situacao como esta hoje, sem ajuste nenhum',
    demanda: 0, leadTime: 0, seguranca: 0, preco: 0, cambio: 0,
  },
  OTIMISTA: {
    titulo: 'Cenario otimista',
    descricao: 'Demanda menor, fornecedor pontual e preco estavel',
    demanda: -10, leadTime: 0, seguranca: -10, preco: -5, cambio: 0,
  },
  PESSIMISTA: {
    titulo: 'Cenario pessimista',
    descricao: 'Demanda maior, fornecedor mais lento e preco em alta',
    demanda: 20, leadTime: 10, seguranca: 20, preco: 10, cambio: 5,
  },
  RUPTURA: {
    titulo: 'Cenario de ruptura',
    descricao: 'Demanda dispara enquanto a reposicao demora',
    demanda: 40, leadTime: 15, seguranca: 30, preco: 0, cambio: 0,
  },
  AUMENTO_PRECO: {
    titulo: 'Cenario de aumento de preco',
    descricao: 'Reajuste do fornecedor sem mudanca de consumo',
    demanda: 0, leadTime: 0, seguranca: 0, preco: 20, cambio: 0,
  },
  ATRASO_FORNECEDOR: {
    titulo: 'Cenario de atraso do fornecedor',
    descricao: 'Lead time estoura e a seguranca precisa cobrir mais tempo',
    demanda: 0, leadTime: 20, seguranca: 25, preco: 0, cambio: 0,
  },
  AUMENTO_DEMANDA: {
    titulo: 'Cenario de aumento de demanda',
    descricao: 'Consumo cresce e o resto se mantem',
    demanda: 25, leadTime: 0, seguranca: 0, preco: 0, cambio: 0,
  },
  CAMBIO: {
    titulo: 'Cenario cambial',
    descricao: 'Alta do cambio sobre o que e importado',
    demanda: 0, leadTime: 0, seguranca: 0, preco: 0, cambio: 15,
  },
};

export interface EntradaSimulacao {
  nome: string;
  cenario?: string;
  horizonte_dias?: number;
  variacao_demanda_percentual?: number;
  lead_time_extra_dias?: number;
  variacao_seguranca_percentual?: number;
  variacao_preco_percentual?: number;
  variacao_cambio_percentual?: number;
  prazo_pagamento_dias?: number;
  categoria_id?: number;
  fornecedor_id?: number;
}

export interface ResultadoSimulacao {
  simulacao_id: number;
  nome: string;
  cenario: string;
  titulo: string;
  descricao: string;
  fatores_aplicados: Record<string, number>;
  reposicao: {
    produtos_analisados: number;
    itens_com_necessidade: number;
    quantidade_total: number;
    valor_total: number;
    produtos_risco_ruptura: number;
    produtos_excesso: number;
    horizonte_dias: number;
  };
  financeiro: ImpactoFinanceiro;
  caixa: {
    prazo_pagamento_dias: number | null;
    desembolso_estimado: number;
    observacao: string;
  } | null;
  comparacao_com_base: {
    diferenca_valor: number;
    diferenca_percentual: number | null;
    diferenca_itens: number;
    diferenca_ruptura: number;
  } | null;
  evidencias: Evidencia[];
  aviso: string;
}

/**
 * Roda um cenario completo: reposicao (modulo 05) + financeiro (aqui).
 *
 * `comparar` roda o cenario BASE tambem, para a resposta trazer a diferenca.
 * Sem a base, um valor simulado de R$ 180.000 nao diz nada - e alto ou baixo
 * em relacao a que?
 */
export async function simularCenario(
  entrada: EntradaSimulacao,
  cfg: ConfigIA,
  contexto: ContextoSessao,
  comparar = true,
): Promise<ResultadoSimulacao> {
  const chave = (entrada.cenario ?? 'PERSONALIZADO').toUpperCase();
  const preset = CENARIOS[chave];
  if (entrada.cenario && !preset) {
    throw naoEncontrado(`Cenario ${entrada.cenario}`);
  }

  const fatores = {
    demanda: entrada.variacao_demanda_percentual ?? preset?.demanda ?? 0,
    lead_time: entrada.lead_time_extra_dias ?? preset?.leadTime ?? 0,
    seguranca: entrada.variacao_seguranca_percentual ?? preset?.seguranca ?? 0,
    preco: entrada.variacao_preco_percentual ?? preset?.preco ?? 0,
    cambio: entrada.variacao_cambio_percentual ?? preset?.cambio ?? 0,
  };

  const rodar = async (nome: string, f: typeof fatores) => simularReposicao({
    nome,
    // O modulo 05 so conhece os proprios cenarios; os nomeados aqui entram
    // como PERSONALIZADO com os fatores ja resolvidos.
    tipo_cenario: 'PERSONALIZADO' as const,
    horizonte_dias: entrada.horizonte_dias,
    variacao_demanda_percentual: f.demanda,
    lead_time_extra_dias: f.lead_time,
    variacao_seguranca_percentual: f.seguranca,
    categoria_id: entrada.categoria_id,
    fornecedor_id: entrada.fornecedor_id,
  } as Parameters<typeof simularReposicao>[0], contexto);

  const simulada = await rodar(entrada.nome, fatores) as Record<string, unknown>;

  const valorBase = num(simulada.valor_total);
  const financeiro = simularImpactoFinanceiro(valorBase, fatores.preco, fatores.cambio);

  let comparacao: ResultadoSimulacao['comparacao_com_base'] = null;
  if (comparar && (fatores.demanda !== 0 || fatores.lead_time !== 0
    || fatores.seguranca !== 0)) {
    const base = await rodar(`${entrada.nome} (base)`, {
      demanda: 0, lead_time: 0, seguranca: 0, preco: 0, cambio: 0,
    }) as Record<string, unknown>;

    const valorBaseReal = num(base.valor_total);
    comparacao = {
      diferenca_valor: arred(financeiro.valorSimulado - valorBaseReal),
      diferenca_percentual: valorBaseReal > 0
        ? arred(((financeiro.valorSimulado - valorBaseReal) / valorBaseReal) * 100) : null,
      diferenca_itens: num(simulada.itens_com_necessidade) - num(base.itens_com_necessidade),
      diferenca_ruptura: num(simulada.produtos_risco_ruptura)
        - num(base.produtos_risco_ruptura),
    };
  }

  const prazo = entrada.prazo_pagamento_dias ?? null;

  const evidencias: Evidencia[] = [
    evidenciaSimulacao(
      `Necessidade simulada de ${num(simulada.itens_com_necessidade)} item(ns), `
      + `${arred(num(simulada.quantidade_total), 3)} unidade(s)`,
      'Modulo 05 - mesmo calculo do planejamento oficial, com os fatores trocados',
      { valor: num(simulada.itens_com_necessidade) }),
    evidenciaSimulacao(
      `Valor simulado de ${arred(financeiro.valorSimulado)}`,
      'Modulo 12 - valor da reposicao ajustado por preco e cambio',
      { valor: financeiro.valorSimulado, unidade: 'R$' }),
    evidenciaSimulacao(
      `${num(simulada.produtos_risco_ruptura)} produto(s) em risco de ruptura no cenario`,
      'Modulo 05 - simulacao de reposicao',
      { valor: num(simulada.produtos_risco_ruptura) }),
  ];

  return {
    simulacao_id: Number(simulada.id),
    nome: entrada.nome,
    cenario: chave,
    titulo: preset?.titulo ?? 'Cenario personalizado',
    descricao: preset?.descricao ?? 'Fatores definidos pelo usuario',
    fatores_aplicados: fatores,
    reposicao: {
      produtos_analisados: num(simulada.produtos_analisados),
      itens_com_necessidade: num(simulada.itens_com_necessidade),
      quantidade_total: arred(num(simulada.quantidade_total), 3),
      valor_total: arred(valorBase),
      produtos_risco_ruptura: num(simulada.produtos_risco_ruptura),
      produtos_excesso: num(simulada.produtos_excesso),
      horizonte_dias: num(simulada.horizonte_dias),
    },
    financeiro,
    caixa: prazo === null ? null : {
      prazo_pagamento_dias: prazo,
      desembolso_estimado: financeiro.valorSimulado,
      observacao: `Com ${prazo} dias de prazo, o desembolso ocorre por volta de `
        + `${new Date(Date.now() + prazo * 86400000).toISOString().slice(0, 10)}`,
    },
    comparacao_com_base: comparacao,
    evidencias,
    aviso: 'Cenario hipotetico. Nenhum dado operacional foi alterado: a simulacao '
      + 'grava apenas o proprio resultado.',
  };
}

/** Roda os cenarios nomeados de uma vez, para comparacao (secao 29). */
export async function compararCenarios(
  nomes: string[],
  entrada: Omit<EntradaSimulacao, 'nome' | 'cenario'>,
  cfg: ConfigIA,
  contexto: ContextoSessao,
) {
  const validos = nomes
    .map((n) => n.toUpperCase())
    .filter((n) => CENARIOS[n]);

  if (!validos.length) throw naoEncontrado('Nenhum cenario valido informado');

  const resultados = [];
  for (const cenario of validos) {
    resultados.push(await simularCenario(
      { ...entrada, nome: `Comparacao ${cenario}`, cenario },
      cfg, contexto, false));
  }

  const base = resultados.find((r) => r.cenario === 'BASE');

  return {
    cenarios: resultados.map((r) => ({
      cenario: r.cenario,
      titulo: r.titulo,
      fatores: r.fatores_aplicados,
      itens_com_necessidade: r.reposicao.itens_com_necessidade,
      quantidade_total: r.reposicao.quantidade_total,
      valor_simulado: r.financeiro.valorSimulado,
      produtos_risco_ruptura: r.reposicao.produtos_risco_ruptura,
      produtos_excesso: r.reposicao.produtos_excesso,
      diferenca_para_base: base
        ? arred(r.financeiro.valorSimulado - base.financeiro.valorSimulado)
        : null,
    })),
    aviso: 'Cenarios hipoteticos. Nenhum dado operacional foi alterado.',
    apurado_em: new Date().toISOString(),
  };
}

export function listarCenarios() {
  return Object.entries(CENARIOS).map(([codigo, c]) => ({
    codigo,
    titulo: c.titulo,
    descricao: c.descricao,
    fatores: {
      demanda: c.demanda, lead_time: c.leadTime, seguranca: c.seguranca,
      preco: c.preco, cambio: c.cambio,
    },
  }));
}

/** Historico das simulacoes rodadas (reusa a tabela do modulo 05). */
export async function historico(limite = 30) {
  const { rows } = await query(`
    SELECT s.id, s.nome, s.tipo_cenario, s.ajustes, s.horizonte_dias,
           s.produtos_analisados, s.itens_com_necessidade, s.quantidade_total,
           s.valor_total, s.produtos_risco_ruptura, s.produtos_excesso,
           s.created_at, u.nome AS usuario
      FROM simulacoes_compra s
      LEFT JOIN usuarios u ON u.id = s.usuario_id
     ORDER BY s.created_at DESC
     LIMIT $1`, [limite]);
  return rows;
}
