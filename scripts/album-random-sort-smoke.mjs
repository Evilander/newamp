// Regression smoke for `albumSortOrder('random', ...)`.
//
// Why this exists:
//   1.5.2 shipped an `albumSortOrder` clause that used `^` as a bitwise XOR
//   operator. SQLite has no XOR operator — its bitwise set is `&`, `|`,
//   `~`, `<<`, `>>` — so every call to `getAlbums({ sort: 'random' })` hit
//   `unrecognized token: "^"` at SQL parse time. The "Random" album sort
//   was therefore broken for every user who picked it. The reviewer
//   originally framed this as an int64 overflow risk at large MIN(id)
//   values, but the parse failure made the math unreachable.
//
// The smoke:
//   1. Pulls the live exported `albumSortOrder` from the compiled bundle.
//   2. Statically guards against `^` ever reappearing in its output.
//   3. Seeds a sql.js library with albums whose MIN(id) covers four
//      magnitudes: 100, 10 000, 1 000 000, and 100 000 000 — the last
//      well past the int64 overflow threshold the old code would have hit.
//   4. Runs the live ORDER BY against the seeded database and asserts:
//      (a) no SQL error,
//      (b) every album returns,
//      (c) two seeds 1 ms apart produce visibly different orderings
//          (the multi-term scramble's whole purpose),
//      (d) a distant seed also differs from the baseline.
//   5. Stresses MIN(id) ≈ 2^30 to confirm no int64 overflow even at the
//      polynomial peak.
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { albumSortOrder } from '../dist-electron/electron/library.js';

// Static guard: emitted SQL must never contain `^`. Sample a wide span of
// seeds so we catch any branch that reintroduces the bad operator.
for (const seed of [1, 42, 991, 7919, 1_000_003, 1_748_761_234_567, 0x7FFFFFFE]) {
  const sql = albumSortOrder('random', seed);
  assert.equal(
    /[^\\]\^/.test(sql),
    false,
    `albumSortOrder must not emit '^' — SQLite has no XOR operator. Got: ${sql}`,
  );
}

const SQL = await initSqlJs();
const db = new SQL.Database();
db.run(`
  CREATE TABLE tracks (
    id INTEGER PRIMARY KEY,
    album TEXT,
    album_artist TEXT,
    artist TEXT,
    year INTEGER,
    duration INTEGER,
    has_art INTEGER,
    mtime INTEGER,
    play_count INTEGER,
    last_played INTEGER
  )
`);

// One track per album. Album N gets MIN(id) at the magnitudes listed above.
const idMagnitudes = [100, 10_000, 1_000_000, 100_000_000];
const albums = [];
const insert = db.prepare('INSERT INTO tracks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
for (let i = 0; i < idMagnitudes.length; i++) {
  const id = idMagnitudes[i];
  const album = `Album ${String.fromCharCode(65 + i)}`;
  const albumArtist = `Artist ${i}`;
  albums.push({ id, album, albumArtist });
  insert.bind([id, album, albumArtist, albumArtist, 2020 + i, 240, 0, Date.now(), 0, null]);
  insert.step();
  insert.reset();
}
insert.free();

function orderRowsFor(seed) {
  const orderSql = albumSortOrder('random', seed);
  const sql = `SELECT album, album_artist
                 FROM tracks
             GROUP BY album, album_artist
             ORDER BY ${orderSql}
                LIMIT 100`;
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    while (stmt.step()) {
      const row = stmt.get();
      rows.push(`${row[0]}|${row[1]}`);
    }
  } finally {
    stmt.free();
  }
  assert.ok(rows.length > 0, `random sort returned no rows for seed ${seed}`);
  return rows;
}

// (1) Parse + execute survives the magnitudes the old code couldn't reach.
let baselineOrder;
try {
  baselineOrder = orderRowsFor(1748761234567); // realistic Date.now()-style seed
} catch (err) {
  assert.fail(`albumSortOrder('random') threw at the live SQL layer: ${err.message}`);
}
assert.equal(baselineOrder.length, albums.length, 'random sort must return every album');

// (2) Two seeds 1 ms apart produce visibly different orderings. The whole
//     point of the multi-term scramble.
const orderA = orderRowsFor(1748761234567);
const orderB = orderRowsFor(1748761234568);
const sameOrder = orderA.every((row, idx) => row === orderB[idx]);
assert.equal(
  sameOrder,
  false,
  `seeds 1ms apart must not produce identical orderings — both gave ${JSON.stringify(orderA)}`,
);

// (3) A far-apart seed must also differ from the baseline.
const orderFar = orderRowsFor(42);
const matchesBaseline = orderFar.every((row, idx) => row === baselineOrder[idx]);
assert.equal(matchesBaseline, false, 'distinct seeds must yield distinct orderings');

// (4) Stress at MIN(id) ≈ 2^30 with the largest legal seed. The old XOR
//     math would have overflowed int64 here even if `^` had parsed.
db.run('INSERT INTO tracks VALUES (1073741800, "Album Huge", "Artist Huge", "Artist Huge", 2030, 240, 0, 0, 0, NULL)');
let hugeOrder;
try {
  hugeOrder = orderRowsFor(0x7FFFFFFE);
} catch (err) {
  assert.fail(`random sort must survive MIN(id) ~ 2^30 with max-seed: ${err.message}`);
}
assert.equal(hugeOrder.length, albums.length + 1, 'huge MIN(id) album should still be sorted into the result');

db.close();
console.log(JSON.stringify({
  ok: true,
  suite: 'album-random-sort',
  magnitudes: idMagnitudes,
  baselineOrder,
  closeSeedDiffers: !sameOrder,
}, null, 2));
