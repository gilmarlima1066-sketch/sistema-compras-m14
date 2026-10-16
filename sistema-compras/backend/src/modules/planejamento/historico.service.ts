/**
 * Historico de compras: as entradas importadas do ERP, lidas de dois lados.
 *
 * - Por produto: todo fornecedor que ja vendeu aquele item, com a ultima
 *   compra (data, PC, quantidade, preco) e a variacao contra a compra anterior.
 * - Por fornecedor: todo produto que ele ja vendeu, com o ultimo preco pago.
 *
 * As chaves sao o codigo do produto e o ID do ERP do fornecedor, gravados na
 * propria compra: a consulta funciona mesmo para compra de produto ou
 * fornecedor que ainda nao esta no cadastro.
 */
import { query } from '../../config/database.js';
import { naoEncontrado } from '../../core/errors.js';
import { metaPaginacao } from '../../core/paginacao.js';

/** Sugestoes da caixa de busca: produtos e fornecedores que aparecem no historico. */
export async function buscar(termo: string) {
  const like = `%${termo}%`;
  const [produtos, fornecedores] = await Promise.all([
    query<{ codigo: string; descricao: string | null; compras: number; ultima: string }>(`
      SELECT h.produto_codigo AS codigo,
             coalesce(max(p.descricao), max(h.produto_descricao)) AS descricao,
             count(*)::int AS compras, max(h.data_entrada)::text AS ultima
        FROM historico_compras h
        LEFT JOIN produtos p ON p.id = h.produto_id
       WHERE h.produto_codigo ILIKE $1 OR ltrim(h.produto_codigo, '0') = ltrim($2, '0')
          OR h.produto_descricao ILIKE $1 OR p.descricao ILIKE $1
       GROUP BY h.produto_codigo
       ORDER BY (h.produto_codigo = upper($2)) DESC, max(h.data_entrada) DESC
       LIMIT 8`, [like, termo]),
    query<{ codigo: string; nome: string | null; razao_social: string | null; compras: number; ultima: string }>(`
      SELECT h.fornecedor_codigo_erp AS codigo,
             coalesce(max(f.nome_fantasia), max(h.fornecedor_nome)) AS nome,
             max(f.razao_social) AS razao_social,
             count(*)::int AS compras, max(h.data_entrada)::text AS ultima
        FROM historico_compras h
        LEFT JOIN fornecedores f ON f.id = h.fornecedor_id
       WHERE h.fornecedor_codigo_erp = $2 OR h.fornecedor_nome ILIKE $1
          OR f.nome_fantasia ILIKE $1 OR f.razao_social ILIKE $1
          OR f.cnpj = regexp_replace($2, '\\D', '', 'g')
       GROUP BY h.fornecedor_codigo_erp
       ORDER BY (h.fornecedor_codigo_erp = $2) DESC, max(h.data_entrada) DESC
       LIMIT 8`, [like, termo]),
  ]);
  return { produtos: produtos.rows, fornecedores: fornecedores.rows };
}

/** Colunas da ultima compra e da anterior, para a variacao de preco. */
const ULTIMA = `
  max(data_entrada) FILTER (WHERE rn = 1)::text       AS ultima_data,
  max(pedido) FILTER (WHERE rn = 1)                   AS ultimo_pedido,
  sum(quantidade_caixas) FILTER (WHERE rn = 1)        AS ultima_quantidade,
  max(total_kg) FILTER (WHERE rn = 1)                 AS ultimo_total_kg,
  max(preco_caixa) FILTER (WHERE rn = 1)              AS ultimo_preco_caixa,
  max(preco_kg) FILTER (WHERE rn = 1)                 AS ultimo_preco_kg,
  max(kg_caixa) FILTER (WHERE rn = 1)                 AS kg_caixa,
  max(aliquota_icms) FILTER (WHERE rn = 1)            AS aliquota_icms,
  max(aliquota_icms_reduzida) FILTER (WHERE rn = 1)   AS aliquota_icms_reduzida,
  max(aliquota_pis_cofins) FILTER (WHERE rn = 1)      AS aliquota_pis_cofins,
  max(tipo) FILTER (WHERE rn = 1)                     AS ultimo_tipo,
  max(preco_caixa) FILTER (WHERE rn = 2)              AS preco_anterior_caixa,
  count(*)::int                                       AS compras,
  count(DISTINCT pedido)::int                         AS pedidos,
  sum(quantidade_caixas)                              AS total_caixas,
  min(preco_caixa)                                    AS menor_preco_caixa,
  max(preco_caixa)                                    AS maior_preco_caixa,
  min(data_entrada)::text                             AS primeira_data`;

export async function porProduto(codigo: string) {
  const { rows: cab } = await query<{ codigo: string; descricao: string | null; produto_id: number | null; unidade: string | null; curva: string | null }>(`
    SELECT h.produto_codigo AS codigo,
           coalesce(max(p.descricao), max(h.produto_descricao)) AS descricao,
           max(p.id) AS produto_id, max(u.codigo) AS unidade, max(p.classificacao_abc::text) AS curva
      FROM historico_compras h
      LEFT JOIN produtos p ON p.id = h.produto_id
      LEFT JOIN unidades u ON u.id = p.unidade_estoque_id
     WHERE h.produto_codigo = upper($1)
     GROUP BY h.produto_codigo`, [codigo]);
  if (!cab[0]) throw naoEncontrado('Compra deste produto');

  const { rows } = await query(`
    WITH h AS (
      SELECT h.*, row_number() OVER (PARTITION BY h.fornecedor_codigo_erp
                                     ORDER BY h.data_entrada DESC, h.id DESC) AS rn
        FROM historico_compras h WHERE h.produto_codigo = upper($1)
    )
    SELECT h.fornecedor_codigo_erp AS fornecedor_codigo,
           coalesce(max(f.nome_fantasia), max(h.fornecedor_nome)) AS fornecedor_nome,
           max(f.razao_social) AS razao_social, bool_or(f.ativo) AS fornecedor_ativo,
           max(f.id) AS fornecedor_id,
           ${ULTIMA}
      FROM h LEFT JOIN fornecedores f ON f.id = h.fornecedor_id
     GROUP BY h.fornecedor_codigo_erp
     ORDER BY max(h.data_entrada) DESC`, [codigo]);
  return { produto: cab[0], fornecedores: rows };
}

