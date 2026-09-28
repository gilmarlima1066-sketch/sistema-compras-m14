/**
 * Guarda de SQL das consultas analiticas (secoes 23 e 39).
 *
 * TRES CAMADAS INDEPENDENTES, e a ordem importa menos que o fato de serem
 * independentes: cada uma sozinha ja barraria a escrita, e nenhuma confia na
 * anterior.
 *
 *   1. VALIDACAO (aqui). Aceita apenas SELECT/WITH, uma instrucao so, sem
 *      comentarios, sem comandos de escrita ou administrativos, sem tabelas
 *      fora da lista permitida, com LIMIT obrigatorio.
 *
 *   2. TRANSACAO READ ONLY (PostgreSQL). Mesmo que a camada 1 fosse burlada,
 *      `BEGIN TRANSACTION READ ONLY` faz o servidor recusar qualquer INSERT,
 *      UPDATE, DELETE ou DDL. Nao e filtro de texto: e o motor recusando.
 *
 *   3. PAPEL SOMENTE LEITURA (opcional, db/roles/001_papel_leitura_ia.sql).
 *      Conexao com privilegio de SELECT apenas, sem acesso a `usuarios` nem ao
 *      proprio log de execucoes.
 *
 * Por que validar por texto se o banco ja recusa escrita? Porque a camada 2
 * protege o DADO e a camada 1 protege o USUARIO: bloquear `pg_read_file`,
 * `pg_sleep` e tabela fora do escopo evita leitura indevida e consumo de
 * recurso, que uma transacao read-only permitiria alegremente.
 *
 * O que esta guarda NAO promete: ela nao torna seguro executar SQL escrito por
 * terceiro nao confiavel. Ela reduz a superficie do que a propria aplicacao
 * executa. O caminho normal do "Pergunte aos Dados" nao passa por aqui com
 * texto livre - passa por um catalogo de consultas parametrizadas.
 */
import { pool, poolLeitura } from '../../config/database.js';
import { env } from '../../config/env.js';

export interface ResultadoGuarda {
  permitida: boolean;
  motivo?: string;
  regra?: string;
  sql?: string;
}

/**
 * Comandos que nao podem aparecer, em nenhuma posicao.
 *
 * A lista cobre escrita, DDL, controle de transacao, administracao e as
 * funcoes do PostgreSQL que leem arquivo, abrem conexao ou gastam tempo.
 * `\b` nas bordas evita barrar `atualizado_em` por conter "atualiza".
 */
const PROIBIDOS = [
  // Escrita
  'insert', 'update', 'delete', 'merge', 'upsert', 'truncate',
  // DDL
  'create', 'alter', 'drop', 'rename', 'comment',
  // Permissao
  'grant', 'revoke', 'reassign',
  /*
   * Transacao e sessao.
   *
   * `END` NAO entra nesta lista, embora encerre transacao: em SQL analitico ele
   * e muito mais comum fechando um `CASE`, e bloquea-lo derruba consultas
   * legitimas - derrubou as do proprio catalogo no primeiro teste. A ausencia e
   * segura porque tres outras regras ja impedem controle de transacao: a
   * consulta precisa COMECAR com SELECT ou WITH, so pode ter UMA instrucao, e
   * ela roda dentro de uma transacao READ ONLY aberta por esta guarda.
   *
   * `OWN` tambem saiu: `REASSIGN OWNED` ja e barrado por `reassign`, e `own`
   * isolado so criaria falso positivo em nome de coluna.
   */
  'commit', 'rollback', 'savepoint', 'begin', 'start',
  'set', 'reset', 'discard', 'listen', 'notify', 'unlisten',
  // Administracao
  'vacuum', 'analyze', 'cluster', 'reindex', 'checkpoint', 'lock',
  'copy', 'execute', 'prepare', 'deallocate', 'declare', 'fetch', 'move',
  'do', 'call', 'refresh', 'import', 'security',
  // Funcoes perigosas
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
  'pg_sleep', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf',
  'lo_import', 'lo_export', 'dblink', 'postgres_fdw', 'pg_logical',
  'current_setting', 'set_config', 'pg_read_server_files',
] as const;

/** Objetos do sistema que nao interessam a uma pergunta de compras. */
const ESQUEMAS_BLOQUEADOS = ['pg_catalog', 'information_schema', 'pg_toast', 'pg_temp'];

