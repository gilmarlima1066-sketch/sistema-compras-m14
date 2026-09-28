# Arquitetura

## Visão geral

```
┌─────────────────────────────────────────────────────────┐
│  Frontend — React + TypeScript + Vite                   │
│  páginas · componentes · hooks · cliente HTTP único      │
└──────────────────────────┬──────────────────────────────┘
                           │  HTTP/JSON + Bearer JWT
┌──────────────────────────▼──────────────────────────────┐
│  API — Express                                          │
│  rotas · middlewares (auth, permissão, erro, contexto)  │
├─────────────────────────────────────────────────────────┤
│  Service Layer                                          │
│  regra de negócio · transações · validação zod          │
├─────────────────────────────────────────────────────────┤
│  Acesso a dados — pg (pool, queries parametrizadas)     │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  PostgreSQL 16                                          │
│  43 tabelas · 5 views · 69 triggers · 105 FKs           │
│  constraints · auditoria · soft delete                  │
└─────────────────────────────────────────────────────────┘
```

## Princípio que orienta o desenho

**O banco é a última linha de defesa, não a única.** Cada regra crítica existe em
dois lugares: na validação da aplicação (mensagem clara para quem está usando) e
em constraint ou trigger no PostgreSQL (garantia de que nenhum caminho —
script, integração futura, psql — consegue furar). Estoque negativo, por
exemplo, é barrado pelo serviço *e* pela trigger de movimentação.

## Backend

### Estrutura

```
backend/src/
├── config/        env.ts (validação do .env), database.ts (pool + transações)
├── core/          errors.ts, http.ts, validate.ts, paginacao.ts
├── middlewares/   autenticar, autorizar, contextoRequisicao, errorHandler
├── modules/       auth, produtos, fornecedores, estoque, usuarios,
│                  cadastros, dashboard, auditoria
├── scripts/       migrate, seed, reset, smoke-test
├── routes.ts      registro central de módulos
├── app.ts         helmet, cors, /health, montagem de rotas
└── server.ts      subida e graceful shutdown
```

Cada módulo é autocontido (`*.routes.ts`, `*.service.ts`, `*.schemas.ts`) e se
registra em `routes.ts`. Um módulo novo — cotações, por exemplo — entra sem
tocar nos existentes.

### Decisões

**ESM + TypeScript strict.** Sem `any` implícito, imports com extensão `.js`
como o Node exige em ESM.

**Validação com zod na borda.** Nada entra no serviço sem passar por schema.
Erro de validação vira HTTP 422 com a lista de campos.

**Transações explícitas.** Toda escrita passa por `comTransacao()`, que abre a
conexão, define `app.usuario_id` e `app.ip` via `set_config` (é daí que as
triggers de auditoria descobrem quem fez a alteração) e faz `ROLLBACK`
automático em qualquer exceção.

**Permissões no formato `<modulo>.<acao>`.** O middleware `exigirPermissao`
consulta as permissões do perfil com cache de 60 segundos, revalidando o usuário
a cada requisição — um usuário desativado perde acesso na hora, sem esperar o
token expirar.

**Tradução de erros do PostgreSQL.** O `errorHandler` converte códigos nativos
(23505 unique, 23503 FK, 23502 not null, 23514 check, P0001 raise) no envelope
padrão, com status HTTP coerente. O usuário recebe "código já cadastrado", não
um stack trace.

**Ordenação por whitelist.** A paginação só aceita colunas de uma lista
explícita, fechando a porta para injeção via `ORDER BY`.

### Segurança

- Senhas com bcrypt; o banco tem CHECK exigindo formato de hash bcrypt na coluna
- JWT assinado com segredo do `.env`, validade configurável
- Rate limit no login, com comparação dummy para não vazar quais e-mails existem
- Helmet e CORS restrito à origem configurada
- Queries sempre parametrizadas
- Senha nunca volta em nenhuma resposta (coberto por teste)

## Frontend

### Estrutura

```
frontend/src/
├── api/           client.ts (fetch único), tipos.ts (contratos)
├── auth/          AuthContext, RotaProtegida
├── componentes/   Layout (sidebar + topbar), Cabecalho, ui.tsx (primitivas)
├── hooks/         useLista (busca paginada reutilizável)
├── paginas/       Login, Dashboard, Estoque, Produtos, Fornecedores,
│                  Usuarios, EmBreve
├── App.tsx        rotas
└── styles.css     design tokens e componentes visuais
```

**Um único cliente HTTP.** Nenhuma tela chama `fetch` direto. O `client.ts`
concentra o envelope `{success, data, message}`, o envio do JWT, a tradução de
erro em `ErroApi` e o evento de sessão expirada que desloga o usuário quando a
API devolve 401.

**A interface esconde, o backend decide.** `pode('produtos.criar')` remove o
botão de quem não tem permissão, mas isso é conveniência visual — a autorização
real acontece no servidor, e o teste de fumaça confirma o 403.

**Nenhum número fixo no Dashboard.** Todos os indicadores vêm de
`GET /api/dashboard`, que os calcula em uma única query sobre as views.

### Identidade visual

Interface de ERP: densa, sóbria, orientada a tabela. Tipografia IBM Plex Sans
para texto e IBM Plex Mono para números — alinhamento de dígitos importa quando
se lê coluna de saldo. Paleta em cinzas frios com verde-oliva de acento, e cores
reservadas para significado (ruptura em vermelho, excesso em azul), não para
decoração. Layout responsivo com sidebar colapsável.

## Fluxo de uma requisição

```
POST /api/estoque/movimentacoes
  → contextoRequisicao   captura IP
  → autenticar           valida JWT, recarrega usuário do banco
  → exigirPermissao      confere "estoque.movimentar"
  → validar (zod)        valida o corpo → 422 se inválido
  → serviço              abre transação, define app.usuario_id/app.ip
  → INSERT movimentacao
      ├─ trigger aplica o saldo em estoques
      ├─ trigger bloqueia saldo negativo (configurável)
      └─ trigger grava auditoria com o usuário da sessão
  → COMMIT (ou ROLLBACK em qualquer erro)
  → 201 {success, data, message}
```

## Convenções

| Item                | Padrão                                               |
|---------------------|------------------------------------------------------|
| Tabelas e colunas   | `snake_case`, tabela no plural                        |
| Chave primária      | `BIGINT GENERATED ALWAYS AS IDENTITY`                 |
| Domínios fechados   | ENUM nativo do PostgreSQL (29 tipos)                  |
| Auditoria de linha  | `created_at`, `updated_at`, `created_by`, `updated_by`|
| Exclusão            | Soft delete via `deleted_at`                          |
| Endpoints           | Plural, kebab-case (`/ordens-compra`)                 |
| Código-fonte        | Identificadores em português, sem acento              |

## O que esta etapa não faz

Motor de sugestão de compra, previsão de demanda, classificação ABC/XYZ
automática e assistente de IA. As tabelas que sustentam essas funções já
existem (`previsoes_demanda`, `parametros_estoque`, `necessidades_compra`,
`compromissos_compra`), e os parâmetros estão em `configuracoes` — o que falta
é a lógica, prevista para as próximas etapas.
