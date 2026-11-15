// A newamp:// request must not turn a network share's hiccup into "file not
// found" or "forbidden", and must not touch the share more than it has to.
// Drives the real authorizeAudioProtocolPath() with stubbed fs calls.
// Run: node scripts/audio-protocol-authorize-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const buildDir = resolve(root, 'tmp', 'a1-protocol-authorize-build');
await rm(buildDir, { recursive: true, force: true });
await mkdir(buildDir, { recursive: true });
await build({
  entryPoints: [
    resolve(root, 'electron/audio-protocol-authorize.ts'),
    resolve(root, 'electron/audio-path-policy.ts'),
    resolve(root, 'electron/cache-key-casing.ts'),
    resolve(root, 'electron/read-failure.ts'),
  ],
  outdir: buildDir,
  platform: 'node',
  format: 'esm',
  bundle: false,
});
// The default retry is read-failure's retryStorageErrors; this budget keeps the
// run short while still letting it make its first pause of a second.
process.env.NEWAMP_READ_OUTAGE_MS = '500';
const { authorizeAudioProtocolPath } = await import(pathToFileURL(resolve(buildDir, 'audio-protocol-authorize.js')).href);

const source = await readFile(resolve(root, 'electron/audio-protocol-authorize.ts'), 'utf8');
assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), /existsSync/, 'the request path makes no synchronous existence check');

const errno = (code) => Object.assign(new Error(code), { code });
const urlFor = (path) => new URL(`newamp://track/${encodeURIComponent(path)}`);
const track = resolve('/music/Artist/song.flac');
const noSleep = async () => {};

const deps = (extra = {}) => {
  const calls = [];
  return {
    calls,
    deps: {
      libraryRoots: [resolve('/music')],
      openedFiles: new Set(),
      getPodcastDownloadsRealRoot: async () => null,
      getTracksByPaths: () => ({ length: 0 }),
      realpath: async (path) => {
        calls.push(path);
        return path;
      },
      sleep: noSleep,
      ...extra,
    },
  };
};

// A library track is settled by its row alone: no fs call at all.
{
  const { deps: d, calls } = deps({ getTracksByPaths: () => ({ length: 1 }) });
  const result = await authorizeAudioProtocolPath(urlFor(track), d);
  assert.deepEqual(result, { ok: true, filePath: track, real: track });
  assert.deepEqual(calls, [], 'a known library track costs the share nothing');
}

// A file under a library root that is not a track yet is resolved, with the
// root's own realpath asked once and then remembered.
{
  let now = 1_000;
  const { deps: d, calls } = deps({ now: () => now });
  const first = await authorizeAudioProtocolPath(urlFor(track), d);
  assert.equal(first.ok, true);
  assert.equal(calls.filter((path) => path === resolve('/music')).length, 1);
  now += 5_000;
  const second = await authorizeAudioProtocolPath(urlFor(track), d);
  assert.equal(second.ok, true);
  assert.equal(calls.filter((path) => path === resolve('/music')).length, 1, 'the root is not resolved again for the next request');
  now += 120_000;
  await authorizeAudioProtocolPath(urlFor(track), d);
  assert.equal(calls.filter((path) => path === resolve('/music')).length, 2, 'it is looked at again after a minute');
}

// A file that is not there is a 404.
{
  const { deps: d } = deps({ realpath: async () => { throw errno('ENOENT'); } });
  assert.deepEqual(await authorizeAudioProtocolPath(urlFor(track), d), { ok: false, status: 404 });
}

// A share that times out is waited for, not reported missing: the file's
// realpath goes through the retry it is given, which here records each try.
{
  let attempts = 0;
  let retried = 0;
  const { deps: d } = deps({
    realpath: async (path) => {
      if (path === track && ++attempts < 3) throw errno('ETIMEDOUT');
      return path;
    },
    retry: async (op) => {
      for (;;) {
        try {
          return await op();
        } catch (err) {
          if (err.code !== 'ETIMEDOUT') throw err;
          retried++;
        }
      }
    },
  });
  const result = await authorizeAudioProtocolPath(urlFor(track), d);
  assert.equal(result.ok, true, 'two timeouts and then an answer still authorizes');
  assert.equal(attempts, 3);
  assert.equal(retried, 2, 'the file went through the retry');
}

// With the real retry (no stub): a timeout that clears on the second try
// authorizes, ENOENT and ENOTDIR answer 404 at once, and a share that outlasts
// the outage budget answers 503.
{
  let attempts = 0;
  const { deps: d } = deps({
    realpath: async (path) => {
      if (path === track && ++attempts < 2) throw errno('ETIMEDOUT');
      return path;
    },
  });
  assert.equal((await authorizeAudioProtocolPath(urlFor(track), d)).ok, true, 'a timeout that clears is waited out');
  assert.equal(attempts, 2);
}
for (const code of ['ENOENT', 'ENOTDIR']) {
  let attempts = 0;
  const { deps: d } = deps({ realpath: async () => { attempts++; throw errno(code); } });
  assert.deepEqual(await authorizeAudioProtocolPath(urlFor(track), d), { ok: false, status: 404 }, code);
  assert.equal(attempts, 1, `${code} is not retried`);
}
{
  const { deps: d } = deps({ realpath: async () => { throw errno('EIO'); } });
  assert.deepEqual(await authorizeAudioProtocolPath(urlFor(track), d), { ok: false, status: 503 }, 'a share that stays away is not "not found"');
}

// A share that stays away is a 503, whichever storage error it gives.
for (const code of ['ETIMEDOUT', 'EIO', 'ESTALE']) {
  const { deps: d } = deps({
    realpath: async () => { throw errno(code); },
    retry: (op) => op(),
  });
  assert.deepEqual(await authorizeAudioProtocolPath(urlFor(track), d), { ok: false, status: 503 }, `${code} is not "not found"`);
}

// A refusal stays final when the roots could be resolved.
{
  const { deps: d } = deps({ libraryRoots: [resolve('/music')], openedFiles: new Set() });
  const outside = resolve('/etc/passwd');
  assert.deepEqual(await authorizeAudioProtocolPath(urlFor(outside), d), { ok: false, status: 403 });
}

// A root whose share timed out is not a reason to forbid a file under it
// (the library row is not there yet), nor to allow one that is not.
{
  const { deps: d } = deps({
    realpath: async (path) => {
      if (path === resolve('/music')) throw errno('ETIMEDOUT');
      return path;
    },
    // The file is opened as a real path, so phase one passes through the
    // opened-files list, and phase two needs the roots only if that misses.
    openedFiles: new Set(),
  });
  const result = await authorizeAudioProtocolPath(urlFor(track), d);
  assert.deepEqual(result, { ok: false, status: 503 }, 'the file may belong to the root that did not answer');
}

// The path is still checked on strings before any fs call.
{
  const { deps: d, calls } = deps({ libraryRoots: [], getTracksByPaths: undefined });
  const result = await authorizeAudioProtocolPath(urlFor('//evilhost/share/file.flac'), d);
  assert.deepEqual(result, { ok: false, status: 403 });
  assert.deepEqual(calls, [], 'a refused path makes no fs call');
}

await rm(buildDir, { recursive: true, force: true });
console.log('PASS newamp:// authorization: no sync fs, storage errors are retried and answer 503, library tracks cost no fs call, roots are remembered');
