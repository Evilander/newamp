# Security Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 403 any `newamp:` request outside the legitimate-playback allowlist (library roots ∪ library DB ∪ session opened files ∪ podcast downloads), close the symlink TOCTOU by serving the validated realpath, and block podcast fetches to private/loopback hosts.

**Architecture:** Pure decision modules (`electron/audio-path-policy.ts`, `isBlockedPodcastHost` in `podcasts.ts`) with esbuild Node tests; `main.ts` wires the policy into the `newamp:` handler before any ffmpeg/cache work and maintains the opened-files set at all four open-file entry points. Spec has the complete shape: `docs/superpowers/specs/2026-06-09-security-pass-design.md`.

**Tech Stack:** TypeScript, esbuild test harnesses, existing playback/podcast smokes.

Branch `security-pass` (created; spec committed).

---

## Task 1 (S1): audio-path policy + handler wiring
**Files:** Create `electron/audio-path-policy.ts`, `scripts/audio-path-policy-test.mjs`; Modify `electron/main.ts`, `package.json`.
- [ ] Test first (esbuild harness on `electron/audio-path-policy.ts`): under-root pass / `…-evil` sibling fail / DB-track pass / opened-file pass / podcast-root pass / otherwise fail / win32+darwin case-fold / empty-roots+null-podcast safe → RED (module missing).
- [ ] Implement `isAllowedAudioPath` per the spec interface (separator-safe `root + sep` prefix or exact-equality; case-fold via `caseFoldCachePath` from `./cache-key-casing.js` on win32/darwin) → GREEN.
- [ ] Wire `main.ts`: module-level `const openedAudioFiles = new Set<string>();` + an `allowOpenedAudioFile(path)` helper (realpath, add; swallow errors) called from `enqueueOpenFiles` (:892), `openFiles` (:3692), and the initial `collectOpenFileArgs(process.argv)` paths; cache the realpathed podcast root (`join(app.getPath('userData'), 'podcast-downloads')`) lazily. In the `newamp:` handler after `existsSync`: realpath → 404 on failure; probe `library.getTracksByPaths([filePath, real])` (guard `library` not yet open → treat as false); realpath each `settings.get().libraryRoots` entry (per-request, few entries, swallow failures); `if (!isAllowedAudioPath(...)) return 403 with X-Newamp-Reason: path-not-allowed`. Then use `real` (not `filePath`) for `playbackMode`, `peekCachedFlac`, `getOrTranscodeToFlac`, `transcodeToWavResponse`, and the native-branch `net.fetch`.
- [ ] READ each Electron playback smoke app (`scripts/playback-smoke-app`, `playback-seek-app`, and `smoke:open-files`/`session` flows) to confirm fixtures are authorized (library scan / open:files); fix the SMOKE (not the handler) if one plays a bare unauthorized path; `smokeMode` gate only as a documented last resort.
- [ ] Gate: typecheck; new test PASS; `smoke:playback-start`, `smoke:playback-controls`, `smoke:session`, `smoke:transcode`, `smoke:open-files`, `smoke:cue` PASS. `package.json`: `"test:audio-path-policy"`. Commit.

## Task 2 (S2): podcast private-host guard
**Files:** Modify `electron/podcasts.ts`; Create `scripts/podcast-host-guard-test.mjs`; Modify `package.json`.
- [ ] Test first: blocked — `localhost`, `foo.localhost`, `printer.local`, `127.0.0.1`, `10.1.2.3`, `172.16.0.1`/`172.31.255.255` (and NOT `172.32.0.1`), `192.168.1.1`, `169.254.169.254`, `0.0.0.0`, `::1`, `fc00::1`, `fe80::1`; allowed — `example.com`, `8.8.8.8`, `feeds.megaphone.fm` → RED.
- [ ] Implement exported `isBlockedPodcastHost(hostname)` (strip brackets for IPv6; numeric IPv4 octet parse, no regex-only matching for ranges); call it inside `normalizeFeedUrl` and `normalizeMaybeUrl` next to the existing scheme check, rejecting through the same path → GREEN.
- [ ] Gate: typecheck; `smoke:podcast`, `smoke:podcast-download` PASS. `package.json`: `"test:podcast-host-guard"`. Commit.

## Task 3: CI + merge gate
- [ ] ci.yml: add both tests after the transcode-peek step. Full gate (typecheck + the 2 new tests + the smokes above + `smoke:visualizer`, `smoke:library`). Commit; final review; merge to main; push.

## Self-Review Notes
Spec coverage: S1→T1, S2→T2, CI→T3. Names: `isAllowedAudioPath`/`AudioPathPolicyInput`/`openedAudioFiles`/`allowOpenedAudioFile`/`isBlockedPodcastHost` consistent. Honesty: policy + host guard pure-tested; handler wiring verified by the playback/open-files/podcast smokes (403 path additionally exercised by the policy unit tests at the decision layer).
