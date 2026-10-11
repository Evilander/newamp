// Moving tracks to the Recycle Bin, the parts that run without Electron:
//  - rows leave the library by id (removeTracksById), history, bookmarks and
//    playlist places with them, whatever the missing-file heuristic would
//    keep, and "Clean missing files" reports the ids it removed
//  - target matching costs one Set lookup per path segment
//  - the safety backup before a removal copies library.db and settings.json
//    only, keeps the newest five automatic backups, leaves a user's alone,
//    and restores
//  - an ffmpeg holding a file is stopped so the file can be moved
//  - the retry around the move, the error wording, what the menu offers and
//    the toasts afterwards
// Run: npm run build:electron && node scripts/trash-tracks-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import ffmpeg from 'ffmpeg-static';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp', 'trash-tracks-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const { LibraryStore, indexPruneTargets, matchesPruneTargets, normalizePruneTargets } = await import(
  pathToFileURL(resolve('dist-electron/electron/library.js')).href
);
const { createSupportBackup, restoreSupportBackup } = await import(pathToFileURL(resolve('dist-electron/electron/support-backup.js')).href);
const { stopFfmpegReading, watchFfmpegInput } = await import(pathToFileURL(resolve('dist-electron/electron/transcode.js')).href);
const { trashErrorMessage, trashWithRetry, trashableTracks } = await import(pathToFileURL(resolve('dist-electron/electron/trash-tracks.js')).href);

function reading(path, dev) {
  return {
    path,
    title: path.split(/[\\/]/).pop(),
    artist: 'Trash Test',
    album: 'Album',
    albumArtist: 'Trash Test',
    trackNo: null,
    discNo: null,
    year: null,
    genre: null,
    duration: 100,
    bitrate: null,
    sampleRate: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 1,
    mtime: 1,
    art: null,
    dev,
  };
}

// --- rows leave by id -------------------------------------------------------
{
  const music = join(root, 'music');
  await mkdir(join(music, 'Lonely'), { recursive: true });
  await writeFile(join(music, 'loose.mp3'), 'keeps the root populated');
  const library = await LibraryStore.open(join(root, 'library.db'));
  const ids = (paths) => library.getTracksByPaths(paths).map((track) => track.id);

  // The last file of its folder, scanned before devices were recorded, and
  // deleted: the heuristic cannot prove it gone, a trash just asks for it.
  const lonely = join(music, 'Lonely', 'only.flac');
  await writeFile(lonely, 'x');
  const kept = join(music, 'kept.flac');
  await writeFile(kept, 'x');
  library.upsertTracks([reading(lonely, null), reading(kept, null)]);
  const [lonelyId] = ids([lonely]);
  const [keptId] = ids([kept]);
  await rm(lonely);
  library.recordPlay(lonelyId);
  library.recordPlay(keptId);
  library.saveTrackBookmark({ trackId: lonelyId, position: 10, label: 'Here' });
  const playlist = library.savePlaylist({ name: 'Mixed', trackIds: [lonelyId, keptId, lonelyId] });
  // Tag rows too: sql.js leaves the cascade to the code, and strays here
  // inflate the tag counts.
  library.saveTagRule({ name: 'trashy', body: 'tag(trashy) when artist = "Trash Test"' });
  library.recomputeTags();
  assert.deepEqual(library.getTagsForTrack(lonelyId), ['trashy']);
  assert.equal(library.pruneMissingTracks([lonely], [music]).removed, 0, 'the heuristic keeps the lonely row');
  assert.equal(ids([lonely]).length, 1);

  assert.deepEqual(library.removeTracksById([lonelyId, lonelyId, 987654, 0, -3]), [lonelyId], 'only rows that exist are reported, once');
  assert.equal(library.getTrack(lonelyId), null);
  assert.equal(library.getTrackBookmarks(lonelyId).length, 0);
  assert.equal(library.getListeningHistory({}).some((item) => item.trackId === lonelyId), false, 'its plays are gone');
  assert.deepEqual(library.getPlaylistTracks(playlist.id).map((track) => track.id), [keptId], 'its playlist places are gone, the rest stay');
  assert.deepEqual(library.getTagsForTrack(lonelyId), [], 'its tags are gone');
  assert.deepEqual(library.getTagSummaries().map((tag) => [tag.name, tag.trackCount]), [['trashy', 1]], 'and no longer counted');
  assert.equal(library.getTrack(keptId).playCount, 1, 'another row is untouched');
  assert.deepEqual(library.removeTracksById([]), []);
  assert.deepEqual(library.removeTracksById([lonelyId]), [], 'removing again removes nothing');

  // "Clean missing files" says which rows it removed, and says nothing when none did.
  const deleted = join(music, 'deleted.flac');
  await writeFile(deleted, 'x');
  library.upsertTracks([reading(deleted, null)]);
  const [deletedId] = ids([deleted]);
  await rm(deleted);
  const pruned = library.pruneMissingTracks(undefined, [music]);
  assert.deepEqual(pruned.removedIds, [deletedId]);
  assert.equal(pruned.removed, 1);
  assert.deepEqual(library.pruneMissingTracks(undefined, [music]), { checked: 1, removed: 0, offline: 0 }, 'no removedIds when nothing was removed');
  library.close();
}

