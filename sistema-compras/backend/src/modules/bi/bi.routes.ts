/**
 * Rotas do modulo 11 (secao 63).
 *
 * Permissoes (secao 60):
 *   - bi.ler          dashboards operacionais, KPIs, series, drill-down;
 *   - bi.executivo    dashboard executivo e mapa de riscos;
 *   - bi.kpi          dicionario e governanca dos indicadores;
 *   - bi.meta         definir meta de indicador;
 *   - bi.alertas      central de alertas e tratativa;
 *   - bi.personalizar dashboards proprios.
 *
 * A checagem e do backend, nao da tela (secao 60): o frontend esconde o
 * painel executivo de quem nao tem a permissao, mas quem chamar a URL direto
 * tambem recebe 403. O dashboard executivo exige `bi.executivo` ALEM de
 * `bi.ler` - um comprador nao ve a visao da diretoria por adivinhar a rota.
 *
 * Rotas fixas antes das com ":codigo".
 */
import { Router } from 'express';
import { z } from 'zod';
import { ok, rota } from '../../core/http.js';
import { semPermissao } from '../../core/errors.js';
import { validar } from '../../core/validate.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import * as kpi from './kpi.service.js';
import * as paineis from './dashboards.service.js';
import * as drill from './drilldown.service.js';
import * as alertas from './alertas.service.js';
import type { FiltroGlobal } from './filtros.js';
import {
  avaliarRegrasSchema, compararSchema, drilldownSchema, filtroSchema, historicoSchema,
  listarAlertasSchema, listarKpisSchema, metaSchema, paretoSchema, serieSchema,
  tratarAlertaSchema,
} from './bi.schemas.js';

const LER = exigirPermissao('bi.ler');
const KPI = exigirPermissao('bi.kpi');
const META = exigirPermissao('bi.meta');
const ALERTAS = exigirPermissao('bi.alertas');

const contexto = (req: { usuario?: { id: number }; ip?: string }) => ({
  usuarioId: req.usuario?.id ?? null,
  ip: req.ip ?? null,
});

const codigoParam = z.object({ codigo: z.string().trim().min(1).max(60) });
const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Filtro global vindo da query string, ja tipado. */
const filtroDe = (req: Parameters<typeof validar>[0]): FiltroGlobal =>
  validar(req, 'query', filtroSchema) as FiltroGlobal;

/**
 * Painel executivo exige a permissao extra.
 *
 * Nao encadeamos `exigirPermissao` como callback aqui: aquele middleware
 * sinaliza negativa por `next(erro)`, entao o handler seguinte rodaria mesmo
 * apos a negativa. A checagem e feita dentro do proprio handler.
 */
const exigirExecutivo = (req: { usuario?: { permissoes?: string[] } }) => {
  const permissoes = req.usuario?.permissoes ?? [];
  if (!permissoes.includes('bi.executivo') && !permissoes.includes('*')) {
    throw semPermissao('Acesso ao painel executivo exige a permissao bi.executivo');
  }
};

// ===========================================================================
// Dashboards - secao 63
// ===========================================================================

export const dashboardBiRouter = Router();
dashboardBiRouter.use(autenticar);

dashboardBiRouter.get('/paineis', LER, rota(async (req, res) => {
  const perfil = (req.usuario as { perfil?: string } | undefined)?.perfil;
  ok(res, await paineis.listarDashboards(perfil));
}));

dashboardBiRouter.get('/executivo', LER, rota(async (req, res) => {
  exigirExecutivo(req);
  ok(res, await paineis.montar('EXECUTIVO', filtroDe(req)));
}));

for (const painel of [
  'compras', 'estoque', 'demanda', 'fornecedores', 'logistica',
  'recebimento', 'qualidade', 'financeiro', 'importacoes', 'comprador',
]) {
  dashboardBiRouter.get(`/${painel}`, LER, rota(async (req, res) => {
    ok(res, await paineis.montar(painel.toUpperCase(), filtroDe(req)));
  }));
}

dashboardBiRouter.get('/riscos', LER, rota(async (req, res) => {
  exigirExecutivo(req);
  const filtro = filtroDe(req);
  const painel = await paineis.montar('RISCOS', filtro);
  ok(res, { ...painel, extras: { mapa: await paineis.mapaRiscos(filtro) } });
}));

dashboardBiRouter.get('/pareto', LER, rota(async (req, res) => {
  const { analise } = validar(req, 'query', paretoSchema);
  ok(res, await paineis.analisePareto(analise, filtroDe(req)));
}));

dashboardBiRouter.get('/pareto-analises', LER, rota(async (_req, res) => {
  ok(res, paineis.analisesPareto());
}));

dashboardBiRouter.get('/matriz-abc-xyz', LER, rota(async (req, res) => {
  ok(res, await paineis.matrizAbcXyz(filtroDe(req)));
}));

// --- Drill-down (secoes 43 a 46) -------------------------------------------

