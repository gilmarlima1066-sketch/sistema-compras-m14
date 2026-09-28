/**
 * Coleta dos indicadores que alimentam a avaliacao.
 *
 * Este arquivo NAO inventa metodologia: ele consome o que os modulos 06 a 09
 * ja calculam e entrega numeros crus, com periodo, eventos, formula e fonte.
 *
 * Em particular, OTIF, OTD e In Full vem do modulo 08 pela funcao que ja
 * existe (secao 13: "nao alterar a metodologia existente do modulo 08"). Uma
 * segunda implementacao do OTIF aqui daria dois numeros diferentes para a
 * mesma pergunta, e o fornecedor teria razao em nao acreditar em nenhum.
 */
import { query } from '../../config/database.js';
import { hojeLocal, paraDataCalendario } from '../../core/datas.js';
import * as entregas from '../entregas/indicadores.service.js';
import * as recebimento from '../recebimento/indicadores.service.js';
import {
  estatisticas, indiceGravidade, percentual, posicaoCompetitiva,
  type Grupo, type IndicadorApurado,
} from './calculos.js';

const num = (v: unknown) => Number(v ?? 0);
const ouNulo = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export interface Periodo {
  inicio: string;
  fim: string;
  dias: number;
  rotulo?: string;
}

export interface Recorte {
  categoriaId?: number | null;
  produtoId?: number | null;
  localId?: number | null;
}

/** Peso de cada gravidade no indice de NC (secao 19). */
const PESOS_GRAVIDADE = { CRITICA: 10, ALTA: 5, MEDIA: 2, BAIXA: 1 };

const indicador = (
  grupo: Grupo, codigo: string, nome: string,
  valor: number | null, unidade: string | null, eventos: number,
  formula: string, fonte: string,
): IndicadorApurado => ({
  codigo, nome, grupo, valor, unidade, eventos, minimoEventos: 1, formula, fonte,
});

/** Condicao SQL do recorte, reaproveitada por todos os coletores. */
function recorteSql(
  recorte: Recorte, valores: unknown[],
  colunas: { produto: string; categoria?: string; local?: string },
): string {
  const cond: string[] = [];
  if (recorte.produtoId) {
    valores.push(recorte.produtoId);
    cond.push(`${colunas.produto} = $${valores.length}`);
  }
  if (recorte.categoriaId && colunas.categoria) {
    valores.push(recorte.categoriaId);
    cond.push(`${colunas.categoria} = $${valores.length}`);
  }
  if (recorte.localId && colunas.local) {
    valores.push(recorte.localId);
    cond.push(`${colunas.local} = $${valores.length}`);
  }
  return cond.length ? ` AND ${cond.join(' AND ')}` : '';
}

// ---------------------------------------------------------------------------
// LOGISTICA (secoes 12 a 16) - fonte: modulo 08
// ---------------------------------------------------------------------------

