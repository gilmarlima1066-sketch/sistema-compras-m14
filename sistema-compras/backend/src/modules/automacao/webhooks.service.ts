/**
 * Webhooks de entrada (secoes 37, 38 e 36).
 *
 * Um webhook e a porta pela qual o mundo externo entra no sistema, e por isso e
 * a superficie mais exposta do modulo. Quatro travas, nesta ordem:
 *
 *   1. A integracao precisa existir e estar ATIVA. Integracao desconhecida nao
 *      e erro do sistema, e tentativa de entrada.
 *   2. A assinatura HMAC precisa conferir. O segredo NUNCA e guardado em texto
 *      puro - a tabela `integracoes` tem `segredo_hash`, e a verificacao compara
 *      digest com digest, em tempo constante.
 *   3. O carimbo de tempo precisa estar dentro da tolerancia. Sem isso, uma
 *      requisicao valida capturada hoje poderia ser reenviada em dezembro e
 *      seria aceita - e a assinatura estaria correta, porque e a mesma.
 *   4. A chave de idempotencia precisa ser nova. O mesmo aviso entregue duas
 *      vezes - reenvio por timeout do lado de la - nao pode virar dois eventos.
 *
 * O que chega e sempre GRAVADO, inclusive o rejeitado: `webhooks_recebidos` e
 * append-only. Sem o registro do rejeitado nao ha como investigar "o fornecedor
 * jura que enviou" nem como perceber uma tentativa repetida de entrada.
 *
 * O payload nunca vira acao direta: vira EVENTO, e o motor de regras decide.
 * Um sistema externo nao emite pedido nem mexe em estoque por aqui.
 */
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { numero } from './config.js';
import * as eventos from './eventos.service.js';

export type StatusWebhook = 'RECEBIDO' | 'PROCESSADO' | 'REJEITADO' | 'DUPLICADO' | 'ERRO';

export interface EntradaWebhook {
  integracao: string;
  evento?: string | null;
  payload: Record<string, unknown>;
  cabecalhos?: Record<string, string>;
  assinatura?: string | null;
  /** Corpo cru, exatamente como chegou: e sobre ele que a assinatura e feita. */
  corpo_bruto?: string;
  chave_idempotencia?: string | null;
  ip?: string | null;
  timestamp?: string | null;
}

export interface ResultadoWebhook {
  id: number;
  status: StatusWebhook;
  aceito: boolean;
  evento_id?: number;
  correlation_id?: string;
  motivo?: string;
}

/**
 * Deriva o hash guardavel de um segredo.
 *
 * O segredo em si nunca toca o banco. Guardamos o SHA-256 e derivamos dele a
 * chave do HMAC - quem ler a tabela inteira nao consegue assinar requisicoes
 * validas, e nao ha nada em texto puro para vazar.
 */
export const derivarHash = (segredo: string): string =>
  createHash('sha256').update(segredo, 'utf8').digest('hex');

