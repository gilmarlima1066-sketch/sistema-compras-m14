/**
 * Dashboards e indicadores do recebimento e da qualidade (secoes 5, 36, 37,
 * 53 e 63).
 *
 * Tudo aqui e leitura. Como no modulo 08, todo indicador sai com formula,
 * periodo e quantidade de registros - percentual sem base e opiniao.
 */
import { query } from '../../config/database.js';
import { hojeLocal } from '../../core/datas.js';
import type { z } from 'zod';
import type { periodoSchema, toleranciaSchema, checklistSchema } from './recebimento.schemas.js';
import { calcularIndicadores } from './calculos.js';

const num = (v: unknown) => Number(v ?? 0);

function janela(filtro: { dias: number; data_inicio?: string; data_fim?: string }) {
  const fim = filtro.data_fim ?? hojeLocal();
  const inicio = filtro.data_inicio
    ?? new Date(Date.parse(`${fim}T00:00:00Z`) - filtro.dias * 86400000)
      .toISOString().slice(0, 10);
  return { inicio, fim };
}

// ---------------------------------------------------------------------------
// Dashboard operacional (secao 5)
// ---------------------------------------------------------------------------

export async function dashboard(filtro: z.output<typeof periodoSchema>) {
  const periodo = janela(filtro);
  const hoje = hojeLocal();

  const [contagens, quantidades, divergencias, ncs, quarentenas, validade, lotes, porStatus] =
    await Promise.all([
      query(`
        SELECT
          count(*) FILTER (WHERE data_prevista = CURRENT_DATE
                             AND status = 'AGUARDANDO_CHEGADA')::int AS previstos_hoje,
          count(*) FILTER (WHERE data_recebimento = CURRENT_DATE)::int AS realizados_hoje,
          count(*) FILTER (WHERE status IN ('AGUARDANDO_CHEGADA','CHEGOU'))::int AS pendentes,
          count(*) FILTER (WHERE status = 'EM_CONFERENCIA')::int AS em_conferencia,
          count(*) FILTER (WHERE status = 'AGUARDANDO_QUALIDADE')::int AS aguardando_qualidade,
          count(*) FILTER (WHERE status = 'APROVADO')::int AS aprovados,
          count(*) FILTER (WHERE status = 'APROVADO_PARCIALMENTE')::int AS aprovados_parcialmente,
          count(*) FILTER (WHERE status = 'REJEITADO')::int AS rejeitados,
          count(*) FILTER (WHERE status = 'QUARENTENA')::int AS em_quarentena,
          count(*) FILTER (WHERE numero_nota_fiscal IS NULL
                             AND status NOT IN ('CANCELADO'))::int AS sem_nota_fiscal
          FROM recebimentos`),
      query(`
        SELECT coalesce(sum(quantidade_recebida), 0) AS quantidade_recebida,
               coalesce(sum(valor_recebido), 0)      AS valor_recebido,
               coalesce(sum(quantidade_rejeitada), 0) AS quantidade_rejeitada
          FROM recebimentos WHERE data_recebimento BETWEEN $1 AND $2`,
        [periodo.inicio, periodo.fim]),
      query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE decisao = 'PENDENTE')::int AS abertas,
               count(*) FILTER (WHERE tipo IN ('QUANTIDADE_MENOR','QUANTIDADE_MAIOR'))::int AS quantidade,
               count(*) FILTER (WHERE tipo IN ('VALIDADE_DIVERGENTE','PRODUTO_VENCIDO'))::int AS validade,
               count(*) FILTER (WHERE tipo IN ('LOTE_DIVERGENTE','LOTE_AUSENTE'))::int AS lote
          FROM recebimento_divergencias WHERE detectada_em >= $1::date`, [periodo.inicio]),
      query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status NOT IN ('ENCERRADA','CANCELADA'))::int AS abertas,
               count(*) FILTER (WHERE severidade = 'CRITICA')::int AS criticas
          FROM nao_conformidades WHERE created_at >= $1::date`, [periodo.inicio]),
      query(`
        SELECT count(*) FILTER (WHERE status = 'ABERTA')::int AS abertas,
               coalesce(sum(quantidade - quantidade_liberada - quantidade_rejeitada)
                          FILTER (WHERE status = 'ABERTA'), 0) AS quantidade
          FROM quarentenas`),
      query(`
        SELECT count(*)::int AS total FROM recebimento_itens ri
        JOIN recebimentos r ON r.id = ri.recebimento_id
         WHERE ri.situacao_validade IN ('CRITICA','INSUFICIENTE','VENCIDO')
           AND r.status NOT IN ('APROVADO','REJEITADO','CANCELADO')`),
      query(`
        SELECT count(*)::int AS total FROM recebimento_itens ri
        JOIN produtos p ON p.id = ri.produto_id
        JOIN recebimentos r ON r.id = ri.recebimento_id
         WHERE p.controla_lote AND ri.numero_lote IS NULL
           AND r.status NOT IN ('APROVADO','REJEITADO','CANCELADO')`),
      query(`
        SELECT status, count(*)::int AS quantidade FROM recebimentos
         WHERE data_recebimento >= $1::date GROUP BY status ORDER BY 1`, [periodo.inicio]),
    ]);

  const { rows: aguardandoConferencia } = await query(`
    SELECT coalesce(sum(ri.quantidade_pedida), 0) AS quantidade
      FROM recebimento_itens ri
      JOIN recebimentos r ON r.id = ri.recebimento_id
     WHERE ri.conferido_em IS NULL
       AND r.status IN ('CHEGOU','EM_CONFERENCIA','AGUARDANDO_QUALIDADE')`);

  const { rows: diferencaQuantidade } = await query(`
    SELECT count(DISTINCT ri.recebimento_id)::int AS total
      FROM recebimento_itens ri
     WHERE ri.conferido_em IS NOT NULL
       AND abs(ri.quantidade_recebida - ri.quantidade_pedida) > 0`);

  const c = contagens.rows[0];
  const q = quantidades.rows[0];

  return {
    avaliado_em: hoje,
    periodo,
    indicadores: {
      previstos_hoje: Number(c.previstos_hoje),
      realizados_hoje: Number(c.realizados_hoje),
      pendentes: Number(c.pendentes),
      em_conferencia: Number(c.em_conferencia),
      aguardando_qualidade: Number(c.aguardando_qualidade),
      aprovados: Number(c.aprovados),
      aprovados_parcialmente: Number(c.aprovados_parcialmente),
      rejeitados: Number(c.rejeitados),
      em_quarentena: Number(c.em_quarentena),
      divergencias_abertas: Number(divergencias.rows[0].abertas),
      nao_conformidades_abertas: Number(ncs.rows[0].abertas),
      produtos_recusados: num(q.quantidade_rejeitada),
      quantidade_recebida: num(q.quantidade_recebida),
      valor_recebido: num(q.valor_recebido),
      quantidade_aguardando_conferencia: num(aguardandoConferencia[0].quantidade),
      notas_fiscais_pendentes: Number(c.sem_nota_fiscal),
      validade_critica: Number(validade.rows[0].total),
      lote_irregular: Number(lotes.rows[0].total),
      diferenca_quantidade: Number(diferencaQuantidade[0].total),
      quantidade_em_quarentena: num(quarentenas.rows[0].quantidade),
    },
    por_status: porStatus.rows,
    divergencias: divergencias.rows[0],
    nao_conformidades: ncs.rows[0],
  };
}

