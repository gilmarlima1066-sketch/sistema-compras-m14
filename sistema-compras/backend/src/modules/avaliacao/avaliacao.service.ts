/**
 * Avaliacao do fornecedor: junta metodologia, indicadores e score.
 *
 * O caminho e sempre o mesmo: resolve a metodologia -> coleta os indicadores
 * crus -> normaliza cada um contra a faixa declarada -> calcula a nota do
 * criterio -> compoe o score. Cada etapa guarda o que usou, para a tela poder
 * mostrar a conta inteira (secao 27) em vez de um numero solto.
 */
import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { conflito, naoEncontrado, regraNegocio } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import { hojeLocal, paraDataCalendario } from '../../core/datas.js';
import type { z } from 'zod';
import type {
  avaliarSchema, cancelarAvaliacaoSchema, comparativoSchema, listarAvaliacoesSchema,
  periodoSchema, validarAvaliacaoSchema,
} from './avaliacao.schemas.js';
import {
  avaliarCriterio, avaliarIndicador, calcularScore,
  type CriterioAvaliado, type Grupo, type IndicadorAvaliado, type Score,
} from './calculos.js';
import * as coleta from './coleta.service.js';
import * as metodologias from './metodologia.service.js';

type Cliente = { query: (t: string, v?: unknown[]) => Promise<{ rows: any[] }> };

const num = (v: unknown) => Number(v ?? 0);
const dataIso = (v: unknown) => paraDataCalendario(v);

export async function configuracoes(): Promise<Record<string, string>> {
  const { rows } = await query<{ chave: string; valor: string }>(
    "SELECT chave, valor FROM configuracoes WHERE grupo = 'avaliacao'");
  return Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
}

export const numeroConfig = (cfg: Record<string, string>, chave: string, padrao: number) => {
  const v = Number(cfg[chave]);
  return Number.isFinite(v) ? v : padrao;
};

// ---------------------------------------------------------------------------
// Periodo (secao 7)
// ---------------------------------------------------------------------------

const DIAS_POR_ROTULO: Record<string, number> = {
  ULTIMOS_30: 30, ULTIMOS_60: 60, ULTIMOS_90: 90,
  ULTIMOS_180: 180, ULTIMOS_365: 365,
};

/**
 * Resolve o periodo a partir do atalho, dos dias ou do intervalo informado.
 *
 * O rotulo e guardado junto com a avaliacao: dois anos depois, "ultimos 90
 * dias" precisa continuar querendo dizer aquelas datas, nao os 90 dias de
 * quem esta lendo.
 */
export function resolverPeriodo(filtro: z.output<typeof periodoSchema>): coleta.Periodo {
  const hoje = hojeLocal();
  const ano = Number(hoje.slice(0, 4));

  if (filtro.periodo === 'ANO_ATUAL') {
    return { inicio: `${ano}-01-01`, fim: hoje, dias: 365, rotulo: 'ANO_ATUAL' };
  }
  if (filtro.periodo === 'ANO_ANTERIOR') {
    return {
      inicio: `${ano - 1}-01-01`, fim: `${ano - 1}-12-31`, dias: 365,
      rotulo: 'ANO_ANTERIOR',
    };
  }
  if (filtro.data_inicio && filtro.data_fim) {
    const dias = Math.max(1, Math.round(
      (Date.parse(`${filtro.data_fim}T00:00:00Z`)
        - Date.parse(`${filtro.data_inicio}T00:00:00Z`)) / 86400000));
    return {
      inicio: filtro.data_inicio, fim: filtro.data_fim, dias,
      rotulo: filtro.periodo ?? 'PERSONALIZADO',
    };
  }

  const dias = filtro.dias ?? DIAS_POR_ROTULO[filtro.periodo ?? 'ULTIMOS_90'] ?? 90;
  const fim = filtro.data_fim ?? hoje;
  const inicio = dataIso(new Date(Date.parse(`${fim}T00:00:00Z`) - dias * 86400000))!;
  return { inicio, fim, dias, rotulo: filtro.periodo ?? `ULTIMOS_${dias}` };
}

// ---------------------------------------------------------------------------
// Calculo (sem gravar)
// ---------------------------------------------------------------------------

