# Eviland — Integration Map

Authoritative file/line index for the Eviland renderer, reactor, audio engine taps, React driver, fullscreen UI, and Electron host. Every code anchor is quoted verbatim from the current tree (NewAmp main @ commit `5961e0d`, release 1.7.1). Do not edit blind — paste these snippets into `Edit.old_string` so changes land in the exact region.

Repo: `B:\projects\claude\newamp` · ES modules (`import`/`export`) · TypeScript · Windows.

---

## 1. Renderer — `src/visualizer/eviland.ts`

Full file ~1269 lines. Exports two values, three types, one function.

### 1.1 Public exports (the @eviland/core boundary)

```ts
// src/visualizer/eviland.ts:35-53
import type { EvilandFrame } from './eviland-audio';

export interface EvilandPalette {
  accent: [number, number, number]; // each channel 0..1
  dark: [number, number, number];
  light: [number, number, number];
  bg: [number, number, number];
}

export interface EvilandRenderer {
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  render(frame: EvilandFrame, palette: EvilandPalette, dtMs: number): void;
  dispose(): void;
}

export interface EvilandOptions {
  smoke?: boolean;
  quality?: 'high' | 'medium' | 'low';
}
```

Factory signature (line 578):

```ts
// src/visualizer/eviland.ts:578-581
export function createEvilandRenderer(
  canvas: HTMLCanvasElement,
  options: EvilandOptions = {},
): EvilandRenderer | null {
```

Returns `null` when WebGL2 or `EXT_color_buffer_float` is missing (lines 590-598). NewAmp falls back to `paintMilkdropFallback` → butterchurn iframe in `Visualizer.tsx`.

### 1.2 Quality tiers and tunables (lines 606-610)

```ts
// src/visualizer/eviland.ts:606-610
const quality: 'high' | 'medium' | 'low' = options.quality ?? 'high';
const fieldScale = quality === 'high' ? 1.0 : quality === 'medium' ? 0.75 : 0.5;
const bloomLevels = quality === 'high' ? 3 : quality === 'medium' ? 2 : 0;
const aberrationOn = quality !== 'low';
const maxEmitters = quality === 'high' ? 32 : quality === 'medium' ? 20 : 10;
```

### 1.3 Cached field uniforms (lines 750-765)

```ts
// src/visualizer/eviland.ts:749-765
// ---- Cached uniform locations (avoid getUniformLocation per frame) ----
const fieldUni = {
  prev: gl.getUniformLocation(fieldProg, 'u_prev'),
  decay: gl.getUniformLocation(fieldProg, 'u_decay'),
  warpAmp: gl.getUniformLocation(fieldProg, 'u_warpAmp'),
  warpScale: gl.getUniformLocation(fieldProg, 'u_warpScale'),
  flow: gl.getUniformLocation(fieldProg, 'u_flow'),
  time: gl.getUniformLocation(fieldProg, 'u_time'),
  novelty: gl.getUniformLocation(fieldProg, 'u_novelty'),
  sectionSeed: gl.getUniformLocation(fieldProg, 'u_sectionSeed'),
  zoom: gl.getUniformLocation(fieldProg, 'u_zoom'),
  rotate: gl.getUniformLocation(fieldProg, 'u_rotate'),
  hueCycle: gl.getUniformLocation(fieldProg, 'u_hueCycle'),
  swirl: gl.getUniformLocation(fieldProg, 'u_swirl'),
  mirror: gl.getUniformLocation(fieldProg, 'u_mirror'),
  mirrorMix: gl.getUniformLocation(fieldProg, 'u_mirrorMix'),
};
```

(`spectrumUni`, `terrainUni`, `thresholdUni`, `downUni`, `upUni`, `postUni` follow on lines 766-802.)

### 1.4 Emitter pool — `spawn()` signature + kinds (lines 553-572, 809-839)

Internal `Emitter` shape:

```ts
// src/visualizer/eviland.ts:553-572
interface Emitter {
  x: number;
  y: number; // NDC (-1..+1)
  baseRadius: number;
  age: number; // seconds
  lifespan: number; // seconds (0 disables)
  r: number; g: number; b: number;
  aspectAdjust: number;
  kind: number; // 0..4 — see EMITTER_FRAG
  jitter: number;
  thickness: number;
  intensity: number;
}

function makeEmitter(): Emitter { /* ... */ }
```

`spawn` — closes over the emitter pool. Note the parameter ordering: `r, g, b` come **before** `life`, then `thickness` and `intensity`. Several call sites in `routeOnsets` are easy to misread.

```ts
// src/visualizer/eviland.ts:809
function spawn(kind: number, x: number, y: number, radius: number, r: number, g: number, b: number, life: number, thickness: number, intensity: number): void {
```

