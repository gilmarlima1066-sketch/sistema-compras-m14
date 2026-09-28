/**
 * Recebimento e conferencia.
 *
 * O fluxo da secao 64 vive aqui: chegada -> conferencia documental ->
 * conferencia fisica -> lote e validade -> qualidade -> aprovacao.
 *
 * Duas fronteiras:
 *   - nada entra no estoque neste arquivo. A movimentacao acontece so na
 *     aprovacao (aprovacao.service.ts), numa transacao unica (secao 48);
 *   - nada aqui altera preco, quantidade pedida ou condicao comercial do
 *     pedido: isso continua sendo fluxo do modulo 07.
 */
import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { conflito, naoEncontrado, regraNegocio } from '../../core/errors.js';
import { deslocamento, metaPaginacao, type Paginacao } from '../../core/paginacao.js';
import { hojeLocal, paraDataCalendario } from '../../core/datas.js';
import type { z } from 'zod';
import type {
  adicionarItemSchema, anexoSchema, chegadaSchema, conferenciaDocumentosSchema,
  conferenciaLoteSchema, conferirItemSchema, criarRecebimentoSchema, divergenciaSchema,
  editarRecebimentoSchema, escanearSchema, listarDivergenciasSchema, listarRecebimentosSchema,
} from './recebimento.schemas.js';
import {
  avaliarValidade, conferirQuantidade, decidirDestino, semaforoItem,
  type AvaliacaoValidade, type ConferenciaQuantidade, type Tolerancia,
} from './calculos.js';

type Cliente = { query: (t: string, v?: unknown[]) => Promise<{ rows: any[] }> };

const num = (v: unknown) => Number(v ?? 0);
const dataIso = (v: unknown) => paraDataCalendario(v);

/** Status a partir dos quais o recebimento nao aceita mais movimentacao. */
export const ENCERRADOS = [
  'APROVADO', 'APROVADO_PARCIALMENTE', 'REJEITADO', 'DEVOLVIDO', 'CANCELADO', 'CONCLUIDO',
];

export async function configuracoes(): Promise<Record<string, string>> {
  const { rows } = await query<{ chave: string; valor: string }>(
    "SELECT chave, valor FROM configuracoes WHERE grupo = 'recebimento'");
  return Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
}

export const numeroConfig = (cfg: Record<string, string>, chave: string, padrao: number) => {
  const v = Number(cfg[chave]);
  return Number.isFinite(v) ? v : padrao;
};

export const booleanoConfig = (cfg: Record<string, string>, chave: string, padrao: boolean) =>
  cfg[chave] === undefined ? padrao : cfg[chave] === 'true';

// ---------------------------------------------------------------------------
// Tolerancia (secao 13)
// ---------------------------------------------------------------------------

/**
 * Resolve a tolerancia do mais especifico para o mais geral: produto, depois
 * fornecedor, depois categoria, e por fim a linha da empresa - que sempre
 * existe e serve de piso.
 */
export async function resolverTolerancia(
  produtoId: number, fornecedorId: number | null, categoriaId: number | null,
  tipoOperacao: string | null,
): Promise<Tolerancia> {
  const { rows } = await query(`
    SELECT * FROM parametros_tolerancia
     WHERE ativo AND (
       (escopo = 'PRODUTO'    AND produto_id = $1)
       OR (escopo = 'FORNECEDOR' AND fornecedor_id = $2)
       OR (escopo = 'CATEGORIA'  AND categoria_id = $3)
       OR (escopo = 'OPERACAO'   AND tipo_operacao = $4)
       OR escopo = 'EMPRESA')
     ORDER BY CASE escopo
                WHEN 'PRODUTO' THEN 1 WHEN 'FORNECEDOR' THEN 2
                WHEN 'CATEGORIA' THEN 3 WHEN 'OPERACAO' THEN 4 ELSE 5 END
     LIMIT 1`, [produtoId, fornecedorId, categoriaId, tipoOperacao]);

  if (!rows.length) {
    return {
      quantidadePercentual: 0, pesoPercentual: 0, valorPercentual: 0,
      validadeDias: 0, origem: 'PADRAO_ZERO',
    };
  }
  const t = rows[0];
  return {
    quantidadePercentual: num(t.quantidade_percentual),
    pesoPercentual: num(t.peso_percentual),
    valorPercentual: num(t.valor_percentual),
    validadeDias: Number(t.validade_dias ?? 0),
    origem: t.escopo,
  };
}

// ---------------------------------------------------------------------------
// Numeracao e historico
// ---------------------------------------------------------------------------

export async function proximoNumero(
  cliente: Cliente, tabela: string, chaveConfig: string, padrao: string,
) {
  const { rows: cfg } = await cliente.query(
    'SELECT valor FROM configuracoes WHERE chave = $1', [chaveConfig]);
  const prefixo = cfg[0]?.valor ?? padrao;
  const ano = new Date().getUTCFullYear();
  const { rows } = await cliente.query(`
    SELECT coalesce(max(nullif(regexp_replace(numero, '^.*-', ''), '')::bigint), 0) + 1 AS proximo
      FROM ${tabela} WHERE numero LIKE $1`, [`${prefixo}-${ano}-%`]);
  return `${prefixo}-${ano}-${String(rows[0].proximo).padStart(6, '0')}`;
}

/** O recebimento reaproveita o historico do pedido quando ha pedido. */
export async function registrarHistorico(
  cliente: Cliente, pedidoId: number | null, evento: string,
  usuarioId: number | null, descricao: string, detalhes?: unknown,
) {
  if (!pedidoId) return;
  await cliente.query(`
    INSERT INTO pedido_historico
      (ordem_compra_id, evento, status_anterior, status_novo, descricao, detalhes, usuario_id)
    VALUES ($1, $2, NULL, NULL, $3, $4::jsonb, $5)`,
    [pedidoId, evento, descricao, JSON.stringify(detalhes ?? {}), usuarioId]);
}

// ---------------------------------------------------------------------------
// Criacao (secao 7)
// ---------------------------------------------------------------------------

/**
 * Cria o recebimento. O caminho preferido e entrega -> recebimento, porque a
 * entrega ja diz o que chegou; a partir do pedido, o recebimento nasce com o
 * saldo ainda nao recebido.
 */
