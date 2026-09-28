/** Derruba e recria o schema public. Bloqueado em producao. */
import { pool, encerrarPool } from '../config/database.js';
import { env } from '../config/env.js';

async function resetar() {
  if (env.isProduction) throw new Error('db:reset e bloqueado em producao');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  console.log('Schema public recriado. Rode npm run db:migrate em seguida.');
}

resetar()
  .catch((erro) => {
    console.error(erro.message);
    process.exitCode = 1;
  })
  .finally(encerrarPool);
