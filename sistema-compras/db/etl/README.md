# ETL do relatorio 7104 (ERP)

Carrega o historico de vendas do ERP nas tabelas oficiais do sistema.
A carga e idempotente: a chave natural e NF + cliente + data, entao rodar de
novo nao duplica nada.

1. `xlsx2csv.py` converte o Excel em CSV por streaming (nao carrega o arquivo
   inteiro em memoria).
2. `01_staging.sql` cria `staging.rel7104`, tudo texto.
3. `02_normalizar.sql` deriva categorias, clientes, produtos, vendas e itens.

Veja `docs/MODULO-04.md` para os comandos e para as convencoes adotadas
(quantidade em embalagens, sinal da devolucao, NF repetida entre anos).
