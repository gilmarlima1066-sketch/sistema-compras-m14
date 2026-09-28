/**
 * Agendador de jobs (secoes 29, 30, 31 e 43).
 *
 * O agendador vive no PostgreSQL, nao em cron do sistema operacional. Isso
 * resolve tres coisas de uma vez: a proxima execucao e um dado consultavel (o
 * gerente ve na tela quando o job roda), o historico de execucoes fica ao lado
 * do resto da auditoria, e a trava de concorrencia usa a mesma transacao que
 * marca o job como executando.
 *
 * A trava importa de verdade. Dois processos da aplicacao no ar - um deploy
 * novo subindo enquanto o antigo ainda responde - rodariam o mesmo job ao mesmo
 * tempo. `reservar` usa UPDATE condicional: quem conseguir mudar a linha de
 * OCIOSO para EXECUTANDO ganha, o outro simplesmente nao recebe linha. Nao ha
 * janela entre verificar e marcar, porque e um unico comando.
 *
 * `executando_desde` e `instancia` existem para o caso feio: o processo morreu
 * no meio e o job ficou EXECUTANDO para sempre. `liberarOrfaos` devolve ao
 * estado ocioso o que passou do timeout - e registra a execucao como ERRO, para
 * a falha aparecer em vez de o job simplesmente parar de rodar em silencio.
 */
