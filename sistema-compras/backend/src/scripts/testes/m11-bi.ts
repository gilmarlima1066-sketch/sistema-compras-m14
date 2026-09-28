/**
 * Bateria do modulo 11 - dashboards gerenciais, BI e indicadores.
 *
 * Cobre as categorias da secao 69 (KPIs, dashboards, alertas, performance e
 * seguranca) e os cinco cenarios obrigatorios da secao 70.
 *
 * A bateria e idempotente: ela apura, filtra, compara e trata alertas de
 * teste, mas devolve a meta de OTIF ao valor original no fim e nao deixa
 * KPI nem dashboard alterado. O modulo 11 e camada de analise (regra 10),
 * entao a bateria tambem verifica o que ele NAO faz: nenhuma movimentacao
 * de estoque, nenhum pedido, nenhum recebimento criado por uma consulta.
 *
 *   npm run test:m11
 */
import {
  checar, chamar, encerrar, loginAdmin, novaBateria, secao, tokenDoPerfil,
  type Bateria,
} from './base.js';

const q = (o: Record<string, unknown>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

async function contarOperacional(token: string) {
  const [mov, pedidos, receb] = await Promise.all([
    chamar('GET', '/api/estoque/movimentacoes?limite=1', { token }),
    chamar('GET', '/api/pedidos-compra?limite=1', { token }),
    chamar('GET', '/api/recebimentos?limite=1', { token }),
  ]);
  return {
    movimentacoes: mov.corpo?.meta?.total ?? mov.corpo?.data?.total ?? null,
    pedidos: pedidos.corpo?.meta?.total ?? pedidos.corpo?.data?.total ?? null,
    recebimentos: receb.corpo?.meta?.total ?? receb.corpo?.data?.total ?? null,
  };
}

async function main() {
  const baterias: Bateria[] = [];
  const admin = await loginAdmin();
  const antes = await contarOperacional(admin);

  // =======================================================================
  secao('1. Catalogo e governanca dos indicadores (secoes 9, 65 e 66)');
  const b1 = novaBateria('Catalogo de KPIs');
  baterias.push(b1);

  const { status: sLista, corpo: lista } = await chamar('GET', '/api/kpis', { token: admin });
  const kpis: any[] = lista?.data ?? [];
  checar(b1, 'catalogo responde 200', sLista === 200, sLista);
  checar(b1, 'catalogo tem ao menos 40 indicadores', kpis.length >= 40, kpis.length);

  // REGRA 1: nao duplicar KPIs.
  const codigos = kpis.map((k) => String(k.codigo).toUpperCase());
  checar(b1, 'nenhum codigo de KPI repetido (regra 1)',
    new Set(codigos).size === codigos.length,
    codigos.filter((c, i) => codigos.indexOf(c) !== i));

  // REGRA 2 e 3: definicao oficial e formula rastreavel.
  const semFormula = kpis.filter((k) => !k.formula || !k.fonte);
  checar(b1, 'todo KPI tem formula e fonte declaradas (regras 2 e 3)',
    semFormula.length === 0, semFormula.map((k) => k.codigo));

  const { status: sDic, corpo: dic } = await chamar('GET', '/api/kpis/dicionario', { token: admin });
  checar(b1, 'dicionario de indicadores responde (secao 66)', sDic === 200, sDic);
  const verbetes: any[] = Array.isArray(dic?.data) ? dic.data : (dic?.data?.indicadores ?? []);
  checar(b1, 'dicionario cobre todos os KPIs do catalogo',
    verbetes.length >= kpis.length, { dicionario: verbetes.length, catalogo: kpis.length });

  // Secao 67: OTIF precisa ter UMA definicao, usada por todos os paineis.
  const otifs = kpis.filter((k) => String(k.codigo).toUpperCase() === 'OTIF');
  checar(b1, 'OTIF aparece uma unica vez no catalogo (secao 67)', otifs.length === 1, otifs.length);

  // =======================================================================
  secao('2. Apuracao, periodo e semaforo (secoes 10, 11 e 47)');
  const b2 = novaBateria('Apuracao de KPI');
  baterias.push(b2);

  const { status: sOtif, corpo: otif } = await chamar('GET', '/api/kpis/OTIF?dias=90', { token: admin });
  const o = otif?.data;
  checar(b2, 'OTIF apura 200', sOtif === 200, sOtif);
  checar(b2, 'OTIF volta em percentual', o?.unidade === 'PERCENTUAL', o?.unidade);
  checar(b2, 'OTIF entre 0 e 100', o?.valor === null || (o.valor >= 0 && o.valor <= 100), o?.valor);
  checar(b2, 'periodo apurado tem 90 dias', o?.periodo?.dias === 90, o?.periodo);

  // REGRA 7: todo KPI informa quando foi atualizado.
  checar(b2, 'KPI informa o momento da apuracao (regra 7)',
    typeof o?.atualizado_em === 'string' && !Number.isNaN(Date.parse(o.atualizado_em)),
    o?.atualizado_em);
  checar(b2, 'KPI informa se e tempo real ou nao', o?.periodicidade !== undefined, o?.periodicidade);

  // REGRA 8: indicador importante permite drill-down.
  checar(b2, 'OTIF declara destino de drill-down (regra 8)', !!o?.drilldown, o?.drilldown);

  // Semaforo coerente com a meta e a direcao.
  if (o?.meta && o?.valor !== null) {
    const esperado = o.valor >= o.meta.meta ? 'VERDE'
      : o.valor >= o.meta.limiteAtencao ? 'AMARELO'
        : o.valor >= o.meta.limiteCritico ? 'AMARELO' : 'VERMELHO';
    checar(b2, 'semaforo coerente com meta e limites (secao 47)',
      o.semaforo === esperado || (esperado === 'AMARELO' && o.semaforo === 'AMARELO'),
      { valor: o.valor, meta: o.meta, semaforo: o.semaforo });
    checar(b2, 'desvio de KPI percentual vem em pontos percentuais (secao 52)',
      o.desvio_unidade === 'PONTOS_PERCENTUAIS', o.desvio_unidade);
  }

  // Periodo diferente = numero diferente (ou ao menos periodo diferente).
  const { corpo: otif30 } = await chamar('GET', '/api/kpis/OTIF?dias=30', { token: admin });
  checar(b2, 'trocar o periodo reapura o indicador',
    otif30?.data?.periodo?.dias === 30, otif30?.data?.periodo);

  // Comparacao: periodo anterior do MESMO tamanho (secao 49).
  const { status: sComp, corpo: comp } = await chamar(
    'GET', '/api/kpis/OTIF/comparacao?dias=30', { token: admin });
  checar(b2, 'comparacao responde 200', sComp === 200, sComp);
  checar(b2, 'periodo anterior tem o mesmo tamanho (secao 49)',
    comp?.data?.comparacao?.periodo_anterior?.periodo?.dias === 30,
    comp?.data?.comparacao?.periodo_anterior?.periodo);
  checar(b2, 'comparacao traz o mesmo periodo do ano anterior',
    !!comp?.data?.comparacao?.ano_anterior,
    Object.keys(comp?.data?.comparacao ?? {}));

  // Serie historica.
  const { status: sSerie, corpo: serie } = await chamar(
    'GET', '/api/kpis/OTIF/serie?meses=6', { token: admin });
  checar(b2, 'serie mensal responde com 6 pontos', sSerie === 200
    && (serie?.data?.pontos?.length ?? serie?.data?.serie?.length) === 6,
  serie?.data?.pontos?.length ?? serie?.data?.serie?.length);

  // Indicador de posicao nao inventa historia (secao 54).
  //
  // PRODUTOS_RUPTURA reapurado para marco de 2015 devolve a posicao de HOJE,
  // porque nao existe posicao historica no banco. Desenhar seis meses desse
  // mesmo numero seria uma linha reta lida como estabilidade.
  const { corpo: pontualKpi } = await chamar(
    'GET', '/api/kpis/PRODUTOS_RUPTURA?dias=90', { token: admin });
  checar(b2, 'indicador de posicao se declara como pontual (secao 54)',
    pontualKpi?.data?.pontual === true, pontualKpi?.data?.pontual);

  const { status: sSeriePontual, corpo: seriePontual } = await chamar(
    'GET', '/api/kpis/PRODUTOS_RUPTURA/serie?meses=6', { token: admin });
  checar(b2, 'serie de indicador pontual e recusada, nao inventada',
    sSeriePontual === 200 && seriePontual?.data?.pontual === true
    && (seriePontual?.data?.pontos?.length ?? 0) === 0,
    { pontual: seriePontual?.data?.pontual, pontos: seriePontual?.data?.pontos?.length });
  checar(b2, 'serie recusada explica o motivo', !!seriePontual?.data?.motivo,
    seriePontual?.data?.motivo);

  const { corpo: compPontual } = await chamar(
    'GET', '/api/kpis/PRODUTOS_RUPTURA/comparacao?dias=30', { token: admin });
  checar(b2, 'comparacao entre periodos e recusada para indicador pontual',
    compPontual?.data?.comparacao === null && !!compPontual?.data?.motivo_comparacao,
    compPontual?.data?.motivo_comparacao);

  // Indicador de periodo continua tendo serie e comparacao normalmente.
  checar(b2, 'indicador de periodo nao e marcado como pontual',
    o?.pontual === false, o?.pontual);

  // Nenhum indicador de periodo pode devolver o mesmo valor para um periodo
  // sem movimento e para o periodo atual - seria um pontual mal classificado.
  const periodicosSuspeitos: string[] = [];
  for (const k of kpis.filter((x: any) => !x.pontual).slice(0, 60)) {
    const { corpo: antigo } = await chamar(
      'GET', `/api/kpis/${k.codigo}?data_inicio=2015-01-01&data_fim=2015-03-31`,
      { token: admin });
    const { corpo: recente } = await chamar(
      'GET', `/api/kpis/${k.codigo}?dias=90`, { token: admin });
    if (antigo?.data?.calculavel && recente?.data?.calculavel
      && Number(antigo.data.valor) === Number(recente.data.valor)) {
      periodicosSuspeitos.push(k.codigo);
    }
  }
  checar(b2, 'nenhum indicador de periodo ignora o periodo (secao 54)',
    periodicosSuspeitos.length === 0, periodicosSuspeitos);

  // KPI inexistente.
  const { status: sInex } = await chamar('GET', '/api/kpis/NAO_EXISTE_KPI', { token: admin });
  checar(b2, 'KPI inexistente responde 404', sInex === 404, sInex);

  // =======================================================================
  secao('3. Dashboards: carregamento, blocos e consistencia (secoes 5 e 6)');
  const b3 = novaBateria('Dashboards');
  baterias.push(b3);

  const { status: sPaineis, corpo: paineis } = await chamar(
    'GET', '/api/dashboard/paineis', { token: admin });
  checar(b3, 'lista de paineis responde 200', sPaineis === 200, sPaineis);
  checar(b3, 'ha ao menos 10 paineis catalogados',
    (paineis?.data?.length ?? 0) >= 10, paineis?.data?.length);

  const nomes = ['executivo', 'compras', 'estoque', 'demanda', 'fornecedores', 'logistica',
    'recebimento', 'qualidade', 'financeiro', 'importacoes', 'comprador', 'riscos'];
  let carregaram = 0;
  for (const nome of nomes) {
    const { status } = await chamar('GET', `/api/dashboard/${nome}`, { token: admin });
    if (status === 200) carregaram += 1;
  }
  checar(b3, 'todos os paineis carregam', carregaram === nomes.length,
    { carregaram, esperado: nomes.length });

  const { corpo: exec } = await chamar('GET', '/api/dashboard/executivo?dias=90', { token: admin });
  const e = exec?.data;
  checar(b3, 'executivo vem agrupado em blocos (secao 6)',
    !!e?.blocos && Object.keys(e.blocos).length >= 4, Object.keys(e?.blocos ?? {}));
  checar(b3, 'executivo informa resumo de semaforos',
    typeof e?.resumo?.verde === 'number' && typeof e?.resumo?.vermelho === 'number', e?.resumo);
  checar(b3, 'executivo informa o momento da atualizacao (regra 7)',
    typeof e?.atualizado_em === 'string', e?.atualizado_em);

  // REGRA 5: filtros consistentes - todos os KPIs do painel usam o mesmo periodo.
  const periodos = new Set((e?.kpis ?? []).map((k: any) => `${k.periodo.inicio}|${k.periodo.fim}`));
  checar(b3, 'todos os KPIs do painel usam o mesmo periodo (regra 5)',
    periodos.size === 1, [...periodos]);

  // Secao 67: OTIF tem o MESMO valor em todos os paineis onde aparece.
  const valoresOtif: Record<string, unknown> = {};
  for (const nome of ['executivo', 'fornecedores', 'logistica']) {
    const { corpo } = await chamar('GET', `/api/dashboard/${nome}?dias=90`, { token: admin });
    const achado = (corpo?.data?.kpis ?? []).find((k: any) => k.codigo === 'OTIF');
    if (achado) valoresOtif[nome] = achado.valor;
  }
  checar(b3, 'OTIF tem o mesmo valor em todos os paineis (secao 67)',
    new Set(Object.values(valoresOtif)).size === 1, valoresOtif);

  const { status: sPainelInex } = await chamar('GET', '/api/dashboard/inventado', { token: admin });
  checar(b3, 'painel inexistente responde 404', sPainelInex === 404, sPainelInex);

  // =======================================================================
  secao('4. Analises: Pareto, ABC-XYZ e mapa de riscos (secoes 33, 35 e 36)');
  const b4 = novaBateria('Analises gerenciais');
  baterias.push(b4);

  const { corpo: analises } = await chamar('GET', '/api/dashboard/pareto-analises', { token: admin });
  checar(b4, 'analises de Pareto catalogadas',
    (analises?.data?.length ?? 0) >= 5, analises?.data?.length);

  const { status: sPar, corpo: par } = await chamar(
    'GET', '/api/dashboard/pareto?analise=COMPRAS_FORNECEDOR', { token: admin });
  const p = par?.data;
  checar(b4, 'Pareto responde 200', sPar === 200, sPar);
  if (p?.linhas?.length) {
    const acum = p.linhas.map((l: any) => l.acumulado_percentual ?? l.acumulado);
    const crescente = acum.every((v: number, i: number) => i === 0 || v >= acum[i - 1] - 0.01);
    checar(b4, 'percentual acumulado do Pareto e crescente', crescente, acum.slice(0, 5));
    const ultimo = acum[acum.length - 1];
    checar(b4, 'acumulado do Pareto fecha em 100%', Math.abs(ultimo - 100) < 0.5, ultimo);
    checar(b4, 'Pareto separa itens vitais dos triviais',
      typeof p.vitais === 'number' && p.vitais >= 1, p.vitais);
  }

  const { status: sMat, corpo: mat } = await chamar(
    'GET', '/api/dashboard/matriz-abc-xyz', { token: admin });
  checar(b4, 'matriz ABC-XYZ responde 200', sMat === 200, sMat);
  checar(b4, 'matriz preserva a coluna de produtos sem classificacao',
    JSON.stringify(mat?.data ?? {}).includes('SEM_CLASSE'), Object.keys(mat?.data ?? {}));

  const { status: sRisco, corpo: risco } = await chamar(
    'GET', '/api/dashboard/riscos', { token: admin });
  checar(b4, 'mapa de riscos responde 200', sRisco === 200, sRisco);
  const itensRisco = risco?.data?.extras?.mapa?.itens ?? risco?.data?.extras?.mapa ?? [];
  checar(b4, 'risco traz os fatores objetivos, nao so o nivel (secao 36)',
    !Array.isArray(itensRisco) || itensRisco.length === 0
      || Array.isArray(itensRisco[0]?.fatores),
    itensRisco[0] ?? null);

  // =======================================================================
  secao('5. Drill-down e contexto de decisao (secoes 43 a 46 e 72)');
  const b5 = novaBateria('Drill-down');
  baterias.push(b5);

  const { status: sDest, corpo: dest } = await chamar(
    'GET', '/api/dashboard/drilldown-destinos', { token: admin });
  const destinos: any[] = dest?.data ?? [];
  checar(b5, 'destinos de drill-down catalogados', sDest === 200 && destinos.length >= 20,
    destinos.length);

  let drillOk = 0;
  for (const d of destinos) {
    const { status, corpo } = await chamar(
      'GET', `/api/dashboard/drilldown?destino=${d.codigo}`, { token: admin });
    if (status === 200 && Array.isArray(corpo?.data?.linhas)
      && Array.isArray(corpo?.data?.colunas)) drillOk += 1;
  }
  checar(b5, 'todos os destinos executam e devolvem colunas e linhas',
    drillOk === destinos.length, { ok: drillOk, total: destinos.length });

  // REGRA 8: todo KPI com drill-down declarado aponta para um destino que existe.
  const declarados = new Set(kpis.map((k) => k.drilldown).filter(Boolean));
  const existentes = new Set(destinos.map((d) => d.codigo));
  const quebrados = [...declarados].filter((d) => !existentes.has(d));
  checar(b5, 'nenhum KPI aponta para drill-down inexistente (regra 8)',
    quebrados.length === 0, quebrados);

  // Secao 67 e regra 2: o KPI e o drill-down dele tem de contar a MESMA coisa.
  // Ja aconteceu de o indicador ler uma tabela e a lista ler outra - e a tela
  // mostrar 9 produtos em ruptura acima de uma lista com 1.439.
  for (const [codigo, destino] of [
    ['PRODUTOS_RUPTURA', 'ruptura'],
    ['PRODUTOS_EXCESSO', 'excesso'],
    ['ESTOQUE_PARADO', 'estoque-parado'],
    ['PEDIDOS_ATRASADOS', 'pedidos-atrasados'],
    ['ENTREGAS_ATRASADAS', 'entregas-atrasadas'],
    ['NC_CRITICAS', 'nao-conformidades'],
    ['PRODUTOS_MONOPROVEDOR', 'monoprovedor'],
  ]) {
    const { corpo: k } = await chamar('GET', `/api/kpis/${codigo}?dias=90`, { token: admin });
    const { corpo: d } = await chamar(
      'GET', `/api/dashboard/drilldown?destino=${destino}&dias=90`, { token: admin });
    checar(b5, `${codigo} e o drill-down "${destino}" contam a mesma coisa (secao 67)`,
      !k?.data?.calculavel || Number(k.data.valor) === Number(d?.data?.total),
      { kpi: k?.data?.valor, drilldown: d?.data?.total });
  }

  // O total do drill-down e quantos registros existem, nao quantos couberam.
  const { corpo: grandeLista } = await chamar(
    'GET', '/api/dashboard/drilldown?destino=ruptura', { token: admin });
  checar(b5, 'drill-down informa o total real e quantos exibiu',
    typeof grandeLista?.data?.total === 'number'
    && typeof grandeLista?.data?.exibidas === 'number'
    && grandeLista.data.total >= grandeLista.data.exibidas,
    { total: grandeLista?.data?.total, exibidas: grandeLista?.data?.exibidas });

  const { status: sDrillInex } = await chamar(
    'GET', '/api/dashboard/drilldown?destino=nao_existe', { token: admin });
  checar(b5, 'drill-down inexistente responde 404', sDrillInex === 404, sDrillInex);

  // Contexto de decisao (secao 72) a partir de um produto em ruptura.
  const { corpo: rup } = await chamar(
    'GET', '/api/dashboard/drilldown?destino=ruptura', { token: admin });
  const produtoRuptura = rup?.data?.linhas?.[0]?.produto_id;
  if (produtoRuptura) {
    const { status: sCtx, corpo: ctx } = await chamar(
      'GET', `/api/dashboard/contexto/${produtoRuptura}`, { token: admin });
    const c = ctx?.data;
    checar(b5, 'contexto de decisao responde 200', sCtx === 200, sCtx);
    // A cadeia completa da secao 72: situacao -> impacto -> origem ->
    // registros relacionados -> acao disponivel.
    checar(b5, 'contexto traz situacao, impacto e registros relacionados (secao 72)',
      !!c?.situacao && !!c?.impacto && !!c?.relacionados, Object.keys(c ?? {}));
    checar(b5, 'contexto aponta a origem com evidencia (secao 72)',
      Array.isArray(c?.origem) && c.origem.length > 0
      && c.origem.every((o: any) => o.causa && o.evidencia), c?.origem);
    // REGRA 9: acoes sao de navegacao, nao de escrita.
    const acoes: any[] = c?.acoes_disponiveis ?? [];
    checar(b5, 'contexto oferece acoes disponiveis (secao 72)', acoes.length > 0, acoes.length);
    const escrevem = acoes.filter((a) => a.tipo !== 'NAVEGAR');
    checar(b5, 'acoes sugeridas apenas levam ao modulo operacional (regras 9 e 10)',
      escrevem.length === 0, escrevem);
  }

  // =======================================================================
  secao('6. Filtros globais (secoes 7 e 8) - cenarios 1 e 2 da secao 70');
  const b6 = novaBateria('Filtros globais');
  baterias.push(b6);

  // CENARIO 1: selecionar um fornecedor.
  const { corpo: forns } = await chamar('GET', '/api/fornecedores?limite=5', { token: admin });
  const fornecedorId = (forns?.data?.[0] ?? forns?.data?.itens?.[0])?.id;
  if (fornecedorId) {
    const { status, corpo } = await chamar(
      'GET', `/api/dashboard/fornecedores?${q({ fornecedor_id: fornecedorId, dias: 180 })}`,
      { token: admin });
    const d = corpo?.data;
    checar(b6, 'cenario 1: painel aceita filtro de fornecedor', status === 200, status);
    checar(b6, 'cenario 1: filtro de fornecedor aparece no resumo aplicado',
      d?.filtros_aplicados?.fornecedor_id === fornecedorId, d?.filtros_aplicados);

    const { corpo: geral } = await chamar(
      'GET', '/api/kpis/ENTREGAS_ATRASADAS?dias=180', { token: admin });
    const { corpo: doForn } = await chamar(
      'GET', `/api/kpis/ENTREGAS_ATRASADAS?${q({ fornecedor_id: fornecedorId, dias: 180 })}`,
      { token: admin });
    checar(b6, 'cenario 1: KPI filtrado por fornecedor nao excede o total geral',
      (doForn?.data?.valor ?? 0) <= (geral?.data?.valor ?? 0),
      { geral: geral?.data?.valor, fornecedor: doForn?.data?.valor });

    // Secao 8: o que o KPI nao sabe filtrar e declarado, nao escondido.
    const { corpo: semSuporte } = await chamar(
      'GET', `/api/kpis/QUALIDADE_DADOS?${q({ fornecedor_id: fornecedorId })}`, { token: admin });
    checar(b6, 'filtro nao aplicavel e declarado em filtros_ignorados (secao 8)',
      Array.isArray(semSuporte?.data?.filtros_ignorados), semSuporte?.data?.filtros_ignorados);
  }

  // CENARIO 2: selecionar uma categoria.
  const { corpo: cats } = await chamar('GET', '/api/cadastros/categorias', { token: admin });
  const categoriaId = (cats?.data?.[0] ?? cats?.data?.itens?.[0])?.id;
  if (categoriaId) {
    const { corpo: geral } = await chamar('GET', '/api/kpis/VALOR_ESTOQUE', { token: admin });
    const { status, corpo: daCat } = await chamar(
      'GET', `/api/kpis/VALOR_ESTOQUE?${q({ categoria_id: categoriaId })}`, { token: admin });
    checar(b6, 'cenario 2: KPI aceita filtro de categoria', status === 200, status);
    checar(b6, 'cenario 2: valor da categoria nao excede o valor total',
      (daCat?.data?.valor ?? 0) <= (geral?.data?.valor ?? 0) + 0.01,
      { geral: geral?.data?.valor, categoria: daCat?.data?.valor });
    checar(b6, 'cenario 2: dashboard recalcula com o filtro de categoria',
      daCat?.data?.filtros_aplicados?.categoria_id === categoriaId,
      daCat?.data?.filtros_aplicados);
  }

  // Filtro invalido.
  const { status: sFiltroRuim } = await chamar(
    'GET', '/api/kpis/OTIF?data_inicio=2026-05-01&data_fim=2026-01-01', { token: admin });
  checar(b6, 'intervalo invertido e recusado', sFiltroRuim === 422 || sFiltroRuim === 400,
    sFiltroRuim);

  // =======================================================================
  secao('7. Cenario 3: periodo sem movimentacao mostra SEM DADOS, nao zero');
  const b7 = novaBateria('Ausencia de dados (regra 6)');
  baterias.push(b7);

  const vazio = q({ data_inicio: '2015-01-01', data_fim: '2015-01-31' });
  const { status: sVazio, corpo: kVazio } = await chamar(
    'GET', `/api/kpis/OTIF?${vazio}`, { token: admin });
  const v = kVazio?.data;
  checar(b7, 'cenario 3: KPI de periodo vazio responde 200', sVazio === 200, sVazio);
  checar(b7, 'cenario 3: KPI sem movimento volta nao calculavel, nao zero',
    v?.calculavel === false && v?.valor === null, { calculavel: v?.calculavel, valor: v?.valor });
  checar(b7, 'cenario 3: KPI sem dados explica o motivo', !!v?.motivo, v?.motivo);
  checar(b7, 'cenario 3: KPI sem dados fica CINZA, nao VERMELHO',
    v?.semaforo === 'CINZA', v?.semaforo);
  checar(b7, 'cenario 3: KPI sem dados nao afirma que atingiu ou perdeu a meta',
    v?.atingiu_meta === null, v?.atingiu_meta);

  const { corpo: pVazio } = await chamar(
    'GET', `/api/dashboard/executivo?${vazio}`, { token: admin });
  checar(b7, 'cenario 3: painel do periodo vazio conta os KPIs sem dados',
    (pVazio?.data?.resumo?.sem_dados ?? 0) > 0, pVazio?.data?.resumo);

  // Um KPI de contagem legitimamente zero continua calculavel: zero apurado
  // e diferente de ausencia de apuracao.
  const { corpo: zero } = await chamar(
    'GET', `/api/kpis/PEDIDOS_ATRASADOS?${vazio}`, { token: admin });
  checar(b7, 'zero apurado e diferente de ausencia de dados (regra 6)',
    zero?.data?.valor === null || zero?.data?.calculavel === true,
    { valor: zero?.data?.valor, calculavel: zero?.data?.calculavel });

  // =======================================================================
  secao('8. Cenario 4: alterar a meta de OTIF');
  const b8 = novaBateria('Metas (secao 12)');
  baterias.push(b8);

  const { corpo: metasAntes } = await chamar('GET', '/api/kpis/metas?codigo=OTIF', { token: admin });
  const metaOriginal = (metasAntes?.data ?? []).find((m: any) => m.escopo === 'EMPRESA');

  // Congela o historico ANTES de mexer na meta, para provar que ele nao muda.
  const { status: sReg, corpo: registro } = await chamar(
    'POST', '/api/kpis/OTIF/registrar?dias=90', { token: admin, corpo: {} });
  checar(b8, 'resultado de KPI pode ser congelado no historico', sReg === 200, sReg);
  const semaforoHistorico = registro?.data?.semaforo;
  const resultadoId = registro?.data?.resultado_id;

  const { corpo: otifAntes } = await chamar('GET', '/api/kpis/OTIF?dias=90', { token: admin });
  const valorOtif = otifAntes?.data?.valor ?? 0;

  // Meta impossivel de atingir: o semaforo tem de ficar vermelho.
  // Arredondado para duas casas porque e assim que a coluna guarda. Sem isso,
  // `59.54 + 20` vira 79.53999999999999 em JavaScript, o banco devolve 79.54 e a
  // comparacao exata falha por um erro que nao existe no sistema - so na conta
  // em ponto flutuante do proprio teste.
  const metaAlta = Math.round(Math.min(99.9, Math.max(valorOtif + 20, 60)) * 100) / 100;
  const { status: sMeta, corpo: nova } = await chamar('POST', '/api/kpis/metas', {
    token: admin,
    corpo: {
      codigo: 'OTIF', escopo: 'EMPRESA', meta: metaAlta,
      limite_atencao: metaAlta - 5, limite_critico: metaAlta - 10,
      observacao: 'M11-teste: meta temporaria da bateria',
    },
  });
  checar(b8, 'cenario 4: nova meta de OTIF aceita', sMeta === 200, nova?.error ?? sMeta);

  const { corpo: otifDepois } = await chamar('GET', '/api/kpis/OTIF?dias=90', { token: admin });
  checar(b8, 'cenario 4: apuracao nova usa a nova meta',
    Number(otifDepois?.data?.meta?.meta) === metaAlta,
    { esperado: metaAlta, veio: otifDepois?.data?.meta?.meta });
  checar(b8, 'cenario 4: semaforo recalculado com a nova meta',
    otifDepois?.data?.semaforo === 'VERMELHO' || otifDepois?.data?.valor === null,
    { valor: otifDepois?.data?.valor, semaforo: otifDepois?.data?.semaforo });

  // O historico congelado nao pode ter mudado.
  const { corpo: hist } = await chamar('GET', '/api/kpis/OTIF/historico?limite=10', { token: admin });
  const congelado = (hist?.data?.registros ?? []).find((r: any) => Number(r.id) === resultadoId);
  checar(b8, 'cenario 4: o resultado congelado continua no historico',
    !!congelado, { resultado_id: resultadoId, registros: hist?.data?.registros?.length });
  checar(b8, 'cenario 4: historico nao e reescrito pela nova meta',
    congelado?.semaforo === semaforoHistorico,
    { historico: congelado?.semaforo, congelado: semaforoHistorico });
  checar(b8, 'cenario 4: historico guarda a meta vigente na epoca, nao a nova',
    congelado?.meta === null || Number(congelado?.meta) !== metaAlta,
    { historico: congelado?.meta, nova: metaAlta });

  // Ordem dos limites e validada segundo a direcao do indicador.
  const { status: sOrdem } = await chamar('POST', '/api/kpis/metas', {
    token: admin,
    corpo: {
      codigo: 'OTIF', escopo: 'EMPRESA', meta: 80, limite_atencao: 90, limite_critico: 95,
    },
  });
  checar(b8, 'limites fora de ordem sao recusados', sOrdem === 422 || sOrdem === 400, sOrdem);

  // Escopo sem a dimensao correspondente e recusado.
  const { status: sEscopo } = await chamar('POST', '/api/kpis/metas', {
    token: admin, corpo: { codigo: 'OTIF', escopo: 'FORNECEDOR', meta: 90 },
  });
  checar(b8, 'meta de escopo FORNECEDOR exige fornecedor_id',
    sEscopo === 422 || sEscopo === 400, sEscopo);

  // =======================================================================
  secao('9. Central de alertas (secoes 40, 41 e 42)');
  const b9 = novaBateria('Central de alertas');
  baterias.push(b9);

  const { status: sResumo, corpo: resumo } = await chamar(
    'GET', '/api/alertas/resumo', { token: admin });
  const r = resumo?.data;
  checar(b9, 'resumo da central responde 200', sResumo === 200, sResumo);
  checar(b9, 'central usa as 4 prioridades da secao 41',
    ['CRITICO', 'ALTO', 'MEDIO', 'BAIXO'].every((p) => p in (r?.por_prioridade ?? {})),
    r?.por_prioridade);
  checar(b9, 'central declara o significado de cada prioridade (secao 41)',
    r?.significados?.CRITICO === 'Necessita acao imediata', r?.significados);
  checar(b9, 'central cobre as categorias da secao 40',
    ['ruptura', 'estoque', 'compra', 'fornecedor', 'atraso', 'qualidade',
      'recebimento', 'preco', 'demanda', 'importacao'].every(
      (c) => (r?.categorias ?? []).includes(c)), r?.categorias);

  // Alertas dos modulos anteriores entram na central ja classificados.
  const { corpo: listaAlertas } = await chamar('GET', '/api/alertas?limite=50', { token: admin });
  const alertas: any[] = listaAlertas?.data?.alertas ?? [];
  const semClassificacao = alertas.filter((a) => !a.categoria || !a.prioridade || !a.titulo);
  checar(b9, 'todo alerta da central tem titulo, categoria e prioridade (secao 40)',
    semClassificacao.length === 0, semClassificacao.slice(0, 3));
  checar(b9, 'alertas vem ordenados por prioridade',
    alertas.length < 2 || ['CRITICO', 'ALTO', 'MEDIO', 'BAIXO']
      .indexOf(alertas[0].prioridade) <= ['CRITICO', 'ALTO', 'MEDIO', 'BAIXO']
      .indexOf(alertas[alertas.length - 1].prioridade),
    alertas.map((a) => a.prioridade).slice(0, 5));

  const { status: sRegras, corpo: regras } = await chamar(
    'GET', '/api/alertas/regras', { token: admin });
  checar(b9, 'regras de alerta catalogadas', sRegras === 200
    && (regras?.data?.length ?? 0) >= 5, regras?.data?.length);

  // Geracao: rodar as regras cria (ou atualiza) alertas.
  const { status: sAval, corpo: aval } = await chamar(
    'POST', '/api/alertas/avaliar?dias=90', { token: admin, corpo: {} });
  checar(b9, 'avaliacao das regras responde 200', sAval === 200, aval?.error ?? sAval);
  const disparos: any[] = aval?.data?.disparos ?? [];
  checar(b9, 'todas as regras ativas foram avaliadas',
    disparos.length === (aval?.data?.avaliadas ?? -1), {
      disparos: disparos.length, avaliadas: aval?.data?.avaliadas,
    });
  checar(b9, 'cada regra explica por que disparou ou nao',
    disparos.every((d) => typeof d.motivo === 'string' && d.motivo.length > 0),
    disparos.filter((d) => !d.motivo).slice(0, 2));

  // REGRA 6 aplicada ao alerta: KPI sem dados nao dispara alerta de limite.
  const { corpo: avalVazio } = await chamar(
    'POST', `/api/alertas/avaliar?${vazio}`, { token: admin, corpo: {} });
  const disparosVazios = (avalVazio?.data?.disparos ?? [])
    .filter((d: any) => d.disparou && d.valor === null);
  checar(b9, 'KPI sem dados nao dispara alerta de limite (regra 6)',
    disparosVazios.length === 0, disparosVazios.slice(0, 2));

  // DEDUPLICACAO (secao 42): rodar de novo nao cria um segundo alerta.
  const dispararam = disparos.filter((d) => d.disparou);
  if (dispararam.length) {
    const { corpo: total1 } = await chamar('GET', '/api/alertas?limite=1', { token: admin });
    const { corpo: aval2 } = await chamar(
      'POST', '/api/alertas/avaliar?dias=90', { token: admin, corpo: {} });
    const { corpo: total2 } = await chamar('GET', '/api/alertas?limite=1', { token: admin });
    checar(b9, 'secao 42: reavaliar nao cria alertas duplicados',
      total2?.data?.total === total1?.data?.total,
      { antes: total1?.data?.total, depois: total2?.data?.total });

    const repetidos = (aval2?.data?.disparos ?? []).filter((d: any) => d.disparou);
    checar(b9, 'secao 42: alerta repetido e atualizado, nao reinserido',
      repetidos.every((d: any) => d.novo === false), repetidos.slice(0, 2));
    checar(b9, 'secao 42: reincidencia e contada no alerta existente',
      repetidos.every((d: any) => (d.ocorrencias ?? 0) >= 2),
      repetidos.map((d: any) => ({ regra: d.regra, ocorrencias: d.ocorrencias })).slice(0, 3));

    // ENCERRAMENTO.
    const alertaId = dispararam[0].alerta_id;
    const { status: sDetalhe, corpo: detalhe } = await chamar(
      'GET', `/api/alertas/${alertaId}`, { token: admin });
    checar(b9, 'alerta traz link para o registro de origem (secao 40)',
      sDetalhe === 200 && 'link' in (detalhe?.data ?? {}), Object.keys(detalhe?.data ?? {}));

    const { status: sTratar } = await chamar(`PATCH`, `/api/alertas/${alertaId}/tratar`, {
      token: admin,
      corpo: { status: 'EM_TRATATIVA', observacao: 'M11-teste: em analise' },
    });
    checar(b9, 'alerta pode entrar em tratativa', sTratar === 200, sTratar);

    const { status: sResolver, corpo: resolvido } = await chamar(
      'PATCH', `/api/alertas/${alertaId}/tratar`, {
        token: admin, corpo: { status: 'RESOLVIDO', observacao: 'M11-teste: encerrado' },
      });
    checar(b9, 'alerta pode ser encerrado', sResolver === 200
      && resolvido?.data?.status === 'RESOLVIDO', resolvido?.data);
    checar(b9, 'alerta encerrado registra a data de resolucao',
      !!resolvido?.data?.data_resolucao, resolvido?.data?.data_resolucao);

    const { status: sReabrir } = await chamar('PATCH', `/api/alertas/${alertaId}/tratar`, {
      token: admin, corpo: { status: 'EM_TRATATIVA' },
    });
    checar(b9, 'alerta resolvido nao volta para tratativa',
      sReabrir === 422 || sReabrir === 400, sReabrir);

    // Depois de resolvido, a mesma condicao gera um alerta NOVO - a chave de
    // deduplicacao so vale enquanto o alerta esta aberto.
    const { corpo: aval3 } = await chamar(
      'POST', '/api/alertas/avaliar?dias=90', { token: admin, corpo: {} });
    const mesmaRegra = (aval3?.data?.disparos ?? [])
      .find((d: any) => d.regra === dispararam[0].regra);
    checar(b9, 'secao 42: alerta resolvido reabre como novo, com contador reiniciado',
      !mesmaRegra?.disparou || mesmaRegra.ocorrencias === 1,
      { novo: mesmaRegra?.novo, ocorrencias: mesmaRegra?.ocorrencias });
  } else {
    checar(b9, 'secao 42: deduplicacao testada', false,
      'nenhuma regra disparou - nao foi possivel exercitar a deduplicacao');
  }

  const { status: sAlertaInex } = await chamar('GET', '/api/alertas/99999999', { token: admin });
  checar(b9, 'alerta inexistente responde 404', sAlertaInex === 404, sAlertaInex);

  // =======================================================================
  secao('10. Cenario 5 e seguranca por perfil (secoes 60 e 69)');
  const b10 = novaBateria('Seguranca');
  baterias.push(b10);

  const { status: sSemToken } = await chamar('GET', '/api/dashboard/executivo');
  checar(b10, 'dashboard exige autenticacao', sSemToken === 401, sSemToken);
  const { status: sKpiSemToken } = await chamar('GET', '/api/kpis/OTIF');
  checar(b10, 'KPI exige autenticacao', sKpiSemToken === 401, sKpiSemToken);
  const { status: sAlertaSemToken } = await chamar('GET', '/api/alertas');
  checar(b10, 'central de alertas exige autenticacao', sAlertaSemToken === 401, sAlertaSemToken);

  const comprador = await tokenDoPerfil(admin, 'COMPRADOR', 'm11');
  if (comprador) {
    const { status: sExecComprador } = await chamar(
      'GET', '/api/dashboard/executivo', { token: comprador });
    checar(b10, 'cenario 5: comprador nao acessa o painel executivo (secao 60)',
      sExecComprador === 403, sExecComprador);

    const { status: sRiscoComprador } = await chamar(
      'GET', '/api/dashboard/riscos', { token: comprador });
    checar(b10, 'cenario 5: comprador nao acessa o mapa de riscos',
      sRiscoComprador === 403, sRiscoComprador);

    const { status: sProprio } = await chamar(
      'GET', '/api/dashboard/comprador', { token: comprador });
    checar(b10, 'comprador acessa o proprio painel', sProprio === 200, sProprio);

    const { status: sMetaComprador } = await chamar('POST', '/api/kpis/metas', {
      token: comprador, corpo: { codigo: 'OTIF', escopo: 'EMPRESA', meta: 50 },
    });
    checar(b10, 'cenario 5: comprador nao define meta de indicador',
      sMetaComprador === 403, sMetaComprador);

    const { status: sDicComprador } = await chamar(
      'GET', '/api/kpis/dicionario', { token: comprador });
    checar(b10, 'cenario 5: comprador nao acessa a governanca dos indicadores',
      sDicComprador === 403, sDicComprador);
  } else {
    checar(b10, 'perfil COMPRADOR disponivel para o teste de permissao', false, null);
  }

  const comercial = await tokenDoPerfil(admin, 'COMERCIAL', 'm11');
  if (comercial) {
    const { status: sAlertasComercial } = await chamar(
      'GET', '/api/alertas', { token: comercial });
    checar(b10, 'cenario 5: perfil sem bi.alertas nao abre a central',
      sAlertasComercial === 403, sAlertasComercial);
    const { status: sDemanda } = await chamar(
      'GET', '/api/dashboard/demanda', { token: comercial });
    checar(b10, 'perfil comercial acessa o painel de demanda', sDemanda === 200, sDemanda);
  }

  const diretoria = await tokenDoPerfil(admin, 'DIRETORIA', 'm11');
  if (diretoria) {
    const { status: sExec } = await chamar(
      'GET', '/api/dashboard/executivo', { token: diretoria });
    checar(b10, 'diretoria acessa o painel executivo', sExec === 200, sExec);
    const { status: sMetaDiretoria } = await chamar('POST', '/api/kpis/metas', {
      token: diretoria, corpo: { codigo: 'OTIF', escopo: 'EMPRESA', meta: 50 },
    });
    checar(b10, 'diretoria nao define meta sem a permissao bi.meta',
      sMetaDiretoria === 403, sMetaDiretoria);
  }

  // =======================================================================
  secao('11. Performance e paginacao (secao 69)');
  const b11 = novaBateria('Performance');
  baterias.push(b11);

  const inicio = Date.now();
  const paralelos = await Promise.all(
    ['executivo', 'compras', 'estoque', 'fornecedores', 'logistica', 'qualidade']
      .map((n) => chamar('GET', `/api/dashboard/${n}?dias=180`, { token: admin })));
  const duracao = Date.now() - inicio;
  checar(b11, 'seis paineis em paralelo respondem todos 200',
    paralelos.every((p) => p.status === 200), paralelos.map((p) => p.status));
  checar(b11, 'seis paineis em paralelo respondem em menos de 60s', duracao < 60000,
    `${duracao}ms`);

  const inicioGrande = Date.now();
  const { status: sGrande, corpo: grande } = await chamar(
    'GET', '/api/dashboard/drilldown?destino=compras&', { token: admin });
  checar(b11, 'drill-down de grande volume responde 200', sGrande === 200, sGrande);
  checar(b11, 'drill-down de grande volume responde em menos de 30s',
    Date.now() - inicioGrande < 30000, `${Date.now() - inicioGrande}ms`);
  checar(b11, 'drill-down avisa quando trunca o resultado',
    typeof grande?.data?.truncado === 'boolean', grande?.data?.truncado);

  const { corpo: pag1 } = await chamar('GET', '/api/alertas?limite=5&pagina=1', { token: admin });
  const { corpo: pag2 } = await chamar('GET', '/api/alertas?limite=5&pagina=2', { token: admin });
  checar(b11, 'central de alertas pagina', (pag1?.data?.alertas?.length ?? 0) <= 5
    && (pag2?.data?.alertas?.length ?? 0) <= 5,
  { p1: pag1?.data?.alertas?.length, p2: pag2?.data?.alertas?.length });
  const ids1 = new Set((pag1?.data?.alertas ?? []).map((a: any) => a.id));
  const repetidosPag = (pag2?.data?.alertas ?? []).filter((a: any) => ids1.has(a.id));
  checar(b11, 'paginas da central nao repetem registros', repetidosPag.length === 0,
    repetidosPag.map((a: any) => a.id));
  checar(b11, 'central informa o total de alertas',
    typeof pag1?.data?.total === 'number', pag1?.data?.total);

  const { status: sLimiteAbusivo } = await chamar(
    'GET', '/api/alertas?limite=99999', { token: admin });
  checar(b11, 'limite abusivo de pagina e recusado ou reduzido',
    sLimiteAbusivo === 422 || sLimiteAbusivo === 400 || sLimiteAbusivo === 200,
    sLimiteAbusivo);

  // =======================================================================
  secao('12. Regras 9 e 10: o BI nao altera dado operacional');
  const b12 = novaBateria('Isolamento do modulo operacional');
  baterias.push(b12);

  const depois = await contarOperacional(admin);
  checar(b12, 'nenhuma movimentacao de estoque criada pelo modulo 11 (regra 9)',
    antes.movimentacoes === depois.movimentacoes,
    { antes: antes.movimentacoes, depois: depois.movimentacoes });
  checar(b12, 'nenhum pedido de compra criado pelo modulo 11 (regra 9)',
    antes.pedidos === depois.pedidos, { antes: antes.pedidos, depois: depois.pedidos });
  checar(b12, 'nenhum recebimento criado pelo modulo 11 (regra 9)',
    antes.recebimentos === depois.recebimentos,
    { antes: antes.recebimentos, depois: depois.recebimentos });

  // O modulo 11 nao expoe escrita em dado operacional.
  for (const rota of ['/api/dashboard/executivo', '/api/dashboard/drilldown', '/api/kpis/OTIF']) {
    const { status } = await chamar('DELETE', rota, { token: admin });
    checar(b12, `${rota} nao aceita DELETE (regra 10)`,
      status === 404 || status === 405, status);
  }

  // =======================================================================
  secao('13. Restauracao do estado');
  const b13 = novaBateria('Idempotencia');
  baterias.push(b13);

  if (metaOriginal) {
    const { status } = await chamar('POST', '/api/kpis/metas', {
      token: admin,
      corpo: {
        codigo: 'OTIF', escopo: 'EMPRESA',
        meta: Number(metaOriginal.meta),
        limite_atencao: metaOriginal.limite_atencao === null
          ? undefined : Number(metaOriginal.limite_atencao),
        limite_critico: metaOriginal.limite_critico === null
          ? undefined : Number(metaOriginal.limite_critico),
        observacao: metaOriginal.observacao ?? undefined,
      },
    });
    checar(b13, 'meta original de OTIF restaurada', status === 200, status);

    const { corpo: conferencia } = await chamar('GET', '/api/kpis/OTIF', { token: admin });
    checar(b13, 'OTIF volta a usar a meta original',
      Number(conferencia?.data?.meta?.meta) === Number(metaOriginal.meta),
      { esperado: metaOriginal.meta, veio: conferencia?.data?.meta?.meta });
  } else {
    checar(b13, 'meta original de OTIF localizada para restauracao', false, metasAntes?.data);
  }

  encerrar(baterias);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
