import { query, comTransacao, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import type { z } from 'zod';
import type { calcularPrevisaoSchema, previsaoManualSchema } from './demanda.schemas.js';
import {
  backtest, calcularErros, classificarConfiabilidade, classificarTendencia,
  coeficienteVariacao, compararErro, intervalo, mediaMovel, mediaPonderada,
  mediaSimples, porSazonalidade, porTendencia, suavizacaoExponencial,
  type MetodoPrevisao, type Metrica, type ParametrosPrevisao, type ResultadoMetodo,
} from './previsao.metodos.js';

// ---------------------------------------------------------------------------
// Parametros
// ---------------------------------------------------------------------------

export interface ConfigForecast {
  mesesMinimos: number;
  mesesMinimosSazonalidade: number;
  janelaMediaMovel: number;
  metrica: Metrica;
  alpha: number;
  alphaAutomatico: boolean;
  pesos: number[];
  limiteOutlierZ: number;
  horizontePadraoDias: number;
  limiteCrescimento: number;
  limiteQueda: number;
  diasDesatualizada: number;
}

export async function carregarConfig(): Promise<ConfigForecast> {
  const { rows } = await query<{ chave: string; valor: string }>(
    "SELECT chave, valor FROM configuracoes WHERE grupo = 'forecast'",
  );
  const m = new Map(rows.map((r) => [r.chave, r.valor]));
  const num = (k: string, padrao: number) => {
    const v = Number(m.get(k));
    return Number.isFinite(v) ? v : padrao;
  };
  let pesos = [0.5, 0.3, 0.2];
  try {
    const bruto = JSON.parse(m.get('forecast.pesos_ponderada') ?? '[]');
    if (Array.isArray(bruto) && bruto.length && bruto.every((x) => typeof x === 'number' && x >= 0)) {
      pesos = bruto as number[];
    }
  } catch { /* mantem o padrao */ }

  const metrica = (m.get('forecast.metrica_erro') ?? 'MAPE').toUpperCase();

  return {
    mesesMinimos: num('forecast.meses_minimos_historico', 3),
    mesesMinimosSazonalidade: num('forecast.meses_minimos_sazonalidade', 12),
    janelaMediaMovel: Math.max(1, Math.round(num('forecast.janela_media_movel', 30) / 30)),
    metrica: (['MAE', 'MAPE', 'RMSE'].includes(metrica) ? metrica : 'MAPE') as Metrica,
    alpha: num('forecast.alpha', 0.3),
    alphaAutomatico: (m.get('forecast.alpha_automatico') ?? 'true') === 'true',
    pesos,
    limiteOutlierZ: num('forecast.limite_outlier_z', 3),
    horizontePadraoDias: num('forecast.horizonte_padrao_dias', 30),
    limiteCrescimento: num('forecast.limite_alerta_crescimento', 30),
    limiteQueda: num('forecast.limite_alerta_queda', 30),
    diasDesatualizada: num('forecast.dias_previsao_desatualizada', 30),
  };
}

// ---------------------------------------------------------------------------
// Calculo
// ---------------------------------------------------------------------------

interface SerieProduto {
  produto_id: number;
  meses: string[];
  valores: number[];
}

async function carregarSeries(
  produtoIds: number[] | null,
  categoriaId: number | null,
  mesesHistorico: number,
  limite: number,
): Promise<SerieProduto[]> {
  const valores: unknown[] = [mesesHistorico];
  let filtro = '';
  if (produtoIds?.length) {
    valores.push(produtoIds);
    filtro = `AND m.produto_id = ANY($${valores.length})`;
  } else if (categoriaId) {
    valores.push(categoriaId);
    filtro = `AND p.categoria_id = $${valores.length}`;
  }
  valores.push(limite);

  const { rows } = await query<{ produto_id: number; meses: string[]; valores: string[] }>(`
    WITH referencia AS (
      SELECT max(data_venda) AS ultimo_dia FROM mv_demanda_diaria
    ),
    limite AS (
      -- O mes corrente quase nunca esta fechado. Treinar com ele puxaria toda
      -- previsao para baixo, entao o ultimo mes so entra se estiver completo.
      SELECT CASE
               WHEN r.ultimo_dia = (date_trunc('month', r.ultimo_dia) + interval '1 month - 1 day')::date
               THEN date_trunc('month', r.ultimo_dia)::date
               ELSE (date_trunc('month', r.ultimo_dia) - interval '1 month')::date
             END AS ultimo_mes
        FROM referencia r
    ),
    corte AS (
      SELECT l.ultimo_mes,
             (l.ultimo_mes - make_interval(months => $1::int))::date AS inicio
        FROM limite l
    ),
    filtrado AS (
      SELECT m.produto_id, m.mes, m.quantidade
        FROM mv_demanda_mensal m
        JOIN produtos p ON p.id = m.produto_id AND p.deleted_at IS NULL
        CROSS JOIN corte c
       WHERE m.mes >= c.inicio AND m.mes <= c.ultimo_mes ${filtro}
    )
    SELECT produto_id,
           array_agg(mes::text ORDER BY mes)    AS meses,
           array_agg(quantidade ORDER BY mes)   AS valores
      FROM filtrado
     GROUP BY produto_id
     ORDER BY sum(quantidade) DESC
     LIMIT $${valores.length}`, valores);

  return rows.map((r) => ({
    produto_id: r.produto_id,
    meses: r.meses,
    valores: r.valores.map((v) => Math.max(0, Number(v))),
  }));
}

/** Preenche os meses sem venda com zero: a ausencia de venda e informacao. */
function completarMeses(meses: string[], valores: number[]): { meses: string[]; valores: number[] } {
  if (!meses.length) return { meses, valores };
  const saida: { mes: string; valor: number }[] = [];
  const mapa = new Map(meses.map((m, i) => [m.slice(0, 7), valores[i]!]));

  const [aInicio, mInicio] = meses[0]!.slice(0, 7).split('-').map(Number);
  const [aFim, mFim] = meses[meses.length - 1]!.slice(0, 7).split('-').map(Number);
  let ano = aInicio!;
  let mes = mInicio!;
  while (ano < aFim! || (ano === aFim! && mes <= mFim!)) {
    const chave = `${ano}-${String(mes).padStart(2, '0')}`;
    saida.push({ mes: `${chave}-01`, valor: mapa.get(chave) ?? 0 });
    mes += 1;
    if (mes > 12) { mes = 1; ano += 1; }
  }
  return { meses: saida.map((s) => s.mes), valores: saida.map((s) => s.valor) };
}

async function carregarIndicesSazonais(produtoId: number): Promise<Map<number, number>> {
  const { rows } = await query<{ mes: number; indice: number }>(
    'SELECT mes, indice FROM indices_sazonais WHERE produto_id = $1', [produtoId],
  );
  return new Map(rows.map((r) => [Number(r.mes), Number(r.indice)]));
}

interface PrevisaoCalculada {
  produto_id: number;
  metodo: MetodoPrevisao;
  demanda_mensal: number;
  demanda_diaria: number;
  demanda_horizonte: number;
  limite_inferior: number | null;
  limite_superior: number | null;
  mae: number;
  mape: number | null;
  rmse: number;
  tendencia: string;
  sazonal: boolean;
  indice_sazonal: number | null;
  meses_historico: number;
  confiabilidade: string;
  pontos_confiabilidade: number;
  explicacao: string;
  parametros: Record<string, unknown>;
  demanda_historica: number;
}

export async function calcularParaProduto(
  serie: SerieProduto,
  config: ConfigForecast,
  horizonteDias: number,
  metodoSolicitado: string,
): Promise<PrevisaoCalculada | { produto_id: number; sem_historico: true; meses: number }> {
  const { meses, valores } = completarMeses(serie.meses, serie.valores);
  if (valores.length < config.mesesMinimos) {
    return { produto_id: serie.produto_id, sem_historico: true, meses: valores.length };
  }

  const indices = await carregarIndicesSazonais(serie.produto_id);
  const mesesNumericos = meses.map((m) => Number(m.slice(5, 7)));

  const parametros: ParametrosPrevisao = {
    janelaMediaMovel: config.janelaMediaMovel,
    pesos: config.pesos,
    alpha: config.alpha,
    alphaAutomatico: config.alphaAutomatico,
    metrica: config.metrica,
  };

  // Backtest de origem deslizante sobre os ultimos periodos.
  const periodosTeste = Math.min(3, Math.max(1, valores.length - 2));
  const resultados = backtest(valores, mesesNumericos, indices, parametros, periodosTeste);

  const proximoMes = ((mesesNumericos[mesesNumericos.length - 1] ?? 1) % 12) + 1;

  const preverFinal = (metodo: MetodoPrevisao, params: Record<string, unknown>): number => {
    switch (metodo) {
      case 'MEDIA_SIMPLES': return mediaSimples(valores);
      case 'MEDIA_MOVEL': return mediaMovel(valores, Number(params.janela ?? config.janelaMediaMovel));
      case 'MEDIA_PONDERADA': return mediaPonderada(valores, (params.pesos as number[]) ?? config.pesos);
      case 'SUAVIZACAO_EXPONENCIAL': return suavizacaoExponencial(valores, Number(params.alpha ?? config.alpha));
      case 'TENDENCIA': return porTendencia(valores);
      case 'SAZONALIDADE': return porSazonalidade(valores, indices, mesesNumericos, proximoMes);
      case 'COMBINADO': {
        const previsoes = resultados.map((r) => preverFinal(r.metodo, r.parametros));
        return previsoes.length ? previsoes.reduce((a, b) => a + b, 0) / previsoes.length : 0;
      }
      default: return mediaSimples(valores);
    }
  };

  let escolhido: ResultadoMetodo;
  if (metodoSolicitado === 'AUTOMATICO') {
    escolhido = resultados.reduce((melhor, atual) =>
      compararErro(atual.erros, melhor.erros, config.metrica) < 0 ? atual : melhor);
  } else if (metodoSolicitado === 'COMBINADO') {
    const reais: number[] = [];
    const previstos: number[] = [];
    const inicio = valores.length - periodosTeste;
    for (let i = inicio; i < valores.length; i += 1) {
      reais.push(valores[i]!);
      const parciais = resultados.map((r) => {
        const treino = valores.slice(0, i);
        return treino.length >= 2 ? mediaSimples(treino) : 0;
      });
      previstos.push(parciais.length ? parciais.reduce((a, b) => a + b, 0) / parciais.length : 0);
    }
    escolhido = { metodo: 'COMBINADO', previsao: 0, erros: calcularErros(reais, previstos), parametros: {} };
  } else {
    const achado = resultados.find((r) => r.metodo === metodoSolicitado);
    if (!achado) throw regraNegocio(`Metodo ${metodoSolicitado} nao pode ser avaliado com o historico disponivel`);
    escolhido = achado;
  }

  const demandaMensal = Math.max(0, preverFinal(escolhido.metodo, escolhido.parametros));
  const demandaDiaria = demandaMensal / 30;
  const cv = coeficienteVariacao(valores);
  const tendencia = classificarTendencia(valores);
  const indiceSazonal = indices.get(proximoMes) ?? null;
  const sazonal = indices.size === 12;

  // Residuos do backtest para o intervalo.
  const residuos: number[] = [];
  const inicioTeste = valores.length - periodosTeste;
  for (let i = inicioTeste; i < valores.length; i += 1) {
    const treino = valores.slice(0, i);
    if (treino.length < 2) continue;
    residuos.push(valores[i]! - preverFinal(escolhido.metodo, escolhido.parametros));
  }
  const faixa = intervalo(demandaMensal, residuos);
  const confianca = classificarConfiabilidade(valores.length, escolhido.erros.mape, cv);

  const explicacao = [
    `Historico: ${valores.length} meses (${meses[0]?.slice(0, 7)} a ${meses[meses.length - 1]?.slice(0, 7)})`,
    `Metodo: ${escolhido.metodo}${Object.keys(escolhido.parametros).length ? ` ${JSON.stringify(escolhido.parametros)}` : ''}`,
    `Escolha por ${config.metrica}${escolhido.erros.mape !== null ? ` = ${escolhido.erros.mape.toFixed(1)}%` : ''}`,
    `Tendencia: ${tendencia}`,
    `Sazonalidade: ${sazonal ? `sim (indice ${indiceSazonal?.toFixed(2)})` : 'nao calculada'}`,
    `Confiabilidade: ${confianca.nivel} (${confianca.pontos}/100)`,
  ].join(' | ');

  return {
    produto_id: serie.produto_id,
    metodo: escolhido.metodo,
    demanda_mensal: demandaMensal,
    demanda_diaria: demandaDiaria,
    demanda_horizonte: demandaDiaria * horizonteDias,
    limite_inferior: faixa ? (faixa.inferior / 30) * horizonteDias : null,
    limite_superior: faixa ? (faixa.superior / 30) * horizonteDias : null,
    mae: escolhido.erros.mae,
    mape: escolhido.erros.mape,
    rmse: escolhido.erros.rmse,
    tendencia,
    sazonal,
    indice_sazonal: indiceSazonal,
    meses_historico: valores.length,
    confiabilidade: confianca.nivel,
    pontos_confiabilidade: confianca.pontos,
    explicacao,
    parametros: { ...escolhido.parametros, metrica: config.metrica, periodos_teste: periodosTeste },
    demanda_historica: valores.reduce((a, b) => a + b, 0),
  };
}

type EntradaCalculo = z.output<typeof calcularPrevisaoSchema>;

export async function executarPrevisao(entrada: EntradaCalculo, contexto: ContextoSessao) {
  const config = await carregarConfig();
  const horizonte = entrada.horizonte_dias ?? config.horizontePadraoDias;
  const mesesHistorico = entrada.meses_historico ?? 24;

  const series = await carregarSeries(
    entrada.produto_id ? [entrada.produto_id] : null,
    entrada.categoria_id ?? null,
    mesesHistorico,
    entrada.limite_produtos,
  );

  if (!series.length) throw regraNegocio('Nenhum produto com historico de vendas no filtro informado');

  const { rows: periodo } = await query<{ inicio: string; fim: string }>(
    `SELECT (date_trunc('month', max(mes)) - make_interval(months => $1::int))::text AS inicio,
            max(mes)::text AS fim FROM mv_demanda_mensal`, [mesesHistorico],
  );

  const { rows: execucao } = await query<{ id: number }>(`
    INSERT INTO execucoes_previsao
      (disparada_por, usuario_id, periodo_inicio, periodo_fim, horizonte_dias, metodo_solicitado, parametros)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [entrada.disparada_por, contexto.usuarioId ?? null,
      periodo[0]?.inicio ?? '2000-01-01', periodo[0]?.fim ?? '2000-01-01',
      horizonte,
      entrada.metodo === 'AUTOMATICO' ? null : entrada.metodo,
      JSON.stringify({ ...config, metodo: entrada.metodo, meses_historico: mesesHistorico })],
  );
  const execucaoId = execucao[0]!.id;

  const hoje = new Date();
  const inicioPrevisao = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()));
  const fimPrevisao = new Date(inicioPrevisao.getTime() + (horizonte - 1) * 86400000);
  const isoData = (d: Date) => d.toISOString().slice(0, 10);

  let geradas = 0;
  let semHistorico = 0;
  const amostra: unknown[] = [];

  try {
    for (const serie of series) {
      const resultado = await calcularParaProduto(serie, config, horizonte, entrada.metodo);
      if ('sem_historico' in resultado) { semHistorico += 1; continue; }

      const { rows: versao } = await query<{ proxima: number }>(
        `SELECT coalesce(max(versao), 0) + 1 AS proxima FROM previsoes_demanda
          WHERE produto_id = $1 AND periodo_inicio = $2 AND periodo_fim = $3`,
        [resultado.produto_id, isoData(inicioPrevisao), isoData(fimPrevisao)],
      );

      await query(`
        INSERT INTO previsoes_demanda
          (produto_id, periodo_inicio, periodo_fim, demanda_historica, demanda_prevista,
           metodo, confianca, parametros, gerado_por, execucao_id, versao, origem,
           limite_inferior, limite_superior, demanda_diaria, tendencia, sazonal, indice_sazonal,
           meses_historico, confiabilidade, mae, mape, rmse, explicacao)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CALCULADA',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [resultado.produto_id, isoData(inicioPrevisao), isoData(fimPrevisao),
          resultado.demanda_historica, resultado.demanda_horizonte,
          resultado.metodo, resultado.pontos_confiabilidade / 100,
          JSON.stringify(resultado.parametros), contexto.usuarioId ?? null,
          execucaoId, versao[0]!.proxima,
          resultado.limite_inferior, resultado.limite_superior, resultado.demanda_diaria,
          resultado.tendencia, resultado.sazonal, resultado.indice_sazonal,
          resultado.meses_historico, resultado.confiabilidade,
          resultado.mae, resultado.mape, resultado.rmse, resultado.explicacao],
      );
      geradas += 1;
      if (amostra.length < 10) amostra.push(resultado);
    }

    await query(`
      UPDATE execucoes_previsao
         SET status = 'CONCLUIDA', concluida_em = now(),
             produtos_avaliados = $2, previsoes_geradas = $3, produtos_sem_historico = $4
       WHERE id = $1`, [execucaoId, series.length, geradas, semHistorico]);
  } catch (erro) {
    await query(
      `UPDATE execucoes_previsao SET status = 'FALHOU', concluida_em = now(), erro_mensagem = $2 WHERE id = $1`,
      [execucaoId, erro instanceof Error ? erro.message : 'erro desconhecido'],
    );
    throw erro;
  }

  return {
    execucao_id: execucaoId,
    horizonte_dias: horizonte,
    periodo_previsto: { inicio: isoData(inicioPrevisao), fim: isoData(fimPrevisao) },
    produtos_avaliados: series.length,
    previsoes_geradas: geradas,
    produtos_sem_historico: semHistorico,
    metodo_solicitado: entrada.metodo,
    amostra,
  };
}

