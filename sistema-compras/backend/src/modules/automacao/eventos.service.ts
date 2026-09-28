/**
 * Motor de eventos (secoes 6, 7 e 22).
 *
 * Um evento e um FATO do mundo que acabou de acontecer: "o produto 42 cruzou o
 * ponto de pedido", "o pedido 891 passou da data prometida". Ele nao carrega
 * decisao nenhuma - quem decide o que fazer com ele e o motor de regras.
 *
 * A separacao importa: o detector pode rodar de hora em hora sem medo, porque
 * registrar o mesmo fato duas vezes nao produz nada duas vezes. A garantia
 * disso nao esta aqui, esta no indice UNIQUE de `chave_idempotencia` - e e por
 * isso que ela e confiavel mesmo com dois detectores rodando ao mesmo tempo.
 */
import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { hojeLocal } from '../../core/datas.js';

export type Origem =
  | 'ESTOQUE' | 'COMPRAS' | 'COTACOES' | 'PEDIDOS' | 'LOGISTICA' | 'RECEBIMENTO'
  | 'QUALIDADE' | 'FORNECEDORES' | 'DEMANDA' | 'BI' | 'IA' | 'INTEGRACAO' | 'SISTEMA';

/** Os tipos padronizados da secao 7, mais os que os modulos 09 a 12 produzem. */
export const TIPOS_EVENTO = {
  STOCK_LOW: 'Estoque projetado para acabar dentro do horizonte',
  STOCK_OUT: 'Produto com demanda e sem estoque disponivel',
  STOCK_EXCESS: 'Saldo acima do maximo aceitavel',
  STOCK_EXPIRY: 'Lote proximo do vencimento',
  STOCK_NEGATIVE: 'Saldo de estoque negativo',
  STOCK_IDLE: 'Produto sem saida no periodo configurado',
  PURCHASE_NEED_CREATED: 'Necessidade de compra calculada',
  PURCHASE_NEED_CRITICAL: 'Necessidade de compra critica',
  QUOTE_OVERDUE: 'Cotacao sem resposta apos o prazo',
  QUOTE_RECEIVED: 'Proposta recebida de fornecedor',
  PO_APPROVED: 'Pedido de compra aprovado',
  PO_LATE: 'Pedido com promessa vencida e saldo pendente',
  PO_UNCONFIRMED: 'Pedido sem confirmacao do fornecedor',
  DELIVERY_LATE: 'Entrega atrasada',
  RECEIPT_APPROVED: 'Recebimento aprovado',
  RECEIPT_DIVERGENCE: 'Divergencia no recebimento',
  QUALITY_NONCONFORMITY: 'Nao conformidade registrada',
  SUPPLIER_PERFORMANCE_DROP: 'Queda de performance do fornecedor',
  SUPPLIER_SINGLE_SOURCE: 'Produto com fornecedor unico',
  PRICE_INCREASE: 'Aumento anormal de preco',
  AI_RISK_DETECTED: 'Risco detectado pela IA',
  AI_RECOMMENDATION_CREATED: 'Recomendacao criada pela IA',
  EXCEPTION_PRICE_ABOVE: 'Excecao: preco acima do historico',
  EXCEPTION_SUPPLIER: 'Excecao: fornecedor nao principal',
  WEBHOOK_RECEIVED: 'Evento externo recebido por webhook',
} as const;

export type TipoEvento = keyof typeof TIPOS_EVENTO;

export interface NovoEvento {
  tipo: TipoEvento | string;
  origem: Origem;
  entidade?: string | null;
  entidade_id?: number | null;
  payload?: Record<string, unknown>;
  /**
   * Identidade do FATO. Duas deteccoes do mesmo fato produzem a mesma chave.
   *
   * Por padrao inclui a data: "o produto 42 esta em ruptura" e um fato NOVO a
   * cada dia - sem a data, a ruptura de ontem impediria o alerta de hoje e o
   * problema sumiria da tela justamente por persistir.
   */
  chave?: string;
  correlation_id?: string;
  usuario_id?: number | null;
}

export interface EventoRegistrado {
  id: number;
  tipo: string;
  correlation_id: string;
  novo: boolean;
}

