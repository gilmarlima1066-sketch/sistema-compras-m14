import { Router } from 'express';
import { z } from 'zod';
import { criado, ok, rota } from '../../core/http.js';
import { validar } from '../../core/validate.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import { comTransacao, query } from '../../config/database.js';

/**
 * Cadastros de apoio (categorias, subcategorias, marcas, unidades, locais,
 * condicoes de pagamento). Mesma forma para todos: listar e criar.
 */
export const cadastrosRouter = Router();
cadastrosRouter.use(autenticar);

const nomeDescricaoSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  descricao: z.string().trim().max(500).nullish(),
  ativo: z.coerce.boolean().default(true),
});

function recursoSimples(caminho: string, tabela: string, permissaoLer: string, permissaoEscrever: string) {
  cadastrosRouter.get(`/${caminho}`, exigirPermissao(permissaoLer), rota(async (_req, res) => {
    const { rows } = await query(`SELECT * FROM ${tabela} ORDER BY nome`);
    return ok(res, rows, `${caminho} listados`);
  }));

  cadastrosRouter.post(`/${caminho}`, exigirPermissao(permissaoEscrever), rota(async (req, res) => {
    const dados = validar(req, 'body', nomeDescricaoSchema);
    const registro = await comTransacao({ usuarioId: req.usuario!.id, ip: req.ipCliente }, async (cliente) => {
      const { rows } = await cliente.query(
        `INSERT INTO ${tabela} (nome, descricao, ativo) VALUES ($1,$2,$3) RETURNING *`,
        [dados.nome, dados.descricao ?? null, dados.ativo],
      );
      return rows[0];
    });
    return criado(res, registro, 'Registro criado com sucesso');
  }));
}

recursoSimples('categorias', 'categorias', 'produtos.ler', 'produtos.criar');
recursoSimples('marcas', 'marcas', 'produtos.ler', 'produtos.criar');

cadastrosRouter.get('/subcategorias', exigirPermissao('produtos.ler'), rota(async (req, res) => {
  const { categoria_id } = validar(req, 'query', z.object({
    categoria_id: z.coerce.number().int().positive().optional(),
  }));
  const { rows } = await query(
    `SELECT s.*, c.nome AS categoria FROM subcategorias s JOIN categorias c ON c.id = s.categoria_id
      ${categoria_id ? 'WHERE s.categoria_id = $1' : ''} ORDER BY c.nome, s.nome`,
    categoria_id ? [categoria_id] : [],
  );
  return ok(res, rows, 'Subcategorias listadas');
}));

cadastrosRouter.post('/subcategorias', exigirPermissao('produtos.criar'), rota(async (req, res) => {
  const dados = validar(req, 'body', nomeDescricaoSchema.extend({
    categoria_id: z.coerce.number().int().positive(),
  }));
  const registro = await comTransacao({ usuarioId: req.usuario!.id, ip: req.ipCliente }, async (cliente) => {
    const { rows } = await cliente.query(
      'INSERT INTO subcategorias (categoria_id, nome, descricao, ativo) VALUES ($1,$2,$3,$4) RETURNING *',
      [dados.categoria_id, dados.nome, dados.descricao ?? null, dados.ativo],
    );
    return rows[0];
  });
  return criado(res, registro, 'Subcategoria criada com sucesso');
}));

cadastrosRouter.get('/unidades', exigirPermissao('produtos.ler'), rota(async (_req, res) => {
  const { rows } = await query('SELECT * FROM unidades WHERE ativo ORDER BY nome');
  return ok(res, rows, 'Unidades listadas');
}));

cadastrosRouter.get('/locais', exigirPermissao('estoque.ler'), rota(async (_req, res) => {
  const { rows } = await query('SELECT * FROM locais ORDER BY nome');
  return ok(res, rows, 'Locais listados');
}));

cadastrosRouter.get('/condicoes-pagamento', exigirPermissao('compras.ler'), rota(async (_req, res) => {
  const { rows } = await query('SELECT * FROM condicoes_pagamento WHERE ativo ORDER BY dias');
  return ok(res, rows, 'Condicoes de pagamento listadas');
}));
