/**
 * Rotas do modulo 14 (secao 39).
 *
 * Permissoes (secao 37):
 *   integracao.ler          consultar integracoes, execucoes, logs, monitoramento
 *   integracao.configurar   criar e editar integracoes, conectores e mapeamentos
 *   integracao.credencial   gerenciar credenciais e referencias seguras
 *   integracao.sincronizar  disparar sincronizacao e teste de conexao
 *   integracao.importar     enviar arquivo, mapear e confirmar importacao
 *   integracao.exportar     exportar dados
 *   integracao.reprocessar  reprocessar mensagens e dead letter
 *   integracao.conciliar    decidir divergencias
 *
 * A secao 39 propoe caminhos em ingles (`/api/integrations`). Aqui eles entram
 * em portugues, como o resto da API - a propria secao manda "adaptar as
 * convencoes ja existentes", e duas linguas no mesmo servico e uma armadilha
 * para quem for manter.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ok, criado, rota } from '../../core/http.js';
import { regraNegocio, semPermissao } from '../../core/errors.js';
import { validar as validarEntrada } from '../../core/validate.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import { query } from '../../config/database.js';
import * as conciliacao from './conciliacao.service.js';
import * as conector from './conector.js';
import * as configIntegracao from './config.js';
import * as credenciais from './credenciais.service.js';
import * as email from './email.service.js';
import * as exportacao from './exportacao.service.js';
import * as importacao from './importacao.service.js';
import * as mapeamento from './mapeamento.service.js';
import * as monitor from './monitoramento.service.js';
import * as normalizacao from './normalizacao.js';
import * as sincronizacao from './sincronizacao.service.js';
import './gravadores.js';
// Registra as rotinas dos jobs de integracao no agendador do modulo 13.
import './rotinas.js';
import {
  validarEndpoint,
  atualizarIntegracaoSchema, cancelarSchema, codigoParam, conciliarEstoqueSchema,
  configuracaoSchema, credencialSchema, criarIntegracaoSchema,
  decidirConciliacaoSchema, emailSchema, enviarSchema, errosSchema,
  execucoesSchema, exportarSchema, historicoExportacoesSchema, idParam,
  importarSchema, listarConciliacoesSchema, listarEmailsSchema,
  listarImportacoesSchema, mapearImportacaoSchema, mensagensSchema,
  ocorrenciasSchema, periodoSchema, resolverErroSchema, rotacionarSchema,
  sincronizarSchema, solicitacaoCotacaoSchema, sugerirSchema, templateSchema,
  testarSchema,
} from './integracao.schemas.js';

const LER = exigirPermissao('integracao.ler');
const CONFIGURAR = exigirPermissao('integracao.configurar');
const CREDENCIAL = exigirPermissao('integracao.credencial');
const SINCRONIZAR = exigirPermissao('integracao.sincronizar');
const IMPORTAR = exigirPermissao('integracao.importar');
const EXPORTAR = exigirPermissao('integracao.exportar');
const REPROCESSAR = exigirPermissao('integracao.reprocessar');
const CONCILIAR = exigirPermissao('integracao.conciliar');

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

export const integracaoRouter = Router();
integracaoRouter.use(autenticar);

// ===========================================================================
// Central de integracoes e monitoramento (secoes 5 e 33)
// ===========================================================================

integracaoRouter.get('/central', LER, rota(async (_req, res) => {
  ok(res, await monitor.central());
}));

integracaoRouter.get('/indicadores', LER, rota(async (req, res) => {
  const { dias } = validarEntrada(req, 'query', periodoSchema);
  ok(res, await monitor.indicadores(dias ?? 7));
}));

integracaoRouter.get('/serie', LER, rota(async (req, res) => {
  const { dias } = validarEntrada(req, 'query', periodoSchema);
  ok(res, await monitor.serie(dias ?? 14));
}));

integracaoRouter.get('/diagnostico', LER, rota(async (_req, res) => {
  ok(res, await monitor.diagnostico());
}));

integracaoRouter.get('/configuracoes', LER, rota(async (_req, res) => {
  const { rows } = await query(`
    SELECT chave, valor, tipo::text AS tipo, descricao
      FROM configuracoes WHERE grupo = 'integracao' AND ativo ORDER BY chave`);
  ok(res, rows);
}));

integracaoRouter.put('/configuracoes/:codigo', CONFIGURAR, rota(async (req, res) => {
  const { codigo } = validarEntrada(req, 'params', codigoParam);
  const { valor } = validarEntrada(req, 'body', configuracaoSchema);

  const { rowCount } = await query(`
    UPDATE configuracoes SET valor = $2, updated_at = now()
     WHERE chave = $1 AND grupo = 'integracao'`, [codigo, valor]);
  if (!rowCount) throw regraNegocio(`Configuracao ${codigo} nao existe no grupo integracao`);

  configIntegracao.invalidar();
  ok(res, { chave: codigo, valor }, 'Configuracao atualizada');
}));

// ===========================================================================
// Integracoes e conectores (secoes 6, 7 e 39)
// ===========================================================================

integracaoRouter.get('/', LER, rota(async (_req, res) => {
  const painel = await monitor.central();
  ok(res, painel.integracoes);
}));

integracaoRouter.get('/conectores', LER, rota(async (_req, res) => {
  ok(res, {
    tipos: ['REST', 'SOAP', 'BANCO_SQL', 'ARQUIVO', 'EMAIL', 'WEBHOOK', 'SFTP', 'MANUAL'],
    // Nem todo tipo esta implementado. Dizer o que falta e melhor do que
    // aceitar a configuracao e falhar so na primeira sincronizacao.
    implementados: ['REST', 'ARQUIVO', 'WEBHOOK', 'EMAIL', 'MANUAL'],
    pendentes: {
      SOAP: 'Envelope SOAP nao implementado; use REST quando o fornecedor oferecer',
      BANCO_SQL: 'Conexao a banco externo depende de driver e de rede liberada',
      SFTP: 'Transferencia por SFTP depende de biblioteca e de chave no servidor',
    },
    autenticacoes: ['NENHUMA', 'API_KEY', 'BEARER', 'BASIC', 'OAUTH2',
      'CERTIFICADO', 'BANCO'],
    transformacoes: normalizacao.catalogo(),
  });
}));

integracaoRouter.post('/', CONFIGURAR, rota(async (req, res) => {
  const e = validarEntrada(req, 'body', criarIntegracaoSchema);

  // `tipo` e a etiqueta livre que o modulo 13 ja usava (ERP, LOGISTICA,
  // FORNECEDOR...) e `sistema` e o enum novo. Os dois saem do mesmo parametro,
  // mas o texto precisa do cast explicito: sem ele o Postgres tenta deduzir dois
  // tipos incompativeis para $3 e recusa a instrucao inteira, na analise - ou
  // seja, a rota falhava em 100% das chamadas, nao em um caso de borda.
  // Endereco interno so passa se o operador tiver liberado aquele host.
  try {
    await validarEndpoint(e.endpoint, await configIntegracao.hostsInternosPermitidos());
  } catch (erro) {
    throw regraNegocio((erro as Error).message);
  }

  const { rows } = await query<{ id: string }>(`
    INSERT INTO integracoes
      (codigo, nome, tipo, sistema, conector, direcao, modo_sincronizacao,
       endpoint, configuracao, timeout_segundos, max_tentativas,
       limite_por_minuto, limite_por_execucao, intervalo_minutos, observacao,
       ativo, created_by)
    SELECT $1, $2, $3::sistema_integrado_enum::text, $3::sistema_integrado_enum,
           $4::tipo_conector_enum,
           coalesce($5, 'ENTRADA')::direcao_integracao_enum,
           coalesce($6, 'MANUAL')::modo_sincronizacao_enum,
           $7, coalesce($8::jsonb, '{}'::jsonb), coalesce($9, 30),
           coalesce($10, 3), $11, coalesce($12, 5000), $13, $14,
           coalesce($15, false), $16
     WHERE NOT EXISTS (SELECT 1 FROM integracoes i WHERE upper(i.codigo) = upper($1))
    RETURNING id`,
  [e.codigo, e.nome, e.sistema, e.conector, e.direcao ?? null,
    e.modo_sincronizacao ?? null, e.endpoint ?? null,
    e.configuracao ? JSON.stringify(e.configuracao) : null,
    e.timeout_segundos ?? null, e.max_tentativas ?? null,
    e.limite_por_minuto ?? null, e.limite_por_execucao ?? null,
    e.intervalo_minutos ?? null, e.observacao ?? null, e.ativo ?? null,
    usuarioId(req)]);

  if (!rows.length) throw regraNegocio(`Ja existe uma integracao com o codigo ${e.codigo}`);
  criado(res, { id: Number(rows[0]!.id), codigo: e.codigo });
}));

integracaoRouter.put('/:codigo', CONFIGURAR, rota(async (req, res) => {
  const { codigo } = validarEntrada(req, 'params', codigoParam);
  const e = validarEntrada(req, 'body', atualizarIntegracaoSchema);

  const { rowCount } = await query(`
    UPDATE integracoes SET
      nome = coalesce($2, nome),
      direcao = coalesce($3::direcao_integracao_enum, direcao),
      modo_sincronizacao = coalesce($4::modo_sincronizacao_enum, modo_sincronizacao),
      endpoint = coalesce($5, endpoint),
      configuracao = coalesce($6::jsonb, configuracao),
      timeout_segundos = coalesce($7, timeout_segundos),
      max_tentativas = coalesce($8, max_tentativas),
      limite_por_minuto = coalesce($9, limite_por_minuto),
      limite_por_execucao = coalesce($10, limite_por_execucao),
      intervalo_minutos = coalesce($11, intervalo_minutos),
      observacao = coalesce($12, observacao),
      ativo = coalesce($13, ativo),
      updated_by = $14
    WHERE upper(codigo) = upper($1)`,
  [codigo, e.nome ?? null, e.direcao ?? null, e.modo_sincronizacao ?? null,
    e.endpoint ?? null, e.configuracao ? JSON.stringify(e.configuracao) : null,
    e.timeout_segundos ?? null, e.max_tentativas ?? null,
    e.limite_por_minuto ?? null, e.limite_por_execucao ?? null,
    e.intervalo_minutos ?? null, e.observacao ?? null,
    e.ativo === undefined ? null : e.ativo, usuarioId(req)]);

  if (!rowCount) throw regraNegocio(`Integracao ${codigo} nao encontrada`);
  ok(res, { codigo }, 'Integracao atualizada');
}));

/** Teste de conexao (secao 39). Nao processa nada: so bate na porta. */
integracaoRouter.post('/:codigo/testar', SINCRONIZAR, rota(async (req, res) => {
  const { codigo } = validarEntrada(req, 'params', codigoParam);
  const { caminho } = validarEntrada(req, 'body', testarSchema);
  const integracao = await sincronizacao.obter(codigo);

  if (!integracao.endpoint) {
    ok(res, {
      alcancavel: false,
      diagnostico: `A integracao ${codigo} usa o conector ${integracao.conector}, `
        + 'que nao tem endpoint para testar. Conectores de ARQUIVO e MANUAL sao '
        + 'exercitados por importacao; WEBHOOK, pela chamada do parceiro.',
    });
    return;
  }

  const auth = await credenciais.autenticar(integracao.id);
  const url = `${integracao.endpoint.replace(/\/$/, '')}`
    + (caminho ? `/${caminho.replace(/^\//, '')}` : '');

  const execucao = await sincronizacao.abrirExecucao({
    integracao, tipo: 'TESTE', direcao: 'ENTRADA',
  }, contexto(req));

  const resultado = await conector.testar({
    url,
    cabecalhos: auth.cabecalhos,
    ...(auth.query ? { query: auth.query } : {}),
    timeout_segundos: integracao.timeout_segundos,
  });

  await sincronizacao.fecharExecucao(execucao.id, {
    status: resultado.alcancavel ? 'CONCLUIDA' : 'FALHOU',
    resumo: { url: resultado.url, status: resultado.status },
    erro: resultado.alcancavel ? null : resultado.diagnostico,
  });

  ok(res, { ...resultado, autenticacao: auth.tipo });
}));

