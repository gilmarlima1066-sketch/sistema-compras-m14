/**
 * Acompanhamento: le um pedido (ou a carteira inteira) e devolve, item a item,
 * atraso, saldo, ETA, risco de ruptura, impacto, situacao e prioridade.
 *
 * Este arquivo so LE. Nada aqui muda pedido, estoque ou entrega - a secao 53
 * do PROMPT 08 proibe alterar informacao comercial do pedido fora do fluxo do
 * modulo 07, e a 49 proibe dar entrada fisica no estoque fora do modulo 09.
 */
import { query } from '../../config/database.js';
import { naoEncontrado } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import type { z } from 'zod';
import type { listarAcompanhamentoSchema } from './entregas.schemas.js';
import {
  avaliarSituacao, calcularAtraso, calcularEta, calcularLeadTime, calcularPrioridade,
  calcularRiscoRuptura, calcularSaldo, classificarImpacto, diferencaDias,
  type FaixasAtraso, type FaixasRuptura,
} from './calculos.js';

const num = (v: unknown) => Number(v ?? 0);
const dataIso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string).toISOString().slice(0, 10);

export const hojeIso = () => new Date().toISOString().slice(0, 10);

export interface ParametrosEntrega {
  faixasAtraso: FaixasAtraso;
  faixasRuptura: FaixasRuptura;
  diasAntecedencia: number;
  diasSemConfirmacao: number;
  minimoEntregasHistorico: number;
  toleranciaExcedente: number;
}

export async function configuracoes(): Promise<Record<string, string>> {
  const { rows } = await query<{ chave: string; valor: string }>(
    "SELECT chave, valor FROM configuracoes WHERE grupo = 'entrega'");
  return Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
}

export function parametros(cfg: Record<string, string>): ParametrosEntrega {
  const n = (chave: string, padrao: number) => {
    const v = Number(cfg[chave]);
    return Number.isFinite(v) ? v : padrao;
  };
  return {
    faixasAtraso: {
      leveAte: n('entrega.atraso_leve_ate', 2),
      moderadoAte: n('entrega.atraso_moderado_ate', 5),
      altoAte: n('entrega.atraso_alto_ate', 10),
    },
    faixasRuptura: {
      criticaAte: n('entrega.ruptura_cobertura_critica', 3),
      altaAte: n('entrega.ruptura_cobertura_alta', 7),
      mediaAte: n('entrega.ruptura_cobertura_media', 15),
    },
    diasAntecedencia: n('entrega.risco_dias_antecedencia', 7),
    diasSemConfirmacao: n('entrega.risco_dias_sem_confirmacao', 3),
    minimoEntregasHistorico: n('entrega.eta_minimo_entregas_historico', 3),
    toleranciaExcedente: n('entrega.tolerancia_excedente_percentual', 0),
  };
}

/** Status que ainda dependem de entrega. Pedido cancelado ou recebido sai. */
const ABERTOS = "('APROVADA','ENVIADA','CONFIRMADA','EM_PRODUCAO','EM_TRANSITO','RECEBIMENTO_PARCIAL')";

/**
 * A consulta pesada do modulo. Traz, por item, tudo que o calculo precisa:
 * estoque (modulo 03), demanda (modulo 04), necessidade (modulo 05), pedido
 * (modulo 07) e o historico logistico do fornecedor.
 */
