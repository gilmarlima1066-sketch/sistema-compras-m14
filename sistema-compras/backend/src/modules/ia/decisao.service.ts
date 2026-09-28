/**
 * Central de Decisao (secao 30), resumo diario (secao 44) e os assistentes
 * por dominio (secoes 5 a 16).
 *
 * A Central responde as dez perguntas da secao 30 lendo o que os modulos
 * anteriores ja apuraram. Os "assistentes" nao sao dez motores diferentes: sao
 * dez recortes do mesmo conjunto de analises, filtrados pelo dominio que o
 * perfil do usuario pode ver (secao 38).
 *
 * Nada aqui escreve em dado operacional (secao 48).
 */
import { query } from '../../config/database.js';
import { hojeLocal } from '../../core/datas.js';
import { apurar, type ResultadoKpi } from '../bi/kpi.service.js';
import {
  anomaliasFornecedor, anomaliasPreco, anomaliasPrevisao, centralRiscos,
  lacunasCadastro, mapaConcentracao, produtosEmFoco, situacaoProdutos,
  avaliarRiscoProduto, type SituacaoProduto,
} from './analise.service.js';
import { auditarProdutos } from './qualidade.js';
import { projetarRuptura, diferencaDias } from './calculos.js';
import { fato, calculo, previsao, type Evidencia } from './evidencias.js';
import { listar as listarRecomendacoes, resumo as resumoRecomendacoes } from './recomendacoes.service.js';
import { podeVer, type ConfigIA, type Dominio, type SessaoIA } from './contexto.js';

const num = (v: unknown) => Number(v ?? 0);
const arred = (v: number, c = 2) => Math.round(v * 10 ** c) / 10 ** c;

/** Bloco de resposta com a natureza declarada e o caminho para o detalhe. */
export interface BlocoDecisao {
  pergunta: string;
  resposta: string;
  quantidade: number;
  valor: number | null;
  itens: Array<Record<string, unknown>>;
  evidencias: Evidencia[];
  drilldown: string | null;
  limitacao: string | null;
}

// ---------------------------------------------------------------------------
// Blocos
// ---------------------------------------------------------------------------

async function blocoRuptura(cfg: ConfigIA): Promise<BlocoDecisao> {
  const hoje = hojeLocal();

  /*
   * O total vem do banco, nao da amostra.
   *
   * Projetar em TypeScript sobre os 300 produtos de maior impacto daria um
   * "300 produtos podem romper" que e o tamanho do recorte, nao a resposta -
   * e o numero ficaria colado no teto para sempre. A contagem roda em SQL
   * sobre a base inteira, com a mesma regra da projecao: saldo / demanda, e
   * fora quem ja tem chegada prevista antes do fim do saldo.
   */
  const { rows: contagem } = await query<Record<string, unknown>>(`
    WITH base AS (
      SELECT v.produto_id,
             v.estoque_disponivel                        AS disponivel,
             v.demanda_media_diaria                      AS demanda,
             coalesce(p.custo_referencia, 0)             AS custo,
             (SELECT min(oci.data_prometida) FROM ordem_compra_itens oci
                JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
               WHERE oci.produto_id = v.produto_id AND oci.quantidade_pendente > 0
                 AND oci.data_prometida >= CURRENT_DATE
                 AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')) AS chegada
        FROM vw_estoque_atual v
        JOIN produtos p ON p.id = v.produto_id
       WHERE p.ativo AND p.deleted_at IS NULL AND v.demanda_media_diaria > 0
    ), projetada AS (
      SELECT *,
             floor(greatest(disponivel, 0) / demanda)::int AS dias_ate_ruptura
        FROM base
    )
    SELECT count(*)                                        AS total,
           count(*) FILTER (WHERE disponivel <= 0)          AS ja_em_ruptura,
           coalesce(sum(demanda * custo * 7), 0)            AS impacto_semanal
      FROM projetada
     WHERE dias_ate_ruptura <= $1::int
       AND (chegada IS NULL
            OR (chegada - CURRENT_DATE) > dias_ate_ruptura)`, [cfg.horizonteRupturaDias]);

  const totais = contagem[0] ?? {};

  const ids = await produtosEmFoco(300, false);
  const situacoes = await situacaoProdutos(ids, cfg);

  const emRisco = situacoes
    .map((s) => {
      const chegada = s.proxima_chegada ? diferencaDias(hoje, s.proxima_chegada) : null;
      const proj = projetarRuptura(s.disponivel, s.demanda_diaria, hoje, chegada);
      return { s, proj };
    })
    .filter(({ proj }) => !proj.cobertoPorPedido
      && (proj.jaEmRuptura
        || (proj.diasAteRuptura !== null && proj.diasAteRuptura <= cfg.horizonteRupturaDias)))
    .sort((a, b) => (a.proj.diasAteRuptura ?? 0) - (b.proj.diasAteRuptura ?? 0));

  const total = num(totais.total);
  const jaEmRuptura = num(totais.ja_em_ruptura);
  const impacto = num(totais.impacto_semanal);

  return {
    pergunta: 'Quais produtos podem romper?',
    resposta: total === 0
      ? `Nenhum produto com ruptura projetada para os proximos ${cfg.horizonteRupturaDias} dias`
      : `${total} produto(s) com ruptura projetada em ate ${cfg.horizonteRupturaDias} dias`
        + (jaEmRuptura > 0 ? `, sendo ${jaEmRuptura} ja sem estoque hoje` : '')
        + (total > emRisco.length
          ? `; os ${Math.min(20, emRisco.length)} de maior impacto aparecem abaixo` : ''),
    quantidade: total,
    valor: arred(impacto),
    itens: emRisco.slice(0, 20).map(({ s, proj }) => ({
      produto_id: s.produto_id,
      codigo: s.codigo,
      descricao: s.descricao,
      disponivel: arred(s.disponivel, 3),
      demanda_diaria: arred(s.demanda_diaria, 3),
      dias_ate_ruptura: proj.diasAteRuptura,
      data_provavel: proj.dataProvavel,
      ja_em_ruptura: proj.jaEmRuptura,
      impacto_semanal: arred(s.demanda_diaria * s.custo * 7),
      pedidos_abertos: s.pedidos_abertos,
      fornecedores: s.fornecedores,
    })),
    evidencias: [
      fato('Base inteira de produtos com demanda avaliada em consulta agregada',
        'Modulo 03 e 04 - estoque e demanda'),
      previsao(`${total} produto(s) com saldo projetado para acabar em ate `
        + `${cfg.horizonteRupturaDias} dias`,
      'Modulo 12 - projecao sobre demanda media', { valor: total }),
      fato(`${jaEmRuptura} produto(s) ja sem estoque disponivel hoje`,
        'Modulo 03 - vw_estoque_atual', { valor: jaEmRuptura }),
    ],
    drilldown: 'ruptura',
    limitacao: total > emRisco.length
      ? `Lista limitada aos ${emRisco.length} de maior impacto; o total e ${total}`
      : null,
  };
}

