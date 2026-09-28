/**
 * Ocorrencias logisticas, acoes sobre atraso e contatos com o fornecedor
 * (secoes 26, 30, 31, 32 e 33).
 *
 * O SLA nao e um campo que alguem digita: ele vem da prioridade, pela tabela
 * de configuracoes, e fica congelado na ocorrencia. Mudar o parametro depois
 * nao reescreve o prazo de quem ja estava aberto.
 */
import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import type { z } from 'zod';
import type {
  acaoSchema, concluirAcaoSchema, contatoSchema, documentoSchema, listarOcorrenciasSchema,
  ocorrenciaSchema, tratarOcorrenciaSchema,
} from './entregas.schemas.js';
import { avaliarSla } from './calculos.js';
import { configuracoes } from './acompanhamento.service.js';

type Cliente = { query: (t: string, v?: unknown[]) => Promise<{ rows: any[] }> };

const CHAVE_SLA: Record<string, string> = {
  CRITICA: 'entrega.sla_ocorrencia_critica_horas',
  ALTA: 'entrega.sla_ocorrencia_alta_horas',
  MEDIA: 'entrega.sla_ocorrencia_media_horas',
  BAIXA: 'entrega.sla_ocorrencia_baixa_horas',
};

const ENCERRADAS = ['RESOLVIDA', 'CANCELADA'];

async function registrarHistoricoPedido(
  cliente: Cliente, pedidoId: number, evento: string,
  usuarioId: number | null, descricao: string, detalhes?: unknown,
) {
  await cliente.query(`
    INSERT INTO pedido_historico
      (ordem_compra_id, evento, status_anterior, status_novo, descricao, detalhes, usuario_id)
    VALUES ($1, $2, NULL, NULL, $3, $4::jsonb, $5)`,
    [pedidoId, evento, descricao, JSON.stringify(detalhes ?? {}), usuarioId]);
}

// ---------------------------------------------------------------------------
// Ocorrencias
// ---------------------------------------------------------------------------

export async function abrirOcorrencia(
  entrada: z.output<typeof ocorrenciaSchema>, contexto: ContextoSessao,
) {
  const cfg = await configuracoes();
  const slaHoras = Number(cfg[CHAVE_SLA[entrada.prioridade]!] ?? 24);

  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT id, fornecedor_id, numero, status FROM ordens_compra WHERE id = $1',
      [entrada.ordem_compra_id]);
    if (!rows.length) throw naoEncontrado('Pedido de compra');
    const pedido = rows[0];

    let motivoId = entrada.motivo_atraso_id ?? null;
    if (!motivoId && entrada.motivo_codigo) {
      const { rows: m } = await cliente.query(
        'SELECT id FROM motivos_atraso WHERE codigo = $1 AND ativo', [entrada.motivo_codigo]);
      if (!m.length) throw regraNegocio(`Motivo ${entrada.motivo_codigo} nao existe ou esta inativo`);
      motivoId = Number(m[0].id);
    }

    const prefixo = cfg['entrega.prefixo_ocorrencia'] ?? 'OCO';
    const ano = new Date().getUTCFullYear();
    const { rows: seq } = await cliente.query(`
      SELECT coalesce(max(nullif(regexp_replace(numero, '^.*-', ''), '')::bigint), 0) + 1 AS proximo
        FROM ocorrencias_entrega WHERE numero LIKE $1`, [`${prefixo}-${ano}-%`]);
    const numero = `${prefixo}-${ano}-${String(seq[0].proximo).padStart(6, '0')}`;

    const { rows: criada } = await cliente.query(`
      INSERT INTO ocorrencias_entrega
        (numero, ordem_compra_id, ordem_compra_item_id, entrega_id, fornecedor_id,
         tipo, descricao, motivo_atraso_id, prioridade, status, sla_horas,
         prazo_resolucao, responsavel_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::prioridade_entrega_enum,'ABERTA',$10::int,
              now() + make_interval(hours => $10::int), $11, $12)
      RETURNING *`,
      [numero, entrada.ordem_compra_id, entrada.ordem_compra_item_id ?? null,
        entrada.entrega_id ?? null, pedido.fornecedor_id, entrada.tipo, entrada.descricao,
        motivoId, entrada.prioridade, slaHoras,
        entrada.responsavel_id ?? contexto.usuarioId ?? null, contexto.usuarioId ?? null]);

    await registrarHistoricoPedido(cliente, entrada.ordem_compra_id, 'OCORRENCIA_ABERTA',
      contexto.usuarioId ?? null, `Ocorrencia ${numero}: ${entrada.tipo}`,
      { numero, prioridade: entrada.prioridade, sla_horas: slaHoras });

    return { ...criada[0], sla_horas: slaHoras };
  });
}

