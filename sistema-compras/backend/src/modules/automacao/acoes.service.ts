/**
 * Catalogo de acoes das automacoes (secoes 8 a 13 e 33).
 *
 * Uma regra diz "quando X, faca Y". Este arquivo e o Y - e, mais importante, e
 * onde esta escrito o que Y NUNCA pode ser.
 *
 * A secao 33 define tres niveis, e eles sao a espinha do modulo:
 *
 *   AUTOMATICO  o sistema executa. Reservado para acoes que so PRODUZEM
 *               informacao: alertar, notificar, abrir tarefa. Nada que mude
 *               dinheiro, estoque ou compromisso com fornecedor.
 *   ASSISTIDO   o sistema prepara e um humano confirma. Vira tarefa com acao
 *               sugerida - o trabalho chega pronto, a decisao continua sendo
 *               de quem responde por ela.
 *   APROVACAO   o sistema pede autorizacao formal por alcada antes de qualquer
 *               coisa acontecer.
 *
 * A trava da secao 9 nao depende do nivel declarado na regra. Se a acao esta em
 * ACOES_QUE_EXIGEM_HUMANO - emitir pedido, aprovar pedido, alterar preco, mover
 * estoque - ela e REBAIXADA para APROVACAO mesmo que alguem cadastre a regra
 * como AUTOMATICO. Uma regra e um dado editavel na tela; a trava nao pode morar
 * em um dado editavel. E o rebaixamento fica registrado no resultado da
 * execucao, para a auditoria ver que a tentativa existiu.
 */
import type { ContextoSessao } from '../../config/database.js';
import { query } from '../../config/database.js';
import { registrarAlerta, type Prioridade } from '../bi/alertas.service.js';
import * as aprovacoes from './aprovacoes.service.js';
import * as notificacoes from './notificacoes.service.js';
import * as tarefas from './tarefas.service.js';

export type NivelAutomacao = 'AUTOMATICO' | 'ASSISTIDO' | 'APROVACAO';

/** As acoes que as regras podem pedir, e o que cada uma realmente faz. */
export const CATALOGO_ACOES = {
  ALERTAR: 'Registra alerta na central, com deduplicacao por fato',
  NOTIFICAR: 'Envia notificacao ao perfil ou usuario de destino',
  ALERTAR_E_TAREFA: 'Registra o alerta e abre a tarefa correspondente',
  TAREFA: 'Abre tarefa com prazo de SLA e acao sugerida',
  SUGERIR_CONSOLIDACAO: 'Abre tarefa de consolidacao de necessidades por fornecedor',
  SOLICITAR_APROVACAO: 'Cria solicitacao de aprovacao por alcada',
  REGISTRAR: 'Apenas registra a ocorrencia, sem alerta nem tarefa',
} as const;

export type Acao = keyof typeof CATALOGO_ACOES;

export const acaoConhecida = (acao: string): acao is Acao =>
  Object.prototype.hasOwnProperty.call(CATALOGO_ACOES, acao.toUpperCase());

export interface ContextoAcao {
  acao: string;
  parametros: Record<string, unknown>;
  nivel: NivelAutomacao;
  evento_id: number | null;
  evento_tipo: string;
  origem: string;
  entidade: string | null;
  entidade_id: number | null;
  payload: Record<string, unknown>;
  correlation_id: string;
  regra_codigo: string;
  regra_id: number | null;
  fila_id?: number | null;
}

export interface ResultadoAcao {
  acao: string;
  nivel_aplicado: NivelAutomacao;
  nivel_declarado: NivelAutomacao;
  rebaixada?: string;
  alerta_id?: number;
  alerta_novo?: boolean;
  tarefa_id?: number;
  tarefa_nova?: boolean;
  aprovacao_id?: number;
  aprovacao_nova?: boolean;
  notificados?: number;
  efeito: string;
  observacoes: string[];
}

// ---------------------------------------------------------------------------
// Apoio
// ---------------------------------------------------------------------------

const texto = (v: unknown, padrao: string): string =>
  typeof v === 'string' && v.trim() ? v.trim() : padrao;

