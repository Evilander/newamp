// Unit test for the pending-album-navigation sequence guard (pure logic,
// no React needed) plus a static check that AlbumsView no longer couples
// programmatic navigation to the grid search filter.
// Run: node scripts/pending-album-nav-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const outfile = resolve('tmp/pending-album-nav-test-bundle.mjs');
await build({
  entryPoints: [resolve('src/lib/pending-album-nav.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile,
  logLevel: 'silent',
});

const { createPendingAlbumNavSeq, beginPendingAlbumNav, isCurrentPendingAlbumNav } =
  await import(pathToFileURL(outfile).href);

// Request A opens an album. Something unrelated happens in between — e.g.
// the album list reloading after a query/sort change — but that never calls
// beginPendingAlbumNav, so it must not invalidate A's in-flight request.
// A's detail should still be allowed to render when it resolves.
{
  const seq = createPendingAlbumNavSeq();
  const requestA = beginPendingAlbumNav(seq);
  // Simulate the unrelated list-reload effect firing — it doesn't touch the
  // pending-nav sequence at all, so A must remain current.
  assert.equal(isCurrentPendingAlbumNav(seq, requestA), true, 'an unrelated list reload must not invalidate the in-flight navigation request');
}

// Request A opens an album, then request B (a different album) fires before
// A's tracks/rating lookups land. When A's slow lookup finally resolves it
// must be treated as stale; B — the most recent request — must win.
{
  const seq = createPendingAlbumNavSeq();
  const requestA = beginPendingAlbumNav(seq);
  const requestB = beginPendingAlbumNav(seq);
  assert.equal(isCurrentPendingAlbumNav(seq, requestA), false, 'request A must be superseded once B has started');
  assert.equal(isCurrentPendingAlbumNav(seq, requestB), true, 'request B (the most recent) must win');
}

// Secondary, static check: the pending-navigation effect in AlbumsView must
// not set the grid search filter. That coupling was the root cause — setting
// `filter` there debounced into a query change ~180ms later, and the album
// list's reload effect (which depends on that query) unconditionally clears
// the selected album, snapping the user back to the grid.
const albumsViewSource = await readFile(new URL('../src/components/views/AlbumsView.tsx', import.meta.url), 'utf8');
const pendingNavEffectMatch = albumsViewSource.match(
  /if \(!pendingNavigation[\s\S]*?\n {2}\}, \[pendingNavigation, consumePendingNavigation\]\);/,
);
assert.ok(pendingNavEffectMatch, 'could not locate the pending-navigation effect in AlbumsView.tsx to check');
assert.doesNotMatch(
  pendingNavEffectMatch[0],
  /setFilter\(/,
  'the pending-navigation effect must not set the grid search filter — that reload clears the just-opened album',
);
assert.match(
  albumsViewSource,
  /isCurrentPendingAlbumNav|beginPendingAlbumNav/,
  'AlbumsView should guard pending navigation against out-of-order resolution',
);

console.log('[pending-album-nav-test] PASS');
