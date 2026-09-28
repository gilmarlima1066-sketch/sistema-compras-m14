import { Router } from 'express';
import { z } from 'zod';
import { criado, ok, rota } from '../../core/http.js';
import { validar } from '../../core/validate.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import * as ac from './acompanhamento.service.js';
import * as ent from './entregas.service.js';
import * as oco from './ocorrencias.service.js';
import * as ind from './indicadores.service.js';
import {
  acaoSchema, alterarPrazoSchema, calendarioSchema, concluirAcaoSchema, contatoSchema,
  documentoSchema, editarEntregaSchema, listarAcompanhamentoSchema, listarEntregasSchema,
  listarOcorrenciasSchema, ocorrenciaSchema, parametrosSchema, periodoSchema, previsaoSchema,
  programarSchema, registrarEntregaSchema, statusLogisticoSchema, transporteSchema,
  tratarOcorrenciaSchema,
} from './entregas.schemas.js';

const LER = exigirPermissao('entregas.ler');
const REGISTRAR = exigirPermissao('entregas.registrar');
const PREVISAO = exigirPermissao('entregas.previsao');
const OCORRENCIAS = exigirPermissao('entregas.ocorrencias');
const PARAMETRIZAR = exigirPermissao('entregas.parametrizar');

const contexto = (req: { usuario?: { id: number }; ip?: string }) => ({
  usuarioId: req.usuario?.id ?? null,
  ip: req.ip ?? null,
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

// ===========================================================================
// /api/entregas
// ===========================================================================

export const entregasRouter = Router();
entregasRouter.use(autenticar);

// --- Rotas fixas antes das com :id -----------------------------------------

entregasRouter.get('/dashboard', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', periodoSchema);
  return ok(res, await ind.dashboard(filtro), 'Dashboard de entregas');
}));

entregasRouter.get('/alertas', LER, rota(async (_req, res) =>
  ok(res, await ind.alertas(), 'Alertas logisticos')));

entregasRouter.get('/calendario', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', calendarioSchema);
  return ok(res, await ind.calendario(filtro), 'Calendario de entregas');
}));

entregasRouter.get('/motivos-atraso', LER, rota(async (_req, res) =>
  ok(res, await oco.catalogoMotivos(), 'Motivos de atraso')));

entregasRouter.get('/parametros', LER, rota(async (_req, res) =>
  ok(res, await ind.listarParametros(), 'Parametros de entrega')));

entregasRouter.put('/parametros', PARAMETRIZAR, rota(async (req, res) => {
  const { parametros } = validar(req, 'body', parametrosSchema);
  return ok(res, await ind.atualizarParametros(parametros, req.usuario?.id ?? null),
    'Parametros atualizados');
}));

// --- Acompanhamento (secao 7) ----------------------------------------------

entregasRouter.get('/acompanhamento', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarAcompanhamentoSchema);
  const { dados, meta } = await ac.listarAcompanhamento(filtro);
  return ok(res, dados, 'Itens em acompanhamento', meta);
}));

const atalho = (nome: string, chave: string, mensagem: string) => {
  entregasRouter.get(`/${nome}`, LER, rota(async (req, res) => {
    const filtro = validar(req, 'query', listarAcompanhamentoSchema);
    const { dados, meta } = await ac.listarAcompanhamento({ ...filtro, [chave]: true } as any);
    return ok(res, dados, mensagem, meta);
  }));
};

atalho('atrasadas', 'apenas_atrasados', 'Entregas atrasadas');
atalho('em-risco', 'apenas_em_risco', 'Entregas em risco');
atalho('parciais', 'apenas_parciais', 'Entregas parciais');
atalho('sem-confirmacao', 'apenas_sem_confirmacao', 'Pedidos sem confirmacao');
atalho('sem-previsao', 'apenas_sem_previsao', 'Pedidos sem previsao');
atalho('em-transito', 'apenas_em_transito', 'Pedidos em transito');

// --- Ocorrencias, acoes e contatos -----------------------------------------

entregasRouter.get('/ocorrencias', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarOcorrenciasSchema);
  const { dados, meta } = await oco.listarOcorrencias(filtro);
  return ok(res, dados, 'Ocorrencias logisticas', meta);
}));

entregasRouter.post('/ocorrencias', OCORRENCIAS, rota(async (req, res) => {
  const entrada = validar(req, 'body', ocorrenciaSchema);
  return criado(res, await oco.abrirOcorrencia(entrada, contexto(req)), 'Ocorrencia aberta');
}));

entregasRouter.get('/ocorrencias/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await oco.detalharOcorrencia(id), 'Ocorrencia encontrada');
}));

entregasRouter.post('/ocorrencias/:id/tratar', OCORRENCIAS, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', tratarOcorrenciaSchema);
  return ok(res, await oco.tratarOcorrencia(id, entrada, contexto(req)), 'Ocorrencia atualizada');
}));

entregasRouter.post('/acoes', OCORRENCIAS, rota(async (req, res) => {
  const entrada = validar(req, 'body', acaoSchema);
  return criado(res, await oco.registrarAcao(entrada, contexto(req)), 'Acao registrada');
}));

entregasRouter.post('/acoes/:id', OCORRENCIAS, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', concluirAcaoSchema);
  return ok(res, await oco.concluirAcao(id, entrada, contexto(req)), 'Acao atualizada');
}));

