import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { conflito, naoEncontrado, regraNegocio, semPermissao } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import type { z } from 'zod';
import type {
  criarNegociacaoSchema, listarNegociacoesSchema, rejeitarSchema,
  rodadaSchema, simularVolumeSchema,
} from './negociacao.schemas.js';
import {
  bonificacao, comparativoAntesDepois, custoTotal, economia,
} from './calculos.js';

type Cliente = { query: (t: string, v?: unknown[]) => Promise<{ rows: any[] }> };

export const TRANSICOES: Record<string, string[]> = {
  RASCUNHO: ['ABERTA', 'CANCELADA'],
  ABERTA: ['EM_NEGOCIACAO', 'AGUARDANDO_FORNECEDOR', 'ACORDADA', 'REJEITADA', 'CANCELADA'],
  EM_NEGOCIACAO: ['AGUARDANDO_FORNECEDOR', 'CONTRAPROPOSTA_RECEBIDA', 'EM_ANALISE', 'ACORDADA', 'REJEITADA', 'CANCELADA'],
  AGUARDANDO_FORNECEDOR: ['CONTRAPROPOSTA_RECEBIDA', 'EM_NEGOCIACAO', 'EM_ANALISE', 'REJEITADA', 'CANCELADA'],
  CONTRAPROPOSTA_RECEBIDA: ['EM_ANALISE', 'EM_NEGOCIACAO', 'ACORDADA', 'REJEITADA', 'CANCELADA'],
  EM_ANALISE: ['EM_NEGOCIACAO', 'ACORDADA', 'REJEITADA', 'CANCELADA'],
  ACORDADA: ['APROVADA', 'EM_NEGOCIACAO', 'REJEITADA', 'CANCELADA'],
  APROVADA: ['CONVERTIDA_PEDIDO', 'CANCELADA'],
  CONVERTIDA_PEDIDO: [],
  REJEITADA: [],
  CANCELADA: [],
};

const num = (v: unknown): number => Number(v ?? 0);

async function proximoNumero(cliente: Cliente) {
  const { rows } = await cliente.query(`
    SELECT 'NEG-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' ||
           lpad((count(*) + 1)::text, 3, '0') AS numero
      FROM negociacoes_compra WHERE data_abertura = CURRENT_DATE`);
  return rows[0].numero as string;
}

async function config(): Promise<Record<string, string>> {
  const { rows } = await query<{ chave: string; valor: string }>(
    "SELECT chave, valor FROM configuracoes WHERE grupo IN ('pedido', 'planejamento')");
  return Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
}

// ---------------------------------------------------------------------------
// Criacao
// ---------------------------------------------------------------------------

type Criar = z.output<typeof criarNegociacaoSchema>;

/**
 * Cria a negociacao. Vindo do modulo 06, tudo que a cotacao ja decidiu e
 * carregado: fornecedor, produtos, quantidades, precos, frete, impostos,
 * prazos, MOQ, multiplo, moeda, incoterm e o preco-alvo (secao 6).
 */
