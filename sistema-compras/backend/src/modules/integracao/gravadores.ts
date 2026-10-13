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
 * DEVOLUCOES SAO DESCARTADAS, por decisao do usuario (28/09/2026). A base tem
 * 1.985 devolucoes importadas antes dessa decisao, e `mv_demanda_diaria`
 * subtrai a quantidade delas: a demanda fica liquida de devolucao no periodo
 * antigo e bruta no novo. O descarte e contado, nunca silencioso.
 *
 * DESEMPENHO: um lote de 20 mil linhas e gravado com um numero FIXO de
 * consultas (unnest), nao com cinco por item. A versao linha a linha levava
 * minutos por lote e estourava o limite de 60 s da funcao da Vercel.
 *
 * ITENS DE NOTA JA EXISTENTE sao regravados inteiros (o relatorio nao tem
 * numero de item para casar um a um). A limpeza acontece UMA vez por nota por
 * importacao: a venda guarda `ultima_importacao_id`, e uma nota dividida entre
 * dois lotes so e limpa no primeiro. Antes isso dependia de um Set em memoria
 * que nao sobrevivia entre as requisicoes do navegador.
 *
 * Produto que nao existe e cadastrado (categoria = SUBGRUPO), como fazia o ETL
 * que montou a base: perder a venda por falta de cadastro e pior do que ter o
 * produto para classificar depois.
 */
interface ItemVenda {
  produto: string; descricao: string | null; subgrupo: string | null;
  quantidade: number; valor: number; preco: number;
}

interface DocumentoVenda {
  chave: string; data: string; cliente: string | null; clienteNome: string | null;
  cidade: string | null; estado: string | null; canal: string | null;
  itens: ItemVenda[];
}

