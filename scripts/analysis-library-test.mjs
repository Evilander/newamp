// What the library keeps for the background analysis and for tempo:
//  - the SQL that lists tracks still owing work agrees, row for row, with the
//    rule the queue applies to one track (shared/analysis.ts)
//  - results are stored in the existing columns and survive a restart; fields
//    from the file's own tags are never overwritten; a rescan of an unchanged
//    file keeps them and a changed file starts over
//  - a BPM of 0 is unknown everywhere: the scanner stores nothing for it, a
//    library that already holds zeros is cleaned once, tempo filters and the
//    missing:bpm search treat it as unset
// Run: npm run build:electron && node scripts/analysis-library-test.mjs
import assert from 'node:assert/strict';
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner } from '../dist-electron/electron/scanner.js';
import { analysisWork, anyWork, ANALYSIS_VERSIONS } from '../dist-electron/shared/analysis.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'analysis-library-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const SQL = await initSqlJs();

function incoming(path, fields = {}) {
  return {
    path,
    title: path.split('/').pop(),
    artist: 'Test Artist',
    album: 'Test Album',
    albumArtist: 'Test Artist',
    trackNo: null,
    discNo: null,
    year: null,
    genre: null,
    duration: 100,
    bitrate: null,
    sampleRate: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    size: 1000,
    mtime: 1,
    art: null,
    ...fields,
  };
}

/** Edits library.db on disk between two opens. */
function editFile(file, fn) {
  const db = new SQL.Database(readFileSync(file));
  try {
    fn(db);
    writeFileSync(file, Buffer.from(db.export()));
  } finally {
    db.close();
  }
}

const DNA = { v: 1, framesAnalyzed: 10, secondsAnalyzed: 1, rms: 0.3, dynamicRange: 0.1, brightness: 0.4, flatness: 0.2, bands: [0.2, 0.2, 0.2, 0.2, 0.2], onsetDensity: 0.3, rolloff: 0.5 };