export async function criarNegociacao(entrada: Criar, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    let fornecedorId = entrada.fornecedor_id ?? null;
    let cotacaoId = entrada.cotacao_id ?? null;
    let moeda = 'BRL';
    let taxaCambio: number | null = null;
    let incoterm: string | null = null;
    let prazoEntrega: number | null = null;
    let prazoPagamento = entrada.prazo_pagamento_dias ?? null;
    let frete = entrada.frete ?? 0;
    let impostos = entrada.impostos ?? 0;
    let outros = 0;
    let prioridade = entrada.prioridade ?? 'MEDIA';

    interface ItemBase {
      produto_id: number; cotacao_item_id: number | null; necessidade_id: number | null;
      unidade_id: number | null; quantidade: number; preco: number;
      preco_alvo: number | null; moq: number | null; multiplo: number | null;
      prazo: number | null; validade: number | null;
    }
    let itens: ItemBase[] = [];

    if (cotacaoId) {
      const { rows: cot } = await cliente.query(
        'SELECT * FROM cotacoes WHERE id = $1 FOR UPDATE', [cotacaoId]);
      if (!cot.length) throw naoEncontrado('Cotacao');
      const c = cot[0];
      if (!['APROVADA_NEGOCIACAO', 'ENCAMINHADA'].includes(c.status)) {
        throw regraNegocio(
          `Cotacao em ${c.status} nao pode virar negociacao. Aprove a cotacao no modulo 06 antes`,
        );
      }

      const { rows: selecionados } = await cliente.query(`
        SELECT ci.*, cp.quantidade AS quantidade_pedida, cp.preco_alvo, cp.necessidade_id,
               cp.unidade_id, cp.validade_minima_dias
          FROM cotacao_itens ci
          JOIN cotacao_produtos cp ON cp.id = ci.cotacao_produto_id
         WHERE ci.cotacao_id = $1 AND ci.selecionado`, [cotacaoId]);
      if (!selecionados.length) {
        throw regraNegocio('Cotacao aprovada sem propostas selecionadas');
      }

      const fornecedores = [...new Set(selecionados.map((s) => Number(s.fornecedor_id)))];
      if (entrada.fornecedor_id) {
        if (!fornecedores.includes(entrada.fornecedor_id)) {
          throw regraNegocio('Fornecedor informado nao tem proposta selecionada nesta cotacao');
        }
        fornecedorId = entrada.fornecedor_id;
      } else if (fornecedores.length > 1) {
        throw regraNegocio(
          `A cotacao tem propostas selecionadas de ${fornecedores.length} fornecedores. `
          + 'Informe o fornecedor: cada um vira uma negociacao',
        );
      } else {
        fornecedorId = fornecedores[0]!;
      }

      // Uma cotacao aprovada gera uma negociacao por fornecedor. Abrir uma
      // segunda para o mesmo fornecedor duplicaria o compromisso de compra;
      // a cotacao esta travada acima, o que serializa esta checagem.
      const { rows: jaAberta } = await cliente.query(`
        SELECT numero, status FROM negociacoes_compra
         WHERE cotacao_id = $1 AND fornecedor_id = $2
           AND status NOT IN ('REJEITADA', 'CANCELADA')`, [cotacaoId, fornecedorId]);
      if (jaAberta.length) {
        throw conflito(
          `A cotacao ja tem a negociacao ${jaAberta[0].numero} (${jaAberta[0].status}) `
          + 'com este fornecedor. Conduza aquela ou cancele antes de abrir outra',
        );
      }

      const doFornecedor = selecionados.filter((s) => Number(s.fornecedor_id) === fornecedorId);
      moeda = doFornecedor[0]?.moeda ?? 'BRL';
      taxaCambio = doFornecedor[0]?.taxa_cambio ?? null;
      incoterm = doFornecedor[0]?.incoterm ?? null;
      prazoEntrega = doFornecedor[0]?.prazo_entrega_dias ?? null;
      prazoPagamento = prazoPagamento ?? doFornecedor[0]?.prazo_pagamento_dias ?? null;
      frete = doFornecedor.reduce((a, s) => a + num(s.frete), 0);
      impostos = doFornecedor.reduce((a, s) => a + num(s.impostos), 0);
      outros = doFornecedor.reduce(
        (a, s) => a + num(s.seguro) + num(s.desembaraco) + num(s.taxas) + num(s.outros_custos), 0);
      prioridade = c.prioridade ?? prioridade;

      itens = doFornecedor.map((s) => ({
        produto_id: Number(s.produto_id),
        cotacao_item_id: Number(s.id),
        necessidade_id: s.necessidade_id ? Number(s.necessidade_id) : null,
        unidade_id: s.unidade_id ? Number(s.unidade_id) : null,
        quantidade: num(s.quantidade_ofertada) || num(s.quantidade_pedida),
        preco: num(s.preco_unitario),
        preco_alvo: s.preco_alvo !== null ? num(s.preco_alvo) : null,
        moq: s.moq !== null ? num(s.moq) : null,
        multiplo: s.multiplo !== null ? num(s.multiplo) : null,
        prazo: s.prazo_entrega_dias !== null ? Number(s.prazo_entrega_dias) : null,
        validade: s.validade_minima_dias !== null ? Number(s.validade_minima_dias) : null,
      }));
    } else {
      const { rows: forn } = await cliente.query(`
        SELECT id, lead_time_padrao_dias, prazo_medio_pagamento
          FROM fornecedores WHERE id = $1 AND ativo AND deleted_at IS NULL`, [fornecedorId]);
      if (!forn.length) throw regraNegocio('Fornecedor inexistente ou inativo');

      itens = (entrada.itens ?? []).map((i) => ({
        produto_id: i.produto_id,
        cotacao_item_id: null,
        necessidade_id: null,
        unidade_id: null,
        quantidade: i.quantidade,
        preco: i.preco_unitario,
        preco_alvo: i.preco_alvo ?? null,
        moq: i.moq ?? null,
        multiplo: i.multiplo ?? null,
        prazo: i.prazo_entrega_dias ?? null,
        validade: null,
      }));

      // Na negociacao manual o prazo e o do item mais demorado e, na falta
      // dele, o padrao do fornecedor: sem prazo a negociacao nunca fecha,
      // porque o acordo exige prazo de entrega e de pagamento (secao 22).
      const prazos = itens.map((i) => i.prazo).filter((p): p is number => p !== null);
      prazoEntrega = prazos.length
        ? Math.max(...prazos)
        : (forn[0].lead_time_padrao_dias ?? null);
      prazoPagamento = prazoPagamento ?? forn[0].prazo_medio_pagamento ?? null;
    }

    const valorProdutos = itens.reduce((a, i) => a + i.quantidade * i.preco, 0);
    const custo = custoTotal({
      valorProdutos, desconto: 0, frete, impostos, seguro: 0,
      desembaraco: 0, taxas: 0, outros,
    });

    const numero = await proximoNumero(cliente);
    const { rows: criada } = await cliente.query(`
      INSERT INTO negociacoes_compra
        (numero, origem, cotacao_id, fornecedor_id, comprador_id, status, prioridade,
         data_limite, moeda, taxa_cambio, incoterm,
         valor_produtos_inicial, frete_inicial, impostos_inicial, outros_inicial,
         custo_total_inicial, prazo_entrega_inicial, prazo_pagamento_inicial,
         valor_produtos_atual, frete_atual, impostos_atual, outros_atual,
         custo_total_atual, prazo_entrega_atual, prazo_pagamento_atual,
         observacao, created_by)
      VALUES ($1,$2,$3,$4,$5,'ABERTA',$6,$7,$8,$9,$10,
              $11,$12,$13,$14,$15,$16,$17,
              $11,$12,$13,$14,$15,$16,$17,
              $18,$5)
      RETURNING *`,
      [numero, entrada.origem, cotacaoId, fornecedorId, contexto.usuarioId ?? null,
        prioridade, entrada.data_limite ?? null, moeda, taxaCambio, incoterm,
        valorProdutos, frete, impostos, outros, custo, prazoEntrega, prazoPagamento,
        entrada.observacao ?? null]);
    const negociacao = criada[0];

    for (const i of itens) {
      // Preco minimo historico serve de piso de referencia na negociacao (secao 12).
      const { rows: hist } = await cliente.query(
        'SELECT min(custo_efetivo) AS minimo FROM historico_precos WHERE produto_id = $1',
        [i.produto_id]);
      const custoItem = i.quantidade * i.preco;
      await cliente.query(`
        INSERT INTO negociacao_itens
          (negociacao_id, produto_id, cotacao_item_id, necessidade_id, unidade_id,
           quantidade_inicial, quantidade_atual, preco_inicial, preco_atual,
           preco_alvo, preco_minimo_historico, custo_total_inicial, custo_total_atual,
           moq, multiplo, prazo_entrega_dias, validade_dias)
        VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$7,$8,$9,$10,$10,$11,$12,$13,$14)`,
        [negociacao.id, i.produto_id, i.cotacao_item_id, i.necessidade_id, i.unidade_id,
          i.quantidade, i.preco, i.preco_alvo, hist[0]?.minimo ?? null, custoItem,
          i.moq, i.multiplo, i.prazo, i.validade]);
    }

    // Rodada 0: a fotografia do ponto de partida.
    await cliente.query(`
      INSERT INTO negociacao_rodadas
        (negociacao_id, rodada, autor, usuario_id, valor_produtos, frete, impostos, outros,
         custo_total, prazo_entrega_dias, prazo_pagamento_dias, justificativa)
      VALUES ($1, 0, 'FORNECEDOR', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [negociacao.id, contexto.usuarioId ?? null, valorProdutos, frete, impostos, outros,
        custo, prazoEntrega, prazoPagamento,
        cotacaoId ? 'Condicoes de abertura, vindas da cotacao aprovada' : 'Condicoes de abertura']);

    return { ...negociacao, itens: itens.length };
  });
}

// ---------------------------------------------------------------------------
// Rodadas
// ---------------------------------------------------------------------------

/**
 * Registra uma rodada. Nada e sobrescrito: a rodada guarda os valores daquele
 * momento e o que mudou em relacao a anterior; os itens ficam com o valor
 * corrente (secao 10).
 */
export async function registrarRodada(
  negociacaoId: number,
  entrada: z.output<typeof rodadaSchema>,
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM negociacoes_compra WHERE id = $1 FOR UPDATE', [negociacaoId]);
    if (!rows.length) throw naoEncontrado('Negociacao');
    const n = rows[0];

    if (['APROVADA', 'CONVERTIDA_PEDIDO', 'REJEITADA', 'CANCELADA'].includes(n.status)) {
      throw regraNegocio(`Negociacao em ${n.status} nao aceita novas rodadas`);
    }

    const { rows: itensAtuais } = await cliente.query(
      'SELECT * FROM negociacao_itens WHERE negociacao_id = $1 ORDER BY id', [negociacaoId]);
    const porId = new Map(itensAtuais.map((i) => [Number(i.id), i]));

    const alteracoes: Array<{ campo: string; anterior: unknown; novo: unknown; item?: number }> = [];
    const registrosItem: Array<Record<string, unknown>> = [];

    for (const item of entrada.itens) {
      const atual = porId.get(item.negociacao_item_id);
      if (!atual) throw regraNegocio(`Item ${item.negociacao_item_id} nao pertence a esta negociacao`);

      const quantidadeAnterior = num(atual.quantidade_atual);
      const precoAnterior = num(atual.preco_atual);
      const quantidade = item.quantidade ?? quantidadeAnterior;
      const preco = item.preco_unitario ?? precoAnterior;
      const desconto = item.desconto ?? num(atual.desconto);
      const bonificada = item.quantidade_bonificada ?? num(atual.quantidade_bonificada);
      const prazo = item.prazo_entrega_dias ?? (atual.prazo_entrega_dias ?? null);

      if (quantidade !== quantidadeAnterior) {
        alteracoes.push({ campo: 'quantidade', anterior: quantidadeAnterior, novo: quantidade, item: atual.produto_id });
      }
      if (preco !== precoAnterior) {
        alteracoes.push({ campo: 'preco_unitario', anterior: precoAnterior, novo: preco, item: atual.produto_id });
      }
      if (bonificada !== num(atual.quantidade_bonificada)) {
        alteracoes.push({ campo: 'bonificacao', anterior: atual.quantidade_bonificada, novo: bonificada, item: atual.produto_id });
      }

      const custoItem = quantidade * preco - desconto;
      const eco = economia(num(atual.custo_total_inicial), custoItem);

      await cliente.query(`
        UPDATE negociacao_itens
           SET quantidade_atual = $2, preco_atual = $3, desconto = $4,
               quantidade_bonificada = $5, prazo_entrega_dias = $6,
               custo_total_atual = $7, economia = $8, economia_percentual = $9,
               observacao = coalesce($10, observacao), updated_at = now()
         WHERE id = $1`,
        [item.negociacao_item_id, quantidade, preco, desconto, bonificada, prazo,
          custoItem, eco.absoluta, eco.percentual, item.observacao ?? null]);

      registrosItem.push({
        negociacao_item_id: item.negociacao_item_id,
        produto_id: atual.produto_id,
        cotacao_item_id: atual.cotacao_item_id,
        preco_anterior: precoAnterior,
        preco_negociado: preco,
        quantidade_anterior: quantidadeAnterior,
        quantidade_negociada: quantidade,
        desconto,
        bonificacao: bonificada,
        saving_unitario: precoAnterior - preco,
        saving_total: quantidadeAnterior * precoAnterior - custoItem,
      });
    }

    const frete = entrada.frete ?? num(n.frete_atual);
    const impostos = entrada.impostos ?? num(n.impostos_atual);
    const outros = entrada.outros ?? num(n.outros_atual);
    const prazoEntrega = entrada.prazo_entrega_dias ?? n.prazo_entrega_atual;
    const prazoPagamento = entrada.prazo_pagamento_dias ?? n.prazo_pagamento_atual;

    if (frete !== num(n.frete_atual)) {
      alteracoes.push({ campo: 'frete', anterior: n.frete_atual, novo: frete });
    }
    if (impostos !== num(n.impostos_atual)) {
      alteracoes.push({ campo: 'impostos', anterior: n.impostos_atual, novo: impostos });
    }
    if (prazoEntrega !== n.prazo_entrega_atual) {
      alteracoes.push({ campo: 'prazo_entrega_dias', anterior: n.prazo_entrega_atual, novo: prazoEntrega });
    }
    if (prazoPagamento !== n.prazo_pagamento_atual) {
      alteracoes.push({ campo: 'prazo_pagamento_dias', anterior: n.prazo_pagamento_atual, novo: prazoPagamento });
    }

    const { rows: recalculo } = await cliente.query(`
      SELECT coalesce(sum(custo_total_atual), 0) AS valor_produtos,
             coalesce(sum(quantidade_bonificada * preco_atual), 0) AS valor_bonificacao
        FROM negociacao_itens WHERE negociacao_id = $1`, [negociacaoId]);
    const valorProdutos = num(recalculo[0].valor_produtos);
    const valorBonificacao = num(recalculo[0].valor_bonificacao);

    const custo = custoTotal({
      valorProdutos, desconto: 0, frete, impostos, seguro: 0, desembaraco: 0, taxas: 0, outros,
    });
    const eco = economia(num(n.custo_total_inicial), custo);

    const rodada = Number(n.rodada_atual) + 1;
    const { rows: novaRodada } = await cliente.query(`
      INSERT INTO negociacao_rodadas
        (negociacao_id, rodada, autor, usuario_id, valor_produtos, frete, impostos, outros,
         valor_bonificacao, custo_total, prazo_entrega_dias, prazo_pagamento_dias,
         economia_acumulada, justificativa, alteracoes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *`,
      [negociacaoId, rodada, entrada.autor, contexto.usuarioId ?? null,
        valorProdutos, frete, impostos, outros, valorBonificacao, custo,
        prazoEntrega, prazoPagamento, eco.absoluta,
        entrada.justificativa ?? null, JSON.stringify(alteracoes)]);

    for (const r of registrosItem) {
      await cliente.query(`
        INSERT INTO negociacoes
          (negociacao_id, rodada_id, negociacao_item_id, cotacao_item_id, produto_id,
           data, usuario_id, autor, preco_anterior, preco_negociado, desconto,
           quantidade_anterior, quantidade_negociada, bonificacao,
           saving_total)
        VALUES ($1,$2,$3,$4,$5, now(), $6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [negociacaoId, novaRodada[0].id, r.negociacao_item_id, r.cotacao_item_id,
          r.produto_id, contexto.usuarioId ?? null, entrada.autor,
          r.preco_anterior, r.preco_negociado, r.desconto,
          r.quantidade_anterior, r.quantidade_negociada, r.bonificacao,
          r.saving_total]);
    }

    const proximoStatus = entrada.autor === 'FORNECEDOR' ? 'CONTRAPROPOSTA_RECEBIDA' : 'AGUARDANDO_FORNECEDOR';

    const { rows: atualizada } = await cliente.query(`
      UPDATE negociacoes_compra
         SET rodada_atual = $2, valor_produtos_atual = $3, frete_atual = $4,
             impostos_atual = $5, outros_atual = $6, valor_bonificacao = $7,
             custo_total_atual = $8, prazo_entrega_atual = $9, prazo_pagamento_atual = $10,
             condicao_pagamento_id = coalesce($11::bigint, condicao_pagamento_id),
             economia_negociada = $12, economia_percentual = $13,
             status = $14::status_negociacao_enum, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [negociacaoId, rodada, valorProdutos, frete, impostos, outros, valorBonificacao,
        custo, prazoEntrega, prazoPagamento, entrada.condicao_pagamento_id ?? null,
        eco.absoluta, eco.percentual, proximoStatus]);

    return { negociacao: atualizada[0], rodada: novaRodada[0], alteracoes };
  });
}

/** Simula faixas de quantidade e preco sem gravar nada (secao 14). */
export async function simularVolume(
  negociacaoId: number,
  entrada: z.output<typeof simularVolumeSchema>,
) {
  const { rows: item } = await query(`
    SELECT ni.*, p.codigo, p.descricao,
           coalesce(s.disponivel, 0) AS estoque_disponivel,
           coalesce(s.transito, 0) AS estoque_transito,
           d.demanda_diaria
      FROM negociacao_itens ni
      JOIN produtos p ON p.id = ni.produto_id
      LEFT JOIN LATERAL (
        SELECT sum(quantidade_disponivel) AS disponivel, sum(quantidade_em_transito) AS transito
          FROM estoques e WHERE e.produto_id = ni.produto_id) s ON true
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(quantidade), 0) / 90.0 AS demanda_diaria
          FROM mv_demanda_diaria m
         WHERE m.produto_id = ni.produto_id AND m.data_venda >= CURRENT_DATE - 90) d ON true
     WHERE ni.id = $1 AND ni.negociacao_id = $2`, [entrada.negociacao_item_id, negociacaoId]);
  if (!item.length) throw naoEncontrado('Item da negociacao');
  const i = item[0];

  const demandaDiaria = num(i.demanda_diaria);
  const posicao = num(i.estoque_disponivel) + num(i.estoque_transito);
  const referencia = num(i.quantidade_atual) * num(i.preco_atual);

  return {
    item: { id: i.id, codigo: i.codigo, descricao: i.descricao,
      quantidade_atual: num(i.quantidade_atual), preco_atual: num(i.preco_atual) },
    faixas: entrada.faixas.map((f) => {
      const total = f.quantidade * f.preco_unitario;
      const cobertura = demandaDiaria > 0 ? (posicao + f.quantidade) / demandaDiaria : null;
      return {
        quantidade: f.quantidade,
        preco_unitario: f.preco_unitario,
        valor_total: total,
        economia_unitaria: num(i.preco_atual) - f.preco_unitario,
        economia_total: referencia - total,
        variacao_quantidade_percentual: num(i.quantidade_atual) > 0
          ? ((f.quantidade - num(i.quantidade_atual)) / num(i.quantidade_atual)) * 100 : null,
        cobertura_apos_compra_dias: cobertura,
        // Desconto por volume nao pode virar compra excessiva sem que o
        // comprador veja o tamanho do estoque que esta criando (secao 14).
        alerta_excesso: cobertura !== null && cobertura > 180
          ? `Compra gera ${cobertura.toFixed(0)} dias de cobertura` : null,
      };
    }),
    contexto: {
      estoque_disponivel: num(i.estoque_disponivel),
      estoque_transito: num(i.estoque_transito),
      demanda_diaria: demandaDiaria,
      cobertura_atual_dias: demandaDiaria > 0 ? posicao / demandaDiaria : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export async function listarNegociacoes(filtro: z.output<typeof listarNegociacoesSchema> & Paginacao) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  if (filtro.status) { valores.push(filtro.status); cond.push(`n.status = $${valores.length}`); }
  if (filtro.fornecedor_id) { valores.push(filtro.fornecedor_id); cond.push(`n.fornecedor_id = $${valores.length}`); }
  if (filtro.comprador_id) { valores.push(filtro.comprador_id); cond.push(`n.comprador_id = $${valores.length}`); }
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(n.numero ILIKE $${valores.length} OR f.razao_social ILIKE $${valores.length})`);
  }
  if (filtro.apenas_paradas) {
    cond.push(`n.status NOT IN ('APROVADA','CONVERTIDA_PEDIDO','REJEITADA','CANCELADA')
               AND n.updated_at < now() - make_interval(days =>
                 (SELECT valor::int FROM configuracoes WHERE chave = 'pedido.dias_negociacao_parada'))`);
  }
  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM negociacoes_compra n
       JOIN fornecedores f ON f.id = n.fornecedor_id ${onde}`, valores);

  const { rows } = await query(`
    SELECT n.*, f.razao_social AS fornecedor, u.nome AS comprador,
           c.numero AS cotacao, oc.numero AS pedido,
           (SELECT count(*)::int FROM negociacao_itens ni WHERE ni.negociacao_id = n.id) AS itens,
           (n.status NOT IN ('APROVADA','CONVERTIDA_PEDIDO','REJEITADA','CANCELADA')
            AND n.updated_at < now() - interval '5 days') AS parada
      FROM negociacoes_compra n
      JOIN fornecedores f ON f.id = n.fornecedor_id
      LEFT JOIN usuarios u ON u.id = n.comprador_id
      LEFT JOIN cotacoes c ON c.id = n.cotacao_id
      LEFT JOIN ordens_compra oc ON oc.id = n.ordem_compra_id
      ${onde}
     ORDER BY n.data_abertura DESC, n.id DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return { dados: rows, meta: metaPaginacao(total.rows[0]?.total ?? 0, filtro) };
}

