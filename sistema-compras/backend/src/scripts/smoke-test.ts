/**
 * Teste de fumaca da Etapa 01.
 * Sobe nada: espera a API rodando em BASE_URL. Exercita autenticacao,
 * autorizacao, CRUD, constraints, triggers e auditoria de ponta a ponta.
 *
 *   npm run dev          (em um terminal)
 *   npm run test:smoke   (em outro)
 */
import { pool, encerrarPool } from '../config/database.js';
import { env } from '../config/env.js';

const BASE = process.env.BASE_URL ?? `http://localhost:${env.PORT}`;

let passou = 0;
let falhou = 0;
const falhas: string[] = [];

function checar(descricao: string, condicao: boolean, detalhe?: unknown) {
  if (condicao) {
    passou++;
    console.log(`  ok   ${descricao}`);
  } else {
    falhou++;
    falhas.push(descricao);
    console.log(`  FALHOU  ${descricao}${detalhe ? ` -> ${JSON.stringify(detalhe)}` : ''}`);
  }
}

interface Resposta { status: number; corpo: any }

async function chamar(metodo: string, caminho: string, opcoes: { token?: string; corpo?: unknown } = {}): Promise<Resposta> {
  const resposta = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(opcoes.token ? { Authorization: `Bearer ${opcoes.token}` } : {}),
    },
    body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
  });
  return { status: resposta.status, corpo: await resposta.json().catch(() => null) };
}

