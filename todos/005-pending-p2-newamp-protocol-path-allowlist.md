---
status: pending
priority: p2
issue_id: "005"
tags: [code-review, security, transcode-cache, hardening]
dependencies: []
---

# `newamp:` protocol accepts ANY absolute path → arbitrary-file-read, now persisted by the cache

## Problem Statement
The `newamp:` handler resolves any absolute path, `existsSync`-gates it, and serves it
(or feeds it to ffmpeg). There is no library-root containment. **Pre-existing**, but the
new cache amplifies it: a non-audio system path (e.g. `newamp://track/C:/Users/.../id_rsa`)
falls through to `playbackMode==='ffmpeg'`, gets read by ffmpeg, and its decodable bytes
are written to a **persistent** `userData/transcode-cache/*.flac` served with
`Access-Control-Allow-Origin: *`. Realistic threat needs a compromised renderer / HTML
injection (lyrics/metadata) — the renderer CSP is `script-src 'self'`, so not currently
reachable, but this is a defense-in-depth gap worth closing while touching this path.

## Findings (security-sentinel 1.1 + 5.1)
- `electron/main.ts:1079-1090` — no allowlist; `resolve(raw)` + `existsSync` only.
- `electron/transcode-cache.ts:99-105, 220-233` — symlink TOCTOU: `realpath` for the key, then ffmpeg re-opens the original path; a swap between them caches B's audio under A's key (real on macOS/Linux; Windows needs dev-mode for symlinks).
- ffmpeg spawn itself is injection-safe (array args, no shell) — confirmed, no fix needed.

## Proposed Solutions
1. In the `newamp` handler, before serving: `realpath(filePath)` and require it to live under one of `settings.libraryRoots` (also realpathed) OR an opened-files allowlist; else 403. Effort: S–M. Neutralizes 1.1 and most of 5.1.
2. In `getOrTranscodeToFlac`, refuse to cache when `realpath(filePath) !== normalized(filePath)` (reject symlinked inputs), or include device+inode/file-id in the key. Effort: S.

## Acceptance Criteria
- [ ] A `newamp://track/<path-outside-library>` request returns 403 and never spawns ffmpeg / writes a cache file.
- [ ] Library playback (paths under configured roots) is unaffected.

## Work Log
- 2026-06-07: Filed from /review (security-sentinel). Noted pre-existing core + cache amplification.
