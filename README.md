# sistema-compras-m14

Sistema de Gestão de Compras, Estoque e Fornecedores — frontend React/Vite,
API Express/TypeScript e banco PostgreSQL no Supabase, publicado na Vercel.

Toda a documentação (pré-requisitos, variáveis, comandos, migrations, Supabase
e Vercel) está em [`sistema-compras/README.md`](sistema-compras/README.md).

Início rápido:

```bash
cd sistema-compras/backend && cp .env.example .env   # preencha DATABASE_URL, PGSSL e JWT_SECRET
npm ci && npm run db:migrate && npm run db:seed && npm run dev
# em outro terminal
cd sistema-compras/frontend && npm ci && npm run dev   # http://localhost:5173
```
