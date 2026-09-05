import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const script = resolve('scripts/library-scale-bench.mjs');
const args = [script, '--tracks', '100', '--batchSize', '100', '--pageSize', '10'];
for (const cleanAfter of [false, true]) {
  const result = spawnSync(process.execPath, [...args, ...(cleanAfter ? ['--clean-after'] : [])], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, NEWAMP_SCALE_CLEAN_AFTER: '0' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.row_counts.stats.tracks, 100);
  assert.equal(existsSync(report.paths.reportPath), !cleanAfter);
  if (!cleanAfter) {
    assert.deepEqual(JSON.parse(readFileSync(report.paths.reportPath, 'utf8')), report);
    rmSync(dirname(report.paths.reportPath), { recursive: true, force: true });
  }
}
// A fresh checkout should give the actionable build message, not ESM's import error.
const missing = mkdtempSync(join(tmpdir(), 'newamp-bench-missing-'));
try {
  mkdirSync(join(missing, 'scripts'));
  const copy = join(missing, 'scripts', 'library-scale-bench.mjs');
  copyFileSync(script, copy);
  const result = spawnSync(process.execPath, [copy, '--tracks', '100'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /run npm run build:electron first/);
  assert.equal(existsSync(join(missing, 'tmp')), false, 'missing build must not create an abandoned benchmark directory');
} finally { rmSync(missing, { recursive: true, force: true }); }
console.log('PASS benchmark reports, cleanup, missing-build guidance');
