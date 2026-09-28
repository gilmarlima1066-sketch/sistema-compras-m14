import { query, comTransacao, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { deslocamento, metaPaginacao, ordenacaoSegura } from '../../core/paginacao.js';
import type { EdicaoProduto, FiltroProdutos, NovoProduto } from './produtos.schemas.js';

const COLUNAS_ORDENAVEIS = ['codigo', 'descricao', 'created_at', 'estoque_minimo', 'classificacao_abc'];

const SELECT_PRODUTO = `
  SELECT p.*,
         c.nome  AS categoria_nome,
         sc.nome AS subcategoria_nome,
         m.nome  AS marca_nome,
         ue.codigo AS unidade_estoque_codigo
    FROM produtos p
    JOIN categorias c      ON c.id = p.categoria_id
    LEFT JOIN subcategorias sc ON sc.id = p.subcategoria_id
    LEFT JOIN marcas m     ON m.id = p.marca_id
    JOIN unidades ue       ON ue.id = p.unidade_estoque_id`;

export async function listar(filtro: FiltroProdutos) {
  const condicoes: string[] = ['p.deleted_at IS NULL'];
  const valores: unknown[] = [];

  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    condicoes.push(`(p.descricao ILIKE $${valores.length} OR p.codigo ILIKE $${valores.length} OR p.ean ILIKE $${valores.length})`);
  }
  if (filtro.categoria_id) {
    valores.push(filtro.categoria_id);
    condicoes.push(`p.categoria_id = $${valores.length}`);
  }
  if (filtro.subcategoria_id) {
    valores.push(filtro.subcategoria_id);
    condicoes.push(`p.subcategoria_id = $${valores.length}`);
  }
  if (filtro.ativo) {
    valores.push(filtro.ativo === 'true');
    condicoes.push(`p.ativo = $${valores.length}`);
  }
  if (filtro.classificacao_abc) {
    valores.push(filtro.classificacao_abc);
    condicoes.push(`p.classificacao_abc = $${valores.length}`);
  }

  const onde = `WHERE ${condicoes.join(' AND ')}`;
  const ordem = ordenacaoSegura(filtro, COLUNAS_ORDENAVEIS, 'descricao');

  const totalResultado = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM produtos p ${onde}`,
    valores,
  );

  const dados = await query(
    `${SELECT_PRODUTO} ${onde} ORDER BY p.${ordem} LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)],
  );

  return { itens: dados.rows, meta: metaPaginacao(totalResultado.rows[0]?.total ?? 0, filtro) };
}

export async function obter(id: number) {
  const { rows } = await query(`${SELECT_PRODUTO} WHERE p.id = $1 AND p.deleted_at IS NULL`, [id]);
  if (!rows[0]) throw naoEncontrado('Produto');

  const fornecedores = await query(
    `SELECT pf.*, COALESCE(f.nome_fantasia, f.razao_social) AS fornecedor
       FROM produto_fornecedor pf
       JOIN fornecedores f ON f.id = pf.fornecedor_id
      WHERE pf.produto_id = $1
      ORDER BY pf.fornecedor_principal DESC, fornecedor`,
    [id],
  );

  const estoque = await query(
    `SELECT * FROM vw_estoque_atual WHERE produto_id = $1`,
    [id],
  );

  return { ...rows[0], fornecedores: fornecedores.rows, estoque: estoque.rows[0] ?? null };
}

const CAMPOS_GRAVAVEIS = [
  'codigo', 'ean', 'descricao', 'descricao_completa', 'categoria_id', 'subcategoria_id',
  'marca_id', 'unidade_compra_id', 'unidade_estoque_id', 'unidade_venda_id', 'fator_conversao',
  'peso', 'dias_validade', 'origem', 'produto_importado', 'ativo', 'estoque_minimo',
  'estoque_maximo', 'estoque_seguranca', 'ponto_pedido', 'lead_time_padrao_dias', 'moq',
  'multiplo_compra', 'classificacao_abc', 'classificacao_xyz',
] as const;

export async function criar(dados: NovoProduto, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    const campos = CAMPOS_GRAVAVEIS.filter((c) => dados[c] !== undefined);
    const valores = campos.map((c) => dados[c]);
    const placeholders = campos.map((_, i) => `$${i + 1}`);

    const { rows } = await cliente.query(
      `INSERT INTO produtos (${campos.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      valores,
    );
    return rows[0];
  });
}

export async function atualizar(id: number, dados: EdicaoProduto, contexto: ContextoSessao) {
  const campos = CAMPOS_GRAVAVEIS.filter((c) => dados[c] !== undefined);
  if (campos.length === 0) throw regraNegocio('Nenhum campo informado para atualizacao');

  return comTransacao(contexto, async (cliente) => {
    const atribuicoes = campos.map((c, i) => `${c} = $${i + 2}`);
    const { rows } = await cliente.query(
      `UPDATE produtos SET ${atribuicoes.join(', ')}
        WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, ...campos.map((c) => dados[c])],
    );
    if (!rows[0]) throw naoEncontrado('Produto');
    return rows[0];
  });
}

/** Soft delete: o historico do produto continua consultavel. */
export async function remover(id: number, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    const saldo = await cliente.query<{ saldo: number }>(
      'SELECT COALESCE(SUM(quantidade_fisica), 0)::numeric AS saldo FROM estoques WHERE produto_id = $1',
      [id],
    );
    if (Number(saldo.rows[0]?.saldo ?? 0) > 0) {
      throw regraNegocio('Produto possui saldo em estoque e nao pode ser inativado');
    }

    const { rows } = await cliente.query(
      `UPDATE produtos SET deleted_at = now(), ativo = FALSE
        WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [id],
    );
    if (!rows[0]) throw naoEncontrado('Produto');
    return { id };
  });
}
