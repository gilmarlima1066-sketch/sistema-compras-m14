import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio, semPermissao } from '../../core/errors.js';
import type { z } from 'zod';
import type { cenarioSchema, selecionarPropostaSchema } from './cotacoes.schemas.js';
import { comparativo, recomendacao } from './comparacao.service.js';
import { registrarHistorico, TRANSICOES } from './cotacoes.service.js';

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

interface Candidata {
  cotacao_produto_id: number;
  cotacao_item_id: number;
  fornecedor_id: number;
  fornecedor: string;
  quantidade_pedida: number;
  quantidade_ofertada: number;
  custo_unitario: number;
  custo_total: number;
  frete: number;
  prazo_entrega_dias: number | null;
  prazo_pagamento_dias: number | null;
  score: number;
  elegivel: boolean;
}

async function candidatas(cotacaoId: number): Promise<Candidata[]> {
  const dados = await comparativo(cotacaoId);
  const lista: Candidata[] = [];
  for (const p of dados.produtos) {
    for (const prop of p.propostas) {
      lista.push({
        cotacao_produto_id: p.cotacao_produto_id,
        cotacao_item_id: Number(prop.cotacao_item_id),
        fornecedor_id: Number(prop.fornecedor_id),
        fornecedor: prop.fornecedor,
        quantidade_pedida: Number(p.quantidade_pedida),
        quantidade_ofertada: Number(prop.quantidade_ofertada ?? 0),
        custo_unitario: Number(prop.custo_efetivo_unitario ?? 0),
        custo_total: Number(prop.custo_total_base ?? 0),
        frete: Number(prop.frete ?? 0),
        prazo_entrega_dias: num(prop.prazo_entrega_dias),
        prazo_pagamento_dias: num(prop.prazo_pagamento_dias),
        score: Number(prop.score ?? 0),
        elegivel: Boolean(prop.elegivel),
      });
    }
  }
  return lista;
}

/**
 * Monta a selecao de um cenario. Cada tipo e uma politica de escolha diferente
 * sobre as mesmas propostas - nenhum deles altera a cotacao oficial (secao 39).
 */
function selecionar(
  tipo: string,
  todas: Candidata[],
  parametros: { fornecedor_id?: number },
): Array<{ candidata: Candidata; quantidade: number }> {
  const elegiveis = todas.filter((c) => c.elegivel);
  const produtos = [...new Set(elegiveis.map((c) => c.cotacao_produto_id))];
  const saida: Array<{ candidata: Candidata; quantidade: number }> = [];

  for (const produtoId of produtos) {
    const grupo = elegiveis.filter((c) => c.cotacao_produto_id === produtoId);
    if (!grupo.length) continue;

    let escolhida: Candidata | undefined;
    switch (tipo) {
      case 'MENOR_CUSTO':
        escolhida = [...grupo].sort((a, b) => a.custo_unitario - b.custo_unitario)[0];
        break;
      case 'MENOR_PRAZO':
        escolhida = [...grupo]
          .sort((a, b) => (a.prazo_entrega_dias ?? 1e9) - (b.prazo_entrega_dias ?? 1e9))[0];
        break;
      case 'MAIOR_PRAZO_PAGAMENTO':
        escolhida = [...grupo]
          .sort((a, b) => (b.prazo_pagamento_dias ?? -1) - (a.prazo_pagamento_dias ?? -1))[0];
        break;
      case 'MELHOR_SCORE':
        escolhida = [...grupo].sort((a, b) => b.score - a.score)[0];
        break;
      case 'FORNECEDOR_UNICO':
        escolhida = grupo.find((g) => g.fornecedor_id === parametros.fornecedor_id);
        break;
      case 'COMPRA_DIVIDIDA': {
        // Enche a necessidade com as propostas mais baratas, na ordem, ate
        // cobrir a quantidade pedida (secao 27).
        const ordenadas = [...grupo].sort((a, b) => a.custo_unitario - b.custo_unitario);
        let restante = grupo[0]!.quantidade_pedida;
        for (const candidata of ordenadas) {
          if (restante <= 0) break;
          const quantidade = Math.min(restante, candidata.quantidade_ofertada);
          if (quantidade <= 0) continue;
          saida.push({ candidata, quantidade });
          restante -= quantidade;
        }
        continue;
      }
      default:
        escolhida = [...grupo].sort((a, b) => b.score - a.score)[0];
    }

    if (escolhida) {
      saida.push({
        candidata: escolhida,
        quantidade: Math.min(escolhida.quantidade_pedida, escolhida.quantidade_ofertada),
      });
    }
  }

  return saida;
}