async function blocoComprar(cfg: ConfigIA): Promise<BlocoDecisao> {
  const { rows } = await query<Record<string, unknown>>(`
    SELECT n.id, n.produto_id, p.codigo, p.descricao, n.prioridade::text AS prioridade,
           n.quantidade_sugerida, n.valor_estimado, n.data_necessaria, n.status::text AS status
      FROM necessidades_compra n
      JOIN produtos p ON p.id = n.produto_id
     WHERE n.status IN ('PENDENTE', 'EM_ANALISE', 'APROVADA', 'AJUSTADA')
     ORDER BY CASE n.prioridade::text
                WHEN 'RUPTURA' THEN 1 WHEN 'CRITICA' THEN 2 WHEN 'ALTA' THEN 3
                WHEN 'MEDIA' THEN 4 ELSE 5 END,
              n.data_necessaria
     LIMIT 20`);

  const { rows: agregado } = await query<Record<string, unknown>>(`
    SELECT count(*) AS itens, coalesce(sum(valor_estimado), 0) AS valor,
           count(*) FILTER (WHERE prioridade::text IN ('RUPTURA','CRITICA')) AS criticas
      FROM necessidades_compra
     WHERE status IN ('PENDENTE', 'EM_ANALISE', 'APROVADA', 'AJUSTADA')`);

  const a = agregado[0] ?? {};

  return {
    pergunta: 'O que precisa ser comprado?',
    resposta: num(a.itens) === 0
      ? 'Nenhuma necessidade de compra em aberto'
      : `${num(a.itens)} necessidade(s) em aberto, ${num(a.criticas)} critica(s), `
        + `somando ${arred(num(a.valor))}`,
    quantidade: num(a.itens),
    valor: arred(num(a.valor)),
    itens: rows,
    evidencias: [
      fato(`${num(a.itens)} necessidade(s) de compra em aberto`,
        'Modulo 05 - planejamento de compras', { valor: num(a.itens) }),
      calculo(`Valor estimado de ${arred(num(a.valor))}`,
        'Modulo 05 - necessidades_compra', { valor: arred(num(a.valor)), unidade: 'R$' }),
    ],
    drilldown: 'necessidades',
    limitacao: null,
  };
}

