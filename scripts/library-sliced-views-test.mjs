// Home, Discover, Mixes and Folders used to freeze the main process for up to a
// second per visit because each one ran its queries in a single turn. They now
// run in slices, and what they work out is kept until the library changes.
// This checks that the answers did not change, that nothing kept goes stale,
// and that the slicing does what it is for.
//
// Run: node scripts/library-sliced-views-test.mjs
//   NEWAMP_DIST=<dir>   test another build of the electron folder
//   --print-golden      print the answer fingerprints (used to record GOLDEN
//                       from the build before the change; only needs the
//                       synchronous methods)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const printGolden = process.argv.includes('--print-golden');
const dist = resolve(process.env.NEWAMP_DIST ?? 'dist-electron');
const load = (file) => import(pathToFileURL(join(dist, file)).href);
const { LibraryStore } = await load('electron/library.js');
const { AUDIO_DNA_VERSION } = await load('shared/audio-dna.js');

const work = resolve('tmp', 'library-sliced-views-test');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const NOW = Date.UTC(2026, 4, 17, 12, 0, 0);
const ROOTS = ['K:/music'];
const DAY = 24 * 60 * 60 * 1000;

// -- fixture ----------------------------------------------------------------
// A small library with the awkward parts of a real one: tracks in a root
// folder and in deep ones, the same folder spelled with either slash, doubled
// separators, a second drive, a drive root, ties on every sort key, tracks
// with no tags, short tracks, avoided and unplayed ones.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fixtureTracks() {
  const random = mulberry32(20261015);
  const genres = ['Rock', 'Jazz', 'Ambient', 'Electronic', 'Dream Pop', 'Soul', null];
  const keys = ['C', 'A minor', '8B', '9A', 'F#', null, null];
  const out = [];
  const add = (path, artist, album, n) => {
    out.push({
      path,
      title: n % 9 === 0 ? 'Intro' : `Song ${String(n).padStart(2, '0')}`,
      artist,
      album,
      albumArtist: artist,
      trackNo: (n % 12) + 1,
      discNo: n % 5 === 0 ? 2 : null,
      year: 1970 + Math.floor(random() * 55),
      genre: genres[Math.floor(random() * genres.length)],
      duration: n % 23 === 0 ? 12 : n % 31 === 0 ? null : 60 + Math.floor(random() * 300),
      bitrate: n % 7 === 0 ? 900000 : 320000,
      sampleRate: n % 7 === 0 ? 96000 : 44100,
      bpm: random() < 0.5 ? 70 + Math.floor(random() * 90) : null,
      key: keys[Math.floor(random() * keys.length)],
      replayGainTrackDb: null,
      replayGainAlbumDb: null,
      size: 4_000_000 + (n % 40) * 1000,
      mtime: NOW - Math.floor(random() * 400) * DAY,
      art: n % 3 === 0 ? { mime: 'image/png', data: Buffer.from(`art-${album}`) } : null,
    });
  };
  let n = 0;
  for (let a = 1; a <= 24; a += 1) {
    const artist = `Artist ${String(a).padStart(2, '0')}`;
    for (let b = 1; b <= 3; b += 1) {
      const album = `Album ${b}`;
      for (let t = 1; t <= 8; t += 1) {
        n += 1;
        // Three spellings of the same folders.
        const base = a % 7 === 0 ? 'K:/music' : a % 11 === 0 ? 'K:\\\\music' : 'K:\\music';
        const sep = base.includes('/') ? '/' : '\\';
        const disc = b === 3 && t > 4 ? `${sep}Disc 2` : '';
        add(`${base}${sep}${artist}${sep}${album}${disc}${sep}${String(t).padStart(2, '0')} Song.flac`, artist, album, n);
      }
    }
  }
  for (let i = 1; i <= 6; i += 1) add(`K:\\music\\Loose ${i}.mp3`, 'Loose Artist', '', 900 + i);
  for (let i = 1; i <= 5; i += 1) add(`L:\\incoming\\Loose\\Other ${i}.mp3`, 'Incoming', 'Drop', 950 + i);
  add('M:\\root.mp3', 'Drive Root', 'Alone', 990);
  // Duplicates for the health check.
  add('K:\\music\\Artist 01\\Album 1\\Copy Song.flac', 'Artist 01', 'Album 1', 1);
  return out;
}

