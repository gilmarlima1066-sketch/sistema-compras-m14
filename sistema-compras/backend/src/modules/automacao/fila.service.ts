/**
 * Fila de processamento com retry, backoff e fila morta (secoes 23 e 24).
 *
 * A fila mora no PostgreSQL. A razao pratica: enfileirar a tarefa e gravar o
 * dado que a originou acontecem na MESMA transacao. Se a compra nao for
 * gravada, a tarefa dela nao existe. Com uma fila externa as duas coisas podem
 * divergir - e divergem justamente quando algo da errado, que e quando menos
 * se pode ter surpresa.
 *
 * O consumo usa `FOR UPDATE SKIP LOCKED`: cada worker pega itens que ninguem
 * mais travou, sem lock global e sem corrida. E o padrao que torna uma tabela
 * uma fila de verdade, com varios consumidores.
 *
 * O backoff nao usa `sleep`. Um item que falhou volta para a fila com
 * `disponivel_em` no futuro; o worker simplesmente nao o enxerga ate la. Assim
 * nenhuma thread fica bloqueada e reiniciar o processo nao perde o atraso.
 */
import { comTransacao, pool, query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';

export type StatusFila =
  | 'PENDENTE' | 'PROCESSANDO' | 'CONCLUIDO' | 'ERRO' | 'RETRY' | 'CANCELADO';

export interface ItemFila {
  id: number;
  evento_id: number | null;
  regra_id: number | null;
  acao: string;
  parametros: Record<string, unknown>;
  correlation_id: string;
  tentativa: number;
  max_tentativas: number;
}

export interface Enfileirar {
  evento_id?: number | null;
  regra_id?: number | null;
  acao: string;
  parametros?: Record<string, unknown>;
  correlation_id: string;
  prioridade?: number;
  max_tentativas?: number;
  /** Atraso inicial, para acoes que nao precisam rodar agora. */
  atraso_segundos?: number;
}

export async function enfileirar(
  entrada: Enfileirar, contexto: ContextoSessao,
): Promise<{ id: number }> {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query<{ id: string }>(`
      INSERT INTO automacao_fila
        (evento_id, regra_id, acao, parametros, correlation_id, prioridade,
         max_tentativas, disponivel_em)
      VALUES ($1, $2, $3, $4::jsonb, $5::uuid, $6, $7,
              now() + make_interval(secs => $8::int))
      RETURNING id`,
    [entrada.evento_id ?? null, entrada.regra_id ?? null, entrada.acao,
      JSON.stringify(entrada.parametros ?? {}), entrada.correlation_id,
      entrada.prioridade ?? 100, entrada.max_tentativas ?? 3,
      entrada.atraso_segundos ?? 0]);
    return { id: Number(rows[0]!.id) };
  });
}

/**
 * Reserva itens da fila para este worker.
 *
 * `FOR UPDATE SKIP LOCKED` e o coracao: dois workers rodando ao mesmo tempo
 * pegam conjuntos diferentes, sem bloquear um ao outro e sem processar o mesmo
 * item duas vezes. A reserva e uma transacao curtissima - so marca PROCESSANDO
 * - para nao segurar lock enquanto a acao roda, que pode demorar.
 */
export async function reservar(lote: number): Promise<ItemFila[]> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query<Record<string, unknown>>(`
      WITH proximos AS (
        SELECT id FROM automacao_fila
         WHERE status IN ('PENDENTE', 'RETRY')
           AND NOT dead_letter
           AND disponivel_em <= now()
         ORDER BY prioridade, disponivel_em, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      UPDATE automacao_fila f
         SET status = 'PROCESSANDO',
             tentativa = f.tentativa + 1,
             iniciado_em = now()
        FROM proximos p
       WHERE f.id = p.id
      RETURNING f.id, f.evento_id, f.regra_id, f.acao, f.parametros,
                f.correlation_id::text AS correlation_id, f.tentativa, f.max_tentativas`,
    [lote]);
    await cliente.query('COMMIT');

    return rows.map((r) => ({
      id: Number(r.id),
      evento_id: r.evento_id === null ? null : Number(r.evento_id),
      regra_id: r.regra_id === null ? null : Number(r.regra_id),
      acao: String(r.acao),
      parametros: (r.parametros as Record<string, unknown>) ?? {},
      correlation_id: String(r.correlation_id),
      tentativa: Number(r.tentativa),
      max_tentativas: Number(r.max_tentativas),
    }));
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    cliente.release();
  }
}

