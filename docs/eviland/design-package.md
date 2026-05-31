# Eviland — `@eviland/core` Extraction & Studio App Design

> Phase 5 design. Read `map-integration.md` first — every line/anchor cited here is verbatim from that map and the current tree (NewAmp `5961e0d`+, viz files dated 2026-05-30). All paths absolute or repo-relative from `B:\projects\claude\newamp`.

## 0. Goals (and what we explicitly will NOT do)

**Goals**
1. Ship `@eviland/core` as a **zero-dep, framework-agnostic, ES-modules-only** library that any web/Electron/Tauri app can embed the way `butterchurn` is embedded today. The current renderer + reactor + RNG already meet that constraint — they have zero NewAmp imports — so the extraction is a *move + rename*, not a rewrite.
2. Reconcile the existing orphan `studio/` directory (design HTML files + 45 KB `designs.db`) without destroying it, and create a real **Eviland Studio** workspace under `apps/eviland-studio/`.
3. Adopt **npm workspaces** so NewAmp consumes `@eviland/core` via a workspace symlink (zero publish churn during dev) and tsc/vite resolve the package without a build step in the loop.
4. NewAmp `npm run build` + `npm run smoke:eviland` + `scripts/eviland-capture.mjs` MUST keep passing after every staged step — Eviland is the flagship visualizer and the default since 1.7.1.

**Non-goals (for this phase)**
- No publish to npm registry yet. Workspace-only. (A separate Phase 5b can wire `npm publish --workspace @eviland/core` once the API is locked.)
- No React in the core. The React driver stays in NewAmp (`Visualizer.tsx`); core exposes only a vanilla factory that takes an `HTMLCanvasElement` + an `AnalyserNode`-or-Float32Array-style frame source.
- No renaming of the existing public API. `createEvilandRenderer`, `createEvilandReactor`, `EvilandFrame`, `EvilandPalette`, `EvilandOptions`, `EvilandReactor`, `EvilandReactorConfig`, `EvilandOnset`, `VoiceGroup`, `EVILAND_BANDS`, `Rng`, `mulberry32`, `hashSeed`, `toSeedState`, `encodeSeedCode`, `decodeSeedCode` keep their current names so the diff in `Visualizer.tsx` is *only* the import path.
- No move of the smoke scripts (`scripts/eviland-smoke.mjs`, `scripts/eviland-capture.mjs`) into the package on first pass — they esbuild-bundle the source, and the bundling path is the most fragile thing to refactor. Phase 5a points them at the new path; Phase 5b duplicates them inside the package as the canonical tests once the API freezes.

## 1. Why the extraction is safe (the evidence audit)

Before designing the move, the audit:

| Question | Answer | Source |
|----------|--------|--------|
| Does `eviland.ts` import anything from NewAmp? | **No.** Only `import type { EvilandFrame } from './eviland-audio'`. | `src/visualizer/eviland.ts:35` |
| Does `eviland-audio.ts` import anything? | **No imports at all.** Pure TS. | `src/visualizer/eviland-audio.ts` (1–429) |
| Does `eviland-rng.ts` import anything? | **No imports at all.** Pure TS. | `src/visualizer/eviland-rng.ts` (1–141) |
| Who consumes the renderer? | `src/components/Visualizer.tsx:13–14` (only) — and the two smoke scripts. | grep `createEvilandRenderer\|createEvilandReactor` returns 5 hits across 4 files. |
| What runtime deps does the renderer need? | WebGL2 + `EXT_color_buffer_float`. No Node. No DOM beyond `HTMLCanvasElement`. | `eviland.ts:590–598`. |
| What runtime deps does the reactor need? | `Uint8Array` × 4 + numbers. No DOM, no Node. | `eviland-audio.ts:100–109`. |
| Is `studio/` referenced by any source code? | **No.** grep `studio/designs` matches only `docs/eviland/map-integration.md`. The HTML files there are orphans from an old skin-design experiment. | grep across full tree. |
| Are `packages/` and `studio/` already on disk? | Yes — `packages/` is **empty** (clean slot). `studio/` has 2 design HTMLs + `designs.db` + 3 empty dirs (`exports/`, `renders/`, `tmp-render/`). | `ls` of both. |

**Conclusion**: the renderer + reactor + RNG are already a clean package boundary disguised as `src/visualizer/*.ts`. The extraction is mechanical.

## 2. Workspace layout (target)

After the migration, the repo looks like:

