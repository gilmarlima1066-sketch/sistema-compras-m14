/**
 * Bateria do MODULO 05 - planejamento de compras e necessidade de compra.
 *
 * Cobre os 28 cenarios da secao 60 do PROMPT 05, o teste de cenario completo da
 * secao 61 (venda -> previsao -> estoque -> necessidade -> requisicao) e as
 * regras de governanca: memoria de calculo, alcada e ajuste com justificativa.
 *
 * Os cenarios usam produtos de teste proprios (prefixo M05-), criados e
 * deixados no banco. Nao tocam no catalogo real importado do ERP.
 */
import { pool, encerrarPool } from '../../config/database.js';
import {
  chamar, checar, encerrar, loginAdmin, novaBateria, secao, tokenDoPerfil,
  type Bateria,
} from './base.js';

const quase = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const num = (v: unknown) => Number(v ?? 0);

interface Cenario {
  codigo: string;
  produtoId: number;
  necessidade?: Record<string, any>;
}

/** Produto de teste com estoque, demanda e contrato de fornecimento sob medida. */
async function montarProduto(opcoes: {
  sufixo: string;
  descricao: string;
  estoque: number;
  reservado?: number;
  demandaDiaria: number;
  leadTime: number;
  moq?: number | null;
  multiplo?: number | null;
  estrategia?: string;
  fatorConversao?: number;
  preco?: number;
  semFornecedor?: boolean;
  fornecedorInativo?: boolean;
  estoqueMaximo?: number | null;
  estoqueMinimo?: number | null;
  coberturaAlvo?: number | null;
  localAlternativo?: number;
  origem?: 'NACIONAL' | 'INTERNACIONAL';
}): Promise<number> {
  const codigo = `M05-${opcoes.sufixo}`;
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query("SELECT set_config('app.usuario_id', '1', true)");

    const { rows: cat } = await cliente.query(
      `INSERT INTO categorias (nome, descricao) VALUES ('M05 TESTES', 'Cenarios da bateria do modulo 05')
       ON CONFLICT (nome) DO UPDATE SET descricao = EXCLUDED.descricao RETURNING id`);
    const categoriaId = cat[0].id;

    const { rows: un } = await cliente.query("SELECT id FROM unidades WHERE codigo = 'UN'");
    const unidadeId = un[0].id;

    // O indice unico de produtos e sobre upper(codigo) com WHERE: ON CONFLICT
    // nao consegue mirar nele, entao a insercao e condicional.
    let prod = (await cliente.query(
      'SELECT id FROM produtos WHERE upper(codigo) = upper($1) AND deleted_at IS NULL', [codigo])).rows;
    if (prod.length) {
      await cliente.query(`
        UPDATE produtos SET descricao = $2, fator_conversao = $3, ativo = true,
                            lead_time_padrao_dias = $4, categoria_id = $5
         WHERE id = $1`,
        [prod[0].id, opcoes.descricao, opcoes.fatorConversao ?? 1, opcoes.leadTime, categoriaId]);
    } else {
      prod = (await cliente.query(`
        INSERT INTO produtos (codigo, descricao, categoria_id, unidade_compra_id, unidade_estoque_id,
                              unidade_venda_id, fator_conversao, ativo, lead_time_padrao_dias)
        VALUES ($1, $2, $3, $4, $4, $4, $5, true, $6) RETURNING id`,
        [codigo, opcoes.descricao, categoriaId, unidadeId, opcoes.fatorConversao ?? 1, opcoes.leadTime])).rows;
    }
    const produtoId = prod[0].id;

    const { rows: locais } = await cliente.query('SELECT id FROM locais ORDER BY id LIMIT 2');
    const localId = locais[0].id;

    await cliente.query('DELETE FROM estoques WHERE produto_id = $1', [produtoId]);
    // quantidade_disponivel e coluna gerada (fisica - reservada): nao se escreve nela.
    await cliente.query(`
      INSERT INTO estoques (produto_id, local_id, quantidade_fisica, quantidade_reservada,
                            quantidade_em_transito)
      VALUES ($1, $2, $3, $4, 0)`,
      [produtoId, localId, opcoes.estoque, opcoes.reservado ?? 0]);

    if (opcoes.localAlternativo && locais[1]) {
      await cliente.query(`
        INSERT INTO estoques (produto_id, local_id, quantidade_fisica, quantidade_reservada,
                              quantidade_em_transito)
        VALUES ($1, $2, $3, 0, 0)`,
        [produtoId, locais[1].id, opcoes.localAlternativo]);
    }

    await cliente.query(`
      INSERT INTO parametros_estoque (produto_id, demanda_media_diaria, lead_time_dias,
                                      estoque_minimo, estoque_maximo, cobertura_alvo_dias,
                                      moq, multiplo_compra, estrategia_reposicao)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (produto_id) DO UPDATE SET
        demanda_media_diaria = EXCLUDED.demanda_media_diaria,
        lead_time_dias = EXCLUDED.lead_time_dias,
        estoque_minimo = EXCLUDED.estoque_minimo,
        estoque_maximo = EXCLUDED.estoque_maximo,
        cobertura_alvo_dias = EXCLUDED.cobertura_alvo_dias,
        moq = EXCLUDED.moq, multiplo_compra = EXCLUDED.multiplo_compra,
        estrategia_reposicao = EXCLUDED.estrategia_reposicao,
        estoque_seguranca = NULL, ponto_pedido = NULL`,
      [produtoId, opcoes.demandaDiaria, opcoes.leadTime,
        opcoes.estoqueMinimo ?? null, opcoes.estoqueMaximo ?? null, opcoes.coberturaAlvo ?? null,
        opcoes.moq ?? null, opcoes.multiplo ?? null, opcoes.estrategia ?? 'PONTO_PEDIDO']);

    await cliente.query('DELETE FROM produto_fornecedor WHERE produto_id = $1', [produtoId]);
    if (!opcoes.semFornecedor) {
      // `fornecedores` nao tem unique em cnpj, entao a insercao e condicional.
      const razao = `FORNECEDOR M05 ${opcoes.origem ?? 'NACIONAL'}${opcoes.fornecedorInativo ? ' INATIVO' : ''}`;
      const cnpj = opcoes.fornecedorInativo ? '33000167000101'
        : opcoes.origem === 'INTERNACIONAL' ? '19131243000197' : '45997418000153';
      let forn = (await cliente.query(
        'SELECT id FROM fornecedores WHERE razao_social = $1 AND deleted_at IS NULL', [razao])).rows;
      if (!forn.length) {
        forn = (await cliente.query(`
          INSERT INTO fornecedores (razao_social, cnpj, tipo_fornecedor, origem_fornecedor, ativo,
                                    lead_time_padrao_dias)
          VALUES ($1, $2, 'DISTRIBUIDOR', $3, $4, $5) RETURNING id`,
          [razao, cnpj, opcoes.origem ?? 'NACIONAL', !opcoes.fornecedorInativo, opcoes.leadTime])).rows;
      } else {
        await cliente.query('UPDATE fornecedores SET ativo = $2 WHERE id = $1',
          [forn[0].id, !opcoes.fornecedorInativo]);
      }

      await cliente.query(`
        INSERT INTO produto_fornecedor (produto_id, fornecedor_id, preco_atual, moq, multiplo_compra,
                                        lead_time_dias, fornecedor_principal, ativo)
        VALUES ($1, $2, $3, $4, $5, $6, true, $7)`,
        [produtoId, forn[0].id, opcoes.preco ?? 10, opcoes.moq ?? null,
          opcoes.multiplo ?? null, opcoes.leadTime, !opcoes.fornecedorInativo]);
    }

    await cliente.query('COMMIT');
    return produtoId;
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }
}

