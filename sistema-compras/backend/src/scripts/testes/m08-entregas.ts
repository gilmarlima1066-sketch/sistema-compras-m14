/**
 * Bateria do MODULO 08 - acompanhamento, entregas, atrasos e performance.
 *
 * Cobre os 34 testes obrigatorios da secao 68 do PROMPT 08 e os oito dirigidos
 * das secoes 69 a 76 (atraso, entrega parcial, OTIF, risco de ruptura,
 * alteracao de prazo, multiplas entregas, pedido cancelado e pedido sem dados).
 *
 * Os dados de teste usam o prefixo M08- e ficam no banco.
 */
import { pool, encerrarPool } from '../../config/database.js';
import {
  chamar, checar, encerrar, loginAdmin, novaBateria, secao, tokenDoPerfil,
  type Bateria,
} from './base.js';
import {
  avaliarSituacao, avaliarSla, calcularAtraso, calcularEta, calcularIndicadores,
  calcularLeadTime, calcularPrioridade, calcularRiscoRuptura, calcularSaldo,
  classificarAtraso, classificarImpacto, diferencaDias, estatisticas, semaforo, somarDias,
  type FaixasAtraso, type RegraOtif,
} from '../../modules/entregas/calculos.js';

const num = (v: unknown) => Number(v ?? 0);
const quase = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
const hoje = new Date().toISOString().slice(0, 10);
const emDias = (d: number) =>
  new Date(Date.parse(`${hoje}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);

const FAIXAS: FaixasAtraso = { leveAte: 2, moderadoAte: 5, altoAte: 10 };

interface Cenario {
  produtoA: number;
  produtoB: number;
  produtoRuptura: number;
  fornecedorA: number;
  fornecedorB: number;
  fornecedorC: number;
  /** Sem nenhuma entrega no historico: e o cenario "sem dados" da secao 76. */
  fornecedorSemHistorico: number;
  /** Recebe exatamente uma entrega: serve para a amostra insuficiente da secao 81. */
  fornecedorPouco: number;
  localId: number;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function preparar(): Promise<Cenario> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query("SELECT set_config('app.usuario_id', '1', true)");

    const { rows: cat } = await cliente.query(`
      INSERT INTO categorias (nome, descricao) VALUES ('M08 TESTES', 'Cenarios da bateria do modulo 08')
      ON CONFLICT (nome) DO UPDATE SET descricao = EXCLUDED.descricao RETURNING id`);
    const categoriaId = Number(cat[0].id);
    const { rows: un } = await cliente.query("SELECT id FROM unidades WHERE codigo = 'KG'");
    const unidadeId = Number(un[0].id);
    const { rows: loc } = await cliente.query('SELECT id FROM locais WHERE ativo ORDER BY id LIMIT 1');
    const localId = Number(loc[0].id);

    const produto = async (codigo: string, descricao: string) => {
      const achado = (await cliente.query(
        'SELECT id FROM produtos WHERE upper(codigo) = upper($1) AND deleted_at IS NULL', [codigo])).rows;
      if (achado.length) {
        await cliente.query('UPDATE produtos SET descricao = $2, ativo = true WHERE id = $1',
          [achado[0].id, descricao]);
        return Number(achado[0].id);
      }
      const { rows } = await cliente.query(`
        INSERT INTO produtos (codigo, descricao, categoria_id, unidade_compra_id,
                              unidade_estoque_id, unidade_venda_id, fator_conversao,
                              ativo, lead_time_padrao_dias, classificacao_abc)
        VALUES ($1, $2, $3, $4, $4, $4, 1, true, 10, 'A') RETURNING id`,
        [codigo, descricao, categoriaId, unidadeId]);
      return Number(rows[0].id);
    };

    const fornecedor = async (razao: string, cnpj: string, leadTime: number) => {
      const achado = (await cliente.query(
        'SELECT id FROM fornecedores WHERE razao_social = $1 AND deleted_at IS NULL', [razao])).rows;
      if (achado.length) {
        await cliente.query(
          'UPDATE fornecedores SET ativo = true, lead_time_padrao_dias = $2 WHERE id = $1',
          [achado[0].id, leadTime]);
        return Number(achado[0].id);
      }
      const { rows } = await cliente.query(`
        INSERT INTO fornecedores (razao_social, cnpj, tipo_fornecedor, origem_fornecedor,
                                  ativo, lead_time_padrao_dias, prazo_medio_pagamento, email)
        VALUES ($1, $2, 'DISTRIBUIDOR', 'NACIONAL', true, $3, 28, 'm08@teste.local') RETURNING id`,
        [razao, cnpj, leadTime]);
      return Number(rows[0].id);
    };

    const produtoA = await produto('M08-A', 'M08 produto A');
    const produtoB = await produto('M08-B', 'M08 produto B');
    const produtoRuptura = await produto('M08-RUPTURA', 'M08 produto do teste de ruptura');

    const estoque = async (produtoId: number, fisica: number) => {
      const achado = (await cliente.query(
        'SELECT id FROM estoques WHERE produto_id = $1 AND local_id = $2', [produtoId, localId])).rows;
      if (achado.length) {
        await cliente.query(
          'UPDATE estoques SET quantidade_fisica = $2, quantidade_reservada = 0 WHERE id = $1',
          [achado[0].id, fisica]);
        return;
      }
      await cliente.query(`
        INSERT INTO estoques (produto_id, local_id, quantidade_fisica, quantidade_reservada,
                              quantidade_em_transito) VALUES ($1, $2, $3, 0, 0)`,
        [produtoId, localId, fisica]);
    };

    await estoque(produtoA, 5000);
    await estoque(produtoB, 5000);
    await estoque(produtoRuptura, 1000);

    await cliente.query('COMMIT');

    // Os dois ultimos nascem novos a cada execucao: historico de entrega se
    // acumula no banco, e ha cenarios que so existem para quem NAO tem
    // historico (previsao sem dados) ou tem pouquissimo (amostra insuficiente).
    const marca = Date.now().toString().slice(-8);
    return {
      produtoA, produtoB, produtoRuptura, localId,
      fornecedorA: await fornecedor('M08 Fornecedor A', '08000000000101', 10),
      fornecedorB: await fornecedor('M08 Fornecedor B', '08000000000202', 10),
      fornecedorC: await fornecedor('M08 Fornecedor C', '08000000000303', 10),
      fornecedorSemHistorico: await fornecedor(
        `M08 Fornecedor Novo ${marca}`, `081${marca}0`.padEnd(14, '0'), 10),
      fornecedorPouco: await fornecedor(
        `M08 Fornecedor Pouco ${marca}`, `082${marca}0`.padEnd(14, '0'), 10),
    };
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }
}

/**
 * Cria um pedido ja aprovado e enviado direto no banco.
 *
 * O caminho completo (cotacao, negociacao, aprovacao) e do modulo 07 e ja tem
 * bateria propria; repeti-lo aqui gastaria minutos por cenario sem testar nada
 * novo. O que importa para o modulo 08 e o estado inicial do pedido.
 */
async function criarPedido(dados: {
  fornecedorId: number;
  itens: Array<{ produtoId: number; quantidade: number; preco: number }>;
  dataEmissao: string;
  dataNecessaria: string | null;
  dataPrometida: string | null;
  status?: string;
  confirmacao?: string;
}) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query("SELECT set_config('app.usuario_id', '1', true)");

    const { rows: seq } = await cliente.query(`
      SELECT coalesce(max(nullif(regexp_replace(numero, '^.*-', ''), '')::bigint), 0) + 1 AS proximo
        FROM ordens_compra WHERE numero LIKE 'M08-%'`);
    const numero = `M08-${String(seq[0].proximo).padStart(5, '0')}`;
    const valor = dados.itens.reduce((a, i) => a + i.quantidade * i.preco, 0);

    const { rows: oc } = await cliente.query(`
      INSERT INTO ordens_compra
        (numero, fornecedor_id, data_emissao, data_necessaria, data_prometida,
         data_prometida_original, data_prevista_entrega, valor_produtos, valor_total,
         status, status_confirmacao, comprador_id, local_entrega_id, data_envio,
         aprovador_id, data_aprovacao, created_by)
      VALUES ($1,$2,$3::date,$4::date,$5::date,$5::date,$5::date,$6,$6,
              $7::status_ordem_compra_enum,$8::status_confirmacao_enum,1,$9,$10::timestamptz,
              1,$10::timestamptz,1)
      RETURNING *`,
      [numero, dados.fornecedorId, dados.dataEmissao, dados.dataNecessaria, dados.dataPrometida,
        valor, dados.status ?? 'ENVIADA', dados.confirmacao ?? 'NAO_CONFIRMADO', 1,
        `${dados.dataEmissao}T12:00:00Z`]);

    const itens: number[] = [];
    for (const i of dados.itens) {
      const { rows } = await cliente.query(`
        INSERT INTO ordem_compra_itens
          (ordem_compra_id, produto_id, quantidade_pedida, quantidade_pendente,
           preco_unitario, valor_total, data_necessaria, data_prometida,
           data_prometida_original, data_prevista_entrega)
        VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$7,$7) RETURNING id`,
        [oc[0].id, i.produtoId, i.quantidade, i.preco, i.quantidade * i.preco,
          dados.dataNecessaria, dados.dataPrometida]);
      itens.push(Number(rows[0].id));
    }

    await cliente.query('COMMIT');
    return { id: Number(oc[0].id), numero, itens, valor };
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }
}

// ---------------------------------------------------------------------------
// 1. Matematica pura
// ---------------------------------------------------------------------------

function testarCalculos(): Bateria {
  const b = novaBateria('MODULO 08 - calculos puros');

  secao('atraso contra promessa e contra necessidade (secoes 14, 15 e 69)');
  // Secao 69: necessaria 10/10, prometida 10/10, hoje 12/10 -> 2 dias.
  const atraso = calcularAtraso({
    dataPrometida: '2026-10-10', dataNecessaria: '2026-10-10',
    dataEfetiva: null, dataPrevista: '2026-10-10', hoje: '2026-10-12', faixas: FAIXAS,
  });
  checar(b, 'pedido vencido acusa 2 dias de atraso', atraso.contraPromessa === 2,
    atraso);
  checar(b, 'o atraso e classificado como leve', atraso.classificacao === 'LEVE');
  checar(b, 'o pedido e marcado como atrasado', atraso.atrasado);

  // Secao 15: necessaria 10/10, prometida 12/10 -> 2 dias de impacto interno.
  const impactoInterno = calcularAtraso({
    dataPrometida: '2026-10-12', dataNecessaria: '2026-10-10',
    dataEfetiva: '2026-10-12', dataPrevista: null, hoje: '2026-10-12', faixas: FAIXAS,
  });
  checar(b, 'fornecedor cumpriu a promessa: zero de atraso contra ele',
    impactoInterno.contraPromessa === 0);
  checar(b, 'mas o impacto contra a necessidade interna e de 2 dias',
    impactoInterno.contraNecessidade === 2);
  checar(b, 'entrega dentro da promessa nao e atraso',
    !impactoInterno.atrasado && impactoInterno.classificacao === 'NO_PRAZO');

  const semDados = calcularAtraso({
    dataPrometida: null, dataNecessaria: null, dataEfetiva: null,
    dataPrevista: null, hoje, faixas: FAIXAS,
  });
  checar(b, 'sem nenhuma data o atraso e SEM_DADOS, nao zero (secao 76)',
    semDados.classificacao === 'SEM_DADOS' && semDados.contraPromessa === null);

  // O atraso de hoje e a projecao da previsao sao leituras diferentes.
  const comProjecao = calcularAtraso({
    dataPrometida: '2026-10-10', dataNecessaria: '2026-10-10', dataEfetiva: null,
    dataPrevista: '2026-10-18', hoje: '2026-10-12', faixas: FAIXAS,
  });
  checar(b, 'o atraso de hoje continua sendo 2 dias', comProjecao.contraPromessa === 2);
  checar(b, 'a previsao projeta 8 dias, em campo separado',
    comProjecao.projetado?.contraPromessa === 8, comProjecao.projetado);
  checar(b, 'entrega realizada nao projeta nada',
    calcularAtraso({
      dataPrometida: '2026-10-10', dataNecessaria: '2026-10-10', dataEfetiva: '2026-10-11',
      dataPrevista: '2026-10-18', hoje: '2026-10-12', faixas: FAIXAS,
    }).projetado === null);

  secao('classificacao de atraso (secao 28)');
  checar(b, '0 dias = no prazo', classificarAtraso(0, FAIXAS) === 'NO_PRAZO');
  checar(b, '2 dias = leve', classificarAtraso(2, FAIXAS) === 'LEVE');
  checar(b, '4 dias = moderado', classificarAtraso(4, FAIXAS) === 'MODERADO');
  checar(b, '8 dias = alto', classificarAtraso(8, FAIXAS) === 'ALTO');
  checar(b, '15 dias = critico', classificarAtraso(15, FAIXAS) === 'CRITICO');
  checar(b, 'as faixas vem de parametro, nao do codigo',
    classificarAtraso(4, { leveAte: 5, moderadoAte: 10, altoAte: 20 }) === 'LEVE');

  secao('saldo do pedido (secoes 10, 18 e 70)');
  // Secao 70: pedido 10.000, entregas de 4.000 e 3.000 -> 70% atendido.
  const saldo = calcularSaldo({ pedida: 10000, confirmada: 10000, entregue: 7000, recebida: 0 });
  checar(b, '7.000 entregues de 10.000', saldo.entregue === 7000);
  checar(b, 'saldo pendente de 3.000', saldo.pendenteEntrega === 3000);
  checar(b, '70% atendido', quase(saldo.percentualAtendido, 70));
  checar(b, '30% pendente', quase(saldo.percentualPendente, 30));
  checar(b, 'pedido incompleto', !saldo.completo);

  // Secao 10: confirmacao parcial de 8.000 em 10.000.
  const parcial = calcularSaldo({ pedida: 10000, confirmada: 8000, entregue: 0, recebida: 0 });
  checar(b, 'confirmacao de 8.000 em 10.000 e parcial',
    parcial.statusConfirmacao === 'CONFIRMADO_PARCIALMENTE');
  checar(b, 'saldo nao confirmado de 2.000', parcial.pendenteConfirmacao === 2000);
  checar(b, 'confirmado nao vira entregue', parcial.entregue === 0);
  checar(b, 'sem confirmacao o status e NAO_CONFIRMADO',
    calcularSaldo({ pedida: 100, confirmada: null, entregue: 0, recebida: 0 })
      .statusConfirmacao === 'NAO_CONFIRMADO');
  checar(b, 'recusa do fornecedor e registrada',
    calcularSaldo({ pedida: 100, confirmada: 0, entregue: 0, recebida: 0, recusado: true })
      .statusConfirmacao === 'RECUSADO');

  secao('lead time (secao 36)');
  const lead = calcularLeadTime({
    dataPedido: '2026-10-01', dataPrometida: '2026-10-11', dataEfetiva: '2026-10-16',
  });
  checar(b, 'lead time contratado de 10 dias', lead.contratado === 10);
  checar(b, 'lead time real de 15 dias', lead.real === 15);
  checar(b, 'desvio de 5 dias', lead.desvio === 5);
  checar(b, 'sem entrega o lead real e nulo',
    calcularLeadTime({ dataPedido: '2026-10-01', dataPrometida: '2026-10-11', dataEfetiva: null })
      .real === null);

  const est = estatisticas([10, 12, 14, 20, 100]);
  checar(b, 'mediana resiste ao outlier', est.mediana === 14);
  checar(b, 'media sobe com o outlier', quase(est.media!, 31.2));
  checar(b, 'minimo e maximo corretos', est.minimo === 10 && est.maximo === 100);
  checar(b, 'lista vazia devolve nulos, nao zero', estatisticas([]).media === null);

  secao('OTD, In Full e OTIF (secoes 37, 38, 39 e 71)');
  const regra: RegraOtif = {
    referencia: 'DATA_PROMETIDA', toleranciaDias: 0,
    toleranciaQuantidadePercentual: 0, unidade: 'ITEM',
  };
  // Secao 71: A no prazo e integral, B atrasado e integral, C no prazo e parcial.
  const tres = calcularIndicadores([
    { dataReferencia: '2026-10-10', dataEfetiva: '2026-10-10', quantidadeEsperada: 100, quantidadeEntregue: 100 },
    { dataReferencia: '2026-10-10', dataEfetiva: '2026-10-15', quantidadeEsperada: 100, quantidadeEntregue: 100 },
    { dataReferencia: '2026-10-10', dataEfetiva: '2026-10-10', quantidadeEsperada: 100, quantidadeEntregue: 80 },
  ], regra, 1);
  checar(b, 'tres entregas avaliadas', tres.avaliadas === 3);
  checar(b, 'OTD de 66,7% (duas no prazo)', quase(tres.otd!, 200 / 3, 0.1), tres.otd);
  checar(b, 'In Full de 66,7% (duas integrais)', quase(tres.inFull!, 200 / 3, 0.1), tres.inFull);
  checar(b, 'OTIF de 33,3% (so a primeira)', quase(tres.otif!, 100 / 3, 0.1), tres.otif);
  checar(b, 'a formula sai junto do numero (secao 79)',
    tres.formula.otif.includes('no prazo') && tres.formula.otd.includes('DATA_PROMETIDA'));
  checar(b, 'atraso medio de 1,67 dias', quase(tres.atrasoMedio!, 5 / 3, 0.01));

  const comTolerancia = calcularIndicadores([
    { dataReferencia: '2026-10-10', dataEfetiva: '2026-10-12', quantidadeEsperada: 100, quantidadeEntregue: 98 },
  ], { ...regra, toleranciaDias: 2, toleranciaQuantidadePercentual: 5 }, 1);
  checar(b, 'tolerancia de 2 dias e 5% torna a entrega OTIF', comTolerancia.otif === 100);

  const naoAvaliavel = calcularIndicadores([
    { dataReferencia: '2026-10-10', dataEfetiva: null, quantidadeEsperada: 100, quantidadeEntregue: 0 },
    { dataReferencia: null, dataEfetiva: '2026-10-10', quantidadeEsperada: 100, quantidadeEntregue: 100 },
  ], regra, 1);
  checar(b, 'entrega nao realizada nao conta como falha de OTIF',
    naoAvaliavel.avaliadas === 0 && naoAvaliavel.ignoradas === 2);
  checar(b, 'sem base avaliavel o OTIF e nulo, nao zero', naoAvaliavel.otif === null);
  checar(b, 'amostra abaixo do minimo e sinalizada',
    !calcularIndicadores([], regra, 5).amostraSuficiente);

  secao('ETA e confianca (secoes 44, 45 e 76)');
  const base = {
    dataConfirmacao: '2026-10-01', dataEmissao: '2026-09-28', statusLogistico: null,
    transporteDataPrevista: null, transporteDataColeta: null,
    leadTimeHistoricoMedio: null, leadTimeHistoricoEntregas: 0,
    leadTimeContratado: 10, minimoEntregasHistorico: 3, hoje: '2026-10-05',
  };
  const etaPromessa = calcularEta({ ...base, dataPrometida: '2026-10-15' });
  checar(b, 'com promessa e confirmacao a ETA e a promessa, confianca alta',
    etaPromessa.eta === '2026-10-15' && etaPromessa.confianca === 'ALTA'
    && etaPromessa.fonte === 'DATA_PROMETIDA');

  const semConfirmar = calcularEta({ ...base, dataPrometida: '2026-10-15', dataConfirmacao: null });
  checar(b, 'sem confirmacao a mesma promessa vale menos', semConfirmar.confianca === 'MEDIA');

  const comTransporte = calcularEta({
    ...base, dataPrometida: '2026-10-15', statusLogistico: 'EM_TRANSITO',
    transporteDataPrevista: '2026-10-12',
  });
  checar(b, 'carga em transito manda mais que a promessa',
    comTransporte.eta === '2026-10-12' && comTransporte.fonte === 'TRANSPORTE'
    && comTransporte.confianca === 'ALTA');

  const historicoRuim = calcularEta({
    ...base, dataPrometida: '2026-10-15',
    leadTimeHistoricoMedio: 16, leadTimeHistoricoEntregas: 8,
  });
  checar(b, 'fornecedor historicamente atrasado tem a promessa ajustada',
    historicoRuim.eta === '2026-10-21' && historicoRuim.fonte === 'LEAD_TIME_HISTORICO',
    historicoRuim);
  checar(b, 'o ajuste sai explicado na memoria do calculo',
    typeof historicoRuim.memoria.regra === 'string'
    && Number(historicoRuim.memoria.desvio_aplicado_dias) === 6);

  const semPromessa = calcularEta({ ...base, dataPrometida: null });
  checar(b, 'sem promessa cai no lead time contratado',
    semPromessa.eta === '2026-10-11' && semPromessa.fonte === 'LEAD_TIME_CONTRATADO'
    && semPromessa.confianca === 'BAIXA');

  const semNada = calcularEta({
    ...base, dataPrometida: null, dataConfirmacao: null, dataEmissao: null,
    leadTimeContratado: null,
  });
  checar(b, 'sem evidencia nenhuma a ETA e nula e a confianca SEM_DADOS (secao 76)',
    semNada.eta === null && semNada.confianca === 'SEM_DADOS');

  secao('risco de ruptura (secoes 23, 24 e 72)');
  // Secao 72: estoque 1.000, demanda 200/dia, cobertura 5 dias, chegada em 8.
  const ruptura = calcularRiscoRuptura({
    estoqueDisponivel: 1000, estoqueReservado: 0, demandaDiaria: 200,
    quantidadePendente: 2000, dataPrevistaChegada: emDias(8), hoje,
    faixas: { criticaAte: 3, altaAte: 7, mediaAte: 15 },
  });
  checar(b, 'cobertura de 5 dias', quase(ruptura.coberturaDias!, 5));
  checar(b, 'ruptura provavel em 5 dias', ruptura.dataProvavelRuptura === emDias(5));
  checar(b, 'a carga chega em 8 dias, depois da ruptura', ruptura.chegaATempo === false);
  checar(b, 'risco classificado como alto', ruptura.nivel === 'ALTO', ruptura.nivel);

  const chegaAntes = calcularRiscoRuptura({
    estoqueDisponivel: 1000, estoqueReservado: 0, demandaDiaria: 200,
    quantidadePendente: 2000, dataPrevistaChegada: emDias(3), hoje,
    faixas: { criticaAte: 3, altaAte: 7, mediaAte: 15 },
  });
  checar(b, 'se a carga chega antes da ruptura o risco cai',
    chegaAntes.chegaATempo === true && chegaAntes.nivel === 'BAIXO');

  const semDemanda = calcularRiscoRuptura({
    estoqueDisponivel: 1000, estoqueReservado: 0, demandaDiaria: null,
    quantidadePendente: 2000, dataPrevistaChegada: emDias(8), hoje,
    faixas: { criticaAte: 3, altaAte: 7, mediaAte: 15 },
  });
  checar(b, 'sem demanda o risco e NAO_CALCULAVEL, sem data inventada (secao 24)',
    semDemanda.nivel === 'NAO_CALCULAVEL' && semDemanda.dataProvavelRuptura === null
    && !semDemanda.calculavel);
  checar(b, 'o motivo de nao calcular vem junto', typeof semDemanda.motivo === 'string');

  const semPendencia = calcularRiscoRuptura({
    estoqueDisponivel: 100, estoqueReservado: 0, demandaDiaria: 50,
    quantidadePendente: 0, dataPrevistaChegada: null, hoje,
    faixas: { criticaAte: 3, altaAte: 7, mediaAte: 15 },
  });
  checar(b, 'sem quantidade pendente nao ha risco do pedido', semPendencia.nivel === 'SEM_RISCO');

  secao('impacto, semaforo e prioridade (secoes 25, 57 e 58)');
  checar(b, 'ruptura critica gera impacto critico',
    classificarImpacto({ risco: 'CRITICO', classificacaoAbc: 'C', quantidadePendente: 10, valorPendente: 1 }) === 'CRITICO');
  checar(b, 'risco alto em item A vira impacto critico',
    classificarImpacto({ risco: 'ALTO', classificacaoAbc: 'A', quantidadePendente: 10, valorPendente: 1 }) === 'CRITICO');
  checar(b, 'risco alto em item C fica em alto',
    classificarImpacto({ risco: 'ALTO', classificacaoAbc: 'C', quantidadePendente: 10, valorPendente: 1 }) === 'ALTO');
  checar(b, 'nada pendente nao tem impacto',
    classificarImpacto({ risco: 'CRITICO', classificacaoAbc: 'A', quantidadePendente: 0, valorPendente: 0 }) === 'BAIXO');

  checar(b, 'no prazo com impacto baixo e verde', semaforo('NO_PRAZO', 'BAIXO') === 'VERDE');
  checar(b, 'em risco com impacto critico e vermelho', semaforo('EM_RISCO', 'CRITICO') === 'VERMELHO');
  checar(b, 'atrasado com impacto medio e laranja', semaforo('ATRASADO', 'MEDIO') === 'LARANJA');
  checar(b, 'sem dados e cinza, nao verde', semaforo('SEM_DADOS', 'BAIXO') === 'CINZA');

  checar(b, 'ruptura critica eleva a prioridade a critica',
    calcularPrioridade({ situacao: 'ATRASADO', impacto: 'CRITICO', risco: 'CRITICO' }) === 'CRITICA');
  checar(b, 'no prazo e sem impacto e prioridade baixa',
    calcularPrioridade({ situacao: 'NO_PRAZO', impacto: 'BAIXO', risco: 'SEM_RISCO' }) === 'BAIXA');

  secao('situacao e motivos do risco (secao 22)');
  const emRisco = avaliarSituacao({
    entregue: false,
    atraso: calcularAtraso({
      dataPrometida: emDias(3), dataNecessaria: emDias(3), dataEfetiva: null,
      dataPrevista: emDias(3), hoje, faixas: FAIXAS,
    }),
    impacto: 'ALTO', diasAteEntrega: 3, confirmado: false, diasDesdeEnvio: 5,
    alteracoesPrazo: 1, atrasosRecentesFornecedor: 2, semPrevisao: false,
    ocorrenciasAbertas: 0, statusLogistico: 'AGUARDANDO_PRODUCAO',
    parametros: { diasAntecedencia: 7, diasSemConfirmacao: 3 },
  });
  checar(b, 'entrega proxima sem confirmacao entra em risco', emRisco.situacao === 'EM_RISCO');
  checar(b, 'os sinais que dispararam vem listados', emRisco.motivos.length >= 4, emRisco.motivos);
  checar(b, 'o semaforo combina risco e impacto', emRisco.semaforo === 'LARANJA');
  const regras = emRisco.motivos.map((m) => m.regra);
  checar(b, 'sinal de data proxima', regras.includes('DATA_PROXIMA'));
  checar(b, 'sinal de falta de confirmacao', regras.includes('SEM_CONFIRMACAO'));
  checar(b, 'sinal de prazo ja alterado', regras.includes('PRAZO_ALTERADO'));
  checar(b, 'sinal de historico de atraso do fornecedor', regras.includes('HISTORICO_ATRASO'));

  const tranquilo = avaliarSituacao({
    entregue: false,
    atraso: calcularAtraso({
      dataPrometida: emDias(60), dataNecessaria: emDias(60), dataEfetiva: null,
      dataPrevista: emDias(60), hoje, faixas: FAIXAS,
    }),
    impacto: 'BAIXO', diasAteEntrega: 60, confirmado: true, diasDesdeEnvio: 1,
    alteracoesPrazo: 0, atrasosRecentesFornecedor: 0, semPrevisao: false,
    ocorrenciasAbertas: 0, statusLogistico: 'EM_PRODUCAO',
    parametros: { diasAntecedencia: 7, diasSemConfirmacao: 3 },
  });
  checar(b, 'pedido confirmado e distante fica verde',
    tranquilo.situacao === 'NO_PRAZO' && tranquilo.semaforo === 'VERDE');

  secao('SLA de ocorrencia (secao 31)');
  const agora = new Date();
  const slaDentro = avaliarSla({
    abertura: new Date(agora.getTime() - 3600000).toISOString(), slaHoras: 24,
    encerramento: null, agora: agora.toISOString(), percentualAlerta: 80,
  });
  checar(b, 'uma hora de 24 e SLA dentro do prazo', slaDentro.situacao === 'DENTRO');
  checar(b, 'restam cerca de 23 horas', quase(slaDentro.horasRestantes!, 23, 0.1));

  const slaAlerta = avaliarSla({
    abertura: new Date(agora.getTime() - 3.5 * 3600000).toISOString(), slaHoras: 4,
    encerramento: null, agora: agora.toISOString(), percentualAlerta: 80,
  });
  checar(b, '87% do SLA consumido dispara alerta', slaAlerta.situacao === 'EM_ALERTA');

  const slaVencido = avaliarSla({
    abertura: new Date(agora.getTime() - 5 * 3600000).toISOString(), slaHoras: 4,
    encerramento: null, agora: agora.toISOString(), percentualAlerta: 80,
  });
  checar(b, 'passou das 4 horas: SLA vencido', slaVencido.situacao === 'VENCIDO');
  checar(b, 'ocorrencia sem SLA nao entra na conta',
    avaliarSla({ abertura: agora.toISOString(), slaHoras: null, encerramento: null,
      agora: agora.toISOString(), percentualAlerta: 80 }).situacao === 'SEM_SLA');

  secao('utilitarios de data');
  checar(b, 'diferenca entre datas em dias', diferencaDias('2026-10-10', '2026-10-15') === 5);
  checar(b, 'diferenca negativa quando a segunda e anterior',
    diferencaDias('2026-10-15', '2026-10-10') === -5);
  checar(b, 'soma de dias atravessa o mes', somarDias('2026-10-28', 5) === '2026-11-02');
  checar(b, 'data nula devolve nulo', diferencaDias(null, '2026-10-10') === null);

  return b;
}

// ---------------------------------------------------------------------------
// 2. Fluxo completo pela API
// ---------------------------------------------------------------------------

async function testarFluxo(cenario: Cenario): Promise<Bateria> {
  const b = novaBateria('MODULO 08 - acompanhamento e entregas pela API');
  const admin = await loginAdmin();

  // --- 1 e 2. Pedido sem confirmacao e confirmado --------------------------
  secao('pedido em acompanhamento (secoes 7, 8 e 9)');
  const pedido = await criarPedido({
    fornecedorId: cenario.fornecedorA,
    itens: [
      { produtoId: cenario.produtoA, quantidade: 10000, preco: 10 },
      { produtoId: cenario.produtoB, quantidade: 2000, preco: 5 },
    ],
    dataEmissao: emDias(-20),
    dataNecessaria: emDias(-2),
    dataPrometida: emDias(-2),
  });

  const acompanhamento = await chamar('GET', `/api/pedidos-compra/${pedido.id}/entrega`,
    { token: admin });
  checar(b, 'acompanhamento do pedido responde', acompanhamento.status === 200,
    acompanhamento.corpo?.error);
  const itens = acompanhamento.corpo?.data?.itens ?? [];
  checar(b, 'os dois itens aparecem', itens.length === 2);
  checar(b, 'pedido enviado sem resposta fica NAO_CONFIRMADO',
    acompanhamento.corpo?.data?.pedido?.status_confirmacao === 'NAO_CONFIRMADO');

  // --- 13. Calculo de atraso (secao 69) ------------------------------------
  checar(b, 'pedido vencido ha 2 dias acusa atraso',
    itens.every((i: any) => i.atraso.contraPromessa === 2), itens[0]?.atraso);
  checar(b, 'a situacao dos itens e ATRASADO',
    itens.every((i: any) => i.situacao === 'ATRASADO'));
  checar(b, 'o semaforo nao e verde', itens.every((i: any) => i.semaforo !== 'VERDE'));
  checar(b, 'o resumo do pedido reflete o pior item',
    acompanhamento.corpo?.data?.resumo?.situacao === 'ATRASADO');
  checar(b, 'a data necessaria e a prometida ficam separadas (secao 11)',
    itens[0]?.datas?.necessaria !== undefined && itens[0]?.datas?.prometida !== undefined);

  // --- 19. ETA -------------------------------------------------------------
  secao('previsao de entrega (secoes 44, 45 e 46)');
  const previsao = await chamar('POST', `/api/pedidos-compra/${pedido.id}/previsao`, {
    token: admin, corpo: { recalcular: true },
  });
  checar(b, 'previsao calculada', previsao.status === 201, previsao.corpo?.error);
  checar(b, 'a fonte da previsao vem junto', !!previsao.corpo?.data?.fonte);
  checar(b, 'a confianca vem junto', !!previsao.corpo?.data?.confianca);
  checar(b, 'a memoria do calculo explica a regra',
    typeof previsao.corpo?.data?.memoria?.regra === 'string', previsao.corpo?.data?.memoria);

  // --- 20. Alteracao de ETA ------------------------------------------------
  const novaEta = await chamar('POST', `/api/pedidos-compra/${pedido.id}/previsao`, {
    token: admin, corpo: { eta: emDias(6), justificativa: 'Fornecedor informou nova data' },
  });
  checar(b, 'ETA manual aceita', novaEta.status === 201, novaEta.corpo?.error);
  checar(b, 'a variacao em relacao a ETA anterior e calculada',
    novaEta.corpo?.data?.variacao_dias !== null);
  checar(b, 'a ETA anterior fica registrada', novaEta.corpo?.data?.eta_anterior !== null);

  const { rows: historicoEta } = await pool.query(
    'SELECT count(*)::int AS n FROM previsoes_entrega WHERE ordem_compra_id = $1', [pedido.id]);
  checar(b, 'as duas previsoes ficam no historico', num(historicoEta[0].n) === 2);

  const apagarEta = await pool.query(
    'DELETE FROM previsoes_entrega WHERE ordem_compra_id = $1', [pedido.id])
    .then(() => 'apagou').catch(() => 'bloqueado');
  checar(b, 'historico de previsao nao pode ser apagado (secao 80)', apagarEta === 'bloqueado');

  // --- 4. Alteracao de prazo (secao 73) ------------------------------------
  secao('alteracao de prazo (secoes 12, 13 e 73)');
  const { rows: antes } = await pool.query(
    'SELECT data_prometida, data_prometida_original FROM ordens_compra WHERE id = $1', [pedido.id]);

  const alteracao = await chamar('POST', `/api/pedidos-compra/${pedido.id}/alterar-prazo`, {
    token: admin,
    corpo: {
      campo: 'DATA_PROMETIDA',
      data_nova: emDias(3),
      motivo_codigo: 'PRODUCAO',
      justificativa: 'Fornecedor atrasou a producao em cinco dias',
    },
  });
  checar(b, 'alteracao de prazo registrada', alteracao.status === 201, alteracao.corpo?.error);
  checar(b, 'a diferenca em dias e calculada', alteracao.corpo?.data?.diferenca_dias === 5,
    alteracao.corpo?.data?.diferenca_dias);
  checar(b, 'a data anterior fica no registro',
    alteracao.corpo?.data?.data_anterior !== null);
  checar(b, 'a nova data ultrapassa a necessidade e isso e marcado',
    alteracao.corpo?.data?.ultrapassa_necessidade === true);
  checar(b, 'o alerta e gerado', alteracao.corpo?.data?.alerta_gerado === true);

  const { rows: depois } = await pool.query(
    'SELECT data_prometida, data_prometida_original FROM ordens_compra WHERE id = $1', [pedido.id]);
  checar(b, 'a promessa atual mudou',
    String(depois[0].data_prometida) !== String(antes[0].data_prometida));
  checar(b, 'a promessa ORIGINAL nao foi apagada (secao 80)',
    String(depois[0].data_prometida_original) === String(antes[0].data_prometida_original));

  const apagarAlteracao = await pool.query(
    'DELETE FROM alteracoes_prazo WHERE ordem_compra_id = $1', [pedido.id])
    .then(() => 'apagou').catch(() => 'bloqueado');
  checar(b, 'historico de alteracao de prazo nao pode ser apagado', apagarAlteracao === 'bloqueado');

  const { rows: alerta } = await pool.query(`
    SELECT count(*)::int AS n FROM alertas
     WHERE ordem_compra_id = $1 AND tipo = 'ALTERACAO_PRAZO'`, [pedido.id]);
  checar(b, 'o alerta de prazo foi gravado', num(alerta[0].n) >= 1);

  // --- 26. Transporte e status logistico -----------------------------------
  secao('transporte e status logistico (secoes 34 e 35)');
  const transporte = await chamar('POST', `/api/pedidos-compra/${pedido.id}/transporte`, {
    token: admin,
    corpo: {
      transportadora: 'Transportes M08', modal: 'RODOVIARIO', veiculo: 'ABC-1234',
      codigo_rastreio: 'M08RASTREIO1', origem: 'Sao Paulo', destino: 'Campinas',
      data_coleta: emDias(1), data_prevista: emDias(5),
    },
  });
  checar(b, 'transporte registrado', transporte.status === 201, transporte.corpo?.error);

  const status = await chamar('POST', `/api/pedidos-compra/${pedido.id}/status-logistico`, {
    token: admin, corpo: { status: 'EM_TRANSITO', justificativa: 'Carga coletada' },
  });
  checar(b, 'status logistico atualizado', status.status === 200, status.corpo?.error);
  checar(b, 'o status anterior vem na resposta',
    status.corpo?.data?.status_logistico_anterior !== undefined);

  const repetido = await chamar('POST', `/api/pedidos-compra/${pedido.id}/status-logistico`, {
    token: admin, corpo: { status: 'EM_TRANSITO' },
  });
  checar(b, 'repetir o mesmo status e recusado', repetido.status === 409, repetido.status);

  const apagarStatus = await pool.query(
    'DELETE FROM status_logistico_historico WHERE ordem_compra_id = $1', [pedido.id])
    .then(() => 'apagou').catch(() => 'bloqueado');
  checar(b, 'historico de status nao pode ser apagado', apagarStatus === 'bloqueado');

  // Com transporte em transito a ETA passa a vir dele.
  const etaTransporte = await chamar('POST', `/api/pedidos-compra/${pedido.id}/previsao`, {
    token: admin, corpo: { recalcular: true },
  });
  checar(b, 'com a carga em transito a ETA vem do transporte',
    etaTransporte.corpo?.data?.fonte === 'TRANSPORTE', etaTransporte.corpo?.data?.fonte);
  checar(b, 'e a confianca sobe para alta', etaTransporte.corpo?.data?.confianca === 'ALTA');

  // --- 19. Programacao de entrega ------------------------------------------
  secao('programacao de entrega e calendario (secoes 19, 20 e 21)');
  const programacao = await chamar('POST', '/api/entregas/programacoes', {
    token: admin,
    corpo: {
      ordem_compra_id: pedido.id,
      data_prevista: hoje,
      horario_previsto: '14:30',
      local_id: cenario.localId,
      transportadora: 'Transportes M08',
      modal: 'RODOVIARIO',
      itens: [{ ordem_compra_item_id: pedido.itens[0], quantidade: 4000 }],
    },
  });
  checar(b, 'entrega programada', programacao.status === 201, programacao.corpo?.error);

  const calendario = await chamar('GET', `/api/entregas/calendario?dias=30`, { token: admin });
  checar(b, 'calendario responde', calendario.status === 200, calendario.corpo?.error);
  checar(b, 'a programacao de hoje aparece no calendario',
    (calendario.corpo?.data?.dias ?? []).some((d: any) =>
      d.data === hoje && d.eventos.some((e: any) => e.origem === 'PROGRAMACAO')),
    calendario.corpo?.data?.totais);
  checar(b, 'o calendario diz quantos eventos omitiu',
    calendario.corpo?.data?.omitidos !== undefined);

  // --- 7, 8, 9. Entregas parciais e multiplas (secoes 70 e 74) -------------
  secao('entregas parciais e multiplas (secoes 17, 18, 70 e 74)');
  const entrega1 = await chamar('POST', '/api/entregas', {
    token: admin,
    corpo: {
      ordem_compra_id: pedido.id,
      data_real: hoje,
      local_id: cenario.localId,
      numero_nota_fiscal: 'NF-M08-001',
      motivo_codigo: 'PRODUCAO',
      itens: [{ ordem_compra_item_id: pedido.itens[0], quantidade: 4000 }],
    },
  });
  checar(b, 'primeira entrega registrada', entrega1.status === 201, entrega1.corpo?.error);
  checar(b, 'a entrega recebe numero', typeof entrega1.corpo?.data?.numero === 'string');
  checar(b, 'saldo de 4.000 entregues',
    quase(num(entrega1.corpo?.data?.saldo_pedido?.entregue), 4000));
  checar(b, 'o pedido nao esta completo', entrega1.corpo?.data?.saldo_pedido?.completo === false);
  checar(b, 'a entrega fica pronta para o modulo 09',
    entrega1.corpo?.data?.pronta_recebimento === true);

  const entrega2 = await chamar('POST', '/api/entregas', {
    token: admin,
    corpo: {
      ordem_compra_id: pedido.id,
      data_real: hoje,
      itens: [{ ordem_compra_item_id: pedido.itens[0], quantidade: 3000 }],
    },
  });
  checar(b, 'segunda entrega registrada', entrega2.status === 201, entrega2.corpo?.error);
  checar(b, '7.000 entregues no total',
    quase(num(entrega2.corpo?.data?.saldo_pedido?.entregue), 7000));

  const saldo = await chamar('GET', `/api/pedidos-compra/${pedido.id}/saldo`, { token: admin });
  checar(b, 'saldo do pedido responde', saldo.status === 200, saldo.corpo?.error);
  const itemA = (saldo.corpo?.data?.itens ?? []).find((i: any) => i.codigo === 'M08-A');
  checar(b, 'saldo do item A: 7.000 entregues', quase(num(itemA?.entregue), 7000));
  checar(b, 'saldo do item A: 3.000 pendentes', quase(num(itemA?.pendenteEntrega), 3000));
  checar(b, '70% atendido no item A', quase(num(itemA?.percentualAtendido), 70));
  checar(b, '30% pendente no item A', quase(num(itemA?.percentualPendente), 30));
  checar(b, 'confirmado e recebido continuam separados de entregue',
    itemA?.confirmada !== undefined && itemA?.recebida !== undefined
    && num(itemA?.recebida) === 0);

  const { rows: contagem } = await pool.query(
    'SELECT count(*)::int AS n FROM entregas WHERE ordem_compra_id = $1 AND data_real IS NOT NULL',
    [pedido.id]);
  checar(b, 'as duas entregas ficam guardadas individualmente (secao 74)',
    num(contagem[0].n) === 2);

  // Entrega parcial nao "quita" o prazo: o que sobrou continua devendo.
  const aposParcial = await chamar('GET', `/api/pedidos-compra/${pedido.id}/entrega`,
    { token: admin });
  const itemParcial = (aposParcial.corpo?.data?.itens ?? [])
    .find((i: any) => i.produto_codigo === 'M08-A');
  // O prazo foi renegociado para frente nos testes anteriores, entao o
  // fornecedor nao esta mais atrasado contra a PROMESSA. Mas a necessidade
  // interna ja venceu e o saldo continua pendente - e isso tem de aparecer.
  checar(b, 'entrega parcial nao encerra o item: o saldo continua pendente',
    num(itemParcial?.saldo?.pendenteEntrega) > 0 && itemParcial?.saldo?.completo === false);
  checar(b, 'o impacto contra a necessidade interna continua sendo contado',
    num(itemParcial?.atraso?.contraNecessidade) > 0, itemParcial?.atraso);
  checar(b, 'o item nao e dado como no prazo depois da entrega parcial',
    itemParcial?.situacao !== 'NO_PRAZO' && itemParcial?.situacao !== 'ENTREGUE',
    itemParcial?.situacao);
  checar(b, 'a data efetiva do item so aparece quando ele foi atendido por inteiro',
    itemParcial?.atraso?.base === 'HOJE', itemParcial?.atraso?.base);
  checar(b, 'nenhum motivo de risco fala em dias negativos',
    (aposParcial.corpo?.data?.itens ?? []).every((i: any) =>
      (i.motivos_risco ?? []).every((m: any) => !String(m.detalhe).includes('-'))),
    (aposParcial.corpo?.data?.itens ?? []).flatMap((i: any) => i.motivos_risco ?? []));

  const { rows: statusPedido } = await pool.query(
    'SELECT status, status_logistico FROM ordens_compra WHERE id = $1', [pedido.id]);
  checar(b, 'o pedido fica em recebimento parcial',
    statusPedido[0].status === 'RECEBIMENTO_PARCIAL');
  checar(b, 'e o status logistico vira entrega parcial',
    statusPedido[0].status_logistico === 'ENTREGA_PARCIAL');

  // --- 63. Integridade: nao entregar mais do que o pedido ------------------
  const excesso = await chamar('POST', '/api/entregas', {
    token: admin,
    corpo: {
      ordem_compra_id: pedido.id,
      data_real: hoje,
      itens: [{ ordem_compra_item_id: pedido.itens[0], quantidade: 5000 }],
    },
  });
  checar(b, 'entregar mais do que o pedido e bloqueado', excesso.status >= 400, excesso.status);
  const { rows: aposExcesso } = await pool.query(
    'SELECT quantidade_entregue FROM ordem_compra_itens WHERE id = $1', [pedido.itens[0]]);
  checar(b, 'a tentativa nao alterou o saldo', quase(num(aposExcesso[0].quantidade_entregue), 7000));

  // --- 14. Atraso por item -------------------------------------------------
  secao('atraso por item (secao 16)');
  const entregaB = await chamar('POST', '/api/entregas', {
    token: admin,
    corpo: {
      ordem_compra_id: pedido.id,
      data_real: hoje,
      itens: [
        { ordem_compra_item_id: pedido.itens[0], quantidade: 3000 },
        { ordem_compra_item_id: pedido.itens[1], quantidade: 2000 },
      ],
    },
  });
  checar(b, 'entrega final registrada', entregaB.status === 201, entregaB.corpo?.error);
  checar(b, 'agora o pedido esta completo',
    entregaB.corpo?.data?.saldo_pedido?.completo === true);

  const detalheEntrega = await chamar('GET', `/api/entregas/${entregaB.corpo?.data?.id}`,
    { token: admin });
  const itensEntrega = detalheEntrega.corpo?.data?.itens ?? [];
  checar(b, 'a entrega guarda o atraso de cada item',
    itensEntrega.every((i: any) => i.atraso_dias !== undefined), itensEntrega[0]);
  checar(b, 'os dois produtos aparecem na entrega', itensEntrega.length === 2);

  // --- 34. Pacote para o modulo 09 ----------------------------------------
  secao('preparacao para o MODULO 09 (secao 83)');
  const pacote = await chamar('GET', `/api/entregas/${entregaB.corpo?.data?.id}/recebimento`,
    { token: admin });
  checar(b, 'pacote para o recebimento pronto', pacote.status === 200, pacote.corpo?.error);
  checar(b, 'o pacote leva fornecedor, itens e quantidades',
    !!pacote.corpo?.data?.fornecedor && (pacote.corpo?.data?.itens ?? []).length === 2);
  checar(b, 'o pacote diz que a entrada fisica e do modulo 09',
    typeof pacote.corpo?.data?.observacao_modulo === 'string');
  const { rows: recebimentos } = await pool.query(
    'SELECT count(*)::int AS n FROM recebimentos WHERE ordem_compra_id = $1', [pedido.id]);
  checar(b, 'o modulo 08 nao cria recebimento (secao 49)', num(recebimentos[0].n) === 0);

  const { rows: movimentacoes } = await pool.query(`
    SELECT count(*)::int AS n FROM movimentacoes_estoque
     WHERE produto_id = $1 AND created_at >= now() - interval '5 minutes'`, [cenario.produtoA]);
  checar(b, 'o modulo 08 nao movimenta estoque fisico', num(movimentacoes[0].n) === 0);

  return b;
}

// ---------------------------------------------------------------------------
// 3. Ruptura, OTIF, ocorrencias, permissoes
// ---------------------------------------------------------------------------

async function testarRegras(cenario: Cenario): Promise<Bateria> {
  const b = novaBateria('MODULO 08 - risco, OTIF, ocorrencias e permissoes');
  const admin = await loginAdmin();

  // --- 22. Risco de ruptura (secao 72) -------------------------------------
  secao('risco de ruptura sobre dados reais (secoes 23 e 72)');
  const { rows: comDemanda } = await pool.query(`
    SELECT m.produto_id, sum(m.quantidade) / 90.0 AS diaria
      FROM mv_demanda_diaria m
     WHERE m.data_venda >= CURRENT_DATE - 90
     GROUP BY m.produto_id HAVING sum(m.quantidade) > 900
     ORDER BY sum(m.quantidade) DESC LIMIT 1`);
  const produtoReal = comDemanda.length ? Number(comDemanda[0].produto_id) : cenario.produtoRuptura;

  const pedidoRuptura = await criarPedido({
    fornecedorId: cenario.fornecedorB,
    itens: [{ produtoId: produtoReal, quantidade: 2000, preco: 8 }],
    dataEmissao: emDias(-30),
    dataNecessaria: emDias(-5),
    dataPrometida: emDias(-5),
  });

  const risco = await chamar('GET', `/api/pedidos-compra/${pedidoRuptura.id}/risco`,
    { token: admin });
  checar(b, 'risco do pedido responde', risco.status === 200, risco.corpo?.error);
  const linha = risco.corpo?.data?.itens?.[0];
  checar(b, 'o risco traz a cobertura ou diz que nao e calculavel',
    linha?.risco?.coberturaDias !== undefined);
  checar(b, 'a memoria do calculo explica a regra',
    typeof linha?.risco?.memoria?.regra === 'string');
  if (comDemanda.length) {
    checar(b, 'com demanda real a cobertura e calculavel', linha?.risco?.calculavel === true,
      linha?.risco);
    checar(b, 'a data provavel de ruptura e informada',
      typeof linha?.risco?.dataProvavelRuptura === 'string');
    checar(b, 'o impacto do atraso e classificado',
      ['BAIXO', 'MEDIO', 'ALTO', 'CRITICO'].includes(linha?.impacto));
  }

  const semDemandaPedido = await criarPedido({
    fornecedorId: cenario.fornecedorB,
    itens: [{ produtoId: cenario.produtoRuptura, quantidade: 100, preco: 1 }],
    dataEmissao: emDias(-10),
    dataNecessaria: emDias(-1),
    dataPrometida: emDias(-1),
  });
  const riscoSemDemanda = await chamar('GET', `/api/pedidos-compra/${semDemandaPedido.id}/risco`,
    { token: admin });
  checar(b, 'produto sem venda nao inventa data de ruptura (secao 24)',
    riscoSemDemanda.corpo?.data?.itens?.[0]?.risco?.dataProvavelRuptura === null,
    riscoSemDemanda.corpo?.data?.itens?.[0]?.risco);
  checar(b, 'e o nivel fica NAO_CALCULAVEL',
    riscoSemDemanda.corpo?.data?.itens?.[0]?.risco?.nivel === 'NAO_CALCULAVEL');

  // --- 76. Pedido sem dados ------------------------------------------------
  secao('pedido sem dados (secao 76)');
  const semDados = await criarPedido({
    fornecedorId: cenario.fornecedorSemHistorico,
    itens: [{ produtoId: cenario.produtoA, quantidade: 500, preco: 10 }],
    dataEmissao: emDias(-3),
    dataNecessaria: null,
    dataPrometida: null,
  });
  await pool.query('UPDATE fornecedores SET lead_time_padrao_dias = NULL WHERE id = $1',
    [cenario.fornecedorSemHistorico]);
  const acompanhamentoSemDados = await chamar('GET',
    `/api/pedidos-compra/${semDados.id}/entrega`, { token: admin });
  const itemSemDados = acompanhamentoSemDados.corpo?.data?.itens?.[0];
  checar(b, 'sem promessa e sem lead time a ETA e nula',
    itemSemDados?.eta?.data === null, itemSemDados?.eta);
  checar(b, 'a confianca da previsao e SEM_DADOS',
    itemSemDados?.eta?.confianca === 'SEM_DADOS');
  checar(b, 'o atraso nao e inventado',
    itemSemDados?.atraso?.classificacao === 'SEM_DADOS');
  checar(b, 'o semaforo fica cinza', itemSemDados?.semaforo === 'CINZA', itemSemDados?.semaforo);
  await pool.query('UPDATE fornecedores SET lead_time_padrao_dias = 10 WHERE id = $1',
    [cenario.fornecedorSemHistorico]);

  // --- 75. Pedido cancelado ------------------------------------------------
  secao('pedido cancelado (secao 75)');
  const cancelado = await criarPedido({
    fornecedorId: cenario.fornecedorC,
    itens: [{ produtoId: cenario.produtoA, quantidade: 100, preco: 10 }],
    dataEmissao: emDias(-5),
    dataNecessaria: emDias(5),
    dataPrometida: emDias(5),
  });
  await pool.query("UPDATE ordens_compra SET status = 'CANCELADA' WHERE id = $1", [cancelado.id]);

  const entregaCancelada = await chamar('POST', '/api/entregas', {
    token: admin,
    corpo: {
      ordem_compra_id: cancelado.id, data_real: hoje,
      itens: [{ ordem_compra_item_id: cancelado.itens[0], quantidade: 100 }],
    },
  });
  checar(b, 'pedido cancelado nao aceita entrega', entregaCancelada.status === 422,
    entregaCancelada.status);
  checar(b, 'a mensagem diz que o pedido esta cancelado',
    String(entregaCancelada.corpo?.error?.message ?? '').includes('CANCELADA'),
    entregaCancelada.corpo?.error);

  const { rows: entregasCanceladas } = await pool.query(
    'SELECT count(*)::int AS n FROM entregas WHERE ordem_compra_id = $1', [cancelado.id]);
  checar(b, 'nenhuma entrega foi criada para o pedido cancelado',
    num(entregasCanceladas[0].n) === 0);

  const prazoCancelado = await chamar('POST', `/api/pedidos-compra/${cancelado.id}/alterar-prazo`, {
    token: admin,
    corpo: { data_nova: emDias(10), justificativa: 'Nao deveria passar' },
  });
  checar(b, 'pedido cancelado nao aceita alteracao de prazo', prazoCancelado.status === 422);

  // --- 16, 17, 18. OTIF (secao 71) -----------------------------------------
  secao('OTD, In Full e OTIF sobre entregas reais (secoes 37 a 40 e 71)');
  const cenarios = [
    { forn: cenario.fornecedorA, qtd: 1000, entregue: 1000, atrasoDias: 0, nome: 'A' },
    { forn: cenario.fornecedorB, qtd: 1000, entregue: 1000, atrasoDias: 5, nome: 'B' },
    { forn: cenario.fornecedorC, qtd: 1000, entregue: 800, atrasoDias: 0, nome: 'C' },
  ];
  for (const c of cenarios) {
    const p = await criarPedido({
      fornecedorId: c.forn,
      itens: [{ produtoId: cenario.produtoB, quantidade: c.qtd, preco: 5 }],
      dataEmissao: emDias(-20),
      dataNecessaria: emDias(-10),
      dataPrometida: emDias(-10),
    });
    const r = await chamar('POST', '/api/entregas', {
      token: admin,
      corpo: {
        ordem_compra_id: p.id,
        data_real: emDias(-10 + c.atrasoDias),
        itens: [{ ordem_compra_item_id: p.itens[0], quantidade: c.entregue }],
      },
    });
    checar(b, `entrega do fornecedor ${c.nome} registrada`, r.status === 201, r.corpo?.error);
  }

  // Fornecedor novo com uma unica entrega: e o caso da amostra insuficiente.
  const pedidoPouco = await criarPedido({
    fornecedorId: cenario.fornecedorPouco,
    itens: [{ produtoId: cenario.produtoB, quantidade: 100, preco: 5 }],
    dataEmissao: emDias(-15),
    dataNecessaria: emDias(-8),
    dataPrometida: emDias(-8),
  });
  const entregaPouco = await chamar('POST', '/api/entregas', {
    token: admin,
    corpo: {
      ordem_compra_id: pedidoPouco.id, data_real: emDias(-8),
      itens: [{ ordem_compra_item_id: pedidoPouco.itens[0], quantidade: 100 }],
    },
  });
  checar(b, 'entrega unica do fornecedor novo registrada', entregaPouco.status === 201,
    entregaPouco.corpo?.error);

  const otif = await chamar('GET', '/api/indicadores/otif?dias=30', { token: admin });
  checar(b, 'indicadores de OTIF respondem', otif.status === 200, otif.corpo?.error);
  checar(b, 'o periodo analisado vem junto (secao 79)',
    !!otif.corpo?.data?.periodo?.inicio && !!otif.corpo?.data?.periodo?.fim);
  checar(b, 'a base de dados usada e declarada',
    typeof otif.corpo?.data?.base_de_dados === 'string');
  checar(b, 'a quantidade de registros avaliados vem junto',
    otif.corpo?.data?.avaliadas !== undefined);
  checar(b, 'a formula de cada indicador vem junto',
    !!otif.corpo?.data?.formula?.otif && !!otif.corpo?.data?.formula?.otd);
  checar(b, 'a regra usada (referencia e tolerancias) e explicita',
    otif.corpo?.data?.regra?.referencia === 'DATA_PROMETIDA');
  checar(b, 'OTD, In Full e OTIF calculados',
    otif.corpo?.data?.otd !== null && otif.corpo?.data?.inFull !== null
    && otif.corpo?.data?.otif !== null, otif.corpo?.data);
  checar(b, 'OTIF nao e maior que OTD nem que In Full',
    num(otif.corpo?.data?.otif) <= num(otif.corpo?.data?.otd)
    && num(otif.corpo?.data?.otif) <= num(otif.corpo?.data?.inFull));
  checar(b, 'o lead time medio e apurado',
    otif.corpo?.data?.lead_time?.media !== undefined);

  const otd = await chamar('GET', '/api/indicadores/otd?dias=30', { token: admin });
  checar(b, 'endpoint dedicado de OTD responde com formula',
    otd.status === 200 && typeof otd.corpo?.data?.formula === 'string');
  const inFull = await chamar('GET', '/api/indicadores/in-full?dias=30', { token: admin });
  checar(b, 'endpoint dedicado de In Full responde com formula',
    inFull.status === 200 && typeof inFull.corpo?.data?.formula === 'string');

  // --- 41 e 81. Performance por fornecedor ---------------------------------
  secao('performance por fornecedor (secoes 40, 41, 42 e 81)');
  const performance = await chamar('GET', '/api/indicadores/performance-entrega?dias=30',
    { token: admin });
  checar(b, 'performance dos fornecedores responde', performance.status === 200,
    performance.corpo?.error);
  const lista = performance.corpo?.data?.fornecedores ?? [];
  checar(b, 'os fornecedores do teste aparecem',
    lista.some((f: any) => String(f.fornecedor).startsWith('M08')), lista.map((f: any) => f.fornecedor));

  const fornA = lista.find((f: any) => f.fornecedor === 'M08 Fornecedor A');
  const fornB = lista.find((f: any) => f.fornecedor === 'M08 Fornecedor B');
  const fornC = lista.find((f: any) => f.fornecedor === 'M08 Fornecedor C');
  checar(b, 'fornecedor B entregou atrasado: OTD abaixo de 100',
    fornB ? num(fornB.otd) < 100 : false, fornB);
  checar(b, 'fornecedor B entregou integral: In Full de 100',
    fornB ? quase(num(fornB.in_full), 100) : false, fornB);
  checar(b, 'fornecedor C entregou no prazo mas parcial: In Full abaixo de 100',
    fornC ? num(fornC.in_full) < 100 : false, fornC);
  checar(b, 'fornecedor C tem OTD de 100', fornC ? quase(num(fornC.otd), 100) : false);
  checar(b, 'nenhum fornecedor recebe score unico (secao 41)',
    lista.every((f: any) => f.score === undefined && f.score_final === undefined));
  checar(b, 'quem tem amostra suficiente vem antes no ranking (secao 81)',
    (() => {
      const primeiraInsuficiente = lista.findIndex((f: any) => !f.amostra_suficiente);
      return primeiraInsuficiente === -1
        || lista.slice(primeiraInsuficiente).every((f: any) => !f.amostra_suficiente);
    })(),
    lista.map((f: any) => ({ f: f.fornecedor, ok: f.amostra_suficiente })));

  const novo = lista.find((f: any) => String(f.fornecedor).includes('Pouco'));
  checar(b, 'fornecedor com uma entrega so e marcado como amostra insuficiente (secao 81)',
    novo?.amostra_suficiente === false && typeof novo?.observacao === 'string',
    novo);
  checar(b, 'a observacao diz quantas entregas faltam para a amostra valer',
    String(novo?.observacao ?? '').includes('AMOSTRA INSUFICIENTE'), novo?.observacao);
  checar(b, 'o periodo e a metodologia sao os mesmos para todos (secao 82)',
    !!performance.corpo?.data?.periodo && !!performance.corpo?.data?.regra
    && typeof performance.corpo?.data?.observacao === 'string');
  checar(b, 'cada fornecedor informa quantas entregas foram avaliadas',
    lista.every((f: any) => f.entregas_avaliadas !== undefined));

  if (fornA) {
    const individual = await chamar('GET',
      `/api/fornecedores/${fornA.fornecedor_id}/performance-entrega?dias=90`, { token: admin });
    checar(b, 'performance individual do fornecedor responde', individual.status === 200,
      individual.corpo?.error);
    checar(b, 'traz lead time contratado, prometido e real',
      individual.corpo?.data?.lead_time?.real !== undefined
      && individual.corpo?.data?.lead_time?.prometido !== undefined);
    checar(b, 'traz a evolucao ao longo do tempo (secao 43)',
      Array.isArray(individual.corpo?.data?.evolucao));
  }

  const atrasos = await chamar('GET', '/api/indicadores/atrasos?dias=30', { token: admin });
  checar(b, 'indicadores de atraso respondem', atrasos.status === 200, atrasos.corpo?.error);
  checar(b, 'as faixas de atraso vem classificadas',
    atrasos.corpo?.data?.faixas?.LEVE !== undefined);
  checar(b, 'os limites configurados sao informados',
    atrasos.corpo?.data?.limites?.leveAte !== undefined);
  checar(b, 'os motivos de atraso sao agregados',
    Array.isArray(atrasos.corpo?.data?.motivos));

  // --- 23, 24, 25. Ocorrencias, SLA e acoes --------------------------------
  secao('ocorrencias, SLA e acoes (secoes 26, 30 e 31)');
  const pedidoOcorrencia = await criarPedido({
    fornecedorId: cenario.fornecedorA,
    itens: [{ produtoId: cenario.produtoA, quantidade: 500, preco: 10 }],
    dataEmissao: emDias(-15),
    dataNecessaria: emDias(-1),
    dataPrometida: emDias(-1),
  });

  const ocorrencia = await chamar('POST', '/api/entregas/ocorrencias', {
    token: admin,
    corpo: {
      ordem_compra_id: pedidoOcorrencia.id,
      tipo: 'ATRASO_PRODUCAO',
      descricao: 'Fornecedor informou parada de linha',
      motivo_codigo: 'PRODUCAO',
      prioridade: 'CRITICA',
    },
  });
  checar(b, 'ocorrencia aberta', ocorrencia.status === 201, ocorrencia.corpo?.error);
  checar(b, 'a ocorrencia recebe numero',
    typeof ocorrencia.corpo?.data?.numero === 'string');
  checar(b, 'o SLA vem da prioridade, nao do usuario',
    num(ocorrencia.corpo?.data?.sla_horas) === 4, ocorrencia.corpo?.data?.sla_horas);
  checar(b, 'o prazo de resolucao e calculado',
    ocorrencia.corpo?.data?.prazo_resolucao !== null);

  const ocorrenciaId = ocorrencia.corpo?.data?.id;
  const detalheOcorrencia = await chamar('GET', `/api/entregas/ocorrencias/${ocorrenciaId}`,
    { token: admin });
  checar(b, 'a ocorrencia traz a avaliacao do SLA',
    ['DENTRO', 'EM_ALERTA', 'VENCIDO'].includes(detalheOcorrencia.corpo?.data?.sla?.situacao),
    detalheOcorrencia.corpo?.data?.sla);

  const acao = await chamar('POST', '/api/entregas/acoes', {
    token: admin,
    corpo: {
      ordem_compra_id: pedidoOcorrencia.id,
      ocorrencia_id: ocorrenciaId,
      tipo: 'COBRAR_FORNECEDOR',
      descricao: 'Cobrar nova previsao por telefone',
      prazo: emDias(1),
    },
  });
  checar(b, 'acao sobre o atraso registrada', acao.status === 201, acao.corpo?.error);

  const concluir = await chamar('POST', `/api/entregas/acoes/${acao.corpo?.data?.id}`, {
    token: admin, corpo: { status: 'CONCLUIDA', resultado: 'Fornecedor prometeu para sexta' },
  });
  checar(b, 'acao concluida', concluir.status === 200, concluir.corpo?.error);

  const contato = await chamar('POST', '/api/entregas/contatos', {
    token: admin,
    corpo: {
      ordem_compra_id: pedidoOcorrencia.id,
      ocorrencia_id: ocorrenciaId,
      canal: 'TELEFONE',
      assunto: 'Nova previsao de entrega',
      resposta: 'Fornecedor confirmou nova data',
      nova_previsao: emDias(7),
    },
  });
  checar(b, 'contato com o fornecedor registrado', contato.status === 201, contato.corpo?.error);
  checar(b, 'o contato avisa que previsao informada nao vira prazo sozinha',
    typeof contato.corpo?.data?.observacao_sistema === 'string');

  const { rows: prazoIntacto } = await pool.query(
    'SELECT data_prometida FROM ordens_compra WHERE id = $1', [pedidoOcorrencia.id]);
  checar(b, 'o contato nao alterou a data prometida',
    String(prazoIntacto[0].data_prometida).slice(0, 10) === emDias(-1),
    prazoIntacto[0].data_prometida);

  const apagarContato = await pool.query(
    'DELETE FROM contatos_fornecedor_pedido WHERE ordem_compra_id = $1', [pedidoOcorrencia.id])
    .then(() => 'apagou').catch(() => 'bloqueado');
  checar(b, 'historico de contato nao pode ser apagado', apagarContato === 'bloqueado');

  const resolverSemSolucao = await chamar('POST', `/api/entregas/ocorrencias/${ocorrenciaId}/tratar`, {
    token: admin, corpo: { status: 'RESOLVIDA' },
  });
  checar(b, 'resolver ocorrencia sem descrever a solucao e recusado',
    resolverSemSolucao.status === 422, resolverSemSolucao.status);

  const resolver = await chamar('POST', `/api/entregas/ocorrencias/${ocorrenciaId}/tratar`, {
    token: admin,
    corpo: { status: 'RESOLVIDA', solucao: 'Fornecedor retomou a producao e entregou' },
  });
  checar(b, 'ocorrencia resolvida', resolver.status === 200, resolver.corpo?.error);
  checar(b, 'a data de encerramento e gravada', resolver.corpo?.data?.data_encerramento !== null);

  const retratar = await chamar('POST', `/api/entregas/ocorrencias/${ocorrenciaId}/tratar`, {
    token: admin, corpo: { status: 'EM_TRATAMENTO' },
  });
  checar(b, 'ocorrencia resolvida nao volta a tratamento', retratar.status === 422);

  // --- 27. Entrega internacional -------------------------------------------
  secao('entrega internacional (secao 47)');
  const internacional = await chamar('POST',
    `/api/pedidos-compra/${pedidoOcorrencia.id}/transporte`, {
      token: admin,
      corpo: {
        modal: 'MARITIMO', incoterm: 'FOB', porto_origem: 'Valparaiso',
        porto_destino: 'Santos', data_embarque: emDias(-20), eta_porto: emDias(5),
        data_desembaraco: emDias(8), eta_final: emDias(12),
        transportadora: 'Naviera Andina',
      },
    });
  checar(b, 'transporte internacional registrado', internacional.status === 201,
    internacional.corpo?.error);
  checar(b, 'as etapas do trajeto ficam separadas',
    internacional.corpo?.data?.eta_porto !== null
    && internacional.corpo?.data?.eta_final !== null
    && internacional.corpo?.data?.data_desembaraco !== null);

  // --- 28. Auditoria -------------------------------------------------------
  secao('auditoria (secao 67)');
  const { rows: auditoria } = await pool.query(`
    SELECT count(*)::int AS n FROM auditoria
     WHERE tabela IN ('entregas', 'entrega_itens', 'ocorrencias_entrega', 'transportes_pedido')
       AND created_at >= now() - interval '10 minutes'`);
  checar(b, 'as operacoes do modulo entraram na auditoria', num(auditoria[0].n) > 0, auditoria[0]);

  const { rows: historico } = await pool.query(`
    SELECT evento, count(*)::int AS n FROM pedido_historico
     WHERE created_at >= now() - interval '10 minutes'
     GROUP BY evento`);
  const eventos = historico.map((h) => h.evento);
  checar(b, 'alteracao de prazo entrou no historico do pedido',
    eventos.includes('ALTERACAO_PRAZO'), eventos);
  checar(b, 'entrega entrou no historico do pedido', eventos.includes('ENTREGA_REGISTRADA'));
  checar(b, 'ocorrencia entrou no historico do pedido', eventos.includes('OCORRENCIA_ABERTA'));
  checar(b, 'contato entrou no historico do pedido', eventos.includes('CONTATO_FORNECEDOR'));
  checar(b, 'status logistico entrou no historico', eventos.includes('STATUS_LOGISTICO'));

  // --- Dashboard e alertas -------------------------------------------------
  secao('dashboard, alertas e listas operacionais (secoes 5, 6, 21, 22 e 54)');
  const dashboard = await chamar('GET', '/api/entregas/dashboard?dias=90', { token: admin });
  checar(b, 'dashboard responde', dashboard.status === 200, dashboard.corpo?.error);
  const ind = dashboard.corpo?.data?.indicadores ?? {};
  checar(b, 'os indicadores principais estao presentes',
    ['pedidos_em_aberto', 'entregas_atrasadas', 'entregas_em_risco', 'quantidade_pendente',
      'valor_pendente', 'otif', 'otd', 'in_full'].every((k) => k in ind), Object.keys(ind));
  checar(b, 'o semaforo operacional e consolidado',
    dashboard.corpo?.data?.semaforo?.VERMELHO !== undefined);
  const matriz = dashboard.corpo?.data?.matriz ?? [];
  checar(b, 'a matriz atraso x impacto e montada (secao 58)', matriz.length === 5);
  checar(b, 'a matriz fecha com o total de itens da carteira',
    matriz.reduce((a: number, l: any) => a + num(l.total), 0)
      === num(dashboard.corpo?.data?.total_itens),
    { matriz: matriz.reduce((a: number, l: any) => a + num(l.total), 0),
      total: dashboard.corpo?.data?.total_itens });
  checar(b, 'cada linha da matriz soma as colunas',
    matriz.every((l: any) =>
      num(l.BAIXO) + num(l.MEDIO) + num(l.ALTO) + num(l.CRITICO) + num(l.SEM_DADOS)
        === num(l.total)), matriz);
  checar(b, 'os parametros usados sao expostos',
    dashboard.corpo?.data?.parametros?.faixas_atraso !== undefined);

  const alertas = await chamar('GET', '/api/entregas/alertas', { token: admin });
  checar(b, 'alertas respondem', alertas.status === 200, alertas.corpo?.error);
  const tipos = (alertas.corpo?.data?.alertas ?? []).map((a: any) => a.tipo);
  checar(b, 'alerta de entrega atrasada aparece', tipos.includes('ENTREGA_ATRASADA'), tipos.slice(0, 8));
  checar(b, 'alerta de pedido sem confirmacao aparece', tipos.includes('PEDIDO_SEM_CONFIRMACAO'));
  checar(b, 'os alertas vem classificados por severidade',
    alertas.corpo?.data?.por_severidade !== undefined);

  const atrasadas = await chamar('GET', '/api/entregas/atrasadas', { token: admin });
  checar(b, 'lista de atrasadas responde', atrasadas.status === 200, atrasadas.corpo?.error);
  checar(b, 'todos os itens da lista estao atrasados',
    (atrasadas.corpo?.data ?? []).every((i: any) => i.situacao === 'ATRASADO'));
  checar(b, 'a meta informa quando foi avaliado',
    typeof atrasadas.corpo?.meta?.avaliado_em === 'string');

  const semConfirmacao = await chamar('GET', '/api/entregas/sem-confirmacao', { token: admin });
  checar(b, 'lista de pedidos sem confirmacao responde',
    semConfirmacao.status === 200
    && (semConfirmacao.corpo?.data ?? []).every((i: any) => i.status_confirmacao === 'NAO_CONFIRMADO'));

  const parciais = await chamar('GET', '/api/entregas/parciais', { token: admin });
  checar(b, 'lista de entregas parciais responde', parciais.status === 200, parciais.corpo?.error);

  const listaEntregas = await chamar('GET', '/api/entregas?limite=5', { token: admin });
  checar(b, 'listagem de entregas paginada',
    listaEntregas.status === 200 && (listaEntregas.corpo?.data ?? []).length <= 5);
  checar(b, 'a listagem informa o total', listaEntregas.corpo?.meta?.total !== undefined);

  // --- 29. Permissoes ------------------------------------------------------
  secao('permissoes e seguranca (secao 66)');
  const semToken = await chamar('GET', '/api/entregas/dashboard');
  checar(b, 'sem token a API recusa', semToken.status === 401);

  const estoque = await tokenDoPerfil(admin, 'ESTOQUE', 'm08');
  if (estoque) {
    const leitura = await chamar('GET', '/api/entregas/dashboard', { token: estoque });
    checar(b, 'ESTOQUE consulta o acompanhamento', leitura.status === 200, leitura.status);
    const tentaPrazo = await chamar('POST',
      `/api/pedidos-compra/${pedidoOcorrencia.id}/alterar-prazo`, {
        token: estoque, corpo: { data_nova: emDias(10), justificativa: 'nao deveria' },
      });
    checar(b, 'ESTOQUE nao altera prazo', tentaPrazo.status === 403, tentaPrazo.status);
  }

  const financeiro = await tokenDoPerfil(admin, 'FINANCEIRO', 'm08');
  if (financeiro) {
    const leitura = await chamar('GET', '/api/indicadores/otif', { token: financeiro });
    checar(b, 'FINANCEIRO consulta indicadores', leitura.status === 200);
    const tentaEntrega = await chamar('POST', '/api/entregas', {
      token: financeiro,
      corpo: {
        ordem_compra_id: pedidoOcorrencia.id, data_real: hoje,
        itens: [{ ordem_compra_item_id: pedidoOcorrencia.itens[0], quantidade: 10 }],
      },
    });
    checar(b, 'FINANCEIRO nao registra entrega', tentaEntrega.status === 403, tentaEntrega.status);
  }

  const comprador = await tokenDoPerfil(admin, 'COMPRADOR', 'm08');
  if (comprador) {
    const tentaParametro = await chamar('PUT', '/api/entregas/parametros', {
      token: comprador,
      corpo: { parametros: [{ chave: 'entrega.otif_tolerancia_dias', valor: '30' }] },
    });
    checar(b, 'COMPRADOR nao altera os parametros de OTIF',
      tentaParametro.status === 403, tentaParametro.status);
  }

  // --- Parametros ----------------------------------------------------------
  secao('parametros configuraveis (secoes 22, 23, 28 e 39)');
  const parametros = await chamar('GET', '/api/entregas/parametros', { token: admin });
  checar(b, 'parametros listados', parametros.status === 200
    && (parametros.corpo?.data ?? []).length >= 15, (parametros.corpo?.data ?? []).length);

  const otifAntes = await chamar('GET', '/api/indicadores/otif?dias=30', { token: admin });
  await chamar('PUT', '/api/entregas/parametros', {
    token: admin,
    corpo: { parametros: [{ chave: 'entrega.otif_tolerancia_dias', valor: '7' }] },
  });
  const otifDepois = await chamar('GET', '/api/indicadores/otif?dias=30', { token: admin });
  checar(b, 'mudar a tolerancia muda o OTD, e a regra nova sai junto',
    num(otifDepois.corpo?.data?.otd) >= num(otifAntes.corpo?.data?.otd)
    && otifDepois.corpo?.data?.regra?.toleranciaDias === 7,
    { antes: otifAntes.corpo?.data?.otd, depois: otifDepois.corpo?.data?.otd });
  await chamar('PUT', '/api/entregas/parametros', {
    token: admin,
    corpo: { parametros: [{ chave: 'entrega.otif_tolerancia_dias', valor: '0' }] },
  });

  const chaveInvalida = await chamar('PUT', '/api/entregas/parametros', {
    token: admin, corpo: { parametros: [{ chave: 'entrega.inexistente', valor: '1' }] },
  });
  checar(b, 'parametro inexistente e ignorado, nao criado',
    (chaveInvalida.corpo?.data?.ignorados ?? []).length === 1);

  // --- Integracoes ---------------------------------------------------------
  secao('integracoes com os modulos anteriores (secoes 50 a 53)');
  const comIntegracao = await chamar('GET',
    `/api/pedidos-compra/${pedidoRuptura.id}/entrega`, { token: admin });
  const itemIntegrado = comIntegracao.corpo?.data?.itens?.[0];
  checar(b, 'traz estoque disponivel, reservado e em transito (modulo 03)',
    itemIntegrado?.estoque?.disponivel !== undefined
    && itemIntegrado?.estoque?.reservado !== undefined
    && itemIntegrado?.estoque?.em_transito !== undefined);
  checar(b, 'traz demanda media e prevista (modulo 04)',
    itemIntegrado?.demanda?.media_diaria !== undefined
    && itemIntegrado?.demanda?.prevista !== undefined);
  checar(b, 'traz a classificacao ABC do produto (modulo 04)',
    itemIntegrado?.classificacao_abc !== undefined);
  checar(b, 'traz a data necessaria do planejamento (modulo 05)',
    itemIntegrado?.datas?.necessaria !== undefined);
  checar(b, 'traz quantidade, preco e condicoes do pedido (modulo 07)',
    itemIntegrado?.saldo?.pedida > 0 && itemIntegrado?.valor_pendente !== undefined);

  const { rows: comercial } = await pool.query(
    'SELECT valor_total, quantidade FROM ordens_compra oc, LATERAL (SELECT 1 AS quantidade) x WHERE oc.id = $1',
    [pedidoRuptura.id]);
  checar(b, 'o modulo 08 nao alterou o valor do pedido',
    num(comercial[0].valor_total) === pedidoRuptura.valor, comercial[0]);

  return b;
}

// ---------------------------------------------------------------------------

async function principal() {
  const baterias: Bateria[] = [];
  try {
    const cenario = await preparar();
    baterias.push(testarCalculos());
    baterias.push(await testarFluxo(cenario));
    baterias.push(await testarRegras(cenario));
  } catch (erro) {
    console.error('\nA bateria parou por erro:', erro);
    process.exitCode = 1;
  } finally {
    encerrar(baterias);
    await encerrarPool();
  }
}

void principal();