// ---------------------------------------------------------------------------
// Previsao manual (produto novo / sem historico)
// ---------------------------------------------------------------------------

export async function registrarPrevisaoManual(
  entrada: z.output<typeof previsaoManualSchema>,
  contexto: ContextoSessao,
) {
  const produto = await query('SELECT id FROM produtos WHERE id = $1 AND deleted_at IS NULL', [entrada.produto_id]);
  if (!produto.rows.length) throw naoEncontrado('Produto');

  const inicio = entrada.periodo_inicio.toISOString().slice(0, 10);
  const fim = entrada.periodo_fim.toISOString().slice(0, 10);
  const dias = Math.max(1, Math.round((entrada.periodo_fim.getTime() - entrada.periodo_inicio.getTime()) / 86400000) + 1);

  return comTransacao(contexto, async (cliente) => {
    const { rows: versao } = await cliente.query<{ proxima: number }>(
      `SELECT coalesce(max(versao), 0) + 1 AS proxima FROM previsoes_demanda
        WHERE produto_id = $1 AND periodo_inicio = $2 AND periodo_fim = $3`,
      [entrada.produto_id, inicio, fim],
    );
    const { rows } = await cliente.query(`
      INSERT INTO previsoes_demanda
        (produto_id, periodo_inicio, periodo_fim, demanda_prevista, metodo, parametros,
         gerado_por, versao, origem, demanda_diaria, meses_historico, confiabilidade,
         justificativa, explicacao)
      VALUES ($1,$2,$3,$4,'MANUAL','{}'::jsonb,$5,$6,$7,$8,0,'BAIXA',$9,$10)
      RETURNING *`,
      [entrada.produto_id, inicio, fim, entrada.demanda_prevista,
        contexto.usuarioId ?? null, versao[0]!.proxima, entrada.origem,
        entrada.demanda_prevista / dias, entrada.justificativa,
        `Previsao informada manualmente (${entrada.origem}). Justificativa: ${entrada.justificativa}`],
    );
    return rows[0];
  });
}

