/**
 * Indicadores, alertas e timeline do MODULO 07 (secoes 48 a 52).
 *
 * Tudo aqui e leitura. Nenhuma funcao deste arquivo altera pedido, negociacao
 * ou estoque - o painel nunca decide nada, so mostra (secao 80).
 */
import { query } from '../../config/database.js';
import { naoEncontrado } from '../../core/errors.js';

const num = (v: unknown) => Number(v ?? 0);

async function config(): Promise<Record<string, string>> {
  const { rows } = await query<{ chave: string; valor: string }>(
    "SELECT chave, valor FROM configuracoes WHERE grupo = 'pedido'");
  return Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
}

const STATUS_VIVOS = "('RASCUNHO','AGUARDANDO_APROVACAO','APROVADA','ENVIADA','CONFIRMADA','EM_PRODUCAO','EM_TRANSITO','RECEBIMENTO_PARCIAL')";

// ---------------------------------------------------------------------------
// Secao 51 - KPI de negociacao
// ---------------------------------------------------------------------------

export async function kpiNegociacao(dias = 180) {
  const { rows } = await query(`
    SELECT
      count(*)::int                                                          AS total,
      count(*) FILTER (WHERE rodada_atual > 0)::int                          AS com_rodada,
      count(*) FILTER (WHERE status = 'ACORDADA')::int                       AS acordadas,
      count(*) FILTER (WHERE status IN ('APROVADA','CONVERTIDA_PEDIDO'))::int AS aprovadas,
      count(*) FILTER (WHERE status = 'REJEITADA')::int                      AS rejeitadas,
      count(*) FILTER (WHERE status = 'CONVERTIDA_PEDIDO')::int              AS convertidas,
      coalesce(sum(economia_negociada), 0)                                   AS economia_total,
      coalesce(avg(economia_negociada) FILTER (WHERE economia_negociada <> 0), 0) AS economia_media,
      coalesce(avg(economia_percentual) FILTER (WHERE economia_percentual IS NOT NULL), 0) AS reducao_media_percentual,
      coalesce(avg(rodada_atual), 0)                                         AS rodadas_medias,
      coalesce(avg(EXTRACT(epoch FROM (coalesce(acordada_em, aprovado_em) - data_abertura::timestamptz)) / 86400)
                 FILTER (WHERE coalesce(acordada_em, aprovado_em) IS NOT NULL), 0) AS tempo_medio_dias
      FROM negociacoes_compra
     WHERE data_abertura >= now() - ($1::int || ' days')::interval`, [dias]);

  const r = rows[0];
  const total = Number(r.total) || 0;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);

  return {
    periodo_dias: dias,
    total,
    taxa_negociacao: pct(Number(r.com_rodada)),
    economia_total: num(r.economia_total),
    economia_media: num(r.economia_media),
    reducao_media_percentual: num(r.reducao_media_percentual),
    rodadas_medias: num(r.rodadas_medias),
    tempo_medio_dias: num(r.tempo_medio_dias),
    percentual_concluidas: pct(Number(r.acordadas) + Number(r.aprovadas)),
    percentual_rejeitadas: pct(Number(r.rejeitadas)),
    percentual_convertidas: pct(Number(r.convertidas)),
  };
}

// ---------------------------------------------------------------------------
// Secao 52 - KPI do pedido de compra
// ---------------------------------------------------------------------------

