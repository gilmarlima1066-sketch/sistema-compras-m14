import { Router } from 'express';
import { z } from 'zod';
import { criado, ok, rota } from '../../core/http.js';
import { validar } from '../../core/validate.js';
import { paginacaoSchema } from '../../core/paginacao.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import { query } from '../../config/database.js';
import { regraNegocio } from '../../core/errors.js';
import * as plan from './planejamento.service.js';
import * as visoes from './visoes.service.js';
import * as simulacao from './simulacao.service.js';
import * as requisicao from './requisicao.service.js';
import * as painel from './painel.service.js';
import {
  ajustarNecessidadeSchema, alcadaSchema, calendarioComprasSchema,
  compararSimulacoesSchema, criarRequisicaoSchema, decidirNecessidadeSchema,
  decidirRequisicaoSchema, executarPlanejamentoSchema, listarNecessidadesSchema,
  parametrosSchema, recalcularParametrosSchema, simularSchema,
} from './planejamento.schemas.js';

export const planejamentoRouter = Router();
planejamentoRouter.use(autenticar);

const LER = exigirPermissao('compras.ler');
const PLANEJAR = exigirPermissao('compras.planejar');
const APROVAR = exigirPermissao('compras.aprovar');
const REQUISITAR = exigirPermissao('compras.requisitar');
const SIMULAR = exigirPermissao('compras.simular');
// Parametros e alcadas sao regra do jogo, nao registro: exigem permissao propria.
const PARAMETRIZAR = exigirPermissao('compras.parametrizar');

const contexto = (req: { usuario?: { id: number }; ip?: string }) => ({
  usuarioId: req.usuario?.id ?? null,
  ip: req.ip ?? null,
});

const idParam = z.object({ id: z.coerce.number().int().positive() });
const planejamentoQuery = z.object({ planejamento_id: z.coerce.number().int().positive().optional() });

// --- Painel de gestao de compras (a aba principal da planilha) ---------------

const painelQuery = z.object({
  metodo: z.enum(['PLANILHA', 'SISTEMA']).default('PLANILHA'),
  busca: z.string().trim().max(120).optional(),
  curva: z.enum(['A', 'B', 'C', 'SEM']).optional(),
  status: z.string().trim().max(40).optional(),
  situacao: z.enum(painel.SITUACOES).optional(),
  acompanhamento: z.enum(['ATRASADO', 'COBRAR']).optional(),
  fornecedor_id: z.coerce.number().int().positive().optional(),
  somente_comprar: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  pagina: z.coerce.number().int().min(1).default(1),
  limite: z.coerce.number().int().min(1).max(500).default(100),
});

planejamentoRouter.get('/painel', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', painelQuery);
  const r = await painel.painel(filtro);
  return ok(res, { linhas: r.linhas, resumo: r.resumo }, 'Painel de gestao de compras', {
    total: r.total, pagina: filtro.pagina, limite: filtro.limite,
    paginas: Math.max(1, Math.ceil(r.total / filtro.limite)),
  });
}));

planejamentoRouter.patch('/painel/produtos/:id/situacao', PLANEJAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const { situacao } = validar(req, 'body', z.object({ situacao: z.enum(painel.SITUACOES) }));
  return ok(res, await painel.definirSituacao(id, situacao), 'Situacao de compra atualizada');
}));

const dias = z.coerce.number().int().min(0).max(365).nullable().optional();
const politicaSchema = z.object({
  escopo: z.enum(['GLOBAL', 'CURVA', 'FORNECEDOR', 'PRODUTO']),
  curva: z.enum(['A', 'B', 'C']).nullable().optional(),
  fornecedor_id: z.coerce.number().int().positive().nullable().optional(),
  produto_codigo: z.string().trim().max(60).nullable().optional(),
  horizonte_dias: z.coerce.number().int().min(1).max(365).nullable().optional(),
  estoque_minimo_dias: dias,
  lead_time_dias: dias,
  observacao: z.string().trim().max(500).nullable().optional(),
});