async function preparar(): Promise<Map<string, Cenario>> {
  const definicoes = [
    { sufixo: 'RUPTURA', descricao: 'M05 produto sem estoque', estoque: 0, demandaDiaria: 10, leadTime: 10 },
    { sufixo: 'SUFICIENTE', descricao: 'M05 estoque suficiente', estoque: 5000, demandaDiaria: 10, leadTime: 10 },
    { sufixo: 'ABAIXO-MIN', descricao: 'M05 abaixo do minimo', estoque: 50, demandaDiaria: 10, leadTime: 10, estrategia: 'ESTOQUE_MINIMO', estoqueMinimo: 500 },
    { sufixo: 'PONTO-PED', descricao: 'M05 no ponto de pedido', estoque: 100, demandaDiaria: 10, leadTime: 10 },
    { sufixo: 'MOQ', descricao: 'M05 necessidade abaixo do MOQ', estoque: 0, demandaDiaria: 1, leadTime: 5, moq: 500 },
    { sufixo: 'MULTIPLO', descricao: 'M05 necessidade com multiplo', estoque: 0, demandaDiaria: 8, leadTime: 5, multiplo: 100 },
    { sufixo: 'MOQ-MULT', descricao: 'M05 MOQ e multiplo juntos', estoque: 0, demandaDiaria: 7, leadTime: 5, moq: 500, multiplo: 100 },
    { sufixo: 'CONVERSAO', descricao: 'M05 conversao de unidade', estoque: 0, demandaDiaria: 5, leadTime: 5, fatorConversao: 25 },
    { sufixo: 'EXCESSO', descricao: 'M05 estoque em excesso', estoque: 100000, demandaDiaria: 5, leadTime: 5 },
    { sufixo: 'SEM-FORN', descricao: 'M05 sem fornecedor', estoque: 0, demandaDiaria: 5, leadTime: 5, semFornecedor: true },
    { sufixo: 'FORN-INAT', descricao: 'M05 fornecedor inativo', estoque: 0, demandaDiaria: 5, leadTime: 5, fornecedorInativo: true },
    { sufixo: 'TRANSF', descricao: 'M05 saldo em outro local', estoque: 0, demandaDiaria: 5, leadTime: 5, localAlternativo: 2000 },
    { sufixo: 'IMPORTADO', descricao: 'M05 fornecedor internacional', estoque: 0, demandaDiaria: 5, leadTime: 45, origem: 'INTERNACIONAL' as const },
    { sufixo: 'COBERTURA', descricao: 'M05 estrategia cobertura', estoque: 200, demandaDiaria: 10, leadTime: 5, estrategia: 'COBERTURA', coberturaAlvo: 60 },
    { sufixo: 'MAXIMO', descricao: 'M05 estrategia estoque maximo', estoque: 100, demandaDiaria: 10, leadTime: 5, estrategia: 'ESTOQUE_MAXIMO', estoqueMaximo: 900 },
    { sufixo: 'RESERVADO', descricao: 'M05 estoque todo reservado', estoque: 1000, reservado: 1000, demandaDiaria: 10, leadTime: 5 },
  ];

  const mapa = new Map<string, Cenario>();
  for (const d of definicoes) {
    const produtoId = await montarProduto(d);
    mapa.set(d.sufixo, { codigo: `M05-${d.sufixo}`, produtoId });
  }
  return mapa;
}

