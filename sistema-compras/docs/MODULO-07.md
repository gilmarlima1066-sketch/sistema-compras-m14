# MÓDULO 07 — Negociação e Pedido de Compra

## O que este módulo faz

Pega a cotação aprovada no módulo 06, conduz a negociação rodada a rodada,
apura a economia e — só depois de aprovada por quem tem alçada — gera o
**pedido de compra oficial**. Registra envio, confirmação do fornecedor,
divergências, alterações pós-aprovação e cancelamento. Não cria recebimento:
o que sai daqui é o pacote para o módulo 08.

## Banco

### Reaproveitado

`ordens_compra`, `ordem_compra_itens`, `compromissos_compra`, `negociacoes`,
`cotacoes`, `cotacao_itens`, `cotacao_produtos`, `necessidades_compra`,
`alcadas_aprovacao`, `condicoes_pagamento`, `fornecedores`, `produtos`,
`estoques`, `mv_demanda_diaria`, `previsoes_demanda`, `configuracoes`,
`auditoria`.

### A decisão estrutural

A tabela `negociacoes` já existia, com uma linha por produto negociado
(preço anterior, preço negociado, saving). Em vez de criar uma tabela paralela,
ela virou **o registro do item dentro da rodada**: ganhou `negociacao_id`,
`rodada_id` e `negociacao_item_id`. A negociação em si — cabeçalho, status,
custo total, economia — passou a viver em `negociacoes_compra`.

`ordens_compra` foi estendida em vez de substituída: o módulo 03 já emitia
ordens, e um pedido vindo da negociação é a mesma entidade com origem e
condições a mais.

### Novo (migrations 020 e 021)

| Objeto | Para quê |
|---|---|
| `negociacoes_compra` | cabeçalho da negociação: status, custo inicial × atual, economia, alçada |
| `negociacao_itens` | item negociado: quantidade, preço inicial, preço atual, alvo, mínimo histórico, MOQ, múltiplo |
| `negociacao_rodadas` | uma linha por rodada, **append-only** (trigger bloqueia UPDATE e DELETE) |
| `pedido_aprovacoes` | quem precisa aprovar, qual valor foi avaliado, o que foi decidido |
| `pedido_alteracoes` | solicitação de alteração pós-aprovação, com valor anterior e novo |
| `pedido_confirmacoes` | confirmação do fornecedor e as divergências daquele momento |
| `pedido_historico` | trilha do pedido, **append-only** |
| `vw_rastreabilidade_compra` | necessidade → cotação → negociação → pedido em uma linha |
| 30 colunas em `ordens_compra` | negociação de origem, economia, envio, confirmação, exceções, validações, alertas, cancelamento |
| 12 colunas em `ordem_compra_itens` | preço original, bonificação, frete rateado, MOQ, múltiplo, quantidade confirmada e pendente |
| 5 colunas em `compromissos_compra` | parcela, percentual, entrada, origem |

### Configurações (grupo `pedido`)

| Chave | Padrão | Para quê |
|---|---|---|
| `pedido.prefixo_numero` | `PC` | prefixo da numeração |
| `pedido.limite_cobertura_dias` | `120` | acima disso a compra vira risco de excesso |
| `pedido.percentual_acima_necessidade` | `20` | quanto se pode comprar acima da necessidade sem justificar |
| `pedido.exigir_justificativa_excesso` | `true` | se o excesso trava a aprovação sem justificativa |
| `pedido.percentual_alteracao_reaprovacao` | `10` | variação de valor que obriga nova aprovação |
| `pedido.metodo_rateio_frete` | `VALOR` | método padrão de rateio |
| `pedido.evento_economia_realizada` | `RECEBIDA` | quando a economia deixa de ser negociada e vira realizada |
| `pedido.dias_negociacao_parada` | `5` | dias sem rodada para a negociação entrar no alerta |
| `pedido.tolerancia_divergencia_percentual` | `2` | diferença entre pedido e confirmação considerada relevante |
| `pedido.dias_alerta_vencimento` | `3` | antecedência do alerta de vencimento |

Nenhum desses números está no código. A alçada vem inteira de
`alcadas_aprovacao`.

## A conta

Tudo em `modules/negociacoes/calculos.ts`, sem banco e sem request — dá para
conferir a aritmética isoladamente.

### Custo total

```
custo = produtos − desconto + frete + impostos + seguro + desembaraço + taxas + outros
```

### Economia

```
economia    = custo_inicial − custo_negociado
percentual  = economia / custo_inicial        (custo inicial 0 → null, nunca 0%)
```

As três economias são coisas diferentes e ficam separadas:

| | O que é | Onde nasce |
|---|---|---|
| **Potencial** | estimada na cotação, antes de negociar | módulo 06 |
| **Negociada** | fechada com o fornecedor | rodadas da negociação |
| **Realizada** | reconhecida no pedido | evento configurável (`RECEBIDA` por padrão) |

### Bonificação

Bonificação **não** vira desconto no preço. As quantidades ficam separadas e o
que muda é o custo unitário efetivo:

```
custo_unitário_efetivo = custo_total / (comprada + bonificada)
```

