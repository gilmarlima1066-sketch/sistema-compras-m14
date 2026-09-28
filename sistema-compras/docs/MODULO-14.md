# MÓDULO 14 — Integrações e conectividade

## O que este módulo faz

Liga o sistema ao mundo: **ERP, Excel, CSV, e-mail, APIs, fornecedores,
transportadoras, sistemas fiscais e bancos externos**. Tudo que entra é validado,
normalizado, mapeado e vira **evento** — nunca escrita direta em estoque ou pedido.

E fecha uma dívida antiga: **exportação para Excel, CSV, PDF e JSON**, pedida
desde o módulo 04.

## Procedência deste módulo

O backend deste módulo — migrations 049 a 052 e 15 arquivos de serviço — foi
escrito por outra sessão, entre 07:35 e 08:46 de 28/09, e **nunca tinha sido
executado**: as rotas não estavam montadas, não havia bateria, nem telas, nem
documentação.

Esta entrega tratou esse código como código de terceiro: revisão contra o
PROMPT 14 e contra o schema real, montagem das rotas, bateria de testes e telas.
**Onze defeitos foram encontrados e corrigidos** — todos só apareceram ao rodar.

## A decisão que define o módulo

**A camada de transporte é a única coisa que este ambiente não consegue provar.**

Este container não alcança a internet. Então a honestidade exige separar duas
coisas que costumam ser confundidas:

| O que foi testado de verdade | Como |
|---|---|
| Leitura de XLSX e CSV | Contra o arquivo real do ERP do cliente: **426.461 linhas, 43 MB, 6,9 s** |
| Normalização, mapeamento, validação | Dados reais, com data serial do Excel, CNPJ e EAN com dígito verificador |
| Idempotência em três camadas | Reimportando o mesmo arquivo e o mesmo conteúdo |
| Conector HTTP: timeout, 401, 500, retry, backoff | **Servidor HTTP real**, subido pela própria bateria em `127.0.0.1` |
| Conciliação, exportação, permissões, auditoria | Banco real |
| **Não** testado | Falar com um ERP, IMAP ou banco externo de verdade — não há rede |

Um mock de conector testaria o mock. Um servidor local de verdade testa o
conector: socket, timeout de sistema operacional, código de status, retry.

## Arquitetura

```
SISTEMA EXTERNO → CONECTOR → AUTENTICAÇÃO → RECEBIMENTO → VALIDAÇÃO
   → NORMALIZAÇÃO → MAPEAMENTO → PROCESSAMENTO → BANCO → EVENTO → AUTOMAÇÃO
```

O elo com o módulo 13 é o **evento**. Nenhum conector chama estoque, compras ou
recebimento direto: registra o fato, e as regras do módulo 13 decidem. É o que
garante que um ERP mal configurado não consiga mexer no saldo.

### Reaproveitado, não recriado (§2)

| Já existia | Como foi usado |
|---|---|
| `integracoes` (módulo 13) | **Evoluída** com sistema, conector, modo, limites e agenda — não substituída |
| `webhooks_recebidos` (módulo 13) | Intacta. A porta de entrada de webhook continua a mesma |
| `eventos` + motor de regras (módulo 13) | Todo dado que entra vira evento e passa por lá |
| `automacao_fila` (módulo 13) | O padrão de retry/backoff/dead-letter foi **reaproveitado**, não reescrito |
| `alertas`, `auditoria`, `configuracoes` | Usados como estão |
| Agendador de jobs (módulo 13) | Ganhou `registrarRotina` para o módulo 14 registrar os seus — o agendador continua sem saber o que é uma integração |

## Onze defeitos encontrados

Todos silenciosos. Nenhum apareceria sem executar.

### 1. Leitura arbitrária de arquivos do servidor — **falha de segurança**

A rota de importação aceitava qualquer caminho de disco. Com `integracao.importar`,
`caminho: "/etc/passwd"` devolvia o conteúdo na pré-visualização **e o gravava em
`importacoes.amostra`**. O mesmo valeria para o `.env` com a senha do banco e a
chave do JWT. Confirmado por exploração, não por leitura de código.

O comentário do próprio schema dizia que havia restrição de diretório. Não havia.

Corrigido: lista de raízes permitidas, `realpath` antes de comparar (texto puro
não barra link simbólico), e validação **na porta de entrada** — as etapas
seguintes releem o caminho já validado, então são seguras por construção.

