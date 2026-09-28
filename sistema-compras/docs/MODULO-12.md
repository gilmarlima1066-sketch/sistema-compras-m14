# MÓDULO 12 — Inteligência artificial para compras, estoque e decisão

## O que este módulo faz

Transforma os dados dos módulos 01 a 11 em **análise, previsão de risco,
recomendação explicada e resposta a pergunta em português** — sem substituir
nenhuma regra transacional.

A IA analisa, interpreta, detecta, prevê, recomenda, explica, alerta e simula.
**Não emite pedido, não aprova fornecedor, não altera preço, não mexe em
estoque** (§48). A bateria verifica isso comparando as contagens operacionais
antes e depois de rodar o módulo inteiro.

## A decisão que define o módulo

**Não há LLM.** O ambiente não alcança nenhuma API externa, e mandar os dados
de compras da empresa para fora seria uma decisão do dono do sistema, não do
sistema.

O "agente" é um **motor de inferência determinístico sobre os próprios dados**:
estatística, regras e limiares configuráveis, rodando dentro do banco. Isso
atende o PROMPT 12 inteiro e é melhor para o domínio:

- o §46 proíbe recomendação em caixa-preta. Um motor determinístico **sempre**
  mostra a conta, porque a conta é o que ele é;
- toda resposta é reproduzível: a mesma pergunta, nos mesmos dados, dá a mesma
  resposta — e uma recomendação de compra de R$ 200 mil precisa ser auditável
  seis meses depois;
- nada sai do banco.

A camada de linguagem natural é isolada do motor de análise, então plugar um
LLM depois — para redigir a resposta, não para decidir o número — é uma
troca localizada.

## Banco

### Reaproveitado, em vez de recriado (§41)

A §41 lista oito estruturas possíveis e manda criar "somente se não houver
equivalente". Auditado o banco, **cinco já tinham**:

| A §41 sugeria | O que já existia | Por que serve |
|---|---|---|
| `AI_ALERTAS` | `alertas` (módulo 02, evoluída no 11) | Já tem categoria, prioridade, origem, evidências, responsável, status — e **deduplicação por chave**, que é exatamente o que a §19 pede |
| `AI_SIMULACOES` | `simulacoes_compra` (módulo 05) | Guarda ajustes, horizonte e resultado, e roda o **mesmo SQL do planejamento oficial** sem tocar nele |
| `AI_CONFIGURACOES` | `configuracoes`, grupo `ia` | O versionamento que a §37 pede já existe: trigger de auditoria grava autor, data, valor anterior e novo |
| Detecção de venda anormal | `vendas_outliers` (módulo 04) | Já tem média, desvio, z-score e tratativa |
| Confiança (§26) | `confiabilidade_previsao_enum` | Já tem exatamente ALTA / MÉDIA / BAIXA / INSUFICIENTE |

### Novo (migrations 040 e 041)

| Objeto | Para quê |
|---|---|
| `ia_conversas`, `ia_mensagens` | Memória operacional: pergunta, resposta e **o que foi consultado** (§35) |
| `ia_recomendacoes` | Recomendação com evidências, cálculo e premissas congelados (§20, §21) |
| `ia_feedback` | Decisão do usuário, **append-only** (§36) |
| `ia_execucoes` | Toda consulta executada **ou bloqueada**, append-only (§23) |
| `natureza_ia_enum` | A regra de ouro do §47 como tipo do banco |
| 9 tipos de alerta + `alertas_tipos` | Os alertas da IA entram na central única do módulo 11 |

### A central de riscos não virou tabela

A §17 pede uma Central de Riscos com status e responsável. Ela **não foi
persistida**: risco é uma condição avaliada continuamente sobre o dado de
agora, e gravar a avaliação criaria uma terceira lista de coisas-para-tratar
que envelhece sozinha.

O risco é calculado ao vivo, com os fatores à vista (§18), e **quando cruza o
limiar vira um alerta** na central única — que é onde a tratativa já mora.

## Segurança do Text-to-SQL (§23)

Três camadas independentes. Cada uma sozinha já barraria a escrita, e nenhuma
confia na anterior.

### 1. Validação na aplicação

Apenas `SELECT` e `WITH`, uma instrução, sem comentários, com `LIMIT`
obrigatório, **lista de permissão** de 100 tabelas e 60 comandos bloqueados.

A análise roda sobre o *esqueleto* da consulta — literais e identificadores
citados são removidos antes. Sem isso, `descricao ILIKE '%update%'` seria
barrada por conter "update", e pior: daria para esconder comando dentro de
string.

Fora da lista de permissão, de propósito: `usuarios` (guarda hash de senha),
`auditoria` e `ia_execucoes` (o próprio log de segurança).

