# MÓDULO 09 — Recebimento, conferência, qualidade e não conformidades

## O que este módulo faz

Pega a carga que o módulo 08 anunciou como pronta para recebimento e decide,
com rastro, **o que entra no estoque, quanto, em que lote e em que condição**.
Cobre chegada, conferência documental, contagem física, lote e validade,
inspeção de qualidade, divergência, quarentena, não conformidade, devolução ao
fornecedor e a entrada de estoque propriamente dita.

É o único ponto do sistema em que mercadoria comprada vira saldo. Por isso a
regra que organiza tudo aqui é uma só: **nada entra sem conferência, e nada
entra sem movimentação correspondente**.

Não calcula score nem ranking de fornecedor — os dados brutos ficam prontos
para o módulo 10 consumir.

## Banco

### Reaproveitado

`recebimentos`, `recebimento_itens`, `inspecoes_qualidade`,
`nao_conformidades`, `lotes`, `estoques`, `movimentacoes_estoque`,
`ordens_compra`, `ordem_compra_itens`, `entregas`, `entrega_itens`,
`produtos`, `produto_fornecedor`, `fornecedores`, `locais`, `unidades`,
`alertas`, `auditoria`, `configuracoes`, `pedido_historico`.

### A decisão estrutural: `quantidade_disponivel`

`estoques.quantidade_disponivel` era `físico − reservado`. Isso não sobrevive
às regras 4 e 5 da seção 58: produto reprovado não pode entrar como disponível
e produto em quarentena não pode contar como disponível. Com a fórmula antiga,
40 kg retidos em quarentena apareceriam como vendáveis.

A coluna foi redefinida (migration 024), continuando **gerada** — não há como
alguém esquecer de atualizar:

```sql
quantidade_disponivel =
  quantidade_fisica
  - quantidade_reservada
  - quantidade_quarentena      -- novo
  - quantidade_bloqueada       -- novo
  - quantidade_recebimento     -- novo (chegou, ainda não liberado)
```

O material retido continua existindo no físico — ele está no depósito — mas
sai do disponível. É a diferença entre "não temos" e "temos e não podemos
usar", e o sistema precisa saber distinguir as duas.

Isso obrigou a recriar as views dependentes (`vw_estoque_atual`,
`vw_produtos_criticos`, `vw_base_planejamento`), que ganharam as três
quantidades novas.

### Novo (migrations 023 e 024)

| Objeto | Para quê |
|---|---|
| `parametros_tolerancia` | tolerância por escopo: produto, fornecedor, categoria, operação, empresa (§13) |
| `recebimento_documentos` | conferência documental item a item (§8) |
| `recebimento_divergencias` | toda divergência com decisão, autor e justificativa — **DELETE bloqueado** (§27–30) |
| `checklists_qualidade` + `checklist_qualidade_itens` | critérios de inspeção, com eliminatório (§17, §18) |
| `inspecao_itens` | resposta por critério da inspeção |
| `quarentenas` | ticket de retenção com número, motivo e decisão (§31, §32) |
| `devolucoes` + `devolucao_itens` | devolução ao fornecedor, com autorização explícita (§34) |
| `nao_conformidade_acoes` | ações corretivas, preventivas e de contenção (§36) |
| `recebimento_aprovacoes` | exceções autorizadas, **append-only** (§58 regra 8) |
| `recebimento_anexos` | referência de foto, laudo e documento — nunca o binário |
| `vw_rastreabilidade_recebimento` | pedido → recebimento → lote → movimentação, em uma linha |
| +22 colunas em `recebimentos` | chegada, doca, volumes, transporte, NF, conferência, aprovação, quantidades |
| +17 colunas em `recebimento_itens` | conferida, quarentena, devolvida, lote, fabricação, validade, vida útil, situação, destino, local, conferente |
| +5 colunas em `produtos` | `controla_lote`, `controla_validade`, `vida_util_minima_percentual`, `exige_inspecao`, `checklist_qualidade_id` |
| +6 em `lotes`, +9 em `inspecoes_qualidade`, +10 em `nao_conformidades` | rastreabilidade, amostragem e tratativa |

### Migrations de correção (026 a 030)

Cinco migrations existem porque o módulo 09 expôs regras do módulo 03 que não
sobreviviam ao fluxo real da doca:

