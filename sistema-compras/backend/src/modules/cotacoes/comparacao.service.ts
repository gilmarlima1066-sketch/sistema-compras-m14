import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import {
  avaliarElegibilidade, calcularScore, explicarRecomendacao, fatoresRisco,
  type Direcao, type EntradaCriterio, type PropostaResumo,
} from './pontuacao.js';
import { registrarHistorico } from './cotacoes.service.js';

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

interface Config {
  limiteVariacaoPreco: number;
  limiteDispersao: number;
  diasAlertaValidade: number;
  leadTimeRisco: number;
  minimoFornecedores: number;
}

async function carregarConfig(): Promise<Config> {
  const { rows } = await query<{ chave: string; valor: string }>(
    "SELECT chave, valor FROM configuracoes WHERE grupo = 'cotacao'");
  const m = new Map(rows.map((r) => [r.chave, Number(r.valor)]));
  const v = (k: string, p: number) => (Number.isFinite(m.get(k)) ? (m.get(k) as number) : p);
  return {
    limiteVariacaoPreco: v('cotacao.limite_variacao_preco', 10),
    limiteDispersao: v('cotacao.limite_dispersao_propostas', 20),
    diasAlertaValidade: v('cotacao.dias_alerta_validade_proposta', 3),
    leadTimeRisco: v('cotacao.lead_time_risco_dias', 60),
    minimoFornecedores: v('cotacao.minimo_fornecedores', 3),
  };
}

const diasEntre = (de: string, ate: string) =>
  Math.round((new Date(ate).getTime() - new Date(de).getTime()) / 86400000);

/**
 * Recalcula elegibilidade, pontuacao por criterio, score e recomendacao de
 * toda a cotacao. Grava o resultado para que a tela e o historico mostrem o
 * mesmo numero, e para que a conta possa ser reproduzida depois.
 */
