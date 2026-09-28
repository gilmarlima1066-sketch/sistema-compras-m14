/**
 * Rotas do modulo 12 (secao 40).
 *
 * Permissoes (secao 38):
 *   - ia.ler         analises, recomendacoes, riscos, assistentes
 *   - ia.perguntar   Pergunte aos Dados
 *   - ia.sql         consulta SQL propria sob a guarda
 *   - ia.simular     simulacoes de cenario
 *   - ia.decidir     aceitar, rejeitar ou executar recomendacao
 *   - ia.executivo   Central de Decisao e resumo estrategico
 *   - ia.configurar  parametros e limiares
 *
 * Duas checagens diferentes convivem aqui, de proposito:
 *
 *   PERMISSAO decide se a rota abre. E feita pelo middleware.
 *   ESCOPO DE DADOS decide o que a resposta contem. E feito dentro do servico,
 *   pelo perfil, porque duas pessoas com `ia.ler` veem coisas diferentes
 *   (secao 38). Nenhum filtro depende do frontend.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ok, rota } from '../../core/http.js';
import { semPermissao } from '../../core/errors.js';
import { validar as validarEntrada } from '../../core/validate.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import { query } from '../../config/database.js';
import { carregarConfig, montarSessao } from './contexto.js';
import * as analise from './analise.service.js';
import * as rec from './recomendacoes.service.js';
import * as sim from './simulacao.service.js';
import * as dec from './decisao.service.js';
import * as perg from './pergunta.service.js';
import * as guarda from './sql-guard.js';
import { catalogo } from './consultas.js';
import { panoramaQualidade } from './qualidade.js';
import {
  analisarSchema, compararCenariosSchema, configuracaoSchema, consultaSqlSchema,
  decidirSchema, gerarRecomendacoesSchema, historicoSchema, limiteSchema,
  listarRecomendacoesSchema, perguntaSchema, simularSchema,
} from './ia.schemas.js';

const LER = exigirPermissao('ia.ler');
const PERGUNTAR = exigirPermissao('ia.perguntar');
const SQL = exigirPermissao('ia.sql');
const SIMULAR = exigirPermissao('ia.simular');
const DECIDIR = exigirPermissao('ia.decidir');
const CONFIGURAR = exigirPermissao('ia.configurar');

const contexto = (req: { usuario?: { id: number }; ip?: string }) => ({
  usuarioId: req.usuario?.id ?? null,
  ip: req.ip ?? null,
});

const sessao = (req: { usuario?: { id: number; perfil: string; permissoes: string[] };
  ip?: string }) => montarSessao(req.usuario, req.ip);

const idParam = z.object({ id: z.coerce.number().int().positive() });
const nomeParam = z.object({ nome: z.string().trim().min(2).max(40) });

/**
 * A Central de Decisao exige `ia.executivo` ALEM de `ia.ler`.
 *
 * A checagem e feita dentro do handler, nao encadeando `exigirPermissao` como
 * callback: aquele middleware sinaliza negativa por `next(erro)`, entao o
 * handler seguinte rodaria mesmo depois da negativa. Foi assim que um furo
 * apareceu no modulo 10.
 */
const exigirExecutivo = (req: { usuario?: { permissoes?: string[] } }) => {
  const permissoes = req.usuario?.permissoes ?? [];
  if (!permissoes.includes('ia.executivo') && !permissoes.includes('*')) {
    throw semPermissao('A Central de Decisao exige a permissao ia.executivo');
  }
};

export const iaRouter = Router();
iaRouter.use(autenticar);

// ===========================================================================
// Central de Decisao e resumo (secoes 30 e 44)
// ===========================================================================

iaRouter.get('/central-decisao', LER, rota(async (req, res) => {
  exigirExecutivo(req);
  const cfg = await carregarConfig();
  ok(res, await dec.centralDecisao(cfg, sessao(req)));
}));

iaRouter.get('/resumo-diario', LER, rota(async (req, res) => {
  exigirExecutivo(req);
  const cfg = await carregarConfig();
  ok(res, await dec.resumoDiario(cfg, sessao(req)));
}));

