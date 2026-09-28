import { query, comTransacao, type ContextoSessao } from '../../config/database.js';
import { conflito, naoEncontrado, regraNegocio } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import type { z } from 'zod';
import type {
  criarCotacaoSchema, editarCotacaoSchema, enviarCotacaoSchema, listarCotacoesSchema,
} from './cotacoes.schemas.js';

/** Transicoes permitidas do fluxo da secao 44 do PROMPT 06. */
export const TRANSICOES: Record<string, string[]> = {
  RASCUNHO: ['ENVIADA', 'CANCELADA'],
  ENVIADA: ['AGUARDANDO_RESPOSTAS', 'EM_ANALISE', 'CANCELADA'],
  AGUARDANDO_RESPOSTAS: ['EM_ANALISE', 'CANCELADA'],
  EM_ANALISE: ['NEGOCIACAO_NECESSARIA', 'APROVADA_NEGOCIACAO', 'REJEITADA', 'CANCELADA'],
  NEGOCIACAO_NECESSARIA: ['EM_ANALISE', 'APROVADA_NEGOCIACAO', 'REJEITADA', 'CANCELADA'],
  APROVADA_NEGOCIACAO: ['ENCAMINHADA', 'REJEITADA', 'CANCELADA'],
  ENCAMINHADA: [],
  REJEITADA: [],
  CANCELADA: [],
  // Estados herdados do modulo 01, mantidos por compatibilidade.
  ABERTA: ['EM_ANALISE', 'CANCELADA'],
  EM_NEGOCIACAO: ['APROVADA_NEGOCIACAO', 'REJEITADA', 'CANCELADA'],
  FINALIZADA: [],
};

async function proximoNumero(cliente: { query: (t: string, v?: unknown[]) => Promise<{ rows: any[] }> }) {
  const { rows } = await cliente.query(`
    SELECT 'COT-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' ||
           lpad((count(*) + 1)::text, 3, '0') AS numero
      FROM cotacoes WHERE data_abertura = CURRENT_DATE`);
  return rows[0].numero as string;
}

export async function registrarHistorico(
  cliente: { query: (t: string, v?: unknown[]) => Promise<{ rows: any[] }> },
  cotacaoId: number,
  anterior: string | null,
  novo: string,
  usuarioId: number | null,
  justificativa?: string | null,
  detalhes?: unknown,
) {
  await cliente.query(`
    INSERT INTO cotacao_historico
      (cotacao_id, status_anterior, status_novo, justificativa, detalhes, usuario_id)
    VALUES ($1, $2::status_cotacao_enum, $3::status_cotacao_enum, $4, $5, $6)`,
    [cotacaoId, anterior, novo, justificativa ?? null,
      detalhes === undefined ? null : JSON.stringify(detalhes), usuarioId]);
}

// ---------------------------------------------------------------------------
// Criacao
// ---------------------------------------------------------------------------

type Criar = z.output<typeof criarCotacaoSchema>;

/**
 * Cria a cotacao a partir de uma requisicao aprovada, de necessidades soltas ou
 * manualmente. Em qualquer caso o que ja existe no modulo 05 e reaproveitado:
 * quantidade, unidade, MOQ, multiplo, lead time, data e fornecedor sugerido
 * nao sao pedidos de novo (secao 57).
 */