async function blocoAtrasos(): Promise<BlocoDecisao> {
  const { rows } = await query<Record<string, unknown>>(`
    SELECT oc.id AS ordem_compra_id, oc.numero, f.razao_social AS fornecedor,
           p.codigo, p.descricao, oci.quantidade_pendente, oci.data_prometida,
           (CURRENT_DATE - oci.data_prometida) AS dias_atraso,
           oci.quantidade_pendente * oci.preco_unitario AS valor_pendente
      FROM ordem_compra_itens oci
      JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
      JOIN fornecedores f   ON f.id = oc.fornecedor_id
      JOIN produtos p       ON p.id = oci.produto_id
     WHERE oci.quantidade_pendente > 0
       AND oci.data_prometida < CURRENT_DATE
       AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')
     ORDER BY dias_atraso DESC
     LIMIT 20`);

  const { rows: agregado } = await query<Record<string, unknown>>(`
    SELECT count(*) AS itens,
           coalesce(sum(oci.quantidade_pendente * oci.preco_unitario), 0) AS valor,
           count(DISTINCT oc.fornecedor_id) AS fornecedores
      FROM ordem_compra_itens oci
      JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
     WHERE oci.quantidade_pendente > 0 AND oci.data_prometida < CURRENT_DATE
       AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')`);

  const a = agregado[0] ?? {};

  return {
    pergunta: 'O que esta atrasado?',
    resposta: num(a.itens) === 0
      ? 'Nenhum item de pedido com promessa vencida'
      : `${num(a.itens)} item(ns) atrasado(s) em ${num(a.fornecedores)} fornecedor(es), `
        + `${arred(num(a.valor))} pendentes`,
    quantidade: num(a.itens),
    valor: arred(num(a.valor)),
    itens: rows,
    evidencias: [
      fato(`${num(a.itens)} item(ns) com data prometida vencida`,
        'Modulo 08 - acompanhamento de pedidos', { valor: num(a.itens) }),
    ],
    drilldown: 'pedidos-atrasados',
    limitacao: null,
  };
}

async function blocoExcesso(cfg: ConfigIA): Promise<BlocoDecisao> {
  const { rows } = await query<Record<string, unknown>>(`
    SELECT * FROM (
      SELECT v.produto_id, v.codigo, v.descricao, v.estoque_disponivel,
             v.cobertura_dias, v.demanda_media_diaria,
             least(nullif(v.demanda_media_diaria, 0) * 90, nullif(p.estoque_maximo, 0)) AS maximo,
             (v.estoque_disponivel
               - least(nullif(v.demanda_media_diaria, 0) * 90, nullif(p.estoque_maximo, 0)))
               * coalesce(p.custo_referencia, 0) AS valor_excedente
        FROM vw_estoque_atual v
        JOIN produtos p ON p.id = v.produto_id
       WHERE p.ativo AND p.deleted_at IS NULL
    ) x
     WHERE x.maximo IS NOT NULL AND x.estoque_disponivel > x.maximo
     ORDER BY x.valor_excedente DESC
     LIMIT 20`);

  const valor = rows.reduce((a, r) => a + num(r.valor_excedente), 0);

  return {
    pergunta: 'Onde existe excesso?',
    resposta: rows.length === 0
      ? 'Nenhum produto acima do maximo aceitavel'
      : `${rows.length} produto(s) acima do maximo, ${arred(valor)} imobilizados`,
    quantidade: rows.length,
    valor: arred(valor),
    itens: rows,
    evidencias: [
      calculo('Maximo aceitavel = menor entre cobertura de 90 dias e estoque maximo cadastrado',
        'Modulo 12 - criterio de excesso'),
    ],
    drilldown: 'excesso',
    limitacao: null,
  };
}

async function blocoFornecedores(cfg: ConfigIA): Promise<BlocoDecisao> {
  const varredura = await anomaliasFornecedor(cfg, 10);
  const { rows } = await query<Record<string, unknown>>(`
    SELECT f.id AS fornecedor_id, f.razao_social,
           f.status_homologacao::text AS situacao, f.score_atual,
           (SELECT count(*) FROM ordem_compra_itens oci
              JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
             WHERE oc.fornecedor_id = f.id AND oci.quantidade_pendente > 0
               AND oci.data_prometida < CURRENT_DATE
               AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')) AS itens_atrasados
      FROM fornecedores f
     WHERE f.deleted_at IS NULL
       AND (f.status_homologacao::text IN ('BLOQUEADO', 'EM_MONITORAMENTO')
            OR EXISTS (SELECT 1 FROM ordem_compra_itens oci
                         JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
                        WHERE oc.fornecedor_id = f.id AND oci.quantidade_pendente > 0
                          AND oci.data_prometida < CURRENT_DATE
                          AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')))
     ORDER BY itens_atrasados DESC, f.score_atual NULLS LAST
     LIMIT 20`);

  return {
    pergunta: 'Quais fornecedores exigem atencao?',
    resposta: rows.length === 0 && varredura.achados.length === 0
      ? 'Nenhum fornecedor bloqueado, monitorado ou com pedido atrasado'
      : `${rows.length} fornecedor(es) com situacao ou atraso a tratar`
        + (varredura.achados.length
          ? `, ${varredura.achados.length} com piora de pontualidade` : ''),
    quantidade: rows.length,
    valor: null,
    itens: rows.map((r) => ({
      ...r,
      anomalia: varredura.achados.find((a) => a.entidade_id === Number(r.fornecedor_id)) ?? null,
    })),
    evidencias: [
      fato(`${rows.length} fornecedor(es) bloqueado(s), monitorado(s) ou com atraso`,
        'Modulos 08 e 10', { valor: rows.length }),
    ],
    drilldown: 'fornecedores',
    limitacao: varredura.motivo_sem_base,
  };
}

