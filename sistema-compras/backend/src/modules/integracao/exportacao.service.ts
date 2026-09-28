/**
 * Exportacao em Excel, CSV, JSON e PDF (secao 40).
 *
 * Esta e a pendencia mais antiga do sistema: pedida desde o modulo 04 e
 * arrastada por dez modulos. Ela cabe aqui porque exportar e integrar - e o
 * caminho de saida para quem esta do outro lado sem API nenhuma.
 *
 * Tres exigencias da secao 40:
 *
 * 1. **Respeitar permissao.** A exportacao nao e um atalho para ver o que a
 *    tela nao mostra. Cada conjunto declara a permissao que exige, e a rota
 *    confere antes de gerar uma linha.
 *
 * 2. **Registrar exportacao sensivel em auditoria.** Levar a base de
 *    fornecedores com CNPJ e preco para uma planilha e um evento que merece
 *    nome e hora.
 *
 * 3. **Limite.** Exportacao sem teto derruba o servidor e produz um arquivo
 *    que ninguem abre. O limite corta com aviso, nao em silencio.
 *
 * Os formatos sao gerados sem biblioteca externa. XLSX e um ZIP com XML
 * dentro: com poucas centenas de linhas de codigo sai um arquivo que o Excel,
 * o LibreOffice e o Google Sheets abrem. A alternativa era mais uma dependencia
 * para gerar o que o proprio formato ja permite escrever.
 */
