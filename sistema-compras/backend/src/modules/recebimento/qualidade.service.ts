/**
 * Inspecao de qualidade, quarentena, nao conformidades e devolucao.
 *
 * A quarentena e o unico lugar do modulo que mexe em estoque antes da
 * aprovacao - e ainda assim nao cria saldo: ela move quantidade entre buckets
 * (quarentena -> disponivel, ou quarentena -> baixa), sempre com movimentacao
 * registrada, como manda a regra 6 da secao 58.
 */
import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio, semPermissao } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import { hojeLocal, paraDataCalendario } from '../../core/datas.js';
import type { z } from 'zod';
import type {
  acaoNcSchema, autorizarDevolucaoSchema, concluirAcaoNcSchema, decidirQuarentenaSchema,
  devolucaoSchema, inspecaoSchema, listarDevolucoesSchema, listarNcSchema, ncSchema,
  quarentenaSchema, tratarNcSchema,
} from './recebimento.schemas.js';
import {
  avaliarValidade, calcularAmostra, decidirDestino, resultadoChecklist,
} from './calculos.js';
import {
  ENCERRADOS, configuracoes, proximoNumero, registrarHistorico,
} from './recebimento.service.js';

type Cliente = { query: (t: string, v?: unknown[]) => Promise<{ rows: any[] }> };

const num = (v: unknown) => Number(v ?? 0);

// ---------------------------------------------------------------------------
// Inspecao de qualidade (secoes 17 a 21)
// ---------------------------------------------------------------------------

/**
 * Registra a inspecao de um item (ou do recebimento inteiro).
 *
 * O resultado nao e escolhido pelo inspetor: ele sai das respostas do
 * checklist. Criterio eliminatorio reprovado reprova o lote - a secao 18 trata
 * embalagem violada e infestacao como coisas que nao se compensam.
 */