export async function criarCotacao(entrada: Criar, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    let necessidadeIds: number[] = entrada.necessidade_ids ?? [];
    let requisicaoId: number | null = entrada.requisicao_id ?? null;
    let prioridade = entrada.prioridade;
    let dataNecessaria = entrada.data_necessaria ?? null;
    let localEntregaId = entrada.local_entrega_id ?? null;

    if (requisicaoId) {
      const { rows } = await cliente.query(
        'SELECT * FROM requisicoes_compra WHERE id = $1 FOR UPDATE', [requisicaoId]);
      if (!rows.length) throw naoEncontrado('Requisicao de compra');
      const req = rows[0];
      if (req.status !== 'APROVADA') {
        throw regraNegocio(`Requisicao em ${req.status} nao pode virar cotacao. Somente requisicao aprovada`);
      }
      const { rows: itens } = await cliente.query(
        'SELECT necessidade_id FROM requisicao_compra_itens WHERE requisicao_id = $1', [requisicaoId]);
      necessidadeIds = itens.map((i) => Number(i.necessidade_id)).filter(Boolean);
      prioridade = req.prioridade ?? prioridade;
      dataNecessaria = dataNecessaria ?? req.data_necessaria;
      localEntregaId = localEntregaId ?? req.local_id;
    }

    const numero = await proximoNumero(cliente);
    const dias = Number((await cliente.query(
      "SELECT valor FROM configuracoes WHERE chave = 'cotacao.dias_resposta_padrao'")).rows[0]?.valor ?? 5);

    const { rows: criada } = await cliente.query(`
      INSERT INTO cotacoes
        (numero, data_abertura, data_limite, responsavel_id, status, observacao,
         requisicao_id, origem, prioridade, solicitante_id, comprador_id,
         local_entrega_id, data_necessaria, moeda_base, referencia_economia)
      VALUES ($1, CURRENT_DATE, coalesce($2::date, CURRENT_DATE + $3::int), $4,
              'RASCUNHO', $5, $6, $7, $8, $4, $4, $9, $10, $11, $12)
      RETURNING *`,
      [numero, entrada.data_limite ?? null, dias, contexto.usuarioId ?? null,
        entrada.observacao ?? null, requisicaoId, entrada.origem, prioridade,
        localEntregaId, dataNecessaria, entrada.moeda_base, entrada.referencia_economia]);
    const cotacao = criada[0];

    // Produtos vindos das necessidades do modulo 05.
    if (necessidadeIds.length) {
      const { rows: necessidades } = await cliente.query(`
        SELECT n.*, p.unidade_compra_id, p.unidade_estoque_id, p.dias_validade
          FROM necessidades_compra n
          JOIN produtos p ON p.id = n.produto_id
         WHERE n.id = ANY($1)`, [necessidadeIds]);

      if (!necessidades.length) throw regraNegocio('Nenhuma necessidade valida informada');

      for (const n of necessidades) {
        await cliente.query(`
          INSERT INTO cotacao_produtos
            (cotacao_id, produto_id, necessidade_id, quantidade, unidade_id, fator_conversao,
             moq_esperado, multiplo_esperado, lead_time_esperado, data_necessaria,
             local_entrega_id, fornecedor_sugerido_id, valor_estimado, validade_minima_dias)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (cotacao_id, produto_id) DO NOTHING`,
          [cotacao.id, n.produto_id, n.id,
            n.quantidade_aprovada ?? n.quantidade_sugerida,
            n.unidade_compra_id ?? n.unidade_estoque_id, n.fator_conversao ?? 1,
            n.moq, n.multiplo_compra, n.lead_time_total_dias, n.data_necessaria,
            localEntregaId, n.fornecedor_id, n.valor_estimado, n.dias_validade]);
      }

      await cliente.query(
        `UPDATE necessidades_compra SET status = 'CONVERTIDA_COTACAO'
          WHERE id = ANY($1) AND status IN ('APROVADA', 'AJUSTADA')`, [necessidadeIds]);
    }

    // Produtos informados manualmente.
    for (const p of entrada.produtos ?? []) {
      const { rows: prod } = await cliente.query(
        `SELECT p.id, p.unidade_compra_id, p.unidade_estoque_id, p.fator_conversao,
                p.moq, p.multiplo_compra, p.lead_time_padrao_dias, p.dias_validade
           FROM produtos p WHERE p.id = $1 AND p.deleted_at IS NULL`, [p.produto_id]);
      if (!prod.length) throw naoEncontrado(`Produto ${p.produto_id}`);
      const pr = prod[0];
      await cliente.query(`
        INSERT INTO cotacao_produtos
          (cotacao_id, produto_id, quantidade, quantidade_minima, unidade_id, fator_conversao,
           moq_esperado, multiplo_esperado, lead_time_esperado, data_necessaria,
           local_entrega_id, validade_minima_dias, preco_alvo, preco_maximo, especificacao)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (cotacao_id, produto_id) DO UPDATE SET quantidade = EXCLUDED.quantidade`,
        [cotacao.id, p.produto_id, p.quantidade, p.quantidade_minima ?? null,
          pr.unidade_compra_id ?? pr.unidade_estoque_id, pr.fator_conversao ?? 1,
          pr.moq, pr.multiplo_compra, pr.lead_time_padrao_dias,
          p.data_necessaria ?? dataNecessaria, localEntregaId,
          p.validade_minima_dias ?? pr.dias_validade, p.preco_alvo ?? null,
          p.preco_maximo ?? null, p.especificacao ?? null]);
    }

    const { rows: totalProdutos } = await cliente.query(
      'SELECT count(*)::int AS n FROM cotacao_produtos WHERE cotacao_id = $1', [cotacao.id]);
    if (Number(totalProdutos[0].n) === 0) {
      throw regraNegocio('Cotacao precisa de ao menos um produto');
    }

    if (entrada.fornecedor_ids?.length) {
      await adicionarFornecedoresTx(cliente, cotacao.id, entrada.fornecedor_ids);
    }

    // Os pesos vigentes ficam gravados na cotacao: e o que permite refazer o
    // calculo depois, mesmo que os pesos da empresa mudem (secao 65).
    await copiarCriterios(cliente, cotacao.id);

    await registrarHistorico(cliente, cotacao.id, null, 'RASCUNHO', contexto.usuarioId ?? null,
      entrada.observacao ?? null, { origem: entrada.origem, produtos: Number(totalProdutos[0].n) });

    return { ...cotacao, produtos: Number(totalProdutos[0].n) };
  });
}

