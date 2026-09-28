import { query, comTransacao, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import type { FiltroPeriodo } from './demanda.schemas.js';
import { z } from 'zod';
import type { importarVendasSchema, comparacaoSchema } from './demanda.schemas.js';

const DIAS_PADRAO = 90;

export interface Periodo {
  inicio: string;
  fim: string;
  dias: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Traduz os filtros de periodo em datas concretas.
 * A referencia e a ultima venda registrada, e nao "hoje": num sistema alimentado
 * por carga do ERP, hoje pode nao ter dado nenhum e todo indicador viria zerado.
 */
export async function resolverPeriodo(filtro: FiltroPeriodo): Promise<Periodo> {
  if (filtro.data_inicio && filtro.data_fim) {
    const inicio = iso(filtro.data_inicio);
    const fim = iso(filtro.data_fim);
    if (fim < inicio) throw regraNegocio('Data final anterior a data inicial');
    const dias = Math.max(1, Math.round((filtro.data_fim.getTime() - filtro.data_inicio.getTime()) / 86400000) + 1);
    return { inicio, fim, dias };
  }

  const { rows } = await query<{ ultima: string | null }>(
    'SELECT max(data_venda)::text AS ultima FROM mv_demanda_diaria',
  );
  const referencia = rows[0]?.ultima ? new Date(`${rows[0].ultima}T00:00:00Z`) : new Date();
  const dias = filtro.dias ?? DIAS_PADRAO;
  const inicio = new Date(referencia.getTime() - (dias - 1) * 86400000);
  return { inicio: iso(inicio), fim: iso(referencia), dias };
}

/** Filtros de catalogo aplicados sobre a tabela `produtos` (alias `p`). */
function condicoesProduto(filtro: FiltroPeriodo, valores: unknown[]): string[] {
  const cond: string[] = [];
  const add = (sql: string, valor: unknown) => {
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };
  if (filtro.produto_id) add('p.id = $?', filtro.produto_id);
  if (filtro.categoria_id) add('p.categoria_id = $?', filtro.categoria_id);
  if (filtro.subcategoria_id) add('p.subcategoria_id = $?', filtro.subcategoria_id);
  if (filtro.marca_id) add('p.marca_id = $?', filtro.marca_id);
  if (filtro.classificacao_abc) add('p.classificacao_abc = $?', filtro.classificacao_abc);
  if (filtro.classificacao_xyz) add('p.classificacao_xyz = $?', filtro.classificacao_xyz);
  if (filtro.fornecedor_id) {
    valores.push(filtro.fornecedor_id);
    cond.push(`EXISTS (SELECT 1 FROM produto_fornecedor pf
                        WHERE pf.produto_id = p.id AND pf.fornecedor_id = $${valores.length})`);
  }
  return cond;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function dashboard(filtro: FiltroPeriodo) {
  const periodo = await resolverPeriodo(filtro);
  const valores: unknown[] = [periodo.inicio, periodo.fim];
  const cond = condicoesProduto(filtro, valores);
  const onde = cond.length ? `AND ${cond.join(' AND ')}` : '';

  // Periodo imediatamente anterior, de mesmo tamanho, para a variacao.
  const anteriorFim = iso(new Date(new Date(`${periodo.inicio}T00:00:00Z`).getTime() - 86400000));
  const anteriorInicio = iso(new Date(new Date(`${periodo.inicio}T00:00:00Z`).getTime() - periodo.dias * 86400000));

  const { rows } = await query(`
    WITH base AS (
      SELECT d.produto_id, d.data_venda, d.quantidade, d.valor, d.documentos
        FROM mv_demanda_diaria d
        JOIN produtos p ON p.id = d.produto_id AND p.deleted_at IS NULL
       WHERE d.data_venda BETWEEN $1 AND $2 ${onde}
    ),
    anterior AS (
      SELECT d.produto_id, sum(d.quantidade) AS quantidade, sum(d.valor) AS valor
        FROM mv_demanda_diaria d
        JOIN produtos p ON p.id = d.produto_id AND p.deleted_at IS NULL
       WHERE d.data_venda BETWEEN $${valores.length + 1} AND $${valores.length + 2} ${onde}
       GROUP BY d.produto_id
    ),
    atual AS (
      SELECT produto_id, sum(quantidade) AS quantidade, sum(valor) AS valor FROM base GROUP BY produto_id
    ),
    variacao AS (
      SELECT a.produto_id,
             a.quantidade AS atual,
             coalesce(ant.quantidade, 0) AS anterior,
             CASE WHEN coalesce(ant.quantidade, 0) > 0
                  THEN (a.quantidade - ant.quantidade) / ant.quantidade * 100 END AS variacao_pct
        FROM atual a LEFT JOIN anterior ant ON ant.produto_id = a.produto_id
    )
    SELECT
      (SELECT coalesce(sum(quantidade), 0) FROM base)                                  AS quantidade_vendida,
      (SELECT coalesce(sum(valor), 0) FROM base)                                       AS faturamento,
      (SELECT coalesce(sum(documentos), 0) FROM base)                                  AS documentos,
      (SELECT count(DISTINCT produto_id) FROM base)                                    AS produtos_com_venda,
      (SELECT coalesce(sum(quantidade), 0) FROM anterior)                              AS quantidade_anterior,
      (SELECT coalesce(sum(valor), 0) FROM anterior)                                   AS faturamento_anterior,
      (SELECT count(*) FROM variacao WHERE variacao_pct > 0)                           AS produtos_em_alta,
      (SELECT count(*) FROM variacao WHERE variacao_pct < 0)                           AS produtos_em_queda,
      (SELECT count(*) FROM (
          SELECT p.id FROM produtos p
            JOIN estoques e ON e.produto_id = p.id
           WHERE p.deleted_at IS NULL
           GROUP BY p.id HAVING sum(e.quantidade_disponivel) <= 0) x)                  AS produtos_em_ruptura,
      (SELECT count(DISTINCT produto_id) FROM indices_sazonais WHERE confirmado)       AS produtos_sazonais,
      (SELECT coalesce(sum(demanda_estimada), 0) FROM demanda_reprimida
        WHERE periodo_inicio BETWEEN $1 AND $2)                                        AS demanda_reprimida,
      (SELECT coalesce(sum(valor_estimado), 0) FROM demanda_reprimida
        WHERE periodo_inicio BETWEEN $1 AND $2)                                        AS valor_reprimido
  `, [...valores, anteriorInicio, anteriorFim]);

  const r = rows[0] as Record<string, number>;
  const quantidade = Number(r.quantidade_vendida ?? 0);
  const anterior = Number(r.quantidade_anterior ?? 0);

  return {
    periodo,
    periodo_anterior: { inicio: anteriorInicio, fim: anteriorFim },
    quantidade_vendida: quantidade,
    faturamento: Number(r.faturamento ?? 0),
    documentos: Number(r.documentos ?? 0),
    produtos_com_venda: Number(r.produtos_com_venda ?? 0),
    demanda_media_diaria: quantidade / periodo.dias,
    demanda_media_mensal: (quantidade / periodo.dias) * 30,
    quantidade_anterior: anterior,
    faturamento_anterior: Number(r.faturamento_anterior ?? 0),
    variacao_percentual: anterior > 0 ? ((quantidade - anterior) / anterior) * 100 : null,
    produtos_em_alta: Number(r.produtos_em_alta ?? 0),
    produtos_em_queda: Number(r.produtos_em_queda ?? 0),
    produtos_em_ruptura: Number(r.produtos_em_ruptura ?? 0),
    produtos_sazonais: Number(r.produtos_sazonais ?? 0),
    demanda_reprimida_estimada: Number(r.demanda_reprimida ?? 0),
    valor_reprimido_estimado: Number(r.valor_reprimido ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Historico de vendas
// ---------------------------------------------------------------------------

export async function listarVendas(
  filtro: FiltroPeriodo & Paginacao & { cliente_id?: number; tipo_documento?: string },
) {
  const periodo = await resolverPeriodo(filtro);
  const valores: unknown[] = [periodo.inicio, periodo.fim];
  const cond = ['v.data_venda BETWEEN $1 AND $2', ...condicoesProduto(filtro, valores)];

  if (filtro.cliente_id) {
    valores.push(filtro.cliente_id);
    cond.push(`v.cliente_id = $${valores.length}`);
  }
  if (filtro.tipo_documento) {
    valores.push(filtro.tipo_documento);
    cond.push(`v.tipo_documento = $${valores.length}`);
  }
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(p.descricao ILIKE $${valores.length} OR p.codigo ILIKE $${valores.length}
                OR v.numero_documento ILIKE $${valores.length} OR c.nome ILIKE $${valores.length})`);
  }

  const onde = `WHERE ${cond.join(' AND ')}`;
  const de = `FROM itens_venda iv
              JOIN vendas v    ON v.id = iv.venda_id
              JOIN produtos p  ON p.id = iv.produto_id AND p.deleted_at IS NULL
              JOIN unidades u  ON u.id = p.unidade_estoque_id
              LEFT JOIN clientes c ON c.id = v.cliente_id`;

  const total = await query<{ total: number }>(`SELECT count(*)::int AS total ${de} ${onde}`, valores);
  const dados = await query(`
    SELECT v.data_venda, v.numero_documento, v.tipo_documento, v.canal, v.status,
           c.nome AS cliente, c.cidade, c.estado,
           p.id AS produto_id, p.codigo, p.descricao, p.peso,
           u.codigo AS unidade,
           iv.quantidade, iv.preco_unitario, iv.valor_total,
           CASE WHEN v.tipo_documento = 'DEVOLUCAO' THEN -iv.quantidade ELSE iv.quantidade END AS quantidade_liquida
      ${de} ${onde}
     ORDER BY v.data_venda DESC, v.numero_documento
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)],
  );

  return { dados: dados.rows, meta: { ...metaPaginacao(total.rows[0]?.total ?? 0, filtro), periodo } };
}

// ---------------------------------------------------------------------------
// Analise de demanda por produto
// ---------------------------------------------------------------------------

const ORDENAVEIS: Record<string, string> = {
  quantidade: 'quantidade',
  valor: 'valor',
  media_diaria: 'media_diaria',
  variacao: 'variacao_percentual',
  codigo: 'codigo',
  descricao: 'descricao',
};

export async function analisarDemanda(filtro: FiltroPeriodo & Paginacao) {
  const periodo = await resolverPeriodo(filtro);
  const anteriorFim = iso(new Date(new Date(`${periodo.inicio}T00:00:00Z`).getTime() - 86400000));
  const anteriorInicio = iso(new Date(new Date(`${periodo.inicio}T00:00:00Z`).getTime() - periodo.dias * 86400000));

  const valores: unknown[] = [periodo.inicio, periodo.fim, anteriorInicio, anteriorFim];
  const cond = condicoesProduto(filtro, valores);
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(p.descricao ILIKE $${valores.length} OR p.codigo ILIKE $${valores.length})`);
  }
  const onde = cond.length ? `AND ${cond.join(' AND ')}` : '';

  const colunaOrdem = ORDENAVEIS[filtro.ordenar_por ?? ''] ?? 'quantidade';
  const direcao = filtro.ordem === 'asc' ? 'ASC' : 'DESC';

  const sql = `
    WITH atual AS (
      SELECT d.produto_id, sum(d.quantidade) AS quantidade, sum(d.valor) AS valor,
             count(*) AS dias_com_venda
        FROM mv_demanda_diaria d
        JOIN produtos p ON p.id = d.produto_id AND p.deleted_at IS NULL
       WHERE d.data_venda BETWEEN $1 AND $2 ${onde}
       GROUP BY d.produto_id
    ),
    anterior AS (
      SELECT d.produto_id, sum(d.quantidade) AS quantidade
        FROM mv_demanda_diaria d
        JOIN produtos p ON p.id = d.produto_id AND p.deleted_at IS NULL
       WHERE d.data_venda BETWEEN $3 AND $4 ${onde}
       GROUP BY d.produto_id
    ),
    consolidado AS (
      SELECT p.id AS produto_id, p.codigo, p.descricao, p.peso,
             p.classificacao_abc, p.classificacao_xyz, c.nome AS categoria,
             a.quantidade, a.valor, a.dias_com_venda,
             a.quantidade / ${periodo.dias}::numeric                AS media_diaria,
             a.quantidade / ${periodo.dias}::numeric * 7            AS media_semanal,
             a.quantidade / ${periodo.dias}::numeric * 30           AS media_mensal,
             coalesce(ant.quantidade, 0)                            AS quantidade_anterior,
             CASE WHEN coalesce(ant.quantidade, 0) > 0
                  THEN (a.quantidade - ant.quantidade) / ant.quantidade * 100 END AS variacao_percentual
        FROM atual a
        JOIN produtos p  ON p.id = a.produto_id
        JOIN categorias c ON c.id = p.categoria_id
        LEFT JOIN anterior ant ON ant.produto_id = a.produto_id
    )
    SELECT * FROM consolidado`;

  const total = await query<{ total: number }>(
    `WITH x AS (${sql}) SELECT count(*)::int AS total FROM x`, valores,
  );
  const dados = await query(
    `${sql} ORDER BY ${colunaOrdem} ${direcao} NULLS LAST
      LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)],
  );

  return {
    dados: dados.rows,
    meta: { ...metaPaginacao(total.rows[0]?.total ?? 0, filtro), periodo, periodo_anterior: { inicio: anteriorInicio, fim: anteriorFim } },
  };
}

