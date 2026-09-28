/**
 * Plano de acao e situacao do fornecedor.
 *
 * Duas coisas que o sistema nunca faz sozinho aqui:
 *
 *   - mudar o status de homologacao por causa do score (regra 9 da secao 67);
 *   - encerrar um plano sem alguem dizer o que aconteceu.
 *
 * Score baixo gera alerta e sugere plano de acao. Bloquear ou monitorar
 * continua sendo decisao de gente, com responsavel e justificativa gravados.
 */
import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { conflito, naoEncontrado, regraNegocio } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import { hojeLocal, paraDataCalendario } from '../../core/datas.js';
import type { z } from 'zod';
import type {
  acaoPlanoSchema, concluirAcaoSchema, listarPlanosSchema, listarSituacoesSchema,
  planoAcaoSchema, situacaoSchema, tratarPlanoSchema,
} from './avaliacao.schemas.js';
import { configuracoes } from './avaliacao.service.js';

type Cliente = { query: (t: string, v?: unknown[]) => Promise<{ rows: any[] }> };

const dataIso = (v: unknown) => paraDataCalendario(v);

/** Workflow da secao 38. Nao ha atalho de ABERTO para ENCERRADO. */
export const FLUXO_PLANO: Record<string, string[]> = {
  ABERTO: ['EM_ANALISE', 'ACAO_DEFINIDA', 'CANCELADO'],
  EM_ANALISE: ['ACAO_DEFINIDA', 'CANCELADO'],
  ACAO_DEFINIDA: ['EM_EXECUCAO', 'AGUARDANDO_FORNECEDOR', 'CANCELADO'],
  EM_EXECUCAO: ['AGUARDANDO_FORNECEDOR', 'VALIDACAO', 'CANCELADO'],
  AGUARDANDO_FORNECEDOR: ['EM_EXECUCAO', 'VALIDACAO', 'CANCELADO'],
  VALIDACAO: ['ENCERRADO', 'EM_EXECUCAO', 'CANCELADO'],
  ENCERRADO: [],
  CANCELADO: [],
};

async function registrarHistorico(
  cliente: Cliente, planoId: number, evento: string,
  anterior: string | null, novo: string | null,
  descricao: string, usuarioId: number | null, detalhes?: unknown,
) {
  await cliente.query(`
    INSERT INTO plano_acao_historico
      (plano_id, evento, status_anterior, status_novo, descricao, detalhes, usuario_id)
    VALUES ($1,$2,$3::status_plano_acao_enum,$4::status_plano_acao_enum,$5,$6::jsonb,$7)`,
    [planoId, evento, anterior, novo, descricao,
      detalhes === undefined ? null : JSON.stringify(detalhes), usuarioId]);
}

async function proximoNumero(cliente: Cliente, prefixo: string) {
  const ano = hojeLocal().slice(0, 4);
  const { rows } = await cliente.query(`
    SELECT coalesce(max(nullif(regexp_replace(numero, '^.*-', ''), '')::bigint), 0) + 1 AS proximo
      FROM planos_acao_fornecedor WHERE numero LIKE $1`, [`${prefixo}-${ano}-%`]);
  return `${prefixo}-${ano}-${String(rows[0].proximo).padStart(5, '0')}`;
}

// ---------------------------------------------------------------------------
// Plano de acao (secoes 37 e 38)
// ---------------------------------------------------------------------------

