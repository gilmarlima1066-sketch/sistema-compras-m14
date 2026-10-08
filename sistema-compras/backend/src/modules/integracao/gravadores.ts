/**
 * Gravadores: onde a linha normalizada vira registro do sistema.
 *
 * Um gravador por entidade, registrado no importador. Essa separacao e o que
 * permite a secao 6 — "adicionar novas integracoes sem alterar os modulos de
 * negocio": um layout novo entra como template; uma ENTIDADE nova entra como
 * gravador, sem tocar no leitor, no mapeador nem no importador.
 *
 * TODOS seguem tres regras:
 *
 * 1. **A idempotencia e do banco.** `ON CONFLICT` sobre indice UNIQUE, nunca
 *    "SELECT e depois INSERT" — dois lotes simultaneos passariam os dois pelo
 *    SELECT.
 *
 * 2. **Referencia inexistente nao vira cadastro.** Um produto que nao existe
 *    faz a linha ser rejeitada com motivo, nao cria produto. Importacao de
 *    venda que cadastra produto sozinha enche o cadastro de lixo com o codigo
 *    errado do dia em que alguem digitou torto.
 *
 * 3. **O motivo do descarte e contado.** "3.000 linhas descartadas" sem dizer
 *    por que e pior que erro: parece que funcionou.
 */
import type { PoolClient } from 'pg';
import { pool, type ContextoSessao } from '../../config/database.js';
import { registrarGravador, type EstadoImportacao } from './importacao.service.js';

type Linha = { linha: number; dados: Record<string, unknown> };

interface Saida {
  criados: number; atualizados: number; descartados: number; rejeitados: number;
  motivos: Map<string, number>;
}

const conta = (m: Map<string, number>, motivo: string, n = 1): void => {
  m.set(motivo, (m.get(motivo) ?? 0) + n);
};

const txt = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ===========================================================================
// VENDAS — o gravador do Rel7104
// ===========================================================================

/**
 * O relatorio traz UMA LINHA POR ITEM; a venda e o agrupamento.
 *
 * A chave do documento e `NUMNF/ID_CIENTE/DATA`, porque o numero da nota
 * sozinho se repete entre clientes e entre anos — foi assim que as 129 mil
 * vendas ja no banco foram gravadas, e manter a mesma chave e o que faz
 * reimportar o arquivo reconhecer o que ja entrou em vez de duplicar.
 *
 * DEVOLUCOES SAO DESCARTADAS, por decisao do usuario (28/09/2026).
 *
 * Vale registrar a consequencia junto da regra, porque quem ler este codigo
 * daqui a um ano precisa saber: a base tem 1.985 devolucoes importadas ANTES
 * dessa decisao, e `mv_demanda_diaria` subtrai a quantidade delas. Com o
 * descarte, a demanda fica liquida de devolucao no periodo antigo e bruta no
 * novo. O descarte e contado e aparece no relatorio de importacao, nunca em
 * silencio.
 */
