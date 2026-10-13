/**
 * Remove a massa de teste (seed 002) do banco.
 *
 * Tudo que o seed cria tem o prefixo `TST-` ou a marca `[TESTE]`; e SO isso que
 * e apagado, junto com o que depende disso (movimentacoes, lotes, itens, etc.),
 * descoberto pelas chaves estrangeiras. Dados reais - produtos do ERP, vendas
 * importadas - nao casam com esses criterios.
 *
 *   npm run db:limpar-teste               simula: mostra o que apagaria e desfaz
 *   npm run db:limpar-teste -- --confirmar  apaga de verdade (numa transacao)
 *
 * As tabelas de razao (somente insercao) tem o bloqueio desligado so dentro da
 * transacao e religado antes do COMMIT.
 */
import type { PoolClient } from 'pg';
import { encerrarPool, pool } from '../config/database.js';

const RAIZES: Array<{ tabela: string; onde: string }> = [
  { tabela: 'ordens_compra', onde: "numero LIKE 'TST-%'" },
  { tabela: 'vendas', onde: "numero_documento LIKE 'TST-%'" },
  { tabela: 'produtos', onde: "codigo LIKE 'TST-%'" },
  { tabela: 'fornecedores', onde: "razao_social LIKE '%[TESTE]%'" },
  { tabela: 'locais', onde: "codigo LIKE 'TST-%'" },
  { tabela: 'subcategorias', onde: "nome LIKE '%[TESTE]%'" },
  { tabela: 'marcas', onde: "nome LIKE '%[TESTE]%'" },
  { tabela: 'categorias', onde: "nome LIKE '%[TESTE]%'" },
];

interface Fk { filha: string; colunasFilha: string; colunasPai: string }

const contagem = new Map<string, number>();

async function chaves(c: PoolClient, tabela: string): Promise<Fk[]> {
  const { rows } = await c.query<{ filha: string; cf: string; cp: string }>(`
    SELECT k.conrelid::regclass::text AS filha,
           (SELECT string_agg(a.attname, ', ' ORDER BY u.ord)
              FROM unnest(k.conkey) WITH ORDINALITY u(num, ord)
              JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.num) AS cf,
           (SELECT string_agg(a.attname, ', ' ORDER BY u.ord)
              FROM unnest(k.confkey) WITH ORDINALITY u(num, ord)
              JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.num) AS cp
      FROM pg_constraint k
     WHERE k.contype = 'f' AND k.confrelid = $1::regclass`, [tabela]);
  return rows.map((r) => ({ filha: r.filha, colunasFilha: r.cf, colunasPai: r.cp }));
}

/** Apaga as linhas de `tabela` que satisfazem `onde`, filhas primeiro. */
async function apagar(c: PoolClient, tabela: string, onde: string, caminho: string[]): Promise<void> {
  if (caminho.length > 30) throw new Error(`Cadeia de dependencias longa demais em ${tabela}`);
  for (const fk of await chaves(c, tabela)) {
    if (fk.filha === tabela || caminho.includes(fk.filha)) continue;
    await apagar(c, fk.filha,
      `(${fk.colunasFilha}) IN (SELECT ${fk.colunasPai} FROM ${tabela} WHERE ${onde})`,
      [...caminho, tabela]);
  }
  const r = await c.query(`DELETE FROM ${tabela} WHERE ${onde}`);
  if (r.rowCount) contagem.set(tabela, (contagem.get(tabela) ?? 0) + r.rowCount);
}

async function main() {
  const confirmar = process.argv.includes('--confirmar');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // Tabelas somente-insercao: o bloqueio impediria apagar a razao do mock.
    const { rows: protegidas } = await c.query<{ tabela: string; gatilho: string }>(`
      SELECT tgrelid::regclass::text AS tabela, tgname AS gatilho
        FROM pg_trigger
       WHERE NOT tgisinternal AND tgfoid = 'fn_bloquear_alteracao'::regproc`);
    for (const p of protegidas) await c.query(`ALTER TABLE ${p.tabela} DISABLE TRIGGER "${p.gatilho}"`);

    for (const r of RAIZES) await apagar(c, r.tabela, r.onde, []);

    for (const p of protegidas) await c.query(`ALTER TABLE ${p.tabela} ENABLE TRIGGER "${p.gatilho}"`);

    if (!contagem.size) {
      console.log('Nenhum dado de teste encontrado. Nada a fazer.');
      await c.query('ROLLBACK');
      return;
    }

    console.log(confirmar ? 'Apagado:' : 'SIMULACAO - seria apagado:');
    for (const [tabela, n] of [...contagem].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${tabela.padEnd(34)} ${String(n).padStart(7)}`);
    }

    if (!confirmar) {
      await c.query('ROLLBACK');
      console.log('\nNada foi alterado. Para apagar de verdade: npm run db:limpar-teste -- --confirmar');
      return;
    }

    await c.query('COMMIT');
    // As demandas agregadas ainda guardam as vendas de teste.
    await pool.query('REFRESH MATERIALIZED VIEW mv_demanda_diaria');
    await pool.query('REFRESH MATERIALIZED VIEW mv_demanda_mensal');
    console.log('\nConcluido. Views de demanda atualizadas.');
  } catch (erro) {
    await c.query('ROLLBACK');
    throw erro;
  } finally {
    c.release();
  }
}

main()
  .catch((e) => { console.error('Falhou, nada foi alterado:', e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => encerrarPool());
