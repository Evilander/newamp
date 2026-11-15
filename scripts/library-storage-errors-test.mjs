// What library.ts does when the storage answers badly, and the library work
// that used to hold the main thread or give the wrong answer on a big library:
//  - a path whose stat fails for any reason but "not there" (a timeout, an I/O
//    error, no permission) is neither present nor gone: nothing is marked
//    missing for it and "Clean missing files" keeps the track as offline;
//  - the async marking and clean-up give the same answers as the sync ones;
//  - a tmp copy left beside library.db by a dead write is swept on open;
//  - folders play in album order (numbers compared as numbers), singles by name;
//  - searching "music" doesn't match every track through the library's own
//    folder, and accented paths match in either Unicode form;
//  - pages past the first ones are cut from one sorted id list;
//  - playlists: covers stored by name, counts that match the list, orphan
//    covers removed; deleting a list takes its items;
//  - setting the stars a track already shows keeps its finer score.
// Run: npm run build:electron && node scripts/library-storage-errors-test.mjs
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore, normalizePruneTargets, pathPresence, pathPresenceAsync } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'library-storage-errors-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const base = {
  album: 'Album', albumArtist: 'Artist', trackNo: null, discNo: null, year: 2001, genre: 'Rock', duration: 100,
  bitrate: 320000, sampleRate: 44100, replayGainTrackDb: null, replayGainAlbumDb: null, size: 1, mtime: 1, art: null,
};
const incoming = (path, extra = {}) => ({ ...base, path, title: path.split('/').pop(), artist: 'Artist', ...extra });
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const canDenyAccess = process.platform !== 'win32' && !isRoot;

// ---- tri-state presence
const music = join(root, 'Music');
mkdirSync(join(music, 'Present'), { recursive: true });
writeFileSync(join(music, 'Present', 'here.mp3'), 'x');
writeFileSync(join(music, 'plain.txt'), 'x');
mkdirSync(join(music, 'Sub'), { recursive: true });
writeFileSync(join(music, 'Sub', 'keep.mp3'), 'x');
assert.equal(pathPresence(join(music, 'Present', 'here.mp3')), 'present');
assert.equal(pathPresence(join(music, 'Present', 'gone.mp3')), 'absent');
assert.equal(pathPresence(join(music, 'plain.txt', 'below-a-file')), 'absent', 'ENOTDIR counts as not there');
assert.equal(await pathPresenceAsync(join(music, 'Present', 'gone.mp3')), 'absent');
if (canDenyAccess) {
  const locked = join(music, 'Locked');
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, 'a.mp3'), 'x');
  chmodSync(locked, 0o000);
  try {
    assert.equal(pathPresence(join(locked, 'a.mp3')), 'unknown', 'a refused stat is not "gone"');
    assert.equal(await pathPresenceAsync(join(locked, 'a.mp3')), 'unknown');
    const [target] = normalizePruneTargets([join(locked, 'a.mp3')]);
    assert.equal(target.exists, false);
    assert.equal(target.unknown, true, 'the target carries that it is unknown');
  } finally {
    chmodSync(locked, 0o755);
  }
}

// ---- marking missing, sync and async
const library = await LibraryStore.open(join(root, 'library.db'));
library.upsertTracks([
  incoming(join(music, 'Present', 'here.mp3')),
  incoming(join(music, 'Present', 'gone.mp3')),
  incoming(join(music, 'Sub', 'Vanished', 'old.mp3')),
  ...(canDenyAccess ? [incoming(join(music, 'Locked', 'a.mp3'))] : []),
]);
const missingPaths = () => library.getTracks({ limit: 100 }).filter((track) => track.missingSince).map((track) => track.path.split('/').pop()).sort();
const targets = [join(music, 'Present'), join(music, 'Sub', 'Vanished'), ...(canDenyAccess ? [join(music, 'Locked')] : [])];
if (canDenyAccess) chmodSync(join(music, 'Locked'), 0o000);
try {
  const marked = await library.markTracksMissingAsync(targets);
  assert.equal(marked, 2, 'the vanished folder and the one deleted file are marked; the locked folder is not');
  assert.deepEqual(missingPaths(), ['gone.mp3', 'old.mp3']);
} finally {
  if (canDenyAccess) chmodSync(join(music, 'Locked'), 0o755);
}
assert.equal(library.markTracksMissing(targets), 0, 'the sync form agrees and finds nothing new');
// A file handed over as a root that the walk already found costs no stat and adds nothing.
assert.equal(library.markUnfoundTracksMissing([join(music, 'Present', 'here.mp3')], [join(music, 'Present', 'here.mp3')]), 0);

