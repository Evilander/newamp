# NewAmp Post-1.11.0 Roadmap — Implementation Blueprint

Produced 2026-06-10 by the ultraplan architect pass, synthesizing five research agents
(codebase recon, external best practices, framework docs, institutional learnings, git history).
All file:line references verified against v1.11.0 (commit 5452d77).

## A. Cross-pillar invariants (apply to every PR)

1. `node packages/eviland-core/sync.mjs --check` must pass for any touched mirrored file. The 8 mirrored files are `eviland.ts`, `eviland-audio.ts`, `eviland-director.ts`, `eviland-fluid.ts`, `eviland-operators.ts`, `eviland-randomizer.ts`, `eviland-recorder.ts`, `eviland-rng.ts`. `eviland-producer.ts` is exempt.
2. Every new feature lands as: pure-seam node-tested module (RED→GREEN via `esbuild + node --test`) BEFORE any React/Electron wiring (the `eviland-fluid-test` pattern at `scripts/eviland-fluid-test.mjs`).
3. Every new feature adds at least one `test:*` (pure) and one `smoke:*` (real Electron) script to `package.json` AND a job line in `.github/workflows/ci.yml` AND must survive `npm run release:gate:local` against `K:/music` (62,949 tracks).
4. No sql.js write at frame/play-event frequency. Write only on: track-end, "N new fingerprints" threshold, or explicit user action. `scheduleFlush` debounces 800ms — let it do its job, do not call `flushSync`.
5. Honesty headers retained: any director/randomizer change keeps the "deterministic from (songId, sectionId, rotationIndex) + two playback-clock inputs" wording at `eviland-director.ts:17-21` accurate.
6. Removal history check before adding new surfaces: `git log --diff-filter=D` for sonic-atlas / live-input / HotdogDeck — confirm nothing reintroduces these.

---

## PILLAR 1 (CENTERPIECE) — Eviland Remembers Your Library

### 1.1 plan_json schema (the durable contract)

The blob format is versioned, append-only-friendly, and lineage-anchored. The crucial invariant: identity = seed lineage. We store fingerprints + counters as evidence; if we ever need to regenerate looks for a new `algoVersion`, we replay from seeds.

File: `src/visualizer/eviland-memory-types.ts` (NEW, mirrored — must be added to `sync.mjs` MIRRORED list).

```ts
// Schema versions:
//   1: initial — sections, fingerprints, lineage, counters.
// Forward-compat rule: unknown fields are preserved on read; never drop them.
export const VISUAL_MEMORY_SCHEMA_VERSION = 1;
// algoVersion changes when the randomizer/director generative algorithm
// changes meaningfully. Old plans with older algoVersion are LOADED but
// flagged staleAlgo:true — Director re-derives a fresh primary look but
// keeps lineage so the song "remembers" without snapping.
export const VISUAL_MEMORY_ALGO_VERSION = 1;

export interface VisualMemorySection {
  sectionId: number;            // monotonic from reactor
  fingerprint: number[];        // 24-float mel avg, JSON-safe (Float32 lost on JSON)
  seed: number;                 // hashSeed used to generate this look (uint32)
  archetype: string;            // 'liquid'|'nebula'|...
  tier: 'calm'|'steady'|'lift'|'drop'|'climax';
  rotationIndex: number;        // 0 = primary; >0 = forced rotations seen
  observedCount: number;        // how many times we've returned to this section
  firstSeenAt: number;          // epoch ms — for prune-without-descendants
  lastSeenAt: number;
}

export interface VisualMemoryLineage {
  // The seed that minted THIS plan's "primary look family" for the track.
  // Epoch-based child seeds: new generations xor a mutation key with this.
  // MANDATORY elitism — ancestor seeds NEVER overwritten in storage.
  rootSeed: number;
  ancestors: number[];          // chronological, cap at 8 (mu+lambda history)
  generation: number;           // 0 = first play, ++ on each evolution event
  // What concrete listening events triggered evolutions. Pruning rule:
  // an ancestor with zero descendants AND zero sections referencing it
  // may be dropped on next compact.
  evolutionLog: Array<{
    at: number;                 // epoch ms
    trigger: 'play-count'|'love'|'section-return'|'neighbor-seed';
    fromSeed: number;
    toSeed: number;
  }>;
}

export interface VisualMemoryPlan {
  schema: number;               // VISUAL_MEMORY_SCHEMA_VERSION
  algoVersion: number;          // VISUAL_MEMORY_ALGO_VERSION at write time
  trackId: number;
  songId: string;               // canonicalized — `track-${trackId}`
  // Optional: nearest-neighbor seed source if this plan was seeded from
  // another track via DNA. Persisted so the UI can render
  // "Borrowed visual DNA from {title}".
  neighborSeed?: { fromTrackId: number; score: number; at: number };
  lineage: VisualMemoryLineage;
  sections: VisualMemorySection[];
  counters: {
    plays: number;
    skips: number;
    loves: number;
    sectionReturns: number;
  };
  updatedAt: number;
}
```

