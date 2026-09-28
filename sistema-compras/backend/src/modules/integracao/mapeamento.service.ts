/**
 * Data mapping: campo externo -> transformacao -> campo interno (secoes 12 e 26).
 *
 * O mapeamento e a fronteira entre "o que o outro sistema chama de coisa" e "o
 * que o nosso banco chama". Tres decisoes:
 *
 * 1. **O mapeamento e DADO, nao codigo.** Um layout novo de planilha entra pela
 *    tela; nenhum modulo de negocio e recompilado. E o que a secao 6 pede ao
 *    exigir que novas integracoes entrem sem alterar os modulos.
 *
 * 2. **A coluna e casada sem depender de grafia exata.** `COD_PROD`, `cod prod`
 *    e `Cod. Prod` sao a mesma coluna. Exigir grafia exata faria o usuario
 *    remapear 23 colunas porque o ERP passou a exportar com acento.
 *
 * 3. **Campo desconhecido e reportado, nunca descartado em silencio.** Uma
 *    coluna nova no arquivo pode ser informacao que passou a existir; sumir com
 *    ela e perder o aviso.
 */
import { createHash } from 'node:crypto';
import { query } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import * as norma from './normalizacao.js';

export interface Mapeamento {
  id: number;
  campo_externo: string;
  campo_interno: string;
  transformacao: string | null;
  parametros: Record<string, unknown>;
  obrigatorio: boolean;
  valor_padrao: string | null;
  ordem: number;
}

export interface Template {
  id: number;
  codigo: string;
  nome: string;
  entidade: string;
  formato: string | null;
  linha_cabecalho: number;
  separador: string | null;
  codificacao: string;
  configuracao: Record<string, unknown>;
  mapeamentos: Mapeamento[];
}

/**
 * Forma canonica de um nome de coluna, para o casamento tolerante.
 *
 * Remove acento, pontuacao e separadores: `Cod. Produto`, `COD_PRODUTO` e
 * `codproduto` viram a mesma chave.
 */
export const canonico = (nome: string): string =>
  String(nome)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

export async function obterTemplate(codigoOuId: string | number): Promise<Template> {
  const porId = typeof codigoOuId === 'number';
  const { rows } = await query<Record<string, unknown>>(`
    SELECT id, codigo, nome, entidade, formato::text AS formato, linha_cabecalho,
           separador, codificacao, configuracao
      FROM integracao_templates
     WHERE ${porId ? 'id = $1' : 'upper(codigo) = upper($1)'} AND ativo`,
  [codigoOuId]);

  const t = rows[0];
  if (!t) throw naoEncontrado(`Template ${codigoOuId}`);

  const { rows: mapas } = await query<Record<string, unknown>>(`
    SELECT id, campo_externo, campo_interno, transformacao, parametros,
           obrigatorio, valor_padrao, ordem
      FROM integracao_mapeamentos
     WHERE template_id = $1
     ORDER BY ordem, id`, [Number(t.id)]);

  return {
    id: Number(t.id),
    codigo: String(t.codigo),
    nome: String(t.nome),
    entidade: String(t.entidade),
    formato: (t.formato as string) ?? null,
    linha_cabecalho: Number(t.linha_cabecalho),
    separador: (t.separador as string) ?? null,
    codificacao: String(t.codificacao),
    configuracao: (t.configuracao as Record<string, unknown>) ?? {},
    mapeamentos: mapas.map((m) => ({
      id: Number(m.id),
      campo_externo: String(m.campo_externo),
      campo_interno: String(m.campo_interno),
      transformacao: (m.transformacao as string) ?? null,
      parametros: (m.parametros as Record<string, unknown>) ?? {},
      obrigatorio: Boolean(m.obrigatorio),
      valor_padrao: (m.valor_padrao as string) ?? null,
      ordem: Number(m.ordem),
    })),
  };
}

// ---------------------------------------------------------------------------
// Casamento de colunas
// ---------------------------------------------------------------------------

