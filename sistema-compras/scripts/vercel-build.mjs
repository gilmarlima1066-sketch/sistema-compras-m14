/**
 * Build de producao para a Vercel (Build Output API v3).
 *
 * Gera `.vercel/output` na raiz do repositorio com:
 *   static/                 o frontend (Vite) ja compilado
 *   functions/api.func/     a API Express empacotada num unico arquivo
 *   config.json             rotas: /api/* e /health -> funcao; resto -> SPA
 *
 * A Vercel publica esse diretorio como esta. Rodar localmente tambem funciona
 * (`node sistema-compras/scripts/vercel-build.mjs`) para conferir o build.
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projeto = join(dirname(fileURLToPath(import.meta.url)), '..');
const raizRepo = join(projeto, '..');
const saida = join(raizRepo, '.vercel', 'output');
const funcao = join(saida, 'functions', 'api.func');

const rodar = (comando, cwd) => execSync(comando, { cwd, stdio: 'inherit' });

rmSync(saida, { recursive: true, force: true });

console.log('\n[1/3] frontend');
rodar('npm run build', join(projeto, 'frontend'));
cpSync(join(projeto, 'frontend', 'dist'), join(saida, 'static'), { recursive: true });

console.log('\n[2/3] API');
// esbuild e devDependency do backend: resolve a partir de la.
const { build } = createRequire(join(projeto, 'backend', 'package.json'))('esbuild');
mkdirSync(funcao, { recursive: true });
await build({
  entryPoints: [join(projeto, 'backend', 'src', 'vercel.ts')],
  outfile: join(funcao, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Dependencias CommonJS (express, pg) usam require() de modulos nativos.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  // Driver nativo opcional do pg: nao e usado.
  external: ['pg-native'],
  logLevel: 'info',
});
writeFileSync(join(funcao, '.vc-config.json'), JSON.stringify({
  runtime: 'nodejs22.x',
  handler: 'index.mjs',
  launcherType: 'Nodejs',
  // O Express le o corpo cru (assinatura HMAC dos webhooks): a Vercel nao
  // pode pre-processar a requisicao.
  shouldAddHelpersToRequest: false,
  maxDuration: 60,
}, null, 2));

console.log('\n[3/3] rotas');
writeFileSync(join(saida, 'config.json'), JSON.stringify({
  version: 3,
  routes: [
    { src: '^/(api|health)(?:/.*)?$', dest: '/api' },
    { src: '^/assets/.*$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
    { handle: 'filesystem' },
    // SPA: qualquer outra rota volta para o index.html (React Router).
    { src: '^/.*$', dest: '/index.html' },
  ],
}, null, 2));

console.log(`\nBuild pronto em ${saida}`);