export async function analisar(cotacaoId: number, contexto: ContextoSessao) {
  const config = await carregarConfig();
  const hoje = new Date().toISOString().slice(0, 10);

  const { rows: cotacao } = await query('SELECT * FROM cotacoes WHERE id = $1', [cotacaoId]);
  if (!cotacao.length) throw naoEncontrado('Cotacao');
  const c = cotacao[0];

  const { rows: criterios } = await query(`
    SELECT cc.peso, cc.eliminatorio, cr.id AS criterio_id, cr.codigo, cr.direcao
      FROM cotacao_criterios cc
      JOIN criterios_cotacao cr ON cr.id = cc.criterio_id
     WHERE cc.cotacao_id = $1`, [cotacaoId]);
  if (!criterios.length) throw regraNegocio('Cotacao sem criterios configurados');

  const soma = criterios.reduce((a, r) => a + Number(r.peso), 0);
  if (Math.abs(soma - 100) > 0.01) {
    throw regraNegocio(`A soma dos pesos da cotacao e ${soma.toFixed(2)}, deveria ser 100`);
  }

  const { rows: itens } = await query(`
    SELECT ci.*, cp.quantidade AS quantidade_pedida, cp.data_necessaria,
           cp.validade_minima_dias, cp.preco_maximo, cp.preco_alvo,
           f.razao_social AS fornecedor, f.ativo AS fornecedor_ativo,
           av.otif, av.qualidade,
           hp.ultimo_preco, hp.preco_medio
      FROM cotacao_itens ci
      JOIN cotacao_produtos cp ON cp.id = ci.cotacao_produto_id
      JOIN fornecedores f ON f.id = ci.fornecedor_id
      LEFT JOIN LATERAL (
        SELECT a.otif, a.qualidade FROM avaliacoes_fornecedores a
         WHERE a.fornecedor_id = ci.fornecedor_id
         ORDER BY a.periodo_fim DESC LIMIT 1) av ON true
      LEFT JOIN LATERAL (
        SELECT (array_agg(h.custo_efetivo ORDER BY h.data DESC))[1] AS ultimo_preco,
               avg(h.custo_efetivo) AS preco_medio
          FROM historico_precos h WHERE h.produto_id = ci.produto_id) hp ON true
     WHERE ci.cotacao_id = $1`, [cotacaoId]);

  if (!itens.length) throw regraNegocio('Nenhuma proposta registrada para analisar');

  // ---- elegibilidade -------------------------------------------------------
  const inelegiveis = new Map<number, Array<{ criterio: string; motivo: string }>>();
  for (const item of itens) {
    const motivos = avaliarElegibilidade({
      fornecedorAtivo: Boolean(item.fornecedor_ativo),
      quantidadeOfertada: num(item.quantidade_ofertada),
      quantidadeSolicitada: Number(item.quantidade_pedida),
      validadeProdutoDias: num(item.validade_produto_dias),
      validadeMinimaDias: num(item.validade_minima_dias),
      dataPrevistaEntrega: item.data_prevista_entrega
        ? new Date(item.data_prevista_entrega).toISOString().slice(0, 10) : null,
      dataNecessaria: item.data_necessaria
        ? new Date(item.data_necessaria).toISOString().slice(0, 10) : null,
      disponibilidade: item.disponibilidade,
      validadeProposta: item.validade_proposta
        ? new Date(item.validade_proposta).toISOString().slice(0, 10) : null,
      moq: num(item.moq),
      precoMaximo: num(item.preco_maximo),
      custoUnitario: Number(item.custo_efetivo_unitario ?? 0),
      hoje,
    });
    inelegiveis.set(Number(item.id), motivos);
  }

  // ---- pontuacao, comparando dentro de cada produto -------------------------
  const porProduto = new Map<number, typeof itens>();
  for (const item of itens) {
    const chave = Number(item.cotacao_produto_id);
    if (!porProduto.has(chave)) porProduto.set(chave, []);
    porProduto.get(chave)!.push(item);
  }

  const criterioPorCodigo = new Map(criterios.map((c2) => [c2.codigo, c2]));
  const scores = new Map<number, { score: number; criterios: any[] }>();

  for (const [, grupo] of porProduto) {
    // So propostas elegiveis competem entre si: incluir uma inelegivel
    // distorceria a faixa de normalizacao das demais.
    const competindo = grupo.filter((g) => (inelegiveis.get(Number(g.id)) ?? []).length === 0);
    const alvo = competindo.length ? competindo : grupo;

    const entradas = alvo.map((item) => {
      const quantidadePedida = Number(item.quantidade_pedida);
      const custoTotal = Number(item.custo_total_base ?? item.custo_total ?? 0);
      const criteriosItem: EntradaCriterio[] = [];

      const add = (codigo: string, valor: number | null, texto?: string, observacao?: string) => {
        const def = criterioPorCodigo.get(codigo);
        if (!def) return;
        criteriosItem.push({
          codigo,
          peso: Number(def.peso),
          direcao: def.direcao as Direcao,
          valor,
          valorTexto: texto,
          observacao,
        });
      };

      add('CUSTO_TOTAL', num(item.custo_efetivo_unitario),
        `${Number(item.custo_efetivo_unitario ?? 0).toFixed(4)} por unidade`,
        'Produto + frete + impostos + seguro + taxas - desconto, dividido pela quantidade');
      add('PRAZO_ENTREGA', num(item.prazo_entrega_dias),
        item.prazo_entrega_dias === null ? undefined : `${item.prazo_entrega_dias} dias`);
      add('QUALIDADE', num(item.qualidade),
        item.qualidade === null ? undefined : `indice ${Number(item.qualidade).toFixed(1)}`,
        'Ultima avaliacao registrada do fornecedor');
      add('OTIF', num(item.otif),
        item.otif === null ? undefined : `${Number(item.otif).toFixed(1)}%`,
        'Ultima avaliacao registrada do fornecedor');
      add('PAGAMENTO', num(item.prazo_pagamento_dias),
        item.prazo_pagamento_dias === null ? undefined : `${item.prazo_pagamento_dias} dias`);

      const freteRelativo = custoTotal > 0 ? (Number(item.frete) / custoTotal) * 100 : null;
      add('FRETE', freteRelativo,
        freteRelativo === null ? undefined : `${freteRelativo.toFixed(2)}% do custo total`);

      // Excesso que o MOQ e o multiplo do fornecedor forcam a comprar.
      const moq = num(item.moq);
      const multiplo = num(item.multiplo);
      let excesso: number | null = 0;
      if (moq !== null || multiplo !== null) {
        let quantidade = Math.max(quantidadePedida, moq ?? 0);
        if (multiplo && multiplo > 0) quantidade = Math.ceil(quantidade / multiplo) * multiplo;
        excesso = quantidadePedida > 0 ? ((quantidade - quantidadePedida) / quantidadePedida) * 100 : 0;
      } else {
        excesso = null;
      }
      add('MOQ_MULTIPLO', excesso,
        excesso === null ? undefined : `${excesso.toFixed(1)}% de excesso forcado`,
        'Quanto a mais seria preciso comprar por causa do minimo e do arredondamento');

      return { id: Number(item.id), criterios: criteriosItem };
    });

    const resultado = calcularScore(entradas);
    for (const [id, r] of resultado) {
      scores.set(id, { score: r.score, criterios: r.criterios });
    }
  }

  // ---- grava ---------------------------------------------------------------
  const idCriterio = new Map(criterios.map((c2) => [c2.codigo, Number(c2.criterio_id)]));

  await comTransacao(contexto, async (cliente) => {
    await cliente.query(`
      DELETE FROM cotacao_pontuacoes
       WHERE cotacao_item_id IN (SELECT id FROM cotacao_itens WHERE cotacao_id = $1)`, [cotacaoId]);

    for (const item of itens) {
      const id = Number(item.id);
      const motivos = inelegiveis.get(id) ?? [];
      const resultado = scores.get(id);

      const grupo = porProduto.get(Number(item.cotacao_produto_id)) ?? [];
      const elegiveisDoGrupo = grupo.filter((g) => (inelegiveis.get(Number(g.id)) ?? []).length === 0);

      const ultimoPreco = num(item.ultimo_preco);
      const custoUnitario = Number(item.custo_efetivo_unitario ?? 0);
      const variacao = ultimoPreco && ultimoPreco > 0
        ? ((custoUnitario - ultimoPreco) / ultimoPreco) * 100 : null;

      const riscos = fatoresRisco({
        fornecedoresElegiveis: elegiveisDoGrupo.length,
        disponibilidade: item.disponibilidade,
        leadTimeDias: num(item.prazo_entrega_dias),
        leadTimeRisco: config.leadTimeRisco,
        otif: num(item.otif),
        qualidade: num(item.qualidade),
        moq: num(item.moq),
        quantidadeSolicitada: Number(item.quantidade_pedida),
        variacaoPrecoPercentual: variacao,
        diasParaExpirar: item.validade_proposta
          ? diasEntre(hoje, new Date(item.validade_proposta).toISOString().slice(0, 10)) : null,
        diasAlertaValidade: config.diasAlertaValidade,
      });

      const alertas: Array<{ tipo: string; mensagem: string }> = [...(item.alertas ?? [])]
        .filter((a: any) => !['PRECO_ACIMA_HISTORICO', 'PRECO_ABAIXO_HISTORICO', 'NOVO_MENOR_PRECO'].includes(a.tipo));

      if (variacao !== null && Math.abs(variacao) >= config.limiteVariacaoPreco) {
        alertas.push({
          tipo: variacao > 0 ? 'PRECO_ACIMA_HISTORICO' : 'PRECO_ABAIXO_HISTORICO',
          mensagem: `${variacao > 0 ? '+' : ''}${variacao.toFixed(2)}% contra a ultima compra de ${ultimoPreco!.toFixed(4)}`,
        });
      }
      if (item.preco_alvo && custoUnitario > Number(item.preco_alvo)) {
        alertas.push({
          tipo: 'ACIMA_PRECO_ALVO',
          mensagem: `Custo de ${custoUnitario.toFixed(4)} acima do preco-alvo de ${Number(item.preco_alvo).toFixed(4)}`,
        });
      }

      await cliente.query(`
        UPDATE cotacao_itens
           SET elegivel = $2, motivos_inelegibilidade = $3, score = $4,
               alertas = $5, updated_at = now()
         WHERE id = $1`,
        [id, motivos.length === 0, JSON.stringify(motivos),
          resultado ? resultado.score : null,
          JSON.stringify([...alertas, ...riscos.map((r) => ({ tipo: `RISCO_${r.fator}`, mensagem: r.detalhe }))])]);

      for (const p of resultado?.criterios ?? []) {
        await cliente.query(`
          INSERT INTO cotacao_pontuacoes
            (cotacao_item_id, criterio_id, valor_original, valor_texto, pontuacao,
             peso, pontuacao_ponderada, dados_insuficientes, observacao)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (cotacao_item_id, criterio_id) DO UPDATE SET
            valor_original = EXCLUDED.valor_original, valor_texto = EXCLUDED.valor_texto,
            pontuacao = EXCLUDED.pontuacao, peso = EXCLUDED.peso,
            pontuacao_ponderada = EXCLUDED.pontuacao_ponderada,
            dados_insuficientes = EXCLUDED.dados_insuficientes,
            observacao = EXCLUDED.observacao, calculado_em = now()`,
          [id, idCriterio.get(p.codigo), p.valorOriginal, p.valorTexto ?? null,
            p.pontuacao, p.peso, p.pontuacaoPonderada, p.dadosInsuficientes, p.observacao ?? null]);
      }
    }

    // Posicao e recomendacao por produto.
    await cliente.query(`
      WITH ordenado AS (
        SELECT ci.id,
               row_number() OVER (PARTITION BY ci.cotacao_produto_id
                                  ORDER BY ci.elegivel DESC, ci.score DESC NULLS LAST,
                                           ci.custo_efetivo_unitario ASC NULLS LAST) AS posicao
          FROM cotacao_itens ci WHERE ci.cotacao_id = $1)
      UPDATE cotacao_itens ci
         SET posicao = o.posicao,
             recomendado = (o.posicao = 1 AND ci.elegivel)
        FROM ordenado o WHERE o.id = ci.id`, [cotacaoId]);

    await cliente.query(`
      UPDATE cotacoes
         SET analisada_em = now(),
             pesos_utilizados = $2,
             status = CASE WHEN status IN ('ENVIADA','AGUARDANDO_RESPOSTAS')
                           THEN 'EM_ANALISE'::status_cotacao_enum ELSE status END,
             updated_at = now()
       WHERE id = $1`,
      [cotacaoId, JSON.stringify(criterios.map((c2) => ({ codigo: c2.codigo, peso: Number(c2.peso) })))]);

    await registrarHistorico(cliente, cotacaoId, c.status,
      ['ENVIADA', 'AGUARDANDO_RESPOSTAS'].includes(c.status) ? 'EM_ANALISE' : c.status,
      contexto.usuarioId ?? null, 'Comparativo recalculado',
      { propostas: itens.length, criterios: criterios.length });
  });

  return comparativo(cotacaoId);
}

