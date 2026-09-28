/**
 * O motor de necessidade de compra.
 *
 * Fica em SQL, e nao em TypeScript, por dois motivos: sao milhares de produtos
 * por execucao, e cada parcela da conta precisa sair na mesma linha do
 * resultado para alimentar a memoria de calculo exigida pela secao 49 do
 * prompt 05 ("como essa quantidade foi calculada?").
 *
 * O mesmo SQL serve ao planejamento oficial e ao simulador: o que muda sao os
 * fatores de ajuste (demanda, lead time, seguranca), nunca a formula.
 */

/** Ordem dos parametros esperada por `SQL_CALCULO`. */
export interface ParametrosCalculo {
  horizonteDias: number;
  estrategiaPadrao: string;
  diasSeguranca: number;
  coberturaAlvoDias: number;
  leadTimePadrao: number;
  diasRecebimento: number;
  usarDiasUteis: boolean;
  limiteExcessoCobertura: number;
  somarSegurancaAoAlvo: boolean;
  fatorDemanda: number;      // 1 = sem ajuste; simulacao usa 1.1, 0.9, ...
  leadTimeExtra: number;     // dias somados ao lead time (simulacao)
  fatorSeguranca: number;    // multiplica o estoque de seguranca (simulacao)
  localId: number | null;
  categoriaId: number | null;
  produtoId: number | null;
  fornecedorId: number | null;
  diasAtrasoAlerta: number;
  pesoRuptura: number;
  pesoCobertura: number;
  pesoAbc: number;
  pesoLeadTime: number;
}

export function valoresCalculo(p: ParametrosCalculo): unknown[] {
  return [
    p.horizonteDias, p.estrategiaPadrao, p.diasSeguranca, p.coberturaAlvoDias,
    p.leadTimePadrao, p.diasRecebimento, p.usarDiasUteis, p.limiteExcessoCobertura,
    p.somarSegurancaAoAlvo, p.fatorDemanda, p.leadTimeExtra, p.fatorSeguranca,
    p.localId, p.categoriaId, p.produtoId, p.fornecedorId, p.diasAtrasoAlerta,
    p.pesoRuptura, p.pesoCobertura, p.pesoAbc, p.pesoLeadTime,
  ];
}

/**
 * Devolve uma linha por produto elegivel, com todas as parcelas da conta.
 * Nao filtra por "tem necessidade": quem decide isso e quem consome, porque o
 * dashboard precisa contar tambem os produtos sem necessidade e os em excesso.
 */