/**
 * Copia para a cotacao os pesos vigentes. A escolha e por categoria e origem
 * quando houver configuracao especifica; caso contrario, o peso padrao.
 */
async function copiarCriterios(
  cliente: { query: (t: string, v?: unknown[]) => Promise<{ rows: any[] }> },
  cotacaoId: number,
) {
  const { rows: categorias } = await cliente.query(`
    SELECT DISTINCT p.categoria_id
      FROM cotacao_produtos cp JOIN produtos p ON p.id = cp.produto_id
     WHERE cp.cotacao_id = $1`, [cotacaoId]);
  const categoriaUnica = categorias.length === 1 ? categorias[0].categoria_id : null;

  await cliente.query(`
    INSERT INTO cotacao_criterios (cotacao_id, criterio_id, peso)
    SELECT $1, c.id,
           coalesce(
             (SELECT cc.peso FROM criterios_categoria cc
               WHERE cc.criterio_id = c.id AND cc.categoria_id = $2::bigint
               LIMIT 1),
             c.peso_padrao)
      FROM criterios_cotacao c
     WHERE c.ativo
    ON CONFLICT (cotacao_id, criterio_id) DO NOTHING`, [cotacaoId, categoriaUnica]);
}

// ---------------------------------------------------------------------------
// Fornecedores convidados
// ---------------------------------------------------------------------------

async function adicionarFornecedoresTx(
  cliente: { query: (t: string, v?: unknown[]) => Promise<{ rows: any[] }> },
  cotacaoId: number,
  fornecedorIds: number[],
) {
  const { rows: validos } = await cliente.query(
    `SELECT id FROM fornecedores WHERE id = ANY($1) AND ativo = true AND deleted_at IS NULL`,
    [fornecedorIds]);
  const idsValidos = validos.map((v) => Number(v.id));
  const invalidos = fornecedorIds.filter((f) => !idsValidos.includes(f));
  if (invalidos.length) {
    throw regraNegocio(`Fornecedor inativo ou inexistente - ${invalidos.join(', ')}`);
  }

  const { rows: itens } = await cliente.query(
    'SELECT count(*)::int AS n FROM cotacao_produtos WHERE cotacao_id = $1', [cotacaoId]);

  for (const fornecedorId of idsValidos) {
    await cliente.query(`
      INSERT INTO cotacao_fornecedores
        (cotacao_id, fornecedor_id, status, itens_solicitados)
      VALUES ($1, $2, 'NAO_ENVIADO', $3)
      ON CONFLICT (cotacao_id, fornecedor_id) DO UPDATE
        SET itens_solicitados = EXCLUDED.itens_solicitados`,
      [cotacaoId, fornecedorId, Number(itens[0].n)]);
  }
  return idsValidos.length;
}

