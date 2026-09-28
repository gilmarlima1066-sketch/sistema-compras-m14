import { Router } from 'express';
import { authRouter } from './modules/auth/auth.routes.js';
import { produtosRouter } from './modules/produtos/produtos.routes.js';
import { fornecedoresRouter } from './modules/fornecedores/fornecedores.routes.js';
import { estoqueRouter } from './modules/estoque/estoque.routes.js';
import { usuariosRouter } from './modules/usuarios/usuarios.routes.js';
import { cadastrosRouter } from './modules/cadastros/cadastros.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { auditoriaRouter } from './modules/auditoria/auditoria.routes.js';
import { demandaRouter } from './modules/demanda/demanda.routes.js';
import { planejamentoRouter } from './modules/planejamento/planejamento.routes.js';
import { cotacoesRouter } from './modules/cotacoes/cotacoes.routes.js';
import { negociacoesRouter, pedidosRouter } from './modules/negociacoes/negociacao.routes.js';
import {
  acompanhamentoPedidoRouter, entregasRouter, indicadoresRouter,
  performanceFornecedorRouter,
} from './modules/entregas/entregas.routes.js';
import {
  acoesNcRouter, devolucoesRouter, divergenciasRouter, naoConformidadesRouter,
  qualidadeFornecedorRouter, quarentenasRouter, recebimentoItensRouter, recebimentosRouter,
} from './modules/recebimento/recebimento.routes.js';
import {
  acoesPlanoRouter, alternativasRouter, avaliacaoRouter, avaliacoesRouter,
  metodologiasRouter, performanceFornecedorRouter as scorecardFornecedorRouter,
  planosRouter, situacoesRouter,
} from './modules/avaliacao/avaliacao.routes.js';
import {
  alertasBiRouter, dashboardBiRouter, kpisRouter,
} from './modules/bi/bi.routes.js';
import { iaRouter } from './modules/ia/ia.routes.js';
import { automacaoRouter, webhookRouter } from './modules/automacao/automacao.routes.js';
import { integracaoRouter } from './modules/integracao/integracao.routes.js';

/** Registro central de modulos da API. Cada modulo cuida das proprias rotas. */
export const rotas = Router();

rotas.use('/auth', authRouter);
rotas.use('/produtos', produtosRouter);
rotas.use('/fornecedores', fornecedoresRouter);
rotas.use('/estoque', estoqueRouter);
rotas.use('/usuarios', usuariosRouter);
rotas.use('/cadastros', cadastrosRouter);
rotas.use('/dashboard', dashboardRouter);
rotas.use('/auditoria', auditoriaRouter);
rotas.use('/demanda', demandaRouter);
rotas.use('/compras', planejamentoRouter);
rotas.use('/cotacoes', cotacoesRouter);
rotas.use('/negociacoes', negociacoesRouter);
rotas.use('/pedidos-compra', pedidosRouter);
// O acompanhamento logistico entra no mesmo prefixo do pedido: sao rotas de
// leitura e de status, sem tocar nas informacoes comerciais do modulo 07.
rotas.use('/pedidos-compra', acompanhamentoPedidoRouter);
rotas.use('/entregas', entregasRouter);
rotas.use('/indicadores', indicadoresRouter);
rotas.use('/fornecedores', performanceFornecedorRouter);
// Modulo 09: recebimento, conferencia, qualidade e nao conformidades.
rotas.use('/recebimentos', recebimentosRouter);
rotas.use('/recebimento-itens', recebimentoItensRouter);
rotas.use('/divergencias', divergenciasRouter);
rotas.use('/quarentenas', quarentenasRouter);
rotas.use('/nao-conformidades', naoConformidadesRouter);
rotas.use('/nc-acoes', acoesNcRouter);
rotas.use('/devolucoes', devolucoesRouter);
rotas.use('/fornecedores', qualidadeFornecedorRouter);
// Modulo 10: avaliacao de fornecedores, scorecard e plano de acao.
rotas.use('/avaliacao', avaliacaoRouter);
rotas.use('/metodologias-avaliacao', metodologiasRouter);
rotas.use('/avaliacoes-fornecedores', avaliacoesRouter);
rotas.use('/planos-acao', planosRouter);
rotas.use('/plano-acoes', acoesPlanoRouter);
rotas.use('/situacoes-fornecedor', situacoesRouter);
rotas.use('/fornecedores', scorecardFornecedorRouter);
rotas.use('/produtos', alternativasRouter);
// Modulo 11: BI, indicadores e central de alertas. O painel do modulo 02
// continua em /dashboard/ - estes sao paineis adicionais no mesmo prefixo.
rotas.use('/dashboard', dashboardBiRouter);
rotas.use('/kpis', kpisRouter);
rotas.use('/alertas', alertasBiRouter);
// Modulo 12: camada de inteligencia sobre os modulos 01 a 11.
rotas.use('/ia', iaRouter);
// Modulo 13: orquestracao. O webhook vem ANTES e em seu proprio prefixo porque
// nao tem usuario autenticado - quem chama e um sistema externo, e a
// autenticacao dele e a assinatura HMAC, verificada dentro do servico.
rotas.use('/webhooks', webhookRouter);
rotas.use('/automacao', automacaoRouter);
// Modulo 14: camada central de integracao. Fica em /integracoes; os webhooks de
// entrada continuam em /webhooks, do modulo 13, porque a porta e a mesma.
rotas.use('/integracoes', integracaoRouter);
