import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { rotas } from './routes.js';
import { errorHandler, rotaNaoEncontrada } from './middlewares/errorHandler.js';
import { contextoRequisicao } from './middlewares/contextoRequisicao.js';
import { pool } from './config/database.js';

export function criarApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()), credentials: true }));
  // `verify` guarda o corpo CRU antes do parse. E o unico momento em que ele
  // existe - depois, `req.body` e um objeto, e reserializar produz outra string
  // (ordem de chaves, espacos), o que quebraria a assinatura HMAC dos webhooks
  // do modulo 13. Guardar aqui nao muda nada para as demais rotas.
  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      if (buf.length) (req as unknown as { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  }));
  app.use(contextoRequisicao);

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ success: true, data: { banco: 'ok' }, message: 'API no ar' });
    } catch {
      res.status(503).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Banco indisponivel', details: [] },
      });
    }
  });

  app.use('/api', rotas);

  app.use(rotaNaoEncontrada);
  app.use(errorHandler);

  return app;
}
