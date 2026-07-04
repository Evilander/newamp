# NewAmp Audio Quality — How We Make It Sound Right (and the honest limits)

Synthesized from a two-expert pass (audio-path review + SOTA research, 2026-06-07).
This documents the signal path, what we ship, and — bluntly — the ceiling of a
Web-Audio/Electron player and what it would take to break through it.

## The signal path (renderer)

```
HTMLAudioElement (deck) → MediaElementSource → inputGain(preamp)
  → 10× BiquadFilter (peaking EQ) → replayGain → masterGain(volume)
  → [DynamicsCompressor limiter] → AudioContext.destination
                                         ↓ (parallel, 0-gain silent sink)
                                    analysers (visualizer taps)
```

Native formats (mp3 / m4a / aac / **flac, incl. 24/96 & 24/192** / ogg / opus / wav)
are served **raw** through the `newamp:` protocol and decoded by Chromium.
Exotic lossless (alac / aiff / ape / wv / tta / wma / mka) and DSD (dsf / dff) go
through an ffmpeg transcode.

## What we ship (honest wins, no native code)

1. **Hi-res-preserving transcode** (`electron/transcode.ts`). The fallback path used
   to hardcode `pcm_s16le -ar 48000` — it **crushed every 24/96 ALAC/AIFF/APE/WV to
   16-bit/48 kHz on every play**. Now: **`pcm_f32le` at the source sample rate** (no
   forced downsample, no bit-depth truncation). 32-bit float is the only lossless
   PCM-in-WAV format Chromium's `<audio>` decodes — **24-bit int WAV is NOT
   supported**, so f32le (not s24le) is the correct choice. DSD gets a pinned
   high-precision SoX resampler (`soxr:precision=28`) to 88.2 kHz instead of
   ffmpeg's uncontrolled default DSD→PCM filter.
2. **True limiter bypass** (`src/audio/engine.ts`). "Limiter off" now **disconnects**
   the `DynamicsCompressor` from the graph (`masterGain → destination`) instead of
   leaving a unity-ratio compressor + its ~6 ms lookahead in the path. Off means off.
   The toggle is **click-free** (an ~8 ms master dip across the rewire so the
   limited↔raw amplitude step can't pop) and **mute-safe** (the rewire is guarded;
   a `connect()` failure force-restores `masterGain → destination` and surfaces an
   error rather than silently killing all audio).
2b. **Hi-res WAV *export* too.** "Export to WAV" now writes **24-bit at the source
   rate** (`pcm_s24le`, no forced 48k) instead of crushing to 16/48 — matching the
   playback fidelity policy. (Export writes a file for other tools, so 24-bit int
   is the right interchange format; the streaming path uses float for Chromium.)
2c. **Rejected sample rates no longer fail silently.** If the device rejects the
   requested Bit-Perfect rate, the engine records it and the Settings UI says
   "X kHz not supported — running at Y kHz" instead of showing the wrong rate.
3. **Faster track-boundary gain ramps**. ReplayGain/preamp `setTargetAtTime` time
   constants dropped 20 ms → 6 ms so a gain change at a track boundary no longer
   "swells" the first beat (still smoothed enough to avoid a zipper click).
4. **Honest rate readout** (Settings → Audio). Shows the **playing track's source
   rate vs the live engine rate** and flags "Chromium resamples this track" when they
   differ — auditable, like foobar2000's status bar.

## The ceiling of a Web-Audio player (don't oversell it)

- **You cannot be bit-perfect through vanilla Electron.** Web Audio → Chromium →
  **WASAPI shared mode** (Windows) / shared CoreAudio (macOS). The OS mixer is always
  in the path and resamples to the device format. Chrome's `--enable-exclusive-audio`
  flag has been broken for years. (This ceiling is exactly why Bit-Perfect Exclusive
  below bypasses the Web Audio path entirely with a native addon.)
- **Matching the AudioContext sample rate to the source per track buys nothing.** The
  Web Audio spec *mandates* the UA resample AudioContext → device when they differ,
  and the device rate is whatever the OS picked. Per-track context recreation just
  moves the same resampler around and costs a graph rebuild + gap. **Do not do it.**
  The right Web-Audio move is what the Bit-Perfect setting already does: pin the
  context to one rate and have the user set their DAC to match.
- **Resampler quality:** Chromium uses a WebRTC Kaiser-windowed sinc — genuinely
  transparent for music (artifacts < ~-110 dB), just not bit-identical.
- **Dither is not our job** in the float32 graph. Requantization happens in Chromium's
  output thread; gain applied in float32 adds noise at ~-150 dBFS (inaudible).

**Realistic verdict:** "Indistinguishable from a good shared-mode app." Above ~-110 dB
this is transparent to ears and DACs. We are NOT bit-perfect and should not claim it
without the native path below.

## The real bit-perfect path (SHIPPED — Bit-Perfect Exclusive, Windows)

**v1.17.0 ships an opt-in native output backend** (default users stay on Web Audio):
Settings → Playback → **Bit-Perfect Exclusive**.