### 2. Transação READ ONLY

`BEGIN TRANSACTION READ ONLY` faz o **servidor** recusar qualquer escrita. Não
é filtro de texto: é o motor recusando, com erro 25006.

Há um **autoteste** em `/api/ia/seguranca` que tenta uma escrita real dentro da
transação e mostra o código do erro. "A transação é somente leitura" é uma
afirmação que merece ser verificada, não apenas declarada numa tela.

### 3. Papel de banco somente leitura

`db/roles/001_papel_leitura_ia.sql` cria `compras_ia`: `SELECT` apenas,
`default_transaction_read_only = on`, `statement_timeout` de 10s, sem acesso a
`usuarios` nem a `ia_execucoes`, sem `CREATE` no schema.

**Não é migration, de propósito.** Criar papel exige superusuário, e um sistema
que cria o próprio usuário de banco também consegue conceder a si mesmo o que
quiser — a separação de privilégio deixa de existir no instante em que é
criada. É trabalho de DBA, rodado uma vez.

Sem `DATABASE_URL_LEITURA` o sistema **não fica inseguro**: as outras duas
camadas seguem valendo, e a tela de governança informa que roda com uma camada
a menos em vez de deixar a dúvida no ar.

### Uma quarta barreira, por acidente

O envelope `SELECT * FROM (consulta)` existe para aplicar o limite de linhas.
O efeito colateral é que qualquer instrução que não produza linhas vira erro de
sintaxe antes de chegar ao executor.

### O caminho normal não passa por texto livre

`/api/ia/query` aceita SQL digitado e exige `ia.sql`, que só ADMIN e
GESTOR_COMPRAS têm. O **Pergunte aos Dados** não passa por ali: a pergunta
escolhe uma consulta de um **catálogo de 16 consultas parametrizadas** e
preenche os parâmetros, que trafegam como `$1`, `$2`.

Isso também responde à "proteção contra prompt injection" da §39 de um jeito
que filtro de texto não alcança: **não existe prompt a injetar**. A frase mais
hostil possível, no pior caso, seleciona a consulta errada do catálogo e
devolve uma lista de produtos.

## A regra de ouro como tipo (§47)

Toda afirmação carrega a sua natureza, e a interface as separa visualmente:

| Natureza | O que é |
|---|---|
| FATO | Está no banco |
| CÁLCULO | Aritmética sobre o que está no banco |
| PREVISÃO | Estimativa a partir de histórico |
| HIPÓTESE | Explicação possível, não confirmada |
| RECOMENDAÇÃO | Sugestão derivada dos dados |
| SIMULAÇÃO | Cenário hipotético |

Isso não é decoração. "O estoque é 850 kg" (FATO) e "o estoque acaba em 6 dias"
(PREVISÃO) apresentados do mesmo jeito fazem a segunda herdar a autoridade da
primeira — e é assim que um sistema de apoio passa a induzir decisão errada com
ar de certeza.

As causas de anomalia são sempre HIPÓTESE: o banco registra **que** o preço
subiu, não **por quê** (§8).

## O que o módulo se recusa a fazer

### Sem base, não recomenda (§26 e §27)

A porta de qualidade roda **antes** de qualquer recomendação. Produto com
lacuna que bloqueia — sem demanda, sem fornecedor, saldo negativo — não gera
recomendação de compra: gera **limitação declarada**.

A confiança vem de fatores objetivos: volume de observações, estabilidade da
série, erro histórico do modelo, atualidade do dado e completude do cadastro.
Sem o mínimo de observações o resultado é **INSUFICIENTE**, não "baixa
confiança" — não existe confiança baixa para quem não tem dado; existe ausência
de base, e chamar isso de baixa confiança sugeriria que há alguma.

### Zero achados vem com o motivo

`achados: []` sozinho é ambíguo: pode significar "nada fora do padrão" ou "não
havia base para comparar". A primeira é boa notícia; a segunda é uma lacuna de
dados disfarçada de boa notícia. Toda varredura devolve quantos candidatos
tinham base e quantos não tinham, com o motivo.

### Lacuna de cadastro vem agregada

Com 1.432 produtos sem fornecedor, uma recomendação por produto geraria 1.432
linhas idênticas e a central de compras abriria com elas — enterrando as
compras que precisam sair hoje sob uma tarefa de cadastro que é **uma só**. A
IA emite uma recomendação por lacuna, com a contagem e os maiores impactos.

### A lista diz o seu próprio tamanho

Quando o recorte trunca, a resposta informa: *"Lista limitada aos 300 de maior
impacto; o total é 1.456"*. Sem isso, o número do teto vira a resposta e fica
colado ali para sempre, dando impressão de problema estável.

### Nada de indicador recalculado

