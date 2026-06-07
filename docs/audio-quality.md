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
  flag has been broken for years.
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

## The only real bit-perfect path (future, needs native code)

Ship an **opt-in native output backend** (default users stay on Web Audio):
- **`audify`** (N-API bindings to **RtAudio**; prebuilds cover current Electron) →
  **WASAPI exclusive** on Windows, **CoreAudio hog mode** on macOS, optional ASIO.
- Decode via WebCodecs `AudioDecoder` (or a hidden OfflineAudioContext), IPC the
  float32 PCM to the main process, push frames into the exclusive endpoint with **no
  intervening conversion** and **automatic device sample-rate switching** per track.
- Dither only at a float→int24/int16 boundary (TPDF, once) if the DAC needs integer.

This is the foobar2000/Audirvana/Roon bar. ~2 weeks for a robust implementation
(exclusive-mode failure handling, single-output locking, rate-switch gaps). It is the
single highest-impact change to put "bit-perfect available" on the box honestly.

**Second-highest (still no native code):** replace `MediaElementSource` with
**WebCodecs `AudioDecoder` → AudioWorklet** for sample-accurate **gapless** (trim
encoder delay/padding) and one fewer implicit resample.

## Known remaining limitations / follow-ups

- **Transcoded formats still aren't seekable** (`Accept-Ranges: none`, streamed WAV).
  The clean fix is to **transcode-to-disk-cache once** (`userData/transcode-cache/
  <sha1>.wav`, LRU) as f32le and serve via the range-aware `newamp` handler — that
  gives hi-res preservation AND seeking for these formats in one move. (~1 day.)
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
