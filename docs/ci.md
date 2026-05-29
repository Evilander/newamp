# Continuous Integration

NewAmp has ~120 smoke scripts. They split into tiers by what they need to run.
CI (`.github/workflows/ci.yml`) runs only the **CI-safe** tier on every push/PR;
the rest run in the release workflow's per-OS legs or in the local release gate
(`npm run release:gate:local`).

## CI-safe (pure-node, no display, no audio hardware, no signing tools)

Run on every push/PR in `ci.yml`:

| Step | Command | What it locks down |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | renderer + electron `tsc --noEmit` |
| Build | `npm run build` | vite renderer + electron main compile |
| Build lock | `npm run smoke:build-lock` | concurrent-build lock + stale-lock recovery |
| Library | `npm run smoke:library` | SQLite scan + query over fixtures |
| Wrapped | `npm run smoke:wrapped` | Wrapped stats math across all 5 ranges + IPC/view wiring |
| Social | `npm run smoke:social` | reviews/lists/profile CRUD, ordering, privacy, reopen persistence, export bundle |
| Visualizer | `npm run smoke:visualizer` | butterchurn/presets module exports + sandbox wiring |
| Security (CSP) | `npm run smoke:security` | main renderer has no `unsafe-eval`; eval scoped to the Butterchurn iframe |
| Capture wiring | `npm run smoke:viz-capture` | visualizer PNG/clip capture IPC wired main→preload→api + UI controls |
| Provenance | `npm run smoke:build-provenance` | `BUILD-PROVENANCE.json` shape |
| Release secrets | `npm run smoke:release-secrets` | no secrets leak into release artifacts |
| Reliability | `npm run smoke:reliability` | DB corruption backup + recovery |
| Completion audit | `npm run smoke:completion-audit` | release-readiness audit (reports blockers, exits 0) |

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
CI-safe set above. See `docs/butterchurn-csp-iframe-plan.md` for the original plan.
