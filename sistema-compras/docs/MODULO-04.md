# MÓDULO 04 — Vendas, demanda, sazonalidade e previsão

## O que este módulo faz

Transforma o histórico de vendas em demanda, e demanda em previsão explicável.
Tudo o que ele produz alimenta o MÓDULO 05 (necessidade de compra) pela view
`vw_base_planejamento`.

## Banco

### Tabelas reaproveitadas (nada foi recriado)

`vendas`, `itens_venda`, `previsoes_demanda`, `produtos`, `parametros_estoque`,
`estoques`, `categorias`, `clientes`, `configuracoes`, `permissoes`.

### Estruturas novas (migration 011)

| Objeto | Para quê |
|---|---|
| `vendas.tipo_documento` | separa VENDA de DEVOLUÇÃO mantendo a quantidade positiva |
| `execucoes_previsao` | governança: quem rodou, quando, com quais parâmetros |
| colunas em `previsoes_demanda` | versão, origem, intervalo, métricas, tendência, confiabilidade, explicação, realizado |
| `indices_sazonais` | índice sazonal por produto e mês, com marca de confirmado |
| `vendas_outliers` | vendas fora do padrão, com decisão registrada |
| `demanda_reprimida` | estimativa por janela de ruptura, com evidências |
| `calendario_eventos` | feriados, campanhas, promoções, dias sem operação |
| `mv_demanda_diaria` / `mv_demanda_mensal` | agregados; nenhum painel varre 2,2 milhões de itens |
| `vw_base_planejamento` | a linha única que o módulo 05 vai consumir |

Migration 012 remove `uq_previsao_produto_periodo` (conflitava com o
versionamento). Migration 013 amplia as colunas percentuais — MAPE de produto
errático passa de 9999%.

### Imutabilidade

`trg_previsoes_append_only` bloqueia DELETE e bloqueia UPDATE de qualquer
campo do cálculo. Só `realizado`, `erro_percentual` e `avaliado_em` podem ser
preenchidos depois, quando o período acontece.

## Convenções de dados

- **A quantidade é em embalagens, não em quilos.** O SKU do ERP já embute o peso
  ("GERGELIM PRETO 5KG"), então `produtos.peso` guarda o peso da embalagem e a
  conversão para kg é `quantidade × peso`. Somar quantidades de SKUs de pesos
  diferentes dá um número sem significado físico — os totais gerais servem para
  tendência, não para logística.
- **Devolução não vira quantidade negativa no item.** O item continua positivo
  (a constraint `ck_itens_venda_qtd` segue valendo) e quem carrega o sinal é
  `vendas.tipo_documento`. A demanda líquida sai de VENDA menos DEVOLUÇÃO, uma
  única vez.
- **Venda cancelada não entra na demanda**, mas continua no banco.
- **O mês corrente nunca entra no treino da previsão nem na sazonalidade.**
  Um mês pela metade puxaria toda a previsão para baixo.

## Métodos de previsão

Média simples, média móvel, média móvel ponderada, suavização exponencial,
tendência (mínimos quadrados), sazonalidade e combinado.

A escolha automática roda um **backtest de origem deslizante**: para cada um dos
últimos períodos, treina com tudo que veio antes e compara a previsão com o
realizado. Vence o método de menor erro pela métrica configurada
(`forecast.metrica_erro`: MAE, MAPE ou RMSE). O alpha da suavização também é
escolhido por backtest quando `forecast.alpha_automatico` está ligado.

MAPE ignora períodos com realizado zero e volta `null` quando todos são zero —
nunca um número inventado.

### Confiabilidade

```
pontos = histórico (0-40) + erro (0-40) + estabilidade (0-20)

histórico     = min(40, meses/24 × 40)
erro          = max(0, 40 - min(40, MAPE/50 × 40))     (sem MAPE: 10)
estabilidade  = max(0, 20 - min(20, CV × 20))          (sem CV: 5)

>= 75 ALTA | >= 50 MEDIA | >= 25 BAIXA | < 25 ou menos de 3 meses INSUFICIENTE
```

### Intervalo

Sai do desvio dos resíduos do backtest (±1,96σ). Com menos de 3 resíduos ou
desvio zero, **não há intervalo** — melhor nenhum número do que um falso.

