/**
 * Cobertura do estoque: quantos dias o saldo disponivel dura na venda real.
 *
 * A visao antiga (vw_produtos_criticos) media a cobertura pela demanda
 * cadastrada em parametros_estoque - vazia para produto importado do ERP, o
 * que deixava tudo como "RUPTURA". Aqui a demanda e a venda dos ultimos 90
 * dias, e as faixas usam o lead time e o estoque minimo das politicas de
 * compra (as mesmas do Painel de Gestao de Compras).
 */
import { query } from '../../config/database.js';

export const FAIXAS = ['ZERADO', 'CRITICO', 'ATENCAO', 'ADEQUADO', 'EXCESSO', 'SEM_GIRO', 'SEM_MOVIMENTO'] as const;
export type Faixa = (typeof FAIXAS)[number];

const SQL = `
WITH ref AS (
  SELECT coalesce((SELECT max(data_venda) FROM mv_demanda_diaria), CURRENT_DATE) AS fim
),
venda AS (
  SELECT d.produto_id, sum(d.quantidade) / 90.0 AS por_dia
    FROM mv_demanda_diaria d, ref r
   WHERE d.data_venda > r.fim - 90 AND d.data_venda <= r.fim
   GROUP BY d.produto_id
),
ultima AS (
  SELECT produto_id, max(data_venda) AS data FROM mv_demanda_diaria GROUP BY produto_id
),
saldo AS (
  SELECT produto_id, sum(quantidade_fisica) AS fisico, sum(quantidade_reservada) AS reservado,
         sum(quantidade_disponivel) AS disponivel
    FROM estoques GROUP BY produto_id
),
abertos AS (
  SELECT i.produto_id,
         sum(i.quantidade_pedida - coalesce(i.quantidade_recebida, 0)) AS saldo,
         min(coalesce(oc.data_prometida, oc.data_prevista_entrega)) AS chegada
    FROM ordem_compra_itens i
    JOIN ordens_compra oc ON oc.id = i.ordem_compra_id
   WHERE oc.status IN ('APROVADA', 'ENVIADA', 'CONFIRMADA', 'EM_PRODUCAO',
                       'EM_TRANSITO', 'RECEBIMENTO_PARCIAL')
     AND i.quantidade_pedida > coalesce(i.quantidade_recebida, 0)
   GROUP BY i.produto_id
),
forn AS (
  SELECT DISTINCT ON (pf.produto_id) pf.produto_id, pf.fornecedor_id, pf.preco_atual
    FROM produto_fornecedor pf
    JOIN fornecedores f ON f.id = pf.fornecedor_id
   WHERE pf.ativo AND f.ativo AND f.deleted_at IS NULL
   ORDER BY pf.produto_id, pf.fornecedor_principal DESC, pf.preco_atual ASC NULLS LAST
),
cfg AS (
  SELECT coalesce((SELECT valor::numeric FROM configuracoes
                    WHERE chave = 'planejamento.limite_excesso_cobertura'), 120) AS excesso
)
SELECT p.id AS produto_id, p.codigo, p.descricao, c.nome AS categoria, u.codigo AS unidade,
       p.classificacao_abc::text AS curva,
       coalesce(s.fisico, 0) AS fisico, coalesce(s.reservado, 0) AS reservado,
       coalesce(s.disponivel, 0) AS disponivel,
       coalesce(a.saldo, 0) AS em_pedido, a.chegada,
       v.por_dia AS venda_dia, ul.data AS ultima_venda,
       CASE WHEN v.por_dia > 0 THEN greatest(coalesce(s.disponivel, 0), 0) / v.por_dia END
         AS cobertura_dias,
       coalesce(pp.lead_time_dias, pfo.lead_time_dias, pc.lead_time_dias, pg.lead_time_dias, 7)
         AS lead_time_dias,
       coalesce(pp.estoque_minimo_dias, pfo.estoque_minimo_dias, pc.estoque_minimo_dias,
                pg.estoque_minimo_dias, 20) AS estoque_minimo_dias,
       cfg.excesso AS excesso_dias,
       coalesce(p.custo_referencia, f.preco_atual) AS custo
  FROM produtos p
  JOIN categorias c ON c.id = p.categoria_id
  JOIN unidades u   ON u.id = p.unidade_estoque_id
 CROSS JOIN cfg
  LEFT JOIN saldo s    ON s.produto_id = p.id
  LEFT JOIN venda v    ON v.produto_id = p.id
  LEFT JOIN ultima ul  ON ul.produto_id = p.id
  LEFT JOIN abertos a  ON a.produto_id = p.id
  LEFT JOIN forn f     ON f.produto_id = p.id
  LEFT JOIN politicas_compra pg  ON pg.escopo = 'GLOBAL'
  LEFT JOIN politicas_compra pp  ON pp.escopo = 'PRODUTO' AND pp.produto_id = p.id
  LEFT JOIN politicas_compra pfo ON pfo.escopo = 'FORNECEDOR' AND pfo.fornecedor_id = f.fornecedor_id
  LEFT JOIN politicas_compra pc  ON pc.escopo = 'CURVA' AND pc.curva = p.classificacao_abc
 WHERE p.deleted_at IS NULL AND p.ativo`;

