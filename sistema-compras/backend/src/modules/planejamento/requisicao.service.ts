import { query, comTransacao, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio, semPermissao } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import { alcadaPara } from './visoes.service.js';
import type { z } from 'zod';
import type { criarRequisicaoSchema } from './planejamento.schemas.js';

/**
 * Requisicao de compra: a ponte para o modulo 06.
 *
 * Nasce de uma ou mais necessidades APROVADAS. Este modulo NAO cria cotacao
 * nem ordem de compra (secao 64 do prompt 05) - so consolida o que precisa ser
 * comprado e por quem precisa ser aprovado.
 */
export async function criarRequisicao(
  entrada: z.output<typeof criarRequisicaoSchema>,
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows: necessidades } = await cliente.query(`
      SELECT n.*, p.codigo, p.descricao, p.unidade_compra_id
        FROM necessidades_compra n
        JOIN produtos p ON p.id = n.produto_id
       WHERE n.id = ANY($1)
       FOR UPDATE OF n`, [entrada.necessidade_ids]);

    if (!necessidades.length) throw naoEncontrado('Necessidades informadas');

    const faltando = entrada.necessidade_ids.filter(
      (id) => !necessidades.some((n) => Number(n.id) === id));
    if (faltando.length) throw naoEncontrado(`Necessidade ${faltando[0]}`);

    const naoAprovadas = necessidades.filter((n) => n.status !== 'APROVADA');
    if (naoAprovadas.length) {
      throw regraNegocio(
        `Somente necessidade aprovada vira requisicao. Pendente - ${naoAprovadas.map((n) => n.codigo).slice(0, 5).join(', ')}`,
      );
    }

    // Uma necessidade so pode virar requisicao uma vez.
    const { rows: jaUsadas } = await cliente.query(
      'SELECT necessidade_id FROM requisicao_compra_itens WHERE necessidade_id = ANY($1)',
      [entrada.necessidade_ids]);
    if (jaUsadas.length) {
      throw regraNegocio(`Necessidade ${jaUsadas[0].necessidade_id} ja pertence a uma requisicao`);
    }

    // A requisicao consolida por fornecedor: itens de fornecedores diferentes
    // numa mesma requisicao tornariam a cotacao do modulo 06 impossivel.
    const fornecedores = new Set(necessidades.map((n) => n.fornecedor_id));
    if (!entrada.fornecedor_sugerido_id && fornecedores.size > 1) {
      throw regraNegocio(
        'As necessidades sao de fornecedores diferentes. Informe o fornecedor sugerido ou gere uma requisicao por fornecedor',
      );
    }
    const fornecedorId = entrada.fornecedor_sugerido_id
      ?? necessidades[0]!.fornecedor_id ?? null;

    const valor = necessidades.reduce(
      (a, n) => a + Number(n.quantidade_aprovada ?? n.quantidade_sugerida) * Number(n.preco_estimado ?? 0), 0);

    const ordemPrioridade = ['RUPTURA', 'CRITICA', 'ALTA', 'MEDIA', 'BAIXA', 'SEM_NECESSIDADE'];
    const prioridade = ordemPrioridade.find((p) => necessidades.some((n) => n.prioridade === p)) ?? 'MEDIA';

    const dataNecessaria = entrada.data_necessaria
      ?? necessidades
        .map((n) => n.data_necessaria)
        .filter(Boolean)
        .sort()[0] ?? null;

    const alcada = await alcadaPara(valor);

    const { rows: numero } = await cliente.query(`
      SELECT 'REQ-' || to_char(now(), 'YYYYMMDD') || '-' || lpad((count(*) + 1)::text, 3, '0') AS numero
        FROM requisicoes_compra WHERE data_requisicao = CURRENT_DATE`);

    const { rows: req } = await cliente.query(`
      INSERT INTO requisicoes_compra
        (numero, planejamento_id, fornecedor_sugerido_id, local_id, solicitante_id,
         comprador_id, prioridade, data_necessaria, valor_estimado, status,
         nivel_aprovacao, observacao, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'AGUARDANDO_APROVACAO', $10, $11, $5)
      RETURNING *`,
      [numero[0]!.numero, necessidades[0]!.planejamento_id, fornecedorId,
        entrada.local_id ?? necessidades[0]!.local_id ?? null,
        contexto.usuarioId ?? null, entrada.comprador_id ?? contexto.usuarioId ?? null,
        prioridade, dataNecessaria, valor, alcada?.perfil ?? null,
        entrada.observacao ?? null]);

    const requisicaoId = req[0]!.id;

    for (const n of necessidades) {
      const quantidade = Number(n.quantidade_aprovada ?? n.quantidade_sugerida);
      await cliente.query(`
        INSERT INTO requisicao_compra_itens
          (requisicao_id, produto_id, necessidade_id, fornecedor_id, quantidade, unidade_id,
           quantidade_original, preco_estimado, valor_estimado, data_necessaria, justificativa)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [requisicaoId, n.produto_id, n.id, n.fornecedor_id, quantidade,
          n.unidade_compra_id, n.quantidade_sugerida, n.preco_estimado,
          quantidade * Number(n.preco_estimado ?? 0), n.data_necessaria, n.justificativa]);

      await cliente.query(
        "UPDATE necessidades_compra SET status = 'CONVERTIDA_COTACAO', updated_at = now() WHERE id = $1",
        [n.id]);
      await cliente.query(`
        INSERT INTO necessidade_historico
          (necessidade_id, status_anterior, status_novo, quantidade_anterior, quantidade_nova,
           justificativa, usuario_id)
        VALUES ($1, 'APROVADA', 'CONVERTIDA_COTACAO', $2, $2, $3, $4)`,
        [n.id, quantidade, `Incluida na requisicao ${numero[0]!.numero}`, contexto.usuarioId ?? null]);
    }

    return { ...req[0], itens: necessidades.length, alcada_necessaria: alcada?.perfil ?? null };
  });
}

export async function listarRequisicoes(filtro: Paginacao & { status?: string; fornecedor_id?: number }) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  if (filtro.status) { valores.push(filtro.status); cond.push(`r.status = $${valores.length}`); }
  if (filtro.fornecedor_id) { valores.push(filtro.fornecedor_id); cond.push(`r.fornecedor_sugerido_id = $${valores.length}`); }
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(r.numero ILIKE $${valores.length} OR f.razao_social ILIKE $${valores.length})`);
  }
  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const de = 'FROM requisicoes_compra r LEFT JOIN fornecedores f ON f.id = r.fornecedor_sugerido_id';

  const total = await query<{ total: number }>(`SELECT count(*)::int AS total ${de} ${onde}`, valores);
  const { rows } = await query(`
    SELECT r.*, f.razao_social AS fornecedor,
           s.nome AS solicitante, ap.nome AS aprovador, l.nome AS local,
           (SELECT count(*)::int FROM requisicao_compra_itens i WHERE i.requisicao_id = r.id) AS itens
      ${de}
      LEFT JOIN usuarios s  ON s.id = r.solicitante_id
      LEFT JOIN usuarios ap ON ap.id = r.aprovador_id
      LEFT JOIN locais l    ON l.id = r.local_id
      ${onde}
     ORDER BY r.data_requisicao DESC, r.id DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return { dados: rows, meta: metaPaginacao(total.rows[0]?.total ?? 0, filtro) };
}

export async function detalharRequisicao(id: number) {
  const { rows } = await query(`
    SELECT r.*, f.razao_social AS fornecedor, f.origem_fornecedor,
           s.nome AS solicitante, c.nome AS comprador, ap.nome AS aprovador,
           l.nome AS local, pl.numero AS planejamento
      FROM requisicoes_compra r
      LEFT JOIN fornecedores f ON f.id = r.fornecedor_sugerido_id
      LEFT JOIN usuarios s  ON s.id = r.solicitante_id
      LEFT JOIN usuarios c  ON c.id = r.comprador_id
      LEFT JOIN usuarios ap ON ap.id = r.aprovador_id
      LEFT JOIN locais l    ON l.id = r.local_id
      LEFT JOIN planejamentos_compra pl ON pl.id = r.planejamento_id
     WHERE r.id = $1`, [id]);
  if (!rows.length) throw naoEncontrado('Requisicao');

  const itens = await query(`
    SELECT i.*, p.codigo, p.descricao, u.codigo AS unidade,
           n.prioridade, n.memoria_calculo, n.alertas
      FROM requisicao_compra_itens i
      JOIN produtos p ON p.id = i.produto_id
      LEFT JOIN unidades u ON u.id = i.unidade_id
      LEFT JOIN necessidades_compra n ON n.id = i.necessidade_id
     WHERE i.requisicao_id = $1 ORDER BY i.valor_estimado DESC NULLS LAST`, [id]);

  return { ...rows[0], itens: itens.rows };
}

/**
 * A aprovacao respeita a alcada configurada: o perfil de quem aprova precisa
 * bater com a faixa de valor da requisicao. ADMIN aprova qualquer faixa.
 */
export async function aprovarRequisicao(
  id: number,
  perfilUsuario: string,
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM requisicoes_compra WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) throw naoEncontrado('Requisicao');
    const req = rows[0];

    if (req.status !== 'AGUARDANDO_APROVACAO') {
      throw regraNegocio(`Requisicao em ${req.status} nao esta aguardando aprovacao`);
    }

    const alcada = await alcadaPara(Number(req.valor_estimado));
    if (perfilUsuario !== 'ADMIN' && alcada && alcada.perfil !== perfilUsuario) {
      throw semPermissao(
        `Valor de ${Number(req.valor_estimado).toFixed(2)} exige aprovacao do perfil ${alcada.perfil}`,
      );
    }

    const { rows: aprovada } = await cliente.query(`
      UPDATE requisicoes_compra
         SET status = 'APROVADA', aprovador_id = $2, aprovado_em = now(),
             nivel_aprovacao = $3
       WHERE id = $1 RETURNING *`,
      [id, contexto.usuarioId ?? null, alcada?.perfil ?? perfilUsuario]);
    return aprovada[0];
  });
}

export async function rejeitarRequisicao(id: number, motivo: string | undefined, contexto: ContextoSessao) {
  if (!motivo) throw regraNegocio('Rejeicao de requisicao exige motivo');
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT status FROM requisicoes_compra WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) throw naoEncontrado('Requisicao');
    if (rows[0].status !== 'AGUARDANDO_APROVACAO') {
      throw regraNegocio(`Requisicao em ${rows[0].status} nao pode ser rejeitada`);
    }

    // As necessidades voltam a ficar disponiveis para uma nova decisao.
    await cliente.query(`
      UPDATE necessidades_compra SET status = 'APROVADA'
       WHERE id IN (SELECT necessidade_id FROM requisicao_compra_itens WHERE requisicao_id = $1)`, [id]);

    const { rows: rejeitada } = await cliente.query(`
      UPDATE requisicoes_compra
         SET status = 'REJEITADA', motivo_rejeicao = $2, aprovador_id = $3, aprovado_em = now()
       WHERE id = $1 RETURNING *`, [id, motivo, contexto.usuarioId ?? null]);
    return rejeitada[0];
  });
}

export async function cancelarRequisicao(id: number, motivo: string | undefined, contexto: ContextoSessao) {
  if (!motivo) throw regraNegocio('Cancelamento de requisicao exige motivo');
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT status FROM requisicoes_compra WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) throw naoEncontrado('Requisicao');
    if (['ATENDIDA', 'CANCELADA'].includes(rows[0].status)) {
      throw regraNegocio(`Requisicao em ${rows[0].status} nao pode ser cancelada`);
    }

    await cliente.query(`
      UPDATE necessidades_compra SET status = 'APROVADA'
       WHERE id IN (SELECT necessidade_id FROM requisicao_compra_itens WHERE requisicao_id = $1)`, [id]);

    const { rows: cancelada } = await cliente.query(`
      UPDATE requisicoes_compra SET status = 'CANCELADA', motivo_rejeicao = $2 WHERE id = $1 RETURNING *`,
      [id, motivo]);
    return cancelada[0];
  });
}

/**
 * Gera uma requisicao por fornecedor a partir de todas as necessidades
 * aprovadas do planejamento. E o caminho normal depois de uma rodada de
 * aprovacao em massa.
 */
export async function gerarRequisicoesPorFornecedor(planejamentoId: number, contexto: ContextoSessao) {
  const { rows } = await query<{ fornecedor_id: number | null; ids: number[] }>(`
    SELECT n.fornecedor_id, array_agg(n.id) AS ids
      FROM necessidades_compra n
      LEFT JOIN requisicao_compra_itens i ON i.necessidade_id = n.id
     WHERE n.planejamento_id = $1 AND n.status = 'APROVADA' AND i.id IS NULL
     GROUP BY n.fornecedor_id`, [planejamentoId]);

  if (!rows.length) throw regraNegocio('Nenhuma necessidade aprovada e ainda nao requisitada neste planejamento');

  const criadas: unknown[] = [];
  for (const grupo of rows) {
    if (!grupo.fornecedor_id) continue; // sem fornecedor nao ha a quem cotar
    criadas.push(await criarRequisicao({
      necessidade_ids: grupo.ids,
      fornecedor_sugerido_id: grupo.fornecedor_id,
    } as z.output<typeof criarRequisicaoSchema>, contexto));
  }

  const semFornecedor = rows.find((g) => !g.fornecedor_id)?.ids.length ?? 0;
  return {
    requisicoes_criadas: criadas.length,
    necessidades_sem_fornecedor: semFornecedor,
    requisicoes: criadas,
  };
}
