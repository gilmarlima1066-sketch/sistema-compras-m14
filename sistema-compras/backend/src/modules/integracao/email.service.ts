/**
 * E-mail: recebimento, extracao e cotacao por e-mail (secoes 15 a 18).
 *
 * O que este modulo faz e o que ele NAO faz precisam ficar claros:
 *
 * FAZ: recebe a mensagem (payload vindo de webhook ou de coleta), guarda o que
 * chegou, identifica de qual fornecedor e, extrai os dados da proposta e
 * **apresenta para validacao**. Gera tarefa para um humano conferir.
 *
 * NAO FAZ: registrar proposta, alterar preco, criar pedido. A secao 16 e
 * explicita - "a IA devera apresentar os dados extraidos para validacao antes
 * de alterar registros criticos". Preco de compra e registro critico.
 *
 * A EXTRACAO E DETERMINISTICA, nao um modelo de linguagem.
 *
 * O ambiente nao alcanca nenhuma API externa, e mesmo que alcancasse, mandar a
 * correspondencia comercial da empresa para fora seria decisao do dono do
 * sistema. A extracao usa expressao regular e vizinhanca de palavras-chave
 * sobre o texto e sobre a planilha anexa - o mesmo caminho do modulo 12. Em
 * troca: e reproduzivel, explica de onde tirou cada numero, e nunca inventa um
 * preco que nao estava na mensagem.
 */
import { createHash } from 'node:crypto';
import { query, type ContextoSessao } from '../../config/database.js';
import { naoEncontrado, regraNegocio } from '../../core/errors.js';
import * as eventos from '../automacao/eventos.service.js';
import * as tarefas from '../automacao/tarefas.service.js';
import * as norma from './normalizacao.js';
import * as sincronizacao from './sincronizacao.service.js';

export interface Anexo {
  nome: string;
  tipo: string;
  tamanho?: number;
  /** Conteudo textual ja extraido, quando houver. */
  texto?: string;
  caminho?: string;
}

export interface EmailRecebido {
  remetente: string;
  assunto: string;
  corpo: string;
  recebido_em?: string;
  message_id?: string;
  anexos?: Anexo[];
}

export type Natureza = 'FATO' | 'EXTRAIDO' | 'INFERIDO';

export interface Campo<T> {
  valor: T | null;
  natureza: Natureza;
  /** De onde saiu: "assunto", "corpo linha 12", "anexo tabela.xlsx". */
  fonte: string;
  confianca: 'ALTA' | 'MEDIA' | 'BAIXA';
  trecho?: string;
}

export interface Extracao {
  fornecedor: Campo<{ id: number; razao_social: string }>;
  itens: Array<{
    produto: Campo<{ id: number; codigo: string; descricao: string }>;
    quantidade: Campo<number>;
    preco: Campo<number>;
  }>;
  prazo_entrega_dias: Campo<number>;
  condicao_pagamento: Campo<string>;
  frete: Campo<number>;
  validade_proposta: Campo<string>;
  moeda: Campo<string>;
  /** O que o extrator NAO conseguiu determinar, dito com todas as letras. */
  lacunas: string[];
  confianca_geral: 'ALTA' | 'MEDIA' | 'BAIXA' | 'INSUFICIENTE';
}

const vazio = <T>(fonte = 'nao encontrado'): Campo<T> => ({
  valor: null, natureza: 'EXTRAIDO', fonte, confianca: 'BAIXA',
});

// ---------------------------------------------------------------------------
// Recebimento
// ---------------------------------------------------------------------------

/**
 * Registra o e-mail como MENSAGEM de integracao e gera o evento.
 *
 * O `message_id` e a chave natural: reenviar o mesmo e-mail - o que acontece
 * quando o servidor repete a entrega - nao pode virar duas propostas.
 */
