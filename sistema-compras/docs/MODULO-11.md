# MÓDULO 11 — Dashboards gerenciais, BI e indicadores

## O que este módulo faz

Transforma o que os módulos 02 a 10 registraram em **46 indicadores com
definição oficial, 12 painéis, drill-down até o registro de origem e uma
central única de alertas**.

Não cria dado operacional. Não move estoque, não abre pedido, não altera
recebimento. É camada de análise (regras 9 e 10 da §71) — e a bateria de
testes verifica isso comparando as contagens operacionais antes e depois de
rodar o módulo inteiro.

A regra que organiza tudo: **cada número tem uma definição só**. Se OTIF
aparece no painel executivo, no de fornecedores e no de logística, os três
pedem o mesmo código ao mesmo motor e recebem o mesmo valor (§67, regra 2).

## A decisão de arquitetura

O catálogo (`kpi_definicoes`) guarda a **definição** do indicador: fórmula em
texto, fonte, periodicidade, direção, unidade, casas decimais, mínimo de
eventos, destino de drill-down e como interpretar. A **execução** fica em um
resolvedor TypeScript indexado pelo código do KPI
(`src/modules/bi/resolvedores.ts`).

A alternativa seria guardar SQL executável no banco — mais flexível, e
inseguro e não testável. Com resolvedor em código, cada indicador é uma
função pura de contexto, revisável em diff e coberta por teste.

O preço: um KPI catalogado sem resolvedor não some da tela nem aparece zerado
— ele volta **não calculável**, com o motivo `KPI catalogado, mas ainda sem
apuração automática implementada`. Hoje os 46 têm resolvedor.

## Banco

### Reaproveitado

`alertas` (evoluída), `notificacoes`, `auditoria`, `configuracoes`,
`permissoes`, `perfil_permissoes`, `produtos`, `categorias`, `fornecedores`,
`produto_fornecedor`, `estoques`, `vw_estoque_atual`, `lotes`,
`movimentacoes_estoque`, `necessidades_compra`, `previsoes_demanda`,
`cotacoes`, `ordens_compra`, `ordem_compra_itens`, `entregas`,
`ocorrencias_entrega`, `recebimentos`, `recebimento_itens`,
`recebimento_divergencias`, `inspecoes_qualidade`, `nao_conformidades`,
`devolucoes`, `avaliacoes_fornecedores`, `planos_acao_fornecedor`,
`historico_precos`, `direcao_criterio_enum`, `severidade_enum`,
`status_alerta_enum`, `tipo_alerta_enum`.

### Novo (migrations 034 a 039)

| Objeto | Para quê |
|---|---|
| `kpi_definicoes` | dicionário oficial: fórmula, fonte, periodicidade, direção, drill-down, dono (§65, §66) |
| `kpi_metas` | meta por escopo, com vigência — a meta de ontem continua sendo a de ontem (§12) |
| `kpi_resultados` | resultado congelado, imutável por trigger (§30, §49) |
| `dashboards`, `dashboard_widgets`, `dashboard_filtros` | catálogo dos painéis (§5, §57) |
| `alertas_regras` | 8 regras de disparo ligadas a indicadores (§40) |
| `alertas_tipos` | classificação oficial de cada tipo em categoria e prioridade |

A tabela `alertas` **ganhou 15 colunas** em vez de virar uma segunda tabela
de alertas: título, prioridade, categoria, origem, entidade, link, chave de
deduplicação, contador de ocorrências, primeira/última ocorrência, KPI, valor
e limite. A §40 pede **uma** central; criar `bi_alertas` ao lado teria
produzido duas.

### Como os alertas dos outros módulos entraram na central

Os módulos 02 a 10 inserem em `alertas` informando só o tipo — eles não
conhecem categoria nem prioridade, e não deveriam precisar conhecer.

Em vez de editar dez módulos (e torcer para que o décimo primeiro lembre), a
classificação virou dado: `alertas_tipos` diz, por tipo, a que categoria e
prioridade ele pertence, e uma trigger `BEFORE INSERT` preenche o que veio
nulo. Quem insere continua informando o tipo; a central recebe o alerta já
classificado. A trigger **só preenche nulo** — um alerta que chega com
prioridade explícita mantém a sua.

