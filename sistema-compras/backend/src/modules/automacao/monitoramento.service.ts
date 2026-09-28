/**
 * Centro de operacoes: saude, monitoramento e diagnostico (secoes 34, 35, 39 e 40).
 *
 * A pergunta que esta tela responde e uma so: "a automacao esta funcionando?"
 *
 * Responder isso e mais dificil do que parece, porque automacao quebra em
 * silencio. O alerta que nao chegou nao aparece na tela; o job que parou de
 * rodar nao gera linha nenhuma. Por isso o diagnostico aqui procura AUSENCIAS,
 * nao so erros: job atrasado alem da propria frequencia, fila crescendo,
 * detector sem base, integracao ativa sem segredo. Uma tela que so mostra o que
 * aconteceu daria luz verde para um sistema parado.
 */
import { query } from '../../config/database.js';
import * as configAutomacao from './config.js';

export type Gravidade = 'OK' | 'ATENCAO' | 'CRITICO';

export interface Sintoma {
  gravidade: Gravidade;
  area: string;
  descricao: string;
  acao: string;
  numero?: number;
}

// ---------------------------------------------------------------------------
// Numeros do painel
// ---------------------------------------------------------------------------

export async function painel() {
  const [eventos, fila, execucoes, tarefas, aprovacoes, jobs, webhooks, notificacoes] =
    await Promise.all([
      query(`
        SELECT count(*) FILTER (WHERE status = 'NOVO')                        AS novos,
               count(*) FILTER (WHERE status = 'PROCESSADO')                  AS processados,
               count(*) FILTER (WHERE status = 'ERRO')                        AS erros,
               count(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS ultimas_24h,
               max(created_at)                                                AS ultimo
          FROM eventos`),
      query(`
        SELECT count(*) FILTER (WHERE status = 'PENDENTE')                  AS pendentes,
               count(*) FILTER (WHERE status = 'PROCESSANDO')               AS processando,
               count(*) FILTER (WHERE status = 'RETRY')                     AS retry,
               count(*) FILTER (WHERE dead_letter)                          AS fila_morta,
               count(*) FILTER (WHERE status = 'PENDENTE'
                                  AND disponivel_em > now())                AS aguardando_backoff,
               min(created_at) FILTER (WHERE status = 'PENDENTE')           AS mais_antigo
          FROM automacao_fila`),
      query(`
        SELECT count(*)                                           AS total_24h,
               count(*) FILTER (WHERE status = 'CONCLUIDO')       AS concluidas,
               count(*) FILTER (WHERE status = 'ERRO')            AS com_erro,
               round(avg(duracao_ms))                             AS duracao_media_ms,
               max(duracao_ms)                                    AS duracao_maxima_ms
          FROM automacao_execucoes
         WHERE created_at >= now() - interval '24 hours'`),
      query(`
        SELECT count(*) FILTER (WHERE status IN ('PENDENTE','EM_ANDAMENTO'))   AS abertas,
               count(*) FILTER (WHERE status IN ('PENDENTE','EM_ANDAMENTO')
                                  AND sla_status = 'VENCIDO')                  AS vencidas,
               count(*) FILTER (WHERE status IN ('PENDENTE','EM_ANDAMENTO')
                                  AND sla_status = 'EM_RISCO')                 AS em_risco,
               count(*) FILTER (WHERE status IN ('PENDENTE','EM_ANDAMENTO')
                                  AND nivel_escalonamento > 0)                 AS escalonadas,
               count(*) FILTER (WHERE status IN ('PENDENTE','EM_ANDAMENTO')
                                  AND responsavel_id IS NULL)                  AS sem_dono
          FROM tarefas`),
      query(`
        SELECT count(*) FILTER (WHERE status = 'PENDENTE')                     AS pendentes,
               count(*) FILTER (WHERE status = 'PENDENTE' AND excecao)         AS excecoes,
               count(*) FILTER (WHERE status = 'PENDENTE'
                                  AND prazo IS NOT NULL AND prazo < now())     AS vencidas
          FROM aprovacoes`),
      query(`
        SELECT count(*) FILTER (WHERE ativo)                       AS ativos,
               count(*) FILTER (WHERE status = 'EXECUTANDO')       AS executando,
               count(*) FILTER (WHERE status = 'ERRO')             AS com_erro,
               count(*) FILTER (WHERE ativo AND frequencia <> 'MANUAL'
                                  AND proxima_execucao < now()
                                      - interval '1 hour')         AS atrasados,
               min(proxima_execucao) FILTER (WHERE ativo)          AS proximo
          FROM jobs`),
      query(`
        SELECT count(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS recebidos_24h,
               count(*) FILTER (WHERE status = 'REJEITADO'
                                  AND created_at >= now() - interval '24 hours') AS rejeitados_24h,
               count(*) FILTER (WHERE status = 'DUPLICADO'
                                  AND created_at >= now() - interval '24 hours') AS duplicados_24h
          FROM webhooks_recebidos`),
      query(`
        SELECT count(*) FILTER (WHERE status = 'PENDENTE')   AS pendentes,
               count(*) FILTER (WHERE status = 'FALHOU')     AS falharam,
               count(*) FILTER (WHERE NOT lida)              AS nao_lidas
          FROM notificacoes`),
    ]);

  const n = (linhas: Record<string, unknown>[], campo: string) =>
    Number((linhas[0]?.[campo] as string) ?? 0);

  const totalExec = n(execucoes.rows, 'total_24h');

  return {
    eventos: {
      novos: n(eventos.rows, 'novos'),
      processados: n(eventos.rows, 'processados'),
      erros: n(eventos.rows, 'erros'),
      ultimas_24h: n(eventos.rows, 'ultimas_24h'),
      ultimo: eventos.rows[0]?.ultimo ?? null,
    },
    fila: {
      pendentes: n(fila.rows, 'pendentes'),
      processando: n(fila.rows, 'processando'),
      retry: n(fila.rows, 'retry'),
      fila_morta: n(fila.rows, 'fila_morta'),
      aguardando_backoff: n(fila.rows, 'aguardando_backoff'),
      mais_antigo: fila.rows[0]?.mais_antigo ?? null,
    },
    execucoes: {
      total_24h: totalExec,
      concluidas: n(execucoes.rows, 'concluidas'),
      com_erro: n(execucoes.rows, 'com_erro'),
      duracao_media_ms: execucoes.rows[0]?.duracao_media_ms === null
        ? null : n(execucoes.rows, 'duracao_media_ms'),
      duracao_maxima_ms: execucoes.rows[0]?.duracao_maxima_ms === null
        ? null : n(execucoes.rows, 'duracao_maxima_ms'),
      // Sem execucao nenhuma o percentual nao existe. 100% de sucesso em zero
      // tentativas seria o painel dando luz verde para um motor parado.
      sucesso_percentual: totalExec > 0
        ? Math.round((n(execucoes.rows, 'concluidas') / totalExec) * 1000) / 10
        : null,
      sem_base: totalExec === 0,
    },
    tarefas: {
      abertas: n(tarefas.rows, 'abertas'),
      vencidas: n(tarefas.rows, 'vencidas'),
      em_risco: n(tarefas.rows, 'em_risco'),
      escalonadas: n(tarefas.rows, 'escalonadas'),
      sem_dono: n(tarefas.rows, 'sem_dono'),
    },
    aprovacoes: {
      pendentes: n(aprovacoes.rows, 'pendentes'),
      excecoes: n(aprovacoes.rows, 'excecoes'),
      vencidas: n(aprovacoes.rows, 'vencidas'),
    },
    jobs: {
      ativos: n(jobs.rows, 'ativos'),
      executando: n(jobs.rows, 'executando'),
      com_erro: n(jobs.rows, 'com_erro'),
      atrasados: n(jobs.rows, 'atrasados'),
      proximo: jobs.rows[0]?.proximo ?? null,
    },
    webhooks: {
      recebidos_24h: n(webhooks.rows, 'recebidos_24h'),
      rejeitados_24h: n(webhooks.rows, 'rejeitados_24h'),
      duplicados_24h: n(webhooks.rows, 'duplicados_24h'),
    },
    notificacoes: {
      pendentes: n(notificacoes.rows, 'pendentes'),
      falharam: n(notificacoes.rows, 'falharam'),
      nao_lidas: n(notificacoes.rows, 'nao_lidas'),
    },
  };
}

