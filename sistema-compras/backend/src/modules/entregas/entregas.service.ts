/**
 * Escrita do modulo 08: entrega, programacao, alteracao de prazo, previsao,
 * status logistico e transporte.
 *
 * Duas fronteiras que este arquivo nao cruza:
 *   - nao da entrada fisica no estoque (secao 49) - so move quantidade EM
 *     TRANSITO, que e projecao, nao saldo contabil. A entrada e do modulo 09.
 *   - nao altera preco, quantidade pedida nem condicao comercial (secao 53);
 *     isso continua sendo fluxo do modulo 07.
 */
import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { conflito, naoEncontrado, regraNegocio } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import type { z } from 'zod';
import type {
  alterarPrazoSchema, editarEntregaSchema, listarEntregasSchema, previsaoSchema,
  programarSchema, registrarEntregaSchema, statusLogisticoSchema, transporteSchema,
} from './entregas.schemas.js';
import { calcularEta, diferencaDias } from './calculos.js';
import { configuracoes, hojeIso, parametros } from './acompanhamento.service.js';

type Cliente = { query: (t: string, v?: unknown[]) => Promise<{ rows: any[] }> };

const num = (v: unknown) => Number(v ?? 0);
const dataIso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string).toISOString().slice(0, 10);

/** Pedido que ja acabou ou foi cancelado nao recebe mais movimentacao. */
const ENCERRADOS = ['CANCELADA', 'REJEITADA', 'FINALIZADA'];

async function registrarHistoricoPedido(
  cliente: Cliente, pedidoId: number, evento: string,
  usuarioId: number | null, descricao: string | null, detalhes?: unknown,
) {
  await cliente.query(`
    INSERT INTO pedido_historico
      (ordem_compra_id, evento, status_anterior, status_novo, descricao, detalhes, usuario_id)
    VALUES ($1, $2, NULL, NULL, $3, $4::jsonb, $5)`,
    [pedidoId, evento, descricao, JSON.stringify(detalhes ?? {}), usuarioId]);
}

async function proximoNumero(cliente: Cliente, tabela: string, chave: string, padrao: string) {
  const { rows: cfg } = await cliente.query(
    'SELECT valor FROM configuracoes WHERE chave = $1', [chave]);
  const prefixo = cfg[0]?.valor ?? padrao;
  const marca = `${prefixo}-${new Date().getUTCFullYear()}-%`;
  const { rows } = await cliente.query(`
    SELECT coalesce(max(nullif(regexp_replace(numero, '^.*-', ''), '')::bigint), 0) + 1 AS proximo
      FROM ${tabela} WHERE numero LIKE $1`, [marca]);
  return `${prefixo}-${new Date().getUTCFullYear()}-${String(rows[0].proximo).padStart(6, '0')}`;
}

async function motivoPorCodigo(cliente: Cliente, codigo?: string) {
  if (!codigo) return null;
  const { rows } = await cliente.query(
    'SELECT id FROM motivos_atraso WHERE codigo = $1 AND ativo', [codigo]);
  if (!rows.length) throw regraNegocio(`Motivo de atraso ${codigo} nao existe ou esta inativo`);
  return Number(rows[0].id);
}

// ---------------------------------------------------------------------------
// Status logistico (secao 35)
// ---------------------------------------------------------------------------

/**
 * Sem maquina de estados rigida aqui de proposito: a logistica real anda para
 * tras (carga volta, embarque cai) e travar transicoes faria o comprador
 * mentir para o sistema. O que e obrigatorio e o rastro - toda mudanca vai
 * para o historico append-only.
 */
export async function mudarStatusLogistico(
  pedidoId: number, entrada: z.output<typeof statusLogisticoSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT id, status, status_logistico FROM ordens_compra WHERE id = $1 FOR UPDATE', [pedidoId]);
    if (!rows.length) throw naoEncontrado('Pedido de compra');
    const pedido = rows[0];

    if (ENCERRADOS.includes(pedido.status) && entrada.status !== 'CANCELADO') {
      throw regraNegocio(`Pedido em ${pedido.status} nao aceita mudanca de status logistico`);
    }

    const anterior = pedido.status_logistico;
    if (anterior === entrada.status) {
      throw conflito(`Pedido ja esta em ${entrada.status}`);
    }

    const { rows: atualizado } = await cliente.query(`
      UPDATE ordens_compra SET status_logistico = $2::status_logistico_enum, updated_at = now()
       WHERE id = $1 RETURNING *`, [pedidoId, entrada.status]);

    await cliente.query(`
      INSERT INTO status_logistico_historico
        (ordem_compra_id, entrega_id, status_anterior, status_novo, justificativa, usuario_id)
      VALUES ($1, $2, $3::status_logistico_enum, $4::status_logistico_enum, $5, $6)`,
      [pedidoId, entrada.entrega_id ?? null, anterior, entrada.status,
        entrada.justificativa ?? null, contexto.usuarioId ?? null]);

    await registrarHistoricoPedido(cliente, pedidoId, 'STATUS_LOGISTICO',
      contexto.usuarioId ?? null,
      `Status logistico: ${anterior ?? 'nao definido'} para ${entrada.status}`,
      { anterior, novo: entrada.status });

    return { ...atualizado[0], status_logistico_anterior: anterior };
  });
}

