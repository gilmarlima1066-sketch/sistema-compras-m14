# API REST

Base: `http://localhost:3333/api` · Autenticação: `Authorization: Bearer <jwt>`

## Envelope de resposta

Sucesso:

```json
{ "success": true, "data": { }, "message": "Produto criado com sucesso" }
```

Listagens acrescentam `meta`:

```json
{ "success": true, "data": [], "message": "Produtos listados",
  "meta": { "total": 10, "pagina": 1, "limite": 25, "paginas": 1 } }
```

Erro:

```json
{ "success": false,
  "error": { "code": "VALIDATION_ERROR", "message": "Dados invalidos",
             "details": [{ "campo": "estoque_minimo", "mensagem": "deve ser >= 0" }] } }
```

## Códigos de erro

| HTTP | `code`             | Quando acontece                                      |
|------|--------------------|------------------------------------------------------|
| 400  | `BAD_REQUEST`      | Requisição malformada                                 |
| 401  | `UNAUTHORIZED`     | Sem token, token inválido/expirado, usuário inativado |
| 403  | `FORBIDDEN`        | Autenticado, mas sem a permissão exigida              |
| 404  | `NOT_FOUND`        | Recurso inexistente ou já excluído                    |
| 409  | `CONFLICT`         | Violação de unicidade (código duplicado, por exemplo) |
| 422  | `VALIDATION_ERROR` | Falha de schema, constraint ou regra de negócio       |
| 429  | `RATE_LIMITED`     | Tentativas de login em excesso                        |
| 500  | `INTERNAL_ERROR`   | Erro inesperado (detalhe fica no log, não na resposta)|

## Paginação e filtros

Parâmetros aceitos nas listagens: `pagina` (1), `limite` (25, máx. 100),
`busca`, `ordenar_por`, `ordem` (`asc`/`desc`). A ordenação só aceita colunas de
uma whitelist por módulo.

## Endpoints

### Infra

| Método | Rota      | Permissão | Descrição                       |
|--------|-----------|-----------|----------------------------------|
| GET    | `/health` | pública   | Estado da API e conexão do banco |

### Autenticação — `/api/auth`

| Método | Rota             | Permissão   | Descrição                               |
|--------|------------------|-------------|------------------------------------------|
| POST   | `/login`         | pública     | Autentica e devolve token + usuário       |
| GET    | `/eu`            | autenticado | Perfil e permissões da sessão atual       |
| POST   | `/trocar-senha`  | autenticado | Troca a própria senha                     |

O login tem rate limit e faz comparação dummy quando o e-mail não existe, para
não revelar quais contas estão cadastradas.

### Produtos — `/api/produtos`

| Método | Rota    | Permissão          | Descrição                                       |
|--------|---------|--------------------|--------------------------------------------------|
| GET    | `/`     | `produtos.ler`     | Lista paginada com filtros                        |
| GET    | `/:id`  | `produtos.ler`     | Detalhe                                           |
| POST   | `/`     | `produtos.criar`   | Cria                                              |
| PUT    | `/:id`  | `produtos.editar`  | Atualiza                                          |
| DELETE | `/:id`  | `produtos.excluir` | Soft delete — recusado se houver saldo em estoque |

### Fornecedores — `/api/fornecedores`

| Método | Rota                | Permissão              | Descrição                                       |
|--------|---------------------|------------------------|--------------------------------------------------|
| GET    | `/`                 | `fornecedores.ler`     | Lista paginada                                    |
| GET    | `/:id`              | `fornecedores.ler`     | Detalhe                                           |
| GET    | `/:id/performance`  | `fornecedores.ler`     | OTIF, qualidade, atraso médio                     |
| POST   | `/`                 | `fornecedores.criar`   | Cria (nacional exige CNPJ)                        |
| PUT    | `/:id`              | `fornecedores.editar`  | Atualiza                                          |
| POST   | `/:id/produtos`     | `fornecedores.editar`  | Vincula produto; gera histórico de preço          |
| DELETE | `/:id`              | `fornecedores.excluir` | Soft delete                                       |