export async function kpiPedido(dias = 180) {
  const { rows } = await query(`
    WITH base AS (
      SELECT oc.*,
             (SELECT min(created_at) FROM pedido_historico h
               WHERE h.ordem_compra_id = oc.id AND h.evento = 'ENVIADO_APROVACAO') AS enviado_aprovacao_em,
             (SELECT count(*) FROM pedido_alteracoes a
               WHERE a.ordem_compra_id = oc.id) AS alteracoes,
             (SELECT count(*) FROM ordem_compra_itens i
               WHERE i.ordem_compra_id = oc.id AND i.quantidade_pendente > 0) AS itens_pendentes
        FROM ordens_compra oc
       WHERE oc.data_emissao >= now() - ($1::int || ' days')::interval
    )
    SELECT count(*)::int                                                      AS total,
           count(*) FILTER (WHERE data_confirmacao IS NOT NULL)::int          AS confirmados,
           count(*) FILTER (WHERE alteracoes > 0)::int                        AS alterados,
           count(*) FILTER (WHERE status = 'CANCELADA')::int                  AS cancelados,
           count(*) FILTER (WHERE itens_pendentes > 0)::int                   AS parciais,
           coalesce(avg(EXTRACT(epoch FROM (data_aprovacao - enviado_aprovacao_em)) / 3600)
                      FILTER (WHERE data_aprovacao IS NOT NULL AND enviado_aprovacao_em IS NOT NULL), 0) AS horas_aprovacao,
           coalesce(avg(EXTRACT(epoch FROM (data_envio - data_aprovacao)) / 3600)
                      FILTER (WHERE data_envio IS NOT NULL AND data_aprovacao IS NOT NULL), 0) AS horas_aprovacao_envio,
           coalesce(avg(EXTRACT(epoch FROM (data_confirmacao - data_envio)) / 3600)
                      FILTER (WHERE data_confirmacao IS NOT NULL AND data_envio IS NOT NULL), 0) AS horas_confirmacao,
           coalesce(avg(coalesce(data_prometida, data_prevista_entrega) - data_emissao)
                      FILTER (WHERE coalesce(data_prometida, data_prevista_entrega) IS NOT NULL), 0) AS lead_time_dias
      FROM base`, [dias]);

  const r = rows[0];
  const total = Number(r.total) || 0;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);

  return {
    periodo_dias: dias,
    total,
    lead_time_dias: num(r.lead_time_dias),
    tempo_aprovacao_horas: num(r.horas_aprovacao),
    tempo_aprovacao_envio_horas: num(r.horas_aprovacao_envio),
    tempo_confirmacao_horas: num(r.horas_confirmacao),
    percentual_confirmados: pct(Number(r.confirmados)),
    percentual_alterados: pct(Number(r.alterados)),
    percentual_cancelados: pct(Number(r.cancelados)),
    percentual_parciais: pct(Number(r.parciais)),
  };
}

// ---------------------------------------------------------------------------
// Secao 50 - Indicadores de compras
// ---------------------------------------------------------------------------

/**
 * Saving = economia / preco de referencia. A referencia e o custo inicial da
 * negociacao; sem negociacao vinculada nao ha referencia e o pedido fica de
 * fora do denominador em vez de entrar com saving zero, que distorceria.
 */