// ---------------------------------------------------------------------------
// Indicadores de recebimento (secao 37)
// ---------------------------------------------------------------------------

export async function indicadoresRecebimento(filtro: z.output<typeof periodoSchema>) {
  const periodo = janela(filtro);

  const valores: unknown[] = [periodo.inicio, periodo.fim];
  const cond = ['r.data_recebimento BETWEEN $1 AND $2', "r.status <> 'CANCELADO'"];
  if (filtro.fornecedor_id) {
    valores.push(filtro.fornecedor_id);
    cond.push(`r.fornecedor_id = $${valores.length}`);
  }

  const { rows } = await query(`
    SELECT r.status::text, r.data_chegada, r.data_aprovacao,
           r.conferencia_inicio, r.conferencia_fim,
           EXISTS (SELECT 1 FROM recebimento_divergencias d
                    WHERE d.recebimento_id = r.id) AS tem_divergencia
      FROM recebimentos r
     WHERE ${cond.join(' AND ')}`, valores);

  const indicadores = calcularIndicadores(rows.map((r) => ({
    status: r.status,
    temDivergencia: r.tem_divergencia,
    chegadaEm: r.data_chegada ? new Date(r.data_chegada).toISOString() : null,
    concluidoEm: r.data_aprovacao ? new Date(r.data_aprovacao).toISOString() : null,
    conferenciaInicio: r.conferencia_inicio
      ? new Date(r.conferencia_inicio).toISOString() : null,
    conferenciaFim: r.conferencia_fim ? new Date(r.conferencia_fim).toISOString() : null,
  })));

  return {
    periodo: { ...periodo, dias: filtro.dias },
    base_de_dados: 'recebimentos com data no periodo, exceto cancelados',
    registros_encontrados: rows.length,
    ...indicadores,
    atualizado_em: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Dashboard de qualidade (secao 36)
// ---------------------------------------------------------------------------

export async function dashboardQualidade(filtro: z.output<typeof periodoSchema>) {
  const periodo = janela(filtro);

  const [recebimentos, ncPorTipo, ncPorSeveridade, ncPorFornecedor, ncPorProduto,
    ncPorCategoria, devolucoes, resolucao, divergencias] = await Promise.all([
    query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'APROVADO')::int AS aprovados,
             count(*) FILTER (WHERE status = 'APROVADO_PARCIALMENTE')::int AS parciais,
             count(*) FILTER (WHERE status = 'REJEITADO')::int AS rejeitados,
             count(*) FILTER (WHERE status = 'QUARENTENA')::int AS quarentena,
             count(*) FILTER (WHERE status = 'APROVADO'
                                AND NOT EXISTS (SELECT 1 FROM recebimento_divergencias d
                                                 WHERE d.recebimento_id = recebimentos.id))::int
               AS aprovados_sem_ressalva,
             coalesce(sum(quantidade_rejeitada), 0) AS quantidade_recusada
        FROM recebimentos
       WHERE data_recebimento BETWEEN $1 AND $2 AND status <> 'CANCELADO'`,
      [periodo.inicio, periodo.fim]),
    query(`
      SELECT tipo::text, count(*)::int AS total FROM nao_conformidades
       WHERE created_at >= $1::date AND created_at < ($2::date + interval '1 day')
       GROUP BY tipo ORDER BY count(*) DESC`, [periodo.inicio, periodo.fim]),
    query(`
      SELECT severidade::text, count(*)::int AS total FROM nao_conformidades
       WHERE created_at >= $1::date AND created_at < ($2::date + interval '1 day')
       GROUP BY severidade`, [periodo.inicio, periodo.fim]),
    query(`
      SELECT f.id AS fornecedor_id, f.razao_social AS fornecedor, count(*)::int AS total,
             count(*) FILTER (WHERE nc.severidade = 'CRITICA')::int AS criticas
        FROM nao_conformidades nc
        JOIN fornecedores f ON f.id = nc.fornecedor_id
       WHERE nc.created_at >= $1::date AND nc.created_at < ($2::date + interval '1 day')
       GROUP BY f.id, f.razao_social ORDER BY count(*) DESC LIMIT 20`,
      [periodo.inicio, periodo.fim]),
    query(`
      SELECT p.id AS produto_id, p.codigo, p.descricao AS produto, count(*)::int AS total
        FROM nao_conformidades nc
        JOIN produtos p ON p.id = nc.produto_id
       WHERE nc.created_at >= $1::date AND nc.created_at < ($2::date + interval '1 day')
       GROUP BY p.id, p.codigo, p.descricao ORDER BY count(*) DESC LIMIT 20`,
      [periodo.inicio, periodo.fim]),
    query(`
      SELECT c.id AS categoria_id, c.nome AS categoria, count(*)::int AS total
        FROM nao_conformidades nc
        JOIN produtos p ON p.id = nc.produto_id
        JOIN categorias c ON c.id = p.categoria_id
       WHERE nc.created_at >= $1::date AND nc.created_at < ($2::date + interval '1 day')
       GROUP BY c.id, c.nome ORDER BY count(*) DESC LIMIT 20`,
      [periodo.inicio, periodo.fim]),
    query(`
      SELECT count(*)::int AS total, coalesce(sum(quantidade_total), 0) AS quantidade,
             coalesce(sum(valor_total), 0) AS valor
        FROM devolucoes
       WHERE created_at >= $1::date AND created_at < ($2::date + interval '1 day')
         AND status <> 'CANCELADA'`, [periodo.inicio, periodo.fim]),
    query(`
      SELECT avg(EXTRACT(epoch FROM (encerrado_em - created_at)) / 86400) AS dias,
             count(*)::int AS encerradas
        FROM nao_conformidades
       WHERE encerrado_em IS NOT NULL
         AND created_at >= $1::date AND created_at < ($2::date + interval '1 day')`,
      [periodo.inicio, periodo.fim]),
    query(`
      SELECT tipo::text, count(*)::int AS total FROM recebimento_divergencias
       WHERE detectada_em >= $1::date AND detectada_em < ($2::date + interval '1 day')
       GROUP BY tipo ORDER BY count(*) DESC`, [periodo.inicio, periodo.fim]),
  ]);

  const r = recebimentos.rows[0];
  const total = Number(r.total) || 0;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : null);

  return {
    periodo: { ...periodo, dias: filtro.dias },
    base_de_dados: 'recebimentos com data no periodo, exceto cancelados',
    recebimentos_avaliados: total,
    percentuais: {
      aprovados: pct(Number(r.aprovados)),
      aprovados_sem_ressalva: pct(Number(r.aprovados_sem_ressalva)),
      aprovados_parcialmente: pct(Number(r.parciais)),
      rejeitados: pct(Number(r.rejeitados)),
      em_quarentena: pct(Number(r.quarentena)),
    },
    quantidade_recusada: num(r.quantidade_recusada),
    nao_conformidades: {
      total: ncPorTipo.rows.reduce((a, l) => a + Number(l.total), 0),
      por_tipo: ncPorTipo.rows,
      por_severidade: ncPorSeveridade.rows,
      por_fornecedor: ncPorFornecedor.rows,
      por_produto: ncPorProduto.rows,
      por_categoria: ncPorCategoria.rows,
      tempo_medio_resolucao_dias: resolucao.rows[0].dias !== null
        ? num(resolucao.rows[0].dias) : null,
      encerradas_no_periodo: Number(resolucao.rows[0].encerradas),
    },
    devolucoes: devolucoes.rows[0],
    divergencias_por_tipo: divergencias.rows,
    formula: {
      percentuais: 'recebimentos no estado / recebimentos avaliados x 100',
      tempo_resolucao: 'media de (encerramento menos abertura), em dias, das NC encerradas',
    },
  };
}

// ---------------------------------------------------------------------------
// Pacote para o MODULO 10 (secao 63)
// ---------------------------------------------------------------------------

/**
 * Dados brutos do fornecedor para a avaliacao do modulo 10. Nao calcula score:
 * a secao 66 e explicita em deixar o scorecard para o proximo modulo.
 */
export async function pacoteFornecedor(
  fornecedorId: number, filtro: z.output<typeof periodoSchema>,
) {
  const periodo = janela(filtro);

  const [recebimentos, ncs, devolucoes, divergencias, qualidade] = await Promise.all([
    query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'APROVADO')::int AS aprovados,
             count(*) FILTER (WHERE status = 'APROVADO_PARCIALMENTE')::int AS parciais,
             count(*) FILTER (WHERE status = 'REJEITADO')::int AS rejeitados,
             coalesce(sum(quantidade_recebida), 0) AS quantidade_recebida,
             coalesce(sum(quantidade_aceita), 0)   AS quantidade_aceita,
             coalesce(sum(quantidade_rejeitada), 0) AS quantidade_recusada,
             coalesce(sum(quantidade_quarentena), 0) AS quantidade_quarentena,
             coalesce(sum(valor_recebido), 0) AS valor_recebido
        FROM recebimentos
       WHERE fornecedor_id = $1 AND data_recebimento BETWEEN $2 AND $3
         AND status <> 'CANCELADO'`, [fornecedorId, periodo.inicio, periodo.fim]),
    query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE severidade = 'CRITICA')::int AS criticas,
             count(*) FILTER (WHERE status IN ('ENCERRADA','VALIDADA'))::int AS encerradas,
             avg(EXTRACT(epoch FROM (encerrado_em - created_at)) / 86400)
               FILTER (WHERE encerrado_em IS NOT NULL) AS tempo_medio_dias
        FROM nao_conformidades
       WHERE fornecedor_id = $1
         AND created_at >= $2::date AND created_at < ($3::date + interval '1 day')`,
      [fornecedorId, periodo.inicio, periodo.fim]),
    query(`
      SELECT count(*)::int AS total, coalesce(sum(quantidade_total), 0) AS quantidade,
             coalesce(sum(valor_total), 0) AS valor
        FROM devolucoes
       WHERE fornecedor_id = $1 AND status <> 'CANCELADA'
         AND created_at >= $2::date AND created_at < ($3::date + interval '1 day')`,
      [fornecedorId, periodo.inicio, periodo.fim]),
    query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE d.tipo IN ('VALIDADE_DIVERGENTE','PRODUTO_VENCIDO'))::int
               AS validade,
             count(*) FILTER (WHERE d.tipo IN ('LOTE_AUSENTE','LOTE_DIVERGENTE'))::int AS lote,
             count(*) FILTER (WHERE d.tipo IN ('QUANTIDADE_MENOR','QUANTIDADE_MAIOR'))::int
               AS quantidade
        FROM recebimento_divergencias d
        JOIN recebimentos r ON r.id = d.recebimento_id
       WHERE r.fornecedor_id = $1
         AND d.detectada_em >= $2::date AND d.detectada_em < ($3::date + interval '1 day')`,
      [fornecedorId, periodo.inicio, periodo.fim]),
    query(`
      SELECT count(*)::int AS inspecoes,
             count(*) FILTER (WHERE resultado = 'APROVADO')::int AS aprovadas,
             count(*) FILTER (WHERE resultado = 'REPROVADO')::int AS reprovadas,
             count(*) FILTER (WHERE resultado = 'APROVADO_COM_RESSALVA')::int AS com_ressalva
        FROM inspecoes_qualidade
       WHERE fornecedor_id = $1
         AND data_inspecao >= $2::date AND data_inspecao < ($3::date + interval '1 day')`,
      [fornecedorId, periodo.inicio, periodo.fim]),
  ]);

  const { rows: fornecedor } = await query(
    'SELECT razao_social FROM fornecedores WHERE id = $1', [fornecedorId]);

  const rec = recebimentos.rows[0];
  const total = Number(rec.total) || 0;

  return {
    fornecedor_id: fornecedorId,
    fornecedor: fornecedor[0]?.razao_social,
    periodo: { ...periodo, dias: filtro.dias },
    recebimentos: rec,
    taxa_aprovacao: total > 0 ? (Number(rec.aprovados) / total) * 100 : null,
    taxa_rejeicao: total > 0 ? (Number(rec.rejeitados) / total) * 100 : null,
    nao_conformidades: ncs.rows[0],
    devolucoes: devolucoes.rows[0],
    divergencias: divergencias.rows[0],
    qualidade: qualidade.rows[0],
    observacao: 'Dados brutos para o MODULO 10. Nenhum score consolidado e calculado aqui',
  };
}