// ---------------------------------------------------------------------------
// Comparativo
// ---------------------------------------------------------------------------

export async function comparativo(cotacaoId: number) {
  const config = await carregarConfig();

  const { rows: cotacao } = await query(
    'SELECT id, numero, status, moeda_base, referencia_economia, analisada_em FROM cotacoes WHERE id = $1',
    [cotacaoId]);
  if (!cotacao.length) throw naoEncontrado('Cotacao');

  const { rows: linhas } = await query(`
    SELECT cp.id AS cotacao_produto_id, p.id AS produto_id, p.codigo, p.descricao,
           cp.quantidade AS quantidade_pedida, cp.data_necessaria, cp.preco_alvo,
           cp.validade_minima_dias, un.codigo AS unidade,
           ci.id AS cotacao_item_id, ci.fornecedor_id, f.razao_social AS fornecedor,
           f.origem_fornecedor, ci.quantidade_ofertada, ci.preco_unitario, ci.preco_liquido,
           ci.desconto, ci.frete, ci.impostos, ci.seguro, ci.desembaraco, ci.taxas,
           ci.outros_custos, ci.custo_total_base, ci.custo_efetivo_unitario,
           ci.prazo_entrega_dias, ci.prazo_pagamento_dias, ci.data_prevista_entrega,
           ci.disponibilidade, ci.validade_produto_dias, ci.validade_proposta,
           ci.incoterm, ci.moeda, ci.taxa_cambio, ci.moq, ci.multiplo,
           ci.atendimento_percentual, ci.elegivel, ci.motivos_inelegibilidade,
           ci.score, ci.posicao, ci.recomendado, ci.alertas, ci.observacao,
           av.otif, av.qualidade,
           hp.ultimo_preco, hp.preco_medio
      FROM cotacao_produtos cp
      JOIN produtos p ON p.id = cp.produto_id
      LEFT JOIN unidades un ON un.id = cp.unidade_id
      LEFT JOIN cotacao_itens ci ON ci.cotacao_produto_id = cp.id
      LEFT JOIN fornecedores f ON f.id = ci.fornecedor_id
      LEFT JOIN LATERAL (
        SELECT a.otif, a.qualidade FROM avaliacoes_fornecedores a
         WHERE a.fornecedor_id = ci.fornecedor_id
         ORDER BY a.periodo_fim DESC LIMIT 1) av ON true
      LEFT JOIN LATERAL (
        SELECT (array_agg(h.custo_efetivo ORDER BY h.data DESC))[1] AS ultimo_preco,
               avg(h.custo_efetivo) AS preco_medio
          FROM historico_precos h WHERE h.produto_id = cp.produto_id) hp ON true
     WHERE cp.cotacao_id = $1
     ORDER BY p.descricao, ci.posicao NULLS LAST`, [cotacaoId]);

  const produtos = new Map<number, any>();
  for (const l of linhas) {
    const chave = Number(l.cotacao_produto_id);
    if (!produtos.has(chave)) {
      produtos.set(chave, {
        cotacao_produto_id: chave,
        produto_id: l.produto_id,
        codigo: l.codigo,
        descricao: l.descricao,
        unidade: l.unidade,
        quantidade_pedida: Number(l.quantidade_pedida),
        data_necessaria: l.data_necessaria,
        preco_alvo: l.preco_alvo,
        validade_minima_dias: l.validade_minima_dias,
        ultimo_preco: num(l.ultimo_preco),
        preco_medio: num(l.preco_medio),
        propostas: [] as any[],
      });
    }
    if (l.cotacao_item_id) {
      const ultimoPreco = num(l.ultimo_preco);
      const precoMedio = num(l.preco_medio);
      const custo = Number(l.custo_efetivo_unitario ?? 0);
      produtos.get(chave).propostas.push({
        ...l,
        variacao_ultima_compra: ultimoPreco && ultimoPreco > 0
          ? ((custo - ultimoPreco) / ultimoPreco) * 100 : null,
        variacao_preco_medio: precoMedio && precoMedio > 0
          ? ((custo - precoMedio) / precoMedio) * 100 : null,
      });
    }
  }

  const lista = [...produtos.values()].map((p) => {
    const elegiveis = p.propostas.filter((x: any) => x.elegivel);
    const custos = elegiveis.map((x: any) => Number(x.custo_efetivo_unitario)).filter(Number.isFinite);
    const menor = custos.length ? Math.min(...custos) : null;
    const maior = custos.length ? Math.max(...custos) : null;
    const dispersao = menor && menor > 0 && maior ? ((maior - menor) / menor) * 100 : null;

    return {
      ...p,
      propostas_recebidas: p.propostas.length,
      propostas_elegiveis: elegiveis.length,
      sem_resposta: p.propostas.length === 0,
      menor_custo_unitario: menor,
      maior_custo_unitario: maior,
      dispersao_percentual: dispersao,
      divergencia_relevante: dispersao !== null && dispersao >= config.limiteDispersao,
      recomendada: p.propostas.find((x: any) => x.recomendado) ?? null,
    };
  });

  return { cotacao: cotacao[0], produtos: lista, limites: config };
}

