# MÓDULO 06 — Cotações, comparação e análise de fornecedores

## O que este módulo faz

Recebe requisições aprovadas do módulo 05, convida fornecedores, registra as
propostas, compara por critérios ponderados e recomenda — explicando a conta.
Não cria pedido de compra: o que sai daqui é o dossiê para o módulo 07.

## Banco

### Reaproveitado

`cotacoes`, `cotacao_fornecedores`, `cotacao_itens`, `negociacoes`,
`historico_precos`, `produto_fornecedor`, `avaliacoes_fornecedores`,
`condicoes_pagamento`, `necessidades_compra`, `requisicoes_compra`,
`alcadas_aprovacao`.

### A mudança estrutural

`cotacao_itens` guardava ao mesmo tempo **o que foi pedido** e **o que foi
ofertado**. Com isso, um produto sem resposta simplesmente não existiria — e a
seção 10 do prompt exige o contrário: item não respondido tem de aparecer como
ausência, nunca como preço zero.

A linha do pedido passou para **`cotacao_produtos`** (uma por produto cotado) e
`cotacao_itens` ficou sendo só a proposta de cada fornecedor, apontando para
ela.

### Novo (migrations 018 e 019)

| Objeto | Para quê |
|---|---|
| `cotacao_produtos` | o que foi pedido, independente de quem respondeu |
| `criterios_cotacao` | catálogo dos 7 critérios, com direção e peso padrão |
| `criterios_categoria` | pesos diferentes por categoria e por origem |
| `cotacao_criterios` | os pesos **usados naquela cotação**, congelados |
| `cotacao_pontuacoes` | pontuação de cada proposta em cada critério |
| `cotacao_cenarios` + itens | simulações, isoladas da cotação oficial |
| `cotacao_faixas_preco` | desconto por volume |
| `cotacao_historico` | append-only, com trigger que bloqueia UPDATE e DELETE |
| 15 colunas em `cotacao_itens` | incoterm, moeda, câmbio, seguro, desembaraço, taxas, disponibilidade, validade, elegibilidade, score |

## A conta

### Custo total de aquisição

```
custo total = produtos − desconto + frete + impostos + seguro
              + desembaraço + taxas + outros
custo unitário = custo total / quantidade ofertada
```

Tudo convertido pela taxa de câmbio registrada na proposta. **A taxa não
substitui o valor original**: o preço em USD continua gravado em USD.

### Score

```
score = Σ(pontuação × peso) / Σ(pesos com dado) × 100
```

Cada critério é normalizado de 0 a 100 dentro da faixa observada **entre as
propostas concorrentes do mesmo produto**. Se todas empatam, todas valem 100.

O denominador é a soma dos pesos que **tinham dado**. Se ninguém informou
frete, o peso do frete é redistribuído em vez de zerar todo mundo. Critério sem
dado aparece como **DADOS INSUFICIENTES**, nunca com nota inventada.

Propostas inelegíveis não entram na faixa de normalização (distorceriam as
demais) e não recebem score — recebem motivo.

### Pesos padrão

| Critério | Peso | Direção |
|---|---:|---|
| Custo total de aquisição | 35% | menor é melhor |
| Prazo de entrega | 20% | menor é melhor |
| Qualidade do fornecedor | 15% | maior é melhor |
| OTIF histórico | 10% | maior é melhor |
| Condição de pagamento | 10% | maior é melhor |
| Frete (% do custo) | 5% | menor é melhor |
| MOQ e múltiplo (excesso forçado) | 5% | menor é melhor |

A soma é validada em 100% na gravação. Os pesos vigentes são **copiados para a
cotação** na criação: refazer o cálculo meses depois dá o mesmo número mesmo que
a empresa tenha mudado os pesos.

## Critérios obrigatórios

Preço menor **não compensa** condição obrigatória não atendida. Eliminam a
proposta: fornecedor inativo, item sem resposta, quantidade zero, validade
abaixo do mínimo, entrega depois da data necessária, produto indisponível,
proposta expirada, MOQ maior que o dobro da necessidade, custo acima do preço
máximo. Cada um com o motivo em texto.

## Cenários

MENOR_CUSTO, MENOR_PRAZO, MAIOR_PRAZO_PAGAMENTO, MELHOR_SCORE,
FORNECEDOR_UNICO, COMPRA_DIVIDIDA e PERSONALIZADO. Nenhum altera a cotação.