export async function criarCenario(
  cotacaoId: number,
  entrada: z.output<typeof cenarioSchema>,
  contexto: ContextoSessao,
) {
  const todas = await candidatas(cotacaoId);
  if (!todas.length) throw regraNegocio('Cotacao sem propostas para simular');

  if (entrada.tipo === 'FORNECEDOR_UNICO' && !entrada.fornecedor_id) {
    throw regraNegocio('Cenario de fornecedor unico exige o fornecedor');
  }

  let selecao: Array<{ candidata: Candidata; quantidade: number }>;
  if (entrada.tipo === 'PERSONALIZADO') {
    if (!entrada.selecao?.length) throw regraNegocio('Cenario personalizado exige a selecao dos itens');
    const porItem = new Map(todas.map((c) => [c.cotacao_item_id, c]));
    selecao = entrada.selecao.map((s) => {
      const candidata = porItem.get(s.cotacao_item_id);
      if (!candidata) throw regraNegocio(`Proposta ${s.cotacao_item_id} nao pertence a esta cotacao`);
      return { candidata, quantidade: s.quantidade };
    });
  } else {
    selecao = selecionar(entrada.tipo, todas, { fornecedor_id: entrada.fornecedor_id });
  }

  const produtosTotais = new Set(todas.map((c) => c.cotacao_produto_id)).size;
  const atendidosMap = new Map<number, number>();
  for (const s of selecao) {
    atendidosMap.set(s.candidata.cotacao_produto_id,
      (atendidosMap.get(s.candidata.cotacao_produto_id) ?? 0) + s.quantidade);
  }

  let valorProdutos = 0;
  let freteTotal = 0;
  const prazos: number[] = [];
  const pagamentos: number[] = [];
  const scores: number[] = [];
  const fornecedores = new Set<number>();

  for (const s of selecao) {
    valorProdutos += s.candidata.custo_unitario * s.quantidade;
    if (!fornecedores.has(s.candidata.fornecedor_id)) freteTotal += s.candidata.frete;
    fornecedores.add(s.candidata.fornecedor_id);
    if (s.candidata.prazo_entrega_dias !== null) prazos.push(s.candidata.prazo_entrega_dias);
    if (s.candidata.prazo_pagamento_dias !== null) pagamentos.push(s.candidata.prazo_pagamento_dias);
    scores.push(s.candidata.score);
  }

  let atendidos = 0;
  let quantidadeTotal = 0;
  let quantidadeAtendida = 0;
  for (const produtoId of new Set(todas.map((c) => c.cotacao_produto_id))) {
    const pedida = todas.find((c) => c.cotacao_produto_id === produtoId)!.quantidade_pedida;
    const atendida = atendidosMap.get(produtoId) ?? 0;
    quantidadeTotal += pedida;
    quantidadeAtendida += Math.min(atendida, pedida);
    if (atendida >= pedida) atendidos += 1;
  }

  const custoTotal = valorProdutos + freteTotal;

  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(`
      INSERT INTO cotacao_cenarios
        (cotacao_id, nome, tipo, parametros, valor_produtos, frete_total, custo_total,
         prazo_medio_dias, prazo_maximo_dias, pagamento_medio_dias, score_medio,
         fornecedores, produtos_atendidos, produtos_nao_atendidos,
         atendimento_percentual, criado_por,
         quantidade_atendida, quantidade_total, custo_por_unidade)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING *`,
      [cotacaoId, entrada.nome, entrada.tipo,
        JSON.stringify({ fornecedor_id: entrada.fornecedor_id ?? null }),
        valorProdutos, freteTotal, custoTotal,
        prazos.length ? prazos.reduce((a, b) => a + b, 0) / prazos.length : null,
        prazos.length ? Math.max(...prazos) : null,
        pagamentos.length ? pagamentos.reduce((a, b) => a + b, 0) / pagamentos.length : null,
        scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
        fornecedores.size, atendidos, produtosTotais - atendidos,
        quantidadeTotal > 0 ? (quantidadeAtendida / quantidadeTotal) * 100 : 0,
        contexto.usuarioId ?? null,
        // Comparar cenarios pelo total engana quando eles atendem quantidades
        // diferentes: o que compra menos parece mais barato.
        quantidadeAtendida, quantidadeTotal,
        quantidadeAtendida > 0 ? custoTotal / quantidadeAtendida : null]);

    const cenario = rows[0];
    for (const s of selecao) {
      await cliente.query(`
        INSERT INTO cotacao_cenario_itens
          (cenario_id, cotacao_produto_id, cotacao_item_id, fornecedor_id,
           quantidade, preco_unitario, custo_total)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [cenario.id, s.candidata.cotacao_produto_id, s.candidata.cotacao_item_id,
          s.candidata.fornecedor_id, s.quantidade, s.candidata.custo_unitario,
          s.candidata.custo_unitario * s.quantidade]);
    }

    return { ...cenario, itens: selecao.length };
  });
}

export async function listarCenarios(cotacaoId: number) {
  const { rows } = await query(`
    SELECT c.*, u.nome AS criado_por_nome,
           (SELECT count(*)::int FROM cotacao_cenario_itens i WHERE i.cenario_id = c.id) AS itens
      FROM cotacao_cenarios c
      LEFT JOIN usuarios u ON u.id = c.criado_por
     WHERE c.cotacao_id = $1
     ORDER BY c.custo_total`, [cotacaoId]);
  return rows;
}

export async function detalharCenario(cenarioId: number) {
  const { rows } = await query('SELECT * FROM cotacao_cenarios WHERE id = $1', [cenarioId]);
  if (!rows.length) throw naoEncontrado('Cenario');
  const { rows: itens } = await query(`
    SELECT ci.*, p.codigo, p.descricao, f.razao_social AS fornecedor,
           cp.quantidade AS quantidade_pedida
      FROM cotacao_cenario_itens ci
      JOIN cotacao_produtos cp ON cp.id = ci.cotacao_produto_id
      JOIN produtos p ON p.id = cp.produto_id
      LEFT JOIN fornecedores f ON f.id = ci.fornecedor_id
     WHERE ci.cenario_id = $1
     ORDER BY p.descricao`, [cenarioId]);
  return { ...rows[0], itens };
}

export async function excluirCenario(cenarioId: number) {
  const { rowCount } = await query(
    'DELETE FROM cotacao_cenarios WHERE id = $1', [cenarioId]) as { rowCount: number };
  if (!rowCount) throw naoEncontrado('Cenario');
  return { excluido: true };
}

/** Consolidacao por fornecedor: quanto sai comprando tudo de cada um (secao 28). */
export async function consolidacaoPorFornecedor(cotacaoId: number) {
  const todas = await candidatas(cotacaoId);
  const produtos = new Set(todas.map((c) => c.cotacao_produto_id));
  const fornecedores = new Set(todas.map((c) => c.fornecedor_id));

  return [...fornecedores].map((fornecedorId) => {
    const doFornecedor = todas.filter((c) => c.fornecedor_id === fornecedorId && c.elegivel);
    const valor = doFornecedor.reduce(
      (a, c) => a + c.custo_unitario * Math.min(c.quantidade_pedida, c.quantidade_ofertada), 0);
    const frete = doFornecedor.length ? Math.max(...doFornecedor.map((c) => c.frete)) : 0;
    const prazos = doFornecedor.map((c) => c.prazo_entrega_dias).filter((x): x is number => x !== null);

    return {
      fornecedor_id: fornecedorId,
      fornecedor: doFornecedor[0]?.fornecedor ?? todas.find((c) => c.fornecedor_id === fornecedorId)?.fornecedor,
      produtos_atendidos: doFornecedor.length,
      produtos_totais: produtos.size,
      cobertura_percentual: produtos.size > 0 ? (doFornecedor.length / produtos.size) * 100 : 0,
      valor_produtos: valor,
      frete_estimado: frete,
      custo_total: valor + frete,
      prazo_maximo_dias: prazos.length ? Math.max(...prazos) : null,
      atende_tudo: doFornecedor.length === produtos.size,
    };
  }).sort((a, b) => b.cobertura_percentual - a.cobertura_percentual || a.custo_total - b.custo_total);
}

// ---------------------------------------------------------------------------
// Decisao e aprovacao
// ---------------------------------------------------------------------------

/**
 * Registra a escolha do comprador. Quando ela diverge do que o sistema
 * recomendou, a justificativa passa a ser obrigatoria (secao 64).
 */
export async function selecionarPropostas(
  cotacaoId: number,
  entrada: z.output<typeof selecionarPropostaSchema>,
  contexto: ContextoSessao,
) {
  const analise = await recomendacao(cotacaoId);
  const recomendadaPorProduto = new Map<number, number | null>(
    analise.por_produto.map((p) => [
      Number(p.cotacao_produto_id),
      p.recomendada ? Number(p.recomendada.cotacao_item_id) : null,
    ]),
  );

  const divergencias = entrada.selecoes.filter((s) => {
    const recomendada = recomendadaPorProduto.get(s.cotacao_produto_id);
    return recomendada !== null && recomendada !== undefined && recomendada !== s.cotacao_item_id;
  });

  if (divergencias.length && !entrada.justificativa) {
    throw regraNegocio(
      `Escolha manual diferente da recomendacao em ${divergencias.length} item(ns). Justificativa obrigatoria`,
    );
  }

  return comTransacao(contexto, async (cliente) => {
    const { rows: cotacao } = await cliente.query(
      'SELECT * FROM cotacoes WHERE id = $1 FOR UPDATE', [cotacaoId]);
    if (!cotacao.length) throw naoEncontrado('Cotacao');

    await cliente.query(
      'UPDATE cotacao_itens SET selecionado = false WHERE cotacao_id = $1', [cotacaoId]);

    let valor = 0;
    for (const s of entrada.selecoes) {
      const { rows } = await cliente.query(`
        UPDATE cotacao_itens SET selecionado = true, updated_at = now()
         WHERE id = $1 AND cotacao_id = $2 AND cotacao_produto_id = $3
         RETURNING custo_total_base, elegivel`,
        [s.cotacao_item_id, cotacaoId, s.cotacao_produto_id]);
      if (!rows.length) throw regraNegocio(`Proposta ${s.cotacao_item_id} nao pertence a esta cotacao`);
      if (!rows[0].elegivel) {
        throw regraNegocio(
          `Proposta ${s.cotacao_item_id} esta marcada como nao elegivel e nao pode ser selecionada`,
        );
      }
      valor += Number(rows[0].custo_total_base ?? 0);
    }

    const { rows: atualizada } = await cliente.query(`
      UPDATE cotacoes
         SET decisao_divergente = $2, justificativa_decisao = $3,
             decidido_por = $4, decidido_em = now(),
             valor_selecionado = $5, recomendacao = $6, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [cotacaoId, divergencias.length > 0, entrada.justificativa ?? null,
        contexto.usuarioId ?? null, valor, JSON.stringify(analise.consolidado)]);

    await registrarHistorico(cliente, cotacaoId, cotacao[0].status, cotacao[0].status,
      contexto.usuarioId ?? null,
      divergencias.length ? 'Escolha manual divergente da recomendacao' : 'Selecao registrada',
      { itens: entrada.selecoes.length, divergencias: divergencias.length, valor });

    return {
      ...atualizada[0],
      itens_selecionados: entrada.selecoes.length,
      divergencias: divergencias.length,
    };
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

export async function aprovarCotacao(
  cotacaoId: number, perfilUsuario: string, justificativa: string | undefined, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query('SELECT * FROM cotacoes WHERE id = $1 FOR UPDATE', [cotacaoId]);
    if (!rows.length) throw naoEncontrado('Cotacao');
    const c = rows[0];

    if (!TRANSICOES[c.status]?.includes('APROVADA_NEGOCIACAO')) {
      throw regraNegocio(`Cotacao em ${c.status} nao pode ser aprovada`);
    }

    const { rows: selecionados } = await cliente.query(
      'SELECT count(*)::int AS n, coalesce(sum(custo_total_base), 0) AS valor FROM cotacao_itens WHERE cotacao_id = $1 AND selecionado',
      [cotacaoId]);
    if (Number(selecionados[0].n) === 0) {
      throw regraNegocio('Selecione as propostas antes de aprovar a cotacao');
    }

    const valor = Number(selecionados[0].valor);
    const alcada = await alcadaPara(valor);
    if (perfilUsuario !== 'ADMIN' && alcada && alcada.perfil !== perfilUsuario) {
      throw semPermissao(
        `Valor de ${valor.toFixed(2)} exige aprovacao do perfil ${alcada.perfil}`,
      );
    }

    const { rows: aprovada } = await cliente.query(`
      UPDATE cotacoes
         SET status = 'APROVADA_NEGOCIACAO', aprovador_id = $2, aprovado_em = now(),
             nivel_aprovacao = $3, valor_selecionado = $4, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [cotacaoId, contexto.usuarioId ?? null, alcada?.perfil ?? perfilUsuario, valor]);

    await registrarHistorico(cliente, cotacaoId, c.status, 'APROVADA_NEGOCIACAO',
      contexto.usuarioId ?? null, justificativa ?? null,
      { valor, alcada: alcada?.nome ?? null, itens: Number(selecionados[0].n) });

    return aprovada[0];
  });
}

export async function rejeitarCotacao(
  cotacaoId: number, justificativa: string | undefined, contexto: ContextoSessao,
) {
  if (!justificativa) throw regraNegocio('Rejeicao exige justificativa');
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query('SELECT status FROM cotacoes WHERE id = $1 FOR UPDATE', [cotacaoId]);
    if (!rows.length) throw naoEncontrado('Cotacao');
    if (!TRANSICOES[rows[0].status]?.includes('REJEITADA')) {
      throw regraNegocio(`Cotacao em ${rows[0].status} nao pode ser rejeitada`);
    }
    const { rows: rejeitada } = await cliente.query(`
      UPDATE cotacoes SET status = 'REJEITADA', motivo_rejeicao = $2,
             aprovador_id = $3, aprovado_em = now(), updated_at = now()
       WHERE id = $1 RETURNING *`, [cotacaoId, justificativa, contexto.usuarioId ?? null]);
    await registrarHistorico(cliente, cotacaoId, rows[0].status, 'REJEITADA',
      contexto.usuarioId ?? null, justificativa);
    return rejeitada[0];
  });
}

export async function marcarNegociacao(
  cotacaoId: number, justificativa: string | undefined, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query('SELECT status FROM cotacoes WHERE id = $1 FOR UPDATE', [cotacaoId]);
    if (!rows.length) throw naoEncontrado('Cotacao');
    if (!TRANSICOES[rows[0].status]?.includes('NEGOCIACAO_NECESSARIA')) {
      throw regraNegocio(`Cotacao em ${rows[0].status} nao pode ir para negociacao`);
    }
    const { rows: atualizada } = await cliente.query(
      "UPDATE cotacoes SET status = 'NEGOCIACAO_NECESSARIA', updated_at = now() WHERE id = $1 RETURNING *",
      [cotacaoId]);
    await registrarHistorico(cliente, cotacaoId, rows[0].status, 'NEGOCIACAO_NECESSARIA',
      contexto.usuarioId ?? null, justificativa ?? null);
    return atualizada[0];
  });
}

/**
 * Pacote entregue ao MODULO 07. Nenhum pedido de compra e criado aqui: o que
 * sai e o dossie da decisao, com criterios, pesos e score (secao 61).
 */
export async function encaminharNegociacao(cotacaoId: number, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query('SELECT * FROM cotacoes WHERE id = $1 FOR UPDATE', [cotacaoId]);
    if (!rows.length) throw naoEncontrado('Cotacao');
    const c = rows[0];
    if (!TRANSICOES[c.status]?.includes('ENCAMINHADA')) {
      throw regraNegocio(`Cotacao em ${c.status} nao pode ser encaminhada. Aprove antes`);
    }

    const { rows: itens } = await cliente.query(`
      SELECT ci.id AS cotacao_item_id, ci.fornecedor_id, f.razao_social AS fornecedor,
             ci.produto_id, p.codigo, p.descricao,
             ci.quantidade_ofertada AS quantidade, ci.preco_unitario, ci.preco_liquido,
             ci.desconto, ci.frete, ci.impostos, ci.seguro, ci.desembaraco, ci.taxas,
             ci.custo_total_base AS custo_total, ci.custo_efetivo_unitario,
             ci.prazo_entrega_dias, ci.prazo_pagamento_dias, ci.data_prevista_entrega,
             ci.incoterm, ci.moeda, ci.taxa_cambio, ci.moq, ci.multiplo,
             ci.score, ci.observacao,
             (SELECT coalesce(jsonb_agg(jsonb_build_object(
                       'criterio', cr.codigo, 'valor', cpn.valor_original,
                       'pontuacao', cpn.pontuacao, 'peso', cpn.peso,
                       'ponderada', cpn.pontuacao_ponderada,
                       'dados_insuficientes', cpn.dados_insuficientes)), '[]'::jsonb)
                FROM cotacao_pontuacoes cpn
                JOIN criterios_cotacao cr ON cr.id = cpn.criterio_id
               WHERE cpn.cotacao_item_id = ci.id) AS pontuacoes
        FROM cotacao_itens ci
        JOIN fornecedores f ON f.id = ci.fornecedor_id
        JOIN produtos p ON p.id = ci.produto_id
       WHERE ci.cotacao_id = $1 AND ci.selecionado
       ORDER BY f.razao_social, p.descricao`, [cotacaoId]);

    if (!itens.length) throw regraNegocio('Nenhuma proposta selecionada para encaminhar');

    const { rows: encaminhada } = await cliente.query(
      "UPDATE cotacoes SET status = 'ENCAMINHADA', updated_at = now() WHERE id = $1 RETURNING *",
      [cotacaoId]);

    const pacote = {
      cotacao: {
        id: c.id, numero: c.numero, moeda_base: c.moeda_base,
        aprovado_em: c.aprovado_em, nivel_aprovacao: c.nivel_aprovacao,
        decisao_divergente: c.decisao_divergente,
        justificativa_decisao: c.justificativa_decisao,
      },
      criterios_utilizados: c.pesos_utilizados,
      itens,
      valor_total: itens.reduce((a: number, i: any) => a + Number(i.custo_total ?? 0), 0),
      fornecedores: [...new Set(itens.map((i: any) => i.fornecedor))],
    };

    await registrarHistorico(cliente, cotacaoId, c.status, 'ENCAMINHADA',
      contexto.usuarioId ?? null, 'Encaminhada para negociacao',
      { itens: itens.length, valor_total: pacote.valor_total });

    return { cotacao: encaminhada[0], pacote };
  });
}

export async function pacoteNegociacao(cotacaoId: number) {
  const { rows } = await query(`
    SELECT ci.id AS cotacao_item_id, f.razao_social AS fornecedor, p.codigo, p.descricao,
           ci.quantidade_ofertada AS quantidade, ci.preco_unitario, ci.custo_total_base,
           ci.prazo_entrega_dias, ci.prazo_pagamento_dias, ci.incoterm, ci.moeda, ci.score
      FROM cotacao_itens ci
      JOIN fornecedores f ON f.id = ci.fornecedor_id
      JOIN produtos p ON p.id = ci.produto_id
     WHERE ci.cotacao_id = $1 AND ci.selecionado
     ORDER BY f.razao_social, p.descricao`, [cotacaoId]);
  if (!rows.length) throw naoEncontrado('Selecao desta cotacao');
  return rows;
}
