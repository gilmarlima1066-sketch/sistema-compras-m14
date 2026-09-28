import { Router } from 'express';
import { z } from 'zod';
import { criado, ok, rota } from '../../core/http.js';
import { validar } from '../../core/validate.js';
import { paginacaoSchema } from '../../core/paginacao.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import * as demanda from './demanda.service.js';
import * as previsao from './previsao.service.js';
import * as analise from './analise.service.js';
import {
  analiseDemandaSchema, calcularPrevisaoSchema, classificarAbcXyzSchema,
  classificarReprimidaSchema, comparacaoSchema, configuracoesSchema,
  eventoCalendarioSchema, filtroPeriodoSchema, importarVendasSchema,
  listarVendasSchema, previsaoManualSchema, tratarOutlierSchema,
} from './demanda.schemas.js';

export const demandaRouter = Router();
demandaRouter.use(autenticar);

const LER = exigirPermissao('demanda.ler');
const PREVER = exigirPermissao('demanda.prever');
const AJUSTAR = exigirPermissao('demanda.ajustar');
const IMPORTAR = exigirPermissao('demanda.importar');

const contexto = (req: { usuario?: { id: number }; ip?: string }) => ({
  usuarioId: req.usuario?.id ?? null,
  ip: req.ip ?? null,
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

// --- Dashboard e analise -----------------------------------------------------

demandaRouter.get('/dashboard', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', filtroPeriodoSchema);
  return ok(res, await demanda.dashboard(filtro), 'Dashboard de demanda');
}));

demandaRouter.get('/', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', analiseDemandaSchema);
  const { dados, meta } = await demanda.analisarDemanda(filtro);
  return ok(res, dados, 'Analise de demanda por produto', meta);
}));

demandaRouter.get('/vendas', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarVendasSchema);
  const { dados, meta } = await demanda.listarVendas(filtro);
  return ok(res, dados, 'Historico de vendas', meta);
}));

demandaRouter.post('/vendas/importar', IMPORTAR, rota(async (req, res) => {
  const payload = validar(req, 'body', importarVendasSchema);
  const resultado = await demanda.importarVendas(payload, contexto(req));
  return resultado.importado
    ? criado(res, resultado, 'Vendas importadas')
    : ok(res, resultado, 'Previa da importacao - nada foi gravado');
}));

demandaRouter.post('/agregados/atualizar', PREVER, rota(async (_req, res) =>
  ok(res, await demanda.atualizarAgregados(), 'Agregados de demanda atualizados')));

demandaRouter.get('/comparacao', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', comparacaoSchema);
  return ok(res, await demanda.compararPeriodos(filtro), 'Comparacao de periodos');
}));

demandaRouter.get('/perfil-temporal', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', filtroPeriodoSchema);
  return ok(res, await demanda.perfilTemporal(filtro), 'Demanda por dia da semana, mes e ano');
}));

demandaRouter.get('/qualidade', LER, rota(async (_req, res) =>
  ok(res, await demanda.qualidadeDados(), 'Qualidade dos dados de vendas')));

// --- Previsao ---------------------------------------------------------------
// Declarada antes de /produto/:id e demais rotas com parametro para que
// "previsao" nunca seja lido como um id.

demandaRouter.get('/previsao', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', paginacaoSchema.extend({
    produto_id: z.coerce.number().int().positive().optional(),
    categoria_id: z.coerce.number().int().positive().optional(),
    confiabilidade: z.enum(['ALTA', 'MEDIA', 'BAIXA', 'INSUFICIENTE']).optional(),
  }));
  const { dados, meta } = await previsao.listarPrevisoes(filtro);
  return ok(res, dados, 'Previsoes vigentes', meta);
}));

demandaRouter.post('/previsao/calcular', PREVER, rota(async (req, res) => {
  const entrada = validar(req, 'body', calcularPrevisaoSchema);
  return criado(res, await previsao.executarPrevisao(entrada, contexto(req)), 'Previsao calculada');
}));

