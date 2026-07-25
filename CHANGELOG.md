# Changelog

All notable changes to NewAmp will be documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [2.1.0] - 2026-07-16

Featherweight — the performance release. A 71-agent adversarial audit hunted
down every reason NewAmp "gets heavy" on long sessions, and the visualizer
learned to fly by its instruments instead of a hardware sniff.

### Added

- **Auto-Pilot.** Every Eviland surface now governs itself by *measured*
  frame cost instead of a one-shot hardware guess: sustained over-budget
  frames step internal resolution down (then frame rate, at the floor), and
  proven headroom steps back up — discrete steps with dwell and cooldown, so
  it never sawtooths and never churns GPU reallocation. The MilkDrop frame
  self-governs the same way and finally respects a 45fps cadence cap instead
  of rendering at full monitor refresh (144Hz displays were paying 3-5x the
  useful GPU cost); paused playback drops it to a 20fps idle glide and skips
  the 22s preset rotation (each rotation was a 50-80MB allocation storm
  nobody could hear). New `test:eviland-governor` suite locks the
  ladder/hysteresis/paint-gap behavior.
- **Two new scenes (31 total).** *Phosphor Scope* — a dual-trace vintage
  oscilloscope whose beams are resynthesized live from the spectrum, stereo
  width splitting the traces; *VU Cathedral* — a wall of twelve warm-backlit
  analog VU meters, each needle wired to its own band slice, red zones
  lighting when pinned.

### Fixed — the "gets heavy" audit

- **Instant Replay no longer taxes every session.** The 15s replay ring — a
  second compositor plus a continuous VP9+audio encode pipeline — used to
  run the entire time fullscreen Eviland Live was open, even paused, even
  hidden. It now arms only while playing and visible (a 3s grace window
  survives quick pauses), and clip recording disarms it for the duration so
  at most one capture pipeline ever runs.
- **Track changes no longer rewrite the whole library database.** Play/skip
  stats batch on a 30s flush tier instead of forcing a full multi-MB
  synchronous DB export + write on the main thread every track change;
  debounced flushes are now async and atomic (tmp + rename, staleness
  guards), and quit still flushes synchronously so nothing is lost.
- **ffmpeg can't hang or orphan anymore.** DNA analysis, ReplayGain, and
  batch-export ffmpeg children got the same 180s watchdog the transcode
  cache always had, and app quit now reaps every live child.
- **Queue, playlist, and history lists are virtualized.** The active-queue
  and playlist track lists rendered every row as live DOM — thousands of
  nodes after an Auto DJ session — and Listening History grew 500 rows per
  "Load More" forever. All three now window with the same virtualizer the
  Library and Albums views use, with drag-reorder and every control intact.
- **Auto DJ keeps refilling on long sessions.** Refill sizing counted played
  history against the lookahead target, so once a session ran long it
  silently stopped adding tracks while still paying the candidate-scan cost.
  Sizing now counts only what's ahead of the playhead.
- **The AI Director stopped allocating.** Intra-section drift was building
  ~20 fresh Maps 10x/sec for the life of every session (the documented
  zero-alloc fast path was unreachable); drift now lerps into a persistent
  scratch config — byte-identical output, zero steady-state allocation.
- **Eviland's memory-bridge registry can't leak.** Switching visualizer
  modes mid-track used to orphan the track's bridge (plus a permanent
  visibilitychange listener) forever; the registry now runs a small LRU
  sweep that flushes learning before evicting, never touching the active
  bridge.
- **The detached projector's producer can't outlive its window.** In
  compact mini-player mode, a closed or crashed projector left the headless
  33ms analysis tick running for the rest of the session; the detach wiring
  now lives at the app root, mounted in every layout.
- **OS media controls stopped churning.** MediaSession metadata and all six
  action handlers were rebuilt 10x/sec during playback; identity now syncs
  only on real track/play-state changes, and only the position updates per
  tick.
- **The transport footer stopped re-rendering 10x/sec** — the elapsed-time
  readout and scrub bar are now leaf subscribers, so the mini visualizer,
  buttons, and badges no longer reconcile on every clock tick.
- **Audio automation hygiene.** Volume, EQ, preamp, and ReplayGain now use
  the same cancel+pin idiom as the crossfade and limiter paths, so
  wheel-speed volume changes can't stack automation events on the
  AudioContext's timeline.
- **Settings writes got a hot path.** The every-3s playback-position
  autosave now debounces through an async atomic write instead of
  synchronously rewriting settings JSON on the main thread; user-toggled
  settings still persist immediately, and quit/restore flush first.
- **Small caps everywhere something grew forever:** the audio probe cache
  (LRU, 500), the bit-perfect gapless segment log (200), the diagnostic
  events.jsonl (5MB rotation), and the reactor overlay's bass-glow gradient
  (cached, not rebuilt per frame). The Retro TV static and Jukebox gel/bubble
  animations now pause with playback like every other deck, with
  reduced-motion still winning the cascade.

## [2.0.0] - 2026-07-08

Reference Grade — the design-led major. The app that always looked like
hardware now feels machined like it: one token layer, one header voice, truth
in every readout, and a screenshot harness to keep it that way.

### Added

- **A real design system.** The 5,500-line `index.css` monolith is now ordered
  modules (tokens / chrome / shells / decks / per-view files) with
  type/motion/shadow/radius/row-height ramps, a Tailwind `var()` bridge, one
  `THEME_REGISTRY`, and global keyboard focus-visible treatment.
- **Shared primitives, everywhere.** `ViewHeader` (one header voice — eyebrow,
  title, count chip, status slot, actions), `Chip`, `EmptyState`,
  `ViewSkeleton` shimmer placeholders wired to real loading states,
  `StatusToast` (a module-level toast queue replacing scattered inline status
  text), `ConfirmAction` two-step arm-then-fire on destructive actions, and an
  SVG icon set that retires the wobbly `★`/`☆` text glyphs.
- **Now Playing is a stage.** ON AIR lamp, truth-in-the-chrome readouts,
  resonance spotlight, and an attract mode when nothing is playing.
- **Restrained Resonance set.** Playing-row accent bar, transport art
  breathing ring, and scrub glow — all gated on `data-amp-reactive` and
  `prefers-reduced-motion`, all compositor-only.
- **Library queueing grammar.** Track rows are keyboard-focusable: `Enter`
  plays, `Q` queues, `Shift+Q` plays next (with toast feedback), and arrow
  keys walk the rows — no mouse required in a 60,000-track table.
- **Deck Snapshot.** A quiet camera button (or `Ctrl+Shift+S`) on every
  compact deck captures a skin-true polaroid of the deck — straight to
  clipboard and disk.
- **Shift+S skin surf.** Cycle the built-in skins live from anywhere;
  zero-hitch theming means the visualizer doesn't stutter when you land.
- **Ctrl+K resume row.** The Quick Play palette opens with your last listen
  ready to resume before you type a single character.
- **Music-first first launch.** The tutorial now starts with your music —
  the API-key screen is gone from the front of the funnel.
- **Craft regression matrix.** `npm run craft:matrix` captures 104 shots
  (4 shells × 6 skins × 4 views, plus all 8 deck skins) by driving the real
  Settings UI, then pixel-diffs against a local baseline.
- **Self-hosted fonts.** Inter, JetBrains Mono, and VT323 ship as woff2 —
  the Google Fonts origins are gone from the CSP entirely.
- **Bit-Perfect Exclusive lanes for macOS and Linux (experimental).**
  CoreAudio hog mode and ALSA-direct output join the Windows
  WASAPI-exclusive native engine in the same honesty framework.

### Changed

- Settings reorganized into registry cards with a jump-to-section chip TOC.
- Catalog views (Albums / Artists / Folders) share one header, skeleton,
  empty-state, and pagination language; the AlphabetRail is generalized.
- Mixes builds once per request and surfaces a "Seed changed — rebuild" chip
  instead of yanking all eight mixes out from under a mid-scroll user.
- Home loads honestly: skeletons ride real async state, and the hero absorbs
  active-station state (ON AIR + STOP) from the old side panel.
- README rewritten human-first, with the deep technical story in a
  "For the nerds" section at the bottom.

### Fixed

- Light-skin legibility: form controls on recessed display surfaces now read
  in display ink on Steel/Terminal/Ice/Miami.
- First-launch tutorial completion persists before dismissal and can no
  longer soft-lock on a failed settings write.
- EmptyLibrary's suggested-folder buttons render styled (their CSS had been
  missing since v1.1).

## [1.17.0] - 2026-07-03

The fifth flagship — the audiophile moat. NewAmp's first native code.

### Added

- **Bit-Perfect Exclusive (Windows).** Settings → Playback grew the toggle the
  audio-quality doc used to call "future phase": true **WASAPI-exclusive**
  output through a first-party native engine (vendored miniaudio, N-API,
  `native/newamp-audio/`). When it's on, tracks bypass Chromium, Web Audio,
  and the OS mixer entirely — ffmpeg decodes straight to raw PCM in the main
  process and a lock-free ring feeds the DAC on the WASAPI callback thread.
  - **Honest by construction.** The stream format is negotiated from the
    device's *native* exclusive formats; if your DAC's clock can't run the
    source rate, NewAmp resamples explicitly (SoX, precision 28) and *tells
    you* — it never ships miniaudio's hidden converter (which we caught
    silently resampling 44.1→48 k on real hardware during development, and
    now refuse at open time by comparing requested vs. internal format).
  - **The gold badge.** The transport's signal-path badge earned a fourth
    tone: gold `EXCLUSIVE` is the strict claim — lossless source, rate + bit
    depth + channel layout preserved, no DSD conversion. Anything less shows
    `EXCLUSIVE*` with the exact reason in the tooltip. 16-bit into a 24-bit
    device slot is still gold (zero-padding loses nothing); mono-to-stereo,
    rate conversion, or DSD→PCM honestly is not.
  - **No DSP means no DSP.** EQ, ReplayGain, crossfade, limiter, preamp and
    software volume are structurally out of the path and grayed in Settings
    with an explanation. Volume is your DAC's knob — same deal foobar2000
    gives you, now with the reasoning printed on the tin.
  - **Visualizers stay alive.** A 30 Hz playhead-aligned PCM tap flows from
    the native engine into a spec-faithful AnalyserNode emulation (Blackman
    window, 1/N FFT, -86/-10 dB byte mapping), so Eviland, MilkDrop, the
    detached projector, and Resonance react to exactly what the DAC is
    playing — proven by the gate: analyser energy with a *silent* Web Audio
    graph can only come from the native tap.
  - **Gapless over exclusive.** When the next track negotiates the identical
    device format, its PCM is spliced into the same ring at the exact frame
    boundary — no reopen, no gap. Rate changes re-open the device with a
    deliberate micro-gap (foobar2000 behavior). Pause releases the device
    after ~15 s so system audio comes back.
  - **Falls back like a grown-up.** Podcasts, cue-sheet segments, non-library
    files, a device that vanishes mid-track, another app holding the DAC —
    each falls back to the shared path per-track with the reason surfaced in
    Settings, never a silent dead toggle.
  - Gates: `smoke:exclusive-output` (addon: enum/probe/shared push, exact
    frame accounting; full exclusive HW pass behind
    `NEWAMP_EXCLUSIVE_SMOKE_HW=1`) and `smoke:exclusive-ui` (boots the real
    app, plays a FLAC through the native path, asserts exclusive engagement +
    clock advance + tap-fed analysers; earns `(bit-perfect)` on rate-matched
    hardware).

### Fixed

- **Windows taskbar icon renders again.** The 1.15.0 tray fix converted every
  ICO frame to BMP — including the 256 px frame that the taskbar/high-res
  shell path officially expects as PNG (the CHANGELOG even said the taskbar
  "looked fine" *because* it decoded PNG). `build/icon.ico` is now
  mixed-format (BMP < 256 for the tray, PNG @ 256 for the taskbar), rebuilt
  by the new committed `scripts/rebuild-icon.mjs` (do NOT use fix-logo.py —
  Pillow writes all-PNG and re-breaks the tray). Belt-and-braces: every
  BrowserWindow now sets an explicit window icon and the app declares its
  AppUserModelID (`io.newamp.player`) so taskbar identity/pinning resolve to
  our icon instead of a stale shell cache.
- `docs/audio-quality.md` no longer recommends audify/RtAudio for the native
  path — RtAudio's WASAPI exclusive mode is an unimplemented TODO; the doc
  now describes the shipped miniaudio engine and the observed hidden-resample
  trap it refuses.

## [1.16.0] - 2026-07-02

The master-plan release: four of the five planned flagships in one pass
(`notes/newamp-master-plan-fable5.md`), plus the go verdict on the fifth.

### Added

- **Clip Studio — save the moment that already happened.** While the Eviland
  Live stage is up, a WebCodecs ring buffer continuously holds the last 15
  seconds of the full composition (MilkDrop + scenes + reactor) with engine
  audio. Shift+R — or the "⏪ Save last 15s" button — muxes exactly that
  window and finishes it to a shareable MP4 (H.264/AAC, NVENC when your GPU
  offers it). No "wish I'd been recording" ever again. Skipped on the Lite
  performance tier. Gate: `smoke:clip-replay` proves ring → WebM → MP4 with
  real pixels and correct duration.
- **Wrapped Live — your year as a video.** Wrapped grew a WRAPPED LIVE
  button: a 30-second, six-chapter 1080×1920 film of your listening
  (count-up totals, artist bars, track reveals, genre arcs, the 24-hour
  listening clock, your sound) scored to your top track — with a Silent
  toggle for copyright-bot-wary sharing. Gate: `smoke:wrapped-live`.