export async function criarPlano(
  entrada: z.output<typeof planoAcaoSchema>, contexto: ContextoSessao,
) {
  const cfg = await configuracoes();
  const prefixo = cfg['avaliacao.prefixo_plano'] ?? 'PAF';

  return comTransacao(contexto, async (cliente) => {
    const { rows: fornecedor } = await cliente.query(
      'SELECT id, razao_social FROM fornecedores WHERE id = $1 AND deleted_at IS NULL',
      [entrada.fornecedor_id]);
    if (!fornecedor.length) throw naoEncontrado('Fornecedor');

    if (entrada.avaliacao_id) {
      const { rows: avaliacao } = await cliente.query(
        'SELECT id FROM avaliacoes_fornecedores WHERE id = $1 AND fornecedor_id = $2',
        [entrada.avaliacao_id, entrada.fornecedor_id]);
      if (!avaliacao.length) {
        throw regraNegocio('A avaliacao informada nao e deste fornecedor');
      }
    }

    const numero = await proximoNumero(cliente, prefixo);

    const { rows } = await cliente.query(`
      INSERT INTO planos_acao_fornecedor
        (numero, fornecedor_id, avaliacao_id, categoria_id, produto_id, grupo,
         indicador, valor_indicador, meta_indicador, problema, causa, severidade,
         responsavel_id, prazo, evidencia, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6::grupo_criterio_enum,$7,$8,$9,$10,$11,
              $12::severidade_nc_enum,$13,$14::date,$15,$16,$16)
      RETURNING *`,
      [numero, entrada.fornecedor_id, entrada.avaliacao_id ?? null,
        entrada.categoria_id ?? null, entrada.produto_id ?? null, entrada.grupo ?? null,
        entrada.indicador ?? null, entrada.valor_indicador ?? null,
        entrada.meta_indicador ?? null, entrada.problema, entrada.causa ?? null,
        entrada.severidade, entrada.responsavel_id ?? contexto.usuarioId ?? null,
        entrada.prazo ?? null, entrada.evidencia ?? null, contexto.usuarioId ?? null]);

    const planoId = Number(rows[0].id);

    let ordem = 0;
    for (const a of entrada.acoes ?? []) {
      ordem += 1;
      await cliente.query(`
        INSERT INTO plano_acao_itens
          (plano_id, acao, responsavel_id, prazo, evidencia, ordem)
        VALUES ($1,$2,$3,$4::date,$5,$6)`,
        [planoId, a.acao, a.responsavel_id ?? null, a.prazo ?? null,
          a.evidencia ?? null, ordem]);
    }

    await registrarHistorico(cliente, planoId, 'ABERTURA', null, 'ABERTO',
      `Plano ${numero} aberto para ${fornecedor[0].razao_social}: ${entrada.problema}`,
      contexto.usuarioId ?? null,
      { grupo: entrada.grupo, indicador: entrada.indicador, severidade: entrada.severidade });

    return { ...rows[0], acoes: ordem };
  });
}