## Sazonalidade

Índice = demanda média do mês ÷ demanda média do ciclo. Só é calculado com pelo
menos `forecast.meses_minimos_sazonalidade` meses (padrão 12) e os 12 meses
representados. Só é marcado como **confirmado** com 2 ciclos completos e
dispersão dos índices ≥ 0,15; abaixo disso a tela mostra
"POSSIVEL_SAZONALIDADE".

## Demanda reprimida

Janelas de 2+ dias consecutivos com saldo ≤ 0, reconstruídas a partir do saldo
atual andando para trás nas movimentações. A estimativa é a média diária dos 60
dias anteriores à ruptura × dias de ruptura. Sem média anterior, **nada é
gravado**. Classificação inicial: POSSIVEL, ou PROVAVEL a partir de 7 dias.
Nunca nasce CONFIRMADA.

A análise de ruptura avisa quando o produto não tem movimentação registrada — aí
o saldo foi inferido só do estoque atual e não serve como histórico.

## API

```
GET  /api/demanda/dashboard              GET  /api/demanda/previsao
GET  /api/demanda                        POST /api/demanda/previsao/calcular
GET  /api/demanda/vendas                 POST /api/demanda/previsao/manual
POST /api/demanda/vendas/importar        GET  /api/demanda/previsao/execucoes
POST /api/demanda/agregados/atualizar    GET  /api/demanda/previsao/:produtoId
GET  /api/demanda/comparacao             POST /api/demanda/acuracidade/avaliar
GET  /api/demanda/perfil-temporal        GET  /api/demanda/acuracidade
GET  /api/demanda/qualidade              POST /api/demanda/sazonalidade/calcular
GET  /api/demanda/produto/:id            GET  /api/demanda/sazonalidade
GET  /api/demanda/categoria/:id          GET  /api/demanda/sazonalidade/:produtoId
GET  /api/demanda/ruptura                POST /api/demanda/outliers/detectar
POST /api/demanda/reprimida/calcular     GET  /api/demanda/outliers
GET  /api/demanda/reprimida              POST /api/demanda/outliers/:id/tratar
POST /api/demanda/reprimida/:id/classificar
POST /api/demanda/abc-xyz/classificar    GET  /api/demanda/abc-xyz
GET  /api/demanda/criticos               GET  /api/demanda/irregulares
GET  /api/demanda/alertas                GET  /api/demanda/calendario
POST /api/demanda/calendario             GET  /api/demanda/configuracoes
PUT  /api/demanda/configuracoes
```

## Permissões

| Permissão | Quem tem |
|---|---|
| `demanda.ler` | todos os perfis com acesso ao módulo |
| `demanda.prever` | ADMIN, GESTOR_COMPRAS, COMPRADOR |
| `demanda.ajustar` | ADMIN, GESTOR_COMPRAS |
| `demanda.importar` | ADMIN, GESTOR_COMPRAS |

## Carga do histórico do ERP

`db/etl/01_staging.sql` cria a área de pouso; `db/etl/02_normalizar.sql`
normaliza para as tabelas oficiais. A carga é idempotente por chave natural
(NF + cliente + data), então pode rodar de novo sem duplicar.

```bash
python3 db/etl/xlsx2csv.py <arquivo.xlsx> <saida.csv>
psql ... -f db/etl/01_staging.sql
psql ... -c "\copy staging.rel7104 FROM 'saida.csv' WITH (FORMAT csv, HEADER true)"
psql ... -1 -f db/etl/02_normalizar.sql
psql ... -c "REFRESH MATERIALIZED VIEW mv_demanda_diaria"
psql ... -c "REFRESH MATERIALIZED VIEW mv_demanda_mensal"
```

## Testes

```bash
npm run dev        # em um terminal
npm run test:m04   # em outro
```

144 verificações: 36 sobre a matemática pura (médias, suavização, regressão,
MAE/MAPE/RMSE, backtest, confiabilidade, intervalo) e 108 sobre a API
(dashboard, paginação, filtros, devolução, sazonalidade, previsão,
imutabilidade, outliers, ruptura, reprimida, ABC×XYZ, acuracidade, qualidade,
importação, permissões).
