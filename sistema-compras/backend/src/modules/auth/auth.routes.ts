import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validar } from '../../core/validate.js';
import { ok, rota } from '../../core/http.js';
import { autenticar as middlewareAutenticar } from '../../middlewares/autenticar.js';
import { alterarSenha, autenticar } from './auth.service.js';
import { env } from '../../config/env.js';

const loginSchema = z.object({
  email: z.string().email('Informe um e-mail valido'),
  senha: z.string().min(1, 'Informe a senha'),
});

const trocaSenhaSchema = z.object({
  senha_atual: z.string().min(1),
  nova_senha: z.string().min(8, 'A nova senha precisa de no minimo 8 caracteres'),
});

// Freio de forca bruta no login
// O teto protege contra forca bruta. Em desenvolvimento as baterias de teste
// autenticam dezenas de vezes em poucos minutos, por isso o valor e
// configuravel - e so ali, nunca em producao.
const limiteLogin = rateLimit({
  windowMs: env.LOGIN_JANELA_MINUTOS * 60 * 1000,
  limit: env.LOGIN_TENTATIVAS_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'UNAUTHORIZED', message: 'Muitas tentativas de login. Tente novamente em 15 minutos.', details: [] },
  },
});

export const authRouter = Router();

authRouter.post(
  '/login',
  limiteLogin,
  rota(async (req, res) => {
    const { email, senha } = validar(req, 'body', loginSchema);
    const resultado = await autenticar(email, senha);
    return ok(res, resultado, 'Login realizado com sucesso');
  }),
);

authRouter.get(
  '/eu',
  middlewareAutenticar,
  rota(async (req, res) => ok(res, req.usuario, 'Usuario autenticado')),
);

authRouter.post(
  '/trocar-senha',
  middlewareAutenticar,
  rota(async (req, res) => {
    const dados = validar(req, 'body', trocaSenhaSchema);
    await alterarSenha(req.usuario!.id, dados.senha_atual, dados.nova_senha);
    return ok(res, null, 'Senha alterada com sucesso');
  }),
);
