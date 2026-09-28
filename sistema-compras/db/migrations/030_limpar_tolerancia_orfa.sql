-- ---------------------------------------------------------------------------
-- 030 - remove a configuracao de tolerancia que ficou sem uso
--
-- 'recebimento.tolerancia_excesso_percentual' existia para os dois gatilhos
-- desativados na migration 027. Desde o modulo 09 a tolerancia vem da tabela
-- parametros_tolerancia, resolvida do mais especifico para o mais geral
-- (produto, fornecedor, categoria, operacao, empresa).
--
-- Deixar a chave na tela de parametros seria pior do que remove-la: o usuario
-- ajustaria um numero que nao muda coisa alguma. O valor que estava nela vira
-- a linha de empresa, caso ela ainda nao exista.
-- ---------------------------------------------------------------------------

INSERT INTO parametros_tolerancia (escopo, quantidade_percentual, observacao)
SELECT 'EMPRESA',
       coalesce((SELECT valor::numeric FROM configuracoes
                  WHERE chave = 'recebimento.tolerancia_excesso_percentual'), 0),
       'Migrada da configuracao recebimento.tolerancia_excesso_percentual'
 WHERE NOT EXISTS (
   SELECT 1 FROM parametros_tolerancia WHERE escopo = 'EMPRESA' AND ativo
 );

DELETE FROM configuracoes WHERE chave = 'recebimento.tolerancia_excesso_percentual';
