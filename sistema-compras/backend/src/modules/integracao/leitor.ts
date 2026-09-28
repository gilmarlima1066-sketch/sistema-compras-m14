/**
 * Leitura de XLSX e CSV em streaming (secao 11).
 *
 * Por que um leitor proprio em vez de uma biblioteca:
 *
 * As bibliotecas comuns de XLSX carregam a planilha inteira em memoria antes de
 * devolver a primeira linha. Os arquivos reais desta empresa tem 426 mil linhas
 * e 50 MB comprimidos - descomprimidos, o XML da planilha passa de 1 GB. Ler
 * assim derruba o processo, e derrubaria justamente na importacao grande, que e
 * quando ninguem esta olhando.
 *
 * O formato XLSX e um ZIP com XML dentro, e o XML e sequencial: linha a linha,
 * celula a celula. Dá para percorrer com um analisador de texto simples sem
 * nunca ter mais de uma linha na memoria. E o que este modulo faz.
 *
 * O preco: nao interpretamos formula, formatacao condicional nem grafico. Para
 * relatorio exportado de ERP - que e o caso - isso nao existe. Se um dia
 * precisar, a limitacao esta escrita aqui.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createInflateRaw } from 'node:zlib';
import { Readable } from 'node:stream';
import { regraNegocio } from '../../core/errors.js';

export interface LinhaLida {
  numero: number;
  valores: Record<string, unknown>;
}

export interface ResultadoLeitura {
  colunas: string[];
  total_linhas: number;
  truncado: boolean;
}

// ===========================================================================
// ZIP: localizar e descomprimir uma entrada sem extrair o arquivo todo
// ===========================================================================

interface EntradaZip {
  nome: string;
  offsetCabecalho: number;
  tamanhoComprimido: number;
  tamanhoOriginal: number;
  metodo: number;
}

/**
 * Le o diretorio central do ZIP, que fica no FIM do arquivo.
 *
 * Ler do fim e o que permite achar uma entrada de 200 MB sem percorrer os
 * 200 MB: o diretorio diz exatamente em que byte cada arquivo comeca.
 */
async function lerDiretorio(caminho: string): Promise<Map<string, EntradaZip>> {
  const arquivo = await open(caminho, 'r');
  try {
    const { size } = await arquivo.stat();

    // O comentario final do ZIP pode ter ate 64 KB; o EOCD vem antes dele.
    const tamanhoCauda = Math.min(size, 66_000);
    const cauda = Buffer.alloc(tamanhoCauda);
    await arquivo.read(cauda, 0, tamanhoCauda, size - tamanhoCauda);

    let posEocd = -1;
    for (let i = cauda.length - 22; i >= 0; i -= 1) {
      if (cauda.readUInt32LE(i) === 0x06054b50) { posEocd = i; break; }
    }
    if (posEocd < 0) throw regraNegocio('Arquivo nao e um XLSX valido (ZIP sem indice)');

    let totalEntradas = cauda.readUInt16LE(posEocd + 10);
    let tamanhoDiretorio = cauda.readUInt32LE(posEocd + 12);
    let inicioDiretorio = cauda.readUInt32LE(posEocd + 16);

    // ZIP64: arquivos grandes marcam os campos com 0xFFFFFFFF e guardam os
    // valores reais num registro proprio, logo antes do EOCD.
    if (inicioDiretorio === 0xffffffff || totalEntradas === 0xffff) {
      let posLocator = -1;
      for (let i = posEocd - 20; i >= 0; i -= 1) {
        if (cauda.readUInt32LE(i) === 0x07064b50) { posLocator = i; break; }
      }
      if (posLocator < 0) throw regraNegocio('XLSX em formato ZIP64 sem localizador');

      const offsetEocd64 = Number(cauda.readBigUInt64LE(posLocator + 8));
      const eocd64 = Buffer.alloc(56);
      await arquivo.read(eocd64, 0, 56, offsetEocd64);
      totalEntradas = Number(eocd64.readBigUInt64LE(32));
      tamanhoDiretorio = Number(eocd64.readBigUInt64LE(40));
      inicioDiretorio = Number(eocd64.readBigUInt64LE(48));
    }

    const diretorio = Buffer.alloc(tamanhoDiretorio);
    await arquivo.read(diretorio, 0, tamanhoDiretorio, inicioDiretorio);

    const entradas = new Map<string, EntradaZip>();
    let p = 0;
    for (let i = 0; i < totalEntradas && p + 46 <= diretorio.length; i += 1) {
      if (diretorio.readUInt32LE(p) !== 0x02014b50) break;

      const metodo = diretorio.readUInt16LE(p + 10);
      let tamanhoComprimido = diretorio.readUInt32LE(p + 20);
      let tamanhoOriginal = diretorio.readUInt32LE(p + 24);
      const tamNome = diretorio.readUInt16LE(p + 28);
      const tamExtra = diretorio.readUInt16LE(p + 30);
      const tamComentario = diretorio.readUInt16LE(p + 32);
      let offsetCabecalho = diretorio.readUInt32LE(p + 42);
      const nome = diretorio.toString('utf8', p + 46, p + 46 + tamNome);

      // Campo extra ZIP64 (0x0001) traz os tamanhos reais.
      if (tamanhoOriginal === 0xffffffff || tamanhoComprimido === 0xffffffff
          || offsetCabecalho === 0xffffffff) {
        let e = p + 46 + tamNome;
        const fim = e + tamExtra;
        while (e + 4 <= fim) {
          const id = diretorio.readUInt16LE(e);
          const tam = diretorio.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (tamanhoOriginal === 0xffffffff) {
              tamanhoOriginal = Number(diretorio.readBigUInt64LE(q)); q += 8;
            }
            if (tamanhoComprimido === 0xffffffff) {
              tamanhoComprimido = Number(diretorio.readBigUInt64LE(q)); q += 8;
            }
            if (offsetCabecalho === 0xffffffff) {
              offsetCabecalho = Number(diretorio.readBigUInt64LE(q));
            }
            break;
          }
          e += 4 + tam;
        }
      }

      entradas.set(nome, {
        nome, offsetCabecalho, tamanhoComprimido, tamanhoOriginal, metodo,
      });
      p += 46 + tamNome + tamExtra + tamComentario;
    }

    return entradas;
  } finally {
    await arquivo.close();
  }
}

