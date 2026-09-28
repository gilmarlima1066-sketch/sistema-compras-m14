import pg from 'pg';
import { env } from './env.js';

const { Pool } = pg;

// NUMERIC volta como string por padrao no driver: convertemos para number
// de forma centralizada para nao espalhar parseFloat pela aplicacao.
pg.types.setTypeParser(1700, (valor) => (valor === null ? null : Number(valor)));
pg.types.setTypeParser(20, (valor) => (valor === null ? null : Number(valor))); // BIGINT

// DATE e um dia, nao um instante. O driver o transformaria num Date a
// meia-noite do fuso do processo; num fuso negativo, "2026-09-26" volta como
// 25/09 assim que alguem serializa em UTC. Data de entrega nao pode andar para
// tras por causa de fuso, entao DATE trafega como texto "AAAA-MM-DD".
pg.types.setTypeParser(1082, (valor) => valor);

/*
 * FUSO DA SESSAO
 *
 * O servidor PostgreSQL deste ambiente roda em UTC; a aplicacao roda em
 * America/Sao_Paulo. Entre 21h e a meia-noite em Sao Paulo o banco ja esta no
 * DIA SEGUINTE - e `CURRENT_DATE` no SQL passa a divergir do `hojeLocal()` da
 * aplicacao.
 *
 * Isso nao e teorico: uma meta gravada com `vigencia_inicio = CURRENT_DATE`
 * (dia 28, no banco) era procurada com a data local (dia 27) e nao era
 * encontrada, fazendo o indicador cair na meta anterior. O bug so aparecia em
 * tres das vinte e quatro horas, que e o tipo de defeito que sobrevive a
 * muitos testes.
 *
 * Alinhar o fuso da SESSAO resolve a classe inteira: `CURRENT_DATE` e `now()`
 * passam a falar a mesma data que a aplicacao. Os `timestamptz` continuam
 * guardados em UTC - muda so a conversao na leitura, que e justamente o que se
 * quer. E `DATE` ja trafega como texto, sem conversao nenhuma.
 */
const FUSO = process.env.TZ ?? 'America/Sao_Paulo';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX,
  ssl: env.usarSsl ? { rejectUnauthorized: false } : undefined,
  application_name: 'compras-api',
  options: `-c timezone=${FUSO}`,
});

pool.on('error', (erro) => {
  console.error('[db] erro inesperado no pool', erro);
});

/**
 * Pool SOMENTE LEITURA das consultas analiticas da IA (modulo 12, secao 23).
 *
 * Existe so quando DATABASE_URL_LEITURA esta configurada, apontando para o
 * papel `compras_ia` (ver db/roles/001_papel_leitura_ia.sql). Quando nao
 * existe, quem consulta cai no pool normal - e ali a transacao READ ONLY do
 * proprio PostgreSQL continua impedindo qualquer escrita.
 *
 * O limite de conexoes e baixo de proposito: consulta analitica nao pode
 * competir com quem esta operando o sistema.
 */
export const poolLeitura = env.DATABASE_URL_LEITURA
  ? new Pool({
    connectionString: env.DATABASE_URL_LEITURA,
    max: 3,
    ssl: env.usarSsl ? { rejectUnauthorized: false } : undefined,
    application_name: 'compras-ia-leitura',
    options: `-c timezone=${FUSO}`,
  })
  : null;

poolLeitura?.on('error', (erro) => {
  console.error('[db] erro inesperado no pool de leitura', erro);
});

export type Consulta = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  texto: string,
  valores?: unknown[],
) => Promise<pg.QueryResult<T>>;

export const query: Consulta = (texto, valores) => pool.query(texto, valores as never[]);

export interface ContextoSessao {
  usuarioId?: number | null;
  ip?: string | null;
}

/**
 * Executa um bloco dentro de uma transacao unica, publicando o usuario e o IP
 * da sessao para que as triggers de auditoria saibam quem fez a alteracao.
 * Qualquer excecao dispara ROLLBACK.
 */
export async function comTransacao<T>(
  contexto: ContextoSessao,
  executar: (cliente: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query('SELECT set_config($1, $2, true)', [
      'app.usuario_id',
      contexto.usuarioId ? String(contexto.usuarioId) : '',
    ]);
    await cliente.query('SELECT set_config($1, $2, true)', ['app.ip', contexto.ip ?? '']);
    const resultado = await executar(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }
}

export async function encerrarPoolLeitura(): Promise<void> {
  await poolLeitura?.end();
}

export async function encerrarPool(): Promise<void> {
  await pool.end();
}