export async function receber(
  email: EmailRecebido, contexto: ContextoSessao,
  codigoIntegracao = 'EMAIL_COMPRAS',
): Promise<{
  mensagem_id: number; desfecho: string; fornecedor_id: number | null;
  classificacao: string; tarefa_id?: number;
}> {
  const integracao = await sincronizacao.obter(codigoIntegracao);

  const chave = email.message_id?.trim()
    || createHash('sha256')
      .update(`${email.remetente}|${email.assunto}|${email.corpo.slice(0, 500)}`)
      .digest('hex').slice(0, 48);

  const execucao = await sincronizacao.abrirExecucao({
    integracao, tipo: 'SINCRONIZACAO', direcao: 'ENTRADA', entidade: 'email',
    modo: 'TEMPO_REAL', disparado_por: 'EMAIL',
  }, contexto);

  const fornecedor = await identificarFornecedor(email.remetente);
  const classificacao = classificar(email);

  const { id, desfecho } = await sincronizacao.registrarMensagem({
    integracao, execucao_id: execucao.id, direcao: 'ENTRADA', entidade: 'email',
    origem: 'EMAIL',
    chave_externa: chave,
    payload: {
      remetente: email.remetente,
      assunto: email.assunto,
      // O corpo e truncado: a mensagem serve para rastrear e reprocessar, nao
      // para virar arquivo de correspondencia.
      corpo: email.corpo.slice(0, 20000),
      recebido_em: email.recebido_em ?? new Date().toISOString(),
      anexos: (email.anexos ?? []).map((a) => ({
        nome: a.nome, tipo: a.tipo, tamanho: a.tamanho ?? null,
      })),
      classificacao,
      fornecedor_id: fornecedor?.id ?? null,
    },
    correlation_id: execucao.correlation_id,
  }, contexto);

  await sincronizacao.fecharExecucao(execucao.id, {
    status: 'CONCLUIDA',
    lidos: 1,
    criados: desfecho === 'NOVA' ? 1 : 0,
    descartados: desfecho === 'INALTERADA' ? 1 : 0,
    resumo: { classificacao, remetente: email.remetente, assunto: email.assunto },
  });

  if (desfecho === 'INALTERADA') {
    return {
      mensagem_id: id, desfecho, fornecedor_id: fornecedor?.id ?? null,
      classificacao,
    };
  }

  // O e-mail vira EVENTO; o motor de regras do modulo 13 decide o que fazer.
  // A integracao nao abre cotacao nem registra proposta por conta propria.
  const evento = await eventos.registrar({
    tipo: classificacao === 'PROPOSTA' ? 'QUOTE_RECEIVED' : 'WEBHOOK_RECEIVED',
    origem: 'INTEGRACAO',
    entidade: 'email',
    entidade_id: id,
    chave: `email:${chave}`,
    payload: {
      remetente: email.remetente,
      assunto: email.assunto,
      classificacao,
      fornecedor_id: fornecedor?.id ?? null,
      fornecedor_nome: fornecedor?.razao_social ?? null,
      anexos: (email.anexos ?? []).length,
    },
  }, contexto);

  await query(
    'UPDATE integracao_mensagens SET evento_id = $2 WHERE id = $1', [id, evento.id]);

  return {
    mensagem_id: id, desfecho, fornecedor_id: fornecedor?.id ?? null, classificacao,
  };
}

/** Classifica pelo assunto e pelo corpo. Heuristica simples, dita como tal. */
export function classificar(email: EmailRecebido): string {
  const texto = `${email.assunto} ${email.corpo}`.toLowerCase();
  const tem = (...termos: string[]) => termos.some((t) => texto.includes(t));

  if (tem('proposta', 'cotação', 'cotacao', 'orçamento', 'orcamento', 'preço por')) {
    return 'PROPOSTA';
  }
  if (tem('nota fiscal', 'nfe', 'nf-e', 'danfe', 'xml da nota')) return 'DOCUMENTO_FISCAL';
  if (tem('confirmação do pedido', 'confirmacao do pedido', 'pedido confirmado')) {
    return 'CONFIRMACAO_PEDIDO';
  }
  if (tem('entrega', 'rastreio', 'transportadora', 'previsão de chegada')) {
    return 'LOGISTICA';
  }
  if (tem('reajuste', 'aumento de preço', 'tabela de preços', 'nova tabela')) {
    return 'TABELA_PRECOS';
  }
  return 'OUTRO';
}

