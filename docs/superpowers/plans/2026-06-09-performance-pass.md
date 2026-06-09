# Performance Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the audit's real performance problems — the 10 fps full-tree re-render during playback, the sql.js N+1 / full-scan main-process stalls, and unbounded list DOM growth — with zero new runtime dependencies.

**Architecture:** Backend wins are exact, unit-tested changes in `electron/library.ts` (de-N+1, cache the health scan, use the existing DNA cache). Renderer wins isolate clock-driven UI into leaf components, memoize heavy panels, defer HomeView's mount fan-out, and add a hand-rolled dep-free virtualization hook. Pure logic (query ordering, cache invalidation, visible-window math) is unit-tested via the esbuild/dist harness pattern; large-component refactors are behavior-preserving and verified by typecheck + smokes + running.

**Tech Stack:** Electron, React, TypeScript, sql.js, esbuild (test harnesses). Library tests build to `dist-electron/` (like `scripts/library-smoke.mjs`) and seed via the public `upsertTracks(items: IncomingTrack[])`.

Spec: `docs/superpowers/specs/2026-06-09-performance-pass-design.md`. Branch `performance-pass` (created; spec committed).

Note: `electron/library.ts` reads as "binary" to plain `grep`/`file` (a non-UTF8 byte near line 269); use `grep -a` / the editor. Cosmetic, out of scope.

---

## File Structure
- Modify `electron/library.ts` — B1 (`getTracksByIdsInOrder:1011`), B2 (`getLibraryHealth:843` + a `libraryHealthCache` field + invalidation), R5 (`findSimilarTracks:2688` → `buildDnaIndex`).
- Create `scripts/library-query-test.mjs` — unit tests for B1 + B2 (dist-electron + temp db + `upsertTracks`).
- Create `src/hooks/useVirtualRows.ts` — pure `computeVisibleWindow(...)` + the `useVirtualRows` hook.
- Create `scripts/virtual-rows-test.mjs` — pure-math test for `computeVisibleWindow`.
- Modify `src/components/views/AlbumsView.tsx` — R4 (lazy art) + R3 (virtualized grid).
- Modify `src/components/views/LibraryView.tsx` — R3 (virtualized table + memoized row).
- Modify `src/components/views/HomeView.tsx` — R2 (defer below-the-fold fan-out).
- Modify `src/components/views/NowPlayingView.tsx` — R1 (isolate clock leaves + memo panels).
- Modify `package.json` (new `test:*` scripts) and `.github/workflows/ci.yml` (run them).

---

## Task 1 (B1): De-N+1 `getTracksByIdsInOrder`

**Files:** Modify `electron/library.ts`; Create `scripts/library-query-test.mjs`; Modify `package.json`.

- [ ] **Step 1: Write the failing test**

Create `scripts/library-query-test.mjs`:

```js
// Unit tests for LibraryStore query performance fixes (B1 de-N+1 ordering, and
// B2 getLibraryHealth caching). Builds electron to dist-electron, opens a temp
// LibraryStore, seeds via upsertTracks (no ffmpeg needed). Mirrors the setup of
// scripts/library-smoke.mjs. Run: npm run build:electron && node scripts/library-query-test.mjs
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
mkdirSync(resolve(repoRoot, 'tmp'), { recursive: true });
const RESULT = resolve(repoRoot, 'tmp/library-query-test-result.txt');
writeFileSync(RESULT, '[library-query-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

const smokeRoot = join(repoRoot, 'tmp', 'library-query-test');
const dbPath = join(smokeRoot, 'library.db');
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const lib = await LibraryStore.open(dbPath);

function track(i) {
  return {
    path: `/music/track-${i}.flac`,
    title: `Track ${i}`,
    artist: `Artist ${i % 7}`,
    album: `Album ${i % 13}`,
    albumArtist: `Artist ${i % 7}`,
    trackNo: i, discNo: 1, year: 2000 + (i % 20), genre: 'Test',
    duration: 180, bitrate: 1000, sampleRate: 44100,
    replayGainTrackDb: null, replayGainAlbumDb: null,
    size: 1000 + i, mtime: 1700000000 + i, art: null,
  };
}

const N = 1000;
lib.upsertTracks(Array.from({ length: N }, (_, k) => track(k + 1)));

// Map our seeded path -> assigned id.
const all = lib.getTracks({ limit: N + 10, offset: 0 });
const idByPath = new Map(all.map((t) => [t.path, t.id]));
const id = (i) => idByPath.get(`/music/track-${i}.flac`);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

// B1: order preserved, duplicates collapsed, missing ids skipped.
const want = [id(5), id(1), id(5), 999999999, id(3)];
const got = lib.getTracksByIdsInOrder(want).map((t) => t.path);
log.push('B1 ordered result: ' + JSON.stringify(got));
if (JSON.stringify(got) !== JSON.stringify(['/music/track-5.flac', '/music/track-1.flac', '/music/track-3.flac'])) {
  fail('B1 ordering/dedup/missing-skip incorrect');
}
// B1: large request returns all N in input order.
const ids = Array.from({ length: N }, (_, k) => id(k + 1));
const big = lib.getTracksByIdsInOrder(ids);
if (big.length !== N) fail(`B1 expected ${N} tracks, got ${big.length}`);
if (big[0].path !== '/music/track-1.flac' || big[N - 1].path !== `/music/track-${N}.flac`) fail('B1 large-request order wrong');

const report = log.join('\n') + '\n' + (pass ? '[library-query-test] PASS' : '[library-query-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
```