```
B:\projects\claude\newamp\
├── package.json                     # adds "workspaces": ["packages/*", "apps/*"]
├── package-lock.json                # unified
├── tsconfig.json                    # adds path alias for "@eviland/core"
├── vite.config.ts                   # adds resolve alias matching tsconfig (dev HMR)
├── src/                             # NewAmp app source (unchanged structure)
│   ├── components/
│   │   ├── Visualizer.tsx           # imports rewritten: '@eviland/core'
│   │   └── FullscreenVisualizer.tsx # unchanged
│   ├── audio/engine.ts              # unchanged
│   └── visualizer/
│       └── particle-flow.ts         # STAYS (NewAmp-specific viz, not Eviland)
│       # eviland.ts, eviland-audio.ts, eviland-rng.ts: MOVED OUT
├── electron/                        # unchanged
├── shared/                          # unchanged
├── scripts/
│   ├── eviland-smoke.mjs            # bundle paths updated to packages/eviland-core/src/*
│   └── eviland-capture.mjs          # bundle paths updated likewise
├── packages/
│   └── eviland-core/
│       ├── package.json             # name: "@eviland/core", version: "0.1.0", type: module
│       ├── tsconfig.json            # extends root, composite: true, outDir: dist
│       ├── tsup.config.ts           # ESM-only lib build (esbuild under the hood)
│       ├── README.md                # public-facing API doc
│       ├── CHANGELOG.md             # tracks API changes independent of NewAmp
│       ├── LICENSE                  # MIT — mirrors repo root
│       ├── .npmignore               # excludes src/, tests/, tsup config
│       ├── src/
│       │   ├── index.ts             # the public surface — re-exports everything
│       │   ├── renderer.ts          # was src/visualizer/eviland.ts
│       │   ├── reactor.ts           # was src/visualizer/eviland-audio.ts
│       │   ├── rng.ts               # was src/visualizer/eviland-rng.ts
│       │   ├── adapter-analyser.ts  # NEW (Phase 5a) — wraps an AnalyserNode → frame source
│       │   └── types.ts             # NEW (Phase 5a) — re-exports types in one place for docs
│       ├── dist/                    # gitignored; built by tsup
│       │   ├── index.js             # ESM
│       │   ├── index.d.ts
│       │   ├── index.js.map
│       │   └── (renderer/reactor/rng chunks if tsup splits)
│       └── tests/
│           ├── reactor.smoke.mjs    # Phase 5b — copy of scripts/eviland-smoke.mjs logic
│           └── renderer.capture.mjs # Phase 5b — copy of scripts/eviland-capture.mjs logic
└── apps/
    └── eviland-studio/              # NEW — the standalone VJ/Studio app
        ├── package.json             # private:true, depends on "@eviland/core": "workspace:*"
        ├── tsconfig.json
        ├── vite.config.ts
        ├── index.html
        ├── electron/                # Phase 5c — wraps the Vite build in an Electron shell
        │   ├── main.ts
        │   └── preload.ts
        ├── src/
        │   ├── main.ts              # Vite entry — mounts the Studio UI
        │   ├── studio/              # the Studio app code (panels, transport, recorder, etc.)
        │   └── lib/                 # adapters: mic input, file player, recorder, preset I/O
        ├── public/
        └── README.md

# Untouched legacy:
└── studio/                          # the old design-experiment dir — RENAMED to:
    studio-legacy/                   # (atomic git mv; no code reads from it)
        ├── designs.db
        ├── designs/{4e8a22f1d85a,7851e0c3bd7c}.html
        └── exports/, renders/, tmp-render/  (all empty)
```

### Why this shape

- **`packages/eviland-core/`** matches the standard npm-workspaces convention. Future siblings (`packages/eviland-presets`, `packages/eviland-director`) drop in without restructuring.
- **`apps/eviland-studio/`** is parallel to `packages/`. Following the same convention as `apps/web` + `packages/shared` from the parent `B:\projects\CLAUDE.md` (the LLM Book Club layout), so the monorepo idiom is consistent across Tyler's projects.
- **NewAmp is NOT moved into `apps/newamp/`** in this phase. Moving the Electron-builder + 150 smoke scripts is high risk for zero gain. NewAmp stays at the repo root; `package.json` simply gains a `workspaces` field that points to `packages/*` and `apps/*`. NewAmp itself is *not* a workspace member (the root `package.json` is the NewAmp manifest), so its existing build/release/installer pipeline is untouched.
- **`studio/` → `studio-legacy/`** with a git rename: zero data loss, clear semantic — the name "studio" now belongs to `apps/eviland-studio`. (Verified: zero source-code references to `studio/`. The map-integration.md mention is documentation.)

## 3. `packages/eviland-core/package.json` (exact contents)