export interface Casamento {
  /** campo_externo do mapeamento -> nome da coluna como veio no arquivo. */
  encontradas: Map<string, string>;
  /** Mapeados e ausentes no arquivo. */
  faltando: string[];
  /** Colunas do arquivo sem mapeamento. */
  desconhecidas: string[];
  /** Obrigatorios ausentes: impedem o processamento. */
  obrigatorios_ausentes: string[];
}

export function casarColunas(template: Template, colunas: string[]): Casamento {
  const porCanonico = new Map<string, string>();
  for (const coluna of colunas) {
    const chave = canonico(coluna);
    if (chave && !porCanonico.has(chave)) porCanonico.set(chave, coluna);
  }

  const encontradas = new Map<string, string>();
  const faltando: string[] = [];
  const obrigatoriosAusentes: string[] = [];
  const usadas = new Set<string>();

  for (const m of template.mapeamentos) {
    const chave = canonico(m.campo_externo);
    const coluna = porCanonico.get(chave);
    if (coluna) {
      encontradas.set(m.campo_externo, coluna);
      usadas.add(chave);
    } else {
      faltando.push(m.campo_externo);
      // Valor padrao supre a ausencia; sem ele, o obrigatorio barra o arquivo.
      if (m.obrigatorio && m.valor_padrao === null) obrigatoriosAusentes.push(m.campo_externo);
    }
  }

  const desconhecidas = colunas.filter((c) => canonico(c) && !usadas.has(canonico(c)));

  return {
    encontradas,
    faltando,
    desconhecidas,
    obrigatorios_ausentes: obrigatoriosAusentes,
  };
}

/**
 * Sugere mapeamento para colunas ainda nao mapeadas (secao 36).
 *
 * E uma SUGESTAO, deliberadamente conservadora: so casa o que e obvio pela
 * forma canonica ou por sinonimo conhecido. Adivinhar com folga produziria
 * mapeamento errado que passa despercebido - e mapear quantidade na coluna de
 * preco e um erro que so aparece no relatorio gerencial do mes seguinte.
 */
const SINONIMOS: Record<string, string[]> = {
  'produto.codigo': ['CODPRODUTO', 'CODPROD', 'CODIGOPRODUTO', 'SKU', 'ITEM',
    'CODITEM', 'REFERENCIA', 'COD'],
  'produto.descricao': ['DESCRICAO', 'DESCPROD', 'DESCRICAOPRODUTO', 'PRODUTO',
    'NOME', 'NOMEPRODUTO', 'DESC'],
  'produto.ean': ['EAN', 'CODIGOBARRAS', 'GTIN', 'CODBARRAS'],
  'fornecedor.cnpj': ['CNPJ', 'CNPJFORNECEDOR', 'DOCUMENTO', 'CNPJCPF'],
  'fornecedor.nome': ['FORNECEDOR', 'RAZAOSOCIAL', 'NOMEFORNECEDOR', 'FANTASIA'],
  'item.quantidade': ['QTDE', 'QTD', 'QUANTIDADE', 'QUANT'],
  'item.preco_unitario': ['PRECO', 'PRECOUNITARIO', 'VALORUNITARIO', 'VLRUNIT',
    'VALORMEDIO', 'PRECOUNIT'],
  'item.valor_total': ['TOTAL', 'VALORTOTAL', 'VLRTOTAL'],
  'venda.data_venda': ['DATA', 'DTFATURAMENTO', 'DATAVENDA', 'DTVENDA', 'EMISSAO'],
  'venda.numero_documento': ['NUMNF', 'NOTA', 'NUMERONOTA', 'DOCUMENTO', 'NF'],
  'item.numero_lote': ['NUMLOTE', 'LOTE'],
  'item.data_validade': ['VALIDADE', 'VALIDADECP', 'DTVALIDADE'],
  'cliente.cidade': ['CIDADE', 'MUNICIPIO'],
  'cliente.estado': ['ESTADO', 'UF'],
  'produto.unidade': ['UNIDADE', 'UN', 'UNIDADEMEDIDA', 'UM'],
};

