import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const {
  checkLastfmLiveProof,
  resolveLastfmCredentials,
} = await import('./lastfm-live-proof.mjs');

const smokeRoot = resolve('tmp', 'lastfm-live-proof-smoke');
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const proofPath = join(smokeRoot, 'lastfm-live-proof.json');
const artifacts = [
  { name: 'installer', path: join(smokeRoot, 'Newamp Setup 1.0.0.exe') },
  { name: 'portable', path: join(smokeRoot, 'Newamp Portable 1.0.0.exe') },
  { name: 'exe', path: join(smokeRoot, 'Newamp.exe') },
];
await Promise.all(artifacts.map((artifact, index) => writeFile(artifact.path, `artifact-${index}`, 'utf8')));

const missing = checkLastfmLiveProof({ proofPath, artifacts });
assert.equal(missing.ok, false);
assert.match(missing.reason, /missing/i);

const proofArtifacts = Object.fromEntries(artifacts.map((artifact) => [artifact.name, {
  name: artifact.name,
  path: artifact.path,
  exists: true,
  bytes: Buffer.byteLength(`artifact-${artifacts.indexOf(artifact)}`),
  sha256: sha256Text(`artifact-${artifacts.indexOf(artifact)}`),
}]));
await writeFile(proofPath, JSON.stringify({
  schemaVersion: 1,
  app: 'Newamp',
  createdAt: new Date().toISOString(),
  platform: process.platform,
  username: 'newamp-smoke-user',
  credentialSources: {
    apiKey: 'env:NEWAMP_LASTFM_API_KEY',
    sharedSecret: 'env:NEWAMP_LASTFM_SHARED_SECRET',
  },
  authTokenSha256: sha256Text('auth-token'),
  sessionKeySha256: sha256Text('session-key'),
  nowPlaying: {
    ok: true,
    method: 'track.updateNowPlaying',
    track: {
      artist: 'Newamp QA',
      title: 'Live Service Readiness Probe',
      album: 'Newamp Release Gate',
      albumArtist: 'Newamp QA',
      duration: 181,
      trackNumber: 1,
    },
  },
  artifacts: proofArtifacts,
}, null, 2), 'utf8');

const valid = checkLastfmLiveProof({ proofPath, artifacts });
assert.equal(valid.ok, true, valid.reason);
assert.equal(valid.username, 'newamp-smoke-user');

const credentials = resolveLastfmCredentials({
  env: {
    NEWAMP_LASTFM_API_KEY: 'api-key',
    NEWAMP_LASTFM_SHARED_SECRET: 'shared-secret',
  },
  settingsPaths: [],
});
assert.equal(credentials.apiKey, 'api-key');
assert.equal(credentials.sharedSecret, 'shared-secret');
assert.equal(credentials.sources.apiKey, 'env:NEWAMP_LASTFM_API_KEY');
assert.equal(credentials.sources.sharedSecret, 'env:NEWAMP_LASTFM_SHARED_SECRET');

const [packageSource, gateSource, readmeSource, liveProofSource] = await Promise.all([
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('./release-gate.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
  readFile(new URL('./lastfm-live-proof.mjs', import.meta.url), 'utf8'),
]);

assert.match(packageSource, /smoke:lastfm-live-proof/, 'package scripts should expose Last.fm live proof smoke');
assert.match(packageSource, /release:start-lastfm-proof/, 'package scripts should expose Last.fm proof starter');
assert.match(packageSource, /release:record-lastfm-proof/, 'package scripts should expose Last.fm proof recorder');
assert.match(packageSource, /release:check-lastfm-proof/, 'package scripts should expose Last.fm proof checker');
assert.match(gateSource, /smoke:lastfm-live-proof/, 'release gate should run Last.fm live proof helper smoke');
assert.match(readmeSource, /release:start-lastfm-proof/, 'README should document Last.fm live proof flow');
assert.doesNotMatch(liveProofSource, /writeFileSync\([^)]*sharedSecret/, 'proof writer must not write the raw shared secret');
assert.match(liveProofSource, /sessionKeySha256/, 'proof should hash the session key instead of storing it');

console.log(JSON.stringify({
  ok: true,
  proofPath,
  username: valid.username,
  artifactCount: artifacts.length,
}, null, 2));

function sha256Text(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').toUpperCase();
}
