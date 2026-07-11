# NewAmp Viral Copy Bank

Prepared: 2026-07-04  
Campaign: "Your Local Library Lives"

## Core Copy

### Hero headline

Your local library lives.

### Hero subhead

NewAmp is a local-first music player that turns the music you own into a private, reactive, shareable desktop universe. No streaming. No cloud. No telemetry.

### CTA options

- Download NewAmp on GitHub.
- Bring your Music folder back to life.
- Try it with the weirdest folder you own.
- Make your private Wrapped.
- Save the visualizer moment after it happens.

## Social Bios

### Short

Local-first music player for people who still have a Music folder. No streaming, no cloud, no telemetry.

### Medium

NewAmp is a local-first desktop music player and library manager with reactive UI, Wrapped, Clip Studio, smart discovery, visualizers, and bit-perfect output.

### Technical

Electron 42 + React + SQLite/sql.js local music player with native WASAPI-exclusive output, GPU visualizers, local Wrapped, Audio DNA, smart playlists, and no telemetry.

## Launch Threads

### X / Bluesky / Mastodon Thread

Post 1:

I built NewAmp for people who still have a Music folder.

It is a local-first desktop music player that makes your private library feel alive again: reactive UI, visualizers, Wrapped, smart discovery, and no cloud.

Post 2:

The pitch is simple:

Your local library. Your rules.

No streaming.
No account.
No telemetry.
No subscription dashboard.

Post 3:

NewAmp scans your local files, including MP3, FLAC, OGG, Opus, WAV, M4A, AAC, WMA, AIFF, APE, WV, MPC, DSF, and DFF.

It is built for real personal libraries, not a tiny demo folder.

Post 4:

The fun part: the app itself reacts to the music.

Resonance makes the player chrome breathe with the track. Eviland and Particle Flow turn the music into fullscreen visual scenes.

Post 5:

You can save the last 15 seconds of a visualizer after the moment already happened.

That feature is called Clip Studio, and it is basically "wait, save that drop" for your music library.

Post 6:

NewAmp Wrapped is private.

It builds recaps from your local play history and can export shareable cards and Wrapped Live videos without uploading your listening history to a cloud account.

Post 7:

It also has Ask Your Library.

Type something like:

"warm slow stuff from the 70s I haven't played this year"

NewAmp compiles it into local search and ranking.

Post 8:

For audiophile people: v1.17.0 adds Bit-Perfect Exclusive on Windows.

The gold EXCLUSIVE badge only appears for strict conditions: lossless source, preserved rate/depth/channels, and no hidden DSP.

Post 9:

This is the app I wanted after years of seeing local music treated like a legacy corner case.

If you have a weird, huge, old, precious, messy music folder, I want you to try it.

Post 10:

Download:
https://github.com/Evilander/newamp/releases

Repo:
https://github.com/Evilander/newamp

Tell me what breaks. Especially if your library is strange.

## Hacker News

### Title

Show HN: NewAmp, a local-first desktop music player for people who own music

### Body

Hi HN, I built NewAmp, a local-first desktop music player and library manager for macOS, Windows, and Linux.

The core idea is that a personal music library should feel like a first-class product again, not a forgotten folder next to streaming apps. NewAmp indexes local files, stores the library locally, and does not require an account, cloud sync, telemetry, or a streaming service.

Some technical pieces that may be interesting:

- SQLite/sql.js local library, tested with large collections
- GPU visualizers, including Eviland and Particle Flow
- Local Wrapped and Wrapped Live exports generated from private play history
- Natural-language local library queries like "warm slow stuff from the 70s I haven't played this year"
- Winamp-style skins and compact deck windows
- Windows Bit-Perfect Exclusive output in v1.17.0 using a first-party native WASAPI path
- Honest signal-path badges: the gold exclusive badge only appears under strict lossless/rate/depth/channel conditions

The repo is here:
https://github.com/Evilander/newamp

Latest releases:
https://github.com/Evilander/newamp/releases

I am especially looking for feedback from people with large, old, weird, or high-resolution local libraries.

## Product Hunt

### Product Name

NewAmp

### Tagline

The local-first music player that makes your library feel alive

### Description

NewAmp is a desktop music player and library manager for people who own music. It scans your local files, adds reactive UI, visualizers, private Wrapped videos, smart discovery, natural-language library search, skins, decks, and Windows bit-perfect output. No account. No cloud. No telemetry.

### Maker Comment

Hi Product Hunt, I built NewAmp because I missed music players that felt personal.

Streaming is convenient, but a lot of us still have real local libraries: Bandcamp folders, ripped CDs, FLACs, live sets, demos, rare tracks, and music that never fit neatly into a subscription catalog.

NewAmp tries to make that library feel alive again:

- Local-first library manager
- Reactive UI and fullscreen visualizers
- Wrapped cards and Wrapped Live videos generated on your machine
- Clip Studio to save the last 15 seconds of a visualizer
- Ask Your Library for plain-English local discovery
- Winamp-style skins and shape-changing deck windows
- Bit-Perfect Exclusive on Windows in v1.17.0

I would love feedback from anyone with a messy or large music folder. I am especially interested in scanner edge cases, audio device behavior, and visualizer performance on older hardware.

### Gallery Captions

1. Your local library, organized into a magazine-style Home.
2. Shape-changing compact decks: Windowshade, Record Player, Jukebox, Cassette, Discman, and more.
3. The whole UI reacts to live audio with Resonance.
4. Wrapped Live creates a private vertical recap from local play history.
5. Ask Your Library turns plain English into local discovery.
6. Bit-Perfect Exclusive shows a gold badge only when the strict claim is true.

## Reddit Templates

### Local-first / open-source communities

Title:

I built a local-first desktop music player for people who still have a Music folder

Body:

Creator here. I built NewAmp because I wanted a modern local music player that treats a personal library as the main product, not as a legacy import path.

It runs on desktop, scans local music files, stores the library locally, and does not require an account, cloud sync, telemetry, or a streaming service.

The more unusual parts:

- Local Wrapped and Wrapped Live, generated from private play history
- Clip Studio, which saves the last 15 seconds of a visualizer after the moment happens
- Ask Your Library, for queries like "warm slow stuff from the 70s I haven't played this year"
- Reactive UI and GPU visualizers
- Winamp-style skins and deck windows
- Windows Bit-Perfect Exclusive output in v1.17.0

Repo/releases:
https://github.com/Evilander/newamp

I am not looking for upvotes. I am looking for feedback from people with real local libraries, especially weird folder structures, high-res files, old tags, and huge collections.

### Audiophile communities

Title:

I added an honest WASAPI-exclusive path to my local music player

Body:

Creator here. NewAmp v1.17.0 adds Bit-Perfect Exclusive on Windows.

The design goal was to avoid vague "audiophile" claims. In exclusive mode, NewAmp bypasses Chromium/Web Audio/OS mixer through a first-party native output path. The gold EXCLUSIVE badge is intentionally strict: lossless source, rate + bit depth + channel layout preserved, and no DSD conversion. If something is resampled or altered, the UI says so.

DSP is structurally out of the path in exclusive mode: EQ, ReplayGain, crossfade, limiter, preamp, and software volume are disabled with an explanation. Visualizers still react through a PCM tap.

Docs:
https://github.com/Evilander/newamp/blob/main/docs/audio-quality.md

Releases:
https://github.com/Evilander/newamp/releases

I would value testing from people with external DACs, unusual Windows device formats, and mixed-rate FLAC libraries.

### Visualizer communities

Title:

I built a music visualizer that remembers your local library

Body:

Creator here. NewAmp is a local music player, but the visualizer side became its own thing.

The flagship visualizer, Eviland, reacts across more than just bass. It uses spectral-flux onset detection so different parts of a track can trigger different visual events, and it stores a tiny persistent visual plan per track so songs can develop a visual identity over time.

The new share feature is Clip Studio: while the visualizer is running, it can save the last 15 seconds after the moment already happened.

Repo:
https://github.com/Evilander/newamp

I am looking for feedback on motion, performance tiers, projector behavior, and whether the visuals feel connected to the music instead of just decorative.

## Short Video Scripts

### Script 1: "Still Have a Music Folder?"

Length: 15 seconds

0-2s:
Show a plain folder: `Music - 43,812 files`

On-screen:
"Still have one of these?"

2-6s:
Open NewAmp. Home fills with albums and rails.

On-screen:
"It is not dead storage."

6-11s:
Cut through decks, Resonance, visualizer.

On-screen:
"It is a private music universe."

11-15s:
End card.

On-screen:
"NewAmp. Your local library lives."

Caption:
For people who still have a Music folder.

### Script 2: "Private Wrapped"

Length: 20 seconds

0-3s:
Show Wrapped view.

On-screen:
"What if Wrapped did not need your data?"

3-10s:
Generate Wrapped card, then Wrapped Live.

On-screen:
"Local play history. Generated on your machine."

10-16s:
Show vertical video export.

On-screen:
"No account. No upload."

16-20s:
End card.

Caption:
Your year in music should belong to you.

### Script 3: "Save the Drop"

Length: 12 seconds

0-4s:
Visualizer hits a strong moment.

On-screen:
"Wait. I should have recorded that."

4-8s:
Press Clip Studio save.

On-screen:
"NewAmp already did."

8-12s:
Show exported clip.

On-screen:
"Save the last 15 seconds."