export async function tratarOcorrencia(
  ocorrenciaId: number, entrada: z.output<typeof tratarOcorrenciaSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM ocorrencias_entrega WHERE id = $1 FOR UPDATE', [ocorrenciaId]);
    if (!rows.length) throw naoEncontrado('Ocorrencia');
    const o = rows[0];

    if (ENCERRADAS.includes(o.status)) {
      throw regraNegocio(`Ocorrencia ${o.numero} ja esta ${o.status}`);
    }

    const encerra = ENCERRADAS.includes(entrada.status);

    const { rows: atualizada } = await cliente.query(`
      UPDATE ocorrencias_entrega
         SET status = $2::status_ocorrencia_enum,
             solucao = coalesce($3, solucao),
             responsavel_id = coalesce($4, responsavel_id),
             data_encerramento = CASE WHEN $5 THEN now() ELSE data_encerramento END,
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [ocorrenciaId, entrada.status, entrada.solucao ?? null,
        entrada.responsavel_id ?? null, encerra]);

    await registrarHistoricoPedido(cliente, Number(o.ordem_compra_id), 'OCORRENCIA_TRATADA',
      contexto.usuarioId ?? null,
      `Ocorrencia ${o.numero}: ${o.status} para ${entrada.status}`,
      { anterior: o.status, novo: entrada.status, observacao: entrada.observacao });

    return atualizada[0];
  });
}

export async function listarOcorrencias(
  filtro: z.output<typeof listarOcorrenciasSchema> & Paginacao,
) {
  const cfg = await configuracoes();
  const percentualAlerta = Number(cfg['entrega.sla_alerta_percentual'] ?? 80);
  const agora = new Date().toISOString();

  const valores: unknown[] = [];
  const cond: string[] = [];
  const filtrar = (sql: string, valor: unknown) => {
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  if (filtro.ordem_compra_id) filtrar('o.ordem_compra_id = $?', filtro.ordem_compra_id);
  if (filtro.fornecedor_id) filtrar('o.fornecedor_id = $?', filtro.fornecedor_id);
  if (filtro.status) filtrar('o.status = $?::status_ocorrencia_enum', filtro.status);
  if (filtro.prioridade) filtrar('o.prioridade = $?::prioridade_entrega_enum', filtro.prioridade);
  if (filtro.apenas_sla_vencido) {
    cond.push("o.status NOT IN ('RESOLVIDA','CANCELADA') AND o.prazo_resolucao < now()");
  }
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(o.numero ILIKE $${valores.length} OR o.tipo ILIKE $${valores.length}`
      + ` OR o.descricao ILIKE $${valores.length})`);
  }

  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM ocorrencias_entrega o ${onde}`, valores);

  const { rows } = await query(`
    SELECT o.*, oc.numero AS pedido, f.razao_social AS fornecedor,
           u.nome AS responsavel, ma.descricao AS motivo, p.descricao AS produto,
           (SELECT count(*)::int FROM acoes_atraso a
             WHERE a.ocorrencia_id = o.id AND a.status IN ('PENDENTE','EM_ANDAMENTO')) AS acoes_pendentes
      FROM ocorrencias_entrega o
      JOIN ordens_compra oc ON oc.id = o.ordem_compra_id
      JOIN fornecedores f ON f.id = o.fornecedor_id
      LEFT JOIN usuarios u ON u.id = o.responsavel_id
      LEFT JOIN motivos_atraso ma ON ma.id = o.motivo_atraso_id
      LEFT JOIN ordem_compra_itens oci ON oci.id = o.ordem_compra_item_id
      LEFT JOIN produtos p ON p.id = oci.produto_id
      ${onde}
     ORDER BY o.prazo_resolucao NULLS LAST, o.data_abertura DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  const dados = rows.map((o) => ({
    ...o,
    sla: avaliarSla({
      abertura: new Date(o.data_abertura).toISOString(),
      slaHoras: o.sla_horas !== null ? Number(o.sla_horas) : null,
      encerramento: o.data_encerramento ? new Date(o.data_encerramento).toISOString() : null,
      agora,
      percentualAlerta,
    }),
  }));

  return { dados, meta: metaPaginacao(Number(total.rows[0]?.total ?? 0), filtro) };
}

