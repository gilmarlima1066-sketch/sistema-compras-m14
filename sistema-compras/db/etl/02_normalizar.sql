-- ---------------------------------------------------------------------------
-- Normaliza o relatorio 7104 do ERP para as tabelas oficiais do sistema.
--
-- Convencoes adotadas (documentadas porque sao decisoes, nao leitura literal):
--  * O SKU do ERP ja embute o peso da embalagem ("GERGELIM PRETO 5KG"). Por isso
--    a quantidade vendida esta em EMBALAGENS, nao em quilos. O peso extraido da
--    descricao vai para produtos.peso e permite converter para kg quando preciso.
--  * TIPO = DEVOLUCAO entra como quantidade NEGATIVA (convencao prevista no
--    modulo 04), de modo que a demanda liquida seja soma simples.
--  * Uma venda = uma combinacao NF + cliente + data. O numero da NF sozinho
--    repete entre anos e entre entrada/saida.
--  * Nada e apagado: a carga e idempotente por chave natural.
-- ---------------------------------------------------------------------------

-- 1. Limpeza minima sobre a staging ------------------------------------------
DROP TABLE IF EXISTS staging.rel7104_limpo;
CREATE TABLE staging.rel7104_limpo AS
SELECT
  left(dtfaturamento, 10)::date                       AS data_venda,
  btrim(codproduto)                                   AS codigo_produto,
  btrim(descricao)                                    AS descricao,
  btrim(subgrupo)                                     AS subgrupo,
  btrim(id_ciente)                                    AS codigo_cliente,
  nullif(btrim(fantasia), '')                         AS cliente_nome,
  nullif(btrim(cidade), '')                           AS cidade,
  nullif(btrim(estado), '')                           AS estado,
  nullif(btrim(apelido), '')                          AS canal,
  btrim(numnf)                                        AS numero_nf,
  btrim(tipo)                                         AS tipo,
  btrim(situacao)                                     AS situacao,
  btrim(cfop)                                         AS cfop,
  CASE WHEN btrim(tipo) = 'DEVOLUCAO' THEN -1 ELSE 1 END * coalesce(nullif(qtde, '')::numeric, 0)       AS quantidade,
  CASE WHEN btrim(tipo) = 'DEVOLUCAO' THEN -1 ELSE 1 END * coalesce(nullif(total, '')::numeric, 0)      AS valor_total,
  coalesce(nullif(valormedio, '')::numeric, 0)        AS preco_unitario,
  coalesce(nullif(custo, '')::numeric, 0)             AS custo_unitario
FROM staging.rel7104
WHERE left(dtfaturamento, 10) ~ '^\d{4}-\d{2}-\d{2}$'
  AND btrim(codproduto) <> ''
  AND btrim(numnf) <> '';

CREATE INDEX ix_limpo_produto ON staging.rel7104_limpo (codigo_produto);
CREATE INDEX ix_limpo_venda   ON staging.rel7104_limpo (numero_nf, codigo_cliente, data_venda);

-- 2. Categorias (subgrupo do ERP) --------------------------------------------
INSERT INTO categorias (nome, descricao, ativo)
SELECT DISTINCT l.subgrupo, 'Importado do ERP (SUBGRUPO)', l.subgrupo NOT LIKE '%(INATIVO)%'
FROM staging.rel7104_limpo l
WHERE l.subgrupo <> ''
  AND NOT EXISTS (SELECT 1 FROM categorias c WHERE c.nome = l.subgrupo);

-- 3. Clientes ------------------------------------------------------------------
INSERT INTO clientes (codigo_externo, nome, cidade, estado, canal, ativo)
SELECT DISTINCT ON (l.codigo_cliente)
       l.codigo_cliente,
       coalesce(l.cliente_nome, 'CLIENTE ' || l.codigo_cliente),
       l.cidade, l.estado, l.canal, true
FROM staging.rel7104_limpo l
WHERE l.codigo_cliente <> ''
  AND NOT EXISTS (SELECT 1 FROM clientes c WHERE c.codigo_externo = l.codigo_cliente)