```json
{
  "name": "@eviland/core",
  "version": "0.1.0",
  "description": "Instrument-aware, causal, zero-dep generative WebGL2 visual engine. The library behind NewAmp's Eviland visualizer.",
  "type": "module",
  "license": "MIT",
  "author": "evilander",
  "homepage": "https://github.com/evilander/newamp/tree/main/packages/eviland-core",
  "repository": {
    "type": "git",
    "url": "https://github.com/evilander/newamp.git",
    "directory": "packages/eviland-core"
  },
  "keywords": [
    "visualizer",
    "audio",
    "webgl2",
    "milkdrop",
    "butterchurn",
    "vj",
    "music",
    "spectrum",
    "onset"
  ],
  "sideEffects": false,
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./renderer": {
      "types": "./dist/renderer.d.ts",
      "import": "./dist/renderer.js"
    },
    "./reactor": {
      "types": "./dist/reactor.d.ts",
      "import": "./dist/reactor.js"
    },
    "./rng": {
      "types": "./dist/rng.d.ts",
      "import": "./dist/rng.js"
    },
    "./adapter-analyser": {
      "types": "./dist/adapter-analyser.d.ts",
      "import": "./dist/adapter-analyser.js"
    }
  },
  "files": [
    "dist",
    "README.md",
    "CHANGELOG.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsup",
    "build:watch": "tsup --watch",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test:smoke": "node tests/reactor.smoke.mjs",
    "test:capture": "node tests/renderer.capture.mjs",
    "clean": "node -e \"import('node:fs').then(fs=>fs.promises.rm('dist',{recursive:true,force:true}))\""
  },
  "devDependencies": {
    "tsup": "^8.3.5",
    "typescript": "^5.7.2"
  },
  "engines": {
    "node": ">=18.17"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

### Build tool choice: **tsup** (not vite-lib)

- tsup is a thin esbuild wrapper. Single command, fast, no rollup config to maintain, splits ESM bundles per entry, emits `.d.ts` via TS. Already the industry default for zero-dep libs.
- vite-lib mode pulls in rollup and is overkill for a 4-entry ESM-only lib with no asset pipeline.
- The smoke scripts already use esbuild via the existing `scripts/eviland-smoke.mjs` `bundle()` helper — tsup keeps the toolchain symmetric.
- Justifying the new devDep: tsup is `^8.3.5`, ~1 MB installed, dev-only (excluded from package `files`), pure ESM. No new runtime deps.

### `tsup.config.ts`

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    renderer: 'src/renderer.ts',
    reactor: 'src/reactor.ts',
    rng: 'src/rng.ts',
    'adapter-analyser': 'src/adapter-analyser.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,        // each entry is self-contained; predictable file map
  treeshake: true,
  target: 'es2022',
  platform: 'browser',     // critical — refuses to bundle node: imports if any sneak in
  outDir: 'dist',
});
```

### `packages/eviland-core/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "noEmit": false,
    "lib": ["ES2022", "DOM"],
    "types": []
  },
  "include": ["src"]
}
```

(A small new `tsconfig.base.json` at repo root holds the shared `strict`, `module`, `moduleResolution: bundler`, `target` settings — the existing root `tsconfig.json` extends it, see §6.)

## 4. The public API surface — `packages/eviland-core/src/index.ts`

```ts
// @eviland/core — public surface.
//
// Stability:
//   - renderer / reactor / rng / palette / frame types: STABLE (these are what
//     NewAmp consumes today). Renaming is a breaking change.
//   - adapter-analyser: STABLE (new in 0.1.0).
//   - operator engine / director: not exported in 0.1.0 — added in 0.2.0 once
//     the in-renderer warp-equation block (renderer.ts:1067-1105) is refactored
//     behind an evaluator interface.

// ---- Renderer ----
export {
  createEvilandRenderer,
} from './renderer';
export type {
  EvilandRenderer,
  EvilandOptions,
  EvilandPalette,
} from './renderer';

// ---- Reactor ----
export {
  createEvilandReactor,
  EVILAND_BANDS,
} from './reactor';
export type {
  EvilandReactor,
  EvilandReactorConfig,
  EvilandFrame,
  EvilandOnset,
  VoiceGroup,
} from './reactor';

// ---- RNG / seed codec ----
export {
  Rng,
  mulberry32,
  hashSeed,
  toSeedState,
  encodeSeedCode,
  decodeSeedCode,
} from './rng';

