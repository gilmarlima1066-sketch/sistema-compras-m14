/**
 * Analise: onde o dado do banco vira fato, anomalia e risco.
 *
 * Este arquivo responde as secoes 6, 7, 8, 13, 14, 15, 16, 17, 18 e 33. Ele le
 * dos modulos anteriores e NAO recalcula o que eles ja calculam: OTIF, giro,
 * cobertura e qualquer indicador vem do motor de KPI do modulo 11; a previsao
 * vem do modulo 04; a necessidade de compra, do modulo 05.
 *
 * O que ele acrescenta e o que nenhum dos anteriores faz: cruzar. Ruptura
 * projetada e uma conta de estoque; ruptura projetada COM pedido atrasado do
 * unico fornecedor homologado e um risco - e e essa leitura conjunta que a
 * secao 3 pede.
 */
import { query } from '../../config/database.js';
import { hojeLocal } from '../../core/datas.js';
import {
  analisarPreco, classificarRisco, detectarAnomalia, medirConcentracao,
  projetarRuptura, diferencaDias,
  type FatorRisco, type Risco,
} from './calculos.js';
import { avaliarConfianca, fato, calculo, previsao, hipotese, type Evidencia } from './evidencias.js';
import { auditarProdutos, type QualidadeDados } from './qualidade.js';
import type { ConfigIA } from './contexto.js';

const num = (v: unknown) => Number(v ?? 0);
const txt = (v: unknown) => (v === null || v === undefined ? null : String(v));

// ---------------------------------------------------------------------------
// Situacao consolidada de um produto (secao 24)
// ---------------------------------------------------------------------------

export interface SituacaoProduto {
  produto_id: number;
  codigo: string;
  descricao: string;
  categoria: string | null;
  classe_abc: string | null;
  disponivel: number;
  em_transito: number;
  quarentena: number;
  demanda_diaria: number;
  cobertura_dias: number | null;
  custo: number;
  estoque_minimo: number;
  estoque_maximo: number;
  ponto_pedido: number;
  estoque_seguranca: number;
  fornecedores: number;
  lead_time: number | null;
  preco_atual: number | null;
  pedidos_abertos: number;
  quantidade_pendente: number;
  proxima_chegada: string | null;
  pedidos_atrasados: number;
  ultima_venda: string | null;
  lotes_vencendo: number;
  quantidade_vencendo: number;
}

const SQL_SITUACAO = `
  SELECT p.id                                   AS produto_id,
         p.codigo, p.descricao,
         c.nome                                 AS categoria,
         p.classificacao_abc::text              AS classe_abc,
         coalesce(v.estoque_disponivel, 0)      AS disponivel,
         coalesce(v.estoque_em_transito, 0)     AS em_transito,
         coalesce(v.estoque_quarentena, 0)      AS quarentena,
         coalesce(v.demanda_media_diaria, 0)    AS demanda_diaria,
         v.cobertura_dias,
         coalesce(p.custo_referencia, 0)        AS custo,
         coalesce(p.estoque_minimo, 0)          AS estoque_minimo,
         coalesce(p.estoque_maximo, 0)          AS estoque_maximo,
         coalesce(p.ponto_pedido, 0)            AS ponto_pedido,
         coalesce(p.estoque_seguranca, 0)       AS estoque_seguranca,
         (SELECT count(*) FROM produto_fornecedor pf
           JOIN fornecedores f ON f.id = pf.fornecedor_id
          WHERE pf.produto_id = p.id AND pf.ativo AND f.deleted_at IS NULL) AS fornecedores,
         (SELECT min(coalesce(pf.lead_time_dias, f.lead_time_padrao_dias))
            FROM produto_fornecedor pf JOIN fornecedores f ON f.id = pf.fornecedor_id
           WHERE pf.produto_id = p.id AND pf.ativo
             AND coalesce(pf.lead_time_dias, f.lead_time_padrao_dias) > 0) AS lead_time,
         (SELECT min(pf.preco_atual) FROM produto_fornecedor pf
           WHERE pf.produto_id = p.id AND pf.ativo AND pf.preco_atual > 0) AS preco_atual,
         (SELECT count(DISTINCT oci.ordem_compra_id) FROM ordem_compra_itens oci
           JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
          WHERE oci.produto_id = p.id AND oci.quantidade_pendente > 0
            AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA'))      AS pedidos_abertos,
         (SELECT coalesce(sum(oci.quantidade_pendente), 0) FROM ordem_compra_itens oci
           JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
          WHERE oci.produto_id = p.id AND oci.quantidade_pendente > 0
            AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA'))      AS quantidade_pendente,
         (SELECT min(oci.data_prometida) FROM ordem_compra_itens oci
           JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
          WHERE oci.produto_id = p.id AND oci.quantidade_pendente > 0
            AND oci.data_prometida >= CURRENT_DATE
            AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA'))      AS proxima_chegada,
         (SELECT count(*) FROM ordem_compra_itens oci
           JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
          WHERE oci.produto_id = p.id AND oci.quantidade_pendente > 0
            AND oci.data_prometida < CURRENT_DATE
            AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA'))      AS pedidos_atrasados,
         (SELECT max(ve.data_venda) FROM itens_venda iv
           JOIN vendas ve ON ve.id = iv.venda_id
          WHERE iv.produto_id = p.id)                                       AS ultima_venda,
         (SELECT count(*) FROM lotes l
          WHERE l.produto_id = p.id AND l.quantidade_atual > 0
            AND l.data_validade IS NOT NULL
            AND l.data_validade <= CURRENT_DATE + $2::int)                  AS lotes_vencendo,
         (SELECT coalesce(sum(l.quantidade_atual), 0) FROM lotes l
          WHERE l.produto_id = p.id AND l.quantidade_atual > 0
            AND l.data_validade IS NOT NULL
            AND l.data_validade <= CURRENT_DATE + $2::int)                  AS quantidade_vencendo
    FROM produtos p
    LEFT JOIN categorias c        ON c.id = p.categoria_id
    LEFT JOIN vw_estoque_atual v  ON v.produto_id = p.id
   WHERE p.ativo AND p.deleted_at IS NULL AND p.id = ANY($1::bigint[])`;