import { createHash } from 'node:crypto';
import { deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { query, type ContextoSessao } from '../../config/database.js';
import { regraNegocio, semPermissao } from '../../core/errors.js';
import { numero as configNumero } from './config.js';

const comprimir = promisify(deflateRaw);

export type Formato = 'XLSX' | 'CSV' | 'JSON' | 'PDF';

export interface Coluna {
  campo: string;
  titulo: string;
  tipo?: 'texto' | 'numero' | 'data' | 'moeda';
}

export interface Conjunto {
  codigo: string;
  nome: string;
  descricao: string;
  permissao: string;
  /** Exportar isto vai para a auditoria (secao 40). */
  sensivel: boolean;
  colunas: Coluna[];
  consulta: (filtros: Record<string, unknown>, limite: number) => {
    sql: string; valores: unknown[];
  };
}

// ---------------------------------------------------------------------------
// Catalogo do que pode ser exportado
// ---------------------------------------------------------------------------

export const CONJUNTOS: Record<string, Conjunto> = {
  estoque: {
    codigo: 'estoque',
    nome: 'Posicao de estoque',
    descricao: 'Saldo, cobertura e ponto de pedido por produto',
    permissao: 'estoque.ler',
    sensivel: false,
    colunas: [
      { campo: 'codigo', titulo: 'Codigo' },
      { campo: 'descricao', titulo: 'Produto' },
      { campo: 'categoria', titulo: 'Categoria' },
      { campo: 'unidade', titulo: 'Unidade' },
      { campo: 'estoque_disponivel', titulo: 'Disponivel', tipo: 'numero' },
      { campo: 'estoque_em_transito', titulo: 'Em transito', tipo: 'numero' },
      { campo: 'demanda_media_diaria', titulo: 'Demanda/dia', tipo: 'numero' },
      { campo: 'cobertura_dias', titulo: 'Cobertura (dias)', tipo: 'numero' },
      { campo: 'ponto_pedido', titulo: 'Ponto de pedido', tipo: 'numero' },
      { campo: 'estoque_minimo', titulo: 'Minimo', tipo: 'numero' },
    ],
    consulta: (_f, limite) => ({
      sql: `SELECT codigo, descricao, categoria, unidade, estoque_disponivel,
                   estoque_em_transito, demanda_media_diaria, cobertura_dias,
                   ponto_pedido, estoque_minimo
              FROM vw_estoque_atual ORDER BY descricao LIMIT $1`,
      valores: [limite],
    }),
  },

  produtos: {
    codigo: 'produtos',
    nome: 'Cadastro de produtos',
    descricao: 'Codigo, descricao, categoria e parametros de reposicao',
    permissao: 'produtos.ler',
    sensivel: false,
    colunas: [
      { campo: 'codigo', titulo: 'Codigo' },
      { campo: 'descricao', titulo: 'Descricao' },
      { campo: 'ean', titulo: 'EAN' },
      { campo: 'categoria', titulo: 'Categoria' },
      { campo: 'classificacao_abc', titulo: 'ABC' },
      { campo: 'classificacao_xyz', titulo: 'XYZ' },
      { campo: 'estoque_minimo', titulo: 'Estoque minimo', tipo: 'numero' },
      { campo: 'ponto_pedido', titulo: 'Ponto de pedido', tipo: 'numero' },
      { campo: 'lead_time_padrao_dias', titulo: 'Lead time (dias)', tipo: 'numero' },
      { campo: 'ativo', titulo: 'Ativo' },
    ],
    consulta: (_f, limite) => ({
      sql: `SELECT p.codigo, p.descricao, p.ean, c.nome AS categoria,
                   p.classificacao_abc::text AS classificacao_abc,
                   p.classificacao_xyz::text AS classificacao_xyz,
                   p.estoque_minimo, p.ponto_pedido, p.lead_time_padrao_dias, p.ativo
              FROM produtos p LEFT JOIN categorias c ON c.id = p.categoria_id
             WHERE p.deleted_at IS NULL ORDER BY p.codigo LIMIT $1`,
      valores: [limite],
    }),
  },

  fornecedores: {
    codigo: 'fornecedores',
    nome: 'Cadastro de fornecedores',
    descricao: 'Razao social, CNPJ, contato e score',
    permissao: 'fornecedores.ler',
    // CNPJ, e-mail e telefone de toda a base de fornecedores numa planilha:
    // e exatamente o tipo de saida que a secao 40 manda auditar.
    sensivel: true,
    colunas: [
      { campo: 'razao_social', titulo: 'Razao social' },
      { campo: 'nome_fantasia', titulo: 'Nome fantasia' },
      { campo: 'cnpj', titulo: 'CNPJ' },
      { campo: 'cidade', titulo: 'Cidade' },
      { campo: 'estado', titulo: 'UF' },
      { campo: 'email', titulo: 'E-mail' },
      { campo: 'telefone', titulo: 'Telefone' },
      { campo: 'score_atual', titulo: 'Score', tipo: 'numero' },
      { campo: 'ativo', titulo: 'Ativo' },
    ],
    consulta: (_f, limite) => ({
      sql: `SELECT razao_social, nome_fantasia, cnpj, cidade, estado, email,
                   telefone, score_atual, ativo
              FROM fornecedores WHERE deleted_at IS NULL
             ORDER BY razao_social LIMIT $1`,
      valores: [limite],
    }),
  },

  precos: {
    codigo: 'precos',
    nome: 'Precos por fornecedor',
    descricao: 'Preco atual e anterior de cada produto por fornecedor',
    permissao: 'fornecedores.ler',
    sensivel: true,
    colunas: [
      { campo: 'produto_codigo', titulo: 'Codigo' },
      { campo: 'produto', titulo: 'Produto' },
      { campo: 'fornecedor', titulo: 'Fornecedor' },
      { campo: 'cnpj', titulo: 'CNPJ' },
      { campo: 'preco_atual', titulo: 'Preco atual', tipo: 'moeda' },
      { campo: 'preco_anterior', titulo: 'Preco anterior', tipo: 'moeda' },
      { campo: 'moq', titulo: 'MOQ', tipo: 'numero' },
      { campo: 'lead_time_dias', titulo: 'Lead time', tipo: 'numero' },
      { campo: 'fornecedor_principal', titulo: 'Principal' },
    ],
    consulta: (_f, limite) => ({
      sql: `SELECT p.codigo AS produto_codigo, p.descricao AS produto,
                   f.razao_social AS fornecedor, f.cnpj, pf.preco_atual,
                   pf.preco_anterior, pf.moq, pf.lead_time_dias,
                   pf.fornecedor_principal
              FROM produto_fornecedor pf
              JOIN produtos p ON p.id = pf.produto_id
              JOIN fornecedores f ON f.id = pf.fornecedor_id
             WHERE pf.ativo ORDER BY p.codigo, f.razao_social LIMIT $1`,
      valores: [limite],
    }),
  },

  necessidades: {
    codigo: 'necessidades',
    nome: 'Necessidades de compra',
    descricao: 'O que precisa ser comprado, com quantidade sugerida',
    permissao: 'compras.ler',
    sensivel: false,
    colunas: [
      { campo: 'codigo', titulo: 'Codigo' },
      { campo: 'produto', titulo: 'Produto' },
      { campo: 'prioridade', titulo: 'Prioridade' },
      { campo: 'estoque_disponivel', titulo: 'Disponivel', tipo: 'numero' },
      { campo: 'demanda_periodo', titulo: 'Demanda do periodo', tipo: 'numero' },
      { campo: 'quantidade_sugerida', titulo: 'Sugerido', tipo: 'numero' },
      { campo: 'fornecedor', titulo: 'Fornecedor sugerido' },
      { campo: 'data_geracao', titulo: 'Gerada em', tipo: 'data' },
    ],
    consulta: (_f, limite) => ({
      sql: `SELECT p.codigo, p.descricao AS produto,
                   n.prioridade::text AS prioridade, n.estoque_disponivel,
                   n.demanda_periodo, n.quantidade_sugerida,
                   f.razao_social AS fornecedor, n.data_geracao
              FROM necessidades_compra n
              JOIN produtos p ON p.id = n.produto_id
              LEFT JOIN fornecedores f ON f.id = n.fornecedor_id
             WHERE n.status = 'PENDENTE'
             ORDER BY CASE n.prioridade::text
                        WHEN 'CRITICA' THEN 1 WHEN 'ALTA' THEN 2
                        WHEN 'MEDIA' THEN 3 ELSE 4 END,
                      n.quantidade_sugerida DESC LIMIT $1`,
      valores: [limite],
    }),
  },

  pedidos: {
    codigo: 'pedidos',
    nome: 'Pedidos de compra',
    descricao: 'Pedidos com fornecedor, valor e situacao',
    permissao: 'ordens_compra.ler',
    sensivel: true,
    colunas: [
      { campo: 'numero', titulo: 'Numero' },
      { campo: 'fornecedor', titulo: 'Fornecedor' },
      { campo: 'data_emissao', titulo: 'Emissao', tipo: 'data' },
      { campo: 'data_prevista_entrega', titulo: 'Previsao', tipo: 'data' },
      { campo: 'valor_total', titulo: 'Valor', tipo: 'moeda' },
      { campo: 'status', titulo: 'Situacao' },
      { campo: 'comprador', titulo: 'Comprador' },
    ],
    consulta: (f, limite) => {
      const valores: unknown[] = [limite];
      let filtro = '';
      if (f.desde) { valores.push(f.desde); filtro += ` AND o.data_emissao >= $${valores.length}`; }
      if (f.ate) { valores.push(f.ate); filtro += ` AND o.data_emissao <= $${valores.length}`; }
      return {
        sql: `SELECT o.numero, fo.razao_social AS fornecedor, o.data_emissao,
                     o.data_prevista_entrega, o.valor_total,
                     o.status::text AS status, u.nome AS comprador
                FROM ordens_compra o
                JOIN fornecedores fo ON fo.id = o.fornecedor_id
                LEFT JOIN usuarios u ON u.id = o.comprador_id
               WHERE 1 = 1${filtro}
               ORDER BY o.data_emissao DESC LIMIT $1`,
        valores,
      };
    },
  },

  tarefas: {
    codigo: 'tarefas',
    nome: 'Tarefas da automacao',
    descricao: 'Tarefas abertas com prazo e responsavel',
    permissao: 'automacao.ler',
    sensivel: false,
    colunas: [
      { campo: 'tipo', titulo: 'Etapa' },
      { campo: 'titulo', titulo: 'Tarefa' },
      { campo: 'prioridade', titulo: 'Prioridade' },
      { campo: 'status', titulo: 'Situacao' },
      { campo: 'responsavel', titulo: 'Responsavel' },
      { campo: 'perfil_destino', titulo: 'Perfil' },
      { campo: 'sla_status', titulo: 'SLA' },
      { campo: 'prazo', titulo: 'Prazo', tipo: 'data' },
    ],
    consulta: (_f, limite) => ({
      sql: `SELECT t.tipo, t.titulo, t.prioridade::text AS prioridade,
                   t.status::text AS status, u.nome AS responsavel,
                   t.perfil_destino, t.sla_status::text AS sla_status, t.prazo
              FROM tarefas t LEFT JOIN usuarios u ON u.id = t.responsavel_id
             WHERE t.status IN ('PENDENTE', 'EM_ANDAMENTO')
             ORDER BY t.sla_vence_em NULLS LAST LIMIT $1`,
      valores: [limite],
    }),
  },

  conciliacoes: {
    codigo: 'conciliacoes',
    nome: 'Divergencias de conciliacao',
    descricao: 'Diferencas entre o sistema e as origens externas',
    permissao: 'integracao.ler',
    sensivel: false,
    colunas: [
      { campo: 'integracao', titulo: 'Integracao' },
      { campo: 'entidade', titulo: 'Entidade' },
      { campo: 'chave_externa', titulo: 'Chave' },
      { campo: 'campo', titulo: 'Campo' },
      { campo: 'valor_interno', titulo: 'Sistema', tipo: 'numero' },
      { campo: 'valor_externo', titulo: 'Origem', tipo: 'numero' },
      { campo: 'diferenca', titulo: 'Diferenca', tipo: 'numero' },
      { campo: 'status', titulo: 'Situacao' },
    ],
    consulta: (_f, limite) => ({
      sql: `SELECT i.codigo AS integracao, c.entidade, c.chave_externa, c.campo,
                   c.valor_interno, c.valor_externo, c.diferenca,
                   c.status::text AS status
              FROM conciliacoes c LEFT JOIN integracoes i ON i.id = c.integracao_id
             ORDER BY CASE WHEN c.status = 'DIVERGENTE' THEN 0 ELSE 1 END,
                      abs(c.diferenca) DESC LIMIT $1`,
      valores: [limite],
    }),
  },
};

export const catalogo = () => Object.values(CONJUNTOS).map((c) => ({
  codigo: c.codigo, nome: c.nome, descricao: c.descricao,
  permissao: c.permissao, sensivel: c.sensivel,
  colunas: c.colunas.map((col) => col.titulo),
}));

// ---------------------------------------------------------------------------
// Geracao
// ---------------------------------------------------------------------------

export interface Exportacao {
  id: number;
  nome_arquivo: string;
  formato: Formato;
  tipo_conteudo: string;
  conteudo: Buffer;
  linhas: number;
  truncado: boolean;
  aviso?: string;
}

export async function exportar(
  codigo: string, formato: Formato,
  filtros: Record<string, unknown>,
  permissoes: string[],
  contexto: ContextoSessao,
): Promise<Exportacao> {
  const conjunto = CONJUNTOS[codigo];
  if (!conjunto) {
    throw regraNegocio(
      `Conjunto "${codigo}" nao existe. Disponiveis: ${Object.keys(CONJUNTOS).join(', ')}`);
  }

  // Secao 40: respeitar permissoes. A exportacao nao e atalho para o que a
  // tela nao mostra.
  if (!permissoes.includes('*') && !permissoes.includes(conjunto.permissao)) {
    throw semPermissao(
      `Exportar ${conjunto.nome} exige a permissao ${conjunto.permissao}`);
  }

  const limite = await configNumero('exportacao_max_linhas', 100_000);
  const inicio = Date.now();

  const { sql, valores } = conjunto.consulta(filtros, limite + 1);
  const { rows } = await query<Record<string, unknown>>(sql, valores);

  const truncado = rows.length > limite;
  const dados = truncado ? rows.slice(0, limite) : rows;

  const carimbo = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const nomeArquivo = `${conjunto.codigo}-${carimbo}.${formato.toLowerCase()}`;

  let conteudo: Buffer;
  let tipoConteudo: string;

  switch (formato) {
    case 'CSV':
      conteudo = gerarCsv(conjunto.colunas, dados);
      tipoConteudo = 'text/csv; charset=utf-8';
      break;
    case 'JSON':
      conteudo = Buffer.from(JSON.stringify({
        conjunto: conjunto.codigo,
        gerado_em: new Date().toISOString(),
        linhas: dados.length,
        truncado,
        dados,
      }, null, 2), 'utf8');
      tipoConteudo = 'application/json; charset=utf-8';
      break;
    case 'PDF':
      conteudo = gerarPdf(conjunto, dados);
      tipoConteudo = 'application/pdf';
      break;
    case 'XLSX':
    default:
      conteudo = await gerarXlsx(conjunto.colunas, dados);
      tipoConteudo = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      break;
  }

  const { rows: registro } = await query<{ id: string }>(`
    INSERT INTO exportacoes
      (entidade, formato, nome_arquivo, filtros, colunas, total_linhas,
       tamanho_bytes, sensivel, duracao_ms, usuario_id, ip)
    VALUES ($1, $2::formato_exportacao_enum, $3, $4::jsonb, $5::jsonb, $6, $7, $8,
            $9, $10, $11)
    RETURNING id`,
  [conjunto.codigo, formato, nomeArquivo, JSON.stringify(filtros),
    JSON.stringify(conjunto.colunas.map((c) => c.titulo)), dados.length,
    conteudo.length, conjunto.sensivel, Date.now() - inicio,
    contexto.usuarioId ?? null, contexto.ip ?? null]);

  // Secao 40: exportacao sensivel vai para a auditoria, com quem e quando.
  if (conjunto.sensivel) {
    await query(`
      INSERT INTO auditoria (usuario_id, tabela, registro_id, acao, valor_novo, ip, origem)
      VALUES ($1, 'exportacoes', $2, 'EXPORTACAO'::acao_auditoria_enum, $3::jsonb, $4,
              'integracao:exportacao')`,
    [contexto.usuarioId ?? null, Number(registro[0]!.id),
      JSON.stringify({
        conjunto: conjunto.codigo, formato, linhas: dados.length,
        colunas: conjunto.colunas.map((c) => c.campo),
      }),
      contexto.ip ?? null]);
  }

  return {
    id: Number(registro[0]!.id),
    nome_arquivo: nomeArquivo,
    formato,
    tipo_conteudo: tipoConteudo,
    conteudo,
    linhas: dados.length,
    truncado,
    ...(truncado ? {
      aviso: `A consulta passou de ${limite} linhas e o arquivo foi cortado nesse `
        + 'ponto. Use filtros para exportar em partes.',
    } : {}),
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const escaparCsv = (valor: unknown): string => {
  if (valor === null || valor === undefined) return '';
  const s = valor instanceof Date ? valor.toISOString().slice(0, 10) : String(valor);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function gerarCsv(colunas: Coluna[], dados: Record<string, unknown>[]): Buffer {
  const linhas = [colunas.map((c) => escaparCsv(c.titulo)).join(';')];
  for (const linha of dados) {
    linhas.push(colunas.map((c) => escaparCsv(linha[c.campo])).join(';'));
  }
  // BOM porque o Excel em portugues abre UTF-8 sem BOM como Latin-1, e todo
  // acento vira simbolo. Um arquivo ilegivel e pior que nenhum arquivo.
  return Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(linhas.join('\r\n'), 'utf8'),
  ]);
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

const escaparXml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c] ?? c))
    // Caractere de controle invalido em XML derruba o Excel na abertura.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const referenciaColuna = (indice: number): string => {
  let n = indice + 1;
  let ref = '';
  while (n > 0) {
    const resto = (n - 1) % 26;
    ref = String.fromCharCode(65 + resto) + ref;
    n = Math.floor((n - resto) / 26);
  }
  return ref;
};