// ---------------------------------------------------------------------------
// Detalhe de um produto
// ---------------------------------------------------------------------------

export async function detalharProduto(produtoId: number, filtro: FiltroPeriodo) {
  const periodo = await resolverPeriodo({ ...filtro, dias: filtro.dias ?? 365 });

  const produto = await query(`
    SELECT p.id, p.codigo, p.descricao, p.descricao_completa, p.peso,
           p.classificacao_abc, p.classificacao_xyz,
           p.lead_time_padrao_dias, p.moq, p.multiplo_compra,
           c.nome AS categoria, m.nome AS marca, u.codigo AS unidade
      FROM produtos p
      JOIN categorias c ON c.id = p.categoria_id
      LEFT JOIN marcas m ON m.id = p.marca_id
      JOIN unidades u ON u.id = p.unidade_estoque_id
     WHERE p.id = $1 AND p.deleted_at IS NULL`, [produtoId]);
  if (!produto.rows.length) throw naoEncontrado('Produto');

  const [serieDiaria, serieMensal, estoque, previsao, sazonalidade, fornecedor, reprimida] = await Promise.all([
    query(`SELECT data_venda, quantidade, valor, documentos
             FROM mv_demanda_diaria
            WHERE produto_id = $1 AND data_venda BETWEEN $2 AND $3
            ORDER BY data_venda`, [produtoId, periodo.inicio, periodo.fim]),
    query(`SELECT mes, quantidade, valor, dias_com_venda
             FROM mv_demanda_mensal
            WHERE produto_id = $1 ORDER BY mes`, [produtoId]),
    query(`SELECT coalesce(sum(quantidade_fisica), 0)      AS estoque_fisico,
                  coalesce(sum(quantidade_disponivel), 0)  AS estoque_disponivel,
                  coalesce(sum(quantidade_reservada), 0)   AS estoque_reservado,
                  coalesce(sum(quantidade_em_transito), 0) AS estoque_em_transito
             FROM estoques WHERE produto_id = $1`, [produtoId]),
    query(`SELECT * FROM previsoes_demanda
            WHERE produto_id = $1 ORDER BY periodo_inicio DESC, versao DESC LIMIT 1`, [produtoId]),
    query(`SELECT mes, indice, demanda_media_mes, ciclos_observados, confirmado
             FROM indices_sazonais WHERE produto_id = $1 ORDER BY mes`, [produtoId]),
    query(`SELECT f.id, f.razao_social, pf.lead_time_dias, pf.preco_atual, pf.moq, pf.multiplo_compra
             FROM produto_fornecedor pf
             JOIN fornecedores f ON f.id = pf.fornecedor_id
            WHERE pf.produto_id = $1 AND pf.ativo = true
            ORDER BY pf.fornecedor_principal DESC, pf.preco_atual ASC NULLS LAST LIMIT 1`, [produtoId]),
    query(`SELECT periodo_inicio, periodo_fim, dias_ruptura, demanda_estimada,
                  valor_estimado, classificacao
             FROM demanda_reprimida WHERE produto_id = $1
            ORDER BY periodo_inicio DESC LIMIT 12`, [produtoId]),
  ]);

  const quantidade = serieDiaria.rows.reduce((a, r) => a + Number(r.quantidade), 0);
  const est = estoque.rows[0] as Record<string, number> | undefined;
  const disponivel = Number(est?.estoque_disponivel ?? 0);
  const mediaDiaria = quantidade / periodo.dias;

  return {
    produto: produto.rows[0],
    periodo,
    resumo: {
      quantidade,
      valor: serieDiaria.rows.reduce((a, r) => a + Number(r.valor), 0),
      dias_com_venda: serieDiaria.rows.length,
      media_diaria: mediaDiaria,
      media_mensal: mediaDiaria * 30,
      cobertura_dias: mediaDiaria > 0 ? disponivel / mediaDiaria : null,
    },
    estoque: est ?? null,
    serie_diaria: serieDiaria.rows,
    serie_mensal: serieMensal.rows,
    previsao: previsao.rows[0] ?? null,
    sazonalidade: sazonalidade.rows,
    fornecedor_principal: fornecedor.rows[0] ?? null,
    demanda_reprimida: reprimida.rows,
  };
}

