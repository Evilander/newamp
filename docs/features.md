# NewAmp — full feature reference

The complete tour. The [README](../README.md) is the landing page; this is the encyclopedia.

## Player

- **0–200% volume** with a red-zone past unity — VLC-style amp boost with full `0 dB / +6 dB` tick labels, running after the master limiter so it amplifies without clipping. A perceptual (cubic) taper makes equal slider travel feel like an equal loudness change.
- **10-band EQ** with custom presets, software peak limiter with preamp control, ReplayGain (per-track + per-album), crossfade and gapless playback, lossless WAV export of any track, output-device picker with test tone.
- **Bit-Perfect Exclusive** — WASAPI-exclusive on Windows through a first-party native engine; experimental CoreAudio hog-mode (macOS) and ALSA-direct (Linux) lanes. Honest format negotiation, explicit labeled resampling, gapless ring splicing, per-track fallback. See [audio-quality.md](audio-quality.md).
- **Format & signal-path honesty** — FLAC / 24-96 hi-res / DSD badges derived from real sample rates, plus a live transport badge showing pass-through vs resampling.
- **Undo clear queue** — the clear notification offers **Undo clear** for ten seconds. It restores the queue and playback position, paused. Hovering or focusing the notification keeps it available; subsequent queue edits take precedence.
- **CUE sheet playback** — one-file albums split into playable, seekable tracks with full metadata.
- **Formats**: MP3, FLAC, OGG, Opus, WAV, M4A, AAC, WMA, AIFF, APE, WV, MPC, TTA, MKA, AC3, DTS, DSF, DFF (+ M3U/M3U8/PLS/CUE playlists).
- Winamp-style keyboard control everywhere: Space, arrows, `L` to love, `0–5` stars, `F` fullscreen visualizer, `Ctrl+K` palette, `Ctrl+M` deck mode.

## Library

- **Scales to 60k+ tracks** — virtualized tables, paged queries, incremental scanning, and a watchful auto-rescan mode.
- **0–100 decimal track scoring** — drag, scroll, keyboard-nudge, or type `88.3`. Stars stay in sync for legacy sorts and smart rules.
- **Power search** (`Ctrl+F`) with field filters, plus **Ask Your Library** in the `Ctrl+K` palette: plain-English queries compiled — fully offline — into year ranges, tempo caps, rating/loved filters, recency exclusions, and DNA-based re-ranking, with interpretation chips showing exactly what ran.
- **Audio DNA + Sounds Like** — per-track perceptual fingerprints (brightness, dynamic range, band energies, onset density) extracted via local FFT, surfaced as a cosine-similarity panel on Now Playing.
- **Living Tags DSL** — reactive tagging rules (`tag(name) when bpm > 110 and dna.energy > 0.4 … boost 1.5`) that compose, cycle-check, and become first-class search filters.
- **Smart playlists + Auto DJ** — BPM/key-aware harmonic mixes, taste-learning from plays/loves/ratings/skips, min-rating rules, recency exclusions.
- **Album art rescue + metadata rescue** — embedded art, folder art, Cover Art Archive, MusicBrainz lookup, manual cleanup tools.
- **Spectral Cover Art** — albums without art get a stable, unique procedural SVG cover seeded by `artist::album`.
- **Library health** — duplicate/missing/bitrate audits with one-click actions.
- **Custom playlists** with reordering, portable folder export, and playlist artwork.

## The stage

- **Magazine-style Home** — greeting hero with blurred album backdrop, Today's Pick (with a reason chip), Your Highest Rated, NewAmp News, weekly listening stats, and the Harmonic / Taste / Loved / Heavy Rotation / Fresh Imports rails.
- **Bloomberg-density Now Playing** — tabbed side panel (On Air / Album / Lyrics), draggable spectrum split, selectable spectrum styles, VU + waveform overview, LRCLIB-synced lyrics with karaoke mode and a custom-lyrics editor, tempo trainer, practice A/B loop, track bookmarks.
- **Resonance** — the whole UI reacts to live audio through one cheap CSS-variable loop that self-throttles on weak hardware and respects `prefers-reduced-motion`.
- **Eviland** — 24-band per-instrument onset detection, GPU feedback field, fluid simulation, structural memory, tempo anticipation, per-track persistent visual lineage, 26 morphing looks.
- **MilkDrop via Butterchurn** (sandboxed, prewarmed preset swaps) + **Particle Flow** (~140k GPU particles) + 24 in-house fullscreen modes with real spectral-flux beat detection and an auto hardware tier.
- **Save the moment** — a WebCodecs ring buffer holds the last 15 seconds of Eviland Live; `Shift+R` mints a shareable MP4 with audio. Plus a general clip recorder and PNG stills.
- **Eight deck skins** — Windowshade, Winamp Classic, Winamp Industrial, Record Player, Jukebox, Cassette Deck, Discman, Retro TV — each declaring its own native window size.
- **Detached projector** — throw the visualizer onto a second monitor while you work.

## Yours

