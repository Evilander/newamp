// What a scan now reads and keeps, through the real Scanner and real files, and
// the backfill that gives rows scanned before those tags were stored their values:
//  - ALBUMARTIST is stored as the file wrote it (NULL when it wrote none) beside
//    album_artist, which keeps its old meaning; the compilation flag, sort
//    names, disc and track totals, disc subtitle, release group and original
//    year are stored too;
//  - a scan ends with the albums grouped (a flagged compilation is one album);
//  - the backfill reads only unchanged files, fills just those columns, can be
//    stopped and picked up again, waits while playback is short of audio, and
//    never holds the thread for long;
//  - a changed file stays queued for the next scan, and a file that will not
//    parse is marked done so it is not tried on every launch.
// Run: npm run build:electron && node scripts/album-identity-scan-test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner, readTagExtras } from '../dist-electron/electron/scanner.js';
import { runTagBackfill } from '../dist-electron/electron/album-identity-backfill.js';
import { reportPlaybackHunger } from '../dist-electron/electron/playback-io.js';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const root = resolve('tmp/album-identity-scan-test');
const music = join(root, 'music');
await rm(root, { recursive: true, force: true });
await mkdir(music, { recursive: true });

function encode(tags, out) {
  const meta = Object.entries(tags).flatMap(([key, value]) => ['-metadata', `${key}=${value}`]);
  const result = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', ...meta, '-c:a', 'flac', out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
async function folder(...parts) {
  const dir = join(music, ...parts);
  await mkdir(dir, { recursive: true });
  return dir;
}

// 1. Fixtures: a flagged compilation with no album artist, a record with a
//    real album artist and a guest, a flagged record that has one, a two-disc
//    release, and a record carrying every extra tag.
const comp = await folder('Cover Versions');
['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].forEach((artist, i) => {
  encode({ title: `Cover ${i + 1}`, artist, album: 'Cover Versions', track: i + 1, COMPILATION: 1 }, join(comp, `${i + 1}.flac`));
});
const band = await folder('Real Band', 'Record');
['Real Band', 'Real Band', 'Real Band', 'Real Band feat. Guest'].forEach((artist, i) => {
  encode({ title: `Song ${i + 1}`, artist, album: 'Record', album_artist: 'Real Band', track: i + 1 }, join(band, `${i + 1}.flac`));
});
const neil = await folder('Neil', 'Archives');
[1, 2, 3].forEach((n) => {
  encode({ title: `Archive ${n}`, artist: n === 2 ? 'Neil Young & Crazy Horse' : 'Neil Young', album: 'Archives', album_artist: 'Neil Young Archives', COMPILATION: 1, track: n }, join(neil, `${n}.flac`));
});
const cd1 = await folder('Box', 'CD1');
const cd2 = await folder('Box', 'CD2');
encode({ title: 'One', artist: 'Boxer', album: 'Box', disc: '1/2', DISCSUBTITLE: 'First', track: '1/9' }, join(cd1, '1.flac'));
encode({ title: 'Two', artist: 'Boxer', album: 'Box', disc: '2/2', DISCSUBTITLE: 'Second', track: '1/9' }, join(cd2, '1.flac'));
const rich = await folder('Rich');
encode({
  title: 'Rich', artist: 'The Rich Band', album: 'Rich', album_artist: 'The Rich Band', ALBUMARTISTSORT: 'Rich Band, The', ARTISTSORT: 'Rich Band, The',
  MUSICBRAINZ_RELEASEGROUPID: '55555555-5555-5555-5555-555555555555', ORIGINALYEAR: 1977, date: 1999, track: '3/12',
}, join(rich, '1.flac'));

