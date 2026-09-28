import { query, comTransacao, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import { carregarConfig } from './previsao.service.js';
import { coeficienteVariacao, desvioPadrao } from './previsao.metodos.js';
import type { FiltroPeriodo } from './demanda.schemas.js';
import { resolverPeriodo } from './demanda.service.js';

/**
 * Sinal de cada tipo de movimentacao. Precisa ser explicito porque a coluna
 * `quantidade` e sempre positiva: quem diz a direcao e o tipo.
 */
const SINAL_MOVIMENTACAO = `CASE m.tipo_movimentacao
    WHEN 'ENTRADA_COMPRA' THEN 1 WHEN 'AJUSTE_POSITIVO' THEN 1
    WHEN 'DEVOLUCAO' THEN 1 WHEN 'TRANSFERENCIA_ENTRADA' THEN 1
    WHEN 'PRODUCAO' THEN 1
    ELSE -1 END`;

// ---------------------------------------------------------------------------
// Sazonalidade
// ---------------------------------------------------------------------------

/**
 * Indice sazonal = demanda media do mes / demanda media do ciclo.
 *
 * So e calculado para produtos com historico suficiente (parametro
 * forecast.meses_minimos_sazonalidade). E so e marcado como `confirmado`
 * quando ha pelo menos dois ciclos completos E a variacao entre os meses e
 * relevante - caso contrario fica como "possivel sazonalidade".
 */
export async function calcularSazonalidade(produtoId?: number) {
  const config = await carregarConfig();
  const valores: unknown[] = [config.mesesMinimosSazonalidade];
  let filtro = '';
  if (produtoId) { valores.push(produtoId); filtro = `AND m.produto_id = $${valores.length}`; }

  const { rows } = await query<{
    produto_id: number; mes: number; media_mes: number;
    media_ciclo: number; meses_historico: number; ciclos: number; desvio_indices: number;
  }>(`
    WITH limite AS (
      -- Mesmo criterio da previsao: mes corrente incompleto nao entra na media.
      SELECT CASE
               WHEN max(data_venda) = (date_trunc('month', max(data_venda)) + interval '1 month - 1 day')::date
               THEN date_trunc('month', max(data_venda))::date
               ELSE (date_trunc('month', max(data_venda)) - interval '1 month')::date
             END AS ultimo_mes
        FROM mv_demanda_diaria
    ),
    fechado AS (
      SELECT m.* FROM mv_demanda_mensal m CROSS JOIN limite l WHERE m.mes <= l.ultimo_mes
    ),
    elegivel AS (
      SELECT produto_id, count(*) AS meses_historico
        FROM fechado m
       WHERE true ${filtro}
       GROUP BY produto_id
      HAVING count(*) >= $1
    ),
    por_mes AS (
      SELECT m.produto_id,
             extract(month FROM m.mes)::int AS mes,
             avg(m.quantidade) AS media_mes,
             count(*) AS ocorrencias
        FROM fechado m
        JOIN elegivel e ON e.produto_id = m.produto_id
       GROUP BY 1, 2
    ),
    ciclo AS (
      SELECT produto_id, avg(media_mes) AS media_ciclo, count(*) AS meses_distintos
        FROM por_mes GROUP BY produto_id
    )
    SELECT pm.produto_id, pm.mes, pm.media_mes, c.media_ciclo,
           e.meses_historico,
           floor(e.meses_historico / 12.0)::int AS ciclos,
           0::numeric AS desvio_indices
      FROM por_mes pm
      JOIN ciclo c    ON c.produto_id = pm.produto_id
      JOIN elegivel e ON e.produto_id = pm.produto_id
     WHERE c.media_ciclo > 0 AND c.meses_distintos = 12
     ORDER BY pm.produto_id, pm.mes`, valores);

  if (!rows.length) {
    return { produtos_avaliados: 0, indices_gravados: 0, motivo: 'Nenhum produto com historico suficiente' };
  }

  // Agrupa por produto para decidir confirmacao com a serie inteira em maos.
  const porProduto = new Map<number, typeof rows>();
  for (const r of rows) {
    if (!porProduto.has(r.produto_id)) porProduto.set(r.produto_id, []);
    porProduto.get(r.produto_id)!.push(r);
  }

  let gravados = 0;
  for (const [produto, linhas] of porProduto) {
    // Um mes pode fechar negativo quando as devolucoes superam as vendas.
    // Para o indice sazonal isso significa "sem demanda", nao demanda negativa.
    const indices = linhas.map((l) => Math.max(0, Number(l.media_mes) / Number(l.media_ciclo)));
    const dispersao = desvioPadrao(indices);
    const ciclos = Number(linhas[0]!.ciclos);
    // Dois ciclos completos e dispersao relevante: so ai afirmamos sazonalidade.
    const confirmado = ciclos >= 2 && dispersao >= 0.15;

    for (let i = 0; i < linhas.length; i += 1) {
      const l = linhas[i]!;
      await query(`
        INSERT INTO indices_sazonais
          (produto_id, mes, indice, demanda_media_mes, demanda_media_ciclo,
           ciclos_observados, meses_historico, confirmado, calculado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
        ON CONFLICT (produto_id, mes) DO UPDATE
          SET indice = EXCLUDED.indice,
              demanda_media_mes = EXCLUDED.demanda_media_mes,
              demanda_media_ciclo = EXCLUDED.demanda_media_ciclo,
              ciclos_observados = EXCLUDED.ciclos_observados,
              meses_historico = EXCLUDED.meses_historico,
              confirmado = EXCLUDED.confirmado,
              calculado_em = now()`,
        [produto, l.mes, indices[i], l.media_mes, l.media_ciclo, ciclos, l.meses_historico, confirmado]);
      gravados += 1;
    }
  }

  return { produtos_avaliados: porProduto.size, indices_gravados: gravados };
}

export async function listarSazonalidade(filtro: Paginacao & { confirmado?: boolean }) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  if (filtro.confirmado !== undefined) {
    valores.push(filtro.confirmado);
    cond.push(`s.confirmado = $${valores.length}`);
  }
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(p.descricao ILIKE $${valores.length} OR p.codigo ILIKE $${valores.length})`);
  }
  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = await query<{ total: number }>(`
    SELECT count(DISTINCT s.produto_id)::int AS total
      FROM indices_sazonais s JOIN produtos p ON p.id = s.produto_id ${onde}`, valores);

  const { rows } = await query(`
    SELECT s.produto_id, p.codigo, p.descricao,
           max(s.meses_historico) AS meses_historico,
           max(s.ciclos_observados) AS ciclos,
           bool_and(s.confirmado) AS confirmado,
           max(s.indice) AS indice_maximo,
           min(s.indice) AS indice_minimo,
           jsonb_object_agg(s.mes, round(s.indice, 4) ORDER BY s.mes) AS indices
      FROM indices_sazonais s JOIN produtos p ON p.id = s.produto_id ${onde}
     GROUP BY s.produto_id, p.codigo, p.descricao
     ORDER BY (max(s.indice) - min(s.indice)) DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return {
    dados: rows.map((r) => ({
      ...r,
      situacao: r.confirmado ? 'SAZONAL' : 'POSSIVEL_SAZONALIDADE',
    })),
    meta: metaPaginacao(total.rows[0]?.total ?? 0, filtro),
  };
}