Emitter kinds (string contract is in shader `EMITTER_FRAG` lines 232-280):

| kind | name    | trigger          | shape                                |
|------|---------|------------------|--------------------------------------|
| 0    | ring    | kick / bass / default | bright annulus expanding with age |
| 1    | burst   | snare            | hot core + 3-spike radial star       |
| 2    | sparkle | hat              | pinpoint + cardinal cross streaks    |
| 3    | blob    | vocal / section flash | tight gaussian orb              |
| 4    | core    | kick punch / beat-anticipation | hard disc + rim         |

Onset routing table — `routeOnsets(frame, palette)` lines 877-927. Section-change full-field flash uses kind 3 at center (line 1037).

### 1.5 Where `bandsTex` (24×1 R32F) is created and uploaded

```ts
// src/visualizer/eviland.ts:655-664
const bandsTex = gl.createTexture();
if (!bandsTex) return null;
gl.bindTexture(gl.TEXTURE_2D, bandsTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 24, 1, 0, gl.RED, gl.FLOAT, new Float32Array(24));
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
// Scratch buffer for per-frame band uploads (avoid per-frame allocations).
const bandsScratch = new Float32Array(24);
```

Per-frame upload sits inside Pass 3b (spectrum) — lines 1134-1142:

```ts
// src/visualizer/eviland.ts:1134-1142
{
  const bands = frame.bands;
  const n = Math.min(24, bands.length);
  for (let i = 0; i < n; i++) bandsScratch[i] = bands[i]!;
  for (let i = n; i < 24; i++) bandsScratch[i] = 0;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, bandsTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 24, 1, gl.RED, gl.FLOAT, bandsScratch);
```

### 1.6 `render()` — ordered passes (entry at line 1015)

Pass order, with file ranges:

1. **Section memory + seed update** — 1023-1042 (sets `sectionSeed`, optional center flash via kind 3 emitter).
2. **`routeOnsets`** — 1045 (translates `frame.onsets[]` → emitter pool, plus beat-anticipation kind 4).
3. **CPU envelopes** — 1047-1052 (`bloomEnv`, `aberrEnv`).
4. **`packEmitters` / `advanceEmitters`** — 1055-1056.
5. **PASS 1 — Feedback field warp** (writes `fieldB` from `fieldA`) — 1058-1106.
6. **PASS 2 — Terrain (bass horizon)** additive into `fieldB` — 1108-1117.
7. **PASS 3 — Emitter splats** (instanced quads, additive) — 1119-1128. Note `unbindEmitterDivisors()` is load-bearing (see warning in code 992-1013).
8. **PASS 3b — Radial spectrum sun** (uploads `bandsTex`, additive) — 1130-1165.
9. **Ping-pong swap** `fieldA ↔ fieldB` — 1168-1170.
10. **PASS 4 — Dual-Kawase bloom pyramid** — 1172-1210.
11. **PASS 5 — Final composite to backbuffer (POST)** — 1212-1241.

### 1.7 The hardcoded warp params (THE EXTRACTION TARGET)

Quoted verbatim with anchor lines so Edit can replace exactly. This is the contiguous block that an extracted "warp operator engine" (MilkDrop equations, randomizer, director) must own. Currently they are inline literal formulas of `frame.*`.

**Field decay + curl** (PASS 1 prelude, lines 1067-1077):

```ts
    // Decay: SHORT trails so drawn shapes stay crisp instead of stacking into a
    // featureless haze (the "smoke cloud"). The geometric zoom/rotate motion
    // carries the look; trails only need to last a few frames, not seconds.
    const decay = 0.84 + 0.05 * (1 - frame.flatness) - 0.02 * frame.crest;
    gl.uniform1f(fieldUni.decay, Math.max(0.80, Math.min(0.91, decay)));
    // Curl turbulence is the #1 source of "smoke" — keep it near zero so field
    // motion is clean geometric zoom/rotate/kaleidoscope, not fluid warp.
    gl.uniform1f(fieldUni.warpAmp, 0.0003 + frame.bass * 0.0010);
    gl.uniform1f(fieldUni.warpScale, 2.5 + frame.width * 1.8);
    gl.uniform2f(fieldUni.flow, frame.pan * 0.0008 + 0.00012, -0.00018);
    gl.uniform1f(fieldUni.time, time);
    gl.uniform1f(fieldUni.novelty, frame.novelty);
    gl.uniform1f(fieldUni.sectionSeed, sectionSeed);
```

**MilkDrop motion: zoom / rotate / hueCycle / swirl** (lines 1080-1096):