export async function tratarPlano(
  planoId: number, entrada: z.output<typeof tratarPlanoSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM planos_acao_fornecedor WHERE id = $1 FOR UPDATE', [planoId]);
    if (!rows.length) throw naoEncontrado('Plano de acao');
    const plano = rows[0];

    if (plano.status !== entrada.status) {
      const permitidos = FLUXO_PLANO[plano.status] ?? [];
      if (!permitidos.includes(entrada.status)) {
        throw conflito(
          `Plano em ${plano.status} nao pode ir para ${entrada.status}.`
          + ` Possiveis - ${permitidos.join(', ') || 'nenhum'}`);
      }
    }

    if (entrada.status === 'ENCERRADO') {
      const { rows: abertas } = await cliente.query(`
        SELECT count(*)::int AS total FROM plano_acao_itens
         WHERE plano_id = $1 AND status NOT IN ('ENCERRADO', 'CANCELADO')`, [planoId]);
      if (Number(abertas[0].total) > 0) {
        throw regraNegocio(
          `Ainda ha ${abertas[0].total} acao(oes) em aberto neste plano.`
          + ' Conclua ou cancele antes de encerrar');
      }
    }

    const encerrando = entrada.status === 'ENCERRADO';

    const { rows: atualizado } = await cliente.query(`
      UPDATE planos_acao_fornecedor
         SET status = $2::status_plano_acao_enum,
             causa = coalesce($3, causa),
             responsavel_id = coalesce($4, responsavel_id),
             prazo = coalesce($5::date, prazo),
             evidencia = coalesce($6, evidencia),
             resultado = coalesce($7, resultado),
             encerrado_em = CASE WHEN $8 THEN now() ELSE encerrado_em END,
             encerrado_por = CASE WHEN $8 THEN $9 ELSE encerrado_por END,
             updated_by = $9, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [planoId, entrada.status, entrada.causa ?? null, entrada.responsavel_id ?? null,
        entrada.prazo ?? null, entrada.evidencia ?? null, entrada.resultado ?? null,
        encerrando, contexto.usuarioId ?? null]);

    await registrarHistorico(cliente, planoId, 'TRATATIVA', plano.status, entrada.status,
      entrada.observacao ?? entrada.resultado
        ?? `Plano movido de ${plano.status} para ${entrada.status}`,
      contexto.usuarioId ?? null, { causa: entrada.causa });

    return atualizado[0];
  });
}

export async function registrarAcao(
  planoId: number, entrada: z.output<typeof acaoPlanoSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM planos_acao_fornecedor WHERE id = $1', [planoId]);
    if (!rows.length) throw naoEncontrado('Plano de acao');
    if (['ENCERRADO', 'CANCELADO'].includes(rows[0].status)) {
      throw conflito(`Plano em ${rows[0].status} nao aceita novas acoes`);
    }

    const { rows: ordem } = await cliente.query(
      'SELECT coalesce(max(ordem), 0) + 1 AS proxima FROM plano_acao_itens WHERE plano_id = $1',
      [planoId]);

    const { rows: criada } = await cliente.query(`
      INSERT INTO plano_acao_itens
        (plano_id, acao, responsavel_id, prazo, evidencia, ordem)
      VALUES ($1,$2,$3,$4::date,$5,$6) RETURNING *`,
      [planoId, entrada.acao, entrada.responsavel_id ?? null, entrada.prazo ?? null,
        entrada.evidencia ?? null, ordem[0].proxima]);

    await registrarHistorico(cliente, planoId, 'ACAO_REGISTRADA', null, null,
      `Acao registrada: ${entrada.acao}`, contexto.usuarioId ?? null);

    return criada[0];
  });
}

export async function concluirAcao(
  acaoId: number, entrada: z.output<typeof concluirAcaoSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM plano_acao_itens WHERE id = $1 FOR UPDATE', [acaoId]);
    if (!rows.length) throw naoEncontrado('Acao do plano');

    const concluindo = entrada.status === 'ENCERRADO';
    const { rows: atualizada } = await cliente.query(`
      UPDATE plano_acao_itens
         SET status = $2::status_plano_acao_enum,
             resultado = coalesce($3, resultado),
             concluido_em = CASE WHEN $4 THEN now() ELSE concluido_em END,
             concluido_por = CASE WHEN $4 THEN $5 ELSE concluido_por END,
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [acaoId, entrada.status, entrada.resultado ?? null, concluindo,
        contexto.usuarioId ?? null]);

    await registrarHistorico(cliente, Number(rows[0].plano_id), 'ACAO_ATUALIZADA',
      rows[0].status, entrada.status,
      `Acao "${rows[0].acao}" agora esta ${entrada.status}`
      + (entrada.resultado ? `: ${entrada.resultado}` : ''),
      contexto.usuarioId ?? null);

    return atualizada[0];
  });
}