// 1. The SQL filter and the per-track rule agree.
{
  const file = join(root, 'parity', 'library.db');
  await mkdir(join(root, 'parity'), { recursive: true });
  const store = await LibraryStore.open(file);
  const names = [];
  const add = (name, fields) => {
    names.push(name);
    store.upsertTracks([incoming(`/music/parity/${name}.mp3`, fields)]);
  };
  add('empty', {});
  add('tags-all', { bpm: 128, key: 'Am', replayGainTrackDb: -7 });
  add('zero-bpm', { bpm: 0, key: 'C', replayGainTrackDb: -7 });
  add('tags-no-key', { bpm: 100, replayGainTrackDb: -7 });
  add('analysed-clean', {});
  add('analysed-old', {});
  add('failed-once', {});
  add('dna-current', { bpm: 90, key: 'D', replayGainTrackDb: -5 });
  add('dna-old', { bpm: 90, key: 'D', replayGainTrackDb: -5 });
  add('dna-broken', { bpm: 90, key: 'D', replayGainTrackDb: -5 });
  add('record-broken', { bpm: 90, key: 'D', replayGainTrackDb: -5 });
  const idOf = (name) => store.getTracks({ search: `${name}` }).find((t) => t.path.endsWith(`/${name}.mp3`)).id;
  const ids = Object.fromEntries(names.map((name) => [name, idOf(name)]));
  store.saveAnalysis([
    { id: ids['analysed-clean'], bpm: 120, key: 'Em', replayGainTrackDb: -9, integratedLufs: -9, dna: DNA, touched: ['loud', 'bpm', 'key', 'dna'] },
    { id: ids['analysed-old'], bpm: 120, key: 'Em', replayGainTrackDb: -9, dna: DNA, touched: ['loud', 'bpm', 'key', 'dna'] },
    { id: ids['failed-once'], touched: ['loud', 'bpm', 'key', 'dna'] },
    { id: ids['dna-current'], dna: DNA, touched: ['dna'] },
    { id: ids['dna-old'], dna: DNA, touched: ['dna'] },
    { id: ids['dna-broken'], dna: DNA, touched: ['dna'] },
    // Tag values, and DNA so only the tempo or key is in question.
    { id: ids['tags-all'], dna: DNA, touched: ['dna'] },
    { id: ids['zero-bpm'], dna: DNA, touched: ['dna'] },
    { id: ids['tags-no-key'], dna: DNA, touched: ['dna'] },
    { id: ids['record-broken'], dna: DNA, touched: ['dna'] },
  ]);
  store.flushNow();
  store.close();
  editFile(file, (db) => {
    // The old analyzer: the record says version 0 for what it wrote.
    db.run(`UPDATE tracks SET analysis_json = '{"loud":0,"bpm":0,"key":1,"dna":1}' WHERE path LIKE '%/analysed-old.mp3'`);
    db.run(`UPDATE tracks SET dna_json = '{"v":0}' WHERE path LIKE '%/dna-old.mp3'`);
    db.run(`UPDATE tracks SET dna_json = 'not json' WHERE path LIKE '%/dna-broken.mp3'`);
    db.run(`UPDATE tracks SET analysis_json = '{{{' WHERE path LIKE '%/record-broken.mp3'`);
  });

  const reopened = await LibraryStore.open(file);
  const pending = new Set(reopened.pendingAnalysisIds());
  const expected = {
    empty: true,
    'tags-all': false,
    'zero-bpm': true,
    'tags-no-key': true,
    'analysed-clean': false,
    'analysed-old': true,
    'failed-once': false,
    'dna-current': false,
    'dna-old': true,
    'dna-broken': true,
    'record-broken': false,
  };
  for (const name of names) {
    const target = reopened.analysisTarget(ids[name]);
    assert.equal(pending.has(ids[name]), expected[name], `${name}: the SQL filter says ${expected[name] ? 'owed' : 'done'}`);
    assert.equal(target != null, expected[name], `${name}: the per-track rule agrees with the SQL`);
  }
  // What each track is asked for.
  assert.deepEqual(reopened.analysisTarget(ids['zero-bpm']).work, { loud: false, bpm: true, key: false, dna: false }, 'a zero tempo is worked out, a tag key and gain are left');
  assert.deepEqual(reopened.analysisTarget(ids['tags-no-key']).work, { loud: false, bpm: false, key: true, dna: false });
  assert.deepEqual(reopened.analysisTarget(ids.empty).work, { loud: true, bpm: true, key: true, dna: true });
  assert.deepEqual(reopened.analysisTarget(ids['analysed-old']).work, { loud: true, bpm: true, key: false, dna: false }, 'old analysis is redone field by field; the key at the current version stays');
  assert.equal(reopened.analysisTarget(ids['dna-old']).work.dna, true, 'DNA from an older analyzer is redone');
  reopened.close();
}

