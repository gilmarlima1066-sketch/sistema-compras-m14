# MÓDULO 10 — Avaliação de fornecedores, scorecard e performance

## O que este módulo faz

Consolida o que os módulos 06 a 09 já produziram — cotações, pedidos, entregas,
recebimentos, qualidade, não conformidades e preços — em uma **nota por
critério, um score ponderado e um plano de ação**, com a conta inteira à vista.

Não recalcula OTIF, não recalcula saving, não move estoque e não muda o status
comercial de nada. Consome, normaliza e explica.

A regra que organiza o módulo inteiro: **score é consequência de dado, nunca
de opinião nem de preenchimento automático**. Sem dado suficiente, o resultado
é "não calculável" — não é zero.

## Banco

### Reaproveitado

`fornecedores`, `produtos`, `produto_fornecedor`, `categorias`, `cotacoes`,
`cotacao_fornecedores`, `ordens_compra`, `ordem_compra_itens`,
`pedido_alteracoes`, `condicoes_pagamento`, `entregas`, `entrega_itens`,
`entrega_programacoes`, `ocorrencias_entrega`, `recebimentos`,
`recebimento_itens`, `recebimento_divergencias`, `inspecoes_qualidade`,
`nao_conformidades`, `devolucoes`, `historico_precos`, `vw_historico_precos`,
`alertas`, `auditoria`, `configuracoes`, `direcao_criterio_enum`.

### A tabela que já existia

`avaliacoes_fornecedores` existia desde o módulo 02, com **uma coluna fixa por
critério** (`otif`, `qualidade`, `lead_time`, `preco`, `atendimento`,
`flexibilidade`). A seção 58 manda evoluir em vez de duplicar, então:

- a tabela ganhou 20 colunas (metodologia, versão, número, período rotulado,
  status, completude, confiabilidade, eventos, critérios calculados, peso
  aplicado, validação);
- **as notas saíram das colunas e foram para `avaliacao_criterios`**, uma
  linha por critério — só assim dá para ter sete critérios configuráveis;
- as colunas antigas continuam preenchidas por compatibilidade. Apagá-las
  destruiria avaliações já gravadas e quebraria quem já as lia.

### Novo (migrations 031 a 033)

| Objeto | Para quê |
|---|---|
| `metodologias_avaliacao` | metodologia versionada, com escopo e vigência (§9, §35, §36) |
| `metodologia_criterios` | os sete grupos com peso (§10) |
| `metodologia_indicadores` | subcritérios com faixa de normalização e direção |
| `avaliacao_criterios` | nota, peso **aplicado na época** e contribuição (§27) |
| `avaliacao_indicadores` | valor cru, eventos, fórmula e fonte de cada indicador (§3) |
| `historico_score_fornecedor` | série temporal para a evolução (§30) |
| `situacoes_fornecedor` | monitoramento, bloqueio e homologação, com responsável (§39–41) |
| `planos_acao_fornecedor` + `plano_acao_itens` | plano e ações (§37) |
| `plano_acao_historico` | **append-only** (§38) |
| +6 colunas em `fornecedores` | `status_homologacao`, homologação, última e próxima avaliação, score atual |

### Integridade

- **Pesos somam 100** — validado no service (mensagem em português) **e** por
  `CONSTRAINT TRIGGER` deferido no banco, para valer também em carga manual;
- **peso com zero indicador não publica**: um critério que pontua mas nunca
  poderia ser calculado viraria um buraco permanente no score;
- `ck_avaliacao_criterio_calculavel` impede a combinação "não calculável com
  nota" — regra 6 da seção 67 virou constraint;
- **avaliação validada não tem score, metodologia ou período reescritos**
  (trigger `fn_avaliacao_validada_imutavel`) — corrigir exige cancelar e
  refazer, o que deixa rastro;
- `plano_acao_historico` recusa UPDATE e DELETE;
- uma metodologia vigente por escopo, por índices parciais únicos;
- auditoria em metodologias, critérios, avaliações, situações e planos.

### A decisão sobre os pesos antigos

Existiam cinco chaves soltas em `configuracoes` (`fornecedor.peso_otif`,
`peso_qualidade`, `peso_preco`, `peso_atendimento`, `peso_flexibilidade`).
Nenhum código as lia, e elas não davam conta do que a seção 10 pede: sete
grupos, pesos por escopo e versionamento.

Manter as duas coisas seria pior do que uma só — o usuário mudaria a chave e o
score continuaria igual. As chaves foram removidas na migration 033 e os pesos
passaram a viver na **Metodologia 1.0**.

## A conta

Tudo em `modules/avaliacao/calculos.ts` — sem banco, sem request.

### Normalização: número cru vira nota (§26)

```
nota = (valor − pior) / (melhor − pior) × 100,   limitada a [0, 100]
```