export async function analisarCategoria(categoriaId: number, filtro: FiltroPeriodo) {
  const periodo = await resolverPeriodo(filtro);
  const { rows } = await query(`
    SELECT p.id AS produto_id, p.codigo, p.descricao,
           sc.nome AS subcategoria,
           coalesce(sum(d.quantidade), 0) AS quantidade,
           coalesce(sum(d.valor), 0)      AS valor,
           coalesce(sum(d.quantidade), 0) / $3::numeric AS media_diaria
      FROM produtos p
      LEFT JOIN subcategorias sc ON sc.id = p.subcategoria_id
      LEFT JOIN mv_demanda_diaria d
             ON d.produto_id = p.id AND d.data_venda BETWEEN $1 AND $2
     WHERE p.categoria_id = $4 AND p.deleted_at IS NULL
     GROUP BY p.id, p.codigo, p.descricao, sc.nome
     ORDER BY quantidade DESC`, [periodo.inicio, periodo.fim, periodo.dias, categoriaId]);

  const categoria = await query('SELECT id, nome FROM categorias WHERE id = $1', [categoriaId]);
  if (!categoria.rows.length) throw naoEncontrado('Categoria');

  return {
    categoria: categoria.rows[0],
    periodo,
    total_quantidade: rows.reduce((a, r) => a + Number(r.quantidade), 0),
    total_valor: rows.reduce((a, r) => a + Number(r.valor), 0),
    produtos: rows,
  };
}