// ---------------------------------------------------------------------------
// Alteracao de prazo (secoes 12, 13 e 80)
// ---------------------------------------------------------------------------

/**
 * A promessa original nunca e apagada: fica em data_prometida_original e o
 * que muda e a promessa atual. Cada mudanca vira uma linha append-only com a
 * diferenca em dias e o motivo.
 */
export async function alterarPrazo(
  pedidoId: number, entrada: z.output<typeof alterarPrazoSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM ordens_compra WHERE id = $1 FOR UPDATE', [pedidoId]);
    if (!rows.length) throw naoEncontrado('Pedido de compra');
    const pedido = rows[0];

    if (ENCERRADOS.includes(pedido.status)) {
      throw regraNegocio(`Pedido em ${pedido.status} nao aceita alteracao de prazo`);
    }

    const motivoId = entrada.motivo_atraso_id
      ?? await motivoPorCodigo(cliente, entrada.motivo_codigo);

    const nova = dataIso(entrada.data_nova)!;
    let item: any = null;

    if (entrada.ordem_compra_item_id) {
      const { rows: itens } = await cliente.query(
        'SELECT * FROM ordem_compra_itens WHERE id = $1 AND ordem_compra_id = $2 FOR UPDATE',
        [entrada.ordem_compra_item_id, pedidoId]);
      if (!itens.length) throw naoEncontrado('Item do pedido');
      item = itens[0];
    }

    const anterior = entrada.campo === 'ETA'
      ? dataIso(pedido.eta_atual)
      : entrada.campo === 'DATA_PREVISTA_ENTREGA'
        ? dataIso(pedido.data_prevista_entrega)
        : dataIso(item ? item.data_prometida : pedido.data_prometida);

    const diferenca = diferencaDias(anterior, nova);
    const necessaria = dataIso(item?.data_necessaria ?? pedido.data_necessaria);
    const ultrapassa = necessaria !== null && diferencaDias(necessaria, nova)! > 0;

    if (entrada.campo === 'DATA_PROMETIDA') {
      if (item) {
        await cliente.query(`
          UPDATE ordem_compra_itens
             SET data_prometida = $2,
                 data_prometida_original = coalesce(data_prometida_original, data_prometida),
                 motivo_atraso_id = coalesce($3, motivo_atraso_id), updated_at = now()
           WHERE id = $1`, [item.id, nova, motivoId]);
      } else {
        await cliente.query(`
          UPDATE ordens_compra
             SET data_prometida = $2,
                 data_prometida_original = coalesce(data_prometida_original, data_prometida),
                 motivo_atraso_id = coalesce($3, motivo_atraso_id),
                 alteracoes_prazo_total = alteracoes_prazo_total + 1, updated_at = now()
           WHERE id = $1`, [pedidoId, nova, motivoId]);
        // O item segue o cabecalho quando nao tem promessa propria.
        await cliente.query(`
          UPDATE ordem_compra_itens
             SET data_prometida = $2,
                 data_prometida_original = coalesce(data_prometida_original, data_prometida)
           WHERE ordem_compra_id = $1`, [pedidoId, nova]);
      }
    } else if (entrada.campo === 'DATA_PREVISTA_ENTREGA') {
      await cliente.query(
        'UPDATE ordens_compra SET data_prevista_entrega = $2, updated_at = now() WHERE id = $1',
        [pedidoId, nova]);
    } else {
      await cliente.query(`
        UPDATE ordens_compra
           SET eta_original = coalesce(eta_original, eta_atual, $2), eta_atual = $2,
               eta_fonte = 'MANUAL'::fonte_previsao_enum,
               eta_confianca = 'MEDIA'::confianca_previsao_enum,
               eta_calculada_em = now(), updated_at = now()
         WHERE id = $1`, [pedidoId, nova]);
    }

    const { rows: registro } = await cliente.query(`
      INSERT INTO alteracoes_prazo
        (ordem_compra_id, ordem_compra_item_id, campo, data_anterior, data_nova,
         diferenca_dias, motivo_atraso_id, justificativa, origem,
         ultrapassa_necessidade, usuario_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::origem_alteracao_prazo_enum,$10,$11)
      RETURNING *`,
      [pedidoId, entrada.ordem_compra_item_id ?? null, entrada.campo, anterior, nova,
        diferenca, motivoId, entrada.justificativa, entrada.origem, ultrapassa,
        contexto.usuarioId ?? null]);

    await registrarHistoricoPedido(cliente, pedidoId, 'ALTERACAO_PRAZO',
      contexto.usuarioId ?? null,
      `${entrada.campo}: ${anterior ?? 'sem data'} para ${nova}`
      + (diferenca !== null ? ` (${diferenca >= 0 ? '+' : ''}${diferenca} dias)` : ''),
      { campo: entrada.campo, anterior, nova, diferenca, ultrapassa_necessidade: ultrapassa });

    // Alerta quando a nova data passa da necessidade (secao 13).
    if (ultrapassa) {
      await cliente.query(`
        INSERT INTO alertas (tipo, severidade, produto_id, fornecedor_id, ordem_compra_id,
                             mensagem, detalhes)
        VALUES ('ALTERACAO_PRAZO'::tipo_alerta_enum, 'ALTA'::severidade_enum,
                $1, $2, $3, $4, $5::jsonb)`,
        [item?.produto_id ?? null, pedido.fornecedor_id, pedidoId,
          `Nova data ${nova} ultrapassa a data necessaria ${necessaria}`,
          JSON.stringify({ anterior, nova, diferenca, data_necessaria: necessaria })]);
    }

    return {
      ...registro[0],
      data_prometida_original: dataIso(pedido.data_prometida_original ?? pedido.data_prometida),
      alerta_gerado: ultrapassa,
    };
  });
}

