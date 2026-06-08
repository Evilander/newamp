---
status: pending
priority: p2
issue_id: "002"
tags: [code-review, reliability, transcode-cache, silent-failure]
dependencies: []
---

# Cache failures silently disable seek / collapse to "Audio error (code 4)" with no signal

## Problem Statement
Every cache failure mode degrades silently, so the user gets the exact bug the cache
was built to fix (scrub-snaps-to-0) — or a generic error — with zero actionable info.

## Findings (silent-failure-hunter C1/C2/C3)
- `transcode-cache.ts:71-87` — `mkdir` failure (EPERM/ENOSPC/OneDrive lock/AV) sets `cacheEnabled=false` permanently → `main.ts:~1118` silently falls back to the non-seekable WAV pipe for ALL lossless formats. No user/diagnostic signal. `transcodeCacheStatus()` is exported but **has zero callers**.
- `transcode-cache.ts:138-149` — per-track STREAMINFO-reject → `transcode-failed` → silent WAV fallback, and re-runs ffmpeg on every play (no negative cache).
- `main.ts:~1112` + `src/audio/engine.ts:363-371` — `503 ffmpeg-missing` (with `X-Newamp-Reason`) collapses to `Audio error (code 4)`; nothing reads the header. User thinks one .wma is broken when every lossless format is dead.

## Proposed Solutions
1. Set `X-Newamp-Reason: ${cached.reason}` on the WAV fallback Response (`main.ts:~1118`), and have `engine.ts`'s audio-error handler / a boot-time `transcodeCacheStatus()` IPC surface a one-shot `EngineState.error` like "Seekable transcode unavailable — scrubbing disabled for lossless formats." Effort: S.
2. Per-track negative cache (Map<key,{failedAt,reason}> + short TTL) so a corrupt source isn't re-encoded every play. Effort: S.
3. Wire `transcodeCacheStatus()` into the About/Diagnostics panel. Effort: S.

## Acceptance Criteria
- [ ] A locked/unavailable cache dir produces a visible one-shot warning, not a silent regression.
- [ ] ffmpeg-missing surfaces an actionable message naming ffmpeg.
- [ ] A corrupt source isn't re-transcoded on every play.

## Work Log
- 2026-06-07: Filed from /review (silent-failure-hunter).
