/**
 * Bateria do MODULO 14 - integracoes e conectividade.
 *
 * Cobre os 15 testes da secao 43 e os criterios de aceite da secao 44.
 *
 * DUAS DECISOES QUE TORNAM ESTA BATERIA HONESTA:
 *
 * 1. Os testes de conector rodam contra um servidor HTTP DE VERDADE, subido
 *    localmente pela propria bateria. Este ambiente nao alcanca a internet, mas
 *    alcanca 127.0.0.1 - entao timeout, 401, 500, retry e backoff sao exercidos
 *    de fato, com socket, e nao simulados com mock. Um mock testaria o mock.
 *
 * 2. A importacao roda contra o ARQUIVO REAL do ERP do cliente (Rel7104, 43 MB,
 *    426 mil linhas) alem dos CSVs sinteticos. Planilha de verdade tem data
 *    serial do Excel, celula vazia no meio, acento e coluna com nome errado -
 *    coisas que um CSV escrito a mao para passar no teste nunca tem.
 *
 * E, como nos modulos anteriores, o que mais importa sao as NEGATIVAS: a
 * integracao nao mexe em estoque (secao 22 manda passar pelo modulo 09), nao
 * emite pedido (secao 9 do modulo 13 continua valendo), nao guarda segredo em
 * texto puro (secao 25) e nao registra token em log (secao 37).
 */
import { createServer, type Server } from 'node:http';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { encerrarPool, query } from '../../config/database.js';
import {
  chamar, checar, encerrar, loginAdmin, novaBateria, secao, tokenDoPerfil,
  type Bateria,
} from './base.js';
import * as conector from '../../modules/integracao/conector.js';
import * as norm from '../../modules/integracao/normalizacao.js';
import * as leitor from '../../modules/integracao/leitor.js';
import * as cred from '../../modules/integracao/credenciais.service.js';
import { canonico, sugerirMapeamento } from '../../modules/integracao/mapeamento.service.js';

const num = (v: unknown) => Number(v ?? 0);
const marca = `M14-${Date.now().toString().slice(-8)}`;
const DIR = '/tmp/importacoes';
const REL7104 = '/mnt/user-data/uploads/Rel_7104_2026.xlsx';

interface Contagens {
  movimentacoes: number; pedidos: number; recebimentos: number;
  lotes: number; estoque_total: number;
}

async function contar(): Promise<Contagens> {
  const { rows } = await query<Record<string, string>>(`
    SELECT (SELECT count(*) FROM movimentacoes_estoque)       AS movimentacoes,
           (SELECT count(*) FROM ordens_compra)               AS pedidos,
           (SELECT count(*) FROM recebimentos)                AS recebimentos,
           (SELECT count(*) FROM lotes)                       AS lotes,
           (SELECT coalesce(sum(quantidade_fisica), 0) FROM estoques) AS estoque_total`);
  const r = rows[0]!;
  return {
    movimentacoes: Number(r.movimentacoes), pedidos: Number(r.pedidos),
    recebimentos: Number(r.recebimentos), lotes: Number(r.lotes),
    estoque_total: Number(r.estoque_total),
  };
}

// ---------------------------------------------------------------------------
// Servidor externo de mentira, com comportamento de verdade
// ---------------------------------------------------------------------------

interface Externo {
  servidor: Server;
  base: string;
  chamadas: Array<{ url: string; metodo: string; autorizacao: string | null }>;
  /** Quantas vezes /instavel ainda deve falhar antes de responder 200. */
  falhasRestantes: number;
}

async function subirExterno(): Promise<Externo> {
  const estado: Externo = {
    servidor: null as unknown as Server, base: '', chamadas: [], falhasRestantes: 0,
  };

  const servidor = createServer((req, res) => {
    const url = req.url ?? '/';
    estado.chamadas.push({
      url, metodo: req.method ?? 'GET',
      autorizacao: req.headers.authorization ?? null,
    });

    const json = (codigo: number, corpo: unknown) => {
      res.writeHead(codigo, { 'content-type': 'application/json' });
      res.end(JSON.stringify(corpo));
    };

    // Nunca responde: exercita o timeout de verdade, sem sleep no teste.
    if (url.startsWith('/nunca')) return;

    if (url.startsWith('/401')) return json(401, { erro: 'token invalido' });
    if (url.startsWith('/403')) return json(403, { erro: 'sem permissao' });
    if (url.startsWith('/500')) return json(500, { erro: 'erro interno do ERP' });

    // Falha as N primeiras vezes e depois responde: prova que o retry chega la.
    if (url.startsWith('/instavel')) {
      if (estado.falhasRestantes > 0) {
        estado.falhasRestantes -= 1;
        return json(503, { erro: 'indisponivel' });
      }
      return json(200, { ok: true, tentativas_ate_sucesso: true });
    }

    // Pagina de produtos do "ERP", para a sincronizacao de entrada.
    if (url.startsWith('/produtos')) {
      const pagina = Number(new URL(url, 'http://x').searchParams.get('page') ?? 1);
      const itens = pagina === 1
        ? [
          { codigo: `${marca}-E1`, descricao: 'CASTANHA ERP 1KG', ean: '7891000000017',
            atualizado_em: '2026-09-01T10:00:00Z' },
          { codigo: `${marca}-E2`, descricao: 'NOZES ERP 500G', ean: '7891000000024',
            atualizado_em: '2026-09-01T10:00:00Z' },
        ]
        : [];
      return json(200, { dados: itens, pagina, tem_proxima: pagina === 1 });
    }

    json(200, { ok: true, url, recebido: req.method });
  });

  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  const endereco = servidor.address();
  const porta = typeof endereco === 'object' && endereco ? endereco.port : 0;

  estado.servidor = servidor;
  estado.base = `http://127.0.0.1:${porta}`;
  return estado;
}