integracaoRouter.post('/:codigo/sincronizar', SINCRONIZAR, rota(async (req, res) => {
  const { codigo } = validarEntrada(req, 'params', codigoParam);
  const { entidade, desde } = validarEntrada(req, 'body', sincronizarSchema);
  ok(res, await sincronizacao.sincronizarEntrada(codigo, entidade, contexto(req), {
    modo: 'MANUAL', disparado_por: `MANUAL:${usuarioId(req)}`, desde: desde ?? null,
  }));
}));

integracaoRouter.post('/sincronizar-devidas', SINCRONIZAR, rota(async (req, res) => {
  ok(res, await sincronizacao.sincronizarDevidas(contexto(req)));
}));

/** Saida para o ERP (secao 9). A trava de aprovacao esta no servico. */
integracaoRouter.post('/:codigo/enviar', SINCRONIZAR, rota(async (req, res) => {
  const { codigo } = validarEntrada(req, 'params', codigoParam);
  const e = validarEntrada(req, 'body', enviarSchema);
  ok(res, await sincronizacao.enviar(codigo, {
    entidade: e.entidade,
    registro_id: e.registro_id,
    payload: e.payload,
    ...(e.caminho ? { caminho: e.caminho } : {}),
    ...(e.metodo ? { metodo: e.metodo } : {}),
  }, contexto(req)));
}));

