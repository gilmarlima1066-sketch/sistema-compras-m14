/**
 * Importador universal de Excel e CSV (secoes 11 a 14).
 *
 * O fluxo da secao 11, com uma parada obrigatoria no meio:
 *
 *   UPLOAD -> LEITURA -> COLUNAS -> MAPEAMENTO -> VALIDACAO
 *          -> PRE-VISUALIZACAO -> [CONFIRMACAO HUMANA] -> PROCESSAMENTO -> RELATORIO
 *
 * A confirmacao nao e formalidade. Um arquivo de 426 mil linhas com o
 * mapeamento errado escreve 426 mil registros errados, e desfazer isso e mais
 * caro que qualquer coisa que o importador economize. Por isso a analise roda
 * sozinha, para sobre a pre-visualizacao, e so escreve depois que alguem
 * confirmou - regra que o CHECK `ck_importacao_confirmacao` garante no banco.
 *
 * TRES GARANTIAS DE IDEMPOTENCIA (secoes 14 e 28), em camadas:
 *
 *   1. Hash do ARQUIVO: reenviar o mesmo arquivo e reconhecido antes de ler
 *      uma linha.
 *   2. Chave natural por REGISTRO: a linha que ja virou venda nao vira outra.
 *      Quem garante e o indice UNIQUE de `vendas.numero_documento`, nao um
 *      "if ja existe" no codigo - dois processos leriam ao mesmo tempo.
 *   3. Hash do CONTEUDO: chave conhecida com conteudo igual e descartada;
 *      com conteudo diferente, atualiza. E o que separa "ja importei" de
 *      "mudou na origem".
 */