// ---------------------------------------------------------------------------
// Previsao de entrega / ETA (secoes 44, 45 e 46)
// ---------------------------------------------------------------------------

/** Recalcula a ETA a partir da melhor evidencia e grava a linha de historico. */
export async function recalcularEta(
  pedidoId: number, entrada: z.output<typeof previsaoSchema>, contexto: ContextoSessao,
) {
  const cfg = await configuracoes();
  const p = parametros(cfg);
  const hoje = hojeIso();

  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(`
      SELECT oc.*, f.lead_time_padrao_dias,
             (SELECT count(*) FILTER (WHERE e.data_real IS NOT NULL)
                FROM entregas e JOIN ordens_compra o2 ON o2.id = e.ordem_compra_id
               WHERE o2.fornecedor_id = oc.fornecedor_id) AS fornecedor_entregas,
             (SELECT avg(e.data_real - o2.data_emissao)
                FROM entregas e JOIN ordens_compra o2 ON o2.id = e.ordem_compra_id
               WHERE o2.fornecedor_id = oc.fornecedor_id AND e.data_real IS NOT NULL)
               AS fornecedor_lead_time_medio,
             (SELECT tp.data_prevista FROM transportes_pedido tp
               WHERE tp.ordem_compra_id = oc.id ORDER BY tp.created_at DESC LIMIT 1)
               AS transporte_data_prevista,
             (SELECT tp.data_coleta FROM transportes_pedido tp
               WHERE tp.ordem_compra_id = oc.id ORDER BY tp.created_at DESC LIMIT 1)
               AS transporte_data_coleta
        FROM ordens_compra oc
        JOIN fornecedores f ON f.id = oc.fornecedor_id
       WHERE oc.id = $1 FOR UPDATE OF oc`, [pedidoId]);
    if (!rows.length) throw naoEncontrado('Pedido de compra');
    const oc = rows[0];

    const anterior = dataIso(oc.eta_atual);
    let eta: { eta: string | null; fonte: string | null; confianca: string; memoria: unknown };

    if (entrada.eta && !entrada.recalcular) {
      eta = {
        eta: dataIso(entrada.eta),
        fonte: 'MANUAL',
        confianca: 'MEDIA',
        memoria: { regra: 'Previsao informada manualmente', usuario: contexto.usuarioId },
      };
    } else {
      eta = calcularEta({
        dataPrometida: dataIso(oc.data_prometida),
        dataConfirmacao: dataIso(oc.data_confirmacao),
        dataEmissao: dataIso(oc.data_emissao),
        statusLogistico: oc.status_logistico,
        transporteDataPrevista: dataIso(oc.transporte_data_prevista),
        transporteDataColeta: dataIso(oc.transporte_data_coleta),
        leadTimeHistoricoMedio: oc.fornecedor_lead_time_medio !== null
          ? num(oc.fornecedor_lead_time_medio) : null,
        leadTimeHistoricoEntregas: Number(oc.fornecedor_entregas ?? 0),
        leadTimeContratado: oc.lead_time_padrao_dias !== null
          ? Number(oc.lead_time_padrao_dias) : null,
        minimoEntregasHistorico: p.minimoEntregasHistorico,
        hoje,
      });
    }

    const variacao = diferencaDias(anterior, eta.eta);

    await cliente.query(`
      UPDATE ordens_compra
         SET eta_original = coalesce(eta_original, $2),
             eta_atual = $2,
             eta_fonte = $3::fonte_previsao_enum,
             eta_confianca = $4::confianca_previsao_enum,
             eta_calculada_em = now(), updated_at = now()
       WHERE id = $1`, [pedidoId, eta.eta, eta.fonte, eta.confianca]);

    const { rows: registro } = await cliente.query(`
      INSERT INTO previsoes_entrega
        (ordem_compra_id, eta, eta_anterior, variacao_dias, fonte, confianca,
         memoria, justificativa, usuario_id)
      VALUES ($1,$2,$3,$4,$5::fonte_previsao_enum,$6::confianca_previsao_enum,$7::jsonb,$8,$9)
      RETURNING *`,
      [pedidoId, eta.eta, anterior, variacao, eta.fonte ?? 'MANUAL', eta.confianca,
        JSON.stringify(eta.memoria), entrada.justificativa ?? null, contexto.usuarioId ?? null]);

    if (anterior && variacao !== null && variacao !== 0) {
      await cliente.query(`
        INSERT INTO alertas (tipo, severidade, fornecedor_id, ordem_compra_id, mensagem, detalhes)
        VALUES ('ETA_ALTERADA'::tipo_alerta_enum, $1::severidade_enum, $2, $3, $4, $5::jsonb)`,
        [variacao > 0 ? 'ALTA' : 'MEDIA', oc.fornecedor_id, pedidoId,
          `Previsao de entrega mudou de ${anterior} para ${eta.eta} (${variacao >= 0 ? '+' : ''}${variacao} dias)`,
          JSON.stringify({ anterior, nova: eta.eta, variacao })]);
    }

    await registrarHistoricoPedido(cliente, pedidoId, 'PREVISAO_ENTREGA',
      contexto.usuarioId ?? null,
      eta.eta ? `ETA ${eta.eta} (${eta.fonte}, confianca ${eta.confianca})`
        : 'Sem dados suficientes para prever a entrega',
      { anterior, nova: eta.eta, fonte: eta.fonte, confianca: eta.confianca });

    return { ...registro[0], eta_original: dataIso(oc.eta_original ?? eta.eta) };
  });
}

