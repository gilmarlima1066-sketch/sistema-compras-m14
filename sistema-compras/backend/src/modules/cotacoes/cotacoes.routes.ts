import { Router } from 'express';
import { z } from 'zod';
import { criado, ok, rota } from '../../core/http.js';
import { validar } from '../../core/validate.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import * as cot from './cotacoes.service.js';
import * as prop from './propostas.service.js';
import * as comp from './comparacao.service.js';
import * as cen from './cenarios.service.js';
import {
  adicionarFornecedoresSchema, cenarioSchema, comparativoSchema, criarCotacaoSchema,
  criteriosSchema, decidirCotacaoSchema, editarCotacaoSchema, enviarCotacaoSchema,
  listarCotacoesSchema, registrarPropostaSchema, selecionarPropostaSchema,
} from './cotacoes.schemas.js';

export const cotacoesRouter = Router();
cotacoesRouter.use(autenticar);

const LER = exigirPermissao('cotacoes.ler');
const CRIAR = exigirPermissao('cotacoes.criar');
const EDITAR = exigirPermissao('cotacoes.editar');
const RESPONDER = exigirPermissao('cotacoes.responder');
const ANALISAR = exigirPermissao('cotacoes.analisar');
const APROVAR = exigirPermissao('cotacoes.aprovar');
const CRITERIOS = exigirPermissao('cotacoes.criterios');

const contexto = (req: { usuario?: { id: number }; ip?: string }) => ({
  usuarioId: req.usuario?.id ?? null,
  ip: req.ip ?? null,
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

// --- Dashboard e catalogo (antes das rotas com :id) -------------------------

cotacoesRouter.get('/dashboard', LER, rota(async (_req, res) =>
  ok(res, await comp.dashboard(), 'Dashboard de cotacoes')));

cotacoesRouter.get('/criterios', LER, rota(async (_req, res) =>
  ok(res, await cot.catalogoCriterios(), 'Catalogo de criterios')));

cotacoesRouter.get('/fornecedores/:fornecedorId/historico', LER, rota(async (req, res) => {
  const { fornecedorId } = validar(req, 'params', z.object({
    fornecedorId: z.coerce.number().int().positive(),
  }));
  const { produto_id } = validar(req, 'query', z.object({
    produto_id: z.coerce.number().int().positive().optional(),
  }));
  return ok(res, await cot.historicoFornecedor(fornecedorId, produto_id), 'Historico do fornecedor');
}));

cotacoesRouter.post('/expirar-pendentes', ANALISAR, rota(async (_req, res) =>
  ok(res, await cot.expirarPendentes(), 'Convites vencidos marcados como expirados')));

// --- Cotacoes ---------------------------------------------------------------

cotacoesRouter.post('/', CRIAR, rota(async (req, res) => {
  const entrada = validar(req, 'body', criarCotacaoSchema);
  return criado(res, await cot.criarCotacao(entrada, contexto(req)), 'Cotacao criada');
}));

cotacoesRouter.get('/', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarCotacoesSchema);
  const { dados, meta } = await cot.listarCotacoes(filtro);
  return ok(res, dados, 'Cotacoes', meta);
}));

cotacoesRouter.get('/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await cot.detalharCotacao(id), 'Cotacao');
}));

cotacoesRouter.put('/:id', EDITAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', editarCotacaoSchema);
  return ok(res, await cot.editarCotacao(id, entrada, contexto(req)), 'Cotacao atualizada');
}));

cotacoesRouter.get('/:id/solicitacao', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const { fornecedor_id } = validar(req, 'query', z.object({
    fornecedor_id: z.coerce.number().int().positive().optional(),
  }));
  return ok(res, await cot.documentoSolicitacao(id, fornecedor_id), 'Solicitacao de cotacao');
}));

// --- Fornecedores convidados ------------------------------------------------

cotacoesRouter.post('/:id/fornecedores', EDITAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const { fornecedor_ids } = validar(req, 'body', adicionarFornecedoresSchema);
  return criado(res, await cot.adicionarFornecedores(id, fornecedor_ids, contexto(req)),
    'Fornecedores convidados');
}));

cotacoesRouter.delete('/:id/fornecedores/:fornecedorId', EDITAR, rota(async (req, res) => {
  const { id, fornecedorId } = validar(req, 'params', idParam.extend({
    fornecedorId: z.coerce.number().int().positive(),
  }));
  return ok(res, await cot.removerFornecedor(id, fornecedorId, contexto(req)), 'Fornecedor removido');
}));

cotacoesRouter.post('/:id/enviar', EDITAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', enviarCotacaoSchema);
  return ok(res, await cot.enviarCotacao(id, entrada, contexto(req)), 'Cotacao enviada aos fornecedores');
}));

cotacoesRouter.post('/:id/fornecedores/:fornecedorId/lembrete', EDITAR, rota(async (req, res) => {
  const { id, fornecedorId } = validar(req, 'params', idParam.extend({
    fornecedorId: z.coerce.number().int().positive(),
  }));
  return ok(res, await cot.registrarLembrete(id, fornecedorId, contexto(req)), 'Lembrete registrado');
}));

