# Changelog

All notable changes to NewAmp will be documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

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
