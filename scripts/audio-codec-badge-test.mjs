// An .m4a can hold Apple Lossless or AAC, so the extension cannot say which.
// The badge used to call every .m4a "AAC" and file it as lossy, and Library
// Health counted ALAC libraries as compressed. Now the scan stores the codec
// the file reports and everything that classifies a track uses it:
//  - with no codec on record, an .m4a gets a neutral container chip, never
//    "AAC" and never a lossy claim;
//  - ALAC (by name or by the codec's lossless flag) is lossless and badged
//    ALAC, including hi-res; AAC stays lossy and badged AAC;
//  - the same holds for .m4b, .mp4 and .mka;
//  - a codec string never overrides an extension that is already decisive
//    (an .mp3 is lossy whatever its tags say, an .ogg keeps its OGG label);
//  - quality: search filters follow the stored flag.
// Run: node scripts/audio-codec-badge-test.mjs
import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const outDir = resolve('tmp/audio-codec-badge-test');
mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [resolve('shared/audio-quality.ts'), resolve('shared/format-badge.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outdir: outDir,
  logLevel: 'silent',
});
const quality = await import(pathToFileURL(resolve(outDir, 'audio-quality.js')).href);
const badges = await import(pathToFileURL(resolve(outDir, 'format-badge.js')).href);

const base = { bitrate: 900_000, sampleRate: 44_100, duration: 200, size: 20_000_000 };
const verbose = { verbose: true };
const labels = (list) => list.map((badge) => `${badge.kind}:${badge.label}`);

// 1. No codec on record: neutral, never AAC, never lossy.
{
  const unknown = { ...base, path: '/music/x.m4a' };
  const signal = quality.classifyAudioQuality(unknown);
  assert.equal(signal.family, 'container');
  assert.equal(signal.isLossless, false);
  for (const options of [{}, verbose, { density: 'comfortable' }]) {
    const list = badges.formatBadgesForTrack(unknown, options);
    assert.ok(!list.some((badge) => badge.kind === 'lossy'), `no lossy claim for ${JSON.stringify(options)}`);
    assert.ok(!list.some((badge) => badge.label === 'AAC'), `no AAC claim for ${JSON.stringify(options)}`);
    assert.ok(!list.some((badge) => /lossy/i.test(badge.title)), `no lossy wording for ${JSON.stringify(options)}`);
  }
  assert.deepEqual(labels(badges.formatBadgesForTrack(unknown, verbose)), ['container:M4A', 'container:900']);
  assert.deepEqual(badges.formatBadgesForTrack(unknown), [], 'compact rows say nothing until the codec is known');
  // The bitrate chip no longer implies quality either way.
  const lowRate = badges.formatBadgesForTrack({ ...unknown, bitrate: 128_000 }, verbose);
  assert.ok(lowRate.every((badge) => badge.tone === 'muted'));

  // An empty codec means "read, none named": still neutral.
  assert.equal(quality.classifyAudioQuality({ ...unknown, codec: '' }).family, 'container');
  assert.equal(quality.classifyAudioQuality({ ...unknown, codec: null, codecLossless: null }).family, 'container');
  // A codec name nothing here recognises settles nothing.
  assert.equal(quality.classifyAudioQuality({ ...unknown, codec: 'MP4S' }).family, 'container');
}

// 2. ALAC.
{
  const byName = { ...base, path: '/music/alac.m4a', codec: 'ALAC' };
  const byFlag = { ...base, path: '/music/alac.m4a', codec: 'whatever', codecLossless: true };
  for (const track of [byName, byFlag, { ...byName, codecLossless: true }]) {
    const signal = quality.classifyAudioQuality(track);
    assert.equal(signal.family, 'lossless');
    assert.equal(signal.isLossless, true);
    assert.equal(signal.isLowBitrate, false);
    assert.ok(!signal.flags.includes('Unclassified codec'));
  }
  assert.deepEqual(labels(badges.formatBadgesForTrack(byName)), ['lossless:ALAC']);
  assert.deepEqual(labels(badges.formatBadgesForTrack(byName, verbose)), ['lossless:ALAC']);
  assert.match(badges.formatBadgesForTrack(byName)[0].title, /ALAC.*lossless/);
  assert.equal(badges.formatBadgesForTrack(byFlag)[0].kind, 'lossless');

  const hires = { ...byName, sampleRate: 96_000, bitsPerSample: 24 };
  assert.equal(quality.classifyAudioQuality(hires).isHiRes, true);
  assert.deepEqual(labels(badges.formatBadgesForTrack(hires)), ['lossless:ALAC', 'hires:24/96']);
  assert.deepEqual(labels(badges.formatBadgesForTrack({ ...hires, bitsPerSample: null })), ['lossless:ALAC', 'hires:96k']);
  assert.equal(quality.classifyAudioQuality({ ...byName, sampleRate: 44_100 }).isHiRes, false);

  // Chromium cannot demux ALAC, so it plays through the FFmpeg PCM path.
  assert.equal(quality.classifyAudioQuality(byName).decodePath, 'ffmpeg-pcm-fallback');
  assert.ok(quality.classifyAudioQuality(byName).flags.includes('FFmpeg PCM playback'));
  assert.equal(
    quality.classifyAudioQuality({ ...byName, path: 'newamp://server/nav/alac-1/Track.m4a' }).decodePath,
    'native',
    'a server stream arrives already converted',
  );

  for (const ext of ['m4b', 'mp4', 'mka']) {
    const track = { ...base, path: `/music/book.${ext}`, codec: 'ALAC' };
    assert.equal(quality.classifyAudioQuality(track).family, 'lossless', ext);
  }
  assert.equal(quality.classifyAudioQuality({ ...base, path: '/music/a.mka', codec: 'FLAC' }).family, 'lossless');
}

