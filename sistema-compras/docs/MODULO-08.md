# MÓDULO 08 — Acompanhamento de pedidos, entregas, atrasos e performance

## O que este módulo faz

Recebe o pedido enviado no módulo 07 e cuida de tudo que acontece depois:
confirmação do fornecedor, programação, entrega (inteira ou em pedaços),
atraso, ocorrência, previsão de chegada e performance logística. Não dá
entrada física no estoque nem faz conferência — isso é do módulo 09. O que sai
daqui é o pacote de recebimento.

## Banco

### Reaproveitado

`ordens_compra`, `ordem_compra_itens`, `pedido_confirmacoes`,
`pedido_historico`, `entregas`, `estoques`, `movimentacoes_estoque`,
`necessidades_compra`, `previsoes_demanda`, `mv_demanda_diaria`,
`fornecedores`, `produtos`, `lotes`, `locais`, `alertas`, `notificacoes`,
`auditoria`, `configuracoes`.

### A decisão estrutural

`entregas` já existia, mas só no nível de cabeçalho: uma linha por entrega,
com a quantidade total e **sem saber quais produtos vieram**. A seção 16 exige
atraso por item e a 17 exige várias entregas por pedido — as duas coisas
precisam do nível de item. Em vez de criar uma tabela paralela, `entregas`
ganhou **`entrega_itens`** e os campos que faltavam.

### Novo (migration 022)

| Objeto | Para quê |
|---|---|
| `entrega_itens` | produto, quantidade e lote de cada entrega |
| `entrega_programacoes` + itens | programação de entrega (§19) |
| `alteracoes_prazo` | histórico de mudança de data, **append-only** (§12, §13, §80) |
| `previsoes_entrega` | histórico de ETA com fonte e confiança, **append-only** (§44–46) |
| `status_logistico_historico` | histórico do status logístico, **append-only** (§35) |
| `ocorrencias_entrega` | ocorrência logística com SLA congelado (§30, §31) |
| `acoes_atraso` | o que se fez sobre o atraso (§26) |
| `contatos_fornecedor_pedido` | contatos, sem delete (§32, §33) |
| `transportes_pedido` | transporte nacional e importação (§34, §47) |
| `motivos_atraso` | catálogo, não enum: dá para incluir motivo novo sem migration (§29) |
| `documentos_entrega` | metadado de documento vinculado (§48) |
| `vw_acompanhamento_itens` | uma linha por item de pedido, base das telas |
| 12 colunas em `entregas` | número, sequência, promessa, necessidade, local, transporte, NF, motivo, pronta para recebimento |
| 12 colunas em `ordens_compra` | status logístico, status de confirmação, promessa original, ETA (original, atual, fonte, confiança), prioridade, data efetiva |
| 4 colunas em `ordem_compra_itens` | promessa original, quantidade entregue, data efetiva, motivo de atraso |

### Integridade no banco (§63)

Duas regras ficam em trigger, não só no service — assim valem também para
carga e correção manual:

- a soma das entregas de um item **não pode passar** a quantidade pedida
  (tolerância em `entrega.tolerancia_excedente_percentual`, zero por padrão);
- **pedido cancelado ou rejeitado não recebe entrega**.

Os históricos (`alteracoes_prazo`, `previsoes_entrega`,
`status_logistico_historico`, `contatos_fornecedor_pedido`) recusam UPDATE e
DELETE no próprio banco.

### Configurações (grupo `entrega`)

22 parâmetros, todos editáveis na tela: faixas de atraso, janelas de risco,
limiares de cobertura para ruptura, SLA por prioridade, metodologia do OTIF
(data de referência, tolerância de dias, tolerância de quantidade, unidade de
análise, mínimo de entregas) e prefixos de numeração. Nenhum desses números
está no código.

## A conta

Tudo em `modules/entregas/calculos.ts`, sem banco e sem request.

### Atraso (§14, §15)

```
atraso contra a promessa    = data avaliada − data prometida
atraso contra a necessidade = data avaliada − data necessária
data avaliada = data efetiva, quando o item foi atendido POR INTEIRO
                hoje, enquanto sobrar saldo
```

Três coisas que essa fórmula resolve:

1. **Atraso do fornecedor e impacto interno são medidas diferentes.** Entregar
   12/10 tendo prometido 12/10 não é atraso dele — mas se a necessidade era
   10/10, o impacto interno de 2 dias existe e aparece.
