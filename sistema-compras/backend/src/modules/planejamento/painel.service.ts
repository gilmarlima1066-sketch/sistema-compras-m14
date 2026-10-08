/**
 * Painel de Gestao de Compras: a aba "GESTAO DE COMPRAS" da planilha, com os
 * mesmos conceitos e sem os defeitos que a analise encontrou nela.
 *
 *   - Duas medias de demanda lado a lado (decisao do usuario): a da planilha
 *     (media dos ultimos 7 meses COM venda, por dia util) e a do sistema
 *     (ultimos 90 dias corridos). O calculo usa a escolhida.
 *   - Horizonte, estoque minimo e lead time vem de `politicas_compra`, que
 *     variam por curva, fornecedor ou produto.
 *   - Tudo e calculado em dias corridos. A planilha dividia por dia util e
 *     somava como dia corrido, o que antecipava a data de ruptura.
 *   - A data e comparada como data (a planilha tinha hora e nunca dava
 *     "COMPRAR HOJE").
 *   - A sugestao desconta o consumo durante o lead time, o pedido em aberto,
 *     respeita MOQ/multiplo e e limitada pelo shelf life.
 */
import { query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';

export type MetodoDemanda = 'PLANILHA' | 'SISTEMA';

export type StatusPainel =
  | 'FORA_DE_LINHA' | 'SUBSTITUIDO' | 'FRACIONADO' | 'PRODUCAO_PROPRIA'
  | 'RUPTURA_PREVISTA' | 'ENTREGA_ATRASADA' | 'PEDIDO_EM_ANDAMENTO'
  | 'SEM_DEMANDA' | 'SEM_GIRO'
  | 'ESTOQUE_ZERADO' | 'COMPRA_ATRASADA' | 'COMPRAR_HOJE' | 'COMPRAR_EM_BREVE' | 'OK';

/** Os que a planilha marcava com "X" na coluna A. */
const STATUS_COMPRAR = new Set<StatusPainel>([
  'RUPTURA_PREVISTA', 'ESTOQUE_ZERADO', 'COMPRA_ATRASADA', 'COMPRAR_HOJE',
]);

/** Ordem de urgencia na listagem. */
const PRIORIDADE: Record<StatusPainel, number> = {
  RUPTURA_PREVISTA: 1, ESTOQUE_ZERADO: 2, COMPRA_ATRASADA: 3, COMPRAR_HOJE: 4,
  ENTREGA_ATRASADA: 5, COMPRAR_EM_BREVE: 6, PEDIDO_EM_ANDAMENTO: 7, OK: 8,
  SEM_GIRO: 9, SEM_DEMANDA: 10, PRODUCAO_PROPRIA: 11, FRACIONADO: 12,
  SUBSTITUIDO: 13, FORA_DE_LINHA: 14,
};

const DIAS_COMPRAR_EM_BREVE = 7;
const DIAS_UTEIS_COBRAR = 3;

/**
 * Uma linha por produto ativo, com todas as parcelas da conta. Status e
 * sugestao ficam no TypeScript (`classificar`), onde a regra e legivel.
 */
const SQL_PAINEL = `
WITH ref AS (
  SELECT coalesce((SELECT max(data_venda) FROM mv_demanda_diaria), CURRENT_DATE) AS fim
),
meses AS (
  SELECT m::date AS mes, least((m + interval '1 month - 1 day')::date, r.fim) AS ate
    FROM ref r,
         generate_series(date_trunc('month', r.fim) - interval '6 months',
                         date_trunc('month', r.fim), interval '1 month') AS m
),
uteis AS (
  SELECT mm.mes, mm.ate,
         count(*) FILTER (WHERE NOT fn_dia_sem_operacao(d::date)) AS dias_uteis,
         count(*) AS dias_corridos
    FROM meses mm, generate_series(mm.mes, mm.ate, interval '1 day') AS d
   GROUP BY mm.mes, mm.ate
),
fator AS (
  SELECT sum(dias_uteis)::numeric / nullif(sum(dias_corridos), 0) AS uteis_por_corrido FROM uteis
),
mensal AS (
  SELECT d.produto_id, u.mes, sum(d.quantidade) / nullif(u.dias_uteis, 0) AS por_dia_util
    FROM mv_demanda_diaria d
    JOIN uteis u ON d.data_venda BETWEEN u.mes AND u.ate
   GROUP BY d.produto_id, u.mes, u.dias_uteis
  HAVING sum(d.quantidade) > 0
),
media_planilha AS (
  SELECT produto_id, avg(por_dia_util) AS por_dia_util, count(*) AS meses_com_venda
    FROM mensal GROUP BY produto_id
),
media_sistema AS (
  SELECT d.produto_id, sum(d.quantidade) / 90.0 AS por_dia
    FROM mv_demanda_diaria d, ref r
   WHERE d.data_venda > r.fim - 90 AND d.data_venda <= r.fim
   GROUP BY d.produto_id
),
saldo AS (
  SELECT produto_id, sum(quantidade_disponivel) AS disponivel, sum(quantidade_fisica) AS fisico,
         sum(quantidade_reservada) AS reservado
    FROM estoques GROUP BY produto_id
),
abertos AS (
  SELECT i.produto_id,
         sum(i.quantidade_pedida - coalesce(i.quantidade_recebida, 0)) AS saldo,
         min(coalesce(oc.data_prometida, oc.data_prevista_entrega)) AS chegada,
         (array_agg(oc.numero ORDER BY coalesce(oc.data_prometida, oc.data_prevista_entrega)
                    NULLS LAST))[1] AS pedido
    FROM ordem_compra_itens i
    JOIN ordens_compra oc ON oc.id = i.ordem_compra_id
   WHERE oc.status IN ('APROVADA', 'ENVIADA', 'CONFIRMADA', 'EM_PRODUCAO',
                       'EM_TRANSITO', 'RECEBIMENTO_PARCIAL')
     AND i.quantidade_pedida > coalesce(i.quantidade_recebida, 0)
   GROUP BY i.produto_id
),
cotando AS (
  SELECT DISTINCT ON (cp.produto_id) cp.produto_id, c.numero
    FROM cotacao_produtos cp
    JOIN cotacoes c ON c.id = cp.cotacao_id
   WHERE c.status IN ('RASCUNHO', 'ABERTA', 'ENVIADA', 'AGUARDANDO_RESPOSTAS',
                      'EM_ANALISE', 'EM_NEGOCIACAO', 'NEGOCIACAO_NECESSARIA')
   ORDER BY cp.produto_id, c.id DESC
),
forn AS (
  SELECT DISTINCT ON (pf.produto_id)
         pf.produto_id, pf.fornecedor_id, pf.preco_atual, pf.moq, pf.multiplo_compra,
         coalesce(f.nome_fantasia, f.razao_social) AS nome
    FROM produto_fornecedor pf
    JOIN fornecedores f ON f.id = pf.fornecedor_id
   WHERE pf.ativo AND f.ativo AND f.deleted_at IS NULL
   ORDER BY pf.produto_id, pf.fornecedor_principal DESC, pf.preco_atual ASC NULLS LAST
),
base AS (
  SELECT p.id AS produto_id, p.codigo, p.descricao,
         p.situacao_compra::text AS situacao, p.classificacao_abc::text AS curva,
         p.dias_validade,
         coalesce(s.disponivel, 0) AS disponivel,
         coalesce(s.fisico, 0)     AS fisico,
         coalesce(s.reservado, 0)  AS reservado,
         mp.por_dia_util                      AS venda_dia_util_planilha,
         mp.por_dia_util * fa.uteis_por_corrido AS venda_dia_planilha,
         coalesce(mp.meses_com_venda, 0)      AS meses_com_venda,
         ms.por_dia                           AS venda_dia_sistema,
         coalesce(a.saldo, 0) AS em_aberto, a.chegada, a.pedido,
         ct.numero AS cotacao,
         f.fornecedor_id, f.nome AS fornecedor,
         coalesce(f.preco_atual, p.custo_referencia) AS preco,
         coalesce(f.moq, p.moq) AS moq,
         coalesce(f.multiplo_compra, p.multiplo_compra) AS multiplo,
         coalesce(pp.horizonte_dias, pfo.horizonte_dias, pc.horizonte_dias, pg.horizonte_dias, 30)
           AS horizonte_dias,
         CASE WHEN pp.horizonte_dias IS NOT NULL THEN 'PRODUTO'
              WHEN pfo.horizonte_dias IS NOT NULL THEN 'FORNECEDOR'
              WHEN pc.horizonte_dias IS NOT NULL THEN 'CURVA' ELSE 'GLOBAL' END AS origem_horizonte,
         coalesce(pp.estoque_minimo_dias, pfo.estoque_minimo_dias, pc.estoque_minimo_dias,
                  pg.estoque_minimo_dias, 20) AS estoque_minimo_dias,
         CASE WHEN pp.estoque_minimo_dias IS NOT NULL THEN 'PRODUTO'
              WHEN pfo.estoque_minimo_dias IS NOT NULL THEN 'FORNECEDOR'
              WHEN pc.estoque_minimo_dias IS NOT NULL THEN 'CURVA' ELSE 'GLOBAL' END
           AS origem_estoque_minimo,
         coalesce(pp.lead_time_dias, pfo.lead_time_dias, pc.lead_time_dias, pg.lead_time_dias, 7)
           AS lead_time_dias,
         CASE WHEN pp.lead_time_dias IS NOT NULL THEN 'PRODUTO'
              WHEN pfo.lead_time_dias IS NOT NULL THEN 'FORNECEDOR'
              WHEN pc.lead_time_dias IS NOT NULL THEN 'CURVA' ELSE 'GLOBAL' END AS origem_lead_time,
         CASE WHEN a.chegada IS NULL THEN NULL
              ELSE (SELECT count(*) FROM generate_series(CURRENT_DATE + 1, a.chegada, interval '1 day') d
                     WHERE NOT fn_dia_sem_operacao(d::date)) END AS dias_uteis_ate_chegada,
         r.fim AS referencia_vendas
    FROM produtos p
   CROSS JOIN ref r
   CROSS JOIN fator fa
    LEFT JOIN politicas_compra pg ON pg.escopo = 'GLOBAL'
    LEFT JOIN saldo s           ON s.produto_id = p.id
    LEFT JOIN media_planilha mp ON mp.produto_id = p.id
    LEFT JOIN media_sistema ms  ON ms.produto_id = p.id
    LEFT JOIN abertos a         ON a.produto_id = p.id
    LEFT JOIN cotando ct        ON ct.produto_id = p.id
    LEFT JOIN forn f            ON f.produto_id = p.id
    LEFT JOIN politicas_compra pp  ON pp.escopo = 'PRODUTO' AND pp.produto_id = p.id
    LEFT JOIN politicas_compra pfo ON pfo.escopo = 'FORNECEDOR' AND pfo.fornecedor_id = f.fornecedor_id
    LEFT JOIN politicas_compra pc  ON pc.escopo = 'CURVA' AND pc.curva = p.classificacao_abc
   WHERE p.deleted_at IS NULL AND p.ativo
),
calculo AS (
  SELECT b.*,
         CASE WHEN $1 = 'SISTEMA' THEN coalesce(b.venda_dia_sistema, 0)
              ELSE coalesce(b.venda_dia_planilha, 0) END AS demanda_dia
    FROM base b
)
SELECT c.*,
       CASE WHEN c.demanda_dia > 0 THEN greatest(c.disponivel, 0) / c.demanda_dia END AS cobertura_dias,
       ruptura.data AS data_ruptura,
       ruptura.data - c.estoque_minimo_dias - c.lead_time_dias AS data_inicio_compra,
       CASE WHEN ruptura.data IS NOT NULL
            THEN CURRENT_DATE - (ruptura.data - c.estoque_minimo_dias - c.lead_time_dias) END
         AS dias_atraso,
       CASE WHEN ruptura.data IS NOT NULL AND c.chegada > ruptura.data
            THEN c.chegada - ruptura.data END AS dias_ruptura,
       CURRENT_DATE AS hoje,
       CURRENT_DATE + ${DIAS_COMPRAR_EM_BREVE} AS limite_em_breve
  FROM calculo c
  LEFT JOIN LATERAL (
    SELECT CASE WHEN c.demanda_dia <= 0 THEN NULL::date
                WHEN c.disponivel <= 0 THEN CURRENT_DATE
                -- Limite de 10 anos: demanda residual daria uma data absurda.
                ELSE CURRENT_DATE + least(floor(c.disponivel / c.demanda_dia), 3650)::int
           END AS data
  ) ruptura ON true`;

interface LinhaBruta {
  produto_id: number; codigo: string; descricao: string; situacao: string; curva: string | null;
  dias_validade: number | null; disponivel: number; fisico: number; reservado: number;
  venda_dia_util_planilha: number | null; venda_dia_planilha: number | null;
  meses_com_venda: number; venda_dia_sistema: number | null;
  em_aberto: number; chegada: string | null; pedido: string | null; cotacao: string | null;
  fornecedor_id: number | null; fornecedor: string | null; preco: number | null;
  moq: number | null; multiplo: number | null;
  horizonte_dias: number; origem_horizonte: string;
  estoque_minimo_dias: number; origem_estoque_minimo: string;
  lead_time_dias: number; origem_lead_time: string;
  dias_uteis_ate_chegada: number | null; referencia_vendas: string;
  demanda_dia: number; cobertura_dias: number | null;
  data_ruptura: string | null; data_inicio_compra: string | null;
  dias_atraso: number | null; dias_ruptura: number | null;
  hoje: string; limite_em_breve: string;
}

export interface LinhaPainel extends LinhaBruta {
  status: StatusPainel;
  comprar: boolean;
  acompanhamento: 'ATRASADO' | 'COBRAR' | null;
  unidades_em_ruptura: number | null;
  sugerida: number;
  limitada_validade: boolean;
  valor_sugerido: number | null;
}

const SITUACAO_STATUS: Record<string, StatusPainel> = {
  FORA_DE_LINHA: 'FORA_DE_LINHA',
  SUBSTITUIDO: 'SUBSTITUIDO',
  FRACIONADO: 'FRACIONADO',
  PRODUCAO_PROPRIA: 'PRODUCAO_PROPRIA',
};

function definirStatus(l: LinhaBruta): StatusPainel {
  const situacao = SITUACAO_STATUS[l.situacao];
  if (situacao) return situacao;

  if (l.chegada) {
    if (l.data_ruptura && l.chegada > l.data_ruptura) return 'RUPTURA_PREVISTA';
    if (l.chegada < l.hoje) return 'ENTREGA_ATRASADA';
    return 'PEDIDO_EM_ANDAMENTO';
  }

  if (l.demanda_dia <= 0) return l.disponivel > 0 ? 'SEM_GIRO' : 'SEM_DEMANDA';
  if (l.disponivel <= 0) return 'ESTOQUE_ZERADO';
  if (l.data_inicio_compra! < l.hoje) return 'COMPRA_ATRASADA';
  if (l.data_inicio_compra === l.hoje) return 'COMPRAR_HOJE';
  if (l.data_inicio_compra! <= l.limite_em_breve) return 'COMPRAR_EM_BREVE';
  return 'OK';
}

/**
 * Quantidade para cobrir lead time + horizonte + estoque minimo, descontado o
 * que ja existe (disponivel e pedido em aberto). Na chegada do pedido, o
 * estoque tera caido o consumo do lead time - a planilha ignorava isso.
 */
export function sugerirQuantidade(l: Pick<LinhaBruta,
  'demanda_dia' | 'disponivel' | 'em_aberto' | 'lead_time_dias' | 'horizonte_dias'
  | 'estoque_minimo_dias' | 'moq' | 'multiplo' | 'dias_validade'>,
): { quantidade: number; limitada_validade: boolean } {
  if (l.demanda_dia <= 0) return { quantidade: 0, limitada_validade: false };

  const dias = l.lead_time_dias + l.horizonte_dias + l.estoque_minimo_dias;
  const necessidade = l.demanda_dia * dias - (Math.max(l.disponivel, 0) + l.em_aberto);
  if (necessidade <= 0) return { quantidade: 0, limitada_validade: false };

  const multiplo = l.multiplo && l.multiplo > 0 ? l.multiplo : 1;
  let quantidade = Math.ceil(Math.ceil(necessidade) / multiplo) * multiplo;
  if (l.moq && quantidade < l.moq) quantidade = Math.ceil(l.moq / multiplo) * multiplo;

  // Shelf life: nao comprar mais do que se vende antes de vencer.
  if (l.dias_validade && l.dias_validade > 0) {
    const naChegada = Math.max(l.disponivel - l.demanda_dia * l.lead_time_dias, 0) + l.em_aberto;
    const limite = l.demanda_dia * l.dias_validade - naChegada;
    if (quantidade > limite) {
      return {
        quantidade: Math.max(0, Math.floor(limite / multiplo) * multiplo),
        limitada_validade: true,
      };
    }
  }
  return { quantidade, limitada_validade: false };
}

function classificar(l: LinhaBruta): LinhaPainel {
  const status = definirStatus(l);
  const comprar = STATUS_COMPRAR.has(status);

  let acompanhamento: LinhaPainel['acompanhamento'] = null;
  if (l.chegada) {
    if (l.chegada < l.hoje) acompanhamento = 'ATRASADO';
    else if ((l.dias_uteis_ate_chegada ?? 99) <= DIAS_UTEIS_COBRAR) acompanhamento = 'COBRAR';
  }

  const sugere = (comprar || status === 'COMPRAR_EM_BREVE') && l.situacao === 'NORMAL';
  const { quantidade, limitada_validade } = sugere
    ? sugerirQuantidade(l)
    : { quantidade: 0, limitada_validade: false };

  return {
    ...l,
    status,
    comprar,
    acompanhamento,
    unidades_em_ruptura: l.dias_ruptura ? Math.round(l.dias_ruptura * l.demanda_dia) : null,
    sugerida: quantidade,
    limitada_validade,
    valor_sugerido: l.preco !== null ? Math.round(quantidade * l.preco * 100) / 100 : null,
  };
}

export interface FiltroPainel {
  metodo: MetodoDemanda;
  busca?: string | undefined;
  curva?: string | undefined;
  status?: string | undefined;
  situacao?: string | undefined;
  acompanhamento?: string | undefined;
  fornecedor_id?: number | undefined;
  somente_comprar?: boolean | undefined;
  pagina: number;
  limite: number;
}

const normalizarBusca = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

export async function painel(filtro: FiltroPainel) {
  const { rows } = await query<LinhaBruta>(SQL_PAINEL, [filtro.metodo]);
  const linhas = rows.map(classificar);

  const busca = filtro.busca ? normalizarBusca(filtro.busca) : null;
  // Os contadores por status ignoram o proprio filtro de status, para a tela
  // mostrar quantos existem em cada um enquanto o usuario troca de status.
  const semStatus = linhas.filter((l) =>
    (!busca || normalizarBusca(`${l.codigo} ${l.descricao}`).includes(busca))
    && (!filtro.curva || (l.curva ?? 'SEM') === filtro.curva)
    && (!filtro.situacao || l.situacao === filtro.situacao)
    && (!filtro.fornecedor_id || l.fornecedor_id === filtro.fornecedor_id)
    && (!filtro.acompanhamento || l.acompanhamento === filtro.acompanhamento)
    && (!filtro.somente_comprar || l.comprar));

  const filtradas = filtro.status
    ? semStatus.filter((l) => l.status === filtro.status)
    : semStatus;

  filtradas.sort((a, b) =>
    PRIORIDADE[a.status] - PRIORIDADE[b.status]
    || (a.data_inicio_compra ?? '9999').localeCompare(b.data_inicio_compra ?? '9999')
    || (a.curva ?? 'Z').localeCompare(b.curva ?? 'Z')
    || a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true }));

  const porStatus: Record<string, number> = {};
  for (const l of semStatus) porStatus[l.status] = (porStatus[l.status] ?? 0) + 1;

  const comprar = semStatus.filter((l) => l.comprar);
  const inicio = (filtro.pagina - 1) * filtro.limite;

  return {
    linhas: filtradas.slice(inicio, inicio + filtro.limite),
    total: filtradas.length,
    resumo: {
      metodo: filtro.metodo,
      referencia_vendas: rows[0]?.referencia_vendas ?? null,
      produtos: semStatus.length,
      por_status: porStatus,
      itens_comprar: comprar.length,
      valor_sugerido: Math.round(comprar.reduce((s, l) => s + (l.valor_sugerido ?? 0), 0) * 100) / 100,
      sem_preco: comprar.filter((l) => l.sugerida > 0 && l.preco === null).length,
      cobrar: semStatus.filter((l) => l.acompanhamento === 'COBRAR').length,
      entregas_atrasadas: semStatus.filter((l) => l.acompanhamento === 'ATRASADO').length,
    },
  };
}