// ---- clean missing files: tri-state, sync and async agree
const roots = [music];
const syncPreview = library.previewPruneMissingTracks(undefined, roots);
const asyncPreview = await library.previewPruneMissingTracksAsync(undefined, roots);
assert.deepEqual(asyncPreview, syncPreview, 'the sliced preview counts what the sync one does');
assert.equal(asyncPreview.tracks, 2, 'the deleted file and the vanished folder are proven gone');
if (canDenyAccess) {
  // The sweep just made is kept for the removal that follows; any write ends that.
  library.toggleLove(library.getTracks({ limit: 1 })[0].id);
  chmodSync(join(music, 'Locked'), 0o000);
  try {
    const locked = await library.previewPruneMissingTracksAsync(undefined, roots);
    assert.equal(locked.tracks, 2, 'a track in a folder that will not answer is kept');
    assert.ok(locked.offline >= 1, 'and counted as offline');
    assert.deepEqual(library.previewPruneMissingTracks(undefined, roots).tracks, 2, 'the sync preview keeps it too');
  } finally {
    chmodSync(join(music, 'Locked'), 0o755);
  }
}
const pruned = await library.pruneMissingTracksAsync(undefined, roots);
assert.equal(pruned.removed, 2);
assert.deepEqual(library.getTracks({ limit: 100 }).map((track) => track.path.split('/').pop()).sort(), canDenyAccess ? ['a.mp3', 'here.mp3'] : ['here.mp3']);
library.close();

// ---- a stale tmp copy is swept on open, a fresh one is not
const tmpDir = join(root, 'sweep');
await mkdir(tmpDir, { recursive: true });
{
  const first = await LibraryStore.open(join(tmpDir, 'library.db'));
  first.upsertTracks([incoming('/m/one.mp3')]);
  first.close();
  const stale = join(tmpDir, 'library.db.tmp-99999-3');
  const fresh = join(tmpDir, 'library.db.tmp-99999-4');
  writeFileSync(stale, 'old');
  writeFileSync(fresh, 'new');
  const longAgo = new Date(Date.now() - 10 * 60_000);
  utimesSync(stale, longAgo, longAgo);
  const second = await LibraryStore.open(join(tmpDir, 'library.db'));
  for (let i = 0; i < 40 && existsSync(stale); i += 1) await new Promise((r) => setTimeout(r, 25));
  assert.equal(existsSync(stale), false, 'the stale tmp copy is removed');
  assert.equal(existsSync(fresh), true, 'a recent one may belong to a write in progress');
  second.close();
}

// ---- the rest on one library
const lib2 = await LibraryStore.open(join(root, 'second.db'));
const music2 = '/Users/x/Music';
lib2.upsertTracks([
  incoming(`${music2}/Album/1 - A.flac`, { trackNo: 1, album: 'Num' }),
  incoming(`${music2}/Album/10 - J.flac`, { trackNo: 10, album: 'Num' }),
  incoming(`${music2}/Album/2 - B.flac`, { trackNo: 2, album: 'Num' }),
  incoming(`${music2}/Multi/CD10/01 c.flac`, { trackNo: 1, album: 'Multi' }),
  incoming(`${music2}/Multi/CD2/01 b.flac`, { trackNo: 1, album: 'Multi' }),
  incoming(`${music2}/Multi/CD1/01 a.flac`, { trackNo: 1, album: 'Multi' }),
  incoming(`${music2}/Singles/zeta.mp3`, { trackNo: 1, album: 'S1' }),
  incoming(`${music2}/Singles/alpha.mp3`, { trackNo: 1, album: 'S2' }),
  incoming(`${music2}/Singles/mid.mp3`, { trackNo: 1, album: 'S3' }),
  incoming(`${music2}/Björk/Homogenic/01 Hunter.flac`, { artist: 'Björk', album: 'Homogenic' }),
  // The accented name is in the path alone, so only the path can answer a search for it.
  incoming(`${music2}/Zoë Keating/Re/01 Ingrata.flac`, { title: 'Ingrata', artist: 'Artist', album: 'Re' }),
]);
const names = (tracks) => tracks.map((track) => track.path.slice(music2.length + 1));
assert.deepEqual(names(lib2.getFolderTracks(music2, { recursive: true })).slice(0, 9), [
  'Album/1 - A.flac', 'Album/2 - B.flac', 'Album/10 - J.flac',
  'Björk/Homogenic/01 Hunter.flac',
  'Multi/CD1/01 a.flac', 'Multi/CD2/01 b.flac', 'Multi/CD10/01 c.flac',
  'Singles/alpha.mp3', 'Singles/mid.mp3',
], 'numbers compare as numbers; a directory of singles goes by name');
assert.deepEqual(lib2.getFolderTrackIds(music2, { recursive: true }), lib2.getFolderTracks(music2, { recursive: true }).map((t) => t.id));
assert.deepEqual(
  names(await lib2.getFolderTracksAsync(`${music2}/Album`, {})),
  ['Album/1 - A.flac', 'Album/2 - B.flac', 'Album/10 - J.flac'],
  'the sliced listing orders the same way',
);
assert.deepEqual(names(lib2.getFolderTracks(music2, { recursive: true, limit: 2, offset: 1 })), ['Album/2 - B.flac', 'Album/10 - J.flac'], 'a page is cut after the sort');