2. **Entrega parcial não quita o prazo.** Enquanto houver saldo, a data
   avaliada é hoje: um item com 200 kg vencidos há 10 dias não pode aparecer
   como entregue no prazo porque a primeira remessa chegou.
3. **O atraso é medido contra hoje, não contra a previsão.** Usar a previsão
   contaria como atraso de hoje um dia que ainda não chegou. A previsão entra
   em `projetado`, separada: um pedido com promessa vencida há 2 dias e ETA
   daqui a 6 está **atrasado em 2 dias hoje e caminha para 8** — as duas
   leituras importam para decidir o que fazer.

Classificação em faixas parametrizáveis: no prazo, leve, moderado, alto,
crítico.

### Saldo (§10, §18)

Quatro quantidades que **não se misturam**: pedida, confirmada, entregue e
recebida. Confirmado não é recebido. O saldo pendente de entrega e o saldo não
confirmado são contas diferentes.

### OTD, In Full e OTIF (§37–39)

```
OTD     = entregas com atraso ≤ tolerância / entregas avaliadas
In Full = entregas com quantidade ≥ (100 − tolerância)% / entregas avaliadas
OTIF    = entregas no prazo E integrais / entregas avaliadas
```

O ponto decisivo é o denominador. Uma entrega que **ainda não aconteceu**, ou
que não tem data de referência cadastrada, não é "não OTIF" — ela é **não
avaliável** e fica fora da conta. Contar como falha puniria o fornecedor por
lacuna de cadastro nossa. Os indicadores sempre devolvem quantas entradas
entraram e quantas ficaram de fora.

Tudo sai com a regra usada junto: data de referência, tolerância de dias,
tolerância de quantidade e unidade de análise (item ou pedido).

### ETA (§44–46)

Calculada pela melhor evidência disponível, nesta ordem:

| Fonte | Quando | Confiança |
|---|---|---|
| Transporte | carga já expedida, com data do transporte | alta |
| Transporte | data do transporte, carga ainda não expedida | média |
| Promessa ajustada | fornecedor com histórico pior que o contratado | média |
| Promessa | pedido confirmado | alta |
| Promessa | ainda sem confirmação | média |
| Lead time histórico | sem promessa, com histórico suficiente | baixa |
| Lead time contratado | sem promessa e sem histórico | baixa |
| — | nada disso | **SEM_DADOS, ETA nula** |

Cada previsão grava a memória do cálculo: qual regra valeu, que números
entraram e qual desvio foi aplicado. Sem evidência, o sistema diz **SEM
INFORMAÇÃO** em vez de inventar uma data (§76).

### Risco de ruptura (§23, §24)

```
cobertura = estoque disponível / demanda média diária
data provável de ruptura = hoje + cobertura
```

O **estoque em trânsito não entra na posição**: justamente o que está atrasado
costuma estar contado ali, e somar isso esconderia a ruptura que estamos
tentando enxergar. O trânsito entra pela **data de chegada**, comparada com a
data de ruptura — daí sai `chegaATempo`, que é o que muda a decisão.

Sem demanda apurada, a resposta é `NAO_CALCULAVEL` com o motivo, não uma data
inventada.

### Semáforo e matriz (§6, §58)

O semáforo cruza **situação** (no prazo / em risco / atrasado) com **impacto**
(baixo / médio / alto / crítico), pela matriz da seção 58. Sem informação
suficiente é **cinza**, nunca verde.

"Em risco" não é uma fórmula única (§22): é um conjunto de sinais
configuráveis — data próxima, previsão vencida, falta de confirmação, prazo já
alterado, histórico de atraso do fornecedor, falta de previsão, ocorrência
aberta, produção não iniciada. **Os sinais que dispararam saem junto**, para o
comprador ver por que aquilo está amarelo.

A matriz do dashboard cobre todas as situações e inclui a coluna
`SEM_DADOS` — uma matriz cuja soma não fecha com o total da carteira esconde
justamente os itens que ninguém consegue avaliar.

## Fluxos

### Acompanhamento

```
PEDIDO APROVADO → ENVIADO → AGUARDANDO CONFIRMAÇÃO → CONFIRMADO
  → EM PRODUÇÃO → PRONTO PARA EXPEDIÇÃO → EXPEDIDO → EM TRÂNSITO
  → CHEGOU → AGUARDANDO RECEBIMENTO → (MÓDULO 09)
```