| # | O que mudou | Por quê |
|---|---|---|
| 026 | `ck_receb_item_qtd` passa a aceitar quantidade zero | o item nasce quando a carga é aberta e só recebe quantidade quando alguém conta. Exigir `> 0` na criação obrigaria o sistema a inventar um número antes da contagem |
| 027 | desativa `trg_receb_item_valida_quantidade` e `trg_oc_item_valida_recebido` | recusar no banco 110 caixas contra 100 pedidas **apaga o fato**. O conferente precisa registrar o que chegou; o excesso vira divergência com decisão, autor e justificativa — controle melhor do que um erro sem rastro |
| 028 + 029 | novo tipo `DEVOLUCAO_FORNECEDOR` (sinal −1) | `DEVOLUCAO` valia +1: é devolução **de cliente**, que soma ao estoque. Devolver ao fornecedor é o oposto |
| 030 | remove `recebimento.tolerancia_excesso_percentual` | ficou órfã com a 027. Deixá-la na tela seria oferecer um botão que não faz nada; o valor virou a linha de empresa em `parametros_tolerancia` |

### Integridade no banco

- `recebimento_divergencias` **recusa DELETE** por trigger (§58 regra 7);
- `recebimento_aprovacoes` é append-only: exceção autorizada não se apaga;
- `auditoria` cobre recebimentos, itens, inspeções, NCs, quarentenas e
  devoluções.

### Configurações (grupo `recebimento`)

15 parâmetros, todos editáveis na tela: exigir conferência, exigir documentos,
exigir lote de produto controlado, vida útil mínima padrão, limiares de
validade próxima e crítica, destino padrão, excesso exige aprovação, rateio de
frete e impostos no custo, dias de alerta de validade e prefixos de numeração.

## A conta

Tudo em `modules/recebimento/calculos.ts` — sem banco, sem request, testável
isoladamente.

### Quantidade e tolerância (§10, §12, §13)

```
diferença   = recebida − pedida
percentual  = diferença / pedida × 100
situação    = EXATA | FALTA | SOBRA
dentro da tolerância = |diferença| ≤ pedida × (tolerância % / 100)
```

A tolerância é resolvida **do mais específico para o mais geral**: produto →
fornecedor → categoria → operação → empresa. A linha de empresa sempre existe
e serve de piso. A tolerância aplicada sai junto com a divergência, para o
comprador ver contra que número a decisão foi tomada.

Item sem quantidade pedida (mercadoria que chegou sem constar no pedido) **não
ganha percentual inventado**: o campo vem nulo e o item nasce com a divergência
`ITEM_NAO_PEDIDO`.

### Conversão de unidade (§14)

Produto sem fator de conversão cadastrado devolve `null` com o motivo, **nunca
assume 1**. Assumir 1 transformaria uma caixa de 12 em uma unidade e o erro só
apareceria no inventário.

### Validade — a regra dos 80% (§16)

```
vida útil total   = fabricação → validade, quando há fabricação
                    dias_validade do produto, caso contrário
dias restantes    = validade − hoje
vida útil restante % = dias restantes / vida útil total × 100
```

O mínimo exigido vem do produto, ou do acordo com aquele fornecedor
(`produto_fornecedor`), ou do parâmetro geral. Situações: `ADEQUADA`,
`PROXIMA`, `CRITICA`, `INSUFICIENTE`, `VENCIDO`, `SEM_CONTROLE`.

A vida útil sai do **lote**, não do cadastro, sempre que a data de fabricação
existir: um lote fabricado há 100 dias com validade para daqui a 100 tem 200
dias de vida útil e está em 50% — independentemente de o cadastro dizer 365.

### Amostragem e checklist (§17, §18)

Quatro tipos: total, amostragem, lote e percentual. Amostra menor que a
exigida sai marcada como **insuficiente com o motivo**, não silenciosamente
aprovada.

No checklist, **um critério eliminatório reprovado reprova o lote inteiro**.
Critério não eliminatório reprovado dá `APROVADO_COM_RESSALVA`. Checklist só
com `NAO_APLICAVEL` fica `PENDENTE` — não vira aprovação por omissão.

### Custo de entrada (§22)

```
custo unitário = (preço − desconto + frete + impostos + outros) × câmbio
```

Tudo por unidade recebida, com frete e impostos ligáveis por configuração. O
cálculo devolve a **memória da conta**. O custo de referência do produto é
atualizado por média ponderada, a mesma regra do módulo 03.

### Destino do item (§30, §33, §58)

`decidirDestino` separa o que chegou em aceito, quarentena e rejeitado:

| Situação | Destino | Aceito |
|---|---|---|
| Produto controlado por lote, sem lote | `AREA_RECEBIMENTO` | 0 |
| Vencido | `RECUSADO` | 0 |
| Vida útil abaixo do mínimo, sem exceção | `QUARENTENA` | 0 |
| Vida útil abaixo do mínimo, com exceção autorizada | destino padrão | tudo |
| Reprovado na inspeção | `RECUSADO` | 0 |
| Retido pela inspeção | `QUARENTENA` | 0 |
| Aprovado com ressalva | destino padrão | total − reprovado − quarentena |
| Conforme | destino padrão | tudo |

O destino é calculado já na **conferência** — a tela do conferente mostra para
onde o material vai antes da aprovação — e **recalculado** quando a inspeção
emite o laudo e de novo na aprovação, com as exceções autorizadas em mãos.

### Semáforo (§52)

Quatro dimensões (quantidade, validade, lote, qualidade) e o geral, que é a
pior delas. **Cinza é pendente de informação, não é verde**: antes da
conferência a falta de lote é informação que ainda não chegou, não falha.
Vermelho de lote só depois que o conferente fechou o item sem lote.

## Fluxo

```
AGUARDANDO_CHEGADA → CHEGOU → EM_CONFERENCIA → AGUARDANDO_QUALIDADE
  → APROVADO | APROVADO_PARCIALMENTE | QUARENTENA | REJEITADO | DEVOLVIDO
```

A aprovação é **uma transação só** (§48). Na ordem: exceções autorizadas →
lote → estoque → custo médio → item → entrega → pedido → histórico. Se
qualquer passo falhar, nada acontece — não existe estado em que o lote foi
criado mas o estoque não entrou.

### Quem move o saldo

Esta é a fronteira mais importante do módulo, e foi onde apareceram três bugs
reais durante os testes:

- **`movimentacoes_estoque` é a única dona de `quantidade_fisica`** e da
  quantidade do lote. O gatilho `fn_aplicar_movimentacao_estoque` aplica a
  movimentação. Código que também somasse o saldo contaria a entrada duas
  vezes — era exatamente o que acontecia na aprovação, na devolução e na
  rejeição de quarentena.
- **Os baldes de quarentena, bloqueio e área de recebimento são do módulo
  09** — o gatilho não os conhece. Eles saem do disponível pela coluna gerada.
- **Liberar quarentena não gera movimentação.** A mercadoria já está no
  depósito; ela só troca de balde. Registrar uma entrada ali criaria saldo do
  nada. O rastro fica na própria quarentena e na auditoria.

A bateria fixa isso como invariante: o desvio entre o saldo físico e a soma
das movimentações **não pode crescer** ao longo do teste.

### Status final do recebimento

```
nada aceito, algo recebido → QUARENTENA (se houver retido) ou REJEITADO
rejeitado, retido, ou saldo pendente no pedido → APROVADO_PARCIALMENTE
resto → APROVADO
```

Receber 90 de 100 e aceitar tudo que chegou é **aprovação parcial**, não
aprovação: o pedido continua com saldo. Era isso que o cenário 2 da seção 60
pedia.

### Divergência

Nasce `PENDENTE`, com autor, valores esperado e recebido, diferença,
percentual e a tolerância aplicada. Decisões: `ACEITAR`, `ACEITAR_PARCIAL`,
`DEVOLVER`, `RECUSAR`, `AUTORIZAR_COMERCIAL` — todas exigem justificativa.

Reconferir um item **não apaga** a divergência anterior: ela fica com decisão
`RECUSAR` e a justificativa de que foi substituída.

### Exceção — quando é realmente exigida

Aviso não é bloqueio, e nem todo aviso exige exceção. O critério é: **aprovar
do jeito que está faria material entrar como disponível sem autorização?**

- Validade abaixo do mínimo **não exige** exceção para aprovar — sem exceção o
  lote fica retido em quarentena, que é o desfecho conservador. A exceção
  serve para **liberar**, não para aprovar.
- Excesso de quantidade e divergência comercial pendente **exigem**, porque o
  que está em jogo é liberar mercadoria que ninguém autorizou.
- Uma vez decidida a divergência de excesso, a exceção deixa de ser exigida: a
  decisão já tem autor e justificativa gravados. Cobrar duas autorizações pelo
  mesmo fato só faria o usuário clicar duas vezes.

### Não conformidade

Máquina de estados real (§36):