const gravarVendas = async (
  lote: Linha[], contexto: ContextoSessao, estado: EstadoImportacao,
): Promise<Saida> => {
  /*
   * Documentos cujos itens ja foram limpos NESTA execucao.
   *
   * Sem este conjunto, um documento dividido entre dois lotes perde itens: o
   * segundo lote apaga o que o primeiro inseriu. Aconteceu de verdade na
   * primeira importacao do arquivo do ERP - 688 documentos, 9.866 itens. A
   * limpeza agora acontece UMA vez por documento por execucao; os lotes
   * seguintes apenas acrescentam.
   */
  let limpos = estado.get('vendas_limpas') as Set<number> | undefined;
  if (!limpos) { limpos = new Set<number>(); estado.set('vendas_limpas', limpos); }

  const saida: Saida = {
    criados: 0, atualizados: 0, descartados: 0, rejeitados: 0, motivos: new Map(),
  };

  // Agrupa o lote por documento antes de tocar no banco: uma nota com doze
  // itens vira uma venda e doze itens, nao doze vendas.
  const documentos = new Map<string, {
    cabecalho: Record<string, unknown>;
    itens: Array<{ linha: number; dados: Record<string, unknown> }>;
  }>();

  for (const registro of lote) {
    const d = registro.dados;

    // Decisao do usuario: devolucao nao entra.
    if (String(d['venda.tipo_documento'] ?? '').trim().toUpperCase() === 'DEVOLUCAO') {
      saida.descartados += 1;
      conta(saida.motivos, 'devolucao descartada por configuracao');
      continue;
    }

    const numero = txt(d['venda.numero_documento']);
    const cliente = txt(d['cliente.codigo_externo']);
    const data = txt(d['venda.data_venda']);

    if (!numero || !data) {
      saida.rejeitados += 1;
      conta(saida.motivos, 'documento sem numero ou sem data');
      continue;
    }

    const chave = `${numero}/${cliente ?? '0'}/${data.replace(/-/g, '')}`;
    const grupo = documentos.get(chave);
    if (grupo) {
      grupo.itens.push(registro);
    } else {
      documentos.set(chave, { cabecalho: d, itens: [registro] });
    }
  }

  if (!documentos.size) return saida;

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    if (contexto.usuarioId) {
      await cliente.query('SELECT set_config($1, $2, true)',
        ['app.usuario_id', String(contexto.usuarioId)]);
    }

    for (const [chave, grupo] of documentos) {
      const c = grupo.cabecalho;

      const clienteId = await resolverCliente(cliente, c);

      // A venda e inserida com ON CONFLICT sobre `uq_vendas_numero`: se a nota
      // ja existe, nao duplica. `xmax = 0` distingue insercao de conflito sem
      // uma segunda consulta.
      const { rows: vendaRows } = await cliente.query<{ id: string; inserido: boolean }>(`
        INSERT INTO vendas
          (numero_documento, data_venda, cliente_id, canal, valor_total, status,
           tipo_documento, origem_integracao)
        VALUES ($1, $2::date, $3, $4, 0, 'FATURADA',
                'VENDA'::tipo_documento_venda_enum, $5)
        ON CONFLICT (numero_documento) DO UPDATE
          SET data_venda = EXCLUDED.data_venda
        RETURNING id, (xmax = 0) AS inserido`,
      [chave, txt(c['venda.data_venda']), clienteId,
        txt(c['venda.canal']), 'ERP:REL7104']);

      const vendaId = Number(vendaRows[0]!.id);
      const vendaNova = vendaRows[0]!.inserido;

      if (vendaNova) saida.criados += 1; else saida.atualizados += 1;

      // Os itens sao regravados inteiros quando a nota ja existia: evita o
      // estado meio-velho-meio-novo de tentar casar item a item sem uma chave
      // natural de item (o relatorio nao tem numero de item).
      //
      // A limpeza acontece UMA vez por documento por execucao. Um documento que
      // aparece em dois lotes e limpo no primeiro e so recebe acrescimo no
      // segundo - foi o que faltava e custou 9.866 itens na primeira execucao.
      if (!vendaNova && !limpos.has(vendaId)) {
        await cliente.query('DELETE FROM itens_venda WHERE venda_id = $1', [vendaId]);
      }
      limpos.add(vendaId);

      let totalVenda = 0;
      for (const item of grupo.itens) {
        const d = item.dados;
        const codigo = txt(d['produto.codigo']);
        if (!codigo) {
          saida.rejeitados += 1;
          conta(saida.motivos, 'item sem codigo de produto');
          continue;
        }

        const { rows: prod } = await cliente.query<{ id: string }>(
          'SELECT id FROM produtos WHERE codigo = $1 AND deleted_at IS NULL', [codigo]);

        if (!prod.length) {
          // Produto inexistente NAO e cadastrado aqui. A venda fica gravada sem
          // este item, e o motivo aparece no relatorio — cadastrar produto a
          // partir de venda encheria o cadastro de codigo digitado torto.
          saida.rejeitados += 1;
          conta(saida.motivos, `produto nao cadastrado (ex.: ${codigo})`);
          continue;
        }

        const quantidade = num(d['item.quantidade']) ?? 0;
        const valorTotal = num(d['item.valor_total']) ?? 0;
        const precoUnitario = num(d['item.preco_unitario'])
          ?? (quantidade > 0 ? valorTotal / quantidade : 0);

        if (quantidade <= 0) {
          saida.rejeitados += 1;
          conta(saida.motivos, 'quantidade zero ou negativa');
          continue;
        }

        await cliente.query(`
          INSERT INTO itens_venda
            (venda_id, produto_id, quantidade, preco_unitario, desconto, valor_total)
          VALUES ($1, $2, $3, $4, 0, $5)`,
        [vendaId, Number(prod[0]!.id), quantidade, precoUnitario, valorTotal]);

        totalVenda += valorTotal;
      }

      await cliente.query('UPDATE vendas SET valor_total = $2 WHERE id = $1',
        [vendaId, totalVenda]);
    }

    await cliente.query('COMMIT');
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }

  return saida;
};

