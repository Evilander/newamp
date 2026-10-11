// What a scan stores from the file, through the real Scanner and real files:
//  - codec, its lossless flag and bit depth (ALAC and AAC both live in .m4a),
//    and Library Health and quality: searches counting ALAC as lossless;
//  - an .m4a/.m4b/.mp4/.mka row that has no codec on record is read again on
//    the next scan even though the file is unchanged, once, and a container
//    that never parses is not read over and over;
//  - ratings and play counts embedded in the file (POPM, PCNT, Vorbis RATING,
//    FMPS_RATING, FMPS_PLAYCOUNT) seed a row that has none of its own, and
//    never replace what was set in NewAmp, including a rating cleared there;
//    a popularimeter byte lands on the star its band names (Windows' 1, 64,
//    128, 196 and 255 are one to five stars);
//  - the codec re-read of an unchanged container leaves its art alone;
//  - quality:fallback in SQL agrees with classifyAudioQuality for every codec
//    a container can name, not only Apple Lossless;
//  - MusicBrainz, ISRC and AcoustID identifiers are stored and exported.
// Run: npm run build:electron && node scripts/library-scan-tags-test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner } from '../dist-electron/electron/scanner.js';
import { classifyAudioQuality } from '../dist-electron/shared/audio-quality.js';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'library-scan-tags-test');
const music = join(root, 'music');
await rm(root, { recursive: true, force: true });
await mkdir(music, { recursive: true });

function encode(args, out) {
  const result = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', ...args, out], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `ffmpeg ${args.join(' ')}: ${result.stderr}`);
}
const meta = (pairs) => Object.entries(pairs).flatMap(([key, value]) => ['-metadata', `${key}=${value}`]);

// 1. Fixtures.
const files = {
  rated: join(music, 'rated.flac'),
  stars: join(music, 'stars.flac'),
  fmps: join(music, 'fmps.flac'),
  unrated: join(music, 'unrated.flac'),
  zero: join(music, 'zero.flac'),
  alac: join(music, 'alac.m4a'),
  aac: join(music, 'aac.m4a'),
  popmBoth: join(music, 'popm-both.mp3'),
  popmOnly: join(music, 'popm-only.mp3'),
  broken: join(music, 'broken.m4a'),
};
encode([...meta({ title: 'Rated', RATING: 80 }), '-c:a', 'flac'], files.rated);
// foobar2000 writes RATING on a 1-5 scale.
encode([...meta({ title: 'Stars', RATING: 5 }), '-c:a', 'flac'], files.stars);
encode([
  ...meta({
    title: 'Fmps',
    FMPS_RATING: 0.6,
    FMPS_PLAYCOUNT: 7,
    MUSICBRAINZ_TRACKID: '11111111-1111-1111-1111-111111111111',
    MUSICBRAINZ_ALBUMID: '22222222-2222-2222-2222-222222222222',
    MUSICBRAINZ_ARTISTID: '33333333-3333-3333-3333-333333333333',
    ISRC: 'USRC17607839',
    ACOUSTID_ID: '44444444-4444-4444-4444-444444444444',
  }),
  '-c:a', 'flac',
], files.fmps);
encode([...meta({ title: 'Unrated' }), '-c:a', 'flac'], files.unrated);
encode([...meta({ title: 'Zero', RATING: 0 }), '-c:a', 'flac'], files.zero);
encode([...meta({ title: 'Alac' }), '-c:a', 'alac'], files.alac);
encode([...meta({ title: 'Aac' }), '-c:a', 'aac'], files.aac);
writeFileSync(files.broken, 'not an mp4 at all');

const bare = join(root, 'bare.mp3');
encode(['-c:a', 'libmp3lame', '-write_id3v2', '0', '-write_xing', '0'], bare);
const bareMp3 = await readFile(bare);

const syncsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const id3Frame = (id, body) => Buffer.concat([Buffer.from(id, 'latin1'), syncsafe(body.length), Buffer.from([0, 0]), body]);
const u32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const popm = (rating, counter) =>
  id3Frame('POPM', Buffer.concat([Buffer.from('tester@example.com\0', 'latin1'), Buffer.from([rating]), u32(counter)]));