export async function listarPlanos(
  filtro: z.output<typeof listarPlanosSchema> & Paginacao,
) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const filtrar = (sql: string, valor: unknown) => {
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  if (filtro.fornecedor_id) filtrar('p.fornecedor_id = $?', filtro.fornecedor_id);
  if (filtro.status) filtrar('p.status = $?::status_plano_acao_enum', filtro.status);
  if (filtro.grupo) filtrar('p.grupo = $?::grupo_criterio_enum', filtro.grupo);
  if (filtro.severidade) filtrar('p.severidade = $?::severidade_nc_enum', filtro.severidade);
  if (filtro.apenas_abertos) cond.push("p.status NOT IN ('ENCERRADO', 'CANCELADO')");
  if (filtro.apenas_atrasados) {
    cond.push("p.prazo < CURRENT_DATE AND p.status NOT IN ('ENCERRADO', 'CANCELADO')");
  }
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(p.numero ILIKE $${valores.length} OR p.problema ILIKE $${valores.length}`
      + ` OR f.razao_social ILIKE $${valores.length})`);
  }

  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = await query<{ total: number }>(`
    SELECT count(*)::int AS total FROM planos_acao_fornecedor p
    JOIN fornecedores f ON f.id = p.fornecedor_id ${onde}`, valores);

  const { rows } = await query(`
    SELECT p.*, f.razao_social AS fornecedor, u.nome AS responsavel,
           a.numero AS avaliacao, pr.descricao AS produto, c.nome AS categoria,
           (SELECT count(*)::int FROM plano_acao_itens i WHERE i.plano_id = p.id) AS acoes,
           (SELECT count(*)::int FROM plano_acao_itens i
             WHERE i.plano_id = p.id AND i.status NOT IN ('ENCERRADO','CANCELADO'))
             AS acoes_abertas,
           (p.prazo IS NOT NULL AND p.prazo < CURRENT_DATE
             AND p.status NOT IN ('ENCERRADO','CANCELADO')) AS atrasado
      FROM planos_acao_fornecedor p
      JOIN fornecedores f ON f.id = p.fornecedor_id
      LEFT JOIN usuarios u ON u.id = p.responsavel_id
      LEFT JOIN avaliacoes_fornecedores a ON a.id = p.avaliacao_id
      LEFT JOIN produtos pr ON pr.id = p.produto_id
      LEFT JOIN categorias c ON c.id = p.categoria_id
      ${onde}
     ORDER BY (p.status NOT IN ('ENCERRADO','CANCELADO')) DESC,
              CASE p.severidade WHEN 'CRITICA' THEN 1 WHEN 'ALTA' THEN 2
                                WHEN 'MEDIA' THEN 3 ELSE 4 END,
              p.prazo NULLS LAST, p.id DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return {
    dados: rows.map((p: Record<string, any>) => ({ ...p, prazo: dataIso(p.prazo) })),
    meta: metaPaginacao(Number(total.rows[0]?.total ?? 0), filtro),
  };
}

export async function detalharPlano(planoId: number) {
  const { rows } = await query(`
    SELECT p.*, f.razao_social AS fornecedor, f.cnpj, u.nome AS responsavel,
           a.numero AS avaliacao, a.score_final AS avaliacao_score,
           e.nome AS encerrado_por_nome
      FROM planos_acao_fornecedor p
      JOIN fornecedores f ON f.id = p.fornecedor_id
      LEFT JOIN usuarios u ON u.id = p.responsavel_id
      LEFT JOIN avaliacoes_fornecedores a ON a.id = p.avaliacao_id
      LEFT JOIN usuarios e ON e.id = p.encerrado_por
     WHERE p.id = $1`, [planoId]);
  if (!rows.length) throw naoEncontrado('Plano de acao');

  const [acoes, historico] = await Promise.all([
    query(`
      SELECT i.*, u.nome AS responsavel, c.nome AS concluido_por_nome
        FROM plano_acao_itens i
        LEFT JOIN usuarios u ON u.id = i.responsavel_id
        LEFT JOIN usuarios c ON c.id = i.concluido_por
       WHERE i.plano_id = $1 ORDER BY i.ordem, i.id`, [planoId]),
    query(`
      SELECT h.*, u.nome AS usuario
        FROM plano_acao_historico h
        LEFT JOIN usuarios u ON u.id = h.usuario_id
       WHERE h.plano_id = $1 ORDER BY h.created_at DESC`, [planoId]),
  ]);

  const p: Record<string, any> = rows[0];

  return {
    ...p,
    prazo: dataIso(p.prazo),
    proximos_status: FLUXO_PLANO[p.status] ?? [],
    acoes: acoes.rows.map((a: Record<string, any>) => ({ ...a, prazo: dataIso(a.prazo) })),
    historico: historico.rows,
  };
}

// ---------------------------------------------------------------------------
// Situacao do fornecedor (secoes 39, 40 e 41)
// ---------------------------------------------------------------------------

/**
 * Muda a situacao do fornecedor com responsavel e justificativa.
 *
 * O status novo e gravado no cadastro E no historico. O cadastro responde
 * "como esta hoje"; o historico responde "por que chegou aqui", que e a
 * pergunta que importa numa auditoria.
 */