// ---------------------------------------------------------------------------
// Situacao de compra do produto
// ---------------------------------------------------------------------------

export const SITUACOES = ['NORMAL', 'FORA_DE_LINHA', 'SUBSTITUIDO', 'FRACIONADO', 'PRODUCAO_PROPRIA'] as const;

export async function definirSituacao(
  produtoId: number, situacao: (typeof SITUACOES)[number],
): Promise<{ produto_id: number; situacao: string }> {
  const { rowCount } = await query(`
    UPDATE produtos SET situacao_compra = $2::situacao_compra_enum, updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL`, [produtoId, situacao]);
  if (!rowCount) throw naoEncontrado('Produto');
  return { produto_id: produtoId, situacao };
}

// ---------------------------------------------------------------------------
// Politicas de compra
// ---------------------------------------------------------------------------

export async function listarPoliticas() {
  const { rows } = await query(`
    SELECT pc.id, pc.escopo::text AS escopo, pc.curva::text AS curva,
           pc.fornecedor_id, coalesce(f.nome_fantasia, f.razao_social) AS fornecedor,
           pc.produto_id, p.codigo AS produto_codigo, p.descricao AS produto_descricao,
           pc.horizonte_dias, pc.estoque_minimo_dias, pc.lead_time_dias,
           pc.observacao, pc.updated_at, u.nome AS atualizado_por
      FROM politicas_compra pc
      LEFT JOIN fornecedores f ON f.id = pc.fornecedor_id
      LEFT JOIN produtos p     ON p.id = pc.produto_id
      LEFT JOIN usuarios u     ON u.id = pc.updated_by
     ORDER BY CASE pc.escopo WHEN 'GLOBAL' THEN 1 WHEN 'CURVA' THEN 2
                             WHEN 'FORNECEDOR' THEN 3 ELSE 4 END,
              pc.curva, fornecedor, p.codigo`);
  return rows;
}