// search: the folder the library lives in is not part of a free-text match
assert.equal(lib2.getTrackCount({ search: 'music' }), 0, '"music" is the library folder, not a track');
assert.equal(lib2.getTrackCount({ search: 'users' }), 0);
assert.equal(lib2.getTrackCount({ search: 'singles' }), 3, 'a folder below it still matches');
assert.equal(lib2.getTrackCount({ search: 'path:music' }), 11, 'path: still matches the whole path');
const nfd = 'Bjo\u0308rk';
// The artist is Björk too, so these two are met by the tags; the Zoë ones below are the path's.
assert.equal(lib2.getTrackCount({ search: nfd }), 1, 'a decomposed typed name finds the composed path');
assert.equal(lib2.getTrackCount({ search: `path:${nfd}` }), 1);
assert.equal(lib2.getTrackCount({ search: 'Zoe\u0308 Keating' }), 1, 'a decomposed name matches a path whose tags do not carry it');
assert.equal(lib2.getTrackCount({ search: 'path:Zoe\u0308 Keating' }), 1);
assert.equal(lib2.getTracksByPaths([`${music2}/BJÖRK/HOMOGENIC/01 HUNTER.FLAC`]).length, 1, 'a playlist path in another case resolves');
assert.equal(lib2.getTracksByPaths([`${music2}/Bjo\u0308rk/Homogenic/01 Hunter.flac`]).length, 1, 'and in another Unicode form');

// ratings: the same stars again leave a finer score alone
const [rated] = lib2.getTracks({ search: 'alpha', limit: 1 });
lib2.setTrackRatingScore(rated.id, 87);
assert.equal(lib2.getTrack(rated.id).rating, 4);
lib2.setTrackRating(rated.id, 4);
assert.equal(lib2.getTrack(rated.id).ratingScore, 87, 'four stars again keeps 87');
lib2.setTrackRating(rated.id, 5);
assert.equal(lib2.getTrack(rated.id).ratingScore, 100);
lib2.setTrackRating(rated.id, 0);
assert.equal(lib2.getTrack(rated.id).ratingScore, null);

