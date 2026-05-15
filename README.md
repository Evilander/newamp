# Newamp

Newamp is a local-first Windows music player with Winamp DNA and a modern library brain. It is built for people who own music files, keep deep libraries, and want a player that feels fast, personal, and alive without turning their collection into a streaming-service sidebar.

It scans your folders, builds a private local catalog, plays modern and legacy audio formats, renders Milkdrop-style visuals, rescues album art and metadata, manages custom playlists, supports smart stations, tracks listening history, and adds musician tools like lyrics, bookmarks, tempo practice, A/B loops, and guitar-tab play-along.

## Current Status

Newamp is in internal Windows release-candidate shape. The app builds, packages, installs, opens associated audio files, launches as a portable EXE, and has been smoke-tested against a large local music library:

- 62,949 tracks
- 5,932 albums
- 3,794 artists
- 62,434 native playback candidates
- 515 ffmpeg fallback candidates

Public `v1.0.0` is intentionally held until the remaining release blockers are closed: Authenticode signing, final human speaker/headphone listening proof, and final live-service/account proof.

## Highlights

- **Local library scanner.** Recursively indexes real music folders into a local `sql.js` catalog with tag parsing through `music-metadata`.
- **Broad playback support.** Handles MP3, FLAC, OGG/Opus, WAV, M4A/AAC/ALAC, WMA, AIFF, APE, WV, MPC, TTA, MKA, AC3, DTS, DSF, playlists, and ffmpeg fallback formats.
- **Home command center.** Opens to a useful dashboard with continue playback, library stats, health signals, fresh imports, heavy rotation, loved tracks, harmonic mixes, and saved playlists.
- **Quick Play command palette.** Ctrl+K/Ctrl+J searches tracks, albums, artists, playlists, views, and commands; Enter plays, Ctrl+Enter plays next, Shift+Enter queues, Ctrl+L loves, and Ctrl+R starts Smart Rule Radio.
- **Custom playlists.** Create named playlists, filter large playlist lists/tracks, append tracks in bulk, add folders, set playlist artwork, and launch playlists directly from Home.
- **Smart rules and stations.** Build dynamic rules from genre, artist, album, year/era, rating, love state, play count, date added, BPM, key, and search filters; launch rule-driven radio stations.
- **Podcasts.** Add podcast feeds, keep episode progress, mark completions, and download episodes for local playback.
- **Milkdrop visualizer.** Butterchurn-powered fullscreen Milkdrop plus lighter built-in analyzer modes.
- **Skins.** Built-in skins, custom CSS-variable skins, import/export of `.newampskin.json`, and Winamp classic `.wsz` / `.zip` palette import.
- **Album art rescue.** Search MusicBrainz release groups, preview Cover Art Archive covers, and cache selected artwork locally without rewriting source audio files.
- **Metadata rescue.** Review MusicBrainz candidates and patch Newamp's catalog metadata without touching original tags.
- **Library health.** Surface missing tags/art/duration, legacy formats, recent imports, duplicate clusters, and exact-looking duplicate rips for safe review.
- **Artist facts and images.** Wikipedia-powered artist spotlights with large images, short descriptions, summaries, source links, and local cache reuse.
- **Lyrics.** LRCLIB lookup, local sidecar lyrics, and saved custom plain/LRC lyrics per track.
- **Play Along.** Search Ultimate Guitar when reachable, paste UG URLs or raw tabs, save local tab text, parse ChordPro, auto-discover sidecar tab files, transpose chords, autoscroll, and pop out a native tab window.
- **Practice tools.** A/B loop panel, tempo trainer with pitch preservation, track bookmarks, ratings, sleep timer, stop-after-current, and smart shuffle.
- **Last.fm.** Desktop auth, Now Playing updates, threshold scrobbling, retry outbox, saved app credentials, and a Settings proof action.
- **Audio controls.** 10-band EQ, presets, ReplayGain, limiter, preamp, crossfade/gapless handoff, output-device selection, and in-app left/right speaker test.
- **Native desktop behavior.** Tray residency, global media keys, open-with file association handling, persisted pin-on-top/compact-window controls, and OS media-session metadata/actions with album art.
- **Winamp-style keyboard controls.** Z/X/C/V/B transport, arrow seek/volume nudges, L love, 0-5 ratings, fullscreen visualizer toggle, and input-safe shortcut handling.
- **Reliability tools.** Corrupt settings/library recovery, support backup/restore, security smoke, installed association proof, and release gates.

## Installable Builds

`npm run package` creates:

- `release/Newamp Setup <version>.exe` - NSIS installer
- `release/Newamp Portable <version>.exe` - no-install portable launcher
- `release/win-unpacked/Newamp.exe` - unpacked app
- `release/SHA256SUMS.txt` - SHA256 checksums for the installer, portable EXE, and unpacked EXE