export interface ResultadoAvaliacao {
  fornecedor_id: number;
  fornecedor: string;
  periodo: coleta.Periodo;
  recorte: coleta.Recorte;
  metodologia: { id: number; versao: string; nome: string; escopo: string };
  score: Score;
  volume: { pedidos: number; valor: number; quantidade: number };
  indicadores: IndicadorAvaliado[];
  /** A tabela da secao 27: criterio, nota, peso e contribuicao. */
  memoria: Array<{
    criterio: string;
    grupo: Grupo;
    nota: number | null;
    peso: number;
    contribuicao: number | null;
    calculavel: boolean;
    motivo?: string;
  }>;
}

/**
 * Calcula a avaliacao de um fornecedor num periodo. Nao grava nada.
 *
 * Indicador coletado que a metodologia nao declara fica de fora da nota, mas
 * volta na resposta: e informacao util para quem esta analisando, e escondê-la
 * so porque nao vale ponto seria empobrecer a tela.
 */
export async function calcular(
  fornecedorId: number, filtro: z.output<typeof avaliarSchema>,
): Promise<ResultadoAvaliacao> {
  const { rows: fornecedor } = await query(
    'SELECT id, razao_social FROM fornecedores WHERE id = $1 AND deleted_at IS NULL',
    [fornecedorId]);
  if (!fornecedor.length) throw naoEncontrado('Fornecedor');

  const cfg = await configuracoes();
  const periodo = resolverPeriodo(filtro);
  const recorte: coleta.Recorte = {
    categoriaId: filtro.categoria_id ?? null,
    produtoId: filtro.produto_id ?? null,
    localId: filtro.local_id ?? null,
  };

  const metodologia = filtro.metodologia_id
    ? await metodologias.carregar(filtro.metodologia_id)
    : await metodologias.resolverMetodologia(fornecedorId, recorte.categoriaId ?? null, null);

  const [apurados, volume] = await Promise.all([
    coleta.coletarTudo(fornecedorId, periodo, recorte),
    coleta.volumeComprado(fornecedorId, periodo),
  ]);

  const porCodigo = new Map(apurados.map((i) => [i.codigo, i]));
  const usados = new Set<string>();
  const avaliados: IndicadorAvaliado[] = [];

  const criterios: CriterioAvaliado[] = metodologia.criterios.map((c) => {
    const indicadores: IndicadorAvaliado[] = c.indicadores.map((definicao) => {
      usados.add(definicao.codigo);
      const apurado = porCodigo.get(definicao.codigo) ?? {
        codigo: definicao.codigo,
        nome: definicao.nome,
        grupo: c.grupo,
        valor: null,
        unidade: definicao.unidade,
        eventos: 0,
        minimoEventos: definicao.minimoEventos,
        formula: 'indicador nao coletado',
        fonte: 'nao disponivel',
      };
      const avaliado = avaliarIndicador(apurado, {
        codigo: definicao.codigo,
        nome: definicao.nome,
        peso: definicao.peso,
        direcao: definicao.direcao,
        valorPior: definicao.valorPior,
        valorMelhor: definicao.valorMelhor,
        unidade: definicao.unidade,
        minimoEventos: definicao.minimoEventos,
      });
      avaliados.push(avaliado);
      return avaliado;
    });

    return avaliarCriterio({
      grupo: c.grupo,
      nome: c.nome,
      peso: c.peso,
      minimoEventos: c.minimoEventos,
      indicadores,
    });
  });

  // Indicadores coletados fora da metodologia: informativos, peso zero.
  for (const a of apurados) {
    if (usados.has(a.codigo)) continue;
    avaliados.push({
      ...a,
      nota: null,
      peso: 0,
      direcao: 'MAIOR_MELHOR',
      calculavel: false,
      motivo: 'Informativo: nao faz parte da metodologia vigente',
      formulaNota: 'nao pontua',
    });
  }

  const score = calcularScore(criterios, {
    parcialPercentual: numeroConfig(cfg, 'avaliacao.completude_parcial_percentual', 50),
    insuficientePercentual:
      numeroConfig(cfg, 'avaliacao.completude_insuficiente_percentual', 30),
  }, {
    altaEventos: numeroConfig(cfg, 'avaliacao.confiabilidade_alta_eventos', 20),
    mediaEventos: numeroConfig(cfg, 'avaliacao.confiabilidade_media_eventos', 8),
  });

  return {
    fornecedor_id: fornecedorId,
    fornecedor: fornecedor[0].razao_social,
    periodo,
    recorte,
    metodologia: {
      id: metodologia.id,
      versao: metodologia.versao,
      nome: metodologia.nome,
      escopo: metodologia.escopo,
    },
    score,
    volume,
    indicadores: avaliados,
    memoria: criterios.map((c) => ({
      criterio: c.nome,
      grupo: c.grupo,
      nota: c.nota,
      peso: c.peso,
      contribuicao: c.contribuicao,
      calculavel: c.calculavel,
      motivo: c.motivo,
    })),
  };
}