/** Matriz produto x fornecedor para a metrica escolhida (secao 22). */
export async function matriz(cotacaoId: number, metrica: string) {
  const dados = await comparativo(cotacaoId);
  const coluna: Record<string, string> = {
    CUSTO_UNITARIO: 'custo_efetivo_unitario',
    PRECO_UNITARIO: 'preco_unitario',
    PRECO_LIQUIDO: 'preco_liquido',
    CUSTO_TOTAL: 'custo_total_base',
    PRAZO: 'prazo_entrega_dias',
    PAGAMENTO: 'prazo_pagamento_dias',
    MOQ: 'moq',
    SCORE: 'score',
    DISPONIBILIDADE: 'disponibilidade',
  };
  const campo = coluna[metrica] ?? 'custo_efetivo_unitario';

  const fornecedores = new Map<number, string>();
  for (const p of dados.produtos) {
    for (const prop of p.propostas) fornecedores.set(Number(prop.fornecedor_id), prop.fornecedor);
  }

  return {
    metrica,
    fornecedores: [...fornecedores].map(([id, nome]) => ({ fornecedor_id: id, fornecedor: nome })),
    linhas: dados.produtos.map((p: any) => ({
      cotacao_produto_id: p.cotacao_produto_id,
      codigo: p.codigo,
      descricao: p.descricao,
      quantidade: p.quantidade_pedida,
      valores: [...fornecedores.keys()].map((fid) => {
        const prop = p.propostas.find((x: any) => Number(x.fornecedor_id) === fid);
        if (!prop) return { fornecedor_id: fid, valor: null, sem_resposta: true };
        return {
          fornecedor_id: fid,
          valor: prop[campo] ?? null,
          elegivel: prop.elegivel,
          recomendado: prop.recomendado,
          melhor: p.menor_custo_unitario !== null
            && Number(prop.custo_efetivo_unitario) === p.menor_custo_unitario,
        };
      }),
    })),
  };
}