const SELECT_ITENS = `
  WITH historico_fornecedor AS (
    SELECT oc.fornecedor_id,
           count(*) FILTER (WHERE e.data_real IS NOT NULL)                       AS entregas,
           avg(e.data_real - oc.data_emissao) FILTER (WHERE e.data_real IS NOT NULL) AS lead_time_medio,
           count(*) FILTER (WHERE e.data_real IS NOT NULL
                              AND e.data_prometida IS NOT NULL
                              AND e.data_real > e.data_prometida
                              AND e.data_real >= CURRENT_DATE - 180)             AS atrasos_recentes
      FROM entregas e
      JOIN ordens_compra oc ON oc.id = e.ordem_compra_id
     GROUP BY oc.fornecedor_id
  )
  SELECT a.*,
         oc.numero                       AS pedido_numero,
         oc.valor_total                  AS pedido_valor,
         oc.data_prevista_entrega,
         f.lead_time_padrao_dias,
         u.nome                          AS comprador,
         c.nome                          AS categoria,
         t.data_prevista                 AS transporte_data_prevista,
         t.data_coleta                   AS transporte_data_coleta,
         t.transportadora,
         t.modal,
         t.codigo_rastreio,
         coalesce(s.disponivel, 0)       AS estoque_disponivel,
         coalesce(s.reservado, 0)        AS estoque_reservado,
         coalesce(s.transito, 0)         AS estoque_transito,
         d.demanda_diaria,
         pv.demanda_prevista,
         nc.prioridade                   AS prioridade_planejamento,
         nc.estoque_seguranca,
         nc.ponto_pedido,
         coalesce(h.entregas, 0)         AS fornecedor_entregas,
         h.lead_time_medio               AS fornecedor_lead_time_medio,
         coalesce(h.atrasos_recentes, 0) AS fornecedor_atrasos_recentes,
         coalesce(ap.total, 0)           AS alteracoes_prazo,
         coalesce(oco.abertas, 0)        AS ocorrencias_abertas
    FROM vw_acompanhamento_itens a
    JOIN ordens_compra oc ON oc.id = a.ordem_compra_id
    JOIN fornecedores f ON f.id = a.fornecedor_id
    LEFT JOIN usuarios u ON u.id = a.comprador_id
    LEFT JOIN categorias c ON c.id = a.categoria_id
    LEFT JOIN historico_fornecedor h ON h.fornecedor_id = a.fornecedor_id
    LEFT JOIN LATERAL (
      SELECT * FROM transportes_pedido tp
       WHERE tp.ordem_compra_id = a.ordem_compra_id
       ORDER BY tp.created_at DESC LIMIT 1) t ON true
    LEFT JOIN LATERAL (
      SELECT sum(quantidade_disponivel) AS disponivel, sum(quantidade_reservada) AS reservado,
             sum(quantidade_em_transito) AS transito
        FROM estoques e WHERE e.produto_id = a.produto_id) s ON true
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(quantidade), 0) / 90.0 AS demanda_diaria
        FROM mv_demanda_diaria m
       WHERE m.produto_id = a.produto_id AND m.data_venda >= CURRENT_DATE - 90) d ON true
    LEFT JOIN LATERAL (
      SELECT demanda_prevista FROM previsoes_demanda pd
       WHERE pd.produto_id = a.produto_id
       ORDER BY pd.periodo_inicio DESC, pd.versao DESC LIMIT 1) pv ON true
    LEFT JOIN necessidades_compra nc ON nc.id = a.necessidade_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS total FROM alteracoes_prazo x
       WHERE x.ordem_compra_id = a.ordem_compra_id) ap ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS abertas FROM ocorrencias_entrega o
       WHERE o.ordem_compra_id = a.ordem_compra_id
         AND o.status IN ('ABERTA','EM_TRATAMENTO','AGUARDANDO_FORNECEDOR')) oco ON true
`;

export interface LinhaAcompanhamento extends Record<string, unknown> {
  ordem_compra_id: number;
  ordem_compra_item_id: number;
}