export async function criarRecebimento(
  entrada: z.output<typeof criarRecebimentoSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    let pedidoId = entrada.ordem_compra_id ?? null;
    let fornecedorId = entrada.fornecedor_id ?? null;
    let entregaId = entrada.entrega_id ?? null;
    let localId = entrada.local_id ?? null;
    let notaFiscal = entrada.numero_nota_fiscal ?? null;
    let chaveNfe = entrada.chave_nfe ?? null;

    interface ItemBase {
      ordem_compra_item_id: number | null;
      entrega_item_id: number | null;
      produto_id: number;
      quantidade_pedida: number;
      preco_unitario: number;
      unidade_id: number | null;
      fator_conversao: number;
    }
    let itens: ItemBase[] = [];

    if (entregaId) {
      const { rows: ent } = await cliente.query(`
        SELECT e.*, oc.fornecedor_id, oc.id AS pedido_id
          FROM entregas e
          JOIN ordens_compra oc ON oc.id = e.ordem_compra_id
         WHERE e.id = $1 FOR UPDATE OF e`, [entregaId]);
      if (!ent.length) throw naoEncontrado('Entrega');
      const e = ent[0];

      if (e.recebimento_id) {
        throw conflito(
          `A entrega ${e.numero ?? entregaId} ja tem recebimento registrado. `
          + 'Abra o recebimento existente em vez de criar outro');
      }

      pedidoId = Number(e.pedido_id);
      fornecedorId = Number(e.fornecedor_id);
      localId = localId ?? (e.local_id !== null ? Number(e.local_id) : null);
      notaFiscal = notaFiscal ?? e.numero_nota_fiscal;
      chaveNfe = chaveNfe ?? e.chave_nfe;

      const { rows: itensEntrega } = await cliente.query(`
        SELECT ei.id AS entrega_item_id, ei.ordem_compra_item_id, ei.produto_id,
               ei.quantidade, oci.preco_unitario, oci.unidade_id,
               coalesce(p.fator_conversao, 1) AS fator_conversao
          FROM entrega_itens ei
          JOIN ordem_compra_itens oci ON oci.id = ei.ordem_compra_item_id
          JOIN produtos p ON p.id = ei.produto_id
         WHERE ei.entrega_id = $1`, [entregaId]);
      if (!itensEntrega.length) throw regraNegocio('Entrega sem itens para conferir');

      itens = itensEntrega.map((i) => ({
        ordem_compra_item_id: Number(i.ordem_compra_item_id),
        entrega_item_id: Number(i.entrega_item_id),
        produto_id: Number(i.produto_id),
        quantidade_pedida: num(i.quantidade),
        preco_unitario: num(i.preco_unitario),
        unidade_id: i.unidade_id !== null ? Number(i.unidade_id) : null,
        fator_conversao: num(i.fator_conversao) || 1,
      }));
    } else if (pedidoId) {
      const { rows: oc } = await cliente.query(
        'SELECT * FROM ordens_compra WHERE id = $1', [pedidoId]);
      if (!oc.length) throw naoEncontrado('Pedido de compra');
      if (['CANCELADA', 'REJEITADA'].includes(oc[0].status)) {
        throw regraNegocio(`PEDIDO ${oc[0].status}. Nao e possivel receber contra este pedido`);
      }
      fornecedorId = Number(oc[0].fornecedor_id);
      localId = localId ?? (oc[0].local_entrega_id !== null ? Number(oc[0].local_entrega_id) : null);

      // Saldo ainda nao recebido: e isso que se espera conferir.
      const { rows: pendentes } = await cliente.query(`
        SELECT oci.id, oci.produto_id, oci.preco_unitario, oci.unidade_id,
               coalesce(p.fator_conversao, 1) AS fator_conversao,
               greatest(oci.quantidade_pedida - oci.quantidade_recebida, 0) AS saldo
          FROM ordem_compra_itens oci
          JOIN produtos p ON p.id = oci.produto_id
         WHERE oci.ordem_compra_id = $1
           AND greatest(oci.quantidade_pedida - oci.quantidade_recebida, 0) > 0`, [pedidoId]);
      if (!pendentes.length) throw regraNegocio('Pedido sem saldo pendente de recebimento');

      itens = pendentes.map((i) => ({
        ordem_compra_item_id: Number(i.id),
        entrega_item_id: null,
        produto_id: Number(i.produto_id),
        quantidade_pedida: num(i.saldo),
        preco_unitario: num(i.preco_unitario),
        unidade_id: i.unidade_id !== null ? Number(i.unidade_id) : null,
        fator_conversao: num(i.fator_conversao) || 1,
      }));
    } else {
      // Recebimento manual autorizado (secao 7).
      const { rows: forn } = await cliente.query(
        'SELECT id FROM fornecedores WHERE id = $1 AND ativo AND deleted_at IS NULL',
        [fornecedorId]);
      if (!forn.length) throw regraNegocio('Fornecedor inexistente ou inativo');

      itens = (entrada.itens ?? []).map((i) => ({
        ordem_compra_item_id: i.ordem_compra_item_id ?? null,
        entrega_item_id: i.entrega_item_id ?? null,
        produto_id: i.produto_id,
        quantidade_pedida: i.quantidade_pedida ?? 0,
        preco_unitario: i.preco_unitario ?? 0,
        unidade_id: null,
        fator_conversao: 1,
      }));
    }

    if (!localId) {
      const { rows: local } = await cliente.query(
        'SELECT id FROM locais WHERE ativo ORDER BY id LIMIT 1');
      localId = local.length ? Number(local[0].id) : null;
    }

    const numero = await proximoNumero(
      cliente, 'recebimentos', 'recebimento.prefixo_numero', 'REC');

    const { rows: criado } = await cliente.query(`
      INSERT INTO recebimentos
        (numero, ordem_compra_id, entrega_id, fornecedor_id, local_id, origem,
         data_prevista, data_recebimento, numero_nota_fiscal, serie_nota_fiscal,
         chave_nfe, valor_nota, volumes, transportadora, placa, motorista, doca,
         tipo_operacao, status, observacao, responsavel_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7::date,CURRENT_DATE,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
              'AGUARDANDO_CHEGADA'::status_recebimento_enum,$18,$19,$19)
      RETURNING *`,
      [numero, pedidoId, entregaId, fornecedorId, localId, entrada.origem,
        entrada.data_prevista ?? null, notaFiscal, entrada.serie_nota_fiscal ?? null,
        chaveNfe, entrada.valor_nota ?? null, entrada.volumes ?? null,
        entrada.transportadora ?? null, entrada.placa ?? null, entrada.motorista ?? null,
        entrada.doca ?? null, entrada.tipo_operacao, entrada.observacao ?? null,
        contexto.usuarioId ?? null]);
    const recebimento = criado[0];

    for (const i of itens) {
      await cliente.query(`
        INSERT INTO recebimento_itens
          (recebimento_id, ordem_compra_item_id, entrega_item_id, produto_id,
           quantidade_pedida, quantidade_recebida, quantidade_aceita, quantidade_rejeitada,
           preco_unitario, unidade_id, fator_conversao, status)
        VALUES ($1,$2,$3,$4,$5,0,0,0,$6,$7,$8,'PENDENTE'::status_recebimento_item_enum)`,
        [recebimento.id, i.ordem_compra_item_id, i.entrega_item_id, i.produto_id,
          i.quantidade_pedida, i.preco_unitario, i.unidade_id, i.fator_conversao]);
    }

    if (entregaId) {
      await cliente.query('UPDATE entregas SET recebimento_id = $2 WHERE id = $1',
        [entregaId, recebimento.id]);
    }

    await registrarHistorico(cliente, pedidoId, 'RECEBIMENTO_CRIADO',
      contexto.usuarioId ?? null, `Recebimento ${numero} aberto com ${itens.length} item(ns)`,
      { recebimento_id: Number(recebimento.id), numero, origem: entrada.origem });

    return { ...recebimento, itens: itens.length };
  });
}

export async function editarRecebimento(
  recebimentoId: number, entrada: z.output<typeof editarRecebimentoSchema>,
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM recebimentos WHERE id = $1 FOR UPDATE', [recebimentoId]);
    if (!rows.length) throw naoEncontrado('Recebimento');
    if (ENCERRADOS.includes(rows[0].status)) {
      throw regraNegocio(
        `Recebimento em ${rows[0].status} nao pode ser alterado. `
        + 'Correcoes em recebimento efetivado passam por processo controlado');
    }

    const { rows: atualizado } = await cliente.query(`
      UPDATE recebimentos
         SET numero_nota_fiscal = coalesce($2, numero_nota_fiscal),
             serie_nota_fiscal = coalesce($3, serie_nota_fiscal),
             chave_nfe = coalesce($4, chave_nfe),
             valor_nota = coalesce($5, valor_nota),
             volumes = coalesce($6, volumes),
             transportadora = coalesce($7, transportadora),
             placa = coalesce($8, placa),
             motorista = coalesce($9, motorista),
             doca = coalesce($10, doca),
             local_id = coalesce($11, local_id),
             observacao = coalesce($12, observacao),
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [recebimentoId, entrada.numero_nota_fiscal ?? null, entrada.serie_nota_fiscal ?? null,
        entrada.chave_nfe ?? null, entrada.valor_nota ?? null, entrada.volumes ?? null,
        entrada.transportadora ?? null, entrada.placa ?? null, entrada.motorista ?? null,
        entrada.doca ?? null, entrada.local_id ?? null, entrada.observacao ?? null]);

    return atualizado[0];
  });
}

// ---------------------------------------------------------------------------
// Chegada (secao 64)
// ---------------------------------------------------------------------------

export async function registrarChegada(
  recebimentoId: number, entrada: z.output<typeof chegadaSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM recebimentos WHERE id = $1 FOR UPDATE', [recebimentoId]);
    if (!rows.length) throw naoEncontrado('Recebimento');
    const r = rows[0];

    if (r.status !== 'AGUARDANDO_CHEGADA') {
      throw regraNegocio(`Recebimento em ${r.status} ja teve a chegada registrada`);
    }

    const { rows: atualizado } = await cliente.query(`
      UPDATE recebimentos
         SET status = 'CHEGOU'::status_recebimento_enum,
             data_chegada = coalesce($2::timestamptz, now()),
             data_recebimento = coalesce($2::timestamptz, now())::date,
             transportadora = coalesce($3, transportadora),
             placa = coalesce($4, placa),
             motorista = coalesce($5, motorista),
             doca = coalesce($6, doca),
             volumes = coalesce($7, volumes),
             observacao = coalesce($8, observacao),
             responsavel_id = coalesce(responsavel_id, $9),
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [recebimentoId, entrada.data_chegada ?? null, entrada.transportadora ?? null,
        entrada.placa ?? null, entrada.motorista ?? null, entrada.doca ?? null,
        entrada.volumes ?? null, entrada.observacao ?? null, contexto.usuarioId ?? null]);

    await registrarHistorico(cliente, r.ordem_compra_id, 'RECEBIMENTO_CHEGADA',
      contexto.usuarioId ?? null, `Mercadoria do recebimento ${r.numero} chegou`,
      { doca: entrada.doca, placa: entrada.placa });

    return atualizado[0];
  });
}