- [ ] **Step 2: Build electron and run the test — verify it PASSES already-or-fails-on-perf-only**

Run: `npm run build:electron && node scripts/library-query-test.mjs`
Expected: **PASS** — the *current* `getTracksByIdsInOrder` already returns correct order/dedup/skip (it's an N+1 only in *how* it queries, not in *what* it returns). This test locks the behavioral contract so the de-N+1 rewrite can't regress it. (If it fails, stop — the seeding/id-mapping is wrong, fix the test first.)

- [ ] **Step 3: Rewrite `getTracksByIdsInOrder` to a chunked IN query**

In `electron/library.ts`, replace (`:1011-1015`):

```ts
  getTracksByIdsInOrder(ids: number[]): Track[] {
    return ids
      .map((id) => this.getTrack(id))
      .filter((track): track is Track => !!track);
  }
```

with (mirrors the chunked `IN (...)` pattern in `getTrackFileStates:1078-1091`; `many`/`rowToTrack`/`RawRow` are already in this file):

```ts
  getTracksByIdsInOrder(ids: number[]): Track[] {
    const wanted = ids.filter((id) => Number.isFinite(id));
    if (!wanted.length) return [];
    const byId = new Map<number, Track>();
    const unique = [...new Set(wanted)];
    const chunkSize = 500;
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.many<RawRow>(`SELECT * FROM tracks WHERE id IN (${placeholders})`, chunk);
      for (const row of rows) {
        const track = rowToTrack(row);
        byId.set(track.id, track);
      }
    }
    // Preserve input order; drop missing; collapse duplicates (first occurrence).
    const out: Track[] = [];
    const emitted = new Set<number>();
    for (const id of wanted) {
      if (emitted.has(id)) continue;
      const track = byId.get(id);
      if (track) {
        out.push(track);
        emitted.add(id);
      }
    }
    return out;
  }
```

- [ ] **Step 4: Run the test — verify it still PASSES**

Run: `node scripts/library-query-test.mjs` (electron already built; rebuild if you changed TS: `npm run build:electron && node scripts/library-query-test.mjs`)
Expected: PASS — same behavior, now one query per 500 ids.

- [ ] **Step 5: Add npm script, typecheck, commit**

In `package.json`, after `"test:macho-arch": ...` (or alongside the other `test:*`), add:
```json
    "test:library-query": "npm run build:electron && node scripts/library-query-test.mjs",
```
Run: `npm run typecheck` (clean).
```bash
git add electron/library.ts scripts/library-query-test.mjs package.json
git commit -m "perf: de-N+1 getTracksByIdsInOrder (chunked IN query)

Replace one prepared SELECT per id (single-threaded WASM sql.js) with a chunked
WHERE id IN (...) into a Map + input-order reorder. Fixes the IPC stall on queue
restore / find-similar / smart playlists / radio-brain. Behavior locked by a new
unit test (order preserved, dups collapsed, missing ids skipped).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 (B2): Cache `getLibraryHealth`

**Files:** Modify `electron/library.ts`, `scripts/library-query-test.mjs`.

- [ ] **Step 1: Add a failing cache test**

In `scripts/library-query-test.mjs`, append before the `const report = ...` line:

```js
// B2: getLibraryHealth is cached and invalidated on write.
const h1 = lib.getLibraryHealth();
const h2 = lib.getLibraryHealth();
if (h2 !== h1) fail('B2 getLibraryHealth should return the SAME cached object reference on repeat calls');
lib.upsertTracks([track(N + 1)]);
const h3 = lib.getLibraryHealth();
if (h3 === h1) fail('B2 getLibraryHealth cache should be invalidated after upsertTracks');
log.push(`B2 cache: same-ref-before=${h2 === h1} new-ref-after-write=${h3 !== h1}`);
```

- [ ] **Step 2: Build + run — verify it FAILS**

Run: `npm run build:electron && node scripts/library-query-test.mjs`
Expected: FAIL — `getLibraryHealth` currently recomputes a fresh object each call (`h2 !== h1`).

- [ ] **Step 3: Add the cache field + invalidation**

In `electron/library.ts`, next to the existing cache fields (`private folderTrackRowsCache: FolderTrackRow[] | null = null;` at `:617`, `private dnaIndexCache: ... = null;` at `:611`), add:
```ts
  private libraryHealthCache: LibraryHealth | null = null;
```

Add an invalidator next to `invalidateFolderTrackRowsCache` (`:1497`):
```ts
  private invalidateLibraryHealthCache(): void {
    this.libraryHealthCache = null;
  }
```

Call `this.invalidateLibraryHealthCache();` at every site that already calls `this.invalidateFolderTrackRowsCache();` — there are calls at `:819` (upsertTracks), `:1148`, `:1182`, `:1373`. Add the health invalidation immediately after each of those four lines. (Search `invalidateFolderTrackRowsCache()` with `grep -a` to confirm you got all call sites; pair each one.)

At the top of `getLibraryHealth()` (`:843`), short-circuit:
```ts
  getLibraryHealth(): LibraryHealth {
    if (this.libraryHealthCache) return this.libraryHealthCache;
    const rows = this.many<LibraryHealthRow>(
```
…and at each `return` of the computed health object at the end of the method, store it first. Find the final `return { ... };` (the assembled `LibraryHealth`) and change it to:
```ts
    const health: LibraryHealth = { /* ...the existing assembled object fields, unchanged... */ };
    this.libraryHealthCache = health;
    return health;
```
(Read the method's existing return statement and wrap exactly that object literal — do not change any field.)

- [ ] **Step 4: Build + run — verify it PASSES**

Run: `npm run build:electron && node scripts/library-query-test.mjs`
Expected: PASS — `same-ref-before=true new-ref-after-write=true`, and Task 1's assertions still pass.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (clean).
```bash
git add electron/library.ts scripts/library-query-test.mjs
git commit -m "perf: cache getLibraryHealth, invalidate on write

The full-table scan + per-row reclassification ran on every HomeView open. Cache
the computed LibraryHealth and clear it wherever folderTrackRowsCache is cleared
(upsert/prune/delete). Unit-tested: cached on repeat, invalidated after upsert.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 (R5): `findSimilarTracks` uses the DNA index cache

**Files:** Modify `electron/library.ts`.

- [ ] **Step 1: Read `findSimilarTracks` (`:2688`)**

Confirm it calls `const all = this.getAllTrackDna();` then loops `for (const row of all)` building a candidate list, then `this.getTracksByIdsInOrder(idList)`. `getAllTrackDna()` re-`SELECT`s + `JSON.parse`s every blob; `buildDnaIndex()` (`:2272`) returns a cached `Map<number, TrackDna>` of the same data, invalidated by `invalidateDnaIndexCache` on writes.

- [ ] **Step 2: Switch to the cached index**

Replace the `getAllTrackDna()` walk in `findSimilarTracks` with the cached map. Change:
```ts
    const all = this.getAllTrackDna();
    ...
    for (const row of all) {
      // uses row.id and row.dna
    }
```
to iterate the cached map (note the shape difference: `getAllTrackDna()` yields `{ id, dna }` objects; `buildDnaIndex()` yields a `Map<number, TrackDna>`):
```ts
    const index = this.buildDnaIndex();
    ...
    for (const [rowId, dna] of index) {
      // replace prior `row.id` with `rowId` and `row.dna` with `dna`
    }
```
Adjust the loop body's variable references accordingly (`row.id` → `rowId`, `row.dna` → `dna`). Do not change the similarity math or the `getTracksByIdsInOrder` call (now also de-N+1'd by Task 1).

- [ ] **Step 3: Verify with the existing DNA smoke + typecheck**

Run: `npm run typecheck` (clean) and `npm run smoke:dna` (expect pass — it exercises DNA/similarity).
Expected: smoke passes; similarity output unchanged (same data source, just cached).

- [ ] **Step 4: Commit**

```bash
git add electron/library.ts
git commit -m "perf: findSimilarTracks reuses the cached DNA index

Iterate buildDnaIndex()'s cached Map instead of re-SELECT+JSON.parse of every
dna_json blob per call (SoundsLikePanel calls this on every track change).
Same data, no redundant parse. Verified by smoke:dna.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 (R4): Lazy-load album art

**Files:** Modify `src/components/views/AlbumsView.tsx`.

- [ ] **Step 1: Read the cover `<img>` (~`:715`)**

Find the `<img>` that renders the album cover via `api.getArtUrl(...)` / `newart://`. Confirm it has no `loading`/`decoding` attributes.

- [ ] **Step 2: Add lazy/async attributes**

Add `loading="lazy"` and `decoding="async"` to that `<img>` (keep all existing props/classes). Example shape:
```tsx
<img
  src={/* existing src expression, unchanged */}
  alt={/* existing */}
  loading="lazy"
  decoding="async"
  /* ...existing className/style/onError... */
/>
```

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck` (clean). (Verified by running the app — only visible covers fetch.)
```bash
git add src/components/views/AlbumsView.tsx
git commit -m "perf: lazy-load album art (loading=lazy, decoding=async)

Opening an Albums page no longer fires a burst of synchronous main-thread art
reads for every cover; the browser fetches only visible tiles.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 (R3a): Pure virtualization hook `useVirtualRows`

**Files:** Create `src/hooks/useVirtualRows.ts`, `scripts/virtual-rows-test.mjs`; Modify `package.json`.

- [ ] **Step 1: Write the failing test**

Create `scripts/virtual-rows-test.mjs`:

```js
// Unit test for computeVisibleWindow (pure virtualization math). esbuild harness.
// Run: node scripts/virtual-rows-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/virtual-rows-test-result.txt');
writeFileSync(RESULT, '[virtual-rows-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/hooks/useVirtualRows.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/virtual-rows-bundle.mjs'), logLevel: 'silent',
  // React is only used by the hook export; the pure fn has no React dependency,
  // but bundling the file pulls react in — mark it external so node import works.
  external: ['react'],
});
const { computeVisibleWindow } = await import(pathToFileURL(resolve('tmp/virtual-rows-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const eq = (got, want, msg) => { const a = JSON.stringify(got), b = JSON.stringify(want); log.push(`${msg}: ${a}`); if (a !== b) fail(`${msg} — expected ${b}`); };

// rowHeight 40, viewport 400 (10 rows), 1000 rows, overscan 3.
const P = { rowHeight: 40, viewportH: 400, rowCount: 1000, overscan: 3 };
// Top of list: start clamps to 0.
eq(computeVisibleWindow({ ...P, scrollTop: 0 }), { startIndex: 0, endIndex: 12, topPad: 0, bottomPad: (1000 - 13) * 40 }, 'top of list');
// Middle: scrollTop 4000 => row 100; window 97..(100+10+3)=113.
eq(computeVisibleWindow({ ...P, scrollTop: 4000 }), { startIndex: 97, endIndex: 113, topPad: 97 * 40, bottomPad: (1000 - 114) * 40 }, 'middle');
// Bottom: scrollTop at max; endIndex clamps to rowCount-1, bottomPad 0.
const bottom = computeVisibleWindow({ ...P, scrollTop: (1000 * 40) - 400 });
log.push('bottom: ' + JSON.stringify(bottom));
if (bottom.endIndex !== 999) fail('bottom endIndex should clamp to 999');
if (bottom.bottomPad !== 0) fail('bottom bottomPad should be 0');
if (bottom.topPad !== bottom.startIndex * 40) fail('bottom topPad mismatch');
// Tiny list (3 rows) — no negative pads, renders all.
const tiny = computeVisibleWindow({ rowHeight: 40, viewportH: 400, rowCount: 3, overscan: 3, scrollTop: 0 });
eq(tiny, { startIndex: 0, endIndex: 2, topPad: 0, bottomPad: 0 }, 'tiny list');

const report = log.join('\n') + '\n' + (pass ? '[virtual-rows-test] PASS' : '[virtual-rows-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
```

- [ ] **Step 2: Run — verify it FAILS** (module missing)

Run: `node scripts/virtual-rows-test.mjs`
Expected: FAIL — `src/hooks/useVirtualRows.ts` doesn't exist.

- [ ] **Step 3: Write the hook + pure function**

Create `src/hooks/useVirtualRows.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

export interface VisibleWindowInput {
  scrollTop: number;
  viewportH: number;
  rowHeight: number;
  rowCount: number;
  overscan: number;
}

export interface VisibleWindow {
  startIndex: number;
  endIndex: number;
  topPad: number;
  bottomPad: number;
}

/**
 * Pure windowing math. Given the scroll position, viewport height, fixed row
 * height and total row count, return the inclusive [startIndex, endIndex] of
 * rows to render (± overscan) plus the spacer heights above/below. No React,
 * no DOM — unit-testable in Node.
 */
export function computeVisibleWindow({
  scrollTop,
  viewportH,
  rowHeight,
  rowCount,
  overscan,
}: VisibleWindowInput): VisibleWindow {
  if (rowCount <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: -1, topPad: 0, bottomPad: 0 };
  }
  const first = Math.floor(scrollTop / rowHeight);
  const visibleCount = Math.ceil(viewportH / rowHeight);
  const startIndex = Math.max(0, first - overscan);
  const endIndex = Math.min(rowCount - 1, first + visibleCount + overscan);
  const topPad = startIndex * rowHeight;
  const bottomPad = Math.max(0, (rowCount - 1 - endIndex) * rowHeight);
  return { startIndex, endIndex, topPad, bottomPad };
}

export interface UseVirtualRowsOptions {
  rowCount: number;
  rowHeight: number;
  overscan?: number;
}

export interface UseVirtualRows extends VisibleWindow {
  onScroll: (e: { currentTarget: { scrollTop: number; clientHeight: number } }) => void;
  scrollRef: React.RefObject<HTMLDivElement>;
}

/**
 * React wrapper around computeVisibleWindow. Attach `scrollRef` to the scroll
 * container and `onScroll` to its onScroll; render rows
 * [startIndex..endIndex] between a topPad and bottomPad spacer.
 */
export function useVirtualRows({ rowCount, rowHeight, overscan = 6 }: UseVirtualRowsOptions): UseVirtualRows {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback((e: { currentTarget: { scrollTop: number; clientHeight: number } }) => {
    setScrollTop(e.currentTarget.scrollTop);
    setViewportH(e.currentTarget.clientHeight);
  }, []);

  const win = computeVisibleWindow({ scrollTop, viewportH: viewportH || 600, rowHeight, rowCount, overscan });
  return { ...win, onScroll, scrollRef };
}
```

- [ ] **Step 4: Run — verify it PASSES**

Run: `node scripts/virtual-rows-test.mjs`
Expected: PASS (all four window cases).

- [ ] **Step 5: npm script, typecheck, commit**

In `package.json` add:
```json
    "test:virtual-rows": "node scripts/virtual-rows-test.mjs",
```
Run: `npm run typecheck` (clean).
```bash
git add src/hooks/useVirtualRows.ts scripts/virtual-rows-test.mjs package.json
git commit -m "perf: add dep-free useVirtualRows hook + pure computeVisibleWindow

Hand-rolled windowing (visible range + overscan + spacer pads) so the big lists
can render only on-screen rows. Pure math is unit-tested; no new runtime deps.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 (R3b): Virtualize the LibraryView track table + memoized row

**Files:** Modify `src/components/views/LibraryView.tsx`.

- [ ] **Step 1: Read the current table render**

Read `LibraryView.tsx` around the `visible.map(...)`/`tracks.map(...)` that emits `<tr>` rows (~`:1542` per the audit), the `selectedIds` state, and `LIBRARY_PAGE_SIZE` (`:30`). Note the row's columns and the per-row handlers (play, love, select, context menu).

- [ ] **Step 2: Extract a memoized `LibraryRow`**

In `LibraryView.tsx`, define a `React.memo` row component above the main component:
```tsx
import { memo, useCallback } from 'react';
// ...
interface LibraryRowProps {
  track: Track;
  selected: boolean;
  onPlay: (id: number) => void;
  onToggleSelect: (id: number) => void;
  onToggleLove: (id: number) => void;
  // ...any other primitive/stable props the row needs
}
const LibraryRow = memo(function LibraryRow({ track, selected, onPlay, onToggleSelect, onToggleLove }: LibraryRowProps) {
  return (
    <tr /* existing row markup, using track + selected + the callbacks */ />
  );
});
```
Move the existing per-row JSX into `LibraryRow`. In the parent, make the handlers stable with `useCallback` (they should take the row id and look up / dispatch, not close over per-row values), and pass `selected={selectedIds.has(track.id)}` as a boolean. This ensures toggling one selection re-renders only that row.

- [ ] **Step 3: Apply `useVirtualRows`**

Wrap the table body in a scroll container with a fixed row height (the rows are uniform — measure the current row height, define `const LIBRARY_ROW_HEIGHT = <px>;` with a comment; if rows are ~36px tall, use that). Use the hook:
```tsx
const { startIndex, endIndex, topPad, bottomPad, onScroll, scrollRef } = useVirtualRows({
  rowCount: tracks.length,
  rowHeight: LIBRARY_ROW_HEIGHT,
});
```
Render a scrollable wrapper (`<div ref={scrollRef} onScroll={onScroll} style={{ overflow: 'auto', height: '<the table viewport height> ' }}>`) containing the `<table>`; inside `<tbody>`, render a top spacer row `<tr style={{ height: topPad }} />`, then `tracks.slice(startIndex, endIndex + 1).map(t => <LibraryRow key={t.id} .../>)`, then a bottom spacer `<tr style={{ height: bottomPad }} />`. Spacer `<tr>`s with a single full-colspan `<td>` keep table layout valid:
```tsx
<tr aria-hidden style={{ height: topPad }}><td colSpan={COLS} style={{ padding: 0, border: 0 }} /></tr>
```
Keep the existing "load more" / pagination intact — virtualization just bounds the *rendered* rows, not the loaded set.

- [ ] **Step 4: Typecheck + verify by running**

Run: `npm run typecheck` (clean). Run the app, open Library, scroll the full list: rows render/recycle smoothly, selection of one row doesn't lag, "load more" still appends, sort/search still work. (No unit test for the rendered table; the math is covered by Task 5.)

- [ ] **Step 5: Commit**

```bash
git add src/components/views/LibraryView.tsx
git commit -m "perf: virtualize the Library track table + memoized rows

Render only the visible window (useVirtualRows) instead of accumulating every
loaded <tr>; extract a React.memo'd LibraryRow with stable callbacks so toggling
one selection re-renders only that row, not the whole table.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 (R3c): Virtualize the AlbumsView grid (deferrable)

**Files:** Modify `src/components/views/AlbumsView.tsx`.

- [ ] **Step 1: Assess feasibility**

Read the AlbumsView grid render. If it's a CSS grid of fixed-size cards, virtualize by *rows of cards*: compute `columns = Math.max(1, Math.floor(containerWidth / cardWidth))`, `rowCount = Math.ceil(albums.length / columns)`, `rowHeight = cardHeight + gap`, and use `useVirtualRows` to render only visible card-rows (each "row" maps `albums.slice(rowStart*columns, …)`). If the layout is responsive/irregular in a way that makes fixed row height unreliable, **stop and report DONE_WITH_CONCERNS** — note that AlbumsView virtualization is deferred (R4 lazy-load already bounds its main cost) and leave AlbumsView as-is.

- [ ] **Step 2: If feasible, apply the row-based virtualization**

Mirror Task 6's structure for card-rows: a scroll container with `scrollRef`/`onScroll`, top/bottom spacer divs of `topPad`/`bottomPad` height, and `Array.from({length: endIndex-startIndex+1})` card-rows. Keep `loading="lazy"` from Task 4 on the covers.

- [ ] **Step 3: Typecheck + run + commit**

Run: `npm run typecheck` (clean); run the app, open Albums, scroll. 
```bash
git add src/components/views/AlbumsView.tsx
git commit -m "perf: virtualize the Albums grid by card-rows

Render only visible card-rows via useVirtualRows; covers stay lazy-loaded.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
(If deferred in Step 1, skip the commit and note it for the final report.)

---

## Task 8 (R2): Defer HomeView's below-the-fold fan-out

**Files:** Modify `src/components/views/HomeView.tsx`.

- [ ] **Step 1: Read the mount effect (`:85`/`:115`)**

Read the `useEffect` and the single `Promise.all([...13 calls...])` at `:115-128` and how the results set state (`stats, health, insights, fresh, loved, history, heavy, harmonic, taste, rated, playlists, smartRules, suggestedStations`).

- [ ] **Step 2: Split into above- and below-the-fold loads**

Restructure the effect so the **above-the-fold** set resolves first and sets its state immediately:
```ts
useEffect(() => {
  let cancelled = false;
  (async () => {
    const [stats, fresh, loved, history, heavy, playlists] = await Promise.all([
      api.getStats(),
      api.getTracks({ sort: 'added', limit: HOME_LIMIT, offset: 0 }),
      api.getTracks({ sort: 'loved', limit: HOME_LIMIT, offset: 0 }),
      api.getListeningHistory({ limit: 30, offset: 0 }),
      api.getTracks({ sort: 'plays', limit: HOME_LIMIT, offset: 0 }),
      api.getPlaylists(),
    ]);
    if (cancelled) return;
    // ...setState for the above-the-fold sections...

    const runBelowFold = async () => {
      const [health, insights, harmonic, taste, rated, smartRules, suggestedStations] = await Promise.all([
        api.getLibraryHealth(),
        api.getListeningInsights({}),
        api.buildHarmonicMix({ seedTrackId: current?.id ?? null, count: HOME_LIMIT }),
        api.buildTasteMix({ seedTrackId: current?.id ?? null, count: HOME_LIMIT }),
        api.getTracks({ sort: 'rating', limit: HOME_LIMIT, offset: 0 }),
        api.getSmartPlaylistRules(),
        api.getSuggestedSmartPlaylistRules(),
      ]);
      if (cancelled) return;
      // ...setState for the below-the-fold sections...
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => void runBelowFold());
    else setTimeout(() => void runBelowFold(), 0);
  })();
  return () => { cancelled = true; };
}, [/* same deps as before, e.g. current?.id */]);
```
Keep the **exact same** state variables and the **same** JSX; below-the-fold sections simply render their existing empty/placeholder state until `runBelowFold` populates them. Do not remove `getSuggestedStations` if it was in the original list — include it in the below-fold batch (match the original calls 1:1; the original had 13 calls — every one must still run, just split across the two batches). Preserve `getListeningInsights`, `getSmartPlaylistRules`, `getSuggestedSmartPlaylistRules` placement in the below-fold batch.

- [ ] **Step 3: Typecheck + smoke + run**

Run: `npm run typecheck` (clean) and `npm run smoke:home` (expect pass — Home wiring/stats). Run the app: Home paints the top sections immediately; mixes/health/suggestions fill in shortly after. Confirm no section is missing vs. before.

- [ ] **Step 4: Commit**

```bash
git add src/components/views/HomeView.tsx
git commit -m "perf: defer HomeView below-the-fold data off the first paint

Split the 13-call mount Promise.all: render stats/fresh/loved/history/top/
playlists immediately; load health (now cached), insights, harmonic/taste mixes,
ratings, smart rules and suggested stations via requestIdleCallback after first
paint so opening Home no longer blocks on full-library scans.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9 (R1): Memoize `NowPlayingView` (the careful one)

**Files:** Modify `src/components/views/NowPlayingView.tsx`.

This is a behavior-preserving refactor of a 2,634-line component — no pure seam to unit-test, so proceed surgically and verify by typecheck + running. If any step is ambiguous about preserving behavior, STOP and report DONE_WITH_CONCERNS rather than guessing.

- [ ] **Step 1: Map the clock usage**

Read the component. `currentTime` is read at `:53` (`usePlayerStore((s) => s.currentTime)`) and used at: `:238` (practice-loop restart effect), `:264` (`findActive(lyrics.lines, currentTime)` → active lyric line), `:273-274` (bookmark-at-current handler), `:329` (practice-loop point set handler), and passed as a prop at `:551`, `:600`, `:612` (and possibly more — grep `currentTime` in the file). Catalog every read.

- [ ] **Step 2: Move event-time reads off the subscription**

For handlers that only need the time *at the moment of an event* (bookmark-at-current `:273`, practice-loop point set `:329`), read it imperatively instead of from the subscribed value:
```ts
const t = usePlayerStore.getState().currentTime;
```
inside the handler body. Remove their dependence on the subscribed `currentTime`.

- [ ] **Step 3: Isolate the time-driven UI into leaf components**

Create small leaf components inside the file (or co-located) that each subscribe to `currentTime` themselves so only they re-render on the clock:
- `ScrubReadout` — the elapsed/remaining text + the seek/scrub bar position (reads `currentTime` + `duration`, calls the existing `seek`).
- `ActiveLyricLine` (or pass the computed active index down) — subscribes to `currentTime`, computes `findActive(lyrics.lines, currentTime)`, renders the highlight. Pass `lyrics.lines` in as a prop (stable).
Each does `const currentTime = usePlayerStore((s) => s.currentTime);` locally.

- [ ] **Step 4: Stop drilling `currentTime` and memoize panels**

Remove the `currentTime={currentTime}` props at `:551/:600/:612` (and any others) from clock-independent panels. Wrap those panel components in `React.memo` (`SpectrumPanel`, `WaveformOverview` if it doesn't need per-frame time, `LyricsPanel` shell, `TrackSignalPanel`, `SoundsLikePanel`, `AlbumContextPanel`, `ArtistImageStage`, `BookmarkPanel`, etc.). For each memoized panel, ensure its props are stable: wrap callbacks passed to it in `useCallback`, and avoid passing freshly-constructed object/array literals (hoist or `useMemo`). If a panel genuinely needs continuous time (e.g., a waveform playhead), give IT a `currentTime` subscription internally rather than re-rendering the parent.

- [ ] **Step 5: Keep the practice-loop effect working**

The effect at `:238` depends on `currentTime` to detect loop wraparound. Leave this effect in the parent but be aware it will re-run on the clock — that's fine (it's a cheap effect, not a render of the subtree). The goal is that the parent's *render output* no longer changes 10×/sec, not that no effect runs. Confirm the effect's dependency array still includes what it needs.

- [ ] **Step 6: Typecheck + verify behavior**

Run: `npm run typecheck` (clean). Run the app and confirm, while a track plays: the scrub bar + elapsed time update smoothly; lyrics highlight tracks the song; scrubbing works; bookmark-at-current and practice-loop set still capture the right time; no panel went stale. If you can add a temporary dev render-counter to `NowPlayingView` to confirm the parent stops re-rendering on the clock, note the before/after counts in your report (then remove it). Do not claim the perf win without either the render-count evidence or an explicit profiler observation.

- [ ] **Step 7: Commit**

```bash
git add src/components/views/NowPlayingView.tsx
git commit -m "perf: stop NowPlayingView re-rendering its whole tree 10x/sec

Isolate the clock-driven UI (scrub readout, active lyric line) into leaf
components that subscribe to currentTime themselves; read event-time imperatively
in handlers; React.memo the clock-independent panels with stable callbacks. The
parent no longer reconciles on every currentTime tick during playback.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10 (D): Wire tests into CI + final gate

**Files:** Modify `.github/workflows/ci.yml`.

- [ ] **Step 1: Add the new Node tests to CI**

In `.github/workflows/ci.yml`, after the macOS-logic test step, add:
```yaml
      - name: Test — virtualization window math
        run: npm run test:virtual-rows

      - name: Test — library query perf (N+1 + health cache)
        run: npm run test:library-query
```
(`test:library-query` runs `build:electron` itself.)

- [ ] **Step 2: Full gate**

Run and confirm each:
- `npm run typecheck` → clean
- `node scripts/virtual-rows-test.mjs` → PASS
- `npm run test:library-query` → PASS
- `npm run smoke:home` → pass
- `npm run smoke:dna` → pass
- `npm run smoke:library` → pass
- `npm run smoke:visualizer` → pass

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "perf: gate the new perf unit tests in CI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes
- **Spec coverage:** B1→T1, B2→T2, R5→T3, R4→T4, R3 hook→T5, R3 LibraryView→T6, R3 AlbumsView→T7 (deferrable), R2→T8, R1→T9, CI/testing→T10. All spec items mapped.
- **Type/name consistency:** `getTracksByIdsInOrder`, `getLibraryHealth`/`libraryHealthCache`/`invalidateLibraryHealthCache`, `buildDnaIndex`, `computeVisibleWindow`/`useVirtualRows`/`VisibleWindow`, `LibraryRow`, `LIBRARY_ROW_HEIGHT` are each defined once and referenced consistently.
- **Verifiability honesty:** T1/T2/T5 fully unit-tested; T3 verified by `smoke:dna`; T4/T6/T7/T8/T9 are behavior-preserving and verified by typecheck + smokes + running (R1 additionally wants render-count or profiler evidence — explicitly required, no fake claims).
- **Confirmed against code:** `getTracksByIdsInOrder:1011`, `getTrack:1006`, `getTrackFileStates:1078` (IN-chunk pattern), `getLibraryHealth:843`, `folderTrackRowsCache:617`/`invalidateFolderTrackRowsCache:1497` (+ call sites 819/1148/1182/1373), `dnaIndexCache:611`/`buildDnaIndex:2272`/`getAllTrackDna:2671`, `findSimilarTracks:2688`, `upsertTracks:745`/`IncomingTrack:560`, `many:3676`/`one:3663`/`rowToTrack:469`, HomeView fan-out `:115`. All real.
- **Assumption to verify during execution:** the exact `LIBRARY_ROW_HEIGHT` (T6) and AlbumsView card dimensions (T7) must be read from the actual markup/CSS at implementation time; the plan can't hardcode a px value sight-unseen — measure and set the constant with a comment.
