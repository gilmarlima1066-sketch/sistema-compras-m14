import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { conflito, naoEncontrado, regraNegocio, semPermissao } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import type { z } from 'zod';
import type {
  aprovarPedidoSchema, cancelarPedidoSchema, confirmarPedidoSchema, converterPedidoSchema,
  decidirAlteracaoSchema, enviarPedidoSchema, listarPedidosSchema, rejeitarSchema,
  solicitarAlteracaoSchema,
} from './negociacao.schemas.js';
import {
  compararConfirmacao, custoTotal, gerarParcelas, impactoEstoque,
  ratearFrete, validarQuantidade, type MetodoRateio,
} from './calculos.js';

type Cliente = { query: (t: string, v?: unknown[]) => Promise<{ rows: any[] }> };
const num = (v: unknown): number => Number(v ?? 0);

export const TRANSICOES_PEDIDO: Record<string, string[]> = {
  RASCUNHO: ['AGUARDANDO_APROVACAO', 'CANCELADA'],
  AGUARDANDO_APROVACAO: ['APROVADA', 'REJEITADA', 'CANCELADA', 'BLOQUEADA'],
  APROVADA: ['ENVIADA', 'CANCELADA', 'BLOQUEADA'],
  ENVIADA: ['CONFIRMADA', 'CANCELADA', 'BLOQUEADA'],
  CONFIRMADA: ['EM_PRODUCAO', 'EM_TRANSITO', 'RECEBIMENTO_PARCIAL', 'RECEBIDA', 'CANCELADA', 'BLOQUEADA'],
  EM_PRODUCAO: ['EM_TRANSITO', 'RECEBIMENTO_PARCIAL', 'RECEBIDA', 'CANCELADA'],
  EM_TRANSITO: ['RECEBIMENTO_PARCIAL', 'RECEBIDA', 'CANCELADA'],
  RECEBIMENTO_PARCIAL: ['RECEBIDA', 'CANCELADA'],
  RECEBIDA: ['FINALIZADA'],
  BLOQUEADA: ['APROVADA', 'CANCELADA'],
  FINALIZADA: [],
  REJEITADA: [],
  CANCELADA: [],
};

async function config(): Promise<Record<string, string>> {
  const { rows } = await query<{ chave: string; valor: string }>(
    "SELECT chave, valor FROM configuracoes WHERE grupo IN ('pedido', 'planejamento')");
  return Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
}

async function registrarEvento(
  cliente: Cliente, pedidoId: number, evento: string,
  anterior: string | null, novo: string | null,
  usuarioId: number | null, descricao?: string | null, detalhes?: unknown,
) {
  await cliente.query(`
    INSERT INTO pedido_historico
      (ordem_compra_id, evento, status_anterior, status_novo, descricao, detalhes, usuario_id)
    VALUES ($1, $2, $3::status_ordem_compra_enum, $4::status_ordem_compra_enum, $5, $6, $7)`,
    [pedidoId, evento, anterior, novo, descricao ?? null,
      detalhes === undefined ? null : JSON.stringify(detalhes), usuarioId]);
}

/**
 * Alcada que responde por um valor.
 *
 * Exportada porque o modulo 13 tambem precisa dela: quando uma automacao pede
 * aprovacao de excecao, a faixa de valor tem de ser a MESMA que o pedido de
 * compra usa. Duas leituras independentes da mesma tabela divergiriam no dia em
 * que uma delas ganhasse um filtro a mais - e a divergencia apareceria como
 * "aprovei na tela e a automacao pediu outra aprovacao".
 */
export async function alcadaPara(valor: number) {
  const { rows } = await query<{
    id: string; nome: string; perfil: string; ordem: number;
  }>(`
    SELECT a.id, a.nome, p.nome AS perfil, a.ordem
      FROM alcadas_aprovacao a JOIN perfis p ON p.id = a.perfil_id
     WHERE a.ativo AND a.valor_minimo <= $1
       AND (a.valor_maximo IS NULL OR a.valor_maximo >= $1)
     ORDER BY a.ordem LIMIT 1`, [valor]);
  return rows[0] ?? null;
}

/**
 * Numeracao no formato PC-AAAA-NNNNNN. O contador vem do maior numero do ano,
 * nao da contagem: numero de pedido cancelado nunca e reaproveitado (secao 25).
 */
async function proximoNumero(cliente: Cliente): Promise<string> {
  const { rows: cfg } = await cliente.query(
    "SELECT valor FROM configuracoes WHERE chave = 'pedido.prefixo_numero'");
  const prefixo = cfg[0]?.valor ?? 'PC';
  const { rows } = await cliente.query(`
    SELECT coalesce(max(
             nullif(regexp_replace(numero, '^.*-', ''), '')::bigint), 0) + 1 AS proximo
      FROM ordens_compra
     WHERE numero LIKE $1`, [`${prefixo}-${new Date().getUTCFullYear()}-%`]);
  const sequencial = String(rows[0].proximo).padStart(6, '0');
  return `${prefixo}-${new Date().getUTCFullYear()}-${sequencial}`;
}

// ---------------------------------------------------------------------------
// Validacoes antes de aprovar (secoes 28 a 31, 64 e 65)
// ---------------------------------------------------------------------------