const numeroDe = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const PRIORIDADES_ALERTA = ['CRITICO', 'ALTO', 'MEDIO', 'BAIXO'] as const;
const PRIORIDADES_TAREFA = ['CRITICA', 'ALTA', 'MEDIA', 'BAIXA'] as const;

/**
 * Prioridade de alerta e de tarefa usam sufixos diferentes no banco (CRITICO
 * contra CRITICA). Traduzir num lugar so evita que a regra precise saber disso.
 */
const prioridadeAlerta = (v: unknown): Prioridade => {
  const bruto = String(v ?? '').toUpperCase();
  if ((PRIORIDADES_ALERTA as readonly string[]).includes(bruto)) return bruto as Prioridade;
  const equivalente = { CRITICA: 'CRITICO', ALTA: 'ALTO', MEDIA: 'MEDIO', BAIXA: 'BAIXO' };
  return (equivalente[bruto as keyof typeof equivalente] ?? 'MEDIO') as Prioridade;
};

const prioridadeTarefa = (v: unknown): tarefas.PrioridadeTarefa => {
  const bruto = String(v ?? '').toUpperCase();
  if ((PRIORIDADES_TAREFA as readonly string[]).includes(bruto)) {
    return bruto as tarefas.PrioridadeTarefa;
  }
  const equivalente = { CRITICO: 'CRITICA', ALTO: 'ALTA', MEDIO: 'MEDIA', BAIXO: 'BAIXA' };
  return (equivalente[bruto as keyof typeof equivalente] ?? 'MEDIA') as tarefas.PrioridadeTarefa;
};

/**
 * Categoria do alerta vem de `alertas_tipos`, nao de um mapa aqui.
 *
 * A tabela ja existe desde o modulo 11 e e a fonte unica: um tipo novo cadastrado
 * la funciona nas automacoes sem mudar codigo.
 */
const categorias = new Map<string, string>();

async function categoriaDoTipo(tipo: string): Promise<string> {
  const chave = tipo.toUpperCase();
  const guardada = categorias.get(chave);
  if (guardada) return guardada;
  const { rows } = await query<{ categoria: string }>(
    'SELECT categoria FROM alertas_tipos WHERE tipo = $1', [chave]);
  const categoria = rows[0]?.categoria ?? 'governanca';
  categorias.set(chave, categoria);
  return categoria;
}

/** Descricao curta da entidade, para o titulo nao ser "Alerta do evento 8123". */
function rotulo(ctx: ContextoAcao): string {
  const p = ctx.payload;
  const nome = texto(p.produto_nome ?? p.nome ?? p.fornecedor_nome, '');
  const codigo = texto(p.sku ?? p.codigo ?? p.numero, '');
  if (nome && codigo) return `${codigo} - ${nome}`;
  if (nome) return nome;
  if (codigo) return codigo;
  if (ctx.entidade && ctx.entidade_id) return `${ctx.entidade} ${ctx.entidade_id}`;
  return ctx.evento_tipo;
}

function linkDe(ctx: ContextoAcao): string | null {
  const mapa: Record<string, string> = {
    produto: '/estoque?produto=', produtos: '/estoque?produto=',
    fornecedor: '/fornecedores?id=', fornecedores: '/fornecedores?id=',
    ordem_compra: '/pedidos?id=', pedido: '/pedidos?id=',
    cotacao: '/cotacoes?id=', recebimento: '/recebimento?id=',
    lote: '/estoque?lote=',
  };
  const prefixo = ctx.entidade ? mapa[ctx.entidade.toLowerCase()] : undefined;
  return prefixo && ctx.entidade_id ? `${prefixo}${ctx.entidade_id}` : null;
}

/** Chave estavel do fato: a mesma regra sobre a mesma entidade no mesmo dia. */
const chaveDe = (ctx: ContextoAcao, sufixo: string): string =>
  [ctx.regra_codigo, sufixo, ctx.entidade ?? '-', ctx.entidade_id ?? '-',
    new Date().toISOString().slice(0, 10)].join(':');