export async function registrarInspecao(
  recebimentoId: number, entrada: z.output<typeof inspecaoSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM recebimentos WHERE id = $1 FOR UPDATE', [recebimentoId]);
    if (!rows.length) throw naoEncontrado('Recebimento');
    const r = rows[0];
    if (ENCERRADOS.includes(r.status)) {
      throw regraNegocio(`Recebimento em ${r.status} nao aceita nova inspecao`);
    }

    let item: any = null;
    if (entrada.recebimento_item_id) {
      const { rows: itens } = await cliente.query(`
        SELECT ri.*, p.codigo, p.descricao, p.checklist_qualidade_id,
               p.controla_lote, p.controla_validade, p.dias_validade,
               p.vida_util_minima_percentual
          FROM recebimento_itens ri JOIN produtos p ON p.id = ri.produto_id
         WHERE ri.id = $1 AND ri.recebimento_id = $2 FOR UPDATE OF ri`,
        [entrada.recebimento_item_id, recebimentoId]);
      if (!itens.length) throw regraNegocio('Item nao pertence a este recebimento');
      item = itens[0];
      if (item.conferido_em === null) {
        throw regraNegocio(
          `Item ${item.codigo} ainda nao foi conferido. A inspecao vem depois da conferencia`);
      }
    }

    // Checklist: o informado, o do produto, ou nenhum.
    let checklist: any = null;
    if (entrada.checklist_id || entrada.checklist_codigo || item?.checklist_qualidade_id) {
      const { rows: cl } = await cliente.query(`
        SELECT * FROM checklists_qualidade
         WHERE ativo AND (id = $1 OR codigo = $2 OR id = $3) LIMIT 1`,
        [entrada.checklist_id ?? null, entrada.checklist_codigo ?? null,
          item?.checklist_qualidade_id ?? null]);
      checklist = cl[0] ?? null;
    }

    const criterios = checklist
      ? (await cliente.query(
        'SELECT * FROM checklist_qualidade_itens WHERE checklist_id = $1 ORDER BY ordem',
        [checklist.id])).rows
      : [];
    const porCriterio = new Map(criterios.map((c) => [c.criterio, c]));

    const respostas = entrada.respostas.map((rp) => {
      const definicao = porCriterio.get(rp.criterio);
      return {
        criterio: rp.criterio,
        eliminatorio: definicao?.eliminatorio ?? false,
        resposta: rp.resposta,
        observacao: rp.observacao ?? null,
        checklist_item_id: definicao ? Number(definicao.id) : null,
      };
    });

    const veredito = resultadoChecklist(respostas);

    const tamanhoLote = num(item?.quantidade_recebida ?? r.quantidade_recebida);
    const amostra = calcularAmostra({
      tipo: entrada.tipo_amostragem ?? checklist?.tipo_amostragem ?? 'AMOSTRAGEM',
      tamanhoLote,
      percentual: checklist?.percentual_amostra !== undefined
        && checklist?.percentual_amostra !== null
        ? num(checklist.percentual_amostra) : null,
      amostrado: entrada.quantidade_amostrada ?? null,
    });

    // Quantidades: a reprovada e a em quarentena vem do inspetor; o resto do
    // lote e o que fica aprovado.
    const reprovada = entrada.quantidade_reprovada ?? (veredito.resultado === 'REPROVADO'
      ? tamanhoLote : 0);
    const quarentena = entrada.quantidade_quarentena ?? 0;
    const aprovada = entrada.quantidade_aprovada
      ?? Math.max(0, tamanhoLote - reprovada - quarentena);

    if (reprovada + quarentena > tamanhoLote + 1e-9) {
      throw regraNegocio(
        `Reprovado (${reprovada}) mais quarentena (${quarentena}) passa do recebido (${tamanhoLote})`);
    }

    // Quando o inspetor separa parte em quarentena, o resultado registrado
    // acompanha: aprovar tudo com parte retida seria uma contradicao.
    const resultado = quarentena > 0 && veredito.resultado === 'APROVADO'
      ? 'QUARENTENA' : veredito.resultado;

    const { rows: inspecao } = await cliente.query(`
      INSERT INTO inspecoes_qualidade
        (recebimento_id, recebimento_item_id, produto_id, fornecedor_id, lote_id,
         data_inspecao, responsavel_id, resultado, quantidade_avaliada, quantidade_aprovada,
         quantidade_reprovada, quantidade_quarentena, criterios, observacoes, restricao,
         checklist_id, tipo_amostragem, tamanho_lote, quantidade_amostrada, created_by)
      VALUES ($1,$2,$3,$4,$5,now(),$6,$7::resultado_inspecao_enum,$8,$9,$10,$11,$12::jsonb,
              $13,$14,$15,$16::tipo_amostragem_enum,$17,$18,$6)
      RETURNING *`,
      [recebimentoId, entrada.recebimento_item_id ?? null,
        item?.produto_id ?? null, r.fornecedor_id, item?.lote_id ?? null,
        contexto.usuarioId ?? null, resultado, amostra.quantidadeAmostrada || tamanhoLote,
        aprovada, reprovada, quarentena,
        JSON.stringify({
          checklist: checklist?.codigo ?? null,
          reprovados: veredito.reprovados,
          eliminatorios_reprovados: veredito.eliminatoriosReprovados,
          amostragem: amostra,
        }),
        entrada.observacoes ?? null, entrada.restricao ?? null,
        checklist?.id ?? null, entrada.tipo_amostragem ?? checklist?.tipo_amostragem ?? 'AMOSTRAGEM',
        tamanhoLote, amostra.quantidadeAmostrada]);

    for (const rp of respostas) {
      await cliente.query(`
        INSERT INTO inspecao_itens
          (inspecao_id, checklist_item_id, criterio, eliminatorio, resposta, observacao)
        VALUES ($1,$2,$3,$4,$5::resposta_checklist_enum,$6)
        ON CONFLICT (inspecao_id, criterio) DO UPDATE
          SET resposta = EXCLUDED.resposta, observacao = EXCLUDED.observacao`,
        [inspecao[0].id, rp.checklist_item_id, rp.criterio, rp.eliminatorio,
          rp.resposta, rp.observacao]);
    }

    // Reprovacao e quarentena viram divergencia e, quando graves, NC.
    if (['REPROVADO', 'QUARENTENA', 'APROVADO_COM_RESSALVA'].includes(resultado)) {
      await cliente.query(`
        INSERT INTO recebimento_divergencias
          (recebimento_id, recebimento_item_id, produto_id, tipo, severidade, descricao,
           valor_esperado, valor_recebido, detectada_por)
        VALUES ($1,$2,$3,'PRODUTO_CONTAMINADO'::tipo_divergencia_enum,
                $4::severidade_nc_enum,$5,'Conforme especificacao',$6,$7)`,
        [recebimentoId, entrada.recebimento_item_id ?? null, item?.produto_id ?? null,
          resultado === 'REPROVADO' ? 'CRITICA' : 'ALTA',
          `Inspecao de qualidade: ${resultado}`
          + (veredito.reprovados.length ? ` (${veredito.reprovados.join(', ')})` : ''),
          resultado, contexto.usuarioId ?? null]);
    }

    // Secao 36: lote reprovado abre nao conformidade sozinho. Quem reprova na
    // doca nao deveria precisar lembrar de abrir a NC depois.
    if (resultado === 'REPROVADO') {
      const numeroNc = await proximoNumero(
        cliente, 'nao_conformidades', 'recebimento.prefixo_nc', 'NC');
      await cliente.query(`
        INSERT INTO nao_conformidades
          (numero, produto_id, fornecedor_id, recebimento_id, recebimento_item_id,
           inspecao_id, tipo, severidade, descricao, quantidade_afetada, status,
           responsavel_id, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,'QUALIDADE'::tipo_nao_conformidade_enum,
                'CRITICA'::severidade_nc_enum,$7,$8,
                'ABERTA'::status_nao_conformidade_enum,$9,$9)`,
        [numeroNc, item?.produto_id ?? null, r.fornecedor_id, recebimentoId,
          entrada.recebimento_item_id ?? null, inspecao[0].id,
          `Lote reprovado na inspecao de qualidade`
          + (veredito.reprovados.length ? `: ${veredito.reprovados.join(', ')}` : ''),
          reprovada, contexto.usuarioId ?? null]);
    }

    if (entrada.recebimento_item_id && item) {
      // O destino previsto na conferencia foi calculado sem laudo. Com o
      // resultado em maos ele muda: reprovado vai para RECUSADO, retido vai
      // para QUARENTENA. A tela do conferente precisa ver isso na hora.
      const destino = decidirDestino({
        quantidadeRecebida: tamanhoLote,
        resultadoQualidade: resultado,
        quantidadeAprovadaQualidade: aprovada,
        quantidadeReprovadaQualidade: reprovada,
        quantidadeQuarentenaQualidade: quarentena,
        validade: avaliarValidade({
          controlaValidade: item.controla_validade,
          dataValidade: paraDataCalendario(item.data_validade),
          dataFabricacao: paraDataCalendario(item.data_fabricacao),
          diasValidadeProduto: item.dias_validade !== null ? Number(item.dias_validade) : null,
          minimoPercentual: item.vida_util_minima_percentual !== null
            ? Number(item.vida_util_minima_percentual) : null,
          limiares: { proximaPercentual: 90, criticaPercentual: 85 },
          hoje: hojeLocal(),
        }),
        exigeLote: item.controla_lote,
        loteInformado: Boolean(item.numero_lote),
        destinoPadrao: 'DISPONIVEL',
        excecaoValidadeAutorizada: false,
      }).destino;

      await cliente.query(`
        UPDATE recebimento_itens
           SET quantidade_aceita = $2, quantidade_rejeitada = $3, quantidade_quarentena = $4,
               destino = $5::destino_recebimento_enum, updated_at = now()
         WHERE id = $1`,
        [entrada.recebimento_item_id, aprovada, reprovada, quarentena, destino]);
    }

    await cliente.query(`
      UPDATE recebimentos
         SET status = CASE WHEN status IN ('EM_CONFERENCIA','CHEGOU')
                           THEN 'AGUARDANDO_QUALIDADE'::status_recebimento_enum ELSE status END,
             updated_at = now()
       WHERE id = $1`, [recebimentoId]);

    await registrarHistorico(cliente, r.ordem_compra_id, 'INSPECAO_QUALIDADE',
      contexto.usuarioId ?? null,
      `Inspecao ${resultado}${item ? ` do item ${item.codigo}` : ''}`,
      { resultado, reprovados: veredito.reprovados, amostra });

    return {
      ...inspecao[0],
      produto: item ? { codigo: item.codigo, descricao: item.descricao } : null,
      checklist: checklist?.codigo ?? null,
      veredito,
      amostragem: amostra,
      quantidades: { avaliada: tamanhoLote, aprovada, reprovada, quarentena },
    };
  });
}