// 2. The scan stores the tags and ends with the albums grouped.
const library = await LibraryStore.open(join(root, 'library.db'));
let last = null;
const scanner = new Scanner(library, (p) => { if (p.done) last = p; });
await scanner.start([music]);
assert.equal(last.parsed, 5 + 4 + 3 + 2 + 1);
const row = (path) => library.db.exec(`SELECT album_artist, album_artist_tag, compilation, album_artist_sort, artist_sort, disc_total, track_total, disc_subtitle, mb_release_group_id, original_year, scan_schema, disc_no FROM tracks WHERE path = '${path.replace(/'/g, "''")}'`)[0].values[0];
{
  const [aa, tag, cmp, aas, as, discTotal, trackTotal, subtitle, mbg, oy, schema] = row(join(comp, '1.flac'));
  assert.equal(aa, 'Alpha', 'album_artist keeps its old meaning: the track artist when the file named none');
  assert.equal(tag, null, 'and the tag column says the file named none');
  assert.equal(cmp, 1);
  assert.equal(schema, 1);
  assert.deepEqual([aas, as, discTotal, trackTotal, subtitle, mbg, oy], [null, null, null, null, null, null, null]);
}
{
  const [aa, tag, cmp] = row(join(band, '4.flac'));
  assert.equal(aa, 'Real Band');
  assert.equal(tag, 'Real Band');
  assert.equal(cmp, 0);
}
{
  const [, tag, cmp] = row(join(neil, '1.flac'));
  assert.equal(tag, 'Neil Young Archives');
  assert.equal(cmp, 1);
}
{
  const [, , , , , discTotal, trackTotal, subtitle, , , , discNo] = row(join(cd2, '1.flac'));
  assert.deepEqual([discTotal, trackTotal, subtitle, discNo], [2, 9, 'Second', 2]);
}
{
  const [, tag, , aas, as, , trackTotal, , mbg, oy] = row(join(rich, '1.flac'));
  assert.equal(tag, 'The Rich Band');
  assert.equal(aas, 'Rich Band, The');
  assert.equal(as, 'Rich Band, The');
  assert.equal(trackTotal, 12);
  assert.equal(mbg, '55555555-5555-5555-5555-555555555555');
  assert.equal(oy, 1977);
}
const albums = () => library.getAlbums({ limit: 100, sort: 'album' });
assert.equal(albums().length, 5);
const cover = albums().find((a) => a.album === 'Cover Versions');
assert.equal(cover.trackCount, 5);
assert.equal(cover.albumKind, 'compilation', 'the flag groups the compilation, and the scan waited for it');
assert.equal(albums().find((a) => a.album === 'Record').albumArtist, 'Real Band');
const archives = albums().find((a) => a.album === 'Archives');
assert.equal(archives.albumKind, 'album', 'flagged, but every file names one album artist');
assert.equal(archives.albumArtist, 'Neil Young Archives');
const box = albums().find((a) => a.album === 'Box');
assert.equal(box.trackCount, 2);
assert.deepEqual(library.getAlbumTracksByKey(box.albumKey).map((t) => [t.discNo, t.discSubtitle, t.discTotal]), [[1, 'First', 2], [2, 'Second', 2]]);
assert.equal(library.getArtists({ limit: 100 }).find((a) => a.artist === 'The Rich Band')?.albumCount, 1);
// The reader on its own.
{
  const tags = await readTagExtras(join(rich, '1.flac'));
  assert.equal(tags.albumArtistTag, 'The Rich Band');
  assert.equal(tags.compilation, false);
  assert.equal(await readTagExtras(join(root, 'does-not-exist.flac')), null);
}

// 3. The backfill. Make many rows look like they predate the tags.
const bulk = await folder('Bulk');
encode({ title: 'Bulk', artist: 'Bulker', album: 'Bulk Album', album_artist: 'Bulker' }, join(bulk, 'seed.flac'));
for (let i = 0; i < 140; i++) copyFileSync(join(bulk, 'seed.flac'), join(bulk, `${String(i).padStart(3, '0')}.flac`));
await scanner.start([music]);
const forget = () => library.db.run(`UPDATE tracks SET album_artist_tag = NULL, compilation = 0, album_artist_sort = NULL, artist_sort = NULL, disc_total = NULL, track_total = NULL, disc_subtitle = NULL, mb_release_group_id = NULL, original_year = NULL, scan_schema = 0`);
const queued = () => library.db.exec(`SELECT COUNT(*) FROM tracks WHERE scan_schema < 1`)[0].values[0][0];
forget();
library.db.run(`DELETE FROM library_meta WHERE key = 'scan_schema'`);
const total = library.getStats().tracks;
assert.ok(total > 140);
assert.equal(queued(), total);
assert.equal(library.tagBackfillPending(), true);

