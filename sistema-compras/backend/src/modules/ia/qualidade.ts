/**
 * Porta de qualidade dos dados (secao 27).
 *
 * Roda ANTES de qualquer recomendacao importante. A ordem e o ponto: verificar
 * a base depois de recomendar serviria para explicar o erro, nao para
 * evita-lo.
 *
 * A secao 27 termina com uma instrucao que este modulo leva ao pe da letra -
 * "se os dados forem insuficientes, INFORMAR CLARAMENTE A LIMITACAO". Entao o
 * resultado nao e um booleano: e a lista do que falta, por produto, para a
 * resposta poder dizer o que nao sabe em vez de calar.
 */
import { query } from '../../config/database.js';

export type Severidade = 'BLOQUEIA' | 'LIMITA' | 'INFORMA';

export interface Achado {
  codigo: string;
  descricao: string;
  severidade: Severidade;
  /** O que fazer para resolver - sem isto o aviso vira reclamacao. */
  correcao: string;
}

export interface QualidadeDados {
  apto: boolean;
  completude: number;
  achados: Achado[];
  /** Frase pronta para a resposta, quando houver limitacao. */
  limitacao: string | null;
}

const ACHADOS: Record<string, Omit<Achado, 'descricao'>> = {
  SEM_DEMANDA: {
    codigo: 'SEM_DEMANDA',
    severidade: 'BLOQUEIA',
    correcao: 'Importar vendas do produto ou apurar a demanda no modulo 04',
  },
  SEM_CUSTO: {
    codigo: 'SEM_CUSTO',
    severidade: 'LIMITA',
    correcao: 'Preencher o custo de referencia no cadastro do produto',
  },
  SEM_FORNECEDOR: {
    codigo: 'SEM_FORNECEDOR',
    severidade: 'BLOQUEIA',
    correcao: 'Vincular ao menos um fornecedor ativo ao produto',
  },
  SEM_LEAD_TIME: {
    codigo: 'SEM_LEAD_TIME',
    severidade: 'LIMITA',
    correcao: 'Informar o lead time no vinculo produto-fornecedor ou no fornecedor',
  },
  SEM_PARAMETROS: {
    codigo: 'SEM_PARAMETROS',
    severidade: 'LIMITA',
    correcao: 'Definir estoque minimo, maximo e ponto de pedido no modulo 03',
  },
  SEM_PRECO: {
    codigo: 'SEM_PRECO',
    severidade: 'LIMITA',
    correcao: 'Registrar o preco do fornecedor ou cotar o produto',
  },
  HISTORICO_CURTO: {
    codigo: 'HISTORICO_CURTO',
    severidade: 'LIMITA',
    correcao: 'Acumular mais historico de vendas antes de projetar tendencia',
  },
  DADO_ANTIGO: {
    codigo: 'DADO_ANTIGO',
    severidade: 'INFORMA',
    correcao: 'Conferir se o produto continua ativo na operacao',
  },
  ESTOQUE_NEGATIVO: {
    codigo: 'ESTOQUE_NEGATIVO',
    severidade: 'BLOQUEIA',
    correcao: 'Corrigir o saldo por inventario no modulo 03',
  },
  PRECO_DESATUALIZADO: {
    codigo: 'PRECO_DESATUALIZADO',
    severidade: 'INFORMA',
    correcao: 'Cotar o produto para atualizar a referencia de preco',
  },
};

const achado = (codigo: keyof typeof ACHADOS, descricao: string): Achado =>
  ({ ...ACHADOS[codigo]!, descricao });

/**
 * Audita a base de UM produto.
 *
 * Uma consulta so, com subselects, em vez de seis idas ao banco: esta funcao
 * roda para cada produto de um lote de recomendacoes, e seis viagens por
 * produto acabariam com o tempo de resposta da Central de Decisao.
 */
export async function auditarProduto(produtoId: number): Promise<QualidadeDados> {
  const { rows } = await query<Record<string, unknown>>(`
    SELECT p.id,
           p.descricao,
           coalesce(p.custo_referencia, 0)                       AS custo,
           p.estoque_minimo, p.estoque_maximo,
           coalesce(v.demanda_media_diaria, 0)                   AS demanda,
           coalesce(v.estoque_disponivel, 0)                     AS disponivel,
           coalesce(v.estoque_fisico, 0)                         AS fisico,
           (SELECT count(*) FROM produto_fornecedor pf
             JOIN fornecedores f ON f.id = pf.fornecedor_id
            WHERE pf.produto_id = p.id AND pf.ativo
              AND f.deleted_at IS NULL)                          AS fornecedores,
           (SELECT count(*) FROM produto_fornecedor pf
            WHERE pf.produto_id = p.id AND pf.ativo
              AND coalesce(pf.lead_time_dias, 0) > 0)            AS com_lead_time,
           (SELECT count(*) FROM produto_fornecedor pf
            WHERE pf.produto_id = p.id AND pf.ativo
              AND coalesce(pf.preco_atual, 0) > 0)               AS com_preco,
           (SELECT count(DISTINCT iv.venda_id) FROM itens_venda iv
             JOIN vendas ve ON ve.id = iv.venda_id
            WHERE iv.produto_id = p.id
              AND ve.data_venda >= CURRENT_DATE - 365)           AS vendas_ano,
           (SELECT max(ve.data_venda) FROM itens_venda iv
             JOIN vendas ve ON ve.id = iv.venda_id
            WHERE iv.produto_id = p.id)                          AS ultima_venda,
           (SELECT max(hp.data) FROM historico_precos hp
            WHERE hp.produto_id = p.id)                          AS ultimo_preco
      FROM produtos p
      LEFT JOIN vw_estoque_atual v ON v.produto_id = p.id
     WHERE p.id = $1 AND p.deleted_at IS NULL`, [produtoId]);

  if (!rows.length) {
    return {
      apto: false,
      completude: 0,
      achados: [achado('SEM_DEMANDA', 'Produto nao encontrado ou inativo')],
      limitacao: 'Produto nao encontrado no cadastro ativo',
    };
  }

  return avaliarLinha(rows[0]!);
}

