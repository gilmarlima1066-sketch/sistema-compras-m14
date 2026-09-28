/**
 * Rotas do modulo 13 (secoes 34 a 40).
 *
 * Permissoes (secao 36):
 *   automacao.ler          consultar eventos, regras, execucoes, monitoramento
 *   automacao.tarefa       assumir e concluir tarefas
 *   automacao.aprovar      decidir aprovacoes e excecoes
 *   automacao.executar     disparar jobs, detectores e acoes manualmente
 *   automacao.regra        criar e editar regras
 *   automacao.reprocessar  mexer na fila e na fila morta
 *   automacao.integracao   configurar integracoes e segredos
 *   automacao.operacao     centro de operacoes e diagnostico
 *
 * Duas notas sobre o desenho:
 *
 * 1. O webhook de entrada NAO passa por `autenticar`. Ele nao tem usuario -
 *    quem chama e um sistema externo. A autenticacao dele e a assinatura HMAC,
 *    verificada dentro do servico. Por isso ele e montado em um router separado,
 *    antes do `use(autenticar)`: deixa-lo no router autenticado o tornaria
 *    inalcancavel, e mover o `autenticar` para depois abriria as outras rotas.
 *
 * 2. Permissao extra e checada DENTRO do handler, nunca encadeando dois
 *    `exigirPermissao`. Aquele middleware sinaliza negativa com `next(erro)`, e
 *    o handler seguinte rodaria mesmo apos a negativa - foi assim que um furo
 *    apareceu no modulo 10.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ok, criado, rota } from '../../core/http.js';
import { regraNegocio, semPermissao } from '../../core/errors.js';
import { validar as validarEntrada } from '../../core/validate.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import { query } from '../../config/database.js';
import * as acoes from './acoes.service.js';
import * as aprovacoes from './aprovacoes.service.js';
import * as configAutomacao from './config.js';
import * as detectores from './detectores.service.js';
import * as eventos from './eventos.service.js';
import * as fila from './fila.service.js';
import * as jobs from './jobs.service.js';
import * as monitor from './monitoramento.service.js';
import * as motor from './motor.service.js';
import * as notificacoes from './notificacoes.service.js';
import * as regras from './regras.service.js';
import * as sla from './sla.service.js';
import * as tarefas from './tarefas.service.js';
import * as webhooks from './webhooks.service.js';
import {
  alternarSchema, aprovarSchema, atualizarRegraSchema, cancelarSchema,
  codigoParam, concluirTarefaSchema, configuracaoSchema, correlationParam,
  criarRegraSchema, criarTarefaSchema, decidirSchema, executarAcaoSchema,
  historicoJobSchema, idParam, listarAprovacoesSchema, listarEventosSchema,
  listarFilaSchema, listarNotificacoesSchema, listarRegrasSchema,
  listarTarefasSchema, listarWebhooksSchema, periodoSchema, processarSchema,
  reatribuirSchema, registrarEventoSchema, rodarDetectoresSchema, segredoSchema,
  simularRegraSchema, solicitarAprovacaoSchema, webhookSchema,
} from './automacao.schemas.js';

const LER = exigirPermissao('automacao.ler');
const TAREFA = exigirPermissao('automacao.tarefa');
const APROVAR = exigirPermissao('automacao.aprovar');
const EXECUTAR = exigirPermissao('automacao.executar');
const REGRA = exigirPermissao('automacao.regra');
const REPROCESSAR = exigirPermissao('automacao.reprocessar');
const INTEGRACAO = exigirPermissao('automacao.integracao');
const OPERACAO = exigirPermissao('automacao.operacao');

interface Req {
  usuario?: { id: number; perfil?: string; permissoes?: string[] };
  ip?: string;
}

const contexto = (req: Req) => ({
  usuarioId: req.usuario?.id ?? null,
  ip: req.ip ?? null,
});

const usuarioId = (req: Req): number => {
  const id = req.usuario?.id;
  if (!id) throw semPermissao('Operacao exige usuario autenticado');
  return id;
};

// ===========================================================================
// Webhook de entrada: sem autenticacao de usuario, com assinatura HMAC
// ===========================================================================

export const webhookRouter = Router();

webhookRouter.post('/:codigo', rota(async (req, res) => {
  const { codigo } = validarEntrada(req, 'params', codigoParam);
  const corpo = validarEntrada(req, 'body', webhookSchema) as Record<string, unknown>;

  const cabecalhos = req.headers as unknown as Record<string, string>;

  const resultado = await webhooks.receber({
    integracao: codigo,
    evento: typeof corpo.evento === 'string' ? corpo.evento : null,
    payload: corpo,
    cabecalhos,
    assinatura: cabecalhos['x-assinatura'] ?? cabecalhos['x-signature'] ?? null,
    // A assinatura e sobre o corpo CRU. `rawBody` e preenchido pelo verify do
    // express.json; sem ele, reserializar o JSON mudaria a ordem das chaves e a
    // assinatura nunca conferiria.
    corpo_bruto: (req as unknown as { rawBody?: string }).rawBody,
    chave_idempotencia: typeof corpo.chave_idempotencia === 'string'
      ? corpo.chave_idempotencia : null,
    timestamp: typeof corpo.timestamp === 'string' ? corpo.timestamp : null,
    ip: req.ip ?? null,
  }, { usuarioId: null, ip: req.ip ?? null });

  // 202 para aceito, 400 para recusado: o parceiro precisa saber se deve
  // reenviar. 200 para tudo faria um webhook rejeitado parecer entregue.
  //
  // O envelope e o mesmo do resto da API (`success`, `data`, `message`), e nao
  // um formato proprio: quem consome esta rota tambem consome as outras, e duas
  // convencoes de resposta no mesmo servico sao uma armadilha silenciosa.
  res.status(resultado.aceito ? 202 : 400).json({
    success: resultado.aceito,
    data: resultado,
    message: resultado.motivo ?? 'Webhook recebido',
  });
}));

// ===========================================================================
// Router principal
// ===========================================================================

export const automacaoRouter = Router();
automacaoRouter.use(autenticar);

// ---------------------------------------------------------------------------
// Centro de operacoes (secoes 34, 39 e 40)
// ---------------------------------------------------------------------------

automacaoRouter.get('/operacao/painel', OPERACAO, rota(async (_req, res) => {
  ok(res, await monitor.painel());
}));

automacaoRouter.get('/operacao/diagnostico', OPERACAO, rota(async (_req, res) => {
  ok(res, await monitor.diagnostico());
}));

automacaoRouter.get('/operacao/serie', OPERACAO, rota(async (req, res) => {
  const { dias } = validarEntrada(req, 'query', periodoSchema);
  ok(res, await monitor.serie(dias ?? 14));
}));

automacaoRouter.get('/operacao/regras-desempenho', OPERACAO, rota(async (req, res) => {
  const { dias } = validarEntrada(req, 'query', periodoSchema);
  ok(res, await monitor.desempenhoRegras(dias ?? 30));
}));

automacaoRouter.get('/operacao/efeito', OPERACAO, rota(async (req, res) => {
  const { dias } = validarEntrada(req, 'query', periodoSchema);
  ok(res, await monitor.efeito(dias ?? 30));
}));

automacaoRouter.get('/operacao/configuracoes', OPERACAO, rota(async (_req, res) => {
  const { rows } = await query(`
    SELECT chave, valor, tipo::text AS tipo, descricao
      FROM configuracoes WHERE grupo = 'automacao' AND ativo ORDER BY chave`);
  ok(res, rows);
}));

automacaoRouter.put('/operacao/configuracoes/:codigo', OPERACAO, rota(async (req, res) => {
  const { codigo } = validarEntrada(req, 'params', codigoParam);
  const { valor } = validarEntrada(req, 'body', configuracaoSchema);

  const { rowCount } = await query(`
    UPDATE configuracoes SET valor = $2, updated_at = now()
     WHERE chave = $1 AND grupo = 'automacao'`, [codigo, valor]);
  if (!rowCount) throw regraNegocio(`Configuracao ${codigo} nao existe no grupo automacao`);

  // Invalida o cache na hora: quem acabou de salvar espera ver o efeito agora,
  // nao daqui a trinta segundos.
  configAutomacao.invalidar();
  sla.invalidar();
  ok(res, { chave: codigo, valor }, 'Configuracao atualizada');
}));

// ---------------------------------------------------------------------------
// Eventos (secoes 6, 7 e 35)
// ---------------------------------------------------------------------------

automacaoRouter.get('/eventos', LER, rota(async (req, res) => {
  ok(res, await eventos.listar(validarEntrada(req, 'query', listarEventosSchema)));
}));

automacaoRouter.get('/eventos/tipos', LER, rota(async (_req, res) => {
  ok(res, eventos.catalogoTipos());
}));

automacaoRouter.post('/eventos', EXECUTAR, rota(async (req, res) => {
  const entrada = validarEntrada(req, 'body', registrarEventoSchema);
  criado(res, await eventos.registrar(entrada, contexto(req)));
}));

/** Linha do tempo de uma decisao (secao 35). */
automacaoRouter.get('/rastrear/:correlation_id', LER, rota(async (req, res) => {
  const { correlation_id: id } = validarEntrada(req, 'params', correlationParam);
  ok(res, await eventos.rastrear(id));
}));

