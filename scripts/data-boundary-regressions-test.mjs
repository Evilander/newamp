import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'newamp-data-boundaries-'));
const stores = [];
const watchers = [];
async function sourceModule(path, platform = process.platform) {
  const output = await build({
    entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve(path)).href), 'process.platform': JSON.stringify(platform) },
  });
  const code = output.outputFiles[0].text.replace(/from "sql.js"/g, `from ${JSON.stringify(import.meta.resolve('sql.js'))}`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const incoming = (path) => ({
  path, title: 'Song', artist: 'Artist', album: 'Album', albumArtist: 'Artist', trackNo: 1, discNo: 1,
  year: 2026, genre: null, duration: 60, bitrate: 320000, sampleRate: 44100, size: 100, mtime: 1,
  art: null, replayGainTrackDb: null, replayGainAlbumDb: null,
});
async function libraryFor(platform) {
  const { LibraryStore } = await sourceModule('electron/library.ts', platform);
  const library = await LibraryStore.open(join(root, platform, 'library.db'));
  stores.push(library);
  return library;
}
async function waitFor(predicate, label) {
  const until = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < until, `Timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

try {
  const library = await libraryFor('win32');
  const path = join(root, 'Song.mp3');
  await writeFile(path, 'fixture');
  library.upsertTracks([incoming(path)]);
  const original = library.getTracks({})[0];
  library.toggleLove(original.id);
  library.setTrackRating(original.id, 5);
  library.saveTrackBookmark({ trackId: original.id, position: 12, label: 'Keep' });
  library.applyManualMetadataPatch(original.id, { genre: 'My genre' });
  const playlist = library.savePlaylist({ name: 'Repeat', trackIds: [original.id, original.id] });
  library.upsertTracks([{ ...incoming(path.replace('Song.mp3', 'song.mp3')), mtime: 2 }]);
  assert.equal(library.getStats().tracks, 1, 'Windows case-only update keeps one identity');
  const updated = library.getTrack(original.id);
  assert.equal(updated.loved, 1);
  assert.equal(updated.rating, 5);
  assert.equal(updated.genre, 'My genre');
  assert.equal(library.getTrackBookmarks(original.id)[0].label, 'Keep');
  assert.deepEqual(library.getPlaylistTracks(playlist.id).map((track) => track.id), [original.id, original.id]);
  const unicodePath = join(root, 'Été.mp3');
  library.upsertTracks([incoming(unicodePath)]);
  const unicodeId = library.getTracksByPaths([unicodePath])[0].id;
  library.toggleLove(unicodeId);
  library.upsertTracks([incoming(join(root, 'été.mp3'))]);
  assert.equal(library.getStats().tracks, 2, 'Unicode case update also keeps one identity');
  assert.equal(library.getTrack(unicodeId).loved, 1);

  const linux = await libraryFor('linux');
  linux.upsertTracks([incoming('/music/Song.mp3'), incoming('/music/song.mp3')]);
  assert.equal(linux.getStats().tracks, 2, 'Linux case-distinct files stay distinct');

  const previousTimezone = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  try {
    for (const days of [['2026-03-07', '2026-03-08', '2026-03-09'], ['2026-10-31', '2026-11-01', '2026-11-02']]) {
      library.clearListeningHistory();
      for (const day of days) library.recordPlay(original.id, new Date(`${day}T12:00:00`).getTime());
      const now = new Date(`${days[2]}T23:00:00`).getTime();
      assert.equal(library.getWrappedStats({ range: 'year', now }).longestStreakDays, 3, `calendar streak: ${days}`);
    }
    library.clearListeningHistory();
    library.recordPlay(original.id, new Date('2026-03-03T23:30:00').getTime());
    library.recordPlay(original.id, new Date('2026-03-04T00:30:00').getTime());
    const springNow = new Date('2026-03-10T12:00:00').getTime();
    assert.equal(library.getWrappedStats({ range: 'week', now: springNow }).totals.plays, 1, 'week starts at local midnight across DST');
    assert.equal(library.getListeningInsights({ now: springNow }).week.plays, 1, 'insights use the same calendar window');
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }

  for (const privacy of ['local', 'friends', 'public']) {
    const list = library.saveList({ title: `${privacy}-title`, description: `${privacy}-description`, privacy });
    library.addListItem({ listId: list.id, label: `${privacy}-item`, note: `${privacy}-note` });
    library.saveReview({ targetType: 'track', targetKey: `${privacy}-target`, title: `${privacy}-review`, body: `${privacy}-body`, privacy });
  }
  const html = library.buildProfileBundleHtml();
  for (const field of ['title', 'description', 'item', 'note', 'target', 'review', 'body']) {
    assert.ok(html.includes(`public-${field}`), `public ${field} exported`);
    for (const privacy of ['local', 'friends']) assert.ok(!html.includes(`${privacy}-${field}`), `${privacy} ${field} excluded`);
  }
  assert.equal(library.getLists().length, 3, 'export does not delete private lists');
  assert.equal(library.getReviews().length, 3, 'export does not delete private reviews');

  const { parseCueSheet } = await sourceModule('electron/cue.ts');
  const cueRoot = join(root, 'cue');
  await mkdir(cueRoot);
  await writeFile(join(cueRoot, 'Z.wav'), 'fixture');
  await writeFile(join(cueRoot, 'A.wav'), 'fixture');
  const cue = parseCueSheet('FILE "Z.wav" WAVE\n TRACK 01 AUDIO\n TITLE "First"\n INDEX 01 00:00:00\n TRACK 02 AUDIO\n TITLE "Second"\n INDEX 01 00:10:00\nFILE "A.wav" WAVE\n TRACK 03 AUDIO\n TITLE "Third"\n INDEX 01 00:00:00', join(cueRoot, 'order.cue'));
  assert.deepEqual(cue.map((entry) => entry.title), ['First', 'Second', 'Third']);
  assert.deepEqual(cue.map((entry) => entry.end), [10, null, null]);

  const { LibraryWatcher } = await sourceModule('electron/library-watcher.ts');
  const watchRoot = join(root, 'watched');
  const oldAlbum = join(watchRoot, 'Old.Album');
  await mkdir(oldAlbum, { recursive: true });
  await writeFile(join(oldAlbum, 'song.mp3'), 'fixture');
  const events = [];
  const watcher = new LibraryWatcher((targets) => events.push(...targets), { debounceMs: 50, rootPollMs: 60000 });
  watchers.push(watcher);
  watcher.start([watchRoot]);
  await waitFor(() => watcher.isWatching(), 'watcher startup');
  if (process.platform === 'linux') await waitFor(() => watcher.watchedPathCount() >= 2, 'per-directory tree startup');
  const newAlbum = join(watchRoot, 'New.Album');
  await rename(oldAlbum, newAlbum);
  await waitFor(() => events.includes(oldAlbum) && events.includes(newAlbum), 'directory rename emits departure and arrival');
  const external = join(root, 'Imported.Album');
  await mkdir(external);
  await writeFile(join(external, 'another.mp3'), 'fixture');
  const imported = join(watchRoot, 'Imported.Album');
  await rename(external, imported);
  await waitFor(() => events.includes(imported), 'populated directory arrival');
  await rename(imported, external);
  await waitFor(() => events.filter((target) => target === imported).length >= 2, 'populated directory departure');
  const missing = join(oldAlbum, 'song.mp3');
  library.upsertTracks([incoming(missing)]);
  assert.equal(library.markTracksMissing([oldAlbum]), 1, 'removed dotted directory marks its descendants');
  console.log('PASS data boundaries: Windows identity, Linux casing, DST, public export, CUE order, native directory watching');
} finally {
  for (const watcher of watchers) watcher.stop();
  for (const library of stores) { library.close(); await library.waitForPendingWrites(); }
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  await rm(root, { recursive: true, force: true });
}