entregasRouter.post('/contatos', OCORRENCIAS, rota(async (req, res) => {
  const entrada = validar(req, 'body', contatoSchema);
  return criado(res, await oco.registrarContato(entrada, contexto(req)), 'Contato registrado');
}));

entregasRouter.post('/documentos', REGISTRAR, rota(async (req, res) => {
  const entrada = validar(req, 'body', documentoSchema);
  return criado(res, await oco.registrarDocumento(entrada, contexto(req)), 'Documento registrado');
}));

// --- Programacao ------------------------------------------------------------

entregasRouter.post('/programacoes', REGISTRAR, rota(async (req, res) => {
  const entrada = validar(req, 'body', programarSchema);
  return criado(res, await ent.programarEntrega(entrada, contexto(req)), 'Entrega programada');
}));

// --- Entregas ---------------------------------------------------------------

entregasRouter.get('/', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarEntregasSchema);
  const { dados, meta } = await ent.listarEntregas(filtro);
  return ok(res, dados, 'Entregas encontradas', meta);
}));

entregasRouter.post('/', REGISTRAR, rota(async (req, res) => {
  const entrada = validar(req, 'body', registrarEntregaSchema);
  return criado(res, await ent.registrarEntrega(entrada, contexto(req)), 'Entrega registrada');
}));

entregasRouter.get('/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await ent.detalharEntrega(id), 'Entrega encontrada');
}));

entregasRouter.put('/:id', REGISTRAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', editarEntregaSchema);
  return ok(res, await ent.editarEntrega(id, entrada, contexto(req)), 'Entrega atualizada');
}));

/** Pacote para o MODULO 09 (secao 83). Nenhum recebimento e criado aqui. */
entregasRouter.get('/:id/recebimento', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await ent.pacoteRecebimento(id), 'Pacote para o recebimento');
}));

// ===========================================================================
// /api/pedidos-compra/:id/... (acompanhamento do pedido, secao 64)
// ===========================================================================

export const acompanhamentoPedidoRouter = Router();
acompanhamentoPedidoRouter.use(autenticar);

acompanhamentoPedidoRouter.get('/:id/entrega', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await ac.acompanharPedido(id), 'Acompanhamento do pedido');
}));

acompanhamentoPedidoRouter.get('/:id/saldo', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await ac.saldoPedido(id), 'Saldo do pedido');
}));

acompanhamentoPedidoRouter.get('/:id/risco', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await ac.riscoPedido(id), 'Risco de ruptura do pedido');
}));

acompanhamentoPedidoRouter.post('/:id/status-logistico', REGISTRAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', statusLogisticoSchema);
  return ok(res, await ent.mudarStatusLogistico(id, entrada, contexto(req)),
    'Status logistico atualizado');
}));

acompanhamentoPedidoRouter.post('/:id/alterar-prazo', PREVISAO, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', alterarPrazoSchema);
  return criado(res, await ent.alterarPrazo(id, entrada, contexto(req)), 'Prazo alterado');
}));

acompanhamentoPedidoRouter.post('/:id/previsao', PREVISAO, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', previsaoSchema);
  return criado(res, await ent.recalcularEta(id, entrada, contexto(req)), 'Previsao atualizada');
}));

acompanhamentoPedidoRouter.post('/:id/transporte', REGISTRAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', transporteSchema);
  return criado(res, await ent.registrarTransporte(id, entrada, contexto(req)),
    'Transporte registrado');
}));

// ===========================================================================
// /api/indicadores (secao 64)
// ===========================================================================

export const indicadoresRouter = Router();
indicadoresRouter.use(autenticar);

indicadoresRouter.get('/otif', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', periodoSchema);
  return ok(res, await ind.indicadoresOtif(filtro), 'OTIF, OTD e In Full');
}));

indicadoresRouter.get('/otd', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', periodoSchema);
  const r = await ind.indicadoresOtif(filtro);
  return ok(res, {
    otd: r.otd, periodo: r.periodo, avaliadas: r.avaliadas, ignoradas: r.ignoradas,
    formula: r.formula.otd, regra: r.regra, base_de_dados: r.base_de_dados,
    atualizado_em: r.atualizado_em,
  }, 'On Time Delivery');
}));

indicadoresRouter.get('/in-full', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', periodoSchema);
  const r = await ind.indicadoresOtif(filtro);
  return ok(res, {
    in_full: r.inFull, periodo: r.periodo, avaliadas: r.avaliadas, ignoradas: r.ignoradas,
    formula: r.formula.inFull, regra: r.regra, base_de_dados: r.base_de_dados,
    atualizado_em: r.atualizado_em,
  }, 'In Full');
}));

indicadoresRouter.get('/atrasos', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', periodoSchema);
  return ok(res, await ind.indicadoresAtrasos(filtro), 'Indicadores de atraso');
}));

indicadoresRouter.get('/performance-entrega', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', periodoSchema);
  return ok(res, await ind.performanceFornecedores(filtro), 'Performance logistica dos fornecedores');
}));

// ===========================================================================
// /api/fornecedores/:id/performance-entrega
// ===========================================================================

export const performanceFornecedorRouter = Router();
performanceFornecedorRouter.use(autenticar);

performanceFornecedorRouter.get('/:id/performance-entrega', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const filtro = validar(req, 'query', periodoSchema);
  return ok(res, await ind.performanceFornecedor(id, filtro),
    'Performance logistica do fornecedor');
}));