export async function detalharNegociacao(negociacaoId: number) {
  const { rows } = await query(`
    SELECT n.*, f.razao_social AS fornecedor, f.origem_fornecedor,
           u.nome AS comprador, a.nome AS aprovador,
           c.numero AS cotacao, oc.numero AS pedido, oc.id AS pedido_id,
           cp.nome AS condicao_pagamento
      FROM negociacoes_compra n
      JOIN fornecedores f ON f.id = n.fornecedor_id
      LEFT JOIN usuarios u ON u.id = n.comprador_id
      LEFT JOIN usuarios a ON a.id = n.aprovador_id
      LEFT JOIN cotacoes c ON c.id = n.cotacao_id
      LEFT JOIN ordens_compra oc ON oc.id = n.ordem_compra_id
      LEFT JOIN condicoes_pagamento cp ON cp.id = n.condicao_pagamento_id
     WHERE n.id = $1`, [negociacaoId]);
  if (!rows.length) throw naoEncontrado('Negociacao');
  const n = rows[0];

  const [itens, rodadas, detalhesRodada] = await Promise.all([
    query(`
      SELECT ni.*, p.codigo, p.descricao, p.peso, un.codigo AS unidade,
             ni.quantidade_atual * ni.preco_atual AS valor_atual,
             CASE WHEN ni.preco_alvo IS NOT NULL
                  THEN ni.preco_atual - ni.preco_alvo END AS diferenca_alvo
        FROM negociacao_itens ni
        JOIN produtos p ON p.id = ni.produto_id
        LEFT JOIN unidades un ON un.id = ni.unidade_id
       WHERE ni.negociacao_id = $1 ORDER BY p.descricao`, [negociacaoId]),
    query(`
      SELECT r.*, u.nome AS usuario
        FROM negociacao_rodadas r
        LEFT JOIN usuarios u ON u.id = r.usuario_id
       WHERE r.negociacao_id = $1 ORDER BY r.rodada`, [negociacaoId]),
    query(`
      SELECT ng.*, p.codigo, p.descricao
        FROM negociacoes ng
        LEFT JOIN produtos p ON p.id = ng.produto_id
       WHERE ng.negociacao_id = $1 ORDER BY ng.rodada_id, p.descricao`, [negociacaoId]),
  ]);

  const bonificacoes = itens.rows
    .filter((i) => num(i.quantidade_bonificada) > 0)
    .map((i) => bonificacao(
      num(i.quantidade_atual), num(i.quantidade_bonificada),
      num(i.preco_atual), num(i.custo_total_atual)));

  const comparativo = comparativoAntesDepois(
    {
      precoMedio: num(n.valor_produtos_inicial)
        / Math.max(1, itens.rows.reduce((a, i) => a + num(i.quantidade_inicial), 0)),
      frete: num(n.frete_inicial),
      pagamentoDias: n.prazo_pagamento_inicial,
      prazoDias: n.prazo_entrega_inicial,
      quantidade: itens.rows.reduce((a, i) => a + num(i.quantidade_inicial), 0),
      custoTotal: num(n.custo_total_inicial),
    },
    {
      precoMedio: num(n.valor_produtos_atual)
        / Math.max(1, itens.rows.reduce((a, i) => a + num(i.quantidade_atual), 0)),
      frete: num(n.frete_atual),
      pagamentoDias: n.prazo_pagamento_atual,
      prazoDias: n.prazo_entrega_atual,
      quantidade: itens.rows.reduce((a, i) => a + num(i.quantidade_atual), 0),
      custoTotal: num(n.custo_total_atual),
    },
  );

  return {
    ...n,
    itens: itens.rows,
    rodadas: rodadas.rows.map((r) => ({
      ...r,
      itens: detalhesRodada.rows.filter((d) => Number(d.rodada_id) === Number(r.id)),
    })),
    bonificacoes,
    comparativo,
    economia: {
      potencial: num(n.economia_potencial),
      negociada: num(n.economia_negociada),
      percentual: n.economia_percentual,
      custo_inicial: num(n.custo_total_inicial),
      custo_atual: num(n.custo_total_atual),
    },
  };
}