export async function indicadoresCompras(dias = 180) {
  const [geral, porComprador, porFornecedor, porCategoria, porPeriodo, atrasos] = await Promise.all([
    query(`
      SELECT coalesce(sum(oc.economia_negociada), 0)                       AS economia,
             coalesce(sum(n.custo_total_inicial), 0)                       AS referencia,
             coalesce(avg(oc.valor_total), 0)                              AS valor_medio,
             coalesce(avg(n.prazo_entrega_atual), 0)                       AS prazo_entrega_medio,
             coalesce(avg(coalesce(cp.dias, n.prazo_pagamento_atual)), 0)  AS prazo_pagamento_medio,
             count(*)::int                                                 AS pedidos
        FROM ordens_compra oc
        LEFT JOIN negociacoes_compra n ON n.id = oc.negociacao_id
        LEFT JOIN condicoes_pagamento cp ON cp.id = oc.condicao_pagamento_id
       WHERE oc.data_emissao >= now() - ($1::int || ' days')::interval
         AND oc.status <> 'CANCELADA'`, [dias]),
    query(`
      SELECT u.id AS comprador_id, u.nome AS comprador, count(*)::int AS pedidos,
             coalesce(sum(oc.valor_total), 0) AS valor,
             coalesce(sum(oc.economia_negociada), 0) AS economia,
             coalesce(sum(n.custo_total_inicial), 0) AS referencia
        FROM ordens_compra oc
        JOIN usuarios u ON u.id = oc.comprador_id
        LEFT JOIN negociacoes_compra n ON n.id = oc.negociacao_id
       WHERE oc.data_emissao >= now() - ($1::int || ' days')::interval
         AND oc.status <> 'CANCELADA'
       GROUP BY u.id, u.nome ORDER BY economia DESC LIMIT 50`, [dias]),
    query(`
      SELECT f.id AS fornecedor_id, f.razao_social AS fornecedor, count(*)::int AS pedidos,
             coalesce(sum(oc.valor_total), 0) AS valor,
             coalesce(sum(oc.economia_negociada), 0) AS economia,
             coalesce(sum(n.custo_total_inicial), 0) AS referencia
        FROM ordens_compra oc
        JOIN fornecedores f ON f.id = oc.fornecedor_id
        LEFT JOIN negociacoes_compra n ON n.id = oc.negociacao_id
       WHERE oc.data_emissao >= now() - ($1::int || ' days')::interval
         AND oc.status <> 'CANCELADA'
       GROUP BY f.id, f.razao_social ORDER BY valor DESC LIMIT 50`, [dias]),
    query(`
      SELECT c.id AS categoria_id, c.nome AS categoria,
             count(DISTINCT oc.id)::int AS pedidos,
             coalesce(sum(oci.valor_total), 0) AS valor,
             coalesce(sum((oci.preco_original - oci.preco_unitario) * oci.quantidade_pedida)
                        FILTER (WHERE oci.preco_original IS NOT NULL), 0) AS economia,
             coalesce(sum(oci.preco_original * oci.quantidade_pedida)
                        FILTER (WHERE oci.preco_original IS NOT NULL), 0) AS referencia,
             coalesce(sum(oci.valor_total) / nullif(sum(oci.quantidade_pedida), 0), 0) AS preco_medio
        FROM ordens_compra oc
        JOIN ordem_compra_itens oci ON oci.ordem_compra_id = oc.id
        JOIN produtos p ON p.id = oci.produto_id
        JOIN categorias c ON c.id = p.categoria_id
       WHERE oc.data_emissao >= now() - ($1::int || ' days')::interval
         AND oc.status <> 'CANCELADA'
       GROUP BY c.id, c.nome ORDER BY valor DESC LIMIT 50`, [dias]),
    query(`
      SELECT to_char(date_trunc('month', oc.data_emissao), 'YYYY-MM') AS periodo,
             count(*)::int AS pedidos,
             coalesce(sum(oc.valor_total), 0) AS valor,
             coalesce(sum(oc.economia_negociada), 0) AS economia,
             coalesce(sum(n.custo_total_inicial), 0) AS referencia
        FROM ordens_compra oc
        LEFT JOIN negociacoes_compra n ON n.id = oc.negociacao_id
       WHERE oc.data_emissao >= now() - ($1::int || ' days')::interval
         AND oc.status <> 'CANCELADA'
       GROUP BY 1 ORDER BY 1`, [dias]),
    query(`
      SELECT
        count(*) FILTER (WHERE oc.status IN ${STATUS_VIVOS}
                           AND coalesce(oc.data_prometida, oc.data_prevista_entrega) < current_date)::int AS atrasados,
        count(*) FILTER (WHERE oc.status = 'CANCELADA')::int AS cancelados,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM ordem_compra_itens i
           WHERE i.ordem_compra_id = oc.id AND i.quantidade_pendente > 0))::int AS parciais,
        count(*)::int AS total,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM pedido_alteracoes a
           WHERE a.ordem_compra_id = oc.id AND a.solicitado_em > oc.data_aprovacao))::int AS alterados_pos_aprovacao
        FROM ordens_compra oc
       WHERE oc.data_emissao >= now() - ($1::int || ' days')::interval`, [dias]),
  ]);

  const saving = (economia: unknown, referencia: unknown) => {
    const r = num(referencia);
    return r > 0 ? (num(economia) / r) * 100 : null;
  };

  const g = geral.rows[0];
  const a = atrasos.rows[0];
  const totalPedidos = Number(a.total) || 0;

  return {
    periodo_dias: dias,
    saving: {
      economia: num(g.economia),
      referencia: num(g.referencia),
      percentual: saving(g.economia, g.referencia),
    },
    valor_medio_pedido: num(g.valor_medio),
    prazo_medio_negociado_dias: num(g.prazo_entrega_medio),
    prazo_medio_pagamento_dias: num(g.prazo_pagamento_medio),
    pedidos_atrasados: Number(a.atrasados),
    pedidos_cancelados: Number(a.cancelados),
    pedidos_parciais: Number(a.parciais),
    percentual_alteracoes_pos_aprovacao:
      totalPedidos > 0 ? (Number(a.alterados_pos_aprovacao) / totalPedidos) * 100 : 0,
    por_comprador: porComprador.rows.map((l) => ({ ...l, saving_percentual: saving(l.economia, l.referencia) })),
    por_fornecedor: porFornecedor.rows.map((l) => ({ ...l, saving_percentual: saving(l.economia, l.referencia) })),
    por_categoria: porCategoria.rows.map((l) => ({ ...l, saving_percentual: saving(l.economia, l.referencia) })),
    por_periodo: porPeriodo.rows.map((l) => ({ ...l, saving_percentual: saving(l.economia, l.referencia) })),
  };
}

