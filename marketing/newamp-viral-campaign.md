# NewAmp Viral Campaign: "Your Local Library Lives"

Status: ready-to-run campaign plan  
Prepared: 2026-07-04  
Primary launch anchor: NewAmp v1.17.0, released 2026-07-03

## Campaign Thesis

NewAmp should not be positioned as "another music player." It should be positioned as the local music player for people who still own music and want their library to feel alive again.

The viral idea:

> Your hard drive is not dead storage. It is a private, living music universe.

The campaign should make people feel the gap between streaming dashboards and a player that treats a personal library like a world: reactive chrome, shape-changing decks, visualizers with memory, local Wrapped, live clips, bit-perfect output, no account, no cloud, no telemetry.

## Project Research Snapshot

Verified project facts from the repo:

- NewAmp is a local-first desktop music player for macOS, Windows, and Linux.
- It indexes large local libraries and has been tested at 60k+ tracks.
- It supports MP3, FLAC, OGG, Opus, WAV, M4A, AAC, WMA, AIFF, APE, WV, MPC, DSF, DFF, and more.
- The core promise is "Your local library. Your rules. No streaming. No cloud. No telemetry."
- The app includes 4 UI shells, 9 compact deck skins, 13 color skins, and Winamp 2.x `.wsz` skin import.
- Differentiators include Resonance, NewAmp Wrapped, Wrapped Live, Clip Studio, Living Library Discover, Audio DNA, Sounds Like, Living Tags DSL, Library Radio Brain, Spectral Cover Art, Auto DJ, smart playlists, metadata rescue, artist facts, synced lyrics, guitar tabs, reviews/lists, Last.fm, and local-first privacy.
- The visualizer stack is unusually strong: Eviland, Particle Flow, MilkDrop via Butterchurn, and 24 in-house fullscreen modes.
- v1.16.0 shipped the campaign's strongest share mechanics: Clip Studio, Wrapped Live, NewAmp Remote, and Ask Your Library.
- v1.17.0 shipped Bit-Perfect Exclusive on Windows using a native WASAPI-exclusive path, with honest signal-path badges and gapless same-format splicing.

Sources:

- README: https://github.com/Evilander/newamp/blob/main/README.md
- Package metadata: https://github.com/Evilander/newamp/blob/main/package.json
- Changelog: https://github.com/Evilander/newamp/blob/main/CHANGELOG.md
- Audio quality doc: https://github.com/Evilander/newamp/blob/main/docs/audio-quality.md
- Master plan notes: https://github.com/Evilander/newamp/blob/main/notes/newamp-master-plan-fable5.md

## Positioning

### One-liner

NewAmp is the local-first music player that makes your private library feel alive: visualizers, Wrapped, smart discovery, bit-perfect output, and no cloud.

### Short pitch

NewAmp is for people who still have a Music folder. It scans your local library, gives it a gorgeous desktop player, turns listening history into private Wrapped cards and videos, lets you clip visualizer moments, understands plain-English library searches, and can run bit-perfect on Windows. No account. No subscription dashboard. No telemetry.

### Fight

Streaming made music convenient, but it made personal libraries feel like leftovers. NewAmp turns the collection you already own into the main event again.

### Product category

Use "local music OS" in social copy and "local-first desktop music player and library manager" in technical/community copy.

### Tagline options

- Your local library lives.
- For people who still have a Music folder.
- Own your music again.
- The anti-streaming dashboard.
- Winamp nostalgia, 2026 hardware brain.
- Spotify Wrapped for music you actually own.
- A private music universe on your desktop.

## Audience Segments

1. Local library owners
   - They have FLAC folders, old MP3s, Bandcamp downloads, ripped CDs, live bootlegs, or obscure files that streaming cannot represent well.
   - Hook: "For people who still have a Music folder."

2. Winamp and foobar2000 nostalgia users
   - They miss player personality, dense controls, skins, and real local ownership.
   - Hook: "Winamp grew up, got a library brain, and learned to make videos."

3. Audiophiles and desktop playback people
   - They care about WASAPI Exclusive, sample-rate honesty, ReplayGain, EQ, bit-depth claims, and signal-path transparency.
   - Hook: "The badge only turns gold when the path is actually bit-perfect."

4. Visualizer and VJ users
   - They want reactive visuals, projector windows, clips, GPU effects, and shareable moments.
   - Hook: "Save the last 15 seconds after the drop already happened."

5. Music hoarders, crate diggers, and collectors
   - They want discovery inside their own files, not algorithmic replacement.
   - Hook: "Ask your library for warm slow 70s tracks you forgot you owned."