async function blocoPrecos(cfg: ConfigIA): Promise<BlocoDecisao> {
  const varredura = await anomaliasPreco(cfg, 15);
  const altas = varredura.achados.filter((a) => a.direcao === 'ACIMA');

  return {
    pergunta: 'Quais precos mudaram?',
    resposta: varredura.achados.length === 0
      ? 'Nenhuma variacao de preco fora do padrao'
      : `${varredura.achados.length} produto(s) com variacao fora do padrao, `
        + `${altas.length} em alta`,
    quantidade: varredura.achados.length,
    valor: null,
    itens: varredura.achados.map((a) => ({
      produto_id: a.entidade_id,
      rotulo: a.rotulo,
      preco_atual: a.valor_atual,
      mediana_historica: a.valor_esperado,
      variacao_percentual: a.diferenca_percentual,
      direcao: a.direcao,
      periodo: a.periodo,
      possivel_causa: a.possivel_causa,
      recomendacao: a.recomendacao,
    })),
    evidencias: [
      calculo(`Limite de variacao anormal: ${cfg.variacaoPrecoAnormal}% contra a mediana`,
        'Modulo 12 - configuracao ia.variacao_preco_anormal'),
    ],
    drilldown: 'precos',
    limitacao: varredura.motivo_sem_base,
  };
}

async function blocoEconomia(cfg: ConfigIA): Promise<BlocoDecisao> {
  const lista = await listarRecomendacoes({
    status: 'NOVA', limite: 20,
  });
  const oportunidades = (lista.recomendacoes as Array<Record<string, unknown>>)
    .filter((r) => ['REDUZIR_EXCESSO', 'NEGOCIACAO', 'TROCA_FORNECEDOR',
      'CONSOLIDAR_PEDIDOS', 'TRANSFERENCIA'].includes(String(r.tipo)));

  const valor = oportunidades.reduce((a, r) => a + num(r.impacto_estimado), 0);

  return {
    pergunta: 'Quais oportunidades de economia existem?',
    resposta: oportunidades.length === 0
      ? 'Nenhuma oportunidade de economia identificada acima do limite configurado'
      : `${oportunidades.length} oportunidade(s), ${arred(valor)} estimados`,
    quantidade: oportunidades.length,
    valor: arred(valor),
    itens: oportunidades,
    evidencias: [
      calculo(`Limite minimo para reportar: ${arred(cfg.economiaMinima)}`,
        'Modulo 12 - configuracao ia.economia_minima_reportar'),
    ],
    drilldown: null,
    limitacao: null,
  };
}

async function blocoRiscos(cfg: ConfigIA): Promise<BlocoDecisao> {
  const central = await centralRiscos(cfg, 20);
  const criticos = central.riscos.filter((r) => r.risco.nivel === 'CRITICO');

  return {
    pergunta: 'Onde existe risco?',
    resposta: central.riscos.length === 0
      ? 'Nenhum risco acima de BAIXO identificado'
      : `${central.riscos.length} risco(s) identificado(s), ${criticos.length} critico(s)`,
    quantidade: central.riscos.length,
    valor: arred(central.riscos.reduce((a, r) => a + r.impacto_diario, 0)),
    itens: central.riscos.slice(0, 20).map((r) => ({
      produto_id: r.produto_id,
      codigo: r.codigo,
      descricao: r.descricao,
      tipo: r.tipo,
      nivel: r.risco.nivel,
      probabilidade: r.risco.probabilidade,
      impacto: r.risco.impacto,
      fatores: r.risco.fatores,
      dias_ate_ruptura: r.dias_ate_ruptura,
      impacto_diario: r.impacto_diario,
    })),
    evidencias: [
      calculo(central.metodologia, 'Modulo 12 - central de riscos'),
      fato(`${central.avaliados} produto(s) avaliados`, 'Modulo 12',
        { valor: central.avaliados }),
    ],
    drilldown: 'criticos',
    limitacao: null,
  };
}

