// newamp://track/ URLs must round-trip a local file path exactly, on every
// platform, regardless of what characters the path contains.
//
// Security: the protocol handler's allowlist decision must be made
// on pure strings, before any fs call (existsSync, realpath, stat). On
// Windows, calling any of those on an unvalidated UNC path (\\host\share,
// //host/share — arriving literally, percent-encoded, or via a multi-slash
// pathname) opens an SMB session to that host and can leak the user's NTLM
// hash, regardless of what the allowlist decides afterward — the fs touch
// alone is the leak, not just a wrong verdict.
//
// This drives the ACTUAL encoder in electron/preload.ts (extracted from the
// real source text — it's a contextBridge callback, not an exported
// function) and the ACTUAL authorizeAudioProtocolPath() in
// electron/audio-protocol-authorize.ts, imported for real after an esbuild
// transpile of that file and its two pure dependencies (no bundling, no
// Electron needed — none of the three touch Electron APIs). A regression in
// any of preload.ts, main.ts's use of it, or audio-protocol-authorize.ts
// fails this test. Pure string/path-resolution proof — nothing here touches
// a real file, network share, or UNC path; existsSync/realpath are spies.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const preloadSource = await readFile(resolve(root, 'electron/preload.ts'), 'utf8');

// --- Extract the real toAudioUrl encoder body -------------------------------
const encoderStart = preloadSource.indexOf("contextBridge.exposeInMainWorld('toAudioUrl'");
assert.notEqual(encoderStart, -1, 'toAudioUrl registration not found in electron/preload.ts');
const encoderText = preloadSource.slice(encoderStart);
const encoderBodyStart = encoderText.indexOf('=> {') + 4;
const encoderBodyEnd = encoderText.indexOf('\n});');
assert.ok(encoderBodyStart > 3 && encoderBodyEnd > encoderBodyStart, 'could not isolate toAudioUrl body');
const encode = new Function('filePath', encoderText.slice(encoderBodyStart, encoderBodyEnd));
assert.match(encoderText.slice(encoderBodyStart, encoderBodyEnd), /encodeURIComponent\(normalized\)/,
  'toAudioUrl must encode the whole path as one opaque component');

// --- Import the real authorizeAudioProtocolPath -----------------------------
// electron/audio-protocol-authorize.ts and its two dependencies (audio-
// path-policy.ts, cache-key-casing.ts) touch nothing but node:fs/path — no
// Electron import, so they transpile and run standalone. Deliberately not
// going through `tsc -p electron/tsconfig.json` here: that project-wide
// build can be red from unrelated in-progress work elsewhere in electron/,
// which would block this test from ever proving anything about files it
// doesn't touch.
const buildDir = resolve(root, 'tmp', 'audio-protocol-authorize-build');
await rm(buildDir, { recursive: true, force: true });
await mkdir(buildDir, { recursive: true });
await build({
  entryPoints: [
    resolve(root, 'electron/audio-protocol-authorize.ts'),
    resolve(root, 'electron/audio-path-policy.ts'),
    resolve(root, 'electron/cache-key-casing.ts'),
  ],
  outdir: buildDir,
  platform: 'node',
  format: 'esm',
  bundle: false,
});
const { authorizeAudioProtocolPath } = await import(
  pathToFileURL(resolve(buildDir, 'audio-protocol-authorize.js')).href
);

// --- Round-trip cases: encode with the real encoder, authorize with the
// real function (deps configured to permit everything, via a stub library
// lookup — authorization policy has its own dedicated cases below), and
// assert the recovered, resolved path is exactly what plain path.resolve()
// would produce from the original input. ------------------------------------
const permissiveDeps = () => {
  const calls = [];
  return {
    calls,
    deps: {
      libraryRoots: [],
      openedFiles: new Set(),
      getPodcastDownloadsRealRoot: async () => null,
      getTracksByPaths: () => ({ length: 1 }), // pretend every path is a known library track
      existsSync: (p) => { calls.push(['existsSync', p]); return true; },
      realpath: async (p) => { calls.push(['realpath', p]); return p; },
    },
  };
};

const roundTripCases = [
  { name: 'POSIX absolute', path: '/home/tyler/Music/Track.flac' },
  { name: 'Windows drive (backslash input)', path: 'K:\\Music\\Artist\\Track.flac' },
  { name: 'UNC share', path: '\\\\nas\\share\\Music\\Track.flac' },
  { name: 'spaces', path: '/home/tyler/My Music/Track One.flac' },
  { name: 'unicode', path: '/home/tyler/Música/Ünïcode Track.flac' },
  { name: 'percent sign', path: '/home/tyler/50% Off.flac' },
  { name: 'question mark', path: '/home/tyler/what?.flac' },
  { name: 'hash', path: '/home/tyler/track#1.flac' },
];

for (const { name, path } of roundTripCases) {
  const normalized = path.replace(/\\/g, '/');
  const url = encode(path);
  assert.match(url, /^newamp:\/\/track\/[^/]+$/, `${name}: URL must be a single opaque path segment (${url})`);
  const { deps } = permissiveDeps();
  const result = await authorizeAudioProtocolPath(new URL(url), deps);
  assert.ok(result.ok, `${name}: must authorize under permissive deps (${JSON.stringify(result)})`);
  assert.equal(result.filePath, resolve(normalized), `${name}: decoded+resolved path must match path.resolve() of the original`);
}