async function openFixture(name) {
  const folder = join(work, name);
  mkdirSync(folder, { recursive: true });
  const library = await LibraryStore.open(join(folder, 'library.db'));
  library.upsertTracks(fixtureTracks());
  await library.albumsReady?.();
  const tracks = library.getTracks({ sort: 'album', limit: 1000 });
  // History, loves, ratings, skips, avoided tracks.
  tracks.forEach((track, i) => {
    if (i % 4 === 0) library.toggleLove(track.id);
    if (i % 5 === 0) library.setTrackRating(track.id, 1 + (Math.floor(i / 5) % 5));
    if (i % 6 === 0) for (let p = 0; p <= i % 4; p += 1) library.recordPlay(track.id, NOW - (i + p * 7) * DAY);
    if (i % 17 === 0) library.recordSkip(track.id, NOW - i * 60_000, 12);
    if (i % 41 === 0) library.toggleAvoidAutoPlay(track.id);
  });
  return { library, folder, tracks };
}

// -- what the views ask for -------------------------------------------------
const MIX_SEED = (tracks) => tracks.find((t) => t.bpm && t.key)?.id ?? tracks[0].id;
const folderPaths = ['K:\\music\\Artist 01', 'K:/music/Artist 07/Album 3', 'K:\\music\\Artist 11\\Album 1', 'M:\\', 'K:\\music', 'L:\\incoming', 'K:\\music\\Artist 02\\Album 3'];

function calls(seedId) {
  return {
    health: (l, mode) => run(l, mode, 'getLibraryHealth'),
    suggestions: (l, mode) => run(l, mode, 'getSuggestedSmartPlaylistRules'),
    harmonic: (l, mode) => run(l, mode, 'buildHarmonicMix', { count: 20 }),
    harmonicSeeded: (l, mode) => run(l, mode, 'buildHarmonicMix', { seedTrackId: seedId, count: 12 }),
    harmonicGenre: (l, mode) => run(l, mode, 'buildHarmonicMix', { genreQuery: 'rock', count: 15 }),
    taste: (l, mode) => run(l, mode, 'buildTasteMix', { count: 20 }),
    tasteSeeded: (l, mode) => run(l, mode, 'buildTasteMix', { seedTrackId: seedId, count: 12 }),
    deepCuts: (l, mode) => run(l, mode, 'runSmartPlaylistRule', { name: 'Mixes Deep Cuts', mood: 'deep-cuts', count: 12, unplayedOnly: true }),
    night: (l, mode) => run(l, mode, 'runSmartPlaylistRule', { name: 'Mixes Night Drive', mood: 'night', count: 12, minRating: 3 }),
    discover: (l, mode) => run(l, mode, 'getDiscoverSurface', { seed: 'fixture', limit: 8, seedTrackId: seedId, now: NOW }),
    discoverPlain: (l, mode) => run(l, mode, 'getDiscoverSurface', { seed: 'fixture', limit: 12, lowEndMode: true, now: NOW }),
    foldersRoots: (l, mode) => run(l, mode, 'getFolders', null, ROOTS),
    foldersDerived: (l, mode) => run(l, mode, 'getFolders', null, []),
    ...Object.fromEntries(
      folderPaths.flatMap((path, i) => [
        [`foldersIn${i}`, (l, mode) => run(l, mode, 'getFolders', path, ROOTS)],
        [`folderTracks${i}`, (l, mode) => run(l, mode, 'getFolderTracks', path, { recursive: false })],
        [`folderTracksDeep${i}`, (l, mode) => run(l, mode, 'getFolderTracks', path, { recursive: true, limit: 7, offset: 2 })],
      ]),
    ),
  };
}

// 'sync' is the method the smokes call; 'sliced' the one the IPC handler calls.
async function run(library, mode, name, ...input) {
  const value = mode === 'sliced' ? await library[`${name}Async`](...input) : library[name](...input);
  return scrub(value);
}

function scrub(value) {
  return JSON.parse(JSON.stringify(value, (key, inner) => (key === 'generatedAt' ? undefined : inner)));
}

const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

async function allOutputs(library, seedId, mode) {
  const out = {};
  for (const [name, call] of Object.entries(calls(seedId))) out[name] = await call(library, mode);
  return out;
}

