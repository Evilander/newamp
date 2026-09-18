# @eviland/core

**An instrument-aware, self-directing generative music visual engine.**
Embeddable like [butterchurn](https://github.com/jberg/butterchurn) — but it
*listens*.

Eviland is the visual engine behind [NewAmp](https://github.com/evilander/newamp).
Zero dependencies, framework-agnostic, WebGL2.

## What makes it different

- Reactivity per frequency range, not one lumped envelope. A 24-band mel
  spectral-flux onset detector groups onsets into kick, bass, snare, hat and
  vocal ranges and gives each its own visual event. These are band ranges, not
  instrument recognition: a tom can land in the kick group.
- Looks are data (`OperatorConfig`): which sources a look draws (a procedural
  scene, fluid, reaction–diffusion, ridge, spectrum, emitters, waveform), plus
  a base value and audio-feature bindings per visual channel. The randomizer
  mints looks that are reproducible from a short shareable seed (`K7Q2-9XMF`).
- A Director reads song structure and crossfades looks on the beat, and gives
  a section its earlier look back when it returns.
- With a song score (below) the Director and renderer work ahead of the music
  instead of reacting to it: looks change on the bar line, a build draws the
  picture inward and dims it, and a drop lands on its downbeat.
- Rendering is a WebGL2 RGBA16F ping-pong feedback field (zoom, rotate, swirl,
  kaleidoscope, hue cycle, all frame-rate independent) with dual-Kawase bloom,
  metered exposure and a tone curve that keeps highlights at their own hue.

## Status

> **Not yet published to npm.** `@eviland/core` is currently *staged inside*
> NewAmp: the engine source lives in `src/visualizer/` and this package's `src/`
> is a verified, build-isolated copy kept in lockstep by `sync.mjs` (NewAmp's
> `prebuild` fails on drift). The standalone npm release — and NewAmp importing
> *from* this package as the single source of truth — comes later. The API below
> is stable and what that release will ship; the `npm install` line will start
> working when it's published.

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

## Look ahead with a song score

Everything above is causal: it only knows the audio that has already played.
If you have the whole track (a file, not a stream), analyse it once and the
engine can act on what is coming.

```ts
import { computeSongScore, createConductor, SONG_SCORE_SAMPLE_RATE } from '@eviland/core';

// Mono Float32 PCM at SONG_SCORE_SAMPLE_RATE (22050 Hz), e.g. from
// OfflineAudioContext or ffmpeg. About 2 s of work for a 5-minute track;
// the result is ~10 KB of JSON, so cache it.
const score = await computeSongScore(pcm, { sampleRate: SONG_SCORE_SAMPLE_RATE });

const conductor = createConductor();
conductor.setScore(score); // null is fine: frames then pass through untouched

// inside the loop, before director.update():
conductor.conduct(frame, audioElement.currentTime, dt);
renderer.setConfig(director.update(frame, dt));
```

The score holds the beat grid and bar phase, section boundaries with repeat
labels, each section's intensity relative to the rest of the track, the
lead-in to each section (build length, strength, and any held silence before
it), and each section's key relative to the track's home key. `conduct()`
stamps `frame.score` with `anticipation`, `blackout`, `impact`, the current
section's tier, a palette `keyShift`, and replaces the live beat and section
estimates with the analysed ones.

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
| `computeSongScore(pcm, opts)` | Whole-track analysis → `SongScore` (or `null` under ~20 s). Pure math, no DOM; runs in node too. |
| `createConductor()` | `SongScore` + playback position → look-ahead cues on each `EvilandFrame`. |
| `evalConfig / defaultConfig / lerpConfig / cloneConfig` | Operator-config evaluation + interpolation. |
| `Rng / encodeSeedCode / decodeSeedCode` | Deterministic RNG + shareable seed codes. |
| `createCanvasRecorder(canvas, opts)` | Canvas + audio → WebM (VP9/Opus). |

## Requirements

WebGL2 with `EXT_color_buffer_float`. `createEvilandRenderer` returns `null`
when unavailable, so you can fall back gracefully.

## License

MIT © evilander