// ---------------------------------------------------------------------------
// Nivel efetivo (secoes 9 e 33)
// ---------------------------------------------------------------------------

export interface NivelEfetivo {
  nivel: NivelAutomacao;
  rebaixada?: string;
}

/**
 * Decide o nivel com que a acao vai REALMENTE rodar.
 *
 * Uma acao restrita nunca roda como AUTOMATICO, venha de onde vier a regra. A
 * funcao e pura de proposito: e a regra de negocio mais importante do modulo e
 * precisa ser testavel sem banco.
 */
export function nivelEfetivo(acao: string, declarado: NivelAutomacao): NivelEfetivo {
  if (aprovacoes.exigeHumano(acao) && declarado !== 'APROVACAO') {
    return {
      nivel: 'APROVACAO',
      rebaixada: `A acao ${acao.toUpperCase()} altera pedido, preco ou estoque e nao pode `
        + `rodar como ${declarado}; secao 9 exige o fluxo de aprovacao.`,
    };
  }
  return { nivel: declarado };
}

// ---------------------------------------------------------------------------
// Execucao
// ---------------------------------------------------------------------------

/**
 * Executa a acao da regra.
 *
 * Nao lanca excecao para "nao fiz nada": devolve o que fez e por que. Uma acao
 * que nao encontrou destinatario nao e erro de execucao - e um dado de
 * configuracao faltando, e reprocessar nao resolve. Erro de verdade (banco fora,
 * SQL invalido) sobe e a fila cuida do retry.
 */
export async function executar(
  ctx: ContextoAcao, contexto: ContextoSessao,
): Promise<ResultadoAcao> {
  const acao = ctx.acao.toUpperCase();
  const declarado = ctx.nivel;
  const efetivo = nivelEfetivo(acao, declarado);

  const base: ResultadoAcao = {
    acao,
    nivel_declarado: declarado,
    nivel_aplicado: efetivo.nivel,
    ...(efetivo.rebaixada ? { rebaixada: efetivo.rebaixada } : {}),
    efeito: '',
    observacoes: efetivo.rebaixada ? [efetivo.rebaixada] : [],
  };

  // A ordem importa. O rebaixamento vem ANTES da checagem de catalogo porque
  // EMITIR_PEDIDO e ALTERAR_ESTOQUE nao estao - nem devem estar - no catalogo de
  // acoes executaveis. Se o catalogo fosse checado primeiro, uma regra
  // cadastrada com acao EMITIR_PEDIDO cairia em "nao executei nada" e o operador
  // acharia que a automacao esta quebrada, quando o certo e ela virar um pedido
  // de aprovacao. Recusar em silencio e pior que recusar pedindo autorizacao.
  if (efetivo.rebaixada) return solicitarAprovacao(ctx, base, contexto, acao);

  if (!acaoConhecida(acao)) {
    return {
      ...base,
      efeito: 'nenhum',
      observacoes: [...base.observacoes,
        `Acao ${acao} nao esta no catalogo; nada foi executado`],
    };
  }

  switch (acao as Acao) {
    case 'ALERTAR':          return alertar(ctx, base, contexto);
    case 'NOTIFICAR':        return apenasNotificar(ctx, base, contexto);
    case 'ALERTAR_E_TAREFA': return alertarETarefa(ctx, base, contexto);
    case 'TAREFA':           return abrirTarefa(ctx, base, contexto);
    case 'SUGERIR_CONSOLIDACAO': return sugerirConsolidacao(ctx, base, contexto);
    case 'SOLICITAR_APROVACAO':  return solicitarAprovacao(ctx, base, contexto, acao);
    case 'REGISTRAR':
      return { ...base, efeito: 'registro', observacoes: [...base.observacoes,
        'Evento registrado sem alerta nem tarefa, conforme a regra'] };
    default:
      return { ...base, efeito: 'nenhum' };
  }
}