export async function alterarSituacao(
  fornecedorId: number, entrada: z.output<typeof situacaoSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      `SELECT id, razao_social, status_homologacao FROM fornecedores
        WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [fornecedorId]);
    if (!rows.length) throw naoEncontrado('Fornecedor');
    const atual = rows[0].status_homologacao;

    if (atual === entrada.status) {
      throw conflito(`O fornecedor ja esta em ${entrada.status}`);
    }

    // Encerra a situacao anterior em aberto, se houver.
    await cliente.query(`
      UPDATE situacoes_fornecedor SET encerrado_em = now()
       WHERE fornecedor_id = $1 AND encerrado_em IS NULL`, [fornecedorId]);

    const { rows: situacao } = await cliente.query(`
      INSERT INTO situacoes_fornecedor
        (fornecedor_id, status_anterior, status_novo, motivo_bloqueio, motivo,
         evidencias, indicadores_monitorados, avaliacao_id, prazo,
         responsavel_id, autorizado_por)
      VALUES ($1,$2::status_homologacao_enum,$3::status_homologacao_enum,
              $4::motivo_bloqueio_enum,$5,$6,$7::jsonb,$8,$9::date,$10,$11)
      RETURNING *`,
      [fornecedorId, atual, entrada.status, entrada.motivo_bloqueio ?? null,
        entrada.motivo, entrada.evidencias ?? null,
        entrada.indicadores_monitorados
          ? JSON.stringify(entrada.indicadores_monitorados) : null,
        entrada.avaliacao_id ?? null, entrada.prazo ?? null,
        contexto.usuarioId ?? null, entrada.autorizado_por ?? contexto.usuarioId ?? null]);

    await cliente.query(`
      UPDATE fornecedores
         SET status_homologacao = $2::status_homologacao_enum,
             homologado_em = CASE WHEN $2 IN ('HOMOLOGADO', 'HOMOLOGADO_COM_RESTRICAO')
                                  THEN now() ELSE homologado_em END,
             homologado_por = CASE WHEN $2 IN ('HOMOLOGADO', 'HOMOLOGADO_COM_RESTRICAO')
                                   THEN $3 ELSE homologado_por END,
             updated_by = $3, updated_at = now()
       WHERE id = $1`, [fornecedorId, entrada.status, contexto.usuarioId ?? null]);

    const tipoAlerta = entrada.status === 'BLOQUEADO' ? 'FORNECEDOR_BLOQUEADO'
      : entrada.status === 'EM_MONITORAMENTO' ? 'FORNECEDOR_MONITORADO' : null;

    if (tipoAlerta) {
      await cliente.query(`
        INSERT INTO alertas (tipo, severidade, fornecedor_id, mensagem, detalhes)
        VALUES ($1::tipo_alerta_enum, $2::severidade_enum, $3, $4, $5::jsonb)`,
        [tipoAlerta, entrada.status === 'BLOQUEADO' ? 'CRITICA' : 'ALTA', fornecedorId,
          `${rows[0].razao_social}: ${entrada.status} - ${entrada.motivo}`,
          JSON.stringify({ status_anterior: atual, prazo: entrada.prazo })]);
    }

    return { ...situacao[0], fornecedor: rows[0].razao_social };
  });
}

export async function listarSituacoes(
  filtro: z.output<typeof listarSituacoesSchema> & Paginacao,
) {
  const valores: unknown[] = [];
  const cond: string[] = [];

  if (filtro.fornecedor_id) {
    valores.push(filtro.fornecedor_id);
    cond.push(`s.fornecedor_id = $${valores.length}`);
  }
  if (filtro.status) {
    valores.push(filtro.status);
    cond.push(`s.status_novo = $${valores.length}::status_homologacao_enum`);
  }
  if (filtro.apenas_abertas) cond.push('s.encerrado_em IS NULL');

  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM situacoes_fornecedor s ${onde}`, valores);

  const { rows } = await query(`
    SELECT s.*, f.razao_social AS fornecedor, u.nome AS responsavel,
           a.nome AS autorizado_por_nome, av.numero AS avaliacao
      FROM situacoes_fornecedor s
      JOIN fornecedores f ON f.id = s.fornecedor_id
      LEFT JOIN usuarios u ON u.id = s.responsavel_id
      LEFT JOIN usuarios a ON a.id = s.autorizado_por
      LEFT JOIN avaliacoes_fornecedores av ON av.id = s.avaliacao_id
      ${onde}
     ORDER BY s.iniciado_em DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return {
    dados: rows.map((s: Record<string, any>) => ({ ...s, prazo: dataIso(s.prazo) })),
    meta: metaPaginacao(Number(total.rows[0]?.total ?? 0), filtro),
  };
}
