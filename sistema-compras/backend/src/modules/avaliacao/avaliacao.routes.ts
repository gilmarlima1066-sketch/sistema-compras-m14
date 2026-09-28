/**
 * Rotas do modulo 10 (secao 61).
 *
 * Permissoes conforme a secao 63:
 *   - fornecedores.ler         consulta, dashboard, comparativo e riscos;
 *   - fornecedores.avaliar     calcular e gravar avaliacao;
 *   - fornecedores.validar     validar e cancelar avaliacao;
 *   - fornecedores.metodologia criar, versionar e publicar metodologia;
 *   - fornecedores.plano_acao  criar e tratar plano de acao;
 *   - fornecedores.monitorar   colocar em monitoramento;
 *   - fornecedores.bloquear    bloquear, desbloquear e homologar.
 *
 * Rotas fixas antes das com ":id".
 */
import { Router } from 'express';
import { z } from 'zod';
import { criado, ok, rota } from '../../core/http.js';
import { semPermissao } from '../../core/errors.js';
import { validar } from '../../core/validate.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import * as av from './avaliacao.service.js';
import * as met from './metodologia.service.js';
import * as plano from './plano.service.js';
import * as painel from './paineis.service.js';
import {
  acaoPlanoSchema, avaliarSchema, cancelarAvaliacaoSchema, comparativoSchema,
  concentracaoSchema, concluirAcaoSchema, listarAvaliacoesSchema, listarMetodologiasSchema,
  listarPlanosSchema, listarSituacoesSchema, metodologiaSchema, parametrosSchema,
  periodoSchema, planoAcaoSchema, publicarMetodologiaSchema, situacaoSchema,
  tratarPlanoSchema, validarAvaliacaoSchema,
} from './avaliacao.schemas.js';

const LER = exigirPermissao('fornecedores.ler');
const AVALIAR = exigirPermissao('fornecedores.avaliar');
const VALIDAR = exigirPermissao('fornecedores.validar');
const METODOLOGIA = exigirPermissao('fornecedores.metodologia');
const PLANO = exigirPermissao('fornecedores.plano_acao');
const MONITORAR = exigirPermissao('fornecedores.monitorar');
const BLOQUEAR = exigirPermissao('fornecedores.bloquear');

const contexto = (req: { usuario?: { id: number }; ip?: string }) => ({
  usuarioId: req.usuario?.id ?? null,
  ip: req.ip ?? null,
});

const idParam = z.object({ id: z.coerce.number().int().positive() });
const rankingSchema = periodoSchema.extend({
  limite: z.coerce.number().int().min(1).max(200).default(50),
});
const precosSchema = z.object({
  produto_id: z.coerce.number().int().positive().optional(),
  fornecedor_id: z.coerce.number().int().positive().optional(),
  dias: z.coerce.number().int().min(1).max(1825).default(365),
});
const versionarSchema = z.object({
  versao: z.string().trim().min(1).max(20),
});

// ===========================================================================
// /api/avaliacao  - paineis, riscos e parametros
// ===========================================================================

export const avaliacaoRouter = Router();
avaliacaoRouter.use(autenticar);

avaliacaoRouter.get('/dashboard', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', periodoSchema);
  return ok(res, await painel.dashboard(filtro), 'Painel de fornecedores');
}));

avaliacaoRouter.get('/ranking', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', rankingSchema);
  return ok(res, await painel.ranking(filtro), 'Ranking de fornecedores');
}));

avaliacaoRouter.get('/alertas', LER, rota(async (_req, res) =>
  ok(res, await painel.alertas(), 'Alertas de performance de fornecedor')));

avaliacaoRouter.get('/concentracao', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', concentracaoSchema);
  return ok(res, await painel.concentracao(filtro), 'Concentracao de fornecimento');
}));

avaliacaoRouter.get('/fornecedor-unico', LER, rota(async (_req, res) =>
  ok(res, await painel.fornecedorUnico(), 'Produtos com fornecedor unico')));

avaliacaoRouter.get('/historico-precos', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', precosSchema);
  return ok(res, await painel.historicoPrecos(filtro), 'Historico de precos');
}));

avaliacaoRouter.get('/comparativo', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', comparativoSchema);
  return ok(res, await av.comparativo(filtro), 'Comparativo de fornecedores');
}));

avaliacaoRouter.get('/parametros', LER, rota(async (_req, res) =>
  ok(res, await painel.listarParametros(), 'Parametros de avaliacao')));

avaliacaoRouter.put('/parametros', METODOLOGIA, rota(async (req, res) => {
  const { parametros } = validar(req, 'body', parametrosSchema);
  return ok(res, await painel.atualizarParametros(parametros, contexto(req).usuarioId),
    'Parametros atualizados');
}));