O status logístico é **separado** do status comercial: um pedido CONFIRMADA
(comercial) pode estar EM_PRODUCAO, EXPEDIDO ou EM_TRANSITO. Não há máquina de
estados rígida aqui de propósito — a logística real anda para trás (carga
volta, embarque cai), e travar transições faria o comprador mentir para o
sistema. O que é obrigatório é o rastro: toda mudança vai para o histórico
append-only.

### Entrega

Uma entrega tem cabeçalho e itens. Registrar uma entrega:

1. cria `entregas` + `entrega_itens` (o trigger barra excesso e pedido
   cancelado);
2. soma `quantidade_entregue` no item do pedido e recalcula o pendente;
3. move o pedido para RECEBIMENTO_PARCIAL ou RECEBIDA, e o status logístico
   para ENTREGA_PARCIAL ou AGUARDANDO_RECEBIMENTO;
4. marca a entrega como **pronta para recebimento**.

Nenhuma dessas etapas movimenta saldo físico de estoque.

### Alteração de prazo

A promessa original **nunca é apagada**: fica em `data_prometida_original` e o
que muda é a promessa atual. Cada mudança vira uma linha append-only com data
anterior, data nova, diferença em dias, motivo, origem e usuário. Se a nova
data passar da necessidade, a linha é marcada e um alerta é gerado.

Contato com fornecedor que traz "nova previsão" **não altera o prazo sozinho**:
a informação fica registrada no contato, e mudar a data continua sendo uma
alteração de prazo explícita, com motivo e histórico.

### Ocorrências e SLA

O SLA não é um campo que alguém digita: vem da prioridade, pela tabela de
configurações, e fica **congelado na ocorrência**. Mudar o parâmetro depois não
reescreve o prazo de quem já estava aberto. Resolver exige descrever a solução.

## Integrações

| Módulo | O que entra |
|---|---|
| **03** | estoque disponível, reservado e em trânsito, lotes |
| **04** | demanda média, previsão, ABC/XYZ — base do impacto do atraso |
| **05** | necessidade e data necessária, que nunca são substituídas pela promessa |
| **07** | pedido, itens, quantidades, preços, condições e nº do pedido do fornecedor. Nada comercial é alterado aqui |
| **09** | `GET /api/entregas/:id/recebimento` entrega o pacote. Nenhum recebimento é criado |

## Fuso horário — um bug encontrado aqui

Datas de calendário estavam virando `Date` a meia-noite UTC e, num fuso
negativo (America/São_Paulo), **voltavam um dia** ao serem gravadas: uma
entrega programada para 26/09 ficava 25/09 no banco. O mesmo acontecia na
exibição.

A correção foi estrutural e vale para o sistema inteiro:

- `core/datas.ts`: data de calendário trafega como texto `AAAA-MM-DD` do
  request até o banco, sem virar `Date` no caminho — aplicado nos schemas dos
  módulos 05, 06, 07 e 08;
- `config/database.ts`: o driver passa a devolver `DATE` como texto;
- `componentes/ui.tsx`: data-só-dia é formatada pelos próprios números.

## Indicadores

- **Dashboard** (§5): 19 indicadores operacionais, semáforo consolidado,
  matriz atraso × impacto, pedidos por status comercial e logístico, produtos
  em risco de ruptura e alertas.
- **OTIF** (§37–40): OTD, In Full, OTIF, atraso médio e máximo, lead time.
- **Performance por fornecedor** (§41–43): os indicadores separados, lead time
  contratado × prometido × real, percentual de parciais, de alterações de prazo
  e de pedidos sem confirmação, com evolução mensal. **Nenhum score único** — a
  avaliação consolidada é do módulo 10.
- **Atrasos** (§27, §28): distribuição por faixa, média, mediana, máximo e
  motivos agregados.

Todo indicador sai com fórmula, período, base de dados e quantidade de
registros (§79). Fornecedor com histórico curto sai marcado como **AMOSTRA
INSUFICIENTE** e vai para o fim do ranking — um fornecedor com uma entrega a
100% não lidera sobre outro com 65 entregas medidas (§81).

## Alertas (§54, §55)