dashboardBiRouter.get('/drilldown-destinos', LER, rota(async (_req, res) => {
  ok(res, drill.destinos());
}));

dashboardBiRouter.get('/drilldown', LER, rota(async (req, res) => {
  const { destino } = validar(req, 'query', drilldownSchema);
  ok(res, await drill.executarDrilldown(destino, filtroDe(req)));
}));

/** Contexto de decisao (secao 72): reune o quadro, nao decide por ninguem. */
dashboardBiRouter.get('/contexto/:id', LER, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  ok(res, await drill.contextoDecisao(id));
}));

// ===========================================================================
// KPIs - secoes 9 a 12, 65 e 66
// ===========================================================================

export const kpisRouter = Router();
kpisRouter.use(autenticar);

kpisRouter.get('/', LER, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarKpisSchema);
  ok(res, await kpi.listarDefinicoes(filtro));
}));

/** Dicionario de indicadores (secao 66). Formula, fonte, dono e meta vigente. */
kpisRouter.get('/dicionario', KPI, rota(async (_req, res) => {
  ok(res, await kpi.dicionario());
}));

kpisRouter.get('/metas', KPI, rota(async (req, res) => {
  const codigo = typeof req.query.codigo === 'string' ? req.query.codigo : undefined;
  ok(res, await kpi.listarMetas(codigo));
}));

kpisRouter.post('/metas', META, rota(async (req, res) => {
  const entrada = validar(req, 'body', metaSchema);
  ok(res, await kpi.definirMeta(entrada, contexto(req)), 'Meta definida');
}));

/** Varios KPIs na mesma chamada, com o mesmo filtro (secao 62). */
kpisRouter.get('/comparar', LER, rota(async (req, res) => {
  const { codigos } = validar(req, 'query', compararSchema);
  const lista = codigos.split(',').map((c) => c.trim()).filter(Boolean).slice(0, 30);
  ok(res, await kpi.apurarVarios(lista, filtroDe(req)));
}));

kpisRouter.get('/:codigo', LER, rota(async (req, res) => {
  const { codigo } = validar(req, 'params', codigoParam);
  ok(res, await kpi.apurar(codigo, filtroDe(req)));
}));

/** Periodo anterior e mesmo periodo do ano passado (secao 49). */
kpisRouter.get('/:codigo/comparacao', LER, rota(async (req, res) => {
  const { codigo } = validar(req, 'params', codigoParam);
  ok(res, await kpi.apurarComComparacao(codigo, filtroDe(req)));
}));

kpisRouter.get('/:codigo/serie', LER, rota(async (req, res) => {
  const { codigo } = validar(req, 'params', codigoParam);
  const { meses } = validar(req, 'query', serieSchema);
  ok(res, await kpi.serie(codigo, filtroDe(req), meses));
}));

/** Historico gravado (kpi_resultados), nao reapuracao. */
kpisRouter.get('/:codigo/historico', LER, rota(async (req, res) => {
  const { codigo } = validar(req, 'params', codigoParam);
  const { limite } = validar(req, 'query', historicoSchema);
  ok(res, await kpi.historico(codigo, limite));
}));

/** Congela a apuracao atual no historico. Nao altera dado operacional. */
kpisRouter.post('/:codigo/registrar', KPI, rota(async (req, res) => {
  const { codigo } = validar(req, 'params', codigoParam);
  ok(res, await kpi.registrar(codigo, filtroDe(req), contexto(req)),
    'Resultado registrado no historico');
}));

// ===========================================================================
// Central de alertas - secoes 40 a 42
// ===========================================================================

export const alertasBiRouter = Router();
alertasBiRouter.use(autenticar);

alertasBiRouter.get('/', ALERTAS, rota(async (req, res) => {
  const filtro = validar(req, 'query', listarAlertasSchema);
  ok(res, await alertas.listarAlertas(filtro));
}));

alertasBiRouter.get('/resumo', ALERTAS, rota(async (_req, res) => {
  ok(res, await alertas.resumoAlertas());
}));

alertasBiRouter.get('/regras', ALERTAS, rota(async (_req, res) => {
  ok(res, await alertas.listarRegras());
}));

/** Roda as regras e registra os alertas, deduplicando os ja abertos. */
alertasBiRouter.post('/avaliar', ALERTAS, rota(async (req, res) => {
  const { regra } = validar(req, 'body', avaliarRegrasSchema);
  ok(res, await alertas.avaliarRegras(filtroDe(req), contexto(req), regra),
    'Regras avaliadas');
}));

alertasBiRouter.get('/:id', ALERTAS, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  ok(res, await alertas.obterAlerta(id));
}));

alertasBiRouter.patch('/:id/tratar', ALERTAS, rota(async (req, res) => {
  const { id } = validar(req, 'params', idParam);
  const corpo = validar(req, 'body', tratarAlertaSchema);
  ok(res, await alertas.tratarAlerta(
    id, corpo.status, contexto(req), corpo.observacao, corpo.responsavel_id),
  'Alerta atualizado');
}));
