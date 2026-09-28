/**
 * Detectores: quem transforma o estado do banco em EVENTOS (secoes 6, 7 e 12).
 *
 * Todo detector aqui e uma consulta de leitura seguida de `eventos.registrar`.
 * Nenhum calcula nada por conta propria: cobertura, ponto de pedido, OTIF,
 * atraso e validade ja foram definidos nos modulos 02 a 12, e as visoes
 * (`vw_produtos_criticos`, `vw_compras_abertas`, `vw_performance_fornecedores`,
 * `vw_estoque_atual`) sao a fonte. Redefinir "cobertura" aqui criaria um segundo
 * numero para a mesma palavra, e um dia os dois divergiriam - e quem olhasse a
 * tela nao saberia qual acreditar.
 *
 * Todos podem rodar de hora em hora sem medo. A chave de idempotencia inclui o
 * dia, entao o mesmo fato registra uma vez por dia: a ruptura que persiste nao
 * gera enxurrada de eventos, mas volta a aparecer amanha, porque continuar em
 * ruptura amanha e um fato novo.
 *
 * Os limites vem de `configuracoes`, nao de constantes, para o gerente ajustar
 * a sensibilidade sem deploy.
 */
import { query, type ContextoSessao } from '../../config/database.js';
import * as eventos from './eventos.service.js';
import { numero } from './config.js';

export interface ResultadoDeteccao {
  detector: string;
  avaliados: number;
  eventos: number;
  novos: number;
  limite?: number;
  observacao?: string;
  /**
   * Quantos casos o detector conseguiu de fato EXAMINAR, quando o pre-filtro
   * dele pode eliminar tudo em silencio.
   *
   * Sem isso, "zero eventos" fica ambiguo entre "esta tudo bem" e "nao havia
   * dado para avaliar" - e as duas coisas pedem acoes opostas. E a mesma licao
   * do modulo 12: ausencia de resultado precisa vir com o motivo, senao passa a
   * ser lida como ausencia de problema.
   */
  base?: number;
  motivo_sem_evento?: string;
}

/** Teto por detector: uma varredura nao pode gerar dez mil eventos de uma vez. */
const TETO = 500;