demandaRouter.post('/previsao/manual', AJUSTAR, rota(async (req, res) => {
  const entrada = validar(req, 'body', previsaoManualSchema);
  return criado(res, await previsao.registrarPrevisaoManual(entrada, contexto(req)), 'Previsao manual registrada');
}));

demandaRouter.get('/previsao/execucoes', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', paginacaoSchema);
  const { dados, meta } = await previsao.listarExecucoes(filtro);
  return ok(res, dados, 'Execucoes de previsao', meta);
}));

demandaRouter.get('/previsao/:produtoId', LER, rota(async (req, res) => {
  const { produtoId } = validar(req, 'params', z.object({ produtoId: z.coerce.number().int().positive() }));
  return ok(res, await previsao.historicoPrevisoesProduto(produtoId), 'Historico de previsoes do produto');
}));

// --- Acuracidade ------------------------------------------------------------

demandaRouter.post('/acuracidade/avaliar', PREVER, rota(async (_req, res) =>
  ok(res, await previsao.avaliarAcuracidade(), 'Previsoes confrontadas com o realizado')));

demandaRouter.get('/acuracidade', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', paginacaoSchema.extend({
    produto_id: z.coerce.number().int().positive().optional(),
    categoria_id: z.coerce.number().int().positive().optional(),
    metodo: z.string().trim().max(40).optional(),
  }));
  const resultado = await previsao.acuracidade(filtro);
  return ok(res, resultado.dados, 'Previsao x realizado', {
    ...resultado.meta, resumo: resultado.resumo, por_metodo: resultado.por_metodo,
  });
}));

// --- Sazonalidade -----------------------------------------------------------

demandaRouter.post('/sazonalidade/calcular', PREVER, rota(async (req, res) => {
  const { produto_id } = validar(req, 'body', z.object({
    produto_id: z.coerce.number().int().positive().optional(),
  }));
  return ok(res, await analise.calcularSazonalidade(produto_id), 'Indices sazonais recalculados');
}));

demandaRouter.get('/sazonalidade', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', paginacaoSchema.extend({
    confirmado: z.enum(['true', 'false']).optional(),
  }));
  const { dados, meta } = await analise.listarSazonalidade({
    ...filtro,
    confirmado: filtro.confirmado === undefined ? undefined : filtro.confirmado === 'true',
  });
  return ok(res, dados, 'Produtos com padrao sazonal', meta);
}));

demandaRouter.get('/sazonalidade/:produtoId', LER, rota(async (req, res) => {
  const { produtoId } = validar(req, 'params', z.object({ produtoId: z.coerce.number().int().positive() }));
  return ok(res, await analise.sazonalidadeProduto(produtoId), 'Sazonalidade do produto');
}));

// --- Outliers ---------------------------------------------------------------

demandaRouter.post('/outliers/detectar', PREVER, rota(async (req, res) => {
  const filtro = validar(req, 'body', filtroPeriodoSchema);
  return ok(res, await analise.detectarOutliers(filtro), 'Deteccao de outliers concluida');
}));

demandaRouter.get('/outliers', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', paginacaoSchema.extend({
    tratamento: z.enum(['PENDENTE', 'MANTER', 'EXCLUIR', 'TRATAR_SEPARADO']).optional(),
    produto_id: z.coerce.number().int().positive().optional(),
  }));
  const { dados, meta } = await analise.listarOutliers(filtro);
  return ok(res, dados, 'Vendas fora do padrao', meta);
}));

demandaRouter.post('/outliers/:id/tratar', AJUSTAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', tratarOutlierSchema);
  return ok(res, await analise.tratarOutlier(id, entrada, contexto(req)), 'Tratamento registrado');
}));

// --- Ruptura e demanda reprimida --------------------------------------------

demandaRouter.get('/ruptura', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', analiseDemandaSchema);
  const resultado = await analise.analisarRuptura(filtro);
  return ok(res, resultado.dados, 'Produtos com dias em ruptura', {
    periodo: resultado.periodo, aviso: resultado.aviso,
  });
}));