### 1.2 Director injection points

Modify `src/visualizer/eviland-director.ts`:

- Add to `DirectorOptions` (after line 273):
  ```ts
  /** Pre-populated visual memory plan. Loaded into the sections map in
   *  reset() / construction; lineage stamped into seedFor() via planSongIdSalt. */
  plan?: VisualMemoryPlan;
  /** Called when the director writes a new section to its memory map.
   *  Lead uses this to coalesce writes — does NOT fire on forced rotations. */
  onSectionLearn?: (section: VisualMemorySection) => void;
  ```
- Add to `Director` public API:
  ```ts
  loadPlan(plan: VisualMemoryPlan): void;   // hot-load mid-track (rare)
  exportPlan(): VisualMemoryPlan;           // for the writer
  ```
- In `createDirector` body:
  - Track `lineage: VisualMemoryLineage` initialized from `opts.plan?.lineage` or `{ rootSeed: hashSeed(songId), ancestors: [], generation: 0, evolutionLog: [] }`.
  - In `seedFor`, fold `lineage.rootSeed` into the key when generation>0:
    ```ts
    const lineageSalt = lineage.generation > 0 ? `::g${lineage.generation}::${lineage.rootSeed >>> 0}` : '';
    const key = rotation === 0
      ? `${activeSongId}${lineageSalt}::section::${sectionId}`
      : `${activeSongId}${lineageSalt}::section::${sectionId}::r${rotation}`;
    ```
    Generation 0 PRESERVES the original key, so existing songs without plans render identically — the No Man's Sky lesson encoded in code.
  - In `reset()`, if `opts.plan` is current and `plan.algoVersion === VISUAL_MEMORY_ALGO_VERSION`, repopulate `sections` from `plan.sections` (rebuilding the `OperatorConfig` via `generateForSection(s.sectionId, s.tier, s.rotationIndex)` — we re-derive from seed, we never store the heavy config). If algoVersion mismatches, populate fingerprints into a parallel `staleAlgoFingerprints` map used only for "returning section detection" guidance; do NOT use stored seeds.
  - In `onSectionBoundary`, after `sections.set(...)`, call `opts.onSectionLearn?.(...)` synthesizing the `VisualMemorySection`. **Critically: only call from real-section paths, never from `onForcedRotation`.** The existing comment at line 420 ("Forced rotations deliberately do NOT write the `sections` recall map") gets a follow-on: "...and the onSectionLearn callback is wired to the same gate."

### 1.3 Reactor surfacing for the writer

The reactor at `eviland-audio.ts:412-435` already holds the 24-float fingerprint locally. We need that fingerprint on the boundary `EvilandFrame`. Modify:

- `EvilandFrame` (line 28) add: `sectionFingerprint: Float32Array | null;` — non-null **only on the frame where `sectionChanged === true`**, else null. Allocation cost: one Float32Array(24) per real boundary (~every 10-30s) — negligible.
- In `analyze()` at line 433, after pushing `fp` into `fingerprints`, also set `out.sectionFingerprint = fp;`. On all other frames, set `out.sectionFingerprint = null` at the start of each call (alongside the existing `out.sectionChanged = false`).

### 1.4 Persistence: library.ts surface

Modify `electron/library.ts`:

- Schema (in `init()` after the existing `ensureColumn` chain at line 682):
  ```ts
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS track_visual_memory (
      track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
      plan_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      algo_version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  ```
- Methods (mirror the `setTrackDna` / `getTrackDna` pattern at lines 2665-2691):
  ```ts
  setTrackVisualMemory(trackId: number, plan: VisualMemoryPlan): boolean;
  getTrackVisualMemory(trackId: number): VisualMemoryPlan | null;
  clearTrackVisualMemory(trackId: number): boolean;
  getVisualMemoryStats(): { tracksWithMemory: number; totalSections: number; oldestAt: number | null };
  // Phase 2:
  getAggregateVisualMemoryByArtist(albumArtist: string): VisualMemoryAggregate | null;
  ```
  All write paths end with `this.scheduleFlush()`. JSON parse errors quarantine the row (set to `NULL`) and log to `recoveryEvents` — same pattern as DNA.

### 1.5 IPC surface

`electron/preload.ts` (after DNA block at line 164):
```ts
getTrackVisualMemory: (id: number) =>
  ipcRenderer.invoke('tracks:visual-memory-get', id) as Promise<VisualMemoryPlan | null>,
setTrackVisualMemory: (id: number, plan: VisualMemoryPlan) =>
  ipcRenderer.invoke('tracks:visual-memory-set', id, plan) as Promise<boolean>,
clearTrackVisualMemory: (id: number) =>
  ipcRenderer.invoke('tracks:visual-memory-clear', id) as Promise<boolean>,
getVisualMemoryStats: () =>
  ipcRenderer.invoke('tracks:visual-memory-stats') as Promise<VisualMemoryStats>,
```

`electron/main.ts` (after line 1520): four matching `ipcMain.handle` registrations.

### 1.6 The writer/loader bridge

New file `src/visualizer/eviland-memory-bridge.ts` (NOT mirrored — renderer-only, Electron API access):

Responsibilities:
1. **Load on track change**: given `trackId`, `await window.newamp.getTrackVisualMemory(id)`, return plan or null. If null, optionally consult `findSimilarTracks(id, 1)`: if top score >= 0.92, fetch that neighbor's plan, mint a derived plan with `neighborSeed: {fromTrackId, score, at}`, `lineage.generation=0`, `lineage.rootSeed = hashSeed(neighbor.rootSeed ^ id)` — note the seed is *derived from* the neighbor, never identical (preserves the "borrow" semantic without identical visuals).
2. **Buffer fingerprints in-memory** during playback. Accept calls from director via `onSectionLearn` callback. Maintain a dirty counter.
3. **Flush triggers** (any of):
   - Track-end event from `usePlayerStore`
   - Dirty counter reaches `LEARN_FLUSH_THRESHOLD = 4` new sections
   - View change away from any active visualizer (debounced 2s)
   - Tab visibility change to hidden
4. **Lineage evolution events** (handled in bridge, not director — keeps director pure):
   - On `library:record-play` echoed by store, increment `counters.plays`. Every 8 plays, push a new `lineage.evolutionLog` entry; mutate `rootSeed` only at the next generation tick (generation increments when plays = 8, 32, 96, 256 — exponential decay so old tracks stabilize).
   - On love, queue a generation tick immediately if generation < 3.
5. **Prune-without-descendants** runs at flush time: walk `lineage.evolutionLog`, drop entries whose `toSeed` does not appear in either current `lineage.rootSeed` or any `section.seed`. Cap log length at 32.