async function alertar(
  ctx: ContextoAcao, base: ResultadoAcao, contexto: ContextoSessao,
): Promise<ResultadoAcao> {
  const tipo = texto(ctx.parametros.tipo_alerta, 'ANOMALIA_DETECTADA').toUpperCase();
  const prioridade = prioridadeAlerta(ctx.parametros.prioridade);
  const categoria = await categoriaDoTipo(tipo);

  const alerta = await registrarAlerta({
    chave: chaveDe(ctx, 'alerta'),
    tipo,
    categoria,
    prioridade,
    titulo: texto(ctx.parametros.titulo, `${tipo.replace(/_/g, ' ')}: ${rotulo(ctx)}`),
    mensagem: mensagemDoEvento(ctx),
    origem: `automacao:${ctx.regra_codigo}`,
    entidade: ctx.entidade,
    entidade_id: ctx.entidade_id,
    link: linkDe(ctx),
    produto_id: ctx.entidade === 'produto' ? ctx.entidade_id : numeroDe(ctx.payload.produto_id),
    fornecedor_id: ctx.entidade === 'fornecedor'
      ? ctx.entidade_id : numeroDe(ctx.payload.fornecedor_id),
    ordem_compra_id: ctx.entidade === 'ordem_compra'
      ? ctx.entidade_id : numeroDe(ctx.payload.ordem_compra_id),
    detalhes: { evento: ctx.evento_tipo, regra: ctx.regra_codigo, payload: ctx.payload },
  }, contexto);

  const observacoes = [...base.observacoes];
  if (!alerta.novo) {
    observacoes.push(`Alerta ja estava aberto (ocorrencia ${alerta.ocorrencias})`);
  }

  return {
    ...base,
    alerta_id: alerta.id,
    alerta_novo: alerta.novo,
    efeito: alerta.novo ? 'alerta criado' : 'alerta reincidente',
    observacoes,
  };
}

async function abrirTarefa(
  ctx: ContextoAcao, base: ResultadoAcao, contexto: ContextoSessao,
  alertaId?: number,
): Promise<ResultadoAcao> {
  const politica = texto(ctx.parametros.sla, ctx.evento_tipo);
  const perfil = texto(ctx.parametros.perfil, 'COMPRADOR');

  const tarefa = await tarefas.criar({
    tipo: politica,
    titulo: texto(ctx.parametros.titulo, `${tituloPorEvento(ctx)}: ${rotulo(ctx)}`),
    descricao: mensagemDoEvento(ctx),
    acao_sugerida: texto(ctx.parametros.acao, acaoSugerida(ctx)),
    perfil_destino: perfil,
    prioridade: prioridadeTarefa(ctx.parametros.prioridade),
    origem: `automacao:${ctx.regra_codigo}`,
    entidade: ctx.entidade,
    entidade_id: ctx.entidade_id,
    link: linkDe(ctx),
    correlation_id: ctx.correlation_id,
    evento_id: ctx.evento_id,
    chave: chaveDe(ctx, 'tarefa'),
    sla: politica,
  }, contexto);

  const observacoes = [...base.observacoes];
  if (!tarefa.nova) observacoes.push('Tarefa para o mesmo fato ja estava aberta');
  if (tarefa.motivo_sem_destino) observacoes.push(tarefa.motivo_sem_destino);
  if (tarefa.nova && tarefa.sla_horas === null) {
    observacoes.push(`Sem politica de SLA para a etapa ${politica}; tarefa aberta sem prazo`);
  }

  return {
    ...base,
    ...(alertaId ? { alerta_id: alertaId } : {}),
    tarefa_id: tarefa.id,
    tarefa_nova: tarefa.nova,
    notificados: tarefa.notificados,
    efeito: tarefa.nova ? 'tarefa criada' : 'tarefa ja aberta',
    observacoes,
  };
}

async function alertarETarefa(
  ctx: ContextoAcao, base: ResultadoAcao, contexto: ContextoSessao,
): Promise<ResultadoAcao> {
  const comAlerta = await alertar(ctx, base, contexto);
  const comTarefa = await abrirTarefa(ctx, comAlerta, contexto, comAlerta.alerta_id);
  return {
    ...comTarefa,
    alerta_novo: comAlerta.alerta_novo,
    efeito: `${comAlerta.efeito} + ${comTarefa.efeito}`,
    observacoes: [...new Set([...comAlerta.observacoes, ...comTarefa.observacoes])],
  };
}