### 2. Coluna `sigla` que não existe

`gravarProdutos` buscava `unidades.sigla`; a coluna é `codigo`. Derrubava toda
importação de produto na primeira linha.

### 3. `ON CONFLICT (codigo)` sem índice correspondente

O índice de produtos é `(upper(codigo)) WHERE deleted_at IS NULL` — por expressão
e parcial. O Postgres recusa a instrução inteira.

### 4. `'SELECT'` não existe no enum de auditoria

Toda exportação sensível falhava **depois** de gravar a linha em `exportacoes` —
o pior dos dois mundos: o registro do que saiu existia, e a auditoria não.

Corrigido com a ação `EXPORTACAO` (migration 053). Usar `INSERT` seria verdade
no sentido estreito e mentira no que importa: quem audita procura "que dado saiu
da empresa", não "que linha foi inserida".

### 5. Parâmetro `$3` com dois tipos incompatíveis

`POST /integracoes` falhava em **100% das chamadas**, na análise da instrução.

### 6. `cotacao_itens.quantidade` não existe

É `quantidade_solicitada`. Quebrava a solicitação de cotação por e-mail.

### 7. Três dos quatro templates de mapeamento estavam vazios

`PRODUTOS_PADRAO`, `FORNECEDORES_PADRAO` e `PRECOS_FORNECEDOR` apareciam na
lista, podiam ser selecionados, e tinham **zero campos**. A importação processava
o arquivo inteiro e gravava nada — pior que um erro, porque não manda conferir
coisa alguma.

Corrigido na migration 054, com os nomes de campo que os gravadores realmente
leem. E ganhou guarda permanente: `vw_templates_saude` expõe
`sem_mapeamento`, e a bateria verifica que nenhum template ativo está vazio.

### 8. Um `Map` devolvido pela API virava `{}`

`JSON.stringify` serializa `Map` como objeto vazio. A tela que mostra "coluna X
virou campo Y" exibiria nada, sem erro para explicar.

### 9. Formato decidido pelo nome do arquivo

XLSX enviado como `.csv` era lido como texto e gravava lixo binário — que ainda
derrubava a inserção com "unsupported Unicode escape sequence", porque `jsonb`
não aceita `\u0000`. Agora **os quatro primeiros bytes decidem**: todo XLSX é um
ZIP, e todo ZIP começa com `PK\x03\x04`.

### 10. Histórico imutável impedia apagar integração ou usuário

A mesma contradição que a migration 045 corrigiu no módulo 13, repetida aqui:
gatilho de imutabilidade + FK `ON DELETE SET NULL`. Nenhuma integração podia ser
apagada depois de ter uma execução; nenhum usuário, depois de disparar uma
sincronização. Corrigido na 056, com a mesma regra: a referência pode ser
**anulada**, trocá-la por outra continua proibido, e `integracao_codigo` em texto
mantém o histórico legível.

### 11. Quatro jobs cadastrados sem rotina

A migration 051 cadastrou `INTEGRACAO_SINCRONIZAR`, `INTEGRACAO_PROCESSAR`,
`INTEGRACAO_SAUDE` e `INTEGRACAO_CONCILIAR` no agendador — sem implementação.
Ficavam na agenda, com próxima execução calculada, sem fazer nada.

Quem apontou foi a **bateria do módulo 13**, com a verificação "todo job
cadastrado tem rotina implementada". Sem ela, quatro jobs mudos passariam por
jobs saudáveis na tela.

### Bônus: uma lista de configuração que não podia ser esvaziada

O schema exigia `min(1)`, então uma lista preenchida pela API nunca mais podia
voltar a ficar vazia — prendendo o sistema na configuração mais permissiva.

## A tensão entre segurança e o caso de uso real

A validação de endpoint recusava **toda** rede privada: `localhost`, `10.x`,
`192.168.x`, `172.16-31.x`, `.local`, `.internal`. Para um sistema público é a
regra certa — endpoint interno só serve a quem quer pivotar para dentro (SSRF).

Só que **o ERP de uma distribuidora fica na rede da empresa**. Com a regra rígida,
a §8 inteira — "integração com ERP", o motivo de existir do módulo — ficava
impossível de configurar: não havia endereço válido para apontar.