/**
 * Cliente: cadastrado sob demanda, ao contrario de produto.
 *
 * A diferenca e deliberada. Produto errado estraga estoque, demanda e compra —
 * o cadastro tem de ser deliberado. Cliente so serve para analisar de onde vem
 * a venda; nao ter o cliente faria perder a venda inteira, o que e pior.
 */
async function resolverCliente(
  cliente: PoolClient, dados: Record<string, unknown>,
): Promise<number | null> {
  const codigo = txt(dados['cliente.codigo_externo']);
  if (!codigo) return null;

  const { rows } = await cliente.query<{ id: string }>(`
    INSERT INTO clientes (codigo_externo, nome, cidade, estado, canal, ativo)
    VALUES ($1, $2, $3, $4, $5, true)
    ON CONFLICT (codigo_externo) DO UPDATE
      SET nome = coalesce(EXCLUDED.nome, clientes.nome),
          cidade = coalesce(EXCLUDED.cidade, clientes.cidade),
          estado = coalesce(EXCLUDED.estado, clientes.estado)
    RETURNING id`,
  [codigo, txt(dados['cliente.nome']) ?? `Cliente ${codigo}`,
    txt(dados['cliente.cidade']), txt(dados['cliente.estado']),
    txt(dados['venda.canal'])]);

  return Number(rows[0]!.id);
}

// ===========================================================================
// PRODUTOS
// ===========================================================================

