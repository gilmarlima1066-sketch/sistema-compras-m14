# MÓDULO 13 — Orquestração, automação e operação inteligente

## O que este módulo faz

Liga os módulos 01 a 12 num **fluxo que roda sozinho**: detecta o que aconteceu,
decide o que fazer com isso, executa o que pode e **entrega ao humano o que não
pode**, com dono, prazo e caminho.

Os doze módulos anteriores produzem informação. Este produz **trabalho atribuído**.

## A linha que define o módulo

Um motor de automação é fácil de demonstrar e difícil de confiar. O que precisa
de prova não é o que ele faz — é o que ele **se recusa** a fazer.

Três travas, nessa ordem de importância:

1. **§9 — nenhuma automação emite pedido de compra sem passar pela aprovação.**
   Sete ações são restritas por lista fechada no código: `EMITIR_PEDIDO`,
   `APROVAR_PEDIDO`, `ALTERAR_PRECO`, `ALTERAR_ESTOQUE`, `CANCELAR_PEDIDO`,
   `APROVAR_RECEBIMENTO`, `BLOQUEAR_FORNECEDOR`. Uma regra cadastrada como
   AUTOMÁTICO pedindo qualquer uma delas é **rebaixada para APROVAÇÃO**, e o
   rebaixamento fica registrado na execução. A trava não pode morar num dado
   editável na tela, então não mora.

2. **§22 — reexecutar não duplica.** Garantido por índice `UNIQUE` parcial em
   evento, alerta, tarefa, aprovação, notificação e webhook — não por verificação
   no código, que perde a corrida entre dois workers.

3. **§13 e §32 — a automação não move estoque nem cria pedido.** A bateria conta
   as linhas de `movimentacoes_estoque`, `ordens_compra`, `recebimentos` e `lotes`
   antes e depois de rodar o módulo inteiro. Se qualquer número mudar, o módulo
   falhou — por mais verdes que estejam os outros testes.

## A decisão de arquitetura

**A fila mora no PostgreSQL, não no Redis.**

A razão é prática: *enfileirar a ação e gravar o dado que a originou acontecem na
mesma transação*. Se a compra não for gravada, a tarefa dela não existe. Com uma
fila externa as duas coisas podem divergir — e divergem justamente quando algo dá
errado, que é quando menos se pode ter surpresa.

O consumo usa `SELECT ... FOR UPDATE SKIP LOCKED`: dois workers pegam conjuntos
diferentes sem lock global e sem corrida. O backoff não usa `sleep` — o item que
falhou volta com `disponivel_em` no futuro e o worker simplesmente não o enxerga
até lá, então nenhuma thread fica bloqueada e reiniciar o processo não perde o
atraso.

## Como o fluxo funciona

```
detector → EVENTO → regra → FILA → ação → alerta / tarefa / aprovação → notificação
   ↑                                                      ↓
  job                                            SLA → escalonamento (3 níveis)
```

Dois passos deliberadamente separados:

- **`processarEventos`** casa evento com regra e **enfileira**. Passo rápido, só
  decide.
- **`processarFila`** reserva e **executa**. Passo lento, pode falhar, tem retry.

Separar importa porque falham por motivos diferentes: se uma ação quebra, o evento
continua processado e as outras regras seguem valendo. Uma regra com defeito não
paralisa as dezenove que funcionam.

### Os três níveis (§33)

| Nível | O que acontece | Para quê |
|---|---|---|
| `AUTOMATICO` | o sistema executa | só o que **produz informação**: alertar, notificar, abrir tarefa |
| `ASSISTIDO` | vira tarefa com ação sugerida | o trabalho chega pronto, a decisão continua de quem responde |
| `APROVACAO` | cria solicitação formal por alçada | antes de qualquer coisa acontecer |

## Banco

### Reaproveitado, não recriado (§2)

Auditado antes de escrever qualquer migration:

| Já existia | Como foi usado |
|---|---|
| `notificacoes` (módulo 02) | **evoluída** com canal, tipo, status, dedup e correlação — não substituída |
| `alcadas_aprovacao` (módulo 07) | **a mesma função** `alcadaPara` do módulo 08, exportada. Duas leituras independentes divergiriam no dia em que uma ganhasse um filtro |
| `pedido_aprovacoes` | **intacta.** O pedido de compra continua sendo aprovado onde sempre foi. A tabela `aprovacoes` nova é para exceções e para o nível 3 — não a substitui |
| `alertas` + `alertas_tipos` (módulos 02/11) | `registrarAlerta` reaproveitado inteiro, com a dedup que já existia |
| `auditoria` (módulo 03) | mantida como está |

### Migrations

| # | O que faz |
|---|---|
| `042` | 5 tipos de alerta de infraestrutura |
| `043` | eventos, regras, fila, execuções, tarefas, aprovações, jobs, webhooks, integrações, SLA; 8 permissões, 13 configurações |
| `044` | catálogo: 20 regras, 15 políticas de SLA, 10 jobs, 3 integrações |
| `045` | **correção** — histórico imutável e expurgo (abaixo) |
| `046` | **correção** — execução autocontida (abaixo) |
| `047` | **correção** — idempotência de webhook só vale para o aceito (abaixo) |
| `048` | **correção** — contrato entre regra e detector (abaixo) |

## Quatro defeitos que os testes encontraram

Vale registrar, porque os quatro eram **silenciosos** — o sistema parecia
funcionar.

### 1. O histórico imutável impedia o próprio expurgo (045)

As tabelas append-only tinham gatilho proibindo qualquer `UPDATE`/`DELETE` e, ao
mesmo tempo, FKs `ON DELETE SET NULL`. As duas coisas não coexistem: o SET NULL
**é** um UPDATE. Consequência: nenhum evento, regra ou usuário podia mais ser
apagado, e a retenção configurada (180 dias na automação, 365 na IA) era
impossível de aplicar. Atingia também as tabelas do módulo 12.

A correção mantém a garantia que interessa e abre duas exceções que o **próprio
banco** confere: a referência pode ser *anulada* quando o pai é apagado (trocá-la
por outra continua proibido), e o registro só pode ser apagado depois da retenção
— lida da tabela de configurações, não escondida no código do job.

### 2. O histórico sobrevivia, mas mudo (046)

Com `regra_id` anulado, ninguém mais responderia "qual regra decidiu isso" — que é
exatamente o que a §35 exige. Havia um segundo furo, independente: `versao` sobe a
cada edição da regra, então guardar só o id fazia a auditoria de hoje descrever a
execução de março com o texto atual da regra.

Agora código, versão e tipo de evento são gravados **na própria linha**, no momento
da execução.

### 3. Webhook recusado bloqueava o reenvio corrigido (047)

O parceiro envia com assinatura errada → recusado corretamente, mas a tentativa
ocupava a chave de idempotência. O parceiro corrige e reenvia o mesmo aviso com a
mesma chave → "já recebido", e nada é processado. O aviso legítimo sumia entre dois
sistemas que se diziam de acordo — os dois com razão de achar que deu certo.

O índice passou a ser **parcial**: a chave só é reservada pelo que foi aceito.

### 4. Cinco de oito regras nunca dispararam (048)

Descoberto olhando a tela de regras. `EST_RISCO_RUPTURA` exigia
`dias_ate_ruptura <= 15`; o detector emite `cobertura_dias`. Campo ausente não
atende à condição, então a regra ficava ativa, vigente, visível — e completamente
inerte. É a pior forma de falhar deste módulo: o sistema parece configurado e não
faz nada, e **ninguém procura pelo alerta que nunca chegou**.

Corrigido dos dois lados: os detectores passaram a emitir `valor_parado`,
`necessidades_do_fornecedor`, `dias_sem_confirmacao` e `nivel`; as condições sem
equivalente possível foram renomeadas.