// ---------------------------------------------------------------------------
// Programacao de entrega (secao 19)
// ---------------------------------------------------------------------------

export async function programarEntrega(
  entrada: z.output<typeof programarSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT id, status FROM ordens_compra WHERE id = $1', [entrada.ordem_compra_id]);
    if (!rows.length) throw naoEncontrado('Pedido de compra');
    if (ENCERRADOS.includes(rows[0].status)) {
      throw regraNegocio(`Pedido em ${rows[0].status} nao aceita programacao de entrega`);
    }

    const { rows: criada } = await cliente.query(`
      INSERT INTO entrega_programacoes
        (ordem_compra_id, data_prevista, horario_previsto, local_id, transportadora,
         modal, observacao, created_by)
      VALUES ($1,$2,$3,$4,$5,$6::modal_transporte_enum,$7,$8) RETURNING *`,
      [entrada.ordem_compra_id, entrada.data_prevista, entrada.horario_previsto ?? null,
        entrada.local_id ?? null, entrada.transportadora ?? null, entrada.modal ?? null,
        entrada.observacao ?? null, contexto.usuarioId ?? null]);

    for (const i of entrada.itens) {
      const { rows: item } = await cliente.query(
        'SELECT produto_id FROM ordem_compra_itens WHERE id = $1 AND ordem_compra_id = $2',
        [i.ordem_compra_item_id, entrada.ordem_compra_id]);
      if (!item.length) throw regraNegocio(`Item ${i.ordem_compra_item_id} nao pertence a este pedido`);
      await cliente.query(`
        INSERT INTO entrega_programacao_itens
          (programacao_id, ordem_compra_item_id, produto_id, quantidade)
        VALUES ($1,$2,$3,$4)`,
        [criada[0].id, i.ordem_compra_item_id, item[0].produto_id, i.quantidade]);
    }

    await registrarHistoricoPedido(cliente, entrada.ordem_compra_id, 'ENTREGA_PROGRAMADA',
      contexto.usuarioId ?? null,
      `Entrega programada para ${dataIso(entrada.data_prevista)}`,
      { itens: entrada.itens.length, transportadora: entrada.transportadora });

    return criada[0];
  });
}