async function identificarFornecedor(
  remetente: string,
): Promise<{ id: number; razao_social: string } | null> {
  const email = remetente.toLowerCase().replace(/^.*<|>.*$/g, '').trim();
  const dominio = email.split('@')[1];

  // Primeiro pelo e-mail exato; depois pelo dominio, que casa quando o
  // vendedor escreve de um endereco pessoal da mesma empresa.
  const { rows } = await query<{ id: string; razao_social: string }>(`
    SELECT id, razao_social FROM fornecedores
     WHERE deleted_at IS NULL AND ativo
       AND (lower(email) = $1 OR ($2 <> '' AND lower(email) LIKE '%@' || $2))
     ORDER BY CASE WHEN lower(email) = $1 THEN 0 ELSE 1 END
     LIMIT 1`, [email, dominio ?? '']);

  return rows.length
    ? { id: Number(rows[0]!.id), razao_social: rows[0]!.razao_social } : null;
}

// ---------------------------------------------------------------------------
// Extracao (secao 16)
// ---------------------------------------------------------------------------

const NUMERO = String.raw`(-?[\d.,]+)`;

function buscar(
  texto: string, padroes: RegExp[], fonte: string,
): { valor: string; trecho: string; indice: number } | null {
  for (const padrao of padroes) {
    const m = padrao.exec(texto);
    if (m && m[1]) {
      const inicio = Math.max(0, m.index - 30);
      return {
        valor: m[1],
        trecho: texto.slice(inicio, Math.min(texto.length, m.index + m[0].length + 30))
          .replace(/\s+/g, ' ').trim(),
        indice: m.index,
      };
    }
  }
  return null;
}

/**
 * Extrai os campos da secao 16 do texto do e-mail e dos anexos.
 *
 * Cada campo devolve valor, NATUREZA, FONTE e CONFIANCA - a mesma disciplina
 * do modulo 12. Um preco extraido do corpo de um e-mail nao tem o mesmo peso
 * de um preco vindo de planilha estruturada, e a tela precisa mostrar isso
 * para quem vai validar.
 */