// ---------------------------------------------------------------------------
// Regras (secoes 8 e 34)
// ---------------------------------------------------------------------------

automacaoRouter.get('/regras', LER, rota(async (req, res) => {
  ok(res, await regras.listar(validarEntrada(req, 'query', listarRegrasSchema)));
}));

automacaoRouter.get('/regras/acoes', LER, rota(async (_req, res) => {
  ok(res, acoes.catalogo());
}));

automacaoRouter.post('/regras', REGRA, rota(async (req, res) => {
  const entrada = validarEntrada(req, 'body', criarRegraSchema);
  criado(res, await regras.criar(entrada as never, usuarioId(req)));
}));

automacaoRouter.put('/regras/:id', REGRA, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const entrada = validarEntrada(req, 'body', atualizarRegraSchema);
  ok(res, await regras.atualizar(id, entrada as never, usuarioId(req)), 'Regra atualizada');
}));

/** Ensaio: mostra condicao por condicao, sem executar a acao (secao 34). */
automacaoRouter.post('/regras/:id/simular', LER, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const { payload } = validarEntrada(req, 'body', simularRegraSchema);
  ok(res, await regras.simular(id, payload));
}));

// ---------------------------------------------------------------------------
// Fila (secoes 23 e 24)
// ---------------------------------------------------------------------------