// ---------------------------------------------------------------------------
// Gravacao
// ---------------------------------------------------------------------------

async function proximoNumero(cliente: Cliente, prefixo: string) {
  const ano = hojeLocal().slice(0, 4);
  const { rows } = await cliente.query(`
    SELECT coalesce(max(nullif(regexp_replace(numero, '^.*-', ''), '')::bigint), 0) + 1 AS proximo
      FROM avaliacoes_fornecedores WHERE numero LIKE $1`, [`${prefixo}-${ano}-%`]);
  return `${prefixo}-${ano}-${String(rows[0].proximo).padStart(6, '0')}`;
}

/**
 * Calcula e grava a avaliacao.
 *
 * Score nulo tambem e gravado: uma avaliacao que concluiu "dados
 * insuficientes" e um resultado legitimo, e registra que se olhou aquele
 * fornecedor naquele periodo (secao 28).
 */
export async function avaliar(
  fornecedorId: number, entrada: z.output<typeof avaliarSchema>, contexto: ContextoSessao,
) {
  const resultado = await calcular(fornecedorId, entrada);
  if (!entrada.gravar) return { ...resultado, gravado: false };

  const cfg = await configuracoes();
  const prefixo = cfg['avaliacao.prefixo_numero'] ?? 'AVF';

  return comTransacao(contexto, async (cliente) => {
    const numero = await proximoNumero(cliente, prefixo);
    const s = resultado.score;

    // As colunas antigas do modulo 02 continuam preenchidas por
    // compatibilidade: quem ja lia `otif` ou `qualidade` na tabela nao quebra.
    const nota = (grupo: Grupo) =>
      resultado.memoria.find((m) => m.grupo === grupo)?.nota ?? null;

    const { rows } = await cliente.query(`
      INSERT INTO avaliacoes_fornecedores
        (fornecedor_id, periodo_inicio, periodo_fim, otif, qualidade, lead_time, preco,
         atendimento, flexibilidade, score_final, ocorrencias, observacoes,
         calculado_em, responsavel_id, metodologia_id, metodologia_versao, numero,
         rotulo_periodo, frequencia, extraordinaria, status, completude, confiabilidade,
         eventos_avaliados, criterios_calculados, criterios_totais, peso_aplicado,
         categoria_id, local_id, valor_comprado)
      VALUES ($1,$2::date,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13,$14,$15,$16,
              $17,$18::frequencia_avaliacao_enum,$19,'CALCULADA'::status_avaliacao_enum,
              $20::completude_avaliacao_enum,$21::confiabilidade_avaliacao_enum,
              $22,$23,$24,$25,$26,$27,$28)
      RETURNING *`,
      [fornecedorId, resultado.periodo.inicio, resultado.periodo.fim,
        nota('LOGISTICA'), nota('QUALIDADE'), null, nota('PRECO'),
        nota('ATENDIMENTO'), nota('FLEXIBILIDADE'), s.score,
        s.eventos, entrada.observacoes ?? null, contexto.usuarioId ?? null,
        resultado.metodologia.id, resultado.metodologia.versao, numero,
        resultado.periodo.rotulo ?? null,
        entrada.frequencia ?? null, entrada.extraordinaria,
        s.completude, s.confiabilidade, s.eventos, s.criteriosCalculados,
        s.criteriosTotais, s.pesoCalculado,
        entrada.categoria_id ?? null, entrada.local_id ?? null, resultado.volume.valor]);

    const avaliacaoId = Number(rows[0].id);
    const idPorGrupo = new Map<string, number>();

    let ordem = 0;
    for (const m of resultado.memoria) {
      ordem += 1;
      const { rows: criterio } = await cliente.query(`
        INSERT INTO avaliacao_criterios
          (avaliacao_id, grupo, nome, nota, peso_percentual, contribuicao,
           calculavel, motivo, eventos, minimo_eventos, ordem)
        VALUES ($1,$2::grupo_criterio_enum,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING id`,
        [avaliacaoId, m.grupo, m.criterio, m.nota, m.peso, m.contribuicao,
          m.calculavel, m.motivo ?? null,
          s.criterios.find((c) => c.grupo === m.grupo)?.eventos ?? 0,
          s.criterios.find((c) => c.grupo === m.grupo)?.minimoEventos ?? 1, ordem]);
      idPorGrupo.set(m.grupo, Number(criterio[0].id));
    }

    for (const i of resultado.indicadores) {
      await cliente.query(`
        INSERT INTO avaliacao_indicadores
          (avaliacao_id, avaliacao_criterio_id, grupo, codigo, nome, valor, unidade,
           nota, peso_percentual, direcao, eventos, minimo_eventos, calculavel,
           motivo, formula, fonte)
        VALUES ($1,$2,$3::grupo_criterio_enum,$4,$5,$6,$7,$8,$9,
                $10::direcao_criterio_enum,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (avaliacao_id, codigo) DO NOTHING`,
        [avaliacaoId, idPorGrupo.get(i.grupo) ?? null, i.grupo, i.codigo, i.nome,
          i.valor, i.unidade, i.nota, i.peso, i.direcao, i.eventos, i.minimoEventos,
          i.calculavel, i.motivo ?? null, `${i.formula} | nota: ${i.formulaNota}`,
          i.fonte]);
    }

    const buscar = (codigo: string) =>
      resultado.indicadores.find((i) => i.codigo === codigo)?.valor ?? null;

    await cliente.query(`
      INSERT INTO historico_score_fornecedor
        (fornecedor_id, avaliacao_id, periodo_inicio, periodo_fim, score, otif, otd,
         in_full, qualidade, nao_conformidades, lead_time_real, variacao_preco, completude)
      VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,
              $13::completude_avaliacao_enum)`,
      [fornecedorId, avaliacaoId, resultado.periodo.inicio, resultado.periodo.fim,
        s.score, buscar('OTIF'), buscar('OTD'), buscar('IN_FULL'),
        nota('QUALIDADE'), Math.round(num(buscar('TAXA_NC'))),
        buscar('DESVIO_LEAD_TIME'), buscar('VARIACAO_PRECO'), s.completude]);

    // O cadastro guarda o ultimo score para a lista de fornecedores. Isso NAO
    // altera o status de homologacao: regra 9 da secao 67.
    await cliente.query(`
      UPDATE fornecedores
         SET score_atual = $2, ultima_avaliacao_em = $3::date, updated_at = now()
       WHERE id = $1`, [fornecedorId, s.score, resultado.periodo.fim]);

    return { ...resultado, gravado: true, avaliacao: rows[0] };
  });
}

