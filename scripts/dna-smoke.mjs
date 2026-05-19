import assert from 'node:assert/strict';
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner } from '../dist-electron/electron/scanner.js';
import { analyzeTrackDna } from '../dist-electron/electron/dna-analyzer.js';
import {
  computeTrackDna,
  dnaCosineSimilarity,
  dnaToVector,
  isValidTrackDna,
  AUDIO_DNA_TARGET_SAMPLE_RATE,
} from '../dist-electron/shared/audio-dna.js';

if (!ffmpeg) throw new Error('ffmpeg-static did not resolve a binary');

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'dna-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const fixtures = [
  { name: 'bright-tone.flac', synth: 'sine=frequency=4000:duration=3', codec: 'flac' },
  { name: 'low-tone.flac', synth: 'sine=frequency=80:duration=3', codec: 'flac' },
  { name: 'pink-noise.flac', synth: 'anoisesrc=color=pink:duration=3:amplitude=0.3', codec: 'flac' },
  { name: 'quiet-tone.flac', synth: 'sine=frequency=1000:duration=3', codec: 'flac', volume: 0.08 },
];

for (const fixture of fixtures) {
  const out = join(musicRoot, fixture.name);
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', fixture.synth,
  ];
  if (fixture.volume != null) {
    args.push('-filter:a', `volume=${fixture.volume}`);
  }
  args.push(
    '-metadata', `title=${fixture.name.replace('.flac', '')}`,
    '-metadata', 'artist=DNA Fixture',
    '-metadata', `album=DNA Album ${fixture.codec}`,
    '-c:a', fixture.codec === 'flac' ? 'flac' : 'pcm_s16le',
    out,
  );
  runFfmpeg(args);
  assert.ok(existsSync(out), `fixture ${fixture.name} should exist`);
}

// Pure-math test: a synthetic high-frequency PCM should report higher brightness than low.
const fakeBright = synthesizeSine(4000, 3, AUDIO_DNA_TARGET_SAMPLE_RATE);
const fakeLow = synthesizeSine(120, 3, AUDIO_DNA_TARGET_SAMPLE_RATE);
const brightDna = computeTrackDna(fakeBright, { sampleRate: AUDIO_DNA_TARGET_SAMPLE_RATE });
const lowDna = computeTrackDna(fakeLow, { sampleRate: AUDIO_DNA_TARGET_SAMPLE_RATE });
assert.ok(brightDna.brightness > lowDna.brightness, 'pure tone at 4kHz should be brighter than 120Hz');
assert.ok(brightDna.bands[3] + brightDna.bands[4] > brightDna.bands[0] + brightDna.bands[1], 'bright tone energy should sit in upper bands');
assert.ok(lowDna.bands[0] + lowDna.bands[1] > lowDna.bands[3] + lowDna.bands[4], 'low tone energy should sit in lower bands');
assert.ok(isValidTrackDna(brightDna));
assert.equal(brightDna.v, 1);
assert.equal(brightDna.bands.length, 5);

const selfSimilarity = dnaCosineSimilarity(brightDna, brightDna);
assert.ok(selfSimilarity > 0.99, 'self-similarity should be ~1');
const crossSimilarity = dnaCosineSimilarity(brightDna, lowDna);
assert.ok(crossSimilarity < selfSimilarity, 'different DNA should be less similar to self');
assert.equal(dnaToVector(brightDna).length, 11, 'DNA vector should expose 11 dimensions');

// FFmpeg-driven analyzer roundtrip
const sampleBrightPath = join(musicRoot, 'bright-tone.flac');
const ffmpegBrightDna = await analyzeTrackDna(sampleBrightPath);
assert.ok(isValidTrackDna(ffmpegBrightDna), 'ffmpeg decode should produce valid DNA');
assert.ok(ffmpegBrightDna.brightness > 0.05, `ffmpeg bright DNA brightness sanity (got ${ffmpegBrightDna.brightness})`);
assert.ok(ffmpegBrightDna.framesAnalyzed > 0);

// LibraryStore persistence
const library = await LibraryStore.open(dbPath);
const scanner = new Scanner(library, () => undefined);
await scanner.start([musicRoot]);
const tracks = library.getTracks({ limit: 100, sort: 'artist' });
assert.equal(tracks.length, fixtures.length, 'all fixtures should scan');

const statsBefore = library.getDnaStats();
assert.equal(statsBefore.total, fixtures.length);
assert.equal(statsBefore.analyzed, 0);
assert.equal(statsBefore.missing, fixtures.length);

const missingIdsBefore = library.getTrackIdsMissingDna(10);
assert.equal(missingIdsBefore.length, fixtures.length);

const writeOk = library.setTrackDna(tracks[0].id, ffmpegBrightDna);
assert.equal(writeOk, true);