export async function extrair(email: EmailRecebido): Promise<Extracao> {
  const texto = `${email.assunto}\n${email.corpo}`;
  const baixo = texto.toLowerCase();
  const lacunas: string[] = [];

  const fornecedorEncontrado = await identificarFornecedor(email.remetente);
  const fornecedor: Campo<{ id: number; razao_social: string }> = fornecedorEncontrado
    ? {
      valor: fornecedorEncontrado,
      // FATO: veio do cadastro, casando o e-mail. Nao foi inferido do texto.
      natureza: 'FATO',
      fonte: `remetente ${email.remetente}`,
      confianca: 'ALTA',
    }
    : vazio('remetente nao casa com nenhum fornecedor cadastrado');

  if (!fornecedorEncontrado) {
    lacunas.push(`O remetente ${email.remetente} nao esta cadastrado como e-mail `
      + 'de nenhum fornecedor ativo. Sem isso a proposta nao pode ser vinculada.');
  }

  // Prazo de entrega
  const prazoBruto = buscar(baixo, [
    /prazo\s*(?:de\s*)?entrega[:\s]*(?:em\s*)?(\d{1,3})\s*dias?/,
    /entrega\s*(?:em|de)\s*(\d{1,3})\s*dias?/,
    /(\d{1,3})\s*dias?\s*(?:uteis\s*)?(?:para|de)\s*entrega/,
  ], 'corpo');

  const prazo: Campo<number> = prazoBruto
    ? {
      valor: Number(prazoBruto.valor),
      natureza: 'EXTRAIDO',
      fonte: 'corpo do e-mail',
      confianca: 'MEDIA',
      trecho: prazoBruto.trecho,
    }
    : vazio('prazo de entrega nao encontrado no texto');
  if (!prazoBruto) lacunas.push('Prazo de entrega nao localizado.');

  // Condicao de pagamento
  const pagamentoBruto = buscar(baixo, [
    /(?:condi[çc][aã]o|forma)\s*(?:de\s*)?pagamento[:\s]*([^\n.;]{3,60})/,
    /pagamento[:\s]*([^\n.;]{3,60})/,
    /(\d{1,3}(?:\s*\/\s*\d{1,3})+\s*dias?)/,
  ], 'corpo');

  const pagamento: Campo<string> = pagamentoBruto
    ? {
      valor: pagamentoBruto.valor.trim().slice(0, 60),
      natureza: 'EXTRAIDO',
      fonte: 'corpo do e-mail',
      confianca: 'MEDIA',
      trecho: pagamentoBruto.trecho,
    }
    : vazio('condicao de pagamento nao encontrada');
  if (!pagamentoBruto) lacunas.push('Condicao de pagamento nao localizada.');

  // Frete
  const freteBruto = buscar(baixo, [
    new RegExp(String.raw`frete[:\s]*(?:r\$\s*)?${NUMERO}`),
    new RegExp(String.raw`valor\s*do\s*frete[:\s]*(?:r\$\s*)?${NUMERO}`),
  ], 'corpo');

  let frete: Campo<number> = vazio('frete nao encontrado');
  if (freteBruto) {
    const n = norma.decimal(freteBruto.valor);
    if (n.ok && n.valor !== null && n.valor !== undefined) {
      frete = {
        valor: n.valor, natureza: 'EXTRAIDO', fonte: 'corpo do e-mail',
        confianca: 'MEDIA', trecho: freteBruto.trecho,
      };
    }
  } else if (/frete\s*(gr[áa]tis|inclu[íi]do|cif|por\s*nossa\s*conta)/.test(baixo)) {
    frete = {
      valor: 0, natureza: 'INFERIDO', fonte: 'corpo do e-mail',
      confianca: 'MEDIA', trecho: 'frete mencionado como incluso',
    };
  }

  // Validade da proposta
  const validadeBruto = buscar(texto, [
    /validade\s*(?:da\s*)?(?:proposta|cota[çc][aã]o)?[:\s]*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    /v[áa]lida?\s*at[ée]\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    /validade[:\s]*(\d{1,3})\s*dias?/i,
  ], 'corpo');

  let validade: Campo<string> = vazio('validade da proposta nao encontrada');
  if (validadeBruto) {
    if (/^\d{1,3}$/.test(validadeBruto.valor)) {
      const dias = Number(validadeBruto.valor);
      const d = new Date(Date.now() + dias * 86400000);
      validade = {
        valor: d.toISOString().slice(0, 10),
        natureza: 'INFERIDO',
        fonte: `corpo do e-mail (${dias} dias a partir de hoje)`,
        confianca: 'MEDIA',
        trecho: validadeBruto.trecho,
      };
    } else {
      const d = norma.data(validadeBruto.valor);
      if (d.ok && d.valor) {
        validade = {
          valor: d.valor, natureza: 'EXTRAIDO', fonte: 'corpo do e-mail',
          confianca: 'ALTA', trecho: validadeBruto.trecho,
        };
      }
    }
  }
  if (!validade.valor) {
    lacunas.push('Validade da proposta nao localizada: confirme com o fornecedor.');
  }

  const moedaDetectada = /us\$|d[óo]lar|usd/.test(baixo) ? 'USD'
    : /€|euro|eur\b/.test(baixo) ? 'EUR' : 'BRL';
  const moeda: Campo<string> = {
    valor: moedaDetectada,
    natureza: moedaDetectada === 'BRL' && !/r\$|real|brl/.test(baixo)
      ? 'INFERIDO' : 'EXTRAIDO',
    fonte: 'corpo do e-mail',
    confianca: moedaDetectada === 'BRL' && !/r\$|real|brl/.test(baixo)
      ? 'BAIXA' : 'ALTA',
  };
  if (moeda.confianca === 'BAIXA') {
    lacunas.push('Nenhuma moeda citada: assumido BRL por ser o padrao da empresa.');
  }

  const itens = await extrairItens(texto, email.anexos ?? []);
  if (!itens.length) {
    lacunas.push('Nenhum item com produto, quantidade e preco foi identificado. '
      + 'A proposta precisa ser lancada manualmente.');
  }

  // A confianca geral e do ELO MAIS FRACO. Uma proposta sem fornecedor
  // identificado ou sem item nao e "media" - e insuficiente para decidir.
  const confiancaGeral: Extracao['confianca_geral'] =
    !fornecedorEncontrado || itens.length === 0 ? 'INSUFICIENTE'
      : lacunas.length === 0 ? 'ALTA'
        : lacunas.length <= 2 ? 'MEDIA' : 'BAIXA';

  return {
    fornecedor,
    itens,
    prazo_entrega_dias: prazo,
    condicao_pagamento: pagamento,
    frete,
    validade_proposta: validade,
    moeda,
    lacunas,
    confianca_geral: confiancaGeral,
  };
}

