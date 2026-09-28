import { Router } from 'express';
import { criado, ok, rota } from '../../core/http.js';
import { validar } from '../../core/validate.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import * as servico from './fornecedores.service.js';
import {
  atualizarFornecedorSchema, criarFornecedorSchema, idSchema,
  listarFornecedoresSchema, vinculoProdutoSchema,
} from './fornecedores.schemas.js';

export const fornecedoresRouter = Router();
fornecedoresRouter.use(autenticar);

fornecedoresRouter.get('/', exigirPermissao('fornecedores.ler'), rota(async (req, res) => {
  const filtro = validar(req, 'query', listarFornecedoresSchema);
  const { itens, meta } = await servico.listar(filtro);
  return ok(res, itens, 'Fornecedores listados', meta);
}));

fornecedoresRouter.get('/:id', exigirPermissao('fornecedores.ler'), rota(async (req, res) => {
  const { id } = validar(req, 'params', idSchema);
  return ok(res, await servico.obter(id), 'Fornecedor encontrado');
}));

fornecedoresRouter.get('/:id/performance', exigirPermissao('fornecedores.ler'), rota(async (req, res) => {
  const { id } = validar(req, 'params', idSchema);
  return ok(res, await servico.performance(id), 'Performance do fornecedor');
}));

fornecedoresRouter.post('/', exigirPermissao('fornecedores.criar'), rota(async (req, res) => {
  const dados = validar(req, 'body', criarFornecedorSchema);
  const fornecedor = await servico.criar(dados, { usuarioId: req.usuario!.id, ip: req.ipCliente });
  return criado(res, fornecedor, 'Fornecedor cadastrado com sucesso');
}));

fornecedoresRouter.put('/:id', exigirPermissao('fornecedores.editar'), rota(async (req, res) => {
  const { id } = validar(req, 'params', idSchema);
  const dados = validar(req, 'body', atualizarFornecedorSchema);
  const fornecedor = await servico.atualizar(id, dados, { usuarioId: req.usuario!.id, ip: req.ipCliente });
  return ok(res, fornecedor, 'Fornecedor atualizado com sucesso');
}));

fornecedoresRouter.post('/:id/produtos', exigirPermissao('fornecedores.editar'), rota(async (req, res) => {
  const { id } = validar(req, 'params', idSchema);
  const dados = validar(req, 'body', vinculoProdutoSchema);
  const vinculo = await servico.vincularProduto(id, dados, { usuarioId: req.usuario!.id, ip: req.ipCliente });
  return criado(res, vinculo, 'Produto vinculado ao fornecedor');
}));

fornecedoresRouter.delete('/:id', exigirPermissao('fornecedores.excluir'), rota(async (req, res) => {
  const { id } = validar(req, 'params', idSchema);
  return ok(res, await servico.remover(id, { usuarioId: req.usuario!.id, ip: req.ipCliente }), 'Fornecedor inativado');
}));