async function blocoAtencao(cfg: ConfigIA): Promise<BlocoDecisao> {
  const resumo = await resumoRecomendacoes();
  const abertas = resumo.por_status.NOVA + resumo.por_status.EM_ANALISE;
  const criticas = resumo.por_prioridade.CRITICO + resumo.por_prioridade.ALTO;

  return {
    pergunta: 'O que precisa de atencao?',
    resposta: abertas === 0
      ? 'Nenhuma recomendacao em aberto'
      : `${abertas} recomendacao(oes) em aberto, ${criticas} de prioridade alta ou critica`,
    quantidade: abertas,
    valor: resumo.impacto_em_aberto,
    itens: resumo.por_tipo,
    evidencias: [
      fato(`${abertas} recomendacao(oes) aguardando decisao`,
        'Modulo 12 - central de recomendacoes', { valor: abertas }),
    ],
    drilldown: null,
    limitacao: null,
  };
}

async function blocoPrioridades(cfg: ConfigIA): Promise<BlocoDecisao> {
  const lista = await listarRecomendacoes({ status: 'NOVA', limite: 10 });

  return {
    pergunta: 'Quais acoes devem ser priorizadas?',
    resposta: lista.total === 0
      ? 'Nenhuma acao pendente'
      : `${lista.total} acao(oes) pendente(s); as 10 de maior score aparecem abaixo`,
    quantidade: lista.total,
    valor: null,
    itens: lista.recomendacoes,
    evidencias: [
      calculo(`Score = impacto x ${cfg.pesoImpacto} + urgencia x ${cfg.pesoUrgencia} `
        + `+ criticidade x ${cfg.pesoCriticidade}`,
      'Modulo 12 - priorizacao (secao 31)'),
    ],
    drilldown: null,
    limitacao: null,
  };
}

// ---------------------------------------------------------------------------
// Central de Decisao (secao 30)
// ---------------------------------------------------------------------------

/**
 * As dez perguntas da secao 30, respondidas com dado de hoje.
 *
 * Os blocos rodam em paralelo porque sao independentes - e porque a Central e
 * a primeira tela que a pessoa abre de manha: dez consultas em serie fariam
 * dela uma tela de espera.
 *
 * Blocos fora do escopo do perfil nao sao omitidos silenciosamente: eles vem
 * com a resposta trocada pela negativa, para a pessoa saber que existe algo ali
 * que ela nao ve (secao 38).
 */