automacaoRouter.get('/fila', LER, rota(async (req, res) => {
  ok(res, await fila.listar(validarEntrada(req, 'query', listarFilaSchema)));
}));

automacaoRouter.get('/fila/estatisticas', LER, rota(async (_req, res) => {
  ok(res, await fila.estatisticas());
}));

automacaoRouter.post('/fila/processar', EXECUTAR, rota(async (req, res) => {
  const { lote } = validarEntrada(req, 'body', processarSchema);
  ok(res, await motor.processarFila(lote ?? 10, contexto(req)));
}));

/** Um ciclo inteiro: casa eventos com regras e executa o que enfileirou. */
automacaoRouter.post('/ciclo', EXECUTAR, rota(async (req, res) => {
  ok(res, await motor.ciclo(contexto(req)));
}));

automacaoRouter.post('/fila/:id/reprocessar', REPROCESSAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  ok(res, await fila.reprocessar(id, contexto(req)), 'Item devolvido a fila');
}));

automacaoRouter.post('/fila/:id/cancelar', REPROCESSAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  validarEntrada(req, 'body', cancelarSchema);
  ok(res, await fila.cancelar(id, contexto(req)), 'Item cancelado');
}));

/** Execucao avulsa, com as mesmas travas do fluxo normal (secao 34). */
automacaoRouter.post('/acoes/executar', EXECUTAR, rota(async (req, res) => {
  const entrada = validarEntrada(req, 'body', executarAcaoSchema);
  ok(res, await motor.executarAvulsa(entrada as never, contexto(req)));
}));