// ---- AnalyserNode adapter (NEW) ----
//
// Convenience wrapper that owns the four Uint8Array taps the reactor needs.
// Embeds the reactor lifecycle so callers can write:
//
//   const driver = createEvilandAnalyserDriver({ analyser, onsetAnalyser, leftAnalyser, rightAnalyser });
//   const frame  = driver.analyze(dtMs, nowMs); // returns EvilandFrame
//
// Anything without an AnalyserNode (synthetic playback, offline render, IPC
// stream from another window) bypasses this and feeds raw Uint8Arrays straight
// into createEvilandReactor.analyze() — the existing path.
export {
  createEvilandAnalyserDriver,
} from './adapter-analyser';
export type {
  EvilandAnalyserDriver,
  EvilandAnalyserDriverConfig,
} from './adapter-analyser';
```

### Why we add an `adapter-analyser` even though the reactor already takes raw `Uint8Array`s

- The current reactor signature is `analyze(freq, onsetFreq, leftFreq, rightFreq, dtMs, nowMs)`. Every embedder has to: allocate four `Uint8Array`s sized to `binCount`, hold four `AnalyserNode` references, and call four `getByteFrequencyData` calls per frame.
- That's the *exact* boilerplate currently in `Visualizer.tsx:285-302`. Extracting it to `createEvilandAnalyserDriver` is a 30-line helper that drops a fragile, hand-rolled wiring pattern from every consumer and makes the "drop it on a page" pitch one factory call instead of seven.
- The raw `analyze()` path stays public for advanced consumers (synthetic feeds, IPC streams to a detached window, offline frame replay).

### `adapter-analyser.ts` outline (new module, ~60 lines)

```ts
import { createEvilandReactor, type EvilandFrame, type EvilandReactor } from './reactor';

export interface EvilandAnalyserDriverConfig {
  /** Smoothed visualizer analyser — drives bands + statistics. */
  analyser: AnalyserNode;
  /** Unsmoothed (smoothingTimeConstant=0) analyser — drives onset detection. */
  onsetAnalyser: AnalyserNode;
  /** Per-channel analysers (smoothingTimeConstant=0). Both required for stereo width/pan. */
  leftAnalyser: AnalyserNode;
  rightAnalyser: AnalyserNode;
}

export interface EvilandAnalyserDriver {
  readonly reactor: EvilandReactor;
  analyze(dtMs: number, nowMs: number): EvilandFrame;
  dispose(): void;
}

