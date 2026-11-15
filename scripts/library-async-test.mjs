// Library behaviour for big libraries and flaky shares, compiled from source so it needs no
// dist-electron:
//  - exportSnapshot hands back the whole database without a second copy;
//  - tag rules are parsed strictly when saved and previewed, so a typo is
//    reported with its position, and a rule that fails when evaluated is
//    reported by the preview instead of showing zero matches as if all were well;
//  - recomputing and previewing tags give the thread back between tracks;
//  - a row whose cached cover is gone, and whose file now yields none, stops
//    claiming it has art, unless the folder of covers could not be listed;
//  - the listening-history import has a sliced form that gives the same report
//    and the same stored plays as the sync one, and is idempotent;
//  - a harmonic mix without a seed still fills the requested length.
// Run: node scripts/library-async-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp', 'library-async-test');
await rm(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const entry = join(root, 'entry.ts');
writeFileSync(entry, `export * from '../../electron/library';\n`);
const outfile = join(root, 'library-bundle.mjs');
await build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile,
  external: ['sql.js', 'electron'], logLevel: 'silent',
});
const { LibraryStore } = await import(pathToFileURL(outfile).href);

const base = {
  album: 'Album', albumArtist: 'Artist', trackNo: null, discNo: null, year: 2001, genre: 'Rock', duration: 200,
  bitrate: 320000, sampleRate: 44100, replayGainTrackDb: null, replayGainAlbumDb: null, size: 1, mtime: 1, art: null,
};
const track = (name, extra = {}) => ({ ...base, path: join(root, 'music', `${name}.mp3`), title: name, artist: `Artist ${name}`, ...extra });

const library = await LibraryStore.open(join(root, 'library.db'));
const count = 600;
library.upsertTracks(Array.from({ length: count }, (_, i) => track(`t${String(i).padStart(4, '0')}`, { bpm: 80 + (i % 90) })));

// ---- exportSnapshot
const snapshot = library.exportSnapshot();
assert.ok(Buffer.isBuffer(snapshot));
assert.equal(snapshot.subarray(0, 15).toString('latin1'), 'SQLite format 3', 'the snapshot is a database file');
assert.equal(snapshot.byteOffset, 0);
assert.ok(snapshot.length > 1000);
// The buffer is a view of the export's own memory: a copy would sit in another ArrayBuffer.
{
  const realExport = library.db.export.bind(library.db);
  const exported = realExport();
  library.db.export = () => exported;
  try {
    assert.equal(library.exportSnapshot().buffer, exported.buffer, 'the snapshot wraps the export without a second copy');
  } finally {
    library.db.export = realExport;
  }
}

// ---- strict tag rules
assert.throws(
  () => library.saveTagRule({ name: 'typo', body: 'tag(typo) when bpmm > 100' }),
  /unknown identifier "bpmm"/,
  'a misspelled field is refused when the rule is saved',
);
assert.throws(
  () => library.saveTagRule({ name: 'typo', body: 'tag(typo) when lowr(title) == "x"' }),
  /unknown function "lowr"/,
);
assert.throws(
  () => library.saveTagRule({ name: 'typo', body: 'tag(typo) when bpm > 100\n  and lowr(title) == "x"' }),
  /^Error: tag rule "typo" failed to parse: unknown function "lowr" \(line 2, column 7\)$/,
  'the message says where the mistake is, on any line',
);
assert.equal(library.listTagRules().length, 0, 'a refused rule is not stored');
const fast = library.saveTagRule({ name: 'fast', body: 'tag(fast) when bpm > 140' });
assert.equal(fast.name, 'fast');

const badPreview = library.previewTagRule({ body: 'tag(typo) when bpmm > 100' });
assert.equal(badPreview.ok, false);
assert.equal(badPreview.errors[0].line, 1);
assert.ok(badPreview.errors[0].column > 1, 'the preview names the column of the typo');
assert.match(badPreview.errors[0].message, /bpmm/);

// A rule stored before a name was checked still loads and recomputes.
library.db.run(
  `INSERT INTO tag_rules (name, body, boost, enabled, created_at, updated_at) VALUES ('legacy', 'tag(legacy) when bpmm > 1', 1, 1, 1, 1)`,
);
const recomputed = await library.recomputeTagsAsync();
assert.equal(recomputed.rulesEvaluated, 2, 'a lenient stored rule is still evaluated');
assert.ok(recomputed.errors.legacy, 'its failure is reported by name');
library.db.run(`DELETE FROM tag_rules WHERE name = 'legacy'`);

// A cycle only shows when the rules are evaluated together.
const fresh = library.saveTagRule({ name: 'b_rule', body: 'tag(b_rule) when tag(a_rule)' });
assert.ok(fresh.id);
const cycle = library.previewTagRule({ body: 'tag(a_rule) when tag(b_rule)' });
assert.equal(cycle.ok, false, 'a rule that cannot be evaluated is not reported as ok with no matches');
assert.match(cycle.errors[0].message, /cycle/);
assert.equal(cycle.matchCount, 0);
const okPreview = await library.previewTagRuleAsync({ body: 'tag(quick) when bpm > 140', limit: 500 });
assert.equal(okPreview.ok, true);
assert.deepEqual(okPreview.errors, []);
assert.ok(okPreview.matchCount > 0);
library.deleteTagRule(fresh.id);

