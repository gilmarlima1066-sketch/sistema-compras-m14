/**
 * Central de integracoes, monitoramento e central de erros (secoes 5, 33 e 35).
 *
 * O semaforo da secao 5 tem quatro cores, e a quarta e a mais importante:
 *
 *   OPERACIONAL       sincronizou e deu certo
 *   ATENCAO           funciona, mas algo pede olhar
 *   ERRO              a ultima tentativa falhou
 *   NAO_CONFIGURADO   nunca foi configurada
 *
 * Sem a quarta cor, uma integracao que nunca foi ligada apareceria como verde
 * (nunca falhou) ou vermelha (nunca funcionou) - e as duas leituras sao falsas.
 * "Nao configurado" e um estado legitimo e diz exatamente o que fazer.
 */
import { query } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { numero as configNumero, ligado } from './config.js';
import * as credenciais from './credenciais.service.js';

export type Semaforo = 'OPERACIONAL' | 'ATENCAO' | 'ERRO' | 'NAO_CONFIGURADO';

// ---------------------------------------------------------------------------
// Central (secao 5)
// ---------------------------------------------------------------------------

export async function central() {
  const horasLimite = await configNumero('alerta_sem_sincronizar_horas', 48);
  const ambiente = await credenciais.ambienteDoServidor();

  const { rows } = await query(`
    SELECT i.id, i.codigo, i.nome, i.sistema::text AS sistema,
           i.conector::text AS conector, i.direcao::text AS direcao,
           i.modo_sincronizacao::text AS modo, i.ativo,
           i.status::text AS status_gravado, i.endpoint IS NOT NULL AS tem_endpoint,
           i.ultima_sincronizacao, i.proxima_sincronizacao, i.ultimo_status,
           i.registros_processados, i.registros_enviados, i.registros_rejeitados,
           i.erros, i.intervalo_minutos,
           (SELECT count(*) FROM integracao_credenciais c
             WHERE c.integracao_id = i.id AND c.ativo) AS credenciais,
           (SELECT count(*) FROM integracao_erros e
             WHERE e.integracao_id = i.id AND e.status = 'ABERTO') AS erros_abertos,
           (SELECT count(*) FROM integracao_mensagens m
             WHERE m.integracao_id = i.id
               AND m.status IN ('PENDENTE', 'RETRY') AND NOT m.dead_letter) AS pendentes,
           (SELECT count(*) FROM integracao_mensagens m
             WHERE m.integracao_id = i.id AND m.dead_letter) AS dead_letter,
           CASE WHEN i.ultima_sincronizacao IS NULL THEN NULL
                ELSE round(EXTRACT(EPOCH FROM (now() - i.ultima_sincronizacao)) / 3600, 1)
           END AS horas_desde_sincronizacao
      FROM integracoes i
     ORDER BY i.sistema, i.codigo`);

  const integracoes = rows.map((r) => {
    const i = r as Record<string, unknown>;
    const ativo = Boolean(i.ativo);
    const temEndpoint = Boolean(i.tem_endpoint);
    const conector = String(i.conector);
    const credenciaisAtivas = Number(i.credenciais);
    const errosAbertos = Number(i.erros_abertos);
    const deadLetter = Number(i.dead_letter);
    const horas = i.horas_desde_sincronizacao === null
      ? null : Number(i.horas_desde_sincronizacao);

    // Um conector de ARQUIVO ou MANUAL nao precisa de endpoint nem de segredo:
    // exigir isso dele o pintaria de vermelho para sempre.
    const precisaEndpoint = ['REST', 'SOAP', 'SFTP'].includes(conector);
    const precisaCredencial = ['REST', 'SOAP', 'SFTP', 'BANCO_SQL', 'EMAIL'].includes(conector);

    const pendencias: string[] = [];
    if (precisaEndpoint && !temEndpoint) pendencias.push('endpoint nao configurado');
    if (precisaCredencial && credenciaisAtivas === 0) {
      pendencias.push('nenhuma credencial cadastrada');
    }

    let semaforo: Semaforo;
    let motivo: string;

    if (!ativo && pendencias.length) {
      semaforo = 'NAO_CONFIGURADO';
      motivo = `Inativa e sem configuracao: ${pendencias.join(', ')}`;
    } else if (!ativo) {
      semaforo = 'NAO_CONFIGURADO';
      motivo = 'Configurada, porem desativada';
    } else if (pendencias.length) {
      // Ativa sem o que precisa: vermelho, porque toda tentativa vai falhar.
      semaforo = 'ERRO';
      motivo = `Ativa mas ${pendencias.join(' e ')}: as sincronizacoes vao falhar`;
    } else if (String(i.status_gravado) === 'ERRO' || errosAbertos > 0) {
      semaforo = 'ERRO';
      motivo = errosAbertos > 0
        ? `${errosAbertos} erro(s) em aberto`
        : `Ultima execucao falhou: ${String(i.ultimo_status ?? '')}`.trim();
    } else if (deadLetter > 0) {
      semaforo = 'ATENCAO';
      motivo = `${deadLetter} mensagem(ns) na dead letter aguardando decisao`;
    } else if (String(i.modo) === 'AGENDADO' && horas !== null && horas > horasLimite) {
      semaforo = 'ATENCAO';
      motivo = `Sem sincronizar ha ${horas}h; o intervalo configurado e de `
        + `${Number(i.intervalo_minutos ?? 0)} minutos`;
    } else if (horas === null) {
      semaforo = 'ATENCAO';
      motivo = 'Configurada e ativa, mas nunca sincronizou';
    } else {
      semaforo = 'OPERACIONAL';
      motivo = `Ultima sincronizacao ha ${horas}h`;
    }

    return {
      id: Number(i.id),
      codigo: i.codigo,
      nome: i.nome,
      sistema: i.sistema,
      conector,
      direcao: i.direcao,
      modo: i.modo,
      ativo,
      semaforo,
      motivo,
      pendencias,
      ultima_sincronizacao: i.ultima_sincronizacao,
      proxima_sincronizacao: i.proxima_sincronizacao,
      horas_desde_sincronizacao: horas,
      registros_recebidos: Number(i.registros_processados),
      registros_enviados: Number(i.registros_enviados),
      registros_rejeitados: Number(i.registros_rejeitados),
      erros_abertos: errosAbertos,
      pendentes: Number(i.pendentes),
      dead_letter: deadLetter,
      credenciais: credenciaisAtivas,
    };
  });

  const contar = (s: Semaforo) => integracoes.filter((i) => i.semaforo === s).length;

  return {
    ambiente,
    sincronizacao_ativa: await ligado('sincronizacao_ativa', true),
    total: integracoes.length,
    operacionais: contar('OPERACIONAL'),
    atencao: contar('ATENCAO'),
    erro: contar('ERRO'),
    nao_configuradas: contar('NAO_CONFIGURADO'),
    ativas: integracoes.filter((i) => i.ativo).length,
    inativas: integracoes.filter((i) => !i.ativo).length,
    integracoes,
  };
}

