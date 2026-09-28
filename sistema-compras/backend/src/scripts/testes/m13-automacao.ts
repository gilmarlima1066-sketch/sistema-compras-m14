/**
 * Bateria do MODULO 13 - orquestracao, automacao e operacao inteligente.
 *
 * O que esta bateria existe para provar, acima de tudo, sao as NEGATIVAS. Um
 * motor de automacao que cria alertas e tarefas e facil de demonstrar; o que
 * precisa de prova e que ele nao emite pedido sozinho, nao duplica movimentacao
 * quando o mesmo evento chega duas vezes, nao deixa quem pediu aprovar o proprio
 * pedido e nao aceita webhook sem assinatura valida.
 *
 * Por isso a bateria conta, antes e depois, quantas linhas existem em
 * `movimentacoes_estoque`, `ordens_compra` e `recebimentos`: se qualquer um
 * desses numeros mudar por causa de uma automacao, o modulo falhou, por mais
 * verdes que estejam os outros testes.
 *
 * Os dados usam o prefixo M13-.
 */
import { createHash, createHmac } from 'node:crypto';
import { pool, encerrarPool, query } from '../../config/database.js';
import {
  chamar, checar, encerrar, loginAdmin, novaBateria, secao, tokenDoPerfil,
  type Bateria,
} from './base.js';
import { intervaloBackoff } from '../../modules/automacao/fila.service.js';
import { nivelEfetivo, CATALOGO_ACOES } from '../../modules/automacao/acoes.service.js';
import { exigeHumano, ACOES_QUE_EXIGEM_HUMANO } from '../../modules/automacao/aprovacoes.service.js';
import { avaliarCondicao, avaliar } from '../../modules/automacao/regras.service.js';
import { situacao, nivelDevido, perfilDoNivel } from '../../modules/automacao/sla.service.js';
import { chavePadrao } from '../../modules/automacao/eventos.service.js';
import { derivarHash, assinar } from '../../modules/automacao/webhooks.service.js';

const num = (v: unknown) => Number(v ?? 0);
const marca = `M13-${Date.now().toString().slice(-8)}`;

interface Cenario {
  produtoId: number;
  produtoCodigo: string;
  fornecedorId: number;
  movimentacoesIniciais: number;
  pedidosIniciais: number;
  recebimentosIniciais: number;
  lotesIniciais: number;
}

async function contar(tabela: string): Promise<number> {
  const { rows } = await query<{ t: string }>(`SELECT count(*)::text AS t FROM ${tabela}`);
  return Number(rows[0]!.t);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * Esvazia a fila de eventos pendentes antes da bateria comecar.
 *
 * Nao e capricho de limpeza: o ciclo processa os eventos MAIS ANTIGOS primeiro,
 * em lotes. Com novecentos eventos acumulados de execucoes anteriores, o evento
 * que a bateria acabou de criar fica no fim da fila e nao roda - e o teste
 * acusaria o motor por um comportamento que esta certo. O estado inicial precisa
 * ser conhecido para a asercao significar alguma coisa.
 */
async function drenar(admin: string): Promise<number> {
  let ciclos = 0;
  for (; ciclos < 40; ciclos += 1) {
    const { rows } = await query<{ t: string }>(
      "SELECT count(*)::text AS t FROM eventos WHERE status = 'NOVO'");
    if (Number(rows[0]!.t) === 0) break;
    await chamar('POST', '/api/automacao/ciclo', { token: admin });
  }
  return ciclos;
}

async function preparar(): Promise<Cenario> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    const { rows: cat } = await cliente.query<{ id: string }>(
      'SELECT id FROM categorias WHERE ativo ORDER BY id LIMIT 1');
    const { rows: un } = await cliente.query<{ id: string }>(
      'SELECT id FROM unidades ORDER BY id LIMIT 1');

    const { rows: prod } = await cliente.query<{ id: string; codigo: string }>(`
      INSERT INTO produtos
        (codigo, descricao, categoria_id, unidade_compra_id, unidade_estoque_id,
         unidade_venda_id, fator_conversao, ativo, estoque_minimo, estoque_maximo,
         ponto_pedido, lead_time_padrao_dias, controla_lote, controla_validade,
         dias_validade)
      VALUES ($1, $2, $3, $4, $4, $4, 1, true, 10, 200, 40, 7, true, true, 180)
      RETURNING id, codigo`,
    [`${marca}-PROD`, `Produto de teste ${marca}`, cat[0]!.id, un[0]!.id]);

    const { rows: forn } = await cliente.query<{ id: string }>(`
      INSERT INTO fornecedores (razao_social, nome_fantasia, cnpj, ativo)
      VALUES ($1, $1, $2, true)
      RETURNING id`,
    [`FORNECEDOR ${marca}`, String(Date.now()).padStart(14, '0').slice(-14)]);

    await cliente.query(`
      INSERT INTO produto_fornecedor
        (produto_id, fornecedor_id, preco_atual, moq, multiplo_compra,
         lead_time_dias, fornecedor_principal, ativo)
      VALUES ($1, $2, 25.50, 1, 1, 7, true, true)`, [prod[0]!.id, forn[0]!.id]);

    // Fixture idempotente: uma execucao anterior interrompida pode ter deixado
    // a regra de teste para tras, e criar de novo daria conflito de codigo.
    await cliente.query("DELETE FROM automacao_regras WHERE codigo LIKE 'M13%'");

    await cliente.query('COMMIT');

    return {
      produtoId: Number(prod[0]!.id),
      produtoCodigo: prod[0]!.codigo,
      fornecedorId: Number(forn[0]!.id),
      movimentacoesIniciais: 0,
      pedidosIniciais: 0,
      recebimentosIniciais: 0,
      lotesIniciais: 0,
    };
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }
}

