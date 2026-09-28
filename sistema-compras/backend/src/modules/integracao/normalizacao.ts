/**
 * Normalizacao de dados externos (secao 27).
 *
 * Tudo aqui e funcao pura: entra o que o sistema de fora mandou, sai o que o
 * banco aceita, ou um erro dizendo por que nao dá. Sem banco e sem estado,
 * porque estas sao as regras que mais precisam de teste e as que mais doem
 * quando erram em silencio.
 *
 * O principio: **preferir recusar a adivinhar**. Uma data ambigua devolvida
 * como erro custa uma linha no relatorio de importacao; a mesma data adivinhada
 * errado vira uma venda no mes errado, e ninguem descobre ate a previsao de
 * demanda ficar estranha tres meses depois.
 */

export interface Resultado<T> {
  ok: boolean;
  valor?: T;
  erro?: string;
  /** Aviso: o valor foi aceito, mas com uma ressalva que merece registro. */
  alerta?: string;
}

const ok = <T>(valor: T, alerta?: string): Resultado<T> =>
  (alerta ? { ok: true, valor, alerta } : { ok: true, valor });

const falha = <T>(erro: string): Resultado<T> => ({ ok: false, erro });

const vazio = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

export function texto(valor: unknown, opcoes: {
  maximo?: number; maiusculas?: boolean; obrigatorio?: boolean;
} = {}): Resultado<string | null> {
  if (vazio(valor)) {
    return opcoes.obrigatorio ? falha('Campo obrigatorio vazio') : ok(null);
  }

  // Espacos duplicados e nao separaveis sao praga de exportacao de ERP e de
  // copia-e-cola de planilha; colapsa-los evita dois cadastros para o mesmo
  // nome, diferentes por um espaco invisivel.
  let s = String(valor).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  if (opcoes.maiusculas) s = s.toUpperCase();

  if (opcoes.maximo && s.length > opcoes.maximo) {
    return ok(s.slice(0, opcoes.maximo),
      `Texto truncado de ${s.length} para ${opcoes.maximo} caracteres`);
  }
  return ok(s);
}

// ---------------------------------------------------------------------------
// Numeros e decimais
// ---------------------------------------------------------------------------

/**
 * Converte numero vindo de planilha ou API.
 *
 * O ponto delicado e o separador decimal. `1.234` e mil duzentos e trinta e
 * quatro no Brasil e um virgula dois em outros lugares - e os dois aparecem no
 * mesmo arquivo quando parte dele foi digitada a mao. A regra adotada:
 *
 *   - com virgula presente, a virgula e o decimal e o ponto e milhar (pt-BR);
 *   - so com ponto, decide o FORMATO do agrupamento: `1.234` e `12.345` tem
 *     exatamente tres casas depois do ponto e nenhum separador antes, o padrao
 *     de milhar; `1.5` ou `12.34` nao tem.
 *
 * O caso `1.234` continua ambiguo em teoria. Escolhemos milhar porque quem
 * exporta de ERP brasileiro escreve assim, e porque o erro na outra direcao
 * (tratar mil como um e pouco) some no meio dos dados, enquanto este aparece.
 * De qualquer forma o alerta e emitido, e o template pode fixar o separador.
 */