/** Chave padrao: tipo + entidade + dia. */
export const chavePadrao = (
  tipo: string, entidade: string | null | undefined, id: number | null | undefined,
  sufixo?: string,
): string => [tipo, entidade ?? '-', id ?? '-', hojeLocal(), sufixo]
  .filter((p) => p !== undefined && p !== null)
  .join(':');

/**
 * Registra o evento. Se o fato ja foi registrado, devolve o existente.
 *
 * `ON CONFLICT DO UPDATE` em vez de `DO NOTHING` porque precisamos do id de
 * volta em qualquer um dos casos - e `DO NOTHING` nao devolve linha. O update
 * e deliberadamente inofensivo: so toca o payload, para o evento existente
 * refletir os numeros mais recentes do mesmo fato.
 */
export async function registrar(
  entrada: NovoEvento, contexto: ContextoSessao,
): Promise<EventoRegistrado> {
  const chave = entrada.chave
    ?? chavePadrao(entrada.tipo, entrada.entidade, entrada.entidade_id);

  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query<{
      id: string; correlation_id: string; inserido: boolean;
    }>(`
      INSERT INTO eventos
        (tipo, origem, entidade, entidade_id, payload, chave_idempotencia,
         correlation_id, usuario_id)
      VALUES ($1, $2::origem_evento_enum, $3, $4, $5::jsonb, $6,
              coalesce($7::uuid, gen_random_uuid()), $8)
      ON CONFLICT (chave_idempotencia) DO UPDATE
        SET payload = EXCLUDED.payload
      RETURNING id, correlation_id::text AS correlation_id, (xmax = 0) AS inserido`,
    [entrada.tipo, entrada.origem, entrada.entidade ?? null,
      entrada.entidade_id ?? null, JSON.stringify(entrada.payload ?? {}),
      chave, entrada.correlation_id ?? null,
      entrada.usuario_id ?? contexto.usuarioId ?? null]);

    const linha = rows[0]!;
    return {
      id: Number(linha.id),
      tipo: entrada.tipo,
      correlation_id: linha.correlation_id,
      novo: linha.inserido,
    };
  });
}

/** Registra varios eventos, contando quantos eram realmente novos. */
export async function registrarVarios(
  entradas: NovoEvento[], contexto: ContextoSessao,
): Promise<{ registrados: number; novos: number; eventos: EventoRegistrado[] }> {
  const eventos: EventoRegistrado[] = [];
  for (const e of entradas) {
    eventos.push(await registrar(e, contexto));
  }
  return {
    registrados: eventos.length,
    novos: eventos.filter((e) => e.novo).length,
    eventos,
  };
}

export async function marcarProcessado(
  ids: number[], regrasDisparadas: Map<number, number>,
): Promise<void> {
  if (!ids.length) return;
  await query(`
    UPDATE eventos
       SET status = 'PROCESSADO', processado_em = now(),
           regras_disparadas = coalesce($2::jsonb ->> id::text, '0')::int
     WHERE id = ANY($1::bigint[])`,
  [ids, JSON.stringify(Object.fromEntries(regrasDisparadas))]);
}

export async function marcarErro(id: number, erro: string): Promise<void> {
  await query(
    "UPDATE eventos SET status = 'ERRO', erro = $2, processado_em = now() WHERE id = $1",
    [id, erro.slice(0, 2000)]);
}

export async function pendentes(limite = 100) {
  const { rows } = await query(`
    SELECT id, tipo, origem::text AS origem, entidade, entidade_id, payload,
           correlation_id::text AS correlation_id, created_at
      FROM eventos
     WHERE status = 'NOVO'
     ORDER BY created_at, id
     LIMIT $1`, [limite]);
  return rows;
}

export interface FiltroEventos {
  tipo?: string;
  origem?: string;
  status?: string;
  entidade?: string;
  correlation_id?: string;
  limite?: number;
  pagina?: number;
}