/** Mesma auditoria, para um lote de produtos, em uma consulta so. */
export async function auditarProdutos(
  produtoIds: number[],
): Promise<Map<number, QualidadeDados>> {
  if (!produtoIds.length) return new Map();

  const { rows } = await query<Record<string, unknown>>(`
    SELECT p.id,
           p.descricao,
           coalesce(p.custo_referencia, 0)                       AS custo,
           p.estoque_minimo, p.estoque_maximo,
           coalesce(v.demanda_media_diaria, 0)                   AS demanda,
           coalesce(v.estoque_disponivel, 0)                     AS disponivel,
           coalesce(v.estoque_fisico, 0)                         AS fisico,
           (SELECT count(*) FROM produto_fornecedor pf
             JOIN fornecedores f ON f.id = pf.fornecedor_id
            WHERE pf.produto_id = p.id AND pf.ativo
              AND f.deleted_at IS NULL)                          AS fornecedores,
           (SELECT count(*) FROM produto_fornecedor pf
            WHERE pf.produto_id = p.id AND pf.ativo
              AND coalesce(pf.lead_time_dias, 0) > 0)            AS com_lead_time,
           (SELECT count(*) FROM produto_fornecedor pf
            WHERE pf.produto_id = p.id AND pf.ativo
              AND coalesce(pf.preco_atual, 0) > 0)               AS com_preco,
           (SELECT count(DISTINCT iv.venda_id) FROM itens_venda iv
             JOIN vendas ve ON ve.id = iv.venda_id
            WHERE iv.produto_id = p.id
              AND ve.data_venda >= CURRENT_DATE - 365)           AS vendas_ano,
           (SELECT max(ve.data_venda) FROM itens_venda iv
             JOIN vendas ve ON ve.id = iv.venda_id
            WHERE iv.produto_id = p.id)                          AS ultima_venda,
           (SELECT max(hp.data) FROM historico_precos hp
            WHERE hp.produto_id = p.id)                          AS ultimo_preco
      FROM produtos p
      LEFT JOIN vw_estoque_atual v ON v.produto_id = p.id
     WHERE p.id = ANY($1::bigint[]) AND p.deleted_at IS NULL`, [produtoIds]);

  return new Map(rows.map((r) => [Number(r.id), avaliarLinha(r)]));
}

const num = (v: unknown) => Number(v ?? 0);