/** Fluxo descomprimido de uma entrada, sem materializar o conteudo. */
async function fluxoEntrada(caminho: string, entrada: EntradaZip): Promise<Readable> {
  const arquivo = await open(caminho, 'r');
  // O cabecalho local repete nome e extra com tamanhos proprios; os dados
  // comecam depois dele.
  const cabecalho = Buffer.alloc(30);
  await arquivo.read(cabecalho, 0, 30, entrada.offsetCabecalho);
  const tamNome = cabecalho.readUInt16LE(26);
  const tamExtra = cabecalho.readUInt16LE(28);
  const inicioDados = entrada.offsetCabecalho + 30 + tamNome + tamExtra;
  await arquivo.close();

  const bruto = createReadStream(caminho, {
    start: inicioDados,
    end: inicioDados + entrada.tamanhoComprimido - 1,
    highWaterMark: 1 << 20,
  });

  if (entrada.metodo === 0) return bruto;        // guardado sem compressao
  if (entrada.metodo === 8) return bruto.pipe(createInflateRaw());
  throw regraNegocio(`Metodo de compressao ${entrada.metodo} nao suportado no XLSX`);
}

/** Percorre o fluxo devolvendo pedacos de texto. */
async function* pedacos(fluxo: Readable): AsyncGenerator<string> {
  let resto = '';
  for await (const bloco of fluxo) {
    resto += (bloco as Buffer).toString('utf8');
    // Corta em '>' para nunca partir uma tag ao meio entre dois blocos.
    const corte = resto.lastIndexOf('>');
    if (corte > 0) {
      yield resto.slice(0, corte + 1);
      resto = resto.slice(corte + 1);
    }
  }
  if (resto) yield resto;
}

// ===========================================================================
// XLSX
// ===========================================================================

const DESESCAPE: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

const desescapar = (s: string): string =>
  s.includes('&')
    ? s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => DESESCAPE[m] ?? m)
      .replace(/&#x?([0-9a-fA-F]+);/g, (_, c: string) =>
        String.fromCodePoint(parseInt(c, /^[0-9]+$/.test(c) ? 10 : 16)))
    : s;

/**
 * Carrega a tabela de textos compartilhados.
 *
 * O XLSX guarda cada texto uma vez e referencia por indice. Esta tabela
 * precisa ficar em memoria - nao da para consultar por indice em streaming -,
 * mas ela e a parte PEQUENA do arquivo: 426 mil linhas com repeticao de
 * produto e cliente produzem poucas dezenas de milhares de textos distintos.
 */