export async function centralDecisao(cfg: ConfigIA, sessao: SessaoIA) {
  const permitido = (d: Dominio) => podeVer(sessao, d);

  const [atencao, comprar, atrasos, riscos, excesso, fornecedores, precos,
    ruptura, economia, prioridades] = await Promise.all([
    permitido('COMPRAS') ? blocoAtencao(cfg) : null,
    permitido('COMPRAS') ? blocoComprar(cfg) : null,
    permitido('PEDIDOS') ? blocoAtrasos() : null,
    permitido('RISCOS') ? blocoRiscos(cfg) : null,
    permitido('ESTOQUE') ? blocoExcesso(cfg) : null,
    permitido('FORNECEDORES') ? blocoFornecedores(cfg) : null,
    permitido('COMPRAS') ? blocoPrecos(cfg) : null,
    permitido('ESTOQUE') ? blocoRuptura(cfg) : null,
    permitido('COMPRAS') ? blocoEconomia(cfg) : null,
    permitido('COMPRAS') ? blocoPrioridades(cfg) : null,
  ]);

  const negado = (pergunta: string, dominio: Dominio): BlocoDecisao => ({
    pergunta,
    resposta: `Seu perfil nao tem acesso a informacoes de ${dominio.toLowerCase()}`,
    quantidade: 0,
    valor: null,
    itens: [],
    evidencias: [],
    drilldown: null,
    limitacao: 'Acesso restrito pelo perfil',
  });

  return {
    data: hojeLocal(),
    perfil: sessao.perfil,
    blocos: [
      atencao ?? negado('O que precisa de atencao?', 'COMPRAS'),
      comprar ?? negado('O que precisa ser comprado?', 'COMPRAS'),
      atrasos ?? negado('O que esta atrasado?', 'PEDIDOS'),
      riscos ?? negado('Onde existe risco?', 'RISCOS'),
      excesso ?? negado('Onde existe excesso?', 'ESTOQUE'),
      fornecedores ?? negado('Quais fornecedores exigem atencao?', 'FORNECEDORES'),
      precos ?? negado('Quais precos mudaram?', 'COMPRAS'),
      ruptura ?? negado('Quais produtos podem romper?', 'ESTOQUE'),
      economia ?? negado('Quais oportunidades de economia existem?', 'COMPRAS'),
      prioridades ?? negado('Quais acoes devem ser priorizadas?', 'COMPRAS'),
    ],
    observacao: 'A IA apresenta o quadro e recomenda. A execucao continua no modulo '
      + 'operacional, com a alcada do usuario.',
    apurado_em: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Resumo diario (secao 44)
// ---------------------------------------------------------------------------

/**
 * Resumo do dia em quatro faixas (secao 44).
 *
 * Classifica por consequencia, nao por origem: um alerta critico de qualidade e
 * uma ruptura de classe A entram na mesma faixa, porque ambos exigem acao hoje.
 */
export async function resumoDiario(cfg: ConfigIA, sessao: SessaoIA) {
  const central = await centralDecisao(cfg, sessao);
  const bloco = (p: string) => central.blocos.find((b) => b.pergunta.startsWith(p));

  const ruptura = bloco('Quais produtos podem romper');
  const atrasos = bloco('O que esta atrasado');
  const riscos = bloco('Onde existe risco');
  const excesso = bloco('Onde existe excesso');
  const precos = bloco('Quais precos mudaram');
  const economia = bloco('Quais oportunidades');
  const comprar = bloco('O que precisa ser comprado');
  const fornecedores = bloco('Quais fornecedores');

  const criticos: string[] = [];
  const atencao: string[] = [];
  const oportunidades: string[] = [];

  // Vem da contagem agregada do bloco, nao da amostra exibida.
  const emRupturaHoje = num((ruptura?.evidencias ?? [])
    .find((e) => e.afirmacao.includes('ja sem estoque disponivel hoje'))?.valor);
  if (emRupturaHoje > 0) {
    criticos.push(`${emRupturaHoje} produto(s) ja sem estoque disponivel`);
  }
  const riscosCriticos = (riscos?.itens ?? []).filter((i) => i.nivel === 'CRITICO').length;
  if (riscosCriticos > 0) criticos.push(`${riscosCriticos} risco(s) classificado(s) como critico`);

  if ((ruptura?.quantidade ?? 0) - emRupturaHoje > 0) {
    atencao.push(`${(ruptura?.quantidade ?? 0) - emRupturaHoje} produto(s) com ruptura `
      + `projetada em ate ${cfg.horizonteRupturaDias} dias`);
  }
  if ((atrasos?.quantidade ?? 0) > 0) {
    atencao.push(`${atrasos?.quantidade} item(ns) de pedido com promessa vencida`);
  }
  if ((precos?.quantidade ?? 0) > 0) {
    atencao.push(`${precos?.quantidade} produto(s) com variacao de preco fora do padrao`);
  }
  if ((fornecedores?.quantidade ?? 0) > 0) {
    atencao.push(`${fornecedores?.quantidade} fornecedor(es) exigindo tratativa`);
  }

  if ((excesso?.quantidade ?? 0) > 0) {
    oportunidades.push(`${excesso?.quantidade} produto(s) em excesso, `
      + `${arred(excesso?.valor ?? 0)} imobilizados`);
  }
  if ((economia?.quantidade ?? 0) > 0) {
    oportunidades.push(`${economia?.quantidade} oportunidade(s) de economia, `
      + `${arred(economia?.valor ?? 0)} estimados`);
  }

  const kpis = await indicadoresDoDia(sessao);

  return {
    data: hojeLocal(),
    perfil: sessao.perfil,
    critico: {
      titulo: 'Exige atencao imediata',
      itens: criticos,
      quantidade: criticos.length,
    },
    atencao: {
      titulo: 'Pode gerar impacto',
      itens: atencao,
      quantidade: atencao.length,
    },
    oportunidades: {
      titulo: 'Possiveis economias e melhorias',
      itens: oportunidades,
      quantidade: oportunidades.length,
    },
    indicadores: kpis,
    compras: {
      necessidades_abertas: comprar?.quantidade ?? 0,
      valor_estimado: comprar?.valor ?? 0,
      principais: (comprar?.itens ?? []).slice(0, 5),
    },
    logistica: {
      itens_atrasados: atrasos?.quantidade ?? 0,
      valor_pendente: atrasos?.valor ?? 0,
      principais: (atrasos?.itens ?? []).slice(0, 5),
    },
    fornecedores: {
      exigindo_atencao: fornecedores?.quantidade ?? 0,
      principais: (fornecedores?.itens ?? []).slice(0, 5),
    },
    estoque: {
      em_ruptura: emRupturaHoje,
      ruptura_projetada: (ruptura?.quantidade ?? 0) - emRupturaHoje,
      em_excesso: excesso?.quantidade ?? 0,
      valor_excesso: excesso?.valor ?? 0,
    },
    apurado_em: new Date().toISOString(),
  };
}

/**
 * Os KPIs do dia vem do motor do modulo 11 (secao 25).
 *
 * Nenhum e recalculado aqui: se o resumo da IA mostrasse um OTIF diferente do
 * painel, o sistema passaria a ter duas verdades sobre o mesmo numero.
 */
async function indicadoresDoDia(sessao: SessaoIA) {
  const codigos: Array<{ codigo: string; dominio: Dominio }> = [
    { codigo: 'PRODUTOS_RUPTURA', dominio: 'ESTOQUE' },
    { codigo: 'COBERTURA_MEDIA', dominio: 'ESTOQUE' },
    { codigo: 'VALOR_ESTOQUE', dominio: 'ESTOQUE' },
    { codigo: 'PEDIDOS_ATRASADOS', dominio: 'PEDIDOS' },
    { codigo: 'OTIF', dominio: 'LOGISTICA' },
    { codigo: 'COMPRAS_EM_ABERTO', dominio: 'COMPRAS' },
  ];

  const permitidos = codigos.filter((c) => podeVer(sessao, c.dominio));
  const resultados = await Promise.all(
    permitidos.map(async (c) => {
      try {
        return await apurar(c.codigo, { dias: 90 });
      } catch {
        return null;
      }
    }));

  return resultados
    .filter((r): r is ResultadoKpi => r !== null)
    .map((r) => ({
      codigo: r.codigo,
      nome: r.nome,
      valor: r.valor,
      unidade: r.unidade,
      calculavel: r.calculavel,
      motivo: r.motivo ?? null,
      semaforo: r.semaforo,
      meta: r.meta?.meta ?? null,
      fonte: 'Modulo 11 - motor de KPI (definicao oficial unica)',
    }));
}

// ---------------------------------------------------------------------------
// Assistentes por dominio (secoes 5 a 16)
// ---------------------------------------------------------------------------

export const ASSISTENTES: Record<string, { titulo: string; dominio: Dominio }> = {
  COMPRAS:      { titulo: 'Assistente de compras',      dominio: 'COMPRAS' },
  ESTOQUE:      { titulo: 'Assistente de estoque',      dominio: 'ESTOQUE' },
  DEMANDA:      { titulo: 'Assistente de demanda',      dominio: 'DEMANDA' },
  FORNECEDORES: { titulo: 'Assistente de fornecedores', dominio: 'FORNECEDORES' },
  COTACOES:     { titulo: 'Assistente de cotacoes',     dominio: 'COTACOES' },
  PEDIDOS:      { titulo: 'Assistente de pedidos',      dominio: 'PEDIDOS' },
  LOGISTICA:    { titulo: 'Assistente de logistica',    dominio: 'LOGISTICA' },
  QUALIDADE:    { titulo: 'Assistente de qualidade',    dominio: 'QUALIDADE' },
  RISCOS:       { titulo: 'Analise de riscos',          dominio: 'RISCOS' },
};

/**
 * Um assistente e um recorte das analises, filtrado pelo dominio.
 *
 * Nao sao nove motores: e o mesmo conjunto de analises visto por nove angulos.
 * Fazer nove implementacoes separadas garantiria que, em algum momento, duas
 * delas respondessem coisas diferentes sobre a mesma pergunta.
 */
export async function assistente(
  nome: string, cfg: ConfigIA, sessao: SessaoIA,
) {
  const def = ASSISTENTES[nome.toUpperCase()];
  if (!def) {
    return {
      assistente: nome,
      erro: 'Assistente desconhecido',
      disponiveis: Object.keys(ASSISTENTES),
    };
  }

  if (!podeVer(sessao, def.dominio)) {
    return {
      assistente: nome.toUpperCase(),
      titulo: def.titulo,
      acesso: 'NEGADO',
      mensagem: `Seu perfil nao tem acesso a informacoes de ${def.dominio.toLowerCase()}.`,
      blocos: [],
    };
  }

  const blocos: BlocoDecisao[] = [];

  switch (def.dominio) {
    case 'COMPRAS':
      blocos.push(await blocoComprar(cfg), await blocoPrecos(cfg),
        await blocoEconomia(cfg), await blocoPrioridades(cfg));
      break;
    case 'ESTOQUE':
      blocos.push(await blocoRuptura(cfg), await blocoExcesso(cfg));
      break;
    case 'DEMANDA': {
      const varredura = await anomaliasPrevisao(cfg, 20);
      blocos.push({
        pergunta: 'A previsao esta descrevendo a demanda?',
        resposta: varredura.achados.length === 0
          ? `Nenhuma previsao com erro acima de ${cfg.mapeMaximo}%`
          : `${varredura.achados.length} previsao(oes) com erro acima de ${cfg.mapeMaximo}%`,
        quantidade: varredura.achados.length,
        valor: null,
        itens: varredura.achados.map((a) => ({
          produto_id: a.entidade_id, rotulo: a.rotulo, mape: a.valor_atual,
          limite: a.valor_esperado, periodo: a.periodo,
          possivel_causa: a.possivel_causa, recomendacao: a.recomendacao,
        })),
        evidencias: [fato(`Limite de erro aceitavel: ${cfg.mapeMaximo}%`,
          'Modulo 12 - configuracao ia.mape_maximo_aceitavel')],
        drilldown: 'previsoes',
        limitacao: varredura.motivo_sem_base,
      });
      break;
    }
    case 'FORNECEDORES': {
      const conc = await mapaConcentracao(cfg);
      blocos.push(await blocoFornecedores(cfg), {
        pergunta: 'Ha dependencia de fornecimento?',
        resposta: conc.concentracao.interpretacao,
        quantidade: conc.produtos_monoprovedor,
        valor: conc.valor_total,
        itens: conc.fornecedores,
        evidencias: [
          calculo(`HHI de ${conc.concentracao.hhi}, maior participacao de `
            + `${conc.concentracao.maiorParticipacao}%`, 'Modulo 12 - concentracao'),
          fato(`${conc.produtos_monoprovedor} produto(s) com fornecedor unico`,
            'Modulo 02 - produto x fornecedor', { valor: conc.produtos_monoprovedor }),
        ],
        drilldown: 'monoprovedor',
        limitacao: null,
      });
      break;
    }
    case 'PEDIDOS':
    case 'LOGISTICA':
      blocos.push(await blocoAtrasos());
      break;
    case 'RISCOS':
      blocos.push(await blocoRiscos(cfg));
      break;
    case 'QUALIDADE': {
      const { rows } = await query<Record<string, unknown>>(`
        SELECT f.id AS fornecedor_id, f.razao_social,
               count(nc.id) AS nao_conformidades,
               count(nc.id) FILTER (WHERE nc.severidade::text = 'CRITICA') AS criticas
          FROM fornecedores f
          JOIN nao_conformidades nc ON nc.fornecedor_id = f.id
         WHERE f.deleted_at IS NULL AND nc.created_at >= CURRENT_DATE - 180
         GROUP BY f.id, f.razao_social
        HAVING count(nc.id) > 0
         ORDER BY criticas DESC, nao_conformidades DESC
         LIMIT 20`);
      blocos.push({
        pergunta: 'Onde a qualidade esta piorando?',
        resposta: rows.length === 0
          ? 'Nenhuma nao conformidade nos ultimos 180 dias'
          : `${rows.length} fornecedor(es) com nao conformidade nos ultimos 180 dias`,
        quantidade: rows.length,
        valor: null,
        itens: rows,
        evidencias: [fato(`${rows.length} fornecedor(es) com NC registrada`,
          'Modulo 09 - nao conformidades', { valor: rows.length })],
        drilldown: 'nao-conformidades',
        limitacao: null,
      });
      break;
    }
    case 'COTACOES': {
      const { rows } = await query<Record<string, unknown>>(`
        SELECT c.id, c.numero, c.status::text AS status, c.data_limite,
               count(DISTINCT cf.fornecedor_id) AS fornecedores,
               count(DISTINCT ci.produto_id)    AS produtos
          FROM cotacoes c
          LEFT JOIN cotacao_fornecedores cf ON cf.cotacao_id = c.id
          LEFT JOIN cotacao_itens ci        ON ci.cotacao_id = c.id
         WHERE c.status::text NOT IN ('ENCERRADA', 'CANCELADA')
         GROUP BY c.id
         ORDER BY c.data_limite NULLS LAST
         LIMIT 20`);
      blocos.push({
        pergunta: 'Quais cotacoes estao em andamento?',
        resposta: rows.length === 0
          ? 'Nenhuma cotacao em aberto'
          : `${rows.length} cotacao(oes) em aberto`,
        quantidade: rows.length,
        valor: null,
        itens: rows,
        evidencias: [fato(`${rows.length} cotacao(oes) em aberto`,
          'Modulo 06 - cotacoes', { valor: rows.length })],
        drilldown: null,
        limitacao: null,
      });
      break;
    }
    default:
      break;
  }

  return {
    assistente: nome.toUpperCase(),
    titulo: def.titulo,
    acesso: 'PERMITIDO',
    blocos,
    apurado_em: new Date().toISOString(),
  };
}