// ---------------------------------------------------------------------------
// Detectores (secao 12)
// ---------------------------------------------------------------------------

const GRUPOS: Record<string, string[]> = {
  critico: detectores.GRUPO_CRITICO,
  estoque: detectores.GRUPO_ESTOQUE,
  pedidos: detectores.GRUPO_PEDIDOS,
  fornecedores: detectores.GRUPO_FORNECEDORES,
  ia: detectores.GRUPO_IA,
  todos: Object.keys(detectores.CATALOGO),
};

automacaoRouter.get('/detectores', LER, rota(async (_req, res) => {
  ok(res, {
    detectores: Object.keys(detectores.CATALOGO),
    grupos: Object.fromEntries(Object.entries(GRUPOS)),
  });
}));

automacaoRouter.post('/detectores/rodar', EXECUTAR, rota(async (req, res) => {
  const { detectores: lista, grupo } = validarEntrada(req, 'body', rodarDetectoresSchema);
  const nomes = lista ?? GRUPOS[grupo ?? 'critico'] ?? detectores.GRUPO_CRITICO;
  ok(res, await detectores.rodarGrupo(nomes, contexto(req)));
}));

// ---------------------------------------------------------------------------
// Tarefas (secoes 17 a 20)
// ---------------------------------------------------------------------------

automacaoRouter.get('/tarefas', LER, rota(async (req, res) => {
  ok(res, await tarefas.listar(validarEntrada(req, 'query', listarTarefasSchema)));
}));

automacaoRouter.get('/tarefas/resumo', LER, rota(async (_req, res) => {
  ok(res, await tarefas.resumo());
}));

/** A fila de quem esta pedindo: tarefas suas ou do seu perfil. */
automacaoRouter.get('/tarefas/minhas', LER, rota(async (req, res) => {
  const { rows } = await query<{ perfil: string }>(
    'SELECT p.nome AS perfil FROM usuarios u JOIN perfis p ON p.id = u.perfil_id WHERE u.id = $1',
    [usuarioId(req)]);

  // O limite e pequeno de proposito. Esta e a tela que a pessoa abre para
  // COMECAR o dia, e a ordenacao do servico ja traz o mais urgente na frente:
  // as dez primeiras sao o que ela consegue atacar agora. A fila inteira -
  // que pode ter centenas de linhas - vive na aba de listagem, em tabela, que
  // e a forma certa de olhar volume. Despejar tudo aqui em cartoes nao
  // informa mais, so empurra o resto para fora da tela.
  const RECORTE = 10;

  const proprias = await tarefas.listar({
    responsavel_id: usuarioId(req), abertas: true, limite: RECORTE,
  });
  const doPerfil = await tarefas.listar({
    perfil_destino: rows[0]?.perfil, abertas: true, status: 'PENDENTE', limite: RECORTE * 3,
  });

  // Tarefa ja atribuida a outra pessoa nao entra na lista do perfil: ela tem
  // dono, e aparecer aqui faria duas pessoas trabalharem no mesmo caso.
  const semDono = doPerfil.tarefas.filter(
    (t) => (t as unknown as { responsavel: string | null }).responsavel === null);

  ok(res, {
    perfil: rows[0]?.perfil ?? null,
    minhas: proprias.tarefas,
    minhas_total: proprias.total,
    disponiveis_do_perfil: semDono.slice(0, RECORTE),
    disponiveis_total: doPerfil.total,
    recorte: RECORTE,
    total: proprias.total + doPerfil.total,
  });
}));

automacaoRouter.get('/tarefas/:id', LER, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  ok(res, await tarefas.obter(id));
}));

automacaoRouter.post('/tarefas', TAREFA, rota(async (req, res) => {
  const entrada = validarEntrada(req, 'body', criarTarefaSchema);
  criado(res, await tarefas.criar({
    ...entrada,
    origem: `manual:${usuarioId(req)}`,
  }, contexto(req)));
}));

automacaoRouter.post('/tarefas/:id/assumir', TAREFA, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  await tarefas.assumir(id, usuarioId(req));
  ok(res, { id }, 'Tarefa assumida');
}));

