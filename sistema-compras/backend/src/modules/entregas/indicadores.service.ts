/**
 * Indicadores logisticos: OTD, In Full, OTIF, lead time, performance por
 * fornecedor, dashboards, calendario e alertas (secoes 5, 20, 36 a 43, 54,
 * 59, 60 e 79).
 *
 * Duas regras atravessam o arquivo:
 *   - secao 79: todo indicador sai com formula, periodo, base e quantidade de
 *     registros. Um percentual solto nao e informacao, e opiniao.
 *   - secao 81: performance com historico curto sai marcada como amostra
 *     insuficiente, nao como um numero que parece solido.
 */
import { query } from '../../config/database.js';
import type { z } from 'zod';
import type { calendarioSchema, periodoSchema } from './entregas.schemas.js';
import {
  avaliarSla, calcularIndicadores, estatisticas,
  type LinhaOtif, type RegraOtif,
} from './calculos.js';
import {
  avaliarLinha, configuracoes, hojeIso, parametros,
} from './acompanhamento.service.js';

const num = (v: unknown) => Number(v ?? 0);
const dataIso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string).toISOString().slice(0, 10);

export function regraOtif(cfg: Record<string, string>): RegraOtif {
  return {
    referencia: (cfg['entrega.otif_referencia'] === 'DATA_NECESSARIA'
      ? 'DATA_NECESSARIA' : 'DATA_PROMETIDA'),
    toleranciaDias: Number(cfg['entrega.otif_tolerancia_dias'] ?? 0),
    toleranciaQuantidadePercentual: Number(cfg['entrega.otif_tolerancia_quantidade_percentual'] ?? 0),
    unidade: (cfg['entrega.otif_unidade'] === 'PEDIDO' ? 'PEDIDO' : 'ITEM'),
  };
}

/** Janela do periodo pedido, como datas explicitas para sair no resultado. */
function janela(filtro: { dias: number; data_inicio?: string; data_fim?: string }) {
  const fim = filtro.data_fim ?? hojeIso();
  const inicio = filtro.data_inicio
    ?? new Date(Date.parse(`${fim}T00:00:00Z`) - filtro.dias * 86400000)
      .toISOString().slice(0, 10);
  return { inicio, fim };
}

/**
 * Base do OTIF: uma linha por item entregue (ou por entrega, se a unidade
 * configurada for PEDIDO). So entra o que ja foi entregue - pedido em aberto
 * nao e falha de OTIF, e simplesmente ainda nao aconteceu.
 */
async function baseOtif(
  periodo: { inicio: string; fim: string },
  regra: RegraOtif,
  filtros: { fornecedor_id?: number; comprador_id?: number; categoria_id?: number },
) {
  const valores: unknown[] = [periodo.inicio, periodo.fim];
  const cond: string[] = ['e.data_real BETWEEN $1 AND $2'];
  if (filtros.fornecedor_id) { valores.push(filtros.fornecedor_id); cond.push(`oc.fornecedor_id = $${valores.length}`); }
  if (filtros.comprador_id) { valores.push(filtros.comprador_id); cond.push(`oc.comprador_id = $${valores.length}`); }
  if (filtros.categoria_id) { valores.push(filtros.categoria_id); cond.push(`p.categoria_id = $${valores.length}`); }

  if (regra.unidade === 'PEDIDO') {
    const { rows } = await query(`
      SELECT e.id, oc.fornecedor_id, f.razao_social AS fornecedor, oc.comprador_id,
             e.data_real AS data_efetiva,
             CASE WHEN $${valores.length + 1} = 'DATA_NECESSARIA'
                  THEN coalesce(e.data_necessaria, oc.data_necessaria)
                  ELSE coalesce(e.data_prometida, oc.data_prometida) END AS data_referencia,
             coalesce(sum(ei.quantidade), e.quantidade_entregue, 0) AS entregue,
             (SELECT sum(oci.quantidade_pedida) FROM ordem_compra_itens oci
               WHERE oci.ordem_compra_id = oc.id)                   AS esperada,
             oc.data_emissao, oc.numero AS pedido
        FROM entregas e
        JOIN ordens_compra oc ON oc.id = e.ordem_compra_id
        JOIN fornecedores f ON f.id = oc.fornecedor_id
        LEFT JOIN entrega_itens ei ON ei.entrega_id = e.id
        LEFT JOIN produtos p ON p.id = ei.produto_id
       WHERE ${cond.join(' AND ')}
       GROUP BY e.id, oc.id, f.razao_social
       ORDER BY e.data_real`, [...valores, regra.referencia]);
    return rows;
  }

  const { rows } = await query(`
    SELECT ei.id, oc.fornecedor_id, f.razao_social AS fornecedor, oc.comprador_id,
           coalesce(ei.data_efetiva, e.data_real) AS data_efetiva,
           CASE WHEN $${valores.length + 1} = 'DATA_NECESSARIA'
                THEN coalesce(ei.data_necessaria, oci.data_necessaria, oc.data_necessaria)
                ELSE coalesce(ei.data_prometida, oci.data_prometida, oc.data_prometida) END AS data_referencia,
           ei.quantidade AS entregue,
           oci.quantidade_pedida AS esperada,
           oc.data_emissao, oc.numero AS pedido,
           p.id AS produto_id, p.codigo, p.descricao AS produto, p.categoria_id
      FROM entrega_itens ei
      JOIN entregas e ON e.id = ei.entrega_id
      JOIN ordens_compra oc ON oc.id = e.ordem_compra_id
      JOIN fornecedores f ON f.id = oc.fornecedor_id
      JOIN ordem_compra_itens oci ON oci.id = ei.ordem_compra_item_id
      JOIN produtos p ON p.id = ei.produto_id
     WHERE ${cond.join(' AND ')}
     ORDER BY e.data_real`, [...valores, regra.referencia]);
  return rows;
}

