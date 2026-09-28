/**
 * O motor: liga evento a regra, regra a fila e fila a acao (secoes 6 a 13 e 22).
 *
 * Sao dois passos deliberadamente separados:
 *
 *   1. `processarEventos` le os eventos NOVO, casa com as regras e ENFILEIRA uma
 *      acao por regra. Passo rapido, so decide.
 *   2. `processarFila` reserva itens e EXECUTA. Passo lento, pode falhar, tem
 *      retry com backoff.
 *
 * Separar importa porque os dois falham por motivos diferentes. Se uma acao
 * quebra, o evento continua processado e as outras regras dele seguem valendo -
 * uma regra com defeito nao paralisa as dezenove que funcionam.
 *
 * A idempotencia da secao 22 nao esta neste arquivo, e e proposital: ela mora nos
 * indices UNIQUE parciais de eventos, alertas, tarefas, aprovacoes e
 * notificacoes. Codigo que verifica antes de inserir perde a corrida entre dois
 * workers; indice nao perde.
 */
import { query, type ContextoSessao } from '../../config/database.js';
import * as acoes from './acoes.service.js';
import { numero } from './config.js';
import * as eventos from './eventos.service.js';
import * as fila from './fila.service.js';
import * as regras from './regras.service.js';

export interface ResultadoProcessamentoEventos {
  eventos_lidos: number;
  regras_disparadas: number;
  acoes_enfileiradas: number;
  sem_regra: number;
  erros: Array<{ evento_id: number; erro: string }>;
  detalhes: Array<{
    evento_id: number; tipo: string; regras: string[]; enfileiradas: number;
  }>;
}

/**
 * Casa eventos pendentes com regras e enfileira as acoes.
 *
 * Um evento sem regra tambem e marcado PROCESSADO, com zero regras. Deixa-lo
 * NOVO faria a fila de pendentes crescer para sempre com fatos que ninguem
 * configurou para tratar - e a fila de pendentes deixaria de significar
 * "trabalho atrasado", que e o unico valor dela.
 */
export async function processarEventos(
  limite: number, contexto: ContextoSessao,
): Promise<ResultadoProcessamentoEventos> {
  const pendentes = await eventos.pendentes(limite);

  const resultado: ResultadoProcessamentoEventos = {
    eventos_lidos: pendentes.length,
    regras_disparadas: 0,
    acoes_enfileiradas: 0,
    sem_regra: 0,
    erros: [],
    detalhes: [],
  };

  const processados: number[] = [];
  const contagem = new Map<number, number>();

  for (const bruto of pendentes) {
    const evento = bruto as {
      id: string; tipo: string; origem: string; entidade: string | null;
      entidade_id: string | null; payload: Record<string, unknown>;
      correlation_id: string;
    };
    const eventoId = Number(evento.id);

    try {
      const candidatas = await regras.paraEvento(evento.tipo);
      const aplicaveis = candidatas.filter(
        (r) => regras.avaliar(r.condicao, evento.payload).aprovada);

      if (!aplicaveis.length) resultado.sem_regra += 1;

      let enfileiradas = 0;
      for (const regra of aplicaveis) {
        await fila.enfileirar({
          evento_id: eventoId,
          regra_id: regra.id,
          acao: regra.acao,
          parametros: {
            ...regra.parametros,
            _nivel: regra.nivel,
            _regra_codigo: regra.codigo,
            _evento_tipo: evento.tipo,
            _origem: evento.origem,
            _entidade: evento.entidade,
            _entidade_id: evento.entidade_id === null ? null : Number(evento.entidade_id),
            _payload: evento.payload,
          },
          correlation_id: evento.correlation_id,
          prioridade: regra.prioridade,
          max_tentativas: regra.max_tentativas,
        }, contexto);
        enfileiradas += 1;
      }

      resultado.regras_disparadas += aplicaveis.length;
      resultado.acoes_enfileiradas += enfileiradas;
      contagem.set(eventoId, aplicaveis.length);
      processados.push(eventoId);
      resultado.detalhes.push({
        evento_id: eventoId,
        tipo: evento.tipo,
        regras: aplicaveis.map((r) => r.codigo),
        enfileiradas,
      });
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      await eventos.marcarErro(eventoId, mensagem);
      resultado.erros.push({ evento_id: eventoId, erro: mensagem });
    }
  }

  await eventos.marcarProcessado(processados, contagem);
  return resultado;
}

export interface ResultadoProcessamentoFila {
  reservados: number;
  concluidos: number;
  falhas: number;
  reagendados: number;
  fila_morta: number;
  execucoes: Array<{
    fila_id: number; acao: string; regra: string | null; status: string;
    efeito?: string; nivel_aplicado?: string; rebaixada?: string; erro?: string;
    duracao_ms: number;
  }>;
}

/**
 * Reserva itens da fila e executa cada acao.
 *
 * Toda execucao vira linha em `automacao_execucoes`, inclusive as que falharam -
 * a tabela e append-only por trigger justamente para que ninguem possa apagar a
 * tentativa que deu errado. Sem esse registro, "por que o sistema abriu essa
 * tarefa" fica sem resposta tres semanas depois.
 */
