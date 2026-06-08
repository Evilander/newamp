// Headless proof that the seekable-transcode fix works at the encode layer.
//
// For each ffmpeg-mode source format, transcode a known-duration fixture through
// the SAME recipe as electron/transcode.ts:buildPlaybackFlacArgs and assert the
// resulting FLAC is finalized with a correct, finite STREAMINFO total-samples.
// A finite total-samples is exactly what makes the file byte-range seekable in
// Chromium (the live WAV pipe could never satisfy this -> scrub reset to 0).
//
// This does NOT require Electron/a display. The full Chromium frequency-seek
// proof lives in scripts/playback-seek-smoke.mjs (run on a real machine).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
// Single source of truth for the encode recipe — import the SHIPPED arg builder
// from the compiled electron output so this smoke can never drift from production
// (e.g. the compression_level / RECIPE_TAG tuning). Requires `npm run build:electron`
// first (the smoke:transcode-seek npm script does this).
import { buildPlaybackFlacArgs } from '../dist-electron/electron/transcode.js';

const require = createRequire(import.meta.url);
const FFMPEG = process.env.NEWAMP_FFMPEG_PATH || require('ffmpeg-static');

const DUR = 10; // seconds
const TOL = 0.25; // seconds tolerance on decoded duration

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-800)}`))));
  });
}

// Parse FLAC STREAMINFO total-samples + sample rate from the header (no ffprobe).
function readFlacStreamInfo(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(26);
    const n = readSync(fd, buf, 0, 26, 0);
    if (n < 26) throw new Error('short read');
    if (buf.toString('ascii', 0, 4) !== 'fLaC') throw new Error('not a FLAC file');
    if ((buf[4] & 0x7f) !== 0) throw new Error('first metadata block is not STREAMINFO');
    const packed = buf.readBigUInt64BE(18);
    const sampleRate = Number((packed >> 44n) & 0xfffffn);
    const totalSamples = Number(packed & 0xfffffffffn);
    return { sampleRate, totalSamples };
  } finally {
    closeSync(fd);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'newamp-seek-'));
let failures = 0;

// Source formats that route through the ffmpeg branch (playbackMode === 'ffmpeg').
// Encoders chosen for broad ffmpeg-static availability; one per representative class.
const cases = [
  { ext: 'wma', enc: ['-c:a', 'wmav2', '-b:a', '192k'], label: 'WMA (lossy)' },
  { ext: 'aiff', enc: ['-c:a', 'pcm_s16be'], label: 'AIFF (lossless 16-bit)' },
  { ext: 'wv', enc: ['-c:a', 'wavpack'], label: 'WavPack (lossless)' },
];

console.log(`ffmpeg: ${FFMPEG}`);

for (const c of cases) {
  const src = join(dir, `fixture.${c.ext}`);
  const out = join(dir, `out-${c.ext}.flac`);
  try {
    // Frequency-changing tone so a real Chromium seek test (separate script) can
    // verify position by pitch; here we only need a known duration.
    await run([
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${DUR / 2}`,
      '-f', 'lavfi', '-i', `sine=frequency=880:duration=${DUR / 2}`,
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]',
      ...c.enc, '-y', src,
    ]);
    if (!existsSync(src)) throw new Error('fixture not created');

    await run(buildPlaybackFlacArgs(src, out));
    if (!existsSync(out)) throw new Error('FLAC not produced');

    const { sampleRate, totalSamples } = readFlacStreamInfo(out);
    const decodedDur = totalSamples / sampleRate;
    const ok = sampleRate > 0 && totalSamples > 0 && Math.abs(decodedDur - DUR) <= TOL;
    if (!ok) {
      failures += 1;
      console.error(`  FAIL ${c.label}: sampleRate=${sampleRate} totalSamples=${totalSamples} decodedDur=${decodedDur.toFixed(3)}s (expected ~${DUR}s)`);
    } else {
      console.log(`  PASS ${c.label}: ${sampleRate} Hz, ${totalSamples} samples = ${decodedDur.toFixed(2)}s, STREAMINFO finalized -> seekable`);
    }
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${c.label}: ${err.message}`);
  }
}

rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\ntranscode-seek-smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\ntranscode-seek-smoke: all formats produce finalized, finite-duration (seekable) FLAC. PASS');
