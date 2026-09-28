/**
 * Transferencia explicita de dados de um PostgreSQL existente (ex.: o banco
 * local usado ate agora) para outro banco com o mesmo schema (ex.: Supabase).
 *
 *   ORIGEM_DATABASE_URL=postgres://...local...  npm run db:transferir            # so simula
 *   ORIGEM_DATABASE_URL=postgres://...local...  npm run db:transferir -- --executar
 *
 * O destino e a DATABASE_URL do .env. Regras:
 * - origem e destino precisam ter exatamente as mesmas migrations aplicadas
 *   (mesmo nome e checksum) - o schema e criado pelas migrations, nao aqui;
 * - sem --executar, nada e gravado: mostra quantas linhas iriam por tabela;
 * - o destino precisa estar recem-migrado e SEM seed (nenhum usuario). Se ja
 *   tiver usuarios, so segue com --substituir-destino, que APAGA os dados dele;
 * - tudo roda numa transacao unica no destino: ou vai tudo, ou nada;
 * - triggers ficam desligadas durante a carga (session_replication_role =
 *   replica) para o historico entrar como esta, sem auditoria nova nem
 *   recalculo de estoque; as sequencias recebem o valor exato da origem;
 * - a origem e lida numa transacao READ ONLY com snapshot unico.
 */
import 'dotenv/config';
import pg from 'pg';

const LOTE = 2000;
const argumentos = new Set(process.argv.slice(2));
const executar = argumentos.has('--executar');
const substituirDestino = argumentos.has('--substituir-destino');

function ssl(url: string) {
  // Supabase (e a maioria dos bancos gerenciados) exige TLS; o local nao.
  return /sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url)
    ? undefined
    : { rejectUnauthorized: false };
}

const cliente = (url: string, nome: string) =>
  new pg.Client({ connectionString: url, ssl: ssl(url), application_name: nome });

const semSenha = (url: string) => url.replace(/\/\/([^:@/]+):[^@]*@/, '//$1:***@');

interface Tabela { nome: string; colunas: string[] }

async function listarTabelas(c: pg.Client): Promise<Tabela[]> {
  const { rows } = await c.query<{ nome: string; colunas: string[] }>(`
    SELECT cl.relname AS nome,
           array_agg(a.attname::text ORDER BY a.attnum) AS colunas
      FROM pg_class cl
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_attribute a ON a.attrelid = cl.oid
     WHERE n.nspname = 'public'
       AND cl.relkind IN ('r', 'p')
       AND NOT cl.relispartition
       AND cl.relname <> 'schema_migrations'
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attgenerated = ''
     GROUP BY cl.relname
     ORDER BY cl.relname`);
  return rows;
}

