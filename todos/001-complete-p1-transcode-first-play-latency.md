---
status: complete
priority: p1
issue_id: "001"
tags: [code-review, performance, transcode-cache, audio]
dependencies: []
---

# Seekable-FLAC cache: first play awaits the WHOLE file transcode (seconds–minutes of silence)

## Problem Statement
The `newamp:` protocol handler `await`s `getOrTranscodeToFlac()` before serving any
bytes, and that only resolves after ffmpeg encodes the **entire** track to FLAC and
STREAMINFO is verified. So the *first* play of an ffmpeg-mode file (.wma/.alac/.aiff/
.ape/.wv/.dsf/.dff…) is silent until the full encode finishes. The old
`transcodeToWavResponse` pipe streamed within tens of ms. This is a real UX regression
for first-play (subsequent plays/seeks are instant cache hits).

## Findings (performance-oracle)
- `electron/main.ts:~1086` — handler awaits the cache before responding.
- `electron/transcode-cache.ts:121-127` — resolves only after `runFfmpegToFile` + `readFlacTotalSamples`.
- Estimated cold-start silence: ~2–5 s (3-min ALAC), ~8–18 s (9-min APE), **20–45 s (15-min DSF + soxr precision=28)**, multi-minute (hour-long mka). AV scan on the `.part` write roughly doubles it.
- Compounded by gapless `prepareNext` (`usePlayerStore.ts:~644`) competing for the 2-slot semaphore.

## Proposed Solutions
1. **Quick mitigation (ship first):** `electron/transcode.ts:~150` change `-compression_level 5` → `1` (or `0`). 2–4× faster encode, negligible size cost for an 8 GB cache. Effort: S. Risk: none.
2. **Stream-while-encoding (proper fix):** on the first fetch for a key, tee ffmpeg stdout → a `PassThrough` returned as the Response body (Accept-Ranges: none, first play only) while the other branch writes the cache file; serve Range from the finalized file on subsequent plays. Effort: M. Risk: medium (stream lifecycle).
3. **Progress affordance:** parse ffmpeg `-progress pipe:2` (stderr already captured) → IPC `transcode-progress` → non-blocking "Preparing lossless playback…" in the player. Effort: M.
4. **Pre-warm at scan/idle** + push `prepareNext` earlier for ffmpeg-mode next tracks. Effort: M.

## Recommended Action
(triage) Ship #1 now; design #2 + #3 for the next pass.

## Acceptance Criteria
- [ ] First play of a 10-min APE starts audio in < 1 s (or shows a progress affordance).
- [ ] `prepareNext` of an ffmpeg-mode track never blocks a user-initiated play.

## Work Log
- 2026-06-07: Filed from /review (performance-oracle). Verified the await-full-file flow in main.ts + transcode-cache.ts.
- 2026-06-07: PARTIAL — applied mitigation #1: `buildPlaybackFlacArgs` compression_level 5→1 (≈2–4× faster encode; bit-identical audio; RECIPE_TAG bumped to flac-s32-cl1-v1). Cuts first-play wait for ALAC/AIFF/APE/WV. Does NOT help DSD (soxr precision=28 is the long pole there). STILL OPEN: the proper fix (#2 stream-while-encoding) + #3 progress affordance — the handler still awaits the full encode. Leaving PENDING.
- 2026-06-09: COMPLETE — stream-first fix shipped (audio-correctness plan, Task 1). New non-blocking `peekCachedFlac` probe in `electron/transcode-cache.ts` (never transcodes, ignores `.part` files; unit-tested by `scripts/transcode-peek-test.mjs` / `npm run test:transcode-peek`). The `newamp:` handler ffmpeg branch now: ffmpeg-missing → 503 up front; peek hit → seekable cached FLAC (unchanged); peek miss → fire-and-forget `getOrTranscodeToFlac` warm (semaphore-bounded, inflight-deduped) + immediate `transcodeToWavResponse` live stream. First play starts in tens of ms; the next play is seekable. Acceptance met: first play < 1 s via the wav pipe; `prepareNext` only warms the cache and never blocks a user-initiated play. `smoke:transcode` + `smoke:transcode-seek` pass unchanged.