export async function processarFila(
  lote: number, contexto: ContextoSessao,
): Promise<ResultadoProcessamentoFila> {
  const itens = await fila.reservar(lote);
  const resultado: ResultadoProcessamentoFila = {
    reservados: itens.length, concluidos: 0, falhas: 0, reagendados: 0,
    fila_morta: 0, execucoes: [],
  };

  const backoffBase = await numero('backoff_base_segundos', 30);
  const backoffMaximo = await numero('backoff_maximo_segundos', 3600);

  for (const item of itens) {
    const inicio = Date.now();
    const p = item.parametros as Record<string, unknown>;
    const regraCodigo = typeof p._regra_codigo === 'string' ? p._regra_codigo : null;

    try {
      const ctx: acoes.ContextoAcao = {
        acao: item.acao,
        parametros: limparInternos(p),
        nivel: (typeof p._nivel === 'string' ? p._nivel : 'ASSISTIDO') as acoes.NivelAutomacao,
        evento_id: item.evento_id,
        evento_tipo: typeof p._evento_tipo === 'string' ? p._evento_tipo : item.acao,
        origem: typeof p._origem === 'string' ? p._origem : 'SISTEMA',
        entidade: typeof p._entidade === 'string' ? p._entidade : null,
        entidade_id: typeof p._entidade_id === 'number' ? p._entidade_id : null,
        payload: (p._payload ?? {}) as Record<string, unknown>,
        correlation_id: item.correlation_id,
        regra_codigo: regraCodigo ?? 'MANUAL',
        regra_id: item.regra_id,
        fila_id: item.id,
      };

      const efeito = await acoes.executar(ctx, contexto);
      const duracao = Date.now() - inicio;

      // `concluir` ja grava a execucao no historico - nao registramos duas vezes.
      await fila.concluir(item, efeito as unknown as Record<string, unknown>, duracao);
      resultado.concluidos += 1;
      resultado.execucoes.push({
        fila_id: item.id, acao: item.acao, regra: regraCodigo, status: 'CONCLUIDO',
        efeito: efeito.efeito, nivel_aplicado: efeito.nivel_aplicado,
        ...(efeito.rebaixada ? { rebaixada: efeito.rebaixada } : {}),
        duracao_ms: duracao,
      });
    } catch (erro) {
      const duracao = Date.now() - inicio;
      const mensagem = erro instanceof Error ? erro.message : String(erro);

      const desfecho = await fila.falhar(
        item, mensagem, duracao, backoffBase, backoffMaximo);
      resultado.falhas += 1;
      if (desfecho.dead_letter) resultado.fila_morta += 1;
      else resultado.reagendados += 1;

      resultado.execucoes.push({
        fila_id: item.id, acao: item.acao, regra: regraCodigo,
        status: desfecho.dead_letter ? 'FILA_MORTA' : 'RETRY',
        erro: mensagem, duracao_ms: duracao,
      });
    }
  }

  return resultado;
}

/** Remove os campos de transporte, deixando so os parametros da regra. */
function limparInternos(p: Record<string, unknown>): Record<string, unknown> {
  const limpo: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(p)) {
    if (!chave.startsWith('_')) limpo[chave] = valor;
  }
  return limpo;
}

/**
 * Um ciclo completo: processa eventos e depois a fila.
 *
 * Nesta ordem de proposito: as acoes enfileiradas no passo 1 rodam no passo 2 do
 * MESMO ciclo. Quem chama uma vez - o job, a tela de operacao, a bateria de
 * teste - ve o efeito completo, sem precisar chamar duas vezes e sem depender de
 * quanto tempo o worker leva para voltar.
 */
export async function ciclo(contexto: ContextoSessao): Promise<{
  eventos: ResultadoProcessamentoEventos; fila: ResultadoProcessamentoFila;
}> {
  const lote = await numero('worker_lote', 10);
  const processados = await processarEventos(Math.max(lote * 5, 50), contexto);
  const executados = await processarFila(Math.max(lote, processados.acoes_enfileiradas), contexto);
  return { eventos: processados, fila: executados };
}

/**
 * Executa uma acao fora do fluxo de evento (secao 34).
 *
 * Serve para a tela de operacao testar uma regra sobre um caso real. A acao roda
 * com o mesmo codigo, as mesmas travas e o mesmo registro de execucao - um teste
 * que passa por um caminho diferente da producao nao prova nada.
 */
export async function executarAvulsa(
  entrada: {
    acao: string; nivel: acoes.NivelAutomacao; parametros?: Record<string, unknown>;
    evento_tipo: string; entidade?: string | null; entidade_id?: number | null;
    payload?: Record<string, unknown>; regra_codigo?: string;
  },
  contexto: ContextoSessao,
): Promise<acoes.ResultadoAcao> {
  const { rows } = await query<{ id: string }>('SELECT gen_random_uuid()::text AS id');
  const correlationId = rows[0]!.id;

  const inicio = Date.now();
  try {
    const efeito = await acoes.executar({
      acao: entrada.acao,
      parametros: entrada.parametros ?? {},
      nivel: entrada.nivel,
      evento_id: null,
      evento_tipo: entrada.evento_tipo,
      origem: 'SISTEMA',
      entidade: entrada.entidade ?? null,
      entidade_id: entrada.entidade_id ?? null,
      payload: entrada.payload ?? {},
      correlation_id: correlationId,
      regra_codigo: entrada.regra_codigo ?? 'AVULSA',
      regra_id: null,
    }, contexto);

    await fila.registrarExecucaoDireta({
      fila_id: null, regra_id: null, evento_id: null, correlation_id: correlationId,
      acao: entrada.acao, status: 'CONCLUIDO', tentativa: 1,
      duracao_ms: Date.now() - inicio, resultado: efeito, erro: null,
      usuario_id: contexto.usuarioId ?? null,
    });

    return efeito;
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await fila.registrarExecucaoDireta({
      fila_id: null, regra_id: null, evento_id: null, correlation_id: correlationId,
      acao: entrada.acao, status: 'ERRO', tentativa: 1,
      duracao_ms: Date.now() - inicio, resultado: null, erro: mensagem,
      usuario_id: contexto.usuarioId ?? null,
    });
    throw erro;
  }
}