export async function situacaoProdutos(
  ids: number[], cfg: ConfigIA,
): Promise<SituacaoProduto[]> {
  if (!ids.length) return [];
  const { rows } = await query<Record<string, unknown>>(
    SQL_SITUACAO, [ids, cfg.diasValidadeRisco]);
  return rows.map((r) => ({
    produto_id: Number(r.produto_id),
    codigo: String(r.codigo),
    descricao: String(r.descricao),
    categoria: txt(r.categoria),
    classe_abc: txt(r.classe_abc),
    disponivel: num(r.disponivel),
    em_transito: num(r.em_transito),
    quarentena: num(r.quarentena),
    demanda_diaria: num(r.demanda_diaria),
    cobertura_dias: r.cobertura_dias === null ? null : num(r.cobertura_dias),
    custo: num(r.custo),
    estoque_minimo: num(r.estoque_minimo),
    estoque_maximo: num(r.estoque_maximo),
    ponto_pedido: num(r.ponto_pedido),
    estoque_seguranca: num(r.estoque_seguranca),
    fornecedores: num(r.fornecedores),
    lead_time: r.lead_time === null ? null : num(r.lead_time),
    preco_atual: r.preco_atual === null ? null : num(r.preco_atual),
    pedidos_abertos: num(r.pedidos_abertos),
    quantidade_pendente: num(r.quantidade_pendente),
    proxima_chegada: r.proxima_chegada ? String(r.proxima_chegada).slice(0, 10) : null,
    pedidos_atrasados: num(r.pedidos_atrasados),
    ultima_venda: r.ultima_venda ? String(r.ultima_venda).slice(0, 10) : null,
    lotes_vencendo: num(r.lotes_vencendo),
    quantidade_vencendo: num(r.quantidade_vencendo),
  }));
}

/**
 * Os produtos que merecem analise: em risco, nao a base inteira.
 *
 * `apenasAnalisaveis` restringe a quem tem fornecedor ativo vinculado. A
 * distincao existe porque um produto sem fornecedor nao gera recomendacao
 * operacional - gera recomendacao de cadastro, que e outro assunto e tem outro
 * dono. Misturar os dois faria a central de compras abrir com centenas de
 * "corrija o cadastro" e enterrar as compras que precisam sair hoje.
 */
export async function produtosEmFoco(
  limite = 200, apenasAnalisaveis = false,
): Promise<number[]> {
  const { rows } = await query<{ produto_id: string }>(`
    SELECT v.produto_id
      FROM vw_estoque_atual v
      JOIN produtos p ON p.id = v.produto_id
     WHERE p.ativo AND p.deleted_at IS NULL
       AND v.demanda_media_diaria > 0
       AND ($2::boolean IS NOT TRUE OR EXISTS (
             SELECT 1 FROM produto_fornecedor pf
               JOIN fornecedores f ON f.id = pf.fornecedor_id
              WHERE pf.produto_id = p.id AND pf.ativo AND f.deleted_at IS NULL))
     /*
      * A ordem e por GRAVIDADE primeiro, valor depois.
      *
      * Ordenar so por impacto financeiro fazia o recorte encher de produtos
      * caros e confortaveis, enquanto um classe A ja em ruptura - de valor
      * menor - ficava de fora da analise. Para quem compra, a situacao pesa
      * antes do valor: primeiro quem ja falta, depois quem vai faltar, e
      * dentro de cada grupo o de maior impacto.
      */
     ORDER BY CASE
                WHEN v.estoque_disponivel <= 0                     THEN 0
                WHEN coalesce(v.cobertura_dias, 999) <= 7          THEN 1
                WHEN coalesce(v.cobertura_dias, 999) <= 30         THEN 2
                ELSE 3
              END,
              (v.demanda_media_diaria * coalesce(p.custo_referencia, 0)) DESC,
              coalesce(v.cobertura_dias, 0) ASC
     LIMIT $1`, [limite, apenasAnalisaveis]);
  return rows.map((r) => Number(r.produto_id));
}