// --- target matching ----------------------------------------------------------
{
  const music = join(root, 'match');
  const targets = indexPruneTargets(normalizePruneTargets([join(music, 'Artist'), join(music, 'loose.mp3'), join(music, 'Artist')]));
  assert.equal(targets.size, 2, 'duplicates collapse');
  const matches = (path) => matchesPruneTargets(path, targets);
  assert.equal(matches(join(music, 'Artist', 'Album', 'song.flac')), true, 'a file under a folder target');
  assert.equal(matches(join(music, 'Artist')), true, 'the folder itself');
  assert.equal(matches(join(music, 'Artist2', 'song.flac')), false, 'a sibling that shares a prefix');
  assert.equal(matches(join(music, 'loose.mp3')), true, 'a file target');
  assert.equal(matches(join(music, 'loose.mp3.bak')), false);
  assert.equal(matches(music), false, 'the parent of a target');
  assert.equal(matches(join(music, 'Artist', 'Album', 'song.flac').toUpperCase()), process.platform !== 'linux', 'case folds where the volume does');
  assert.equal(matchesPruneTargets(join(music, 'x.flac'), new Set()), false);
  const rootTarget = indexPruneTargets(normalizePruneTargets([process.platform === 'win32' ? 'Q:\\' : '/']));
  assert.equal(matchesPruneTargets(process.platform === 'win32' ? 'Q:\\a\\b.flac' : '/a/b.flac', rootTarget), true, 'a drive or filesystem root answers for everything on it');

  // 100k rows against 5k targets, the shape of a big trash or a dropped share.
  const paths = [];
  for (let i = 0; i < 100_000; i += 1) paths.push(join(music, `A${i % 200}`, `B${i % 50}`, `track-${i}.flac`));
  const many = [];
  for (let a = 0; a < 100; a += 1) for (let b = 0; b < 50; b += 1) many.push(join(music, `A${a}`, `B${b}`));
  // Normalizing stats each target, which is the filesystem's time, not the
  // matcher's.
  const normalized = normalizePruneTargets(many);
  const started = performance.now();
  const index = indexPruneTargets(normalized);
  let hits = 0;
  for (const path of paths) if (matchesPruneTargets(path, index)) hits += 1;
  const elapsed = performance.now() - started;
  assert.equal(hits, 50_000, 'half the rows sit under a target');
  assert.ok(elapsed < 1500, `100k rows x 5k targets took ${elapsed.toFixed(0)} ms`);
  console.log(`[trash-tracks-test] 100k rows x 5k targets: ${elapsed.toFixed(0)} ms`);
}