// ---------------------------------------------------------------------------
// Alertas (secao 53)
// ---------------------------------------------------------------------------

export async function alertas(limite = 200) {
  const lista: Array<Record<string, unknown>> = [];

  const [semLote, validade, divergentes, quarentena, ncCriticas, devolucoes, aprovacao] =
    await Promise.all([
      query(`
        SELECT r.id, r.numero, p.codigo, p.descricao FROM recebimento_itens ri
        JOIN recebimentos r ON r.id = ri.recebimento_id
        JOIN produtos p ON p.id = ri.produto_id
         WHERE p.controla_lote AND ri.numero_lote IS NULL
           AND r.status IN ('CHEGOU','EM_CONFERENCIA','AGUARDANDO_QUALIDADE')
         LIMIT $1`, [limite]),
      query(`
        SELECT r.id, r.numero, p.codigo, ri.situacao_validade::text, ri.data_validade,
               ri.vida_util_restante_percentual
          FROM recebimento_itens ri
          JOIN recebimentos r ON r.id = ri.recebimento_id
          JOIN produtos p ON p.id = ri.produto_id
         WHERE ri.situacao_validade IN ('CRITICA','INSUFICIENTE','VENCIDO')
           AND r.status NOT IN ('APROVADO','REJEITADO','CANCELADO')
         LIMIT $1`, [limite]),
      query(`
        SELECT d.id, d.tipo::text, d.severidade::text, d.descricao, r.id AS recebimento_id,
               r.numero
          FROM recebimento_divergencias d
          JOIN recebimentos r ON r.id = d.recebimento_id
         WHERE d.decisao = 'PENDENTE' LIMIT $1`, [limite]),
      query(`
        SELECT q.id, q.numero, p.codigo, q.quantidade - q.quantidade_liberada
                 - q.quantidade_rejeitada AS saldo, q.motivo
          FROM quarentenas q JOIN produtos p ON p.id = q.produto_id
         WHERE q.status = 'ABERTA' LIMIT $1`, [limite]),
      query(`
        SELECT nc.id, nc.numero, nc.tipo::text, nc.descricao, f.razao_social AS fornecedor
          FROM nao_conformidades nc
          LEFT JOIN fornecedores f ON f.id = nc.fornecedor_id
         WHERE nc.severidade = 'CRITICA' AND nc.status NOT IN ('ENCERRADA','CANCELADA')
         LIMIT $1`, [limite]),
      query(`
        SELECT d.id, d.numero, f.razao_social AS fornecedor, d.quantidade_total
          FROM devolucoes d JOIN fornecedores f ON f.id = d.fornecedor_id
         WHERE d.status = 'RASCUNHO' LIMIT $1`, [limite]),
      query(`
        SELECT r.id, r.numero, f.razao_social AS fornecedor, r.data_chegada
          FROM recebimentos r JOIN fornecedores f ON f.id = r.fornecedor_id
         WHERE r.status = 'AGUARDANDO_QUALIDADE' LIMIT $1`, [limite]),
    ]);

  for (const i of semLote.rows) {
    lista.push({
      tipo: 'LOTE_NAO_INFORMADO', severidade: 'ALTA', recebimento_id: Number(i.id),
      referencia: i.numero,
      mensagem: `${i.codigo} do recebimento ${i.numero} controla lote e esta sem lote informado`,
    });
  }
  for (const i of validade.rows) {
    const vencido = i.situacao_validade === 'VENCIDO';
    lista.push({
      tipo: vencido ? 'PRODUTO_VENCIDO' : 'VALIDADE_INSUFICIENTE',
      severidade: vencido ? 'CRITICA' : 'ALTA',
      recebimento_id: Number(i.id), referencia: i.numero,
      mensagem: vencido
        ? `${i.codigo} do recebimento ${i.numero} esta vencido (${i.data_validade})`
        : `${i.codigo} do recebimento ${i.numero} com validade ${i.situacao_validade}`
          + ` (${num(i.vida_util_restante_percentual).toFixed(1)}% de vida util)`,
    });
  }
  for (const d of divergentes.rows) {
    lista.push({
      tipo: 'RECEBIMENTO_DIVERGENTE',
      severidade: d.severidade === 'CRITICA' ? 'CRITICA' : 'MEDIA',
      recebimento_id: Number(d.recebimento_id), referencia: d.numero,
      divergencia_id: Number(d.id),
      mensagem: `Divergencia ${d.tipo} sem decisao no recebimento ${d.numero}: ${d.descricao}`,
    });
  }
  for (const q of quarentena.rows) {
    lista.push({
      tipo: 'QUARENTENA_ABERTA', severidade: 'ALTA', quarentena_id: Number(q.id),
      referencia: q.numero,
      mensagem: `${q.codigo}: ${num(q.saldo)} em quarentena (${q.numero}) - ${q.motivo}`,
    });
  }
  for (const nc of ncCriticas.rows) {
    lista.push({
      tipo: 'NC_CRITICA', severidade: 'CRITICA', nao_conformidade_id: Number(nc.id),
      referencia: nc.numero,
      mensagem: `NC critica ${nc.numero} (${nc.tipo}) de ${nc.fornecedor}: ${nc.descricao}`,
    });
  }
  for (const d of devolucoes.rows) {
    lista.push({
      tipo: 'DEVOLUCAO_PENDENTE', severidade: 'MEDIA', devolucao_id: Number(d.id),
      referencia: d.numero,
      mensagem: `Devolucao ${d.numero} de ${num(d.quantidade_total)} para ${d.fornecedor} aguarda autorizacao`,
    });
  }
  for (const r of aprovacao.rows) {
    lista.push({
      tipo: 'APROVACAO_PENDENTE', severidade: 'MEDIA', recebimento_id: Number(r.id),
      referencia: r.numero,
      mensagem: `Recebimento ${r.numero} de ${r.fornecedor} aguardando decisao da qualidade`,
    });
  }

  const ordem: Record<string, number> = { CRITICA: 0, ALTA: 1, MEDIA: 2, BAIXA: 3 };
  lista.sort((a, b) => (ordem[String(a.severidade)] ?? 9) - (ordem[String(b.severidade)] ?? 9));

  return {
    total: lista.length,
    por_severidade: {
      CRITICA: lista.filter((l) => l.severidade === 'CRITICA').length,
      ALTA: lista.filter((l) => l.severidade === 'ALTA').length,
      MEDIA: lista.filter((l) => l.severidade === 'MEDIA').length,
    },
    alertas: lista.slice(0, limite),
    avaliado_em: hojeLocal(),
  };
}