// ===========================================================================
// /api/metodologias-avaliacao
// ===========================================================================

export const metodologiasRouter = Router();
metodologiasRouter.use(autenticar);

metodologiasRouter.get('/', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarMetodologiasSchema);
  const { dados, meta } = await met.listarMetodologias(filtro);
  return ok(res, dados, 'Metodologias de avaliacao', meta);
}));

metodologiasRouter.post('/', METODOLOGIA, rota(async (req, res) => {
  const entrada = validar(req, 'body', metodologiaSchema);
  return criado(res, await met.criarMetodologia(entrada, contexto(req)), 'Metodologia criada');
}));

metodologiasRouter.get('/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await met.detalharMetodologia(id), 'Metodologia');
}));

metodologiasRouter.put('/:id', METODOLOGIA, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', metodologiaSchema);
  return ok(res, await met.editarMetodologia(id, entrada, contexto(req)),
    'Metodologia atualizada');
}));

metodologiasRouter.post('/:id/versionar', METODOLOGIA, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const { versao } = validar(req, 'body', versionarSchema);
  return criado(res, await met.versionarMetodologia(id, versao, contexto(req)),
    'Nova versao da metodologia criada');
}));

metodologiasRouter.post('/:id/publicar', METODOLOGIA, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', publicarMetodologiaSchema);
  return ok(res, await met.publicarMetodologia(id, entrada, contexto(req)),
    'Metodologia publicada');
}));

// ===========================================================================
// /api/avaliacoes-fornecedores
// ===========================================================================

export const avaliacoesRouter = Router();
avaliacoesRouter.use(autenticar);

avaliacoesRouter.get('/', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarAvaliacoesSchema);
  const { dados, meta } = await av.listarAvaliacoes(filtro);
  return ok(res, dados, 'Avaliacoes de fornecedores', meta);
}));

avaliacoesRouter.get('/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await av.detalharAvaliacao(id), 'Avaliacao');
}));

avaliacoesRouter.post('/:id/validar', VALIDAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', validarAvaliacaoSchema);
  return ok(res, await av.validarAvaliacao(id, entrada, contexto(req)), 'Avaliacao validada');
}));

avaliacoesRouter.post('/:id/cancelar', VALIDAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', cancelarAvaliacaoSchema);
  return ok(res, await av.cancelarAvaliacao(id, entrada, contexto(req)), 'Avaliacao cancelada');
}));

// ===========================================================================
// /api/planos-acao
// ===========================================================================

export const planosRouter = Router();
planosRouter.use(autenticar);

planosRouter.get('/', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarPlanosSchema);
  const { dados, meta } = await plano.listarPlanos(filtro);
  return ok(res, dados, 'Planos de acao', meta);
}));

planosRouter.post('/', PLANO, rota(async (req, res) => {
  const entrada = validar(req, 'body', planoAcaoSchema);
  return criado(res, await plano.criarPlano(entrada, contexto(req)), 'Plano de acao aberto');
}));

planosRouter.get('/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await plano.detalharPlano(id), 'Plano de acao');
}));

planosRouter.put('/:id', PLANO, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', tratarPlanoSchema);
  return ok(res, await plano.tratarPlano(id, entrada, contexto(req)), 'Plano atualizado');
}));

planosRouter.post('/:id/acoes', PLANO, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', acaoPlanoSchema);
  return criado(res, await plano.registrarAcao(id, entrada, contexto(req)), 'Acao registrada');
}));

// ===========================================================================
// /api/plano-acoes/:id/concluir
// ===========================================================================

export const acoesPlanoRouter = Router();
acoesPlanoRouter.use(autenticar);

acoesPlanoRouter.post('/:id/concluir', PLANO, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', concluirAcaoSchema);
  return ok(res, await plano.concluirAcao(id, entrada, contexto(req)), 'Acao atualizada');
}));

// ===========================================================================
// /api/situacoes-fornecedor
// ===========================================================================

export const situacoesRouter = Router();
situacoesRouter.use(autenticar);

situacoesRouter.get('/', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarSituacoesSchema);
  const { dados, meta } = await plano.listarSituacoes(filtro);
  return ok(res, dados, 'Historico de situacao de fornecedores', meta);
}));

// ===========================================================================
// /api/fornecedores/:id/...  (performance, scorecard, avaliacao, plano)
// ===========================================================================

export const performanceFornecedorRouter = Router();
performanceFornecedorRouter.use(autenticar);

