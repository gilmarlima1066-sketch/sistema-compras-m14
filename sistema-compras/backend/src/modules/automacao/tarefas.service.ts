/**
 * Tarefas operacionais (secoes 17, 18, 19 e 20).
 *
 * A tarefa e o que transforma um alerta em trabalho. Um alerta diz "ha um
 * problema"; a tarefa diz "e sua, o prazo e esse, a acao sugerida e essa". Sem
 * ela o sistema produz consciencia sem producao - o gerente sabe de vinte
 * rupturas e nenhuma tem dono.
 *
 * Duas garantias sustentam isso:
 *
 * - `chave_dedup` vale so enquanto a tarefa esta ABERTA (indice parcial). Assim
 *   reexecutar o detector nao cria a segunda tarefa da mesma ruptura, mas se a
 *   ruptura voltar depois de resolvida a tarefa nasce de novo - como deve.
 *
 * - A tarefa nasce com prazo vindo da politica de SLA e escalona sozinha. Quem
 *   escalona e a varredura, nao uma pessoa lembrando de cobrar.
 */
import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { notificar } from './notificacoes.service.js';
import * as sla from './sla.service.js';

export type StatusTarefa = 'PENDENTE' | 'EM_ANDAMENTO' | 'CONCLUIDA' | 'CANCELADA';
export type PrioridadeTarefa = 'CRITICA' | 'ALTA' | 'MEDIA' | 'BAIXA';

const ABERTAS: StatusTarefa[] = ['PENDENTE', 'EM_ANDAMENTO'];

export interface EntradaTarefa {
  /** Codigo da etapa; quando coincide com uma politica de SLA, herda o prazo. */
  tipo: string;
  titulo: string;
  descricao?: string | null;
  acao_sugerida?: string | null;
  responsavel_id?: number | null;
  perfil_destino?: string | null;
  prioridade?: PrioridadeTarefa;
  origem: string;
  entidade?: string | null;
  entidade_id?: number | null;
  link?: string | null;
  correlation_id?: string | null;
  evento_id?: number | null;
  chave?: string | null;
  /** Politica de SLA. Por padrao usa o proprio `tipo`. */
  sla?: string | null;
  /** Prazo explicito, quando a tarefa nao segue politica. */
  sla_horas?: number | null;
}

export interface TarefaCriada {
  id: number;
  nova: boolean;
  sla_horas: number | null;
  sla_vence_em: string | null;
  notificados: number;
  motivo_sem_destino?: string;
}

/**
 * Cria a tarefa e avisa quem deve executa-la.
 *
 * `DO NOTHING` em vez de `DO UPDATE`: uma tarefa aberta pertence a alguem, pode
 * ja estar EM_ANDAMENTO com observacao escrita. Sobrescrever titulo e prazo por
 * causa de uma nova deteccao do mesmo fato apagaria trabalho humano. O fato
 * repetido e ruido; a tarefa aberta e o registro de que ele ja foi capturado.
 */