export async function adicionarFornecedores(
  cotacaoId: number, fornecedorIds: number[], contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query('SELECT status FROM cotacoes WHERE id = $1 FOR UPDATE', [cotacaoId]);
    if (!rows.length) throw naoEncontrado('Cotacao');
    if (['ENCAMINHADA', 'REJEITADA', 'CANCELADA'].includes(rows[0].status)) {
      throw regraNegocio(`Cotacao em ${rows[0].status} nao aceita novos fornecedores`);
    }
    const adicionados = await adicionarFornecedoresTx(cliente, cotacaoId, fornecedorIds);
    await registrarHistorico(cliente, cotacaoId, rows[0].status, rows[0].status,
      contexto.usuarioId ?? null, 'Fornecedores convidados', { fornecedor_ids: fornecedorIds });
    return { adicionados };
  });
}

export async function removerFornecedor(cotacaoId: number, fornecedorId: number, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    const { rows: respostas } = await cliente.query(
      'SELECT count(*)::int AS n FROM cotacao_itens WHERE cotacao_id = $1 AND fornecedor_id = $2',
      [cotacaoId, fornecedorId]);
    if (Number(respostas[0].n) > 0) {
      throw conflito('Fornecedor ja respondeu esta cotacao. A proposta faz parte do historico e nao pode ser apagada');
    }
    const { rowCount } = await cliente.query(
      'DELETE FROM cotacao_fornecedores WHERE cotacao_id = $1 AND fornecedor_id = $2',
      [cotacaoId, fornecedorId]) as { rowCount: number };
    if (!rowCount) throw naoEncontrado('Fornecedor nesta cotacao');
    await registrarHistorico(cliente, cotacaoId, null, 'RASCUNHO', contexto.usuarioId ?? null,
      'Fornecedor removido', { fornecedor_id: fornecedorId });
    return { removido: true };
  });
}

