import { Router } from 'express';
import { ok, rota } from '../../core/http.js';
import { autenticar } from '../../middlewares/autenticar.js';
import { exigirPermissao } from '../../middlewares/autorizar.js';
import { query } from '../../config/database.js';

export const dashboardRouter = Router();
dashboardRouter.use(autenticar);

/**
 * Todos os numeros do painel saem do banco em uma unica ida — nada fixo
 * no frontend.
 */
dashboardRouter.get('/', exigirPermissao('dashboard.ler'), rota(async (_req, res) => {
  const { rows } = await query(`
    SELECT
      (SELECT count(*)::int FROM produtos WHERE deleted_at IS NULL AND ativo)        AS produtos_ativos,
      (SELECT count(*)::int FROM produtos WHERE deleted_at IS NULL)                  AS produtos_cadastrados,
      (SELECT count(*)::int FROM fornecedores WHERE deleted_at IS NULL AND ativo)    AS fornecedores_ativos,
      (SELECT COALESCE(SUM(quantidade_fisica), 0) FROM estoques)                     AS estoque_total,
      (SELECT count(*)::int FROM vw_produtos_criticos WHERE situacao = 'RUPTURA')    AS produtos_em_ruptura,
      (SELECT count(*)::int FROM vw_produtos_criticos
        WHERE situacao IN ('ABAIXO_MINIMO','ABAIXO_SEGURANCA'))                      AS produtos_abaixo_minimo,
      (SELECT count(*)::int FROM vw_produtos_criticos WHERE situacao = 'PONTO_PEDIDO') AS produtos_ponto_pedido,
      (SELECT count(*)::int FROM vw_produtos_criticos WHERE situacao = 'EXCESSO')    AS produtos_excesso,
      (SELECT count(DISTINCT ordem_compra_id)::int FROM vw_compras_abertas)          AS compras_em_aberto,
      (SELECT COALESCE(SUM(valor_total), 0) FROM ordens_compra
        WHERE status IN ('APROVADA','ENVIADA','CONFIRMADA','EM_PRODUCAO','EM_TRANSITO','RECEBIMENTO_PARCIAL'))
                                                                                     AS valor_em_aberto,
      (SELECT count(DISTINCT ordem_compra_id)::int FROM vw_compras_abertas WHERE dias_atraso > 0)
                                                                                     AS entregas_atrasadas,
      (SELECT count(*)::int FROM alertas WHERE status = 'ABERTO' AND severidade IN ('ALTA','CRITICA'))
                                                                                     AS alertas_criticos,
      (SELECT count(*)::int FROM alertas WHERE status = 'ABERTO')                    AS alertas_abertos,
      (SELECT count(*)::int FROM lotes
        WHERE status = 'DISPONIVEL' AND data_validade IS NOT NULL
          AND data_validade <= CURRENT_DATE + (fn_config_num('qualidade.dias_alerta_validade', 30))::int)
                                                                                     AS lotes_validade_proxima
  `);

  const criticos = await query(
    `SELECT produto_id, codigo, descricao, estoque_disponivel, cobertura_dias, situacao
       FROM vw_produtos_criticos WHERE situacao <> 'NORMAL'
      ORDER BY CASE situacao WHEN 'RUPTURA' THEN 1 WHEN 'ABAIXO_SEGURANCA' THEN 2
                             WHEN 'ABAIXO_MINIMO' THEN 3 ELSE 4 END, estoque_disponivel
      LIMIT 10`,
  );

  const alertas = await query(
    `SELECT id, tipo, severidade, mensagem, data_geracao FROM alertas
      WHERE status = 'ABERTO' ORDER BY
        CASE severidade WHEN 'CRITICA' THEN 1 WHEN 'ALTA' THEN 2 WHEN 'MEDIA' THEN 3 ELSE 4 END,
        data_geracao DESC LIMIT 10`,
  );

  return ok(res, {
    indicadores: rows[0],
    produtos_criticos: criticos.rows,
    alertas_recentes: alertas.rows,
  }, 'Indicadores do painel');
}));
