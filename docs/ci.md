# Continuous integration

The scripts in `package.json` fall into tiers by what they need to run. `npm run` lists them. A `smoke:*` script checks one feature end to end and a `test:*` script is a narrower regression test. `npm run test:all` (`scripts/run-all-tests.mjs`) runs every `test:*` script, so a new test is exercised as soon as it is registered.

Three things run them:

- `.github/workflows/ci.yml` runs the CI-safe tier on every push and pull request, and compiles the native audio addon on macOS.
- `.github/workflows/release.yml` runs when a version tag is pushed. A verify job runs the typecheck, the build, `test:all` and a handful of smokes. If it passes, Windows, macOS and Linux are packaged in parallel. The Windows build is signed when the certificate secrets are set. The macOS build is ad-hoc signed, and the notarize step runs only when the Apple secrets are set (it needs a Developer ID certificate, see [macOS signing](macos-signing.md)). A draft GitHub release is created with a `SHA256SUMS.txt`.
- `npm run release:gate:local` (`scripts/release-gate.mjs`) runs the long smoke list, including the tiers CI cannot run, then packages the app and checks the result. The list of smokes is in that file.

## CI-safe (no real display, no audio hardware, no signing tools)

| Step | Command | What it covers |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | Renderer and Electron `tsc --noEmit`, plus the standalone `@eviland/core` package |
| Build | `npm run build` | Vite renderer and Electron main process |
| Native addon | `npm run build:native -- --force` | Compiles `native/newamp-audio` on Linux (ALSA lane) |
| Exclusive output | `npm run smoke:exclusive-output` | Loads the addon, enumerates devices, and pushes PCM through shared mode with exact frame accounting. A runner with no audio device only builds, loads and enumerates |
| Build lock | `npm run smoke:build-lock` | Concurrent-build lock and stale-lock recovery |
| Library | `npm run smoke:library`, `npm run smoke:library-corruption` | SQLite scan and query over fixtures; recovery from a corrupt `library.db` |
| Tags | `npm run smoke:tags` | Living Tags sandbox, regular-expression cost and rule cycles |
| All tests | `npm run test:all` | Every `test:*` script, run under Xvfb |
| Wrapped | `npm run smoke:wrapped` | Wrapped statistics across all five ranges, and the IPC and view wiring |
| Social | `npm run smoke:social` | Reviews, lists and profile: ordering, privacy, persistence, export |
| Visualizer | `npm run smoke:visualizer` | Butterchurn and preset module exports, sandbox wiring |
| Eviland | `test:eviland-audio`, `test:eviland-director`, `test:eviland-memory`, `test:eviland-memory-bridge`, `test:eviland-fluid`, `test:eviland-operators` | Section detection, look rotation, per-track visual lineage, fluid forces, operator channels |
| `@eviland/core` | `npm run test:eviland-core-package` | Builds `packages/eviland-core` with its own `npm run build` (one esbuild ESM bundle plus type declarations) and imports every value `src/index.ts` exports from `dist/index.js` in plain Node, so the package surface cannot drift from the engine modules |
| Look versioning | `npm run test:algo-version-guard` | A change to look generation has to bump `VISUAL_MEMORY_ALGO_VERSION` |
| macOS logic | `test:device-change`, `test:music-folders`, `test:cache-key-casing`, `test:app-menu`, `test:macho-arch` | Platform decisions that need no Mac to test |
| Tables and queries | `test:virtual-rows`, `test:css-color`, `test:library-query`, `test:transcode-peek` | Virtualized row math, colour parsing, library query cost, the first-play decode path |
| Security | `test:audio-path-policy`, `test:podcast-host-guard`, `test:safe-regex`, `test:tag-dsl-hardening`, `smoke:security` | The audio path allowlist, podcast address filtering, the rule-language regex matcher, and the renderer content security policy (no `unsafe-eval`; eval is scoped to the Butterchurn frame) |
| Capture | `npm run smoke:viz-capture` | Visualizer PNG and clip capture is wired from main to preload to the UI |
| Release hygiene | `smoke:build-provenance`, `smoke:release-secrets`, `smoke:reliability` | The shape of `BUILD-PROVENANCE.json`, no secrets in release artifacts, database corruption backup and recovery |

## Display-required

These open an Electron window with a GPU context, so they need an X11, Wayland or macOS display. They run in the local release gate or on any machine with a display; the macOS leg of the release workflow runs `smoke:mac-launch`, but a failure there does not block the release. Examples: every `smoke:ui-*`, `smoke:startup`, `smoke:playback`, `smoke:ui-visualizer`, `smoke:mac-launch`, `smoke:butterchurn-sandbox` (loads `butterchurn-iframe.html` under its real content security policy and checks that the frame reports it mounted), and `smoke:particle-flow` (renders the WebGL2 particle engine in a real GL2 context and checks that frames are not blank and react to audio).

`smoke:community-ui` runs the Jellyfin, Subsonic and history-import flows through the real app. It needs Python with Playwright installed, uses isolated profiles and local protocol fixtures for both servers, and checks history reimport, playback, seeking, visualizer input and exact byte ranges. The node-only `test:music-servers` and `test:history-import` cover the same code without a window.

## Audio hardware or a person at the machine

The release checks in this section and the next are run by the maintainer before tagging. Contributors do not need them.

These need a real output device or someone to confirm something, and never run in CI: `smoke:audio-output`, `smoke:audio-hardware`, `smoke:audio-proof`, `smoke:manual-listening-proof`, `smoke:lastfm-live-proof`.

`smoke:exclusive-ui` boots the app with Bit-Perfect Exclusive enabled and takes over the default device for about three quiet seconds. It checks that the native path engaged without falling back, that the clock advances from the native frame counter, and that the analysers carry energy while the Web Audio graph is silent, which can only happen through the 30 Hz tap on the native output that keeps the visualizers running. It does nothing outside Windows and Linux. The exclusive-mode pass of `smoke:exclusive-output` (opening the device exclusively at its native format) runs only with `NEWAMP_EXCLUSIVE_SMOKE_HW=1`.

Two release checks record the maintainer's confirmation, and the release gate reads the records:

```bash
npm run release:start-lastfm-proof
npm run release:record-lastfm-proof -- --token=<token> --confirm-live-write
npm run release:start-listening-proof
npm run release:record-listening-proof -- --confirm-playback --confirm-output-switching --confirm-crossfade --confirm-gapless
```

`release:start-lastfm-proof` and `release:record-lastfm-proof` scrobble one test track to the maintainer's own Last.fm account and record the result. `release:start-listening-proof` and `release:record-listening-proof` record that playback, output switching, crossfade and gapless were checked by ear. `npm run release:gate:local` runs the rest of the gate.

## Platform signing

Windows `signtool` and a built Windows installer: `smoke:signing-readiness` and `smoke:signing-workflow`. The Windows leg of `release.yml` signs when the certificate secrets are set. [macOS signing](macos-signing.md) covers the Apple side.