const paraLinha = (r: any): LinhaOtif => ({
  dataReferencia: dataIso(r.data_referencia),
  dataEfetiva: dataIso(r.data_efetiva),
  quantidadeEsperada: num(r.esperada),
  quantidadeEntregue: num(r.entregue),
});

// ---------------------------------------------------------------------------
// OTIF geral (secoes 37, 38, 39 e 79)
// ---------------------------------------------------------------------------

export async function indicadoresOtif(filtro: z.output<typeof periodoSchema>) {
  const cfg = await configuracoes();
  const regra = regraOtif(cfg);
  const minimo = Number(cfg['entrega.otif_minimo_entregas'] ?? 5);
  const periodo = janela(filtro);

  const base = await baseOtif(periodo, regra, filtro);
  const indicadores = calcularIndicadores(base.map(paraLinha), regra, minimo);

  const leadTimes = base
    .map((r) => {
      const emissao = dataIso(r.data_emissao);
      const efetiva = dataIso(r.data_efetiva);
      return emissao && efetiva
        ? Math.round((Date.parse(efetiva) - Date.parse(emissao)) / 86400000) : NaN;
    })
    .filter((v) => Number.isFinite(v));

  return {
    periodo: { ...periodo, dias: filtro.dias },
    base_de_dados: regra.unidade === 'ITEM'
      ? 'itens de entrega com data efetiva no periodo'
      : 'entregas com data efetiva no periodo',
    registros_encontrados: base.length,
    ...indicadores,
    lead_time: estatisticas(leadTimes),
    atualizado_em: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Performance por fornecedor (secoes 40, 41, 42 e 43)
// ---------------------------------------------------------------------------

/**
 * Nao devolve score unico: a secao 41 e explicita em separar OTIF, OTD, In
 * Full e lead time, deixando a avaliacao consolidada para o modulo 10.
 */
export async function performanceFornecedores(filtro: z.output<typeof periodoSchema>) {
  const cfg = await configuracoes();
  const regra = regraOtif(cfg);
  const minimo = Number(cfg['entrega.otif_minimo_entregas'] ?? 5);
  const periodo = janela(filtro);

  const base = await baseOtif(periodo, regra, filtro);

  const porFornecedor = new Map<number, { nome: string; linhas: any[] }>();
  for (const r of base) {
    const id = Number(r.fornecedor_id);
    if (!porFornecedor.has(id)) porFornecedor.set(id, { nome: r.fornecedor, linhas: [] });
    porFornecedor.get(id)!.linhas.push(r);
  }

  const { rows: volumes } = await query(`
    SELECT oc.fornecedor_id,
           count(DISTINCT oc.id)::int AS pedidos,
           coalesce(sum(oc.valor_total), 0) AS valor_comprado,
           count(DISTINCT e.id)::int AS entregas,
           count(*) FILTER (WHERE ap.id IS NOT NULL)::int AS alteracoes_prazo,
           count(DISTINCT oc.id) FILTER (WHERE oc.status_confirmacao = 'NAO_CONFIRMADO')::int AS sem_confirmacao
      FROM ordens_compra oc
      LEFT JOIN entregas e ON e.ordem_compra_id = oc.id AND e.data_real BETWEEN $1 AND $2
      LEFT JOIN alteracoes_prazo ap ON ap.ordem_compra_id = oc.id
     WHERE oc.data_emissao BETWEEN $1 AND $2 AND oc.status <> 'CANCELADA'
     GROUP BY oc.fornecedor_id`, [periodo.inicio, periodo.fim]);
  const porVolume = new Map(volumes.map((v) => [Number(v.fornecedor_id), v]));

  const fornecedores = [...porFornecedor.entries()].map(([id, { nome, linhas }]) => {
    const ind = calcularIndicadores(linhas.map(paraLinha), regra, minimo);
    const v = porVolume.get(id);

    const leadTimes = linhas
      .map((r) => {
        const emissao = dataIso(r.data_emissao);
        const efetiva = dataIso(r.data_efetiva);
        return emissao && efetiva
          ? Math.round((Date.parse(efetiva) - Date.parse(emissao)) / 86400000) : NaN;
      })
      .filter((x) => Number.isFinite(x));

    const parciais = linhas.filter((r) => num(r.entregue) < num(r.esperada)).length;

    return {
      fornecedor_id: id,
      fornecedor: nome,
      entregas_avaliadas: ind.avaliadas,
      entregas_ignoradas: ind.ignoradas,
      otif: ind.otif,
      otd: ind.otd,
      in_full: ind.inFull,
      atraso_medio: ind.atrasoMedio,
      atraso_maximo: ind.atrasoMaximo,
      lead_time: estatisticas(leadTimes),
      percentual_parciais: linhas.length ? (parciais / linhas.length) * 100 : null,
      percentual_alteracoes_prazo: v && Number(v.pedidos) > 0
        ? (Number(v.alteracoes_prazo) / Number(v.pedidos)) * 100 : null,
      percentual_sem_confirmacao: v && Number(v.pedidos) > 0
        ? (Number(v.sem_confirmacao) / Number(v.pedidos)) * 100 : null,
      pedidos: v ? Number(v.pedidos) : 0,
      valor_comprado: v ? num(v.valor_comprado) : 0,
      quantidade_entregue: linhas.reduce((a, r) => a + num(r.entregue), 0),
      amostra_suficiente: ind.amostraSuficiente,
      observacao: ind.amostraSuficiente ? undefined
        : `AMOSTRA INSUFICIENTE: ${ind.avaliadas} entrega(s) avaliada(s), minimo ${minimo}`,
    };
  });

  // Amostra suficiente vem primeiro: um fornecedor com uma entrega a 100%
  // nao pode liderar o ranking sobre outro com 65 entregas medidas.
  fornecedores.sort((a, b) => {
    if (a.amostra_suficiente !== b.amostra_suficiente) return a.amostra_suficiente ? -1 : 1;
    return (b.otif ?? -1) - (a.otif ?? -1);
  });

  return {
    periodo: { ...periodo, dias: filtro.dias },
    regra,
    minimo_entregas: minimo,
    observacao: 'Todos os fornecedores desta lista usam o mesmo periodo, a mesma metodologia '
      + 'e as mesmas tolerancias. Quem tem amostra insuficiente aparece no fim da lista.',
    fornecedores,
  };
}

/** Performance logistica de um fornecedor, com evolucao mensal (secao 43). */
export async function performanceFornecedor(
  fornecedorId: number, filtro: z.output<typeof periodoSchema>,
) {
  const cfg = await configuracoes();
  const regra = regraOtif(cfg);
  const minimo = Number(cfg['entrega.otif_minimo_entregas'] ?? 5);
  const periodo = janela(filtro);

  const base = await baseOtif(periodo, regra, { fornecedor_id: fornecedorId });
  const ind = calcularIndicadores(base.map(paraLinha), regra, minimo);

  const porMes = new Map<string, any[]>();
  for (const r of base) {
    const mes = dataIso(r.data_efetiva)!.slice(0, 7);
    if (!porMes.has(mes)) porMes.set(mes, []);
    porMes.get(mes)!.push(r);
  }

  const evolucao = [...porMes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, linhas]) => {
      const i = calcularIndicadores(linhas.map(paraLinha), regra, minimo);
      return {
        periodo: mes,
        entregas: i.avaliadas,
        otif: i.otif,
        otd: i.otd,
        in_full: i.inFull,
        atraso_medio: i.atrasoMedio,
      };
    });

  const { rows: prazos } = await query(`
    SELECT e.data_real - oc.data_emissao AS lead_real,
           e.data_prometida - oc.data_emissao AS lead_prometido,
           f.lead_time_padrao_dias AS lead_contratado
      FROM entregas e
      JOIN ordens_compra oc ON oc.id = e.ordem_compra_id
      JOIN fornecedores f ON f.id = oc.fornecedor_id
     WHERE oc.fornecedor_id = $1 AND e.data_real BETWEEN $2 AND $3`,
    [fornecedorId, periodo.inicio, periodo.fim]);

  const { rows: fornecedor } = await query(
    'SELECT razao_social, lead_time_padrao_dias FROM fornecedores WHERE id = $1', [fornecedorId]);

  return {
    fornecedor_id: fornecedorId,
    fornecedor: fornecedor[0]?.razao_social,
    periodo: { ...periodo, dias: filtro.dias },
    indicadores: ind,
    lead_time: {
      contratado: fornecedor[0]?.lead_time_padrao_dias ?? null,
      prometido: estatisticas(prazos.map((p) => Number(p.lead_prometido)).filter(Number.isFinite)),
      real: estatisticas(prazos.map((p) => Number(p.lead_real)).filter(Number.isFinite)),
    },
    evolucao,
  };
}

