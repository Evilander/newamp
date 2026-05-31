# @eviland/core — extraction status

## Done

- **Self-contained, buildable, publishable package.** `packages/eviland-core/`
  with `package.json` (exports + types), `tsconfig.json`, `README.md`, a clean
  public `src/index.ts`, and all seven zero-dependency engine modules
  (renderer, reactor, operators, randomizer, rng, director, recorder).
- **Builds in isolation:** `cd packages/eviland-core && npm run build` →
  `dist/` with `.js` + `.d.ts` + sourcemaps, **0 errors**.
- **Public API boundary defined** in `src/index.ts` (see README for the surface).
- NewAmp's own typecheck is unaffected (root tsconfig includes only
  `src`/`shared`/`electron`, not `packages`).

## Staging model (current)

During extraction, **`src/visualizer/eviland*.ts` is the source of truth** and the
package's `src/` is a synced copy (`node packages/eviland-core/sync.mjs`). This
keeps NewAmp working untouched while the package proves out as a standalone,
publishable boundary. After editing any engine module, run the sync script so the
package doesn't drift.

## Final consolidation (tracked follow-up — intentionally NOT done yet)

To make the package the single source of truth without risk to NewAmp's mature
build/release pipeline:

1. Add `"private": true` + `"workspaces": ["packages/*"]` to the root
   `package.json`, then `npm install` to link `@eviland/core`. (Deferred because
   it can perturb the existing electron-builder + postinstall flow; do it in a
   dedicated, separately-verified change.)
2. Replace `src/visualizer/eviland*.ts` with re-exports from `@eviland/core`
   (or delete them and rewrite imports in `Visualizer.tsx` /
   `FullscreenVisualizer.tsx` / the smoke scripts).
3. Delete `sync.mjs` once there's one source of truth.
4. Publish `@eviland/core` to npm.

## studio/ note

The repo-root `studio/` dir is an existing **player-skin design** workspace
(`designs.db` + saved HTML) — unrelated to Eviland. The standalone "Eviland
Studio" VJ app should live in a fresh top-level dir (e.g. `eviland-studio/`),
not by reusing `studio/`.
