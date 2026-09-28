/**
 * Notificacoes multicanal (secoes 25, 26, 27 e 28).
 *
 * Aqui mora a diferenca entre avisar e incomodar. Tres decisoes sustentam isso:
 *
 * 1. Deduplicacao por `chave_dedup`. O mesmo fato notifica uma vez, nao uma vez
 *    por ciclo do worker. Sem isso o usuario aprende a ignorar o sino - e um
 *    sistema de alerta ignorado e pior que nenhum, porque da falsa seguranca.
 *
 * 2. Destino por perfil, resolvido no momento do envio. A regra diz "avise o
 *    comprador"; quem e o comprador hoje o banco responde. Regra nao guarda
 *    nome de pessoa, que muda.
 *
 * 3. Canal SISTEMA entrega na hora; EMAIL, WHATSAPP e WEBHOOK nascem PENDENTE
 *    e esperam o despachante. Nenhum provedor externo esta configurado nesta
 *    fase, e a fila registra isso honestamente em vez de fingir envio.
 */
import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { ligado } from './config.js';

export type Canal = 'SISTEMA' | 'EMAIL' | 'WHATSAPP' | 'WEBHOOK';
export type StatusNotificacao = 'PENDENTE' | 'ENVIADA' | 'FALHOU' | 'DESCARTADA';

export interface EntradaNotificacao {
  titulo: string;
  mensagem?: string | null;
  tipo?: string | null;
  canal?: Canal;
  /** Destino explicito. Quando ausente, `perfil` resolve os destinatarios. */
  usuario_id?: number | null;
  perfil?: string | null;
  link?: string | null;
  alerta_id?: number | null;
  correlation_id?: string | null;
  chave?: string | null;
}

export interface ResultadoNotificacao {
  criadas: number;
  duplicadas: number;
  destinatarios: number[];
  canal: Canal;
  motivo_sem_destino?: string;
}

/** Usuarios ativos de um perfil. Vazio e um resultado legitimo, nao um erro. */
export async function destinatariosDoPerfil(perfil: string): Promise<number[]> {
  const { rows } = await query<{ id: string }>(`
    SELECT u.id
      FROM usuarios u
      JOIN perfis p ON p.id = u.perfil_id
     WHERE u.ativo AND u.deleted_at IS NULL AND p.ativo
       AND upper(p.nome) = upper($1)
     ORDER BY u.id`, [perfil]);
  return rows.map((r) => Number(r.id));
}

/**
 * Cria a notificacao para cada destinatario.
 *
 * A chave de deduplicacao ganha o sufixo do usuario: o mesmo fato notifica cada
 * pessoa uma vez, e nao uma pessoa so porque a chave ja estava tomada.
 *
 * O canal SISTEMA ja nasce ENVIADA porque a entrega e a propria linha no banco -
 * nao existe passo posterior que possa falhar. Para os outros canais, marcar
 * ENVIADA aqui seria mentira.
 */
export async function notificar(
  entrada: EntradaNotificacao, contexto: ContextoSessao,
): Promise<ResultadoNotificacao> {
  const canal: Canal = entrada.canal ?? 'SISTEMA';

  let destinos: number[];
  if (entrada.usuario_id) {
    destinos = [entrada.usuario_id];
  } else if (entrada.perfil) {
    destinos = await destinatariosDoPerfil(entrada.perfil);
  } else {
    destinos = [];
  }

  if (!destinos.length) {
    return {
      criadas: 0,
      duplicadas: 0,
      destinatarios: [],
      canal,
      motivo_sem_destino: entrada.perfil
        ? `Nenhum usuario ativo com o perfil ${entrada.perfil}`
        : 'Notificacao sem usuario nem perfil de destino',
    };
  }

  const statusInicial: StatusNotificacao = canal === 'SISTEMA' ? 'ENVIADA' : 'PENDENTE';

  return comTransacao(contexto, async (cliente) => {
    let criadas = 0;
    let duplicadas = 0;

    for (const usuarioId of destinos) {
      const chave = entrada.chave ? `${entrada.chave}:u${usuarioId}` : null;
      const { rows } = await cliente.query<{ id: string }>(`
        INSERT INTO notificacoes
          (usuario_id, alerta_id, titulo, mensagem, canal, tipo, status,
           enviada_em, correlation_id, chave_dedup, link)
        VALUES ($1, $2, $3, $4, $5::canal_notificacao_enum, $6,
                $7::status_notificacao_enum,
                CASE WHEN $7 = 'ENVIADA' THEN now() END,
                $8::uuid, $9, $10)
        ON CONFLICT (chave_dedup) WHERE chave_dedup IS NOT NULL
        DO NOTHING
        RETURNING id`,
      [usuarioId, entrada.alerta_id ?? null, entrada.titulo,
        entrada.mensagem ?? null, canal, entrada.tipo ?? null, statusInicial,
        entrada.correlation_id ?? null, chave, entrada.link ?? null]);

      if (rows.length) criadas += 1;
      else duplicadas += 1;
    }

    return { criadas, duplicadas, destinatarios: destinos, canal };
  });
}

