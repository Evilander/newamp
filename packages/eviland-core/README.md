# @eviland/core

**An instrument-aware, self-directing generative music visual engine.**
Embeddable like [butterchurn](https://github.com/jberg/butterchurn) — but it
*listens*.

Eviland is the visual engine behind [NewAmp](https://github.com/evilander/newamp).
Zero dependencies, framework-agnostic, WebGL2.

## What makes it different

- **Causal, per-instrument reactivity.** A 24-band mel spectral-flux onset
  detector classifies *which instrument* fired (kick / snare / hat / vocal /
  bass) and gives each its own visual event — not a bass/mid/treble average.
- **Generative, not preset packs.** Looks are *data* (`OperatorConfig`): a base
  value plus audio-feature bindings per visual channel. The randomizer mints
  endless musically-coherent looks, each reproducible from a short shareable
  seed (`K7Q2-9XMF`).
- **A Director that conducts itself.** Reads song structure (sections, energy,
  novelty) and crossfades looks on the beat — building into drops, settling into
  breakdowns, and *recalling a section's earlier look when it returns* so the
  visuals rhyme with the song.
- **Native MilkDrop-class rendering.** Feedback-field warp (zoom / rotate /
  swirl / kaleidoscope / hue-cycle) + a reactive waveform oscilloscope, all on a
  WebGL2 RGBA16F ping-pong field with dual-Kawase bloom and ACES tone-mapping.

## Status

> **Not yet published to npm.** `@eviland/core` is currently *staged inside*
> NewAmp: the engine source lives in `src/visualizer/` and this package's `src/`
> is a verified, build-isolated copy kept in lockstep by `sync.mjs` (NewAmp's
> `prebuild` fails on drift). The standalone npm release — and NewAmp importing
> *from* this package as the single source of truth — is the tracked follow-up
> in `EXTRACTION-STATUS.md`. The API below is stable and what that release will
> ship; the `npm install` line will start working when it's published.

## Install (after publish)

```bash
npm install @eviland/core
```

## Quick start (20 lines)

```ts
import { createEvilandRenderer, createEvilandReactor } from '@eviland/core';

const canvas = document.querySelector('canvas')!;
const renderer = createEvilandRenderer(canvas, { quality: 'high' });
if (!renderer) throw new Error('WebGL2 + EXT_color_buffer_float required');
renderer.resize(canvas.clientWidth, canvas.clientHeight, devicePixelRatio);

const ctx = new AudioContext();
const analyser = ctx.createAnalyser();            // wire your <audio> source → analyser
const onset = ctx.createAnalyser(); onset.smoothingTimeConstant = 0;
const reactor = createEvilandReactor({ sampleRate: ctx.sampleRate, fftSize: analyser.fftSize, binCount: analyser.frequencyBinCount });

const freq = new Uint8Array(analyser.frequencyBinCount);
const on = new Uint8Array(onset.frequencyBinCount);
const wave = new Uint8Array(256);
const palette = { bg: [0.02,0.02,0.06], dark: [1,0.15,0.4], accent: [0.1,0.8,1], light: [1,0.95,0.6] };

let prev = performance.now();
(function loop(t) {
  const dt = t - prev; prev = t;
  analyser.getByteFrequencyData(freq);
  onset.getByteFrequencyData(on);
  analyser.getByteTimeDomainData(wave);
  const frame = reactor.analyze(freq, on, freq, freq, dt, t);  // L/R = freq for mono
  renderer.setWaveform(wave);
  renderer.render(frame, palette, dt);
  requestAnimationFrame(loop);
})(prev);
```

## Add the generative engine

```ts
import { generate, createDirector } from '@eviland/core';

// A specific look from a shareable seed:
const { config } = generate('K7Q2-9XMF');
renderer.setConfig(config);

// …or let the Director conduct the whole song:
const director = createDirector({ songId: 'my-track' });
// inside the loop, before render():
renderer.setConfig(director.update(frame, dt));
```

## Record a clip

```ts
import { createCanvasRecorder } from '@eviland/core';
const rec = createCanvasRecorder(canvas, { fps: 60, videoBitsPerSecond: 12_000_000 });
rec.start(audioStream);              // pass a MediaStream to mux audio
// …later…
const webm = await rec.stop();       // → Blob
```

## API surface

| Export | What |
|---|---|
| `createEvilandRenderer(canvas, opts)` | WebGL2 renderer → `{ resize, render, setConfig, getConfig, setWaveform, dispose }` (or `null` if WebGL2 float is unavailable — fall back to your own canvas). |
| `createEvilandReactor(cfg)` | 24-band causal onset reactor → `EvilandFrame` per `analyze()`. |
| `generate / mutate / encode / decode / classic / ARCHETYPES` | Seedable generative looks. |
| `createDirector(opts)` | Autonomous conductor → `OperatorConfig` per `update()`. |
| `evalConfig / defaultConfig / lerpConfig / cloneConfig` | Operator-config evaluation + interpolation. |
| `Rng / encodeSeedCode / decodeSeedCode` | Deterministic RNG + shareable seed codes. |
| `createCanvasRecorder(canvas, opts)` | Canvas + audio → WebM (VP9/Opus). |

## Requirements

WebGL2 with `EXT_color_buffer_float`. `createEvilandRenderer` returns `null`
when unavailable, so you can fall back gracefully.

## License

MIT © evilander