// ---------------------------------------------------------------------------
// Comparacao de periodos
// ---------------------------------------------------------------------------

function janelasComparacao(modo: string, hoje: Date) {
  const ano = hoje.getUTCFullYear();
  const mes = hoje.getUTCMonth();
  const primeiroDia = (a: number, m: number) => new Date(Date.UTC(a, m, 1));
  const ultimoDia = (a: number, m: number) => new Date(Date.UTC(a, m + 1, 0));

  if (modo === 'MESMO_MES_ANO_ANTERIOR') {
    return {
      atual: { inicio: iso(primeiroDia(ano, mes)), fim: iso(ultimoDia(ano, mes)) },
      anterior: { inicio: iso(primeiroDia(ano - 1, mes)), fim: iso(ultimoDia(ano - 1, mes)) },
    };
  }
  if (modo === 'TRIMESTRE') {
    const inicioTri = Math.floor(mes / 3) * 3;
    return {
      atual: { inicio: iso(primeiroDia(ano, inicioTri)), fim: iso(ultimoDia(ano, inicioTri + 2)) },
      anterior: { inicio: iso(primeiroDia(ano, inicioTri - 3)), fim: iso(ultimoDia(ano, inicioTri - 1)) },
    };
  }
  return {
    atual: { inicio: iso(primeiroDia(ano, mes)), fim: iso(ultimoDia(ano, mes)) },
    anterior: { inicio: iso(primeiroDia(ano, mes - 1)), fim: iso(ultimoDia(ano, mes - 1)) },
  };
}