const pcnt = (counter) => id3Frame('PCNT', u32(counter));
const title = (text) => id3Frame('TIT2', Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]));
function mp3WithTag(frames, out) {
  const body = Buffer.concat(frames);
  writeFileSync(out, Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0]), syncsafe(body.length), body, bareMp3]));
}
// POPM 255 is five stars; 128 is three. PCNT, when present, is the count.
mp3WithTag([title('Popm both'), popm(255, 9), pcnt(5)], files.popmBoth);
mp3WithTag([title('Popm only'), popm(128, 9)], files.popmOnly);

// 2. First scan.
const library = await LibraryStore.open(join(root, 'library.db'));
let last = null;
const scanner = new Scanner(library, (progress) => { if (progress.done) last = progress; });
const byPath = (path) => library.getTracksByPaths([path])[0];
const db = () => library.db;

await scanner.start([music]);
assert.equal(last.parsed, 10);

// Codecs.
{
  const alac = byPath(files.alac);
  assert.equal(alac.codec, 'ALAC');
  assert.equal(alac.codecLossless, true);
  assert.equal(alac.bitsPerSample, 16);
  const aac = byPath(files.aac);
  assert.equal(aac.codec, 'MPEG-4/AAC');
  assert.equal(aac.codecLossless, false);
  assert.equal(byPath(files.rated).codec, 'FLAC');
  assert.equal(byPath(files.rated).codecLossless, true);
  assert.equal(byPath(files.popmOnly).codecLossless, false);
  assert.equal(byPath(files.broken).codec, null, 'an unreadable file names no codec');
  const exported = library.exportTrackMetadata().find((row) => row.path === files.alac);
  assert.equal(exported.codec, 'ALAC');
  assert.equal(exported.bitsPerSample, 16);
}

// Library Health and quality: searches count ALAC as lossless.
{
  const health = library.getLibraryHealth();
  // 5 FLAC + ALAC; the AAC and the two MP3s are lossy; the broken file is unclassified.
  assert.equal(health.quality.lossless, 6);
  assert.equal(health.quality.lossy, 3);
  const names = (search) => library.getTracks({ search, limit: 50 }).map((t) => t.path.split(/[\\/]/).pop()).sort();
  assert.ok(names('quality:lossless').includes('alac.m4a'));
  assert.ok(!names('quality:lossless').includes('aac.m4a'));
  assert.ok(names('quality:lossy').includes('aac.m4a'));
  assert.ok(!names('quality:lossy').includes('alac.m4a'));
  assert.ok(names('codec:lossless').includes('alac.m4a'));
  assert.ok(!names('quality:unknown').includes('alac.m4a'));
  assert.ok(!names('quality:unknown').includes('broken.m4a'), 'a container is never "unknown"');
  assert.deepEqual(names('quality:hires'), []);
  assert.deepEqual(names('quality:fallback'), ['alac.m4a'], 'Apple Lossless in a container plays through FFmpeg');
  assert.equal(health.quality.ffmpegFallback, 1);
  const aacRate = byPath(files.aac).bitrate;
  assert.equal(names('quality:low').includes('aac.m4a'), aacRate > 0 && aacRate < 192000);
}

// 3. Ratings and play counts seeded from the files.
{
  const rated = byPath(files.rated);
  assert.equal(rated.rating, 4);
  assert.equal(rated.ratingScore, 80);
  assert.equal(byPath(files.stars).rating, 5, 'a bare Vorbis RATING of 5 is five stars');
  assert.equal(byPath(files.stars).ratingScore, 100);
  const fmps = byPath(files.fmps);
  assert.equal(fmps.rating, 3);
  assert.equal(fmps.ratingScore, 60);
  assert.equal(fmps.playCount, 7);
  assert.equal(byPath(files.unrated).rating, 0);
  assert.equal(byPath(files.unrated).ratingScore, null);
  assert.equal(byPath(files.zero).rating, 0);
  assert.equal(byPath(files.zero).ratingScore, null);
  const both = byPath(files.popmBoth);
  assert.equal(both.rating, 5);
  assert.equal(both.ratingScore, 100);
  assert.equal(both.playCount, 5, 'PCNT is the play count when the file has one');
  const only = byPath(files.popmOnly);
  assert.equal(only.rating, 3);
  assert.equal(only.playCount, 9, 'otherwise the counter inside POPM');
  assert.equal(only.lastPlayed, null, 'imported plays are not listening history');
  assert.equal(library.getListeningHistory({ limit: 10 }).length, 0);
}