cotacoesRouter.post('/:id/fornecedores/:fornecedorId/visualizada', RESPONDER, rota(async (req, res) => {
  const { id, fornecedorId } = validar(req, 'params', idParam.extend({
    fornecedorId: z.coerce.number().int().positive(),
  }));
  return ok(res, await prop.marcarVisualizada(id, fornecedorId), 'Visualizacao registrada');
}));

// --- Propostas --------------------------------------------------------------

cotacoesRouter.post('/:id/respostas', RESPONDER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', registrarPropostaSchema);
  return criado(res, await prop.registrarProposta(id, entrada, contexto(req)), 'Proposta registrada');
}));

cotacoesRouter.get('/:id/respostas', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await prop.listarPropostas(id), 'Propostas recebidas');
}));

// --- Criterios e pesos ------------------------------------------------------

cotacoesRouter.get('/:id/criterios', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await cot.listarCriterios(id), 'Criterios da cotacao');
}));

cotacoesRouter.put('/:id/criterios', CRITERIOS, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const { criterios } = validar(req, 'body', criteriosSchema);
  return ok(res, await cot.definirCriterios(id, criterios, contexto(req)), 'Criterios atualizados');
}));

// --- Analise ----------------------------------------------------------------

cotacoesRouter.post('/:id/analisar', ANALISAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await comp.analisar(id, contexto(req)), 'Comparativo calculado');
}));

cotacoesRouter.get('/:id/comparativo', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await comp.comparativo(id), 'Comparativo de propostas');
}));

cotacoesRouter.get('/:id/matriz', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const { metrica } = validar(req, 'query', comparativoSchema);
  return ok(res, await comp.matriz(id, metrica), 'Matriz produto x fornecedor');
}));

cotacoesRouter.get('/:id/recomendacao', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await comp.recomendacao(id), 'Recomendacao tecnica');
}));

cotacoesRouter.get('/:id/economia', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await comp.economia(id), 'Economia potencial');
}));

cotacoesRouter.get('/:id/consolidacao', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await cen.consolidacaoPorFornecedor(id), 'Consolidacao por fornecedor');
}));

cotacoesRouter.get('/propostas/:itemId/pontuacao', LER, rota(async (req, res) => {
  const { itemId } = validar(req, 'params', z.object({
    itemId: z.coerce.number().int().positive(),
  }));
  return ok(res, await comp.detalharPontuacao(itemId), 'Como esta proposta foi avaliada');
}));

// --- Cenarios ---------------------------------------------------------------

cotacoesRouter.post('/:id/cenarios', ANALISAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', cenarioSchema);
  return criado(res, await cen.criarCenario(id, entrada, contexto(req)), 'Cenario simulado');
}));

cotacoesRouter.get('/:id/cenarios', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await cen.listarCenarios(id), 'Cenarios da cotacao');
}));

cotacoesRouter.get('/cenarios/:cenarioId', LER, rota(async (req, res) => {
  const { cenarioId } = validar(req, 'params', z.object({
    cenarioId: z.coerce.number().int().positive(),
  }));
  return ok(res, await cen.detalharCenario(cenarioId), 'Cenario');
}));

cotacoesRouter.delete('/cenarios/:cenarioId', ANALISAR, rota(async (req, res) => {
  const { cenarioId } = validar(req, 'params', z.object({
    cenarioId: z.coerce.number().int().positive(),
  }));
  return ok(res, await cen.excluirCenario(cenarioId), 'Cenario excluido');
}));

// --- Decisao e aprovacao ----------------------------------------------------

cotacoesRouter.post('/:id/selecionar', ANALISAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', selecionarPropostaSchema);
  return ok(res, await cen.selecionarPropostas(id, entrada, contexto(req)), 'Selecao registrada');
}));

cotacoesRouter.post('/:id/negociacao', ANALISAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const { justificativa } = validar(req, 'body', decidirCotacaoSchema);
  return ok(res, await cen.marcarNegociacao(id, justificativa, contexto(req)),
    'Cotacao marcada como negociacao necessaria');
}));

cotacoesRouter.post('/:id/aprovar', APROVAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const { justificativa } = validar(req, 'body', decidirCotacaoSchema);
  return ok(res, await cen.aprovarCotacao(id, req.usuario!.perfil, justificativa, contexto(req)),
    'Cotacao aprovada para negociacao');
}));

cotacoesRouter.post('/:id/rejeitar', APROVAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const { justificativa } = validar(req, 'body', decidirCotacaoSchema);
  return ok(res, await cen.rejeitarCotacao(id, justificativa, contexto(req)), 'Cotacao rejeitada');
}));

cotacoesRouter.post('/:id/encaminhar-negociacao', APROVAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await cen.encaminharNegociacao(id, contexto(req)), 'Cotacao encaminhada ao modulo 07');
}));

cotacoesRouter.get('/:id/pacote-negociacao', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await cen.pacoteNegociacao(id), 'Dados preparados para a negociacao');
}));