/** Historico do fornecedor antes de convida-lo (secao 7). */
export async function historicoFornecedor(fornecedorId: number, produtoId?: number) {
  const { rows: fornecedor } = await query(
    'SELECT id, razao_social, origem_fornecedor, prazo_medio_pagamento, lead_time_padrao_dias, ativo FROM fornecedores WHERE id = $1',
    [fornecedorId]);
  if (!fornecedor.length) throw naoEncontrado('Fornecedor');

  const [precos, avaliacao, contrato, ocorrencias] = await Promise.all([
    query(`
      SELECT count(*)::int AS compras,
             max(data)::text AS ultima_compra,
             (array_agg(custo_efetivo ORDER BY data DESC))[1] AS ultimo_preco,
             avg(custo_efetivo) AS preco_medio,
             min(custo_efetivo) AS menor_preco,
             max(custo_efetivo) AS maior_preco
        FROM historico_precos
       WHERE fornecedor_id = $1 AND ($2::bigint IS NULL OR produto_id = $2::bigint)`,
      [fornecedorId, produtoId ?? null]),
    query(`
      SELECT otif, qualidade, lead_time, atendimento, flexibilidade, score_final,
             ocorrencias, periodo_inicio, periodo_fim
        FROM avaliacoes_fornecedores
       WHERE fornecedor_id = $1
       ORDER BY periodo_fim DESC LIMIT 1`, [fornecedorId]),
    produtoId
      ? query(`
          SELECT preco_atual, moq, multiplo_compra, lead_time_dias, prazo_pagamento_dias,
                 moeda, fornecedor_principal
            FROM produto_fornecedor
           WHERE fornecedor_id = $1 AND produto_id = $2 AND ativo`, [fornecedorId, produtoId])
      : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    query(`
      SELECT count(*)::int AS nao_conformidades FROM nao_conformidades nc
       WHERE nc.fornecedor_id = $1 AND nc.created_at > now() - interval '365 days'`, [fornecedorId])
      .catch(() => ({ rows: [{ nao_conformidades: null }] })),
  ]);

  const respostas = await query(`
    SELECT count(*)::int AS convites,
           count(*) FILTER (WHERE status IN ('RESPONDIDA', 'PARCIALMENTE_RESPONDIDA'))::int AS respondidas
      FROM cotacao_fornecedores WHERE fornecedor_id = $1`, [fornecedorId]);

  const r = respostas.rows[0] as { convites: number; respondidas: number };
  return {
    fornecedor: fornecedor[0],
    precos: precos.rows[0],
    avaliacao: avaliacao.rows[0] ?? null,
    contrato: contrato.rows[0] ?? null,
    nao_conformidades_12m: ocorrencias.rows[0]?.nao_conformidades ?? null,
    taxa_resposta_cotacoes: r.convites > 0 ? (r.respondidas / r.convites) * 100 : null,
    convites: r.convites,
  };
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

export async function enviarCotacao(
  cotacaoId: number,
  entrada: z.output<typeof enviarCotacaoSchema>,
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query('SELECT * FROM cotacoes WHERE id = $1 FOR UPDATE', [cotacaoId]);
    if (!rows.length) throw naoEncontrado('Cotacao');
    const cotacao = rows[0];
    if (!TRANSICOES[cotacao.status]?.includes('ENVIADA')) {
      throw regraNegocio(`Cotacao em ${cotacao.status} nao pode ser enviada`);
    }

    const { rows: fornecedores } = await cliente.query(
      'SELECT count(*)::int AS n FROM cotacao_fornecedores WHERE cotacao_id = $1', [cotacaoId]);
    if (Number(fornecedores[0].n) === 0) {
      throw regraNegocio('Convide ao menos um fornecedor antes de enviar a cotacao');
    }

    const { rows: itens } = await cliente.query(
      'SELECT count(*)::int AS n FROM cotacao_produtos WHERE cotacao_id = $1', [cotacaoId]);

    await cliente.query(`
      UPDATE cotacao_fornecedores
         SET status = 'ENVIADA', data_envio = now(), canal_envio = $2,
             responsavel_id = $3, data_prevista_resposta = coalesce($4::date, data_prevista_resposta),
             itens_solicitados = $5
       WHERE cotacao_id = $1 AND status IN ('NAO_ENVIADO', 'PENDENTE')`,
      [cotacaoId, entrada.canal, contexto.usuarioId ?? null,
        entrada.data_limite ?? cotacao.data_limite, Number(itens[0].n)]);

    const { rows: atualizada } = await cliente.query(`
      UPDATE cotacoes
         SET status = 'AGUARDANDO_RESPOSTAS',
             data_limite = coalesce($2::date, data_limite),
             updated_at = now()
       WHERE id = $1 RETURNING *`, [cotacaoId, entrada.data_limite ?? null]);

    await registrarHistorico(cliente, cotacaoId, cotacao.status, 'AGUARDANDO_RESPOSTAS',
      contexto.usuarioId ?? null, entrada.observacao ?? null,
      { canal: entrada.canal, fornecedores: Number(fornecedores[0].n) });

    return atualizada[0];
  });
}