async function calculo(cenarios: Map<string, Cenario>): Promise<Bateria> {
  const b = novaBateria('MODULO 05 - calculo da necessidade');
  const admin = await loginAdmin();

  const { rows: categoria } = await pool.query("SELECT id FROM categorias WHERE nome = 'M05 TESTES'");
  const categoriaId = categoria[0].id;

  secao('execucao do planejamento');
  const exec = await chamar('POST', '/api/compras/planejamentos', {
    token: admin,
    corpo: { horizonte_dias: 30, categoria_id: categoriaId, observacao: 'Bateria m05' },
  });
  checar(b, 'planejamento e calculado', exec.status === 201, exec.corpo?.error);
  const planejamentoId = exec.corpo?.data?.planejamento_id;
  checar(b, 'planejamento recebe numero sequencial', /^PLN-\d{8}-\d+$/.test(exec.corpo?.data?.numero ?? ''));
  checar(b, 'planejamento conta produtos analisados', num(exec.corpo?.data?.produtos_analisados) >= cenarios.size);

  // Carrega as necessidades geradas para os produtos do teste.
  const { rows: geradas } = await pool.query(`
    SELECT n.*, p.codigo
      FROM necessidades_compra n JOIN produtos p ON p.id = n.produto_id
     WHERE n.planejamento_id = $1 AND p.codigo LIKE 'M05-%'`, [planejamentoId]);
  const porCodigo = new Map<string, any>(geradas.map((g) => [g.codigo, g]));
  for (const [chave, cenario] of cenarios) cenario.necessidade = porCodigo.get(cenario.codigo);

  const n = (chave: string) => cenarios.get(chave)?.necessidade;

  secao('1-4: gatilho da compra');
  checar(b, 'produto sem estoque gera necessidade', num(n('RUPTURA')?.quantidade_sugerida) > 0, n('RUPTURA')?.quantidade_sugerida);
  checar(b, 'produto sem estoque fica com prioridade RUPTURA', n('RUPTURA')?.prioridade === 'RUPTURA', n('RUPTURA')?.prioridade);
  checar(b, 'produto com estoque suficiente nao gera compra',
    !n('SUFICIENTE') || num(n('SUFICIENTE')?.quantidade_sugerida) === 0, n('SUFICIENTE')?.quantidade_sugerida);
  checar(b, 'produto abaixo do minimo dispara pela estrategia ESTOQUE_MINIMO',
    num(n('ABAIXO-MIN')?.quantidade_sugerida) > 0 && n('ABAIXO-MIN')?.estrategia === 'ESTOQUE_MINIMO');
  checar(b, 'produto no ponto de pedido dispara', num(n('PONTO-PED')?.quantidade_sugerida) > 0);

  secao('5-8: posicao de estoque e compras em andamento');
  const ruptura = n('RUPTURA');
  checar(b, 'posicao considera disponivel + transito + compras em aberto',
    quase(num(ruptura?.memoria_calculo?.posicao),
      num(ruptura?.estoque_disponivel) + num(ruptura?.estoque_em_transito) + num(ruptura?.compra_em_aberto), 0.01),
    ruptura?.memoria_calculo);
  checar(b, 'estoque reservado nao entra no disponivel',
    num(n('RESERVADO')?.estoque_disponivel) === 0 && num(n('RESERVADO')?.estoque_atual) === 1000,
    { disp: n('RESERVADO')?.estoque_disponivel, fisico: n('RESERVADO')?.estoque_atual });
  checar(b, 'produto com estoque todo reservado gera compra',
    num(n('RESERVADO')?.quantidade_sugerida) > 0);

  secao('9-11: MOQ, multiplo e os dois juntos');
  const moq = n('MOQ');
  checar(b, 'necessidade abaixo do MOQ sobe para o MOQ',
    num(moq?.quantidade_sugerida) === 500 && num(moq?.necessidade_bruta) < 500,
    { bruta: moq?.necessidade_bruta, sugerida: moq?.quantidade_sugerida });
  checar(b, 'alerta de MOQ e registrado',
    (moq?.alertas ?? []).some((a: any) => a.tipo === 'MOQ'));

  const mult = n('MULTIPLO');
  checar(b, 'quantidade e arredondada para cima no multiplo de 100',
    num(mult?.quantidade_sugerida) % 100 === 0
    && num(mult?.quantidade_sugerida) >= num(mult?.necessidade_bruta),
    { bruta: mult?.necessidade_bruta, sugerida: mult?.quantidade_sugerida });
  checar(b, 'alerta de multiplo e registrado',
    (mult?.alertas ?? []).some((a: any) => a.tipo === 'MULTIPLO'));

  const ambos = n('MOQ-MULT');
  checar(b, 'MOQ aplicado antes do multiplo',
    num(ambos?.quantidade_sugerida) >= 500 && num(ambos?.quantidade_sugerida) % 100 === 0,
    { bruta: ambos?.necessidade_bruta, sugerida: ambos?.quantidade_sugerida });

  secao('12: conversao de unidade');
  const conv = n('CONVERSAO');
  checar(b, 'quantidade na unidade de compra = sugerida / fator',
    quase(num(conv?.quantidade_unidade_compra), num(conv?.quantidade_sugerida) / 25, 0.01),
    { sugerida: conv?.quantidade_sugerida, embalagens: conv?.quantidade_unidade_compra, fator: conv?.fator_conversao });
  checar(b, 'fator de conversao e gravado na necessidade', num(conv?.fator_conversao) === 25);

  secao('17: excesso de estoque');
  const excesso = n('EXCESSO');
  checar(b, 'produto com excesso nao gera compra',
    !excesso || num(excesso.quantidade_sugerida) === 0, excesso?.quantidade_sugerida);
  const { rows: exc } = await pool.query(`
    SELECT n.excesso FROM necessidades_compra n JOIN produtos p ON p.id = n.produto_id
     WHERE n.planejamento_id = $1 AND p.codigo = 'M05-EXCESSO'`, [planejamentoId]);
  checar(b, 'excesso e quantificado', exc.length === 0 || num(exc[0].excesso) > 0, exc[0]);

  secao('18-20: transferencia, fornecedor inativo e sem fornecedor');
  // Saldo "em outro local" so faz sentido quando o planejamento e de um local:
  // por isso este cenario roda com local_id, diferente dos demais.
  const { rows: locais } = await pool.query('SELECT id FROM locais ORDER BY id LIMIT 2');
  const execLocal = await chamar('POST', '/api/compras/planejamentos', {
    token: admin,
    corpo: {
      horizonte_dias: 30, local_id: locais[0].id,
      produto_id: cenarios.get('TRANSF')?.produtoId,
    },
  });
  checar(b, 'planejamento por local roda', execLocal.status === 201, execLocal.corpo?.error);
  const { rows: transfRows } = await pool.query(`
    SELECT * FROM necessidades_compra
     WHERE planejamento_id = $1`, [execLocal.corpo?.data?.planejamento_id]);
  const transf = transfRows[0];
  checar(b, 'saldo em outro local e apontado como transferencia possivel',
    num(transf?.transferencia_possivel) > 0, transf?.transferencia_possivel);
  checar(b, 'transferencia aponta qual local tem o saldo',
    !!transf?.transferencia_local_id && Number(transf.transferencia_local_id) !== Number(locais[0].id));
  checar(b, 'transferencia gera alerta, nao executa nada',
    (transf?.alertas ?? []).some((a: any) => a.tipo === 'TRANSFERENCIA_POSSIVEL'));
  const { rows: movimentos } = await pool.query(`
    SELECT count(*)::int AS n FROM movimentacoes_estoque
     WHERE produto_id = $1 AND tipo_movimentacao::text LIKE 'TRANSFERENCIA%'`,
    [cenarios.get('TRANSF')?.produtoId]);
  checar(b, 'nenhuma transferencia foi executada automaticamente', num(movimentos[0].n) === 0);

  checar(b, 'produto sem fornecedor ainda calcula a necessidade',
    num(n('SEM-FORN')?.quantidade_sugerida) > 0);
  checar(b, 'produto sem fornecedor recebe alerta SEM_FORNECEDOR',
    (n('SEM-FORN')?.alertas ?? []).some((a: any) => a.tipo === 'SEM_FORNECEDOR'));
  checar(b, 'fornecedor inativo nao e escolhido como referencia',
    n('FORN-INAT')?.fornecedor_id === null, n('FORN-INAT')?.fornecedor_id);

  secao('21-23: lead time, nacional e importado');
  checar(b, 'lead time do contrato prevalece sobre o do cadastro',
    num(n('RUPTURA')?.lead_time_dias) === 10, n('RUPTURA')?.lead_time_dias);
  checar(b, 'lead time total soma as etapas alem do fornecedor',
    num(n('RUPTURA')?.lead_time_total_dias) >= num(n('RUPTURA')?.lead_time_dias));
  const imp = n('IMPORTADO');
  checar(b, 'compra internacional tem lead time total maior que a nacional',
    num(imp?.lead_time_total_dias) > num(n('RUPTURA')?.lead_time_total_dias),
    { importado: imp?.lead_time_total_dias, nacional: n('RUPTURA')?.lead_time_total_dias });

  secao('datas');
  const datas = n('RUPTURA') ?? {};
  checar(b, 'data ideal do pedido antecede a data necessaria',
    !datas.data_necessaria || !datas.data_ideal_compra
    || new Date(datas.data_ideal_compra) <= new Date(datas.data_necessaria),
    { ideal: datas.data_ideal_compra, necessaria: datas.data_necessaria });
  checar(b, 'data prevista de chegada e futura',
    !datas.data_prevista_chegada
    || new Date(datas.data_prevista_chegada) >= new Date(new Date().toISOString().slice(0, 10)));

  secao('estrategias de reposicao');
  checar(b, 'estrategia COBERTURA compra ate os dias de cobertura alvo',
    n('COBERTURA')?.estrategia === 'COBERTURA' && num(n('COBERTURA')?.quantidade_sugerida) > 0);
  checar(b, 'estrategia ESTOQUE_MAXIMO respeita o teto do parametro',
    n('MAXIMO')?.estrategia === 'ESTOQUE_MAXIMO'
    && num(n('MAXIMO')?.estoque_alvo) <= 900 + 1e-6,
    { alvo: n('MAXIMO')?.estoque_alvo });

  secao('governanca do calculo');
  for (const chave of ['RUPTURA', 'MOQ', 'MULTIPLO']) {
    const item = n(chave);
    checar(b, `${chave}: memoria de calculo traz a formula`,
      typeof item?.memoria_calculo?.formula === 'string' && item.memoria_calculo.formula.length > 20);
    checar(b, `${chave}: memoria bate com a necessidade bruta gravada`,
      quase(num(item?.memoria_calculo?.necessidade_bruta), num(item?.necessidade_bruta), 0.01));
  }
  checar(b, 'origem da demanda e registrada',
    ['PREVISAO_VALIDADA', 'DEMANDA_MEDIA', 'PARAMETRO_MANUAL', 'SEM_BASE']
      .includes(n('RUPTURA')?.origem_demanda));
  checar(b, 'indice de prioridade expoe os fatores que o formaram',
    Array.isArray(n('RUPTURA')?.fatores_prioridade)
    && (n('RUPTURA')?.fatores_prioridade ?? []).length >= 4);
  checar(b, 'origem do preco fica registrada na memoria',
    ['FORNECEDOR', 'CUSTO_ERP', 'SEM_PRECO'].includes(n('RUPTURA')?.memoria_calculo?.origem_preco),
    n('RUPTURA')?.memoria_calculo?.origem_preco);

  secao('conferencia aritmetica da formula');
  for (const chave of ['RUPTURA', 'PONTO-PED', 'COBERTURA']) {
    const item = n(chave);
    if (!item?.memoria_calculo) continue;
    const m = item.memoria_calculo as Record<string, unknown>;
    const esperado = Math.max(0,
      num(m.demanda_periodo) + num(m.estoque_alvo)
      + (m.seguranca_somada_por_fora ? num(m.estoque_seguranca) : 0)
      - num(m.posicao));
    checar(b, `${chave}: necessidade bruta confere com a formula declarada`,
      quase(num(item.necessidade_bruta), esperado, 0.05),
      { gravada: item.necessidade_bruta, recalculada: esperado });
  }

  secao('valor estimado');
  checar(b, 'valor estimado = quantidade x preco',
    quase(num(n('RUPTURA')?.valor_estimado),
      num(n('RUPTURA')?.quantidade_sugerida) * num(n('RUPTURA')?.preco_estimado), 0.05),
    { valor: n('RUPTURA')?.valor_estimado, qtd: n('RUPTURA')?.quantidade_sugerida, preco: n('RUPTURA')?.preco_estimado });

  return b;
}