export function createEvilandAnalyserDriver(cfg: EvilandAnalyserDriverConfig): EvilandAnalyserDriver {
  const { analyser, onsetAnalyser, leftAnalyser, rightAnalyser } = cfg;
  const binCount = analyser.frequencyBinCount;
  const freq      = new Uint8Array(new ArrayBuffer(binCount));
  const onsetFreq = new Uint8Array(new ArrayBuffer(binCount));
  const leftFreq  = new Uint8Array(new ArrayBuffer(binCount));
  const rightFreq = new Uint8Array(new ArrayBuffer(binCount));
  const reactor = createEvilandReactor({
    sampleRate: analyser.context.sampleRate,
    fftSize:    analyser.fftSize,
    binCount,
  });
  let disposed = false;
  return {
    reactor,
    analyze(dtMs, nowMs) {
      if (disposed) throw new Error('EvilandAnalyserDriver.analyze after dispose');
      analyser.getByteFrequencyData(freq);
      onsetAnalyser.getByteFrequencyData(onsetFreq);
      leftAnalyser.getByteFrequencyData(leftFreq);
      rightAnalyser.getByteFrequencyData(rightFreq);
      return reactor.analyze(freq, onsetFreq, leftFreq, rightFreq, dtMs, nowMs);
    },
    dispose() { disposed = true; },
  };
}
```

NewAmp's `Visualizer.tsx` Eviland branch shrinks from ~25 lines of analyser wiring to ~3 lines + the `renderer.render(driver.analyze(dt, now), palette, dt)` call. That diff is the proof the API is right.

## 5. Files to move + the exact rewrites (the migration unit-of-work)

### 5.1 File moves (git mv — preserves blame)

| From | To |
|------|----|
| `src/visualizer/eviland.ts`        | `packages/eviland-core/src/renderer.ts` |
| `src/visualizer/eviland-audio.ts`  | `packages/eviland-core/src/reactor.ts` |
| `src/visualizer/eviland-rng.ts`    | `packages/eviland-core/src/rng.ts` |
| `studio/` (entire dir)             | `studio-legacy/` (atomic rename) |

`src/visualizer/particle-flow.ts` **stays put** — NewAmp-specific viz, not part of Eviland.

### 5.2 Edits inside the moved files (small, surgical)

| File (new path) | Edit | Justification |
|---|---|---|
| `packages/eviland-core/src/renderer.ts` | Line 35: `import type { EvilandFrame } from './eviland-audio';` → `import type { EvilandFrame } from './reactor';` | Renamed sibling. |
| `packages/eviland-core/src/reactor.ts` | No edits. Zero imports. | Already self-contained. |
| `packages/eviland-core/src/rng.ts` | No edits. Zero imports. | Already self-contained. |

That's the entire content diff for the move. **No logic changes.** `eviland-capture.mjs` PNG diff must be byte-identical (or at most differ by hash because the bundler entry path changed — but pixel content identical).

### 5.3 Edits in NewAmp consumers

| File | Old | New |
|---|---|---|
| `src/components/Visualizer.tsx:13` | `import { createEvilandRenderer } from '../visualizer/eviland';` | `import { createEvilandRenderer } from '@eviland/core';` |
| `src/components/Visualizer.tsx:14` | `import { createEvilandReactor } from '../visualizer/eviland-audio';` | `import { createEvilandReactor } from '@eviland/core';` *(or, after Phase 5a adoption of the adapter, replace lines 285-302 of `Visualizer.tsx` with the `createEvilandAnalyserDriver` call)* |

That is the **only** consumer in `src/`. (`src/components/FullscreenVisualizer.tsx` and `src/components/views/SettingsView.tsx` mention "eviland" by string ID only — no imports to update.)

### 5.4 Edits in the smoke scripts

| File | Old (verbatim) | New |
|---|---|---|
| `scripts/eviland-smoke.mjs:35` | `rendererBundle = await bundle('src/visualizer/eviland.ts', 'Eviland');` | `rendererBundle = await bundle('packages/eviland-core/src/renderer.ts', 'Eviland');` |
| `scripts/eviland-smoke.mjs:36` | `audioBundle = await bundle('src/visualizer/eviland-audio.ts', 'EvilandAudio');` | `audioBundle = await bundle('packages/eviland-core/src/reactor.ts', 'EvilandAudio');` |
| `scripts/eviland-capture.mjs:19` | `const rendererBundle = await bundle('src/visualizer/eviland.ts', 'Eviland');` | `const rendererBundle = await bundle('packages/eviland-core/src/renderer.ts', 'Eviland');` |
| `scripts/eviland-capture.mjs:20` | `const audioBundle = await bundle('src/visualizer/eviland-audio.ts', 'EvilandAudio');` | `const audioBundle = await bundle('packages/eviland-core/src/reactor.ts', 'EvilandAudio');` |

`scripts/eviland-smoke.mjs:38` and `:163` keep their `[eviland-smoke]` log tags — no rename of the test name.

### 5.5 NewAmp root `package.json` additions

Append these top-level fields next to the existing `"type": "module"`:

```jsonc
{
  // ...existing fields...
  "workspaces": [
    "packages/*",
    "apps/*"
  ],
  "dependencies": {
    "@eviland/core": "workspace:*",
    // ...existing deps unchanged...
  }
}
```

Why `dependencies` (not `devDependencies`): the renderer ships in the production NewAmp bundle. Vite resolves `@eviland/core` to `packages/eviland-core/dist/index.js` at build time (electron-builder packages `dist/` into the app). See §7 for the build-order detail.

### 5.6 NewAmp root `tsconfig.json` additions

```diff
   "paths": {
     "@/*": ["src/*"],
-    "@shared/*": ["shared/*"]
+    "@shared/*": ["shared/*"],
+    "@eviland/core": ["packages/eviland-core/src/index.ts"],
+    "@eviland/core/*": ["packages/eviland-core/src/*"]
   },
```

The path alias means `tsc` resolves `@eviland/core` directly to the workspace **source** during typecheck — no need to build the package before typechecking NewAmp. The vite alias in §5.7 mirrors this for `npm run dev` (HMR works across the workspace boundary instantly).

### 5.7 NewAmp `vite.config.ts` additions

```diff
   resolve: {
     alias: {
       '@': resolve(__dirname, 'src'),
       '@shared': resolve(__dirname, 'shared'),
+      '@eviland/core': resolve(__dirname, 'packages/eviland-core/src/index.ts'),
     },
   },
```

For production `npm run build`: tsup builds `packages/eviland-core/dist` first, then vite (which prefers the dist resolution via package `exports`) bundles the published artifact. The alias above is dev-only — vite's resolver prefers an exact-match alias when present; in production we want the built artifact so the alias is conditional:

```ts
const isDev = process.env.NODE_ENV !== 'production';
// ...
alias: isDev
  ? { /* the three aliases above */ }
  : {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'shared'),
      // no eviland alias in prod — let package exports resolve to dist/
    },
```

(Tradeoff: keeping a single alias that always points at `src` works too — vite bundles fine from TS — but it bypasses the tsup-built `.d.ts` and trees through TS, which means a typo in the public surface isn't caught until typecheck. The conditional alias gives us the prod resolution path we'll actually ship, while keeping dev HMR snappy.)

## 6. New shared TS config — `tsconfig.base.json` (repo root)

Extracted so both NewAmp and `@eviland/core` (and `apps/eviland-studio`) share strict compiler options:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "strict": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": false
  }
}
```