The current artifacts are unsigned. Windows may warn until a real code-signing certificate is added.

Signing dry-run:

```bash
npm run release:sign -- --dry-run
```

Actual signing supports either a local PFX file (`NEWAMP_SIGN_CERT_PATH` or `CSC_LINK` plus password env) or an installed certificate (`NEWAMP_SIGN_SHA1` or `NEWAMP_SIGN_SUBJECT`). The JSON report redacts certificate passwords.

## Development

Requirements:

- Windows 11 for the primary desktop target
- Node 22.12+; developed against Node 25.5
- No Python or Visual Studio Build Tools required

Install and run:

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
npm start
npm run package
```

Local release gate:

```bash
npm run release:gate:local
```

Strict release gate:

```bash
npm run release:gate
```

Strict mode is expected to fail until signing, live-service/account proof, and manual speaker/headphone proof are complete.

Publication readiness:

```bash
npm run release:publication-readiness
npm run release:publish-github
```

Both commands are non-mutating by default. Readiness checks the README, package version, git/GitHub CLI state, signed artifacts, and manual listening proof. `release:publish-github` dry-runs the exact git/GitHub command sequence and only executes with `-- --execute` after readiness passes.

## Important Smoke Tests

```bash
npm run smoke:library
npm run smoke:transcode
npm run smoke:incremental-scan
npm run smoke:scanner-queue
npm run smoke:library-paging
npm run smoke:artist
npm run smoke:folders
npm run smoke:search
npm run smoke:smart
npm run smoke:harmonic
npm run smoke:auto-dj
npm run smoke:metadata
npm run smoke:health
npm run smoke:podcast
npm run smoke:podcast-progress
npm run smoke:podcast-download
npm run smoke:full-library -- <music-root>
npm run smoke:audio-proof
npm run smoke:installer-artifact
npm run smoke:installed-app
npm run smoke:portable-app
npm run smoke:packaged-open-files
npm run smoke:library-watch
npm run smoke:library-prune
npm run smoke:support-backup
npm run smoke:support-restore
npm run smoke:signing-readiness
npm run smoke:signing-workflow
npm run smoke:release-checksums
npm run smoke:publish-github
npm run smoke:live-services
npm run smoke:lastfm
npm run smoke:tabs
npm run smoke:playback-start
npm run smoke:playback-controls
npm run smoke:keyboard
npm run smoke:media-session
npm run smoke:smart-shuffle
npm run smoke:queue-insert
npm run smoke:queue-edit
npm run smoke:rating
npm run smoke:bookmarks
npm run smoke:practice-loop
npm run smoke:tempo
npm run smoke:replaygain
npm run smoke:session
npm run smoke:chrome-state
npm run smoke:audio-output
npm run smoke:audio-limiter
npm run smoke:ui-playback
npm run smoke:ui-visualizer
```

After doing the real speaker/headphone pass against the current package, record the manual proof artifact with:

```bash
npm run release:record-listening-proof -- --confirm-playback --confirm-output-switching --confirm-crossfade --confirm-gapless
```

That writes `release/manual-listening-proof.json` with the current installer, portable EXE, and unpacked EXE hashes. The strict release gate rejects stale proof if the artifacts change.

Check it later with:

```bash
npm run release:check-listening-proof
```

## Architecture

```text
newamp/
  electron/              Main-process TypeScript, IPC, protocols, library store
  shared/                Shared app types and pure helpers
  src/                   React renderer, audio engine, views, components, stores
  scripts/               Smoke tests, release gates, packaging helpers
  build/                 Generated app icons
  release/               Generated installer, portable EXE, unpacked app
```

Newamp uses Electron for the desktop shell, React for the renderer, Zustand for playback/UI state, `sql.js` for the local catalog, `music-metadata` for tags, `ffmpeg-static` for fallback playback/transcoding, and Butterchurn for Milkdrop visualizations.

The renderer does not read arbitrary files directly. The main process exposes controlled IPC and custom app protocols for library scans, playback streams, artwork, lyrics, tabs, backups, and support actions.

## Privacy

Newamp is local-first:

- No telemetry
- No cloud library sync
- No required account
- No streaming subscription
- Last.fm is optional and user-configured
- Network features are explicit: Last.fm, LRCLIB, MusicBrainz/Cover Art Archive, Radio Browser, podcast feeds, and Ultimate Guitar search when reachable

## Release Plan

The `v1.0.0` release should include:

- Signed installer
- Signed portable EXE
- Clean strict `npm run release:gate`
- Human listening proof for playback, output switching, crossfade, and gapless behavior
- Live Last.fm account proof
- Clear note that Ultimate Guitar access may be blocked by Cloudflare and that local/pasted/sidecar tabs remain supported

## License

MIT