/**
 * Itens: busca no texto e nos anexos com texto ja extraido.
 *
 * Um item so e aceito quando o CODIGO casa com produto cadastrado. Casar por
 * descricao parecida produziria proposta de preco no produto errado - e preco
 * errado no cadastro e um erro que se propaga para necessidade, cotacao e
 * pedido antes de alguem notar.
 */
async function extrairItens(
  texto: string, anexos: Anexo[],
): Promise<Extracao['itens']> {
  const itens: Extracao['itens'] = [];
  const fontes: Array<{ conteudo: string; fonte: string; estruturado: boolean }> = [
    { conteudo: texto, fonte: 'corpo do e-mail', estruturado: false },
    ...anexos.filter((a) => a.texto).map((a) => ({
      conteudo: a.texto!, fonte: `anexo ${a.nome}`,
      estruturado: /\.(xlsx|csv)$/i.test(a.nome),
    })),
  ];

  const vistos = new Set<string>();

  for (const { conteudo, fonte, estruturado } of fontes) {
    // Linha com codigo, quantidade e preco em qualquer ordem de separadores.
    const linhas = conteudo.split(/\r?\n/);
    for (const linha of linhas) {
      const numeros = linha.match(/-?[\d][\d.,]*/g) ?? [];
      if (numeros.length < 2) continue;

      const codigoMatch = /\b([A-Z0-9][A-Z0-9\-_.]{2,19})\b/.exec(linha.toUpperCase());
      if (!codigoMatch) continue;
      const codigo = codigoMatch[1]!;
      if (vistos.has(codigo)) continue;

      const { rows } = await query<{ id: string; codigo: string; descricao: string }>(
        'SELECT id, codigo, descricao FROM produtos WHERE codigo = $1 AND deleted_at IS NULL',
        [codigo]);
      if (!rows.length) continue;

      // O ultimo numero da linha costuma ser o preco; o penultimo, a quantidade.
      const valores = numeros
        .map((n) => norma.decimal(n))
        .filter((r) => r.ok && r.valor !== null)
        .map((r) => r.valor as number)
        .filter((n) => n > 0);

      if (valores.length < 2) continue;

      const preco = valores[valores.length - 1]!;
      const quantidade = valores[valores.length - 2]!;
      vistos.add(codigo);

      const confianca = estruturado ? 'ALTA' : 'MEDIA';
      itens.push({
        produto: {
          valor: {
            id: Number(rows[0]!.id), codigo: rows[0]!.codigo,
            descricao: rows[0]!.descricao,
          },
          natureza: 'FATO',
          fonte,
          confianca: 'ALTA',
        },
        quantidade: {
          valor: quantidade, natureza: 'EXTRAIDO', fonte, confianca,
          trecho: linha.trim().slice(0, 120),
        },
        preco: {
          valor: preco, natureza: 'EXTRAIDO', fonte, confianca,
          trecho: linha.trim().slice(0, 120),
        },
      });
    }
  }

  return itens;
}