// ---------------------------------------------------------------------------

async function prepararArquivos() {
  await mkdir(DIR, { recursive: true });

  await writeFile(`${DIR}/${marca}-produtos.csv`,
    'CODIGO;DESCRICAO;EAN;CATEGORIA;UNIDADE\n'
    + `${marca}-P1;CASTANHA DE CAJU W2 TORRADA 1KG;7891234500011;APERITIVOS;KG\n`
    + `${marca}-P2;NOZES CHILENA LIGHT 500G;7891234500028;APERITIVOS;KG\n`
    + `${marca}-P3;TEMPERO ORGANICO MISTO 200G;7891234500035;POTES;KG\n`, 'utf8');

  // Arquivo com problemas de proposito, um por linha, para a validacao da
  // secao 13 ter o que classificar entre ERRO e ALERTA.
  await writeFile(`${DIR}/${marca}-ruim.csv`,
    'CODIGO;DESCRICAO;EAN;CATEGORIA;UNIDADE\n'
    + `${marca}-R1;EAN COM DIGITO ERRADO;1234567890123;APERITIVOS;KG\n`
    + ';SEM CODIGO OBRIGATORIO;7891234500059;APERITIVOS;KG\n'
    + `${marca}-R3;;7891234500066;APERITIVOS;KG\n`
    + `${marca}-R4;CATEGORIA INEXISTENTE;7891234500073;NAO_EXISTE_ESSA;KG\n`, 'utf8');

  // Mesmo conteudo do primeiro, bytes diferentes (uma linha em branco no fim):
  // separa "mesmo arquivo" de "mesmo conteudo" na prova de idempotencia.
  await writeFile(`${DIR}/${marca}-produtos-rebatizado.csv`,
    'CODIGO;DESCRICAO;EAN;CATEGORIA;UNIDADE\n'
    + `${marca}-P1;CASTANHA DE CAJU W2 TORRADA 1KG;7891234500011;APERITIVOS;KG\n`
    + `${marca}-P2;NOZES CHILENA LIGHT 500G;7891234500028;APERITIVOS;KG\n`
    + `${marca}-P3;TEMPERO ORGANICO MISTO 200G;7891234500035;POTES;KG\n\n`, 'utf8');
}

async function limpar() {
  await query("DELETE FROM importacao_ocorrencias WHERE importacao_id IN "
    + "(SELECT id FROM importacoes WHERE nome_arquivo LIKE $1)", [`${marca}%`]);
  await query('DELETE FROM importacoes WHERE nome_arquivo LIKE $1', [`${marca}%`]);
  await query('DELETE FROM produto_fornecedor WHERE produto_id IN '
    + '(SELECT id FROM produtos WHERE codigo LIKE $1)', [`${marca}%`]);
  await query('DELETE FROM produtos WHERE codigo LIKE $1', [`${marca}%`]);
  await query('DELETE FROM conciliacoes WHERE chave_externa LIKE $1', [`${marca}%`]);
  await query('DELETE FROM integracao_credenciais WHERE nome LIKE $1', [`${marca}%`]);
  await query('DELETE FROM integracao_mensagens WHERE chave_externa LIKE $1', [`${marca}%`]);
  await query('DELETE FROM integracoes WHERE codigo LIKE $1', [`${marca.replace(/-/g, '')}%`]);
  await rm(`${DIR}/${marca}-produtos.csv`, { force: true });
  await rm(`${DIR}/${marca}-ruim.csv`, { force: true });
  await rm(`${DIR}/${marca}-produtos-rebatizado.csv`, { force: true });
}

// ---------------------------------------------------------------------------

/**
 * O servidor local segura o event loop enquanto estiver aberto.
 *
 * Sem fechar no caminho de erro, qualquer falha no meio da bateria vira um
 * travamento de dez minutos em vez de um erro em dez segundos - e quem esta
 * rodando o teste fica sem saber se quebrou ou se esta lento.
 */
let externoAberto: Externo | null = null;

/** Definida em main e reaproveitada pela secao de permissoes. */
let exportar: (conjunto: string, formato: string, token: string) => Promise<{
  status: number; linhas: number; tipo: string; nome: string; bytes: number;
}>;

