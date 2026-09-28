/**
 * Executor de migrations.
 * - le db/migrations/*.sql em ordem alfabetica;
 * - envolve cada arquivo em UMA transacao (BEGIN/COMMIT do arquivo sao removidos
 *   para que o controle fique com o runner);
 * - registra o que ja rodou em schema_migrations com o checksum do arquivo.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, encerrarPool } from '../config/database.js';

const PASTA_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

async function garantirTabelaControle() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      nome        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      executado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

export async function migrar(): Promise<{ aplicadas: string[]; jaAplicadas: string[] }> {
  await garantirTabelaControle();

  const arquivos = (await readdir(PASTA_MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ nome: string; checksum: string }>(
    'SELECT nome, checksum FROM schema_migrations',
  );
  const executadas = new Map(rows.map((r) => [r.nome, r.checksum]));

  const aplicadas: string[] = [];
  const jaAplicadas: string[] = [];

  for (const arquivo of arquivos) {
    const conteudo = await readFile(join(PASTA_MIGRATIONS, arquivo), 'utf8');
    const checksum = createHash('sha256').update(conteudo).digest('hex').slice(0, 16);

    if (executadas.has(arquivo)) {
      if (executadas.get(arquivo) !== checksum) {
        throw new Error(
          `Migration ${arquivo} foi alterada depois de aplicada. ` +
          'Crie uma nova migration em vez de editar uma ja executada.',
        );
      }
      jaAplicadas.push(arquivo);
      continue;
    }

    const sql = conteudo
      .split('\n')
      .filter((linha) => !/^\s*(BEGIN|COMMIT)\s*;\s*$/i.test(linha))
      .join('\n');

    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query(sql);
      await cliente.query('INSERT INTO schema_migrations (nome, checksum) VALUES ($1, $2)', [arquivo, checksum]);
      await cliente.query('COMMIT');
      aplicadas.push(arquivo);
      console.log(`  [ok] ${arquivo}`);
    } catch (erro) {
      await cliente.query('ROLLBACK');
      console.error(`  [falhou] ${arquivo}`);
      throw erro;
    } finally {
      cliente.release();
    }
  }

  return { aplicadas, jaAplicadas };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Executando migrations...');
  migrar()
    .then(({ aplicadas, jaAplicadas }) => {
      console.log(`\n${aplicadas.length} migration(s) aplicada(s), ${jaAplicadas.length} ja estavam no banco.`);
    })
    .catch((erro) => {
      console.error('\nErro nas migrations:', erro.message);
      process.exitCode = 1;
    })
    .finally(encerrarPool);
}