async function lerTextos(caminho: string, entrada: EntradaZip): Promise<string[]> {
  const textos: string[] = [];
  const fluxo = await fluxoEntrada(caminho, entrada);

  let buffer = '';
  let dentroSi = false;
  let atual = '';

  for await (const pedaco of pedacos(fluxo)) {
    buffer += pedaco;
    let pos = 0;

    for (;;) {
      if (!dentroSi) {
        const inicio = buffer.indexOf('<si>', pos);
        if (inicio < 0) {
          const inicioCurto = buffer.indexOf('<si/>', pos);
          if (inicioCurto >= 0) { textos.push(''); pos = inicioCurto + 5; continue; }
          break;
        }
        dentroSi = true;
        atual = '';
        pos = inicio + 4;
      }

      const fim = buffer.indexOf('</si>', pos);
      if (fim < 0) { atual += buffer.slice(pos); pos = buffer.length; break; }

      atual += buffer.slice(pos, fim);
      // Um <si> pode ter varios <t> (texto rico); concatenar todos e o certo.
      const partes = atual.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [];
      textos.push(desescapar(
        partes.map((t) => t.replace(/<t[^>]*>/, '').replace('</t>', '')).join('')));

      dentroSi = false;
      pos = fim + 5;
    }

    buffer = dentroSi ? '' : buffer.slice(pos);
  }

  return textos;
}

const colunaDaReferencia = (ref: string): number => {
  let n = 0;
  for (const c of ref) {
    const codigo = c.charCodeAt(0);
    if (codigo < 65 || codigo > 90) break;
    n = n * 26 + (codigo - 64);
  }
  return n - 1;
};

export interface OpcoesLeitura {
  linhaCabecalho?: number;
  maxLinhas?: number;
  /** Para so na quantidade pedida: usado na pre-visualizacao. */
  amostra?: number;
  separador?: string;
}

/**
 * Percorre o XLSX linha a linha.
 *
 * Devolve um gerador: quem consome decide se acumula, grava em lote ou
 * descarta. A importacao de 426 mil linhas grava de mil em mil e nunca tem
 * mais que isso na memoria.
 */
export async function* lerXlsx(
  caminho: string, opcoes: OpcoesLeitura = {},
): AsyncGenerator<LinhaLida, ResultadoLeitura, undefined> {
  const entradas = await lerDiretorio(caminho);

  const nomePlanilha = [...entradas.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  if (!nomePlanilha) throw regraNegocio('XLSX sem planilha legivel');

  const entradaTextos = entradas.get('xl/sharedStrings.xml');
  const textos = entradaTextos ? await lerTextos(caminho, entradaTextos) : [];

  const linhaCabecalho = opcoes.linhaCabecalho ?? 1;
  const maxLinhas = opcoes.maxLinhas ?? 1_000_000;

  const fluxo = await fluxoEntrada(caminho, entradas.get(nomePlanilha)!);

  let colunas: string[] = [];
  let numeroLinha = 0;
  let lidas = 0;
  let truncado = false;
  let buffer = '';

  for await (const pedaco of pedacos(fluxo)) {
    buffer += pedaco;
    let pos = 0;

    for (;;) {
      const inicio = buffer.indexOf('<row', pos);
      if (inicio < 0) break;

      const fim = buffer.indexOf('</row>', inicio);
      // Linha sem celula nenhuma: <row .../>
      if (fim < 0) {
        const fimCurto = buffer.indexOf('/>', inicio);
        const proximaTag = buffer.indexOf('<', inicio + 4);
        if (fimCurto > 0 && (proximaTag < 0 || fimCurto < proximaTag)) {
          numeroLinha += 1;
          pos = fimCurto + 2;
          continue;
        }
        break;
      }

      const xml = buffer.slice(inicio, fim);
      pos = fim + 6;
      numeroLinha += 1;

      const atributoR = /^<row[^>]*\sr="(\d+)"/.exec(xml);
      const indiceLinha = atributoR ? Number(atributoR[1]) : numeroLinha;

      const celulas = xml.match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) ?? [];
      const valores: unknown[] = [];

      for (const celula of celulas) {
        const refMatch = /\sr="([A-Z]+)\d+"/.exec(celula);
        const indice = refMatch ? colunaDaReferencia(refMatch[1]!) : valores.length;
        const tipo = /\st="([^"]+)"/.exec(celula)?.[1];

        let valor: unknown = null;
        if (tipo === 'inlineStr') {
          const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(celula);
          valor = t ? desescapar(t[1]!) : null;
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(celula);
          if (v) {
            const bruto = desescapar(v[1]!);
            if (tipo === 's') {
              valor = textos[Number(bruto)] ?? null;
            } else if (tipo === 'b') {
              valor = bruto === '1';
            } else if (tipo === 'e') {
              valor = null;            // erro de formula (#N/D): vira vazio
            } else {
              const n = Number(bruto);
              valor = Number.isFinite(n) ? n : bruto;
            }
          }
        }

        while (valores.length < indice) valores.push(null);
        valores[indice] = valor;
      }

      if (indiceLinha < linhaCabecalho) continue;

      if (indiceLinha === linhaCabecalho || (colunas.length === 0 && valores.length)) {
        colunas = valores.map((v, i) =>
          (v === null || v === undefined || String(v).trim() === ''
            ? `coluna_${i + 1}` : String(v).trim()));
        continue;
      }

      // Linha completamente vazia no meio do arquivo e separador visual, nao dado.
      if (valores.every((v) => v === null || v === undefined || String(v).trim() === '')) {
        continue;
      }

      const registro: Record<string, unknown> = {};
      for (const [i, nome] of colunas.entries()) registro[nome] = valores[i] ?? null;

      lidas += 1;
      yield { numero: indiceLinha, valores: registro };

      if (opcoes.amostra && lidas >= opcoes.amostra) {
        return { colunas, total_linhas: lidas, truncado: true };
      }
      if (lidas >= maxLinhas) {
        truncado = true;
        return { colunas, total_linhas: lidas, truncado };
      }
    }

    buffer = buffer.slice(pos);
  }

  return { colunas, total_linhas: lidas, truncado };
}