// ---------------------------------------------------------------------------
// Decisao
// ---------------------------------------------------------------------------

async function mudarStatus(
  cliente: Cliente, negociacaoId: number, novo: string, usuarioId: number | null,
) {
  const { rows } = await cliente.query(
    'SELECT status FROM negociacoes_compra WHERE id = $1 FOR UPDATE', [negociacaoId]);
  if (!rows.length) throw naoEncontrado('Negociacao');
  const atual = rows[0].status;
  if (!TRANSICOES[atual]?.includes(novo)) {
    throw regraNegocio(
      `Negociacao em ${atual} nao pode ir para ${novo}. Possiveis - ${TRANSICOES[atual]?.join(', ') || 'nenhuma'}`,
    );
  }
  return atual;
}

/**
 * So fecha o acordo quando tudo que o pedido precisa esta definido (secao 22).
 */
export async function acordarNegociacao(negociacaoId: number, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    await mudarStatus(cliente, negociacaoId, 'ACORDADA', contexto.usuarioId ?? null);

    const { rows } = await cliente.query(
      'SELECT * FROM negociacoes_compra WHERE id = $1', [negociacaoId]);
    const n = rows[0];

    const faltando: string[] = [];
    if (!n.fornecedor_id) faltando.push('fornecedor');
    if (!n.comprador_id) faltando.push('comprador responsavel');
    if (n.prazo_entrega_atual === null) faltando.push('prazo de entrega');
    if (n.prazo_pagamento_atual === null) faltando.push('condicao de pagamento');
    if (num(n.custo_total_atual) <= 0) faltando.push('custo total');

    const { rows: itens } = await cliente.query(
      'SELECT count(*)::int AS n, count(*) FILTER (WHERE preco_atual > 0)::int AS com_preco FROM negociacao_itens WHERE negociacao_id = $1',
      [negociacaoId]);
    if (Number(itens[0].n) === 0) faltando.push('itens');
    if (Number(itens[0].com_preco) < Number(itens[0].n)) faltando.push('preco de todos os itens');

    if (faltando.length) {
      throw regraNegocio(`Negociacao nao pode ser acordada. Falta definir - ${faltando.join(', ')}`);
    }

    const { rows: acordada } = await cliente.query(
      "UPDATE negociacoes_compra SET status = 'ACORDADA', acordada_em = now(), updated_at = now() WHERE id = $1 RETURNING *",
      [negociacaoId]);
    return acordada[0];
  });
}

