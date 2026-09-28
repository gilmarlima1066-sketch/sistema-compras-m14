/**
 * Bateria do MODULO 06 - cotacoes, comparacao e analise de fornecedores.
 *
 * Cobre os 32 cenarios da secao 52 do PROMPT 06 e os quatro testes dirigidos
 * das secoes 53 a 56 (tres fornecedores, criterio obrigatorio, custo total e
 * compra dividida).
 *
 * Os dados de teste usam o prefixo M06- e ficam no banco.
 */
import { pool, encerrarPool } from '../../config/database.js';
import {
  chamar, checar, encerrar, loginAdmin, novaBateria, secao, tokenDoPerfil,
  type Bateria,
} from './base.js';
import {
  avaliarElegibilidade, calcularScore, custoAquisicao, normalizar,
  precoPorFaixa, validarPesos, explicarRecomendacao,
} from '../../modules/cotacoes/pontuacao.js';

const quase = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const num = (v: unknown) => Number(v ?? 0);
const hoje = new Date();
const emDias = (d: number) => new Date(hoje.getTime() + d * 86400000).toISOString().slice(0, 10);

interface Cenario {
  produtoIds: { comum: number; perecivel: number; dividido: number };
  fornecedorIds: { a: number; b: number; c: number; inativo: number; importado: number };
}

async function preparar(): Promise<Cenario> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query("SELECT set_config('app.usuario_id', '1', true)");

    const { rows: cat } = await cliente.query(`
      INSERT INTO categorias (nome, descricao) VALUES ('M06 TESTES', 'Cenarios da bateria do modulo 06')
      ON CONFLICT (nome) DO UPDATE SET descricao = EXCLUDED.descricao RETURNING id`);
    const categoriaId = cat[0].id;
    const { rows: un } = await cliente.query("SELECT id FROM unidades WHERE codigo = 'KG'");
    const unidadeId = un[0].id;

    const produto = async (codigo: string, descricao: string, validade: number | null) => {
      const achado = (await cliente.query(
        'SELECT id FROM produtos WHERE upper(codigo) = upper($1) AND deleted_at IS NULL', [codigo])).rows;
      if (achado.length) {
        await cliente.query(
          'UPDATE produtos SET descricao = $2, dias_validade = $3, ativo = true WHERE id = $1',
          [achado[0].id, descricao, validade]);
        return Number(achado[0].id);
      }
      const { rows } = await cliente.query(`
        INSERT INTO produtos (codigo, descricao, categoria_id, unidade_compra_id,
                              unidade_estoque_id, unidade_venda_id, fator_conversao,
                              ativo, dias_validade, lead_time_padrao_dias)
        VALUES ($1, $2, $3, $4, $4, $4, 1, true, $5, 15) RETURNING id`,
        [codigo, descricao, categoriaId, unidadeId, validade]);
      return Number(rows[0].id);
    };

    const fornecedor = async (razao: string, cnpj: string, ativo: boolean, origem: string) => {
      const achado = (await cliente.query(
        'SELECT id FROM fornecedores WHERE razao_social = $1 AND deleted_at IS NULL', [razao])).rows;
      if (achado.length) {
        await cliente.query('UPDATE fornecedores SET ativo = $2 WHERE id = $1', [achado[0].id, ativo]);
        return Number(achado[0].id);
      }
      const { rows } = await cliente.query(`
        INSERT INTO fornecedores (razao_social, cnpj, tipo_fornecedor, origem_fornecedor,
                                  ativo, lead_time_padrao_dias, prazo_medio_pagamento)
        VALUES ($1, $2, 'DISTRIBUIDOR', $3, $4, 15, 30) RETURNING id`,
        [razao, cnpj, origem, ativo]);
      return Number(rows[0].id);
    };

    const produtoIds = {
      comum: await produto('M06-COMUM', 'M06 produto comum', null),
      perecivel: await produto('M06-PERECIVEL', 'M06 produto com validade', 365),
      dividido: await produto('M06-DIVIDIDO', 'M06 produto de compra dividida', null),
    };

    const fornecedorIds = {
      a: await fornecedor('FORNECEDOR M06 A', '11222333000181', true, 'NACIONAL'),
      b: await fornecedor('FORNECEDOR M06 B', '11444777000161', true, 'NACIONAL'),
      c: await fornecedor('FORNECEDOR M06 C', '34028316000103', true, 'NACIONAL'),
      inativo: await fornecedor('FORNECEDOR M06 INATIVO', '60746948000112', false, 'NACIONAL'),
      importado: await fornecedor('FORNECEDOR M06 IMPORTADO', '07526557000100', true, 'INTERNACIONAL'),
    };

    // Avaliacoes: A qualidade alta e OTIF medio, B ambos altos, C ambos baixos
    // (cenario da secao 53).
    const avaliacao = async (fornecedorId: number, otif: number, qualidade: number) => {
      await cliente.query('DELETE FROM avaliacoes_fornecedores WHERE fornecedor_id = $1', [fornecedorId]);
      await cliente.query(`
        INSERT INTO avaliacoes_fornecedores
          (fornecedor_id, periodo_inicio, periodo_fim, otif, qualidade, lead_time,
           preco, atendimento, flexibilidade, score_final, ocorrencias)
        VALUES ($1, CURRENT_DATE - 180, CURRENT_DATE, $2, $3, 80, 80, 80, 80, $4, 0)`,
        [fornecedorId, otif, qualidade, (otif + qualidade) / 2]);
    };
    await avaliacao(fornecedorIds.a, 85, 95);
    await avaliacao(fornecedorIds.b, 96, 92);
    await avaliacao(fornecedorIds.c, 62, 70);

    // Historico de precos para comparar contra a ultima compra (secao 24).
    // A tabela e somente-insercao por design (modulo 01), entao a carga e
    // condicional em vez de apagar e recriar.
    const { rows: jaTem } = await cliente.query(
      "SELECT 1 FROM historico_precos WHERE produto_id = $1 AND origem = 'TESTE_M06' LIMIT 1",
      [produtoIds.comum]);
    if (!jaTem.length) {
      await cliente.query(`
        INSERT INTO historico_precos
          (produto_id, fornecedor_id, data, quantidade, preco_unitario, frete, impostos,
           outros_custos, custo_efetivo, moeda, origem)
        VALUES ($1, $2, CURRENT_DATE - 90, 1000, 10, 0, 0, 0, 10, 'BRL', 'TESTE_M06')`,
        [produtoIds.comum, fornecedorIds.a]);
    }

    await cliente.query('COMMIT');
    return { produtoIds, fornecedorIds };
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }
}

// ---------------------------------------------------------------------------
// Bloco 1 - matematica
// ---------------------------------------------------------------------------