Os 109 alertas que já existiam foram classificados pelo mesmo mapa na
migration 037.

## Os 46 indicadores

| Módulo | Quantos | Exemplos |
|---|---|---|
| ESTOQUE | 11 | valor, disponível, cobertura, giro, ruptura, excesso, parado, crítico |
| COMPRAS | 9 | valor comprado, preço médio, saving, carteira aberta, necessidade |
| LOGISTICA | 6 | OTIF, OTD, in-full, atraso médio, lead time, entregas atrasadas |
| QUALIDADE | 4 | taxa de aprovação, taxa de NC, NC críticas, devolução |
| FINANCEIRO | 3 | valor recebido, compromisso futuro, prazo médio de pagamento |
| RECEBIMENTO | 3 | pendentes, divergência, tempo de conferência |
| DEMANDA | 3 | demanda média, acuracidade da previsão, produtos sazonais |
| FORNECEDORES | 3 | score, monitorados, bloqueados |
| IMPORTACAO | 2 | pedidos e valor em importação |
| RISCOS | 2 | monoprovedor, qualidade dos dados |

10 têm meta vigente. Os demais aparecem em **cinza** — sem meta não há
semáforo, e pintar de verde por falta de meta seria inventar aprovação.

## O que o módulo se recusa a fazer

### Zero não é ausência de dado (regra 6)

Um KPI sem eventos no período volta `calculavel: false`, `valor: null`,
semáforo `CINZA` e `atingiu_meta: null`, com o motivo por escrito. Nunca zero
em vermelho.

A distinção é preservada ponta a ponta: uma regra de alerta com comparador de
limite **não dispara** sobre indicador não calculável — ausência de dado não
é violação de meta. Só o comparador `SEM_DADOS` dispara aí, e é justamente
para isso que ele existe.

Cobertura de estoque segue a mesma linha: produto sem demanda não tem
cobertura infinita, tem `SEM_DEMANDA`.

### Indicador de posição não finge ter história (§54)

23 dos 46 indicadores medem a **posição atual**, não um período. "Produtos em
ruptura" reapurado para março de 2015 devolve o número de hoje — o banco
guarda a posição atual, não a de março.

Sem essa distinção, a curva de evolução mensal desses indicadores sai
perfeitamente plana, e uma linha reta em seis meses lê-se como estabilidade.
Não é: é o mesmo número desenhado seis vezes.

Por isso `kpi_definicoes.pontual` marca esses indicadores, e para eles a
série reapurada e a comparação entre períodos são **recusadas com o motivo**,
não entregues. A série de verdade passa a existir conforme
`kpi_resultados` for alimentado (o agendamento do módulo 13 fará isso).

O critério não foi escolhido no olho: cada indicador foi apurado para dois
períodos muito distantes e marcado como pontual quando devolveu o mesmo
valor. A bateria refaz essa verificação e falha se um indicador de período
passar a ignorar o período.

### Filtro que não se aplica é declarado, não descartado (§8)

Cada resolvedor declara quais dimensões sabe aplicar. O que ele não sabe
aplicar volta na resposta em `filtros_ignorados` e a tela avisa. Um número
que ignorou o filtro de categoria e responde como se tivesse filtrado é pior
do que um número ausente.

Os KPIs de posição de estoque leem `vw_estoque_atual`, que já consolida os
locais — então o filtro por local é declarado como não aplicável a eles.

### Do dashboard não se altera dado operacional (regras 9 e 10)

O drill-down leva até a lista e dela ao módulo que cuida do registro. As
"ações disponíveis" do contexto de decisão são todas do tipo `NAVEGAR`. O
único `PATCH` do módulo é a tratativa do alerta — que registra o
encaminhamento e não toca em estoque, pedido ou recebimento.

## Três bugs que os testes de consistência encontraram

### 1. Os KPIs de estoque olhavam 37 produtos de 2.283

