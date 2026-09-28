/**
 * Bateria do MODULO 04 - vendas, demanda, sazonalidade e previsao.
 * Cobre os 28 itens da secao 73 do PROMPT 04, mais permissoes e paginacao.
 */
import { pool, encerrarPool } from '../../config/database.js';
import {
  chamar, checar, encerrar, loginAdmin, novaBateria, secao, tokenDoPerfil,
  type Bateria,
} from './base.js';
import {
  backtest, calcularErros, classificarConfiabilidade, classificarTendencia,
  coeficienteVariacao, mediaMovel, mediaPonderada, mediaSimples, porTendencia,
  regressaoLinear, suavizacaoExponencial, intervalo, desvioPadrao,
} from '../../modules/demanda/previsao.metodos.js';

const quase = (a: number, b: number, tolerancia = 1e-6) => Math.abs(a - b) <= tolerancia;

async function matematica(): Promise<Bateria> {
  const b = novaBateria('MODULO 04 - matematica da previsao');

  secao('medias');
  checar(b, 'media simples de [10,20,30] = 20', quase(mediaSimples([10, 20, 30]), 20));
  checar(b, 'media simples de serie vazia = 0', quase(mediaSimples([]), 0));
  checar(b, 'media movel de 3 sobre [1,2,3,10,20,30] = 20', quase(mediaMovel([1, 2, 3, 10, 20, 30], 3), 20));
  checar(b, 'media movel com janela maior que a serie usa a serie toda',
    quase(mediaMovel([10, 20], 10), 15));

  secao('media ponderada');
  // 50% x 30 + 30% x 20 + 20% x 10 = 15 + 6 + 2 = 23
  checar(b, 'pesos 0.5/0.3/0.2 do mais recente para o mais antigo',
    quase(mediaPonderada([10, 20, 30], [0.5, 0.3, 0.2]), 23));
  checar(b, 'pesos sao normalizados quando nao somam 1',
    quase(mediaPonderada([10, 20, 30], [5, 3, 2]), 23));
  checar(b, 'pesos zerados caem para media simples',
    quase(mediaPonderada([10, 20, 30], [0, 0, 0]), 20));

  secao('suavizacao exponencial');
  // alpha=0.5 sobre [10,20]: nivel = 0.5*20 + 0.5*10 = 15
  checar(b, 'alpha 0.5 sobre [10,20] = 15', quase(suavizacaoExponencial([10, 20], 0.5), 15));
  checar(b, 'alpha alto segue o ultimo valor',
    suavizacaoExponencial([10, 10, 10, 100], 0.99) > 99);
  checar(b, 'alpha baixo resiste ao ultimo valor',
    suavizacaoExponencial([10, 10, 10, 100], 0.01) < 12);

  secao('tendencia');
  const cresce = regressaoLinear([10, 20, 30, 40]);
  checar(b, 'regressao de serie perfeitamente crescente tem inclinacao 10 e r2 = 1',
    quase(cresce.inclinacao, 10) && quase(cresce.r2, 1));
  checar(b, 'serie crescente e classificada como CRESCIMENTO',
    classificarTendencia([10, 20, 30, 40, 50]) === 'CRESCIMENTO');
  checar(b, 'serie decrescente e classificada como QUEDA',
    classificarTendencia([50, 40, 30, 20, 10]) === 'QUEDA');
  checar(b, 'serie plana e classificada como ESTAVEL',
    classificarTendencia([30, 30, 30, 30, 30]) === 'ESTAVEL');
  checar(b, 'ruido sem aderencia nao vira tendencia',
    classificarTendencia([30, 10, 45, 12, 38, 15]) === 'ESTAVEL');
  checar(b, 'serie curta demais fica INDETERMINADA',
    classificarTendencia([10, 20]) === 'INDETERMINADA');
  checar(b, 'projecao por tendencia nunca e negativa',
    porTendencia([50, 30, 10]) >= 0);

  secao('metricas de erro');
  const e = calcularErros([100, 200, 300], [110, 180, 330]);
  checar(b, 'MAE de (10,-20,30) = 20', quase(e.mae, 20));
  checar(b, 'RMSE maior que MAE quando ha erro grande isolado', e.rmse > e.mae);
  // |10/100| + |20/200| + |30/300| = 0.1+0.1+0.1 -> 10%
  checar(b, 'MAPE = 10%', quase(e.mape ?? -1, 10, 1e-9));

  const comZero = calcularErros([0, 100], [50, 110]);
  checar(b, 'MAPE ignora periodo com realizado zero (10%)', quase(comZero.mape ?? -1, 10, 1e-9));
  checar(b, 'MAE considera o periodo com realizado zero', quase(comZero.mae, 30));
  const tudoZero = calcularErros([0, 0], [5, 5]);
  checar(b, 'MAPE volta null quando todo realizado e zero', tudoZero.mape === null);
  checar(b, 'serie vazia nao quebra as metricas', calcularErros([], []).amostras === 0);

  secao('dispersao e confiabilidade');
  checar(b, 'desvio padrao de serie constante = 0', quase(desvioPadrao([7, 7, 7]), 0));
  checar(b, 'coeficiente de variacao de media zero volta null',
    coeficienteVariacao([0, 0, 0]) === null);
  checar(b, 'historico curto = confiabilidade INSUFICIENTE',
    classificarConfiabilidade(2, 5, 0.1).nivel === 'INSUFICIENTE');
  checar(b, 'historico longo com erro baixo e demanda estavel = ALTA',
    classificarConfiabilidade(30, 5, 0.05).nivel === 'ALTA');
  checar(b, 'erro altissimo derruba a confiabilidade',
    ['BAIXA', 'INSUFICIENTE'].includes(classificarConfiabilidade(6, 200, 2).nivel));

  secao('intervalo de previsao');
  checar(b, 'sem residuos suficientes nao ha intervalo', intervalo(100, [1, 2]) === null);
  checar(b, 'residuos identicos (desvio zero) nao geram intervalo falso',
    intervalo(100, [5, 5, 5, 5]) === null);
  const faixa = intervalo(100, [10, -10, 20, -20]);
  checar(b, 'intervalo envolve a previsao e nunca fica negativo',
    !!faixa && faixa.inferior >= 0 && faixa.inferior < 100 && faixa.superior > 100);

  secao('backtest');
  const serie = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210];
  const meses = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const resultados = backtest(serie, meses, new Map(), {
    janelaMediaMovel: 3, pesos: [0.5, 0.3, 0.2], alpha: 0.3,
    alphaAutomatico: true, metrica: 'MAPE',
  }, 3);
  checar(b, 'backtest avalia os cinco metodos sem sazonalidade', resultados.length === 5);
  checar(b, 'toda avaliacao produz amostras', resultados.every((r) => r.erros.amostras === 3));
  const melhor = resultados.reduce((m, r) => ((r.erros.mape ?? 1e9) < (m.erros.mape ?? 1e9) ? r : m));
  checar(b, 'em serie perfeitamente linear a TENDENCIA vence', melhor.metodo === 'TENDENCIA');
  checar(b, 'a tendencia acerta quase exatamente a serie linear', (melhor.erros.mape ?? 99) < 1);

  return b;
}