export async function criar(
  entrada: EntradaTarefa, contexto: ContextoSessao,
): Promise<TarefaCriada> {
  const politicaCodigo = entrada.sla === undefined ? entrada.tipo : entrada.sla;
  const prazo = await sla.prazoDe(politicaCodigo);

  const horas = prazo.horas ?? entrada.sla_horas ?? null;
  const venceEm = prazo.vence_em
    ?? (entrada.sla_horas ? new Date(Date.now() + entrada.sla_horas * 3_600_000) : null);

  const criada = await comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query<{ id: string; sla_vence_em: string | null }>(`
      INSERT INTO tarefas
        (tipo, titulo, descricao, acao_sugerida, responsavel_id, perfil_destino,
         prioridade, prazo, origem, entidade, entidade_id, link, correlation_id,
         evento_id, chave_dedup, sla_horas, sla_vence_em)
      VALUES ($1, $2, $3, $4, $5, $6, $7::prioridade_tarefa_enum,
              CASE WHEN $8::timestamptz IS NULL THEN NULL
                   ELSE ($8::timestamptz)::date END,
              $9, $10, $11, $12, $13::uuid, $14, $15, $16::int, $8::timestamptz)
      ON CONFLICT (chave_dedup)
        WHERE chave_dedup IS NOT NULL
          AND status = ANY (ARRAY['PENDENTE','EM_ANDAMENTO']::status_tarefa_enum[])
      DO NOTHING
      RETURNING id, sla_vence_em`,
    [entrada.tipo, entrada.titulo, entrada.descricao ?? null,
      entrada.acao_sugerida ?? null, entrada.responsavel_id ?? null,
      entrada.perfil_destino ?? null, entrada.prioridade ?? 'MEDIA',
      venceEm, entrada.origem, entrada.entidade ?? null, entrada.entidade_id ?? null,
      entrada.link ?? null, entrada.correlation_id ?? null, entrada.evento_id ?? null,
      entrada.chave ?? null, horas]);

    return rows[0] ?? null;
  });

  if (!criada) {
    // Ja existe tarefa aberta para o mesmo fato: devolve o id dela, para a
    // execucao registrar contra que tarefa o evento recaiu.
    const { rows } = await query<{ id: string; sla_horas: number | null; sla_vence_em: string | null }>(
      `SELECT id, sla_horas, sla_vence_em FROM tarefas
        WHERE chave_dedup = $1
          AND status = ANY (ARRAY['PENDENTE','EM_ANDAMENTO']::status_tarefa_enum[])
        LIMIT 1`, [entrada.chave]);
    const existente = rows[0];
    return {
      id: existente ? Number(existente.id) : 0,
      nova: false,
      sla_horas: existente?.sla_horas ?? horas,
      sla_vence_em: existente?.sla_vence_em ?? null,
      notificados: 0,
    };
  }

  const id = Number(criada.id);
  const aviso = await notificar({
    titulo: entrada.titulo,
    mensagem: entrada.acao_sugerida ?? entrada.descricao ?? null,
    tipo: 'TAREFA',
    usuario_id: entrada.responsavel_id ?? null,
    perfil: entrada.responsavel_id ? null : entrada.perfil_destino ?? null,
    link: entrada.link ?? `/tarefas?id=${id}`,
    correlation_id: entrada.correlation_id ?? null,
    chave: entrada.chave ? `tarefa:${entrada.chave}` : `tarefa:${id}`,
  }, contexto);

  return {
    id,
    nova: true,
    sla_horas: horas,
    sla_vence_em: criada.sla_vence_em,
    notificados: aviso.criadas,
    ...(aviso.motivo_sem_destino ? { motivo_sem_destino: aviso.motivo_sem_destino } : {}),
  };
}

export async function assumir(id: number, usuarioId: number): Promise<void> {
  const { rowCount } = await query(`
    UPDATE tarefas
       SET status = 'EM_ANDAMENTO', responsavel_id = $2
     WHERE id = $1 AND status = 'PENDENTE'`, [id, usuarioId]);
  if (!rowCount) throw regraNegocio('Tarefa nao esta pendente ou nao existe');
}

/**
 * Conclui a tarefa e fecha o SLA.
 *
 * O status de SLA final e CUMPRIDO ou VENCIDO conforme o prazo real, nao
 * conforme o que estava marcado: uma tarefa concluida depois do prazo fica
 * registrada como vencida mesmo que a varredura ainda nao tivesse passado nela.
 */
export async function concluir(
  id: number, usuarioId: number, observacao?: string | null,
): Promise<{ id: number; sla_status: string; horas: number | null }> {
  const { rows } = await query<{ sla_status: string; horas: string | null }>(`
    UPDATE tarefas
       SET status = 'CONCLUIDA', concluida_em = now(), concluida_por = $2,
           observacao = coalesce($3, observacao),
           sla_status = CASE
             WHEN sla_vence_em IS NULL      THEN 'CUMPRIDO'
             WHEN now() <= sla_vence_em     THEN 'CUMPRIDO'
             ELSE 'VENCIDO' END::status_sla_enum
     WHERE id = $1
       AND status = ANY (ARRAY['PENDENTE','EM_ANDAMENTO']::status_tarefa_enum[])
     RETURNING sla_status::text AS sla_status,
               round(EXTRACT(EPOCH FROM (now() - created_at)) / 3600, 1)::text AS horas`,
  [id, usuarioId, observacao ?? null]);

  const linha = rows[0];
  if (!linha) throw regraNegocio('Tarefa nao esta aberta ou nao existe');
  return { id, sla_status: linha.sla_status, horas: linha.horas === null ? null : Number(linha.horas) };
}