// 3a. Stopped part-way, then resumed.
{
  const control = { cancelled: false };
  let reads = 0;
  const read = async (path) => {
    reads++;
    if (reads === 60) control.cancelled = true;
    return readTagExtras(path);
  };
  const first = await runTagBackfill(library, read, control);
  assert.equal(first.completed, false);
  const left = queued();
  assert.ok(left > 0 && left < total, `some rows were filled before the stop (${left} of ${total} still queued)`);
  assert.equal(library.getTagBackfillBatch(1000, 0).length, left);
  const second = await runTagBackfill(library, readTagExtras, { cancelled: false });
  assert.equal(second.completed, true);
  assert.equal(queued(), 0, 'the resumed run finished the rest');
  assert.equal(library.tagBackfillPending(), false);
  assert.equal(library.db.exec(`SELECT value FROM library_meta WHERE key = 'scan_schema'`)[0].values[0][0], '1');
  // It put back what the files say, and only that.
  assert.equal(row(join(comp, '3.flac'))[2], 1);
  assert.equal(row(join(neil, '1.flac'))[1], 'Neil Young Archives');
  assert.equal(row(join(cd2, '1.flac'))[5], 2);
  assert.equal(row(join(rich, '1.flac'))[9], 1977);
  assert.equal(albums().find((a) => a.album === 'Cover Versions').albumKind, 'compilation', 'the albums were grouped again afterwards');
}

// 3b. Playback comes first: nothing is read while the stream is short of audio.
{
  forget();
  const stream = {};
  reportPlaybackHunger(stream, true);
  let reads = 0;
  const run = runTagBackfill(library, async (path) => { reads++; return readTagExtras(path); }, { cancelled: false });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(reads, 0, 'the backfill waits while playback is hungry');
  assert.equal(queued(), total);
  reportPlaybackHunger(stream, false);
  const result = await run;
  assert.equal(result.completed, true);
  assert.ok(reads >= total);
  assert.equal(queued(), 0);
}

// 3c. The thread is never held for long.
{
  forget();
  let longest = 0;
  let tick = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - tick);
    tick = now;
  }, 1);
  await runTagBackfill(library, readTagExtras, { cancelled: false });
  clearInterval(timer);
  console.log(`[album-identity-scan-test] longest gap between 1 ms timer ticks during the backfill of ${total} rows: ${Math.round(longest)} ms`);
  assert.ok(longest < 150, `the backfill held the thread for ${Math.round(longest)} ms`);
}

// 3d. A file changed since the scan is left for the next scan; one that will not parse is marked done.
{
  forget();
  const changed = join(comp, '2.flac');
  const later = new Date(Date.now() + 60_000);
  utimesSync(changed, later, later);
  const broken = join(music, 'broken.flac');
  writeFileSync(broken, 'this is not audio');
  library.upsertTracks([{
    path: broken, title: 'broken', artist: 'Unknown Artist', album: '', albumArtist: 'Unknown Artist', trackNo: null, discNo: null,
    year: null, genre: null, duration: null, bitrate: null, sampleRate: null, replayGainTrackDb: null, replayGainAlbumDb: null,
    size: 17, mtime: Math.round(utimesAndMtime(broken)), art: null, parseFailed: true,
  }]);
  const result = await runTagBackfill(library, readTagExtras, { cancelled: false });
  assert.equal(result.completed, true);
  assert.equal(result.skipped, 1, 'the changed file was not read');
  assert.equal(queued(), 1, 'and stays queued');
  assert.equal(library.db.exec(`SELECT scan_schema FROM tracks WHERE path = '${changed.replace(/'/g, "''")}'`)[0].values[0][0], 0);
  assert.equal(library.db.exec(`SELECT scan_schema FROM tracks WHERE path = '${broken.replace(/'/g, "''")}'`)[0].values[0][0], 1, 'a file that will not parse is done');
  assert.equal(library.db.exec(`SELECT COUNT(*) FROM library_meta WHERE key = 'scan_schema'`)[0].values[0][0], 1);
  // The scan reads the changed file in full and settles it.
  await scanner.start([music]);
  assert.equal(queued(), 0);
}

function utimesAndMtime(path) {
  const stat = require('node:fs').statSync(path);
  return stat.mtimeMs;
}

library.close();
console.log('[album-identity-scan-test] ok: tags stored by the scan, backfill resumable, yielding and short');
