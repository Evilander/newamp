// Server stream audio-path labels must describe the proxy path, not the local
// file fallback path. Run: node scripts/server-audio-path-test.mjs
import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const outDir = resolve('tmp/server-audio-path-test');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [
    resolve('shared/audio-quality.ts'),
    resolve('shared/format-badge.ts'),
  ],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outdir: outDir,
  logLevel: 'silent',
});

const quality = await import(pathToFileURL(resolve(outDir, 'audio-quality.js')).href);
const badges = await import(pathToFileURL(resolve(outDir, 'format-badge.js')).href);

const localWma = {
  path: 'K:/music/archive/legacy.wma',
  bitrate: 192000,
  sampleRate: 44100,
  duration: 180,
  size: 4_320_000,
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
};

assert.equal(quality.playbackCodecLabel(localWma.path), 'WMA->WAV');
assert.equal(quality.classifyAudioQuality(localWma).decodePath, 'ffmpeg-pcm-fallback');
assert.ok(quality.classifyAudioQuality(localWma).flags.includes('FFmpeg PCM playback'));

const serverWma = {
  ...localWma,
  path: 'newamp://server/nav-local/sub%2F1%3F/Folder%20Alpha.wma',
};

const serverSignal = quality.classifyAudioQuality(serverWma);
assert.equal(quality.isMusicServerStreamPath(serverWma.path), true);
assert.equal(quality.playbackCodecLabel(serverWma.path), 'WMA');
assert.equal(serverSignal.decodePath, 'native');
assert.equal(serverSignal.family, 'lossy');
assert.equal(serverSignal.flags.includes('FFmpeg PCM playback'), false);

const localDsdBadge = badges.formatBadgesForTrack({
  path: 'K:/music/dsd/source.dsf',
  bitrate: null,
  sampleRate: 2_822_400,
  duration: 120,
  size: 40_000_000,
});
assert.match(localDsdBadge[0]?.title ?? '', /FFmpeg/);

const serverDsdBadge = badges.formatBadgesForTrack({
  path: 'newamp://server/jf-local/dsd-1/Source.dsf',
  bitrate: null,
  sampleRate: 2_822_400,
  duration: 120,
  size: 40_000_000,
});
assert.equal(serverDsdBadge[0]?.label, 'DSD64');
assert.match(serverDsdBadge[0]?.title ?? '', /not playable in the browser/i);
assert.match(serverDsdBadge[0]?.title ?? '', /conversion.*music server/i);
assert.doesNotMatch(serverDsdBadge[0]?.title ?? '', /FFmpeg/);

console.log('[server-audio-path-test] PASS');