// 2. Saving: the columns, the record, a restart, tags untouched, slow flush.
{
  const file = join(root, 'save', 'library.db');
  await mkdir(join(root, 'save'), { recursive: true });
  const store = await LibraryStore.open(file);
  store.upsertTracks([
    incoming('/music/save/a.mp3'),
    incoming('/music/save/b.mp3', { bpm: 128 }),
    incoming('/music/save/c.mp3'),
  ]);
  const [a, b, c] = ['a', 'b', 'c'].map((n) => store.getTracks({}).find((t) => t.path.endsWith(`/${n}.mp3`)).id);
  assert.equal(store.pendingAnalysisIds().length, 3);
  store.saveAnalysis([
    { id: a, bpm: 101.5, key: 'F#m', replayGainTrackDb: -6.25, integratedLufs: -11.84, dna: DNA, touched: ['loud', 'bpm', 'key', 'dna'] },
    // Tempo came from the tag: only the key is asked for and written.
    { id: b, key: 'C', touched: ['key'] },
  ]);
  const trackA = store.getTrack(a);
  assert.equal(trackA.bpm, 101.5);
  assert.equal(trackA.key, 'F#m');
  assert.equal(trackA.replayGainTrackDb, -6.25);
  assert.deepEqual(store.getTrackDna(a), DNA);
  assert.equal(store.getTrack(b).bpm, 128, 'the tag tempo is kept');
  assert.equal(store.getTrack(b).key, 'C');
  store.flushNow();
  store.close();

  const again = await LibraryStore.open(file);
  assert.equal(again.getTrack(a).bpm, 101.5, 'results survive a restart');
  assert.deepEqual(again.pendingAnalysisIds().sort(), [b, c].sort(), 'a restart owes only what is left: b still owes gain and DNA, c everything');
  assert.equal(again.analysisTarget(a), null);
  const record = JSON.parse(
    (() => {
      const db = new SQL.Database(readFileSync(file));
      try {
        return db.exec(`SELECT analysis_json FROM tracks WHERE id = ${a}`)[0].values[0][0];
      } finally {
        db.close();
      }
    })(),
  );
  assert.deepEqual(record, { loud: ANALYSIS_VERSIONS.loud, bpm: ANALYSIS_VERSIONS.tempo, key: ANALYSIS_VERSIONS.tempo, dna: ANALYSIS_VERSIONS.dna, lufs: -11.8 }, 'the record carries the versions and the measured loudness');

  // 3. Rescans: unchanged keeps the analysis, changed starts over, a tag wins.
  again.upsertTracks([incoming('/music/save/a.mp3')]);
  assert.equal(again.getTrack(a).bpm, 101.5, 'a rescan of an unchanged file keeps the analysed tempo');
  assert.equal(again.getTrack(a).replayGainTrackDb, -6.25);
  assert.deepEqual(again.getTrackDna(a), DNA);
  assert.equal(again.analysisTarget(a), null);
  again.upsertTracks([incoming('/music/save/a.mp3', { bpm: 140 })]);
  assert.equal(again.getTrack(a).bpm, 140, 'a tempo in the tags replaces the analysed one');
  again.upsertTracks([incoming('/music/save/a.mp3', { mtime: 2, size: 2000 })]);
  const changed = again.getTrack(a);
  assert.equal(changed.bpm, null, 'a changed file loses the analysed values');
  assert.equal(changed.key, null);
  assert.equal(changed.replayGainTrackDb, null);
  assert.equal(again.getTrackDna(a), null);
  assert.deepEqual(again.analysisTarget(a).work, { loud: true, bpm: true, key: true, dna: true }, 'and owes everything again, so it rejoins the queue');

  // 4. Counts for the progress line.
  const counts = again.analysisCounts();
  assert.equal(counts.total, 3);
  assert.equal(counts.owed, 3);
  assert.deepEqual(counts.coverage, { tempo: 1, key: 1, loudness: 0, dna: 0 });
  again.close();
}

