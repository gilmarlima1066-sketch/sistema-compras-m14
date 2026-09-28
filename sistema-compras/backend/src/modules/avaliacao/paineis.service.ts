/**
 * Paineis, riscos e alertas de fornecedor.
 *
 * O que este arquivo NAO faz: decidir. Concentracao de fornecimento, fornecedor
 * unico e queda de OTIF saem daqui como informacao de risco, com os numeros
 * que a sustentam. A secao 49 e explicita: informar, nunca bloquear a compra.
 */
import { query } from '../../config/database.js';
import { naoEncontrado } from '../../core/errors.js';
import { hojeLocal, paraDataCalendario } from '../../core/datas.js';
import type { z } from 'zod';
import type { concentracaoSchema, parametrosSchema, periodoSchema } from './avaliacao.schemas.js';
import { analisarTendencia, calcularConcentracao, percentual } from './calculos.js';
import { configuracoes, numeroConfig, resolverPeriodo } from './avaliacao.service.js';

const num = (v: unknown) => Number(v ?? 0);
const ouNulo = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const dataIso = (v: unknown) => paraDataCalendario(v);

// ---------------------------------------------------------------------------
// Dashboard (secoes 5 e 69)
// ---------------------------------------------------------------------------

export async function dashboard(filtro: z.output<typeof periodoSchema>) {
  const cfg = await configuracoes();
  const periodo = resolverPeriodo(filtro);

  const [cadastro, avaliacoes, medias, qualidade, planos, riscos] = await Promise.all([
    query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE ativo)::int AS ativos,
             count(*) FILTER (WHERE status_homologacao = 'HOMOLOGADO')::int AS homologados,
             count(*) FILTER (WHERE status_homologacao = 'HOMOLOGADO_COM_RESTRICAO')::int
               AS homologados_com_restricao,
             count(*) FILTER (WHERE status_homologacao = 'EM_HOMOLOGACAO')::int
               AS em_homologacao,
             count(*) FILTER (WHERE status_homologacao = 'EM_MONITORAMENTO')::int
               AS em_monitoramento,
             count(*) FILTER (WHERE status_homologacao = 'BLOQUEADO')::int AS bloqueados,
             count(*) FILTER (WHERE ultima_avaliacao_em IS NULL AND ativo)::int
               AS nunca_avaliados
        FROM fornecedores WHERE deleted_at IS NULL`),
    query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'VALIDADA')::int AS validadas,
             count(*) FILTER (WHERE status = 'CALCULADA')::int AS aguardando_validacao,
             count(*) FILTER (WHERE completude = 'COMPLETA')::int AS completas,
             count(*) FILTER (WHERE completude IN ('DADOS_INSUFICIENTES','SEM_HISTORICO'))::int
               AS sem_dados,
             avg(score_final) FILTER (WHERE score_final IS NOT NULL) AS score_medio
        FROM avaliacoes_fornecedores
       WHERE periodo_fim BETWEEN $1::date AND $2::date AND status <> 'CANCELADA'`,
      [periodo.inicio, periodo.fim]),
    query(`
      SELECT avg(otif) FILTER (WHERE otif IS NOT NULL)       AS otif,
             avg(otd) FILTER (WHERE otd IS NOT NULL)         AS otd,
             avg(in_full) FILTER (WHERE in_full IS NOT NULL) AS in_full,
             avg(qualidade) FILTER (WHERE qualidade IS NOT NULL) AS qualidade,
             avg(lead_time_real) FILTER (WHERE lead_time_real IS NOT NULL) AS desvio_lead_time,
             avg(variacao_preco) FILTER (WHERE variacao_preco IS NOT NULL) AS variacao_preco,
             count(*)::int AS amostras
        FROM historico_score_fornecedor
       WHERE periodo_fim BETWEEN $1::date AND $2::date`, [periodo.inicio, periodo.fim]),
    query(`
      SELECT count(DISTINCT r.id)::int AS recebimentos,
             count(DISTINCT r.id) FILTER (
               WHERE EXISTS (SELECT 1 FROM nao_conformidades n WHERE n.recebimento_id = r.id)
             )::int AS com_nc,
             (SELECT count(*)::int FROM nao_conformidades n
               WHERE n.severidade = 'CRITICA'
                 AND n.created_at >= $1::date
                 AND n.created_at < ($2::date + interval '1 day')) AS ncs_criticas,
             (SELECT count(*)::int FROM devolucoes d
               WHERE d.status <> 'CANCELADA'
                 AND d.created_at >= $1::date
                 AND d.created_at < ($2::date + interval '1 day')) AS devolucoes
        FROM recebimentos r
       WHERE r.data_recebimento BETWEEN $1::date AND $2::date AND r.status <> 'CANCELADO'`,
      [periodo.inicio, periodo.fim]),
    query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status NOT IN ('ENCERRADO','CANCELADO'))::int AS abertos,
             count(*) FILTER (WHERE prazo < CURRENT_DATE
                                AND status NOT IN ('ENCERRADO','CANCELADO'))::int AS atrasados,
             count(*) FILTER (WHERE severidade = 'CRITICA'
                                AND status NOT IN ('ENCERRADO','CANCELADO'))::int AS criticos
        FROM planos_acao_fornecedor`),
    query(`
      SELECT count(*)::int AS produtos_ativos,
             count(*) FILTER (WHERE fornecedores = 1)::int AS monoprovedor
        FROM (
          SELECT pf.produto_id, count(DISTINCT pf.fornecedor_id)::int AS fornecedores
            FROM produto_fornecedor pf
            JOIN fornecedores f ON f.id = pf.fornecedor_id
           WHERE pf.ativo AND f.ativo AND f.deleted_at IS NULL
           GROUP BY pf.produto_id
        ) x`),
  ]);

  const c = cadastro.rows[0];
  const a = avaliacoes.rows[0];
  const m = medias.rows[0];
  const q = qualidade.rows[0];

  return {
    avaliado_em: hojeLocal(),
    periodo,
    fornecedores: {
      total: num(c.total),
      ativos: num(c.ativos),
      homologados: num(c.homologados),
      homologados_com_restricao: num(c.homologados_com_restricao),
      em_homologacao: num(c.em_homologacao),
      em_monitoramento: num(c.em_monitoramento),
      bloqueados: num(c.bloqueados),
      nunca_avaliados: num(c.nunca_avaliados),
    },
    avaliacoes: {
      total: num(a.total),
      validadas: num(a.validadas),
      aguardando_validacao: num(a.aguardando_validacao),
      completas: num(a.completas),
      sem_dados: num(a.sem_dados),
      score_medio: ouNulo(a.score_medio),
    },
    logistica: {
      otif_medio: ouNulo(m.otif),
      otd_medio: ouNulo(m.otd),
      in_full_medio: ouNulo(m.in_full),
      desvio_lead_time_medio: ouNulo(m.desvio_lead_time),
      amostras: num(m.amostras),
    },
    qualidade: {
      indice_medio: ouNulo(m.qualidade),
      recebimentos: num(q.recebimentos),
      taxa_nao_conformidade: percentual(num(q.com_nc), num(q.recebimentos)),
      ncs_criticas: num(q.ncs_criticas),
      devolucoes: num(q.devolucoes),
      taxa_devolucao: percentual(num(q.devolucoes), num(q.recebimentos)),
    },
    comercial: {
      variacao_preco_media: ouNulo(m.variacao_preco),
    },
    planos_acao: planos.rows[0],
    riscos: {
      produtos_com_fornecedor: num(riscos.rows[0]?.produtos_ativos),
      produtos_monoprovedor: num(riscos.rows[0]?.monoprovedor),
      percentual_monoprovedor: percentual(
        num(riscos.rows[0]?.monoprovedor), num(riscos.rows[0]?.produtos_ativos)),
      limite_concentracao: numeroConfig(cfg, 'avaliacao.concentracao_alerta_percentual', 70),
    },
    base_de_dados: 'cadastro de fornecedores, avaliacoes e historico de score do periodo',
  };
}

// ---------------------------------------------------------------------------
// Ranking (secao 47)
// ---------------------------------------------------------------------------

/**
 * Fornecedores ordenados pelo ultimo score.
 *
 * Quem tem completude insuficiente vai para o fim, como no modulo 08: um
 * fornecedor com duas entregas e score 100 nao lidera sobre outro com
 * quarenta entregas e score 92.
 */
export async function ranking(filtro: z.output<typeof periodoSchema> & { limite?: number }) {
  const periodo = resolverPeriodo(filtro);

  const { rows } = await query(`
    WITH ultima AS (
      SELECT DISTINCT ON (a.fornecedor_id)
             a.fornecedor_id, a.id, a.numero, a.score_final, a.completude,
             a.confiabilidade, a.eventos_avaliados, a.periodo_inicio, a.periodo_fim,
             a.metodologia_versao, a.valor_comprado
        FROM avaliacoes_fornecedores a
       WHERE a.status <> 'CANCELADA'
         AND a.periodo_fim BETWEEN $1::date AND $2::date
       ORDER BY a.fornecedor_id, a.periodo_fim DESC, a.id DESC
    )
    SELECT f.id AS fornecedor_id, f.razao_social AS fornecedor, f.cnpj,
           f.status_homologacao, u.*,
           (u.completude IN ('COMPLETA','DADOS_PARCIAIS')) AS amostra_suficiente
      FROM ultima u
      JOIN fornecedores f ON f.id = u.fornecedor_id
     WHERE f.deleted_at IS NULL
     ORDER BY (u.completude IN ('COMPLETA','DADOS_PARCIAIS')) DESC,
              u.score_final DESC NULLS LAST
     LIMIT $3`, [periodo.inicio, periodo.fim, filtro.limite ?? 50]);

  return {
    periodo,
    regra: 'ordenado pelo score da ultima avaliacao do periodo;'
      + ' avaliacoes com dados insuficientes ficam no fim',
    fornecedores: rows.map((r: Record<string, any>) => ({
      ...r,
      periodo_inicio: dataIso(r.periodo_inicio),
      periodo_fim: dataIso(r.periodo_fim),
    })),
  };
}

// ---------------------------------------------------------------------------
// Concentracao e fornecedor unico (secoes 48, 49 e 50)
// ---------------------------------------------------------------------------

export async function concentracao(filtro: z.output<typeof concentracaoSchema>) {
  const cfg = await configuracoes();
  const limite = numeroConfig(cfg, 'avaliacao.concentracao_alerta_percentual', 70);
  const fim = hojeLocal();
  const inicio = dataIso(
    new Date(Date.parse(`${fim}T00:00:00Z`) - filtro.dias * 86400000))!;

  const valores: unknown[] = [inicio, fim];
  const cond: string[] = [];
  if (filtro.produto_id) {
    valores.push(filtro.produto_id);
    cond.push(`oci.produto_id = $${valores.length}`);
  }
  if (filtro.categoria_id) {
    valores.push(filtro.categoria_id);
    cond.push(`p.categoria_id = $${valores.length}`);
  }
  const extra = cond.length ? ` AND ${cond.join(' AND ')}` : '';
  const base = filtro.base === 'QUANTIDADE' ? 'oci.quantidade_pedida' : 'oci.valor_total';

  // Concentracao geral por fornecedor no periodo.
  const { rows: geral } = await query(`
    SELECT oc.fornecedor_id, f.razao_social AS fornecedor,
           coalesce(sum(${base}), 0)::numeric AS valor
      FROM ordem_compra_itens oci
      JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
      JOIN fornecedores f ON f.id = oc.fornecedor_id
      JOIN produtos p ON p.id = oci.produto_id
     WHERE oc.data_emissao BETWEEN $1::date AND $2::date
       AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA') ${extra}
     GROUP BY oc.fornecedor_id, f.razao_social`, valores);

  const consolidada = calcularConcentracao(
    geral.map((g: Record<string, any>) => ({
      fornecedorId: Number(g.fornecedor_id),
      fornecedor: g.fornecedor,
      valor: num(g.valor),
    })), limite);

  // Concentracao por produto: e onde o risco costuma se esconder. Um
  // fornecedor pode ser 20% das compras totais e 100% de um item critico.
  const { rows: porProduto } = await query(`
    WITH compras AS (
      SELECT oci.produto_id, oc.fornecedor_id,
             sum(${base})::numeric AS valor
        FROM ordem_compra_itens oci
        JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
        JOIN produtos p ON p.id = oci.produto_id
       WHERE oc.data_emissao BETWEEN $1::date AND $2::date
         AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA') ${extra}
       GROUP BY oci.produto_id, oc.fornecedor_id
    ), totais AS (
      SELECT produto_id, sum(valor) AS total,
             count(DISTINCT fornecedor_id)::int AS fornecedores
        FROM compras GROUP BY produto_id
    )
    SELECT p.id AS produto_id, p.codigo, p.descricao AS produto,
           t.fornecedores, t.total,
           f.id AS principal_id, f.razao_social AS principal,
           round((c.valor / nullif(t.total, 0)) * 100, 2) AS participacao_principal,
           (SELECT count(*)::int FROM produto_fornecedor pf
             JOIN fornecedores ff ON ff.id = pf.fornecedor_id
            WHERE pf.produto_id = p.id AND pf.ativo AND ff.ativo
              AND ff.deleted_at IS NULL) AS fornecedores_cadastrados
      FROM totais t
      JOIN produtos p ON p.id = t.produto_id
      JOIN LATERAL (
        SELECT * FROM compras c2 WHERE c2.produto_id = t.produto_id
         ORDER BY c2.valor DESC LIMIT 1
      ) c ON TRUE
      JOIN fornecedores f ON f.id = c.fornecedor_id
     WHERE t.total > 0
     ORDER BY (c.valor / nullif(t.total, 0)) DESC, t.total DESC
     LIMIT 100`, valores);

  const criticos = porProduto.filter(
    (p: Record<string, any>) => num(p.participacao_principal) >= limite);

  return {
    periodo: { inicio, fim, dias: filtro.dias },
    base: filtro.base,
    limite_alerta: limite,
    consolidada,
    por_produto: porProduto.map((p: Record<string, any>) => ({
      ...p,
      monoprovedor: num(p.fornecedores) === 1,
      alternativas_cadastradas: Math.max(0, num(p.fornecedores_cadastrados) - 1),
    })),
    produtos_concentrados: criticos.length,
    observacao: 'Informacao de risco de concentracao. Nao bloqueia compra (secao 49)',
  };
}

/** Produtos com um unico fornecedor ativo cadastrado (secao 49). */
export async function fornecedorUnico(limite = 200) {
  const { rows } = await query(`
    SELECT p.id AS produto_id, p.codigo, p.descricao AS produto,
           p.classificacao_abc, c.nome AS categoria,
           f.id AS fornecedor_id, f.razao_social AS fornecedor,
           f.status_homologacao, f.score_atual, f.lead_time_padrao_dias,
           pf.preco_atual, pf.moq, pf.multiplo_compra
      FROM produto_fornecedor pf
      JOIN produtos p ON p.id = pf.produto_id
      JOIN fornecedores f ON f.id = pf.fornecedor_id
      LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE pf.ativo AND f.ativo AND f.deleted_at IS NULL
       AND p.ativo AND p.deleted_at IS NULL
       AND (SELECT count(*) FROM produto_fornecedor x
             JOIN fornecedores xf ON xf.id = x.fornecedor_id
            WHERE x.produto_id = p.id AND x.ativo AND xf.ativo
              AND xf.deleted_at IS NULL) = 1
     ORDER BY p.classificacao_abc NULLS LAST, p.descricao
     LIMIT $1`, [limite]);

  return {
    total: rows.length,
    alerta: 'FORNECIMENTO MONOPROVEDOR',
    observacao: 'Risco de concentracao informado. A compra continua liberada (secao 49)',
    produtos: rows,
  };
}

/** Alternativas de fornecimento de um produto (secao 50). */
export async function alternativas(produtoId: number) {
  const { rows: produto } = await query(
    'SELECT id, codigo, descricao FROM produtos WHERE id = $1', [produtoId]);
  if (!produto.length) throw naoEncontrado('Produto');

  const { rows } = await query(`
    SELECT f.id AS fornecedor_id, f.razao_social AS fornecedor, f.cnpj,
           f.status_homologacao, f.score_atual, f.ultima_avaliacao_em,
           pf.fornecedor_principal, pf.preco_atual, pf.preco_anterior, pf.moeda,
           pf.moq, pf.multiplo_compra, pf.lead_time_dias, pf.prazo_pagamento_dias,
           pf.data_ultima_compra,
           (SELECT h.otif FROM historico_score_fornecedor h
             WHERE h.fornecedor_id = f.id ORDER BY h.periodo_fim DESC LIMIT 1) AS otif,
           (SELECT h.qualidade FROM historico_score_fornecedor h
             WHERE h.fornecedor_id = f.id ORDER BY h.periodo_fim DESC LIMIT 1) AS qualidade
      FROM produto_fornecedor pf
      JOIN fornecedores f ON f.id = pf.fornecedor_id
     WHERE pf.produto_id = $1 AND pf.ativo AND f.deleted_at IS NULL
     ORDER BY pf.fornecedor_principal DESC, pf.preco_atual NULLS LAST`, [produtoId]);

  return {
    produto: produto[0],
    total: rows.length,
    monoprovedor: rows.filter((r: Record<string, any>) => r.status_homologacao !== 'BLOQUEADO')
      .length <= 1,
    fornecedores: rows.map((r: Record<string, any>) => ({
      ...r,
      data_ultima_compra: dataIso(r.data_ultima_compra),
      ultima_avaliacao_em: dataIso(r.ultima_avaliacao_em),
    })),
    observacao: 'Menor preco nao e automaticamente a melhor decisao (secao 22)',
  };
}

// ---------------------------------------------------------------------------
// Alertas e tendencia (secoes 42, 43 e 44)
// ---------------------------------------------------------------------------

export async function alertas(limite = 200) {
  const cfg = await configuracoes();
  const otifMinimo = numeroConfig(cfg, 'avaliacao.alerta_otif_minimo', 85);
  const ncMaximo = numeroConfig(cfg, 'avaliacao.alerta_nc_maximo', 10);
  const variacaoPreco = numeroConfig(cfg, 'avaliacao.alerta_variacao_preco', 10);
  const periodosTendencia = numeroConfig(cfg, 'avaliacao.tendencia_periodos', 3);
  const variacaoMinima = numeroConfig(cfg, 'avaliacao.tendencia_variacao_percentual', 5);

  const lista: Array<Record<string, unknown>> = [];

  const [ultimos, planos, vencidas, semDados] = await Promise.all([
    query(`
      SELECT h.fornecedor_id, f.razao_social AS fornecedor, h.otif, h.qualidade,
             h.variacao_preco, h.periodo_fim, h.score,
             (SELECT count(*)::int FROM nao_conformidades n
               WHERE n.fornecedor_id = h.fornecedor_id
                 AND n.severidade = 'CRITICA'
                 AND n.created_at >= h.periodo_inicio) AS ncs_criticas
        FROM historico_score_fornecedor h
        JOIN fornecedores f ON f.id = h.fornecedor_id
       WHERE f.deleted_at IS NULL AND f.ativo
         AND h.id IN (SELECT max(x.id) FROM historico_score_fornecedor x
                       GROUP BY x.fornecedor_id)`),
    query(`
      SELECT p.id, p.numero, p.fornecedor_id, f.razao_social AS fornecedor,
             p.problema, p.prazo, p.severidade
        FROM planos_acao_fornecedor p
        JOIN fornecedores f ON f.id = p.fornecedor_id
       WHERE p.prazo < CURRENT_DATE AND p.status NOT IN ('ENCERRADO','CANCELADO')
       LIMIT $1`, [limite]),
    query(`
      SELECT f.id AS fornecedor_id, f.razao_social AS fornecedor,
             f.ultima_avaliacao_em, f.proxima_avaliacao_em
        FROM fornecedores f
       WHERE f.ativo AND f.deleted_at IS NULL
         AND f.proxima_avaliacao_em IS NOT NULL
         AND f.proxima_avaliacao_em < CURRENT_DATE
       LIMIT $1`, [limite]),
    query(`
      SELECT a.fornecedor_id, f.razao_social AS fornecedor, a.numero, a.completude
        FROM avaliacoes_fornecedores a
        JOIN fornecedores f ON f.id = a.fornecedor_id
       WHERE a.completude IN ('DADOS_INSUFICIENTES','SEM_HISTORICO')
         AND a.status <> 'CANCELADA'
         AND a.id IN (SELECT max(x.id) FROM avaliacoes_fornecedores x
                       GROUP BY x.fornecedor_id)
       LIMIT $1`, [limite]),
  ]);

  for (const u of ultimos.rows) {
    if (u.otif !== null && num(u.otif) < otifMinimo) {
      lista.push({
        tipo: 'FORNECEDOR_BAIXO_DESEMPENHO', severidade: 'ALTA',
        fornecedor_id: Number(u.fornecedor_id), fornecedor: u.fornecedor,
        mensagem: `${u.fornecedor}: OTIF de ${num(u.otif).toFixed(1)}%,`
          + ` abaixo do minimo de ${otifMinimo}%`,
        indicador: 'OTIF', valor: num(u.otif), limite: otifMinimo,
      });
    }
    if (num(u.ncs_criticas) > 0) {
      lista.push({
        tipo: 'NC_CRITICA', severidade: 'CRITICA',
        fornecedor_id: Number(u.fornecedor_id), fornecedor: u.fornecedor,
        mensagem: `${u.fornecedor}: ${u.ncs_criticas} nao conformidade(s) critica(s)`
          + ' no periodo avaliado',
        indicador: 'NC_CRITICA', valor: num(u.ncs_criticas),
      });
    }
    if (u.variacao_preco !== null && num(u.variacao_preco) > variacaoPreco) {
      lista.push({
        tipo: 'PRECO_AUMENTOU', severidade: 'MEDIA',
        fornecedor_id: Number(u.fornecedor_id), fornecedor: u.fornecedor,
        mensagem: `${u.fornecedor}: preco subiu ${num(u.variacao_preco).toFixed(1)}%`
          + ` no periodo, acima do limite de ${variacaoPreco}%`,
        indicador: 'VARIACAO_PRECO', valor: num(u.variacao_preco), limite: variacaoPreco,
      });
    }
  }

  // Tendencia: compara as ultimas N medicoes de OTIF de cada fornecedor.
  // A secao 43 pede o alerta SEM concluir a causa - por isso a mensagem so
  // relata o movimento e mostra a serie.
  const { rows: series } = await query(`
    SELECT fornecedor_id, array_agg(otif ORDER BY periodo_fim) AS serie
      FROM (
        SELECT h.fornecedor_id, h.otif, h.periodo_fim,
               row_number() OVER (PARTITION BY h.fornecedor_id
                                  ORDER BY h.periodo_fim DESC) AS posicao
          FROM historico_score_fornecedor h WHERE h.otif IS NOT NULL
      ) x
     WHERE posicao <= $1
     GROUP BY fornecedor_id
    HAVING count(*) >= 2`, [periodosTendencia]);

  const nomes = new Map(ultimos.rows.map(
    (u: Record<string, any>) => [Number(u.fornecedor_id), u.fornecedor]));

  for (const s of series) {
    const analise = analisarTendencia(
      (s.serie as Array<string | null>).map((v) => (v === null ? null : Number(v))),
      variacaoMinima, 'MAIOR_MELHOR');
    if (analise.tendencia === 'PIORA') {
      lista.push({
        tipo: 'TENDENCIA_NEGATIVA', severidade: 'ALTA',
        fornecedor_id: Number(s.fornecedor_id),
        fornecedor: nomes.get(Number(s.fornecedor_id)) ?? null,
        mensagem: `OTIF em queda: ${analise.serie.map((v) => `${v.toFixed(0)}%`).join(' -> ')}`,
        indicador: 'OTIF', valor: analise.variacao, serie: analise.serie,
      });
    }
    if (analise.tendencia === 'MELHORIA') {
      lista.push({
        tipo: 'MELHORIA_PERFORMANCE', severidade: 'INFO',
        fornecedor_id: Number(s.fornecedor_id),
        fornecedor: nomes.get(Number(s.fornecedor_id)) ?? null,
        mensagem: `Melhoria de performance no OTIF:`
          + ` ${analise.serie.map((v) => `${v.toFixed(0)}%`).join(' -> ')}`,
        indicador: 'OTIF', valor: analise.variacao, serie: analise.serie,
      });
    }
  }

  for (const p of planos.rows) {
    lista.push({
      tipo: 'PLANO_ACAO_ATRASADO',
      severidade: p.severidade === 'CRITICA' ? 'CRITICA' : 'ALTA',
      fornecedor_id: Number(p.fornecedor_id), fornecedor: p.fornecedor,
      mensagem: `Plano ${p.numero} vencido em ${dataIso(p.prazo)}: ${p.problema}`,
      plano_id: Number(p.id),
    });
  }

  for (const v of vencidas.rows) {
    lista.push({
      tipo: 'AVALIACAO_VENCIDA', severidade: 'MEDIA',
      fornecedor_id: Number(v.fornecedor_id), fornecedor: v.fornecedor,
      mensagem: `${v.fornecedor}: avaliacao vencida desde`
        + ` ${dataIso(v.proxima_avaliacao_em)}`,
    });
  }

  for (const s of semDados.rows) {
    lista.push({
      tipo: 'DADOS_INSUFICIENTES', severidade: 'BAIXA',
      fornecedor_id: Number(s.fornecedor_id), fornecedor: s.fornecedor,
      mensagem: `${s.fornecedor}: ultima avaliacao (${s.numero}) ficou em ${s.completude}`,
    });
  }

  const ordem: Record<string, number> = { CRITICA: 1, ALTA: 2, MEDIA: 3, BAIXA: 4, INFO: 5 };
  lista.sort((a, b) =>
    (ordem[String(a.severidade)] ?? 9) - (ordem[String(b.severidade)] ?? 9));

  return {
    total: lista.length,
    por_severidade: {
      CRITICA: lista.filter((l) => l.severidade === 'CRITICA').length,
      ALTA: lista.filter((l) => l.severidade === 'ALTA').length,
      MEDIA: lista.filter((l) => l.severidade === 'MEDIA').length,
      BAIXA: lista.filter((l) => l.severidade === 'BAIXA').length,
      INFO: lista.filter((l) => l.severidade === 'INFO').length,
    },
    limites: {
      otif_minimo: otifMinimo,
      nc_maximo: ncMaximo,
      variacao_preco: variacaoPreco,
      tendencia_variacao: variacaoMinima,
    },
    alertas: lista.slice(0, limite),
    avaliado_em: hojeLocal(),
  };
}

// ---------------------------------------------------------------------------
// Perfil do fornecedor (secao 6)
// ---------------------------------------------------------------------------

export async function perfil(fornecedorId: number, filtro: z.output<typeof periodoSchema>) {
  const periodo = resolverPeriodo(filtro);

  const { rows: cadastro } = await query(`
    SELECT f.*, u.nome AS homologado_por_nome
      FROM fornecedores f
      LEFT JOIN usuarios u ON u.id = f.homologado_por
     WHERE f.id = $1 AND f.deleted_at IS NULL`, [fornecedorId]);
  if (!cadastro.length) throw naoEncontrado('Fornecedor');

  const [produtos, pedidos, avaliacoes, planos, situacao, ncs] = await Promise.all([
    query(`
      SELECT pf.*, p.codigo, p.descricao AS produto, p.classificacao_abc,
             c.nome AS categoria
        FROM produto_fornecedor pf
        JOIN produtos p ON p.id = pf.produto_id
        LEFT JOIN categorias c ON c.id = p.categoria_id
       WHERE pf.fornecedor_id = $1 AND pf.ativo AND p.deleted_at IS NULL
       ORDER BY pf.fornecedor_principal DESC, p.descricao
       LIMIT 200`, [fornecedorId]),
    query(`
      SELECT count(*)::int AS pedidos,
             coalesce(sum(valor_total), 0) AS valor,
             min(data_emissao) AS primeira_compra,
             max(data_emissao) AS ultima_compra
        FROM ordens_compra
       WHERE fornecedor_id = $1 AND status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')`,
      [fornecedorId]),
    query(`
      SELECT id, numero, periodo_inicio, periodo_fim, rotulo_periodo, score_final,
             status, completude, confiabilidade, metodologia_versao, calculado_em
        FROM avaliacoes_fornecedores
       WHERE fornecedor_id = $1 AND status <> 'CANCELADA'
       ORDER BY periodo_fim DESC LIMIT 12`, [fornecedorId]),
    query(`
      SELECT id, numero, problema, status, severidade, prazo, grupo
        FROM planos_acao_fornecedor
       WHERE fornecedor_id = $1
       ORDER BY (status NOT IN ('ENCERRADO','CANCELADO')) DESC, created_at DESC
       LIMIT 20`, [fornecedorId]),
    query(`
      SELECT s.*, u.nome AS responsavel
        FROM situacoes_fornecedor s
        LEFT JOIN usuarios u ON u.id = s.responsavel_id
       WHERE s.fornecedor_id = $1
       ORDER BY s.iniciado_em DESC LIMIT 10`, [fornecedorId]),
    query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE severidade = 'CRITICA')::int AS criticas,
             count(*) FILTER (WHERE status NOT IN ('ENCERRADA','VALIDADA','CANCELADA'))::int
               AS abertas
        FROM nao_conformidades
       WHERE fornecedor_id = $1
         AND created_at >= $2::date AND created_at < ($3::date + interval '1 day')`,
      [fornecedorId, periodo.inicio, periodo.fim]),
  ]);

  const f: Record<string, any> = cadastro[0];

  return {
    periodo,
    cadastro: {
      id: Number(f.id),
      razao_social: f.razao_social,
      nome_fantasia: f.nome_fantasia,
      cnpj: f.cnpj,
      email: f.email,
      telefone: f.telefone,
      cidade: f.cidade,
      estado: f.estado,
      pais: f.pais,
      tipo_fornecedor: f.tipo_fornecedor,
      origem_fornecedor: f.origem_fornecedor,
      ativo: f.ativo,
      status_homologacao: f.status_homologacao,
      homologado_em: f.homologado_em,
      homologado_por: f.homologado_por_nome,
      incoterm: f.incoterm,
    },
    comercial: {
      lead_time_padrao_dias: f.lead_time_padrao_dias,
      prazo_medio_pagamento: f.prazo_medio_pagamento,
      transit_time_dias: f.transit_time_dias,
      produtos: produtos.rows.length,
      lista_produtos: produtos.rows.map((p: Record<string, any>) => ({
        ...p, data_ultima_compra: dataIso(p.data_ultima_compra),
      })),
    },
    historico_compras: {
      ...pedidos.rows[0],
      primeira_compra: dataIso(pedidos.rows[0]?.primeira_compra),
      ultima_compra: dataIso(pedidos.rows[0]?.ultima_compra),
    },
    performance: {
      score_atual: ouNulo(f.score_atual),
      ultima_avaliacao_em: dataIso(f.ultima_avaliacao_em),
      proxima_avaliacao_em: dataIso(f.proxima_avaliacao_em),
      nao_conformidades: ncs.rows[0],
    },
    avaliacoes: avaliacoes.rows.map((a: Record<string, any>) => ({
      ...a,
      periodo_inicio: dataIso(a.periodo_inicio),
      periodo_fim: dataIso(a.periodo_fim),
    })),
    planos_acao: planos.rows.map((p: Record<string, any>) => ({ ...p, prazo: dataIso(p.prazo) })),
    situacoes: situacao.rows.map((s: Record<string, any>) => ({ ...s, prazo: dataIso(s.prazo) })),
  };
}

// ---------------------------------------------------------------------------
// Historico de precos (secao 51)
// ---------------------------------------------------------------------------

export async function historicoPrecos(filtro: {
  produto_id?: number; fornecedor_id?: number; dias?: number;
}) {
  const dias = filtro.dias ?? 365;
  const fim = hojeLocal();
  const inicio = dataIso(new Date(Date.parse(`${fim}T00:00:00Z`) - dias * 86400000))!;

  const valores: unknown[] = [inicio, fim];
  const cond: string[] = [];
  if (filtro.produto_id) {
    valores.push(filtro.produto_id);
    cond.push(`h.produto_id = $${valores.length}`);
  }
  if (filtro.fornecedor_id) {
    valores.push(filtro.fornecedor_id);
    cond.push(`h.fornecedor_id = $${valores.length}`);
  }
  const extra = cond.length ? ` AND ${cond.join(' AND ')}` : '';

  const { rows } = await query(`
    SELECT h.*, oc.numero AS pedido
      FROM vw_historico_precos h
      LEFT JOIN historico_precos hp ON hp.id = h.id
      LEFT JOIN ordens_compra oc ON oc.id = hp.ordem_compra_id
     WHERE h.data BETWEEN $1::date AND $2::date ${extra}
     ORDER BY h.data DESC, h.id DESC
     LIMIT 500`, valores);

  return {
    periodo: { inicio, fim, dias },
    total: rows.length,
    registros: rows.map((r: Record<string, any>) => ({ ...r, data: dataIso(r.data) })),
  };
}

// ---------------------------------------------------------------------------
// Parametros
// ---------------------------------------------------------------------------

export async function listarParametros() {
  const [config, metodologia] = await Promise.all([
    query(`SELECT chave, valor, tipo, descricao FROM configuracoes
            WHERE grupo = 'avaliacao' ORDER BY chave`),
    query(`
      SELECT m.id, m.versao, m.nome, m.escopo, m.vigente, m.publicada_em, m.frequencia,
             (SELECT coalesce(sum(c.peso_percentual), 0) FROM metodologia_criterios c
               WHERE c.metodologia_id = m.id) AS soma_pesos,
             (SELECT count(*)::int FROM metodologia_criterios c
               WHERE c.metodologia_id = m.id) AS criterios
        FROM metodologias_avaliacao m
       WHERE m.ativo ORDER BY m.vigente DESC, m.versao DESC`),
  ]);

  return { configuracoes: config.rows, metodologias: metodologia.rows };
}

export async function atualizarParametros(
  entrada: z.output<typeof parametrosSchema>['parametros'], usuarioId: number | null,
) {
  const atualizados: string[] = [];
  for (const p of entrada) {
    const { rows } = await query(`
      UPDATE configuracoes SET valor = $2, updated_at = now(), updated_by = $3
       WHERE chave = $1 AND grupo = 'avaliacao' RETURNING chave`,
      [p.chave, p.valor, usuarioId]);
    if (rows.length) atualizados.push(p.chave);
  }
  return { atualizados, ignorados: entrada.filter((p) => !atualizados.includes(p.chave)) };
}