// ---------------------------------------------------------------------------
// Conferencia documental (secao 9)
// ---------------------------------------------------------------------------

export async function conferirDocumentos(
  recebimentoId: number, entrada: z.output<typeof conferenciaDocumentosSchema>,
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM recebimentos WHERE id = $1 FOR UPDATE', [recebimentoId]);
    if (!rows.length) throw naoEncontrado('Recebimento');
    const r = rows[0];
    if (ENCERRADOS.includes(r.status)) {
      throw regraNegocio(`Recebimento em ${r.status} nao aceita conferencia`);
    }

    for (const i of entrada.itens) {
      await cliente.query(`
        INSERT INTO recebimento_documentos
          (recebimento_id, item, descricao, resposta, observacao, conferido_por)
        VALUES ($1,$2,$3,$4::resposta_checklist_enum,$5,$6)
        ON CONFLICT (recebimento_id, item) DO UPDATE
          SET resposta = EXCLUDED.resposta, observacao = EXCLUDED.observacao,
              conferido_por = EXCLUDED.conferido_por, conferido_em = now()`,
        [recebimentoId, i.item, i.descricao ?? null, i.resposta,
          i.observacao ?? null, contexto.usuarioId ?? null]);
    }

    const reprovados = entrada.itens.filter((i) => i.resposta === 'REPROVADO');

    // Documento reprovado vira divergencia: a secao 26 lista documentacao e NF
    // divergentes como tipos proprios.
    for (const i of reprovados) {
      await cliente.query(`
        INSERT INTO recebimento_divergencias
          (recebimento_id, tipo, severidade, descricao, valor_esperado, valor_recebido,
           detectada_por)
        VALUES ($1,'DOCUMENTACAO_DIVERGENTE'::tipo_divergencia_enum,
                'MEDIA'::severidade_nc_enum,$2,'CONFORME','REPROVADO',$3)`,
        [recebimentoId, `Conferencia documental reprovou: ${i.item}`
          + (i.observacao ? ` - ${i.observacao}` : ''), contexto.usuarioId ?? null]);
    }

    const { rows: atualizado } = await cliente.query(`
      UPDATE recebimentos
         SET documentos_conferidos = $2,
             status = CASE WHEN status = 'CHEGOU'
                           THEN 'EM_CONFERENCIA'::status_recebimento_enum ELSE status END,
             conferencia_inicio = coalesce(conferencia_inicio, now()),
             updated_at = now()
       WHERE id = $1 RETURNING *`, [recebimentoId, reprovados.length === 0]);

    await registrarHistorico(cliente, r.ordem_compra_id, 'CONFERENCIA_DOCUMENTAL',
      contexto.usuarioId ?? null,
      reprovados.length
        ? `Conferencia documental com ${reprovados.length} item(ns) reprovado(s)`
        : 'Conferencia documental concluida sem ressalvas',
      { reprovados: reprovados.map((i) => i.item) });

    return {
      ...atualizado[0],
      reprovados: reprovados.map((i) => i.item),
      divergencias_geradas: reprovados.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Conferencia fisica (secoes 10 a 16)
// ---------------------------------------------------------------------------

interface ContextoItem {
  produtoId: number;
  controlaLote: boolean;
  controlaValidade: boolean;
  diasValidade: number | null;
  minimoVidaUtil: number | null;
  categoriaId: number | null;
  fornecedorId: number | null;
  tipoOperacao: string | null;
}

async function avaliarItem(
  cliente: Cliente, item: any, entrada: z.output<typeof conferirItemSchema>,
  ctx: ContextoItem, cfg: Record<string, string>, hoje: string,
): Promise<{
  quantidade: ConferenciaQuantidade;
  validade: AvaliacaoValidade;
  tolerancia: Tolerancia;
  divergencias: Array<{ tipo: string; severidade: string; descricao: string;
    esperado: string; recebido: string; diferenca: number | null;
    percentual: number | null; toleranciaAplicada: number; dentro: boolean }>;
}> {
  const tolerancia = await resolverTolerancia(
    ctx.produtoId, ctx.fornecedorId, ctx.categoriaId, ctx.tipoOperacao);

  const quantidade = conferirQuantidade(
    num(item.quantidade_pedida), entrada.quantidade_recebida,
    tolerancia.quantidadePercentual);

  const validade = avaliarValidade({
    controlaValidade: ctx.controlaValidade,
    dataValidade: entrada.data_validade ?? null,
    dataFabricacao: entrada.data_fabricacao ?? null,
    diasValidadeProduto: ctx.diasValidade,
    minimoPercentual: ctx.minimoVidaUtil,
    limiares: {
      proximaPercentual: numeroConfig(cfg, 'recebimento.validade_proxima_percentual', 90),
      criticaPercentual: numeroConfig(cfg, 'recebimento.validade_critica_percentual', 85),
    },
    hoje,
  });

  const divergencias: Array<any> = [];

  if (quantidade.situacao !== 'EXATA' && !quantidade.dentroTolerancia) {
    divergencias.push({
      tipo: quantidade.situacao === 'FALTA' ? 'QUANTIDADE_MENOR' : 'QUANTIDADE_MAIOR',
      severidade: quantidade.situacao === 'SOBRA' ? 'MEDIA' : 'ALTA',
      descricao: quantidade.situacao === 'FALTA'
        ? `Faltaram ${quantidade.faltante} de ${quantidade.pedida} pedidos`
        : `Chegaram ${quantidade.diferenca} a mais que os ${quantidade.pedida} pedidos`,
      esperado: String(quantidade.pedida),
      recebido: String(quantidade.recebida),
      diferenca: quantidade.diferenca,
      percentual: quantidade.diferencaPercentual,
      toleranciaAplicada: tolerancia.quantidadePercentual,
      dentro: false,
    });
  }

  if (ctx.controlaLote && !entrada.numero_lote) {
    divergencias.push({
      tipo: 'LOTE_AUSENTE', severidade: 'ALTA',
      descricao: 'Produto controlado por lote recebido sem numero de lote',
      esperado: 'Lote informado', recebido: 'Sem lote',
      diferenca: null, percentual: null, toleranciaAplicada: 0, dentro: false,
    });
  }

  if (validade.situacao === 'VENCIDO') {
    divergencias.push({
      tipo: 'PRODUTO_VENCIDO', severidade: 'CRITICA',
      descricao: `Produto vencido em ${entrada.data_validade}`,
      esperado: `Validade futura`, recebido: String(entrada.data_validade),
      diferenca: validade.diasRestantes, percentual: null,
      toleranciaAplicada: tolerancia.validadeDias, dentro: false,
    });
  } else if (validade.situacao === 'INSUFICIENTE') {
    divergencias.push({
      tipo: 'VALIDADE_DIVERGENTE', severidade: 'ALTA',
      descricao: `Vida util de ${validade.vidaUtilRestantePercentual?.toFixed(2)}% `
        + `abaixo do minimo de ${validade.minimoExigidoPercentual}%`,
      esperado: `>= ${validade.minimoExigidoPercentual}% de vida util`,
      recebido: `${validade.vidaUtilRestantePercentual?.toFixed(2)}%`,
      diferenca: validade.diasRestantes, percentual: validade.vidaUtilRestantePercentual,
      toleranciaAplicada: tolerancia.validadeDias, dentro: false,
    });
  }

  if (entrada.preco_unitario !== undefined && num(item.preco_unitario) > 0) {
    const esperado = num(item.preco_unitario);
    const diferenca = entrada.preco_unitario - esperado;
    const percentual = (Math.abs(diferenca) / esperado) * 100;
    if (percentual > tolerancia.valorPercentual + 1e-9) {
      divergencias.push({
        tipo: 'PRECO_DIVERGENTE', severidade: 'MEDIA',
        descricao: `Preco de ${entrada.preco_unitario} difere do pedido (${esperado})`,
        esperado: String(esperado), recebido: String(entrada.preco_unitario),
        diferenca, percentual,
        toleranciaAplicada: tolerancia.valorPercentual, dentro: false,
      });
    }
  }

  return { quantidade, validade, tolerancia, divergencias };
}

/** Confere um item: quantidade, lote, validade e destino provisorio. */
export async function conferirItem(
  recebimentoItemId: number, entrada: z.output<typeof conferirItemSchema>,
  contexto: ContextoSessao,
) {
  const cfg = await configuracoes();
  const hoje = hojeLocal();

  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(`
      SELECT ri.*, r.status AS status_recebimento, r.ordem_compra_id, r.fornecedor_id,
             r.numero AS recebimento_numero, r.tipo_operacao, r.local_id AS local_recebimento,
             p.codigo, p.descricao, p.controla_lote, p.controla_validade, p.dias_validade,
             p.categoria_id, p.vida_util_minima_percentual AS minimo_produto,
             pf.vida_util_minima_percentual AS minimo_fornecedor
        FROM recebimento_itens ri
        JOIN recebimentos r ON r.id = ri.recebimento_id
        JOIN produtos p ON p.id = ri.produto_id
        LEFT JOIN produto_fornecedor pf
               ON pf.produto_id = ri.produto_id AND pf.fornecedor_id = r.fornecedor_id
       WHERE ri.id = $1 FOR UPDATE OF ri`, [recebimentoItemId]);
    if (!rows.length) throw naoEncontrado('Item do recebimento');
    const item = rows[0];

    if (ENCERRADOS.includes(item.status_recebimento)) {
      throw regraNegocio(
        `Recebimento em ${item.status_recebimento} nao aceita nova conferencia`);
    }
    if (item.status_recebimento === 'AGUARDANDO_CHEGADA') {
      throw regraNegocio('Registre a chegada da mercadoria antes de conferir');
    }

    const minimo = item.minimo_fornecedor ?? item.minimo_produto
      ?? (item.controla_validade
        ? numeroConfig(cfg, 'recebimento.vida_util_minima_percentual', 80) : null);

    const avaliacao = await avaliarItem(cliente, item, entrada, {
      produtoId: Number(item.produto_id),
      controlaLote: item.controla_lote,
      controlaValidade: item.controla_validade,
      diasValidade: item.dias_validade !== null ? Number(item.dias_validade) : null,
      minimoVidaUtil: minimo !== null ? Number(minimo) : null,
      categoriaId: item.categoria_id !== null ? Number(item.categoria_id) : null,
      fornecedorId: Number(item.fornecedor_id),
      tipoOperacao: item.tipo_operacao,
    }, cfg, hoje);

    // Destino previsto ja na conferencia: a tela do conferente precisa mostrar
    // para onde o material vai antes da aprovacao. A qualidade ainda nao opinou,
    // entao a aprovacao recalcula o destino com o laudo em maos.
    const destinoPrevisto = decidirDestino({
      quantidadeRecebida: entrada.quantidade_recebida,
      resultadoQualidade: null,
      quantidadeAprovadaQualidade: null,
      quantidadeReprovadaQualidade: null,
      quantidadeQuarentenaQualidade: null,
      validade: avaliacao.validade,
      exigeLote: item.controla_lote,
      loteInformado: Boolean(entrada.numero_lote ?? item.numero_lote),
      destinoPadrao: 'DISPONIVEL',
      excecaoValidadeAutorizada: false,
    }).destino;

    const { rows: atualizado } = await cliente.query(`
      UPDATE recebimento_itens
         SET quantidade_recebida = $2::numeric,
             -- Os dois casts sao obrigatorios: coalesce so de parametros sem
             -- tipo e resolvido como text pelo Postgres antes de olhar a coluna.
             quantidade_conferida = coalesce($3::numeric, $2::numeric),
             numero_lote = coalesce($4, numero_lote),
             data_fabricacao = coalesce($5::date, data_fabricacao),
             data_validade = coalesce($6::date, data_validade),
             vida_util_dias = $7,
             vida_util_restante_percentual = $8,
             situacao_validade = $9::situacao_validade_enum,
             destino = $16::destino_recebimento_enum,
             local_id = coalesce($10, local_id, $11),
             localizacao = coalesce($12, localizacao),
             preco_unitario = coalesce($13, preco_unitario),
             observacao = coalesce($14, observacao),
             conferido_por = $15,
             conferido_em = now(),
             status = 'PENDENTE'::status_recebimento_item_enum,
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [recebimentoItemId, entrada.quantidade_recebida, entrada.quantidade_conferida ?? null,
        entrada.numero_lote ?? null, entrada.data_fabricacao ?? null,
        entrada.data_validade ?? null,
        avaliacao.validade.vidaUtilTotalDias, avaliacao.validade.vidaUtilRestantePercentual,
        avaliacao.validade.situacao,
        entrada.local_id ?? null, item.local_recebimento, entrada.localizacao ?? null,
        entrada.preco_unitario ?? null, entrada.observacao ?? null,
        contexto.usuarioId ?? null, destinoPrevisto]);

    // Divergencias novas desta conferencia. As antigas do mesmo item sao
    // canceladas: reconferir corrige a leitura, mas o registro anterior nao
    // se apaga - ele fica com decisao RECUSAR e justificativa.
    await cliente.query(`
      UPDATE recebimento_divergencias
         SET decisao = 'RECUSAR'::decisao_divergencia_enum,
             justificativa = coalesce(justificativa, 'Substituida por nova conferencia do item'),
             decidido_em = now(), decidido_por = $2
       WHERE recebimento_item_id = $1 AND decisao = 'PENDENTE'`,
      [recebimentoItemId, contexto.usuarioId ?? null]);

    const criadas: any[] = [];
    for (const d of avaliacao.divergencias) {
      const { rows: div } = await cliente.query(`
        INSERT INTO recebimento_divergencias
          (recebimento_id, recebimento_item_id, produto_id, tipo, severidade, descricao,
           valor_esperado, valor_recebido, diferenca, diferenca_percentual,
           tolerancia_aplicada, dentro_tolerancia, detectada_por)
        VALUES ($1,$2,$3,$4::tipo_divergencia_enum,$5::severidade_nc_enum,$6,$7,$8,$9,$10,
                $11,$12,$13)
        RETURNING *`,
        [item.recebimento_id, recebimentoItemId, item.produto_id, d.tipo, d.severidade,
          d.descricao, d.esperado, d.recebido, d.diferenca, d.percentual,
          d.toleranciaAplicada, d.dentro, contexto.usuarioId ?? null]);
      criadas.push(div[0]);
    }

    await cliente.query(`
      UPDATE recebimentos
         SET status = CASE WHEN status IN ('CHEGOU', 'AGUARDANDO_CHEGADA')
                           THEN 'EM_CONFERENCIA'::status_recebimento_enum ELSE status END,
             conferencia_inicio = coalesce(conferencia_inicio, now()),
             updated_at = now()
       WHERE id = $1`, [item.recebimento_id]);

    return {
      item: atualizado[0],
      produto: { codigo: item.codigo, descricao: item.descricao },
      quantidade: avaliacao.quantidade,
      validade: avaliacao.validade,
      tolerancia: avaliacao.tolerancia,
      divergencias: criadas,
      semaforo: semaforoItem({
        conferido: true,
        quantidade: avaliacao.quantidade,
        validade: avaliacao.validade,
        exigeLote: item.controla_lote,
        loteInformado: Boolean(entrada.numero_lote ?? atualizado[0].numero_lote),
        resultadoQualidade: null,
      }),
    };
  });
}

/** Confere varios itens de uma vez, como a tela de conferencia faz. */
export async function conferirLote(
  recebimentoId: number, entrada: z.output<typeof conferenciaLoteSchema>,
  contexto: ContextoSessao,
) {
  const resultados = [];
  for (const i of entrada.itens) {
    const { recebimento_item_id, ...dados } = i;
    resultados.push(await conferirItem(recebimento_item_id, dados, contexto));
  }
  return {
    recebimento_id: recebimentoId,
    conferidos: resultados.length,
    divergencias: resultados.reduce((a, r) => a + r.divergencias.length, 0),
    itens: resultados,
  };
}

/** Encerra a conferencia e manda para a qualidade quando ha o que inspecionar. */
export async function concluirConferencia(recebimentoId: number, contexto: ContextoSessao) {
  const cfg = await configuracoes();

  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM recebimentos WHERE id = $1 FOR UPDATE', [recebimentoId]);
    if (!rows.length) throw naoEncontrado('Recebimento');
    const r = rows[0];
    if (ENCERRADOS.includes(r.status)) {
      throw regraNegocio(`Recebimento em ${r.status} ja foi encerrado`);
    }

    const { rows: pendentes } = await cliente.query(`
      SELECT p.codigo FROM recebimento_itens ri
      JOIN produtos p ON p.id = ri.produto_id
       WHERE ri.recebimento_id = $1 AND ri.conferido_em IS NULL`, [recebimentoId]);
    if (pendentes.length && booleanoConfig(cfg, 'recebimento.exigir_conferencia', true)) {
      throw regraNegocio(
        `Nao e possivel concluir a conferencia: ${pendentes.length} item(ns) sem conferir `
        + `(${pendentes.slice(0, 5).map((p) => p.codigo).join(', ')})`);
    }

    const { rows: exigeQualidade } = await cliente.query(`
      SELECT count(*)::int AS n FROM recebimento_itens ri
      JOIN produtos p ON p.id = ri.produto_id
       WHERE ri.recebimento_id = $1
         AND (p.exige_inspecao OR p.checklist_qualidade_id IS NOT NULL
              OR ri.situacao_validade IN ('CRITICA','INSUFICIENTE','VENCIDO'))`,
      [recebimentoId]);

    const proximo = Number(exigeQualidade[0].n) > 0 ? 'AGUARDANDO_QUALIDADE' : 'EM_CONFERENCIA';

    const { rows: atualizado } = await cliente.query(`
      UPDATE recebimentos
         SET conferencia_fim = now(),
             status = $2::status_recebimento_enum,
             updated_at = now()
       WHERE id = $1 RETURNING *`, [recebimentoId, proximo]);

    await registrarHistorico(cliente, r.ordem_compra_id, 'CONFERENCIA_CONCLUIDA',
      contexto.usuarioId ?? null,
      `Conferencia do recebimento ${r.numero} concluida`,
      { exige_qualidade: Number(exigeQualidade[0].n) > 0 });

    return {
      ...atualizado[0],
      exige_qualidade: Number(exigeQualidade[0].n) > 0,
      itens_sem_conferir: pendentes.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Conferencia por codigo de barras (secao 11)
// ---------------------------------------------------------------------------

/**
 * Localiza o item do recebimento a partir de um codigo lido. Nao grava nada:
 * devolve o que a tela precisa para mostrar o esperado e pedir lote e validade.
 */
export async function escanear(
  recebimentoId: number, entrada: z.output<typeof escanearSchema>,
) {
  const { rows } = await query(`
    SELECT ri.id AS recebimento_item_id, ri.quantidade_pedida, ri.quantidade_recebida,
           ri.numero_lote, ri.data_validade, ri.conferido_em,
           p.id AS produto_id, p.codigo, p.ean, p.descricao,
           p.controla_lote, p.controla_validade, p.dias_validade,
           un.codigo AS unidade, pf.codigo_produto_fornecedor
      FROM recebimento_itens ri
      JOIN recebimentos r ON r.id = ri.recebimento_id
      JOIN produtos p ON p.id = ri.produto_id
      LEFT JOIN unidades un ON un.id = coalesce(ri.unidade_id, p.unidade_compra_id)
      LEFT JOIN produto_fornecedor pf
             ON pf.produto_id = p.id AND pf.fornecedor_id = r.fornecedor_id
     WHERE ri.recebimento_id = $1
       AND (upper(p.codigo) = upper($2) OR p.ean = $2
            OR upper(coalesce(pf.codigo_produto_fornecedor, '')) = upper($2))`,
    [recebimentoId, entrada.codigo]);

  if (!rows.length) {
    throw naoEncontrado(
      `Nenhum item deste recebimento corresponde ao codigo ${entrada.codigo}`);
  }
  if (rows.length > 1) {
    throw conflito(
      `O codigo ${entrada.codigo} corresponde a ${rows.length} itens deste recebimento. `
      + 'Selecione o item manualmente');
  }

  const i = rows[0];
  return {
    recebimento_item_id: Number(i.recebimento_item_id),
    produto: {
      id: Number(i.produto_id), codigo: i.codigo, ean: i.ean,
      descricao: i.descricao, unidade: i.unidade,
      codigo_fornecedor: i.codigo_produto_fornecedor,
    },
    quantidade_esperada: num(i.quantidade_pedida),
    quantidade_ja_recebida: num(i.quantidade_recebida),
    quantidade_sugerida: entrada.quantidade ?? num(i.quantidade_pedida),
    ja_conferido: i.conferido_em !== null,
    exige_lote: i.controla_lote,
    exige_validade: i.controla_validade,
    lote_atual: i.numero_lote,
    validade_atual: dataIso(i.data_validade),
    proxima_acao: i.controla_lote && !i.numero_lote
      ? 'Informe o numero do lote'
      : i.controla_validade && !i.data_validade
        ? 'Informe a data de validade'
        : 'Confirme a quantidade recebida',
  };
}

// ---------------------------------------------------------------------------
// Divergencia manual (secao 26)
// ---------------------------------------------------------------------------

export async function registrarDivergencia(
  recebimentoId: number, entrada: z.output<typeof divergenciaSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT id, status, ordem_compra_id, numero FROM recebimentos WHERE id = $1',
      [recebimentoId]);
    if (!rows.length) throw naoEncontrado('Recebimento');

    let produtoId: number | null = null;
    if (entrada.recebimento_item_id) {
      const { rows: item } = await cliente.query(
        'SELECT produto_id FROM recebimento_itens WHERE id = $1 AND recebimento_id = $2',
        [entrada.recebimento_item_id, recebimentoId]);
      if (!item.length) throw regraNegocio('Item nao pertence a este recebimento');
      produtoId = Number(item[0].produto_id);
    }

    const { rows: criada } = await cliente.query(`
      INSERT INTO recebimento_divergencias
        (recebimento_id, recebimento_item_id, produto_id, tipo, severidade, descricao,
         valor_esperado, valor_recebido, detectada_por)
      VALUES ($1,$2,$3,$4::tipo_divergencia_enum,$5::severidade_nc_enum,$6,$7,$8,$9)
      RETURNING *`,
      [recebimentoId, entrada.recebimento_item_id ?? null, produtoId, entrada.tipo,
        entrada.severidade, entrada.descricao, entrada.valor_esperado ?? null,
        entrada.valor_recebido ?? null, contexto.usuarioId ?? null]);

    await registrarHistorico(cliente, rows[0].ordem_compra_id, 'DIVERGENCIA_REGISTRADA',
      contexto.usuarioId ?? null, `Divergencia ${entrada.tipo} no recebimento ${rows[0].numero}`,
      { tipo: entrada.tipo, severidade: entrada.severidade });

    return criada[0];
  });
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export async function listarRecebimentos(
  filtro: z.output<typeof listarRecebimentosSchema> & Paginacao,
) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const filtrar = (sql: string, valor: unknown) => {
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  if (filtro.status) filtrar('r.status = $?::status_recebimento_enum', filtro.status);
  if (filtro.fornecedor_id) filtrar('r.fornecedor_id = $?', filtro.fornecedor_id);
  if (filtro.ordem_compra_id) filtrar('r.ordem_compra_id = $?', filtro.ordem_compra_id);
  if (filtro.local_id) filtrar('r.local_id = $?', filtro.local_id);
  if (filtro.data_inicio) filtrar('r.data_recebimento >= $?', filtro.data_inicio);
  if (filtro.data_fim) filtrar('r.data_recebimento <= $?', filtro.data_fim);
  if (filtro.numero_nota_fiscal) filtrar('r.numero_nota_fiscal = $?', filtro.numero_nota_fiscal);
  if (filtro.apenas_hoje) cond.push('r.data_recebimento = CURRENT_DATE');
  if (filtro.apenas_pendentes) {
    cond.push("r.status IN ('AGUARDANDO_CHEGADA','CHEGOU','EM_CONFERENCIA','AGUARDANDO_QUALIDADE')");
  }
  if (filtro.apenas_quarentena) cond.push("r.status = 'QUARENTENA'");
  if (filtro.produto_id) {
    filtrar('EXISTS (SELECT 1 FROM recebimento_itens x WHERE x.recebimento_id = r.id AND x.produto_id = $?)',
      filtro.produto_id);
  }
  if (filtro.numero_lote) {
    filtrar(`EXISTS (SELECT 1 FROM recebimento_itens x
                      WHERE x.recebimento_id = r.id AND upper(x.numero_lote) = upper($?))`,
      filtro.numero_lote);
  }
  if (filtro.apenas_divergentes) {
    cond.push(`EXISTS (SELECT 1 FROM recebimento_divergencias d
                        WHERE d.recebimento_id = r.id)`);
  }
  if (filtro.apenas_validade_critica) {
    cond.push(`EXISTS (SELECT 1 FROM recebimento_itens x
                        WHERE x.recebimento_id = r.id
                          AND x.situacao_validade IN ('CRITICA','INSUFICIENTE','VENCIDO'))`);
  }
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(r.numero ILIKE $${valores.length} OR r.numero_nota_fiscal ILIKE $${valores.length}`
      + ` OR f.razao_social ILIKE $${valores.length} OR oc.numero ILIKE $${valores.length})`);
  }

  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = await query<{ total: number }>(`
    SELECT count(*)::int AS total FROM recebimentos r
    JOIN fornecedores f ON f.id = r.fornecedor_id
    LEFT JOIN ordens_compra oc ON oc.id = r.ordem_compra_id ${onde}`, valores);

  const { rows } = await query(`
    SELECT r.*, f.razao_social AS fornecedor, oc.numero AS pedido, l.nome AS local,
           u.nome AS responsavel, a.nome AS aprovador, e.numero AS entrega,
           (SELECT count(*)::int FROM recebimento_itens x WHERE x.recebimento_id = r.id) AS itens,
           (SELECT count(*)::int FROM recebimento_itens x
             WHERE x.recebimento_id = r.id AND x.conferido_em IS NOT NULL) AS itens_conferidos,
           (SELECT count(*)::int FROM recebimento_divergencias d
             WHERE d.recebimento_id = r.id) AS divergencias,
           (SELECT count(*)::int FROM recebimento_divergencias d
             WHERE d.recebimento_id = r.id AND d.decisao = 'PENDENTE') AS divergencias_pendentes,
           (SELECT min(x.situacao_validade::text) FROM recebimento_itens x
             WHERE x.recebimento_id = r.id
               AND x.situacao_validade IN ('CRITICA','INSUFICIENTE','VENCIDO')) AS validade_critica
      FROM recebimentos r
      JOIN fornecedores f ON f.id = r.fornecedor_id
      LEFT JOIN ordens_compra oc ON oc.id = r.ordem_compra_id
      LEFT JOIN entregas e ON e.id = r.entrega_id
      LEFT JOIN locais l ON l.id = r.local_id
      LEFT JOIN usuarios u ON u.id = r.responsavel_id
      LEFT JOIN usuarios a ON a.id = r.aprovador_id
      ${onde}
     ORDER BY r.data_recebimento DESC NULLS LAST, r.id DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return { dados: rows, meta: metaPaginacao(Number(total.rows[0]?.total ?? 0), filtro) };
}

/** Detalhe completo: e o que a tela de conferencia carrega. */
export async function detalharRecebimento(recebimentoId: number) {
  const cfg = await configuracoes();
  const hoje = hojeLocal();

  const { rows } = await query(`
    SELECT r.*, f.razao_social AS fornecedor, f.cnpj, f.email AS fornecedor_email,
           f.origem_fornecedor, oc.numero AS pedido, oc.valor_total AS pedido_valor,
           e.numero AS entrega, l.nome AS local, u.nome AS responsavel,
           a.nome AS aprovador, c.nome AS criado_por
      FROM recebimentos r
      JOIN fornecedores f ON f.id = r.fornecedor_id
      LEFT JOIN ordens_compra oc ON oc.id = r.ordem_compra_id
      LEFT JOIN entregas e ON e.id = r.entrega_id
      LEFT JOIN locais l ON l.id = r.local_id
      LEFT JOIN usuarios u ON u.id = r.responsavel_id
      LEFT JOIN usuarios a ON a.id = r.aprovador_id
      LEFT JOIN usuarios c ON c.id = r.created_by
     WHERE r.id = $1`, [recebimentoId]);
  if (!rows.length) throw naoEncontrado('Recebimento');
  const r = rows[0];

  const [itens, divergencias, documentos, inspecoes, quarentenas, ncs, aprovacoes, anexos] =
    await Promise.all([
      query(`
        SELECT ri.*, p.codigo, p.ean, p.descricao, p.controla_lote, p.controla_validade,
               p.dias_validade, p.classificacao_abc,
               un.codigo AS unidade, l.nome AS local, lt.numero_lote AS lote_gerado,
               cu.nome AS conferido_por_nome,
               coalesce(pf.vida_util_minima_percentual, p.vida_util_minima_percentual)
                 AS minimo_vida_util,
               (SELECT iq.resultado FROM inspecoes_qualidade iq
                 WHERE iq.recebimento_item_id = ri.id
                 ORDER BY iq.data_inspecao DESC LIMIT 1) AS resultado_qualidade,
               (SELECT count(*)::int FROM recebimento_divergencias d
                 WHERE d.recebimento_item_id = ri.id) AS divergencias
          FROM recebimento_itens ri
          JOIN produtos p ON p.id = ri.produto_id
          LEFT JOIN unidades un ON un.id = coalesce(ri.unidade_id, p.unidade_compra_id)
          LEFT JOIN locais l ON l.id = ri.local_id
          LEFT JOIN lotes lt ON lt.id = ri.lote_id
          LEFT JOIN usuarios cu ON cu.id = ri.conferido_por
          LEFT JOIN produto_fornecedor pf
                 ON pf.produto_id = ri.produto_id AND pf.fornecedor_id = $2
         WHERE ri.recebimento_id = $1 ORDER BY p.descricao`, [recebimentoId, r.fornecedor_id]),
      query(`
        SELECT d.*, p.codigo, p.descricao AS produto, u.nome AS detectada_por_nome,
               du.nome AS decidido_por_nome
          FROM recebimento_divergencias d
          LEFT JOIN produtos p ON p.id = d.produto_id
          LEFT JOIN usuarios u ON u.id = d.detectada_por
          LEFT JOIN usuarios du ON du.id = d.decidido_por
         WHERE d.recebimento_id = $1 ORDER BY d.detectada_em DESC`, [recebimentoId]),
      query(`
        SELECT dc.*, u.nome AS conferido_por_nome FROM recebimento_documentos dc
        LEFT JOIN usuarios u ON u.id = dc.conferido_por
         WHERE dc.recebimento_id = $1 ORDER BY dc.item`, [recebimentoId]),
      query(`
        SELECT iq.*, p.codigo, p.descricao AS produto, u.nome AS responsavel,
               cl.nome AS checklist,
               (SELECT json_agg(json_build_object('criterio', ii.criterio,
                        'resposta', ii.resposta, 'eliminatorio', ii.eliminatorio,
                        'observacao', ii.observacao) ORDER BY ii.id)
                  FROM inspecao_itens ii WHERE ii.inspecao_id = iq.id) AS respostas
          FROM inspecoes_qualidade iq
          LEFT JOIN produtos p ON p.id = iq.produto_id
          LEFT JOIN usuarios u ON u.id = iq.responsavel_id
          LEFT JOIN checklists_qualidade cl ON cl.id = iq.checklist_id
         WHERE iq.recebimento_id = $1 ORDER BY iq.data_inspecao DESC`, [recebimentoId]),
      query(`
        SELECT q.*, p.codigo, p.descricao AS produto, u.nome AS aberta_por_nome
          FROM quarentenas q
          JOIN produtos p ON p.id = q.produto_id
          LEFT JOIN usuarios u ON u.id = q.aberta_por
         WHERE q.recebimento_id = $1 ORDER BY q.aberta_em DESC`, [recebimentoId]),
      query(`
        SELECT nc.*, p.descricao AS produto, u.nome AS responsavel
          FROM nao_conformidades nc
          LEFT JOIN produtos p ON p.id = nc.produto_id
          LEFT JOIN usuarios u ON u.id = nc.responsavel_id
         WHERE nc.recebimento_id = $1 ORDER BY nc.created_at DESC`, [recebimentoId]),
      query(`
        SELECT ap.*, u.nome AS usuario FROM recebimento_aprovacoes ap
        LEFT JOIN usuarios u ON u.id = ap.usuario_id
         WHERE ap.recebimento_id = $1 ORDER BY ap.created_at`, [recebimentoId]),
      query(`
        SELECT an.*, u.nome AS usuario FROM recebimento_anexos an
        LEFT JOIN usuarios u ON u.id = an.usuario_id
         WHERE an.recebimento_id = $1 ORDER BY an.created_at DESC`, [recebimentoId]),
    ]);

  const limiares = {
    proximaPercentual: numeroConfig(cfg, 'recebimento.validade_proxima_percentual', 90),
    criticaPercentual: numeroConfig(cfg, 'recebimento.validade_critica_percentual', 85),
  };
  const minimoPadrao = numeroConfig(cfg, 'recebimento.vida_util_minima_percentual', 80);

  const itensAvaliados: Array<Record<string, any>> = await Promise.all(itens.rows.map(async (i) => {
    const tolerancia = await resolverTolerancia(
      Number(i.produto_id), Number(r.fornecedor_id), null, r.tipo_operacao);

    const conferido = i.conferido_em !== null;
    const quantidade = conferido
      ? conferirQuantidade(num(i.quantidade_pedida), num(i.quantidade_recebida),
        tolerancia.quantidadePercentual)
      : null;

    const validade = avaliarValidade({
      controlaValidade: i.controla_validade,
      dataValidade: dataIso(i.data_validade),
      dataFabricacao: dataIso(i.data_fabricacao),
      diasValidadeProduto: i.dias_validade !== null ? Number(i.dias_validade) : null,
      minimoPercentual: i.minimo_vida_util !== null
        ? Number(i.minimo_vida_util) : (i.controla_validade ? minimoPadrao : null),
      limiares,
      hoje,
    });

    return {
      ...i,
      data_fabricacao: dataIso(i.data_fabricacao),
      data_validade: dataIso(i.data_validade),
      tolerancia,
      quantidade,
      validade,
      semaforo: semaforoItem({
        conferido,
        quantidade,
        validade,
        exigeLote: i.controla_lote,
        loteInformado: Boolean(i.numero_lote),
        resultadoQualidade: i.resultado_qualidade,
      }),
    };
  }));

  const semaforoGeral = ['VERMELHO', 'AMARELO', 'CINZA', 'VERDE']
    .find((c) => itensAvaliados.some((i) => i.semaforo.geral === c)) ?? 'VERDE';

  const detalhe: Record<string, any> = {
    ...r,
    data_prevista: dataIso(r.data_prevista),
    data_recebimento: dataIso(r.data_recebimento),
    semaforo: semaforoGeral,
    resumo: {
      itens: itensAvaliados.length,
      conferidos: itensAvaliados.filter((i) => i.conferido_em !== null).length,
      divergencias: divergencias.rows.length,
      divergencias_pendentes: divergencias.rows.filter((d) => d.decisao === 'PENDENTE').length,
      quantidade_pedida: itensAvaliados.reduce((a, i) => a + num(i.quantidade_pedida), 0),
      quantidade_recebida: itensAvaliados.reduce((a, i) => a + num(i.quantidade_recebida), 0),
      sem_lote: itensAvaliados.filter((i) => i.controla_lote && !i.numero_lote).length,
      validade_insuficiente: itensAvaliados.filter(
        (i) => ['INSUFICIENTE', 'VENCIDO'].includes(i.validade.situacao)).length,
    },
    itens: itensAvaliados,
    divergencias: divergencias.rows,
    documentos: documentos.rows,
    inspecoes: inspecoes.rows,
    quarentenas: quarentenas.rows,
    nao_conformidades: ncs.rows,
    aprovacoes: aprovacoes.rows,
    anexos: anexos.rows,
  };
  return detalhe;
}

/** Rastreabilidade da secao 62. */
export async function rastrear(recebimentoId: number) {
  const { rows } = await query(
    'SELECT * FROM vw_rastreabilidade_recebimento WHERE recebimento_id = $1 ORDER BY produto',
    [recebimentoId]);
  if (!rows.length) throw naoEncontrado('Recebimento');

  const movimentacoes = await query(`
    SELECT m.*, p.codigo, p.descricao AS produto, l.numero_lote, loc.nome AS local,
           u.nome AS usuario
      FROM movimentacoes_estoque m
      JOIN produtos p ON p.id = m.produto_id
      LEFT JOIN lotes l ON l.id = m.lote_id
      LEFT JOIN locais loc ON loc.id = m.local_id
      LEFT JOIN usuarios u ON u.id = m.usuario_id
     WHERE m.documento_tipo IN ('RECEBIMENTO','QUARENTENA') AND m.documento_id = $1
     ORDER BY m.created_at`, [recebimentoId]);

  return {
    recebimento_id: recebimentoId,
    cadeia: rows.map((l) => ({
      ...l,
      data_recebimento: dataIso(l.data_recebimento),
      data_validade: dataIso(l.data_validade),
    })),
    movimentacoes: movimentacoes.rows,
  };
}

// ---------------------------------------------------------------------------
// Itens, divergencias e anexos (secao 49)
// ---------------------------------------------------------------------------

/** Lista os itens do recebimento com o contexto que a conferencia precisa. */
export async function listarItens(recebimentoId: number) {
  const { rows: cab } = await query(
    'SELECT id FROM recebimentos WHERE id = $1', [recebimentoId]);
  if (!cab.length) throw naoEncontrado('Recebimento');

  const { rows } = await query(`
    SELECT ri.*, p.codigo AS produto_codigo, p.descricao AS produto,
           p.controla_lote, p.controla_validade, p.exige_inspecao,
           p.dias_validade AS produto_dias_validade,
           un.codigo AS unidade, l.nome AS local,
           (SELECT count(*)::int FROM recebimento_divergencias d
             WHERE d.recebimento_item_id = ri.id) AS divergencias
      FROM recebimento_itens ri
      JOIN produtos p ON p.id = ri.produto_id
      LEFT JOIN unidades un ON un.id = ri.unidade_id
      LEFT JOIN locais l ON l.id = ri.local_id
     WHERE ri.recebimento_id = $1
     ORDER BY p.descricao, ri.id`, [recebimentoId]);

  return rows.map((i: Record<string, any>) => ({
    ...i,
    data_fabricacao: dataIso(i.data_fabricacao),
    data_validade: dataIso(i.data_validade),
    saldo_conferir: Math.max(num(i.quantidade_recebida) - num(i.quantidade_conferida), 0),
  }));
}

/**
 * Item avulso: mercadoria que chegou sem estar no pedido. Entra como item do
 * recebimento e ja nasce com a divergencia ITEM_NAO_PEDIDO registrada, porque
 * a secao 58 exige historico para toda divergencia.
 */
export async function adicionarItem(
  recebimentoId: number, entrada: z.output<typeof adicionarItemSchema>,
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows: cab } = await cliente.query(
      'SELECT id, numero, status, ordem_compra_id FROM recebimentos WHERE id = $1 FOR UPDATE',
      [recebimentoId]);
    if (!cab.length) throw naoEncontrado('Recebimento');
    if (ENCERRADOS.includes(cab[0].status)) {
      throw conflito(`Recebimento ${cab[0].numero} esta ${cab[0].status} e nao aceita novos itens`);
    }

    const { rows: prod } = await cliente.query(
      'SELECT id, descricao, unidade_compra_id FROM produtos WHERE id = $1 AND ativo = true AND deleted_at IS NULL',
      [entrada.produto_id]);
    if (!prod.length) throw naoEncontrado('Produto');

    const { rows: duplicado } = await cliente.query(`
      SELECT id FROM recebimento_itens
       WHERE recebimento_id = $1 AND produto_id = $2
         AND ordem_compra_item_id IS NOT DISTINCT FROM $3`,
      [recebimentoId, entrada.produto_id, entrada.ordem_compra_item_id ?? null]);
    if (duplicado.length) throw conflito('Este produto ja consta no recebimento');

    const { rows: criado } = await cliente.query(`
      INSERT INTO recebimento_itens
        (recebimento_id, ordem_compra_item_id, entrega_item_id, produto_id, unidade_id,
         quantidade_pedida, quantidade_recebida, preco_unitario, observacao, status)
      VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,'PENDENTE')
      RETURNING *`,
      [recebimentoId, entrada.ordem_compra_item_id ?? null, entrada.entrega_item_id ?? null,
        entrada.produto_id, entrada.unidade_id ?? prod[0].unidade_compra_id ?? null,
        entrada.quantidade_pedida ?? null, entrada.preco_unitario ?? null,
        entrada.observacao ?? null]);

    // Sem vinculo com item de pedido, a mercadoria nao foi comprada: isso e
    // divergencia por definicao e precisa de decisao antes da aprovacao.
    if (!entrada.ordem_compra_item_id) {
      await cliente.query(`
        INSERT INTO recebimento_divergencias
          (recebimento_id, recebimento_item_id, produto_id, tipo, severidade, descricao,
           detectada_por)
        VALUES ($1,$2,$3,'ITEM_NAO_PEDIDO'::tipo_divergencia_enum,
                'ALTA'::severidade_nc_enum,$4,$5)`,
        [recebimentoId, criado[0].id, entrada.produto_id,
          `Produto ${prod[0].descricao} chegou sem constar no pedido`, contexto.usuarioId ?? null]);
    }

    await registrarHistorico(cliente, cab[0].ordem_compra_id, 'RECEBIMENTO_ITEM_ADICIONADO',
      contexto.usuarioId ?? null,
      `Item ${prod[0].descricao} adicionado ao recebimento ${cab[0].numero}`,
      { produto_id: entrada.produto_id, nao_pedido: !entrada.ordem_compra_item_id });

    return criado[0];
  });
}

/** Painel de divergencias: e a fila de decisao do comprador (secao 30). */
export async function listarDivergencias(
  filtro: z.output<typeof listarDivergenciasSchema> & Paginacao,
) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const filtrar = (sql: string, valor: unknown) => {
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  if (filtro.recebimento_id) filtrar('d.recebimento_id = $?', filtro.recebimento_id);
  if (filtro.fornecedor_id) filtrar('r.fornecedor_id = $?', filtro.fornecedor_id);
  if (filtro.tipo) filtrar('d.tipo = $?::tipo_divergencia_enum', filtro.tipo);
  if (filtro.severidade) filtrar('d.severidade = $?::severidade_nc_enum', filtro.severidade);
  if (filtro.apenas_pendentes) cond.push("d.decisao = 'PENDENTE'");
  if (filtro.data_inicio) filtrar('d.detectada_em >= $?::date', filtro.data_inicio);
  if (filtro.data_fim) filtrar("d.detectada_em < ($?::date + 1)", filtro.data_fim);
  if (filtro.busca) {
    valores.push(`%${filtro.busca}%`);
    cond.push(`(d.descricao ILIKE $${valores.length} OR r.numero ILIKE $${valores.length}`
      + ` OR p.descricao ILIKE $${valores.length})`);
  }

  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const base = `
    FROM recebimento_divergencias d
    JOIN recebimentos r ON r.id = d.recebimento_id
    JOIN fornecedores f ON f.id = r.fornecedor_id
    LEFT JOIN produtos p ON p.id = d.produto_id`;

  const total = await query<{ total: number }>(
    `SELECT count(*)::int AS total ${base} ${onde}`, valores);

  const { rows } = await query(`
    SELECT d.*, r.numero AS recebimento, r.status AS recebimento_status,
           f.id AS fornecedor_id, f.razao_social AS fornecedor,
           p.codigo AS produto_codigo, p.descricao AS produto,
           u.nome AS decidido_por_nome, n.numero AS nao_conformidade
      ${base}
      LEFT JOIN usuarios u ON u.id = d.decidido_por
      LEFT JOIN nao_conformidades n ON n.id = d.nao_conformidade_id
      ${onde}
     ORDER BY (d.decisao = 'PENDENTE') DESC,
              CASE d.severidade WHEN 'CRITICA' THEN 1 WHEN 'ALTA' THEN 2
                                WHEN 'MEDIA' THEN 3 ELSE 4 END,
              d.detectada_em DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, filtro.limite, deslocamento(filtro)]);

  return { dados: rows, meta: metaPaginacao(Number(total.rows[0]?.total ?? 0), filtro) };
}

