# Audio signal path

NewAmp has three ways to turn a file into sound. Shared output is the default:
audio goes through Chromium's Web Audio and the operating system's mixer.
Sample-accurate gapless is a transport inside shared output that plays local
tracks as one continuous stream. Bit-Perfect Exclusive is an opt-in native
output that opens the device directly and skips the mixer. This page describes
each one and what it can and cannot promise.

## Shared output

```
<audio> deck (two, alternating) -> per-deck ReplayGain -> fade gain -> preamp
gapless worklet ---------------------------------------------------^
  -> 10 peaking EQ bands -> tap point -> volume -> [limiter] -> output
                              |
                        analysers (visualizers), routed to the output
                        through a gain node fixed at 0
```

Volume sits before the limiter, so boost past 100% (the slider goes to 200%)
is caught by it. Below 100% the slider follows a cubic taper; above it the gain
is linear. The analysers read the signal before volume, which keeps the
visualizers moving when you listen quietly. They are wired to the output
through a silent gain node because Chromium can drop analyser subtrees that
never reach the destination, which freezes the spectrum at zero.

### Formats

Files Chromium decodes (mp3, m4a, m4b, mp4, aac, flac, ogg, oga, opus, wav) are
served unchanged through the `newamp:` protocol. Everything else goes through
ffmpeg first: wma, alac, aiff, ape, wv, mpc, tta, mka, ac3, dts, and DSD (dsf,
dff). See `electron/transcode.ts`.

- The first play of a transcoded file streams 32-bit float PCM at the source
  sample rate, with no forced downsample and no bit-depth truncation. Float is
  used because Chromium's `<audio>` does not decode 24-bit integer WAV. It is a
  transport choice, not a quality claim.
- A lossless FLAC copy at the source rate is written to the transcode cache for
  later plays. Cache hits are served like any native file.
- DSD has no native path in the browser. It is converted to PCM at 88.2 kHz with
  soxr (precision 28) when the ffmpeg build has it, and with a long
  Kaiser-windowed swr filter otherwise. The ffmpeg bundled on Windows has no
  soxr. See `electron/resampler.ts`.
- Export to WAV writes 24-bit PCM at the source sample rate.

### Seeking

Every playback path is byte-range addressable. Native files and cached FLACs are
served with `206 Partial Content` responses from `electron/audio-serve.ts`,
because Electron's `net.fetch(file://)` answers range requests with a bare
`200`, which Chromium treats as a non-seekable stream. The live first-play
transcode sends a synthesized WAV header, so a byte range maps to an
`ffmpeg -ss` seek. `npm run smoke:playback-seek` scrubs a real `<audio>` element
across all four paths.

### Limiter, ReplayGain and gain changes

- The limiter is a Web Audio `DynamicsCompressor`: threshold -1 dB, knee 0,
  ratio 20, attack 3 ms, release 120 ms. It is a compressor-based limiter, not a
  true-peak limiter.
- Turning it off disconnects the node (volume goes straight to the output). It
  is not left in the path at a unity ratio. The switch mutes the master gain for
  about 8 ms on each side of the rewire so it does not click. If the reconnect
  throws, the direct path is forced and the error is shown, so a failed toggle
  cannot leave playback silent.
- ReplayGain is clamped to -18..+12 dB. A change at a track boundary uses a 6 ms
  time constant, short enough that the first beat of the next track does not
  swell and long enough to avoid a zipper click.

### Sample rate

Settings > Playback > Bit-Perfect Path pins the AudioContext to a chosen rate.
The row shows the live engine rate next to the playing track's source rate and
says "Chromium resamples this track" when they differ. If the output device
rejects the requested rate, the row says so and shows the rate it is running at.

NewAmp pins one rate instead of recreating the context per track. The Web Audio
spec requires the browser to resample between the context and the device when
their rates differ, so recreating the context per track would move the same
resampler around and add a gap at every rate change.

## Sample-accurate gapless