// ---------------------------------------------------------------------------
// Controle de validade (secao 15) e FEFO (secao 34)
// ---------------------------------------------------------------------------

/** Lotes em estoque ordenados por validade: e a fila do FEFO. */
export async function controleValidade(filtro: { dias?: number; produto_id?: number }) {
  const dias = filtro.dias ?? 90;
  const valores: unknown[] = [dias];
  const cond = [
    "l.status IN ('DISPONIVEL','QUARENTENA')",
    'l.quantidade_atual > 0',
    "l.data_validade IS NOT NULL",
    `l.data_validade <= CURRENT_DATE + ($1::int || ' days')::interval`,
  ];
  if (filtro.produto_id) {
    valores.push(filtro.produto_id);
    cond.push(`l.produto_id = $${valores.length}`);
  }

  const { rows } = await query(`
    SELECT l.id, l.numero_lote, l.data_fabricacao, l.data_validade, l.quantidade_atual,
           l.status::text, p.codigo, p.descricao AS produto, p.dias_validade,
           f.razao_social AS fornecedor, loc.nome AS local, r.numero AS recebimento,
           l.data_validade - CURRENT_DATE AS dias_restantes,
           CASE WHEN p.dias_validade > 0
                THEN round(((l.data_validade - CURRENT_DATE)::numeric / p.dias_validade) * 100, 2)
           END AS vida_util_restante_percentual
      FROM lotes l
      JOIN produtos p ON p.id = l.produto_id
      LEFT JOIN fornecedores f ON f.id = l.fornecedor_id
      LEFT JOIN locais loc ON loc.id = l.local_id
      LEFT JOIN recebimentos r ON r.id = l.recebimento_id
     WHERE ${cond.join(' AND ')}
     ORDER BY l.data_validade, p.descricao
     LIMIT 500`, valores);

  return {
    janela_dias: dias,
    regra: 'FEFO - o lote com menor validade sai primeiro',
    total: rows.length,
    lotes: rows.map((l) => ({
      ...l,
      situacao: Number(l.dias_restantes) < 0 ? 'VENCIDO'
        : Number(l.dias_restantes) <= 15 ? 'CRITICA'
          : Number(l.dias_restantes) <= 30 ? 'PROXIMA' : 'ADEQUADA',
    })),
  };
}