async function alcadaPara(valor: number) {
  const { rows } = await query<{ nome: string; perfil: string }>(`
    SELECT a.nome, p.nome AS perfil
      FROM alcadas_aprovacao a JOIN perfis p ON p.id = a.perfil_id
     WHERE a.ativo AND a.valor_minimo <= $1
       AND (a.valor_maximo IS NULL OR a.valor_maximo >= $1)
     ORDER BY a.ordem LIMIT 1`, [valor]);
  return rows[0] ?? null;
}

export async function aprovarNegociacao(
  negociacaoId: number, perfilUsuario: string, justificativa: string | undefined, contexto: ContextoSessao,
) {
  const cfg = await config();
  return comTransacao(contexto, async (cliente) => {
    const anterior = await mudarStatus(cliente, negociacaoId, 'APROVADA', contexto.usuarioId ?? null);
    const { rows } = await cliente.query('SELECT * FROM negociacoes_compra WHERE id = $1', [negociacaoId]);
    const n = rows[0];

    const valor = num(n.custo_total_atual);
    const alcada = await alcadaPara(valor);
    if (perfilUsuario !== 'ADMIN' && alcada && alcada.perfil !== perfilUsuario) {
      throw semPermissao(`Valor de ${valor.toFixed(2)} exige aprovacao do perfil ${alcada.perfil}`);
    }

    // Secao 23: se a negociacao mudou muito a proposta aprovada na cotacao,
    // isso fica gravado e a aprovacao tem de ser consciente disso.
    const limite = Number(cfg['pedido.percentual_alteracao_reaprovacao'] ?? 10);
    const variacao = num(n.custo_total_inicial) > 0
      ? Math.abs((valor - num(n.custo_total_inicial)) / num(n.custo_total_inicial)) * 100 : 0;
    const desvio = n.cotacao_id !== null && variacao > limite;

    const { rows: aprovada } = await cliente.query(`
      UPDATE negociacoes_compra
         SET status = 'APROVADA', aprovador_id = $2, aprovado_em = now(),
             nivel_aprovacao = $3, desvio_relevante = $4,
             motivo_desvio = CASE WHEN $4 THEN $5 ELSE motivo_desvio END,
             observacao = coalesce($6, observacao), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [negociacaoId, contexto.usuarioId ?? null, alcada?.perfil ?? perfilUsuario, desvio,
        `Condicoes alteradas apos aprovacao da cotacao: variacao de ${variacao.toFixed(2)}% no custo total`,
        justificativa ?? null]);

    return { ...aprovada[0], status_anterior: anterior, variacao_percentual: variacao };
  });
}

export async function rejeitarNegociacao(
  negociacaoId: number, entrada: z.output<typeof rejeitarSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    await mudarStatus(cliente, negociacaoId, 'REJEITADA', contexto.usuarioId ?? null);
    const { rows } = await cliente.query(`
      UPDATE negociacoes_compra
         SET status = 'REJEITADA', motivo_rejeicao = $2::motivo_rejeicao_enum,
             justificativa_rejeicao = $3, aprovador_id = $4, aprovado_em = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [negociacaoId, entrada.motivo, entrada.justificativa, contexto.usuarioId ?? null]);
    return rows[0];
  });
}

export async function cancelarNegociacao(
  negociacaoId: number, justificativa: string | undefined, contexto: ContextoSessao,
) {
  if (!justificativa) throw regraNegocio('Cancelamento exige justificativa');
  return comTransacao(contexto, async (cliente) => {
    await mudarStatus(cliente, negociacaoId, 'CANCELADA', contexto.usuarioId ?? null);
    const { rows } = await cliente.query(`
      UPDATE negociacoes_compra
         SET status = 'CANCELADA', justificativa_rejeicao = $2, updated_at = now()
       WHERE id = $1 RETURNING *`, [negociacaoId, justificativa]);
    return rows[0];
  });
}