const gravarProdutos = async (
  lote: Linha[], contexto: ContextoSessao, _estado: EstadoImportacao,
): Promise<Saida> => {
  const saida: Saida = {
    criados: 0, atualizados: 0, descartados: 0, rejeitados: 0, motivos: new Map(),
  };

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    for (const { dados } of lote) {
      const codigo = txt(dados['produto.codigo']);
      const descricao = txt(dados['produto.descricao']);

      if (!codigo) {
        saida.rejeitados += 1;
        conta(saida.motivos, 'produto sem codigo');
        continue;
      }
      if (!descricao) {
        saida.rejeitados += 1;
        conta(saida.motivos, 'produto sem descricao');
        continue;
      }

      // Categoria e unidade sao obrigatorias no cadastro. Quando o arquivo nao
      // traz, usa-se a primeira ativa — e o alerta fica no relatorio.
      const { rows: categoria } = await cliente.query<{ id: string }>(
        `SELECT id FROM categorias WHERE ativo
          AND ($1::text IS NULL OR upper(nome) = upper($1)) ORDER BY id LIMIT 1`,
        [txt(dados['produto.categoria'])]);
      // A coluna da unidade e `codigo` ("KG", "CX"), nao `sigla`. O nome errado
      // derrubava toda importacao de produto na primeira linha.
      const { rows: unidade } = await cliente.query<{ id: string }>(
        `SELECT id FROM unidades
          WHERE ($1::text IS NULL OR upper(codigo) = upper($1)) ORDER BY id LIMIT 1`,
        [txt(dados['produto.unidade'])]);

      if (!categoria.length || !unidade.length) {
        saida.rejeitados += 1;
        conta(saida.motivos, 'sem categoria ou unidade cadastrada');
        continue;
      }

      // O indice unico de produtos e por EXPRESSAO e PARCIAL: uq_produtos_codigo
      // sobre (upper(codigo)) WHERE deleted_at IS NULL. Um ON CONFLICT (codigo)
      // simples nao casa com ele e o Postgres recusa a instrucao inteira.
      const { rows } = await cliente.query<{ id: string; inserido: boolean }>(`
        INSERT INTO produtos
          (codigo, descricao, ean, categoria_id, unidade_compra_id,
           unidade_estoque_id, unidade_venda_id, fator_conversao, ativo)
        VALUES ($1, $2, $3, $4, $5, $5, $5, 1, true)
        ON CONFLICT (upper(codigo)) WHERE deleted_at IS NULL DO UPDATE
          SET descricao = EXCLUDED.descricao,
              ean = coalesce(EXCLUDED.ean, produtos.ean),
              updated_at = now()
        RETURNING id, (xmax = 0) AS inserido`,
      [codigo, descricao, txt(dados['produto.ean']),
        Number(categoria[0]!.id), Number(unidade[0]!.id)]);

      if (rows[0]!.inserido) saida.criados += 1; else saida.atualizados += 1;
    }

    await cliente.query('COMMIT');
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }

  return saida;
};

// ===========================================================================
// FORNECEDORES
// ===========================================================================