### 1.7 Visualizer.tsx wiring

Modify `src/components/Visualizer.tsx` (existing director construction at line 407):

```ts
// Inside the eviland branch, before createDirector:
const memoryBridge = createMemoryBridge({ trackId: initial.trackId });
const director = createDirector({
  songId: initial.trackId != null ? `track-${initial.trackId}` : 'eviland',
  onSectionLearn: (section) => memoryBridge.observeSection(section),
});
// Effect can't be async: create director synchronously with no plan, then
// hot-load: guard with `let cancelled = false`:
Promise.resolve(memoryBridge.loadOrSeed()).then(plan => {
  if (cancelled || !plan) return;
  director.loadPlan(plan);
});
```

Add a track-change effect (a sibling to the existing `lastTrackId` check):
```ts
useEffect(() => {
  return () => { memoryBridge.flushAndDispose('track-change'); };
}, [trackId]);
```

In `eviland-producer.ts:144-149` apply the same `loadOrSeed`/`observeSection` pattern (the detached window must remember too).

NOTE: bridge must NO-OP entirely when trackId is null (non-library plays collide on songId 'eviland' — never persist memory for them).

### 1.8 The "Eviland knows this song" UI affordance (phase 1, minimal but visible)

The Refik Anadol lesson: if users can't see the memory working, the feature reads as random.

Add to `src/components/FullscreenVisualizer.tsx` as a new overlay component **only when `activePreset === 'eviland'` AND a plan was loaded for the current track**:

```
+------------------------------+
|  REMEMBERS THIS SONG  - gen2 |
|  17 plays - 4 sections known |
+------------------------------+
```

Tiny, top-left, fades in over 4s and back out after 5s on track start; pinnable via click -> opens a popover with:
- "Reset visual memory for this track" -> `clearTrackVisualMemory(id)`
- "Borrowed from {neighbor.title}" link if `neighborSeed` is set
- Generation/lineage compact view

File: `src/components/EvilandMemoryBadge.tsx` (NEW). Reuses `signal-path-badge` styling tokens for visual consistency.

Also add a one-line counter to `SettingsView.tsx` Audio/Visuals section: "Eviland remembers N tracks - purge all". **Memory privacy:** purge-all must delete the table rows (not just NULL the column), and a confirm dialog with line "this resets the visual look of every remembered song to its first-play default" is mandatory.

### 1.9 Phase 2 (separate release): per-artist/genre aggregate

After Phase 1 ships and bakes one minor version:

- Table `artist_visual_memory(album_artist PRIMARY KEY, plan_json TEXT, updated_at)`.
- Aggregate built lazily: when N>=5 tracks by an artist have plans, mint an aggregate plan whose `lineage.rootSeed = hashSeed('artist::' + name)` and whose `sections` are clusters of the artist's section fingerprints (k-means k=8, plain JS). A new track by that artist with no plan gets seeded from the artist aggregate BEFORE the DNA-neighbor path (artist familiarity > sonic similarity).
- Genre layer is identical with the genre tag as key.

### 1.10 Acceptance criteria (Pillar 1)

- `npm run test:eviland-director` (extended) — RED→GREEN — covers: plan round-trip (`exportPlan -> loadPlan` reproduces identical first 4 generated configs at the same seeds); `onSectionLearn` fires on `sectionChanged` only and never on forced timer rotations across a 5-minute simulated frame stream; algoVersion mismatch path uses stored fingerprints for return-detection but does NOT use stored seeds.
- New `npm run test:eviland-memory` (pure node, no Electron): plan JSON schema round-trip; lineage evolution math (generation transitions at 8/32/96/256); prune-without-descendants leaves no orphan log entries; neighbor-seed derivation never returns the neighbor's exact root seed.
- New `npm run smoke:eviland-memory` (real Electron): launch app, play 3 tracks in K:/music for >=45s each, assert `getTrackVisualMemory(id)` returns plans with >=1 section each; restart app; reload same track; assert director's first-frame seed equals the persisted primary section seed.
- `node packages/eviland-core/sync.mjs --check` passes after adding `eviland-memory-types.ts` to the mirrored set.
- `npm run release:gate:local` passes against K:/music. Audit: <=1 visual-memory DB write per track played to completion (counter asserted in smoke).
- `npm run typecheck` clean.

