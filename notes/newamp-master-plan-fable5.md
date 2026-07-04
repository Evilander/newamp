# NewAmp Master Plan — Five Additions (Fable 5 pick)

**Status:** draft
**Created:** 2026-07-02
**Owner:** Tyler
**Chosen by:** Fable 5, after a whole-project review at v1.15.0 (research: 5 parallel agents, 2026-07-02 — anchors below are verified against live code, external claims carry primary sources)

> **Executor instructions:** write decisions to `notes/newamp-master-plan-fable5-context/decisions.md` as you make them. Answer open questions by editing `open-questions.md` and committing. Every feature section is independently executable; respect the sequence unless a dependency note says otherwise.

## Goal (one sentence)

Make NewAmp the local player people switch TO — by giving it the two shareable artifacts nothing else produces (Clip Studio, Wrapped Live), the two capabilities serious users demand (bit-perfect output, a phone remote), and the query interface nobody local has (ask your library in English).

## Why these five

- **The three axes Tyler named** — player, library manager, visualizer — each get a flagship: bit-perfect output (player), Ask Your Library (library), Clip Studio (visualizer).
- **The share loop is the growth engine.** Clip Studio and Wrapped Live produce artifacts people post; every post is an ad for a local-first player. Wrapped Live also carries the roadmap's only hard deadline (ship before December 2026, ahead of Spotify Wrapped).
- **Every one builds on infrastructure that already exists and was verified this week**: the 1.15.0 layer compositor, the frame bus, radio-brain's HTTP server, the Tags/smart-rule engines, ffmpeg-static (verified locally: includes libx264, h264_nvenc, aac, libopus).
- Two **course corrections from research** are baked in: audify/RtAudio *cannot* do WASAPI exclusive (unimplemented TODO in RtAudio's WASAPI backend, confirmed in current master 2026-07-02 — `docs/audio-quality.md`'s plan is wrong and gets fixed), and radio-brain currently binds `0.0.0.0` with **zero auth** (fix ships with Feature 3, and the auth gate is worth landing even sooner).

## Sequence and why

1. **Clip Studio** (M) — smallest flagship; builds the WebCodecs ring + ffmpeg-remux muscle that #2 reuses.
2. **Wrapped Live** (M) — the December deadline; reuses #1's mp4 finishing step.
3. **NewAmp Remote** (M) — self-contained; includes the radio-brain auth fix.
4. **Ask Your Library** (M) — self-contained; two small schema additions unlock it.
5. **Bit-Perfect Mode** (L) — the largest and the only one with native-code risk. **Start its go/no-go spike (§5 step 1) in parallel with #1** so the verdict arrives before its slot.

---

## 1. Eviland Clip Studio — save the moment that already happened

**Goal:** press one key and get a shareable MP4 of the last ~15 seconds of Eviland Live, with audio — ShadowPlay for your music.

