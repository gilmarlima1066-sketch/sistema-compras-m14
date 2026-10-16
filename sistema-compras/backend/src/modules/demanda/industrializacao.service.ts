/**
 * Historico de industrializados: o produto que saiu do estoque para ser
 * processado (fracionado, embalado). E consumo interno - nao e venda, mas
 * tira produto da prateleira e entra na conta de quem compra.
 *
 * Duas leituras: os itens, linha a linha, e o total por produto no periodo.
 * So a situacao OK (efetivado) entra nos totais; AB e AL aparecem na lista
 * para conferencia.
 */
import { query } from '../../config/database.js';
import { metaPaginacao } from '../../core/paginacao.js';

export interface FiltroIndustrializacao {
  busca?: string | undefined;
  situacao?: string | undefined;
  data_inicio?: Date | undefined;
  data_fim?: Date | undefined;
  dias?: number | undefined;
  visao: 'itens' | 'produtos';
  pagina: number;
  limite: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Ultimos N dias contados do ultimo lancamento importado, ou o intervalo dado. */
async function periodo(filtro: FiltroIndustrializacao) {
  if (filtro.data_inicio && filtro.data_fim) {
    return { inicio: iso(filtro.data_inicio), fim: iso(filtro.data_fim) };
  }
  const { rows } = await query<{ ultima: string | null }>(
    'SELECT max(data_inclusao)::text AS ultima FROM historico_industrializacao');
  const fim = rows[0]?.ultima ? new Date(`${rows[0].ultima}T00:00:00Z`) : new Date();
  const dias = filtro.dias ?? 90;
  return { inicio: iso(new Date(fim.getTime() - (dias - 1) * 86400000)), fim: iso(fim) };
}

export async function listar(filtro: FiltroIndustrializacao) {
  const p = await periodo(filtro);
  const valores: unknown[] = [p.inicio, p.fim];
  const cond = ['h.data_inclusao BETWEEN $1 AND $2'];
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`, filtro.busca.trim());
    const i = valores.length - 1;
    cond.push(`(h.produto_codigo ILIKE $${i} OR h.produto_descricao ILIKE $${i}
                OR p.descricao ILIKE $${i} OR h.documento_erp = $${i + 1} OR h.usuario ILIKE $${i})`);
  }
  if (filtro.situacao) {
    valores.push(filtro.situacao.toUpperCase());
    cond.push(`h.situacao = $${valores.length}`);
  }
  const de = `FROM historico_industrializacao h
              LEFT JOIN produtos p ON p.id = h.produto_id
             WHERE ${cond.join(' AND ')}`;

  const resumo = await query(`
    SELECT count(*)::int AS itens, count(DISTINCT h.documento_erp)::int AS documentos,
           count(DISTINCT h.produto_codigo)::int AS produtos,
           coalesce(sum(h.quantidade) FILTER (WHERE h.situacao = 'OK'), 0) AS quantidade,
           coalesce(sum(h.quantidade * h.peso_liquido) FILTER (WHERE h.situacao = 'OK'), 0) AS peso_total,
           count(*) FILTER (WHERE h.situacao IS DISTINCT FROM 'OK')::int AS fora_de_ok
      ${de}`, valores);

  const limite = valores.length + 1;
  const desloc = valores.length + 2;
  const pagina = [filtro.limite, (filtro.pagina - 1) * filtro.limite];

  if (filtro.visao === 'produtos') {
    const { rows } = await query<Record<string, unknown> & { total_geral: number }>(`
      SELECT h.produto_codigo, coalesce(max(p.descricao), max(h.produto_descricao)) AS produto_descricao,
             max(h.produto_id) AS produto_id,
             count(*)::int AS itens, count(DISTINCT h.documento_erp)::int AS documentos,
             coalesce(sum(h.quantidade) FILTER (WHERE h.situacao = 'OK'), 0) AS quantidade,
             coalesce(sum(h.quantidade * h.peso_liquido) FILTER (WHERE h.situacao = 'OK'), 0) AS peso_total,
             max(h.peso_liquido) AS peso_liquido,
             max(h.data_inclusao)::text AS ultima_data,
             count(*) OVER ()::int AS total_geral
        ${de}
       GROUP BY h.produto_codigo
       ORDER BY peso_total DESC, h.produto_codigo
       LIMIT $${limite} OFFSET $${desloc}`, [...valores, ...pagina]);
    return montar(rows, resumo.rows[0], p, filtro);
  }

  const { rows } = await query<Record<string, unknown> & { total_geral: number }>(`
    SELECT h.id, h.documento_erp, h.item, h.data_inclusao::text AS data_inclusao, h.situacao, h.usuario,
           h.estoque_saida, h.estoque_entrada, h.produto_codigo,
           coalesce(p.descricao, h.produto_descricao) AS produto_descricao, h.produto_id,
           h.quantidade, h.peso_liquido, h.quantidade * h.peso_liquido AS peso_total,
           count(*) OVER ()::int AS total_geral
      ${de}
     ORDER BY h.data_inclusao DESC, h.documento_erp DESC, h.id
     LIMIT $${limite} OFFSET $${desloc}`, [...valores, ...pagina]);
  return montar(rows, resumo.rows[0], p, filtro);
}

function montar(
  rows: Array<Record<string, unknown> & { total_geral: number }>,
  resumo: unknown, p: { inicio: string; fim: string }, filtro: FiltroIndustrializacao,
) {
  const total = rows[0]?.total_geral ?? 0;
  return {
    dados: rows.map(({ total_geral: _t, ...r }) => r),
    meta: {
      ...metaPaginacao(total, { pagina: filtro.pagina, limite: filtro.limite, ordem: 'desc' }),
      periodo: p,
      resumo,
    },
  };
}