export async function cancelar(
  id: number, usuarioId: number, motivo: string,
): Promise<void> {
  if (!motivo?.trim()) throw regraNegocio('Cancelamento de tarefa exige motivo');
  const { rowCount } = await query(`
    UPDATE tarefas
       SET status = 'CANCELADA', concluida_em = now(), concluida_por = $2,
           observacao = $3
     WHERE id = $1
       AND status = ANY (ARRAY['PENDENTE','EM_ANDAMENTO']::status_tarefa_enum[])`,
  [id, usuarioId, motivo.trim()]);
  if (!rowCount) throw regraNegocio('Tarefa nao esta aberta ou nao existe');
}

export async function reatribuir(
  id: number, responsavelId: number | null, perfilDestino: string | null,
): Promise<void> {
  if (!responsavelId && !perfilDestino) {
    throw regraNegocio('Informe o responsavel ou o perfil de destino');
  }
  const { rowCount } = await query(`
    UPDATE tarefas
       SET responsavel_id = $2, perfil_destino = coalesce($3, perfil_destino)
     WHERE id = $1
       AND status = ANY (ARRAY['PENDENTE','EM_ANDAMENTO']::status_tarefa_enum[])`,
  [id, responsavelId, perfilDestino]);
  if (!rowCount) throw regraNegocio('Tarefa nao esta aberta ou nao existe');
}

// ---------------------------------------------------------------------------
// SLA e escalonamento (secoes 19 e 20)
// ---------------------------------------------------------------------------

export interface ResultadoVarreduraSla {
  avaliadas: number;
  em_risco: number;
  vencidas: number;
  escalonadas: number;
  notificacoes: number;
  detalhes: Array<{
    tarefa_id: number; tipo: string; status_sla: string;
    nivel_anterior: number; nivel_novo: number; perfil_alvo: string | null;
  }>;
}

/**
 * Varre as tarefas abertas, atualiza o status de SLA e escalona as vencidas.
 *
 * Roda como job. Idempotente por construcao: so escreve quando o nivel devido e
 * MAIOR que o registrado, e a notificacao de escalonamento carrega o nivel na
 * chave de deduplicacao. Rodar tres vezes na mesma hora nao gera tres cobrancas.
 */