`baseEstoque` partia da tabela `estoques`, que só tem linha para produto com
saldo registrado. O drill-down partia de `vw_estoque_atual`, a visão oficial
do módulo 03, que tem todos.

Resultado: o painel dizia **9 produtos em ruptura** logo acima de uma lista
com **1.439**, e a cobertura média aparecia como 781 dias.

Os dois passaram a ler `vw_estoque_atual`. Cobertura média caiu para 14,5
dias — que é o número real.

A bateria agora compara sete pares KPI↔drill-down e falha se divergirem.

### 2. Excesso tinha duas definições

O KPI contava produto acima do **menor** entre a cobertura máxima e o estoque
máximo cadastrado. O drill-down exigia demanda maior que zero e só olhava
cobertura — deixando de fora o pior caso: produto acima do máximo cadastrado
e **sem saída nenhuma**. O drill-down passou a usar o critério do KPI, e
mostra em coluna qual dos dois limites mordeu.

### 3. O drill-down informava o tamanho da página como se fosse o total

A lista buscava `limite + 1` registros e reportava `total` como o que tinha
buscado. Com 1.439 produtos em ruptura, dizia "500 registros" logo abaixo de
um indicador que dizia 1.439. Agora, **só quando estoura o limite**, uma
contagem é feita: a resposta traz `total` (quantos existem) e `exibidas`
(quantos vieram).

## Metodologias definidas aqui

A §18 manda usar a metodologia de giro do módulo 03. **Ela não existe**: o
módulo 03 implementou só a configuração `estoque.dias_sem_giro_alerta`, nunca
o cálculo. O giro foi então definido neste módulo — saídas do período sobre
estoque médio, por custo — e está declarado no dicionário como qualquer outro
indicador, com a configuração `bi.giro_metodo`.

O mesmo vale para o mapa de riscos: probabilidade e impacto somam **pesos de
fatores objetivos** apurados nos registros (sem estoque com demanda, sem
fornecedor, pedido atrasado, classe ABC, valor da demanda), limitados a 100.
A resposta devolve os fatores junto do nível, com o peso de cada um — quem lê
confere a conta em vez de acreditar nela (§36).

## Central de alertas

Categorias da §40: ruptura, estoque, compra, fornecedor, atraso, qualidade,
recebimento, preço, demanda, importação, governança.

Prioridades da §41: CRÍTICO (ação imediata), ALTO (ação prioritária), MÉDIO
(acompanhamento), BAIXO (informativo). O campo `severidade`, do módulo 02,
continua preenchido em coerência — as telas antigas seguem corretas.

### Deduplicação (§42)

O alerta é identificado por uma **chave estável do evento** (regra + escopo
do filtro), não pelo texto. Enquanto houver alerta ABERTO com aquela chave,
uma nova apuração **atualiza** o registro — valor, última ocorrência e
contador — em vez de inserir outro.

Quem resolveu o alerta ontem não o vê renascer hoje como se fosse novo: ele
volta, sim, mas como reincidência contada. E a lista fica do tamanho dos
problemas, não do tamanho do tempo.

O índice parcial `uq_alerta_dedup ON alertas (chave_dedup) WHERE chave_dedup
IS NOT NULL AND status = 'ABERTO'` garante isso no banco: duas apurações
simultâneas não criam duas linhas, a segunda cai no `ON CONFLICT`.

Depois de **resolvido**, a mesma condição gera alerta novo com contador
reiniciado — a chave só vale enquanto o alerta está aberto. É o comportamento
correto: o problema voltou depois de tratado, e isso é informação.

## Contexto de decisão (§72)

Para um produto, reúne a cadeia inteira:

**situação** (disponível, em trânsito, quarentena, demanda, cobertura) →
**impacto** (valor da demanda diária, classe ABC) → **origem** →
**registros relacionados** (pedidos abertos, necessidades, recebimentos, NCs,
fornecedores) → **ações disponíveis**.

A **origem** lista causas observadas com a evidência de cada uma — pedido
atrasado, reposição não iniciada, produto sem fornecedor ativo, monoprovedor,
estoque retido em quarentena, histórico recente de NC, demanda alta em
relação ao saldo. São fatos lidos dos registros, não hipóteses, e cada um
aponta o que o sustenta.