/**
 * Tabelas que a consulta analitica pode ler.
 *
 * Lista de permissao, nao de bloqueio: o que nao esta aqui nao e legivel. A
 * diferenca e que uma tabela nova nasce inacessivel ate alguem decidir
 * inclui-la, em vez de nascer exposta ate alguem lembrar de bloquea-la.
 *
 * Fora da lista, de proposito: `usuarios` (guarda hash de senha),
 * `auditoria`, `ia_execucoes` (o proprio log de seguranca), `perfis` e
 * `permissoes`.
 */
const TABELAS_PERMITIDAS = new Set([
  'produtos', 'categorias', 'subcategorias', 'marcas', 'unidades',
  'fornecedores', 'produto_fornecedor', 'contatos_fornecedor_pedido',
  'estoques', 'lotes', 'movimentacoes_estoque', 'locais', 'parametros_estoque',
  'inventarios', 'inventario_itens',
  'vendas', 'itens_venda', 'clientes', 'previsoes_demanda', 'indices_sazonais',
  'vendas_outliers', 'demanda_reprimida',
  'necessidades_compra', 'planejamentos_compra', 'requisicoes_compra',
  'requisicao_compra_itens', 'simulacoes_compra', 'simulacao_compra_itens',
  'cotacoes', 'cotacao_itens', 'cotacao_fornecedores', 'cotacao_produtos',
  'cotacao_pontuacoes', 'cotacao_faixas_preco', 'cotacao_cenarios',
  'negociacoes', 'negociacao_rodadas', 'negociacao_itens', 'negociacoes_compra',
  'ordens_compra', 'ordem_compra_itens', 'pedido_aprovacoes', 'pedido_historico',
  'pedido_confirmacoes', 'pedido_alteracoes', 'compromissos_compra',
  'condicoes_pagamento', 'alcadas_aprovacao',
  'entregas', 'entrega_itens', 'entrega_programacoes', 'ocorrencias_entrega',
  'previsoes_entrega', 'transportes_pedido', 'motivos_atraso', 'acoes_atraso',
  'status_logistico_historico', 'alteracoes_prazo',
  'recebimentos', 'recebimento_itens', 'recebimento_divergencias',
  'inspecoes_qualidade', 'inspecao_itens', 'nao_conformidades',
  'nao_conformidade_acoes', 'devolucoes', 'devolucao_itens', 'quarentenas',
  'checklists_qualidade', 'checklist_qualidade_itens',
  'avaliacoes_fornecedores', 'avaliacao_criterios', 'avaliacao_indicadores',
  'metodologias_avaliacao', 'metodologia_criterios', 'metodologia_indicadores',
  'planos_acao_fornecedor', 'plano_acao_itens', 'situacoes_fornecedor',
  'historico_precos', 'historico_score_fornecedor',
  'kpi_definicoes', 'kpi_metas', 'kpi_resultados', 'dashboards',
  'alertas', 'alertas_regras', 'alertas_tipos', 'notificacoes',
  'ia_recomendacoes', 'ia_feedback',
  'configuracoes', 'calendario_eventos', 'parametros_tolerancia',
  // Views
  'vw_estoque_atual', 'vw_historico_precos', 'mv_demanda_diaria',
]);

const LIMITE_TAMANHO = 4000;

/**
 * Remove literais e identificadores citados antes da analise.
 *
 * Sem isso, uma consulta legitima que filtrasse `descricao ILIKE '%update%'`
 * seria barrada por conter a palavra "update" - e, pior, um atacante poderia
 * esconder comando dentro de string. A analise roda sobre o esqueleto da
 * consulta, nao sobre o texto que o usuario digitou dentro das aspas.
 */
function esqueleto(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, " '' ")      // literais
    .replace(/"(?:[^"]|"")*"/g, ' "" ')      // identificadores citados
    .replace(/\$\d+/g, ' $ ')                // parametros
    .toLowerCase();
}

/**
 * Valida a consulta antes de executar (secao 23).
 *
 * Devolve o motivo e a REGRA que barrou - quem recebeu a negativa precisa
 * saber o que corrigir, e quem audita precisa saber qual regra atuou.
 */