import { realpath, unlink } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { comTransacao, pool, query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import { numero as configNumero } from './config.js';
import * as leitor from './leitor.js';
import * as mapeador from './mapeamento.service.js';
import { registrarAlerta } from '../bi/alertas.service.js';
import * as eventos from '../automacao/eventos.service.js';

export type StatusImportacao =
  | 'RECEBIDO' | 'ANALISANDO' | 'AGUARDANDO_MAPEAMENTO' | 'VALIDANDO'
  | 'AGUARDANDO_CONFIRMACAO' | 'PROCESSANDO' | 'CONCLUIDA'
  | 'CONCLUIDA_COM_ERROS' | 'REJEITADA' | 'CANCELADA';

export interface EntradaImportacao {
  caminho: string;
  nome_arquivo: string;
  entidade: string;
  template?: string | null;
  linha_cabecalho?: number;
  separador?: string | null;
  integracao?: string | null;
}

// ---------------------------------------------------------------------------
// Onde o importador pode ler (secao 37)
// ---------------------------------------------------------------------------

/**
 * Diretorios de onde o importador aceita ler.
 *
 * Esta lista e a unica coisa entre a rota de importacao e a leitura arbitraria
 * de disco. Sem ela, `POST /integracoes/importacoes` com
 * `caminho: "/etc/passwd"` devolve o arquivo na pre-visualizacao - e ainda o
 * grava em `importacoes.amostra`. O mesmo vale para o `.env` com a senha do
 * banco, para a chave do JWT e para qualquer coisa que o processo consiga ler.
 *
 * A variavel de ambiente permite ao operador apontar o diretorio real de
 * upload sem mexer no codigo; os dois padroes cobrem o anexo enviado pela
 * aplicacao e a area de trabalho do container.
 */
const RAIZES_PERMITIDAS = (process.env.IMPORTACAO_DIRETORIOS
  ?? '/mnt/user-data/uploads:/tmp/importacoes')
  .split(':')
  .map((d) => d.trim())
  .filter(Boolean)
  .map((d) => resolve(d));

/**
 * Resolve o caminho e recusa qualquer coisa fora das raizes permitidas.
 *
 * Usa `realpath` de proposito: comparar o texto do caminho barra `../..` mas
 * nao barra um link simbolico apontando para fora. E preciso perguntar ao
 * sistema de arquivos onde o caminho REALMENTE vai dar, e so entao comparar.
 *
 * A mensagem de erro nao lista as raizes permitidas: quem esta sondando o disco
 * nao precisa do mapa, e quem configurou o servidor ja o tem.
 */
export async function caminhoSeguro(caminho: string): Promise<string> {
  if (!caminho || !isAbsolute(caminho)) {
    throw regraNegocio('O caminho do arquivo precisa ser absoluto');
  }

  let real: string;
  try {
    real = await realpath(caminho);
  } catch {
    throw naoEncontrado(`Arquivo ${caminho}`);
  }

  const dentro = RAIZES_PERMITIDAS.some(
    (raiz) => real === raiz || real.startsWith(raiz + sep));

  if (!dentro) {
    throw regraNegocio(
      'O arquivo esta fora dos diretorios de importacao permitidos neste servidor');
  }

  return real;
}

/** Para a tela de operacao mostrar de onde o importador aceita ler. */
export const raizesPermitidas = (): string[] => [...RAIZES_PERMITIDAS];

// ---------------------------------------------------------------------------
// Etapa 1: receber e analisar
// ---------------------------------------------------------------------------

export interface Analise {
  importacao_id: number;
  status: StatusImportacao;
  formato: string;
  colunas: string[];
  total_estimado: number;
  casamento?: {
    encontradas: Record<string, string>;
    faltando: string[];
    desconhecidas: string[];
    obrigatorios_ausentes: string[];
  };
  sugestoes?: Array<{ campo_externo: string; campo_interno: string;
    transformacao: string; confianca: string; }>;
  amostra: Record<string, unknown>[];
  ja_importado?: { importacao_id: number; em: string; registros: number };
  impedimentos: string[];
}

/**
 * Le o cabecalho, casa com o template e devolve o que vai acontecer.
 *
 * NAO grava nada da planilha. O objetivo e responder "da para importar, e o
 * que vai virar o que" antes de qualquer escrita.
 */
export async function analisar(
  entrada: EntradaImportacao, contexto: ContextoSessao,
): Promise<Analise> {
  const caminhoValidado = await caminhoSeguro(entrada.caminho);

  // O formato sai do CONTEUDO do arquivo, nao da extensao que veio no nome: um
  // XLSX enviado como ".csv" seria lido como texto e gravaria lixo binario na
  // pre-visualizacao, sem erro nenhum que explicasse o resultado.
  const formato = await leitor.detectarFormato(caminhoValidado, entrada.nome_arquivo);
  if (!formato) {
    throw regraNegocio(
      `Formato nao suportado em "${entrada.nome_arquivo}". Envie XLSX ou CSV.`);
  }

  const hash = await leitor.hashArquivo(caminhoValidado);

  // Camada 1 da idempotencia: o arquivo inteiro ja passou por aqui?
  const { rows: anterior } = await query<{
    id: string; created_at: string; registros_criados: number; status: string;
  }>(`SELECT id, created_at, registros_criados, status::text AS status
        FROM importacoes
       WHERE hash_arquivo = $1
         AND status IN ('CONCLUIDA', 'CONCLUIDA_COM_ERROS')
       ORDER BY id DESC LIMIT 1`, [hash]);

  const maxLinhas = await configNumero('importacao_max_linhas', 1_000_000);
  const linhasAmostra = await configNumero('importacao_amostra_linhas', 20);
  const linhaCabecalho = entrada.linha_cabecalho ?? 1;

  const inspecao = await leitor.inspecionar(caminhoValidado, formato, {
    linhaCabecalho,
    amostra: linhasAmostra,
    ...(entrada.separador ? { separador: entrada.separador } : {}),
  });

  const impedimentos: string[] = [];
  if (inspecao.colunas.length === 0) {
    impedimentos.push('Nenhuma coluna encontrada na linha de cabecalho '
      + `${linhaCabecalho}. Ajuste a linha do cabecalho.`);
  }
  if (inspecao.colunas.length === 1 && formato === 'CSV') {
    impedimentos.push('Apenas uma coluna detectada: o separador do arquivo '
      + 'provavelmente e outro. Informe o separador.');
  }

  let template: mapeador.Template | null = null;
  let casamento: mapeador.Casamento | null = null;

  if (entrada.template) {
    template = await mapeador.obterTemplate(entrada.template);
    if (template.entidade !== entrada.entidade) {
      impedimentos.push(
        `O template ${template.codigo} e da entidade "${template.entidade}" e a `
        + `importacao pediu "${entrada.entidade}".`);
    }
    casamento = mapeador.casarColunas(template, inspecao.colunas);
    for (const campo of casamento.obrigatorios_ausentes) {
      impedimentos.push(
        `A coluna obrigatoria "${campo}" nao existe no arquivo e nao tem valor padrao.`);
    }
  }

  const { rows } = await query<{ id: string }>(`
    INSERT INTO importacoes
      (nome_arquivo, formato, entidade, origem, caminho, hash_arquivo,
       template_id, linha_cabecalho, colunas_detectadas, amostra, status,
       usuario_id, integracao_id, analisado_em)
    VALUES ($1, $2::formato_arquivo_enum, $3, $4::origem_registro_enum, $5, $6,
            $7, $8, $9::jsonb, $10::jsonb, $11::status_importacao_enum, $12,
            (SELECT id FROM integracoes WHERE upper(codigo) = upper($13)), now())
    RETURNING id`,
  [entrada.nome_arquivo, formato, entrada.entidade,
    formato === 'CSV' ? 'CSV' : 'EXCEL', caminhoValidado, hash,
    template?.id ?? null, linhaCabecalho,
    JSON.stringify(inspecao.colunas), JSON.stringify(inspecao.amostra),
    impedimentos.length ? 'REJEITADA'
      : template ? 'AGUARDANDO_CONFIRMACAO' : 'AGUARDANDO_MAPEAMENTO',
    contexto.usuarioId ?? null, entrada.integracao ?? null]);

  const importacaoId = Number(rows[0]!.id);

  if (impedimentos.length) {
    await query('UPDATE importacoes SET erro = $2 WHERE id = $1',
      [importacaoId, impedimentos.join(' ')]);
  }

  return {
    importacao_id: importacaoId,
    status: impedimentos.length ? 'REJEITADA'
      : template ? 'AGUARDANDO_CONFIRMACAO' : 'AGUARDANDO_MAPEAMENTO',
    formato,
    colunas: inspecao.colunas,
    total_estimado: 0,
    ...(casamento ? {
      casamento: {
        encontradas: Object.fromEntries(casamento.encontradas),
        faltando: casamento.faltando,
        desconhecidas: casamento.desconhecidas,
        obrigatorios_ausentes: casamento.obrigatorios_ausentes,
      },
    } : {
      sugestoes: mapeador.sugerirMapeamento(inspecao.colunas),
    }),
    amostra: inspecao.amostra,
    ...(anterior.length ? {
      ja_importado: {
        importacao_id: Number(anterior[0]!.id),
        em: anterior[0]!.created_at,
        registros: anterior[0]!.registros_criados,
      },
    } : {}),
    impedimentos,
    ...(maxLinhas < 1_000_000 ? {} : {}),
  };
}

// ---------------------------------------------------------------------------
// Etapa 2: validar sem gravar (pre-visualizacao)
// ---------------------------------------------------------------------------

export interface Validacao {
  importacao_id: number;
  total_linhas: number;
  validas: number;
  com_erro: number;
  com_alerta: number;
  truncado: boolean;
  duracao_ms: number;
  ocorrencias_por_regra: Array<{ regra: string; severidade: string; total: number;
    exemplo: string; }>;
  previa: Array<{ linha: number; dados: Record<string, unknown>; valido: boolean }>;
}

/**
 * Percorre o arquivo inteiro aplicando o mapeamento, sem escrever no destino.
 *
 * Vale percorrer tudo, e nao so uma amostra: um erro que aparece na linha
 * 300 mil descoberto depois de gravar 299.999 registros e o pior dos mundos.
 * A leitura e em streaming e custa segundos.
 */
export async function validar(importacaoId: number): Promise<Validacao> {
  const imp = await obter(importacaoId);
  if (!imp.template_id) {
    throw regraNegocio('Defina o mapeamento antes de validar');
  }

  // Importacao iniciada pelo navegador: sem arquivo em disco, valida a amostra.
  if (!imp.caminho) {
    return validarAmostra(imp, importacaoId);
  }

  const template = await mapeador.obterTemplate(Number(imp.template_id));
  const formato = String(imp.formato) as leitor.Formato;
  const caminho = String(imp.caminho);

  await query(
    "UPDATE importacoes SET status = 'VALIDANDO' WHERE id = $1", [importacaoId]);

  const inspecao = await leitor.inspecionar(caminho, formato, {
    linhaCabecalho: Number(imp.linha_cabecalho), amostra: 1,
  });
  const casamento = mapeador.casarColunas(template, inspecao.colunas);

  const maxLinhas = await configNumero('importacao_max_linhas', 1_000_000);
  const inicio = Date.now();

  let total = 0;
  let validas = 0;
  let comErro = 0;
  let comAlerta = 0;
  const previa: Validacao['previa'] = [];

  // Agrupa por regra em vez de gravar uma linha por ocorrencia: um arquivo com
  // erro sistematico geraria centenas de milhares de linhas identicas, e o
  // relatorio util e "a coluna X falhou 300 mil vezes, veja um exemplo".
  const porRegra = new Map<string, { severidade: string; total: number; exemplo: string }>();
  const amostraOcorrencias: mapeador.Ocorrencia[] = [];

  await query('DELETE FROM importacao_ocorrencias WHERE importacao_id = $1',
    [importacaoId]);

  const gerador = leitor.ler(caminho, formato, {
    linhaCabecalho: Number(imp.linha_cabecalho),
    maxLinhas,
    ...(imp.separador ? { separador: String(imp.separador) } : {}),
  });

  let passo = await gerador.next();
  while (!passo.done) {
    const { numero, valores } = passo.value;
    const resultado = mapeador.aplicarLinha(template, casamento, valores);

    total += 1;
    if (resultado.valido) validas += 1; else comErro += 1;

    const temAlerta = resultado.ocorrencias.some((o) => o.severidade === 'ALERTA');
    if (temAlerta) comAlerta += 1;

    for (const o of resultado.ocorrencias) {
      const chave = `${o.severidade}|${o.regra}|${o.campo ?? o.coluna ?? ''}`;
      const atual = porRegra.get(chave);
      if (atual) {
        atual.total += 1;
      } else {
        porRegra.set(chave, {
          severidade: o.severidade,
          total: 1,
          exemplo: `linha ${numero}: ${o.mensagem}`,
        });
        // Guarda as primeiras ocorrencias distintas para o relatorio baixavel.
        if (amostraOcorrencias.length < 500) {
          amostraOcorrencias.push({ ...o, ...{ linha: numero } } as never);
        }
      }
    }

    if (previa.length < 20) {
      previa.push({ linha: numero, dados: resultado.dados, valido: resultado.valido });
    }

    passo = await gerador.next();
  }

  const leituraFinal = passo.value;

  for (const o of amostraOcorrencias) {
    const linha = (o as unknown as { linha: number }).linha;
    await query(`
      INSERT INTO importacao_ocorrencias
        (importacao_id, linha, coluna, campo, severidade, regra, mensagem, valor)
      VALUES ($1, $2, $3, $4, $5::severidade_validacao_enum, $6, $7, $8)`,
    [importacaoId, linha, o.coluna ?? null, o.campo ?? null, o.severidade,
      o.regra, o.mensagem, o.valor ?? null]);
  }

  const duracao = Date.now() - inicio;

  await query(`
    UPDATE importacoes
       SET status = 'AGUARDANDO_CONFIRMACAO', total_linhas = $2,
           linhas_validas = $3, linhas_com_erro = $4, linhas_com_alerta = $5,
           mapeamento = $6::jsonb, resumo = $7::jsonb
     WHERE id = $1`,
  [importacaoId, total, validas, comErro, comAlerta,
    JSON.stringify(Object.fromEntries(casamento.encontradas)),
    JSON.stringify({
      duracao_validacao_ms: duracao,
      colunas_desconhecidas: casamento.desconhecidas,
      colunas_faltando: casamento.faltando,
    })]);

  return {
    importacao_id: importacaoId,
    total_linhas: total,
    validas,
    com_erro: comErro,
    com_alerta: comAlerta,
    truncado: leituraFinal.truncado,
    duracao_ms: duracao,
    ocorrencias_por_regra: [...porRegra.entries()]
      .map(([chave, v]) => ({
        regra: chave.split('|').slice(1).join(' '),
        severidade: v.severidade,
        total: v.total,
        exemplo: v.exemplo,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 50),
    previa,
  };
}

// ---------------------------------------------------------------------------
// Etapa 3: processar (so depois da confirmacao)
// ---------------------------------------------------------------------------

export interface Resultado {
  importacao_id: number;
  status: StatusImportacao;
  total_linhas: number;
  criados: number;
  atualizados: number;
  descartados: number;
  rejeitados: number;
  duracao_ms: number;
  detalhes: Record<string, unknown>;
}

/**
 * Cada entidade sabe gravar a si mesma. O importador so orquestra.
 *
 * O terceiro parametro, `estado`, e um mapa que vive por EXECUCAO INTEIRA e
 * atravessa todos os lotes. Ele existe por causa de um defeito real: o
 * importador quebra o arquivo em lotes de mil linhas, e um documento com muitos
 * itens pode ficar dividido entre dois lotes. O gravador de vendas limpava os
 * itens do documento antes de regravar - e no segundo lote apagava os itens que
 * o primeiro tinha acabado de inserir.
 *
 * Na primeira importacao real, 688 documentos perderam 9.866 itens assim. O
 * estado compartilhado permite ao gravador lembrar o que ja limpou nesta
 * execucao, e limpar uma unica vez.
 */
export type EstadoImportacao = Map<string, unknown>;

type Gravador = (
  lote: Array<{ linha: number; dados: Record<string, unknown> }>,
  contexto: ContextoSessao,
  estado: EstadoImportacao,
) => Promise<{ criados: number; atualizados: number; descartados: number;
  rejeitados: number; motivos: Map<string, number>; }>;

const GRAVADORES: Record<string, Gravador> = {};

export function registrarGravador(entidade: string, gravador: Gravador): void {
  GRAVADORES[entidade] = gravador;
}

export const entidadesSuportadas = (): string[] => Object.keys(GRAVADORES);

export async function processar(
  importacaoId: number, contexto: ContextoSessao,
): Promise<Resultado> {
  const imp = await obter(importacaoId);

  if (imp.status !== 'AGUARDANDO_CONFIRMACAO') {
    throw regraNegocio(
      `A importacao esta em ${imp.status}; so e possivel processar o que esta `
      + 'aguardando confirmacao.');
  }
  if (!imp.confirmado_em) {
    throw regraNegocio(
      'A importacao precisa ser confirmada antes de processar (secao 11). '
      + 'Reveja a pre-visualizacao e confirme.');
  }
  if (!imp.caminho) {
    throw regraNegocio(
      'Esta importacao foi iniciada pelo navegador. Use o endpoint '
      + '/processar-lote para enviar os dados em lotes.');
  }

  const gravador = GRAVADORES[String(imp.entidade)];
  if (!gravador) {
    throw regraNegocio(
      `Nao ha gravador para a entidade "${imp.entidade}". `
      + `Disponiveis: ${entidadesSuportadas().join(', ') || '(nenhum)'}`);
  }

  const template = await mapeador.obterTemplate(Number(imp.template_id));
  const formato = String(imp.formato) as leitor.Formato;
  const caminho = String(imp.caminho);
  const tamanhoLote = await configNumero('importacao_lote_linhas', 1000);
  const maxLinhas = await configNumero('importacao_max_linhas', 1_000_000);

  await query(
    "UPDATE importacoes SET status = 'PROCESSANDO' WHERE id = $1", [importacaoId]);

  const { rows: execucao } = await query<{ id: string }>(`
    INSERT INTO integracao_execucoes
      (integracao_id, integracao_codigo, tipo, direcao, entidade, modo,
       disparado_por, usuario_id)
    VALUES ($1, (SELECT codigo FROM integracoes WHERE id = $1), 'IMPORTACAO',
            'ENTRADA', $2, 'MANUAL', $3, $4)
    RETURNING id`,
  [imp.integracao_id ?? null, imp.entidade,
    `IMPORTACAO:${importacaoId}`, contexto.usuarioId ?? null]);
  const execucaoId = Number(execucao[0]!.id);

  const inspecao = await leitor.inspecionar(caminho, formato, {
    linhaCabecalho: Number(imp.linha_cabecalho), amostra: 1,
  });
  const casamento = mapeador.casarColunas(template, inspecao.colunas);

  const inicio = Date.now();
  let total = 0;
  let criados = 0;
  let atualizados = 0;
  let descartados = 0;
  let rejeitados = 0;
  const motivos = new Map<string, number>();
  let lote: Array<{ linha: number; dados: Record<string, unknown> }> = [];

  // Vive por toda a execucao e atravessa os lotes. Ver o comentario do tipo
  // Gravador: e o que impede um lote de desfazer o trabalho do anterior.
  const estado: EstadoImportacao = new Map();

  const descarregar = async () => {
    if (!lote.length) return;
    const r = await gravador(lote, contexto, estado);
    criados += r.criados;
    atualizados += r.atualizados;
    descartados += r.descartados;
    rejeitados += r.rejeitados;
    for (const [motivo, n] of r.motivos) {
      motivos.set(motivo, (motivos.get(motivo) ?? 0) + n);
    }
    lote = [];
  };

  try {
    const gerador = leitor.ler(caminho, formato, {
      linhaCabecalho: Number(imp.linha_cabecalho),
      maxLinhas,
      ...(imp.separador ? { separador: String(imp.separador) } : {}),
    });

    let passo = await gerador.next();
    while (!passo.done) {
      const resultado = mapeador.aplicarLinha(template, casamento, passo.value.valores);
      total += 1;

      if (!resultado.valido) {
        rejeitados += 1;
        const primeiro = resultado.ocorrencias.find((o) => o.severidade === 'ERRO');
        const motivo = primeiro ? `${primeiro.regra}: ${primeiro.campo ?? ''}` : 'invalida';
        motivos.set(motivo, (motivos.get(motivo) ?? 0) + 1);
      } else {
        lote.push({ linha: passo.value.numero, dados: resultado.dados });
        if (lote.length >= tamanhoLote) await descarregar();
      }

      passo = await gerador.next();
    }
    await descarregar();

    const comErros = rejeitados > 0;
    const duracao = Date.now() - inicio;

    await query(`
      UPDATE importacoes
         SET status = $2::status_importacao_enum, total_linhas = $3,
             registros_criados = $4, registros_atualizados = $5,
             registros_descartados = $6, linhas_com_erro = $7,
             concluido_em = now(), duracao_ms = $8, execucao_id = $9,
             resumo = coalesce(resumo, '{}'::jsonb) || $10::jsonb
       WHERE id = $1`,
    [importacaoId, comErros ? 'CONCLUIDA_COM_ERROS' : 'CONCLUIDA', total,
      criados, atualizados, descartados, rejeitados, duracao, execucaoId,
      JSON.stringify({ motivos: Object.fromEntries(motivos) })]);

    await query(`
      UPDATE integracao_execucoes
         SET status = $2::status_execucao_integracao_enum, concluido_em = now(),
             duracao_ms = $3, registros_lidos = $4, registros_criados = $5,
             registros_atualizados = $6, registros_descartados = $7,
             registros_rejeitados = $8, resumo = $9::jsonb
       WHERE id = $1`,
    [execucaoId, comErros ? 'CONCLUIDA_COM_ERROS' : 'CONCLUIDA', duracao,
      total, criados, atualizados, descartados, rejeitados,
      JSON.stringify({ arquivo: imp.nome_arquivo, motivos: Object.fromEntries(motivos) })]);

    // A importacao conta como sincronizacao da integracao de origem. Sem isto,
    // um conector de ARQUIVO que acabou de importar 426 mil linhas apareceria
    // no painel como "nunca sincronizou" - e o operador procuraria um problema
    // que nao existe.
    if (imp.integracao_id) {
      await query(`
        UPDATE integracoes
           SET ultima_sincronizacao = now(),
               ultimo_status = $2,
               status = CASE WHEN $3 THEN 'ATENCAO' ELSE 'OPERACIONAL' END
                        ::status_conector_enum,
               ultima_execucao_id = $4,
               registros_processados = registros_processados + $5,
               registros_rejeitados = registros_rejeitados + $6
         WHERE id = $1`,
      [Number(imp.integracao_id), comErros ? 'IMPORTACAO_COM_ERROS' : 'OK',
        comErros, execucaoId, criados + atualizados, rejeitados]);
    }

    if (comErros) {
      await avisarErros(importacaoId, String(imp.nome_arquivo), rejeitados, total, contexto);
    }

    return {
      importacao_id: importacaoId,
      status: comErros ? 'CONCLUIDA_COM_ERROS' : 'CONCLUIDA',
      total_linhas: total,
      criados,
      atualizados,
      descartados,
      rejeitados,
      duracao_ms: duracao,
      detalhes: {
        execucao_id: execucaoId,
        motivos: Object.fromEntries(
          [...motivos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)),
        // O descarte e informado sempre, mesmo quando e zero: e o numero que
        // responde "por que importei 400 mil linhas e so 300 mil viraram venda".
        descarte_explicado: descartados > 0,
      },
    };
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await query(`
      UPDATE importacoes SET status = 'CONCLUIDA_COM_ERROS', erro = $2,
             concluido_em = now(), duracao_ms = $3
       WHERE id = $1`, [importacaoId, mensagem.slice(0, 2000), Date.now() - inicio]);
    await query(`
      UPDATE integracao_execucoes
         SET status = 'FALHOU', concluido_em = now(), erro = $2 WHERE id = $1`,
    [execucaoId, mensagem.slice(0, 2000)]);
    throw erro;
  }
}

async function avisarErros(
  importacaoId: number, arquivo: string, rejeitados: number, total: number,
  contexto: ContextoSessao,
): Promise<void> {
  await registrarAlerta({
    chave: `importacao-erros:${importacaoId}`,
    tipo: 'IMPORTACAO_COM_ERROS',
    categoria: 'importacao',
    prioridade: rejeitados / Math.max(total, 1) > 0.1 ? 'ALTO' : 'MEDIO',
    titulo: `Importacao de ${arquivo} deixou ${rejeitados} linha(s) para tras`,
    mensagem: `${rejeitados} de ${total} linhas foram rejeitadas. `
      + 'Baixe o relatorio de erros para ver o motivo linha a linha.',
    origem: 'integracao:importacao',
    entidade: 'importacao',
    entidade_id: importacaoId,
    link: `/integracoes/importacoes?id=${importacaoId}`,
    valor: rejeitados,
    limite: total,
  }, contexto);

  await eventos.registrar({
    tipo: 'IMPORT_COMPLETED_WITH_ERRORS',
    origem: 'INTEGRACAO',
    entidade: 'importacao',
    entidade_id: importacaoId,
    payload: { arquivo, rejeitados, total,
      percentual: Math.round((rejeitados / Math.max(total, 1)) * 1000) / 10 },
  }, contexto);
}

// ---------------------------------------------------------------------------
// Confirmacao e consulta
// ---------------------------------------------------------------------------

export async function confirmar(
  importacaoId: number, usuarioId: number,
): Promise<{ id: number; confirmado_em: string }> {
  const { rows } = await query<{ confirmado_em: string }>(`
    UPDATE importacoes
       SET confirmado_em = now(), confirmado_por = $2
     WHERE id = $1 AND status = 'AGUARDANDO_CONFIRMACAO' AND confirmado_em IS NULL
     RETURNING confirmado_em`, [importacaoId, usuarioId]);

  if (!rows.length) {
    throw regraNegocio(
      'A importacao nao esta aguardando confirmacao ou ja foi confirmada');
  }
  return { id: importacaoId, confirmado_em: rows[0]!.confirmado_em };
}

/**
 * Casamento com as chaves ja em objeto simples.
 *
 * `casarColunas` devolve um Map, que e o certo para uso interno e o errado para
 * sair pela API: `JSON.stringify` transforma Map em `{}`, entao a tela que
 * mostra "coluna X virou campo Y" exibiria nada, sem erro nenhum para explicar.
 */
export interface CasamentoSerializavel {
  encontradas: Record<string, string>;
  faltando: string[];
  desconhecidas: string[];
  obrigatorios_ausentes: string[];
}

export async function definirMapeamento(
  importacaoId: number, templateCodigo: string,
): Promise<{ id: number; template: string; casamento: CasamentoSerializavel }> {
  const imp = await obter(importacaoId);
  const template = await mapeador.obterTemplate(templateCodigo);

  if (template.entidade !== imp.entidade) {
    throw regraNegocio(
      `O template e da entidade "${template.entidade}" e a importacao e de `
      + `"${imp.entidade}"`);
  }

  const colunas = (imp.colunas_detectadas as string[]) ?? [];
  const casamento = mapeador.casarColunas(template, colunas);

  if (casamento.obrigatorios_ausentes.length) {
    throw regraNegocio(
      `O arquivo nao tem as colunas obrigatorias: ${casamento.obrigatorios_ausentes.join(', ')}`);
  }

  await query(`
    UPDATE importacoes SET template_id = $2, status = 'VALIDANDO' WHERE id = $1`,
  [importacaoId, template.id]);

  await query(
    'UPDATE integracao_templates SET vezes_usado = vezes_usado + 1 WHERE id = $1',
    [template.id]);

  return {
    id: importacaoId,
    template: template.codigo,
    casamento: {
      ...casamento,
      encontradas: Object.fromEntries(casamento.encontradas),
    },
  };
}

export async function cancelar(importacaoId: number, motivo: string): Promise<void> {
  const { rowCount } = await query(`
    UPDATE importacoes
       SET status = 'CANCELADA', erro = $2, concluido_em = now()
     WHERE id = $1 AND status NOT IN ('CONCLUIDA', 'CONCLUIDA_COM_ERROS', 'PROCESSANDO')`,
  [importacaoId, motivo]);
  if (!rowCount) {
    throw regraNegocio('A importacao ja terminou ou esta processando');
  }
}

export async function obter(id: number): Promise<Record<string, unknown>> {
  const { rows } = await query(`
    SELECT i.*, i.status::text AS status, i.formato::text AS formato,
           i.origem::text AS origem, t.codigo AS template_codigo,
           u.nome AS usuario, c.nome AS confirmado_por_nome
      FROM importacoes i
      LEFT JOIN integracao_templates t ON t.id = i.template_id
      LEFT JOIN usuarios u ON u.id = i.usuario_id
      LEFT JOIN usuarios c ON c.id = i.confirmado_por
     WHERE i.id = $1`, [id]);
  if (!rows.length) throw naoEncontrado('Importacao');
  return rows[0] as Record<string, unknown>;
}

export async function listar(filtro: {
  status?: string; entidade?: string; limite?: number; pagina?: number;
}) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const add = (sql: string, valor: unknown) => {
    if (valor === undefined || valor === null || valor === '') return;
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  add('i.status = $?::status_importacao_enum', filtro.status);
  add('i.entidade = $?', filtro.entidade);

  const limite = Math.min(Math.max(filtro.limite ?? 50, 1), 200);
  const pagina = Math.max(filtro.pagina ?? 1, 1);
  valores.push(limite, (pagina - 1) * limite);

  const { rows } = await query(`
    SELECT i.id, i.nome_arquivo, i.formato::text AS formato, i.entidade,
           i.origem::text AS origem, i.status::text AS status,
           i.total_linhas, i.linhas_validas, i.linhas_com_erro, i.linhas_com_alerta,
           i.registros_criados, i.registros_atualizados, i.registros_descartados,
           i.duracao_ms, i.created_at, i.confirmado_em, i.concluido_em, i.erro,
           t.codigo AS template, u.nome AS usuario,
           count(*) OVER () AS total
      FROM importacoes i
      LEFT JOIN integracao_templates t ON t.id = i.template_id
      LEFT JOIN usuarios u ON u.id = i.usuario_id
     ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT $${valores.length - 1} OFFSET $${valores.length}`, valores);

  return {
    total: rows.length ? Number((rows[0] as { total: string }).total) : 0,
    pagina,
    limite,
    importacoes: rows.map((r) => {
      const { total: _t, ...i } = r as Record<string, unknown>;
      return i;
    }),
  };
}

/** Ocorrencias para o relatorio de erros baixavel (secao 13). */
export async function ocorrencias(
  importacaoId: number, filtro: { severidade?: string; limite?: number } = {},
) {
  const limite = Math.min(Math.max(filtro.limite ?? 500, 1), 5000);
  const { rows } = await query(`
    SELECT linha, coluna, campo, severidade::text AS severidade, regra,
           mensagem, valor
      FROM importacao_ocorrencias
     WHERE importacao_id = $1
       ${filtro.severidade ? 'AND severidade = $3::severidade_validacao_enum' : ''}
     ORDER BY CASE severidade WHEN 'ERRO' THEN 1 WHEN 'ALERTA' THEN 2 ELSE 3 END, linha
     LIMIT $2`,
  filtro.severidade ? [importacaoId, limite, filtro.severidade] : [importacaoId, limite]);
  return rows;
}

/** Remove o arquivo do disco depois de processado, mantendo o registro. */
export async function descartarArquivo(importacaoId: number): Promise<boolean> {
  const { rows } = await query<{ caminho: string | null }>(
    'SELECT caminho FROM importacoes WHERE id = $1', [importacaoId]);
  const caminho = rows[0]?.caminho;
  if (!caminho) return false;
  try {
    await unlink(caminho);
  } catch {
    return false;
  }
  await query('UPDATE importacoes SET caminho = NULL WHERE id = $1', [importacaoId]);
  return true;
}

export { pool as poolImportacao, comTransacao as transacaoImportacao };

// ---------------------------------------------------------------------------
// Importacao iniciada pelo navegador (sem upload de arquivo)
// ---------------------------------------------------------------------------

export interface EntradaImportacaoClient {
  nome_arquivo: string;
  entidade: string;
  colunas: string[];
  amostra: Record<string, unknown>[];
  total_linhas: number;
  template?: string | null;
  integracao?: string | null;
}

/**
 * Cria o registro de importacao a partir de dados ja parseados no navegador.
 *
 * Usado quando o arquivo e grande demais para o limite de corpo da Vercel
 * (4.5 MB). O navegador le e serializa a planilha com SheetJS, envia
 * cabecalho + amostra aqui para analise, e depois processa as linhas em lotes
 * via `processarLoteClient`. Nenhum arquivo chega ao servidor.
 */
export async function iniciarImportacaoClient(
  entrada: EntradaImportacaoClient,
  contexto: ContextoSessao,
): Promise<Analise> {
  const { createHash } = await import('node:crypto');
  const hashBase = entrada.nome_arquivo + '|' + JSON.stringify(entrada.amostra.slice(0, 3));
  const hash = createHash('sha256').update(hashBase).digest('hex');

  const { rows: anterior } = await query<{
    id: string; created_at: string; registros_criados: number; status: string;
  }>(`SELECT id, created_at, registros_criados, status::text AS status
        FROM importacoes
       WHERE hash_arquivo = $1
         AND status IN ('CONCLUIDA', 'CONCLUIDA_COM_ERROS')
       ORDER BY id DESC LIMIT 1`, [hash]);

  const maxLinhas = await configNumero('importacao_max_linhas', 1_000_000);
  if (entrada.total_linhas > maxLinhas) {
    throw regraNegocio(
      `O arquivo tem ${entrada.total_linhas} linhas, acima do limite de ${maxLinhas}`);
  }

  const impedimentos: string[] = [];
  if (!entrada.colunas.length) {
    impedimentos.push('Nenhuma coluna encontrada no arquivo.');
  }

  let template: mapeador.Template | null = null;
  let casamento: mapeador.Casamento | null = null;

  if (entrada.template) {
    template = await mapeador.obterTemplate(entrada.template);
    if (template.entidade !== entrada.entidade) {
      impedimentos.push(
        `O template ${template.codigo} e da entidade "${template.entidade}" e a `
        + `importacao pediu "${entrada.entidade}".`);
    }
    casamento = mapeador.casarColunas(template, entrada.colunas);
    for (const campo of casamento.obrigatorios_ausentes) {
      impedimentos.push(
        `A coluna obrigatoria "${campo}" nao existe no arquivo.`);
    }
  }

  const { rows } = await query<{ id: string }>(`
    INSERT INTO importacoes
      (nome_arquivo, formato, entidade, origem, caminho, hash_arquivo,
       template_id, linha_cabecalho, colunas_detectadas, amostra, status,
       total_linhas, usuario_id, integracao_id, analisado_em)
    VALUES ($1, 'CSV'::formato_arquivo_enum, $2, 'CSV'::origem_registro_enum, NULL, $3,
            $4, 1, $5::jsonb, $6::jsonb, $7::status_importacao_enum, $8, $9,
            (SELECT id FROM integracoes WHERE upper(codigo) = upper($10)), now())
    RETURNING id`,
  [entrada.nome_arquivo, entrada.entidade, hash,
    template?.id ?? null,
    JSON.stringify(entrada.colunas), JSON.stringify(entrada.amostra),
    impedimentos.length ? 'REJEITADA'
      : template ? 'AGUARDANDO_CONFIRMACAO' : 'AGUARDANDO_MAPEAMENTO',
    entrada.total_linhas, contexto.usuarioId ?? null, entrada.integracao ?? null]);

  const importacaoId = Number(rows[0]!.id);

  if (impedimentos.length) {
    await query('UPDATE importacoes SET erro = $2 WHERE id = $1',
      [importacaoId, impedimentos.join(' ')]);
  }

  return {
    importacao_id: importacaoId,
    status: impedimentos.length ? 'REJEITADA'
      : template ? 'AGUARDANDO_CONFIRMACAO' : 'AGUARDANDO_MAPEAMENTO',
    formato: 'CSV',
    colunas: entrada.colunas,
    total_estimado: entrada.total_linhas,
    ...(casamento ? {
      casamento: {
        encontradas: Object.fromEntries(casamento.encontradas),
        faltando: casamento.faltando,
        desconhecidas: casamento.desconhecidas,
        obrigatorios_ausentes: casamento.obrigatorios_ausentes,
      },
    } : {
      sugestoes: mapeador.sugerirMapeamento(entrada.colunas),
    }),
    amostra: entrada.amostra,
    ...(anterior.length ? {
      ja_importado: {
        importacao_id: Number(anterior[0]!.id),
        em: anterior[0]!.created_at,
        registros: anterior[0]!.registros_criados,
      },
    } : {}),
    impedimentos,
  };
}

/**
 * Valida a amostra armazenada (importacoes.amostra) em vez do arquivo completo.
 *
 * Chamado por `validar()` quando `caminho IS NULL`: o arquivo nao existe no
 * servidor, mas a amostra enviada durante `iniciarImportacaoClient` basta para
 * confirmar que o mapeamento faz sentido. O total real vem de `total_linhas`.
 */
async function validarAmostra(
  imp: Record<string, unknown>,
  importacaoId: number,
): Promise<Validacao> {
  const template = await mapeador.obterTemplate(Number(imp.template_id));
  const colunas = (imp.colunas_detectadas as string[]) ?? [];
  const casamento = mapeador.casarColunas(template, colunas);
  const amostra = (imp.amostra as Record<string, unknown>[]) ?? [];

  await query("UPDATE importacoes SET status = 'VALIDANDO' WHERE id = $1", [importacaoId]);
  await query('DELETE FROM importacao_ocorrencias WHERE importacao_id = $1', [importacaoId]);

  const inicio = Date.now();
  let validas = 0;
  let comErro = 0;
  let comAlerta = 0;
  const porRegra = new Map<string, { severidade: string; total: number; exemplo: string }>();
  const previa: Validacao['previa'] = [];

  for (let i = 0; i < amostra.length; i++) {
    const resultado = mapeador.aplicarLinha(template, casamento, amostra[i]!);
    if (resultado.valido) validas += 1; else comErro += 1;
    const temAlerta = resultado.ocorrencias.some((o) => o.severidade === 'ALERTA');
    if (temAlerta) comAlerta += 1;

    for (const o of resultado.ocorrencias) {
      const chave = `${o.severidade}|${o.regra}|${o.campo ?? o.coluna ?? ''}`;
      const atual = porRegra.get(chave);
      if (atual) { atual.total += 1; }
      else { porRegra.set(chave, { severidade: o.severidade, total: 1, exemplo: `linha ${i + 2}: ${o.mensagem}` }); }
    }
    if (previa.length < 20) {
      previa.push({ linha: i + 2, dados: resultado.dados, valido: resultado.valido });
    }
  }

  const totalLinhas = Number(imp.total_linhas) || amostra.length;
  const duracao = Date.now() - inicio;

  await query(`
    UPDATE importacoes
       SET status = 'AGUARDANDO_CONFIRMACAO', mapeamento = $2::jsonb, resumo = $3::jsonb
     WHERE id = $1`,
  [importacaoId,
    JSON.stringify(Object.fromEntries(casamento.encontradas)),
    JSON.stringify({
      duracao_validacao_ms: duracao,
      amostra_validada: true,
      linhas_amostra: amostra.length,
      colunas_desconhecidas: casamento.desconhecidas,
      colunas_faltando: casamento.faltando,
    })]);

  return {
    importacao_id: importacaoId,
    total_linhas: totalLinhas,
    validas,
    com_erro: comErro,
    com_alerta: comAlerta,
    truncado: true,
    duracao_ms: duracao,
    ocorrencias_por_regra: [...porRegra.entries()]
      .map(([chave, v]) => ({
        regra: chave.split('|').slice(1).join(' '),
        severidade: v.severidade,
        total: v.total,
        exemplo: v.exemplo,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 50),
    previa,
  };
}

/**
 * Processa um lote de linhas ja parseadas pelo navegador.
 *
 * O navegador envia os dados em lotes de ate 8 mil linhas (ca. 3 MB JSON).
 * Cada lote e validado e gravado imediatamente; o estado entre lotes (quais
 * documentos ja tiveram os itens limpos, o id da execucao) vive em
 * `importacoes.resumo` enquanto o processamento esta em andamento.
 */
export async function processarLoteClient(
  importacaoId: number,
  lote: number,
  totalLotes: number,
  linhas: Array<Record<string, unknown>>,
  isLast: boolean,
  contexto: ContextoSessao,
): Promise<{
  lote: number;
  criados: number;
  atualizados: number;
  descartados: number;
  rejeitados: number;
  concluida: boolean;
  importacao_id: number;
  status?: StatusImportacao;
  total_linhas?: number;
  motivos?: Record<string, number>;
}> {
  const imp = await obter(importacaoId);

  if (!imp.confirmado_em) {
    throw regraNegocio('Confirme a importacao antes de processar');
  }
  if (!imp.template_id) {
    throw regraNegocio('Defina o mapeamento antes de processar');
  }

  const gravador = GRAVADORES[String(imp.entidade)];
  if (!gravador) {
    throw regraNegocio(
      `Nao ha gravador para a entidade "${imp.entidade}". `
      + `Disponiveis: ${entidadesSuportadas().join(', ') || '(nenhum)'}`);
  }

  const template = await mapeador.obterTemplate(Number(imp.template_id));
  const colunas = (imp.colunas_detectadas as string[]) ?? [];
  const casamento = mapeador.casarColunas(template, colunas);
  const resumo = (imp.resumo as Record<string, unknown>) ?? {};

  let execucaoId: number;
  if (lote === 0) {
    await query("UPDATE importacoes SET status = 'PROCESSANDO' WHERE id = $1", [importacaoId]);
    const { rows: execRows } = await query<{ id: string }>(`
      INSERT INTO integracao_execucoes
        (integracao_id, integracao_codigo, tipo, direcao, entidade, modo,
         disparado_por, usuario_id)
      VALUES ($1, (SELECT codigo FROM integracoes WHERE id = $1), 'IMPORTACAO',
              'ENTRADA', $2, 'MANUAL', $3, $4)
      RETURNING id`,
    [imp.integracao_id ?? null, imp.entidade,
      `IMPORTACAO:${importacaoId}`, contexto.usuarioId ?? null]);
    execucaoId = Number(execRows[0]!.id);
  } else {
    execucaoId = Number((resumo as Record<string, number>)._execucao_id) || 0;
  }

  const estadoRaw = (resumo._estado ?? {}) as Record<string, unknown>;
  const estado: EstadoImportacao = new Map(Object.entries(estadoRaw));

  let criados = 0;
  let atualizados = 0;
  let descartados = 0;
  let rejeitados = 0;
  const loteGravar: Array<{ linha: number; dados: Record<string, unknown> }> = [];
  const linhaBase = lote * linhas.length;
  const motivos = new Map<string, number>(
    Object.entries((resumo._motivos ?? {}) as Record<string, number>));
  const contar = (motivo: string, n: number) =>
    motivos.set(motivo, (motivos.get(motivo) ?? 0) + n);

  for (let i = 0; i < linhas.length; i++) {
    const resultado = mapeador.aplicarLinha(template, casamento, linhas[i]!);
    if (resultado.valido) {
      loteGravar.push({ linha: linhaBase + i + 2, dados: resultado.dados });
    } else {
      rejeitados += 1;
      const primeiro = resultado.ocorrencias.find((o) => o.severidade === 'ERRO');
      contar(primeiro ? `${primeiro.regra}: ${primeiro.campo ?? ''}` : 'linha invalida', 1);
    }
  }

  if (loteGravar.length > 0) {
    const r = await gravador(loteGravar, contexto, estado);
    criados += r.criados;
    atualizados += r.atualizados;
    descartados += r.descartados;
    rejeitados += r.rejeitados;
    for (const [motivo, n] of r.motivos) contar(motivo, n);
  }

  const novoCriados = Number(resumo._criados ?? 0) + criados;
  const novoAtualizados = Number(resumo._atualizados ?? 0) + atualizados;
  const novoDescartados = Number(resumo._descartados ?? 0) + descartados;
  const novoRejeitados = Number(resumo._rejeitados ?? 0) + rejeitados;
  const novoTotal = Number(resumo._total ?? 0) + linhas.length;

  await query(`
    UPDATE importacoes
       SET resumo = coalesce(resumo, '{}'::jsonb) || $2::jsonb
     WHERE id = $1`,
  [importacaoId, JSON.stringify({
    _execucao_id: execucaoId,
    _estado: Object.fromEntries(estado),
    _criados: novoCriados,
    _atualizados: novoAtualizados,
    _descartados: novoDescartados,
    _rejeitados: novoRejeitados,
    _total: novoTotal,
    _motivos: Object.fromEntries(motivos),
  })]);

  if (!isLast) {
    return {
      lote, criados, atualizados, descartados, rejeitados,
      concluida: false, importacao_id: importacaoId,
    };
  }

  const comErros = novoRejeitados > 0;
  await query(`
    UPDATE importacoes
       SET status = $2::status_importacao_enum,
           total_linhas = $3, registros_criados = $4, registros_atualizados = $5,
           registros_descartados = $6, linhas_com_erro = $7,
           concluido_em = now(), execucao_id = $8
     WHERE id = $1`,
  [importacaoId,
    comErros ? 'CONCLUIDA_COM_ERROS' : 'CONCLUIDA',
    novoTotal, novoCriados, novoAtualizados, novoDescartados, novoRejeitados, execucaoId]);

  await query(`
    UPDATE integracao_execucoes
       SET status = $2::status_execucao_integracao_enum, concluido_em = now(),
           registros_lidos = $3, registros_criados = $4, registros_atualizados = $5,
           registros_descartados = $6, registros_rejeitados = $7
     WHERE id = $1`,
  [execucaoId,
    comErros ? 'CONCLUIDA_COM_ERROS' : 'CONCLUIDA',
    novoTotal, novoCriados, novoAtualizados, novoDescartados, novoRejeitados]);

  // Importacao de vendas precisa atualizar as views materializadas de demanda
  // para que o modulo de Demanda (historico, dashboard, previsao) enxergue os
  // novos registros imediatamente. CONCURRENTLY nao bloqueia leituras.
  if (String(imp.entidade) === 'vendas') {
    await query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_demanda_diaria');
    await query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_demanda_mensal');
  }

  if (comErros) {
    await avisarErros(
      importacaoId, String(imp.nome_arquivo), novoRejeitados, novoTotal, contexto);
  }

  return {
    lote,
    criados: novoCriados,
    atualizados: novoAtualizados,
    descartados: novoDescartados,
    rejeitados: novoRejeitados,
    concluida: true,
    importacao_id: importacaoId,
    status: comErros ? 'CONCLUIDA_COM_ERROS' : 'CONCLUIDA',
    total_linhas: novoTotal,
    motivos: Object.fromEntries(
      [...motivos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)),
  };
}