**Approach.** Always-armed (while fullscreen viz is open) WebCodecs ring buffer: `canvas.captureStream(fps)` → `MediaStreamTrackProcessor` → `VideoEncoder`/`AudioEncoder` (VP9/Opus, `prefer-hardware`, forced ~2s keyframes) → bounded ring of encoded chunks with **keyframe-aligned eviction** → on save, mux the retained window with **Mediabunny** (the maintained successor to webm-muxer/mp4-muxer) → hand WebM to main → ffmpeg remux/encode to MP4 H.264+AAC via `h264_nvenc` (verified present in the bundled binary). ~20MB steady memory for a 20s 1080p window, one continuous encode, zero boundary hitches.
Key tradeoff: WebCodecs ring is the most complex of the three candidate patterns, but the alternatives are disqualified — MediaRecorder chunk-dropping yields unplayable files (WebM cluster/header dependency, W3C mediacapture-record #178), and dual alternating recorders have documented boundary seams. Stock Electron ships **no H.264/AAC WebCodecs encode** (electron/electron#38213) — hence VP9/Opus in the ring and ffmpeg for the finish.

**Files to touch**
- `src/components/FullscreenVisualizer.tsx` — arm/disarm the ring alongside the existing eviland-live compositor (`toggleRecord`'s eviland-live branch at ~line 796 already solves layer compositing + the audio tap; reuse both).
- `shared/keyboard-shortcuts.ts` + `src/App.tsx` — `Shift+R` = "save last 15s".
- `docs/eviland/design-live-io.md` §3 (~line 803) — new subsection; it already sketches ring-buffer export and proposes the `eviland:export-video` IPC name.

**Files to create**
- `src/visualizer/eviland-replay.ts` — the ring recorder (encoders, eviction, Mediabunny mux). Same dependency-free discipline as `eviland-recorder.ts`.
- `electron/video-mux.ts` — `remuxWebmToMp4(webmPath|buffer, opts)` using `transcode.ts`'s `resolveFfmpegPath()`/`runFfmpeg()` pattern (lines 326–349). Args: `-c:v h264_nvenc` (fallback `libx264`), `-pix_fmt yuv420p`, `-c:a aac -b:a 192k`, optional 9:16 crop.
- `scripts/clip-replay-smoke.mjs` — arms the ring against a synthetic canvas, saves, asserts ffprobe-visible `h264` + `aac` and duration ≈ window.

**Sequence**
1. **Empirical pre-check** — `MediaStreamTrackProcessor` frames off the real compositor canvas are non-blank (same failure class as the known drawImage-on-WebGL issue). Acceptance: a 3s capture has lit pixels.
2. Ring recorder module + unit-ish smoke. Acceptance: save at T yields [T−15s, T] within ±0.5s, playable WebM.
3. `video-mux.ts` + save path (reuse `media:save-capture` for the final bytes — it's format-agnostic, `electron/main.ts:1891`). Acceptance: MP4 plays in Windows Films&TV; export ≤4s on this machine (NVENC).
4. UI: arm indicator + Shift+R + 9:16 toggle + watermark toggle. Acceptance: smoke green, no frame-rate regression while armed (compare `smoke:ui-visualizer` timings).

**Risks:** `new VideoFrame(canvas)` blank-read risk (mitigated by step 1 gate); Mediabunny fed mid-session timestamps needs a unit test; add `mediabunny` dep (small, MIT).

## 2. Wrapped Live — your year as a video

**Goal:** one click in Wrapped → a 30s 1080×1920 MP4 of your listening year, scored to your top track — shipped before December.

**Approach.** A dedicated offscreen animated canvas renderer (~6 chapters: totals → top artists → top tracks → genres → listening clock → taste/outro) driven by the complete, already-shipped `WrappedStats` surface (totals, top tracks/artists/albums, genres, listeningClock[24], peakHour, streak, taste — `shared/types.ts:439-462`, computed in `electron/library.ts:3209-3387`, IPC `history:wrapped`). Capture with the existing `createCanvasRecorder` + engine audio tap while the top track plays (resolved via `library:get-track` → `.path`); finish with #1's `video-mux.ts`. Chapters use spring easing and the album-art palette module for per-user color. Tradeoff: real-time capture (30s render = 30s wall) over an offline frame-by-frame pipe — dramatically simpler, and 30s wall is fine for a once-a-year artifact.

**Proposed answers to roadmap open question Q4** (defaults, revisit anytime): fixed 30s; year + month modes; small "NewAmp" watermark on; audio bed on **with a visible mute toggle** (copyright-bot-wary sharing).

**Files to create:** `src/visualizer/wrapped-live-scene.ts` (chapter renderer, pure canvas), `src/components/WrappedLiveExport.tsx` (modal: preview, mute toggle, progress, save), `scripts/wrapped-live-smoke.mjs` (renders with fixture stats, asserts non-black chapters + mp4 output).
**Files to touch:** `src/components/views/WrappedView.tsx` (entry button next to the existing PNG share card, whose draw code at lines 35–133 seeds the visual language), `electron/video-mux.ts` (from #1).

**Sequence:** scene renderer with fixture data → capture+audio integration → mux+save → smoke + polish. Acceptance: export ≤60s wall, ≤20MB, plays in iMessage/Discord/TikTok upload; zero network.

**Risks:** none structural — all substrate verified. Chapter typography is the taste risk; steal from the share-card's existing look.

## 3. NewAmp Remote — the phone is the remote

**Goal:** scan a QR in Settings, get a phone page with art, transport, scrub, volume, and queue — no cloud, no app store.

**Approach.** Extend radio-brain (bare `node:http`, `electron/radio-brain.ts`) with: a **token gate on every route** (32-byte token persisted in settings, QR in Settings encodes `http://<lan-ip>:<port>/remote#<token>`), a static `/remote` PWA (single self-contained HTML file, no build step), `GET /now/events` (SSE — the audio-passthrough code already demonstrates the streaming-response pattern), and `POST /control` validated against the same command whitelist as the projector then forwarded through the existing `transport:command` path. Rich now-playing state: widen the 1.15.0 `playback:state` IPC payload (trackId, album, position, duration, volume, queue head, art hash) — main already receives it. Tradeoff: extending radio-brain vs a sibling server — one port, one settings surface, one server to secure wins.

**Do first, ships even without the rest:** the token gate on the *existing* endpoints. Research confirmed radio-brain today serves your full library and audio streams to anyone on the LAN, unauthenticated, bound to `0.0.0.0`. That's a hole regardless of Remote.

**Files to touch:** `electron/radio-brain.ts` (auth middleware, routes, SSE, real Range support on `/audio/:trackId` — the current `Accept-Ranges: bytes` header is a lie, lines ~270–289 always send the whole file), `electron/main.ts` + `electron/preload.ts` + `src/store/usePlayerStore.ts` (widened playback:state; volume/seek command handling already exists in the transport:command handler), `src/components/views/SettingsView.tsx` (QR + token display + regenerate button).
**Files to create:** `electron/remote-page.ts` (the inlined PWA HTML), `scripts/remote-smoke.mjs` (boots server, asserts 401 without token, 200 with, SSE emits on state change, POST control round-trips).

**Sequence:** token gate (+ 401s, + smoke) → widened state channel → SSE + `/remote` page → control endpoints → QR in Settings. Acceptance: phone on same LAN controls playback with <300ms perceived latency; every route 401s without the token; `smoke:radio-brain` still green.

**Risks:** CSRF on control endpoints (mitigate: token required in header/hash, never cookie; POST-only for writes); LAN IP enumeration for the QR (use the first non-internal IPv4; show all candidates).

## 4. Ask Your Library — natural language in Ctrl+K

**Goal:** type "warm slow stuff from the 70s I haven't played this year" into the palette and get exactly that, offline.

**Approach.** A **local intent compiler** targeting `SmartPlaylistRuleInput` (it already has minBpm/maxBpm, year ranges, rating, loved/unplayed, free-text, and a full execution path `smart:run` → `runSmartPlaylistRule`, `electron/library.ts:2416`): vocabulary tables map decades→year ranges, tempo words→bpm bands, mood/texture words ("warm", "bright", "loud", "gentle")→DNA target bands applied as a **post-fetch re-rank** using the existing `buildDnaIndex()` (exactly how `buildHarmonicMix` already re-ranks). Two small schema additions unlock the target phrases: a `notPlayedSince` field on the rule input + `smartRuleWhere` (recency-exclusion has *no* primitive today), and a `bpm:` token is unnecessary (rule input already carries it). Optional LLM tier: clone `openai-assist.ts`'s strict-json_schema pattern (`electron/openai-assist.ts:68`) with output constrained to exactly the rule-input fields, gated on `openaiApiKey` **plus a new explicit setting** so liner-notes and ask-mode opt-ins stay separate. The palette shows the compiled interpretation as chips ("1970s · bpm < 100 · warmth-ranked · not played since Jan") — honest, teachable, correctable.
Key tradeoff: compiling to SmartPlaylistRuleInput (SQL path, no DNA predicates) + DNA re-rank, instead of executing the Living Tags DSL live — far less work, reuses scoring/limits, and the re-rank recovers the DNA expressiveness where it matters (ordering).

**Files to touch:** `shared/types.ts` (`SmartPlaylistRuleInput.notPlayedSince`), `electron/library.ts` (`smartRuleWhere` ~4761 + DNA re-rank hook in `runSmartPlaylistRule`), `src/components/QuickPlayPalette.tsx` (new `ask` PaletteItem kind at the union ~line 16; branch the debounced effect ~line 113 on NL-shaped input — 3+ words, no `field:` token; separate longer debounce for the LLM tier), `electron/openai-assist.ts` + `electron/main.ts` + `electron/preload.ts` (optional `ai:query-translate`), `src/components/views/SettingsView.tsx` (ask-mode toggle).
**Files to create:** `shared/query-intent.ts` (the vocabulary + compiler — pure, unit-testable), `scripts/query-intent-test.mjs` (the 10 canonical phrases → expected rule objects).

**Sequence:** intent compiler + tests → `notPlayedSince` plumbing → palette ask-mode UI + chips → DNA re-rank → optional LLM tier. Acceptance: 8/10 canonical queries produce correct results fully offline (the 2.0-plan bar); chips always render what actually ran.

**Risks:** vocabulary coverage is a long tail — mitigate with the chips (user sees the interpretation) and a "refine" affordance; DNA coverage is partial across the library (re-rank only, never filter, so un-analyzed tracks still appear).

## 5. Bit-Perfect Mode — WASAPI exclusive, honestly

**Goal:** a signal-path badge that turns gold: NewAmp → device, exclusive, untouched samples at source rate — the permanent audiophile moat (Windows first).

**Approach — corrected by research.** RtAudio/audify is out: its WASAPI backend hardcodes `AUDCLNT_SHAREMODE_SHARED`; exclusive is a literal `TODO` (confirmed in master, 2026-07-02). The healthy path: **vendor `mackron/miniaudio.h`** (MIT, single header, actively maintained, real `ma_share_mode_exclusive`) **in a small custom N-API addon** (`node-addon-api`, prebuilds for Electron 42 / Node 24.15 ABI) exposing: device enumeration, format probe, exclusive open/start/stop, PCM push. Decode stays on the existing `ffmpeg → f32le/s32le at source rate` policy (per `docs/audio-quality.md`, which also gets its audify claim corrected). Playback runs in the main/utility process; the renderer keeps the UI and feeds the visualizer from a 30Hz time/freq-domain tap of the decoded PCM pushed over IPC into the existing frame-producer input path — the visualizer must not die when the Web Audio graph goes silent. Bit-perfect means **no DSP**: EQ, ReplayGain, crossfade, and the perceptual volume curve disable with an honest explanation; volume in v1 is the device's hardware volume or none (per-app session volume is inert in exclusive mode — Microsoft docs).

**Proposed answers to roadmap open question Q2** (defaults): (a) SMTC — keep the already-registered global media-key shortcuts in v1, smoke-test Electron 42's MediaSession behavior with a muted shadow `<audio>` element, defer full SMTC polish; (b) single global exclusive toggle + device picker in v1, per-device settings later.

**Planned-for pitfalls** (all sourced): `AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED` retry-once pattern; probe both packed 24-bit and 24-in-32 padded; deliberate audible micro-gap on sample-rate change (full re-Initialize — foobar2000 behaves identically; surface it in UI, don't hide it); relinquish the device on pause/background so system audio returns; macOS hog-mode is NOT solved by miniaudio — explicitly Windows-only v1.

**Files to create:** `native/newamp-audio/` (addon: `binding.cpp`, miniaudio vendored, `binding.gyp`/cmake, prebuild CI lane), `electron/exclusive-output.ts` (stream lifecycle, format negotiation, ffmpeg pipe feed), `src/audio/exclusive-bridge.ts` (renderer state + viz tap consumer), `scripts/exclusive-smoke.mjs` (device enum + shared-mode open/close on CI hardware; exclusive path behind a manual flag).
**Files to touch:** `src/audio/engine.ts` (engine-switch seam), `src/store/usePlayerStore.ts`, `src/components/views/SettingsView.tsx` (replace the honest "future phase" copy at ~line 1205 with the real toggle), `SignalPathBadge` (gold state), `docs/audio-quality.md` (correct the audify claim), `package.json` (electron-builder native rebuild lane).

**Sequence:** ① **Go/no-go spike** — bare addon: enumerate devices + open WASAPI *exclusive* + play 10s of a 44.1/16 and a 96/24 FLAC via ffmpeg pipe, loopback-record and byte-compare. This is the whole feature's risk, retired first, in parallel with Feature 1. ② Addon API + prebuilds. ③ `exclusive-output.ts` + engine seam + honesty UI. ④ Visualizer tap. ⑤ Gapless-same-format + rate-switch UX. ⑥ Badge + docs + smokes. Acceptance: loopback byte-compare proves untouched samples; every prior playback smoke still green with the toggle OFF (default OFF).

**Risks:** native addon = the repo's first (build matrix, signing, electron-builder rebuild) — accepted, this is the moat; SMTC behavior unverified on Electron 42 (smoke early); Chromium's own `--enable-exclusive-audio` has been broken for years (why this addon exists at all).

---

## Alternatives considered (and why not)

- **Sonic Atlas resurrection / Listening Rooms / Resonance Outwards** — high charm, but each is either hardware-gated, network-heavy, or was deliberately deleted scope (Atlas, in 1.11.0); none beats the five above on axis coverage per unit risk.
- **`.milk` preset import** — IP-adjacent, and Eviland's own identity (scenes, memory, palettes) is now the stronger bet than compatibility.
- **Stems (roadmap P2)** — gated on unanswered Q1 (model hosting/size) and large; stays queued behind this five.

## Cross-cutting risks

- **radio-brain's current no-auth LAN exposure** — real today, worth the token gate ASAP even if Feature 3 slips (it's step 1 of its sequence for exactly that reason).
- Two new deps total (`mediabunny`, `node-addon-api`) — everything else rides existing infrastructure.
- All five features default OFF or additive; no existing playback/UI path changes behavior until invoked. Release gates: every feature lands with its own smoke + the standard battery.

## Open questions (Tyler)

1. Roadmap Q2 & Q4 defaults proposed above (exclusive-mode scope; Wrapped Live scope) — confirm or adjust in `open-questions.md`.
2. Clip Studio watermark: on by default (share-loop branding) or off by default (purist)? Proposed: on, one-click off, remembered.
3. Remote: is LAN-only + token enough, or do you want an off-network story (Cloudflare tunnel) in v1? Proposed: LAN-only v1.
4. Bit-perfect device volume: expose `IAudioEndpointVolume` (moves the *hardware* volume — affects the whole endpoint) or ship volume-less exclusive v1 (knob on your DAC)? Proposed: volume-less v1 with clear copy.

## Execution notes

- **2026-07-02 (v1.16.0):** Features 1–4 shipped in one pass — Clip Studio, Wrapped Live, Remote (incl. the token gate for the pre-existing LAN exposure), Ask Your Library (local compiler 10/10 canonical phrases; LLM tier deferred). Bit-perfect spike: GO.
- **2026-07-03 (v1.17.0):** Feature 5 shipped — Bit-Perfect Exclusive. Deltas from plan §5:
  - The addon builds against ambient Node headers with NAPI_VERSION=8 and loads in Electron 42 unmodified (N-API 10) — no electron-rebuild/prebuild lane needed; `scripts/build-native.mjs` (vcvars64 wrapper) is the whole build story, wired win-gated into `scripts/package.mjs`.
  - Renderer seam landed as an `ExternalTransport` facade *inside* `AudioEngine` (not a parallel engine) — store and all downstream consumers unchanged; state returns via `patchExternal`.
  - The viz tap landed at the engine's six get*Data methods (spec-faithful AnalyserNode emulation, `src/audio/exclusive-tap.ts`) rather than the frame producer — zero visualizer-code changes, detached projector included.
  - Loopback byte-compare acceptance was replaced: WASAPI loopback cannot capture exclusive streams (they bypass the mixer). Proof instead = refuse-dishonest-open (requested vs internal format from the device itself) + exact frame accounting + the end-to-end `smoke:exclusive-ui` earning `(bit-perfect)` on real hardware.
  - Real-hardware finding that shaped the design: exclusive devices only advertise their control-panel clock (Focusrite: 48k only); miniaudio silently resamples unless you match a probed native format. All conversion is now explicit (ffmpeg/soxr) and labeled.
  - Bonus beyond plan: gapless-same-format ring splicing (§5 step ⑤) shipped in v1, not deferred; plus the Windows taskbar-icon regression fix (mixed-format ICO) that rode along.
  - Open questions resolved with proposed defaults: Q2 (media keys kept, single global toggle + device picker), volume-less exclusive v1 (DAC knob, honest copy).