export async function porFornecedor(codigoErp: string) {
  const { rows: cab } = await query(`
    SELECT h.fornecedor_codigo_erp AS codigo,
           coalesce(max(f.nome_fantasia), max(h.fornecedor_nome)) AS nome,
           max(f.razao_social) AS razao_social, max(f.cnpj) AS cnpj, bool_or(f.ativo) AS ativo,
           max(f.contato) AS contato, max(f.telefone) AS telefone, max(f.email) AS email,
           max(f.cidade) AS cidade, max(f.estado) AS estado,
           count(DISTINCT h.pedido)::int AS pedidos, count(DISTINCT h.produto_codigo)::int AS produtos,
           min(h.data_entrada)::text AS primeira_data, max(h.data_entrada)::text AS ultima_data,
           sum(h.quantidade_caixas * coalesce(h.preco_caixa, 0)) AS valor_total
      FROM historico_compras h
      LEFT JOIN fornecedores f ON f.id = h.fornecedor_id
     WHERE h.fornecedor_codigo_erp = $1
     GROUP BY h.fornecedor_codigo_erp`, [codigoErp]);
  if (!cab[0]) throw naoEncontrado('Compra deste fornecedor');

  const { rows } = await query(`
    WITH h AS (
      SELECT h.*, row_number() OVER (PARTITION BY h.produto_codigo
                                     ORDER BY h.data_entrada DESC, h.id DESC) AS rn
        FROM historico_compras h WHERE h.fornecedor_codigo_erp = $1
    )
    SELECT h.produto_codigo, coalesce(max(p.descricao), max(h.produto_descricao)) AS produto_descricao,
           max(p.id) AS produto_id, max(p.classificacao_abc::text) AS curva,
           ${ULTIMA}
      FROM h LEFT JOIN produtos p ON p.id = h.produto_id
     GROUP BY h.produto_codigo
     ORDER BY max(h.data_entrada) DESC, h.produto_codigo`, [codigoErp]);
  return { fornecedor: cab[0], produtos: rows };
}

/** As entradas, linha a linha: ultimas do sistema ou de um produto/fornecedor. */
export async function itens(filtro: {
  produto?: string | undefined; fornecedor?: string | undefined; pagina: number; limite: number;
}) {
  const cond: string[] = [];
  const valores: unknown[] = [];
  if (filtro.produto) { valores.push(filtro.produto.toUpperCase()); cond.push(`h.produto_codigo = $${valores.length}`); }
  if (filtro.fornecedor) { valores.push(filtro.fornecedor); cond.push(`h.fornecedor_codigo_erp = $${valores.length}`); }
  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const { rows } = await query<Record<string, unknown> & { total_geral: number }>(`
    SELECT h.id, h.data_entrada::text AS data_entrada, h.pedido, h.produto_codigo,
           coalesce(p.descricao, h.produto_descricao) AS produto_descricao,
           h.fornecedor_codigo_erp AS fornecedor_codigo,
           coalesce(f.nome_fantasia, h.fornecedor_nome) AS fornecedor_nome,
           h.kg_caixa, h.quantidade_caixas, h.total_kg, h.preco_caixa, h.preco_kg,
           h.aliquota_icms, h.aliquota_icms_reduzida, h.aliquota_pis_cofins, h.tipo,
           count(*) OVER ()::int AS total_geral
      FROM historico_compras h
      LEFT JOIN produtos p ON p.id = h.produto_id
      LEFT JOIN fornecedores f ON f.id = h.fornecedor_id
      ${onde}
     ORDER BY h.data_entrada DESC, h.id DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
  [...valores, filtro.limite, (filtro.pagina - 1) * filtro.limite]);
  const total = rows[0]?.total_geral ?? 0;
  return {
    itens: rows.map(({ total_geral: _t, ...r }) => r),
    meta: metaPaginacao(total, { pagina: filtro.pagina, limite: filtro.limite, ordem: 'desc' }),
  };
}

/** Numeros do topo da aba: o tamanho do historico e ate quando ele vai. */
export async function resumo() {
  const { rows } = await query(`
    SELECT count(*)::int AS itens, count(DISTINCT pedido)::int AS pedidos,
           count(DISTINCT produto_codigo)::int AS produtos,
           count(DISTINCT fornecedor_codigo_erp)::int AS fornecedores,
           min(data_entrada)::text AS primeira_data, max(data_entrada)::text AS ultima_data,
           count(*) FILTER (WHERE fornecedor_id IS NULL)::int AS sem_fornecedor,
           count(*) FILTER (WHERE produto_id IS NULL)::int AS sem_produto
      FROM historico_compras`);
  return rows[0];
}