NewAmp's existing `tsconfig.json` is rewritten to `extends: "./tsconfig.base.json"` and adds back the app-only options (`baseUrl`, `paths`, `lib: [ES2022, DOM, DOM.Iterable]`, `jsx: react-jsx`, `noEmit: true`, `include`, `types: [node]`). The `allowImportingTsExtensions: true` it has today moves into the *NewAmp* tsconfig only — the core package wants the standard (no `.ts` extensions in imports) so its `tsup` build doesn't choke.

## 7. Build order + commands (after migration)

```bash
# One-time install (from repo root)
npm install

# Dev (NewAmp + live core):
npm run dev                          # NewAmp via vite alias → core source — instant HMR
# OR
npm run build:watch --workspace @eviland/core   # rebuild dist on save (only needed when testing prod-style resolution)

# Build everything (release-style):
npm run build --workspace @eviland/core         # writes packages/eviland-core/dist/
npm run build                                   # NewAmp tsc + vite build → dist/ + dist-electron/

# Verification (must keep passing — Phase 5 gate):
npm run typecheck                               # NewAmp + workspace TS
npm run build --workspace @eviland/core         # core builds clean
npm run smoke:eviland                           # the reactivity smoke
node scripts/eviland-capture.mjs                # PNG capture — frame must look identical to pre-move
node scripts/visualizer-smoke.mjs               # general viz smoke
node scripts/audio-proof-smoke.mjs              # audio pipeline (sanity)
```

NewAmp's existing release pipeline (`npm run package`, `release:gate`, electron-builder) is **unchanged**. The packaged app only ships the `dist/` (renderer build output), and the renderer build inlines `@eviland/core` from its `dist/` via standard rollup resolution. `packages/eviland-core/` is **not** copied into the Electron `extraResources` — only the bundled output that lives in NewAmp's `dist/` after vite build.

## 8. Eviland Studio (`apps/eviland-studio`) — first-pass spec

This is the standalone VJ tool. Phase 5a only stubs the workspace member (so `npm install` wires everything); Phase 5b through 5d build out the app in parallel with NewAmp work, because they share zero source.

### 8.1 Day-1 Studio shape

- **Stack**: Vite + TypeScript + vanilla TS (no React in v0 — keeps it light and proves the core lib has zero framework deps). React optional later.
- **Surfaces**:
  1. **Source picker**: file (`<audio>` element), microphone (`getUserMedia({ audio })`), line-in (same API + device picker via `enumerateDevices()`).
  2. **Stage**: a single full-window `<canvas>` driven by `createEvilandRenderer` + `createEvilandAnalyserDriver`.
  3. **Transport**: play/pause/seek when source = file; mute/gain when source = mic.
  4. **Preset deck**: name + seed + quality + palette. Persisted in IndexedDB (no SQL — Studio is browser-native). Import/export presets as JSON (single-file shareable).
  5. **Recorder**: `canvas.captureStream(60)` + the `AnalyserNode`'s upstream `MediaStreamAudioDestinationNode` → `MediaRecorder` (WebM). MP4 transcode is a Phase 5d concern (would need `ffmpeg-static` and an Electron shell).
  6. **Random / Lock**: button maps to `encodeSeedCode(Math.random()*2^32|0)`; lock pins the seed in the URL hash so a tab refresh keeps the look.
- **Electron shell (Phase 5c)**: thin wrapper that ships the same vite build inside an Electron BrowserWindow with the live-input permission handler pre-allowed and ffmpeg-static plumbed. Allows packaging Studio as a standalone .exe/.dmg/.AppImage independent of NewAmp.

### 8.2 `apps/eviland-studio/package.json` (skeleton — Phase 5a)

```json
{
  "name": "@eviland/studio",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@eviland/core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "typescript": "^5.7.2",
    "vite": "^6.0.5"
  }
}
```

### 8.3 Why a separate Studio app (instead of a Studio mode inside NewAmp)

- NewAmp is a music **player**. Conflating it with a VJ/recording tool bloats the surface, drags Studio releases behind player releases, and forces every Studio user to install a 300 MB player they don't want.
- A separate app proves the `@eviland/core` extraction is clean — if Studio can stand up against only the package, the package boundary is correct. (NewAmp consuming the same package validates the other direction.)
- Studio's natural user is a VJ / streamer / video producer. Different brand, different distribution, different update cadence. The package is the asset; the two apps are vehicles.

## 9. Staged migration order — every stage keeps NewAmp working

Each stage is one atomic commit, with the verification commands listed. **DO NOT** combine stages — the value is that any stage can be reverted without losing the others. Use git tags for snapshot recovery between stages.