// playlists: counts agree with the list, covers are stored by name
const picture = join(root, 'cover.png');
await writeFile(picture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
const all = lib2.getTracks({ limit: 100 });
const playlist = lib2.savePlaylist({ name: 'Mixed', trackIds: [all[0].id, 999999, all[1].id], coverImagePath: picture });
assert.equal(playlist.trackCount, 2, 'an id that is no track is not counted');
assert.equal(lib2.getPlaylistTracks(playlist.id).length, 2);
const storedCover = lib2.one(`SELECT cover_art_path FROM playlists WHERE id = ?`, [playlist.id]).cover_art_path;
assert.ok(!storedCover.includes('/') && !storedCover.includes('\\'), 'the cover is stored as a file name');
assert.equal(lib2.getPlaylistCover(playlist.id)?.mime, 'image/png');
// A library.db that stored the whole path of another machine still finds the file by its name.
lib2.db.run(`UPDATE playlists SET cover_art_path = ? WHERE id = ?`, [`C:\\Users\\other\\playlist-art\\${storedCover}`, playlist.id]);
assert.equal(lib2.getPlaylistCover(playlist.id)?.mime, 'image/png', 'a legacy absolute path resolves by its name');
const added = lib2.addTracksToPlaylist({ playlistId: playlist.id, trackIds: [all[2].id, all[2].id, 888888] });
assert.equal(added.trackCount, 4, 'known ids are added, repeats included; unknown ones are not');
const coverFile = join(root, 'playlist-art', storedCover);
assert.equal(existsSync(coverFile), true);
lib2.deletePlaylist(playlist.id);
for (let i = 0; i < 40 && existsSync(coverFile); i += 1) await new Promise((r) => setTimeout(r, 25));
assert.equal(existsSync(coverFile), false, 'deleting the playlist removes its cover file');

// lists: the items go with the list
const list = lib2.saveList({ title: 'Gone soon' });
lib2.addListItem({ listId: list.id, trackId: null, label: 'one' });
lib2.deleteList(list.id);
assert.equal(lib2.one(`SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?`, [list.id]).n, 0, 'the list items are deleted with the list');

// tags: a limited pass leaves the other tracks' tags alone; the async pass agrees
lib2.saveTagRule({ name: 'rocky', body: 'tag(rocky) when genre = "Rock"' });
const full = lib2.recomputeTags();
assert.equal(full.tracksEvaluated, lib2.getTrackCount());
const before = lib2.getTagSummaries().find((tag) => tag.name === 'rocky').trackCount;
lib2.recomputeTags({ limit: 2 });
assert.equal(lib2.getTagSummaries().find((tag) => tag.name === 'rocky').trackCount, before, 'a pass over two tracks keeps the tags of the rest');
const asyncPass = await lib2.recomputeTagsAsync();
assert.equal(asyncPass.tracksEvaluated, full.tracksEvaluated);
assert.equal(lib2.getTagSummaries().find((tag) => tag.name === 'rocky').trackCount, before);
const preview = await lib2.previewTagRuleAsync({ body: 'tag(rocky2) when genre = "Rock"', limit: 4 });
assert.equal(preview.ok, true);
assert.equal(preview.totalCount, lib2.getTrackCount());
assert.ok(preview.sampledCount <= 4 && preview.sampledCount > 0, 'a large library is sampled at a stride');
assert.deepEqual(await lib2.previewTagRuleAsync({ body: 'tag(rocky2) when genre = "Rock"', limit: 4 }), preview, 'the sample is the same each time');

// history views: the sliced forms agree with the sync ones, and a profile page keeps listening private
const [one, two] = lib2.getTracks({ limit: 2 });
lib2.recordPlay(one.id, Date.UTC(2026, 4, 15, 12));
lib2.recordPlay(two.id, Date.UTC(2026, 4, 14, 12));
lib2.recordSkip(two.id, Date.UTC(2026, 4, 14, 13), 5);
const now = Date.UTC(2026, 4, 15, 18);
assert.deepEqual(await lib2.getListeningInsightsAsync({ now }), lib2.getListeningInsights({ now }));
assert.deepEqual(await lib2.getWrappedStatsAsync({ range: 'all', now }), lib2.getWrappedStats({ range: 'all', now }));
assert.equal(lib2.getWrappedStats({ range: 'all', now }).totals.plays, 2);
assert.doesNotMatch(lib2.buildProfileBundleHtml({ now }), /Top artists/, 'a local profile does not publish its listening');
lib2.saveProfile({ defaultPrivacy: 'public' });
assert.match(lib2.buildProfileBundleHtml({ now }), /Top artists/);

// paging: a page past the first ones comes from the same order as a direct page
const many = Array.from({ length: 1500 }, (_, i) => incoming(`/big/${String(i).padStart(4, '0')} Song.flac`, { title: `Song ${i}`, artist: `Artist ${i % 37}` }));
lib2.upsertTracks(many);
const direct = lib2.getTrackIds({ sort: 'artist', limit: 1000, offset: 0 });
const wide = lib2.getTrackIds({ sort: 'artist', limit: 1400, offset: 0 });
assert.deepEqual(wide.slice(0, 1000), direct, 'the long list begins with the direct page');
assert.deepEqual(lib2.getTrackIds({ sort: 'artist', limit: 200, offset: 1000 }), wide.slice(1000, 1200), 'a direct page at the edge matches');
assert.deepEqual(lib2.getTrackIds({ sort: 'artist', limit: 100, offset: 1300 }), wide.slice(1300, 1400), 'a page from the kept list matches');
assert.deepEqual(lib2.getTracks({ sort: 'artist', limit: 100, offset: 1300 }).map((t) => t.id), wide.slice(1300, 1400));
// A write drops the kept list, and the next page is cut from a fresh one. The
// sort is one the write changes: five stars moves a track from the tail to the head.
const byRating = lib2.getTrackIds({ sort: 'rating', limit: 1400, offset: 0 });
const tailId = byRating[1300];
assert.deepEqual(lib2.getTrackIds({ sort: 'rating', limit: 100, offset: 1300 }), byRating.slice(1300, 1400), 'the page comes from the kept list');
lib2.setTrackRating(tailId, 5);
const byRatingAfter = lib2.getTrackIds({ sort: 'rating', limit: 1400, offset: 0 });
assert.equal(byRatingAfter[0], tailId, 'the rated track leads the list rebuilt after the write');
assert.deepEqual(lib2.getTrackIds({ sort: 'rating', limit: 100, offset: 1300 }), byRatingAfter.slice(1300, 1400));
assert.notDeepEqual(byRatingAfter.slice(1300, 1400), byRating.slice(1300, 1400), 'a stale list would have given the old page');

// Tracks that tie on every sort column page the same from the first page, the
// direct query and the kept list.
lib2.upsertTracks(Array.from({ length: 1200 }, (_, i) => incoming(`/same/${String((i * 7919) % 1200).padStart(4, '0')}.flac`, { title: 'Same', artist: 'Same', album: 'Same' })));
const tiedWide = lib2.getTrackIds({ sort: 'title', limit: 3000, offset: 0 });
const tiedDirect = lib2.getTrackIds({ sort: 'title', limit: 500, offset: 400 });
assert.deepEqual(tiedDirect, tiedWide.slice(400, 900), 'a page cut by the query matches the same page of the kept list');
assert.equal(new Set(tiedWide).size, tiedWide.length, 'no track repeats or is dropped across pages');
assert.deepEqual(lib2.getTrackIds({ sort: 'title', limit: 200, offset: 1100 }), tiedWide.slice(1100, 1300), 'pages that cross the direct limit agree');
lib2.close();

// A flush that can't export keeps the changes dirty and tries again by itself.
{
  const file = join(root, 'flush.db');
  const lib4 = await LibraryStore.open(file);
  lib4.upsertTracks([incoming('/m/flush.mp3')]);
  await lib4.flushPendingWrites();
  const realExport = lib4.db.export.bind(lib4.db);
  let failures = 1;
  lib4.db.export = () => {
    if (failures-- > 0) throw new Error('out of memory');
    return realExport();
  };
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const [track] = lib4.getTracks({ limit: 1 });
  lib4.toggleLove(track.id);
  await new Promise((r) => setTimeout(r, 1200));
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, [], 'a failed export is not an unhandled rejection');
  assert.equal(lib4.dirty, true, 'the changes are still waiting to be written');
  assert.notEqual(lib4.persistTimer, null, 'and a retry is scheduled');
  lib4.close();
  const reopened = await LibraryStore.open(file);
  assert.equal(reopened.getTrack(track.id).loved, 1, 'closing wrote what the failed flush could not');
  reopened.close();
}