### Rateio de frete

Cinco métodos: `VALOR`, `PESO` (peso × quantidade), `QUANTIDADE`, `PERCENTUAL`
e `MANUAL`. Quando a base escolhida não existe (peso não cadastrado, por
exemplo), cai para valor em vez de ratear zero. **A sobra do arredondamento vai
para o item de maior base**, então a soma dos rateios fecha com o frete.

### Parcelas

O prazo negociado é o **intervalo entre parcelas**, não um total a dividir:
"35 dias em 2×" vence aos 35 e aos 70. Com entrada, a primeira parcela vence na
emissão. A diferença de arredondamento sobra na última parcela.

### Excesso e ruptura

```
cobertura_atual       = (disponível + em trânsito) / demanda_diária
cobertura_após_compra = (disponível + em trânsito + pedido) / demanda_diária

risco de excesso  ⟺ cobertura_após_compra > limite configurado
risco de ruptura  ⟺ quantidade comprada < necessidade planejada
```

Sem demanda a cobertura é `null`, não infinito — e aí não há risco de excesso a
apontar. A data provável de ruptura sai da posição após a compra dividida pela
demanda diária.

## Fluxos

### Negociação

```
ABERTA → EM_NEGOCIACAO ⇄ AGUARDANDO_FORNECEDOR ⇄ CONTRAPROPOSTA_RECEBIDA
       → EM_ANALISE → ACORDADA → APROVADA → CONVERTIDA_PEDIDO
                   ↘ REJEITADA / CANCELADA
```

Uma rodada nunca sobrescreve a anterior: ela grava os valores daquele momento e
o que mudou em relação à rodada passada. A **rodada 0** é a fotografia das
condições de abertura.

O acordo (`/acordar`) só fecha quando fornecedor, comprador, prazo de entrega,
prazo de pagamento, custo total e preço de **todos** os itens estão definidos —
caso contrário a resposta diz exatamente o que falta.

Uma cotação aprovada gera **uma negociação por fornecedor**. Tentar abrir uma
segunda para o mesmo fornecedor devolve 409.

### Pedido

```
RASCUNHO → AGUARDANDO_APROVACAO → APROVADA → ENVIADA → CONFIRMADA
         → EM_PRODUCAO → EM_TRANSITO → RECEBIMENTO_PARCIAL → RECEBIDA → FINALIZADA
                                     ↘ REJEITADA / CANCELADA / BLOQUEADA
```

A numeração nunca reaproveita um número cancelado: o próximo sai do maior
sequencial já usado no ano, não de uma contagem de linhas.

### Aprovação

A alçada vem de `alcadas_aprovacao` por faixa de valor. `simularAprovacao`
responde "o que acontece se eu aprovar este pedido?" sem gravar nada: estoque
antes e depois, cobertura, capital comprometido, riscos.

A aprovação é **recusada** quando a validação de quantidade não passa (MOQ,
múltiplo, quantidade zero) e **exige justificativa** quando há compra acima da
necessidade ou risco de excesso. A exceção fica gravada com tipo, motivo,
usuário e data.

### Confirmação e divergência

O pedido original não é alterado pela confirmação. Entra a quantidade
confirmada; a diferença vira `quantidade_pendente` e divergência registrada,
com tolerância percentual configurável.

### Alteração pós-aprovação

Pedido aprovado não se edita. Abre-se uma solicitação em `pedido_alteracoes`,
com motivo e valor anterior. Se a variação passar do percentual configurado, a
solicitação marca `exige_reaprovacao` e o pedido volta para aprovação. Recusada,
nada muda no pedido — e a solicitação fica no histórico.

## Concorrência e transação

A conversão negociação → pedido roda em uma transação com `FOR UPDATE` sobre a
negociação, e um **índice único parcial** em `negociacoes_compra (ordem_compra_id)`
garante o resto. Duas conversões simultâneas: uma passa, a outra recebe 409 e
nenhum pedido duplicado aparece no banco.

## Integrações

| Módulo | O que entra / sai |
|---|---|
| **03** | `ordens_compra` e `ordem_compra_itens` estendidas, não substituídas |
| **04** | demanda média, previsão, tendência, ABC/XYZ na validação do pedido |
| **05** | `necessidade_id` viaja da cotação até o item do pedido; a validação compara pedido × necessidade |
| **06** | negociação nasce da cotação aprovada, herdando preço, prazo, frete e item de origem |
| **08** | `GET /api/pedidos-compra/:id/acompanhamento` entrega o pacote. Nenhum recebimento é criado aqui |

## Indicadores

`GET /api/negociacoes/dashboard` reúne os três blocos:

- **Painel de economia** (§78): valor original, negociado, economia, % — com
  potencial, negociada e realizada separadas.
- **KPI de negociação** (§51): taxa de negociação, economia média e total,
  redução média, rodadas médias, tempo médio, % concluídas / rejeitadas /
  convertidas.
- **KPI de pedido** (§52): lead time, tempo de aprovação, aprovação→envio,
  confirmação, % confirmados / alterados / cancelados / parciais.
