import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repoRoot = resolve('.');
const source = await readFile(new URL('./completion-audit.mjs', import.meta.url), 'utf8');

assert.match(source, /localOk/, 'completion audit should report local readiness separately');
assert.match(source, /publicReleaseOk/, 'completion audit should report public release readiness separately');
assert.match(source, /blockerGroups/, 'completion audit should group blockers by actionability');
assert.match(source, /publicationReadinessBlockerClass/, 'publication readiness blockers should be classified');

const result = spawnSync(process.execPath, ['scripts/completion-audit.mjs', '--allow-incomplete'], {
  cwd: repoRoot,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 45_000,
});

assert.equal(result.status, 0, result.stderr || result.stdout);
const report = JSON.parse(result.stdout);

assert.equal(report.ok, false, 'public release should remain blocked without external proofs');
assert.equal(report.publicReleaseOk, false, 'publicReleaseOk should stay false while publication blockers remain');
assert.equal(typeof report.localOk, 'boolean', 'localOk should be a first-class boolean');
assert.ok(Array.isArray(report.blockerGroups?.local), 'local blocker group should be present');
assert.ok(Array.isArray(report.blockerGroups?.external), 'external blocker group should be present');
assert.ok(
  report.blockerGroups.local.some((blocker) => blocker.includes('large-local-library-proof')),
  'audit without --real-library should classify missing fresh library proof as local evidence',
);
assert.ok(
  report.blockerGroups.external.some((blocker) =>
    blocker.includes('publication readiness/github-auth') || blocker.includes('publication readiness/signed-artifacts'),
  ),
  'nested publication readiness blockers should split credential/signing failures into the external group',
);
assert.ok(
  report.blockerGroups.external.some((blocker) => blocker.includes('manual listening proof')),
  'manual listening proof should be grouped as external',
);
assert.match(
  report.conclusion,
  /remaining local blockers|Local product\/readiness evidence is complete/,
  'conclusion should explain whether local work remains or only public-release proof remains',
);

console.log(JSON.stringify({
  ok: true,
  localOk: report.localOk,
  publicReleaseOk: report.publicReleaseOk,
  localBlockers: report.blockerGroups.local.length,
  externalBlockers: report.blockerGroups.external.length,
}, null, 2));