planejamentoRouter.get('/politicas', LER, rota(async (_req, res) =>
  ok(res, await painel.listarPoliticas(), 'Politicas de compra')));

planejamentoRouter.put('/politicas', PARAMETRIZAR, rota(async (req, res) => {
  const dados = validar(req, 'body', politicaSchema);
  return ok(res, await painel.salvarPolitica(dados, contexto(req)), 'Politica de compra salva');
}));

planejamentoRouter.delete('/politicas/:id', PARAMETRIZAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  await painel.removerPolitica(id);
  return ok(res, { id }, 'Politica de compra removida');
}));

// --- Dashboard e visoes -----------------------------------------------------

planejamentoRouter.get('/dashboard', LER, rota(async (req, res) => {
  const { planejamento_id } = validar(req, 'query', planejamentoQuery);
  return ok(res, await visoes.dashboard(planejamento_id), 'Dashboard de compras');
}));

planejamentoRouter.get('/fornecedores', LER, rota(async (req, res) => {
  const { planejamento_id } = validar(req, 'query', planejamentoQuery);
  return ok(res, await visoes.porFornecedor(planejamento_id), 'Compras por fornecedor');
}));

planejamentoRouter.get('/consolidacao', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', planejamentoQuery.extend({
    criterio: z.enum(['FORNECEDOR', 'CATEGORIA', 'LOCAL', 'DATA_IDEAL', 'SEMANA', 'ORIGEM', 'MOEDA'])
      .default('FORNECEDOR'),
  }));
  return ok(res, await visoes.consolidar(filtro.criterio, filtro.planejamento_id), 'Consolidacao de compras');
}));

planejamentoRouter.get('/calendario', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', calendarioComprasSchema);
  return ok(res, await visoes.calendario(filtro.dias, filtro.planejamento_id, filtro.limite), 'Calendario de compras');
}));

planejamentoRouter.get('/prioritarias', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', paginacaoSchema.merge(planejamentoQuery));
  const { dados, meta } = await visoes.prioritarias(filtro, filtro.planejamento_id);
  return ok(res, dados, 'Compras prioritarias', meta);
}));

planejamentoRouter.get('/em-aberto', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', paginacaoSchema);
  const { dados, meta } = await visoes.comprasEmAberto(filtro);
  return ok(res, dados, 'Compras em aberto', meta);
}));

planejamentoRouter.get('/impacto-financeiro', LER, rota(async (req, res) => {
  const { planejamento_id } = validar(req, 'query', planejamentoQuery);
  return ok(res, await visoes.impactoFinanceiro(planejamento_id), 'Impacto financeiro do planejamento');
}));

planejamentoRouter.get('/acuracidade', LER, rota(async (_req, res) =>
  ok(res, await visoes.acuracidade(), 'Acuracidade do planejamento')));

// --- Planejamentos ----------------------------------------------------------

planejamentoRouter.post('/planejamentos', PLANEJAR, rota(async (req, res) => {
  const entrada = validar(req, 'body', executarPlanejamentoSchema);
  return criado(res, await plan.executarPlanejamento(entrada, contexto(req)), 'Planejamento calculado');
}));

planejamentoRouter.get('/planejamentos', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', paginacaoSchema);
  const { dados, meta } = await plan.listarPlanejamentos(filtro);
  return ok(res, dados, 'Planejamentos de compra', meta);
}));

planejamentoRouter.get('/planejamentos/comparar', LER, rota(async (req, res) => {
  const { atual, anterior } = validar(req, 'query', z.object({
    atual: z.coerce.number().int().positive(),
    anterior: z.coerce.number().int().positive(),
  }));
  return ok(res, await visoes.compararPlanejamentos(atual, anterior), 'Planejamento atual x anterior');
}));

planejamentoRouter.get('/planejamentos/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await visoes.historicoPlanejamento(id), 'Historico do planejamento');
}));