automacaoRouter.post('/tarefas/:id/concluir', TAREFA, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const { observacao } = validarEntrada(req, 'body', concluirTarefaSchema);
  ok(res, await tarefas.concluir(id, usuarioId(req), observacao ?? null), 'Tarefa concluida');
}));

automacaoRouter.post('/tarefas/:id/cancelar', TAREFA, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const { motivo } = validarEntrada(req, 'body', cancelarSchema);
  await tarefas.cancelar(id, usuarioId(req), motivo);
  ok(res, { id }, 'Tarefa cancelada');
}));

automacaoRouter.post('/tarefas/:id/reatribuir', TAREFA, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const { responsavel_id: responsavel, perfil_destino: perfil } =
    validarEntrada(req, 'body', reatribuirSchema);
  await tarefas.reatribuir(id, responsavel ?? null, perfil ?? null);
  ok(res, { id }, 'Tarefa reatribuida');
}));

automacaoRouter.post('/tarefas/varrer-sla', EXECUTAR, rota(async (req, res) => {
  ok(res, await tarefas.varrerSla(contexto(req)));
}));

// ---------------------------------------------------------------------------
// SLA (secoes 19 a 21)
// ---------------------------------------------------------------------------

automacaoRouter.get('/sla/politicas', LER, rota(async (_req, res) => {
  ok(res, await sla.listar());
}));

automacaoRouter.get('/sla/desempenho', LER, rota(async (req, res) => {
  const { dias } = validarEntrada(req, 'query', periodoSchema);
  ok(res, await sla.desempenho(dias ?? 30));
}));

// ---------------------------------------------------------------------------
// Aprovacoes (secoes 14 a 16)
// ---------------------------------------------------------------------------

automacaoRouter.get('/aprovacoes', LER, rota(async (req, res) => {
  ok(res, await aprovacoes.listar(validarEntrada(req, 'query', listarAprovacoesSchema)));
}));

automacaoRouter.get('/aprovacoes/resumo', LER, rota(async (_req, res) => {
  ok(res, await aprovacoes.resumo());
}));

automacaoRouter.get('/aprovacoes/minha-fila', APROVAR, rota(async (req, res) => {
  ok(res, await aprovacoes.minhaFila(usuarioId(req)));
}));

automacaoRouter.get('/aprovacoes/:id', LER, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  ok(res, await aprovacoes.obter(id));
}));

automacaoRouter.post('/aprovacoes', LER, rota(async (req, res) => {
  const entrada = validarEntrada(req, 'body', solicitarAprovacaoSchema);
  criado(res, await aprovacoes.solicitar({
    ...entrada,
    solicitante_id: usuarioId(req),
  }, contexto(req)));
}));

automacaoRouter.post('/aprovacoes/:id/aprovar', APROVAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const { justificativa } = validarEntrada(req, 'body', aprovarSchema);
  ok(res, await aprovacoes.aprovar(id, usuarioId(req), justificativa ?? null, contexto(req)),
    'Aprovacao registrada');
}));

automacaoRouter.post('/aprovacoes/:id/rejeitar', APROVAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const { justificativa } = validarEntrada(req, 'body', decidirSchema);
  ok(res, await aprovacoes.rejeitar(id, usuarioId(req), justificativa, contexto(req)),
    'Rejeicao registrada');
}));

automacaoRouter.post('/aprovacoes/:id/dispensar', APROVAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const { justificativa } = validarEntrada(req, 'body', decidirSchema);
  ok(res, await aprovacoes.dispensar(id, usuarioId(req), justificativa, contexto(req)),
    'Solicitacao dispensada');
}));

// ---------------------------------------------------------------------------
// Jobs (secoes 29 a 31)
// ---------------------------------------------------------------------------

automacaoRouter.get('/jobs', LER, rota(async (_req, res) => {
  ok(res, await jobs.listar());
}));

automacaoRouter.get('/jobs/historico', LER, rota(async (req, res) => {
  const { codigo, limite } = validarEntrada(req, 'query', historicoJobSchema);
  ok(res, await jobs.historico(codigo, limite ?? 50));
}));