// Recorded from the build before the change (node scripts/library-sliced-views-test.mjs --print-golden
// with NEWAMP_DIST pointing at it). The same library, the same answers.
const GOLDEN = {
  health: '47ace458cd82882e',
  suggestions: '71515a3013ca4b4b',
  harmonic: 'b5508aa2c5b99850',
  harmonicSeeded: '9b9d970b6ddd1524',
  harmonicGenre: '9d19a578a35fe2c8',
  taste: '08a93e24dafba03e',
  tasteSeeded: '43bed348695f0d0f',
  deepCuts: '96f26a2761c060d8',
  night: '1959bb8a2e8fe61b',
  discover: 'b2b12d7e325a6a13',
  discoverPlain: '6ec89d831c1bde28',
  foldersRoots: '592b46143b336524',
  foldersDerived: '356ce55c379fda34',
  foldersIn0: 'a268be5926c2c6b7',
  folderTracks0: '4f53cda18c2baa0c',
  folderTracksDeep0: '5b469e042b207b46',
  foldersIn1: 'e5a855ec32c8d39e',
  folderTracks1: '43d9018370895d79',
  folderTracksDeep1: '342d18043be60011',
  foldersIn2: '4f53cda18c2baa0c',
  folderTracks2: '4f53cda18c2baa0c',
  folderTracksDeep2: '4f53cda18c2baa0c',
  foldersIn3: '4f53cda18c2baa0c',
  folderTracks3: 'ae596b7e1cf9c727',
  folderTracksDeep3: '4f53cda18c2baa0c',
  foldersIn4: '4e30fa7a3f0e677f',
  folderTracks4: '58f40664ff74362e',
  folderTracksDeep4: '5b469e042b207b46',
  foldersIn5: 'a451ac815be772c4',
  folderTracks5: '4f53cda18c2baa0c',
  folderTracksDeep5: '9adea347ba495e33',
  foldersIn6: '2fb91ec299d4fd38',
  folderTracks6: '2487c416e831370b',
  folderTracksDeep6: '635da41d66238399',
};