export async function detalharOcorrencia(ocorrenciaId: number) {
  const cfg = await configuracoes();
  const { rows } = await query(`
    SELECT o.*, oc.numero AS pedido, f.razao_social AS fornecedor,
           u.nome AS responsavel, ma.descricao AS motivo, p.descricao AS produto
      FROM ocorrencias_entrega o
      JOIN ordens_compra oc ON oc.id = o.ordem_compra_id
      JOIN fornecedores f ON f.id = o.fornecedor_id
      LEFT JOIN usuarios u ON u.id = o.responsavel_id
      LEFT JOIN motivos_atraso ma ON ma.id = o.motivo_atraso_id
      LEFT JOIN ordem_compra_itens oci ON oci.id = o.ordem_compra_item_id
      LEFT JOIN produtos p ON p.id = oci.produto_id
     WHERE o.id = $1`, [ocorrenciaId]);
  if (!rows.length) throw naoEncontrado('Ocorrencia');
  const o = rows[0];

  const [acoes, contatos] = await Promise.all([
    query(`
      SELECT a.*, u.nome AS responsavel FROM acoes_atraso a
      LEFT JOIN usuarios u ON u.id = a.responsavel_id
       WHERE a.ocorrencia_id = $1 ORDER BY a.created_at`, [ocorrenciaId]),
    query(`
      SELECT c.*, u.nome AS usuario FROM contatos_fornecedor_pedido c
      LEFT JOIN usuarios u ON u.id = c.usuario_id
       WHERE c.ocorrencia_id = $1 ORDER BY c.data_contato DESC`, [ocorrenciaId]),
  ]);

  return {
    ...o,
    sla: avaliarSla({
      abertura: new Date(o.data_abertura).toISOString(),
      slaHoras: o.sla_horas !== null ? Number(o.sla_horas) : null,
      encerramento: o.data_encerramento ? new Date(o.data_encerramento).toISOString() : null,
      agora: new Date().toISOString(),
      percentualAlerta: Number(cfg['entrega.sla_alerta_percentual'] ?? 80),
    }),
    acoes: acoes.rows,
    contatos: contatos.rows,
  };
}

// ---------------------------------------------------------------------------
// Acoes sobre atraso (secao 26)
// ---------------------------------------------------------------------------

export async function registrarAcao(
  entrada: z.output<typeof acaoSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT id FROM ordens_compra WHERE id = $1', [entrada.ordem_compra_id]);
    if (!rows.length) throw naoEncontrado('Pedido de compra');

    const { rows: criada } = await cliente.query(`
      INSERT INTO acoes_atraso
        (ordem_compra_id, ocorrencia_id, tipo, descricao, responsavel_id, prazo,
         observacao, created_by)
      VALUES ($1,$2,$3::tipo_acao_atraso_enum,$4,$5,$6,$7,$8) RETURNING *`,
      [entrada.ordem_compra_id, entrada.ocorrencia_id ?? null, entrada.tipo,
        entrada.descricao ?? null, entrada.responsavel_id ?? contexto.usuarioId ?? null,
        entrada.prazo ?? null, entrada.observacao ?? null, contexto.usuarioId ?? null]);

    await registrarHistoricoPedido(cliente, entrada.ordem_compra_id, 'ACAO_ATRASO',
      contexto.usuarioId ?? null, `Acao registrada: ${entrada.tipo}`,
      { tipo: entrada.tipo, prazo: entrada.prazo });

    return criada[0];
  });
}