const gravarFornecedores = async (
  lote: Linha[], contexto: ContextoSessao, _estado: EstadoImportacao,
): Promise<Saida> => {
  const saida: Saida = {
    criados: 0, atualizados: 0, descartados: 0, rejeitados: 0, motivos: new Map(),
  };

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    for (const { dados } of lote) {
      const cnpj = txt(dados['fornecedor.cnpj']);
      const nome = txt(dados['fornecedor.nome']);

      if (!nome) {
        saida.rejeitados += 1;
        conta(saida.motivos, 'fornecedor sem razao social');
        continue;
      }

      // Sem CNPJ nao ha chave natural confiavel: cadastrar assim produziria
      // duplicata na proxima importacao, que e exatamente o que a secao 28
      // proibe.
      if (!cnpj) {
        saida.rejeitados += 1;
        conta(saida.motivos, 'fornecedor sem CNPJ (chave natural ausente)');
        continue;
      }

      const { rows: existente } = await cliente.query<{ id: string }>(
        'SELECT id FROM fornecedores WHERE cnpj = $1 AND deleted_at IS NULL', [cnpj]);

      if (existente.length) {
        await cliente.query(`
          UPDATE fornecedores
             SET razao_social = $2,
                 nome_fantasia = coalesce($3, nome_fantasia),
                 cidade = coalesce($4, cidade),
                 estado = coalesce($5, estado),
                 email = coalesce($6, email),
                 telefone = coalesce($7, telefone),
                 updated_at = now()
           WHERE id = $1`,
        [Number(existente[0]!.id), nome, txt(dados['fornecedor.nome_fantasia']),
          txt(dados['fornecedor.cidade']), txt(dados['fornecedor.estado']),
          txt(dados['fornecedor.email']), txt(dados['fornecedor.telefone'])]);
        saida.atualizados += 1;
      } else {
        await cliente.query(`
          INSERT INTO fornecedores
            (razao_social, nome_fantasia, cnpj, cidade, estado, email, telefone, ativo)
          VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
        [nome, txt(dados['fornecedor.nome_fantasia']) ?? nome, cnpj,
          txt(dados['fornecedor.cidade']), txt(dados['fornecedor.estado']),
          txt(dados['fornecedor.email']), txt(dados['fornecedor.telefone'])]);
        saida.criados += 1;
      }
    }

    await cliente.query('COMMIT');
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }

  return saida;
};

// ===========================================================================
// PRODUTO x FORNECEDOR — a tabela de precos que o fornecedor manda
// ===========================================================================

const gravarPrecos = async (
  lote: Linha[], contexto: ContextoSessao, _estado: EstadoImportacao,
): Promise<Saida> => {
  const saida: Saida = {
    criados: 0, atualizados: 0, descartados: 0, rejeitados: 0, motivos: new Map(),
  };

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    if (contexto.usuarioId) {
      await cliente.query('SELECT set_config($1, $2, true)',
        ['app.usuario_id', String(contexto.usuarioId)]);
    }

    for (const { dados } of lote) {
      const codigoProduto = txt(dados['produto.codigo']);
      const cnpj = txt(dados['fornecedor.cnpj']);
      const preco = num(dados['produto_fornecedor.preco']);

      if (!codigoProduto || !cnpj) {
        saida.rejeitados += 1;
        conta(saida.motivos, 'linha sem produto ou sem fornecedor');
        continue;
      }
      if (preco === null || preco <= 0) {
        saida.rejeitados += 1;
        conta(saida.motivos, 'preco ausente, zero ou negativo');
        continue;
      }

      const { rows: prod } = await cliente.query<{ id: string }>(
        'SELECT id FROM produtos WHERE codigo = $1 AND deleted_at IS NULL',
        [codigoProduto]);
      const { rows: forn } = await cliente.query<{ id: string }>(
        'SELECT id FROM fornecedores WHERE cnpj = $1 AND deleted_at IS NULL AND deleted_at IS NULL', [cnpj]);

      if (!prod.length) {
        saida.rejeitados += 1;
        conta(saida.motivos, `produto nao cadastrado (ex.: ${codigoProduto})`);
        continue;
      }
      if (!forn.length) {
        saida.rejeitados += 1;
        conta(saida.motivos, `fornecedor nao cadastrado (ex.: ${cnpj})`);
        continue;
      }

      // `preco_anterior` guarda o valor de antes: e o que o modulo 12 usa para
      // detectar aumento anormal. Sobrescrever sem guardar apagaria a serie.
      const { rows } = await cliente.query<{ id: string; inserido: boolean }>(`
        INSERT INTO produto_fornecedor
          (produto_id, fornecedor_id, preco_atual, moq, multiplo_compra,
           lead_time_dias, ativo)
        VALUES ($1, $2, $3, coalesce($4, 1), coalesce($5, 1), coalesce($6, 7), true)
        ON CONFLICT (produto_id, fornecedor_id) DO UPDATE
          SET preco_anterior = produto_fornecedor.preco_atual,
              preco_atual = EXCLUDED.preco_atual,
              moq = coalesce(EXCLUDED.moq, produto_fornecedor.moq),
              multiplo_compra = coalesce(EXCLUDED.multiplo_compra,
                                         produto_fornecedor.multiplo_compra),
              lead_time_dias = coalesce(EXCLUDED.lead_time_dias,
                                        produto_fornecedor.lead_time_dias),
              ativo = true,
              updated_at = now()
        RETURNING id, (xmax = 0) AS inserido`,
      [Number(prod[0]!.id), Number(forn[0]!.id), preco,
        num(dados['produto_fornecedor.moq']),
        num(dados['produto_fornecedor.multiplo']),
        num(dados['produto_fornecedor.lead_time'])]);

      if (rows[0]!.inserido) saida.criados += 1; else saida.atualizados += 1;
    }

    await cliente.query('COMMIT');
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }

  return saida;
};

// ===========================================================================
// ESTOQUE — o saldo do ERP (Rel 9054)
// ===========================================================================

const LOCAL_ERP = 'ERP';
const CATEGORIA_A_CLASSIFICAR = 'A CLASSIFICAR (ERP)';

interface EntradaEstoque {
  fisico: number;
  reservado: number;
  descricao: string | null;
  ean: string | null;
  unidade: string | null;
  ativo: boolean;
}

/** Chave para casar codigo numerico com ou sem zeros a esquerda. */
const chaveNumerica = (codigo: string): string | null =>
  /^\d+$/.test(codigo) ? codigo.replace(/^0+(?=\d)/, '') : null;

const arredondar = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Resolve codigos do ERP para produtos.
 *
 * O ERP exporta o codigo como texto com zeros a esquerda ("00005", "01043"),
 * tanto no Rel 9054 quanto no Rel 7104, e e assim que o cadastro guarda. Uma
 * planilha que passou pelo Excel pode trazer o mesmo codigo como numero ("5").
 * O codigo exato vence; na falta dele, casa ignorando os zeros - nunca cria um
 * segundo produto "5" ao lado do "00005".
 */
async function resolverProdutos(
  cliente: PoolClient, codigos: string[],
): Promise<Map<string, number>> {
  const { rows } = await cliente.query<{ id: number; codigo: string }>(
    'SELECT id, upper(codigo) AS codigo FROM produtos WHERE deleted_at IS NULL');

  const exato = new Map<string, number>();
  const numerico = new Map<string, number>();
  for (const r of rows) {
    exato.set(r.codigo, Number(r.id));
    const chave = chaveNumerica(r.codigo);
    if (chave !== null && !numerico.has(chave)) numerico.set(chave, Number(r.id));
  }

  const resolvidos = new Map<string, number>();
  for (const codigo of codigos) {
    const chave = chaveNumerica(codigo);
    const id = exato.get(codigo) ?? (chave !== null ? numerico.get(chave) : undefined);
    if (id !== undefined) resolvidos.set(codigo, id);
  }
  return resolvidos;
}

/**
 * O ERP e a fonte da verdade do saldo, mas a razao de estoque e somente
 * insercao: o saldo nunca e sobrescrito. A diferenca entre o que o ERP diz e o
 * que o sistema tem vira uma movimentacao INVENTARIO, e a trigger da razao
 * atualiza `estoques`. Reimportar o mesmo arquivo nao gera movimento.
 *
 * Escrita em conjunto (unnest), nao linha a linha: o relatorio tem ~4.500
 * produtos e a funcao da Vercel tem 60 segundos.
 *
 * Excecao deliberada a regra 2 do topo do arquivo: o Rel 9054 e a lista de
 * produtos do proprio ERP, nao uma referencia digitada. Produto que ainda nao
 * vendeu e cadastrado aqui (categoria "A CLASSIFICAR"), para que a primeira
 * venda ja o encontre.
 */
const gravarEstoque = async (
  lote: Linha[], contexto: ContextoSessao, _estado: EstadoImportacao,
): Promise<Saida> => {
  const saida: Saida = {
    criados: 0, atualizados: 0, descartados: 0, rejeitados: 0, motivos: new Map(),
  };

  const entradas = new Map<string, EntradaEstoque>();
  for (const { dados } of lote) {
    const codigo = txt(dados['produto.codigo'])?.toUpperCase();
    if (!codigo) {
      saida.rejeitados += 1;
      conta(saida.motivos, 'linha sem codigo de produto');
      continue;
    }
    const fisico = num(dados['estoque.quantidade_fisica']);
    if (fisico === null) {
      saida.rejeitados += 1;
      conta(saida.motivos, 'saldo (QTDE) ausente ou invalido');
      continue;
    }
    if (fisico < 0) conta(saida.motivos, 'saldo negativo no ERP gravado como zero');

    // A planilha de gestao faz QTDE - |QTDEVENDIDA|: o sinal nao importa.
    const situacao = txt(dados['produto.situacao']);
    entradas.set(codigo, {
      fisico: arredondar(Math.max(fisico, 0)),
      reservado: arredondar(Math.abs(num(dados['estoque.quantidade_reservada']) ?? 0)),
      descricao: txt(dados['produto.descricao']),
      ean: txt(dados['produto.ean']),
      unidade: txt(dados['produto.unidade'])?.toUpperCase() ?? null,
      ativo: situacao === null || situacao.toUpperCase() === 'ATIVO',
    });
  }

  if (!entradas.size) return saida;

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    if (contexto.usuarioId) {
      await cliente.query('SELECT set_config($1, $2, true)',
        ['app.usuario_id', String(contexto.usuarioId)]);
    }

    const { rows: local } = await cliente.query<{ id: string }>(
      'SELECT id FROM locais WHERE upper(codigo) = $1 AND ativo', [LOCAL_ERP]);
    if (!local.length) {
      throw new Error(
        `Local de estoque "${LOCAL_ERP}" nao cadastrado. Aplique a migration 058 `
        + '(npm run db:migrate).');
    }
    const localId = Number(local[0]!.id);

    const codigos = [...entradas.keys()];
    const produtos = await resolverProdutos(cliente, codigos);
    const faltando = codigos.filter((c) => !produtos.has(c));
    if (faltando.length) {
      const novos = await cadastrarProdutosDoErp(cliente, faltando, entradas);
      for (const [codigo, id] of novos) produtos.set(codigo, id);
      if (novos.size) {
        conta(saida.motivos,
          `produto cadastrado a partir do ERP (categoria ${CATEGORIA_A_CLASSIFICAR})`, novos.size);
      }
    }

    const { rows: saldos } = await cliente.query<{
      produto_id: number; fisico: number; reservado: number;
    }>(`
      SELECT produto_id, quantidade_fisica AS fisico, quantidade_reservada AS reservado
        FROM estoques WHERE local_id = $1 AND produto_id = ANY($2::bigint[])`,
    [localId, [...new Set(produtos.values())]]);
    const saldoAtual = new Map(saldos.map((s) => [Number(s.produto_id), s]));

    const movProdutos: number[] = [];
    const movQuantidades: number[] = [];
    const resProdutos: number[] = [];
    const resQuantidades: number[] = [];

    for (const [codigo, e] of entradas) {
      const produtoId = produtos.get(codigo);
      if (produtoId === undefined) {
        saida.rejeitados += 1;
        conta(saida.motivos, 'produto nao pode ser cadastrado');
        continue;
      }

      const atual = saldoAtual.get(produtoId);
      const semSaldo = e.fisico === 0 && e.reservado === 0;
      const diferenca = arredondar(e.fisico - Number(atual?.fisico ?? 0));
      const reservaMudou = e.reservado !== Number(atual?.reservado ?? 0);

      if (!atual && semSaldo) {
        saida.descartados += 1;
        conta(saida.motivos, 'sem saldo no ERP');
        continue;
      }
      if (atual && diferenca === 0 && !reservaMudou) {
        saida.descartados += 1;
        conta(saida.motivos, 'saldo igual ao ja registrado');
        continue;
      }

      if (diferenca !== 0) {
        movProdutos.push(produtoId);
        movQuantidades.push(diferenca);
      }
      resProdutos.push(produtoId);
      resQuantidades.push(e.reservado);
      if (atual) saida.atualizados += 1; else saida.criados += 1;
    }

    if (movProdutos.length) {
      await cliente.query(`
        INSERT INTO movimentacoes_estoque
          (produto_id, local_id, tipo_movimentacao, quantidade, documento_tipo,
           observacao, usuario_id)
        SELECT m.produto_id, $3, 'INVENTARIO', m.quantidade, 'INVENTARIO',
               'Carga de saldo do ERP (Rel 9054)', $4
          FROM unnest($1::bigint[], $2::numeric[]) AS m(produto_id, quantidade)`,
      [movProdutos, movQuantidades, localId, contexto.usuarioId ?? null]);
    }

    if (resProdutos.length) {
      await cliente.query(`
        INSERT INTO estoques (produto_id, local_id, quantidade_reservada)
        SELECT r.produto_id, $3, r.reservado
          FROM unnest($1::bigint[], $2::numeric[]) AS r(produto_id, reservado)
        ON CONFLICT (produto_id, local_id) DO UPDATE
          SET quantidade_reservada = EXCLUDED.quantidade_reservada,
              updated_at = now()`,
      [resProdutos, resQuantidades, localId]);
    }

    await cliente.query('COMMIT');
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }

  return saida;
};

/**
 * Cadastra os produtos que ainda nao existem, com o codigo exatamente como o
 * ERP exporta. Devolve codigo -> id dos criados.
 *
 * EAN e opcional: invalido, repetido no lote ou ja usado por outro produto
 * fica de fora, porque `uq_produtos_ean` derrubaria a transacao inteira.
 */
async function cadastrarProdutosDoErp(
  cliente: PoolClient, faltando: string[], entradas: Map<string, EntradaEstoque>,
): Promise<Map<string, number>> {
  const { rows: categoria } = await cliente.query<{ id: string }>(
    'SELECT id FROM categorias WHERE nome = $1', [CATEGORIA_A_CLASSIFICAR]);
  if (!categoria.length) {
    throw new Error(
      `Categoria "${CATEGORIA_A_CLASSIFICAR}" nao cadastrada. Aplique a migration 059 `
      + '(npm run db:migrate).');
  }

  const { rows: unidades } = await cliente.query<{ id: string; codigo: string }>(
    'SELECT id, upper(codigo) AS codigo FROM unidades');
  const unidadePorCodigo = new Map(unidades.map((u) => [u.codigo, Number(u.id)]));
  const unidadePadrao = unidadePorCodigo.get('UN');
  if (unidadePadrao === undefined) throw new Error('Unidade "UN" nao cadastrada');

  const codigos: string[] = [];
  const descricoes: string[] = [];
  const eans: Array<string | null> = [];
  const unidadesIds: number[] = [];
  const ativos: boolean[] = [];
  const eansNoLote = new Set<string>();

  for (const codigo of faltando) {
    const e = entradas.get(codigo)!;
    let ean = e.ean && /^[0-9]{8,14}$/.test(e.ean) ? e.ean : null;
    if (ean && eansNoLote.has(ean)) ean = null;
    if (ean) eansNoLote.add(ean);

    codigos.push(codigo);
    descricoes.push(e.descricao ?? `Produto ${codigo} (ERP)`);
    eans.push(ean);
    unidadesIds.push(unidadePorCodigo.get(e.unidade ?? '') ?? unidadePadrao);
    ativos.push(e.ativo);
  }

  const { rows } = await cliente.query<{ id: number; codigo: string }>(`
    INSERT INTO produtos
      (codigo, descricao, ean, categoria_id, unidade_compra_id, unidade_estoque_id,
       unidade_venda_id, fator_conversao, ativo)
    SELECT n.codigo, n.descricao,
           CASE WHEN n.ean IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM produtos x WHERE x.ean = n.ean AND x.deleted_at IS NULL)
                THEN n.ean END,
           $6, n.unidade, n.unidade, n.unidade, 1, n.ativo
      FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::boolean[])
           AS n(codigo, descricao, ean, unidade, ativo)
    ON CONFLICT (upper(codigo)) WHERE deleted_at IS NULL DO NOTHING
    RETURNING id, upper(codigo) AS codigo`,
  [codigos, descricoes, eans, unidadesIds, ativos, Number(categoria[0]!.id)]);

  return new Map(rows.map((r) => [r.codigo, Number(r.id)]));
}

// ===========================================================================
// Registro
// ===========================================================================

registrarGravador('vendas', gravarVendas);
registrarGravador('produtos', gravarProdutos);
registrarGravador('fornecedores', gravarFornecedores);
registrarGravador('produto_fornecedor', gravarPrecos);
registrarGravador('estoque', gravarEstoque);

export { gravarVendas, gravarProdutos, gravarFornecedores, gravarPrecos, gravarEstoque };
