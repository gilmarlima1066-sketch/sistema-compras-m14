/**
 * Orcamento para fornecedor: o comprador monta na tela e envia o PDF pelo
 * WhatsApp. O servidor guarda o orcamento, sugere preco e impostos de cada
 * produto e refaz as contas (o total gravado nunca vem do navegador).
 *
 * Sugestao do item, na ordem:
 *  - preco: ultimo orcamento deste produto para ESTE fornecedor; ultima
 *    compra (historico do ERP) com ele; ultima compra de qualquer fornecedor;
 *    preco do vinculo produto x fornecedor;
 *  - impostos: os do ultimo orcamento do produto (o "ultimo imposto
 *    incluido"); sem orcamento, os da ultima compra no ERP, preferindo o
 *    mesmo fornecedor. PIS/COFINS da compra vem somado (9,25%) e e separado
 *    na proporcao 1,65 / 7,60 do regime nao cumulativo.
 */
import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { metaPaginacao } from '../../core/paginacao.js';

const arred = (v: number, casas = 2) => Math.round(v * 10 ** casas) / 10 ** casas;

export async function empresa() {
  const { rows } = await query<{ chave: string; valor: string }>(
    "SELECT chave, valor FROM configuracoes WHERE grupo = 'empresa' AND ativo");
  return Object.fromEntries(rows.map((r) => [r.chave.replace('empresa.', ''), r.valor]));
}

interface SugestaoProduto {
  produto_id: number; codigo: string; descricao: string; unidade: string | null; ativo: boolean;
  preco_unitario: number | null; origem_preco: string | null; data_preco: string | null;
  icms_pct: number; pis_pct: number; cofins_pct: number; ipi_pct: number; st_valor: number;
  origem_impostos: string | null;
}