```ts
    // MilkDrop-style motion — bolder than the previous tuning:
    //  • zoom: stronger base tunnel + kick punches in deeper.
    //  • rotate: always drifting; energy + beatPhase accelerate it.
    //  • hue cycle: visibly sweeps the palette (~2x previous range).
    //  • swirl: pronounced edge spin.
    // Lower base zoom so constant inward pull doesn't pile feedback energy into
    // a permanent bright focal blob at centre; kick/bass still punch the tunnel.
    const zoom = 0.0018 + frame.kick * 0.038 + frame.bass * 0.012;
    const rotateBase = 0.0028 * (sectionSeed * 0.5 + 0.5); // section-stable drift
    const rotateSign = ((Math.floor(sectionSeed * 7) % 2) === 0) ? 1 : -1;
    const rotate = rotateSign * (rotateBase + frame.energy * 0.0090 + frame.beatPhase * 0.0014);
    const hueCycle = (0.0028 + frame.centroid * 0.0090 + frame.energy * 0.0055) * (sectionSeed < 0.5 ? -1 : 1);
    const swirl = 0.012 + frame.width * 0.030 + frame.novelty * 0.020;
    gl.uniform1f(fieldUni.zoom, zoom);
    gl.uniform1f(fieldUni.rotate, rotate);
    gl.uniform1f(fieldUni.hueCycle, hueCycle);
    gl.uniform1f(fieldUni.swirl, swirl);
```

**Kaleidoscope mirror count + mix** (lines 1097-1105):

```ts
    // Kaleidoscope: the single most "MilkDrop" trait. ALWAYS on (no 0 entries)
    // and strongly mixed so the mirror symmetry actually reads — previously it
    // was off ~1/3 of sections and too faint to see even when active.
    const mirrorCounts = [4, 6, 8, 5, 6, 12];
    const mirrorIdx = Math.floor(sectionSeed * 13) % mirrorCounts.length;
    const mirrorN = mirrorCounts[mirrorIdx]!;
    const mirrorMix = Math.min(0.96, 0.70 + frame.energy * 0.26);
    gl.uniform1f(fieldUni.mirror, mirrorN);
    gl.uniform1f(fieldUni.mirrorMix, mirrorMix);
    drawFullscreen();
```

These 7 named variables (`decay`, `warpAmp`, `warpScale`/`flow` (vec2), `zoom`, `rotate`, `hueCycle`, `swirl`, `mirrorN`, `mirrorMix`) plus `time`, `novelty`, `sectionSeed` are the operator-engine surface. A clean refactor: replace this block with `const ops = directorOrPreset.evaluate(frame, time, sectionSeed); applyOps(fieldUni, ops);` where `ops` is a plain object matching the uniform set.

Also load-bearing literals elsewhere:
- Bloom threshold `0.18` — line 1183.
- Bloom intensity scale `0.30 + bloomEnv * 0.45` (gated by `bloomSrc`) — line 1225.
- Aberration ceiling `aberrEnv * 0.9` — line 1226.
- Saturation floor `Math.max(0.35, 1 - frame.flatness * 0.55)` — line 1227.
- Post hueShift (centroid tilt) — lines 1234-1240.

### 1.8 `dispose()` — line 1244

Standard teardown; deletes all programs, buffers, FBOs, texture, then calls `WEBGL_lose_context.loseContext()`. Safe to call multiple times only if the React effect cleanup runs once per mount (current React-StrictMode hardening implicit).

---

## 2. Reactor — `src/visualizer/eviland-audio.ts`

Pure TS, zero deps, allocation-free hot path. 429 lines.

### 2.1 Public exports (the second half of the @eviland/core boundary)

```ts
// src/visualizer/eviland-audio.ts:19-26
export type VoiceGroup = 'kick' | 'bass' | 'snare' | 'hat' | 'vocal' | 'other';

export interface EvilandOnset {
  band: number; // 0..BANDS-1
  group: VoiceGroup;
  intensity: number; // 0..1 (how far over threshold)
  sharpness: number; // 0..1 (attack steepness)
}
```

```ts
// src/visualizer/eviland-audio.ts:28-51
export interface EvilandFrame {
  bands: Float32Array; // BANDS smoothed band magnitudes, 0..1
  onsets: EvilandOnset[]; // onsets detected THIS frame
  kick: number; bass: number; snare: number; hat: number; vocal: number;
  energy: number; centroid: number; flatness: number; crest: number; rolloff: number;
  width: number; pan: number;
  beatPhase: number; beatConfidence: number; bpm: number;
  novelty: number;
  sectionId: number; sectionChanged: boolean; sectionReturn: number;
}
```