// ---------------------------------------------------------------------------
// Consulta de previsoes
// ---------------------------------------------------------------------------

export async function listarPrevisoes(filtro: Paginacao & { produto_id?: number; categoria_id?: number; confiabilidade?: string }) {
  const valores: unknown[] = [];
  const cond: string[] = ['p.deleted_at IS NULL'];
  if (filtro.produto_id) { valores.push(filtro.produto_id); cond.push(`pr.produto_id = $${valores.length}`); }
  if (filtro.categoria_id) { valores.push(filtro.categoria_id); cond.push(`p.categoria_id = $${valores.length}`); }
  if (filtro.confiabilidade) { valores.push(filtro.confiabilidade); cond.push(`pr.confiabilidade = $${valores.length}`); }
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(p.descricao ILIKE $${valores.length} OR p.codigo ILIKE $${valores.length})`);
  }
  const onde = `WHERE ${cond.join(' AND ')}`;

  // Vigente = ultima versao do periodo mais recente de cada produto.
  const de = `FROM (
                SELECT DISTINCT ON (produto_id) *
                  FROM previsoes_demanda
                 ORDER BY produto_id, periodo_inicio DESC, versao DESC
              ) pr
              JOIN produtos p ON p.id = pr.produto_id`;

  const total = await query<{ total: number }>(`SELECT count(*)::int AS total ${de} ${onde}`, valores);
  const dados = await query(`
    SELECT pr.*, p.codigo, p.descricao, p.classificacao_abc, p.classificacao_xyz
      ${de} ${onde}
     ORDER BY pr.demanda_prevista DESC, p.descricao
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return { dados: dados.rows, meta: metaPaginacao(total.rows[0]?.total ?? 0, filtro) };
}

