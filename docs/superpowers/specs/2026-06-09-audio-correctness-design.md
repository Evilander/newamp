# Audio Correctness Pass — Design

**Date:** 2026-06-09
**Status:** Approved (standing user trust)
**Goal:** Fix the two remaining P1 audio findings from the 2026-06-09 audit: the deferred-seek wrong-track race in the engine, and the blocking first-play transcode (todo 001's "proper fix").

## A1. Guarded deferred-metadata seeks — `src/audio/engine.ts`

**Problem.** Two sites register `{ once: true }` `loadedmetadata` listeners to land a seek once metadata arrives: `applyStartPosition` (`:606-615`) and the seek-retry in the seek path (`:848-860`). Neither is guarded: if the deck's `src` is replaced before metadata loads (routine: `prepareNext` track B, then the user plays track C on the same deck; or `silenceDeck(clearSrc:true)`), the pending listener either leaks (closure over the old deck/target) or fires against the **new** src and seeks the wrong track to the old offset. The VBR diagnostic in the same file already demonstrates the correct guard (`scheduledSrc = el.currentSrc`, bail when changed, `seekSeq` supersession — `:881-887`).

**Change.**
- New private helper `scheduleMetadataSeek(deck: Deck, target: number)`:
  - removes any previously-pending listener for that deck (stored as `deck.pendingSeek?: { handler: () => void }` on the Deck record — extend the `Deck` type),
  - captures `const scheduledSrc = deck.el.currentSrc;`,
  - registers a `{ once: true }` `loadedmetadata` handler that first checks `deck.el.currentSrc === scheduledSrc` (bail silently otherwise), then clamps + assigns `currentTime` exactly as the current code does,
  - clears `deck.pendingSeek` when it fires or is replaced.
- `applyStartPosition` and the seek-retry both use the helper instead of inline `addEventListener`.
- `silenceDeck` removes the deck's pending listener (and clears `pendingSeek`) before clearing `src`.

Behavior for the normal path is unchanged (same clamp math, same once-semantics). The only difference: a stale listener can no longer fire against a different src, and pending listeners are torn down with the deck.

## A2. Stream-first playback while the FLAC cache warms — `electron/transcode-cache.ts`, `electron/main.ts`

**Problem (todo 001, still open after the cl5→cl1 mitigation).** The `newamp:` handler (`main.ts:~1124`) `await`s `getOrTranscodeToFlac(filePath)` on every request; on a cache miss that resolves only after the **entire** track is encoded (and STREAMINFO verified) — seconds for ALAC/APE, 20-45 s for long DSD. First play is silent the whole time. The degraded path `transcodeToWavResponse(filePath, request)` already exists in the same handler (used when the cache fails) and streams audio within tens of ms.

**Change.**
- `transcode-cache.ts`: new export
  ```ts
  /** Non-blocking probe: the finalized cached FLAC's path, or null (never transcodes). */
  export async function peekCachedFlac(filePath: string): Promise<string | null>
  ```
  Implemented from the existing internals: compute `canonicalKey` (requires the same `stat` the current code does), check the finalized cache file exists (NOT a `.part`), return its path; null on any miss/error/disabled-cache. Must NOT touch the semaphore or `inflight`.
- `main.ts` ffmpeg branch becomes:
  1. `const ready = await peekCachedFlac(filePath);`
  2. **Hit** → serve the range-capable FLAC exactly as today (the existing `net.fetch` block, using `ready` as the path).
  3. **Miss** → `void getOrTranscodeToFlac(filePath).catch(() => {});` (fire-and-forget warm; the existing 2-slot semaphore + inflight dedup bound concurrent ffmpeg work and coalesce duplicate warms) and immediately `return transcodeToWavResponse(filePath, request);` with header `X-Newamp-Playback: ffmpeg-live-stream` (the wav path's existing behavior). First play = instant audio, non-seekable (pre-cache behavior, already handled by the recent scrub-fix work); next play = cache hit = seekable.
  4. `ffmpeg-missing` 503 stays as-is (probe can't distinguish — keep the check where it lives today: if the warm rejects with ffmpeg-missing nothing changes for the current response; the wav pipe will surface its own failure as it always has).

**Resource note.** A first play briefly runs two ffmpeg decodes (live WAV pipe + background FLAC encode). The encode is semaphore-bounded (2 slots) and `inflight`-deduped; this is an accepted trade for instant audio, documented in code.

**Acceptance (from todo 001).**
- First play of a long ffmpeg-mode file starts audio in < 1 s (wav pipe).
- A repeat play of the same file serves `X-Newamp-Playback: ffmpeg-cached-flac` (seekable).
- `prepareNext` of an ffmpeg-mode track never blocks a user-initiated play (it only warms the cache now).

## Testing
- **A2 unit (`scripts/transcode-peek-test.mjs`, dist-electron harness like `library-query-test`):** with a temp cache dir: `peekCachedFlac(file)` → null before any transcode; after `getOrTranscodeToFlac(file)` completes → non-null and equal to the cached path; `.part` files are never returned (simulate by writing a bare `.part`); probe never creates files.
- **Existing smokes:** `smoke:transcode`, `smoke:transcode-seek` (these build fixtures with ffmpeg and exercise both serve paths), plus `smoke:playback-start` for A1's normal path. Run `smoke:session` (resume-at-position exercises `applyStartPosition`).
- **A1:** no clean pure seam (DOM listeners); verified by typecheck + the playback/session smokes + code review against the race description. Update `todos/001` work log and mark complete; file the same for the audit A1 item.

## Out of scope
- Security pass (`newamp:` path allowlist todo 005, podcast SSRF) — the next and final roadmap item.
- WebCodecs gapless rewrite, native output backend (documented future work in docs/audio-quality.md).