**Compare pelo `custo_por_unidade`, não pelo total.** Cenários atendem
quantidades diferentes, e o que compra menos sempre soma menos — a bateria pegou
exatamente esse engano (o cenário "menor custo" somava mais que o "menor prazo"
porque cobria 6.000 unidades contra 4.000).

## Decisão

A recomendação é calculada; a decisão é do comprador. Quando a escolha diverge
da recomendação, **a justificativa passa a ser obrigatória** e a divergência
fica registrada em `cotacoes.decisao_divergente`.

Aprovação respeita a alçada por valor (a mesma tabela do módulo 05).

## Fluxo

```
RASCUNHO → ENVIADA → AGUARDANDO_RESPOSTAS → EM_ANALISE
   → NEGOCIACAO_NECESSARIA → APROVADA_NEGOCIACAO → ENCAMINHADA
   ou REJEITADA ou CANCELADA
```

Status do fornecedor: NAO_ENVIADO, ENVIADA, VISUALIZADO, RESPONDIDA,
PARCIALMENTE_RESPONDIDA, RECUSADA, EXPIRADO.

## Permissões

| Permissão | Quem tem |
|---|---|
| `cotacoes.ler` | ADMIN, GESTOR_COMPRAS, COMPRADOR, DIRETORIA, QUALIDADE, FINANCEIRO, ESTOQUE |
| `cotacoes.criar` / `cotacoes.editar` | ADMIN, GESTOR_COMPRAS, COMPRADOR |
| `cotacoes.responder` | ADMIN, GESTOR_COMPRAS, COMPRADOR |
| `cotacoes.analisar` | ADMIN, GESTOR_COMPRAS, COMPRADOR |
| `cotacoes.aprovar` | ADMIN, GESTOR_COMPRAS, DIRETORIA |
| `cotacoes.criterios` | ADMIN, GESTOR_COMPRAS |

## API

```
GET  /api/cotacoes/dashboard              POST /api/cotacoes
GET  /api/cotacoes/criterios              GET  /api/cotacoes
GET  /api/cotacoes/fornecedores/:id/historico
POST /api/cotacoes/expirar-pendentes      GET  /api/cotacoes/:id
                                          PUT  /api/cotacoes/:id
GET  /api/cotacoes/:id/solicitacao        POST /api/cotacoes/:id/fornecedores
POST /api/cotacoes/:id/enviar             DELETE /api/cotacoes/:id/fornecedores/:fid
POST /api/cotacoes/:id/fornecedores/:fid/lembrete
POST /api/cotacoes/:id/fornecedores/:fid/visualizada
POST /api/cotacoes/:id/respostas          GET  /api/cotacoes/:id/respostas
GET  /api/cotacoes/:id/criterios          PUT  /api/cotacoes/:id/criterios
POST /api/cotacoes/:id/analisar           GET  /api/cotacoes/:id/comparativo
GET  /api/cotacoes/:id/matriz             GET  /api/cotacoes/:id/recomendacao
GET  /api/cotacoes/:id/economia           GET  /api/cotacoes/:id/consolidacao
GET  /api/cotacoes/propostas/:itemId/pontuacao
POST /api/cotacoes/:id/cenarios           GET  /api/cotacoes/:id/cenarios
GET  /api/cotacoes/cenarios/:cenarioId    DELETE /api/cotacoes/cenarios/:cenarioId
POST /api/cotacoes/:id/selecionar         POST /api/cotacoes/:id/negociacao
POST /api/cotacoes/:id/aprovar            POST /api/cotacoes/:id/rejeitar
POST /api/cotacoes/:id/encaminhar-negociacao
GET  /api/cotacoes/:id/pacote-negociacao
```

## Testes

```bash
npm run dev        # em um terminal
npm run test:m06   # em outro
```

164 verificações: 40 sobre a matemática pura (custo total, câmbio, faixas de
volume, normalização, score com dado faltando, elegibilidade, recomendação),
23 sobre o fluxo da cotação e 101 sobre propostas, score e decisão — incluindo
os quatro testes dirigidos das seções 53 a 56.

Os dados de teste usam o prefixo `M06-` e ficam no banco.