// 4. A user's choice wins, now and on every later scan.
{
  const rated = byPath(files.rated);
  library.setTrackRating(rated.id, 2);
  const fmps = byPath(files.fmps);
  library.recordPlay(fmps.id, 1_700_000_000_000);
  const stars = byPath(files.stars);
  library.setTrackRating(stars.id, 0); // cleared on purpose
  await scanner.start([music], { force: true });
  assert.equal(byPath(files.rated).rating, 2, 'a rating set in NewAmp survives a rescan');
  assert.equal(byPath(files.rated).ratingScore, 40);
  assert.equal(byPath(files.fmps).playCount, 8, 'plays counted here are added to, not replaced');
  assert.equal(byPath(files.stars).rating, 0, 'a rating cleared in NewAmp stays cleared');
  assert.equal(byPath(files.stars).ratingScore, null);
  await scanner.start([music], { force: true });
  assert.equal(byPath(files.stars).rating, 0);
  assert.equal(byPath(files.rated).rating, 2);
}

// A row from before the import existed (nothing considered yet) takes the
// file's values on the next read when it has none of its own; one the user
// already rated here does not.
{
  db().run(`UPDATE tracks SET tag_stats_imported = 0 WHERE path IN (?, ?)`, [files.fmps, files.rated]);
  db().run(`UPDATE tracks SET rating = 0, rating_score = NULL, play_count = 0, last_played = NULL WHERE path = ?`, [files.fmps]);
  await scanner.start([files.fmps, files.rated], { force: true });
  assert.equal(byPath(files.fmps).rating, 3);
  assert.equal(byPath(files.fmps).playCount, 7);
  assert.equal(byPath(files.rated).rating, 2, 'already rated here: the file does not replace it');
}

// 5. Identifiers.
{
  const track = byPath(files.fmps);
  assert.equal(track.mbRecordingId, '11111111-1111-1111-1111-111111111111');
  const exported = library.exportTrackMetadata().find((row) => row.path === files.fmps);
  assert.equal(exported.mbRecordingId, '11111111-1111-1111-1111-111111111111');
  assert.equal(exported.mbReleaseId, '22222222-2222-2222-2222-222222222222');
  assert.equal(exported.mbArtistId, '33333333-3333-3333-3333-333333333333');
  assert.equal(exported.isrc, 'USRC17607839');
  assert.equal(exported.acoustidId, '44444444-4444-4444-4444-444444444444');
  assert.equal(library.exportTrackMetadata().find((row) => row.path === files.rated).mbRecordingId, null);
}

// 6. Containers with no codec on record are read once more.
{
  await scanner.start([music]);
  assert.equal(last.parsed, 0, 'an unchanged library reads nothing');

  db().run(`UPDATE tracks SET codec = NULL, codec_lossless = NULL, bits_per_sample = NULL WHERE path LIKE '%.m4a'`);
  assert.equal(byPath(files.alac).codec, null);
  await scanner.start([music]);
  assert.equal(last.parsed, 3, 'all three .m4a files are read again, the unreadable one included');
  assert.equal(byPath(files.alac).codec, 'ALAC');
  assert.equal(byPath(files.alac).codecLossless, true);
  assert.equal(byPath(files.aac).codec, 'MPEG-4/AAC');
  assert.equal(byPath(files.broken).codec, null);

  await scanner.start([music]);
  assert.equal(last.parsed, 0, 'and not again');

  // Only containers are re-read for a missing codec.
  db().run(`UPDATE tracks SET codec = NULL WHERE path LIKE '%.flac' OR path LIKE '%.mp3'`);
  await scanner.start([music]);
  assert.equal(last.parsed, 0, 'a missing codec on a .flac or .mp3 is not worth a read');

  // A file's own change still re-reads it, and keeps the codec.
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  copyFileSync(files.aac, files.broken);
  await scanner.start([music]);
  assert.equal(last.parsed, 1);
  assert.equal(byPath(files.broken).codec, 'MPEG-4/AAC', 'the broken file is a real one now');
  assert.equal(byPath(files.broken).codecLossless, false);
}