export async function compararPeriodos(filtro: z.output<typeof comparacaoSchema>) {
  let atual: { inicio: string; fim: string };
  let anterior: { inicio: string; fim: string };

  if (filtro.modo === 'PERSONALIZADO') {
    if (!filtro.atual_inicio || !filtro.atual_fim || !filtro.anterior_inicio || !filtro.anterior_fim) {
      throw regraNegocio('Comparacao personalizada exige as quatro datas');
    }
    atual = { inicio: iso(filtro.atual_inicio), fim: iso(filtro.atual_fim) };
    anterior = { inicio: iso(filtro.anterior_inicio), fim: iso(filtro.anterior_fim) };
  } else {
    const { rows } = await query<{ ultima: string | null }>(
      'SELECT max(data_venda)::text AS ultima FROM mv_demanda_diaria',
    );
    const referencia = rows[0]?.ultima ? new Date(`${rows[0].ultima}T00:00:00Z`) : new Date();
    ({ atual, anterior } = janelasComparacao(filtro.modo, referencia));
  }

  // Os filtros de catalogo entram sempre nas posicoes $3 em diante, para que a
  // mesma consulta sirva aos dois periodos sem renumerar parametro nenhum.
  const extras: unknown[] = [];
  const cond: string[] = [];
  if (filtro.produto_id) { extras.push(filtro.produto_id); cond.push(`p.id = $${extras.length + 2}`); }
  if (filtro.categoria_id) { extras.push(filtro.categoria_id); cond.push(`p.categoria_id = $${extras.length + 2}`); }
  const onde = cond.length ? `AND ${cond.join(' AND ')}` : '';

  const agregado = async (i: string, f: string) => {
    const { rows } = await query<{ quantidade: number; valor: number; produtos: number }>(`
      SELECT coalesce(sum(d.quantidade), 0) AS quantidade,
             coalesce(sum(d.valor), 0)      AS valor,
             count(DISTINCT d.produto_id)   AS produtos
        FROM mv_demanda_diaria d
        JOIN produtos p ON p.id = d.produto_id AND p.deleted_at IS NULL
       WHERE d.data_venda BETWEEN $1 AND $2 ${onde}`,
      [i, f, ...extras]);
    const dias = Math.max(1, Math.round((new Date(f).getTime() - new Date(i).getTime()) / 86400000) + 1);
    const r = rows[0]!;
    return { inicio: i, fim: f, dias, quantidade: Number(r.quantidade), valor: Number(r.valor), produtos: Number(r.produtos), media_diaria: Number(r.quantidade) / dias };
  };

  const a = await agregado(atual.inicio, atual.fim);
  const b = await agregado(anterior.inicio, anterior.fim);
  const variacao = (x: number, y: number) => (y > 0 ? ((x - y) / y) * 100 : null);

  return {
    modo: filtro.modo,
    atual: a,
    anterior: b,
    variacao: {
      quantidade: variacao(a.quantidade, b.quantidade),
      valor: variacao(a.valor, b.valor),
      media_diaria: variacao(a.media_diaria, b.media_diaria),
    },
  };
}