export async function sazonalidadeProduto(produtoId: number) {
  const { rows } = await query(`
    SELECT s.mes, s.indice, s.demanda_media_mes, s.demanda_media_ciclo,
           s.ciclos_observados, s.meses_historico, s.confirmado, s.calculado_em
      FROM indices_sazonais s WHERE s.produto_id = $1 ORDER BY s.mes`, [produtoId]);
  if (!rows.length) {
    const config = await carregarConfig();
    const { rows: hist } = await query<{ meses: number }>(
      'SELECT count(*)::int AS meses FROM mv_demanda_mensal WHERE produto_id = $1', [produtoId]);
    return {
      produto_id: produtoId,
      indices: [],
      sazonal: false,
      motivo: `Historico de ${hist[0]?.meses ?? 0} meses; sao necessarios ${config.mesesMinimosSazonalidade}`,
    };
  }
  const serieAnual = await query(`
    SELECT extract(year FROM mes)::int AS ano, extract(month FROM mes)::int AS mes, quantidade
      FROM mv_demanda_mensal WHERE produto_id = $1 ORDER BY mes`, [produtoId]);

  return {
    produto_id: produtoId,
    indices: rows,
    sazonal: rows.every((r) => r.confirmado),
    situacao: rows.every((r) => r.confirmado) ? 'SAZONAL' : 'POSSIVEL_SAZONALIDADE',
    serie_anual: serieAnual.rows,
  };
}

// ---------------------------------------------------------------------------
// Outliers
// ---------------------------------------------------------------------------