/**
 * Notifica so se a configuracao permitir (secao 27).
 *
 * Usada pelas notificacoes de infraestrutura - job falhou, automacao falhou -
 * que sao exatamente as que mais irritam quando algo esta quebrado em serie.
 */
export async function notificarSePermitido(
  entrada: EntradaNotificacao, contexto: ContextoSessao,
): Promise<ResultadoNotificacao> {
  if (!await ligado('notificar_falhas', true)) {
    return {
      criadas: 0, duplicadas: 0, destinatarios: [], canal: entrada.canal ?? 'SISTEMA',
      motivo_sem_destino: 'Notificacao de falhas desligada em automacao.notificar_falhas',
    };
  }
  return notificar(entrada, contexto);
}

/**
 * Tenta despachar as notificacoes de canal externo (secao 26).
 *
 * Nao existe provedor de e-mail ou WhatsApp configurado nesta fase. O honesto e
 * registrar a tentativa e o motivo, deixando a notificacao PENDENTE para quando
 * a integracao existir - e nao marcar FALHOU, que sugeriria erro de entrega, nem
 * ENVIADA, que seria falso. Quem plugar o provedor troca somente este corpo.
 */
export async function despachar(limite = 50): Promise<{
  avaliadas: number; enviadas: number; pendentes: number; motivo: string;
}> {
  const { rows } = await query<{ id: string; canal: string }>(`
    SELECT id, canal::text AS canal
      FROM notificacoes
     WHERE status = 'PENDENTE'
     ORDER BY created_at
     LIMIT $1`, [limite]);

  if (rows.length) {
    await query(`
      UPDATE notificacoes
         SET tentativas = tentativas + 1,
             erro = 'Canal externo sem provedor configurado nesta fase'
       WHERE id = ANY($1::bigint[])`, [rows.map((r) => Number(r.id))]);
  }

  return {
    avaliadas: rows.length,
    enviadas: 0,
    pendentes: rows.length,
    motivo: 'Nenhum provedor de e-mail, WhatsApp ou webhook de saida configurado; '
      + 'as notificacoes permanecem PENDENTE ate a integracao do modulo 14',
  };
}

export async function listar(filtro: {
  usuario_id?: number; lida?: boolean; canal?: string; status?: string;
  limite?: number; pagina?: number;
}) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const add = (sql: string, valor: unknown) => {
    if (valor === undefined || valor === null || valor === '') return;
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  add('n.usuario_id = $?', filtro.usuario_id);
  if (filtro.lida !== undefined) add('n.lida = $?', filtro.lida);
  add('n.canal = $?::canal_notificacao_enum', filtro.canal);
  add('n.status = $?::status_notificacao_enum', filtro.status);

  const limite = Math.min(Math.max(filtro.limite ?? 50, 1), 200);
  const pagina = Math.max(filtro.pagina ?? 1, 1);
  valores.push(limite, (pagina - 1) * limite);

  const { rows } = await query(`
    SELECT n.id, n.titulo, n.mensagem, n.canal::text AS canal, n.tipo,
           n.status::text AS status, n.lida, n.data_leitura, n.link,
           n.correlation_id::text AS correlation_id, n.tentativas, n.erro,
           n.created_at, n.enviada_em, u.nome AS usuario,
           count(*) OVER () AS total
      FROM notificacoes n
      JOIN usuarios u ON u.id = n.usuario_id
     ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT $${valores.length - 1} OFFSET $${valores.length}`, valores);

  return {
    total: rows.length ? Number((rows[0] as { total: string }).total) : 0,
    pagina,
    limite,
    notificacoes: rows.map((r) => {
      const { total: _t, ...n } = r as Record<string, unknown>;
      return n;
    }),
  };
}

export async function marcarLida(id: number, usuarioId: number): Promise<boolean> {
  // O filtro por usuario nao e cosmetico: sem ele um usuario marcaria como lida
  // a notificacao de outro, que e leitura indevida de dado alheio.
  const { rowCount } = await query(`
    UPDATE notificacoes
       SET lida = true, data_leitura = now()
     WHERE id = $1 AND usuario_id = $2 AND NOT lida`, [id, usuarioId]);
  return (rowCount ?? 0) > 0;
}

export async function marcarTodasLidas(usuarioId: number): Promise<number> {
  const { rowCount } = await query(`
    UPDATE notificacoes
       SET lida = true, data_leitura = now()
     WHERE usuario_id = $1 AND NOT lida`, [usuarioId]);
  return rowCount ?? 0;
}

export async function naoLidas(usuarioId: number): Promise<number> {
  const { rows } = await query<{ total: string }>(
    'SELECT count(*) AS total FROM notificacoes WHERE usuario_id = $1 AND NOT lida',
    [usuarioId]);
  return Number(rows[0]!.total);
}