export async function historicoPrevisoesProduto(produtoId: number) {
  const { rows } = await query(`
    SELECT pr.*, e.disparada_por, e.iniciada_em
      FROM previsoes_demanda pr
      LEFT JOIN execucoes_previsao e ON e.id = pr.execucao_id
     WHERE pr.produto_id = $1
     ORDER BY pr.periodo_inicio DESC, pr.versao DESC`, [produtoId]);
  if (!rows.length) throw naoEncontrado('Previsao para o produto');
  return rows;
}

export async function listarExecucoes(filtro: Paginacao) {
  const total = await query<{ total: number }>('SELECT count(*)::int AS total FROM execucoes_previsao');
  const { rows } = await query(`
    SELECT e.*, u.nome AS usuario
      FROM execucoes_previsao e
      LEFT JOIN usuarios u ON u.id = e.usuario_id
     ORDER BY e.iniciada_em DESC
     LIMIT $1 OFFSET $2`, [filtro.limite, deslocamento(filtro)]);
  return { dados: rows, meta: metaPaginacao(total.rows[0]?.total ?? 0, filtro) };
}

// ---------------------------------------------------------------------------
// Previsao x realizado
// ---------------------------------------------------------------------------

/**
 * Preenche o realizado das previsoes cujo periodo ja terminou.
 * E o unico UPDATE permitido pela trigger de append-only.
 */
