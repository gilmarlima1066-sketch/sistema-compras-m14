-- =========================================================================
-- 057 - SEGURANCA PARA RODAR NO SUPABASE
--
-- O Supabase publica automaticamente o schema `public` numa API REST
-- (PostgREST) acessivel com a chave `anon` - que e PUBLICA por definicao.
-- Todo projeto novo concede a `anon` e `authenticated` acesso total as
-- tabelas criadas em `public`. Sem esta migration, qualquer pessoa com a URL
-- do projeto e a chave anon leria `usuarios` (hash de senha), pedidos,
-- precos e credenciais de integracao, e poderia gravar neles.
--
-- Este sistema NAO usa essa API: o frontend fala so com a API Express, que
-- autentica com JWT proprio, autoriza por perfil/permissao e conecta ao banco
-- como dono das tabelas. Entao a politica coerente para os papeis da API
-- publica do Supabase e: nenhum acesso.
--
-- Duas camadas independentes:
--   1. RLS ligado em todas as tabelas, sem politica para anon/authenticated
--      (negacao por padrao). O dono das tabelas - o usuario da API - nao e
--      afetado, porque RLS nao se aplica ao dono sem FORCE.
--   2. Privilegios de anon/authenticated revogados em tabelas, views,
--      sequencias e funcoes - inclusive para objetos criados no futuro - e a
--      concessao explicita de USAGE no schema. (Views rodam com o privilegio
--      do dono e ignorariam o RLS: por isso a revogacao e necessaria, e nao so
--      o RLS.) O USAGE que o PostgreSQL da a PUBLIC no schema public continua,
--      mas sem privilegio em nenhuma tabela ou view ele nao da acesso a dado.
--      Nenhuma funcao deste schema e SECURITY DEFINER.
--
-- Terceira camada, manual e recomendada: no painel do Supabase, retirar
-- `public` dos "Exposed schemas" da Data API (ver README).
--
-- Fora do Supabase (PostgreSQL local), os papeis anon/authenticated nao
-- existem: a migration so liga o RLS, sem efeito para a aplicacao.
--
-- A funcao abaixo e reaplicada pelo `npm run db:migrate` ao final de toda
-- execucao, para que tabelas criadas por migrations futuras nascam protegidas
-- sem depender de alguem lembrar.
-- =========================================================================

CREATE OR REPLACE FUNCTION aplicar_seguranca_supabase() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t record;
  papel text;
BEGIN
  -- 1. RLS em toda tabela (comum e particionada) do schema public.
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;

  -- 2 e 3. Papeis da API publica do Supabase: sem acesso algum.
  FOREACH papel IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = papel) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM %I', papel);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', papel);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', papel);
      EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', papel);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM %I', papel);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', papel);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', papel);
    END IF;
  END LOOP;

  -- O papel somente leitura da IA (db/roles/001_papel_leitura_ia.sql) nao e
  -- dono das tabelas: com RLS ligado, precisa de politica de leitura. O que
  -- ele NAO pode ler (usuarios, ia_execucoes) continua barrado pelo GRANT -
  -- politica de RLS filtra linhas, nao concede privilegio.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'compras_ia') THEN
    FOR t IN
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND NOT EXISTS (
           SELECT 1 FROM pg_policies p
            WHERE p.schemaname = 'public' AND p.tablename = c.relname
              AND p.policyname = 'leitura_ia'
         )
    LOOP
      EXECUTE format(
        'CREATE POLICY leitura_ia ON public.%I FOR SELECT TO compras_ia USING (true)',
        t.relname);
    END LOOP;
  END IF;
END
$$;

-- So o dono (quem roda as migrations) executa a funcao.
REVOKE ALL ON FUNCTION aplicar_seguranca_supabase() FROM PUBLIC;

SELECT aplicar_seguranca_supabase();