### Stage A — pre-flight (no code changes)
1. Run `node scripts/eviland-capture.mjs` and copy `tmp/eviland-capture.png` to `tmp/eviland-capture-baseline.png` — the visual regression anchor.
2. `npm run typecheck` and `npm run smoke:eviland` — both must pass.
3. `git tag eviland-pre-extract` for rollback.

### Stage B — create the package skeleton (no consumers change yet)
1. Create `packages/eviland-core/{package.json, tsconfig.json, tsup.config.ts, LICENSE, README.md, CHANGELOG.md, .npmignore, src/}`.
2. `git mv src/visualizer/eviland.ts packages/eviland-core/src/renderer.ts`.
3. `git mv src/visualizer/eviland-audio.ts packages/eviland-core/src/reactor.ts`.
4. `git mv src/visualizer/eviland-rng.ts packages/eviland-core/src/rng.ts`.
5. Edit `renderer.ts:35`: change `'./eviland-audio'` → `'./reactor'`.
6. Write `packages/eviland-core/src/index.ts` (the re-exports from §4).
7. Write `packages/eviland-core/src/adapter-analyser.ts` (the new module from §4).
8. Add `tsconfig.base.json` at repo root.
9. Update NewAmp root `tsconfig.json` to extend the base and to add the `@eviland/core` path alias.
10. Update NewAmp root `vite.config.ts` to add the dev-only alias.
11. Edit `src/components/Visualizer.tsx:13-14` to import from `@eviland/core`.
12. Edit `scripts/eviland-smoke.mjs:35-36` and `scripts/eviland-capture.mjs:19-20` to use the new paths.
13. Add `"workspaces": ["packages/*", "apps/*"]` and `"@eviland/core": "workspace:*"` to NewAmp `package.json`.
14. `npm install` (creates the workspace symlink).
15. **VERIFY**:
   - `npm run typecheck` — passes.
   - `npm run build --workspace @eviland/core` — passes (tsup writes `dist/`).
   - `npm run build` — NewAmp builds clean.
   - `node scripts/eviland-capture.mjs` — diff `tmp/eviland-capture.png` against `tmp/eviland-capture-baseline.png` (e.g. ImageMagick `compare -metric AE`). Must be **identical** or differ by ≤ tiny float rounding (< 50 pixels different).
   - `npm run smoke:eviland` — passes.
   - `npm start` and visually confirm Eviland renders the same.
16. Commit: `refactor(eviland): extract renderer/reactor/rng to @eviland/core workspace`.
17. `git tag eviland-core-extracted`.

### Stage C — adopt the AnalyserNode adapter inside NewAmp
1. Edit `src/components/Visualizer.tsx` Eviland branch (lines 285-302) — replace the four `Uint8Array` allocations and the four `getXxxFreqData` calls with `const driver = createEvilandAnalyserDriver({ analyser: engine.visualizerNode, onsetAnalyser: engine.onsetNode, leftAnalyser: engine.leftNode, rightAnalyser: engine.rightNode });`.
2. (Pre-req: confirm `AudioEngine` exposes the four analyser nodes; if not, add `getOnsetNode()`, `getLeftAnalyser()`, `getRightAnalyser()` shims mirroring the existing `visualizerNode` getter. The taps `getOnsetFreqData`/`getLeftFreqData`/`getRightFreqData` exist — the underlying nodes do too; this is a one-line getter per node.)
3. Replace the `reactor.analyze(freq, onsetFreq, leftFreq, rightFreq, dtMs, now)` call with `driver.analyze(dtMs, now)`.
4. **VERIFY**: same gate as Stage B.
5. Commit: `refactor(viz): adopt @eviland/core AnalyserNode adapter in Visualizer`.
6. `git tag eviland-adapter-adopted`.

### Stage D — rename legacy `studio/` to `studio-legacy/`
1. `git mv studio studio-legacy`.
2. Add a one-liner `studio-legacy/README.md` explaining the dir's origin and that the live "studio" name now belongs to `apps/eviland-studio`.
3. **VERIFY**: `grep -rn "studio/" src/ electron/ scripts/ shared/` returns no source matches; `npm run typecheck` passes.
4. Commit: `chore: rename legacy studio/ design workspace to studio-legacy/`.

### Stage E — scaffold `apps/eviland-studio` (skeleton only)
1. Create `apps/eviland-studio/{package.json, tsconfig.json, vite.config.ts, index.html, src/main.ts, README.md}`.
2. `src/main.ts` boots a minimal page: file-input picker → loads an `<audio>` → creates a Web Audio graph mirroring NewAmp's analyser quad → `createEvilandRenderer` + `createEvilandAnalyserDriver` → rAF loop.
3. `npm install` from repo root (workspace picks up the new app).
4. `npm run dev --workspace @eviland/studio` boots; load a local mp3, see Eviland render.
5. Commit: `feat(eviland-studio): scaffold standalone @eviland/studio app on @eviland/core`.