### Estoque — `/api/estoque`

| Método | Rota              | Permissão             | Descrição                                        |
|--------|-------------------|-----------------------|---------------------------------------------------|
| GET    | `/`               | `estoque.ler`         | Posição por produto, com situação e cobertura     |
| GET    | `/criticos`       | `estoque.ler`         | Apenas os SKUs fora da faixa saudável             |
| GET    | `/:produto_id`    | `estoque.ler`         | Saldo, lotes e últimas movimentações              |
| POST   | `/movimentacoes`  | `estoque.movimentar`  | Registra entrada, saída, ajuste ou transferência  |

O saldo é aplicado por trigger. Saída maior que o disponível é bloqueada e a
transação inteira sofre rollback.

### Usuários — `/api/usuarios`

| Método | Rota       | Permissão          | Descrição                                       |
|--------|------------|--------------------|--------------------------------------------------|
| GET    | `/perfis`  | `usuarios.ler`     | Perfis com contagem de usuários e permissões      |
| GET    | `/`        | `usuarios.ler`     | Lista paginada                                    |
| POST   | `/`        | `usuarios.criar`   | Cria usuário (senha com bcrypt)                   |
| PUT    | `/:id`     | `usuarios.editar`  | Atualiza — não permite desativar a si mesmo       |
| DELETE | `/:id`     | `usuarios.excluir` | Soft delete — não permite excluir a si mesmo      |

### Cadastros de apoio — `/api/cadastros`

| Método    | Rota                     | Permissão                      |
|-----------|--------------------------|--------------------------------|
| GET/POST  | `/categorias`            | `produtos.ler` / `produtos.criar` |
| GET/POST  | `/subcategorias`         | `produtos.ler` / `produtos.criar` |
| GET/POST  | `/marcas`                | `produtos.ler` / `produtos.criar` |
| GET       | `/unidades`              | `produtos.ler`                 |
| GET       | `/locais`                | `estoque.ler`                  |
| GET       | `/condicoes-pagamento`   | `compras.ler`                  |

`/subcategorias` aceita `?categoria_id=` para filtrar.

### Dashboard — `/api/dashboard`

| Método | Rota | Permissão       | Descrição                                          |
|--------|------|-----------------|-----------------------------------------------------|
| GET    | `/`  | `dashboard.ler` | Indicadores, produtos críticos e alertas recentes    |

Tudo calculado em uma query sobre as views — nenhum valor fixo.

O módulo 11 acrescentou painéis gerenciais, drill-down e contexto de decisão
sob o mesmo prefixo, além de `/api/kpis` e `/api/alertas`. Estão documentados
em [`MODULO-11.md`](MODULO-11.md).

O módulo 12 acrescentou `/api/ia` — Central de Decisão, recomendações, riscos,
Pergunte aos Dados e simulações. Documentado em
[`MODULO-12.md`](MODULO-12.md), incluindo as três camadas de segurança do
Text-to-SQL.

### Auditoria — `/api/auditoria`

| Método | Rota | Permissão       | Descrição                                                    |
|--------|------|-----------------|---------------------------------------------------------------|
| GET    | `/`  | `auditoria.ler` | Trilha paginada, filtrável por tabela, registro, usuário e período |

## Exemplos

```bash
# Login
curl -s -X POST localhost:3333/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@empresa.com.br","senha":"Admin@123"}'

TOKEN=...

# Produtos críticos
curl -s localhost:3333/api/estoque/criticos -H "Authorization: Bearer $TOKEN"

# Entrada de estoque
curl -s -X POST localhost:3333/api/estoque/movimentacoes \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"produto_id":1,"local_id":1,"tipo":"ENTRADA","quantidade":500,
       "custo_unitario":8.50,"observacao":"Recebimento NF 1234"}'
```