function avaliarLinha(r: Record<string, unknown>): QualidadeDados {
  const achados: Achado[] = [];

  // Seis campos obrigatorios compoem a completude. A lista e fixa de proposito:
  // completude que muda de denominador conforme o caso nao compara com nada.
  const obrigatorios = [
    num(r.demanda) > 0,
    num(r.custo) > 0,
    num(r.fornecedores) > 0,
    num(r.com_lead_time) > 0,
    num(r.estoque_minimo) > 0 || num(r.estoque_maximo) > 0,
    num(r.com_preco) > 0,
  ];
  const completude = (obrigatorios.filter(Boolean).length / obrigatorios.length) * 100;

  if (num(r.demanda) <= 0) {
    achados.push(achado('SEM_DEMANDA',
      'Sem demanda media apurada: nao da para projetar consumo nem cobertura'));
  }
  if (num(r.custo) <= 0) {
    achados.push(achado('SEM_CUSTO',
      'Sem custo de referencia: o impacto financeiro nao pode ser estimado'));
  }
  if (num(r.fornecedores) <= 0) {
    achados.push(achado('SEM_FORNECEDOR',
      'Nenhum fornecedor ativo vinculado: nao ha a quem comprar'));
  }
  if (num(r.fornecedores) > 0 && num(r.com_lead_time) <= 0) {
    achados.push(achado('SEM_LEAD_TIME',
      'Nenhum fornecedor com lead time informado: a data ideal de compra fica indefinida'));
  }
  if (num(r.estoque_minimo) <= 0 && num(r.estoque_maximo) <= 0) {
    achados.push(achado('SEM_PARAMETROS',
      'Sem estoque minimo e maximo definidos: excesso e falta ficam sem referencia'));
  }
  if (num(r.fornecedores) > 0 && num(r.com_preco) <= 0) {
    achados.push(achado('SEM_PRECO',
      'Nenhum fornecedor com preco registrado'));
  }
  if (num(r.vendas_ano) > 0 && num(r.vendas_ano) < 6) {
    achados.push(achado('HISTORICO_CURTO',
      `Apenas ${num(r.vendas_ano)} venda(s) no ultimo ano: serie curta para tendencia`));
  }
  if (num(r.fisico) < 0 || num(r.disponivel) < 0) {
    achados.push(achado('ESTOQUE_NEGATIVO',
      'Saldo de estoque negativo: o dado esta inconsistente'));
  }

  const ultimaVenda = r.ultima_venda ? String(r.ultima_venda).slice(0, 10) : null;
  if (ultimaVenda && diasDesde(ultimaVenda) > 180) {
    achados.push(achado('DADO_ANTIGO',
      `Ultima venda em ${ultimaVenda}: o comportamento pode ter mudado`));
  }

  const ultimoPreco = r.ultimo_preco ? String(r.ultimo_preco).slice(0, 10) : null;
  if (ultimoPreco && diasDesde(ultimoPreco) > 180) {
    achados.push(achado('PRECO_DESATUALIZADO',
      `Ultimo preco registrado em ${ultimoPreco}`));
  }

  const bloqueia = achados.filter((a) => a.severidade === 'BLOQUEIA');
  const limita = achados.filter((a) => a.severidade === 'LIMITA');

  return {
    apto: bloqueia.length === 0,
    completude: Math.round(completude * 10) / 10,
    achados,
    limitacao: bloqueia.length
      ? `Analise nao realizada: ${bloqueia.map((a) => a.descricao).join('; ')}`
      : limita.length
        ? `Analise parcial: ${limita.map((a) => a.descricao).join('; ')}`
        : null,
  };
}

function diasDesde(data: string): number {
  return Math.round((Date.now() - Date.parse(`${data}T00:00:00Z`)) / 86400000);
}

/**
 * Panorama da base inteira (secao 27), para o painel de governanca.
 *
 * Conta produtos, nao percentuais de linha: o gestor precisa saber quantos
 * cadastros corrigir, nao a nota media da base.
 */
export async function panoramaQualidade() {
  const { rows } = await query<Record<string, unknown>>(`
    SELECT count(*)                                                    AS produtos,
           count(*) FILTER (WHERE coalesce(v.demanda_media_diaria,0)=0) AS sem_demanda,
           count(*) FILTER (WHERE coalesce(p.custo_referencia,0)=0)     AS sem_custo,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM produto_fornecedor pf JOIN fornecedores f ON f.id=pf.fornecedor_id
              WHERE pf.produto_id=p.id AND pf.ativo AND f.deleted_at IS NULL)) AS sem_fornecedor,
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM produto_fornecedor pf
              WHERE pf.produto_id=p.id AND pf.ativo
                AND coalesce(pf.lead_time_dias,0) > 0))                AS sem_lead_time,
           count(*) FILTER (WHERE coalesce(p.estoque_minimo,0)=0
                              AND coalesce(p.estoque_maximo,0)=0)      AS sem_parametros,
           count(*) FILTER (WHERE coalesce(v.estoque_disponivel,0) < 0) AS estoque_negativo
      FROM produtos p
      LEFT JOIN vw_estoque_atual v ON v.produto_id = p.id
     WHERE p.ativo AND p.deleted_at IS NULL`);

  const r = rows[0]!;
  const total = num(r.produtos);
  const pct = (n: unknown) => (total > 0 ? Math.round((num(n) / total) * 1000) / 10 : 0);

  return {
    produtos: total,
    lacunas: [
      { codigo: 'SEM_DEMANDA', produtos: num(r.sem_demanda), percentual: pct(r.sem_demanda),
        efeito: 'Sem projecao de consumo, cobertura nem risco de ruptura' },
      { codigo: 'SEM_CUSTO', produtos: num(r.sem_custo), percentual: pct(r.sem_custo),
        efeito: 'Sem estimativa de impacto financeiro' },
      { codigo: 'SEM_FORNECEDOR', produtos: num(r.sem_fornecedor), percentual: pct(r.sem_fornecedor),
        efeito: 'Sem a quem comprar: recomendacao de compra fica sem destino' },
      { codigo: 'SEM_LEAD_TIME', produtos: num(r.sem_lead_time), percentual: pct(r.sem_lead_time),
        efeito: 'Sem data ideal de compra' },
      { codigo: 'SEM_PARAMETROS', produtos: num(r.sem_parametros), percentual: pct(r.sem_parametros),
        efeito: 'Excesso e falta sem referencia de cadastro' },
      { codigo: 'ESTOQUE_NEGATIVO', produtos: num(r.estoque_negativo),
        percentual: pct(r.estoque_negativo),
        efeito: 'Saldo inconsistente: qualquer conta sobre ele herda o erro' },
    ].filter((l) => l.produtos > 0),
    observacao: 'A IA nao recomenda sobre produto com lacuna BLOQUEIA; informa a limitacao.',
    apurado_em: new Date().toISOString(),
  };
}
