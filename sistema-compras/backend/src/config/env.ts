import 'dotenv/config';
import { z } from 'zod';

/**
 * Validacao das variaveis de ambiente na subida do processo.
 * A aplicacao nao sobe com configuracao invalida — falha cedo e explicita.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3333),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL e obrigatoria'),
  /*
   * Conexao somente leitura para as consultas analiticas da IA (secao 23 do
   * modulo 12). Opcional de proposito: sem ela a guarda de SQL e a transacao
   * READ ONLY continuam valendo, e o sistema informa que roda com uma camada
   * a menos em vez de fingir que nao ha diferenca.
   * Provisionada por `db/roles/001_papel_leitura_ia.sql`.
   */
  DATABASE_URL_LEITURA: z.string().optional(),
  PGSSL: z.enum(['true', 'false']).default('false'),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de no minimo 32 caracteres'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(8).max(15).default(10),
  LOGIN_TENTATIVAS_MAX: z.coerce.number().int().min(3).max(1000).default(10),
  LOGIN_JANELA_MINUTOS: z.coerce.number().int().min(1).max(1440).default(15),
  SEED_ADMIN_EMAIL: z.string().email().default('admin@empresa.com.br'),
  SEED_ADMIN_SENHA: z.string().min(8).default('Admin@123'),
  SEED_DADOS_TESTE: z.enum(['true', 'false']).default('true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Configuracao invalida no .env:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = {
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  usarSsl: parsed.data.PGSSL === 'true',
  semearDadosTeste: parsed.data.SEED_DADOS_TESTE === 'true',
  temConexaoLeitura: Boolean(parsed.data.DATABASE_URL_LEITURA),
};
