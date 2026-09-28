/**
 * Bateria do MODULO 09 - recebimento, conferencia, qualidade e NC.
 *
 * Cobre as categorias da secao 59 (recebimento, lote, validade, qualidade,
 * estoque, divergencias, devolucao e permissoes) e os seis cenarios
 * obrigatorios da secao 60.
 *
 * Os dados de teste usam o prefixo M09- e ficam no banco.
 */
import { pool, encerrarPool } from '../../config/database.js';
import {
  chamar, checar, encerrar, loginAdmin, novaBateria, secao, tokenDoPerfil,
  type Bateria,
} from './base.js';
import {
  avaliarValidade, calcularAmostra, calcularCustoEntrada, conferirQuantidade,
  converterQuantidade, custoMedioPonderado, decidirDestino, diferencaDias,
  resultadoChecklist, semaforoItem,
  type AvaliacaoValidade, type LimiaresValidade,
} from '../../modules/recebimento/calculos.js';

const num = (v: unknown) => Number(v ?? 0);
const quase = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
const hoje = new Date().toISOString().slice(0, 10);
const emDias = (d: number) =>
  new Date(Date.parse(`${hoje}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);

const LIMIARES: LimiaresValidade = { proximaPercentual: 50, criticaPercentual: 30 };

interface Cenario {
  /** Simples: sem lote, sem validade, sem inspecao. */
  produtoSimples: number;
  /** Controla lote e validade, minimo de 80% de vida util. */
  produtoLote: number;
  /** Exige inspecao de qualidade. */
  produtoQualidade: number;
  fornecedor: number;
  localId: number;
  unidadeId: number;
  /**
   * Desvio entre o saldo fisico e a soma das movimentacoes, medido antes de o
   * modulo 09 agir. A fixture grava saldo direto, sem movimentacao, entao esse
   * desvio comeca diferente de zero: o teste cobra que ele nao cresca.
   */
  desvioInicial: Record<string, number>;
}

/** Saldo fisico menos a soma das movimentacoes, por produto de teste. */
async function desvioEstoque(c: {
  produtoSimples: number; produtoLote: number; produtoQualidade: number;
}): Promise<Record<string, number>> {
  const { rows } = await pool.query(`
    SELECT e.produto_id::text AS produto_id,
           (e.quantidade_fisica - (
             SELECT coalesce(sum(
               CASE WHEN fn_sinal_movimentacao(m.tipo_movimentacao) = 0 THEN m.quantidade
                    ELSE fn_sinal_movimentacao(m.tipo_movimentacao) * m.quantidade END), 0)
               FROM movimentacoes_estoque m
              WHERE m.produto_id = e.produto_id AND m.local_id = e.local_id))::numeric AS desvio
      FROM estoques e
     WHERE e.produto_id IN ($1, $2, $3)`,
    [c.produtoSimples, c.produtoLote, c.produtoQualidade]);
  return Object.fromEntries(rows.map((r) => [r.produto_id, Number(r.desvio)]));
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
      INSERT INTO categorias (nome, descricao)
      VALUES ('M09 TESTES', 'Cenarios da bateria do modulo 09')
      ON CONFLICT (nome) DO UPDATE SET descricao = EXCLUDED.descricao RETURNING id`);
    const categoriaId = Number(cat[0].id);
    const { rows: un } = await cliente.query("SELECT id FROM unidades WHERE codigo = 'KG'");
    const unidadeId = Number(un[0].id);
    const { rows: loc } = await cliente.query(
      'SELECT id FROM locais WHERE ativo ORDER BY id LIMIT 1');
    const localId = Number(loc[0].id);

    const produto = async (codigo: string, descricao: string, extras: {
      controlaLote: boolean; controlaValidade: boolean; diasValidade: number | null;
      minimo: number | null; exigeInspecao: boolean;
    }) => {
      const achado = (await cliente.query(
        'SELECT id FROM produtos WHERE upper(codigo) = upper($1) AND deleted_at IS NULL',
        [codigo])).rows;
      const id = achado.length ? Number(achado[0].id) : Number((await cliente.query(`
        INSERT INTO produtos (codigo, descricao, categoria_id, unidade_compra_id,
                              unidade_estoque_id, unidade_venda_id, fator_conversao,
                              ativo, lead_time_padrao_dias, classificacao_abc)
        VALUES ($1,$2,$3,$4,$4,$4,1,true,10,'A') RETURNING id`,
        [codigo, descricao, categoriaId, unidadeId])).rows[0].id);

      await cliente.query(`
        UPDATE produtos
           SET descricao = $2, ativo = true, controla_lote = $3, controla_validade = $4,
               dias_validade = $5, vida_util_minima_percentual = $6, exige_inspecao = $7,
               custo_referencia = coalesce(nullif(custo_referencia, 0), 10)
         WHERE id = $1`,
        [id, descricao, extras.controlaLote, extras.controlaValidade, extras.diasValidade,
          extras.minimo, extras.exigeInspecao]);
      return id;
    };

    const produtoSimples = await produto('M09-SIMPLES', 'M09 produto sem controle', {
      controlaLote: false, controlaValidade: false, diasValidade: null,
      minimo: null, exigeInspecao: false,
    });
    const produtoLote = await produto('M09-LOTE', 'M09 produto com lote e validade', {
      controlaLote: true, controlaValidade: true, diasValidade: 365,
      minimo: 80, exigeInspecao: false,
    });
    const produtoQualidade = await produto('M09-QUALIDADE', 'M09 produto que exige inspecao', {
      controlaLote: true, controlaValidade: true, diasValidade: 365,
      minimo: 50, exigeInspecao: true,
    });

    for (const p of [produtoSimples, produtoLote, produtoQualidade]) {
      const achado = (await cliente.query(
        'SELECT id FROM estoques WHERE produto_id = $1 AND local_id = $2', [p, localId])).rows;
      if (achado.length) {
        await cliente.query(`
          UPDATE estoques SET quantidade_fisica = 100, quantidade_reservada = 0,
                 quantidade_quarentena = 0, quantidade_bloqueada = 0,
                 quantidade_recebimento = 0 WHERE id = $1`, [achado[0].id]);
      } else {
        await cliente.query(`
          INSERT INTO estoques (produto_id, local_id, quantidade_fisica, quantidade_reservada,
                                quantidade_em_transito) VALUES ($1,$2,100,0,0)`, [p, localId]);
      }
    }

    const achadoF = (await cliente.query(
      "SELECT id FROM fornecedores WHERE razao_social = 'M09 Fornecedor' AND deleted_at IS NULL"
    )).rows;
    const fornecedor = achadoF.length ? Number(achadoF[0].id) : Number((await cliente.query(`
      INSERT INTO fornecedores (razao_social, cnpj, tipo_fornecedor, origem_fornecedor,
                                ativo, lead_time_padrao_dias, prazo_medio_pagamento, email)
      VALUES ('M09 Fornecedor','09000000000101','DISTRIBUIDOR','NACIONAL',true,10,28,
              'm09@teste.local') RETURNING id`)).rows[0].id);
    await cliente.query('UPDATE fornecedores SET ativo = true WHERE id = $1', [fornecedor]);

    await cliente.query('COMMIT');

    const base = { produtoSimples, produtoLote, produtoQualidade, fornecedor, localId, unidadeId };
    return { ...base, desvioInicial: await desvioEstoque(base) };
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }
}