// ---------------------------------------------------------------------------
// Validacao humana (secao 16)
// ---------------------------------------------------------------------------

/**
 * Abre a tarefa para alguem conferir a extracao.
 *
 * Este e o ponto onde a secao 16 e cumprida. NADA e gravado em cotacao, preco
 * ou pedido: cria-se uma tarefa com o que foi extraido e de onde veio, e o
 * comprador decide.
 */
export async function prepararValidacao(
  mensagemId: number, contexto: ContextoSessao,
): Promise<{
  mensagem_id: number; extracao: Extracao; tarefa_id: number | null;
  observacao: string;
}> {
  const { rows } = await query<{
    payload: Record<string, unknown>; correlation_id: string | null;
  }>('SELECT payload, correlation_id::text AS correlation_id FROM integracao_mensagens WHERE id = $1',
  [mensagemId]);

  if (!rows.length) throw naoEncontrado('Mensagem de e-mail');
  const p = rows[0]!.payload;

  const extracao = await extrair({
    remetente: String(p.remetente ?? ''),
    assunto: String(p.assunto ?? ''),
    corpo: String(p.corpo ?? ''),
    anexos: (p.anexos as Anexo[]) ?? [],
  });

  await query(
    'UPDATE integracao_mensagens SET normalizado = $2::jsonb WHERE id = $1',
    [mensagemId, JSON.stringify(extracao)]);

  const fornecedorNome = extracao.fornecedor.valor?.razao_social ?? 'remetente nao identificado';

  const tarefa = await tarefas.criar({
    tipo: 'COTACAO',
    titulo: `Conferir proposta recebida por e-mail de ${fornecedorNome}`,
    descricao: `${extracao.itens.length} item(ns) identificado(s). `
      + `Confianca da extracao: ${extracao.confianca_geral}.`
      + (extracao.lacunas.length ? ` Lacunas: ${extracao.lacunas.join(' ')}` : ''),
    acao_sugerida: 'Conferir os dados extraidos contra o e-mail original e, se '
      + 'estiverem corretos, registrar a proposta na cotacao',
    perfil_destino: 'COMPRADOR',
    prioridade: extracao.confianca_geral === 'ALTA' ? 'MEDIA' : 'ALTA',
    origem: 'integracao:email',
    entidade: 'integracao_mensagem',
    entidade_id: mensagemId,
    link: `/integracoes/email?mensagem=${mensagemId}`,
    correlation_id: rows[0]!.correlation_id,
    chave: `email-validacao:${mensagemId}`,
    sla: 'COTACAO',
  }, contexto);

  return {
    mensagem_id: mensagemId,
    extracao,
    tarefa_id: tarefa.id || null,
    observacao: 'Os dados foram EXTRAIDOS e estao aguardando conferencia. '
      + 'Nenhuma proposta, preco ou pedido foi criado ou alterado (secao 16).',
  };
}

// ---------------------------------------------------------------------------
// Cotacao por e-mail (secao 18)
// ---------------------------------------------------------------------------

/**
 * Prepara a solicitacao de cotacao - sem enviar.
 *
 * A secao 18 termina com "nao enviar automaticamente sem respeitar permissoes
 * e configuracoes". Como nao ha provedor de e-mail configurado, o metodo monta
 * a mensagem e devolve para revisao. Quando houver provedor, o envio entra aqui
 * e continua exigindo a permissao.
 */