```ts
// src/visualizer/eviland-audio.ts:53-58
export interface EvilandReactorConfig {
  sampleRate: number;
  fftSize: number;
  binCount: number;
}

export const EVILAND_BANDS = 24;
```

```ts
// src/visualizer/eviland-audio.ts:100-109
export interface EvilandReactor {
  analyze(
    freq: Uint8Array,
    onsetFreq: Uint8Array,
    leftFreq: Uint8Array,
    rightFreq: Uint8Array,
    dtMs: number,
    nowMs: number,
  ): EvilandFrame;
}

export function createEvilandReactor(config: EvilandReactorConfig): EvilandReactor { /* ... */ }
```

`EvilandFrame` is shallow + transferable (Float32Array bands, plain numbers, an array of plain-object onsets). Two caveats for IPC / cross-window posting:
- `frame.bands` is reused per call (the same `Float32Array` reference). Anything sent across a `postMessage` needs a copy or a structuredClone before the next frame.
- `frame.onsets` reuses pooled objects (line 256, `onsetPool[]`). Same copy-before-send rule.

Group → band ranges (lines 67-82):

```ts
const GROUP_BANDS: Record<Exclude<VoiceGroup, 'other'>, [number, number]> = {
  kick: [0, 2], bass: [2, 5], snare: [5, 9], vocal: [10, 14], hat: [19, 23],
};
```

---

## 3. Audio engine taps — `src/audio/engine.ts`

Class `AudioEngine` (~949 lines). Single `AudioContext`, two-deck `<audio>` graph with crossfade, EQ, ReplayGain, limiter, three analysers (visualizer + onset + stereo splitter pair).

### 3.1 Graph construction (`ensureGraph`, lines 163-297)

`AudioContext` is built lazily on first `play()`:

```ts
// src/audio/engine.ts:166-177
const contextOptions: AudioContextOptions = { latencyHint: 'playback' };
if (this.preferredSampleRate) {
  contextOptions.sampleRate = this.preferredSampleRate;
}
let ctx: AudioContext;
try {
  ctx = new AudioContext(contextOptions);
} catch {
  ctx = new AudioContext({ latencyHint: 'playback' });
}
```

Four analysers (lines 196-223):

```ts
const analyser = ctx.createAnalyser();
analyser.fftSize = DEFAULT_FFT_SIZE;          // 2048
analyser.minDecibels = -86;
analyser.maxDecibels = -10;
analyser.smoothingTimeConstant = 0.24;        // visualizer-smoothed
const onsetAnalyser = ctx.createAnalyser();   // unsmoothed (smoothingTimeConstant = 0)
const stereoSplitter = ctx.createChannelSplitter(2);
const leftAnalyser = ctx.createAnalyser();
const rightAnalyser = ctx.createAnalyser();
for (const a of [leftAnalyser, rightAnalyser]) {
  a.fftSize = DEFAULT_FFT_SIZE; a.minDecibels = -86; a.maxDecibels = -10; a.smoothingTimeConstant = 0;
}
```

Routing (lines 256-272): the three analyser subtrees parallel-tap off `replayGain` and drain into a 0-gain `silentSink` so Chromium's audio-graph optimizer never culls them. **Critical for live-input**: any new mic/line-in source must reach `replayGain` so all four taps fire.

### 3.2 Public tap signatures (lines 862-925) — feed these to the reactor

```ts
// src/audio/engine.ts:862-869
getFreqData(buf: Uint8Array<ArrayBuffer>): void {
  if (!this.graph) { buf.fill(0); return; }
  this.graph.analyser.getByteFrequencyData(buf);
}

// src/audio/engine.ts:870-876
getTimeData(buf: Uint8Array<ArrayBuffer>): void {
  if (!this.graph) { buf.fill(128); return; }
  this.graph.analyser.getByteTimeDomainData(buf);
}

// src/audio/engine.ts:883-889
getOnsetFreqData(buf: Uint8Array<ArrayBuffer>): void {
  if (!this.graph) { buf.fill(0); return; }
  this.graph.onsetAnalyser.getByteFrequencyData(buf);
}

// src/audio/engine.ts:892-906
getLeftFreqData(buf: Uint8Array<ArrayBuffer>): void { /* leftAnalyser.getByteFrequencyData */ }
getRightFreqData(buf: Uint8Array<ArrayBuffer>): void { /* rightAnalyser.getByteFrequencyData */ }

// src/audio/engine.ts:914-920
getOnsetTimeData(buf: Uint8Array<ArrayBuffer>): void {
  if (!this.graph) { buf.fill(128); return; }
  this.graph.onsetAnalyser.getByteTimeDomainData(buf);
}

// src/audio/engine.ts:922-925
getSampleRate(): number { return this.graph?.ctx.sampleRate ?? 48000; }
// also: get frequencyBinCount(), get fftSize(), get ctx, get context, get visualizerNode
```

