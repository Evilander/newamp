// sql.js export() reopens the connection and with it turns foreign keys off,
// so ON DELETE CASCADE only held for the first moments of a session: a track
// removed later could leave track_tags rows behind and inflate the tag counts,
// and list entries pointing at a track that no longer exists.
// Opening a library now drops any tag row whose track is gone, and turns a list
// entry for such a track into a free-text one that keeps its label and note.
// Run: npm run build:electron && node scripts/library-orphan-tags-test.mjs
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'library-orphan-tags-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const file = join(root, 'library.db');

const incoming = (path, genre) => ({
  path, title: path, artist: 'A', album: 'B', albumArtist: 'A', trackNo: null, discNo: null, year: null, genre,
  duration: 1, bitrate: null, sampleRate: null, replayGainTrackDb: null, replayGainAlbumDb: null, size: 1, mtime: 1, art: null,
});

const first = await LibraryStore.open(file);
first.upsertTracks([incoming('/m/one.flac', 'Keeper'), incoming('/m/two.flac', 'Keeper'), incoming('/m/three.flac', 'Other')]);
first.saveTagRule({ name: 'keeper', body: 'tag(keeper) when genre = "Keeper"' });
first.recomputeTags();
const list = first.saveList({ title: 'Favourites' });
const [one, two] = ['/m/one.flac', '/m/two.flac'].map((path) => first.getTracksByPaths([path])[0]);
first.addListItem({ listId: list.id, trackId: one.id, label: 'One' });
first.addListItem({ listId: list.id, trackId: two.id, label: 'Two', note: 'loved it' });
first.addListItem({ listId: list.id, trackId: null, label: 'Something on vinyl' });
assert.equal(first.getTagSummaries().find((tag) => tag.name === 'keeper').trackCount, 2);

// A removal that leaves the tag rows behind, as one made after the first flush
// did: saving once is what turns foreign keys off.
await first.flushPendingWrites();
first.db.run(`DELETE FROM tracks WHERE path = '/m/two.flac'`);
assert.equal(first.getTagSummaries().find((tag) => tag.name === 'keeper').trackCount, 2, 'the stale count');
first.toggleLove(1); // any write, so close() saves
first.close();

const reopened = await LibraryStore.open(file);
assert.equal(reopened.getTagSummaries().find((tag) => tag.name === 'keeper').trackCount, 1);
assert.deepEqual(reopened.getTrackIdsByTag('keeper'), [1]);
const items = reopened.getList(list.id).items.map((item) => [item.trackId, item.label, item.note]);
assert.deepEqual(items, [[one.id, 'One', ''], [null, 'Two', 'loved it'], [null, 'Something on vinyl', '']]);
reopened.close();

await rm(root, { recursive: true, force: true });
console.log('[library-orphan-tags-test] ok: tag rows without a track are dropped and list entries detached on open');
