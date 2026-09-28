/**
 * Pergunte aos Dados (secoes 22, 24 e 25).
 *
 * A pergunta em portugues escolhe UMA consulta do catalogo e preenche os
 * parametros dela. O texto do usuario nunca vira SQL - ele vira uma escolha e
 * um conjunto de valores que trafegam como $1, $2.
 *
 * Isso tambem responde a "protecao contra prompt injection" da secao 39 de um
 * jeito que filtro de texto nao alcanca: nao existe prompt a injetar. A frase
 * mais hostil possivel, no pior caso, seleciona a consulta errada do catalogo e
 * devolve uma lista de produtos.
 *
 * Quando nenhuma intencao alcanca a pontuacao minima, a resposta e "nao
 * entendi" com sugestoes - e nao um palpite. Devolver a lista errada com ar de
 * certeza e pior do que admitir que nao entendeu.
 */
import { comTransacao, type ContextoSessao } from '../../config/database.js';
import { query } from '../../config/database.js';
import { CONSULTAS, CONSULTAS_POR_CODIGO, type Consulta } from './consultas.js';
import { executar, validar } from './sql-guard.js';
import { fato, type Evidencia } from './evidencias.js';
import { negar, podeVer, type ConfigIA, type SessaoIA } from './contexto.js';

/** Minusculas, sem acento, sem pontuacao: a forma em que tudo e comparado. */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MESES_EM_DIAS: Record<string, number> = {
  hoje: 1, ontem: 2, semana: 7, quinzena: 15, mes: 30, bimestre: 60,
  trimestre: 90, semestre: 180, ano: 365,
};

export interface Intencao {
  codigo: string;
  titulo: string;
  pontos: number;
  termos_reconhecidos: string[];
}

/**
 * Classifica a pergunta contra o catalogo.
 *
 * Pontuacao: cada termo da consulta encontrado na pergunta vale pelo proprio
 * tamanho em palavras. "fornecedor unico" (2 palavras) pesa mais que "unico"
 * (1) - expressoes mais especificas devem ganhar de palavras soltas, senao
 * "quais produtos tem fornecedor unico" cairia em qualquer consulta que
 * mencione "produtos".
 *
 * `excluir` zera a candidata: e como se desempata "pedidos atrasados" de
 * "qual fornecedor mais atrasou", que compartilham a palavra "atras".
 */
export function classificar(pergunta: string): Intencao[] {
  const texto = ` ${normalizar(pergunta)} `;

  return CONSULTAS
    .map((c): Intencao => {
      if (c.excluir?.some((e) => texto.includes(` ${normalizar(e)} `)
        || texto.includes(`${normalizar(e)} `))) {
        return { codigo: c.codigo, titulo: c.titulo, pontos: 0, termos_reconhecidos: [] };
      }

      const reconhecidos: string[] = [];
      let pontos = 0;
      for (const termo of c.termos) {
        const t = normalizar(termo);
        if (texto.includes(` ${t} `) || texto.includes(` ${t}`) || texto.includes(`${t} `)) {
          reconhecidos.push(termo);
          pontos += t.split(' ').length * 10;
        }
      }
      return { codigo: c.codigo, titulo: c.titulo, pontos, termos_reconhecidos: reconhecidos };
    })
    .filter((i) => i.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos);
}

export interface Entidades {
  dias?: number;
  meses?: number;
  termo?: string;
  produto_id?: number;
  fornecedor_id?: number;
}

/**
 * Extrai periodo, produto e fornecedor da pergunta.
 *
 * Periodo aceita "ultimos 90 dias", "90 dias", "3 meses" e os atalhos
 * ("semana", "trimestre"). O numero explicito ganha do atalho: quem escreveu
 * "ultimos 45 dias" quer 45, nao o mes arredondado.
 */
