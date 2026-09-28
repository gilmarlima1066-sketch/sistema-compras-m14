/** Derruba e recria o schema public. Bloqueado em producao. */
import { pool, encerrarPool } from '../config/database.js';
import { env } from '../config/env.js';

async function resetar() {
  if (env.isProduction) throw new Error('db:reset e bloqueado em producao');
  // No Supabase o schema public carrega permissoes e objetos da plataforma;
  // derruba-lo apaga dados reais e quebra essas permissoes. So com pedido
  // explicito, para um projeto de testes.
  if (/supabase\.(co|com)/i.test(env.DATABASE_URL) && process.env.CONFIRMAR_RESET_SUPABASE !== 'sim') {
    throw new Error(
      'DATABASE_URL aponta para o Supabase: db:reset recusado. ' +
      'Se for um projeto de TESTE, rode com CONFIRMAR_RESET_SUPABASE=sim.',
    );
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  console.log('Schema public recriado. Rode npm run db:migrate em seguida.');
}

resetar()
  .catch((erro) => {
    console.error(erro.message);
    process.exitCode = 1;
  })
  .finally(encerrarPool);
