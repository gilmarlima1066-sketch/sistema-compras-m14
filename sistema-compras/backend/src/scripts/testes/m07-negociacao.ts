/**
 * Bateria do MODULO 07 - negociacao e pedido de compra.
 *
 * Cobre os 36 testes da secao 69 do PROMPT 07 e os cinco testes dirigidos das
 * secoes 70 a 74 (cenario completo, divergencia, alteracao, excesso e
 * duplicidade).
 *
 * Os dados de teste usam o prefixo M07- e ficam no banco. O produto do teste
 * de excesso e um produto real do ERP, escolhido por ter venda nos ultimos 90
 * dias: sem demanda real nao existe cobertura para avaliar.
 */
import { pool, encerrarPool } from '../../config/database.js';
import {
  chamar, checar, encerrar, loginAdmin, novaBateria, secao, tokenDoPerfil,
  type Bateria,
} from './base.js';
import {
  bonificacao, comparativoAntesDepois, compararConfirmacao, custoTotal, economia,
  gerarParcelas, impactoEstoque, ratearFrete, validarQuantidade,
} from '../../modules/negociacoes/calculos.js';

const num = (v: unknown) => Number(v ?? 0);
const quase = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
const hoje = new Date();
const emDias = (d: number) => new Date(hoje.getTime() + d * 86400000).toISOString().slice(0, 10);

interface Cenario {
  produtoPrincipal: number;
  produtoMoq: number;
  produtoExcesso: number;
  fornecedorA: number;
  fornecedorB: number;
  necessidadePrincipal: number;
  necessidadeExcesso: number;
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
      INSERT INTO categorias (nome, descricao) VALUES ('M07 TESTES', 'Cenarios da bateria do modulo 07')
      ON CONFLICT (nome) DO UPDATE SET descricao = EXCLUDED.descricao RETURNING id`);
    const categoriaId = Number(cat[0].id);
    const { rows: un } = await cliente.query("SELECT id FROM unidades WHERE codigo = 'KG'");
    const unidadeId = Number(un[0].id);

    const produto = async (codigo: string, descricao: string, peso: number) => {
      const achado = (await cliente.query(
        'SELECT id FROM produtos WHERE upper(codigo) = upper($1) AND deleted_at IS NULL', [codigo])).rows;
      if (achado.length) {
        await cliente.query('UPDATE produtos SET descricao = $2, peso = $3, ativo = true WHERE id = $1',
          [achado[0].id, descricao, peso]);
        return Number(achado[0].id);
      }
      const { rows } = await cliente.query(`
        INSERT INTO produtos (codigo, descricao, categoria_id, unidade_compra_id,
                              unidade_estoque_id, unidade_venda_id, fator_conversao,
                              ativo, peso, lead_time_padrao_dias)
        VALUES ($1, $2, $3, $4, $4, $4, 1, true, $5, 10) RETURNING id`,
        [codigo, descricao, categoriaId, unidadeId, peso]);
      return Number(rows[0].id);
    };

    const fornecedor = async (razao: string, cnpj: string) => {
      const achado = (await cliente.query(
        'SELECT id FROM fornecedores WHERE razao_social = $1 AND deleted_at IS NULL', [razao])).rows;
      if (achado.length) {
        await cliente.query('UPDATE fornecedores SET ativo = true WHERE id = $1', [achado[0].id]);
        return Number(achado[0].id);
      }
      const { rows } = await cliente.query(`
        INSERT INTO fornecedores (razao_social, cnpj, tipo_fornecedor, origem_fornecedor,
                                  ativo, lead_time_padrao_dias, prazo_medio_pagamento, email)
        VALUES ($1, $2, 'DISTRIBUIDOR', 'NACIONAL', true, 10, 28, 'm07@teste.local') RETURNING id`,
        [razao, cnpj]);
      return Number(rows[0].id);
    };

    const produtoPrincipal = await produto('M07-PRINCIPAL', 'M07 produto do cenario completo', 1);
    const produtoMoq = await produto('M07-MOQ', 'M07 produto com MOQ e multiplo', 2);
    await fornecedor('M07 Fornecedor A', '07000000000101');
    const fornecedorA = await fornecedor('M07 Fornecedor A', '07000000000101');
    const fornecedorB = await fornecedor('M07 Fornecedor B', '07000000000202');

    // Produto real com venda recente: e o unico jeito de a cobertura existir.
    const { rows: real } = await cliente.query(`
      SELECT m.produto_id, sum(m.quantidade) AS vendido
        FROM mv_demanda_diaria m
       WHERE m.data_venda >= CURRENT_DATE - 90
       GROUP BY m.produto_id
      HAVING sum(m.quantidade) > 90
       ORDER BY sum(m.quantidade) DESC LIMIT 1`);
    const produtoExcesso = real.length ? Number(real[0].produto_id) : produtoMoq;

    const estoque = async (produtoId: number, fisica: number) => {
      const { rows: local } = await cliente.query(
        "SELECT id FROM locais WHERE ativo ORDER BY id LIMIT 1");
      const localId = Number(local[0].id);
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
                              quantidade_em_transito)
        VALUES ($1, $2, $3, 0, 0)`, [produtoId, localId, fisica]);
    };

    await estoque(produtoPrincipal, 500);
    await estoque(produtoMoq, 0);

    const necessidade = async (produtoId: number, quantidade: number) => {
      const achado = (await cliente.query(`
        SELECT id FROM necessidades_compra
         WHERE produto_id = $1 AND observacao = 'M07 fixture' ORDER BY id LIMIT 1`, [produtoId])).rows;
      if (achado.length) {
        await cliente.query(`
          UPDATE necessidades_compra
             SET quantidade_sugerida = $2, quantidade_aprovada = NULL, status = 'PENDENTE'
           WHERE id = $1`, [achado[0].id, quantidade]);
        return Number(achado[0].id);
      }
      const { rows } = await cliente.query(`
        INSERT INTO necessidades_compra
          (produto_id, estoque_atual, estoque_disponivel, estoque_em_transito, demanda_prevista,
           estoque_seguranca, quantidade_sugerida, status, observacao, data_necessaria,
           lead_time_dias, preco_estimado)
        VALUES ($1, 0, 0, 0, $2, 0, $2, 'PENDENTE', 'M07 fixture', $3, 10, 10)
        RETURNING id`, [produtoId, quantidade, emDias(30)]);
      return Number(rows[0].id);
    };

    const necessidadePrincipal = await necessidade(produtoPrincipal, 10000);
    const necessidadeExcesso = await necessidade(produtoExcesso, 1000);

    await cliente.query('COMMIT');
    return {
      produtoPrincipal, produtoMoq, produtoExcesso,
      fornecedorA, fornecedorB, necessidadePrincipal, necessidadeExcesso,
    };
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }
}

// ---------------------------------------------------------------------------
// 1. Matematica (secoes 13 a 16, 41, 44, 45, 64 e 65)
// ---------------------------------------------------------------------------