// 5. A BPM of 0 is unknown.
{
  const file = join(root, 'zero', 'library.db');
  await mkdir(join(root, 'zero'), { recursive: true });
  const store = await LibraryStore.open(file);
  store.upsertTracks([
    incoming('/music/zero/unset.mp3', { bpm: 0 }),
    incoming('/music/zero/none.mp3'),
    incoming('/music/zero/slow.mp3', { bpm: 70 }),
    incoming('/music/zero/mid.mp3', { bpm: 100 }),
    incoming('/music/zero/fast.mp3', { bpm: 130 }),
  ]);
  store.flushNow();
  store.close();
  // A library from before this change: zeros stored, and no record that they were cleaned.
  editFile(file, (db) => {
    db.run(`UPDATE tracks SET bpm = 0 WHERE path LIKE '%/unset.mp3'`);
    db.run(`DELETE FROM library_meta WHERE key = 'bpm_zero_cleared_v1'`);
  });

  const fresh = await LibraryStore.open(file);
  const names = (tracks) => tracks.map((t) => t.path.split('/').pop()).sort();
  const run = (rule) => names(fresh.runSmartPlaylistRule({ name: 'T', mood: 'focus', count: 50, ...rule }));
  assert.equal(fresh.getTracks({}).find((t) => t.path.endsWith('/unset.mp3')).bpm, null, 'a stored zero reads as unknown once the library is opened');
  assert.deepEqual(run({ maxBpm: 95 }), ['slow.mp3'], '"slow" does not pick up tracks with no tempo');
  assert.deepEqual(run({ minBpm: 118 }), ['fast.mp3']);
  assert.deepEqual(run({ minBpm: 90, maxBpm: 125 }), ['mid.mp3']);
  assert.deepEqual(names(fresh.getTracks({ search: 'missing:bpm' })), ['none.mp3', 'unset.mp3'], 'missing:bpm lists tracks with no usable tempo');
  fresh.close();
  const cleaned = new SQL.Database(readFileSync(file));
  try {
    assert.equal(cleaned.exec(`SELECT COUNT(*) FROM tracks WHERE bpm = 0`)[0].values[0][0], 0, 'the zeros are gone from the file');
  } finally {
    cleaned.close();
  }

  // A zero that is already in the table and survives (a library opened before the cleanup ran) still must not count as a tempo.
  const raw = await LibraryStore.open(file);
  raw.upsertTracks([incoming('/music/zero/late.mp3', { bpm: 0 })]);
  assert.equal(raw.getTracks({}).find((t) => t.path.endsWith('/late.mp3')).bpm, null, 'a track read with bpm 0 is unknown');
  assert.deepEqual(names(raw.runSmartPlaylistRule({ name: 'T', mood: 'focus', count: 50, maxBpm: 95 })), ['slow.mp3'], 'and is not picked by "slow"');
  assert.equal(raw.analysisTarget(raw.getTracks({}).find((t) => t.path.endsWith('/late.mp3')).id).work.bpm, true, 'the analysis works its tempo out');
  assert.ok(names(raw.getTracks({ search: 'missing:bpm' })).includes('late.mp3'), 'missing:bpm lists a track whose stored tempo is 0');
  assert.deepEqual(
    names(raw.runSmartPlaylistRule({ name: 'T', mood: 'focus', count: 50, minBpm: 0 })),
    ['fast.mp3', 'mid.mp3', 'slow.mp3'],
    'a tempo floor of 0 still means a known tempo',
  );
  raw.close();
}

// 6. The scanner stores nothing for a BPM tag of 0.
if (!ffmpeg) throw new Error('ffmpeg-static did not resolve a binary');
{
  const music = join(root, 'scan', 'music');
  await mkdir(music, { recursive: true });
  for (const [name, bpm] of [['unset', '0'], ['set', '128']]) {
    const made = spawnSync(
      ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-metadata', `title=${name}`, '-metadata', 'artist=Scan Test', '-metadata', `BPM=${bpm}`, '-c:a', 'flac', join(music, `${name}.flac`)],
      { encoding: 'utf8' },
    );
    assert.equal(made.status, 0, made.stderr);
  }
  const store = await LibraryStore.open(join(root, 'scan', 'library.db'));
  const scanner = new Scanner(store, () => undefined);
  await scanner.start([music]);
  const byTitle = Object.fromEntries(store.getTracks({}).map((t) => [t.title, t]));
  assert.equal(byTitle.set.bpm, 128, 'a real tempo tag is stored');
  assert.equal(byTitle.unset.bpm, null, 'a tag of 0 is not');
  store.flushNow();
  const onDisk = new SQL.Database(readFileSync(join(root, 'scan', 'library.db')));
  try {
    const stored = Object.fromEntries(onDisk.exec(`SELECT title, bpm FROM tracks`)[0].values);
    assert.equal(stored.unset, null, 'nothing is stored for it, so a rescan cannot bring a zero back');
    assert.equal(stored.set, 128);
  } finally {
    onDisk.close();
  }
  scanner.cancel();
  store.close();
}

console.log('[analysis-library] PASS');