demandaRouter.post('/reprimida/calcular', PREVER, rota(async (req, res) => {
  const filtro = validar(req, 'body', filtroPeriodoSchema);
  return ok(res, await analise.calcularDemandaReprimida(filtro), 'Estimativa de demanda reprimida atualizada');
}));

demandaRouter.get('/reprimida', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', paginacaoSchema.extend({
    classificacao: z.enum(['POSSIVEL', 'PROVAVEL', 'CONFIRMADA']).optional(),
    produto_id: z.coerce.number().int().positive().optional(),
  }));
  const resultado = await analise.listarDemandaReprimida(filtro);
  return ok(res, resultado.dados, 'Estimativa de demanda reprimida', {
    ...resultado.meta, impacto: resultado.impacto, observacao: resultado.observacao,
  });
}));

demandaRouter.post('/reprimida/:id/classificar', AJUSTAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', classificarReprimidaSchema);
  return ok(res, await analise.classificarReprimida(id, entrada, contexto(req)), 'Classificacao registrada');
}));

// --- ABC x XYZ --------------------------------------------------------------

demandaRouter.post('/abc-xyz/classificar', PREVER, rota(async (req, res) => {
  const { dias } = validar(req, 'body', classificarAbcXyzSchema);
  return ok(res, await analise.classificarAbcXyz(dias, contexto(req)), 'Produtos reclassificados');
}));

demandaRouter.get('/abc-xyz', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', filtroPeriodoSchema);
  return ok(res, await analise.matrizAbcXyz(filtro), 'Matriz ABC x XYZ');
}));

// --- Visoes derivadas -------------------------------------------------------

demandaRouter.get('/criticos', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', paginacaoSchema);
  return ok(res, await analise.produtosCriticos(filtro), 'Produtos criticos');
}));

demandaRouter.get('/irregulares', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', paginacaoSchema);
  return ok(res, await analise.demandaIrregular(filtro), 'Produtos com demanda irregular');
}));

demandaRouter.get('/alertas', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', filtroPeriodoSchema);
  return ok(res, await analise.alertasDemanda(filtro), 'Alertas de demanda');
}));

// --- Calendario e parametros ------------------------------------------------

demandaRouter.get('/calendario', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', z.object({
    data_inicio: z.coerce.date().optional(),
    data_fim: z.coerce.date().optional(),
    tipo: z.enum(['FERIADO', 'DATA_COMEMORATIVA', 'CAMPANHA', 'PROMOCAO', 'EVENTO', 'SEM_OPERACAO']).optional(),
  }));
  return ok(res, await analise.listarCalendario(filtro), 'Calendario de eventos');
}));

demandaRouter.post('/calendario', AJUSTAR, rota(async (req, res) => {
  const entrada = validar(req, 'body', eventoCalendarioSchema);
  return criado(res, await analise.criarEventoCalendario(entrada, contexto(req)), 'Evento registrado');
}));

demandaRouter.get('/configuracoes', LER, rota(async (_req, res) =>
  ok(res, await analise.listarParametros(), 'Parametros de previsao')));

demandaRouter.put('/configuracoes', AJUSTAR, rota(async (req, res) => {
  const valores = validar(req, 'body', configuracoesSchema);
  return ok(res, await analise.atualizarParametros(valores, contexto(req)), 'Parametros atualizados');
}));

// --- Detalhes por entidade (rotas com parametro ficam por ultimo) -----------

demandaRouter.get('/produto/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const filtro = validar(req, 'query', filtroPeriodoSchema);
  return ok(res, await demanda.detalharProduto(id, filtro), 'Demanda do produto');
}));

demandaRouter.get('/categoria/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const filtro = validar(req, 'query', filtroPeriodoSchema);
  return ok(res, await demanda.analisarCategoria(id, filtro), 'Demanda da categoria');
}));
