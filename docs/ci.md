# Continuous Integration

NewAmp has ~120 smoke scripts. They split into tiers by what they need to run.
CI (`.github/workflows/ci.yml`) runs only the **CI-safe** tier on every push/PR;
the rest run in the release workflow's per-OS legs or in the local release gate
(`npm run release:gate:local`).

## CI-safe (pure-node, no display, no audio hardware, no signing tools)

Run on every push/PR in `ci.yml`:

| Step | Command | What it locks down |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | renderer + electron `tsc --noEmit`, plus the standalone `@eviland/core` package's own (stricter) `tsc --noEmit` |
| Build | `npm run build` | vite renderer + electron main compile |
| Build lock | `npm run smoke:build-lock` | concurrent-build lock + stale-lock recovery |
| Library | `npm run smoke:library` | SQLite scan + query over fixtures |
| All unit tests | `npm run test:all` | every `test:*` script in package.json, run through `scripts/run-all-tests.mjs` so a new test is exercised the moment it is registered |
| Wrapped | `npm run smoke:wrapped` | Wrapped stats math across all 5 ranges + IPC/view wiring |
| Social | `npm run smoke:social` | reviews/lists/profile CRUD, ordering, privacy, reopen persistence, export bundle |
| Visualizer | `npm run smoke:visualizer` | butterchurn/presets module exports + sandbox wiring |
| Security (CSP) | `npm run smoke:security` | main renderer has no `unsafe-eval`; eval scoped to the Butterchurn iframe |
| Capture wiring | `npm run smoke:viz-capture` | visualizer PNG/clip capture IPC wired main→preload→api + UI controls |
| Provenance | `npm run smoke:build-provenance` | `BUILD-PROVENANCE.json` shape |
| Release secrets | `npm run smoke:release-secrets` | no secrets leak into release artifacts |
| Reliability | `npm run smoke:reliability` | DB corruption backup + recovery |
| Completion audit | `npm run smoke:completion-audit` | release-readiness audit (reports blockers, exits 0) |
| `@eviland/core` package | `npm run test:eviland-core-package` | builds `packages/eviland-core` for real (declaration emit) and imports every value `src/index.ts` exports from the built `dist/index.js`, so the package's hand-maintained public surface can't drift from what the mirrored engine modules actually export |

## Display-required (need an X11/Wayland/macOS display + WebGL)

Spawn Electron with a window. Run on `macos-latest`/`ubuntu-latest` runners with a
virtual display, or locally. Examples: every `smoke:ui-*`, `smoke:startup`,
`smoke:playback`, `smoke:tabs`, `smoke:ui-visualizer`, `smoke:mac-launch`,
`smoke:butterchurn-sandbox` (loads butterchurn-iframe.html under its real CSP and
asserts the frame reports `mounted` — the deterministic, audio-free proof that the
Butterchurn sandbox works), and `smoke:particle-flow` (esbuild-bundles the WebGL2
particle engine, renders it to a real GL2 context, and asserts non-blank +
audio-reactive frames).

## Audio-hardware / human-in-the-loop

Need a real output device or manual confirmation; **never** CI:
`smoke:audio-proof`, `smoke:audio-output`, `smoke:audio-hardware`,
`smoke:manual-listening-proof`, `smoke:lastfm-live-proof`.

`smoke:exclusive-output` is the exception that proves the rule: its base pass
(device enum + probe + shared-mode push with exact frame accounting) needs a
playback device but no human, so it runs in the local release gate; it no-ops
cleanly on non-Windows. The full WASAPI-exclusive hardware pass (takes over
the DAC, asserts requested == internal format) stays manual behind
`NEWAMP_EXCLUSIVE_SMOKE_HW=1`.

`smoke:exclusive-ui` (also gate-run, never CI, no-op off-Windows) boots the
real app with `bitPerfectExclusive` pre-enabled and takes over the default
device for ~3 quiet seconds: asserts the native path engaged (no silent
fallback), the clock advances from the native frame counter, and the
analysers carry energy while the Web Audio graph is silent — which can only
come from the 30Hz native PCM tap that keeps visualizers alive.

## Platform-signing-required

Windows-only tooling (`signtool`) / a built Windows installer:
`smoke:signing-readiness`, `smoke:signing-workflow`. These run in the Windows leg
of `release.yml` when signing secrets are configured.

## History: `smoke:security` was red from 1.5.2 until the CSP iframe sandbox

`smoke:security` asserts the renderer CSP `script-src` does **not** include
`'unsafe-eval'`. Commit `1e5228b` (1.5.2's "real Milkdrop fix") added
`'unsafe-eval'` to `index.html` so Butterchurn could compile MilkDrop preset math,
*after* the smoke was written. The smoke was never updated, so `smoke:security`
— and therefore the strict `npm run release:gate` — was red from 1.5.2 through
1.5.7; those releases shipped via the `:local` gate variants.

This is now **fixed**: Butterchurn runs in a sandboxed `butterchurn-iframe.html`
that scopes `'unsafe-eval'` to just that frame, and the main renderer is back on
`script-src 'self'`. `smoke:security` verifies both halves and is part of the
CI-safe set above.
