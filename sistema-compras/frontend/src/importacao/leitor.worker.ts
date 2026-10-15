/**
 * Leitura de planilha fora da thread da tela.
 *
 * Um Rel 7104 de 28 MB leva ~13 s so para descompactar e interpretar o XML.
 * Na thread principal isso congela a pagina; aqui a tela continua respondendo
 * e mostra o progresso.
 *
 * Devolve matriz (lista de valores por linha), nao objetos: 400 mil objetos
 * com 23 chaves cada custam centenas de MB, e a matriz e o mesmo formato que
 * vai para o servidor.
 */
import * as XLSX from 'xlsx';

export type MensagemLeitor =
  | { tipo: 'progresso'; etapa: string }
  | { tipo: 'concluido'; colunas: string[]; linhas: unknown[][]; emBranco: number }
  | { tipo: 'erro'; mensagem: string };

const enviar = (m: MensagemLeitor) => (self as unknown as Worker).postMessage(m);

/**
 * XLSX (zip) e XLS binario (OLE) sao lidos como bytes. O resto e texto: CSV e
 * o ".xls" do ERP, que na verdade e uma tabela HTML em Windows-1252. Texto e
 * lido com raw para preservar zeros a esquerda e codigos de barras longos.
 */
function lerPastaDeTrabalho(bytes: Uint8Array): XLSX.WorkBook {
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf;
  if (zip || ole) {
    // dense: a conversao em linhas cai de ~8 s para menos de 0,1 s.
    return XLSX.read(bytes, { type: 'array', raw: false, dateNF: 'DD/MM/YYYY', dense: true });
  }
  let texto: string;
  try {
    texto = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    texto = new TextDecoder('windows-1252').decode(bytes);
  }
  return XLSX.read(texto, { type: 'string', raw: true, dense: true });
}

/**
 * O texto formatado de um numero inteiro longo em formato "Geral" e notacao
 * cientifica: o CNPJ 9519473000174 vira "9,51947E+12" e o codigo de barras
 * 7898663866223 vira "7,89866E+12" - digitos perdidos. Para esses o valor
 * verdadeiro da celula e o que vale.
 */
function preservarInteirosLongos(planilha: XLSX.WorkSheet) {
  const corrigir = (celula: XLSX.CellObject | undefined) => {
    if (celula?.t === 'n' && typeof celula.v === 'number' && Number.isInteger(celula.v)
        && Math.abs(celula.v) >= 1e10 && (!celula.z || celula.z === 'General')) {
      celula.w = String(celula.v);
    }
  };
  // Modo denso: a 0.18 guarda as linhas na propria folha; versoes novas em "!data".
  type Linhas = Array<Array<XLSX.CellObject | undefined> | undefined>;
  const densa = (planilha as unknown as { '!data'?: Linhas })['!data']
    ?? (Array.isArray(planilha) ? (planilha as unknown as Linhas) : null);
  if (densa) {
    for (const linha of densa) linha?.forEach(corrigir);
    return;
  }
  for (const chave of Object.keys(planilha)) {
    if (chave[0] !== '!') corrigir(planilha[chave] as XLSX.CellObject);
  }
}

self.onmessage = async (evento: MessageEvent<{ arquivo: File }>) => {
  try {
    enviar({ tipo: 'progresso', etapa: 'Lendo o arquivo...' });
    const bytes = new Uint8Array(await evento.data.arquivo.arrayBuffer());

    enviar({ tipo: 'progresso', etapa: 'Interpretando a planilha (arquivos grandes levam alguns segundos)...' });
    const livro = lerPastaDeTrabalho(bytes);
    const planilha = livro.SheetNames.length ? livro.Sheets[livro.SheetNames[0]!] : undefined;
    if (!planilha) throw new Error('O arquivo nao contem planilhas validas');

    preservarInteirosLongos(planilha);
    enviar({ tipo: 'progresso', etapa: 'Separando as linhas...' });
    const matriz = XLSX.utils.sheet_to_json<unknown[]>(planilha, {
      header: 1, defval: '', raw: false, dateNF: 'DD/MM/YYYY', blankrows: false,
    });

    const colunas = (matriz[0] ?? []).map((c) => String(c ?? '').trim());
    const linhas: unknown[][] = [];
    let emBranco = 0;

    // O Excel do ERP traz milhares de linhas so com a data preenchida (sobra
    // de formatacao). Linha com menos de dois valores nao e venda.
    for (let i = 1; i < matriz.length; i++) {
      const linha = matriz[i]!;
      let preenchidos = 0;
      for (const v of linha) {
        if (v !== null && v !== undefined && String(v).trim() !== '' && ++preenchidos > 1) break;
      }
      if (preenchidos > 1) linhas.push(linha); else emBranco++;
    }

    enviar({ tipo: 'concluido', colunas, linhas, emBranco });
  } catch (e) {
    enviar({ tipo: 'erro', mensagem: e instanceof Error ? e.message : 'Falha ao ler o arquivo' });
  }
};
