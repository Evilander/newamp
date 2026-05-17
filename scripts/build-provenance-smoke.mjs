import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repoRoot = resolve('.');
const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
const fixtureVersion = String(pkg.version);
const smokeRoot = join(repoRoot, 'tmp', 'build-provenance-smoke');
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(join(smokeRoot, 'release', 'win-unpacked'), { recursive: true });
await writeFile(join(smokeRoot, 'package.json'), JSON.stringify({ name: 'newamp', version: fixtureVersion }), 'utf8');
await writeFile(join(smokeRoot, 'release', `NewAmp Setup ${fixtureVersion}.exe`), 'installer', 'utf8');
await writeFile(join(smokeRoot, 'release', `NewAmp Portable ${fixtureVersion}.exe`), 'portable', 'utf8');
await writeFile(join(smokeRoot, 'release', 'win-unpacked', 'NewAmp.exe'), 'exe', 'utf8');

const {
  buildProvenance,
  buildProvenancePath,
  checkBuildProvenance,
  writeBuildProvenance,
} = await import('./build-provenance.mjs');

const path = buildProvenancePath({ root: smokeRoot });
assert.match(path, /BUILD-PROVENANCE\.json$/);

const missing = checkBuildProvenance({ root: smokeRoot, version: fixtureVersion });
assert.equal(missing.ok, false, 'missing provenance should fail');
assert.match(missing.reason, /missing/i);

const planned = buildProvenance({ root: smokeRoot, version: fixtureVersion, now: new Date('2026-01-01T00:00:00.000Z') });
assert.equal(planned.name, 'newamp-build-provenance');
assert.equal(planned.version, fixtureVersion);
assert.equal(planned.artifacts.length, 3);
assert.ok(planned.artifacts.every((artifact) => artifact.sha256), 'all artifacts should be fingerprinted');

const written = writeBuildProvenance({ root: smokeRoot, version: fixtureVersion, now: new Date('2026-01-01T00:00:00.000Z') });
assert.equal(written.ok, true, written.reason);

await writeFile(join(smokeRoot, 'release', `NewAmp Portable ${fixtureVersion}.exe`), 'portable changed', 'utf8');
const stale = checkBuildProvenance({ root: smokeRoot, version: fixtureVersion });
assert.equal(stale.ok, false, 'mutating an artifact should stale provenance');
assert.ok(stale.artifactMismatches.some((item) => item.name === 'portable' && item.field === 'sha256'));

console.log(JSON.stringify({
  ok: true,
  path,
  staleReason: stale.reason,
}, null, 2));
