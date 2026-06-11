# NewAmp post-1.11.0 roadmap — Eviland Remembers + four pillars

**Status:** draft
**Created:** 2026-06-10
**Owner:** Tyler

> **Executor instructions:** write decisions to `notes/newamp-post-1.11-roadmap-context/decisions.md` as you make them. Answer open questions by editing `open-questions.md` and committing. The full architect blueprint (per-pillar file lists, schemas, data flows, acceptance criteria) lives at `notes/newamp-post-1.11-roadmap-context/artifacts/blueprint.md` — read it before any implementation work.

## Goal (one sentence)

Ship "Eviland remembers your library" — the first music visualizer in history with persistent memory of the user's taste — then cash in the supporting pillars (Wrapped Live video before December, WASAPI-exclusive bit-perfect output, stem-true sight, WebGPU Quantum fluid) in impact-per-effort order.

## Why now

- v1.11.0 just shipped the substrate the centerpiece needs: deterministic `seedFor(songId, sectionId, rotationIndex)` looks, 26 distinct archetypes, section fingerprints with cosine return-matching — persistence is a thin, cheap layer on a foundation that exists today.
- Wrapped Live has a hard calendar deadline: it must ship before Spotify Wrapped lands in early December to ride the wave with the "your Wrapped never leaves your PC" counter-message.
- audify 1.10.1 prebuilds now cover Electron 42 (N-API 10) with the WASAPI `HOG_DEVICE` flag confirmed plumbed — the bit-perfect blueprint in `docs/audio-quality.md` is executable without forking anything.

## Approach