There is **no** time-domain tap for the left/right analyser pair, nor a public per-channel time-domain method. To add a "bright waveform layer" the cheap path is to read `getOnsetTimeData` (snappy mono); a true stereo waveform needs new `getLeftTimeData` / `getRightTimeData` methods that mirror lines 892-906 against `leftAnalyser` / `rightAnalyser`.

### 3.3 Live mic / line-in insertion point

To swap the source to `navigator.mediaDevices.getUserMedia({ audio: ... })`, build a `MediaStreamAudioSourceNode` and connect it to `inputGain` (line 178 → 233 chain) **in parallel** with the deck sources. The decks all run through `deck.gain → inputGain`, so a `liveGain` node connected the same way (with a mute crossfade to the deck path) keeps the EQ/limiter/all-four-analyser flow identical.

Electron permission note: `getUserMedia` from a custom protocol (`newamp-app://`) needs an explicit allow on the `session.setPermissionRequestHandler` — there is no current handler for `media`. See electron/main.ts §5.

---

## 4. React driver — `src/components/Visualizer.tsx` + `src/components/FullscreenVisualizer.tsx`

### 4.1 `Visualizer.tsx` — the Eviland branch (lines 261-332)

`VizMode` union — eviland is one of 27 (line 16-42). `'eviland'` is listed at line 36.

The Eviland branch:

```tsx
// src/components/Visualizer.tsx:261-332
if (mode === 'eviland') {
  const smoke = Boolean((window as Window & { __newampSmoke?: unknown }).__newampSmoke);
  const evilandQuality: 'high' | 'medium' | 'low' =
    performance === 'low' ? 'low' : isFullscreen ? 'high' : 'medium';
  const canPaint = createFrameGate(canvasRef, frameIntervalMs);
  const baseDpr = Math.min(window.devicePixelRatio || 1, dprCap);
  let raf = 0;
  const renderer = createEvilandRenderer(canvas, { quality: evilandQuality, smoke });

  if (!renderer) {
    const fb = (now: number) => {
      if (canPaint(now)) paintMilkdropFallback(canvas, engine);
      raf = requestAnimationFrame(fb);
    };
    raf = requestAnimationFrame(fb);
    return () => cancelAnimationFrame(raf);
  }

  const binCount = engine.frequencyBinCount;
  const freq = new Uint8Array(new ArrayBuffer(binCount));
  const onsetFreq = new Uint8Array(new ArrayBuffer(binCount));
  const leftFreq = new Uint8Array(new ArrayBuffer(binCount));
  const rightFreq = new Uint8Array(new ArrayBuffer(binCount));
  const reactor = createEvilandReactor({
    sampleRate: engine.getSampleRate(),
    fftSize: engine.fftSize,
    binCount,
  });
  let lastNow = 0;
  if (engine.ctx.state === 'suspended') void engine.ctx.resume().catch(() => {});

  // Hoist the palette out of the rAF loop. getComputedStyle forces a style
  // recalc; calling it 4x per frame + allocating 4 fresh rgb arrays was
  // burning real CPU. The canvas key includes palette/mode/etc so a theme
  // change remounts this effect and rebuilds the palette — correct.
  const palette = {
    accent: parseRgbVec(getCssVar('--accent')),
    dark: parseRgbVec(getCssVar('--accent-dim') || getCssVar('--accent')),
    light: parseRgbVec(getCssVar('--ink') || '#ffffff'),
    bg: parseRgbVec(getCssVar('--bg') || '#05060a'),
  };

  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (!canPaint(now)) return;
    const node = canvasRef.current;
    if (node) {
      const cssW = node.clientWidth || 100;
      const cssH = node.clientHeight || 100;
      const fit = Math.min(1, Math.sqrt(maxPixels / Math.max(1, cssW * baseDpr * cssH * baseDpr)));
      renderer.resize(cssW, cssH, baseDpr * fit);
    }
    engine.getFreqData(freq);
    engine.getOnsetFreqData(onsetFreq);
    engine.getLeftFreqData(leftFreq);
    engine.getRightFreqData(rightFreq);
    const dtMs = lastNow ? now - lastNow : 16.7;
    const evFrame = reactor.analyze(freq, onsetFreq, leftFreq, rightFreq, dtMs, now);
    lastNow = now;
    renderer.render(evFrame, palette, dtMs);
  };
  raf = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(raf);
    renderer.dispose();
  };
}
```

