/**
 * Catalogo de consultas do "Pergunte aos Dados" (secoes 22 e 23).
 *
 * POR QUE UM CATALOGO E NAO SQL GERADO LIVREMENTE
 *
 * A secao 22 pede linguagem natural e a 23 pede seguranca. Gerar SQL livre e
 * depois filtrar por texto inverte a ordem do problema: cria a ameaca e tenta
 * reconhece-la. Um catalogo de consultas parametrizadas elimina a categoria
 * inteira - o texto do usuario nunca vira SQL, ele escolhe QUAL consulta roda e
 * preenche os PARAMETROS, que trafegam como $1, $2 e nunca sao concatenados.
 *
 * O resultado tambem e melhor de usar: cada consulta ja vem com colunas
 * nomeadas, unidade certa e a fonte declarada. SQL adivinhado acerta a sintaxe
 * e erra a regra de negocio - somaria `quantidade` sem excluir pedido
 * cancelado, por exemplo.
 *
 * Cada entrada declara o DOMINIO, e e ele que decide se o perfil pode ver a
 * resposta (secao 38).
 */
import type { Dominio } from './contexto.js';

export interface Parametro {
  nome: string;
  tipo: 'inteiro' | 'texto' | 'id';
  padrao?: number | string;
  descricao: string;
}

export interface Consulta {
  codigo: string;
  titulo: string;
  dominio: Dominio;
  /** Perguntas que levam a esta consulta. Usadas na classificacao e na ajuda. */
  exemplos: string[];
  /** Termos que pontuam. Ja normalizados: minusculos e sem acento. */
  termos: string[];
  /** Termos que, se presentes, eliminam a consulta. Desempata pares parecidos. */
  excluir?: string[];
  parametros: Parametro[];
  sql: string;
  colunas: Array<{ campo: string; titulo: string; tipo: string }>;
  fonte: string;
  /** Monta a frase de resposta a partir das linhas. */
  resumo: (linhas: Array<Record<string, unknown>>, p: Record<string, unknown>) => string;
}

/*
 * O LIMIT das consultas e alto de proposito.
 *
 * A guarda exige LIMIT em toda consulta, e o limite EFETIVO vem da
 * configuracao `ia.limite_linhas_consulta`, aplicada pelo envelope de
 * execucao. Um LIMIT baixo aqui truncaria antes disso - e o truncamento
 * passaria despercebido, fazendo "200 produtos em ruptura" parecer a resposta
 * quando e so o teto da consulta.
 */
const col = (campo: string, titulo: string, tipo = 'texto') => ({ campo, titulo, tipo });
const n = (v: unknown) => Number(v ?? 0);
const moeda = (v: unknown) => n(v).toLocaleString('pt-BR', {
  style: 'currency', currency: 'BRL',
});

