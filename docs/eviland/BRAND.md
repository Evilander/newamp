# Eviland — Brand & Positioning

> **Eviland** — the visualizer that *listens*.
> An instrument-aware, self-directing generative visual engine for music.

## One-liner

**Eviland turns any song into a live light show that conducts itself — reacting to
every instrument, generating looks no one has seen before, and following the
music's structure like a VJ who already knows the track.**

## The 15-second pitch

Every music visualizer for the last 20 years pulses on the same three numbers:
bass, mid, treble. Eviland *hears the band* — a 24-band onset engine separates the
kick from the snare from the hat from the vocal and gives each its own visual
voice. On top of that sits a generative engine that mints endless original looks
from a shareable seed, and an AI **Director** that reads the song's structure and
conducts the visuals through its arc — calm in the intro, exploding on the drop,
and *rhyming* when the chorus comes back. Plug in a mic or your audio interface,
throw it on a projector, and hit record.

## Who it's for

| Audience | Why Eviland |
|---|---|
| **VJs & live performers** | Line-in/interface input, projector/second-screen output, beat-locked auto-direction, recordable. A VJ rig that runs itself. |
| **Musicians (live & practice)** | Point it at the room; it reacts to *your* instruments individually, not a muddy average. |
| **Streamers & content creators** | A reactive backdrop that never repeats; shareable seeds for a signature look. |
| **Video producers** | High-bitrate WebM capture now; deterministic 4K ffmpeg export on the roadmap. |
| **Everyone with a music library** | The most beautiful "press play and stare" visualizer on the desktop — default in NewAmp. |

## What makes it different (the moat)

1. **Causal, per-instrument reactivity.** A 24-band mel spectral-flux onset
   detector classifies *which instrument* fired and fires its own visual event
   (kick → shockwave, snare → burst, hat → sparkle, vocal → blob, bass →
   terrain). Frequency drives vertical position; stereo drives horizontal. No
   other engine sees music this granularly.
2. **A generative engine, not a preset pack.** Looks are *data* (operator
   configs): a base + audio-feature bindings per visual channel. The randomizer
   samples that space within musical, never-broken bounds across six archetypes
   (tunnel, kaleidoscope, liquid, lattice, nebula, strobe). Every look is a
   short shareable seed — `K7Q2-9XMF` — that reproduces it exactly, anywhere.
3. **A Director that conducts itself.** Structural memory detects sections and
   energy tiers and crossfades the generative looks on the beat — building into
   drops, settling into breakdowns, and recalling a section's earlier look when
   it returns so the visuals *rhyme* with the song. Hands-free, overridable.
4. **Built for the stage.** Mic/line-in input, a detached window you can throw on
   a projector while you keep working, and video recording.

### Versus the field

- **MilkDrop / butterchurn / projectM** — gorgeous, but preset-driven and react
  to bass/mid/treb only. Eviland is instrument-aware, generative, and
  self-directing, with native MilkDrop-class warp + waveform built in.
- **Magic / Resolume generators** — pro VJ tools, but you drive them. Eviland can
  drive itself, and it's free inside a music player.
- **Winamp AVS nostalgia** — Eviland is the modern, GPU, instrument-aware answer.

## Naming & identity

- **Product:** Eviland (keep Tyler's name — it's distinctive and ownable).
- **Wordmark:** lowercase `eviland`, tight tracking; the "i" dot as a reactive
  pulse.
- **Palette:** deep near-black grounds; signal colors are generated per-look
  (cyan/magenta/cream lead the default identity).
- **Voice:** confident, a little mischievous, never corporate. "It listens." "It
  conducts." "Throw it on the wall."

## README / landing outline

1. Hero: a 6-second looping demo-reel clip (recorder output) + the one-liner.
2. "It hears the band" — animated diagram of the 24-band → per-instrument events.
3. "Infinite looks, one seed" — the randomizer montage; a seed you can paste.
4. "It conducts itself" — the Director arc over a song timeline.
5. "On the stage" — live input + projector + record.
6. Quickstart (embed `@eviland/core` in 10 lines) + download (NewAmp).

## Demo-reel plan (uses the recorder)

1. Pick 3 contrasting tracks (electronic w/ a drop, a band recording, a sparse
   vocal piece).
2. Director ON; record each at 1080p60 / 12 Mbps via the canvas recorder.
3. Cut to the drops; show the same chorus rhyming on its return.
4. One segment: live mic input reacting to clapping/voice to prove "it hears the
   room."
5. End card: a seed code on screen — "scan to load this look."

## Roadmap headline features (post-MVP)

- Deterministic 4K ffmpeg export (frame-log replay).
- A public seed gallery (browse/share looks by code).
- MIDI / Ableton Link sync for tight live rigs.
- `@eviland/core` on npm — embeddable like butterchurn, but it listens.
