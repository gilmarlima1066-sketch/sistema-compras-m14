import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';

export interface EntradaMovimentacao {
  produto_id: number;
  local_id: number;
  lote_id?: number | null;
  tipo_movimentacao: string;
  quantidade: number;
  custo_unitario?: number | null;
  documento_tipo?: string | null;
  documento_id?: number | null;
  observacao?: string | null;
}

export async function detalharProduto(produtoId: number) {
  const consolidado = await query('SELECT * FROM vw_estoque_atual WHERE produto_id = $1', [produtoId]);
  if (!consolidado.rows[0]) throw naoEncontrado('Produto');

  const porLocal = await query(
    `SELECT e.*, l.codigo AS local_codigo, l.nome AS local_nome, l.tipo AS local_tipo
       FROM estoques e JOIN locais l ON l.id = e.local_id
      WHERE e.produto_id = $1 ORDER BY l.nome`,
    [produtoId],
  );

  const lotes = await query(
    `SELECT id, numero_lote, data_fabricacao, data_validade, quantidade_atual, status
       FROM lotes WHERE produto_id = $1 AND quantidade_atual > 0
      ORDER BY data_validade NULLS LAST, numero_lote`,
    [produtoId],
  );

  const movimentacoes = await query(
    `SELECT m.id, m.tipo_movimentacao, m.quantidade, m.created_at, m.observacao,
            l.nome AS local, u.nome AS usuario
       FROM movimentacoes_estoque m
       JOIN locais l ON l.id = m.local_id
       LEFT JOIN usuarios u ON u.id = m.usuario_id
      WHERE m.produto_id = $1 ORDER BY m.created_at DESC LIMIT 50`,
    [produtoId],
  );

  return {
    consolidado: consolidado.rows[0],
    por_local: porLocal.rows,
    lotes: lotes.rows,
    movimentacoes: movimentacoes.rows,
  };
}

/**
 * Toda movimentacao roda em transacao: o INSERT dispara a trigger que
 * atualiza saldo e lote. Se o saldo ficar negativo sem autorizacao,
 * a trigger levanta excecao e a transacao inteira e desfeita.
 */
export async function registrarMovimentacao(dados: EntradaMovimentacao, contexto: ContextoSessao) {
  if (dados.tipo_movimentacao !== 'INVENTARIO' && dados.quantidade <= 0) {
    throw regraNegocio('Quantidade deve ser positiva; o tipo da movimentacao define entrada ou saida');
  }

  return comTransacao(contexto, async (cliente) => {
    if (dados.lote_id) {
      const lote = await cliente.query<{ produto_id: number; status: string }>(
        'SELECT produto_id, status FROM lotes WHERE id = $1 FOR UPDATE',
        [dados.lote_id],
      );
      if (!lote.rows[0]) throw naoEncontrado('Lote');
      if (lote.rows[0].produto_id !== dados.produto_id) {
        throw regraNegocio('O lote informado pertence a outro produto');
      }
      if (['BLOQUEADO', 'VENCIDO'].includes(lote.rows[0].status) && dados.quantidade > 0) {
        throw regraNegocio(`Lote com status ${lote.rows[0].status} nao pode ser movimentado`);
      }
    }

    const { rows } = await cliente.query(
      `INSERT INTO movimentacoes_estoque (
         produto_id, local_id, lote_id, tipo_movimentacao, quantidade, custo_unitario,
         documento_tipo, documento_id, observacao, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        dados.produto_id, dados.local_id, dados.lote_id ?? null, dados.tipo_movimentacao,
        dados.quantidade, dados.custo_unitario ?? null, dados.documento_tipo ?? null,
        dados.documento_id ?? null, dados.observacao ?? null, contexto.usuarioId ?? null,
      ],
    );

    const saldo = await cliente.query(
      'SELECT quantidade_fisica, quantidade_disponivel FROM estoques WHERE produto_id = $1 AND local_id = $2',
      [dados.produto_id, dados.local_id],
    );

    return { movimentacao: rows[0], saldo: saldo.rows[0] ?? null };
  });
}
