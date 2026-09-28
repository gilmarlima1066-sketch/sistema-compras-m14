/**
 * Motor de aprovacao por alcada e aprovacao de excecao (secoes 14, 15, 16 e 33).
 *
 * Este e o ponto mais sensivel do modulo, e vale dizer com clareza o que ele NAO
 * faz: nao emite pedido de compra, nao aprova pedido, nao altera preco, nao move
 * estoque. A secao 9 e explicita - nenhuma automacao emite pedido sem respeitar
 * o fluxo de aprovacao - e o modo de respeitar um fluxo que ja existe e usar o
 * fluxo que ja existe. O pedido de compra continua sendo aprovado em
 * `pedido_aprovacoes`, pelo modulo 08, com as mesmas alcadas. O que a automacao
 * faz e PEDIR: cria a solicitacao, avisa quem decide, registra a decisao.
 *
 * A faixa de valor vem de `alcadaPara`, do modulo 08 - a mesma funcao, nao uma
 * copia. Se as duas leituras divergissem, o usuario veria a automacao exigir uma
 * aprovacao que ele acabou de dar.
 *
 * A excecao (secao 16) e uma aprovacao com motivo obrigatorio: comprar acima do
 * historico ou de fornecedor nao principal pode ser a decisao certa, mas nao
 * pode ser uma decisao muda. O banco garante o motivo pelo CHECK
 * `ck_aprovacao_excecao`; nao confiamos so na validacao da aplicacao.
 */
import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio, semPermissao } from '../../core/errors.js';
import { alcadaPara } from '../negociacoes/pedido.service.js';
import { notificar } from './notificacoes.service.js';
import * as sla from './sla.service.js';

export type StatusAprovacao = 'PENDENTE' | 'APROVADA' | 'REJEITADA' | 'DISPENSADA';

/** Acoes que uma automacao nunca executa por conta propria (secoes 9 e 32). */
export const ACOES_QUE_EXIGEM_HUMANO = [
  'EMITIR_PEDIDO', 'APROVAR_PEDIDO', 'ALTERAR_PRECO', 'ALTERAR_ESTOQUE',
  'CANCELAR_PEDIDO', 'APROVAR_RECEBIMENTO', 'BLOQUEAR_FORNECEDOR',
] as const;

export type AcaoRestrita = typeof ACOES_QUE_EXIGEM_HUMANO[number];

export const exigeHumano = (acao: string): boolean =>
  (ACOES_QUE_EXIGEM_HUMANO as readonly string[]).includes(acao.toUpperCase());

export interface EntradaAprovacao {
  tipo: string;
  titulo: string;
  descricao?: string | null;
  entidade: string;
  entidade_id?: number | null;
  /** Quando informado, a alcada resolve o perfil e o nivel exigidos. */
  valor_avaliado?: number | null;
  /** Perfil exigido explicito, para aprovacoes que nao dependem de valor. */
  perfil_exigido?: string | null;
  excecao?: boolean;
  motivo_excecao?: string | null;
  impacto?: string | null;
  solicitante_id?: number | null;
  correlation_id?: string | null;
  fila_id?: number | null;
  chave?: string | null;
  contexto?: Record<string, unknown>;
  /** Politica de SLA do prazo de decisao. Por padrao, APROVACAO. */
  sla?: string | null;
}

export interface AprovacaoSolicitada {
  id: number;
  nova: boolean;
  nivel: number;
  perfil_exigido: string | null;
  alcada: string | null;
  prazo: string | null;
  notificados: number;
  motivo_sem_destino?: string;
}

/**
 * Solicita a aprovacao e avisa quem tem alcada para decidir.
 *
 * O nivel sai da ORDEM da alcada, nao de uma tabela paralela: alcada 1 e nivel
 * 1. Assim mudar a faixa de valor na tela muda quem aprova, sem tocar em codigo.
 */
