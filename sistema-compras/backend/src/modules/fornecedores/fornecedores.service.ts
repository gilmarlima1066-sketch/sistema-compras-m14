import { query, comTransacao, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { deslocamento, metaPaginacao, ordenacaoSegura } from '../../core/paginacao.js';
import type { FiltroFornecedores, NovoFornecedor, VinculoProduto } from './fornecedores.schemas.js';

const COLUNAS_ORDENAVEIS = ['razao_social', 'nome_fantasia', 'cidade', 'created_at'];

const CAMPOS_GRAVAVEIS = [
  'razao_social', 'nome_fantasia', 'cnpj', 'inscricao_estadual', 'email', 'telefone', 'celular',
  'endereco', 'numero', 'complemento', 'bairro', 'cidade', 'estado', 'cep', 'pais',
  'tipo_fornecedor', 'origem_fornecedor', 'prazo_medio_pagamento', 'lead_time_padrao_dias',
  'observacoes', 'ativo',
] as const;

export async function listar(filtro: FiltroFornecedores) {
  const condicoes = ['deleted_at IS NULL'];
  const valores: unknown[] = [];

  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    condicoes.push(
      `(razao_social ILIKE $${valores.length} OR nome_fantasia ILIKE $${valores.length} OR cnpj ILIKE $${valores.length})`,
    );
  }
  if (filtro.origem) {
    valores.push(filtro.origem);
    condicoes.push(`origem_fornecedor = $${valores.length}`);
  }
  if (filtro.tipo) {
    valores.push(filtro.tipo);
    condicoes.push(`tipo_fornecedor = $${valores.length}`);
  }
  if (filtro.ativo) {
    valores.push(filtro.ativo === 'true');
    condicoes.push(`ativo = $${valores.length}`);
  }

  const onde = `WHERE ${condicoes.join(' AND ')}`;
  const total = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM fornecedores ${onde}`, valores,
  );
  const dados = await query(
    `SELECT f.*,
            (SELECT count(*)::int FROM produto_fornecedor pf WHERE pf.fornecedor_id = f.id) AS total_produtos
       FROM fornecedores f ${onde}
      ORDER BY ${ordenacaoSegura(filtro, COLUNAS_ORDENAVEIS, 'razao_social')}
      LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)],
  );

  return { itens: dados.rows, meta: metaPaginacao(total.rows[0]?.total ?? 0, filtro) };
}

export async function obter(id: number) {
  const { rows } = await query('SELECT * FROM fornecedores WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!rows[0]) throw naoEncontrado('Fornecedor');

  const produtos = await query(
    `SELECT pf.*, p.codigo AS produto_codigo, p.descricao AS produto
       FROM produto_fornecedor pf
       JOIN produtos p ON p.id = pf.produto_id
      WHERE pf.fornecedor_id = $1 AND p.deleted_at IS NULL
      ORDER BY p.descricao`,
    [id],
  );
  const performance = await query('SELECT * FROM vw_performance_fornecedores WHERE fornecedor_id = $1', [id]);

  return { ...rows[0], produtos: produtos.rows, performance: performance.rows[0] ?? null };
}

export async function performance(id: number) {
  const { rows } = await query('SELECT * FROM vw_performance_fornecedores WHERE fornecedor_id = $1', [id]);
  if (!rows[0]) throw naoEncontrado('Fornecedor');
  return rows[0];
}

export async function criar(dados: NovoFornecedor, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    const campos = CAMPOS_GRAVAVEIS.filter((c) => (dados as Record<string, unknown>)[c] !== undefined);
    const { rows } = await cliente.query(
      `INSERT INTO fornecedores (${campos.join(', ')})
       VALUES (${campos.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      campos.map((c) => (dados as Record<string, unknown>)[c]),
    );
    return rows[0];
  });
}

export async function atualizar(id: number, dados: Partial<NovoFornecedor>, contexto: ContextoSessao) {
  const campos = CAMPOS_GRAVAVEIS.filter((c) => (dados as Record<string, unknown>)[c] !== undefined);
  if (campos.length === 0) throw regraNegocio('Nenhum campo informado para atualizacao');

  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      `UPDATE fornecedores SET ${campos.map((c, i) => `${c} = $${i + 2}`).join(', ')}
        WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, ...campos.map((c) => (dados as Record<string, unknown>)[c])],
    );
    if (!rows[0]) throw naoEncontrado('Fornecedor');
    return rows[0];
  });
}

export async function remover(id: number, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    const abertas = await cliente.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM ordens_compra
        WHERE fornecedor_id = $1
          AND status IN ('AGUARDANDO_APROVACAO','APROVADA','ENVIADA','CONFIRMADA',
                         'EM_PRODUCAO','EM_TRANSITO','RECEBIMENTO_PARCIAL')`,
      [id],
    );
    if ((abertas.rows[0]?.total ?? 0) > 0) {
      throw regraNegocio('Fornecedor possui ordens de compra em aberto e nao pode ser inativado');
    }
    const { rows } = await cliente.query(
      'UPDATE fornecedores SET deleted_at = now(), ativo = FALSE WHERE id = $1 AND deleted_at IS NULL RETURNING id',
      [id],
    );
    if (!rows[0]) throw naoEncontrado('Fornecedor');
    return { id };
  });
}

/** Vincula (ou atualiza) um produto ao fornecedor com as condicoes comerciais. */
export async function vincularProduto(fornecedorId: number, dados: VinculoProduto, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    if (dados.fornecedor_principal) {
      await cliente.query(
        'UPDATE produto_fornecedor SET fornecedor_principal = FALSE WHERE produto_id = $1 AND fornecedor_id <> $2',
        [dados.produto_id, fornecedorId],
      );
    }
    const { rows } = await cliente.query(
      `INSERT INTO produto_fornecedor (
         produto_id, fornecedor_id, codigo_produto_fornecedor, preco_atual, moeda, moq,
         multiplo_compra, lead_time_dias, prazo_pagamento_dias, frete_estimado,
         fornecedor_principal, ativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (produto_id, fornecedor_id) DO UPDATE SET
         codigo_produto_fornecedor = EXCLUDED.codigo_produto_fornecedor,
         preco_atual = EXCLUDED.preco_atual,
         moeda = EXCLUDED.moeda,
         moq = EXCLUDED.moq,
         multiplo_compra = EXCLUDED.multiplo_compra,
         lead_time_dias = EXCLUDED.lead_time_dias,
         prazo_pagamento_dias = EXCLUDED.prazo_pagamento_dias,
         frete_estimado = EXCLUDED.frete_estimado,
         fornecedor_principal = EXCLUDED.fornecedor_principal,
         ativo = EXCLUDED.ativo
       RETURNING *`,
      [
        dados.produto_id, fornecedorId, dados.codigo_produto_fornecedor ?? null, dados.preco_atual ?? null,
        dados.moeda, dados.moq ?? null, dados.multiplo_compra ?? null, dados.lead_time_dias ?? null,
        dados.prazo_pagamento_dias ?? null, dados.frete_estimado ?? null,
        dados.fornecedor_principal, dados.ativo,
      ],
    );
    return rows[0];
  });
}
