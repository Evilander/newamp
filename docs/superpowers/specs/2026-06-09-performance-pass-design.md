# Performance Pass — Design

**Date:** 2026-06-09
**Status:** Approved (design), pending implementation plan
**Goal:** Remove the real performance problems the 2026-06-09 audit found — the steady-state CPU drain during playback, main-process DB stalls, and unbounded DOM growth — while staying dependency-light (virtualization is hand-rolled, no new runtime deps).

All changes are behavior-preserving optimizations. Browser/electron-only logic is isolated into pure, Node-testable seams where practical (same pattern as the Eviland and macOS passes). Tests are esbuild-bundle-then-import harnesses like `scripts/eviland-director-test.mjs`.

Note: `electron/library.ts` is flagged by `grep`/`file` as binary ("data") due to a non-UTF8 byte (a comment near line 269, `"ÉLAN"`); use `grep -a` or the editor's Read. This is cosmetic and out of scope here.

The work is one workstream of 7 items, grouped so each is independently committable/reviewable. Default order below (safer wins first; the large `NowPlayingView` refactor is its own carefully-reviewed task near the end).

---

## B1. De-N+1 `getTracksByIdsInOrder` — `electron/library.ts:1011`

Current:
```ts
getTracksByIdsInOrder(ids: number[]): Track[] {
  return ids.map((id) => this.getTrack(id)).filter((track): track is Track => !!track);
}
```
`getTrack` (`:1006`) runs one prepared `SELECT * FROM tracks WHERE id = ?` per id on single-threaded WASM sql.js. A 500-track queue restore = 500 prepare/bind/step cycles, blocking IPC. Used by `library:get-tracks-by-ids` (main.ts:1318/1323), `findSimilarTracks`, smart-playlist rules, `radio-brain.ts`.

**Change:** chunked `WHERE id IN (...)` (mirror `getTrackFileStates:1078-1091`, chunk 500) into a `Map<number, Track>`, then map input ids → preserve order, drop missing, dedupe. One query per 500 ids instead of one per id.

**Test (unit, in-memory LibraryStore):** insert tracks 1..1000; assert `getTracksByIdsInOrder([5,1,5,999999,3])` returns tracks `[5,1,3]` in that order (dup `5` collapsed, missing id skipped); assert a 1000-id request returns 1000 in input order.

## B2. Cache `getLibraryHealth` — `electron/library.ts:843`

`getLibraryHealth` scans every track row and reclassifies (`classifyAudioQuality`, duplicate map, legacy-format map) on **every** call; HomeView calls it on every open. There is an existing `folderTrackRowsCache` invalidated on writes (search `invalidate`/`upsertTracks`/prune).

**Change:** add a `libraryHealthCache: LibraryHealth | null` field; `getLibraryHealth` returns it when non-null, else computes + stores. Invalidate (set to null) in the same place(s) `folderTrackRowsCache` is invalidated (track upsert / prune / delete). No behavior change beyond freshness timing (cache reflects last write, which is exactly when it changes).

**Test:** open in-memory store, insert tracks, call `getLibraryHealth()` twice → second call returns a deep-equal object and (assert via a spy/counter on the row-scan, or by inserting between calls) recomputes only after an upsert.

## R5. `findSimilarTracks` uses the DNA index cache — `electron/library.ts`

`findSimilarTracks` calls `getAllTrackDna()` directly (re-`SELECT` + `JSON.parse` of every `dna_json` blob per call) instead of the existing `buildDnaIndex()` cache (which is invalidated correctly). `SoundsLikePanel` calls this on every track change.

**Change:** iterate `this.buildDnaIndex()`'s cached map instead of `getAllTrackDna()`. Combined with B1, the top-N lookup is also de-N+1'd. (Behavior identical; only removes redundant parse work.)

**Test:** covered indirectly by B1's test + a smoke that `findSimilarTracks` returns the same ids before/after (if a DNA fixture is practical); otherwise a targeted unit check that two consecutive calls don't re-parse (counter/spy). Keep minimal — the cache + its invalidation already exist and are tested by the dna smoke.

## R4. Lazy album art — `src/components/views/AlbumsView.tsx`

The art `<img>` (~line 715) requests all covers on a page immediately through `newart://`, each triggering a synchronous main-thread `getArt` query + `readFileSync`.

**Change:** add `loading="lazy"` and `decoding="async"` to the cover `<img>`. One-line, no test (verified by running); browser only fetches visible tiles.

## R2. Defer HomeView's heavy fan-out — `src/components/views/HomeView.tsx:115`

13 IPC calls in one mount `Promise.all`; several (`getLibraryHealth`, `buildHarmonicMix`, `buildTasteMix`, `getSuggestedSmartPlaylistRules`) full-scan or serialize on sql.js, stalling first paint.