performanceFornecedorRouter.get('/:id/perfil', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const filtro = validar(req, 'query', periodoSchema);
  return ok(res, await painel.perfil(id, filtro), 'Perfil do fornecedor');
}));

/** Scorecard: calcula sem gravar. E a previa que a tela mostra. */
performanceFornecedorRouter.get('/:id/scorecard', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const filtro = validar(req, 'query', avaliarSchema);
  return ok(res, await av.calcular(id, { ...filtro, gravar: false }), 'Scorecard do fornecedor');
}));

performanceFornecedorRouter.get('/:id/performance', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const filtro = validar(req, 'query', avaliarSchema);
  const r = await av.calcular(id, { ...filtro, gravar: false });
  return ok(res, {
    fornecedor_id: r.fornecedor_id,
    fornecedor: r.fornecedor,
    periodo: r.periodo,
    score: r.score.score,
    completude: r.score.completude,
    confiabilidade: r.score.confiabilidade,
    indicadores: r.indicadores.map((i) => ({
      grupo: i.grupo, codigo: i.codigo, nome: i.nome, valor: i.valor,
      unidade: i.unidade, eventos: i.eventos, calculavel: i.calculavel,
      motivo: i.motivo, formula: i.formula, fonte: i.fonte,
    })),
  }, 'Performance do fornecedor');
}));

performanceFornecedorRouter.get('/:id/indicadores', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const filtro = validar(req, 'query', avaliarSchema);
  const r = await av.calcular(id, { ...filtro, gravar: false });
  return ok(res, { periodo: r.periodo, indicadores: r.indicadores },
    'Indicadores do fornecedor');
}));

performanceFornecedorRouter.get('/:id/evolucao', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await av.evolucao(id), 'Evolucao da performance');
}));

performanceFornecedorRouter.get('/:id/avaliacoes', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const filtro = validar(req, 'query', listarAvaliacoesSchema);
  const { dados, meta } = await av.listarAvaliacoes({ ...filtro, fornecedor_id: id });
  return ok(res, dados, 'Avaliacoes do fornecedor', meta);
}));

performanceFornecedorRouter.post('/:id/avaliacoes', AVALIAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', avaliarSchema);
  const resultado = await av.avaliar(id, entrada, contexto(req));
  return entrada.gravar
    ? criado(res, resultado, 'Avaliacao registrada')
    : ok(res, resultado, 'Avaliacao calculada (nao gravada)');
}));

performanceFornecedorRouter.get('/:id/plano-acao', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const filtro = validar(req, 'query', listarPlanosSchema);
  const { dados, meta } = await plano.listarPlanos({ ...filtro, fornecedor_id: id });
  return ok(res, dados, 'Planos de acao do fornecedor', meta);
}));

performanceFornecedorRouter.post('/:id/plano-acao', PLANO, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', planoAcaoSchema);
  return criado(res, await plano.criarPlano({ ...entrada, fornecedor_id: id }, contexto(req)),
    'Plano de acao aberto');
}));

performanceFornecedorRouter.get('/:id/situacoes', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const filtro = validar(req, 'query', listarSituacoesSchema);
  const { dados, meta } = await plano.listarSituacoes({ ...filtro, fornecedor_id: id });
  return ok(res, dados, 'Historico de situacao', meta);
}));

/**
 * Monitoramento e bloqueio compartilham a rota, mas nao a permissao: colocar
 * em monitoramento e uma decisao de gestao; bloquear, homologar ou inativar
 * tem consequencia comercial e exige a permissao especifica (secoes 39 a 41).
 *
 * A permissao depende do corpo, entao a checagem acontece dentro do handler e
 * NAO encadeando o middleware por dentro: `exigirPermissao` sinaliza negacao
 * chamando `next(erro)`, e um callback que ignore esse argumento deixaria a
 * acao seguir mesmo negada.
 */
performanceFornecedorRouter.post('/:id/situacao', rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', situacaoSchema);

  const necessaria = entrada.status === 'EM_MONITORAMENTO'
    ? 'fornecedores.monitorar' : 'fornecedores.bloquear';
  const permissoes = req.usuario?.permissoes ?? [];
  if (!permissoes.includes('*') && !permissoes.includes(necessaria)) {
    throw semPermissao(`Permissao necessaria: ${necessaria}`);
  }

  return ok(res, await plano.alterarSituacao(id, entrada, contexto(req)),
    'Situacao do fornecedor atualizada');
}));

// ===========================================================================
// /api/produtos/:id/alternativas
// ===========================================================================

export const alternativasRouter = Router();
alternativasRouter.use(autenticar);

alternativasRouter.get('/:id/alternativas', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await painel.alternativas(id), 'Alternativas de fornecimento');
}));