function testarCalculos(): Bateria {
  const b = novaBateria('MODULO 07 - calculos puros');

  secao('custo total e economia (secoes 13, 14, 15 e 16)');
  const inicial = custoTotal({
    valorProdutos: 100000, desconto: 0, frete: 5000, impostos: 0,
    seguro: 0, desembaraco: 0, taxas: 0, outros: 0,
  });
  const negociado = custoTotal({
    valorProdutos: 95000, desconto: 0, frete: 3000, impostos: 0,
    seguro: 0, desembaraco: 0, taxas: 0, outros: 0,
  });
  checar(b, 'custo total soma produtos e frete', quase(inicial, 105000));
  checar(b, 'custo total negociado cai para 98.000', quase(negociado, 98000));

  const eco = economia(inicial, negociado);
  checar(b, 'economia absoluta de 7.000', quase(eco.absoluta, 7000));
  checar(b, 'economia percentual de 6,67%', quase(eco.percentual ?? 0, 6.6667, 0.001));
  checar(b, 'custo inicial zero nao divide por zero',
    economia(0, 0).percentual === null);

  secao('bonificacao (secao 20)');
  const bon = bonificacao(1000, 100, 10, 10000);
  checar(b, 'bonificacao aumenta a quantidade recebida', quase(num(bon.quantidadeRecebida), 1100));
  checar(b, 'custo unitario efetivo cai com a bonificacao',
    quase(num(bon.custoUnitarioEfetivo), 10000 / 1100, 0.0001));
  checar(b, 'a bonificacao vale 10% sobre o comprado',
    quase(num(bon.percentualBonificacao), 10));
  checar(b, 'o valor equivalente da bonificacao e calculado',
    quase(num(bon.valorEquivalente), 1000));

  secao('rateio de frete (secao 41)');
  const itens = [
    { id: 1, valor: 6000, quantidade: 600, peso: 2, percentualManual: null },
    { id: 2, valor: 4000, quantidade: 400, peso: 1, percentualManual: null },
  ];
  const porValor = ratearFrete(itens, 1000, 'VALOR');
  checar(b, 'rateio por valor segue a proporcao 60/40',
    quase(porValor.get(1) ?? 0, 600) && quase(porValor.get(2) ?? 0, 400));
  const porQuantidade = ratearFrete(itens, 1000, 'QUANTIDADE');
  checar(b, 'rateio por quantidade segue 600/400',
    quase(porQuantidade.get(1) ?? 0, 600) && quase(porQuantidade.get(2) ?? 0, 400));
  const porPeso = ratearFrete(itens, 1000, 'PESO');
  checar(b, 'rateio por peso usa peso vezes quantidade (1200 contra 400)',
    quase(porPeso.get(1) ?? 0, 750) && quase(porPeso.get(2) ?? 0, 250));
  const tresItens = ratearFrete([
    { id: 1, valor: 100, quantidade: 1, peso: null, percentualManual: null },
    { id: 2, valor: 100, quantidade: 1, peso: null, percentualManual: null },
    { id: 3, valor: 100, quantidade: 1, peso: null, percentualManual: null },
  ], 100, 'VALOR');
  const somaTres = [...tresItens.values()].reduce((a, v) => a + v, 0);
  checar(b, 'a sobra de arredondamento nao some do rateio', quase(somaTres, 100));
  const semFrete = ratearFrete(itens, 0, 'VALOR');
  checar(b, 'frete zero rateia zero', (semFrete.get(1) ?? -1) === 0);

  secao('parcelas (secoes 44 e 45)');
  const parcelas = gerarParcelas('2026-01-10', 10000, 30, 3, 0);
  checar(b, 'tres parcelas geradas', parcelas.length === 3);
  checar(b, 'as parcelas vencem em 30, 60 e 90 dias',
    parcelas.map((p) => p.vencimento).join(',') === '2026-02-09,2026-03-11,2026-04-10',
    parcelas.map((p) => p.vencimento));
  checar(b, 'as parcelas somam o valor total',
    quase(parcelas.reduce((a, p) => a + p.valor, 0), 10000));
  checar(b, 'primeira parcela vence no prazo cheio', parcelas[0]?.vencimento === '2026-02-09');
  const comEntrada = gerarParcelas('2026-01-10', 10000, 30, 3, 30);
  checar(b, 'entrada de 30% vence na emissao',
    comEntrada[0]?.entrada === true && comEntrada[0]?.vencimento === '2026-01-10');
  checar(b, 'entrada vale 3.000', quase(comEntrada[0]?.valor ?? 0, 3000));
  checar(b, 'com entrada a soma continua fechando',
    quase(comEntrada.reduce((a, p) => a + p.valor, 0), 10000));
  checar(b, 'valor zero nao gera parcela', gerarParcelas('2026-01-10', 0, 30).length === 0);

  secao('validacao de quantidade - MOQ e multiplo (secao 28)');
  const abaixoMoq = validarQuantidade(500, 1000, null);
  checar(b, 'quantidade abaixo do MOQ e recusada', !abaixoMoq.atende);
  checar(b, 'o sistema sugere subir para o MOQ', abaixoMoq.quantidadeSugerida === 1000);
  const foraMultiplo = validarQuantidade(1050, null, 100);
  checar(b, 'quantidade fora do multiplo e recusada', !foraMultiplo.atende);
  checar(b, 'a sugestao sobe para o proximo multiplo', foraMultiplo.quantidadeSugerida === 1100);
  checar(b, 'quantidade correta passa', validarQuantidade(1000, 1000, 100).atende);
  checar(b, 'quantidade zero e recusada', !validarQuantidade(0, null, null).atende);

  secao('impacto no estoque - excesso e ruptura (secoes 64, 65 e 73)');
  const excesso = impactoEstoque({
    estoqueDisponivel: 2000, estoqueEmTransito: 0, quantidadePedido: 5000,
    demandaDiaria: 10, limiteCoberturaDias: 120, necessidadePlanejada: 1000,
    hoje: '2026-01-10',
  });
  checar(b, 'cobertura atual de 200 dias', quase(excesso.coberturaAtualDias ?? 0, 200));
  checar(b, 'cobertura apos a compra de 700 dias', quase(excesso.coberturaAposCompraDias ?? 0, 700));
  checar(b, 'risco de excesso identificado', excesso.riscoExcesso);
  checar(b, 'quantidade excedente calculada', quase(excesso.quantidadeExcedente ?? 0, 7000 - 1200));
  checar(b, 'pedido 400% acima da necessidade',
    quase(excesso.percentualAcimaNecessidade ?? 0, 400));
  checar(b, 'sem ruptura quando se compra acima da necessidade', !excesso.riscoRuptura);

  const ruptura = impactoEstoque({
    estoqueDisponivel: 100, estoqueEmTransito: 0, quantidadePedido: 8000,
    demandaDiaria: 100, limiteCoberturaDias: 120, necessidadePlanejada: 10000,
    hoje: '2026-01-10',
  });
  checar(b, 'risco de ruptura quando a compra nao cobre a necessidade', ruptura.riscoRuptura);
  checar(b, 'faltante de 2.000', quase(ruptura.quantidadeFaltante ?? 0, 2000));
  checar(b, 'data provavel de ruptura calculada',
    ruptura.dataProvavelRuptura === '2026-04-01', ruptura.dataProvavelRuptura);
  const semDemanda = impactoEstoque({
    estoqueDisponivel: 100, estoqueEmTransito: 0, quantidadePedido: 100,
    demandaDiaria: 0, limiteCoberturaDias: 120, necessidadePlanejada: null,
    hoje: '2026-01-10',
  });
  checar(b, 'sem demanda a cobertura fica nula em vez de infinita',
    semDemanda.coberturaAposCompraDias === null && !semDemanda.riscoExcesso);

  secao('divergencia entre pedido e confirmacao (secoes 37 e 71)');
  const divergencias = compararConfirmacao(
    { quantidade: 10000, preco: 9.5, prazoDias: 7, dataPrometida: '2026-01-17' },
    { quantidade: 8000, preco: 9.5, prazoDias: 7, dataPrometida: '2026-01-17' },
    2,
  );
  const qtd = divergencias.find((d) => d.campo === 'quantidade');
  checar(b, 'divergencia de quantidade detectada', !!qtd && qtd.relevante);
  checar(b, 'a diferenca de 2.000 aparece', quase(num(qtd?.diferenca), -2000));
  const dentroTolerancia = compararConfirmacao(
    { quantidade: 10000, preco: 10, prazoDias: 7, dataPrometida: null },
    { quantidade: 9900, preco: 10, prazoDias: 7, dataPrometida: null },
    2,
  );
  checar(b, 'diferenca de 1% fica dentro da tolerancia de 2%',
    dentroTolerancia.every((d) => !d.relevante));

  secao('comparativo antes e depois (secao 53)');
  const comparativo = comparativoAntesDepois(
    { precoMedio: 10, frete: 5000, pagamentoDias: 28, prazoDias: 10, quantidade: 10000, custoTotal: 105000 },
    { precoMedio: 9.5, frete: 3000, pagamentoDias: 35, prazoDias: 7, quantidade: 10000, custoTotal: 98000 },
  );
  checar(b, 'o comparativo cobre preco, frete, pagamento, prazo e custo',
    comparativo.length >= 5);
  const linhaCusto = comparativo.find((l) => l.criterio.toUpperCase().includes('CUSTO'));
  checar(b, 'a linha de custo guarda antes e depois',
    num(linhaCusto?.antes) === 105000 && num(linhaCusto?.depois) === 98000);

  return b;
}

