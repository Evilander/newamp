---
status: pending
priority: p2
issue_id: "006"
tags: [code-review, audio, transcode-cache, audiophile]
dependencies: []
---

# FLAC cache "bitwise lossless" comment overclaims; multichannel silently downmixed; DSD not in recipe tag

## Problem Statement
`buildPlaybackFlacArgs` is genuinely lossless for the common case (stereo PCM ≤24-bit —
`-sample_fmt s32` does NOT inflate 16/24-bit sources; FLAC writes the source
`bits_per_raw_sample` to STREAMINFO). But the `transcode.ts:138` comment "verified by
audiophile review … bitwise lossless" overclaims for two real edges and one omission.

## Findings (audiophile-snob)
- `transcode.ts:163-164` — `-ac 2` silently downmixes 5.1 **DTS/AC3** (both in FFMPEG_FALLBACK_EXTS) via the codec's default matrix (DTS's is clipping-prone). Lossy, undisclosed, and the cache key/header don't record it. (Old WAV pipe had the same flaw — not a regression, but the comment claims fidelity the code doesn't deliver here.)
- `transcode.ts:150` — true **32-bit-int** sources: ffmpeg-static's FLAC encoder may clamp to 24-bit (silent 8-bit truncation) or fail; Chromium 32-bit FLAC decode is unverified. Rare in real libraries, but the comment claims it works.
- `transcode-cache.ts:43` — `RECIPE_TAG='flac-s32-cl5-v1'` does NOT encode the DSD sub-recipe (soxr precision=28 → 88.2 kHz); changing those won't invalidate stale DSD cache entries.

## Proposed Solutions
1. Rewrite the comment honestly: "bitwise lossless for stereo PCM ≤24-bit; multichannel is downmixed to stereo; DSD is soxr-resampled to 88.2 kHz PCM (not lossless)." Drop the "verified by audiophile review" tag (this review downgraded it). Effort: S.
2. Fold the DSD sub-recipe into RECIPE_TAG (e.g. `…-dsd-soxr28-88200-v1`). Effort: S.
3. (edge) Probe channel count; for >2ch either record the downmix in the cache header/metadata or use a deterministic ITU `pan=` matrix. Effort: M.
4. (edge) Init-time 32-bit-int probe: encode→decode→check STREAMINFO bps; log once if it can't do 32-bit. Effort: M.
5. CI null-test: encode known 16/24-bit fixtures through `buildPlaybackFlacArgs`, decode, assert peak error ≤ -144/-150 dBFS. Effort: M. (The only thing that makes "lossless" *verified*.)

## Acceptance Criteria
- [ ] No comment claims fidelity the code doesn't deliver.
- [ ] DSD recipe changes invalidate the cache.

## Work Log
- 2026-06-07: Filed from /review (audiophile-snob). Confirmed s32 is lossless for ≤24-bit stereo; flagged multichannel/32-bit/DSD-tag.