/** Aplica o motor de calculo sobre uma linha crua da consulta acima. */
export function avaliarLinha(l: any, p: ParametrosEntrega, hoje: string) {
  const dataPrometida = dataIso(l.data_prometida);
  const dataNecessaria = dataIso(l.data_necessaria);
  const entregue = num(l.quantidade_entregue) >= num(l.quantidade_pedida);

  // A data efetiva so encerra o atraso quando o item foi atendido por inteiro.
  // Numa entrega parcial, o que sobrou continua devendo: usar a data da
  // primeira remessa faria um item com 200 kg vencidos ha 10 dias aparecer
  // como entregue no prazo (secoes 16 e 17).
  const dataEfetiva = entregue ? dataIso(l.data_entrega_efetiva) : null;
  const dataPrimeiraEntrega = dataIso(l.data_entrega_efetiva);

  const eta = calcularEta({
    dataPrometida,
    dataConfirmacao: dataIso(l.data_confirmacao),
    dataEmissao: dataIso(l.data_emissao),
    statusLogistico: l.status_logistico,
    transporteDataPrevista: dataIso(l.transporte_data_prevista),
    transporteDataColeta: dataIso(l.transporte_data_coleta),
    leadTimeHistoricoMedio: l.fornecedor_lead_time_medio !== null
      ? num(l.fornecedor_lead_time_medio) : null,
    leadTimeHistoricoEntregas: Number(l.fornecedor_entregas ?? 0),
    leadTimeContratado: l.lead_time_padrao_dias !== null ? Number(l.lead_time_padrao_dias) : null,
    minimoEntregasHistorico: p.minimoEntregasHistorico,
    hoje,
  });

  const atraso = calcularAtraso({
    dataPrometida,
    dataNecessaria,
    dataEfetiva,
    dataPrevista: eta.eta,
    hoje,
    faixas: p.faixasAtraso,
  });

  const saldo = calcularSaldo({
    pedida: num(l.quantidade_pedida),
    confirmada: l.quantidade_confirmada !== null ? num(l.quantidade_confirmada) : null,
    entregue: num(l.quantidade_entregue),
    recebida: num(l.quantidade_recebida),
    recusado: l.status_confirmacao === 'RECUSADO',
  });

  const risco = calcularRiscoRuptura({
    estoqueDisponivel: num(l.estoque_disponivel),
    estoqueReservado: num(l.estoque_reservado),
    demandaDiaria: l.demanda_diaria !== null ? num(l.demanda_diaria) : null,
    quantidadePendente: saldo.pendenteEntrega,
    dataPrevistaChegada: eta.eta,
    hoje,
    faixas: p.faixasRuptura,
  });

  const valorPendente = saldo.pendenteEntrega * num(l.preco_unitario);

  const impacto = classificarImpacto({
    risco: risco.nivel,
    classificacaoAbc: l.classificacao_abc ?? null,
    quantidadePendente: saldo.pendenteEntrega,
    valorPendente,
  });

  const situacao = avaliarSituacao({
    entregue,
    atraso,
    impacto,
    diasAteEntrega: diferencaDias(hoje, eta.eta),
    confirmado: l.status_confirmacao === 'CONFIRMADO'
      || l.status_confirmacao === 'CONFIRMADO_PARCIALMENTE',
    diasDesdeEnvio: diferencaDias(dataIso(l.data_envio), hoje),
    alteracoesPrazo: Number(l.alteracoes_prazo ?? 0),
    atrasosRecentesFornecedor: Number(l.fornecedor_atrasos_recentes ?? 0),
    semPrevisao: eta.eta === null,
    ocorrenciasAbertas: Number(l.ocorrencias_abertas ?? 0),
    statusLogistico: l.status_logistico,
    parametros: { diasAntecedencia: p.diasAntecedencia, diasSemConfirmacao: p.diasSemConfirmacao },
  });

  const leadTime = calcularLeadTime({
    dataPedido: dataIso(l.data_emissao),
    dataPrometida,
    dataEfetiva,
  });

  return {
    ordem_compra_id: Number(l.ordem_compra_id),
    ordem_compra_item_id: Number(l.ordem_compra_item_id),
    pedido: l.pedido ?? l.pedido_numero,
    status_pedido: l.status_pedido,
    status_logistico: l.status_logistico,
    status_confirmacao: l.status_confirmacao,
    fornecedor_id: Number(l.fornecedor_id),
    fornecedor: l.fornecedor,
    origem_fornecedor: l.origem_fornecedor,
    comprador_id: l.comprador_id !== null ? Number(l.comprador_id) : null,
    comprador: l.comprador,
    produto_id: Number(l.produto_id),
    produto_codigo: l.produto_codigo,
    produto: l.produto,
    categoria: l.categoria,
    classificacao_abc: l.classificacao_abc,
    classificacao_xyz: l.classificacao_xyz,
    datas: {
      emissao: dataIso(l.data_emissao),
      envio: dataIso(l.data_envio),
      confirmacao: dataIso(l.data_confirmacao),
      necessaria: dataNecessaria,
      prometida: dataPrometida,
      prometida_original: dataIso(l.data_prometida_original),
      prevista_entrega: dataIso(l.data_prevista_entrega),
      efetiva: dataPrimeiraEntrega,
    },
    eta: {
      data: eta.eta,
      original: dataIso(l.eta_original),
      fonte: eta.fonte,
      confianca: eta.confianca,
      memoria: eta.memoria,
    },
    saldo,
    valor_pendente: valorPendente,
    atraso,
    lead_time: leadTime,
    risco_ruptura: risco,
    impacto,
    situacao: situacao.situacao,
    semaforo: situacao.semaforo,
    motivos_risco: situacao.motivos,
    prioridade: l.prioridade_entrega
      ?? calcularPrioridade({ situacao: situacao.situacao, impacto, risco: risco.nivel }),
    estoque: {
      disponivel: num(l.estoque_disponivel),
      reservado: num(l.estoque_reservado),
      em_transito: num(l.estoque_transito),
    },
    demanda: {
      media_diaria: l.demanda_diaria !== null ? num(l.demanda_diaria) : null,
      prevista: l.demanda_prevista !== null ? num(l.demanda_prevista) : null,
    },
    transporte: l.transportadora || l.codigo_rastreio ? {
      transportadora: l.transportadora,
      modal: l.modal,
      codigo_rastreio: l.codigo_rastreio,
      data_prevista: dataIso(l.transporte_data_prevista),
      data_coleta: dataIso(l.transporte_data_coleta),
    } : null,
    ocorrencias_abertas: Number(l.ocorrencias_abertas ?? 0),
    alteracoes_prazo: Number(l.alteracoes_prazo ?? 0),
  };
}

