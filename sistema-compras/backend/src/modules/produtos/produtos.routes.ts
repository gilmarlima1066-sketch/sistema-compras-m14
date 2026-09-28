import { Router } from 'express';
import { ok, criado, rota } from '../../core/http.js';
import { validar } from '../../core/validate.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import * as servico from './produtos.service.js';
import {
  atualizarProdutoSchema, criarProdutoSchema, idSchema, listarProdutosSchema,
} from './produtos.schemas.js';

export const produtosRouter = Router();
produtosRouter.use(autenticar);

produtosRouter.get(
  '/',
  exigirPermissao('produtos.ler'),
  rota(async (req, res) => {
    const filtro = validar(req, 'query', listarProdutosSchema);
    const { itens, meta } = await servico.listar(filtro);
    return ok(res, itens, 'Produtos listados', meta);
  }),
);

produtosRouter.get(
  '/:id',
  exigirPermissao('produtos.ler'),
  rota(async (req, res) => {
    const { id } = validar(req, 'params', idSchema);
    return ok(res, await servico.obter(id), 'Produto encontrado');
  }),
);

produtosRouter.post(
  '/',
  exigirPermissao('produtos.criar'),
  rota(async (req, res) => {
    const dados = validar(req, 'body', criarProdutoSchema);
    const produto = await servico.criar(dados, { usuarioId: req.usuario!.id, ip: req.ipCliente });
    return criado(res, produto, 'Produto cadastrado com sucesso');
  }),
);

produtosRouter.put(
  '/:id',
  exigirPermissao('produtos.editar'),
  rota(async (req, res) => {
    const { id } = validar(req, 'params', idSchema);
    const dados = validar(req, 'body', atualizarProdutoSchema);
    const produto = await servico.atualizar(id, dados, { usuarioId: req.usuario!.id, ip: req.ipCliente });
    return ok(res, produto, 'Produto atualizado com sucesso');
  }),
);

produtosRouter.delete(
  '/:id',
  exigirPermissao('produtos.excluir'),
  rota(async (req, res) => {
    const { id } = validar(req, 'params', idSchema);
    const resultado = await servico.remover(id, { usuarioId: req.usuario!.id, ip: req.ipCliente });
    return ok(res, resultado, 'Produto inativado com sucesso');
  }),
);