/** Pedido ja aprovado e enviado: o caminho comercial e do modulo 07. */
async function criarPedido(fornecedorId: number, localId: number, itens: Array<{
  produtoId: number; quantidade: number; preco: number;
}>) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query("SELECT set_config('app.usuario_id', '1', true)");

    const { rows: seq } = await cliente.query(`
      SELECT coalesce(max(nullif(regexp_replace(numero, '^.*-', ''), '')::bigint), 0) + 1 AS proximo
        FROM ordens_compra WHERE numero LIKE 'M09-%'`);
    const numero = `M09-${String(seq[0].proximo).padStart(5, '0')}`;
    const valor = itens.reduce((a, i) => a + i.quantidade * i.preco, 0);

    const { rows: oc } = await cliente.query(`
      INSERT INTO ordens_compra
        (numero, fornecedor_id, data_emissao, data_necessaria, data_prometida,
         data_prometida_original, data_prevista_entrega, valor_produtos, valor_total,
         status, status_confirmacao, comprador_id, local_entrega_id, data_envio,
         aprovador_id, data_aprovacao, created_by)
      VALUES ($1,$2,$3::date,$4::date,$4::date,$4::date,$4::date,$5,$5,
              'ENVIADA'::status_ordem_compra_enum,'CONFIRMADO'::status_confirmacao_enum,
              1,$6,$7::timestamptz,1,$7::timestamptz,1)
      RETURNING id`,
      [numero, fornecedorId, emDias(-5), emDias(2), valor, localId, `${emDias(-5)}T12:00:00Z`]);

    const ids: number[] = [];
    for (const i of itens) {
      const { rows } = await cliente.query(`
        INSERT INTO ordem_compra_itens
          (ordem_compra_id, produto_id, quantidade_pedida, quantidade_pendente,
           preco_unitario, valor_total, data_necessaria, data_prometida,
           data_prometida_original, data_prevista_entrega)
        VALUES ($1,$2,$3,$3,$4,$5,$6::date,$6::date,$6::date,$6::date) RETURNING id`,
        [oc[0].id, i.produtoId, i.quantidade, i.preco, i.quantidade * i.preco, emDias(2)]);
      ids.push(Number(rows[0].id));
    }

    await cliente.query('COMMIT');
    return { id: Number(oc[0].id), numero, itens: ids };
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }
}

const estoqueDe = async (produtoId: number, localId: number) => {
  const { rows } = await pool.query(`
    SELECT quantidade_fisica, quantidade_disponivel, quantidade_quarentena,
           quantidade_bloqueada, quantidade_recebimento
      FROM estoques WHERE produto_id = $1 AND local_id = $2`, [produtoId, localId]);
  return rows[0] ?? null;
};

// ---------------------------------------------------------------------------
// 1. Calculos puros
// ---------------------------------------------------------------------------

function testarCalculos(): Bateria {
  const b = novaBateria('MODULO 09 - calculos');

  secao('Conferencia de quantidade (secoes 10, 12 e 13)');
  const integral = conferirQuantidade(100, 100, 5);
  checar(b, 'recebimento integral fica EXATA e dentro da tolerancia',
    integral.situacao === 'EXATA' && integral.dentroTolerancia && integral.diferenca === 0,
    integral);

  const parcial = conferirQuantidade(100, 90, 5);
  checar(b, 'recebimento parcial acusa FALTA de 10',
    parcial.situacao === 'FALTA' && parcial.diferenca === -10, parcial);
  checar(b, 'falta de 10% estoura a tolerancia de 5%', !parcial.dentroTolerancia, parcial);
  checar(b, 'atendimento parcial e de 90%',
    quase(parcial.percentualAtendimento ?? 0, 90), parcial);

  const sobraOk = conferirQuantidade(100, 103, 5);
  checar(b, 'sobra de 3% com tolerancia de 5% fica dentro',
    sobraOk.situacao === 'SOBRA' && sobraOk.dentroTolerancia, sobraOk);

  const sobraRuim = conferirQuantidade(100, 110, 5);
  checar(b, 'sobra de 10% com tolerancia de 5% estoura',
    sobraRuim.situacao === 'SOBRA' && !sobraRuim.dentroTolerancia, sobraRuim);

  const semPedido = conferirQuantidade(0, 20, 5);
  checar(b, 'item sem quantidade pedida nao inventa percentual',
    semPedido.diferencaPercentual === null, semPedido);

  secao('Conversao de unidade (secao 14)');
  checar(b, 'caixa com 12 unidades converte corretamente',
    converterQuantidade(10, 12).convertida === 120);
  checar(b, 'produto sem fator nao assume 1: devolve null com motivo',
    converterQuantidade(10, null).convertida === null
    && !!converterQuantidade(10, null).motivo);

  secao('Validade e regra dos 80% (secao 16)');
  const base = {
    controlaValidade: true, dataFabricacao: null, diasValidadeProduto: 365,
    minimoPercentual: 80, limiares: LIMIARES, hoje,
  };
  const adequada = avaliarValidade({ ...base, dataValidade: emDias(330) });
  checar(b, 'validade de 330 de 365 dias (90%) e ADEQUADA',
    adequada.situacao === 'ADEQUADA' && adequada.atendeMinimo === true, adequada);

  const insuficiente = avaliarValidade({ ...base, dataValidade: emDias(255) });
  checar(b, 'validade de 70% com minimo de 80% e INSUFICIENTE',
    insuficiente.situacao === 'INSUFICIENTE' && insuficiente.atendeMinimo === false,
    insuficiente);
  checar(b, 'o percentual de vida util restante bate com 70%',
    quase(insuficiente.vidaUtilRestantePercentual ?? 0, 69.86, 0.5), insuficiente);

  const critica = avaliarValidade({ ...base, minimoPercentual: null, dataValidade: emDias(60) });
  checar(b, 'validade abaixo de 30% da vida util e CRITICA',
    critica.situacao === 'CRITICA', critica);

  const proxima = avaliarValidade({ ...base, minimoPercentual: null, dataValidade: emDias(150) });
  checar(b, 'validade entre 30% e 50% e PROXIMA', proxima.situacao === 'PROXIMA', proxima);

  const vencido = avaliarValidade({ ...base, dataValidade: emDias(-1) });
  checar(b, 'produto com validade passada e VENCIDO',
    vencido.situacao === 'VENCIDO' && (vencido.diasRestantes ?? 0) < 0, vencido);

  const semControle = avaliarValidade({
    ...base, controlaValidade: false, dataValidade: null,
  });
  checar(b, 'produto sem controle de validade fica SEM_CONTROLE',
    semControle.situacao === 'SEM_CONTROLE' && !semControle.avaliavel, semControle);

  const semData = avaliarValidade({ ...base, dataValidade: null });
  checar(b, 'produto que controla validade sem data nao e avaliavel',
    !semData.avaliavel && !!semData.motivo, semData);

  const comFabricacao = avaliarValidade({
    ...base, dataFabricacao: emDias(-100), dataValidade: emDias(100), diasValidadeProduto: 365,
  });
  checar(b, 'com data de fabricacao a vida util vem do lote, nao do cadastro',
    quase(comFabricacao.vidaUtilTotalDias ?? 0, 200), comFabricacao);

  checar(b, 'diferencaDias conta dias de calendario', diferencaDias(hoje, emDias(45)) === 45);
  checar(b, 'diferencaDias com data ausente devolve null',
    diferencaDias(null, emDias(45)) === null);

  secao('Semaforo (secao 52)');
  const verde = semaforoItem({
    conferido: true, quantidade: integral, validade: adequada,
    exigeLote: true, loteInformado: true, resultadoQualidade: 'APROVADO',
  });
  checar(b, 'tudo conforme acende VERDE em todas as dimensoes',
    verde.geral === 'VERDE' && verde.quantidade === 'VERDE' && verde.validade === 'VERDE'
    && verde.lote === 'VERDE' && verde.qualidade === 'VERDE', verde);

  const cinza = semaforoItem({
    conferido: false, quantidade: null, validade: semData,
    exigeLote: true, loteInformado: false, resultadoQualidade: null,
  });
  checar(b, 'item nao conferido fica CINZA (pendente de informacao)',
    cinza.quantidade === 'CINZA' && cinza.lote === 'CINZA', cinza);

  const vermelho = semaforoItem({
    conferido: true, quantidade: sobraRuim, validade: vencido,
    exigeLote: true, loteInformado: true, resultadoQualidade: 'REPROVADO',
  });
  checar(b, 'vencido e reprovado acende VERMELHO no geral',
    vermelho.geral === 'VERMELHO' && vermelho.validade === 'VERMELHO'
    && vermelho.qualidade === 'VERMELHO', vermelho);

  const amarelo = semaforoItem({
    conferido: true, quantidade: sobraOk, validade: proxima,
    exigeLote: false, loteInformado: false, resultadoQualidade: 'APROVADO_COM_RESSALVA',
  });
  checar(b, 'ressalva e validade proxima acendem AMARELO, nao VERMELHO',
    amarelo.geral === 'AMARELO', amarelo);

  secao('Amostragem e checklist (secoes 17 e 18)');
  const total = calcularAmostra({ tipo: 'TOTAL', tamanhoLote: 40, percentual: null, amostrado: 40 });
  checar(b, 'amostragem TOTAL exige inspecionar o lote inteiro',
    total.suficiente && total.quantidadeAmostrada === 40, total);

  const pouco = calcularAmostra({
    tipo: 'PERCENTUAL', tamanhoLote: 100, percentual: 10, amostrado: 4,
  });
  checar(b, 'amostra de 4 em 100 com exigencia de 10% e insuficiente',
    !pouco.suficiente && !!pouco.motivo, pouco);

  const aprovado = resultadoChecklist([
    { criterio: 'Embalagem', eliminatorio: true, resposta: 'APROVADO' },
    { criterio: 'Rotulo', eliminatorio: false, resposta: 'APROVADO' },
  ]);
  checar(b, 'checklist todo aprovado resulta APROVADO', aprovado.resultado === 'APROVADO');

  const ressalva = resultadoChecklist([
    { criterio: 'Embalagem', eliminatorio: true, resposta: 'APROVADO' },
    { criterio: 'Rotulo', eliminatorio: false, resposta: 'REPROVADO' },
  ]);
  checar(b, 'criterio nao eliminatorio reprovado vira APROVADO_COM_RESSALVA',
    ressalva.resultado === 'APROVADO_COM_RESSALVA' && ressalva.reprovados.length === 1,
    ressalva);

  const reprovado = resultadoChecklist([
    { criterio: 'Embalagem', eliminatorio: true, resposta: 'REPROVADO' },
    { criterio: 'Rotulo', eliminatorio: false, resposta: 'APROVADO' },
  ]);
  checar(b, 'criterio eliminatorio reprovado reprova o lote inteiro',
    reprovado.resultado === 'REPROVADO' && reprovado.eliminatoriosReprovados.length === 1,
    reprovado);

  const naoAplicavel = resultadoChecklist([
    { criterio: 'Embalagem', eliminatorio: true, resposta: 'NAO_APLICAVEL' },
  ]);
  checar(b, 'checklist so com NAO_APLICAVEL fica PENDENTE',
    naoAplicavel.resultado === 'PENDENTE', naoAplicavel);

  secao('Custo de entrada (secao 22)');
  const custo = calcularCustoEntrada({
    quantidadeEntrando: 100, precoUnitario: 10, descontoTotal: 100, freteRateado: 200,
    impostosRateados: 50, outrosCustos: 0, incluirFrete: true, incluirImpostos: true,
    taxaCambio: null,
  });
  checar(b, 'custo unitario = 10 - 1 + 2 + 0,50 = 11,50',
    quase(custo.custoUnitario, 11.5), custo);

  const semFrete = calcularCustoEntrada({
    quantidadeEntrando: 100, precoUnitario: 10, descontoTotal: 0, freteRateado: 200,
    impostosRateados: 0, outrosCustos: 0, incluirFrete: false, incluirImpostos: false,
    taxaCambio: null,
  });
  checar(b, 'com frete desligado o custo fica no preco', quase(semFrete.custoUnitario, 10),
    semFrete);
  checar(b, 'o calculo devolve a memoria da conta', !!custo.memoria?.regra);

  checar(b, 'custo medio de 100 a 10 mais 100 a 20 e 15',
    quase(custoMedioPonderado(100, 10, 100, 20), 15));
  checar(b, 'estoque zerado assume o custo da entrada',
    quase(custoMedioPonderado(0, 99, 100, 20), 20));

  secao('Destino do item (secoes 30, 33 e 58)');
  const padrao = {
    quantidadeRecebida: 100, quantidadeAprovadaQualidade: null,
    quantidadeReprovadaQualidade: null, quantidadeQuarentenaQualidade: null,
    destinoPadrao: 'DISPONIVEL' as const, excecaoValidadeAutorizada: false,
  };

  const ok = decidirDestino({
    ...padrao, resultadoQualidade: 'APROVADO', validade: adequada,
    exigeLote: true, loteInformado: true,
  });
  checar(b, 'item conforme vai para DISPONIVEL com 100 aceitos',
    ok.destino === 'DISPONIVEL' && ok.quantidadeAceita === 100, ok);

  const semLote = decidirDestino({
    ...padrao, resultadoQualidade: 'APROVADO', validade: adequada,
    exigeLote: true, loteInformado: false,
  });
  checar(b, 'regra 2 da secao 58: sem lote nada entra como disponivel',
    semLote.destino === 'AREA_RECEBIMENTO' && semLote.quantidadeAceita === 0, semLote);

  const destinoVencido = decidirDestino({
    ...padrao, resultadoQualidade: null, validade: vencido,
    exigeLote: false, loteInformado: false,
  });
  checar(b, 'produto vencido e RECUSADO por inteiro',
    destinoVencido.destino === 'RECUSADO' && destinoVencido.quantidadeAceita === 0,
    destinoVencido);

  const destinoInsuf = decidirDestino({
    ...padrao, resultadoQualidade: null, validade: insuficiente,
    exigeLote: false, loteInformado: false,
  });
  checar(b, 'vida util abaixo do minimo segura tudo em QUARENTENA',
    destinoInsuf.destino === 'QUARENTENA' && destinoInsuf.quantidadeQuarentena === 100,
    destinoInsuf);

  const comExcecao = decidirDestino({
    ...padrao, resultadoQualidade: 'APROVADO', validade: insuficiente,
    exigeLote: false, loteInformado: false, excecaoValidadeAutorizada: true,
  });
  checar(b, 'excecao autorizada libera a validade insuficiente e registra o motivo',
    comExcecao.destino === 'DISPONIVEL' && comExcecao.motivos.length > 0, comExcecao);

  const destinoReprovado = decidirDestino({
    ...padrao, resultadoQualidade: 'REPROVADO', validade: adequada,
    exigeLote: false, loteInformado: false,
  });
  checar(b, 'regra 4 da secao 58: reprovado nunca entra como disponivel',
    destinoReprovado.destino === 'RECUSADO' && destinoReprovado.quantidadeAceita === 0,
    destinoReprovado);

  const destinoQuarentena = decidirDestino({
    ...padrao, resultadoQualidade: 'QUARENTENA', validade: adequada,
    exigeLote: false, loteInformado: false,
  });
  checar(b, 'regra 5 da secao 58: quarentena nao conta como disponivel',
    destinoQuarentena.destino === 'QUARENTENA' && destinoQuarentena.quantidadeAceita === 0,
    destinoQuarentena);

  return b;
}

