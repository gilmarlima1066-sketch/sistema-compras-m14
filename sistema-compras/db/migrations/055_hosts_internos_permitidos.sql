-- ---------------------------------------------------------------------------
-- 055 - Lista de hosts internos liberados para endpoint de integracao
--
-- A validacao de endpoint recusava TODA rede privada: localhost, 10.x, 192.168.x,
-- 172.16-31.x, .local, .internal. Para um sistema publico essa e a regra certa -
-- endpoint interno so serve a quem quer pivotar para dentro da rede (SSRF).
--
-- Mas este sistema roda na propria empresa, e o ERP de uma distribuidora fica
-- quase sempre na rede local. Com a regra rigida, a secao 8 inteira - "integracao
-- com ERP", o motivo de existir do modulo - ficava impossivel de configurar: nao
-- havia endereco valido para apontar.
--
-- A saida nao e afrouxar a protecao, e tornar a excecao explicita e nomeada.
-- Vazio por padrao: nada interno passa. O operador escreve os hosts que ele
-- mesmo administra, um a um. Quem ataca nao escolhe o endereco; quem administra
-- escolhe uma vez, por escrito, e fica registrado em configuracao auditavel.
-- ---------------------------------------------------------------------------

INSERT INTO configuracoes (chave, valor, tipo, grupo, descricao, ativo)
SELECT 'integracao.hosts_internos_permitidos', '', 'STRING', 'integracao',
       'Hosts de rede interna liberados como endpoint de integracao, separados '
       'por virgula (ex.: erp.local, 192.168.1.50). Vazio bloqueia toda rede '
       'privada, que e o padrao seguro.',
       true
 WHERE NOT EXISTS (
   SELECT 1 FROM configuracoes
    WHERE chave = 'integracao.hosts_internos_permitidos');