With Sample-accurate gapless on (Settings > Playback; on by default), local
library tracks don't play through the two `<audio>` decks. ffmpeg decodes each
track in the main process, the next track's first frame follows the previous
track's last frame in the same stream, and an AudioWorklet plays that stream
(`electron/gapless-transport.ts`, `src/audio/gapless-processor.js`). The deck
path can only start the next element after the current one fires `ended`,
which leaves digital silence at every boundary however early it preloads.
`npm run smoke:gapless-pcm` captures the output of both paths and measures
the boundaries.

- The rate the decoder actually produces decides whether a track is resampled,
  not its tags: Opus always decodes at 48 kHz, and HE-AAC's SBR doubles the
  core rate a container may report. A rate change inside the queue drains one
  resampler and starts the next track on a fresh one.
- ReplayGain switches on the new track's first frame.
- A pause longer than 5 s releases the decoder and its open file (Windows won't
  let anything rename or delete a file ffmpeg holds); resume restarts it at the
  paused position.
- Crossfade, playback speed other than 1x, an active A-B practice loop, CUE sheet
  segments, DSD, missing files, streams, podcasts and music-server tracks stay on
  the decks, as does any track the transport can't decode or that stalls.

## Bit-Perfect Exclusive

An opt-in native output backend (Settings > Playback > Bit-Perfect Exclusive).
The default stays on shared output. It is a first-party N-API addon around
vendored miniaudio (`native/newamp-audio/`, built against NAPI_VERSION 8, so it
loads in Electron without a rebuild).

- Decoding happens in the main process. ffmpeg writes raw PCM into a lock-free
  ring that the device callback drains (`electron/exclusive-output.ts`). Integer
  sources stay integer where the device accepts their format, so a 16-bit FLAC
  reaches the device as 16-bit samples.
- The stream format is chosen from the formats the device reports as natively
  supported for exclusive use. If the device cannot take the source rate,
  NewAmp resamples in ffmpeg (soxr or the swr filter above) and says which one
  ran. miniaudio would otherwise insert its own converter without telling
  anyone, so after opening the device the driver compares the rate and format it
  got with the ones it asked for and refuses the open if they differ.
- The Web Audio DSP stages are out of the path: crossfade, ReplayGain, limiter,
  preamp, EQ and software volume are bypassed and disabled in Settings. Use the
  device's own volume. Visualizers keep running from a roughly 30 Hz tap of the
  PCM being played (`src/audio/exclusive-tap.ts`).
- Gapless: when the next track negotiates the same device format, its PCM is
  spliced into the same ring at the exact frame boundary. A rate change reopens
  the device and leaves a short audible gap. Pausing releases the device after
  15 s so other audio can use it again.
- Streamed tracks (podcasts, radio, music-server tracks) and anything else that
  is not a local library track play through shared output, one track at a time.

The signal-path badge reports what happened. Gold `EXCLUSIVE` means the source
is lossless and not DSD, the rate, bit depth and channel layout reach the device
unchanged, and nothing was resampled. `EXCLUSIVE*` means the OS mixer is still
bypassed but something changed, and the tooltip names it: resampled by NewAmp,
lossy source, bit depth adapted, or channel layout adapted.

Platform status: Windows (WASAPI exclusive) is the verified path. Linux (ALSA
`hw:` devices, which bypass dmix and PulseAudio) and macOS (CoreAudio hog mode,
implemented in the addon because miniaudio has none) are marked experimental in
the UI. Both build and load on CI, and real-hardware listening checks are still
pending.

`npm run smoke:exclusive-output` covers the driver without a device. Setting
`NEWAMP_EXCLUSIVE_SMOKE_HW=1` adds a pass that opens a real exclusive stream,
which takes over the audio device while it runs.

## Limits

- Shared output is not bit-perfect. Web Audio goes through Chromium to the OS
  mixer (WASAPI shared mode on Windows, CoreAudio on macOS), and the mixer
  resamples to the device format when the rates differ. Only Bit-Perfect
  Exclusive bypasses it.
- There is no dither stage. The shared graph runs in 32-bit float and Chromium
  requantizes at the output.
- The shared graph has no automated bit-exactness test (render a known file with
  all processing off and compare). Exclusive mode checks the negotiated format
  when it opens the device instead.
