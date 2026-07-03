import assert from 'node:assert/strict';
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner } from '../dist-electron/electron/scanner.js';
import { RadioBrain } from '../dist-electron/electron/radio-brain.js';

if (!ffmpeg) throw new Error('ffmpeg-static did not resolve a binary');

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'radio-brain-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const fixtures = [
  { name: 'alpha-tone.flac', synth: 'sine=frequency=400:duration=2', title: 'Alpha', codec: 'flac' },
  { name: 'beta-tone.flac', synth: 'sine=frequency=800:duration=2', title: 'Beta', codec: 'flac' },
  { name: 'gamma-noise.flac', synth: 'anoisesrc=color=pink:duration=2:amplitude=0.3', title: 'Gamma', codec: 'flac' },
];

for (const fixture of fixtures) {
  const out = join(musicRoot, fixture.name);
  runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', fixture.synth,
    '-metadata', `title=${fixture.title}`,
    '-metadata', 'artist=Radio Brain',
    '-metadata', 'album=Brain Test',
    '-c:a', 'flac',
    out,
  ]);
  assert.ok(existsSync(out));
}

const library = await LibraryStore.open(dbPath);
const scanner = new Scanner(library, () => undefined);
await scanner.start([musicRoot]);
const tracks = library.getTracks({ limit: 100, sort: 'artist' });
assert.equal(tracks.length, fixtures.length);

// Save a Living Tag rule so /tag/<name>.m3u has something to serve.
library.saveTagRule({ name: 'all_alpha', body: 'tag(all_alpha) when title = "Alpha"' });
library.recomputeTags();
const tagSummaries = library.getTagSummaries();
assert.ok(tagSummaries.some((s) => s.name === 'all_alpha' && s.trackCount === 1));

const port = pickFreePort();
const SMOKE_TOKEN = 'radio-brain-smoke-token';
const brain = new RadioBrain({
  library,
  port,
  // Use a stub transcoder for the smoke — real path tested in transcode-smoke.
  transcode: (path) => {
    const buffer = Buffer.from(`stub-wav:${path}`);
    return new Response(buffer, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
  },
  ffmpegFallbackExt: () => false,
  getToken: () => SMOKE_TOKEN,
  getNowPlaying: () => null,
  onNowPlaying: () => () => undefined,
  control: () => true,
});
const startStatus = await brain.start();
assert.equal(startStatus.enabled, true, `radio brain should start (error: ${startStatus.error ?? '<none>'})`);
assert.ok(startStatus.baseUrl?.startsWith('http://'), 'status should expose baseUrl');
assert.ok(startStatus.endpoints.includes('/library.m3u'));

const base = `http://127.0.0.1:${port}`;

// HTML status page
const unauthorized = await fetch(`${base}/`);
assert.equal(unauthorized.status, 401, 'routes must 401 without the token');
const statusRes = await fetch(`${base}/?token=${SMOKE_TOKEN}`);
assert.equal(statusRes.status, 200);
assert.match(statusRes.headers.get('content-type') ?? '', /text\/html/);
const statusBody = await statusRes.text();
assert.match(statusBody, /NewAmp Radio Brain/);
assert.match(statusBody, /all_alpha/);

// library.m3u
const libRes = await fetch(`${base}/library.m3u?token=${SMOKE_TOKEN}`);
assert.equal(libRes.status, 200);
assert.match(libRes.headers.get('content-type') ?? '', /audio\/x-mpegurl/);
const libBody = await libRes.text();
assert.match(libBody, /^#EXTM3U/);
const audioLines = libBody.split('\n').filter((l) => l.startsWith(`${base}/audio/`));
assert.equal(audioLines.length, fixtures.length, 'every track should appear in /library.m3u');

// random.m3u
const randomRes = await fetch(`${base}/random.m3u?token=${SMOKE_TOKEN}`);
const randomBody = await randomRes.text();
const randomLines = randomBody.split('\n').filter((l) => l.startsWith(`${base}/audio/`));
assert.equal(randomLines.length, fixtures.length, 'random playlist should include every track at small sizes');

// tag/<name>.m3u
const tagRes = await fetch(`${base}/tag/all_alpha.m3u?token=${SMOKE_TOKEN}`);
assert.equal(tagRes.status, 200);
const tagBody = await tagRes.text();
const tagLines = tagBody.split('\n').filter((l) => l.startsWith(`${base}/audio/`));
assert.equal(tagLines.length, 1, 'tag playlist should include the single all_alpha track');

// audio endpoint: streams the file via the stubbed transcode path when ffmpegFallbackExt returns false (raw stream)
const alphaId = tracks.find((t) => t.title === 'Alpha').id;
const audioRes = await fetch(`${base}/audio/${alphaId}?token=${SMOKE_TOKEN}`);
assert.equal(audioRes.status, 200);
assert.match(audioRes.headers.get('content-type') ?? '', /audio\/flac/);
const audioBytes = new Uint8Array(await audioRes.arrayBuffer());
assert.ok(audioBytes.length > 100, 'audio stream should have meaningful bytes');

// 404 paths
const missingRes = await fetch(`${base}/nope?token=${SMOKE_TOKEN}`);
assert.equal(missingRes.status, 404);
const missingTrackRes = await fetch(`${base}/audio/9999999?token=${SMOKE_TOKEN}`);
assert.equal(missingTrackRes.status, 404);

// Method not allowed
const postRes = await fetch(`${base}/library.m3u?token=${SMOKE_TOKEN}`, { method: 'POST' });
assert.equal(postRes.status, 405);

const stopStatus = await brain.stop();
assert.equal(stopStatus.enabled, false);

library.close();

const [radioBrainSource, mainSource, typesSource, settingsSource, preloadSource, apiSource] = await Promise.all([
  readFile(new URL('../electron/radio-brain.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/settings.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
]);

assert.match(radioBrainSource, /class RadioBrain/);
assert.match(radioBrainSource, /library\.m3u/);
assert.match(mainSource, /radio-brain:status/, 'main process should register radio brain IPC');
assert.match(mainSource, /syncRadioBrain/);
assert.match(typesSource, /radioBrainEnabled/);
assert.match(typesSource, /RadioBrainStatus/);
assert.match(settingsSource, /radioBrainEnabled/);
assert.match(settingsSource, /radioBrainPort/);
assert.match(preloadSource, /getRadioBrainStatus/);
assert.match(apiSource, /getRadioBrainStatus/);

console.log(JSON.stringify({
  ok: true,
  port,
  endpoints: startStatus.endpoints,
  libraryPlaylistLines: audioLines.length,
  tagPlaylistLines: tagLines.length,
}, null, 2));

function runFfmpeg(args) {
  const result = spawnSync(ffmpeg, args, { stdio: 'pipe' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr?.toString?.() ?? '');
    throw new Error(`ffmpeg failed: ${args.join(' ')}`);
  }
}

function pickFreePort() {
  // 17118..17128 — the configurable default is 17117, so the smoke uses
  // the next slot to avoid collisions with a user-enabled instance.
  return 17118 + Math.floor(Math.random() * 10);
}