export async function concluir(
  item: ItemFila, resultado: Record<string, unknown>, duracaoMs: number,
): Promise<void> {
  await query(`
    UPDATE automacao_fila
       SET status = 'CONCLUIDO', concluido_em = now(), duracao_ms = $2,
           resultado = $3::jsonb, erro = NULL
     WHERE id = $1`, [item.id, duracaoMs, JSON.stringify(resultado)]);

  await registrarExecucao(item, 'CONCLUIDO', duracaoMs, resultado, null);
}

/**
 * Backoff exponencial com teto: 30s, 60s, 120s, 240s... ate o maximo.
 *
 * Exponencial porque a causa mais comum de falha e indisponibilidade temporaria
 * - e insistir no mesmo ritmo contra um servico caido so multiplica a carga
 * sobre ele. O teto evita que a quinta tentativa caia daqui a dois dias.
 */
export function intervaloBackoff(
  tentativa: number, base: number, maximo: number,
): number {
  return Math.min(maximo, base * 2 ** Math.max(0, tentativa - 1));
}

export async function falhar(
  item: ItemFila, erro: string, duracaoMs: number,
  backoffBase: number, backoffMaximo: number,
): Promise<{ dead_letter: boolean; proxima_em: number | null }> {
  const esgotou = item.tentativa >= item.max_tentativas;

  if (esgotou) {
    await query(`
      UPDATE automacao_fila
         SET status = 'ERRO', dead_letter = TRUE, concluido_em = now(),
             duracao_ms = $2, erro = $3
       WHERE id = $1`, [item.id, duracaoMs, erro.slice(0, 2000)]);
    await registrarExecucao(item, 'ERRO', duracaoMs, null, erro);
    return { dead_letter: true, proxima_em: null };
  }

  const espera = intervaloBackoff(item.tentativa, backoffBase, backoffMaximo);
  await query(`
    UPDATE automacao_fila
       SET status = 'RETRY', duracao_ms = $2, erro = $3,
           disponivel_em = now() + make_interval(secs => $4::int)
     WHERE id = $1`, [item.id, duracaoMs, erro.slice(0, 2000), espera]);
  await registrarExecucao(item, 'RETRY', duracaoMs, null, erro);
  return { dead_letter: false, proxima_em: espera };
}

/**
 * Grava a execucao no historico append-only.
 *
 * Exportada porque nem toda execucao vem da fila: a tela de operacao executa
 * uma acao avulsa para testar uma regra, e essa tentativa precisa aparecer no
 * mesmo historico. Duas funcoes de insercao darian dois formatos de registro na
 * mesma tabela, e a auditoria passaria a depender de qual caminho foi usado.
 */