async function contar(c: pg.Client, tabela: string): Promise<number> {
  const { rows } = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${pg.escapeIdentifier(tabela)}`);
  return Number(rows[0].n);
}

async function migrationsIguais(origem: pg.Client, destino: pg.Client): Promise<string | null> {
  const ler = async (c: pg.Client) => {
    const { rows } = await c.query<{ nome: string; checksum: string }>(
      'SELECT nome, checksum FROM schema_migrations ORDER BY nome');
    return rows.map((r) => `${r.nome}:${r.checksum}`);
  };
  const [o, d] = await Promise.all([ler(origem), ler(destino)]);
  const soOrigem = o.filter((x) => !d.includes(x));
  const soDestino = d.filter((x) => !o.includes(x));
  if (!soOrigem.length && !soDestino.length) return null;
  return [
    'Origem e destino tem migrations diferentes. Rode `npm run db:migrate` nos dois antes.',
    soOrigem.length ? `  so na origem: ${soOrigem.join(', ')}` : '',
    soDestino.length ? `  so no destino: ${soDestino.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

async function transferir() {
  const urlOrigem = process.env.ORIGEM_DATABASE_URL;
  const urlDestino = process.env.DESTINO_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!urlOrigem) throw new Error('Defina ORIGEM_DATABASE_URL (banco de onde os dados saem).');
  if (!urlDestino) throw new Error('Defina DATABASE_URL (ou DESTINO_DATABASE_URL) com o banco de destino.');
  if (urlOrigem === urlDestino) throw new Error('Origem e destino sao o mesmo banco.');

  console.log(`Origem:  ${semSenha(urlOrigem)}`);
  console.log(`Destino: ${semSenha(urlDestino)}`);
  console.log(executar ? 'Modo: EXECUCAO\n' : 'Modo: simulacao (nada sera gravado; use --executar)\n');

  const origem = cliente(urlOrigem, 'compras-transferencia-origem');
  const destino = cliente(urlDestino, 'compras-transferencia-destino');
  await origem.connect();
  await destino.connect();

  try {
    const divergencia = await migrationsIguais(origem, destino);
    if (divergencia) throw new Error(divergencia);

    await origem.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tabelas = await listarTabelas(origem);

    const usuariosDestino = await contar(destino, 'usuarios');
    if (usuariosDestino > 0 && !substituirDestino) {
      throw new Error(
        `O destino ja tem ${usuariosDestino} usuario(s): parece estar em uso. Nada foi alterado.\n` +
        'Use um banco recem-migrado e sem seed, ou repita com --substituir-destino ' +
        '(isso APAGA todos os dados do destino).',
      );
    }

    const contagem: Array<{ tabela: string; origem: number; destino: number }> = [];
    for (const t of tabelas) {
      contagem.push({ tabela: t.nome, origem: await contar(origem, t.nome), destino: await contar(destino, t.nome) });
    }
    const comDados = contagem.filter((c) => c.origem > 0 || c.destino > 0);
    console.table(comDados);
    const total = contagem.reduce((s, c) => s + c.origem, 0);
    console.log(`${tabelas.length} tabelas, ${total} linhas na origem.`);

    if (!executar) {
      console.log('\nSimulacao concluida. Para gravar, repita com --executar.');
      return;
    }

    await destino.query('BEGIN');
    try {
      await destino.query('SET LOCAL session_replication_role = replica');
    } catch (erro) {
      throw new Error(
        'O usuario do destino nao pode desligar triggers (session_replication_role). ' +
        `Use o usuario postgres do Supabase. Detalhe: ${(erro as Error).message}`,
      );
    }

    // Limpa o destino inteiro (inclui catalogos que as migrations inseriram:
    // a origem tem os mesmos, possivelmente ajustados por quem usa o sistema).
    await destino.query(`TRUNCATE ${tabelas.map((t) => `public.${pg.escapeIdentifier(t.nome)}`).join(', ')}`);

    for (const t of tabelas) {
      const nome = `public.${pg.escapeIdentifier(t.nome)}`;
      const colunas = t.colunas.map((c) => pg.escapeIdentifier(c)).join(', ');
      let copiadas = 0;
      for (let deslocamento = 0; ; deslocamento += LOTE) {
        const { rows } = await origem.query<{ lote: string | null }>(
          `SELECT jsonb_agg(to_jsonb(x))::text AS lote
             FROM (SELECT * FROM ${nome} ORDER BY ctid LIMIT ${LOTE} OFFSET ${deslocamento}) x`);
        const lote = rows[0].lote;
        if (!lote) break;
        const r = await destino.query(
          `INSERT INTO ${nome} (${colunas}) OVERRIDING SYSTEM VALUE
           SELECT ${colunas} FROM jsonb_populate_recordset(NULL::${nome}, $1::jsonb)`, [lote]);
        copiadas += r.rowCount ?? 0;
      }
      if (copiadas) console.log(`  [ok] ${t.nome}: ${copiadas}`);
    }

    // Sequencias com o valor exato da origem: o proximo id no destino continua
    // de onde a origem parou.
    const { rows: sequencias } = await origem.query<{ nome: string; valor: string | null; chamada: boolean }>(`
      SELECT sequencename AS nome, last_value::text AS valor, last_value IS NOT NULL AS chamada
        FROM pg_sequences WHERE schemaname = 'public'`);
    for (const s of sequencias) {
      if (s.valor === null) continue;
      await destino.query('SELECT setval($1::regclass, $2::bigint, $3)',
        [`public.${pg.escapeIdentifier(s.nome)}`, s.valor, s.chamada]);
    }

    // Conferencia antes do COMMIT: cada tabela com a mesma contagem.
    for (const c of contagem) {
      const n = await contar(destino, c.tabela);
      if (n !== c.origem) throw new Error(`Conferencia falhou em ${c.tabela}: origem ${c.origem}, destino ${n}.`);
    }

    await destino.query('COMMIT');
    console.log(`\nTransferencia concluida e conferida: ${total} linhas, ${sequencias.length} sequencias.`);
  } catch (erro) {
    await destino.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    await origem.query('ROLLBACK').catch(() => undefined);
    await origem.end();
    await destino.end();
  }
}

transferir().catch((erro) => {
  console.error(`\nErro: ${(erro as Error).message}`);
  process.exitCode = 1;
});