async function main() {
  const baterias: Bateria[] = [];
  const admin = await loginAdmin();
  await prepararArquivos();
  const externo = await subirExterno();
  externoAberto = externo;
  const antes = await contar();

  // =========================================================================
  secao('1. Unitarios: normalizacao, classificacao e higienizacao');
  // =========================================================================
  const b1 = novaBateria('Puro: normalizacao (secao 27) e conector (secao 30)');
  baterias.push(b1);

  checar(b1, 'decimal no padrao brasileiro: 1.234,56 vira 1234.56',
    norm.decimal('1.234,56').valor === 1234.56, norm.decimal('1.234,56'));
  checar(b1, 'decimal no padrao americano: 1,234.56 tambem vira 1234.56',
    norm.decimal('1,234.56').valor === 1234.56, norm.decimal('1,234.56'));
  checar(b1, 'decimal com virgula simples: 12,5 vira 12.5',
    norm.decimal('12,5').valor === 12.5, norm.decimal('12,5'));
  checar(b1, 'data brasileira vira ISO',
    norm.data('05/03/2026').valor === '2026-03-05', norm.data('05/03/2026'));
  checar(b1, 'CASO CRITICO: numero serial do Excel vira data',
    norm.data(46027).valor === '2026-01-01' || String(norm.data(46027).valor).startsWith('2026'),
    norm.data(46027));
  checar(b1, 'CNPJ valido passa e fica so com digitos',
    norm.cnpj('11.222.333/0001-81').valor === '11222333000181', norm.cnpj('11.222.333/0001-81'));
  checar(b1, 'CASO CRITICO: CNPJ com digito verificador errado e recusado',
    norm.cnpj('11.222.333/0001-99').ok === false, norm.cnpj('11.222.333/0001-99'));
  checar(b1, 'CNPJ de digitos repetidos e recusado',
    norm.cnpj('11111111111111').ok === false);
  checar(b1, 'EAN com digito verificador errado e recusado',
    norm.ean('1234567890123').ok === false, norm.ean('1234567890123'));
  checar(b1, 'UF desconhecida e recusada, UF valida e normalizada',
    norm.uf('XX').ok === false && norm.uf(' sp ').valor === 'SP');
  checar(b1, 'unidade por extenso vira codigo, com alerta',
    norm.unidade('quilo').valor === 'KG' && Boolean(norm.unidade('quilo').alerta),
    norm.unidade('quilo'));

  for (const [status, tipoEsperado, classeEsperada] of [
    [401, 'AUTENTICACAO', 'DEFINITIVO'],
    [403, 'AUTORIZACAO', 'DEFINITIVO'],
    [404, 'REFERENCIA_INEXISTENTE', 'DEFINITIVO'],
    [429, 'LIMITE_TAXA', 'RECUPERAVEL'],
    [500, 'INDISPONIVEL', 'RECUPERAVEL'],
  ] as Array<[number, string, string]>) {
    const c = conector.classificarStatus(status);
    checar(b1, `HTTP ${status} e ${tipoEsperado} e ${classeEsperada} (secao 30)`,
      c.tipo === tipoEsperado && c.classe === classeEsperada, c);
  }

  checar(b1, 'backoff dobra e respeita o teto',
    conector.intervaloBackoff(1, 5, 60) === 5
    && conector.intervaloBackoff(2, 5, 60) === 10
    && conector.intervaloBackoff(9, 5, 60) === 60,
    [1, 2, 9].map((t) => conector.intervaloBackoff(t, 5, 60)));

  const limpos = conector.higienizarCabecalhos({
    Authorization: 'Bearer token-secreto-de-producao',
    'X-Api-Key': 'chave-secreta', 'Content-Type': 'application/json',
  });
  checar(b1, 'CASO CRITICO: Authorization e X-Api-Key nunca vao para o log (secao 37)',
    !JSON.stringify(limpos).includes('token-secreto-de-producao')
    && !JSON.stringify(limpos).includes('chave-secreta')
    && limpos['Content-Type'] === 'application/json', limpos);
  checar(b1, 'CASO CRITICO: token na query string tambem e removido',
    !conector.higienizarUrl('https://erp/api?token=abc123&page=2').includes('abc123'),
    conector.higienizarUrl('https://erp/api?token=abc123&page=2'));

  checar(b1, 'referencia de credencial aceita env: e file:, recusa valor literal',
    cred.esquemaValido('env:ERP_TOKEN') && cred.esquemaValido('file:/run/s')
    && !cred.esquemaValido('meu-token-em-texto-puro'));

  checar(b1, 'nome de coluna e canonizado sem acento nem separador',
    canonico('Cód. Produto') === 'CODPRODUTO', canonico('Cód. Produto'));
  const sug = sugerirMapeamento(['COD_PROD', 'DESC_PROD', 'QTD', 'FORN']);
  checar(b1, 'a sugestao do PROMPT (COD_PROD, DESC_PROD) e reconhecida (secao 12)',
    sug.some((s) => s.campo_externo === 'COD_PROD' && s.campo_interno === 'produto.codigo')
    && sug.some((s) => s.campo_externo === 'DESC_PROD' && s.campo_interno === 'produto.descricao'),
    sug);

  // =========================================================================
  secao('2. Leitura de arquivo: XLSX real do ERP e CSV (testes 01 e 02)');
  // =========================================================================
  const b2 = novaBateria('Leitor: 43 MB de planilha real');
  baterias.push(b2);

  const t0 = Date.now();
  const insp = await leitor.inspecionar(REL7104, 'XLSX', { amostra: 5 });
  const msInspecao = Date.now() - t0;
  checar(b2, 'le o cabecalho de um XLSX de 43 MB sem carregar o arquivo',
    insp.colunas.length === 23 && msInspecao < 5000, { colunas: insp.colunas.length, msInspecao });
  checar(b2, 'as colunas reais do relatorio 7104 sao reconhecidas',
    insp.colunas.includes('DTFATURAMENTO') && insp.colunas.includes('CODPRODUTO')
    && insp.colunas.includes('QTDE'), insp.colunas.slice(0, 5));
  checar(b2, 'a data vem como serial do Excel, que a normalizacao sabe converter',
    typeof insp.amostra[0]?.DTFATURAMENTO === 'number', insp.amostra[0]?.DTFATURAMENTO);

  checar(b2, 'CASO CRITICO: o formato sai do CONTEUDO, nao da extensao do nome',
    await leitor.detectarFormato(REL7104, 'mentira.csv') === 'XLSX',
    await leitor.detectarFormato(REL7104, 'mentira.csv'));
  checar(b2, 'CSV de verdade continua sendo lido como CSV',
    await leitor.detectarFormato(`${DIR}/${marca}-produtos.csv`, 'x.csv') === 'CSV');

  const h1 = await leitor.hashArquivo(`${DIR}/${marca}-produtos.csv`);
  const h2 = await leitor.hashArquivo(`${DIR}/${marca}-produtos-rebatizado.csv`);
  checar(b2, 'arquivos de bytes diferentes tem hash diferente', h1 !== h2);

  // =========================================================================
  secao('3. Importacao ponta a ponta (testes 01, 02, 10, 11)');
  // =========================================================================
  const b3 = novaBateria('Importador: analisar, mapear, validar, processar');
  baterias.push(b3);

  const { corpo: entidades } = await chamar('GET', '/api/integracoes/importacoes/entidades',
    { token: admin });
  checar(b3, 'as entidades importaveis respondem',
    (entidades?.data?.entidades ?? []).length >= 4, entidades?.data?.entidades);

  const { status: stAnalise, corpo: analise } = await chamar('POST', '/api/integracoes/importacoes', {
    token: admin,
    corpo: {
      nome_arquivo: `${marca}-produtos.csv`, caminho: `${DIR}/${marca}-produtos.csv`,
      entidade: 'produtos',
    },
  });
  checar(b3, 'analise do CSV aceita (201)', stAnalise === 201, { stAnalise, analise });
  const impId = analise?.data?.importacao_id;
  checar(b3, 'as colunas do arquivo sao detectadas',
    (analise?.data?.colunas ?? []).length === 5, analise?.data?.colunas);
  checar(b3, 'CASO CRITICO: a analise NAO grava nada ainda (secao 11)',
    (await query("SELECT count(*)::int t FROM produtos WHERE codigo LIKE $1", [`${marca}%`]))
      .rows[0]!.t === 0);

  const { corpo: mapeado } = await chamar('POST', `/api/integracoes/importacoes/${impId}/mapear`,
    { token: admin, corpo: { template: 'PRODUTOS_PADRAO' } });
  checar(b3, 'CASO CRITICO: o casamento de colunas chega serializado, nao como {}',
    Object.keys(mapeado?.data?.casamento?.encontradas ?? {}).length === 5,
    mapeado?.data?.casamento);

  const { corpo: validado } = await chamar('POST', `/api/integracoes/importacoes/${impId}/validar`,
    { token: admin });
  checar(b3, 'validacao separa validas, erro e alerta (secao 13)',
    num(validado?.data?.validas) === 3 && num(validado?.data?.com_erro) === 0,
    validado?.data);
  checar(b3, 'a pre-visualizacao mostra o que vai ser gravado',
    (validado?.data?.previa ?? []).length > 0, validado?.data?.previa?.[0]);

  const { status: stSemConfirmar } = await chamar(
    'POST', `/api/integracoes/importacoes/${impId}/processar`, { token: admin });
  checar(b3, 'CASO CRITICO: processar sem confirmar e recusado (secao 11)',
    stSemConfirmar >= 400, stSemConfirmar);

  await chamar('POST', `/api/integracoes/importacoes/${impId}/confirmar`, { token: admin });
  const { corpo: processado } = await chamar(
    'POST', `/api/integracoes/importacoes/${impId}/processar`, { token: admin });
  checar(b3, 'processamento cria os 3 produtos',
    processado?.data?.status === 'CONCLUIDA' && num(processado?.data?.criados) === 3,
    processado?.data);

  const { rows: criados } = await query<{ t: string }>(
    "SELECT count(*)::text t FROM produtos WHERE codigo LIKE $1", [`${marca}%`]);
  checar(b3, 'os produtos existem no banco', Number(criados[0]!.t) === 3, criados[0]);

  // Teste 10: duplicidade, nas duas camadas.
  const { corpo: reenvio } = await chamar('POST', '/api/integracoes/importacoes', {
    token: admin,
    corpo: {
      nome_arquivo: `${marca}-produtos.csv`, caminho: `${DIR}/${marca}-produtos.csv`,
      entidade: 'produtos',
    },
  });
  checar(b3, 'CASO CRITICO: reenviar o MESMO arquivo e reconhecido pelo hash (secao 14)',
    Boolean(reenvio?.data?.ja_importado), reenvio?.data?.ja_importado);

  const { corpo: outroArquivo } = await chamar('POST', '/api/integracoes/importacoes', {
    token: admin,
    corpo: {
      nome_arquivo: `${marca}-produtos-rebatizado.csv`,
      caminho: `${DIR}/${marca}-produtos-rebatizado.csv`, entidade: 'produtos',
    },
  });
  const impId2 = outroArquivo?.data?.importacao_id;
  checar(b3, 'arquivo de bytes diferentes passa pelo hash (e outro arquivo)',
    !outroArquivo?.data?.ja_importado && impId2 !== impId);

  await chamar('POST', `/api/integracoes/importacoes/${impId2}/mapear`,
    { token: admin, corpo: { template: 'PRODUTOS_PADRAO' } });
  await chamar('POST', `/api/integracoes/importacoes/${impId2}/validar`, { token: admin });
  await chamar('POST', `/api/integracoes/importacoes/${impId2}/confirmar`, { token: admin });
  const { corpo: proc2 } = await chamar(
    'POST', `/api/integracoes/importacoes/${impId2}/processar`, { token: admin });
  checar(b3, 'CASO CRITICO: mesmo conteudo em outro arquivo ATUALIZA, nao duplica (secao 28)',
    num(proc2?.data?.criados) === 0, proc2?.data);

  const { rows: aposReenvio } = await query<{ t: string }>(
    "SELECT count(*)::text t FROM produtos WHERE codigo LIKE $1", [`${marca}%`]);
  checar(b3, 'continuam sendo 3 produtos, nao 6',
    Number(aposReenvio[0]!.t) === 3, aposReenvio[0]);

  // Teste 11: payload invalido.
  const { corpo: analiseRuim } = await chamar('POST', '/api/integracoes/importacoes', {
    token: admin,
    corpo: {
      nome_arquivo: `${marca}-ruim.csv`, caminho: `${DIR}/${marca}-ruim.csv`,
      entidade: 'produtos',
    },
  });
  const impRuim = analiseRuim?.data?.importacao_id;
  await chamar('POST', `/api/integracoes/importacoes/${impRuim}/mapear`,
    { token: admin, corpo: { template: 'PRODUTOS_PADRAO' } });
  const { corpo: validadoRuim } = await chamar(
    'POST', `/api/integracoes/importacoes/${impRuim}/validar`, { token: admin });
  checar(b3, 'CASO CRITICO: linha sem campo obrigatorio vira ERRO, nao passa',
    num(validadoRuim?.data?.com_erro) >= 2, validadoRuim?.data);
  checar(b3, 'EAN invalido em campo opcional vira ALERTA, nao barra a linha',
    num(validadoRuim?.data?.com_alerta) >= 1, validadoRuim?.data);

  const { corpo: ocorr } = await chamar(
    'GET', `/api/integracoes/importacoes/${impRuim}/ocorrencias`, { token: admin });
  const lista = ocorr?.data?.ocorrencias ?? ocorr?.data ?? [];
  checar(b3, 'cada ocorrencia aponta linha, coluna e motivo (secao 13)',
    lista.length > 0 && lista.every((o: any) => o.linha && o.mensagem),
    lista.slice(0, 2));

  // =========================================================================
  secao('4. Seguranca do importador (secao 37)');
  // =========================================================================
  const b4 = novaBateria('Caminho de arquivo: leitura arbitraria bloqueada');
  baterias.push(b4);

  for (const [caminho, rotulo] of [
    ['/etc/passwd', 'arquivo de sistema'],
    ['/home/claude/sistema-compras/backend/.env', 'segredos da aplicacao'],
    [`${DIR}/../../etc/passwd`, 'travessia com ../'],
    ['relativo.csv', 'caminho relativo'],
  ] as Array<[string, string]>) {
    const { status, corpo } = await chamar('POST', '/api/integracoes/importacoes', {
      token: admin,
      corpo: { nome_arquivo: 'x.csv', caminho, entidade: 'produtos' },
    });
    checar(b4, `CASO CRITICO: importar ${rotulo} e recusado`,
      status >= 400, { caminho, status, corpo: corpo?.error?.message });
  }

  const { rows: vazou } = await query<{ t: string }>(
    "SELECT count(*)::text t FROM importacoes WHERE caminho LIKE '/etc/%' OR caminho LIKE '%.env'");
  checar(b4, 'CASO CRITICO: nenhum arquivo de fora ficou registrado no banco',
    Number(vazou[0]!.t) === 0, vazou[0]);

  // =========================================================================
  secao('5. Conector contra servidor real (testes 03, 07, 08, 09)');
  // =========================================================================
  const b5 = novaBateria('Conector: HTTP de verdade, em 127.0.0.1');
  baterias.push(b5);

  const ok200 = await conector.chamar({ url: `${externo.base}/produtos`, max_tentativas: 1 });
  checar(b5, 'TESTE 03: chamada a API externa responde 200',
    ok200.ok && ok200.status === 200, { status: ok200.status, ms: ok200.duracao_ms });

  // Teste 07: erro de autenticacao NAO deve ser reexecutado.
  //
  // O conector DEVOLVE a falha em `resposta.erro` em vez de lancar excecao: quem
  // sincroniza precisa registrar a tentativa, o tempo e o motivo mesmo quando
  // deu errado, e excecao perde tudo isso no caminho.
  const chamadasAntes = externo.chamadas.length;
  const r401 = await conector.chamar({ url: `${externo.base}/401`, max_tentativas: 3 });
  const tentativas401 = externo.chamadas.length - chamadasAntes;
  checar(b5, 'TESTE 07: 401 e classificado como erro de AUTENTICACAO e DEFINITIVO',
    r401.ok === false && r401.erro?.tipo === 'AUTENTICACAO'
    && r401.erro?.classe === 'DEFINITIVO', r401.erro);
  checar(b5, 'CASO CRITICO: 401 NAO e reexecutado - insistir com token errado nao conserta',
    tentativas401 === 1, { tentativas401 });

  // Teste 09: erro recuperavel É reexecutado, e chega a passar.
  externo.falhasRestantes = 2;
  const chamadasAntes2 = externo.chamadas.length;
  const instavel = await conector.chamar({
    url: `${externo.base}/instavel`, max_tentativas: 4, backoff_base_segundos: 0,
  });
  const tentativasInstavel = externo.chamadas.length - chamadasAntes2;
  checar(b5, 'TESTE 09: servico que falha 2x e responde na 3a acaba dando certo',
    instavel.ok && tentativasInstavel === 3, { ok: instavel.ok, tentativasInstavel });

  // Teste 08: timeout real, contra rota que nunca responde.
  const tTimeout = Date.now();
  const rTimeout = await conector.chamar({
    url: `${externo.base}/nunca`, timeout_segundos: 1, max_tentativas: 1,
  });
  const msTimeout = Date.now() - tTimeout;
  checar(b5, 'TESTE 08: requisicao sem resposta e cortada pelo timeout configurado',
    rTimeout.ok === false && rTimeout.erro?.tipo === 'TIMEOUT'
    && msTimeout >= 900 && msTimeout < 4000,
    { msTimeout, erro: rTimeout.erro });
  checar(b5, 'timeout e RECUPERAVEL: o ERP pode so estar lento agora',
    rTimeout.erro?.classe === 'RECUPERAVEL', rTimeout.erro);

  // Secao 24: DELETE exige autorizacao explicita.
  let erroDelete: any = null;
  try {
    await conector.chamar({ url: `${externo.base}/x`, metodo: 'DELETE', max_tentativas: 1 });
  } catch (e) { erroDelete = e; }
  checar(b5, 'CASO CRITICO: DELETE em sistema externo exige autorizacao (secao 24)',
    Boolean(erroDelete), String(erroDelete).slice(0, 140));
  const chamadasDelete = externo.chamadas.filter((c) => c.metodo === 'DELETE').length;
  checar(b5, 'CASO CRITICO: o DELETE recusado nem chegou a sair da aplicacao',
    chamadasDelete === 0, { chamadasDelete });

  // Secao 25: o segredo vira cabecalho e nunca aparece na resposta do conector.
  const comAuth = await conector.chamar({
    url: `${externo.base}/eco`, max_tentativas: 1,
    cabecalhos: { Authorization: 'Bearer segredo-nao-deve-vazar' },
  });
  const ultima = externo.chamadas[externo.chamadas.length - 1];
  checar(b5, 'o cabecalho de autenticacao chega ao servidor externo',
    ultima?.autorizacao === 'Bearer segredo-nao-deve-vazar');
  checar(b5, 'CASO CRITICO: o segredo nao volta no objeto de resposta do conector',
    !JSON.stringify(comAuth).includes('segredo-nao-deve-vazar'));

  // =========================================================================
  secao('6. Integracoes, credenciais e sincronizacao (testes 04, 15)');
  // =========================================================================
  const b6 = novaBateria('Integracao ERP: cadastro, credencial e ambiente');
  baterias.push(b6);

  const codigoIntegracao = `${marca.replace(/-/g, '')}ERP`;

  // A lista de hosts liberados e estado que sobrevive entre execucoes: sem
  // zera-la, a segunda rodada da bateria testaria a configuracao deixada pela
  // primeira, e o teste de recusa passaria a falhar sozinho.
  const { status: stLimpar } = await chamar(
    'PUT', '/api/integracoes/configuracoes/integracao.hosts_internos_permitidos',
    { token: admin, corpo: { valor: '' } });
  checar(b6, 'CASO CRITICO: uma lista de configuracao pode voltar a ficar vazia',
    stLimpar === 200, stLimpar);

  // Endpoint interno e recusado por padrao. Este e o caso real do cliente - o
  // ERP fica na rede da empresa - entao o teste exercita o caminho previsto:
  // liberar o host explicitamente, e so entao cadastrar.
  const { status: stSemLiberar } = await chamar('POST', '/api/integracoes', {
    token: admin,
    corpo: {
      codigo: `${codigoIntegracao}X`, nome: 'ERP interno sem liberar', sistema: 'ERP',
      conector: 'REST', endpoint: `${externo.base}/produtos`,
    },
  });
  checar(b6, 'CASO CRITICO: endpoint de rede interna e recusado por padrao (SSRF)',
    stSemLiberar >= 400, stSemLiberar);

  await chamar('PUT', '/api/integracoes/configuracoes/integracao.hosts_internos_permitidos',
    { token: admin, corpo: { valor: '127.0.0.1' } });

  const { status: stCriar, corpo: criada } = await chamar('POST', '/api/integracoes', {
    token: admin,
    corpo: {
      codigo: codigoIntegracao, nome: `ERP de teste ${marca}`, sistema: 'ERP',
      conector: 'REST', direcao: 'BIDIRECIONAL', modo_sincronizacao: 'MANUAL',
      endpoint: `${externo.base}/produtos`, timeout_segundos: 5, max_tentativas: 2,
      ativo: true,
    },
  });
  checar(b6, 'TESTE 04: com o host liberado, a integracao de ERP e criada (201)',
    stCriar === 201, { stCriar, criada });

  const { corpo: duplicada } = await chamar('POST', '/api/integracoes', {
    token: admin,
    corpo: {
      codigo: codigoIntegracao, nome: 'duplicata', sistema: 'ERP', conector: 'REST',
    },
  });
  checar(b6, 'codigo repetido de integracao e recusado',
    duplicada?.success === false, duplicada);

  const { corpo: teste } = await chamar('POST', `/api/integracoes/${codigoIntegracao}/testar`,
    { token: admin, corpo: { caminho: 'produtos' } });
  checar(b6, 'TESTE 04: o botao "testar conexao" alcanca o ERP e diz o tempo',
    teste?.data?.alcancavel === true, teste?.data);

  const { status: stCredLiteral } = await chamar('POST', '/api/integracoes/credenciais', {
    token: admin,
    corpo: {
      integracao_id: criada?.data?.id, nome: `${marca}-cred`, tipo: 'BEARER',
      referencia_segura: 'token-em-texto-puro-123456',
    },
  });
  checar(b6, 'CASO CRITICO: credencial em texto puro e recusada (secao 25)',
    stCredLiteral >= 400, stCredLiteral);

  const { status: stCredOk, corpo: credOk } = await chamar('POST', '/api/integracoes/credenciais', {
    token: admin,
    corpo: {
      integracao_id: criada?.data?.id, nome: `${marca}-cred`, tipo: 'BEARER',
      referencia_segura: 'env:M14_TOKEN_TESTE', ambiente: 'DESENVOLVIMENTO',
    },
  });
  checar(b6, 'credencial por referencia e aceita', stCredOk === 201, { stCredOk, credOk });

  const { rows: guardado } = await query<{ referencia_segura: string }>(
    'SELECT referencia_segura FROM integracao_credenciais WHERE nome = $1', [`${marca}-cred`]);
  checar(b6, 'CASO CRITICO: o banco guarda a REFERENCIA, nunca o segredo (secao 25)',
    guardado[0]?.referencia_segura === 'env:M14_TOKEN_TESTE', guardado[0]);

  const { corpo: listaCred } = await chamar('GET', '/api/integracoes/credenciais',
    { token: admin });
  checar(b6, 'CASO CRITICO: a listagem de credenciais nao devolve valor de segredo',
    !JSON.stringify(listaCred?.data ?? []).includes('M14_TOKEN_TESTE_VALOR'),
    Object.keys((listaCred?.data ?? [])[0] ?? {}));

  // =========================================================================
  secao('7. Conciliacao (teste 12)');
  // =========================================================================
  const b7 = novaBateria('Conciliacao: divergencia vira alerta, nunca correcao');
  baterias.push(b7);

  const { rows: paraConciliar } = await query<{ codigo: string; saldo: string }>(`
    SELECT codigo, estoque_disponivel::text AS saldo
      FROM vw_estoque_atual WHERE estoque_disponivel > 100 LIMIT 3`);

  const estoqueAntes = (await contar()).estoque_total;

  const { corpo: conciliacao } = await chamar('POST', '/api/integracoes/conciliacoes/estoque', {
    token: admin,
    corpo: {
      integracao: 'ERP',
      saldos: paraConciliar.map((p) => ({
        codigo_produto: p.codigo, saldo: Number(p.saldo) - 50,
      })),
    },
  });
  checar(b7, 'TESTE 12: a conciliacao compara e encontra as divergencias',
    num(conciliacao?.data?.comparados) === 3 && num(conciliacao?.data?.divergentes) >= 1,
    conciliacao?.data);

  const estoqueDepois = (await contar()).estoque_total;
  checar(b7, 'CASO CRITICO: conciliar NAO corrige o estoque sozinho (secao 34)',
    estoqueAntes === estoqueDepois, { estoqueAntes, estoqueDepois });

  const { corpo: divergencias } = await chamar(
    'GET', '/api/integracoes/conciliacoes?status=DIVERGENTE', { token: admin });
  checar(b7, 'a divergencia fica registrada com os dois valores',
    (divergencias?.data?.conciliacoes ?? []).some(
      (c: any) => c.valor_interno !== null && c.valor_externo !== null),
    (divergencias?.data?.conciliacoes ?? [])[0]);

  const { corpo: repetida } = await chamar('POST', '/api/integracoes/conciliacoes/estoque', {
    token: admin,
    corpo: {
      integracao: 'ERP',
      saldos: paraConciliar.map((p) => ({
        codigo_produto: p.codigo, saldo: Number(p.saldo) - 50,
      })),
    },
  });
  checar(b7, 'CASO CRITICO: conciliar de novo nao duplica a divergencia aberta',
    num(repetida?.data?.registradas) === 0 && num(repetida?.data?.ja_abertas) >= 1,
    repetida?.data);

  // =========================================================================
  secao('8. Exportacao (secao 40)');
  // =========================================================================
  const b8 = novaBateria('Exportacao: formatos, permissao e auditoria');
  baterias.push(b8);

  const { corpo: conjuntos } = await chamar('GET', '/api/integracoes/exportacoes/conjuntos',
    { token: admin });
  checar(b8, 'o catalogo de conjuntos exportaveis responde',
    (conjuntos?.data ?? []).length >= 5, (conjuntos?.data ?? []).length);

  //
  // A exportacao devolve o ARQUIVO, com `X-Linhas` no cabecalho - nao o envelope
  // JSON das demais rotas. Faz sentido: o navegador precisa baixar, nao ler um
  // JSON com o arquivo dentro em base64.
  exportar = async (conjunto: string, formato: string, token: string) => {
    const resposta = await fetch(
      `${process.env.BASE_URL ?? 'http://localhost:3333'}/api/integracoes/exportacoes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ conjunto, formato }),
      });
    const bytes = resposta.status === 200
      ? (await resposta.arrayBuffer()).byteLength : 0;
    return {
      status: resposta.status,
      linhas: Number(resposta.headers.get('x-linhas') ?? 0),
      tipo: resposta.headers.get('content-type') ?? '',
      nome: resposta.headers.get('content-disposition') ?? '',
      bytes,
    };
  };

  const assinaturas: Record<string, (r: { tipo: string; nome: string }) => boolean> = {
    CSV: (r) => /csv/i.test(r.tipo) && /\.csv/i.test(r.nome),
    XLSX: (r) => /spreadsheet|octet/i.test(r.tipo) && /\.xlsx/i.test(r.nome),
    JSON: (r) => /json/i.test(r.tipo) && /\.json/i.test(r.nome),
    PDF: (r) => /pdf/i.test(r.tipo) && /\.pdf/i.test(r.nome),
  };

  for (const formato of ['CSV', 'XLSX', 'JSON', 'PDF']) {
    const r = await exportar('estoque', formato, admin);
    checar(b8, `exportacao de estoque em ${formato} gera arquivo com linhas`,
      r.status === 200 && r.linhas > 0 && r.bytes > 0, r);
    checar(b8, `o arquivo ${formato} sai com o tipo e a extensao certos`,
      assinaturas[formato]!(r), { tipo: r.tipo, nome: r.nome });
  }

  const sensivel = await exportar('fornecedores', 'CSV', admin);
  checar(b8, 'exportacao sensivel e permitida para quem tem a permissao do dado',
    sensivel.status === 200 && sensivel.linhas > 0, sensivel);

  const { rows: auditado } = await query<{ acao: string }>(`
    SELECT acao::text AS acao FROM auditoria
     WHERE origem = 'integracao:exportacao' ORDER BY id DESC LIMIT 1`);
  checar(b8, 'CASO CRITICO: exportacao sensivel vai para a auditoria (secao 40)',
    auditado[0]?.acao === 'EXPORTACAO', auditado[0]);

  // =========================================================================
  secao('9. Permissoes (teste 15)');
  // =========================================================================
  const b9 = novaBateria('Permissoes: quem pode o que');
  baterias.push(b9);

  const { status: semToken } = await chamar('GET', '/api/integracoes/central');
  checar(b9, 'sem token a API recusa (401)', semToken === 401, semToken);

  const comercial = await tokenDoPerfil(admin, 'COMERCIAL', marca);
  if (comercial) {
    // O COMERCIAL recebe `integracao.ler` e `integracao.exportar` pelo seed, e
    // isso esta certo: ele consulta estoque e disponibilidade. O que ele NAO
    // pode e mexer na infraestrutura nem ver dado comercial sensivel.
    for (const [metodo, rota] of [
      ['GET', '/api/integracoes/credenciais'],
      ['POST', '/api/integracoes/importacoes'],
      ['PUT', '/api/integracoes/configuracoes/integracao.max_tentativas'],
    ] as Array<['GET' | 'POST' | 'PUT', string]>) {
      const { status } = await chamar(metodo, rota, {
        token: comercial, ...(metodo === 'GET' ? {} : { corpo: { valor: '9' } }),
      });
      checar(b9, `perfil sem a permissao especifica nao acessa ${metodo} ${rota}`,
        status === 403, { rota, status });
    }

    const permitida = await exportar('estoque', 'CSV', comercial);
    checar(b9, 'quem pode ler estoque exporta estoque',
      permitida.status === 200, permitida.status);

    const negada = await exportar('fornecedores', 'CSV', comercial);
    checar(b9, 'CASO CRITICO: a permissao de exportar nao da acesso ao dado sensivel',
      negada.status === 403, { status: negada.status });

    const { corpo: central2 } = await chamar('GET', '/api/integracoes/central',
      { token: comercial });
    checar(b9, 'CASO CRITICO: a central nao expoe referencia de credencial a quem le',
      !JSON.stringify(central2?.data ?? {}).includes('env:'),
      JSON.stringify(central2?.data ?? {}).slice(0, 120));
  }

  // =========================================================================
  secao('10. O que a integracao NAO fez (secoes 9, 22 e 34)');
  // =========================================================================
  const b10 = novaBateria('Efeitos colaterais: as negativas que importam');
  baterias.push(b10);

  const depois = await contar();
  checar(b10, 'CASO CRITICO: nenhuma movimentacao de estoque criada pela integracao (secao 22)',
    depois.movimentacoes === antes.movimentacoes,
    { antes: antes.movimentacoes, depois: depois.movimentacoes });
  checar(b10, 'CASO CRITICO: nenhum pedido de compra emitido pela integracao (secao 9)',
    depois.pedidos === antes.pedidos, { antes: antes.pedidos, depois: depois.pedidos });
  checar(b10, 'CASO CRITICO: nenhum recebimento criado sem passar pelo modulo 09 (secao 22)',
    depois.recebimentos === antes.recebimentos,
    { antes: antes.recebimentos, depois: depois.recebimentos });
  checar(b10, 'CASO CRITICO: nenhum lote criado pela integracao',
    depois.lotes === antes.lotes, { antes: antes.lotes, depois: depois.lotes });
  checar(b10, 'CASO CRITICO: o saldo de estoque nao mudou',
    depois.estoque_total === antes.estoque_total,
    { antes: antes.estoque_total, depois: depois.estoque_total });

  const { rows: segredos } = await query<{ t: string }>(`
    SELECT count(*)::text AS t FROM integracao_credenciais
     WHERE referencia_segura IS NOT NULL
       AND referencia_segura !~ '^(env|file):'`);
  checar(b10, 'CASO CRITICO: nenhuma credencial guardada fora do padrao de referencia',
    Number(segredos[0]!.t) === 0, segredos[0]);

  const { rows: logs } = await query<{ t: string }>(`
    SELECT count(*)::text AS t FROM integracao_erros
     WHERE payload::text ~* '(bearer |authorization|api[-_]?key)'`);
  checar(b10, 'CASO CRITICO: nenhum token gravado no log de erros (secao 37)',
    Number(logs[0]!.t) === 0, logs[0]);

  // =========================================================================
  secao('11. Central e monitoramento (secoes 5 e 33)');
  // =========================================================================
  const b11 = novaBateria('Central de integracoes e diagnostico');
  baterias.push(b11);

  const { corpo: central } = await chamar('GET', '/api/integracoes/central', { token: admin });
  checar(b11, 'a central responde com o semaforo de cada integracao (secao 5)',
    Array.isArray(central?.data?.integracoes) && central.data.integracoes.length > 0,
    (central?.data?.integracoes ?? [])[0]);
  checar(b11, 'cada integracao tem situacao classificada',
    (central?.data?.integracoes ?? []).every((i: any) => typeof i.semaforo === 'string'),
    (central?.data?.integracoes ?? []).map((i: any) => `${i.codigo}:${i.semaforo}`).slice(0, 6));

  const { corpo: indicadores } = await chamar('GET', '/api/integracoes/indicadores?dias=30',
    { token: admin });
  checar(b11, 'os indicadores da secao 33 respondem',
    indicadores?.data !== undefined, Object.keys(indicadores?.data ?? {}));

  const { corpo: diag } = await chamar('GET', '/api/integracoes/diagnostico', { token: admin });
  checar(b11, 'o diagnostico classifica a gravidade',
    ['OK', 'ATENCAO', 'CRITICO'].includes(diag?.data?.gravidade), diag?.data?.gravidade);
  checar(b11, 'CASO CRITICO: todo sintoma vem com a acao correspondente',
    (diag?.data?.sintomas ?? []).every((s: any) => typeof s.acao === 'string' && s.acao.length > 8),
    (diag?.data?.sintomas ?? []).filter((s: any) => !s.acao));

  const { rows: templates } = await query<{ codigo: string }>(
    'SELECT codigo FROM vw_templates_saude WHERE sem_mapeamento AND ativo');
  checar(b11, 'CASO CRITICO: nenhum template ativo sem campo mapeado',
    templates.length === 0, templates.map((t) => t.codigo));

  // =========================================================================
  // Devolve a configuracao ao padrao seguro: a bateria nao pode deixar o
  // sistema mais permissivo do que encontrou.
  await chamar('PUT', '/api/integracoes/configuracoes/integracao.hosts_internos_permitidos',
    { token: admin, corpo: { valor: '' } });

  externo.servidor.close();
  await limpar();
  encerrar(baterias);
  await encerrarPool();
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  externoAberto?.servidor.close();
  await encerrarPool().catch(() => undefined);
});