export async function coletarLogistica(
  fornecedorId: number, periodo: Periodo, recorte: Recorte = {},
): Promise<IndicadorApurado[]> {
  const fonte = 'Modulo 08 - entregas e acompanhamento de pedidos';

  // A metodologia do OTIF (data de referencia, tolerancias, unidade) e a do
  // modulo 08, lida das configuracoes dele. Aqui so se consome o resultado.
  const performance = await entregas.performanceFornecedor(fornecedorId, {
    dias: periodo.dias,
    data_inicio: periodo.inicio,
    data_fim: periodo.fim,
  } as any);

  const ind = performance.indicadores;
  const avaliadas = num(ind.avaliadas);

  // Desvio de lead time e percentual de parciais precisam do recorte por
  // produto/categoria/local, que a funcao do modulo 08 nao oferece.
  const valores: unknown[] = [fornecedorId, periodo.inicio, periodo.fim];
  const onde = recorteSql(recorte, valores, {
    produto: 'oci.produto_id',
    categoria: 'p.categoria_id',
    local: 'e.local_id',
  });

  const { rows: prazos } = await query(`
    SELECT (e.data_real - oc.data_emissao)   AS lead_real,
           (e.data_prometida - oc.data_emissao) AS lead_prometido
      FROM entregas e
      JOIN ordens_compra oc ON oc.id = e.ordem_compra_id
      LEFT JOIN entrega_itens ei ON ei.entrega_id = e.id
      LEFT JOIN ordem_compra_itens oci ON oci.id = ei.ordem_compra_item_id
      LEFT JOIN produtos p ON p.id = oci.produto_id
     WHERE oc.fornecedor_id = $1
       AND e.data_real BETWEEN $2::date AND $3::date
       AND e.data_prometida IS NOT NULL ${onde}`, valores);

  const desvios = prazos
    .map((p: any) => num(p.lead_real) - num(p.lead_prometido))
    .filter((v) => Number.isFinite(v));
  const desvio = estatisticas(desvios);

  const valoresParciais: unknown[] = [fornecedorId, periodo.inicio, periodo.fim];
  const ondeParciais = recorteSql(recorte, valoresParciais, {
    produto: 'oci.produto_id',
    categoria: 'p.categoria_id',
    local: 'oc.local_entrega_id',
  });

  const { rows: parciais } = await query(`
    SELECT count(DISTINCT oci.id)::int AS itens,
           count(DISTINCT oci.id) FILTER (
             WHERE oci.quantidade_entregue > 0
               AND oci.quantidade_entregue < oci.quantidade_pedida)::int AS parciais
      FROM ordem_compra_itens oci
      JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
      JOIN produtos p ON p.id = oci.produto_id
     WHERE oc.fornecedor_id = $1
       AND oc.data_emissao BETWEEN $2::date AND $3::date
       AND oc.status NOT IN ('CANCELADA', 'REJEITADA') ${ondeParciais}`, valoresParciais);

  const itens = num(parciais[0]?.itens);

  return [
    indicador('LOGISTICA', 'OTIF', 'OTIF - no prazo e integral',
      ouNulo(ind.otif), '%', avaliadas,
      ind.formula?.otif ?? 'entregas no prazo e integrais / entregas elegiveis x 100', fonte),
    indicador('LOGISTICA', 'OTD', 'OTD - entregas no prazo',
      ouNulo(ind.otd), '%', avaliadas,
      ind.formula?.otd ?? 'entregas no prazo / entregas elegiveis x 100', fonte),
    indicador('LOGISTICA', 'IN_FULL', 'In Full - entregas integrais',
      ouNulo(ind.inFull), '%', avaliadas,
      ind.formula?.inFull ?? 'entregas integrais / entregas elegiveis x 100', fonte),
    indicador('LOGISTICA', 'ATRASO_MEDIO', 'Atraso medio em dias',
      ouNulo(ind.atrasoMedio), 'dias', avaliadas,
      'media dos dias de atraso das entregas avaliadas', fonte),
    indicador('LOGISTICA', 'DESVIO_LEAD_TIME', 'Desvio do lead time contra o prometido',
      desvio.media, 'dias', desvio.amostra,
      'media de (lead time real - lead time prometido), por entrega', fonte),
    indicador('LOGISTICA', 'PERCENTUAL_PARCIAIS', 'Itens entregues parcialmente',
      percentual(num(parciais[0]?.parciais), itens), '%', itens,
      'itens com entrega parcial / itens do periodo x 100', fonte),
  ];
}

// ---------------------------------------------------------------------------
// QUALIDADE (secoes 17 a 19) - fonte: modulo 09
// ---------------------------------------------------------------------------

