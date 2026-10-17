# Changelog

Notable changes to NewAmp. Versions follow [semver](https://semver.org/).

Release notes for every version, including everything before 2.0, are on the
[releases page](https://github.com/evilander/newamp/releases).

## [2.7.0] - 2026-10-16

The whole library is analysed in the background, so Sounds Like, harmonic
mixes and the tempo filters cover everything you own without a manual step.
Albums are grouped the way the files describe them, which turns compilations
and multi-disc sets back into single albums; the first launch after updating
regroups them and starts the analysis, and neither touches your music files.
The library and settings are backed up once a day, internet radio plays the
plain-http stations that are most of the directory, and files opened from
Explorer or Finder join the queue instead of replacing it. Home, Discover,
Mixes and Folders open without stalling the app on large libraries. On a Mac,
Cmd+W closes the window, the menu says NewAmp, and Bit-Perfect Exclusive waits
for the device to switch sample rate, checked on real hardware for the first
time.

### Added

- The whole library is analysed in the background: tempo, key, loudness
  (ReplayGain), audio DNA and the seek-bar waveform, from one decode per
  track. It waits while playback is short of audio, during scans, on battery
  and when the computer is busy, picks up where it left off after a restart,
  and never writes to music files. Settings > Library shows progress and the
  time left, and can turn it off. On 17 test files it took 1.4 seconds per
  track, about 22 hours for a 58,000-track library. Sounds Like, harmonic
  mixes and tempo filters work across the library as it fills in.
- The library and settings are copied once a day to a backups folder in the
  app's data folder. Five are kept, a copy is skipped when nothing changed or
  the drive is nearly full, and each one is checked before older ones are
  removed. Settings shows them and can turn this off.
- The Windows media controls show the album cover.
- Lyrics embedded in the audio file are shown when there is no saved or
  sidecar lyrics file.

### Changed

- Albums are grouped the way the files describe them, not by each track's
  artist. Compilations, soundtracks and other various-artists releases are one
  album instead of one fragment per performer, using the compilation flag,
  ALBUMARTIST, the folder and disc numbers. Multi-disc sets show a heading per
  disc. On a 58,001-track library the Albums grid went from 5,903 entries to
  4,910. Each album page says why its tracks were grouped, and "Show as
  separate albums" undoes a grouping you disagree with; the choice survives
  rescans and retagging.
- Scans now keep the album artist, sort names, compilation flag, disc and
  track totals and MusicBrainz release group from each file. Libraries scanned
  before this read those tags in the background, pausing while music plays.
- Album ratings move with their albums. The first launch copies library.db
  to library.db.before-album-keys.bak before changing the ratings table,
  because earlier versions can't write ratings to the new one.
- Opening audio files from Explorer, with Open with, a double-click or a
  drop, plays them next and keeps the rest of the queue. It used to replace
  the whole queue.
- The Library list loads more rows as you scroll instead of one "Load more"
  click per 600 tracks, and it fills in while a scan adds tracks.
- Library health lists what is missing and where to fix it, without grading
  the library with a letter.
- Radio's genre chips are a short list of common genres, and station search
  matches names and tags. Radio Brain's playlists page through the whole
  library instead of stopping at 5,000 tracks.
- The first time the close button hides NewAmp to the tray, it says so and
  explains how to quit and where to change it.
- The startup script is 340 KB, down from 441 KB: the visualizer engine
  loads when a visualizer or projector opens, as it did in 2.5.
- Home, Discover, Mixes and Folders no longer stall the app while they load.
  On a 58,000-track library the longest single step when opening Home went
  from 1.2 seconds to 57 ms, Folders from 1.2 seconds to 49 ms, and Discover
  and Mixes from about 0.6 seconds to under 60 ms. Results are the same.

### Fixed

- Playback no longer stops to buffer when the music drive is busy for a few
  seconds. Gapless playback keeps 30 seconds decoded ahead instead of 3, so a
  drive slowed down by downloads or by another program scanning the library
  doesn't interrupt the track.
- The seek bar's waveform and the visualizer's song analysis wait while
  playback is short of audio, and one already reading the next track stops,
  so on a slow drive they no longer compete with the track that's playing.
- Scrolling Albums sorted by Recently added while new music is being added
  no longer shows the same albums twice.
- Internet radio stations that stream over plain http play. That was most of
  them: 647 of the 1,000 most-voted stations. A station shows as live only
  once it is actually playing, and a failure says why.
- Starting a scan from the empty Library left the empty screen up until the
  app was restarted.
- A folder added in Settings is scanned right away.
- The title bar said "Ready. Load your library." whenever nothing was
  playing, even with a library loaded.
- The first-run hints point at the controls they describe instead of
  floating over the view.
- Settings no longer lists assistant features that were never built, and the
  Last.fm help says what the API key and secret are for.
- Leaving the fullscreen visualizer could shrink the window to 980x640 in
  the corner of the screen and remember that size.
- Media keys no longer turn off the Windows media controls.
- On Linux with native Wayland the window sometimes never appeared, and the
  Linux window had no icon.
- Logging off, shutting down or a crash could lose the library changes made
  since the last save.
- A first run on Windows or Linux no longer adds the empty Public Music
  folder, and when a scan finds nothing, Home says which folder it looked in.
- Cancelling a scan left the banner on "Scanning"; it now says the scan
  stopped.
- The folder picker opened at a fixed drive letter instead of the Music
  folder.
- Cover images in album folders are found under more names and layouts
  (front, cover and folder in any case and image type, the only image in the
  folder, or one folder up from a disc folder). On a 5,993-album library 408
  more albums have art. Existing albums pick it up on the next scan.
- Tracks never analysed had a tempo of 0, so a "slow" tempo filter matched
  all of them.
- Error messages no longer start with "Error invoking remote method".
- On a Mac, Cmd+W closes the window (it hides and keeps playing, like the
  close button). The Window menu had no Close item, and About, Hide and Quit
  said "newamp" instead of NewAmp.
- Bit-Perfect Exclusive on macOS waits for the audio device to finish
  switching sample rate before opening it. A 44.1 kHz track on a device left
  at 48 kHz could be refused as a hidden resample because the stream opened at
  the old rate; and when a device refused hog mode, its sample rate was left
  at the track's rate instead of put back.
- On macOS and Linux, when the app runs without the GPU after a graphics
  crash, MilkDrop and the projector use software WebGL instead of failing to
  start.

## [2.6.0] - 2026-10-11

The seek bar now draws the track's waveform, the colour editor can stay open
over any view, and the sidebar's groups collapse while its items hide and
reorder. Apple Lossless files in .m4a play and are labelled ALAC. Track
tables have a column chooser, Move to Recycle Bin / Trash is in the track
menu, and library search ignores accents. The visualizer has three new
scenes, reacts relative to each track's loudness, and recovers when the GPU
takes its graphics context. Several defaults changed too, and each one is
listed under Changed.

Thanks to u/mojsterr, whose detailed reports from testing 2.5.0 and 2.5.1 on a
Mac mini led to the column chooser, Move to Recycle Bin, the waveform seek bar,
the floating colour editor, the rearrangeable sidebar and the pressed-button
text colour that had been tied to the Background.

### Added

#### Playback and formats

- The transport's seek bar is the playing track's waveform, and Now Playing's
  overview shows the real waveform instead of one shape for every track. The
  Windowshade deck's seek strip draws it as well. NewAmp builds the waveform
  once per local file in the background and keeps it in `waveform-cache`.
  Until it is ready, and for streams, server tracks and podcast episodes, the
  bar stays plain. Hovering the bar shows the time under the pointer.
  Settings > Performance has a Seek bar row after Resonance. Turning it off
  gives back the plain slider and stops the background decoding, including
  any already running or queued.
- In the main window, the mouse wheel over a seek bar seeks 5 seconds per
  notch.
- Play with an empty queue and a scanned library starts a taste mix led by
  today's pick, and a toast says so. This covers Space, the media keys and the
  tray.
- The transport shows Buffering while a slow source loads.

#### Library and search

- Track tables have a column chooser: the Columns button above the header, the
  ⋯ at the left of the header, or a right-click on the header row. It hides,
  shows and reorders columns, so Stars can sit next to the title. One layout
  serves every track table and is remembered with the column widths.
- Move to Recycle Bin (Trash on macOS and Linux) is in the track right-click
  menu. It asks first, takes a backup, then moves the files. The tracks leave
  the library along with their play history, ratings and playlist entries. A
  track that was on one of your Lists (in Profile) stays there as a plain text
  entry with the track's title. A queued track drops out of the queue. NewAmp
  stops its own audio decoders that have the file open before moving it, so
  the track that is playing can be moved on Windows too, and playback carries
  on with the next track. A selection of more than 25 files shows a progress
  toast. A file that is in use, or on a drive with no Recycle Bin (network
  shares, some removable drives), stays where it is with a plain message. CUE
  and podcast entries don't offer the item.
- Library search ignores case and accents the way people type: `bjork` finds
  Björk, `ÓLAFUR` finds Ólafur, and Cyrillic and Greek work too. It applies to
  track search, the `title:`, `artist:`, `album:`, `albumartist:` and `genre:`
  filters, Albums and Artists. The path part of a search is still matched as
  typed. Existing libraries are backfilled once on first open. `library.db`
  gets larger because it now stores a folded copy of the searchable text.
- Scans read star ratings and play counts stored inside files (ID3 POPM and
  PCNT, Vorbis RATING and FMPS tags, iTunes ratings, WMA) for tracks that have
  neither yet. A rating you set in NewAmp, clearing one included, is never
  overwritten. Files that haven't changed aren't re-read, so this applies to
  new and changed files, and to the .m4a, .m4b, .mp4 and .mka files read once
  more for the ALAC label. There is no rescan button for the rest yet.
- MusicBrainz recording, release and artist ids, ISRC and AcoustID are stored
  from file tags, and the metadata export includes them along with codec and
  bit depth.

#### Volume and keyboard

- In the main window, double-click a volume slider for 100%.
- Ctrl+F (Cmd+F on macOS) focuses the Library search from any view, and `/`
  does the same inside the Library. Esc clears the box, then leaves it.
- Ctrl+M toggles deck mode both ways; it used to only enter it. On macOS the
  chord is Cmd+Shift+M, because Cmd+M is Minimize. Ctrl+M still works there.
- With a track row focused, `0` to `5` rate that row and `L` loves it. With no
  row focused they act on the playing track.
- Settings > Support Diagnostics has a Copy input log button. It copies the
  last 200 wheel events over the volume controls, with the app version, so a
  report about the wheel can say what the wheel actually sent.

#### Visualizer and Eviland

- Right-click in the fullscreen visualizer opens a menu at the pointer, in
  place of the big preset grid. Esc closes the menu, then a popover, then the
  visualizer.
- Three new scenes: Spectral Strata, Bokeh Field and Data Raster.
- Eviland measures energy, kick and band levels against the track's own
  loudness, so a quietly mastered track reacts about as strongly as a loud one
  and a verse reads lower than its chorus. Very quiet recordings can still fall
  below what the analyser sees. The live section detector fires on verse and
  chorus changes and recognises a section that comes back, so a chorus gets its
  look back. It stays quiet during fade-outs and on loops, and never fires in
  the first 10 seconds of a track.
- Song scores get the tempo right more often: a backbeat track is less likely
  to come out at half tempo and a hi-hat pattern at double. Some syncopated
  tracks still read at double tempo. Scores also detect 3/4, recognise a final
  chorus raised a semitone as the chorus, and no longer cut fade-outs or
  constant loops into sections. Scores from earlier versions are recomputed the
  next time a track plays. Motion runs on a continuous beat clock, so it no
  longer twitches at each beat line, and look rotations land on a beat line or
  a 16-beat phrase line.
- Eviland keeps its colour in step with the music instead of greying every
  track. Where a look uses only a little of the liquid effect, its colour is
  now added on top of the picture, where it used to darken it. Album cover
  colours reach the on-screen Eviland, Eviland Live and the projector the same
  way, and a fade between a look that follows the cover and one that doesn't is
  smooth.
- Randomizing an Eviland look puts a seed code you can paste in the box. It
  used to say `seed-1`, `seed-2`, and so on.
- If the GPU takes Eviland's graphics context and it doesn't come back within
  about three seconds, the visualizer and the projector switch to a simple 2D
  picture instead of freezing.
- The projector takes Cmd+Left/Right and Cmd+Up/Down on macOS, and Up and Down
  change its volume everywhere. Right-arrow seeking works on streams. Its
  sliders use the skin's accent colour, its pixel ratio, quality tier and
  sample rate follow display and output changes, and MilkDrop there knows
  whether a track is playing.

#### Decks

- The Retro TV's volume knob is the volume: drag it, scroll over it, use the
  arrow keys, or double-click for 100%. Its channel knob changes track when
  clicked or dragged (up or right is next), with Shift+click for previous, the
  wheel, or the arrow keys, PageUp, PageDown, Enter and Space when focused.
- The Jukebox's selector keys play queue entries, twelve to a page, with the
  page letter in the readout (A-01 to A-12, then B-01) and the playing entry
  lit. Unused keys are disabled. The keys cover the page that holds the playing
  entry, so entries on other pages of a long queue can't be reached from the
  cabinet.

#### Skins, colours and sidebar

- A colour editor that floats over the app. Edit over the app in the Skin
  Workshop, or Edit Colours in Quick Play (Ctrl/Cmd+K), opens a panel that stays
  over every view, the fullscreen visualizer included. Drag its title bar, press
  Esc to close it, and it remembers where you left it. It steps aside in deck
  mode and returns afterwards.
- Every colour row has a picker and a value field, and an opacity slider
  except for solid surfaces such as Background and Panels. Tint everything
  shifts hue, saturation and brightness for the whole skin at once, and keeps
  the warning and error hues. A Contrast list checks text pairs against 4.5:1
  and the accent on panels against 3:1, measured on what is on screen, and says
  in words when a pair is low.
- Text on accent is a new Skin Workshop colour: the label on pressed buttons
  and other accent fills. It is independent of Background. A skin that doesn't
  set it, such as an older saved or imported one, gets black or white,
  whichever reads better on its accent. Exported skins include it, and older
  versions ignore the unknown key.
- A skin you import, drop on the window or save over no longer replaces your
  custom skin without a trace. The replaced skin goes under Previous skins in
  the Skin Workshop (the last 8, kept on this computer), with an Undo on the
  toast. Unsaved edits are kept there too if the skin changes under them.
- Sidebar groups collapse and expand, and the choice is remembered. Right-click
  the sidebar, or press Customise at the bottom, to show, hide and reorder the
  items in a group. Settings always stays, and the view you are on shows even
  if it is hidden or its group is collapsed. Reset restores the default.
  Streaming starts collapsed and opens by default once the library has a music
  server or podcast feed, or once you open Radio. Radio sits inside it, and
  Quick Play still reaches it.

#### macOS

- The NewAmp menu has Settings, with Cmd+, as its shortcut. It also brings the
  window back if it was closed to the Dock.
- The Dock menu has Previous, Play or Pause, Next and Stop. The Help menu links
  to the GitHub page and the issue tracker.
- Cmd+Left/Right is previous and next, and Cmd+Up/Down is volume. The deck
  snapshot is Cmd+Shift+S. Tooltips and hints show the Cmd forms. Ctrl+Left and
  Ctrl+Right still work.
- The visualizer's fullscreen no longer creates a new Space, and the display
  stays awake while the visualizer is up and music plays.

#### Windows

- The portable build keeps its data in a `NewAmp Data` folder next to the exe
  when no profile exists in the default location. If you have run a portable
  build before, it keeps using `%APPDATA%\NewAmp`, and so does a portable exe
  in a read-only folder. About shows a Data folder row with the path.
- Opening several files from Explorer within about 400 ms queues all of them.
  Each used to replace the queue.
- Listing output devices no longer starts a separate Video Capture process, a
  camera helper NewAmp never uses, so there is one process fewer in memory.

#### All platforms

- The window opens where you left it. Position, size and maximized state are
  remembered, the deck's position separately, and a window whose display is
  gone reopens on screen.
- If the interface process crashes, NewAmp reloads the window from the saved
  session, up to twice a minute, then asks.

### Changed

#### Playback and formats

- Shuffle with Repeat off now ends after every track has played once. Repeat
  all starts a new shuffle cycle that doesn't open with the track that just
  played. Auto DJ refills in shuffle too. Queue edits no longer reset the
  shuffle history.
- Shuffle and repeat are remembered, even with an empty queue.
- NewAmp opens on the last view you were on. Settings and About are left out,
  and a first run, a start with no library and the first-launch tour open on
  Home.
- The sleep timer pauses instead of stopping, so a podcast keeps its place.
- Previous counts as a play and wraps with Repeat all. Replaying a track at
  the same spot re-arms crossfade and gapless. Removing or deleting the last
  track while it plays stops playback instead of restarting the one before it,
  and records no skip.
- Playback stops with a toast after 8 failed tracks in a row (or the queue
  length, if smaller), and Next skips tracks the library knows are missing.
- Wrapped Live export no longer replaces the queue, counts a play or scrobbles.
  The queue comes back paused afterwards.
- The transport title shows a heart for loved tracks only, in place of a star
  before every title.
- The main window appears as soon as it is ready, after a 0.6 s minimum splash,
  instead of after a fixed 5.6 s.

#### Library and search

- The Library opens on the track list. The stats and health report is a
  one-row Library health summary (grade, profile, counts, missing tags,
  duplicate groups) that expands on click and remembers whether it was open.
  Opened, it starts with an explainer card you can dismiss, and Compass Moves
  that carry a search query filter the list when clicked.
- Playlist, Mix and Tag columns are hidden on a fresh install, and default
  widths fit a 1280 px window. Turn them on from Columns. The DJ OK / NO DJ
  toggle and the TAG metadata-rescue button live in the Mix and Tag columns,
  so they stay out of sight until those columns are shown. Saved layouts are
  kept, and saved widths that still sat at the old defaults follow the new
  narrower ones.
- The Library search isn't focused on arrival, so Space, `L`, `0` to `5` and
  the arrow keys control the player right away. Track rows are a single Tab
  stop: arrows walk the rows, Enter plays, `Q` and Shift+`Q` queue, and Tab
  steps through the row's buttons. Column resize handles take Left and Right.
- Scrolling over a score bar changes only the score, and Shift+wheel moves it
  by whole points, on macOS too.
- Trashing tracks, and Clean missing files, remove just those rows. The list
  keeps its scroll position and loaded pages, and the queue, Now Playing and
  playlist views update at once. Clean missing files no longer cancels a scan
  in progress. A removed track that was on one of your Lists (in Profile)
  stays there as a plain text entry titled after the track.
- The safety copy taken before Move to Recycle Bin or Clean missing files now
  holds only `library.db` and `settings.json`. It used to copy the whole
  album-art folder every time, which filled drives. These copies are named
  `newamp-auto-backup-<time>` and the newest five are kept. Backups you make
  from Settings still copy everything and are never deleted automatically.
  Both restore from Settings.
- Editing a track's tags (MusicBrainz match, manual edit, bulk edit, ReplayGain
  analysis, reset of adopted edits) updates the queue, the transport and the
  scrobble payload without re-queuing.

#### Volume and keyboard

- The wheel over any volume control (the transport slider, the Retro TV knob,
  the visualizer's volume meter) stops at exactly 100%. Keep scrolling after a
  short pause, or hold Shift, to boost past it. Up and Down (Cmd+Up and
  Cmd+Down on a Mac) step 5% and stop at 100% the same way, and Shift+Up goes
  straight through.
- A slow single wheel click always moves the volume at least 2%. A trackpad
  pinch or a sideways drift no longer changes it, and the distance one flick
  can travel is capped so momentum can't run away. The volume track isn't
  tinted red until you boost past 100%.
- In the fullscreen visualizer, Lite is Shift+L and Auto-VJ is Shift+V, so `L`
  loves the track and `V` stops playback as they do everywhere else. The
  visualizer never takes a key held with Ctrl, Cmd or Alt, so Ctrl+Left and
  Ctrl+Right skip tracks there too.

#### Visualizer and Eviland

- The album cover overlay in the visualizer is off until you turn it on, from
  Settings or with `A`.
- Look palettes are rebuilt in OKLCh, so an Eviland seed code gives the same
  scene in new colours. The light colour is always lighter than the accent,
  and there are no olive or brown shadows. Half of the looks follow the
  cover's hue in look mode, and the album-art shadow is the cover's hue, dark.
- The liquid effect, the soft flowing blobs of colour, appears only in the
  liquid, nebula, inkwell, tidal, glasshouse, stormfront and emberveil looks.
  Several looks now draw their waveform, the lissajous waveform is no longer
  picked, and every look has some audio drive, so a seed code can differ in
  more than colour. Scenes composite with partial occlusion, so trails carry
  on through strokes.
- The 4K render option allows up to 2x the display's pixel ratio and about
  8.3 megapixels, up from 1.25x and 4.2 megapixels. The performance governors
  still trim it on slower machines.
- MilkDrop's reactivity sets the waveform gain with a hard limit instead of a
  soft clip, and the control reads Signal gain on plain MilkDrop.
- The spectrum meters on the transport, the decks and Now Playing, and the
  reading Auto-VJ uses, are log-spaced from 30 Hz to 16 kHz and follow the
  sample rate. The low bands no longer read the DC bin as bass.

#### Decks

- On the Record Player, SPEED and PITCH are printed panel text rather than
  controls. The Discman's thumbwheel is a printed speaker mark, and its slider
  is the volume.

#### Skins and colours

- Edits in the Skin Workshop belong to the Workshop now, not the Settings page.
  They stay when you leave Settings, are marked Unsaved changes, and end with
  Save skin or Reset. Closing the floating editor with unsaved edits asks
  whether to save, discard, keep the preview or keep editing.
- Buttons and medium chips are 24 px tall, 22 px in table rows and on the
  hardware decks. Button labels no longer wrap.
- Calls to action use the primary button style, and the lit style is kept for
  toggles and selections.

#### macOS

- Closing the window hides it and playback continues. Click the Dock icon to
  bring it back, and Cmd+Q quits. Settings > Shell words the choice as Keep
  playing in the Dock or Quit NewAmp.
- The decks use the window's own traffic lights in place of their minimize and
  close buttons. PIN and FULL stay.

#### Windows

- Without a tray icon, the close button minimizes to the taskbar instead of
  quitting, and closing the minimized window quits. With a tray icon the
  choices read Minimize to tray and Close the app.

### Fixed

#### Playback and formats

- Apple Lossless in .m4a, .m4b and .mp4 files now plays, including with
  crossfade, playback speed, an A-B loop, CUE sheets and gapless off. NewAmp
  reads the file's codec and decodes ALAC with the bundled ffmpeg instead of
  the browser decoder. AAC, FLAC and Opus inside MP4 stay native. No rescan is
  needed for playback.
- Apple Lossless is badged ALAC, and counted as lossless in Library health and
  in `quality:lossless`, where it used to be called AAC. The codec is read at
  scan time. Existing .m4a, .m4b, .mp4 and .mka rows are read once more on the
  next scan, and show a neutral M4A chip until then.
- Quick Play items and navigation links (SHOW toasts, artist and album links)
  leave deck mode and the fullscreen visualizer, so the view is visible. Quick
  Play opens over the fullscreen visualizer instead of invisibly behind it.
- An OS play command no longer pauses a track that is already playing.
- The seek bar thumb keeps following playback after a click.
- The transport's title box had a fixed height, so the codec line sank into its
  bottom edge at any Text size above the smallest. It grows with the text now.

#### Library and search

- Copying a lot of files into a watched folder no longer re-reads the whole
  library, and new files appear at least every 30 seconds during a long copy
  instead of after it finishes. The first scan of a large library no longer
  re-reads the whole tracks table for every batch that has a new file.
- Tag counts included tracks that no longer exist. Those leftovers are dropped
  on open. A skip recorded for a track that was removed is ignored.
- In a short window, the Library's search bar and track table could fall off
  the bottom with no way to reach them. The view scrolls now, and the table
  keeps a usable height.
- The ? next to Discover, Mixes and Living Tags did nothing while their intro
  card was showing. It hides the card now, and brings it back on the next
  click.

#### Volume and keyboard

- Scrolling over a volume control no longer loses distance when the app is
  busy. On macOS, Shift+wheel arrives on the horizontal axis and now counts. If
  the wheel still misbehaves, Settings > Support Diagnostics > Copy input log
  shows what the wheel sent.
- Shortcuts keep working after you touch a slider or the seek bar: Space,
  Ctrl or Cmd with the arrows, `L`, `F` and `0` to `5`. Plain arrows stay with
  a focused slider. Space after clicking a toolbar button plays or pauses
  instead of pressing that button again.
- In the fullscreen visualizer, `V`, `L` and `F` each ran a visualizer action
  and the app's own action for the same key (stop, love, and closing the
  visualizer). Each key does one thing now. Holding an arrow key through
  visualizer modes no longer jumps back when the saves return, and a
  double-click on a control no longer flips fullscreen. A double-click on the
  hover volume meter sets 100%.
- Leaving the visualizer keeps the app in fullscreen if it was already. Esc
  with a popover open closes the popover first, and popovers take keyboard
  focus and give it back.
- Scrolling over the Retro TV volume knob or the visualizer's volume meter no
  longer scrolls the page behind it.

#### Visualizer and Eviland

- After the GPU takes its graphics context and gives it back, the visualizer
  recovers instead of freezing.
- The visualizer keeps its trails when you resize the window, and a bad value
  in the audio analysis no longer leaves it black. Banding in dark trails is
  reduced.
- Colour in the fluid looks drains away instead of building up, hot spots go
  white at the centre, and the bloom no longer veils the whole frame.
- Eviland's Bars waveform is drawn at a limited strength. A loud passage, a
  long trail, or picking Bars under Waveform layer on a look with heavy
  feedback could wash the whole picture out to white.
- Eye of the Storm, Hex Pulse, Pixel Bloom, Smoke & Ink and Fire Spires no
  longer jump after they have been running for a while. Phosphor Scope, City
  Pulse and Deep Jelly follow the palette, and Tunnel Rings and Glitch Bars
  re-roll on counted kicks instead of a timer. Shader modes and Confetti no
  longer jitter the longer the app has been open.
- MilkDrop's bass, mid and treble bands were an octave low, because every
  second sample was fed at the full rate. The feed is contiguous now, so
  presets react to the right frequencies. In plain MilkDrop mode, presets
  compile off the paint path.
- The 45 fps option holds 45 fps on a 60 Hz display instead of dropping to 30.
- The projector's Eviland reactor resets on a track change, and both windows
  follow the output device's sample rate when Bit-Perfect output changes it.

#### Skins and colours

- Pressed buttons keep a readable label whatever the Background colour is, in
  Modern, Liquid Glass and Concourse.
- On the light skins (Steel, Terminal, Ice and Miami), warning and error text,
  title bar text and the transport's codec and duration line are readable.
  Accent-coloured text in the Library, Now Playing and the deck skin chips uses
  a darker shade there. Classic's secondary text is brighter, disabled buttons
  look disabled, and the Library search hint no longer glows like an active
  filter.

### Accessibility

- Deck transport and window buttons have accessible names, and the Retro TV
  screen button announces the current track.
- The volume slider and the Retro TV knob announce a value such as
  `120% · +1.6 dB` in place of renaming themselves at every step. The score
  input is named Score out of 100, and the Now Playing stars are labelled.
- Library row play buttons are named after the track. PIN, Light Viz, Missing
  art and the Library sort chips report whether they are on.

### For contributors

- The default session denies web permissions apart from audio checks, output
  device selection, fullscreen and clipboard writes from the app's own origin.
  A feature that needs another (MIDI, notifications) has to add it in
  `electron/permissions.ts`.
- The Retro TV volume knob releases its drag listeners if the deck closes
  mid-drag.

## [2.5.1] - 2026-10-08

### Fixed

- The Pin button in deck mode now works. A deck floats over other windows
  only while it's pinned, which is what the button showed all along.
- Scrolling the wheel over the volume slider in the fullscreen visualizer
  moved the volume a fixed step per event, so a trackpad or Magic Mouse
  flick, which sends dozens of events, could jump it by half the range. It
  now follows how far the wheel moved. The main volume slider answers the
  wheel too.
- The projector window's mouse pointer never came back once it had hidden.
  It shows on any movement and hides again after two seconds of rest.
- Skin Workshop: a colour written as rgba() or hsl() had no colour picker.
  Every colour has one now and keeps its transparency, each setting says
  what it changes, and a value the skin can't accept is marked instead of
  being ignored.
- Text size now applies to text in the app's standard sizes as well, not
  only the sidebar and transport. Panels with fixed sizes still don't follow
  it.

## [2.5.0] - 2026-10-08

### Added

- Eviland looks can now move in eight new ways, not only zoom, spin and fold.
  Cells: the picture divides into cells that each bloom out of their own
  nucleus, and the seams between them read as membranes. Coral: patterns
  like labyrinths, spots and brain folds grow out of whatever is lit. Marble:
  bands of the picture shear past each other and get combed into streaks.
  Chroma: each colour drifts in its own direction. Droste: a smaller, turned
  copy of the frame keeps feeding back into itself. Mobius: the picture
  streams out of one moving pole into another. Tendril: the picture gets
  dragged outward into curling arms. Peristalsis: squeeze-and-release waves
  pump outward on the kick. Most existing looks now carry one of these.
- Eleven new looks built around living things: Mycelium, Mitosis, Synapse,
  Radiolarian, Reef, Hyperbloom, Medusa, Chromatin, Anemone, Plankton and
  Myofibril. They draw on ten new scenes (a dividing cell colony, firing
  neurons, radiolarian skeletons, a cilia carpet, a capillary tree,
  jellyfish, twisting DNA strands, a feather-star crown, swimming plankton,
  contracting muscle fibres) and on a new slime-mould simulation. The mould
  senses the picture it grows into, so its veins crawl along whatever the
  rest of the look draws. Eviland Live grows it into MilkDrop's feedback too.
- A "Per look" palette, now the default if you never picked one. Each Eviland
  look keeps the colours it was generated with instead of every look using
  your skin's accent, and the colours blend across a look change. The other
  visualizers treat it as Theme.
- Gapless playback of local files. NewAmp decodes the queue itself, trims
  each file's encoder delay and padding, and plays the result as one
  continuous stream. At a 48 kHz output the old player left 923 samples
  (about 19 ms) of silence between FLAC or MP3 tracks and 1,947 (about
  41 ms) between AAC tracks. The new path leaves none for FLAC, MP3, AAC,
  ALAC, Opus, Vorbis, WAV, AIFF and WavPack, and repeat-one loops without a
  gap too. An MP3 whose own gapless header is wrong still plays what the
  header says. `npm run smoke:gapless-pcm` measures both paths. It's on by
  default under Settings > Playback > Gapless. Crossfade, speeds other than
  1x, A-B loops, CUE sheets, DSD, podcasts, radio and server tracks still
  use the old player.
- Flash protection for the visualizers. A last stage on every output
  (Eviland, Eviland Live, MilkDrop, the shader looks, the projector window,
  recordings) keeps any patch of the picture covering 1% of the screen or
  more from flashing more than three times a second, the WCAG limit for
  photosensitive viewers. That includes flicker where neighbouring pixels
  flash out of step, like stripes or a reversing checkerboard. Calm visuals
  pass through essentially unchanged. A strobing passage is held down
  rather than blacked out, so dense, bright-on-black looks run noticeably
  darker with it on, some at about half their usual brightness. On an RTX
  4080 it costs about half a millisecond a frame at 4K. It's on by
  default, and turning it off asks you to confirm.
  `npm run smoke:flash-guard-render` counts the flashes with it off and on.
- Your tag edits are now stored apart from the file's own tags, so a rescan
  no longer puts back the old title or genre. Edited fields are marked in
  the metadata panel, and each one can be reset to what the file says.
- ChatGPT Assist can use another OpenAI-compatible endpoint. Set
  `NEWAMP_OPENAI_BASE_URL`, `NEWAMP_OPENAI_API_KEY` and optionally
  `NEWAMP_OPENAI_MODEL` before starting NewAmp; Settings shows when one is in
  use.

### Changed

- Look changes in Eviland no longer dissolve a frozen still into the new
  look. The old and new looks both keep moving while a front crosses the
  screen between them. The front can take several shapes: cells converting
  one by one, a mould-like front fingering outward, an iris opening, a
  plasma edge, spiral arms, or the old picture's brightest parts going
  first. It glows as it moves and pushes the old picture aside. Changes take
  about four beats, up from two.
- Eviland Live's colour grade reads each MilkDrop preset's hues as well as
  its brightness, so a preset's differently coloured parts stay different
  colours of your palette. MilkDrop's own blend between presets in Live now
  runs 4.5 s, up from 2 s. The new motion kinds also bend Live's MilkDrop
  feedback, at a lower strength so the preset stays recognisable.
- Visual memory from earlier versions keeps its section fingerprints, but
  its looks are regenerated, since the look generator changed. For the same
  reason, a look code shared from an earlier version now opens a different
  look.
- A file that disappears from your library folders is marked missing
  instead of deleted. It keeps its plays, rating, history and playlist
  places, shows dimmed with the date it went missing, and comes back as the
  same track when the file or drive returns. Auto DJ, mixes, smart playlists
  and Discover skip missing tracks.
- "Clean missing files" now shows how many tracks, plays and playlist
  entries it would remove, and makes a backup before removing anything. It
  never removes tracks from a drive or share that is offline.
- Older versions stored your edits in the same place as the file's tags. On
  the first scan after upgrading, a field that differs from an unchanged
  file is kept as your edit; a file that changed since the last scan (a
  retag in another program, say) takes the file's tags. Library health can
  reset all of these carried-over edits at once.
- The signal path badge and Settings name the resampler that actually ran,
  SoX or FFmpeg's own, instead of always saying SoX.
- Two-step buttons like Clear queue, Delete playlist and Restore backup
  no longer arm and confirm in one double-click or a held Enter. The
  confirming press has to be a separate one.
- Building from source needs Node 22.12 or newer, which is what Electron 42
  requires.

### Fixed

- A library from NewAmp 1.0 opened empty after upgrading. The upgrade built
  an index before adding the column it indexes. Columns now come first, and
  a library that fails to upgrade is left as it was instead of being set
  aside.
- If the settings file was briefly locked at startup (by antivirus or a sync
  client, for example), NewAmp treated it as corrupt and saved default
  settings over it. It now retries. If the file stays unreadable, NewAmp
  runs on defaults for that session, never writes over the file, and tells
  you.
- A podcast save that failed partway, on a full disk for example, could
  leave the podcast list empty. Podcast changes are now written in one step
  and only take effect once saved.
- The drop highlight could stay on screen after a drop, Escape or switching
  windows, and a drop on the Library imported the files twice. Dropping
  files on a playlist row no longer reorders the playlist.
- On macOS and Linux, local files didn't play when NewAmp was started from a
  terminal anywhere but `/`. A `?` in a file name broke playback on every
  platform.
- Bit-Perfect Exclusive stopped with "Decode failed" on any track that
  needed a sample-rate change, and DSD files played silence the first time.
  The bundled FFmpeg has no SoX resampler; NewAmp now checks, and uses
  FFmpeg's own when SoX isn't there.
- A request for a file on a network share made Windows connect to that
  share before NewAmp refused it. Paths are now checked before anything
  touches the disk or network.
- In Bit-Perfect Exclusive, seeking in the last couple of seconds of a song
  could play the next song while the display still showed the old one. A
  device that listed some rates only for mono or multichannel use could be
  opened at one of them in stereo and wrongly shown as bit-perfect. A slow
  source could be reported as a lost device before its first sound.
- During a crossfade the outgoing song switched to the incoming song's
  ReplayGain before it finished. Each song now keeps its own. A next track
  that took a while to start could also jump into a fade that had already
  run; the fade now starts when the track does.
- A backup restore that failed partway could leave some settings changed
  and the library watcher stopped until restart. Restore now checks every
  file first, rolls back completely if anything fails, and always restarts
  scanning.
- On Linux, when two files' names differed only in case, the folder watcher
  and some lookups mixed them up, so a change to one could leave the other
  out of date. Case now only folds on Windows and macOS, where the file
  system does the same. CUE sheets still match file names without regard
  to case.
- A CUE sheet that spans several files played them in alphabetical order
  instead of the order the sheet lists them.
- Turning Eviland's Director off partway through a look change left the
  half-finished blend frozen on screen.
- If the video encoder failed during a visualizer recording, pressing stop
  did nothing: no file and no message. It now says the recording failed.
- Opening a deck after one had already been open that session, from
  Discover's Visual Set for example, could leave the window stuck at a
  720x152 strip with most of the deck cut off and no way to resize it.
- Clicking quickly between artists or albums could leave the previous
  one's tracks on screen. Changing the Radio Brain token now also
  disconnects clients that were already connected with the old one.
- In Quick Play and the first-launch tour, Tab could move focus to the
  controls behind the dialog. Focus now stays in the dialog and goes back
  where it was when it closes.
- The Intel and Apple Silicon Mac downloads each get the exclusive-output
  addon built for their own processor. Before, one of the two could ship
  with an addon it couldn't load.

## [2.4.0] - 2026-09-19

### Added

- Eviland look-ahead. NewAmp plays local files, so it can read a whole track
  before you hear it: the beat grid and bar lines, where the sections are and
  which ones repeat, how intense each section is compared with the rest of
  that song, the builds and the beat of silence before a drop, and key
  changes. Eviland and Eviland Live now change looks on the bar line, with the
  look chosen for the section that is starting rather than the one that just
  ended. A repeated chorus gets its look back. Through a build the picture
  draws inward and dims, it goes dark for the held beat, and the drop lands on
  its downbeat. When the song modulates, the palette shifts with it.
  A track is analysed the first time it plays with an Eviland visualizer
  open, then cached beside the library.
  Streams, podcasts, server tracks and anything under 20 s run on live
  analysis as before. Turn it off under Visualizer settings, Look-ahead.
- Two new Eviland sources: a reaction–diffusion simulation that grows out of
  whatever is bright in the picture, and a raymarched volume scene.
- The queue in Now Playing can be edited in place. Drag a row to reorder it,
  or use the move and remove buttons that appear on hover; from the keyboard,
  Alt+Up/Down moves the focused row and Delete removes it. Clear empties the
  queue (with the usual undo). Editing around the playing track does not
  interrupt it.
- Right-click any track, in the Library, album, artist, folder, Loved,
  queue and playlist lists, for Play Next, Add to Queue, Add to Playlist and
  Show in Folder. Add to Playlist lists every playlist and starts with New
  Playlist. On a row that is part of a multi-selection, the menu acts on the
  whole selection.
- Folder playlists. In Folders, Smart playlist saves the open folder as a
  smart playlist: every track under it, subfolders included, in folder order,
  kept up to date as files are added or removed. Show in Library filters the
  Library to that folder, and the folder list has a filter box.
- `npm run bench:cpu` measures the app's CPU use per process with a large
  synthetic library (27,000 tracks by default), with or without the GPU.
- Save as New in the smart rule panel. With a rule selected, Save Smart reads
  Update Smart and overwrites that rule; Save as New keeps the settings as a
  separate rule and leaves the original alone.

### Changed

- Eviland Live is one image now. Scenes, the fluid and the per-band events are
  drawn into MilkDrop's feedback texture instead of sitting on top of it as
  separate canvases, so the preset warps and trails them like its own shapes,
  and one palette grades the result.
- Each Eviland look picks its own sources. All 26 used to draw the same bass
  ridge, spectrum sun and emitters and differ only in how the feedback
  distorted them; now a look selects a scene from the scene library and
  decides whether the ridge, sun and emitters appear at all.
- The palette and reactivity controls apply to both Eviland modes and to the
  detached projector. Waveform has an Auto setting that follows the look, and
  Off now turns the waveform off.
- Director, seed and waveform controls show for Eviland Live as well as
  Eviland (engine).
- Eviland meters its own exposure, so sparse looks are no longer nearly black
  and dense ones no longer wash out. Highlights keep their hue instead of
  clipping to white.
- Fire Spires and VU Cathedral take their colours from the active palette.
- Playing music costs far less CPU. With a 27,000-track library, playing a
  track on the Library view used about 1.3 CPU cores, or 1.5 when Chromium
  composites in software (common on Linux when it blocklists the GPU driver).
  It now uses about a quarter of one core either way, and an idle window
  dropped from 12% of a core (38% in software) to under 3%. Measured with
  `npm run bench:cpu` (27,000 tracks; percent of one core, summed over every
  process) on Windows 11 with a 165 Hz display, the software figures taken
  with `--disable-gpu` rather than on a Linux machine, and the before figures
  from the same script run against 2.3.0. Most of the cost was the interface
  reacting to the music: the variables it animates were written for the
  whole page 165 times a second on a 165 Hz display, several loops woke on
  every display refresh only to skip the frame, and a few animations never
  stopped. Everything that moves with the music now shares one 30 Hz clock
  and touches only the elements it animates. Some of the reactive chrome is
  quieter for it: the play button pulses its icon instead of glowing, and the
  full-window wash is dimmer and no longer screen-blended.
- The title-bar equalizer is four real band meters instead of a looping
  animation.
- When Chromium composites in software, the interface stops reacting to the
  music and stays still, the way it already did on low-end hardware.
- Artists load as one list and draw only the rows on screen, so the A to Z
  rail reaches every letter (the list stops at 100,000 artists, and says so).
  Before, the view loaded 320 artists at a time and
  letters past the first few were greyed out until you clicked "Load more"
  enough times.
- Editing an open playlist (moving or removing tracks) saves immediately, and
  the playlist header shows its total running time.
- Eviland Live preset switches are cheaper: a switch that took 8 ms at the
  median and 17 ms at worst now takes 2.5 ms and 8 ms. Butterchurn built
  several million-element arrays element by element on every switch, used or
  not. `npm run bench:eviland-switch` measures it; the before figure predates
  the change, which is applied when the app is built.

### Fixed

- Bloom, emitter size and emitter intensity were generated for every look but
  never reached the renderer.
- Bright fluid dye disappeared wherever the feedback field behind it was dark.
- Several scenes jumped when the music's energy changed, more the longer a
  track had been playing.
- Trail length and motion speed changed with frame rate, so a look moved
  differently on the low-quality tier or when the frame governor stepped in.
- The detached projector ignored the palette and reactivity settings.
- Turning the equalizer off and back on did nothing until the next restart;
  the bands were saved but never re-applied. Picking a preset while the
  equalizer was off had the same problem.
- New Playlist created nothing. It cleared the form and put "NewAmp Set" back
  in the name field. It now creates the playlist under the name you typed and
  opens it.
- "Add to playlist" pickers never showed playlists created after the view
  was opened.
- Moving or removing tracks in an open playlist was lost unless you pressed
  Update Playlist before leaving the view.
- Eviland and Eviland Live stuttered when they changed look. Each look's
  shader compiled on the frame it first appeared, and on a fresh shader cache
  that frame took 42.5 ms at the median and 337.9 ms at worst. Scenes now
  compile in the background and the crossfade waits for them, which brings the
  worst frame after a switch to 0.3 ms at the median and 0.8 ms.
  `npm run bench:eviland-switch` measures it; adding `-- --sync-compile`
  reproduces the old behaviour on the same build.
- The library watcher was restarted on every settings save, including the
  playback position saved every few seconds. Changes it had noticed but not
  yet scanned were thrown away, so new or edited files were never picked up
  while music played. On Linux, each restart also re-read the whole library
  tree. On Linux the watcher now holds one watch per folder instead of one per
  file.
- A folder whose name carried a capital outside A-Z matched nothing. A folder
  playlist for "Ólafur Arnalds" came out empty, Show in Library found nothing
  there, and `path:` and ordinary searches missed those names. SQLite folds
  only A-Z, and the search text was being folded further than that before the
  two were compared.
- On Linux, two folders whose names differ only in case are two folders. They
  were being treated as one: merged in the Folders view, and a folder playlist
  for one pulled in the other's tracks. Windows and macOS keep treating them
  as the same folder, which is what those filesystems do.
- A folder created inside a watched folder on Linux was picked up through a
  symlink the first scan would have skipped.
- Watching folders on Linux reported almost nothing when it went wrong. One
  folder that could not be watched stopped the walk from going any deeper, so
  an arbitrary part of the library quietly stopped being watched, and only
  failures on a library root were logged at all, which under one watch per
  folder is a handful out of thousands. Every distinct failure is now logged
  once, running out of system watches says so by name, and a folder that
  cannot be watched no longer hides the folders inside it.
- With no music folders configured, the Folders view was empty on Linux and
  macOS even with a full library, because the root it worked out from the
  track paths dropped their leading slash.
- Auto DJ on a folder rule carried every track under that folder across to the
  interface each time it topped the queue up, to keep a handful. It now asks
  for a handful, picked at random from anywhere in the folder rather than
  taken in folder order, and falls back to the whole folder if everything it
  drew has been played already.
- Choosing a smart rule meant editing that rule with no way out: Save Smart
  overwrote it, and a rule made from a folder stayed tied to that folder.
  Save as New keeps the settings and leaves the original alone.
- Long entries in the Library health panel ran underneath the next column.
- `path:` searches ignored a typed Windows path in quotes (the backslashes
  were treated as escapes), and a forward-slash path never matched a
  backslash one or the other way round.
- Folder paths showed backslashes on Linux and macOS.
- A GPU process that exited normally, or during quit, counted as a crash and
  made the next launch start with software rendering.

## [2.3.0] - 2026-09-05

### Added

- Connect to Navidrome/Subsonic and Jellyfin music servers, browse and search
  their libraries, and play server tracks through NewAmp's queue and visualizers.
  Remembered connections restore their queued tracks after restarting.
- Import listening history from Last.fm, CSV or JSON, with a preview before
  applying changes and duplicate detection when repeating an import.
- **Undo clear queue**: restore a cleared queue and its playback position from
  the notification, paused. The action is available for ten seconds, with expiry
  paused while hovering or using keyboard focus.

### Fixed

- Explicit Quit saves pending library changes and playback settings, including
  a settings save already in flight.
- Exclusive gapless playback keeps its active decoder after a track transition;
  a previous track's idle timer can no longer close a newly playing stream.
- Native PCM output retains incomplete frames across decoder chunks and ring
  underruns, preserving sample/channel alignment and position accounting.
- Stop, queue replacement and queue clearing cancel pending playback requests
  and release the previous source.
- CUE/start offsets survive metadata loading, and seeking a restored paused
  track updates the position used when playback starts.
- Editing an idle queue keeps it idle; repeated songs retain their queue slots.
- Large-library benchmark cleanup finishes reporting before removing its files.
- Release packaging rebuilds the native addon from the current source instead
  of trusting checkout timestamps on a tracked binary.

- Uninstalling on Windows now clears the file-type entries the installer
  wrote. Before, `.mp3`, `.flac`, `.m3u` and the other registered extensions
  were left pointing at a NewAmp file class that no longer existed, so Windows
  treated them as unknown types until another player claimed them.
- The release manifest no longer records the build machine's absolute paths.

## [2.2.1] - 2026-09-02

Follow-ups to 2.2.0 found by a review of the shipped build, plus two limits
real feeds and real rules ran into.

### Fixed

- Tag rules can call `matches(field, "pattern")` and `contains(field, "text")`
  as functions, the way the Tags view lists them. The parser only knew the
  infix forms and rejected the call with "unexpected token".
- Podcast feeds up to 32 MB can be subscribed to. The previous 5 MB ceiling
  refused the feeds of some long-running shows on the larger networks; one
  Simplecast feed measured 20 MB.
- Podcast feeds served compressed are decoded again. The 2.2.0 HTTP path
  stopped asking for compression and did not undo it when a host sent it
  anyway, which would have handed compressed bytes to the feed parser. The size
  cap now counts decoded bytes, so a small compressed body cannot inflate past
  it.
- If replacing `library.db` or `settings.json` fails outright, the complete
  copy stays on disk next to the target and the error names it. The 2.2.0 code
  deleted its temp file even when the replace had failed, which could turn a
  failed save into a lost one. The synchronous retry backoff is also shorter,
  so a locked file cannot freeze the app for most of a second on an ordinary
  settings change.
- Restoring a backup now pauses the library watcher's pending rescan the same
  way creating one does, so a folder change noticed just before the restore
  cannot prune tracks from the restored library.
- Winamp skin archives written by streaming zip tools (entries flagged with a
  data descriptor) import again; 2.2.0 refused them without needing to.
- Custom skins saved under 2.1.0 that used space-separated `rgb()` or `hsl()`
  colours, or a bare `0` radius, lost those values silently on the next
  settings change under 2.2.0. The grammar accepts them now, and any value it
  still refuses is named in the main-process log instead of vanishing quietly.
- A tag rule whose pattern the 2.2.0 matcher refuses was skipped with only a
  truncated note in the Tags sidebar, while every tag it had assigned
  disappeared. The Tags view now shows a banner naming the rules that are not
  running, Recompute-all reports them, and the app posts a notice at startup.
- The tag-rule matcher now folds case for accented letters (`café` matches
  `CAFÉ`), `.` no longer matches the Unicode line and paragraph separators, and
  a pattern that repeats a group name is refused, all matching what the regular
  expression engine did before 2.2.0.

## [2.2.0] - 2026-09-02

A correctness release. Nothing here is a new feature; it is the app doing what
it already claimed to do, with a regression test behind each fix.

### Your data

- A corrupted library database stopped NewAmp from starting at all. Opening the
  database only checked that the file loaded and its schema applied, and
  page-level corruption passes both of those — the header and schema stay
  intact, and the damage only shows up on the first real read. That read
  happened during startup, before the window was shown, so the app exited with
  no window and no error. Reinstalling didn't help, because the database lives
  in your user data folder and an uninstall leaves it there. NewAmp now runs an
  integrity check when it opens the database, sets a corrupt one aside with a
  `.corrupt-` suffix instead of failing, and rebuilds the library from a rescan.
- The library and settings files are written through a temp file, synced to
  disk, and renamed into place. A crash or power cut in the middle of a save can
  no longer leave you with a truncated `library.db` or a `settings.json` that
  has forgotten your music folders and Last.fm login. The quit-time save and
  the background save also use different temp files now; before, quitting during
  a background save could let one writer's bytes land inside the other's file.
- A library file that is merely locked (antivirus, a sync client, a network
  share) is retried instead of being mistaken for a corrupt one and quarantined.
  If it stays locked through every retry, a packaged build used to exit with
  nothing on screen; it now shows a dialog saying why and records the failure
  in the diagnostics log.
- When the rename that swaps a fresh file into place kept failing under a
  Windows lock, the fallback was a plain in-place write with no sync to disk,
  the exact hazard the atomic path exists to remove. It now retries for about
  a second, tries once more through a fresh temp file, and only then writes in
  place, synced.
- Support backups copied `library.db` and `settings.json` off disk, but the
  library batches play counts for up to thirty seconds and the resume position
  is debounced, so a backup taken right after listening could be missing the
  last half minute. Backups now pause the watcher and scanner and snapshot both
  stores from memory. Restore stops those first, takes its safety copy from the
  live stores, waits for any write still in flight, and only then replaces the
  files.
- Auto-watch no longer deletes a track, with its ratings and play history, the
  moment a file disappears. Editors that save by renaming and sync clients make
  files vanish for a fraction of a second; NewAmp now re-checks after 1.5 seconds
  and only prunes what is still gone.
- Eviland's per-track visual memory could lose a love, a skip, or a newly
  learned section if it arrived while a save was in flight. Saves now record
  what they covered and run again for anything that landed mid-write.
- Scrobbles made while your Last.fm session key is dead were being attempted,
  refused, and dropped with no sign of it. They are kept in the outbox now, so
  they survive and the app can tell you a reconnect is needed.
- Album art you applied by hand survives a rescan of a file that has no embedded
  art of its own.

### Playback

- Shuffle and repeat are two separate toggles again. They were stored as one
  value, so turning one on turned the other off, in the transport bar and in
  three deck skins. A shuffle-plus-repeat combination also survives a restart now.
- Shuffle gets the same crossfade and gapless handoff every other mode has. It
  was excluded because the next track is random; the pick is now made once,
  ahead of time, and the handoff plays exactly the track it prepared.
- Removing the track that is playing while paused, or removing the last track in
  the queue, left the audio engine holding it. Pressing Play resumed the removed
  track under the new track's title.
- Restoring your queue after a restart follows the track you were on by its id.
  If tracks before it had been deleted since, the old code landed you a few
  tracks off. A queue that was loaded without pressing Play also came back with
  its first track selected; it stays idle now, and the saved position is only
  applied when the track it was saved for is the one selected.
- Click one track and then another before the first has started, and both were
  counted as played and both were sent to Last.fm as now playing. The engine
  now tells the store when a request was overtaken, and play counts, Last.fm,
  podcast progress and Auto DJ only act on the request that actually started.
- Auto DJ no longer undoes a Clear Queue that happens while it is looking for
  candidates.
- Space no longer both starts a highlighted track and toggles playback.
- The volume you start the app at goes through the same loudness taper as every
  later change, so the first track is not louder than the rest.

### Library, search, and tags

- Searching for a literal `%` or `_` works.
- Camelot keys were scored as if they were on a different wheel, so a library
  tagged `8B` mixed badly with one tagged `C major`. The 24 Camelot codes now map
  to their real keys.
- Opening an album from Now Playing or a track link snapped back to the album
  grid about a fifth of a second later, because the navigation also changed the
  grid's search filter and the resulting reload cleared the selection.
- Tag rules that use `matches` now run on a matcher whose time is proportional
  to the text it is matching, whatever the pattern looks like. Before, patterns
  went to the regular expression engine behind a guard that rejected the shapes
  known to be catastrophic; `.*.*=` was not one of them, and it froze the whole
  app when the rules ran. The cost is a smaller grammar: backreferences,
  lookahead, lookbehind and lazy quantifiers are refused when a rule is saved,
  with the reason shown in the Tags view. Named groups, classes, alternation,
  anchors, word boundaries and repeats up to 64 all still work, and matching is
  still case-insensitive.
- A pair of tag rules that reference each other no longer wipes the whole tag
  table when rules are recomputed; the cyclic pair is reported and skipped.
  `tag()` references are matched case-insensitively.
- The Weird Shelf on the Discover page counted genres once per track. It now
  builds the shelf in 96 ms on a 12,000-track library; smart shuffle picks the
  next track in 13 ms on a 40,000-track queue. Both measured on the release
  machine with `npm run test:discover-weirdness-perf` and
  `npm run test:smart-shuffle-perf`.
- Picking a playlist cover and then taking more than ten minutes to finish the
  playlist failed the save. Approvals no longer expire on a clock.
- A Wikipedia outage was being cached as "this artist has no page" for a day.
  Only a real miss is cached now, and the lyrics and facts caches prune old
  entries instead of failing when browser storage fills up.

### Radio Brain

- Enabling, disabling, or changing the port of the LAN station server could
  leave two servers running, a listener stranded on the old port, or a shutdown
  that never finished because it waited for phone clients that hold their
  connection open on purpose. One reconciler owns the server now; stop ends the
  live connections itself and completes in well under a second.

### Security and privacy

- Podcast fetches classified IPv6 addresses by their text, so an IPv4-mapped
  address like `::ffff:169.254.169.254` slipped past the guard that keeps feeds
  from reaching your local network, and a plain hostname that resolved to a
  private address was never checked at all. All podcast traffic now goes
  through one HTTP path that validates the resolved addresses and connects only
  to those, re-checks every redirect hop (at most five), and gives up on a
  server that accepts a connection and never answers.
- Feed and episode bodies were read whole and only then compared against their
  size caps, so a server that omitted its Content-Length could push hundreds of
  megabytes into memory first. Bodies are cut off the moment they pass the cap;
  downloads stream to a temporary file and are renamed into place only when
  complete, and a failed download leaves nothing behind.
- A 169-byte Winamp skin file could freeze the app: its bitmap declared
  100000 by 100000 pixels and the colour sampler looped over the declared size
  before reading a byte. Bitmap dimensions are now checked against a ceiling
  and against the bytes actually present, every archive header field is checked
  to lie inside the file, and encrypted or otherwise unsupported archives are
  refused with a plain message. Archives are also decompressed under per-entry
  and total size caps, and a skin file over 20 MB is refused before it is read.
- Custom skin colour and radius values are checked against a grammar for what
  each slot can hold — hex, `rgb()`, `hsl()`, a named colour, or a bounded
  length. A skin file could previously carry `url(https://…)` in a colour slot
  and make an outbound request when applied. The check runs on import, when a
  skin is saved to settings, in the Skin Workshop's live preview, and again at
  the moment a value reaches the page.
- Electron moves from 42.0.1 to 42.11.1, which fixes a session-isolation bug in
  custom protocol handlers that NewAmp's own schemes were exposed to. No
  dependency changed its declared range, and the audit is clean.
- Saving a playlist cover only accepts a path that the cover picker itself just
  returned, so the renderer can no longer ask the main process to read an
  arbitrary file.

### Other

- The Windows installer is 115 MB, down from 136 MB for 2.1.0, and the unpacked
  app is 376 MB, down from 488 MB. The difference is duplicate library copies
  that were already bundled, 54 unused Chromium locale files, and a DirectX
  shader compiler that only WebGPU needs. Measured on the release machine
  against the published 2.1.0 installer.
- On macOS, closing the last window keeps NewAmp running, as Mac apps do,
  instead of tearing the library down.
- The release workflow now runs the typecheck and the headless smokes before it
  packages a tagged build. Previously a tag packaged, signed and published
  without running a single test. Several smokes that launched the app, printed a
  result and always exited 0 now assert what they print, and every unit test in
  the repository runs from one entry point in CI and in the release gate, so a
  test can no longer be added without anything running it.
- The standalone `@eviland/core` package had stopped building under its own
  stricter compiler settings and nothing noticed. It builds again, its public
  index matches what the engine exports, and CI checks both.

## [2.1.0] - 2026-07-16

A performance release. NewAmp got heavier the longer you left it running, and
this fixes the reasons why.

### Fixed

- **Screen recording no longer runs constantly.** The 15-second instant-replay
  buffer kept a second compositor and a video encoder running the whole time the
  fullscreen visualizer was open — even paused, even hidden. It now only runs
  while music is actually playing and visible.
- **Changing tracks no longer rewrites the whole library file.** Play and skip
  counts were forcing a full multi-megabyte database write on every track change.
  They're batched now and written in the background, with a final flush on quit
  so nothing is lost.
- **Long queues and playlists stay fast.** The queue, playlist, and history views
  built a DOM row for every single track — thousands of them after a long Auto DJ
  session. They now render only what's on screen, like the library view already did.
- **ffmpeg can't hang or get orphaned.** Analysis, ReplayGain, and export jobs now
  time out like transcoding already did, and any running jobs are cleaned up when
  you quit.
- **Auto DJ keeps filling the queue on long sessions.** It was counting already
  played tracks toward its lookahead target, so eventually it stopped adding
  anything while still doing the work of looking.
- **Several visualizer memory leaks**, mostly around switching modes and the
  per-track visual memory registry.

### Added

- **The visualizer manages its own quality.** Instead of guessing from a hardware
  check at startup, each visualizer measures how long its frames actually take. If
  it's consistently over budget it steps resolution down, then frame rate; when
  there's headroom again it steps back up. Changes are gradual so it doesn't
  oscillate. The MilkDrop view does the same and is now capped at 45fps — on a
  144Hz monitor it had been rendering at full refresh for no visible benefit — and
  idles down when paused.
- **Two more visualizer scenes**, for 31 total: *Phosphor Scope*, a dual-trace
  oscilloscope driven by the live spectrum with stereo width separating the beams,
  and *VU Cathedral*, a wall of twelve backlit analog VU meters each tracking its
  own frequency band.

## [2.0.0] - 2026-07-08

A design pass. The app looked like hardware but was inconsistent up close; this
made it consistent.

### Added

- **A proper design system.** The 5,500-line stylesheet became ordered modules
  with shared scales for type, spacing, motion, and shadow, and a single theme
  registry.
- **Shared UI pieces** used across every view: one header component, chips, empty
  states, loading placeholders, a toast queue instead of scattered status text,
  and two-step confirmation on destructive actions. Star ratings use real icons
  now instead of text glyphs.
- **Now Playing was rebuilt** as a proper display, with an on-air lamp, honest
  readouts, and an attract mode when nothing is playing.
- **Keyboard queueing in the library.** Track rows take focus: `Enter` plays, `Q`
  queues, `Shift+Q` plays next, arrows move between rows. Useful when the table
  has 60,000 rows in it.
- **Deck snapshot** — `Ctrl+Shift+S` captures the current compact deck to your
  clipboard and disk.
- **`Shift+S` cycles skins** live from anywhere, without the visualizer stuttering.
- **`Ctrl+K` opens with your last track** ready to resume before you type.
- **First launch starts with your music**, not an API key screen.
- **Self-hosted fonts** — Google Fonts is no longer in the content security policy
  at all.
- **Experimental exclusive-output support on macOS and Linux** (CoreAudio hog mode
  and ALSA direct), joining the existing Windows WASAPI exclusive mode.

### Changed

- Reduced-motion and reactive-chrome settings are now respected consistently, and
  the animated accents are compositor-only so they don't cost frame time.

## Earlier releases

1.x covered the first two months of the project: the library and scanner, the
Eviland visualizer and MilkDrop support, compact decks and skins, bit-perfect
exclusive output on Windows, the phone remote, podcasts, Last.fm, and the
year-in-review. Full notes for each version are on the
[releases page](https://github.com/evilander/newamp/releases).