Six releases, one pillar each, sequenced so cheap+novel ships first and infrastructure-heavy work amortizes: Pillar 1 Phase 1 (visual memory, pure TS + one DB table) → Pillar 4 (Wrapped Live, extends the existing recorder + new ffmpeg mux) → Pillar 3 (WASAPI exclusive in a utilityProcess, building the native-worker scaffolding) → Pillar 1 Phase 2 (artist/genre aggregates) → Pillar 2 (stem separation, reusing P3's worker/cache patterns) → Pillar 5 (WebGPU MLS-MPM, the flash that lands best after the narrative is established). The single most important tradeoff: visual memory identity is **seed lineage, not stored frames** — plans store seeds + fingerprints + counters and re-derive looks deterministically, which keeps writes tiny (sql.js exports the whole DB on flush) and makes algorithm upgrades survivable via `algoVersion` instead of silently breaking remembered looks.

## Alternatives considered

- **Store rendered look configs (OperatorConfigs) per section:** rejected — heavier rows, breaks on every randomizer change, and contradicts the repo's determinism contract; seeds re-derive everything.
- **ML-embedding visual memory (MemWeaver-style):** rejected for Phase 1 — opaque, expensive, hard to debug; the DNA-cosine neighbor path gives 80% of the "borrowed visual DNA" value with zero new ML.
- **ORT-web/WebGPU in the renderer for stems:** rejected — open Intel-iGPU conv-correctness bug in Electron specifically (#24442); native onnxruntime-node in a utilityProcess with a probe-fixture wasm fallback is the safe shape.
- **Threading WASAPI through the existing transcode pipeline:** rejected — that pipeline is the most-revisited bug surface in the repo (5 open todos, 71 commits on main.ts since May); the exclusive path owns its own decode (WebCodecs → PCM → worker).
- **Building all five pillars in parallel:** rejected — P3's utilityProcess/cache/COOP-COEP scaffolding is P2's prerequisite, and serial releases keep the gate honest.

## Files to touch

- `src/visualizer/eviland-director.ts` — `DirectorOptions.plan`, `loadPlan`/`exportPlan`, lineage-salted `seedFor`, `onSectionLearn` (real-section gate only)
- `src/visualizer/eviland-audio.ts` — surface `sectionFingerprint` on boundary frames
- `src/visualizer/eviland-producer.ts` — same load/observe wiring as Visualizer
- `src/components/Visualizer.tsx` — memory bridge wiring in the eviland branch; later: `eviland-quantum` mode branch
- `src/components/FullscreenVisualizer.tsx` — memory badge overlay
- `electron/library.ts` — `track_visual_memory` table + four methods (clone the `dna_json` pattern at :2665-2691)
- `electron/preload.ts` + `electron/main.ts` — `tracks:visual-memory-*` IPC; later pillars: stems/exclusive/mux IPC
- `src/audio/engine.ts` — `outputMode` state + getter (Pillar 3)
- `src/components/SignalPathBadge.tsx` — BIT-PERFECT state (Pillar 3)
- `src/components/views/SettingsView.tsx` — memory purge row; exclusive-output controls; stem model download; Quantum toggle
- `src/components/views/WrappedView.tsx` — "Share as video" entry (Pillar 4)
- `src/visualizer/eviland-recorder.ts` — mp4/avc3 preference + onerror fallback (Pillar 4)
- `package.json` + `.github/workflows/ci.yml` — new test/smoke entries per pillar; `audify` dep (Pillar 3)
- `packages/eviland-core/sync.mjs` — add `eviland-memory-types.ts` to the mirrored set
- `docs/audio-quality.md` — audify justification + exclusive-mode docs

## Files to create

- `src/visualizer/eviland-memory-types.ts` (mirrored) — versioned `VisualMemoryPlan` schema: sections, fingerprints, seed lineage (rootSeed/ancestors/generation/evolutionLog), counters, `algoVersion`
- `src/visualizer/eviland-memory-bridge.ts` (host-only) — load-or-seed (DNA-neighbor borrow at ≥0.92 cosine), in-memory fingerprint buffer, flush triggers (track-end / 4 new sections / hide), lineage evolution at plays 8/32/96/256, prune-without-descendants
- `src/components/EvilandMemoryBadge.tsx` — "REMEMBERS THIS SONG · gen2 · 17 plays" overlay + reset/borrowed-from popover
- `scripts/eviland-memory-test.mjs` + `scripts/eviland-memory-smoke.mjs`
- Pillar 4: `src/visualizer/wrapped-scene.ts`, `src/components/WrappedLiveExport.tsx`, `electron/video-mux.ts`
- Pillar 3: `electron/wasapi-worker.ts`, `electron/exclusive-output.ts`, `src/audio/exclusive-decoder.ts`, `scripts/audify-prebuild-probe.mjs`
- Pillar 2: `electron/stem-worker.ts`, `electron/stem-service.ts`, `electron/cache-key.ts` (extracted from transcode-cache), `src/visualizer/stem-envelope-source.ts`
- Pillar 5: `src/visualizer/eviland-quantum.ts` + WGSL shader dir

## Implementation sequence

1. **[v1.11.1] Eviland Remembers, Phase 1** (3–5 days) — memory types + bridge + Director injection + DB/IPC + badge. Accept: `test:eviland-memory` green (schema round-trip, lineage math, prune, neighbor-seed never returns identical seed); extended `test:eviland-director` proves `onSectionLearn` never fires on forced rotations; `smoke:eviland-memory` proves restart-recall (first-frame seed equals persisted primary seed); ≤1 DB write per completed track; sync gate + release gate green.
2. **[v1.11.2] Wrapped Live video export** (4–6 days, ship before December) — scripted 20–30s 1080×1920 scene + recorder + ffmpeg mux to H.264/AAC/yuv420p/+faststart. Accept: `smoke:wrapped-live` produces a valid mp4 ≤25MB with audio; mime-fallback (avc3 mp4 → vp9 webm) exercised; share-target playback proof recorded.
3. **[v1.12.0] WASAPI exclusive, Windows v1** (10–14 days) — audify in utilityProcess, WebCodecs decode, dual ring buffers, COOP/COEP gated by setting, per-track rate switching, fallback-to-WebAudio on open failure. Accept: `smoke:wasapi-exclusive` at 44.1/48/96/192k with zero underruns; badge shows BIT-PERFECT only in exclusive+matched; forced open-failure falls back within 200ms; audify-missing degrades cleanly.
4. **[v1.12.x] Eviland Remembers, Phase 2** (2–3 days) — artist/genre aggregate plans (k-means over section fingerprints, artist-familiarity beats DNA-neighbor for seeding).
5. **[v1.13.0] Stem-true sight** (10–15 days) — htdemucs-ft per-stem ONNX in utilityProcess, filesystem envelope cache, `frame.stemEnvelopes` additive bias ("stems refine, FFT decides"), model download UX. Accept: cache hit <50ms on second analyze; probe-failure forces wasm EP and re-keys cache; stems-off behavior byte-identical to today.
6. **[v1.14.0] WebGPU Quantum tier** (10–15 days) — MLS-MPM at 100k/300k particles (webgpu-ocean pattern, MIT), `eviland-quantum` mode, null-fallback ladder, derived `::quantum` seeds. Accept: `smoke:eviland-quantum` skips cleanly without hardware, ≥45fps at 100k on hardware; device.lost retry; seed goldens untouched.

## Risks and unknowns

- sql.js whole-file export amplification — mitigated by track-end-only writes + 800ms debounce; if the library DB outgrows ~50MB, plan the better-sqlite3 hot-table migration (accept for now).
- songId collision: non-library plays all map to `'eviland'` — bridge must no-op memory for null trackIds (mitigate in Phase 1).
- Intel iGPU WebGPU correctness bug in Electron (#24442) — probe fixture + wasm fallback mandatory for stems; same probe informs Quantum tier (mitigate).
- MediaRecorder `isTypeSupported` lies — onerror rebuild-and-rerun fallback is required, not optional (mitigate).
- audify maintainer cadence: prebuilds cover Electron 42 today; pin the version and re-verify before any Electron major bump (accept + guard script).
- `engine.seek` + transcode pipeline is the most-revisited bug surface — Pillar 3 deliberately bypasses it; only optional contact point is extending transcode-cache for FLOAT32 PCM on exotic formats (accept).
- December deadline risk on Pillar 4 — it has no dependency on Pillar 1; reorder to ship it first if Phase 1 slips.
- Git-history research found no prior reverts in the five pillar surfaces, but the Hotdog Deck precedent says check removal history before adding any new UI surface (accept).

## Open questions

- **Stem model size/hosting:** FP16 default (~140MB) vs FP32 (~280MB) vs INT8 toggle; self-host vs hot-link the StemSplitio HF mirror (dead-URL risk)?
- **Exclusive-mode scope:** own OS media keys/volume (SMTC) in v1 (+~3 days) or punt to v1.1? Per-device setting or global?
- **Memory privacy surface:** Settings-only purge, or also per-track right-click "Forget visual memory"? Should neighbor-borrowing be disable-able (it leaks listening relationships across tracks)?
- **Wrapped Live scope:** fixed 30s vs selectable 15/30/60s; year+month modes or year-only; watermark customization; "mute audio bed" toggle for copyright-bot-wary sharers?
- **algoVersion bump policy:** strict CI enforcement (any PR touching ARCHETYPES/TIER_ARCHETYPE_WEIGHTS/TIER_MUTATE_AMOUNT bumps it, guarded by script) or judgment-call?

## Execution notes

<!-- for the executing session -->