async function emitir(
  detector: string, entradas: eventos.NovoEvento[], contexto: ContextoSessao,
  avaliados: number, extras: Partial<ResultadoDeteccao> = {},
): Promise<ResultadoDeteccao> {
  const recortadas = entradas.slice(0, TETO);
  const { registrados, novos } = await eventos.registrarVarios(recortadas, contexto);
  return {
    detector,
    avaliados,
    eventos: registrados,
    novos,
    ...extras,
    ...(entradas.length > TETO
      ? { observacao: `${entradas.length} casos encontrados; limitado a ${TETO} eventos `
          + 'por varredura para nao inundar a fila. O restante entra na proxima.' }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Estoque
// ---------------------------------------------------------------------------

/**
 * Ruptura: tem demanda e nao tem saldo.
 *
 * A condicao de demanda e essencial. Sem ela, os 800 produtos cadastrados que
 * ninguem vende entrariam como ruptura todo dia e o alerta de ruptura perderia
 * o sentido - estar sem estoque de algo que nao sai nao e um problema.
 */
export async function ruptura(contexto: ContextoSessao): Promise<ResultadoDeteccao> {
  const { rows } = await query<{
    produto_id: string; codigo: string; descricao: string;
    demanda_media_diaria: string; estoque_em_transito: string; ponto_pedido: string | null;
  }>(`
    SELECT produto_id, codigo, descricao, demanda_media_diaria,
           estoque_em_transito, ponto_pedido
      FROM vw_estoque_atual
     WHERE estoque_disponivel <= 0
       AND demanda_media_diaria > 0
     ORDER BY demanda_media_diaria DESC`);

  return emitir('ruptura', rows.map((r) => ({
    tipo: 'STOCK_OUT' as const,
    origem: 'ESTOQUE' as const,
    entidade: 'produto',
    entidade_id: Number(r.produto_id),
    payload: {
      sku: r.codigo,
      produto_nome: r.descricao,
      saldo: 0,
      demanda_diaria: Number(r.demanda_media_diaria),
      cobertura_dias: 0,
      em_transito: Number(r.estoque_em_transito),
      ponto_pedido: r.ponto_pedido === null ? null : Number(r.ponto_pedido),
    },
  })), contexto, rows.length);
}

/** Risco de ruptura: cobertura abaixo do lead time mais a margem configurada. */
export async function riscoRuptura(contexto: ContextoSessao): Promise<ResultadoDeteccao> {
  const margem = await numero('margem_risco_dias', 3);

  const { rows } = await query<{
    produto_id: string; codigo: string; descricao: string; cobertura_dias: string;
    demanda_media_diaria: string; lead_time_dias: string | null;
    estoque_disponivel: string; ponto_pedido: string | null;
  }>(`
    SELECT produto_id, codigo, descricao, cobertura_dias, demanda_media_diaria,
           lead_time_dias, estoque_disponivel, ponto_pedido
      FROM vw_produtos_criticos
     WHERE estoque_disponivel > 0
       AND demanda_media_diaria > 0
       AND cobertura_dias IS NOT NULL
       AND cobertura_dias <= coalesce(lead_time_dias, 7) + $1
     ORDER BY cobertura_dias`, [margem]);

  return emitir('risco_ruptura', rows.map((r) => ({
    tipo: 'STOCK_LOW' as const,
    origem: 'ESTOQUE' as const,
    entidade: 'produto',
    entidade_id: Number(r.produto_id),
    payload: {
      sku: r.codigo,
      produto_nome: r.descricao,
      saldo: Number(r.estoque_disponivel),
      demanda_diaria: Number(r.demanda_media_diaria),
      cobertura_dias: Number(r.cobertura_dias),
      lead_time_dias: r.lead_time_dias === null ? null : Number(r.lead_time_dias),
      ponto_pedido: r.ponto_pedido === null ? null : Number(r.ponto_pedido),
    },
  })), contexto, rows.length, { limite: margem });
}

/** Excesso: saldo acima do maximo, medido pelo mesmo criterio do modulo 11. */
export async function excesso(contexto: ContextoSessao): Promise<ResultadoDeteccao> {
  const cobertura = await numero('excesso_cobertura_dias', 90);

  // `valor_parado` e o capital imobilizado acima do que faz sentido guardar -
  // e e o campo pelo qual a regra decide se vale acordar alguem. Excesso de mil
  // unidades de um item barato nao e o mesmo problema que excesso de cem de um
  // item caro, e sem o valor as duas viram o mesmo alerta.
  const { rows } = await query<{
    produto_id: string; codigo: string; descricao: string; estoque_disponivel: string;
    cobertura_dias: string | null; estoque_maximo: string | null;
    valor_parado: string | null; excedente: string | null;
  }>(`
    SELECT v.produto_id, v.codigo, v.descricao, v.estoque_disponivel,
           v.cobertura_dias, p.estoque_maximo,
           greatest(v.estoque_disponivel - coalesce(p.estoque_maximo,
             CASE WHEN v.demanda_media_diaria > 0
                  THEN v.demanda_media_diaria * $1 ELSE 0 END), 0)::text AS excedente,
           round(greatest(v.estoque_disponivel - coalesce(p.estoque_maximo,
             CASE WHEN v.demanda_media_diaria > 0
                  THEN v.demanda_media_diaria * $1 ELSE 0 END), 0)
             * coalesce(p.custo_referencia, 0), 2)::text AS valor_parado
      FROM vw_estoque_atual v
      JOIN produtos p ON p.id = v.produto_id
     WHERE v.estoque_disponivel > 0
       AND ((p.estoque_maximo IS NOT NULL AND v.estoque_disponivel > p.estoque_maximo)
            OR (v.cobertura_dias IS NOT NULL AND v.cobertura_dias > $1))
     ORDER BY v.cobertura_dias DESC NULLS LAST`, [cobertura]);

  return emitir('excesso', rows.map((r) => ({
    tipo: 'STOCK_EXCESS' as const,
    origem: 'ESTOQUE' as const,
    entidade: 'produto',
    entidade_id: Number(r.produto_id),
    payload: {
      sku: r.codigo,
      produto_nome: r.descricao,
      saldo: Number(r.estoque_disponivel),
      cobertura_dias: r.cobertura_dias === null ? null : Number(r.cobertura_dias),
      estoque_maximo: r.estoque_maximo === null ? null : Number(r.estoque_maximo),
      excedente: r.excedente === null ? null : Number(r.excedente),
      valor_parado: r.valor_parado === null ? 0 : Number(r.valor_parado),
    },
  })), contexto, rows.length, { limite: cobertura });
}

/** Validade: lote com saldo vencendo dentro do horizonte configurado. */
export async function validade(contexto: ContextoSessao): Promise<ResultadoDeteccao> {
  const horizonte = await numero('validade_horizonte_dias', 60);

  const { rows } = await query<{
    lote_id: string; produto_id: string; codigo: string; descricao: string;
    numero_lote: string; data_validade: string; dias: string; quantidade: string;
  }>(`
    SELECT l.id AS lote_id, l.produto_id, p.codigo, p.descricao, l.numero_lote,
           l.data_validade::text AS data_validade,
           (l.data_validade - CURRENT_DATE)::text AS dias,
           l.quantidade_atual AS quantidade
      FROM lotes l
      JOIN produtos p ON p.id = l.produto_id
     WHERE l.quantidade_atual > 0
       AND l.data_validade IS NOT NULL
       AND l.status = 'DISPONIVEL'
       AND l.data_validade <= CURRENT_DATE + $1::int
     ORDER BY l.data_validade`, [horizonte]);

  return emitir('validade', rows.map((r) => ({
    tipo: 'STOCK_EXPIRY' as const,
    origem: 'ESTOQUE' as const,
    entidade: 'lote',
    entidade_id: Number(r.lote_id),
    payload: {
      sku: r.codigo,
      produto_nome: r.descricao,
      produto_id: Number(r.produto_id),
      numero_lote: r.numero_lote,
      data_validade: r.data_validade,
      dias_para_vencer: Number(r.dias),
      saldo: Number(r.quantidade),
    },
  })), contexto, rows.length, { limite: horizonte });
}

/**
 * Saldo negativo: inconsistencia, nao escassez.
 *
 * Merece evento proprio porque a acao e outra - ninguem compra para resolver
 * saldo negativo, conferem-se as movimentacoes.
 */
export async function saldoNegativo(contexto: ContextoSessao): Promise<ResultadoDeteccao> {
  const { rows } = await query<{
    produto_id: string; codigo: string; descricao: string; estoque_fisico: string;
  }>(`
    SELECT produto_id, codigo, descricao, estoque_fisico
      FROM vw_estoque_atual
     WHERE estoque_fisico < 0
     ORDER BY estoque_fisico`);

  return emitir('saldo_negativo', rows.map((r) => ({
    tipo: 'STOCK_NEGATIVE' as const,
    origem: 'ESTOQUE' as const,
    entidade: 'produto',
    entidade_id: Number(r.produto_id),
    payload: {
      sku: r.codigo, produto_nome: r.descricao, saldo: Number(r.estoque_fisico),
    },
  })), contexto, rows.length);
}

// ---------------------------------------------------------------------------
// Compras, cotacoes, pedidos e entregas
// ---------------------------------------------------------------------------

/** Necessidade de compra pendente, gerada pelo modulo 05. */
export async function necessidades(contexto: ContextoSessao): Promise<ResultadoDeteccao> {
  const { rows } = await query<{
    id: string; produto_id: string; codigo: string; descricao: string;
    quantidade_sugerida: string; prioridade: string; fornecedor_id: string | null;
    valor: string | null; necessidades_do_fornecedor: string;
  }>(`
    SELECT n.id, n.produto_id, p.codigo, p.descricao, n.quantidade_sugerida,
           n.prioridade::text AS prioridade, n.fornecedor_id,
           (n.quantidade_sugerida * coalesce(pf.preco_atual, 0))::text AS valor,
           -- Quantas necessidades pendentes o MESMO fornecedor tem. E o numero
           -- pelo qual a regra de consolidacao decide: juntar duas compras nao
           -- economiza frete, juntar cinco economiza.
           count(*) OVER (PARTITION BY n.fornecedor_id)::text AS necessidades_do_fornecedor
      FROM necessidades_compra n
      JOIN produtos p ON p.id = n.produto_id
      LEFT JOIN produto_fornecedor pf
             ON pf.produto_id = n.produto_id AND pf.fornecedor_id = n.fornecedor_id
     WHERE n.status = 'PENDENTE'
       AND n.quantidade_sugerida > 0
     ORDER BY CASE n.prioridade::text
                WHEN 'CRITICA' THEN 1 WHEN 'ALTA' THEN 2
                WHEN 'MEDIA' THEN 3 ELSE 4 END,
              n.quantidade_sugerida DESC`);

  return emitir('necessidades', rows.map((r) => ({
    // Critica virou tipo proprio: quem trata "abrir cotacao ja" nao e quem
    // trata "analisar a necessidade quando der".
    tipo: r.prioridade === 'CRITICA'
      ? ('PURCHASE_NEED_CRITICAL' as const) : ('PURCHASE_NEED_CREATED' as const),
    origem: 'COMPRAS' as const,
    entidade: 'produto',
    entidade_id: Number(r.produto_id),
    payload: {
      sku: r.codigo,
      produto_nome: r.descricao,
      necessidade_id: Number(r.id),
      quantidade: Number(r.quantidade_sugerida),
      prioridade: r.prioridade,
      fornecedor_id: r.fornecedor_id === null ? null : Number(r.fornecedor_id),
      valor: r.valor === null ? null : Number(r.valor),
      necessidades_do_fornecedor: r.fornecedor_id === null
        ? 0 : Number(r.necessidades_do_fornecedor),
    },
  })), contexto, rows.length);
}

/** Cotacao aberta que passou da data limite sem resposta. */
export async function cotacoesVencidas(contexto: ContextoSessao): Promise<ResultadoDeteccao> {
  const { rows } = await query<{
    id: string; numero: string; data_limite: string; dias: string; fornecedores: string;
    respostas: string;
  }>(`
    SELECT c.id, c.numero, c.data_limite::text AS data_limite,
           (CURRENT_DATE - c.data_limite)::text AS dias,
           count(DISTINCT cf.fornecedor_id)::text AS fornecedores,
           count(DISTINCT cf.fornecedor_id) FILTER (
             WHERE cf.status::text IN ('RESPONDIDA', 'PARCIALMENTE_RESPONDIDA')
           )::text AS respostas
      FROM cotacoes c
      LEFT JOIN cotacao_fornecedores cf ON cf.cotacao_id = c.id
     WHERE c.status::text IN ('ABERTA', 'ENVIADA', 'AGUARDANDO_RESPOSTAS')
       AND c.data_limite IS NOT NULL
       AND c.data_limite < CURRENT_DATE
     GROUP BY c.id, c.numero, c.data_limite
     ORDER BY c.data_limite`);

  return emitir('cotacoes_vencidas', rows.map((r) => ({
    tipo: 'QUOTE_OVERDUE' as const,
    origem: 'COTACOES' as const,
    entidade: 'cotacao',
    entidade_id: Number(r.id),
    payload: {
      numero: r.numero,
      data_limite: r.data_limite,
      dias_atraso: Number(r.dias),
      fornecedores_convidados: Number(r.fornecedores),
      respostas: Number(r.respostas),
    },
  })), contexto, rows.length);
}

/** Pedido com promessa vencida e saldo pendente, pela visao do modulo 08. */
export async function pedidosAtrasados(contexto: ContextoSessao): Promise<ResultadoDeteccao> {
  const { rows } = await query<{
    ordem_compra_id: string; ordem_compra: string; fornecedor: string;
    fornecedor_id: string; dias_atraso: string; itens: string; valor: string;
  }>(`
    SELECT ordem_compra_id, ordem_compra, fornecedor, fornecedor_id,
           max(dias_atraso)::text  AS dias_atraso,
           count(*)::text          AS itens,
           sum(valor_total)::text  AS valor
      FROM vw_compras_abertas
     WHERE dias_atraso > 0 AND quantidade_pendente > 0
     GROUP BY ordem_compra_id, ordem_compra, fornecedor, fornecedor_id
     ORDER BY max(dias_atraso) DESC`);

  return emitir('pedidos_atrasados', rows.map((r) => ({
    tipo: 'PO_LATE' as const,
    origem: 'PEDIDOS' as const,
    entidade: 'ordem_compra',
    entidade_id: Number(r.ordem_compra_id),
    payload: {
      numero: r.ordem_compra,
      fornecedor_nome: r.fornecedor,
      fornecedor_id: Number(r.fornecedor_id),
      dias_atraso: Number(r.dias_atraso),
      itens_pendentes: Number(r.itens),
      valor: Number(r.valor),
    },
  })), contexto, rows.length);
}

/** Pedido enviado sem confirmacao do fornecedor apos o prazo configurado. */
export async function pedidosSemConfirmacao(
  contexto: ContextoSessao,
): Promise<ResultadoDeteccao> {
  const prazo = await numero('confirmacao_prazo_dias', 2);

  const { rows } = await query<{
    id: string; numero: string; fornecedor: string; fornecedor_id: string;
    dias: string; valor: string | null;
  }>(`
    SELECT o.id, o.numero, f.razao_social AS fornecedor, o.fornecedor_id,
           (CURRENT_DATE - coalesce(o.data_envio::date, o.data_emissao))::text AS dias,
           o.valor_total::text AS valor
      FROM ordens_compra o
      JOIN fornecedores f ON f.id = o.fornecedor_id
     WHERE o.status::text = 'ENVIADA'
       AND o.data_confirmacao IS NULL
       AND coalesce(o.data_envio::date, o.data_emissao) <= CURRENT_DATE - $1::int
     ORDER BY coalesce(o.data_envio::date, o.data_emissao)`, [prazo]);

  return emitir('pedidos_sem_confirmacao', rows.map((r) => ({
    tipo: 'PO_UNCONFIRMED' as const,
    origem: 'PEDIDOS' as const,
    entidade: 'ordem_compra',
    entidade_id: Number(r.id),
    payload: {
      numero: r.numero,
      fornecedor_nome: r.fornecedor,
      fornecedor_id: Number(r.fornecedor_id),
      // Dois nomes para o mesmo numero, de proposito: `dias_atraso` e o campo
      // generico que as mensagens usam, `dias_sem_confirmacao` e como a regra
      // deste evento pergunta. Um alias custa um campo; um nome errado custa
      // uma regra que nunca dispara.
      dias_atraso: Number(r.dias),
      dias_sem_confirmacao: Number(r.dias),
      valor: r.valor === null ? null : Number(r.valor),
    },
  })), contexto, rows.length, { limite: prazo });
}

/** Entrega programada que passou da data prometida sem chegar. */
export async function entregasAtrasadas(contexto: ContextoSessao): Promise<ResultadoDeteccao> {
  const { rows } = await query<{
    id: string; numero: string | null; ordem_compra_id: string; numero_pedido: string;
    fornecedor: string; fornecedor_id: string; dias: string;
  }>(`
    SELECT e.id, e.numero, e.ordem_compra_id, o.numero AS numero_pedido,
           f.razao_social AS fornecedor, o.fornecedor_id,
           (CURRENT_DATE - coalesce(e.data_prometida, e.data_prevista))::text AS dias
      FROM entregas e
      JOIN ordens_compra o ON o.id = e.ordem_compra_id
      JOIN fornecedores  f ON f.id = o.fornecedor_id
     WHERE e.data_real IS NULL
       AND e.status::text NOT IN ('CANCELADA', 'ENTREGUE')
       AND coalesce(e.data_prometida, e.data_prevista) < CURRENT_DATE
     ORDER BY coalesce(e.data_prometida, e.data_prevista)`);

  return emitir('entregas_atrasadas', rows.map((r) => ({
    tipo: 'DELIVERY_LATE' as const,
    origem: 'LOGISTICA' as const,
    entidade: 'entrega',
    entidade_id: Number(r.id),
    payload: {
      numero: r.numero ?? r.numero_pedido,
      ordem_compra_id: Number(r.ordem_compra_id),
      fornecedor_nome: r.fornecedor,
      fornecedor_id: Number(r.fornecedor_id),
      dias_atraso: Number(r.dias),
    },
  })), contexto, rows.length);
}

// ---------------------------------------------------------------------------
// Fornecedores e precos
// ---------------------------------------------------------------------------

/**
 * Queda de performance: OTIF abaixo do limite, com base minima de entregas.
 *
 * A base minima nao e detalhe. Um fornecedor com uma entrega atrasada tem OTIF
 * 0% e seria o pior da base - sem base, o detector acusaria justamente quem
 * ainda nao teve chance de mostrar como opera.
 */
export async function performanceFornecedor(
  contexto: ContextoSessao,
): Promise<ResultadoDeteccao> {
  const limite = await numero('otif_minimo_percentual', 80);
  const baseMinima = await numero('base_minima_entregas', 5);

  const { rows } = await query<{
    fornecedor_id: string; fornecedor: string; otif_percentual: string;
    entregas_total: string; media_dias_atraso: string | null;
    qualidade_percentual: string | null;
  }>(`
    SELECT fornecedor_id, fornecedor, otif_percentual, entregas_total,
           media_dias_atraso, qualidade_percentual
      FROM vw_performance_fornecedores
     WHERE ativo
       AND entregas_total >= $2
       AND otif_percentual IS NOT NULL
       AND otif_percentual < $1
     ORDER BY otif_percentual`, [limite, baseMinima]);

  return emitir('performance_fornecedor', rows.map((r) => ({
    tipo: 'SUPPLIER_PERFORMANCE_DROP' as const,
    origem: 'FORNECEDORES' as const,
    entidade: 'fornecedor',
    entidade_id: Number(r.fornecedor_id),
    payload: {
      fornecedor_nome: r.fornecedor,
      otif: Number(r.otif_percentual),
      entregas: Number(r.entregas_total),
      dias_atraso_medio: r.media_dias_atraso === null ? null : Number(r.media_dias_atraso),
      qualidade: r.qualidade_percentual === null ? null : Number(r.qualidade_percentual),
      limite,
    },
  })), contexto, rows.length, { limite });
}

/** Produto com demanda atendido por um unico fornecedor: risco de concentracao. */
export async function fornecedorUnico(contexto: ContextoSessao): Promise<ResultadoDeteccao> {
  const { rows } = await query<{
    produto_id: string; codigo: string; descricao: string; fornecedor: string;
    fornecedor_id: string; demanda: string;
  }>(`
    WITH unico AS (
      SELECT pf.produto_id, min(pf.fornecedor_id) AS fornecedor_id
        FROM produto_fornecedor pf
       WHERE pf.ativo
       GROUP BY pf.produto_id
      HAVING count(*) = 1
    )
    SELECT v.produto_id, v.codigo, v.descricao, f.razao_social AS fornecedor,
           f.id AS fornecedor_id, v.demanda_media_diaria AS demanda
      FROM vw_estoque_atual v
      JOIN unico        u ON u.produto_id = v.produto_id
      JOIN fornecedores f ON f.id = u.fornecedor_id
     WHERE v.demanda_media_diaria > 0
     ORDER BY v.demanda_media_diaria DESC`);

  return emitir('fornecedor_unico', rows.map((r) => ({
    tipo: 'SUPPLIER_SINGLE_SOURCE' as const,
    origem: 'FORNECEDORES' as const,
    entidade: 'produto',
    entidade_id: Number(r.produto_id),
    payload: {
      sku: r.codigo,
      produto_nome: r.descricao,
      fornecedor_nome: r.fornecedor,
      fornecedor_id: Number(r.fornecedor_id),
      demanda_diaria: Number(r.demanda),
    },
  })), contexto, rows.length);
}

/**
 * Aumento anormal de preco.
 *
 * Compara o preco atual com a MEDIANA dos ultimos registros, nao com a media -
 * a mediana nao se desloca por causa de uma compra emergencial caseira, que e
 * exatamente o tipo de ponto que existe no historico real.
 */
export async function aumentoPreco(contexto: ContextoSessao): Promise<ResultadoDeteccao> {
  const limite = await numero('variacao_preco_percentual', 15);
  const janela = await numero('variacao_preco_dias', 180);

  const { rows } = await query<{
    produto_id: string; codigo: string; descricao: string; fornecedor_id: string;
    fornecedor: string; preco_atual: string; mediana: string; variacao: string;
    registros: string;
  }>(`
    WITH hist AS (
      SELECT h.produto_id, h.fornecedor_id,
             (percentile_cont(0.5) WITHIN GROUP (
               ORDER BY coalesce(h.custo_efetivo, h.preco_unitario)))::numeric AS mediana,
             count(*) AS registros
        FROM historico_precos h
       WHERE h.data >= CURRENT_DATE - $2::int
         AND coalesce(h.custo_efetivo, h.preco_unitario) > 0
       GROUP BY h.produto_id, h.fornecedor_id
      HAVING count(*) >= 3
    )
    SELECT pf.produto_id, p.codigo, p.descricao, pf.fornecedor_id,
           f.razao_social AS fornecedor, pf.preco_atual::text AS preco_atual,
           round(hist.mediana, 4)::text AS mediana,
           round((pf.preco_atual - hist.mediana) / hist.mediana * 100, 1)::text AS variacao,
           hist.registros::text AS registros
      FROM produto_fornecedor pf
      JOIN hist ON hist.produto_id = pf.produto_id
               AND hist.fornecedor_id = pf.fornecedor_id
      JOIN produtos     p ON p.id = pf.produto_id
      JOIN fornecedores f ON f.id = pf.fornecedor_id
     WHERE pf.ativo AND pf.preco_atual IS NOT NULL AND hist.mediana > 0
       AND (pf.preco_atual - hist.mediana) / hist.mediana * 100 >= $1
     ORDER BY (pf.preco_atual - hist.mediana) / hist.mediana DESC`, [limite, janela]);

  // Este detector tem o pre-filtro mais exigente de todos: precisa de preco
  // atual cadastrado E de pelo menos tres precos historicos do mesmo par
  // produto-fornecedor. Quando ele nao acha nada, a pergunta seguinte e sempre
  // "porque esta tudo normal ou porque nao havia base?" - e a resposta vem aqui,
  // com a maior variacao observada ao lado do limite que a definiu.
  const { rows: base } = await query<{ pares: string; maior: string | null }>(`
    WITH hist AS (
      SELECT h.produto_id, h.fornecedor_id,
             (percentile_cont(0.5) WITHIN GROUP (
               ORDER BY coalesce(h.custo_efetivo, h.preco_unitario)))::numeric AS mediana
        FROM historico_precos h
       WHERE h.data >= CURRENT_DATE - $1::int
         AND coalesce(h.custo_efetivo, h.preco_unitario) > 0
       GROUP BY h.produto_id, h.fornecedor_id
      HAVING count(*) >= 3
    )
    SELECT count(*)::text AS pares,
           round(max((pf.preco_atual - hist.mediana) / hist.mediana * 100), 1)::text AS maior
      FROM produto_fornecedor pf
      JOIN hist ON hist.produto_id = pf.produto_id
               AND hist.fornecedor_id = pf.fornecedor_id
     WHERE pf.ativo AND pf.preco_atual IS NOT NULL AND hist.mediana > 0`, [janela]);

  const pares = Number(base[0]?.pares ?? 0);
  const maior = base[0]?.maior === null || base[0]?.maior === undefined
    ? null : Number(base[0].maior);

  const motivo = rows.length > 0 ? undefined
    : pares === 0
      ? 'Nenhum par produto-fornecedor tem preco atual cadastrado e ao menos tres '
        + `precos historicos nos ultimos ${janela} dias: sem base para comparar`
      : `${pares} pares avaliados; a maior alta foi de ${maior}% contra um limite `
        + `de ${limite}%. Nenhum aumento anormal - ausencia de evento aqui e boa noticia.`;

  return emitir('aumento_preco', rows.map((r) => ({
    tipo: 'PRICE_INCREASE' as const,
    origem: 'FORNECEDORES' as const,
    entidade: 'produto',
    entidade_id: Number(r.produto_id),
    chave: eventos.chavePadrao('PRICE_INCREASE', 'produto', Number(r.produto_id),
      `f${r.fornecedor_id}`),
    payload: {
      sku: r.codigo,
      produto_nome: r.descricao,
      fornecedor_nome: r.fornecedor,
      fornecedor_id: Number(r.fornecedor_id),
      preco_atual: Number(r.preco_atual),
      mediana_historica: Number(r.mediana),
      variacao_percentual: Number(r.variacao),
      registros_base: Number(r.registros),
      limite,
    },
  })), contexto, rows.length, {
    limite,
    base: pares,
    ...(motivo ? { motivo_sem_evento: motivo } : {}),
  });
}

// ---------------------------------------------------------------------------
// Qualidade e recebimento
// ---------------------------------------------------------------------------

/** Nao conformidade aberta, registrada pelo modulo 09. */
export async function naoConformidades(contexto: ContextoSessao): Promise<ResultadoDeteccao> {
  const { rows } = await query<{
    id: string; numero: string | null; fornecedor: string | null;
    fornecedor_id: string | null; severidade: string | null; descricao: string | null;
  }>(`
    SELECT nc.id, nc.numero, f.razao_social AS fornecedor, nc.fornecedor_id,
           nc.severidade::text AS severidade, nc.descricao
      FROM nao_conformidades nc
      LEFT JOIN fornecedores f ON f.id = nc.fornecedor_id
     WHERE nc.status::text NOT IN ('ENCERRADA', 'CANCELADA', 'RESOLVIDA', 'VALIDADA')
     ORDER BY nc.created_at DESC`);

  return emitir('nao_conformidades', rows.map((r) => ({
    tipo: 'QUALITY_NONCONFORMITY' as const,
    origem: 'QUALIDADE' as const,
    entidade: 'nao_conformidade',
    entidade_id: Number(r.id),
    payload: {
      numero: r.numero,
      fornecedor_nome: r.fornecedor,
      fornecedor_id: r.fornecedor_id === null ? null : Number(r.fornecedor_id),
      severidade: r.severidade,
      descricao: r.descricao,
    },
  })), contexto, rows.length);
}

/** Recebimento com divergencia ainda sem tratamento. */
export async function divergenciasRecebimento(
  contexto: ContextoSessao,
): Promise<ResultadoDeteccao> {
  const { rows } = await query<{
    id: string; numero: string | null; fornecedor: string | null;
    fornecedor_id: string | null; divergencias: string;
  }>(`
    SELECT r.id, r.numero, f.razao_social AS fornecedor, r.fornecedor_id,
           count(*)::text AS divergencias
      FROM recebimentos r
      JOIN recebimento_itens ri ON ri.recebimento_id = r.id
      LEFT JOIN fornecedores f ON f.id = r.fornecedor_id
     WHERE r.status::text NOT IN ('CONCLUIDO', 'CANCELADO', 'APROVADO', 'DEVOLVIDO')
       AND (coalesce(ri.quantidade_rejeitada, 0) > 0
            OR ri.motivo_divergencia IS NOT NULL
            OR (ri.quantidade_recebida IS NOT NULL
                AND ri.quantidade_recebida <> ri.quantidade_pedida))
     GROUP BY r.id, r.numero, f.razao_social, r.fornecedor_id
     ORDER BY r.id DESC`);

  return emitir('divergencias_recebimento', rows.map((r) => ({
    tipo: 'RECEIPT_DIVERGENCE' as const,
    origem: 'RECEBIMENTO' as const,
    entidade: 'recebimento',
    entidade_id: Number(r.id),
    payload: {
      numero: r.numero,
      fornecedor_nome: r.fornecedor,
      fornecedor_id: r.fornecedor_id === null ? null : Number(r.fornecedor_id),
      itens_divergentes: Number(r.divergencias),
    },
  })), contexto, rows.length);
}

// ---------------------------------------------------------------------------
// IA
// ---------------------------------------------------------------------------

/** Recomendacao criada pela IA e ainda nao decidida (modulo 12). */
export async function recomendacoesIa(contexto: ContextoSessao): Promise<ResultadoDeteccao> {
  const { rows } = await query<{
    id: string; tipo: string; titulo: string; prioridade: string | null;
    confianca: string | null; produto_id: string | null; impacto: string | null;
  }>(`
    SELECT id, tipo::text AS tipo, titulo, prioridade::text AS prioridade,
           confianca::text AS confianca, produto_id,
           impacto_estimado::text AS impacto
      FROM ia_recomendacoes
     WHERE status::text IN ('NOVA', 'EM_ANALISE')
     ORDER BY created_at DESC`);

  return emitir('recomendacoes_ia', rows.map((r) => ({
    tipo: 'AI_RECOMMENDATION_CREATED' as const,
    origem: 'IA' as const,
    entidade: 'ia_recomendacao',
    entidade_id: Number(r.id),
    payload: {
      recomendacao_tipo: r.tipo,
      nome: r.titulo,
      prioridade: r.prioridade,
      nivel: r.prioridade,
      confianca: r.confianca,
      produto_id: r.produto_id === null ? null : Number(r.produto_id),
      impacto_financeiro: r.impacto === null ? null : Number(r.impacto),
    },
  })), contexto, rows.length);
}

// ---------------------------------------------------------------------------
// Grupos, como os jobs os chamam
// ---------------------------------------------------------------------------

type Detector = (c: ContextoSessao) => Promise<ResultadoDeteccao>;

export const CATALOGO: Record<string, Detector> = {
  ruptura,
  risco_ruptura: riscoRuptura,
  excesso,
  validade,
  saldo_negativo: saldoNegativo,
  necessidades,
  cotacoes_vencidas: cotacoesVencidas,
  pedidos_atrasados: pedidosAtrasados,
  pedidos_sem_confirmacao: pedidosSemConfirmacao,
  entregas_atrasadas: entregasAtrasadas,
  performance_fornecedor: performanceFornecedor,
  fornecedor_unico: fornecedorUnico,
  aumento_preco: aumentoPreco,
  nao_conformidades: naoConformidades,
  divergencias_recebimento: divergenciasRecebimento,
  recomendacoes_ia: recomendacoesIa,
};

/** Os criticos, que rodam de hora em hora. */
export const GRUPO_CRITICO = ['ruptura', 'saldo_negativo', 'pedidos_atrasados'];

export const GRUPO_ESTOQUE = [
  'ruptura', 'risco_ruptura', 'excesso', 'validade', 'saldo_negativo',
];

export const GRUPO_PEDIDOS = [
  'necessidades', 'cotacoes_vencidas', 'pedidos_atrasados',
  'pedidos_sem_confirmacao', 'entregas_atrasadas', 'divergencias_recebimento',
];

export const GRUPO_FORNECEDORES = [
  'performance_fornecedor', 'fornecedor_unico', 'aumento_preco', 'nao_conformidades',
];

export const GRUPO_IA = ['recomendacoes_ia'];

/**
 * Roda um grupo de detectores.
 *
 * Um detector que falha nao derruba os outros: a ruptura precisa ser detectada
 * mesmo que a consulta de precos esteja com problema. Cada falha vira uma linha
 * no resultado, para o centro de operacoes mostrar qual detector esta quebrado.
 */
export async function rodarGrupo(
  nomes: string[], contexto: ContextoSessao,
): Promise<{
  resultados: ResultadoDeteccao[];
  erros: Array<{ detector: string; erro: string }>;
  eventos: number;
  novos: number;
}> {
  const resultados: ResultadoDeteccao[] = [];
  const erros: Array<{ detector: string; erro: string }> = [];

  for (const nome of nomes) {
    const detector = CATALOGO[nome];
    if (!detector) {
      erros.push({ detector: nome, erro: 'Detector nao existe no catalogo' });
      continue;
    }
    try {
      resultados.push(await detector(contexto));
    } catch (erro) {
      erros.push({
        detector: nome,
        erro: erro instanceof Error ? erro.message : String(erro),
      });
    }
  }

  return {
    resultados,
    erros,
    eventos: resultados.reduce((a, r) => a + r.eventos, 0),
    novos: resultados.reduce((a, r) => a + r.novos, 0),
  };
}