// ---------------------------------------------------------------------------
// Indicadores (secao 33)
// ---------------------------------------------------------------------------

export async function indicadores(dias = 7) {
  const [execucoes, mensagens, importacoes, exportacoes] = await Promise.all([
    query(`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE status = 'CONCLUIDA') AS sucesso,
             count(*) FILTER (WHERE status = 'CONCLUIDA_COM_ERROS') AS parcial,
             count(*) FILTER (WHERE status = 'FALHOU') AS falha,
             round(avg(duracao_ms)) AS latencia_media_ms,
             max(duracao_ms) AS latencia_maxima_ms,
             sum(registros_lidos) AS registros,
             sum(registros_rejeitados) AS rejeitados
        FROM integracao_execucoes
       WHERE iniciado_em >= now() - make_interval(days => $1::int)`, [dias]),
    query(`
      SELECT count(*) FILTER (WHERE status IN ('PENDENTE','RETRY')
                                AND NOT dead_letter) AS pendentes,
             count(*) FILTER (WHERE dead_letter) AS dead_letter,
             count(*) FILTER (WHERE status = 'SUCESSO') AS sucesso,
             count(*) FILTER (WHERE status = 'DESCARTADA') AS descartadas,
             count(*) FILTER (WHERE status = 'ERRO') AS erro
        FROM integracao_mensagens`),
    query(`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE status = 'CONCLUIDA') AS concluidas,
             count(*) FILTER (WHERE status = 'CONCLUIDA_COM_ERROS') AS com_erros,
             count(*) FILTER (WHERE status = 'AGUARDANDO_CONFIRMACAO') AS aguardando,
             sum(total_linhas) AS linhas,
             sum(registros_criados + registros_atualizados) AS registros
        FROM importacoes
       WHERE created_at >= now() - make_interval(days => $1::int)`, [dias]),
    query(`
      SELECT count(*) AS total, count(*) FILTER (WHERE sensivel) AS sensiveis,
             sum(total_linhas) AS linhas
        FROM exportacoes
       WHERE created_at >= now() - make_interval(days => $1::int)`, [dias]),
  ]);

  const n = (linhas: Record<string, unknown>[], campo: string) =>
    Number((linhas[0]?.[campo] as string) ?? 0);

  const total = n(execucoes.rows, 'total');
  const sucesso = n(execucoes.rows, 'sucesso');
  const falha = n(execucoes.rows, 'falha');

  return {
    periodo_dias: dias,
    execucoes: {
      total,
      sucesso,
      parcial: n(execucoes.rows, 'parcial'),
      falha,
      // Sem execucao nenhuma o percentual nao existe. Mostrar 100% de sucesso
      // em zero tentativas daria luz verde a uma integracao parada.
      taxa_sucesso: total > 0 ? Math.round((sucesso / total) * 1000) / 10 : null,
      taxa_erro: total > 0 ? Math.round((falha / total) * 1000) / 10 : null,
      sem_base: total === 0,
      latencia_media_ms: execucoes.rows[0]?.latencia_media_ms === null
        ? null : n(execucoes.rows, 'latencia_media_ms'),
      latencia_maxima_ms: execucoes.rows[0]?.latencia_maxima_ms === null
        ? null : n(execucoes.rows, 'latencia_maxima_ms'),
      registros: n(execucoes.rows, 'registros'),
      rejeitados: n(execucoes.rows, 'rejeitados'),
    },
    mensagens: {
      pendentes: n(mensagens.rows, 'pendentes'),
      dead_letter: n(mensagens.rows, 'dead_letter'),
      sucesso: n(mensagens.rows, 'sucesso'),
      descartadas: n(mensagens.rows, 'descartadas'),
      erro: n(mensagens.rows, 'erro'),
    },
    importacoes: {
      total: n(importacoes.rows, 'total'),
      concluidas: n(importacoes.rows, 'concluidas'),
      com_erros: n(importacoes.rows, 'com_erros'),
      aguardando_confirmacao: n(importacoes.rows, 'aguardando'),
      linhas: n(importacoes.rows, 'linhas'),
      registros: n(importacoes.rows, 'registros'),
    },
    exportacoes: {
      total: n(exportacoes.rows, 'total'),
      sensiveis: n(exportacoes.rows, 'sensiveis'),
      linhas: n(exportacoes.rows, 'linhas'),
    },
    ...(total === 0 ? {
      motivo_sem_base: `Nenhuma execucao de integracao nos ultimos ${dias} dias`,
    } : {}),
  };
}