// ---- turns are given back between tracks
const countYields = (steps) => {
  let yields = 0;
  for (;;) {
    const next = steps.next();
    if (next.done) return yields;
    yields += 1;
  }
};
const total = library.many(`SELECT COUNT(*) AS n FROM tracks`)[0].n;
assert.ok(countYields(library.recomputeTagsSteps({})) >= total, 'a tag pass yields at least once per track');
assert.ok(countYields(library.previewTagRuleSteps({ body: 'tag(quick) when bpm > 140', limit: 500 })) >= 500 / 2,
  'a preview yields per track too');
await library.recomputeTagsAsync();
const tagged = library.getTrackIdsByTag('fast');
assert.ok(tagged.length > 0 && tagged.length < count);
const limited = await library.recomputeTagsAsync({ trackIds: tagged.slice(0, 3) });
assert.equal(limited.tracksEvaluated, 3);

// ---- art that cannot be re-derived is cleared
const artTrack = track('has-art');
library.upsertTracks([artTrack]);
const artId = library.many(`SELECT id FROM tracks WHERE path = ?`, [artTrack.path])[0].id;
library.db.run(`UPDATE tracks SET has_art = 1, art_hash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' WHERE id = ?`, [artId]);
library.upsertTracks([{ ...artTrack, mtime: 2 }]);
const afterRescan = library.many(`SELECT has_art, art_hash FROM tracks WHERE id = ?`, [artId])[0];
assert.equal(afterRescan.has_art, 0, 'a cover that is gone is not claimed');
assert.equal(afterRescan.art_hash, null);

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
library.upsertTracks([{ ...artTrack, mtime: 3, art: { mime: 'image/png', data: png } }]);
const withArt = library.many(`SELECT has_art, art_hash FROM tracks WHERE id = ?`, [artId])[0];
assert.equal(withArt.has_art, 1);
library.upsertTracks([{ ...artTrack, mtime: 4 }]);
const kept = library.many(`SELECT has_art, art_hash FROM tracks WHERE id = ?`, [artId])[0];
assert.equal(kept.has_art, 1, 'art that still exists is kept when the file carries none');
assert.equal(kept.art_hash, withArt.art_hash);

// A folder of covers that cannot be listed says nothing about the covers in it:
// the row keeps the cover the user chose until the folder can be read again.
const artDir = join(root, 'art');
rmSync(artDir, { recursive: true, force: true });
writeFileSync(artDir, 'not a folder');
library.upsertTracks([{ ...artTrack, mtime: 5 }]);
const unlisted = library.many(`SELECT has_art, art_hash FROM tracks WHERE id = ?`, [artId])[0];
assert.equal(unlisted.has_art, 1, 'a row is not cleared because the art folder could not be listed');
assert.equal(unlisted.art_hash, withArt.art_hash);
rmSync(artDir);
mkdirSync(artDir);
library.upsertTracks([{ ...artTrack, mtime: 6 }]);
assert.equal(library.many(`SELECT has_art FROM tracks WHERE id = ?`, [artId])[0].has_art, 0, 'listed and empty, the cover is gone');

// The analysis queue compares a result with the file it was made from, so its target carries the row's size and date.
const analysed = library.analysisTarget(artId);
assert.deepEqual([analysed.size, analysed.mtime], [1, 6]);

// ---- history import, sync and sliced
const sample = (i) => ({ artist: `Artist t${String(i).padStart(4, '0')}`, title: `t${String(i).padStart(4, '0')}`, album: 'Album', playedAt: 1_600_000_000 + i * 60 });
const entries = [
  ...Array.from({ length: 300 }, (_, i) => sample(i)),
  { artist: 'Nobody', title: 'Nothing', album: 'None', playedAt: 1_600_100_000 },
  { ...sample(1), playedAt: Number.NaN },
];
const sliced = await library.importListeningHistoryAsync(entries);
assert.equal(sliced.imported, 300);
assert.equal(sliced.unmatched, 1);
assert.equal(sliced.invalid, 1);
assert.equal(sliced.total, 302);
const plays = library.many(`SELECT COUNT(*) AS n FROM play_history`)[0].n;
assert.equal(plays, 300);
const counted = library.many(`SELECT SUM(play_count) AS n FROM tracks`)[0].n;
assert.equal(counted, 300, 'each batch carries its play counts');
const again = library.importListeningHistory(entries);
assert.equal(again.imported, 0, 'plays already in the history are not imported twice');
assert.equal(again.duplicates, 300);
assert.equal(library.many(`SELECT COUNT(*) AS n FROM play_history`)[0].n, 300);
await assert.rejects(
  () => library.importListeningHistoryAsync(new Array(500_001).fill(sample(0))),
  /limited to/,
);

// ---- harmonic mix without a seed
const mix = await library.buildHarmonicMixAsync({ count: 25 });
assert.equal(mix.length, 25, 'an unseeded mix still fills its length');
assert.equal(new Set(mix.map((t) => t.id)).size, 25);

library.close();
for (const name of readdirSync(root)) if (name.startsWith('library.db.tmp')) unlinkSync(join(root, name));
console.log('library-async-test: ok');