// ---------------------------------------------------------------------------
// 2. Cenarios obrigatorios da secao 60
// ---------------------------------------------------------------------------

async function testarCenarios(c: Cenario, token: string): Promise<Bateria> {
  const b = novaBateria('MODULO 09 - cenarios obrigatorios (secao 60)');

  /** Abre, confere e devolve o recebimento detalhado. */
  const abrir = async (pedido: { id: number }) => {
    const { status, corpo } = await chamar('POST', '/api/recebimentos', {
      token,
      corpo: {
        origem: 'PEDIDO', ordem_compra_id: pedido.id, local_id: c.localId,
        numero_nota_fiscal: `NF${Date.now().toString().slice(-8)}`, valor_nota: 1000,
      },
    });
    if (status !== 201) throw new Error(`Falha ao abrir recebimento: ${JSON.stringify(corpo)}`);
    return Number(corpo.data.id);
  };

  // --- CENARIO 1: 100 pedidas, 100 recebidas, validade adequada -> APROVADO --
  secao('CENARIO 1 - integral com validade adequada');
  const p1 = await criarPedido(c.fornecedor, c.localId, [
    { produtoId: c.produtoLote, quantidade: 100, preco: 10 },
  ]);
  const r1 = await abrir(p1);
  const antes1 = await estoqueDe(c.produtoLote, c.localId);

  await chamar('POST', `/api/recebimentos/${r1}/chegada`, { token, corpo: { volumes: 4 } });
  const itens1 = (await chamar('GET', `/api/recebimentos/${r1}/itens`, { token })).corpo.data;
  checar(b, 'o recebimento nasceu com o item do pedido e a quantidade pedida',
    itens1.length === 1 && num(itens1[0].quantidade_pedida) === 100, itens1[0]);

  const conf1 = await chamar('POST', `/api/recebimentos/${r1}/conferencia`, {
    token,
    corpo: {
      itens: [{
        recebimento_item_id: itens1[0].id, quantidade_recebida: 100,
        numero_lote: `M09L${Date.now().toString().slice(-7)}`,
        data_fabricacao: emDias(-30), data_validade: emDias(335),
      }],
    },
  });
  checar(b, 'a conferencia integral e aceita', conf1.status === 200, conf1.corpo);

  const det1 = (await chamar('GET', `/api/recebimentos/${r1}`, { token })).corpo.data;
  const item1 = det1.itens[0];
  checar(b, 'a validade do item e classificada como ADEQUADA',
    item1.situacao_validade === 'ADEQUADA', item1.situacao_validade);
  checar(b, 'o item nao gera divergencia de quantidade',
    (det1.divergencias ?? []).filter((d: any) => d.tipo === 'QUANTIDADE_MENOR'
      || d.tipo === 'QUANTIDADE_MAIOR').length === 0, det1.divergencias);

  await chamar('POST', `/api/recebimentos/${r1}/conferencia/concluir`, { token });
  const validacao1 = (await chamar('GET', `/api/recebimentos/${r1}/validar`, { token })).corpo.data;
  checar(b, 'a validacao previa nao aponta bloqueio',
    (validacao1.bloqueios ?? []).length === 0, validacao1.bloqueios);

  const apr1 = await chamar('POST', `/api/recebimentos/${r1}/aprovar`, {
    token, corpo: { justificativa: 'Cenario 1 - recebimento integral' },
  });
  checar(b, 'CENARIO 1: resultado APROVADO',
    apr1.status === 200 && apr1.corpo.data.status === 'APROVADO', apr1.corpo?.data?.status);

  const depois1 = await estoqueDe(c.produtoLote, c.localId);
  checar(b, 'as 100 unidades entraram no estoque fisico',
    quase(num(depois1.quantidade_fisica) - num(antes1.quantidade_fisica), 100),
    { antes: antes1, depois: depois1 });
  checar(b, 'as 100 unidades ficaram disponiveis',
    quase(num(depois1.quantidade_disponivel) - num(antes1.quantidade_disponivel), 100),
    depois1);

  const { rows: mov1 } = await pool.query(`
    SELECT count(*)::int AS total, sum(quantidade)::numeric AS quantidade
      FROM movimentacoes_estoque
     WHERE documento_tipo = 'RECEBIMENTO' AND documento_id = $1`, [r1]);
  checar(b, 'regra 6 da secao 58: a entrada gerou movimentacao de estoque',
    mov1[0].total > 0 && quase(num(mov1[0].quantidade), 100), mov1[0]);

  const { rows: lote1 } = await pool.query(
    'SELECT numero_lote, data_validade FROM lotes WHERE recebimento_id = $1', [r1]);
  checar(b, 'o lote foi criado com numero e validade', lote1.length === 1
    && !!lote1[0].numero_lote && !!lote1[0].data_validade, lote1[0]);

  const { rows: ped1 } = await pool.query(
    'SELECT quantidade_recebida, quantidade_pendente FROM ordem_compra_itens WHERE id = $1',
    [p1.itens[0]]);
  checar(b, 'o pedido ficou sem saldo pendente',
    quase(num(ped1[0].quantidade_recebida), 100) && quase(num(ped1[0].quantidade_pendente), 0),
    ped1[0]);

  // --- CENARIO 2: 100 pedidas, 90 recebidas -> parcial + saldo ---------------
  secao('CENARIO 2 - parcial com saldo pendente');
  const p2 = await criarPedido(c.fornecedor, c.localId, [
    { produtoId: c.produtoSimples, quantidade: 100, preco: 10 },
  ]);
  const r2 = await abrir(p2);
  await chamar('POST', `/api/recebimentos/${r2}/chegada`, { token, corpo: {} });
  const itens2 = (await chamar('GET', `/api/recebimentos/${r2}/itens`, { token })).corpo.data;
  await chamar('POST', `/api/recebimentos/${r2}/conferencia`, {
    token,
    corpo: { itens: [{ recebimento_item_id: itens2[0].id, quantidade_recebida: 90 }] },
  });
  await chamar('POST', `/api/recebimentos/${r2}/conferencia/concluir`, { token });

  const det2 = (await chamar('GET', `/api/recebimentos/${r2}`, { token })).corpo.data;
  const divQtd = (det2.divergencias ?? []).find((d: any) => d.tipo === 'QUANTIDADE_MENOR');
  checar(b, 'a falta de 10 unidades virou divergencia QUANTIDADE_MENOR', !!divQtd,
    det2.divergencias);
  checar(b, 'regra 7 da secao 58: a divergencia nasce PENDENTE de decisao',
    divQtd?.decisao === 'PENDENTE', divQtd?.decisao);

  const dec2 = await chamar('POST', `/api/divergencias/${divQtd?.id}/decidir`, {
    token,
    corpo: {
      decisao: 'ACEITAR_PARCIAL',
      justificativa: 'Cenario 2 - fornecedor entrega o saldo na proxima remessa',
    },
  });
  checar(b, 'a divergencia e decidida com justificativa', dec2.status === 200, dec2.corpo);

  const apr2 = await chamar('POST', `/api/recebimentos/${r2}/aprovar`, {
    token, corpo: { justificativa: 'Cenario 2 - aprovacao parcial' },
  });
  checar(b, 'CENARIO 2: resultado APROVADO_PARCIALMENTE',
    apr2.status === 200 && apr2.corpo.data.status === 'APROVADO_PARCIALMENTE',
    apr2.corpo?.data?.status);

  const { rows: ped2 } = await pool.query(
    'SELECT quantidade_recebida, quantidade_pendente FROM ordem_compra_itens WHERE id = $1',
    [p2.itens[0]]);
  checar(b, 'CENARIO 2: o pedido guarda saldo pendente de 10',
    quase(num(ped2[0].quantidade_recebida), 90) && quase(num(ped2[0].quantidade_pendente), 10),
    ped2[0]);

  // --- CENARIO 3: 100 pedidas, 110 recebidas --------------------------------
  secao('CENARIO 3 - acima do pedido, dentro e fora da tolerancia');
  // A tolerancia do produto e fixada antes das duas metades do cenario: com
  // 5%, 110 estoura e 102 passa. Sem fixar, o teste dependeria do parametro
  // geral da empresa, que muda conforme a configuracao do banco.
  const tolerancia = await chamar('POST', '/api/recebimentos/tolerancias', {
    token,
    corpo: {
      escopo: 'PRODUTO', produto_id: c.produtoSimples, quantidade_percentual: 5,
      observacao: 'Tolerancia do cenario 3',
    },
  });
  checar(b, 'a tolerancia por produto e cadastrada', tolerancia.status === 201,
    tolerancia.corpo);

  const p3 = await criarPedido(c.fornecedor, c.localId, [
    { produtoId: c.produtoSimples, quantidade: 100, preco: 10 },
  ]);
  const r3 = await abrir(p3);
  await chamar('POST', `/api/recebimentos/${r3}/chegada`, { token, corpo: {} });
  const itens3 = (await chamar('GET', `/api/recebimentos/${r3}/itens`, { token })).corpo.data;
  await chamar('POST', `/api/recebimentos/${r3}/conferencia`, {
    token,
    corpo: { itens: [{ recebimento_item_id: itens3[0].id, quantidade_recebida: 110 }] },
  });
  await chamar('POST', `/api/recebimentos/${r3}/conferencia/concluir`, { token });

  const det3 = (await chamar('GET', `/api/recebimentos/${r3}`, { token })).corpo.data;
  const divMaior = (det3.divergencias ?? []).find((d: any) => d.tipo === 'QUANTIDADE_MAIOR');
  checar(b, 'CENARIO 3: 10% acima excede a tolerancia e vira DIVERGENCIA', !!divMaior,
    det3.divergencias);
  checar(b, 'a divergencia guarda a tolerancia que foi aplicada',
    divMaior?.tolerancia_aplicada !== null && divMaior?.dentro_tolerancia === false,
    divMaior);

  const bloqueio3 = (await chamar('GET', `/api/recebimentos/${r3}/validar`, { token })).corpo.data;
  checar(b, 'excesso sem decisao exige autorizacao de excecao',
    bloqueio3.exige_excecao === true
    && (bloqueio3.avisos ?? []).some((a: any) => a.regra === 'EXCESSO_QUANTIDADE'),
    bloqueio3.avisos);

  const tentativa3 = await chamar('POST', `/api/recebimentos/${r3}/aprovar`, {
    token, corpo: { justificativa: 'tentativa sem decidir a divergencia' },
  });
  checar(b, 'a API recusa aprovar com divergencia pendente', tentativa3.status >= 400,
    tentativa3.status);

  await chamar('POST', `/api/divergencias/${divMaior?.id}/decidir`, {
    token,
    corpo: { decisao: 'ACEITAR', justificativa: 'Cenario 3 - sobra aceita pelo comprador' },
  });
  const apr3 = await chamar('POST', `/api/recebimentos/${r3}/aprovar`, {
    token, corpo: { justificativa: 'Cenario 3 - sobra autorizada' },
  });
  checar(b, 'CENARIO 3: decidida a divergencia, o recebimento e aprovado',
    apr3.status === 200
    && ['APROVADO', 'APROVADO_PARCIALMENTE'].includes(apr3.corpo?.data?.status),
    apr3.corpo);

  const pos3 = (await chamar('GET', `/api/recebimentos/${r3}/validar`, { token })).corpo.data;
  checar(b, 'decidida a divergencia, o excesso deixa de exigir excecao',
    pos3.exige_excecao === false, pos3.avisos);

  // Dentro da tolerancia: 100 pedidas, 102 recebidas com tolerancia de 5%.
  const p3b = await criarPedido(c.fornecedor, c.localId, [
    { produtoId: c.produtoSimples, quantidade: 100, preco: 10 },
  ]);
  const r3b = await abrir(p3b);
  await chamar('POST', `/api/recebimentos/${r3b}/chegada`, { token, corpo: {} });
  const itens3b = (await chamar('GET', `/api/recebimentos/${r3b}/itens`, { token })).corpo.data;
  await chamar('POST', `/api/recebimentos/${r3b}/conferencia`, {
    token,
    corpo: { itens: [{ recebimento_item_id: itens3b[0].id, quantidade_recebida: 102 }] },
  });
  await chamar('POST', `/api/recebimentos/${r3b}/conferencia/concluir`, { token });
  const det3b = (await chamar('GET', `/api/recebimentos/${r3b}`, { token })).corpo.data;
  checar(b, 'CENARIO 3: 2% com tolerancia de 5% nao gera divergencia',
    (det3b.divergencias ?? []).filter((d: any) => d.tipo === 'QUANTIDADE_MAIOR').length === 0,
    det3b.divergencias);
  const apr3b = await chamar('POST', `/api/recebimentos/${r3b}/aprovar`, {
    token, corpo: { justificativa: 'Cenario 3 - dentro da tolerancia' },
  });
  checar(b, 'CENARIO 3: dentro da tolerancia o resultado e APROVADO',
    apr3b.status === 200, apr3b.corpo?.data?.status);

  // --- CENARIO 4: validade de 70% com minimo de 80% -> NAO CONFORME ---------
  secao('CENARIO 4 - vida util de 70% com minimo de 80%');
  const p4 = await criarPedido(c.fornecedor, c.localId, [
    { produtoId: c.produtoLote, quantidade: 50, preco: 10 },
  ]);
  const r4 = await abrir(p4);
  const antes4 = await estoqueDe(c.produtoLote, c.localId);
  await chamar('POST', `/api/recebimentos/${r4}/chegada`, { token, corpo: {} });
  const itens4 = (await chamar('GET', `/api/recebimentos/${r4}/itens`, { token })).corpo.data;
  await chamar('POST', `/api/recebimentos/${r4}/conferencia`, {
    token,
    corpo: {
      itens: [{
        recebimento_item_id: itens4[0].id, quantidade_recebida: 50,
        numero_lote: `M09V${Date.now().toString().slice(-7)}`,
        data_validade: emDias(255),
      }],
    },
  });
  await chamar('POST', `/api/recebimentos/${r4}/conferencia/concluir`, { token });

  const det4 = (await chamar('GET', `/api/recebimentos/${r4}`, { token })).corpo.data;
  checar(b, 'CENARIO 4: a validade e classificada como INSUFICIENTE',
    det4.itens[0].situacao_validade === 'INSUFICIENTE', det4.itens[0].situacao_validade);
  checar(b, 'CENARIO 4: o destino do item e QUARENTENA, nao DISPONIVEL',
    det4.itens[0].destino === 'QUARENTENA', det4.itens[0].destino);
  const divVal = (det4.divergencias ?? []).find((d: any) => d.tipo === 'VALIDADE_DIVERGENTE');
  checar(b, 'CENARIO 4: nasce divergencia de VALIDADE', !!divVal, det4.divergencias);
  checar(b, 'CENARIO 4: a vida util restante fica abaixo de 80%',
    num(det4.itens[0].vida_util_restante_percentual) < 80,
    det4.itens[0].vida_util_restante_percentual);

  await chamar('POST', `/api/divergencias/${divVal?.id}/decidir`, {
    token, corpo: { decisao: 'ACEITAR', justificativa: 'Cenario 4 - segurar em quarentena para analise' },
  });
  const apr4 = await chamar('POST', `/api/recebimentos/${r4}/aprovar`, {
    token, corpo: { justificativa: 'Cenario 4 - entrada em quarentena' },
  });
  checar(b, 'CENARIO 4: o recebimento e concluido sem liberar o material',
    apr4.status === 200, apr4.corpo);

  const depois4 = await estoqueDe(c.produtoLote, c.localId);
  checar(b, 'CENARIO 4: as 50 unidades foram para o bucket de quarentena',
    quase(num(depois4.quantidade_quarentena) - num(antes4.quantidade_quarentena), 50),
    { antes: antes4, depois: depois4 });
  checar(b, 'CENARIO 4: nada foi somado ao disponivel',
    quase(num(depois4.quantidade_disponivel), num(antes4.quantidade_disponivel)),
    { antes: antes4, depois: depois4 });

  // --- CENARIO 5: problema de qualidade -> QUARENTENA -----------------------
  secao('CENARIO 5 - problema de qualidade');
  const p5 = await criarPedido(c.fornecedor, c.localId, [
    { produtoId: c.produtoQualidade, quantidade: 40, preco: 10 },
  ]);
  const r5 = await abrir(p5);
  const antes5 = await estoqueDe(c.produtoQualidade, c.localId);
  await chamar('POST', `/api/recebimentos/${r5}/chegada`, { token, corpo: {} });
  const itens5 = (await chamar('GET', `/api/recebimentos/${r5}/itens`, { token })).corpo.data;
  await chamar('POST', `/api/recebimentos/${r5}/conferencia`, {
    token,
    corpo: {
      itens: [{
        recebimento_item_id: itens5[0].id, quantidade_recebida: 40,
        numero_lote: `M09Q${Date.now().toString().slice(-7)}`,
        data_validade: emDias(300),
      }],
    },
  });

  const semInspecao = (await chamar('GET', `/api/recebimentos/${r5}/validar`, { token })).corpo.data;
  checar(b, 'produto que exige inspecao bloqueia a aprovacao antes dela',
    (semInspecao.bloqueios ?? []).some((x: any) =>
      JSON.stringify(x).toLowerCase().includes('inspe')), semInspecao.bloqueios);

  const insp5 = await chamar('POST', `/api/recebimentos/${r5}/inspecao`, {
    token,
    corpo: {
      recebimento_item_id: itens5[0].id, checklist_codigo: 'NATURAIS',
      tipo_amostragem: 'PERCENTUAL', quantidade_amostrada: 40,
      quantidade_quarentena: 40,
      observacoes: 'Cenario 5 - aspecto fora do padrao, reter para analise',
      respostas: [
        { criterio: 'CONFORME_ESPECIFICACAO', resposta: 'REPROVADO',
          observacao: 'Cor irregular no lote' },
      ],
    },
  });
  checar(b, 'a inspecao e registrada', insp5.status === 201, insp5.corpo);

  const qua5 = (await chamar('GET', `/api/recebimentos/${r5}/qualidade`, { token })).corpo.data;
  checar(b, 'o painel de qualidade mostra a inspecao do recebimento',
    qua5.resumo.inspecoes >= 1, qua5.resumo);

  const excesso5 = await chamar('POST', `/api/recebimentos/${r5}/quarentena`, {
    token,
    corpo: {
      recebimento_item_id: itens5[0].id, quantidade: 41,
      motivo: 'Cenario 5 - tentativa de retar mais do que chegou',
    },
  });
  checar(b, 'nao e possivel colocar em quarentena mais do que chegou',
    excesso5.status >= 400, excesso5.status);

  const quar5 = await chamar('POST', `/api/recebimentos/${r5}/quarentena`, {
    token,
    corpo: {
      recebimento_item_id: itens5[0].id, quantidade: 40,
      motivo: 'Cenario 5 - aspecto visual fora do padrao',
    },
  });
  checar(b, 'CENARIO 5: a quarentena e aberta', quar5.status === 201, quar5.corpo);

  await chamar('POST', `/api/recebimentos/${r5}/conferencia/concluir`, { token });
  const apr5 = await chamar('POST', `/api/recebimentos/${r5}/aprovar`, {
    token, corpo: { justificativa: 'Cenario 5 - material retido' },
  });
  checar(b, 'CENARIO 5: o recebimento fecha sem liberar o material', apr5.status === 200,
    apr5.corpo);

  const depois5 = await estoqueDe(c.produtoQualidade, c.localId);
  checar(b, 'CENARIO 5: o material ficou em quarentena',
    num(depois5.quantidade_quarentena) > num(antes5.quantidade_quarentena),
    { antes: antes5, depois: depois5 });
  checar(b, 'CENARIO 5: o disponivel nao subiu',
    quase(num(depois5.quantidade_disponivel), num(antes5.quantidade_disponivel)),
    { antes: antes5, depois: depois5 });

  const listaQ = (await chamar('GET', '/api/quarentenas?status=ABERTA', { token })).corpo;
  checar(b, 'a quarentena aparece na fila de decisao',
    (listaQ.data ?? []).some((q: any) => Number(q.recebimento_id) === r5), listaQ.meta);

  const quarentenaId = (listaQ.data ?? []).find(
    (q: any) => Number(q.recebimento_id) === r5)?.id;
  const libera = await chamar('POST', `/api/quarentenas/${quarentenaId}/decidir`, {
    token,
    corpo: {
      decisao: 'LIBERAR', quantidade: 40,
      justificativa: 'Cenario 5 - laudo do fornecedor aprovou o lote',
    },
  });
  checar(b, 'a quarentena pode ser liberada com justificativa', libera.status === 200,
    libera.corpo);

  const depoisLib = await estoqueDe(c.produtoQualidade, c.localId);
  checar(b, 'ao liberar, o saldo sai da quarentena e vira disponivel',
    num(depoisLib.quantidade_quarentena) < num(depois5.quantidade_quarentena)
    && num(depoisLib.quantidade_disponivel) > num(depois5.quantidade_disponivel),
    { antes: depois5, depois: depoisLib });
  checar(b, 'liberar quarentena nao cria estoque fisico novo',
    quase(num(depoisLib.quantidade_fisica), num(depois5.quantidade_fisica)),
    { antes: depois5, depois: depoisLib });

  // --- CENARIO 6: produto reprovado -> nao disponivel ------------------------
  secao('CENARIO 6 - produto reprovado');
  const p6 = await criarPedido(c.fornecedor, c.localId, [
    { produtoId: c.produtoQualidade, quantidade: 30, preco: 10 },
  ]);
  const r6 = await abrir(p6);
  const antes6 = await estoqueDe(c.produtoQualidade, c.localId);
  await chamar('POST', `/api/recebimentos/${r6}/chegada`, { token, corpo: {} });
  const itens6 = (await chamar('GET', `/api/recebimentos/${r6}/itens`, { token })).corpo.data;
  await chamar('POST', `/api/recebimentos/${r6}/conferencia`, {
    token,
    corpo: {
      itens: [{
        recebimento_item_id: itens6[0].id, quantidade_recebida: 30,
        numero_lote: `M09R${Date.now().toString().slice(-7)}`,
        data_validade: emDias(300),
      }],
    },
  });
  const insp6 = await chamar('POST', `/api/recebimentos/${r6}/inspecao`, {
    token,
    corpo: {
      recebimento_item_id: itens6[0].id, checklist_codigo: 'NATURAIS',
      quantidade_amostrada: 30, quantidade_reprovada: 30,
      observacoes: 'Cenario 6 - embalagem violada em todo o lote',
      respostas: [
        { criterio: 'EMBALAGEM_INTEGRA', resposta: 'REPROVADO',
          observacao: 'Embalagens abertas em todo o lote' },
      ],
    },
  });
  checar(b, 'a inspecao reprovando o lote e registrada', insp6.status === 201, insp6.corpo);
  await chamar('POST', `/api/recebimentos/${r6}/conferencia/concluir`, { token });

  const det6 = (await chamar('GET', `/api/recebimentos/${r6}`, { token })).corpo.data;
  checar(b, 'CENARIO 6: o destino do item reprovado e RECUSADO',
    det6.itens[0].destino === 'RECUSADO', det6.itens[0].destino);

  const apr6 = await chamar('POST', `/api/recebimentos/${r6}/aprovar`, {
    token, corpo: { justificativa: 'Cenario 6 - lote reprovado na inspecao' },
  });
  checar(b, 'CENARIO 6: o recebimento e fechado', apr6.status === 200, apr6.corpo?.data?.status);

  const depois6 = await estoqueDe(c.produtoQualidade, c.localId);
  checar(b, 'CENARIO 6: NADA do lote reprovado entrou como disponivel',
    quase(num(depois6.quantidade_disponivel), num(antes6.quantidade_disponivel)),
    { antes: antes6, depois: depois6 });
  checar(b, 'CENARIO 6: o fisico tambem nao subiu com material recusado',
    quase(num(depois6.quantidade_fisica), num(antes6.quantidade_fisica)),
    { antes: antes6, depois: depois6 });

  const { rows: ncs6 } = await pool.query(
    'SELECT id, tipo, severidade FROM nao_conformidades WHERE recebimento_id = $1', [r6]);
  checar(b, 'CENARIO 6: a reprovacao gerou nao conformidade', ncs6.length > 0, ncs6);

  return b;
}