export async function solicitar(
  entrada: EntradaAprovacao, contexto: ContextoSessao,
): Promise<AprovacaoSolicitada> {
  if (entrada.excecao && !entrada.motivo_excecao?.trim()) {
    throw regraNegocio('Aprovacao de excecao exige motivo');
  }

  const valor = entrada.valor_avaliado ?? null;
  const faixa = valor !== null ? await alcadaPara(valor) : null;
  const perfilExigido = entrada.perfil_exigido ?? faixa?.perfil ?? null;
  const nivel = faixa?.ordem ?? 1;

  const prazo = await sla.prazoDe(entrada.sla === undefined ? 'APROVACAO' : entrada.sla);

  const criada = await comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query<{ id: string; prazo: string | null }>(`
      INSERT INTO aprovacoes
        (tipo, titulo, descricao, entidade, entidade_id, valor_avaliado, alcada_id,
         perfil_exigido, nivel, excecao, motivo_excecao, impacto, solicitante_id,
         prazo, correlation_id, fila_id, chave_dedup, contexto)
      VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, $11, $12, $13,
              $14::timestamptz, $15::uuid, $16, $17, $18::jsonb)
      ON CONFLICT (chave_dedup)
        WHERE chave_dedup IS NOT NULL AND status = 'PENDENTE'
      DO NOTHING
      RETURNING id, prazo`,
    [entrada.tipo, entrada.titulo, entrada.descricao ?? null, entrada.entidade,
      entrada.entidade_id ?? null, valor, faixa ? Number(faixa.id) : null,
      perfilExigido, nivel, entrada.excecao ?? false,
      entrada.motivo_excecao?.trim() || null, entrada.impacto ?? null,
      entrada.solicitante_id ?? contexto.usuarioId ?? null, prazo.vence_em,
      entrada.correlation_id ?? null, entrada.fila_id ?? null,
      entrada.chave ?? null,
      entrada.contexto ? JSON.stringify(entrada.contexto) : null]);
    return rows[0] ?? null;
  });

  if (!criada) {
    const { rows } = await query<{ id: string; nivel: number; perfil_exigido: string | null; prazo: string | null }>(
      `SELECT id, nivel, perfil_exigido, prazo FROM aprovacoes
        WHERE chave_dedup = $1 AND status = 'PENDENTE' LIMIT 1`, [entrada.chave]);
    const existente = rows[0];
    return {
      id: existente ? Number(existente.id) : 0,
      nova: false,
      nivel: existente?.nivel ?? nivel,
      perfil_exigido: existente?.perfil_exigido ?? perfilExigido,
      alcada: faixa?.nome ?? null,
      prazo: existente?.prazo ?? null,
      notificados: 0,
    };
  }

  const id = Number(criada.id);
  const aviso = await notificar({
    titulo: `Aprovacao pendente: ${entrada.titulo}`,
    mensagem: entrada.excecao
      ? `Excecao solicitada. Motivo: ${entrada.motivo_excecao}`
      : entrada.descricao ?? null,
    tipo: 'APROVACAO',
    perfil: perfilExigido,
    link: `/aprovacoes?id=${id}`,
    correlation_id: entrada.correlation_id ?? null,
    chave: `aprovacao:${id}`,
  }, contexto);

  return {
    id,
    nova: true,
    nivel,
    perfil_exigido: perfilExigido,
    alcada: faixa?.nome ?? null,
    prazo: criada.prazo,
    notificados: aviso.criadas,
    ...(aviso.motivo_sem_destino ? { motivo_sem_destino: aviso.motivo_sem_destino } : {}),
  };
}

interface Pendente {
  id: number;
  titulo: string;
  perfil_exigido: string | null;
  nivel: number;
  excecao: boolean;
  correlation_id: string | null;
  solicitante_id: number | null;
  prazo: Date | null;
}

