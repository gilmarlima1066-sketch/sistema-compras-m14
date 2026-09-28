import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import type { RegistrarProposta } from './cotacoes.schemas.js';
import { custoAquisicao } from './pontuacao.js';
import { registrarHistorico } from './cotacoes.service.js';

/**
 * Registra a proposta de um fornecedor.
 *
 * Duas regras do prompt moldam esta funcao:
 *  - resposta parcial e normal (secao 10): item nao respondido simplesmente
 *    nao ganha linha, e NUNCA vira preco zero;
 *  - quantidade diferente da pedida (secao 11) e registrada e sinalizada, nao
 *    corrigida em silencio.
 */
export async function registrarProposta(
  cotacaoId: number,
  entrada: RegistrarProposta,
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows: cotacao } = await cliente.query(
      'SELECT * FROM cotacoes WHERE id = $1 FOR UPDATE', [cotacaoId]);
    if (!cotacao.length) throw naoEncontrado('Cotacao');
    const c = cotacao[0];
    if (['ENCAMINHADA', 'REJEITADA', 'CANCELADA'].includes(c.status)) {
      throw regraNegocio(`Cotacao em ${c.status} nao aceita novas propostas`);
    }

    const { rows: convite } = await cliente.query(
      'SELECT * FROM cotacao_fornecedores WHERE cotacao_id = $1 AND fornecedor_id = $2 FOR UPDATE',
      [cotacaoId, entrada.fornecedor_id]);
    if (!convite.length) {
      throw regraNegocio('Fornecedor nao foi convidado para esta cotacao');
    }

    if (entrada.recusou) {
      if (!entrada.motivo_recusa) throw regraNegocio('Recusa exige motivo');
      const { rows } = await cliente.query(`
        UPDATE cotacao_fornecedores
           SET status = 'RECUSADA', data_resposta = coalesce($3::timestamptz, now()),
               motivo_recusa = $4, observacao = $5
         WHERE cotacao_id = $1 AND fornecedor_id = $2 RETURNING *`,
        [cotacaoId, entrada.fornecedor_id, entrada.data_resposta ?? null,
          entrada.motivo_recusa, entrada.observacao ?? null]);
      await registrarHistorico(cliente, cotacaoId, c.status, c.status, contexto.usuarioId ?? null,
        'Fornecedor recusou participar', { fornecedor_id: entrada.fornecedor_id, motivo: entrada.motivo_recusa });
      return { convite: rows[0], itens_gravados: 0, itens_sem_resposta: Number(convite[0].itens_solicitados) };
    }

    const { rows: produtos } = await cliente.query(`
      SELECT cp.id, cp.produto_id, cp.quantidade, cp.data_necessaria
        FROM cotacao_produtos cp WHERE cp.cotacao_id = $1`, [cotacaoId]);
    const porProduto = new Map(produtos.map((p) => [Number(p.produto_id), p]));

    const naoCotados = entrada.itens
      .map((i) => i.produto_id)
      .filter((p) => !porProduto.has(p));
    if (naoCotados.length) {
      throw regraNegocio(`Produto nao faz parte desta cotacao - ${naoCotados.join(', ')}`);
    }

    const avisos: Array<{ produto_id: number; aviso: string }> = [];
    let gravados = 0;

    for (const item of entrada.itens) {
      const produto = porProduto.get(item.produto_id)!;
      const quantidadeSolicitada = Number(produto.quantidade);

      const custo = custoAquisicao({
        quantidadeOfertada: item.quantidade_ofertada,
        precoUnitario: item.preco_unitario,
        desconto: item.desconto,
        frete: item.frete,
        impostos: item.impostos,
        seguro: item.seguro,
        desembaraco: item.desembaraco,
        taxas: item.taxas,
        outrosCustos: item.outros_custos,
        taxaCambio: item.taxa_cambio ?? null,
      });

      const atendimento = quantidadeSolicitada > 0
        ? (item.quantidade_ofertada / quantidadeSolicitada) * 100
        : 0;

      const alertas: Array<{ tipo: string; mensagem: string }> = [];
      if (item.quantidade_ofertada !== quantidadeSolicitada) {
        const aviso = `Quantidade ofertada (${item.quantidade_ofertada}) diferente da solicitada (${quantidadeSolicitada})`;
        alertas.push({ tipo: 'QUANTIDADE_DIVERGENTE', mensagem: aviso });
        avisos.push({ produto_id: item.produto_id, aviso });
      }
      if (item.moq !== null && item.moq !== undefined && item.moq > quantidadeSolicitada) {
        alertas.push({
          tipo: 'MOQ_ACIMA_NECESSIDADE',
          mensagem: `MOQ de ${item.moq} acima da quantidade necessaria de ${quantidadeSolicitada}`,
        });
      }
      if (item.moeda !== c.moeda_base && !item.taxa_cambio) {
        alertas.push({
          tipo: 'SEM_TAXA_CAMBIO',
          mensagem: `Proposta em ${item.moeda} sem taxa de cambio informada; comparacao usa o valor nominal`,
        });
      }

      const { rows: gravado } = await cliente.query(`
        INSERT INTO cotacao_itens
          (cotacao_id, fornecedor_id, produto_id, cotacao_produto_id, necessidade_compra_id,
           quantidade_solicitada, quantidade_ofertada, preco_unitario, desconto, frete,
           impostos, outros_custos, seguro, desembaraco, taxas,
           custo_total, custo_efetivo_unitario, custo_total_base, preco_liquido,
           prazo_entrega_dias, prazo_pagamento_dias, data_prevista_entrega,
           disponibilidade, data_disponivel, validade_produto_dias, validade_proposta,
           incoterm, moeda, taxa_cambio, data_taxa_cambio, moq, multiplo,
           atendimento_percentual, alertas, observacao, respondido_em)
        VALUES ($1,$2,$3,$4,
                (SELECT necessidade_id FROM cotacao_produtos WHERE id = $4),
                $5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
                $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,
                coalesce($35::timestamptz, now()))
        ON CONFLICT (cotacao_id, fornecedor_id, produto_id) DO UPDATE SET
          cotacao_produto_id = EXCLUDED.cotacao_produto_id,
          quantidade_ofertada = EXCLUDED.quantidade_ofertada,
          preco_unitario = EXCLUDED.preco_unitario, desconto = EXCLUDED.desconto,
          frete = EXCLUDED.frete, impostos = EXCLUDED.impostos,
          outros_custos = EXCLUDED.outros_custos, seguro = EXCLUDED.seguro,
          desembaraco = EXCLUDED.desembaraco, taxas = EXCLUDED.taxas,
          custo_total = EXCLUDED.custo_total,
          custo_efetivo_unitario = EXCLUDED.custo_efetivo_unitario,
          custo_total_base = EXCLUDED.custo_total_base,
          preco_liquido = EXCLUDED.preco_liquido,
          prazo_entrega_dias = EXCLUDED.prazo_entrega_dias,
          prazo_pagamento_dias = EXCLUDED.prazo_pagamento_dias,
          data_prevista_entrega = EXCLUDED.data_prevista_entrega,
          disponibilidade = EXCLUDED.disponibilidade,
          data_disponivel = EXCLUDED.data_disponivel,
          validade_produto_dias = EXCLUDED.validade_produto_dias,
          validade_proposta = EXCLUDED.validade_proposta,
          incoterm = EXCLUDED.incoterm, moeda = EXCLUDED.moeda,
          taxa_cambio = EXCLUDED.taxa_cambio, data_taxa_cambio = EXCLUDED.data_taxa_cambio,
          moq = EXCLUDED.moq, multiplo = EXCLUDED.multiplo,
          atendimento_percentual = EXCLUDED.atendimento_percentual,
          alertas = EXCLUDED.alertas, observacao = EXCLUDED.observacao,
          respondido_em = EXCLUDED.respondido_em, updated_at = now()
        RETURNING id`,
        [cotacaoId, entrada.fornecedor_id, item.produto_id, produto.id,
          quantidadeSolicitada, item.quantidade_ofertada, item.preco_unitario,
          item.desconto, item.frete, item.impostos, item.outros_custos,
          item.seguro, item.desembaraco, item.taxas,
          custo.custoTotal, custo.custoUnitario, custo.custoTotal, custo.precoLiquidoUnitario,
          item.prazo_entrega_dias ?? null, item.prazo_pagamento_dias ?? null,
          item.data_prevista_entrega ?? null, item.disponibilidade ?? null,
          item.data_disponivel ?? null, item.validade_produto_dias ?? null,
          item.validade_proposta ?? null, item.incoterm ?? null, item.moeda,
          item.taxa_cambio ?? null, item.data_taxa_cambio ?? null,
          item.moq ?? null, item.multiplo ?? null, atendimento,
          JSON.stringify(alertas), item.observacao ?? null, entrada.data_resposta ?? null]);

      const itemId = gravado[0].id;
      gravados += 1;

      await cliente.query('DELETE FROM cotacao_faixas_preco WHERE cotacao_item_id = $1', [itemId]);
      for (const faixa of item.faixas_preco ?? []) {
        await cliente.query(`
          INSERT INTO cotacao_faixas_preco (cotacao_item_id, quantidade_de, quantidade_ate, preco_unitario)
          VALUES ($1, $2, $3, $4)`,
          [itemId, faixa.quantidade_de, faixa.quantidade_ate ?? null, faixa.preco_unitario]);
      }
    }

    const solicitados = produtos.length;
    const semResposta = solicitados - gravados;
    const status = semResposta > 0 ? 'PARCIALMENTE_RESPONDIDA' : 'RESPONDIDA';

    const { rows: conviteAtualizado } = await cliente.query(`
      UPDATE cotacao_fornecedores
         SET status = $3::status_cotacao_fornecedor_enum,
             data_resposta = coalesce($4::timestamptz, now()),
             itens_respondidos = $5, itens_solicitados = $6,
             observacao = coalesce($7, observacao)
       WHERE cotacao_id = $1 AND fornecedor_id = $2 RETURNING *`,
      [cotacaoId, entrada.fornecedor_id, status, entrada.data_resposta ?? null,
        gravados, solicitados, entrada.observacao ?? null]);

    if (c.status === 'AGUARDANDO_RESPOSTAS' || c.status === 'ENVIADA') {
      await cliente.query(
        "UPDATE cotacoes SET status = 'EM_ANALISE', updated_at = now() WHERE id = $1", [cotacaoId]);
      await registrarHistorico(cliente, cotacaoId, c.status, 'EM_ANALISE', contexto.usuarioId ?? null,
        'Primeira proposta recebida', { fornecedor_id: entrada.fornecedor_id });
    }

    await registrarHistorico(cliente, cotacaoId, c.status, c.status, contexto.usuarioId ?? null,
      'Proposta registrada',
      { fornecedor_id: entrada.fornecedor_id, itens: gravados, sem_resposta: semResposta });

    return {
      convite: conviteAtualizado[0],
      itens_gravados: gravados,
      itens_sem_resposta: semResposta,
      status_fornecedor: status,
      avisos,
    };
  });
}