// ---------------------------------------------------------------------------
// Entrega (secoes 17, 18 e 49)
// ---------------------------------------------------------------------------

/**
 * Registra uma entrega com seus itens e atualiza o pedido.
 *
 * O que muda no pedido: quantidade entregue, data efetiva e status - logistico
 * e comercial. O que NAO muda: saldo fisico de estoque. A quantidade so entra
 * como EM TRANSITO enquanto a carga nao chegou; quando chega, fica esperando o
 * modulo 09 conferir e dar a entrada oficial.
 */
export async function registrarEntrega(
  entrada: z.output<typeof registrarEntregaSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM ordens_compra WHERE id = $1 FOR UPDATE', [entrada.ordem_compra_id]);
    if (!rows.length) throw naoEncontrado('Pedido de compra');
    const pedido = rows[0];

    if (['CANCELADA', 'REJEITADA'].includes(pedido.status)) {
      throw regraNegocio(
        `PEDIDO ${pedido.status}. Nao e permitido registrar entrega sem autorizacao expressa`);
    }
    if (pedido.status === 'FINALIZADA') {
      throw regraNegocio('Pedido finalizado nao aceita nova entrega');
    }

    const motivoId = entrada.motivo_atraso_id
      ?? await motivoPorCodigo(cliente, entrada.motivo_codigo);

    const { rows: seq } = await cliente.query(
      'SELECT coalesce(max(sequencia), 0) + 1 AS proxima FROM entregas WHERE ordem_compra_id = $1',
      [entrada.ordem_compra_id]);
    const numero = await proximoNumero(cliente, 'entregas', 'entrega.prefixo_entrega', 'ENT');

    const dataReal = entrada.data_real ? dataIso(entrada.data_real) : null;
    const quantidadeTotal = entrada.itens.reduce((a, i) => a + i.quantidade, 0);

    const { rows: criada } = await cliente.query(`
      INSERT INTO entregas
        (ordem_compra_id, numero, sequencia, data_prevista, data_real, data_prometida,
         data_necessaria, quantidade_prevista, quantidade_entregue, status, local_id,
         programacao_id, transporte_id, horario_previsto, transportadora, codigo_rastreio,
         numero_nota_fiscal, chave_nfe, motivo_atraso_id, observacao, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::status_entrega_enum,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *`,
      [entrada.ordem_compra_id, numero, Number(seq[0].proxima),
        entrada.data_prevista ? dataIso(entrada.data_prevista) : dataReal,
        dataReal, dataIso(pedido.data_prometida), dataIso(pedido.data_necessaria),
        quantidadeTotal, dataReal ? quantidadeTotal : null,
        dataReal ? 'ENTREGUE' : 'PENDENTE',
        entrada.local_id ?? pedido.local_entrega_id ?? null,
        entrada.programacao_id ?? null, entrada.transporte_id ?? null,
        entrada.horario_previsto ?? null, entrada.transportadora ?? null,
        entrada.codigo_rastreio ?? null, entrada.numero_nota_fiscal ?? null,
        entrada.chave_nfe ?? null, motivoId, entrada.observacao ?? null,
        contexto.usuarioId ?? null]);
    const entrega = criada[0];

    for (const i of entrada.itens) {
      const { rows: item } = await cliente.query(`
        SELECT oci.*, p.id AS pid FROM ordem_compra_itens oci
        JOIN produtos p ON p.id = oci.produto_id
       WHERE oci.id = $1 AND oci.ordem_compra_id = $2 FOR UPDATE OF oci`,
        [i.ordem_compra_item_id, entrada.ordem_compra_id]);
      if (!item.length) throw regraNegocio(`Item ${i.ordem_compra_item_id} nao pertence a este pedido`);

      // O excesso e barrado pelo trigger do banco, que vale tambem para carga
      // manual; aqui a mensagem so chega mais cedo e mais legivel.
      await cliente.query(`
        INSERT INTO entrega_itens
          (entrega_id, ordem_compra_item_id, produto_id, lote_id, quantidade,
           data_prometida, data_necessaria, data_efetiva, observacao)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [entrega.id, i.ordem_compra_item_id, item[0].produto_id, i.lote_id ?? null,
          i.quantidade, item[0].data_prometida, item[0].data_necessaria, dataReal,
          i.observacao ?? null]);

      if (dataReal) {
        await cliente.query(`
          UPDATE ordem_compra_itens
             SET quantidade_entregue = quantidade_entregue + $2,
                 data_entrega_efetiva = coalesce(data_entrega_efetiva, $3),
                 quantidade_pendente = greatest(quantidade_pedida - (quantidade_entregue + $2), 0),
                 updated_at = now()
           WHERE id = $1`, [i.ordem_compra_item_id, i.quantidade, dataReal]);
      }
    }

    // Saldo do pedido depois desta entrega.
    const { rows: saldo } = await cliente.query(`
      SELECT sum(quantidade_pedida) AS pedida, sum(quantidade_entregue) AS entregue
        FROM ordem_compra_itens WHERE ordem_compra_id = $1`, [entrada.ordem_compra_id]);
    const pedida = num(saldo[0].pedida);
    const entregue = num(saldo[0].entregue);
    const completo = entregue >= pedida;

    if (dataReal) {
      const statusLogistico = completo ? 'AGUARDANDO_RECEBIMENTO' : 'ENTREGA_PARCIAL';
      const statusComercial = completo ? 'RECEBIDA' : 'RECEBIMENTO_PARCIAL';

      await cliente.query(`
        UPDATE ordens_compra
           SET status = $2::status_ordem_compra_enum,
               status_logistico = $3::status_logistico_enum,
               data_entrega_efetiva = CASE WHEN $4 THEN $5::date ELSE data_entrega_efetiva END,
               motivo_atraso_id = coalesce($6, motivo_atraso_id),
               updated_at = now()
         WHERE id = $1`,
        [entrada.ordem_compra_id, statusComercial, statusLogistico, completo, dataReal, motivoId]);

      await cliente.query(`
        INSERT INTO status_logistico_historico
          (ordem_compra_id, entrega_id, status_anterior, status_novo, justificativa, usuario_id)
        VALUES ($1,$2,$3::status_logistico_enum,$4::status_logistico_enum,$5,$6)`,
        [entrada.ordem_compra_id, entrega.id, pedido.status_logistico, statusLogistico,
          completo ? 'Entrega completa' : 'Entrega parcial', contexto.usuarioId ?? null]);

      // Pronta para o modulo 09 conferir. A entrada fisica NAO acontece aqui.
      await cliente.query(
        'UPDATE entregas SET pronta_recebimento = true WHERE id = $1', [entrega.id]);
    }

    await registrarHistoricoPedido(cliente, entrada.ordem_compra_id,
      dataReal ? 'ENTREGA_REGISTRADA' : 'ENTREGA_PREVISTA', contexto.usuarioId ?? null,
      dataReal
        ? `Entrega ${numero}: ${quantidadeTotal} em ${dataReal}`
          + (completo ? ' (pedido completo)' : ` (${pedida - entregue} pendente)`)
        : `Entrega ${numero} prevista para ${dataIso(entrada.data_prevista)}`,
      { entrega_id: Number(entrega.id), numero, quantidade: quantidadeTotal, completo });

    return {
      ...entrega,
      itens: entrada.itens.length,
      quantidade_total: quantidadeTotal,
      saldo_pedido: {
        pedida, entregue, pendente: Math.max(0, pedida - entregue),
        percentual_atendido: pedida > 0 ? (entregue / pedida) * 100 : 0,
        completo,
      },
      pronta_recebimento: Boolean(dataReal),
      observacao: dataReal
        ? 'Entrega registrada. A entrada fisica no estoque e feita no modulo 09'
        : 'Entrega prevista registrada; ainda nao recebida',
    };
  });
}

export async function editarEntrega(
  entregaId: number, entrada: z.output<typeof editarEntregaSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM entregas WHERE id = $1 FOR UPDATE', [entregaId]);
    if (!rows.length) throw naoEncontrado('Entrega');
    const entrega = rows[0];

    if (entrega.data_real && entrada.data_real === undefined && entrada.data_prevista) {
      throw regraNegocio('Entrega ja realizada nao aceita mudanca de data prevista');
    }

    const { rows: atualizada } = await cliente.query(`
      UPDATE entregas
         SET data_prevista = coalesce($2, data_prevista),
             data_real = coalesce($3, data_real),
             horario_previsto = coalesce($4, horario_previsto),
             transportadora = coalesce($5, transportadora),
             codigo_rastreio = coalesce($6, codigo_rastreio),
             numero_nota_fiscal = coalesce($7, numero_nota_fiscal),
             chave_nfe = coalesce($8, chave_nfe),
             motivo_atraso_id = coalesce($9, motivo_atraso_id),
             observacao = coalesce($10, observacao),
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [entregaId,
        entrada.data_prevista ? dataIso(entrada.data_prevista) : null,
        entrada.data_real ? dataIso(entrada.data_real) : null,
        entrada.horario_previsto ?? null, entrada.transportadora ?? null,
        entrada.codigo_rastreio ?? null, entrada.numero_nota_fiscal ?? null,
        entrada.chave_nfe ?? null, entrada.motivo_atraso_id ?? null,
        entrada.observacao ?? null]);

    await registrarHistoricoPedido(cliente, Number(entrega.ordem_compra_id), 'ENTREGA_ATUALIZADA',
      contexto.usuarioId ?? null, `Entrega ${entrega.numero ?? entregaId} atualizada`, entrada);

    return atualizada[0];
  });
}