// ---------------------------------------------------------------------------
// Demanda por dia da semana / mes / ano
// ---------------------------------------------------------------------------

export async function perfilTemporal(filtro: FiltroPeriodo) {
  const periodo = await resolverPeriodo({ ...filtro, dias: filtro.dias ?? 365 });
  const valores: unknown[] = [periodo.inicio, periodo.fim];
  const cond = condicoesProduto(filtro, valores);
  const onde = cond.length ? `AND ${cond.join(' AND ')}` : '';

  const [semana, mes, ano] = await Promise.all([
    query(`SELECT extract(dow FROM d.data_venda)::int AS dia_semana,
                  sum(d.quantidade) AS quantidade, count(DISTINCT d.data_venda) AS dias
             FROM mv_demanda_diaria d JOIN produtos p ON p.id = d.produto_id AND p.deleted_at IS NULL
            WHERE d.data_venda BETWEEN $1 AND $2 ${onde}
            GROUP BY 1 ORDER BY 1`, valores),
    query(`SELECT extract(month FROM d.data_venda)::int AS mes,
                  extract(year FROM d.data_venda)::int AS ano,
                  sum(d.quantidade) AS quantidade, sum(d.valor) AS valor
             FROM mv_demanda_diaria d JOIN produtos p ON p.id = d.produto_id AND p.deleted_at IS NULL
            WHERE d.data_venda BETWEEN $1 AND $2 ${onde}
            GROUP BY 1, 2 ORDER BY 2, 1`, valores),
    query(`SELECT extract(year FROM d.data_venda)::int AS ano,
                  sum(d.quantidade) AS quantidade, sum(d.valor) AS valor
             FROM mv_demanda_diaria d JOIN produtos p ON p.id = d.produto_id AND p.deleted_at IS NULL
            GROUP BY 1 ORDER BY 1`, []),
  ]);

  const totalSemana = semana.rows.reduce((a, r) => a + Number(r.quantidade), 0);
  const nomes = ['Domingo', 'Segunda', 'Terca', 'Quarta', 'Quinta', 'Sexta', 'Sabado'];

  return {
    periodo,
    por_dia_semana: semana.rows.map((r) => ({
      dia_semana: Number(r.dia_semana),
      nome: nomes[Number(r.dia_semana)],
      quantidade: Number(r.quantidade),
      dias: Number(r.dias),
      media: Number(r.dias) > 0 ? Number(r.quantidade) / Number(r.dias) : 0,
      participacao_percentual: totalSemana > 0 ? (Number(r.quantidade) / totalSemana) * 100 : 0,
    })),
    por_mes: mes.rows,
    por_ano: ano.rows,
  };
}

