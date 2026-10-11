// sync.mjs keeps packages/eviland-core/src a copy of src/visualizer. It must
// not quietly throw away an edit made to the copy, and --check has to say
// which side moved. Runs against a throwaway tree, never the real package.
// Run: node scripts/eviland-core-sync-test.mjs
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve('tmp/eviland-core-sync-fixture');
rmSync(root, { recursive: true, force: true });
mkdirSync(resolve(root, 'packages/eviland-core'), { recursive: true });
cpSync(resolve('src/visualizer'), resolve(root, 'src/visualizer'), { recursive: true });
cpSync(resolve('packages/eviland-core/sync.mjs'), resolve(root, 'packages/eviland-core/sync.mjs'));

const sync = (...args) => {
  const run = spawnSync(process.execPath, [resolve(root, 'packages/eviland-core/sync.mjs'), ...args], { encoding: 'utf8' });
  return { status: run.status, out: run.stdout + run.stderr };
};
const app = (f) => resolve(root, 'src/visualizer', f);
const pkg = (f) => resolve(root, 'packages/eviland-core/src', f);
const state = resolve(root, 'tmp/eviland-core-sync.json');
const append = (file, text) => writeFileSync(file, readFileSync(file, 'utf8') + text);

let run = sync();
assert.equal(run.status, 0, run.out);
assert.equal(readFileSync(pkg('eviland-gl.ts'), 'utf8'), readFileSync(app('eviland-gl.ts'), 'utf8'), 'the first sync copies');
assert.ok(readFileSync(state, 'utf8').includes('eviland-gl.ts'), 'and records what it wrote');
assert.equal(sync('--check').status, 0);

// The engine moved on: --check names the source, and a sync carries it over.
append(app('eviland-gl.ts'), '\n// engine change\n');
run = sync('--check');
assert.equal(run.status, 1);
assert.match(run.out, /eviland-gl\.ts \(src\/visualizer changed\)/);
run = sync();
assert.equal(run.status, 0, run.out);
assert.match(readFileSync(pkg('eviland-gl.ts'), 'utf8'), /engine change/);

// An edit made to the package copy is not thrown away.
append(pkg('eviland-morph.ts'), '\n// edited in the package\n');
run = sync('--check');
assert.equal(run.status, 1);
assert.match(run.out, /eviland-morph\.ts \(package copy edited\)/);
run = sync();
assert.equal(run.status, 1, 'sync refuses');
assert.match(run.out, /REFUSED/);
assert.match(run.out, /eviland-morph\.ts/);
assert.match(run.out, /git diff --no-index src\/visualizer\/eviland-morph\.ts packages\/eviland-core\/src\/eviland-morph\.ts/, 'and says how to look at it');
assert.match(readFileSync(pkg('eviland-morph.ts'), 'utf8'), /edited in the package/, 'the edit is still there');
assert.equal(readFileSync(pkg('eviland-gl.ts'), 'utf8'), readFileSync(app('eviland-gl.ts'), 'utf8'), 'other files still sync');

// Both sides moved: still refused.
append(app('eviland-morph.ts'), '\n// edited in the app too\n');
assert.match(sync('--check').out, /eviland-morph\.ts \(edited on both sides\)/);
assert.equal(sync().status, 1);

// --force is the way to say the package edit can go.
run = sync('--force');
assert.equal(run.status, 0, run.out);
assert.equal(readFileSync(pkg('eviland-morph.ts'), 'utf8'), readFileSync(app('eviland-morph.ts'), 'utf8'));
assert.equal(sync('--check').status, 0);

// With no record of an earlier sync the app copy wins, as it always did.
rmSync(state);
append(pkg('eviland-rng.ts'), '\n// stray\n');
assert.match(sync('--check').out, /eviland-rng\.ts \(differs from src\/visualizer\)/);
run = sync();
assert.equal(run.status, 0, run.out);
assert.equal(readFileSync(pkg('eviland-rng.ts'), 'utf8'), readFileSync(app('eviland-rng.ts'), 'utf8'));

rmSync(root, { recursive: true, force: true });
console.log('[eviland-core-sync-test] PASS');