Caption:
Clip Studio is ShadowPlay for your music visualizer.

### Script 4: "Ask Your Library"

Length: 18 seconds

0-3s:
Show command palette.

On-screen:
"I asked my music folder:"

3-7s:
Type:
"warm slow stuff from the 70s I haven't played this year"

7-13s:
Show interpretation chips and results.

On-screen:
"NewAmp understood."

13-18s:
Play a result.

On-screen:
"Crate digging, but local."

Caption:
What would you ask your library?

### Script 5: "The Gold Badge"

Length: 20 seconds

0-4s:
Show normal transport badge.

On-screen:
"Most audio apps make vague claims."

4-10s:
Turn on Bit-Perfect Exclusive.

On-screen:
"NewAmp only turns gold when the strict claim is true."

10-16s:
Show disabled DSP controls and signal path.

On-screen:
"No hidden DSP. No quiet resampling claim."

16-20s:
Show gold EXCLUSIVE badge.

Caption:
Audiophile honesty beats audiophile vibes.

### Script 6: "Winamp Grew Up"

Length: 18 seconds

0-4s:
Show Windowshade or Winamp-style deck.

On-screen:
"Remember when players had personality?"

4-10s:
Cut to Modern, Liquid Glass, Concourse.

On-screen:
"Now give that a real library brain."

10-15s:
Show Home, Discover, Wrapped, visualizer.

On-screen:
"NewAmp."

15-18s:
End card.

Caption:
Winamp nostalgia, local-first 2026 brain.

## One-off Posts

### Download Post

NewAmp v1.17.0 is out.

It is a local-first music player and library manager for people who own music.

New in the latest releases:

- Bit-Perfect Exclusive on Windows
- Wrapped Live
- Clip Studio
- NewAmp Remote
- Ask Your Library

Download:
https://github.com/Evilander/newamp/releases

### Feature Post: Resonance

Most players put the visualizer in a box.

NewAmp makes the player itself react to the song.

The album art, chrome, transport, glow, and motion can all respond to live audio while respecting reduced-motion settings and low-power hardware.

The app becomes part of the instrument.

### Feature Post: Living Tags

NewAmp has a local tagging DSL.

Example:

`tag(midnight_drive) when bpm > 110 and dna.energy > 0.4 and genre matches "synth|wave" boost 1.5`

Your library can re-tag itself from local metadata and audio fingerprints.

### Feature Post: Radio Brain

NewAmp can turn your local library into a tiny private station on your LAN.

Phone, VLC, OBS, Sonos URL import, or anything that reads M3U can tune into routes like your library, random, or a tag-based station.

Local-first does not have to mean stuck on one screen.

## Press Email

Subject:

NewAmp makes local music libraries feel alive again

Body:

Hi [Name],

I built NewAmp, a local-first desktop music player and library manager for people who still own music.

The angle I thought might interest you: while streaming made music convenient, personal libraries have been treated like a legacy corner case. NewAmp goes the other way. It turns local files into a modern music experience with reactive UI, visualizers, private Wrapped videos, smart discovery, natural-language library search, skins, deck windows, and no account or telemetry.

The latest release, v1.17.0, adds Bit-Perfect Exclusive on Windows through a native WASAPI-exclusive path. The app only shows the gold EXCLUSIVE badge when the strict signal-path claim is true.

Repo:
https://github.com/Evilander/newamp

Releases:
https://github.com/Evilander/newamp/releases

Screenshots are in the README, and I can provide short clips of Wrapped Live, Clip Studio, deck skins, and the visualizers.

Thanks,
[Name]

## Comment Replies

### "Why not just use Spotify?"

Spotify is convenient. NewAmp is for music you own: Bandcamp folders, ripped CDs, FLACs, bootlegs, demos, local archives, and tracks that streaming does not represent well. Different job.

### "Why Electron?"

The app uses Electron for the desktop UI, but the audio path is explicit about its limits. On Windows, Bit-Perfect Exclusive uses a native WASAPI-exclusive backend instead of pretending Chromium/Web Audio can be bit-perfect.

### "Does it phone home?"

No telemetry and no required account. Optional services like Last.fm or synced lyrics only run if you choose to use them.

### "Is it actually bit-perfect?"

On Windows, the Bit-Perfect Exclusive path is designed so the gold badge only appears under strict conditions: lossless source, rate/depth/channels preserved, and no hidden DSP. If conversion happens, the UI labels it instead of pretending.

### "Can I use it with a huge library?"

That is one of the main goals. The README says NewAmp has been tested with 60k+ tracks. Real-world edge cases are useful bug reports.

### "Can I share Wrapped without uploading my data?"

Yes. NewAmp Wrapped is generated from local play history on your machine. The campaign should emphasize this because it is one of the clearest differences from streaming recaps.