// ---------------------------------------------------------------------------
// Qualidade dos dados
// ---------------------------------------------------------------------------

export async function qualidadeDados() {
  const { rows } = await query(`
    SELECT
      (SELECT count(*) FROM itens_venda iv LEFT JOIN produtos p ON p.id = iv.produto_id
        WHERE p.id IS NULL)                                                     AS itens_sem_produto,
      (SELECT count(*) FROM vendas WHERE cliente_id IS NULL)                     AS vendas_sem_cliente,
      (SELECT count(*) FROM vendas WHERE data_venda > CURRENT_DATE)              AS vendas_data_futura,
      (SELECT count(*) FROM vendas WHERE data_venda < '2000-01-01')              AS vendas_data_invalida,
      (SELECT count(*) FROM itens_venda WHERE quantidade <= 0)                   AS itens_quantidade_invalida,
      (SELECT count(*) FROM itens_venda WHERE valor_total = 0 AND quantidade > 0) AS itens_valor_zero,
      (SELECT count(*) FROM vendas WHERE status = 'CANCELADA')                   AS vendas_canceladas,
      (SELECT count(*) FROM vendas WHERE tipo_documento = 'DEVOLUCAO')           AS devolucoes,
      (SELECT count(*) FROM produtos p WHERE p.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM mv_demanda_diaria d WHERE d.produto_id = p.id)) AS produtos_sem_venda,
      (SELECT count(*) FROM produtos WHERE deleted_at IS NULL AND peso IS NULL)  AS produtos_sem_peso,
      (SELECT count(*) FROM vendas)                                              AS total_vendas,
      (SELECT count(*) FROM itens_venda)                                         AS total_itens,
      (SELECT min(data_venda)::text FROM vendas)                                 AS primeira_venda,
      (SELECT max(data_venda)::text FROM vendas)                                 AS ultima_venda
  `);
  const r = rows[0] as Record<string, unknown>;
  const problemas = Object.entries(r)
    .filter(([k, v]) => k.startsWith('itens_') || k.startsWith('vendas_') || k.startsWith('produtos_'))
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => ({ indicador: k, ocorrencias: Number(v) }));

  return { resumo: r, problemas, sem_problemas: problemas.length === 0 };
}

// ---------------------------------------------------------------------------
// Importacao de vendas
// ---------------------------------------------------------------------------

type Importacao = z.output<typeof importarVendasSchema>;

/**
 * Sobe vendas de planilha/CSV. Em duas fases: sem `confirmar` devolve a previa
 * com os problemas encontrados e NAO grava nada; com `confirmar` grava o que
 * passou na validacao. Documento ja existente e ignorado, nunca duplicado.
 */
