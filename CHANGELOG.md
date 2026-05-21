# Changelog

All notable changes to NewAmp will be documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [1.5.6] - 2026-05-20

Hotfix for a 1.5.4-introduced Milkdrop break.

### Fixed — Milkdrop visualizer was broken

The 1.5.4 "adaptive resolution scaling" experiment reassigned the `ensureSize` function declaration mid-effect (`ensureSize = function adaptiveEnsureSize() { ... }`). In TypeScript strict-mode modules this is unsafe and broke the visualizer entirely on real hardware (the smoke happened to slip past because it doesn't exercise the full render loop under sustained frame pressure).

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

Live-feedback pass driven by playing the 1.5.3 build. Five user-reported issues from a single listening session, all fixed.

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