const TRANSFORMACAO_SUGERIDA: Record<string, string> = {
  'produto.codigo': 'texto_maiusculo',
  'produto.ean': 'ean',
  'fornecedor.cnpj': 'cnpj',
  'item.quantidade': 'decimal',
  'item.preco_unitario': 'decimal',
  'item.valor_total': 'decimal',
  'venda.data_venda': 'data',
  'item.data_validade': 'data',
  'cliente.estado': 'uf',
  'produto.unidade': 'unidade',
};

export function sugerirMapeamento(colunas: string[]): Array<{
  campo_externo: string; campo_interno: string; transformacao: string;
  confianca: 'ALTA' | 'MEDIA';
}> {
  const sugestoes: Array<{
    campo_externo: string; campo_interno: string; transformacao: string;
    confianca: 'ALTA' | 'MEDIA';
  }> = [];

  for (const coluna of colunas) {
    const chave = canonico(coluna);
    if (!chave) continue;

    for (const [interno, nomes] of Object.entries(SINONIMOS)) {
      const exato = nomes.includes(chave);
      // Parcial exige um nome longo para nao casar "COD" com tudo.
      const parcial = !exato && nomes.some(
        (n) => n.length >= 5 && (chave.includes(n) || n.includes(chave)));

      if (exato || parcial) {
        sugestoes.push({
          campo_externo: coluna,
          campo_interno: interno,
          transformacao: TRANSFORMACAO_SUGERIDA[interno] ?? 'texto',
          confianca: exato ? 'ALTA' : 'MEDIA',
        });
        break;
      }
    }
  }
  return sugestoes;
}

// ---------------------------------------------------------------------------
// Aplicacao linha a linha
// ---------------------------------------------------------------------------

export interface Ocorrencia {
  coluna?: string;
  campo?: string;
  severidade: 'ERRO' | 'ALERTA' | 'INFO';
  regra: string;
  mensagem: string;
  valor?: string;
}

export interface LinhaMapeada {
  valido: boolean;
  dados: Record<string, unknown>;
  ocorrencias: Ocorrencia[];
}

/**
 * Transforma uma linha crua no registro interno.
 *
 * Nunca lanca: devolve o que conseguiu e a lista do que deu errado. Uma linha
 * ruim no meio de quatrocentas mil nao pode derrubar a importacao inteira -
 * ela entra no relatorio de erros e o arquivo segue.
 */
export function aplicarLinha(
  template: Template, casamento: Casamento, linha: Record<string, unknown>,
): LinhaMapeada {
  const dados: Record<string, unknown> = {};
  const ocorrencias: Ocorrencia[] = [];
  let valido = true;

  for (const m of template.mapeamentos) {
    const coluna = casamento.encontradas.get(m.campo_externo);
    const bruto = coluna !== undefined ? linha[coluna] : undefined;

    const ausente = bruto === undefined || bruto === null
      || (typeof bruto === 'string' && bruto.trim() === '');

    if (ausente && m.valor_padrao !== null) {
      dados[m.campo_interno] = m.valor_padrao;
      continue;
    }

    if (ausente && m.obrigatorio) {
      valido = false;
      ocorrencias.push({
        coluna: m.campo_externo,
        campo: m.campo_interno,
        severidade: 'ERRO',
        regra: 'obrigatorio',
        mensagem: `Campo obrigatorio "${m.campo_externo}" vazio`,
      });
      continue;
    }

    if (ausente) {
      dados[m.campo_interno] = null;
      continue;
    }

    const resultado = norma.aplicar(m.transformacao, bruto, {
      ...m.parametros,
      obrigatorio: m.obrigatorio,
    });

    if (!resultado.ok) {
      // Falha de transformacao em campo opcional NAO invalida a linha: o dado
      // vai nulo e a ocorrencia vira alerta. Perder a venda inteira porque a
      // data de validade veio bagunçada seria desproporcional.
      if (m.obrigatorio) {
        valido = false;
        ocorrencias.push({
          coluna: m.campo_externo,
          campo: m.campo_interno,
          severidade: 'ERRO',
          regra: m.transformacao ?? 'texto',
          mensagem: resultado.erro ?? 'Valor invalido',
          valor: String(bruto).slice(0, 80),
        });
      } else {
        dados[m.campo_interno] = null;
        ocorrencias.push({
          coluna: m.campo_externo,
          campo: m.campo_interno,
          severidade: 'ALERTA',
          regra: m.transformacao ?? 'texto',
          mensagem: `${resultado.erro ?? 'Valor invalido'} (campo opcional: gravado vazio)`,
          valor: String(bruto).slice(0, 80),
        });
      }
      continue;
    }

    dados[m.campo_interno] = resultado.valor;
    if (resultado.alerta) {
      ocorrencias.push({
        coluna: m.campo_externo,
        campo: m.campo_interno,
        severidade: 'ALERTA',
        regra: m.transformacao ?? 'texto',
        mensagem: resultado.alerta,
        valor: String(bruto).slice(0, 80),
      });
    }
  }

  return { valido, dados, ocorrencias };
}