export type ItemAvaliado = ReturnType<typeof avaliarLinha>;

/**
 * Carteira em acompanhamento.
 *
 * Situacao, risco e impacto sao calculados em TypeScript, nao em SQL - eles
 * dependem de regras configuraveis que precisam sair explicadas. Por isso os
 * filtros dessas tres dimensoes sao aplicados depois do calculo, e a
 * paginacao tambem: paginar antes devolveria "3 atrasados" quando ha 30.
 */
export async function listarAcompanhamento(
  filtro: z.output<typeof listarAcompanhamentoSchema> & Paginacao,
) {
  const cfg = await configuracoes();
  const p = parametros(cfg);
  const hoje = hojeIso();

  const valores: unknown[] = [];
  const cond: string[] = [`a.status_pedido IN ${ABERTOS}`];

  const filtrar = (sql: string, valor: unknown) => {
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  if (filtro.fornecedor_id) filtrar('a.fornecedor_id = $?', filtro.fornecedor_id);
  if (filtro.produto_id) filtrar('a.produto_id = $?', filtro.produto_id);
  if (filtro.categoria_id) filtrar('a.categoria_id = $?', filtro.categoria_id);
  if (filtro.comprador_id) filtrar('a.comprador_id = $?', filtro.comprador_id);
  if (filtro.status) filtrar('a.status_pedido = $?::status_ordem_compra_enum', filtro.status);
  if (filtro.status_logistico) {
    filtrar('a.status_logistico = $?::status_logistico_enum', filtro.status_logistico);
  }
  if (filtro.origem) filtrar('a.origem_fornecedor = $?', filtro.origem);
  if (filtro.data_necessaria_ate) filtrar('a.data_necessaria <= $?', filtro.data_necessaria_ate);
  if (filtro.data_prometida_ate) filtrar('a.data_prometida <= $?', filtro.data_prometida_ate);
  if (filtro.data_inicio) filtrar('a.data_emissao >= $?', filtro.data_inicio);
  if (filtro.data_fim) filtrar('a.data_emissao <= $?', filtro.data_fim);
  if (filtro.apenas_sem_confirmacao) cond.push("a.status_confirmacao = 'NAO_CONFIRMADO'");
  if (filtro.apenas_em_transito) cond.push("a.status_logistico IN ('EXPEDIDO','EM_TRANSITO','CHEGOU_DESTINO')");
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(a.pedido ILIKE $${valores.length} OR a.fornecedor ILIKE $${valores.length}`
      + ` OR a.produto ILIKE $${valores.length} OR a.produto_codigo ILIKE $${valores.length})`);
  }

  const { rows } = await query(
    `${SELECT_ITENS} WHERE ${cond.join(' AND ')} ORDER BY a.data_necessaria NULLS LAST, a.ordem_compra_id, a.ordem_compra_item_id`,
    valores);

  let itens = rows.map((l) => avaliarLinha(l, p, hoje));

  if (filtro.situacao) itens = itens.filter((i) => i.situacao === filtro.situacao);
  if (filtro.prioridade) itens = itens.filter((i) => i.prioridade === filtro.prioridade);
  if (filtro.apenas_atrasados) itens = itens.filter((i) => i.situacao === 'ATRASADO');
  if (filtro.apenas_em_risco) itens = itens.filter((i) => i.situacao === 'EM_RISCO');
  if (filtro.apenas_parciais) {
    itens = itens.filter((i) => i.saldo.entregue > 0 && !i.saldo.completo);
  }
  if (filtro.apenas_sem_previsao) itens = itens.filter((i) => i.eta.data === null);
  if (filtro.dias_atraso_minimo !== undefined) {
    const minimo = filtro.dias_atraso_minimo;
    itens = itens.filter((i) => (i.atraso.contraPromessa ?? i.atraso.contraNecessidade ?? 0) >= minimo);
  }

  const total = itens.length;
  const inicio = deslocamento(filtro);
  const pagina = itens.slice(inicio, inicio + filtro.limite);

  return {
    dados: pagina,
    meta: {
      ...metaPaginacao(total, filtro),
      avaliado_em: hoje,
      parametros: {
        faixas_atraso: p.faixasAtraso,
        faixas_ruptura: p.faixasRuptura,
        dias_antecedencia_risco: p.diasAntecedencia,
        dias_sem_confirmacao: p.diasSemConfirmacao,
      },
    },
  };
}

/** Acompanhamento de um pedido: itens avaliados + resumo do cabecalho. */
export async function acompanharPedido(pedidoId: number) {
  const cfg = await configuracoes();
  const p = parametros(cfg);
  const hoje = hojeIso();

  const { rows: cabecalho } = await query(`
    SELECT oc.*, f.razao_social AS fornecedor, f.cnpj, f.email AS fornecedor_email,
           f.telefone AS fornecedor_telefone, f.origem_fornecedor, f.lead_time_padrao_dias,
           u.nome AS comprador, ma.descricao AS motivo_atraso,
           cp.nome AS condicao_pagamento, l.nome AS local_entrega
      FROM ordens_compra oc
      JOIN fornecedores f ON f.id = oc.fornecedor_id
      LEFT JOIN usuarios u ON u.id = oc.comprador_id
      LEFT JOIN motivos_atraso ma ON ma.id = oc.motivo_atraso_id
      LEFT JOIN condicoes_pagamento cp ON cp.id = oc.condicao_pagamento_id
      LEFT JOIN locais l ON l.id = oc.local_entrega_id
     WHERE oc.id = $1`, [pedidoId]);
  if (!cabecalho.length) throw naoEncontrado('Pedido de compra');

  const { rows } = await query(
    `${SELECT_ITENS} WHERE a.ordem_compra_id = $1 ORDER BY a.produto`, [pedidoId]);
  const itens = rows.map((l) => avaliarLinha(l, p, hoje));

  const [entregas, programacoes, alteracoes, previsoes, ocorrencias, contatos, transporte, statusHist] =
    await Promise.all([
      query(`
        SELECT e.*, ma.descricao AS motivo_atraso,
               (SELECT json_agg(json_build_object(
                  'id', ei.id, 'ordem_compra_item_id', ei.ordem_compra_item_id,
                  'produto_id', ei.produto_id, 'codigo', p.codigo, 'descricao', p.descricao,
                  'quantidade', ei.quantidade, 'lote_id', ei.lote_id,
                  'data_efetiva', ei.data_efetiva) ORDER BY p.descricao)
                  FROM entrega_itens ei JOIN produtos p ON p.id = ei.produto_id
                 WHERE ei.entrega_id = e.id) AS itens
          FROM entregas e
          LEFT JOIN motivos_atraso ma ON ma.id = e.motivo_atraso_id
         WHERE e.ordem_compra_id = $1 ORDER BY coalesce(e.data_real, e.data_prevista), e.id`, [pedidoId]),
      query(`
        SELECT pr.*, l.nome AS local,
               (SELECT json_agg(json_build_object(
                  'ordem_compra_item_id', pi.ordem_compra_item_id, 'codigo', p.codigo,
                  'descricao', p.descricao, 'quantidade', pi.quantidade) ORDER BY p.descricao)
                  FROM entrega_programacao_itens pi JOIN produtos p ON p.id = pi.produto_id
                 WHERE pi.programacao_id = pr.id) AS itens
          FROM entrega_programacoes pr
          LEFT JOIN locais l ON l.id = pr.local_id
         WHERE pr.ordem_compra_id = $1 ORDER BY pr.data_prevista`, [pedidoId]),
      query(`
        SELECT ap.*, u.nome AS usuario, ma.descricao AS motivo, p.descricao AS produto
          FROM alteracoes_prazo ap
          LEFT JOIN usuarios u ON u.id = ap.usuario_id
          LEFT JOIN motivos_atraso ma ON ma.id = ap.motivo_atraso_id
          LEFT JOIN ordem_compra_itens oci ON oci.id = ap.ordem_compra_item_id
          LEFT JOIN produtos p ON p.id = oci.produto_id
         WHERE ap.ordem_compra_id = $1 ORDER BY ap.created_at`, [pedidoId]),
      query(`
        SELECT pe.*, u.nome AS usuario FROM previsoes_entrega pe
        LEFT JOIN usuarios u ON u.id = pe.usuario_id
         WHERE pe.ordem_compra_id = $1 ORDER BY pe.created_at`, [pedidoId]),
      query(`
        SELECT o.*, u.nome AS responsavel, ma.descricao AS motivo
          FROM ocorrencias_entrega o
          LEFT JOIN usuarios u ON u.id = o.responsavel_id
          LEFT JOIN motivos_atraso ma ON ma.id = o.motivo_atraso_id
         WHERE o.ordem_compra_id = $1 ORDER BY o.data_abertura DESC`, [pedidoId]),
      query(`
        SELECT c.*, u.nome AS usuario FROM contatos_fornecedor_pedido c
        LEFT JOIN usuarios u ON u.id = c.usuario_id
         WHERE c.ordem_compra_id = $1 ORDER BY c.data_contato DESC`, [pedidoId]),
      query('SELECT * FROM transportes_pedido WHERE ordem_compra_id = $1 ORDER BY created_at DESC',
        [pedidoId]),
      query(`
        SELECT h.*, u.nome AS usuario FROM status_logistico_historico h
        LEFT JOIN usuarios u ON u.id = h.usuario_id
         WHERE h.ordem_compra_id = $1 ORDER BY h.created_at`, [pedidoId]),
    ]);

  const pior = (campo: 'situacao' | 'semaforo') => {
    const ordem = campo === 'situacao'
      ? ['ATRASADO', 'EM_RISCO', 'SEM_DADOS', 'NO_PRAZO', 'ENTREGUE']
      : ['VERMELHO', 'LARANJA', 'AMARELO', 'CINZA', 'VERDE'];
    for (const v of ordem) if (itens.some((i) => i[campo] === v)) return v;
    return ordem[ordem.length - 1]!;
  };

  const c = cabecalho[0];
  const totalPedido = itens.reduce((a, i) => a + i.saldo.pedida, 0);
  const totalEntregue = itens.reduce((a, i) => a + i.saldo.entregue, 0);

  return {
    pedido: {
      id: Number(c.id),
      numero: c.numero,
      fornecedor: c.fornecedor,
      fornecedor_id: Number(c.fornecedor_id),
      cnpj: c.cnpj,
      email: c.fornecedor_email,
      telefone: c.fornecedor_telefone,
      origem_fornecedor: c.origem_fornecedor,
      comprador: c.comprador,
      status: c.status,
      status_logistico: c.status_logistico,
      status_confirmacao: c.status_confirmacao,
      valor_total: num(c.valor_total),
      moeda: c.moeda,
      incoterm: c.incoterm,
      condicao_pagamento: c.condicao_pagamento,
      local_entrega: c.local_entrega,
      numero_pedido_fornecedor: c.numero_pedido_fornecedor,
      motivo_atraso: c.motivo_atraso,
      prioridade_entrega: c.prioridade_entrega,
      datas: {
        emissao: dataIso(c.data_emissao),
        envio: dataIso(c.data_envio),
        confirmacao: dataIso(c.data_confirmacao),
        necessaria: dataIso(c.data_necessaria),
        prometida: dataIso(c.data_prometida),
        prometida_original: dataIso(c.data_prometida_original),
        prevista_entrega: dataIso(c.data_prevista_entrega),
        efetiva: dataIso(c.data_entrega_efetiva),
        eta_original: dataIso(c.eta_original),
        eta_atual: dataIso(c.eta_atual),
      },
      eta_fonte: c.eta_fonte,
      eta_confianca: c.eta_confianca,
    },
    resumo: {
      itens: itens.length,
      situacao: pior('situacao'),
      semaforo: pior('semaforo'),
      quantidade_pedida: totalPedido,
      quantidade_entregue: totalEntregue,
      quantidade_pendente: itens.reduce((a, i) => a + i.saldo.pendenteEntrega, 0),
      percentual_atendido: totalPedido > 0 ? (totalEntregue / totalPedido) * 100 : 0,
      valor_pendente: itens.reduce((a, i) => a + i.valor_pendente, 0),
      itens_atrasados: itens.filter((i) => i.situacao === 'ATRASADO').length,
      itens_em_risco: itens.filter((i) => i.situacao === 'EM_RISCO').length,
      maior_atraso_dias: itens.reduce(
        (a, i) => Math.max(a, i.atraso.contraPromessa ?? 0), 0),
      entregas: entregas.rows.length,
    },
    itens,
    entregas: entregas.rows,
    programacoes: programacoes.rows,
    alteracoes_prazo: alteracoes.rows,
    previsoes: previsoes.rows,
    ocorrencias: ocorrencias.rows,
    contatos: contatos.rows,
    transportes: transporte.rows,
    status_logistico_historico: statusHist.rows,
    avaliado_em: hoje,
  };
}

/** Saldo do pedido (secao 18), separado por confirmado, entregue e recebido. */
export async function saldoPedido(pedidoId: number) {
  const { rows } = await query(`
    SELECT oci.id, p.codigo, p.descricao, un.codigo AS unidade,
           oci.quantidade_pedida, oci.quantidade_confirmada,
           oci.quantidade_entregue, oci.quantidade_recebida, oci.preco_unitario
      FROM ordem_compra_itens oci
      JOIN produtos p ON p.id = oci.produto_id
      LEFT JOIN unidades un ON un.id = coalesce(oci.unidade_id, p.unidade_compra_id)
     WHERE oci.ordem_compra_id = $1 ORDER BY p.descricao`, [pedidoId]);
  if (!rows.length) throw naoEncontrado('Pedido de compra');

  const itens = rows.map((i) => ({
    ordem_compra_item_id: Number(i.id),
    codigo: i.codigo,
    descricao: i.descricao,
    unidade: i.unidade,
    ...calcularSaldo({
      pedida: num(i.quantidade_pedida),
      confirmada: i.quantidade_confirmada !== null ? num(i.quantidade_confirmada) : null,
      entregue: num(i.quantidade_entregue),
      recebida: num(i.quantidade_recebida),
    }),
    valor_pendente: Math.max(0, num(i.quantidade_pedida) - num(i.quantidade_entregue))
      * num(i.preco_unitario),
  }));

  const soma = (campo: 'pedida' | 'confirmada' | 'entregue' | 'recebida' | 'pendenteEntrega') =>
    itens.reduce((a, i) => a + i[campo], 0);
  const pedida = soma('pedida');

  return {
    pedido_id: pedidoId,
    total: {
      pedida,
      confirmada: soma('confirmada'),
      entregue: soma('entregue'),
      recebida: soma('recebida'),
      pendente: soma('pendenteEntrega'),
      percentual_atendido: pedida > 0 ? (soma('entregue') / pedida) * 100 : 0,
      percentual_pendente: pedida > 0 ? (soma('pendenteEntrega') / pedida) * 100 : 0,
      valor_pendente: itens.reduce((a, i) => a + i.valor_pendente, 0),
    },
    itens,
    observacao: 'Quantidade confirmada nao e quantidade recebida: as duas andam separadas',
  };
}

/** Risco de ruptura dos produtos de um pedido (secoes 23, 24 e 25). */
export async function riscoPedido(pedidoId: number) {
  const cfg = await configuracoes();
  const p = parametros(cfg);
  const hoje = hojeIso();

  const { rows } = await query(
    `${SELECT_ITENS} WHERE a.ordem_compra_id = $1 ORDER BY a.produto`, [pedidoId]);
  if (!rows.length) throw naoEncontrado('Pedido de compra');

  const itens = rows.map((l) => {
    const avaliado = avaliarLinha(l, p, hoje);
    return {
      produto_id: avaliado.produto_id,
      codigo: avaliado.produto_codigo,
      descricao: avaliado.produto,
      classificacao_abc: avaliado.classificacao_abc,
      classificacao_xyz: avaliado.classificacao_xyz,
      quantidade_pendente: avaliado.saldo.pendenteEntrega,
      estoque: avaliado.estoque,
      demanda: avaliado.demanda,
      eta: avaliado.eta,
      atraso: avaliado.atraso,
      risco: avaliado.risco_ruptura,
      impacto: avaliado.impacto,
      prioridade: avaliado.prioridade,
    };
  });

  const ordem = ['CRITICO', 'ALTO', 'MEDIO', 'BAIXO', 'SEM_RISCO', 'NAO_CALCULAVEL'];
  const pior = ordem.find((n) => itens.some((i) => i.risco.nivel === n)) ?? 'SEM_RISCO';

  return {
    pedido_id: pedidoId,
    risco_geral: pior,
    itens,
    faixas: p.faixasRuptura,
    avaliado_em: hoje,
  };
}