A saída não foi afrouxar, foi tornar a exceção **explícita e nomeada**:
`integracao.hosts_internos_permitidos`, vazia por padrão. O operador escreve os
hosts que ele mesmo administra, um a um. Quem ataca não escolhe o endereço; quem
administra escolhe uma vez, por escrito, em configuração auditável.

## Idempotência em três camadas (§14, §28)

1. **Hash do arquivo** — reenviar o mesmo arquivo é reconhecido antes de ler uma
   linha.
2. **Chave natural por registro** — garantida por índice `UNIQUE`, não por um
   "if já existe" no código: dois processos leriam ao mesmo tempo.
3. **Hash do conteúdo** — chave conhecida com conteúdo igual é descartada; com
   conteúdo diferente, atualiza. É o que separa "já importei" de "mudou na origem".

Provado contra o arquivo real: 426.461 linhas → **22.809 vendas atualizadas,
0 criadas, 601 descartadas** com motivo registrado (`devolução descartada por
configuração`). Nada duplicado.

## Credenciais (§25, §37)

O banco **não guarda o segredo**. Guarda onde ele está: `env:ERP_API_KEY`,
`file:/run/secrets/erp`. Criptografar no banco apenas mudaria o nome do problema —
a chave de decifração ficaria ao lado.

Quem levar o banco inteiro leva a lista de integrações e o **endereço** dos
segredos; não leva um único token.

Consequência aceita conscientemente: a aplicação precisa ser reiniciada quando um
segredo muda. É o preço de não ter o segredo no banco, e é barato perto do risco.

Além disso: `Authorization`, `Cookie` e `X-Api-Key` são removidos antes de
qualquer log, e token em query string é mascarado. A bateria verifica os dois.

## Importador universal (§11 a §13)

```
ARQUIVO → formato pelo conteúdo → colunas → mapeamento → validação
        → PRÉ-VISUALIZAÇÃO → [confirmação humana] → processamento → relatório
```

A confirmação não é formalidade. Um arquivo de 426 mil linhas com o mapeamento
errado escreve 426 mil registros errados, e desfazer custa mais que qualquer
coisa que o importador economize. O CHECK `ck_importacao_confirmacao` garante isso
no banco, não só na tela.

A validação separa **ERRO** (barra a linha) de **ALERTA** (grava com ressalva).
EAN com dígito verificador errado em campo opcional é alerta; código obrigatório
ausente é erro.

O leitor de XLSX é escrito à mão — sem dependência, streaming, lê o ZIP e o XML
da planilha direto. 43 MB em 6,9 s sem carregar o arquivo na memória.

## Exportação (§40) — a pendência dos módulos 04 a 12

Oito conjuntos, quatro formatos (XLSX, CSV, JSON, PDF), gerados sem dependência
externa.

| Conjunto | Sensível |
|---|---|
| Posição de estoque, Cadastro de produtos, Necessidades de compra, Tarefas, Divergências | não |
| **Cadastro de fornecedores, Preços por fornecedor, Pedidos de compra** | sim |

Sensível exige a permissão **do próprio dado**, não apenas `integracao.exportar`
— e fica em auditoria com quem, quando e quantas linhas. A bateria verifica que
um perfil com permissão de exportar e sem permissão de fornecedores recebe 403.

## Testes

**104 verificações, 104 passando.** Regressão completa: **1.626 verificações nos
onze módulos**, todas verdes.

| Seção | Verificações |
|---|---|
| Normalização, classificação de erro, higienização | 22 |
| Leitor: 43 MB de planilha real | 6 |
| Importador ponta a ponta | 17 |
| **Segurança do caminho de arquivo** | 5 |
| Conector contra servidor HTTP real | 10 |
| Integração, credencial, ambiente | 8 |
| Conciliação | 4 |
| Exportação | 11 |
| Permissões | 7 |
| **Efeitos colaterais: as negativas** | 7 |
| Central e monitoramento | 6 |

Os 15 testes do §43 estão cobertos. Os quatro que dependeriam de rede externa —
API, ERP, timeout, retry — rodam contra servidor HTTP local real.

### As negativas

Contadas antes e depois de rodar o módulo inteiro: **nenhuma movimentação de
estoque, nenhum pedido de compra, nenhum recebimento, nenhum lote, nenhum saldo
alterado**. Nenhuma credencial fora do padrão de referência. Nenhum token no log
de erros.

## Relatório final (§47)