/**
 * Anexo: o sistema guarda a referencia (nome e local do arquivo), nunca o
 * binario nem credencial de acesso. Quem armazena e o storage do modulo 14.
 */
export async function registrarAnexo(
  entrada: z.output<typeof anexoSchema>, contexto: ContextoSessao,
) {
  if (entrada.recebimento_id) {
    const { rows } = await query(
      'SELECT id FROM recebimentos WHERE id = $1', [entrada.recebimento_id]);
    if (!rows.length) throw naoEncontrado('Recebimento');
  }
  const { rows } = await query(`
    INSERT INTO recebimento_anexos
      (recebimento_id, recebimento_item_id, lote_id, nao_conformidade_id, inspecao_id,
       tipo, nome, descricao, referencia, usuario_id)
    VALUES ($1,$2,$3,$4,$5,$6::tipo_anexo_enum,$7,$8,$9,$10)
    RETURNING *`,
    [entrada.recebimento_id ?? null, entrada.recebimento_item_id ?? null,
      entrada.lote_id ?? null, entrada.nao_conformidade_id ?? null, entrada.inspecao_id ?? null,
      entrada.tipo, entrada.nome, entrada.descricao ?? null, entrada.referencia ?? null,
      contexto.usuarioId ?? null]);
  return rows[0];
}

export async function listarAnexos(recebimentoId: number) {
  const { rows } = await query(`
    SELECT a.*, u.nome AS usuario
      FROM recebimento_anexos a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
     WHERE a.recebimento_id = $1
     ORDER BY a.created_at DESC`, [recebimentoId]);
  return rows;
}