// After a run of answers that are neither yes nor no the sweep stops asking, so
// a file past the run is kept as offline even when it is plainly gone.
if (canDenyAccess) {
  const lib5 = await LibraryStore.open(join(root, 'fifth.db'));
  const music5 = join(root, 'Music5');
  mkdirSync(join(music5, 'Gone'), { recursive: true });
  writeFileSync(join(music5, 'Gone', 'kept.mp3'), 'x');
  mkdirSync(join(music5, 'Locked'), { recursive: true });
  for (let i = 0; i < 6; i += 1) writeFileSync(join(music5, 'Locked', `${i}.mp3`), 'x');
  lib5.upsertTracks([
    ...Array.from({ length: 6 }, (_, i) => incoming(join(music5, 'Locked', `${i}.mp3`))),
    incoming(join(music5, 'Gone', 'deleted.mp3')),
  ]);
  const before = lib5.previewPruneMissingTracks(undefined, [music5]);
  assert.equal(before.tracks, 1, 'with every folder answering, the deleted file is proven gone');
  chmodSync(join(music5, 'Locked'), 0o000);
  try {
    const during = lib5.previewPruneMissingTracks(undefined, [music5]);
    assert.equal(during.tracks, 0, 'five unanswered files in a row end the sweep; the one after is not judged');
    assert.equal(during.offline, 7, 'and everything left is counted offline');
    const duringAsync = await lib5.previewPruneMissingTracksAsync(undefined, [music5]);
    assert.equal(duringAsync.tracks, 1, 'the sliced sweep asks every file at once, and a deleted one is still proven');
    assert.equal(duringAsync.offline, 6);
  } finally {
    chmodSync(join(music5, 'Locked'), 0o755);
  }
  lib5.close();
}