export async function coletarQualidade(
  fornecedorId: number, periodo: Periodo, recorte: Recorte = {},
): Promise<IndicadorApurado[]> {
  const fonte = 'Modulo 09 - recebimento, inspecao e nao conformidades';

  const pacote = await recebimento.pacoteFornecedor(fornecedorId, {
    dias: periodo.dias,
    data_inicio: periodo.inicio,
    data_fim: periodo.fim,
  } as any);

  const rec: Record<string, any> = pacote.recebimentos ?? {};
  const total = num(rec.total);
  const aprovados = num(rec.aprovados);
  const quantidadeRecebida = num(rec.quantidade_recebida);
  const naoConforme = num(rec.quantidade_recusada) + num(rec.quantidade_quarentena);

  // Recebimentos COM nao conformidade: e a primeira metrica da secao 18, e e
  // diferente de "quantidade de NCs" - dez NCs no mesmo recebimento contam
  // como um recebimento com problema.
  const valores: unknown[] = [fornecedorId, periodo.inicio, periodo.fim];
  const onde = recorteSql(recorte, valores, {
    produto: 'ri.produto_id',
    categoria: 'p.categoria_id',
    local: 'r.local_id',
  });

  const { rows: comNc } = await query(`
    SELECT count(DISTINCT r.id)::int AS recebimentos,
           count(DISTINCT r.id) FILTER (
             WHERE EXISTS (SELECT 1 FROM nao_conformidades n WHERE n.recebimento_id = r.id)
           )::int AS com_nc,
           count(DISTINCT r.id) FILTER (
             WHERE EXISTS (SELECT 1 FROM devolucoes d
                            WHERE d.recebimento_id = r.id AND d.status <> 'CANCELADA')
           )::int AS com_devolucao
      FROM recebimentos r
      LEFT JOIN recebimento_itens ri ON ri.recebimento_id = r.id
      LEFT JOIN produtos p ON p.id = ri.produto_id
     WHERE r.fornecedor_id = $1
       AND r.data_recebimento BETWEEN $2::date AND $3::date
       AND r.status <> 'CANCELADO' ${onde}`, valores);

  const { rows: gravidade } = await query(`
    SELECT count(*) FILTER (WHERE severidade = 'CRITICA')::int AS critica,
           count(*) FILTER (WHERE severidade = 'ALTA')::int    AS alta,
           count(*) FILTER (WHERE severidade = 'MEDIA')::int   AS media,
           count(*) FILTER (WHERE severidade = 'BAIXA')::int   AS baixa,
           count(*)::int AS total
      FROM nao_conformidades
     WHERE fornecedor_id = $1
       AND created_at >= $2::date AND created_at < ($3::date + interval '1 day')`,
    [fornecedorId, periodo.inicio, periodo.fim]);

  const g = gravidade[0] ?? {};
  const avaliados = num(comNc[0]?.recebimentos) || total;

  const indice = indiceGravidade(
    { CRITICA: num(g.critica), ALTA: num(g.alta), MEDIA: num(g.media), BAIXA: num(g.baixa) },
    PESOS_GRAVIDADE, avaliados);

  return [
    indicador('QUALIDADE', 'TAXA_APROVACAO', 'Recebimentos aprovados',
      percentual(aprovados, total), '%', total,
      'recebimentos aprovados / recebimentos avaliados x 100', fonte),
    indicador('QUALIDADE', 'TAXA_NC', 'Recebimentos com nao conformidade',
      percentual(num(comNc[0]?.com_nc), avaliados), '%', avaliados,
      'recebimentos com NC / recebimentos avaliados x 100', fonte),
    indicador('QUALIDADE', 'TAXA_QUANTIDADE_NAO_CONFORME',
      'Quantidade nao conforme sobre a recebida',
      percentual(naoConforme, quantidadeRecebida), '%', total,
      'quantidade recusada mais em quarentena / quantidade recebida x 100', fonte),
    indicador('QUALIDADE', 'INDICE_GRAVIDADE_NC', 'Indice de gravidade das NCs',
      indice.indice, 'pontos', num(g.total), indice.formula, fonte),
    indicador('QUALIDADE', 'TAXA_DEVOLUCAO', 'Recebimentos com devolucao',
      percentual(num(comNc[0]?.com_devolucao), avaliados), '%', avaliados,
      'recebimentos com devolucao / recebimentos avaliados x 100', fonte),
  ];
}

// ---------------------------------------------------------------------------
// COMERCIAL (secao 20) - fonte: modulos 07 e 09
// ---------------------------------------------------------------------------

