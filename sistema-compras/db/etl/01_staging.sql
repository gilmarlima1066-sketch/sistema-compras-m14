-- Area de pouso do relatorio 7104 do ERP. Tudo texto: a limpeza acontece depois,
-- para que um valor fora do padrao nao derrube a carga inteira.
CREATE SCHEMA IF NOT EXISTS staging;

DROP TABLE IF EXISTS staging.rel7104;
CREATE TABLE staging.rel7104 (
  dtfaturamento text, codproduto text, descricao text, qtde text, total text,
  valormedio text, fantasia text, cidade text, estado text, apelido text,
  numnf text, venda text, numlote text, validadecp text, custo text,
  custo_total text, imposto text, subgrupo text, situacao text,
  id_ciente text, tipo text, cfop text, codop text
);
