/**
 * Rotas do modulo 09 (secao 49).
 *
 * Divisao de permissoes:
 *   - recebimento.ler        consulta, rastreio e indicadores;
 *   - recebimento.registrar  chegada, conferencia, divergencia, anexo;
 *   - recebimento.aprovar    aprovacao, rejeicao e decisao de divergencia;
 *   - recebimento.devolucao  devolucao ao fornecedor;
 *   - recebimento.excecao    excecoes autorizadas na aprovacao;
 *   - recebimento.parametrizar  toleranciais, checklists e configuracoes;
 *   - qualidade.inspecionar  inspecao e quarentena;
 *   - qualidade.liberar      decisao de quarentena;
 *   - qualidade.nao_conformidade  abertura e tratativa de NC.
 *
 * Rotas fixas sempre antes das que usam ":id", senao o Express casa o texto
 * literal com o parametro.
 */
import { Router } from 'express';
import { z } from 'zod';
import { criado, ok, rota } from '../../core/http.js';
import { validar } from '../../core/validate.js';
import { paginacaoSchema } from '../../core/paginacao.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import * as rec from './recebimento.service.js';
import * as qua from './qualidade.service.js';
import * as apr from './aprovacao.service.js';
import * as ind from './indicadores.service.js';
import {
  acaoNcSchema, adicionarItemSchema, anexoSchema, aprovarSchema, autorizarDevolucaoSchema,
  checklistSchema, chegadaSchema, concluirAcaoNcSchema, conferenciaDocumentosSchema,
  conferenciaLoteSchema, conferirItemSchema, criarRecebimentoSchema, decidirDivergenciaSchema,
  decidirQuarentenaSchema, devolucaoSchema, divergenciaSchema, editarRecebimentoSchema,
  escanearSchema, inspecaoSchema, listarDevolucoesSchema, listarDivergenciasSchema,
  listarNcSchema, listarRecebimentosSchema, ncSchema, parametrosSchema, periodoSchema,
  quarentenaSchema, rejeitarSchema, toleranciaSchema, tratarNcSchema,
} from './recebimento.schemas.js';

const LER = exigirPermissao('recebimento.ler');
const REGISTRAR = exigirPermissao('recebimento.registrar');
const APROVAR = exigirPermissao('recebimento.aprovar');
const DEVOLUCAO = exigirPermissao('recebimento.devolucao');
const PARAMETRIZAR = exigirPermissao('recebimento.parametrizar');
const INSPECIONAR = exigirPermissao('qualidade.inspecionar');
const LIBERAR = exigirPermissao('qualidade.liberar');
const NC = exigirPermissao('qualidade.nao_conformidade');

const contexto = (req: { usuario?: { id: number }; ip?: string }) => ({
  usuarioId: req.usuario?.id ?? null,
  ip: req.ip ?? null,
});

const idParam = z.object({ id: z.coerce.number().int().positive() });
const quarentenaFiltroSchema = paginacaoSchema.extend({
  status: z.enum(['ABERTA', 'LIBERADA', 'REJEITADA', 'DEVOLVIDA']).optional(),
});
const validadeSchema = z.object({
  dias: z.coerce.number().int().min(1).max(3650).optional(),
  produto_id: z.coerce.number().int().positive().optional(),
});

// ===========================================================================
// /api/recebimentos
// ===========================================================================

export const recebimentosRouter = Router();
recebimentosRouter.use(autenticar);

// --- Fixas -----------------------------------------------------------------

recebimentosRouter.get('/dashboard', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', periodoSchema);
  return ok(res, await ind.dashboard(filtro), 'Painel de recebimento');
}));

recebimentosRouter.get('/indicadores', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', periodoSchema);
  return ok(res, await ind.indicadoresRecebimento(filtro), 'Indicadores de recebimento');
}));

recebimentosRouter.get('/alertas', LER, rota(async (_req, res) =>
  ok(res, await ind.alertas(), 'Alertas de recebimento e qualidade')));

recebimentosRouter.get('/controle-validade', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', validadeSchema);
  return ok(res, await ind.controleValidade(filtro), 'Controle de validade (FEFO)');
}));

recebimentosRouter.get('/checklists', LER, rota(async (_req, res) =>
  ok(res, await qua.catalogoChecklists(), 'Checklists de qualidade')));

recebimentosRouter.post('/checklists', PARAMETRIZAR, rota(async (req, res) => {
  const entrada = validar(req, 'body', checklistSchema);
  return criado(res, await ind.salvarChecklist(entrada), 'Checklist salvo');
}));

recebimentosRouter.get('/parametros', LER, rota(async (_req, res) =>
  ok(res, await ind.listarParametros(), 'Parametros de recebimento')));

