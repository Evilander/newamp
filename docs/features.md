# NewAmp feature reference

The [README](../README.md) covers installing and the privacy summary. This page lists what the app does, by area, and what each setting or shortcut does. [Audio quality](audio-quality.md) covers the audio path in more detail.

Contents: [Playback](#playback), [Library](#library), [Playlists and mixes](#playlists-and-mixes), [Now Playing and lyrics](#now-playing-and-lyrics), [Visualizers](#visualizers), [Skins, shells and decks](#skins-shells-and-decks), [History and statistics](#history-and-statistics), [Listening-history import](#listening-history-import), [Network features](#network-features), [Music servers](#music-servers), [Windows, macOS and Linux](#windows-macos-and-linux), [Keyboard shortcuts](#keyboard-shortcuts), [Data and diagnostics](#data-and-diagnostics).

## Playback

### Formats

The scanner reads MP3, M4A / M4B / MP4 (AAC or Apple Lossless), AAC, FLAC, OGG / OGA, Opus, WAV, WMA, ALAC, AIFF, DSF and DFF (DSD), APE, WavPack, Musepack, TTA, Matroska audio (MKA), AC-3 and DTS. M3U, M3U8, PLS and CUE files open as playlists. A CUE sheet next to a single-file album splits it into seekable tracks.

Chromium's own decoder plays what it can. The rest goes through the bundled ffmpeg: WMA, AIFF, DSD, APE, WavPack, Musepack, TTA, MKA, AC-3, DTS, and any MP4-family file whose first sound track is not AAC, FLAC or Opus (Apple Lossless in an .m4a is the common case).

Apple Lossless is labelled ALAC and counts as lossless in Library health and in `quality:lossless`. The codec is read at scan time. Existing .m4a, .m4b, .mp4 and .mka rows are read once more on the next scan to record it, and show a neutral M4A chip until then.

### Transport

- Play, pause, stop, previous, next, seek, shuffle, repeat (off, all, one), playback speed, and an A-B practice loop on Now Playing.
- Shuffle with repeat off ends after every queued track has played once. Repeat all starts a new shuffle cycle that does not open with the track that just played. Queue edits keep the shuffle history.
- Previous counts as a play and wraps around with repeat all.
- The mouse wheel over a seek bar in the main window seeks 5 seconds per notch. A trackpad flick adds up to the same distance, and one gesture is limited in how far it can move the playhead.
- Play with an empty queue and a scanned library starts a mix led by today's pick and says so in a notification.
- Playback stops after 8 failed tracks in a row (fewer if the queue is shorter), with a notification. Next skips tracks the library already knows are missing. The transport shows Buffering while a slow source loads.
- Opening several files from the file manager at once queues all of them.
- The sleep timer pauses instead of stopping, so a podcast keeps its place.
- Clearing the queue shows a notification with Undo. It restores the queue and playback position, paused, for ten seconds. Hovering or focusing the notification keeps it available, and later queue edits take precedence.
- NewAmp reopens the last content view at launch (Settings and About excluded). On a first run, with no library, or during the first-launch tour it opens on Home. Shuffle and repeat are remembered, including with an empty queue.

### Gapless and crossfade

Local tracks play as one decoded stream with each file's encoder delay and padding trimmed, including AAC from iTunes (it reads the iTunSMPB atom). The next track starts on the next sample, and repeat-one loops without a gap. This is the Gapless option (labelled Sample-accurate) under Settings → Playback.

Crossfade, playback speeds other than 1x, streams, podcasts and CUE segments use the standard two-player path instead. Crossfade length is set under Settings → Playback.

### Volume, EQ and limiter

- Volume runs from 0 to 200%. Up to 100% the slider follows a cubic taper, so equal travel is closer to equal loudness change. Past 100% the gain is linear, +6 dB at the top, and the track turns warn then error colour.
- The volume sits before the master limiter. With the limiter on, a boost past 100% gets louder without clipping. With the limiter off, anything past 100% can clip.
- The wheel over any volume control (the slider, the Retro TV knob, the fullscreen visualizer's meter) changes the volume in proportion to how far it turns, and stops at 100%. Keep scrolling after a short pause, or hold Shift, to go past it. Double-click resets to 100%.
- The Up and Down keys step 5% and stop at 100% in the same way. Shift+Up goes on.
- A 10-band equalizer (+/-12 dB) with 11 built-in presets: Flat, Rock, Jazz, Classical, Electronic, Hip-Hop, Vocal, Bass+, Treble+, Night, Car.
- A peak limiter (Clipping protection) and a preamp, both under Settings → Playback.
- ReplayGain off, per track or per album. ReplayGain values come from the file tags or from the analysis buttons in the Library selection bar.
- An output-device picker with a test tone.

### Bit-Perfect Exclusive

Bit-Perfect Exclusive opens the audio device directly through a native addon (miniaudio). It is WASAPI exclusive mode on Windows. On macOS it uses CoreAudio hog mode and on Linux ALSA direct access; both are marked experimental.

While it plays a track, the Web Audio chain is bypassed: no EQ, ReplayGain, crossfade, limiter, preamp or software volume. The negotiated format must come from the formats the device reports. A rate change is done explicitly in ffmpeg and labelled in the signal-path badge, and bit-perfect is only claimed for a lossless source whose rate and bit depth are kept. If a track cannot be opened that way, that track falls back to the normal path. Recording a visualizer clip with Exclusive on gives a clip without sound. See [audio quality](audio-quality.md).

Format badges (FLAC, hi-res, DSD, ALAC and so on) come from the file's sample rate, bit depth and codec. A signal-path badge on the transport shows whether the output is passed through or resampled.

## Library

### Scanning

- Add folders in Settings → Library or drop them on the window. Scans are incremental and can be cancelled. An optional watcher rescans when files change. A large copy into a watched folder is walked incrementally, and the watcher imports at least every 30 seconds during a long copy.
- Star ratings and play counts embedded in files (ID3 POPM and PCNT, Vorbis RATING, FMPS_RATING and FMPS_PLAYCOUNT, iTunes ratings, WMA) are imported for tracks that have no rating or plays of their own. A rating set in NewAmp, including clearing one, is never overwritten. Files that have not changed are not re-read, so a forced rescan imports them.
- MusicBrainz recording, release and artist IDs, ISRC and AcoustID are stored from file tags and included in the metadata export, along with codec and bit depth.
- Tag edits made in NewAmp are stored apart from the file's own tags, so a rescan never undoes them. Edited fields are marked, and each can be reset to the file's value. NewAmp does not write tags to your files.
- A file that disappears keeps its plays, rating, history and playlist places, shows dimmed, and comes back as the same track when the file or drive returns.
- Clean missing files lists what it would remove, backs up the library first, and never touches a drive or share that is offline.

### Search

The search box in the Library (`/` while the Library is open, or Ctrl+F, Cmd+F on macOS, from any main-window view) matches title, artist, album, genre and path. Matching ignores case and accents: `bjork` finds Björk, `ÓLAFUR` finds Ólafur, and Cyrillic and Greek fold the same way. The path part of a search is matched as typed.

Field filters can be combined with free text:

| Filter | Matches |
| --- | --- |
| `title:` `artist:` `album:` `albumartist:` `genre:` | text in that field (quote values with spaces) |
| `year:` | a year or a range such as `1990-1999` |
| `format:` or `ext:` | file extension, e.g. `format:wma` |
| `quality:` or `codec:` | `lossless`, `lossy`, `dsd`, `hires`, `low-bitrate`, `unknown`, `ffmpeg` |
| `replaygain:` | tracks that have ReplayGain data |
| `rating:` or `stars:` | a rating |
| `loved:` | loved or not |
| `avoid:` | tracks excluded from Auto DJ |
| `missing:` and `has:` | a missing or present field, e.g. `missing:art` |
| `tag:` and `untagged:` | Living Tags |
| `path:` | part of the file path |

Example: `artist:radiohead album:"in rainbows" year:2007 format:wma missing:art`.

Quick Play (Ctrl+K or Ctrl+J, Cmd on macOS) is a command palette that also takes plain-English requests. "Ask Your Library" turns phrases such as "warm slow stuff from the 70s I haven't played this year" into year ranges, tempo limits, rating and loved filters, play-recency exclusions and an audio-feature ranking. It runs on your machine, and chips show what it understood. Words it does not recognise fall through to free-text search.

### Browsing

- Library, Loved, Albums, Artists, Folders, Discover and Mixes list tracks in a shared table. Playlists use their own list.
- The Library opens on the track list. A one-row Library health summary above it (grade, profile, counts, missing tags, duplicate groups) expands into a report and remembers whether it was open. The grade weighs tags, cover art, duplicates and audio quality. Suggested clean-ups in the report open the matching tracks.
- Track tables have a labelled Columns button above the header (also the ⋯ in the header, and a right-click on the header row). It hides, shows and reorders columns, with one layout for every track table, kept with the column widths. A fresh install hides Playlist, Mix and Tag.
- Track rows are one Tab stop. See the shortcut table for row keys.
- Albums without art get a generated cover, stable for the same artist and album.
- Folders shows the library as it sits on disk. Save the open folder as a smart playlist (every track under it, subfolders included, in folder order, kept current as files change), or choose Show in Library to filter the Library to that folder.
- The track tables and the Artists list are virtualized, so large libraries scroll without rendering every row. `npm run bench:library-scale` runs a reproducible database benchmark; see the README.

### Track menu

Right-click a track in a track table, a playlist or the queue for Play Next, Add to Queue, Add to Playlist (any playlist, or a new one), Show in Folder, and Move to Recycle Bin (Trash on macOS and Linux). A right-click inside a selection acts on the whole selection.

Move to Recycle Bin asks first and takes a library backup. NewAmp then stops its own decoders on the file, so moving the playing track works on Windows, and the track leaves the library with its plays, ratings and playlist places. A track whose file is already missing is just removed from the library. The item is not offered for CUE or podcast entries. A file in use, or on a drive without a bin (network shares, some removable drives), stays where it is with a plain message. A second request while one is running is refused. It is the only operation that changes your music files on disk.

The backups taken before Move to Recycle Bin or Clean missing files are named `newamp-auto-backup-<time>`, copy only `library.db` and `settings.json`, and the newest five are kept. Backups made from Settings copy everything and are never deleted automatically. Both kinds restore from Settings → Support.

### Audio DNA, Sounds Like and Living Tags

- Audio DNA is a per-track feature vector (loudness, dynamic range, brightness, band energies, onset density) computed locally from decoded audio. Now Playing uses it for a Sounds Like panel ranked by cosine similarity.
- Living Tags are rules like `tag(deep_cuts) when playcount = 0 and rating >= 3 and not loved`. Rules can read DNA, ratings, play history, time of day and other tags, and are evaluated in a sandboxed interpreter (no eval, linear-time regular expressions, cycle detection). Tags are derived, so changing a rule re-tags the library. They work as `tag:` search filters and feed Mixes and Discover.
- Tracks can be given a 0-100 score. Drag, scroll, nudge with the keyboard, or type `88.3`. Stars stay in sync. Scrolling over a score bar changes only the score, and Shift+wheel moves in steps of 1.0.

### Export

Select tracks in the Library to export them as WAV, MP3, FLAC or Opus into a folder you choose. Playlists export as M3U, PLS, or a folder containing the audio files and a playlist.

## Playlists and mixes

- Playlists can be reordered, have artwork (a PNG, JPEG, WebP, GIF or BMP), and import or export as M3U and PLS.
- Smart playlists are saved rules (BPM, key, rating, recency and more). Auto DJ keeps the queue topped up, by default to 24 tracks (adjustable from 6 to 80), by ranking tracks on your plays, loves, ratings and skips, or from a smart playlist you pick. It also refills while shuffle is on.
- Mixes lists eight mixes built from the library: Harmonic (BPM and key), Taste Match, Fresh Imports, Loved Tracks, Recently Played, Heavy Rotation, Deep Cuts and Night Drive. Each plays or saves as a playlist.
- Discover builds playlists from your listening history (recent additions, loved tracks you have not played lately, an album to play through again). Each opens as a session or saves as a playlist.
- Home is built from the library and history: today's pick with the reason it was chosen, your highest-rated tracks, a weekly listening summary, and rails such as Recently Played, Loved Tracks, Fresh Imports and Heavy Rotation.

## Now Playing and lyrics

- Now Playing has a side panel with On Air, Album and Lyrics tabs, a spectrum with four styles, a VU meter, a seek bar drawn over the track's waveform, a tempo trainer, an A-B practice loop and track bookmarks.
- Lyrics come from, in order: a lyrics file next to the audio file or in a `lyrics` folder beside it (`.lrc`, `.txt`, `.lyrics.lrc`, `.lyrics.txt`, named after the file, "Artist - Title", the title, or "Album - Title"), lyrics you saved in the editor (stored in the library), and then LRCLIB. Synced lyrics follow the song, with a karaoke mode and a text-size control.
- The Album tab shows tracks from the same album and other albums from the same year, with a summary from Wikipedia when one is found. The Artists view does the same for artists. These lookups are described under [Network features](#network-features).
- The transport, Now Playing and the Windowshade deck draw that waveform. NewAmp decodes each local file once with ffmpeg to get the peaks and keeps them in `waveform-cache/`. Streams, server tracks and podcast episodes get a plain bar. Hovering the bar shows the time under the pointer.
- The Seek bar row under Settings → Performance (after Resonance) turns the waveform off. The plain slider comes back and the background decoding stops, including any that is running or queued.
- Deck mode has a camera button and Ctrl+Shift+S, which save the deck as a framed PNG with the title, artist and skin name.

## Visualizers

The fullscreen visualizer (F) groups its modes as MilkDrop (Eviland Live and plain MilkDrop through Butterchurn), Shaders, GPU particles (Eviland and Particle Flow), Reactive, Classic and Album art. Right-click on it for a menu at the pointer with next and previous look, Randomize, Lock look, a Mode submenu, Browse all modes, Settings and Exit. Arrow keys or `[` and `]` step through modes. Double-click on the bare stage toggles OS fullscreen.

### Eviland

Eviland is NewAmp's own GPU visualizer (WebGL2).

- Audio analysis splits the signal into 24 bands and detects onsets, grouped into kick, bass, snare, hat and vocal frequency ranges. These are band ranges, not instrument recognition. Energy, kick and the band levels are measured against the track's own loudness, so a quietly mastered track moves as much as a loud one, and a verse reads lower than its chorus.
- Each look chooses its sources, motion and palette. A seed code reproduces a look and can be pasted into the seed box in the visualizer settings.
- Sources are procedural scenes plus fluid, reaction-diffusion and slime-mould simulations. Eight motion kinds bend the feedback field: cells, coral, marble, chroma, droste, Möbius, tendril and peristalsis. Scenes composite with partial occlusion, so trails continue through strokes.
- A look change runs both looks at once behind a moving front instead of crossfading a still frame.
- The Director rotates looks over time, and with look-ahead (below) it changes them on the song's bar lines. Auto-VJ switches modes by energy.
- Each track keeps a visual lineage, so a returning section gets its look back.
- Palettes: Per look, Theme, Phosphor, Ice, Sunset and Cycle. Reactivity: Truth, Punch or Wild.
- Eviland and Particle Flow restart themselves if the graphics context is lost.

### Eviland Live

Eviland Live draws Eviland's sources into MilkDrop's feedback loop, so the preset's blur, echo and decay apply to them too, under one palette. If that fails, the frame shows plain MilkDrop.

### Look-ahead

For local files, Eviland reads the track ahead of time to find its beat grid, bar lines (including 3/4), sections and repeats, builds, drops and key changes. Looks change on the bar line, a build dims the picture, and the drop lands on its downbeat. Detection is a best guess from the audio. Analysis starts in the background when an Eviland mode first shows the track, so cues may arrive a little after it begins. Only the first 20 minutes of a track are analysed. Results are cached in `score-cache`, so a track is analysed once. It can be turned off in the visualizer settings.

### MilkDrop

MilkDrop presets run in Butterchurn inside their own frame, so the main window never allows `eval`. Presets are prewarmed and compiled off the paint path. The bass, mid and treble bands fed to presets are computed from the output's actual sample rate.

### Other modes, quality and performance

- Particle Flow draws GPU particles. The count grows with the window size and the quality setting, from fewest in Lite to most in fullscreen at 4K quality.
- Q toggles the 4K render option, which allows up to a 2x pixel ratio and about 8.3 megapixels. Governors trim the resolution on slower machines. Shift+L toggles Lite, which renders at a lower resolution and particle count.
- The album-art overlay is off until turned on (A, or the visualizer settings).
- Performance (auto, high, lite) and Resonance are under Settings → Performance. Resonance is a 30 Hz loop that writes audio levels to a few marked interface elements (a glow from the album art, a beat pulse on controls). It stops when the window is hidden, playback is paused or the tier is low, and it respects the system reduced-motion setting.

### Flash protection

On by default for every visualizer output, the projector and recordings (Settings → Performance). It limits any patch of the screen of 1% or more to three flashes a second (the thresholds in WCAG 2.3.1), including out-of-step flicker such as stripes or reversing checkerboards, and pulls saturated red toward grey. Dense bright-on-black looks run darker with it on. Turning it off asks you to confirm. It is a limiter on the picture, not a conformance claim.

### Capture and projector

- Shift+R saves the last 15 seconds of Eviland Live as an MP4 (up to 1080p) with audio. It uses a WebCodecs ring buffer and works only in the Eviland Live mode above Lite.
- The visualizer settings also record a WebM clip and save or copy a PNG still.
- The detached projector opens the visualizer in a separate window, for a second display. Its control bar has transport, seek and volume, and the window takes the arrow keys (left and right seek 5 seconds, up and down change the volume).
- While the fullscreen visualizer or the projector is showing and music is playing, the display is kept awake.

## Skins, shells and decks

Appearance has independent parts:

| Part | What it controls | Where |
| --- | --- | --- |
| Shell | Layout, sidebar, transport and materials: Retro, Modern, Liquid Glass, Concourse | Settings → Shell |
| Skin | 13 colour palettes: Classic, Ops, Midnight, Neon, Amber, Oxide, Steel, Record Deck, Jukebox, Vintage Computer, Ice, Miami, Mono | Settings → Skin |
| Deck | The shape of the compact window | Picker in deck mode |

- Shift+S in the app or the visualizer steps to the next skin.
- Drop a Winamp 2.x `.wsz` (or `.zip`) skin onto the window to import it; the palette is derived from the bitmap. Custom skins are `.newampskin.json` files.
- The Skin Workshop edits 18 colours and two corner radii live. Text on accent is the label colour on pressed buttons and other accent-coloured fills. A skin that does not set it, such as an imported one, gets black or white, whichever contrasts better with its accent. Export a skin to a `.newampskin.json` file to share it. Edit over the app opens the same colours in a floating editor (below). A skin you import, drop on the window or save over goes under Previous skins (the last 8, kept on this computer), with an Undo on the toast.
- Contrast is checked for each built-in skin by `scripts/theme-contrast-test.mjs`: 4.5:1 for body text and labels, 3:1 on the hover surface. This is a regression check, not a conformance claim.
- Text size (Settings → Shell) scales all type.

### Colour editor

Edit over the app, in the Skin Workshop (Settings → Workshop), or Edit Colours in Quick Play opens the Workshop's colours in a panel that floats over the app. It stays over every view, the fullscreen visualizer included, so a skin can be tuned while a look plays. Drag the title bar to move it, or use the arrow keys on the grip. Esc closes it, and it remembers where it was left. In deck mode it steps aside and returns when the app does.

Each colour has a picker, a value field and, except for solid surfaces such as Background and Panels, an opacity slider. Tint everything shifts hue, saturation and brightness for the whole skin at once and leaves the warning and error hues alone. A Contrast list measures text pairs against 4.5:1 and the accent on panels against 3:1, on what is on screen, and says in words when a pair is low.

The panel and the Workshop page edit one draft. Changes show at once, Save skin keeps them, and Discard goes back. Closing the panel with unsaved edits asks whether to save, discard, keep the preview or keep editing.

### Sidebar

The sidebar groups the views as Main, Explore, Discovery, Yours, Streaming and App. Click a group's heading to collapse or expand it. Right-click the sidebar, or press Customise under Tools, to show or hide each item and move it up or down within its group. Reset restores the default layout. The choices are remembered.

Settings cannot be hidden, and the view you are on stays listed even if it is hidden or its group is collapsed. Streaming (Music Servers, Podcasts and Radio) starts collapsed and opens by default once the library has a music server or a podcast feed, or after you open Radio. Quick Play opens most views by name, whether or not the sidebar shows them.

### Decks

Deck mode (Ctrl+M, Cmd+Shift+M on macOS) shrinks the window into one of eight skins, each with its own window size: Windowshade, Winamp Classic, Winamp Industrial, Record Player, Jukebox, Cassette Deck, Discman and Retro TV. Every deck has PIN (stay on top), FULL (leave deck mode), minimize and close, and its transport buttons have accessible names.

- Retro TV: the volume knob is the volume (drag, scroll or arrow keys, PageUp and PageDown for larger steps, Home for 0, End for 200%). The channel knob changes track: click or drag (up or right is next), Shift+click for previous, wheel, or the arrow keys, PageUp and PageDown, Enter and Space when it has focus.
- Jukebox: the twelve selector keys play entries of the queue, a page of twelve at a time, with the page letter in the readout (A-01 to A-12, then B-01). The playing entry is lit and unused keys are disabled. Only the page holding the playing entry is reachable.
- Record Player: SPEED and PITCH are printed on the panel and are not controls. Discman: the slider is the volume control.
- Deck mode toggles in both directions with the same chord.

## History and statistics

- History lists every play with listening insights.
- Wrapped gives recaps for today, the week, the month, the year and all time: time listened, top tracks, artists and albums, genre breakdown, a 24-hour listening clock, streaks and discoveries. It exports a PNG card, or a 30-second 1080x1920 video scored to your top track. Exporting does not replace the queue, count a play or scrobble.
- Profile holds reviews and diary entries on tracks, albums and artists, ranked lists, five favourites, per-item privacy and a self-contained static HTML export.

## Listening-history import

Open History → Import listening history after scanning your music.

- Last.fm: enter a public username and configure your API key in
  Settings → Last.fm. Scrobbling and account authorization are not required.
  The importer fetches completed plays across pages up to a fixed cutoff time,
  shows progress, and supports cancellation before applying the import. Up to
  500,000 plays can be imported at once; larger histories need a file export
  divided into smaller files.
- Files: choose a CSV or JSON export, up to 64 MB and 500,000 plays per file.
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

## Network features

NewAmp makes no network request on its own account: no telemetry, analytics, crash upload or update check. Every request below belongs to a feature. The [README](../README.md#privacy) lists the same hosts with what each one is sent.

| Feature | Host | When |
| --- | --- | --- |
| Lyrics | lrclib.net | Automatically, for the playing track, while Now Playing is open and no local lyrics are found. Sends artist, title, album and duration. |
| Artist and album summaries | en.wikipedia.org | Automatically, while Now Playing is open (artist picture and facts, and album notes in the Album tab) and in the Artists view. Sends the artist or album name. |
| Metadata Rescue | musicbrainz.org | When you press the lookup for a track. Sends its title, artist and album. |
| Last.fm scrobbling | ws.audioscrobbler.com, www.last.fm | When Last.fm is connected. Sends now playing and finished plays. |
| Last.fm history import | ws.audioscrobbler.com | When you run an import. Sends the username you typed. |
| Podcasts | the feed hosts you subscribe to | On subscribe, refresh and download. |
| Internet radio | radio-browser.info mirrors, then the station's own stream host | When you search stations or play one. |
| Music servers | the server URL you enter | When connected. |
| Liner notes | api.openai.com | Only if you save an OpenAI key under Settings → Assist, and only when you press the AI Notes button. If the `NEWAMP_OPENAI_BASE_URL` environment variable is set, the request goes to that address instead. |

The lyrics and Wikipedia lookups have no off switch. They only happen while Now Playing or the Artists view is open, so the ways to avoid them are to stay out of those views or to block the hosts. Results are kept in the browser storage inside the profile folder (`Local Storage/`) so the same artist or track is not fetched twice. Pictures those services point to (podcast artwork, radio station icons, Wikipedia images) load directly from whoever hosts them.

- Last.fm: scrobbling and now-playing updates with an offline outbox that retries. You supply your own Last.fm API key and shared secret.
- Podcasts: subscriptions, downloads (stored under the profile folder), progress tracking. Feed and episode requests refuse localhost and private-network addresses.
- Internet radio: station search by name, tag and country through radio-browser.info. Playing a station also tells radio-browser which one was chosen, as that service asks of clients.
- NewAmp Remote and Radio Brain (below) are servers that NewAmp runs, off by default.
- Liner notes send the track's title, artist, album, album artist, genre, year, length, rating, BPM, key and play and skip counts, plus up to 3 highlighted lyric lines and a preview of up to 18 lines (or the first 1,200 characters of unsynced lyrics), to OpenAI's API when you press the button. The track's numeric ID in your library goes along with them. The key is saved in `settings.json`.
- A guitar-tab search against ultimate-guitar.com exists in the main process; nothing in the interface starts it in this version.
- An album-art lookup against MusicBrainz and the Cover Art Archive exists in the main process; nothing in the interface starts it in this version.

### NewAmp Remote and Radio Brain

Both are off by default (Settings → Library) and run from one local HTTP server (default port 17117) on all network interfaces, over plain HTTP with no encryption. Every route except the remote page itself, which holds no data, is behind a token unique to your install, and the token appears in the playlist and audio URLs. Use them only on a network you trust. The remote link can be regenerated, which invalidates old links.

- NewAmp Remote: scan a QR code to control playback from a phone on the same network: art, transport, seek, volume and the current track, updated live.
- Radio Brain: the library as a station. `/library.m3u` and `/tag/<name>.m3u` list up to 5,000 tracks. `/random.m3u` returns 200 tracks picked at random from the first 5,000 tracks in artist order, so in a larger library most tracks never appear in it. `/library.m3u` and `/random.m3u` leave out tracks whose file is missing. `/audio/<id>` streams a file, so a player such as VLC can play it. Legacy formats are served as WAV through ffmpeg.

## Music servers

Music Servers connects to Jellyfin and Navidrome / compatible Subsonic
servers with your server URL, username, and password. LAN HTTP URLs and
reverse-proxy subpaths are supported; HTTPS protects credentials in transit.
Saved connections use the OS credential store. Turn off Remember connection
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

## Windows, macOS and Linux

### Windows and Linux

- A tray icon keeps playback running when the window is closed. Settings → Shell has the close-button choice: minimize to the tray, or quit. Without a working tray the close button minimizes to the taskbar instead, and closing the minimized window quits.
- Windows has taskbar thumbnail buttons (previous, play or pause, next).
- Hardware acceleration is on by default. After a GPU process crash NewAmp falls back to software rendering.

### macOS

- Cmd replaces Ctrl in the shortcuts (see the table). The NewAmp menu has Settings (Cmd+,), which opens the Settings view and brings the window back if it was closed to the Dock. The View menu has zoom in, zoom out and reset (Cmd+Plus, Cmd+Minus, Cmd+0) and full screen (Ctrl+Cmd+F).
- Closing the window with the red button hides it and playback continues. Click the Dock icon to bring it back, and Cmd+Q quits. The Settings choice reads "Keep playing in the Dock" or "Quit NewAmp".
- The Dock menu has Previous, Play or Pause, Next and Stop. The menu bar is the standard one (app, Edit, View, Window, Help), and Help links to the GitHub page and issue tracker.
- The visualizer's fullscreen uses simple fullscreen, which does not create a new Space.
- Without a Developer ID certificate, builds are ad-hoc signed and not notarized, which is why first launch needs the steps in the README. [macOS signing](macos-signing.md) covers the signed path.

### All platforms

- The main window's position, size and maximized state are remembered, and the deck's position separately. A window whose display is gone reopens on screen.
- If the interface process crashes, NewAmp reloads the window from the saved session, at most twice a minute.
- The Windows installer and the macOS app register NewAmp as a viewer for the supported audio and playlist file types, so files opened from the file manager play in NewAmp.
- A first-launch tour introduces the main shortcuts. Settings → Assist can show it again.

## Keyboard shortcuts

On macOS, Cmd takes the place of Ctrl in these shortcuts unless a row says otherwise. Shortcuts that are not typing in a text field work after clicking the seek bar or a volume slider; plain arrow keys stay with a focused slider. Space plays or pauses after you click a toolbar button such as Next. After you click a checkbox or radio button, or inside a dialog, Space keeps its own meaning.

### Anywhere in the main window

| Shortcut | Action |
| --- | --- |
| Space | Play or pause |
| ← and → | Seek 5 seconds back and forward |
| ↑ and ↓ | Volume in 5% steps. ↑ stops at 100%; Shift+↑ goes past it |
| Ctrl+← and Ctrl+→ | Previous and next track (also Cmd+← and Cmd+→ on macOS) |
| Cmd+↑ and Cmd+↓ (macOS) | Volume |
| Z, X, C, V, B | Previous, play, pause, stop, next |
| L | Love or unlove the current track |
| 0 to 5 | Star rating for the current track |
| F | Fullscreen visualizer |
| Shift+S | Next built-in skin |
| Ctrl+K or Ctrl+J | Quick Play |
| Ctrl+F | Focus the Library search. Ignored in deck mode, the fullscreen visualizer, Quick Play and the first-launch tour. On macOS it is Cmd+F only |
| Ctrl+M | Toggle deck mode both ways (Cmd+Shift+M on macOS, where Cmd+M is Minimize; Ctrl+M also works) |
| Ctrl+Shift+S | Save a deck snapshot, deck mode only (Cmd+Shift+S on macOS; Ctrl+Shift+S also works there) |
| Cmd+, (macOS) | Open Settings, from the NewAmp menu |

Ctrl+↑ and Ctrl+↓ are not bound.

### Library

| Shortcut | Action |
| --- | --- |
| / | Focus the search box. Esc clears it, then leaves it |
| ↑ and ↓ on a focused row | Move between rows |
| Enter | Play the row |
| Q | Add the row to the queue |
| Shift+Q | Play the row next |
| L, 0 to 5 | Love or rate the row |
| Tab | Only one row is in the Tab order. Tab steps through its buttons, then leaves the table |
| ← and → on a column resize handle | Resize (Shift for larger steps) |

The search box is not focused on arrival, so Space, L, the rating keys and the arrows control the player until you ask to search.

### Fullscreen visualizer

| Shortcut | Action |
| --- | --- |
| ← and →, or `[` and `]` | Previous and next mode |
| Q | Toggle 4K render quality |
| Shift+L | Toggle Lite |
| A | Album-art overlay |
| P | Cycle the colour palette |
| R | Cycle reactivity (Truth, Punch, Wild) |
| Shift+R | Save the last 15 seconds (Eviland Live) |
| Shift+V | Auto-VJ |
| Shift+S | Next built-in skin |
| F | Native fullscreen |
| H | Hide the controls |
| L and V | Love, and stop, as everywhere else |
| ? | Help |
| Esc | Close the menu, then an open popover, then the visualizer |
| Right-click | Visualizer menu |
| Double-click | Toggle fullscreen on the bare stage; on the volume meter, set 100% |

Any key with Ctrl, Cmd or Alt held belongs to the app, so Ctrl+← and Ctrl+→ skip tracks there too.

## Data and diagnostics

The profile folder is `%APPDATA%\newamp` on Windows, `~/Library/Application Support/newamp` on macOS and `~/.config/newamp` on Linux. The portable Windows build uses a `NewAmp Data` folder beside the exe when no profile exists in the default location; anyone who already ran a portable build keeps their library in `%APPDATA%\newamp`, and a read-only exe folder falls back to the default.

The table lists the main items. Chromium keeps its own files in the same folder (caches, session data).

| Item | Contents |
| --- | --- |
| `library.db` | Library, ratings, plays, tags, playlists, reviews |
| `settings.json` | Settings, window positions, Last.fm and OpenAI keys |
| `podcasts.json` | Podcast subscriptions |
| `music-servers.json` | Saved music-server connections, encrypted with the OS credential store |
| `art/`, `playlist-art/` | Cover art and playlist artwork |
| `transcode-cache/`, `score-cache/`, `waveform-cache/` | Cached decodes, look-ahead scores and waveform peaks |
| `Local Storage/` | Browser storage holding the lyrics and Wikipedia lookups already fetched |
| `podcast-downloads/` | Downloaded episodes |
| `backups/` | Backups described above |
| `diagnostics/` | `events.jsonl` and crash dumps (never uploaded) |

Settings → Support has Create backup and Restore backup (a folder-based copy of the profile), shortcuts to the library database, crash log and crash dumps, and Copy input log, which copies the last 200 wheel events over the volume controls for volume bug reports.

If `library.db` is corrupt at startup, NewAmp quarantines it and starts with an empty library instead of failing to open. A file locked by another process is left untouched.
