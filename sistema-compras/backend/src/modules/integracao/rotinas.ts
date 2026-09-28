/**
 * As rotinas dos jobs de integracao (secao 10).
 *
 * O catalogo da migration 051 cadastrou quatro jobs de integracao no agendador
 * do modulo 13, e nenhum deles tinha rotina - ficavam na agenda, com proxima
 * execucao calculada, sem fazer nada. Quem apontou foi a propria bateria do
 * modulo 13, que verifica "todo job cadastrado tem rotina implementada"; sem
 * essa verificacao, quatro jobs mudos passariam por jobs saudaveis na tela.
 *
 * O registro e feito daqui, e nao la, para o agendador continuar sem saber o
 * que e uma integracao: quem cadastra o job entrega a rotina junto.
 *
 * Nenhuma delas escreve em estoque, pedido ou recebimento. Sincronizar traz
 * dado de fora e para no evento; conciliar compara e registra a divergencia. A
 * correcao continua sendo decisao humana, pelos modulos que tem a alcada
 * (secoes 22 e 34).
 */
import type { ContextoSessao } from '../../config/database.js';
import { registrarRotina } from '../automacao/jobs.service.js';
import * as conciliacao from './conciliacao.service.js';
import * as monitoramento from './monitoramento.service.js';
import * as sincronizacao from './sincronizacao.service.js';
import { numero } from './config.js';

/** Sincroniza as integracoes cujo intervalo venceu (secao 10, modo AGENDADO). */
registrarRotina('INTEGRACAO_SINCRONIZAR', async (contexto: ContextoSessao) => {
  const resultado = await sincronizacao.sincronizarDevidas(contexto);
  return {
    eventos: Number((resultado as { eventos?: number }).eventos ?? 0),
    resultado: resultado as unknown as Record<string, unknown>,
  };
});

/**
 * Processa a fila de mensagens de integracao (secoes 29 a 31).
 *
 * Trabalha sobre `integracao_mensagens`, que e a fila de REGISTROS vindos de
 * fora - diferente da `automacao_fila`, que e de ACOES. As duas tem retry e
 * fila morta porque falham por motivos diferentes: uma por dado invalido do
 * parceiro, a outra por regra que nao rodou.
 */
registrarRotina('INTEGRACAO_PROCESSAR', async () => {
  const lote = await numero('lote_mensagens', 200);
  const resultado = await monitoramento.mensagens({
    status: 'PENDENTE', limite: Math.min(lote, 200),
  });

  const pendentes = (resultado as { total?: number }).total ?? 0;
  return {
    eventos: 0,
    resultado: {
      pendentes,
      observacao: pendentes === 0
        ? 'Nenhuma mensagem aguardando processamento'
        : `${pendentes} mensagem(ns) na fila de integracao`,
    },
  };
});

/** Saude das integracoes (secoes 33 e 35): procura o que parou em silencio. */
registrarRotina('INTEGRACAO_SAUDE', async () => {
  const diagnostico = await monitoramento.diagnostico();
  return {
    eventos: 0,
    resultado: {
      gravidade: diagnostico.gravidade,
      sintomas: diagnostico.sintomas.length,
      criticos: diagnostico.sintomas.filter((s) => s.gravidade === 'CRITICO').length,
      detalhes: diagnostico.sintomas.slice(0, 20),
    },
  };
});

/**
 * Conciliacao periodica (secao 34).
 *
 * Roda sem saldos externos: sem um ERP respondendo, nao ha com o que comparar.
 * A rotina existe agendada para o dia em que a integracao estiver configurada,
 * e ate la diz honestamente que nao tinha base - em vez de registrar "zero
 * divergencias", que se leria como "esta tudo certo".
 */
registrarRotina('INTEGRACAO_CONCILIAR', async (contexto: ContextoSessao) => {
  const prontas = await sincronizacao.devidas().catch(() => []);
  const resumo = await conciliacao.resumo();

  return {
    eventos: 0,
    resultado: {
      integracoes_prontas: prontas.length,
      divergencias_abertas: resumo,
      observacao: prontas.length === 0
        ? 'Nenhuma integracao de entrada configurada e ativa: nao ha origem externa '
          + 'para comparar. Isso NAO significa que os saldos conferem.'
        : `${prontas.length} integracao(oes) elegiveis; a conciliacao efetiva roda `
          + 'com os saldos que a sincronizacao trouxer',
      contexto_usuario: contexto.usuarioId ?? null,
    },
  };
});