E — mais importante — a falha ganhou **guarda permanente**: a visão
`vw_regras_contrato` cruza as condições das regras com os campos vistos nos
eventos daquele tipo, o Centro de Operações levanta como CRÍTICO qualquer regra
que peça campo que nunca chega, e a bateria verifica que não há nenhuma.

## Os 16 detectores

Nenhum calcula nada por conta própria. Cobertura, ponto de pedido, OTIF, atraso e
validade já foram definidos nos módulos 02 a 12, e as visões
(`vw_produtos_criticos`, `vw_compras_abertas`, `vw_performance_fornecedores`,
`vw_estoque_atual`) são a fonte. Redefinir "cobertura" aqui criaria um segundo
número para a mesma palavra — e um dia os dois divergiriam.

Rodando contra a base real: **967 eventos em 15 tipos**, sem erro de detector.

| Tipo | Quantos | O que significa |
|---|---|---|
| `STOCK_OUT` | 503 | produto com demanda e sem saldo |
| `PO_UNCONFIRMED` | 240 | pedido enviado sem confirmação do fornecedor |
| `RECEIPT_DIVERGENCE` | 64 | recebimento com divergência sem tratamento |
| `QUALITY_NONCONFORMITY` | 48 | não conformidade aberta |
| `PO_LATE` | 29 | pedido com promessa vencida e saldo pendente |
| `SUPPLIER_SINGLE_SOURCE` | 25 | produto com demanda e fornecedor único |
| `PURCHASE_NEED_CREATED` | 14 | necessidade de compra pendente |
| `STOCK_LOW` | 12 | cobertura abaixo do lead time + margem |
| `SUPPLIER_PERFORMANCE_DROP` | 10 | OTIF abaixo do limite, com base mínima |
| `AI_RECOMMENDATION_CREATED` | 7 | recomendação da IA sem decisão |
| `STOCK_EXCESS` | 6 | saldo acima do máximo aceitável |
| `PURCHASE_NEED_CRITICAL` | 3 | necessidade crítica |

Todos podem rodar de hora em hora sem medo: a chave de idempotência inclui o dia,
então o mesmo fato registra uma vez por dia — a ruptura que persiste não gera
enxurrada, mas volta a aparecer amanhã, porque continuar em ruptura amanhã **é**
um fato novo.

### Ausência com motivo

O detector de preço não achou nada e **diz por quê**: *"51 pares avaliados; a maior
alta foi de 14,3% contra um limite de 15%. Nenhum aumento anormal — ausência de
evento aqui é boa notícia."* Sem isso, "zero eventos" ficaria ambíguo entre "está
tudo bem" e "não havia dado para avaliar" — e as duas coisas pedem ações opostas.

## SLA e escalonamento

15 políticas por etapa. A tarefa nasce com prazo, muda para `EM_RISCO` antes de
vencer — o percentual de alerta existe para avisar **enquanto ainda dá tempo** — e,
se vencer, sobe de nível sozinha.

Três níveis porque a realidade tem três: quem faz, quem responde pela área, quem
responde pela empresa. Subir direto para a diretoria queima o mecanismo; nunca
subir o torna inútil.

A varredura devolve o nível **mais alto já alcançado**, não o próximo: uma tarefa
esquecida por uma semana chega de uma vez onde deveria estar, em vez de subir um
nível por varredura.

**O cumprimento se mede sobre tarefas encerradas**, não sobre todas. Uma tarefa
aberta e dentro do prazo não é descumprimento; contá-la faria o indicador piorar a
cada tarefa nova — o oposto da verdade.

## Aprovações

A faixa de valor vem de `alcadaPara`, **a mesma função do módulo 08**. Se as duas
leituras divergissem, o usuário veria a automação exigir uma aprovação que ele
acabou de dar.

| Valor | Alçada | Perfil |
|---|---|---|
| até R$ 10.000 | Comprador | `COMPRADOR` |
| R$ 10.000 – 50.000 | Gestor de compras | `GESTOR_COMPRAS` |
| acima de R$ 50.000 | Diretoria | `DIRETORIA` |

