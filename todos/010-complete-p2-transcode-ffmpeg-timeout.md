---
status: complete
priority: p2
issue_id: "010"
tags: [code-review, reliability, transcode-cache, concurrency, resource-leak]
dependencies: []
---

# Hung ffmpeg encode pins a semaphore slot + inflight entry forever → wedges all ffmpeg-mode playback

## Problem Statement
The production transcode path has no watchdog. A single stalled `ffmpeg` (truncated/
malformed `.wma`/`.ape`/`.dts`/`.dsf` — exactly the formats this cache targets) holds a
concurrency slot AND its inflight-map entry indefinitely. Because `getOrTranscodeToFlac`
`await`s the job and the protocol handler `await`s the cache, every later fetch for that
track piles onto the same never-settling promise. With `MAX_CONCURRENT` = `cpus()-1`
capped at 2 (i.e. **1 on a 2-core box**), one or two stuck files wedges *all*
ffmpeg-mode playback for the session.

## Findings (kieran-typescript-reviewer, P2; corroborated by performance-oracle)
- `transcode-cache.ts:158-177` — `runFfmpegToFile()` resolves/rejects only on `close`/`error`. No timeout, no kill-on-stall. (Contrast `probeFfmpeg()` at `:249-279`, which correctly uses a 3s `setTimeout` + `child.kill()`.)
- `transcode-cache.ts:134` (`await acquire()`) + `:140` (`await runFfmpegToFile`) — a hung child never releases the semaphore (`release()` only runs in the `finally`, which never fires).
- `transcode-cache.ts:114-131` — the inflight entry is removed via `job.finally(...)`, which also never fires; subsequent same-key callers `await` the dead promise.
- `main.ts:~1090` — `const cached = await getOrTranscodeToFlac(filePath)` never returns → the protocol handler hangs → the `<audio>` element stalls with no fallback.

## Proposed Solutions
1. **Per-encode timeout + kill (recommended).** Wrap the `spawn` in `runFfmpegToFile`
   with a timeout (e.g. 60s — generous for a 20-min track at `-compression_level 1`; make
   it a const). On expiry: `child.kill()` and `reject(new Error('ffmpeg timed out after Ns for <path>'))`.
   The existing `runTranscode` `catch` already unlinks the temp + the `finally` releases
   the slot, and `getOrTranscodeToFlac` maps the rejection to `transcode-failed` → live-stream
   fallback. Effort: **Small**. Risk: pick the timeout high enough not to abort legit long
   DSD encodes (soxr precision=28 is the long pole).
2. **Idle-based timeout (more robust).** Reset the timer on each `stderr`/stdout-progress
   chunk (`-progress pipe:2`) so only a *truly stalled* (no-output) ffmpeg is killed, never a
   slow-but-progressing one. Effort: Medium.
3. **Watchdog + negative cache.** On timeout, also record the key in a short-TTL negative
   cache (see todo 002) so a pathological file doesn't re-spawn ffmpeg + re-stall every play.
   Effort: Medium. Pairs naturally with 002.

## Recommended Action
(blank — triage)

## Technical Details
- Affected: `electron/transcode-cache.ts` (`runFfmpegToFile`, and the `acquire`/inflight
  lifetime it gates).
- Interacts with: todo 002 (failure surfacing / negative cache), todo 008 (semaphore handoff).

## Acceptance Criteria
- [ ] A spawned encode that never closes is killed after the timeout and rejects cleanly.
- [ ] After a timed-out encode, the semaphore slot is released and the inflight entry cleared (next play of any track works).
- [ ] A new smoke (or extension of `smoke:transcode-seek`) feeds ffmpeg a never-finalizing input and asserts the cache recovers (no wedge, falls back).
- [ ] Legit long DSD/APE encodes are NOT aborted by the timeout.

## Work Log
- 2026-06-07: Filed from `/review` multi-agent pass (kieran-typescript-reviewer P2; performance-oracle corroboration). Only review finding not already covered by todos 001-009.
- 2026-06-07: DONE — added `FFMPEG_TIMEOUT_MS` (180s) watchdog to `runFfmpegToFile` (`transcode-cache.ts`): kills the child + rejects on stall, guarded by a `settled` flag so close/error/timeout can't double-settle. On timeout `runTranscode` unlinks the temp, the semaphore slot is released, and the protocol handler falls back to the live stream — no wedge. typecheck + `smoke:transcode-seek` pass. (Idle-based timeout + negative cache, AC item 3's dedicated hang-fixture test, deferred — hard cap covers the wedge risk.)

## Resources
- `electron/transcode-cache.ts:158-177` (no-timeout spawn), `:249-279` (probe, which DOES time out — copy the pattern)
- Related: `todos/002` (failure surfacing), `todos/008` (semaphore handoff)