// --- Parametros de estoque --------------------------------------------------

planejamentoRouter.post('/parametros/recalcular', PLANEJAR, rota(async (req, res) => {
  const entrada = validar(req, 'body', recalcularParametrosSchema);
  return ok(res, await plan.recalcularParametros(entrada, contexto(req)), 'Parametros de estoque recalculados');
}));

planejamentoRouter.get('/parametros', LER, rota(async (_req, res) =>
  ok(res, await visoes.listarParametros(), 'Parametros do planejamento')));

planejamentoRouter.put('/parametros', PARAMETRIZAR, rota(async (req, res) => {
  const valores = validar(req, 'body', parametrosSchema);
  const chaves = Object.keys(valores);
  const { rows } = await query<{ chave: string }>(
    "SELECT chave FROM configuracoes WHERE grupo = 'planejamento' AND chave = ANY($1)", [chaves]);
  const validas = new Set(rows.map((r) => r.chave));
  const invalidas = chaves.filter((c) => !validas.has(c));
  if (invalidas.length) throw regraNegocio(`Parametro nao reconhecido - ${invalidas.join(', ')}`);

  for (const chave of chaves) {
    await query('UPDATE configuracoes SET valor = $2, updated_by = $3, updated_at = now() WHERE chave = $1',
      [chave, String(valores[chave]), req.usuario?.id ?? null]);
  }
  return ok(res, await visoes.listarParametros(), 'Parametros atualizados');
}));

// --- Necessidades -----------------------------------------------------------

planejamentoRouter.get('/necessidades', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarNecessidadesSchema);
  const { dados, meta } = await plan.listarNecessidades(filtro);
  return ok(res, dados, 'Necessidades de compra', meta);
}));

planejamentoRouter.get('/necessidades/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await plan.detalharNecessidade(id), 'Necessidade de compra');
}));

planejamentoRouter.post('/necessidades/:id/analisar', PLANEJAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await plan.analisarNecessidade(id, contexto(req)), 'Necessidade em analise');
}));

planejamentoRouter.post('/necessidades/:id/aprovar', APROVAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const { justificativa } = validar(req, 'body', decidirNecessidadeSchema);
  return ok(res, await plan.aprovarNecessidade(id, justificativa, contexto(req)), 'Necessidade aprovada');
}));

planejamentoRouter.post('/necessidades/:id/rejeitar', APROVAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const { justificativa } = validar(req, 'body', decidirNecessidadeSchema);
  return ok(res, await plan.rejeitarNecessidade(id, justificativa, contexto(req)), 'Necessidade rejeitada');
}));

planejamentoRouter.post('/necessidades/:id/ajustar', PLANEJAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const entrada = validar(req, 'body', ajustarNecessidadeSchema);
  return ok(res, await plan.ajustarNecessidade(id, entrada, contexto(req)), 'Necessidade ajustada');
}));

planejamentoRouter.post('/necessidades/:id/cancelar', APROVAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const { justificativa } = validar(req, 'body', decidirNecessidadeSchema);
  return ok(res, await plan.cancelarNecessidade(id, justificativa, contexto(req)), 'Necessidade cancelada');
}));

// --- Simulacao --------------------------------------------------------------

planejamentoRouter.post('/simulacoes', SIMULAR, rota(async (req, res) => {
  const entrada = validar(req, 'body', simularSchema);
  return criado(res, await simulacao.simular(entrada, contexto(req)), 'Cenario simulado');
}));

planejamentoRouter.get('/simulacoes', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', paginacaoSchema);
  const { dados, meta } = await simulacao.listarSimulacoes(filtro);
  return ok(res, dados, 'Simulacoes de compra', meta);
}));

