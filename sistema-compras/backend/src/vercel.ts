/**
 * Ponto de entrada da API como funcao serverless na Vercel.
 *
 * O app Express e um handler (req, res) - a Vercel o chama a cada requisicao
 * de /api/* e /health (rotas em scripts/vercel-build.mjs). O pool de conexoes
 * vive enquanto a instancia estiver quente; por isso PG_POOL_MAX deve ser
 * baixo na Vercel. Localmente continua valendo `npm run dev` (server.ts).
 */
import './vercel-fuso.js';
import { criarApp } from './app.js';

export default criarApp();