- **NOT `audify`/RtAudio** — the plan above this section used to recommend it, but
  RtAudio's WASAPI backend hardcodes `AUDCLNT_SHAREMODE_SHARED`; exclusive mode is a
  literal unimplemented `TODO` in its source (verified against master, 2026-07-02).
  Instead: **vendored `miniaudio`** in a first-party N-API addon
  (`native/newamp-audio/`, NAPI_VERSION=8 → ABI-stable across Node/Electron, loads
  in Electron 42 with no electron-rebuild).
- **Decode in the main process**: `ffmpeg → raw PCM ints/floats` piped straight into
  a lock-free ring drained by the WASAPI callback (`electron/exclusive-output.ts`).
  No WebCodecs, no renderer round-trip, no float detour for integer sources — a
  16-bit FLAC leaves ffmpeg as the same s16 words the encoder stored.
- **Probe-driven honest negotiation**: the stream format is chosen from the device's
  *native* exclusive formats (`probeDevice()`). If the source rate isn't natively
  supported, NewAmp resamples **explicitly** (soxr, precision 28) and *says so* —
  the badge shows `EXCLUSIVE*` instead of gold, because miniaudio would otherwise
  insert a hidden converter (observed live: a Focusrite clocked at 48 kHz silently
  resampled a 44.1 kHz exclusive stream; `internalSampleRate` exposes it and the
  driver refuses dishonest opens).
- **No DSP, structurally**: EQ, ReplayGain, crossfade, limiter, preamp and software
  volume are out of the path (and grayed in the UI). Volume is your DAC's knob.
  Visualizers stay live via a 30 Hz playhead-aligned PCM tap → spec-faithful
  AnalyserNode emulation (`src/audio/exclusive-tap.ts`).
- **Gapless over exclusive**: when the next track negotiates the identical device
  format it is spliced into the same ring at the exact frame boundary. Rate changes
  re-open the device with a deliberate audible micro-gap (same behavior as
  foobar2000). Pause relinquishes the device after ~15 s so system audio returns.
- The gold `EXCLUSIVE` badge = strict claim: lossless source, rate + bit depth +
  channel layout preserved, no DSD conversion. Anything less shows `EXCLUSIVE*`
  with the exact reason in the tooltip and Settings.
- **Windows-only v1** (macOS hog-mode is NOT solved by miniaudio; roadmap).
  Podcasts / non-library sources / cue sheets fall back to the shared path
  automatically, per-track. Gate: `npm run smoke:exclusive-output` (+ manual
  `NEWAMP_EXCLUSIVE_SMOKE_HW=1` full exclusive pass).

This is the foobar2000/Audirvana/Roon bar, and "bit-perfect available" is now on
the box honestly.

**Second-highest (still no native code):** replace `MediaElementSource` with
**WebCodecs `AudioDecoder` → AudioWorklet** for sample-accurate **gapless** (trim
encoder delay/padding) and one fewer implicit resample.

## Known remaining limitations / follow-ups

- ~~Transcoded formats still aren't seekable~~ **FIXED.** All playback paths are now
  range-addressable: native files and finalized cached FLACs are served with
  hand-rolled `206 Partial Content` responses (`electron/audio-serve.ts` —
  Electron's `net.fetch(file://)` slices Range bodies but answers a bare `200`,
  which Chromium reads as non-seekable), and the first-play live transcode is a
  synthesized-header f32le WAV whose constant bitrate maps byte ranges to
  `ffmpeg -ss` seeks. Gate: `npm run smoke:playback-seek` (4 paths, real `<audio>`
  scrub assertions).
- **No null-test in CI.** To claim "bit-perfect verified", add an `OfflineAudioContext`
  harness that renders a known WAV through the real engine graph and asserts peak
  error < 2^-23 with all DSP bypassed. (Refactor `engine.ts` to expose
  `buildGraph(ctx)`; ~half a day.)
- **ReplayGain 2.0 / true-peak**: limiter ceiling is -1 dBFS (close to the -1 dBTP
  target); consider 2× true-peak detection and the Opus +5 dB R128 offset.

## Snake oil we are NOT shipping

- "Set AudioContext rate to source rate = no resampling." False unless the device rate
  also matches.
- "Upsample everything to 192 kHz improves quality." False; source-rate is the target.
- "32-bit float is higher quality than 24-bit int for playback." False; 24-bit already
  exceeds any DAC's noise floor. (We use f32le only because Chromium won't decode 24-bit
  int WAV — it's a transport choice, not a quality claim.)
- Replacing `DynamicsCompressorNode` with a custom AudioWorklet to reclaim 6 ms — the
  delay doesn't affect transparency and our analyser tap is already pre-limiter.

_Sources: W3C Web Audio API 1.1; Chromium issues 40524559 / 40176358; Chromium
audio-video format docs; foobar2000 foo_out_wasapi; audify/RtAudio; loudgain /
Hydrogenaudio ReplayGain 2.0; EBU R128 / BS.1770._