### Stage F — publish prep (later; not required to ship Phase 5)
1. Write `packages/eviland-core/README.md` API doc with the embed example.
2. Move (copy) `scripts/eviland-smoke.mjs` and `eviland-capture.mjs` into `packages/eviland-core/tests/` as the package's own smoke suite.
3. `npm version` in the package, `npm publish --workspace @eviland/core --access public`.
4. NewAmp root `package.json` switches `"@eviland/core": "workspace:*"` → `"@eviland/core": "^0.1.0"` (workspace protocol falls back to npm registry resolution).

## 10. Risk register + mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `npm install` in a Windows repo with native modules (ffmpeg-static, electron, sql.js) tripping on the new workspace layout. | Medium. | Stage B runs `npm install` first; if it fails, the rollback is `git checkout eviland-pre-extract && rm -rf node_modules && npm install`. The workspaces feature is supported by npm ≥ 7; the repo uses npm with Node 22 (see `@types/node` ^22.10.2). |
| `electron-builder` packaging the wrong path for the moved files (it doesn't — it bundles `dist/` only, which is post-vite-build). | Low. | Verified in `package.json:202-212` — `files` glob is `dist/**/*` and `dist-electron/**/*`; no source path. After vite bundles `@eviland/core` into `dist/assets/*.js`, packaging is unaffected. Stage B's `npm run package` smoke catches it anyway. |
| Vite dev alias resolving `@eviland/core` to `src/index.ts` while prod resolves via `dist/index.js` — divergence between dev and prod. | Medium. | The conditional alias in §5.7 is the explicit guard; documented; can be removed entirely if Phase 5 reveals the always-source path is fine (it likely is for an ESM TS lib). |
| Visual regression after the move (smoke passes but pixels shift). | Low (no logic changes). | Stage A captures the baseline PNG; Stage B diffs against it. Any pixel-level divergence > tolerance blocks the commit. |
| Loss of git blame on the moved files. | Low. | `git mv` (used in §5.1) preserves blame; `git log --follow` works. |
| `studio/` rename breaking some hidden tool. | Very low. | grep verified zero source references. Stage D's grep gate catches it. `studio/designs.db` is preserved as `studio-legacy/designs.db`. |
| `@eviland/core` accidentally importing `node:*` modules (kills the browser bundle). | Low. | tsup `platform: 'browser'` refuses the build if a `node:` import sneaks in. Current source has zero Node imports — confirmed by grep. |
| `tsup` choking on the `.ts` extension imports the current source uses internally. | None. | Current source has NO `.ts`-extension imports (only `'./eviland-audio'`). The package tsconfig drops `allowImportingTsExtensions`. |
| NewAmp typecheck failing because `@eviland/core/dist/*.d.ts` doesn't exist on first install. | Medium. | The `tsconfig.json` `paths` alias resolves `@eviland/core` to `packages/eviland-core/src/index.ts` directly — typecheck does not need the build. Documented in §5.6. |
| Future contributors adding a NewAmp-specific import to `renderer.ts` and breaking the zero-dep promise. | Medium. | Stage F adds a tsup build to the package's smoke; a CI check fails on any `node:` or relative-out-of-package import. Inline rule: PRs touching `packages/eviland-core/src/*` MUST keep the package buildable with `npm run build --workspace @eviland/core`. |

## 11. Open decisions deferred to later phases

- **Whether to publish to npm registry** (Phase 5f). The workspace setup means the answer doesn't gate Phase 5. We can publish whenever the public surface is locked.
- **Whether Studio gets React** (Phase 5b vs 5c). Pure-TS v0 proves the package needs no framework. React is a Phase 5c add if the Studio UI grows beyond ~5 controls.
- **Whether to ship `@eviland/presets`** as a separate workspace (operator-config presets) once the operator engine lands in Phase 2 of the broader Eviland roadmap. Likely yes; this design leaves `packages/` ready.
- **Whether to ship `@eviland/director`** as a separate workspace for the AI Director (Phase 6). Likely yes; symmetric to presets.
- **Whether `apps/eviland-studio` should reuse NewAmp's `electron/` setup** (Phase 5c). Probably not — Studio's Electron needs are different (live-input permission default on, no media-key registration, no file-association registration). Independent shell keeps both small.

## 12. One-line summary for the implementer

> Move three files into `packages/eviland-core/src/`, update one import path, one `Visualizer.tsx` import, two smoke-script paths, add a `workspaces` field, run the smoke + capture suite, commit, tag. Then scaffold `apps/eviland-studio` and rename `studio/` → `studio-legacy/`. NewAmp keeps working at every step because the extraction is a *move + rename* of an already-isolated module.