export async function catalogoChecklists() {
  const { rows } = await query(`
    SELECT c.*, cat.nome AS categoria,
           (SELECT json_agg(json_build_object('id', i.id, 'ordem', i.ordem,
                    'criterio', i.criterio, 'descricao', i.descricao,
                    'eliminatorio', i.eliminatorio) ORDER BY i.ordem)
              FROM checklist_qualidade_itens i WHERE i.checklist_id = c.id) AS itens
      FROM checklists_qualidade c
      LEFT JOIN categorias cat ON cat.id = c.categoria_id
     WHERE c.ativo ORDER BY c.nome`);
  return rows;
}

// ---------------------------------------------------------------------------
// Quarentena (secao 20)
// ---------------------------------------------------------------------------

/**
 * Abre quarentena para parte de um item. A quantidade e marcada no item; o
 * saldo fisico so muda na aprovacao, quando a movimentacao credita o bucket
 * de quarentena em vez do disponivel.
 */
export async function abrirQuarentena(
  recebimentoId: number, entrada: z.output<typeof quarentenaSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(`
      SELECT ri.*, r.status AS status_recebimento, r.fornecedor_id, r.ordem_compra_id,
             r.numero AS recebimento_numero, r.local_id, p.codigo, p.descricao
        FROM recebimento_itens ri
        JOIN recebimentos r ON r.id = ri.recebimento_id
        JOIN produtos p ON p.id = ri.produto_id
       WHERE ri.id = $1 AND ri.recebimento_id = $2 FOR UPDATE OF ri`,
      [entrada.recebimento_item_id, recebimentoId]);
    if (!rows.length) throw naoEncontrado('Item do recebimento');
    const item = rows[0];

    // A quantidade em quarentena do item e a soma dos tickets abertos, nunca a
    // soma de tickets com o que a inspecao anotou: a inspecao registra a
    // intencao, o ticket formaliza. Somar os dois contaria o material duas
    // vezes e estouraria o saldo do pedido na aprovacao.
    const { rows: tickets } = await cliente.query<{ aberta: string }>(`
      SELECT coalesce(sum(quantidade - quantidade_liberada - quantidade_rejeitada), 0) AS aberta
        FROM quarentenas
       WHERE recebimento_item_id = $1 AND status = 'ABERTA'`,
      [entrada.recebimento_item_id]);
    const jaEmQuarentena = num(tickets[0]?.aberta);
    const recebida = num(item.quantidade_recebida);

    if (jaEmQuarentena + entrada.quantidade > recebida + 1e-9) {
      throw regraNegocio(
        `Quarentena de ${entrada.quantidade} passa do recebido (${recebida})`
        + (jaEmQuarentena > 0 ? `: ${jaEmQuarentena} ja esta retido` : ''));
    }

    const numero = await proximoNumero(
      cliente, 'quarentenas', 'recebimento.prefixo_quarentena', 'QUA');

    const { rows: criada } = await cliente.query(`
      INSERT INTO quarentenas
        (numero, recebimento_id, recebimento_item_id, produto_id, lote_id, local_id,
         fornecedor_id, quantidade, motivo, aberta_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [numero, recebimentoId, entrada.recebimento_item_id, item.produto_id,
        item.lote_id, item.local_id, item.fornecedor_id, entrada.quantidade,
        entrada.motivo, contexto.usuarioId ?? null]);

    await cliente.query(`
      UPDATE recebimento_itens
         SET quantidade_quarentena = $2::numeric,
             quantidade_aceita = greatest(quantidade_recebida - $2::numeric
                                          - quantidade_rejeitada, 0),
             status = 'EM_QUARENTENA'::status_recebimento_item_enum,
             updated_at = now()
       WHERE id = $1`,
      [entrada.recebimento_item_id, jaEmQuarentena + entrada.quantidade]);

    await cliente.query(`
      INSERT INTO alertas (tipo, severidade, produto_id, fornecedor_id, ordem_compra_id, mensagem, detalhes)
      VALUES ('QUARENTENA_ABERTA'::tipo_alerta_enum, 'ALTA'::severidade_enum, $1, $2, $3, $4, $5::jsonb)`,
      [item.produto_id, item.fornecedor_id, item.ordem_compra_id,
        `${item.codigo}: ${entrada.quantidade} em quarentena (${numero})`,
        JSON.stringify({ quarentena: numero, motivo: entrada.motivo })]);

    await registrarHistorico(cliente, item.ordem_compra_id, 'QUARENTENA_ABERTA',
      contexto.usuarioId ?? null,
      `${entrada.quantidade} de ${item.codigo} em quarentena: ${entrada.motivo}`,
      { quarentena: numero });

    return { ...criada[0], produto: { codigo: item.codigo, descricao: item.descricao } };
  });
}

/**
 * Libera, rejeita ou devolve o que estava em quarentena.
 *
 * Liberar move a quantidade de quarentena para disponivel, com movimentacao
 * propria. Rejeitar baixa a quantidade: ela nao volta a existir como saldo.
 */
export async function decidirQuarentena(
  quarentenaId: number, entrada: z.output<typeof decidirQuarentenaSchema>,
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(`
      SELECT q.*, p.codigo, p.descricao, r.ordem_compra_id, r.numero AS recebimento_numero
        FROM quarentenas q
        JOIN produtos p ON p.id = q.produto_id
        LEFT JOIN recebimentos r ON r.id = q.recebimento_id
       WHERE q.id = $1 FOR UPDATE OF q`, [quarentenaId]);
    if (!rows.length) throw naoEncontrado('Quarentena');
    const q = rows[0];

    if (q.status !== 'ABERTA') {
      throw regraNegocio(`Quarentena ${q.numero} ja esta ${q.status}`);
    }

    const pendente = num(q.quantidade) - num(q.quantidade_liberada) - num(q.quantidade_rejeitada);
    const quantidade = entrada.quantidade ?? pendente;
    if (quantidade > pendente + 1e-9) {
      throw regraNegocio(`Quantidade de ${quantidade} passa do saldo em quarentena (${pendente})`);
    }

    const liberando = entrada.decisao === 'LIBERAR';
    const restante = pendente - quantidade;

    // O saldo fisico so existe se o recebimento ja foi aprovado; antes disso a
    // quarentena e apenas uma marcacao no item.
    const { rows: estoque } = await cliente.query(
      'SELECT * FROM estoques WHERE produto_id = $1 AND local_id = $2 FOR UPDATE',
      [q.produto_id, q.local_id]);

    if (estoque.length && num(estoque[0].quantidade_quarentena) > 0) {
      const mover = Math.min(quantidade, num(estoque[0].quantidade_quarentena));
      if (liberando) {
        // Liberar nao traz mercadoria nova: ela ja esta no deposito, apenas sai
        // do balde de quarentena e passa a contar como disponivel. Registrar
        // uma movimentacao de entrada aqui criaria saldo do nada - o rastro da
        // liberacao fica na propria quarentena e na auditoria.
        await cliente.query(`
          UPDATE estoques SET quantidade_quarentena = quantidade_quarentena - $2, updated_at = now()
           WHERE id = $1`, [estoque[0].id, mover]);
        if (q.lote_id) {
          await cliente.query(
            "UPDATE lotes SET status = 'DISPONIVEL'::status_lote_enum WHERE id = $1", [q.lote_id]);
        }
      } else {
        // Rejeitada: sai da quarentena e sai do fisico, sem passar por
        // disponivel. O balde e deste modulo; o saldo fisico (e o do lote) e
        // baixado pelo gatilho a partir da movimentacao de PERDA abaixo.
        await cliente.query(`
          UPDATE estoques
             SET quantidade_quarentena = quantidade_quarentena - $2, updated_at = now()
           WHERE id = $1`, [estoque[0].id, mover]);
        await cliente.query(`
          INSERT INTO movimentacoes_estoque
            (produto_id, local_id, lote_id, tipo_movimentacao, quantidade, documento_tipo,
             documento_id, observacao, usuario_id)
          VALUES ($1,$2,$3,'PERDA'::tipo_movimentacao_enum,$4,
                  'QUARENTENA'::documento_movimentacao_enum,$5,$6,$7)`,
          [q.produto_id, q.local_id, q.lote_id, mover, quarentenaId,
            `Quarentena ${q.numero} ${entrada.decisao}: ${entrada.justificativa}`,
            contexto.usuarioId ?? null]);
        if (q.lote_id) {
          await cliente.query(
            "UPDATE lotes SET status = 'BLOQUEADO'::status_lote_enum WHERE id = $1",
            [q.lote_id]);
        }
      }
    }

    const { rows: atualizada } = await cliente.query(`
      UPDATE quarentenas
         SET quantidade_liberada = quantidade_liberada + $2,
             quantidade_rejeitada = quantidade_rejeitada + $3,
             status = CASE WHEN $4 <= 0 THEN $5::status_quarentena_enum ELSE status END,
             decidida_em = now(), decidida_por = $6,
             justificativa = $7, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [quarentenaId, liberando ? quantidade : 0, liberando ? 0 : quantidade,
        restante, liberando ? 'LIBERADA' : entrada.decisao === 'DEVOLVER' ? 'DEVOLVIDA' : 'REJEITADA',
        contexto.usuarioId ?? null, entrada.justificativa]);

    if (q.recebimento_item_id) {
      await cliente.query(`
        UPDATE recebimento_itens
           SET quantidade_quarentena = greatest(quantidade_quarentena - $2, 0),
               quantidade_aceita = quantidade_aceita + $3,
               quantidade_rejeitada = quantidade_rejeitada + $4,
               updated_at = now()
         WHERE id = $1`,
        [q.recebimento_item_id, quantidade, liberando ? quantidade : 0,
          liberando ? 0 : quantidade]);
    }

    await registrarHistorico(cliente, q.ordem_compra_id, 'QUARENTENA_DECIDIDA',
      contexto.usuarioId ?? null,
      `Quarentena ${q.numero}: ${entrada.decisao} de ${quantidade} de ${q.codigo}`,
      { decisao: entrada.decisao, quantidade, justificativa: entrada.justificativa });

    return {
      ...atualizada[0],
      produto: { codigo: q.codigo, descricao: q.descricao },
      quantidade_movimentada: quantidade,
      saldo_em_quarentena: restante,
    };
  });
}