O sistema apresenta o quadro. Quem decide é a pessoa (§73).

## Um detalhe de meta que o banco pegou

`definirMeta` encerrava a meta anterior em `CURRENT_DATE - 1`. Quando a meta
anterior **tinha começado no mesmo dia**, isso produzia vigência negativa e
o `ck_kpi_meta_vigencia` recusava — corretamente.

Redefinir a meta no dia em que ela foi criada é uma **correção**, não uma
troca. Agora, nesse caso, a meta anterior sai como inativa, sem fingir que
vigorou por um período negativo. Nos demais casos ela é encerrada na véspera,
como antes.

## Configurações (grupo `bi`)

| Chave | Padrão | Para quê |
|---|---|---|
| `bi.dias_padrao` | 90 | período quando nada é informado |
| `bi.limite_drilldown` | 500 | teto de linhas por lista |
| `bi.excesso_cobertura_dias` | 90 | cobertura acima da qual é excesso |
| `bi.estoque_parado_dias` | 90 | sem saída há mais que isso |
| `bi.cobertura_critica_dias` / `bi.cobertura_atencao_dias` | 7 / 15 | faixas de cobertura |
| `bi.giro_baixo` | 2 | giro abaixo do qual alerta |
| `bi.giro_metodo` | CUSTO | base do giro |
| `bi.valor_estoque_metodo` | CUSTO_REFERENCIA | base da valorização |
| `bi.qualidade_dados_minimo` | 80 | completude mínima do cadastro |
| `bi.lead_time_elevado_dias` | 30 | fator de risco |
| `bi.risco_concentracao_percentual` | 70 | concentração de fornecimento |
| `bi.semaforo_tolerancia_percentual` | 5 | tolerância do amarelo |

## API

### Painéis

```
GET  /api/dashboard/paineis
GET  /api/dashboard/executivo            (exige bi.executivo)
GET  /api/dashboard/{compras|estoque|demanda|fornecedores|logistica
                     |recebimento|qualidade|financeiro|importacoes|comprador}
GET  /api/dashboard/riscos               (exige bi.executivo)
GET  /api/dashboard/pareto?analise=
GET  /api/dashboard/pareto-analises
GET  /api/dashboard/matriz-abc-xyz
GET  /api/dashboard/drilldown?destino=
GET  /api/dashboard/drilldown-destinos
GET  /api/dashboard/contexto/{produtoId}
```

### Indicadores

```
GET  /api/kpis
GET  /api/kpis/dicionario                (exige bi.kpi)
GET  /api/kpis/metas                     (exige bi.kpi)
POST /api/kpis/metas                     (exige bi.meta)
GET  /api/kpis/comparar?codigos=A,B,C
GET  /api/kpis/{codigo}
GET  /api/kpis/{codigo}/comparacao
GET  /api/kpis/{codigo}/serie?meses=
GET  /api/kpis/{codigo}/historico
POST /api/kpis/{codigo}/registrar        (exige bi.kpi)
```

### Alertas

```
GET   /api/alertas
GET   /api/alertas/resumo
GET   /api/alertas/regras
POST  /api/alertas/avaliar
GET   /api/alertas/{id}
PATCH /api/alertas/{id}/tratar
```

Todas aceitam o filtro global: `periodo`, `dias`, `data_inicio`, `data_fim`,
`categoria_id`, `produto_id`, `fornecedor_id`, `local_id`, `comprador_id`,
`origem`, `status`.

## Permissões (§60)

| Permissão | Dá acesso a |
|---|---|
| `bi.ler` | painéis operacionais, KPIs, séries, drill-down |
| `bi.executivo` | painel executivo e mapa de riscos |
| `bi.kpi` | dicionário, governança, congelar resultado |
| `bi.meta` | definir meta de indicador |
| `bi.alertas` | central de alertas e tratativa |
| `bi.personalizar` | painéis próprios |