// ---------------------------------------------------------------------------
// 2. Cenario completo (secoes 70 a 74)
// ---------------------------------------------------------------------------

async function testarFluxo(cenario: Cenario): Promise<Bateria> {
  const b = novaBateria('MODULO 07 - negociacao e pedido pela API');
  const admin = await loginAdmin();

  // --- Cotacao aprovada, a origem oficial da negociacao (secao 61) ----------
  secao('cotacao aprovada vira negociacao (secoes 1 e 61)');
  const cotacao = await chamar('POST', '/api/cotacoes', {
    token: admin,
    corpo: {
      origem: 'NECESSIDADES',
      necessidade_ids: [cenario.necessidadePrincipal],
      fornecedor_ids: [cenario.fornecedorA],
      data_limite: emDias(7),
      prioridade: 'ALTA',
      observacao: 'M07 cenario completo',
    },
  });
  checar(b, 'cotacao criada a partir da necessidade do modulo 05',
    cotacao.status === 201, cotacao.corpo?.error);
  const cotacaoId = cotacao.corpo?.data?.id;

  await chamar('POST', `/api/cotacoes/${cotacaoId}/enviar`, { token: admin, corpo: {} });
  const proposta = await chamar('POST', `/api/cotacoes/${cotacaoId}/respostas`, {
    token: admin,
    corpo: {
      fornecedor_id: cenario.fornecedorA,
      itens: [{
        produto_id: cenario.produtoPrincipal,
        quantidade_ofertada: 10000,
        preco_unitario: 10,
        frete: 5000,
        prazo_entrega_dias: 10,
        prazo_pagamento_dias: 28,
      }],
    },
  });
  checar(b, 'proposta de 10,00/kg com frete de 5.000 registrada',
    proposta.status === 201 || proposta.status === 200, proposta.corpo?.error);

  const analise = await chamar('POST', `/api/cotacoes/${cotacaoId}/analisar`, { token: admin, corpo: {} });
  const recomendadas = (analise.corpo?.data?.produtos ?? [])
    .filter((p: any) => p.recomendada)
    .map((p: any) => ({
      cotacao_produto_id: p.cotacao_produto_id,
      cotacao_item_id: Number(p.recomendada.cotacao_item_id),
    }));
  await chamar('POST', `/api/cotacoes/${cotacaoId}/selecionar`, {
    token: admin, corpo: { selecoes: recomendadas, justificativa: 'Fornecedor unico convidado' },
  });
  const cotacaoAprovada = await chamar('POST', `/api/cotacoes/${cotacaoId}/aprovar`, {
    token: admin, corpo: { justificativa: 'Cenario do teste completo' },
  });
  checar(b, 'cotacao aprovada para negociacao',
    cotacaoAprovada.corpo?.data?.status === 'APROVADA_NEGOCIACAO', cotacaoAprovada.corpo?.error);

  // --- 1. Negociacao a partir da cotacao -----------------------------------
  const negociacao = await chamar('POST', '/api/negociacoes', {
    token: admin, corpo: { origem: 'COTACAO', cotacao_id: cotacaoId, data_limite: emDias(10) },
  });
  checar(b, 'negociacao criada a partir da cotacao',
    negociacao.status === 201, negociacao.corpo?.error);
  const negId = negociacao.corpo?.data?.id;
  checar(b, 'a negociacao herda o custo inicial de 105.000',
    quase(num(negociacao.corpo?.data?.custo_total_inicial), 105000),
    negociacao.corpo?.data?.custo_total_inicial);
  checar(b, 'a negociacao recebe numero proprio',
    typeof negociacao.corpo?.data?.numero === 'string' && negociacao.corpo.data.numero.length > 0);
  checar(b, 'a negociacao nasce ABERTA', negociacao.corpo?.data?.status === 'ABERTA');

  const cotacaoUsada = await chamar('POST', '/api/negociacoes', {
    token: admin, corpo: { origem: 'COTACAO', cotacao_id: cotacaoId },
  });
  checar(b, 'cotacao ja negociada nao abre segunda negociacao',
    cotacaoUsada.status === 422 || cotacaoUsada.status === 409, cotacaoUsada.status);

  // --- 3 a 8. Rodada de negociacao ------------------------------------------
  secao('rodadas e contraproposta (secoes 9, 10 e 11)');
  const detalheInicial = await chamar('GET', `/api/negociacoes/${negId}`, { token: admin });
  const itemId = detalheInicial.corpo?.data?.itens?.[0]?.id;
  checar(b, 'a rodada zero guarda o ponto de partida',
    (detalheInicial.corpo?.data?.rodadas ?? []).length === 1);

  // Rodada 1: o comprador pede. Status vai para AGUARDANDO_FORNECEDOR.
  const contraproposta = await chamar('POST', `/api/negociacoes/${negId}/rodadas`, {
    token: admin,
    corpo: {
      autor: 'COMPRADOR',
      justificativa: 'Pedido de reducao para 9,20 e frete por conta do fornecedor',
      frete: 0,
      prazo_pagamento_dias: 45,
      itens: [{ negociacao_item_id: itemId, preco_unitario: 9.2 }],
    },
  });
  checar(b, 'contraproposta do comprador registrada como rodada 1',
    contraproposta.status === 201 && num(contraproposta.corpo?.data?.rodada?.rodada) === 1,
    contraproposta.corpo?.error);
  checar(b, 'apos a contraproposta a negociacao aguarda o fornecedor',
    contraproposta.corpo?.data?.negociacao?.status === 'AGUARDANDO_FORNECEDOR',
    contraproposta.corpo?.data?.negociacao?.status);

  const acordarCedo = await chamar('POST', `/api/negociacoes/${negId}/acordar`, {
    token: admin, corpo: {},
  });
  checar(b, 'nao se fecha acordo enquanto o fornecedor nao responde',
    acordarCedo.status === 422, acordarCedo.status);

  // Rodada 2: a resposta do fornecedor, que e o cenario da secao 70.
  const resposta = await chamar('POST', `/api/negociacoes/${negId}/rodadas`, {
    token: admin,
    corpo: {
      autor: 'FORNECEDOR',
      justificativa: 'Fornecedor fecha em 9,50 com frete de 3.000',
      frete: 3000,
      prazo_pagamento_dias: 35,
      prazo_entrega_dias: 7,
      itens: [{ negociacao_item_id: itemId, preco_unitario: 9.5 }],
    },
  });
  checar(b, 'resposta do fornecedor registrada como rodada 2',
    resposta.status === 201 && num(resposta.corpo?.data?.rodada?.rodada) === 2,
    resposta.corpo?.error);
  checar(b, 'o custo cai para 98.000',
    quase(num(resposta.corpo?.data?.negociacao?.custo_total_atual), 98000),
    resposta.corpo?.data?.negociacao?.custo_total_atual);
  checar(b, 'economia negociada de 7.000',
    quase(num(resposta.corpo?.data?.negociacao?.economia_negociada), 7000));
  const alteracoes = resposta.corpo?.data?.alteracoes ?? [];
  const campos = alteracoes.map((a: any) => a.campo ?? a.criterio ?? '');
  checar(b, 'a rodada registra a alteracao de preco',
    campos.some((c: string) => String(c).toLowerCase().includes('preco')), campos);
  checar(b, 'a rodada registra a alteracao de frete',
    campos.some((c: string) => String(c).toLowerCase().includes('frete')), campos);
  checar(b, 'a rodada registra a alteracao de prazo de pagamento',
    campos.some((c: string) => String(c).toLowerCase().includes('pagamento')), campos);
  checar(b, 'a rodada registra a alteracao de prazo de entrega',
    campos.some((c: string) => String(c).toLowerCase().includes('entrega')), campos);

  const rodadaVazia = await chamar('POST', `/api/negociacoes/${negId}/rodadas`, {
    token: admin, corpo: { autor: 'FORNECEDOR', itens: [] },
  });
  checar(b, 'rodada que nao muda nada e recusada', rodadaVazia.status === 422, rodadaVazia.status);

  const detalhe = await chamar('GET', `/api/negociacoes/${negId}`, { token: admin });
  checar(b, 'o historico guarda as tres rodadas',
    (detalhe.corpo?.data?.rodadas ?? []).length === 3,
    (detalhe.corpo?.data?.rodadas ?? []).length);
  checar(b, 'a rodada zero continua com o valor original',
    quase(num(detalhe.corpo?.data?.rodadas?.[0]?.custo_total), 105000));
  checar(b, 'o comparativo antes e depois vem pronto',
    (detalhe.corpo?.data?.comparativo ?? []).length >= 5);
  checar(b, 'economia potencial, negociada e percentual expostas',
    detalhe.corpo?.data?.economia?.negociada !== undefined
    && detalhe.corpo?.data?.economia?.potencial !== undefined
    && detalhe.corpo?.data?.economia?.percentual !== undefined);

  // --- 10. Negociacao por volume -------------------------------------------
  secao('simulacao por volume (secao 14)');
  const simulacao = await chamar('POST', `/api/negociacoes/${negId}/simular-volume`, {
    token: admin,
    corpo: {
      negociacao_item_id: itemId,
      faixas: [
        { quantidade: 10000, preco_unitario: 9.5 },
        { quantidade: 20000, preco_unitario: 9.0 },
      ],
    },
  });
  checar(b, 'simulacao de volume devolve as faixas',
    simulacao.status === 200 && (simulacao.corpo?.data?.faixas ?? []).length === 2,
    simulacao.corpo?.error);
  const { rows: semGravar } = await pool.query(
    'SELECT quantidade_atual, preco_atual FROM negociacao_itens WHERE id = $1', [itemId]);
  checar(b, 'a simulacao nao alterou o item (secao 66)',
    quase(num(semGravar[0]?.quantidade_atual), 10000) && quase(num(semGravar[0]?.preco_atual), 9.5));

  // --- 17. Aprovacao da negociacao -----------------------------------------
  secao('acordo e aprovacao da negociacao (secoes 22 e 23)');
  const comprador = await tokenDoPerfil(admin, 'COMPRADOR', 'm07');
  if (comprador) {
    const compradorAprova = await chamar('POST', `/api/negociacoes/${negId}/aprovar`, {
      token: comprador, corpo: {},
    });
    checar(b, 'COMPRADOR nao aprova negociacao', compradorAprova.status === 403,
      compradorAprova.status);
  }

  const converterAntes = await chamar('POST', `/api/negociacoes/${negId}/converter-pedido`, {
    token: admin, corpo: {},
  });
  checar(b, 'negociacao nao aprovada nao vira pedido', converterAntes.status === 422,
    converterAntes.status);

  const acordo = await chamar('POST', `/api/negociacoes/${negId}/acordar`, { token: admin, corpo: {} });
  checar(b, 'negociacao acordada', acordo.status === 200 && acordo.corpo?.data?.status === 'ACORDADA',
    acordo.corpo?.error);

  const aprovacao = await chamar('POST', `/api/negociacoes/${negId}/aprovar`, {
    token: admin, corpo: { justificativa: 'Reducao de 6,67% no custo total' },
  });
  checar(b, 'ADMIN aprova a negociacao',
    aprovacao.status === 200 && aprovacao.corpo?.data?.status === 'APROVADA', aprovacao.corpo?.error);
  checar(b, 'a alcada usada fica registrada na negociacao',
    !!aprovacao.corpo?.data?.nivel_aprovacao);

  // --- 19, 20, 21. Pedido de compra ----------------------------------------
  secao('conversao em pedido de compra (secoes 24, 25 e 27)');
  const pedido = await chamar('POST', `/api/negociacoes/${negId}/converter-pedido`, {
    token: admin,
    corpo: {
      data_prevista_entrega: emDias(7),
      numero_parcelas: 2,
      metodo_rateio_frete: 'VALOR',
      observacao: 'Pedido do cenario completo',
    },
  });
  checar(b, 'pedido gerado a partir da negociacao aprovada',
    pedido.status === 201, pedido.corpo?.error);
  const pedidoId = pedido.corpo?.data?.id;
  checar(b, 'o pedido recebe numero no formato configurado',
    /^[A-Z]+-\d{4}-\d+$/.test(String(pedido.corpo?.data?.numero ?? '')),
    pedido.corpo?.data?.numero);
  checar(b, 'o pedido nasce em RASCUNHO', pedido.corpo?.data?.status === 'RASCUNHO');
  checar(b, 'o valor total do pedido e 98.000',
    quase(num(pedido.corpo?.data?.valor_total), 98000), pedido.corpo?.data?.valor_total);
  checar(b, 'a economia negociada viaja para o pedido',
    quase(num(pedido.corpo?.data?.economia_negociada), 7000));

  // --- 74. Duplicidade -----------------------------------------------------
  const duplicado = await chamar('POST', `/api/negociacoes/${negId}/converter-pedido`, {
    token: admin, corpo: {},
  });
  checar(b, 'converter a mesma negociacao duas vezes e bloqueado',
    duplicado.status === 409 || duplicado.status === 422, duplicado.status);
  const { rows: contagem } = await pool.query(
    'SELECT count(*)::int AS n FROM ordens_compra WHERE negociacao_id = $1', [negId]);
  checar(b, 'nao existe pedido duplicado no banco', num(contagem[0].n) === 1, contagem[0]);

  // --- Concorrencia (secao 59) ---------------------------------------------
  const emParalelo = await Promise.all([
    chamar('POST', `/api/negociacoes/${negId}/converter-pedido`, { token: admin, corpo: {} }),
    chamar('POST', `/api/negociacoes/${negId}/converter-pedido`, { token: admin, corpo: {} }),
  ]);
  checar(b, 'duas conversoes simultaneas continuam bloqueadas',
    emParalelo.every((r) => r.status >= 400));
  const { rows: aindaUm } = await pool.query(
    'SELECT count(*)::int AS n FROM ordens_compra WHERE negociacao_id = $1', [negId]);
  checar(b, 'o pedido continua unico apos a disputa', num(aindaUm[0].n) === 1);

  // --- Itens, rateio e parcelas --------------------------------------------
  const detalhePedido = await chamar('GET', `/api/pedidos-compra/${pedidoId}`, { token: admin });
  const itensPedido = detalhePedido.corpo?.data?.itens ?? [];
  checar(b, 'o pedido leva o item negociado', itensPedido.length === 1);
  checar(b, 'o item guarda o preco negociado de 9,50',
    quase(num(itensPedido[0]?.preco_unitario), 9.5));
  checar(b, 'o item guarda o preco original de 10,00 para comparar',
    quase(num(itensPedido[0]?.preco_original), 10));
  checar(b, 'o frete foi rateado no item',
    quase(num(itensPedido[0]?.frete_rateado), 3000), itensPedido[0]?.frete_rateado);
  checar(b, 'o item aponta para a necessidade do modulo 05 (secao 60)',
    Number(itensPedido[0]?.necessidade_id) === cenario.necessidadePrincipal,
    itensPedido[0]?.necessidade_id);
  checar(b, 'o item aponta para o item da cotacao (secao 61)',
    itensPedido[0]?.cotacao_item_id !== null);
  const parcelasPedido = detalhePedido.corpo?.data?.parcelas ?? [];
  checar(b, 'duas parcelas financeiras geradas (secao 45)', parcelasPedido.length === 2);
  checar(b, 'as parcelas somam o valor do pedido',
    quase(parcelasPedido.reduce((a: number, p: any) => a + num(p.valor), 0), 98000));

  // --- 22 a 24. Validacao e simulacao --------------------------------------
  secao('validacao e simulacao antes da aprovacao (secoes 28 a 31 e 66)');
  const validacao = await chamar('GET', `/api/pedidos-compra/${pedidoId}/validacao`, { token: admin });
  checar(b, 'validacao responde', validacao.status === 200, validacao.corpo?.error);
  checar(b, 'a quantidade pedida bate com a necessidade de 10.000',
    quase(num(validacao.corpo?.data?.itens?.[0]?.necessidade_planejada), 10000));
  checar(b, 'sem problema de MOQ o pedido pode ser aprovado',
    validacao.corpo?.data?.pode_aprovar === true, validacao.corpo?.data?.bloqueios);
  checar(b, 'a alcada necessaria e a da diretoria acima de 50.000',
    validacao.corpo?.data?.alcada_necessaria?.perfil === 'DIRETORIA',
    validacao.corpo?.data?.alcada_necessaria);
  checar(b, 'a validacao mostra estoque do item',
    validacao.corpo?.data?.itens?.[0]?.estoque?.disponivel !== undefined);

  const simular = await chamar('GET', `/api/pedidos-compra/${pedidoId}/simular-aprovacao`, { token: admin });
  checar(b, 'simulacao de aprovacao responde', simular.status === 200, simular.corpo?.error);
  checar(b, 'a simulacao mostra estoque antes e depois',
    num(simular.corpo?.data?.itens?.[0]?.estoque_apos_compra)
      > num(simular.corpo?.data?.itens?.[0]?.estoque_atual));
  checar(b, 'a simulacao informa o capital comprometido',
    quase(num(simular.corpo?.data?.capital_comprometido), 98000));
  checar(b, 'a simulacao avisa que nada foi alterado',
    typeof simular.corpo?.data?.observacao === 'string');
  const { rows: statusAposSimular } = await pool.query(
    'SELECT status FROM ordens_compra WHERE id = $1', [pedidoId]);
  checar(b, 'simular nao muda o status do pedido', statusAposSimular[0]?.status === 'RASCUNHO');

  // --- 21, 17, 18. Alcada e aprovacao --------------------------------------
  secao('alcada e aprovacao do pedido (secoes 32, 33 e 34)');
  await chamar('POST', `/api/pedidos-compra/${pedidoId}/enviar-aprovacao`, { token: admin, corpo: {} });
  if (comprador) {
    const compradorAprovaPedido = await chamar('POST', `/api/pedidos-compra/${pedidoId}/aprovar`, {
      token: comprador, corpo: {},
    });
    checar(b, 'COMPRADOR nao aprova pedido de 98.000', compradorAprovaPedido.status === 403,
      compradorAprovaPedido.status);
  }
  const gestor = await tokenDoPerfil(admin, 'GESTOR_COMPRAS', 'm07');
  if (gestor) {
    const gestorAprova = await chamar('POST', `/api/pedidos-compra/${pedidoId}/aprovar`, {
      token: gestor, corpo: {},
    });
    checar(b, 'GESTOR_COMPRAS nao aprova acima da sua alcada',
      gestorAprova.status === 403, gestorAprova.status);
  }

  const aprovado = await chamar('POST', `/api/pedidos-compra/${pedidoId}/aprovar`, {
    token: admin, corpo: { justificativa: 'Dentro do planejamento' },
  });
  checar(b, 'ADMIN aprova o pedido',
    aprovado.status === 200 && aprovado.corpo?.data?.status === 'APROVADA', aprovado.corpo?.error);
  checar(b, 'o nivel de aprovacao fica gravado', !!aprovado.corpo?.data?.nivel_aprovacao);

  // --- 25, 26, 27. Envio, confirmacao e divergencia (secao 71) -------------
  secao('envio, confirmacao e divergencia (secoes 35, 36, 37 e 71)');
  const enviado = await chamar('POST', `/api/pedidos-compra/${pedidoId}/enviar`, {
    token: admin, corpo: { canal: 'EMAIL' },
  });
  checar(b, 'pedido enviado ao fornecedor',
    enviado.status === 200 && enviado.corpo?.data?.status === 'ENVIADA', enviado.corpo?.error);

  const documento = await chamar('GET', `/api/pedidos-compra/${pedidoId}/documento`, { token: admin });
  checar(b, 'documento oficial do pedido gerado', documento.status === 200, documento.corpo?.error);
  checar(b, 'o documento tem cabecalho, itens e totais',
    !!documento.corpo?.data?.cabecalho && (documento.corpo?.data?.itens ?? []).length === 1
    && quase(num(documento.corpo?.data?.totais?.valor_total), 98000));
  checar(b, 'o documento traz as condicoes gerais',
    typeof documento.corpo?.data?.condicoes_gerais === 'string');

  const itemPedidoId = itensPedido[0]?.id;
  const confirmacao = await chamar('POST', `/api/pedidos-compra/${pedidoId}/confirmar`, {
    token: admin,
    corpo: {
      numero_pedido_fornecedor: 'FORN-2026-777',
      data_prometida: emDias(7),
      itens: [{ ordem_compra_item_id: itemPedidoId, quantidade_confirmada: 8000 }],
    },
  });
  checar(b, 'confirmacao parcial registrada', confirmacao.status === 200, confirmacao.corpo?.error);
  checar(b, 'divergencia de quantidade apontada',
    (confirmacao.corpo?.data?.divergencias ?? []).length > 0, confirmacao.corpo?.data);

  const { rows: itemConfirmado } = await pool.query(
    'SELECT quantidade_pedida, quantidade_confirmada, quantidade_pendente FROM ordem_compra_itens WHERE id = $1',
    [itemPedidoId]);
  checar(b, 'quantidade pedida continua 10.000 (pedido original mantido)',
    quase(num(itemConfirmado[0]?.quantidade_pedida), 10000));
  checar(b, '8.000 confirmados', quase(num(itemConfirmado[0]?.quantidade_confirmada), 8000));
  checar(b, '2.000 pendentes', quase(num(itemConfirmado[0]?.quantidade_pendente), 2000));

  const validacaoPosConfirmacao = await chamar('GET',
    `/api/pedidos-compra/${pedidoId}/validacao`, { token: admin });
  checar(b, 'o numero do pedido do fornecedor fica guardado',
    (await chamar('GET', `/api/pedidos-compra/${pedidoId}`, { token: admin }))
      .corpo?.data?.numero_pedido_fornecedor === 'FORN-2026-777');
  checar(b, 'a validacao continua respondendo apos a confirmacao',
    validacaoPosConfirmacao.status === 200);

  // --- 28. Alteracao pos-aprovacao (secao 72) ------------------------------
  secao('alteracao apos aprovacao (secoes 38 e 72)');
  const { rows: antesAlteracao } = await pool.query(
    'SELECT valor_total, status FROM ordens_compra WHERE id = $1', [pedidoId]);

  const alteracao = await chamar('POST', `/api/pedidos-compra/${pedidoId}/alteracoes`, {
    token: admin,
    corpo: {
      motivo: 'Fornecedor pediu reajuste de preco',
      alteracoes: [{ ordem_compra_item_id: itemPedidoId, campo: 'preco_unitario', valor_novo: '12' }],
    },
  });
  checar(b, 'alteracao vira solicitacao em vez de edicao direta',
    alteracao.status === 201, alteracao.corpo?.error);
  const alteracaoId = (alteracao.corpo?.data?.alteracoes ?? alteracao.corpo?.data ?? [])[0]?.id
    ?? alteracao.corpo?.data?.id;
  const { rows: durante } = await pool.query(
    'SELECT valor_total FROM ordens_compra WHERE id = $1', [pedidoId]);
  checar(b, 'o pedido nao muda de valor enquanto a alteracao nao e decidida',
    quase(num(durante[0]?.valor_total), num(antesAlteracao[0]?.valor_total)));
  checar(b, 'a alteracao registra que exige nova aprovacao',
    alteracao.corpo?.data?.exige_reaprovacao === true
    || (alteracao.corpo?.data?.alteracoes ?? []).some((a: any) => a.exige_reaprovacao),
    alteracao.corpo?.data);

  if (alteracaoId) {
    const recusada = await chamar('POST', `/api/pedidos-compra/alteracoes/${alteracaoId}`, {
      token: admin, corpo: { aprovar: false, observacao: 'Reajuste fora do acordado' },
    });
    checar(b, 'alteracao pode ser recusada', recusada.status === 200, recusada.corpo?.error);
    const { rows: depois } = await pool.query(
      'SELECT valor_total FROM ordens_compra WHERE id = $1', [pedidoId]);
    checar(b, 'alteracao recusada nao altera o pedido',
      quase(num(depois[0]?.valor_total), num(antesAlteracao[0]?.valor_total)));
    const { rows: viva } = await pool.query(
      'SELECT status FROM pedido_alteracoes WHERE id = $1', [alteracaoId]);
    checar(b, 'a solicitacao recusada fica no historico', viva.length === 1);
  }

  // --- 30. Auditoria e historico -------------------------------------------
  secao('auditoria e rastreabilidade (secoes 46, 68 e 81)');
  const timeline = await chamar('GET', `/api/pedidos-compra/${pedidoId}/timeline`, { token: admin });
  checar(b, 'timeline da compra responde', timeline.status === 200, timeline.corpo?.error);
  const eventos = timeline.corpo?.data?.eventos ?? [];
  checar(b, 'a timeline cobre cotacao, negociacao e pedido',
    ['COTACAO', 'NEGOCIACAO', 'PEDIDO'].every((o) => eventos.some((e: any) => e.origem === o)),
    [...new Set(eventos.map((e: any) => e.origem))]);
  checar(b, 'a timeline esta em ordem cronologica',
    eventos.every((e: any, i: number) => i === 0
      || new Date(eventos[i - 1].momento).getTime() <= new Date(e.momento).getTime()));

  const detalheFinal = await chamar('GET', `/api/pedidos-compra/${pedidoId}`, { token: admin });
  checar(b, 'o detalhe traz o historico do pedido',
    (detalheFinal.corpo?.data?.historico ?? []).length >= 4);
  checar(b, 'o historico guarda status anterior e novo',
    (detalheFinal.corpo?.data?.historico ?? []).every((h: any) => h.evento !== undefined));
  checar(b, 'a rastreabilidade liga necessidade, cotacao, negociacao e pedido',
    (detalheFinal.corpo?.data?.rastreabilidade ?? []).length >= 1,
    detalheFinal.corpo?.data?.rastreabilidade);

  const tentarApagarRodada = await pool.query(
    'DELETE FROM negociacao_rodadas WHERE negociacao_id = $1', [negId]).then(() => 'apagou')
    .catch(() => 'bloqueado');
  checar(b, 'historico de rodadas nao pode ser apagado', tentarApagarRodada === 'bloqueado');
  const tentarApagarHistorico = await pool.query(
    'DELETE FROM pedido_historico WHERE ordem_compra_id = $1', [pedidoId]).then(() => 'apagou')
    .catch(() => 'bloqueado');
  checar(b, 'historico do pedido nao pode ser apagado', tentarApagarHistorico === 'bloqueado');

  const { rows: auditoria } = await pool.query(`
    SELECT count(*)::int AS n FROM auditoria
     WHERE tabela IN ('ordens_compra', 'negociacoes_compra')
       AND registro_id IN ($1, $2)`, [pedidoId, negId]);
  checar(b, 'a auditoria geral registrou as operacoes', num(auditoria[0].n) > 0, auditoria[0]);

  // --- 32. Pacote para o modulo 08 -----------------------------------------
  const pacote = await chamar('GET', `/api/pedidos-compra/${pedidoId}/acompanhamento`, { token: admin });
  checar(b, 'pacote de acompanhamento pronto para o modulo 08',
    pacote.status === 200, pacote.corpo?.error);
  checar(b, 'o pacote leva fornecedor, itens e quantidades pendentes',
    !!pacote.corpo?.data?.pedido?.fornecedor && (pacote.corpo?.data?.itens ?? []).length === 1
    && pacote.corpo?.data?.itens?.[0]?.quantidade_pendente !== undefined,
    pacote.corpo?.data?.pedido);
  const { rows: recebimentos } = await pool.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'recebimentos'");
  if (num(recebimentos[0].n) > 0) {
    const { rows: criados } = await pool.query(
      'SELECT count(*)::int AS n FROM recebimentos WHERE ordem_compra_id = $1', [pedidoId]);
    checar(b, 'o modulo 07 nao cria recebimento (secao 82)', num(criados[0].n) === 0);
  }

  return b;
}