async function executar() {
  console.log(`\nTestando ${BASE}\n`);

  // ---------------------------------------------------------------- health --
  console.log('[infra]');
  const health = await chamar('GET', '/health');
  checar('GET /health responde 200 com banco ok', health.status === 200 && health.corpo?.data?.banco === 'ok');

  // ------------------------------------------------------------ autenticacao --
  console.log('\n[autenticacao]');
  const semToken = await chamar('GET', '/api/produtos');
  checar('rota protegida sem token retorna 401', semToken.status === 401, semToken.corpo);

  const senhaErrada = await chamar('POST', '/api/auth/login', {
    corpo: { email: env.SEED_ADMIN_EMAIL, senha: 'senha-errada' },
  });
  checar('login com senha incorreta retorna 401', senhaErrada.status === 401);

  const login = await chamar('POST', '/api/auth/login', {
    corpo: { email: env.SEED_ADMIN_EMAIL, senha: env.SEED_ADMIN_SENHA },
  });
  checar('login do administrador retorna token', login.status === 200 && !!login.corpo?.data?.token, login.corpo?.error);
  const token: string = login.corpo?.data?.token;

  checar('senha nunca volta na resposta do login', !JSON.stringify(login.corpo).includes('senha_hash'));

  const eu = await chamar('GET', '/api/auth/eu', { token });
  checar('GET /api/auth/eu devolve perfil e permissoes',
    eu.status === 200 && eu.corpo?.data?.perfil === 'ADMIN' && eu.corpo?.data?.permissoes?.length > 0);

  const tokenInvalido = await chamar('GET', '/api/auth/eu', { token: 'token.invalido.aqui' });
  checar('token adulterado e rejeitado', tokenInvalido.status === 401);

  // ------------------------------------------------------------- dashboard --
  console.log('\n[dashboard]');
  const dashboard = await chamar('GET', '/api/dashboard', { token });
  const ind = dashboard.corpo?.data?.indicadores;
  checar('GET /api/dashboard responde 200', dashboard.status === 200);
  checar('indicadores vem do banco (produtos > 0)', Number(ind?.produtos_cadastrados) > 0, ind);
  checar('indicador de produtos criticos calculado',
    ind?.produtos_abaixo_minimo !== undefined && ind?.produtos_em_ruptura !== undefined);

  // -------------------------------------------------------------- produtos --
  console.log('\n[produtos - CRUD e constraints]');
  const cat = await chamar('GET', '/api/cadastros/categorias', { token });
  const categoriaId = cat.corpo?.data?.[0]?.id;
  const un = await chamar('GET', '/api/cadastros/unidades', { token });
  const unidadeId = un.corpo?.data?.find((u: any) => u.codigo === 'KG')?.id;

  const sufixo = Date.now().toString().slice(-6);
  const novoProduto = {
    codigo: `SMK-${sufixo}`,
    descricao: 'Produto de teste automatizado',
    categoria_id: categoriaId,
    unidade_estoque_id: unidadeId,
    estoque_minimo: 100,
    estoque_maximo: 500,
    ponto_pedido: 150,
  };

  const criado = await chamar('POST', '/api/produtos', { token, corpo: novoProduto });
  checar('POST /api/produtos cria produto (201)', criado.status === 201, criado.corpo?.error);
  const produtoId = criado.corpo?.data?.id;

  const obtido = await chamar('GET', `/api/produtos/${produtoId}`, { token });
  checar('GET /api/produtos/:id retorna o produto', obtido.corpo?.data?.codigo === novoProduto.codigo);

  const atualizado = await chamar('PUT', `/api/produtos/${produtoId}`, {
    token, corpo: { descricao: 'Produto de teste automatizado (editado)', estoque_minimo: 120 },
  });
  checar('PUT /api/produtos/:id atualiza', atualizado.corpo?.data?.estoque_minimo === 120, atualizado.corpo?.error);

  const duplicado = await chamar('POST', '/api/produtos', { token, corpo: novoProduto });
  checar('codigo duplicado e bloqueado (409 CONFLICT)',
    duplicado.status === 409 && duplicado.corpo?.error?.code === 'CONFLICT', duplicado.corpo?.error?.code);

  const negativo = await chamar('POST', '/api/produtos', {
    token, corpo: { ...novoProduto, codigo: `SMK-NEG-${sufixo}`, estoque_minimo: -50 },
  });
  checar('estoque_minimo negativo e barrado na validacao (422)', negativo.status === 422);

  const semCategoria = await chamar('POST', '/api/produtos', {
    token, corpo: { codigo: `SMK-X-${sufixo}`, descricao: 'Sem categoria', unidade_estoque_id: unidadeId },
  });
  checar('produto sem categoria e recusado (422)', semCategoria.status === 422);

  const sub = await chamar('GET', '/api/cadastros/subcategorias', { token });
  const subOutraCategoria = sub.corpo?.data?.find((s: any) => s.categoria_id !== categoriaId);
  if (subOutraCategoria) {
    const incoerente = await chamar('POST', '/api/produtos', {
      token,
      corpo: { ...novoProduto, codigo: `SMK-SUB-${sufixo}`, subcategoria_id: subOutraCategoria.id },
    });
    checar('subcategoria de outra categoria e barrada pela trigger (422)',
      incoerente.status === 422, incoerente.corpo?.error?.code);
  }

  const lista = await chamar('GET', '/api/produtos?limite=5&busca=teste', { token });
  checar('GET /api/produtos pagina e filtra',
    lista.status === 200 && Array.isArray(lista.corpo?.data) && lista.corpo?.meta?.limite === 5);

  // ---------------------------------------------------------- fornecedores --
  console.log('\n[fornecedores - CRUD e regras]');
  const semCnpj = await chamar('POST', '/api/fornecedores', {
    token, corpo: { razao_social: 'Fornecedor Nacional Sem CNPJ', origem_fornecedor: 'NACIONAL' },
  });
  checar('fornecedor nacional sem CNPJ e recusado (422)', semCnpj.status === 422);

  const cnpjTeste = `99${sufixo}000199`.slice(0, 14);
  const fornecedorCriado = await chamar('POST', '/api/fornecedores', {
    token,
    corpo: {
      razao_social: 'Fornecedor Smoke Test LTDA', nome_fantasia: 'Smoke Test',
      cnpj: cnpjTeste, origem_fornecedor: 'NACIONAL', tipo_fornecedor: 'DISTRIBUIDOR',
      email: 'contato@smoketest.teste', cidade: 'Sao Paulo', estado: 'SP',
    },
  });
  checar('POST /api/fornecedores cria fornecedor (201)', fornecedorCriado.status === 201, fornecedorCriado.corpo?.error);
  const fornecedorId = fornecedorCriado.corpo?.data?.id;

  const vinculo = await chamar('POST', `/api/fornecedores/${fornecedorId}/produtos`, {
    token, corpo: { produto_id: produtoId, preco_atual: 12.5, fornecedor_principal: true, lead_time_dias: 10 },
  });
  checar('vincula produto ao fornecedor (201)', vinculo.status === 201, vinculo.corpo?.error);

  const historico = await pool.query(
    'SELECT count(*)::int AS total FROM historico_precos WHERE produto_id = $1 AND fornecedor_id = $2',
    [produtoId, fornecedorId],
  );
  checar('trigger registrou historico de preco automaticamente', historico.rows[0].total === 1, historico.rows[0]);

  await chamar('POST', `/api/fornecedores/${fornecedorId}/produtos`, {
    token, corpo: { produto_id: produtoId, preco_atual: 13.9, fornecedor_principal: true },
  });
  const historico2 = await pool.query(
    'SELECT count(*)::int AS total FROM historico_precos WHERE produto_id = $1 AND fornecedor_id = $2',
    [produtoId, fornecedorId],
  );
  checar('alteracao de preco gera nova linha no historico', historico2.rows[0].total === 2, historico2.rows[0]);

  const performance = await chamar('GET', `/api/fornecedores/${fornecedorId}/performance`, { token });
  checar('GET /api/fornecedores/:id/performance responde', performance.status === 200);

  // ---------------------------------------------------------------- estoque --
  console.log('\n[estoque - movimentacao e saldo]');
  const locais = await chamar('GET', '/api/cadastros/locais', { token });
  const localId = locais.corpo?.data?.[0]?.id;

  const entrada = await chamar('POST', '/api/estoque/movimentacoes', {
    token,
    corpo: {
      produto_id: produtoId, local_id: localId, tipo_movimentacao: 'ENTRADA_COMPRA',
      quantidade: 500, custo_unitario: 12.5, documento_tipo: 'RECEBIMENTO',
    },
  });
  checar('entrada de estoque registrada (201)', entrada.status === 201, entrada.corpo?.error);
  checar('saldo fisico atualizado pela trigger', Number(entrada.corpo?.data?.saldo?.quantidade_fisica) === 500,
    entrada.corpo?.data?.saldo);

  const saida = await chamar('POST', '/api/estoque/movimentacoes', {
    token,
    corpo: { produto_id: produtoId, local_id: localId, tipo_movimentacao: 'SAIDA_VENDA', quantidade: 200 },
  });
  checar('saida de estoque atualiza saldo para 300',
    Number(saida.corpo?.data?.saldo?.quantidade_fisica) === 300, saida.corpo?.data?.saldo);

  const estouro = await chamar('POST', '/api/estoque/movimentacoes', {
    token,
    corpo: { produto_id: produtoId, local_id: localId, tipo_movimentacao: 'SAIDA_VENDA', quantidade: 5000 },
  });
  checar('saida maior que o saldo e bloqueada (estoque negativo)',
    estouro.status === 422 && estouro.corpo?.error?.code === 'BUSINESS_RULE', estouro.corpo?.error);

  const saldoAposFalha = await pool.query(
    'SELECT quantidade_fisica FROM estoques WHERE produto_id = $1 AND local_id = $2', [produtoId, localId],
  );
  checar('rollback preservou o saldo anterior (300)', Number(saldoAposFalha.rows[0]?.quantidade_fisica) === 300,
    saldoAposFalha.rows[0]);

  const detalhe = await chamar('GET', `/api/estoque/${produtoId}`, { token });
  checar('GET /api/estoque/:produto_id traz saldo, lotes e movimentacoes',
    detalhe.status === 200 && Array.isArray(detalhe.corpo?.data?.movimentacoes));

  const posicao = await chamar('GET', '/api/estoque?limite=10', { token });
  checar('GET /api/estoque lista a posicao com situacao', posicao.status === 200 && !!posicao.corpo?.data?.[0]?.situacao);

  // ------------------------------------------------------------- permissoes --
  console.log('\n[autorizacao por perfil]');
  const perfis = await chamar('GET', '/api/usuarios/perfis', { token });
  const perfilComercial = perfis.corpo?.data?.find((p: any) => p.nome === 'COMERCIAL');
  checar('perfis carregados com suas permissoes', !!perfilComercial?.permissoes?.length);

  const emailComercial = `comercial.smoke.${sufixo}@empresa.com.br`;
  const usuarioComercial = await chamar('POST', '/api/usuarios', {
    token,
    corpo: { nome: 'Usuario Comercial Teste', email: emailComercial, senha: 'Comercial@123', perfil_id: perfilComercial.id },
  });
  checar('usuario COMERCIAL criado (201)', usuarioComercial.status === 201, usuarioComercial.corpo?.error);

  const loginComercial = await chamar('POST', '/api/auth/login', {
    corpo: { email: emailComercial, senha: 'Comercial@123' },
  });
  const tokenComercial = loginComercial.corpo?.data?.token;
  checar('login do usuario COMERCIAL funciona', loginComercial.status === 200 && !!tokenComercial);

  const leituraComercial = await chamar('GET', '/api/produtos?limite=1', { token: tokenComercial });
  checar('COMERCIAL consegue LER produtos', leituraComercial.status === 200);

  const escritaComercial = await chamar('POST', '/api/produtos', {
    token: tokenComercial, corpo: { ...novoProduto, codigo: `SMK-BLOQ-${sufixo}` },
  });
  checar('COMERCIAL NAO consegue criar produto (403)',
    escritaComercial.status === 403 && escritaComercial.corpo?.error?.code === 'FORBIDDEN', escritaComercial.corpo?.error?.code);

  const usuariosComercial = await chamar('GET', '/api/usuarios', { token: tokenComercial });
  checar('COMERCIAL NAO acessa cadastro de usuarios (403)', usuariosComercial.status === 403);

  await pool.query('UPDATE usuarios SET ativo = FALSE WHERE email = $1', [emailComercial]);
  const inativo = await chamar('GET', '/api/produtos?limite=1', { token: tokenComercial });
  checar('usuario inativado perde o acesso imediatamente (401)', inativo.status === 401);

  const loginInativo = await chamar('POST', '/api/auth/login', {
    corpo: { email: emailComercial, senha: 'Comercial@123' },
  });
  checar('usuario inativo nao consegue autenticar', loginInativo.status === 401);

  // -------------------------------------------------------------- auditoria --
  console.log('\n[auditoria]');
  const auditoria = await chamar('GET', `/api/auditoria?tabela=produtos&registro_id=${produtoId}`, { token });
  const registros = auditoria.corpo?.data ?? [];
  checar('auditoria registrou INSERT e UPDATE do produto',
    registros.some((r: any) => r.acao === 'INSERT') && registros.some((r: any) => r.acao === 'UPDATE'),
    registros.map((r: any) => r.acao));

  const comUsuario = registros.find((r: any) => r.acao === 'UPDATE');
  checar('auditoria guarda o usuario responsavel', !!comUsuario?.usuario, comUsuario);
  checar('auditoria guarda valor anterior e novo',
    !!comUsuario?.valor_anterior && !!comUsuario?.valor_novo);

  let historicoImutavel = false;
  try {
    await pool.query('UPDATE historico_precos SET preco_unitario = 0 WHERE produto_id = $1', [produtoId]);
  } catch {
    historicoImutavel = true;
  }
  checar('historico de precos e imutavel (UPDATE bloqueado)', historicoImutavel);

  let auditoriaImutavel = false;
  try {
    await pool.query('DELETE FROM auditoria WHERE tabela = $1', ['produtos']);
  } catch {
    auditoriaImutavel = true;
  }
  checar('auditoria e imutavel (DELETE bloqueado)', auditoriaImutavel);

  let movimentacaoImutavel = false;
  try {
    await pool.query('DELETE FROM movimentacoes_estoque WHERE produto_id = $1', [produtoId]);
  } catch {
    movimentacaoImutavel = true;
  }
  checar('razao de estoque e imutavel (DELETE bloqueado)', movimentacaoImutavel);

  // ------------------------------------------------------------ soft delete --
  console.log('\n[soft delete]');
  const remocaoComSaldo = await chamar('DELETE', `/api/produtos/${produtoId}`, { token });
  checar('produto com saldo em estoque nao pode ser inativado (422)', remocaoComSaldo.status === 422);

  await chamar('POST', '/api/estoque/movimentacoes', {
    token,
    corpo: { produto_id: produtoId, local_id: localId, tipo_movimentacao: 'AJUSTE_NEGATIVO', quantidade: 300 },
  });
  const remocao = await chamar('DELETE', `/api/produtos/${produtoId}`, { token });
  checar('produto zerado pode ser inativado', remocao.status === 200, remocao.corpo?.error);

  const aposRemocao = await chamar('GET', `/api/produtos/${produtoId}`, { token });
  checar('produto inativado some das consultas (404)', aposRemocao.status === 404);

  const aindaNoBanco = await pool.query('SELECT deleted_at FROM produtos WHERE id = $1', [produtoId]);
  checar('registro continua no banco com deleted_at preenchido', !!aindaNoBanco.rows[0]?.deleted_at);

  // ------------------------------------------------------------- relatorio --
  console.log('\n' + '='.repeat(60));
  console.log(`TESTES: ${passou + falhou} executados | ${passou} passaram | ${falhou} falharam`);
  if (falhas.length) {
    console.log('\nFalhas:');
    falhas.forEach((f) => console.log(`  - ${f}`));
  }
  console.log('='.repeat(60) + '\n');

  return falhou === 0;
}

executar()
  .then((sucesso) => { process.exitCode = sucesso ? 0 : 1; })
  .catch((erro) => {
    console.error('\nErro ao executar os testes:', erro);
    process.exitCode = 1;
  })
  .finally(encerrarPool);