Duas travas além da permissão:

- **Perfil**: quem decide precisa ser da alçada. ADMIN passa por qualquer uma,
  senão uma alçada sem usuário ativo travaria a operação sem saída.
- **Segregação de funções**: quem pediu não aprova o próprio pedido. Vale **também
  para ADMIN** — é o único ponto onde ADMIN não passa, porque aqui o risco não é de
  acesso, é de conflito de interesse.

A exceção (§16) tem motivo obrigatório, garantido pelo CHECK `ck_aprovacao_excecao`
— não só pela validação da aplicação.

## Jobs

10 jobs, agendador no PostgreSQL. A próxima execução é um **dado consultável**, o
histórico fica ao lado do resto da auditoria, e a trava de concorrência usa a mesma
transação que marca o job como executando.

A trava é um `UPDATE` condicional: quem conseguir mudar a linha de OCIOSO para
EXECUTANDO ganha, o outro não recebe linha. Não há janela entre verificar e marcar,
porque é um comando só. A bateria dispara o mesmo job duas vezes em paralelo e
confirma que exatamente um executa.

`liberarOrfaos` cobre o caso feio: o processo morreu no meio e o job ficaria
EXECUTANDO para sempre — falhando em silêncio, que é a pior forma de falhar.

O timeout **não aborta** o job no meio: cortar uma varredura pela metade deixaria
metade dos eventos detectados, o que é pior que demorar. Ele é registrado para o
Centro de Operações mostrar quem está lento.

## Webhooks

Quatro travas, nesta ordem: integração ativa → assinatura HMAC → carimbo de tempo
dentro da tolerância → idempotência.

O **segredo nunca é guardado em texto puro** (§36): a tabela tem `segredo_hash`, a
comparação é em tempo constante, e a assinatura registrada é truncada em 16
caracteres. Cabeçalhos sensíveis (`Authorization`, `Cookie`, `X-Api-Key`) são
mascarados antes de gravar — a tabela de recebidos é um log, e a regra de não
registrar tokens em log vale para ela.

O carimbo de tempo existe contra **replay**: sem ele, uma requisição válida
capturada hoje seria aceita em dezembro, e a assinatura estaria correta, porque é a
mesma.

Tudo que chega fica registrado, **inclusive o recusado** — é o que permite
investigar "o fornecedor jura que enviou".

O payload nunca vira ação direta: vira **evento**, e o motor de regras decide. Um
sistema externo não emite pedido nem mexe em estoque por aqui.

## Centro de Operações

A tela responde uma pergunta só: *a automação está funcionando?*

Responder isso é mais difícil do que parece, porque **automação quebra em
silêncio**. O alerta que não chegou não aparece na tela; o job que parou de rodar
não gera linha nenhuma. Por isso o diagnóstico procura **ausências**, não só erros:

- job atrasado além da própria frequência (comparado com a frequência dele, para
  não acusar o job mensal no dia 2);
- fila parada — o sinal não é o tamanho, é a **idade**: mil itens processados em um
  minuto estão bem, dez parados há duas horas indicam worker fora do ar;
- nenhum evento novo há mais de 26 horas — os detectores rodam de hora em hora;
  silêncio assim longo indica motor parado, não operação sem problemas;
- **perfil sem usuário ativo**: a regra aponta para um destino que não existe, e a
  tarefa nasce sem chegar a ninguém;
- regra pedindo campo que o detector não emite (§ acima);
- integração ativa sem segredo: todo webhook dela será recusado.

Cada sintoma vem com a **ação** correspondente. Um diagnóstico que diz "fila com
4.000 itens" e deixa o operador decidir não terminou o trabalho. A bateria verifica
que todo sintoma tem ação.

### O que o painel se recusa a dizer

Sucesso em zero execuções é `null`, não 100%. Cem por cento de sucesso em zero
tentativas seria o painel dando **luz verde para um motor parado**.

## Telas