O painel executivo exige `bi.executivo` **além** de `bi.ler`. A checagem é
feita dentro do handler, não encadeando `exigirPermissao` como callback — esse
middleware sinaliza negativa por `next(erro)`, então o handler seguinte
rodaria mesmo depois da negativa. (Foi exatamente esse o furo encontrado no
módulo 10.)

O front esconde o que o perfil não pode ver; o backend recusa quem chamar a
URL direto. A bateria confere os dois.

## Telas

`/indicadores` — filtro global no topo, válido para as três abas:

- **Painéis**: 12 painéis, KPI em cartão com cor do semáforo, meta e desvio.
  Clicar no número abre o indicador: definição oficial, série, comparação e
  botão para os registros que o compõem.
- **Análises**: curva de Pareto (7 análises), matriz ABC×XYZ — com a coluna
  `SEM_CLASSE` preservada de propósito, porque produto sem classificação não
  é produto classe C — e mapa de riscos.
- **Dicionário**: os 46 indicadores com fórmula, fonte, periodicidade e meta
  vigente, e o formulário de meta para quem tem `bi.meta`.

`/alertas` — resumo por prioridade e categoria, lista com contador de
reincidência, detalhe com tratativa, e as regras com o resultado da última
avaliação.

O gráfico de linha passou a **quebrar a linha nos meses sem apuração**, em vez
de ligar os dois lados: ligar desenharia uma continuidade que o dado não tem.

## Testes

`npm run test:m11` — **137 verificações**, idempotente (a meta de OTIF é
devolvida ao valor original no fim).

| Bateria | Cobre |
|---|---|
| Catálogo de KPIs | sem duplicidade, fórmula e fonte em todos, dicionário completo |
| Apuração | período, semáforo, desvio em p.p., comparação, série, indicador pontual |
| Dashboards | carregamento dos 12, blocos, mesmo período em todos os KPIs, OTIF igual nos 3 painéis |
| Análises | Pareto acumulado crescente fechando em 100%, ABC×XYZ, riscos com fatores |
| Drill-down | os 28 destinos, consistência KPI↔lista, total real, contexto de decisão |
| Filtros | cenários 1 e 2, filtro não aplicável declarado, intervalo invertido recusado |
| Ausência de dados | cenário 3 — sem dados ≠ zero |
| Metas | cenário 4 — nova meta muda o semáforo, histórico não é reescrito |
| Central de alertas | geração, prioridade, deduplicação, reincidência, encerramento, reabertura |
| Segurança | cenário 5 — 401 sem token, 403 por perfil em executivo, riscos, metas e dicionário |
| Performance | 6 painéis em paralelo, grande volume, paginação sem repetição |
| Isolamento | nenhuma movimentação, pedido ou recebimento criado pelo módulo |

Regressão completa após o módulo: **1.366 verificações**, todas passando
(smoke 49, m04 144, m05 126, m06 164, m07 181, m08 261, m09 137, m10 167,
m11 137).

## Pendências assumidas

- **Exportação para Excel/CSV/PDF** (§58): pedida desde o módulo 04 e adiada
  de propósito como um trabalho genérico único, em vez de sete implementações
  parecidas.
- **Série histórica real dos indicadores de posição**: depende de
  `kpi_resultados` ser alimentado periodicamente — o agendamento é do módulo
  13. A estrutura e o endpoint de congelamento já existem.
- **Dashboards personalizados** (`bi.personalizar`): a permissão, as tabelas
  `dashboard_widgets` e `dashboard_filtros` existem; a montagem de painel pelo
  usuário não foi construída.
- **Cache de KPI** (§62): nenhum. Todo indicador é apurado na hora, e a
  resposta diz `tempo_real: true`. A §62 pede cache só onde houver ganho real
  de performance — os 12 painéis respondem em paralelo dentro do limite.
- **Dados mestres de custo**: 49 dos 2.283 produtos estão sem
  `custo_referencia`, o que zera a valorização deles. Não distorce os
  indicadores agregados, mas aparece como R$ 0,00 no detalhe desses produtos.
- **Dados de teste** com prefixos `M05-` a `M11-` continuam no catálogo.