export async function detectarOutliers(filtro: FiltroPeriodo) {
  const config = await carregarConfig();
  const periodo = await resolverPeriodo({ ...filtro, dias: filtro.dias ?? 365 });

  const { rows } = await query<{ detectados: number }>(`
    WITH estatistica AS (
      SELECT produto_id, avg(quantidade) AS media, stddev_samp(quantidade) AS desvio, count(*) AS dias
        FROM mv_demanda_diaria
       WHERE data_venda BETWEEN $1 AND $2
       GROUP BY produto_id
      HAVING count(*) >= 10 AND stddev_samp(quantidade) > 0
    ),
    candidatos AS (
      SELECT d.produto_id, d.data_venda, d.quantidade, e.media, e.desvio,
             (d.quantidade - e.media) / e.desvio AS z
        FROM mv_demanda_diaria d
        JOIN estatistica e ON e.produto_id = d.produto_id
       WHERE d.data_venda BETWEEN $1 AND $2
         AND abs((d.quantidade - e.media) / e.desvio) >= $3
    ),
    inseridos AS (
      INSERT INTO vendas_outliers
        (produto_id, data_venda, quantidade, media_periodo, desvio_padrao, z_score)
      SELECT produto_id, data_venda, quantidade, media, desvio, z FROM candidatos
      ON CONFLICT (produto_id, data_venda) DO NOTHING
      RETURNING id
    )
    SELECT count(*)::int AS detectados FROM inseridos`,
    [periodo.inicio, periodo.fim, config.limiteOutlierZ]);

  return { periodo, limite_z: config.limiteOutlierZ, novos_outliers: rows[0]?.detectados ?? 0 };
}

export async function listarOutliers(filtro: Paginacao & { tratamento?: string; produto_id?: number }) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  if (filtro.tratamento) { valores.push(filtro.tratamento); cond.push(`o.tratamento = $${valores.length}`); }
  if (filtro.produto_id) { valores.push(filtro.produto_id); cond.push(`o.produto_id = $${valores.length}`); }
  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM vendas_outliers o ${onde}`, valores);
  const { rows } = await query(`
    SELECT o.*, p.codigo, p.descricao, u.nome AS decidido_por_nome
      FROM vendas_outliers o
      JOIN produtos p ON p.id = o.produto_id
      LEFT JOIN usuarios u ON u.id = o.decidido_por
      ${onde}
     ORDER BY abs(o.z_score) DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return { dados: rows, meta: metaPaginacao(total.rows[0]?.total ?? 0, filtro) };
}

export async function tratarOutlier(
  id: number,
  entrada: { tratamento: string; justificativa: string },
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(`
      UPDATE vendas_outliers
         SET tratamento = $2, justificativa = $3, decidido_por = $4, decidido_em = now()
       WHERE id = $1 RETURNING *`,
      [id, entrada.tratamento, entrada.justificativa, contexto.usuarioId ?? null]);
    if (!rows.length) throw naoEncontrado('Outlier');
    return rows[0];
  });
}

// ---------------------------------------------------------------------------
// Ruptura
// ---------------------------------------------------------------------------

/**
 * Reconstroi o saldo diario a partir do saldo atual, andando para tras nas
 * movimentacoes. Quando nao ha movimentacao no periodo, o sistema diz que nao
 * tem base para afirmar ruptura em vez de inventar dias zerados.
 */
