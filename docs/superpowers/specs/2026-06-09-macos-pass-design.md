# macOS Pass — Design

**Date:** 2026-06-09
**Status:** Approved (design), pending implementation plan
**Goal:** Make NewAmp feel and behave correctly on macOS — fix the audio/UX bugs that bite Mac users, give it native window chrome + menu + lifecycle, and correct the build/signing issues that make the shipped DMG unusable.

All changes are **platform-gated**: zero behavior change on Windows/Linux. The renderer already exposes `api.platform` (from preload `readAppInfo` → `process.platform`); main-process code uses `process.platform`.

The work is grouped into three tiers with different verifiability. The implementation plan will keep these as independently-reviewable groups.

---

## Tier A — Safe logic fixes (fully testable in Node)

### A1. CoreAudio device-change re-routing — `src/audio/engine.ts`
**Problem:** The engine has `applyOutputDevice`/`outputDeviceId`/`sampleRateFallback` (engine.ts ~90, ~634, ~639) but registers no `devicechange` listener. `SettingsView.tsx:69` listens to `mediaDevices.devicechange` only to refresh its device dropdown — it never re-applies the sink. On macOS, unplugging headphones / switching the default output (very common) leaves the engine pinned to a now-absent `outputDeviceId`, so playback can go silent until the user manually re-selects.

**Change:** In the engine, subscribe (guarded) to `navigator.mediaDevices` `devicechange`. Handler (all in try/catch, never throws into the audio path):
- `await navigator.mediaDevices.enumerateDevices()`.
- If `outputDeviceId` is set and no longer present among `audiooutput` devices → reset to the system default (`outputDeviceId = null`), call `applyOutputDevice(null)`, and record a `deviceFallback: { requestedId, reason: 'device-removed' }` exposed via a new `getDeviceFallback()` getter (mirroring the existing `getSampleRateFallback()` shape at engine.ts:903) so Settings can surface "output device changed".
- If still present → re-assert `applyOutputDevice(outputDeviceId)` so audio follows the device.
- Listener registered when the graph is ensured; removed in `dispose()` (store the bound handler ref).

**Note:** load-bearing audio file — keep the change minimal, additive, and fully guarded. Do not alter the audible chain.

### A2. Mac-aware music-folder suggestions + first-run seed — `electron/music-folders.ts`, `electron/main.ts:3808`
**Problem:** `music-folders.ts` suggests `K:/music`, OneDrive paths, and labels `~/Music` as `"Windows Music"`. `main.ts:3808` first-run auto-seed candidates are all Windows drive paths, so on macOS the seed loop matches nothing useful.

**Change:** Branch on `process.platform`.
- `music-folders.ts`: on darwin, suggest `~/Music`, `~/Music/Music/Media` (Apple Music), `~/Music/iTunes/iTunes Media`, and enumerate `/Volumes/*` (skip the boot volume) suggesting external drives that exist. Fix the `"Windows Music"` label to a platform-neutral `"Music"`. Keep the Windows branch unchanged.
- `main.ts:3808`: on darwin, candidates = `[app.getPath('music')]` plus any existing `/Volumes/*/Music`. Keep Windows candidates on win32.

### A3. Case-fold transcode cache key on APFS — `electron/transcode-cache.ts:271`
**Problem:** `canonicalKey` lowercases the canonical path only on `win32`; macOS default APFS is case-insensitive, so `/Music/Song.flac` and `/music/song.flac` produce two cache entries (duplicate transcodes). `realpath()` (line 266) mitigates for existing files but not all paths.

**Change:** `if (process.platform === 'win32' || process.platform === 'darwin') canon = canon.toLowerCase();`

---

## Tier B — Native look & feel (verified by running the app on macOS)

### B1. Native traffic lights — `electron/main.ts:404-423`, `src/components/TitleBar.tsx`
**Problem:** The main window uses `frame:false` + `titleBarStyle:'hidden'` + `transparent:true` with no `trafficLightPosition`. On macOS `frame:false` suppresses the traffic lights entirely, so Mac users get no native close/minimize/zoom and instead see Windows-style `_`/`MAX`/`X` buttons on the wrong side, with the logo where the dots belong. `transparent:true` also costs GPU for an opaque UI.

