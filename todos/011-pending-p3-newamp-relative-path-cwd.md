---
status: pending
priority: p3
issue_id: "011"
tags: [protocol, paths, smoke]
dependencies: []
---

# `newamp:` handler reconstructs absolute paths via `resolve(raw)` — cwd-dependent

## Problem Statement
The handler strips leading slashes from the URL pathname and calls `resolve(raw)`.
On POSIX an absolute source path (`/Users/...`) becomes relative after the strip, so
`resolve` only reconstructs it correctly when `process.cwd() === '/'` (true for
packaged/Finder launches, false when the app is spawned with a project cwd — e.g.
`smoke:ui-playback`, which fails for this reason on dev machines).

## Findings
- Found during the security-pass allowlist work (2026-06-09): `smoke:ui-playback`
  fails identically on a clean tree (pre-existing, NOT caused by the allowlist).
- Windows paths (`K:/music/...`) are unaffected (drive letter survives the strip).

## Proposed Solution
Reconstruct POSIX absolute paths explicitly: if the stripped `raw` does not match
`/^[a-zA-Z]:[\\/]/` (Windows drive), treat it as `'/' + raw` instead of `resolve(raw)`.
Then `smoke:ui-playback` should pass regardless of spawn cwd.

## Acceptance Criteria
- [ ] `smoke:ui-playback` passes when spawned with a non-root cwd.
- [ ] Packaged playback unaffected on macOS + Windows.

## Work Log
- 2026-06-09: Filed from the security-pass T1 report.