---

## PILLAR 2 — Stem-true Sight (stem-aware visualizer)

### 2.1 Architecture

- **Process**: Electron `utilityProcess` (`electron/stem-worker.ts` NEW), entry registered from `main.ts`. `onnxruntime-node` loaded in the worker only; renderer never imports it.
- **Models directory**: `app.getPath('userData')/stem-models/htdemucs-ft/{drums,bass,vocals,other}.onnx`. NOT bundled. First-run UX (see 2.3).
- **Cache directory**: `app.getPath('userData')/stem-cache/`. Files keyed `<sha256(realpath|size|mtime|model_version|chunk_params)>.f32` containing four interleaved Float32 envelope curves at 100Hz. Eviction: LRU bytes-budget setting (default 2 GB, configurable). Reuse the `transcode-cache.ts` hashing helpers — extract them into `electron/cache-key.ts` (NEW shared module) instead of copy-pasting.
- **Worker concurrency**: One ORT session per stem, all four parallel within the single utilityProcess. Outer scheduler: `MAX_CONCURRENT_TRACKS=1` (we only need envelopes for the playing track; the next track gets queued at -30s lookahead).

### 2.2 Files to create/modify

- `electron/stem-worker.ts` NEW — utilityProcess entry. Loads ORT, accepts `{ id, srcPath, modelVersion }` over MessageChannelMain, decodes via `ffmpeg-static` (reuse `dna-analyzer.ts` pattern) -> stereo 44.1k Float32, chunks [1,2,343980] with 1s overlap-add (triangular window), runs 4 ORT sessions, computes per-stem RMS envelope at 100Hz, writes the cache file, returns `{ id, ok, cachePath }` or `{ id, ok:false, error }`.
- `electron/stem-service.ts` NEW — main-process owner. Spawns the utilityProcess, restarts on crash with backoff, exposes `analyzeTrack(trackId, path)` returning `Promise<StemEnvelopes>`. In-memory inflight Map (dedupe). Watchdog: kill+respawn worker if a job stalls >120s.
- `electron/cache-key.ts` NEW — extracted realpath+size+mtime+RECIPE_TAG helpers from `transcode-cache.ts`.
- `electron/main.ts` — IPC `stems:get-envelopes` (sync read from cache if present, else nudge analyzer in background and return null), `stems:precompute`, `stems:cache-stats`, `stems:cache-clear`, `stems:models-status`, `stems:download-models`.
- `electron/preload.ts` — mirror IPC surface.
- `src/visualizer/stem-envelope-source.ts` NEW — renderer client. Loads the cache file's Float32 bytes via fetch through `protocol.handle`. Exposes `sample(timeSec): { drums, bass, vocals, other }` via interpolated lookup.
- `src/visualizer/eviland-audio.ts` — add to `EvilandFrame`: `stemEnvelopes?: { drums; bass; vocals; other } | null` — null when not available. Reactor unchanged (pure FFT path remains the moat); the lead in `Visualizer.tsx` fills the field per-frame from `stem-envelope-source.sample(audio.currentTime)`.
- `src/visualizer/eviland-director.ts` — stem-aware tier hints: if vocals > 0.5 && drums < 0.2, bias archetype weights toward cathedral|deepfield|inkwell. Documented: "stems refine, FFT decides — stem hints are an additive bias, never overrides".

### 2.3 First-run UX (model download)