**Change:** split the single `Promise.all` into:
- **above-the-fold** (rendered immediately on mount): `getStats`, fresh/loved/history/heavy `getTracks`, `getPlaylists`.
- **below-the-fold** (loaded after first paint via `requestIdleCallback`, fallback `setTimeout(…, 0)`): `getLibraryHealth` (now cached by B2), `getListeningInsights`, `buildHarmonicMix`, `buildTasteMix`, `getTracks{rating}`, `getSmartPlaylistRules`, `getSuggestedSmartPlaylistRules`, `getSuggestedStations`.

Keep the existing rendering; below-the-fold sections show a light placeholder until their data arrives. No new deps. Verified by running + `smoke:home` staying green.

## R3. Hand-rolled list virtualization — new `src/hooks/useVirtualRows.ts`, `src/components/views/LibraryView.tsx`, `src/components/views/AlbumsView.tsx`

No virtualization exists; `LibraryView` paginates at 600 and "load more" **appends**, so the DOM accumulates thousands of heavy `<tr>`s; selection state lives in the parent so toggling one checkbox re-renders every row.

**New pure hook** `useVirtualRows({ rowCount, rowHeight, overscan }, scrollElRef)` → `{ startIndex, endIndex, topPad, bottomPad, onScroll }` (or a `totalHeight` + per-item offset). Pure math: from `scrollTop` + viewport height + `rowHeight`, compute the visible window ± overscan and the spacer sizes. Dep-free.

**LibraryView:** render only `tracks.slice(startIndex, endIndex+1)` inside a scroll container with top/bottom spacer rows (or a sized inner container). Extract the row into a `React.memo`'d `LibraryRow` keyed by `t.id` with stable (`useCallback`) handlers and primitive props (incl. `selected: boolean`) so a selection toggle re-renders only the changed row. Assumes fixed row height (the table rows are uniform); document the constant.

**AlbumsView:** same hook for the album grid (row = a grid row of N covers; compute columns from container width). Lower priority than the track table; include if straightforward, else note as the one deferrable sub-item.

**Test:** pure unit test of `useVirtualRows`' math extracted as a pure function `computeVisibleWindow({ scrollTop, viewportH, rowHeight, rowCount, overscan })` → `{ startIndex, endIndex, topPad, bottomPad }`. Assert: top of list, middle, bottom, tiny list (no negative pads), overscan clamping at edges.

## R1. Memoize `NowPlayingView` — `src/components/views/NowPlayingView.tsx`

2,634 lines, **zero `React.memo`/`useCallback` beyond 3 incidental `useMemo`s**. Subscribes to `currentTime` (`:53`, updated 10 fps by the engine) and threads it as a prop into ~30 children (`SpectrumPanel`, `WaveformOverview`, `LyricsPanel`, `TrackSignalPanel`, etc. — `:551/:600/:612` …), so the whole subtree reconciles 10×/sec for the entire duration of playback.

**Change (the delicate one — its own task, careful review):**
1. **Isolate the clock.** Create small leaf components that subscribe to `currentTime` themselves and render only the time-driven UI: the scrub/seek bar position + elapsed/remaining text, and the active-lyric-line highlight. The parent stops reading `currentTime` for those.
2. **Stop drilling `currentTime`** into clock-independent panels (`SpectrumPanel`, `AlbumContextPanel`, `SoundsLikePanel`, `ArtistImageStage`, `TrackSignalPanel`, `BookmarkPanel`, etc.).
3. **`React.memo`** those panels and **`useCallback`** the handlers passed to them so they actually stay stable.
4. The parent `NowPlayingView` no longer re-renders on the clock; only the small leaves update 10×/sec.

Preserve all existing behavior (scrubbing, lyric sync, practice-loop restart at `:238`, bookmark-at-current at `:273`). Where a panel genuinely needs the current time only at an event (e.g., "bookmark at current position"), read it imperatively from the store (`usePlayerStore.getState().currentTime`) in the handler instead of subscribing.

**Test:** behavior-preserving refactor — no pure-logic seam. Verify with: typecheck; a render-instrumentation check if feasible (e.g., a dev-only render counter asserting the parent doesn't re-render across simulated `currentTime` ticks); and manual confirmation (play a track, scrub, lyrics still highlight). Do NOT claim a perf win without at least the render-count evidence or a profiler note.

---

## Testing & gate (all items)
- New Node unit tests (esbuild harness): `getTracksByIdsInOrder` ordering/dedup, `getLibraryHealth` cache+invalidation, `computeVisibleWindow` math.
- Existing smokes stay green: `smoke:library`, `smoke:home`, `smoke:visualizer`, plus `typecheck`.
- New tests wired into CI (`.github/workflows/ci.yml`), matching the Eviland/macOS pattern.
- R1/R2/R3-AlbumsView/R4 are verified by running the app (and smokes); only the pure seams get unit tests.

## Out of scope (follow-ups)
- The remaining audit items: audio correctness (`loadedmetadata` seek guard, blocking first-play transcode), security (`newamp:` path allowlist, podcast SSRF). These are the next two passes.
- Store-subscription micro-optimizations (`usePlayerStore` 10 fps subscriber work) — already cheap branching; not worth the churn now.
- Full DB indexing review / sql.js → native SQLite — large, separate effort.