export async function validarAvaliacao(
  avaliacaoId: number, entrada: z.output<typeof validarAvaliacaoSchema>,
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM avaliacoes_fornecedores WHERE id = $1 FOR UPDATE', [avaliacaoId]);
    if (!rows.length) throw naoEncontrado('Avaliacao');
    if (rows[0].status === 'VALIDADA') throw conflito('A avaliacao ja esta validada');
    if (rows[0].status === 'CANCELADA') throw conflito('A avaliacao foi cancelada');

    const { rows: validada } = await cliente.query(`
      UPDATE avaliacoes_fornecedores
         SET status = 'VALIDADA'::status_avaliacao_enum,
             validado_por = $2, validado_em = now(),
             observacoes = coalesce($3, observacoes), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [avaliacaoId, contexto.usuarioId ?? null, entrada.observacoes ?? null]);

    return validada[0];
  });
}

export async function cancelarAvaliacao(
  avaliacaoId: number, entrada: z.output<typeof cancelarAvaliacaoSchema>,
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM avaliacoes_fornecedores WHERE id = $1 FOR UPDATE', [avaliacaoId]);
    if (!rows.length) throw naoEncontrado('Avaliacao');
    if (rows[0].status === 'CANCELADA') throw conflito('A avaliacao ja esta cancelada');

    const { rows: cancelada } = await cliente.query(`
      UPDATE avaliacoes_fornecedores
         SET status = 'CANCELADA'::status_avaliacao_enum,
             observacoes = coalesce(observacoes || ' | ', '') || $2,
             updated_at = now()
       WHERE id = $1 RETURNING *`, [avaliacaoId, `Cancelada: ${entrada.justificativa}`]);

    return cancelada[0];
  });
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export async function listarAvaliacoes(
  filtro: z.output<typeof listarAvaliacoesSchema> & Paginacao,
) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const filtrar = (sql: string, valor: unknown) => {
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  if (filtro.fornecedor_id) filtrar('a.fornecedor_id = $?', filtro.fornecedor_id);
  if (filtro.status) filtrar('a.status = $?::status_avaliacao_enum', filtro.status);
  if (filtro.completude) {
    filtrar('a.completude = $?::completude_avaliacao_enum', filtro.completude);
  }
  if (filtro.metodologia_id) filtrar('a.metodologia_id = $?', filtro.metodologia_id);
  if (filtro.data_inicio) filtrar('a.periodo_fim >= $?::date', filtro.data_inicio);
  if (filtro.data_fim) filtrar('a.periodo_inicio <= $?::date', filtro.data_fim);
  if (filtro.score_minimo !== undefined) filtrar('a.score_final >= $?', filtro.score_minimo);
  if (filtro.score_maximo !== undefined) filtrar('a.score_final <= $?', filtro.score_maximo);
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(a.numero ILIKE $${valores.length} OR f.razao_social ILIKE $${valores.length})`);
  }

  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = await query<{ total: number }>(`
    SELECT count(*)::int AS total FROM avaliacoes_fornecedores a
    JOIN fornecedores f ON f.id = a.fornecedor_id ${onde}`, valores);

  const { rows } = await query(`
    SELECT a.id, a.numero, a.fornecedor_id, f.razao_social AS fornecedor,
           a.periodo_inicio, a.periodo_fim, a.rotulo_periodo, a.score_final,
           a.status, a.completude, a.confiabilidade, a.eventos_avaliados,
           a.criterios_calculados, a.criterios_totais, a.metodologia_versao,
           a.valor_comprado, a.extraordinaria, a.calculado_em,
           u.nome AS responsavel, v.nome AS validado_por_nome, a.validado_em
      FROM avaliacoes_fornecedores a
      JOIN fornecedores f ON f.id = a.fornecedor_id
      LEFT JOIN usuarios u ON u.id = a.responsavel_id
      LEFT JOIN usuarios v ON v.id = a.validado_por
      ${onde}
     ORDER BY a.periodo_fim DESC, a.id DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return {
    dados: rows.map((a: Record<string, any>) => ({
      ...a,
      periodo_inicio: dataIso(a.periodo_inicio),
      periodo_fim: dataIso(a.periodo_fim),
    })),
    meta: metaPaginacao(Number(total.rows[0]?.total ?? 0), filtro),
  };
}

/** Detalhe com a tabela da secao 27 e os indicadores que a sustentam. */
export async function detalharAvaliacao(avaliacaoId: number) {
  const { rows } = await query(`
    SELECT a.*, f.razao_social AS fornecedor, f.cnpj, f.status_homologacao,
           u.nome AS responsavel, v.nome AS validado_por_nome,
           m.nome AS metodologia_nome, m.escopo AS metodologia_escopo
      FROM avaliacoes_fornecedores a
      JOIN fornecedores f ON f.id = a.fornecedor_id
      LEFT JOIN usuarios u ON u.id = a.responsavel_id
      LEFT JOIN usuarios v ON v.id = a.validado_por
      LEFT JOIN metodologias_avaliacao m ON m.id = a.metodologia_id
     WHERE a.id = $1`, [avaliacaoId]);
  if (!rows.length) throw naoEncontrado('Avaliacao');

  const [criterios, indicadores, planos] = await Promise.all([
    query('SELECT * FROM avaliacao_criterios WHERE avaliacao_id = $1 ORDER BY ordem, id',
      [avaliacaoId]),
    query('SELECT * FROM avaliacao_indicadores WHERE avaliacao_id = $1 ORDER BY grupo, codigo',
      [avaliacaoId]),
    query(`
      SELECT id, numero, problema, status, severidade, prazo
        FROM planos_acao_fornecedor WHERE avaliacao_id = $1 ORDER BY created_at DESC`,
      [avaliacaoId]),
  ]);

  const a: Record<string, any> = rows[0];

  return {
    ...a,
    periodo_inicio: dataIso(a.periodo_inicio),
    periodo_fim: dataIso(a.periodo_fim),
    criterios: criterios.rows,
    indicadores: indicadores.rows,
    planos_acao: planos.rows,
    // A soma explicita, do jeito que a secao 27 pede: nunca so o total.
    memoria_do_score: {
      linhas: criterios.rows.map((c: Record<string, any>) => ({
        criterio: c.nome,
        grupo: c.grupo,
        nota: c.nota === null ? null : num(c.nota),
        peso: num(c.peso_percentual),
        contribuicao: c.contribuicao === null ? null : num(c.contribuicao),
        calculavel: c.calculavel,
        motivo: c.motivo,
      })),
      peso_calculado: num(a.peso_aplicado),
      score: a.score_final === null ? null : num(a.score_final),
      formula: num(a.peso_aplicado) === 100
        ? 'score = soma das contribuicoes (nota x peso / 100)'
        : `score = soma das contribuicoes / ${num(a.peso_aplicado)}% x 100`,
    },
  };
}

// ---------------------------------------------------------------------------
// Evolucao e comparativo (secoes 30 e 31)
// ---------------------------------------------------------------------------

export async function evolucao(fornecedorId: number, limite = 12) {
  const { rows } = await query(`
    SELECT h.*, a.numero, a.metodologia_versao, a.status
      FROM historico_score_fornecedor h
      LEFT JOIN avaliacoes_fornecedores a ON a.id = h.avaliacao_id
     WHERE h.fornecedor_id = $1
     ORDER BY h.periodo_fim DESC
     LIMIT $2`, [fornecedorId, limite]);

  const serie = rows.reverse().map((r: Record<string, any>) => ({
    ...r,
    periodo_inicio: dataIso(r.periodo_inicio),
    periodo_fim: dataIso(r.periodo_fim),
  }));

  return { fornecedor_id: fornecedorId, pontos: serie.length, serie };
}

/**
 * Compara fornecedores nos MESMOS criterios e no MESMO periodo (secao 31).
 *
 * Nao elege um vencedor: devolve os numeros lado a lado com a completude de
 * cada um, porque comparar um fornecedor com 40 entregas contra outro com 2
 * exige que quem le saiba disso.
 */
export async function comparativo(filtro: z.output<typeof comparativoSchema>) {
  const ids = Array.isArray(filtro.fornecedores) ? filtro.fornecedores : [];
  if (ids.length < 2) {
    throw regraNegocio('Informe ao menos dois fornecedores para comparar');
  }

  const periodo = resolverPeriodo(filtro);
  const linhas = await Promise.all(ids.map(async (id) => {
    const r = await calcular(id, {
      ...filtro, gravar: false, extraordinaria: false,
    } as z.output<typeof avaliarSchema>);
    return {
      fornecedor_id: r.fornecedor_id,
      fornecedor: r.fornecedor,
      score: r.score.score,
      completude: r.score.completude,
      confiabilidade: r.score.confiabilidade,
      eventos: r.score.eventos,
      volume: r.volume,
      criterios: Object.fromEntries(r.memoria.map((m) => [m.grupo, m.nota])),
      indicadores: Object.fromEntries(
        r.indicadores.filter((i) => i.peso > 0).map((i) => [i.codigo, i.valor])),
    };
  }));

  return {
    periodo,
    base: 'mesma metodologia, mesmo periodo e mesmos criterios para todos',
    fornecedores: linhas,
    observacao: 'Fornecedores com completude diferente nao sao diretamente comparaveis:'
      + ' confira a coluna de eventos antes de concluir',
  };
}
