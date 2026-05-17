# Changelog

All notable changes to NewAmp will be documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

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