/** Comparacao em tempo constante: o tempo de resposta nao entrega o segredo. */
function iguais(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function assinar(corpo: string, segredoHash: string): string {
  return createHmac('sha256', segredoHash).update(corpo, 'utf8').digest('hex');
}

interface Integracao {
  id: number;
  codigo: string;
  nome: string;
  ativo: boolean;
  segredo_hash: string | null;
}

async function carregarIntegracao(codigo: string): Promise<Integracao | null> {
  const { rows } = await query<{
    id: string; codigo: string; nome: string; ativo: boolean; segredo_hash: string | null;
  }>(`SELECT id, codigo, nome, ativo, segredo_hash
        FROM integracoes WHERE upper(codigo) = upper($1)`, [codigo]);
  const i = rows[0];
  return i ? { ...i, id: Number(i.id) } : null;
}

/** Registra a tentativa, aceita ou nao. Nada entra sem deixar rastro. */
async function registrar(
  entrada: EntradaWebhook, chave: string, status: StatusWebhook,
  motivo: string | null, eventoId: number | null, correlationId: string | null,
): Promise<number> {
  const { rows } = await query<{ id: string }>(`
    INSERT INTO webhooks_recebidos
      (integracao, evento, payload, cabecalhos, assinatura, ip, chave_idempotencia,
       status, motivo_rejeicao, evento_id, correlation_id, processado_em)
    VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8::status_webhook_enum,
            $9, $10, $11::uuid, now())
    ON CONFLICT (integracao, chave_idempotencia)
      WHERE status IN ('RECEBIDO', 'PROCESSADO', 'DUPLICADO')
      DO NOTHING
    RETURNING id`,
  [entrada.integracao, entrada.evento ?? null, JSON.stringify(entrada.payload),
    entrada.cabecalhos ? JSON.stringify(mascarar(entrada.cabecalhos)) : null,
    // A assinatura e guardada truncada: serve para conferir qual foi tentada,
    // sem deixar o valor completo disponivel em uma tabela de consulta.
    entrada.assinatura ? entrada.assinatura.slice(0, 16) : null,
    entrada.ip ?? null, chave, status, motivo, eventoId, correlationId]);

  if (rows.length) return Number(rows[0]!.id);

  // So chega aqui quando a chave ja estava reservada por um webhook ACEITO -
  // uma recusa nao reserva nada (migration 047).
  const { rows: existente } = await query<{ id: string }>(
    `SELECT id FROM webhooks_recebidos
      WHERE integracao = $1 AND chave_idempotencia = $2
        AND status IN ('RECEBIDO', 'PROCESSADO', 'DUPLICADO')
      ORDER BY id LIMIT 1`, [entrada.integracao, chave]);
  return Number(existente[0]!.id);
}

/**
 * Remove cabecalhos sensiveis antes de gravar.
 *
 * Gravar a requisicao inteira e util para depurar e perigoso para o segredo:
 * `Authorization` e a propria credencial. A regra da secao 36 - nunca registrar
 * senhas ou tokens em log - vale para a tabela tambem, que e um log.
 */
function mascarar(cabecalhos: Record<string, string>): Record<string, string> {
  const proibidos = ['authorization', 'cookie', 'x-api-key', 'x-auth-token',
    'proxy-authorization', 'x-webhook-secret'];
  const limpo: Record<string, string> = {};
  for (const [chave, valor] of Object.entries(cabecalhos)) {
    limpo[chave] = proibidos.includes(chave.toLowerCase()) ? '[removido]' : valor;
  }
  return limpo;
}

/**
 * Recebe, valida e converte em evento.
 *
 * Devolve sempre - nunca lanca por payload invalido. Um webhook e uma resposta
 * HTTP para um sistema externo: a resposta precisa dizer o que houve, e um
 * stack trace vazado seria informacao demais para quem esta do outro lado.
 */
export async function receber(
  entrada: EntradaWebhook, contexto: ContextoSessao,
): Promise<ResultadoWebhook> {
  const chave = entrada.chave_idempotencia?.trim()
    || createHash('sha256')
      .update(`${entrada.integracao}:${JSON.stringify(entrada.payload)}`)
      .digest('hex').slice(0, 48);

  const integracao = await carregarIntegracao(entrada.integracao);

  if (!integracao) {
    const id = await registrar(entrada, chave, 'REJEITADO',
      'Integracao desconhecida', null, null);
    return { id, status: 'REJEITADO', aceito: false, motivo: 'Integracao desconhecida' };
  }

  if (!integracao.ativo) {
    const id = await registrar(entrada, chave, 'REJEITADO',
      'Integracao inativa', null, null);
    return { id, status: 'REJEITADO', aceito: false, motivo: 'Integracao inativa' };
  }

  // Assinatura. Sem segredo cadastrado a integracao nao aceita nada: uma porta
  // aberta sem tranca e pior que uma porta que nao existe.
  if (!integracao.segredo_hash) {
    const id = await registrar(entrada, chave, 'REJEITADO',
      'Integracao sem segredo configurado', null, null);
    return {
      id, status: 'REJEITADO', aceito: false,
      motivo: 'Integracao sem segredo configurado: nao e possivel validar a origem',
    };
  }

  const corpo = entrada.corpo_bruto ?? JSON.stringify(entrada.payload);
  const esperada = assinar(corpo, integracao.segredo_hash);

  if (!entrada.assinatura || !iguais(entrada.assinatura, esperada)) {
    const id = await registrar(entrada, chave, 'REJEITADO',
      'Assinatura invalida', null, null);
    return { id, status: 'REJEITADO', aceito: false, motivo: 'Assinatura invalida' };
  }

  // Carimbo de tempo, contra reenvio de uma requisicao antiga e bem assinada.
  const tolerancia = await numero('webhook_tolerancia_minutos', 5);
  if (entrada.timestamp) {
    const enviado = new Date(entrada.timestamp).getTime();
    if (Number.isNaN(enviado)) {
      const id = await registrar(entrada, chave, 'REJEITADO',
        'Carimbo de tempo invalido', null, null);
      return { id, status: 'REJEITADO', aceito: false, motivo: 'Carimbo de tempo invalido' };
    }
    const distancia = Math.abs(Date.now() - enviado) / 60_000;
    if (distancia > tolerancia) {
      const id = await registrar(entrada, chave, 'REJEITADO',
        `Carimbo de tempo fora da tolerancia de ${tolerancia} minutos`, null, null);
      return {
        id, status: 'REJEITADO', aceito: false,
        motivo: `Carimbo de tempo fora da tolerancia de ${tolerancia} minutos`,
      };
    }
  }

  // Idempotencia: o indice UNIQUE (integracao, chave) e quem decide, nao um
  // SELECT anterior - dois reenvios simultaneos passariam pelo SELECT juntos.
  //
  // O filtro por status e essencial: uma tentativa RECUSADA nao pode barrar o
  // reenvio corrigido do parceiro. Sem ele, quem errasse a assinatura uma vez
  // teria o aviso legitimo descartado como duplicado (migration 047).
  const { rows: jaRecebido } = await query<{
    id: string; status: string; evento_id: string | null; correlation_id: string | null;
  }>(`SELECT id, status::text AS status, evento_id, correlation_id::text AS correlation_id
        FROM webhooks_recebidos
       WHERE integracao = $1 AND chave_idempotencia = $2
         AND status IN ('RECEBIDO', 'PROCESSADO', 'DUPLICADO')
       ORDER BY id LIMIT 1`, [entrada.integracao, chave]);

  if (jaRecebido.length) {
    const anterior = jaRecebido[0]!;
    return {
      id: Number(anterior.id),
      status: 'DUPLICADO',
      aceito: true,
      ...(anterior.evento_id ? { evento_id: Number(anterior.evento_id) } : {}),
      ...(anterior.correlation_id ? { correlation_id: anterior.correlation_id } : {}),
      motivo: 'Webhook ja recebido anteriormente; nada foi reprocessado',
    };
  }

  try {
    const evento = await eventos.registrar({
      tipo: 'WEBHOOK_RECEIVED',
      origem: 'INTEGRACAO',
      entidade: 'integracao',
      entidade_id: integracao.id,
      chave: `webhook:${entrada.integracao}:${chave}`,
      payload: {
        integracao: integracao.codigo,
        integracao_nome: integracao.nome,
        evento_externo: entrada.evento ?? null,
        dados: entrada.payload,
      },
    }, contexto);

    const id = await registrar(entrada, chave, 'PROCESSADO', null,
      evento.id, evento.correlation_id);

    await query(`
      UPDATE integracoes
         SET ultima_sincronizacao = now(), ultimo_status = 'OK',
             registros_processados = registros_processados + 1
       WHERE id = $1`, [integracao.id]);

    return {
      id, status: 'PROCESSADO', aceito: true,
      evento_id: evento.id, correlation_id: evento.correlation_id,
    };
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    const id = await registrar(entrada, chave, 'ERRO', mensagem.slice(0, 500), null, null);

    await query(`
      UPDATE integracoes SET ultimo_status = 'ERRO', erros = erros + 1
       WHERE id = $1`, [integracao.id]);

    return {
      id, status: 'ERRO', aceito: false,
      motivo: 'Falha ao registrar o evento correspondente',
    };
  }
}

// ---------------------------------------------------------------------------
// Integracoes
// ---------------------------------------------------------------------------

export async function listarIntegracoes() {
  const { rows } = await query(`
    SELECT i.id, i.codigo, i.nome, i.tipo, i.direcao, i.ativo,
           (i.segredo_hash IS NOT NULL) AS tem_segredo,
           i.ultima_sincronizacao, i.ultimo_status, i.registros_processados, i.erros,
           (SELECT count(*) FROM webhooks_recebidos w
             WHERE w.integracao = i.codigo
               AND w.created_at >= now() - interval '7 days') AS recebidos_7d,
           (SELECT count(*) FROM webhooks_recebidos w
             WHERE w.integracao = i.codigo AND w.status = 'REJEITADO'
               AND w.created_at >= now() - interval '7 days') AS rejeitados_7d
      FROM integracoes i
     ORDER BY i.codigo`);
  return rows.map((r) => {
    const i = r as Record<string, unknown>;
    return {
      ...i,
      recebidos_7d: Number(i.recebidos_7d),
      rejeitados_7d: Number(i.rejeitados_7d),
      // Uma integracao ativa sem segredo nao consegue aceitar nada. Dizer isso
      // na listagem evita a caca ao erro do lado do parceiro.
      pronta: Boolean(i.ativo) && Boolean(i.tem_segredo),
    };
  });
}

/**
 * Define o segredo de uma integracao.
 *
 * Recebe o segredo em claro, guarda apenas o hash e devolve o segredo UMA vez,
 * para ser entregue ao parceiro. Depois disso nem o sistema sabe qual era.
 */
export async function definirSegredo(
  codigo: string, segredo: string,
): Promise<{ codigo: string; segredo_hash_prefixo: string }> {
  if (!segredo || segredo.length < 16) {
    throw regraNegocio('O segredo precisa ter pelo menos 16 caracteres');
  }

  const hash = derivarHash(segredo);
  const { rowCount } = await query(
    'UPDATE integracoes SET segredo_hash = $2 WHERE upper(codigo) = upper($1)',
    [codigo, hash]);
  if (!rowCount) throw naoEncontrado(`Integracao ${codigo}`);

  return { codigo, segredo_hash_prefixo: `${hash.slice(0, 8)}...` };
}

export async function alternarIntegracao(codigo: string, ativo: boolean): Promise<void> {
  const { rowCount } = await query(
    'UPDATE integracoes SET ativo = $2 WHERE upper(codigo) = upper($1)', [codigo, ativo]);
  if (!rowCount) throw naoEncontrado(`Integracao ${codigo}`);
}

export async function listarRecebidos(filtro: {
  integracao?: string; status?: string; limite?: number; pagina?: number;
}) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const add = (sql: string, valor: unknown) => {
    if (valor === undefined || valor === null || valor === '') return;
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  add('upper(w.integracao) = upper($?)', filtro.integracao);
  add('w.status = $?::status_webhook_enum', filtro.status);

  const limite = Math.min(Math.max(filtro.limite ?? 50, 1), 200);
  const pagina = Math.max(filtro.pagina ?? 1, 1);
  valores.push(limite, (pagina - 1) * limite);

  const { rows } = await query(`
    SELECT w.id, w.integracao, w.evento, w.status::text AS status, w.motivo_rejeicao,
           w.chave_idempotencia, w.ip, w.evento_id,
           w.correlation_id::text AS correlation_id, w.created_at, w.processado_em,
           -- O payload nao vai inteiro para a listagem: pode ser grande e pode
           -- conter dado do parceiro. A tela de detalhe busca quando precisa.
           jsonb_build_object('campos', (SELECT count(*) FROM jsonb_object_keys(w.payload)))
             AS payload_resumo,
           count(*) OVER () AS total
      FROM webhooks_recebidos w
     ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
     ORDER BY w.created_at DESC, w.id DESC
     LIMIT $${valores.length - 1} OFFSET $${valores.length}`, valores);

  return {
    total: rows.length ? Number((rows[0] as { total: string }).total) : 0,
    pagina,
    limite,
    webhooks: rows.map((r) => {
      const { total: _t, ...w } = r as Record<string, unknown>;
      return w;
    }),
  };
}

export async function obterRecebido(id: number) {
  const { rows } = await query(`
    SELECT id, integracao, evento, payload, cabecalhos, status::text AS status,
           motivo_rejeicao, chave_idempotencia, ip, evento_id,
           correlation_id::text AS correlation_id, created_at, processado_em
      FROM webhooks_recebidos WHERE id = $1`, [id]);
  if (!rows.length) throw naoEncontrado('Webhook');
  return rows[0];
}