export const SQL_CALCULO = `
WITH cfg AS (
  SELECT $1::int          AS horizonte,
         $2::estrategia_reposicao_enum AS estrategia_padrao,
         $3::numeric      AS dias_seguranca,
         $4::int          AS cobertura_alvo,
         $5::int          AS lead_time_padrao,
         $6::int          AS dias_recebimento,
         $7::boolean      AS uteis,
         $8::numeric      AS limite_excesso,
         $9::boolean      AS soma_seguranca,
         $10::numeric     AS fator_demanda,
         $11::int         AS lead_extra,
         $12::numeric     AS fator_seguranca,
         $17::int         AS dias_atraso,
         $18::numeric     AS peso_ruptura,
         $19::numeric     AS peso_cobertura,
         $20::numeric     AS peso_abc,
         $21::numeric     AS peso_lead
),
-- Saldo do local planejado (ou da empresa toda quando nenhum local e informado)
saldo AS (
  SELECT e.produto_id,
         sum(e.quantidade_fisica)     AS fisico,
         sum(e.quantidade_disponivel) AS disponivel,
         sum(e.quantidade_reservada)  AS reservado,
         sum(e.quantidade_em_transito) AS transito
    FROM estoques e
   WHERE $13::bigint IS NULL OR e.local_id = $13::bigint
   GROUP BY e.produto_id
),
-- Saldo parado em outro local: antes de comprar, vale olhar (secao 23)
outro_local AS (
  SELECT DISTINCT ON (e.produto_id)
         e.produto_id, e.local_id, e.quantidade_disponivel AS disponivel
    FROM estoques e
   WHERE $13::bigint IS NOT NULL
     AND e.local_id <> $13::bigint
     AND e.quantidade_disponivel > 0
   ORDER BY e.produto_id, e.quantidade_disponivel DESC
),
-- Demanda: previsao validada, senao media realizada, senao parametro manual
previsao AS (
  SELECT DISTINCT ON (produto_id)
         produto_id, demanda_diaria, confiabilidade
    FROM previsoes_demanda
   WHERE periodo_fim >= CURRENT_DATE AND demanda_diaria IS NOT NULL
   ORDER BY produto_id, periodo_inicio DESC, versao DESC
),
referencia AS (SELECT max(data_venda) AS fim FROM mv_demanda_diaria),
media AS (
  SELECT d.produto_id, sum(d.quantidade) / 90.0 AS diaria
    FROM mv_demanda_diaria d, referencia r
   WHERE d.data_venda > r.fim - 90
   GROUP BY d.produto_id
),
-- Compras ja confirmadas: so o saldo pendente conta como entrada futura (secao 21)
abertos AS (
  SELECT i.produto_id,
         sum(greatest(0, i.quantidade_pedida - coalesce(i.quantidade_recebida, 0))) AS saldo,
         bool_or(oc.data_prevista_entrega < CURRENT_DATE - (SELECT dias_atraso FROM cfg)) AS atrasado
    FROM ordem_compra_itens i
    JOIN ordens_compra oc ON oc.id = i.ordem_compra_id
   WHERE oc.status IN ('APROVADA', 'ENVIADA', 'CONFIRMADA', 'EM_PRODUCAO',
                       'EM_TRANSITO', 'RECEBIMENTO_PARCIAL')
   GROUP BY i.produto_id
),
-- Fornecedor de referencia: o principal; empatado, o de menor preco
forn AS (
  SELECT DISTINCT ON (pf.produto_id)
         pf.produto_id, pf.fornecedor_id, pf.lead_time_dias, pf.preco_atual,
         pf.moq, pf.multiplo_compra, pf.frete_estimado,
         f.razao_social, f.origem_fornecedor,
         coalesce(f.transit_time_dias, 0)  AS transit,
         coalesce(f.desembaraco_dias, 0)   AS desembaraco,
         coalesce(f.recebimento_dias, 0)   AS receb_fornecedor
    FROM produto_fornecedor pf
    JOIN fornecedores f ON f.id = pf.fornecedor_id
   WHERE pf.ativo AND f.ativo AND f.deleted_at IS NULL
   ORDER BY pf.produto_id, pf.fornecedor_principal DESC, pf.preco_atual ASC NULLS LAST
),
base AS (
  SELECT
    p.id AS produto_id, p.codigo, p.descricao, p.categoria_id,
    p.classificacao_abc, p.classificacao_xyz,
    p.unidade_compra_id, p.unidade_estoque_id,
    greatest(coalesce(p.fator_conversao, 1), 0.0001) AS fator_conversao,
    coalesce(s.disponivel, 0) AS estoque_disponivel,
    coalesce(s.fisico, 0)     AS estoque_fisico,
    coalesce(s.transito, 0)   AS estoque_transito,
    coalesce(a.saldo, 0)      AS compra_em_aberto,
    coalesce(a.atrasado, false) AS pedido_atrasado,
    ol.disponivel AS transferencia_possivel,
    ol.local_id   AS transferencia_local_id,
    f.fornecedor_id, f.frete_estimado, f.origem_fornecedor,
    -- Preco: o contrato com o fornecedor manda. Sem contrato, o ultimo custo do
    -- ERP entra como referencia, e a origem fica registrada para o comprador
    -- saber que aquilo e estimativa, nao preco negociado.
    coalesce(f.preco_atual, p.custo_referencia) AS preco_atual,
    CASE WHEN f.preco_atual IS NOT NULL THEN 'FORNECEDOR'
         WHEN p.custo_referencia IS NOT NULL THEN 'CUSTO_ERP'
         ELSE 'SEM_PRECO' END AS origem_preco,
    -- MOQ e multiplo do contrato com o fornecedor; na falta, o do cadastro do produto
    coalesce(f.moq, pe.moq, p.moq)                           AS moq,
    coalesce(f.multiplo_compra, pe.multiplo_compra, p.multiplo_compra) AS multiplo,
    coalesce(pe.estrategia_reposicao, (SELECT estrategia_padrao FROM cfg)) AS estrategia,
    pe.estoque_minimo, pe.estoque_maximo, pe.ponto_pedido AS ponto_pedido_param,
    pe.estoque_seguranca AS seguranca_param,
    coalesce(pe.cobertura_alvo_dias, (SELECT cobertura_alvo FROM cfg)) AS cobertura_alvo,
    coalesce(pe.dias_seguranca, (SELECT dias_seguranca FROM cfg))      AS dias_seguranca,
    -- Lead time total: fornecedor, transporte, desembaraco e recebimento (secao 30)
    coalesce(nullif(f.lead_time_dias, 0), nullif(pe.lead_time_dias, 0),
             nullif(p.lead_time_padrao_dias, 0), (SELECT lead_time_padrao FROM cfg)) AS lead_time_dias,
    coalesce(f.transit, 0) + coalesce(f.desembaraco, 0)
      + coalesce(nullif(f.receb_fornecedor, 0), (SELECT dias_recebimento FROM cfg)) AS lead_time_extra_forn,
    -- Demanda: prioridade previsao > media realizada > parametro manual
    CASE WHEN pv.demanda_diaria IS NOT NULL THEN pv.demanda_diaria
         WHEN m.diaria IS NOT NULL         THEN m.diaria
         WHEN pe.demanda_media_diaria IS NOT NULL THEN pe.demanda_media_diaria
         ELSE 0 END * (SELECT fator_demanda FROM cfg) AS demanda_diaria,
    CASE WHEN pv.demanda_diaria IS NOT NULL THEN 'PREVISAO_VALIDADA'
         WHEN m.diaria IS NOT NULL          THEN 'DEMANDA_MEDIA'
         WHEN pe.demanda_media_diaria IS NOT NULL THEN 'PARAMETRO_MANUAL'
         ELSE 'SEM_BASE' END::origem_demanda_enum AS origem_demanda,
    pv.confiabilidade AS previsao_confiabilidade
  FROM produtos p
  LEFT JOIN saldo s              ON s.produto_id = p.id
  LEFT JOIN abertos a            ON a.produto_id = p.id
  LEFT JOIN outro_local ol       ON ol.produto_id = p.id
  LEFT JOIN forn f               ON f.produto_id = p.id
  LEFT JOIN parametros_estoque pe ON pe.produto_id = p.id
  LEFT JOIN previsao pv          ON pv.produto_id = p.id
  LEFT JOIN media m              ON m.produto_id = p.id
 WHERE p.deleted_at IS NULL AND p.ativo
   AND ($14::bigint IS NULL OR p.categoria_id = $14::bigint)
   AND ($15::bigint IS NULL OR p.id = $15::bigint)
   AND ($16::bigint IS NULL OR f.fornecedor_id = $16::bigint)
),
conta AS (
  SELECT b.*,
    c.horizonte, c.uteis, c.limite_excesso,
    (b.lead_time_dias + b.lead_time_extra_forn + c.lead_extra)::int AS lead_time_total,
    b.demanda_diaria * c.horizonte AS demanda_periodo,
    b.demanda_diaria * (b.lead_time_dias + b.lead_time_extra_forn + c.lead_extra) AS demanda_lead_time,
    -- Seguranca: o parametro calculado, ou dias de cobertura da demanda
    coalesce(nullif(b.seguranca_param, 0), b.demanda_diaria * b.dias_seguranca)
      * c.fator_seguranca AS estoque_seguranca,
    b.estoque_disponivel + b.estoque_transito + b.compra_em_aberto AS posicao,
    c.soma_seguranca, c.peso_ruptura, c.peso_cobertura, c.peso_abc, c.peso_lead
  FROM base b CROSS JOIN cfg c
),
alvo AS (
  SELECT k.*,
    coalesce(nullif(k.ponto_pedido_param, 0), k.demanda_lead_time + k.estoque_seguranca) AS ponto_pedido,
    -- Estoque desejado ao fim do horizonte, conforme a estrategia do produto
    CASE k.estrategia
      WHEN 'PONTO_PEDIDO'      THEN k.estoque_seguranca
      WHEN 'ESTOQUE_MINIMO'    THEN coalesce(nullif(k.estoque_minimo, 0), k.estoque_seguranca)
      WHEN 'ESTOQUE_MAXIMO'    THEN coalesce(nullif(k.estoque_maximo, 0),
                                             k.demanda_diaria * k.cobertura_alvo)
      WHEN 'COBERTURA'         THEN k.demanda_diaria * k.cobertura_alvo
      WHEN 'DEMANDA_LEAD_TIME' THEN k.demanda_lead_time + k.estoque_seguranca
      ELSE 0
    END AS estoque_alvo,
    k.posicao - k.demanda_periodo                       AS estoque_projetado,
    k.posicao - k.demanda_lead_time                     AS projetado_lead_time,
    CASE WHEN k.demanda_diaria > 0 THEN k.posicao / k.demanda_diaria END AS dias_cobertura
  FROM conta k
),
necessidade AS (
  SELECT a.*,
    -- Gatilho: a estrategia decide SE compra; a formula decide QUANTO
    CASE a.estrategia
      WHEN 'PONTO_PEDIDO'      THEN a.posicao <= a.ponto_pedido
      WHEN 'ESTOQUE_MINIMO'    THEN a.estoque_projetado < coalesce(a.estoque_minimo, 0)
      WHEN 'ESTOQUE_MAXIMO'    THEN a.posicao < coalesce(nullif(a.estoque_maximo, 0),
                                                         a.demanda_diaria * a.cobertura_alvo)
      WHEN 'COBERTURA'         THEN coalesce(a.dias_cobertura, 0) < a.cobertura_alvo
      WHEN 'DEMANDA_LEAD_TIME' THEN a.projetado_lead_time < a.estoque_seguranca
      ELSE false
    END AS dispara,
    greatest(0,
      a.demanda_periodo
      + a.estoque_alvo
      + CASE WHEN a.soma_seguranca THEN a.estoque_seguranca ELSE 0 END
      - a.posicao
    ) AS necessidade_bruta
  FROM alvo a
),
arredondada AS (
  SELECT n.*,
    CASE WHEN n.dispara THEN n.necessidade_bruta ELSE 0 END AS necessidade_calculada,
    -- MOQ primeiro, multiplo depois, sempre para cima (secoes 16 a 18)
    CASE
      WHEN NOT n.dispara OR n.necessidade_bruta <= 0 THEN 0
      WHEN n.multiplo IS NULL OR n.multiplo <= 0
        THEN greatest(n.necessidade_bruta, coalesce(n.moq, 0))
      ELSE ceil(greatest(n.necessidade_bruta, coalesce(n.moq, 0)) / n.multiplo) * n.multiplo
    END AS quantidade_sugerida,
    -- Excesso: cobertura acima do limite configurado (secao 27)
    CASE WHEN n.demanda_diaria > 0
           AND n.posicao > n.demanda_diaria * n.limite_excesso
         THEN n.posicao - n.demanda_diaria * n.limite_excesso END AS excesso
  FROM necessidade n
)
SELECT
  r.*,
  -- Datas (secoes 14 e 15)
  CASE WHEN r.demanda_diaria > 0
       THEN fn_somar_prazo(CURRENT_DATE,
              greatest(0, floor((r.posicao - r.estoque_seguranca) / r.demanda_diaria))::int,
              r.uteis)
  END AS data_necessaria,
  CASE WHEN r.demanda_diaria > 0
       THEN fn_somar_prazo(
              fn_somar_prazo(CURRENT_DATE,
                greatest(0, floor((r.posicao - r.estoque_seguranca) / r.demanda_diaria))::int,
                r.uteis),
              -r.lead_time_total, r.uteis)
  END AS data_ideal_compra,
  fn_somar_prazo(CURRENT_DATE, r.lead_time_total, r.uteis) AS data_prevista_chegada,
  -- Prioridade (secao 24)
  CASE
    WHEN r.quantidade_sugerida <= 0                       THEN 'SEM_NECESSIDADE'
    WHEN r.estoque_disponivel <= 0                        THEN 'RUPTURA'
    WHEN r.projetado_lead_time < 0                        THEN 'CRITICA'
    WHEN r.posicao <= r.ponto_pedido                      THEN 'ALTA'
    WHEN r.estoque_projetado < r.estoque_alvo             THEN 'MEDIA'
    ELSE 'BAIXA'
  END::prioridade_compra_enum AS prioridade,
  -- Indice tecnico de prioridade (secao 25): pesos configuraveis, fatores visiveis
  round((
      CASE WHEN r.estoque_disponivel <= 0 THEN r.peso_ruptura ELSE 0 END
    + CASE WHEN r.dias_cobertura IS NULL THEN 0
           WHEN r.dias_cobertura <= 0 THEN r.peso_cobertura
           WHEN r.lead_time_total > 0 AND r.dias_cobertura < r.lead_time_total
             THEN r.peso_cobertura * (1 - r.dias_cobertura / r.lead_time_total)
           ELSE 0 END
    + CASE r.classificacao_abc WHEN 'A' THEN r.peso_abc
                               WHEN 'B' THEN r.peso_abc * 0.6
                               WHEN 'C' THEN r.peso_abc * 0.3 ELSE 0 END
    + CASE WHEN r.lead_time_total >= 60 THEN r.peso_lead
           WHEN r.lead_time_total >= 30 THEN r.peso_lead * 0.6
           ELSE r.peso_lead * 0.2 END
    + CASE WHEN r.pedido_atrasado THEN 10 ELSE 0 END
  )::numeric, 4) AS indice_prioridade,
  jsonb_build_array(
    jsonb_build_object('fator', 'ruptura', 'valor', r.estoque_disponivel <= 0, 'peso', r.peso_ruptura),
    jsonb_build_object('fator', 'cobertura_dias', 'valor', round(coalesce(r.dias_cobertura, 0)::numeric, 1), 'peso', r.peso_cobertura),
    jsonb_build_object('fator', 'curva_abc', 'valor', coalesce(r.classificacao_abc::text, 'SEM'), 'peso', r.peso_abc),
    jsonb_build_object('fator', 'lead_time_total', 'valor', r.lead_time_total, 'peso', r.peso_lead),
    jsonb_build_object('fator', 'pedido_atrasado', 'valor', r.pedido_atrasado, 'peso', 10)
  ) AS fatores_prioridade,
  -- Memoria de calculo: a conta inteira, parcela a parcela
  jsonb_build_object(
    'demanda_diaria',        round(r.demanda_diaria::numeric, 4),
    'origem_demanda',        r.origem_demanda,
    'horizonte_dias',        r.horizonte,
    'demanda_periodo',       round(r.demanda_periodo::numeric, 3),
    'estoque_disponivel',    round(r.estoque_disponivel::numeric, 3),
    'estoque_transito',      round(r.estoque_transito::numeric, 3),
    'compras_em_aberto',     round(r.compra_em_aberto::numeric, 3),
    'posicao',               round(r.posicao::numeric, 3),
    'estoque_seguranca',     round(r.estoque_seguranca::numeric, 3),
    'estoque_alvo',          round(r.estoque_alvo::numeric, 3),
    'seguranca_somada_por_fora', r.soma_seguranca,
    'estrategia',            r.estrategia,
    'disparou',              r.dispara,
    'necessidade_bruta',     round(r.necessidade_bruta::numeric, 3),
    'moq',                   r.moq,
    'multiplo',              r.multiplo,
    'quantidade_sugerida',   round(r.quantidade_sugerida::numeric, 3),
    'lead_time_fornecedor',  r.lead_time_dias,
    'lead_time_total',       r.lead_time_total,
    'preco_unitario',        r.preco_atual,
    'origem_preco',          r.origem_preco,
    'formula',               'necessidade = demanda_periodo + estoque_alvo'
                             || CASE WHEN r.soma_seguranca THEN ' + estoque_seguranca' ELSE '' END
                             || ' - (disponivel + transito + compras_em_aberto)'
  ) AS memoria_calculo,
  -- Alertas (secao 38)
  (
    CASE WHEN r.estoque_disponivel <= 0 THEN jsonb_build_array(jsonb_build_object('tipo','RUPTURA','mensagem','Produto sem saldo disponivel')) ELSE '[]'::jsonb END
    || CASE WHEN r.projetado_lead_time < 0 THEN jsonb_build_array(jsonb_build_object('tipo','RISCO_RUPTURA','mensagem','Estoque pode zerar dentro do lead time')) ELSE '[]'::jsonb END
    || CASE WHEN r.pedido_atrasado THEN jsonb_build_array(jsonb_build_object('tipo','COMPRA_ATRASADA','mensagem','Compra em atraso pode causar ruptura')) ELSE '[]'::jsonb END
    || CASE WHEN r.excesso IS NOT NULL THEN jsonb_build_array(jsonb_build_object('tipo','EXCESSO','mensagem','Cobertura acima do limite configurado')) ELSE '[]'::jsonb END
    || CASE WHEN r.moq IS NOT NULL AND r.necessidade_bruta > 0 AND r.necessidade_bruta < r.moq
            THEN jsonb_build_array(jsonb_build_object('tipo','MOQ','mensagem','Necessidade abaixo do minimo do fornecedor')) ELSE '[]'::jsonb END
    || CASE WHEN r.multiplo IS NOT NULL AND r.multiplo > 0 AND r.quantidade_sugerida <> r.necessidade_bruta AND r.quantidade_sugerida > 0
            THEN jsonb_build_array(jsonb_build_object('tipo','MULTIPLO','mensagem','Quantidade arredondada para o multiplo de compra')) ELSE '[]'::jsonb END
    || CASE WHEN r.compra_em_aberto > 0 AND r.quantidade_sugerida > 0
            THEN jsonb_build_array(jsonb_build_object('tipo','DUPLICIDADE','mensagem','Ja existe compra em aberto para este produto')) ELSE '[]'::jsonb END
    || CASE WHEN r.transferencia_possivel IS NOT NULL AND r.quantidade_sugerida > 0
            THEN jsonb_build_array(jsonb_build_object('tipo','TRANSFERENCIA_POSSIVEL','mensagem','Outro local possui saldo disponivel')) ELSE '[]'::jsonb END
    || CASE WHEN r.origem_preco = 'CUSTO_ERP' AND r.quantidade_sugerida > 0
            THEN jsonb_build_array(jsonb_build_object('tipo','PRECO_ESTIMADO','mensagem','Valor calculado pelo ultimo custo do ERP - nao ha preco de fornecedor')) ELSE '[]'::jsonb END
    || CASE WHEN r.origem_preco = 'SEM_PRECO' AND r.quantidade_sugerida > 0
            THEN jsonb_build_array(jsonb_build_object('tipo','SEM_PRECO','mensagem','Produto sem preco de fornecedor nem custo de referencia')) ELSE '[]'::jsonb END
    || CASE WHEN r.fornecedor_id IS NULL AND r.quantidade_sugerida > 0
            THEN jsonb_build_array(jsonb_build_object('tipo','SEM_FORNECEDOR','mensagem','Produto sem fornecedor ativo cadastrado')) ELSE '[]'::jsonb END
    || CASE WHEN r.previsao_confiabilidade IN ('BAIXA','INSUFICIENTE')
            THEN jsonb_build_array(jsonb_build_object('tipo','PREVISAO_INSTAVEL','mensagem','Previsao de baixa confiabilidade - revisar antes de aprovar compra')) ELSE '[]'::jsonb END
    || CASE WHEN r.origem_demanda = 'SEM_BASE'
            THEN jsonb_build_array(jsonb_build_object('tipo','SEM_HISTORICO','mensagem','Produto sem historico nem previsao')) ELSE '[]'::jsonb END
  ) AS alertas
FROM arredondada r
`;
