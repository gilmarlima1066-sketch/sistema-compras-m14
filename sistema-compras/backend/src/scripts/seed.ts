/**
 * Carga inicial: dados estruturais, usuario administrador e (opcional) massa
 * de teste. Idempotente — pode rodar quantas vezes precisar.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, encerrarPool } from '../config/database.js';
import { env } from '../config/env.js';
import { gerarHashSenha } from '../modules/auth/auth.service.js';

const PASTA_SEEDS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/seeds');

async function rodarArquivo(nome: string) {
  const sql = await readFile(join(PASTA_SEEDS, nome), 'utf8');
  await pool.query(sql);
  console.log(`  [ok] ${nome}`);
}

async function criarAdministrador() {
  const { rows } = await pool.query<{ id: number }>(
    'SELECT id FROM usuarios WHERE lower(email) = lower($1)', [env.SEED_ADMIN_EMAIL],
  );
  if (rows[0]) {
    console.log('  [ok] administrador ja existe');
    return;
  }
  await pool.query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil_id, ativo)
     VALUES ($1, $2, $3, (SELECT id FROM perfis WHERE nome = 'ADMIN'), TRUE)`,
    ['Administrador', env.SEED_ADMIN_EMAIL, await gerarHashSenha(env.SEED_ADMIN_SENHA)],
  );
  console.log(`  [ok] administrador criado: ${env.SEED_ADMIN_EMAIL}`);
}

export async function semear() {
  await rodarArquivo('001_base.sql');
  await criarAdministrador();
  if (env.semearDadosTeste) {
    await rodarArquivo('002_dados_teste.sql');
  } else {
    console.log('  [--] massa de teste desativada (SEED_DADOS_TESTE=false)');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Carregando seeds...');
  semear()
    .then(() => console.log('\nSeed concluido.'))
    .catch((erro) => {
      console.error('\nErro no seed:', erro.message);
      process.exitCode = 1;
    })
    .finally(encerrarPool);
}