function matematica(): Bateria {
  const b = novaBateria('MODULO 06 - matematica da comparacao');

  secao('custo total de aquisicao (secoes 13 e 55)');
  const a = custoAquisicao({
    quantidadeOfertada: 1000, precoUnitario: 100, desconto: 0, frete: 10000,
    impostos: 0, seguro: 0, desembaraco: 0, taxas: 0, outrosCustos: 0, taxaCambio: null,
  });
  const bb = custoAquisicao({
    quantidadeOfertada: 1000, precoUnitario: 103, desconto: 0, frete: 2000,
    impostos: 0, seguro: 0, desembaraco: 0, taxas: 0, outrosCustos: 0, taxaCambio: null,
  });
  checar(b, 'A: 100.000 de produto + 10.000 de frete = 110.000', quase(a.custoTotal, 110000));
  checar(b, 'B: 103.000 de produto + 2.000 de frete = 105.000', quase(bb.custoTotal, 105000));
  checar(b, 'o mais barato no produto nao e o mais barato no total', a.custoTotal > bb.custoTotal);
  checar(b, 'custo unitario = custo total / quantidade', quase(a.custoUnitario, 110));

  const comDesconto = custoAquisicao({
    quantidadeOfertada: 100, precoUnitario: 10, desconto: 100, frete: 50,
    impostos: 30, seguro: 20, desembaraco: 40, taxas: 10, outrosCustos: 5, taxaCambio: null,
  });
  checar(b, 'desconto subtrai e os demais componentes somam',
    quase(comDesconto.custoTotal, 1000 - 100 + 50 + 30 + 20 + 40 + 10 + 5));
  checar(b, 'preco liquido unitario desconta antes de dividir',
    quase(comDesconto.precoLiquidoUnitario, 9));

  secao('moeda e cambio (secao 31)');
  const emDolar = custoAquisicao({
    quantidadeOfertada: 10, precoUnitario: 100, desconto: 0, frete: 50,
    impostos: 0, seguro: 0, desembaraco: 0, taxas: 0, outrosCustos: 0, taxaCambio: 5,
  });
  checar(b, 'conversao multiplica todos os componentes', quase(emDolar.custoTotal, (1000 + 50) * 5));
  checar(b, 'conversao fica sinalizada', emDolar.moedaConvertida);
  const semTaxa = custoAquisicao({
    quantidadeOfertada: 10, precoUnitario: 100, desconto: 0, frete: 0,
    impostos: 0, seguro: 0, desembaraco: 0, taxas: 0, outrosCustos: 0, taxaCambio: null,
  });
  checar(b, 'sem taxa o valor nominal e preservado', quase(semTaxa.custoTotal, 1000));

  secao('desconto por volume (secao 29)');
  const faixas = [
    { quantidade_de: 1, quantidade_ate: 499, preco_unitario: 10 },
    { quantidade_de: 500, quantidade_ate: 999, preco_unitario: 9.7 },
    { quantidade_de: 1000, quantidade_ate: null, preco_unitario: 9.4 },
  ];
  checar(b, '300 kg cai na primeira faixa', precoPorFaixa(faixas, 300) === 10);
  checar(b, '700 kg cai na segunda faixa', precoPorFaixa(faixas, 700) === 9.7);
  checar(b, '5.000 kg cai na faixa aberta', precoPorFaixa(faixas, 5000) === 9.4);
  checar(b, 'quantidade fora de qualquer faixa volta null', precoPorFaixa(faixas, 0) === null);

  secao('normalizacao (secao 17)');
  checar(b, 'menor e melhor: o menor vale 100', quase(normalizar(10, 10, 20, 'MENOR_MELHOR'), 100));
  checar(b, 'menor e melhor: o maior vale 0', quase(normalizar(20, 10, 20, 'MENOR_MELHOR'), 0));
  checar(b, 'maior e melhor inverte a escala', quase(normalizar(20, 10, 20, 'MAIOR_MELHOR'), 100));
  checar(b, 'empate geral da 100 para todos', quase(normalizar(10, 10, 10, 'MENOR_MELHOR'), 100));
  checar(b, 'ponto medio vale 50', quase(normalizar(15, 10, 20, 'MENOR_MELHOR'), 50));

  secao('score ponderado (secao 18)');
  const resultado = calcularScore([
    {
      id: 1,
      criterios: [
        { codigo: 'CUSTO_TOTAL', peso: 50, direcao: 'MENOR_MELHOR', valor: 10 },
        { codigo: 'PRAZO_ENTREGA', peso: 50, direcao: 'MENOR_MELHOR', valor: 20 },
      ],
    },
    {
      id: 2,
      criterios: [
        { codigo: 'CUSTO_TOTAL', peso: 50, direcao: 'MENOR_MELHOR', valor: 20 },
        { codigo: 'PRAZO_ENTREGA', peso: 50, direcao: 'MENOR_MELHOR', valor: 10 },
      ],
    },
  ]);
  checar(b, 'duas propostas espelhadas empatam em 50',
    quase(resultado.get(1)!.score, 50) && quase(resultado.get(2)!.score, 50),
    { um: resultado.get(1)!.score, dois: resultado.get(2)!.score });

  const comFalta = calcularScore([
    {
      id: 1,
      criterios: [
        { codigo: 'CUSTO_TOTAL', peso: 60, direcao: 'MENOR_MELHOR', valor: 10 },
        { codigo: 'OTIF', peso: 40, direcao: 'MAIOR_MELHOR', valor: null },
      ],
    },
    {
      id: 2,
      criterios: [
        { codigo: 'CUSTO_TOTAL', peso: 60, direcao: 'MENOR_MELHOR', valor: 20 },
        { codigo: 'OTIF', peso: 40, direcao: 'MAIOR_MELHOR', valor: null },
      ],
    },
  ]);
  checar(b, 'criterio sem dado nao zera o score: peso e redistribuido',
    quase(comFalta.get(1)!.score, 100) && quase(comFalta.get(2)!.score, 0),
    { um: comFalta.get(1)!.score, dois: comFalta.get(2)!.score });
  checar(b, 'criterio sem dado e marcado como insuficiente, nao pontuado',
    comFalta.get(1)!.criterios.find((c) => c.codigo === 'OTIF')?.dadosInsuficientes === true
    && comFalta.get(1)!.criterios.find((c) => c.codigo === 'OTIF')?.pontuacao === null);
  checar(b, 'peso utilizado reflete so os criterios com dado',
    comFalta.get(1)!.pesoUtilizado === 60);

  secao('validacao dos pesos (secao 15)');
  checar(b, 'pesos que somam 100 sao validos', validarPesos([35, 20, 15, 10, 10, 5, 5]).valido);
  checar(b, 'pesos que somam 90 sao recusados', !validarPesos([35, 20, 15, 10, 10]).valido);
  checar(b, 'a soma e devolvida para a mensagem de erro', validarPesos([50, 30]).soma === 80);

  secao('criterios obrigatorios (secoes 20, 21 e 54)');
  const base = {
    fornecedorAtivo: true, quantidadeOfertada: 100, quantidadeSolicitada: 100,
    validadeProdutoDias: 365, validadeMinimaDias: 180,
    dataPrevistaEntrega: emDias(10), dataNecessaria: emDias(20),
    disponibilidade: 'IMEDIATA', validadeProposta: emDias(30),
    moq: null, precoMaximo: null, custoUnitario: 10, hoje: emDias(0),
  };
  checar(b, 'proposta que atende tudo e elegivel', avaliarElegibilidade(base).length === 0);

  const validadeCurta = avaliarElegibilidade({ ...base, validadeProdutoDias: 90 });
  checar(b, 'validade de 90 dias contra exigencia de 180 elimina a proposta',
    validadeCurta.some((m) => m.criterio === 'VALIDADE_MINIMA'));
  checar(b, 'o motivo diz os dois numeros',
    /90/.test(validadeCurta[0]?.motivo ?? '') && /180/.test(validadeCurta[0]?.motivo ?? ''));

  checar(b, 'entrega depois da data necessaria elimina',
    avaliarElegibilidade({ ...base, dataPrevistaEntrega: emDias(40) })
      .some((m) => m.criterio === 'DATA_ENTREGA'));
  checar(b, 'fornecedor inativo elimina',
    avaliarElegibilidade({ ...base, fornecedorAtivo: false })
      .some((m) => m.criterio === 'FORNECEDOR_ATIVO'));
  checar(b, 'produto indisponivel elimina',
    avaliarElegibilidade({ ...base, disponibilidade: 'INDISPONIVEL' })
      .some((m) => m.criterio === 'DISPONIBILIDADE'));
  checar(b, 'proposta expirada elimina',
    avaliarElegibilidade({ ...base, validadeProposta: emDias(-1) })
      .some((m) => m.criterio === 'PROPOSTA_EXPIRADA'));
  checar(b, 'MOQ mais que o dobro da necessidade elimina',
    avaliarElegibilidade({ ...base, moq: 500 }).some((m) => m.criterio === 'MOQ_INVIAVEL'));
  checar(b, 'custo acima do preco maximo elimina',
    avaliarElegibilidade({ ...base, precoMaximo: 8 }).some((m) => m.criterio === 'PRECO_MAXIMO'));
  checar(b, 'item sem resposta nao vira preco zero: e inelegivel',
    avaliarElegibilidade({ ...base, quantidadeOfertada: null })
      .some((m) => m.criterio === 'SEM_RESPOSTA'));

  secao('recomendacao explicada (secoes 35 e 36)');
  const explicacao = explicarRecomendacao([
    { id: 1, fornecedor: 'A', custoUnitario: 10, custoTotal: 1000, prazoEntregaDias: 30,
      prazoPagamentoDias: 30, otif: 85, qualidade: 95, atendimentoPercentual: 100, score: 70, elegivel: true },
    { id: 2, fornecedor: 'B', custoUnitario: 11, custoTotal: 1100, prazoEntregaDias: 10,
      prazoPagamentoDias: 30, otif: 96, qualidade: 92, atendimentoPercentual: 100, score: 85, elegivel: true },
  ]);
  checar(b, 'vence o melhor score, nao o menor preco', explicacao.recomendada?.fornecedor === 'B');
  checar(b, 'a explicacao diz que nao e a mais barata e quanto custa a mais',
    /nao e a proposta mais barata/i.test(explicacao.texto) && /100\.00/.test(explicacao.texto),
    explicacao.texto);
  checar(b, 'a explicacao cita o prazo e o OTIF',
    /prazo de entrega/i.test(explicacao.texto) && /OTIF/i.test(explicacao.texto));
  checar(b, 'a decisao final fica com o comprador', /decisao final e do comprador/i.test(explicacao.texto));

  const semElegivel = explicarRecomendacao([
    { id: 1, fornecedor: 'A', custoUnitario: 10, custoTotal: 1000, prazoEntregaDias: 30,
      prazoPagamentoDias: 30, otif: null, qualidade: null, atendimentoPercentual: 100, score: 0, elegivel: false },
  ]);
  checar(b, 'sem proposta elegivel nao ha recomendacao inventada',
    semElegivel.recomendada === null && /nenhuma proposta elegivel/i.test(semElegivel.texto));

  return b;
}