OTIF, giro, cobertura e qualquer indicador vêm do motor de KPI do **módulo
11**; a previsão, do **módulo 04**; a necessidade de compra, do **módulo 05**; o
custo de aquisição, do **módulo 06**. A bateria verifica que o
`PRODUTOS_RUPTURA` mostrado pela IA é idêntico ao do painel — se divergissem, o
sistema passaria a ter duas verdades sobre o mesmo número.

## Bugs reais encontrados durante o módulo

### 1. Um dia de diferença entre o banco e a aplicação

O PostgreSQL deste ambiente roda em UTC; a aplicação, em `America/Sao_Paulo`.
**Entre 21h e a meia-noite em São Paulo o banco já está no dia seguinte.**

Uma meta gravada com `vigencia_inicio = CURRENT_DATE` (dia 28, no banco) era
procurada com a data local (dia 27) e não era encontrada — e o indicador caía
na meta anterior. O bug só aparecia em **três das vinte e quatro horas**, que é
o tipo de defeito que sobrevive a muitos testes.

Corrigido alinhando o fuso da **sessão** do banco ao da aplicação, o que resolve
a classe inteira e não só o sintoma.

### 2. Desempate arbitrário entre metas do mesmo dia

Duas metas do mesmo escopo podem começar no mesmo dia — corrigir uma meta no dia
em que foi criada é corriqueiro. Sem desempate por `id`, qual delas valia ficava
a critério do plano de execução do banco, e o mesmo indicador podia mostrar
metas diferentes em duas consultas seguidas.

### 3. O recorte de análise escondia produtos críticos

Dois casos, a mesma raiz — ordenar por valor sem olhar a gravidade:

- a análise de preço pegava os 400 produtos de maior custo e deixava de fora
  justamente os que **tinham histórico de preço** (só 6 na base) — ter
  histórico não tem relação com ser caro;
- a central de riscos ordenava pela matriz qualitativa, então dezenas de itens
  de R$ 2 mil/dia empurravam para fora um de R$ 200 mil/dia que tinha um fator
  de probabilidade a menos.

Hoje o foco ordena por **gravidade da situação primeiro** (já falta, vai faltar,
resto) e a central de riscos ordena por **impacto financeiro real**, com a
matriz como desempate.

### 4. A guarda de SQL barrava a própria consulta

`END` estava na lista de comandos proibidos por encerrar transação. Em SQL
analítico ele é muito mais comum fechando um `CASE` — e derrubou as consultas do
catálogo no primeiro teste. Removido: três outras regras já impedem controle de
transação.

## Preparação da base

A rotina de recálculo de parâmetros do módulo 05 **nunca tinha sido executada
para a base inteira**: 27 produtos de 2.283 tinham demanda apurada. Executada
sobre 365 dias de vendas reais, 1.457 produtos passaram a ter demanda — e só aí
a IA teve o que analisar.

O que a IA aponta como problema número um da base é verdadeiro e útil: **1.432
produtos têm demanda ativa e nenhum fornecedor vinculado**. Sem isso ela não
recomenda compra, porque não há a quem comprar.

## Configurações (grupo `ia`)

17 parâmetros, todos com descrição e alteração auditada: confiança mínima para
recomendar, mínimo de eventos e de dias de histórico, z-score de anomalia,
variação de preço anormal, horizonte de ruptura, dias de validade em risco,
concentração crítica, MAPE máximo, economia mínima, limite de linhas, timeout,
retenção, os três pesos da priorização e a expiração de recomendação.

## API (§40)

```
GET  /api/ia/central-decisao          GET  /api/ia/assistentes
GET  /api/ia/resumo-diario            GET  /api/ia/assistentes/{nome}
POST /api/ia/analyze                  GET  /api/ia/risks
GET  /api/ia/qualidade-dados          GET  /api/ia/lacunas
GET  /api/ia/recommendations          GET  /api/ia/recommendations/resumo
POST /api/ia/recommendations/gerar    GET  /api/ia/recommendations/{id}
POST /api/ia/recommendations/{id}/feedback
POST /api/ia/recommendations/expirar
POST /api/ia/chat                     GET  /api/ia/exemplos
POST /api/ia/query                    GET  /api/ia/catalogo
POST /api/ia/simulate                 GET  /api/ia/cenarios
POST /api/ia/simulate/comparar        GET  /api/ia/simulate/historico
GET  /api/ia/seguranca                GET  /api/ia/history
GET  /api/ia/config                   PUT  /api/ia/config
```

## Permissões (§38)