/** Produtos pelo codigo (com ou sem zeros a esquerda) ou pela descricao, ja com preco e impostos sugeridos. */
export async function buscarProdutos(termo: string, fornecedorId?: number) {
  const { rows } = await query<Record<string, unknown>>(`
    WITH achados AS (
      SELECT p.id, p.codigo, p.descricao, p.ativo, u.codigo AS unidade
        FROM produtos p
        LEFT JOIN unidades u ON u.id = p.unidade_estoque_id
       WHERE p.deleted_at IS NULL
         AND (upper(p.codigo) = upper($1) OR ltrim(p.codigo, '0') = ltrim($1, '0')
              OR p.codigo ILIKE $2 OR p.descricao ILIKE $3)
       ORDER BY (upper(p.codigo) = upper($1) OR ltrim(p.codigo, '0') = ltrim($1, '0')) DESC,
                p.ativo DESC, p.descricao
       LIMIT 12
    )
    SELECT a.*,
           oi_f.preco_unitario AS orc_preco, oi_f.data AS orc_data,
           hc_f.preco_caixa AS compra_f_preco, hc_f.data_entrada::text AS compra_f_data,
           hc.preco_caixa AS compra_preco, hc.data_entrada::text AS compra_data,
           pf.preco_atual AS vinculo_preco,
           oi.icms_pct AS orc_icms, oi.pis_pct AS orc_pis, oi.cofins_pct AS orc_cofins,
           oi.ipi_pct AS orc_ipi, oi.st_valor AS orc_st,
           hi.aliquota_icms AS compra_icms, hi.aliquota_pis_cofins AS compra_pis_cofins
      FROM achados a
      LEFT JOIN LATERAL (
        SELECT i.preco_unitario, o.data_emissao::text AS data
          FROM orcamento_fornecedor_itens i JOIN orcamentos_fornecedor o ON o.id = i.orcamento_id
         WHERE i.produto_id = a.id AND o.fornecedor_id = $4
         ORDER BY i.id DESC LIMIT 1) oi_f ON $4::bigint IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT h.preco_caixa, h.data_entrada FROM historico_compras h
         WHERE h.produto_id = a.id AND h.fornecedor_id = $4 AND h.preco_caixa > 0
         ORDER BY h.data_entrada DESC, h.id DESC LIMIT 1) hc_f ON $4::bigint IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT h.preco_caixa, h.data_entrada FROM historico_compras h
         WHERE h.produto_id = a.id AND h.preco_caixa > 0
         ORDER BY h.data_entrada DESC, h.id DESC LIMIT 1) hc ON true
      LEFT JOIN LATERAL (
        SELECT pf.preco_atual FROM produto_fornecedor pf
         WHERE pf.produto_id = a.id AND pf.ativo AND pf.preco_atual > 0
         ORDER BY (pf.fornecedor_id = $4) DESC NULLS LAST, pf.fornecedor_principal DESC LIMIT 1) pf ON true
      LEFT JOIN LATERAL (
        SELECT i.icms_pct, i.pis_pct, i.cofins_pct, i.ipi_pct, i.st_valor
          FROM orcamento_fornecedor_itens i
         WHERE i.produto_id = a.id ORDER BY i.id DESC LIMIT 1) oi ON true
      LEFT JOIN LATERAL (
        SELECT h.aliquota_icms, h.aliquota_pis_cofins FROM historico_compras h
         WHERE h.produto_id = a.id
         ORDER BY (h.fornecedor_id = $4) DESC NULLS LAST, h.data_entrada DESC, h.id DESC LIMIT 1) hi ON true`,
  [termo.trim(), `${termo.trim()}%`, `%${termo.trim()}%`, fornecedorId ?? null]);

  return rows.map((r): SugestaoProduto => {
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const [preco, origem, dataPreco] =
      n(r.orc_preco) !== null ? [n(r.orc_preco), 'ultimo orcamento para este fornecedor', r.orc_data]
        : n(r.compra_f_preco) !== null ? [n(r.compra_f_preco), 'ultima compra deste fornecedor', r.compra_f_data]
          : n(r.compra_preco) !== null ? [n(r.compra_preco), 'ultima compra (outro fornecedor)', r.compra_data]
            : n(r.vinculo_preco) !== null ? [n(r.vinculo_preco), 'preco do cadastro produto x fornecedor', null]
              : [null, null, null];

    let impostos = { icms_pct: 0, pis_pct: 0, cofins_pct: 0, ipi_pct: 0, st_valor: 0 };
    let origemImpostos: string | null = null;
    if (r.orc_icms !== null && r.orc_icms !== undefined) {
      impostos = {
        icms_pct: Number(r.orc_icms), pis_pct: Number(r.orc_pis), cofins_pct: Number(r.orc_cofins),
        ipi_pct: Number(r.orc_ipi), st_valor: Number(r.orc_st),
      };
      origemImpostos = 'ultimo orcamento do produto';
    } else if (r.compra_icms !== null && r.compra_icms !== undefined) {
      // Historico guarda fracao (0,12); a tela trabalha em percentual (12).
      const pisCofins = Number(r.compra_pis_cofins ?? 0) * 100;
      impostos = {
        icms_pct: arred(Number(r.compra_icms) * 100, 4),
        pis_pct: arred(pisCofins * (1.65 / 9.25), 4),
        cofins_pct: arred(pisCofins * (7.6 / 9.25), 4),
        ipi_pct: 0, st_valor: 0,
      };
      origemImpostos = 'ultima compra no ERP';
    }

    return {
      produto_id: Number(r.id), codigo: String(r.codigo), descricao: String(r.descricao),
      unidade: (r.unidade as string | null) ?? null, ativo: Boolean(r.ativo),
      preco_unitario: preco as number | null, origem_preco: origem as string | null,
      data_preco: (dataPreco as string | null) ?? null,
      ...impostos, origem_impostos: origemImpostos,
    };
  });
}

export interface ItemOrcamento {
  produto_id?: number | null | undefined;
  produto_codigo: string; descricao: string; unidade?: string | null | undefined;
  quantidade: number; preco_unitario: number; desconto: number; st_valor: number;
  ipi_pct: number; icms_pct: number; pis_pct: number; cofins_pct: number;
}

