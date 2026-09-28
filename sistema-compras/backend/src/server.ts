import { criarApp } from './app.js';
import { env } from './config/env.js';
import { encerrarPool } from './config/database.js';

const servidor = criarApp().listen(env.PORT, () => {
  console.log(`[api] ouvindo em http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

const encerrar = (sinal: string) => async () => {
  console.log(`[api] ${sinal} recebido, encerrando...`);
  servidor.close(async () => {
    await encerrarPool();
    process.exit(0);
  });
};

process.on('SIGTERM', encerrar('SIGTERM'));
process.on('SIGINT', encerrar('SIGINT'));