automacaoRouter.post('/jobs/:codigo/executar', EXECUTAR, rota(async (req, res) => {
  const { codigo } = validarEntrada(req, 'params', codigoParam);
  ok(res, await jobs.executar(codigo, contexto(req), `MANUAL:${usuarioId(req)}`));
}));

automacaoRouter.post('/jobs/:codigo/ativo', EXECUTAR, rota(async (req, res) => {
  const { codigo } = validarEntrada(req, 'params', codigoParam);
  const { ativo } = validarEntrada(req, 'body', alternarSchema);
  await jobs.alternarAtivo(codigo, ativo);
  ok(res, { codigo, ativo }, ativo ? 'Job ativado' : 'Job desativado');
}));

automacaoRouter.post('/jobs/rodar-devidos', EXECUTAR, rota(async (req, res) => {
  ok(res, await jobs.rodarDevidos(contexto(req)));
}));

automacaoRouter.post('/jobs/reagendar', EXECUTAR, rota(async (_req, res) => {
  ok(res, { reagendados: await jobs.reagendarTodos() }, 'Agenda recalculada');
}));

// ---------------------------------------------------------------------------
// Integracoes e webhooks recebidos (secoes 37 e 38)
// ---------------------------------------------------------------------------

automacaoRouter.get('/integracoes', LER, rota(async (_req, res) => {
  ok(res, await webhooks.listarIntegracoes());
}));

automacaoRouter.post('/integracoes/:codigo/segredo', INTEGRACAO, rota(async (req, res) => {
  const { codigo } = validarEntrada(req, 'params', codigoParam);
  const { segredo } = validarEntrada(req, 'body', segredoSchema);
  const resultado = await webhooks.definirSegredo(codigo, segredo);
  ok(res, resultado,
    'Segredo definido. O valor em claro nao e guardado: anote-o agora, '
    + 'porque nem o sistema podera recupera-lo depois');
}));

automacaoRouter.post('/integracoes/:codigo/ativo', INTEGRACAO, rota(async (req, res) => {
  const { codigo } = validarEntrada(req, 'params', codigoParam);
  const { ativo } = validarEntrada(req, 'body', alternarSchema);
  await webhooks.alternarIntegracao(codigo, ativo);
  ok(res, { codigo, ativo });
}));

automacaoRouter.get('/webhooks', LER, rota(async (req, res) => {
  ok(res, await webhooks.listarRecebidos(validarEntrada(req, 'query', listarWebhooksSchema)));
}));

automacaoRouter.get('/webhooks/:id', LER, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  ok(res, await webhooks.obterRecebido(id));
}));

// ---------------------------------------------------------------------------
// Notificacoes (secoes 25 a 28)
// ---------------------------------------------------------------------------

automacaoRouter.get('/notificacoes', rota(async (req, res) => {
  const filtro = validarEntrada(req, 'query', listarNotificacoesSchema);
  // Sem permissao especial: cada um ve as suas, e o filtro por usuario e
  // aplicado aqui, nao aceito do cliente.
  ok(res, await notificacoes.listar({ ...filtro, usuario_id: usuarioId(req) }));
}));

automacaoRouter.get('/notificacoes/nao-lidas', rota(async (req, res) => {
  ok(res, { total: await notificacoes.naoLidas(usuarioId(req)) });
}));

automacaoRouter.post('/notificacoes/:id/lida', rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const marcou = await notificacoes.marcarLida(id, usuarioId(req));
  ok(res, { id, marcada: marcou },
    marcou ? 'Notificacao marcada como lida' : 'Notificacao ja estava lida ou nao e sua');
}));

automacaoRouter.post('/notificacoes/todas-lidas', rota(async (req, res) => {
  ok(res, { marcadas: await notificacoes.marcarTodasLidas(usuarioId(req)) });
}));

automacaoRouter.post('/notificacoes/despachar', EXECUTAR, rota(async (req, res) => {
  const { lote } = validarEntrada(req, 'body', z.object({
    lote: z.coerce.number().int().min(1).max(500).optional(),
  }));
  ok(res, await notificacoes.despachar(lote ?? 50));
}));