export async function validarPedido(pedidoId: number) {
  const cfg = await config();
  const limiteCobertura = Number(cfg['pedido.limite_cobertura_dias'] ?? 120);
  const percentualAcima = Number(cfg['pedido.percentual_acima_necessidade'] ?? 20);
  const hoje = new Date().toISOString().slice(0, 10);

  const { rows: pedido } = await query(
    'SELECT * FROM ordens_compra WHERE id = $1', [pedidoId]);
  if (!pedido.length) throw naoEncontrado('Pedido de compra');

  const { rows: itens } = await query(`
    SELECT oci.*, p.codigo, p.descricao, p.classificacao_abc, p.classificacao_xyz,
           coalesce(s.disponivel, 0)  AS estoque_disponivel,
           coalesce(s.fisico, 0)      AS estoque_fisico,
           coalesce(s.reservado, 0)   AS estoque_reservado,
           coalesce(s.transito, 0)    AS estoque_transito,
           d.demanda_diaria,
           pv.demanda_prevista, pv.tendencia, pv.sazonal, pv.confiabilidade,
           nc.quantidade_sugerida AS necessidade_planejada,
           nc.quantidade_aprovada AS necessidade_aprovada,
           ni.quantidade_atual    AS quantidade_negociada,
           ci.quantidade_ofertada AS quantidade_cotada
      FROM ordem_compra_itens oci
      JOIN produtos p ON p.id = oci.produto_id
      LEFT JOIN LATERAL (
        SELECT sum(quantidade_disponivel) AS disponivel, sum(quantidade_fisica) AS fisico,
               sum(quantidade_reservada) AS reservado, sum(quantidade_em_transito) AS transito
          FROM estoques e WHERE e.produto_id = oci.produto_id) s ON true
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(quantidade), 0) / 90.0 AS demanda_diaria
          FROM mv_demanda_diaria m
         WHERE m.produto_id = oci.produto_id AND m.data_venda >= CURRENT_DATE - 90) d ON true
      LEFT JOIN LATERAL (
        SELECT demanda_prevista, tendencia, sazonal, confiabilidade
          FROM previsoes_demanda pd WHERE pd.produto_id = oci.produto_id
         ORDER BY pd.periodo_inicio DESC, pd.versao DESC LIMIT 1) pv ON true
      LEFT JOIN necessidades_compra nc ON nc.id = oci.necessidade_id
      LEFT JOIN negociacao_itens ni ON ni.id = oci.negociacao_item_id
      LEFT JOIN cotacao_itens ci ON ci.id = oci.cotacao_item_id
     WHERE oci.ordem_compra_id = $1
     ORDER BY p.descricao`, [pedidoId]);

  const linhas = itens.map((i) => {
    const quantidade = num(i.quantidade_pedida);
    const necessidade = i.necessidade_aprovada !== null
      ? num(i.necessidade_aprovada)
      : i.necessidade_planejada !== null ? num(i.necessidade_planejada) : null;

    const quantidadeOk = validarQuantidade(quantidade, i.moq !== null ? num(i.moq) : null,
      i.multiplo !== null ? num(i.multiplo) : null);

    const impacto = impactoEstoque({
      estoqueDisponivel: num(i.estoque_disponivel),
      estoqueEmTransito: num(i.estoque_transito),
      quantidadePedido: quantidade,
      demandaDiaria: i.demanda_diaria !== null ? num(i.demanda_diaria) : null,
      limiteCoberturaDias: limiteCobertura,
      necessidadePlanejada: necessidade,
      hoje,
    });

    const acimaNecessidade = impacto.percentualAcimaNecessidade !== null
      && impacto.percentualAcimaNecessidade > percentualAcima;

    return {
      ordem_compra_item_id: Number(i.id),
      produto_id: Number(i.produto_id),
      codigo: i.codigo,
      descricao: i.descricao,
      classificacao_abc: i.classificacao_abc,
      classificacao_xyz: i.classificacao_xyz,
      quantidade_pedida: quantidade,
      quantidade_negociada: i.quantidade_negociada !== null ? num(i.quantidade_negociada) : null,
      quantidade_cotada: i.quantidade_cotada !== null ? num(i.quantidade_cotada) : null,
      necessidade_planejada: necessidade,
      divergencia_planejamento: necessidade !== null && Math.abs(quantidade - necessidade) > 1e-9,
      estoque: {
        fisico: num(i.estoque_fisico),
        disponivel: num(i.estoque_disponivel),
        reservado: num(i.estoque_reservado),
        em_transito: num(i.estoque_transito),
      },
      demanda: {
        media_diaria: i.demanda_diaria !== null ? num(i.demanda_diaria) : null,
        prevista: i.demanda_prevista !== null ? num(i.demanda_prevista) : null,
        tendencia: i.tendencia,
        sazonal: i.sazonal,
        confiabilidade: i.confiabilidade,
      },
      quantidade: quantidadeOk,
      impacto,
      acima_necessidade: acimaNecessidade,
    };
  });

  const alertas: Array<{ tipo: string; mensagem: string; produto?: string }> = [];
  for (const l of linhas) {
    for (const p of l.quantidade.problemas) {
      alertas.push({ tipo: p.regra, mensagem: p.mensagem, produto: l.codigo });
    }
    if (l.acima_necessidade) {
      alertas.push({
        tipo: 'COMPRA_ACIMA_NECESSIDADE',
        mensagem: `${l.quantidade_pedida} contra necessidade de ${l.necessidade_planejada} `
          + `(${l.impacto.percentualAcimaNecessidade?.toFixed(1)}% acima)`,
        produto: l.codigo,
      });
    }
    if (l.impacto.riscoExcesso) {
      alertas.push({
        tipo: 'RISCO_EXCESSO',
        mensagem: `Cobertura apos a compra de ${l.impacto.coberturaAposCompraDias?.toFixed(0)} dias, `
          + `acima do limite de ${l.impacto.limiteCoberturaDias}`,
        produto: l.codigo,
      });
    }
    if (l.impacto.riscoRuptura) {
      alertas.push({
        tipo: 'RISCO_RUPTURA',
        mensagem: `Faltam ${l.impacto.quantidadeFaltante} para atender a necessidade`
          + (l.impacto.dataProvavelRuptura ? `; ruptura provavel em ${l.impacto.dataProvavelRuptura}` : ''),
        produto: l.codigo,
      });
    }
    if (l.divergencia_planejamento && !l.acima_necessidade) {
      alertas.push({
        tipo: 'PEDIDO_DIFERENTE_PLANEJAMENTO',
        mensagem: `Pedido de ${l.quantidade_pedida} contra planejamento de ${l.necessidade_planejada}`,
        produto: l.codigo,
      });
    }
  }

  const valor = num(pedido[0].valor_total);
  const alcada = await alcadaPara(valor);

  return {
    pedido_id: pedidoId,
    numero: pedido[0].numero,
    valor_total: valor,
    alcada_necessaria: alcada,
    itens: linhas,
    alertas,
    bloqueios: linhas.flatMap((l) => l.quantidade.problemas.map((p) => ({ produto: l.codigo, ...p }))),
    pode_aprovar: linhas.every((l) => l.quantidade.atende),
    exige_justificativa: alertas.some((a) =>
      ['COMPRA_ACIMA_NECESSIDADE', 'RISCO_EXCESSO'].includes(a.tipo))
      && (cfg['pedido.exigir_justificativa_excesso'] ?? 'true') === 'true',
  };
}