export async function registrarExecucaoDireta(entrada: {
  fila_id: number | null; regra_id: number | null; evento_id: number | null;
  correlation_id: string; acao: string; status: StatusFila; tentativa: number;
  duracao_ms: number; resultado: unknown; erro: string | null;
  usuario_id?: number | null;
}): Promise<void> {
  // Codigo, versao e tipo de evento sao copiados no momento da insercao, pelos
  // subselects, e nao por uma leitura previa em JavaScript: assim a linha nasce
  // com a identidade certa em uma unica ida ao banco, e continua legivel depois
  // que a regra for editada ou o evento expurgado (migration 046).
  await query(`
    INSERT INTO automacao_execucoes
      (fila_id, regra_id, evento_id, correlation_id, acao, status, tentativa,
       concluido_em, duracao_ms, resultado, erro, usuario_id,
       regra_codigo, regra_versao, evento_tipo)
    VALUES ($1,$2,$3,$4::uuid,$5,$6::status_execucao_automacao_enum,$7,
            now(),$8,$9::jsonb,$10,$11,
            (SELECT codigo FROM automacao_regras WHERE id = $2),
            (SELECT versao FROM automacao_regras WHERE id = $2),
            (SELECT tipo   FROM eventos          WHERE id = $3))`,
  [entrada.fila_id, entrada.regra_id, entrada.evento_id, entrada.correlation_id,
    entrada.acao, entrada.status, entrada.tentativa, entrada.duracao_ms,
    entrada.resultado === null || entrada.resultado === undefined
      ? null : JSON.stringify(entrada.resultado),
    entrada.erro?.slice(0, 2000) ?? null, entrada.usuario_id ?? null]);
}

async function registrarExecucao(
  item: ItemFila, status: StatusFila, duracaoMs: number,
  resultado: Record<string, unknown> | null, erro: string | null,
): Promise<void> {
  await registrarExecucaoDireta({
    fila_id: item.id, regra_id: item.regra_id, evento_id: item.evento_id,
    correlation_id: item.correlation_id, acao: item.acao, status,
    tentativa: item.tentativa, duracao_ms: duracaoMs, resultado, erro,
  });
}

/**
 * Devolve a fila morta ao processamento (secao 24).
 *
 * Zera a contagem de tentativas: o reprocessamento manual acontece depois que
 * alguem corrigiu a causa, e manter a contagem antiga faria o item morrer na
 * primeira tentativa nova.
 */
export async function reprocessar(
  id: number, contexto: ContextoSessao,
): Promise<Record<string, unknown>> {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query<{ dead_letter: boolean; status: string }>(
      'SELECT dead_letter, status::text AS status FROM automacao_fila WHERE id = $1 FOR UPDATE',
      [id]);
    if (!rows.length) throw naoEncontrado('Item da fila');
    if (rows[0]!.status === 'PROCESSANDO') {
      throw regraNegocio('O item esta sendo processado agora; aguarde o fim da tentativa');
    }

    const { rows: atualizado } = await cliente.query(`
      UPDATE automacao_fila
         SET status = 'PENDENTE', dead_letter = FALSE, tentativa = 0,
             disponivel_em = now(), erro = NULL, concluido_em = NULL
       WHERE id = $1
      RETURNING id, acao, status::text AS status, tentativa`, [id]);
    return atualizado[0] as Record<string, unknown>;
  });
}

export async function cancelar(id: number, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(`
      UPDATE automacao_fila
         SET status = 'CANCELADO', concluido_em = now()
       WHERE id = $1 AND status <> 'PROCESSANDO'
      RETURNING id, acao, status::text AS status`, [id]);
    if (!rows.length) {
      throw regraNegocio('Item nao encontrado ou em processamento');
    }
    return rows[0];
  });
}

/**
 * Solta itens travados em PROCESSANDO (secao 24).
 *
 * Um worker derrubado no meio da acao deixa o item preso para sempre. Passado o
 * timeout, ele volta para a fila. Continua contando como tentativa - a acao
 * pode ter chegado a rodar parcialmente, e insistir sem limite num item que
 * derruba o worker seria pior.
 */
export async function liberarTravados(timeoutSegundos: number) {
  // O CASE abaixo produz texto, e sem o cast explicito o Postgres recusa a
  // atribuicao ao enum. Este caminho so roda quando existe item travado, entao
  // o defeito ficava escondido justamente na rotina de recuperacao - a que
  // precisa funcionar quando o resto ja falhou.
  const { rows } = await query<{ id: string }>(`
    UPDATE automacao_fila
       SET status = (CASE WHEN tentativa >= max_tentativas
                          THEN 'ERRO' ELSE 'RETRY' END)::status_execucao_automacao_enum,
           dead_letter = tentativa >= max_tentativas,
           erro = 'Execucao interrompida: o worker nao concluiu dentro do tempo limite',
           disponivel_em = now()
     WHERE status = 'PROCESSANDO'
       AND iniciado_em < now() - make_interval(secs => $1::int)
    RETURNING id`, [timeoutSegundos]);
  return { liberados: rows.length };
}

