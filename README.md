<div align="center">

<img src="assets/github/logo-readme.png" alt="NewAmp" width="200">

# NewAmp

**A music player for people who still own their music.**

Your files, on your machine. No subscription, no account, no cloud, no telemetry.
Free and open source for Windows, macOS, and Linux.

[![Release](https://img.shields.io/github/v/release/evilander/newamp?style=flat-square&color=39ff14)](https://github.com/evilander/newamp/releases/latest)
[![License](https://img.shields.io/github/license/evilander/newamp?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%2B%20macOS%20%2B%20Linux-blue?style=flat-square)](https://github.com/evilander/newamp/releases/latest)

**[⬇ Download the latest release](https://github.com/evilander/newamp/releases/latest)**

</div>

---

## Get it

Grab your platform from the [latest release](https://github.com/evilander/newamp/releases/latest):

| You use | Download |
| --- | --- |
| **Windows** | `NewAmp Setup <version>.exe` (installer) or `NewAmp Portable <version>.exe` (no install, single file) |
| **macOS** | `NewAmp <version> arm64.dmg` (Apple Silicon) or `NewAmp <version> x64.dmg` (Intel) |
| **Linux** | `NewAmp Linux <version> x64.tar.gz` — extract and run `./newamp` |

Point it at your music folder, and it just starts playing. That's the whole setup.

> The builds aren't code-signed yet, so Windows SmartScreen may ask you to click "More info → Run anyway", and macOS may want a right-click → Open the first time. Every file's checksum is published in `SHA256SUMS.txt` if you want to verify what you downloaded.

## Why you'll love it

- **It feels like a piece of hardware, not a website.** Panels, bevels, glowing readouts — and four completely different looks (called *shells*), from a dense retro terminal to translucent glass.
- **The whole player moves with your music.** Not just a visualizer in a box — the chrome itself breathes with the song that's playing. (You can turn that off. It respects your settings and your battery.)
- **It handles a serious collection.** Tested with libraries of 60,000+ tracks — MP3, FLAC, and about eighteen other formats — and it stays fast.
- **Your year, Wrapped — without an account.** A Spotify-Wrapped-style recap built entirely from your local listening history: shareable card, or a 30-second video. Nothing is uploaded, because there's nowhere to upload it to.
- **Your phone is the remote.** Scan a QR code and control playback from the couch. No app store, no cloud — it's all on your Wi-Fi.
- **Visualizers people actually screenshot.** A full MilkDrop-style engine plus Eviland, our own visualizer that hears each instrument separately — the kick, the snare, the vocals each paint their own light. Press one key to save the last 15 seconds as a video.
- **Dress it up.** 13 color skins, 9 compact "deck" modes (record player, jukebox, cassette, even a hotdog), and it imports classic Winamp `.wsz` skins from 1999.
- **Plays like an instrument.** Winamp-style keyboard controls everywhere — Space, arrows, `L` to love, `0–5` to rate, `Q` to queue, `F` for the fullscreen visualizer, and `Ctrl+K` opens a command palette that resumes where you left off.

## A quick look

| Home | Albums |
| --- | --- |
| <img src="assets/screenshots/contributed-home-pink-floyd.png" alt="NewAmp Home — greeting hero with blurred album backdrop and smart rails" width="420"> | <img src="assets/screenshots/contributed-albums-built-to-spill.png" alt="NewAmp Albums — dense cover grid that scales to thousands of albums" width="420"> |

| Now Playing | Synced lyrics |
| --- | --- |
| <img src="assets/screenshots/contributed-now-playing-facts.png" alt="NewAmp Now Playing — artist facts, live spectrum, waveform overview" width="420"> | <img src="assets/screenshots/contributed-now-playing-lyrics.png" alt="NewAmp lyrics scrolling in sync with playback" width="420"> |

**The decks** — compact modes that reshape the window into a little machine:

| Record Player | Jukebox |
| --- | --- |
| <img src="assets/screenshots/contributed-record-player-deck.png" alt="Record player deck — spinning vinyl and a swinging tonearm" width="420"> | <img src="assets/screenshots/contributed-jukebox-deck.png" alt="Jukebox deck — chrome arch and animated bubble tubes" width="420"> |

**The visualizers:**

| Tempo Pulse | Aurora |
| --- | --- |
| <img src="assets/screenshots/visualizer-tempo-pulse-deerhoof.png" alt="Tempo Pulse visualizer — beat-locked pulse rings" width="420"> | <img src="assets/screenshots/visualizer-aurora-hella.png" alt="Aurora visualizer — flowing ribbons" width="420"> |

More screenshots live in `assets/screenshots/`.

## What else is in the box

- **A Home screen that knows you** — today's pick, your highest-rated tracks, heavy rotation, fresh imports, and listening stats for the week.
- **Discover mode** — turns your own ratings, skips, and forgotten corners into playable "crate-digging" sessions. It's your library, resurfaced.
- **Ask your library in plain English** — press `Ctrl+K` and type "warm slow stuff from the 70s I haven't played this year". It works offline, and it shows you exactly how it understood you.
- **Ratings with real precision** — score tracks 0–100.0 if stars aren't enough. Stars stay in sync for sorting.
- **Smart playlists and Auto DJ** — taste-learning mixes, BPM/key-aware transitions, rules like "loved, over 85, not played this month".
- **Lyrics, karaoke, practice tools** — synced lyrics, A/B loops, a tempo trainer, and track bookmarks for musicians.
- **Podcasts, CUE sheets, Last.fm scrobbling** — with an offline queue so nothing is lost when you're off the grid.
- **Reviews, ranked lists, and a profile** — a Letterboxd-for-listening foundation, exportable as a single HTML page. Local first, like everything else.
- **Radio Brain** — flip a switch and your library becomes a private station on your home network that VLC, Sonos, or OBS can tune into.

## First run

1. Open NewAmp. It offers to scan your Music folder (or drop any folder onto the window).
2. Give it a moment — about 10 seconds per thousand tracks.
3. Press `Ctrl+K` and search for anything. Press `F` for the fullscreen visualizer. Press `Ctrl+M` to shrink into a deck.
4. Open **Settings → Shell** and **Settings → Skin** to make it yours.

## Community

- **Found a bug? Have an idea?** [Open an issue](https://github.com/evilander/newamp/issues) — there are templates, and drive-by reports are welcome.
- **Want to talk?** [GitHub Discussions](https://github.com/evilander/newamp/discussions) is the town square.
- **Want to contribute?** See [CONTRIBUTING.md](CONTRIBUTING.md). You don't need to run the whole release gate for a typo fix.

---

## For the nerds

*The part of the README where we stop holding back.*

<details>
<summary><b>The audiophile chain — bit-perfect, honestly</b></summary>

**Bit-Perfect Exclusive** (Windows, with experimental macOS/Linux lanes) is true exclusive-mode output through NewAmp's own native engine — a first-party N-API addon with vendored miniaudio. ffmpeg decodes straight to raw PCM in the main process and a lock-free ring feeds the DAC on the WASAPI callback thread. No Chromium, no Web Audio, no OS mixer.

The negotiation is *honest by construction*: formats are probed from the device's native exclusive capabilities, and if your DAC's clock can't run the source rate, NewAmp resamples explicitly (SoX, precision 28) and tells you — it refuses miniaudio's hidden converter, which we caught silently resampling 44.1→48k on real hardware. The gold `EXCLUSIVE` badge is a strict claim: lossless source, rate + bit depth + channel layout preserved. Anything less shows `EXCLUSIVE*` with the exact reason.

No DSP means no DSP: EQ, ReplayGain, crossfade, limiter, and software volume are structurally out of the path and grayed out with an explanation. Gapless works over the exclusive stream by splicing PCM into the same ring at the exact frame boundary. Visualizers stay alive via a 30 Hz native PCM tap into a spec-faithful AnalyserNode emulation.

The shared path is no slouch either: WASAPI output, per-track/per-album ReplayGain, a software peak limiter, a 10-band EQ, 0–200% perceptual (cubic-taper) volume with a post-limiter amp stage, format badges derived from real sample rates (not marketing tags), and a live transport badge that tells you whether your source rate is passing through untouched (`44.1k DIRECT`) or not (`44.1k→48k RESAMPLED`). DSD files (DSF/DFF up to DSD1024) decode through the ffmpeg lane. Full signal-path story in [`docs/audio-quality.md`](docs/audio-quality.md).

</details>

<details>
<summary><b>Eviland — a visualizer with long-term memory</b></summary>

Where MilkDrop pulses three lumped bands on one shared envelope, Eviland runs a 24-band spectral-flux onset detector so each instrument fires its own visual event — the kick blooms a red shockwave from the floor, the snare cracks white off-center, hats sparkle along the top. It renders into a GPU feedback field (WebGL2 float ping-pong) with curl-noise flow, dual-Kawase bloom, and transient-gated chromatic aberration — and underneath it runs a real Navier-Stokes fluid solver (vorticity confinement + Jacobi pressure projection) whose **Liquid** look makes every instrument inject its own colored dye into a divergence-free velocity field.

It has structural memory (detects verse/chorus boundaries and visually *rhymes* when a chorus returns), anticipation (locks to tempo and leads the beat), and — uniquely — **it remembers your library**: every song learns a persistent visual plan that survives restarts, evolves a generation at 8/32/96/256 plays, and seeds brand-new songs from their closest sonic cousin's visual lineage. Its Director choreographs 26 morphing looks built on MilkDrop's own preset primitives: q-variable LFOs, per-pixel radial warp profiles, per-channel RGB trail decay, video echo, tear-free field crossfades.

Also in the stable: real MilkDrop via Butterchurn (sandboxed in its own frame so the app needs no `unsafe-eval`), **Particle Flow** (~140k particles simulated on the GPU via WebGL2 transform feedback through a curl-noise field that bends with the bass), and 24 in-house fullscreen modes. An auto hardware tier keeps all of it smooth on weak machines, and everything falls back gracefully without WebGL2.

</details>

<details>
<summary><b>Living Tags — a reactive tagging language</b></summary>

Write expressions like:

```
tag(midnight_drive) when bpm > 110 and dna.energy > 0.4 and genre matches "synth|wave" boost 1.5
```

…and the library reactively re-tags itself as tracks are played, rated, and analyzed. Tags compose, cycle-check at definition time, and become first-class search filters (`tag:midnight_drive`). The `dna.*` fields come from **Audio DNA** — per-track perceptual fingerprints (brightness, dynamic range, band energies, onset density) extracted by local FFT, which also power the "Sounds Like" panel and the plain-English query compiler.

</details>

<details>
<summary><b>Architecture & stack</b></summary>

```text
newamp/
  electron/        Main process: IPC, protocols, library store (sql.js), scanner,
                   metadata, ReplayGain, radio server, video muxing, exports
  native/          newamp-audio: N-API addon (vendored miniaudio) for exclusive output
  shared/          Types, Discover scoring, limiter math, query-intent compiler
  src/             Renderer (React + Zustand)
    audio/         Web Audio chain: input → eq → replayGain → limiter → master → analyser
    components/    Views, decks, chrome; styles in src/styles/
    visualizer/    Eviland engine, particle flow, frame bus, replay ring
  scripts/         ~100 smoke tests, packaging, release gate, screenshot tooling
```

Electron 42 · Vite 6 · React 18 · Zustand 5 · sql.js (SQLite in WASM, no native DB deps) · music-metadata · ffmpeg (bundled) · Butterchurn · LRCLIB for synced lyrics · optional Last.fm.

The library is a SQLite file in your OS profile (`%APPDATA%/NewAmp` on Windows, `~/Library/Application Support/NewAmp` on macOS, `~/.config/NewAmp` on Linux). Delete the folder and NewAmp never existed.

</details>

<details>
<summary><b>Privacy, exactly</b></summary>

- No telemetry, no analytics, no crash reporters that phone home, no update pings.
- Network calls exist only where you can see the feature that needs them, all optional: LRCLIB lyric lookups (anonymous artist/title/duration), Cover Art Archive / MusicBrainz art & metadata rescue, artist facts/images, podcast feeds you add, and Last.fm scrobbling with your own credentials.
- Radio Brain / Remote binds to your LAN and every route requires this install's secret token.

</details>

## Build from source

Node 20+ on Windows, macOS, or Linux:

```bash
git clone https://github.com/evilander/newamp.git
cd newamp
npm install
npm run dev          # development with hot reload
npm run package      # production artifacts for your platform
```

The full feature reference lives in [`docs/features.md`](docs/features.md), and the deep technical docs in [`docs/`](docs/).

## License

[MIT](LICENSE). The "NewAmp" name and logo artwork are project-specific; everything else is yours to fork.

## Acknowledgements

NewAmp stands on the shoulders of Winamp (1997–2013), the open-source audio community, and decades of bedroom DJs who refused to give up local files.
