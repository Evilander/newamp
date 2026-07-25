# Changelog

Notable changes to NewAmp. Versions follow [semver](https://semver.org/).

Release notes for every version, including everything before 2.0, are on the
[releases page](https://github.com/evilander/newamp/releases).

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
