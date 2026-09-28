-- ===========================================================================
-- Custo de referencia do produto.
--
-- O impacto financeiro do planejamento so existe se houver preco. Hoje o preco
-- vem de produto_fornecedor, que so tem contrato para uma dezena de itens - o
-- catalogo de fornecedores ainda nao foi carregado. Enquanto isso, o ultimo
-- custo praticado no ERP e a melhor referencia disponivel, e fica marcado como
-- tal: e estimativa de custo, nunca preco negociado.
-- ===========================================================================

ALTER TABLE produtos
  ADD COLUMN IF NOT EXISTS custo_referencia        NUMERIC(14, 4),
  ADD COLUMN IF NOT EXISTS custo_referencia_em     DATE,
  ADD COLUMN IF NOT EXISTS custo_referencia_origem TEXT;

COMMENT ON COLUMN produtos.custo_referencia IS
  'Custo unitario de referencia para estimar valor de compra quando nao ha preco de fornecedor';

CREATE INDEX IF NOT EXISTS ix_produtos_custo_referencia
  ON produtos (custo_referencia) WHERE custo_referencia IS NOT NULL;

-- Carga a partir da area de pouso do ERP, quando ela existir nesta instalacao.
DO $$
BEGIN
  IF to_regclass('staging.rel7104_limpo') IS NULL THEN
    RAISE NOTICE 'staging.rel7104_limpo ausente: custo de referencia fica para a proxima carga do ERP';
    RETURN;
  END IF;

  WITH ultimo AS (
    SELECT DISTINCT ON (l.codigo_produto)
           l.codigo_produto, l.custo_unitario, l.data_venda
      FROM staging.rel7104_limpo l
     WHERE l.custo_unitario > 0
     ORDER BY l.codigo_produto, l.data_venda DESC
  )
  UPDATE produtos p
     SET custo_referencia        = u.custo_unitario,
         custo_referencia_em     = u.data_venda,
         custo_referencia_origem = 'ERP:REL7104 (ultimo custo praticado)'
    FROM ultimo u
   WHERE p.codigo = u.codigo_produto
     AND p.deleted_at IS NULL;
END $$;