recebimentosRouter.put('/parametros', PARAMETRIZAR, rota(async (req, res) => {
  const { parametros } = validar(req, 'body', parametrosSchema);
  const atualizados = await ind.atualizarParametros(parametros, contexto(req).usuarioId);
  return ok(res, atualizados, 'Parametros atualizados');
}));

recebimentosRouter.post('/tolerancias', PARAMETRIZAR, rota(async (req, res) => {
  const entrada = validar(req, 'body', toleranciaSchema);
  return criado(res, await ind.salvarTolerancia(entrada, contexto(req).usuarioId),
    'Tolerancia salva');
}));

// --- CRUD -------------------------------------------------------------------

recebimentosRouter.get('/', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarRecebimentosSchema);
  const { dados, meta } = await rec.listarRecebimentos(filtro);
  return ok(res, dados, 'Recebimentos', meta);
}));

recebimentosRouter.post('/', REGISTRAR, rota(async (req, res) => {
  const entrada = validar(req, 'body', criarRecebimentoSchema);
  return criado(res, await rec.criarRecebimento(entrada, contexto(req)), 'Recebimento aberto');
}));

recebimentosRouter.get('/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await rec.detalharRecebimento(id), 'Recebimento');
}));

recebimentosRouter.put('/:id', REGISTRAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', editarRecebimentoSchema);
  return ok(res, await rec.editarRecebimento(id, entrada, contexto(req)),
    'Recebimento atualizado');
}));

// --- Fluxo de conferencia ---------------------------------------------------

recebimentosRouter.post('/:id/chegada', REGISTRAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', chegadaSchema);
  return ok(res, await rec.registrarChegada(id, entrada, contexto(req)), 'Chegada registrada');
}));

recebimentosRouter.post('/:id/documentos', REGISTRAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', conferenciaDocumentosSchema);
  return ok(res, await rec.conferirDocumentos(id, entrada, contexto(req)),
    'Conferencia documental registrada');
}));

recebimentosRouter.get('/:id/itens', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await rec.listarItens(id), 'Itens do recebimento');
}));

recebimentosRouter.post('/:id/itens', REGISTRAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', adicionarItemSchema);
  return criado(res, await rec.adicionarItem(id, entrada, contexto(req)), 'Item adicionado');
}));

recebimentosRouter.post('/:id/conferencia', REGISTRAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', conferenciaLoteSchema);
  return ok(res, await rec.conferirLote(id, entrada, contexto(req)), 'Conferencia registrada');
}));

recebimentosRouter.post('/:id/conferencia/concluir', REGISTRAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await rec.concluirConferencia(id, contexto(req)), 'Conferencia concluida');
}));

recebimentosRouter.post('/:id/escanear', REGISTRAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', escanearSchema);
  return ok(res, await rec.escanear(id, entrada), 'Item localizado');
}));

// --- Divergencias -----------------------------------------------------------

recebimentosRouter.post('/:id/divergencia', REGISTRAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', divergenciaSchema);
  return criado(res, await rec.registrarDivergencia(id, entrada, contexto(req)),
    'Divergencia registrada');
}));

// --- Qualidade --------------------------------------------------------------

recebimentosRouter.get('/:id/qualidade', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await qua.qualidadeDoRecebimento(id), 'Qualidade do recebimento');
}));

recebimentosRouter.post('/:id/inspecao', INSPECIONAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', inspecaoSchema);
  return criado(res, await qua.registrarInspecao(id, entrada, contexto(req)),
    'Inspecao registrada');
}));

recebimentosRouter.post('/:id/quarentena', INSPECIONAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', quarentenaSchema);
  return criado(res, await qua.abrirQuarentena(id, entrada, contexto(req)), 'Quarentena aberta');
}));

// --- Aprovacao --------------------------------------------------------------

recebimentosRouter.get('/:id/validar', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await apr.validarRecebimento(id), 'Validacao previa do recebimento');
}));

recebimentosRouter.post('/:id/aprovar', APROVAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', aprovarSchema);
  return ok(res, await apr.aprovarRecebimento(id, entrada, contexto(req)),
    'Recebimento aprovado e estoque atualizado');
}));

recebimentosRouter.post('/:id/reprovar', APROVAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', rejeitarSchema);
  return ok(res, await apr.rejeitarRecebimento(id, entrada, contexto(req)),
    'Recebimento reprovado');
}));

// --- Rastreabilidade e anexos ------------------------------------------------

recebimentosRouter.get('/:id/rastreabilidade', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await rec.rastrear(id), 'Rastreabilidade do recebimento');
}));

recebimentosRouter.get('/:id/anexos', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await rec.listarAnexos(id), 'Anexos do recebimento');
}));

recebimentosRouter.post('/:id/anexos', REGISTRAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', anexoSchema);
  return criado(res, await rec.registrarAnexo({ ...entrada, recebimento_id: id }, contexto(req)),
    'Anexo registrado');
}));

