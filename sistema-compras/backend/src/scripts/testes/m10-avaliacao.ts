/**
 * Bateria do MODULO 10 - avaliacao de fornecedores, scorecard e plano de acao.
 *
 * Cobre as categorias da secao 65 (score, indicadores, dados insuficientes,
 * historico, plano de acao e permissoes) e os cinco cenarios obrigatorios da
 * secao 66.
 *
 * Os dados de teste usam o prefixo M10-. Os fornecedores nascem novos a cada
 * execucao: metade dos cenarios existe justamente para quem NAO tem historico,
 * e historico se acumula no banco.
 */
import { pool, encerrarPool } from '../../config/database.js';
import {
  chamar, checar, encerrar, loginAdmin, novaBateria, secao, tokenDoPerfil,
  type Bateria,
} from './base.js';
import {
  analisarTendencia, avaliarCriterio, avaliarIndicador, calcularConcentracao,
  calcularScore, estatisticas, indiceGravidade, normalizar, percentual,
  posicaoCompetitiva, validarPesos, variacaoPreco,
  type CriterioAvaliado, type IndicadorApurado, type IndicadorAvaliado,
} from '../../modules/avaliacao/calculos.js';

const num = (v: unknown) => Number(v ?? 0);
const quase = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
const hoje = new Date().toISOString().slice(0, 10);
const emDias = (d: number) =>
  new Date(Date.parse(`${hoje}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);

const LIMIARES = { parcialPercentual: 50, insuficientePercentual: 30 };
const CONFIABILIDADE = { altaEventos: 20, mediaEventos: 8 };

interface Cenario {
  marca: string;
  /** Historico completo: pedidos, entregas, recebimentos, qualidade e precos. */
  completo: number;
  /** Recem cadastrado, sem nenhum movimento. */
  novo: number;
  /** Qualidade alta e OTIF baixo (cenario 3). */
  pontual: number;
  /** Preco competitivo e muita nao conformidade (cenario 4). */
  barato: number;
  produtoA: number;
  produtoB: number;
  localId: number;
  categoriaId: number;
  /**
   * Movimentacoes de estoque existentes antes de a bateria comecar. O modulo
   * 10 e camada de leitura: este numero nao pode mudar ate o fim.
   */
  movimentacoesIniciais: number;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function preparar(): Promise<Cenario> {
  const marca = Date.now().toString().slice(-8);
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query("SELECT set_config('app.usuario_id', '1', true)");

    const { rows: cat } = await cliente.query(`
      INSERT INTO categorias (nome, descricao)
      VALUES ('M10 TESTES', 'Cenarios da bateria do modulo 10')
      ON CONFLICT (nome) DO UPDATE SET descricao = EXCLUDED.descricao RETURNING id`);
    const categoriaId = Number(cat[0].id);
    const { rows: un } = await cliente.query("SELECT id FROM unidades WHERE codigo = 'KG'");
    const unidadeId = Number(un[0].id);
    const { rows: loc } = await cliente.query(
      'SELECT id FROM locais WHERE ativo ORDER BY id LIMIT 1');
    const localId = Number(loc[0].id);

    const produto = async (codigo: string, descricao: string) => {
      const achado = (await cliente.query(
        'SELECT id FROM produtos WHERE upper(codigo) = upper($1) AND deleted_at IS NULL',
        [codigo])).rows;
      if (achado.length) {
        await cliente.query(`
          UPDATE produtos SET descricao = $2, ativo = true, categoria_id = $3,
                 controla_lote = false, controla_validade = false, exige_inspecao = false
           WHERE id = $1`, [achado[0].id, descricao, categoriaId]);
        return Number(achado[0].id);
      }
      const { rows } = await cliente.query(`
        INSERT INTO produtos (codigo, descricao, categoria_id, unidade_compra_id,
                              unidade_estoque_id, unidade_venda_id, fator_conversao,
                              ativo, lead_time_padrao_dias, classificacao_abc)
        VALUES ($1,$2,$3,$4,$4,$4,1,true,10,'A') RETURNING id`,
        [codigo, descricao, categoriaId, unidadeId]);
      return Number(rows[0].id);
    };

    const produtoA = await produto('M10-A', 'M10 produto A');
    const produtoB = await produto('M10-B', 'M10 produto B');

    for (const p of [produtoA, produtoB]) {
      const achado = (await cliente.query(
        'SELECT id FROM estoques WHERE produto_id = $1 AND local_id = $2', [p, localId])).rows;
      if (!achado.length) {
        await cliente.query(`
          INSERT INTO estoques (produto_id, local_id, quantidade_fisica, quantidade_reservada,
                                quantidade_em_transito) VALUES ($1,$2,0,0,0)`, [p, localId]);
      }
    }

    // Fornecedores novos a cada execucao: o cenario 2 exige um fornecedor
    // sem nenhum historico, e o banco acumula.
    const fornecedor = async (sufixo: string, nome: string, leadTime: number, prazo: number) => {
      const { rows } = await cliente.query(`
        INSERT INTO fornecedores (razao_social, cnpj, tipo_fornecedor, origem_fornecedor,
                                  ativo, lead_time_padrao_dias, prazo_medio_pagamento, email)
        VALUES ($1, $2, 'DISTRIBUIDOR', 'NACIONAL', true, $3, $4, 'm10@teste.local')
        RETURNING id`,
        [`M10 ${nome} ${marca}`, `10${sufixo}${marca}`.padEnd(14, '0').slice(0, 14),
          leadTime, prazo]);
      return Number(rows[0].id);
    };

    const completo = await fornecedor('1', 'Completo', 10, 30);
    const novo = await fornecedor('2', 'Novo', 10, 30);
    const pontual = await fornecedor('3', 'Qualidade Alta', 10, 30);
    const barato = await fornecedor('4', 'Preco Baixo', 10, 30);

    // Existe um indice unico de fornecedor principal por produto
    // (uq_pf_principal). Como cada execucao cria fornecedores novos, o
    // principal da execucao anterior precisa sair antes - senao o INSERT do
    // novo principal conflita. Sem o ON CONFLICT, o conflito apareceria em vez
    // de sumir em silencio.
    await cliente.query(`
      UPDATE produto_fornecedor SET fornecedor_principal = false
       WHERE produto_id = ANY($1::bigint[]) AND fornecedor_principal`,
      [[produtoA, produtoB]]);

    for (const f of [completo, pontual, barato]) {
      for (const p of [produtoA, produtoB]) {
        await cliente.query(`
          INSERT INTO produto_fornecedor
            (produto_id, fornecedor_id, preco_atual, moeda, moq, multiplo_compra,
             lead_time_dias, prazo_pagamento_dias, ativo, fornecedor_principal)
          VALUES ($1,$2,$3,'BRL',10,1,10,30,true,$4)`,
          [p, f, f === barato ? 8 : 10, f === completo]);
      }
    }

    await cliente.query('COMMIT');
    const { rows: mov } = await cliente.query(
      'SELECT count(*)::int AS total FROM movimentacoes_estoque');

    return {
      marca, completo, novo, pontual, barato, produtoA, produtoB, localId, categoriaId,
      movimentacoesIniciais: Number(mov[0].total),
    };
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }
}

/**
 * Gera historico completo direto no banco: pedido, entrega, recebimento,
 * inspecao, NC e preco. O caminho pela API ja tem bateria propria nos modulos
 * 07 a 09; repeti-lo aqui gastaria minutos sem testar nada do modulo 10.
 */
async function gerarHistorico(dados: {
  fornecedorId: number;
  produtoId: number;
  localId: number;
  quantidade: number;
  preco: number;
  /** Dias de atraso da entrega: 0 significa no prazo. */
  atraso: number;
  /** Quanto do pedido chegou de fato. */
  quantidadeEntregue: number;
  recebimentoAprovado: boolean;
  naoConformidade?: 'CRITICA' | 'ALTA' | 'MEDIA' | 'BAIXA' | null;
  diasAtras: number;
}) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query("SELECT set_config('app.usuario_id', '1', true)");

    const { rows: seq } = await cliente.query(`
      SELECT coalesce(max(nullif(regexp_replace(numero, '^.*-', ''), '')::bigint), 0) + 1
        AS proximo FROM ordens_compra WHERE numero LIKE 'M10-%'`);
    const numero = `M10-${String(seq[0].proximo).padStart(5, '0')}`;
    const emissao = emDias(-dados.diasAtras);
    const prometida = emDias(-dados.diasAtras + 10);
    const real = emDias(-dados.diasAtras + 10 + dados.atraso);
    const valor = dados.quantidade * dados.preco;

    const { rows: oc } = await cliente.query(`
      INSERT INTO ordens_compra
        (numero, fornecedor_id, data_emissao, data_necessaria, data_prometida,
         data_prometida_original, data_prevista_entrega, valor_produtos, valor_total,
         status, status_confirmacao, comprador_id, local_entrega_id, data_envio,
         aprovador_id, data_aprovacao, created_by, condicao_pagamento_id)
      VALUES ($1,$2,$3::date,$4::date,$4::date,$4::date,$4::date,$5,$5,
              'ENVIADA'::status_ordem_compra_enum,'CONFIRMADO'::status_confirmacao_enum,
              1,$6,$7::timestamptz,1,$7::timestamptz,1,
              (SELECT id FROM condicoes_pagamento WHERE ativo ORDER BY dias LIMIT 1))
      RETURNING id`,
      [numero, dados.fornecedorId, emissao, prometida, valor, dados.localId,
        `${emissao}T12:00:00Z`]);

    const { rows: item } = await cliente.query(`
      INSERT INTO ordem_compra_itens
        (ordem_compra_id, produto_id, quantidade_pedida, quantidade_pendente,
         quantidade_entregue, quantidade_recebida, preco_unitario, valor_total,
         data_necessaria, data_prometida, data_prometida_original, data_prevista_entrega,
         data_entrega_efetiva)
      VALUES ($1,$2,$3::numeric,greatest($3::numeric - $4::numeric, 0),$4::numeric,
              $4::numeric,$5,$6,$7::date,$7::date,$7::date,$7::date,
              $8::date)
      RETURNING id`,
      [oc[0].id, dados.produtoId, dados.quantidade, dados.quantidadeEntregue,
        dados.preco, valor, prometida, real]);

    const { rows: entrega } = await cliente.query(`
      INSERT INTO entregas
        (ordem_compra_id, numero, sequencia, data_prevista, data_prometida, data_real,
         data_necessaria, quantidade_prevista, quantidade_entregue, status, local_id,
         pronta_recebimento)
      VALUES ($1,$2,1,$3::date,$3::date,$4::date,$3::date,$5::numeric,$5::numeric,
              'ENTREGUE'::status_entrega_enum,$6,true)
      RETURNING id`,
      [oc[0].id, `${numero}-E1`, prometida, real, dados.quantidadeEntregue, dados.localId]);

    await cliente.query(`
      INSERT INTO entrega_itens
        (entrega_id, ordem_compra_item_id, produto_id, quantidade, quantidade_conferida,
         data_prometida, data_efetiva)
      VALUES ($1,$2,$3,$4::numeric,$4::numeric,$5::date,$6::date)`,
      [entrega[0].id, item[0].id, dados.produtoId, dados.quantidadeEntregue,
        prometida, real]);

    const { rows: seqRec } = await cliente.query(`
      SELECT coalesce(max(nullif(regexp_replace(numero, '^.*-', ''), '')::bigint), 0) + 1
        AS proximo FROM recebimentos WHERE numero LIKE 'M10R-%'`);

    const status = dados.recebimentoAprovado ? 'APROVADO' : 'REJEITADO';
    const aceita = dados.recebimentoAprovado ? dados.quantidadeEntregue : 0;
    const rejeitada = dados.recebimentoAprovado ? 0 : dados.quantidadeEntregue;

    const { rows: rec } = await cliente.query(`
      INSERT INTO recebimentos
        (numero, ordem_compra_id, entrega_id, fornecedor_id, local_id, data_recebimento,
         status, origem, quantidade_recebida, quantidade_aceita, quantidade_rejeitada,
         quantidade_quarentena, valor_recebido, data_chegada, conferencia_inicio,
         conferencia_fim, data_aprovacao, aprovador_id, responsavel_id)
      VALUES ($1,$2,$3,$4,$5,$6::date,$7::status_recebimento_enum,'ENTREGA',
              $8,$9,$10,0,$11,$12::timestamptz,$12::timestamptz,$12::timestamptz,
              $12::timestamptz,1,1)
      RETURNING id`,
      [`M10R-${String(seqRec[0].proximo).padStart(5, '0')}`, oc[0].id, entrega[0].id,
        dados.fornecedorId, dados.localId, real, status,
        dados.quantidadeEntregue, aceita, rejeitada,
        dados.quantidadeEntregue * dados.preco, `${real}T10:00:00Z`]);

    await cliente.query(`
      INSERT INTO recebimento_itens
        (recebimento_id, ordem_compra_item_id, produto_id, quantidade_pedida,
         quantidade_recebida, quantidade_conferida, quantidade_aceita, quantidade_rejeitada,
         preco_unitario, status, conferido_por, conferido_em, local_id)
      VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9::status_recebimento_item_enum,1,
              $10::timestamptz,$11)`,
      [rec[0].id, item[0].id, dados.produtoId, dados.quantidade, dados.quantidadeEntregue,
        aceita, rejeitada, dados.preco,
        dados.recebimentoAprovado ? 'ACEITO' : 'REJEITADO', `${real}T10:00:00Z`,
        dados.localId]);

    await cliente.query(`
      INSERT INTO inspecoes_qualidade
        (recebimento_id, produto_id, fornecedor_id, data_inspecao, resultado,
         quantidade_avaliada, quantidade_aprovada, responsavel_id)
      VALUES ($1,$2,$3,$4::timestamptz,$5::resultado_inspecao_enum,$6,$7,1)`,
      [rec[0].id, dados.produtoId, dados.fornecedorId, `${real}T11:00:00Z`,
        dados.recebimentoAprovado ? 'APROVADO' : 'REPROVADO',
        dados.quantidadeEntregue, aceita]);

    if (dados.naoConformidade) {
      const { rows: seqNc } = await cliente.query(`
        SELECT coalesce(max(nullif(regexp_replace(numero, '^.*-', ''), '')::bigint), 0) + 1
          AS proximo FROM nao_conformidades WHERE numero LIKE 'M10N-%'`);
      await cliente.query(`
        INSERT INTO nao_conformidades
          (numero, produto_id, fornecedor_id, recebimento_id, tipo, severidade, descricao,
           quantidade_afetada, status, created_at, created_by)
        VALUES ($1,$2,$3,$4,'QUALIDADE'::tipo_nao_conformidade_enum,
                $5::severidade_nc_enum,$6,$7,'ABERTA'::status_nao_conformidade_enum,
                $8::timestamptz,1)`,
        [`M10N-${String(seqNc[0].proximo).padStart(5, '0')}`, dados.produtoId,
          dados.fornecedorId, rec[0].id, dados.naoConformidade,
          `Nao conformidade de teste (${dados.naoConformidade})`,
          dados.quantidadeEntregue, `${real}T12:00:00Z`]);
    }

    await cliente.query(`
      INSERT INTO historico_precos
        (produto_id, fornecedor_id, data, quantidade, preco_unitario, custo_efetivo,
         moeda, ordem_compra_id, origem, usuario_id)
      VALUES ($1,$2,$3::date,$4,$5,$5,'BRL',$6,'PEDIDO',1)`,
      [dados.produtoId, dados.fornecedorId, emissao, dados.quantidade, dados.preco,
        oc[0].id]);

    await cliente.query('COMMIT');
    return { pedidoId: Number(oc[0].id), recebimentoId: Number(rec[0].id) };
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }
}

// ---------------------------------------------------------------------------
// 1. Calculos puros
// ---------------------------------------------------------------------------

function testarCalculos(): Bateria {
  const b = novaBateria('MODULO 10 - calculos');

  secao('Pesos (secoes 11 e 67 regra 4)');
  checar(b, 'pesos somando 100 sao validos',
    validarPesos([25, 25, 20, 10, 10, 5, 5]).valido);
  checar(b, 'pesos somando 95 sao recusados com a soma na mensagem',
    !validarPesos([25, 25, 20, 10, 10, 5]).valido
    && validarPesos([25, 25, 20, 10, 10, 5]).mensagem!.includes('95'));
  checar(b, 'pesos somando 105 sao recusados', !validarPesos([30, 25, 20, 10, 10, 5, 5]).valido);
  checar(b, 'peso zerado e permitido quando o resto fecha 100',
    validarPesos([30, 30, 20, 10, 10, 0, 0]).valido);
  checar(b, 'peso negativo e recusado', !validarPesos([110, -10]).valido);

  secao('Normalizacao (secao 26)');
  const maior = { direcao: 'MAIOR_MELHOR' as const, valorPior: 60, valorMelhor: 100 };
  checar(b, 'OTIF de 100% com faixa 60-100 vale nota 100',
    normalizar(100, maior).nota === 100);
  checar(b, 'OTIF de 60% vale nota 0', normalizar(60, maior).nota === 0);
  checar(b, 'OTIF de 80% vale nota 50', normalizar(80, maior).nota === 50);
  checar(b, 'valor abaixo do pior e limitado a 0', normalizar(10, maior).nota === 0);
  checar(b, 'valor acima do melhor e limitado a 100', normalizar(140, maior).nota === 100);

  const menor = { direcao: 'MENOR_MELHOR' as const, valorPior: 25, valorMelhor: 0 };
  checar(b, 'NC de 0% com faixa 25-0 vale nota 100', normalizar(0, menor).nota === 100);
  checar(b, 'NC de 25% vale nota 0', normalizar(25, menor).nota === 0);
  checar(b, 'NC de 12,5% vale nota 50', normalizar(12.5, menor).nota === 50);

  const semValor = normalizar(null, maior);
  checar(b, 'valor ausente nao vira nota zero: fica nao calculavel',
    semValor.nota === null && !semValor.calculavel, semValor);
  checar(b, 'faixa nao configurada e sinalizada, nao chutada',
    normalizar(80, { direcao: 'MAIOR_MELHOR', valorPior: null, valorMelhor: null })
      .calculavel === false);
  checar(b, 'a normalizacao devolve a formula usada', !!normalizar(80, maior).formula);

  secao('Amostra minima (secao 28)');
  const apurado = (valor: number | null, eventos: number): IndicadorApurado => ({
    codigo: 'OTIF', nome: 'OTIF', grupo: 'LOGISTICA', valor, unidade: '%',
    eventos, minimoEventos: 3, formula: 'f', fonte: 'teste',
  });
  const definicao = {
    codigo: 'OTIF', nome: 'OTIF', peso: 100, direcao: 'MAIOR_MELHOR' as const,
    valorPior: 60, valorMelhor: 100, unidade: '%', minimoEventos: 3,
  };

  const poucos = avaliarIndicador(apurado(100, 1), definicao);
  checar(b, 'OTIF de 100% com uma unica entrega NAO vira nota alta',
    poucos.nota === null && !poucos.calculavel, poucos);
  checar(b, 'a amostra insuficiente diz quantos eventos faltam',
    poucos.motivo!.includes('1 evento') && poucos.motivo!.includes('3'), poucos.motivo);
  checar(b, 'com a amostra minima o indicador e calculado',
    avaliarIndicador(apurado(100, 3), definicao).nota === 100);

  secao('Nota do criterio');
  const ind = (codigo: string, nota: number | null, peso: number, calculavel = true):
    IndicadorAvaliado => ({
    codigo, nome: codigo, grupo: 'LOGISTICA', valor: nota, unidade: '%', eventos: 10,
    minimoEventos: 1, formula: 'f', fonte: 'teste', nota, peso,
    direcao: 'MAIOR_MELHOR', calculavel, formulaNota: 'f',
  });

  const criterio = avaliarCriterio({
    grupo: 'LOGISTICA', nome: 'Logistica', peso: 25, minimoEventos: 3,
    indicadores: [ind('OTIF', 90, 40), ind('OTD', 100, 20), ind('IN_FULL', 80, 40)],
  });
  checar(b, 'nota do criterio e a media ponderada dos indicadores',
    quase(criterio.nota!, 88), criterio.nota);
  checar(b, 'a contribuicao e nota x peso / 100',
    quase(criterio.contribuicao!, 22), criterio.contribuicao);

  const comLacuna = avaliarCriterio({
    grupo: 'LOGISTICA', nome: 'Logistica', peso: 25, minimoEventos: 3,
    indicadores: [ind('OTIF', 90, 50), ind('OTD', null, 50, false)],
  });
  checar(b, 'indicador sem dados sai do denominador em vez de valer zero',
    quase(comLacuna.nota!, 90), comLacuna.nota);
  checar(b, 'o criterio avisa quantos indicadores ficaram de fora',
    comLacuna.motivo!.includes('1 indicador'), comLacuna.motivo);

  const vazio = avaliarCriterio({
    grupo: 'QUALIDADE', nome: 'Qualidade', peso: 25, minimoEventos: 3,
    indicadores: [ind('TAXA_NC', null, 100, false)],
  });
  checar(b, 'criterio sem nenhum indicador calculavel fica nao calculavel',
    vazio.nota === null && !vazio.calculavel, vazio);

  secao('Score final (secoes 26, 27 e 28)');
  const criterios = (notas: Array<[string, number | null, number]>): CriterioAvaliado[] =>
    notas.map(([grupo, nota, peso]) => ({
      grupo: grupo as any, nome: grupo, nota, peso,
      contribuicao: nota === null ? null : (nota * peso) / 100,
      calculavel: nota !== null, eventos: nota === null ? 0 : 10, minimoEventos: 3,
      indicadores: [], formula: 'f',
    }));

  // O exemplo literal da secao 27.
  const exemplo = calcularScore(criterios([
    ['LOGISTICA', 90, 25], ['QUALIDADE', 85, 25], ['COMERCIAL', 80, 20],
    ['ATENDIMENTO', 75, 10], ['PRECO', 78, 10], ['PAGAMENTO', 90, 5],
    ['FLEXIBILIDADE', 80, 5],
  ]), LIMIARES, CONFIABILIDADE);
  checar(b, 'o exemplo da secao 27 resulta em 83,55',
    quase(exemplo.score!, 83.55), exemplo.score);
  checar(b, 'com todos os criterios calculados a avaliacao e COMPLETA',
    exemplo.completude === 'COMPLETA', exemplo.completude);
  checar(b, 'a memoria do score traz os sete criterios',
    exemplo.criterios.length === 7 && exemplo.criteriosCalculados === 7);
  checar(b, 'o score sai com a formula', !!exemplo.formula);

  const parcial = calcularScore(criterios([
    ['LOGISTICA', 90, 25], ['QUALIDADE', 80, 25], ['COMERCIAL', 70, 20],
    ['ATENDIMENTO', null, 10], ['PRECO', null, 10], ['PAGAMENTO', null, 5],
    ['FLEXIBILIDADE', null, 5],
  ]), LIMIARES, CONFIABILIDADE);
  checar(b, 'faltando criterios a avaliacao vira DADOS_PARCIAIS',
    parcial.completude === 'DADOS_PARCIAIS', parcial.completude);
  checar(b, 'o score parcial e reescalado pelo peso calculavel, nao somado a seco',
    quase(parcial.score!, 80.71, 0.05), parcial.score);
  checar(b, 'somar as contribuicoes a seco daria 56,5 e puniria o fornecedor pela lacuna',
    num(parcial.score) > 56.5, parcial.score);
  checar(b, 'o peso calculado e informado', parcial.pesoCalculado === 70);

  const insuficiente = calcularScore(criterios([
    ['LOGISTICA', 90, 25], ['QUALIDADE', null, 25], ['COMERCIAL', null, 20],
    ['ATENDIMENTO', null, 10], ['PRECO', null, 10], ['PAGAMENTO', null, 5],
    ['FLEXIBILIDADE', null, 5],
  ]), LIMIARES, CONFIABILIDADE);
  checar(b, 'com 25% do peso a avaliacao e DADOS_INSUFICIENTES',
    insuficiente.completude === 'DADOS_INSUFICIENTES', insuficiente.completude);
  checar(b, 'regra 2 da secao 67: sem dados o score e NULO, nao zero',
    insuficiente.score === null, insuficiente.score);
  checar(b, 'o motivo explica por que nao houve score',
    insuficiente.motivo!.includes('%'), insuficiente.motivo);

  const semHistorico = calcularScore(criterios([
    ['LOGISTICA', null, 25], ['QUALIDADE', null, 25], ['COMERCIAL', null, 20],
    ['ATENDIMENTO', null, 10], ['PRECO', null, 10], ['PAGAMENTO', null, 5],
    ['FLEXIBILIDADE', null, 5],
  ]), LIMIARES, CONFIABILIDADE);
  checar(b, 'fornecedor sem nenhum evento fica SEM_HISTORICO',
    semHistorico.completude === 'SEM_HISTORICO', semHistorico.completude);
  checar(b, 'sem historico a confiabilidade e INSUFICIENTE',
    semHistorico.confiabilidade === 'INSUFICIENTE');

  secao('Confiabilidade (secao 29)');
  const muitos = calcularScore(criterios([['LOGISTICA', 90, 100]]),
    LIMIARES, { altaEventos: 5, mediaEventos: 2 });
  checar(b, 'muitos eventos dao confiabilidade ALTA',
    muitos.confiabilidade === 'ALTA', muitos.confiabilidade);
  const poucosEventos = calcularScore(
    [{ ...criterios([['LOGISTICA', 90, 100]])[0], eventos: 3 }],
    LIMIARES, { altaEventos: 20, mediaEventos: 8 });
  checar(b, 'poucos eventos dao confiabilidade BAIXA',
    poucosEventos.confiabilidade === 'BAIXA', poucosEventos.confiabilidade);

  secao('Indicadores brutos (secoes 18, 19, 21 e 22)');
  checar(b, 'percentual com denominador zero devolve null, nao zero',
    percentual(5, 0) === null);
  checar(b, 'percentual de 3 em 12 e 25%', percentual(3, 12) === 25);

  const v = variacaoPreco(110, 100);
  checar(b, 'variacao de 100 para 110 e +10%', quase(v.variacao!, 10), v);
  checar(b, 'preco anterior zero nao gera percentual',
    variacaoPreco(110, 0).variacao === null
    && !!variacaoPreco(110, 0).motivo);
  checar(b, 'preco anterior ausente nao gera percentual',
    variacaoPreco(110, null).variacao === null);

  const p = posicaoCompetitiva(12, 10);
  checar(b, 'preco 12 contra menor 10 e 20% acima', quase(p.posicao!, 20), p);
  checar(b, 'quem e o menor preco fica em 0%',
    posicaoCompetitiva(10, 10).posicao === 0);
  checar(b, 'sem preco comparavel nao se inventa posicao',
    posicaoCompetitiva(12, null).posicao === null);

  const gravidade = indiceGravidade(
    { CRITICA: 1, ALTA: 2, MEDIA: 0, BAIXA: 0 },
    { CRITICA: 10, ALTA: 5, MEDIA: 2, BAIXA: 1 }, 10);
  checar(b, 'uma NC critica e duas altas em 10 recebimentos dao indice 2,0',
    quase(gravidade.indice!, 2), gravidade);
  checar(b, 'a gravidade nao trata critica e baixa como iguais',
    indiceGravidade({ CRITICA: 1, ALTA: 0, MEDIA: 0, BAIXA: 0 },
      { CRITICA: 10, ALTA: 5, MEDIA: 2, BAIXA: 1 }, 10).indice !==
    indiceGravidade({ CRITICA: 0, ALTA: 0, MEDIA: 0, BAIXA: 1 },
      { CRITICA: 10, ALTA: 5, MEDIA: 2, BAIXA: 1 }, 10).indice);
  checar(b, 'sem recebimentos o indice nao e calculado',
    indiceGravidade({ CRITICA: 1, ALTA: 0, MEDIA: 0, BAIXA: 0 },
      { CRITICA: 10, ALTA: 5, MEDIA: 2, BAIXA: 1 }, 0).indice === null);

  const est = estatisticas([2, 4, 4, 4, 5, 5, 7, 9]);
  checar(b, 'estatisticas trazem media, mediana, minimo, maximo e desvio',
    est.media === 5 && est.mediana === 4.5 && est.minimo === 2 && est.maximo === 9
    && quase(est.desvio!, 2), est);
  checar(b, 'serie vazia devolve tudo nulo com amostra zero',
    estatisticas([]).media === null && estatisticas([]).amostra === 0);

  secao('Tendencia (secoes 43 e 44)');
  const piora = analisarTendencia([90, 88, 81], 5, 'MAIOR_MELHOR');
  checar(b, 'OTIF 90 -> 88 -> 81 e tendencia de PIORA',
    piora.tendencia === 'PIORA', piora);
  const melhoria = analisarTendencia([72, 80, 91], 5, 'MAIOR_MELHOR');
  checar(b, 'OTIF 72 -> 80 -> 91 e MELHORIA', melhoria.tendencia === 'MELHORIA', melhoria);
  checar(b, 'variacao pequena fica ESTAVEL',
    analisarTendencia([90, 91, 89], 5, 'MAIOR_MELHOR').tendencia === 'ESTAVEL');
  checar(b, 'um unico ponto nao permite concluir tendencia',
    analisarTendencia([90], 5).tendencia === 'SEM_DADOS');
  checar(b, 'em MENOR_MELHOR a queda e melhoria',
    analisarTendencia([20, 10, 5], 5, 'MENOR_MELHOR').tendencia === 'MELHORIA');

  secao('Concentracao (secoes 48 e 49)');
  const conc = calcularConcentracao([
    { fornecedorId: 1, fornecedor: 'A', valor: 900 },
    { fornecedorId: 2, fornecedor: 'B', valor: 100 },
  ], 70);
  checar(b, 'fornecedor A com 900 de 1000 tem 90% de participacao',
    quase(conc.participacoes[0].percentual, 90), conc.participacoes);
  checar(b, '90% acima do limite de 70% e marcado como concentrado', conc.concentrado);
  checar(b, 'dois fornecedores nao sao monoprovedor', !conc.fornecedorUnico);
  const unico = calcularConcentracao([
    { fornecedorId: 1, fornecedor: 'A', valor: 500 }], 70);
  checar(b, 'um unico fornecedor e sinalizado como monoprovedor',
    unico.fornecedorUnico && quase(unico.hhi!, 10000), unico);
  checar(b, 'sem compras no periodo a concentracao nao e calculada',
    calcularConcentracao([], 70).hhi === null);

  return b;
}

// ---------------------------------------------------------------------------
// 2. Cenarios obrigatorios da secao 66
// ---------------------------------------------------------------------------

async function testarCenarios(c: Cenario, token: string): Promise<Bateria> {
  const b = novaBateria('MODULO 10 - cenarios obrigatorios (secao 66)');

  // --- CENARIO 1: fornecedor com historico completo -------------------------
  secao('CENARIO 1 - fornecedor com historico completo');
  for (let i = 0; i < 6; i += 1) {
    await gerarHistorico({
      fornecedorId: c.completo, produtoId: i % 2 ? c.produtoA : c.produtoB,
      localId: c.localId, quantidade: 100, preco: 10,
      atraso: 0, quantidadeEntregue: 100, recebimentoAprovado: true,
      diasAtras: 70 - i * 8,
    });
  }

  const sc1 = await chamar('GET',
    `/api/fornecedores/${c.completo}/scorecard?dias=120`, { token });
  checar(b, 'o scorecard do fornecedor completo responde', sc1.status === 200, sc1.corpo);

  const r1 = sc1.corpo?.data;
  checar(b, 'CENARIO 1: a avaliacao tem score calculado',
    typeof r1?.score?.score === 'number' && r1.score.score > 0, r1?.score?.score);
  checar(b, 'CENARIO 1: a completude e COMPLETA ou DADOS_PARCIAIS',
    ['COMPLETA', 'DADOS_PARCIAIS'].includes(r1?.score?.completude), r1?.score?.completude);
  checar(b, 'a memoria do score traz os sete criterios com nota, peso e contribuicao',
    (r1?.memoria ?? []).length === 7
    && r1.memoria.every((m: any) => m.peso !== undefined && m.contribuicao !== undefined),
    r1?.memoria?.length);
  checar(b, 'os indicadores saem com formula e fonte',
    (r1?.indicadores ?? []).every((i: any) => !!i.formula && !!i.fonte));
  checar(b, 'a logistica foi calculada a partir do modulo 08',
    r1?.indicadores?.some((i: any) => i.codigo === 'OTIF'
      && String(i.fonte).includes('Modulo 08')),
    r1?.indicadores?.find((i: any) => i.codigo === 'OTIF')?.fonte);
  checar(b, 'a qualidade foi calculada a partir do modulo 09',
    r1?.indicadores?.some((i: any) => i.codigo === 'TAXA_APROVACAO'
      && String(i.fonte).includes('Modulo 09')));
  checar(b, 'entregas no prazo e integrais dao OTIF de 100%',
    quase(num(r1?.indicadores?.find((i: any) => i.codigo === 'OTIF')?.valor), 100),
    r1?.indicadores?.find((i: any) => i.codigo === 'OTIF')?.valor);
  checar(b, 'o volume comprado do periodo acompanha a avaliacao',
    num(r1?.volume?.valor) > 0, r1?.volume);

  const gravada = await chamar('POST', `/api/fornecedores/${c.completo}/avaliacoes`, {
    token, corpo: { dias: 120, frequencia: 'TRIMESTRAL', observacoes: 'Cenario 1' },
  });
  checar(b, 'CENARIO 1: a avaliacao e gravada com numero',
    gravada.status === 201 && !!gravada.corpo?.data?.avaliacao?.numero,
    gravada.corpo?.data?.avaliacao?.numero);
  const avaliacaoId = Number(gravada.corpo?.data?.avaliacao?.id);

  const detalhe = (await chamar('GET', `/api/avaliacoes-fornecedores/${avaliacaoId}`,
    { token })).corpo?.data;
  checar(b, 'o detalhe traz a tabela criterio/nota/peso/contribuicao da secao 27',
    (detalhe?.memoria_do_score?.linhas ?? []).length === 7
    && !!detalhe?.memoria_do_score?.formula, detalhe?.memoria_do_score?.formula);
  checar(b, 'o detalhe guarda os indicadores que sustentam cada nota',
    (detalhe?.indicadores ?? []).length > 0, detalhe?.indicadores?.length);
  checar(b, 'a avaliacao registra a versao da metodologia usada',
    !!detalhe?.metodologia_versao, detalhe?.metodologia_versao);

  const { rows: score } = await pool.query(
    'SELECT score_atual, ultima_avaliacao_em FROM fornecedores WHERE id = $1', [c.completo]);
  checar(b, 'o cadastro guarda o ultimo score',
    score[0].score_atual !== null, score[0]);
  const { rows: homolog } = await pool.query(
    'SELECT status_homologacao FROM fornecedores WHERE id = $1', [c.completo]);
  checar(b, 'regra 9 da secao 67: o score NAO muda o status de homologacao',
    homolog[0].status_homologacao === 'EM_HOMOLOGACAO', homolog[0]);

  // --- CENARIO 2: fornecedor novo, sem historico ----------------------------
  secao('CENARIO 2 - fornecedor novo');
  const sc2 = await chamar('GET', `/api/fornecedores/${c.novo}/scorecard?dias=120`, { token });
  const r2 = sc2.corpo?.data;
  checar(b, 'CENARIO 2: o scorecard responde mesmo sem historico',
    sc2.status === 200, sc2.corpo);
  checar(b, 'CENARIO 2: resultado SEM_HISTORICO ou DADOS_INSUFICIENTES',
    ['SEM_HISTORICO', 'DADOS_INSUFICIENTES'].includes(r2?.score?.completude),
    r2?.score?.completude);
  checar(b, 'CENARIO 2: NAO ha score artificial - o score e nulo',
    r2?.score?.score === null, r2?.score?.score);
  checar(b, 'CENARIO 2: a confiabilidade e INSUFICIENTE',
    r2?.score?.confiabilidade === 'INSUFICIENTE', r2?.score?.confiabilidade);
  checar(b, 'CENARIO 2: o motivo explica a ausencia de dados',
    !!r2?.score?.motivo, r2?.score?.motivo);
  checar(b, 'CENARIO 2: os criterios vem marcados como nao calculaveis',
    (r2?.memoria ?? []).every((m: any) => m.calculavel === false && m.nota === null));

  const gravada2 = await chamar('POST', `/api/fornecedores/${c.novo}/avaliacoes`, {
    token, corpo: { dias: 120, observacoes: 'Cenario 2 - fornecedor novo' },
  });
  checar(b, 'a avaliacao sem dados tambem e registrada, com score nulo',
    gravada2.status === 201 && gravada2.corpo?.data?.avaliacao?.score_final === null,
    gravada2.corpo?.data?.avaliacao?.score_final);

  // --- CENARIO 3: qualidade alta, OTIF baixo --------------------------------
  secao('CENARIO 3 - qualidade alta e OTIF baixo');
  for (let i = 0; i < 6; i += 1) {
    await gerarHistorico({
      fornecedorId: c.pontual, produtoId: c.produtoA, localId: c.localId,
      quantidade: 100, preco: 10,
      atraso: 12, quantidadeEntregue: 100, recebimentoAprovado: true,
      diasAtras: 70 - i * 8,
    });
  }

  const r3 = (await chamar('GET', `/api/fornecedores/${c.pontual}/scorecard?dias=120`,
    { token })).corpo?.data;
  const logistica3 = r3?.memoria?.find((m: any) => m.grupo === 'LOGISTICA');
  const qualidade3 = r3?.memoria?.find((m: any) => m.grupo === 'QUALIDADE');

  checar(b, 'CENARIO 3: logistica e qualidade aparecem SEPARADAS',
    logistica3 !== undefined && qualidade3 !== undefined);
  checar(b, 'CENARIO 3: a nota de qualidade e alta',
    num(qualidade3?.nota) >= 80, qualidade3?.nota);
  checar(b, 'CENARIO 3: a nota de logistica e baixa',
    num(logistica3?.nota) < num(qualidade3?.nota),
    { logistica: logistica3?.nota, qualidade: qualidade3?.nota });
  checar(b, 'CENARIO 3: o atraso aparece no indicador, nao so no score',
    num(r3?.indicadores?.find((i: any) => i.codigo === 'ATRASO_MEDIO')?.valor) > 0,
    r3?.indicadores?.find((i: any) => i.codigo === 'ATRASO_MEDIO')?.valor);
  checar(b, 'CENARIO 3: o OTIF caiu por causa do atraso',
    num(r3?.indicadores?.find((i: any) => i.codigo === 'OTIF')?.valor) < 100,
    r3?.indicadores?.find((i: any) => i.codigo === 'OTIF')?.valor);

  // --- CENARIO 4: preco bom, muita nao conformidade -------------------------
  secao('CENARIO 4 - preco competitivo e alta nao conformidade');
  for (let i = 0; i < 6; i += 1) {
    await gerarHistorico({
      fornecedorId: c.barato, produtoId: c.produtoA, localId: c.localId,
      quantidade: 100, preco: 7,
      atraso: 0, quantidadeEntregue: 100,
      recebimentoAprovado: i > 3,
      naoConformidade: i > 3 ? null : 'CRITICA',
      diasAtras: 70 - i * 8,
    });
  }

  const r4 = (await chamar('GET', `/api/fornecedores/${c.barato}/scorecard?dias=120`,
    { token })).corpo?.data;
  const preco4 = r4?.memoria?.find((m: any) => m.grupo === 'PRECO');
  const qualidade4 = r4?.memoria?.find((m: any) => m.grupo === 'QUALIDADE');

  checar(b, 'CENARIO 4: preco e qualidade aparecem separados',
    preco4 !== undefined && qualidade4 !== undefined);
  checar(b, 'CENARIO 4: a qualidade e ruim apesar do preco',
    num(qualidade4?.nota) < 60, qualidade4?.nota);
  checar(b, 'CENARIO 4: a taxa de NC do fornecedor e visivel',
    num(r4?.indicadores?.find((i: any) => i.codigo === 'TAXA_NC')?.valor) > 0,
    r4?.indicadores?.find((i: any) => i.codigo === 'TAXA_NC')?.valor);
  checar(b, 'CENARIO 4: o indice de gravidade registra as NCs criticas',
    num(r4?.indicadores?.find((i: any) => i.codigo === 'INDICE_GRAVIDADE_NC')?.valor) > 0,
    r4?.indicadores?.find((i: any) => i.codigo === 'INDICE_GRAVIDADE_NC')?.valor);
  checar(b, 'CENARIO 4: o preco NAO esconde o problema de qualidade no score',
    num(r4?.score?.score) < num(r1?.score?.score),
    { barato: r4?.score?.score, completo: r1?.score?.score });
  checar(b, 'CENARIO 4: o fornecedor barato tem preco melhor que o completo',
    num(r4?.indicadores?.find((i: any) => i.codigo === 'POSICAO_COMPETITIVA')?.valor)
      <= num(r1?.indicadores?.find((i: any) => i.codigo === 'POSICAO_COMPETITIVA')?.valor),
    {
      barato: r4?.indicadores?.find((i: any) => i.codigo === 'POSICAO_COMPETITIVA')?.valor,
      completo: r1?.indicadores?.find((i: any) => i.codigo === 'POSICAO_COMPETITIVA')?.valor,
    });

  // --- CENARIO 5: mudanca de pesos ------------------------------------------
  secao('CENARIO 5 - mudanca de pesos preserva o historico');
  const antes = (await chamar('GET', `/api/avaliacoes-fornecedores/${avaliacaoId}`,
    { token })).corpo?.data;
  const scoreAntes = antes?.score_final;
  const versaoAntes = antes?.metodologia_versao;

  const { rows: vigente } = await pool.query(
    "SELECT id FROM metodologias_avaliacao WHERE vigente AND escopo = 'EMPRESA'");

  const versao = `T${c.marca}`;
  const nova = await chamar('POST', `/api/metodologias-avaliacao/${vigente[0].id}/versionar`, {
    token, corpo: { versao },
  });
  checar(b, 'CENARIO 5: a nova versao e criada a partir da vigente',
    nova.status === 201, nova.corpo);
  const novaId = Number(nova.corpo?.data?.id);

  const { rows: criterios } = await pool.query(
    'SELECT grupo, peso_percentual FROM metodologia_criterios WHERE metodologia_id = $1',
    [novaId]);
  checar(b, 'a nova versao herda os sete criterios', criterios.length === 7, criterios.length);

  // Pesos novos: logistica cai para 10 e qualidade sobe para 40.
  const pesos: Record<string, number> = {
    LOGISTICA: 10, QUALIDADE: 40, COMERCIAL: 20, ATENDIMENTO: 10,
    PRECO: 10, PAGAMENTO: 5, FLEXIBILIDADE: 5,
  };
  // Os indicadores herdados sao reenviados: mudar o peso do criterio nao pode
  // custar a metodologia os indicadores que a tornam calculavel.
  const { rows: herdados } = await pool.query(`
    SELECT c.grupo, i.codigo, i.nome, i.peso_percentual, i.direcao,
           i.valor_pior, i.valor_melhor, i.unidade, i.minimo_eventos
      FROM metodologia_indicadores i
      JOIN metodologia_criterios c ON c.id = i.metodologia_criterio_id
     WHERE c.metodologia_id = $1 ORDER BY c.ordem, i.ordem`, [novaId]);

  const corpoCriterios = Object.entries(pesos).map(([grupo, peso]) => ({
    grupo, nome: grupo, peso_percentual: peso, minimo_eventos: 3,
    indicadores: herdados.filter((h: any) => h.grupo === grupo).map((h: any) => ({
      codigo: h.codigo, nome: h.nome, peso_percentual: num(h.peso_percentual),
      direcao: h.direcao, valor_pior: num(h.valor_pior), valor_melhor: num(h.valor_melhor),
      unidade: h.unidade, minimo_eventos: Number(h.minimo_eventos),
    })),
  }));

  const editada = await chamar('PUT', `/api/metodologias-avaliacao/${novaId}`, {
    token,
    corpo: {
      versao, nome: 'Metodologia com peso maior em qualidade',
      escopo: 'EMPRESA', frequencia: 'TRIMESTRAL', criterios: corpoCriterios,
    },
  });
  checar(b, 'a metodologia nao publicada aceita edicao de pesos',
    editada.status === 200, editada.corpo);

  // Criterio com peso e sem indicador nunca seria calculavel: publicar assim
  // criaria um buraco permanente no score.
  const semIndicadores = await chamar('POST', '/api/metodologias-avaliacao', {
    token,
    corpo: {
      versao: `V${c.marca}`, nome: 'Metodologia sem indicadores', escopo: 'EMPRESA',
      frequencia: 'TRIMESTRAL',
      criterios: Object.entries(pesos).map(([grupo, peso]) => ({
        grupo, nome: grupo, peso_percentual: peso, minimo_eventos: 3,
      })),
    },
  });
  const publicarVazia = await chamar(
    'POST', `/api/metodologias-avaliacao/${semIndicadores.corpo?.data?.id}/publicar`,
    { token, corpo: { vigente: false } });
  checar(b, 'nao se publica metodologia cujo criterio com peso nao tem indicador',
    publicarVazia.status >= 400
    && String(JSON.stringify(publicarVazia.corpo)).includes('indicador'),
    publicarVazia.corpo);

  const invalida = await chamar('PUT', `/api/metodologias-avaliacao/${novaId}`, {
    token,
    corpo: {
      versao, nome: 'Pesos invalidos', escopo: 'EMPRESA', frequencia: 'TRIMESTRAL',
      criterios: [
        { grupo: 'LOGISTICA', nome: 'Logistica', peso_percentual: 40, minimo_eventos: 1 },
        { grupo: 'QUALIDADE', nome: 'Qualidade', peso_percentual: 40, minimo_eventos: 1 },
      ],
    },
  });
  checar(b, 'regra 4 da secao 67: pesos que nao somam 100 sao recusados',
    invalida.status >= 400
    && String(JSON.stringify(invalida.corpo)).includes('100'), invalida.corpo);

  const publicada = await chamar('POST', `/api/metodologias-avaliacao/${novaId}/publicar`, {
    token, corpo: { vigente: true },
  });
  checar(b, 'a metodologia e publicada e passa a vigorar',
    publicada.status === 200 && publicada.corpo?.data?.vigente === true, publicada.corpo);

  const bloqueada = await chamar('PUT', `/api/metodologias-avaliacao/${novaId}`, {
    token,
    corpo: {
      versao, nome: 'Tentando mudar depois de publicada', escopo: 'EMPRESA',
      frequencia: 'TRIMESTRAL',
      criterios: Object.entries(pesos).map(([grupo, peso]) => ({
        grupo, nome: grupo, peso_percentual: peso, minimo_eventos: 3,
      })),
    },
  });
  checar(b, 'regra 8 da secao 67: metodologia publicada nao aceita alteracao',
    bloqueada.status >= 400, bloqueada.corpo);

  const depois = (await chamar('GET', `/api/avaliacoes-fornecedores/${avaliacaoId}`,
    { token })).corpo?.data;
  checar(b, 'CENARIO 5: a avaliacao antiga mantem o score original',
    depois?.score_final === scoreAntes,
    { antes: scoreAntes, depois: depois?.score_final });
  checar(b, 'CENARIO 5: a avaliacao antiga mantem a versao antiga da metodologia',
    depois?.metodologia_versao === versaoAntes,
    { antes: versaoAntes, depois: depois?.metodologia_versao });

  const novaAvaliacao = (await chamar('GET',
    `/api/fornecedores/${c.completo}/scorecard?dias=120`, { token })).corpo?.data;
  checar(b, 'CENARIO 5: a nova avaliacao usa a nova versao',
    novaAvaliacao?.metodologia?.versao === versao, novaAvaliacao?.metodologia?.versao);
  checar(b, 'CENARIO 5: com peso maior em qualidade o peso da logistica caiu para 10',
    num(novaAvaliacao?.memoria?.find((m: any) => m.grupo === 'LOGISTICA')?.peso) === 10,
    novaAvaliacao?.memoria?.find((m: any) => m.grupo === 'LOGISTICA')?.peso);
  checar(b, 'CENARIO 5: com a nova metodologia o score continua calculavel',
    typeof novaAvaliacao?.score?.score === 'number', novaAvaliacao?.score);

  // A metodologia 1.0 volta a vigorar: deixar a versao do teste vigente faria
  // a proxima execucao comecar de um estado que nenhum usuario criaria.
  const voltar = await chamar('POST',
    `/api/metodologias-avaliacao/${vigente[0].id}/publicar`, {
      token, corpo: { vigente: true },
    });
  checar(b, 'a metodologia padrao volta a vigorar ao fim do cenario',
    voltar.status === 200 && voltar.corpo?.data?.vigente === true, voltar.corpo);

  return b;
}

// ---------------------------------------------------------------------------
// 3. Plano de acao, riscos, historico e permissoes
// ---------------------------------------------------------------------------

async function testarRegras(c: Cenario, token: string): Promise<Bateria> {
  const b = novaBateria('MODULO 10 - plano de acao, riscos e permissoes');

  secao('Plano de acao (secoes 37 e 38)');
  const plano = await chamar('POST', `/api/fornecedores/${c.pontual}/plano-acao`, {
    token,
    corpo: {
      fornecedor_id: c.pontual, grupo: 'LOGISTICA', indicador: 'OTIF',
      valor_indicador: 40, meta_indicador: 90, severidade: 'ALTA',
      problema: 'OTIF abaixo do minimo por atraso recorrente de 12 dias',
      prazo: emDias(30),
      acoes: [{ acao: 'Revisar o lead time contratado com o fornecedor', prazo: emDias(15) }],
    },
  });
  checar(b, 'o plano de acao e aberto com numero',
    plano.status === 201 && !!plano.corpo?.data?.numero, plano.corpo?.data?.numero);
  const planoId = Number(plano.corpo?.data?.id);

  const pulo = await chamar('PUT', `/api/planos-acao/${planoId}`, {
    token, corpo: { status: 'ENCERRADO', resultado: 'tentando pular o fluxo' },
  });
  checar(b, 'o plano nao pula de ABERTO direto para ENCERRADO',
    pulo.status >= 400, pulo.status);

  for (const status of ['EM_ANALISE', 'ACAO_DEFINIDA', 'EM_EXECUCAO']) {
    const passo = await chamar('PUT', `/api/planos-acao/${planoId}`, {
      token, corpo: { status, causa: 'Lead time contratado menor que o praticado' },
    });
    checar(b, `o plano avanca para ${status}`, passo.status === 200, passo.corpo);
  }

  const detalhePlano = (await chamar('GET', `/api/planos-acao/${planoId}`, { token })).corpo?.data;
  checar(b, 'o plano traz a acao cadastrada na abertura',
    (detalhePlano?.acoes ?? []).length === 1, detalhePlano?.acoes?.length);
  checar(b, 'o plano traz o historico append-only de cada movimento',
    (detalhePlano?.historico ?? []).length >= 4, detalhePlano?.historico?.length);
  checar(b, 'o plano informa os proximos status possiveis',
    (detalhePlano?.proximos_status ?? []).length > 0, detalhePlano?.proximos_status);

  const comAcaoAberta = await chamar('PUT', `/api/planos-acao/${planoId}`, {
    token, corpo: { status: 'VALIDACAO' },
  });
  checar(b, 'o plano avanca para VALIDACAO', comAcaoAberta.status === 200, comAcaoAberta.corpo);

  const encerrarComPendencia = await chamar('PUT', `/api/planos-acao/${planoId}`, {
    token, corpo: { status: 'ENCERRADO', resultado: 'Fornecedor ajustou o lead time' },
  });
  checar(b, 'nao se encerra o plano com acao em aberto',
    encerrarComPendencia.status >= 400, encerrarComPendencia.corpo);

  const acaoId = detalhePlano?.acoes?.[0]?.id;
  const concluir = await chamar('POST', `/api/plano-acoes/${acaoId}/concluir`, {
    token, corpo: { status: 'ENCERRADO', resultado: 'Lead time revisado para 15 dias' },
  });
  checar(b, 'a acao e concluida com resultado', concluir.status === 200, concluir.corpo);

  const semResultado = await chamar('PUT', `/api/planos-acao/${planoId}`, {
    token, corpo: { status: 'ENCERRADO' },
  });
  checar(b, 'encerrar o plano sem descrever o resultado e recusado',
    semResultado.status >= 400, semResultado.status);

  const encerrado = await chamar('PUT', `/api/planos-acao/${planoId}`, {
    token, corpo: { status: 'ENCERRADO', resultado: 'Fornecedor ajustou o lead time' },
  });
  checar(b, 'com as acoes concluidas o plano e encerrado',
    encerrado.status === 200 && encerrado.corpo?.data?.status === 'ENCERRADO',
    encerrado.corpo?.data?.status);

  let bloqueouHistorico = false;
  try {
    await pool.query('DELETE FROM plano_acao_historico WHERE plano_id = $1', [planoId]);
  } catch {
    bloqueouHistorico = true;
  }
  checar(b, 'o historico do plano nao pode ser apagado', bloqueouHistorico);

  secao('Monitoramento, homologacao e bloqueio (secoes 39 a 41)');
  const monitorar = await chamar('POST', `/api/fornecedores/${c.pontual}/situacao`, {
    token,
    corpo: {
      status: 'EM_MONITORAMENTO',
      motivo: 'OTIF abaixo do minimo por tres periodos seguidos',
      indicadores_monitorados: ['OTIF', 'ATRASO_MEDIO'],
      prazo: emDias(90),
    },
  });
  checar(b, 'o fornecedor entra em monitoramento com motivo e prazo',
    monitorar.status === 200, monitorar.corpo);

  const { rows: statusMonitorado } = await pool.query(
    'SELECT status_homologacao FROM fornecedores WHERE id = $1', [c.pontual]);
  checar(b, 'o cadastro reflete o monitoramento',
    statusMonitorado[0].status_homologacao === 'EM_MONITORAMENTO', statusMonitorado[0]);

  const semMotivoBloqueio = await chamar('POST', `/api/fornecedores/${c.barato}/situacao`, {
    token, corpo: { status: 'BLOQUEADO', motivo: 'Nao conformidades criticas recorrentes' },
  });
  checar(b, 'bloquear sem informar o motivo do bloqueio e recusado',
    semMotivoBloqueio.status >= 400, semMotivoBloqueio.status);

  const bloquear = await chamar('POST', `/api/fornecedores/${c.barato}/situacao`, {
    token,
    corpo: {
      status: 'BLOQUEADO', motivo_bloqueio: 'NAO_CONFORMIDADE_CRITICA',
      motivo: 'Quatro nao conformidades criticas em seis recebimentos',
      evidencias: 'Recebimentos M10R do periodo',
    },
  });
  checar(b, 'o bloqueio exige e registra motivo e responsavel',
    bloquear.status === 200, bloquear.corpo);

  const situacoes = (await chamar('GET',
    `/api/fornecedores/${c.barato}/situacoes`, { token })).corpo;
  checar(b, 'o historico de situacao guarda a decisao',
    (situacoes?.data ?? []).length >= 1
    && situacoes.data[0].motivo_bloqueio === 'NAO_CONFORMIDADE_CRITICA', situacoes?.data?.[0]);

  const { rows: alertaBloqueio } = await pool.query(
    "SELECT count(*)::int AS total FROM alertas WHERE tipo = 'FORNECEDOR_BLOQUEADO' "
    + 'AND fornecedor_id = $1', [c.barato]);
  checar(b, 'o bloqueio gera alerta', alertaBloqueio[0].total > 0, alertaBloqueio[0]);

  const repetido = await chamar('POST', `/api/fornecedores/${c.barato}/situacao`, {
    token,
    corpo: {
      status: 'BLOQUEADO', motivo_bloqueio: 'NAO_CONFORMIDADE_CRITICA',
      motivo: 'Tentando bloquear de novo',
    },
  });
  checar(b, 'bloquear quem ja esta bloqueado e recusado', repetido.status >= 400,
    repetido.status);

  secao('Comparativo e riscos (secoes 31, 48, 49 e 50)');
  const comparativo = await chamar('GET',
    `/api/avaliacao/comparativo?fornecedores=${c.completo},${c.pontual},${c.barato}&dias=120`,
    { token });
  checar(b, 'o comparativo responde com os tres fornecedores',
    comparativo.status === 200 && (comparativo.corpo?.data?.fornecedores ?? []).length === 3,
    comparativo.corpo?.data?.fornecedores?.length);
  checar(b, 'o comparativo usa o mesmo periodo para todos',
    !!comparativo.corpo?.data?.periodo?.inicio);
  checar(b, 'o comparativo traz a completude de cada fornecedor',
    (comparativo.corpo?.data?.fornecedores ?? []).every((f: any) => !!f.completude));
  checar(b, 'o comparativo avisa que completudes diferentes nao sao comparaveis',
    String(comparativo.corpo?.data?.observacao ?? '').includes('completude'));

  const umSo = await chamar('GET',
    `/api/avaliacao/comparativo?fornecedores=${c.completo}&dias=120`, { token });
  checar(b, 'comparar um unico fornecedor e recusado', umSo.status >= 400, umSo.status);

  const concentracao = await chamar('GET', '/api/avaliacao/concentracao?dias=365', { token });
  checar(b, 'a concentracao de fornecimento responde',
    concentracao.status === 200 && concentracao.corpo?.data?.consolidada !== undefined,
    concentracao.status);
  checar(b, 'a concentracao traz a participacao por fornecedor',
    Array.isArray(concentracao.corpo?.data?.consolidada?.participacoes));
  checar(b, 'a concentracao informa o risco sem bloquear compra',
    String(concentracao.corpo?.data?.observacao ?? '').includes('Nao bloqueia'));

  const unico = await chamar('GET', '/api/avaliacao/fornecedor-unico', { token });
  checar(b, 'a lista de fornecedor unico responde',
    unico.status === 200 && unico.corpo?.data?.alerta === 'FORNECIMENTO MONOPROVEDOR',
    unico.corpo?.data?.alerta);

  const alternativas = await chamar('GET', `/api/produtos/${c.produtoA}/alternativas`,
    { token });
  checar(b, 'as alternativas de fornecimento do produto respondem',
    alternativas.status === 200
    && (alternativas.corpo?.data?.fornecedores ?? []).length >= 2,
    alternativas.corpo?.data?.fornecedores?.length);
  checar(b, 'as alternativas lembram que menor preco nao e decisao automatica',
    String(alternativas.corpo?.data?.observacao ?? '').includes('melhor decisao'));

  secao('Historico e evolucao (secoes 30 e 35)');
  const evolucao = await chamar('GET', `/api/fornecedores/${c.completo}/evolucao`, { token });
  checar(b, 'a evolucao do fornecedor responde com a serie',
    evolucao.status === 200 && Array.isArray(evolucao.corpo?.data?.serie),
    evolucao.corpo?.data?.pontos);

  const perfil = await chamar('GET', `/api/fornecedores/${c.completo}/perfil?dias=120`,
    { token });
  checar(b, 'o perfil traz cadastro, comercial, historico e performance',
    perfil.status === 200 && !!perfil.corpo?.data?.cadastro
    && !!perfil.corpo?.data?.comercial && !!perfil.corpo?.data?.performance,
    perfil.status);
  checar(b, 'o perfil lista os produtos fornecidos',
    (perfil.corpo?.data?.comercial?.lista_produtos ?? []).length >= 1);

  const historicoPrecos = await chamar('GET',
    `/api/avaliacao/historico-precos?fornecedor_id=${c.completo}&dias=365`, { token });
  checar(b, 'o historico de precos responde',
    historicoPrecos.status === 200
    && (historicoPrecos.corpo?.data?.registros ?? []).length > 0,
    historicoPrecos.corpo?.data?.total);

  secao('Validacao e imutabilidade da avaliacao');
  const lista = (await chamar('GET',
    `/api/avaliacoes-fornecedores?fornecedor_id=${c.completo}&limite=5`, { token })).corpo;
  const primeira = lista?.data?.[0];
  checar(b, 'a lista de avaliacoes responde com paginacao',
    Array.isArray(lista?.data) && lista?.meta?.total !== undefined, lista?.meta);

  const validada = await chamar('POST',
    `/api/avaliacoes-fornecedores/${primeira?.id}/validar`, {
      token, corpo: { observacoes: 'Validada na bateria' },
    });
  checar(b, 'a avaliacao e validada', validada.status === 200, validada.corpo);

  const revalidar = await chamar('POST',
    `/api/avaliacoes-fornecedores/${primeira?.id}/validar`, { token, corpo: {} });
  checar(b, 'validar duas vezes e recusado', revalidar.status >= 400, revalidar.status);

  let bloqueouAlteracao = false;
  try {
    await pool.query(
      'UPDATE avaliacoes_fornecedores SET score_final = 99 WHERE id = $1', [primeira?.id]);
  } catch {
    bloqueouAlteracao = true;
  }
  checar(b, 'regra 3 da secao 67: avaliacao validada nao tem score reescrito',
    bloqueouAlteracao);

  secao('Paineis e alertas (secoes 5, 42 e 69)');
  const dashboard = await chamar('GET', '/api/avaliacao/dashboard?dias=180', { token });
  checar(b, 'o painel de fornecedores responde',
    dashboard.status === 200 && !!dashboard.corpo?.data?.fornecedores, dashboard.status);
  checar(b, 'o painel separa logistica, qualidade, comercial e riscos',
    !!dashboard.corpo?.data?.logistica && !!dashboard.corpo?.data?.qualidade
    && !!dashboard.corpo?.data?.comercial && !!dashboard.corpo?.data?.riscos);
  checar(b, 'o painel conta fornecedores bloqueados e monitorados',
    num(dashboard.corpo?.data?.fornecedores?.bloqueados) >= 1
    && num(dashboard.corpo?.data?.fornecedores?.em_monitoramento) >= 1,
    dashboard.corpo?.data?.fornecedores);

  const ranking = await chamar('GET', '/api/avaliacao/ranking?dias=180&limite=20', { token });
  checar(b, 'o ranking responde e explica a regra de ordenacao',
    ranking.status === 200 && !!ranking.corpo?.data?.regra, ranking.status);

  const alertas = await chamar('GET', '/api/avaliacao/alertas', { token });
  checar(b, 'os alertas vem em lista com contagem por severidade',
    alertas.status === 200 && Array.isArray(alertas.corpo?.data?.alertas)
    && !!alertas.corpo?.data?.por_severidade, alertas.corpo?.data?.total);
  checar(b, 'os alertas informam os limites configurados',
    !!alertas.corpo?.data?.limites?.otif_minimo, alertas.corpo?.data?.limites);

  const parametros = await chamar('GET', '/api/avaliacao/parametros', { token });
  checar(b, 'os parametros trazem configuracoes e metodologias',
    parametros.status === 200
    && (parametros.corpo?.data?.configuracoes ?? []).length > 0
    && (parametros.corpo?.data?.metodologias ?? []).length > 0,
    parametros.status);

  secao('Permissoes (secao 63)');
  const semToken = await chamar('GET', '/api/avaliacao/dashboard');
  checar(b, 'sem token a API responde 401', semToken.status === 401, semToken.status);

  const tokenAdmin = token;
  const tokenComprador = await tokenDoPerfil(tokenAdmin, 'COMPRADOR', 'm10');
  if (tokenComprador) {
    const leitura = await chamar('GET', '/api/avaliacao/dashboard', { token: tokenComprador });
    checar(b, 'o COMPRADOR consulta o painel', leitura.status === 200, leitura.status);

    const avalia = await chamar('GET', `/api/fornecedores/${c.completo}/scorecard?dias=120`,
      { token: tokenComprador });
    checar(b, 'o COMPRADOR consulta o scorecard', avalia.status === 200, avalia.status);

    const metodologia = await chamar('PUT', '/api/avaliacao/parametros', {
      token: tokenComprador,
      corpo: { parametros: [{ chave: 'avaliacao.alerta_otif_minimo', valor: '1' }] },
    });
    checar(b, 'o COMPRADOR nao altera os parametros da metodologia',
      metodologia.status === 403, metodologia.status);

    const bloqueio = await chamar('POST', `/api/fornecedores/${c.completo}/situacao`, {
      token: tokenComprador,
      corpo: {
        status: 'BLOQUEADO', motivo_bloqueio: 'DECISAO_ADMINISTRATIVA',
        motivo: 'tentativa sem permissao',
      },
    });
    checar(b, 'o COMPRADOR nao bloqueia fornecedor', bloqueio.status === 403, bloqueio.status);
  } else {
    for (const t of ['painel', 'scorecard', 'parametros', 'bloqueio']) {
      checar(b, `perfil COMPRADOR disponivel para o teste de ${t}`, false);
    }
  }

  const tokenQualidade = await tokenDoPerfil(tokenAdmin, 'QUALIDADE', 'm10');
  if (tokenQualidade) {
    const planoQualidade = await chamar('POST', '/api/planos-acao', {
      token: tokenQualidade,
      corpo: {
        fornecedor_id: c.barato, grupo: 'QUALIDADE',
        problema: 'Nao conformidades criticas recorrentes no lote recebido',
        severidade: 'CRITICA',
      },
    });
    checar(b, 'o perfil QUALIDADE abre plano de acao',
      planoQualidade.status === 201, planoQualidade.corpo);

    const avaliar = await chamar('POST', `/api/fornecedores/${c.barato}/avaliacoes`, {
      token: tokenQualidade, corpo: { dias: 120 },
    });
    checar(b, 'o perfil QUALIDADE nao cria avaliacao', avaliar.status === 403, avaliar.status);
  } else {
    checar(b, 'perfil QUALIDADE disponivel para o teste de plano', false);
    checar(b, 'perfil QUALIDADE bloqueado na avaliacao', false);
  }

  const tokenDiretoria = await tokenDoPerfil(tokenAdmin, 'DIRETORIA', 'm10');
  if (tokenDiretoria) {
    const consulta = await chamar('GET', '/api/avaliacao/dashboard', { token: tokenDiretoria });
    checar(b, 'a DIRETORIA consulta o painel', consulta.status === 200, consulta.status);
    const altera = await chamar('POST', `/api/fornecedores/${c.completo}/avaliacoes`, {
      token: tokenDiretoria, corpo: { dias: 120 },
    });
    checar(b, 'a DIRETORIA nao cria avaliacao', altera.status === 403, altera.status);
  } else {
    checar(b, 'perfil DIRETORIA disponivel para consulta', false);
    checar(b, 'perfil DIRETORIA bloqueado na avaliacao', false);
  }

  secao('Fronteiras do modulo');
  const { rows: comercial } = await pool.query(`
    SELECT count(*)::int AS total FROM ordem_compra_itens oci
     JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
    WHERE oc.numero LIKE 'M10-%' AND oci.preco_unitario NOT IN (7, 10)`);
  checar(b, 'o modulo 10 nao alterou preco de item de pedido',
    comercial[0].total === 0, comercial[0]);

  const { rows: estoque } = await pool.query(
    'SELECT count(*)::int AS total FROM movimentacoes_estoque');
  checar(b, 'o modulo 10 nao movimentou estoque',
    Number(estoque[0].total) === c.movimentacoesIniciais,
    { antes: c.movimentacoesIniciais, depois: Number(estoque[0].total) });

  const { rows: auditoria } = await pool.query(`
    SELECT count(*)::int AS total FROM auditoria
     WHERE tabela IN ('avaliacoes_fornecedores', 'metodologias_avaliacao',
                      'planos_acao_fornecedor', 'situacoes_fornecedor')`);
  checar(b, 'as operacoes do modulo ficam na auditoria', auditoria[0].total > 0, auditoria[0]);

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
    baterias.push(await testarRegras(cenario, token));
  } catch (erro) {
    console.error('\nA bateria parou por erro:', erro);
    process.exitCode = 1;
  } finally {
    encerrar(baterias);
    await encerrarPool();
  }
}

void principal();