// 7. An .m4a that never parses is not read on every scan.
{
  const junk = join(music, 'junk.m4a');
  await writeFile(junk, 'still not an mp4');
  await scanner.start([music]);
  assert.equal(last.parsed, 1);
  assert.equal(db().exec(`SELECT codec FROM tracks WHERE path = '${junk.replace(/'/g, "''")}'`)[0].values[0][0], '');
  await scanner.start([music]);
  assert.equal(last.parsed, 0, 'tried once, then left alone until the file changes');
  // An old row (no codec) whose file cannot be read is marked tried, not retried forever.
  db().run(`UPDATE tracks SET codec = NULL WHERE path = ?`, [junk]);
  await scanner.start([music]);
  assert.equal(last.parsed, 1);
  await scanner.start([music]);
  assert.equal(last.parsed, 0);
}

// 8. The popularimeter byte lands on the star its band names, not on whatever
// (byte - 1) / 254 rounds to: Windows' 1, 64, 128, 196 and 255 are one to five stars.
{
  const popmDir = join(root, 'popm');
  await mkdir(popmDir, { recursive: true });
  const cases = [
    [0, 0], [1, 1], [2, 1], [31, 1], [32, 2], [64, 2], [95, 2], [96, 3], [128, 3],
    [159, 3], [160, 4], [196, 4], [223, 4], [224, 5], [255, 5],
  ];
  for (const [byte] of cases) mp3WithTag([title(`Popm ${byte}`), popm(byte, 0)], join(popmDir, `popm-${byte}.mp3`));
  await scanner.start([popmDir]);
  assert.equal(last.parsed, cases.length);
  for (const [byte, stars] of cases) {
    const row = byPath(join(popmDir, `popm-${byte}.mp3`));
    assert.equal(row.rating, stars, `POPM ${byte} is ${stars} star(s)`);
    assert.equal(row.ratingScore, stars ? stars * 20 : null, `POPM ${byte} score`);
  }
}

// 9. The one-time codec read of an unchanged container does not touch its art:
// folder art that changed since is only taken up by a real re-read.
{
  const probeDir = join(root, 'probe');
  await mkdir(probeDir, { recursive: true });
  const book = join(probeDir, 'book.m4a');
  const cover = join(probeDir, 'cover.jpg');
  encode([...meta({ title: 'Book' }), '-c:a', 'alac'], book);
  await writeFile(cover, Buffer.from('first cover'));
  await scanner.start([probeDir]);
  const artHash = () => db().exec(`SELECT art_hash FROM tracks WHERE path = '${book.replace(/'/g, "''")}'`)[0].values[0][0];
  const first = artHash();
  assert.ok(first, 'the folder cover was taken up');
  assert.equal(byPath(book).codec, 'ALAC');

  await writeFile(cover, Buffer.from('a different cover'));
  db().run(`UPDATE tracks SET codec = NULL, codec_lossless = NULL, bits_per_sample = NULL WHERE path = ?`, [book]);
  await scanner.start([probeDir]);
  assert.equal(last.parsed, 1);
  assert.equal(byPath(book).codec, 'ALAC', 'the codec is read');
  assert.equal(byPath(book).hasArt, 1);
  assert.equal(artHash(), first, 'and the art stays as it was');

  await scanner.start([probeDir], { force: true });
  assert.notEqual(artHash(), first, 'a full read takes up the new cover');
}

// 10. The SQL behind quality:fallback and classifyAudioQuality are two
// statements of one rule; they have to agree.
{
  const probe = join(root, 'probe', 'book.m4a');
  const inFallback = () => library.getTracks({ search: 'quality:fallback', limit: 100 }).some((t) => t.path === probe);
  const codecs = [
    'ALAC', 'AC-3', 'uLaw 2:1', 'MP4S', 'ALAC+MPEG-4/AAC',
    'MPEG-4/AAC', 'MPEG-1 layer 3', 'MPEG 1 Layer 3', 'MPEG-4/AAC+ALAC', 'FLAC', 'Opus', '',
  ];
  for (const codec of codecs) {
    db().run(`UPDATE tracks SET codec = ?, codec_lossless = NULL WHERE path = ?`, [codec, probe]);
    const expected = classifyAudioQuality({ path: probe, bitrate: null, sampleRate: null, codec }).decodePath === 'ffmpeg-pcm-fallback';
    assert.equal(inFallback(), expected, `quality:fallback for codec ${JSON.stringify(codec)}`);
  }
  db().run(`UPDATE tracks SET codec = NULL WHERE path = ?`, [probe]);
  assert.equal(inFallback(), false, 'a codec not read yet says nothing');
}

library.close();
console.log('[library-scan-tags-test] ok: codecs, quality, embedded ratings and plays, identifiers, codec re-read');