export function decimal(valor: unknown, opcoes: {
  minimo?: number; maximo?: number; casas?: number; obrigatorio?: boolean;
  separador?: ',' | '.';
} = {}): Resultado<number | null> {
  if (vazio(valor)) {
    return opcoes.obrigatorio ? falha('Campo numerico obrigatorio vazio') : ok(null);
  }

  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) return falha('Numero invalido');
    return aplicarFaixa(valor, opcoes);
  }

  let s = String(valor).trim()
    .replace(/ /g, '')
    .replace(/\s/g, '')
    .replace(/^R\$/i, '')
    .replace(/^\+/, '');

  if (s === '' || s === '-') return falha('Numero invalido');

  // Negativo entre parenteses: contabilidade e exportacao de ERP usam.
  let negativo = false;
  if (/^\(.*\)$/.test(s)) { negativo = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { negativo = true; s = s.slice(1); }

  if (!/^[\d.,]*$/.test(s)) return falha(`Nao e um numero: "${String(valor).slice(0, 40)}"`);

  let alerta: string | undefined;
  const temVirgula = s.includes(',');
  const temPonto = s.includes('.');

  if (opcoes.separador === ',') {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (opcoes.separador === '.') {
    s = s.replace(/,/g, '');
  } else if (temVirgula && temPonto) {
    // O ultimo que aparece e o decimal.
    s = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (temVirgula) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (temPonto) {
    const partes = s.split('.');
    const pareceMilhar = partes.length > 1
      && partes.slice(1).every((p) => p.length === 3)
      && partes[0]!.length <= 3;
    if (pareceMilhar) {
      s = partes.join('');
      alerta = `"${String(valor)}" lido como ${s}: ponto interpretado como `
        + 'separador de milhar. Defina o separador no template para remover a duvida.';
    }
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return falha(`Nao e um numero: "${String(valor).slice(0, 40)}"`);

  const resultado = aplicarFaixa(negativo ? -n : n, opcoes);
  return alerta && resultado.ok ? { ...resultado, alerta } : resultado;
}

function aplicarFaixa(n: number, opcoes: {
  minimo?: number; maximo?: number; casas?: number;
}): Resultado<number | null> {
  let valor = n;
  if (opcoes.casas !== undefined) {
    const f = 10 ** opcoes.casas;
    valor = Math.round(valor * f) / f;
  }
  if (opcoes.minimo !== undefined && valor < opcoes.minimo) {
    return falha(`Valor ${valor} abaixo do minimo ${opcoes.minimo}`);
  }
  if (opcoes.maximo !== undefined && valor > opcoes.maximo) {
    return falha(`Valor ${valor} acima do maximo ${opcoes.maximo}`);
  }
  return ok(valor);
}

export const inteiro = (valor: unknown, opcoes: {
  minimo?: number; maximo?: number; obrigatorio?: boolean;
} = {}): Resultado<number | null> => {
  const r = decimal(valor, { ...opcoes, casas: 0 });
  if (!r.ok || r.valor === null || r.valor === undefined) return r;
  return Number.isInteger(r.valor) ? r : falha(`${r.valor} nao e inteiro`);
};

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

const MESES_PT: Record<string, number> = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

/**
 * Converte data para o formato de calendario `YYYY-MM-DD`.
 *
 * Nao devolve `Date`: o sistema inteiro trabalha com data de calendario em
 * texto (o modulo 04 estabeleceu isso), e converter para `Date` aqui
 * reintroduziria o fuso horario numa informacao que nao tem hora.
 *
 * `03/04/2026` e ambiguo entre dia/mes e mes/dia. O padrao e DD/MM (pt-BR); o
 * template pode fixar o contrario. Quando o dia passa de 12 a ambiguidade
 * desaparece sozinha e o formato e deduzido.
 */
export function data(valor: unknown, opcoes: {
  formato?: 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD';
  obrigatorio?: boolean;
  minimo?: string;
  maximo?: string;
} = {}): Resultado<string | null> {
  if (vazio(valor)) {
    return opcoes.obrigatorio ? falha('Data obrigatoria vazia') : ok(null);
  }

  // Serial do Excel: dias desde 1899-12-30 (o "30" absorve o bug do ano
  // bissexto de 1900 que o formato carrega desde o Lotus 1-2-3).
  if (typeof valor === 'number' || /^\d{5}(\.\d+)?$/.test(String(valor).trim())) {
    const serial = Number(valor);
    if (serial > 0 && serial < 80000) {
      const base = Date.UTC(1899, 11, 30);
      const d = new Date(base + Math.floor(serial) * 86400000);
      return limitar(
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
        opcoes);
    }
  }

  const s = String(valor).trim();

  // ISO, com ou sem hora. `montar` recebe (dia, mes, ano) - a ordem importa e
  // ja custou caro: passar (ano, mes, dia) aqui fazia TODA data ISO ser
  // recusada como "dia fora do calendario", porque o ano virava o dia.
  const iso = /^(\d{4})-(\d{2})-(\d{2})([T ].*)?$/.exec(s);
  if (iso) return limitar(montar(+iso[3]!, +iso[2]!, +iso[1]!), opcoes);

  // Separado por barra, ponto ou hifen.
  const sep = /^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{2,4})([T ].*)?$/.exec(s);
  if (sep) {
    const a = +sep[1]!; const b = +sep[2]!; const c = +sep[3]!;

    // Ano na frente nao tem ambiguidade: YYYY/MM/DD, e o terceiro campo e o
    // DIA. A expansao de ano de dois digitos NAO pode acontecer antes deste
    // teste: em "2026/10/21" ela transformaria o dia 21 no ano 2021.
    if (String(sep[1]).length === 4) return limitar(montar(c, b, a), opcoes);

    // Daqui para baixo o terceiro campo e o ano, e ai sim dois digitos viram
    // quatro. O corte em 50 e a convencao usual: 26 -> 2026, 87 -> 1987.
    const ano = String(sep[3]).length === 2 ? c + (c <= 50 ? 2000 : 1900) : c;

    const formato = opcoes.formato ?? 'DD/MM/YYYY';
    let dia = formato === 'MM/DD/YYYY' ? b : a;
    let mes = formato === 'MM/DD/YYYY' ? a : b;

    // O numero maior que 12 so pode ser dia: corrige o formato declarado
    // errado em vez de recusar um dado que e legivel sem duvida.
    if (mes > 12 && dia <= 12) { const t = dia; dia = mes; mes = t; }
    return limitar(montar(dia, mes, ano), opcoes);
  }

  // "12 de marco de 2026" / "12-mar-2026"
  const texto = /^(\d{1,2})[\s\-de]+([a-zçãé]{3,})[\s\-de]+(\d{2,4})$/i.exec(s);
  if (texto) {
    const mes = MESES_PT[texto[2]!.slice(0, 3).toLowerCase()];
    if (mes) {
      let ano = +texto[3]!;
      if (String(texto[3]).length === 2) ano += ano <= 50 ? 2000 : 1900;
      return limitar(montar(+texto[1]!, mes, ano), opcoes);
    }
  }

  return falha(`Data nao reconhecida: "${s.slice(0, 40)}"`);
}

function montar(dia: number, mes: number, ano: number): string | null {
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || ano < 1900 || ano > 2200) return null;
  // Confere que a data EXISTE: 31/02 passaria pelos limites acima.
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    return null;
  }
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function limitar(
  iso: string | null, opcoes: { minimo?: string; maximo?: string },
): Resultado<string | null> {
  if (!iso) return falha('Data invalida (dia ou mes fora do calendario)');
  if (opcoes.minimo && iso < opcoes.minimo) {
    return falha(`Data ${iso} anterior ao minimo ${opcoes.minimo}`);
  }
  if (opcoes.maximo && iso > opcoes.maximo) {
    return falha(`Data ${iso} posterior ao maximo ${opcoes.maximo}`);
  }
  return ok(iso);
}

// ---------------------------------------------------------------------------
// Documentos
// ---------------------------------------------------------------------------

/**
 * CNPJ: normaliza e CONFERE os digitos verificadores.
 *
 * Validar de verdade importa porque o CNPJ e chave natural de fornecedor. Um
 * digito trocado cria um segundo cadastro do mesmo fornecedor, e a partir dai
 * o OTIF, o scorecard e a concentracao de compras contam duas empresas onde ha
 * uma.
 */
export function cnpj(valor: unknown, opcoes: { obrigatorio?: boolean } = {}):
Resultado<string | null> {
  if (vazio(valor)) {
    return opcoes.obrigatorio ? falha('CNPJ obrigatorio vazio') : ok(null);
  }

  const digitos = String(valor).replace(/\D/g, '');
  if (digitos.length !== 14) {
    return falha(`CNPJ deve ter 14 digitos, veio com ${digitos.length}`);
  }
  if (/^(\d)\1{13}$/.test(digitos)) return falha('CNPJ invalido (digitos repetidos)');

  const verificar = (base: string, pesos: number[]): number => {
    const soma = pesos.reduce((a, p, i) => a + Number(base[i]) * p, 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const d1 = verificar(digitos, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = verificar(digitos, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);

  if (Number(digitos[12]) !== d1 || Number(digitos[13]) !== d2) {
    return falha('CNPJ com digito verificador invalido');
  }
  return ok(digitos);
}

export function cpf(valor: unknown, opcoes: { obrigatorio?: boolean } = {}):
Resultado<string | null> {
  if (vazio(valor)) {
    return opcoes.obrigatorio ? falha('CPF obrigatorio vazio') : ok(null);
  }
  const d = String(valor).replace(/\D/g, '');
  if (d.length !== 11) return falha(`CPF deve ter 11 digitos, veio com ${d.length}`);
  if (/^(\d)\1{10}$/.test(d)) return falha('CPF invalido (digitos repetidos)');

  const dig = (ate: number): number => {
    let soma = 0;
    for (let i = 0; i < ate; i += 1) soma += Number(d[i]) * (ate + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  if (dig(9) !== Number(d[9]) || dig(10) !== Number(d[10])) {
    return falha('CPF com digito verificador invalido');
  }
  return ok(d);
}

/** EAN-8/12/13/14 com digito verificador. */
export function ean(valor: unknown, opcoes: { obrigatorio?: boolean } = {}):
Resultado<string | null> {
  if (vazio(valor)) {
    return opcoes.obrigatorio ? falha('EAN obrigatorio vazio') : ok(null);
  }
  const d = String(valor).replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(d.length)) {
    return falha(`EAN deve ter 8, 12, 13 ou 14 digitos, veio com ${d.length}`);
  }

  // Pesos alternam 3 e 1 a partir do digito imediatamente antes do verificador.
  const corpo = d.slice(0, -1);
  let soma = 0;
  for (let i = corpo.length - 1, peso = 3; i >= 0; i -= 1, peso = peso === 3 ? 1 : 3) {
    soma += Number(corpo[i]) * peso;
  }
  const esperado = (10 - (soma % 10)) % 10;
  if (Number(d[d.length - 1]) !== esperado) {
    return falha('EAN com digito verificador invalido');
  }
  return ok(d);
}

// ---------------------------------------------------------------------------
// Estado, pais e moeda
// ---------------------------------------------------------------------------

const UFS = new Set(['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA',
  'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR',
  'SC', 'SP', 'SE', 'TO']);

const NOMES_UF: Record<string, string> = {
  'ACRE': 'AC', 'ALAGOAS': 'AL', 'AMAPA': 'AP', 'AMAZONAS': 'AM', 'BAHIA': 'BA',
  'CEARA': 'CE', 'DISTRITO FEDERAL': 'DF', 'ESPIRITO SANTO': 'ES', 'GOIAS': 'GO',
  'MARANHAO': 'MA', 'MATO GROSSO': 'MT', 'MATO GROSSO DO SUL': 'MS',
  'MINAS GERAIS': 'MG', 'PARA': 'PA', 'PARAIBA': 'PB', 'PARANA': 'PR',
  'PERNAMBUCO': 'PE', 'PIAUI': 'PI', 'RIO DE JANEIRO': 'RJ',
  'RIO GRANDE DO NORTE': 'RN', 'RIO GRANDE DO SUL': 'RS', 'RONDONIA': 'RO',
  'RORAIMA': 'RR', 'SANTA CATARINA': 'SC', 'SAO PAULO': 'SP', 'SERGIPE': 'SE',
  'TOCANTINS': 'TO',
};

const semAcento = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '');

export function uf(valor: unknown, opcoes: { obrigatorio?: boolean } = {}):
Resultado<string | null> {
  if (vazio(valor)) {
    return opcoes.obrigatorio ? falha('UF obrigatoria vazia') : ok(null);
  }
  const bruto = semAcento(String(valor).trim().toUpperCase()).replace(/\s+/g, ' ');
  if (UFS.has(bruto)) return ok(bruto);
  const porNome = NOMES_UF[bruto];
  if (porNome) return ok(porNome, `"${String(valor).trim()}" normalizado para ${porNome}`);
  return falha(`UF nao reconhecida: "${String(valor).slice(0, 30)}"`);
}

const MOEDAS: Record<string, string> = {
  'BRL': 'BRL', 'R$': 'BRL', 'REAL': 'BRL', 'REAIS': 'BRL',
  'USD': 'USD', 'US$': 'USD', 'DOLAR': 'USD', '$': 'USD',
  'EUR': 'EUR', '€': 'EUR', 'EURO': 'EUR',
};

export function moeda(valor: unknown, opcoes: { padrao?: string } = {}):
Resultado<string> {
  if (vazio(valor)) return ok(opcoes.padrao ?? 'BRL');
  const bruto = semAcento(String(valor).trim().toUpperCase());
  const codigo = MOEDAS[bruto];
  if (codigo) return ok(codigo);
  if (/^[A-Z]{3}$/.test(bruto)) {
    return ok(bruto, `Moeda "${bruto}" nao esta no catalogo; aceita como codigo ISO`);
  }
  return falha(`Moeda nao reconhecida: "${String(valor).slice(0, 20)}"`);
}

// ---------------------------------------------------------------------------
// Unidades
// ---------------------------------------------------------------------------

/**
 * Normaliza a sigla da unidade.
 *
 * NAO converte quantidade entre unidades - isso e decisao de negocio e mora no
 * `fator_conversao` do produto (modulo 02). Converter aqui criaria uma segunda
 * regra de conversao, e as duas divergiriam no dia em que o cadastro mudasse.
 */
const UNIDADES: Record<string, string> = {
  'KG': 'KG', 'QUILO': 'KG', 'QUILOS': 'KG', 'KGS': 'KG', 'K': 'KG',
  'G': 'G', 'GR': 'G', 'GRAMA': 'G', 'GRAMAS': 'G',
  'TON': 'TON', 'T': 'TON', 'TONELADA': 'TON', 'TONELADAS': 'TON',
  'L': 'L', 'LT': 'L', 'LITRO': 'L', 'LITROS': 'L',
  'ML': 'ML', 'MILILITRO': 'ML',
  'UN': 'UN', 'UND': 'UN', 'UNID': 'UN', 'UNIDADE': 'UN', 'PC': 'UN', 'PCS': 'UN',
  'CX': 'CX', 'CAIXA': 'CX', 'CAIXAS': 'CX',
  'FD': 'FD', 'FARDO': 'FD', 'SC': 'SC', 'SACO': 'SC', 'SACA': 'SC',
  'PCT': 'PCT', 'PACOTE': 'PCT', 'DZ': 'DZ', 'DUZIA': 'DZ',
};

export function unidade(valor: unknown, opcoes: { obrigatorio?: boolean } = {}):
Resultado<string | null> {
  if (vazio(valor)) {
    return opcoes.obrigatorio ? falha('Unidade obrigatoria vazia') : ok(null);
  }
  const bruto = semAcento(String(valor).trim().toUpperCase()).replace(/[.\s]/g, '');
  const sigla = UNIDADES[bruto];
  if (sigla) {
    return bruto === sigla ? ok(sigla)
      : ok(sigla, `Unidade "${String(valor).trim()}" normalizada para ${sigla}`);
  }
  return ok(bruto.slice(0, 10),
    `Unidade "${bruto}" nao esta no catalogo; mantida como veio`);
}

// ---------------------------------------------------------------------------
// Booleano
// ---------------------------------------------------------------------------

const VERDADEIROS = new Set(['TRUE', '1', 'SIM', 'S', 'Y', 'YES', 'V', 'ATIVO']);
const FALSOS = new Set(['FALSE', '0', 'NAO', 'N', 'NO', 'F', 'INATIVO']);

export function booleano(valor: unknown, opcoes: { padrao?: boolean } = {}):
Resultado<boolean | null> {
  if (vazio(valor)) return ok(opcoes.padrao ?? null);
  if (typeof valor === 'boolean') return ok(valor);
  const s = semAcento(String(valor).trim().toUpperCase());
  if (VERDADEIROS.has(s)) return ok(true);
  if (FALSOS.has(s)) return ok(false);
  return falha(`Nao e sim/nao: "${String(valor).slice(0, 20)}"`);
}

// ---------------------------------------------------------------------------
// Catalogo, para o mapeamento escolher pelo nome
// ---------------------------------------------------------------------------

export type Transformacao =
  | 'texto' | 'texto_maiusculo' | 'decimal' | 'inteiro' | 'data'
  | 'cnpj' | 'cpf' | 'ean' | 'uf' | 'moeda' | 'unidade' | 'booleano';

type Aplicador = (valor: unknown, parametros: Record<string, unknown>) => Resultado<unknown>;

/**
 * Os parametros vem de jsonb, entao chegam como `Record<string, unknown>`.
 * Este apelido converte uma vez, num lugar so, em vez de espalhar `as never`
 * por doze entradas do catalogo - onde `never` acabaria escondendo um erro de
 * verdade no dia em que uma assinatura mudasse.
 */
const opts = <T>(p: Record<string, unknown>): T => p as T;

export const CATALOGO: Record<Transformacao, { descricao: string; aplicar: Aplicador }> = {
  texto: {
    descricao: 'Limpa espacos e normaliza o texto',
    aplicar: (v, p) => texto(v, opts(p)),
  },
  texto_maiusculo: {
    descricao: 'Texto em maiusculas, para codigo e sigla',
    aplicar: (v, p) => texto(v, { ...opts<{ maximo?: number }>(p), maiusculas: true }),
  },
  decimal: {
    descricao: 'Numero com separador brasileiro ou internacional',
    aplicar: (v, p) => decimal(v, opts(p)),
  },
  inteiro: {
    descricao: 'Numero inteiro',
    aplicar: (v, p) => inteiro(v, opts(p)),
  },
  data: {
    descricao: 'Data de calendario, incluindo serial do Excel',
    aplicar: (v, p) => data(v, opts(p)),
  },
  cnpj: {
    descricao: 'CNPJ com conferencia de digito verificador',
    aplicar: (v, p) => cnpj(v, opts(p)),
  },
  cpf: {
    descricao: 'CPF com conferencia de digito verificador',
    aplicar: (v, p) => cpf(v, opts(p)),
  },
  ean: {
    descricao: 'Codigo de barras EAN com digito verificador',
    aplicar: (v, p) => ean(v, opts(p)),
  },
  uf: {
    descricao: 'Sigla de estado, aceitando o nome por extenso',
    aplicar: (v, p) => uf(v, opts(p)),
  },
  moeda: {
    descricao: 'Codigo de moeda ISO',
    aplicar: (v, p) => moeda(v, opts(p)),
  },
  unidade: {
    descricao: 'Sigla de unidade; nao converte quantidade',
    aplicar: (v, p) => unidade(v, opts(p)),
  },
  booleano: {
    descricao: 'Sim/nao em qualquer grafia comum',
    aplicar: (v, p) => booleano(v, opts(p)),
  },
};

export const transformacaoExiste = (nome: string): nome is Transformacao =>
  Object.prototype.hasOwnProperty.call(CATALOGO, nome);

/** Aplica a transformacao pelo nome. Nome desconhecido e erro, nao silencio. */
export function aplicar(
  transformacao: string | null | undefined,
  valor: unknown,
  parametros: Record<string, unknown> = {},
): Resultado<unknown> {
  if (!transformacao) return texto(valor, opts(parametros));
  if (!transformacaoExiste(transformacao)) {
    return falha(`Transformacao desconhecida: "${transformacao}". `
      + `Disponiveis: ${Object.keys(CATALOGO).join(', ')}`);
  }
  return CATALOGO[transformacao].aplicar(valor, parametros);
}

export const catalogo = () =>
  Object.entries(CATALOGO).map(([nome, t]) => ({ nome, descricao: t.descricao }));