// -- tests ------------------------------------------------------------------
const results = [];
async function test(name, body) {
  try {
    await body();
    results.push(`PASS ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}\n${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  }
}

if (printGolden) {
  const { library, tracks } = await openFixture('golden');
  const outputs = await allOutputs(library, MIX_SEED(tracks), 'sync');
  console.log('const GOLDEN = {');
  for (const [name, value] of Object.entries(outputs)) console.log(`  ${name}: '${fingerprint(value)}',`);
  console.log('};');
  library.close();
  process.exit(0);
}

const { DerivedCache } = await load('electron/derived-cache.js');
const { runSync, runSliced } = await load('electron/sliced.js');

const main = await openFixture('main');
const seedId = MIX_SEED(main.tracks);

await test('answers match the build before the change', async () => {
  const outputs = await allOutputs(main.library, seedId, 'sync');
  const names = Object.keys(outputs);
  assert.ok(names.length > 30, 'the fixture covers the views');
  const mismatched = names.filter((name) => fingerprint(outputs[name]) !== GOLDEN[name]);
  assert.deepEqual(mismatched, [], `unchanged answers; differing: ${mismatched.join(', ')}`);
});

await test('the sliced methods return what the synchronous ones do', async () => {
  const sync = await allOutputs(main.library, seedId, 'sync');
  const sliced = await allOutputs(main.library, seedId, 'sliced');
  for (const name of Object.keys(sync)) assert.deepEqual(sliced[name], sync[name], name);
  // And again, now served from what was kept.
  const again = await allOutputs(main.library, seedId, 'sliced');
  for (const name of Object.keys(sync)) assert.deepEqual(again[name], sync[name], `${name} (kept)`);
});

await test('the fixture exercises the cases it is meant to', async () => {
  const sync = await allOutputs(main.library, seedId, 'sync');
  assert.ok(sync.health.duplicateGroups.length > 0, 'duplicate groups');
  assert.ok(sync.harmonicSeeded.length > 1 && sync.tasteSeeded.length > 1, 'seeded mixes');
  assert.ok(sync.deepCuts.length > 0 && sync.night.length >= 0, 'rule mixes');
  assert.ok(sync.discover.cards.length > 0 && sync.discover.missions.length > 0, 'discover picks');
  assert.ok(sync.foldersRoots.length === 1 && sync.foldersRoots[0].totalTrackCount > 100, 'a configured root');
  assert.ok(sync.foldersDerived.length >= 3, 'derived roots across drives');
  assert.ok(sync.foldersIn5.length > 0 && sync.folderTracks1.length > 0, 'nested folders resolve');
  assert.equal(sync.foldersIn3.length, 0, 'a drive root with only a file in it has no subfolders');
});

await test('folder summaries agree with a plain tree walk', async () => {
  const rows = main.library.getTracks({ limit: 1000, sort: 'added' }).map((t) => ({ id: t.id, path: t.path, duration: t.duration, hasArt: t.hasArt }));
  rows.sort((a, b) => a.id - b.id);
  const fold = (path) => path.replace(/\//g, '\\').replace(/\\{2,}/g, '\\').toLowerCase();
  const dirs = rows.map((row) => ({ ...row, dir: fold(row.path).replace(/\\[^\\]*$/, '') }));
  const wanted = 'k:\\music';
  const below = dirs.filter((row) => row.dir.startsWith(`${wanted}\\`));
  const children = new Map();
  for (const row of below) {
    const name = row.dir.slice(wanted.length + 1).split('\\')[0];
    const entry = children.get(name) ?? { total: 0, direct: 0, duration: 0, art: null, deeper: new Set() };
    entry.total += 1;
    entry.duration += Math.max(0, row.duration ?? 0);
    if (entry.art == null && row.hasArt) entry.art = row.id;
    const rest = row.dir.slice(wanted.length + 1 + name.length);
    if (!rest) entry.direct += 1;
    else entry.deeper.add(rest.split('\\')[1]);
    children.set(name, entry);
  }
  const summaries = await main.library.getFoldersAsync('K:/music', ROOTS);
  assert.equal(summaries.length, children.size);
  for (const summary of summaries) {
    const expected = children.get(summary.name.toLowerCase());
    assert.ok(expected, summary.name);
    assert.equal(summary.totalTrackCount, expected.total, `${summary.name} total`);
    assert.equal(summary.trackCount, expected.direct, `${summary.name} direct`);
    assert.equal(summary.childFolderCount, expected.deeper.size, `${summary.name} children`);
    assert.equal(summary.artFromTrackId, expected.art, `${summary.name} art`);
    assert.ok(Math.abs(summary.duration - expected.duration) < 1e-6, `${summary.name} duration`);
  }
});

await test('rows read for the views are the same objects getAsObject gave', async () => {
  const sql = 'SELECT * FROM tracks ORDER BY id';
  const stmt = main.library.db.prepare(sql);
  const expected = [];
  while (stmt.step()) expected.push(stmt.getAsObject());
  stmt.free();
  assert.deepStrictEqual(main.library.many(sql), expected);
  assert.deepStrictEqual(main.library.many('SELECT 1 WHERE 0'), []);
});

// -- what is kept, and when it is dropped ------------------------------------
function watchStatements(library) {
  const seen = [];
  const prepare = library.db.prepare.bind(library.db);
  library.db.prepare = (sql, ...rest) => {
    seen.push(String(sql));
    return prepare(sql, ...rest);
  };
  return {
    seen,
    reset: () => seen.splice(0, seen.length),
    stop: () => {
      library.db.prepare = prepare;
    },
  };
}

await test('a second visit is served from what was kept, without touching the database', async () => {
  const { library, tracks } = await openFixture('kept');
  const seed = MIX_SEED(tracks);
  const spy = watchStatements(library);
  const everything = calls(seed);
  const viewCalls = ['health', 'suggestions', 'harmonic', 'harmonicSeeded', 'taste', 'tasteSeeded', 'deepCuts', 'night', 'discover', 'foldersRoots', 'foldersIn4'];
  for (const name of viewCalls) await everything[name](library, 'sliced');
  spy.reset();
  for (const name of viewCalls) await everything[name](library, 'sliced');
  assert.deepEqual(spy.seen, [], 'nothing was read the second time');
  spy.stop();
  library.close();
});

await test('a first call defers its work to a later turn', async () => {
  const { library } = await openFixture('deferred');
  const spy = watchStatements(library);
  const pending = [
    library.getLibraryHealthAsync(),
    library.buildTasteMixAsync({ count: 12 }),
    library.getDiscoverSurfaceAsync({ seed: 'x', now: NOW }),
    library.getFoldersAsync(null, ROOTS),
  ];
  assert.deepEqual(spy.seen, [], 'nothing ran inside the calls themselves');
  await Promise.all(pending);
  assert.ok(spy.seen.length > 0);
  spy.stop();
  library.close();
});

// A change of each kind, and the views that show it. After each one, every
// answer the sliced methods give (after they had been asked once and kept) has
// to be what a library opened fresh from the saved file works out.
async function freshAnswers(library, folder, seed, label) {
  library.flushNow();
  const copy = join(folder, `fresh-${label}.db`);
  copyFileSync(join(folder, 'library.db'), copy);
  const fresh = await LibraryStore.open(copy);
  await fresh.albumsReady?.();
  try {
    return await allOutputs(fresh, seed, 'sync');
  } finally {
    fresh.close();
  }
}

const dnaOf = (rms) => ({ v: AUDIO_DNA_VERSION, bands: [0.1, 0.2, 0.3, 0.2, 0.1], rms, brightness: 0.4, flatness: 0.2, dynamicRange: 0.5, onsetDensity: 0.3, rolloff: 0.6 });
const aTrack = (path, extra = {}) => ({
  path,
  title: 'Brand New',
  artist: 'Newcomer',
  album: 'First Light',
  albumArtist: 'Newcomer',
  trackNo: 1,
  discNo: null,
  year: 2026,
  genre: 'Rock',
  duration: 200,
  bitrate: 320000,
  sampleRate: 44100,
  bpm: 120,
  key: 'C',
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
  size: 5_000_000,
  mtime: NOW,
  art: null,
  ...extra,
});

const mutations = [
  ['a rating', (l, t, answers) => { for (const track of answers.taste.slice(0, 5)) l.setTrackRating(track.id, 1); for (const track of answers.taste.slice(10, 20)) l.setTrackRating(track.id, 5); }, 'taste'],
  ['a love', (l, t, answers) => { for (const track of answers.taste.slice(0, 10)) l.toggleLove(track.id); }, 'taste'],
  ['a play', (l, t, answers) => { for (const track of answers.deepCuts) l.recordPlay(track.id, NOW); }, 'deepCuts'],
  ['a skip', (l, t, answers) => { for (const track of answers.taste.slice(0, 8)) for (let i = 0; i < 6; i += 1) l.recordSkip(track.id, NOW - i, 5); }, 'taste'],
  ['an avoid flag', (l, t, answers) => { for (const track of answers.taste.slice(0, 5)) l.toggleAvoidAutoPlay(track.id); }, 'taste'],
  ['a new track from a scan', (l) => l.upsertTracks([aTrack('K:\\music\\Newcomer\\First Light\\01 Brand New.flac')]), 'foldersIn4'],
  ['a changed file from a scan', (l, t) => l.upsertTracks([aTrack(t[10].path, { title: t[10].title, artist: t[10].artist, album: t[10].album, albumArtist: t[10].albumArtist, duration: 999, art: { mime: 'image/png', data: Buffer.from('changed') }, mtime: NOW })]), 'foldersIn4'],
  ['a removal', (l, t) => l.removeTracksById(t.slice(30, 60).map((x) => x.id)), 'foldersRoots'],
  ['a replay gain write', (l, t) => { for (const track of t.slice(0, 30)) l.setTrackReplayGain(track.id, -6, -6); }, 'health'],
  ['a tag edit', (l, t, answers) => { l.applyManualMetadataPatch(answers.harmonic[0].id, { artist: 'Edited Artist', genre: 'Rock' }); }, 'harmonic'],
  ['an album rating', (l, t, answers) => { for (const track of answers.taste.slice(10, 20)) l.setAlbumRatingScore(track.albumArtist, track.album, 100); }, 'taste'],
  ['track DNA', (l, t, answers) => { for (const track of [...t.slice(0, 80), answers.harmonicSeeded[0]]) l.setTrackDna(track.id, dnaOf(0.1 + (track.id % 10) / 12)); }, 'harmonicSeeded'],
];

for (const [label, change, mostLikelyToMove] of mutations) {
  await test(`nothing kept is stale after ${label}`, async () => {
    const { library, folder, tracks } = await openFixture(`mut-${label.replace(/\W+/g, '-')}`);
    const seed = MIX_SEED(tracks);
    const before = await allOutputs(library, seed, 'sliced');
    await allOutputs(library, seed, 'sliced');
    await change(library, tracks, before);
    const after = await allOutputs(library, seed, 'sliced');
    const fresh = await freshAnswers(library, folder, seed, 'a');
    const stale = Object.keys(fresh).filter((name) => JSON.stringify(after[name]) !== JSON.stringify(fresh[name]));
    assert.deepEqual(stale, [], `answers that did not follow the change: ${stale.join(', ')}`);
    const moved = Object.keys(fresh).filter((name) => JSON.stringify(before[name]) !== JSON.stringify(fresh[name]));
    assert.ok(moved.length > 0, `${label} changed some answer, or this proves nothing`);
    assert.ok(moved.includes(mostLikelyToMove), `${label} moves ${mostLikelyToMove} (moved: ${moved.join(', ')})`);
    library.close();
  });
}

await test('a play drops the mixes and health but not the folder index, a scan drops the folder index', async () => {
  const { library, tracks } = await openFixture('targeted');
  const seed = MIX_SEED(tracks);
  const spy = watchStatements(library);
  await allOutputs(library, seed, 'sliced');
  const scansLibrary = (sql) => /WHERE id > \?/.test(sql);

  spy.reset();
  library.recordPlay(tracks[2].id, NOW);
  await library.getFoldersAsync(null, ROOTS);
  await library.getFoldersAsync('K:\\music\\Artist 01', ROOTS);
  assert.deepEqual(spy.seen.filter(scansLibrary), [], 'folders are not read again after a play');
  spy.reset();
  await library.getLibraryHealthAsync();
  assert.deepEqual(spy.seen.filter(scansLibrary), [], 'health does not scan every track again after a play');
  assert.ok(spy.seen.length > 0, 'but the tracks it shows are read again');
  spy.reset();
  await library.buildTasteMixAsync({ count: 20 });
  assert.ok(spy.seen.length > 0, 'the mix is worked out again after a play');

  spy.reset();
  library.upsertTracks([aTrack('K:\\music\\Newcomer\\First Light\\01 Brand New.flac')]);
  await library.getFoldersAsync(null, ROOTS);
  await library.getLibraryHealthAsync();
  assert.ok(spy.seen.filter(scansLibrary).length >= 2, 'a scan makes both read every track again');
  spy.stop();
  library.close();
});

await test('a write between slices of the folder index and the health scan is picked up', async () => {
  const { library, folder, tracks } = await openFixture('between');
  const drive = (steps, afterFirst) => {
    const first = steps.next();
    assert.equal(first.done, false, 'the pass yields after its first slice');
    afterFirst();
    return runSync(steps);
  };
  const added = aTrack('K:\\music\\Newcomer\\First Light\\01 Brand New.flac', { duration: 12345 });
  const index = drive(library.folderIndexSteps(), () => library.upsertTracks([added]));
  assert.ok(index.folders.some((entry) => entry.path.endsWith('First Light')), 'the folder index includes the track written meanwhile');
  assert.equal(library.folderIndexCache, index, 'and the result is kept');
  library.invalidateFolderTrackRowsCache();
  const scan = drive(library.healthScanSteps(), () => library.setTrackReplayGain(tracks[0].id, -3, -3));
  assert.equal(library.healthScanCache, scan);
  assert.equal(scan.quality.replayGainReady + scan.quality.replayGainMissing, tracks.length + 1);
  const fresh = await freshAnswers(library, folder, MIX_SEED(tracks), 'b');
  assert.deepEqual(scrub(library.getLibraryHealth()), fresh.health);
  assert.deepEqual(scrub(library.getFolders(null, ROOTS)), fresh.foldersRoots);
  library.close();
});

await test('a folder with more tracks than the fast path takes is listed the same way', async () => {
  const { library } = await openFixture('big-folder');
  library.upsertTracks(
    Array.from({ length: 3100 }, (_, i) => aTrack(`Z:\\Big\\${String(i).padStart(4, '0')} Song.flac`, { title: `Song ${i}`, trackNo: i % 12, art: null })),
  );
  for (const opts of [{ recursive: false }, { recursive: true, limit: 50, offset: 3000 }, { recursive: false, limit: 5, offset: 3098 }]) {
    const sync = scrub(library.getFolderTracks('Z:\\Big', opts));
    assert.deepEqual(scrub(await library.getFolderTracksAsync('Z:\\Big', opts)), sync, JSON.stringify(opts));
  }
  assert.equal((await library.getFolderTracksAsync('Z:\\Big', { limit: 100000 })).length, 3100);
  library.close();
});

await test('a job stops with an error when the library is closed under it', async () => {
  const { library } = await openFixture('closing');
  const pending = library.getDiscoverSurfaceAsync({ seed: 'x', now: NOW });
  library.close();
  await assert.rejects(pending, /closed/);
});

// -- the parts ----------------------------------------------------------------
await test('sliced jobs take one turn each round the event loop', async () => {
  const order = [];
  const job = function* (name, steps) {
    for (let i = 0; i < steps; i += 1) {
      order.push(`${name}${i}`);
      yield;
    }
    return name;
  };
  let turns = 0;
  const watcher = setInterval(() => {}, 1);
  const tick = () => {
    turns += 1;
    order.push('|');
    if (turns < 30) setImmediate(tick);
  };
  const done = Promise.all([runSliced(job('a', 3), { budgetMs: 0 }), runSliced(job('b', 3), { budgetMs: 0 })]);
  setImmediate(tick);
  assert.deepEqual(await done, ['a', 'b']);
  clearInterval(watcher);
  // Between any two slices of the two jobs the loop got a turn of its own.
  const slices = order.filter((entry) => entry !== '|');
  assert.deepEqual(slices, ['a0', 'b0', 'a1', 'b1', 'a2', 'b2']);
  const firstSlice = order.indexOf('a0');
  const lastSlice = order.lastIndexOf('b2');
  const between = order.slice(firstSlice, lastSlice).join('');
  assert.ok(!/[ab]\d[ab]\d/.test(between), `a turn of the event loop between slices: ${between}`);
});

await test('a sliced job runs nothing until its turn, and stops when told to', async () => {
  let ran = 0;
  let cleaned = false;
  const job = function* () {
    try {
      ran += 1;
      yield;
      ran += 1;
      yield;
      return 'done';
    } finally {
      cleaned = true;
    }
  };
  const started = runSliced(job(), { budgetMs: 0 });
  assert.equal(ran, 0, 'the first slice is not run inside the call');
  assert.equal(await started, 'done');
  assert.equal(ran, 2);

  ran = 0;
  cleaned = false;
  let turns = 0;
  const stopped = runSliced(job(), {
    budgetMs: 0,
    check: () => {
      turns += 1;
      if (turns === 2) throw new Error('stop');
    },
  });
  await assert.rejects(stopped, /stop/);
  assert.equal(ran, 1);
  assert.ok(cleaned, 'the job is unwound');
});

await test('the synchronous runner returns the value of the job', () => {
  assert.equal(
    runSync((function* () { yield; yield; return 7; })()),
    7,
  );
});

await test('kept results follow the version, the most recent stay, and one computation is shared', async () => {
  const cache = new DerivedCache(2);
  let version = 1;
  let computed = 0;
  const compute = async () => {
    computed += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return { n: computed };
  };
  const [a, b] = await Promise.all([cache.resolve('k', () => version, compute), cache.resolve('k', () => version, compute)]);
  assert.equal(computed, 1, 'two callers share one computation');
  assert.strictEqual(a, b);
  assert.strictEqual(await cache.resolve('k', () => version, compute), a, 'kept');
  version = 2;
  assert.notStrictEqual(await cache.resolve('k', () => version, compute), a, 'dropped when the version moved');
  assert.equal(computed, 2);

  // A result computed while the version moved is handed over but not kept.
  const slow = cache.resolve('s', () => version, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    version = 3;
    return 'old';
  });
  assert.equal(await slow, 'old');
  assert.equal(cache.get('s', 2), undefined);
  assert.equal(cache.get('s', 3), undefined);

  cache.set('x', 3, 1);
  cache.set('y', 3, 2);
  cache.get('x', 3);
  cache.set('z', 3, 3);
  assert.equal(cache.get('y', 3), undefined, 'the least recently used goes first');
  assert.equal(cache.get('x', 3), 1);
});

main.library.close();
console.log(results.join('\n'));
const failed = results.filter((line) => line.startsWith('FAIL')).length;
console.log(failed ? `\n[library-sliced-views-test] ${failed} FAILED` : `\n[library-sliced-views-test] PASS (${results.length})`);