// ---------------------------------------------------------------------------
// Parametros e tolerancias
// ---------------------------------------------------------------------------

export async function listarParametros() {
  const [config, tolerancias, checklists] = await Promise.all([
    query(`SELECT chave, valor, tipo, descricao FROM configuracoes
            WHERE grupo = 'recebimento' ORDER BY chave`),
    query(`
      SELECT t.*, p.codigo AS produto_codigo, p.descricao AS produto,
             c.nome AS categoria, f.razao_social AS fornecedor
        FROM parametros_tolerancia t
        LEFT JOIN produtos p ON p.id = t.produto_id
        LEFT JOIN categorias c ON c.id = t.categoria_id
        LEFT JOIN fornecedores f ON f.id = t.fornecedor_id
       WHERE t.ativo
       ORDER BY CASE t.escopo WHEN 'EMPRESA' THEN 1 WHEN 'CATEGORIA' THEN 2
                              WHEN 'FORNECEDOR' THEN 3 ELSE 4 END, t.id`),
    query(`
      SELECT c.id, c.codigo, c.nome, c.descricao, c.tipo_amostragem,
             c.percentual_amostra, cat.nome AS categoria,
             count(i.id)::int AS criterios,
             count(i.id) FILTER (WHERE i.eliminatorio)::int AS eliminatorios
        FROM checklists_qualidade c
        LEFT JOIN checklist_qualidade_itens i ON i.checklist_id = c.id
        LEFT JOIN categorias cat ON cat.id = c.categoria_id
       WHERE c.ativo
       GROUP BY c.id, cat.nome
       ORDER BY c.codigo`),
  ]);
  return {
    configuracoes: config.rows,
    tolerancias: tolerancias.rows,
    checklists: checklists.rows,
  };
}