**Change:**
- `main.ts` createWindow: build window options platform-aware. On **darwin**: omit `frame:false` and `transparent:true`; set `titleBarStyle:'hidden'`, `trafficLightPosition:{ x: 14, y: 13 }`, and an opaque `backgroundColor` (the app's dark base, e.g. `#0b0b10`). On **win32/linux**: keep the current `frame:false` + `titleBarStyle:'hidden'` + `transparent:true` exactly.
- `TitleBar.tsx`: read `const isMac = api.platform === 'darwin'`. When `isMac`: do not render the `_` / `MAX`/`RST` / `X` buttons (the native traffic lights own minimize/zoom/close); keep `PIN` and `DECK` (app features, not window controls); add ~72px left padding to the header's left cluster so `BrandLogo` + `NEWAMP` clear the traffic lights. The `titlebar-drag` region stays.

### B2. Native application menu — `electron/main.ts`
**Problem:** No `Menu.setApplicationMenu` for an app menu exists (only the tray context menu at main.ts:900). Mac falls back to a bare default; standard shortcuts (Cmd-Q/W/M, clipboard Cmd-C/V/X/A/Z in inputs) may not work, and there's no proper app menu / About.

**Change:** On **darwin**, build `Menu.buildFromTemplate([...])` with a leading `{ role: 'appMenu' }`, then `{ role: 'editMenu' }`, `{ role: 'viewMenu' }`, `{ role: 'windowMenu' }`, and call `Menu.setApplicationMenu(menu)`. Call `app.setAboutPanelOptions({ applicationName, applicationVersion, ... })`. On **win32/linux**, keep current behavior (`autoHideMenuBar` + custom titlebar) — set the application menu to `null` only if needed to preserve today's look; otherwise leave untouched.

### B3. Native Dock lifecycle — `electron/main.ts:891`, `:451`, `:3951`
**Decision:** Native Dock model (no auto menu-bar icon on macOS).
**Change:** `registerTray()` returns early when `process.platform === 'darwin'` (no tray on mac). With `tray` null, the existing close handler (`main.ts:451-465`) hits `if (!tray || tray.isDestroyed()) return;` and the window closes normally; `window-all-closed` (`:3951`) already keeps the app alive on darwin; the existing `activate` handler (`:3958`) reopens from the Dock; Cmd-Q (via B2's appMenu) quits (sets `isQuitting` in `before-quit`). The `closeButtonBehavior` setting becomes a no-op on mac (no tray to hide to) — acceptable; leave the setting as-is.

---

## Tier C — Build & signing P1s (config + scripts; correct-by-reasoning, NOT verifiable in this environment)

These require a real `package:mac` run (and an Apple Developer ID cert for C2) to fully verify. The user has no signing set up yet, so C2 is written correctly and documented but cannot be exercised. C1's build orchestration needs a real packaging run; only its arch-detection helper is unit-testable here.

### C1. ffmpeg cross-arch — `scripts/package.mjs`, new `scripts/stage-ffmpeg-for-arch.mjs`, new `scripts/afterpack-verify-ffmpeg-arch.mjs`, `package.json` (`build.afterPack`)
**Problem:** `package.mjs --mac` runs a single `electron-builder --mac` that builds **both** arm64 and x64 (per `build.mac.target` arch list) on one runner (`macos-latest` = arm64). `ffmpeg-static` installs only the host-arch binary, so the cross-arch DMG embeds a wrong-arch ffmpeg. `resolveFfmpegPath()` (transcode.ts:326, dna-analyzer.ts:73) then falls through to bare `'ffmpeg'` (not on a normal Mac PATH) → spawn ENOENT → the `newamp://` handler returns 503; all transcoded formats (ALAC/AIFF/APE/WMA/DSD/WV) fail to play/scrub on that arch. `smoke:mac-launch` only checks `did-finish-load`, so it's untested.

**Change:**
- New `scripts/stage-ffmpeg-for-arch.mjs <arch>`: ensures `node_modules/ffmpeg-static/ffmpeg` is the `<arch>` darwin binary by invoking ffmpeg-static's installer with `npm_config_platform=darwin npm_config_arch=<arch>` (its install script honors these — pure download, no cross-arch execution). After staging, verify the resulting binary's Mach-O arch via the shared `detectMachOArch()` helper.
- `scripts/package.mjs`: change `electronBuilderTargetArgs` for `--mac` to build **per-arch** — return `[['--mac','--arm64'], ['--mac','--x64']]` — and before each invocation run `stage-ffmpeg-for-arch.mjs <arch>` for that arch. (Only affects the mac path; Windows/Linux paths unchanged.)
- New `scripts/afterpack-verify-ffmpeg-arch.mjs` wired via `package.json` `build.afterPack`: on macOS targets, locate the unpacked ffmpeg under `app.asar.unpacked/node_modules/ffmpeg-static/`, run `detectMachOArch()`, and **throw** (fail the build) if it ≠ `context.arch`. This guarantees a wrong-arch binary can never ship silently.
- New shared helper module (e.g. `scripts/lib/macho-arch.mjs`) exporting `detectMachOArch(path) → 'arm64' | 'x64' | 'universal' | 'unknown'` by reading the Mach-O magic + `cputype` (and fat-binary magic). **Unit-testable here** against the installed host ffmpeg-static binary.
- Extend `scripts/packaged-mac-launch-smoke.mjs` (or add `smoke:mac-ffmpeg`) to spawn the bundled ffmpeg `-version` and assert exit 0 — proves the host-arch DMG's ffmpeg runs. (Cross-arch exec can't be tested on a single runner; the afterPack arch-guard covers that case.)

### C2. Code-sign + notarize preflight — new `scripts/verify-mac-signing.mjs`, `scripts/notarize-artifacts.mjs`, `docs/macos-signing.md`
**Problem:** `build.mac` has `hardenedRuntime: true` + entitlements (correct), but `scripts/sign-artifacts.mjs` is Windows-only and no mac `identity` is pinned. If `package:mac` runs without a Developer ID identity (CSC env / keychain), electron-builder produces an ad-hoc-signed `.app`; Apple's notary service then rejects it, and end users get the "NewAmp is damaged / cannot verify developer" Gatekeeper block. Nothing guarantees the `.app` was Developer-ID-signed before notarize.

**Change:**
- New `scripts/verify-mac-signing.mjs`: runs `codesign --verify --deep --strict --verbose=2 <app>` and `spctl -a -vvv -t install <app>`; **exits non-zero** if the app is not Developer-ID-signed/accepted. Skips cleanly (exit 0 with a notice) when no packaged `.app` exists or on non-darwin, matching the env-gating pattern of the existing release scripts.
- `scripts/notarize-artifacts.mjs`: run `verify-mac-signing.mjs` as a hard preflight before submitting to `notarytool`, so an unsignable artifact is never submitted.
- `docs/macos-signing.md`: document the required env vars to actually sign + notarize — `CSC_LINK` + `CSC_KEY_PASSWORD` (Developer ID Application `.p12`), `NEWAMP_APPLE_ID` + `NEWAMP_APPLE_PASSWORD` (app-specific password) + team id — and how to obtain a Developer ID cert. Note that until these are set, builds are ad-hoc-signed and the preflight will (correctly) block notarization.
- Optionally extend `smoke:signing-readiness` to assert the mac preflight wiring exists.

---

## Testing

- **Tier A (Node, in CI):**
  - A1: a device-change unit test that constructs the engine with a mocked `navigator.mediaDevices` (enumerate + dispatch `devicechange`), asserts that a removed selected device triggers fallback-to-default + a recorded `deviceFallback`, and that a still-present device re-applies the sink. (esbuild-harness style, mirroring `eviland-*-test.mjs`.)
  - A2: a `music-folders` unit test mocking `process.platform='darwin'`, `homedir()`, and a fake `/Volumes` listing; asserts darwin suggestions + corrected label.
  - A3: a `canonicalKey`/cache-key test asserting darwin lowercases the key.
- **Tier B:**
  - B2: a unit test that the menu template built on darwin includes the `appMenu`/`editMenu`/`viewMenu`/`windowMenu` roles (extract menu-template construction into a pure, testable function).
  - B1/B3: confirmed by running `npm run dev` / a packaged build on macOS (traffic lights present & positioned, custom buttons hidden, close keeps app in Dock, Cmd-Q quits).
- **Tier C:**
  - C1: unit-test `detectMachOArch()` against the installed host ffmpeg-static binary (asserts it returns the host arch) and against crafted 4-byte Mach-O/fat magics. The per-arch build + afterPack guard require a real `npm run package:mac` on macOS to confirm.
  - C2: the preflight script's skip-paths are testable; full signing/notarization requires a Developer ID cert (documented, deferred).
- **Gate (every tier):** `npm run typecheck`, the new Node tests, existing `smoke:visualizer`/CI smokes still green.

## Out of scope (follow-ups)
- The remaining performance + audio-correctness + security items from the 2026-06-09 audit (NowPlayingView memoization, `getTracksByIdsInOrder` N+1, `loadedmetadata` seek guard, `newamp:` path allowlist).
- Global media-key permission documentation (P3-2), Dock menu/badge (P3-3).
- macOS universal (single fat) binary — current design ships separate arm64 + x64 artifacts, which is fine.