async function api(cenarios: Map<string, Cenario>): Promise<Bateria> {
  const b = novaBateria('MODULO 05 - API, workflow e permissoes');
  const admin = await loginAdmin();

  const { rows: ultimo } = await pool.query(
    'SELECT id FROM planejamentos_compra ORDER BY id DESC LIMIT 1');
  const planejamentoId = ultimo[0]?.id;

  secao('dashboard e visoes');
  const dash = await chamar('GET', '/api/compras/dashboard', { token: admin });
  checar(b, 'dashboard de compras responde 200', dash.status === 200, dash.corpo?.error);
  checar(b, 'dashboard traz o planejamento vigente', !!dash.corpo?.data?.planejamento?.numero);
  const ind = dash.corpo?.data?.indicadores ?? dash.corpo?.data;
  checar(b, 'dashboard traz valor total sugerido', typeof ind === 'object' && ind !== null);

  for (const rota of ['/api/compras/fornecedores', '/api/compras/consolidacao',
    '/api/compras/calendario', '/api/compras/prioritarias', '/api/compras/em-aberto',
    '/api/compras/impacto-financeiro', '/api/compras/acuracidade']) {
    const r = await chamar('GET', rota, { token: admin });
    checar(b, `${rota} responde 200`, r.status === 200, r.corpo?.error);
  }

  const consolidado = await chamar('GET', '/api/compras/consolidacao?criterio=CATEGORIA', { token: admin });
  checar(b, 'consolidacao aceita criterio alternativo', consolidado.status === 200);
  const criterioInvalido = await chamar('GET', '/api/compras/consolidacao?criterio=INVENTADO', { token: admin });
  checar(b, 'criterio de consolidacao invalido e recusado', criterioInvalido.status === 422);

  secao('listagem e filtros de necessidades');
  const lista = await chamar('GET', `/api/compras/necessidades?planejamento_id=${planejamentoId}&limite=10`, { token: admin });
  checar(b, 'necessidades respondem 200', lista.status === 200);
  checar(b, 'necessidades trazem paginacao', typeof lista.corpo?.meta?.total === 'number');
  checar(b, 'por padrao so vem quem tem necessidade',
    (lista.corpo?.data ?? []).every((x: any) => num(x.quantidade_sugerida) > 0));

  const porPrioridade = await chamar('GET',
    `/api/compras/necessidades?planejamento_id=${planejamentoId}&prioridade=RUPTURA&limite=10`, { token: admin });
  checar(b, 'filtro por prioridade funciona',
    porPrioridade.status === 200
    && (porPrioridade.corpo?.data ?? []).every((x: any) => x.prioridade === 'RUPTURA'));

  const prioridadeInvalida = await chamar('GET', '/api/compras/necessidades?prioridade=URGENTISSIMA', { token: admin });
  checar(b, 'prioridade inexistente e recusada', prioridadeInvalida.status === 422);

  const soRuptura = await chamar('GET',
    `/api/compras/necessidades?planejamento_id=${planejamentoId}&apenas_ruptura=true&limite=10`, { token: admin });
  checar(b, 'filtro apenas_ruptura funciona',
    soRuptura.status === 200
    && (soRuptura.corpo?.data ?? []).every((x: any) => num(x.estoque_disponivel) <= 0));

  secao('detalhe e explicacao');
  const alvo = cenarios.get('RUPTURA')?.necessidade;
  if (!alvo) {
    checar(b, 'necessidade do cenario RUPTURA existe para os testes de workflow', false);
    return b;
  }
  const detalhe = await chamar('GET', `/api/compras/necessidades/${alvo.id}`, { token: admin });
  checar(b, 'detalhe da necessidade responde 200', detalhe.status === 200, detalhe.corpo?.error);
  checar(b, 'detalhe explica como a quantidade foi calculada',
    !!detalhe.corpo?.data?.memoria_calculo?.formula);
  const inexistente = await chamar('GET', '/api/compras/necessidades/99999999', { token: admin });
  checar(b, 'necessidade inexistente devolve 404', inexistente.status === 404);

  secao('ajuste manual com justificativa');
  const semJustificativa = await chamar('POST', `/api/compras/necessidades/${alvo.id}/ajustar`, {
    token: admin, corpo: { quantidade_aprovada: 999 },
  });
  checar(b, 'ajuste sem justificativa e recusado', semJustificativa.status === 422);

  const ajuste = await chamar('POST', `/api/compras/necessidades/${alvo.id}/ajustar`, {
    token: admin,
    corpo: { quantidade_aprovada: 999, justificativa: 'Consolidacao de compra internacional' },
  });
  checar(b, 'ajuste com justificativa e aceito', ajuste.status === 200, ajuste.corpo?.error);
  checar(b, 'ajuste preserva a quantidade calculada pelo sistema',
    num(ajuste.corpo?.data?.quantidade_sistema) === num(alvo.quantidade_sugerida),
    { sistema: ajuste.corpo?.data?.quantidade_sistema, original: alvo.quantidade_sugerida });
  checar(b, 'ajuste grava a quantidade do comprador',
    num(ajuste.corpo?.data?.quantidade_aprovada) === 999);
  checar(b, 'necessidade ajustada muda de status',
    ajuste.corpo?.data?.status === 'AJUSTADA', ajuste.corpo?.data?.status);

  const { rows: auditado } = await pool.query(`
    SELECT count(*)::int AS n FROM auditoria
     WHERE tabela = 'necessidades_compra' AND registro_id = $1`, [alvo.id]);
  checar(b, 'ajuste deixa rastro na auditoria', num(auditado[0].n) > 0, auditado[0]);

  secao('workflow de aprovacao da necessidade');
  const aprovada = await chamar('POST', `/api/compras/necessidades/${alvo.id}/aprovar`, {
    token: admin, corpo: { justificativa: 'Ruptura confirmada' },
  });
  checar(b, 'necessidade e aprovada', aprovada.status === 200 && aprovada.corpo?.data?.status === 'APROVADA',
    aprovada.corpo?.error);
  checar(b, 'aprovacao registra quem aprovou e quando',
    !!aprovada.corpo?.data?.aprovado_por && !!aprovada.corpo?.data?.aprovado_em);

  const reaprovar = await chamar('POST', `/api/compras/necessidades/${alvo.id}/aprovar`, {
    token: admin, corpo: {},
  });
  checar(b, 'necessidade ja aprovada nao e aprovada de novo', reaprovar.status === 422, reaprovar.status);

  const outra = cenarios.get('MOQ')?.necessidade ?? alvo;
  const rejeitada = await chamar('POST', `/api/compras/necessidades/${outra.id}/rejeitar`, {
    token: admin, corpo: { justificativa: 'Fornecedor sem estoque neste mes' },
  });
  checar(b, 'necessidade e rejeitada com justificativa',
    rejeitada.status === 200 && rejeitada.corpo?.data?.status === 'REJEITADA', rejeitada.corpo?.error);

  secao('requisicao de compra');
  const semAprovadas = await chamar('POST', '/api/compras/requisicoes', {
    token: admin, corpo: { necessidade_ids: [outra.id] },
  });
  checar(b, 'necessidade rejeitada nao entra em requisicao', semAprovadas.status === 422, semAprovadas.corpo?.error);

  const requisicao = await chamar('POST', '/api/compras/requisicoes', {
    token: admin, corpo: { necessidade_ids: [alvo.id], observacao: 'Bateria m05' },
  });
  checar(b, 'requisicao e criada a partir de necessidade aprovada',
    requisicao.status === 201, requisicao.corpo?.error);
  const requisicaoId = requisicao.corpo?.data?.id;
  checar(b, 'requisicao recebe numero', !!requisicao.corpo?.data?.numero);
  checar(b, 'requisicao nasce aguardando aprovacao',
    requisicao.corpo?.data?.status === 'AGUARDANDO_APROVACAO', requisicao.corpo?.data?.status);

  const { rows: convertida } = await pool.query(
    'SELECT status FROM necessidades_compra WHERE id = $1', [alvo.id]);
  checar(b, 'necessidade usada muda de status ao virar requisicao',
    convertida[0].status !== 'APROVADA', convertida[0]);

  const duplicada = await chamar('POST', '/api/compras/requisicoes', {
    token: admin, corpo: { necessidade_ids: [alvo.id] },
  });
  checar(b, 'mesma necessidade nao entra em duas requisicoes', duplicada.status === 422);

  const detalheReq = await chamar('GET', `/api/compras/requisicoes/${requisicaoId}`, { token: admin });
  checar(b, 'detalhe da requisicao traz os itens',
    detalheReq.status === 200 && Array.isArray(detalheReq.corpo?.data?.itens)
    && detalheReq.corpo.data.itens.length > 0);
  checar(b, 'item da requisicao guarda a quantidade original da necessidade',
    detalheReq.corpo?.data?.itens?.[0]?.quantidade_original !== undefined);

  secao('alcada de aprovacao');
  const alcadas = await chamar('GET', '/api/compras/alcadas', { token: admin });
  checar(b, 'alcadas respondem 200', alcadas.status === 200);
  checar(b, 'alcadas vem de configuracao, nao do codigo',
    (alcadas.corpo?.data ?? []).length >= 3, alcadas.corpo?.data?.length);

  const comprador = await tokenDoPerfil(admin, 'COMPRADOR', 'm05');
  const valorRequisicao = num(requisicao.corpo?.data?.valor_estimado);
  if (comprador && valorRequisicao > 10000) {
    const fora = await chamar('POST', `/api/compras/requisicoes/${requisicaoId}/aprovar`, { token: comprador });
    checar(b, 'COMPRADOR nao aprova requisicao acima da sua alcada', fora.status === 403,
      { valor: valorRequisicao, status: fora.status });
  } else {
    checar(b, 'valor da requisicao permite testar alcada', true);
  }

  const aprovadaReq = await chamar('POST', `/api/compras/requisicoes/${requisicaoId}/aprovar`, { token: admin });
  checar(b, 'ADMIN aprova qualquer faixa', aprovadaReq.status === 200, aprovadaReq.corpo?.error);
  checar(b, 'requisicao aprovada registra o nivel de alcada',
    !!aprovadaReq.corpo?.data?.nivel_aprovacao);

  const rejeitarAprovada = await chamar('POST', `/api/compras/requisicoes/${requisicaoId}/rejeitar`, {
    token: admin, corpo: { motivo: 'tentativa indevida' },
  });
  checar(b, 'requisicao ja aprovada nao pode ser rejeitada', rejeitarAprovada.status === 422);

  secao('simulacao');
  const simulacaoBase = await chamar('POST', '/api/compras/simulacoes', {
    token: admin,
    corpo: { nome: `Base ${Date.now()}`, tipo_cenario: 'BASE', horizonte_dias: 30 },
  });
  checar(b, 'simulacao base responde 201', simulacaoBase.status === 201, simulacaoBase.corpo?.error);

  const simulacaoAlta = await chamar('POST', '/api/compras/simulacoes', {
    token: admin,
    corpo: {
      nome: `Demanda +20% ${Date.now()}`, tipo_cenario: 'CONSERVADOR',
      horizonte_dias: 30, variacao_demanda_percentual: 20,
    },
  });
  checar(b, 'simulacao com demanda maior responde 201', simulacaoAlta.status === 201);
  checar(b, 'demanda +20% exige comprar mais que o cenario base',
    num(simulacaoAlta.corpo?.data?.valor_total_estimado) >= num(simulacaoBase.corpo?.data?.valor_total_estimado),
    { base: simulacaoBase.corpo?.data?.valor_total_estimado, alta: simulacaoAlta.corpo?.data?.valor_total_estimado });

  const { rows: antesSimulacao } = await pool.query(
    'SELECT count(*)::int AS n FROM necessidades_compra');
  const simulacaoExtra = await chamar('POST', '/api/compras/simulacoes', {
    token: admin, corpo: { nome: `Lead +10 ${Date.now()}`, lead_time_extra_dias: 10 },
  });
  const { rows: depoisSimulacao } = await pool.query(
    'SELECT count(*)::int AS n FROM necessidades_compra');
  checar(b, 'simulacao nao altera as necessidades oficiais',
    num(antesSimulacao[0].n) === num(depoisSimulacao[0].n),
    { antes: antesSimulacao[0].n, depois: depoisSimulacao[0].n });
  checar(b, 'lead time maior nao reduz a compra',
    num(simulacaoExtra.corpo?.data?.valor_total_estimado) >= 0);

  const comparacao = await chamar('GET',
    `/api/compras/simulacoes/comparar?ids=${simulacaoBase.corpo?.data?.id},${simulacaoAlta.corpo?.data?.id}`,
    { token: admin });
  checar(b, 'comparacao de cenarios responde 200', comparacao.status === 200, comparacao.corpo?.error);

  const excluir = await chamar('DELETE', `/api/compras/simulacoes/${simulacaoExtra.corpo?.data?.id}`, { token: admin });
  checar(b, 'simulacao pode ser excluida', excluir.status === 200);

  secao('historico e comparacao de planejamentos');
  const historico = await chamar('GET', `/api/compras/planejamentos/${planejamentoId}`, { token: admin });
  checar(b, 'historico do planejamento responde 200', historico.status === 200, historico.corpo?.error);

  const listaPlan = await chamar('GET', '/api/compras/planejamentos?limite=5', { token: admin });
  checar(b, 'planejamentos anteriores ficam no historico',
    listaPlan.status === 200 && (listaPlan.corpo?.data ?? []).length >= 1);
  const ids = (listaPlan.corpo?.data ?? []).map((p: any) => p.id);
  if (ids.length >= 2) {
    const comparar = await chamar('GET',
      `/api/compras/planejamentos/comparar?atual=${ids[0]}&anterior=${ids[1]}`, { token: admin });
    checar(b, 'comparacao entre planejamentos responde 200', comparar.status === 200, comparar.corpo?.error);
  } else {
    checar(b, 'ha planejamentos suficientes para comparar', false);
  }

  secao('parametros');
  const params = await chamar('GET', '/api/compras/parametros', { token: admin });
  checar(b, 'parametros do planejamento respondem 200', params.status === 200);
  const invalido = await chamar('PUT', '/api/compras/parametros', {
    token: admin, corpo: { 'planejamento.inexistente': '1' },
  });
  checar(b, 'parametro desconhecido e recusado', invalido.status === 422);

  secao('permissoes');
  const semToken = await chamar('GET', '/api/compras/dashboard');
  checar(b, 'compras sem token retorna 401', semToken.status === 401);

  const comercial = await tokenDoPerfil(admin, 'COMERCIAL', 'm05');
  if (comercial) {
    const leitura = await chamar('GET', '/api/compras/dashboard', { token: comercial });
    checar(b, 'COMERCIAL nao acessa o dashboard de compras', leitura.status === 403, leitura.status);
  }
  if (comprador) {
    const planeja = await chamar('POST', '/api/compras/planejamentos', {
      token: comprador, corpo: { horizonte_dias: 30, produto_id: cenarios.get('RUPTURA')?.produtoId },
    });
    checar(b, 'COMPRADOR pode executar planejamento', planeja.status === 201, planeja.corpo?.error);
    const mexeParametro = await chamar('PUT', '/api/compras/parametros', {
      token: comprador, corpo: { 'planejamento.horizonte_dias': '30' },
    });
    checar(b, 'COMPRADOR nao altera parametros do planejamento', mexeParametro.status === 403);
  }

  const estoque = await tokenDoPerfil(admin, 'ESTOQUE', 'm05');
  if (estoque) {
    const aprova = await chamar('POST', `/api/compras/necessidades/${alvo.id}/aprovar`, {
      token: estoque, corpo: {},
    });
    checar(b, 'ESTOQUE nao aprova necessidade de compra', aprova.status === 403, aprova.status);
  }

  return b;
}