async function carregarPendente(id: number): Promise<Pendente> {
  const { rows } = await query<{
    id: string; titulo: string; perfil_exigido: string | null; nivel: number;
    excecao: boolean; correlation_id: string | null; solicitante_id: string | null;
    prazo: Date | null; status: string;
  }>(`SELECT id, titulo, perfil_exigido, nivel, excecao,
             correlation_id::text AS correlation_id, solicitante_id, prazo,
             status::text AS status
        FROM aprovacoes WHERE id = $1`, [id]);

  const linha = rows[0];
  if (!linha) throw naoEncontrado('Aprovacao');
  if (linha.status !== 'PENDENTE') {
    throw regraNegocio(`Aprovacao ja foi ${linha.status.toLowerCase()}`);
  }
  return {
    id: Number(linha.id), titulo: linha.titulo, perfil_exigido: linha.perfil_exigido,
    nivel: linha.nivel, excecao: linha.excecao, correlation_id: linha.correlation_id,
    solicitante_id: linha.solicitante_id === null ? null : Number(linha.solicitante_id),
    prazo: linha.prazo,
  };
}

/**
 * Confere se o usuario pode decidir esta aprovacao (secoes 15 e 36).
 *
 * Duas travas, alem da permissao `automacao.aprovar`:
 *
 * - Perfil: quem decide precisa ser do perfil da alcada. ADMIN passa por
 *   qualquer uma, porque sem isso uma alcada sem usuario ativo travaria a
 *   operacao sem saida.
 *
 * - Segregacao de funcoes: quem pediu nao aprova o proprio pedido. Vale mesmo
 *   para ADMIN - e o unico ponto onde ADMIN nao passa, porque aqui o risco nao e
 *   de acesso, e de conflito de interesse.
 */
async function conferirAlcada(aprovacao: Pendente, usuarioId: number): Promise<string> {
  const { rows } = await query<{ perfil: string }>(`
    SELECT p.nome AS perfil
      FROM usuarios u JOIN perfis p ON p.id = u.perfil_id
     WHERE u.id = $1 AND u.ativo AND u.deleted_at IS NULL`, [usuarioId]);

  const perfil = rows[0]?.perfil;
  if (!perfil) throw semPermissao('Usuario inativo ou inexistente');

  if (aprovacao.solicitante_id === usuarioId) {
    throw semPermissao(
      'Segregacao de funcoes: quem solicitou nao pode aprovar a propria solicitacao');
  }

  if (aprovacao.perfil_exigido
      && perfil !== 'ADMIN'
      && perfil.toUpperCase() !== aprovacao.perfil_exigido.toUpperCase()) {
    throw semPermissao(
      `Esta aprovacao exige o perfil ${aprovacao.perfil_exigido}; o seu e ${perfil}`);
  }

  return perfil;
}

export interface Decisao {
  id: number;
  status: StatusAprovacao;
  aprovador: string;
  no_prazo: boolean;
}

export async function aprovar(
  id: number, usuarioId: number, justificativa: string | null, contexto: ContextoSessao,
): Promise<Decisao> {
  const pendente = await carregarPendente(id);
  const perfil = await conferirAlcada(pendente, usuarioId);
  return decidir(pendente, 'APROVADA', usuarioId, perfil, justificativa, contexto);
}

export async function rejeitar(
  id: number, usuarioId: number, justificativa: string, contexto: ContextoSessao,
): Promise<Decisao> {
  // O banco tambem exige (ck_aprovacao_rejeicao); a checagem aqui existe para a
  // mensagem ser util, nao para ser a unica.
  if (!justificativa?.trim()) throw regraNegocio('Rejeicao exige justificativa');
  const pendente = await carregarPendente(id);
  const perfil = await conferirAlcada(pendente, usuarioId);
  return decidir(pendente, 'REJEITADA', usuarioId, perfil, justificativa, contexto);
}

/** Dispensa: a solicitacao perdeu sentido (o fato que a originou deixou de valer). */
export async function dispensar(
  id: number, usuarioId: number, motivo: string, contexto: ContextoSessao,
): Promise<Decisao> {
  if (!motivo?.trim()) throw regraNegocio('Dispensa exige motivo');
  const pendente = await carregarPendente(id);
  const perfil = await conferirAlcada(pendente, usuarioId);
  return decidir(pendente, 'DISPENSADA', usuarioId, perfil, motivo, contexto);
}

