import { Router } from 'express';
import { z } from 'zod';
import { criado, ok, rota } from '../../core/http.js';
import { validar } from '../../core/validate.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import * as neg from './negociacao.service.js';
import * as ped from './pedido.service.js';
import * as ind from './indicadores.service.js';
import {
  aprovarPedidoSchema, cancelarPedidoSchema, confirmarPedidoSchema, converterPedidoSchema,
  criarNegociacaoSchema, decidirAlteracaoSchema, decidirSchema, enviarPedidoSchema,
  listarNegociacoesSchema, listarPedidosSchema, rejeitarSchema, rodadaSchema,
  simularVolumeSchema, solicitarAlteracaoSchema,
} from './negociacao.schemas.js';

const LER = exigirPermissao('compras.ler');
const NEGOCIAR = exigirPermissao('compras.negociar');
const APROVAR_NEG = exigirPermissao('compras.aprovar_negociacao');
const PEDIDO_LER = exigirPermissao('ordens_compra.ler');
const PEDIDO_CRIAR = exigirPermissao('ordens_compra.criar');
const PEDIDO_APROVAR = exigirPermissao('ordens_compra.aprovar');
const PEDIDO_ENVIAR = exigirPermissao('ordens_compra.enviar');
const PEDIDO_ALTERAR = exigirPermissao('ordens_compra.alterar');
const PEDIDO_CANCELAR = exigirPermissao('ordens_compra.cancelar');

const contexto = (req: { usuario?: { id: number }; ip?: string }) => ({
  usuarioId: req.usuario?.id ?? null,
  ip: req.ip ?? null,
});

const idParam = z.object({ id: z.coerce.number().int().positive() });
const periodoSchema = z.object({ dias: z.coerce.number().int().min(1).max(1095).default(180) });

// ===========================================================================
// Negociacoes
// ===========================================================================

export const negociacoesRouter = Router();
negociacoesRouter.use(autenticar);

// Rotas fixas antes das com :id, senao o param captura a palavra.

negociacoesRouter.get('/dashboard', LER, rota(async (req, res) => {
  const { dias } = validar(req, 'query', periodoSchema);
  return ok(res, await ind.dashboard(dias), 'Dashboard de negociacoes e pedidos');
}));

negociacoesRouter.get('/alertas', LER, rota(async (_req, res) =>
  ok(res, await ind.alertas(), 'Alertas de negociacao e pedido')));

negociacoesRouter.get('/indicadores', LER, rota(async (req, res) => {
  const { dias } = validar(req, 'query', periodoSchema);
  return ok(res, await ind.indicadoresCompras(dias), 'Indicadores de compras');
}));

negociacoesRouter.get('/kpi', LER, rota(async (req, res) => {
  const { dias } = validar(req, 'query', periodoSchema);
  const [negociacao, pedido] = await Promise.all([ind.kpiNegociacao(dias), ind.kpiPedido(dias)]);
  return ok(res, { negociacao, pedido }, 'KPIs de negociacao e pedido');
}));

negociacoesRouter.get('/', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarNegociacoesSchema);
  const { dados, meta } = await neg.listarNegociacoes(filtro);
  return ok(res, dados, 'Negociacoes encontradas', meta);
}));

negociacoesRouter.post('/', NEGOCIAR, rota(async (req, res) => {
  const entrada = validar(req, 'body', criarNegociacaoSchema);
  return criado(res, await neg.criarNegociacao(entrada, contexto(req)), 'Negociacao criada');
}));

negociacoesRouter.get('/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await neg.detalharNegociacao(id), 'Negociacao encontrada');
}));

negociacoesRouter.post('/:id/rodadas', NEGOCIAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', rodadaSchema);
  return criado(res, await neg.registrarRodada(id, entrada, contexto(req)), 'Rodada registrada');
}));

negociacoesRouter.post('/:id/simular-volume', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', simularVolumeSchema);
  return ok(res, await neg.simularVolume(id, entrada), 'Simulacao de volume');
}));

negociacoesRouter.post('/:id/acordar', NEGOCIAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await neg.acordarNegociacao(id, contexto(req)), 'Negociacao acordada');
}));

negociacoesRouter.post('/:id/aprovar', APROVAR_NEG, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const { justificativa } = validar(req, 'body', decidirSchema);
  return ok(
    res,
    await neg.aprovarNegociacao(id, req.usuario!.perfil, justificativa, contexto(req)),
    'Negociacao aprovada',
  );
}));