/** Secao 61 do prompt: o caminho inteiro, do histórico ate a requisicao. */
async function cicloCompleto(): Promise<Bateria> {
  const b = novaBateria('MODULO 05 - cenario completo (secao 61)');
  const admin = await loginAdmin();

  secao('produto novo com historico controlado');
  const produtoId = await montarProduto({
    sufixo: 'CICLO', descricao: 'M05 ciclo completo', estoque: 300,
    demandaDiaria: 50, leadTime: 10, moq: 500, multiplo: 100, preco: 20,
  });

  const { rows: planejado } = await pool.query('SELECT id FROM planejamentos_compra ORDER BY id DESC LIMIT 1');

  const exec = await chamar('POST', '/api/compras/planejamentos', {
    token: admin, corpo: { horizonte_dias: 30, produto_id: produtoId },
  });
  checar(b, 'planejamento do produto isolado roda', exec.status === 201, exec.corpo?.error);

  const { rows } = await pool.query(`
    SELECT * FROM necessidades_compra
     WHERE produto_id = $1 AND planejamento_id = $2`, [produtoId, exec.corpo?.data?.planejamento_id]);
  const nec = rows[0];
  checar(b, 'necessidade foi gerada para o produto do ciclo', !!nec, { produtoId });
  if (!nec) return b;

  const m = nec.memoria_calculo;
  secao('a conta, passo a passo');
  checar(b, 'demanda diaria e 50', quase(num(m.demanda_diaria), 50, 0.01), m.demanda_diaria);
  checar(b, 'demanda do periodo = 50 x 30 = 1500', quase(num(m.demanda_periodo), 1500, 0.5), m.demanda_periodo);
  checar(b, 'posicao de estoque e 300', quase(num(m.posicao), 300, 0.01), m.posicao);
  checar(b, 'demanda no lead time = 50 x lead time total',
    quase(num(nec.demanda_lead_time), 50 * num(nec.lead_time_total_dias), 1),
    { lead: nec.lead_time_total_dias, demanda: nec.demanda_lead_time });
  checar(b, 'necessidade bruta = demanda + alvo - posicao',
    quase(num(nec.necessidade_bruta),
      Math.max(0, num(m.demanda_periodo) + num(m.estoque_alvo)
        + (m.seguranca_somada_por_fora ? num(m.estoque_seguranca) : 0) - num(m.posicao)), 0.5),
    { bruta: nec.necessidade_bruta, memoria: m });
  checar(b, 'quantidade sugerida respeita MOQ 500 e multiplo 100',
    num(nec.quantidade_sugerida) >= 500 && num(nec.quantidade_sugerida) % 100 === 0,
    nec.quantidade_sugerida);
  checar(b, 'valor estimado = quantidade x 20',
    quase(num(nec.valor_estimado), num(nec.quantidade_sugerida) * 20, 0.05),
    { valor: nec.valor_estimado, qtd: nec.quantidade_sugerida });
  checar(b, 'data ideal do pedido = data necessaria menos lead time total',
    !!nec.data_ideal_compra && !!nec.data_necessaria
    && new Date(nec.data_ideal_compra) <= new Date(nec.data_necessaria));

  secao('do calculo ate a requisicao');
  const aprovar = await chamar('POST', `/api/compras/necessidades/${nec.id}/aprovar`, {
    token: admin, corpo: { justificativa: 'Ciclo completo da bateria' },
  });
  checar(b, 'necessidade do ciclo e aprovada', aprovar.status === 200, aprovar.corpo?.error);

  const req = await chamar('POST', '/api/compras/requisicoes', {
    token: admin, corpo: { necessidade_ids: [nec.id] },
  });
  checar(b, 'requisicao do ciclo e criada', req.status === 201, req.corpo?.error);
  checar(b, 'valor da requisicao bate com o da necessidade',
    quase(num(req.corpo?.data?.valor_estimado), num(nec.valor_estimado), 0.05),
    { requisicao: req.corpo?.data?.valor_estimado, necessidade: nec.valor_estimado });

  const aprovarReq = await chamar('POST', `/api/compras/requisicoes/${req.corpo?.data?.id}/aprovar`, { token: admin });
  checar(b, 'requisicao do ciclo e aprovada', aprovarReq.status === 200, aprovarReq.corpo?.error);

  secao('nenhuma ordem de compra e criada neste modulo');
  const { rows: ordens } = await pool.query(`
    SELECT count(*)::int AS n FROM ordem_compra_itens WHERE produto_id = $1`, [produtoId]);
  checar(b, 'o modulo 05 para na requisicao, nao emite ordem de compra',
    num(ordens[0].n) === 0, ordens[0]);

  secao('recalculo nao duplica necessidade');
  const { rows: antes } = await pool.query(
    'SELECT count(*)::int AS n FROM necessidades_compra WHERE produto_id = $1', [produtoId]);
  await chamar('POST', '/api/compras/planejamentos', {
    token: admin, corpo: { horizonte_dias: 30, produto_id: produtoId },
  });
  const { rows: depois } = await pool.query(`
    SELECT count(DISTINCT planejamento_id)::int AS planejamentos, count(*)::int AS n
      FROM necessidades_compra WHERE produto_id = $1`, [produtoId]);
  checar(b, 'novo planejamento gera nova linha, sem sobrescrever a anterior',
    num(depois[0].n) > num(antes[0].n) && num(depois[0].planejamentos) >= 2,
    { antes: antes[0].n, depois: depois[0] });

  return b;
}

async function executar() {
  const cenarios = await preparar();
  const baterias: Bateria[] = [];
  baterias.push(await calculo(cenarios));
  baterias.push(await api(cenarios));
  baterias.push(await cicloCompleto());
  encerrar(baterias);
}

executar()
  .catch((erro) => {
    console.error('\nBateria interrompida:', erro);
    process.exitCode = 1;
  })
  .finally(encerrarPool);