const gravarVendas = async (
  lote: Linha[], contexto: ContextoSessao, estado: EstadoImportacao,
): Promise<Saida> => {
  const importacaoId = Number(estado.get('importacao_id')) || null;
  const saida: Saida = {
    criados: 0, atualizados: 0, descartados: 0, rejeitados: 0, motivos: new Map(),
  };

  const documentos = new Map<string, DocumentoVenda>();
  for (const { dados: d } of lote) {
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

    const produto = txt(d['produto.codigo'])?.toUpperCase();
    if (!produto) {
      saida.rejeitados += 1;
      conta(saida.motivos, 'item sem codigo de produto');
      continue;
    }

    const quantidade = num(d['item.quantidade']) ?? 0;
    if (quantidade <= 0) {
      saida.rejeitados += 1;
      conta(saida.motivos, 'quantidade zero ou negativa');
      continue;
    }
    const valor = num(d['item.valor_total']) ?? 0;

    const chave = `${numero}/${cliente ?? '0'}/${data.replace(/-/g, '')}`;
    let doc = documentos.get(chave);
    if (!doc) {
      doc = {
        chave, data, cliente,
        clienteNome: txt(d['cliente.nome']), cidade: txt(d['cliente.cidade']),
        estado: txt(d['cliente.estado']), canal: txt(d['venda.canal']), itens: [],
      };
      documentos.set(chave, doc);
    }
    doc.itens.push({
      produto, quantidade, valor,
      preco: num(d['item.preco_unitario']) ?? valor / quantidade,
      descricao: txt(d['produto.descricao']),
      subgrupo: txt(d['produto.subcategoria']),
    });
  }

  if (!documentos.size) return saida;

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    if (contexto.usuarioId) {
      await cliente.query('SELECT set_config($1, $2, true)',
        ['app.usuario_id', String(contexto.usuarioId)]);
    }

    // --- Produtos: resolve todos de uma vez; cadastra os que faltam -------
    const primeiroItem = new Map<string, ItemVenda>();
    for (const doc of documentos.values()) {
      for (const item of doc.itens) if (!primeiroItem.has(item.produto)) primeiroItem.set(item.produto, item);
    }
    const codigos = [...primeiroItem.keys()];
    const produtos = await resolverProdutos(cliente, codigos);
    const faltando = codigos.filter((c) => !produtos.has(c));
    if (faltando.length) {
      const novos = await cadastrarProdutos(cliente, faltando.map((c) => {
        const item = primeiroItem.get(c)!;
        return {
          codigo: c, descricao: item.descricao, ean: null, unidade: null,
          ativo: true, categoria: item.subgrupo,
        };
      }));
      for (const [codigo, id] of novos) produtos.set(codigo, id);
      if (novos.size) conta(saida.motivos, 'produto cadastrado a partir da venda', novos.size);
    }

    // --- Clientes: um upsert para o lote todo ----------------------------
    const clientes = await gravarClientes(cliente, documentos);

    // --- Notas que ja existiam e ainda nao foram limpas nesta importacao --
    const chaves = [...documentos.keys()];
    const { rows: existentes } = await cliente.query<{
      id: number; numero_documento: string; ultima_importacao_id: number | null;
    }>(`
      SELECT id, numero_documento, ultima_importacao_id
        FROM vendas WHERE numero_documento = ANY($1::text[])`, [chaves]);
    const jaTocadas = new Set<string>();
    const limpar: number[] = [];
    for (const e of existentes) {
      if (importacaoId !== null && Number(e.ultima_importacao_id) === importacaoId) {
        jaTocadas.add(e.numero_documento);
      } else {
        limpar.push(Number(e.id));
      }
    }
    if (limpar.length) {
      await cliente.query('DELETE FROM itens_venda WHERE venda_id = ANY($1::bigint[])', [limpar]);
    }

    // --- Vendas: um upsert para o lote todo ------------------------------
    const docs = [...documentos.values()];
    const { rows: vendas } = await cliente.query<{
      id: number; numero_documento: string; inserido: boolean;
    }>(`
      INSERT INTO vendas
        (numero_documento, data_venda, cliente_id, canal, valor_total, status,
         tipo_documento, origem_integracao, ultima_importacao_id)
      SELECT v.chave, v.data::date, v.cliente_id, v.canal, 0, 'FATURADA',
             'VENDA'::tipo_documento_venda_enum, 'ERP:REL7104', $5
        FROM unnest($1::text[], $2::text[], $3::bigint[], $4::text[])
             AS v(chave, data, cliente_id, canal)
      ON CONFLICT (numero_documento) DO UPDATE
        SET data_venda = EXCLUDED.data_venda,
            cliente_id = coalesce(EXCLUDED.cliente_id, vendas.cliente_id),
            ultima_importacao_id = EXCLUDED.ultima_importacao_id,
            updated_at = now()
      RETURNING id, numero_documento, (xmax = 0) AS inserido`,
    [docs.map((d) => d.chave), docs.map((d) => d.data),
      docs.map((d) => (d.cliente ? clientes.get(d.cliente) ?? null : null)),
      docs.map((d) => d.canal), importacaoId]);

    const vendaPorChave = new Map<string, number>();
    for (const v of vendas) {
      vendaPorChave.set(v.numero_documento, Number(v.id));
      if (v.inserido) saida.criados += 1;
      else if (!jaTocadas.has(v.numero_documento)) saida.atualizados += 1;
    }

    // --- Itens: um insert para o lote todo -------------------------------
    const itVenda: number[] = [];
    const itProduto: number[] = [];
    const itQtd: number[] = [];
    const itPreco: number[] = [];
    const itValor: number[] = [];
    for (const doc of docs) {
      const vendaId = vendaPorChave.get(doc.chave)!;
      for (const item of doc.itens) {
        const produtoId = produtos.get(item.produto);
        if (produtoId === undefined) {
          saida.rejeitados += 1;
          conta(saida.motivos, 'produto nao pode ser cadastrado');
          continue;
        }
        itVenda.push(vendaId);
        itProduto.push(produtoId);
        itQtd.push(item.quantidade);
        itPreco.push(item.preco);
        itValor.push(item.valor);
      }
    }

    if (itVenda.length) {
      await cliente.query(`
        INSERT INTO itens_venda
          (venda_id, produto_id, quantidade, preco_unitario, desconto, valor_total)
        SELECT i.venda_id, i.produto_id, i.quantidade, i.preco, 0, i.valor
          FROM unnest($1::bigint[], $2::bigint[], $3::numeric[], $4::numeric[], $5::numeric[])
               AS i(venda_id, produto_id, quantidade, preco, valor)`,
      [itVenda, itProduto, itQtd, itPreco, itValor]);
    }

    // O total sai dos itens gravados, inclusive os de lotes anteriores.
    await cliente.query(`
      UPDATE vendas v SET valor_total = s.total
        FROM (SELECT venda_id, sum(valor_total) AS total
                FROM itens_venda WHERE venda_id = ANY($1::bigint[])
               GROUP BY venda_id) s
       WHERE v.id = s.venda_id`, [[...vendaPorChave.values()]]);

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
 * Cliente: cadastrado sob demanda. So serve para analisar de onde vem a venda;
 * nao ter o cliente faria perder a venda inteira, o que e pior.
 */
async function gravarClientes(
  cliente: PoolClient, documentos: Map<string, DocumentoVenda>,
): Promise<Map<string, number>> {
  const porCodigo = new Map<string, DocumentoVenda>();
  for (const doc of documentos.values()) {
    if (doc.cliente && !porCodigo.has(doc.cliente)) porCodigo.set(doc.cliente, doc);
  }
  if (!porCodigo.size) return new Map();

  const lista = [...porCodigo.values()];
  const { rows } = await cliente.query<{ id: number; codigo_externo: string }>(`
    INSERT INTO clientes (codigo_externo, nome, cidade, estado, canal, ativo)
    SELECT c.codigo, coalesce(c.nome, 'Cliente ' || c.codigo), c.cidade, c.estado, c.canal, true
      FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
           AS c(codigo, nome, cidade, estado, canal)
    ON CONFLICT (codigo_externo) DO UPDATE
      SET nome = coalesce(EXCLUDED.nome, clientes.nome),
          cidade = coalesce(EXCLUDED.cidade, clientes.cidade),
          estado = coalesce(EXCLUDED.estado, clientes.estado)
    RETURNING id, codigo_externo`,
  [lista.map((d) => d.cliente), lista.map((d) => d.clienteNome), lista.map((d) => d.cidade),
    lista.map((d) => d.estado), lista.map((d) => d.canal)]);

  return new Map(rows.map((r) => [r.codigo_externo, Number(r.id)]));
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
      const novos = await cadastrarProdutos(cliente, faltando.map((c) => {
        const e = entradas.get(c)!;
        return {
          codigo: c, descricao: e.descricao, ean: e.ean, unidade: e.unidade,
          ativo: e.ativo, categoria: null,
        };
      }));
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

interface NovoProduto {
  codigo: string; descricao: string | null; ean: string | null;
  unidade: string | null; ativo: boolean;
  /** Nome da categoria (SUBGRUPO do ERP); sem ela, "A CLASSIFICAR (ERP)". */
  categoria: string | null;
}

/**
 * Cadastra produtos com o codigo exatamente como o ERP exporta. Devolve
 * codigo -> id dos criados.
 *
 * A categoria e o SUBGRUPO do ERP, criada se ainda nao existe - a mesma
 * convencao do ETL que montou a base. EAN invalido, repetido no lote ou ja
 * usado por outro produto fica de fora, porque `uq_produtos_ean` derrubaria a
 * transacao inteira.
 */
async function cadastrarProdutos(
  cliente: PoolClient, novos: NovoProduto[],
): Promise<Map<string, number>> {
  const nomesCategoria = [...new Set(novos.map((n) => n.categoria ?? CATEGORIA_A_CLASSIFICAR))];
  await cliente.query(`
    INSERT INTO categorias (nome, descricao, ativo)
    SELECT n, 'Importado do ERP (SUBGRUPO)', true FROM unnest($1::text[]) AS n
    ON CONFLICT (nome) DO NOTHING`, [nomesCategoria]);
  const { rows: categorias } = await cliente.query<{ id: number; nome: string }>(
    'SELECT id, nome FROM categorias WHERE nome = ANY($1::text[])', [nomesCategoria]);
  const categoriaPorNome = new Map(categorias.map((c) => [c.nome, Number(c.id)]));

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
  const categoriasIds: number[] = [];
  const eansNoLote = new Set<string>();

  for (const n of novos) {
    let ean = n.ean && /^[0-9]{8,14}$/.test(n.ean) ? n.ean : null;
    if (ean && eansNoLote.has(ean)) ean = null;
    if (ean) eansNoLote.add(ean);

    codigos.push(n.codigo);
    descricoes.push(n.descricao ?? `Produto ${n.codigo} (ERP)`);
    eans.push(ean);
    unidadesIds.push(unidadePorCodigo.get(n.unidade ?? '') ?? unidadePadrao);
    ativos.push(n.ativo);
    categoriasIds.push(categoriaPorNome.get(n.categoria ?? CATEGORIA_A_CLASSIFICAR)!);
  }

  const { rows } = await cliente.query<{ id: number; codigo: string }>(`
    INSERT INTO produtos
      (codigo, descricao, ean, categoria_id, unidade_compra_id, unidade_estoque_id,
       unidade_venda_id, fator_conversao, ativo)
    SELECT n.codigo, n.descricao,
           CASE WHEN n.ean IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM produtos x WHERE x.ean = n.ean AND x.deleted_at IS NULL)
                THEN n.ean END,
           n.categoria, n.unidade, n.unidade, n.unidade, 1, n.ativo
      FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::boolean[], $6::bigint[])
           AS n(codigo, descricao, ean, unidade, ativo, categoria)
    ON CONFLICT (upper(codigo)) WHERE deleted_at IS NULL DO NOTHING
    RETURNING id, upper(codigo) AS codigo`,
  [codigos, descricoes, eans, unidadesIds, ativos, categoriasIds]);

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
