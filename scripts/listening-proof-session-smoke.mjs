import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repoRoot = resolve('.');
const result = spawnSync(
  process.execPath,
  ['scripts/listening-proof-session.mjs', '--dry-run'],
  {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  },
);

assert.equal(result.status, 0, result.stderr || result.stdout);
const report = JSON.parse(result.stdout);
assert.equal(report.name, 'listening-proof-session');
assert.equal(report.ok, true);
assert.equal(report.dryRun, true);
assert.equal(report.launch.executed, false);
assert.equal(report.launch.ready, true);
assert.match(report.launch.exePath, /NewAmp\.exe$/);
assert.ok(Array.isArray(report.launch.args) && report.launch.args[0]?.endsWith('newamp-speaker-proof.mp3'));
assert.ok(report.proofFile.ok, 'speaker proof file should be prepared');
assert.ok(report.checklist.length >= 4, 'listening checklist should include the release proof steps');
assert.match(report.recordCommand, /confirm-playback/);
assert.match(report.recordCommand, /confirm-output-switching/);
assert.match(report.recordCommand, /confirm-crossfade/);
assert.match(report.recordCommand, /confirm-gapless/);

const [packageSource, gateSource, featuresSource] = await Promise.all([
  readFile('package.json', 'utf8'),
  readFile('scripts/release-gate.mjs', 'utf8'),
  readFile('docs/features.md', 'utf8'),
]);

assert.match(packageSource, /smoke:listening-proof-session/, 'package scripts should expose listening proof session smoke');
assert.match(packageSource, /release:start-listening-proof/, 'package scripts should expose listening proof session launcher');
assert.match(gateSource, /smoke:listening-proof-session/, 'release gate should cover the listening proof session helper');
assert.match(featuresSource, /release:start-listening-proof/, 'the features doc should document the listening proof helper for maintainers');

console.log(JSON.stringify({
  ok: true,
  proofFile: report.proofFile.path,
  recordCommand: report.recordCommand,
}, null, 2));
