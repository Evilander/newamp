# Changelog

Notable changes to NewAmp. Versions follow [semver](https://semver.org/).

Release notes for every version, including everything before 2.0, are on the
[releases page](https://github.com/evilander/newamp/releases).

## [Unreleased]

### Fixed

- Tag rules can call `matches(field, "pattern")` and `contains(field, "text")`
  as functions, the way the Tags view lists them. The parser only knew the
  infix forms and rejected the call with "unexpected token".
- Podcast feeds up to 32 MB can be subscribed to. The previous 5 MB ceiling
  refused the feeds of some long-running shows on the larger networks; one
  Simplecast feed measured 20 MB.

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