// 3. AAC stays lossy.
{
  const aac = { ...base, bitrate: 256_000, path: '/music/aac.m4a', codec: 'MPEG-4/AAC', codecLossless: false };
  for (const track of [aac, { ...aac, codecLossless: null }, { ...aac, codec: 'mp4a' }, { ...aac, codec: '', codecLossless: false }]) {
    const signal = quality.classifyAudioQuality(track);
    assert.equal(signal.family, 'lossy');
    assert.equal(signal.isLossless, false);
  }
  assert.equal(quality.classifyAudioQuality({ ...aac, bitrate: 128_000 }).isLowBitrate, true);
  assert.equal(quality.classifyAudioQuality(aac).decodePath, 'native');
  const list = badges.formatBadgesForTrack(aac, verbose);
  assert.deepEqual(labels(list), ['lossy:AAC', 'lossy:256']);
  assert.match(list[0].title, /AAC.*lossy/);
  // Compact rows keep their old rule: a plain 256 chip is skipped.
  assert.deepEqual(badges.formatBadgesForTrack(aac), []);
  assert.deepEqual(labels(badges.formatBadgesForTrack({ ...aac, bitrate: 320_000 })), ['lossy:320']);
  assert.equal(quality.classifyAudioQuality({ ...aac, codec: 'MPEG 1 Layer 3', path: '/music/x.mka' }).family, 'lossy');
}

// 4. A decisive extension is not overridden.
{
  assert.equal(quality.classifyAudioQuality({ ...base, path: '/music/a.mp3', codec: 'ALAC', codecLossless: true }).family, 'lossy');
  assert.equal(quality.classifyAudioQuality({ ...base, path: '/music/a.flac', codec: 'MPEG-4/AAC', codecLossless: false }).family, 'lossless');
  assert.deepEqual(
    labels(badges.formatBadgesForTrack({ ...base, bitrate: 160_000, path: '/music/a.ogg', codec: 'Vorbis I' }, verbose)),
    ['lossy:OGG', 'lossy:160'],
  );
  assert.deepEqual(
    labels(badges.formatBadgesForTrack({ ...base, path: '/music/a.flac', codec: 'FLAC', codecLossless: true })),
    ['lossless:FLAC'],
  );
  assert.deepEqual(
    labels(badges.formatBadgesForTrack({ ...base, path: '/music/a.aif' })),
    ['lossless:AIFF'],
  );
}

// 5. The lossless/lossy decision on its own.
{
  const family = quality.codecFamilyFromCodec;
  assert.equal(family('ALAC'), 'lossless');
  assert.equal(family('FLAC'), 'lossless');
  assert.equal(family('MPEG-4/AAC'), 'lossy');
  assert.equal(family('Opus'), 'lossy');
  assert.equal(family('MPEG 1 Layer 3'), 'lossy');
  assert.equal(family('AAC', true), 'lossless', 'the file\'s own flag wins');
  assert.equal(family('ALAC', false), 'lossy');
  assert.equal(family(''), null);
  assert.equal(family(null), null);
  assert.equal(family('MP4S'), null);
  // "pcm" inside ADPCM and "mpeg" inside MPEG-4 ALS point the wrong way.
  assert.equal(family('IMA ADPCM'), 'lossy');
  assert.equal(family('MS ADPCM'), 'lossy');
  assert.equal(family('PCM'), 'lossless');
  assert.equal(family('A_PCM/INT/LIT'), 'lossless');
  assert.equal(family('MPEG-4 ALS'), 'lossless');
  assert.equal(family('MPEG-4/AAC'), 'lossy');
  assert.equal(family('ALS'), 'lossless');
  assert.equal(quality.classifyAudioQuality({ ...base, path: '/music/x.mka', codec: 'ADPCM' }).isLossless, false);
}

// 6. Which containers play through FFmpeg: whatever Chromium's MP4 demuxer
// lacks, not only Apple Lossless (electron/mp4-codec.ts decides by sample entry).
{
  const route = (codec, path = '/music/x.m4a') => quality.classifyAudioQuality({ ...base, path, codec }).decodePath;
  for (const codec of ['ALAC', 'AC-3', 'uLaw 2:1', 'MP4S', 'ALAC+MPEG-4/AAC']) {
    assert.equal(route(codec), 'ffmpeg-pcm-fallback', codec);
  }
  for (const codec of ['MPEG-4/AAC', 'MPEG-1 layer 3', 'MPEG 1 Layer 3', 'FLAC', 'Opus', 'MPEG-4/AAC+ALAC', '', null]) {
    assert.equal(route(codec), 'native', String(codec));
  }
  assert.equal(route('AC-3', '/music/x.mp4'), 'ffmpeg-pcm-fallback');
  assert.equal(route('AC-3', '/music/x.m4b'), 'ffmpeg-pcm-fallback');
  assert.equal(route('AC-3', '/music/x.mp3'), 'native', 'a decisive extension is not second-guessed');
  assert.equal(route('AC-3', 'newamp://server/nav/ac3-1/Track.m4a'), 'native', 'a server stream arrives already converted');
  assert.equal(quality.containerCodecNeedsFfmpeg(undefined), false);
  assert.ok(quality.classifyAudioQuality({ ...base, path: '/music/x.m4a', codec: 'AC-3' }).flags.includes('FFmpeg PCM playback'));
}

console.log('[audio-codec-badge-test] PASS');