// ---------------------------------------------------------------------------
// Atrasos (secoes 27 e 28)
// ---------------------------------------------------------------------------

export async function indicadoresAtrasos(filtro: z.output<typeof periodoSchema>) {
  const cfg = await configuracoes();
  const regra = regraOtif(cfg);
  const p = parametros(cfg);
  const periodo = janela(filtro);

  const base = await baseOtif(periodo, regra, filtro);

  const atrasadas = base
    .map((r) => {
      const ref = dataIso(r.data_referencia);
      const ef = dataIso(r.data_efetiva);
      return ref && ef ? Math.round((Date.parse(ef) - Date.parse(ref)) / 86400000) : null;
    })
    .filter((d): d is number => d !== null && d > 0);

  const faixa = (min: number, max: number | null) =>
    atrasadas.filter((d) => d >= min && (max === null || d <= max)).length;

  const { rows: motivos } = await query(`
    SELECT ma.codigo, ma.descricao, ma.responsavel, count(*)::int AS ocorrencias
      FROM entregas e
      JOIN motivos_atraso ma ON ma.id = e.motivo_atraso_id
     WHERE e.data_real BETWEEN $1 AND $2
     GROUP BY ma.codigo, ma.descricao, ma.responsavel
     ORDER BY count(*) DESC`, [periodo.inicio, periodo.fim]);

  const est = estatisticas(atrasadas);

  return {
    periodo: { ...periodo, dias: filtro.dias },
    entregas_no_periodo: base.length,
    entregas_atrasadas: atrasadas.length,
    percentual_atrasadas: base.length ? (atrasadas.length / base.length) * 100 : null,
    atraso_medio: est.media,
    atraso_mediano: est.mediana,
    atraso_maximo: est.maximo,
    faixas: {
      NO_PRAZO: base.length - atrasadas.length,
      LEVE: faixa(1, p.faixasAtraso.leveAte),
      MODERADO: faixa(p.faixasAtraso.leveAte + 1, p.faixasAtraso.moderadoAte),
      ALTO: faixa(p.faixasAtraso.moderadoAte + 1, p.faixasAtraso.altoAte),
      CRITICO: faixa(p.faixasAtraso.altoAte + 1, null),
    },
    limites: p.faixasAtraso,
    motivos: motivos,
    regra,
  };
}