export interface EntradaOrcamento {
  fornecedor_id?: number | null | undefined;
  fornecedor: Record<string, unknown>;
  data_emissao?: string | undefined;
  tipo_operacao: string;
  condicao_pagamento?: string | null | undefined;
  data_entrega?: string | null | undefined;
  transportadora?: string | null | undefined;
  observacoes?: string | null | undefined;
  desconto: number;
  frete: number;
  comprador?: string | null | undefined;
  itens: ItemOrcamento[];
}

/** As mesmas contas da tela, refeitas aqui: o que fica gravado e o que o servidor calculou. */
export function calcularTotais(e: Pick<EntradaOrcamento, 'itens' | 'desconto' | 'frete'>) {
  let mercadorias = 0; let ipi = 0; let st = 0; let icms = 0; let pis = 0; let cofins = 0;
  for (const i of e.itens) {
    const base = Math.max(0, i.quantidade * i.preco_unitario - i.desconto);
    mercadorias += base;
    ipi += base * i.ipi_pct / 100;
    icms += base * i.icms_pct / 100;
    pis += base * i.pis_pct / 100;
    cofins += base * i.cofins_pct / 100;
    st += i.st_valor;
  }
  // Como no pedido do ERP: ICMS, PIS e COFINS estao dentro do preco
  // (informativos); IPI e ICMS-ST somam ao total.
  const total = mercadorias - e.desconto + e.frete + ipi + st;
  return {
    total_mercadorias: arred(mercadorias), total_ipi: arred(ipi), total_st: arred(st),
    total_icms: arred(icms), total_pis: arred(pis), total_cofins: arred(cofins),
    total_pedido: arred(total),
  };
}

export async function salvar(id: number | null, e: EntradaOrcamento, contexto: ContextoSessao) {
  if (!e.itens.length) throw regraNegocio('Inclua ao menos um produto no orcamento');
  const t = calcularTotais(e);
  return comTransacao(contexto, async (cliente) => {
    const campos = [
      e.fornecedor_id ?? null, JSON.stringify(e.fornecedor), e.data_emissao ?? null, e.tipo_operacao,
      e.condicao_pagamento ?? null, e.data_entrega ?? null, e.transportadora ?? null, e.observacoes ?? null,
      e.desconto, e.frete, t.total_mercadorias, t.total_ipi, t.total_st, t.total_icms, t.total_pis,
      t.total_cofins, t.total_pedido, e.comprador ?? null, contexto.usuarioId ?? null,
    ];
    let orcamentoId: number;
    if (id === null) {
      const { rows } = await cliente.query<{ id: string }>(`
        INSERT INTO orcamentos_fornecedor
          (fornecedor_id, fornecedor, data_emissao, tipo_operacao, condicao_pagamento, data_entrega,
           transportadora, observacoes, desconto, frete, total_mercadorias, total_ipi, total_st,
           total_icms, total_pis, total_cofins, total_pedido, comprador, created_by, updated_by)
        VALUES ($1, $2::jsonb, coalesce($3::date, CURRENT_DATE), $4, $5, $6, $7, $8, $9, $10, $11, $12,
                $13, $14, $15, $16, $17, $18, $19, $19)
        RETURNING id`, campos);
      orcamentoId = Number(rows[0]!.id);
    } else {
      const { rowCount } = await cliente.query(`
        UPDATE orcamentos_fornecedor
           SET fornecedor_id = $1, fornecedor = $2::jsonb, data_emissao = coalesce($3::date, data_emissao),
               tipo_operacao = $4, condicao_pagamento = $5, data_entrega = $6, transportadora = $7,
               observacoes = $8, desconto = $9, frete = $10, total_mercadorias = $11, total_ipi = $12,
               total_st = $13, total_icms = $14, total_pis = $15, total_cofins = $16, total_pedido = $17,
               comprador = $18, updated_by = $19, updated_at = now()
         WHERE id = $20`, [...campos, id]);
      if (!rowCount) throw naoEncontrado('Orcamento');
      orcamentoId = id;
      await cliente.query('DELETE FROM orcamento_fornecedor_itens WHERE orcamento_id = $1', [id]);
    }

    await cliente.query(`
      INSERT INTO orcamento_fornecedor_itens
        (orcamento_id, ordem, produto_id, produto_codigo, descricao, unidade, quantidade, preco_unitario,
         desconto, st_valor, ipi_pct, icms_pct, pis_pct, cofins_pct)
      SELECT $1, x.ordem, x.produto_id, x.produto_codigo, x.descricao, x.unidade, x.quantidade,
             x.preco_unitario, x.desconto, x.st_valor, x.ipi_pct, x.icms_pct, x.pis_pct, x.cofins_pct
        FROM jsonb_to_recordset($2::jsonb) AS x(
          ordem smallint, produto_id bigint, produto_codigo text, descricao text, unidade text,
          quantidade numeric, preco_unitario numeric, desconto numeric, st_valor numeric,
          ipi_pct numeric, icms_pct numeric, pis_pct numeric, cofins_pct numeric)`,
    [orcamentoId, JSON.stringify(e.itens.map((i, ordem) => ({ ...i, ordem: ordem + 1, produto_id: i.produto_id ?? null })))]);

    return obterCom(cliente.query.bind(cliente), orcamentoId);
  });
}