export async function extrairEntidades(
  pergunta: string, consulta: Consulta,
): Promise<Entidades> {
  const texto = normalizar(pergunta);
  const e: Entidades = {};

  const emDias = texto.match(/(\d{1,4})\s*dias?/);
  const emMeses = texto.match(/(\d{1,2})\s*(?:mes|meses)/);
  const emAnos = texto.match(/(\d{1,2})\s*anos?/);

  if (emDias) e.dias = Number(emDias[1]);
  else if (emMeses) { e.meses = Number(emMeses[1]); e.dias = Number(emMeses[1]) * 30; }
  else if (emAnos) { e.meses = Number(emAnos[1]) * 12; e.dias = Number(emAnos[1]) * 365; }
  else {
    for (const [palavra, dias] of Object.entries(MESES_EM_DIAS)) {
      if (texto.includes(palavra)) { e.dias = dias; break; }
    }
  }

  // Produto: a consulta de situacao precisa do termo de busca.
  if (consulta.parametros.some((p) => p.nome === 'termo')) {
    const limpo = texto
      .replace(/\b(como|esta|estao|situacao|do|da|de|o|a|os|as|me|fala|sobre|qual|e|produto|status)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (limpo.length >= 3) e.termo = limpo;
  }

  // Fornecedor citado pelo nome: so busca quando a consulta aceita o parametro.
  if (consulta.parametros.some((p) => p.nome === 'fornecedor_id')) {
    const apos = texto.match(/fornecedor\s+([a-z0-9][a-z0-9\s]{2,40})/);
    const alvo = apos?.[1]?.trim();
    if (alvo) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM fornecedores
          WHERE deleted_at IS NULL
            AND (razao_social ILIKE '%' || $1 || '%' OR nome_fantasia ILIKE '%' || $1 || '%')
          ORDER BY length(razao_social) LIMIT 1`, [alvo]);
      if (rows.length) e.fornecedor_id = Number(rows[0]!.id);
    }
  }

  return e;
}

// ---------------------------------------------------------------------------
// Resposta
// ---------------------------------------------------------------------------

export interface Resposta {
  entendida: boolean;
  intencao: string | null;
  titulo: string | null;
  confianca_intencao: 'ALTA' | 'MEDIA' | 'BAIXA' | null;
  resposta: string;
  colunas: Array<{ campo: string; titulo: string; tipo: string }>;
  linhas: Array<Record<string, unknown>>;
  total: number;
  truncado: boolean;
  parametros: Record<string, unknown>;
  fonte: string | null;
  evidencias: Evidencia[];
  alternativas: Array<{ codigo: string; titulo: string; exemplo: string }>;
  tempo_ms: number;
  camadas_seguranca: string[];
}

const PONTUACAO_MINIMA = 10;

/**
 * Responde a pergunta: classifica, checa permissao, executa e registra.
 *
 * A checagem de permissao acontece DEPOIS de classificar e ANTES de executar.
 * A ordem importa: so depois de saber qual consulta responderia e que da para
 * dizer se o perfil pode ve-la, e nada e lido antes dessa decisao.
 */
export async function responder(
  pergunta: string,
  cfg: ConfigIA,
  sessao: SessaoIA,
  contexto: ContextoSessao,
  intencaoForcada?: string,
): Promise<Resposta> {
  const inicio = Date.now();
  const candidatas = classificar(pergunta);
  const escolhida = intencaoForcada
    ? CONSULTAS_POR_CODIGO.get(intencaoForcada.toUpperCase())
    : (candidatas[0] && candidatas[0].pontos >= PONTUACAO_MINIMA
      ? CONSULTAS_POR_CODIGO.get(candidatas[0].codigo)
      : undefined);

  const alternativas = candidatas.slice(0, 4).map((c) => {
    const cons = CONSULTAS_POR_CODIGO.get(c.codigo)!;
    return { codigo: c.codigo, titulo: cons.titulo, exemplo: cons.exemplos[0]! };
  });

  // --- Nao entendi
  if (!escolhida) {
    await registrarExecucao(contexto, sessao, {
      tipo: 'PERGUNTA', entrada: pergunta, status: 'VAZIA',
      motivo: 'Nenhuma intencao reconhecida',
    });
    return {
      entendida: false,
      intencao: null,
      titulo: null,
      confianca_intencao: null,
      resposta: 'Nao consegui identificar o que voce quer saber. '
        + 'Reformule a pergunta ou escolha um dos exemplos abaixo.',
      colunas: [],
      linhas: [],
      total: 0,
      truncado: false,
      parametros: {},
      fonte: null,
      evidencias: [],
      alternativas: alternativas.length ? alternativas : CONSULTAS.slice(0, 6).map((c) => ({
        codigo: c.codigo, titulo: c.titulo, exemplo: c.exemplos[0]!,
      })),
      tempo_ms: Date.now() - inicio,
      camadas_seguranca: [],
    };
  }

  // --- Permissao (secao 38)
  if (!podeVer(sessao, escolhida.dominio)) {
    await registrarExecucao(contexto, sessao, {
      tipo: 'PERGUNTA', entrada: pergunta, intencao: escolhida.codigo,
      status: 'BLOQUEADA', motivo: `Perfil sem acesso ao dominio ${escolhida.dominio}`,
    });
    return {
      entendida: true,
      intencao: escolhida.codigo,
      titulo: escolhida.titulo,
      confianca_intencao: null,
      resposta: negar(escolhida.dominio),
      colunas: [],
      linhas: [],
      total: 0,
      truncado: false,
      parametros: {},
      fonte: null,
      evidencias: [],
      alternativas: [],
      tempo_ms: Date.now() - inicio,
      camadas_seguranca: [],
    };
  }

  // --- Parametros
  const entidades = await extrairEntidades(pergunta, escolhida);
  const parametros: Record<string, unknown> = {};
  const valores: unknown[] = [];

  for (const p of escolhida.parametros) {
    let valor: unknown = (entidades as Record<string, unknown>)[p.nome] ?? p.padrao ?? null;
    if (p.nome === 'meses' && entidades.meses) valor = entidades.meses;
    if (p.tipo === 'inteiro' && valor !== null) {
      valor = Math.max(1, Math.min(3650, Number(valor)));
    }
    parametros[p.nome] = valor;
    valores.push(valor);
  }

  // --- Guarda de SQL: o catalogo tambem passa por ela.
  //
  // Nao e desconfianca do catalogo: e a garantia de que existe UM caminho ate o
  // banco, e ele e vigiado. Um SQL novo adicionado ao catalogo com um erro
  // passa pela mesma porta que qualquer outro.
  const veredito = validar(escolhida.sql);
  if (!veredito.permitida) {
    await registrarExecucao(contexto, sessao, {
      tipo: 'CONSULTA_SQL', entrada: pergunta, intencao: escolhida.codigo,
      consulta: escolhida.sql, status: 'BLOQUEADA',
      motivo: `${veredito.regra}: ${veredito.motivo}`,
    });
    throw new Error(`Consulta do catalogo rejeitada pela guarda: ${veredito.motivo}`);
  }

  // --- Execucao
  try {
    const resultado = await executar(
      escolhida.sql, valores, cfg.limiteLinhas, cfg.timeoutMs);

    await registrarExecucao(contexto, sessao, {
      tipo: 'PERGUNTA', entrada: pergunta, intencao: escolhida.codigo,
      consulta: escolhida.sql, parametros, status: 'OK',
      linhas: resultado.linhas.length, tempo: resultado.tempo_ms,
    });

    const pontos = candidatas[0]?.pontos ?? 0;

    return {
      entendida: true,
      intencao: escolhida.codigo,
      titulo: escolhida.titulo,
      confianca_intencao: intencaoForcada ? 'ALTA'
        : pontos >= 40 ? 'ALTA' : pontos >= 20 ? 'MEDIA' : 'BAIXA',
      /*
       * Quando a lista estoura o limite, a frase DIZ isso.
       *
       * Sem o aviso, "200 produtos podem romper" seria o tamanho do limite
       * apresentado como se fosse a resposta - e o numero ficaria colado no
       * teto para sempre, dando a impressao de um problema estavel.
       */
      resposta: escolhida.resumo(resultado.linhas, parametros)
        + (resultado.truncado
          ? ` A lista foi limitada a ${cfg.limiteLinhas} registro(s); ha mais alem disso.`
          : ''),
      colunas: escolhida.colunas,
      linhas: resultado.linhas,
      total: resultado.total,
      truncado: resultado.truncado,
      parametros,
      fonte: escolhida.fonte,
      evidencias: [
        fato(`${resultado.linhas.length} registro(s) lidos`, escolhida.fonte,
          { valor: resultado.linhas.length }),
      ],
      alternativas: alternativas.filter((a) => a.codigo !== escolhida.codigo).slice(0, 3),
      tempo_ms: Date.now() - inicio,
      camadas_seguranca: resultado.camadas,
    };
  } catch (erro) {
    const e = erro as { message?: string };
    await registrarExecucao(contexto, sessao, {
      tipo: 'PERGUNTA', entrada: pergunta, intencao: escolhida.codigo,
      consulta: escolhida.sql, parametros, status: 'ERRO', erro: e.message,
    });
    throw erro;
  }
}

/**
 * Executa SQL proprio do usuario, sob a guarda (secao 23).
 *
 * Exige a permissao `ia.sql`, que so ADMIN e GESTOR_COMPRAS tem. E o unico
 * ponto do sistema que aceita SQL digitado - e por isso o que mais registra:
 * a tentativa bloqueada fica gravada com a regra que a barrou.
 */
export async function consultaPropria(
  sql: string,
  cfg: ConfigIA,
  sessao: SessaoIA,
  contexto: ContextoSessao,
) {
  const veredito = validar(sql);

  if (!veredito.permitida) {
    await registrarExecucao(contexto, sessao, {
      tipo: 'CONSULTA_SQL', entrada: sql, consulta: sql, status: 'BLOQUEADA',
      motivo: `${veredito.regra}: ${veredito.motivo}`,
    });
    return {
      permitida: false,
      regra: veredito.regra,
      motivo: veredito.motivo,
      registrada: true,
      observacao: 'A tentativa foi registrada em ia_execucoes.',
    };
  }

  try {
    const resultado = await executar(veredito.sql!, [], cfg.limiteLinhas, cfg.timeoutMs);
    await registrarExecucao(contexto, sessao, {
      tipo: 'CONSULTA_SQL', entrada: sql, consulta: veredito.sql, status: 'OK',
      linhas: resultado.linhas.length, tempo: resultado.tempo_ms,
    });
    return {
      permitida: true,
      linhas: resultado.linhas,
      total: resultado.total,
      truncado: resultado.truncado,
      tempo_ms: resultado.tempo_ms,
      camadas_seguranca: resultado.camadas,
      observacao: 'Consulta executada em transacao somente leitura.',
    };
  } catch (erro) {
    const e = erro as { message?: string };
    await registrarExecucao(contexto, sessao, {
      tipo: 'CONSULTA_SQL', entrada: sql, consulta: veredito.sql, status: 'ERRO',
      erro: e.message,
    });
    return {
      permitida: true,
      erro: e.message ?? 'Erro ao executar a consulta',
      registrada: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Registro (secoes 23, 35 e 39)
// ---------------------------------------------------------------------------

interface DadosExecucao {
  tipo: string;
  entrada: string;
  intencao?: string;
  consulta?: string;
  parametros?: Record<string, unknown>;
  status: string;
  motivo?: string;
  linhas?: number;
  tempo?: number;
  erro?: string;
}

/**
 * Grava a execucao. Nunca deixa o registro derrubar a resposta.
 *
 * Um log que quebra a funcionalidade vira o primeiro candidato a ser desligado,
 * e ai nao ha mais log. A falha de gravacao vai para o console e a resposta
 * segue.
 */
async function registrarExecucao(
  contexto: ContextoSessao, sessao: SessaoIA, d: DadosExecucao,
): Promise<void> {
  try {
    await comTransacao(contexto, async (cliente) => {
      await cliente.query(`
        INSERT INTO ia_execucoes
          (usuario_id, tipo, entrada, intencao, consulta, parametros, status,
           motivo_bloqueio, linhas, tempo_ms, erro, ip)
        VALUES ($1, $2::tipo_execucao_ia_enum, $3, $4, $5, $6::jsonb,
                $7::status_execucao_ia_enum, $8, $9, $10, $11, $12)`,
      [sessao.usuarioId, d.tipo, d.entrada.slice(0, 4000), d.intencao ?? null,
        d.consulta?.slice(0, 4000) ?? null,
        d.parametros ? JSON.stringify(d.parametros) : null,
        d.status, d.motivo ?? null, d.linhas ?? null, d.tempo ?? null,
        d.erro?.slice(0, 2000) ?? null, sessao.ip]);
    });
  } catch (erro) {
    console.error('[ia] falha ao registrar execucao', erro);
  }
}

/** Historico de execucoes (secoes 35 e 39). */
export async function historicoExecucoes(filtro: {
  status?: string; tipo?: string; usuario_id?: number; limite?: number; pagina?: number;
}) {
  const valores: unknown[] = [];
  const cond: string[] = [];
  const add = (sql: string, valor: unknown) => {
    if (valor === undefined || valor === null || valor === '') return;
    valores.push(valor);
    cond.push(sql.replace('$?', `$${valores.length}`));
  };

  add('e.status = $?::status_execucao_ia_enum', filtro.status);
  add('e.tipo = $?::tipo_execucao_ia_enum', filtro.tipo);
  add('e.usuario_id = $?', filtro.usuario_id);

  const limite = Math.min(Math.max(filtro.limite ?? 50, 1), 200);
  const pagina = Math.max(filtro.pagina ?? 1, 1);
  valores.push(limite, (pagina - 1) * limite);

  const { rows } = await query(`
    SELECT e.id, e.tipo::text AS tipo, e.entrada, e.intencao, e.status::text AS status,
           e.motivo_bloqueio, e.linhas, e.tempo_ms, e.erro, e.created_at,
           u.nome AS usuario, count(*) OVER () AS total
      FROM ia_execucoes e
      LEFT JOIN usuarios u ON u.id = e.usuario_id
     ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
     ORDER BY e.created_at DESC
     LIMIT $${valores.length - 1} OFFSET $${valores.length}`, valores);

  return {
    total: rows.length ? Number((rows[0] as { total: string }).total) : 0,
    pagina,
    limite,
    execucoes: rows.map((r) => {
      const { total: _t, ...e } = r as Record<string, unknown>;
      return e;
    }),
  };
}

/** Exemplos de pergunta, para a tela (secao 22). */
export function exemplos() {
  return CONSULTAS.map((c) => ({
    codigo: c.codigo,
    titulo: c.titulo,
    dominio: c.dominio,
    perguntas: c.exemplos,
  }));
}