/** "Como esta proposta foi avaliada?" (secao 19). */
export async function detalharPontuacao(cotacaoItemId: number) {
  const { rows: item } = await query(`
    SELECT ci.*, f.razao_social AS fornecedor, p.codigo, p.descricao,
           cp.quantidade AS quantidade_pedida
      FROM cotacao_itens ci
      JOIN fornecedores f ON f.id = ci.fornecedor_id
      JOIN produtos p ON p.id = ci.produto_id
      JOIN cotacao_produtos cp ON cp.id = ci.cotacao_produto_id
     WHERE ci.id = $1`, [cotacaoItemId]);
  if (!item.length) throw naoEncontrado('Proposta');

  const { rows: pontuacoes } = await query(`
    SELECT cp.*, cr.codigo, cr.nome, cr.direcao, cr.descricao AS criterio_descricao
      FROM cotacao_pontuacoes cp
      JOIN criterios_cotacao cr ON cr.id = cp.criterio_id
     WHERE cp.cotacao_item_id = $1
     ORDER BY cr.ordem`, [cotacaoItemId]);

  const somaPesos = pontuacoes
    .filter((p) => !p.dados_insuficientes)
    .reduce((a, p) => a + Number(p.peso), 0);
  const somaPonderada = pontuacoes
    .filter((p) => !p.dados_insuficientes)
    .reduce((a, p) => a + Number(p.pontuacao_ponderada ?? 0), 0);

  const i = item[0];
  return {
    proposta: i,
    custo: {
      valor_produtos: Number(i.preco_unitario ?? 0) * Number(i.quantidade_ofertada ?? 0)
        * Number(i.taxa_cambio ?? 1),
      desconto: Number(i.desconto ?? 0) * Number(i.taxa_cambio ?? 1),
      frete: Number(i.frete ?? 0) * Number(i.taxa_cambio ?? 1),
      impostos: Number(i.impostos ?? 0) * Number(i.taxa_cambio ?? 1),
      seguro: Number(i.seguro ?? 0) * Number(i.taxa_cambio ?? 1),
      desembaraco: Number(i.desembaraco ?? 0) * Number(i.taxa_cambio ?? 1),
      taxas: Number(i.taxas ?? 0) * Number(i.taxa_cambio ?? 1),
      outros_custos: Number(i.outros_custos ?? 0) * Number(i.taxa_cambio ?? 1),
      custo_total: Number(i.custo_total_base ?? 0),
      custo_unitario: Number(i.custo_efetivo_unitario ?? 0),
      formula: 'custo total = produtos - desconto + frete + impostos + seguro + desembaraco + taxas + outros',
    },
    criterios: pontuacoes,
    soma_pesos_utilizados: somaPesos,
    soma_ponderada: somaPonderada,
    score: Number(i.score ?? 0),
    formula_score: 'score = soma(pontuacao x peso) / soma(pesos com dado) x 100',
    elegivel: i.elegivel,
    motivos_inelegibilidade: i.motivos_inelegibilidade,
  };
}