// ---------------------------------------------------------------------------
// Secao 49 - Alertas
// ---------------------------------------------------------------------------

export async function alertas(limitePorTipo = 50) {
  const cfg = await config();
  const paradaDias = Number(cfg['pedido.dias_negociacao_parada'] ?? 5);
  const vencimentoDias = Number(cfg['pedido.dias_alerta_vencimento'] ?? 3);

  const [negociacoes, pedidos, confirmacoes, alteracoes] = await Promise.all([
    query(`
      SELECT n.id, n.numero, n.status, f.razao_social AS fornecedor,
             n.data_abertura, n.data_limite, n.rodada_atual,
             (SELECT max(created_at) FROM negociacao_rodadas r WHERE r.negociacao_id = n.id) AS ultima_rodada,
             EXISTS (SELECT 1 FROM negociacao_itens i
                      WHERE i.negociacao_id = n.id AND i.preco_alvo IS NOT NULL
                        AND i.preco_atual > i.preco_alvo) AS acima_do_alvo
        FROM negociacoes_compra n
        JOIN fornecedores f ON f.id = n.fornecedor_id
       WHERE n.status NOT IN ('APROVADA','CONVERTIDA_PEDIDO','REJEITADA','CANCELADA')
       ORDER BY n.data_abertura LIMIT $1`, [limitePorTipo]),
    query(`
      SELECT oc.id, oc.numero, oc.status, f.razao_social AS fornecedor,
             oc.valor_total, oc.data_emissao, oc.data_envio, oc.data_confirmacao,
             coalesce(oc.data_prometida, oc.data_prevista_entrega) AS data_entrega
        FROM ordens_compra oc
        JOIN fornecedores f ON f.id = oc.fornecedor_id
       WHERE oc.status IN ${STATUS_VIVOS} OR oc.status = 'AGUARDANDO_APROVACAO'
       ORDER BY oc.data_emissao DESC LIMIT $1`, [limitePorTipo * 4]),
    query(`
      SELECT oc.id, oc.numero, f.razao_social AS fornecedor,
             sum(i.quantidade_pedida) AS pedida,
             sum(i.quantidade_confirmada) AS confirmada,
             sum(i.quantidade_pendente) AS pendente
        FROM ordens_compra oc
        JOIN fornecedores f ON f.id = oc.fornecedor_id
        JOIN ordem_compra_itens i ON i.ordem_compra_id = oc.id
       WHERE oc.data_confirmacao IS NOT NULL AND oc.status <> 'CANCELADA'
       GROUP BY oc.id, oc.numero, f.razao_social
      HAVING sum(i.quantidade_pendente) > 0
       ORDER BY oc.id DESC LIMIT $1`, [limitePorTipo]),
    query(`
      SELECT a.id, a.ordem_compra_id, oc.numero, a.campo, a.status,
             a.exige_reaprovacao, a.motivo, a.solicitado_em
        FROM pedido_alteracoes a
        JOIN ordens_compra oc ON oc.id = a.ordem_compra_id
       WHERE a.status = 'SOLICITADA'
       ORDER BY a.solicitado_em LIMIT $1`, [limitePorTipo]),
  ]);

  const lista: Array<Record<string, unknown>> = [];
  const agora = Date.now();
  const diasDesde = (d: unknown) => (d ? (agora - new Date(d as string).getTime()) / 86400000 : null);

  for (const n of negociacoes.rows) {
    const parada = diasDesde(n.ultima_rodada ?? n.data_abertura);
    if (parada !== null && parada >= paradaDias) {
      lista.push({
        tipo: 'NEGOCIACAO_PARADA', severidade: 'ALERTA', negociacao_id: n.id, referencia: n.numero,
        mensagem: `Negociacao ${n.numero} sem movimento ha ${Math.floor(parada)} dias`,
      });
    }
    if (n.status === 'AGUARDANDO_FORNECEDOR' && parada !== null && parada >= paradaDias) {
      lista.push({
        tipo: 'FORNECEDOR_SEM_RESPOSTA', severidade: 'ALERTA', negociacao_id: n.id, referencia: n.numero,
        mensagem: `${n.fornecedor} nao respondeu a negociacao ${n.numero}`,
      });
    }
    if (n.acima_do_alvo) {
      lista.push({
        tipo: 'PRECO_ACIMA_DO_ALVO', severidade: 'ATENCAO', negociacao_id: n.id, referencia: n.numero,
        mensagem: `Negociacao ${n.numero} tem item com preco acima do alvo`,
      });
    }
    if (n.data_limite && new Date(n.data_limite as string).getTime() < agora) {
      lista.push({
        tipo: 'PRAZO_ACIMA_DO_NECESSARIO', severidade: 'CRITICO', negociacao_id: n.id, referencia: n.numero,
        mensagem: `Negociacao ${n.numero} passou da data limite`,
      });
    }
  }

  for (const p of pedidos.rows) {
    if (p.status === 'AGUARDANDO_APROVACAO') {
      lista.push({
        tipo: 'PEDIDO_AGUARDANDO_APROVACAO', severidade: 'ALERTA', pedido_id: p.id, referencia: p.numero,
        mensagem: `Pedido ${p.numero} aguarda aprovacao (${num(p.valor_total).toFixed(2)})`,
      });
    }
    if (p.data_envio && !p.data_confirmacao) {
      const espera = diasDesde(p.data_envio);
      if (espera !== null && espera >= paradaDias) {
        lista.push({
          tipo: 'PEDIDO_SEM_CONFIRMACAO', severidade: 'ALERTA', pedido_id: p.id, referencia: p.numero,
          mensagem: `Pedido ${p.numero} enviado ha ${Math.floor(espera)} dias e sem confirmacao`,
        });
      }
    }
    if (p.data_entrega) {
      const faltam = (new Date(p.data_entrega as string).getTime() - agora) / 86400000;
      if (faltam < 0) {
        lista.push({
          tipo: 'PEDIDO_EM_ATRASO', severidade: 'CRITICO', pedido_id: p.id, referencia: p.numero,
          mensagem: `Pedido ${p.numero} com entrega vencida ha ${Math.ceil(-faltam)} dias`,
        });
      } else if (faltam <= vencimentoDias) {
        lista.push({
          tipo: 'PEDIDO_PROXIMO_VENCIMENTO', severidade: 'ATENCAO', pedido_id: p.id, referencia: p.numero,
          mensagem: `Pedido ${p.numero} vence em ${Math.ceil(faltam)} dia(s)`,
        });
      }
    }
  }

  for (const c of confirmacoes.rows) {
    lista.push({
      tipo: 'PEDIDO_PARCIALMENTE_CONFIRMADO', severidade: 'ATENCAO', pedido_id: c.id, referencia: c.numero,
      mensagem: `${c.fornecedor} confirmou ${num(c.confirmada)} de ${num(c.pedida)} - ${num(c.pendente)} pendente`,
    });
  }

  for (const a of alteracoes.rows) {
    lista.push({
      tipo: 'PEDIDO_ALTERADO', severidade: a.exige_reaprovacao ? 'CRITICO' : 'ATENCAO',
      pedido_id: a.ordem_compra_id, referencia: a.numero, alteracao_id: a.id,
      mensagem: `Alteracao de ${a.campo} solicitada no pedido ${a.numero}`
        + (a.exige_reaprovacao ? ' - exige nova aprovacao' : ''),
    });
  }

  const ordem: Record<string, number> = { CRITICO: 0, ALERTA: 1, ATENCAO: 2 };
  lista.sort((x, y) => (ordem[String(x.severidade)] ?? 9) - (ordem[String(y.severidade)] ?? 9));

  return {
    total: lista.length,
    por_severidade: {
      CRITICO: lista.filter((l) => l.severidade === 'CRITICO').length,
      ALERTA: lista.filter((l) => l.severidade === 'ALERTA').length,
      ATENCAO: lista.filter((l) => l.severidade === 'ATENCAO').length,
    },
    alertas: lista,
  };
}

