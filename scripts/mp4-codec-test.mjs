// The MP4 codec sniffer behind resolvePlaybackMode: Apple Lossless in .m4a
// routes to ffmpeg and AAC stays native, whether moov sits at the start or
// the end of the file, with a video track ahead of the sound track, and with
// 64-bit and to-end-of-file box sizes. A file that isn't MP4 keeps the
// extension's verdict, the verdict follows the file's size and mtime, and
// the gapless trim only reads AAC files.
// Run: npm run build:electron && node scripts/mp4-codec-test.mjs
import assert from 'node:assert/strict';
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp', 'mp4-codec-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const { mp4SoundCodec, readMoov, soundSampleEntry } = await import(pathToFileURL(resolve('dist-electron/electron/mp4-codec.js')).href);
const { playbackMode, resolvePlaybackMode } = await import(pathToFileURL(resolve('dist-electron/electron/transcode.js')).href);
const { playableLength } = await import(pathToFileURL(resolve('dist-electron/electron/gapless-trim.js')).href);

function encode(name, args) {
  const path = join(root, name);
  const result = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args, path], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${name}: ${result.stderr}`);
  return path;
}

const sine = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'];
// ffmpeg's mov muxer puts moov after mdat unless asked for faststart.
const alac = encode('alac.m4a', [...sine, '-c:a', 'alac']);
const alacFirst = encode('alac-faststart.m4a', [...sine, '-c:a', 'alac', '-movflags', '+faststart']);
const aac = encode('aac.m4a', [...sine, '-c:a', 'aac', '-b:a', '128k']);
const aacFirst = encode('aac-faststart.m4a', [...sine, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']);
const videoFirst = encode('video-first.mp4', [
  '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=2:r=10', ...sine,
  '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-c:a', 'alac', '-shortest',
]);
let flac = null;
try {
  flac = encode('flac.m4a', [...sine, '-c:a', 'flac', '-strict', '-2']);
} catch {
  console.warn('[mp4-codec-test] this ffmpeg cannot mux FLAC into MP4; skipping that case');
}

// --- the sample entry, wherever moov is and whatever comes before the sound track
assert.equal(await mp4SoundCodec(alac), 'alac');
assert.equal(await mp4SoundCodec(alacFirst), 'alac');
assert.equal(await mp4SoundCodec(aac), 'mp4a');
assert.equal(await mp4SoundCodec(aacFirst), 'mp4a');
assert.equal(await mp4SoundCodec(videoFirst), 'alac', 'the video track ahead of the sound track is skipped');
if (flac) assert.equal(await mp4SoundCodec(flac), 'fLaC');

// --- box sizes in the 64-bit form and the to-end-of-file form
{
  const bytes = await readFile(alac);
  const boxes = [];
  for (let at = 0; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(at) || bytes.length - at;
    boxes.push({ type: bytes.toString('latin1', at + 4, at + 8), start: at, size });
    at += size;
  }
  assert.deepEqual(boxes.map((b) => b.type).slice(-2), ['mdat', 'moov'], 'the fixture has moov after mdat');
  const parts = [];
  for (const box of boxes) {
    const body = bytes.subarray(box.start + 8, box.start + box.size);
    if (box.type === 'mdat') {
      const header = Buffer.alloc(16);
      header.writeUInt32BE(1, 0);
      header.write('mdat', 4, 'latin1');
      header.writeBigUInt64BE(BigInt(body.length + 16), 8);
      parts.push(header, body);
    } else if (box.type === 'moov') {
      const header = Buffer.alloc(8);
      header.writeUInt32BE(0, 0);
      header.write('moov', 4, 'latin1');
      parts.push(header, body);
    } else {
      parts.push(bytes.subarray(box.start, box.start + box.size));
    }
  }
  const rewritten = join(root, 'alac-large-boxes.m4a');
  await writeFile(rewritten, Buffer.concat(parts));
  const moov = await readMoov(rewritten);
  assert.ok(moov, 'moov is found past a 64-bit mdat, as the last box with size 0');
  assert.equal(soundSampleEntry(moov), 'alac');
  assert.equal(await mp4SoundCodec(rewritten), 'alac');
}

// --- not an MP4 at all: no verdict, and the protocol handler keeps today's native path
const garbage = join(root, 'garbage.m4a');
await writeFile(garbage, randomBytes(4096));
assert.equal(await mp4SoundCodec(garbage), null);
const tiny = join(root, 'tiny.m4a');
await writeFile(tiny, Buffer.from('abc'));
assert.equal(await mp4SoundCodec(tiny), null);
assert.equal(await mp4SoundCodec(join(root, 'missing.m4a')), null);

// --- routing
assert.equal(playbackMode(alac), 'native', 'by extension alone every .m4a looks native, which is the bug');
assert.equal(await resolvePlaybackMode(alac), 'ffmpeg');
assert.equal(await resolvePlaybackMode(alacFirst), 'ffmpeg');
assert.equal(await resolvePlaybackMode(videoFirst), 'ffmpeg');
assert.equal(await resolvePlaybackMode(aac), 'native');
assert.equal(await resolvePlaybackMode(aacFirst), 'native');
if (flac) assert.equal(await resolvePlaybackMode(flac), 'native');
assert.equal(await resolvePlaybackMode(garbage), 'native');
assert.equal(await resolvePlaybackMode(join(root, 'missing.m4a')), 'native');
assert.equal(await resolvePlaybackMode(join(root, 'song.mp3')), 'native', 'other native formats are not sniffed');
assert.equal(await resolvePlaybackMode(join(root, 'song.ape')), 'ffmpeg');

// --- the verdict is keyed by size and mtime: a file replaced in place is read again
{
  const swapped = join(root, 'swapped.m4a');
  await copyFile(alac, swapped);
  assert.equal(await mp4SoundCodec(swapped), 'alac');
  assert.equal(await mp4SoundCodec(swapped), 'alac');
  await copyFile(aac, swapped);
  const later = new Date(Date.now() + 5000);
  await utimes(swapped, later, later);
  assert.equal(await mp4SoundCodec(swapped), 'mp4a');
}

// --- the gapless trim is AAC's business only
assert.equal(await playableLength(alac), null, 'no AAC priming or padding to trim in an Apple Lossless file');
assert.equal(await playableLength(videoFirst), null);
const trimmed = await playableLength(aac);
assert.ok(trimmed && trimmed.frames > 0 && trimmed.rate === 44100, `an AAC file still reports its playable length (${JSON.stringify(trimmed)})`);

await rm(root, { recursive: true, force: true });
console.log('PASS mp4 codec sniffer');