// ===========================================================================
// CSV
// ===========================================================================

/**
 * Divide a linha respeitando aspas.
 *
 * Nao da para usar `split`: descricao de produto tem virgula, e `"NOZES, EXTRA"`
 * e um campo so. Aspas duplas dentro do campo vem duplicadas, pelo padrao.
 */
export function dividirCsv(linha: string, separador: string): string[] {
  const campos: string[] = [];
  let atual = '';
  let dentroAspas = false;

  for (let i = 0; i < linha.length; i += 1) {
    const c = linha[i]!;
    if (dentroAspas) {
      if (c === '"') {
        if (linha[i + 1] === '"') { atual += '"'; i += 1; } else { dentroAspas = false; }
      } else {
        atual += c;
      }
    } else if (c === '"') {
      dentroAspas = true;
    } else if (c === separador) {
      campos.push(atual); atual = '';
    } else {
      atual += c;
    }
  }
  campos.push(atual);
  return campos.map((c) => c.trim());
}

/**
 * Detecta o separador contando ocorrencias fora de aspas.
 *
 * Exportacao brasileira usa ponto-e-virgula (porque a virgula e decimal); a
 * internacional usa virgula. Errar o separador faz o arquivo inteiro virar uma
 * coluna so, e o usuario ve "1 coluna detectada" sem entender por que.
 */
export function detectarSeparador(amostra: string): string {
  const candidatos = [';', ',', '\t', '|'];
  const linhas = amostra.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
  if (!linhas.length) return ';';

  let melhor = ';';
  let melhorNota = -1;

  for (const sep of candidatos) {
    const contagens = linhas.map((l) => dividirCsv(l, sep).length);
    const minimo = Math.min(...contagens);
    // O bom separador produz MAIS de uma coluna e o MESMO numero em toda linha.
    const consistente = contagens.every((c) => c === contagens[0]);
    const nota = minimo > 1 && consistente ? minimo : 0;
    if (nota > melhorNota) { melhorNota = nota; melhor = sep; }
  }
  return melhor;
}