export function validar(sqlBruto: string): ResultadoGuarda {
  const sql = sqlBruto.trim();

  if (!sql) {
    return { permitida: false, motivo: 'Consulta vazia', regra: 'VAZIA' };
  }
  if (sql.length > LIMITE_TAMANHO) {
    return {
      permitida: false,
      motivo: `Consulta com ${sql.length} caracteres; o limite e ${LIMITE_TAMANHO}`,
      regra: 'TAMANHO',
    };
  }

  const corpo = esqueleto(sql);

  // Comentario pode esconder o resto da instrucao de quem le, inclusive desta
  // guarda. Nao ha motivo legitimo para comentario numa consulta gerada.
  if (corpo.includes('--') || corpo.includes('/*') || corpo.includes('*/')) {
    return {
      permitida: false,
      motivo: 'Comentarios nao sao permitidos na consulta',
      regra: 'COMENTARIO',
    };
  }

  // Uma instrucao so. Ponto e virgula final e tolerado; no meio, nao.
  const semFinal = corpo.replace(/;\s*$/, '');
  if (semFinal.includes(';')) {
    return {
      permitida: false,
      motivo: 'Apenas uma instrucao por consulta',
      regra: 'MULTIPLAS_INSTRUCOES',
    };
  }

  if (!/^\s*(select|with)\b/.test(semFinal)) {
    return {
      permitida: false,
      motivo: 'Apenas SELECT e WITH sao permitidos',
      regra: 'COMANDO_NAO_PERMITIDO',
    };
  }

  for (const termo of PROIBIDOS) {
    const padrao = termo.includes('_')
      ? new RegExp(`\\b${termo}\\b`)
      : new RegExp(`\\b${termo}\\b`);
    if (padrao.test(semFinal)) {
      return {
        permitida: false,
        motivo: `Comando ou funcao nao permitida: ${termo.toUpperCase()}`,
        regra: 'COMANDO_BLOQUEADO',
      };
    }
  }

  for (const esquema of ESQUEMAS_BLOQUEADOS) {
    if (semFinal.includes(esquema)) {
      return {
        permitida: false,
        motivo: `Acesso a ${esquema} nao e permitido`,
        regra: 'ESQUEMA_BLOQUEADO',
      };
    }
  }

  // Tabelas referenciadas: tudo que vem depois de FROM ou JOIN.
  const referencias = [...semFinal.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/g)]
    .map((m) => m[1]!)
    .filter((t) => t !== 'select'); // subconsulta: "from (select ..."

  // CTEs declarados no proprio WITH sao referencias validas.
  const ctes = new Set([...semFinal.matchAll(/\b([a-z_][a-z0-9_]*)\s+as\s*\(/g)]
    .map((m) => m[1]!));

  for (const tabela of referencias) {
    if (ctes.has(tabela)) continue;
    if (!TABELAS_PERMITIDAS.has(tabela)) {
      return {
        permitida: false,
        motivo: `Tabela nao permitida para consulta analitica: ${tabela}`,
        regra: 'TABELA_BLOQUEADA',
      };
    }
  }

  if (!/\blimit\b/.test(semFinal)) {
    return {
      permitida: false,
      motivo: 'A consulta precisa de LIMIT',
      regra: 'SEM_LIMITE',
    };
  }

  return { permitida: true, sql: semFinal === corpo ? sql : sql.replace(/;\s*$/, '') };
}

// ---------------------------------------------------------------------------
// Execucao
// ---------------------------------------------------------------------------

export interface ExecucaoSql {
  linhas: Array<Record<string, unknown>>;
  total: number;
  truncado: boolean;
  tempo_ms: number;
  camadas: string[];
}

/**
 * Executa a consulta ja validada, sob transacao READ ONLY e timeout.
 *
 * A transacao e sempre revertida com ROLLBACK, mesmo tendo dado certo: nao ha
 * nada a confirmar numa leitura, e encerrar por ROLLBACK garante que nada
 * escapou dela.
 */