async function apenasNotificar(
  ctx: ContextoAcao, base: ResultadoAcao, contexto: ContextoSessao,
): Promise<ResultadoAcao> {
  const aviso = await notificacoes.notificar({
    titulo: texto(ctx.parametros.titulo, `${tituloPorEvento(ctx)}: ${rotulo(ctx)}`),
    mensagem: mensagemDoEvento(ctx),
    tipo: ctx.evento_tipo,
    perfil: texto(ctx.parametros.perfil, 'COMPRADOR'),
    canal: (texto(ctx.parametros.canal, 'SISTEMA').toUpperCase() as notificacoes.Canal),
    link: linkDe(ctx),
    correlation_id: ctx.correlation_id,
    chave: chaveDe(ctx, 'notificacao'),
  }, contexto);

  const observacoes = [...base.observacoes];
  if (aviso.motivo_sem_destino) observacoes.push(aviso.motivo_sem_destino);

  return {
    ...base,
    notificados: aviso.criadas,
    efeito: aviso.criadas ? `${aviso.criadas} notificacao(oes)` : 'nenhuma notificacao',
    observacoes,
  };
}

/**
 * Consolidacao de necessidades (secao 11).
 *
 * Nao emite pedido nem agrupa nada por conta propria: abre a tarefa apontando a
 * oportunidade, com o numero que a justifica. Agrupar compras muda compromisso
 * com fornecedor, e isso e decisao do comprador.
 */
async function sugerirConsolidacao(
  ctx: ContextoAcao, base: ResultadoAcao, contexto: ContextoSessao,
): Promise<ResultadoAcao> {
  const fornecedorId = numeroDe(ctx.payload.fornecedor_id);

  if (!fornecedorId) {
    return {
      ...base,
      efeito: 'nenhum',
      observacoes: [...base.observacoes,
        'Necessidade sem fornecedor definido; nao ha o que consolidar'],
    };
  }

  const { rows } = await query<{ total: string; itens: string; fornecedor: string }>(`
    SELECT count(*) AS itens,
           coalesce(sum(n.quantidade_sugerida * coalesce(pf.preco_atual, 0)), 0)::text AS total,
           f.razao_social AS fornecedor
      FROM necessidades_compra n
      JOIN fornecedores f ON f.id = $1
      LEFT JOIN produto_fornecedor pf
             ON pf.produto_id = n.produto_id AND pf.fornecedor_id = $1
     WHERE n.status = 'PENDENTE' AND n.fornecedor_id = $1
     GROUP BY f.razao_social`, [fornecedorId]);

  const consolidado = rows[0];
  const itens = Number(consolidado?.itens ?? 0);

  if (itens < 2) {
    return {
      ...base,
      efeito: 'nenhum',
      observacoes: [...base.observacoes,
        `Apenas ${itens} necessidade(s) pendente(s) para este fornecedor; `
        + 'consolidacao exige pelo menos duas'],
    };
  }

  const valor = Number(consolidado!.total);
  const resultado = await abrirTarefa({
    ...ctx,
    entidade: 'fornecedor',
    entidade_id: fornecedorId,
    parametros: {
      ...ctx.parametros,
      sla: texto(ctx.parametros.sla, 'ANALISE_NECESSIDADE'),
      titulo: `Consolidar ${itens} necessidades de ${consolidado!.fornecedor}`,
      acao: `Avaliar pedido unico com ${itens} itens`
        + (valor > 0 ? `, cerca de R$ ${valor.toFixed(2)}` : '')
        + '. Consolidar pode reduzir frete e alcancar faixa de desconto.',
    },
  }, base, contexto);

  return {
    ...resultado,
    observacoes: [...resultado.observacoes,
      valor > 0
        ? `Valor estimado R$ ${valor.toFixed(2)} com base no preco atual do fornecedor`
        : 'Valor nao estimado: produtos sem preco atual cadastrado para este fornecedor'],
  };
}