planejamentoRouter.get('/simulacoes/comparar', LER, rota(async (req, res) => {
  const { ids } = validar(req, 'query', compararSimulacoesSchema);
  const lista = ids.split(',').map((i) => Number(i.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return ok(res, await simulacao.compararSimulacoes(lista), 'Comparacao de cenarios');
}));

planejamentoRouter.get('/simulacoes/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const filtro = validar(req, 'query', paginacaoSchema);
  const resultado = await simulacao.detalharSimulacao(id, filtro);
  return ok(res, resultado.itens, 'Itens da simulacao', {
    ...resultado.meta, simulacao: resultado.simulacao,
  });
}));

planejamentoRouter.delete('/simulacoes/:id', SIMULAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await simulacao.excluirSimulacao(id, contexto(req)), 'Simulacao excluida');
}));

// --- Requisicoes ------------------------------------------------------------

planejamentoRouter.post('/requisicoes', REQUISITAR, rota(async (req, res) => {
  const entrada = validar(req, 'body', criarRequisicaoSchema);
  return criado(res, await requisicao.criarRequisicao(entrada, contexto(req)), 'Requisicao de compra criada');
}));

planejamentoRouter.post('/requisicoes/gerar-por-fornecedor', REQUISITAR, rota(async (req, res) => {
  const { planejamento_id } = validar(req, 'body', z.object({
    planejamento_id: z.coerce.number().int().positive(),
  }));
  return criado(res, await requisicao.gerarRequisicoesPorFornecedor(planejamento_id, contexto(req)),
    'Requisicoes geradas por fornecedor');
}));

planejamentoRouter.get('/requisicoes', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', paginacaoSchema.extend({
    status: z.enum(['RASCUNHO', 'AGUARDANDO_APROVACAO', 'APROVADA', 'REJEITADA',
      'ENVIADA_COTACAO', 'ATENDIDA', 'CANCELADA']).optional(),
    fornecedor_id: z.coerce.number().int().positive().optional(),
  }));
  const { dados, meta } = await requisicao.listarRequisicoes(filtro);
  return ok(res, dados, 'Requisicoes de compra', meta);
}));

planejamentoRouter.get('/requisicoes/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await requisicao.detalharRequisicao(id), 'Requisicao de compra');
}));

planejamentoRouter.post('/requisicoes/:id/aprovar', APROVAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  return ok(res, await requisicao.aprovarRequisicao(id, req.usuario!.perfil, contexto(req)),
    'Requisicao aprovada');
}));

planejamentoRouter.post('/requisicoes/:id/rejeitar', APROVAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const { motivo } = validar(req, 'body', decidirRequisicaoSchema);
  return ok(res, await requisicao.rejeitarRequisicao(id, motivo, contexto(req)), 'Requisicao rejeitada');
}));

planejamentoRouter.post('/requisicoes/:id/cancelar', REQUISITAR, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const { motivo } = validar(req, 'body', decidirRequisicaoSchema);
  return ok(res, await requisicao.cancelarRequisicao(id, motivo, contexto(req)), 'Requisicao cancelada');
}));

// --- Alcadas ----------------------------------------------------------------

planejamentoRouter.get('/alcadas', LER, rota(async (_req, res) =>
  ok(res, await visoes.listarAlcadas(), 'Alcadas de aprovacao')));

planejamentoRouter.post('/alcadas', PARAMETRIZAR, rota(async (req, res) => {
  const entrada = validar(req, 'body', alcadaSchema);
  const { rows } = await query(`
    INSERT INTO alcadas_aprovacao (nome, perfil_id, valor_minimo, valor_maximo, ordem, ativo)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (nome) DO UPDATE SET
      perfil_id = EXCLUDED.perfil_id, valor_minimo = EXCLUDED.valor_minimo,
      valor_maximo = EXCLUDED.valor_maximo, ordem = EXCLUDED.ordem, ativo = EXCLUDED.ativo
    RETURNING *`,
    [entrada.nome, entrada.perfil_id, entrada.valor_minimo, entrada.valor_maximo ?? null,
      entrada.ordem, entrada.ativo]);
  return criado(res, rows[0], 'Alcada registrada');
}));