// ===========================================================================
// Assistentes (secoes 5 a 16)
// ===========================================================================

iaRouter.get('/assistentes', LER, rota(async (_req, res) => {
  ok(res, Object.entries(dec.ASSISTENTES).map(([codigo, a]) => ({
    codigo, titulo: a.titulo, dominio: a.dominio,
  })));
}));

iaRouter.get('/assistentes/:nome', LER, rota(async (req, res) => {
  const { nome } = validarEntrada(req, 'params', nomeParam);
  const cfg = await carregarConfig();
  ok(res, await dec.assistente(nome, cfg, sessao(req)));
}));

// ===========================================================================
// Analises (secoes 8, 13, 14, 17, 18, 27 e 33)
// ===========================================================================

iaRouter.post('/analyze', LER, rota(async (req, res) => {
  const { tipo, limite, dias } = validarEntrada(req, 'body', analisarSchema);
  const cfg = await carregarConfig();
  const s = sessao(req);

  const resultado = await (async () => {
    switch (tipo) {
      case 'PRECO':
        return { tipo, ...(await analise.anomaliasPreco(cfg, limite)) };
      case 'FORNECEDOR':
        return { tipo, ...(await analise.anomaliasFornecedor(cfg, limite)) };
      case 'PREVISAO':
        return { tipo, ...(await analise.anomaliasPrevisao(cfg, limite)) };
      case 'CONCENTRACAO':
        return { tipo, ...(await analise.mapaConcentracao(cfg, dias ?? 365)) };
      case 'QUALIDADE':
        return { tipo, ...(await panoramaQualidade()) };
      default:
        return { tipo, ...(await analise.centralRiscos(cfg, limite)) };
    }
  })();

  ok(res, { ...resultado, perfil: s.perfil });
}));

iaRouter.get('/risks', LER, rota(async (req, res) => {
  const { limite } = validarEntrada(req, 'query', limiteSchema);
  const cfg = await carregarConfig();
  ok(res, await analise.centralRiscos(cfg, limite));
}));

iaRouter.get('/qualidade-dados', LER, rota(async (_req, res) => {
  ok(res, await panoramaQualidade());
}));

iaRouter.get('/lacunas', LER, rota(async (_req, res) => {
  ok(res, await analise.lacunasCadastro(10));
}));

// ===========================================================================
// Recomendacoes (secoes 20, 21, 31, 32 e 36)
// ===========================================================================

iaRouter.get('/recommendations', LER, rota(async (req, res) => {
  const filtro = validarEntrada(req, 'query', listarRecomendacoesSchema);
  ok(res, await rec.listar(filtro));
}));

iaRouter.get('/recommendations/resumo', LER, rota(async (_req, res) => {
  ok(res, await rec.resumo());
}));

/** Gera o lote. Nao executa nada: grava recomendacoes (secao 48). */
iaRouter.post('/recommendations/gerar', DECIDIR, rota(async (req, res) => {
  const { limite_produtos: limite } = validarEntrada(req, 'body', gerarRecomendacoesSchema);
  const cfg = await carregarConfig();
  ok(res, await rec.gerar(cfg, contexto(req), limite), 'Recomendacoes geradas');
}));

iaRouter.post('/recommendations/expirar', DECIDIR, rota(async (req, res) => {
  ok(res, await rec.expirarVencidas(contexto(req)), 'Recomendacoes vencidas expiradas');
}));

iaRouter.get('/recommendations/:id', LER, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  ok(res, await rec.detalhar(id));
}));

/** Decisao do usuario (secao 36). Muda o status; nao executa a acao. */
iaRouter.post('/recommendations/:id/feedback', DECIDIR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const corpo = validarEntrada(req, 'body', decidirSchema);
  ok(res, await rec.decidir(id, corpo.tipo, contexto(req), corpo.motivo, corpo.observacao),
    'Decisao registrada');
}));