if (process.platform === 'darwin' || process.platform === 'win32') {
  // Where names compare without case a changed file under a re-cased folder is the same row.
  const lib3 = await LibraryStore.open(join(root, 'third.db'));
  lib3.upsertTracks([incoming('/Users/x/music/The Beatles/one.flac', { title: 'One' })]);
  lib3.upsertTracks([incoming('/Users/x/music/the beatles/one.flac', { title: 'One', size: 2 })]);
  assert.equal(lib3.getTrackCount(), 1, 'a case-variant path updates the row instead of adding one');
  lib3.close();
}

// A file renamed in case or Unicode form keeps its row, and the row takes the
// spelling the file has now, so playback opens a path that exists. On a volume
// that keeps the spellings apart, two files that differ only in case stay two.
if (process.platform === 'darwin') {
  const lib6 = await LibraryStore.open(join(root, 'sixth.db'));
  const dir6 = join(root, 'Rename');
  mkdirSync(dir6, { recursive: true });
  writeFileSync(join(dir6, 'track.mp3'), 'x');
  // Stored under a spelling the disk no longer has.
  lib6.upsertTracks([incoming(join(dir6, 'Track.mp3'), { title: 'Track' })]);
  const [stored] = lib6.getTracks({ limit: 10 });
  lib6.recordPlay(stored.id, Date.UTC(2026, 4, 1));
  lib6.upsertTracks([incoming(join(dir6, 'track.mp3'), { title: 'Track', size: 2 })]);
  const rows = lib6.getTracks({ limit: 10 });
  assert.equal(rows.length, 1, 'the renamed file is the same row');
  assert.equal(rows[0].id, stored.id, 'with the same id');
  assert.equal(rows[0].path, join(dir6, 'track.mp3'), 'under the spelling the file has now');
  assert.equal(lib6.getTrack(stored.id).playCount, 1, 'its history is kept');

  const nfc = 'Caf\u00e9.mp3';
  const nfdName = 'Cafe\u0301.mp3';
  writeFileSync(join(dir6, nfc), 'x');
  lib6.upsertTracks([incoming(join(dir6, nfdName), { title: 'Cafe' })]);
  lib6.upsertTracks([incoming(join(dir6, nfc), { title: 'Cafe', size: 2 })]);
  assert.equal(lib6.getTracks({ limit: 10 }).filter((track) => track.title === 'Cafe').length, 1, 'a Unicode-form rename is one row too');

  // Two real files: a volume that tells them apart holds both rows.
  const twin = join(root, 'Twin');
  mkdirSync(twin, { recursive: true });
  writeFileSync(join(twin, 'A.flac'), 'x');
  const apart = !existsSync(join(twin, 'a.flac'));
  if (apart) {
    writeFileSync(join(twin, 'a.flac'), 'y');
    lib6.upsertTracks([incoming(join(twin, 'A.flac'), { title: 'Upper' })]);
    lib6.upsertTracks([incoming(join(twin, 'a.flac'), { title: 'Lower' })]);
    assert.equal(lib6.getTracks({ limit: 20 }).filter((track) => track.path.startsWith(twin)).length, 2, 'files that differ only in case stay two rows');
  }
  lib6.close();
}

await rm(root, { recursive: true, force: true });
console.log('[library-storage-errors-test] ok');