export async function listarQuarentenas(filtro: { status?: string } & Paginacao) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  if (filtro.status) { valores.push(filtro.status); cond.push(`q.status = $${valores.length}::status_quarentena_enum`); }
  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM quarentenas q ${onde}`, valores);

  const { rows } = await query(`
    SELECT q.*, p.codigo, p.descricao AS produto, f.razao_social AS fornecedor,
           r.numero AS recebimento, l.nome AS local, u.nome AS aberta_por_nome,
           q.quantidade - q.quantidade_liberada - q.quantidade_rejeitada AS saldo
      FROM quarentenas q
      JOIN produtos p ON p.id = q.produto_id
      LEFT JOIN fornecedores f ON f.id = q.fornecedor_id
      LEFT JOIN recebimentos r ON r.id = q.recebimento_id
      LEFT JOIN locais l ON l.id = q.local_id
      LEFT JOIN usuarios u ON u.id = q.aberta_por
      ${onde}
     ORDER BY q.aberta_em DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return { dados: rows, meta: metaPaginacao(Number(total.rows[0]?.total ?? 0), filtro) };
}

// ---------------------------------------------------------------------------
// Nao conformidades (secoes 22 a 25)
// ---------------------------------------------------------------------------

const FLUXO_NC: Record<string, string[]> = {
  ABERTA: ['EM_ANALISE', 'ACAO_DEFINIDA', 'CANCELADA'],
  EM_ANALISE: ['ACAO_DEFINIDA', 'AGUARDANDO_FORNECEDOR', 'EM_TRATATIVA', 'CANCELADA'],
  ACAO_DEFINIDA: ['AGUARDANDO_FORNECEDOR', 'EM_TRATATIVA', 'RESOLVIDA', 'CANCELADA'],
  AGUARDANDO_FORNECEDOR: ['EM_TRATATIVA', 'RESOLVIDA', 'CANCELADA'],
  EM_TRATATIVA: ['RESOLVIDA', 'AGUARDANDO_FORNECEDOR', 'CANCELADA'],
  RESOLVIDA: ['VALIDADA', 'EM_TRATATIVA'],
  VALIDADA: ['ENCERRADA'],
  ENCERRADA: [],
  CANCELADA: [],
};