/** "O que acontece se eu aprovar este pedido?" (secao 66). Nao grava nada. */
export async function simularAprovacao(pedidoId: number) {
  const validacao = await validarPedido(pedidoId);
  const { rows: pedido } = await query(
    'SELECT numero, valor_total, data_prevista_entrega, moeda FROM ordens_compra WHERE id = $1',
    [pedidoId]);

  return {
    pedido: pedido[0],
    capital_comprometido: num(pedido[0]?.valor_total),
    data_chegada: pedido[0]?.data_prevista_entrega,
    itens: validacao.itens.map((i) => ({
      codigo: i.codigo,
      descricao: i.descricao,
      estoque_atual: i.estoque.disponivel,
      estoque_apos_compra: i.estoque.disponivel + i.quantidade_pedida,
      cobertura_atual_dias: i.impacto.coberturaAtualDias,
      cobertura_apos_compra_dias: i.impacto.coberturaAposCompraDias,
      risco_excesso: i.impacto.riscoExcesso,
      quantidade_excedente: i.impacto.quantidadeExcedente,
      risco_ruptura: i.impacto.riscoRuptura,
      quantidade_faltante: i.impacto.quantidadeFaltante,
    })),
    alertas: validacao.alertas,
    observacao: 'Simulacao. Nenhum dado oficial foi alterado',
  };
}

// ---------------------------------------------------------------------------
// Conversao negociacao -> pedido (secoes 24, 58 e 59)
// ---------------------------------------------------------------------------

export async function converterEmPedido(
  negociacaoId: number,
  entrada: z.output<typeof converterPedidoSchema>,
  contexto: ContextoSessao,
) {
  const cfg = await config();
  return comTransacao(contexto, async (cliente) => {
    // O lock impede que dois usuarios convertam a mesma negociacao ao mesmo
    // tempo; o indice unico em ordem_compra_id garante o resto (secao 59).
    const { rows } = await cliente.query(
      'SELECT * FROM negociacoes_compra WHERE id = $1 FOR UPDATE', [negociacaoId]);
    if (!rows.length) throw naoEncontrado('Negociacao');
    const n = rows[0];

    if (n.ordem_compra_id) {
      const { rows: existente } = await cliente.query(
        'SELECT numero FROM ordens_compra WHERE id = $1', [n.ordem_compra_id]);
      throw conflito(
        `Negociacao ja convertida no pedido ${existente[0]?.numero ?? n.ordem_compra_id}. `
        + 'Uma negociacao nao gera dois pedidos',
      );
    }
    if (n.status !== 'APROVADA') {
      throw regraNegocio(`Negociacao em ${n.status} nao pode virar pedido. Aprove antes`);
    }

    const { rows: itens } = await cliente.query(`
      SELECT ni.*, p.peso, p.unidade_compra_id, p.unidade_estoque_id
        FROM negociacao_itens ni JOIN produtos p ON p.id = ni.produto_id
       WHERE ni.negociacao_id = $1 ORDER BY ni.id`, [negociacaoId]);
    if (!itens.length) throw regraNegocio('Negociacao sem itens');

    const valorProdutos = itens.reduce((a, i) => a + num(i.custo_total_atual), 0);
    const frete = num(n.frete_atual);
    const impostos = num(n.impostos_atual);
    const outros = num(n.outros_atual);
    const total = custoTotal({
      valorProdutos, desconto: 0, frete, impostos,
      seguro: 0, desembaraco: 0, taxas: 0, outros,
    });

    const metodo = (entrada.metodo_rateio_frete
      ?? cfg['pedido.metodo_rateio_frete'] ?? 'VALOR') as MetodoRateio;
    const rateio = ratearFrete(
      itens.map((i) => ({
        id: Number(i.id),
        valor: num(i.custo_total_atual),
        peso: i.peso !== null ? num(i.peso) : null,
        quantidade: num(i.quantidade_atual),
      })),
      frete, metodo,
    );

    const numero = await proximoNumero(cliente);
    const dataPrevista = entrada.data_prevista_entrega
      ?? (n.prazo_entrega_atual !== null
        ? new Date(Date.now() + Number(n.prazo_entrega_atual) * 86400000).toISOString().slice(0, 10)
        : null);

    const { rows: pedido } = await cliente.query(`
      INSERT INTO ordens_compra
        (numero, fornecedor_id, cotacao_id, negociacao_id, comprador_id, responsavel_id,
         data_emissao, data_prevista_entrega, data_necessaria,
         valor_produtos, desconto, frete, impostos, outros_custos, valor_total,
         moeda, taxa_cambio, incoterm, condicao_pagamento_id, local_entrega_id,
         prioridade, status, metodo_rateio_frete, valor_bonificacao,
         economia_negociada, observacao)
      VALUES ($1,$2,$3,$4,$5,$5, CURRENT_DATE, $6, $7,
              $8, 0, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
              'RASCUNHO', $19, $20, $21, $22)
      RETURNING *`,
      [numero, n.fornecedor_id, n.cotacao_id, negociacaoId, contexto.usuarioId ?? null,
        dataPrevista, dataPrevista,
        valorProdutos, frete, impostos, outros, total,
        n.moeda, n.taxa_cambio, n.incoterm,
        entrada.condicao_pagamento_id ?? n.condicao_pagamento_id,
        entrada.local_entrega_id ?? null, n.prioridade, metodo,
        num(n.valor_bonificacao), num(n.economia_negociada),
        entrada.observacao ?? n.observacao]);
    const pedidoId = Number(pedido[0].id);

    for (const i of itens) {
      await cliente.query(`
        INSERT INTO ordem_compra_itens
          (ordem_compra_id, produto_id, cotacao_item_id, negociacao_item_id, necessidade_id,
           unidade_id, quantidade_pedida, quantidade_bonificada, quantidade_pendente,
           preco_unitario, preco_original, desconto, impostos, frete_rateado, valor_total,
           moq, multiplo, data_prevista_entrega, data_necessaria, observacao)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$18)`,
        [pedidoId, i.produto_id, i.cotacao_item_id, i.id, i.necessidade_id,
          i.unidade_id ?? i.unidade_compra_id ?? i.unidade_estoque_id,
          num(i.quantidade_atual), num(i.quantidade_bonificada),
          num(i.preco_atual), num(i.preco_inicial), num(i.desconto),
          num(i.impostos_item), rateio.get(Number(i.id)) ?? 0,
          num(i.custo_total_atual), i.moq, i.multiplo,
          i.data_entrega ?? dataPrevista, i.observacao]);
    }

    // Parcelas: usam COMPROMISSOS_COMPRA, que ja existia (secao 45).
    const { rows: condicao } = await cliente.query(
      'SELECT dias FROM condicoes_pagamento WHERE id = $1',
      [entrada.condicao_pagamento_id ?? n.condicao_pagamento_id]);
    const prazoPagamento = condicao[0]?.dias ?? n.prazo_pagamento_atual ?? 0;

    const parcelas = gerarParcelas(
      new Date().toISOString().slice(0, 10), total, Number(prazoPagamento),
      entrada.numero_parcelas, entrada.percentual_entrada,
    );
    for (const p of parcelas) {
      await cliente.query(`
        INSERT INTO compromissos_compra
          (ordem_compra_id, fornecedor_id, parcela, vencimento, valor, moeda,
           status, condicao_pagamento_id, percentual, entrada)
        VALUES ($1,$2,$3,$4,$5,$6,'PREVISTO',$7,$8,$9)`,
        [pedidoId, n.fornecedor_id, p.parcela, p.vencimento, p.valor, n.moeda,
          entrada.condicao_pagamento_id ?? n.condicao_pagamento_id, p.percentual, p.entrada]);
    }

    await cliente.query(
      "UPDATE negociacoes_compra SET status = 'CONVERTIDA_PEDIDO', ordem_compra_id = $2, updated_at = now() WHERE id = $1",
      [negociacaoId, pedidoId]);

    await registrarEvento(cliente, pedidoId, 'PEDIDO_CRIADO', null, 'RASCUNHO',
      contexto.usuarioId ?? null,
      `Criado a partir da negociacao ${n.numero}`,
      { negociacao: n.numero, cotacao_id: n.cotacao_id, itens: itens.length, parcelas: parcelas.length });

    const { rows: validacao } = await cliente.query(
      'SELECT id FROM ordem_compra_itens WHERE ordem_compra_id = $1', [pedidoId]);

    return { ...pedido[0], itens: validacao.length, parcelas: parcelas.length };
  });
}