async function solicitarAprovacao(
  ctx: ContextoAcao, base: ResultadoAcao, contexto: ContextoSessao, acaoOriginal: string,
): Promise<ResultadoAcao> {
  const ehExcecao = ctx.evento_tipo.startsWith('EXCEPTION_')
    || Boolean(ctx.parametros.excecao)
    || Boolean(efeitoRebaixamento(base));

  const motivo = texto(
    ctx.parametros.motivo ?? ctx.payload.motivo,
    efeitoRebaixamento(base)
      ?? `Excecao detectada pela regra ${ctx.regra_codigo} a partir do evento ${ctx.evento_tipo}`);

  const pedido = await aprovacoes.solicitar({
    tipo: texto(ctx.parametros.tipo, ctx.evento_tipo),
    titulo: texto(ctx.parametros.titulo, `${tituloPorEvento(ctx)}: ${rotulo(ctx)}`),
    descricao: mensagemDoEvento(ctx),
    entidade: ctx.entidade ?? 'evento',
    entidade_id: ctx.entidade_id,
    valor_avaliado: numeroDe(ctx.parametros.valor ?? ctx.payload.valor
      ?? ctx.payload.valor_total ?? ctx.payload.impacto_financeiro),
    perfil_exigido: ctx.parametros.perfil ? String(ctx.parametros.perfil) : null,
    excecao: ehExcecao,
    motivo_excecao: ehExcecao ? motivo : null,
    impacto: texto(ctx.payload.impacto, '') || null,
    correlation_id: ctx.correlation_id,
    fila_id: ctx.fila_id ?? null,
    chave: chaveDe(ctx, 'aprovacao'),
    contexto: {
      evento: ctx.evento_tipo,
      regra: ctx.regra_codigo,
      acao_solicitada: acaoOriginal,
      payload: ctx.payload,
    },
    sla: texto(ctx.parametros.sla, 'APROVACAO'),
  }, contexto);

  const observacoes = [...base.observacoes];
  if (!pedido.nova) observacoes.push('Solicitacao de aprovacao identica ja estava pendente');
  if (pedido.motivo_sem_destino) observacoes.push(pedido.motivo_sem_destino);
  if (!pedido.perfil_exigido) {
    observacoes.push('Sem valor nem perfil informado: aprovacao aberta sem perfil exigido, '
      + 'qualquer aprovador com permissao pode decidir');
  }

  return {
    ...base,
    aprovacao_id: pedido.id,
    aprovacao_nova: pedido.nova,
    notificados: pedido.notificados,
    efeito: pedido.nova
      ? `aprovacao solicitada (nivel ${pedido.nivel}${pedido.alcada ? `, ${pedido.alcada}` : ''})`
      : 'aprovacao ja pendente',
    observacoes,
  };
}

const efeitoRebaixamento = (base: ResultadoAcao): string | undefined => base.rebaixada;

// ---------------------------------------------------------------------------
// Texto para humano
// ---------------------------------------------------------------------------

const TITULOS: Record<string, string> = {
  STOCK_OUT: 'Ruptura de estoque',
  STOCK_LOW: 'Risco de ruptura',
  STOCK_EXCESS: 'Estoque excessivo',
  STOCK_EXPIRY: 'Validade proxima',
  STOCK_NEGATIVE: 'Saldo negativo',
  STOCK_IDLE: 'Produto sem saida',
  PURCHASE_NEED_CREATED: 'Necessidade de compra',
  PURCHASE_NEED_CRITICAL: 'Necessidade critica',
  QUOTE_OVERDUE: 'Cotacao sem resposta',
  PO_LATE: 'Pedido atrasado',
  PO_UNCONFIRMED: 'Pedido sem confirmacao',
  DELIVERY_LATE: 'Entrega atrasada',
  RECEIPT_DIVERGENCE: 'Divergencia no recebimento',
  QUALITY_NONCONFORMITY: 'Nao conformidade',
  SUPPLIER_PERFORMANCE_DROP: 'Queda de performance',
  SUPPLIER_SINGLE_SOURCE: 'Fornecedor unico',
  PRICE_INCREASE: 'Aumento de preco',
  AI_RISK_DETECTED: 'Risco detectado pela IA',
  AI_RECOMMENDATION_CREATED: 'Recomendacao da IA',
  EXCEPTION_PRICE_ABOVE: 'Excecao de preco',
  EXCEPTION_SUPPLIER: 'Excecao de fornecedor',
};

