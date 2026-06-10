# Security Pass — Design

**Date:** 2026-06-09
**Status:** Approved (standing user trust)
**Goal:** Close the two remaining audit security items: the `newamp:` protocol's arbitrary-file-read (todo 005, P2 defense-in-depth — amplified by the persistent transcode cache) and the podcast feed SSRF-to-private-hosts gap (P3).

Threat model (per audit): malicious media/skins/feeds + a hypothetically compromised renderer. CSP (`script-src 'self'`) blocks renderer compromise today; this is layered hardening, not an exploitable hole.

## S1. `newamp:` path allowlist + symlink-TOCTOU mitigation

**Problem (todo 005).** `electron/main.ts` `newamp:` handler serves ANY absolute path that exists (`resolve(raw)` + `existsSync`). Non-audio paths fall into the ffmpeg branch and their decodable bytes get written to a persistent cache served with `Access-Control-Allow-Origin: *`. Separately, the cache keys by `realpath` but ffmpeg reopens the original path — a symlink swap between the two caches B's audio under A's key.

**Authorization signal — what makes a path legitimately playable.** Library scanning, M3U import, drag-drop, and Open With are the only ways paths become playable, so the allowlist is the union of:
1. under a configured `settings.libraryRoots` entry (realpathed),
2. **a track in the library DB** (covers M3U-imported / previously-opened tracks living outside the roots — probe with `library.getTracksByPaths([original, real])`),
3. the **session opened-files allowlist** — a main-process `Set` of realpathed paths registered by every `enqueueOpenFiles`/`openFiles` entry point (CLI argv, `open-file` event, second-instance argv, `open:files` IPC i.e. drag-drop),
4. under the **podcast downloads root** (`userData/podcast-downloads`).

**Change.**
- New pure module `electron/audio-path-policy.ts` (Node-testable):
  ```ts
  export interface AudioPathPolicyInput {
    realPath: string;
    libraryRoots: readonly string[];   // realpathed by caller
    openedFiles: ReadonlySet<string>;  // realpathed by caller
    podcastRoot: string | null;        // realpathed by caller
    isLibraryTrack: boolean;
    platform?: NodeJS.Platform;        // case-folding for win32/darwin compares
  }
  export function isAllowedAudioPath(input: AudioPathPolicyInput): boolean
  ```
  Containment checks are separator-safe (`root + sep` prefix) and case-folded on win32/darwin (reuse `caseFoldCachePath`).
- `main.ts` handler: after `existsSync`, `const real = await realpath(filePath)` (404 on failure); build the policy input (realpath the few roots per request; module-level `openedAudioFiles: Set<string>` maintained at all four open-file entry points; podcast root realpathed once and cached); **403 + `X-Newamp-Reason: path-not-allowed`** before any ffmpeg/cache work when not allowed.
- **TOCTOU:** after validation, serve/transcode the **`real`** path (pass it to `peekCachedFlac`/`getOrTranscodeToFlac`/`transcodeToWavResponse`/`net.fetch`) so the validated target is exactly what's opened. (Cache keys already realpath internally — keys unchanged.)
- Smoke compatibility: the Electron playback smoke apps must keep working — they play fixture files; verify each smoke either configures `libraryRoots`, scans the fixture dir, or opens files through `open:files` (all of which authorize). If one plays a bare path outside any signal, register its fixture through the opened-files entry point it already uses (or set roots in the smoke) — do NOT special-case the handler for smoke mode unless a smoke genuinely can't express authorization; if that happens, gate on the existing `smokeMode` flag with a comment.

**Acceptance (todo 005):** a `newamp://track/<path-outside-all-signals>` request → 403, no ffmpeg spawn, no cache write; library/opened/podcast playback unaffected.

## S2. Podcast private-host guard

**Problem.** `podcasts.ts` fetches user-supplied feed/enclosure URLs; http/https-only is enforced, but `http://127.0.0.1/...`, `http://169.254.169.254/...`, or internal hostnames are reachable (P3: blast radius = user's own LAN).

**Change.** New pure `isBlockedPodcastHost(hostname: string): boolean` in `podcasts.ts` (exported for the test): blocks `localhost`, `*.localhost`, `*.local`, IPv4 literals in 0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, and IPv6 `::1`, `fc00::/7`, `fe80::/10` (parse bracketed literals). Applied inside the existing `normalizeFeedUrl`/`normalizeMaybeUrl` (reject → same null/throw path as a non-http URL). Hostname-literal guard only — DNS-pinning is out of scope for a desktop app (documented in code).

## Testing
- `scripts/audio-path-policy-test.mjs` (esbuild harness): under-root pass; root-prefix-but-not-child (`/music-evil` vs `/music`) fail; DB-track pass; opened-file pass; podcast-root pass; everything-else fail; win32/darwin case-fold compare; empty roots + null podcastRoot safe.
- `scripts/podcast-host-guard-test.mjs`: each blocked family + allowed public hosts (`example.com`, `8.8.8.8`).
- Smokes: `smoke:playback-start`, `smoke:playback-controls`, `smoke:session`, `smoke:transcode`, `smoke:open-files`, `smoke:podcast`, `smoke:podcast-download`, plus typecheck. CI gains the two new tests.

## Out of scope
- `sandbox: false` on main/detached windows (accepted; preload needs webUtils/MessagePort).
- DNS-rebinding-proof SSRF (overkill for desktop threat model).