// --- the safety backup --------------------------------------------------------
{
  const userData = join(root, 'user-data');
  const settingsPath = join(userData, 'settings.json');
  const libraryPath = join(userData, 'library.db');
  await mkdir(join(userData, 'art'), { recursive: true });
  await mkdir(join(userData, 'playlist-art'), { recursive: true });
  for (let i = 0; i < 50; i += 1) await writeFile(join(userData, 'art', `cover-${i}.jpg`), `cover ${i}`);
  await writeFile(join(userData, 'playlist-art', 'icon.png'), 'icon');
  await writeFile(join(userData, 'podcasts.json'), '{}');
  await writeFile(settingsPath, JSON.stringify({ theme: 'classic' }));
  const library = await LibraryStore.open(libraryPath);
  library.flushSync?.();
  const snapshot = library.exportSnapshot();
  library.close();
  const input = { userDataPath: userData, settingsPath, libraryPath, librarySnapshot: snapshot, settingsSnapshot: JSON.stringify({ theme: 'from-backup' }) };
  const base = Date.parse('2026-05-15T03:45:00.000Z');

  const user = await createSupportBackup({ ...input, now: base - 60_000 });
  assert.ok(user.backupPath.includes('newamp-backup-') && !user.backupPath.includes('newamp-auto-backup-'));
  assert.ok(existsSync(join(user.backupPath, 'art', 'cover-7.jpg')), 'a user backup still carries the art stores');
  // A user backup that happens to be named like an automatic one, say copied
  // in by hand: its manifest says it isn't, so it stays.
  const lookalike = join(userData, 'backups', 'newamp-auto-backup-19990101-000000');
  await rename(user.backupPath, lookalike);

  const autos = [];
  for (let i = 0; i < 7; i += 1) {
    const auto = await createSupportBackup({ ...input, scope: 'library', now: base + i * 1000 });
    autos.push(auto);
    assert.deepEqual(auto.included, ['settings.json', 'library.db']);
    assert.ok(auto.backupPath.includes('newamp-auto-backup-'));
    assert.equal(existsSync(join(auto.backupPath, 'art')), false, 'no art in an automatic backup');
    assert.equal(existsSync(join(auto.backupPath, 'playlist-art')), false);
    assert.equal(existsSync(join(auto.backupPath, 'podcasts.json')), false);
    assert.equal(JSON.parse(await readFile(join(auto.backupPath, 'manifest.json'), 'utf8')).automatic, true);
  }
  const names = (await readdir(join(userData, 'backups'))).sort();
  const remaining = autos.filter((auto) => existsSync(auto.backupPath));
  assert.deepEqual(remaining.map((auto) => auto.createdAt), autos.slice(2).map((auto) => auto.createdAt), 'the two oldest automatic backups went, the newest five stay');
  assert.ok(existsSync(lookalike), 'a user backup is never pruned, whatever it is called');
  assert.equal(names.filter((name) => name.startsWith('newamp-auto-backup-')).length, 6, 'five automatic plus the lookalike');

  // A library-scope backup restores.
  const restored = await restoreSupportBackup({ userDataPath: userData, settingsPath, libraryPath, backupPath: autos[6].backupPath });
  assert.deepEqual(restored.restored, ['settings.json', 'library.db']);
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).theme, 'from-backup');
}

// --- stopping an ffmpeg that holds a file --------------------------------------
{
  const media = join(root, 'media');
  await mkdir(media, { recursive: true });
  const wav = join(media, 'held.wav');
  const made = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=90', wav], { encoding: 'utf8', windowsHide: true });
  assert.equal(made.status, 0, made.stderr);
  // Decoding into a pipe nobody reads: ffmpeg blocks on a full pipe with the
  // file open, the way the gapless decoder sits under backpressure.
  const held = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', wav, '-f', 'wav', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  held.stdout.pause();
  const other = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=90', '-f', 'wav', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  other.stdout.pause();
  watchFfmpegInput(held, wav);
  watchFfmpegInput(other, join(media, 'something-else.wav'));
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(held.exitCode, null, 'the decoder is still running on the file');
  if (process.platform === 'win32') {
    await assert.rejects(rename(wav, join(media, 'moved.wav')), 'Windows refuses to move a file ffmpeg has open');
  }
  // Keys fold case and slashes the way the cache keys do.
  const spelled = process.platform === 'win32' ? wav.toUpperCase().replace(/\\/g, '/') : wav;
  await stopFfmpegReading([spelled]);
  assert.ok(held.exitCode != null || held.signalCode != null, 'the decoder on the file was stopped');
  assert.equal(other.exitCode, null, 'a decoder on another file keeps running');
  await rename(wav, join(media, 'moved.wav'));
  assert.ok(existsSync(join(media, 'moved.wav')), 'the file can be moved once its reader is gone');
  other.kill();
  await new Promise((r) => other.once('exit', r));
}

// --- which of the requested tracks have a file to move ---------------------------
{
  const rows = new Map([
    [1, { id: 1, title: 'Alpha', path: 'K:/music/a.flac' }],
    [2, { id: 2, title: 'Radio', path: 'http://radio.example/live' }],
    [3, { id: 3, title: 'Cue', path: 'K:/music/album.flac', cueStart: 12 }],
  ]);
  const pick = (ids) => trashableTracks(ids, (id) => rows.get(id) ?? null);
  assert.deepEqual(pick([1, '1', 1.7, 2, 3, -5, 0, 404]), { supplied: true, tracks: [rows.get(1)] }, 'one row per id, files only');
  assert.deepEqual(pick([]), { supplied: false, tracks: [] }, 'an empty request is answered with nothing');
  assert.deepEqual(pick(undefined), { supplied: false, tracks: [] });
  // A CUE or podcast track (negative id) and a stream named on their own:
  // the handler answers these with a failure, not silence.
  assert.deepEqual(pick([-5]), { supplied: true, tracks: [] });
  assert.deepEqual(pick([2, 3]), { supplied: true, tracks: [] });
}