async function decidir(
  pendente: Pendente, status: StatusAprovacao, usuarioId: number, perfil: string,
  justificativa: string | null, contexto: ContextoSessao,
): Promise<Decisao> {
  const noPrazo = !pendente.prazo || new Date() <= new Date(pendente.prazo);

  const atualizadas = await comTransacao(contexto, async (cliente) => {
    // O `AND status = 'PENDENTE'` repete a checagem de carregarPendente de
    // proposito: entre a leitura e a escrita outro aprovador pode ter decidido.
    // Sem ele, duas decisoes simultaneas gravariam uma sobre a outra.
    const { rowCount } = await cliente.query(`
      UPDATE aprovacoes
         SET status = $2::status_aprovacao_enum, aprovador_id = $3,
             justificativa = $4, decidido_em = now(),
             sla_status = CASE WHEN prazo IS NULL OR now() <= prazo
                               THEN 'CUMPRIDO' ELSE 'VENCIDO'
                          END::status_sla_enum
       WHERE id = $1 AND status = 'PENDENTE'`,
    [pendente.id, status, usuarioId, justificativa?.trim() || null]);
    return rowCount ?? 0;
  });

  if (!atualizadas) throw regraNegocio('Aprovacao foi decidida por outro usuario');

  if (pendente.solicitante_id) {
    await notificar({
      titulo: `Aprovacao ${status.toLowerCase()}: ${pendente.titulo}`,
      mensagem: justificativa ?? null,
      tipo: 'APROVACAO_DECIDIDA',
      usuario_id: pendente.solicitante_id,
      link: `/aprovacoes?id=${pendente.id}`,
      correlation_id: pendente.correlation_id,
      chave: `aprovacao-decidida:${pendente.id}`,
    }, contexto);
  }

  return { id: pendente.id, status, aprovador: perfil, no_prazo: noPrazo };
}

/** Varre as aprovacoes pendentes atualizando o semaforo de prazo (secao 19). */
export async function varrerPrazos(): Promise<{ em_risco: number; vencidas: number }> {
  const { rows } = await query<{ em_risco: string; vencidas: string }>(`
    WITH atualizadas AS (
      UPDATE aprovacoes a
         SET sla_status = CASE
               WHEN now() > a.prazo THEN 'VENCIDO'
               WHEN now() >= a.created_at
                    + (a.prazo - a.created_at) * (coalesce(p.alerta_percentual, 80) / 100.0)
                 THEN 'EM_RISCO'
               ELSE 'DENTRO' END::status_sla_enum
        FROM (SELECT alerta_percentual FROM sla_politicas
               WHERE upper(codigo) = 'APROVACAO' AND ativo) p
       WHERE a.status = 'PENDENTE' AND a.prazo IS NOT NULL
       RETURNING a.sla_status
    )
    SELECT count(*) FILTER (WHERE sla_status = 'EM_RISCO') AS em_risco,
           count(*) FILTER (WHERE sla_status = 'VENCIDO')  AS vencidas
      FROM atualizadas`);
  return {
    em_risco: Number(rows[0]?.em_risco ?? 0),
    vencidas: Number(rows[0]?.vencidas ?? 0),
  };
}

