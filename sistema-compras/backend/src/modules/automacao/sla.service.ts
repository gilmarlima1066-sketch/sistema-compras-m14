/**
 * SLA por etapa e escalonamento em tres niveis (secoes 19, 20 e 21).
 *
 * Um SLA aqui nao e um numero decorativo ao lado da tarefa: e a promessa de que
 * ninguem precisa lembrar de cobrar. A tarefa nasce com prazo, muda para
 * EM_RISCO antes de vencer - o percentual de alerta existe para avisar enquanto
 * ainda da tempo de agir - e, se vencer, sobe de nivel sozinha.
 *
 * O escalonamento tem tres niveis porque a realidade tem tres: quem faz, quem
 * responde pela area e quem responde pela empresa. Subir direto para a diretoria
 * queima o mecanismo; nunca subir o torna inutil.
 *
 * As horas sao de calendario, nao uteis. E uma escolha consciente e limitada:
 * um vencimento de sexta as 18h conta o fim de semana. Distribuidora de
 * produtos naturais opera com validade e ruptura, onde o sabado tambem conta -
 * mas isso esta registrado como limitacao para quem for evoluir o modulo.
 */
import { query } from '../../config/database.js';

export type StatusSla = 'DENTRO' | 'EM_RISCO' | 'VENCIDO' | 'CUMPRIDO';

export interface Politica {
  id: number;
  codigo: string;
  nome: string;
  etapa: string;
  horas: number;
  alerta_percentual: number;
  escalonar_nivel1_horas: number | null;
  escalonar_nivel2_horas: number | null;
  escalonar_nivel3_horas: number | null;
  perfil_nivel1: string | null;
  perfil_nivel2: string | null;
  perfil_nivel3: string | null;
}

/** Tempo de vida curto: as politicas mudam raramente e sao lidas a cada tarefa. */
const cache = new Map<string, { politica: Politica | null; em: number }>();
const TTL_MS = 60_000;

export function invalidar(): void {
  cache.clear();
}

export async function politica(codigo: string): Promise<Politica | null> {
  const chave = codigo.trim().toUpperCase();
  const guardado = cache.get(chave);
  if (guardado && Date.now() - guardado.em < TTL_MS) return guardado.politica;

  const { rows } = await query<Politica>(`
    SELECT id, codigo, nome, etapa, horas, alerta_percentual,
           escalonar_nivel1_horas, escalonar_nivel2_horas, escalonar_nivel3_horas,
           perfil_nivel1, perfil_nivel2, perfil_nivel3
      FROM sla_politicas
     WHERE upper(codigo) = $1 AND ativo`, [chave]);

  const encontrada = rows[0] ?? null;
  cache.set(chave, { politica: encontrada, em: Date.now() });
  return encontrada;
}

export async function listar(): Promise<Politica[]> {
  const { rows } = await query<Politica>(`
    SELECT id, codigo, nome, etapa, horas, alerta_percentual,
           escalonar_nivel1_horas, escalonar_nivel2_horas, escalonar_nivel3_horas,
           perfil_nivel1, perfil_nivel2, perfil_nivel3
      FROM sla_politicas
     WHERE ativo
     ORDER BY etapa, horas`);
  return rows;
}

/**
 * Situacao do SLA a partir do prazo.
 *
 * Trabalha com datas ja resolvidas em vez de ler do banco de novo: a mesma
 * funcao serve para a tarefa que acabou de nascer, para o job que varre as
 * abertas e para a tela que mostra o semaforo, sem tres versoes da conta.
 */
export function situacao(
  criadoEm: Date, venceEm: Date | null, alertaPercentual: number, agora = new Date(),
): { status: StatusSla; horas_restantes: number | null; percentual_consumido: number | null } {
  if (!venceEm) return { status: 'DENTRO', horas_restantes: null, percentual_consumido: null };

  const total = venceEm.getTime() - criadoEm.getTime();
  const decorrido = agora.getTime() - criadoEm.getTime();
  const restanteMs = venceEm.getTime() - agora.getTime();
  const horasRestantes = Math.round((restanteMs / 3_600_000) * 10) / 10;

  if (total <= 0) {
    return { status: restanteMs < 0 ? 'VENCIDO' : 'DENTRO', horas_restantes: horasRestantes, percentual_consumido: 100 };
  }

  const percentual = Math.round((decorrido / total) * 1000) / 10;
  if (restanteMs < 0) return { status: 'VENCIDO', horas_restantes: horasRestantes, percentual_consumido: percentual };
  if (percentual >= alertaPercentual) {
    return { status: 'EM_RISCO', horas_restantes: horasRestantes, percentual_consumido: percentual };
  }
  return { status: 'DENTRO', horas_restantes: horasRestantes, percentual_consumido: percentual };
}