async function limpar(c: Cenario): Promise<void> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query("DELETE FROM notificacoes WHERE chave_dedup LIKE $1", [`%${marca}%`]);
    await cliente.query("DELETE FROM tarefas WHERE chave_dedup LIKE $1 OR titulo LIKE $2",
      [`%${marca}%`, `%${marca}%`]);
    await cliente.query("DELETE FROM aprovacoes WHERE chave_dedup LIKE $1 OR titulo LIKE $2",
      [`%${marca}%`, `%${marca}%`]);
    await cliente.query('DELETE FROM alertas WHERE entidade_id = $1 AND entidade = $2',
      [c.produtoId, 'produto']);
    await cliente.query('DELETE FROM automacao_fila WHERE evento_id IN '
      + '(SELECT id FROM eventos WHERE entidade_id = $1)', [c.produtoId]);
    await cliente.query('DELETE FROM eventos WHERE entidade_id = $1', [c.produtoId]);
    await cliente.query('DELETE FROM produto_fornecedor WHERE produto_id = $1', [c.produtoId]);
    await cliente.query('DELETE FROM produtos WHERE id = $1', [c.produtoId]);
    await cliente.query('DELETE FROM fornecedores WHERE id = $1', [c.fornecedorId]);
    await cliente.query("DELETE FROM automacao_regras WHERE codigo LIKE 'M13%'");
    // webhooks_recebidos e append-only: nao se apaga dentro da retencao.
    await cliente.query("DELETE FROM integracoes WHERE codigo = 'M13TESTE'");
    await cliente.query('COMMIT');
  } catch {
    await cliente.query('ROLLBACK');
  } finally {
    cliente.release();
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const baterias: Bateria[] = [];
  const admin = await loginAdmin();
  const cenario = await preparar();

  const ciclosDrenados = await drenar(admin);
  if (ciclosDrenados > 0) {
    console.log(`  (fila de eventos drenada em ${ciclosDrenados} ciclo(s) antes de comecar)`);
  }

  cenario.movimentacoesIniciais = await contar('movimentacoes_estoque');
  cenario.pedidosIniciais = await contar('ordens_compra');
  cenario.recebimentosIniciais = await contar('recebimentos');
  cenario.lotesIniciais = await contar('lotes');

  // =========================================================================
  secao('1. Calculo puro - sem banco, sem API');
  // =========================================================================
  const b1 = novaBateria('Unitarios: backoff, niveis, condicoes e SLA');
  baterias.push(b1);

  checar(b1, 'backoff dobra a cada tentativa (30, 60, 120, 240)',
    intervaloBackoff(1, 30, 3600) === 30 && intervaloBackoff(2, 30, 3600) === 60
    && intervaloBackoff(3, 30, 3600) === 120 && intervaloBackoff(4, 30, 3600) === 240,
    [1, 2, 3, 4].map((t) => intervaloBackoff(t, 30, 3600)));

  checar(b1, 'backoff respeita o teto configurado',
    intervaloBackoff(20, 30, 3600) === 3600, intervaloBackoff(20, 30, 3600));

  checar(b1, 'backoff nao fica negativo na tentativa zero',
    intervaloBackoff(0, 30, 3600) === 30, intervaloBackoff(0, 30, 3600));

  // Secao 9: a trava nao depende do que esta cadastrado na regra.
  for (const acao of ACOES_QUE_EXIGEM_HUMANO) {
    const efetivo = nivelEfetivo(acao, 'AUTOMATICO');
    checar(b1, `${acao} declarada AUTOMATICO e rebaixada para APROVACAO (secao 9)`,
      efetivo.nivel === 'APROVACAO' && Boolean(efetivo.rebaixada), efetivo);
  }

  checar(b1, 'ALERTAR continua AUTOMATICO: so produz informacao',
    nivelEfetivo('ALERTAR', 'AUTOMATICO').nivel === 'AUTOMATICO'
    && !nivelEfetivo('ALERTAR', 'AUTOMATICO').rebaixada);

  checar(b1, 'nenhuma acao do catalogo executavel esta na lista de restritas',
    Object.keys(CATALOGO_ACOES).every((a) => !exigeHumano(a)),
    Object.keys(CATALOGO_ACOES).filter((a) => exigeHumano(a)));

  const payload = { saldo: 0, demanda_diaria: 12, categoria: 'GRAOS', lote: { dias: 15 } };
  checar(b1, 'condicao com operador = compara valor exato',
    avaliarCondicao({ campo: 'categoria', operador: '=', valor: 'GRAOS' }, payload));
  checar(b1, 'condicao com <= compara numero, nao texto',
    avaliarCondicao({ campo: 'saldo', operador: '<=', valor: 0 }, payload));
  checar(b1, 'condicao le caminho com ponto (lote.dias)',
    avaliarCondicao({ campo: 'lote.dias', operador: '<', valor: 30 }, payload));
  checar(b1, 'operador in aceita lista',
    avaliarCondicao({ campo: 'categoria', operador: 'in', valor: ['GRAOS', 'TEMPEROS'] }, payload));
  checar(b1, 'operador entre respeita os dois limites',
    avaliarCondicao({ campo: 'demanda_diaria', operador: 'entre', valor: [10, 20] }, payload)
    && !avaliarCondicao({ campo: 'demanda_diaria', operador: 'entre', valor: [20, 30] }, payload));
  checar(b1, 'campo inexistente nao passa em existe',
    !avaliarCondicao({ campo: 'inexistente', operador: 'existe' }, payload));
  checar(b1, 'lista de condicoes vazia dispara sempre',
    avaliar([], payload).aprovada);
  checar(b1, 'todas as condicoes precisam passar (E, nao OU)',
    !avaliar([
      { campo: 'saldo', operador: '<=', valor: 0 },
      { campo: 'categoria', operador: '=', valor: 'OUTRA' },
    ], payload).aprovada);

  const criado = new Date(Date.now() - 3 * 3600_000);
  const vence = new Date(criado.getTime() + 4 * 3600_000);
  const sit = situacao(criado, vence, 50);
  checar(b1, 'SLA com 75% consumido e alerta em 50% fica EM_RISCO',
    sit.status === 'EM_RISCO', sit);
  checar(b1, 'SLA vencido e reportado como VENCIDO com horas negativas',
    situacao(criado, new Date(Date.now() - 3600_000), 50).status === 'VENCIDO');
  checar(b1, 'tarefa sem prazo fica DENTRO, sem inventar percentual',
    situacao(criado, null, 80).status === 'DENTRO'
    && situacao(criado, null, 80).percentual_consumido === null);

  const politica = {
    id: 1, codigo: 'X', nome: 'X', etapa: 'X', horas: 4, alerta_percentual: 50,
    escalonar_nivel1_horas: 4, escalonar_nivel2_horas: 8, escalonar_nivel3_horas: 24,
    perfil_nivel1: 'COMPRADOR', perfil_nivel2: 'GESTOR_COMPRAS', perfil_nivel3: 'DIRETORIA',
  };
  checar(b1, 'escalonamento so comeca apos a primeira faixa',
    nivelDevido(politica, 3) === 0 && nivelDevido(politica, 4) === 1);
  checar(b1, 'esquecida por muito tempo sobe direto ao nivel mais alto',
    nivelDevido(politica, 100) === 3, nivelDevido(politica, 100));
  checar(b1, 'cada nivel aponta para o perfil certo',
    perfilDoNivel(politica, 1) === 'COMPRADOR'
    && perfilDoNivel(politica, 3) === 'DIRETORIA'
    && perfilDoNivel(politica, 0) === null);

  checar(b1, 'chave de idempotencia inclui a data: o fato se repete a cada dia',
    chavePadrao('STOCK_OUT', 'produto', 7).includes(new Date().toISOString().slice(0, 10)),
    chavePadrao('STOCK_OUT', 'produto', 7));
  checar(b1, 'mesma entidade e mesmo dia produzem a mesma chave',
    chavePadrao('STOCK_OUT', 'produto', 7) === chavePadrao('STOCK_OUT', 'produto', 7));
  checar(b1, 'entidades diferentes produzem chaves diferentes',
    chavePadrao('STOCK_OUT', 'produto', 7) !== chavePadrao('STOCK_OUT', 'produto', 8));

  // =========================================================================
  secao('2. Evento, regra e fila (secoes 6 a 8, 22 a 24)');
  // =========================================================================
  const b2 = novaBateria('Motor: evento -> regra -> fila -> acao');
  baterias.push(b2);

  const corpoEvento = {
    tipo: 'STOCK_OUT', origem: 'ESTOQUE', entidade: 'produto',
    entidade_id: cenario.produtoId,
    payload: {
      sku: cenario.produtoCodigo, produto_nome: `Produto de teste ${marca}`,
      saldo: 0, demanda_diaria: 12.5, cobertura_dias: 0,
    },
  };

  const { status: st1, corpo: ev1 } = await chamar('POST', '/api/automacao/eventos',
    { token: admin, corpo: corpoEvento });
  checar(b2, 'evento registrado (201)', st1 === 201, { st1, ev1 });
  checar(b2, 'evento nasce como novo', ev1?.data?.novo === true, ev1?.data);

  const correlation = ev1?.data?.correlation_id;
  checar(b2, 'evento recebe correlation_id', typeof correlation === 'string');

  const { corpo: ev2 } = await chamar('POST', '/api/automacao/eventos',
    { token: admin, corpo: corpoEvento });
  checar(b2, 'CASO CRITICO: reregistrar o mesmo fato nao cria evento novo (secao 22)',
    ev2?.data?.novo === false && ev2?.data?.id === ev1?.data?.id,
    { primeiro: ev1?.data?.id, segundo: ev2?.data?.id, novo: ev2?.data?.novo });

  const { corpo: ciclo1 } = await chamar('POST', '/api/automacao/ciclo', { token: admin });
  checar(b2, 'o ciclo processa o evento pendente',
    num(ciclo1?.data?.eventos?.eventos_lidos) >= 1, ciclo1?.data?.eventos);
  checar(b2, 'a regra EST_RUPTURA e disparada pelo evento STOCK_OUT',
    (ciclo1?.data?.eventos?.detalhes ?? []).some((d: any) =>
      (d.regras ?? []).includes('EST_RUPTURA')),
    ciclo1?.data?.eventos?.detalhes);
  checar(b2, 'a acao da fila e executada no mesmo ciclo',
    num(ciclo1?.data?.fila?.concluidos) >= 1, ciclo1?.data?.fila);
  checar(b2, 'a execucao nao reporta falha',
    num(ciclo1?.data?.fila?.falhas) === 0, ciclo1?.data?.fila?.execucoes);

  const { corpo: rastro1 } = await chamar('GET', `/api/automacao/rastrear/${correlation}`,
    { token: admin });
  checar(b2, 'rastreio encontra o evento (secao 35)', rastro1?.data?.encontrado === true);
  checar(b2, 'rastreio traz a execucao', (rastro1?.data?.execucoes?.length ?? 0) >= 1);
  checar(b2, 'a execucao registra QUAL regra decidiu',
    rastro1?.data?.execucoes?.[0]?.regra === 'EST_RUPTURA',
    rastro1?.data?.execucoes?.[0]);
  checar(b2, 'a execucao registra a VERSAO da regra que rodou',
    num(rastro1?.data?.execucoes?.[0]?.regra_versao) >= 1,
    rastro1?.data?.execucoes?.[0]?.regra_versao);
  checar(b2, 'CASO CRITICO: o evento gerou uma tarefa (secao 18)',
    (rastro1?.data?.tarefas?.length ?? 0) === 1, rastro1?.data?.tarefas);
  checar(b2, 'a tarefa nasceu com prazo de SLA',
    Boolean(rastro1?.data?.tarefas?.[0]?.prazo), rastro1?.data?.tarefas?.[0]);

  const tarefasDepoisDoPrimeiro = rastro1?.data?.tarefas?.length ?? 0;

  // Terceira passagem: nada pode duplicar.
  await chamar('POST', '/api/automacao/eventos', { token: admin, corpo: corpoEvento });
  await chamar('POST', '/api/automacao/ciclo', { token: admin });
  const { corpo: rastro2 } = await chamar('GET', `/api/automacao/rastrear/${correlation}`,
    { token: admin });
  checar(b2, 'CASO CRITICO: reexecutar nao duplica tarefa (secao 22)',
    (rastro2?.data?.tarefas?.length ?? 0) === tarefasDepoisDoPrimeiro,
    { antes: tarefasDepoisDoPrimeiro, depois: rastro2?.data?.tarefas?.length });

  const { rows: alertas } = await query<{
    t: string; ocorrencias: string; origens: string | null;
  }>(`SELECT count(*)::text AS t, max(ocorrencias)::text AS ocorrencias,
             string_agg(DISTINCT origem, ', ') AS origens
        FROM alertas
       WHERE entidade = 'produto' AND entidade_id = $1`, [cenario.produtoId]);
  checar(b2, 'CASO CRITICO: reexecutar o evento nao duplica alerta',
    Number(alertas[0]!.t) === 1, alertas[0]);

  // A deduplicacao acontece em DUAS camadas, e a segunda merece prova propria:
  // a primeira barra o EVENTO repetido, entao a acao nem chega a rodar de novo -
  // foi por isso que o contador de ocorrencias ficou em 1 acima. Para exercitar
  // a camada do alerta e preciso a acao rodar duas vezes, o que a execucao
  // avulsa permite.
  //
  // A chave de deduplicacao inclui a REGRA, e isso e proposital: duas regras
  // diferentes olhando o mesmo fato tem motivos e prioridades diferentes, e
  // devem produzir alertas separados. Por isso os dois disparos abaixo usam a
  // mesma regra de origem - senao nao estariamos testando deduplicacao.
  const acaoAvulsa = {
    acao: 'ALERTAR', nivel: 'AUTOMATICO', evento_tipo: 'STOCK_OUT',
    entidade: 'produto', entidade_id: cenario.produtoId,
    parametros: { tipo_alerta: 'RUPTURA', prioridade: 'CRITICO' },
    payload: corpoEvento.payload,
  };
  await chamar('POST', '/api/automacao/acoes/executar', { token: admin, corpo: acaoAvulsa });
  await chamar('POST', '/api/automacao/acoes/executar', { token: admin, corpo: acaoAvulsa });

  const { rows: alertasApos } = await query<{ t: string; ocorrencias: string }>(
    `SELECT count(*)::text AS t, max(ocorrencias)::text AS ocorrencias FROM alertas
      WHERE entidade = 'produto' AND entidade_id = $1
        AND origem = 'automacao:AVULSA'`, [cenario.produtoId]);
  checar(b2, 'CASO CRITICO: a acao repetida reabre o MESMO alerta e conta ocorrencia',
    Number(alertasApos[0]!.t) === 1 && Number(alertasApos[0]!.ocorrencias) >= 2,
    alertasApos[0]);

  const { corpo: estat } = await chamar('GET', '/api/automacao/fila/estatisticas',
    { token: admin });
  checar(b2, 'estatisticas da fila respondem', estat?.success === true, estat?.data);

  // =========================================================================
  secao('3. Simulacao de regra e execucao avulsa (secao 34)');
  // =========================================================================
  const b3 = novaBateria('Regras: criacao, versao e ensaio');
  baterias.push(b3);

  const { status: stRegra, corpo: regraNova } = await chamar('POST', '/api/automacao/regras', {
    token: admin,
    corpo: {
      codigo: 'M13_TESTE', nome: `Regra de teste ${marca}`, evento: 'STOCK_LOW',
      condicao: [{ campo: 'cobertura_dias', operador: '<', valor: 5 }],
      acao: 'ALERTAR', nivel: 'AUTOMATICO', prioridade: 500,
      parametros: { tipo_alerta: 'RISCO_RUPTURA', prioridade: 'ALTO' },
    },
  });
  checar(b3, 'regra criada pela API (201)', stRegra === 201, { stRegra, regraNova });
  const regraId = regraNova?.data?.id;
  checar(b3, 'regra nasce na versao 1', num(regraNova?.data?.versao) === 1, regraNova?.data);

  const { corpo: sim1 } = await chamar('POST', `/api/automacao/regras/${regraId}/simular`, {
    token: admin, corpo: { payload: { cobertura_dias: 2 } },
  });
  checar(b3, 'simulacao aprova o payload que atende a condicao',
    sim1?.data?.dispararia === true, sim1?.data);

  const { corpo: sim2 } = await chamar('POST', `/api/automacao/regras/${regraId}/simular`, {
    token: admin, corpo: { payload: { cobertura_dias: 40 } },
  });
  checar(b3, 'simulacao recusa o payload que nao atende',
    sim2?.data?.dispararia === false, sim2?.data);
  checar(b3, 'a simulacao mostra condicao por condicao, com o valor que veio',
    Array.isArray(sim2?.data?.condicoes) && sim2.data.condicoes.length === 1
    && sim2.data.condicoes[0].valor_no_payload === 40
    && sim2.data.condicoes[0].passou === false, sim2?.data?.condicoes);

  const { rows: antesSimulacao } = await query<{ t: string }>(
    "SELECT count(*)::text AS t FROM alertas WHERE tipo = 'RISCO_RUPTURA'");
  const { corpo: sim3 } = await chamar('POST', `/api/automacao/regras/${regraId}/simular`, {
    token: admin, corpo: { payload: { cobertura_dias: 1 } },
  });
  const { rows: depoisSimulacao } = await query<{ t: string }>(
    "SELECT count(*)::text AS t FROM alertas WHERE tipo = 'RISCO_RUPTURA'");
  checar(b3, 'CASO CRITICO: simular NAO executa a acao (ensaio e ensaio)',
    antesSimulacao[0]!.t === depoisSimulacao[0]!.t,
    { antes: antesSimulacao[0]!.t, depois: depoisSimulacao[0]!.t, sim3: sim3?.data });

  const { corpo: regraEditada } = await chamar('PUT', `/api/automacao/regras/${regraId}`, {
    token: admin, corpo: { prioridade: 600 },
  });
  checar(b3, 'editar a regra sobe a versao (rastreabilidade da secao 35)',
    num(regraEditada?.data?.versao) === 2, regraEditada?.data);

  // =========================================================================
  secao('4. Aprovacao, alcada e segregacao de funcoes (secoes 9, 14 a 16)');
  // =========================================================================
  const b4 = novaBateria('Aprovacoes: alcada, excecao e quem pode decidir');
  baterias.push(b4);

  const gestor = await tokenDoPerfil(admin, 'GESTOR_COMPRAS', marca);
  const comprador = await tokenDoPerfil(admin, 'COMPRADOR', marca);
  const diretor = await tokenDoPerfil(admin, 'DIRETORIA', marca);
  checar(b4, 'usuarios de teste criados para os tres perfis',
    Boolean(gestor && comprador && diretor));

  // Faixas de alcada, lidas da mesma tabela que o modulo 08 usa.
  const faixas: Array<[number, string]> = [
    [5000, 'COMPRADOR'], [25000, 'GESTOR_COMPRAS'], [500000, 'DIRETORIA'],
  ];
  const criadas: number[] = [];
  for (const [valor, perfilEsperado] of faixas) {
    const { corpo } = await chamar('POST', '/api/automacao/aprovacoes', {
      token: admin,
      corpo: {
        tipo: 'M13_FAIXA', titulo: `${marca} faixa ${valor}`, entidade: 'evento',
        valor_avaliado: valor,
      },
    });
    criadas.push(corpo?.data?.id);
    checar(b4, `valor ${valor} cai na alcada ${perfilEsperado}`,
      corpo?.data?.perfil_exigido === perfilEsperado, corpo?.data);
  }

  const { status: stExcecao, corpo: semMotivo } = await chamar('POST', '/api/automacao/aprovacoes', {
    token: admin,
    corpo: {
      tipo: 'M13_EXCECAO', titulo: `${marca} sem motivo`, entidade: 'produto',
      excecao: true, valor_avaliado: 100,
    },
  });
  checar(b4, 'CASO CRITICO: excecao sem motivo e recusada (secao 16)',
    stExcecao >= 400, { stExcecao, semMotivo });

  const { corpo: comMotivo } = await chamar('POST', '/api/automacao/aprovacoes', {
    token: gestor ?? admin,
    corpo: {
      tipo: 'M13_EXCECAO', titulo: `${marca} com motivo`, entidade: 'produto',
      entidade_id: cenario.produtoId, excecao: true, valor_avaliado: 25000,
      motivo_excecao: 'Compra emergencial acima do preco historico por ruptura confirmada',
    },
  });
  const excecaoId = comMotivo?.data?.id;
  checar(b4, 'excecao com motivo e aceita', Boolean(excecaoId), comMotivo);

  const { status: stProprio } = await chamar(
    `POST`, `/api/automacao/aprovacoes/${excecaoId}/aprovar`,
    { token: gestor ?? admin, corpo: { justificativa: 'tentando aprovar o proprio pedido' } });
  checar(b4, 'CASO CRITICO: quem solicitou nao aprova o proprio pedido (segregacao)',
    stProprio === 403, stProprio);

  const { status: stPerfilErrado } = await chamar(
    'POST', `/api/automacao/aprovacoes/${excecaoId}/aprovar`,
    { token: comprador ?? admin, corpo: { justificativa: 'perfil abaixo da alcada' } });
  checar(b4, 'CASO CRITICO: perfil fora da alcada nao decide',
    stPerfilErrado === 403, stPerfilErrado);

  const { status: stSemJustificativa } = await chamar(
    'POST', `/api/automacao/aprovacoes/${excecaoId}/rejeitar`,
    { token: admin, corpo: {} });
  checar(b4, 'rejeicao sem justificativa e recusada',
    stSemJustificativa >= 400, stSemJustificativa);

  const { status: stAprovar, corpo: aprovada } = await chamar(
    'POST', `/api/automacao/aprovacoes/${excecaoId}/aprovar`,
    { token: admin, corpo: { justificativa: 'Aprovado pela bateria de teste' } });
  checar(b4, 'ADMIN decide qualquer alcada (mas nao a propria solicitacao)',
    stAprovar === 200 && aprovada?.data?.status === 'APROVADA', { stAprovar, aprovada });

  const { status: stDuasVezes } = await chamar(
    'POST', `/api/automacao/aprovacoes/${excecaoId}/aprovar`,
    { token: admin, corpo: { justificativa: 'segunda vez' } });
  checar(b4, 'CASO CRITICO: aprovacao ja decidida nao e decidida de novo',
    stDuasVezes >= 400, stDuasVezes);

  const { corpo: filaDiretor } = await chamar('GET', '/api/automacao/aprovacoes/minha-fila',
    { token: diretor ?? admin });
  checar(b4, 'a fila do diretor traz a aprovacao de 500 mil',
    (filaDiretor?.data ?? []).some((a: any) => a.id === criadas[2]),
    (filaDiretor?.data ?? []).map((a: any) => a.id));
  checar(b4, 'a fila do diretor NAO traz a aprovacao de 5 mil (alcada do comprador)',
    !(filaDiretor?.data ?? []).some((a: any) => a.id === criadas[0]));

  // Secao 9, ponta a ponta pela API.
  const { corpo: restrita } = await chamar('POST', '/api/automacao/acoes/executar', {
    token: admin,
    corpo: {
      acao: 'EMITIR_PEDIDO', nivel: 'AUTOMATICO', evento_tipo: 'PURCHASE_NEED_CRITICAL',
      entidade: 'produto', entidade_id: cenario.produtoId,
      payload: { produto_nome: `Produto ${marca}`, valor: 25000 },
    },
  });
  checar(b4, 'CASO CRITICO: EMITIR_PEDIDO automatico vira solicitacao de aprovacao (secao 9)',
    restrita?.data?.nivel_aplicado === 'APROVACAO'
    && Boolean(restrita?.data?.aprovacao_id), restrita?.data);
  checar(b4, 'o rebaixamento fica registrado no resultado, para a auditoria',
    typeof restrita?.data?.rebaixada === 'string', restrita?.data?.rebaixada);

  // =========================================================================
  secao('5. Tarefas, SLA e escalonamento (secoes 17 a 21)');
  // =========================================================================
  const b5 = novaBateria('Tarefas e SLA em tres niveis');
  baterias.push(b5);

  const { status: stTarefa, corpo: tarefaNova } = await chamar('POST', '/api/automacao/tarefas', {
    token: admin,
    corpo: {
      tipo: 'RUPTURA', titulo: `${marca} tarefa de SLA`,
      descricao: 'Tarefa criada pela bateria para exercitar o escalonamento',
      perfil_destino: 'COMPRADOR', prioridade: 'ALTA',
      entidade: 'produto', entidade_id: cenario.produtoId,
    },
  });
  checar(b5, 'tarefa criada pela API (201)', stTarefa === 201, { stTarefa, tarefaNova });
  const tarefaId = tarefaNova?.data?.id;
  checar(b5, 'a tarefa herda o prazo da politica RUPTURA (4h)',
    num(tarefaNova?.data?.sla_horas) === 4, tarefaNova?.data);
  checar(b5, 'a criacao notifica o perfil de destino',
    num(tarefaNova?.data?.notificados) >= 1, tarefaNova?.data);

  // Envelhece a tarefa para forcar o escalonamento.
  await query(`UPDATE tarefas SET created_at = now() - interval '30 hours',
                 sla_vence_em = now() - interval '26 hours' WHERE id = $1`, [tarefaId]);

  const { corpo: varre1 } = await chamar('POST', '/api/automacao/tarefas/varrer-sla',
    { token: admin });
  checar(b5, 'a varredura marca a tarefa vencida', num(varre1?.data?.vencidas) >= 1,
    varre1?.data);
  checar(b5, 'CASO CRITICO: tarefa esquecida por 30h sobe ao nivel 3 (secao 20)',
    (varre1?.data?.detalhes ?? []).some((d: any) =>
      d.tarefa_id === tarefaId && d.nivel_novo === 3 && d.perfil_alvo === 'DIRETORIA'),
    (varre1?.data?.detalhes ?? []).filter((d: any) => d.tarefa_id === tarefaId));

  const { corpo: varre2 } = await chamar('POST', '/api/automacao/tarefas/varrer-sla',
    { token: admin });
  checar(b5, 'CASO CRITICO: varrer de novo nao escalona nem notifica duas vezes',
    !(varre2?.data?.detalhes ?? []).some((d: any) => d.tarefa_id === tarefaId),
    varre2?.data?.detalhes);

  const { corpo: assumir } = await chamar('POST', `/api/automacao/tarefas/${tarefaId}/assumir`,
    { token: comprador ?? admin });
  checar(b5, 'comprador assume a tarefa', assumir?.success === true, assumir);

  const { corpo: concluir } = await chamar('POST', `/api/automacao/tarefas/${tarefaId}/concluir`,
    { token: comprador ?? admin, corpo: { observacao: 'Resolvido pela bateria' } });
  checar(b5, 'tarefa concluida fora do prazo e registrada como VENCIDO',
    concluir?.data?.sla_status === 'VENCIDO', concluir?.data);

  const { status: stConcluirDeNovo } = await chamar(
    'POST', `/api/automacao/tarefas/${tarefaId}/concluir`,
    { token: comprador ?? admin, corpo: {} });
  checar(b5, 'tarefa ja concluida nao e concluida de novo',
    stConcluirDeNovo >= 400, stConcluirDeNovo);

  const { corpo: desempenho } = await chamar('GET', '/api/automacao/sla/desempenho?dias=30',
    { token: admin });
  const linhaEstoque = (desempenho?.data ?? []).find((l: any) => l.etapa === 'ESTOQUE');
  checar(b5, 'o cumprimento de SLA se mede sobre tarefas ENCERRADAS, nao abertas',
    !linhaEstoque || linhaEstoque.cumprimento_percentual === null
    || num(linhaEstoque.encerradas_com_sla) > 0, linhaEstoque);

  const { corpo: politicas } = await chamar('GET', '/api/automacao/sla/politicas',
    { token: admin });
  checar(b5, 'as 15 politicas de SLA do catalogo respondem',
    (politicas?.data?.length ?? 0) >= 15, politicas?.data?.length);

  // =========================================================================
  secao('6. Detectores (secao 12)');
  // =========================================================================
  const b6 = novaBateria('Detectores: leem os modulos anteriores, nao recalculam');
  baterias.push(b6);

  const { corpo: catalogoDet } = await chamar('GET', '/api/automacao/detectores',
    { token: admin });
  checar(b6, 'o catalogo de detectores responde',
    (catalogoDet?.data?.detectores?.length ?? 0) >= 15, catalogoDet?.data?.detectores?.length);

  const { corpo: rodada } = await chamar('POST', '/api/automacao/detectores/rodar',
    { token: admin, corpo: { grupo: 'estoque' } });
  checar(b6, 'o grupo estoque roda sem erro de detector',
    (rodada?.data?.erros?.length ?? 0) === 0, rodada?.data?.erros);
  checar(b6, 'os detectores de estoque produzem resultado',
    (rodada?.data?.resultados?.length ?? 0) === 5, rodada?.data?.resultados?.length);

  const { corpo: rodada2 } = await chamar('POST', '/api/automacao/detectores/rodar',
    { token: admin, corpo: { grupo: 'estoque' } });
  checar(b6, 'CASO CRITICO: rodar o detector duas vezes nao cria evento novo',
    num(rodada2?.data?.novos) === 0, rodada2?.data?.novos);

  // Contrato regra x detector. Cinco das oito regras com condicao ficaram
  // inertes por nome de campo trocado, e nada acusava: a regra aparecia ativa e
  // vigente na tela. Esta verificacao existe para a falha nao voltar calada.
  await chamar('POST', '/api/automacao/detectores/rodar',
    { token: admin, corpo: { grupo: 'todos' } });

  const { rows: contratoQuebrado } = await query<{
    codigo: string; campo_exigido: string;
  }>(`SELECT codigo, campo_exigido FROM vw_regras_contrato
       WHERE NOT campo_existe AND evento_ja_ocorreu`);
  checar(b6, 'CASO CRITICO: nenhuma regra exige campo que o detector nao emite',
    contratoQuebrado.length === 0, contratoQuebrado);

  const { corpo: diagContrato } = await chamar(
    'GET', '/api/automacao/operacao/diagnostico', { token: admin });
  checar(b6, 'o diagnostico sabe apontar regra que nunca vai disparar',
    Array.isArray(diagContrato?.data?.sintomas), diagContrato?.data?.gravidade);

  const { corpo: fornecedores } = await chamar('POST', '/api/automacao/detectores/rodar',
    { token: admin, corpo: { detectores: ['aumento_preco'] } });
  const resultadoPreco = fornecedores?.data?.resultados?.[0];
  checar(b6, 'detector sem evento explica o motivo, em vez de silenciar',
    num(resultadoPreco?.eventos) > 0 || typeof resultadoPreco?.motivo_sem_evento === 'string',
    resultadoPreco);

  // =========================================================================
  secao('7. Jobs e agendador (secoes 29 a 31)');
  // =========================================================================
  const b7 = novaBateria('Jobs: agenda, trava e historico');
  baterias.push(b7);

  const { corpo: listaJobs } = await chamar('GET', '/api/automacao/jobs', { token: admin });
  const jobsLista = listaJobs?.data ?? [];
  checar(b7, 'os 10 jobs do catalogo respondem', jobsLista.length >= 10, jobsLista.length);
  checar(b7, 'CASO CRITICO: todo job cadastrado tem rotina implementada',
    jobsLista.every((j: any) => j.tem_rotina),
    jobsLista.filter((j: any) => !j.tem_rotina).map((j: any) => j.codigo));

  const { corpo: execJob } = await chamar('POST', '/api/automacao/jobs/VERIFICAR_SLA/executar',
    { token: admin });
  checar(b7, 'job executado manualmente conclui',
    execJob?.data?.status === 'CONCLUIDO', execJob?.data);

  const { corpo: jobsDepois } = await chamar('GET', '/api/automacao/jobs', { token: admin });
  const verificarSla = (jobsDepois?.data ?? []).find((j: any) => j.codigo === 'VERIFICAR_SLA');
  checar(b7, 'o job registra a ultima execucao', Boolean(verificarSla?.ultima_execucao));
  checar(b7, 'o job reagenda a proxima execucao', Boolean(verificarSla?.proxima_execucao),
    verificarSla);
  checar(b7, 'o job volta ao estado OCIOSO depois de rodar',
    verificarSla?.status === 'OCIOSO', verificarSla?.status);

  const { corpo: historicoJob } = await chamar(
    'GET', '/api/automacao/jobs/historico?codigo=VERIFICAR_SLA&limite=5', { token: admin });
  checar(b7, 'o historico do job guarda o resultado',
    (historicoJob?.data?.length ?? 0) >= 1 && Boolean(historicoJob.data[0].resultado),
    historicoJob?.data?.[0]);

  const { status: stJobInexistente, corpo: jobInexistente } = await chamar(
    'POST', '/api/automacao/jobs/NAO_EXISTE/executar', { token: admin });
  checar(b7, 'job inexistente devolve 404 com mensagem util',
    stJobInexistente === 404 && jobInexistente?.success === false
    && /NAO_EXISTE/.test(jobInexistente?.error?.message ?? ''),
    { stJobInexistente, jobInexistente });

  // Recuperacao de worker morto. Este caminho so roda quando ha item travado,
  // entao ele fica sem exercicio na operacao normal - e foi exatamente onde um
  // defeito (falta de cast de enum) passou despercebido ate a primeira carga
  // real. A rotina que conserta o sistema quebrado precisa de teste proprio.
  await query(`
    INSERT INTO automacao_fila
      (acao, parametros, correlation_id, status, tentativa, max_tentativas, iniciado_em)
    VALUES ('ALERTAR', '{}'::jsonb, gen_random_uuid(), 'PROCESSANDO', 1, 3,
            now() - interval '2 hours')`);

  const { corpo: comTravado } = await chamar(
    'POST', '/api/automacao/jobs/PROCESSAR_FILA/executar', { token: admin });
  checar(b7, 'CASO CRITICO: item travado por worker morto volta para a fila',
    comTravado?.data?.status === 'CONCLUIDO', comTravado?.data);

  const { rows: travadosRestantes } = await query<{ t: string }>(`
    SELECT count(*)::text AS t FROM automacao_fila
     WHERE status = 'PROCESSANDO' AND iniciado_em < now() - interval '1 hour'`);
  checar(b7, 'nao sobra item preso em PROCESSANDO apos a recuperacao',
    Number(travadosRestantes[0]!.t) === 0, travadosRestantes[0]);

  // Trava de concorrencia: duas chamadas ao mesmo tempo, uma so executa.
  const [par1, par2] = await Promise.all([
    chamar('POST', '/api/automacao/jobs/LIMPEZA/executar', { token: admin }),
    chamar('POST', '/api/automacao/jobs/LIMPEZA/executar', { token: admin }),
  ]);
  const estados = [par1.corpo?.data?.status, par2.corpo?.data?.status];
  checar(b7, 'CASO CRITICO: duas chamadas simultaneas do mesmo job - so uma executa',
    estados.filter((e) => e === 'CONCLUIDO').length === 1
    && estados.filter((e) => e === 'IGNORADO').length === 1, estados);

  // =========================================================================
  secao('8. Webhooks e integracoes (secoes 36 a 38)');
  // =========================================================================
  const b8 = novaBateria('Webhook: assinatura, replay e idempotencia');
  baterias.push(b8);

  const segredo = 'segredo-de-teste-m13-com-mais-de-16';
  // O indice unico e por expressao (upper(codigo)), entao ON CONFLICT (codigo)
  // nao casa com ele. Recriar a integracao e mais simples que replicar a
  // expressao. Os webhooks recebidos NAO sao apagados: a tabela e append-only e
  // recusa exclusao dentro da retencao - e esta certa em recusar. As chaves de
  // idempotencia levam a marca do tempo, entao cada execucao da bateria usa
  // chaves proprias e nao esbarra nas anteriores.
  await query("DELETE FROM integracoes WHERE upper(codigo) = 'M13TESTE'");
  await query(`
    INSERT INTO integracoes (codigo, nome, tipo, sistema, conector, direcao, ativo,
                             segredo_hash)
    VALUES ('M13TESTE', 'Integracao de teste M13', 'TESTE', 'OUTRO', 'WEBHOOK',
            'ENTRADA', true, $1)`,
  [derivarHash(segredo)]);

  const hashSegredo = derivarHash(segredo);
  checar(b8, 'o segredo e guardado como hash, nunca em texto puro (secao 36)',
    hashSegredo !== segredo && hashSegredo.length === 64, hashSegredo.slice(0, 12));

  const { rows: guardado } = await query<{ segredo_hash: string }>(
    "SELECT segredo_hash FROM integracoes WHERE codigo = 'M13TESTE'");
  checar(b8, 'o segredo em claro nao aparece no banco',
    guardado[0]!.segredo_hash !== segredo);

  const enviar = async (corpo: Record<string, unknown>, assinatura?: string) => {
    const texto = JSON.stringify(corpo);
    const resposta = await fetch(
      `${process.env.BASE_URL ?? 'http://localhost:3333'}/api/webhooks/M13TESTE`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-assinatura': assinatura ?? assinar(texto, hashSegredo),
        },
        body: texto,
      });
    return {
      status: resposta.status,
      corpo: (await resposta.json().catch(() => null)) as any,
    };
  };

  const chaveUnica = `${marca}-wh-1`;
  const corpoOk = {
    evento: 'pedido.confirmado', chave_idempotencia: chaveUnica,
    timestamp: new Date().toISOString(), numero_pedido: 'PC-2026-000999',
  };

  const semAssinatura = await enviar(corpoOk, 'assinatura-errada-de-proposito');
  checar(b8, 'CASO CRITICO: webhook com assinatura invalida e recusado (400)',
    semAssinatura.status === 400 && semAssinatura.corpo?.data?.status === 'REJEITADO'
    && semAssinatura.corpo?.success === false,
    semAssinatura);

  const aceito = await enviar(corpoOk);
  checar(b8, 'webhook com assinatura valida e aceito (202)',
    aceito.status === 202 && aceito.corpo?.data?.status === 'PROCESSADO', aceito);
  checar(b8, 'o webhook aceito vira EVENTO, nao acao direta',
    num(aceito.corpo?.data?.evento_id) > 0, aceito.corpo?.data);

  checar(b8, 'CASO CRITICO: recusa por assinatura NAO reserva a chave; '
    + 'o reenvio corrigido do parceiro e aceito (migration 047)',
  aceito.corpo?.data?.status === 'PROCESSADO', aceito.corpo?.data);

  const repetido = await enviar(corpoOk);
  checar(b8, 'CASO CRITICO: o mesmo webhook reenviado nao reprocessa (secao 22)',
    repetido.corpo?.data?.status === 'DUPLICADO', repetido.corpo?.data);

  const antigo = {
    ...corpoOk, chave_idempotencia: `${marca}-wh-antigo`,
    timestamp: new Date(Date.now() - 60 * 60_000).toISOString(),
  };
  const replay = await enviar(antigo);
  checar(b8, 'CASO CRITICO: webhook antigo e bem assinado e recusado (anti-replay)',
    replay.status === 400 && /tempo/i.test(replay.corpo?.data?.motivo ?? ''),
    replay.corpo?.data);

  const desconhecida = await fetch(
    `${process.env.BASE_URL ?? 'http://localhost:3333'}/api/webhooks/NAO_EXISTE`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-assinatura': 'qualquer' },
      body: JSON.stringify({ a: 1 }),
    });
  checar(b8, 'integracao desconhecida e recusada', desconhecida.status === 400,
    desconhecida.status);

  const { corpo: recebidos } = await chamar(
    'GET', '/api/automacao/webhooks?integracao=M13TESTE', { token: admin });
  checar(b8, 'todo webhook fica registrado, inclusive os recusados',
    num(recebidos?.data?.total) >= 4, recebidos?.data?.total);
  checar(b8, 'a listagem nao devolve o payload inteiro por padrao',
    (recebidos?.data?.webhooks ?? []).every((w: any) => w.payload === undefined),
    Object.keys(recebidos?.data?.webhooks?.[0] ?? {}));

  const { corpo: detalhe } = await chamar(
    `GET`, `/api/automacao/webhooks/${aceito.corpo?.data?.id}`, { token: admin });
  const cabecalhos = detalhe?.data?.cabecalhos ?? {};
  checar(b8, 'CASO CRITICO: cabecalhos sensiveis sao mascarados no registro (secao 36)',
    !Object.entries(cabecalhos).some(([k, v]) =>
      ['authorization', 'cookie', 'x-api-key'].includes(k.toLowerCase())
      && v !== '[removido]'),
    cabecalhos);
  checar(b8, 'a assinatura e guardada truncada, nunca inteira',
    typeof detalhe?.data?.assinatura !== 'string'
    || detalhe.data.assinatura.length <= 16, detalhe?.data?.assinatura);

  const { corpo: integracoes } = await chamar('GET', '/api/automacao/integracoes',
    { token: admin });
  const semSegredo = (integracoes?.data ?? []).filter((i: any) => i.ativo && !i.tem_segredo);
  checar(b8, 'a listagem de integracoes avisa quando falta segredo',
    semSegredo.every((i: any) => i.pronta === false), semSegredo);

  // =========================================================================
  secao('9. Permissoes (secao 36)');
  // =========================================================================
  const b9 = novaBateria('Permissoes e escopo');
  baterias.push(b9);

  const { status: semToken } = await chamar('GET', '/api/automacao/eventos');
  checar(b9, 'sem token a API recusa (401)', semToken === 401, semToken);

  const comercial = await tokenDoPerfil(admin, 'COMERCIAL', marca);
  if (comercial) {
    for (const rota of [
      ['GET', '/api/automacao/operacao/painel'],
      ['POST', '/api/automacao/ciclo'],
      ['POST', '/api/automacao/regras'],
    ] as const) {
      const { status } = await chamar(rota[0], rota[1], {
        token: comercial,
        ...(rota[0] === 'GET' ? {} : { corpo: {} }),
      });
      checar(b9, `perfil sem permissao nao acessa ${rota[0]} ${rota[1]}`,
        status === 403, { rota, status });
    }
  }

  const { status: stAprovarSemPerm } = await chamar(
    'POST', `/api/automacao/aprovacoes/${criadas[0]}/aprovar`,
    { token: comercial ?? admin, corpo: { justificativa: 'sem permissao' } });
  checar(b9, 'perfil sem automacao.aprovar nao decide aprovacao',
    stAprovarSemPerm === 403, stAprovarSemPerm);

  // As notificacoes de cada um sao dele: o filtro nao vem do cliente.
  const { corpo: notifComprador } = await chamar('GET', '/api/automacao/notificacoes',
    { token: comprador ?? admin });
  const { rows: donoDasNotificacoes } = await query<{ t: string }>(`
    SELECT count(DISTINCT usuario_id)::text AS t FROM notificacoes
     WHERE id = ANY($1::bigint[])`,
  [(notifComprador?.data?.notificacoes ?? []).map((n: any) => n.id)]);
  checar(b9, 'CASO CRITICO: cada usuario ve apenas as proprias notificacoes',
    Number(donoDasNotificacoes[0]!.t) <= 1, donoDasNotificacoes[0]);

  // =========================================================================
  secao('10. Centro de operacoes e diagnostico (secoes 39 e 40)');
  // =========================================================================
  const b10 = novaBateria('Operacao: painel, diagnostico e efeito');
  baterias.push(b10);

  const { corpo: painel } = await chamar('GET', '/api/automacao/operacao/painel',
    { token: admin });
  for (const bloco of ['eventos', 'fila', 'execucoes', 'tarefas', 'aprovacoes',
    'jobs', 'webhooks', 'notificacoes']) {
    checar(b10, `o painel traz o bloco ${bloco}`,
      painel?.data?.[bloco] !== undefined, Object.keys(painel?.data ?? {}));
  }
  checar(b10, 'sucesso em zero execucoes e null, nao 100% (nao dar luz verde a motor parado)',
    painel?.data?.execucoes?.total_24h > 0
      ? typeof painel.data.execucoes.sucesso_percentual === 'number'
      : painel?.data?.execucoes?.sucesso_percentual === null,
    painel?.data?.execucoes);

  const { corpo: diag } = await chamar('GET', '/api/automacao/operacao/diagnostico',
    { token: admin });
  checar(b10, 'o diagnostico classifica a gravidade',
    ['OK', 'ATENCAO', 'CRITICO'].includes(diag?.data?.gravidade), diag?.data?.gravidade);
  checar(b10, 'CASO CRITICO: todo sintoma vem com a acao correspondente',
    (diag?.data?.sintomas ?? []).every((s: any) =>
      typeof s.acao === 'string' && s.acao.length > 10),
    (diag?.data?.sintomas ?? []).filter((s: any) => !s.acao));

  const { corpo: serie } = await chamar('GET', '/api/automacao/operacao/serie?dias=7',
    { token: admin });
  checar(b10, 'a serie devolve um ponto por dia, inclusive dias sem movimento',
    (serie?.data?.length ?? 0) === 7, serie?.data?.length);

  const { corpo: efeito } = await chamar('GET', '/api/automacao/operacao/efeito?dias=30',
    { token: admin });
  checar(b10, 'o efeito mede conclusao de tarefa, nao volume de execucao',
    efeito?.data?.tarefas !== undefined, efeito?.data);
  checar(b10, 'sem tarefa gerada, o efeito informa o motivo em vez de mostrar 0%',
    num(efeito?.data?.tarefas?.geradas) > 0
    || typeof efeito?.data?.motivo_sem_base === 'string', efeito?.data);

  const { corpo: desempenhoRegras } = await chamar(
    'GET', '/api/automacao/operacao/regras-desempenho?dias=30', { token: admin });
  checar(b10, 'o desempenho por regra responde',
    Array.isArray(desempenhoRegras?.data), desempenhoRegras?.data);

  // =========================================================================
  secao('11. O que a automacao NAO fez (secoes 9, 13 e 32)');
  // =========================================================================
  const b11 = novaBateria('Efeitos colaterais: as negativas que importam');
  baterias.push(b11);

  const movDepois = await contar('movimentacoes_estoque');
  const pedDepois = await contar('ordens_compra');
  const recDepois = await contar('recebimentos');
  const lotDepois = await contar('lotes');

  checar(b11, 'CASO CRITICO: nenhuma movimentacao de estoque criada pela automacao (secao 13)',
    movDepois === cenario.movimentacoesIniciais,
    { antes: cenario.movimentacoesIniciais, depois: movDepois });
  checar(b11, 'CASO CRITICO: nenhum pedido de compra emitido pela automacao (secao 9)',
    pedDepois === cenario.pedidosIniciais,
    { antes: cenario.pedidosIniciais, depois: pedDepois });
  checar(b11, 'CASO CRITICO: nenhum recebimento criado pela automacao',
    recDepois === cenario.recebimentosIniciais,
    { antes: cenario.recebimentosIniciais, depois: recDepois });
  checar(b11, 'CASO CRITICO: nenhum lote criado pela automacao',
    lotDepois === cenario.lotesIniciais,
    { antes: cenario.lotesIniciais, depois: lotDepois });

  const { rows: precoIntacto } = await query<{ preco_atual: string }>(
    'SELECT preco_atual::text FROM produto_fornecedor WHERE produto_id = $1',
    [cenario.produtoId]);
  checar(b11, 'CASO CRITICO: nenhum preco alterado pela automacao',
    Number(precoIntacto[0]?.preco_atual) === 25.5, precoIntacto[0]);

  // =========================================================================
  secao('12. Historico imutavel (secoes 35 e 36)');
  // =========================================================================
  const b12 = novaBateria('Auditoria: o historico nao se reescreve');
  baterias.push(b12);

  const { rows: umaExecucao } = await query<{ id: string }>(
    'SELECT id FROM automacao_execucoes ORDER BY id DESC LIMIT 1');
  const execId = umaExecucao[0]?.id;

  let bloqueouUpdate = false;
  try {
    await query('UPDATE automacao_execucoes SET erro = $2 WHERE id = $1',
      [execId, 'reescrito pela bateria']);
  } catch { bloqueouUpdate = true; }
  checar(b12, 'CASO CRITICO: alterar o historico de execucao e bloqueado pelo banco',
    bloqueouUpdate);

  let bloqueouDelete = false;
  try {
    await query('DELETE FROM automacao_execucoes WHERE id = $1', [execId]);
  } catch { bloqueouDelete = true; }
  checar(b12, 'CASO CRITICO: apagar historico dentro da retencao e bloqueado',
    bloqueouDelete);

  // A anulacao de referencia pelo ON DELETE SET NULL precisa continuar passando:
  // sem ela, nenhum evento antigo poderia ser expurgado (migrations 045 e 046).
  const { rows: eventoDescartavel } = await query<{ id: string }>(`
    INSERT INTO eventos (tipo, origem, chave_idempotencia, correlation_id)
    VALUES ('M13_TEMP', 'SISTEMA', $1, gen_random_uuid()) RETURNING id`,
  [`${marca}-temp`]);
  const eventoTemp = Number(eventoDescartavel[0]!.id);

  await query(`
    INSERT INTO automacao_execucoes
      (evento_id, correlation_id, acao, status, tentativa, regra_codigo, evento_tipo)
    SELECT $1, correlation_id, 'REGISTRAR', 'CONCLUIDO', 1, 'M13_TEMP', 'M13_TEMP'
      FROM eventos WHERE id = $1`, [eventoTemp]);

  let expurgoFuncionou = true;
  try {
    await query('DELETE FROM eventos WHERE id = $1', [eventoTemp]);
  } catch { expurgoFuncionou = false; }
  checar(b12, 'apagar o evento pai funciona: a referencia e anulada, o historico fica',
    expurgoFuncionou);

  const { rows: sobreviveu } = await query<{ regra_codigo: string; evento_id: string | null }>(
    "SELECT regra_codigo, evento_id FROM automacao_execucoes WHERE regra_codigo = 'M13_TEMP'");
  checar(b12, 'CASO CRITICO: o historico sobrevive nomeando a regra, sem depender do pai',
    sobreviveu[0]?.regra_codigo === 'M13_TEMP' && sobreviveu[0]?.evento_id === null,
    sobreviveu[0]);

  await query("DELETE FROM automacao_execucoes WHERE regra_codigo = 'M13_TEMP'")
    .catch(() => undefined);

  // =========================================================================
  await limpar(cenario);
  encerrar(baterias);
  await encerrarPool();
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await encerrarPool().catch(() => undefined);
});