export async function abrirNaoConformidade(
  entrada: z.output<typeof ncSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    let fornecedorId = entrada.fornecedor_id ?? null;
    let produtoId = entrada.produto_id ?? null;
    let pedidoId: number | null = null;

    if (entrada.recebimento_id) {
      const { rows } = await cliente.query(
        'SELECT fornecedor_id, ordem_compra_id, numero FROM recebimentos WHERE id = $1',
        [entrada.recebimento_id]);
      if (!rows.length) throw naoEncontrado('Recebimento');
      fornecedorId = fornecedorId ?? Number(rows[0].fornecedor_id);
      pedidoId = rows[0].ordem_compra_id !== null ? Number(rows[0].ordem_compra_id) : null;
    }
    if (entrada.recebimento_item_id && !produtoId) {
      const { rows } = await cliente.query(
        'SELECT produto_id FROM recebimento_itens WHERE id = $1', [entrada.recebimento_item_id]);
      produtoId = rows.length ? Number(rows[0].produto_id) : null;
    }

    const numero = await proximoNumero(
      cliente, 'nao_conformidades', 'recebimento.prefixo_nc', 'NC');

    const { rows: criada } = await cliente.query(`
      INSERT INTO nao_conformidades
        (numero, produto_id, fornecedor_id, lote_id, recebimento_id, recebimento_item_id,
         inspecao_id, divergencia_id, tipo, severidade, descricao, quantidade_afetada,
         valor_impacto, causa, prazo, status, responsavel_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::tipo_nao_conformidade_enum,$10::severidade_nc_enum,
              $11,$12,$13,$14,$15::date,'ABERTA'::status_nao_conformidade_enum,$16,$17)
      RETURNING *`,
      [numero, produtoId, fornecedorId, entrada.lote_id ?? null, entrada.recebimento_id ?? null,
        entrada.recebimento_item_id ?? null, entrada.inspecao_id ?? null,
        entrada.divergencia_id ?? null, entrada.tipo, entrada.severidade, entrada.descricao,
        entrada.quantidade_afetada ?? null, entrada.valor_impacto ?? null,
        entrada.causa ?? null, entrada.prazo ?? null,
        entrada.responsavel_id ?? contexto.usuarioId ?? null, contexto.usuarioId ?? null]);

    if (entrada.divergencia_id) {
      await cliente.query(
        'UPDATE recebimento_divergencias SET nao_conformidade_id = $2 WHERE id = $1',
        [entrada.divergencia_id, criada[0].id]);
    }

    if (entrada.severidade === 'CRITICA') {
      await cliente.query(`
        INSERT INTO alertas (tipo, severidade, produto_id, fornecedor_id, mensagem, detalhes)
        VALUES ('NC_CRITICA'::tipo_alerta_enum, 'CRITICA'::severidade_enum, $1, $2, $3, $4::jsonb)`,
        [produtoId, fornecedorId, `Nao conformidade critica ${numero}: ${entrada.descricao}`,
          JSON.stringify({ numero, tipo: entrada.tipo })]);
    }

    await registrarHistorico(cliente, pedidoId, 'NAO_CONFORMIDADE',
      contexto.usuarioId ?? null, `NC ${numero} (${entrada.severidade}): ${entrada.tipo}`,
      { numero, tipo: entrada.tipo, severidade: entrada.severidade });

    return criada[0];
  });
}

export async function tratarNaoConformidade(
  ncId: number, entrada: z.output<typeof tratarNcSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM nao_conformidades WHERE id = $1 FOR UPDATE', [ncId]);
    if (!rows.length) throw naoEncontrado('Nao conformidade');
    const nc = rows[0];

    const permitidos = FLUXO_NC[nc.status] ?? [];
    if (!permitidos.includes(entrada.status)) {
      throw regraNegocio(
        `Nao conformidade em ${nc.status} nao pode ir para ${entrada.status}. `
        + `Possiveis - ${permitidos.join(', ') || 'nenhuma'}`);
    }

    // Encerrar exige que as acoes do plano tenham sido concluidas.
    if (['RESOLVIDA', 'VALIDADA', 'ENCERRADA'].includes(entrada.status)) {
      const { rows: abertas } = await cliente.query(`
        SELECT count(*)::int AS n FROM nao_conformidade_acoes
         WHERE nao_conformidade_id = $1 AND status IN ('PENDENTE','EM_ANDAMENTO')`, [ncId]);
      if (Number(abertas[0].n) > 0) {
        throw regraNegocio(
          `Nao e possivel ${entrada.status.toLowerCase()} a NC: ${abertas[0].n} acao(oes) `
          + 'do plano ainda em aberto');
      }
    }

    const { rows: atualizada } = await cliente.query(`
      UPDATE nao_conformidades
         SET status = $2::status_nao_conformidade_enum,
             acao = coalesce($3::acao_nao_conformidade_enum, acao),
             causa = coalesce($4, causa),
             responsavel_id = coalesce($5, responsavel_id),
             data_resolucao = CASE WHEN $2 = 'RESOLVIDA' THEN now() ELSE data_resolucao END,
             validado_por = CASE WHEN $2 = 'VALIDADA' THEN $6 ELSE validado_por END,
             validado_em = CASE WHEN $2 = 'VALIDADA' THEN now() ELSE validado_em END,
             encerrado_em = CASE WHEN $2 = 'ENCERRADA' THEN now() ELSE encerrado_em END,
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [ncId, entrada.status, entrada.acao ?? null, entrada.causa ?? null,
        entrada.responsavel_id ?? null, contexto.usuarioId ?? null]);

    return { ...atualizada[0], status_anterior: nc.status };
  });
}

export async function registrarAcaoNc(
  ncId: number, entrada: z.output<typeof acaoNcSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT id, status FROM nao_conformidades WHERE id = $1', [ncId]);
    if (!rows.length) throw naoEncontrado('Nao conformidade');
    if (['ENCERRADA', 'CANCELADA'].includes(rows[0].status)) {
      throw regraNegocio(`Nao conformidade ${rows[0].status} nao aceita nova acao`);
    }

    const { rows: criada } = await cliente.query(`
      INSERT INTO nao_conformidade_acoes
        (nao_conformidade_id, tipo, descricao, responsavel_id, prazo, evidencia, created_by)
      VALUES ($1,$2,$3,$4,$5::date,$6,$7) RETURNING *`,
      [ncId, entrada.tipo, entrada.descricao,
        entrada.responsavel_id ?? contexto.usuarioId ?? null, entrada.prazo ?? null,
        entrada.evidencia ?? null, contexto.usuarioId ?? null]);

    return criada[0];
  });
}

export async function concluirAcaoNc(
  acaoId: number, entrada: z.output<typeof concluirAcaoNcSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM nao_conformidade_acoes WHERE id = $1 FOR UPDATE', [acaoId]);
    if (!rows.length) throw naoEncontrado('Acao');
    if (['CONCLUIDA', 'CANCELADA'].includes(rows[0].status)) {
      throw regraNegocio(`Acao ja esta ${rows[0].status}`);
    }

    const { rows: atualizada } = await cliente.query(`
      UPDATE nao_conformidade_acoes
         SET status = $2, resultado = coalesce($3, resultado),
             concluida_em = CASE WHEN $2 IN ('CONCLUIDA','CANCELADA') THEN now() ELSE concluida_em END,
             updated_at = now()
       WHERE id = $1 RETURNING *`, [acaoId, entrada.status, entrada.resultado ?? null]);

    return atualizada[0];
  });
}

export async function listarNaoConformidades(
  filtro: z.output<typeof listarNcSchema> & Paginacao,
) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const filtrar = (sql: string, valor: unknown) => {
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  if (filtro.recebimento_id) filtrar('nc.recebimento_id = $?', filtro.recebimento_id);
  if (filtro.fornecedor_id) filtrar('nc.fornecedor_id = $?', filtro.fornecedor_id);
  if (filtro.produto_id) filtrar('nc.produto_id = $?', filtro.produto_id);
  if (filtro.tipo) filtrar('nc.tipo = $?::tipo_nao_conformidade_enum', filtro.tipo);
  if (filtro.severidade) filtrar('nc.severidade = $?::severidade_nc_enum', filtro.severidade);
  if (filtro.status) filtrar('nc.status = $?::status_nao_conformidade_enum', filtro.status);
  if (filtro.data_inicio) filtrar('nc.created_at >= $?::date', filtro.data_inicio);
  if (filtro.data_fim) filtrar("nc.created_at < ($?::date + interval '1 day')", filtro.data_fim);
  if (filtro.apenas_abertas) cond.push("nc.status NOT IN ('ENCERRADA','CANCELADA')");
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(nc.numero ILIKE $${valores.length} OR nc.descricao ILIKE $${valores.length})`);
  }

  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM nao_conformidades nc ${onde}`, valores);

  const { rows } = await query(`
    SELECT nc.*, p.codigo, p.descricao AS produto, f.razao_social AS fornecedor,
           r.numero AS recebimento, u.nome AS responsavel,
           (SELECT count(*)::int FROM nao_conformidade_acoes a
             WHERE a.nao_conformidade_id = nc.id) AS acoes,
           (SELECT count(*)::int FROM nao_conformidade_acoes a
             WHERE a.nao_conformidade_id = nc.id AND a.status IN ('PENDENTE','EM_ANDAMENTO'))
             AS acoes_pendentes,
           CASE WHEN nc.encerrado_em IS NOT NULL
                THEN EXTRACT(epoch FROM (nc.encerrado_em - nc.created_at)) / 86400 END
             AS dias_resolucao
      FROM nao_conformidades nc
      LEFT JOIN produtos p ON p.id = nc.produto_id
      LEFT JOIN fornecedores f ON f.id = nc.fornecedor_id
      LEFT JOIN recebimentos r ON r.id = nc.recebimento_id
      LEFT JOIN usuarios u ON u.id = nc.responsavel_id
      ${onde}
     ORDER BY nc.created_at DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return { dados: rows, meta: metaPaginacao(Number(total.rows[0]?.total ?? 0), filtro) };
}