- **NewAmp Remote — your phone is the remote.** Settings → Radio Brain now
  shows a QR code; scan it and your phone gets a full remote over Wi-Fi:
  album art, title, scrub, volume, prev/play/next, live via server-sent
  events — no cloud, no app store, no account. And the important part:
  **every Radio Brain route now requires this install's secret token**
  (playlist links embed it automatically). The server previously answered
  to anyone on the LAN; that hole is closed regardless of whether you use
  the remote. Audio streams also honor HTTP Range now — the advertised
  header used to be a lie, so phone scrubbing re-downloaded whole files.
  Gate: `smoke:remote` (401s, SSE, control whitelist, ranges) +
  `smoke:radio-brain` updated for auth.
- **Ask Your Library — plain English in Ctrl+K.** Type three or more words
  ("warm slow stuff from the 70s I haven't played this year") and the
  palette compiles it — fully offline — into year ranges, tempo caps,
  loved/rating filters, played-recency exclusions, and DNA-based
  warmth/energy re-ranking, showing "Understood: 1970s · slow (bpm ≤ 95) ·
  warm-leaning · not played this year" as chips so you always see exactly
  what ran. Unknown words still search titles/artists/genres. Short queries
  behave exactly as before. Gate: `test:query-intent` (10/10 canonical
  phrases).

### Under the hood

- Smart rules gained `notPlayedSinceMs` (recency exclusion had no primitive
  before) and optional DNA energy/brightness re-rank targets — boosts, never
  filters, so un-analyzed tracks still surface.
- New shared eviland-live compositor module powers both press-to-record and
  the replay ring; WebM→MP4 finishing lives in one place
  (`electron/video-mux.ts`).