async function gerarXlsx(
  colunas: Coluna[], dados: Record<string, unknown>[],
): Promise<Buffer> {
  const linhasXml: string[] = [];

  linhasXml.push(`<row r="1">${colunas.map((c, i) =>
    `<c r="${referenciaColuna(i)}1" t="inlineStr" s="1">`
    + `<is><t>${escaparXml(c.titulo)}</t></is></c>`).join('')}</row>`);

  for (const [indice, linha] of dados.entries()) {
    const numero = indice + 2;
    const celulas = colunas.map((coluna, i) => {
      const valor = linha[coluna.campo];
      const ref = `${referenciaColuna(i)}${numero}`;
      if (valor === null || valor === undefined) return '';

      const ehNumero = (coluna.tipo === 'numero' || coluna.tipo === 'moeda')
        && valor !== '' && Number.isFinite(Number(valor));

      if (ehNumero) return `<c r="${ref}"><v>${Number(valor)}</v></c>`;

      const texto = valor instanceof Date
        ? valor.toISOString().slice(0, 10) : String(valor);
      return `<c r="${ref}" t="inlineStr"><is><t>${escaparXml(texto)}</t></is></c>`;
    }).join('');
    linhasXml.push(`<row r="${numero}">${celulas}</row>`);
  }

  const larguras = colunas.map((c, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${Math.min(Math.max(c.titulo.length + 6, 12), 50)}" customWidth="1"/>`).join('');

  const planilha = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<cols>${larguras}</cols>`
    // A linha de cabecalho fica congelada: uma planilha de mil linhas sem isso
    // obriga a rolar de volta toda vez para lembrar de que coluna e o numero.
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" '
    + 'activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `<sheetData>${linhasXml.join('')}</sheetData></worksheet>`;

  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets><sheet name="Dados" sheetId="1" r:id="rId1"/></sheets></workbook>';

  const estilos = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
    + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill>'
    + '<fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFE8E8E8"/>'
    + '<bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" '
    + 'applyFill="1"/></cellXfs></styleSheet>';

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '</Types>';

  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>';

  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>';

  return montarZip([
    { nome: '[Content_Types].xml', conteudo: contentTypes },
    { nome: '_rels/.rels', conteudo: rels },
    { nome: 'xl/workbook.xml', conteudo: workbook },
    { nome: 'xl/_rels/workbook.xml.rels', conteudo: workbookRels },
    { nome: 'xl/styles.xml', conteudo: estilos },
    { nome: 'xl/worksheets/sheet1.xml', conteudo: planilha },
  ]);
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

const TABELA_CRC = (() => {
  const tabela = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[i] = c;
  }
  return tabela;
})();

function crc32(buffer: Buffer): number {
  let c = -1;
  for (const byte of buffer) c = TABELA_CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

async function montarZip(
  arquivos: Array<{ nome: string; conteudo: string }>,
): Promise<Buffer> {
  const partes: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const arquivo of arquivos) {
    const dados = Buffer.from(arquivo.conteudo, 'utf8');
    const comprimido = await comprimir(dados);
    const nome = Buffer.from(arquivo.nome, 'utf8');
    const crc = crc32(dados);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // versao necessaria
    local.writeUInt16LE(0, 6);            // sem sinalizadores
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt16LE(0, 10);           // hora
    local.writeUInt16LE(0x2821, 12);      // data (2000-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28);

    partes.push(local, nome, comprimido);

    const entrada = Buffer.alloc(46);
    entrada.writeUInt32LE(0x02014b50, 0);
    entrada.writeUInt16LE(20, 4);
    entrada.writeUInt16LE(20, 6);
    entrada.writeUInt16LE(0, 8);
    entrada.writeUInt16LE(8, 10);
    entrada.writeUInt16LE(0, 12);
    entrada.writeUInt16LE(0x2821, 14);
    entrada.writeUInt32LE(crc, 16);
    entrada.writeUInt32LE(comprimido.length, 20);
    entrada.writeUInt32LE(dados.length, 24);
    entrada.writeUInt16LE(nome.length, 28);
    entrada.writeUInt32LE(0, 42);
    entrada.writeUInt32LE(offset, 42);
    central.push(entrada, nome);

    offset += local.length + nome.length + comprimido.length;
  }

  const diretorio = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(offset, 16);

  return Buffer.concat([...partes, diretorio, fim]);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const escaparPdf = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    // O PDF basico usa WinAnsi; caractere fora disso vira "?" em vez de
    // corromper o arquivo inteiro.
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

/**
 * PDF de listagem, em retrato, sem biblioteca.
 *
 * Deliberadamente simples: cabecalho, linhas e paginacao. PDF e o formato de
 * LEITURA - quem vai trabalhar com o dado exporta XLSX ou CSV. Tentar
 * reproduzir aqui a riqueza de uma planilha seria gastar muito para entregar
 * uma planilha pior.
 */
function gerarPdf(conjunto: Conjunto, dados: Record<string, unknown>[]): Buffer {
  const largura = 842;   // A4 paisagem
  const altura = 595;
  const margem = 30;
  const linhasPorPagina = 32;

  const colunas = conjunto.colunas.slice(0, 8);
  const larguraColuna = (largura - margem * 2) / colunas.length;

  const paginas: string[] = [];
  const totalPaginas = Math.max(1, Math.ceil(dados.length / linhasPorPagina));

  for (let p = 0; p < totalPaginas; p += 1) {
    const fatia = dados.slice(p * linhasPorPagina, (p + 1) * linhasPorPagina);
    const linhas: string[] = [];

    linhas.push('BT /F2 13 Tf 1 0 0 1 '
      + `${margem} ${altura - margem} Tm (${escaparPdf(conjunto.nome)}) Tj ET`);
    linhas.push('BT /F1 8 Tf 1 0 0 1 '
      + `${margem} ${altura - margem - 14} Tm `
      + `(${escaparPdf(`Gerado em ${new Date().toLocaleString('pt-BR')} - `
        + `${dados.length} linha(s) - pagina ${p + 1} de ${totalPaginas}`)}) Tj ET`);

    let y = altura - margem - 38;
    linhas.push(`0.9 0.9 0.9 rg ${margem} ${y - 4} ${largura - margem * 2} 16 re f 0 0 0 rg`);

    colunas.forEach((c, i) => {
      linhas.push('BT /F2 8 Tf 1 0 0 1 '
        + `${margem + i * larguraColuna + 3} ${y} Tm `
        + `(${escaparPdf(c.titulo.slice(0, 18))}) Tj ET`);
    });

    y -= 18;
    for (const linha of fatia) {
      colunas.forEach((c, i) => {
        const bruto = linha[c.campo];
        const texto = bruto === null || bruto === undefined ? ''
          : bruto instanceof Date ? bruto.toISOString().slice(0, 10)
            : String(bruto);
        linhas.push('BT /F1 7 Tf 1 0 0 1 '
          + `${margem + i * larguraColuna + 3} ${y} Tm `
          + `(${escaparPdf(texto.slice(0, 22))}) Tj ET`);
      });
      y -= 14;
    }

    paginas.push(linhas.join('\n'));
  }

  const objetos: string[] = [];
  const kids = paginas.map((_, i) => `${4 + i * 2} 0 R`).join(' ');

  objetos.push('<< /Type /Catalog /Pages 2 0 R >>');
  objetos.push(`<< /Type /Pages /Kids [${kids}] /Count ${paginas.length} >>`);
  objetos.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  for (const conteudo of paginas) {
    objetos.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${largura} ${altura}] `
      + `/Resources << /Font << /F1 3 0 R /F2 ${3 + paginas.length * 2 + 1} 0 R >> >> `
      + `/Contents ${objetos.length + 2} 0 R >>`);
    objetos.push(`<< /Length ${Buffer.byteLength(conteudo, 'latin1')} >>\nstream\n${conteudo}\nendstream`);
  }

  objetos.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  let pdf = '%PDF-1.4\n';
  const posicoes: number[] = [];
  for (const [i, objeto] of objetos.entries()) {
    posicoes.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${objeto}\nendobj\n`;
  }

  const inicioXref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const pos of posicoes) pdf += `${String(pos).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\n`
    + `startxref\n${inicioXref}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

// ---------------------------------------------------------------------------
// Historico
// ---------------------------------------------------------------------------

export async function historico(filtro: {
  sensivel?: boolean; usuario_id?: number; limite?: number;
}) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  if (filtro.sensivel !== undefined) {
    valores.push(filtro.sensivel);
    cond.push(`e.sensivel = $${valores.length}`);
  }
  if (filtro.usuario_id) {
    valores.push(filtro.usuario_id);
    cond.push(`e.usuario_id = $${valores.length}`);
  }
  valores.push(Math.min(Math.max(filtro.limite ?? 50, 1), 200));

  const { rows } = await query(`
    SELECT e.id, e.entidade, e.formato::text AS formato, e.nome_arquivo,
           e.total_linhas, e.tamanho_bytes, e.sensivel, e.duracao_ms,
           e.created_at, u.nome AS usuario
      FROM exportacoes e LEFT JOIN usuarios u ON u.id = e.usuario_id
     ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
     ORDER BY e.created_at DESC LIMIT $${valores.length}`, valores);
  return rows;
}

export const impressaoDigital = (conteudo: Buffer): string =>
  createHash('sha256').update(conteudo).digest('hex').slice(0, 16);