// ---------------------------------------------------------------------------
// Calendario (secao 20)
// ---------------------------------------------------------------------------

export async function calendario(filtro: z.output<typeof calendarioSchema>) {
  const hoje = hojeIso();
  const inicio = filtro.data_inicio ?? hoje;
  const fim = filtro.data_fim
    ?? new Date(Date.parse(`${inicio}T00:00:00Z`) + filtro.dias * 86400000)
      .toISOString().slice(0, 10);

  const valores: unknown[] = [inicio, fim];
  const cond: string[] = ['d.data BETWEEN $1 AND $2'];
  const filtrar = (sql: string, valor: unknown) => {
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };
  if (filtro.fornecedor_id) filtrar('d.fornecedor_id = $?', filtro.fornecedor_id);
  if (filtro.comprador_id) filtrar('d.comprador_id = $?', filtro.comprador_id);
  if (filtro.local_id) filtrar('d.local_id = $?', filtro.local_id);

  // Tres origens de data no calendario: entrega realizada, entrega programada
  // e o pedido em aberto com previsao. Uniao para nao perder nenhuma.
  const sql = `
    WITH d AS (
      SELECT e.data_real AS data, 'ENTREGA' AS origem, e.id AS referencia_id,
             e.numero AS referencia, oc.id AS ordem_compra_id, oc.numero AS pedido,
             oc.fornecedor_id, f.razao_social AS fornecedor, oc.comprador_id,
             e.local_id, e.status::text AS status, e.horario_previsto,
             e.transportadora, e.quantidade_entregue AS quantidade
        FROM entregas e
        JOIN ordens_compra oc ON oc.id = e.ordem_compra_id
        JOIN fornecedores f ON f.id = oc.fornecedor_id
       WHERE e.data_real IS NOT NULL
      UNION ALL
      SELECT pr.data_prevista, 'PROGRAMACAO', pr.id, NULL, oc.id, oc.numero,
             oc.fornecedor_id, f.razao_social, oc.comprador_id, pr.local_id,
             pr.status, pr.horario_previsto, pr.transportadora,
             (SELECT sum(pi.quantidade) FROM entrega_programacao_itens pi
               WHERE pi.programacao_id = pr.id)
        FROM entrega_programacoes pr
        JOIN ordens_compra oc ON oc.id = pr.ordem_compra_id
        JOIN fornecedores f ON f.id = oc.fornecedor_id
       WHERE pr.status <> 'CANCELADA'
      UNION ALL
      SELECT coalesce(oc.eta_atual, oc.data_prometida), 'PREVISAO', oc.id, oc.numero,
             oc.id, oc.numero, oc.fornecedor_id, f.razao_social, oc.comprador_id,
             oc.local_entrega_id, oc.status::text, NULL, NULL,
             (SELECT sum(greatest(oci.quantidade_pedida - oci.quantidade_entregue, 0))
                FROM ordem_compra_itens oci WHERE oci.ordem_compra_id = oc.id)
        FROM ordens_compra oc
        JOIN fornecedores f ON f.id = oc.fornecedor_id
       WHERE oc.status IN ('APROVADA','ENVIADA','CONFIRMADA','EM_PRODUCAO','EM_TRANSITO','RECEBIMENTO_PARCIAL')
         AND coalesce(oc.eta_atual, oc.data_prometida) IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM entrega_programacoes pr2
                          WHERE pr2.ordem_compra_id = oc.id AND pr2.status <> 'CANCELADA')
    )
    SELECT d.*, l.nome AS local FROM d
    LEFT JOIN locais l ON l.id = d.local_id
     WHERE ${cond.join(' AND ')}`;

  const totais = await query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE origem = 'ENTREGA')::int AS entregas,
           count(*) FILTER (WHERE origem = 'PROGRAMACAO')::int AS programadas,
           count(*) FILTER (WHERE origem = 'PREVISAO')::int AS previstas,
           count(*) FILTER (WHERE data < current_date AND origem <> 'ENTREGA')::int AS vencidas
      FROM (${sql}) x`, valores);

  const { rows } = await query(
    `${sql} ORDER BY d.data, d.pedido LIMIT $${valores.length + 1}`, [...valores, filtro.limite]);

  const porDia = new Map<string, any[]>();
  for (const r of rows) {
    const dia = dataIso(r.data)!;
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia)!.push({ ...r, data: dia });
  }

  const total = Number(totais.rows[0]?.total ?? 0);

  return {
    periodo: { inicio, fim },
    totais: totais.rows[0],
    exibidos: rows.length,
    omitidos: Math.max(0, total - rows.length),
    dias: [...porDia.entries()].map(([data, eventos]) => ({ data, eventos })),
  };
}

// ---------------------------------------------------------------------------
// Alertas (secoes 54 e 55)
// ---------------------------------------------------------------------------

export async function alertas(limite = 200) {
  const cfg = await configuracoes();
  const p = parametros(cfg);
  const hoje = hojeIso();
  const percentualAlerta = Number(cfg['entrega.sla_alerta_percentual'] ?? 80);

  const { rows } = await query(`
    SELECT a.*, oc.data_prevista_entrega, f.lead_time_padrao_dias,
           u.nome AS comprador, c.nome AS categoria,
           t.data_prevista AS transporte_data_prevista, t.data_coleta AS transporte_data_coleta,
           t.transportadora, t.modal, t.codigo_rastreio,
           coalesce(s.disponivel, 0) AS estoque_disponivel,
           coalesce(s.reservado, 0) AS estoque_reservado,
           coalesce(s.transito, 0) AS estoque_transito,
           d.demanda_diaria, NULL::numeric AS demanda_prevista,
           NULL AS prioridade_planejamento, NULL::numeric AS estoque_seguranca,
           NULL::numeric AS ponto_pedido,
           coalesce(h.entregas, 0) AS fornecedor_entregas,
           h.lead_time_medio AS fornecedor_lead_time_medio,
           coalesce(h.atrasos_recentes, 0) AS fornecedor_atrasos_recentes,
           coalesce(ap.total, 0) AS alteracoes_prazo,
           coalesce(oco.abertas, 0) AS ocorrencias_abertas
      FROM vw_acompanhamento_itens a
      JOIN ordens_compra oc ON oc.id = a.ordem_compra_id
      JOIN fornecedores f ON f.id = a.fornecedor_id
      LEFT JOIN usuarios u ON u.id = a.comprador_id
      LEFT JOIN categorias c ON c.id = a.categoria_id
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE e.data_real IS NOT NULL) AS entregas,
               avg(e.data_real - o2.data_emissao) FILTER (WHERE e.data_real IS NOT NULL) AS lead_time_medio,
               count(*) FILTER (WHERE e.data_real IS NOT NULL AND e.data_prometida IS NOT NULL
                                  AND e.data_real > e.data_prometida
                                  AND e.data_real >= CURRENT_DATE - 180) AS atrasos_recentes
          FROM entregas e JOIN ordens_compra o2 ON o2.id = e.ordem_compra_id
         WHERE o2.fornecedor_id = a.fornecedor_id) h ON true
      LEFT JOIN LATERAL (
        SELECT * FROM transportes_pedido tp WHERE tp.ordem_compra_id = a.ordem_compra_id
         ORDER BY tp.created_at DESC LIMIT 1) t ON true
      LEFT JOIN LATERAL (
        SELECT sum(quantidade_disponivel) AS disponivel, sum(quantidade_reservada) AS reservado,
               sum(quantidade_em_transito) AS transito
          FROM estoques e WHERE e.produto_id = a.produto_id) s ON true
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(quantidade), 0) / 90.0 AS demanda_diaria
          FROM mv_demanda_diaria m
         WHERE m.produto_id = a.produto_id AND m.data_venda >= CURRENT_DATE - 90) d ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS total FROM alteracoes_prazo x
         WHERE x.ordem_compra_id = a.ordem_compra_id) ap ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS abertas FROM ocorrencias_entrega o
         WHERE o.ordem_compra_id = a.ordem_compra_id
           AND o.status IN ('ABERTA','EM_TRATAMENTO','AGUARDANDO_FORNECEDOR')) oco ON true
     WHERE a.status_pedido IN ('APROVADA','ENVIADA','CONFIRMADA','EM_PRODUCAO','EM_TRANSITO','RECEBIMENTO_PARCIAL')
     LIMIT $1`, [limite * 4]);

  const itens = rows.map((l) => avaliarLinha(l, p, hoje));
  const lista: Array<Record<string, unknown>> = [];

  for (const i of itens) {
    const referencia = { pedido_id: i.ordem_compra_id, pedido: i.pedido, produto: i.produto_codigo };

    if (i.situacao === 'ATRASADO') {
      lista.push({
        tipo: 'ENTREGA_ATRASADA',
        severidade: i.impacto === 'CRITICO' ? 'CRITICA' : i.impacto === 'ALTO' ? 'ALTA' : 'MEDIA',
        ...referencia,
        mensagem: `${i.produto_codigo} do pedido ${i.pedido} com ${i.atraso.contraPromessa ?? i.atraso.contraNecessidade} dia(s) de atraso`,
        impacto: i.impacto,
      });
    } else if (i.situacao === 'EM_RISCO') {
      lista.push({
        tipo: 'ENTREGA_EM_RISCO',
        severidade: i.impacto === 'CRITICO' ? 'ALTA' : 'MEDIA',
        ...referencia,
        mensagem: `${i.produto_codigo} do pedido ${i.pedido} em risco: ${i.motivos_risco.map((m) => m.detalhe).join('; ')}`,
        motivos: i.motivos_risco,
      });
    }

    if (i.status_confirmacao === 'NAO_CONFIRMADO' && i.datas.envio) {
      lista.push({
        tipo: 'PEDIDO_SEM_CONFIRMACAO', severidade: 'MEDIA', ...referencia,
        mensagem: `Pedido ${i.pedido} enviado e ainda sem confirmacao do fornecedor`,
      });
    }
    if (i.eta.data === null) {
      lista.push({
        tipo: 'PEDIDO_SEM_PREVISAO', severidade: 'BAIXA', ...referencia,
        mensagem: `Pedido ${i.pedido} sem data prometida e sem previsao de entrega`,
      });
    }
    if (i.saldo.entregue > 0 && !i.saldo.completo) {
      lista.push({
        tipo: 'QUANTIDADE_PARCIAL', severidade: 'MEDIA', ...referencia,
        mensagem: `${i.produto_codigo}: ${i.saldo.percentualAtendido.toFixed(1)}% atendido, `
          + `${i.saldo.pendenteEntrega} pendente`,
      });
    }

    // Alerta critico de ruptura (secao 55): traz a conta inteira junto.
    if (['CRITICO', 'ALTO'].includes(i.risco_ruptura.nivel)) {
      lista.push({
        tipo: 'RISCO_RUPTURA',
        severidade: i.risco_ruptura.nivel === 'CRITICO' ? 'CRITICA' : 'ALTA',
        ...referencia,
        mensagem: `${i.produto_codigo}: cobertura de ${i.risco_ruptura.coberturaDias?.toFixed(1)} dia(s),`
          + ` ruptura provavel em ${i.risco_ruptura.dataProvavelRuptura}`,
        detalhes: {
          produto: i.produto,
          estoque_disponivel: i.estoque.disponivel,
          demanda_diaria: i.demanda.media_diaria,
          cobertura_dias: i.risco_ruptura.coberturaDias,
          data_provavel_ruptura: i.risco_ruptura.dataProvavelRuptura,
          pedido: i.pedido,
          fornecedor: i.fornecedor,
          quantidade_pendente: i.saldo.pendenteEntrega,
          atraso_dias: i.atraso.contraPromessa,
          chega_a_tempo: i.risco_ruptura.chegaATempo,
        },
      });
    }
  }

  // SLA de ocorrencia (secao 31).
  const { rows: ocorrencias } = await query(`
    SELECT o.id, o.numero, o.tipo, o.prioridade, o.data_abertura, o.sla_horas,
           o.ordem_compra_id, oc.numero AS pedido
      FROM ocorrencias_entrega o
      JOIN ordens_compra oc ON oc.id = o.ordem_compra_id
     WHERE o.status IN ('ABERTA','EM_TRATAMENTO','AGUARDANDO_FORNECEDOR')
     ORDER BY o.prazo_resolucao LIMIT $1`, [limite]);

  for (const o of ocorrencias) {
    const sla = avaliarSla({
      abertura: new Date(o.data_abertura).toISOString(),
      slaHoras: o.sla_horas !== null ? Number(o.sla_horas) : null,
      encerramento: null,
      agora: new Date().toISOString(),
      percentualAlerta,
    });
    if (sla.situacao === 'EM_ALERTA' || sla.situacao === 'VENCIDO') {
      lista.push({
        tipo: 'SLA_OCORRENCIA',
        severidade: sla.situacao === 'VENCIDO' ? 'ALTA' : 'MEDIA',
        pedido_id: Number(o.ordem_compra_id),
        pedido: o.pedido,
        ocorrencia_id: Number(o.id),
        mensagem: `Ocorrencia ${o.numero} com SLA ${sla.situacao === 'VENCIDO' ? 'vencido' : 'proximo do vencimento'}`
          + ` (${sla.percentualConsumido?.toFixed(0)}% consumido)`,
        sla,
      });
    }
  }

  // Fornecedor com deterioracao de performance (secao 54).
  const regra = regraOtif(cfg);
  const minimo = Number(cfg['entrega.otif_minimo_entregas'] ?? 5);
  const recente = await performanceFornecedores({ dias: 90 } as any);
  for (const f of recente.fornecedores) {
    if (f.amostra_suficiente && f.otif !== null && f.otif < 70) {
      lista.push({
        tipo: 'FORNECEDOR_PERFORMANCE',
        severidade: f.otif < 50 ? 'ALTA' : 'MEDIA',
        fornecedor_id: f.fornecedor_id,
        mensagem: `${f.fornecedor} com OTIF de ${f.otif.toFixed(1)}% em ${f.entregas_avaliadas} entregas (90 dias)`,
        detalhes: { otd: f.otd, in_full: f.in_full, atraso_medio: f.atraso_medio },
      });
    }
  }

  const ordem: Record<string, number> = { CRITICA: 0, ALTA: 1, MEDIA: 2, BAIXA: 3 };
  lista.sort((a, b) => (ordem[String(a.severidade)] ?? 9) - (ordem[String(b.severidade)] ?? 9));

  return {
    total: lista.length,
    por_severidade: {
      CRITICA: lista.filter((l) => l.severidade === 'CRITICA').length,
      ALTA: lista.filter((l) => l.severidade === 'ALTA').length,
      MEDIA: lista.filter((l) => l.severidade === 'MEDIA').length,
      BAIXA: lista.filter((l) => l.severidade === 'BAIXA').length,
    },
    alertas: lista.slice(0, limite),
    regra_otif: regra,
    minimo_entregas: minimo,
    avaliado_em: hoje,
  };
}

// ---------------------------------------------------------------------------
// Dashboards (secoes 5, 59 e 60)
// ---------------------------------------------------------------------------

export async function dashboard(filtro: z.output<typeof periodoSchema>) {
  const cfg = await configuracoes();
  const p = parametros(cfg);
  const hoje = hojeIso();

  const { rows } = await query(`
    SELECT a.*, oc.data_prevista_entrega, f.lead_time_padrao_dias,
           NULL AS comprador, NULL AS categoria,
           t.data_prevista AS transporte_data_prevista, t.data_coleta AS transporte_data_coleta,
           t.transportadora, t.modal, t.codigo_rastreio,
           coalesce(s.disponivel, 0) AS estoque_disponivel,
           coalesce(s.reservado, 0) AS estoque_reservado,
           coalesce(s.transito, 0) AS estoque_transito,
           d.demanda_diaria, NULL::numeric AS demanda_prevista,
           NULL AS prioridade_planejamento, NULL::numeric AS estoque_seguranca,
           NULL::numeric AS ponto_pedido,
           coalesce(h.entregas, 0) AS fornecedor_entregas,
           h.lead_time_medio AS fornecedor_lead_time_medio,
           coalesce(h.atrasos_recentes, 0) AS fornecedor_atrasos_recentes,
           coalesce(ap.total, 0) AS alteracoes_prazo,
           coalesce(oco.abertas, 0) AS ocorrencias_abertas
      FROM vw_acompanhamento_itens a
      JOIN ordens_compra oc ON oc.id = a.ordem_compra_id
      JOIN fornecedores f ON f.id = a.fornecedor_id
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE e.data_real IS NOT NULL) AS entregas,
               avg(e.data_real - o2.data_emissao) FILTER (WHERE e.data_real IS NOT NULL) AS lead_time_medio,
               count(*) FILTER (WHERE e.data_real IS NOT NULL AND e.data_prometida IS NOT NULL
                                  AND e.data_real > e.data_prometida
                                  AND e.data_real >= CURRENT_DATE - 180) AS atrasos_recentes
          FROM entregas e JOIN ordens_compra o2 ON o2.id = e.ordem_compra_id
         WHERE o2.fornecedor_id = a.fornecedor_id) h ON true
      LEFT JOIN LATERAL (
        SELECT * FROM transportes_pedido tp WHERE tp.ordem_compra_id = a.ordem_compra_id
         ORDER BY tp.created_at DESC LIMIT 1) t ON true
      LEFT JOIN LATERAL (
        SELECT sum(quantidade_disponivel) AS disponivel, sum(quantidade_reservada) AS reservado,
               sum(quantidade_em_transito) AS transito
          FROM estoques e WHERE e.produto_id = a.produto_id) s ON true
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(quantidade), 0) / 90.0 AS demanda_diaria
          FROM mv_demanda_diaria m
         WHERE m.produto_id = a.produto_id AND m.data_venda >= CURRENT_DATE - 90) d ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS total FROM alteracoes_prazo x
         WHERE x.ordem_compra_id = a.ordem_compra_id) ap ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS abertas FROM ocorrencias_entrega o
         WHERE o.ordem_compra_id = a.ordem_compra_id
           AND o.status IN ('ABERTA','EM_TRATAMENTO','AGUARDANDO_FORNECEDOR')) oco ON true
     WHERE a.status_pedido IN ('APROVADA','ENVIADA','CONFIRMADA','EM_PRODUCAO','EM_TRANSITO','RECEBIMENTO_PARCIAL')
       ${filtro.comprador_id ? 'AND a.comprador_id = $1' : ''}`,
    filtro.comprador_id ? [filtro.comprador_id] : []);

  const itens = rows.map((l) => avaliarLinha(l, p, hoje));
  const pedidos = new Set(itens.map((i) => i.ordem_compra_id));

  const contar = (fn: (i: typeof itens[number]) => boolean) =>
    new Set(itens.filter(fn).map((i) => i.ordem_compra_id)).size;

  const [otif, statusPedidos, statusLogisticos, entregasHoje, ocorrenciasAbertas] =
    await Promise.all([
      indicadoresOtif(filtro),
      query(`
        SELECT status, count(*)::int AS quantidade FROM ordens_compra
         WHERE status IN ('APROVADA','ENVIADA','CONFIRMADA','EM_PRODUCAO','EM_TRANSITO','RECEBIMENTO_PARCIAL')
         GROUP BY status ORDER BY 1`),
      query(`
        SELECT coalesce(status_logistico::text, 'SEM_STATUS') AS status, count(*)::int AS quantidade
          FROM ordens_compra
         WHERE status IN ('APROVADA','ENVIADA','CONFIRMADA','EM_PRODUCAO','EM_TRANSITO','RECEBIMENTO_PARCIAL')
         GROUP BY 1 ORDER BY 1`),
      query(`
        SELECT count(*)::int AS total FROM (
          SELECT e.id FROM entregas e WHERE e.data_prevista = current_date AND e.data_real IS NULL
          UNION
          SELECT pr.id FROM entrega_programacoes pr
           WHERE pr.data_prevista = current_date AND pr.status <> 'CANCELADA') x`),
      query(`
        SELECT count(*)::int AS total FROM ocorrencias_entrega
         WHERE status IN ('ABERTA','EM_TRATAMENTO','AGUARDANDO_FORNECEDOR')`),
    ]);

  const fornecedoresComAtraso = new Set(
    itens.filter((i) => i.situacao === 'ATRASADO').map((i) => i.fornecedor_id)).size;

  return {
    avaliado_em: hoje,
    indicadores: {
      pedidos_em_aberto: pedidos.size,
      pedidos_aguardando_confirmacao: contar((i) => i.status_confirmacao === 'NAO_CONFIRMADO'),
      pedidos_confirmados: contar((i) => i.status_confirmacao === 'CONFIRMADO'
        || i.status_confirmacao === 'CONFIRMADO_PARCIALMENTE'),
      pedidos_em_producao: contar((i) => i.status_logistico === 'EM_PRODUCAO'),
      pedidos_em_transito: contar((i) => ['EXPEDIDO', 'EM_TRANSITO', 'CHEGOU_DESTINO']
        .includes(i.status_logistico ?? '')),
      entregas_hoje: Number(entregasHoje.rows[0]?.total ?? 0),
      entregas_atrasadas: contar((i) => i.situacao === 'ATRASADO'),
      entregas_em_risco: contar((i) => i.situacao === 'EM_RISCO'),
      entregas_parciais: contar((i) => i.saldo.entregue > 0 && !i.saldo.completo),
      pedidos_sem_previsao: contar((i) => i.eta.data === null),
      quantidade_pendente: itens.reduce((a, i) => a + i.saldo.pendenteEntrega, 0),
      valor_pendente: itens.reduce((a, i) => a + i.valor_pendente, 0),
      fornecedores_com_atraso: fornecedoresComAtraso,
      ocorrencias_abertas: Number(ocorrenciasAbertas.rows[0]?.total ?? 0),
      otif: otif.otif,
      otd: otif.otd,
      in_full: otif.inFull,
      lead_time_medio: otif.lead_time.media,
      atraso_medio: otif.atrasoMedio,
    },
    semaforo: {
      VERDE: itens.filter((i) => i.semaforo === 'VERDE').length,
      AMARELO: itens.filter((i) => i.semaforo === 'AMARELO').length,
      LARANJA: itens.filter((i) => i.semaforo === 'LARANJA').length,
      VERMELHO: itens.filter((i) => i.semaforo === 'VERMELHO').length,
      CINZA: itens.filter((i) => i.semaforo === 'CINZA').length,
    },
    // A matriz cobre TODAS as situacoes e inclui a coluna SEM_DADOS: uma matriz
    // cuja soma nao fecha com o total da carteira esconde justamente os itens
    // que ninguem consegue avaliar.
    matriz: ['NO_PRAZO', 'EM_RISCO', 'ATRASADO', 'ENTREGUE', 'SEM_DADOS'].map((situacao) => {
      const daSituacao = itens.filter((i) => i.situacao === situacao);
      const porImpacto = (impacto: string) =>
        daSituacao.filter((i) => i.impacto === impacto).length;
      return {
        situacao,
        BAIXO: porImpacto('BAIXO'),
        MEDIO: porImpacto('MEDIO'),
        ALTO: porImpacto('ALTO'),
        CRITICO: porImpacto('CRITICO'),
        SEM_DADOS: porImpacto('SEM_DADOS'),
        total: daSituacao.length,
      };
    }),
    total_itens: itens.length,
    pedidos_por_status: statusPedidos.rows,
    pedidos_por_status_logistico: statusLogisticos.rows,
    otif_detalhado: otif,
    produtos_em_risco: itens
      .filter((i) => ['CRITICO', 'ALTO'].includes(i.risco_ruptura.nivel))
      .sort((a, b) => (a.risco_ruptura.coberturaDias ?? 999) - (b.risco_ruptura.coberturaDias ?? 999))
      .slice(0, 20)
      .map((i) => ({
        produto_id: i.produto_id, codigo: i.produto_codigo, produto: i.produto,
        pedido: i.pedido, fornecedor: i.fornecedor,
        cobertura_dias: i.risco_ruptura.coberturaDias,
        data_provavel_ruptura: i.risco_ruptura.dataProvavelRuptura,
        quantidade_pendente: i.saldo.pendenteEntrega,
        atraso_dias: i.atraso.contraPromessa,
        risco: i.risco_ruptura.nivel, impacto: i.impacto,
      })),
    parametros: {
      faixas_atraso: p.faixasAtraso,
      faixas_ruptura: p.faixasRuptura,
      dias_antecedencia_risco: p.diasAntecedencia,
      dias_sem_confirmacao: p.diasSemConfirmacao,
    },
  };
}

/** Parametros do modulo, para a tela de configuracao (secao 4, item 18). */
export async function listarParametros() {
  const { rows } = await query(`
    SELECT chave, valor, tipo, descricao FROM configuracoes
     WHERE grupo = 'entrega' ORDER BY chave`);
  return rows;
}

export async function atualizarParametros(
  entrada: Array<{ chave: string; valor: string }>, usuarioId: number | null,
) {
  const atualizados: string[] = [];
  for (const p of entrada) {
    const { rows } = await query(`
      UPDATE configuracoes SET valor = $2, updated_at = now(), updated_by = $3
       WHERE chave = $1 AND grupo = 'entrega' RETURNING chave`,
      [p.chave, p.valor, usuarioId]);
    if (rows.length) atualizados.push(p.chave);
  }
  return { atualizados, ignorados: entrada.filter((p) => !atualizados.includes(p.chave)) };
}