- **Bit-Perfect Mode spike: GO.** Vendored miniaudio opened true WASAPI
  exclusive mode on real hardware at 48k and 44.1k via a custom N-API addon
  built with the local VS2022 toolchain. Full integration (the plan's §5) is
  next. Note: the previous audify/RtAudio plan was disproven — RtAudio's
  WASAPI backend cannot do exclusive mode.

## [1.15.0] - 2026-07-02

### Fixed

- **The Windows tray icon renders.** Every frame inside `icon.ico` — including
  the 16px one — was PNG-compressed, which Windows officially supports only
  for the 256px frame; the notification area drew the white placeholder while
  the taskbar (a different decode path) looked fine. The icon now ships
  classic BMP frames at nine sizes, and the tray hands Windows the .ico path
  so the shell picks the right frame for your DPI natively.
- **You can actually move the projector now.** The detached visualizer is a
  frameless window and had no drag region at all — it was literally immovable
  by mouse, which also meant you couldn't drag it to the monitor you wanted
  before going fullscreen. Moving the cursor now reveals a grab bar along the
  top ("drag to move · F11 fullscreen") that appears and hides with the
  control bar.
- **Detached no longer costs two players.** Three compounding fixes for the
  "suffers mightily when detached" report: (1) the main window's background
  throttling stays ON while a projector runs — everything that matters
  (producer, engine clock, bookkeeping) moved to timers in 1.14.0, so a
  covered/minimized main window now stops burning GPU on UI nobody can see;
  (2) the projector honors your visualizer performance tier instead of
  running hardcoded maximum quality for everyone (Lite → light, 4K opt-in →
  full; everyone else a balanced middle); (3) its render resolution is capped
  by tier, so a 4K TV no longer gets full-DPR MilkDrop + scene shaders
  unless you asked for exactly that.

### Added

- **Windows taskbar transport.** Hover the taskbar preview: previous /
  play-pause / next buttons, live glyph state, no icon files involved. The
  tray tooltip now names what's actually playing.
- **Export your whole library.** Settings → Library → Export metadata writes
  every tag plus your listening data (plays, ratings, loves, skips,
  ReplayGain) as JSON or spreadsheet-ready CSV — audit your collection or
  take it anywhere.
- **Four new Eviland scenes** (29 total): Spiral Galaxy, City Pulse — a night
  skyline that *is* the equalizer, Laser Storm, and Deep Jelly, a
  bioluminescent breather for the calm tier.
- **Eviland choreographs the drop.** When a section boundary lands with a
  real energy jump, the scene fast-cuts instead of lazily crossfading, an
  accent-white flash blows through and decays, and the accent layer surges
  to full — an event, not a strobe (8s cooldown, never on boot).
- **Every view can explain itself.** A quiet "?" next to Discover / Mixes /
  Living Tags titles reopens the view's intro card any time — the answer to
  "what is this?" no longer vanishes after first run. Sidebar entries gained
  function-first tooltips ("Rules that keep your library tagged
  automatically") instead of repeating their own names.
- **The whole app sees the record sleeve.** Now Playing carries an ambient
  wash — the current album art blurred into a color field breathing behind
  the panels (pure CSS, respects reduced motion). The title bar's artist and
  the fullscreen cinema overlay's artist/album are now links, closing out
  the "band names and albums are always clickable" sweep.

## [1.14.0] - 2026-07-02

### Fixed

- **The player's clock no longer freezes when you can't see it.** The audio
  engine polled `currentTime` on `requestAnimationFrame`, which Chromium
  stops entirely for occluded or minimized windows — so the moment the
  projector covered the main window (single monitor, projector fullscreen)
  or you minimized to the tray, everything gated on that clock silently
  stalled: the projector's scrub bar and time readout, gapless prepare and
  crossfade handoff, cue-sheet segment advancement, the sleep timer,
  scrobbling, and resume-state persistence. The clock now runs on a 100 ms
  timer — the UI notify path was already bucketed to 100 ms, so nothing
  renders more often; it just never stops. This was the root cause of most
  "player + projector at the same time" weirdness.
- **The projector's control bar resets when playback stops.** Clearing the
  queue or running it out no longer leaves the projector frozen on the last
  track's title and timestamp forever; the producer now ships an explicit
  idle signal and the bar returns to its resting state.
- **Unplugging the projector's monitor now actually rescues the window.**
  The display-removed recovery compared against a display id that could
  never match (the display is already gone from the list when the event
  fires — the check was dead code). It now asks whether the window still
  intersects any remaining display and snaps it to the primary when not.
- **Eviland Live clips record what's actually on screen.** Recording in
  eviland-live captured only the raw MilkDrop iframe — NewAmp's scene
  overlay and reactor event layers were silently missing from every saved
  clip. The recorder now composites the full layer stack live (audio muxed
  as before), so the clip matches the screen.
- **The projector respects the low-quality tier.** Its scene overlay ran at
  hardcoded high quality forever, regardless of the quality the main window
  pushed; it now skips entirely on low and re-scales on quality changes,
  matching the main window's performance floor.
- Closing the projector no longer briefly re-enables the toggle against a
  still-closing window, and reloading the main window while the projector is
  open no longer leaks a MessagePort per reload.

### Added

- **Eviland sees the record sleeve.** The dominant colors of the current
  album art are extracted per track and blended into the palette that drives
  the scene overlay, the reactor events, and the projector — a red album
  burns red, a teal album glows teal, in both windows, with zero configuration.
  Grayscale sleeves gracefully keep the theme palette. MilkDrop presets ship
  fixed colors; Eviland now paints with your collection's.
- **A second scene, played by the drums.** On the high quality tier, Eviland
  Live composites an independent accent scene over the base scene, its
  opacity driven live by kick/snare/vocal onset envelopes — it materializes
  on the hits and evaporates in quiet passages, and rotates on its own
  cadence so the base × accent pairing keeps recombining. Two full presets
  at once, mixed per-instrument: structurally impossible in a single
  MilkDrop preset.
- **The scene walk remembers too.** Scene rotation is now seeded by the
  track's visual-memory lineage (generation × root seed), not just the track
  id — when a favorite evolves a generation, its scene deck reshuffles,
  identically in the main window and the projector. The 1.12.0 "Eviland
  remembers" promise now covers every layer of the composition.
- **The projector is a real player now: volume.** The floating control bar
  gained a volume slider (0–200% perceptual, live-mirrors the main window),
  joining play/pause, prev/next, scrub, and fullscreen.
- **Song search results you can click.** Album-search matches on a song
  title (the ♪ line under a card) now open that album with the matching row
  scrolled into view and flashed. New `TrackLink` navigation everywhere:
  queue rows link their artist; Sounds Like rows, Album Context credits,
  same-year albums, bookends, longest cut, and the mini tracklist all link
  to their artist/album/track (double-click a mini-tracklist row to play
  it). The Now Playing album card's artist and album are links as well.

### Performance

- Hoisted per-frame `getComputedStyle` reads out of three visualizer render
  loops (the canvas-2D catch-all, particle-flow, and the shader modes) —
  theme colors now refresh twice a second instead of forcing a style recalc
  60×/s, and a dead variable that survived only via `void` suppression is
  gone.

## [1.13.1] - 2026-06-13

### Added

- **Projector controls.** When you detached the visualizer in 1.13.0, every
  control vanished with it — no way to play/pause, no way to scrub, no way to
  go exclusive fullscreen. The projector now has a floating control bar that
  appears on cursor movement (and hides again on idle, so the visuals stay
  primary): current track + artist, scrub bar, play/pause, prev/next,
  fullscreen toggle, and a close button. Double-click anywhere on the visuals
  toggles exclusive fullscreen; F11 toggles it from the keyboard; Esc always
  exits. Space plays/pauses, ←/→ scrub ±5s, Ctrl+←/→ change tracks. The
  control bar is driven by transport state piggy-backed on the existing 30Hz
  frame publish (no extra round-trips) and dispatches via a new
  `transport:command` IPC the main window subscribes to.

## [1.13.0] - 2026-06-13

### Fixed

- **Scrubbing works everywhere now — for real this time.** Every prior "seek
  fix" forwarded Range headers into Electron's `net.fetch(file://)`, which
  slices the bytes but answers a bare `200` with no
  `Content-Range`/`Content-Length`/`Accept-Ranges` — Chromium's media stack read
  that as "endless live stream" and snapped every scrub back to 0:00, on every
  format including plain MP3/FLAC. NewAmp now answers byte ranges itself with
  real `206 Partial Content` responses (`electron/audio-serve.ts`), and the
  first play of exotic formats (.wma/.ape/.wv/.dsf/…) streams a
  synthesized-header float-WAV whose constant bitrate maps any byte range to an
  `ffmpeg -ss` seek — so even the live transcode path is scrubbable from second
  zero. Gates: `smoke:playback-seek` (4 serving paths, real `<audio>` scrub
  assertions) and a production-stack scrub assert in `smoke:ui-detached-viz`.
- **The detached visualizer actually works.** The projector window was black
  for three compounding reasons, all fixed: (1) the frame MessagePort was wired
  at `ready-to-show`, racing module evaluation — the port could be dropped
  forever; the detached renderer now signals `renderer-ready` and the port is
  wired only then. (2) The frame producer ran on `requestAnimationFrame` in the
  main window, which the compositor throttles to ~1fps the moment the projector
  occludes it — the headless producer now runs on a steady 30Hz timer and the
  main window's background throttling is disabled while a projector is
  attached. (3) The detached window rendered the bare WebGL field instead of
  the flagship composition — it now hosts the REAL Eviland Live stack: the
  butterchurn (MilkDrop) iframe fed live time-domain audio over the port, the
  new scene overlay, and the reactor event canvas, with the WebGL renderer as
  fallback. The frame bus also self-heals from lost messages/acks instead of
  freezing. Gate: `smoke:ui-detached-viz` boots the real app, scrubs, opens the
  projector, and asserts non-black pixels via `capturePage`.

### Added

- **Eviland Live: 25 scene overlays + the full MilkDrop catalog.** The
  butterchurn layer now loads the base + Extra + Extra2 + MD1 preset packs
  (hundreds of real MilkDrop presets, up from ~170). On top of the field, a new
  transparent WebGL2 **scene overlay** (`src/visualizer/scene-overlay.ts`,
  `src/visualizer/scenes/`) runs 25 hand-built audio-reactive scenes —
  lightning veins, voronoi pulse, kaleido bloom, liquid metal, neon grid,
  orbit swarm, fractal zoom, comet trails, constellation, and 16 more — each a
  self-contained shader driven by the 24-band reactor (voice envelopes, onset
  impulses, beat phase, stereo field, spectral shape). Scene choice is a seeded
  walk keyed on track × section × your evolved visual-memory lineage, layered
  under MilkDrop's own randomized rotation — the resulting composition is
  effectively unreplicable on anyone else's machine. Scenes crossfade on
  section boundaries, skip entirely on `performance: low`, and any scene that
  fails to compile is blacklisted for the session without taking the layer
  down. Gate: `smoke:scene-overlay` compiles and renders every scene and fails
  any that are black, static, or audio-deaf.

## [1.12.0] - 2026-06-11

### Added

- **Eviland remembers your library.** The visualizer now has long-term memory of
  your taste — the first music visualizer anywhere to have one. Every song you
  play with Eviland active learns a persistent visual plan: its section
  fingerprints, the look each section earned, and a seed lineage that *evolves*
  with your listening (a song's visuals gain a generation at 8, 32, 96, and 256
  plays — loving a track evolves it early; old favorites stabilize). Plans
  survive restarts: when you come back to a song, its choruses bloom the same
  visual they did last week. New songs aren't blank either — a track that sounds
  like one Eviland already knows (Audio DNA cosine ≥ 0.92) borrows a derived
  visual lineage from its sonic cousin, disclosed in the UI as "Borrowed visual
  DNA from …". Identity is seed lineage, never stored frames: one tiny row per
  track (≤1 database write per completed play), deterministic re-derivation,
  ancestor seeds preserved forever (your visualizer stays recognizable as it
  evolves), and an `algoVersion` contract — enforced by a CI guard — so engine
  upgrades can never silently break a remembered look. A small "REMEMBERS THIS
  SONG · gen 2 — 17 plays · 4 sections known" badge fades in on track start
  (pin it for per-track reset and lineage details); Settings shows how many
  tracks Eviland knows, with a one-click purge. Non-library playback (dropped
  files, podcasts) is never memorized. The detached projector reads memory but
  never writes it. (`src/visualizer/eviland-memory-*.ts`,
  `eviland-director.ts`, `electron/library.ts` `track_visual_memory`)

### Performance

- Echo FBOs now free with 30-frame hysteresis instead of thrashing ~32MB of
  allocations when a look's echo hovers at the activation gate; fluid forces
  come from a preallocated pool (was ~25–30 allocations per audio frame);
  section fades use an allocation-free config lerp with an owned-palette
  alias-safety contract; attribute locations are cached per program (was ~16
  driver lookups per frame); the transport signal-path badge re-renders only
  when its readout actually changes (was 10×/sec during playback). All
  zero-value changes: operator goldens untouched, GPU smoke byte-identical.

### Fixed

- DSD format badges now recognize 48kHz-base DSD streams (DSD64 at 3.072MHz)
  instead of labeling them bare "DSD".

## [1.11.0] - 2026-06-10

### Added

- **Eviland Liquid — the fluid is now the picture.** Eviland's Navier-Stokes solver
  (previously an invisible warp layer) gained a full dye field advected by the
  divergence-free velocity: the kick floods colored dye up from the floor, the snare
  jets near-white, hats sparkle the top edge, and vocals/leads bloom at their own
  band height — each of the 24 detector bands gets a deterministic emitter position
  and hue, so a busy mix reads as a liquid that knows the song. Silence stills the
  surface (energy-gated dissipation); stereo pans become visible currents. The
  Director's `liquid` archetype now drives it (`liquidMix` 0.78–0.95); all other
  looks remain byte-identical at `liquidMix=0`, and existing shareable seed codes
  keep their exact pre-dye looks. Falls back to the procedural warp path on low-tier
  hardware. (`src/visualizer/eviland-fluid.ts`, `eviland.ts`, `eviland-operators.ts`,
  `eviland-randomizer.ts`)
- **Format badges.** Small monospace chips on Library rows, album track lists, and
  Now Playing: lossless codec (FLAC/ALAC/APE/…), hi-res rate (24/96-style, derived
  from the real sample rate), DSD64–DSD1024, and notable lossy bitrates. Mid-bitrate
  MP3s stay un-chipped so the library doesn't drown in tags.
  (`shared/format-badge.ts`, `src/components/FormatBadges.tsx`)
- **Signal-path badge on the transport.** Live "44.1k DIRECT" vs "44.1k→48k
  RESAMPLED" indicator showing whether Chromium is resampling the playing track;
  click-through to the full readout in Settings → Audio.
  (`src/components/SignalPathBadge.tsx`)
- **The six MilkDrop-variety engine primitives.** What gives MilkDrop presets
  their character is now native to Eviland: a q-variable system (8 preset-internal
  scratch slots with tempo-locked sine/tri/saw/square LFOs, referenceable from any
  channel), per-pixel radial warp profiles (zoom/rotate/swirl/decay as functions of
  radius²), per-channel RGB trail decay ("everything drifts toward a hue"), a
  moving warp centre, a video-echo pass (zoomed/rotated/flipped self-composite,
  FBO allocated only while active, off on low tier), and a field-snapshot
  crossfade that kills the mid-fade tear on section changes. All default-neutral:
  existing looks render bit-identically. (`src/visualizer/eviland-operators.ts`,
  `eviland.ts`, `eviland-director.ts`)
- **26-look morphing pool.** Eviland's Director now rotates through 26 archetypes
  (was 6): the original six retuned to exploit the new primitives, plus vortex,
  inkwell, supernova, cathedral, phosphor, ribbonfall, pulsar, mosaic, deepfield,
  solarflare, glasshouse, stormfront, heartbeat, carousel, firefly, tidal, prism,
  echochamber, wireframe, and emberveil — each with a distinct motion signature,
  palette behavior, and emitter usage, enforced forever by a pairwise-distance
  distinctness test plus a GPU capture harness
  (`npm run smoke:eviland-arch-distinct`) that proves no two looks are
  metrics-twins. Note: shareable look seeds map into the expanded pool, so an old
  seed code may resolve to a different look than before.
  (`src/visualizer/eviland-randomizer.ts`, `eviland-director.ts`)

### Removed

- **Sonic Atlas.** The 2D library-projection view never earned its sidebar slot —
  its data source (Audio DNA) is analyze-on-demand, so the map opened empty for
  most libraries. The view, its PCA projection math, and its smoke are gone
  (~900 LOC including the dead `live-input.ts`). The **Audio DNA engine stays**:
  Sounds Like, Living Tags `dna.*` fields, Wrapped's vibe, and seed-vibe mixes are
  untouched.

### Performance

- `cloneConfig` uses `structuredClone` instead of a JSON round-trip (called on every
  section boundary), the placeholder shader pair compiled-then-discarded at boot is
  gone, and the dead `classic()` randomizer wrapper is deleted.

### Fixed

- **The release gate runs green again.** Five pre-existing breaks: the display app
  logo (177KB) and README logo (1.25MB) both exceeded the startup-bundle smoke's own
  size caps — recompressed to 101KB webp / 495KB png with no visible change — the
  smoke still grepped for an `index-*.js` entry chunk after the vite entry was
  renamed to `main`, `smoke:artist` couldn't load `artistFacts.ts` under Node's
  native type-stripping because the wiki helper chain used an extensionless import
  plus a tsconfig path alias (now relative, extensioned imports that resolve
  everywhere), and the `ui-visualizer` smoke probe still scripted the pre-redesign
  fullscreen controls — an always-visible preset rail and per-control toolbar
  buttons that no longer exist. The probe now opens the preset picker panel like a
  user and drives quality/performance/art/clean/palette/reactivity/auto-VJ through
  their real keyboard shortcuts; the OS-fullscreen assertion was dropped as
  unobservable under the smoke's hidden window. (`build/logo-app.webp`,
  `assets/github/logo-readme.png`, `scripts/startup-bundle-smoke.mjs`,
  `src/api/artistFacts.ts`, `src/api/albumFacts.ts`, `src/lib/wiki.ts`,
  `electron/main.ts`)

## [1.10.0] - 2026-06-07

### Audio quality

- **Hi-res no longer gets crushed.** The ffmpeg fallback path (ALAC, AIFF, APE, WV,
  TTA, DSD…) used to hardcode 16-bit / 48 kHz, irreversibly downsampling and
  truncating every 24/96 lossless file on playback. It now emits **32-bit float PCM
  at the source sample rate** (the only lossless PCM-in-WAV format Chromium decodes —
  24-bit int WAV is unsupported), and DSD gets a pinned high-precision SoX resampler
  instead of ffmpeg's uncontrolled default. (`electron/transcode.ts`)
- **"Limiter off" is now a true bypass** — the DynamicsCompressor is disconnected from
  the graph, not left in-chain at unity ratio with its lookahead delay. The toggle is
  click-free (an ~8 ms master dip across the rewire) and mute-safe (a routing failure
  force-restores direct output instead of silently killing audio). (`engine.ts`)
- **Hi-res WAV export too** — "Export to WAV" now writes 24-bit at the source rate
  (`pcm_s24le`), matching playback fidelity instead of crushing to 16-bit/48 kHz.
- **Smoother track transitions** — ReplayGain gain changes use a 6 ms ramp (was 20 ms),
  killing the loudness "swell" on the first beat of a new track (preamp stays on the
  slider-class 15 ms ramp so dragging it glides like volume/EQ).
- **Honest sample-rate readout** in Settings → Audio: shows the playing track's source
  rate vs the live engine rate, flags when Chromium is resampling the track, and now
  warns when the device rejected the requested rate (instead of silently showing the
  wrong one). Seeks before metadata loads retry on `loadedmetadata` instead of being
  dropped, and no longer emit a misleading "VBR" warning.
- **`docs/audio-quality.md`** documents the full signal path, the real ceiling of a
  Web-Audio player, and the native WASAPI-exclusive backend roadmap for true
  bit-perfect output.

### Fixed

- **Scrubbing no longer resets the song to the start.** The big one. The native
  audio protocol now forwards the media element's HTTP `Range` header to
  `net.fetch`, so Chromium gets a real `206 Partial Content` and can seek mp3 /
  flac / m4a / aac / ogg / opus. `engine.seek` also stops collapsing to 0 when
  duration is briefly unknown (`NaN`/`Infinity`), and seeks while paused now
  reflect immediately. (`electron/main.ts`, `src/audio/engine.ts`)
- **The seek bar now actually scrubs.** Every scrubber (the transport, all 9 deck
  skins, the fullscreen visualizer) was a *controlled* `<input>` whose value was
  yanked back to the playhead ~10×/sec, fighting the drag. They now share one
  uncontrolled-while-dragging `ScrubBar`. (`src/components/ScrubBar.tsx`)
- **The Now Playing waveform is a real scrubber.** The big "Overview" waveform was
  decorative; click or drag it to seek. (`src/components/views/NowPlayingView.tsx`)
- **The detached visualizer works as a projector.** It no longer opens a black
  window: a headless Eviland frame producer now publishes to it independently of
  the on-screen visualizer, so you can pop Eviland onto a second monitor and keep
  using NewAmp normally. Opening it no longer force-switches the main window's
  look, and the projector follows the Director's choreography.
  (`src/visualizer/eviland-producer.ts`, `frame-bus.ts`, `detached/main.tsx`)
- **Searching Albums now finds songs too.** Typing a track title (e.g. "helter
  skelter") surfaces the album that contains it, with the matching song titles
  shown under the cover. (`electron/library.ts`, `AlbumsView.tsx`)

### Added

- **Projector toggle in the sidebar.** Pop Eviland out into its own window from
  anywhere — no need to enter fullscreen first. (`src/components/Sidebar.tsx`)
- **Clickable artist & album names across the app.** The transport marquee and the
  Albums grid (and more) route to the artist/album. (`Transport.tsx`,
  `AlbumsView.tsx`, `EntityLink`)
- **`docs/newamp-2.0-plan.md`** — a synthesized, prioritized build plan for the
  Eviland MilkDrop-parity engine sprint and the NewAmp 2.0 feature set.

### Performance

- **No more idle 60fps loops.** The adaptive-quality monitor now stops when nothing
  is subscribed; the engine's playback-clock rAF suspends while paused/ended and
  re-arms on play/seek; the Now Playing spectrum + VU meter stop polling while
  paused (and the VU meter now reads true L/R levels instead of a faked split).
  (`adaptiveQuality.ts`, `engine.ts`, `NowPlayingView.tsx`, `frame-bus.ts`)

## [1.9.0] - 2026-06-02

### Added

- **Eviland Live — the MilkDrop rip-off.** A new default visualizer that uses the
  real MilkDrop engine (butterchurn) for its warp/zoom/decay field and composites
  NewAmp's causal per-instrument reactor on top: kick rings, snare spike-stars,
  hat sparkles, vocal blobs, and a bass terrain glow, all drawn as a transparent
  additive overlay over the MilkDrop field. MilkDrop's animations, NewAmp's ears.
- **New transport buttons.** The play/pause/prev/next/stop/shuffle/repeat controls
  are now crisp inline SVG (theme-colored, optically weighted) with a play↔pause
  crossfade, springy press feedback, and an audio-reactive glow on the play button.
  Proper WCAG 2.2 semantics for the shuffle/repeat toggles.

### Changed

- **Visualizer interaction.** Double-click now toggles fullscreen↔windowed
  (was: exit). Esc or right-click exits the visualizer.
- **Cinema mode** now fully hides the bottom transport (title, scrubber,
  prev/play/next) and reveals it on hover or cursor-near-bottom.
- **Detach is a standard toolbar control** in the visualizer (no longer buried in
  Eviland's settings).
- **Eviland (engine) de-collapsed.** The Director runs by default and the
  randomizer's multi-hue palette now actually drives rendered color (it was
  previously ignored — everything rendered in the theme's single accent hue). The
  oscilloscope is on by default; the kick-zoom bounce, the central "sun", and the
  wash-to-accent force are all dialed back.

### Fixed

- **MilkDrop no longer stutters between presets.** Preset rotation is now weighted
  by real switch cost (enabled shapes/waves = the megabuffer allocation storm,
  not equation length), the warp mesh is lighter, and the synchronous shader
  compile gets a render gap so it stops colliding with active paints.
- **Text is readable across all 14 themes.** Raised the failing `--muted` values,
  added an accent-text token so accent-colored labels pass contrast on light
  themes, fixed the terminal theme (body text was ~1.2:1), and made the
  visualizer overlay labels theme-aware.

## [1.8.0] - 2026-05-30

### Added — Eviland becomes a generative visual engine

Eviland grows from a reactive visualizer into an instrument-aware **generative
engine** — native MilkDrop-class animation, endless original looks, and an
autonomous conductor. The whole engine is also extracted as a reusable
zero-dependency package, [`@eviland/core`](packages/eviland-core/README.md).

- **Native MilkDrop-class waveform layer.** The signature oscilloscope, drawn
  into the feedback field before the warp so it advects into evolving symmetry —
  with line, radial, and spectrum-bar modes.
- **Operator engine.** Every look is now data (`OperatorConfig`): a base value
  plus audio-feature bindings per visual channel, evaluated and clamped each
  frame. Serializable, interpolatable, shareable. The classic Eviland look is
  one such config (so nothing changed unless you ask it to).
- **Randomizer.** Mints endless musically-coherent looks across six archetypes
  (tunnel, kaleidoscope, liquid, lattice, nebula, strobe), each with a generated
  palette. Every look is a short **shareable seed** (e.g. `K7Q2-9XMF`) you can
  copy, paste, and recall exactly — on any machine.
- **Director (auto-VJ).** An autonomous conductor that reads the song's structure
  (sections, energy tiers, novelty) and crossfades looks on the beat — gentle in
  intros, intense on drops, and recalling a section's earlier look when it
  returns so the visuals rhyme with the music. Hands-free, fully overridable.
- **Live input — engine groundwork.** The capture layer that lets Eviland react
  to a microphone / line-in / audio interface, with voice DSP (AGC / noise-
  suppression / echo-cancellation) forced off so music stays intact. The
  device-picker UI is a follow-up; this release ships the typed capture core.
- **Detached / undocked visualizer window.** Pop the visualizer out into its own
  window (Detach button in the fullscreen Eviland controls), pick a display,
  drag it to a second monitor or projector, and fullscreen it there — while the
  main NewAmp window stays fully browsable. Audio + the reactor stay in the main
  window; the per-frame data streams to the detached window over a low-latency
  message port, so the two stay perfectly in sync, and the feed auto-recovers if
  the main window reloads.
- **Video recording.** Capture the visualizer to WebM (VP9/Opus) at 60 fps /
  12 Mbps with the audio muxed in, via a parallel tap that never touches your
  audible output.
- **New fullscreen controls** for Eviland: Randomize, Director toggle, a
  copyable seed with paste-to-recall, and a waveform-mode selector.
- **`@eviland/core`** — the renderer, reactor, operator engine, randomizer, RNG,
  director, and recorder packaged as a zero-dependency, framework-agnostic
  library. Embeddable like Butterchurn, but it listens. (Staged in-repo and
  build-isolated; the standalone npm publish is a tracked follow-up. NewAmp's
  build now fails on any drift between the package copy and `src/visualizer/`.)

### Fixed

- **Visualizer no longer stutters under the Director.** The Director was deep-
  cloning its entire operator config every frame (a `JSON.parse(JSON.stringify)`
  round-trip ~60×/sec); steady-state frames now reuse the owned config by
  reference, cutting the dominant per-frame GC churn behind the reported lag.
- **Library / History / Loved "load more" no longer duplicates or cross-
  contaminates rows.** Page de-duplication now runs inside the state updater
  (race-safe), and the library's infinite scroll drops any page that resolves
  after you've changed the search, instead of appending stale results.
- **Detached window failures are now visible and recoverable.** A failed open,
  port hand-off, or renderer crash tears the window down, reports the reason in
  the controls, and releases the frame feed — no more stuck "open" state.

## [1.7.4] - 2026-05-30

### Fixed — Eviland: real structure, no more gold/cream

Eviland reacted correctly but still rendered as a "gold/cream reactive smoke." Built a headless **visual** capture harness (`scripts/eviland-capture.mjs`) to actually see the output frame-by-frame — the GPU smoke proves *reactive*, this proves *structured* — and traced the cream to three real sources, none of which were the per-instrument emitters:

- **The palette ramp's warm highlight stop.** Every bright region was driven to the single cream `light` colour, so any energetic frame went monochrome-cream regardless of the (correct) reactivity. Highlights now lean on the accent and the field's *own* hue, so loud events read as their instrument colour (cyan kick-rings, magenta bursts), with a guard that recolours any residual blown-out highlight toward the accent.
- **The zoom focal point.** A constant inward zoom piled feedback energy into a permanent bright blob at centre; lowered the base zoom so the tunnel still punches on kicks but doesn't accumulate a static core.
- **A cream section-flash.** The structural-memory section-change flash was a screen-filling cream burst; it's now a small accent-coloured core that pulses with bass/energy.

Plus: field decay cut (0.92–0.985 → 0.80–0.91) and curl turbulence near-eliminated so shapes stay crisp instead of smearing into haze; kaleidoscope always-on and strongly mixed; spectrum "sun" brightened with a clean centre eye.

### Changed — album-art overlay more transparent

Fullscreen album-cover overlay lowered from 0.72 → 0.55 opacity so it sits more gently over the visualizer.

## [1.7.3] - 2026-05-30

### Changed — Eviland goes full MilkDrop

Pushed Eviland's look hard toward the classic MilkDrop aesthetic while keeping its 24-band per-instrument causal reactivity:

- **Kaleidoscopic symmetry** — the feedback sampling coordinate is folded into N-fold mirror symmetry, so the zoom/swirl flow becomes a fractal kaleidoscope. The segment count (off / 3 / 4 / 6 / 8) is chosen per song-section from the structural-memory seed, and the mirror blend rises with energy — so verses and choruses get visibly different symmetry.
- **Stronger motion** — roughly 2× the zoom (deeper kick-driven tunnel rush), rotation, and swirl, so beats visibly pull and spiral the whole field.
- **Crisp spectrum overlay** — a radial 24-ray "sun" drawn from the live band magnitudes each frame, additively, *before* the feedback captures it — so the structure is continuously drawn and then swept into the swirling flow (the signature MilkDrop "draw-and-advect" look). The sun's color drifts over time.
- **Bolder color cycling** — ~2.3× the per-frame hue rotation, so trails sweep through the palette as they age.

## [1.7.2] - 2026-05-30

### Changed — Eviland looks like MilkDrop now, not a white cloud

Eviland reacted correctly but rendered as a flat, pale cloud because three things each pushed toward "diffuse white": the feedback field only applied soft curl-noise (no structured motion), emitters were soft gaussian blobs, and the final composite was raw additive (`field + bloom`), so accumulating energy summed straight to white. Rebuilt the shaders to adopt MilkDrop's actual visual language while keeping Eviland's 24-band causal reactivity:

- **Feedback field** now does a MilkDrop-style per-frame transform of the previous frame — inward **zoom** (kick/bass-driven tunnel rush), **rotate + swirl** (energy/beat-driven spirals), curl-noise detail on top — and a **YIQ hue-rotation** so trails drift through colors as they age (the signature MilkDrop palette feel). Section seed sets the spin direction so a returning chorus rhymes.
- **Emitters** sharpened from blobs into crisp shapes: thin bright ring (kick), spike-star burst (snare), pinpoint + cross-streak sparkle (hat), tighter blob (vocal), hard-rim core.
- **Composite** maps field intensity through a dark→accent→light **palette ramp** (color depth, not a brightness ramp to white), with bloom mixed at half weight as glow rather than flood, ACES tone-mapping, and dark-grounded empty zones.

### Fixed — album-art overlay invisible on Eviland

The fullscreen album-cover overlay used `mix-blend-mode: screen` at 0.34 opacity, which washed out completely against Eviland's bright field. It now uses normal blending at 0.72 so the cover reads clearly over any visualizer.

## [1.7.1] - 2026-05-30

### Changed — Eviland is now the default visualizer

New installs open the fullscreen visualizer on Eviland (was Neon Waves), so the causal, reacts-to-every-instrument experience is what you get out of the box. Existing users keep whatever they last selected. On machines without WebGL2 float support Eviland still falls back to MilkDrop automatically — one binary, no configuration needed.

## [1.7.0] - 2026-05-30

### Added — Eviland: a visualizer that reacts to every instrument

NewAmp's new flagship visualizer, and a genuinely new thing in the space. MilkDrop/butterchurn — and Plexamp, Specterr, Synesthesia, and essentially every Shadertoy audio shader — react to roughly three lumped frequency bands fed through one shared loudness envelope, so everything pulses together on the bass. Eviland is built the opposite way: it runs a **24-band perceptual (mel) spectral-flux onset detector** with per-band adaptive thresholds and refractory gating, so each instrument fires its *own* visual event. A kick blooms a red shockwave from the floor; the snare cracks white off-center and drives a chromatic split; hi-hats sparkle along the top edge; the lead/vocal drifts mid-screen tracking spectral brightness; the bass is a horizon line the whole scene rests on. Frequency maps to vertical position and stereo to horizontal, so it reads like a spectrogram you can feel.

It renders into a **WebGL2 RGBA16F ping-pong feedback field** — the persistent, flowing substrate MilkDrop fakes with per-pixel equations — advected by curl noise, with a dual-Kawase bloom pyramid and ACES tone-mapping for the glow. Two things no other player's visualizer does:

- **Structural memory** — a self-similarity novelty curve detects section boundaries (verse → chorus → drop), fingerprints each section, and when a section *returns* the field visually rhymes with its earlier appearance instead of starting over.
- **Anticipation** — a kick inter-onset-interval tempo estimate yields a beat phase, so on confident tempo the visuals *lead* the downbeat (wind up ~80 ms early) instead of chasing it.

Color is derived from the album-art palette plus the live spectral centroid (brightness → hue) and flatness (tonal → saturated, percussive → washed out). It self-throttles across three quality tiers and returns to real MilkDrop on machines without WebGL2 float support — one binary, no separate lite build. New audio infrastructure: dedicated stereo L/R analyser taps in the engine for width/pan. Eviland is the default-prominent first entry in the visualizer picker.

## [1.6.2] - 2026-05-30

The visualizer pass: the MilkDrop "lag between animations" is gone, the whole visualizer is more reactive, there are five new GPU shader modes, and the fullscreen controls are no longer a wall of cryptic buttons.

### Fixed — MilkDrop "lag between animations"

The hitch on every preset change wasn't the crossfade — it was butterchurn JIT-compiling a preset's MilkDrop math (GLSL + JS) synchronously on the iframe's main thread the instant the timer fired, picking uniformly at random from the full ~120-preset pack so the heaviest presets hit as often as the cheapest. Three compounding fixes in `src/butterchurn-iframe/main.ts`:
- **Complexity-biased selection** — presets are weighted by equation-body size (a cheap compile-cost proxy); rotation draws ~85% from the lighter half, ~15% heavy for variety, cutting average compile time per swap.
- **Idle-callback dispatch** — `loadPreset` now runs inside `requestIdleCallback` so the remaining compile lands between paints instead of mid-frame.
- **Visibility + pause gating** — rotation skips while the window is hidden or playback is paused, so it never compiles a preset nobody can see or hear.

The crossfade stays smooth (~2 s) and the 22 s dwell is unchanged.

### Added — five new GPU shader visualizers

Kaleido Bloom (N-fold mirrored kaleidoscope, petals pulse with treble, bloom with bass), Aurora Storm (stacked band-driven aurora ribbons with beat-triggered lightning), Fractal Pulse (a real folded-IFS escape-time fractal, fold angle from mids, iris bloom on the beat), Starfield Warp (radial hyperspace tunnel, streaks stretch on the beat), and Spectral Tunnel (a polar tunnel carved by the 16-band spectrum with beat-locked ring shockwaves). All run on the GPU through the existing single-pass shader and are audio-reactive across the full spectrum.

### Changed — the visualizer is more reactive, especially mids and highs

Butterchurn was fed raw, smoothed time-domain bytes with no boost, so it reacted less than the in-house canvas modes. It now reads the unsmoothed onset analyser (a new `engine.getOnsetTimeData`) with a gentle pre-emphasis + soft-clip, so kicks punch and presets shimmer. Across the shader and canvas modes the reactivity mapping was rebalanced so mids and highs lift toward the bass instead of the low end carrying everything: the shader energy formula now includes treble, and `boostFrequencyData` gained per-band mid/treble lifts.

### Changed — redesigned fullscreen visualizer controls

The old top bar was ~15 identical cryptic pills (LOW/4K/PERF, palette-name-only, REACT Punch, SCREEN, CLEAN, ESC X…) plus a 20-button preset rail. It's now a slim bar — `[‹] [active preset ▾] [›] … [⚙ Settings] [?] [✕]` — with a grouped preset picker, a settings panel of plain-language rows (a segmented Auto/4K/Lite quality control, named palette/reactivity controls, clearly-labeled toggles, and a Capture/Copy/Record cluster), and a `?` keyboard-shortcut legend. Every existing handler, setting, and shortcut is preserved; this is purely a discoverability redesign.

## [1.6.1] - 2026-05-29

A performance + feel release layered on 1.6.0. The headline is **Resonance** — the whole UI reacts to the live audio — but the biggest practical win is that **hardware acceleration is finally on by default**, which alone makes the entire app feel dramatically lighter.

### Fixed — hardware acceleration was disabled by default (the single biggest perf bug)

Since the project's first commit, `electron/main.ts` required an opt-in env var (`NEWAMP_ENABLE_HARDWARE_ACCELERATION=1`) to use the GPU; the default path called `app.disableHardwareAcceleration()` plus `disable-gpu`/`disable-gpu-compositing`/`disable-gpu-rasterization`. This was a holdover from the GPU-less cloud sandbox the app was built in. On real machines it forced the WebGL visualizer onto SwiftShader (CPU) and CPU-composited the entire UI — the dominant cause of sluggishness.

Hardware acceleration now defaults **on**. Software rendering is used only for smoke tests, an explicit `NEWAMP_DISABLE_HARDWARE_ACCELERATION=1` opt-out, or automatic crash recovery: a GPU-process crash drops a sentinel file under `userData` so the next launch falls back to software once, then retries — a one-off crash self-heals, a persistently broken driver stays on software. Chromium's own GPU blocklist still handles known-bad drivers.

### Added — Resonance: the whole UI reacts to the live audio

Every other player themes from static cover art or confines audio-reactivity to a dedicated visualizer window. NewAmp now makes the *application chrome itself* respond to what's playing: a live album-art accent wash behind the content, a beat pulse on the transport, and energy-driven glow — all driven by one `requestAnimationFrame` loop writing a handful of `:root` CSS custom properties (`--amp-energy`, `--amp-beat`, `--amp-bright`), consumed by compositor-only `transform`/`opacity` rules. No per-frame React.

It self-throttles: an honest adaptive-quality tier (a static device-capability probe plus a tiny live rAF-frame-budget monitor — not the abandoned "pressure" machinery) drops Resonance to a single accent pulse, then to a clean static theme, on weak hardware — and `prefers-reduced-motion` disables it entirely. New Settings rows: **Performance** (Auto / High / Lite) and **Resonance** (Auto / On / Off). The accent palette is extracted from album art on `requestIdleCallback`, cached per track.

### Fixed — volume slider did almost nothing past ~15%

`setVolume` mapped slider position directly to gain (linear). Because loudness perception is logarithmic, nearly all the audible change was crammed into the bottom of the travel. Volume now passes through a perceptual cubic taper below unity (the 1.0–2.0 boost zone stays linear, still caught by the limiter), so equal slider movement produces roughly equal perceived loudness change across the whole range.

### Fixed — Folders view stutter on large libraries

`getFolders` ran a full `SELECT … FROM tracks` (60k+ rows) and re-derived the folder tree in JS on *every* folder click; that row set only changes on a library rescan, so it's now memoized and invalidated precisely at the four track-mutation sites (upsert, prune, metadata patch, album-art apply). Folder navigation on a large library is no longer an O(library) operation per click.

### Added — clickable artist and album names

Artist and album names across Library, History, and Playlist/queue rows are now links to their artist/album views (a reusable `EntityLink`), reusing the existing navigation store.

### Fixed — rating a song no longer changes the album's rating

The database split (per-track vs per-album ratings) was already correct; the Albums view was *displaying* the live track-score average as the album rating when an album had no explicit rating, so editing a song appeared to move the album. The editable album control now reflects only the explicit album rating, with the track average shown as a separate read-only hint.

## [1.6.0] - 2026-05-29

Production-ready & special: macOS becomes a first-class platform, CI lands as a
safety net, the deferred Butterchurn `unsafe-eval` CSP gap is closed (release gate
green again), the visualizer gains a GPU particle engine + capture/share, **NewAmp
Wrapped** ships as the hero shareable, and a local-first social/profile foundation
arrives. Every feature ships with a smoke wired into CI.

### Added — Local-first social foundation: reviews, lists & an exportable profile

The groundwork for "Letterboxd for listening" (per `docs/online-social-roadmap.md`),
local-first and private by default — no account, no server, nothing uploaded. A new
**Profile** view (sidebar · Ctrl+K) lets you set an identity ("five bags"
favorites, bio), write **reviews/diary entries** on tracks/albums/artists (with an
optional 0–100 score), and build ranked **lists** ("best local recordings", "hidden
gems"). Every object carries a `local` / `friends` / `public` privacy flag (stored
now; it only governs what a future export/sync would include). One button exports a
**self-contained static HTML profile page** built from your profile, lists, reviews,
and top artists — the offline, shareable artifact the roadmap requires before any
account service. New `reviews` / `lists` / `list_items` / `profile` SQLite tables,
a full `social:*` IPC surface, and a CI-safe `smoke:social` covering CRUD,
reordering, privacy normalization, reopen-persistence, and the export bundle.

### Added — NewAmp Wrapped (daily / weekly / monthly / yearly listening recap)

A new **Wrapped** view (sidebar · Ctrl+K) turns your real local listening history
into a recap with a range switcher — **Today, This Week, This Month, This Year,
All Time**. Each range shows time listened, tracks played, unique artists, top
tracks/artists, genre breakdown, a 24-hour listening clock with your peak hour,
your longest daily streak, discoveries (tracks first played in the window), loved
count, and a DNA-derived "vibe" (energy + brightness → a mood label). One tap
renders a portrait, on-brand **shareable PNG card** (saved or copied to the
clipboard via the Phase-4 capture path). All computed locally from
`play_history` — no account, no upload. New `library.getWrappedStats(range)` +
`history:wrapped` IPC; CI-safe `smoke:wrapped` verifies the aggregation across all
five ranges plus the IPC/view wiring.

### Added — Visualizer capture & share (PNG stills + WebM clips)

The fullscreen visualizer gains **CAPTURE**, **COPY**, and **● REC** controls. Still
capture uses the main process's `webContents.capturePage`, so it works for every
mode — including the sandboxed Butterchurn iframe and the WebGL2 particle field —
and can save a PNG or copy it straight to the clipboard. **REC** streams the live
visualizer canvas through `MediaRecorder` to a WebM clip you can save. New IPC:
`media:capture-page` / `media:copy-png` / `media:save-capture`, exposed via
`captureVisualizerPng` / `copyPngToClipboard` / `saveCaptureBytes`. CI-safe
`smoke:viz-capture` locks the wiring end to end.

### Added — Particle Flow: a GPU (WebGL2) particle flow-field visualizer

A genuinely new fullscreen visualizer that no Winamp-lineage player has had: up to
~140k particles simulated **entirely on the GPU** via WebGL2 transform feedback.
Each frame a curl-noise flow field advects every particle, with the field strength
driven by bass, high-frequency turbulence by treble, and a radial burst fired on
each detected beat edge — then they're drawn as additive glowing points over a
faded previous frame for motion trails. It reuses the existing pre-volume
`AudioFeatures` contract (no new audio plumbing) and is offered as the "Particle
Flow" preset + in the balanced Auto-VJ pool. If WebGL2 / transform feedback is
unavailable it falls back to the non-eval canvas-2D Milkdrop painter, so it never
goes dark. (WebGPU was evaluated but isn't reliably exposed in Electron 42, so the
engine rests on hardware-accelerated WebGL2 instead.) Verified by a deterministic,
audio-free `smoke:particle-flow` that renders the real module to a WebGL2 context
and asserts it draws non-blank, audio-reactive frames.

### Fixed — Butterchurn `unsafe-eval` scoped to a sandboxed iframe (security)

The renderer ran with `script-src 'self' 'unsafe-eval'` since 1.5.2 — granted to
the *entire* renderer just so Butterchurn could compile MilkDrop preset math via
the Function constructor. `smoke:security` (which asserts the renderer has no
`unsafe-eval`) had therefore been red since 1.5.2, so the strict `release:gate`
was red and 1.5.2–1.5.7 shipped via the `:local` gate variants.

Butterchurn now runs inside `butterchurn-iframe.html`, a same-origin frame whose
own CSP scopes `'unsafe-eval'` to just that frame; the main renderer is back on
`script-src 'self'`. Web Audio nodes can't cross a frame boundary, so the main
renderer reads the pre-volume visualizer analyser (`engine.getTimeData`) and posts
~1 KB of time-domain bytes per frame to the iframe, which feeds them to
butterchurn's `render({ audioLevels })` path (bypassing its internal analyser). If
the frame can't host butterchurn (load error / missing feature / 8s mount
timeout), the visualizer falls back to the existing non-eval canvas-2D Milkdrop
painter so it never goes dark. Verified by a new deterministic, audio-free
`smoke:butterchurn-sandbox` (loads the frame under its real CSP and asserts it
reports `mounted`); `smoke:security` is green again and back in CI + the gate.

### Added — GitHub Actions CI (safety net)

The smoke suite (~120 scripts) had never run in CI; nothing gated regressions
before release, which is how the 1.5.4/1.5.5 hotfix regressions shipped. New
`.github/workflows/ci.yml` runs `typecheck` + `build` + the CI-safe pure-node
smokes (`build-lock`, `library`, `visualizer`, `build-provenance`,
`release-secrets`, `reliability`, `completion-audit`) on every push/PR. New
`.github/workflows/release.yml` is a tag-triggered macOS/Windows/Linux matrix
that packages per-OS, signs/notarizes when secrets are present (skips cleanly
when absent), and drafts a GitHub release. Smoke classification documented in
`docs/ci.md`.

### Added — macOS as a first-class platform

NewAmp now builds for macOS (Apple Silicon + Intel) alongside Windows and Linux.
`package.json` gains a `mac` target (dmg + zip, arm64 + x64, hardened runtime),
`build/icon.icns` (generated from `icon.png`), and `build/entitlements.mac.plist`
granting the JIT entitlements the renderer needs (Butterchurn `unsafe-eval` +
sql.js WASM) plus library-validation relaxation for the bundled ffmpeg binary.
`scripts/package.mjs` handles `--mac`; `npm run package:mac` produces launchable
`.dmg`/`.zip` artifacts. Verified end-to-end: the packaged `NewAmp.app` boots the
real packaged renderer over `newamp-app://` (new `smoke:mac-launch`).

`scripts/notarize-artifacts.mjs` (`npm run release:notarize`) submits to Apple's
notary service and staples the dmg, reading credentials from the environment and
skipping cleanly when absent — so unsigned dev builds work immediately
(right-click → Open) and notarized builds light up once an Apple Developer ID is
configured. macOS `.dmg`/`.zip` artifacts are tracked as `optional` entries in
the release checksum manifest (hashed/validated when present; their absence does
not invalidate a Windows/Linux build).

## [1.5.7] - 2026-05-21

Expert-pass cleanup driven by a 10-reviewer parallel ultrareview of the 1.5.3 → 1.5.6 changeset. Five blockers, ten high-priority items, two cleanup passes — all applied, all verified by smoke.

### Added — `npm run typecheck` and `prebuild` gate

The frontend has had no type checking in CI since the project's start. `build:electron` runs `tsc` against the electron tsconfig only; the renderer was built by esbuild, which strips types without checking them. That's why the 1.5.4 `AlbumSummary` literal landed in production with `rating: undefined` fields and the 1.5.5 visualizer regression shipped despite the existence of strict-mode TypeScript.

New `typecheck` script runs `tsc -p tsconfig.json --noEmit && tsc -p electron/tsconfig.json --noEmit`. Wired into `prebuild` so every release build fails on type errors instead of letting them ship. This single change closes the structural gap that produced both prior hotfix releases.

### Fixed — `engine.seek` false-positive "seek failed" warnings

The 1.5.4 VBR-seek diagnostic captured `target` in a closure but read `currentTime` at fire time. Every seekbar drag from one position to another queued dozens of timers, each comparing a stale `target` against the most recent `currentTime`, generating ~30 false-positive warnings per drag. A seek followed by Next within 220ms reported the track change itself as a "VBR seek failure."

Now snapshots `activeDeckIndex` + the deck element + a monotonic `seekSeq` at schedule time. The verify timer bails if any of the four invariants changed (graph torn down, deck swapped via crossfade, src changed via track-load, or a newer seek superseded). Dead `expectedNotRestart` variable removed. The 220ms magic number is now a named `SEEK_VERIFY_MS` constant with documented tuning rationale.

### Fixed — `AlbumsView` rendered `undefined` rating fields

The 1.5.4 `AlbumSummary` interface gained `rating` and `ratingScore`, but the `pendingNavigation` literal in `AlbumsView` was never updated. Vite/esbuild strips types without checking them so this shipped silently. The new typecheck gate caught it. The fix also asynchronously hydrates the real album rating from `api.getAlbumRating` so the slider lands on the correct value when the user navigates to an album from Now Playing.

### Fixed — Wheel-volume hijacked the main process with sync disk writes

`setVolume` called `api.setSettings({ volume })` synchronously, which called `writeFileSync` on the whole settings JSON. The 1.5.4 fullscreen-viz wheel handler made the entire viz canvas wheel-active — 60-120 wheel events/sec on fast scroll became 60-120 sync settings writes/sec, blocking the main process for ~300-900ms/sec on HDD.

Web Audio gain ramp + in-memory store update stay synchronous (real-time control). Disk persistence now debounces on a 250ms trailing edge. Bursts coalesce; last value wins.

### Fixed — `AlbumScoreInline` was the perfect-storm class of silent failure

The Now Playing album-rating widget was the same anti-pattern that caused the 1.5.4 empty-albums bug, plus three more:
- Silent `.catch(() => setAlbumRating({rating:0, ratingScore:null}))` — a transient IPC failure looked identical to "user never rated this album" and the next slider drag would silently overwrite the real stored rating.
- `void handleChange(score)` swallowed write-path rejections; UI showed the new value briefly then snapped back without explaining why.
- No cancel-on-unmount race guard: a slow IPC followed by a fast track-skip could overwrite the next track's displayed rating with the previous track's resolved write.
- Early-return for tracks with empty `albumArtist` tag hid the rating UI for albums that AlbumsView could display via the SQL `COALESCE(NULLIF(album_artist,''), artist)` fallback.

Now logs failures with `[newamp]` prefix + preserves prior state on read failure; wraps the write in try/catch; uses a write-generation counter to discard stale resolves; mirrors the SQL `COALESCE` fallback by using `track.albumArtist || track.artist`.

### Fixed — `AlbumsView.setAlbumScore` write bypassed 1.5.6 hardening

The same file's read-path catch was hardened in 1.5.6, but the write path still let IPC throws become unhandled rejections and reported lying "Rated X 75/100" status messages for writes that never persisted. Now wrapped in the same pattern.

### Fixed — `disconnectAudio` swallowed real graph corruption

The catch logged both benign double-disconnects (expected during rapid preset thrash) and real Web Audio graph corruption at the same `console.warn` level — making the FFT-freeze regression class indistinguishable from preset noise. Now matches `InvalidAccessError | not connected` for the benign case and escalates everything else to `console.error`.

### Fixed — Backfill migration for pre-1.5.4 album ratings

The 1.5.4 schema split shifted album ratings into `album_ratings`, but never backfilled from the old cascade pattern that wrote the same `rating_score` to every track in an album. Users who rated albums under 1.5.3 saw them vanish from Now Playing and lost the taste-mix boost.

New one-shot migration (gated by a flag in a new `library_meta` table) walks `tracks`, finds groups where every track shares the same nonzero `rating_score`, and `INSERT OR IGNORE`s into `album_ratings`. Preserves any explicit album rating set since 1.5.4.

### Fixed — `setAlbumRatingScore` / `getAlbumRating` throw on invalid input

Both methods used to return `null` for three semantically distinct outcomes: missing input / successful clear / "this album doesn't exist." Renderer callers couldn't distinguish them and lied about clears. Now throw on missing `albumArtist` or `album` so the caller's try/catch surfaces "this album has no album-artist metadata" instead of silently succeeding.

### Fixed — IPC argument order aligned to `(albumArtist, album)`

`library:get-album-tracks(album, albumArtist)` and the new `library:get-album-rating(albumArtist, album)` had opposite argument orders. Both `(string, string)`, both type-check, silently wrong if mixed up. All IPC handlers + renderer call sites now use `(albumArtist, album)` to match the schema PK order.

### Improved — Canonical `albumKey()` in `shared/album-key.ts`

The same `(albumArtist, album) → string` composite key was inlined in four places with subtle inconsistencies (one had a `'Unknown Artist'` fallback, others didn't). Three other album-key conventions exist elsewhere in the codebase (`shared/discover.ts`, `getStats`, `albumFacts.ts`) with different separators and normalization. One canonical helper now lives in `shared/album-key.ts`; the four 1.5.4-era rating sites use it. NUL (`\0`) separator survives every printable character the user can put in a tag.

### Improved — `getAlbums` failure visibility (already in 1.5.6, extended)

The 1.5.6 catch hardening for `getAlbums` becomes the pattern: console.error + scan-status banner + state reset. The N17 cleanup pass aligns the rest of the 1.5.4-era catch handlers to match.

### Added — Smokes that lock down the regressions

- `scripts/rating-smoke.mjs` gained album-rating round-trip coverage: set/get/clear/NOCASE/persist-across-reopen, the explicit "must not touch track ratings" guarantee that the 1.5.4 split was meant to fix, the explicit `getAlbums()` query after `album_ratings` rows exist (locks down the 1.5.4 LEFT JOIN ambiguous-column regression class), and assertions that `setAlbumRatingScore`/`getAlbumRating` throw on empty input.
- `scripts/ui-visualizer-smoke.mjs` + `electron/main.ts` probe gained a multi-sample liveness check that reads the engine's FFT sum via a new `__newampSmoke.analyserFftSum()` hook. The 1.5.5 broken-render-loop class shipped because the smoke only asserted on `milkdropMounted='true'`, which is set BEFORE the render loop runs. Software WebGL drops shader paint (so pixel deltas always return 0 in the smoke), but the FFT path catches the actual load-bearing signal — if the analyser subtree is alive, FFT bytes are non-zero. Audio fixture extended from 4.2s to 30s so audio is still playing during the sample window.
- `scripts/chrome-state-smoke.mjs` — broken `VIZ_TOP_NAV_KEY` assertion deleted (constant removed in 1.5.6).

### Improved — `FullscreenVisualizer` wheel handler

Switched from `document.querySelector` lookup to a `useRef` on the root `<div>`. Listener now tracks DOM identity correctly even under future remount patterns. Stable refs dropped from the `useEffect` deps array.

### Lesson

Loud failures over silent fallbacks, applied at the build pipeline level. The 1.5.4 → 1.5.5 → 1.5.6 hotfix sequence happened because vite/esbuild silently shipped TypeScript-invalid code, then a silent `.catch(() => setAlbums([]))` made the SQL ambiguous-column error look like "library is empty," then a smoke that asserted on a setup flag missed a broken render loop. The structural fix is enforcing the type checker on every build *and* preferring loud errors over defensive silence in catch handlers. Both are in.

## [1.5.6] - 2026-05-20

Hotfix for a 1.5.4-introduced Milkdrop break.

### Fixed — Milkdrop visualizer was broken

The 1.5.4 "adaptive resolution scaling" experiment reassigned the `ensureSize` function declaration mid-effect (`ensureSize = function adaptiveEnsureSize() { ... }`). The reassignment itself works at runtime in modern V8 — the actual failure was likely stale closure capture or the adaptive-scale logic misbehaving once it took over. The smoke happened to slip past because it asserted on the `milkdropMounted` data attribute, which is set BEFORE the render loop runs.

Ripped the adaptive logic out. The simpler render loop is restored. The other 1.5.4 perf wins — mesh 32×24, presetMaxPixels cap at 2.5M for butterchurn, slower preset rotation with shorter blend, silent-sink GainNode for reactivity — are kept because they do real work without depending on the broken adaptive path.

### Lesson

Loud failures over silent fallbacks: this is the second 1.5.x release where a quiet "improvement" hid a complete feature break (1.5.4: empty albums; 1.5.5: dead Milkdrop). The smoke layer needs an actual frame-render assertion, not just `milkdropMounted: 'true'`. Filed as follow-up.

## [1.5.5] - 2026-05-20

Hotfix for a 1.5.4 regression that hid every album.

### Fixed — Albums view showed nothing

The 1.5.4 album-rating work added a `LEFT JOIN album_ratings` to `getAlbums`. The join made `album` and `album_artist` exist on **two** tables, so every existing `WHERE` clause (`album != ''`, `lower(album) LIKE ?`, `lower(COALESCE(NULLIF(album_artist,''), artist))`) became an ambiguous-column reference and SQLite threw on every call. `AlbumsView`'s `.catch` silently swallowed the error and rendered an empty list — so the symptom looked like "library is empty" instead of "query is broken."

Reverted to the unchanged aggregation query and now merge album ratings in via a single bulk `Map` lookup — same number of round trips, no join fragility.

### Improved — getAlbums failures are now visible

`AlbumsView`'s catch handler now logs the error to the console *and* shows the failure message in the scan-status banner. Future backend regressions will surface as a visible error message instead of looking like an empty library.

## [1.5.4] - 2026-05-20

Live-feedback pass driven by playing the 1.5.3 build. Eight user-reported issues from a single listening session, all fixed.

### Fixed — Milkdrop visualizer reactivity

In 1.5.3 the audio graph was rewired so volume sits upstream of the limiter. The new shape made the AnalyserNode tap a leaf node (no path to `AudioDestinationNode`), and Chrome's audio graph optimizer culled the subtree — leaving butterchurn with a frozen FFT buffer that always read zero. The visualizer rendered shaders but had no real audio to react to.

Added a `silentSink` (0-gain `GainNode`) that routes both the visualization analyser and the unsmoothed onset analyser to `ctx.destination`. The subtree now stays alive, butterchurn receives live FFT data again, and no audible signal is added.

### Fixed — Milkdrop fullscreen performance

Three layered changes:
- Mesh dropped from 48×36 to 32×24 (butterchurn upstream default). 2.25× cheaper per vertex, and butterchurn pays the vertex cost for *both* presets during a blend.
- Preset rotation slowed from every 16 s with 3.6 s blend to every 22 s with 2.2 s blend. The blend window is the GPU-hot moment.
- Adaptive resolution scaling: an EMA of paint time drives a dynamic downscale when frames miss budget for sustained intervals, then recovers gradually. Same trick AAA games use as "dynamic resolution."
- Render budget for butterchurn capped at ~2.5 M pixels regardless of the 4K toggle. Butterchurn's shader fragments dominate at high resolution and don't gain visible detail above 1440p.

### Fixed — Fullscreen visualizer top nav

A user could toggle "TOP NAV" off in a previous session and find themselves with no nav and no way to bring it back (the "VIS MENU" recovery button was too subtle). Deleted the persistent toggle entirely. Auto-hide on cursor idle is the only mode now — moving the cursor to the top edge always reveals the toolbar.

Buttons also tightened to 26 px height with 0 / 8 px padding for a denser, less obtrusive look.

### Fixed — Arrow keys cycled visualizer presets AND skipped song time

In fullscreen visualizer, the shortcut layer resolved ←/→ to `seek-backward`/`seek-forward` while the visualizer's own keydown handler simultaneously called `cyclePreset(±1)`. Every preset change scrubbed five seconds in the same direction. The shortcut layer now returns `null` for unmodified ←/→ when `fullscreenVisualizer` is true. Ctrl+arrows still resolve to previous/next track everywhere; Up/Down still nudge volume.

### Fixed — Album rating cascaded over per-song ratings

The AlbumsView rating slider rewrote `rating_score` on every track in the album, silently destroying per-song nuance. New `album_ratings` table holds album-level ratings independent of `tracks`. Now Playing exposes both a "Song" slider and an "Album" slider so the user can rate the song they're hearing without leaving the screen. The mix scorer factors `albumRatingBoost(track, context)` so a 100/100 album lifts each of its songs by +2.0 in TasteContext — well-rated albums float their songs into Auto DJ and mixes without overwriting per-song detail.

### Improved — Fullscreen volume bar

Fully hidden by default. A faint silhouette appears when the top nav is up (signalling "grabbable"); direct hover/focus fades it to fully visible. Mouse wheel anywhere over the fullscreen visualizer also drives volume (Shift+wheel for coarse step). Wheel handling is bound to the visualizer root only — library and Now Playing scroll behavior is untouched.

### Added — Seek-failure diagnostic

VBR MP3s without a Xing/Info header (typical of LAME `--vbr-old` era encodes — Tyler hit this on Comets on Fire / Field Recordings from the Sun) can't be seeked accurately by HTMLAudioElement. The engine now detects the "seek requested past 1 s, landed near 0" pattern and logs a diagnostic with the source URL and target. A full fix (AudioBuffer fallback or re-encode pipeline) is queued for a follow-up.

## [1.5.3] - 2026-05-20

Bug-fix and review-followup pass. Six review-flagged blockers, nine high-priority issues, and ten nice-to-haves resolved, plus durable regression smokes for the algorithmic surfaces (seed-vibe similarity, Sonic Atlas region playback, random album sort).

### Fixed — Volume past 100% no longer clips the limiter
- The audio graph was source → eq → replayGain → masterGain (volume) → limiter → destination, so anything above 1.0× volume amplified the post-limiter signal and pushed the device into clipping. Volume now lives upstream of the limiter and the analyser tap is parallel to the master/limiter chain, so the visualizer stays reactive even at silent volume.

### Fixed — DNA cosine similarity returned [0.5, 1] instead of [0, 1]
- `dnaCosineSimilarity` was remapping cos via `(cos + 1) / 2`, which made sense only if vectors could be anti-aligned. Audio DNA vectors are non-negative, so cos already sits in [0, 1]; the remap collapsed the seed-vibe gate's discriminative power into a flat half-range.

### Fixed — Random album sort crashed every call
- `albumSortOrder('random', …)` emitted `MIN(id) ^ xorMask`, but SQLite has no `^` operator. Every shuffle, every Random sort, every random-album quick-pick was an SQL parse error since 1.5.2. Replaced with a bounded three-term polynomial seeded by Knuth multiplicative hashing.
- `normalizeAlbumRandomSeed` clamped any seed above 2^31-1 to the same ceiling, so consecutive `Date.now()` values collapsed to a single normalized seed and the "random" sort was deterministic across the session. Replaced clamp with modulo so the low 31 bits of entropy survive.

### Fixed — Sonic Atlas crashed when empty
- AtlasView dereferenced `atlas.points[…]` before the projection finished. Now falls back to no-center when the atlas is empty.

### Fixed — Close-button behavior reset on settings patch
- A `closeButtonBehavior: undefined` patch (sent by every other settings save) overwrote the user's preference back to the default. Now preserves the stored value when the patch field is missing.

### Fixed — `useEffect` shadowed `window.performance`
- The fullscreen visualizer's local state variable named `performance` shadowed `window.performance` in some closures and broke frame-rate measurement on cold boot. Renamed to `perfTier`.

### Fixed — Long-session float drift on visualizer accumulators
- `radialRotation`, `tunnelTwist`, `orbitalRotation`, and `mercuryHueDrift` accumulated monotonically and lost trig precision after roughly thirty minutes. Wrapped with explicit modulo.

### Improved — Audio analyzer sample-rate awareness
- Kick-band, bass, low-mid, mid, and treble bins are now derived from sample rate plus FFT size instead of hardcoded for 48 kHz. The visualizer now reads correct bands on 44.1 kHz devices.
- Dedicated unsmoothed `AnalyserNode` for kick onset detection so the smoothed analyser can keep its visual smoothing without lying about transients.

### Improved — DNA index caching
- `LibraryStore.buildDnaIndex` cached and invalidated on writes. Harmonic and taste mix calls used to re-parse the entire DNA table per invocation.

### Improved — Seed-vibe scoring hoisted out of the per-candidate loop
- `createSeedVibeContext` precomputes genre tokens, normalized artist/album, and the seed-side DNA snapshot once per mix call instead of per candidate.

### Improved — Wikipedia client extracted to a shared helper
- `src/lib/wiki.ts` now owns the user-agent, response shape, and search/lookup helpers. Artist and album fact paths share the implementation and surface non-OK responses via `console.warn` instead of silently failing.

### Tests
- New: `scripts/seed-vibe-smoke.mjs` covers identical DNA, genre+era branch, same-artist floor, all-null inputs, BPM half/double match, and the `applySeedVibeGate` formula.
- New: `scripts/album-random-sort-smoke.mjs` reproduces the `^` parse failure, asserts close seeds decorrelate, and stresses int64 bounds at MIN(id) ≈ 2^30.
- Tightened: `scripts/sonic-atlas-smoke.mjs` now asserts `nearestAtlasPoints` clamp bounds, monotonic distance ordering, and floor behavior.
- Tightened: `scripts/ui-visualizer-smoke.mjs` requires a positive `milkdropMounted` data attribute (set after `butterchurn.createVisualizer` succeeds) instead of only checking the absence of an eval error.

### Deferred
- Butterchurn CSP iframe sandbox. Splitting the audio graph across an iframe boundary is the right fix but breaks the live analyser path. Tracked in `docs/butterchurn-csp-iframe-plan.md`.

## [1.5.2] - 2026-05-20

Production-readiness pass. A long autonomous run resolving real-world bug reports plus a complete visualizer reactivity overhaul, deck art improvements, smarter Mixes, and in-app navigation from Now Playing.

### Added — Liquid Mercury visualizer (new preset)
- Twelve metaball blobs that each couple to a distinct frequency band. Beat-driven attractor flips collapse and explode the cluster on every kick; bass drives a slow palette wheel rotation so the whole field cycles color with the music.
- Connection lines fuse between overlapping blobs for a true metaball look without per-pixel sampling cost. Center caustic flare on each kick gives the bass a physical compression effect.
- Available in fullscreen preset list and Auto VJ rotation.

### Added — In-app navigation from Now Playing
- Clicking the artist name in Now Playing now jumps to the Artists view filtered to that artist (instead of opening a Wikipedia search).
- Clicking the album name jumps to the Albums view with that album pre-selected.
- External Wikipedia search moved behind a small ↗ icon next to each name.
- Backed by a `pendingNavigation` action on the player store consumed by AlbumsView/ArtistsView on next render.

### Added — Sonic Atlas region playback
- Click any atlas point to pin it (warn-colored halo + crosshair stays put through panning).
- New footer: pick 6/12/24/48 nearest tracks, then PLAY REGION / QUEUE NEXT. The cluster is hydrated via the new bulk `getTracksByIds` IPC, preserving atlas-neighborhood order so the result reads as a smooth journey through sound space.
- Hover overlay now shows album + year + genre alongside the DNA breakdown.

### Added — Living Tags in Now Playing
- The "NewAmp Notes" filler is replaced with a Living Tags chip panel that shows every DSL-derived tag currently assigned to the playing track. Empty-state hint points the user at the Living Tags view to write their first rule.

### Added — First-visit onboarding cards
- Discover, Mixes, Living Tags, and Sonic Atlas each show an inline explainer card on first visit. Dismissed state persists per view via `localStorage`. The cards explain what each surface does, what to expect, and where to click next.

### Added — Spectral-art fallback in the transport bar
- Bottom transport bar falls back to a deterministic SVG cover (FNV-1a hashed from artist+album) whenever the embedded art URL 404s. No more music-note placeholder for tagless tracks; every track in the library gets a distinct visual identity.

### Added — Visualizer auto-hide top nav + working volume slider
- Cursor near the top edge (≤110 px) reveals the toolbar; moving away hides it after 1.4 s. Keyboard shortcuts also reveal briefly. Fullscreen no longer feels cluttered.
- Right-side volume meter is now a real volume slider (native `appearance: slider-vertical` + `writing-mode: vertical-lr`). Drag or scroll to set volume. The animated RMS fill bar remains visible behind the input.

### Added — Deck art pan + TV static
- Jukebox + Retro TV decks now slowly pan the album cover up→center→down on a 14 s loop instead of showing a static crop. Honors `prefers-reduced-motion`.
- Retro TV deck overlays animated SVG snow noise that intensifies when no track is tuned in, becomes subtle film grain during playback.

### Changed — Mixes seed coherence
- Both Harmonic Mix and Taste Match now gate candidate tracks by audio DNA cosine + genre Jaccard + era proximity + artist match before scoring. A Lykke Li track no longer shows up in a mix seeded from Everclear ('90s alt-rock) just because it's heavily played; seed-vibe similarity becomes a multiplicative gate on top of the existing taste score.
- New `shared/seed-vibe.ts` exports `seedVibeSimilarity(track, seed, ...)` returning 0–1.

### Changed — Visualizer reactivity overhaul
- Beat decay tightened from `0.76` to `0.5` so kicks read as discrete events instead of one smeared envelope. Fixes Tempo Pulse lag.
- New `kick`, `beatEdge`, and `flux` features on `AudioFeatures`. `kick` is unsmoothed narrow-band (0–140 Hz) energy. `beatEdge` is true exactly on the frame a transient fires. `flux` is positive-only spectral delta.
- Galaxy: hue now coupled to `bass + beat + time`; bass ring color cycles instead of staying accent-colored. Beat edges trigger a 14-particle burst.
- Radial: beat-driven rotation accumulator; consumes `features.bands[i]` per spoke; maxR pumps with beat.
- Tunnel: accumulator twist (silent → frozen, kick → accelerate); polygon side count modulates with beat; per-ring radius scales with bass + beat.
- Orbital Rings: outer-bar count cut from `96+ring*18` to `48+ring*10`. The expensive `shadowBlur` is now gated on `features.beat > 0.42` — only fires during transients. Rotation derives from `orbitalRotation` accumulator.
- Tempo Pulse: rising-edge trigger via `features.beatEdge`; debounce drops from 110 ms to 70 ms.
- Confetti: alpha + size pulse on beat; angle accelerates with beat; hue shifts on edges.
- Burning Cloud (shader): swapped hardcoded red→orange→amber ramp for palette()-driven hues so the cloud actually cycles color with the music. Palette mix factor raised from 0.16 to 0.55+bass*0.4.
- Plasma Grid (shader): tile frequency cut from 10–20× to 3–5× per axis so we see flowing plasma cells instead of "a wall of tiny windows". Plasma now dominates over the grid lines.
- Neon Ribbons (shader): replaced raw `atan(p.y, p.x)` with periodic `cos(theta*n)` — eliminates the broken seam along the negative x-axis.

### Fixed — Wikipedia integration (Blood Orange + similar artists)
- Added `Api-User-Agent` header per Wikipedia's UA policy; anonymous browser UAs were getting throttled which made lookups silently fail.
- `MUSIC_DISAMBIGUATORS` extended with `musical project`, `music producer`, `producer`, `artist` so artist aliases (Blood Orange = Devonté Hynes) resolve directly to `Page (musical project)` etc.
- Album panel in Now Playing falls back to the artist's Wikipedia entry when no album-specific page exists, with a "showing the artist instead" note. No more empty panel for off-catalog releases.
- Fetch errors no longer kill the candidate chain — failure on one disambiguator continues to the next.

### Fixed — Album rating overlapping Play Album buttons
- Album rating widget was rendering wider than its 230 px container and crashing into the action buttons row. Now lives on a dedicated full-width row beneath the action buttons, no overlap at any viewport.

### Fixed — Rating a song no longer "rates the album"
- Album Context panel in Now Playing was showing an averageScore that updated whenever the user rated a single song, making it look like the album received a rating. Now only displays the average when 3+ tracks (or ≥50%) of the album are actually rated; otherwise shows `(N of M tracks rated)` to make it clear it's an aggregate.

### Fixed — Random album reshuffle producing identical orderings
- The polynomial random sort could occasionally hit near-identical orderings when two Date.now() seeds shared the same `% 991` or `% 7919` residue. New formula XORs `MIN(id)` against the seed before the polynomial mix so tiny seed deltas always produce visibly distinct orders.

### Fixed — Vintage Computer (terminal) theme legibility
- Ink, ink-2, muted darkened to pass AA contrast against the `#c4c1aa` beige panel. Accent, accent-dim, warn, and error similarly darkened. The whole theme now reads cleanly instead of fading into the background.

### Fixed — Milkdrop (Butterchurn) visualizer actually renders
- Root cause: `script-src 'self'` in the renderer CSP blocked butterchurn-presets from compiling preset shader math via the Function constructor (used by butterchurn at preset load). The catch in `startButterchurn` fell back to the placeholder fallback without surfacing the EvalError. Added `'unsafe-eval'` to script-src — the compiled code only comes from the locally-bundled butterchurn-presets package (connect-src still restricts what can be fetched).
- `electron/settings.ts.normalizeVisualizerPreset` whitelist now includes `liquid-mercury` so the new preset persists across sessions instead of silently reverting to default.
- `ui-visualizer-smoke` extended end-to-end: clicks the Milkdrop button, waits for canvas mount, asserts no CSP/eval errors fire. Also covers Liquid Mercury with full pixel-output validation.
- Probe timeout extended from 20s to 60s to fit the new battery + butterchurn shader compilation time.

### Fixed — Engine tick re-rendering NowPlayingView 60× per second
- The audio engine's RAF tick was notifying state listeners on every frame. Each `notify()` fired re-renders of every Zustand-subscribed component including the 1900-line NowPlayingView. Throttled to 10Hz integer buckets — seek + duration changes still fire immediately — for a 6× cut in per-second React work. Largest contributor to the "gets heavier after an hour" report.

### Fixed — Folders view capped at 7 visible folders
- The `grid-rows-[minmax(180px,0.42fr)_minmax(0,1fr)]` layout kept the folder list at most 42% of available height even when no folder was selected. Now the layout adapts: full height for the folder list when nothing is selected (~25 folders on an 800px window), split layout when a folder IS opened so tracks have room.

### Community feedback round
- Sidebar scrolls when the window is too short to show all nav + tools (outer `<aside>` now owns the scroll; inner nav drops its own overflow for a single unified scrollbar).
- New `closeButtonBehavior` setting in Settings > Shell/Layout: choose between minimize-to-tray (default) or close-the-app for the X button.
- Albums view (artist sort) gets a vertical A-Z letter rail on the right edge for quick jump-to-letter scrolling. Letters with no matching artist render dimmed. Skips leading articles so "The Beatles" jumps to B.

## [1.5.1] - 2026-05-19

### Removed
- Hotdog Deck skin and assets. The compact-deck registry, CompactPlayer case, CSS block, mask + shell PNGs, and ui-deck/skin/discover smoke entries all gone. The shape-changing decks lineup is now Windowshade, Winamp Classic + Industrial, Record Player, Jukebox, Cassette, Discman, Retro TV.

## [1.5.0] - 2026-05-19

Living Library — a content-aware, programmable upgrade to the library.

This release adds six new surfaces (Audio DNA, Sounds Like, Living Tags DSL + workshop, Sonic Atlas, Library Radio Brain, Spectral Cover Art) plus a Bit-Perfect Path through the audio chain and a sidebar redesign. Performance regression smoke detects 5× drops on a synthetic 60 000-track library; current numbers are 5–12× under budget.

### Added — Sonic Atlas (new this release)
- 2D projection of the library's per-track Audio DNA via zero-deps PCA (power iteration + Hotelling deflation, deterministic across runs). Pan, zoom, click to play, Shift-click to queue next. Hover for the DNA breakdown.
- Axis hints surface the dominant DNA dimensions per axis ("+brightness & +rolloff" / "+rms & +dynRng") so the user can read what the axes actually mean.
- `atlasPointColor` keys an HSL palette on brightness (hue) + dynamic range (saturation) + low-band energy (lightness) so adjacent dots read as adjacent colors at a glance.
- Smoke `smoke:sonic-atlas` synthesizes three sonic clusters, asserts each cluster's centroid stays > 0.15 apart in the projection, verifies determinism, hit-testing, axis hints, and color formatting.

### Added — Bit-Perfect Path (new this release)
- `AppSettings.audioBitPerfectPath` + `audioPreferredSampleRate` (44.1 / 48 / 88.2 / 96 / 176.4 / 192 / 352.8 / 384 kHz). When enabled, the Web Audio AudioContext is created at the preferred rate so Chromium's resampler is a pass-through on matching sources.
- `AudioEngine.setPreferredSampleRate` honors the setting at next AudioContext boot; falls back to the device default if Chromium rejects the rate.
- Settings → Audio gains a Bit-Perfect row: toggle, rate picker, live "Live AudioContext rate" indicator showing whether the requested rate is actually active, and a collapsible setup guide that documents WASAPI Exclusive on Windows + ALSA `hw:` / PipeWire bit-perfect on Linux.
- Honest copy: true kernel streaming (WASAPI Exclusive, ASIO, ALSA `hw:` direct) requires a native PortAudio addon — tracked as Phase 2.

### Added — Audio DNA Engine
- Per-track perceptual feature vectors extracted via ffmpeg → 22 050 Hz mono PCM → hand-rolled FFT. Eleven dimensions per track: RMS, dynamic range, spectral centroid (brightness), spectral flatness, 85th-percentile rolloff, onset density, and five normalized band energies (low → high).
- `tracks.dna_json` + `dna_analyzed_at` columns persist the vectors. `setTrackDna` / `getTrackDna` / `getTrackIdsMissingDna` / `getAllTrackDna` / `getDnaStats` round-trip them.
- Background batch analysis runs three concurrent ffmpeg workers so library-wide DNA fills 2.5× faster on multi-core machines without contending with active playback.
- Smoke `smoke:dna` covers pure-math determinism, FFmpeg-driven analyzer round-trip on real FLAC fixtures, persistence, similarity math, and source-link assertions across the IPC, preload, types, and renderer surface.

### Added — Living Tags DSL (the moonshot)

### Added — Audio DNA Engine
- Per-track perceptual feature vectors extracted via ffmpeg → 22 050 Hz mono PCM → hand-rolled FFT. Eleven dimensions per track: RMS, dynamic range, spectral centroid (brightness), spectral flatness, 85th-percentile rolloff, onset density, and five normalized band energies (low → high).
- `tracks.dna_json` + `dna_analyzed_at` columns persist the vectors. `setTrackDna` / `getTrackDna` / `getTrackIdsMissingDna` / `getAllTrackDna` / `getDnaStats` round-trip them.
- Smoke `smoke:dna` covers pure-math determinism, FFmpeg-driven analyzer round-trip on real FLAC fixtures, persistence, similarity math, and source-link assertions across the IPC, preload, types, and renderer surface.

### Added — Living Tags DSL (moonshot)
- A tiny embedded expression language for user-authored derived tags. Tags are named expressions over track metadata, audio DNA, listening behavior, and time context. Editing a rule retroactively re-tags every track in the library.
- Grammar: `tag(name) when <expr> [boost N]`. Operators: `and / or / not`, `== != < <= > >=`, `matches`, `contains`, `in`, ranges (`90..120`), arithmetic. Identifiers: `track.*` + `dna.*` plus bareword shortcuts. Functions: `weekday() / hour() / month() / season() / now() / daysSince()`, `matches`, `contains`, `lower / upper / length`, `abs / min / max`, `tag(other)` for composition.
- Sandboxed eval: hand-rolled AST walker, whitelisted function table guarded by `hasOwnProperty` so the prototype chain is unreachable. Three-valued null logic: missing fields fail comparisons rather than poisoning the boolean. Topological-sort cycle detection rejects circular tag references at definition time. Tag names locked to `[a-z_][a-z0-9_-]*`, ≤48 chars; rule bodies ≤4 000 chars.
- New tables `tag_rules` (definition + boost + enabled + `last_error`) and `track_tags` (materialized with cascade on track deletion). Library power-search gains `tag:<name>` and `untagged:true`.
- `saveTagRule` / `deleteTagRule` / `setTagRuleEnabled` / `recomputeTags` / `previewTagRule` / `getTagsForTrack` / `getTagSummaries` / `getTrackIdsByTag`. Saving or toggling a rule auto-recomputes.
- Living Tags workshop view (`/tags` in the sidebar): three-column UI — rule list, expression editor with boost slider and inline parse-error caret, live preview pane that runs the candidate rule against a 2 000-track sample on every keystroke (350 ms debounce). One-click Play sample, recompute-all action, tag-summary chip strip.
- Smoke `smoke:tags`: parser correctness, sandbox escape attempts (`constructor("alert(1)")`, `__proto__` lookup, chained `f()()`), three-valued null behaviour, range filters, composition + cycle detection, and end-to-end persistence including disabled-rule cleanup.

### Added — Sounds Like
- `findSimilarTracks(trackId, limit)` ranks the library by cosine similarity over DNA vectors and returns hydrated tracks with their score.
- Now Playing gains a Sounds Like panel under the Signal Bay. If the track has no DNA, the panel offers an inline "Analyze DNA" button that calls `analyzeTracksDna([id])` and reloads. Otherwise the top five matches show with cosine percentages and a "Play set" action that queues the full result.

### Added — Spectral Cover Art
- Deterministic procedural SVG cover for albums without embedded or sidecar art. Seeded by FNV-1a hash of `artist::album` so the same library renders the same artwork across launches.
- Three-stop OKLCH-ish gradient over a 14-bar spectrogram-style figure with offset accent circles. Lower band stamps `ARTIST + ALBUM` in monospace small caps (HTML escaped). Wired into `AlbumArt` and `FolderArt` as the no-real-art fallback.
- Reference gallery captured at `assets/screenshots/spectral-art-gallery.png`.
- Smoke `smoke:spectral-art`: byte-stable output, palette diversity, valid SVG structure, data-URL round-trip, edge cases.

### Added — Library Radio Brain
- Toggleable HTTP server (`Settings → Library Radio Brain`) that turns NewAmp into a tunable station on the local network. Default port `17117`, configurable (1024–65535).
- Endpoints: `GET /` (HTML status page), `GET /library.m3u`, `GET /random.m3u` (200 shuffled tracks per fetch), `GET /tag/<name>.m3u` (Living-Tag stream), `GET /audio/<trackId>` (raw audio for native formats; WAV-via-ffmpeg transcode for legacy codecs, reusing the engine's transcoder).
- Aborts on client disconnect propagate to the underlying ffmpeg process. `syncRadioBrain` reacts to `settings:set` so flipping the toggle starts / stops / rebinds the server automatically and the renderer status row polls `getRadioBrainStatus` every 4 s.
- Smoke `smoke:radio-brain`: validates endpoint surface, M3U content, audio Content-Type, 405-on-POST, 404 paths, and clean shutdown.

### Changed
- Library power-search grammar gains `tag` and `untagged` field tokens.
- `AlbumArt` and `FolderArt` no longer show a single `♫` placeholder when art is missing — every album/folder gets a unique spectral cover instead.
- Sidebar nav reorganised from a 17-item flat list into six labeled groups (Main / Explore / Discovery / Yours / Streaming / App) with a bordered Tools footer that anchors EQ / VIZ / DECK + the keyboard chip cheat sheet. Row padding compressed so all groups fit a 900 px window without scroll.
- Logo: shipped raster + ICO + new SVG vector wrapper rebuilt from a clean alpha pipeline — no more transparent-hair / ghost-eyes on light GitHub-mobile pages.
- README screenshot grid swapped to higher-density contributed captures with section headers; added a Shape-changing decks row (Record Player / Jukebox / Hotdog / Windowshade) and a Reactive tagging row (Living Tags / Sonic Atlas).

### Performance
- `recomputeTags` and `previewTagRule` build a single in-memory DNA index via `buildDnaIndex()` instead of running one SQLite query per track. `bulkInsertTrackTags` batches the result writes 500 pairs per multi-row INSERT. Result: full library re-tag on 60 000 tracks × 2 rules drops from ~3.9 s projected to **743 ms measured**.
- Spectral SVG renderer gets a bounded LRU memo (512 entries) for both SVG strings and data URLs. Scrolling album grids no longer rebuild every cover on every React re-render.
- `analyzeTracksDna` runs a three-worker pool over the input ids; ffmpeg-bound decode parallelises ~2.5× on multi-core machines.
- New `smoke:perf-bench`: synthetic 60 000-track regression detector that asserts every hot path under per-step budgets and prints the live headroom ratio (current run lands at 5–12× under budget).

### Fixed
- Reverted accidental ASCII downgrades of UI glyphs in `RecordPlayerDeck` (brand dot, close, play/pause/stop, vinyl-label fallbacks) and `formatDuration`'s em-dash. Kept the tonearm-angle correction.
- `profileFor` in `shared/archive-compass.ts` no longer reports `Lossless Library` for an empty library; it returns `Empty Shelf` so Home's grade tile matches the headline.
- Two unprefixed debug `console.log` lines in the `os:pick-folder` IPC handler that printed dialog results on every folder pick.
- Living Tags DSL ReDoS hardening: `matches` and `matches()` route through `safeRegexTest` that pre-screens for nested-quantifier and alternation-of-equivalents patterns; input is sliced to 4 096 chars. Without the screener, `title matches "(a+)+b"` on 28 'a's locked the recompute thread for 17 s — that's library-wide pause.
- Living Tags DSL parser depth guard (`>256` nested parens rejected with a clean compile error) and boost-product cap (`1e6`) so a careless rule pack can't drift the running shuffle-bag weight toward Infinity.
- Living Tags DSL `daysSince()` was unreachable from user rules because the function-table key was mixedCase while the dispatcher lowercases the lookup. Caught by review pass; smoke now asserts the regression.
- `saveTagRule` now runs `topologicalSort` across the full enabled rule set before writing, so cross-rule cycles (`tag(a) when tag(b)` + `tag(b) when tag(a)`) are rejected at save with a clear "would form a cycle" message instead of silently zeroing out the recompute.
- Radio Brain's `respondAudio` destroys the socket when an error fires after headers are sent so a mid-stream error can't chimera audio bytes with error text. M3U `#EXTINF` lines strip `\r\n` from artist/title so a malformed tag can't inject playlist entries.
- TagsView preview pane race condition: each keystroke now carries a sequence number; slow responses to old keystrokes are discarded when a newer edit has already queried.

## [Unreleased]


## [1.2.0] - 2026-05-17

Living Library release.

### Added
- Added Discover, a local-first Living Library view that builds playable crate-digging missions from fresh imports, forgotten favorites, deep album candidates, underplayed corners, and visual-night sets.
- Added a native `getDiscoverSurface` API with deterministic seeds, low-end visual preset safety, deck/visualizer plans, and saveable mission payloads.
- Added Discover navigation in the sidebar and command palette.
- Added `smoke:discover` and `smoke:ui-discover`, and wired both into the release gate.

### Changed
- Broadened README coverage for Discover, current deck skins, release artifact names, architecture, and smoke-test count.

## [1.1.1] - 2026-05-17

Release polish for the first broader test build.

### Fixed
- Restored the compact deck sizing path and tightened the Winamp-style deck to a locked 550x232 shell with in-deck skin switching still accessible.
- Hardened artist facts so ambiguous names resolve to musicians, bands, singers, composers, or record producers instead of species or unrelated pages.
- Regenerated package naming around NewAmp casing for the app, installer, portable build, file associations, release bundle, and publication helper.

### Added
- Added theme-colored logo rendering, longer startup logo animation, an About screen, user text scaling, Now Playing spectrum styles, and an Album context panel.

## [1.1.0] — 2026-05-16

First public release. Major feature drop across UI shells, deck skins, scoring,
audiophile audio chain, and home experience.

### Added — Shells (chrome / layout)
- **Four UI shells** selectable from Settings → Shell · Layout, independent of color skin:
  - **Retro** — Bloomberg-density Winamp 2 homage (default)
  - **Modern** — rounded panels, soft shadows, pill buttons
  - **Liquid Glass** — translucent stacked panes with `backdrop-filter: blur(28px)`,
    triple-radial OKLCH backdrop, SVG noise overlay, frosted sidebar + transport
  - **Concourse** — zero-radius operator-console split-cells with `CELL` labels
    on tagged sections
- Shell selection persists via `localStorage` and is reflected via
  `data-shell` on `<html>` so CSS can re-skin chrome without React knowing.

### Added — Deck (compact-window) skins
- **Four deck skins** with native window sizes — no letterbox borders:
  - **Bento** — the original 720×168 horizontal deck
  - **Record Player** — 540×540, spinning vinyl with the album-art label,
    tonearm swings with playback progress
  - **Jukebox** — 420×560 Wurlitzer-style arch with animated bubble tubes,
    chrome selection numerals fallback for tracks without trackNo
  - **Cassette Deck** — 760×320 with twin rotating reels, TYPE-IV embossed
    strip, frosted front-load door, reels rotate only when `isPlaying`
- IPC `win:set-compact-size` sizes the OS window to each deck's native aspect.
- Deck → full-window transition now restores the maximized state correctly
  even when DECK mode was entered from a maximized window.
- DeckSkinPicker overlay lets you switch deck shape from inside any deck.

### Added — Rating
- 0–100 decimal track scoring via new `tracks.rating_score REAL` column
  alongside the legacy `rating INTEGER (0–5)`. Stars stay in sync
  (`round(score / 20)`) so existing sorts and smart rules keep working.
- `ScoreRating` widget — drag/click to scrub, scroll-wheel ±0.1
  (Shift = ±1.0), arrow keys (Alt = ±10), double-click to type an exact
  score, right-click to clear. Tier label updates from `skip` to
  `desert island`.

### Added — Volume / audio
- Master volume slider extends to **200%** with a red-zone past unity, just
  like VLC. Engine `setVolume` clamps to `[0, 2]`. Limiter sits before the
  master gain so the boost amplifies without clipping. `0 dB` and `+6 dB`
  tick labels render under the slider in addition to percentage readout.
- Settings → Audio shows a live "Output engine" readout: AudioContext
  sample rate + bit depth, styled like a hi-fi component panel.
- ReplayGain status pill in the Now Playing header strip when active.

### Added — Home (magazine layout)
- `HomeHero` with greeting, blurred album-art backdrop, library counts,
  current track + progress bar, transport buttons, and **Today's Pick**
  card with a reason chip (smart-pick logic: high-rated, never played OR
  not played in 30+ days, not currently playing; falls back to top rated).
- `RatedHighlightRail` — 8 album-art cards sorted by rating score, with
  decimal score badges.
- `NewsCard` - compact field report for the most recent import.
- `ListeningStatsThisWeek` — total minutes, distinct artists, top genre.
- Fresh Imports rail subtitle shows the date of the newest file `mtime`.

### Added — Now Playing
- Side-panel tab strip: **On Air** (default - Liner Notes / sonic vitals / lyric hot lines / file credits), **Album**
  (Tempo Trainer / Practice Loop / Track Bookmarks musician tools),
  **Lyrics**.
- Draggable spectrum/side split with `localStorage` persistence
  (`newamp:np:spectrumFrac`).

### Added — First-run UX
- Rebuilt Empty Library view as an inviting hero (themed logo + headline +
  one-CTA folder scan) instead of a text-heavy onboarding wall.
- `FirstRunHints` shows a one-time `Ctrl+K` command palette tip toast on
  first launch (tracked via `localStorage`).

### Added — Other
- Music field-report copy delivered in-product without requiring a network account.
- Score-aware sort and `data.rated` rail in `HomeView`.

### Performance
- `content-visibility: auto` on long catalog rows (`.newamp-library-row`,
  `.newamp-albums-row`, etc.) — the browser skips offscreen layout/paint
  entirely. Single biggest scroll-frame improvement on 60k-track libraries.
- Lazy-load album art in Home with reserved aspect ratios to prevent
  layout reflow.

### Build / release
- `appId` neutralized to `io.newamp.player`.
- `package.json` `repository` / `homepage` / `bugs` fields set so
  electron-builder can compute publish info without warnings.
- Logo asset moved from repo root to `build/logo.png` (the root `*.png`
  glob in `.gitignore` was hiding it from tracking).
- `package` script produces both NSIS installer and portable EXE,
  signs them with signtool, writes `SHA256SUMS.txt`.