// ---------------------------------------------------------------------------
// Diagnostico (secao 39)
// ---------------------------------------------------------------------------

/**
 * Procura o que esta errado, inclusive o que esta faltando.
 *
 * Cada sintoma vem com a acao correspondente. Um diagnostico que diz "fila com
 * 4.000 itens" e deixa o operador decidir o que fazer nao terminou o trabalho.
 */
export async function diagnostico(): Promise<{
  gravidade: Gravidade; sintomas: Sintoma[]; verificado_em: string;
}> {
  const sintomas: Sintoma[] = [];

  const agendadorLigado = await configAutomacao.ligado('agendador_ativo', true);
  const workerLigado = await configAutomacao.ligado('worker_ativo', true);

  if (!agendadorLigado) {
    sintomas.push({
      gravidade: 'CRITICO', area: 'agendador',
      descricao: 'O agendador esta desligado: nenhum job automatico esta rodando',
      acao: 'Religar em automacao.agendador_ativo, na tela de configuracoes',
    });
  }
  if (!workerLigado) {
    sintomas.push({
      gravidade: 'CRITICO', area: 'worker',
      descricao: 'O worker esta desligado: as acoes enfileiradas nao sao executadas',
      acao: 'Religar em automacao.worker_ativo',
    });
  }

  // Job atrasado alem da propria frequencia. Comparar com a frequencia dele e o
  // que evita acusar o job mensal de atraso no dia 2.
  const { rows: jobsAtrasados } = await query<{
    codigo: string; frequencia: string; horas: string;
  }>(`
    SELECT codigo, frequencia::text AS frequencia,
           round(EXTRACT(EPOCH FROM (now() - proxima_execucao)) / 3600, 1)::text AS horas
      FROM jobs
     WHERE ativo AND frequencia <> 'MANUAL' AND proxima_execucao IS NOT NULL
       AND now() - proxima_execucao > CASE frequencia
             WHEN 'MINUTO'  THEN make_interval(mins  => coalesce(intervalo_minutos, 5) * 3)
             WHEN 'HORA'    THEN interval '3 hours'
             WHEN 'DIARIO'  THEN interval '2 days'
             WHEN 'SEMANAL' THEN interval '9 days'
             WHEN 'MENSAL'  THEN interval '35 days'
             ELSE interval '1 day' END
     ORDER BY proxima_execucao`);

  for (const j of jobsAtrasados) {
    sintomas.push({
      gravidade: 'CRITICO', area: 'jobs',
      descricao: `Job ${j.codigo} (${j.frequencia}) esta ${j.horas}h atrasado`,
      acao: 'Verificar se o agendador esta sendo chamado; executar manualmente para destravar',
      numero: Number(j.horas),
    });
  }

  const { rows: jobsErro } = await query<{ codigo: string; ultimo_erro: string }>(`
    SELECT codigo, ultimo_erro FROM jobs WHERE status = 'ERRO' AND ativo`);
  for (const j of jobsErro) {
    sintomas.push({
      gravidade: 'ATENCAO', area: 'jobs',
      descricao: `Job ${j.codigo} terminou com erro: ${(j.ultimo_erro ?? '').slice(0, 160)}`,
      acao: 'Ver o historico do job no centro de operacoes e corrigir a causa',
    });
  }

  const { rows: jobsTravados } = await query<{ codigo: string; minutos: string }>(`
    SELECT codigo,
           round(EXTRACT(EPOCH FROM (now() - executando_desde)) / 60)::text AS minutos
      FROM jobs
     WHERE status = 'EXECUTANDO'
       AND executando_desde < now() - make_interval(secs => timeout_segundos)`);
  for (const j of jobsTravados) {
    sintomas.push({
      gravidade: 'ATENCAO', area: 'jobs',
      descricao: `Job ${j.codigo} esta executando ha ${j.minutos} minutos, acima do timeout`,
      acao: 'Aguardar o proximo ciclo: orfaos sao liberados automaticamente apos o limite',
      numero: Number(j.minutos),
    });
  }

  // Fila. O sinal nao e o tamanho, e a IDADE: mil itens processados em um minuto
  // estao bem; dez itens parados ha duas horas indicam worker fora do ar.
  const { rows: filaAntiga } = await query<{ horas: string; total: string }>(`
    SELECT round(EXTRACT(EPOCH FROM (now() - min(created_at))) / 3600, 1)::text AS horas,
           count(*)::text AS total
      FROM automacao_fila
     WHERE status = 'PENDENTE' AND disponivel_em <= now()`);

  const idade = Number(filaAntiga[0]?.horas ?? 0);
  const aguardando = Number(filaAntiga[0]?.total ?? 0);
  if (aguardando > 0 && idade >= 1) {
    sintomas.push({
      gravidade: idade >= 6 ? 'CRITICO' : 'ATENCAO', area: 'fila',
      descricao: `${aguardando} acao(oes) na fila, a mais antiga ha ${idade}h sem execucao`,
      acao: 'Verificar se o job PROCESSAR_FILA esta rodando; executar manualmente se preciso',
      numero: aguardando,
    });
  }

  const { rows: mortas } = await query<{ total: string; acoes: string }>(`
    SELECT count(*)::text AS total, string_agg(DISTINCT acao, ', ') AS acoes
      FROM automacao_fila WHERE dead_letter`);
  if (Number(mortas[0]?.total ?? 0) > 0) {
    sintomas.push({
      gravidade: 'ATENCAO', area: 'fila',
      descricao: `${mortas[0]!.total} acao(oes) na fila morta apos esgotar as tentativas`
        + ` (${mortas[0]!.acoes})`,
      acao: 'Analisar o erro registrado e reprocessar pela tela de operacao',
      numero: Number(mortas[0]!.total),
    });
  }

  const { rows: eventosErro } = await query<{ total: string }>(
    "SELECT count(*)::text AS total FROM eventos WHERE status = 'ERRO'");
  if (Number(eventosErro[0]?.total ?? 0) > 0) {
    sintomas.push({
      gravidade: 'ATENCAO', area: 'eventos',
      descricao: `${eventosErro[0]!.total} evento(s) com erro no casamento de regras`,
      acao: 'Ver a lista de eventos filtrando por status ERRO',
      numero: Number(eventosErro[0]!.total),
    });
  }

  // Ausencia de evento recente: sinal de detector parado, nao de operacao limpa.
  const { rows: ultimoEvento } = await query<{ horas: string | null }>(`
    SELECT round(EXTRACT(EPOCH FROM (now() - max(created_at))) / 3600, 1)::text AS horas
      FROM eventos`);
  const horasSemEvento = ultimoEvento[0]?.horas === null
    ? null : Number(ultimoEvento[0]!.horas);

  if (horasSemEvento === null) {
    sintomas.push({
      gravidade: 'ATENCAO', area: 'eventos',
      descricao: 'Nenhum evento registrado ate agora',
      acao: 'Executar o job DETECTAR_EVENTOS para a primeira varredura',
    });
  } else if (horasSemEvento > 26) {
    sintomas.push({
      gravidade: 'CRITICO', area: 'eventos',
      descricao: `Nenhum evento novo ha ${horasSemEvento}h. `
        + 'Os detectores rodam de hora em hora: silencio assim longo indica motor parado, '
        + 'nao operacao sem problemas',
      acao: 'Verificar o agendador e executar DETECTAR_EVENTOS manualmente',
      numero: horasSemEvento,
    });
  }

  const { rows: tarefasVencidas } = await query<{ total: string; nivel3: string }>(`
    SELECT count(*)::text AS total,
           count(*) FILTER (WHERE nivel_escalonamento >= 3)::text AS nivel3
      FROM tarefas
     WHERE status IN ('PENDENTE','EM_ANDAMENTO') AND sla_status = 'VENCIDO'`);
  const vencidas = Number(tarefasVencidas[0]?.total ?? 0);
  if (vencidas > 0) {
    sintomas.push({
      gravidade: Number(tarefasVencidas[0]!.nivel3) > 0 ? 'CRITICO' : 'ATENCAO',
      area: 'sla',
      descricao: `${vencidas} tarefa(s) com SLA vencido`
        + (Number(tarefasVencidas[0]!.nivel3) > 0
          ? `, sendo ${tarefasVencidas[0]!.nivel3} ja no nivel 3 (diretoria)` : ''),
      acao: 'Revisar a fila de tarefas por prioridade e redistribuir',
      numero: vencidas,
    });
  }

  const { rows: semDono } = await query<{ total: string }>(`
    SELECT count(*)::text AS total FROM tarefas
     WHERE status = 'PENDENTE' AND responsavel_id IS NULL
       AND created_at < now() - interval '48 hours'`);
  if (Number(semDono[0]?.total ?? 0) > 0) {
    sintomas.push({
      gravidade: 'ATENCAO', area: 'tarefas',
      descricao: `${semDono[0]!.total} tarefa(s) ha mais de 48h sem ninguem assumir`,
      acao: 'Atribuir responsavel: tarefa de perfil sem dono tende a nao ser feita',
      numero: Number(semDono[0]!.total),
    });
  }

  const { rows: aprovacoesVencidas } = await query<{ total: string }>(`
    SELECT count(*)::text AS total FROM aprovacoes
     WHERE status = 'PENDENTE' AND prazo IS NOT NULL AND prazo < now()`);
  if (Number(aprovacoesVencidas[0]?.total ?? 0) > 0) {
    sintomas.push({
      gravidade: 'ATENCAO', area: 'aprovacoes',
      descricao: `${aprovacoesVencidas[0]!.total} aprovacao(oes) pendente(s) fora do prazo`,
      acao: 'Cobrar a alcada responsavel; compra parada por aprovacao vira ruptura',
      numero: Number(aprovacoesVencidas[0]!.total),
    });
  }

  // Perfil sem usuario ativo: a regra aponta para um destino que nao existe, e
  // a tarefa nasce sem chegar a ninguem. Falha silenciosa classica.
  const { rows: perfisVazios } = await query<{ perfil: string; regras: string }>(`
    SELECT DISTINCT r.parametros ->> 'perfil' AS perfil,
           count(*) OVER (PARTITION BY r.parametros ->> 'perfil')::text AS regras
      FROM automacao_regras r
     WHERE r.ativo AND r.parametros ->> 'perfil' IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM usuarios u JOIN perfis p ON p.id = u.perfil_id
          WHERE u.ativo AND u.deleted_at IS NULL
            AND upper(p.nome) = upper(r.parametros ->> 'perfil'))`);
  for (const p of perfisVazios) {
    sintomas.push({
      gravidade: 'CRITICO', area: 'notificacoes',
      descricao: `${p.regras} regra(s) enviam para o perfil ${p.perfil}, `
        + 'que nao tem nenhum usuario ativo: essas notificacoes nao chegam a ninguem',
      acao: `Cadastrar ou ativar um usuario com o perfil ${p.perfil}, `
        + 'ou apontar as regras para outro perfil',
    });
  }

  const { rows: integracoes } = await query<{ codigo: string }>(`
    SELECT codigo FROM integracoes WHERE ativo AND segredo_hash IS NULL`);
  for (const i of integracoes) {
    sintomas.push({
      gravidade: 'ATENCAO', area: 'integracoes',
      descricao: `Integracao ${i.codigo} esta ativa mas sem segredo configurado: `
        + 'todo webhook dela sera recusado',
      acao: `Definir o segredo da integracao ${i.codigo} ou desativa-la`,
    });
  }

  const { rows: webhooksRejeitados } = await query<{ total: string; integracao: string }>(`
    SELECT count(*)::text AS total, integracao
      FROM webhooks_recebidos
     WHERE status = 'REJEITADO' AND created_at >= now() - interval '24 hours'
     GROUP BY integracao HAVING count(*) >= 5`);
  for (const w of webhooksRejeitados) {
    sintomas.push({
      gravidade: 'ATENCAO', area: 'integracoes',
      descricao: `${w.total} webhook(s) de ${w.integracao} recusados nas ultimas 24h`,
      acao: 'Conferir o segredo combinado com o parceiro e o relogio do servidor dele',
      numero: Number(w.total),
    });
  }

  // Contrato entre regra e detector (migration 048). E a falha mais traicoeira
  // do modulo: a regra fica ativa, vigente e visivel na tela, pedindo um campo
  // que os eventos daquele tipo nunca carregam - e nunca dispara. Ninguem
  // procura pelo alerta que nao chegou, entao quem tem de procurar e o
  // diagnostico.
  const { rows: contrato } = await query<{
    codigo: string; campo_exigido: string; evento: string; evento_ja_ocorreu: boolean;
  }>(`SELECT codigo, campo_exigido, evento, evento_ja_ocorreu
        FROM vw_regras_contrato
       WHERE NOT campo_existe
       ORDER BY evento_ja_ocorreu DESC, codigo`);

  for (const c of contrato) {
    sintomas.push(c.evento_ja_ocorreu
      ? {
        gravidade: 'CRITICO', area: 'regras',
        descricao: `A regra ${c.codigo} exige o campo "${c.campo_exigido}", que os `
          + `eventos ${c.evento} nao carregam: ela nunca vai disparar`,
        acao: `Corrigir o nome do campo na condicao da regra ${c.codigo}, ou fazer o `
          + `detector de ${c.evento} emitir "${c.campo_exigido}"`,
      }
      : {
        gravidade: 'OK', area: 'regras',
        descricao: `A regra ${c.codigo} espera o campo "${c.campo_exigido}", e nenhum `
          + `evento ${c.evento} foi produzido ainda - nao da para conferir o contrato`,
        acao: `Normal enquanto nao existir detector para ${c.evento}; reavaliar quando o `
          + 'primeiro evento desse tipo chegar',
      });
  }

  const { rows: regrasSemUso } = await query<{ total: string }>(`
    SELECT count(*)::text AS total
      FROM automacao_regras r
     WHERE r.ativo
       AND NOT EXISTS (SELECT 1 FROM automacao_execucoes x
                        WHERE x.regra_id = r.id
                          AND x.created_at >= now() - interval '30 days')`);
  if (Number(regrasSemUso[0]?.total ?? 0) > 0) {
    sintomas.push({
      gravidade: 'OK', area: 'regras',
      descricao: `${regrasSemUso[0]!.total} regra(s) ativa(s) nao dispararam em 30 dias`,
      acao: 'Normal para regras de excecao; revisar se alguma deveria estar disparando',
      numero: Number(regrasSemUso[0]!.total),
    });
  }

  const criticos = sintomas.filter((s) => s.gravidade === 'CRITICO').length;
  const atencoes = sintomas.filter((s) => s.gravidade === 'ATENCAO').length;

  return {
    gravidade: criticos > 0 ? 'CRITICO' : atencoes > 0 ? 'ATENCAO' : 'OK',
    sintomas,
    verificado_em: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Series e rankings
// ---------------------------------------------------------------------------

/** Volume por dia: mostra se o motor mantem ritmo ou parou em algum dia. */
export async function serie(dias = 14) {
  const { rows } = await query(`
    WITH calendario AS (
      SELECT generate_series(current_date - make_interval(days => $1::int - 1),
                             current_date, interval '1 day')::date AS dia
    )
    SELECT c.dia::text AS dia,
           coalesce(e.total, 0)        AS eventos,
           coalesce(x.total, 0)        AS execucoes,
           coalesce(x.erros, 0)        AS erros,
           coalesce(t.total, 0)        AS tarefas,
           coalesce(a.total, 0)        AS alertas
      FROM calendario c
      LEFT JOIN (SELECT created_at::date AS dia, count(*) AS total
                   FROM eventos GROUP BY 1) e ON e.dia = c.dia
      LEFT JOIN (SELECT created_at::date AS dia, count(*) AS total,
                        count(*) FILTER (WHERE status = 'ERRO') AS erros
                   FROM automacao_execucoes GROUP BY 1) x ON x.dia = c.dia
      LEFT JOIN (SELECT created_at::date AS dia, count(*) AS total
                   FROM tarefas GROUP BY 1) t ON t.dia = c.dia
      LEFT JOIN (SELECT created_at::date AS dia, count(*) AS total
                   FROM alertas WHERE origem LIKE 'automacao:%' GROUP BY 1) a ON a.dia = c.dia
     ORDER BY c.dia`, [dias]);

  return rows.map((r) => {
    const l = r as Record<string, unknown>;
    return {
      dia: l.dia,
      eventos: Number(l.eventos),
      execucoes: Number(l.execucoes),
      erros: Number(l.erros),
      tarefas: Number(l.tarefas),
      alertas: Number(l.alertas),
    };
  });
}

/** Quais regras produzem mais, e quais custam mais caro (secao 34). */
export async function desempenhoRegras(dias = 30) {
  const { rows } = await query(`
    SELECT coalesce(x.regra_codigo, r.codigo, '(sem regra)') AS codigo,
           r.nome, r.acao, r.nivel::text AS nivel, r.ativo,
           count(*)                                          AS execucoes,
           count(*) FILTER (WHERE x.status = 'ERRO')         AS erros,
           round(avg(x.duracao_ms))                          AS duracao_media_ms,
           max(x.duracao_ms)                                 AS duracao_maxima_ms,
           max(x.created_at)                                 AS ultima
      FROM automacao_execucoes x
      LEFT JOIN automacao_regras r ON r.id = x.regra_id
     WHERE x.created_at >= now() - make_interval(days => $1::int)
     GROUP BY coalesce(x.regra_codigo, r.codigo, '(sem regra)'),
              r.nome, r.acao, r.nivel, r.ativo
     ORDER BY count(*) DESC`, [dias]);

  return rows.map((r) => {
    const l = r as Record<string, unknown>;
    const execucoes = Number(l.execucoes);
    const erros = Number(l.erros);
    return {
      ...l,
      execucoes,
      erros,
      duracao_media_ms: l.duracao_media_ms === null ? null : Number(l.duracao_media_ms),
      duracao_maxima_ms: l.duracao_maxima_ms === null ? null : Number(l.duracao_maxima_ms),
      erro_percentual: execucoes > 0 ? Math.round((erros / execucoes) * 1000) / 10 : null,
    };
  });
}

/**
 * Efeito real da automacao (secao 40).
 *
 * A pergunta do gerente nao e "quantas execucoes rodaram", e "isso esta
 * resolvendo alguma coisa?". Por isso a medida e quantas tarefas nascidas de
 * automacao foram CONCLUIDAS - e em quanto tempo.
 */
export async function efeito(dias = 30) {
  const { rows } = await query(`
    SELECT count(*)                                              AS tarefas_geradas,
           count(*) FILTER (WHERE status = 'CONCLUIDA')          AS concluidas,
           count(*) FILTER (WHERE status = 'CANCELADA')          AS canceladas,
           count(*) FILTER (WHERE status IN ('PENDENTE','EM_ANDAMENTO')) AS abertas,
           round(avg(EXTRACT(EPOCH FROM (concluida_em - created_at)) / 3600)
                 FILTER (WHERE status = 'CONCLUIDA'), 1)         AS horas_ate_conclusao
      FROM tarefas
     WHERE origem LIKE 'automacao:%'
       AND created_at >= now() - make_interval(days => $1::int)`, [dias]);

  const { rows: alertas } = await query(`
    SELECT count(*)                                        AS gerados,
           count(*) FILTER (WHERE status = 'RESOLVIDO')    AS resolvidos,
           sum(ocorrencias)                                AS ocorrencias
      FROM alertas
     WHERE origem LIKE 'automacao:%'
       AND created_at >= now() - make_interval(days => $1::int)`, [dias]);

  const { rows: aprovacoes } = await query(`
    SELECT count(*)                                         AS solicitadas,
           count(*) FILTER (WHERE status = 'APROVADA')      AS aprovadas,
           count(*) FILTER (WHERE status = 'REJEITADA')     AS rejeitadas,
           count(*) FILTER (WHERE excecao)                  AS excecoes,
           round(avg(EXTRACT(EPOCH FROM (decidido_em - created_at)) / 3600)
                 FILTER (WHERE decidido_em IS NOT NULL), 1) AS horas_ate_decisao
      FROM aprovacoes
     WHERE created_at >= now() - make_interval(days => $1::int)`, [dias]);

  const t = rows[0] as Record<string, unknown>;
  const a = alertas[0] as Record<string, unknown>;
  const p = aprovacoes[0] as Record<string, unknown>;

  const geradas = Number(t.tarefas_geradas);
  const concluidas = Number(t.concluidas);

  return {
    periodo_dias: dias,
    tarefas: {
      geradas,
      concluidas,
      canceladas: Number(t.canceladas),
      abertas: Number(t.abertas),
      horas_ate_conclusao: t.horas_ate_conclusao === null
        ? null : Number(t.horas_ate_conclusao),
      // Cancelamento alto e o sinal mais util aqui: quer dizer que a automacao
      // esta gerando trabalho que o time julga desnecessario.
      conclusao_percentual: geradas > 0
        ? Math.round((concluidas / geradas) * 1000) / 10 : null,
      descarte_percentual: geradas > 0
        ? Math.round((Number(t.canceladas) / geradas) * 1000) / 10 : null,
    },
    alertas: {
      gerados: Number(a.gerados),
      resolvidos: Number(a.resolvidos),
      ocorrencias: Number(a.ocorrencias ?? 0),
    },
    aprovacoes: {
      solicitadas: Number(p.solicitadas),
      aprovadas: Number(p.aprovadas),
      rejeitadas: Number(p.rejeitadas),
      excecoes: Number(p.excecoes),
      horas_ate_decisao: p.horas_ate_decisao === null ? null : Number(p.horas_ate_decisao),
    },
    ...(geradas === 0
      ? { motivo_sem_base: `Nenhuma tarefa gerada por automacao nos ultimos ${dias} dias` }
      : {}),
  };
}