// ===========================================================================
// Credenciais (secoes 25 e 37)
// ===========================================================================

integracaoRouter.get('/credenciais', CREDENCIAL, rota(async (req, res) => {
  const { integracao_id: id } = validarEntrada(req, 'query', z.object({
    integracao_id: z.coerce.number().int().positive().optional(),
  }));
  ok(res, await credenciais.listar(id));
}));

integracaoRouter.post('/credenciais', CREDENCIAL, rota(async (req, res) => {
  const e = validarEntrada(req, 'body', credencialSchema);
  const resultado = await credenciais.cadastrar({
    integracao_id: e.integracao_id,
    nome: e.nome,
    tipo: e.tipo,
    ...(e.ambiente ? { ambiente: e.ambiente } : {}),
    referencia_segura: e.referencia_segura,
    ...(e.parametros ? { parametros: e.parametros } : {}),
    expira_em: e.expira_em ?? null,
  }, contexto(req));

  criado(res, resultado, resultado.aviso
    ? `Credencial cadastrada, mas a referencia nao resolve: ${resultado.aviso}`
    : 'Credencial cadastrada. O segredo nao foi guardado: apenas a referencia.');
}));

integracaoRouter.post('/credenciais/:id/rotacionar', CREDENCIAL, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const { referencia_segura: nova } = validarEntrada(req, 'body', rotacionarSchema);
  ok(res, await credenciais.rotacionar(id, nova, contexto(req)), 'Credencial rotacionada');
}));