/** Documento de solicitacao (secao 8): o conteudo que vai ao fornecedor. */
export async function documentoSolicitacao(cotacaoId: number, fornecedorId?: number) {
  const { rows: cabecalho } = await query(`
    SELECT c.numero, c.data_abertura, c.data_limite, c.data_necessaria, c.observacao,
           c.moeda_base, u.nome AS responsavel, l.nome AS local_entrega
      FROM cotacoes c
      LEFT JOIN usuarios u ON u.id = c.responsavel_id
      LEFT JOIN locais l ON l.id = c.local_entrega_id
     WHERE c.id = $1`, [cotacaoId]);
  if (!cabecalho.length) throw naoEncontrado('Cotacao');

  const { rows: itens } = await query(`
    SELECT p.codigo, p.descricao, p.descricao_completa, cp.quantidade,
           u.codigo AS unidade, cp.data_necessaria, cp.especificacao,
           cp.validade_minima_dias, l.nome AS local_entrega
      FROM cotacao_produtos cp
      JOIN produtos p ON p.id = cp.produto_id
      LEFT JOIN unidades u ON u.id = cp.unidade_id
      LEFT JOIN locais l ON l.id = cp.local_entrega_id
     WHERE cp.cotacao_id = $1
     ORDER BY p.descricao`, [cotacaoId]);

  const { rows: destinatarios } = await query(`
    SELECT f.id, f.razao_social, f.email, cf.status, cf.data_envio, cf.data_prevista_resposta,
           cf.data_resposta, cf.canal_envio, cf.lembretes
      FROM cotacao_fornecedores cf
      JOIN fornecedores f ON f.id = cf.fornecedor_id
     WHERE cf.cotacao_id = $1 AND ($2::bigint IS NULL OR f.id = $2::bigint)
     ORDER BY f.razao_social`, [cotacaoId, fornecedorId ?? null]);

  return { cabecalho: cabecalho[0], itens, destinatarios };
}

export async function registrarLembrete(cotacaoId: number, fornecedorId: number, contexto: ContextoSessao) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(`
      UPDATE cotacao_fornecedores
         SET lembretes = lembretes + 1, ultimo_lembrete = now()
       WHERE cotacao_id = $1 AND fornecedor_id = $2
       RETURNING *`, [cotacaoId, fornecedorId]);
    if (!rows.length) throw naoEncontrado('Fornecedor nesta cotacao');
    return rows[0];
  });
}