export async function listar(filtro: {
  status?: string; tipo?: string; excecao?: boolean; perfil_exigido?: string;
  entidade?: string; correlation_id?: string; limite?: number; pagina?: number;
}) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const add = (sql: string, valor: unknown) => {
    if (valor === undefined || valor === null || valor === '') return;
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  add('a.status = $?::status_aprovacao_enum', filtro.status);
  add('a.tipo = $?', filtro.tipo);
  if (filtro.excecao !== undefined) add('a.excecao = $?', filtro.excecao);
  add('upper(a.perfil_exigido) = upper($?)', filtro.perfil_exigido);
  add('a.entidade = $?', filtro.entidade);
  add('a.correlation_id = $?::uuid', filtro.correlation_id);

  const limite = Math.min(Math.max(filtro.limite ?? 50, 1), 200);
  const pagina = Math.max(filtro.pagina ?? 1, 1);
  valores.push(limite, (pagina - 1) * limite);

  const { rows } = await query(`
    SELECT a.id, a.tipo, a.titulo, a.descricao, a.entidade, a.entidade_id,
           a.valor_avaliado, a.perfil_exigido, a.nivel,
           a.status::text AS status, a.excecao, a.motivo_excecao, a.impacto,
           a.justificativa, a.prazo, a.sla_status::text AS sla_status,
           a.decidido_em, a.created_at, a.contexto,
           a.correlation_id::text AS correlation_id,
           al.nome AS alcada, s.nome AS solicitante, ap.nome AS aprovador,
           count(*) OVER () AS total
      FROM aprovacoes a
      LEFT JOIN alcadas_aprovacao al ON al.id = a.alcada_id
      LEFT JOIN usuarios s  ON s.id  = a.solicitante_id
      LEFT JOIN usuarios ap ON ap.id = a.aprovador_id
     ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
     ORDER BY CASE WHEN a.status = 'PENDENTE' THEN 0 ELSE 1 END,
              a.nivel DESC, a.created_at
     LIMIT $${valores.length - 1} OFFSET $${valores.length}`, valores);

  return {
    total: rows.length ? Number((rows[0] as { total: string }).total) : 0,
    pagina,
    limite,
    aprovacoes: rows.map((r) => {
      const { total: _t, ...a } = r as Record<string, unknown>;
      return a;
    }),
  };
}

/** Aprovacoes que ESTE usuario pode decidir, ja aplicando as duas travas. */
export async function minhaFila(usuarioId: number) {
  const { rows } = await query(`
    SELECT a.id, a.tipo, a.titulo, a.valor_avaliado, a.nivel, a.excecao,
           a.motivo_excecao, a.prazo, a.sla_status::text AS sla_status,
           a.created_at, al.nome AS alcada, s.nome AS solicitante
      FROM aprovacoes a
      JOIN usuarios u ON u.id = $1
      JOIN perfis  p ON p.id = u.perfil_id
      LEFT JOIN alcadas_aprovacao al ON al.id = a.alcada_id
      LEFT JOIN usuarios s ON s.id = a.solicitante_id
     WHERE a.status = 'PENDENTE'
       AND coalesce(a.solicitante_id, -1) <> $1
       AND (a.perfil_exigido IS NULL
            OR p.nome = 'ADMIN'
            OR upper(p.nome) = upper(a.perfil_exigido))
     ORDER BY a.nivel DESC, a.prazo NULLS LAST, a.created_at
     LIMIT 100`, [usuarioId]);
  return rows;
}

export async function obter(id: number) {
  const { rows } = await query(`
    SELECT a.*, a.status::text AS status, a.sla_status::text AS sla_status,
           a.correlation_id::text AS correlation_id,
           al.nome AS alcada, s.nome AS solicitante, ap.nome AS aprovador
      FROM aprovacoes a
      LEFT JOIN alcadas_aprovacao al ON al.id = a.alcada_id
      LEFT JOIN usuarios s  ON s.id  = a.solicitante_id
      LEFT JOIN usuarios ap ON ap.id = a.aprovador_id
     WHERE a.id = $1`, [id]);
  if (!rows.length) throw naoEncontrado('Aprovacao');
  return rows[0];
}

export async function resumo() {
  const { rows } = await query(`
    SELECT status::text AS status, excecao, count(*) AS total
      FROM aprovacoes GROUP BY status, excecao ORDER BY 1, 2`);
  const { rows: fila } = await query(`
    SELECT nivel, perfil_exigido, count(*) AS total
      FROM aprovacoes WHERE status = 'PENDENTE'
     GROUP BY nivel, perfil_exigido ORDER BY nivel`);
  return {
    por_status: rows.map((r) => {
      const l = r as Record<string, unknown>;
      return { status: l.status, excecao: l.excecao, total: Number(l.total) };
    }),
    fila_pendente: fila.map((r) => {
      const l = r as Record<string, unknown>;
      return { nivel: l.nivel, perfil_exigido: l.perfil_exigido, total: Number(l.total) };
    }),
    acoes_que_exigem_humano: [...ACOES_QUE_EXIGEM_HUMANO],
  };
}