export async function coletarComercial(
  fornecedorId: number, periodo: Periodo, recorte: Recorte = {},
): Promise<IndicadorApurado[]> {
  const fonte = 'Modulos 07 e 09 - pedidos, itens e recebimento';

  const valores: unknown[] = [fornecedorId, periodo.inicio, periodo.fim];
  const onde = recorteSql(valores.length ? recorte : recorte, valores, {
    produto: 'oci.produto_id',
    categoria: 'p.categoria_id',
    local: 'oc.local_entrega_id',
  });

  // Cumprimento de preco: compara o preco do item do pedido com o que foi
  // efetivamente conferido no recebimento. Divergencia de preco tambem e
  // registrada pelo modulo 09, mas aqui interessa a proporcao de itens que
  // chegaram pelo preco combinado.
  const { rows } = await query(`
    SELECT count(*)::int AS itens,
           count(*) FILTER (
             WHERE ri.preco_unitario IS NULL
                OR abs(ri.preco_unitario - oci.preco_unitario) <= 0.0001
           )::int AS preco_cumprido,
           coalesce(sum(oci.quantidade_pedida), 0)   AS quantidade_pedida,
           coalesce(sum(oci.quantidade_recebida), 0) AS quantidade_recebida
      FROM ordem_compra_itens oci
      JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
      JOIN produtos p ON p.id = oci.produto_id
      LEFT JOIN recebimento_itens ri ON ri.ordem_compra_item_id = oci.id
     WHERE oc.fornecedor_id = $1
       AND oc.data_emissao BETWEEN $2::date AND $3::date
       AND oc.status NOT IN ('CANCELADA', 'REJEITADA') ${onde}`, valores);

  const r = rows[0] ?? {};
  const itens = num(r.itens);

  // Estabilidade: pedidos que chegaram ao fim sem alteracao comercial pedida
  // pelo fornecedor. Alteracao pedida pelo comprador nao conta contra ele.
  const { rows: estabilidade } = await query(`
    SELECT count(*)::int AS pedidos,
           count(*) FILTER (
             WHERE NOT EXISTS (
               SELECT 1 FROM pedido_alteracoes pa
                WHERE pa.ordem_compra_id = oc.id
                  AND pa.status IN ('APROVADA', 'APLICADA')
                  AND pa.campo IN ('preco_unitario', 'condicao_pagamento_id', 'quantidade_pedida')
             ))::int AS sem_alteracao
      FROM ordens_compra oc
     WHERE oc.fornecedor_id = $1
       AND oc.data_emissao BETWEEN $2::date AND $3::date
       AND oc.status NOT IN ('CANCELADA', 'REJEITADA')`,
    [fornecedorId, periodo.inicio, periodo.fim]);

  const pedidos = num(estabilidade[0]?.pedidos);

  return [
    indicador('COMERCIAL', 'CUMPRIMENTO_PRECO', 'Itens recebidos ao preco acordado',
      percentual(num(r.preco_cumprido), itens), '%', itens,
      'itens sem divergencia de preco / itens do periodo x 100', fonte),
    indicador('COMERCIAL', 'CUMPRIMENTO_QUANTIDADE', 'Quantidade recebida sobre a pedida',
      percentual(num(r.quantidade_recebida), num(r.quantidade_pedida)), '%', itens,
      'quantidade recebida / quantidade pedida x 100', fonte),
    indicador('COMERCIAL', 'ESTABILIDADE_COMERCIAL', 'Pedidos sem alteracao comercial',
      percentual(num(estabilidade[0]?.sem_alteracao), pedidos), '%', pedidos,
      'pedidos sem alteracao de preco, prazo de pagamento ou quantidade / pedidos x 100',
      fonte),
  ];
}

// ---------------------------------------------------------------------------
// ATENDIMENTO (secao 24) - fonte: modulos 06, 07 e 08
// ---------------------------------------------------------------------------