- **NewAmp Wrapped** — Today / Week / Month / Year / All-Time recaps: time listened, top tracks & artists, genre breakdown, 24-hour listening clock, streaks, discoveries, a DNA-derived vibe — exported as a shareable PNG card or a 30-second 1080×1920 video scored to your top track.
- **Discover mode** — local-first crate-digging missions from ratings, skips, fresh imports, deep-album candidates, and underplayed corners.
- **Profile, reviews & lists** — reviews and diary entries on tracks/albums/artists, ranked lists, "five bags" favorites, per-item privacy, and a self-contained static HTML profile export.
- **History & insights** — full play history with honest stats.

## Connected (only if you ask)

- **NewAmp Remote** — QR-scan phone remote over Wi-Fi: art, transport, scrub, volume, queue, live via server-sent events. Token-gated.
- **Radio Brain** — your library as a tunable HTTP station on the LAN (`/library.m3u`, `/random.m3u`, `/tag/<name>.m3u`), token-gated.
- **Last.fm** — full scrobbling + now-playing with an offline outbox queue.
- **Podcasts** — subscriptions, downloads, progress tracking, SSRF-guarded fetching.

## Theming

Two independent axes plus deck shapes:

| Axis | What it controls | Where |
| --- | --- | --- |
| **Shell** | Layout, sidebar, transport, materials (Retro / Modern / Liquid Glass / Concourse) | Settings → Shell |
| **Skin** | 13 color palettes via CSS variables | Settings → Skin |
| **Deck** | Compact-window shape | Picker in deck view |

Drop a Winamp 2.x `.wsz` onto the window to import it (palette derived from the bitmap), or author your own in the Skin Workshop and export `.newampskin.json`.

## Listening-history import

Open **History → Import listening history** after scanning your music.

- **Last.fm:** enter a public username and configure your API key in
  Settings → Last.fm. Scrobbling and account authorization are not required.
  The importer fetches completed plays across pages up to a fixed cutoff time,
  shows progress, and supports cancellation before applying the import. Up to
  500,000 plays can be imported at once; larger histories need a file export
  divided into smaller files.
- **Files:** choose a CSV or JSON export, up to 64 MB and 500,000 plays per file.
  CSV uses a header row. JSON accepts an array of play objects or a Last.fm
  `recenttracks` response. Each row represents one play event.
- Required data: `played_at` plus either `path`, or both `artist` and `title`.
  `album` helps distinguish releases. Timestamps accept Unix seconds, Unix
  milliseconds, or ISO timestamps with a timezone. Common alternatives such as
  `timestamp`, `playedAt`, `track`, and `file_path` are also accepted.
- Tracks match by file path first, then exact normalized artist/title, with
  album disambiguation. Ambiguous and unmatched rows are skipped and reported.
  Matching preserves Unicode text and accents; it does not guess approximate
  song titles. Duplicate track/timestamp pairs are skipped on reimport.
- Imports update play counts, most-recent-play timestamps, History, Mixes, and
  listening insights. Existing history is preserved. Play-count totals alone
  cannot recover individual play dates and are not expanded into invented plays.

```csv
artist,title,album,played_at
Example Artist,Example Track,Example Album,2025-08-12T19:30:00Z
```

## Music servers

**Music Servers** connects to Jellyfin and Navidrome / compatible Subsonic
servers with your server URL, username, and password. LAN HTTP URLs and
reverse-proxy subpaths are supported; HTTPS protects credentials in transit.
Saved connections use the OS credential store. Turn off **Remember connection**
to keep credentials only for the session; these disappear when NewAmp exits.

Tracks from remembered connections can resume in the queue after restarting.
Session-only and disconnected servers are skipped when restoring the queue.

Browse or search tracks in pages of 100, then play a track, queue it next, or
queue a page. Playback uses the normal transport and visualizers, with seeking
when the server supports byte ranges. The player requests original audio;
unsupported browser codecs require conversion on the server. Native exclusive
output, local playlists, offline downloads, and server library synchronization
are not part of this connection feature. Credentials stay in the main process
and are not placed in renderer playback URLs. Redirects are refused, so enter
the final server URL directly.

Developer checks: `npm run test:music-servers`, `npm run test:history-import`,
and `npm run smoke:community-ui` (Python with Playwright installed). The UI check
uses isolated profiles and local protocol fixtures for both servers; it tests
history reimport, playback, seeking, visualizer input, and exact byte ranges.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Space | Play / Pause |
| ← / → | Seek ±5 s |
| ↑ / ↓ | Volume ±5% (clamps at 200%) |
| Ctrl+→ / Ctrl+← | Next / Previous track |
| L | Love / unlove |
| 0–5 | Star rating |
| F | Fullscreen visualizer |
| Shift+R | Save last 15 s of Eviland Live |
| Ctrl+K | Command palette |
| Ctrl+F | Search |
| Ctrl+M | Compact deck mode |
| Esc | Exit fullscreen / close overlay |

## Release proof tooling (maintainers)

```powershell
npm run release:gate:local
npm run release:start-lastfm-proof
npm run release:record-lastfm-proof -- --token=<token> --confirm-live-write
npm run release:start-listening-proof
npm run release:record-listening-proof -- --confirm-playback --confirm-output-switching --confirm-crossfade --confirm-gapless
```