/** Volume por dia, para ver se o ritmo se manteve (secao 33). */
export async function serie(dias = 14) {
  const { rows } = await query(`
    WITH calendario AS (
      SELECT generate_series(current_date - make_interval(days => $1::int - 1),
                             current_date, interval '1 day')::date AS dia
    )
    SELECT c.dia::text AS dia,
           coalesce(e.execucoes, 0) AS execucoes,
           coalesce(e.falhas, 0)    AS falhas,
           coalesce(e.registros, 0) AS registros,
           coalesce(e.latencia, 0)  AS latencia_ms
      FROM calendario c
      LEFT JOIN (
        SELECT iniciado_em::date AS dia, count(*) AS execucoes,
               count(*) FILTER (WHERE status = 'FALHOU') AS falhas,
               sum(registros_lidos) AS registros,
               round(avg(duracao_ms)) AS latencia
          FROM integracao_execucoes GROUP BY 1) e ON e.dia = c.dia
     ORDER BY c.dia`, [dias]);

  return rows.map((r) => {
    const l = r as Record<string, unknown>;
    return {
      dia: l.dia,
      execucoes: Number(l.execucoes),
      falhas: Number(l.falhas),
      registros: Number(l.registros),
      latencia_ms: Number(l.latencia_ms),
    };
  });
}