export async function marcarVisualizada(cotacaoId: number, fornecedorId: number) {
  const { rows } = await query(`
    UPDATE cotacao_fornecedores
       SET status = CASE WHEN status = 'ENVIADA' THEN 'VISUALIZADO'::status_cotacao_fornecedor_enum ELSE status END,
           data_visualizacao = coalesce(data_visualizacao, now())
     WHERE cotacao_id = $1 AND fornecedor_id = $2 RETURNING *`, [cotacaoId, fornecedorId]);
  if (!rows.length) throw naoEncontrado('Fornecedor nesta cotacao');
  return rows[0];
}

/** Propostas recebidas, com o que falta responder explicito. */
export async function listarPropostas(cotacaoId: number) {
  const { rows: itens } = await query(`
    SELECT ci.*, f.razao_social AS fornecedor, f.origem_fornecedor, f.ativo AS fornecedor_ativo,
           p.codigo, p.descricao, cp.quantidade AS quantidade_pedida,
           cp.data_necessaria, cp.validade_minima_dias, cp.preco_alvo, cp.preco_maximo,
           (SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'quantidade_de', fp.quantidade_de,
                     'quantidade_ate', fp.quantidade_ate,
                     'preco_unitario', fp.preco_unitario) ORDER BY fp.quantidade_de), '[]'::jsonb)
              FROM cotacao_faixas_preco fp WHERE fp.cotacao_item_id = ci.id) AS faixas_preco
      FROM cotacao_itens ci
      JOIN fornecedores f ON f.id = ci.fornecedor_id
      JOIN produtos p ON p.id = ci.produto_id
      JOIN cotacao_produtos cp ON cp.id = ci.cotacao_produto_id
     WHERE ci.cotacao_id = $1
     ORDER BY p.descricao, ci.custo_efetivo_unitario NULLS LAST`, [cotacaoId]);

  // Secao 10: o que ninguem respondeu tem que aparecer como ausencia.
  const { rows: semResposta } = await query(`
    SELECT cp.id AS cotacao_produto_id, p.codigo, p.descricao, cp.quantidade,
           f.id AS fornecedor_id, f.razao_social AS fornecedor
      FROM cotacao_produtos cp
      JOIN produtos p ON p.id = cp.produto_id
      CROSS JOIN cotacao_fornecedores cf
      JOIN fornecedores f ON f.id = cf.fornecedor_id
     WHERE cp.cotacao_id = $1 AND cf.cotacao_id = $1
       AND cf.status NOT IN ('RECUSADA', 'CANCELADA')
       AND NOT EXISTS (
         SELECT 1 FROM cotacao_itens ci
          WHERE ci.cotacao_produto_id = cp.id AND ci.fornecedor_id = cf.fornecedor_id)
     ORDER BY p.descricao, f.razao_social`, [cotacaoId]);

  return { propostas: itens, sem_resposta: semResposta };
}