```
ABERTA → EM_ANALISE → ACAO_DEFINIDA → AGUARDANDO_FORNECEDOR / EM_TRATATIVA
       → RESOLVIDA → VALIDADA → ENCERRADA
```

Não se pula de `ABERTA` para `ENCERRADA`, e resolver ou encerrar **exige
descrever o desfecho**. Lote reprovado na inspeção abre NC crítica sozinho —
quem reprova na doca não deveria precisar lembrar de abrir a NC depois.

### Devolução

Nasce `RASCUNHO`, **sem efeito nenhum no estoque**. Só a autorização explícita
gera a movimentação `DEVOLUCAO_FORNECEDOR`. Devolver mais do que foi recebido
é recusado.

## Integrações

| Módulo | O que entra / sai |
|---|---|
| **03** | estoque, lotes, movimentações e custo médio — **saída** deste módulo |
| **04** | classificação ABC do produto, para priorizar a doca |
| **05** | o saldo que volta a ser necessidade quando o recebimento é parcial |
| **07** | pedido, itens, preços e condições. **Nada comercial é alterado aqui** |
| **08** | a entrega pronta para recebimento vira o recebimento; a conferência volta para `entrega_itens` |
| **10** | `GET /api/fornecedores/:id/qualidade` entrega dados brutos: recebimentos, taxas, NCs, devoluções, divergências e qualidade. **Nenhum score consolidado** |

## Indicadores

- **Painel** (§44): 20 indicadores operacionais — fila do dia, em conferência,
  aguardando qualidade, divergências abertas, NCs abertas, quarentena,
  validade crítica, lote irregular, valor recebido — mais recebimentos por
  status e divergências por natureza.
- **Indicadores** (§37): taxa de aprovação, de divergência e de rejeição,
  tempo médio de recebimento e de conferência, **com a fórmula de cada um**.
- **Qualidade** (§38): percentuais de aprovação, recusa e quarentena, NCs por
  tipo, severidade, fornecedor, produto e categoria, tempo médio de resolução.
- **Validade / FEFO** (§15, §34): lotes em estoque ordenados por validade, com
  dias restantes e situação.

Todo indicador sai com período, base de dados e quantidade de registros.

## Alertas (§53)

Lote não informado, validade insuficiente, produto vencido, recebimento
divergente, quarentena aberta, NC crítica, devolução pendente e aprovação
pendente — com severidade e contagem por severidade.

## Permissões (§59)

| Permissão | Quem tem |
|---|---|
| `recebimento.ler` | ADMIN, GESTOR_COMPRAS, COMPRADOR, ESTOQUE, QUALIDADE, FINANCEIRO, DIRETORIA |
| `recebimento.registrar` | ADMIN, GESTOR_COMPRAS, COMPRADOR, ESTOQUE |
| `recebimento.aprovar` | ADMIN, GESTOR_COMPRAS, ESTOQUE |
| `recebimento.devolucao` | ADMIN, GESTOR_COMPRAS, COMPRADOR |
| `recebimento.excecao` | ADMIN, GESTOR_COMPRAS |
| `recebimento.parametrizar` | ADMIN, GESTOR_COMPRAS |
| `qualidade.inspecionar` | ADMIN, GESTOR_COMPRAS, QUALIDADE, ESTOQUE |
| `qualidade.liberar` | ADMIN, GESTOR_COMPRAS, QUALIDADE |
| `qualidade.nao_conformidade` | ADMIN, GESTOR_COMPRAS, COMPRADOR, QUALIDADE |

ESTOQUE confere e aprova a entrada mas **não parametriza tolerância**;
QUALIDADE inspeciona e libera quarentena mas **não aprova recebimento**.

## API