SettingsView "Stem-aware visualizer (experimental)" row. States: Not installed (default, "Download models ~280MB" with checksums + "models stay local"); Installing (progress); Installed ("clear cache N tracks, M MB"); Probe-failed (Intel iGPU conv bug #24442 -> "GPU acceleration disabled — falling back to CPU", persist `stemsExecutionProvider: 'wasm'`; probe is a fixture run at first enable; cache key incorporates EP).

### 2.4 Acceptance criteria (Pillar 2)

- `npm run test:stem-worker`: synthetic 7.8s sine through a fixture model -> envelopes within tolerance.
- `npm run smoke:stem-precompute`: analyze 3 K:/music tracks, cache files present, second invocation <50ms.
- `npm run smoke:stem-envelope-source`: sampling returns 4 finite floats in [0,1].
- `NEWAMP_STEM_FORCE_WASM=1` forces wasm EP, cache re-keys.
- `smoke:visualizer` extended: stems on -> stemEnvelopes populated >=95% of mid-track frames; stems off -> field null, visuals byte-identical to current.
- Default-off; no regression to any non-stem smoke when disabled.

---

## PILLAR 3 — WASAPI-exclusive Native Output (Windows-only v1)

### 3.1 Architecture: bypass the existing pipeline

The exclusive path does NOT thread through `HTMLAudioElement` or `transcode.ts`. We own decode -> PCM -> WASAPI.

- **Process**: utilityProcess (`electron/wasapi-worker.ts` NEW). `audify` loads here only. audify 1.10.1 prebuilds cover NAPI 10 (Electron 42) — no electron-rebuild in the happy path. Add `scripts/audify-prebuild-probe.mjs` postinstall probe (informational, never blocking).
- **Decode**: WebCodecs `AudioDecoder` in the renderer (Blink API). Renderer streams Float32 ArrayBuffers to the worker via MessageChannelMain set up from main. No SAB across the worker boundary (Electron polyfilled ports don't carry SAB).
- **Ring buffers**: Renderer-side SAB ringbuf.js (AudioWorklet producer) AND a worker-local ring fed by ArrayBuffer chunks whose consumer drives the audify TSFN callback. Two rings — that's the practical Electron shape.
- **COOP/COEP**: inject `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` on app responses (protocol.handle / onHeadersReceived), gated by `enableExclusiveOutput` setting.
- **Format**: FLOAT32 only over the wire (audify hard-rejects SINT24). TPDF dither only at final int16 boundary; 24/32-bit endpoints pass through.
- **Device-rate switching**: per-track stream teardown+reopen. Open failure -> `engine:exclusive-fallback` event -> Web Audio engine for that track + toast.
- audify limits: numberOfBuffers/priority NOT exposed (fork audify if latency targets unreachable); RTAUDIO_HOG_DEVICE | MINIMIZE_LATENCY | SCHEDULE_REALTIME flags confirmed plumbed.

### 3.2 Files

- `electron/wasapi-worker.ts` NEW; `electron/exclusive-output.ts` NEW (main-process owner, IPC: exclusive:list-devices/open/close/status); `src/audio/exclusive-decoder.ts` NEW (WebCodecs + SAB ring producer).
- `src/audio/engine.ts` MODIFY — `outputMode: 'webaudio'|'wasapi-exclusive'`, `getOutputMode()`; exclusive path is parallel, engine logic otherwise untouched.
- `src/components/SignalPathBadge.tsx` MODIFY — `tone: 'bitperfect'` (golden) when exclusive, label `${sourceKhz} BIT-PERFECT`.
- `src/components/views/SettingsView.tsx` MODIFY — Bit-Perfect row gains "Exclusive output (Windows · WASAPI)" + device picker; replace the literal "32-bit float / Web Audio" at :1316-1320 with `engine.getOutputMode()`-driven copy.
- `package.json` — `audify@^1.10.1` dep; justification block in `docs/audio-quality.md`; opt-in setting `enableExclusiveOutput` default false.
- Exotic formats (APE/MPC/TTA, no WebCodecs): fall back to the standard Web Audio engine for those tracks in v1; optionally extend transcode-cache for FLOAT32 PCM later (the ONLY optional contact with todo 007's serveAudio extraction).

### 3.3 Acceptance criteria (Pillar 3)

- `npm run test:exclusive-ringbuf` (pure node, fake TSFN driver): underrun emits silence + warning, no crash.
- `npm run smoke:wasapi-exclusive` (Windows): open default endpoint at 44.1/48/96/192k, 5s tone, zero underruns.
- `smoke:audio-output` passes in both modes; `smoke:audio-proof` extended with hash-compare bit-perfect verification where loopback available.
- BIT-PERFECT badge only in exclusive+matched rate; RESAMPLED banner impossible in exclusive mode (invariant).
- Forced open-failure -> Web Audio fallback within 200ms, non-blocking toast, no dropouts.
- audify prebuild missing -> clean settings message; app starts; existing engine unaffected.

---

## PILLAR 4 — Wrapped Live Video Export (DEADLINE: early December)

### 4.1 Architecture

Recorder exists (`eviland-recorder.ts`: captureStream+MediaRecorder, vp9->vp8->webm chain, parallel MediaStreamAudioDestinationNode audio — see FullscreenVisualizer.tsx:736-783). Missing: scripted Wrapped scene, ffmpeg mux, trigger UI.

### 4.2 Files

- `src/components/WrappedLiveExport.tsx` NEW — modal from WrappedView. State machine: idle -> preparing -> recording -> muxing -> done/error. Owns hidden 1080x1920 canvas.
- `src/visualizer/wrapped-scene.ts` NEW (host-only) — choreography. Input: WrappedStats + audio bed (#1 top track). Output: `tick(t, dtMs) -> { config: OperatorConfig, captionLayer: CaptionFrame }`. Beats: 0-3s logo bloom; 3-9s "you played N hours"; 9-15s top-artist montage; 15-22s top-track climax with real audio bed; 22-30s outro card + watermark.
- `electron/video-mux.ts` NEW — ffmpeg-static spawn: `-i input.webm -c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart output.mp4`.
- `electron/main.ts` — IPC `wrapped-live:mux` (reuse saveCaptureBytes structure, ext='mp4' branch).
- `src/components/views/WrappedView.tsx` MODIFY — "Share as video" button.

### 4.3 Mime + perf constraints

- If `isTypeSupported('video/mp4;codecs="avc3.640028,mp4a.40.2"')` -> record mp4 directly (avc3 NOT avc1 — canvas streams can resize). Else webm chain. `MediaRecorder.onerror` mid-take -> rebuild with vp9 webm, re-run scene from t=0 (acceptable for 30s).
- `backgroundThrottling: false` during recording OR a visible offscreen-positioned window; verify 60fps rAF in smoke.
- `timeslice=250ms` bounds memory (Electron MediaRecorder leak is a long-recording problem; irrelevant at 30s but bound anyway).

### 4.4 Acceptance criteria (Pillar 4)

- `npm run smoke:wrapped-live`: 20s clip -> .mp4 exists, yuv420p, moov at front, audio track present.
- `smoke:viz-capture` still passes; ffmpeg per-arch staging (macOS afterPack guard) still passes.
- Share-target playback proof (manual, tracked via release:check pattern). Output <=25MB at 30s (8Mbps video + 192kbps audio budget).

---

## PILLAR 5 — WebGPU Quantum Tier

### 5.1 Architecture

- New `VizMode` `'eviland-quantum'`; branch in Visualizer.tsx dispatch (canvas keyed by mode).
- `src/visualizer/eviland-quantum.ts` NEW (host-only) — `createEvilandWebGpuRenderer(canvas, opts): Promise<QuantumRenderer | null>`; null on: no navigator.gpu, adapter denied, insufficient device.limits, pipeline compile failure. Fallback ladder: quantum -> WebGL2 Eviland -> procedural -> butterchurn.
- MLS-MPM per matsuoka-601/webgpu-ocean (MIT): fixed-point atomicAdd P2G scatter, G2P gather, grid update. Particles: 100k iGPU / 300k dGPU (~24MB SSBO at 80 bytes/particle — under the 128MB guaranteed binding limit; read device.limits NOT adapter.limits — Chrome clamps). Grid: Z-slab-split SSBOs. `featureLevel:'compatibility'` FORBIDDEN (strips storage buffers).
- Audio: frame kick/bass/snare/hat/vocal as uniform buffer; Director still picks archetype. Derived seed `hashSeed(baseCode + '::quantum')` — never base seed verbatim.
- WGSL shaders via vite raw imports from `src/visualizer/eviland-quantum-shaders/`.
- Linux: `--enable-unsafe-webgpu` appended ONLY when the setting is on.

### 5.2 Defensive behavior

- `device.lost` -> one conservative retry at 50k particles -> null-fallback.
- Pipelines precompiled at renderer creation; first frame must not stall.
- SwiftShader detection (adapter.info vendor 'Google Inc.' + description contains 'SwiftShader') -> return null; headless smokes skip cleanly (Electron SwiftShader WebGPU is broken, #38189).

### 5.3 Acceptance criteria (Pillar 5)

- `npm run smoke:eviland-quantum`: skips cleanly without hardware; on hardware 5s run >=45fps at 100k particles.
- device.lost simulation recovers within 250ms; fallback ladder verified with WebGPU forced off.
- Seed goldens (`test:eviland-operators`) untouched. One binary, runtime-tiered.

---

## B. Cross-pillar build sequence

```
[v1.11.1]  Pillar 1 Phase 1 — Eviland Remembers           (3-5 dev-days)
[v1.11.2]  Pillar 4         — Wrapped Live video export   (4-6 dev-days, DECEMBER DEADLINE)
[v1.12.0]  Pillar 3 v1      — WASAPI exclusive (Windows)  (~10-14 dev-days)
[v1.12.x]  Pillar 1 Phase 2 — artist/genre aggregate      (2-3 dev-days)
[v1.13.0]  Pillar 2         — Stem-true sight             (~10-15 dev-days incl. model UX)
[v1.14.0]  Pillar 5         — WebGPU Quantum tier         (~10-15 dev-days)
```

Rationale: P1.1 is pure-TS + tiny DB surface and the headline narrative (cheapest, most differentiated — nobody can claim "remembers your library"). P4 has the December calendar deadline and no dependency on P1. P3 builds the utilityProcess/cache/COOP-COEP scaffolding that P2 reuses. P5 is the biggest flash but least differentiated — ship it once the narrative is established.

Impact: P1>P4>P3>P2>P5. Effort: P1.1 < P4 < P1.2 < P3 < P2 ~ P5. Risk: P1 low (pure JS), P4 medium (share-target mp4 compat), P3 medium-high (native + COOP/COEP fallout), P2 medium (model UX + ORT iGPU bug), P5 medium (device.lost paths).

---

## C. Open questions (Tyler-only) — mirrored in open-questions.md

1. Stem model size/hosting (FP16 ~140MB default vs FP32 ~280MB vs INT8 ~70MB toggle; self-host vs HF hot-link).
2. WASAPI v1 scope: SMTC media-keys/volume ownership now (+~3 days) or v1.1; per-device vs global setting.
3. Memory privacy: purge surfaces beyond Settings; whether DNA-neighbor borrowing is disable-able.
4. Wrapped Live: fixed 30s vs selectable; year+month vs year-only; watermark customization; mute-audio toggle.
5. algoVersion bump policy: strict CI guard script vs judgment-call.
