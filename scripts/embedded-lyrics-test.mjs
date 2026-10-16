// Lyrics the audio file itself carries are found when lyrics are asked for:
// ID3 USLT and SYLT, Vorbis LYRICS and UNSYNCEDLYRICS, MP4 lyr. A sidecar still
// wins, timed lyrics beat plain ones, and a file with none answers null. The
// files are real ones made by ffmpeg (plus hand-built ID3 frames, which ffmpeg
// cannot write), read by the real tag parser.
// Run: node scripts/embedded-lyrics-test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve('tmp/embedded-lyrics-test');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const bundlePath = join(root, 'local-lyrics.mjs');
await build({
  entryPoints: [resolve('electron/local-lyrics.ts')],
  bundle: true, packages: 'external', format: 'esm', platform: 'node', target: 'es2022',
  outfile: bundlePath, logLevel: 'silent',
});
const { findLocalLyricsForTrack, findSidecarLyricsForTrack, findEmbeddedLyricsForTrack } = await import(pathToFileURL(bundlePath).href);

function encode(args, out) {
  const result = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', ...args, out], { encoding: 'utf8' });
  assert.equal(result.status, 0, `ffmpeg ${args.join(' ')}: ${result.stderr}`);
}
const lyricsTag = (value, key = 'lyrics') => ['-metadata', `${key}=${value}`];
const track = (path, extra = {}) => ({ path, artist: 'Artist', title: 'Song', album: 'Album', ...extra });

// ---- ID3v2.3 frames, built by hand ----
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const frame = (id, body) => Buffer.concat([Buffer.from(id, 'latin1'), u32(body.length), Buffer.alloc(2), body]);
const cstr = (text) => Buffer.concat([Buffer.from(text, 'latin1'), Buffer.from([0])]);
const uslt = (text) => frame('USLT', Buffer.concat([Buffer.from([0]), Buffer.from('eng'), cstr(''), Buffer.from(text, 'latin1')]));
const sylt = (entries) => frame('SYLT', Buffer.concat([
  Buffer.from([0]), Buffer.from('eng'), Buffer.from([2, 1]), cstr(''),
  ...entries.flatMap(([text, ms]) => [cstr(text), u32(ms)]),
]));
function withId3(frames, mpegPath, out) {
  const body = Buffer.concat(frames);
  const size = Buffer.from([(body.length >> 21) & 0x7f, (body.length >> 14) & 0x7f, (body.length >> 7) & 0x7f, body.length & 0x7f]);
  writeFileSync(out, Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), size, body, readFileSync(mpegPath)]));
}

const bareMp3 = join(root, 'bare.mp3');
encode(['-c:a', 'libmp3lame', '-write_id3v2', '0', '-write_xing', '0'], bareMp3);

const plainText = 'First verse line\nSecond verse line';
const lrcText = '[00:01.00]First synced line\n[00:04.50]Second synced line';

const files = {
  flacPlain: join(root, 'flac-plain.flac'),
  flacLrc: join(root, 'flac-lrc.flac'),
  flacUnsynced: join(root, 'flac-unsynced.flac'),
  m4a: join(root, 'plain.m4a'),
  none: join(root, 'none.flac'),
  mp3Plain: join(root, 'mp3-plain.mp3'),
  mp3Lrc: join(root, 'mp3-lrc.mp3'),
  mp3Sylt: join(root, 'mp3-sylt.mp3'),
  mp3Both: join(root, 'mp3-both.mp3'),
  garbage: join(root, 'garbage.mp3'),
};
encode([...lyricsTag(plainText), '-c:a', 'flac'], files.flacPlain);
encode([...lyricsTag(lrcText), '-c:a', 'flac'], files.flacLrc);
encode([...lyricsTag(plainText, 'UNSYNCEDLYRICS'), '-c:a', 'flac'], files.flacUnsynced);
encode([...lyricsTag(plainText), '-c:a', 'aac'], files.m4a);
encode([...lyricsTag('Song', 'title'), '-c:a', 'flac'], files.none);
withId3([uslt(plainText.replace(/\n/g, '\r\n'))], bareMp3, files.mp3Plain);
withId3([uslt(lrcText)], bareMp3, files.mp3Lrc);
withId3([sylt([['First synced line', 1000], ['Second synced line', 4500], ['Past the hour mark', 3_725_250]])], bareMp3, files.mp3Sylt);
withId3([uslt(plainText), sylt([['Timed one', 2000]])], bareMp3, files.mp3Both);
writeFileSync(files.garbage, 'this is not an audio file');