export async function analisarRuptura(filtro: FiltroPeriodo & Paginacao) {
  const periodo = await resolverPeriodo({ ...filtro, dias: filtro.dias ?? 180 });
  const valores: unknown[] = [periodo.inicio, periodo.fim];
  const cond: string[] = ['p.deleted_at IS NULL'];
  if (filtro.produto_id) { valores.push(filtro.produto_id); cond.push(`p.id = $${valores.length}`); }
  if (filtro.categoria_id) { valores.push(filtro.categoria_id); cond.push(`p.categoria_id = $${valores.length}`); }
  const onde = `WHERE ${cond.join(' AND ')}`;

  const { rows } = await query(`
    WITH saldo_atual AS (
      SELECT produto_id, sum(quantidade_disponivel) AS saldo FROM estoques GROUP BY produto_id
    ),
    movimentos AS (
      SELECT m.produto_id, m.created_at::date AS dia,
             sum(${SINAL_MOVIMENTACAO} * m.quantidade) AS delta
        FROM movimentacoes_estoque m
       GROUP BY 1, 2
    ),
    dias AS (
      SELECT generate_series($1::date, $2::date, '1 day')::date AS dia
    ),
    reconstruido AS (
      -- Saldo no fim do dia = saldo de hoje menos tudo que se movimentou depois dele.
      SELECT p.id AS produto_id, d.dia,
             coalesce(sa.saldo, 0)
               - coalesce((SELECT sum(mv.delta) FROM movimentos mv
                            WHERE mv.produto_id = p.id AND mv.dia > d.dia), 0) AS saldo
        FROM produtos p
        CROSS JOIN dias d
        LEFT JOIN saldo_atual sa ON sa.produto_id = p.id
        ${onde}
    ),
    agregado AS (
      SELECT r.produto_id,
             count(*) FILTER (WHERE r.saldo <= 0) AS dias_ruptura,
             count(*) FILTER (WHERE r.saldo > 0)  AS dias_disponivel,
             count(*)                              AS dias_periodo
        FROM reconstruido r GROUP BY r.produto_id
    ),
    vendas AS (
      SELECT d.produto_id,
             sum(d.quantidade) AS quantidade,
             count(*)          AS dias_com_venda
        FROM mv_demanda_diaria d
       WHERE d.data_venda BETWEEN $1 AND $2
       GROUP BY d.produto_id
    ),
    tem_movimento AS (
      SELECT DISTINCT produto_id FROM movimentacoes_estoque
    )
    SELECT a.produto_id, p.codigo, p.descricao,
           a.dias_ruptura, a.dias_disponivel, a.dias_periodo,
           coalesce(v.quantidade, 0) AS quantidade_vendida,
           coalesce(v.dias_com_venda, 0) AS dias_com_venda,
           CASE WHEN a.dias_disponivel > 0
                THEN coalesce(v.quantidade, 0) / a.dias_disponivel END AS media_dias_disponiveis,
           (tm.produto_id IS NOT NULL) AS base_confiavel
      FROM agregado a
      JOIN produtos p ON p.id = a.produto_id
      LEFT JOIN vendas v ON v.produto_id = a.produto_id
      LEFT JOIN tem_movimento tm ON tm.produto_id = a.produto_id
     WHERE a.dias_ruptura > 0
     ORDER BY a.dias_ruptura DESC, p.descricao
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  const semBase = rows.filter((r) => !r.base_confiavel).length;

  return {
    periodo,
    dados: rows,
    aviso: semBase
      ? `${semBase} produto(s) sem movimentacao de estoque registrada: a ruptura foi inferida apenas do saldo atual e nao deve ser tratada como historico`
      : null,
  };
}

// ---------------------------------------------------------------------------
// Demanda reprimida
// ---------------------------------------------------------------------------

/**
 * Estimativa, nunca "venda perdida confirmada" (secao 35 do prompt 04).
 * So gera registro quando ha media de venda ANTES da ruptura - sem isso nao ha
 * evidencia e nada e gravado.
 */
export async function calcularDemandaReprimida(filtro: FiltroPeriodo) {
  const periodo = await resolverPeriodo({ ...filtro, dias: filtro.dias ?? 180 });

  const { rows } = await query<{ gravados: number }>(`
    WITH saldo_atual AS (
      SELECT produto_id, sum(quantidade_disponivel) AS saldo FROM estoques GROUP BY produto_id
    ),
    movimentos AS (
      SELECT m.produto_id, m.created_at::date AS dia,
             sum(${SINAL_MOVIMENTACAO} * m.quantidade) AS delta
        FROM movimentacoes_estoque m GROUP BY 1, 2
    ),
    dias AS (SELECT generate_series($1::date, $2::date, '1 day')::date AS dia),
    reconstruido AS (
      SELECT p.id AS produto_id, d.dia,
             coalesce(sa.saldo, 0)
               - coalesce((SELECT sum(mv.delta) FROM movimentos mv
                            WHERE mv.produto_id = p.id AND mv.dia > d.dia), 0) AS saldo
        FROM produtos p
        CROSS JOIN dias d
        LEFT JOIN saldo_atual sa ON sa.produto_id = p.id
       WHERE p.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM movimentacoes_estoque m WHERE m.produto_id = p.id)
    ),
    marcado AS (
      SELECT produto_id, dia, saldo,
             -- Agrupa dias consecutivos em ruptura: a diferenca entre a data e o
             -- numero da linha e constante dentro de uma mesma sequencia.
             dia - (row_number() OVER (PARTITION BY produto_id ORDER BY dia))::int AS grupo
        FROM reconstruido WHERE saldo <= 0
    ),
    janelas AS (
      SELECT produto_id, min(dia) AS inicio, max(dia) AS fim, count(*)::int AS dias_ruptura
        FROM marcado GROUP BY produto_id, grupo
      HAVING count(*) >= 2
    ),
    com_media AS (
      SELECT j.*,
             (SELECT avg(d.quantidade) FROM mv_demanda_diaria d
               WHERE d.produto_id = j.produto_id
                 AND d.data_venda BETWEEN j.inicio - 60 AND j.inicio - 1) AS media_antes,
             (SELECT avg(d.valor / nullif(d.quantidade, 0)) FROM mv_demanda_diaria d
               WHERE d.produto_id = j.produto_id
                 AND d.data_venda BETWEEN j.inicio - 60 AND j.inicio - 1) AS preco_medio
        FROM janelas j
    ),
    gravar AS (
      INSERT INTO demanda_reprimida
        (produto_id, periodo_inicio, periodo_fim, dias_ruptura, media_diaria_antes,
         demanda_estimada, preco_medio, valor_estimado, classificacao, evidencias)
      SELECT produto_id, inicio, fim, dias_ruptura, media_antes,
             media_antes * dias_ruptura, preco_medio,
             media_antes * dias_ruptura * coalesce(preco_medio, 0),
             CASE WHEN dias_ruptura >= 7 THEN 'PROVAVEL' ELSE 'POSSIVEL' END::classificacao_reprimida_enum,
             jsonb_build_array(
               jsonb_build_object('evidencia', 'produto sem saldo disponivel', 'dias', dias_ruptura),
               jsonb_build_object('evidencia', 'media diaria nos 60 dias anteriores', 'valor', round(media_antes, 3))
             )
        FROM com_media
       WHERE media_antes IS NOT NULL AND media_antes > 0
      ON CONFLICT (produto_id, periodo_inicio) DO NOTHING
      RETURNING id
    )
    SELECT count(*)::int AS gravados FROM gravar`, [periodo.inicio, periodo.fim]);

  return {
    periodo,
    registros_gravados: rows[0]?.gravados ?? 0,
    observacao: 'Valores sao estimativa de demanda reprimida, nao venda perdida confirmada',
  };
}

export async function listarDemandaReprimida(filtro: Paginacao & { classificacao?: string; produto_id?: number }) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  if (filtro.classificacao) { valores.push(filtro.classificacao); cond.push(`r.classificacao = $${valores.length}`); }
  if (filtro.produto_id) { valores.push(filtro.produto_id); cond.push(`r.produto_id = $${valores.length}`); }
  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM demanda_reprimida r ${onde}`, valores);
  const { rows } = await query(`
    SELECT r.*, p.codigo, p.descricao
      FROM demanda_reprimida r JOIN produtos p ON p.id = r.produto_id ${onde}
     ORDER BY r.valor_estimado DESC NULLS LAST
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  const totais = await query(`
    SELECT coalesce(sum(r.demanda_estimada), 0) AS demanda_total,
           coalesce(sum(r.valor_estimado), 0)   AS valor_total,
           count(*)::int                        AS ocorrencias,
           coalesce(sum(r.dias_ruptura), 0)::int AS dias_ruptura
      FROM demanda_reprimida r ${onde}`, valores);

  return {
    dados: rows,
    impacto: totais.rows[0],
    meta: metaPaginacao(total.rows[0]?.total ?? 0, filtro),
    observacao: 'Estimativa de demanda reprimida',
  };
}

export async function classificarReprimida(
  id: number,
  entrada: { classificacao: string; observacao?: string },
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      `UPDATE demanda_reprimida SET classificacao = $2, observacao = $3 WHERE id = $1 RETURNING *`,
      [id, entrada.classificacao, entrada.observacao ?? null]);
    if (!rows.length) throw naoEncontrado('Registro de demanda reprimida');
    return rows[0];
  });
}

// ---------------------------------------------------------------------------
// ABC x XYZ
// ---------------------------------------------------------------------------

/**
 * ABC pelo faturamento acumulado; XYZ pelo coeficiente de variacao da demanda
 * mensal. Os limites vem de `configuracoes` (abc.limite_a, xyz.limite_x, ...),
 * porque cada operacao corta a curva num ponto diferente.
 */
export async function classificarAbcXyz(dias: number, contexto: ContextoSessao) {
  const { rows: cfg } = await query<{ chave: string; valor: string }>(
    "SELECT chave, valor FROM configuracoes WHERE chave IN ('abc.limite_a','abc.limite_b','xyz.limite_x','xyz.limite_y')");
  const m = new Map(cfg.map((c) => [c.chave, Number(c.valor)]));
  const limiteA = m.get('abc.limite_a') ?? 80;
  const limiteB = m.get('abc.limite_b') ?? 95;
  const limiteX = m.get('xyz.limite_x') ?? 0.5;
  const limiteY = m.get('xyz.limite_y') ?? 1.0;

  const { rows } = await query<{ atualizados: number }>(`
    WITH referencia AS (SELECT max(data_venda) AS fim FROM mv_demanda_diaria),
    janela AS (SELECT fim, (fim - $1::int) AS inicio FROM referencia),
    faturamento AS (
      SELECT d.produto_id, sum(d.valor) AS valor
        FROM mv_demanda_diaria d, janela j
       WHERE d.data_venda BETWEEN j.inicio AND j.fim
       GROUP BY d.produto_id
      HAVING sum(d.valor) > 0
    ),
    acumulado AS (
      SELECT produto_id, valor,
             sum(valor) OVER (ORDER BY valor DESC, produto_id)
               / nullif(sum(valor) OVER (), 0) * 100 AS percentual_acumulado
        FROM faturamento
    ),
    abc AS (
      SELECT produto_id,
             CASE WHEN percentual_acumulado <= $2 THEN 'A'
                  WHEN percentual_acumulado <= $3 THEN 'B'
                  ELSE 'C' END::classificacao_abc_enum AS classe
        FROM acumulado
    ),
    mensal AS (
      SELECT m.produto_id, avg(m.quantidade) AS media, stddev_samp(m.quantidade) AS desvio,
             count(*) AS meses
        FROM mv_demanda_mensal m, janela j
       WHERE m.mes >= date_trunc('month', j.inicio)
       GROUP BY m.produto_id
    ),
    xyz AS (
      SELECT produto_id,
             CASE WHEN meses < 3 OR media = 0 THEN 'Z'
                  WHEN desvio / media <= $4 THEN 'X'
                  WHEN desvio / media <= $5 THEN 'Y'
                  ELSE 'Z' END::classificacao_xyz_enum AS classe
        FROM mensal
    ),
    atualizacao AS (
      UPDATE produtos p
         SET classificacao_abc = abc.classe,
             classificacao_xyz = coalesce(xyz.classe, p.classificacao_xyz)
        FROM abc LEFT JOIN xyz ON xyz.produto_id = abc.produto_id
       WHERE p.id = abc.produto_id AND p.deleted_at IS NULL
       RETURNING p.id
    )
    SELECT count(*)::int AS atualizados FROM atualizacao`,
    [dias, limiteA, limiteB, limiteX, limiteY]);

  return {
    dias_analisados: dias,
    limites: { abc_a: limiteA, abc_b: limiteB, xyz_x: limiteX, xyz_y: limiteY },
    produtos_classificados: rows[0]?.atualizados ?? 0,
  };
}

export async function matrizAbcXyz(filtro: FiltroPeriodo) {
  const periodo = await resolverPeriodo({ ...filtro, dias: filtro.dias ?? 365 });
  const { rows } = await query(`
    SELECT coalesce(p.classificacao_abc::text, 'SEM') AS abc,
           coalesce(p.classificacao_xyz::text, 'SEM') AS xyz,
           count(*)::int AS produtos,
           coalesce(sum(d.quantidade), 0) AS quantidade,
           coalesce(sum(d.valor), 0)      AS valor
      FROM produtos p
      LEFT JOIN (SELECT produto_id, sum(quantidade) AS quantidade, sum(valor) AS valor
                   FROM mv_demanda_diaria WHERE data_venda BETWEEN $1 AND $2
                  GROUP BY produto_id) d ON d.produto_id = p.id
     WHERE p.deleted_at IS NULL
     GROUP BY 1, 2 ORDER BY 1, 2`, [periodo.inicio, periodo.fim]);

  const porClasse = await query(`
    SELECT coalesce(p.classificacao_abc::text, 'SEM') AS classe,
           count(*)::int AS produtos,
           coalesce(sum(d.quantidade), 0) AS quantidade,
           coalesce(sum(d.valor), 0)      AS valor,
           coalesce(avg(d.quantidade), 0) AS media
      FROM produtos p
      LEFT JOIN (SELECT produto_id, sum(quantidade) AS quantidade, sum(valor) AS valor
                   FROM mv_demanda_diaria WHERE data_venda BETWEEN $1 AND $2
                  GROUP BY produto_id) d ON d.produto_id = p.id
     WHERE p.deleted_at IS NULL GROUP BY 1 ORDER BY 1`, [periodo.inicio, periodo.fim]);

  return { periodo, matriz: rows, por_classe_abc: porClasse.rows };
}

// ---------------------------------------------------------------------------
// Produtos criticos e irregulares
// ---------------------------------------------------------------------------

export async function produtosCriticos(filtro: Paginacao) {
  const { rows } = await query(`
    SELECT b.produto_id, b.codigo, b.descricao, b.classificacao_abc, b.classificacao_xyz,
           b.estoque_disponivel, b.demanda_diaria_90d, b.lead_time_dias, b.lead_time_padrao_dias,
           CASE WHEN b.demanda_diaria_90d > 0
                THEN b.estoque_disponivel / b.demanda_diaria_90d END AS cobertura_dias,
           b.demanda_prevista, b.previsao_confiabilidade
      FROM vw_base_planejamento b
     WHERE b.demanda_diaria_90d > 0
       AND (b.estoque_disponivel <= 0
            OR b.estoque_disponivel / b.demanda_diaria_90d
               < coalesce(b.lead_time_dias, b.lead_time_padrao_dias, 0))
     ORDER BY CASE WHEN b.estoque_disponivel <= 0 THEN 0 ELSE 1 END,
              b.demanda_diaria_90d DESC
     LIMIT $1 OFFSET $2`, [filtro.limite, deslocamento(filtro)]);
  return rows;
}

export async function demandaIrregular(filtro: Paginacao) {
  const { rows } = await query(`
    SELECT m.produto_id, p.codigo, p.descricao,
           count(*)::int                             AS meses,
           count(*) FILTER (WHERE m.quantidade = 0)::int AS meses_zerados,
           avg(m.quantidade)                          AS media,
           stddev_samp(m.quantidade)                  AS desvio,
           CASE WHEN avg(m.quantidade) > 0
                THEN stddev_samp(m.quantidade) / avg(m.quantidade) END AS coeficiente_variacao,
           p.classificacao_xyz
      FROM mv_demanda_mensal m
      JOIN produtos p ON p.id = m.produto_id AND p.deleted_at IS NULL
     GROUP BY m.produto_id, p.codigo, p.descricao, p.classificacao_xyz
    HAVING count(*) >= 6 AND avg(m.quantidade) > 0
       AND stddev_samp(m.quantidade) / avg(m.quantidade) > 1
     ORDER BY coeficiente_variacao DESC
     LIMIT $1 OFFSET $2`, [filtro.limite, deslocamento(filtro)]);
  return rows;
}

// ---------------------------------------------------------------------------
// Alertas de demanda
// ---------------------------------------------------------------------------

export async function alertasDemanda(filtro: FiltroPeriodo) {
  const config = await carregarConfig();
  const periodo = await resolverPeriodo({ ...filtro, dias: filtro.dias ?? 30 });
  const anteriorFim = new Date(new Date(`${periodo.inicio}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
  const anteriorInicio = new Date(new Date(`${periodo.inicio}T00:00:00Z`).getTime() - periodo.dias * 86400000).toISOString().slice(0, 10);

  const { rows } = await query(`
    WITH atual AS (
      SELECT produto_id, sum(quantidade) AS quantidade FROM mv_demanda_diaria
       WHERE data_venda BETWEEN $1 AND $2 GROUP BY produto_id
    ),
    anterior AS (
      SELECT produto_id, sum(quantidade) AS quantidade FROM mv_demanda_diaria
       WHERE data_venda BETWEEN $3 AND $4 GROUP BY produto_id
    ),
    variacao AS (
      SELECT coalesce(a.produto_id, b.produto_id) AS produto_id,
             coalesce(a.quantidade, 0) AS atual,
             coalesce(b.quantidade, 0) AS anterior,
             CASE WHEN coalesce(b.quantidade, 0) > 0
                  THEN (coalesce(a.quantidade, 0) - b.quantidade) / b.quantidade * 100 END AS variacao_pct
        FROM atual a FULL OUTER JOIN anterior b ON b.produto_id = a.produto_id
    )
    -- O UNION vai dentro de uma subconsulta: ORDER BY com expressao nao e
    -- aceito diretamente sobre UNION.
    SELECT * FROM (
      SELECT 'DEMANDA_CRESCENDO' AS tipo, v.produto_id, p.codigo, p.descricao,
             v.anterior, v.atual, v.variacao_pct
        FROM variacao v JOIN produtos p ON p.id = v.produto_id AND p.deleted_at IS NULL
       WHERE v.variacao_pct >= $5::numeric
      UNION ALL
      SELECT 'DEMANDA_CAINDO', v.produto_id, p.codigo, p.descricao, v.anterior, v.atual, v.variacao_pct
        FROM variacao v JOIN produtos p ON p.id = v.produto_id AND p.deleted_at IS NULL
       -- O menos unario precisa do cast: sem ele o Postgres nao sabe o tipo do parametro.
       WHERE v.variacao_pct <= -($6::numeric)
    ) alertas
     ORDER BY abs(variacao_pct) DESC
     LIMIT 300`,
    [periodo.inicio, periodo.fim, anteriorInicio, anteriorFim, config.limiteCrescimento, config.limiteQueda]);

  const [desatualizadas, semHistorico, erroAlto] = await Promise.all([
    query(`SELECT count(*)::int AS total FROM (
             SELECT DISTINCT ON (produto_id) produto_id, created_at
               FROM previsoes_demanda ORDER BY produto_id, periodo_inicio DESC) u
            WHERE u.created_at < now() - make_interval(days => $1::int)`, [config.diasDesatualizada]),
    query(`SELECT count(*)::int AS total FROM produtos p
            WHERE p.deleted_at IS NULL
              AND (SELECT count(*) FROM mv_demanda_mensal m WHERE m.produto_id = p.id) < $1`,
      [config.mesesMinimos]),
    query(`SELECT count(*)::int AS total FROM previsoes_demanda
            WHERE avaliado_em IS NOT NULL AND abs(erro_percentual) > 50`),
  ]);

  return {
    periodo,
    limites: { crescimento: config.limiteCrescimento, queda: config.limiteQueda },
    variacoes: rows,
    previsoes_desatualizadas: desatualizadas.rows[0]?.total ?? 0,
    produtos_sem_historico: semHistorico.rows[0]?.total ?? 0,
    previsoes_com_erro_alto: erroAlto.rows[0]?.total ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Calendario
// ---------------------------------------------------------------------------

export async function listarCalendario(filtro: { data_inicio?: Date; data_fim?: Date; tipo?: string }) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  if (filtro.data_inicio) { valores.push(filtro.data_inicio); cond.push(`data_fim >= $${valores.length}`); }
  if (filtro.data_fim) { valores.push(filtro.data_fim); cond.push(`data_inicio <= $${valores.length}`); }
  if (filtro.tipo) { valores.push(filtro.tipo); cond.push(`tipo = $${valores.length}`); }
  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM calendario_eventos ${onde} ORDER BY data_inicio LIMIT 500`, valores);
  return rows;
}

export async function criarEventoCalendario(entrada: Record<string, unknown>, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(`
      INSERT INTO calendario_eventos
        (nome, tipo, data_inicio, data_fim, produto_id, categoria_id, desconto_percentual, observacao, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [entrada.nome, entrada.tipo, entrada.data_inicio, entrada.data_fim,
        entrada.produto_id ?? null, entrada.categoria_id ?? null,
        entrada.desconto_percentual ?? null, entrada.observacao ?? null, contexto.usuarioId ?? null]);
    return rows[0];
  });
}