// --- the retry and the wording ---------------------------------------------------
{
  let calls = 0;
  await trashWithRetry('a', async () => {
    calls += 1;
    if (calls === 1) throw new Error('Operation was aborted');
  }, 1);
  assert.equal(calls, 2, 'one retry after a failure');
  calls = 0;
  await trashWithRetry('a', async () => { calls += 1; }, 1);
  assert.equal(calls, 1, 'no retry after success');
  await assert.rejects(
    trashWithRetry('a', async () => { throw new Error(`again ${++calls}`); }, 1),
    { message: 'again 3' },
    'the second failure is the one reported',
  );

  assert.match(trashErrorMessage(new Error('Operation was aborted'), 'Recycle Bin'), /in use, or its drive has no Recycle Bin/);
  assert.match(trashErrorMessage(new Error('EBUSY: resource busy or locked'), 'Trash'), /in use by another program/);
  assert.match(trashErrorMessage(new Error('ENOENT: no such file'), 'Trash'), /not found/);
  assert.equal(trashErrorMessage(new Error('Failed to move item to trash'), 'Trash'), 'Failed to move item to trash', 'unknown errors pass through');
  assert.equal(trashErrorMessage('', 'Trash'), 'The file could not be moved to the Trash.');
}

// --- what the menu offers and what the toasts say -------------------------------
{
  const bundled = await build({
    stdin: { contents: `export * from './src/lib/trashResult';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
  });
  const { canTrashTracks, describeTrashResult } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const a = { id: 1, title: 'Alpha', path: 'K:/music/a.flac' };
  const b = { id: 2, title: 'Beta', path: 'K:/music/b.flac' };
  const cue = { id: -5, title: 'Cue', path: 'K:/music/album.flac', cueStart: 12 };
  const podcast = { id: -3, title: 'Episode', path: 'https://example.com/ep.mp3' };
  const stream = { id: 9, title: 'Radio', path: 'http://radio.example/live' };
  assert.equal(canTrashTracks([a, b]), true);
  assert.equal(canTrashTracks([]), false);
  assert.equal(canTrashTracks([cue]), false, 'a CUE track has no file of its own');
  assert.equal(canTrashTracks([podcast]), false);
  assert.equal(canTrashTracks([stream]), false);
  assert.equal(canTrashTracks([a, cue]), false, 'one such track in the selection removes the item');

  const bin = 'Recycle Bin';
  assert.deepEqual(describeTrashResult({ trashed: 0, removed: 0, failed: [], cancelled: true }, [a], bin), []);
  assert.deepEqual(describeTrashResult({ trashed: 0, removed: 0, failed: [], cancelled: false, refused: 'Busy.' }, [a], bin), [{ tone: 'warn', title: 'Busy.' }]);
  assert.deepEqual(describeTrashResult({ trashed: 1, removed: 1, failed: [], cancelled: false, trashedIds: [1], removedIds: [1] }, [a], bin), [
    { tone: 'ok', title: 'Moved to the Recycle Bin', detail: 'Alpha. Gone from the library too.' },
  ]);
  assert.deepEqual(
    describeTrashResult({ trashed: 1, removed: 1, failed: [{ path: a.path, error: 'In use.' }], cancelled: false, trashedIds: [2], removedIds: [2] }, [a, b], bin),
    [
      { tone: 'warn', title: 'One file could not be moved to the Recycle Bin', detail: 'In use.' },
      { tone: 'ok', title: 'Moved to the Recycle Bin', detail: 'Beta. Gone from the library too.' },
    ],
    'the toast names the file that moved, not the first in the selection',
  );
  assert.deepEqual(describeTrashResult({ trashed: 2, removed: 1, failed: [], cancelled: false, trashedIds: [1, 2], removedIds: [1] }, [a, b], bin), [
    { tone: 'warn', title: 'Moved to the Recycle Bin', detail: '2 files. One is still in the library.' },
  ]);
  assert.deepEqual(describeTrashResult({ trashed: 0, removed: 1, failed: [], cancelled: false, trashedIds: [], removedIds: [2] }, [b], bin), [
    { tone: 'ok', title: 'Removed from the library', detail: 'Beta. Its file was not there to move.' },
  ]);
  assert.deepEqual(describeTrashResult({ trashed: 1, removed: 3, failed: [], cancelled: false, trashedIds: [1], removedIds: [1, 2, 3] }, [a, b, { id: 3, title: 'Gamma', path: 'K:/c.flac' }], bin), [
    { tone: 'ok', title: 'Moved to the Recycle Bin', detail: 'Alpha. Gone from the library too.' },
    { tone: 'ok', title: 'Removed from the library', detail: '2 tracks. Their files were not there to move.' },
  ]);
  assert.deepEqual(describeTrashResult({ trashed: 0, removed: 0, failed: [{ path: '', error: 'Not a library file.' }], cancelled: false }, [stream], bin), [
    { tone: 'warn', title: 'One file could not be moved to the Recycle Bin', detail: 'Not a library file.' },
  ]);
}

await rm(root, { recursive: true, force: true });
console.log('PASS trash tracks');