export async function prepararSolicitacao(
  cotacaoId: number, fornecedorIds: number[],
): Promise<{
  cotacao: string;
  mensagens: Array<{
    fornecedor_id: number; fornecedor: string; email: string | null;
    assunto: string; corpo: string; enviavel: boolean; impedimento?: string;
  }>;
  observacao: string;
}> {
  const { rows: cotacao } = await query<{
    id: string; numero: string; data_limite: string | null;
  }>('SELECT id, numero, data_limite::text FROM cotacoes WHERE id = $1', [cotacaoId]);
  if (!cotacao.length) throw naoEncontrado('Cotacao');

  const { rows: itens } = await query<{ codigo: string; descricao: string; quantidade: string }>(`
    SELECT p.codigo, p.descricao, ci.quantidade_solicitada::text AS quantidade
      FROM cotacao_itens ci JOIN produtos p ON p.id = ci.produto_id
     WHERE ci.cotacao_id = $1 ORDER BY p.descricao`, [cotacaoId]);

  if (!itens.length) throw regraNegocio('A cotacao nao tem itens');

  const { rows: fornecedores } = await query<{
    id: string; razao_social: string; email: string | null;
  }>(`SELECT id, razao_social, email FROM fornecedores
       WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [fornecedorIds]);

  const listaItens = itens
    .map((i) => `  - ${i.codigo} | ${i.descricao} | ${Number(i.quantidade)}`)
    .join('\n');

  const prazo = cotacao[0]!.data_limite
    ? `\nPrazo para resposta: ${cotacao[0]!.data_limite}.` : '';

  const mensagens = fornecedores.map((f) => ({
    fornecedor_id: Number(f.id),
    fornecedor: f.razao_social,
    email: f.email,
    assunto: `Solicitacao de cotacao ${cotacao[0]!.numero}`,
    corpo: `Prezados,\n\nSolicitamos cotacao para os itens abaixo.\n\n`
      + `${listaItens}\n${prazo}\n\n`
      + 'Favor informar: preco unitario, prazo de entrega, condicao de pagamento, '
      + 'frete e validade da proposta.\n\nAtenciosamente,',
    enviavel: Boolean(f.email),
    ...(f.email ? {} : {
      impedimento: 'Fornecedor sem e-mail cadastrado',
    }),
  }));

  return {
    cotacao: cotacao[0]!.numero,
    mensagens,
    observacao: 'As mensagens foram PREPARADAS e nao enviadas: nao ha provedor de '
      + 'e-mail configurado nesta fase. Copie o texto ou configure a integracao '
      + 'EMAIL_COMPRAS para enviar daqui.',
  };
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export async function listar(filtro: {
  classificacao?: string; limite?: number; pagina?: number;
}) {
  const limite = Math.min(Math.max(filtro.limite ?? 50, 1), 200);
  const pagina = Math.max(filtro.pagina ?? 1, 1);
  const valores: unknown[] = [];
  let cond = "m.entidade = 'email'";

  if (filtro.classificacao) {
    valores.push(filtro.classificacao);
    cond += ` AND m.payload ->> 'classificacao' = $${valores.length}`;
  }
  valores.push(limite, (pagina - 1) * limite);

  const { rows } = await query(`
    SELECT m.id, m.payload ->> 'remetente' AS remetente,
           m.payload ->> 'assunto' AS assunto,
           m.payload ->> 'classificacao' AS classificacao,
           m.payload ->> 'recebido_em' AS recebido_em,
           jsonb_array_length(coalesce(m.payload -> 'anexos', '[]'::jsonb)) AS anexos,
           m.status::text AS status, m.created_at,
           f.razao_social AS fornecedor,
           (m.normalizado -> 'confianca_geral') #>> '{}' AS confianca,
           count(*) OVER () AS total
      FROM integracao_mensagens m
      LEFT JOIN fornecedores f
             ON f.id = (m.payload ->> 'fornecedor_id')::bigint
     WHERE ${cond}
     ORDER BY m.created_at DESC
     LIMIT $${valores.length - 1} OFFSET $${valores.length}`, valores);

  return {
    total: rows.length ? Number((rows[0] as { total: string }).total) : 0,
    pagina,
    limite,
    emails: rows.map((r) => {
      const { total: _t, ...e } = r as Record<string, unknown>;
      return { ...e, anexos: Number((e as { anexos: string }).anexos) };
    }),
  };
}