| # | Item | Situação |
|---|---|---|
| 1 | Integrações criadas | 8 (ERP REST, ERP arquivo, fornecedor API, portal, transportadora, fiscal, banco, e-mail) |
| 2 | Conectores | 5 tipos: REST, ARQUIVO, WEBHOOK, EMAIL, BANCO_SQL |
| 3 | APIs | 53 rotas em `/api/integracoes` |
| 4 | Mapeamentos | 4 templates, 41 campos, 12 transformações |
| 5 | Importadores | XLSX e CSV, 4 entidades (vendas, produtos, fornecedores, preços) |
| 6 | Exportadores | 8 conjuntos × 4 formatos |
| 7 | Jobs | 4, agora com rotina implementada |
| 8 | Webhooks | reaproveitados do módulo 13, com HMAC e anti-replay |
| 9 | Filas | `integracao_mensagens` com retry, backoff e dead letter |
| 10 | Retry | classificação recuperável × definitivo; 401 não é reexecutado |
| 11 | Dead letter | com reprocessamento e cancelamento |
| 12 | Logs | execuções, mensagens e erros, com payload higienizado |
| 13 | Conciliações | compara e registra; **nunca corrige sozinha** |
| 14 | Segurança | caminho restrito, HMAC, SSRF configurável, segredo por referência |
| 15 | Auditoria | ação `EXPORTACAO` para dado sensível que sai |
| 16 | Testes | 104/104; regressão 1.626/1.626 |
| 17 | Erros encontrados | 11, listados acima |
| 18 | Pendências | abaixo |
| 19 | Limitações | abaixo |
| 20 | Próximas melhorias | abaixo |

## Limitações registradas

- **Nenhum sistema externo real foi contatado.** O ambiente não tem rede. O
  conector foi exercitado contra servidor HTTP local; falar com um ERP, IMAP ou
  SQL Server de verdade continua por provar.
- **E-mail não envia nem recebe.** `email.service.ts` prepara e interpreta
  mensagens; não há SMTP nem IMAP. A leitura inteligente (§16) extrai fornecedor,
  produto, quantidade e preço por regra, e **apresenta para validação humana**
  antes de tocar em registro — como a §16 exige.
- **Portal do fornecedor (§20) é arquitetura, não tela.** As tabelas, a direção
  de integração e o isolamento por fornecedor existem; a interface do fornecedor
  não foi construída.
- **Importar 426 mil linhas leva cerca de 8,7 minutos.** Aceitável para carga
  inicial de ERP, incômodo para rotina diária. A sincronização incremental por
  data de atualização é o caminho, e a estrutura (`atualizado_na_origem`,
  `marca_inicio`, `marca_fim`) já existe.
- **OAuth2 não tem fluxo de renovação automática.** O tipo existe e a credencial
  é guardada por referência; renovar o token ainda é manual.
- **A conciliação só compara saldo de estoque.** A estrutura é genérica
  (`entidade`, `campo`), mas só o comparador de estoque foi implementado.

## Pendências

- **1.432 dos 2.283 produtos com demanda continuam sem fornecedor vinculado** — o
  mesmo achado dos módulos 12 e 13. A importação de `produto_fornecedor` agora
  existe e é o caminho mais rápido para resolver: uma planilha do fornecedor com
  CNPJ, código e preço fecha o problema.
- **Backup e recuperação (§41)** não foram implementados como processo do sistema.
  Existe o dump do banco, feito manualmente.
- **Separação de ambientes (§42)** está no nível da credencial (cada uma declara o
  ambiente e a divergência é recusada no uso), não no nível de infraestrutura.

## Como rodar

```bash
bash /home/claude/testar.sh m14
bash /home/claude/regressao.sh m04 m05 m06 m07 m08 m09 m10 m11 m12 m13 m14
```

Importar o relatório do ERP pela API:

```
POST /api/integracoes/importacoes
     { "caminho": "/mnt/user-data/uploads/Rel_7104_2026.xlsx",
       "nome_arquivo": "Rel_7104_2026.xlsx", "entidade": "vendas" }
POST /api/integracoes/importacoes/{id}/mapear      { "template": "REL7104_VENDAS" }
POST /api/integracoes/importacoes/{id}/validar
POST /api/integracoes/importacoes/{id}/confirmar
POST /api/integracoes/importacoes/{id}/processar
```