export async function detalharNaoConformidade(ncId: number) {
  const { rows } = await query(`
    SELECT nc.*, p.codigo, p.descricao AS produto, f.razao_social AS fornecedor,
           r.numero AS recebimento, u.nome AS responsavel, v.nome AS validado_por_nome,
           l.numero_lote
      FROM nao_conformidades nc
      LEFT JOIN produtos p ON p.id = nc.produto_id
      LEFT JOIN fornecedores f ON f.id = nc.fornecedor_id
      LEFT JOIN recebimentos r ON r.id = nc.recebimento_id
      LEFT JOIN usuarios u ON u.id = nc.responsavel_id
      LEFT JOIN usuarios v ON v.id = nc.validado_por
      LEFT JOIN lotes l ON l.id = nc.lote_id
     WHERE nc.id = $1`, [ncId]);
  if (!rows.length) throw naoEncontrado('Nao conformidade');

  const [acoes, anexos] = await Promise.all([
    query(`
      SELECT a.*, u.nome AS responsavel FROM nao_conformidade_acoes a
      LEFT JOIN usuarios u ON u.id = a.responsavel_id
       WHERE a.nao_conformidade_id = $1 ORDER BY a.created_at`, [ncId]),
    query('SELECT * FROM recebimento_anexos WHERE nao_conformidade_id = $1 ORDER BY created_at',
      [ncId]),
  ]);

  const detalhe: Record<string, any> = {
    ...rows[0], acoes: acoes.rows, anexos: anexos.rows, fluxo: FLUXO_NC[rows[0].status] ?? [],
  };
  return detalhe;
}

// ---------------------------------------------------------------------------
// Devolucao (secao 29)
// ---------------------------------------------------------------------------