```
GET  /api/recebimentos/dashboard        GET  /api/recebimentos/indicadores
GET  /api/recebimentos/alertas          GET  /api/recebimentos/controle-validade
GET  /api/recebimentos/checklists       POST /api/recebimentos/checklists
GET  /api/recebimentos/parametros       PUT  /api/recebimentos/parametros
POST /api/recebimentos/tolerancias

GET  /api/recebimentos                  POST /api/recebimentos
GET  /api/recebimentos/:id              PUT  /api/recebimentos/:id
POST /api/recebimentos/:id/chegada      POST /api/recebimentos/:id/documentos
GET  /api/recebimentos/:id/itens        POST /api/recebimentos/:id/itens
POST /api/recebimentos/:id/conferencia
POST /api/recebimentos/:id/conferencia/concluir
POST /api/recebimentos/:id/escanear     POST /api/recebimentos/:id/divergencia
GET  /api/recebimentos/:id/qualidade    POST /api/recebimentos/:id/inspecao
POST /api/recebimentos/:id/quarentena
GET  /api/recebimentos/:id/validar      POST /api/recebimentos/:id/aprovar
POST /api/recebimentos/:id/reprovar
GET  /api/recebimentos/:id/rastreabilidade
GET  /api/recebimentos/:id/anexos       POST /api/recebimentos/:id/anexos

POST /api/recebimento-itens/:id/conferir

GET  /api/divergencias                  POST /api/divergencias/:id/decidir
GET  /api/quarentenas                   POST /api/quarentenas/:id/decidir

GET  /api/nao-conformidades/dashboard
GET  /api/nao-conformidades             POST /api/nao-conformidades
GET  /api/nao-conformidades/:id         PUT  /api/nao-conformidades/:id
POST /api/nao-conformidades/:id/acoes   POST /api/nc-acoes/:id/concluir

GET  /api/devolucoes                    POST /api/devolucoes
GET  /api/devolucoes/:id                POST /api/devolucoes/:id/autorizar

GET  /api/fornecedores/:id/qualidade
```

## Tela

`/recebimentos` — oito abas: **Painel**, **Recebimentos**, **Divergências**,
**Não conformidades**, **Quarentenas**, **Devoluções**, **Validade (FEFO)** e
**Parâmetros**.

A **tela de conferência** (§51) é a operacional. Cabeçalho com pedido,
fornecedor, NF, data e status; depois a grade:

```
Produto | Pedido | Recebido | Diferença | Lote | Validade | Qualidade | Destino | Status
```

Quantidade, lote e validade são editáveis direto na linha. Cada coluna carrega
seu semáforo, e o bloco "o que falta para aprovar" mostra bloqueios e avisos
**em português**, separando o que impede de aprovar do que exige exceção. O
botão de aprovar fica desabilitado enquanto houver bloqueio, com o motivo no
`title`.

## Testes

```bash
npm run dev        # em um terminal
npm run test:m09   # em outro
```

**137 verificações**: 42 sobre a matemática pura, 50 sobre os seis cenários
obrigatórios da seção 60 ponta a ponta pela API, e 45 sobre regras críticas,
NC, devolução, permissões e fronteiras.

Os seis cenários da seção 60:

| # | Situação | Resultado verificado |
|---|---|---|
| 1 | 100 pedidas, 100 recebidas, validade adequada | `APROVADO`, 100 no físico e no disponível, movimentação gerada, lote criado, pedido sem saldo |
| 2 | 100 pedidas, 90 recebidas | divergência `QUANTIDADE_MENOR` pendente → decidida → `APROVADO_PARCIALMENTE` com 10 de saldo |
| 3 | 100 pedidas, 110 recebidas | com tolerância de 5%: divergência, aprovação bloqueada até decidir. Com 102: passa direto |
| 4 | vida útil de 70% contra mínimo de 80% | `INSUFICIENTE`, destino `QUARENTENA`, 50 no balde de quarentena, **zero no disponível** |
| 5 | problema de qualidade | inspeção → quarentena → retido; liberação move de balde **sem criar estoque novo** |
| 6 | lote reprovado (critério eliminatório) | destino `RECUSADO`, **nada** entra no disponível nem no físico, NC aberta automaticamente |

E as oito categorias da seção 59: recebimento (integral, parcial, acima,
abaixo), lote (obrigatório, duplicado, inválido), validade (adequada, crítica,
insuficiente, vencida), qualidade (aprovado, com ressalva, reprovado,
quarentena), estoque (entrada aprovada, bloqueada, lote e local corretos),
divergências (quantidade, validade, lote, produto, documentação), devolução
(parcial e total) e permissões por perfil.

Os dados de teste usam o prefixo `M09-`.

## Pendências assumidas

- **Exportação** para Excel, CSV e PDF (§55) — pedida desde o módulo 04,
  deliberadamente adiada para ser feita uma vez só, de forma genérica.
- **Notificações** (§54) — a estrutura de alertas existe e é alimentada; o
  disparo por e-mail e push é do módulo 13.
- **Anexo** guarda a referência do arquivo, não o binário: o armazenamento é
  do módulo 14.
- **Leitura de código de barras** (§11) existe pela API (`/escanear`), mas a
  tela ainda não tem o campo de leitor.