integracaoRouter.post('/credenciais/:id/verificar', CREDENCIAL, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  ok(res, await credenciais.verificar(id));
}));

integracaoRouter.delete('/credenciais/:id', CREDENCIAL, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  await credenciais.desativar(id);
  ok(res, { id }, 'Credencial desativada');
}));

// ===========================================================================
// Templates e mapeamentos (secoes 12 e 26)
// ===========================================================================

integracaoRouter.get('/templates', LER, rota(async (req, res) => {
  const { entidade } = validarEntrada(req, 'query', z.object({
    entidade: z.string().trim().min(2).max(60).optional(),
  }));
  ok(res, await mapeamento.listarTemplates(entidade ? { entidade } : {}));
}));

integracaoRouter.get('/templates/:codigo', LER, rota(async (req, res) => {
  const { codigo } = validarEntrada(req, 'params', codigoParam);
  ok(res, await mapeamento.obterTemplate(codigo));
}));

integracaoRouter.post('/templates', CONFIGURAR, rota(async (req, res) => {
  const e = validarEntrada(req, 'body', templateSchema);
  criado(res, await mapeamento.salvarTemplate({
    codigo: e.codigo,
    nome: e.nome,
    descricao: e.descricao ?? null,
    entidade: e.entidade,
    formato: e.formato ?? null,
    integracao_id: e.integracao_id ?? null,
    ...(e.linha_cabecalho ? { linha_cabecalho: e.linha_cabecalho } : {}),
    separador: e.separador ?? null,
    ...(e.codificacao ? { codificacao: e.codificacao } : {}),
    ...(e.configuracao ? { configuracao: e.configuracao } : {}),
    mapeamentos: e.mapeamentos.map((m) => ({
      campo_externo: m.campo_externo,
      campo_interno: m.campo_interno,
      transformacao: m.transformacao ?? null,
      ...(m.parametros ? { parametros: m.parametros } : {}),
      ...(m.obrigatorio !== undefined ? { obrigatorio: m.obrigatorio } : {}),
      valor_padrao: m.valor_padrao ?? null,
    })),
  }, usuarioId(req)));
}));