export const CONSULTAS: Consulta[] = [
  // ---------------------------------------------------------------- compras
  {
    codigo: 'COMPRAR_SEMANA',
    titulo: 'O que precisa ser comprado',
    dominio: 'COMPRAS',
    exemplos: [
      'Quais produtos preciso comprar esta semana?',
      'O que preciso comprar hoje?',
      'Quais compras sao criticas?',
    ],
    termos: ['comprar', 'compra', 'preciso', 'necessidade', 'repor', 'reposicao',
      'semana', 'hoje', 'critica', 'criticas'],
    excluir: ['aberto', 'atrasado', 'atrasados'],
    parametros: [
      { nome: 'dias', tipo: 'inteiro', padrao: 7, descricao: 'Janela em dias' },
    ],
    sql: `
      SELECT p.codigo, p.descricao, nc.prioridade::text AS prioridade,
             nc.quantidade_sugerida, nc.valor_estimado, nc.data_necessaria,
             nc.status::text AS status
        FROM necessidades_compra nc
        JOIN produtos p ON p.id = nc.produto_id
       WHERE nc.status IN ('PENDENTE','EM_ANALISE','APROVADA','AJUSTADA')
         AND nc.data_necessaria <= CURRENT_DATE + $1::int
       ORDER BY CASE nc.prioridade::text
                  WHEN 'RUPTURA' THEN 1 WHEN 'CRITICA' THEN 2 WHEN 'ALTA' THEN 3
                  WHEN 'MEDIA' THEN 4 ELSE 5 END, nc.data_necessaria
       LIMIT 5000`,
    colunas: [col('codigo', 'Codigo'), col('descricao', 'Produto'),
      col('prioridade', 'Prioridade', 'etiqueta'),
      col('quantidade_sugerida', 'Quantidade', 'numero'),
      col('valor_estimado', 'Valor', 'moeda'),
      col('data_necessaria', 'Necessaria em', 'data')],
    fonte: 'Modulo 05 - necessidades de compra',
    resumo: (l, p) => (l.length === 0
      ? `Nenhuma necessidade de compra para os proximos ${p.dias} dias.`
      : `${l.length} produto(s) a comprar nos proximos ${p.dias} dias, somando `
        + `${moeda(l.reduce((a, r) => a + n(r.valor_estimado), 0))}.`),
  },
  {
    codigo: 'COMPRAS_EM_ABERTO',
    titulo: 'Compras em aberto',
    dominio: 'COMPRAS',
    exemplos: ['Quanto tenho em compras em aberto?', 'Qual o valor dos pedidos em aberto?'],
    termos: ['aberto', 'abertas', 'carteira', 'quanto tenho', 'em andamento'],
    parametros: [],
    sql: `
      SELECT oc.numero, f.razao_social AS fornecedor, oc.status::text AS status,
             oc.data_emissao,
             sum(oci.quantidade_pendente * oci.preco_unitario) AS valor_pendente,
             count(*) AS itens
        FROM ordem_compra_itens oci
        JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
        JOIN fornecedores f   ON f.id = oc.fornecedor_id
       WHERE oci.quantidade_pendente > 0
         AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')
       GROUP BY oc.numero, f.razao_social, oc.status, oc.data_emissao
       ORDER BY valor_pendente DESC
       LIMIT 5000`,
    colunas: [col('numero', 'Pedido'), col('fornecedor', 'Fornecedor'),
      col('status', 'Status', 'etiqueta'), col('data_emissao', 'Emissao', 'data'),
      col('itens', 'Itens', 'numero'), col('valor_pendente', 'Pendente', 'moeda')],
    fonte: 'Modulo 07 - pedidos de compra',
    resumo: (l) => (l.length === 0
      ? 'Nenhum pedido de compra em aberto.'
      : `${l.length} pedido(s) em aberto, ${moeda(l.reduce((a, r) => a + n(r.valor_pendente), 0))} `
        + 'pendentes de entrega.'),
  },
  {
    codigo: 'EVOLUCAO_COMPRAS',
    titulo: 'Evolucao das compras',
    dominio: 'COMPRAS',
    exemplos: ['Qual foi minha evolucao de compras nos ultimos 12 meses?',
      'Quanto comprei por mes?'],
    termos: ['evolucao', 'historico de compras', 'ultimos meses', 'por mes',
      'mensal', 'quanto comprei', '12 meses'],
    parametros: [
      { nome: 'meses', tipo: 'inteiro', padrao: 12, descricao: 'Meses a considerar' },
    ],
    sql: `
      SELECT to_char(oc.data_emissao, 'YYYY-MM') AS mes,
             count(DISTINCT oc.id) AS pedidos,
             sum(oci.valor_total)  AS valor,
             count(DISTINCT oc.fornecedor_id) AS fornecedores
        FROM ordens_compra oc
        JOIN ordem_compra_itens oci ON oci.ordem_compra_id = oc.id
       WHERE oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')
         AND oc.data_emissao >= (date_trunc('month', CURRENT_DATE)
                                 - make_interval(months => $1::int))
       GROUP BY 1 ORDER BY 1
       LIMIT 5000`,
    colunas: [col('mes', 'Mes'), col('pedidos', 'Pedidos', 'numero'),
      col('fornecedores', 'Fornecedores', 'numero'), col('valor', 'Valor', 'moeda')],
    fonte: 'Modulo 07 - pedidos de compra',
    resumo: (l, p) => (l.length === 0
      ? `Nenhuma compra registrada nos ultimos ${p.meses} meses.`
      : `${l.length} mes(es) com compras, total de `
        + `${moeda(l.reduce((a, r) => a + n(r.valor), 0))}.`),
  },
  {
    codigo: 'COMPRAS_POR_FORNECEDOR',
    titulo: 'Compras por fornecedor',
    dominio: 'COMPRAS',
    exemplos: ['Quanto tenho comprado do fornecedor X?', 'Quanto comprei de cada fornecedor?'],
    termos: ['quanto comprei do', 'comprado do fornecedor', 'por fornecedor',
      'compras do fornecedor'],
    parametros: [
      { nome: 'dias', tipo: 'inteiro', padrao: 365, descricao: 'Periodo em dias' },
      { nome: 'fornecedor_id', tipo: 'id', descricao: 'Fornecedor especifico' },
    ],
    sql: `
      SELECT f.razao_social AS fornecedor,
             count(DISTINCT oc.id) AS pedidos,
             sum(oci.valor_total)  AS valor,
             count(DISTINCT oci.produto_id) AS produtos,
             max(oc.data_emissao)  AS ultima_compra
        FROM ordens_compra oc
        JOIN ordem_compra_itens oci ON oci.ordem_compra_id = oc.id
        JOIN fornecedores f         ON f.id = oc.fornecedor_id
       WHERE oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')
         AND oc.data_emissao >= CURRENT_DATE - $1::int
         AND ($2::bigint IS NULL OR f.id = $2::bigint)
       GROUP BY f.razao_social
       ORDER BY valor DESC
       LIMIT 5000`,
    colunas: [col('fornecedor', 'Fornecedor'), col('pedidos', 'Pedidos', 'numero'),
      col('produtos', 'Produtos', 'numero'), col('valor', 'Valor', 'moeda'),
      col('ultima_compra', 'Ultima compra', 'data')],
    fonte: 'Modulo 07 - pedidos de compra',
    resumo: (l, p) => (l.length === 0
      ? `Nenhuma compra nos ultimos ${p.dias} dias.`
      : `${l.length} fornecedor(es), ${moeda(l.reduce((a, r) => a + n(r.valor), 0))} `
        + `em ${p.dias} dias.`),
  },

  // ---------------------------------------------------------------- estoque
  {
    codigo: 'RUPTURA',
    titulo: 'Produtos em ruptura ou com risco',
    dominio: 'ESTOQUE',
    exemplos: ['Quais produtos podem romper?', 'Quais produtos estao em ruptura?',
      'O que esta faltando?'],
    termos: ['ruptura', 'romper', 'faltando', 'falta', 'acabar', 'sem estoque',
      'zerado', 'zerados'],
    parametros: [
      { nome: 'dias', tipo: 'inteiro', padrao: 30, descricao: 'Horizonte em dias' },
    ],
    sql: `
      SELECT v.codigo, v.descricao, v.categoria,
             v.estoque_disponivel, v.demanda_media_diaria,
             floor(greatest(v.estoque_disponivel,0) / v.demanda_media_diaria)::int
               AS dias_ate_ruptura,
             v.demanda_media_diaria * coalesce(p.custo_referencia,0) * 7 AS impacto_semanal,
             (SELECT count(*) FROM ordem_compra_itens oci
                JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
               WHERE oci.produto_id = v.produto_id AND oci.quantidade_pendente > 0
                 AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')) AS pedidos_abertos
        FROM vw_estoque_atual v
        JOIN produtos p ON p.id = v.produto_id
       WHERE p.ativo AND p.deleted_at IS NULL
         AND v.demanda_media_diaria > 0
         AND floor(greatest(v.estoque_disponivel,0) / v.demanda_media_diaria) <= $1::int
       ORDER BY impacto_semanal DESC
       LIMIT 5000`,
    colunas: [col('codigo', 'Codigo'), col('descricao', 'Produto'),
      col('estoque_disponivel', 'Disponivel', 'numero'),
      col('demanda_media_diaria', 'Demanda/dia', 'numero'),
      col('dias_ate_ruptura', 'Dias', 'numero'),
      col('impacto_semanal', 'Impacto/semana', 'moeda'),
      col('pedidos_abertos', 'Pedidos', 'numero')],
    fonte: 'Modulos 03 e 04 - estoque e demanda',
    resumo: (l, p) => (l.length === 0
      ? `Nenhum produto com ruptura projetada em ate ${p.dias} dias.`
      : `${l.length} produto(s) com ruptura projetada em ate ${p.dias} dias; `
        + `${l.filter((r) => n(r.estoque_disponivel) <= 0).length} ja sem estoque.`),
  },
  {
    codigo: 'EXCESSO',
    titulo: 'Produtos com excesso',
    dominio: 'ESTOQUE',
    exemplos: ['Quais produtos estao com excesso?', 'Onde existe excesso de estoque?'],
    termos: ['excesso', 'sobra', 'sobrando', 'parado', 'encalhado', 'demais'],
    parametros: [
      { nome: 'dias', tipo: 'inteiro', padrao: 90, descricao: 'Cobertura maxima em dias' },
    ],
    sql: `
      SELECT * FROM (
        SELECT v.codigo, v.descricao, v.estoque_disponivel, v.cobertura_dias,
               least(nullif(v.demanda_media_diaria,0) * $1::int,
                     nullif(p.estoque_maximo,0))                AS maximo,
               v.estoque_disponivel
                 - least(nullif(v.demanda_media_diaria,0) * $1::int,
                         nullif(p.estoque_maximo,0))            AS excedente,
               (v.estoque_disponivel
                 - least(nullif(v.demanda_media_diaria,0) * $1::int,
                         nullif(p.estoque_maximo,0)))
                 * coalesce(p.custo_referencia,0)               AS valor_parado
          FROM vw_estoque_atual v
          JOIN produtos p ON p.id = v.produto_id
         WHERE p.ativo AND p.deleted_at IS NULL
      ) x
       WHERE x.maximo IS NOT NULL AND x.estoque_disponivel > x.maximo
       ORDER BY x.valor_parado DESC
       LIMIT 5000`,
    colunas: [col('codigo', 'Codigo'), col('descricao', 'Produto'),
      col('estoque_disponivel', 'Disponivel', 'numero'),
      col('maximo', 'Maximo', 'numero'), col('excedente', 'Excedente', 'numero'),
      col('cobertura_dias', 'Cobertura', 'numero'),
      col('valor_parado', 'Valor parado', 'moeda')],
    fonte: 'Modulos 03 e 04 - estoque e demanda',
    resumo: (l) => (l.length === 0
      ? 'Nenhum produto acima do maximo aceitavel.'
      : `${l.length} produto(s) em excesso, `
        + `${moeda(l.reduce((a, r) => a + n(r.valor_parado), 0))} imobilizados.`),
  },
  {
    codigo: 'COBERTURA',
    titulo: 'Cobertura de estoque',
    dominio: 'ESTOQUE',
    exemplos: ['Qual e minha cobertura media?', 'Quantos dias de estoque eu tenho?'],
    termos: ['cobertura', 'quantos dias de estoque', 'dias de estoque', 'autonomia'],
    parametros: [],
    sql: `
      SELECT count(*)                            AS produtos,
             round(avg(v.cobertura_dias), 1)     AS cobertura_media,
             round(min(v.cobertura_dias), 1)     AS cobertura_minima,
             round(max(v.cobertura_dias), 1)     AS cobertura_maxima,
             count(*) FILTER (WHERE v.cobertura_dias < 7)  AS abaixo_7_dias,
             count(*) FILTER (WHERE v.cobertura_dias > 90) AS acima_90_dias
        FROM vw_estoque_atual v
        JOIN produtos p ON p.id = v.produto_id
       WHERE p.ativo AND p.deleted_at IS NULL AND v.cobertura_dias IS NOT NULL
       LIMIT 5000`,
    colunas: [col('produtos', 'Produtos', 'numero'),
      col('cobertura_media', 'Media (dias)', 'numero'),
      col('cobertura_minima', 'Minima', 'numero'), col('cobertura_maxima', 'Maxima', 'numero'),
      col('abaixo_7_dias', 'Abaixo de 7d', 'numero'),
      col('acima_90_dias', 'Acima de 90d', 'numero')],
    fonte: 'Modulos 03 e 04 - estoque e demanda',
    resumo: (l) => (l.length === 0 || n(l[0]?.produtos) === 0
      ? 'Nenhum produto com cobertura calculavel: sem demanda apurada, a cobertura nao existe.'
      : `Cobertura media de ${n(l[0]?.cobertura_media)} dias em `
        + `${n(l[0]?.produtos)} produto(s); ${n(l[0]?.abaixo_7_dias)} abaixo de 7 dias.`),
  },
  {
    codigo: 'ESTOQUE_PARADO',
    titulo: 'Estoque sem movimentacao',
    dominio: 'ESTOQUE',
    exemplos: ['Quais produtos estao com estoque parado?', 'O que nao tem saida?'],
    termos: ['parado', 'sem movimentacao', 'sem saida', 'nao vende', 'encalhe'],
    parametros: [
      { nome: 'dias', tipo: 'inteiro', padrao: 90, descricao: 'Dias sem saida' },
    ],
    sql: `
      SELECT p.codigo, p.descricao, sum(e.quantidade_disponivel) AS disponivel,
             max(e.ultima_saida) AS ultima_saida,
             (CURRENT_DATE - max(e.ultima_saida)::date) AS dias_sem_saida,
             sum(e.quantidade_disponivel) * coalesce(p.custo_referencia,0) AS valor_parado
        FROM estoques e
        JOIN produtos p ON p.id = e.produto_id
       WHERE p.ativo AND p.deleted_at IS NULL AND e.quantidade_disponivel > 0
       GROUP BY p.id, p.codigo, p.descricao, p.custo_referencia
      HAVING max(e.ultima_saida) IS NULL
          OR max(e.ultima_saida) < now() - make_interval(days => $1::int)
       ORDER BY valor_parado DESC
       LIMIT 5000`,
    colunas: [col('codigo', 'Codigo'), col('descricao', 'Produto'),
      col('disponivel', 'Disponivel', 'numero'),
      col('ultima_saida', 'Ultima saida', 'data'),
      col('dias_sem_saida', 'Dias parado', 'numero'),
      col('valor_parado', 'Valor parado', 'moeda')],
    fonte: 'Modulo 03 - movimentacoes de estoque',
    resumo: (l, p) => (l.length === 0
      ? `Nenhum produto sem saida ha mais de ${p.dias} dias.`
      : `${l.length} produto(s) sem saida ha mais de ${p.dias} dias, `
        + `${moeda(l.reduce((a, r) => a + n(r.valor_parado), 0))} parados.`),
  },
  {
    codigo: 'VALIDADE',
    titulo: 'Lotes proximos do vencimento',
    dominio: 'ESTOQUE',
    exemplos: ['Quais lotes estao vencendo?', 'O que vai vencer?'],
    termos: ['validade', 'vencendo', 'vencer', 'vencimento', 'lote', 'lotes', 'prazo'],
    parametros: [
      { nome: 'dias', tipo: 'inteiro', padrao: 60, descricao: 'Janela em dias' },
    ],
    sql: `
      SELECT p.codigo, p.descricao, l.numero_lote, l.data_validade,
             (l.data_validade - CURRENT_DATE) AS dias_para_vencer,
             l.quantidade_atual,
             l.quantidade_atual * coalesce(p.custo_referencia,0) AS valor
        FROM lotes l
        JOIN produtos p ON p.id = l.produto_id
       WHERE l.quantidade_atual > 0 AND l.data_validade IS NOT NULL
         AND l.data_validade <= CURRENT_DATE + $1::int
       ORDER BY l.data_validade
       LIMIT 5000`,
    colunas: [col('codigo', 'Codigo'), col('descricao', 'Produto'),
      col('numero_lote', 'Lote'), col('data_validade', 'Validade', 'data'),
      col('dias_para_vencer', 'Dias', 'numero'),
      col('quantidade_atual', 'Quantidade', 'numero'), col('valor', 'Valor', 'moeda')],
    fonte: 'Modulo 03 - lotes',
    resumo: (l, p) => (l.length === 0
      ? `Nenhum lote vencendo nos proximos ${p.dias} dias.`
      : `${l.length} lote(s) vencendo em ate ${p.dias} dias, `
        + `${moeda(l.reduce((a, r) => a + n(r.valor), 0))} envolvidos.`),
  },

  // ----------------------------------------------------------- fornecedores
  {
    codigo: 'FORNECEDOR_ATRASO',
    titulo: 'Fornecedores que mais atrasaram',
    dominio: 'FORNECEDORES',
    exemplos: ['Qual fornecedor mais atrasou nos ultimos 90 dias?',
      'Quais fornecedores estao atrasando?'],
    termos: ['fornecedor atrasou', 'mais atrasou', 'atrasando', 'atraso do fornecedor',
      'pontualidade'],
    parametros: [
      { nome: 'dias', tipo: 'inteiro', padrao: 90, descricao: 'Periodo em dias' },
    ],
    sql: `
      SELECT f.razao_social AS fornecedor,
             count(*) AS entregas,
             count(*) FILTER (WHERE e.data_real
                              > coalesce(e.data_prometida, e.data_prevista)) AS atrasadas,
             round(avg(greatest(0, e.data_real
                       - coalesce(e.data_prometida, e.data_prevista)))::numeric, 1)
               AS atraso_medio_dias,
             max(greatest(0, e.data_real
                 - coalesce(e.data_prometida, e.data_prevista))) AS maior_atraso
        FROM entregas e
        JOIN ordens_compra oc ON oc.id = e.ordem_compra_id
        JOIN fornecedores f   ON f.id = oc.fornecedor_id
       WHERE e.data_real IS NOT NULL
         AND coalesce(e.data_prometida, e.data_prevista) IS NOT NULL
         AND e.data_real >= CURRENT_DATE - $1::int
       GROUP BY f.razao_social
      HAVING count(*) FILTER (WHERE e.data_real
                              > coalesce(e.data_prometida, e.data_prevista)) > 0
       ORDER BY atraso_medio_dias DESC, atrasadas DESC
       LIMIT 5000`,
    colunas: [col('fornecedor', 'Fornecedor'), col('entregas', 'Entregas', 'numero'),
      col('atrasadas', 'Atrasadas', 'numero'),
      col('atraso_medio_dias', 'Atraso medio', 'numero'),
      col('maior_atraso', 'Maior atraso', 'numero')],
    fonte: 'Modulo 08 - entregas',
    resumo: (l, p) => (l.length === 0
      ? `Nenhuma entrega atrasada nos ultimos ${p.dias} dias.`
      : `${l.length} fornecedor(es) com atraso; o maior atraso medio e de `
        + `${n(l[0]?.atraso_medio_dias)} dia(s) (${l[0]?.fornecedor}).`),
  },
  {
    codigo: 'FORNECEDOR_OTIF',
    titulo: 'Fornecedores abaixo da meta de OTIF',
    dominio: 'FORNECEDORES',
    exemplos: ['Quais fornecedores possuem OTIF abaixo da meta?',
      'Quem esta abaixo da meta?'],
    termos: ['otif', 'meta', 'abaixo da meta', 'performance', 'desempenho'],
    parametros: [
      { nome: 'dias', tipo: 'inteiro', padrao: 90, descricao: 'Periodo em dias' },
    ],
    sql: `
      WITH avaliadas AS (
        SELECT oc.fornecedor_id,
               count(*) AS total,
               count(*) FILTER (
                 WHERE e.data_real <= coalesce(e.data_prometida, e.data_prevista)
                   AND e.quantidade_entregue >= e.quantidade_prevista) AS otif
          FROM entregas e
          JOIN ordens_compra oc ON oc.id = e.ordem_compra_id
         WHERE e.data_real IS NOT NULL
           AND coalesce(e.data_prometida, e.data_prevista) IS NOT NULL
           AND e.data_real >= CURRENT_DATE - $1::int
         GROUP BY oc.fornecedor_id
      )
      SELECT f.razao_social AS fornecedor, a.total AS entregas, a.otif AS no_prazo_e_integrais,
             round((a.otif::numeric / nullif(a.total,0)) * 100, 2) AS otif_percentual,
             f.status_homologacao::text AS situacao
        FROM avaliadas a
        JOIN fornecedores f ON f.id = a.fornecedor_id
       WHERE (a.otif::numeric / nullif(a.total,0)) * 100 < 95
       ORDER BY otif_percentual
       LIMIT 5000`,
    colunas: [col('fornecedor', 'Fornecedor'), col('entregas', 'Entregas', 'numero'),
      col('otif_percentual', 'OTIF %', 'percentual'),
      col('situacao', 'Situacao', 'etiqueta')],
    fonte: 'Modulo 08 - entregas. A definicao oficial de OTIF e a do modulo 11',
    resumo: (l, p) => (l.length === 0
      ? `Nenhum fornecedor abaixo de 95% de OTIF nos ultimos ${p.dias} dias.`
      : `${l.length} fornecedor(es) abaixo da meta de 95%; o menor e `
        + `${n(l[0]?.otif_percentual)}% (${l[0]?.fornecedor}).`),
  },
  {
    codigo: 'MONOPROVEDOR',
    titulo: 'Produtos com fornecedor unico',
    dominio: 'FORNECEDORES',
    exemplos: ['Quais produtos tem fornecedor unico?', 'Onde dependo de um so fornecedor?'],
    termos: ['fornecedor unico', 'monoprovedor', 'um so fornecedor', 'dependencia',
      'unico fornecedor', 'alternativa'],
    parametros: [],
    sql: `
      SELECT p.codigo, p.descricao, f.razao_social AS fornecedor_unico,
             coalesce(pe.demanda_media_diaria, 0) AS demanda_diaria,
             coalesce(pe.demanda_media_diaria, 0) * coalesce(p.custo_referencia, 0) * 365
               AS exposicao_anual,
             f.status_homologacao::text AS situacao
        FROM produtos p
        JOIN produto_fornecedor pf ON pf.produto_id = p.id AND pf.ativo
        JOIN fornecedores f        ON f.id = pf.fornecedor_id AND f.deleted_at IS NULL
        LEFT JOIN parametros_estoque pe ON pe.produto_id = p.id
       WHERE p.ativo AND p.deleted_at IS NULL
       GROUP BY p.id, p.codigo, p.descricao, f.razao_social, pe.demanda_media_diaria,
                p.custo_referencia, f.status_homologacao
      HAVING count(*) = 1
       ORDER BY exposicao_anual DESC
       LIMIT 5000`,
    colunas: [col('codigo', 'Codigo'), col('descricao', 'Produto'),
      col('fornecedor_unico', 'Fornecedor'),
      col('demanda_diaria', 'Demanda/dia', 'numero'),
      col('exposicao_anual', 'Exposicao anual', 'moeda'),
      col('situacao', 'Situacao', 'etiqueta')],
    fonte: 'Modulo 02 - produto x fornecedor',
    resumo: (l) => (l.length === 0
      ? 'Nenhum produto com fornecedor unico.'
      : `${l.length} produto(s) dependem de um unico fornecedor, `
        + `${moeda(l.reduce((a, r) => a + n(r.exposicao_anual), 0))} de exposicao anual.`),
  },

  // -------------------------------------------------------------- logistica
  {
    codigo: 'PEDIDOS_ATRASADOS',
    titulo: 'Pedidos atrasados',
    dominio: 'PEDIDOS',
    exemplos: ['Quais pedidos estao atrasados?', 'O que esta atrasado?'],
    termos: ['pedido atrasado', 'pedidos atrasados', 'atrasado', 'atrasados', 'vencido'],
    excluir: ['fornecedor mais', 'mais atrasou'],
    parametros: [],
    sql: `
      SELECT oc.numero AS pedido, f.razao_social AS fornecedor,
             p.codigo, p.descricao, oci.quantidade_pendente,
             oci.data_prometida, (CURRENT_DATE - oci.data_prometida) AS dias_atraso,
             oci.quantidade_pendente * oci.preco_unitario AS valor_pendente
        FROM ordem_compra_itens oci
        JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
        JOIN fornecedores f   ON f.id = oc.fornecedor_id
        JOIN produtos p       ON p.id = oci.produto_id
       WHERE oci.quantidade_pendente > 0
         AND oci.data_prometida < CURRENT_DATE
         AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA')
       ORDER BY dias_atraso DESC
       LIMIT 5000`,
    colunas: [col('pedido', 'Pedido'), col('fornecedor', 'Fornecedor'),
      col('descricao', 'Produto'), col('quantidade_pendente', 'Pendente', 'numero'),
      col('data_prometida', 'Prometida', 'data'),
      col('dias_atraso', 'Dias', 'numero'), col('valor_pendente', 'Valor', 'moeda')],
    fonte: 'Modulos 07 e 08 - pedidos e acompanhamento',
    resumo: (l) => (l.length === 0
      ? 'Nenhum item de pedido com promessa vencida.'
      : `${l.length} item(ns) atrasado(s); o maior atraso e de ${n(l[0]?.dias_atraso)} dia(s).`),
  },

  // ------------------------------------------------------------------ preco
  {
    codigo: 'AUMENTO_PRECO',
    titulo: 'Produtos com aumento de preco',
    dominio: 'COMPRAS',
    exemplos: ['Qual produto teve maior aumento de preco?', 'Quais precos aumentaram?'],
    termos: ['preco', 'precos', 'aumento', 'aumentou', 'aumentaram', 'caro',
      'reajuste', 'subiu'],
    parametros: [
      { nome: 'dias', tipo: 'inteiro', padrao: 365, descricao: 'Periodo em dias' },
    ],
    sql: `
      WITH ranqueado AS (
        SELECT hp.produto_id, hp.preco_unitario, hp.data,
               row_number() OVER (PARTITION BY hp.produto_id
                                  ORDER BY hp.data DESC, hp.id DESC) AS ordem
          FROM historico_precos hp
         WHERE hp.preco_unitario > 0 AND hp.data >= CURRENT_DATE - $1::int
      )
      SELECT p.codigo, p.descricao,
             max(r.preco_unitario) FILTER (WHERE r.ordem = 1) AS preco_atual,
             round(avg(r.preco_unitario) FILTER (WHERE r.ordem > 1), 4) AS media_anterior,
             round(((max(r.preco_unitario) FILTER (WHERE r.ordem = 1)
                     - avg(r.preco_unitario) FILTER (WHERE r.ordem > 1))
                    / nullif(avg(r.preco_unitario) FILTER (WHERE r.ordem > 1), 0)) * 100, 2)
               AS variacao_percentual,
             count(*) AS observacoes
        FROM ranqueado r
        JOIN produtos p ON p.id = r.produto_id
       GROUP BY p.id, p.codigo, p.descricao
      HAVING count(*) >= 3
         AND avg(r.preco_unitario) FILTER (WHERE r.ordem > 1) > 0
       ORDER BY variacao_percentual DESC NULLS LAST
       LIMIT 5000`,
    colunas: [col('codigo', 'Codigo'), col('descricao', 'Produto'),
      col('preco_atual', 'Preco atual', 'moeda'),
      col('media_anterior', 'Media anterior', 'moeda'),
      col('variacao_percentual', 'Variacao %', 'percentual'),
      col('observacoes', 'Observacoes', 'numero')],
    fonte: 'Modulo 06 - historico de precos',
    resumo: (l, p) => (l.length === 0
      ? `Sem historico de preco suficiente nos ultimos ${p.dias} dias.`
      : `${l.filter((r) => n(r.variacao_percentual) > 0).length} produto(s) com alta; `
        + `a maior e de ${n(l[0]?.variacao_percentual)}% (${l[0]?.descricao}).`),
  },

  // -------------------------------------------------------------- qualidade
  {
    codigo: 'QUALIDADE_NC',
    titulo: 'Nao conformidades por fornecedor',
    dominio: 'QUALIDADE',
    exemplos: ['Quais fornecedores tem mais nao conformidades?',
      'Onde ha problema de qualidade?'],
    termos: ['nao conformidade', 'conformidade', 'qualidade', 'nc', 'reprovado',
      'defeito', 'problema de qualidade'],
    parametros: [
      { nome: 'dias', tipo: 'inteiro', padrao: 180, descricao: 'Periodo em dias' },
    ],
    sql: `
      SELECT f.razao_social AS fornecedor,
             count(*) AS nao_conformidades,
             count(*) FILTER (WHERE nc.severidade::text = 'CRITICA') AS criticas,
             count(*) FILTER (WHERE nc.status::text NOT IN ('ENCERRADA','CANCELADA'))
               AS em_aberto,
             max(nc.created_at) AS ultima
        FROM nao_conformidades nc
        JOIN fornecedores f ON f.id = nc.fornecedor_id
       WHERE nc.created_at >= CURRENT_DATE - $1::int
       GROUP BY f.razao_social
       ORDER BY criticas DESC, nao_conformidades DESC
       LIMIT 5000`,
    colunas: [col('fornecedor', 'Fornecedor'),
      col('nao_conformidades', 'NCs', 'numero'), col('criticas', 'Criticas', 'numero'),
      col('em_aberto', 'Em aberto', 'numero'), col('ultima', 'Ultima', 'data')],
    fonte: 'Modulo 09 - nao conformidades',
    resumo: (l, p) => (l.length === 0
      ? `Nenhuma nao conformidade nos ultimos ${p.dias} dias.`
      : `${l.length} fornecedor(es) com NC; ${l.reduce((a, r) => a + n(r.criticas), 0)} `
        + 'critica(s) no total.'),
  },

  // ---------------------------------------------------------------- produto
  {
    codigo: 'SITUACAO_PRODUTO',
    titulo: 'Situacao consolidada de um produto',
    dominio: 'ESTOQUE',
    exemplos: ['Como esta a castanha?', 'Qual a situacao do produto X?',
      'Me fala sobre a amendoa'],
    termos: ['como esta', 'situacao do', 'situacao de', 'me fala sobre', 'sobre o produto',
      'status do produto'],
    parametros: [
      { nome: 'termo', tipo: 'texto', descricao: 'Nome ou codigo do produto' },
    ],
    sql: `
      SELECT p.codigo, p.descricao, c.nome AS categoria,
             p.classificacao_abc::text AS classe,
             coalesce(v.estoque_disponivel,0)   AS disponivel,
             coalesce(v.estoque_em_transito,0)  AS em_transito,
             coalesce(v.demanda_media_diaria,0) AS demanda_diaria,
             v.cobertura_dias,
             coalesce(p.custo_referencia,0)     AS custo,
             (SELECT count(*) FROM produto_fornecedor pf
                JOIN fornecedores f ON f.id = pf.fornecedor_id
               WHERE pf.produto_id = p.id AND pf.ativo
                 AND f.deleted_at IS NULL)      AS fornecedores,
             (SELECT coalesce(sum(oci.quantidade_pendente),0) FROM ordem_compra_itens oci
                JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
               WHERE oci.produto_id = p.id AND oci.quantidade_pendente > 0
                 AND oc.status NOT IN ('RASCUNHO','CANCELADA','REJEITADA'))
                                                AS pendente_de_entrega
        FROM produtos p
        LEFT JOIN categorias c       ON c.id = p.categoria_id
        LEFT JOIN vw_estoque_atual v ON v.produto_id = p.id
       WHERE p.ativo AND p.deleted_at IS NULL
         AND (p.descricao ILIKE '%' || $1::text || '%'
              OR p.codigo ILIKE '%' || $1::text || '%')
       ORDER BY coalesce(v.demanda_media_diaria,0) DESC
       LIMIT 5000`,
    colunas: [col('codigo', 'Codigo'), col('descricao', 'Produto'),
      col('categoria', 'Categoria'), col('classe', 'ABC', 'etiqueta'),
      col('disponivel', 'Disponivel', 'numero'),
      col('em_transito', 'Em transito', 'numero'),
      col('demanda_diaria', 'Demanda/dia', 'numero'),
      col('cobertura_dias', 'Cobertura', 'numero'),
      col('fornecedores', 'Fornecedores', 'numero'),
      col('pendente_de_entrega', 'A receber', 'numero')],
    fonte: 'Modulos 02, 03, 04 e 07 - cadastro, estoque, demanda e pedidos',
    resumo: (l, p) => (l.length === 0
      ? `Nenhum produto encontrado com "${p.termo}".`
      : l.length === 1
        ? `${l[0]?.descricao}: ${n(l[0]?.disponivel)} disponivel(is), demanda de `
          + `${n(l[0]?.demanda_diaria)}/dia, cobertura de `
          + `${l[0]?.cobertura_dias ?? 'nao calculavel'} dia(s).`
        : `${l.length} produto(s) encontrado(s) com "${p.termo}".`),
  },
];

export const CONSULTAS_POR_CODIGO = new Map(CONSULTAS.map((c) => [c.codigo, c]));

export const catalogo = () => CONSULTAS.map((c) => ({
  codigo: c.codigo,
  titulo: c.titulo,
  dominio: c.dominio,
  exemplos: c.exemplos,
  parametros: c.parametros,
  fonte: c.fonte,
}));