A faixa vive na **metodologia**, não no código. Transformar 8% de não
conformidade em nota é decisão de negócio, e decisão de negócio precisa ser
visível e versionada. O código só aplica a regra que a metodologia declarou.

### Amostra mínima vem antes da faixa (§28)

Um fornecedor com **uma** entrega pode ter OTIF de 100%, e esse 100% não diz
nada. Abaixo do mínimo configurado, o indicador é **não calculável com o
motivo**, não nota alta.

### Nota do critério

Média ponderada dos indicadores calculáveis. **Indicador sem dado sai do
denominador**, não entra como zero — somar zero puniria o fornecedor por uma
lacuna de cadastro nossa. Quantos ficaram de fora sai junto.

### Score final (§26, §27)

```
score = Σ (nota × peso / 100),  reescalado pelo peso que foi calculado
```

O reescalonamento importa: se só 70% do peso é calculável, somar as
contribuições daria no máximo 70 e o fornecedor pareceria pior do que é. O
peso usado sai junto, para quem lê saber sobre o que o número repousa.

A tela nunca mostra só o total. A tabela da seção 27 é a resposta padrão:

| Critério | Nota | Peso | Contribuição |
|---|---:|---:|---:|
| Logística | 90 | 25% | 22,50 |
| … | | | |
| **Total** | | **100%** | **83,55** |

### Completude e confiabilidade (§28, §29)

| Completude | Quando |
|---|---|
| `COMPLETA` | todo o peso da metodologia foi calculado |
| `DADOS_PARCIAIS` | parte do peso, acima do limite parcial |
| `DADOS_INSUFICIENTES` | abaixo do limite mínimo → **score nulo** |
| `SEM_HISTORICO` | nenhum evento no período |

Confiabilidade (`ALTA`, `MEDIA`, `BAIXA`, `INSUFICIENTE`) vem da quantidade de
eventos. Como a seção 29 pede, **não vira julgamento do fornecedor** — é a
medida de quanto o próprio número vale.

### Outros indicadores

- **Variação de preço** (§21): preço anterior zero ou ausente **não gera
  percentual**. "Aumentou infinito por cento" não é informação.
- **Posição competitiva** (§22): quanto acima do menor preço elegível, por
  produto, só para produtos com mais de um fornecedor. Sai cru — a seção 22 é
  explícita em não tratar menor preço como melhor decisão.
- **Índice de gravidade de NC** (§19): soma ponderada por gravidade
  (crítica 10, alta 5, média 2, baixa 1) sobre recebimentos. Contar NCs sem
  peso trataria uma embalagem amassada e um lote contaminado como iguais.
- **Tendência** (§43, §44): compara o primeiro e o último ponto da série.
  Relata o movimento e **não conclui a causa**.
- **Concentração** (§48): participação por fornecedor e HHI, geral e **por
  produto** — é aí que o risco costuma se esconder. Um fornecedor pode ser 20%
  das compras e 100% de um item crítico.

## Os sete critérios (Metodologia 1.0)

| Critério | Peso | Indicadores | Fonte |
|---|---:|---|---|
| Logística | 25% | OTIF 40, OTD 20, In Full 20, atraso médio 10, desvio de lead time 10 | módulo 08 |
| Qualidade | 25% | taxa de aprovação 35, taxa de NC 25, quantidade não conforme 15, gravidade 15, devolução 10 | módulo 09 |
| Comercial | 20% | cumprimento de preço 45, de quantidade 30, estabilidade 25 | módulos 07 e 09 |
| Atendimento | 10% | resposta a cotação 40, confirmação de pedido 35, resolução de ocorrência 25 | módulos 06, 07, 08 |
| Preço | 10% | variação 50, posição competitiva 50 | histórico de preços |
| Pagamento | 5% | prazo praticado 60, aderência ao negociado 40 | módulos 02 e 07 |
| Flexibilidade | 5% | aceite de alterações 50, entrega programada 50 | módulos 07 e 08 |

**OTIF, OTD e In Full vêm da função que já existe no módulo 08**, com a
metodologia dele (data de referência, tolerâncias, unidade). A seção 13 pede
exatamente isso. Uma segunda implementação daria dois números diferentes para a
mesma pergunta, e o fornecedor teria razão em não acreditar em nenhum.

## Versionamento (§35, §36)

```
Metodologia 1.0 (vigente) → versionar → 1.1 (rascunho) → editar → publicar
```

- metodologia **publicada é congelada**: mudar peso exige versão nova;
- a avaliação grava o `metodologia_id` **e** o peso aplicado em cada linha;
- avaliações antigas **nunca** são recalculadas quando a metodologia muda.

Sem isso, mudar um peso hoje mudaria o significado de toda avaliação gravada no
ano passado.

## Decisões que o sistema não toma sozinho