// ---------------------------------------------------------------------------
// Recomendacao e economia
// ---------------------------------------------------------------------------

export async function recomendacao(cotacaoId: number) {
  const dados = await comparativo(cotacaoId);

  const porProduto = dados.produtos.map((p: any) => {
    const resumos: PropostaResumo[] = p.propostas.map((x: any) => ({
      id: Number(x.cotacao_item_id),
      fornecedor: x.fornecedor,
      custoUnitario: Number(x.custo_efetivo_unitario ?? 0),
      custoTotal: Number(x.custo_total_base ?? 0),
      prazoEntregaDias: num(x.prazo_entrega_dias),
      prazoPagamentoDias: num(x.prazo_pagamento_dias),
      otif: num(x.otif),
      qualidade: num(x.qualidade),
      atendimentoPercentual: Number(x.atendimento_percentual ?? 0),
      score: Number(x.score ?? 0),
      elegivel: Boolean(x.elegivel),
    }));

    const { recomendada, texto, fatores } = explicarRecomendacao(resumos);
    return {
      cotacao_produto_id: p.cotacao_produto_id,
      codigo: p.codigo,
      descricao: p.descricao,
      quantidade: p.quantidade_pedida,
      propostas_recebidas: p.propostas_recebidas,
      propostas_elegiveis: p.propostas_elegiveis,
      recomendada: recomendada
        ? p.propostas.find((x: any) => Number(x.cotacao_item_id) === recomendada.id)
        : null,
      explicacao: texto,
      fatores,
      inelegiveis: p.propostas
        .filter((x: any) => !x.elegivel)
        .map((x: any) => ({
          fornecedor: x.fornecedor,
          motivos: x.motivos_inelegibilidade,
        })),
    };
  });

  const atendidos = porProduto.filter((p) => p.recomendada).length;
  const custoRecomendado = porProduto.reduce(
    (a, p) => a + Number(p.recomendada?.custo_total_base ?? 0), 0);
  const fretes = porProduto.reduce((a, p) => a + Number(p.recomendada?.frete ?? 0), 0);
  const prazos = porProduto.map((p) => num(p.recomendada?.prazo_entrega_dias)).filter((x): x is number => x !== null);
  const pagamentos = porProduto.map((p) => num(p.recomendada?.prazo_pagamento_dias)).filter((x): x is number => x !== null);
  const scores = porProduto.map((p) => num(p.recomendada?.score)).filter((x): x is number => x !== null);
  const fornecedores = new Set(porProduto.map((p) => p.recomendada?.fornecedor_id).filter(Boolean));

  return {
    cotacao: dados.cotacao,
    por_produto: porProduto,
    consolidado: {
      produtos_atendidos: atendidos,
      produtos_nao_atendidos: porProduto.length - atendidos,
      fornecedores: fornecedores.size,
      custo_total: custoRecomendado,
      frete_total: fretes,
      prazo_medio_dias: prazos.length ? prazos.reduce((a, b) => a + b, 0) / prazos.length : null,
      prazo_maximo_dias: prazos.length ? Math.max(...prazos) : null,
      pagamento_medio_dias: pagamentos.length
        ? pagamentos.reduce((a, b) => a + b, 0) / pagamentos.length : null,
      score_medio: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    },
  };
}