**Tarefas e aprovações** — o que o comprador abre de manhã.

"Minhas tarefas" vem primeiro, não a lista geral: uma fila de 548 tarefas de todo
mundo não ajuda ninguém a começar o dia. A tela mostra **as 10 mais urgentes** em
cartões, com o total e o caminho para a fila completa em tabela — que é a forma
certa de olhar volume. Despejar tudo em cartões não informa mais, só empurra o
resto para fora da tela.

O SLA aparece como **tempo restante** ("vence em 2h"), não como data de vencimento:
a data obriga a fazer a conta de cabeça, e a conta é refeita a cada linha da lista.

**Centro de operações** — sete abas: saúde, jobs, fila, eventos, regras,
integrações e parâmetros. O rastreio por `correlation_id` reconstrói a linha do
tempo de uma decisão: evento, execuções (com a regra e a versão que rodou),
tarefas, aprovações e notificações.

A simulação de regra é um **ensaio**: mostra condição por condição, com o valor que
veio no payload, e **não executa a ação** — a bateria verifica que simular não cria
alerta.

## Testes

**142 verificações, 142 passando.** Regressão completa: **1.624 verificações nos
dez módulos**, todas verdes.

| Seção | Verificações |
|---|---|
| Unitários: backoff, níveis, condições, SLA | 29 |
| Motor: evento → regra → fila → ação | 18 |
| Regras: criação, versão, ensaio | 7 |
| Aprovações: alçada, exceção, quem decide | 15 |
| Tarefas e SLA em três níveis | 11 |
| Detectores | 7 |
| Jobs: agenda, trava, recuperação | 11 |
| Webhook: assinatura, replay, idempotência | 14 |
| Permissões e escopo | 6 |
| Operação: painel, diagnóstico, efeito | 15 |
| **Efeitos colaterais: as negativas** | 5 |
| Auditoria: o histórico não se reescreve | 4 |

## Limitações registradas

- **Horas de SLA são de calendário, não úteis.** Um vencimento de sexta às 18h
  conta o fim de semana. É escolha consciente — distribuidora de produtos naturais
  opera com validade e ruptura, onde o sábado também conta — mas fica registrado
  para quem for evoluir.
- **Nenhum provedor de e-mail ou WhatsApp configurado.** Notificações de canal
  externo nascem `PENDENTE` e o despachante registra a tentativa e o motivo, em vez
  de marcar `FALHOU` (sugeriria erro de entrega) ou `ENVIADA` (seria falso). Quem
  plugar o provedor troca somente o corpo de `despachar`.
- **`AI_RISK_DETECTED` não tem detector.** A regra `IA_RISCO` existe e está
  correta, mas nenhum detector produz esse evento ainda. O diagnóstico marca como
  OK, distinguindo "contrato quebrado" de "evento ainda não produzido".
- **503 rupturas é sintoma de dado, não de motor.** 1.432 dos 2.283 produtos com
  demanda não têm fornecedor vinculado — o mesmo achado que a IA do módulo 12 já
  reportava como recomendação número um. Enquanto isso não for resolvido, o
  detector de ruptura continuará com volume alto, e o teto de 500 eventos por
  varredura existe justamente para isso não inundar a fila.
- **Notificação por perfil multiplica por usuário.** Uma tarefa de perfil com 15
  usuários ativos gera 15 notificações. Correto (qualquer um pode assumir) e
  barulhento na base de testes, que tem muitos usuários fictícios; em operação real
  são 1 a 3 por perfil.
- **Exportação para Excel/CSV/PDF continua pendente** — pedida desde o módulo 04.

## Como rodar

```bash
bash /home/claude/testar.sh m13          # bateria do módulo
bash /home/claude/regressao.sh m04 ... m13   # regressão completa
```

Pela API, um ciclo inteiro manualmente:

```
POST /api/automacao/detectores/rodar   { "grupo": "todos" }
POST /api/automacao/ciclo
GET  /api/automacao/operacao/diagnostico
```