/** Sugestao de mapeamento (secao 36). E sugestao, e vem marcada como tal. */
integracaoRouter.post('/templates/sugerir', LER, rota(async (req, res) => {
  const { colunas } = validarEntrada(req, 'body', sugerirSchema);
  const sugestoes = mapeamento.sugerirMapeamento(colunas);
  ok(res, {
    sugestoes,
    nao_reconhecidas: colunas.filter(
      (c) => !sugestoes.some((s) => s.campo_externo === c)),
    observacao: 'Sao SUGESTOES por semelhanca de nome, nao mapeamento confirmado. '
      + 'Revise antes de salvar: mapear quantidade na coluna de preco produz um '
      + 'erro que so aparece no relatorio do mes seguinte.',
  });
}));

// ===========================================================================
// Importacao (secoes 11 a 14)
// ===========================================================================

integracaoRouter.get('/importacoes', LER, rota(async (req, res) => {
  ok(res, await importacao.listar(validarEntrada(req, 'query', listarImportacoesSchema)));
}));

integracaoRouter.get('/importacoes/entidades', LER, rota(async (_req, res) => {
  ok(res, {
    entidades: importacao.entidadesSuportadas(),
    observacao: 'Entidades com gravador implementado. Outras exigem um gravador '
      + 'novo, que e o ponto de extensao do modulo.',
  });
}));

integracaoRouter.get('/importacoes/:id', LER, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  ok(res, await importacao.obter(id));
}));

integracaoRouter.get('/importacoes/:id/ocorrencias', LER, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const filtro = validarEntrada(req, 'query', ocorrenciasSchema);
  ok(res, await importacao.ocorrencias(id, filtro));
}));

integracaoRouter.post('/importacoes', IMPORTAR, rota(async (req, res) => {
  const e = validarEntrada(req, 'body', importarSchema);
  criado(res, await importacao.analisar({
    caminho: e.caminho,
    nome_arquivo: e.nome_arquivo,
    entidade: e.entidade,
    template: e.template ?? null,
    ...(e.linha_cabecalho ? { linha_cabecalho: e.linha_cabecalho } : {}),
    separador: e.separador ?? null,
    integracao: e.integracao ?? null,
  }, contexto(req)));
}));