/**
 * Economia potencial contra o preco de referencia escolhido na cotacao.
 * Potencial, nunca realizada: so vira economia quando a compra acontecer.
 */
export async function economia(cotacaoId: number) {
  const dados = await comparativo(cotacaoId);
  const referencia = dados.cotacao.referencia_economia as string;

  const linhas = dados.produtos.map((p: any) => {
    const escolhida = p.recomendada;
    if (!escolhida) {
      return {
        codigo: p.codigo, descricao: p.descricao, quantidade: p.quantidade_pedida,
        referencia: null, custo_referencia: null, custo_proposto: null,
        economia_absoluta: null, economia_percentual: null,
        motivo: 'Sem proposta elegivel',
      };
    }

    const base = referencia === 'PRECO_MEDIO' ? p.preco_medio
      : referencia === 'PRECO_ALVO' ? num(p.preco_alvo)
        : p.ultimo_preco;

    const quantidade = Number(p.quantidade_pedida);
    const custoProposto = Number(escolhida.custo_efetivo_unitario) * quantidade;
    const custoReferencia = base !== null ? base * quantidade : null;

    return {
      codigo: p.codigo,
      descricao: p.descricao,
      quantidade,
      fornecedor: escolhida.fornecedor,
      referencia,
      preco_referencia: base,
      custo_referencia: custoReferencia,
      custo_proposto: custoProposto,
      economia_absoluta: custoReferencia !== null ? custoReferencia - custoProposto : null,
      economia_percentual: custoReferencia && custoReferencia > 0
        ? ((custoReferencia - custoProposto) / custoReferencia) * 100 : null,
      motivo: custoReferencia === null ? 'Sem preco de referencia no historico' : null,
    };
  });

  const comBase = linhas.filter((l) => l.economia_absoluta !== null);
  const total = comBase.reduce((a, l) => a + (l.economia_absoluta ?? 0), 0);
  const totalReferencia = comBase.reduce((a, l) => a + (l.custo_referencia ?? 0), 0);

  return {
    referencia,
    linhas,
    itens_sem_referencia: linhas.length - comBase.length,
    economia_absoluta: total,
    economia_percentual: totalReferencia > 0 ? (total / totalReferencia) * 100 : null,
    observacao: 'Economia potencial. So e considerada realizada quando a compra for concluida',
  };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function dashboard() {
  const { rows } = await query(`
    SELECT
      count(*) FILTER (WHERE status = 'RASCUNHO')::int                    AS rascunho,
      count(*) FILTER (WHERE status IN ('ENVIADA','AGUARDANDO_RESPOSTAS'))::int AS aguardando,
      count(*) FILTER (WHERE status = 'EM_ANALISE')::int                  AS em_analise,
      count(*) FILTER (WHERE status = 'NEGOCIACAO_NECESSARIA')::int       AS negociacao,
      count(*) FILTER (WHERE status IN ('APROVADA_NEGOCIACAO','ENCAMINHADA'))::int AS aprovadas,
      count(*) FILTER (WHERE status = 'REJEITADA')::int                   AS rejeitadas,
      count(*) FILTER (WHERE data_limite < CURRENT_DATE
                        AND status IN ('ENVIADA','AGUARDANDO_RESPOSTAS'))::int AS vencidas,
      count(*)::int                                                       AS total
      FROM cotacoes`);

  const { rows: valores } = await query(`
    SELECT coalesce(sum(ci.custo_total_base), 0)                         AS valor_total_cotado,
           coalesce(avg(ci.custo_total_base), 0)                         AS valor_medio_proposta,
           count(DISTINCT ci.fornecedor_id)::int                         AS fornecedores_participantes,
           count(DISTINCT ci.produto_id)::int                            AS produtos_cotados
      FROM cotacao_itens ci
      JOIN cotacoes c ON c.id = ci.cotacao_id
     WHERE c.status NOT IN ('CANCELADA','REJEITADA')`);

  const { rows: semResposta } = await query(`
    SELECT count(*)::int AS n
      FROM cotacao_produtos cp
      JOIN cotacoes c ON c.id = cp.cotacao_id
     WHERE c.status IN ('AGUARDANDO_RESPOSTAS','EM_ANALISE')
       AND NOT EXISTS (SELECT 1 FROM cotacao_itens ci WHERE ci.cotacao_produto_id = cp.id)`);

  const { rows: divergentes } = await query(`
    WITH faixa AS (
      SELECT ci.cotacao_produto_id,
             min(ci.custo_efetivo_unitario) AS menor,
             max(ci.custo_efetivo_unitario) AS maior
        FROM cotacao_itens ci WHERE ci.elegivel
       GROUP BY ci.cotacao_produto_id HAVING count(*) > 1)
    SELECT count(*)::int AS n FROM faixa
     WHERE menor > 0 AND (maior - menor) / menor * 100 >=
       (SELECT valor::numeric FROM configuracoes WHERE chave = 'cotacao.limite_dispersao_propostas')`);

  const [porStatus, porFornecedor, porCategoria, evolucao] = await Promise.all([
    query(`SELECT status::text, count(*)::int AS cotacoes FROM cotacoes GROUP BY 1 ORDER BY 2 DESC`),
    query(`
      SELECT f.razao_social AS fornecedor, count(DISTINCT ci.cotacao_id)::int AS cotacoes,
             coalesce(sum(ci.custo_total_base), 0) AS valor
        FROM cotacao_itens ci JOIN fornecedores f ON f.id = ci.fornecedor_id
       GROUP BY 1 ORDER BY valor DESC LIMIT 15`),
    query(`
      SELECT cat.nome AS categoria, count(DISTINCT cp.cotacao_id)::int AS cotacoes,
             coalesce(sum(ci.custo_total_base), 0) AS valor
        FROM cotacao_produtos cp
        JOIN produtos p ON p.id = cp.produto_id
        JOIN categorias cat ON cat.id = p.categoria_id
        LEFT JOIN cotacao_itens ci ON ci.cotacao_produto_id = cp.id AND ci.recomendado
       GROUP BY 1 ORDER BY valor DESC LIMIT 15`),
    query(`
      SELECT date_trunc('month', c.data_abertura)::date AS mes,
             count(DISTINCT c.id)::int AS cotacoes,
             coalesce(avg(ci.custo_efetivo_unitario), 0) AS preco_medio
        FROM cotacoes c LEFT JOIN cotacao_itens ci ON ci.cotacao_id = c.id
       GROUP BY 1 ORDER BY 1`),
  ]);

  return {
    indicadores: {
      ...rows[0],
      ...valores[0],
      produtos_sem_resposta: semResposta[0]?.n ?? 0,
      produtos_com_divergencia: divergentes[0]?.n ?? 0,
    },
    por_status: porStatus.rows,
    por_fornecedor: porFornecedor.rows,
    por_categoria: porCategoria.rows,
    evolucao: evolucao.rows,
  };
}