// ---------------------------------------------------------------------------
// Central de erros (secao 35)
// ---------------------------------------------------------------------------

export async function erros(filtro: {
  status?: string; integracao?: string; tipo?: string; classe?: string;
  limite?: number; pagina?: number;
}) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const add = (sql: string, valor: unknown) => {
    if (valor === undefined || valor === null || valor === '') return;
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  add('e.status = $?::status_erro_integracao_enum', filtro.status);
  add('upper(e.integracao_codigo) = upper($?)', filtro.integracao);
  add('e.tipo = $?::tipo_erro_integracao_enum', filtro.tipo);
  add('e.classe = $?::classe_erro_enum', filtro.classe);

  const limite = Math.min(Math.max(filtro.limite ?? 50, 1), 200);
  const pagina = Math.max(filtro.pagina ?? 1, 1);
  valores.push(limite, (pagina - 1) * limite);

  const { rows } = await query(`
    SELECT e.id, e.integracao_codigo AS integracao, e.entidade, e.linha,
           e.tipo::text AS tipo, e.classe::text AS classe, e.mensagem,
           e.payload, e.tentativa, e.ocorrencias,
           e.causa_provavel, e.origem_diagnostico, e.confianca_diagnostico,
           e.solucao_sugerida, e.confirmado, e.status::text AS status,
           e.created_at, e.resolvido_em, e.observacao,
           u.nome AS resolvido_por_nome, i.nome AS integracao_nome,
           count(*) OVER () AS total
      FROM integracao_erros e
      LEFT JOIN integracoes i ON i.id = e.integracao_id
      LEFT JOIN usuarios u ON u.id = e.resolvido_por
     ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
     ORDER BY CASE WHEN e.status = 'ABERTO' THEN 0 ELSE 1 END,
              e.created_at DESC
     LIMIT $${valores.length - 1} OFFSET $${valores.length}`, valores);

  return {
    total: rows.length ? Number((rows[0] as { total: string }).total) : 0,
    pagina,
    limite,
    erros: rows.map((r) => {
      const { total: _t, ...e } = r as Record<string, unknown>;
      return {
        ...e,
        ocorrencias: Number((e as { ocorrencias: string }).ocorrencias),
        // A secao 35 exige distinguir palpite de fato confirmado. A tela recebe
        // isso mastigado, para nao depender de quem lê interpretar o campo.
        diagnostico_e_palpite: !(e as { confirmado: boolean }).confirmado,
      };
    }),
  };
}