export async function listarEntregas(
  filtro: z.output<typeof listarEntregasSchema> & Paginacao,
) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const filtrar = (sql: string, valor: unknown) => {
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  if (filtro.ordem_compra_id) filtrar('e.ordem_compra_id = $?', filtro.ordem_compra_id);
  if (filtro.fornecedor_id) filtrar('oc.fornecedor_id = $?', filtro.fornecedor_id);
  if (filtro.status) filtrar('e.status = $?::status_entrega_enum', filtro.status);
  if (filtro.data_inicio) filtrar('coalesce(e.data_real, e.data_prevista) >= $?', filtro.data_inicio);
  if (filtro.data_fim) filtrar('coalesce(e.data_real, e.data_prevista) <= $?', filtro.data_fim);
  if (filtro.apenas_pendentes_recebimento) {
    cond.push('e.pronta_recebimento AND e.recebimento_id IS NULL');
  }
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(e.numero ILIKE $${valores.length} OR oc.numero ILIKE $${valores.length}`
      + ` OR f.razao_social ILIKE $${valores.length})`);
  }

  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = await query<{ total: string }>(`
    SELECT count(*)::int AS total FROM entregas e
    JOIN ordens_compra oc ON oc.id = e.ordem_compra_id
    JOIN fornecedores f ON f.id = oc.fornecedor_id ${onde}`, valores);

  const { rows } = await query(`
    SELECT e.*, oc.numero AS pedido, f.razao_social AS fornecedor, f.id AS fornecedor_id,
           ma.descricao AS motivo_atraso, l.nome AS local,
           (SELECT count(*)::int FROM entrega_itens ei WHERE ei.entrega_id = e.id) AS itens,
           CASE WHEN e.data_real IS NOT NULL AND e.data_prometida IS NOT NULL
                THEN e.data_real - e.data_prometida END AS atraso_contra_promessa
      FROM entregas e
      JOIN ordens_compra oc ON oc.id = e.ordem_compra_id
      JOIN fornecedores f ON f.id = oc.fornecedor_id
      LEFT JOIN motivos_atraso ma ON ma.id = e.motivo_atraso_id
      LEFT JOIN locais l ON l.id = e.local_id
      ${onde}
     ORDER BY coalesce(e.data_real, e.data_prevista) DESC NULLS LAST, e.id DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return { dados: rows, meta: metaPaginacao(Number(total.rows[0]?.total ?? 0), filtro) };
}