export async function atualizarParametros(
  entrada: Array<{ chave: string; valor: string }>, usuarioId: number | null,
) {
  const atualizados: string[] = [];
  for (const p of entrada) {
    const { rows } = await query(`
      UPDATE configuracoes SET valor = $2, updated_at = now(), updated_by = $3
       WHERE chave = $1 AND grupo = 'recebimento' RETURNING chave`,
      [p.chave, p.valor, usuarioId]);
    if (rows.length) atualizados.push(p.chave);
  }
  return { atualizados, ignorados: entrada.filter((p) => !atualizados.includes(p.chave)) };
}

export async function salvarTolerancia(
  entrada: z.output<typeof toleranciaSchema>, usuarioId: number | null,
) {
  const valores = [
    entrada.quantidade_percentual, entrada.peso_percentual, entrada.valor_percentual,
    entrada.validade_dias, entrada.observacao ?? null, usuarioId,
  ];

  // Cada escopo tem um unico registro ativo (indices parciais no banco).
  // Salvar de novo o mesmo escopo e corrigir a tolerancia, nao criar outra:
  // duas linhas ativas deixariam a regra da secao 13 ambigua.
  const { rows: existente } = await query<{ id: number }>(`
    SELECT id FROM parametros_tolerancia
     WHERE ativo AND escopo = $1
       AND produto_id IS NOT DISTINCT FROM $2
       AND categoria_id IS NOT DISTINCT FROM $3
       AND fornecedor_id IS NOT DISTINCT FROM $4
       AND tipo_operacao IS NOT DISTINCT FROM $5`,
    [entrada.escopo, entrada.produto_id ?? null, entrada.categoria_id ?? null,
      entrada.fornecedor_id ?? null, entrada.tipo_operacao ?? null]);

  if (existente.length) {
    const { rows } = await query(`
      UPDATE parametros_tolerancia
         SET quantidade_percentual = $2, peso_percentual = $3, valor_percentual = $4,
             validade_dias = $5, observacao = $6, updated_by = $7, updated_at = now()
       WHERE id = $1 RETURNING *`, [existente[0].id, ...valores]);
    return rows[0];
  }

  const { rows } = await query(`
    INSERT INTO parametros_tolerancia
      (escopo, produto_id, categoria_id, fornecedor_id, tipo_operacao,
       quantidade_percentual, peso_percentual, valor_percentual, validade_dias,
       observacao, updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING *`,
    [entrada.escopo, entrada.produto_id ?? null, entrada.categoria_id ?? null,
      entrada.fornecedor_id ?? null, entrada.tipo_operacao ?? null, ...valores]);
  return rows[0];
}