| Decisão | Quem toma |
|---|---|
| Mudar status de homologação | pessoa, com motivo e responsável (**regra 9**) |
| Bloquear fornecedor | pessoa, com motivo do bloqueio obrigatório |
| Encerrar plano de ação | pessoa, descrevendo o resultado |
| Escolher fornecedor pelo menor preço | ninguém — o sistema mostra os dados |
| Bloquear compra por concentração | ninguém — informa o risco (**§49**) |

Score baixo gera **alerta** e sugere plano de ação. O cadastro guarda o último
score, e o status de homologação não se move por causa dele.

## Fluxo do plano de ação (§38)

```
ABERTO → EM_ANALISE → ACAO_DEFINIDA → EM_EXECUCAO
       → AGUARDANDO_FORNECEDOR → VALIDACAO → ENCERRADO
```

Não se pula de `ABERTO` para `ENCERRADO`, não se encerra com ação em aberto e
não se encerra sem descrever o resultado. Cada movimento vira uma linha
append-only.

## Um furo de permissão encontrado nos testes

A rota `/fornecedores/:id/situacao` usa permissão diferente conforme o corpo:
`fornecedores.monitorar` para monitoramento, `fornecedores.bloquear` para o
resto. A primeira versão encadeava o middleware por dentro do handler:

```ts
middleware(req, res, async () => { /* ação */ });   // errado
```

`exigirPermissao` sinaliza negação chamando **`next(erro)`** — e aquele
callback ignorava o argumento e executava a ação assim mesmo. Um COMPRADOR
bloqueava fornecedor e recebia 200.

A bateria pegou. A correção lê a permissão do próprio `req.usuario` dentro do
handler e lança `semPermissao`, sem callback. A lição vale para qualquer rota
cuja permissão dependa do corpo: **middleware de Express não compõe por
callback**.

## Integrações

| Módulo | O que entra |
|---|---|
| **02** | cadastro, produto × fornecedor, MOQ, múltiplo, prazo de pagamento |
| **05** | consulta de performance para o planejamento (lead time, OTIF, alternativas) |
| **06** | cotações enviadas, respondidas e recusadas — base do atendimento |
| **07** | pedidos, preços, condições, alterações e confirmação |
| **08** | OTIF, OTD, In Full e lead time, **pela metodologia do próprio módulo 08** |
| **09** | recebimentos, aprovação, rejeição, quarentena, NC, devoluções, divergências |
| **11** | indicadores consolidados ficam prontos; o módulo 11 não foi implementado |

## API

```
GET  /api/avaliacao/dashboard          GET  /api/avaliacao/ranking
GET  /api/avaliacao/alertas            GET  /api/avaliacao/concentracao
GET  /api/avaliacao/fornecedor-unico   GET  /api/avaliacao/historico-precos
GET  /api/avaliacao/comparativo
GET  /api/avaliacao/parametros         PUT  /api/avaliacao/parametros

GET  /api/metodologias-avaliacao       POST /api/metodologias-avaliacao
GET  /api/metodologias-avaliacao/:id   PUT  /api/metodologias-avaliacao/:id
POST /api/metodologias-avaliacao/:id/versionar
POST /api/metodologias-avaliacao/:id/publicar

GET  /api/avaliacoes-fornecedores      GET  /api/avaliacoes-fornecedores/:id
POST /api/avaliacoes-fornecedores/:id/validar
POST /api/avaliacoes-fornecedores/:id/cancelar

GET  /api/fornecedores/:id/perfil      GET  /api/fornecedores/:id/scorecard
GET  /api/fornecedores/:id/performance GET  /api/fornecedores/:id/indicadores
GET  /api/fornecedores/:id/evolucao
GET  /api/fornecedores/:id/avaliacoes  POST /api/fornecedores/:id/avaliacoes
GET  /api/fornecedores/:id/plano-acao  POST /api/fornecedores/:id/plano-acao
GET  /api/fornecedores/:id/situacoes   POST /api/fornecedores/:id/situacao

GET  /api/planos-acao                  POST /api/planos-acao
GET  /api/planos-acao/:id              PUT  /api/planos-acao/:id
POST /api/planos-acao/:id/acoes        POST /api/plano-acoes/:id/concluir

GET  /api/situacoes-fornecedor
GET  /api/produtos/:id/alternativas
```

## Permissões (§63)

| Permissão | Quem tem |
|---|---|
| `fornecedores.ler` | todos os perfis operacionais e a diretoria |
| `fornecedores.avaliar` | ADMIN, GESTOR_COMPRAS, COMPRADOR |
| `fornecedores.validar` | ADMIN, GESTOR_COMPRAS |
| `fornecedores.metodologia` | ADMIN, GESTOR_COMPRAS |
| `fornecedores.plano_acao` | ADMIN, GESTOR_COMPRAS, COMPRADOR, QUALIDADE |
| `fornecedores.monitorar` | ADMIN, GESTOR_COMPRAS |
| `fornecedores.bloquear` | ADMIN, GESTOR_COMPRAS |