export async function detalharEntrega(entregaId: number) {
  const { rows } = await query(`
    SELECT e.*, oc.numero AS pedido, oc.status AS status_pedido,
           f.razao_social AS fornecedor, f.id AS fornecedor_id,
           ma.descricao AS motivo_atraso, l.nome AS local, u.nome AS registrado_por
      FROM entregas e
      JOIN ordens_compra oc ON oc.id = e.ordem_compra_id
      JOIN fornecedores f ON f.id = oc.fornecedor_id
      LEFT JOIN motivos_atraso ma ON ma.id = e.motivo_atraso_id
      LEFT JOIN locais l ON l.id = e.local_id
      LEFT JOIN usuarios u ON u.id = e.created_by
     WHERE e.id = $1`, [entregaId]);
  if (!rows.length) throw naoEncontrado('Entrega');

  const [itens, documentos] = await Promise.all([
    query(`
      SELECT ei.*, p.codigo, p.descricao, un.codigo AS unidade,
             oci.quantidade_pedida, oci.quantidade_entregue AS entregue_no_item,
             CASE WHEN ei.data_efetiva IS NOT NULL AND ei.data_prometida IS NOT NULL
                  THEN ei.data_efetiva - ei.data_prometida END AS atraso_dias
        FROM entrega_itens ei
        JOIN produtos p ON p.id = ei.produto_id
        JOIN ordem_compra_itens oci ON oci.id = ei.ordem_compra_item_id
        LEFT JOIN unidades un ON un.id = coalesce(oci.unidade_id, p.unidade_compra_id)
       WHERE ei.entrega_id = $1 ORDER BY p.descricao`, [entregaId]),
    query('SELECT * FROM documentos_entrega WHERE entrega_id = $1 ORDER BY created_at', [entregaId]),
  ]);

  const detalhe: Record<string, any> = {
    ...rows[0], itens: itens.rows, documentos: documentos.rows,
  };
  return detalhe;
}