| Permissão | Dá acesso a |
|---|---|
| `ia.ler` | Análises, recomendações, riscos, assistentes |
| `ia.perguntar` | Pergunte aos Dados |
| `ia.sql` | Consulta SQL própria sob a guarda |
| `ia.simular` | Simulações de cenário |
| `ia.decidir` | Aceitar, rejeitar ou executar recomendação |
| `ia.executivo` | Central de Decisão e resumo estratégico |
| `ia.configurar` | Parâmetros e limiares |

Duas checagens diferentes convivem:

- **Permissão** decide se a rota abre — middleware.
- **Escopo de dados** decide o que a resposta contém — dentro do serviço, pelo
  perfil. Duas pessoas com `ia.ler` veem coisas diferentes, e nenhum filtro
  depende do frontend.

Quando o perfil não alcança um domínio, a resposta diz **qual domínio faltou**,
não o que havia lá dentro. Um "não posso mostrar os 3 fornecedores bloqueados"
já teria revelado que são três.

A Central de Decisão exige `ia.executivo` além de `ia.ler`. A checagem é feita
dentro do handler, não encadeando `exigirPermissao` como callback — aquele
middleware sinaliza negativa por `next(erro)`, então o handler seguinte rodaria
mesmo depois da negativa. Foi assim que um furo apareceu no módulo 10.

## Telas

`/assistente-ia`, com seis abas:

- **Central de Decisão** — as dez perguntas da §30, o resumo em três faixas da
  §44 e os indicadores do módulo 11 com a fonte declarada;
- **Recomendações** — lista priorizada; abrir mostra as seis perguntas da §21,
  as evidências etiquetadas por natureza, a conta congelada e as premissas;
- **Riscos** — nível, probabilidade, impacto e **os fatores observados com o
  peso de cada um**;
- **Pergunte aos Dados** — pergunta livre, exemplos clicáveis, resposta com
  tabela, fonte e as camadas de segurança aplicadas;
- **Simulações** — oito cenários nomeados, efeito de cada fator e comparação;
- **Governança** — autoteste de segurança com o código do erro, qualidade dos
  dados, parâmetros e histórico de execuções.

## Testes

`npm run test:m12` — **165 verificações**, idempotente, cobrindo as onze
categorias da §52 e os 15 casos obrigatórios da §51.

| Bateria | Verificações | Cobre |
|---|---|---|
| Cálculos | 33 | anomalia, projeção de ruptura, risco, preço, prioridade, financeiro, concentração, economia |
| Confiança e evidências | 8 | §26 e a regra de ouro do §47 |
| Segurança do SQL | 10 | **20 ataques bloqueados**, 6 consultas legítimas permitidas, autoteste do banco |
| Qualidade dos dados | 5 | §27 |
| Análises | 14 | casos 01, 05, 08; anomalias com causa como hipótese |
| Recomendações | 29 | casos 01, 02, 08, 10; explicação, priorização, deduplicação, feedback |
| Pergunte aos Dados | 12 | caso 14 — as 12 perguntas da §22 e 4 tentativas de injeção |
| Simulações | 12 | caso 12 e os cenários da §29 |
| Central de Decisão | 11 | §30, §44 e consistência com o módulo 11 |
| Permissões | 11 | caso 05 — isolamento por perfil |
| Performance | 6 | §42 |
| Isolamento operacional | 8 | §48 — nada criado pela IA |
| Governança | 6 | §37 |

Regressão completa após o módulo: **1.531 verificações**, todas passando
(smoke 49, m04 144, m05 126, m06 164, m07 181, m08 261, m09 137, m10 167,
m11 137, m12 165).

## Pendências assumidas

- **Exportação para Excel/CSV/PDF** — pedida desde o módulo 04, adiada de
  propósito como um trabalho genérico único.
- **Processamento automático (§43)** — as rotinas diária, semanal e mensal
  dependem do agendador, que é o módulo 13. Os endpoints que elas chamariam já
  existem e são idempotentes.
- **Assistente de negociação (§12)** — o motor de preço e concentração está
  pronto; falta a tela que monta a pauta de negociação por fornecedor.
- **Transferência entre locais (§6)** — a IA identifica excesso e falta, mas não
  cruza os dois por local para sugerir transferência.
- **Inteligência de importação (§34)** — o simulador já separa preço de câmbio;
  falta ler Incoterm, prazo de desembaraço e trânsito internacional.
- **1.432 produtos sem fornecedor vinculado** — a maior limitação prática. A IA
  aponta isso como recomendação de prioridade ALTA, com R$ 243 mil/dia de
  demanda afetada.
- **MAPE de até 26.910%** em algumas previsões do módulo 04 — o MAPE explode
  quando o realizado é próximo de zero. A IA reporta o número como está; corrigir
  a métrica é trabalho do módulo 04.
- **Dados de teste** com prefixos `M05-` a `M12-` continuam no catálogo.