type Consulta = (sql: string, valores?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

async function obterCom(consulta: Consulta, id: number) {
  const { rows } = await consulta(`
    SELECT o.*, o.data_emissao::text AS data_emissao, o.data_entrega::text AS data_entrega
      FROM orcamentos_fornecedor o WHERE o.id = $1`, [id]);
  if (!rows[0]) throw naoEncontrado('Orcamento');
  const { rows: itens } = await consulta(`
    SELECT produto_id, produto_codigo, descricao, unidade, quantidade, preco_unitario, desconto,
           st_valor, ipi_pct, icms_pct, pis_pct, cofins_pct
      FROM orcamento_fornecedor_itens WHERE orcamento_id = $1 ORDER BY ordem`, [id]);
  return { ...rows[0], itens };
}

export const obter = (id: number) => obterCom(query as Consulta, id);

export async function listar(filtro: { busca?: string | undefined; pagina: number; limite: number }) {
  const valores: unknown[] = [];
  let onde = '';
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`, filtro.busca.replace(/\D/g, '') || '0');
    onde = `WHERE o.fornecedor->>'nome' ILIKE $1 OR o.fornecedor->>'razao_social' ILIKE $1
              OR o.id::text = $2`;
  }
  const { rows } = await query<Record<string, unknown> & { total_geral: number }>(`
    SELECT o.id, o.status, o.data_emissao::text AS data_emissao, o.tipo_operacao,
           coalesce(o.fornecedor->>'nome', o.fornecedor->>'razao_social') AS fornecedor_nome,
           o.fornecedor->>'codigo_erp' AS fornecedor_codigo, o.total_pedido, o.enviado_em,
           (SELECT count(*)::int FROM orcamento_fornecedor_itens i WHERE i.orcamento_id = o.id) AS itens,
           count(*) OVER ()::int AS total_geral
      FROM orcamentos_fornecedor o ${onde}
     ORDER BY o.id DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
  [...valores, filtro.limite, (filtro.pagina - 1) * filtro.limite]);
  return {
    itens: rows.map(({ total_geral: _t, ...r }) => r),
    meta: metaPaginacao(rows[0]?.total_geral ?? 0, { pagina: filtro.pagina, limite: filtro.limite, ordem: 'desc' }),
  };
}

/** Marca como enviado quando o PDF sai para o fornecedor. */
export async function marcarEnviado(id: number, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      `UPDATE orcamentos_fornecedor SET status = 'ENVIADO', enviado_em = now(), updated_at = now()
        WHERE id = $1 RETURNING id, status, enviado_em`, [id]);
    if (!rows[0]) throw naoEncontrado('Orcamento');
    return rows[0];
  });
}

export async function excluir(id: number, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    const { rowCount } = await cliente.query('DELETE FROM orcamentos_fornecedor WHERE id = $1', [id]);
    if (!rowCount) throw naoEncontrado('Orcamento');
    return { id };
  });
}