// ---------------------------------------------------------------------------
// Chave natural e hash (secoes 14 e 28)
// ---------------------------------------------------------------------------

/**
 * Monta a chave que identifica o registro no sistema de ORIGEM.
 *
 * Usa os campos EXTERNOS, nao os internos: a chave precisa ser estavel mesmo
 * que o mapeamento mude. Valor ausente vira `-` em vez de sumir, senao duas
 * chaves diferentes poderiam colapsar numa so.
 */
export function chaveNatural(
  template: Template, linha: Record<string, unknown>, casamento: Casamento,
): string | null {
  const campos = template.configuracao.chave_natural;
  if (!Array.isArray(campos) || campos.length === 0) return null;

  const partes = campos.map((campo) => {
    const coluna = casamento.encontradas.get(String(campo)) ?? String(campo);
    const valor = linha[coluna];
    return valor === undefined || valor === null || String(valor).trim() === ''
      ? '-' : String(valor).trim();
  });

  return partes.every((p) => p === '-') ? null : partes.join('|');
}

/**
 * Hash do conteudo, para saber se o registro MUDOU (secao 14).
 *
 * Calculado sobre os dados JA NORMALIZADOS e com as chaves ordenadas: assim
 * `1.234,56` e `1234.56` dao o mesmo hash, e o ERP mudar a ordem das colunas
 * nao faz a base inteira parecer alterada.
 */
