// Package gate for @eviland/core (packages/eviland-core): builds the
// standalone package for real (declaration-emitting tsc, not just a
// typecheck) and imports every value the public src/index.ts promises to
// export, asserting each one actually made it into dist/index.js.
//
// This exists because the package's public surface (src/index.ts + README)
// is hand-maintained, separate from the byte-for-byte src/visualizer mirror
// that sync.mjs enforces: an engine module can drop an export that index.ts
// still re-exports, and nothing else catches that until a real consumer's
// `import` throws `undefined is not a function`.
//
// Run: node scripts/eviland-core-package-test.mjs
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/eviland-core-package-test-result.txt');
writeFileSync(RESULT, '[eviland-core-package-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

const pkgDir = resolve('packages/eviland-core');

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

// 1) Build for real (declaration-emitting), not just --noEmit. This is what a
// consumer would actually run before publishing/installing the package.
// Built from the repo root so tsc resolves from the root node_modules; the
// package has no node_modules of its own on a clean checkout or CI runner.
const built = spawnSync('npx tsc -p packages/eviland-core/tsconfig.json', { cwd: resolve('.'), stdio: 'inherit', shell: true });
if (built.status !== 0) {
  fail(`package build exited with ${built.status}`);
  writeFileSync(RESULT, log.join('\n') + '\n[eviland-core-package-test] FAIL\n');
  process.exit(1);
}
log.push('build: dist/ emitted with 0 tsc errors');

// 2) Derive the expected public value exports from src/index.ts itself
// (rather than hardcoding a list here), so a newly added export is covered
// automatically and a `type X` re-export is correctly skipped (types don't
// exist at runtime).
const indexSrc = readFileSync(resolve(pkgDir, 'src/index.ts'), 'utf8');
const expectedExports = [];
for (const block of indexSrc.matchAll(/export\s*\{([\s\S]*?)\}\s*from/g)) {
  for (const rawEntry of block[1].split(',')) {
    const entry = rawEntry.trim();
    if (!entry || entry.startsWith('type ')) continue; // type-only, no runtime value
    // Handles `Name` and `Name as Alias` (keep the alias, what callers import).
    const name = entry.includes(' as ') ? entry.split(' as ')[1].trim() : entry;
    if (name) expectedExports.push(name);
  }
}
if (expectedExports.length === 0) {
  fail('could not find any exported value names in src/index.ts — parser regression?');
}
log.push(`expected ${expectedExports.length} value exports from src/index.ts: ${expectedExports.join(', ')}`);

// 3) Import the actual built output and check each one is really there. The
// package targets bundlers (moduleResolution: bundler, extensionless relative
// imports), so a bare Node import of dist/index.js cannot resolve its own
// modules; bundle it the way a consumer's toolchain would and import that.
const bundlePath = resolve('tmp/eviland-core-package-bundle.mjs');
await build({
  entryPoints: [resolve(pkgDir, 'dist/index.js')],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  outfile: bundlePath, logLevel: 'silent',
});
const dist = await import(pathToFileURL(bundlePath).href);
for (const name of expectedExports) {
  if (!(name in dist)) {
    fail(`dist/index.js is missing export "${name}" (promised by src/index.ts)`);
    continue;
  }
  if (dist[name] === undefined) {
    fail(`dist/index.js exports "${name}" but its value is undefined`);
  }
}
if (pass) log.push(`all ${expectedExports.length} exports present and defined in dist/index.js`);

const report = log.join('\n') + '\n' + (pass ? '[eviland-core-package-test] PASS' : '[eviland-core-package-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