export async function importarVendas(payload: Importacao, contexto: ContextoSessao) {
  const codigos = [...new Set(payload.linhas.map((l) => l.codigo_produto))];
  const { rows: produtos } = await query<{ id: number; codigo: string }>(
    'SELECT id, codigo FROM produtos WHERE codigo = ANY($1) AND deleted_at IS NULL', [codigos],
  );
  const mapaProduto = new Map(produtos.map((p) => [p.codigo, p.id]));

  const documentos = [...new Set(payload.linhas.map((l) => l.numero_documento))];
  const { rows: existentes } = await query<{ numero_documento: string }>(
    'SELECT numero_documento FROM vendas WHERE numero_documento = ANY($1)', [documentos],
  );
  const jaExistem = new Set(existentes.map((v) => v.numero_documento));

  const erros: { linha: number; motivo: string }[] = [];
  const validas: typeof payload.linhas = [];

  payload.linhas.forEach((linha, i) => {
    const n = i + 1;
    if (!mapaProduto.has(linha.codigo_produto)) {
      erros.push({ linha: n, motivo: `Produto ${linha.codigo_produto} nao cadastrado` });
      return;
    }
    if (linha.quantidade === 0) {
      erros.push({ linha: n, motivo: 'Quantidade zero' });
      return;
    }
    if (Number.isNaN(linha.data_venda.getTime())) {
      erros.push({ linha: n, motivo: 'Data invalida' });
      return;
    }
    if (jaExistem.has(linha.numero_documento)) {
      erros.push({ linha: n, motivo: `Documento ${linha.numero_documento} ja importado` });
      return;
    }
    validas.push(linha);
  });

  const previa = {
    total_linhas: payload.linhas.length,
    linhas_validas: validas.length,
    linhas_com_erro: erros.length,
    documentos_novos: new Set(validas.map((l) => l.numero_documento)).size,
    erros: erros.slice(0, 200),
  };

  if (!payload.confirmar) return { ...previa, importado: false };

  if (!validas.length) throw regraNegocio('Nenhuma linha valida para importar');

  const resultado = await comTransacao(contexto, async (cliente) => {
    const mapaVenda = new Map<string, number>();
    let itens = 0;

    for (const linha of validas) {
      let vendaId = mapaVenda.get(linha.numero_documento);
      if (!vendaId) {
        let clienteId: number | null = null;
        if (linha.codigo_cliente) {
          const { rows } = await cliente.query<{ id: number }>(
            `INSERT INTO clientes (codigo_externo, nome, canal)
             VALUES ($1, $2, $3)
             ON CONFLICT (codigo_externo) DO UPDATE SET nome = EXCLUDED.nome
             RETURNING id`,
            [linha.codigo_cliente, linha.cliente_nome ?? `CLIENTE ${linha.codigo_cliente}`, linha.canal ?? null],
          );
          clienteId = rows[0]?.id ?? null;
        }
        const { rows } = await cliente.query<{ id: number }>(
          `INSERT INTO vendas (numero_documento, data_venda, cliente_id, canal, valor_total,
                               status, tipo_documento, origem_integracao)
           VALUES ($1, $2, $3, $4, 0, 'FATURADA', $5, $6) RETURNING id`,
          [linha.numero_documento, linha.data_venda, clienteId, linha.canal ?? null,
            linha.tipo_documento, payload.origem],
        );
        vendaId = rows[0]!.id;
        mapaVenda.set(linha.numero_documento, vendaId);
      }

      const quantidade = Math.abs(linha.quantidade);
      const valor = Math.abs(linha.valor_total ?? linha.quantidade * linha.preco_unitario);
      await cliente.query(
        `INSERT INTO itens_venda (venda_id, produto_id, quantidade, preco_unitario, desconto, valor_total)
         VALUES ($1, $2, $3, $4, 0, $5)`,
        [vendaId, mapaProduto.get(linha.codigo_produto), quantidade, linha.preco_unitario, valor],
      );
      itens += 1;
    }

    for (const [, vendaId] of mapaVenda) {
      await cliente.query(
        `UPDATE vendas v SET valor_total = (SELECT coalesce(sum(valor_total), 0) FROM itens_venda WHERE venda_id = v.id)
          WHERE v.id = $1`, [vendaId],
      );
    }

    return { vendas: mapaVenda.size, itens };
  });

  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_demanda_diaria');
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_demanda_mensal');

  return { ...previa, importado: true, ...resultado };
}

export async function atualizarAgregados() {
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_demanda_diaria');
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_demanda_mensal');
  const { rows } = await query<{ linhas: number }>('SELECT count(*)::int AS linhas FROM mv_demanda_diaria');
  return { linhas_agregadas: rows[0]?.linhas ?? 0, atualizado_em: new Date().toISOString() };
}