interface Linha {
  produto_id: number; codigo: string; descricao: string; categoria: string; unidade: string;
  curva: string | null; fisico: number; reservado: number; disponivel: number;
  em_pedido: number; chegada: string | null; venda_dia: number | null; ultima_venda: string | null;
  cobertura_dias: number | null; lead_time_dias: number; estoque_minimo_dias: number;
  excesso_dias: number; custo: number | null;
}

export interface LinhaCobertura extends Linha {
  faixa: Faixa;
  valor: number | null;
}

/** A faixa diz o que fazer: comprar ja, acompanhar, nada, ou parar de comprar. */
function faixaDe(l: Linha): Faixa {
  if (!l.venda_dia || l.venda_dia <= 0) return l.disponivel > 0 ? 'SEM_GIRO' : 'SEM_MOVIMENTO';
  if (l.disponivel <= 0) return 'ZERADO';
  const dias = l.cobertura_dias ?? 0;
  if (dias < l.lead_time_dias) return 'CRITICO';
  if (dias < l.lead_time_dias + l.estoque_minimo_dias) return 'ATENCAO';
  if (dias > l.excesso_dias) return 'EXCESSO';
  return 'ADEQUADO';
}

const ORDEM_FAIXA: Record<Faixa, number> = {
  ZERADO: 1, CRITICO: 2, ATENCAO: 3, ADEQUADO: 4, EXCESSO: 5, SEM_GIRO: 6, SEM_MOVIMENTO: 7,
};

export interface FiltroCobertura {
  busca?: string | undefined;
  faixa?: Faixa | undefined;
  curva?: string | undefined;
  ordenar: 'urgencia' | 'cobertura' | 'valor' | 'venda' | 'codigo';
  pagina: number;
  limite: number;
}

const normalizar = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

export async function cobertura(filtro: FiltroCobertura) {
  const { rows } = await query<Linha>(SQL);
  const todas: LinhaCobertura[] = rows.map((l) => ({
    ...l,
    faixa: faixaDe(l),
    valor: l.custo !== null ? Math.round(Math.max(l.disponivel, 0) * l.custo * 100) / 100 : null,
  }));

  const busca = filtro.busca ? normalizar(filtro.busca) : null;
  // O resumo ignora o filtro de faixa: a barra mostra sempre o todo.
  const semFaixa = todas.filter((l) =>
    (!busca || normalizar(`${l.codigo} ${l.descricao}`).includes(busca))
    && (!filtro.curva || (l.curva ?? 'SEM') === filtro.curva));
  const filtradas = filtro.faixa ? semFaixa.filter((l) => l.faixa === filtro.faixa) : semFaixa;

  const cmp: Record<FiltroCobertura['ordenar'], (a: LinhaCobertura, b: LinhaCobertura) => number> = {
    urgencia: (a, b) => ORDEM_FAIXA[a.faixa] - ORDEM_FAIXA[b.faixa]
      || (a.cobertura_dias ?? 1e9) - (b.cobertura_dias ?? 1e9)
      || (b.venda_dia ?? 0) - (a.venda_dia ?? 0),
    cobertura: (a, b) => (a.cobertura_dias ?? 1e9) - (b.cobertura_dias ?? 1e9),
    valor: (a, b) => (b.valor ?? -1) - (a.valor ?? -1),
    venda: (a, b) => (b.venda_dia ?? 0) - (a.venda_dia ?? 0),
    codigo: (a, b) => a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true }),
  };
  filtradas.sort((a, b) => cmp[filtro.ordenar](a, b)
    || a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true }));

  const porFaixa = Object.fromEntries(FAIXAS.map((f) => [f, { produtos: 0, valor: 0 }])) as
    Record<Faixa, { produtos: number; valor: number }>;
  for (const l of semFaixa) {
    porFaixa[l.faixa].produtos += 1;
    porFaixa[l.faixa].valor += l.valor ?? 0;
  }
  const valorTotal = semFaixa.reduce((s, l) => s + (l.valor ?? 0), 0);

  const inicio = (filtro.pagina - 1) * filtro.limite;
  return {
    linhas: filtradas.slice(inicio, inicio + filtro.limite),
    total: filtradas.length,
    resumo: {
      produtos: semFaixa.length,
      por_faixa: porFaixa,
      valor_total: Math.round(valorTotal * 100) / 100,
      valor_parado: Math.round((porFaixa.SEM_GIRO.valor + porFaixa.EXCESSO.valor) * 100) / 100,
      sem_custo: semFaixa.filter((l) => l.disponivel > 0 && l.custo === null).length,
    },
  };
}