export async function resolverErro(
  id: number, usuarioId: number,
  dados: { status: 'RESOLVIDO' | 'IGNORADO' | 'EM_ANALISE'; observacao?: string | null;
    confirmar_causa?: boolean; },
): Promise<void> {
  if (dados.status === 'IGNORADO' && !dados.observacao?.trim()) {
    throw regraNegocio('Ignorar um erro exige observacao explicando por que');
  }

  const { rowCount } = await query(`
    UPDATE integracao_erros
       SET status = $2::status_erro_integracao_enum,
           observacao = coalesce($3, observacao),
           confirmado = CASE WHEN $4 THEN true ELSE confirmado END,
           resolvido_por = $5,
           resolvido_em = CASE WHEN $2 IN ('RESOLVIDO', 'IGNORADO')
                               THEN now() ELSE resolvido_em END
     WHERE id = $1 AND status <> $2::status_erro_integracao_enum`,
  [id, dados.status, dados.observacao ?? null, dados.confirmar_causa ?? false,
    usuarioId]);

  if (!rowCount) throw regraNegocio('O erro ja esta nesse estado ou nao existe');
}

/**
 * Padroes de erro, para a secao 36: "identificar padroes de erro".
 *
 * Agrupa por tipo e mensagem para mostrar o que se repete. Um erro que
 * aconteceu duzentas vezes e um problema; duzentos erros diferentes sao outro
 * problema - e a tela precisa distinguir os dois.
 */
export async function padroes(dias = 30) {
  const { rows } = await query(`
    SELECT e.tipo::text AS tipo, e.classe::text AS classe,
           e.integracao_codigo AS integracao,
           count(*) AS distintos,
           sum(e.ocorrencias) AS ocorrencias,
           count(*) FILTER (WHERE e.status = 'ABERTO') AS abertos,
           min(e.created_at) AS primeira,
           max(e.created_at) AS ultima,
           (array_agg(e.mensagem ORDER BY e.ocorrencias DESC))[1] AS exemplo,
           (array_agg(e.solucao_sugerida ORDER BY e.ocorrencias DESC))[1] AS solucao
      FROM integracao_erros e
     WHERE e.created_at >= now() - make_interval(days => $1::int)
     GROUP BY e.tipo, e.classe, e.integracao_codigo
     ORDER BY sum(e.ocorrencias) DESC
     LIMIT 50`, [dias]);

  return rows.map((r) => {
    const p = r as Record<string, unknown>;
    return {
      ...p,
      distintos: Number(p.distintos),
      ocorrencias: Number(p.ocorrencias),
      abertos: Number(p.abertos),
      // Muitas ocorrencias do MESMO erro e falha sistematica; muitos erros
      // distintos e instabilidade. A leitura vai junto do numero.
      leitura: Number(p.distintos) === 1 && Number(p.ocorrencias) > 5
        ? 'Falha sistematica: o mesmo erro se repete'
        : Number(p.distintos) > 10
          ? 'Instabilidade: muitos erros diferentes na mesma integracao'
          : 'Ocorrencias isoladas',
    };
  });
}

// ---------------------------------------------------------------------------
// Diagnostico (secoes 33 e 35)
// ---------------------------------------------------------------------------

export interface Sintoma {
  gravidade: 'OK' | 'ATENCAO' | 'CRITICO';
  area: string;
  descricao: string;
  acao: string;
}

/**
 * Procura o que esta errado, inclusive o que esta FALTANDO.
 *
 * Mesma disciplina do modulo 13: integracao quebra em silencio, e uma tela que
 * so mostra erro registrado daria verde para um conector que nunca foi chamado.
 */