export async function estatisticas() {
  const { rows } = await query<Record<string, unknown>>(`
    SELECT status::text AS status, count(*) AS total,
           count(*) FILTER (WHERE dead_letter) AS mortos
      FROM automacao_fila GROUP BY 1`);

  const porStatus: Record<string, number> = {
    PENDENTE: 0, PROCESSANDO: 0, CONCLUIDO: 0, ERRO: 0, RETRY: 0, CANCELADO: 0,
  };
  let mortos = 0;
  for (const r of rows) {
    porStatus[String(r.status)] = Number(r.total);
    mortos += Number(r.mortos);
  }

  const { rows: tempos } = await query<Record<string, unknown>>(`
    SELECT round(avg(duracao_ms))::int AS media_ms,
           max(duracao_ms)             AS maior_ms,
           count(*)                    AS concluidas
      FROM automacao_fila
     WHERE status = 'CONCLUIDO' AND concluido_em >= now() - interval '24 hours'`);

  const { rows: aguardando } = await query<{ n: string; mais_antigo: string | null }>(`
    SELECT count(*) AS n, min(disponivel_em)::text AS mais_antigo
      FROM automacao_fila
     WHERE status IN ('PENDENTE','RETRY') AND NOT dead_letter AND disponivel_em <= now()`);

  return {
    por_status: porStatus,
    fila_morta: mortos,
    aguardando_agora: Number(aguardando[0]?.n ?? 0),
    mais_antigo_aguardando: aguardando[0]?.mais_antigo ?? null,
    ultimas_24h: {
      concluidas: Number(tempos[0]?.concluidas ?? 0),
      duracao_media_ms: tempos[0]?.media_ms ?? null,
      maior_duracao_ms: tempos[0]?.maior_ms ?? null,
    },
  };
}

export interface FiltroFila {
  status?: string;
  acao?: string;
  dead_letter?: boolean;
  correlation_id?: string;
  limite?: number;
  pagina?: number;
}

export async function listar(filtro: FiltroFila) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const add = (sql: string, valor: unknown) => {
    if (valor === undefined || valor === null || valor === '') return;
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };
  add('f.status = $?::status_execucao_automacao_enum', filtro.status);
  add('f.acao = $?', filtro.acao);
  add('f.correlation_id = $?::uuid', filtro.correlation_id);
  if (filtro.dead_letter !== undefined) {
    valores.push(filtro.dead_letter);
    cond.push(`f.dead_letter = $${valores.length}`);
  }

  const limite = Math.min(Math.max(filtro.limite ?? 50, 1), 200);
  const pagina = Math.max(filtro.pagina ?? 1, 1);
  valores.push(limite, (pagina - 1) * limite);

  const { rows } = await query(`
    SELECT f.id, f.acao, f.parametros, f.status::text AS status, f.tentativa,
           f.max_tentativas, f.dead_letter, f.prioridade, f.disponivel_em,
           f.iniciado_em, f.concluido_em, f.duracao_ms, f.erro, f.resultado,
           f.correlation_id::text AS correlation_id,
           r.codigo AS regra, e.tipo AS evento,
           count(*) OVER () AS total
      FROM automacao_fila f
      LEFT JOIN automacao_regras r ON r.id = f.regra_id
      LEFT JOIN eventos e          ON e.id = f.evento_id
     ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT $${valores.length - 1} OFFSET $${valores.length}`, valores);

  return {
    total: rows.length ? Number((rows[0] as { total: string }).total) : 0,
    pagina,
    limite,
    itens: rows.map((r) => {
      const { total: _t, ...i } = r as Record<string, unknown>;
      return i;
    }),
  };
}