/**
 * Lacunas de cadastro agregadas por tipo (secao 27).
 *
 * Devolve UMA linha por lacuna, com a contagem e os produtos de maior impacto,
 * em vez de uma linha por produto. Duas mil recomendacoes dizendo a mesma coisa
 * nao sao duas mil informacoes: sao uma informacao repetida duas mil vezes, e
 * a repeticao esconde o resto da central.
 */
export async function lacunasCadastro(limiteExemplos = 10) {
  const { rows } = await query<Record<string, unknown>>(`
    SELECT 'SEM_FORNECEDOR' AS lacuna, p.id, p.codigo, p.descricao,
           coalesce(v.demanda_media_diaria,0) * coalesce(p.custo_referencia,0) AS impacto
      FROM produtos p
      LEFT JOIN vw_estoque_atual v ON v.produto_id = p.id
     WHERE p.ativo AND p.deleted_at IS NULL
       AND coalesce(v.demanda_media_diaria,0) > 0
       AND NOT EXISTS (SELECT 1 FROM produto_fornecedor pf
                         JOIN fornecedores f ON f.id = pf.fornecedor_id
                        WHERE pf.produto_id = p.id AND pf.ativo AND f.deleted_at IS NULL)
    UNION ALL
    SELECT 'SEM_CUSTO', p.id, p.codigo, p.descricao,
           coalesce(v.demanda_media_diaria,0)
      FROM produtos p
      LEFT JOIN vw_estoque_atual v ON v.produto_id = p.id
     WHERE p.ativo AND p.deleted_at IS NULL
       AND coalesce(v.demanda_media_diaria,0) > 0
       AND coalesce(p.custo_referencia,0) = 0
    UNION ALL
    SELECT 'SEM_PARAMETROS', p.id, p.codigo, p.descricao,
           coalesce(v.demanda_media_diaria,0) * coalesce(p.custo_referencia,0)
      FROM produtos p
      LEFT JOIN vw_estoque_atual v ON v.produto_id = p.id
     WHERE p.ativo AND p.deleted_at IS NULL
       AND coalesce(v.demanda_media_diaria,0) > 0
       AND coalesce(p.estoque_minimo,0) = 0 AND coalesce(p.estoque_maximo,0) = 0`);

  const porLacuna = new Map<string, {
    produtos: number; impacto: number;
    exemplos: Array<{ produto_id: number; codigo: string; descricao: string; impacto: number }>;
  }>();

  for (const r of rows) {
    const chave = String(r.lacuna);
    const atual = porLacuna.get(chave) ?? { produtos: 0, impacto: 0, exemplos: [] };
    atual.produtos += 1;
    atual.impacto += num(r.impacto);
    atual.exemplos.push({
      produto_id: Number(r.id),
      codigo: String(r.codigo),
      descricao: String(r.descricao),
      impacto: Math.round(num(r.impacto) * 100) / 100,
    });
    porLacuna.set(chave, atual);
  }

  return [...porLacuna.entries()].map(([lacuna, d]) => ({
    lacuna,
    produtos: d.produtos,
    impacto_diario: Math.round(d.impacto * 100) / 100,
    exemplos: d.exemplos
      .sort((a, b) => b.impacto - a.impacto)
      .slice(0, limiteExemplos),
  })).sort((a, b) => b.impacto_diario - a.impacto_diario);
}

// ---------------------------------------------------------------------------
// Risco por produto (secoes 17 e 18)
// ---------------------------------------------------------------------------

export interface RiscoProduto {
  produto_id: number;
  codigo: string;
  descricao: string;
  tipo: string;
  risco: Risco;
  evidencias: Evidencia[];
  dias_ate_ruptura: number | null;
  impacto_diario: number;
  qualidade: QualidadeDados | null;
}

/**
 * Avalia o risco de abastecimento de um produto.
 *
 * Os pesos sao explicitos e cada fator so entra quando o DADO existe - um
 * produto sem lead time informado nao ganha peso de "lead time alto" nem de
 * "lead time baixo": ele simplesmente nao tem esse fator, e a ausencia aparece
 * na qualidade dos dados em vez de virar uma pontuacao inventada.
 */