Key facts:
- **Palette source = CSS variables** (`--accent`, `--accent-dim`, `--ink`, `--bg`) read once at effect mount via `getCssVar` (line 1785) → `parseRgbVec` (line 1789). To make palette dynamic (randomizer / director / preset), either remount the effect on palette change (current pattern for other modes via `key={mode-palette}` upstream) or hoist palette into a ref that the rAF loop reads each frame.
- **rAF loop** is a single closure per mount. Frame gate (`createFrameGate`, line 98) skips paints when hidden / disconnected / 0-size / below `frameIntervalMs`.
- **No emit hook**: nothing fires when an onset is detected on the React side — onsets exist only inside the renderer's `routeOnsets`. Adding a director or recorder needs either a callback parameter to `render()` or a parallel `reactor.analyze` consumer.
- **No `key` on the canvas tied to preset**: effect cleanup relies on React tearing down the parent on `mode` change. Fine for now but a "lock seed" feature can simply close over a `seedRef`.

Smoke-mode handle (used by capture/smoke scripts) — line 266 reads `window.__newampSmoke`. The smoke flag flows into `preserveDrawingBuffer: smoke` inside `createEvilandRenderer` (line 587).

### 4.2 `FullscreenVisualizer.tsx` — PRESETS, state, control surface

The PRESETS registry (lines 21-48):

```tsx
const PRESETS = [
  { id: 'butterchurn', label: 'Milkdrop', group: 'milkdrop' },
  { id: 'eviland', label: 'Eviland', group: 'gpu' },
  { id: 'kaleido-bloom', label: 'Kaleido Bloom', group: 'crazy' },
  { id: 'liquid-aurora-storm', label: 'Aurora Storm', group: 'crazy' },
  { id: 'fractal-pulse', label: 'Fractal Pulse', group: 'crazy' },
  { id: 'starfield-warp', label: 'Starfield Warp', group: 'crazy' },
  { id: 'spectral-tunnel', label: 'Spectral Tunnel', group: 'crazy' },
  { id: 'particle-flow', label: 'Particle Flow', group: 'gpu' },
  // ... reactive / classic / art entries
  { id: 'album-breathe', label: 'Album Breathe', group: 'art' },
] as const satisfies ReadonlyArray<{ id: VisualizerPreset; label: string; group: PresetGroup }>;
```

`PresetGroup` union (line 50) plus `PRESET_GROUPS` header list (51-58) drive the popover layout.

**Preset persistence** is settings-driven, not localStorage. From `src/store/usePlayerStore.ts`:

```ts
// src/store/usePlayerStore.ts:95
vizPreset: AppSettings['visualizerPreset'];
// src/store/usePlayerStore.ts:778-783
setVizPreset: (name) => {
  set({ vizPreset: name });
  api.setSetting('visualizerPreset', name)
    .then((settings) => set({ settings, vizPreset: settings.visualizerPreset }))
```

So new presets need: (1) entry in `VisualizerPreset` (`shared/types.ts:867`), (2) entry in `PRESETS` array, (3) optional Auto-VJ pool entries (`AUTO_VJ_BALANCED` line 84, `AUTO_VJ_LOW` line 110).

**Control-surface layout** lives in `FullscreenVisualizer.tsx`. The relevant insertion points for new viz controls:

| feature       | natural home                                           | line(s) |
|---------------|--------------------------------------------------------|---------|
| randomize seed | new button in toolbar between Prev/Preset/Next OR a `viz-setting-row` in Settings popover after Reactivity | toolbar 692-722; settings rows 845-944 |
| lock-seed     | toggle row in Settings popover (mirror Album-art row 890-900) | 845-944 |
| live-input toggle | new `viz-setting-row` near "Native fullscreen" 917-927; the IPC for permission goes in `electron/main.ts` | 845-944 |
| record (video) | already present — `toggleRecord` line 593, button row 965-973. Currently MediaRecorder→WebM via `canvas.captureStream(30)`. Drop in `ffmpeg-static` (already in deps) for proper MP4. | 593-627 / 965-973 |
| director toggle | mirror "Auto-VJ" row 902-915 | 902-915 |
| pop-out / detach window | new toolbar button + new `winctl.detachVisualizer()` IPC | toolbar; preload §5.2 |

The settings popover is the most stable insertion point — it already groups toggles with consistent styling (`viz-setting-row` / `viz-setting-label`). Each new control needs: (a) state + localStorage key (pattern: `VIZ_*_KEY` constants 62-68), (b) loader function (pattern: `loadStoredBoolean` 124-130), (c) toggle function, (d) row JSX.

**Keyboard shortcut handler** is lines 437-484 — currently consumes Q L A P R V F H ? Esc and arrows. Free letters for new actions: B, C, D, E, G, I, J, K, M, N, O, S, T, U, W, X, Y, Z (avoid F=fullscreen, R=reactivity, L=lite, V=auto-VJ).

