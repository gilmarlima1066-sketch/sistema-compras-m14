import { Router } from 'express';
import { z } from 'zod';
import { criado, ok, rota } from '../../core/http.js';
import { validar } from '../../core/validate.js';
import { paginacaoSchema, deslocamento, metaPaginacao } from '../../core/paginacao.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import { query } from '../../config/database.js';
import * as servico from './estoque.service.js';

const listarSchema = paginacaoSchema.extend({
  situacao: z.enum(['RUPTURA', 'ABAIXO_SEGURANCA', 'ABAIXO_MINIMO', 'PONTO_PEDIDO', 'EXCESSO', 'NORMAL']).optional(),
});

const movimentacaoSchema = z.object({
  produto_id: z.coerce.number().int().positive(),
  local_id: z.coerce.number().int().positive(),
  lote_id: z.coerce.number().int().positive().nullish(),
  tipo_movimentacao: z.enum([
    'ENTRADA_COMPRA', 'SAIDA_VENDA', 'AJUSTE_POSITIVO', 'AJUSTE_NEGATIVO', 'DEVOLUCAO',
    'TRANSFERENCIA_ENTRADA', 'TRANSFERENCIA_SAIDA', 'PERDA', 'AVARIA', 'INVENTARIO',
    'PRODUCAO', 'CONSUMO_PRODUCAO',
  ]),
  quantidade: z.coerce.number().refine((v) => v !== 0, 'Quantidade nao pode ser zero'),
  custo_unitario: z.coerce.number().nonnegative().nullish(),
  documento_tipo: z.enum([
    'RECEBIMENTO', 'VENDA', 'INVENTARIO', 'AJUSTE_MANUAL', 'TRANSFERENCIA',
    'ORDEM_PRODUCAO', 'DEVOLUCAO', 'OUTRO',
  ]).nullish(),
  documento_id: z.coerce.number().int().positive().nullish(),
  observacao: z.string().trim().max(500).nullish(),
});

export const estoqueRouter = Router();
estoqueRouter.use(autenticar);

estoqueRouter.get('/', exigirPermissao('estoque.ler'), rota(async (req, res) => {
  const filtro = validar(req, 'query', listarSchema);
  const condicoes: string[] = [];
  const valores: unknown[] = [];

  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    condicoes.push(`(descricao ILIKE $${valores.length} OR codigo ILIKE $${valores.length})`);
  }
  if (filtro.situacao) {
    valores.push(filtro.situacao);
    condicoes.push(`situacao = $${valores.length}`);
  }
  const onde = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  const total = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM vw_produtos_criticos ${onde}`, valores,
  );
  const dados = await query(
    `SELECT * FROM vw_produtos_criticos ${onde}
      ORDER BY CASE situacao
                 WHEN 'RUPTURA' THEN 1 WHEN 'ABAIXO_SEGURANCA' THEN 2
                 WHEN 'ABAIXO_MINIMO' THEN 3 WHEN 'PONTO_PEDIDO' THEN 4
                 WHEN 'EXCESSO' THEN 5 ELSE 6 END, descricao
      LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)],
  );
  return ok(res, dados.rows, 'Posicao de estoque', metaPaginacao(total.rows[0]?.total ?? 0, filtro));
}));

estoqueRouter.get('/criticos', exigirPermissao('estoque.ler'), rota(async (_req, res) => {
  const { rows } = await query(
    `SELECT * FROM vw_produtos_criticos
      WHERE situacao <> 'NORMAL' ORDER BY estoque_disponivel ASC LIMIT 100`,
  );
  return ok(res, rows, 'Produtos em situacao critica');
}));

estoqueRouter.get('/:produto_id', exigirPermissao('estoque.ler'), rota(async (req, res) => {
  const { produto_id } = validar(req, 'params', z.object({ produto_id: z.coerce.number().int().positive() }));
  return ok(res, await servico.detalharProduto(produto_id), 'Detalhe do estoque do produto');
}));

estoqueRouter.post('/movimentacoes', exigirPermissao('estoque.movimentar'), rota(async (req, res) => {
  const dados = validar(req, 'body', movimentacaoSchema);
  const movimentacao = await servico.registrarMovimentacao(dados, {
    usuarioId: req.usuario!.id, ip: req.ipCliente,
  });
  return criado(res, movimentacao, 'Movimentacao registrada e saldo atualizado');
}));