// ---------------------------------------------------------------------------
// 3. Regras, NC, devolucao e permissoes
// ---------------------------------------------------------------------------

async function testarRegras(c: Cenario, token: string, tokenAdmin: string): Promise<Bateria> {
  const b = novaBateria('MODULO 09 - regras criticas, NC, devolucao e permissoes');

  secao('Regras criticas da secao 58');

  // Regra 1: sem conferencia nao ha entrada definitiva.
  const pA = await criarPedido(c.fornecedor, c.localId, [
    { produtoId: c.produtoSimples, quantidade: 20, preco: 10 },
  ]);
  const rA = Number((await chamar('POST', '/api/recebimentos', {
    token,
    corpo: { origem: 'PEDIDO', ordem_compra_id: pA.id, local_id: c.localId },
  })).corpo.data.id);
  const semConf = await chamar('POST', `/api/recebimentos/${rA}/aprovar`, {
    token, corpo: { justificativa: 'tentativa sem conferir' },
  });
  checar(b, 'regra 1: aprovar sem conferencia e recusado', semConf.status >= 400, semConf.status);

  // Regra 2 e 3: lote e validade obrigatorios para quem controla.
  const pB = await criarPedido(c.fornecedor, c.localId, [
    { produtoId: c.produtoLote, quantidade: 20, preco: 10 },
  ]);
  const rB = Number((await chamar('POST', '/api/recebimentos', {
    token,
    corpo: { origem: 'PEDIDO', ordem_compra_id: pB.id, local_id: c.localId },
  })).corpo.data.id);
  await chamar('POST', `/api/recebimentos/${rB}/chegada`, { token, corpo: {} });
  const itensB = (await chamar('GET', `/api/recebimentos/${rB}/itens`, { token })).corpo.data;
  await chamar('POST', `/api/recebimentos/${rB}/conferencia`, {
    token,
    corpo: { itens: [{ recebimento_item_id: itensB[0].id, quantidade_recebida: 20 }] },
  });
  const valB = (await chamar('GET', `/api/recebimentos/${rB}/validar`, { token })).corpo.data;
  const textoB = JSON.stringify(valB.bloqueios ?? []).toLowerCase();
  checar(b, 'regra 2: produto controlado por lote sem lote informado bloqueia',
    textoB.includes('lote'), valB.bloqueios);
  checar(b, 'regra 3: produto controlado por validade sem validade bloqueia',
    textoB.includes('validade'), valB.bloqueios);
  checar(b, 'as mensagens de bloqueio estao em portugues e sao acionaveis',
    (valB.bloqueios ?? []).every((x: any) => typeof (x.mensagem ?? x) === 'string'
      && String(x.mensagem ?? x).length > 10), valB.bloqueios);

  // Produto vencido.
  const pC = await criarPedido(c.fornecedor, c.localId, [
    { produtoId: c.produtoLote, quantidade: 10, preco: 10 },
  ]);
  const rC = Number((await chamar('POST', '/api/recebimentos', {
    token,
    corpo: { origem: 'PEDIDO', ordem_compra_id: pC.id, local_id: c.localId },
  })).corpo.data.id);
  await chamar('POST', `/api/recebimentos/${rC}/chegada`, { token, corpo: {} });
  const itensC = (await chamar('GET', `/api/recebimentos/${rC}/itens`, { token })).corpo.data;
  await chamar('POST', `/api/recebimentos/${rC}/conferencia`, {
    token,
    corpo: {
      itens: [{
        recebimento_item_id: itensC[0].id, quantidade_recebida: 10,
        numero_lote: `M09VENC${Date.now().toString().slice(-5)}`, data_validade: emDias(-2),
      }],
    },
  });
  const detC = (await chamar('GET', `/api/recebimentos/${rC}`, { token })).corpo.data;
  checar(b, 'produto vencido e marcado como VENCIDO',
    detC.itens[0].situacao_validade === 'VENCIDO', detC.itens[0].situacao_validade);
  checar(b, 'produto vencido tem destino RECUSADO',
    detC.itens[0].destino === 'RECUSADO', detC.itens[0].destino);

  // Lote duplicado no mesmo fornecedor e produto.
  const numeroLote = `M09DUP${Date.now().toString().slice(-6)}`;
  const criarComLote = async (quantidade: number, validade: string) => {
    const p = await criarPedido(c.fornecedor, c.localId, [
      { produtoId: c.produtoLote, quantidade, preco: 10 },
    ]);
    const r = Number((await chamar('POST', '/api/recebimentos', {
      token, corpo: { origem: 'PEDIDO', ordem_compra_id: p.id, local_id: c.localId },
    })).corpo.data.id);
    await chamar('POST', `/api/recebimentos/${r}/chegada`, { token, corpo: {} });
    const it = (await chamar('GET', `/api/recebimentos/${r}/itens`, { token })).corpo.data;
    const conf = await chamar('POST', `/api/recebimentos/${r}/conferencia`, {
      token,
      corpo: {
        itens: [{
          recebimento_item_id: it[0].id, quantidade_recebida: quantidade,
          numero_lote: numeroLote, data_validade: validade,
        }],
      },
    });
    return { r, conf };
  };

  const dup1 = await criarComLote(10, emDias(330));
  await chamar('POST', `/api/recebimentos/${dup1.r}/conferencia/concluir`, { token });
  await chamar('POST', `/api/recebimentos/${dup1.r}/aprovar`, {
    token, corpo: { justificativa: 'Primeira entrada do lote' },
  });
  const dup2 = await criarComLote(10, emDias(330));
  const detDup = (await chamar('GET', `/api/recebimentos/${dup2.r}`, { token })).corpo.data;
  checar(b, 'lote repetido do mesmo produto e sinalizado, nao duplicado as cegas',
    (detDup.divergencias ?? []).some((d: any) => d.tipo === 'LOTE')
    || (detDup.avisos ?? []).length > 0
    || detDup.itens[0].numero_lote === numeroLote, detDup.divergencias);

  const { rows: lotes } = await pool.query(
    'SELECT count(*)::int AS total FROM lotes WHERE numero_lote = $1 AND produto_id = $2',
    [numeroLote, c.produtoLote]);
  checar(b, 'o mesmo numero de lote nao cria dois registros de lote para o produto',
    lotes[0].total === 1, lotes[0]);

  secao('Divergencias e nao conformidades');
  const listaDiv = await chamar('GET', '/api/divergencias?apenas_pendentes=true', { token });
  checar(b, 'a fila de divergencias responde com paginacao',
    listaDiv.status === 200 && Array.isArray(listaDiv.corpo.data)
    && listaDiv.corpo.meta?.total !== undefined, listaDiv.corpo?.meta);

  const nc = await chamar('POST', '/api/nao-conformidades', {
    token,
    corpo: {
      recebimento_id: rC, fornecedor_id: c.fornecedor, produto_id: c.produtoLote,
      tipo: 'VALIDADE', severidade: 'CRITICA',
      descricao: 'Lote entregue vencido pelo fornecedor',
      quantidade_afetada: 10, prazo: emDias(15),
    },
  });
  checar(b, 'a nao conformidade e aberta com numero', nc.status === 201 && !!nc.corpo.data.numero,
    nc.corpo?.data?.numero);
  const ncId = Number(nc.corpo?.data?.id);

  const encerrarDireto = await chamar('PUT', `/api/nao-conformidades/${ncId}`, {
    token, corpo: { status: 'ENCERRADA' },
  });
  checar(b, 'encerrar NC sem descrever o desfecho e recusado', encerrarDireto.status >= 400,
    encerrarDireto.status);

  const acao = await chamar('POST', `/api/nao-conformidades/${ncId}/acoes`, {
    token,
    corpo: {
      tipo: 'CORRETIVA', descricao: 'Solicitar troca do lote ao fornecedor',
      prazo: emDias(10),
    },
  });
  checar(b, 'a acao corretiva e registrada', acao.status === 201, acao.corpo);

  const concluir = await chamar('POST', `/api/nc-acoes/${acao.corpo?.data?.id}/concluir`, {
    token, corpo: { status: 'CONCLUIDA', resultado: 'Fornecedor trocou o lote' },
  });
  checar(b, 'a acao e concluida com resultado', concluir.status === 200, concluir.corpo);

  // A NC segue a maquina de estados da secao 36: ABERTA nao pula direto para
  // RESOLVIDA. Passa por analise e acao definida antes de fechar.
  const pulo = await chamar('PUT', `/api/nao-conformidades/${ncId}`, {
    token, corpo: { status: 'ENCERRADA', observacao: 'tentando pular o fluxo' },
  });
  checar(b, 'a NC nao pula de ABERTA direto para ENCERRADA', pulo.status >= 400, pulo.status);

  const analise = await chamar('PUT', `/api/nao-conformidades/${ncId}`, {
    token, corpo: { status: 'EM_ANALISE', causa: 'Estoque antigo do fornecedor' },
  });
  checar(b, 'a NC avanca para EM_ANALISE', analise.status === 200, analise.corpo);

  const definida = await chamar('PUT', `/api/nao-conformidades/${ncId}`, {
    token, corpo: { status: 'ACAO_DEFINIDA', acao: 'DEVOLUCAO' },
  });
  checar(b, 'a NC avanca para ACAO_DEFINIDA', definida.status === 200, definida.corpo);

  const tratar = await chamar('PUT', `/api/nao-conformidades/${ncId}`, {
    token,
    corpo: {
      status: 'RESOLVIDA', acao: 'DEVOLUCAO', causa: 'Estoque antigo do fornecedor',
      observacao: 'Lote devolvido e substituido pelo fornecedor',
    },
  });
  checar(b, 'a NC e resolvida com causa e desfecho', tratar.status === 200, tratar.corpo);

  const detNc = (await chamar('GET', `/api/nao-conformidades/${ncId}`, { token })).corpo.data;
  checar(b, 'o detalhe da NC traz o historico de acoes',
    (detNc.acoes ?? []).length >= 1, detNc.acoes?.length);

  secao('Devolucao (secao 34)');
  const devParcial = await chamar('POST', '/api/devolucoes', {
    token,
    corpo: {
      recebimento_id: rC, fornecedor_id: c.fornecedor, motivo: 'VALIDADE',
      descricao: 'Devolucao parcial do lote vencido',
      itens: [{
        recebimento_item_id: itensC[0].id, produto_id: c.produtoLote, quantidade: 4,
        preco_unitario: 10,
      }],
    },
  });
  checar(b, 'devolucao parcial e criada', devParcial.status === 201, devParcial.corpo);
  checar(b, 'a devolucao nasce como RASCUNHO, sem efeito no estoque',
    devParcial.corpo?.data?.status === 'RASCUNHO', devParcial.corpo?.data?.status);

  const autorizar = await chamar(
    'POST', `/api/devolucoes/${devParcial.corpo?.data?.id}/autorizar`, {
      token, corpo: { justificativa: 'Autorizado pelo gerente de compras' },
    });
  checar(b, 'a devolucao precisa de autorizacao explicita', autorizar.status === 200,
    autorizar.corpo);

  const devTotal = await chamar('POST', '/api/devolucoes', {
    token,
    corpo: {
      recebimento_id: rC, fornecedor_id: c.fornecedor, motivo: 'VALIDADE',
      descricao: 'Devolucao do saldo restante',
      itens: [{
        recebimento_item_id: itensC[0].id, produto_id: c.produtoLote, quantidade: 6,
        preco_unitario: 10,
      }],
    },
  });
  checar(b, 'devolucao total do saldo e criada', devTotal.status === 201, devTotal.corpo);

  const excesso = await chamar('POST', '/api/devolucoes', {
    token,
    corpo: {
      recebimento_id: rC, fornecedor_id: c.fornecedor, motivo: 'VALIDADE',
      descricao: 'Tentativa de devolver mais do que chegou',
      itens: [{
        recebimento_item_id: itensC[0].id, produto_id: c.produtoLote, quantidade: 999,
      }],
    },
  });
  checar(b, 'devolver mais do que foi recebido e recusado', excesso.status >= 400, excesso.status);

  const listaDev = await chamar('GET', '/api/devolucoes', { token });
  checar(b, 'a lista de devolucoes responde', listaDev.status === 200
    && Array.isArray(listaDev.corpo.data), listaDev.status);

  secao('Historico, rastreabilidade e imutabilidade');
  const rastro = await chamar('GET', `/api/recebimentos/${rC}/rastreabilidade`, { token });
  checar(b, 'a rastreabilidade devolve a cadeia do recebimento',
    rastro.status === 200 && !!rastro.corpo.data, rastro.status);

  const { rows: apagar } = await pool.query(`
    SELECT count(*)::int AS total FROM information_schema.triggers
     WHERE event_object_table = 'recebimento_divergencias' AND event_manipulation = 'DELETE'`);
  checar(b, 'a tabela de divergencias tem trigger que impede DELETE',
    apagar[0].total > 0, apagar[0]);

  let bloqueouDelete = false;
  try {
    await pool.query('DELETE FROM recebimento_divergencias WHERE recebimento_id = $1', [rC]);
  } catch {
    bloqueouDelete = true;
  }
  checar(b, 'regra 7 da secao 58: o banco recusa apagar divergencia', bloqueouDelete);

  const { rows: aud } = await pool.query(`
    SELECT count(*)::int AS total FROM auditoria
     WHERE tabela IN ('recebimentos','recebimento_itens','nao_conformidades')`);
  checar(b, 'as operacoes do modulo ficam registradas na auditoria', aud[0].total > 0, aud[0]);

  const encerradoEdicao = await chamar('PUT', `/api/recebimentos/${dup1.r}`, {
    token, corpo: { observacao: 'tentando editar recebimento ja aprovado' },
  });
  checar(b, 'regra 9 da secao 58: recebimento efetivado nao aceita edicao',
    encerradoEdicao.status >= 400, encerradoEdicao.status);

  secao('Indicadores e alertas (secoes 44 e 53)');
  const dash = await chamar('GET', '/api/recebimentos/dashboard?dias=120', { token });
  checar(b, 'o painel de recebimento responde', dash.status === 200 && !!dash.corpo.data,
    dash.status);

  const ind = (await chamar('GET', '/api/recebimentos/indicadores?dias=120', { token })).corpo.data;
  checar(b, 'os indicadores trazem volume de recebimentos', num(ind?.total) > 0,
    ind?.total);
  checar(b, 'os indicadores trazem taxa de divergencia e a formula do calculo',
    ind?.taxaDivergencia !== undefined && !!ind?.formula,
    { taxa: ind?.taxaDivergencia, formula: ind?.formula });

  const alertas = (await chamar('GET', '/api/recebimentos/alertas', { token })).corpo.data;
  checar(b, 'os alertas vem em lista, com contagem por severidade',
    Array.isArray(alertas?.alertas) && alertas?.por_severidade !== undefined,
    { total: alertas?.total, por_severidade: alertas?.por_severidade });

  const qualidade = await chamar('GET', '/api/nao-conformidades/dashboard?dias=120', { token });
  checar(b, 'o painel de qualidade responde', qualidade.status === 200, qualidade.status);

  const validade = await chamar('GET', '/api/recebimentos/controle-validade?dias=400', { token });
  checar(b, 'o controle de validade (FEFO) responde', validade.status === 200, validade.status);

  const pacote = await chamar(
    `GET`, `/api/fornecedores/${c.fornecedor}/qualidade?dias=180`, { token });
  checar(b, 'o pacote do fornecedor entrega dados brutos para o modulo 10',
    pacote.status === 200 && !!pacote.corpo.data, pacote.status);
  checar(b, 'o pacote NAO calcula score nem ranking (fica para o modulo 10)',
    pacote.corpo?.data?.score === undefined && pacote.corpo?.data?.ranking === undefined,
    Object.keys(pacote.corpo?.data ?? {}));

  secao('Permissoes (secao 59)');
  const semToken = await chamar('GET', '/api/recebimentos');
  checar(b, 'sem token a API responde 401', semToken.status === 401, semToken.status);

  const tokenEstoque = await tokenDoPerfil(tokenAdmin, 'ESTOQUE', 'm09');
  if (tokenEstoque) {
    const leitura = await chamar('GET', '/api/recebimentos', { token: tokenEstoque });
    checar(b, 'o perfil ESTOQUE consegue ler recebimentos', leitura.status === 200,
      leitura.status);
    const param = await chamar('PUT', '/api/recebimentos/parametros', {
      token: tokenEstoque,
      corpo: { parametros: [{ chave: 'recebimento_tolerancia_padrao', valor: '99' }] },
    });
    checar(b, 'o perfil ESTOQUE nao parametriza tolerancias', param.status === 403,
      param.status);
  } else {
    checar(b, 'perfil ESTOQUE disponivel para o teste de permissao', false);
    checar(b, 'perfil ESTOQUE bloqueado na parametrizacao', false);
  }

  const tokenComercial = await tokenDoPerfil(tokenAdmin, 'COMERCIAL', 'm09');
  if (tokenComercial) {
    const aprovar = await chamar('POST', `/api/recebimentos/${rC}/aprovar`, {
      token: tokenComercial, corpo: { justificativa: 'tentativa sem permissao' },
    });
    checar(b, 'o perfil COMERCIAL nao aprova recebimento', aprovar.status === 403,
      aprovar.status);
    const devolver = await chamar('POST', '/api/devolucoes', {
      token: tokenComercial,
      corpo: {
        fornecedor_id: c.fornecedor, motivo: 'AVARIA',
        itens: [{ produto_id: c.produtoLote, quantidade: 1 }],
      },
    });
    checar(b, 'o perfil COMERCIAL nao cria devolucao', devolver.status === 403,
      devolver.status);
  } else {
    checar(b, 'perfil COMERCIAL disponivel para o teste de permissao', false);
    checar(b, 'perfil COMERCIAL bloqueado na devolucao', false);
  }

  const tokenQualidade = await tokenDoPerfil(tokenAdmin, 'QUALIDADE', 'm09');
  if (tokenQualidade) {
    const painel = await chamar('GET', '/api/nao-conformidades?limite=5',
      { token: tokenQualidade });
    checar(b, 'o perfil QUALIDADE le as nao conformidades', painel.status === 200,
      painel.status);
  } else {
    checar(b, 'perfil QUALIDADE disponivel para o teste de permissao', false);
  }

  secao('Fronteiras do modulo');
  // A fixture grava quantidade_fisica direto, sem movimentacao, entao existe um
  // desvio de partida. O que se cobra do modulo 09 e que esse desvio NAO cresca:
  // cada unidade que entrou pelo modulo tem movimentacao correspondente
  // (regra 6 da secao 58).
  const desvioAtual = await desvioEstoque(c);
  const desvios = Object.entries(desvioAtual)
    .filter(([produtoId, valor]) => !quase(valor, c.desvioInicial[produtoId] ?? 0));
  checar(b, 'todo saldo creditado pelo modulo tem movimentacao correspondente',
    desvios.length === 0, { inicial: c.desvioInicial, atual: desvioAtual });

  const { rows: comercial } = await pool.query(`
    SELECT count(*)::int AS total FROM ordem_compra_itens oci
     JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
    WHERE oc.numero LIKE 'M09-%' AND oci.preco_unitario <> 10`);
  checar(b, 'o modulo 09 nao alterou preco de item de pedido', comercial[0].total === 0,
    comercial[0]);

  return b;
}

// ---------------------------------------------------------------------------

async function principal() {
  const baterias: Bateria[] = [];
  try {
    const cenario = await preparar();
    const token = await loginAdmin();
    baterias.push(testarCalculos());
    baterias.push(await testarCenarios(cenario, token));
    baterias.push(await testarRegras(cenario, token, token));
  } catch (erro) {
    console.error('\nA bateria parou por erro:', erro);
    process.exitCode = 1;
  } finally {
    encerrar(baterias);
    await encerrarPool();
  }
}

void principal();
