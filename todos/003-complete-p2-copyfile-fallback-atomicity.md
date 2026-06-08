---
status: complete
priority: p2
issue_id: "003"
tags: [code-review, data-integrity, transcode-cache]
dependencies: []
---

# atomicRename copyFile fallback can publish a half-written FLAC (served on next cache hit)

## Problem Statement
`atomicRename`'s last-resort `copyFile(temp, finalPath)` writes directly to the final
path and is NOT atomic. If the process is killed (or power-cuts) mid-copy, `finalPath`
exists truncated. The cache-hit path (`existsSync(finalPath)` → return) does NOT
re-validate via `readFlacTotalSamples`, so the truncated FLAC is served — Chromium
refuses to seek past the truncation and audio glitches/cuts off mid-track.

## Findings (data-integrity-guardian 3a)
- `electron/transcode-cache.ts:198-218` — `if (attempt === 3) { await copyFile(temp, finalPath); ... }`.
- `electron/transcode-cache.ts:108-112` — cache-hit returns without re-validating STREAMINFO.

## Proposed Solutions
1. Stage the copy then atomic-rename:
   ```js
   const stage = `${finalPath}.copy.part`;
   await copyFile(temp, stage);
   await rename(stage, finalPath); // atomic on same volume
   await unlink(temp).catch(() => {});
   ```
   Effort: S. Risk: none.
2. Or re-run `readFlacTotalSamples(finalPath)` on the first cache-hit of a session and unlink if 0. Effort: S.

## Acceptance Criteria
- [ ] No code path can publish a `finalPath` that wasn't either atomically renamed or STREAMINFO-validated.

## Work Log
- 2026-06-07: Filed from /review (data-integrity-guardian).
- 2026-06-07: FIXED. `atomicRename` copy-fallback now stages to `${finalPath}.copy.part` then atomically renames into place (cleans the stage + rethrows if the final rename fails). finalPath is now only ever published via an atomic rename. Verified: electron typecheck + smoke:transcode-seek green.
