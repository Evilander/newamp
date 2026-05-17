import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const {
  checkManualListeningProof,
  defaultManualListeningArtifacts,
  recordManualListeningProof,
  summarizeManualListeningProof,
} = await import('./manual-listening-proof.mjs');

const repoRoot = resolve('.');
const smokeRoot = join(repoRoot, 'tmp', 'manual-listening-proof-smoke');
const proofPath = join(smokeRoot, 'manual-listening-proof.json');
assert.deepEqual(defaultManualListeningArtifacts(repoRoot).map((artifact) => artifact.name), [
  'installer',
  'portable',
  'exe',
  'checksums',
  'source',
  'manifest',
  'bundle',
]);

const artifacts = [
  { name: 'installer', path: join(smokeRoot, 'NewAmp Setup 0.1.0.exe') },
  { name: 'portable', path: join(smokeRoot, 'NewAmp Portable 0.1.0.exe') },
  { name: 'exe', path: join(smokeRoot, 'NewAmp.exe') },
];

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });
await Promise.all(artifacts.map((artifact, index) => writeFile(artifact.path, `newamp-artifact-${index}`, 'utf8')));

const missing = checkManualListeningProof({ proofPath, artifacts });
assert.equal(missing.ok, false);
assert.match(missing.reason, /missing/i);

const recorded = recordManualListeningProof({
  proofPath,
  artifacts,
  confirmations: {
    playback: true,
    outputSwitching: true,
    crossfade: true,
    gapless: true,
  },
  notes: 'Smoke proof only.',
});
assert.equal(recorded.ok, true, summarizeManualListeningProof(recorded));
assert.equal(recorded.missingConfirmations.length, 0);
assert.equal(recorded.mismatchedArtifacts.length, 0);

await writeFile(artifacts[1].path, 'portable-mutated-after-proof', 'utf8');
const stale = checkManualListeningProof({ proofPath, artifacts });
assert.equal(stale.ok, false);
assert.deepEqual(stale.mismatchedArtifacts, ['portable']);
assert.match(summarizeManualListeningProof(stale), /portable/);

assert.throws(
  () => recordManualListeningProof({
    proofPath,
    artifacts,
    confirmations: {
      playback: true,
      outputSwitching: false,
      crossfade: true,
      gapless: true,
    },
  }),
  /outputSwitching/,
);

console.log(JSON.stringify({
  ok: true,
  recordedAt: recorded.createdAt,
  staleReason: stale.reason,
}, null, 2));