// ===========================================================================
// /api/recebimento-itens/:id  (conferencia item a item)
// ===========================================================================

export const recebimentoItensRouter = Router();
recebimentoItensRouter.use(autenticar);

recebimentoItensRouter.post('/:id/conferir', REGISTRAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', conferirItemSchema);
  return ok(res, await rec.conferirItem(id, entrada, contexto(req)), 'Item conferido');
}));

// ===========================================================================
// /api/divergencias
// ===========================================================================

export const divergenciasRouter = Router();
divergenciasRouter.use(autenticar);

divergenciasRouter.get('/', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarDivergenciasSchema);
  const { dados, meta } = await rec.listarDivergencias(filtro);
  return ok(res, dados, 'Divergencias', meta);
}));

divergenciasRouter.post('/:id/decidir', APROVAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', decidirDivergenciaSchema);
  return ok(res, await apr.decidirDivergencia(id, entrada, contexto(req)),
    'Divergencia decidida');
}));

// ===========================================================================
// /api/quarentenas
// ===========================================================================

export const quarentenasRouter = Router();
quarentenasRouter.use(autenticar);

quarentenasRouter.get('/', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', quarentenaFiltroSchema);
  const { dados, meta } = await qua.listarQuarentenas(filtro);
  return ok(res, dados, 'Quarentenas', meta);
}));

quarentenasRouter.post('/:id/decidir', LIBERAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', decidirQuarentenaSchema);
  return ok(res, await qua.decidirQuarentena(id, entrada, contexto(req)), 'Quarentena decidida');
}));

// ===========================================================================
// /api/nao-conformidades
// ===========================================================================

export const naoConformidadesRouter = Router();
naoConformidadesRouter.use(autenticar);

naoConformidadesRouter.get('/dashboard', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', periodoSchema);
  return ok(res, await ind.dashboardQualidade(filtro), 'Painel de qualidade');
}));

naoConformidadesRouter.get('/', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarNcSchema);
  const { dados, meta } = await qua.listarNaoConformidades(filtro);
  return ok(res, dados, 'Nao conformidades', meta);
}));

naoConformidadesRouter.post('/', NC, rota(async (req, res) => {
  const entrada = validar(req, 'body', ncSchema);
  return criado(res, await qua.abrirNaoConformidade(entrada, contexto(req)),
    'Nao conformidade aberta');
}));

naoConformidadesRouter.get('/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await qua.detalharNaoConformidade(id), 'Nao conformidade');
}));

naoConformidadesRouter.put('/:id', NC, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', tratarNcSchema);
  return ok(res, await qua.tratarNaoConformidade(id, entrada, contexto(req)),
    'Nao conformidade atualizada');
}));

naoConformidadesRouter.post('/:id/acoes', NC, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', acaoNcSchema);
  return criado(res, await qua.registrarAcaoNc(id, entrada, contexto(req)), 'Acao registrada');
}));

// ===========================================================================
// /api/nc-acoes/:id/concluir
// ===========================================================================

export const acoesNcRouter = Router();
acoesNcRouter.use(autenticar);

acoesNcRouter.post('/:id/concluir', NC, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', concluirAcaoNcSchema);
  return ok(res, await qua.concluirAcaoNc(id, entrada, contexto(req)), 'Acao concluida');
}));

// ===========================================================================
// /api/devolucoes
// ===========================================================================

export const devolucoesRouter = Router();
devolucoesRouter.use(autenticar);

devolucoesRouter.get('/', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarDevolucoesSchema);
  const { dados, meta } = await qua.listarDevolucoes(filtro);
  return ok(res, dados, 'Devolucoes', meta);
}));

devolucoesRouter.post('/', DEVOLUCAO, rota(async (req, res) => {
  const entrada = validar(req, 'body', devolucaoSchema);
  return criado(res, await qua.criarDevolucao(entrada, contexto(req)), 'Devolucao criada');
}));

devolucoesRouter.get('/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await qua.detalharDevolucao(id), 'Devolucao');
}));

devolucoesRouter.post('/:id/autorizar', DEVOLUCAO, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', autorizarDevolucaoSchema);
  return ok(res, await qua.autorizarDevolucao(id, entrada, contexto(req)), 'Devolucao autorizada');
}));

// ===========================================================================
// /api/fornecedores/:id/qualidade  (dados brutos para o modulo 10)
// ===========================================================================

export const qualidadeFornecedorRouter = Router();
qualidadeFornecedorRouter.use(autenticar);

qualidadeFornecedorRouter.get('/:id/qualidade', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const filtro = validar(req, 'query', periodoSchema);
  return ok(res, await ind.pacoteFornecedor(id, filtro),
    'Dados de recebimento e qualidade do fornecedor');
}));