const tituloPorEvento = (ctx: ContextoAcao): string =>
  TITULOS[ctx.evento_tipo] ?? ctx.evento_tipo.replace(/_/g, ' ').toLowerCase();

const ACOES_SUGERIDAS: Record<string, string> = {
  STOCK_OUT: 'Abrir cotacao ou pedido emergencial para o produto',
  STOCK_LOW: 'Avaliar reposicao antes do ponto de pedido ser ultrapassado',
  STOCK_EXCESS: 'Suspender compras do item e avaliar giro com o comercial',
  STOCK_EXPIRY: 'Priorizar saida do lote ou negociar devolucao',
  STOCK_NEGATIVE: 'Conferir movimentacoes e corrigir o saldo com inventario',
  PURCHASE_NEED_CREATED: 'Analisar a necessidade e decidir a compra',
  PURCHASE_NEED_CRITICAL: 'Abrir cotacao imediatamente',
  QUOTE_OVERDUE: 'Cobrar o fornecedor ou encerrar a cotacao',
  PO_LATE: 'Cobrar a entrega e atualizar a data prometida',
  PO_UNCONFIRMED: 'Confirmar o pedido com o fornecedor',
  RECEIPT_DIVERGENCE: 'Tratar a divergencia com o fornecedor',
  QUALITY_NONCONFORMITY: 'Abrir plano de acao com o fornecedor',
  SUPPLIER_PERFORMANCE_DROP: 'Avaliar o fornecedor e buscar alternativa',
  PRICE_INCREASE: 'Renegociar ou cotar com outros fornecedores',
  AI_RISK_DETECTED: 'Analisar o risco apontado e decidir a acao',
  AI_RECOMMENDATION_CREATED: 'Aceitar, ajustar ou recusar a recomendacao',
};

const acaoSugerida = (ctx: ContextoAcao): string =>
  ACOES_SUGERIDAS[ctx.evento_tipo] ?? 'Analisar a ocorrencia e registrar a decisao';

/**
 * Mensagem com os numeros do payload.
 *
 * Um alerta sem numero obriga o usuario a abrir a tela para saber se importa.
 * Com "saldo 0, demanda 12/dia, cobertura 0 dias" ele decide na notificacao.
 */
function mensagemDoEvento(ctx: ContextoAcao): string {
  const p = ctx.payload;
  const partes: string[] = [];
  const adicionar = (rotuloCampo: string, valor: unknown, sufixo = '') => {
    const n = numeroDe(valor);
    if (n === null) return;
    partes.push(`${rotuloCampo} ${Number.isInteger(n) ? n : n.toFixed(2)}${sufixo}`);
  };

  adicionar('saldo', p.saldo ?? p.quantidade_disponivel);
  adicionar('demanda diaria', p.demanda_diaria);
  adicionar('cobertura', p.cobertura_dias, ' dias');
  adicionar('ponto de pedido', p.ponto_pedido);
  adicionar('dias para vencer', p.dias_para_vencer);
  adicionar('atraso', p.dias_atraso, ' dias');
  adicionar('variacao', p.variacao_percentual, '%');
  adicionar('valor', p.valor ?? p.valor_total);
  adicionar('OTIF', p.otif, '%');

  const cabeca = `${tituloPorEvento(ctx)} em ${rotulo(ctx)}`;
  return partes.length ? `${cabeca}. ${partes.join(', ')}.` : `${cabeca}.`;
}

export const catalogo = () =>
  Object.entries(CATALOGO_ACOES).map(([acao, descricao]) => ({
    acao,
    descricao,
    exige_humano: aprovacoes.exigeHumano(acao),
  }));