export async function avaliarAcuracidade() {
  const { rows } = await query<{ atualizadas: number }>(`
    WITH pendentes AS (
      SELECT pr.id, pr.produto_id, pr.periodo_inicio, pr.periodo_fim, pr.demanda_prevista
        FROM previsoes_demanda pr
       WHERE pr.avaliado_em IS NULL AND pr.periodo_fim < CURRENT_DATE
       LIMIT 5000
    ),
    realizado AS (
      SELECT p.id,
             p.demanda_prevista,
             coalesce((SELECT sum(d.quantidade) FROM mv_demanda_diaria d
                        WHERE d.produto_id = p.produto_id
                          AND d.data_venda BETWEEN p.periodo_inicio AND p.periodo_fim), 0) AS realizado
        FROM pendentes p
    ),
    atualizacao AS (
      UPDATE previsoes_demanda pr
         SET realizado = r.realizado,
             erro_percentual = CASE WHEN r.realizado <> 0
                                    THEN (pr.demanda_prevista - r.realizado) / r.realizado * 100 END,
             avaliado_em = now()
        FROM realizado r
       WHERE pr.id = r.id
       RETURNING pr.id
    )
    SELECT count(*)::int AS atualizadas FROM atualizacao`);
  return { previsoes_avaliadas: rows[0]?.atualizadas ?? 0 };
}