6. Privacy and local-first software fans
   - They care that it works with no account, no required network, no cloud database, and no telemetry.
   - Hook: "Your Wrapped, without uploading your year."

## Core Viral Loop

The campaign should turn NewAmp users into distribution.

1. User imports a local library.
2. NewAmp produces something personal and visual:
   - Wrapped Live video
   - Wrapped PNG card
   - Clip Studio 15-second visualizer clip
   - Eviland/Particle Flow screenshot
   - Spectral Cover Art grid
   - Ask Your Library result
   - Deck skin screenshot
3. Shared artifact carries a light watermark or footer:
   - "Made with NewAmp"
   - "Local files. No account."
   - "github.com/Evilander/newamp"
4. Viewers ask "what app is that?"
5. CTA sends them to the GitHub release and the campaign landing post.

Do not hide that NewAmp is a desktop app. The novelty is that this runs locally.

## Big Launch Moment

### Campaign name

"Your Local Library Lives"

### Launch post headline

I built a local music player that turns your hard drive into a living music universe.

### Launch asset

A 45-second vertical video:

1. 0-3s: A dull folder named `Music` with thousands of files.
2. 3-8s: NewAmp scans it and Home fills with albums, rails, stats, Today's Pick.
3. 8-14s: Decks flip: Windowshade, Record Player, Jukebox, Cassette, Discman.
4. 14-21s: Resonance makes the whole UI react to the song.
5. 21-28s: Eviland/Particle Flow visualizer explodes, then Clip Studio saves the last 15 seconds.
6. 28-34s: Ask Your Library: "warm slow stuff from the 70s I haven't played this year."
7. 34-39s: Wrapped Live exports a private vertical recap.
8. 39-45s: Signal-path badge turns gold: `EXCLUSIVE`.

End card:

> NewAmp  
> Your local library lives.  
> No streaming. No cloud. No telemetry.  
> Download on GitHub.

Use royalty-free or self-owned music in official campaign clips. Encourage users to share their own library clips, but do not ask them to upload copyrighted music they do not have rights to share.

## Channel Strategy

### Hacker News

Use a technical, curiosity-driven Show HN post. Do not use hype wording, do not ask for votes, and do not coordinate voting. HN guidelines say submissions should satisfy intellectual curiosity, avoid promotional primary use, and never solicit upvotes.

Best angle:

> Show HN: NewAmp, a local-first desktop music player for people who own music

Why it can work:

- Local-first software
- Electron with native WASAPI-exclusive path
- Visualizers, no unsafe-eval main app path for Butterchurn
- SQLite/sql.js library
- No telemetry
- Honest audio signal-path claims

Source: https://news.ycombinator.com/newsguidelines.html

### Product Hunt

Product Hunt is viable because NewAmp has a highly visual product story and a maker/community audience. Product Hunt's launch guide says the best launch day is the day you are most prepared, notes 12:01 AM Pacific as the best time when planning ahead, and says makers should ask people to visit and comment rather than directly asking for upvotes.

Best angle:

> NewAmp - A local-first music player that makes your library feel alive

Use the launch for feedback and early-adopter reach, not as the only growth channel.

Source: https://www.producthunt.com/launch

### Reddit

Reddit should be treated as community contribution, not blast promotion. Reddiquette says to read each community's rules, post to the most appropriate community, keep titles factual, and only post your own content within reason. It also warns against vote requests, mass promotion, and sensationalized titles.

Recommended approach:

- Ask for feedback from specific communities.
- Disclose creator status in the first line.
- Post one relevant angle per community.
- Do not cross-post the same title everywhere.
- Do not ask for upvotes.

Potential community angles to evaluate before posting:

- Local music collections and self-hosted/local-first communities
- Audiophile desktop playback communities
- Winamp/foobar/music-player nostalgia communities
- Music hoarding and archival communities
- VJ/visualizer communities
- Open-source software communities

Source: https://support.reddithelp.com/hc/en-us/articles/205926439-Reddiquette

### TikTok, Reels, Shorts

The short-form channel should be built around "pattern interrupts," not feature checklists. TikTok's Creative Center is useful for studying high-performing auction ads and current creative examples before each posting sprint.

Creative rules:

- First frame must show the app doing something visually impossible to describe.
- Keep captions plain and curiosity-based.
- Use one feature per video.
- End with a comment prompt, not a generic download ask.
- Convert the same recording into 9:16, 1:1, and 16:9 cuts.

Source: https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en

### GitHub

GitHub is the conversion home. Optimize the repo for the campaign:

- Pin the launch video or GIF near the top of the README.
- Add "Start here" install links to releases.
- Add a "Share what NewAmp made from your library" section.
- Add issue templates for "library import issue," "audio output issue," and "visualizer performance issue."
- Add a screenshot/video asset folder in `assets/marketing/` if not already present.

### Press and newsletters

Pitch niche outlets before broad tech press:

- Local-first software newsletters
- Open-source desktop app newsletters
- Music tech blogs
- Audiophile blogs
- Creator tools newsletters
- Retro computing and Winamp nostalgia outlets

The press angle is not "new app released." It is "music ownership is cool again, and this app makes local files look better than streaming."

## The Content Pillars

### Pillar 1: Own Your Music Again

Message:

Streaming is useful, but owning music still matters. NewAmp makes owned music feel modern.

Examples:

- "This is what a Music folder looks like when it gets a pulse."
- "No algorithm. No account. Just the library you built."
- "A player for Bandcamp folders, ripped CDs, live sets, rare tracks, and everything streaming forgot."

### Pillar 2: The App Is the Visualizer

Message:

NewAmp does not confine reactivity to a small pane. The player itself reacts to the music.

Examples:

- Resonance demo
- Eviland instrument-reactive visuals
- Particle Flow GPU particles
- Deck skin transformations

### Pillar 3: Private Wrapped

Message:

You should not need to upload your listening history to get a beautiful recap.

Examples:

- Wrapped PNG
- Wrapped Live video
- "Your year in music, generated on your machine."

### Pillar 4: Crate-Digging Superpowers

Message:

NewAmp helps you rediscover the music you already have.

Examples:

- Today's Pick
- Living Library Discover
- Audio DNA and Sounds Like
- Ask Your Library
- Living Tags DSL

### Pillar 5: Audiophile Honesty

Message:

NewAmp should only make audio claims it can prove.

Examples:

- Gold `EXCLUSIVE` badge
- Direct vs resampled transport readout
- DSP disabled in exclusive mode
- Format badges based on real sample rates

## Launch Timeline

### Phase 0: Prep, 3-5 days

Deliverables:

- 45-second hero video
- 6 short clips, 10-20 seconds each
- 8 screenshots: Home, Albums, Record deck, Jukebox deck, Living Tags, Wrapped, Eviland, Signal Path badge
- Product Hunt gallery images
- HN post
- Reddit variants
- Press email
- Landing thread for X/Bluesky/Mastodon
- README campaign section or release discussion

Prep checklist:

- Use the latest release link, not a build-from-source CTA.
- Verify the release assets and checksums are visible.
- Make the first-run flow obvious in the README.
- Prepare honest caveats: Windows SmartScreen, macOS Gatekeeper, experimental exclusive paths outside Windows if applicable.
- Prepare support macros for import failures, audio output, and performance tier issues.

### Phase 1: Warm-up, days -5 to -1

Goal:

Build curiosity without exhausting the reveal.

Daily posts:

1. "For people who still have a Music folder." Screenshot of folder to NewAmp Home.
2. "A player skin should change the shape of the window." Deck montage.
3. "Your Wrapped should not require an account." Wrapped Live teaser.
4. "The app itself reacts to the song." Resonance clip.
5. "I added a gold badge that only appears when the signal path is actually bit-perfect." Audiophile teaser.

CTA:

- "Launch post tomorrow. I want feedback from people with weird local libraries."

### Phase 2: Launch day

Morning:

- GitHub release thread or discussion
- HN Show HN
- Product Hunt
- X/Bluesky/Mastodon main thread
- YouTube Shorts/TikTok/Reels hero cut

Midday:

- Reply to every substantial comment.
- Post one technical thread about bit-perfect exclusive.
- Post one visual thread about Eviland/Clip Studio.

Evening:

- Post "top questions from launch day" with direct answers.
- Share a user clip if one appears and permission is clear.

Rules:

- Do not ask for upvotes on HN, Reddit, or Product Hunt.
- Ask for comments, bug reports, weird libraries, and test cases.
- Keep claims precise.

### Phase 3: First week

Each day gets a theme:

1. Launch recap and install friction fixes
2. Deck skins and nostalgia
3. Wrapped Live/private recaps
4. Eviland/Clip Studio visuals
5. Ask Your Library and Living Tags
6. Bit-Perfect Exclusive/audio honesty
7. User libraries, clips, and roadmap

### Phase 4: 30-day loop

Run weekly mini-campaigns:

- Week 1: "Show me your library"
- Week 2: "Visualizers are back"
- Week 3: "Private Wrapped"
- Week 4: "Audiophile honesty"

Each week should have:

- 1 hero clip
- 1 technical post
- 1 community feedback post
- 1 user artifact repost
- 1 release/bugfix update

## Viral Challenges

### Challenge 1: #MyLibraryLives

Prompt:

Post a 10-15 second NewAmp clip of a track from your local library that streaming would never recommend.

Asset:

Clip Studio visualizer video or deck recording.

CTA:

> Drop the weirdest folder in your collection. No streaming links. Local files only.

### Challenge 2: #StillHaveAMusicFolder

Prompt:

Show your Music folder count, then show NewAmp turning it into a living library.

Asset:

Screen recording: folder -> scan -> Home -> Discover.

CTA:

> How many tracks are in your offline library?

### Challenge 3: #PrivateWrapped

Prompt:

Export a NewAmp Wrapped card or Wrapped Live video without uploading your history.

Asset:

Wrapped PNG or vertical video.

CTA:

> Would you post your Wrapped if it never left your machine?

### Challenge 4: #SkinThePlayer

Prompt:

Pick a deck: Windowshade, Record Player, Jukebox, Cassette, Discman, Hotdog Deck, Retro TV.

Asset:

Deck montage with polls.

CTA:

> Which one should be the default compact player?

### Challenge 5: #AskYourLibrary

Prompt:

Type a natural-language library request and show the result.

Examples:

- "warm slow stuff from the 70s I haven't played this year"
- "high energy tracks I loved but forgot"
- "quiet late-night albums with no skips"
- "new imports that sound like my top-rated tracks"

CTA:

> What would you ask your music library?

## Growth Mechanics To Add Or Emphasize In Product

These are campaign accelerants, not blockers.

1. Share footer standard
   - Add consistent footer to Wrapped PNG, Wrapped Live, Clip Studio, and exported profile pages:
   - "Made with NewAmp | Local files. No account."

2. Copy post text
   - After export, offer platform-specific copy:
   - "My local library lives. Made with NewAmp."

3. First-run campaign trigger
   - After scan completes, suggest:
   - "Make your first Wrapped card"
   - "Open Discover"
   - "Try a visualizer"

4. Watermark controls
   - Default on for share artifacts.
   - One-click off, remembered.

5. Campaign gallery
   - Add `assets/marketing/` with approved screenshots, GIFs, captions, and logos.

6. Feedback links
   - In release notes and README, route to GitHub issues and discussions with templates.

## Metrics

Primary:

- GitHub release downloads by artifact
- GitHub stars
- First-run successful scans
- New issue quality and count
- Clip/Wrapped exports if locally measurable without telemetry

Secondary:

- HN comments and referral clicks
- Product Hunt comments and followers
- Reddit comment quality
- Short-form saves, shares, and completion rate
- Press/newsletter mentions

Activation events to track locally or in opt-in release proof:

- First library scan completed
- First playback
- First visualizer opened
- First Wrapped export
- First Clip Studio export
- First Ask Your Library query
- Bit-Perfect Exclusive enabled

Do not add telemetry to chase the campaign. If metrics are needed, use aggregate public channel metrics and opt-in/manual proof.

## Risk Controls

### Avoid overclaiming

Say:

- "Bit-Perfect Exclusive on Windows"
- "Gold badge only for strict bit-perfect conditions"
- "No account, no telemetry, no required network"
- "Local Wrapped generated on your machine"

Avoid:

- "Best-sounding player"
- "Works perfectly on every DAC"
- "Spotify killer"
- "Zero network ever" because optional services like Last.fm and lyrics can use network.

### Avoid community backlash

- Do not brigade.
- Do not ask for upvotes.
- Do not spam subreddits.
- Do not use fake user testimonials.
- Do not imply copyrighted tracks can be shared freely.
- Do not hide that it is Electron. The native audio path and local-first design are the stronger answer.

### Support posture

Be explicit:

- "This is a real desktop app, and local libraries are messy. I want bug reports."
- "If your library breaks the scanner, that is useful."
- "If your DAC does something weird, I want to know the exact device and format."

## Success Definition

The campaign is working if people repeat one of these ideas without prompting:

- "For people who still have a Music folder."
- "Private Spotify Wrapped."
- "The player itself reacts to the music."
- "Winamp grew up."
- "A local music OS."
- "It only says bit-perfect when it really is."

## Immediate Next Actions

1. Record the 45-second hero video.
2. Export six short clips from the hero footage.
3. Add a campaign section to the README or create a GitHub release discussion.
4. Launch HN and Product Hunt only when the release assets are easy to install.
5. Start the #MyLibraryLives challenge with the strongest Eviland or Wrapped Live clip.