// ---------------------------------------------------------------------------
// Transporte (secoes 34 e 47)
// ---------------------------------------------------------------------------

export async function registrarTransporte(
  pedidoId: number, entrada: z.output<typeof transporteSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT id, status FROM ordens_compra WHERE id = $1', [pedidoId]);
    if (!rows.length) throw naoEncontrado('Pedido de compra');

    const { rows: criado } = await cliente.query(`
      INSERT INTO transportes_pedido
        (ordem_compra_id, transportadora, modal, veiculo, motorista, documento,
         codigo_rastreio, origem, destino, data_coleta, data_prevista, data_efetiva,
         incoterm, porto_origem, porto_destino, data_embarque, eta_porto,
         data_desembaraco, eta_final, observacao, created_by)
      VALUES ($1,$2,$3::modal_transporte_enum,$4,$5,$6,$7,$8,$9,$10,$11,$12,
              $13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *`,
      [pedidoId, entrada.transportadora ?? null, entrada.modal ?? null, entrada.veiculo ?? null,
        entrada.motorista ?? null, entrada.documento ?? null, entrada.codigo_rastreio ?? null,
        entrada.origem ?? null, entrada.destino ?? null,
        entrada.data_coleta ?? null, entrada.data_prevista ?? null, entrada.data_efetiva ?? null,
        entrada.incoterm ?? null, entrada.porto_origem ?? null, entrada.porto_destino ?? null,
        entrada.data_embarque ?? null, entrada.eta_porto ?? null,
        entrada.data_desembaraco ?? null, entrada.eta_final ?? null,
        entrada.observacao ?? null, contexto.usuarioId ?? null]);

    await registrarHistoricoPedido(cliente, pedidoId, 'TRANSPORTE', contexto.usuarioId ?? null,
      `Transporte registrado${entrada.transportadora ? ` com ${entrada.transportadora}` : ''}`,
      { modal: entrada.modal, rastreio: entrada.codigo_rastreio });

    return criado[0];
  });
}

// ---------------------------------------------------------------------------
// Pacote para o MODULO 09 (secao 83)
// ---------------------------------------------------------------------------

/** O que o recebimento precisa saber. Nenhum recebimento e criado aqui. */
export async function pacoteRecebimento(entregaId: number) {
  const entrega = await detalharEntrega(entregaId);
  if (!entrega.data_real) {
    throw regraNegocio('Entrega ainda nao realizada: nao ha o que conferir no recebimento');
  }
  return {
    entrega_id: entregaId,
    numero: entrega.numero,
    pedido: entrega.pedido,
    ordem_compra_id: Number(entrega.ordem_compra_id),
    fornecedor_id: Number(entrega.fornecedor_id),
    fornecedor: entrega.fornecedor,
    data_entrega: dataIso(entrega.data_real),
    local_id: entrega.local_id !== null ? Number(entrega.local_id) : null,
    local: entrega.local,
    numero_nota_fiscal: entrega.numero_nota_fiscal,
    chave_nfe: entrega.chave_nfe,
    transportadora: entrega.transportadora,
    codigo_rastreio: entrega.codigo_rastreio,
    observacao: entrega.observacao,
    ja_recebida: entrega.recebimento_id !== null,
    itens: (entrega.itens as any[]).map((i) => ({
      entrega_item_id: Number(i.id),
      ordem_compra_item_id: Number(i.ordem_compra_item_id),
      produto_id: Number(i.produto_id),
      codigo: i.codigo,
      descricao: i.descricao,
      unidade: i.unidade,
      quantidade_entregue: num(i.quantidade),
      quantidade_pedida: num(i.quantidade_pedida),
      lote_id: i.lote_id !== null ? Number(i.lote_id) : null,
    })),
    documentos: entrega.documentos,
    observacao_modulo: 'Entrada fisica no estoque e conferencia sao do MODULO 09',
  };
}