integracaoRouter.post('/importacoes/:id/mapear', IMPORTAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const { template } = validarEntrada(req, 'body', mapearImportacaoSchema);
  ok(res, await importacao.definirMapeamento(id, template));
}));

integracaoRouter.post('/importacoes/:id/validar', IMPORTAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  ok(res, await importacao.validar(id));
}));

integracaoRouter.post('/importacoes/:id/confirmar', IMPORTAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  ok(res, await importacao.confirmar(id, usuarioId(req)),
    'Importacao confirmada. Use /processar para gravar os registros.');
}));

integracaoRouter.post('/importacoes/:id/processar', IMPORTAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  ok(res, await importacao.processar(id, contexto(req)));
}));

integracaoRouter.post('/importacoes/:id/cancelar', IMPORTAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const { motivo } = validarEntrada(req, 'body', cancelarSchema);
  await importacao.cancelar(id, motivo);
  ok(res, { id }, 'Importacao cancelada');
}));

// ===========================================================================
// Exportacao (secao 40)
// ===========================================================================

integracaoRouter.get('/exportacoes/conjuntos', LER, rota(async (_req, res) => {
  ok(res, exportacao.catalogo());
}));

integracaoRouter.get('/exportacoes/historico', LER, rota(async (req, res) => {
  const filtro = validarEntrada(req, 'query', historicoExportacoesSchema);
  ok(res, await exportacao.historico(filtro));
}));

/**
 * Gera e devolve o arquivo.
 *
 * Responde com o binario, nao com JSON: o navegador precisa baixar. O
 * `Content-Disposition` carrega o nome, e o aviso de truncamento vai num
 * cabecalho proprio para nao corromper o arquivo.
 */
integracaoRouter.post('/exportacoes', EXPORTAR, rota(async (req, res) => {
  const e = validarEntrada(req, 'body', exportarSchema);
  const permissoes = (req as unknown as Req).usuario?.permissoes ?? [];

  const resultado = await exportacao.exportar(
    e.conjunto, e.formato ?? 'XLSX', e.filtros ?? {}, permissoes, contexto(req));

  res.setHeader('Content-Type', resultado.tipo_conteudo);
  res.setHeader('Content-Disposition',
    `attachment; filename="${resultado.nome_arquivo}"`);
  res.setHeader('X-Linhas', String(resultado.linhas));
  if (resultado.aviso) res.setHeader('X-Aviso', encodeURIComponent(resultado.aviso));
  res.send(resultado.conteudo);
}));

// ===========================================================================
// Log, mensagens e dead letter (secoes 29 a 32)
// ===========================================================================

integracaoRouter.get('/execucoes', LER, rota(async (req, res) => {
  ok(res, await monitor.execucoes(validarEntrada(req, 'query', execucoesSchema)));
}));

integracaoRouter.get('/mensagens', LER, rota(async (req, res) => {
  ok(res, await monitor.mensagens(validarEntrada(req, 'query', mensagensSchema)));
}));

integracaoRouter.get('/mensagens/:id', LER, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  ok(res, await monitor.obterMensagem(id));
}));

integracaoRouter.post('/mensagens/:id/reprocessar', REPROCESSAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  ok(res, await monitor.reprocessar(id));
}));

integracaoRouter.post('/mensagens/:id/cancelar', REPROCESSAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const { motivo } = validarEntrada(req, 'body', cancelarSchema);
  await monitor.cancelarMensagem(id, motivo);
  ok(res, { id }, 'Mensagem cancelada');
}));

// ===========================================================================
// Central de erros (secoes 35 e 36)
// ===========================================================================

integracaoRouter.get('/erros', LER, rota(async (req, res) => {
  ok(res, await monitor.erros(validarEntrada(req, 'query', errosSchema)));
}));

