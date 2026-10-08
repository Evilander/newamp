import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { algorithmComparisonBase } from './lib/algo-base.mjs';

assert.equal(algorithmComparisonBase([], {}, () => null), 'HEAD');
assert.equal(algorithmComparisonBase([], { CI: 'true' }, () => null), 'HEAD^');
const resolves = (args) => (args[0] === 'rev-parse' ? 'fixture-sha\n' : null);
assert.equal(algorithmComparisonBase([], { CI: 'true', NEWAMP_ALGO_BASE: 'pr-base' }, resolves), 'pr-base');
// A force-push leaves the push's starting commit out of the history: fall back
// to the CI default rather than failing every run on that branch.
assert.equal(
  algorithmComparisonBase([], { CI: 'true', NEWAMP_ALGO_BASE: 'force-pushed-away' }, () => null),
  'HEAD^',
);
assert.equal(algorithmComparisonBase([], { CI: 'true', NEWAMP_ALGO_BASE: '00000', GITHUB_REF_TYPE: 'tag' }, () => 'v1.0.0\n'), 'v1.0.0');

const code = readFileSync(new URL('./algo-version-guard.mjs', import.meta.url), 'utf8').replace(/^import .*\r?\n/gm, '');
function runGuard({ version = 1, baseAvailable = true } = {}) {
  const output = [];
  const read = (path, old = false) => path.includes('memory-types') || path.includes('visual-memory')
    ? `export const VISUAL_MEMORY_ALGO_VERSION = ${old ? 1 : version};`
    : path.includes('randomizer') ? `const ARCHETYPES = [{ gain: ${old ? 1 : 2} }];` : '';
  const sandbox = {
    algorithmComparisonBase, createHash, resolve: (path) => path, existsSync: () => true,
    readFileSync: (path) => read(path),
    execFileSync: (_command, args) => {
      if (args[0] === 'rev-parse') {
        if (args.includes('--verify') && !baseAvailable) throw new Error('missing base');
        return args.includes('--is-inside-work-tree') ? 'true' : 'fixture-sha';
      }
      if (args[0] === 'show') return read(args[1], true);
      throw new Error('Unexpected git fixture command');
    },
    console: { log: (s) => output.push(s), error: (s) => output.push(s) },
    process: { argv: ['node', 'guard'], env: { CI: 'true' }, exit: (status) => { throw { status }; } },
  };
  try { vm.runInNewContext(code, sandbox, { timeout: 1000 }); } catch (error) {
    if ('status' in error) return { status: error.status, output: output.join('\n') };
    throw error;
  }
  throw new Error('Guard did not exit');
}
assert.equal(runGuard().status, 1, 'clean CI algorithm change without version bump must fail');
assert.equal(runGuard({ version: 2 }).status, 0);
assert.match(runGuard({ baseAvailable: false }).output, /unavailable/);
console.log('PASS CI algorithm baseline detects committed changes and fails closed on missing history');
