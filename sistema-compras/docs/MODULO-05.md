# MÓDULO 05 — Planejamento de compras e necessidade de compra

## O que este módulo faz

Transforma demanda, previsão, estoque, lead time, pedidos em aberto, MOQ e
múltiplo em **necessidade de compra** — e a necessidade aprovada em
**requisição**. Não emite ordem de compra: isso é o módulo 07.

## Banco

### Reaproveitado

`necessidades_compra`, `parametros_estoque`, `produtos`, `produto_fornecedor`,
`estoques`, `ordem_compra_itens`, `previsoes_demanda`, `mv_demanda_diaria`,
`locais`, `unidades`, `configuracoes`, `permissoes`.

### Novo (migrations 014 a 017)

| Objeto | Para quê |
|---|---|
| `planejamentos_compra` | cada execução: horizonte, estratégia, parâmetros, contagens |
| `necessidade_historico` | toda mudança de status, com quantidade anterior e nova |
| `requisicoes_compra` / `requisicao_compra_itens` | a ponte para o módulo 06 |
| `simulacoes_compra` / `simulacao_compra_itens` | cenários isolados do oficial |
| `alcadas_aprovacao` | faixas de valor por perfil, configuráveis |
| `fn_somar_prazo`, calendário de dias úteis (015) | datas em dias úteis ou corridos |
| `produtos.custo_referencia` (016) | custo do ERP como preço de estimativa |
| `compras.parametrizar` (017) | separa editar registro de mudar a regra |

## A conta

```
posição        = disponível + em trânsito + compras em aberto
necessidade    = demanda_do_horizonte + estoque_alvo [+ estoque_segurança] − posição
quantidade     = múltiplo × teto( máx(necessidade, MOQ) / múltiplo )
data necessária= hoje + (posição − segurança) / demanda_diária
data ideal     = data necessária − lead time total
lead time total= fornecedor + transporte + desembaraço + recebimento
```

O `estoque_alvo` depende da estratégia do produto:

| Estratégia | Dispara quando | Alvo |
|---|---|---|
| PONTO_PEDIDO | posição ≤ ponto de pedido | estoque de segurança |
| ESTOQUE_MINIMO | projetado < mínimo | estoque mínimo |
| ESTOQUE_MAXIMO | posição < máximo | estoque máximo |
| COBERTURA | cobertura < alvo em dias | demanda diária × dias de cobertura |
| DEMANDA_LEAD_TIME | projetado no lead time < segurança | demanda no lead time + segurança |

A origem da demanda segue a ordem do prompt: **previsão validada → média
realizada → parâmetro manual**, e fica gravada em `origem_demanda`.

### Governança

Toda necessidade carrega `memoria_calculo` (JSONB) com cada parcela da conta, a
fórmula por extenso, a origem da demanda e a origem do preço; e
`fatores_prioridade` com o peso de cada fator do índice. A tela mostra isso no
botão "Abrir" — o comprador consegue responder "por que este número?".

O ajuste manual grava a quantidade do sistema em `quantidade_sistema` e exige
justificativa de no mínimo 10 caracteres. As duas ficam lado a lado para sempre.

## Preço

`preco_estimado` vem de `produto_fornecedor.preco_atual`. Sem contrato, cai para
`produtos.custo_referencia` (último custo praticado no ERP) e a necessidade
recebe o alerta `PRECO_ESTIMADO`. Sem nenhum dos dois, alerta `SEM_PRECO`.
A origem fica em `memoria_calculo.origem_preco`.

## Alertas

RUPTURA, RISCO_RUPTURA, COMPRA_ATRASADA, EXCESSO, MOQ, MULTIPLO, DUPLICIDADE,
TRANSFERENCIA_POSSIVEL, SEM_FORNECEDOR, PRECO_ESTIMADO, SEM_PRECO,
PREVISAO_INSTAVEL, SEM_HISTORICO.

Transferência entre locais é **apontada, nunca executada**. E só é avaliada
quando o planejamento é de um local específico — "saldo em outro local" não
significa nada num planejamento global.

## Workflow

```
PENDENTE → EM_ANALISE → APROVADA → CONVERTIDA_COTACAO → ATENDIDA
   ↘ AJUSTADA ↗        ↘ REJEITADA        ↘ CANCELADA
```

A requisição nasce `AGUARDANDO_APROVACAO` e a aprovação respeita a alçada por
valor (`alcadas_aprovacao`): Comprador até R$ 10 mil, Gestor até R$ 50 mil,
Diretoria acima. ADMIN aprova qualquer faixa. Os valores são configuráveis.

## Permissões

| Permissão | Quem tem |
|---|---|
| `compras.ler` | ADMIN, GESTOR_COMPRAS, COMPRADOR, DIRETORIA, FINANCEIRO |
| `compras.planejar` | ADMIN, GESTOR_COMPRAS, COMPRADOR |
| `compras.aprovar` | ADMIN, GESTOR_COMPRAS, DIRETORIA |
| `compras.requisitar` | ADMIN, GESTOR_COMPRAS, COMPRADOR |
| `compras.simular` | ADMIN, GESTOR_COMPRAS, COMPRADOR |
| `compras.parametrizar` | ADMIN, GESTOR_COMPRAS |

## API

```
GET  /api/compras/dashboard             POST /api/compras/planejamentos
GET  /api/compras/fornecedores          GET  /api/compras/planejamentos
GET  /api/compras/consolidacao          GET  /api/compras/planejamentos/comparar
GET  /api/compras/calendario            GET  /api/compras/planejamentos/:id
GET  /api/compras/prioritarias          POST /api/compras/parametros/recalcular
GET  /api/compras/em-aberto             GET  /api/compras/parametros
GET  /api/compras/impacto-financeiro    PUT  /api/compras/parametros
GET  /api/compras/acuracidade
GET  /api/compras/necessidades          POST /api/compras/necessidades/:id/analisar
GET  /api/compras/necessidades/:id      POST /api/compras/necessidades/:id/aprovar
                                        POST /api/compras/necessidades/:id/rejeitar
                                        POST /api/compras/necessidades/:id/ajustar
                                        POST /api/compras/necessidades/:id/cancelar
POST /api/compras/simulacoes            GET  /api/compras/simulacoes
GET  /api/compras/simulacoes/comparar   GET  /api/compras/simulacoes/:id
DELETE /api/compras/simulacoes/:id
POST /api/compras/requisicoes           GET  /api/compras/requisicoes
POST /api/compras/requisicoes/gerar-por-fornecedor
GET  /api/compras/requisicoes/:id       POST /api/compras/requisicoes/:id/aprovar
                                        POST /api/compras/requisicoes/:id/rejeitar
                                        POST /api/compras/requisicoes/:id/cancelar
GET  /api/compras/alcadas               POST /api/compras/alcadas
```

## Testes

```bash
npm run dev        # em um terminal
npm run test:m05   # em outro
```

126 verificações em três blocos: cálculo da necessidade (cenários de MOQ,
múltiplo, conversão, excesso, transferência, importação, estratégias),
API/workflow/permissões, e o cenário completo da seção 61 conferido conta a
conta.

A bateria monta 17 produtos próprios com prefixo `M05-` e os deixa no banco.
São dados de teste convivendo com o catálogo real — convém excluí-los antes de
colocar o sistema em produção.