// ===========================================================================
// Pergunte aos Dados (secoes 22, 23 e 24)
// ===========================================================================

iaRouter.post('/chat', PERGUNTAR, rota(async (req, res) => {
  const { pergunta, intencao } = validarEntrada(req, 'body', perguntaSchema);
  const cfg = await carregarConfig();
  ok(res, await perg.responder(pergunta, cfg, sessao(req), contexto(req), intencao));
}));

iaRouter.get('/exemplos', PERGUNTAR, rota(async (_req, res) => {
  ok(res, perg.exemplos());
}));

iaRouter.get('/catalogo', PERGUNTAR, rota(async (_req, res) => {
  ok(res, catalogo());
}));

/** SQL proprio, sob a guarda. So ADMIN e GESTOR_COMPRAS tem `ia.sql`. */
iaRouter.post('/query', SQL, rota(async (req, res) => {
  const { sql } = validarEntrada(req, 'body', consultaSqlSchema);
  const cfg = await carregarConfig();
  ok(res, await perg.consultaPropria(sql, cfg, sessao(req), contexto(req)));
}));

// ===========================================================================
// Simulacoes (secoes 28, 29 e 34)
// ===========================================================================

iaRouter.get('/cenarios', SIMULAR, rota(async (_req, res) => {
  ok(res, sim.listarCenarios());
}));

iaRouter.post('/simulate', SIMULAR, rota(async (req, res) => {
  const entrada = validarEntrada(req, 'body', simularSchema);
  const cfg = await carregarConfig();
  ok(res, await sim.simularCenario(entrada, cfg, contexto(req)), 'Simulacao concluida');
}));

iaRouter.post('/simulate/comparar', SIMULAR, rota(async (req, res) => {
  const entrada = validarEntrada(req, 'body', compararCenariosSchema);
  const cfg = await carregarConfig();
  const nomes = entrada.cenarios.split(',').map((c) => c.trim()).filter(Boolean).slice(0, 6);
  ok(res, await sim.compararCenarios(nomes, entrada, cfg, contexto(req)));
}));

iaRouter.get('/simulate/historico', SIMULAR, rota(async (req, res) => {
  const { limite } = validarEntrada(req, 'query', limiteSchema);
  ok(res, await sim.historico(limite));
}));

// ===========================================================================
// Governanca e seguranca (secoes 37 e 39)
// ===========================================================================

iaRouter.get('/seguranca', LER, rota(async (_req, res) => {
  ok(res, {
    ...guarda.estadoSeguranca(),
    autoteste: await guarda.verificarLeituraSomente(),
    tabelas_permitidas: guarda.tabelasPermitidas().length,
    comandos_bloqueados: guarda.comandosBloqueados(),
  });
}));

iaRouter.get('/history', LER, rota(async (req, res) => {
  const filtro = validarEntrada(req, 'query', historicoSchema);
  ok(res, await perg.historicoExecucoes(filtro));
}));

iaRouter.get('/config', LER, rota(async (_req, res) => {
  const { rows } = await query(`
    SELECT chave, valor, tipo::text AS tipo, descricao, updated_at
      FROM configuracoes WHERE grupo = 'ia' AND ativo ORDER BY chave`);
  ok(res, {
    configuracoes: rows,
    observacao: 'Toda alteracao fica registrada em auditoria, com autor, data, '
      + 'valor anterior e novo (secao 37).',
  });
}));

iaRouter.put('/config', CONFIGURAR, rota(async (req, res) => {
  const { chave, valor } = validarEntrada(req, 'body', configuracaoSchema);
  const { rows } = await query(`
    UPDATE configuracoes SET valor = $2, updated_by = $3, updated_at = now()
     WHERE chave = $1 AND grupo = 'ia'
    RETURNING chave, valor, descricao`, [chave, valor, req.usuario?.id ?? null]);
  if (!rows.length) {
    throw semPermissao(`Configuracao ${chave} nao existe no grupo ia`);
  }
  ok(res, rows[0], 'Configuracao atualizada');
}));