// ---------------------------------------------------------------------------
// Parametros do modulo
// ---------------------------------------------------------------------------

export async function listarParametros() {
  const { rows } = await query(
    "SELECT chave, valor, tipo, descricao FROM configuracoes WHERE grupo = 'forecast' ORDER BY chave");
  return rows;
}

export async function atualizarParametros(
  valores: Record<string, string | number | boolean>,
  contexto: ContextoSessao,
) {
  const chaves = Object.keys(valores);
  const { rows: existentes } = await query<{ chave: string }>(
    "SELECT chave FROM configuracoes WHERE grupo = 'forecast' AND chave = ANY($1)", [chaves]);
  const validas = new Set(existentes.map((e) => e.chave));
  const invalidas = chaves.filter((c) => !validas.has(c));
  if (invalidas.length) throw regraNegocio(`Parametro nao reconhecido - ${invalidas.join(', ')}`);

  return comTransacao(contexto, async (cliente) => {
    for (const chave of chaves) {
      await cliente.query(
        'UPDATE configuracoes SET valor = $2, updated_by = $3, updated_at = now() WHERE chave = $1',
        [chave, String(valores[chave]), contexto.usuarioId ?? null]);
    }
    const { rows } = await cliente.query(
      "SELECT chave, valor, tipo, descricao FROM configuracoes WHERE grupo = 'forecast' ORDER BY chave");
    return rows;
  });
}
