/**
 * Aprovacao do recebimento: a unica porta pela qual mercadoria entra no
 * estoque neste sistema.
 *
 * Tudo numa transacao so (secao 48): valida -> cria lote -> movimenta estoque
 * -> atualiza entrega -> atualiza pedido -> registra auditoria. Se qualquer
 * passo falhar, ROLLBACK - a secao 48 e explicita em nao permitir estoque
 * atualizado pela metade.
 *
 * As dez regras criticas da secao 58 se concentram aqui:
 *   1. sem conferencia nao ha entrada definitiva;
 *   2. produto controlado por lote precisa de lote;
 *   3. produto controlado por validade precisa de validade;
 *   4. produto reprovado nao entra como disponivel;
 *   5. produto em quarentena nao conta como disponivel;
 *   6. toda entrada gera movimentacao;
 *   8. toda excecao tem responsavel e justificativa.
 */
import { comTransacao, query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { hojeLocal, paraDataCalendario } from '../../core/datas.js';
import type { z } from 'zod';
import type { aprovarSchema, rejeitarSchema } from './recebimento.schemas.js';
import {
  avaliarValidade, calcularCustoEntrada, custoMedioPonderado, decidirDestino,
  type Destino,
} from './calculos.js';
import {
  ENCERRADOS, booleanoConfig, configuracoes, numeroConfig, proximoNumero, registrarHistorico,
  resolverTolerancia,
} from './recebimento.service.js';

type Cliente = { query: (t: string, v?: unknown[]) => Promise<{ rows: any[] }> };

const num = (v: unknown) => Number(v ?? 0);
const dataIso = (v: unknown) => paraDataCalendario(v);

export interface Bloqueio {
  regra: string;
  item?: string;
  mensagem: string;
  /**
   * Avisos so exigem excecao quando aprovar, do jeito que esta, faria o
   * material entrar como disponivel. Validade abaixo do minimo nao exige: sem
   * excecao o lote fica retido em quarentena, que e o desfecho conservador.
   * Excesso de quantidade e divergencia comercial pendente exigem, porque o
   * que esta em jogo e liberar mercadoria que ninguem autorizou.
   */
  exige_excecao?: boolean;
}

// ---------------------------------------------------------------------------
// Validacao previa (secao 58 e mensagens da secao 57)
// ---------------------------------------------------------------------------

/**
 * Diz se o recebimento pode ser aprovado e por que nao, em portugues.
 *
 * Nao grava nada: e o que a tela chama antes de habilitar o botao, e o que a
 * propria aprovacao chama antes de comecar.
 */
export async function validarRecebimento(recebimentoId: number) {
  const cfg = await configuracoes();
  const hoje = hojeLocal();

  const { rows: cab } = await query(
    'SELECT * FROM recebimentos WHERE id = $1', [recebimentoId]);
  if (!cab.length) throw naoEncontrado('Recebimento');
  const r = cab[0];

  const { rows: itens } = await query(`
    SELECT ri.*, p.codigo, p.descricao, p.controla_lote, p.controla_validade,
           p.dias_validade, p.exige_inspecao, p.checklist_qualidade_id,
           coalesce(pf.vida_util_minima_percentual, p.vida_util_minima_percentual)
             AS minimo_vida_util,
           (SELECT iq.resultado FROM inspecoes_qualidade iq
             WHERE iq.recebimento_item_id = ri.id
             ORDER BY iq.data_inspecao DESC LIMIT 1) AS resultado_qualidade
      FROM recebimento_itens ri
      JOIN produtos p ON p.id = ri.produto_id
      LEFT JOIN produto_fornecedor pf
             ON pf.produto_id = ri.produto_id AND pf.fornecedor_id = $2
     WHERE ri.recebimento_id = $1 ORDER BY p.descricao`, [recebimentoId, r.fornecedor_id]);

  const { rows: divergencias } = await query(`
    SELECT d.*, p.codigo FROM recebimento_divergencias d
    LEFT JOIN produtos p ON p.id = d.produto_id
     WHERE d.recebimento_id = $1`, [recebimentoId]);

  const bloqueios: Bloqueio[] = [];
  const avisos: Bloqueio[] = [];
  const minimoPadrao = numeroConfig(cfg, 'recebimento.vida_util_minima_percentual', 80);
  const exigirConferencia = booleanoConfig(cfg, 'recebimento.exigir_conferencia', true);
  const exigirLote = booleanoConfig(cfg, 'recebimento.exigir_lote_produto_controlado', true);
  const exigirDocumentos = booleanoConfig(cfg, 'recebimento.exigir_documentos', false);
  const excessoExigeAprovacao = booleanoConfig(cfg, 'recebimento.excesso_exige_aprovacao', true);

  if (exigirDocumentos && !r.documentos_conferidos) {
    bloqueios.push({
      regra: 'DOCUMENTOS',
      mensagem: 'A conferencia documental precisa estar concluida antes da aprovacao',
    });
  }

  const linhas = [];

  for (const i of itens) {
    // Regra 1: sem conferencia nao ha entrada definitiva.
    if (i.conferido_em === null && exigirConferencia) {
      bloqueios.push({
        regra: 'SEM_CONFERENCIA', item: i.codigo,
        mensagem: `Nao e possivel aprovar o recebimento porque o item ${i.codigo} nao foi conferido`,
      });
    }

    // Regra 2: produto controlado por lote precisa de lote.
    if (i.controla_lote && !i.numero_lote && exigirLote) {
      bloqueios.push({
        regra: 'SEM_LOTE', item: i.codigo,
        mensagem: `Nao e possivel aprovar o recebimento porque o item ${i.codigo} esta sem lote`,
      });
    }

    // Regra 3: produto controlado por validade precisa de validade.
    if (i.controla_validade && !i.data_validade) {
      bloqueios.push({
        regra: 'SEM_VALIDADE', item: i.codigo,
        mensagem: `O item ${i.codigo} controla validade e a data nao foi informada`,
      });
    }

    const validade = avaliarValidade({
      controlaValidade: i.controla_validade,
      dataValidade: dataIso(i.data_validade),
      dataFabricacao: dataIso(i.data_fabricacao),
      diasValidadeProduto: i.dias_validade !== null ? Number(i.dias_validade) : null,
      minimoPercentual: i.minimo_vida_util !== null
        ? Number(i.minimo_vida_util) : (i.controla_validade ? minimoPadrao : null),
      limiares: {
        proximaPercentual: numeroConfig(cfg, 'recebimento.validade_proxima_percentual', 90),
        criticaPercentual: numeroConfig(cfg, 'recebimento.validade_critica_percentual', 85),
      },
      hoje,
    });

    if (validade.situacao === 'VENCIDO') {
      bloqueios.push({
        regra: 'PRODUTO_VENCIDO', item: i.codigo,
        mensagem: `O item ${i.codigo} esta vencido e nao pode entrar no estoque`,
      });
    } else if (validade.situacao === 'INSUFICIENTE') {
      avisos.push({
        regra: 'VALIDADE_ABAIXO_MINIMO', item: i.codigo,
        mensagem: `A validade recebida do item ${i.codigo} esta abaixo do minimo permitido `
          + `(${validade.vidaUtilRestantePercentual?.toFixed(2)}% contra ${validade.minimoExigidoPercentual}%)`
          + '. Sem excecao autorizada o lote entra em quarentena',
        exige_excecao: false,
      });
    }

    // Item que exige inspecao e ainda nao tem resultado nao pode ser aprovado.
    const exigeInspecao = i.exige_inspecao || i.checklist_qualidade_id !== null;
    if (exigeInspecao && !i.resultado_qualidade) {
      bloqueios.push({
        regra: 'SEM_INSPECAO', item: i.codigo,
        mensagem: `O item ${i.codigo} exige inspecao de qualidade e ainda nao foi inspecionado`,
      });
    }

    const tolerancia = await resolverTolerancia(
      Number(i.produto_id), Number(r.fornecedor_id), null, r.tipo_operacao);
    const diferenca = num(i.quantidade_recebida) - num(i.quantidade_pedida);
    const limite = num(i.quantidade_pedida) * (tolerancia.quantidadePercentual / 100);

    if (diferenca > limite + 1e-9 && excessoExigeAprovacao) {
      // Se a divergencia de excesso deste item ja foi decidida, o excesso esta
      // autorizado: a decisao tem autor e justificativa gravados, que e
      // exatamente o que a excecao existe para exigir. Pedir excecao de novo
      // seria cobrar duas autorizacoes pelo mesmo fato.
      const decidida = divergencias.some((d) => d.tipo === 'QUANTIDADE_MAIOR'
        && Number(d.recebimento_item_id) === Number(i.id)
        && d.decisao !== 'PENDENTE');
      avisos.push({
        regra: 'EXCESSO_QUANTIDADE', item: i.codigo,
        mensagem: `${i.codigo} recebeu ${num(i.quantidade_recebida)} contra `
          + `${num(i.quantidade_pedida)} pedidos`
          + (decidida ? ', excesso ja autorizado na decisao da divergencia'
            : ', o excesso precisa de autorizacao'),
        exige_excecao: !decidida,
      });
    }

    linhas.push({
      recebimento_item_id: Number(i.id),
      codigo: i.codigo,
      descricao: i.descricao,
      quantidade_pedida: num(i.quantidade_pedida),
      quantidade_recebida: num(i.quantidade_recebida),
      diferenca,
      conferido: i.conferido_em !== null,
      controla_lote: i.controla_lote,
      numero_lote: i.numero_lote,
      validade,
      resultado_qualidade: i.resultado_qualidade,
      exige_inspecao: exigeInspecao,
    });
  }

  const pendentes = divergencias.filter((d) => d.decisao === 'PENDENTE');
  for (const d of pendentes) {
    if (['QUANTIDADE_MAIOR', 'PRECO_DIVERGENTE', 'PRODUTO_DIFERENTE'].includes(d.tipo)) {
      avisos.push({
        regra: 'DIVERGENCIA_PENDENTE', item: d.codigo ?? undefined,
        mensagem: `Divergencia ${d.tipo} sem decisao: ${d.descricao}`,
        exige_excecao: true,
      });
    }
  }

  return {
    recebimento_id: recebimentoId,
    numero: r.numero,
    status: r.status,
    pode_aprovar: bloqueios.length === 0,
    exige_excecao: avisos.some((a) => a.exige_excecao),
    bloqueios,
    avisos,
    itens: linhas,
    divergencias_pendentes: pendentes.length,
    parametros: {
      exigir_conferencia: exigirConferencia,
      exigir_lote: exigirLote,
      exigir_documentos: exigirDocumentos,
      excesso_exige_aprovacao: excessoExigeAprovacao,
      vida_util_minima_padrao: minimoPadrao,
    },
  };
}

// ---------------------------------------------------------------------------
// Movimentacao de estoque (secoes 30, 31, 32 e 33)
// ---------------------------------------------------------------------------

/** Garante a linha de estoque do par produto x local. */
async function estoqueDoLocal(cliente: Cliente, produtoId: number, localId: number) {
  const { rows } = await cliente.query(
    'SELECT * FROM estoques WHERE produto_id = $1 AND local_id = $2 FOR UPDATE',
    [produtoId, localId]);
  if (rows.length) return rows[0];

  const { rows: criado } = await cliente.query(`
    INSERT INTO estoques (produto_id, local_id, quantidade_fisica, quantidade_reservada,
                          quantidade_em_transito, quantidade_quarentena, quantidade_bloqueada)
    VALUES ($1,$2,0,0,0,0,0) RETURNING *`, [produtoId, localId]);
  return criado[0];
}

/**
 * Credita a quantidade no bucket certo e registra a movimentacao.
 *
 * Nunca escreve saldo sem movimentacao (regra 6 e secao 31). O bucket depende
 * do destino: disponivel soma so no fisico; quarentena e bloqueio somam no
 * fisico E no bucket proprio, que o disponivel desconta.
 */
async function creditarEstoque(
  cliente: Cliente,
  dados: {
    produtoId: number; localId: number; loteId: number | null; quantidade: number;
    destino: Destino; custoUnitario: number; recebimentoId: number;
    observacao: string; usuarioId: number | null;
  },
) {
  if (dados.quantidade <= 0) return null;

  const coluna = dados.destino === 'QUARENTENA' ? 'quantidade_quarentena'
    : dados.destino === 'BLOQUEADO' ? 'quantidade_bloqueada'
      : dados.destino === 'AREA_RECEBIMENTO' ? 'quantidade_recebimento'
        : null;

  // A movimentacao vem primeiro e e a unica dona do saldo fisico: o gatilho
  // fn_aplicar_movimentacao_estoque soma quantidade_fisica (e a quantidade do
  // lote) a partir dela. Somar aqui tambem contaria a entrada duas vezes.
  const { rows: mov } = await cliente.query(`
    INSERT INTO movimentacoes_estoque
      (produto_id, local_id, lote_id, tipo_movimentacao, quantidade, custo_unitario,
       documento_tipo, documento_id, observacao, usuario_id)
    VALUES ($1,$2,$3,'ENTRADA_COMPRA'::tipo_movimentacao_enum,$4,$5,
            'RECEBIMENTO'::documento_movimentacao_enum,$6,$7,$8)
    RETURNING *`,
    [dados.produtoId, dados.localId, dados.loteId, dados.quantidade, dados.custoUnitario,
      dados.recebimentoId, dados.observacao, dados.usuarioId]);

  // Os baldes de quarentena, bloqueio e area de recebimento sao do modulo 09:
  // o gatilho nao os conhece. Eles saem do fisico por conta da coluna gerada
  // quantidade_disponivel, garantindo as regras 4 e 5 da secao 58.
  if (coluna) {
    const estoque = await estoqueDoLocal(cliente, dados.produtoId, dados.localId);
    await cliente.query(
      `UPDATE estoques SET ${coluna} = ${coluna} + $2, updated_at = now() WHERE id = $1`,
      [estoque.id, dados.quantidade]);
  }

  return mov[0];
}

/** Cria ou reaproveita o lote, com a rastreabilidade da secao 62. */
async function garantirLote(
  cliente: Cliente,
  dados: {
    produtoId: number; numeroLote: string; dataFabricacao: string | null;
    dataValidade: string | null; quantidade: number; fornecedorId: number;
    recebimentoId: number; recebimentoItemId: number; pedidoId: number | null;
    notaFiscal: string | null; localId: number; custoUnitario: number;
    destino: Destino; usuarioId: number | null;
  },
) {
  const status = dados.destino === 'QUARENTENA' ? 'QUARENTENA'
    : dados.destino === 'BLOQUEADO' ? 'BLOQUEADO' : 'DISPONIVEL';

  const { rows: existente } = await cliente.query(
    'SELECT * FROM lotes WHERE produto_id = $1 AND numero_lote = $2 FOR UPDATE',
    [dados.produtoId, dados.numeroLote]);

  if (existente.length) {
    const { rows: atualizado } = await cliente.query(`
      UPDATE lotes
         SET quantidade_inicial = quantidade_inicial + $2,
             -- quantidade_atual fica por conta do gatilho da movimentacao.
             data_validade = coalesce(data_validade, $3::date),
             data_fabricacao = coalesce(data_fabricacao, $4::date),
             status = CASE WHEN $5 = 'QUARENTENA' THEN 'QUARENTENA'::status_lote_enum
                           ELSE status END,
             updated_at = now(), updated_by = $6
       WHERE id = $1 RETURNING *`,
      [existente[0].id, dados.quantidade, dados.dataValidade, dados.dataFabricacao,
        status, dados.usuarioId]);
    return atualizado[0];
  }

  const { rows: criado } = await cliente.query(`
    INSERT INTO lotes
      (produto_id, numero_lote, data_fabricacao, data_validade, quantidade_inicial,
       quantidade_atual, fornecedor_id, status, recebimento_id, recebimento_item_id,
       ordem_compra_id, numero_nota_fiscal, local_id, custo_unitario, created_by)
    VALUES ($1,$2,$3::date,$4::date,$5::numeric,0,$6,$7::status_lote_enum,$8,$9,$10,$11,$12,
            $13,$14)
    RETURNING *`,
    [dados.produtoId, dados.numeroLote, dados.dataFabricacao, dados.dataValidade,
      dados.quantidade, dados.fornecedorId, status, dados.recebimentoId,
      dados.recebimentoItemId, dados.pedidoId, dados.notaFiscal, dados.localId,
      dados.custoUnitario, dados.usuarioId]);
  return criado[0];
}

// ---------------------------------------------------------------------------
// Aprovacao (secoes 30, 39, 48 e 64)
// ---------------------------------------------------------------------------

/**
 * Aprova o recebimento: gera lote, movimenta estoque, atualiza entrega e
 * pedido. Tudo ou nada.
 */
export async function aprovarRecebimento(
  recebimentoId: number, entrada: z.output<typeof aprovarSchema>, contexto: ContextoSessao,
) {
  const validacao = await validarRecebimento(recebimentoId);

  if (!validacao.pode_aprovar) {
    throw regraNegocio(validacao.bloqueios.map((b) => b.mensagem).join('; '));
  }

  // Regra 8: excecao exige responsavel e justificativa. Sem elas, nao passa.
  const excecoes = entrada.excecoes ?? [];
  if (validacao.exige_excecao && !excecoes.length) {
    throw regraNegocio(
      `Este recebimento exige autorizacao de excecao: `
      + validacao.avisos.filter((a) => a.exige_excecao).map((a) => a.mensagem).join('; '));
  }

  const cfg = await configuracoes();
  const destinoPadrao = (cfg['recebimento.destino_padrao'] ?? 'DISPONIVEL') as Destino;
  const incluirFrete = booleanoConfig(cfg, 'recebimento.custo_inclui_frete', true);
  const incluirImpostos = booleanoConfig(cfg, 'recebimento.custo_inclui_impostos', false);
  const hoje = hojeLocal();
  const minimoPadrao = numeroConfig(cfg, 'recebimento.vida_util_minima_percentual', 80);

  return comTransacao(contexto, async (cliente) => {
    const { rows: cab } = await cliente.query(
      'SELECT * FROM recebimentos WHERE id = $1 FOR UPDATE', [recebimentoId]);
    if (!cab.length) throw naoEncontrado('Recebimento');
    const r = cab[0];

    if (ENCERRADOS.includes(r.status)) {
      throw regraNegocio(`Recebimento ${r.numero} ja esta ${r.status}`);
    }

    // As excecoes ficam registradas ANTES da entrada: se a transacao falhar
    // adiante, nada disso sobra.
    const excecaoPorItem = new Map<number, string[]>();
    for (const e of excecoes) {
      await cliente.query(`
        INSERT INTO recebimento_aprovacoes
          (recebimento_id, recebimento_item_id, tipo, descricao, decisao, justificativa,
           usuario_id, perfil)
        VALUES ($1,$2,$3::tipo_excecao_recebimento_enum,$4,'APROVADA',$5,$6,$7)`,
        [recebimentoId, e.recebimento_item_id ?? null, e.tipo, e.descricao,
          e.justificativa, contexto.usuarioId ?? null, null]);
      if (e.recebimento_item_id) {
        const lista = excecaoPorItem.get(e.recebimento_item_id) ?? [];
        lista.push(e.tipo);
        excecaoPorItem.set(e.recebimento_item_id, lista);
      }
    }
    const excecoesGerais = new Set(excecoes.filter((e) => !e.recebimento_item_id)
      .map((e) => e.tipo));

    const { rows: itens } = await cliente.query(`
      SELECT ri.*, p.codigo, p.descricao, p.controla_lote, p.controla_validade,
             p.dias_validade, oci.desconto, oci.frete_rateado, oci.impostos,
             oci.ordem_compra_id, oc.taxa_cambio,
             coalesce(pf.vida_util_minima_percentual, p.vida_util_minima_percentual)
               AS minimo_vida_util,
             (SELECT iq.resultado FROM inspecoes_qualidade iq
               WHERE iq.recebimento_item_id = ri.id
               ORDER BY iq.data_inspecao DESC LIMIT 1) AS resultado_qualidade,
             (SELECT iq.quantidade_aprovada FROM inspecoes_qualidade iq
               WHERE iq.recebimento_item_id = ri.id
               ORDER BY iq.data_inspecao DESC LIMIT 1) AS qtd_aprovada_qualidade,
             (SELECT iq.quantidade_reprovada FROM inspecoes_qualidade iq
               WHERE iq.recebimento_item_id = ri.id
               ORDER BY iq.data_inspecao DESC LIMIT 1) AS qtd_reprovada_qualidade,
             (SELECT iq.quantidade_quarentena FROM inspecoes_qualidade iq
               WHERE iq.recebimento_item_id = ri.id
               ORDER BY iq.data_inspecao DESC LIMIT 1) AS qtd_quarentena_qualidade
        FROM recebimento_itens ri
        JOIN produtos p ON p.id = ri.produto_id
        LEFT JOIN ordem_compra_itens oci ON oci.id = ri.ordem_compra_item_id
        LEFT JOIN ordens_compra oc ON oc.id = oci.ordem_compra_id
        LEFT JOIN produto_fornecedor pf
               ON pf.produto_id = ri.produto_id AND pf.fornecedor_id = $2
       WHERE ri.recebimento_id = $1 FOR UPDATE OF ri`, [recebimentoId, r.fornecedor_id]);

    const resultados = [];
    let totalAceito = 0;
    let totalRejeitado = 0;
    let totalQuarentena = 0;
    let totalRecebido = 0;
    let valorRecebido = 0;
    let saldoPendente = 0;

    for (const i of itens) {
      const recebida = num(i.quantidade_recebida);
      totalRecebido += recebida;

      const validade = avaliarValidade({
        controlaValidade: i.controla_validade,
        dataValidade: dataIso(i.data_validade),
        dataFabricacao: dataIso(i.data_fabricacao),
        diasValidadeProduto: i.dias_validade !== null ? Number(i.dias_validade) : null,
        minimoPercentual: i.minimo_vida_util !== null
          ? Number(i.minimo_vida_util) : (i.controla_validade ? minimoPadrao : null),
        limiares: {
          proximaPercentual: numeroConfig(cfg, 'recebimento.validade_proxima_percentual', 90),
          criticaPercentual: numeroConfig(cfg, 'recebimento.validade_critica_percentual', 85),
        },
        hoje,
      });

      const excecaoValidade = (excecaoPorItem.get(Number(i.id)) ?? [])
        .includes('VALIDADE_ABAIXO_MINIMO')
        || excecoesGerais.has('VALIDADE_ABAIXO_MINIMO');

      const decisao = decidirDestino({
        quantidadeRecebida: recebida,
        resultadoQualidade: i.resultado_qualidade,
        quantidadeAprovadaQualidade: i.qtd_aprovada_qualidade !== null
          ? num(i.qtd_aprovada_qualidade) : null,
        quantidadeReprovadaQualidade: i.qtd_reprovada_qualidade !== null
          ? num(i.qtd_reprovada_qualidade) : null,
        quantidadeQuarentenaQualidade: i.qtd_quarentena_qualidade !== null
          ? num(i.qtd_quarentena_qualidade) : null,
        validade,
        exigeLote: i.controla_lote,
        loteInformado: Boolean(i.numero_lote),
        destinoPadrao,
        excecaoValidadeAutorizada: excecaoValidade,
      });

      // Quarentena aberta manualmente soma a que a inspecao decidiu.
      const quarentenaManual = num(i.quantidade_quarentena);
      const quarentena = Math.max(decisao.quantidadeQuarentena, quarentenaManual);
      const aceita = Math.max(0, recebida - quarentena - decisao.quantidadeRejeitada);
      const rejeitada = decisao.quantidadeRejeitada;

      const custo = calcularCustoEntrada({
        quantidadeEntrando: recebida,
        precoUnitario: num(i.preco_unitario),
        descontoTotal: num(i.desconto),
        freteRateado: num(i.frete_rateado),
        impostosRateados: num(i.impostos),
        outrosCustos: 0,
        incluirFrete,
        incluirImpostos,
        taxaCambio: i.taxa_cambio !== null ? num(i.taxa_cambio) : null,
      });

      const localId = i.local_id !== null ? Number(i.local_id)
        : r.local_id !== null ? Number(r.local_id) : null;
      if (!localId && (aceita > 0 || quarentena > 0)) {
        throw regraNegocio(
          `Item ${i.codigo} sem local de estoque definido. Informe o local na conferencia`);
      }

      // Lote: um por item, com a quantidade que realmente entra.
      let loteId: number | null = i.lote_id !== null ? Number(i.lote_id) : null;
      const entrando = aceita + quarentena;
      if (i.numero_lote && entrando > 0 && localId) {
        const lote = await garantirLote(cliente, {
          produtoId: Number(i.produto_id),
          numeroLote: i.numero_lote,
          dataFabricacao: dataIso(i.data_fabricacao),
          dataValidade: dataIso(i.data_validade),
          quantidade: entrando,
          fornecedorId: Number(r.fornecedor_id),
          recebimentoId,
          recebimentoItemId: Number(i.id),
          pedidoId: i.ordem_compra_id !== null ? Number(i.ordem_compra_id) : null,
          notaFiscal: r.numero_nota_fiscal,
          localId,
          custoUnitario: custo.custoUnitario,
          destino: quarentena > 0 && aceita === 0 ? 'QUARENTENA' : decisao.destino,
          usuarioId: contexto.usuarioId ?? null,
        });
        loteId = Number(lote.id);
      }

      const movimentacoes = [];
      if (localId) {
        if (aceita > 0) {
          const mov = await creditarEstoque(cliente, {
            produtoId: Number(i.produto_id), localId, loteId, quantidade: aceita,
            destino: decisao.destino === 'RECUSADO' ? destinoPadrao : decisao.destino,
            custoUnitario: custo.custoUnitario, recebimentoId,
            observacao: `Recebimento ${r.numero}`
              + (i.numero_lote ? ` lote ${i.numero_lote}` : ''),
            usuarioId: contexto.usuarioId ?? null,
          });
          if (mov) movimentacoes.push(mov);
        }
        if (quarentena > 0) {
          const mov = await creditarEstoque(cliente, {
            produtoId: Number(i.produto_id), localId, loteId, quantidade: quarentena,
            destino: 'QUARENTENA', custoUnitario: custo.custoUnitario, recebimentoId,
            observacao: `Recebimento ${r.numero} em quarentena: ${decisao.motivos.join('; ')}`,
            usuarioId: contexto.usuarioId ?? null,
          });
          if (mov) movimentacoes.push(mov);
        }
      }

      // Regra 4: o rejeitado nao entra no estoque. Fica so no registro.
      const statusItem = rejeitada >= recebida && recebida > 0 ? 'REJEITADO'
        : quarentena > 0 ? 'EM_QUARENTENA'
          : rejeitada > 0 ? 'ACEITO_PARCIAL' : 'ACEITO';

      await cliente.query(`
        UPDATE recebimento_itens
           SET quantidade_aceita = $2, quantidade_rejeitada = $3, quantidade_quarentena = $4,
               lote_id = coalesce($5, lote_id), destino = $6::destino_recebimento_enum,
               local_id = coalesce(local_id, $7),
               status = $8::status_recebimento_item_enum, updated_at = now()
         WHERE id = $1`,
        [i.id, aceita, rejeitada, quarentena, loteId, decisao.destino, localId,
          statusItem]);

      // Custo de referencia do produto, pelo medio ponderado que o modulo 03 usa.
      if (aceita > 0) {
        const { rows: saldo } = await cliente.query(`
          SELECT coalesce(sum(quantidade_fisica), 0) AS fisico FROM estoques
           WHERE produto_id = $1`, [i.produto_id]);
        const saldoAnterior = num(saldo[0].fisico) - aceita - quarentena;
        const { rows: produto } = await cliente.query(
          'SELECT custo_referencia FROM produtos WHERE id = $1', [i.produto_id]);
        const medio = custoMedioPonderado(
          Math.max(0, saldoAnterior), num(produto[0]?.custo_referencia), aceita,
          custo.custoUnitario);
        await cliente.query(`
          UPDATE produtos SET custo_referencia = $2, custo_referencia_em = now(),
                 custo_referencia_origem = 'RECEBIMENTO' WHERE id = $1`,
          [i.produto_id, medio]);
      }

      totalAceito += aceita;
      totalRejeitado += rejeitada;
      totalQuarentena += quarentena;
      // Faltou mercadoria em relacao ao pedido: o recebimento e parcial mesmo
      // que tudo que chegou tenha sido aceito (secao 60, cenario 2).
      if (i.quantidade_pedida !== null && recebida < num(i.quantidade_pedida)) {
        saldoPendente += num(i.quantidade_pedida) - recebida;
      }
      valorRecebido += recebida * num(i.preco_unitario);

      resultados.push({
        recebimento_item_id: Number(i.id),
        codigo: i.codigo,
        quantidade_recebida: recebida,
        quantidade_aceita: aceita,
        quantidade_rejeitada: rejeitada,
        quantidade_quarentena: quarentena,
        destino: decisao.destino,
        motivos: decisao.motivos,
        lote_id: loteId,
        custo_unitario: custo.custoUnitario,
        movimentacoes: movimentacoes.length,
        validade: validade.situacao,
      });

      // Secao 39: o saldo da entrega e do pedido acompanha o que foi recebido.
      if (i.ordem_compra_item_id) {
        await cliente.query(`
          UPDATE ordem_compra_itens
             SET quantidade_recebida = quantidade_recebida + $2,
                 quantidade_pendente = greatest(quantidade_pedida - (quantidade_recebida + $2), 0),
                 updated_at = now()
           WHERE id = $1`, [i.ordem_compra_item_id, aceita + quarentena]);
      }
      if (i.entrega_item_id) {
        await cliente.query(
          'UPDATE entrega_itens SET quantidade_conferida = $2, updated_at = now() WHERE id = $1',
          [i.entrega_item_id, recebida]);
      }
    }

    // Status final: tudo aceito e aprovado; parte rejeitada ou em quarentena,
    // aprovado parcialmente; nada aceito, rejeitado.
    const status = totalAceito <= 0 && totalRecebido > 0
      ? (totalQuarentena > 0 ? 'QUARENTENA' : 'REJEITADO')
      : totalRejeitado > 0 || totalQuarentena > 0 || saldoPendente > 0
        ? 'APROVADO_PARCIALMENTE' : 'APROVADO';

    const { rows: aprovado } = await cliente.query(`
      UPDATE recebimentos
         SET status = $2::status_recebimento_enum,
             data_aprovacao = now(), aprovador_id = $3,
             justificativa_decisao = $4,
             quantidade_recebida = $5, quantidade_aceita = $6,
             quantidade_rejeitada = $7, quantidade_quarentena = $8,
             valor_recebido = $9,
             conferencia_fim = coalesce(conferencia_fim, now()),
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [recebimentoId, status, contexto.usuarioId ?? null, entrada.justificativa ?? null,
        totalRecebido, totalAceito, totalRejeitado, totalQuarentena, valorRecebido]);

    // Entrega e pedido (secao 39).
    if (r.entrega_id) {
      await cliente.query(`
        UPDATE entregas
           SET status = 'ENTREGUE'::status_entrega_enum,
               quantidade_entregue = coalesce(quantidade_entregue, $2),
               pronta_recebimento = false, updated_at = now()
         WHERE id = $1`, [r.entrega_id, totalRecebido]);
    }

    let pedidoFinalizado = false;
    if (r.ordem_compra_id) {
      const { rows: saldo } = await cliente.query(`
        SELECT sum(quantidade_pedida) AS pedida, sum(quantidade_recebida) AS recebida
          FROM ordem_compra_itens WHERE ordem_compra_id = $1`, [r.ordem_compra_id]);
      pedidoFinalizado = num(saldo[0].recebida) >= num(saldo[0].pedida);

      await cliente.query(`
        UPDATE ordens_compra
           SET status = $2::status_ordem_compra_enum,
               status_logistico = $3::status_logistico_enum,
               economia_realizada = CASE WHEN $4 THEN economia_negociada ELSE economia_realizada END,
               economia_reconhecida_em = CASE WHEN $4 THEN now() ELSE economia_reconhecida_em END,
               updated_at = now()
         WHERE id = $1`,
        [r.ordem_compra_id, pedidoFinalizado ? 'RECEBIDA' : 'RECEBIMENTO_PARCIAL',
          'RECEBIDO', pedidoFinalizado]);
    }

    await registrarHistorico(cliente, r.ordem_compra_id, 'RECEBIMENTO_APROVADO',
      contexto.usuarioId ?? null,
      `Recebimento ${r.numero}: ${status}. Aceito ${totalAceito}`
      + (totalQuarentena > 0 ? `, quarentena ${totalQuarentena}` : '')
      + (totalRejeitado > 0 ? `, rejeitado ${totalRejeitado}` : ''),
      { status, aceito: totalAceito, quarentena: totalQuarentena, rejeitado: totalRejeitado,
        excecoes: excecoes.length });

    return {
      ...aprovado[0],
      itens: resultados,
      totais: {
        recebido: totalRecebido, aceito: totalAceito,
        rejeitado: totalRejeitado, quarentena: totalQuarentena,
        valor: valorRecebido,
      },
      pedido_finalizado: pedidoFinalizado,
      excecoes_registradas: excecoes.length,
      observacao: totalQuarentena > 0
        ? 'Parte da mercadoria entrou em quarentena e nao conta como disponivel'
        : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Rejeicao (secao 58, regra 4)
// ---------------------------------------------------------------------------

/** Rejeita o recebimento inteiro. Nada entra no estoque. */
export async function rejeitarRecebimento(
  recebimentoId: number, entrada: z.output<typeof rejeitarSchema>, contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(
      'SELECT * FROM recebimentos WHERE id = $1 FOR UPDATE', [recebimentoId]);
    if (!rows.length) throw naoEncontrado('Recebimento');
    const r = rows[0];
    if (ENCERRADOS.includes(r.status)) {
      throw regraNegocio(`Recebimento ${r.numero} ja esta ${r.status}`);
    }

    const { rows: itens } = await cliente.query(
      'SELECT * FROM recebimento_itens WHERE recebimento_id = $1', [recebimentoId]);

    await cliente.query(`
      UPDATE recebimento_itens
         SET quantidade_aceita = 0, quantidade_quarentena = 0,
             quantidade_rejeitada = quantidade_recebida,
             destino = 'RECUSADO'::destino_recebimento_enum,
             status = 'REJEITADO'::status_recebimento_item_enum, updated_at = now()
       WHERE recebimento_id = $1`, [recebimentoId]);

    const totalRecebido = itens.reduce((a, i) => a + num(i.quantidade_recebida), 0);

    const { rows: rejeitado } = await cliente.query(`
      UPDATE recebimentos
         SET status = 'REJEITADO'::status_recebimento_enum,
             data_aprovacao = now(), aprovador_id = $2,
             justificativa_decisao = $3,
             quantidade_recebida = $4, quantidade_aceita = 0,
             quantidade_rejeitada = $4, quantidade_quarentena = 0,
             conferencia_fim = coalesce(conferencia_fim, now()), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [recebimentoId, contexto.usuarioId ?? null, entrada.justificativa, totalRecebido]);

    let ncNumero: string | null = null;
    if (entrada.abrir_nao_conformidade) {
      const numero = await proximoNumero(
        cliente, 'nao_conformidades', 'recebimento.prefixo_nc', 'NC');
      await cliente.query(`
        INSERT INTO nao_conformidades
          (numero, fornecedor_id, recebimento_id, tipo, severidade, descricao,
           quantidade_afetada, status, responsavel_id, created_by)
        VALUES ($1,$2,$3,'QUALIDADE'::tipo_nao_conformidade_enum,$4::severidade_nc_enum,
                $5,$6,'ABERTA'::status_nao_conformidade_enum,$7,$7)`,
        [numero, r.fornecedor_id, recebimentoId, entrada.severidade,
          `Recebimento ${r.numero} rejeitado: ${entrada.justificativa}`,
          totalRecebido, contexto.usuarioId ?? null]);
      ncNumero = numero;
    }

    await cliente.query(`
      INSERT INTO alertas (tipo, severidade, fornecedor_id, ordem_compra_id, mensagem, detalhes)
      VALUES ('QUALIDADE_REPROVADA'::tipo_alerta_enum, 'ALTA'::severidade_enum, $1, $2, $3, $4::jsonb)`,
      [r.fornecedor_id, r.ordem_compra_id,
        `Recebimento ${r.numero} rejeitado: ${entrada.justificativa}`,
        JSON.stringify({ recebimento: r.numero, nc: ncNumero })]);

    if (r.entrega_id) {
      await cliente.query(
        'UPDATE entregas SET pronta_recebimento = false, updated_at = now() WHERE id = $1',
        [r.entrega_id]);
    }

    await registrarHistorico(cliente, r.ordem_compra_id, 'RECEBIMENTO_REJEITADO',
      contexto.usuarioId ?? null,
      `Recebimento ${r.numero} rejeitado: ${entrada.justificativa}`,
      { nc: ncNumero, quantidade: totalRecebido });

    return {
      ...rejeitado[0],
      nao_conformidade: ncNumero,
      observacao: 'Nenhuma quantidade entrou no estoque',
    };
  });
}

/** Decide uma divergencia pendente (secoes 26 e 27). */
export async function decidirDivergencia(
  divergenciaId: number,
  entrada: { decisao: string; justificativa: string; abrir_nao_conformidade: boolean },
  contexto: ContextoSessao,
) {
  return comTransacao(contexto, async (cliente) => {
    const { rows } = await cliente.query(`
      SELECT d.*, r.numero AS recebimento_numero, r.fornecedor_id, r.ordem_compra_id
        FROM recebimento_divergencias d
        JOIN recebimentos r ON r.id = d.recebimento_id
       WHERE d.id = $1 FOR UPDATE OF d`, [divergenciaId]);
    if (!rows.length) throw naoEncontrado('Divergencia');
    const d = rows[0];

    if (d.decisao !== 'PENDENTE') {
      throw regraNegocio(`Divergencia ja decidida como ${d.decisao}`);
    }

    const { rows: atualizada } = await cliente.query(`
      UPDATE recebimento_divergencias
         SET decisao = $2::decisao_divergencia_enum, justificativa = $3,
             decidido_por = $4, decidido_em = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [divergenciaId, entrada.decisao, entrada.justificativa, contexto.usuarioId ?? null]);

    let ncNumero: string | null = null;
    if (entrada.abrir_nao_conformidade) {
      const numero = await proximoNumero(
        cliente, 'nao_conformidades', 'recebimento.prefixo_nc', 'NC');
      const tipo = d.tipo.startsWith('QUANTIDADE') ? 'QUANTIDADE'
        : d.tipo.includes('VALIDADE') || d.tipo === 'PRODUTO_VENCIDO' ? 'VALIDADE'
          : d.tipo.includes('LOTE') ? 'LOTE'
            : d.tipo === 'PRECO_DIVERGENTE' ? 'PRECO'
              : d.tipo.includes('DOCUMENTACAO') || d.tipo === 'NF_DIVERGENTE' ? 'DOCUMENTACAO'
                : 'QUALIDADE';

      const { rows: nc } = await cliente.query(`
        INSERT INTO nao_conformidades
          (numero, produto_id, fornecedor_id, recebimento_id, recebimento_item_id,
           divergencia_id, tipo, severidade, descricao, quantidade_afetada, status,
           responsavel_id, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7::tipo_nao_conformidade_enum,$8::severidade_nc_enum,
                $9,$10,'ABERTA'::status_nao_conformidade_enum,$11,$11)
        RETURNING id, numero`,
        [numero, d.produto_id, d.fornecedor_id, d.recebimento_id, d.recebimento_item_id,
          divergenciaId, tipo, d.severidade, d.descricao, d.diferenca,
          contexto.usuarioId ?? null]);

      await cliente.query(
        'UPDATE recebimento_divergencias SET nao_conformidade_id = $2 WHERE id = $1',
        [divergenciaId, nc[0].id]);
      ncNumero = nc[0].numero;
    }

    await registrarHistorico(cliente, d.ordem_compra_id, 'DIVERGENCIA_DECIDIDA',
      contexto.usuarioId ?? null,
      `Divergencia ${d.tipo} do recebimento ${d.recebimento_numero}: ${entrada.decisao}`,
      { decisao: entrada.decisao, justificativa: entrada.justificativa, nc: ncNumero });

    return { ...atualizada[0], nao_conformidade: ncNumero };
  });
}