// ---------------------------------------------------------------------------
// Fluxo do pedido
// ---------------------------------------------------------------------------

async function exigirTransicao(cliente: Cliente, pedidoId: number, novo: string) {
  const { rows } = await cliente.query(
    'SELECT * FROM ordens_compra WHERE id = $1 FOR UPDATE', [pedidoId]);
  if (!rows.length) throw naoEncontrado('Pedido de compra');
  const atual = rows[0].status;
  if (!TRANSICOES_PEDIDO[atual]?.includes(novo)) {
    throw regraNegocio(
      `Pedido em ${atual} nao pode ir para ${novo}. Possiveis - ${TRANSICOES_PEDIDO[atual]?.join(', ') || 'nenhuma'}`,
    );
  }
  return rows[0];
}

export async function enviarParaAprovacao(pedidoId: number, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    const pedido = await exigirTransicao(cliente, pedidoId, 'AGUARDANDO_APROVACAO');
    const alcada = await alcadaPara(num(pedido.valor_total));

    await cliente.query(`
      INSERT INTO pedido_aprovacoes (ordem_compra_id, nivel, perfil_exigido, valor_avaliado)
      VALUES ($1, $2, $3, $4)`,
      [pedidoId, alcada?.nome ?? 'UNICA', alcada?.perfil ?? null, num(pedido.valor_total)]);

    const { rows } = await cliente.query(
      "UPDATE ordens_compra SET status = 'AGUARDANDO_APROVACAO', updated_at = now() WHERE id = $1 RETURNING *",
      [pedidoId]);

    await registrarEvento(cliente, pedidoId, 'ENVIADO_APROVACAO', pedido.status,
      'AGUARDANDO_APROVACAO', contexto.usuarioId ?? null,
      `Aguardando aprovacao do perfil ${alcada?.perfil ?? 'responsavel'}`,
      { valor: num(pedido.valor_total), alcada: alcada?.nome });

    return { ...rows[0], alcada_necessaria: alcada };
  });
}

export async function aprovarPedido(
  pedidoId: number, perfilUsuario: string,
  entrada: z.output<typeof aprovarPedidoSchema>, contexto: ContextoSessao,
) {
  const validacao = await validarPedido(pedidoId);
  if (!validacao.pode_aprovar) {
    throw regraNegocio(
      `Pedido nao passa nas validacoes de quantidade - ${validacao.bloqueios.map((b) => b.mensagem).join('; ')}`,
    );
  }
  if (validacao.exige_justificativa && !entrada.justificativa && !entrada.excecoes?.length) {
    throw regraNegocio(
      'Pedido acima da necessidade ou com risco de excesso. Informe justificativa ou registre a excecao',
    );
  }

  return comTransacao(contexto, async (cliente) => {
    const pedido = await exigirTransicao(cliente, pedidoId, 'APROVADA');
    const valor = num(pedido.valor_total);
    const alcada = await alcadaPara(valor);

    if (perfilUsuario !== 'ADMIN' && alcada && alcada.perfil !== perfilUsuario) {
      throw semPermissao(`Valor de ${valor.toFixed(2)} exige aprovacao do perfil ${alcada.perfil}`);
    }

    const excecoes = (entrada.excecoes ?? []).map((e) => ({
      ...e, usuario_id: contexto.usuarioId ?? null, registrado_em: new Date().toISOString(),
    }));

    const cfg = await config();
    const reconhecer = (cfg['pedido.evento_economia_realizada'] ?? 'RECEBIDA') === 'APROVADA';

    const { rows } = await cliente.query(`
      UPDATE ordens_compra
         SET status = 'APROVADA', aprovador_id = $2, data_aprovacao = now(),
             nivel_aprovacao = $3,
             excecoes = excecoes || $4::jsonb,
             validacoes = $5::jsonb,
             alertas = $6::jsonb,
             economia_realizada = CASE WHEN $7 THEN economia_negociada ELSE economia_realizada END,
             economia_reconhecida_em = CASE WHEN $7 THEN now() ELSE economia_reconhecida_em END,
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [pedidoId, contexto.usuarioId ?? null, alcada?.perfil ?? perfilUsuario,
        JSON.stringify(excecoes),
        JSON.stringify({ pode_aprovar: true, itens: validacao.itens.length }),
        JSON.stringify(validacao.alertas), reconhecer]);

    await cliente.query(`
      UPDATE pedido_aprovacoes
         SET status = 'APROVADA', usuario_id = $2, decidido_em = now(), observacao = $3
       WHERE ordem_compra_id = $1 AND status = 'PENDENTE'`,
      [pedidoId, contexto.usuarioId ?? null, entrada.justificativa ?? null]);

    await registrarEvento(cliente, pedidoId, 'APROVADO', pedido.status, 'APROVADA',
      contexto.usuarioId ?? null, entrada.justificativa ?? null,
      { valor, alcada: alcada?.nome, excecoes: excecoes.length, alertas: validacao.alertas.length });

    return rows[0];
  });
}

export async function rejeitarPedido(
  pedidoId: number, entrada: z.output<typeof rejeitarSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const pedido = await exigirTransicao(cliente, pedidoId, 'REJEITADA');
    const { rows } = await cliente.query(`
      UPDATE ordens_compra
         SET status = 'REJEITADA', motivo_rejeicao = $2::motivo_rejeicao_enum,
             justificativa_rejeicao = $3, aprovador_id = $4, data_aprovacao = now(),
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [pedidoId, entrada.motivo, entrada.justificativa, contexto.usuarioId ?? null]);

    await cliente.query(`
      UPDATE pedido_aprovacoes SET status = 'REJEITADA', usuario_id = $2,
             decidido_em = now(), observacao = $3
       WHERE ordem_compra_id = $1 AND status = 'PENDENTE'`,
      [pedidoId, contexto.usuarioId ?? null, entrada.justificativa]);

    await registrarEvento(cliente, pedidoId, 'REJEITADO', pedido.status, 'REJEITADA',
      contexto.usuarioId ?? null, entrada.justificativa, { motivo: entrada.motivo });

    return rows[0];
  });
}