export async function coletarAtendimento(
  fornecedorId: number, periodo: Periodo,
): Promise<IndicadorApurado[]> {
  const fonte = 'Modulos 06, 07 e 08 - cotacoes, confirmacao de pedido e ocorrencias';

  const { rows: cotacoes } = await query(`
    SELECT count(*)::int AS convidadas,
           count(*) FILTER (WHERE status IN ('RESPONDIDA', 'PARCIALMENTE_RESPONDIDA'))::int
             AS respondidas,
           avg(EXTRACT(epoch FROM (data_resposta - data_envio)) / 86400)
             FILTER (WHERE data_resposta IS NOT NULL AND data_envio IS NOT NULL)
             AS dias_resposta
      FROM cotacao_fornecedores
     WHERE fornecedor_id = $1
       AND data_envio >= $2::date AND data_envio < ($3::date + interval '1 day')`,
    [fornecedorId, periodo.inicio, periodo.fim]);

  const { rows: pedidos } = await query(`
    SELECT count(*)::int AS enviados,
           count(*) FILTER (WHERE status_confirmacao IN ('CONFIRMADO', 'CONFIRMADO_PARCIALMENTE'))::int
             AS confirmados
      FROM ordens_compra
     WHERE fornecedor_id = $1
       AND data_envio >= $2::date AND data_envio < ($3::date + interval '1 day')
       AND status NOT IN ('RASCUNHO', 'CANCELADA', 'REJEITADA')`,
    [fornecedorId, periodo.inicio, periodo.fim]);

  const { rows: ocorrencias } = await query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'RESOLVIDA')::int AS resolvidas
      FROM ocorrencias_entrega
     WHERE fornecedor_id = $1
       AND data_abertura >= $2::date AND data_abertura < ($3::date + interval '1 day')`,
    [fornecedorId, periodo.inicio, periodo.fim]);

  const convidadas = num(cotacoes[0]?.convidadas);
  const enviados = num(pedidos[0]?.enviados);
  const totalOcorrencias = num(ocorrencias[0]?.total);

  return [
    indicador('ATENDIMENTO', 'TAXA_RESPOSTA_COTACAO', 'Cotacoes respondidas',
      percentual(num(cotacoes[0]?.respondidas), convidadas), '%', convidadas,
      'cotacoes respondidas / cotacoes enviadas ao fornecedor x 100', fonte),
    indicador('ATENDIMENTO', 'TAXA_CONFIRMACAO_PEDIDO', 'Pedidos confirmados',
      percentual(num(pedidos[0]?.confirmados), enviados), '%', enviados,
      'pedidos confirmados / pedidos enviados x 100', fonte),
    indicador('ATENDIMENTO', 'RESOLUCAO_OCORRENCIAS', 'Ocorrencias resolvidas',
      percentual(num(ocorrencias[0]?.resolvidas), totalOcorrencias), '%', totalOcorrencias,
      'ocorrencias resolvidas / ocorrencias abertas x 100', fonte),
    indicador('ATENDIMENTO', 'TEMPO_RESPOSTA_COTACAO', 'Tempo medio de resposta a cotacao',
      ouNulo(cotacoes[0]?.dias_resposta), 'dias', convidadas,
      'media de (data da resposta - data do envio), em dias', fonte),
  ];
}

// ---------------------------------------------------------------------------
// PRECO (secoes 21 e 22) - fonte: historico_precos
// ---------------------------------------------------------------------------

export async function coletarPreco(
  fornecedorId: number, periodo: Periodo, recorte: Recorte = {},
): Promise<IndicadorApurado[]> {
  const fonte = 'Modulo 02 e 07 - historico de precos';

  const valores: unknown[] = [fornecedorId, periodo.inicio, periodo.fim];
  const onde = recorteSql(recorte, valores, {
    produto: 'h.produto_id',
    categoria: 'p.categoria_id',
  });

  // Variacao media ponderada pela quantidade: um reajuste em item de giro alto
  // pesa mais do que o mesmo reajuste num item esporadico.
  const { rows: variacao } = await query(`
    SELECT count(*)::int AS registros,
           sum(h.variacao_percentual * h.quantidade)
             FILTER (WHERE h.variacao_percentual IS NOT NULL) AS soma,
           sum(h.quantidade) FILTER (WHERE h.variacao_percentual IS NOT NULL) AS peso,
           count(*) FILTER (WHERE h.variacao_percentual IS NOT NULL)::int AS com_variacao
      FROM vw_historico_precos h
      JOIN produtos p ON p.id = h.produto_id
     WHERE h.fornecedor_id = $1
       AND h.data BETWEEN $2::date AND $3::date ${onde}`, valores);

  const v = variacao[0] ?? {};
  const pesoVariacao = num(v.peso);
  const variacaoMedia = pesoVariacao > 0 ? num(v.soma) / pesoVariacao : null;

  // Competitividade: para cada produto, o preco medio deste fornecedor contra
  // o menor preco medio entre os fornecedores que forneceram o mesmo produto
  // no periodo.
  const valoresComp: unknown[] = [fornecedorId, periodo.inicio, periodo.fim];
  const ondeComp = recorteSql(recorte, valoresComp, {
    produto: 'h.produto_id',
    categoria: 'p.categoria_id',
  });

  const { rows: competitividade } = await query(`
    WITH medias AS (
      SELECT h.produto_id, h.fornecedor_id, avg(h.preco_unitario) AS preco
        FROM historico_precos h
        JOIN produtos p ON p.id = h.produto_id
       WHERE h.data BETWEEN $2::date AND $3::date ${ondeComp}
       GROUP BY h.produto_id, h.fornecedor_id
    ), comparacao AS (
      SELECT m.produto_id, m.preco AS preco_fornecedor,
             (SELECT min(x.preco) FROM medias x WHERE x.produto_id = m.produto_id) AS menor,
             (SELECT count(DISTINCT x.fornecedor_id) FROM medias x
               WHERE x.produto_id = m.produto_id)::int AS fornecedores
        FROM medias m WHERE m.fornecedor_id = $1
    )
    SELECT * FROM comparacao`, valoresComp);

  const comparaveis = competitividade.filter((c: any) => num(c.fornecedores) > 1);
  const posicoes = comparaveis
    .map((c: any) => posicaoCompetitiva(num(c.preco_fornecedor), num(c.menor)).posicao)
    .filter((p): p is number => p !== null);
  const posicao = estatisticas(posicoes);

  return [
    indicador('PRECO', 'VARIACAO_PRECO', 'Variacao do preco no periodo',
      variacaoMedia === null ? null : Number(variacaoMedia.toFixed(4)), '%',
      num(v.com_variacao),
      'media da variacao percentual ponderada pela quantidade comprada', fonte),
    indicador('PRECO', 'POSICAO_COMPETITIVA',
      'Preco diante do menor preco elegivel do produto',
      posicao.media, '%', posicao.amostra,
      'media de (preco do fornecedor - menor preco do produto) / menor preco x 100,'
      + ' apenas para produtos com mais de um fornecedor', fonte),
    indicador('PRECO', 'REGISTROS_PRECO', 'Registros de preco no periodo',
      num(v.registros), 'registros', num(v.registros),
      'contagem de compras com preco registrado', fonte),
  ];
}

// ---------------------------------------------------------------------------
// PAGAMENTO (secao 23)
// ---------------------------------------------------------------------------

export async function coletarPagamento(
  fornecedorId: number, periodo: Periodo,
): Promise<IndicadorApurado[]> {
  const fonte = 'Modulo 02 e 07 - condicoes de pagamento do cadastro e dos pedidos';

  const { rows } = await query(`
    SELECT count(*)::int AS pedidos,
           avg(cp.dias) FILTER (WHERE cp.dias IS NOT NULL) AS prazo_praticado,
           count(*) FILTER (WHERE cp.dias IS NOT NULL)::int AS com_condicao
      FROM ordens_compra oc
      LEFT JOIN condicoes_pagamento cp ON cp.id = oc.condicao_pagamento_id
     WHERE oc.fornecedor_id = $1
       AND oc.data_emissao BETWEEN $2::date AND $3::date
       AND oc.status NOT IN ('CANCELADA', 'REJEITADA')`,
    [fornecedorId, periodo.inicio, periodo.fim]);

  const { rows: cadastro } = await query(
    'SELECT prazo_medio_pagamento FROM fornecedores WHERE id = $1', [fornecedorId]);

  const praticado = ouNulo(rows[0]?.prazo_praticado);
  const negociado = ouNulo(cadastro[0]?.prazo_medio_pagamento);
  const comCondicao = num(rows[0]?.com_condicao);

  // Aderencia: o quanto o prazo praticado honra o negociado. Acima de 100 e
  // limitado a 100 - pagar depois do combinado favorece o caixa, mas nao e
  // "mais do que cumprir" o acordo.
  const aderencia = praticado !== null && negociado !== null && negociado > 0
    ? Math.min(100, (praticado / negociado) * 100) : null;

  return [
    indicador('PAGAMENTO', 'PRAZO_MEDIO_PAGAMENTO', 'Prazo medio praticado',
      praticado, 'dias', comCondicao,
      'media dos dias da condicao de pagamento dos pedidos do periodo', fonte),
    indicador('PAGAMENTO', 'ADERENCIA_PRAZO', 'Prazo praticado contra o negociado',
      aderencia === null ? null : Number(aderencia.toFixed(2)), '%', comCondicao,
      'prazo medio praticado / prazo do cadastro x 100, limitado a 100', fonte),
    indicador('PAGAMENTO', 'PRAZO_NEGOCIADO', 'Prazo do cadastro',
      negociado, 'dias', negociado === null ? 0 : comCondicao,
      'prazo medio de pagamento registrado no cadastro do fornecedor', fonte),
  ];
}

// ---------------------------------------------------------------------------
// FLEXIBILIDADE (secao 25)
// ---------------------------------------------------------------------------

export async function coletarFlexibilidade(
  fornecedorId: number, periodo: Periodo,
): Promise<IndicadorApurado[]> {
  const fonte = 'Modulos 07 e 08 - alteracoes de pedido e programacao de entrega';

  const { rows: alteracoes } = await query(`
    SELECT count(*)::int AS solicitadas,
           count(*) FILTER (WHERE pa.status IN ('APROVADA', 'APLICADA'))::int AS aceitas
      FROM pedido_alteracoes pa
      JOIN ordens_compra oc ON oc.id = pa.ordem_compra_id
     WHERE oc.fornecedor_id = $1
       AND pa.solicitado_em >= $2::date AND pa.solicitado_em < ($3::date + interval '1 day')`,
    [fornecedorId, periodo.inicio, periodo.fim]);

  const { rows: programacoes } = await query(`
    SELECT count(DISTINCT oc.id)::int AS pedidos,
           count(DISTINCT oc.id) FILTER (
             WHERE EXISTS (SELECT 1 FROM entrega_programacoes ep
                            WHERE ep.ordem_compra_id = oc.id))::int AS programados
      FROM ordens_compra oc
     WHERE oc.fornecedor_id = $1
       AND oc.data_emissao BETWEEN $2::date AND $3::date
       AND oc.status NOT IN ('CANCELADA', 'REJEITADA')`,
    [fornecedorId, periodo.inicio, periodo.fim]);

  const solicitadas = num(alteracoes[0]?.solicitadas);
  const pedidos = num(programacoes[0]?.pedidos);

  return [
    indicador('FLEXIBILIDADE', 'ACEITE_ALTERACOES', 'Alteracoes de pedido aceitas',
      percentual(num(alteracoes[0]?.aceitas), solicitadas), '%', solicitadas,
      'alteracoes aprovadas ou aplicadas / alteracoes solicitadas x 100', fonte),
    indicador('FLEXIBILIDADE', 'PARCELAMENTO_ENTREGA',
      'Pedidos atendidos com entrega programada',
      percentual(num(programacoes[0]?.programados), pedidos), '%', pedidos,
      'pedidos com programacao de entrega / pedidos do periodo x 100', fonte),
  ];
}

// ---------------------------------------------------------------------------
// Coleta completa
// ---------------------------------------------------------------------------

export async function coletarTudo(
  fornecedorId: number, periodo: Periodo, recorte: Recorte = {},
): Promise<IndicadorApurado[]> {
  const [logistica, qualidade, comercial, atendimento, preco, pagamento, flexibilidade] =
    await Promise.all([
      coletarLogistica(fornecedorId, periodo, recorte),
      coletarQualidade(fornecedorId, periodo, recorte),
      coletarComercial(fornecedorId, periodo, recorte),
      coletarAtendimento(fornecedorId, periodo),
      coletarPreco(fornecedorId, periodo, recorte),
      coletarPagamento(fornecedorId, periodo),
      coletarFlexibilidade(fornecedorId, periodo),
    ]);

  return [
    ...logistica, ...qualidade, ...comercial,
    ...atendimento, ...preco, ...pagamento, ...flexibilidade,
  ];
}

/** Volume comprado no periodo: entra no relatorio e na concentracao. */
export async function volumeComprado(
  fornecedorId: number, periodo: Periodo,
): Promise<{ pedidos: number; valor: number; quantidade: number }> {
  const { rows } = await query(`
    SELECT count(*)::int AS pedidos,
           coalesce(sum(oc.valor_total), 0) AS valor,
           coalesce((SELECT sum(oci.quantidade_pedida)
                       FROM ordem_compra_itens oci
                      WHERE oci.ordem_compra_id = ANY(array_agg(oc.id))), 0) AS quantidade
      FROM ordens_compra oc
     WHERE oc.fornecedor_id = $1
       AND oc.data_emissao BETWEEN $2::date AND $3::date
       AND oc.status NOT IN ('RASCUNHO', 'CANCELADA', 'REJEITADA')`,
    [fornecedorId, periodo.inicio, periodo.fim]);

  return {
    pedidos: num(rows[0]?.pedidos),
    valor: num(rows[0]?.valor),
    quantidade: num(rows[0]?.quantidade),
  };
}

/** Janela de datas a partir de dias ou de um intervalo informado. */
export function janela(filtro: {
  dias?: number; data_inicio?: string; data_fim?: string;
}): Periodo {
  const dias = filtro.dias ?? 90;
  const fim = filtro.data_fim ?? hojeLocal();
  const inicio = filtro.data_inicio
    ?? paraDataCalendario(new Date(Date.parse(`${fim}T00:00:00Z`) - dias * 86400000))!;
  return { inicio, fim, dias };
}