negociacoesRouter.post('/:id/rejeitar', APROVAR_NEG, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', rejeitarSchema);
  return ok(res, await neg.rejeitarNegociacao(id, entrada, contexto(req)), 'Negociacao rejeitada');
}));

negociacoesRouter.post('/:id/cancelar', NEGOCIAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const { justificativa } = validar(req, 'body', decidirSchema);
  return ok(res, await neg.cancelarNegociacao(id, justificativa, contexto(req)), 'Negociacao cancelada');
}));

/** Conversao em pedido oficial (secao 24). Exige permissao de criar pedido. */
negociacoesRouter.post('/:id/converter-pedido', PEDIDO_CRIAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', converterPedidoSchema);
  return criado(res, await ped.converterEmPedido(id, entrada, contexto(req)), 'Pedido de compra gerado');
}));

// ===========================================================================
// Pedidos de compra
// ===========================================================================

export const pedidosRouter = Router();
pedidosRouter.use(autenticar);

pedidosRouter.get('/', PEDIDO_LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarPedidosSchema);
  const { dados, meta } = await ped.listarPedidos(filtro);
  return ok(res, dados, 'Pedidos encontrados', meta);
}));

/** Decisao de alteracao vem antes de /:id para nao ser capturada pelo param. */
pedidosRouter.post('/alteracoes/:id', PEDIDO_APROVAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', decidirAlteracaoSchema);
  return ok(res, await ped.decidirAlteracao(id, entrada, contexto(req)), 'Alteracao decidida');
}));

pedidosRouter.get('/:id', PEDIDO_LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await ped.detalharPedido(id), 'Pedido encontrado');
}));

pedidosRouter.get('/:id/documento', PEDIDO_LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await ped.documentoPedido(id), 'Documento do pedido');
}));

pedidosRouter.get('/:id/validacao', PEDIDO_LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await ped.validarPedido(id), 'Validacao do pedido');
}));

pedidosRouter.get('/:id/simular-aprovacao', PEDIDO_LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await ped.simularAprovacao(id), 'Simulacao de aprovacao');
}));

pedidosRouter.get('/:id/timeline', PEDIDO_LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await ind.timeline(id), 'Timeline da compra');
}));

/** Pacote de acompanhamento consumido pelo MODULO 08 (secao 82). */
pedidosRouter.get('/:id/acompanhamento', PEDIDO_LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await ped.pacoteAcompanhamento(id), 'Pacote de acompanhamento');
}));

pedidosRouter.post('/:id/enviar-aprovacao', PEDIDO_CRIAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await ped.enviarParaAprovacao(id, contexto(req)), 'Pedido enviado para aprovacao');
}));

pedidosRouter.post('/:id/aprovar', PEDIDO_APROVAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', aprovarPedidoSchema);
  return ok(
    res,
    await ped.aprovarPedido(id, req.usuario!.perfil, entrada, contexto(req)),
    'Pedido aprovado',
  );
}));

pedidosRouter.post('/:id/rejeitar', PEDIDO_APROVAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', rejeitarSchema);
  return ok(res, await ped.rejeitarPedido(id, entrada, contexto(req)), 'Pedido rejeitado');
}));

pedidosRouter.post('/:id/enviar', PEDIDO_ENVIAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', enviarPedidoSchema);
  return ok(res, await ped.enviarPedido(id, entrada, contexto(req)), 'Pedido enviado ao fornecedor');
}));

pedidosRouter.post('/:id/confirmar', PEDIDO_ENVIAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', confirmarPedidoSchema);
  return ok(res, await ped.confirmarPedido(id, entrada, contexto(req)), 'Confirmacao do fornecedor registrada');
}));

pedidosRouter.post('/:id/alteracoes', PEDIDO_ALTERAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', solicitarAlteracaoSchema);
  return criado(res, await ped.solicitarAlteracao(id, entrada, contexto(req)), 'Alteracao solicitada');
}));

pedidosRouter.post('/:id/cancelar', PEDIDO_CANCELAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', cancelarPedidoSchema);
  return ok(res, await ped.cancelarPedido(id, entrada, contexto(req)), 'Pedido cancelado');
}));