export async function listar(filtro: FiltroEventos) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const add = (sql: string, valor: unknown) => {
    if (valor === undefined || valor === null || valor === '') return;
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  add('e.tipo = $?', filtro.tipo);
  add('e.origem = $?::origem_evento_enum', filtro.origem);
  add('e.status = $?::status_evento_enum', filtro.status);
  add('e.entidade = $?', filtro.entidade);
  add('e.correlation_id = $?::uuid', filtro.correlation_id);

  const limite = Math.min(Math.max(filtro.limite ?? 50, 1), 200);
  const pagina = Math.max(filtro.pagina ?? 1, 1);
  valores.push(limite, (pagina - 1) * limite);

  const { rows } = await query(`
    SELECT e.id, e.tipo, e.origem::text AS origem, e.entidade, e.entidade_id,
           e.payload, e.status::text AS status, e.regras_disparadas,
           e.correlation_id::text AS correlation_id, e.chave_idempotencia,
           e.created_at, e.processado_em, e.erro, u.nome AS usuario,
           count(*) OVER () AS total
      FROM eventos e
      LEFT JOIN usuarios u ON u.id = e.usuario_id
     ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT $${valores.length - 1} OFFSET $${valores.length}`, valores);

  return {
    total: rows.length ? Number((rows[0] as { total: string }).total) : 0,
    pagina,
    limite,
    eventos: rows.map((r) => {
      const { total: _t, ...e } = r as Record<string, unknown>;
      return e;
    }),
  };
}

/**
 * A linha do tempo de um correlation_id (secao 35).
 *
 * Responde "o que aconteceu, quando, por que, qual regra, qual usuario" juntando
 * evento, execucoes, tarefas, aprovacoes e notificacoes que descendem do mesmo
 * fato. E o que permite reconstruir uma decisao meses depois.
 */
export async function rastrear(correlationId: string) {
  const [evento, execucoes, tarefas, aprovacoes, notificacoes, fila] = await Promise.all([
    query(`SELECT id, tipo, origem::text AS origem, entidade, entidade_id, payload,
                  status::text AS status, created_at, processado_em
             FROM eventos WHERE correlation_id = $1::uuid`, [correlationId]),
    // `regra` sai do codigo gravado na propria execucao, nao do JOIN: e o que
    // continua respondendo "qual regra decidiu isso" depois que a regra for
    // editada ou removida (migration 046). O JOIN fica so para o nome atual.
    query(`SELECT x.id, x.acao, x.status::text AS status, x.tentativa, x.iniciado_em,
                  x.concluido_em, x.duracao_ms, x.erro, x.resultado,
                  coalesce(x.regra_codigo, r.codigo) AS regra,
                  x.regra_versao, x.evento_tipo, r.nome AS regra_nome_atual
             FROM automacao_execucoes x
             LEFT JOIN automacao_regras r ON r.id = x.regra_id
            WHERE x.correlation_id = $1::uuid ORDER BY x.iniciado_em`, [correlationId]),
    query(`SELECT id, tipo, titulo, status::text AS status, prioridade::text AS prioridade,
                  prazo, sla_status::text AS sla_status, nivel_escalonamento, created_at
             FROM tarefas WHERE correlation_id = $1::uuid ORDER BY created_at`,
    [correlationId]),
    query(`SELECT id, tipo, titulo, status::text AS status, nivel, excecao,
                  motivo_excecao, decidido_em, created_at
             FROM aprovacoes WHERE correlation_id = $1::uuid ORDER BY created_at`,
    [correlationId]),
    query(`SELECT id, titulo, canal::text AS canal, status::text AS status, created_at
             FROM notificacoes WHERE correlation_id = $1::uuid ORDER BY created_at`,
    [correlationId]),
    query(`SELECT id, acao, status::text AS status, tentativa, dead_letter,
                  disponivel_em, erro
             FROM automacao_fila WHERE correlation_id = $1::uuid ORDER BY created_at`,
    [correlationId]),
  ]);

  return {
    correlation_id: correlationId,
    evento: evento.rows[0] ?? null,
    fila: fila.rows,
    execucoes: execucoes.rows,
    tarefas: tarefas.rows,
    aprovacoes: aprovacoes.rows,
    notificacoes: notificacoes.rows,
    encontrado: evento.rows.length > 0 || execucoes.rows.length > 0,
  };
}

export const catalogoTipos = () =>
  Object.entries(TIPOS_EVENTO).map(([tipo, descricao]) => ({ tipo, descricao }));