// ---------------------------------------------------------------------------
// Bloco 2 - fluxo completo pela API
// ---------------------------------------------------------------------------

async function fluxo(cenario: Cenario): Promise<{ bateria: Bateria; cotacaoId: number }> {
  const b = novaBateria('MODULO 06 - fluxo da cotacao');
  const admin = await loginAdmin();
  const { produtoIds, fornecedorIds } = cenario;

  secao('criacao (secao 5)');
  const semNada = await chamar('POST', '/api/cotacoes', { token: admin, corpo: {} });
  checar(b, 'cotacao sem produto nem requisicao e recusada', semNada.status === 422);

  const criada = await chamar('POST', '/api/cotacoes', {
    token: admin,
    corpo: {
      origem: 'MANUAL',
      produtos: [
        { produto_id: produtoIds.comum, quantidade: 1000 },
        { produto_id: produtoIds.perecivel, quantidade: 500, validade_minima_dias: 180 },
        { produto_id: produtoIds.dividido, quantidade: 10000 },
      ],
      data_necessaria: emDias(45),
      observacao: 'Bateria m06',
    },
  });
  checar(b, 'cotacao e criada', criada.status === 201, criada.corpo?.error);
  const cotacaoId = criada.corpo?.data?.id;
  checar(b, 'cotacao recebe numero sequencial', /^COT-\d{8}-\d+$/.test(criada.corpo?.data?.numero ?? ''));
  checar(b, 'cotacao nasce em rascunho', criada.corpo?.data?.status === 'RASCUNHO');
  checar(b, 'os tres produtos entraram', criada.corpo?.data?.produtos === 3);

  secao('criterios e pesos (secoes 15 e 16)');
  const criterios = await chamar('GET', `/api/cotacoes/${cotacaoId}/criterios`, { token: admin });
  checar(b, 'criterios sao copiados na criacao', (criterios.corpo?.data?.criterios ?? []).length >= 7);
  checar(b, 'os pesos copiados somam 100', criterios.corpo?.data?.valido === true,
    criterios.corpo?.data?.soma_pesos);

  const pesosInvalidos = await chamar('PUT', `/api/cotacoes/${cotacaoId}/criterios`, {
    token: admin,
    corpo: { criterios: [{ codigo: 'CUSTO_TOTAL', peso: 50 }, { codigo: 'PRAZO_ENTREGA', peso: 30 }] },
  });
  checar(b, 'pesos que nao somam 100 sao recusados', pesosInvalidos.status === 422,
    pesosInvalidos.corpo?.error?.message);
  checar(b, 'a mensagem diz quanto somou', /80/.test(pesosInvalidos.corpo?.error?.message ?? ''));

  const criterioInexistente = await chamar('PUT', `/api/cotacoes/${cotacaoId}/criterios`, {
    token: admin, corpo: { criterios: [{ codigo: 'INVENTADO', peso: 100 }] },
  });
  checar(b, 'criterio desconhecido e recusado', criterioInexistente.status === 422);

  secao('fornecedores convidados (secao 7)');
  const historico = await chamar('GET',
    `/api/cotacoes/fornecedores/${fornecedorIds.a}/historico?produto_id=${produtoIds.comum}`,
    { token: admin });
  checar(b, 'historico do fornecedor responde 200', historico.status === 200, historico.corpo?.error);
  checar(b, 'historico traz ultimo preco e preco medio',
    historico.corpo?.data?.precos?.ultimo_preco !== undefined);
  checar(b, 'historico traz OTIF e qualidade da avaliacao',
    num(historico.corpo?.data?.avaliacao?.otif) > 0);

  const comInativo = await chamar('POST', `/api/cotacoes/${cotacaoId}/fornecedores`, {
    token: admin, corpo: { fornecedor_ids: [fornecedorIds.inativo] },
  });
  checar(b, 'fornecedor inativo nao pode ser convidado', comInativo.status === 422,
    comInativo.corpo?.error?.message);

  const convidados = await chamar('POST', `/api/cotacoes/${cotacaoId}/fornecedores`, {
    token: admin,
    corpo: { fornecedor_ids: [fornecedorIds.a, fornecedorIds.b, fornecedorIds.c, fornecedorIds.importado] },
  });
  checar(b, 'quatro fornecedores convidados', convidados.status === 201 && convidados.corpo?.data?.adicionados === 4,
    convidados.corpo?.error);

  secao('envio (secao 8)');
  const solicitacao = await chamar('GET', `/api/cotacoes/${cotacaoId}/solicitacao`, { token: admin });
  checar(b, 'documento de solicitacao responde 200', solicitacao.status === 200);
  checar(b, 'documento lista os itens com quantidade e unidade',
    (solicitacao.corpo?.data?.itens ?? []).length === 3
    && solicitacao.corpo.data.itens[0].quantidade !== undefined);
  checar(b, 'documento lista os destinatarios',
    (solicitacao.corpo?.data?.destinatarios ?? []).length === 4);

  const enviada = await chamar('POST', `/api/cotacoes/${cotacaoId}/enviar`, {
    token: admin, corpo: { canal: 'EMAIL' },
  });
  checar(b, 'cotacao e enviada', enviada.status === 200, enviada.corpo?.error);
  checar(b, 'status vai para aguardando respostas',
    enviada.corpo?.data?.status === 'AGUARDANDO_RESPOSTAS');

  const { rows: convites } = await pool.query(
    "SELECT status::text, data_envio FROM cotacao_fornecedores WHERE cotacao_id = $1", [cotacaoId]);
  checar(b, 'todos os convites ficam ENVIADA com data',
    convites.every((c) => c.status === 'ENVIADA' && c.data_envio));

  secao('status do fornecedor (secao 33)');
  const visualizada = await chamar('POST',
    `/api/cotacoes/${cotacaoId}/fornecedores/${fornecedorIds.a}/visualizada`, { token: admin });
  checar(b, 'visualizacao muda o status', visualizada.corpo?.data?.status === 'VISUALIZADO');

  const lembrete = await chamar('POST',
    `/api/cotacoes/${cotacaoId}/fornecedores/${fornecedorIds.c}/lembrete`, { token: admin });
  checar(b, 'lembrete e contabilizado', num(lembrete.corpo?.data?.lembretes) === 1);

  return { bateria: b, cotacaoId };
}

