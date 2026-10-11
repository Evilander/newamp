// Builds dist/: one ESM bundle that Node and bundlers can import as it is,
// plus the type declarations. (tsc alone emits a file per module with
// extensionless relative imports, which plain Node cannot resolve.)
//
//   node build.mjs        # or: npm run build
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, 'dist');
rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: [resolve(here, 'src/index.ts')],
  outfile: resolve(dist, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'warning',
});

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const declarations = spawnSync(process.execPath, [tsc, '-p', resolve(here, 'tsconfig.json'), '--emitDeclarationOnly'], { cwd: here, stdio: 'inherit' });
if (declarations.status !== 0) process.exit(declarations.status ?? 1);