/** Marca como EXPIRADO quem nao respondeu ate a data limite. */
export async function expirarPendentes() {
  const { rows } = await query(`
    UPDATE cotacao_fornecedores cf
       SET status = 'EXPIRADO'
      FROM cotacoes c
     WHERE c.id = cf.cotacao_id
       AND c.data_limite < CURRENT_DATE
       AND cf.status IN ('ENVIADA', 'VISUALIZADO')
     RETURNING cf.id`);
  return { expirados: rows.length };
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export async function listarCotacoes(filtro: z.output<typeof listarCotacoesSchema> & Paginacao) {
  const valores: unknown[] = [];
  const cond: string[] = [];

  if (filtro.status) { valores.push(filtro.status); cond.push(`c.status = $${valores.length}`); }
  if (filtro.comprador_id) { valores.push(filtro.comprador_id); cond.push(`c.comprador_id = $${valores.length}`); }
  if (filtro.prioridade) { valores.push(filtro.prioridade); cond.push(`c.prioridade = $${valores.length}`); }
  if (filtro.data_inicio) { valores.push(filtro.data_inicio); cond.push(`c.data_abertura >= $${valores.length}`); }
  if (filtro.data_fim) { valores.push(filtro.data_fim); cond.push(`c.data_abertura <= $${valores.length}`); }
  if (filtro.apenas_vencidas) {
    cond.push("c.data_limite < CURRENT_DATE AND c.status IN ('ENVIADA','AGUARDANDO_RESPOSTAS')");
  }
  if (filtro.fornecedor_id) {
    valores.push(filtro.fornecedor_id);
    cond.push(`EXISTS (SELECT 1 FROM cotacao_fornecedores cf
                        WHERE cf.cotacao_id = c.id AND cf.fornecedor_id = $${valores.length})`);
  }
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(c.numero ILIKE $${valores.length} OR c.observacao ILIKE $${valores.length})`);
  }
  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM cotacoes c ${onde}`, valores);

  const { rows } = await query(`
    SELECT c.*, u.nome AS comprador, r.numero AS requisicao,
           (SELECT count(*)::int FROM cotacao_produtos cp WHERE cp.cotacao_id = c.id) AS produtos,
           (SELECT count(*)::int FROM cotacao_fornecedores cf WHERE cf.cotacao_id = c.id) AS fornecedores,
           (SELECT count(*)::int FROM cotacao_fornecedores cf
             WHERE cf.cotacao_id = c.id
               AND cf.status IN ('RESPONDIDA','PARCIALMENTE_RESPONDIDA')) AS respondidos,
           (c.data_limite < CURRENT_DATE
            AND c.status IN ('ENVIADA','AGUARDANDO_RESPOSTAS')) AS vencida
      FROM cotacoes c
      LEFT JOIN usuarios u ON u.id = c.comprador_id
      LEFT JOIN requisicoes_compra r ON r.id = c.requisicao_id
      ${onde}
     ORDER BY c.data_abertura DESC, c.id DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return { dados: rows, meta: metaPaginacao(total.rows[0]?.total ?? 0, filtro) };
}

export async function detalharCotacao(cotacaoId: number) {
  const { rows } = await query(`
    SELECT c.*, u.nome AS comprador, s.nome AS solicitante, a.nome AS aprovador,
           r.numero AS requisicao, l.nome AS local_entrega
      FROM cotacoes c
      LEFT JOIN usuarios u ON u.id = c.comprador_id
      LEFT JOIN usuarios s ON s.id = c.solicitante_id
      LEFT JOIN usuarios a ON a.id = c.aprovador_id
      LEFT JOIN requisicoes_compra r ON r.id = c.requisicao_id
      LEFT JOIN locais l ON l.id = c.local_entrega_id
     WHERE c.id = $1`, [cotacaoId]);
  if (!rows.length) throw naoEncontrado('Cotacao');

  const [produtos, fornecedores, criterios, historico] = await Promise.all([
    query(`
      SELECT cp.*, p.codigo, p.descricao, p.classificacao_abc, p.peso,
             un.codigo AS unidade, fs.razao_social AS fornecedor_sugerido,
             (SELECT count(*)::int FROM cotacao_itens ci
               WHERE ci.cotacao_produto_id = cp.id AND ci.quantidade_ofertada IS NOT NULL) AS respostas
        FROM cotacao_produtos cp
        JOIN produtos p ON p.id = cp.produto_id
        LEFT JOIN unidades un ON un.id = cp.unidade_id
        LEFT JOIN fornecedores fs ON fs.id = cp.fornecedor_sugerido_id
       WHERE cp.cotacao_id = $1
       ORDER BY p.descricao`, [cotacaoId]),
    query(`
      SELECT cf.*, f.razao_social, f.origem_fornecedor, f.email, f.ativo
        FROM cotacao_fornecedores cf
        JOIN fornecedores f ON f.id = cf.fornecedor_id
       WHERE cf.cotacao_id = $1
       ORDER BY f.razao_social`, [cotacaoId]),
    query(`
      SELECT cc.peso, cc.eliminatorio, cr.codigo, cr.nome, cr.direcao, cr.descricao
        FROM cotacao_criterios cc
        JOIN criterios_cotacao cr ON cr.id = cc.criterio_id
       WHERE cc.cotacao_id = $1
       ORDER BY cr.ordem`, [cotacaoId]),
    query(`
      SELECT ch.*, u.nome AS usuario
        FROM cotacao_historico ch
        LEFT JOIN usuarios u ON u.id = ch.usuario_id
       WHERE ch.cotacao_id = $1
       ORDER BY ch.created_at DESC`, [cotacaoId]),
  ]);

  return {
    ...rows[0],
    produtos: produtos.rows,
    fornecedores: fornecedores.rows,
    criterios: criterios.rows,
    historico: historico.rows,
  };
}

export async function editarCotacao(
  cotacaoId: number,
  entrada: z.output<typeof editarCotacaoSchema>,
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query('SELECT status FROM cotacoes WHERE id = $1 FOR UPDATE', [cotacaoId]);
    if (!rows.length) throw naoEncontrado('Cotacao');
    if (['ENCAMINHADA', 'REJEITADA', 'CANCELADA'].includes(rows[0].status)) {
      throw regraNegocio(`Cotacao em ${rows[0].status} nao pode ser editada`);
    }
    const { rows: atualizada } = await cliente.query(`
      UPDATE cotacoes
         SET data_limite = coalesce($2::date, data_limite),
             data_necessaria = coalesce($3::date, data_necessaria),
             local_entrega_id = coalesce($4::bigint, local_entrega_id),
             prioridade = coalesce($5::prioridade_compra_enum, prioridade),
             comprador_id = coalesce($6::bigint, comprador_id),
             referencia_economia = coalesce($7::referencia_economia_enum, referencia_economia),
             observacao = coalesce($8::text, observacao),
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [cotacaoId, entrada.data_limite ?? null, entrada.data_necessaria ?? null,
        entrada.local_entrega_id ?? null, entrada.prioridade ?? null,
        entrada.comprador_id ?? null, entrada.referencia_economia ?? null,
        entrada.observacao ?? null]);
    return atualizada[0];
  });
}