COMPRADOR avalia e conduz plano de ação mas **não mexe na metodologia nem
bloqueia**; QUALIDADE registra plano de ação mas **não cria avaliação**;
DIRETORIA consulta.

## Tela

`/avaliacao-fornecedores` — oito abas: **Painel**, **Ranking**,
**Avaliações**, **Comparativo**, **Planos de ação**, **Riscos**,
**Histórico de preços** e **Metodologia**.

O **scorecard** é a tela central e obedece à seção 27: cabeçalho com período,
metodologia, score, completude e confiabilidade; a tabela
`Critério | Nota | Peso | Contribuição | Situação`; e abaixo os indicadores com
valor, nota, eventos e **fonte**. Critério sem dado aparece como "SEM DADOS"
com o motivo, nunca como zero.

No **ranking**, quem tem completude insuficiente fica no fim e não recebe
posição — um fornecedor com duas entregas e score 100 não lidera sobre outro
com quarenta e score 92.

## Testes

```bash
npm run dev        # em um terminal
npm run test:m10   # em outro
```

**167 verificações**: 62 sobre a matemática pura, 46 sobre os cinco cenários
obrigatórios da seção 66 ponta a ponta pela API, e 59 sobre plano de ação,
riscos, histórico, permissões e fronteiras.

Os cinco cenários da seção 66:

| # | Situação | Resultado verificado |
|---|---|---|
| 1 | histórico completo (pedidos, entregas, recebimentos, qualidade, preços) | score calculado, completude `COMPLETA`/`DADOS_PARCIAIS`, sete critérios com nota/peso/contribuição, fontes dos módulos 08 e 09 |
| 2 | fornecedor novo, sem movimento | `SEM_HISTORICO`, **score nulo**, confiabilidade `INSUFICIENTE`, motivo explícito — e a avaliação é gravada assim mesmo |
| 3 | qualidade alta, OTIF baixo | notas separadas; logística abaixo de qualidade; atraso visível no indicador |
| 4 | preço bom, muita NC | preço e qualidade separados; qualidade abaixo de 60; score menor que o do fornecedor completo — **o preço não esconde o problema** |
| 5 | mudança de pesos | nova versão criada, publicada e vigente; avaliação antiga mantém score e versão originais; publicada não aceita mais alteração |

E as categorias da seção 65: score (pesos válidos, inválidos, cálculo,
arredondamento), indicadores (OTIF, OTD, In Full, qualidade, NC, lead time,
preço), dados insuficientes (sem histórico, poucos pedidos, sem qualidade),
histórico (mudança de metodologia, preservação), plano de ação (criação,
alteração, vencimento, encerramento) e permissões por perfil.

A bateria roda duas vezes seguidas com o mesmo resultado: o cenário 5 devolve a
Metodologia 1.0 à vigência ao terminar, porque deixar a versão de teste vigente
faria a execução seguinte começar de um estado que nenhum usuário criaria.

### Um bug de fixture que valeu a pena

Os produtos de teste têm índice único `uq_pf_principal` — **um fornecedor
principal por produto**. O fixture usava `ON CONFLICT DO NOTHING`, então o
conflito com o principal da execução anterior sumia em silêncio e o fornecedor
novo ficava sem nenhum produto. O `ON CONFLICT` saiu e o principal anterior
passa a ser liberado antes. Fixture que engole erro esconde exatamente o que o
teste deveria mostrar.

## Pendências assumidas

- **Exportação** para Excel, CSV e PDF (§68) — pedida desde o módulo 04,
  deliberadamente adiada para ser feita uma vez só, de forma genérica.
- **Performance por local** (§34): a estrutura aceita o recorte por
  `local_id` e a avaliação o grava, mas a coleta ainda não filtra por local em
  todos os indicadores — só nos de logística e qualidade.
- **Impacto financeiro das condições de pagamento** (§23): o prazo é
  comparado, o custo de capital não é calculado — falta a taxa configurada.
- **Preço médio de mercado** (§21): não há fonte externa configurada; a
  competitividade compara apenas fornecedores internos.
- **Atendimento** usa cotação, confirmação e ocorrência. Tempo de resposta a
  contato e disponibilidade do contato ficam como dado insuficiente, como a
  seção 24 manda — não viram nota inventada.
- **Relatórios executivos** (§45–47) existem como endpoints de dados
  (dashboard, ranking, perfil, comparativo); a montagem em PDF é parte da
  exportação adiada.
- Massa de teste dos módulos 05 a 10 continua no catálogo (prefixos `M05-` a
  `M10-`).
