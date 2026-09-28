-- =========================================================================
-- PAPEL SOMENTE LEITURA PARA AS CONSULTAS ANALITICAS DA IA (secao 23)
--
-- Este arquivo NAO e uma migration, e de proposito.
--
-- Criar papel e conceder privilegio exige superusuario. A aplicacao roda como
-- `compras_app`, que nao e - e nao deve ser. Um sistema que consegue criar o
-- proprio usuario de banco consegue tambem conceder a si mesmo o que quiser,
-- e a separacao de privilegio deixa de existir no instante em que e criada.
--
-- Entao isto aqui e trabalho de DBA, rodado uma vez, como superusuario:
--
--     psql -U postgres -d compras -f db/roles/001_papel_leitura_ia.sql
--
-- Depois, configure no backend:
--
--     DATABASE_URL_LEITURA=postgres://compras_ia:<senha>@host:5432/compras
--
-- Sem essa variavel o sistema NAO fica inseguro nem deixa de funcionar: a
-- guarda de SQL continua valendo e as consultas continuam rodando dentro de
-- uma transacao READ ONLY, que o proprio PostgreSQL recusa escrever. O papel
-- e a terceira camada, nao a unica - e o `/api/ia/seguranca` informa quantas
-- camadas estao ativas, em vez de deixar a duvida no ar.
--
-- TROQUE A SENHA ABAIXO ANTES DE RODAR EM QUALQUER AMBIENTE REAL.
-- =========================================================================

-- 1. O papel. NOLOGIN nao serve: ele precisa conectar. Mas nao herda nada.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'compras_ia') THEN
    CREATE ROLE compras_ia LOGIN PASSWORD 'troque_esta_senha'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION
      CONNECTION LIMIT 5;
  END IF;
END
$$;

-- 2. Toda sessao dele ja comeca somente leitura, mesmo que a aplicacao
--    esqueca de abrir a transacao como READ ONLY.
ALTER ROLE compras_ia SET default_transaction_read_only = on;

-- 3. Teto de tempo por consulta, aplicado pelo banco. Uma consulta analitica
--    mal filtrada nao derruba o servidor de quem esta operando.
ALTER ROLE compras_ia SET statement_timeout = '10s';
ALTER ROLE compras_ia SET idle_in_transaction_session_timeout = '15s';

-- 4. Leitura, e so leitura, no schema public.
GRANT CONNECT ON DATABASE compras TO compras_ia;
GRANT USAGE   ON SCHEMA public    TO compras_ia;
GRANT SELECT  ON ALL TABLES    IN SCHEMA public TO compras_ia;
GRANT SELECT  ON ALL SEQUENCES IN SCHEMA public TO compras_ia;

-- Tabelas criadas depois desta data tambem nascem legiveis por ele.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO compras_ia;
ALTER DEFAULT PRIVILEGES FOR ROLE compras_app IN SCHEMA public
  GRANT SELECT ON TABLES TO compras_ia;

-- 5. E o que ele nao pode ver.
--
--    `usuarios` guarda hash de senha. A IA responde sobre compras, estoque e
--    fornecedores - nunca precisa ler credencial, e o caminho mais curto para
--    nao vazar uma e nao ter acesso a ela.
REVOKE SELECT ON usuarios FROM compras_ia;

--    `ia_execucoes` e o log de seguranca do proprio mecanismo. Deixar a
--    consulta analitica ler o log das consultas analiticas permitiria
--    reconhecer o que ja foi barrado.
REVOKE SELECT ON ia_execucoes FROM compras_ia;

--    E nada de criar objeto no schema.
REVOKE CREATE ON SCHEMA public FROM compras_ia;

-- 6. Conferencia. Deve devolver zero linha.
--
--   SELECT table_name, privilege_type
--     FROM information_schema.table_privileges
--    WHERE grantee = 'compras_ia'
--      AND privilege_type <> 'SELECT';