// --- Backward compatibility: URLs built by the old encodeURI-based encoder
// must still resolve. Windows-drive URLs happened to work before (a drive
// letter never starts with "/", so the old encoder never produced a leading
// double slash for them); this proves that's still true. The handler's
// regex fix (strip exactly one leading slash, not one-or-more) also
// retroactively repairs the old encoder's POSIX form, whose double slash
// used to collapse an absolute path into a relative one. -------------------
{
  const { deps } = permissiveDeps();
  const result = await authorizeAudioProtocolPath(new URL('newamp://track/K:/Music/Legacy.mp3'), deps);
  assert.ok(result.ok, 'a pre-existing Windows-style newamp:// URL must still authorize');
  assert.equal(result.filePath, resolve('K:/Music/Legacy.mp3'));
}
{
  const { deps } = permissiveDeps();
  const result = await authorizeAudioProtocolPath(new URL('newamp://track//home/tyler/legacy.flac'), deps);
  assert.ok(result.ok, 'a pre-existing double-slash POSIX newamp:// URL must now authorize as an absolute path');
  assert.equal(result.filePath, resolve('/home/tyler/legacy.flac'));
}

console.log('PASS newamp://track URL round-trip (%d cases + 2 backward-compat checks)', roundTripCases.length);

// --- The allowlist decision must happen before any fs call, and a UNC
// candidate must only pass by exactly matching an already-configured
// allowlist string, never by being resolved against the real filesystem. --
const denyDeps = (extra = {}) => {
  const calls = [];
  return {
    calls,
    deps: {
      libraryRoots: [],
      openedFiles: new Set(),
      getPodcastDownloadsRealRoot: async () => null,
      // No getTracksByPaths at all — matches a real "library DB not open
      // yet" request, the least favorable case for an attacker.
      existsSync: (p) => { calls.push(['existsSync', p]); return true; },
      realpath: async (p) => { calls.push(['realpath', p]); return p; },
      ...extra,
    },
  };
};

const unauthorizedUncRequests = [
  { name: 'backslash-encoded UNC', url: 'newamp://track/%5C%5Cevilhost%5Cshare%5Cfile.flac' },
  { name: 'forward-slash-encoded UNC', url: 'newamp://track/%2F%2Fevilhost%2Fshare%2Ffile.flac' },
  { name: 'literal multi-slash UNC pathname', url: 'newamp://track///evilhost/share/file.flac' },
];

for (const { name, url } of unauthorizedUncRequests) {
  const { deps, calls } = denyDeps();
  const result = await authorizeAudioProtocolPath(new URL(url), deps);
  assert.deepEqual(result, { ok: false, status: 403 }, `${name}: must be rejected (${JSON.stringify(result)})`);
  assert.deepEqual(calls, [], `${name}: must make ZERO fs calls before rejecting — an SMB session to the named host is the leak, not just a wrong verdict`);
}

// A UNC share the user actually configured as a library root must still
// work — the gate is "exactly matches the allowlist", not "deny all UNC".
{
  const configuredRoot = '//trusted-nas/music';
  const { deps, calls } = denyDeps({ libraryRoots: [configuredRoot] });
  const result = await authorizeAudioProtocolPath(new URL('newamp://track/%2F%2Ftrusted-nas%2Fmusic%2Ftrack.flac'), deps);
  assert.ok(result.ok, `a UNC path under a configured library root must authorize (${JSON.stringify(result)})`);
  assert.ok(calls.length > 0, 'a legitimately-allowed path is expected to reach existsSync/realpath');
}

// A UNC path that is NOT under the configured root (same host, different
// share) must still be denied before any fs call — proves this isn't a
// naive "does it contain a known substring" match.
{
  const configuredRoot = '//trusted-nas/music';
  const { deps, calls } = denyDeps({ libraryRoots: [configuredRoot] });
  const result = await authorizeAudioProtocolPath(new URL('newamp://track/%2F%2Ftrusted-nas%2Fother-share%2Ffile.flac'), deps);
  assert.deepEqual(result, { ok: false, status: 403 }, `a sibling share on a trusted host must still be denied (${JSON.stringify(result)})`);
  assert.deepEqual(calls, [], 'a sibling share must make zero fs calls before rejecting');
}

// A file the user opened through a symlink or junction (macOS /tmp is
// /private/tmp) is requested by the path it was opened as. The first check
// compares that path as written, so main must register it alongside the real
// path; registering only the real path turns the request into a 403.
{
  const openedAs = resolve('tmp', 'opened-through-link', 'song.flac');
  const real = resolve('tmp', 'real-location', 'song.flac');
  const url = new URL(`newamp://track/${encodeURIComponent(openedAs.replace(/\\/g, '/'))}`);
  const realpathOf = async (p) => (resolve(p) === openedAs ? real : p);
  const key = (p) => p.replace(/\\/g, '/');
  const onlyReal = await authorizeAudioProtocolPath(url, denyDeps({
    openedFiles: new Set([key(real)]),
    realpath: realpathOf,
  }).deps);
  assert.deepEqual(onlyReal, { ok: false, status: 403 }, 'registering only the real path refuses a file opened through a link');
  const both = await authorizeAudioProtocolPath(url, denyDeps({
    openedFiles: new Set([key(openedAs), key(real)]),
    realpath: realpathOf,
  }).deps);
  assert.ok(both.ok, `a file opened through a link must play once both spellings are registered (${JSON.stringify(both)})`);
  const mainSource = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  assert.match(mainSource, /openedAudioFiles\.add\(resolve\(path\)/, 'main must register the path a file was opened as');
}

console.log('PASS newamp:// UNC requests are allowlist-checked before any fs call (%d denied + 2 allowlist-boundary cases), and files opened through a link authorize', unauthorizedUncRequests.length);