**Pop-out window** plumbing — `winctl` is exposed via preload (line 354-357 of `electron/preload.ts`) and only has `isFullscreen` / `setFullscreen` today. A detached visualizer window will need a new IPC verb (e.g. `win:open-visualizer-popout`) plus a new BrowserWindow created in `electron/main.ts` (see §5.1). The renderer side can simply navigate the new window to a route that mounts only `<Visualizer mode="eviland" />` without library chrome.

### 4.3 Other helpers

- `parseRgbVec(color)` — accepts `#rrggbb` only; falls back to `[0.22, 1, 0.08]` (lines 1789-1797). Hex-only is fragile if CSS vars ever become `hsl()` or `rgb()`. Future audit before changing themes.
- `getCssVar(name)` — line 1785, defaults to `#39ff14`.
- `paintMilkdropFallback(canvas, engine)` — 2D canvas fallback (line 1601) used when WebGL2/Eviland is unavailable.
- `createAudioFeatureAnalyzer({ sampleRate, fftSize })` — line 1692. Used by every NON-Eviland mode. Returns `(freq, wave, onsetFreq) => AudioFeatures`. Independent of the Eviland reactor.

---

## 5. Electron host — `electron/main.ts`, `electron/preload.ts`

### 5.1 `BrowserWindow` patterns

Main window factory (lines 400-486):

```ts
// electron/main.ts:400-420
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 640,
    show: false,
    frame: false, titleBarStyle: 'hidden', transparent: true,
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: !smokeMode,
    },
  });
  attachWindowDiagnostics(win, 'main');
  attachExternalLinkHandler(win);
  // ...
```

A second BrowserWindow already exists (startup splash, lines 488-525) — same `preload.js`-less, `transparent: true`, `frame: false`, `alwaysOnTop: true`, `skipTaskbar: true` recipe. A detached visualizer window should reuse:
- The `preload: join(__dirname, 'preload.js')` (so the React app inside the popout has full `window.api` / `window.winctl`).
- `frame: false`, `backgroundColor: '#000'`, `autoHideMenuBar: true`.
- Loader pattern: same `isDev ? loadURL('http://localhost:5173/visualizer.html') : loadURL('newamp-app://app/visualizer.html')` style as line 464-470.
- A `tabWindows` style `Set<BrowserWindow>` already exists (line 376) — model the popout the same way for cleanup.

`backgroundThrottling: !smokeMode` is important: the detached window MUST set `backgroundThrottling: false` if the user pushes it to a second monitor and gives focus back to the main player; otherwise rAF rate halves.

### 5.2 IPC patterns

Every IPC verb uses `ipcMain.handle(name, ...)` + `ipcRenderer.invoke(name, ...)`. The window-control surface (`win:*`) is already established:

```ts
// electron/main.ts:1524-1527
ipcMain.handle('win:set-fullscreen', (_e, on: boolean) => {
  mainWin?.setFullScreen(!!on);
});
ipcMain.handle('win:is-fullscreen', () => mainWin?.isFullScreen() ?? false);
```

Preload bridge (`electron/preload.ts:354-357`):

```ts
contextBridge.exposeInMainWorld('winctl', {
  // ...
  setFullscreen: (on: boolean) => ipcRenderer.invoke('win:set-fullscreen', on),
});
```

Capture verbs (PNG still + WebM clip already work via main):

```ts
// electron/preload.ts:137-142
captureVisualizerPng: (rect?: { x; y; width; height }) =>
  ipcRenderer.invoke('media:capture-page', rect) as Promise<string | null>,
copyPngToClipboard: (dataUrl: string) =>
  ipcRenderer.invoke('media:copy-png', dataUrl) as Promise<boolean>,
saveCaptureBytes: (payload: { base64; defaultName; filterName; ext }) =>
  ipcRenderer.invoke('media:save-capture', payload) as Promise<string | null>,
```

For a **detached visualizer popout** + **live-input permission** the additions should follow the exact same shape:
- Add `ipcMain.handle('win:open-visualizer-popout', ...)` near line 1527 in main.ts.
- Add `ipcMain.handle('win:close-visualizer-popout', ...)` next to it.
- Expose them on `winctl` in preload.ts (line 354 block).
- For live-input: register `session.defaultSession.setPermissionRequestHandler` in `electron/main.ts` (no existing handler — `grep` returns zero hits). Whitelist `media` for the local protocol origin only.

---

## 6. Verify / smoke scripts