export async function varrerSla(contexto: ContextoSessao): Promise<ResultadoVarreduraSla> {
  const { rows } = await query<{
    id: string; tipo: string; titulo: string; nivel_escalonamento: number;
    sla_status: string; created_at: Date; sla_vence_em: Date | null;
    responsavel_id: string | null; perfil_destino: string | null;
    correlation_id: string | null; link: string | null;
  }>(`
    SELECT id, tipo, titulo, nivel_escalonamento, sla_status::text AS sla_status,
           created_at, sla_vence_em, responsavel_id, perfil_destino,
           correlation_id::text AS correlation_id, link
      FROM tarefas
     WHERE status = ANY (ARRAY['PENDENTE','EM_ANDAMENTO']::status_tarefa_enum[])
       AND sla_vence_em IS NOT NULL
     ORDER BY sla_vence_em
     LIMIT 1000`);

  const resultado: ResultadoVarreduraSla = {
    avaliadas: rows.length, em_risco: 0, vencidas: 0, escalonadas: 0,
    notificacoes: 0, detalhes: [],
  };

  const agora = new Date();

  for (const t of rows) {
    const politica = await sla.politica(t.tipo);
    const percentualAlerta = politica?.alerta_percentual ?? 80;
    const criadoEm = new Date(t.created_at);
    const venceEm = new Date(t.sla_vence_em!);

    const { status } = sla.situacao(criadoEm, venceEm, percentualAlerta, agora);
    if (status === 'EM_RISCO') resultado.em_risco += 1;
    if (status === 'VENCIDO') resultado.vencidas += 1;

    const horasDecorridas = (agora.getTime() - criadoEm.getTime()) / 3_600_000;
    const nivelDevido = politica ? sla.nivelDevido(politica, horasDecorridas) : 0;
    const nivelNovo = Math.max(t.nivel_escalonamento, nivelDevido);
    const subiu = nivelNovo > t.nivel_escalonamento;

    if (status !== t.sla_status || subiu) {
      await query(`
        UPDATE tarefas
           SET sla_status = $2::status_sla_enum,
               nivel_escalonamento = $3,
               escalonado_em = CASE WHEN $4 THEN now() ELSE escalonado_em END
         WHERE id = $1`, [Number(t.id), status, nivelNovo, subiu]);
    }

    if (!subiu) continue;

    resultado.escalonadas += 1;
    const perfilAlvo = politica ? sla.perfilDoNivel(politica, nivelNovo) : null;
    resultado.detalhes.push({
      tarefa_id: Number(t.id), tipo: t.tipo, status_sla: status,
      nivel_anterior: t.nivel_escalonamento, nivel_novo: nivelNovo,
      perfil_alvo: perfilAlvo,
    });

    const aviso = await notificar({
      titulo: `SLA vencido (nivel ${nivelNovo}): ${t.titulo}`,
      mensagem: `Tarefa aberta ha ${Math.round(horasDecorridas)}h sem conclusao. `
        + `Politica ${t.tipo}, prazo de ${politica?.horas ?? '?'}h.`,
      tipo: 'SLA_ESCALONAMENTO',
      perfil: perfilAlvo,
      link: t.link ?? `/tarefas?id=${t.id}`,
      correlation_id: t.correlation_id,
      chave: `escalonamento:${t.id}:n${nivelNovo}`,
    }, contexto);
    resultado.notificacoes += aviso.criadas;
  }

  return resultado;
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export interface FiltroTarefas {
  status?: string;
  tipo?: string;
  prioridade?: string;
  responsavel_id?: number;
  perfil_destino?: string;
  sla_status?: string;
  abertas?: boolean;
  correlation_id?: string;
  limite?: number;
  pagina?: number;
}

export async function listar(filtro: FiltroTarefas) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const add = (sql: string, valor: unknown) => {
    if (valor === undefined || valor === null || valor === '') return;
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  add('t.status = $?::status_tarefa_enum', filtro.status);
  add('t.tipo = $?', filtro.tipo);
  add('t.prioridade = $?::prioridade_tarefa_enum', filtro.prioridade);
  add('t.responsavel_id = $?', filtro.responsavel_id);
  add('upper(t.perfil_destino) = upper($?)', filtro.perfil_destino);
  add('t.sla_status = $?::status_sla_enum', filtro.sla_status);
  add('t.correlation_id = $?::uuid', filtro.correlation_id);
  if (filtro.abertas) {
    cond.push("t.status = ANY (ARRAY['PENDENTE','EM_ANDAMENTO']::status_tarefa_enum[])");
  }

  const limite = Math.min(Math.max(filtro.limite ?? 50, 1), 200);
  const pagina = Math.max(filtro.pagina ?? 1, 1);
  valores.push(limite, (pagina - 1) * limite);

  const { rows } = await query(`
    SELECT t.id, t.tipo, t.titulo, t.descricao, t.acao_sugerida,
           t.prioridade::text AS prioridade, t.status::text AS status,
           t.prazo, t.sla_horas, t.sla_vence_em, t.sla_status::text AS sla_status,
           t.nivel_escalonamento, t.escalonado_em, t.origem, t.entidade,
           t.entidade_id, t.link, t.correlation_id::text AS correlation_id,
           t.perfil_destino, t.observacao, t.created_at, t.concluida_em,
           r.nome AS responsavel, c.nome AS concluida_por_nome,
           CASE WHEN t.sla_vence_em IS NULL THEN NULL
                ELSE round(EXTRACT(EPOCH FROM (t.sla_vence_em - now())) / 3600, 1)
           END AS horas_restantes,
           count(*) OVER () AS total
      FROM tarefas t
      LEFT JOIN usuarios r ON r.id = t.responsavel_id
      LEFT JOIN usuarios c ON c.id = t.concluida_por
     ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
     ORDER BY CASE t.prioridade
                WHEN 'CRITICA' THEN 1 WHEN 'ALTA' THEN 2
                WHEN 'MEDIA' THEN 3 ELSE 4 END,
              t.sla_vence_em NULLS LAST, t.id DESC
     LIMIT $${valores.length - 1} OFFSET $${valores.length}`, valores);

  return {
    total: rows.length ? Number((rows[0] as { total: string }).total) : 0,
    pagina,
    limite,
    tarefas: rows.map((r) => {
      const { total: _t, horas_restantes: h, ...resto } = r as Record<string, unknown>;
      return { ...resto, horas_restantes: h === null ? null : Number(h) };
    }),
  };
}

export async function obter(id: number) {
  const { rows } = await query(`
    SELECT t.*, t.status::text AS status, t.prioridade::text AS prioridade,
           t.sla_status::text AS sla_status,
           t.correlation_id::text AS correlation_id,
           r.nome AS responsavel, c.nome AS concluida_por_nome
      FROM tarefas t
      LEFT JOIN usuarios r ON r.id = t.responsavel_id
      LEFT JOIN usuarios c ON c.id = t.concluida_por
     WHERE t.id = $1`, [id]);
  if (!rows.length) throw naoEncontrado('Tarefa');
  return rows[0];
}

/** Painel de tarefas: fila por prioridade, SLA e escalonamento (secao 18). */
export async function resumo() {
  const [porStatus, porPrioridade, porSla, porTipo] = await Promise.all([
    query(`SELECT status::text AS chave, count(*) AS total FROM tarefas
            GROUP BY status ORDER BY 1`),
    query(`SELECT prioridade::text AS chave, count(*) AS total FROM tarefas
            WHERE status = ANY (ARRAY['PENDENTE','EM_ANDAMENTO']::status_tarefa_enum[])
            GROUP BY prioridade`),
    query(`SELECT sla_status::text AS chave, count(*) AS total FROM tarefas
            WHERE status = ANY (ARRAY['PENDENTE','EM_ANDAMENTO']::status_tarefa_enum[])
            GROUP BY sla_status`),
    query(`SELECT tipo AS chave, count(*) AS total FROM tarefas
            WHERE status = ANY (ARRAY['PENDENTE','EM_ANDAMENTO']::status_tarefa_enum[])
            GROUP BY tipo ORDER BY 2 DESC LIMIT 10`),
  ]);

  const mapear = (rows: Record<string, unknown>[]) =>
    rows.map((r) => ({ chave: String(r.chave), total: Number(r.total) }));

  const { rows: escal } = await query<{ nivel: number; total: string }>(`
    SELECT nivel_escalonamento AS nivel, count(*) AS total
      FROM tarefas
     WHERE status = ANY (ARRAY['PENDENTE','EM_ANDAMENTO']::status_tarefa_enum[])
     GROUP BY nivel_escalonamento ORDER BY 1`);

  return {
    por_status: mapear(porStatus.rows),
    por_prioridade: mapear(porPrioridade.rows),
    por_sla: mapear(porSla.rows),
    por_tipo: mapear(porTipo.rows),
    por_escalonamento: escal.map((r) => ({ nivel: r.nivel, total: Number(r.total) })),
    abertas: mapear(porStatus.rows)
      .filter((s) => ABERTAS.includes(s.chave as StatusTarefa))
      .reduce((a, s) => a + s.total, 0),
  };
}