export async function criarDevolucao(
  entrada: z.output<typeof devolucaoSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    let fornecedorId = entrada.fornecedor_id ?? null;
    let pedidoId = entrada.ordem_compra_id ?? null;

    if (entrada.recebimento_id) {
      const { rows } = await cliente.query(
        'SELECT fornecedor_id, ordem_compra_id FROM recebimentos WHERE id = $1',
        [entrada.recebimento_id]);
      if (!rows.length) throw naoEncontrado('Recebimento');
      fornecedorId = fornecedorId ?? Number(rows[0].fornecedor_id);
      pedidoId = pedidoId ?? (rows[0].ordem_compra_id !== null
        ? Number(rows[0].ordem_compra_id) : null);
    }

    const numero = await proximoNumero(
      cliente, 'devolucoes', 'recebimento.prefixo_devolucao', 'DEV');

    const { rows: criada } = await cliente.query(`
      INSERT INTO devolucoes
        (numero, recebimento_id, ordem_compra_id, fornecedor_id, motivo, descricao,
         numero_nota_fiscal, transportadora, data_devolucao, status, created_by)
      VALUES ($1,$2,$3,$4,$5::motivo_devolucao_enum,$6,$7,$8,$9::date,
              'RASCUNHO'::status_devolucao_enum,$10)
      RETURNING *`,
      [numero, entrada.recebimento_id ?? null, pedidoId, fornecedorId, entrada.motivo,
        entrada.descricao ?? null, entrada.numero_nota_fiscal ?? null,
        entrada.transportadora ?? null, entrada.data_devolucao ?? null,
        contexto.usuarioId ?? null]);

    let quantidadeTotal = 0;
    let valorTotal = 0;

    for (const i of entrada.itens) {
      let preco = i.preco_unitario ?? 0;
      if (i.recebimento_item_id) {
        const { rows: item } = await cliente.query(
          'SELECT preco_unitario, quantidade_recebida, quantidade_devolvida FROM recebimento_itens WHERE id = $1',
          [i.recebimento_item_id]);
        if (!item.length) throw regraNegocio('Item do recebimento nao encontrado');
        preco = i.preco_unitario ?? num(item[0].preco_unitario);

        const devolvida = num(item[0].quantidade_devolvida) + i.quantidade;
        if (devolvida > num(item[0].quantidade_recebida) + 1e-9) {
          throw regraNegocio(
            `Devolucao de ${i.quantidade} passa do recebido (${num(item[0].quantidade_recebida)})`);
        }
        await cliente.query(
          'UPDATE recebimento_itens SET quantidade_devolvida = $2, updated_at = now() WHERE id = $1',
          [i.recebimento_item_id, devolvida]);
      }

      const valor = i.quantidade * preco;
      quantidadeTotal += i.quantidade;
      valorTotal += valor;

      await cliente.query(`
        INSERT INTO devolucao_itens
          (devolucao_id, recebimento_item_id, produto_id, lote_id, quantidade,
           preco_unitario, valor_total, observacao)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [criada[0].id, i.recebimento_item_id ?? null, i.produto_id, i.lote_id ?? null,
          i.quantidade, preco, valor, i.observacao ?? null]);
    }

    const { rows: atualizada } = await cliente.query(`
      UPDATE devolucoes SET quantidade_total = $2, valor_total = $3, updated_at = now()
       WHERE id = $1 RETURNING *`, [criada[0].id, quantidadeTotal, valorTotal]);

    await cliente.query(`
      INSERT INTO alertas (tipo, severidade, fornecedor_id, ordem_compra_id, mensagem, detalhes)
      VALUES ('DEVOLUCAO_PENDENTE'::tipo_alerta_enum, 'ALTA'::severidade_enum, $1, $2, $3, $4::jsonb)`,
      [fornecedorId, pedidoId, `Devolucao ${numero} aguardando autorizacao`,
        JSON.stringify({ numero, motivo: entrada.motivo, quantidade: quantidadeTotal })]);

    await registrarHistorico(cliente, pedidoId, 'DEVOLUCAO_CRIADA',
      contexto.usuarioId ?? null,
      `Devolucao ${numero}: ${quantidadeTotal} por ${entrada.motivo}`,
      { numero, motivo: entrada.motivo, itens: entrada.itens.length });

    return { ...atualizada[0], itens: entrada.itens.length };
  });
}

/**
 * Autoriza a devolucao e baixa o estoque devolvido.
 *
 * Baixar aqui, e nao na criacao, e o que faz a autorizacao valer: a secao 44
 * exige aprovacao para devolucao, e antes dela a mercadoria continua nossa.
 */
export async function autorizarDevolucao(
  devolucaoId: number, entrada: z.output<typeof autorizarDevolucaoSchema>,
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM devolucoes WHERE id = $1 FOR UPDATE', [devolucaoId]);
    if (!rows.length) throw naoEncontrado('Devolucao');
    const d = rows[0];
    if (d.status !== 'RASCUNHO') {
      throw regraNegocio(`Devolucao ${d.numero} ja esta ${d.status}`);
    }

    const { rows: itens } = await cliente.query(`
      SELECT di.*, ri.local_id, r.local_id AS local_recebimento
        FROM devolucao_itens di
        LEFT JOIN recebimento_itens ri ON ri.id = di.recebimento_item_id
        LEFT JOIN recebimentos r ON r.id = $2
       WHERE di.devolucao_id = $1`, [devolucaoId, d.recebimento_id]);

    for (const i of itens) {
      const localId = i.local_id ?? i.local_recebimento;
      if (!localId) continue;

      const { rows: estoque } = await cliente.query(
        'SELECT * FROM estoques WHERE produto_id = $1 AND local_id = $2 FOR UPDATE',
        [i.produto_id, localId]);
      if (!estoque.length || num(estoque[0].quantidade_fisica) < num(i.quantidade)) continue;

      // A baixa do saldo fisico (e da quantidade do lote) e feita pelo gatilho
      // fn_aplicar_movimentacao_estoque a partir da movimentacao abaixo. Baixar
      // aqui tambem tiraria a mercadoria duas vezes do estoque.
      await cliente.query(`
        INSERT INTO movimentacoes_estoque
          (produto_id, local_id, lote_id, tipo_movimentacao, quantidade, custo_unitario,
           documento_tipo, documento_id, observacao, usuario_id)
        VALUES ($1,$2,$3,'DEVOLUCAO_FORNECEDOR'::tipo_movimentacao_enum,$4,$5,
                'DEVOLUCAO'::documento_movimentacao_enum,$6,$7,$8)`,
        [i.produto_id, localId, i.lote_id, i.quantidade, i.preco_unitario, devolucaoId,
          `Devolucao ${d.numero} ao fornecedor: ${d.motivo}`, contexto.usuarioId ?? null]);

    }

    const { rows: atualizada } = await cliente.query(`
      UPDATE devolucoes
         SET status = 'AUTORIZADA'::status_devolucao_enum,
             autorizado_por = $2, autorizado_em = now(), justificativa = $3, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [devolucaoId, contexto.usuarioId ?? null, entrada.justificativa]);

    await registrarHistorico(cliente, d.ordem_compra_id, 'DEVOLUCAO_AUTORIZADA',
      contexto.usuarioId ?? null, `Devolucao ${d.numero} autorizada`,
      { justificativa: entrada.justificativa });

    return { ...atualizada[0], itens_baixados: itens.length };
  });
}

export async function listarDevolucoes(
  filtro: z.output<typeof listarDevolucoesSchema> & Paginacao,
) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const filtrar = (sql: string, valor: unknown) => {
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };
  if (filtro.fornecedor_id) filtrar('d.fornecedor_id = $?', filtro.fornecedor_id);
  if (filtro.status) filtrar('d.status = $?::status_devolucao_enum', filtro.status);
  if (filtro.motivo) filtrar('d.motivo = $?::motivo_devolucao_enum', filtro.motivo);
  if (filtro.data_inicio) filtrar('d.created_at >= $?::date', filtro.data_inicio);
  if (filtro.data_fim) filtrar("d.created_at < ($?::date + interval '1 day')", filtro.data_fim);
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(d.numero ILIKE $${valores.length} OR f.razao_social ILIKE $${valores.length})`);
  }

  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = await query<{ total: number }>(`
    SELECT count(*)::int AS total FROM devolucoes d
    JOIN fornecedores f ON f.id = d.fornecedor_id ${onde}`, valores);

  const { rows } = await query(`
    SELECT d.*, f.razao_social AS fornecedor, r.numero AS recebimento,
           oc.numero AS pedido, u.nome AS autorizado_por_nome,
           (SELECT count(*)::int FROM devolucao_itens i WHERE i.devolucao_id = d.id) AS itens
      FROM devolucoes d
      JOIN fornecedores f ON f.id = d.fornecedor_id
      LEFT JOIN recebimentos r ON r.id = d.recebimento_id
      LEFT JOIN ordens_compra oc ON oc.id = d.ordem_compra_id
      LEFT JOIN usuarios u ON u.id = d.autorizado_por
      ${onde}
     ORDER BY d.created_at DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return { dados: rows, meta: metaPaginacao(Number(total.rows[0]?.total ?? 0), filtro) };
}