/**
 * Nivel de escalonamento devido, dadas as horas decorridas.
 *
 * Devolve o nivel MAIS ALTO ja alcancado, nao o proximo. Assim uma tarefa
 * esquecida por uma semana nao precisa subir nivel por nivel em varredura
 * atras de varredura: ela chega de uma vez onde deveria estar.
 */
export function nivelDevido(politica: Politica, horasDecorridas: number): number {
  const faixas: Array<[number, number | null]> = [
    [3, politica.escalonar_nivel3_horas],
    [2, politica.escalonar_nivel2_horas],
    [1, politica.escalonar_nivel1_horas],
  ];
  for (const [nivel, horas] of faixas) {
    if (horas !== null && horasDecorridas >= horas) return nivel;
  }
  return 0;
}

export function perfilDoNivel(politica: Politica, nivel: number): string | null {
  if (nivel === 1) return politica.perfil_nivel1;
  if (nivel === 2) return politica.perfil_nivel2;
  if (nivel === 3) return politica.perfil_nivel3;
  return null;
}

/**
 * Prazo absoluto de uma politica a partir de agora.
 *
 * Sem politica cadastrada devolve null em vez de inventar um prazo: uma tarefa
 * sem SLA e honesta, uma com SLA fantasma polui todo o indicador de pontualidade.
 */
export async function prazoDe(
  codigo: string | null | undefined, desde = new Date(),
): Promise<{ vence_em: Date | null; horas: number | null; politica: Politica | null }> {
  if (!codigo) return { vence_em: null, horas: null, politica: null };
  const p = await politica(codigo);
  if (!p) return { vence_em: null, horas: null, politica: null };
  return {
    vence_em: new Date(desde.getTime() + p.horas * 3_600_000),
    horas: p.horas,
    politica: p,
  };
}

/** Cumprimento de SLA por etapa, para o painel de operacao (secao 21). */
export async function desempenho(dias = 30) {
  const { rows } = await query(`
    WITH base AS (
      SELECT coalesce(p.etapa, 'SEM_POLITICA') AS etapa,
             t.status::text                    AS status,
             t.sla_status::text                AS sla_status,
             t.nivel_escalonamento,
             t.sla_vence_em, t.concluida_em, t.created_at
        FROM tarefas t
        LEFT JOIN sla_politicas p ON upper(p.codigo) = upper(t.tipo)
       WHERE t.created_at >= now() - make_interval(days => $1::int)
    )
    SELECT etapa,
           count(*)                                                        AS total,
           count(*) FILTER (WHERE status = 'CONCLUIDA')                    AS concluidas,
           count(*) FILTER (WHERE sla_vence_em IS NOT NULL)                AS com_sla,
           -- O cumprimento se mede sobre o que JA TERMINOU. Uma tarefa aberta e
           -- dentro do prazo nao e descumprimento; conta-la no denominador faria
           -- o indicador piorar a cada tarefa nova, o que e o oposto da verdade.
           count(*) FILTER (WHERE status = 'CONCLUIDA'
                              AND sla_vence_em IS NOT NULL)                AS encerradas_com_sla,
           count(*) FILTER (WHERE status = 'CONCLUIDA' AND sla_vence_em IS NOT NULL
                              AND concluida_em <= sla_vence_em)            AS no_prazo,
           count(*) FILTER (WHERE sla_status = 'VENCIDO')                  AS vencidas,
           count(*) FILTER (WHERE sla_status = 'EM_RISCO')                 AS em_risco,
           count(*) FILTER (WHERE nivel_escalonamento > 0)                 AS escalonadas,
           round(avg(EXTRACT(EPOCH FROM (concluida_em - created_at)) / 3600)
                 FILTER (WHERE status = 'CONCLUIDA'), 1)                   AS horas_media
      FROM base
     GROUP BY etapa
     ORDER BY total DESC`, [dias]);

  return rows.map((r) => {
    const linha = r as Record<string, string | null>;
    const encerradas = Number(linha.encerradas_com_sla ?? 0);
    const noPrazo = Number(linha.no_prazo ?? 0);
    return {
      ...linha,
      total: Number(linha.total),
      concluidas: Number(linha.concluidas),
      com_sla: Number(linha.com_sla ?? 0),
      encerradas_com_sla: encerradas,
      no_prazo: noPrazo,
      vencidas: Number(linha.vencidas),
      em_risco: Number(linha.em_risco),
      escalonadas: Number(linha.escalonadas),
      horas_media: linha.horas_media === null ? null : Number(linha.horas_media),
      // Sem tarefa encerrada nao existe percentual: 0% sugeriria falha total
      // quando a verdade e "ainda nao ha o que medir".
      cumprimento_percentual: encerradas > 0
        ? Math.round((noPrazo / encerradas) * 1000) / 10
        : null,
      base_insuficiente: encerradas === 0,
      ...(encerradas === 0
        ? { motivo_sem_base: 'Nenhuma tarefa com SLA foi encerrada no periodo' }
        : {}),
    };
  });
}