export function avaliarRiscoProduto(
  s: SituacaoProduto, cfg: ConfigIA, qualidade?: QualidadeDados,
): RiscoProduto {
  const hoje = hojeLocal();
  const chegadaDias = s.proxima_chegada ? diferencaDias(hoje, s.proxima_chegada) : null;
  const proj = projetarRuptura(s.disponivel, s.demanda_diaria, hoje, chegadaDias);

  const fatores: FatorRisco[] = [];
  const evidencias: Evidencia[] = [
    fato(`Estoque disponivel de ${s.disponivel}`, 'Modulo 03 - vw_estoque_atual',
      { valor: s.disponivel }),
    fato(`Demanda media de ${s.demanda_diaria.toFixed(3)} por dia`,
      'Modulo 04 - parametros de estoque', { valor: s.demanda_diaria }),
  ];

  // --- Probabilidade
  if (proj.jaEmRuptura) {
    fatores.push({ codigo: 'EM_RUPTURA', dimensao: 'PROBABILIDADE', peso: 45,
      descricao: 'Produto com demanda e sem estoque disponivel' });
    evidencias.push(calculo('Produto ja em ruptura hoje', 'Modulo 12 - projecao'));
  } else if (proj.diasAteRuptura !== null && proj.diasAteRuptura <= cfg.horizonteRupturaDias) {
    const peso = proj.diasAteRuptura <= 7 ? 40 : proj.diasAteRuptura <= 15 ? 28 : 18;
    fatores.push({ codigo: 'RUPTURA_PROXIMA', dimensao: 'PROBABILIDADE', peso,
      descricao: `Saldo projetado para ${proj.diasAteRuptura} dia(s) no ritmo atual` });
    evidencias.push(previsao(
      `No ritmo atual o saldo acaba em ${proj.diasAteRuptura} dia(s), por volta de ${proj.dataProvavel}`,
      'Modulo 12 - projecao sobre demanda media',
      { valor: proj.diasAteRuptura, unidade: 'dias' }));
  }

  if (proj.cobertoPorPedido) {
    evidencias.push(fato(
      `Reposicao prevista para ${s.proxima_chegada}, antes do saldo acabar`,
      'Modulo 07 - pedidos em aberto'));
  }

  if (s.pedidos_atrasados > 0) {
    fatores.push({ codigo: 'PEDIDO_ATRASADO', dimensao: 'PROBABILIDADE',
      peso: Math.min(30, 12 + s.pedidos_atrasados * 6),
      descricao: `${s.pedidos_atrasados} item(ns) de pedido com promessa vencida` });
    evidencias.push(fato(`${s.pedidos_atrasados} pedido(s) atrasado(s) para este produto`,
      'Modulo 08 - acompanhamento', { valor: s.pedidos_atrasados }));
  }

  if (s.fornecedores === 0) {
    fatores.push({ codigo: 'SEM_FORNECEDOR', dimensao: 'PROBABILIDADE', peso: 35,
      descricao: 'Nenhum fornecedor ativo vinculado ao produto' });
  } else if (s.fornecedores === 1) {
    fatores.push({ codigo: 'FORNECEDOR_UNICO', dimensao: 'PROBABILIDADE', peso: 20,
      descricao: 'Fornecedor unico: sem alternativa em caso de falha' });
    evidencias.push(fato('Produto com um unico fornecedor ativo',
      'Modulo 02 - produto x fornecedor'));
  }

  if (s.lead_time !== null && s.lead_time > 30) {
    fatores.push({ codigo: 'LEAD_TIME_ALTO', dimensao: 'PROBABILIDADE', peso: 12,
      descricao: `Lead time de ${s.lead_time} dias reduz a margem de reacao` });
  }

  // --- Impacto
  const impactoDiario = s.demanda_diaria * s.custo;
  if (s.classe_abc === 'A') {
    fatores.push({ codigo: 'CLASSE_A', dimensao: 'IMPACTO', peso: 45,
      descricao: 'Produto classe A na curva ABC' });
  } else if (s.classe_abc === 'B') {
    fatores.push({ codigo: 'CLASSE_B', dimensao: 'IMPACTO', peso: 25,
      descricao: 'Produto classe B na curva ABC' });
  } else if (s.classe_abc === 'C') {
    fatores.push({ codigo: 'CLASSE_C', dimensao: 'IMPACTO', peso: 10,
      descricao: 'Produto classe C na curva ABC' });
  }

  if (impactoDiario > 0) {
    const peso = impactoDiario >= 5000 ? 40 : impactoDiario >= 1000 ? 28
      : impactoDiario >= 200 ? 15 : 6;
    fatores.push({ codigo: 'VALOR_DEMANDA', dimensao: 'IMPACTO', peso,
      descricao: `Demanda diaria valorizada em ${impactoDiario.toFixed(2)}` });
    evidencias.push(calculo(
      `Cada dia sem estoque deixa de atender ${impactoDiario.toFixed(2)} em demanda`,
      'Modulo 12 - demanda diaria x custo de referencia',
      { valor: Math.round(impactoDiario * 100) / 100, unidade: 'R$' }));
  }

  if (s.quantidade_vencendo > 0) {
    fatores.push({ codigo: 'VALIDADE', dimensao: 'IMPACTO', peso: 20,
      descricao: `${s.quantidade_vencendo} em lotes proximos do vencimento` });
    evidencias.push(fato(
      `${s.lotes_vencendo} lote(s) vencendo em ate ${cfg.diasValidadeRisco} dias`,
      'Modulo 03 - lotes', { valor: s.quantidade_vencendo }));
  }

  const tipo = proj.jaEmRuptura ? 'RUPTURA'
    : proj.diasAteRuptura !== null && proj.diasAteRuptura <= cfg.horizonteRupturaDias
      ? 'RISCO_RUPTURA'
      : s.quantidade_vencendo > 0 ? 'VALIDADE'
        : s.estoque_maximo > 0 && s.disponivel > s.estoque_maximo ? 'EXCESSO'
          : 'ABASTECIMENTO';

  return {
    produto_id: s.produto_id,
    codigo: s.codigo,
    descricao: s.descricao,
    tipo,
    risco: classificarRisco(fatores),
    evidencias,
    dias_ate_ruptura: proj.diasAteRuptura,
    impacto_diario: Math.round(impactoDiario * 100) / 100,
    qualidade: qualidade ?? null,
  };
}