export async function detalharDevolucao(devolucaoId: number) {
  const { rows } = await query(`
    SELECT d.*, f.razao_social AS fornecedor, f.cnpj, r.numero AS recebimento,
           oc.numero AS pedido, u.nome AS autorizado_por_nome, c.nome AS criado_por
      FROM devolucoes d
      JOIN fornecedores f ON f.id = d.fornecedor_id
      LEFT JOIN recebimentos r ON r.id = d.recebimento_id
      LEFT JOIN ordens_compra oc ON oc.id = d.ordem_compra_id
      LEFT JOIN usuarios u ON u.id = d.autorizado_por
      LEFT JOIN usuarios c ON c.id = d.created_by
     WHERE d.id = $1`, [devolucaoId]);
  if (!rows.length) throw naoEncontrado('Devolucao');

  const itens = await query(`
    SELECT di.*, p.codigo, p.descricao, l.numero_lote, un.codigo AS unidade
      FROM devolucao_itens di
      JOIN produtos p ON p.id = di.produto_id
      LEFT JOIN lotes l ON l.id = di.lote_id
      LEFT JOIN unidades un ON un.id = p.unidade_compra_id
     WHERE di.devolucao_id = $1 ORDER BY p.descricao`, [devolucaoId]);

  const detalhe: Record<string, any> = { ...rows[0], itens: itens.rows };
  return detalhe;
}

// ---------------------------------------------------------------------------
// Painel de qualidade do recebimento (secao 49)
// ---------------------------------------------------------------------------

/**
 * Consolida, para um recebimento, tudo que a qualidade produziu: inspecoes,
 * quarentenas, nao conformidades e devolucoes. E a tela que decide se o
 * material pode ser liberado.
 */
export async function qualidadeDoRecebimento(recebimentoId: number) {
  const { rows: cab } = await query(
    'SELECT id, numero, status FROM recebimentos WHERE id = $1', [recebimentoId]);
  if (!cab.length) throw naoEncontrado('Recebimento');

  const [inspecoes, quarentenas, ncs, devolucoes, itens] = await Promise.all([
    query(`
      SELECT i.*, p.codigo AS produto_codigo, p.descricao AS produto, c.nome AS checklist,
             u.nome AS responsavel,
             (SELECT count(*)::int FROM inspecao_itens ii
               WHERE ii.inspecao_id = i.id AND ii.resposta = 'REPROVADO') AS criterios_reprovados
        FROM inspecoes_qualidade i
        JOIN produtos p ON p.id = i.produto_id
        LEFT JOIN checklists_qualidade c ON c.id = i.checklist_id
        LEFT JOIN usuarios u ON u.id = i.responsavel_id
       WHERE i.recebimento_id = $1
       ORDER BY i.data_inspecao DESC, i.id DESC`, [recebimentoId]),
    query(`
      SELECT q.*, p.codigo AS produto_codigo, p.descricao AS produto, l.numero_lote AS lote,
             ua.nome AS aberta_por_nome, ud.nome AS decidida_por_nome
        FROM quarentenas q
        JOIN produtos p ON p.id = q.produto_id
        LEFT JOIN lotes l ON l.id = q.lote_id
        LEFT JOIN usuarios ua ON ua.id = q.aberta_por
        LEFT JOIN usuarios ud ON ud.id = q.decidida_por
       WHERE q.recebimento_id = $1
       ORDER BY q.aberta_em DESC`, [recebimentoId]),
    query(`
      SELECT n.*, p.descricao AS produto, u.nome AS responsavel,
             (SELECT count(*)::int FROM nao_conformidade_acoes a
               WHERE a.nao_conformidade_id = n.id AND a.concluida_em IS NULL) AS acoes_abertas
        FROM nao_conformidades n
        LEFT JOIN produtos p ON p.id = n.produto_id
        LEFT JOIN usuarios u ON u.id = n.responsavel_id
       WHERE n.recebimento_id = $1
       ORDER BY n.created_at DESC`, [recebimentoId]),
    query(`
      SELECT d.*, f.razao_social AS fornecedor
        FROM devolucoes d
        JOIN fornecedores f ON f.id = d.fornecedor_id
       WHERE d.recebimento_id = $1
       ORDER BY d.created_at DESC`, [recebimentoId]),
    query(`
      SELECT ri.id, ri.produto_id, p.descricao AS produto, ri.status, ri.situacao_validade,
             ri.destino, ri.quantidade_conferida, ri.quantidade_aceita,
             ri.quantidade_rejeitada, ri.quantidade_quarentena, p.exige_inspecao,
             EXISTS (SELECT 1 FROM inspecoes_qualidade i
                      WHERE i.recebimento_item_id = ri.id) AS inspecionado
        FROM recebimento_itens ri
        JOIN produtos p ON p.id = ri.produto_id
       WHERE ri.recebimento_id = $1
       ORDER BY p.descricao`, [recebimentoId]),
  ]);

  const pendentes = itens.rows.filter(
    (i: Record<string, any>) => i.exige_inspecao && !i.inspecionado);

  return {
    recebimento: cab[0],
    resumo: {
      inspecoes: inspecoes.rows.length,
      reprovadas: inspecoes.rows.filter(
        (i: Record<string, any>) => i.resultado === 'REPROVADO').length,
      quarentenas_abertas: quarentenas.rows.filter(
        (q: Record<string, any>) => q.status === 'ABERTA').length,
      nao_conformidades_abertas: ncs.rows.filter(
        (n: Record<string, any>) => !['VALIDADA', 'ENCERRADA', 'RESOLVIDA'].includes(n.status)).length,
      devolucoes: devolucoes.rows.length,
      inspecoes_pendentes: pendentes.length,
    },
    itens: itens.rows,
    inspecoes_pendentes: pendentes,
    inspecoes: inspecoes.rows,
    quarentenas: quarentenas.rows,
    nao_conformidades: ncs.rows,
    devolucoes: devolucoes.rows,
  };
}