ORDER BY l.codigo_cliente, l.data_venda DESC;

-- 4. Produtos --------------------------------------------------------------
-- O peso sai da descricao. \y e limite de palavra no Postgres (\b e backspace).
WITH ultimo AS (
  SELECT DISTINCT ON (codigo_produto)
         codigo_produto, descricao, subgrupo
  FROM staging.rel7104_limpo
  ORDER BY codigo_produto, data_venda DESC
), com_peso AS (
  SELECT u.*,
         (SELECT CASE
                   WHEN m[2] ILIKE 'KG' THEN replace(m[1], ',', '.')::numeric
                   WHEN m[2] ILIKE 'G'  THEN replace(m[1], ',', '.')::numeric / 1000
                 END
          FROM regexp_matches(u.descricao, '(\d+(?:[.,]\d+)?)\s*(KG|G)\y', 'i') AS m
          LIMIT 1) AS peso_kg
  FROM ultimo u
)
INSERT INTO produtos (codigo, descricao, descricao_completa, categoria_id,
                      unidade_compra_id, unidade_estoque_id, unidade_venda_id,
                      fator_conversao, peso, ativo)
SELECT p.codigo_produto,
       left(p.descricao, 120),
       p.descricao,
       c.id,
       un.id, un.id, un.id,
       1,
       p.peso_kg,
       true
FROM com_peso p
JOIN categorias c ON c.nome = p.subgrupo
CROSS JOIN (SELECT id FROM unidades WHERE codigo = 'UN') un
WHERE NOT EXISTS (SELECT 1 FROM produtos x WHERE x.codigo = p.codigo_produto);

-- 5. Vendas ------------------------------------------------------------------
INSERT INTO vendas (numero_documento, data_venda, cliente_id, canal, valor_total,
                    status, tipo_documento, origem_integracao)
SELECT k.numero_documento, k.data_venda, cl.id, k.canal, k.valor_total,
       'FATURADA'::status_venda_enum, k.tipo_documento, 'ERP:REL7104'
FROM (
  SELECT l.numero_nf || '/' || l.codigo_cliente || '/' || to_char(l.data_venda, 'YYYYMMDD') AS numero_documento,
         l.data_venda,
         l.codigo_cliente,
         min(l.canal) AS canal,
         -- NF mista (uma unica no historico) fica como VENDA; o sinal do item decide.
         (CASE WHEN bool_and(l.tipo = 'DEVOLUCAO') THEN 'DEVOLUCAO' ELSE 'VENDA' END)::tipo_documento_venda_enum AS tipo_documento,
         -- O cabecalho guarda o valor do documento (sempre positivo: uma NF de
         -- devolucao de R$ 271,50 vale R$ 271,50). O sinal da demanda fica no item.
         abs(sum(l.valor_total)) AS valor_total
  FROM staging.rel7104_limpo l
  GROUP BY 1, 2, 3
) k
JOIN clientes cl ON cl.codigo_externo = k.codigo_cliente
WHERE NOT EXISTS (SELECT 1 FROM vendas v WHERE v.numero_documento = k.numero_documento);

-- 6. Itens de venda ----------------------------------------------------------
INSERT INTO itens_venda (venda_id, produto_id, quantidade, preco_unitario, desconto, valor_total)
-- A quantidade fica sempre positiva: quem carrega o sinal e vendas.tipo_documento.
SELECT v.id, pr.id, abs(sum(l.quantidade)), max(l.preco_unitario), 0, abs(sum(l.valor_total))
FROM staging.rel7104_limpo l
JOIN vendas v  ON v.numero_documento = l.numero_nf || '/' || l.codigo_cliente || '/' || to_char(l.data_venda, 'YYYYMMDD')
JOIN produtos pr ON pr.codigo = l.codigo_produto
LEFT JOIN itens_venda iv ON iv.venda_id = v.id AND iv.produto_id = pr.id
WHERE iv.id IS NULL
GROUP BY v.id, pr.id
HAVING abs(sum(l.quantidade)) > 0;
