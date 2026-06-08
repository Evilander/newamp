---
status: pending
priority: p3
issue_id: "008"
tags: [code-review, typescript, transcode-cache, simplicity]
dependencies: []
---

# Transcode-cache TypeScript & simplicity polish (grouped P3)

## Findings (kieran-typescript-reviewer / code-simplicity-reviewer)
- `transcode-cache.ts:203` — `catch (err: any)` → `catch (err: unknown)` + narrow via `(err as NodeJS.ErrnoException)?.code`. (TS FAIL-by-bar, but pure hygiene)
- [DONE 2026-06-07] `transcode-cache.ts` — semaphore rewritten to the hand-off pattern: `release()` hands the slot to the next waiter without decrementing (else decrements); `acquire()` no longer re-increments after the await. Closes the transient over-admission race. (TS #4)
- `transcode-cache.ts:98` — `let st;` → `const st = await stat(filePath).catch(() => null); if (!st) return {ok:false, reason:'source-missing'};`. (TS #3)
- `transcode-cache.ts:235-265` — `probeFfmpeg`'s `settled` double-resolve guard is dead (Promise ignores extra resolves); the `try/catch` around `spawn` is dead (spawn emits 'error', doesn't throw sync for ENOENT). Drop both (~9 lines). (simplicity #1)
- `transcode-cache.ts:133-134` — per-job temp entropy over-built; `${key}.${process.pid}.${Date.now().toString(36)}.flac.part` is sufficient (drop the sha1). (simplicity #2)
- `transcode-cache.ts:190-191` — add "9 hex f's = 36 bits" comment next to the `0xfffffffffn` mask; optionally assert `packed` low-36 ≤ MAX_SAFE_INTEGER. (TS #5)
- Optionally rename `buildPlaybackFlacArgs` → `buildFlacCacheArgs` for producer/consumer clarity. (architecture)

## Acceptance Criteria
- [ ] No `any` in the cache module.
- [ ] `npm run typecheck` + `smoke:transcode-seek` + `smoke:playback-seek` still pass.

## Work Log
- 2026-06-07: Filed from /review. Note: STREAMINFO parse offsets are CORRECT (verified) — comment-only here.