- `scripts/eviland-smoke.mjs` — esbuild-bundles `eviland.ts` + `eviland-audio.ts` into a hidden Electron BrowserWindow, drives 30 silent frames then 90 loud beat-driven frames, asserts: renderer non-null, lit-pixel count rises, ≥5 onsets, ≥2 distinct groups. Run via `npm` script or `node scripts/eviland-smoke.mjs` (requires display + WebGL2; local + per-OS release legs).
- `scripts/eviland-capture.mjs` — same bundling path; runs 200 synthronous frames with a panning stereo image, dumps `tmp/eviland-capture.png` (800×600) and `tmp/eviland-capture-small.png` (480×360). Use this to confirm visuals after edits.
- `npm run typecheck` — `tsc` over the full tree; the renderer's strict-null narrowing (lines 628-635) and `Uint8Array<ArrayBuffer>` tap types depend on this passing.

---

## 7. `studio/` and `packages/` directories — what they currently are

- `packages/` (B:\projects\claude\newamp\packages) — **empty**. Clean slot for `@eviland/core`.
- `studio/` (B:\projects\claude\newamp\studio) — **NOT** an "Eviland Studio" yet. Currently a design workspace:
  - `studio/designs.db` (45 KB SQLite) + `studio/designs/*.html` (two saved design files).
  - `studio/exports/` and `studio/renders/` — empty.
  - `studio/tmp-render/` — empty.
  - This was used for a player-skin / icon design pipeline. Repurposing the dir name for "Eviland Studio" risks colliding with whatever loads `designs.db` — recommend a new top-level `eviland-studio/` directory and a separate `apps/eviland-studio/` if you want monorepo shape. Confirm with `grep -r "studio/designs" src/ electron/` before reusing the path.

---

## 8. Quick edit-surface summary (the smallest moves)

1. **Extract `@eviland/core`** to `packages/eviland-core/` — copy `src/visualizer/eviland.ts` + `eviland-audio.ts` verbatim (they already have zero internal NewAmp imports). The renderer's only external import is `import type { EvilandFrame } from './eviland-audio';` so the package is self-contained.
2. **Operator engine** — replace lines 1067-1105 of `eviland.ts` with a `directorOrPreset.evaluate(frame, time, sectionSeed)` call. The output object matches the existing variable names verbatim so the `gl.uniform1f` calls below stay byte-for-byte identical.
3. **Randomizer + lock-seed** — needs a `seedRef` in `Visualizer.tsx`'s Eviland branch (lines 261-332) closed over a settings popover toggle. Cheapest implementation: seed the `sectionSeeds` array on mount + freeze `frame.sectionChanged` in a wrapper reactor.
4. **Bright reactive waveform layer** — new pass between PASS 3b and the bloom pyramid in `render()`. Requires a new tap `engine.getOnsetTimeData()` already exists (line 914) — feed bytes into a new `WAVEFORM_FRAG` program drawn additive into `fieldB` BEFORE the ping-pong swap.
5. **Live mic/line-in** — new `MediaStreamAudioSourceNode` connected at `inputGain` (engine.ts line 178), plus `session.setPermissionRequestHandler` in `electron/main.ts`, plus settings UI toggle in `FullscreenVisualizer.tsx`.
6. **Detached visualizer window** — new IPC `win:open-visualizer-popout` in `electron/main.ts` near line 1527, new `BrowserWindow` mirror of `createWindow()` lines 400-486 (transparent: false, frame: false, autoHideMenuBar: true, backgroundThrottling: false, same preload), new route in renderer that mounts only `<Visualizer mode={preset} />`.
7. **Video recording (MP4)** — `toggleRecord` in `FullscreenVisualizer.tsx:593-627` currently writes WebM via MediaRecorder. `ffmpeg-static` is already a dependency. Pipe the WebM chunks to `ffmpeg -i pipe:0 -c:v libx264 -pix_fmt yuv420p out.mp4` from main process via a new `media:record-clip-finalize` IPC.

---

## 9. Proof plan (verifier instructions)

- `npm run typecheck` after any TS change.
- `node scripts/eviland-smoke.mjs` — must keep printing `[eviland-smoke] PASS` with `groups.length >= 2`.
- `node scripts/eviland-capture.mjs` then visually open `tmp/eviland-capture.png` — the previous "gold/cream smoke" regression is the easiest visual failure mode; a healthy frame shows distinct coloured emitter shapes against a near-black background, NOT a uniform cream cloud.
- For the operator-engine refactor: the smoke PNG before/after must be visibly different ONLY if the refactor preserves identical formulas (it should be identical).
- For the detached window: open the popout, drag to a second monitor, confirm 60fps via Chromium devtools performance recorder (or just check `requestAnimationFrame` deltas in the renderer's existing dt logging).