export async function enviarPedido(
  pedidoId: number, entrada: z.output<typeof enviarPedidoSchema>, contexto: ContextoSessao,
) {
  const cfg = await config();
  return comTransacao(contexto, async (cliente) => {
    const pedido = await exigirTransicao(cliente, pedidoId, 'ENVIADA');
    const reconhecer = (cfg['pedido.evento_economia_realizada'] ?? 'RECEBIDA') === 'ENVIADA';

    const { rows } = await cliente.query(`
      UPDATE ordens_compra
         SET status = 'ENVIADA', data_envio = now(), canal_envio = $2,
             economia_realizada = CASE WHEN $3 THEN economia_negociada ELSE economia_realizada END,
             economia_reconhecida_em = CASE WHEN $3 THEN now() ELSE economia_reconhecida_em END,
             updated_at = now()
       WHERE id = $1 RETURNING *`, [pedidoId, entrada.canal, reconhecer]);

    await registrarEvento(cliente, pedidoId, 'ENVIADO_FORNECEDOR', pedido.status, 'ENVIADA',
      contexto.usuarioId ?? null, entrada.observacao ?? null, { canal: entrada.canal });

    return rows[0];
  });
}

/**
 * Confirmacao do fornecedor. O pedido original nao e alterado: o que entra e a
 * quantidade confirmada e a pendente, mais as divergencias (secoes 36, 37 e 40).
 */
export async function confirmarPedido(
  pedidoId: number, entrada: z.output<typeof confirmarPedidoSchema>, contexto: ContextoSessao,
) {
  const cfg = await config();
  const tolerancia = Number(cfg['pedido.tolerancia_divergencia_percentual'] ?? 2);

  return comTransacao(contexto, async (cliente) => {
    const pedido = await exigirTransicao(cliente, pedidoId, 'CONFIRMADA');

    const { rows: itens } = await cliente.query(
      'SELECT * FROM ordem_compra_itens WHERE ordem_compra_id = $1', [pedidoId]);
    const porId = new Map(itens.map((i) => [Number(i.id), i]));

    const divergencias: Array<Record<string, unknown>> = [];

    for (const item of entrada.itens) {
      const atual = porId.get(item.ordem_compra_item_id);
      if (!atual) throw regraNegocio(`Item ${item.ordem_compra_item_id} nao pertence a este pedido`);

      const lista = compararConfirmacao(
        {
          quantidade: num(atual.quantidade_pedida),
          preco: num(atual.preco_unitario),
          prazoDias: null,
          dataPrometida: atual.data_prevista_entrega
            ? new Date(atual.data_prevista_entrega).toISOString().slice(0, 10) : null,
        },
        {
          quantidade: item.quantidade_confirmada,
          preco: item.preco_unitario ?? null,
          prazoDias: null,
          dataPrometida: item.data_prometida ?? null,
        },
        tolerancia,
      );
      if (lista.length) {
        divergencias.push({
          ordem_compra_item_id: item.ordem_compra_item_id,
          produto_id: atual.produto_id,
          divergencias: lista,
        });
      }

      const pendente = Math.max(0, num(atual.quantidade_pedida) - item.quantidade_confirmada);
      await cliente.query(`
        UPDATE ordem_compra_itens
           SET quantidade_confirmada = $2, quantidade_pendente = $3,
               data_prometida = coalesce($4::date, data_prometida), updated_at = now()
         WHERE id = $1`,
        [item.ordem_compra_item_id, item.quantidade_confirmada, pendente,
          item.data_prometida ?? null]);
    }

    const { rows: confirmacao } = await cliente.query(`
      INSERT INTO pedido_confirmacoes
        (ordem_compra_id, numero_pedido_fornecedor, canal, data_prometida,
         divergencias, observacao, usuario_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [pedidoId, entrada.numero_pedido_fornecedor ?? null, entrada.canal ?? null,
        entrada.data_prometida ?? null, JSON.stringify(divergencias),
        entrada.observacao ?? null, contexto.usuarioId ?? null]);

    const cfgReconhecer = (cfg['pedido.evento_economia_realizada'] ?? 'RECEBIDA') === 'CONFIRMADA';

    const { rows } = await cliente.query(`
      UPDATE ordens_compra
         SET status = 'CONFIRMADA', data_confirmacao = now(),
             numero_pedido_fornecedor = coalesce($2, numero_pedido_fornecedor),
             data_prometida = coalesce($3::date, data_prometida),
             alertas = alertas || $4::jsonb,
             economia_realizada = CASE WHEN $5 THEN economia_negociada ELSE economia_realizada END,
             economia_reconhecida_em = CASE WHEN $5 THEN now() ELSE economia_reconhecida_em END,
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [pedidoId, entrada.numero_pedido_fornecedor ?? null, entrada.data_prometida ?? null,
        JSON.stringify(divergencias.length
          ? [{ tipo: 'ALTERACAO_PELO_FORNECEDOR', mensagem: `${divergencias.length} item(ns) com divergencia na confirmacao` }]
          : []),
        cfgReconhecer]);

    await registrarEvento(cliente, pedidoId, 'CONFIRMADO_FORNECEDOR', pedido.status, 'CONFIRMADA',
      contexto.usuarioId ?? null,
      divergencias.length ? 'Confirmacao com divergencias' : 'Confirmacao sem divergencias',
      { divergencias, numero_fornecedor: entrada.numero_pedido_fornecedor });

    return { pedido: rows[0], confirmacao: confirmacao[0], divergencias };
  });
}