/** Central de riscos (secao 17): avalia o foco e ordena pelo que dói mais. */
export async function centralRiscos(cfg: ConfigIA, limite = 100) {
  const ids = await produtosEmFoco(Math.max(limite * 2, 200));
  const [situacoes, qualidades] = await Promise.all([
    situacaoProdutos(ids, cfg),
    auditarProdutos(ids),
  ]);

  /*
   * A ordem: dinheiro primeiro, gravidade como desempate.
   *
   * A matriz de risco e qualitativa - "impacto ALTO" cabe tanto num produto de
   * R$ 2 mil por dia quanto num de R$ 200 mil. Ordenar pela matriz fazia
   * dezenas de itens de valor modesto empurrarem para fora da lista um item
   * cem vezes maior, so porque ele tinha um fator de probabilidade a menos.
   *
   * Quem le esta lista decide onde gastar o dia. Entre dois problemas que
   * ambos exigem acao, o que custa mais caro vem antes; a matriz desempata
   * quando o valor e parecido. O filtro anterior ja removeu o que nao exige
   * acao nenhuma.
   */
  const riscos = situacoes
    .map((s) => avaliarRiscoProduto(s, cfg, qualidades.get(s.produto_id)))
    .filter((r) => r.risco.nivel !== 'BAIXO')
    .sort((a, b) => (b.impacto_diario - a.impacto_diario)
      || ((b.risco.probabilidade * b.risco.impacto)
        - (a.risco.probabilidade * a.risco.impacto)))
    .slice(0, limite);

  const porNivel = { CRITICO: 0, ALTO: 0, MODERADO: 0, BAIXO: 0 };
  for (const r of riscos) porNivel[r.risco.nivel] += 1;

  return {
    avaliados: situacoes.length,
    riscos,
    por_nivel: porNivel,
    por_tipo: riscos.reduce<Record<string, number>>((a, r) => {
      a[r.tipo] = (a[r.tipo] ?? 0) + 1; return a;
    }, {}),
    metodologia: 'probabilidade e impacto somam pesos de fatores observados nos '
      + 'registros; o nivel vem da matriz probabilidade x impacto (secao 18). '
      + 'A lista e ordenada pelo impacto financeiro diario, com a matriz como '
      + 'desempate',
    apurado_em: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Anomalias (secao 8)
// ---------------------------------------------------------------------------

/**
 * Resultado de uma varredura de anomalias.
 *
 * `achados: []` sozinho e ambiguo: pode significar "nada fora do padrao" ou
 * "nao havia base para comparar". A diferenca importa - a primeira e uma boa
 * noticia, a segunda e uma lacuna de dados disfarcada de boa noticia. Por isso
 * a varredura devolve tambem quantos candidatos tinham base e quantos nao
 * tinham, com o motivo.
 */
export interface VarreduraAnomalias {
  achados: AnomaliaDetectada[];
  candidatos: number;
  avaliados: number;
  sem_base: number;
  motivo_sem_base: string | null;
}

export interface AnomaliaDetectada {
  indicador: string;
  entidade: string;
  entidade_id: number;
  rotulo: string;
  valor_atual: number;
  valor_esperado: number;
  diferenca: number;
  diferenca_percentual: number | null;
  z_score: number | null;
  direcao: string;
  periodo: string;
  possivel_causa: Evidencia | null;
  impacto: string;
  recomendacao: string;
}

/**
 * Anomalias de preco de compra (secoes 8 e 33).
 *
 * Compara o ultimo preco pago de cada produto com a mediana dos anteriores,
 * por produto. A causa vem marcada como HIPOTESE: o banco mostra QUE o preco
 * subiu, nao POR QUE - e a secao 8 e explicita em nao apresentar causa como
 * fato.
 */
export async function anomaliasPreco(
  cfg: ConfigIA, limite = 50,
): Promise<VarreduraAnomalias> {
  const { rows } = await query<Record<string, unknown>>(`
    WITH precos AS (
      SELECT hp.produto_id, hp.fornecedor_id, hp.data, hp.preco_unitario,
             row_number() OVER (PARTITION BY hp.produto_id ORDER BY hp.data DESC, hp.id DESC) AS ordem
        FROM historico_precos hp
       WHERE hp.preco_unitario > 0
         AND hp.data >= CURRENT_DATE - 730
    )
    SELECT p.id AS produto_id, p.codigo, p.descricao,
           coalesce(p.custo_referencia, 0) AS custo,
           (SELECT preco_unitario FROM precos x
             WHERE x.produto_id = p.id AND x.ordem = 1)            AS atual,
           (SELECT max(data) FROM precos x
             WHERE x.produto_id = p.id AND x.ordem = 1)            AS data_atual,
           (SELECT f.razao_social FROM precos x
              JOIN fornecedores f ON f.id = x.fornecedor_id
             WHERE x.produto_id = p.id AND x.ordem = 1)            AS fornecedor,
           (SELECT array_agg(preco_unitario ORDER BY data) FROM precos x
             WHERE x.produto_id = p.id AND x.ordem > 1)            AS historico
      FROM produtos p
     WHERE p.ativo AND p.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM precos x WHERE x.produto_id = p.id AND x.ordem > 2)
     /*
      * Sem recorte por custo.
      *
      * A versao anterior pegava os 400 produtos de maior custo de referencia -
      * e deixava de fora justamente quem tinha historico de preco, porque ter
      * historico nao tem relacao com ser caro. O filtro que importa e o do
      * EXISTS acima: so entra quem tem ao menos tres precos para comparar, e
      * esse conjunto e naturalmente pequeno.
      */
     ORDER BY coalesce(p.custo_referencia, 0) DESC`);

  const achados: AnomaliaDetectada[] = [];
  let avaliados = 0;
  let semBase = 0;

  for (const r of rows) {
    const atual = num(r.atual);
    const historico = (r.historico as number[] | null)?.map(Number) ?? [];
    if (atual <= 0 || historico.length < 3) { semBase += 1; continue; }
    avaliados += 1;

    const a = analisarPreco(atual, historico, cfg.variacaoPrecoAnormal, 3);
    if (!a.anormal) continue;

    const subiu = (a.variacaoMedia ?? 0) > 0;
    achados.push({
      indicador: 'PRECO_COMPRA',
      entidade: 'produto',
      entidade_id: Number(r.produto_id),
      rotulo: `${r.codigo} - ${r.descricao}`,
      valor_atual: a.atual,
      valor_esperado: a.medianaHistorica,
      diferenca: Math.round((a.atual - a.medianaHistorica) * 100) / 100,
      diferenca_percentual: a.variacaoMedia,
      z_score: null,
      direcao: subiu ? 'ACIMA' : 'ABAIXO',
      periodo: `${a.observacoes} compras anteriores`,
      possivel_causa: hipotese(
        subiu
          ? 'Possivel reajuste do fornecedor, mudanca de condicao comercial ou compra '
            + 'em quantidade menor que a habitual'
          : 'Possivel negociacao bem sucedida, compra em volume maior ou mudanca de fornecedor',
        'Nao confirmado: o banco registra a variacao, nao a sua causa'),
      impacto: subiu
        ? `Cada unidade comprada neste preco custa ${(a.atual - a.medianaHistorica).toFixed(2)} a mais que a mediana`
        : `Cada unidade comprada neste preco custa ${(a.medianaHistorica - a.atual).toFixed(2)} a menos que a mediana`,
      recomendacao: subiu
        ? 'Cotar o produto com outros fornecedores antes da proxima compra'
        : 'Verificar se a condicao se mantem para as proximas compras e registrar como referencia',
    });
  }

  return {
    achados: achados
      .sort((a, b) => Math.abs(b.diferenca_percentual ?? 0)
        - Math.abs(a.diferenca_percentual ?? 0))
      .slice(0, limite),
    candidatos: rows.length,
    avaliados,
    sem_base: semBase,
    motivo_sem_base: semBase
      ? `${semBase} produto(s) com menos de 3 precos registrados: sem base para comparar`
      : null,
  };
}

/**
 * Anomalias de lead time e atraso por fornecedor (secoes 8 e 15).
 *
 * Compara o atraso medio das entregas recentes com o das anteriores, do MESMO
 * fornecedor. O fornecedor e a propria referencia: comparar com a media geral
 * penalizaria quem importa e premiaria quem entrega na esquina.
 */
export async function anomaliasFornecedor(
  cfg: ConfigIA, limite = 30,
): Promise<VarreduraAnomalias> {
  // Janela recente de 3 entregas, nao 5: com poucas entregas por fornecedor,
  // exigir 5 recentes MAIS um historico deixaria a varredura sem nenhum
  // candidato - e o silencio pareceria ausencia de problema.
  const JANELA = 3;
  const { rows } = await query<Record<string, unknown>>(`
    WITH entregas_avaliadas AS (
      -- A entrega pertence ao pedido; o fornecedor vem de la. E a data de
      -- referencia e a PROMETIDA quando existe - foi a que o fornecedor
      -- assumiu; a prevista e a do planejamento, que ele nunca prometeu.
      SELECT oc.fornecedor_id,
             e.data_real,
             greatest(0, (e.data_real - coalesce(e.data_prometida, e.data_prevista)))::numeric
               AS atraso,
             row_number() OVER (PARTITION BY oc.fornecedor_id
                                ORDER BY e.data_real DESC)                 AS ordem
        FROM entregas e
        JOIN ordens_compra oc ON oc.id = e.ordem_compra_id
       WHERE e.data_real IS NOT NULL
         AND coalesce(e.data_prometida, e.data_prevista) IS NOT NULL
         AND e.data_real >= CURRENT_DATE - 540
    )
    SELECT f.id AS fornecedor_id, f.razao_social,
           (SELECT avg(atraso) FROM entregas_avaliadas x
             WHERE x.fornecedor_id = f.id AND x.ordem <= $1::int) AS atraso_recente,
           (SELECT count(*) FROM entregas_avaliadas x
             WHERE x.fornecedor_id = f.id AND x.ordem <= $1::int) AS n_recente,
           (SELECT array_agg(atraso) FROM entregas_avaliadas x
             WHERE x.fornecedor_id = f.id AND x.ordem > $1::int)  AS historico
      FROM fornecedores f
     WHERE f.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM entregas_avaliadas x
                    WHERE x.fornecedor_id = f.id AND x.ordem > $1::int)`, [JANELA]);

  const achados: AnomaliaDetectada[] = [];
  let avaliados = 0;
  let semBase = 0;

  for (const r of rows) {
    const recente = num(r.atraso_recente);
    const historico = (r.historico as number[] | null)?.map(Number) ?? [];
    if (historico.length < cfg.minimoEventos) { semBase += 1; continue; }
    avaliados += 1;

    const a = detectarAnomalia(recente, historico, cfg.zscoreAnomalia, cfg.minimoEventos);
    if (!a.anomala || a.direcao !== 'ACIMA') continue;

    achados.push({
      indicador: 'ATRASO_MEDIO',
      entidade: 'fornecedor',
      entidade_id: Number(r.fornecedor_id),
      rotulo: String(r.razao_social),
      valor_atual: a.valorAtual,
      valor_esperado: a.valorEsperado,
      diferenca: a.diferenca,
      diferenca_percentual: a.diferencaPercentual,
      z_score: a.zScore,
      direcao: a.direcao,
      periodo: `ultimas ${num(r.n_recente)} entregas contra ${historico.length} anteriores`,
      possivel_causa: hipotese(
        'Possivel mudanca de capacidade, de rota logistica ou de prioridade do fornecedor',
        'Nao confirmado: o banco registra o atraso, nao a sua causa'),
      impacto: `O atraso medio subiu de ${a.valorEsperado.toFixed(1)} para `
        + `${a.valorAtual.toFixed(1)} dia(s), encurtando a margem de reposicao`,
      recomendacao: 'Tratar com o fornecedor e revisar o lead time cadastrado '
        + 'antes do proximo pedido',
    });
  }

  return {
    achados: achados
      .sort((a, b) => Math.abs(b.z_score ?? 0) - Math.abs(a.z_score ?? 0))
      .slice(0, limite),
    candidatos: rows.length,
    avaliados,
    sem_base: semBase,
    motivo_sem_base: semBase
      ? `${semBase} fornecedor(es) com menos de ${cfg.minimoEventos} entregas anteriores `
        + 'as recentes: sem base para dizer se o comportamento mudou'
      : null,
  };
}

/**
 * Divergencia entre previsao e realizado (secoes 7 e 8).
 *
 * Le o MAPE que o modulo 04 ja gravou, em vez de recalcular o erro - o modulo
 * 04 e o dono da metodologia de previsao, e recalcular aqui produziria um
 * segundo numero oficial para a mesma coisa.
 */
export async function anomaliasPrevisao(
  cfg: ConfigIA, limite = 30,
): Promise<VarreduraAnomalias> {
  const { rows } = await query<Record<string, unknown>>(`
    SELECT pd.produto_id, p.codigo, p.descricao, pd.mape, pd.metodo::text AS metodo,
           pd.periodo_inicio, pd.periodo_fim, pd.demanda_prevista
      FROM previsoes_demanda pd
      JOIN produtos p ON p.id = pd.produto_id
     WHERE pd.mape IS NOT NULL AND pd.mape > $1
       AND p.ativo AND p.deleted_at IS NULL
     ORDER BY pd.mape DESC
     LIMIT $2`, [cfg.mapeMaximo, limite]);

  const achados = rows.map((r): AnomaliaDetectada => ({
    indicador: 'ACURACIDADE_PREVISAO',
    entidade: 'produto',
    entidade_id: Number(r.produto_id),
    rotulo: `${r.codigo} - ${r.descricao}`,
    valor_atual: num(r.mape),
    valor_esperado: cfg.mapeMaximo,
    diferenca: Math.round((num(r.mape) - cfg.mapeMaximo) * 100) / 100,
    diferenca_percentual: null,
    z_score: null,
    direcao: 'ACIMA',
    periodo: `${String(r.periodo_inicio).slice(0, 10)} a ${String(r.periodo_fim).slice(0, 10)}`,
    possivel_causa: hipotese(
      `O metodo ${r.metodo} pode nao descrever o comportamento deste produto; `
      + 'sazonalidade ou evento pontual podem explicar o desvio',
      'Nao confirmado: o erro esta medido, a sua origem nao'),
    impacto: `Erro medio de ${num(r.mape).toFixed(1)}% na previsao: o planejamento `
      + 'de compra deste produto herda esse erro',
    recomendacao: 'Reavaliar o metodo de previsao do produto no modulo 04',
  }));

  return {
    achados,
    candidatos: achados.length,
    avaliados: achados.length,
    sem_base: 0,
    motivo_sem_base: null,
  };
}

// ---------------------------------------------------------------------------
// Concentracao de fornecimento (secao 14)
// ---------------------------------------------------------------------------

export async function mapaConcentracao(cfg: ConfigIA, dias = 365) {
  const { rows } = await query<Record<string, unknown>>(`
    SELECT oc.fornecedor_id, f.razao_social,
           sum(oci.valor_total) AS valor
      FROM ordem_compra_itens oci
      JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
      JOIN fornecedores f   ON f.id = oc.fornecedor_id
     WHERE oc.data_emissao >= CURRENT_DATE - $1::int
       AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')
     GROUP BY oc.fornecedor_id, f.razao_social
     ORDER BY valor DESC`, [dias]);

  const valores = rows.map((r) => num(r.valor));
  const concentracao = medirConcentracao(valores);
  const total = valores.reduce((a, b) => a + b, 0);

  const { rows: mono } = await query<{ produtos: string }>(`
    SELECT count(*) AS produtos FROM (
      SELECT pf.produto_id FROM produto_fornecedor pf
        JOIN fornecedores f ON f.id = pf.fornecedor_id
        JOIN produtos p     ON p.id = pf.produto_id
       WHERE pf.ativo AND f.deleted_at IS NULL AND p.ativo AND p.deleted_at IS NULL
       GROUP BY pf.produto_id HAVING count(*) = 1) x`);

  return {
    periodo_dias: dias,
    valor_total: Math.round(total * 100) / 100,
    concentracao,
    limite_critico: cfg.concentracaoCriticaPercentual,
    acima_do_limite: concentracao.maiorParticipacao >= cfg.concentracaoCriticaPercentual,
    produtos_monoprovedor: num(mono[0]?.produtos),
    fornecedores: rows.slice(0, 20).map((r) => ({
      fornecedor_id: Number(r.fornecedor_id),
      razao_social: String(r.razao_social),
      valor: Math.round(num(r.valor) * 100) / 100,
      participacao: total > 0 ? Math.round((num(r.valor) / total) * 1000) / 10 : 0,
    })),
    interpretacao: concentracao.interpretacao,
    metodologia: 'indice de Herfindahl-Hirschman sobre o valor comprado por fornecedor; '
      + 'pune concentracao mais do que a simples maior participacao',
  };
}

// ---------------------------------------------------------------------------
// Confianca de uma analise de produto
// ---------------------------------------------------------------------------

export async function confiancaProduto(produtoId: number, cfg: ConfigIA) {
  const { rows } = await query<Record<string, unknown>>(`
    SELECT (SELECT count(*) FROM itens_venda iv JOIN vendas v ON v.id = iv.venda_id
             WHERE iv.produto_id = $1 AND v.data_venda >= CURRENT_DATE - 365) AS vendas,
           (SELECT min(v.data_venda) FROM itens_venda iv JOIN vendas v ON v.id = iv.venda_id
             WHERE iv.produto_id = $1)                                        AS primeira,
           (SELECT max(v.data_venda) FROM itens_venda iv JOIN vendas v ON v.id = iv.venda_id
             WHERE iv.produto_id = $1)                                        AS ultima,
           (SELECT pd.mape FROM previsoes_demanda pd WHERE pd.produto_id = $1
             ORDER BY pd.created_at DESC LIMIT 1)                             AS mape,
           (SELECT array_agg(iv.quantidade) FROM itens_venda iv
              JOIN vendas v ON v.id = iv.venda_id
             WHERE iv.produto_id = $1 AND v.data_venda >= CURRENT_DATE - 365) AS quantidades`,
  [produtoId]);

  const r = rows[0] ?? {};
  const quantidades = (r.quantidades as number[] | null)?.map(Number) ?? [];
  const m = quantidades.length
    ? quantidades.reduce((a, b) => a + b, 0) / quantidades.length : 0;
  const dp = quantidades.length > 1
    ? Math.sqrt(quantidades.reduce((a, x) => a + (x - m) ** 2, 0) / (quantidades.length - 1))
    : 0;

  const ultima = r.ultima ? String(r.ultima).slice(0, 10) : null;
  const primeira = r.primeira ? String(r.primeira).slice(0, 10) : null;

  return avaliarConfianca({
    eventos: num(r.vendas),
    minimoEventos: cfg.minimoEventos,
    diasHistorico: primeira ? diferencaDias(primeira, hojeLocal()) : 0,
    minimoDias: cfg.minimoDiasHistorico,
    coeficienteVariacao: m > 0 ? dp / m : null,
    mape: r.mape === null || r.mape === undefined ? null : num(r.mape),
    dadoRecente: ultima ? diferencaDias(ultima, hojeLocal()) <= 60 : false,
  });
}