export async function* lerCsv(
  caminho: string, opcoes: OpcoesLeitura = {},
): AsyncGenerator<LinhaLida, ResultadoLeitura, undefined> {
  let separador = opcoes.separador;
  if (!separador) {
    const arquivo = await open(caminho, 'r');
    const amostra = Buffer.alloc(8192);
    const { bytesRead } = await arquivo.read(amostra, 0, 8192, 0);
    await arquivo.close();
    separador = detectarSeparador(amostra.toString('utf8', 0, bytesRead));
  }

  const linhaCabecalho = opcoes.linhaCabecalho ?? 1;
  const maxLinhas = opcoes.maxLinhas ?? 1_000_000;

  const leitor = createInterface({
    input: createReadStream(caminho, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let colunas: string[] = [];
  let numero = 0;
  let lidas = 0;

  try {
    for await (const linha of leitor) {
      numero += 1;
      if (numero < linhaCabecalho) continue;

      // BOM no inicio do arquivo estraga o nome da primeira coluna.
      const limpa = numero === 1 ? linha.replace(/^﻿/, '') : linha;

      if (numero === linhaCabecalho) {
        colunas = dividirCsv(limpa, separador).map((c, i) =>
          (c.trim() === '' ? `coluna_${i + 1}` : c.trim()));
        continue;
      }

      if (!limpa.trim()) continue;

      const campos = dividirCsv(limpa, separador);
      const registro: Record<string, unknown> = {};
      for (const [i, nome] of colunas.entries()) {
        registro[nome] = campos[i] === undefined || campos[i] === '' ? null : campos[i];
      }

      lidas += 1;
      yield { numero, valores: registro };

      if (opcoes.amostra && lidas >= opcoes.amostra) {
        return { colunas, total_linhas: lidas, truncado: true };
      }
      if (lidas >= maxLinhas) {
        return { colunas, total_linhas: lidas, truncado: true };
      }
    }
  } finally {
    leitor.close();
  }

  return { colunas, total_linhas: lidas, truncado: false };
}

// ===========================================================================
// Fachada
// ===========================================================================

export type Formato = 'XLSX' | 'CSV';

export const formatoDoNome = (nome: string): Formato | null => {
  const ext = nome.toLowerCase().split('.').pop();
  if (ext === 'xlsx' || ext === 'xlsm') return 'XLSX';
  if (ext === 'csv' || ext === 'txt' || ext === 'tsv') return 'CSV';
  return null;
};

/**
 * Descobre o formato pelo CONTEUDO, nao pela extensao.
 *
 * A extensao vem do nome que o cliente enviou, e nome errado acontece o tempo
 * todo: a planilha salva como `.csv`, o export do ERP chamado `.txt`, o arquivo
 * renomeado a mao. Quando o nome mente, ler um XLSX como texto nao da erro -
 * produz lixo binario, e esse lixo vai parar na pre-visualizacao e no banco.
 * (Foi exatamente assim que um XLSX enviado como `x.csv` derrubou a insercao
 * com "unsupported Unicode escape sequence": o ZIP tem bytes nulos, e `jsonb`
 * nao aceita \u0000.)
 *
 * XLSX e um ZIP, e todo ZIP comeca com "PK\x03\x04". Quatro bytes respondem com
 * certeza o que o nome so sugere.
 */
export async function detectarFormato(
  caminho: string, nome?: string,
): Promise<Formato | null> {
  const arquivo = await open(caminho, 'r');
  try {
    const cabeca = Buffer.alloc(4);
    const { bytesRead } = await arquivo.read(cabeca, 0, 4, 0);
    if (bytesRead === 4
        && cabeca[0] === 0x50 && cabeca[1] === 0x4b
        && cabeca[2] === 0x03 && cabeca[3] === 0x04) {
      return 'XLSX';
    }
    // Nao e ZIP. Pode ser CSV de verdade, ou um formato que nao tratamos - e
    // ai o nome ajuda a recusar cedo, com mensagem melhor que "coluna
    // estranha".
    if (bytesRead > 0 && cabeca.includes(0)) return null;
    return nome ? formatoDoNome(nome) : 'CSV';
  } finally {
    await arquivo.close();
  }
}

export function ler(
  caminho: string, formato: Formato, opcoes: OpcoesLeitura = {},
): AsyncGenerator<LinhaLida, ResultadoLeitura, undefined> {
  return formato === 'XLSX' ? lerXlsx(caminho, opcoes) : lerCsv(caminho, opcoes);
}

/**
 * Le so o cabecalho e algumas linhas, para a etapa de identificacao de colunas.
 *
 * Existe separado porque abrir um arquivo de 50 MB para descobrir os nomes das
 * colunas nao precisa ler os 50 MB.
 */
export async function inspecionar(
  caminho: string, formato: Formato, opcoes: OpcoesLeitura = {},
): Promise<{ colunas: string[]; amostra: Record<string, unknown>[]; separador?: string }> {
  const gerador = ler(caminho, formato, { ...opcoes, amostra: opcoes.amostra ?? 20 });
  const amostra: Record<string, unknown>[] = [];

  let resultado = await gerador.next();
  while (!resultado.done) {
    amostra.push(resultado.value.valores);
    resultado = await gerador.next();
  }

  return { colunas: resultado.value.colunas, amostra };
}

/** SHA-256 do arquivo, para reconhecer reenvio antes de ler linha nenhuma. */
export async function hashArquivo(caminho: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bloco of createReadStream(caminho, { highWaterMark: 1 << 20 })) {
    hash.update(bloco as Buffer);
  }
  return hash.digest('hex');
}