export interface EntradaPolitica {
  escopo: 'GLOBAL' | 'CURVA' | 'FORNECEDOR' | 'PRODUTO';
  curva?: 'A' | 'B' | 'C' | null | undefined;
  fornecedor_id?: number | null | undefined;
  produto_codigo?: string | null | undefined;
  horizonte_dias?: number | null | undefined;
  estoque_minimo_dias?: number | null | undefined;
  lead_time_dias?: number | null | undefined;
  observacao?: string | null | undefined;
}

export async function salvarPolitica(e: EntradaPolitica, contexto: ContextoSessao) {
  let produtoId: number | null = null;
  if (e.escopo === 'PRODUTO') {
    const codigo = String(e.produto_codigo ?? '').trim().toUpperCase();
    // "1674" digitado acha o "01674" do cadastro; o codigo exato vence.
    const { rows } = await query<{ id: number }>(`
      SELECT id FROM produtos
       WHERE deleted_at IS NULL
         AND (upper(codigo) = $1
              OR ($1 ~ '^[0-9]+$' AND codigo ~ '^[0-9]+$'
                  AND ltrim(codigo, '0') = ltrim($1, '0')))
       ORDER BY (upper(codigo) = $1) DESC
       LIMIT 1`, [codigo]);
    if (!rows.length) throw regraNegocio(`Produto ${codigo} nao encontrado`);
    produtoId = rows[0]!.id;
  }
  if (e.escopo === 'CURVA' && !e.curva) throw regraNegocio('Informe a curva (A, B ou C)');
  if (e.escopo === 'FORNECEDOR' && !e.fornecedor_id) throw regraNegocio('Informe o fornecedor');

  const valores = [e.horizonte_dias, e.estoque_minimo_dias, e.lead_time_dias];
  if (e.escopo === 'GLOBAL' && valores.some((v) => v === null || v === undefined)) {
    throw regraNegocio('A politica global precisa de horizonte, estoque minimo e lead time');
  }
  if (valores.every((v) => v === null || v === undefined)) {
    throw regraNegocio('Informe ao menos um valor: horizonte, estoque minimo ou lead time');
  }

  const { rows } = await query(`
    INSERT INTO politicas_compra
      (escopo, curva, fornecedor_id, produto_id, horizonte_dias, estoque_minimo_dias,
       lead_time_dias, observacao, updated_by)
    VALUES ($1::escopo_politica_compra_enum, $2::classificacao_abc_enum, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (escopo, curva, fornecedor_id, produto_id) DO UPDATE
      SET horizonte_dias = EXCLUDED.horizonte_dias,
          estoque_minimo_dias = EXCLUDED.estoque_minimo_dias,
          lead_time_dias = EXCLUDED.lead_time_dias,
          observacao = EXCLUDED.observacao,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
    RETURNING id`,
  [e.escopo, e.escopo === 'CURVA' ? e.curva : null,
    e.escopo === 'FORNECEDOR' ? e.fornecedor_id : null, produtoId,
    e.horizonte_dias ?? null, e.estoque_minimo_dias ?? null, e.lead_time_dias ?? null,
    e.observacao ?? null, contexto.usuarioId ?? null]);
  return rows[0];
}

export async function removerPolitica(id: number): Promise<void> {
  const { rows } = await query<{ escopo: string }>(
    'SELECT escopo::text AS escopo FROM politicas_compra WHERE id = $1', [id]);
  if (!rows.length) throw naoEncontrado('Politica de compra');
  if (rows[0]!.escopo === 'GLOBAL') {
    throw regraNegocio('A politica global e o padrao de todos os produtos: altere, nao remova');
  }
  await query('DELETE FROM politicas_compra WHERE id = $1', [id]);
}
