// Package gate for @eviland/core (packages/eviland-core): builds the
// standalone package the way its `npm run build` does and imports the result
// with nothing but Node, asserting every value the public src/index.ts
// promises to export is really in dist/index.js.
//
// This exists because the package's public surface (src/index.ts + README)
// is hand-maintained, separate from the byte-for-byte src/visualizer mirror
// that sync.mjs enforces: an engine module can drop an export that index.ts
// still re-exports, and nothing else catches that until a real consumer's
// `import` throws `undefined is not a function`. The import is deliberately
// not routed through a bundler: tsc's per-module output has extensionless
// relative imports, so a bundler-only check passed while Node could not load
// the package at all.
//
// Run: node scripts/eviland-core-package-test.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// 1) Build for real, with the package's own build script (bundle + declarations).
// The package has no node_modules of its own; npm finds esbuild and tsc in the
// repo root's.
const built = spawnSync('npm run build', { cwd: pkgDir, stdio: 'inherit', shell: true });
if (built.status !== 0) {
  fail(`package build exited with ${built.status}`);
  writeFileSync(RESULT, log.join('\n') + '\n[eviland-core-package-test] FAIL\n');
  console.log(log.join('\n'));
  process.exit(1);
}
log.push('build: dist/ emitted with 0 errors');

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

// 3) Import dist/index.js in a fresh Node process, no bundler, and list what it exports.
const entry = resolve(pkgDir, 'dist/index.js');
const bundled = readFileSync(entry, 'utf8');
if (/(?:from|import)\s*\(?\s*['"]\.\.?\//.test(bundled)) {
  fail('dist/index.js still has relative imports; it is meant to be one self-contained module');
}
const probe = spawnSync(process.execPath, [
  '--input-type=module',
  '-e',
  `const m = await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log(JSON.stringify(Object.keys(m).filter((k) => m[k] !== undefined)));`,
], { encoding: 'utf8' });
if (probe.status !== 0) {
  fail(`plain Node could not import dist/index.js:\n${probe.stderr}`);
} else {
  const present = new Set(JSON.parse(probe.stdout));
  for (const name of expectedExports) {
    if (!present.has(name)) fail(`dist/index.js is missing export "${name}" (promised by src/index.ts) or exports it undefined`);
  }
  if (pass) log.push(`all ${expectedExports.length} exports present and defined, imported by plain Node`);
}

// 4) The declarations the package.json points consumers at.
for (const file of ['dist/index.d.ts', 'dist/eviland.d.ts']) {
  if (!existsSync(resolve(pkgDir, file))) fail(`${file} was not emitted`);
}

const report = log.join('\n') + '\n' + (pass ? '[eviland-core-package-test] PASS' : '[eviland-core-package-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