// ---- plain lyrics, per container ----
for (const [label, path] of [['Vorbis LYRICS', files.flacPlain], ['Vorbis UNSYNCEDLYRICS', files.flacUnsynced], ['MP4 lyr', files.m4a], ['ID3 USLT', files.mp3Plain]]) {
  const found = await findLocalLyricsForTrack(track(path));
  assert.ok(found, `${label}: embedded lyrics are found`);
  assert.equal(found.plainLyrics?.replace(/\r\n/g, '\n'), plainText, `${label}: the text comes through`);
  assert.equal(found.syncedLyrics, null, `${label}: plain stays plain`);
  assert.equal(found.path, path, `${label}: the path is the audio file`);
}

// ---- timed lyrics ----
{
  const flac = await findLocalLyricsForTrack(track(files.flacLrc));
  assert.equal(flac?.syncedLyrics, '[00:01.00]First synced line\n[00:04.50]Second synced line', 'Vorbis LYRICS holding LRC is timed');
  assert.equal(flac?.plainLyrics, null);

  const usltLrc = await findLocalLyricsForTrack(track(files.mp3Lrc));
  assert.equal(usltLrc?.syncedLyrics, lrcText, 'LRC lines in a USLT frame are timed');
  assert.equal(usltLrc?.plainLyrics, null);

  const syltOnly = await findLocalLyricsForTrack(track(files.mp3Sylt));
  assert.equal(
    syltOnly?.syncedLyrics,
    '[00:01.00]First synced line\n[00:04.50]Second synced line\n[62:05.25]Past the hour mark',
    'SYLT milliseconds become LRC stamps',
  );

  const both = await findLocalLyricsForTrack(track(files.mp3Both));
  assert.equal(both?.syncedLyrics, '[00:02.00]Timed one', 'timed lyrics beat plain ones in the same file');
  assert.equal(both?.plainLyrics, null);
}

// ---- nothing embedded, nothing readable ----
assert.equal(await findLocalLyricsForTrack(track(files.none)), null, 'a file with no lyrics answers null');
assert.equal(await findLocalLyricsForTrack(track(files.garbage)), null, 'a file that is not audio answers null');
assert.equal(await findLocalLyricsForTrack(track(join(root, 'missing.flac'))), null, 'a missing file answers null');
assert.equal(await findEmbeddedLyricsForTrack({ path: '' }), null);

// ---- a sidecar next to the file still comes first ----
{
  assert.equal(await findSidecarLyricsForTrack(track(files.flacPlain)), null, 'the sidecar finder alone ignores the tags');
  writeFileSync(join(root, 'flac-plain.lrc'), '[00:02.00]From the sidecar\n');
  const found = await findLocalLyricsForTrack(track(files.flacPlain));
  assert.equal(found?.syncedLyrics?.includes('From the sidecar'), true, 'the sidecar wins over the tag');
  assert.equal(found?.path, join(root, 'flac-plain.lrc'));
}

// ---- retagging is noticed; an untouched file is not read twice ----
{
  const path = join(root, 'retag.flac');
  encode([...lyricsTag('Old words'), '-c:a', 'flac'], path);
  assert.equal((await findLocalLyricsForTrack(track(path)))?.plainLyrics, 'Old words');
  encode([...lyricsTag('New words and some more'), '-c:a', 'flac'], path);
  const later = new Date(Date.now() + 60_000);
  utimesSync(path, later, later);
  assert.equal((await findLocalLyricsForTrack(track(path)))?.plainLyrics, 'New words and some more', 'a changed file is read again');

  const first = await findEmbeddedLyricsForTrack(track(path));
  const second = await findEmbeddedLyricsForTrack(track(path));
  assert.equal(first, second, 'the second ask is served from memory');
}

// ---- the renderer asks local lyrics before the network, and this is what it asks ----
{
  const main = readFileSync(resolve('electron/main.ts'), 'utf8');
  assert.match(main, /find(Local|Sidecar)LyricsForTrack\(track\)/, 'the lyrics:local handler calls the finder');
  const now = readFileSync(resolve('src/components/views/NowPlayingView.tsx'), 'utf8');
  assert.match(now, /api\.getLocalLyrics\(current\.id\)/, 'Now Playing asks for local lyrics first');
}

console.log('PASS embedded lyrics: Vorbis, MP4 and ID3 (USLT and SYLT) read on demand, sidecar first, timed first, cached by file state');