// ---------------------------------------------------------------------------
// Secao 48 - Timeline
// ---------------------------------------------------------------------------

/**
 * Linha do tempo da compra inteira: comeca na cotacao, passa pela negociacao e
 * termina no pedido. Le do historico, que e append-only (secao 68).
 */
export async function timeline(pedidoId: number) {
  const { rows: pedido } = await query(`
    SELECT oc.id, oc.numero, oc.negociacao_id, oc.cotacao_id,
           n.numero AS negociacao, c.numero AS cotacao
      FROM ordens_compra oc
      LEFT JOIN negociacoes_compra n ON n.id = oc.negociacao_id
      LEFT JOIN cotacoes c ON c.id = oc.cotacao_id
     WHERE oc.id = $1`, [pedidoId]);
  if (!pedido.length) throw naoEncontrado('Pedido de compra');
  const p = pedido[0];

  const eventos: Array<Record<string, unknown>> = [];

  if (p.cotacao_id) {
    const { rows } = await query(`
      SELECT h.created_at, h.status_anterior, h.status_novo, h.justificativa, u.nome AS usuario
        FROM cotacao_historico h
        LEFT JOIN usuarios u ON u.id = h.usuario_id
       WHERE h.cotacao_id = $1 ORDER BY h.created_at`, [p.cotacao_id]);
    rows.forEach((r) => eventos.push({
      origem: 'COTACAO', referencia: p.cotacao, momento: r.created_at,
      evento: r.status_novo, status_anterior: r.status_anterior, status_novo: r.status_novo,
      descricao: r.justificativa ?? `Cotacao ${r.status_novo}`, usuario: r.usuario,
    }));
  }

  if (p.negociacao_id) {
    const { rows } = await query(`
      SELECT r.created_at, r.rodada, r.autor, r.justificativa, r.custo_total,
             r.economia_acumulada, u.nome AS usuario
        FROM negociacao_rodadas r
        LEFT JOIN usuarios u ON u.id = r.usuario_id
       WHERE r.negociacao_id = $1 ORDER BY r.rodada`, [p.negociacao_id]);
    rows.forEach((r) => eventos.push({
      origem: 'NEGOCIACAO', referencia: p.negociacao, momento: r.created_at,
      evento: Number(r.rodada) === 0 ? 'NEGOCIACAO_CRIADA'
        : (r.autor === 'FORNECEDOR' ? 'CONTRAPROPOSTA_RECEBIDA' : 'CONTRAPROPOSTA_ENVIADA'),
      descricao: r.justificativa
        ?? `Rodada ${r.rodada} - custo ${num(r.custo_total).toFixed(2)}`,
      usuario: r.usuario,
      valor: num(r.custo_total),
      economia_acumulada: num(r.economia_acumulada),
    }));
  }

  const { rows: hist } = await query(`
    SELECT h.created_at, h.evento, h.descricao, h.status_anterior, h.status_novo,
           u.nome AS usuario
      FROM pedido_historico h
      LEFT JOIN usuarios u ON u.id = h.usuario_id
     WHERE h.ordem_compra_id = $1 ORDER BY h.created_at`, [pedidoId]);
  hist.forEach((r) => eventos.push({
    origem: 'PEDIDO', referencia: p.numero, momento: r.created_at,
    evento: r.evento, descricao: r.descricao,
    status_anterior: r.status_anterior, status_novo: r.status_novo, usuario: r.usuario,
  }));

  eventos.sort((a, b) =>
    new Date(a.momento as string).getTime() - new Date(b.momento as string).getTime());

  return { pedido_id: Number(p.id), numero: p.numero, eventos };
}