/**
 * Pedido aprovado nao se edita: abre-se uma solicitacao de alteracao, que e
 * decidida separadamente e pode obrigar nova aprovacao (secao 38).
 */
export async function solicitarAlteracao(
  pedidoId: number, entrada: z.output<typeof solicitarAlteracaoSchema>, contexto: ContextoSessao,
) {
  const cfg = await config();
  const limite = Number(cfg['pedido.percentual_alteracao_reaprovacao'] ?? 10);

  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM ordens_compra WHERE id = $1 FOR UPDATE', [pedidoId]);
    if (!rows.length) throw naoEncontrado('Pedido de compra');
    const pedido = rows[0];

    if (['RASCUNHO', 'AGUARDANDO_APROVACAO'].includes(pedido.status)) {
      throw regraNegocio(
        `Pedido em ${pedido.status} ainda pode ser editado diretamente. `
        + 'Solicitacao de alteracao serve para pedido aprovado',
      );
    }
    if (['CANCELADA', 'REJEITADA', 'FINALIZADA'].includes(pedido.status)) {
      throw regraNegocio(`Pedido em ${pedido.status} nao aceita alteracao`);
    }

    const { rows: itens } = await cliente.query(
      'SELECT * FROM ordem_compra_itens WHERE ordem_compra_id = $1', [pedidoId]);
    const porId = new Map(itens.map((i) => [Number(i.id), i]));

    // Estima o valor resultante para decidir se a alcada muda.
    let valorEstimado = num(pedido.valor_total);
    for (const a of entrada.alteracoes) {
      if (a.campo === 'frete') {
        valorEstimado = valorEstimado - num(pedido.frete) + Number(a.valor_novo);
      } else if (a.ordem_compra_item_id && ['quantidade_pedida', 'preco_unitario'].includes(a.campo)) {
        const item = porId.get(a.ordem_compra_item_id);
        if (!item) throw regraNegocio(`Item ${a.ordem_compra_item_id} nao pertence a este pedido`);
        const quantidade = a.campo === 'quantidade_pedida'
          ? Number(a.valor_novo) : num(item.quantidade_pedida);
        const preco = a.campo === 'preco_unitario'
          ? Number(a.valor_novo) : num(item.preco_unitario);
        valorEstimado = valorEstimado - num(item.valor_total) + quantidade * preco;
      }
    }

    const variacao = num(pedido.valor_total) > 0
      ? Math.abs((valorEstimado - num(pedido.valor_total)) / num(pedido.valor_total)) * 100 : 0;
    const exigeReaprovacao = variacao > limite;

    const criadas: Record<string, unknown>[] = [];
    for (const a of entrada.alteracoes) {
      const item = a.ordem_compra_item_id ? porId.get(a.ordem_compra_item_id) : null;
      const valorAnterior = item
        ? String(item[a.campo] ?? '')
        : String(pedido[a.campo] ?? '');

      const { rows: alteracao } = await cliente.query(`
        INSERT INTO pedido_alteracoes
          (ordem_compra_id, campo, item_id, valor_anterior, valor_novo, motivo,
           exige_reaprovacao, solicitado_por)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [pedidoId, a.campo, a.ordem_compra_item_id ?? null, valorAnterior, a.valor_novo,
          entrada.motivo, exigeReaprovacao, contexto.usuarioId ?? null]);
      criadas.push(alteracao[0]);
    }

    await registrarEvento(cliente, pedidoId, 'ALTERACAO_SOLICITADA', pedido.status, pedido.status,
      contexto.usuarioId ?? null, entrada.motivo,
      { alteracoes: criadas.length, variacao_percentual: variacao, exige_reaprovacao: exigeReaprovacao });

    return {
      alteracoes: criadas,
      valor_atual: num(pedido.valor_total),
      valor_estimado: valorEstimado,
      variacao_percentual: variacao,
      exige_reaprovacao: exigeReaprovacao,
      limite_percentual: limite,
    };
  });
}

export async function decidirAlteracao(
  alteracaoId: number, entrada: z.output<typeof decidirAlteracaoSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM pedido_alteracoes WHERE id = $1 FOR UPDATE', [alteracaoId]);
    if (!rows.length) throw naoEncontrado('Solicitacao de alteracao');
    const a = rows[0];
    if (a.status !== 'SOLICITADA') {
      throw regraNegocio(`Alteracao em ${a.status} ja foi decidida`);
    }

    if (!entrada.aprovar) {
      const { rows: rejeitada } = await cliente.query(`
        UPDATE pedido_alteracoes
           SET status = 'REJEITADA', decidido_por = $2, decidido_em = now(), observacao_decisao = $3
         WHERE id = $1 RETURNING *`,
        [alteracaoId, contexto.usuarioId ?? null, entrada.observacao ?? null]);
      await registrarEvento(cliente, Number(a.ordem_compra_id), 'ALTERACAO_REJEITADA',
        null, null, contexto.usuarioId ?? null, entrada.observacao ?? null, { campo: a.campo });
      return rejeitada[0];
    }

    // Aplica a alteracao e recalcula os totais do pedido.
    if (a.item_id) {
      await cliente.query(
        `UPDATE ordem_compra_itens SET ${a.campo} = $2, updated_at = now() WHERE id = $1`,
        [a.item_id, a.valor_novo]);
      await cliente.query(`
        UPDATE ordem_compra_itens
           SET valor_total = quantidade_pedida * preco_unitario - desconto
         WHERE id = $1`, [a.item_id]);
    } else {
      await cliente.query(
        `UPDATE ordens_compra SET ${a.campo} = $2, updated_at = now() WHERE id = $1`,
        [a.ordem_compra_id, a.valor_novo]);
    }

    await cliente.query(`
      UPDATE ordens_compra oc
         SET valor_produtos = t.produtos,
             valor_total = t.produtos - oc.desconto + oc.frete + oc.impostos
                           + oc.seguro + oc.desembaraco + oc.taxas + oc.outros_custos,
             updated_at = now()
        FROM (SELECT coalesce(sum(valor_total), 0) AS produtos
                FROM ordem_compra_itens WHERE ordem_compra_id = $1) t
       WHERE oc.id = $1`, [a.ordem_compra_id]);

    const { rows: pedido } = await cliente.query(
      'SELECT * FROM ordens_compra WHERE id = $1', [a.ordem_compra_id]);

    let statusNovo = pedido[0].status;
    if (a.exige_reaprovacao) {
      const alcada = await alcadaPara(num(pedido[0].valor_total));
      await cliente.query(`
        INSERT INTO pedido_aprovacoes (ordem_compra_id, nivel, perfil_exigido, valor_avaliado)
        VALUES ($1, $2, $3, $4)`,
        [a.ordem_compra_id, alcada?.nome ?? 'REAPROVACAO', alcada?.perfil ?? null,
          num(pedido[0].valor_total)]);
      await cliente.query(
        "UPDATE ordens_compra SET status = 'AGUARDANDO_APROVACAO', updated_at = now() WHERE id = $1",
        [a.ordem_compra_id]);
      statusNovo = 'AGUARDANDO_APROVACAO';
    }

    const { rows: aplicada } = await cliente.query(`
      UPDATE pedido_alteracoes
         SET status = 'APLICADA', decidido_por = $2, decidido_em = now(), observacao_decisao = $3
       WHERE id = $1 RETURNING *`,
      [alteracaoId, contexto.usuarioId ?? null, entrada.observacao ?? null]);

    await registrarEvento(cliente, Number(a.ordem_compra_id), 'ALTERACAO_APLICADA',
      pedido[0].status, statusNovo, contexto.usuarioId ?? null, a.motivo,
      { campo: a.campo, anterior: a.valor_anterior, novo: a.valor_novo,
        exige_reaprovacao: a.exige_reaprovacao });

    return { ...aplicada[0], status_pedido: statusNovo, valor_total: num(pedido[0].valor_total) };
  });
}

export async function cancelarPedido(
  pedidoId: number, entrada: z.output<typeof cancelarPedidoSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const pedido = await exigirTransicao(cliente, pedidoId, 'CANCELADA');

    const { rows } = await cliente.query(`
      UPDATE ordens_compra
         SET status = 'CANCELADA', motivo_cancelamento = $2::motivo_cancelamento_enum,
             justificativa_cancelamento = $3, cancelado_por = $4, cancelado_em = now(),
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [pedidoId, entrada.motivo, entrada.justificativa, contexto.usuarioId ?? null]);

    await cliente.query(
      "UPDATE compromissos_compra SET status = 'CANCELADO' WHERE ordem_compra_id = $1 AND status = 'PREVISTO'",
      [pedidoId]);

    await registrarEvento(cliente, pedidoId, 'CANCELADO', pedido.status, 'CANCELADA',
      contexto.usuarioId ?? null, entrada.justificativa, { motivo: entrada.motivo });

    return rows[0];
  });
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export async function listarPedidos(filtro: z.output<typeof listarPedidosSchema> & Paginacao) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  if (filtro.status) { valores.push(filtro.status); cond.push(`oc.status = $${valores.length}`); }
  if (filtro.fornecedor_id) { valores.push(filtro.fornecedor_id); cond.push(`oc.fornecedor_id = $${valores.length}`); }
  if (filtro.comprador_id) { valores.push(filtro.comprador_id); cond.push(`oc.comprador_id = $${valores.length}`); }
  if (filtro.data_inicio) { valores.push(filtro.data_inicio); cond.push(`oc.data_emissao >= $${valores.length}`); }
  if (filtro.data_fim) { valores.push(filtro.data_fim); cond.push(`oc.data_emissao <= $${valores.length}`); }
  if (filtro.apenas_atrasados) {
    cond.push(`oc.data_prevista_entrega < CURRENT_DATE
               AND oc.status IN ('ENVIADA','CONFIRMADA','EM_PRODUCAO','EM_TRANSITO','RECEBIMENTO_PARCIAL')`);
  }
  if (filtro.apenas_parciais) {
    cond.push(`EXISTS (SELECT 1 FROM ordem_compra_itens i
                        WHERE i.ordem_compra_id = oc.id AND coalesce(i.quantidade_pendente, 0) > 0)`);
  }
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(oc.numero ILIKE $${valores.length} OR f.razao_social ILIKE $${valores.length}
                OR oc.numero_pedido_fornecedor ILIKE $${valores.length})`);
  }
  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM ordens_compra oc
       JOIN fornecedores f ON f.id = oc.fornecedor_id ${onde}`, valores);

  const { rows } = await query(`
    SELECT oc.*, f.razao_social AS fornecedor, u.nome AS comprador, a.nome AS aprovador,
           n.numero AS negociacao, c.numero AS cotacao, cp.nome AS condicao_pagamento,
           (SELECT count(*)::int FROM ordem_compra_itens i WHERE i.ordem_compra_id = oc.id) AS itens,
           (SELECT coalesce(sum(i.quantidade_pendente), 0) FROM ordem_compra_itens i
             WHERE i.ordem_compra_id = oc.id) AS quantidade_pendente,
           (oc.data_prevista_entrega < CURRENT_DATE
            AND oc.status IN ('ENVIADA','CONFIRMADA','EM_PRODUCAO','EM_TRANSITO','RECEBIMENTO_PARCIAL')) AS atrasado
      FROM ordens_compra oc
      JOIN fornecedores f ON f.id = oc.fornecedor_id
      LEFT JOIN usuarios u ON u.id = oc.comprador_id
      LEFT JOIN usuarios a ON a.id = oc.aprovador_id
      LEFT JOIN negociacoes_compra n ON n.id = oc.negociacao_id
      LEFT JOIN cotacoes c ON c.id = oc.cotacao_id
      LEFT JOIN condicoes_pagamento cp ON cp.id = oc.condicao_pagamento_id
      ${onde}
     ORDER BY oc.data_emissao DESC, oc.id DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return { dados: rows, meta: metaPaginacao(total.rows[0]?.total ?? 0, filtro) };
}

export async function detalharPedido(pedidoId: number) {
  const { rows } = await query(`
    SELECT oc.*, f.razao_social AS fornecedor, f.cnpj, f.email AS fornecedor_email,
           f.telefone AS fornecedor_telefone, f.origem_fornecedor,
           u.nome AS comprador, a.nome AS aprovador, cn.nome AS cancelado_por_nome,
           n.numero AS negociacao, n.economia_negociada, n.rodada_atual,
           c.numero AS cotacao, cp.nome AS condicao_pagamento, cp.dias AS condicao_dias,
           l.nome AS local_entrega
      FROM ordens_compra oc
      JOIN fornecedores f ON f.id = oc.fornecedor_id
      LEFT JOIN usuarios u ON u.id = oc.comprador_id
      LEFT JOIN usuarios a ON a.id = oc.aprovador_id
      LEFT JOIN usuarios cn ON cn.id = oc.cancelado_por
      LEFT JOIN negociacoes_compra n ON n.id = oc.negociacao_id
      LEFT JOIN cotacoes c ON c.id = oc.cotacao_id
      LEFT JOIN condicoes_pagamento cp ON cp.id = oc.condicao_pagamento_id
      LEFT JOIN locais l ON l.id = oc.local_entrega_id
     WHERE oc.id = $1`, [pedidoId]);
  if (!rows.length) throw naoEncontrado('Pedido de compra');

  const [itens, parcelas, aprovacoes, alteracoes, confirmacoes, historico, rastreabilidade] =
    await Promise.all([
      query(`
        SELECT oci.*, p.codigo, p.ean, p.descricao, p.peso, un.codigo AS unidade
          FROM ordem_compra_itens oci
          JOIN produtos p ON p.id = oci.produto_id
          LEFT JOIN unidades un ON un.id = coalesce(oci.unidade_id, p.unidade_compra_id, p.unidade_estoque_id)
         WHERE oci.ordem_compra_id = $1 ORDER BY p.descricao`, [pedidoId]),
      query('SELECT * FROM compromissos_compra WHERE ordem_compra_id = $1 ORDER BY parcela', [pedidoId]),
      query(`
        SELECT pa.*, u.nome AS usuario FROM pedido_aprovacoes pa
        LEFT JOIN usuarios u ON u.id = pa.usuario_id
         WHERE pa.ordem_compra_id = $1 ORDER BY pa.created_at`, [pedidoId]),
      query(`
        SELECT al.*, s.nome AS solicitante, d.nome AS decisor
          FROM pedido_alteracoes al
          LEFT JOIN usuarios s ON s.id = al.solicitado_por
          LEFT JOIN usuarios d ON d.id = al.decidido_por
         WHERE al.ordem_compra_id = $1 ORDER BY al.solicitado_em DESC`, [pedidoId]),
      query(`
        SELECT pc.*, u.nome AS usuario FROM pedido_confirmacoes pc
        LEFT JOIN usuarios u ON u.id = pc.usuario_id
         WHERE pc.ordem_compra_id = $1 ORDER BY pc.data_confirmacao DESC`, [pedidoId]),
      query(`
        SELECT ph.*, u.nome AS usuario FROM pedido_historico ph
        LEFT JOIN usuarios u ON u.id = ph.usuario_id
         WHERE ph.ordem_compra_id = $1 ORDER BY ph.created_at DESC`, [pedidoId]),
      query('SELECT * FROM vw_rastreabilidade_compra WHERE ordem_compra_id = $1', [pedidoId]),
    ]);

  const detalhe: Record<string, any> = {
    ...rows[0],
    itens: itens.rows,
    parcelas: parcelas.rows,
    aprovacoes: aprovacoes.rows,
    alteracoes: alteracoes.rows,
    confirmacoes: confirmacoes.rows,
    historico: historico.rows,
    rastreabilidade: rastreabilidade.rows,
  };
  return detalhe;
}

/** Documento oficial do pedido (secao 35). */
export async function documentoPedido(pedidoId: number) {
  const pedido = await detalharPedido(pedidoId);
  return {
    cabecalho: {
      numero: pedido.numero,
      data_emissao: pedido.data_emissao,
      fornecedor: pedido.fornecedor,
      cnpj: pedido.cnpj,
      email: pedido.fornecedor_email,
      telefone: pedido.fornecedor_telefone,
      comprador: pedido.comprador,
      local_entrega: pedido.local_entrega,
      data_prevista_entrega: pedido.data_prevista_entrega,
      condicao_pagamento: pedido.condicao_pagamento,
      moeda: pedido.moeda,
      incoterm: pedido.incoterm,
      observacao: pedido.observacao,
    },
    itens: pedido.itens.map((i: any) => ({
      codigo: i.codigo, ean: i.ean, descricao: i.descricao,
      quantidade: num(i.quantidade_pedida), bonificada: num(i.quantidade_bonificada),
      unidade: i.unidade, preco_unitario: num(i.preco_unitario),
      desconto: num(i.desconto), impostos: num(i.impostos),
      frete_rateado: num(i.frete_rateado), valor_total: num(i.valor_total),
      data_prometida: i.data_prometida ?? i.data_prevista_entrega,
    })),
    totais: {
      valor_produtos: num(pedido.valor_produtos),
      desconto: num(pedido.desconto),
      frete: num(pedido.frete),
      impostos: num(pedido.impostos),
      seguro: num(pedido.seguro),
      desembaraco: num(pedido.desembaraco),
      taxas: num(pedido.taxas),
      outros: num(pedido.outros_custos),
      valor_total: num(pedido.valor_total),
    },
    parcelas: pedido.parcelas,
    condicoes_gerais:
      'Mercadoria sujeita a conferencia e inspecao no recebimento. Divergencia de quantidade, '
      + 'preco ou prazo deve ser comunicada antes do faturamento.',
  };
}

/** Pacote para o MODULO 08 (secao 82). Nenhum recebimento e criado aqui. */
export async function pacoteAcompanhamento(pedidoId: number) {
  const { rows } = await query(`
    SELECT oc.id, oc.numero, oc.status, oc.data_emissao, oc.data_envio, oc.data_confirmacao,
           oc.data_prevista_entrega, oc.data_prometida, oc.data_necessaria,
           oc.numero_pedido_fornecedor, oc.condicao_pagamento_id, oc.local_entrega_id,
           f.id AS fornecedor_id, f.razao_social AS fornecedor,
           f.lead_time_padrao_dias, l.nome AS local_entrega
      FROM ordens_compra oc
      JOIN fornecedores f ON f.id = oc.fornecedor_id
      LEFT JOIN locais l ON l.id = oc.local_entrega_id
     WHERE oc.id = $1`, [pedidoId]);
  if (!rows.length) throw naoEncontrado('Pedido de compra');

  const { rows: itens } = await query(`
    SELECT oci.id AS ordem_compra_item_id, p.id AS produto_id, p.codigo, p.descricao,
           oci.quantidade_pedida, oci.quantidade_confirmada, oci.quantidade_pendente,
           oci.quantidade_recebida, oci.quantidade_bonificada,
           oci.preco_unitario, oci.data_prometida, oci.data_necessaria
      FROM ordem_compra_itens oci
      JOIN produtos p ON p.id = oci.produto_id
     WHERE oci.ordem_compra_id = $1 ORDER BY p.descricao`, [pedidoId]);

  return { pedido: rows[0], itens };
}