// ---------------------------------------------------------------------------
// Criterios e pesos
// ---------------------------------------------------------------------------

export async function listarCriterios(cotacaoId: number) {
  const { rows } = await query(`
    SELECT cc.peso, cc.eliminatorio, cr.id AS criterio_id, cr.codigo, cr.nome,
           cr.descricao, cr.direcao, cr.peso_padrao
      FROM cotacao_criterios cc
      JOIN criterios_cotacao cr ON cr.id = cc.criterio_id
     WHERE cc.cotacao_id = $1
     ORDER BY cr.ordem`, [cotacaoId]);
  const soma = rows.reduce((a, r) => a + Number(r.peso), 0);
  return { criterios: rows, soma_pesos: soma, valido: Math.abs(soma - 100) < 0.01 };
}

export async function definirCriterios(
  cotacaoId: number,
  criterios: Array<{ codigo: string; peso: number; eliminatorio: boolean }>,
  contexto: ContextoSessao,
) {
  const soma = criterios.reduce((a, c) => a + c.peso, 0);
  if (Math.abs(soma - 100) > 0.01) {
    throw regraNegocio(`A soma dos pesos deve ser 100. Informado - ${soma.toFixed(2)}`);
  }

  return comTransacao(contexto, async (cliente) => {
    const { rows: cotacao } = await cliente.query(
      'SELECT status FROM cotacoes WHERE id = $1 FOR UPDATE', [cotacaoId]);
    if (!cotacao.length) throw naoEncontrado('Cotacao');
    if (['ENCAMINHADA', 'REJEITADA', 'CANCELADA'].includes(cotacao[0].status)) {
      throw regraNegocio(`Cotacao em ${cotacao[0].status} nao aceita mudanca de criterios`);
    }

    const codigos = criterios.map((c) => c.codigo);
    const { rows: existentes } = await cliente.query(
      'SELECT id, codigo FROM criterios_cotacao WHERE codigo = ANY($1)', [codigos]);
    const mapa = new Map(existentes.map((e) => [e.codigo, Number(e.id)]));
    const desconhecidos = codigos.filter((c) => !mapa.has(c));
    if (desconhecidos.length) {
      throw regraNegocio(`Criterio desconhecido - ${desconhecidos.join(', ')}`);
    }

    await cliente.query('DELETE FROM cotacao_criterios WHERE cotacao_id = $1', [cotacaoId]);
    for (const c of criterios) {
      await cliente.query(
        'INSERT INTO cotacao_criterios (cotacao_id, criterio_id, peso, eliminatorio) VALUES ($1, $2, $3, $4)',
        [cotacaoId, mapa.get(c.codigo), c.peso, c.eliminatorio]);
    }

    await registrarHistorico(cliente, cotacaoId, cotacao[0].status, cotacao[0].status,
      contexto.usuarioId ?? null, 'Pesos dos criterios alterados', { criterios });

    return listarCriterios(cotacaoId);
  });
}

export async function catalogoCriterios() {
  const { rows } = await query(
    'SELECT * FROM criterios_cotacao ORDER BY ordem');
  const { rows: porCategoria } = await query(`
    SELECT cc.*, c.nome AS categoria, cr.codigo
      FROM criterios_categoria cc
      LEFT JOIN categorias c ON c.id = cc.categoria_id
      JOIN criterios_cotacao cr ON cr.id = cc.criterio_id
     ORDER BY c.nome NULLS FIRST, cr.codigo`);
  return { criterios: rows, por_categoria: porCategoria };
}
