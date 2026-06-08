---
status: complete
priority: p2
issue_id: "004"
tags: [code-review, reliability, transcode-cache]
dependencies: []
---

# `void job.finally(...)` leaks an unhandled rejection on every failed transcode

## Problem Statement
`job.finally(...)` returns a second promise that mirrors the original rejection. The
original is handled by `await job` in the try/catch, but the `.finally(...)` chain is
discarded with `void` and no `.catch`, so every failed transcode (corrupt source,
ffmpeg crash, the explicit STREAMINFO-0 throw, exhausted rename retries) fires
`unhandledRejection` → `writeDiagnosticEvent('main-unhandled-rejection', ...)` + log
spam. It doesn't crash, but it pollutes the crash-triage channel — wrong signal/noise
for a release.

## Findings (feature-dev:code-reviewer, confidence 85)
- `electron/transcode-cache.ts:118` — `void job.finally(() => inflight.delete(key));`
- `electron/main.ts:~3894` — global unhandledRejection writes a diagnostic event.

## Proposed Solution
`void job.finally(() => inflight.delete(key)).catch(() => {});` (or `.then(del, del)`).
Effort: S (one line). Risk: none.

## Acceptance Criteria
- [ ] Skip-loading a malformed track produces NO `main-unhandled-rejection` diagnostic event (the caller already returns a clean `{ok:false}`).

## Work Log
- 2026-06-07: Filed from /review (bug-hunt).
- 2026-06-07: FIXED. Added `.catch(() => {})` to the `job.finally(...)` side-chain in `getOrTranscodeToFlac`. Failed transcodes no longer fire unhandledRejection / spam the crash-triage diagnostic channel. Verified: electron typecheck green.