export async function concluirAcao(
  acaoId: number, entrada: z.output<typeof concluirAcaoSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM acoes_atraso WHERE id = $1 FOR UPDATE', [acaoId]);
    if (!rows.length) throw naoEncontrado('Acao');
    if (['CONCLUIDA', 'CANCELADA'].includes(rows[0].status)) {
      throw regraNegocio(`Acao ja esta ${rows[0].status}`);
    }

    const { rows: atualizada } = await cliente.query(`
      UPDATE acoes_atraso
         SET status = $2, resultado = coalesce($3, resultado),
             concluida_em = CASE WHEN $2 IN ('CONCLUIDA','CANCELADA') THEN now() ELSE concluida_em END,
             updated_at = now()
       WHERE id = $1 RETURNING *`, [acaoId, entrada.status, entrada.resultado ?? null]);

    await registrarHistoricoPedido(cliente, Number(rows[0].ordem_compra_id), 'ACAO_ATRASO',
      contexto.usuarioId ?? null, `Acao ${rows[0].tipo}: ${entrada.status}`,
      { resultado: entrada.resultado });

    return atualizada[0];
  });
}

// ---------------------------------------------------------------------------
// Contatos (secoes 32 e 33)
// ---------------------------------------------------------------------------

/**
 * O contato nao altera o prazo sozinho: se o fornecedor deu uma previsao nova,
 * ela fica registrada como informacao do contato. Mudar a data prometida
 * continua sendo uma alteracao de prazo explicita, com motivo e historico.
 */
export async function registrarContato(
  entrada: z.output<typeof contatoSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT id, fornecedor_id FROM ordens_compra WHERE id = $1', [entrada.ordem_compra_id]);
    if (!rows.length) throw naoEncontrado('Pedido de compra');

    const { rows: criado } = await cliente.query(`
      INSERT INTO contatos_fornecedor_pedido
        (ordem_compra_id, fornecedor_id, ocorrencia_id, canal, assunto, resposta,
         nova_previsao, observacao, usuario_id)
      VALUES ($1,$2,$3,$4::canal_contato_enum,$5,$6,$7,$8,$9) RETURNING *`,
      [entrada.ordem_compra_id, rows[0].fornecedor_id, entrada.ocorrencia_id ?? null,
        entrada.canal, entrada.assunto, entrada.resposta ?? null,
        entrada.nova_previsao ?? null, entrada.observacao ?? null, contexto.usuarioId ?? null]);

    await registrarHistoricoPedido(cliente, entrada.ordem_compra_id, 'CONTATO_FORNECEDOR',
      contexto.usuarioId ?? null, `Contato por ${entrada.canal}: ${entrada.assunto}`,
      { canal: entrada.canal, nova_previsao: entrada.nova_previsao });

    return {
      ...criado[0],
      observacao_sistema: entrada.nova_previsao
        ? 'Nova previsao registrada no contato. Para valer como prazo, use a alteracao de prazo'
        : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Documentos (secao 48)
// ---------------------------------------------------------------------------

export async function registrarDocumento(
  entrada: z.output<typeof documentoSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT id, fornecedor_id FROM ordens_compra WHERE id = $1', [entrada.ordem_compra_id]);
    if (!rows.length) throw naoEncontrado('Pedido de compra');

    const { rows: criado } = await cliente.query(`
      INSERT INTO documentos_entrega
        (ordem_compra_id, entrega_id, fornecedor_id, tipo, numero, descricao,
         referencia, emitido_em, usuario_id)
      VALUES ($1,$2,$3,$4::tipo_documento_entrega_enum,$5,$6,$7,$8,$9) RETURNING *`,
      [entrada.ordem_compra_id, entrada.entrega_id ?? null, rows[0].fornecedor_id,
        entrada.tipo, entrada.numero ?? null, entrada.descricao ?? null,
        entrada.referencia ?? null, entrada.emitido_em ?? null, contexto.usuarioId ?? null]);

    return criado[0];
  });
}

export async function catalogoMotivos() {
  const { rows } = await query(
    'SELECT * FROM motivos_atraso WHERE ativo ORDER BY categoria, descricao');
  return rows;
}