export async function salvarChecklist(entrada: z.output<typeof checklistSchema>) {
  const { rows } = await query(`
    INSERT INTO checklists_qualidade
      (codigo, nome, descricao, categoria_id, tipo_amostragem, percentual_amostra)
    VALUES ($1,$2,$3,$4,$5::tipo_amostragem_enum,$6)
    ON CONFLICT (codigo) DO UPDATE
      SET nome = EXCLUDED.nome, descricao = EXCLUDED.descricao,
          categoria_id = EXCLUDED.categoria_id, tipo_amostragem = EXCLUDED.tipo_amostragem,
          percentual_amostra = EXCLUDED.percentual_amostra, updated_at = now()
    RETURNING *`,
    [entrada.codigo, entrada.nome, entrada.descricao ?? null, entrada.categoria_id ?? null,
      entrada.tipo_amostragem, entrada.percentual_amostra ?? null]);

  const checklist = rows[0];
  await query('DELETE FROM checklist_qualidade_itens WHERE checklist_id = $1', [checklist.id]);

  for (const [indice, i] of entrada.itens.entries()) {
    await query(`
      INSERT INTO checklist_qualidade_itens
        (checklist_id, ordem, criterio, descricao, eliminatorio)
      VALUES ($1,$2,$3,$4,$5)`,
      [checklist.id, indice + 1, i.criterio, i.descricao ?? null, i.eliminatorio]);
  }

  return { ...checklist, itens: entrada.itens.length };
}