integracaoRouter.get('/erros/padroes', LER, rota(async (req, res) => {
  const { dias } = validarEntrada(req, 'query', periodoSchema);
  ok(res, await monitor.padroes(dias ?? 30));
}));

integracaoRouter.post('/erros/:id/resolver', REPROCESSAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const dados = validarEntrada(req, 'body', resolverErroSchema);
  await monitor.resolverErro(id, usuarioId(req), {
    status: dados.status,
    observacao: dados.observacao ?? null,
    ...(dados.confirmar_causa !== undefined
      ? { confirmar_causa: dados.confirmar_causa } : {}),
  });
  ok(res, { id, status: dados.status }, 'Erro atualizado');
}));

// ===========================================================================
// Conciliacao (secao 34)
// ===========================================================================

integracaoRouter.get('/conciliacoes', LER, rota(async (req, res) => {
  ok(res, await conciliacao.listar(validarEntrada(req, 'query', listarConciliacoesSchema)));
}));

integracaoRouter.get('/conciliacoes/resumo', LER, rota(async (_req, res) => {
  ok(res, await conciliacao.resumo());
}));

integracaoRouter.post('/conciliacoes/estoque', CONCILIAR, rota(async (req, res) => {
  const e = validarEntrada(req, 'body', conciliarEstoqueSchema);
  ok(res, await conciliacao.conciliarEstoque(
    e.integracao,
    e.saldos.map((s) => ({
      codigo_produto: s.codigo_produto,
      saldo: s.saldo,
      ...(s.unidade ? { unidade: s.unidade } : {}),
    })),
    contexto(req)));
}));

integracaoRouter.post('/conciliacoes/:id/aceitar', CONCILIAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const { justificativa } = validarEntrada(req, 'body', decidirConciliacaoSchema);
  ok(res, await conciliacao.aceitar(id, usuarioId(req), justificativa));
}));

integracaoRouter.post('/conciliacoes/:id/conciliar', CONCILIAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const { justificativa } = validarEntrada(req, 'body', decidirConciliacaoSchema);
  await conciliacao.marcarConciliado(id, usuarioId(req), justificativa);
  ok(res, { id }, 'Divergencia marcada como conciliada');
}));

integracaoRouter.post('/conciliacoes/:id/ignorar', CONCILIAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  const { justificativa } = validarEntrada(req, 'body', decidirConciliacaoSchema);
  await conciliacao.ignorar(id, usuarioId(req), justificativa);
  ok(res, { id }, 'Divergencia ignorada');
}));

// ===========================================================================
// E-mail (secoes 15 a 18)
// ===========================================================================

integracaoRouter.get('/emails', LER, rota(async (req, res) => {
  ok(res, await email.listar(validarEntrada(req, 'query', listarEmailsSchema)));
}));

integracaoRouter.post('/emails', SINCRONIZAR, rota(async (req, res) => {
  const e = validarEntrada(req, 'body', emailSchema);
  criado(res, await email.receber({
    remetente: e.remetente,
    assunto: e.assunto,
    corpo: e.corpo,
    ...(e.recebido_em ? { recebido_em: e.recebido_em } : {}),
    ...(e.message_id ? { message_id: e.message_id } : {}),
    ...(e.anexos ? { anexos: e.anexos } : {}),
  }, contexto(req)));
}));

/** Extracao apresentada para validacao humana (secao 16). Nao grava nada. */
integracaoRouter.post('/emails/:id/extrair', SINCRONIZAR, rota(async (req, res) => {
  const { id } = validarEntrada(req, 'params', idParam);
  ok(res, await email.prepararValidacao(id, contexto(req)));
}));

integracaoRouter.post('/cotacoes/:id/solicitar-por-email', SINCRONIZAR,
  rota(async (req, res) => {
    const { id } = validarEntrada(req, 'params', idParam);
    const { fornecedores } = validarEntrada(req, 'body', solicitacaoCotacaoSchema);
    ok(res, await email.prepararSolicitacao(id, fornecedores));
  }));