import { query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import * as aprovacoes from './aprovacoes.service.js';
import { ligado, numero } from './config.js';
import * as detectores from './detectores.service.js';
import * as fila from './fila.service.js';
import * as motor from './motor.service.js';
import * as notificacoes from './notificacoes.service.js';
import * as sla from './sla.service.js';
import * as tarefas from './tarefas.service.js';

export type Frequencia = 'MINUTO' | 'HORA' | 'DIARIO' | 'SEMANAL' | 'MENSAL' | 'MANUAL';
export type StatusJob = 'OCIOSO' | 'EXECUTANDO' | 'ERRO' | 'DESATIVADO';

/** Identidade deste processo, para saber quem travou um job pendurado. */
const INSTANCIA = `${process.pid}@${new Date().toISOString()}`;

export interface ResultadoJob {
  codigo: string;
  status: 'CONCLUIDO' | 'ERRO' | 'IGNORADO';
  duracao_ms: number;
  eventos_gerados: number;
  resultado: Record<string, unknown>;
  erro?: string;
}

// ---------------------------------------------------------------------------
// O que cada job faz
// ---------------------------------------------------------------------------

/**
 * Rotinas nomeadas pelo codigo do job.
 *
 * Nenhuma delas recalcula nada: cada uma chama o motor que ja existe. O job e
 * so o gatilho de tempo - se ele tambem tivesse regra, haveria duas versoes da
 * mesma regra, uma para quando um humano pede e outra para quando o relogio
 * pede, e elas divergiriam.
 */
const ROTINAS: Record<string, (c: ContextoSessao) => Promise<{
  eventos: number; resultado: Record<string, unknown>;
}>> = {
  /** De hora em hora: o que nao pode esperar o dia seguinte. */
  DETECTAR_EVENTOS: async (c) => {
    const d = await detectores.rodarGrupo(detectores.GRUPO_CRITICO, c);
    const ciclo = await motor.ciclo(c);
    return {
      eventos: d.novos,
      resultado: {
        detectores: d.resultados, erros_detector: d.erros,
        eventos_processados: ciclo.eventos.eventos_lidos,
        acoes_executadas: ciclo.fila.concluidos,
        acoes_com_falha: ciclo.fila.falhas,
      },
    };
  },

  PROCESSAR_FILA: async (c) => {
    const lote = await numero('worker_lote', 10);
    const executado = await motor.processarFila(lote, c);
    const travados = await fila.liberarTravados(
      await numero('fila_timeout_travado_segundos', 300));

    return {
      eventos: 0,
      resultado: {
        reservados: executado.reservados, concluidos: executado.concluidos,
        falhas: executado.falhas, reagendados: executado.reagendados,
        fila_morta: executado.fila_morta, travados_liberados: travados.liberados,
      },
    };
  },

  VERIFICAR_SLA: async (c) => {
    const varredura = await tarefas.varrerSla(c);
    const prazos = await aprovacoes.varrerPrazos();
    return {
      eventos: 0,
      resultado: {
        tarefas_avaliadas: varredura.avaliadas,
        tarefas_em_risco: varredura.em_risco,
        tarefas_vencidas: varredura.vencidas,
        escalonadas: varredura.escalonadas,
        notificacoes: varredura.notificacoes,
        aprovacoes_em_risco: prazos.em_risco,
        aprovacoes_vencidas: prazos.vencidas,
        detalhes_escalonamento: varredura.detalhes.slice(0, 20),
      },
    };
  },

  ESTOQUE_DIARIO: async (c) => {
    const d = await detectores.rodarGrupo(detectores.GRUPO_ESTOQUE, c);
    return { eventos: d.novos, resultado: { detectores: d.resultados, erros: d.erros } };
  },

  PEDIDOS_DIARIO: async (c) => {
    const d = await detectores.rodarGrupo(detectores.GRUPO_PEDIDOS, c);
    return { eventos: d.novos, resultado: { detectores: d.resultados, erros: d.erros } };
  },

  IA_RECOMENDACOES: async (c) => {
    const d = await detectores.rodarGrupo(detectores.GRUPO_IA, c);
    return { eventos: d.novos, resultado: { detectores: d.resultados, erros: d.erros } };
  },

  FORNECEDORES_SEMANAL: async (c) => {
    const d = await detectores.rodarGrupo(detectores.GRUPO_FORNECEDORES, c);
    return { eventos: d.novos, resultado: { detectores: d.resultados, erros: d.erros } };
  },

  /** Oportunidades: excesso e monoprovedor, que sao economia e risco, nao urgencia. */
  OPORTUNIDADES_SEMANAL: async (c) => {
    const d = await detectores.rodarGrupo(['excesso', 'fornecedor_unico', 'aumento_preco'], c);
    return { eventos: d.novos, resultado: { detectores: d.resultados, erros: d.erros } };
  },

  /**
   * Mensal: cumprimento de SLA e despacho das notificacoes externas pendentes.
   *
   * Nao recalcula KPI: os KPIs do modulo 11 sao apurados sob demanda a partir
   * das visoes, nao materializados. Agendar um recalculo seria inventar trabalho
   * que a arquitetura nao pede.
   */
  KPI_MENSAL: async () => {
    const desempenho = await sla.desempenho(30);
    const despacho = await notificacoes.despachar(200);
    return { eventos: 0, resultado: { sla_por_etapa: desempenho, despacho } };
  },

  /** Expurgo, dentro do que a retencao configurada permite (secoes 43 e 44). */
  LIMPEZA: async () => {
    const dias = await numero('retencao_eventos_dias', 180);

    // A ordem e obrigatoria: a fila referencia o evento, e o historico de
    // execucao referencia os dois. O gatilho da migration 045 so libera a
    // exclusao das execucoes fora da janela de retencao, entao apagar fila e
    // evento primeiro resultaria em erro de gatilho.
    const execucoes = await query(`
      DELETE FROM automacao_execucoes
       WHERE created_at < now() - make_interval(days => $1::int)`, [dias]);

    const filaAntiga = await query(`
      DELETE FROM automacao_fila
       WHERE created_at < now() - make_interval(days => $1::int)
         AND status = ANY (ARRAY['CONCLUIDO','CANCELADO']::status_execucao_automacao_enum[])`,
    [dias]);

    const eventosAntigos = await query(`
      DELETE FROM eventos
       WHERE created_at < now() - make_interval(days => $1::int)
         AND status = 'PROCESSADO'`, [dias]);

    const webhooks = await query(`
      DELETE FROM webhooks_recebidos
       WHERE created_at < now() - make_interval(days => $1::int)`, [dias]);

    const notificacoesLidas = await query(`
      DELETE FROM notificacoes
       WHERE created_at < now() - make_interval(days => $1::int) AND lida`, [dias]);

    const execucoesJob = await query(`
      DELETE FROM job_execucoes
       WHERE iniciado_em < now() - make_interval(days => $1::int)`, [dias]);

    return {
      eventos: 0,
      resultado: {
        retencao_dias: dias,
        execucoes_removidas: execucoes.rowCount ?? 0,
        fila_removida: filaAntiga.rowCount ?? 0,
        eventos_removidos: eventosAntigos.rowCount ?? 0,
        webhooks_removidos: webhooks.rowCount ?? 0,
        notificacoes_removidas: notificacoesLidas.rowCount ?? 0,
        execucoes_job_removidas: execucoesJob.rowCount ?? 0,
      },
    };
  },
};

export const rotinaExiste = (codigo: string): boolean =>
  Object.prototype.hasOwnProperty.call(ROTINAS, codigo.toUpperCase());

export const catalogoRotinas = () => Object.keys(ROTINAS);

/**
 * Permite a outro modulo registrar a rotina dos jobs que ele cadastrou.
 *
 * Existe por uma razao concreta: o modulo 14 cadastrou quatro jobs de
 * integracao e nao tinha onde implementa-los. Deixar o agendador do modulo 13
 * importar os servicos do 14 inverteria a dependencia - o motor generico
 * passaria a conhecer um caso particular, e cada modulo novo exigiria mexer
 * nele de novo.
 *
 * Com o registro, quem cadastra o job tambem entrega a rotina, e o agendador
 * continua sem saber o que e uma integracao. E o mesmo padrao de
 * `registrarGravador`, no importador.
 *
 * A verificacao "todo job cadastrado tem rotina" da bateria do modulo 13
 * continua valendo, e foi ela que apontou a falta.
 */
export function registrarRotina(
  codigo: string,
  rotina: (c: ContextoSessao) => Promise<{
    eventos: number; resultado: Record<string, unknown>;
  }>,
): void {
  ROTINAS[codigo.toUpperCase()] = rotina;
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

/**
 * Proxima execucao de um job, em SQL.
 *
 * O calculo fica no banco porque ele conhece o fuso da sessao e sabe somar mes
 * sem os casos de borda de fim de mes. Fazer em JavaScript daria a resposta
 * certa quase sempre - e "quase sempre" em agendamento significa um job que nao
 * roda no dia 31.
 */
export async function calcularProxima(jobId: number): Promise<string | null> {
  const { rows } = await query<{ proxima: string | null }>(`
    UPDATE jobs SET proxima_execucao = CASE frequencia
      WHEN 'MINUTO'  THEN now() + make_interval(mins => coalesce(intervalo_minutos, 5))
      WHEN 'HORA'    THEN date_trunc('hour', now())
                          + make_interval(hours => 1, mins => minuto)
      WHEN 'DIARIO'  THEN (current_date + 1) + make_time(coalesce(hora, 0), minuto, 0)
      -- dia_semana 0 = domingo, como no EXTRACT(DOW)
      WHEN 'SEMANAL' THEN (current_date
                           + ((7 + coalesce(dia_semana, 1)
                               - EXTRACT(DOW FROM current_date)::int - 1) % 7 + 1))
                          + make_time(coalesce(hora, 0), minuto, 0)
      WHEN 'MENSAL'  THEN (date_trunc('month', current_date) + interval '1 month')::date
                          + make_interval(days => coalesce(dia_mes, 1) - 1)
                          + make_time(coalesce(hora, 0), minuto, 0)
      ELSE NULL END
     WHERE id = $1
     RETURNING proxima_execucao::text AS proxima`, [jobId]);
  return rows[0]?.proxima ?? null;
}

/** Jobs cuja hora chegou. Sem `proxima_execucao` conta como vencido: nunca rodou. */
export async function devidos(): Promise<Array<{ id: number; codigo: string }>> {
  const { rows } = await query<{ id: string; codigo: string }>(`
    SELECT id, codigo FROM jobs
     WHERE ativo
       AND frequencia <> 'MANUAL'
       AND status <> 'EXECUTANDO'
       AND (proxima_execucao IS NULL OR proxima_execucao <= now())
     ORDER BY coalesce(proxima_execucao, '-infinity'::timestamptz)`);
  return rows.map((r) => ({ id: Number(r.id), codigo: r.codigo }));
}

/**
 * Reserva o job para esta instancia.
 *
 * Um unico UPDATE condicional e a trava: quem mudar a linha ganha. Sem SELECT
 * antes, porque entre o SELECT e o UPDATE cabe o outro processo.
 */
async function reservar(jobId: number): Promise<boolean> {
  const { rowCount } = await query(`
    UPDATE jobs
       SET status = 'EXECUTANDO', executando_desde = now(), instancia = $2
     WHERE id = $1 AND ativo AND status <> 'EXECUTANDO'`, [jobId, INSTANCIA]);
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Execucao
// ---------------------------------------------------------------------------

export async function executar(
  codigo: string, contexto: ContextoSessao, disparadoPor = 'AGENDADOR',
): Promise<ResultadoJob> {
  const { rows } = await query<{ id: string; timeout_segundos: number; ativo: boolean }>(
    'SELECT id, timeout_segundos, ativo FROM jobs WHERE upper(codigo) = upper($1)',
    [codigo]);

  const job = rows[0];
  if (!job) throw naoEncontrado(`Job ${codigo}`);

  const rotina = ROTINAS[codigo.toUpperCase()];
  if (!rotina) {
    throw regraNegocio(
      `Job ${codigo} esta cadastrado mas nao tem rotina implementada. `
      + `Rotinas disponiveis: ${catalogoRotinas().join(', ')}`);
  }

  const jobId = Number(job.id);
  if (!await reservar(jobId)) {
    return {
      codigo, status: 'IGNORADO', duracao_ms: 0, eventos_gerados: 0,
      resultado: { motivo: 'Job ja esta executando em outra instancia ou esta inativo' },
    };
  }

  const { rows: exec } = await query<{ id: string; correlation_id: string }>(`
    INSERT INTO job_execucoes (job_id, disparado_por, usuario_id, status)
    VALUES ($1, $2, $3, 'PROCESSANDO')
    RETURNING id, correlation_id::text AS correlation_id`,
  [jobId, disparadoPor, contexto.usuarioId ?? null]);

  const execucaoId = Number(exec[0]!.id);
  const inicio = Date.now();

  try {
    const saida = await rotina(contexto);
    const duracao = Date.now() - inicio;

    await query(`
      UPDATE job_execucoes
         SET status = 'CONCLUIDO', concluido_em = now(), duracao_ms = $2,
             eventos_gerados = $3, resultado = $4::jsonb
       WHERE id = $1`,
    [execucaoId, duracao, saida.eventos, JSON.stringify(saida.resultado)]);

    await query(`
      UPDATE jobs
         SET status = 'OCIOSO', executando_desde = NULL, instancia = NULL,
             ultima_execucao = now(), execucoes = execucoes + 1, ultimo_erro = NULL
       WHERE id = $1`, [jobId]);

    await calcularProxima(jobId);

    // O estouro de timeout nao aborta o job no meio - cortar uma varredura pela
    // metade deixaria metade dos eventos detectados, o que e pior que demorar.
    // Ele e registrado para o centro de operacoes mostrar quem esta lento.
    const estourou = duracao > job.timeout_segundos * 1000;

    return {
      codigo,
      status: 'CONCLUIDO',
      duracao_ms: duracao,
      eventos_gerados: saida.eventos,
      resultado: estourou
        ? { ...saida.resultado,
          aviso_timeout: `Levou ${Math.round(duracao / 1000)}s, acima do limite `
            + `de ${job.timeout_segundos}s configurado para este job` }
        : saida.resultado,
    };
  } catch (erro) {
    const duracao = Date.now() - inicio;
    const mensagem = erro instanceof Error ? erro.message : String(erro);

    await query(`
      UPDATE job_execucoes
         SET status = 'ERRO', concluido_em = now(), duracao_ms = $2, erro = $3
       WHERE id = $1`, [execucaoId, duracao, mensagem.slice(0, 4000)]);

    await query(`
      UPDATE jobs
         SET status = 'ERRO', executando_desde = NULL, instancia = NULL,
             ultima_execucao = now(), execucoes = execucoes + 1,
             falhas = falhas + 1, ultimo_erro = $2
       WHERE id = $1`, [jobId, mensagem.slice(0, 2000)]);

    // A proxima execucao e recalculada mesmo com erro: um job que falhou hoje
    // precisa tentar amanha. Deixar sem proxima o tiraria da agenda para sempre.
    await calcularProxima(jobId);

    await notificacoes.notificarSePermitido({
      titulo: `Job ${codigo} falhou`,
      mensagem: mensagem.slice(0, 500),
      tipo: 'JOB_FALHOU',
      perfil: 'ADMIN',
      link: '/operacao',
      correlation_id: exec[0]!.correlation_id,
      chave: `job-falhou:${codigo}:${new Date().toISOString().slice(0, 13)}`,
    }, contexto);

    return {
      codigo, status: 'ERRO', duracao_ms: duracao, eventos_gerados: 0,
      resultado: {}, erro: mensagem,
    };
  }
}

/**
 * Roda todos os jobs vencidos. E o que o agendador chama a cada minuto.
 *
 * Respeita `automacao.agendador_ativo`: o interruptor existe para quem precisa
 * congelar a automacao durante uma carga de dados ou uma investigacao, sem
 * desativar os dez jobs um por um e sem arriscar esquecer de religar algum.
 */
export async function rodarDevidos(contexto: ContextoSessao): Promise<{
  ativo: boolean; executados: ResultadoJob[]; orfaos_liberados: number; motivo?: string;
}> {
  if (!await ligado('agendador_ativo', true)) {
    return {
      ativo: false, executados: [], orfaos_liberados: 0,
      motivo: 'Agendador desligado em automacao.agendador_ativo',
    };
  }

  const orfaos = await liberarOrfaos();
  const executados: ResultadoJob[] = [];

  for (const job of await devidos()) {
    executados.push(await executar(job.codigo, contexto, 'AGENDADOR'));
  }

  return { ativo: true, executados, orfaos_liberados: orfaos };
}

/**
 * Devolve ao estado ocioso jobs que ficaram travados em EXECUTANDO.
 *
 * O caso real: o processo foi reiniciado no meio de uma varredura. O job ficaria
 * EXECUTANDO para sempre e nunca mais rodaria - falhando em silencio, que e a
 * pior forma de falhar. A execucao correspondente e fechada como ERRO para a
 * interrupcao ficar visivel no historico.
 */
export async function liberarOrfaos(): Promise<number> {
  const minutos = await numero('job_timeout_orfao_minutos', 30);

  const { rows } = await query<{ id: string; codigo: string }>(`
    UPDATE jobs
       SET status = 'ERRO', executando_desde = NULL, instancia = NULL,
           falhas = falhas + 1,
           ultimo_erro = 'Execucao interrompida: processo encerrado antes de concluir'
     WHERE status = 'EXECUTANDO'
       AND executando_desde < now() - make_interval(mins => $1::int)
     RETURNING id, codigo`, [minutos]);

  if (rows.length) {
    await query(`
      UPDATE job_execucoes
         SET status = 'ERRO', concluido_em = now(),
             erro = 'Execucao interrompida: processo encerrado antes de concluir'
       WHERE job_id = ANY($1::bigint[]) AND status = 'PROCESSANDO'`,
    [rows.map((r) => Number(r.id))]);
  }

  return rows.length;
}

// ---------------------------------------------------------------------------
// Consulta e manutencao
// ---------------------------------------------------------------------------

export async function listar() {
  const { rows } = await query(`
    SELECT j.id, j.codigo, j.nome, j.descricao, j.frequencia::text AS frequencia,
           j.hora, j.minuto, j.dia_semana, j.dia_mes, j.intervalo_minutos,
           j.ativo, j.status::text AS status, j.ultima_execucao, j.proxima_execucao,
           j.executando_desde, j.instancia, j.timeout_segundos, j.execucoes,
           j.falhas, j.ultimo_erro,
           CASE WHEN j.execucoes > 0
                THEN round(j.falhas::numeric / j.execucoes * 100, 1) END AS falha_percentual,
           (SELECT x.duracao_ms FROM job_execucoes x
             WHERE x.job_id = j.id AND x.duracao_ms IS NOT NULL
             ORDER BY x.iniciado_em DESC LIMIT 1) AS ultima_duracao_ms
      FROM jobs j
     ORDER BY j.frequencia, j.codigo`);

  const rotinas = catalogoRotinas();
  return rows.map((r) => {
    const j = r as Record<string, unknown>;
    return {
      ...j,
      falha_percentual: j.falha_percentual === null ? null : Number(j.falha_percentual),
      ultima_duracao_ms: j.ultima_duracao_ms === null ? null : Number(j.ultima_duracao_ms),
      // Um job cadastrado sem rotina nunca vai rodar. Melhor dizer na listagem
      // do que deixar o operador esperando por uma execucao que nao vem.
      tem_rotina: rotinas.includes(String(j.codigo).toUpperCase()),
    };
  });
}

export async function historico(codigo: string | undefined, limite = 50) {
  const valores: unknown[] = [];
  let filtro = '';
  if (codigo) {
    valores.push(codigo);
    filtro = 'WHERE upper(j.codigo) = upper($1)';
  }
  valores.push(Math.min(Math.max(limite, 1), 200));

  const { rows } = await query(`
    SELECT x.id, j.codigo, j.nome, x.status::text AS status, x.disparado_por,
           x.iniciado_em, x.concluido_em, x.duracao_ms, x.eventos_gerados,
           x.resultado, x.erro, x.correlation_id::text AS correlation_id,
           u.nome AS usuario
      FROM job_execucoes x
      JOIN jobs j ON j.id = x.job_id
      LEFT JOIN usuarios u ON u.id = x.usuario_id
     ${filtro}
     ORDER BY x.iniciado_em DESC
     LIMIT $${valores.length}`, valores);
  return rows;
}

export async function alternarAtivo(codigo: string, ativo: boolean): Promise<void> {
  const { rowCount } = await query(`
    UPDATE jobs
       SET ativo = $2,
           status = CASE WHEN $2 THEN 'OCIOSO' ELSE 'DESATIVADO' END::status_job_enum,
           proxima_execucao = CASE WHEN $2 THEN proxima_execucao ELSE NULL END
     WHERE upper(codigo) = upper($1)`, [codigo, ativo]);
  if (!rowCount) throw naoEncontrado(`Job ${codigo}`);
}

/** Reagenda todos: usado depois de mudar frequencia ou hora de vários jobs. */
export async function reagendarTodos(): Promise<number> {
  const { rows } = await query<{ id: string }>(
    "SELECT id FROM jobs WHERE ativo AND frequencia <> 'MANUAL'");
  for (const r of rows) await calcularProxima(Number(r.id));
  return rows.length;
}