export async function acuracidade(filtro: Paginacao & { produto_id?: number; categoria_id?: number; metodo?: string }) {
  const valores: unknown[] = [];
  const cond = ['pr.avaliado_em IS NOT NULL'];
  if (filtro.produto_id) { valores.push(filtro.produto_id); cond.push(`pr.produto_id = $${valores.length}`); }
  if (filtro.categoria_id) { valores.push(filtro.categoria_id); cond.push(`p.categoria_id = $${valores.length}`); }
  if (filtro.metodo) { valores.push(filtro.metodo); cond.push(`pr.metodo = $${valores.length}`); }
  const onde = `WHERE ${cond.join(' AND ')}`;

  const de = 'FROM previsoes_demanda pr JOIN produtos p ON p.id = pr.produto_id';

  const [resumo, porMetodo, total, dados] = await Promise.all([
    query(`SELECT count(*)::int AS previsoes,
                  avg(abs(pr.demanda_prevista - pr.realizado))                   AS mae,
                  avg(abs(pr.erro_percentual)) FILTER (WHERE pr.realizado <> 0)  AS mape,
                  sqrt(avg(power(pr.demanda_prevista - pr.realizado, 2)))        AS rmse,
                  avg(100 - least(100, abs(pr.erro_percentual)))
                    FILTER (WHERE pr.realizado <> 0)                             AS acuracidade_media
             ${de} ${onde}`, valores),
    query(`SELECT pr.metodo, count(*)::int AS previsoes,
                  avg(abs(pr.erro_percentual)) FILTER (WHERE pr.realizado <> 0) AS mape
             ${de} ${onde} GROUP BY pr.metodo ORDER BY mape NULLS LAST`, valores),
    query<{ total: number }>(`SELECT count(*)::int AS total ${de} ${onde}`, valores),
    query(`SELECT pr.id, pr.produto_id, p.codigo, p.descricao, pr.periodo_inicio, pr.periodo_fim,
                  pr.metodo, pr.demanda_prevista, pr.realizado,
                  pr.demanda_prevista - pr.realizado AS diferenca, pr.erro_percentual,
                  pr.confiabilidade
             ${de} ${onde}
            ORDER BY abs(pr.erro_percentual) DESC NULLS LAST
            LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
      [...valores, filtro.limite, deslocamento(filtro)]),
  ]);

  const r = resumo.rows[0] as Record<string, unknown>;
  const suficiente = Number(r.previsoes ?? 0) >= 3;

  return {
    // Secao 52: nao apresentar acuracidade quando os dados forem insuficientes.
    resumo: suficiente ? r : { previsoes: Number(r.previsoes ?? 0), dados_insuficientes: true },
    por_metodo: porMetodo.rows,
    dados: dados.rows,
    meta: metaPaginacao(total.rows[0]?.total ?? 0, filtro),
  };
}