// ---------------------------------------------------------------------------
// Bloco 3 - propostas, comparacao e decisao
// ---------------------------------------------------------------------------

async function propostas(cenario: Cenario, cotacaoId: number): Promise<Bateria> {
  const b = novaBateria('MODULO 06 - propostas, score e decisao');
  const admin = await loginAdmin();
  const { produtoIds, fornecedorIds } = cenario;

  secao('respostas dos fornecedores (secoes 9 a 11)');
  const naoConvidado = await chamar('POST', `/api/cotacoes/${cotacaoId}/respostas`, {
    token: admin,
    corpo: {
      fornecedor_id: fornecedorIds.inativo,
      itens: [{ produto_id: produtoIds.comum, quantidade_ofertada: 1000, preco_unitario: 9 }],
    },
  });
  checar(b, 'fornecedor nao convidado nao pode responder', naoConvidado.status === 422);

  // FORNECEDOR A: menor preco, prazo maior, OTIF medio, qualidade alta.
  const respostaA = await chamar('POST', `/api/cotacoes/${cotacaoId}/respostas`, {
    token: admin,
    corpo: {
      fornecedor_id: fornecedorIds.a,
      itens: [
        {
          produto_id: produtoIds.comum, quantidade_ofertada: 1000, preco_unitario: 10,
          frete: 1000, prazo_entrega_dias: 30, prazo_pagamento_dias: 30,
          data_prevista_entrega: emDias(30), disponibilidade: 'IMEDIATA',
          validade_proposta: emDias(20), moeda: 'BRL',
          faixas_preco: [
            { quantidade_de: 1, quantidade_ate: 499, preco_unitario: 10.5 },
            { quantidade_de: 500, quantidade_ate: 999, preco_unitario: 10.2 },
            { quantidade_de: 1000, quantidade_ate: null, preco_unitario: 10 },
          ],
        },
        {
          // Validade de 90 dias contra exigencia de 180: secao 54.
          produto_id: produtoIds.perecivel, quantidade_ofertada: 500, preco_unitario: 5,
          frete: 100, prazo_entrega_dias: 15, prazo_pagamento_dias: 30,
          data_prevista_entrega: emDias(15), validade_produto_dias: 90,
          disponibilidade: 'IMEDIATA', validade_proposta: emDias(20),
        },
        {
          // Atende so 6.000 dos 10.000: secao 56.
          produto_id: produtoIds.dividido, quantidade_ofertada: 6000, preco_unitario: 8,
          frete: 500, prazo_entrega_dias: 20, prazo_pagamento_dias: 30,
          data_prevista_entrega: emDias(20), disponibilidade: 'PARCIAL',
          validade_proposta: emDias(20),
        },
      ],
    },
  });
  checar(b, 'proposta A registrada', respostaA.status === 201, respostaA.corpo?.error);
  checar(b, 'A respondeu os tres itens', respostaA.corpo?.data?.itens_gravados === 3);
  checar(b, 'A fica como RESPONDIDA', respostaA.corpo?.data?.status_fornecedor === 'RESPONDIDA');
  checar(b, 'quantidade diferente da pedida gera aviso',
    (respostaA.corpo?.data?.avisos ?? []).some((a: any) => a.produto_id === produtoIds.dividido),
    respostaA.corpo?.data?.avisos);

  // FORNECEDOR B: preco intermediario, prazo menor, OTIF alto.
  const respostaB = await chamar('POST', `/api/cotacoes/${cotacaoId}/respostas`, {
    token: admin,
    corpo: {
      fornecedor_id: fornecedorIds.b,
      itens: [
        {
          produto_id: produtoIds.comum, quantidade_ofertada: 1000, preco_unitario: 10.3,
          frete: 200, prazo_entrega_dias: 10, prazo_pagamento_dias: 45,
          data_prevista_entrega: emDias(10), disponibilidade: 'IMEDIATA',
          validade_proposta: emDias(30),
        },
        {
          produto_id: produtoIds.perecivel, quantidade_ofertada: 500, preco_unitario: 5.5,
          frete: 120, prazo_entrega_dias: 12, prazo_pagamento_dias: 30,
          data_prevista_entrega: emDias(12), validade_produto_dias: 300,
          disponibilidade: 'IMEDIATA', validade_proposta: emDias(30),
        },
        {
          produto_id: produtoIds.dividido, quantidade_ofertada: 4000, preco_unitario: 8.4,
          frete: 400, prazo_entrega_dias: 15, prazo_pagamento_dias: 30,
          data_prevista_entrega: emDias(15), disponibilidade: 'IMEDIATA',
          validade_proposta: emDias(30),
        },
      ],
    },
  });
  checar(b, 'proposta B registrada', respostaB.status === 201, respostaB.corpo?.error);

  // FORNECEDOR C: preco maior, prazo maior, OTIF baixo. Responde so um item
  // (resposta parcial, secao 10).
  const respostaC = await chamar('POST', `/api/cotacoes/${cotacaoId}/respostas`, {
    token: admin,
    corpo: {
      fornecedor_id: fornecedorIds.c,
      itens: [
        {
          produto_id: produtoIds.comum, quantidade_ofertada: 1000, preco_unitario: 11.5,
          frete: 800, impostos: 200, prazo_entrega_dias: 35, prazo_pagamento_dias: 60,
          data_prevista_entrega: emDias(35), disponibilidade: 'PRODUCAO',
          validade_proposta: emDias(10),
        },
      ],
    },
  });
  checar(b, 'proposta parcial registrada', respostaC.status === 201, respostaC.corpo?.error);
  checar(b, 'C fica PARCIALMENTE_RESPONDIDA',
    respostaC.corpo?.data?.status_fornecedor === 'PARCIALMENTE_RESPONDIDA');
  checar(b, 'os dois itens nao respondidos sao contados',
    respostaC.corpo?.data?.itens_sem_resposta === 2);

  // Fornecedor importado: moeda e incoterm (secoes 31 e 32).
  const respostaImportado = await chamar('POST', `/api/cotacoes/${cotacaoId}/respostas`, {
    token: admin,
    corpo: {
      fornecedor_id: fornecedorIds.importado,
      itens: [{
        produto_id: produtoIds.comum, quantidade_ofertada: 1000, preco_unitario: 1.8,
        frete: 300, seguro: 100, desembaraco: 400, taxas: 150,
        prazo_entrega_dias: 60, prazo_pagamento_dias: 60,
        data_prevista_entrega: emDias(60), disponibilidade: 'IMEDIATA',
        validade_proposta: emDias(30), incoterm: 'CIF',
        moeda: 'USD', taxa_cambio: 5.2, data_taxa_cambio: emDias(0),
      }],
    },
  });
  checar(b, 'proposta em moeda estrangeira registrada', respostaImportado.status === 201,
    respostaImportado.corpo?.error);

  const { rows: importado } = await pool.query(`
    SELECT ci.moeda, ci.taxa_cambio, ci.incoterm::text, ci.custo_total_base, ci.preco_unitario
      FROM cotacao_itens ci WHERE ci.cotacao_id = $1 AND ci.fornecedor_id = $2`,
    [cotacaoId, fornecedorIds.importado]);
  checar(b, 'a moeda original e preservada',
    importado[0]?.moeda === 'USD' && num(importado[0]?.preco_unitario) === 1.8);
  checar(b, 'o incoterm e gravado', importado[0]?.incoterm === 'CIF');
  checar(b, 'custo total convertido = (1800 + 300 + 100 + 400 + 150) x 5,2',
    quase(num(importado[0]?.custo_total_base), (1800 + 300 + 100 + 400 + 150) * 5.2, 0.01),
    importado[0]?.custo_total_base);

  secao('resposta parcial nao vira preco zero (secao 10)');
  const listagem = await chamar('GET', `/api/cotacoes/${cotacaoId}/respostas`, { token: admin });
  checar(b, 'propostas listadas', listagem.status === 200);
  checar(b, 'o que ninguem respondeu aparece como ausencia explicita',
    (listagem.corpo?.data?.sem_resposta ?? []).length > 0,
    listagem.corpo?.data?.sem_resposta?.length);
  const { rows: zeros } = await pool.query(
    'SELECT count(*)::int AS n FROM cotacao_itens WHERE cotacao_id = $1 AND preco_unitario = 0',
    [cotacaoId]);
  checar(b, 'nenhum item ausente virou linha com preco zero', num(zeros[0].n) === 0);

  secao('analise e score');
  const analise = await chamar('POST', `/api/cotacoes/${cotacaoId}/analisar`, { token: admin, corpo: {} });
  checar(b, 'comparativo calculado', analise.status === 200, analise.corpo?.error);

  const produtos = analise.corpo?.data?.produtos ?? [];
  const comum = produtos.find((p: any) => p.codigo === 'M06-COMUM');
  const perecivel = produtos.find((p: any) => p.codigo === 'M06-PERECIVEL');
  const dividido = produtos.find((p: any) => p.codigo === 'M06-DIVIDIDO');

  checar(b, 'produto comum recebeu quatro propostas', comum?.propostas_recebidas === 4,
    comum?.propostas_recebidas);
  checar(b, 'toda proposta elegivel tem score',
    (comum?.propostas ?? []).filter((p: any) => p.elegivel).every((p: any) => p.score !== null),
    (comum?.propostas ?? []).map((p: any) => ({ f: p.fornecedor, el: p.elegivel, s: p.score })));
  checar(b, 'proposta inelegivel nao recebe score, recebe motivo',
    (comum?.propostas ?? []).filter((p: any) => !p.elegivel)
      .every((p: any) => p.score === null && (p.motivos_inelegibilidade ?? []).length > 0));
  checar(b, 'ha uma proposta recomendada', !!comum?.recomendada);
  checar(b, 'o menor e o maior custo do item sao calculados',
    comum?.menor_custo_unitario !== null && comum?.maior_custo_unitario !== null);
  checar(b, 'a dispersao entre propostas e medida', comum?.dispersao_percentual !== null);

  secao('criterio obrigatorio elimina mesmo com menor preco (secao 54)');
  const propostaAPerecivel = (perecivel?.propostas ?? [])
    .find((p: any) => Number(p.fornecedor_id) === fornecedorIds.a);
  const propostaBPerecivel = (perecivel?.propostas ?? [])
    .find((p: any) => Number(p.fornecedor_id) === fornecedorIds.b);
  checar(b, 'A tem o menor preco no produto perecivel',
    num(propostaAPerecivel?.custo_efetivo_unitario) < num(propostaBPerecivel?.custo_efetivo_unitario));
  checar(b, 'A e marcado NAO ELEGIVEL pela validade', propostaAPerecivel?.elegivel === false);
  checar(b, 'o motivo e a validade inferior ao minimo',
    (propostaAPerecivel?.motivos_inelegibilidade ?? [])
      .some((m: any) => m.criterio === 'VALIDADE_MINIMA'),
    propostaAPerecivel?.motivos_inelegibilidade);
  checar(b, 'a recomendacao do perecivel vai para B, mais caro porem elegivel',
    Number(perecivel?.recomendada?.fornecedor_id) === fornecedorIds.b,
    perecivel?.recomendada?.fornecedor);

  secao('custo total decide, nao o preco do produto (secao 55)');
  const propostaAComum = (comum?.propostas ?? [])
    .find((p: any) => Number(p.fornecedor_id) === fornecedorIds.a);
  const propostaBComum = (comum?.propostas ?? [])
    .find((p: any) => Number(p.fornecedor_id) === fornecedorIds.b);
  checar(b, 'A tem preco unitario menor que B',
    num(propostaAComum?.preco_unitario) < num(propostaBComum?.preco_unitario));
  checar(b, 'mas o custo total de B e menor por causa do frete',
    num(propostaBComum?.custo_total_base) < num(propostaAComum?.custo_total_base),
    { A: propostaAComum?.custo_total_base, B: propostaBComum?.custo_total_base });
  checar(b, 'A: 1000 x 10 + 1000 de frete = 11.000',
    quase(num(propostaAComum?.custo_total_base), 11000, 0.01));
  checar(b, 'B: 1000 x 10,3 + 200 de frete = 10.500',
    quase(num(propostaBComum?.custo_total_base), 10500, 0.01));

  secao('comparacao com o historico (secao 24)');
  checar(b, 'o ultimo preco comprado e trazido', num(comum?.ultimo_preco) === 10);
  checar(b, 'a variacao contra a ultima compra e calculada',
    propostaAComum?.variacao_ultima_compra !== null);
  checar(b, 'A custa 10% a mais que a ultima compra (11 contra 10)',
    quase(num(propostaAComum?.variacao_ultima_compra), 10, 0.01),
    propostaAComum?.variacao_ultima_compra);
  checar(b, 'a variacao relevante gera alerta',
    (propostaAComum?.alertas ?? []).some((a: any) => a.tipo === 'PRECO_ACIMA_HISTORICO'));

  secao('como esta proposta foi avaliada (secao 19)');
  const pontuacao = await chamar('GET',
    `/api/cotacoes/propostas/${propostaBComum?.cotacao_item_id}/pontuacao`, { token: admin });
  checar(b, 'detalhamento da pontuacao responde 200', pontuacao.status === 200, pontuacao.corpo?.error);
  const detalhe = pontuacao.corpo?.data;
  checar(b, 'traz criterio, valor, pontuacao, peso e ponderada',
    (detalhe?.criterios ?? []).every((c: any) =>
      c.codigo && 'valor_original' in c && 'pontuacao' in c && 'peso' in c && 'pontuacao_ponderada' in c));
  checar(b, 'traz a formula do score', /soma\(pontuacao x peso\)/.test(detalhe?.formula_score ?? ''));
  checar(b, 'traz a decomposicao do custo total', detalhe?.custo?.frete !== undefined);
  checar(b, 'o score confere com a soma ponderada dividida pelos pesos usados',
    detalhe.soma_pesos_utilizados > 0
    && quase(num(detalhe.score), (num(detalhe.soma_ponderada) / num(detalhe.soma_pesos_utilizados)) * 100, 0.01),
    { score: detalhe?.score, ponderada: detalhe?.soma_ponderada, pesos: detalhe?.soma_pesos_utilizados });

  secao('matriz por produto (secao 22)');
  const matriz = await chamar('GET', `/api/cotacoes/${cotacaoId}/matriz?metrica=CUSTO_TOTAL`, { token: admin });
  checar(b, 'matriz responde 200', matriz.status === 200);
  checar(b, 'a matriz tem uma linha por produto', (matriz.corpo?.data?.linhas ?? []).length === 3);
  checar(b, 'celula sem proposta e marcada como sem resposta',
    (matriz.corpo?.data?.linhas ?? []).some((l: any) =>
      l.valores.some((v: any) => v.sem_resposta === true)));
  const matrizPrazo = await chamar('GET', `/api/cotacoes/${cotacaoId}/matriz?metrica=PRAZO`, { token: admin });
  checar(b, 'a matriz troca de metrica', matrizPrazo.corpo?.data?.metrica === 'PRAZO');

  secao('recomendacao (secoes 35 a 38)');
  const recomendacao = await chamar('GET', `/api/cotacoes/${cotacaoId}/recomendacao`, { token: admin });
  checar(b, 'recomendacao responde 200', recomendacao.status === 200, recomendacao.corpo?.error);
  checar(b, 'toda linha traz explicacao em texto',
    (recomendacao.corpo?.data?.por_produto ?? []).every((p: any) => (p.explicacao ?? '').length > 30));
  checar(b, 'as propostas inelegiveis sao listadas com motivo',
    (recomendacao.corpo?.data?.por_produto ?? [])
      .some((p: any) => (p.inelegiveis ?? []).length > 0));
  const consolidado = recomendacao.corpo?.data?.consolidado;
  checar(b, 'consolidado traz custo, prazo e score medio',
    consolidado?.custo_total > 0 && consolidado?.produtos_atendidos >= 1);
  checar(b, 'produtos diferentes podem ir para fornecedores diferentes (secao 37)',
    consolidado?.fornecedores >= 1);

  secao('economia potencial (secao 40)');
  const economia = await chamar('GET', `/api/cotacoes/${cotacaoId}/economia`, { token: admin });
  checar(b, 'economia responde 200', economia.status === 200, economia.corpo?.error);
  checar(b, 'a referencia usada e declarada', economia.corpo?.data?.referencia === 'ULTIMA_COMPRA');
  checar(b, 'itens sem preco de referencia sao contados, nao chutados',
    typeof economia.corpo?.data?.itens_sem_referencia === 'number');
  checar(b, 'o texto deixa claro que a economia e potencial',
    /potencial/i.test(economia.corpo?.data?.observacao ?? ''));

  secao('consolidacao por fornecedor (secao 28)');
  const consolidacao = await chamar('GET', `/api/cotacoes/${cotacaoId}/consolidacao`, { token: admin });
  checar(b, 'consolidacao responde 200', consolidacao.status === 200, consolidacao.corpo?.error);
  checar(b, 'mostra a cobertura de cada fornecedor',
    (consolidacao.corpo?.data ?? []).every((f: any) => typeof f.cobertura_percentual === 'number'));
  checar(b, 'identifica quem atende a cotacao inteira',
    (consolidacao.corpo?.data ?? []).some((f: any) => typeof f.atende_tudo === 'boolean'));

  secao('cenarios (secoes 39 e 56)');
  const cenarioCusto = await chamar('POST', `/api/cotacoes/${cotacaoId}/cenarios`, {
    token: admin, corpo: { nome: 'Menor custo', tipo: 'MENOR_CUSTO' },
  });
  checar(b, 'cenario de menor custo criado', cenarioCusto.status === 201, cenarioCusto.corpo?.error);

  const cenarioPrazo = await chamar('POST', `/api/cotacoes/${cotacaoId}/cenarios`, {
    token: admin, corpo: { nome: 'Menor prazo', tipo: 'MENOR_PRAZO' },
  });
  checar(b, 'cenario de menor prazo criado', cenarioPrazo.status === 201);
  checar(b, 'o cenario de menor prazo nao tem prazo maior que o de menor custo',
    num(cenarioPrazo.corpo?.data?.prazo_maximo_dias) <= num(cenarioCusto.corpo?.data?.prazo_maximo_dias),
    { prazo: cenarioPrazo.corpo?.data?.prazo_maximo_dias, custo: cenarioCusto.corpo?.data?.prazo_maximo_dias });
  // O total absoluto nao serve de comparacao: cenarios atendem quantidades
  // diferentes. Quem compara e o custo por unidade atendida.
  checar(b, 'o cenario de menor custo tem o menor custo por unidade atendida',
    num(cenarioCusto.corpo?.data?.custo_por_unidade) <= num(cenarioPrazo.corpo?.data?.custo_por_unidade),
    { custo: cenarioCusto.corpo?.data?.custo_por_unidade, prazo: cenarioPrazo.corpo?.data?.custo_por_unidade });
  checar(b, 'o cenario informa quanto da necessidade cobriu',
    num(cenarioCusto.corpo?.data?.quantidade_atendida) > 0
    && num(cenarioCusto.corpo?.data?.quantidade_total) >= num(cenarioCusto.corpo?.data?.quantidade_atendida));

  const cenarioPagamento = await chamar('POST', `/api/cotacoes/${cotacaoId}/cenarios`, {
    token: admin, corpo: { nome: 'Maior prazo de pagamento', tipo: 'MAIOR_PRAZO_PAGAMENTO' },
  });
  checar(b, 'cenario de maior prazo de pagamento criado', cenarioPagamento.status === 201);

  const cenarioUnicoSemFornecedor = await chamar('POST', `/api/cotacoes/${cotacaoId}/cenarios`, {
    token: admin, corpo: { nome: 'Unico', tipo: 'FORNECEDOR_UNICO' },
  });
  checar(b, 'fornecedor unico sem informar o fornecedor e recusado',
    cenarioUnicoSemFornecedor.status === 422);

  const cenarioUnico = await chamar('POST', `/api/cotacoes/${cotacaoId}/cenarios`, {
    token: admin, corpo: { nome: 'So fornecedor B', tipo: 'FORNECEDOR_UNICO', fornecedor_id: fornecedorIds.b },
  });
  checar(b, 'cenario de fornecedor unico criado', cenarioUnico.status === 201, cenarioUnico.corpo?.error);
  checar(b, 'fornecedor unico usa um fornecedor so',
    num(cenarioUnico.corpo?.data?.fornecedores) === 1, cenarioUnico.corpo?.data?.fornecedores);

  const cenarioDividido = await chamar('POST', `/api/cotacoes/${cotacaoId}/cenarios`, {
    token: admin, corpo: { nome: 'Compra dividida', tipo: 'COMPRA_DIVIDIDA' },
  });
  checar(b, 'cenario de compra dividida criado', cenarioDividido.status === 201, cenarioDividido.corpo?.error);
  checar(b, 'a compra dividida atende mais do que o fornecedor unico',
    num(cenarioDividido.corpo?.data?.atendimento_percentual)
      >= num(cenarioUnico.corpo?.data?.atendimento_percentual),
    { dividida: cenarioDividido.corpo?.data?.atendimento_percentual,
      unico: cenarioUnico.corpo?.data?.atendimento_percentual });

  const detalheDividido = await chamar('GET',
    `/api/cotacoes/cenarios/${cenarioDividido.corpo?.data?.id}`, { token: admin });
  const itensDividido = (detalheDividido.corpo?.data?.itens ?? [])
    .filter((i: any) => i.codigo === 'M06-DIVIDIDO');
  checar(b, 'o item de 10.000 foi dividido entre dois fornecedores', itensDividido.length === 2,
    itensDividido.length);
  checar(b, 'a soma das partes cobre a necessidade',
    quase(itensDividido.reduce((a: number, i: any) => a + num(i.quantidade), 0), 10000, 0.01),
    itensDividido.map((i: any) => i.quantidade));

  const listaCenarios = await chamar('GET', `/api/cotacoes/${cotacaoId}/cenarios`, { token: admin });
  checar(b, 'os cenarios ficam salvos para comparar',
    (listaCenarios.corpo?.data ?? []).length >= 5);

  const { rows: intactas } = await pool.query(
    'SELECT count(*)::int AS n FROM cotacao_itens WHERE cotacao_id = $1 AND selecionado', [cotacaoId]);
  checar(b, 'nenhum cenario alterou a cotacao oficial', num(intactas[0].n) === 0);

  secao('decisao do comprador (secao 64)');
  const recomendadas = (analise.corpo?.data?.produtos ?? [])
    .filter((p: any) => p.recomendada)
    .map((p: any) => ({
      cotacao_produto_id: p.cotacao_produto_id,
      cotacao_item_id: Number(p.recomendada.cotacao_item_id),
    }));

  const inelegivelSelecionada = await chamar('POST', `/api/cotacoes/${cotacaoId}/selecionar`, {
    token: admin,
    corpo: {
      selecoes: [{
        cotacao_produto_id: perecivel.cotacao_produto_id,
        cotacao_item_id: Number(propostaAPerecivel.cotacao_item_id),
      }],
      justificativa: 'tentando escolher a inelegivel',
    },
  });
  checar(b, 'proposta inelegivel nao pode ser selecionada', inelegivelSelecionada.status === 422,
    inelegivelSelecionada.corpo?.error?.message);

  // Escolhe A no produto comum, divergindo da recomendacao.
  const divergente = [{
    cotacao_produto_id: comum.cotacao_produto_id,
    cotacao_item_id: Number(propostaAComum.cotacao_item_id),
  }];
  const recomendadaComum = Number(comum.recomendada.cotacao_item_id);

  if (recomendadaComum !== Number(propostaAComum.cotacao_item_id)) {
    const semJustificativa = await chamar('POST', `/api/cotacoes/${cotacaoId}/selecionar`, {
      token: admin, corpo: { selecoes: divergente },
    });
    checar(b, 'escolha divergente sem justificativa e recusada', semJustificativa.status === 422,
      semJustificativa.corpo?.error?.message);

    const comJustificativa = await chamar('POST', `/api/cotacoes/${cotacaoId}/selecionar`, {
      token: admin,
      corpo: { selecoes: divergente, justificativa: 'Contrato anual em vigor com o fornecedor A' },
    });
    checar(b, 'escolha divergente com justificativa e aceita', comJustificativa.status === 200,
      comJustificativa.corpo?.error);
    checar(b, 'a divergencia fica registrada',
      comJustificativa.corpo?.data?.decisao_divergente === true);
  } else {
    checar(b, 'a recomendacao do item comum nao foi o fornecedor A', false,
      { recomendada: recomendadaComum });
  }

  const selecaoFinal = await chamar('POST', `/api/cotacoes/${cotacaoId}/selecionar`, {
    token: admin,
    corpo: { selecoes: recomendadas, justificativa: 'Seguindo a recomendacao do sistema' },
  });
  checar(b, 'selecao alinhada com a recomendacao e aceita', selecaoFinal.status === 200,
    selecaoFinal.corpo?.error);
  checar(b, 'sem divergencia a marca fica falsa',
    selecaoFinal.corpo?.data?.decisao_divergente === false);
  checar(b, 'o valor selecionado e somado', num(selecaoFinal.corpo?.data?.valor_selecionado) > 0);

  secao('aprovacao e encaminhamento (secoes 44, 45 e 61)');
  const encaminharSemAprovar = await chamar('POST',
    `/api/cotacoes/${cotacaoId}/encaminhar-negociacao`, { token: admin, corpo: {} });
  checar(b, 'nao da para encaminhar sem aprovar antes', encaminharSemAprovar.status === 422);

  const comprador = await tokenDoPerfil(admin, 'COMPRADOR', 'm06');
  if (comprador) {
    const compradorAprova = await chamar('POST', `/api/cotacoes/${cotacaoId}/aprovar`, {
      token: comprador, corpo: {},
    });
    checar(b, 'COMPRADOR nao tem permissao de aprovar cotacao', compradorAprova.status === 403,
      compradorAprova.status);
    const compradorPesos = await chamar('PUT', `/api/cotacoes/${cotacaoId}/criterios`, {
      token: comprador, corpo: { criterios: [{ codigo: 'CUSTO_TOTAL', peso: 100 }] },
    });
    checar(b, 'COMPRADOR nao altera os pesos', compradorPesos.status === 403);
  }

  const aprovada = await chamar('POST', `/api/cotacoes/${cotacaoId}/aprovar`, {
    token: admin, corpo: { justificativa: 'Melhor conjunto de criterios' },
  });
  checar(b, 'ADMIN aprova a cotacao', aprovada.status === 200, aprovada.corpo?.error);
  checar(b, 'status vai para aprovada para negociacao',
    aprovada.corpo?.data?.status === 'APROVADA_NEGOCIACAO');
  checar(b, 'a alcada usada fica registrada', !!aprovada.corpo?.data?.nivel_aprovacao);

  const encaminhada = await chamar('POST', `/api/cotacoes/${cotacaoId}/encaminhar-negociacao`, {
    token: admin, corpo: {},
  });
  checar(b, 'cotacao aprovada e encaminhada', encaminhada.status === 200, encaminhada.corpo?.error);
  const pacote = encaminhada.corpo?.data?.pacote;
  checar(b, 'o pacote leva os criterios utilizados', !!pacote?.criterios_utilizados);
  checar(b, 'o pacote leva os itens com preco, prazo e score',
    (pacote?.itens ?? []).every((i: any) => i.preco_unitario !== undefined && i.score !== undefined));
  checar(b, 'o pacote leva a pontuacao criterio a criterio',
    (pacote?.itens ?? []).every((i: any) => Array.isArray(i.pontuacoes)));

  const { rows: ordens } = await pool.query(`
    SELECT count(*)::int AS n FROM ordens_compra WHERE cotacao_id = $1`, [cotacaoId]);
  checar(b, 'o modulo 06 nao cria pedido de compra', num(ordens[0].n) === 0);

  secao('historico e auditoria (secoes 46 e 65)');
  const detalhada = await chamar('GET', `/api/cotacoes/${cotacaoId}`, { token: admin });
  checar(b, 'o historico da cotacao tem varios eventos',
    (detalhada.corpo?.data?.historico ?? []).length >= 5,
    detalhada.corpo?.data?.historico?.length);

  const { rows: historicoId } = await pool.query(
    'SELECT id FROM cotacao_historico WHERE cotacao_id = $1 LIMIT 1', [cotacaoId]);
  let bloqueouUpdate = false;
  try {
    await pool.query('UPDATE cotacao_historico SET justificativa = $2 WHERE id = $1',
      [historicoId[0].id, 'adulterado']);
  } catch { bloqueouUpdate = true; }
  checar(b, 'o historico da cotacao nao pode ser alterado', bloqueouUpdate);

  let bloqueouDelete = false;
  try {
    await pool.query('DELETE FROM cotacao_historico WHERE id = $1', [historicoId[0].id]);
  } catch { bloqueouDelete = true; }
  checar(b, 'o historico da cotacao nao pode ser apagado', bloqueouDelete);

  const fornecedorRespondeu = await chamar('DELETE',
    `/api/cotacoes/${cotacaoId}/fornecedores/${fornecedorIds.a}`, { token: admin });
  checar(b, 'fornecedor que ja respondeu nao pode ser removido', fornecedorRespondeu.status === 409,
    fornecedorRespondeu.status);

  const editarEncaminhada = await chamar('PUT', `/api/cotacoes/${cotacaoId}`, {
    token: admin, corpo: { observacao: 'nao deveria passar' },
  });
  checar(b, 'cotacao encaminhada nao pode ser editada', editarEncaminhada.status === 422);

  secao('dashboard e permissoes');
  const dashboard = await chamar('GET', '/api/cotacoes/dashboard', { token: admin });
  checar(b, 'dashboard responde 200', dashboard.status === 200, dashboard.corpo?.error);
  checar(b, 'dashboard traz indicadores de status',
    typeof dashboard.corpo?.data?.indicadores?.total === 'number');
  checar(b, 'dashboard traz valor total cotado',
    num(dashboard.corpo?.data?.indicadores?.valor_total_cotado) > 0);
  checar(b, 'dashboard conta produtos sem resposta',
    typeof dashboard.corpo?.data?.indicadores?.produtos_sem_resposta === 'number');

  const semToken = await chamar('GET', '/api/cotacoes/dashboard');
  checar(b, 'cotacoes sem token retorna 401', semToken.status === 401);

  const qualidade = await tokenDoPerfil(admin, 'QUALIDADE', 'm06');
  if (qualidade) {
    const leitura = await chamar('GET', `/api/cotacoes/${cotacaoId}`, { token: qualidade });
    checar(b, 'QUALIDADE consegue consultar a cotacao', leitura.status === 200, leitura.corpo?.error);
    const tentaResponder = await chamar('POST', `/api/cotacoes/${cotacaoId}/respostas`, {
      token: qualidade,
      corpo: { fornecedor_id: fornecedorIds.a, itens: [{ produto_id: produtoIds.comum, quantidade_ofertada: 1, preco_unitario: 1 }] },
    });
    checar(b, 'QUALIDADE nao registra proposta', tentaResponder.status === 403);
  }

  return b;
}

async function executar() {
  const cenario = await preparar();
  const baterias: Bateria[] = [];
  baterias.push(matematica());
  const { bateria, cotacaoId } = await fluxo(cenario);
  baterias.push(bateria);
  baterias.push(await propostas(cenario, cotacaoId));
  encerrar(baterias);
}

executar()
  .catch((erro) => {
    console.error('\nBateria interrompida:', erro);
    process.exitCode = 1;
  })
  .finally(encerrarPool);