// ---------------------------------------------------------------------------
// Dashboard (secoes 5, 50, 51 e 52 reunidas)
// ---------------------------------------------------------------------------

export async function dashboard(dias = 180) {
  const [negociacao, pedido, compras, avisos, funil, economia] = await Promise.all([
    kpiNegociacao(dias),
    kpiPedido(dias),
    indicadoresCompras(dias),
    alertas(20),
    query(`
      SELECT status, count(*)::int AS quantidade, coalesce(sum(custo_total_atual), 0) AS valor
        FROM negociacoes_compra
       WHERE data_abertura >= now() - ($1::int || ' days')::interval
       GROUP BY status ORDER BY 1`, [dias]),
    query(`
      SELECT coalesce(sum(n.custo_total_inicial), 0)   AS valor_original,
             coalesce(sum(n.custo_total_atual), 0)     AS valor_negociado,
             coalesce(sum(n.economia_potencial), 0)    AS economia_potencial,
             coalesce(sum(n.economia_negociada), 0)    AS economia_negociada,
             coalesce(sum(oc.economia_realizada), 0)   AS economia_realizada
        FROM negociacoes_compra n
        LEFT JOIN ordens_compra oc ON oc.negociacao_id = n.id AND oc.status <> 'CANCELADA'
       WHERE n.data_abertura >= now() - ($1::int || ' days')::interval
         AND n.status <> 'CANCELADA'`, [dias]),
  ]);

  const { rows: statusPedido } = await query(`
    SELECT status, count(*)::int AS quantidade, coalesce(sum(valor_total), 0) AS valor
      FROM ordens_compra
     WHERE data_emissao >= now() - ($1::int || ' days')::interval
     GROUP BY status ORDER BY 1`, [dias]);

  const e = economia.rows[0];
  const original = num(e.valor_original);

  return {
    periodo_dias: dias,
    painel_economia: {
      valor_original: original,
      valor_negociado: num(e.valor_negociado),
      economia: num(e.economia_negociada),
      percentual: original > 0 ? (num(e.economia_negociada) / original) * 100 : 0,
      potencial: num(e.economia_potencial),
      negociada: num(e.economia_negociada),
      realizada: num(e.economia_realizada),
    },
    negociacoes_por_status: funil.rows,
    pedidos_por_status: statusPedido,
    kpi_negociacao: negociacao,
    kpi_pedido: pedido,
    indicadores_compras: compras,
    alertas: avisos,
  };
}