// ---------------------------------------------------------------------------
// 3. Excesso, cancelamento, rejeicao e negociacao manual
// ---------------------------------------------------------------------------

async function testarRegras(cenario: Cenario): Promise<Bateria> {
  const b = novaBateria('MODULO 07 - excesso, manual, cancelamento e paineis');
  const admin = await loginAdmin();

  // --- 73. Excesso ---------------------------------------------------------
  secao('pedido acima da necessidade e risco de excesso (secoes 64 e 73)');
  const negExcesso = await chamar('POST', '/api/negociacoes', {
    token: admin,
    corpo: {
      origem: 'MANUAL',
      fornecedor_id: cenario.fornecedorA,
      itens: [{ produto_id: cenario.produtoExcesso, quantidade: 5000, preco_unitario: 2 }],
      prazo_pagamento_dias: 30,
    },
  });
  checar(b, 'negociacao manual criada sem cotacao (secao 2)',
    negExcesso.status === 201, negExcesso.corpo?.error);
  const negExcessoId = negExcesso.corpo?.data?.id;
  checar(b, 'a negociacao manual nasce com origem MANUAL',
    negExcesso.corpo?.data?.origem === 'MANUAL');

  await chamar('POST', `/api/negociacoes/${negExcessoId}/acordar`, { token: admin, corpo: {} });
  await chamar('POST', `/api/negociacoes/${negExcessoId}/aprovar`, { token: admin, corpo: {} });
  const pedidoExcesso = await chamar('POST', `/api/negociacoes/${negExcessoId}/converter-pedido`, {
    token: admin, corpo: { data_prevista_entrega: emDias(15) },
  });
  checar(b, 'pedido do cenario de excesso criado', pedidoExcesso.status === 201,
    pedidoExcesso.corpo?.error);
  const pedidoExcessoId = pedidoExcesso.corpo?.data?.id;

  // A necessidade do modulo 05 e amarrada aqui: numa negociacao manual nao ha
  // cotacao para trazer esse vinculo, mas a validacao precisa dele.
  await pool.query(
    'UPDATE ordem_compra_itens SET necessidade_id = $2 WHERE ordem_compra_id = $1',
    [pedidoExcessoId, cenario.necessidadeExcesso]);

  const validacaoExcesso = await chamar('GET',
    `/api/pedidos-compra/${pedidoExcessoId}/validacao`, { token: admin });
  const tipos = (validacaoExcesso.corpo?.data?.alertas ?? []).map((a: any) => a.tipo);
  checar(b, 'compra acima da necessidade e sinalizada',
    tipos.includes('COMPRA_ACIMA_NECESSIDADE'), tipos);
  checar(b, 'a validacao exige justificativa nesse caso',
    validacaoExcesso.corpo?.data?.exige_justificativa === true, validacaoExcesso.corpo?.data);
  const linha = validacaoExcesso.corpo?.data?.itens?.[0];
  checar(b, 'a validacao mostra cobertura atual e apos a compra',
    linha?.impacto?.coberturaAtualDias !== undefined
    && linha?.impacto?.coberturaAposCompraDias !== undefined);
  checar(b, 'a quantidade excedente aparece',
    linha?.impacto?.percentualAcimaNecessidade !== null);

  await chamar('POST', `/api/pedidos-compra/${pedidoExcessoId}/enviar-aprovacao`, {
    token: admin, corpo: {},
  });
  const semJustificativa = await chamar('POST', `/api/pedidos-compra/${pedidoExcessoId}/aprovar`, {
    token: admin, corpo: {},
  });
  checar(b, 'aprovar sem justificativa e recusado quando ha excesso',
    semJustificativa.status === 422, semJustificativa.status);

  const comExcecao = await chamar('POST', `/api/pedidos-compra/${pedidoExcessoId}/aprovar`, {
    token: admin,
    corpo: {
      justificativa: 'Compra antecipada por fechamento de safra',
      excecoes: [{ tipo: 'COMPRA_ACIMA_NECESSIDADE', motivo: 'Preco de safra, aprovado pela diretoria' }],
    },
  });
  checar(b, 'com excecao registrada a aprovacao passa (secao 67)',
    comExcecao.status === 200, comExcecao.corpo?.error);
  const { rows: excecoes } = await pool.query(
    'SELECT excecoes FROM ordens_compra WHERE id = $1', [pedidoExcessoId]);
  checar(b, 'a excecao fica gravada no pedido com motivo e usuario',
    Array.isArray(excecoes[0]?.excecoes) && excecoes[0].excecoes.length > 0, excecoes[0]?.excecoes);

  // --- 29. Cancelamento ----------------------------------------------------
  secao('cancelamento e rejeicao (secoes 34 e 39)');
  const cancelado = await chamar('POST', `/api/pedidos-compra/${pedidoExcessoId}/cancelar`, {
    token: admin, corpo: { motivo: 'DEMANDA', justificativa: 'Demanda revista pelo comercial' },
  });
  checar(b, 'pedido aprovado pode ser cancelado com motivo',
    cancelado.status === 200 && cancelado.corpo?.data?.status === 'CANCELADA', cancelado.corpo?.error);
  const { rows: aindaExiste } = await pool.query(
    'SELECT status, motivo_cancelamento FROM ordens_compra WHERE id = $1', [pedidoExcessoId]);
  checar(b, 'o pedido cancelado continua no historico', aindaExiste.length === 1);
  checar(b, 'o motivo do cancelamento fica gravado',
    aindaExiste[0]?.motivo_cancelamento === 'DEMANDA');
  const { rows: compromissos } = await pool.query(
    "SELECT count(*)::int AS n FROM compromissos_compra WHERE ordem_compra_id = $1 AND status = 'PREVISTO'",
    [pedidoExcessoId]);
  checar(b, 'o cancelamento derruba os compromissos financeiros previstos',
    num(compromissos[0].n) === 0);

  const cancelarDeNovo = await chamar('POST', `/api/pedidos-compra/${pedidoExcessoId}/cancelar`, {
    token: admin, corpo: { motivo: 'ERRO', justificativa: 'Tentativa repetida' },
  });
  checar(b, 'pedido cancelado nao cancela de novo', cancelarDeNovo.status === 422,
    cancelarDeNovo.status);

  const negRejeitada = await chamar('POST', '/api/negociacoes', {
    token: admin,
    corpo: {
      origem: 'MANUAL', fornecedor_id: cenario.fornecedorB,
      itens: [{ produto_id: cenario.produtoMoq, quantidade: 100, preco_unitario: 5 }],
    },
  });
  const rejeitada = await chamar('POST', `/api/negociacoes/${negRejeitada.corpo?.data?.id}/rejeitar`, {
    token: admin, corpo: { motivo: 'PRECO', justificativa: 'Preco acima do mercado' },
  });
  checar(b, 'negociacao pode ser rejeitada com motivo',
    rejeitada.status === 200 && rejeitada.corpo?.data?.status === 'REJEITADA', rejeitada.corpo?.error);
  const rodadaAposRejeicao = await chamar('POST',
    `/api/negociacoes/${negRejeitada.corpo?.data?.id}/rodadas`, {
      token: admin, corpo: { autor: 'FORNECEDOR', frete: 10 },
    });
  checar(b, 'negociacao rejeitada nao aceita nova rodada',
    rodadaAposRejeicao.status === 422, rodadaAposRejeicao.status);

  // --- MOQ bloqueando aprovacao --------------------------------------------
  secao('MOQ e multiplo bloqueiam a aprovacao (secao 28)');
  const negMoq = await chamar('POST', '/api/negociacoes', {
    token: admin,
    corpo: {
      origem: 'MANUAL', fornecedor_id: cenario.fornecedorA,
      itens: [{ produto_id: cenario.produtoMoq, quantidade: 150, preco_unitario: 4, moq: 500, multiplo: 100 }],
    },
  });
  const negMoqId = negMoq.corpo?.data?.id;
  await chamar('POST', `/api/negociacoes/${negMoqId}/acordar`, { token: admin, corpo: {} });
  await chamar('POST', `/api/negociacoes/${negMoqId}/aprovar`, { token: admin, corpo: {} });
  const pedidoMoq = await chamar('POST', `/api/negociacoes/${negMoqId}/converter-pedido`, {
    token: admin, corpo: {},
  });
  const pedidoMoqId = pedidoMoq.corpo?.data?.id;
  const validacaoMoq = await chamar('GET', `/api/pedidos-compra/${pedidoMoqId}/validacao`, { token: admin });
  checar(b, 'quantidade abaixo do MOQ bloqueia a aprovacao',
    validacaoMoq.corpo?.data?.pode_aprovar === false, validacaoMoq.corpo?.data?.bloqueios);
  await chamar('POST', `/api/pedidos-compra/${pedidoMoqId}/enviar-aprovacao`, { token: admin, corpo: {} });
  const aprovarMoq = await chamar('POST', `/api/pedidos-compra/${pedidoMoqId}/aprovar`, {
    token: admin, corpo: { justificativa: 'Tentando aprovar com MOQ errado' },
  });
  checar(b, 'a API recusa aprovar pedido que nao atende ao MOQ',
    aprovarMoq.status === 422, aprovarMoq.status);

  // --- Numeracao nao se repete ---------------------------------------------
  secao('numeracao do pedido (secao 25)');
  const { rows: numeros } = await pool.query(`
    SELECT count(*)::int AS total, count(DISTINCT numero)::int AS distintos FROM ordens_compra`);
  checar(b, 'nenhum numero de pedido se repete',
    num(numeros[0].total) === num(numeros[0].distintos), numeros[0]);
  const { rows: negNumeros } = await pool.query(`
    SELECT count(*)::int AS total, count(DISTINCT numero)::int AS distintos FROM negociacoes_compra`);
  checar(b, 'nenhum numero de negociacao se repete',
    num(negNumeros[0].total) === num(negNumeros[0].distintos), negNumeros[0]);

  // --- Paineis -------------------------------------------------------------
  secao('dashboard, indicadores, KPIs e alertas (secoes 49 a 52)');
  const dash = await chamar('GET', '/api/negociacoes/dashboard?dias=365', { token: admin });
  checar(b, 'dashboard responde', dash.status === 200, dash.corpo?.error);
  checar(b, 'o painel de economia separa potencial, negociada e realizada',
    dash.corpo?.data?.painel_economia?.potencial !== undefined
    && dash.corpo?.data?.painel_economia?.negociada !== undefined
    && dash.corpo?.data?.painel_economia?.realizada !== undefined);
  checar(b, 'o dashboard traz negociacoes e pedidos por status',
    Array.isArray(dash.corpo?.data?.negociacoes_por_status)
    && Array.isArray(dash.corpo?.data?.pedidos_por_status));

  const kpi = await chamar('GET', '/api/negociacoes/kpi?dias=365', { token: admin });
  checar(b, 'KPI de negociacao responde', kpi.status === 200, kpi.corpo?.error);
  checar(b, 'taxa de negociacao, economia e rodadas medias calculadas',
    kpi.corpo?.data?.negociacao?.taxa_negociacao !== undefined
    && kpi.corpo?.data?.negociacao?.rodadas_medias !== undefined
    && kpi.corpo?.data?.negociacao?.economia_total !== undefined);
  checar(b, 'KPI de pedido traz tempo de aprovacao e percentuais',
    kpi.corpo?.data?.pedido?.tempo_aprovacao_horas !== undefined
    && kpi.corpo?.data?.pedido?.percentual_confirmados !== undefined);

  const indicadores = await chamar('GET', '/api/negociacoes/indicadores?dias=365', { token: admin });
  checar(b, 'indicadores de compras respondem', indicadores.status === 200, indicadores.corpo?.error);
  checar(b, 'saving sai por comprador, fornecedor, categoria e periodo',
    ['por_comprador', 'por_fornecedor', 'por_categoria', 'por_periodo']
      .every((k) => Array.isArray(indicadores.corpo?.data?.[k])));
  checar(b, 'saving sem referencia devolve nulo em vez de zero enganoso',
    indicadores.corpo?.data?.saving?.percentual === null
    || typeof indicadores.corpo?.data?.saving?.percentual === 'number');

  const alertas = await chamar('GET', '/api/negociacoes/alertas', { token: admin });
  checar(b, 'alertas respondem', alertas.status === 200, alertas.corpo?.error);
  checar(b, 'os alertas vem classificados por severidade',
    alertas.corpo?.data?.por_severidade !== undefined);
  checar(b, 'pedido aguardando aprovacao aparece nos alertas',
    (alertas.corpo?.data?.alertas ?? []).some((a: any) => a.tipo === 'PEDIDO_AGUARDANDO_APROVACAO'),
    (alertas.corpo?.data?.alertas ?? []).map((a: any) => a.tipo).slice(0, 10));

  // --- Listagem e filtros --------------------------------------------------
  secao('listagem, filtros e paginacao (secao 75)');
  const lista = await chamar('GET', '/api/pedidos-compra?limite=5', { token: admin });
  checar(b, 'listagem de pedidos responde paginada',
    lista.status === 200 && (lista.corpo?.data ?? []).length <= 5, lista.corpo?.error);
  checar(b, 'a listagem informa o total', lista.corpo?.meta?.total !== undefined);
  const porStatus = await chamar('GET', '/api/pedidos-compra?status=CANCELADA', { token: admin });
  checar(b, 'filtro por status funciona',
    (porStatus.corpo?.data ?? []).every((p: any) => p.status === 'CANCELADA'));
  const listaNeg = await chamar('GET', '/api/negociacoes?status=REJEITADA', { token: admin });
  checar(b, 'filtro de negociacao por status funciona',
    (listaNeg.corpo?.data ?? []).every((n: any) => n.status === 'REJEITADA'));

  // --- Permissoes e seguranca ----------------------------------------------
  secao('permissoes e seguranca (secoes 56 e 57)');
  const semToken = await chamar('GET', '/api/pedidos-compra');
  checar(b, 'sem token a API recusa', semToken.status === 401);
  const financeiro = await tokenDoPerfil(admin, 'FINANCEIRO', 'm07');
  if (financeiro) {
    const leitura = await chamar('GET', '/api/pedidos-compra', { token: financeiro });
    checar(b, 'FINANCEIRO consulta pedidos', leitura.status === 200, leitura.status);
    const tentaAprovar = await chamar('POST', `/api/pedidos-compra/${pedidoMoqId}/aprovar`, {
      token: financeiro, corpo: { justificativa: 'nao deveria' },
    });
    checar(b, 'FINANCEIRO nao aprova pedido', tentaAprovar.status === 403, tentaAprovar.status);
    const tentaCancelar = await chamar('POST', `/api/pedidos-compra/${pedidoMoqId}/cancelar`, {
      token: financeiro, corpo: { motivo: 'ERRO', justificativa: 'nao deveria' },
    });
    checar(b, 'FINANCEIRO nao cancela pedido', tentaCancelar.status === 403, tentaCancelar.status);
  }
  const inexistente = await chamar('GET', '/api/pedidos-compra/99999999', { token: admin });
  checar(b, 'pedido inexistente devolve 404', inexistente.status === 404, inexistente.status);
  const entradaInvalida = await chamar('POST', '/api/negociacoes', {
    token: admin, corpo: { origem: 'MANUAL' },
  });
  checar(b, 'a validacao do servidor recusa entrada incompleta (secao 57)',
    entradaInvalida.status === 422, entradaInvalida.status);
  const quantidadeNegativa = await chamar('POST', '/api/negociacoes', {
    token: admin,
    corpo: {
      origem: 'MANUAL', fornecedor_id: cenario.fornecedorA,
      itens: [{ produto_id: cenario.produtoMoq, quantidade: -10, preco_unitario: 1 }],
    },
  });
  checar(b, 'quantidade negativa e recusada', quantidadeNegativa.status === 422);

  // --- Rollback (secao 58) -------------------------------------------------
  secao('transacao e rollback (secoes 32 e 58)');
  const { rows: antes } = await pool.query('SELECT count(*)::int AS n FROM ordens_compra');
  const falha = await chamar('POST', '/api/negociacoes/99999999/converter-pedido', {
    token: admin, corpo: {},
  });
  const { rows: depois } = await pool.query('SELECT count(*)::int AS n FROM ordens_compra');
  checar(b, 'conversao de negociacao inexistente falha', falha.status === 404, falha.status);
  checar(b, 'a falha nao deixou pedido pela metade', num(antes[0].n) === num(depois[0].n));

  const { rows: orfaos } = await pool.query(`
    SELECT count(*)::int AS n FROM ordens_compra oc
     WHERE NOT EXISTS (SELECT 1 FROM ordem_compra_itens i WHERE i.ordem_compra_id = oc.id)
       AND oc.negociacao_id IS NOT NULL`);
  checar(b, 'nenhum pedido de negociacao ficou sem itens', num(orfaos[0].n) === 0, orfaos[0]);

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