- **Indicadores de compras** (§50): saving geral e por comprador, fornecedor,
  categoria e período; preço médio, prazos médios, valor médio, atrasados,
  cancelados, parciais, % de alteração pós-aprovação.

Saving = economia / preço de referência. Pedido sem negociação vinculada não
tem referência e fica **fora do denominador**, em vez de entrar como saving
zero e puxar a média para baixo.

## Alertas

`GET /api/negociacoes/alertas`, classificados em CRÍTICO / ALERTA / ATENÇÃO:
negociação parada, fornecedor sem resposta, preço acima do alvo, data limite
vencida, pedido aguardando aprovação, pedido sem confirmação, parcialmente
confirmado, alterado, próximo do vencimento e em atraso.

## Auditoria

`negociacao_rodadas` e `pedido_historico` são append-only por trigger: `DELETE`
falha no banco, não na aplicação. Cada evento guarda quem fez, o que fez,
quando, status anterior e novo, e a justificativa. A `auditoria` geral continua
registrando as operações sobre `negociacoes_compra` e `ordens_compra`.

## Permissões

| Permissão | Quem tem |
|---|---|
| `compras.negociar` | ADMIN, GESTOR_COMPRAS, COMPRADOR |
| `compras.aprovar_negociacao` | ADMIN, GESTOR_COMPRAS, DIRETORIA |
| `ordens_compra.ler` | ADMIN, GESTOR_COMPRAS, COMPRADOR, DIRETORIA, FINANCEIRO, ESTOQUE, QUALIDADE |
| `ordens_compra.criar` | ADMIN, GESTOR_COMPRAS, COMPRADOR |
| `ordens_compra.aprovar` | ADMIN, GESTOR_COMPRAS, DIRETORIA |
| `ordens_compra.enviar` | ADMIN, GESTOR_COMPRAS, COMPRADOR |
| `ordens_compra.alterar` | ADMIN, GESTOR_COMPRAS, COMPRADOR |
| `ordens_compra.cancelar` | ADMIN, GESTOR_COMPRAS |

Permissão é só a porta. Quem aprova de fato depende da **alçada por valor** —
um GESTOR_COMPRAS com `ordens_compra.aprovar` recebe 403 num pedido de
R$ 98.000, porque essa faixa é da DIRETORIA.

## API

```
GET  /api/negociacoes/dashboard           GET  /api/negociacoes/alertas
GET  /api/negociacoes/indicadores         GET  /api/negociacoes/kpi
GET  /api/negociacoes                     POST /api/negociacoes
GET  /api/negociacoes/:id
POST /api/negociacoes/:id/rodadas         POST /api/negociacoes/:id/simular-volume
POST /api/negociacoes/:id/acordar         POST /api/negociacoes/:id/aprovar
POST /api/negociacoes/:id/rejeitar        POST /api/negociacoes/:id/cancelar
POST /api/negociacoes/:id/converter-pedido

GET  /api/pedidos-compra                  GET  /api/pedidos-compra/:id
GET  /api/pedidos-compra/:id/documento    GET  /api/pedidos-compra/:id/validacao
GET  /api/pedidos-compra/:id/simular-aprovacao
GET  /api/pedidos-compra/:id/timeline     GET  /api/pedidos-compra/:id/acompanhamento
POST /api/pedidos-compra/:id/enviar-aprovacao
POST /api/pedidos-compra/:id/aprovar      POST /api/pedidos-compra/:id/rejeitar
POST /api/pedidos-compra/:id/enviar       POST /api/pedidos-compra/:id/confirmar
POST /api/pedidos-compra/:id/alteracoes   POST /api/pedidos-compra/alteracoes/:id
POST /api/pedidos-compra/:id/cancelar
```

## Tela

`/ordens-compra` — quatro abas: **Dashboard** (economia, KPIs, saving),
**Negociações**, **Pedidos** e **Alertas**. O detalhe da negociação mostra
antes/depois, itens com preço-alvo e mínimo histórico, e a linha do tempo das
rodadas. O detalhe do pedido tem resumo, itens, validação, aprovações, timeline
(cotação → negociação → pedido) e o documento oficial.

O botão de aprovar fica **desabilitado** quando a validação aponta bloqueio, com
o motivo no topo do modal — em vez de deixar o usuário tentar e tomar 422.

## Testes

```bash
npm run dev        # em um terminal
npm run test:m07   # em outro
```

181 verificações: 45 sobre a matemática pura, 91 sobre o fluxo completo pela
API (cotação → negociação → pedido → envio → confirmação → alteração) e 45
sobre excesso, negociação manual, cancelamento, permissões e painéis.

Cobre os 36 testes obrigatórios da seção 69 e os cinco dirigidos das seções 70
a 74 — cenário completo de 10.000 kg, divergência de confirmação, alteração
pós-aprovação, risco de excesso e tentativa de conversão duplicada.

Os dados de teste usam o prefixo `M07-` e ficam no banco. O produto do teste de
excesso é um produto real do ERP, escolhido por ter venda nos últimos 90 dias:
sem demanda real não existe cobertura para avaliar.