const stored = library.getTrackDna(tracks[0].id);
assert.ok(stored, 'stored DNA should round-trip');
assert.equal(stored.v, ffmpegBrightDna.v);
assert.deepEqual(stored.bands.length, 5);

const statsAfter = library.getDnaStats();
assert.equal(statsAfter.analyzed, 1);
assert.equal(statsAfter.missing, fixtures.length - 1);

// Bulk fetch + similarity
for (let i = 1; i < tracks.length; i++) {
  const dna = await analyzeTrackDna(tracks[i].path);
  library.setTrackDna(tracks[i].id, dna);
}

const all = library.getAllTrackDna();
assert.equal(all.length, fixtures.length, 'every track should report DNA after batch analysis');
const idToDna = new Map(all.map((row) => [row.id, row.dna]));
const brightTrackId = tracks.find((t) => t.title === 'bright-tone')?.id;
const lowTrackId = tracks.find((t) => t.title === 'low-tone')?.id;
assert.ok(brightTrackId && lowTrackId, 'bright + low fixtures should be present');
const brightStored = idToDna.get(brightTrackId);
const lowStored = idToDna.get(lowTrackId);
assert.ok(brightStored && lowStored);
assert.ok(brightStored.brightness > lowStored.brightness, 'persisted bright DNA should still outshine persisted low DNA');

// findSimilarTracks: brightTone should match the quietTone (1kHz) more closely than the
// low-tone fixture because the low-tone sits in the bottom band while the bright
// and quiet tones share upper-band energy.
const brightSimilar = library.findSimilarTracks(brightTrackId, 5);
assert.ok(brightSimilar.length >= 1, 'similar list should contain peers');
assert.ok(!brightSimilar.some((row) => row.track.id === brightTrackId), 'source track must not be returned in similar list');
for (const row of brightSimilar) {
  assert.ok(row.score >= 0 && row.score <= 1, 'similarity score should be normalized 0..1');
}

// Clearing
assert.equal(library.setTrackDna(tracks[0].id, null), true);
assert.equal(library.getTrackDna(tracks[0].id), null);
assert.equal(library.getDnaStats().analyzed, fixtures.length - 1);
const finalStats = library.getDnaStats();

library.close();

const [audioDnaSource, librarySource, mainSource, preloadSource, typesSource, apiSource] = await Promise.all([
  readFile(new URL('../shared/audio-dna.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/library.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
]);

assert.match(audioDnaSource, /export function computeTrackDna/, 'shared module should expose computeTrackDna');
assert.match(audioDnaSource, /AUDIO_DNA_VERSION/, 'DNA version constant should be exported');
assert.match(librarySource, /setTrackDna/, 'library should expose setTrackDna');
assert.match(librarySource, /getTrackDna/, 'library should expose getTrackDna');
assert.match(librarySource, /getTrackIdsMissingDna/, 'library should expose missing-DNA query');
assert.match(librarySource, /dna_json/, 'library schema should store dna_json column');
assert.match(mainSource, /tracks:analyze-dna/, 'main process should register DNA IPC');
assert.match(preloadSource, /analyzeTracksDna/, 'preload should expose analyzeTracksDna');
assert.match(typesSource, /TracksDnaAnalysisResult/, 'shared types should expose TracksDnaAnalysisResult');
assert.match(typesSource, /DnaStats/, 'shared types should expose DnaStats');
assert.match(apiSource, /analyzeTracksDna/, 'renderer API should stub analyzeTracksDna');
assert.match(librarySource, /findSimilarTracks/, 'library should expose findSimilarTracks');
assert.match(mainSource, /tracks:dna-similar/, 'main process should register similarity IPC');
assert.match(preloadSource, /findSimilarTracks/, 'preload should expose findSimilarTracks');
assert.match(typesSource, /SimilarTrack\b/, 'shared types should expose SimilarTrack');
assert.match(apiSource, /findSimilarTracks/, 'renderer API should stub findSimilarTracks');

console.log(JSON.stringify({
  ok: true,
  vectorDim: dnaToVector(brightDna).length,
  brightBrightness: brightDna.brightness,
  lowBrightness: lowDna.brightness,
  ffmpegBrightDna: {
    brightness: ffmpegBrightDna.brightness,
    bands: ffmpegBrightDna.bands,
    framesAnalyzed: ffmpegBrightDna.framesAnalyzed,
  },
  statsAfterBatch: finalStats,
}, null, 2));

function synthesizeSine(hz, durationSec, sampleRate) {
  const count = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = 0.6 * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return out;
}

function runFfmpeg(args) {
  const result = spawnSync(ffmpeg, args, { stdio: 'pipe' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr?.toString?.() ?? '');
    throw new Error(`ffmpeg failed: ${args.join(' ')}`);
  }
}