export async function executar(
  sql: string,
  parametros: unknown[],
  limiteLinhas: number,
  timeoutMs: number,
): Promise<ExecucaoSql> {
  const inicio = Date.now();
  const usandoLeitura = poolLeitura !== null;
  const cliente = await (poolLeitura ?? pool).connect();

  const camadas = [
    'validacao da aplicacao',
    'transacao READ ONLY do PostgreSQL',
    usandoLeitura ? 'papel de banco somente leitura' : 'papel de banco: nao configurado',
  ];

  try {
    await cliente.query('BEGIN TRANSACTION READ ONLY');
    // SET LOCAL vale ate o fim da transacao e nao vaza para a proxima conexao
    // do pool. O timeout e aplicado pelo servidor, nao pelo cliente.
    await cliente.query(`SET LOCAL statement_timeout = ${Math.max(100, timeoutMs)}`);

    /*
     * O envelope `SELECT * FROM (...)` e, na pratica, uma quarta barreira:
     * qualquer instrucao que nao produza linhas vira erro de sintaxe antes de
     * chegar ao executor. Nao foi projetado para isso - existe para aplicar o
     * limite - mas o efeito conta.
     *
     * Uma linha a mais do que o limite revela o truncamento sem contar tudo.
     */
    const { rows } = await cliente.query(
      `SELECT * FROM (${sql}) AS _consulta LIMIT ${limiteLinhas + 1}`, parametros);

    const truncado = rows.length > limiteLinhas;
    return {
      linhas: truncado ? rows.slice(0, limiteLinhas) : rows,
      total: truncado ? limiteLinhas : rows.length,
      truncado,
      tempo_ms: Date.now() - inicio,
      camadas,
    };
  } finally {
    // Sempre ROLLBACK: nao ha o que confirmar numa leitura.
    await cliente.query('ROLLBACK').catch(() => undefined);
    cliente.release();
  }
}

/**
 * Autoteste da camada 2: prova que o servidor recusa escrita.
 *
 * Existe porque "a transacao e READ ONLY" e uma afirmacao que merece ser
 * verificada, nao apenas declarada numa tela. Tenta uma escrita real dentro da
 * transacao e espera o erro 25006 do PostgreSQL. Se a escrita PASSAR, devolve
 * `protegido: false` - e ai ha um problema serio a investigar.
 *
 * Nao usa o envelope de SELECT justamente para testar o motor, e nao a
 * sintaxe. Roda numa transacao que termina em ROLLBACK de qualquer forma.
 */
export async function verificarLeituraSomente(): Promise<{
  protegido: boolean;
  codigo: string | null;
  mensagem: string;
  papel_dedicado: boolean;
}> {
  const cliente = await (poolLeitura ?? pool).connect();
  try {
    await cliente.query('BEGIN TRANSACTION READ ONLY');
    await cliente.query(
      "UPDATE configuracoes SET valor = valor WHERE chave = 'ia.zscore_anomalia'");
    return {
      protegido: false,
      codigo: null,
      mensagem: 'A escrita NAO foi recusada dentro da transacao READ ONLY',
      papel_dedicado: poolLeitura !== null,
    };
  } catch (erro) {
    const e = erro as { code?: string; message?: string };
    // 25006 = read_only_sql_transaction; 42501 = insufficient_privilege
    const protegido = e.code === '25006' || e.code === '42501';
    return {
      protegido,
      codigo: e.code ?? null,
      mensagem: e.message ?? 'erro sem mensagem',
      papel_dedicado: poolLeitura !== null,
    };
  } finally {
    await cliente.query('ROLLBACK').catch(() => undefined);
    cliente.release();
  }
}

/** Estado das camadas de seguranca, para a tela de governanca (secao 37). */
export function estadoSeguranca() {
  return {
    camadas: [
      {
        nome: 'Validacao da aplicacao',
        ativa: true,
        descricao: 'Apenas SELECT e WITH, uma instrucao, sem comentarios, '
          + 'lista de tabelas permitidas e LIMIT obrigatorio',
        comandos_bloqueados: PROIBIDOS.length,
        tabelas_permitidas: TABELAS_PERMITIDAS.size,
      },
      {
        nome: 'Transacao READ ONLY',
        ativa: true,
        descricao: 'O PostgreSQL recusa qualquer escrita dentro da transacao, '
          + 'independentemente do que a aplicacao tenha deixado passar',
      },
      {
        nome: 'Papel de banco somente leitura',
        ativa: env.temConexaoLeitura,
        descricao: env.temConexaoLeitura
          ? 'Conexao com privilegio de SELECT apenas, sem acesso a usuarios nem ao log'
          : 'Nao configurado: defina DATABASE_URL_LEITURA apos rodar '
            + 'db/roles/001_papel_leitura_ia.sql. As outras duas camadas seguem ativas.',
      },
      {
        nome: 'Registro de execucoes',
        ativa: true,
        descricao: 'Toda consulta, executada ou bloqueada, e gravada em ia_execucoes, '
          + 'que e append-only',
      },
    ],
    escrita_possivel: false,
    observacao: 'A IA nao altera dados por este mecanismo em nenhuma circunstancia.',
  };
}

export const tabelasPermitidas = () => [...TABELAS_PERMITIDAS].sort();
export const comandosBloqueados = () => [...PROIBIDOS];