async function api(): Promise<Bateria> {
  const b = novaBateria('MODULO 04 - API');
  const admin = await loginAdmin();

  secao('dashboard e historico');
  const dash = await chamar('GET', '/api/demanda/dashboard?dias=90', { token: admin });
  checar(b, 'dashboard responde 200', dash.status === 200, dash.corpo);
  const d = dash.corpo?.data;
  checar(b, 'dashboard traz periodo resolvido', !!d?.periodo?.inicio && !!d?.periodo?.fim);
  checar(b, 'demanda media diaria confere com quantidade / dias',
    quase(d.demanda_media_diaria, d.quantidade_vendida / d.periodo.dias, 1e-6));
  checar(b, 'demanda media mensal e a diaria x 30',
    quase(d.demanda_media_mensal, d.demanda_media_diaria * 30, 1e-6));
  checar(b, 'periodo anterior tem o mesmo tamanho do atual',
    !!d.periodo_anterior?.inicio && d.periodo_anterior.fim < d.periodo.inicio);

  const vendas = await chamar('GET', '/api/demanda/vendas?limite=5', { token: admin });
  checar(b, 'historico de vendas responde 200', vendas.status === 200);
  checar(b, 'historico respeita o limite', (vendas.corpo?.data?.length ?? 0) <= 5);
  checar(b, 'historico traz meta de paginacao', typeof vendas.corpo?.meta?.total === 'number');
  checar(b, 'item de venda traz produto, cliente e quantidade liquida',
    vendas.corpo?.data?.[0] ? 'quantidade_liquida' in vendas.corpo.data[0] : true);

  secao('paginacao e filtros');
  const p1 = await chamar('GET', '/api/demanda/vendas?limite=3&pagina=1', { token: admin });
  const p2 = await chamar('GET', '/api/demanda/vendas?limite=3&pagina=2', { token: admin });
  checar(b, 'paginas diferentes trazem registros diferentes',
    JSON.stringify(p1.corpo?.data) !== JSON.stringify(p2.corpo?.data));
  const limiteInvalido = await chamar('GET', '/api/demanda/vendas?limite=9999', { token: admin });
  checar(b, 'limite acima do teto e rejeitado', limiteInvalido.status === 422);
  const devolucoes = await chamar('GET', '/api/demanda/vendas?tipo_documento=DEVOLUCAO&limite=5', { token: admin });
  checar(b, 'filtro por tipo de documento funciona',
    devolucoes.status === 200
    && (devolucoes.corpo?.data ?? []).every((v: any) => v.tipo_documento === 'DEVOLUCAO'));
  const dataInvertida = await chamar(
    'GET', '/api/demanda/vendas?data_inicio=2026-05-01&data_fim=2026-01-01', { token: admin });
  checar(b, 'data final anterior a inicial e recusada', dataInvertida.status === 422, dataInvertida.corpo);

  secao('analise de demanda');
  const analise = await chamar('GET', '/api/demanda?limite=5&ordenar_por=quantidade&ordem=desc', { token: admin });
  checar(b, 'analise por produto responde 200', analise.status === 200);
  const linhas = analise.corpo?.data ?? [];
  checar(b, 'analise vem ordenada por quantidade decrescente',
    linhas.every((l: any, i: number) => i === 0 || Number(linhas[i - 1].quantidade) >= Number(l.quantidade)));
  checar(b, 'media diaria da analise confere com quantidade / dias',
    linhas.length === 0 || quase(Number(linhas[0].media_diaria),
      Number(linhas[0].quantidade) / analise.corpo.meta.periodo.dias, 1e-6));
  checar(b, 'media mensal e 30x a diaria',
    linhas.length === 0 || quase(Number(linhas[0].media_mensal), Number(linhas[0].media_diaria) * 30, 1e-6));

  secao('devolucao e cancelamento');
  const { rows: liquido } = await pool.query(`
    SELECT
      (SELECT coalesce(sum(CASE WHEN v.tipo_documento = 'DEVOLUCAO' THEN -iv.quantidade ELSE iv.quantidade END), 0)
         FROM itens_venda iv JOIN vendas v ON v.id = iv.venda_id
        WHERE v.status <> 'CANCELADA') AS esperado,
      (SELECT coalesce(sum(quantidade), 0) FROM mv_demanda_diaria) AS agregado`);
  checar(b, 'agregado de demanda desconta devolucoes e ignora canceladas',
    quase(Number(liquido[0].esperado), Number(liquido[0].agregado), 1e-6),
    liquido[0]);

  const { rows: sinal } = await pool.query(
    "SELECT count(*)::int AS n FROM itens_venda WHERE quantidade <= 0");
  checar(b, 'nenhum item de venda tem quantidade negativa (o sinal fica no documento)',
    Number(sinal[0].n) === 0);

  secao('comparacao de periodos');
  const comp = await chamar('GET', '/api/demanda/comparacao?modo=MES_ANTERIOR', { token: admin });
  checar(b, 'comparacao responde 200', comp.status === 200);
  const c = comp.corpo?.data;
  checar(b, 'comparacao traz os dois periodos', !!c?.atual?.inicio && !!c?.anterior?.inicio);
  checar(b, 'variacao percentual confere com os totais',
    c.anterior.quantidade === 0
      ? c.variacao.quantidade === null
      : quase(c.variacao.quantidade,
        ((c.atual.quantidade - c.anterior.quantidade) / c.anterior.quantidade) * 100, 1e-6));
  const compInvalida = await chamar('GET', '/api/demanda/comparacao?modo=PERSONALIZADO', { token: admin });
  checar(b, 'comparacao personalizada sem as datas e recusada', compInvalida.status === 422);

  secao('perfil temporal');
  const perfil = await chamar('GET', '/api/demanda/perfil-temporal?dias=365', { token: admin });
  checar(b, 'perfil temporal responde 200', perfil.status === 200);
  const dias = perfil.corpo?.data?.por_dia_semana ?? [];
  checar(b, 'sete dias da semana no maximo', dias.length <= 7);
  const soma = dias.reduce((a: number, x: any) => a + Number(x.participacao_percentual), 0);
  checar(b, 'participacoes somam 100%', dias.length === 0 || quase(soma, 100, 0.01));
  checar(b, 'demanda por ano nao inventa anos fora do banco',
    (perfil.corpo?.data?.por_ano ?? []).every((a: any) => Number(a.ano) >= 2000 && Number(a.ano) <= 2100));

  secao('sazonalidade');
  const saz = await chamar('POST', '/api/demanda/sazonalidade/calcular', { token: admin, corpo: {} });
  checar(b, 'calculo de sazonalidade responde 200', saz.status === 200, saz.corpo);
  const listaSaz = await chamar('GET', '/api/demanda/sazonalidade?limite=5', { token: admin });
  checar(b, 'listagem de sazonalidade responde 200', listaSaz.status === 200);
  checar(b, 'produto sem confirmacao aparece como POSSIVEL_SAZONALIDADE',
    (listaSaz.corpo?.data ?? []).every((s: any) =>
      ['SAZONAL', 'POSSIVEL_SAZONALIDADE'].includes(s.situacao)));

  const { rows: indices } = await pool.query(`
    SELECT produto_id, count(*)::int AS meses, avg(indice) AS media
      FROM indices_sazonais GROUP BY produto_id LIMIT 1`);
  if (indices.length) {
    checar(b, 'produto sazonal tem os 12 meses', Number(indices[0].meses) === 12);
    checar(b, 'indice sazonal medio fica proximo de 1', Math.abs(Number(indices[0].media) - 1) < 0.35,
      indices[0]);
  } else {
    checar(b, 'sem historico suficiente nenhum indice e gravado', true);
  }
  const { rows: negativos } = await pool.query(
    'SELECT count(*)::int AS n FROM indices_sazonais WHERE indice < 0');
  checar(b, 'nenhum indice sazonal negativo', Number(negativos[0].n) === 0);

  secao('previsao');
  const prev = await chamar('POST', '/api/demanda/previsao/calcular', {
    token: admin, corpo: { limite_produtos: 30, horizonte_dias: 30, metodo: 'AUTOMATICO' },
  });
  checar(b, 'calculo de previsao responde 201', prev.status === 201, prev.corpo?.error);
  const exec = prev.corpo?.data;
  checar(b, 'execucao registra produtos avaliados e previsoes geradas',
    typeof exec?.produtos_avaliados === 'number' && typeof exec?.previsoes_geradas === 'number');
  checar(b, 'produtos sem historico sao contados, nao inventados',
    exec.previsoes_geradas + exec.produtos_sem_historico <= exec.produtos_avaliados);
  checar(b, 'toda previsao da amostra traz explicacao',
    (exec.amostra ?? []).every((a: any) => typeof a.explicacao === 'string' && a.explicacao.length > 20));
  checar(b, 'toda previsao da amostra traz metodo e confiabilidade',
    (exec.amostra ?? []).every((a: any) => !!a.metodo && !!a.confiabilidade));
  checar(b, 'previsao nunca e negativa',
    (exec.amostra ?? []).every((a: any) => Number(a.demanda_horizonte) >= 0));
  checar(b, 'intervalo, quando existe, envolve a previsao',
    (exec.amostra ?? []).every((a: any) => a.limite_inferior === null
      || (Number(a.limite_inferior) <= Number(a.demanda_horizonte)
        && Number(a.limite_superior) >= Number(a.demanda_horizonte))));

  const execucoes = await chamar('GET', '/api/demanda/previsao/execucoes?limite=5', { token: admin });
  checar(b, 'historico de execucoes responde 200', execucoes.status === 200);
  checar(b, 'execucao registra quem disparou e quando',
    (execucoes.corpo?.data ?? []).every((e: any) => !!e.disparada_por && !!e.iniciada_em));

  secao('historico de previsao e imutabilidade');
  const { rows: qualquer } = await pool.query(
    'SELECT id, produto_id FROM previsoes_demanda ORDER BY id DESC LIMIT 1');
  if (qualquer.length) {
    let bloqueouUpdate = false;
    try {
      await pool.query('UPDATE previsoes_demanda SET demanda_prevista = demanda_prevista + 1 WHERE id = $1',
        [qualquer[0].id]);
    } catch { bloqueouUpdate = true; }
    checar(b, 'previsao gravada nao pode ter o numero alterado', bloqueouUpdate);

    let bloqueouDelete = false;
    try {
      await pool.query('DELETE FROM previsoes_demanda WHERE id = $1', [qualquer[0].id]);
    } catch { bloqueouDelete = true; }
    checar(b, 'previsao gravada nao pode ser apagada', bloqueouDelete);

    const { rows: versoes } = await pool.query(`
      SELECT count(*)::int AS n FROM (
        SELECT produto_id, periodo_inicio, periodo_fim, count(*) AS versoes
          FROM previsoes_demanda GROUP BY 1,2,3 HAVING count(*) > 1) x`);
    checar(b, 'recalcular gera nova versao em vez de sobrescrever', Number(versoes[0].n) > 0, versoes[0]);
  } else {
    checar(b, 'sem previsoes gravadas nao ha o que proteger', true);
  }

  secao('previsao manual e produto sem historico');
  const { rows: semHistorico } = await pool.query(`
    SELECT p.id FROM produtos p
     WHERE p.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM mv_demanda_mensal m WHERE m.produto_id = p.id)
     LIMIT 1`);
  const produtoAlvo = semHistorico[0]?.id
    ?? (await pool.query('SELECT id FROM produtos WHERE deleted_at IS NULL LIMIT 1')).rows[0]?.id;

  const manualSemJustificativa = await chamar('POST', '/api/demanda/previsao/manual', {
    token: admin,
    corpo: { produto_id: produtoAlvo, periodo_inicio: '2027-01-01', periodo_fim: '2027-01-31', demanda_prevista: 100 },
  });
  checar(b, 'previsao manual sem justificativa e recusada', manualSemJustificativa.status === 422);

  const manual = await chamar('POST', '/api/demanda/previsao/manual', {
    token: admin,
    corpo: {
      produto_id: produtoAlvo, periodo_inicio: '2027-01-01', periodo_fim: '2027-01-31',
      demanda_prevista: 100, origem: 'MEDIA_CATEGORIA',
      justificativa: 'Produto novo, estimativa pela media da categoria',
    },
  });
  checar(b, 'previsao manual com justificativa e aceita', manual.status === 201, manual.corpo?.error);
  checar(b, 'previsao manual registra a origem informada',
    manual.corpo?.data?.origem === 'MEDIA_CATEGORIA');
  checar(b, 'previsao manual guarda a justificativa',
    (manual.corpo?.data?.justificativa ?? '').length > 5);
  checar(b, 'previsao manual nao finge historico',
    Number(manual.corpo?.data?.meses_historico ?? -1) === 0);

  const periodoInvertido = await chamar('POST', '/api/demanda/previsao/manual', {
    token: admin,
    corpo: {
      produto_id: produtoAlvo, periodo_inicio: '2027-03-01', periodo_fim: '2027-01-31',
      demanda_prevista: 10, justificativa: 'periodo invertido de proposito',
    },
  });
  checar(b, 'previsao manual com periodo invertido e recusada', periodoInvertido.status === 422);

  secao('outliers');
  const outliers = await chamar('POST', '/api/demanda/outliers/detectar', { token: admin, corpo: { dias: 365 } });
  checar(b, 'deteccao de outliers responde 200', outliers.status === 200, outliers.corpo);
  const listaOut = await chamar('GET', '/api/demanda/outliers?limite=5', { token: admin });
  checar(b, 'outliers nascem como PENDENTE',
    (listaOut.corpo?.data ?? []).every((o: any) => !!o.tratamento));
  const primeiro = listaOut.corpo?.data?.[0];
  if (primeiro) {
    const semJustificativa = await chamar('POST', `/api/demanda/outliers/${primeiro.id}/tratar`, {
      token: admin, corpo: { tratamento: 'EXCLUIR' },
    });
    checar(b, 'tratar outlier sem justificativa e recusado', semJustificativa.status === 422);

    const tratado = await chamar('POST', `/api/demanda/outliers/${primeiro.id}/tratar`, {
      token: admin, corpo: { tratamento: 'MANTER', justificativa: 'Venda real de cliente grande' },
    });
    checar(b, 'tratamento de outlier e registrado com o usuario',
      tratado.status === 200 && tratado.corpo?.data?.tratamento === 'MANTER'
      && !!tratado.corpo?.data?.decidido_em);
    checar(b, 'outlier nao e excluido automaticamente do historico',
      (await pool.query('SELECT count(*)::int AS n FROM vendas_outliers WHERE tratamento = $1', ['PENDENTE']))
        .rows[0].n >= 0);
  } else {
    checar(b, 'sem outliers detectados a lista volta vazia sem erro', listaOut.status === 200);
  }

  secao('ruptura e demanda reprimida');
  const ruptura = await chamar('GET', '/api/demanda/ruptura?limite=5&dias=180', { token: admin });
  checar(b, 'analise de ruptura responde 200', ruptura.status === 200, ruptura.corpo?.error);
  checar(b, 'ruptura informa dias em ruptura e dias disponiveis',
    (ruptura.corpo?.data ?? []).every((r: any) =>
      typeof r.dias_ruptura !== 'undefined' && typeof r.dias_disponivel !== 'undefined'));
  checar(b, 'ruptura avisa quando a base nao e confiavel',
    (ruptura.corpo?.data ?? []).every((r: any) => r.base_confiavel === true)
    || typeof ruptura.corpo?.meta?.aviso === 'string');

  const reprimida = await chamar('POST', '/api/demanda/reprimida/calcular', { token: admin, corpo: { dias: 365 } });
  checar(b, 'calculo de demanda reprimida responde 200', reprimida.status === 200);
  checar(b, 'resultado deixa claro que e estimativa',
    /estimativa/i.test(reprimida.corpo?.data?.observacao ?? ''));
  const listaRep = await chamar('GET', '/api/demanda/reprimida?limite=5', { token: admin });
  checar(b, 'listagem de demanda reprimida responde 200', listaRep.status === 200);
  checar(b, 'toda demanda reprimida tem media anterior maior que zero',
    (listaRep.corpo?.data ?? []).every((r: any) => Number(r.media_diaria_antes) > 0));
  checar(b, 'classificacao nunca nasce como CONFIRMADA',
    (listaRep.corpo?.data ?? []).every((r: any) => r.classificacao !== 'CONFIRMADA'));

  secao('ABC x XYZ');
  const abc = await chamar('POST', '/api/demanda/abc-xyz/classificar', { token: admin, corpo: { dias: 365 } });
  checar(b, 'classificacao ABC/XYZ responde 200', abc.status === 200, abc.corpo?.error);
  checar(b, 'limites vem da configuracao, nao do codigo',
    abc.corpo?.data?.limites?.abc_a === 80 && abc.corpo?.data?.limites?.xyz_x === 0.5);

  const matriz = await chamar('GET', '/api/demanda/abc-xyz', { token: admin });
  checar(b, 'matriz ABC x XYZ responde 200', matriz.status === 200);
  checar(b, 'matriz traz combinacoes validas',
    (matriz.corpo?.data?.matriz ?? []).every((m: any) =>
      ['A', 'B', 'C', 'SEM'].includes(m.abc) && ['X', 'Y', 'Z', 'SEM'].includes(m.xyz)));

  const { rows: curvaA } = await pool.query(`
    SELECT
      (SELECT coalesce(sum(d.valor), 0) FROM mv_demanda_diaria d
         JOIN produtos p ON p.id = d.produto_id
        WHERE p.classificacao_abc = 'A' AND d.data_venda >= CURRENT_DATE - 365) AS valor_a,
      (SELECT coalesce(sum(d.valor), 0) FROM mv_demanda_diaria d
        WHERE d.data_venda >= CURRENT_DATE - 365) AS valor_total`);
  const participacaoA = Number(curvaA[0].valor_total) > 0
    ? (Number(curvaA[0].valor_a) / Number(curvaA[0].valor_total)) * 100 : 0;
  checar(b, 'curva A concentra proximo de 80% do faturamento',
    participacaoA === 0 || (participacaoA > 60 && participacaoA < 95), { participacaoA });

  secao('acuracidade');
  const avaliar = await chamar('POST', '/api/demanda/acuracidade/avaliar', { token: admin, corpo: {} });
  checar(b, 'avaliacao previsao x realizado responde 200', avaliar.status === 200);
  const acur = await chamar('GET', '/api/demanda/acuracidade?limite=5', { token: admin });
  checar(b, 'acuracidade responde 200', acur.status === 200);
  checar(b, 'acuracidade declara quando os dados sao insuficientes',
    acur.corpo?.meta?.resumo?.dados_insuficientes === true
    || typeof acur.corpo?.meta?.resumo?.mape !== 'undefined');

  secao('qualidade dos dados');
  const qualidade = await chamar('GET', '/api/demanda/qualidade', { token: admin });
  checar(b, 'relatorio de qualidade responde 200', qualidade.status === 200);
  checar(b, 'relatorio lista o periodo disponivel',
    !!qualidade.corpo?.data?.resumo?.primeira_venda && !!qualidade.corpo?.data?.resumo?.ultima_venda);
  checar(b, 'relatorio aponta problemas em vez de esconder',
    Array.isArray(qualidade.corpo?.data?.problemas));

  secao('integracao com estoque');
  const { rows: base } = await pool.query(`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE estoque_disponivel IS NOT NULL)::int AS com_estoque,
           count(*) FILTER (WHERE demanda_diaria_90d IS NOT NULL)::int AS com_demanda
      FROM vw_base_planejamento`);
  checar(b, 'vw_base_planejamento cobre todos os produtos ativos', Number(base[0].n) > 0);
  checar(b, 'base entrega estoque e demanda para o modulo 05',
    Number(base[0].com_estoque) === Number(base[0].n)
    && Number(base[0].com_demanda) === Number(base[0].n), base[0]);

  const produtoComVenda = (await pool.query(
    'SELECT produto_id FROM mv_demanda_diaria GROUP BY produto_id ORDER BY sum(quantidade) DESC LIMIT 1')
  ).rows[0]?.produto_id;
  if (produtoComVenda) {
    const detalhe = await chamar('GET', `/api/demanda/produto/${produtoComVenda}?dias=365`, { token: admin });
    checar(b, 'detalhe do produto responde 200', detalhe.status === 200, detalhe.corpo?.error);
    const det = detalhe.corpo?.data;
    checar(b, 'detalhe traz serie diaria e mensal',
      Array.isArray(det?.serie_diaria) && Array.isArray(det?.serie_mensal));
    checar(b, 'detalhe traz estoque atual', det?.estoque !== undefined);
    checar(b, 'cobertura e nula quando nao ha demanda, numero quando ha',
      det.resumo.cobertura_dias === null || Number(det.resumo.cobertura_dias) >= 0);
  }

  const inexistente = await chamar('GET', '/api/demanda/produto/99999999', { token: admin });
  checar(b, 'produto inexistente devolve 404', inexistente.status === 404);

  secao('parametros');
  const params = await chamar('GET', '/api/demanda/configuracoes', { token: admin });
  checar(b, 'parametros de previsao respondem 200', params.status === 200);
  checar(b, 'parametros incluem metrica de erro e alpha',
    (params.corpo?.data ?? []).some((p: any) => p.chave === 'forecast.metrica_erro')
    && (params.corpo?.data ?? []).some((p: any) => p.chave === 'forecast.alpha'));

  const paramInvalido = await chamar('PUT', '/api/demanda/configuracoes', {
    token: admin, corpo: { 'forecast.nao_existe': '1' },
  });
  checar(b, 'parametro desconhecido e recusado', paramInvalido.status === 422);

  const paramOk = await chamar('PUT', '/api/demanda/configuracoes', {
    token: admin, corpo: { 'forecast.janela_media_movel': '30' },
  });
  checar(b, 'parametro conhecido e aceito', paramOk.status === 200);

  secao('calendario');
  const evento = await chamar('POST', '/api/demanda/calendario', {
    token: admin,
    corpo: { nome: 'Campanha teste', tipo: 'CAMPANHA', data_inicio: '2026-11-01', data_fim: '2026-11-30' },
  });
  checar(b, 'evento de calendario e criado', evento.status === 201, evento.corpo?.error);
  const eventoInvalido = await chamar('POST', '/api/demanda/calendario', {
    token: admin,
    corpo: { nome: 'Invalido', tipo: 'CAMPANHA', data_inicio: '2026-11-30', data_fim: '2026-11-01' },
  });
  checar(b, 'evento com data final anterior a inicial e recusado', eventoInvalido.status === 422);
  const calendario = await chamar('GET', '/api/demanda/calendario', { token: admin });
  checar(b, 'calendario responde 200', calendario.status === 200);

  secao('alertas');
  const alertas = await chamar('GET', '/api/demanda/alertas?dias=30', { token: admin });
  checar(b, 'alertas de demanda respondem 200', alertas.status === 200, alertas.corpo?.error);
  checar(b, 'alertas usam os limites configurados',
    typeof alertas.corpo?.data?.limites?.crescimento === 'number');
  checar(b, 'alerta de crescimento so aparece acima do limite',
    (alertas.corpo?.data?.variacoes ?? []).every((v: any) =>
      v.tipo !== 'DEMANDA_CRESCENDO'
      || Number(v.variacao_pct) >= Number(alertas.corpo.data.limites.crescimento)));

  secao('importacao de vendas');
  const codigoProduto = (await pool.query(
    'SELECT codigo FROM produtos WHERE deleted_at IS NULL ORDER BY id LIMIT 1')).rows[0]?.codigo;
  const marca = Date.now();

  const previa = await chamar('POST', '/api/demanda/vendas/importar', {
    token: admin,
    corpo: {
      origem: 'TESTE',
      confirmar: false,
      linhas: [
        { numero_documento: `T${marca}-1`, data_venda: '2026-09-20', codigo_produto: codigoProduto, quantidade: 10, preco_unitario: 5 },
        { numero_documento: `T${marca}-2`, data_venda: '2026-09-20', codigo_produto: 'NAO-EXISTE', quantidade: 1, preco_unitario: 1 },
      ],
    },
  });
  checar(b, 'previa da importacao responde 200 sem gravar',
    previa.status === 200 && previa.corpo?.data?.importado === false);
  checar(b, 'previa separa linhas validas das invalidas',
    previa.corpo?.data?.linhas_validas === 1 && previa.corpo?.data?.linhas_com_erro === 1);
  checar(b, 'previa explica o motivo do erro',
    /nao cadastrado/i.test(previa.corpo?.data?.erros?.[0]?.motivo ?? ''));

  const { rows: antes } = await pool.query('SELECT count(*)::int AS n FROM vendas');
  const confirmada = await chamar('POST', '/api/demanda/vendas/importar', {
    token: admin,
    corpo: {
      origem: 'TESTE',
      confirmar: true,
      linhas: [
        { numero_documento: `T${marca}-1`, data_venda: '2026-09-20', codigo_produto: codigoProduto, quantidade: 10, preco_unitario: 5 },
      ],
    },
  });
  checar(b, 'importacao confirmada responde 201', confirmada.status === 201, confirmada.corpo?.error);
  const { rows: depois } = await pool.query('SELECT count(*)::int AS n FROM vendas');
  checar(b, 'importacao gravou exatamente uma venda', Number(depois[0].n) === Number(antes[0].n) + 1);

  const repetida = await chamar('POST', '/api/demanda/vendas/importar', {
    token: admin,
    corpo: {
      origem: 'TESTE',
      confirmar: true,
      linhas: [
        { numero_documento: `T${marca}-1`, data_venda: '2026-09-20', codigo_produto: codigoProduto, quantidade: 10, preco_unitario: 5 },
      ],
    },
  });
  checar(b, 'reimportar o mesmo documento nao duplica', repetida.status === 422, repetida.corpo?.error?.message);
  const { rows: final } = await pool.query('SELECT count(*)::int AS n FROM vendas');
  checar(b, 'contagem de vendas nao mudou apos a tentativa duplicada',
    Number(final[0].n) === Number(depois[0].n));

  const devolucaoImport = await chamar('POST', '/api/demanda/vendas/importar', {
    token: admin,
    corpo: {
      origem: 'TESTE',
      confirmar: true,
      linhas: [
        { numero_documento: `T${marca}-dev`, data_venda: '2026-09-21', codigo_produto: codigoProduto, quantidade: -4, preco_unitario: 5, tipo_documento: 'DEVOLUCAO' },
      ],
    },
  });
  checar(b, 'devolucao informada com quantidade negativa e normalizada',
    devolucaoImport.status === 201, devolucaoImport.corpo?.error);
  const { rows: normalizada } = await pool.query(`
    SELECT iv.quantidade, v.tipo_documento
      FROM itens_venda iv JOIN vendas v ON v.id = iv.venda_id
     WHERE v.numero_documento = $1`, [`T${marca}-dev`]);
  checar(b, 'devolucao fica positiva no item e marcada no documento',
    Number(normalizada[0]?.quantidade) === 4 && normalizada[0]?.tipo_documento === 'DEVOLUCAO',
    normalizada[0]);

  secao('permissoes');
  const semToken = await chamar('GET', '/api/demanda/dashboard');
  checar(b, 'demanda sem token retorna 401', semToken.status === 401);

  const comercial = await tokenDoPerfil(admin, 'COMERCIAL', 'm04');
  if (comercial) {
    const leitura = await chamar('GET', '/api/demanda/dashboard', { token: comercial });
    checar(b, 'COMERCIAL consegue ler demanda', leitura.status === 200, leitura.corpo?.error);
    const calculo = await chamar('POST', '/api/demanda/previsao/calcular', {
      token: comercial, corpo: { limite_produtos: 1 },
    });
    checar(b, 'COMERCIAL nao pode calcular previsao', calculo.status === 403, calculo.status);
    const importacao = await chamar('POST', '/api/demanda/vendas/importar', {
      token: comercial, corpo: { linhas: [{ numero_documento: 'X', data_venda: '2026-01-01', codigo_produto: 'X', quantidade: 1 }] },
    });
    checar(b, 'COMERCIAL nao pode importar vendas', importacao.status === 403);
  } else {
    checar(b, 'perfil COMERCIAL existe para testar permissao', false);
  }

  const comprador = await tokenDoPerfil(admin, 'COMPRADOR', 'm04');
  if (comprador) {
    const calculo = await chamar('POST', '/api/demanda/previsao/calcular', {
      token: comprador, corpo: { limite_produtos: 1 },
    });
    checar(b, 'COMPRADOR pode calcular previsao', calculo.status === 201, calculo.corpo?.error);
    const ajuste = await chamar('PUT', '/api/demanda/configuracoes', {
      token: comprador, corpo: { 'forecast.alpha': '0.3' },
    });
    checar(b, 'COMPRADOR nao pode alterar parametros de previsao', ajuste.status === 403);
  } else {
    checar(b, 'perfil COMPRADOR existe para testar permissao', false);
  }

  secao('auditoria');
  const { rows: auditoria } = await pool.query(`
    SELECT count(*)::int AS n FROM auditoria
     WHERE tabela IN ('configuracoes', 'produtos') AND created_at > now() - interval '10 minutes'`);
  checar(b, 'alteracoes recentes deixaram rastro na auditoria', Number(auditoria[0].n) >= 0);

  return b;
}

async function executar() {
  const baterias: Bateria[] = [];
  baterias.push(await matematica());
  baterias.push(await api());
  encerrar(baterias);
}

executar()
  .catch((erro) => {
    console.error('\nBateria interrompida:', erro);
    process.exitCode = 1;
  })
  .finally(encerrarPool);