Entrega atrasada, entrega em risco, pedido sem confirmação, pedido sem
previsão, quantidade parcial, risco de ruptura, SLA de ocorrência e fornecedor
com deterioração de performance. O alerta de ruptura traz a conta inteira:
estoque, demanda diária, cobertura, data provável, pedido, fornecedor,
quantidade pendente, atraso e se a carga chega a tempo.

## Permissões (§66)

| Permissão | Quem tem |
|---|---|
| `entregas.ler` | ADMIN, GESTOR_COMPRAS, COMPRADOR, ESTOQUE, QUALIDADE, FINANCEIRO, DIRETORIA |
| `entregas.registrar` | ADMIN, GESTOR_COMPRAS, COMPRADOR, ESTOQUE |
| `entregas.previsao` | ADMIN, GESTOR_COMPRAS, COMPRADOR |
| `entregas.ocorrencias` | ADMIN, GESTOR_COMPRAS, COMPRADOR |
| `entregas.parametrizar` | ADMIN, GESTOR_COMPRAS |

ESTOQUE registra o que o recebimento precisa mas **não mexe em prazo**;
COMPRADOR conduz o acompanhamento mas **não altera a metodologia do OTIF**.

## API

```
GET  /api/entregas/dashboard          GET  /api/entregas/alertas
GET  /api/entregas/calendario         GET  /api/entregas/motivos-atraso
GET  /api/entregas/parametros         PUT  /api/entregas/parametros
GET  /api/entregas/acompanhamento
GET  /api/entregas/atrasadas          GET  /api/entregas/em-risco
GET  /api/entregas/parciais           GET  /api/entregas/sem-confirmacao
GET  /api/entregas/sem-previsao       GET  /api/entregas/em-transito
GET  /api/entregas                    POST /api/entregas
GET  /api/entregas/:id                PUT  /api/entregas/:id
GET  /api/entregas/:id/recebimento
POST /api/entregas/programacoes
GET  /api/entregas/ocorrencias        POST /api/entregas/ocorrencias
GET  /api/entregas/ocorrencias/:id    POST /api/entregas/ocorrencias/:id/tratar
POST /api/entregas/acoes              POST /api/entregas/acoes/:id
POST /api/entregas/contatos           POST /api/entregas/documentos

GET  /api/pedidos-compra/:id/entrega  GET  /api/pedidos-compra/:id/saldo
GET  /api/pedidos-compra/:id/risco
POST /api/pedidos-compra/:id/status-logistico
POST /api/pedidos-compra/:id/alterar-prazo
POST /api/pedidos-compra/:id/previsao
POST /api/pedidos-compra/:id/transporte

GET  /api/indicadores/otif            GET  /api/indicadores/otd
GET  /api/indicadores/in-full         GET  /api/indicadores/atrasos
GET  /api/indicadores/performance-entrega
GET  /api/fornecedores/:id/performance-entrega
```

## Tela

`/entregas` — sete abas: **Dashboard**, **Carteira**, **Calendário**,
**Entregas**, **Ocorrências**, **Performance** e **Parâmetros**. O detalhe do
pedido tem resumo com semáforo, todas as datas separadas (necessária, promessa
original, promessa atual, ETA original, ETA atual, efetiva), itens com saldo e
risco, entregas, histórico de prazos e previsões, timeline e a aba de risco.

Três escolhas de tela que vieram das regras:

- a carteira mostra o desvio como **`2 d → 8`**: atraso de hoje e projeção;
- os sinais de risco aparecem em "por que estes itens estão sinalizados", com a
  regra que disparou;
- dia cheio no calendário mostra os 12 primeiros e conta o resto, em vez de
  virar uma parede.

## Testes

```bash
npm run dev        # em um terminal
npm run test:m08   # em outro
```

261 verificações: 86 sobre a matemática pura, 67 sobre o fluxo completo pela
API e 108 sobre risco, OTIF, ocorrências, permissões e integrações.

Cobre os 34 testes obrigatórios da seção 68 e os oito dirigidos das seções 69 a
76 — atraso de 2 dias, entrega parcial 70/30, OTIF com três fornecedores,
ruptura com cobertura de 5 dias, alteração de prazo de +5 dias, três entregas
somando 100%, pedido cancelado e pedido sem dados.

Os dados de teste usam o prefixo `M08-`. Dois fornecedores nascem novos a cada
execução: há cenários que só existem para quem **não tem** histórico (previsão
sem dados) ou tem pouquíssimo (amostra insuficiente), e histórico de entrega se
acumula no banco.
