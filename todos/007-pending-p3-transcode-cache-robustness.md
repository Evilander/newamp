---
status: pending
priority: p3
issue_id: "007"
tags: [code-review, transcode-cache, architecture, performance]
dependencies: []
---

# Transcode-cache robustness & polish (grouped P3)

## Problem Statement
Lower-severity hardening/correctness items in the new cache, grouped for one pass.

## Findings (architecture / performance / data-integrity / silent-failure)
- `transcode-cache.ts:71` — `initTranscodeCache` is not idempotent; a second call swaps `cacheDir`/`readyPromise` under in-flight waiters. Add `if (readyPromise) return;`. (architecture)
- `main.ts:~1118` — `cached.reason === 'source-missing'` falls through to the WAV pipe (spawns ffmpeg on a vanished file). Treat as 404. (architecture; TOCTOU vs the earlier existsSync)
- `transcode-cache.ts:276-305` — `evictIfNeeded` runs a full `readdir`+`stat` after every encode; track total in-memory and only scan above ~0.9×budget; add a single-flight guard so concurrent encodes don't double-scan. (performance)
- `transcode-cache.ts:296-304, 268, 278` — eviction/sweep/readdir swallow ALL errors; distinguish EBUSY/EPERM (expected, skip) from real errors (log once) so a permissions glitch can't silently stop eviction forever (unbounded disk). (silent-failure H1/H5)
- `transcode-cache.ts:267-273` — `.part` sweep deletes ALL `.part` unconditionally; add a 5-min mtime cutoff so a concurrent instance (shared `--newamp-user-data-dir` override; single-instance lock protects the default path) can't nuke a live job. (data-integrity, dev-only)
- `transcode-cache.ts:1-28` — document the (size, mtime) key trust: a tag editor that preserves mtime AND rewrites audio in place serves stale cache until eviction. Consider adding ctime or a content hash of first/last 4 KiB. (data-integrity)
- `scripts/transcode-seek-smoke.mjs:~35` — re-implements `buildPlaybackFlacArgs` ("keep in sync"); import it from `dist-electron/electron/transcode.js` so RECIPE_TAG bumps can't drift. (architecture)
- `main.ts:~1075-1142` — extract `serveAudio(filePath, request, deps)` so both `registerAudioProtocol` and `scripts/playback-seek.mjs` share it (the smoke currently re-implements the handler) and unify on `withAudioCors`. (architecture)
- Optional: a `version.txt` of `RECIPE_TAG` in cacheDir → eager nuke-on-bump instead of lazy LRU orphaning.

## Acceptance Criteria
- [ ] Eviction can't silently stop on a non-EBUSY error.
- [ ] `source-missing` → 404, not ffmpeg-on-missing-file.
- [x] Smoke imports the real arg builder (no recipe drift).

## Work Log
- 2026-06-07: Filed from /review (multiple agents).
- 2026-06-07: DONE (smoke-drift item) — `scripts/transcode-seek-smoke.mjs` now imports `buildPlaybackFlacArgs` from `dist-electron/electron/transcode.js` (deleted the inline cl5 replica); `smoke:transcode-seek` npm script gated behind `build:electron`. Re-ran: PASS on WMA/AIFF/WavPack through the shipped cl1 recipe. Remaining 007 items (eviction single-flight, source-missing→404, .part mtime cutoff, key-trust doc, serveAudio extraction) still open.