export async function diagnostico(): Promise<{
  gravidade: 'OK' | 'ATENCAO' | 'CRITICO'; sintomas: Sintoma[]; verificado_em: string;
}> {
  const sintomas: Sintoma[] = [];
  const painel = await central();

  if (!painel.sincronizacao_ativa) {
    sintomas.push({
      gravidade: 'CRITICO', area: 'agendador',
      descricao: 'As sincronizacoes estao desligadas: nenhuma integracao agendada roda',
      acao: 'Religar em `integracao.sincronizacao_ativa`',
    });
  }

  for (const i of painel.integracoes) {
    if (i.semaforo === 'ERRO') {
      sintomas.push({
        gravidade: 'CRITICO', area: 'integracao',
        descricao: `${i.nome}: ${i.motivo}`,
        acao: i.pendencias.length
          ? `Configurar ${i.pendencias.join(' e ')} ou desativar a integracao`
          : `Ver os erros abertos de ${i.codigo} na central de erros`,
      });
    } else if (i.semaforo === 'ATENCAO') {
      sintomas.push({
        gravidade: 'ATENCAO', area: 'integracao',
        descricao: `${i.nome}: ${i.motivo}`,
        acao: i.dead_letter > 0
          ? 'Analisar as mensagens na dead letter e reprocessar ou cancelar'
          : ['ARQUIVO', 'MANUAL'].includes(i.conector)
            ? 'Esta integracao so recebe dados quando um arquivo e importado; '
              + 'importe um arquivo pela tela de importacoes'
            : i.conector === 'WEBHOOK'
              ? 'Esta integracao espera o sistema externo chamar; confirme com o '
                + 'parceiro que a URL de webhook esta configurada la'
              : 'Conferir se o agendador esta rodando e se o endpoint responde',
      });
    }
  }

  // Credencial vencendo: sem aviso, derruba a integracao numa madrugada e o
  // sintoma aparece como "erro de autenticacao" sem causa aparente.
  const dias = await configNumero('credencial_aviso_dias', 15);
  for (const c of await credenciais.vencendo(dias)) {
    const d = Number(c.dias);
    sintomas.push({
      gravidade: d <= 0 ? 'CRITICO' : 'ATENCAO',
      area: 'credenciais',
      descricao: d <= 0
        ? `A credencial "${c.nome}" de ${c.integracao} VENCEU ha ${Math.abs(d)} dia(s)`
        : `A credencial "${c.nome}" de ${c.integracao} vence em ${d} dia(s)`,
      acao: `Rotacionar a credencial de ${c.integracao} antes do vencimento`,
    });
  }

  // Credencial de outro ambiente: sera recusada no uso (secao 42).
  const ambiente = await credenciais.ambienteDoServidor();
  const { rows: ambienteErrado } = await query<{ integracao: string; ambiente: string }>(`
    SELECT i.codigo AS integracao, c.ambiente::text AS ambiente
      FROM integracao_credenciais c JOIN integracoes i ON i.id = c.integracao_id
     WHERE c.ativo AND i.ativo AND c.ambiente <> $1::ambiente_enum`, [ambiente]);

  for (const c of ambienteErrado) {
    sintomas.push({
      gravidade: 'CRITICO', area: 'credenciais',
      descricao: `A credencial de ${c.integracao} e de ${c.ambiente} e este servidor `
        + `e ${ambiente}: toda sincronizacao sera recusada (secao 42)`,
      acao: `Cadastrar uma credencial de ${ambiente} para ${c.integracao}`,
    });
  }

  const { rows: dead } = await query<{ total: string; integracoes: string }>(`
    SELECT count(*)::text AS total,
           string_agg(DISTINCT integracao_codigo, ', ') AS integracoes
      FROM integracao_mensagens WHERE dead_letter`);
  if (Number(dead[0]?.total ?? 0) > 0) {
    sintomas.push({
      gravidade: 'ATENCAO', area: 'fila',
      descricao: `${dead[0]!.total} mensagem(ns) na dead letter (${dead[0]!.integracoes})`,
      acao: 'Corrigir a causa e reprocessar, ou cancelar as que nao valem mais',
    });
  }

  const { rows: antigas } = await query<{ total: string; horas: string }>(`
    SELECT count(*)::text AS total,
           round(EXTRACT(EPOCH FROM (now() - min(created_at))) / 3600, 1)::text AS horas
      FROM integracao_mensagens
     WHERE status IN ('PENDENTE', 'RETRY') AND NOT dead_letter
       AND disponivel_em <= now()`);
  const pendentes = Number(antigas[0]?.total ?? 0);
  const horas = Number(antigas[0]?.horas ?? 0);
  if (pendentes > 0 && horas >= 2) {
    sintomas.push({
      gravidade: horas >= 12 ? 'CRITICO' : 'ATENCAO',
      area: 'fila',
      descricao: `${pendentes} mensagem(ns) pendente(s), a mais antiga ha ${horas}h`,
      acao: 'Verificar se o job INTEGRACAO_PROCESSAR esta rodando',
    });
  }

  // Importacao parada esperando confirmacao humana ha muito tempo.
  const { rows: aguardando } = await query<{ total: string }>(`
    SELECT count(*)::text AS total FROM importacoes
     WHERE status = 'AGUARDANDO_CONFIRMACAO'
       AND created_at < now() - interval '72 hours'`);
  if (Number(aguardando[0]?.total ?? 0) > 0) {
    sintomas.push({
      gravidade: 'ATENCAO', area: 'importacoes',
      descricao: `${aguardando[0]!.total} importacao(oes) ha mais de 72h aguardando `
        + 'confirmacao: o arquivo foi enviado e ninguem confirmou',
      acao: 'Revisar a pre-visualizacao e confirmar ou cancelar',
    });
  }

  const { rows: divergencias } = await query<{ total: string }>(`
    SELECT count(*)::text AS total FROM conciliacoes WHERE status = 'DIVERGENTE'`);
  if (Number(divergencias[0]?.total ?? 0) > 0) {
    sintomas.push({
      gravidade: 'ATENCAO', area: 'conciliacao',
      descricao: `${divergencias[0]!.total} divergencia(s) de conciliacao sem decisao`,
      acao: 'Analisar na tela de conciliacoes; nenhum valor foi corrigido '
        + 'automaticamente (secao 34)',
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
// Log de integracao (secao 32)
// ---------------------------------------------------------------------------

export async function execucoes(filtro: {
  integracao?: string; status?: string; tipo?: string; entidade?: string;
  desde?: string; ate?: string; limite?: number; pagina?: number;
}) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const add = (sql: string, valor: unknown) => {
    if (valor === undefined || valor === null || valor === '') return;
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  add('upper(x.integracao_codigo) = upper($?)', filtro.integracao);
  add('x.status = $?::status_execucao_integracao_enum', filtro.status);
  add('x.tipo = $?::tipo_execucao_integracao_enum', filtro.tipo);
  add('x.entidade = $?', filtro.entidade);
  add('x.iniciado_em >= $?::timestamptz', filtro.desde);
  add('x.iniciado_em <= $?::timestamptz', filtro.ate);

  const limite = Math.min(Math.max(filtro.limite ?? 50, 1), 200);
  const pagina = Math.max(filtro.pagina ?? 1, 1);
  valores.push(limite, (pagina - 1) * limite);

  const { rows } = await query(`
    SELECT x.id, x.integracao_codigo AS integracao, x.tipo::text AS tipo,
           x.direcao::text AS direcao, x.entidade, x.status::text AS status,
           x.modo::text AS modo, x.ambiente::text AS ambiente,
           x.iniciado_em, x.concluido_em, x.duracao_ms,
           x.registros_lidos, x.registros_criados, x.registros_atualizados,
           x.registros_descartados, x.registros_rejeitados,
           x.correlation_id::text AS correlation_id, x.disparado_por,
           x.resumo, x.erro, u.nome AS usuario,
           count(*) OVER () AS total
      FROM integracao_execucoes x
      LEFT JOIN usuarios u ON u.id = x.usuario_id
     ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
     ORDER BY x.iniciado_em DESC
     LIMIT $${valores.length - 1} OFFSET $${valores.length}`, valores);

  return {
    total: rows.length ? Number((rows[0] as { total: string }).total) : 0,
    pagina,
    limite,
    execucoes: rows.map((r) => {
      const { total: _t, ...x } = r as Record<string, unknown>;
      return x;
    }),
  };
}

export async function mensagens(filtro: {
  integracao?: string; entidade?: string; status?: string; dead_letter?: boolean;
  limite?: number; pagina?: number;
}) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const add = (sql: string, valor: unknown) => {
    if (valor === undefined || valor === null || valor === '') return;
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  add('upper(m.integracao_codigo) = upper($?)', filtro.integracao);
  add('m.entidade = $?', filtro.entidade);
  add('m.status = $?::status_mensagem_enum', filtro.status);
  if (filtro.dead_letter !== undefined) add('m.dead_letter = $?', filtro.dead_letter);

  const limite = Math.min(Math.max(filtro.limite ?? 50, 1), 200);
  const pagina = Math.max(filtro.pagina ?? 1, 1);
  valores.push(limite, (pagina - 1) * limite);

  const { rows } = await query(`
    SELECT m.id, m.integracao_codigo AS integracao, m.direcao::text AS direcao,
           m.entidade, m.origem::text AS origem, m.chave_externa,
           left(m.hash_conteudo, 12) AS hash, m.status::text AS status,
           m.tentativa, m.max_tentativas, m.dead_letter, m.disponivel_em,
           m.entidade_destino, m.registro_id, m.acao_aplicada, m.erro,
           m.created_at, m.processado_em,
           count(*) OVER () AS total
      FROM integracao_mensagens m
     ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
     ORDER BY m.created_at DESC
     LIMIT $${valores.length - 1} OFFSET $${valores.length}`, valores);

  return {
    total: rows.length ? Number((rows[0] as { total: string }).total) : 0,
    pagina,
    limite,
    mensagens: rows.map((r) => {
      const { total: _t, ...m } = r as Record<string, unknown>;
      return m;
    }),
  };
}

export async function obterMensagem(id: number) {
  const { rows } = await query(`
    SELECT m.*, m.status::text AS status, m.direcao::text AS direcao,
           m.origem::text AS origem, m.correlation_id::text AS correlation_id
      FROM integracao_mensagens m WHERE m.id = $1`, [id]);
  if (!rows.length) throw naoEncontrado('Mensagem');
  return rows[0];
}

// ---------------------------------------------------------------------------
// Reprocessamento (secoes 31 e 43)
// ---------------------------------------------------------------------------

export async function reprocessar(
  id: number,
): Promise<{ id: number; status: string; observacao: string }> {
  const { rows } = await query<{ status: string; dead_letter: boolean }>(
    'SELECT status::text AS status, dead_letter FROM integracao_mensagens WHERE id = $1',
    [id]);

  if (!rows.length) throw naoEncontrado('Mensagem');
  if (rows[0]!.status === 'SUCESSO') {
    throw regraNegocio(
      'A mensagem ja foi processada com sucesso. Reprocessar criaria duplicata: '
      + 'se o dado mudou na origem, ele entra na proxima sincronizacao.');
  }

  await query(`
    UPDATE integracao_mensagens
       SET status = 'PENDENTE', tentativa = 0, dead_letter = false,
           disponivel_em = now(), erro = NULL
     WHERE id = $1`, [id]);

  return {
    id,
    status: 'PENDENTE',
    observacao: 'A mensagem voltou para a fila com as tentativas zeradas. '
      + 'Ela sera processada no proximo ciclo do worker.',
  };
}

export async function cancelarMensagem(id: number, motivo: string): Promise<void> {
  if (!motivo?.trim()) throw regraNegocio('Cancelar uma mensagem exige motivo');
  const { rowCount } = await query(`
    UPDATE integracao_mensagens
       SET status = 'CANCELADA', erro = $2, processado_em = now()
     WHERE id = $1 AND status <> 'SUCESSO'`, [id, motivo.trim()]);
  if (!rowCount) {
    throw regraNegocio('A mensagem ja foi processada com sucesso ou nao existe');
  }
}