export function hashConteudo(dados: Record<string, unknown>): string {
  const ordenado = Object.keys(dados).sort()
    .map((k) => `${k}=${dados[k] === null || dados[k] === undefined ? '' : String(dados[k])}`)
    .join('\u0001');
  // 32 caracteres bastam: o hash so precisa distinguir versoes do MESMO
  // registro, ja isolado pela chave natural, nao o universo inteiro.
  return createHash('sha256').update(ordenado, 'utf8').digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Cadastro de template e mapeamento
// ---------------------------------------------------------------------------

export interface EntradaTemplate {
  codigo: string;
  nome: string;
  descricao?: string | null;
  entidade: string;
  formato?: string | null;
  integracao_id?: number | null;
  linha_cabecalho?: number;
  separador?: string | null;
  codificacao?: string;
  configuracao?: Record<string, unknown>;
  mapeamentos: Array<{
    campo_externo: string;
    campo_interno: string;
    transformacao?: string | null;
    parametros?: Record<string, unknown>;
    obrigatorio?: boolean;
    valor_padrao?: string | null;
  }>;
}

export async function salvarTemplate(
  entrada: EntradaTemplate, usuarioId: number | null,
): Promise<{ id: number; codigo: string; campos: number }> {
  for (const m of entrada.mapeamentos) {
    if (m.transformacao && !norma.transformacaoExiste(m.transformacao)) {
      throw regraNegocio(
        `Transformacao desconhecida "${m.transformacao}" no campo ${m.campo_externo}. `
        + `Disponiveis: ${norma.catalogo().map((t) => t.nome).join(', ')}`);
    }
  }

  const externos = entrada.mapeamentos.map((m) => canonico(m.campo_externo));
  const repetido = externos.find((e, i) => externos.indexOf(e) !== i);
  if (repetido) {
    throw regraNegocio(
      `A coluna "${repetido}" foi mapeada duas vezes. Qual venceria dependeria `
      + 'da ordem de leitura, entao o cadastro e recusado.');
  }

  const { rows } = await query<{ id: string }>(`
    INSERT INTO integracao_templates
      (codigo, nome, descricao, entidade, formato, integracao_id, linha_cabecalho,
       separador, codificacao, configuracao, created_by)
    VALUES ($1, $2, $3, $4, $5::formato_arquivo_enum, $6, $7, $8, $9, $10::jsonb, $11)
    ON CONFLICT DO NOTHING
    RETURNING id`,
  [entrada.codigo, entrada.nome, entrada.descricao ?? null, entrada.entidade,
    entrada.formato ?? null, entrada.integracao_id ?? null,
    entrada.linha_cabecalho ?? 1, entrada.separador ?? null,
    entrada.codificacao ?? 'utf8',
    JSON.stringify(entrada.configuracao ?? {}), usuarioId]);

  let id: number;
  if (rows.length) {
    id = Number(rows[0]!.id);
  } else {
    // Template ja existe: atualiza e troca os mapeamentos inteiros. Trocar
    // tudo evita o estado meio-novo-meio-velho de um merge campo a campo.
    const { rows: existente } = await query<{ id: string }>(
      'SELECT id FROM integracao_templates WHERE upper(codigo) = upper($1)',
      [entrada.codigo]);
    if (!existente.length) throw regraNegocio('Nao foi possivel salvar o template');
    id = Number(existente[0]!.id);

    await query(`
      UPDATE integracao_templates
         SET nome = $2, descricao = $3, entidade = $4,
             formato = $5::formato_arquivo_enum, linha_cabecalho = $6,
             separador = $7, codificacao = $8, configuracao = $9::jsonb, ativo = true
       WHERE id = $1`,
    [id, entrada.nome, entrada.descricao ?? null, entrada.entidade,
      entrada.formato ?? null, entrada.linha_cabecalho ?? 1,
      entrada.separador ?? null, entrada.codificacao ?? 'utf8',
      JSON.stringify(entrada.configuracao ?? {})]);

    await query('DELETE FROM integracao_mapeamentos WHERE template_id = $1', [id]);
  }

  for (const [i, m] of entrada.mapeamentos.entries()) {
    await query(`
      INSERT INTO integracao_mapeamentos
        (template_id, campo_externo, campo_interno, transformacao, parametros,
         obrigatorio, valor_padrao, ordem)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
    [id, m.campo_externo, m.campo_interno, m.transformacao ?? null,
      JSON.stringify(m.parametros ?? {}), m.obrigatorio ?? false,
      m.valor_padrao ?? null, i + 1]);
  }

  return { id, codigo: entrada.codigo, campos: entrada.mapeamentos.length };
}

export async function listarTemplates(filtro: { entidade?: string } = {}) {
  const { rows } = await query(`
    SELECT t.id, t.codigo, t.nome, t.descricao, t.entidade,
           t.formato::text AS formato, t.linha_cabecalho, t.ativo, t.vezes_usado,
           i.codigo AS integracao, count(m.id) AS campos, t.configuracao
      FROM integracao_templates t
      LEFT JOIN integracoes i ON i.id = t.integracao_id
      LEFT JOIN integracao_mapeamentos m ON m.template_id = t.id
     ${filtro.entidade ? 'WHERE t.entidade = $1' : ''}
     GROUP BY t.id, i.codigo
     ORDER BY t.entidade, t.codigo`,
  filtro.entidade ? [filtro.entidade] : []);

  return rows.map((r) => {
    const t = r as Record<string, unknown>;
    return { ...t, campos: Number(t.campos), vezes_usado: Number(t.vezes_usado) };
  });
}
