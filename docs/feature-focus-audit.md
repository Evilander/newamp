# NewAmp feature-focus audit — 2026-07-11

Question asked: which features earn their upkeep, and where should focus go
to sharpen what makes NewAmp special?

Evidence base: 20 view modules (~14,700 LOC in `src/components/views/`),
120+ `smoke:*`/`test:*` gates in package.json, release history in git.
Where a claim below is a judgment call rather than measured fact, it says so.

## What NewAmp actually is

Three moats no mainstream player matches simultaneously:

1. **Hardware soul** — deck skins (now reference-grade objects), Eviland +
   detached projector, Resonance whole-UI reactivity, 13 skins × 4 shells.
   Nobody else *looks* like this.
2. **Audiophile honesty** — WASAPI-exclusive bit-perfect with refuse-to-lie
   sample-rate traps, hi-res f32 transcode, honest signal-path UI.
   foobar2000 has the plumbing; it does not have the honesty *presentation*.
3. **Local-first scale** — 62,949 tracks scanned incrementally in ~5.4s;
   after this pass, virtualized grids and instant album-open. The library
   never feels like a web app.

Everything in the product should either serve one of these or be cheap
enough that it doesn't matter. The rule proposed here: **every surface must
make the library instant, the playback honest, or the experience beautiful
and shareable.** Fail all three → freeze or cut.

## Double-down (the differentiators)

| Feature | Why |
|---|---|
| Deck skins | Just rebuilt to wow-grade; Deck Snapshot (polaroid) is a built-in share loop — marketing/ drafts already lean on it |
| Eviland + detached projector | Flagship; green artifact fixed this pass; keep investing in scenes over new modes |
| Resonance | Unique; self-throttling already solved the perf objection |
| Bit-perfect / signal-path honesty | The trust story that converts audiophiles; document it louder |
| Perceived performance | This pass: virtualized album grid, no whole-app re-render on the clock, instant album-open. Continue: LibraryView rows, art thumbnail sizes |

## Keep (table stakes — maintain, don't grow)

Queue/playlists/smart rules/Auto DJ, EQ, ReplayGain, gapless/crossfade,
Last.fm, lyrics (local + fetched), watch folders, metadata editing, media
keys/tray/thumbar, themes/shells, Home/History/Mixes, first-launch flow.
These are done and gated; new work here should be bug-fix only.

## Audit list (value unclear vs. upkeep cost — decide with data)

| Feature | Footprint | Concern |
|---|---|---|
| Podcasts | PodcastView + download/progress smokes + host-guard test | A whole subscription/download subsystem inside a local music player; dedicated apps do it better. Candidate: freeze, or reduce to "plays podcast files" |
| Net radio | RadioView + radio-brain smoke | Same question, smaller footprint |
| Discover | 381 LOC + 2 smokes | If it's network novelty rather than library insight, it dilutes the local-first story |
| Social / Remote / Handoff | 4+ smokes | Multi-device surface = permanent upkeep; who uses it? |
| AI assist (OpenAI key) | smoke:ai-assist + settings | Keep only if it demonstrably powers something loved (smart playlists, liner notes); otherwise it's a checkbox feature |
| DNA / seed-vibe / clip-replay / practice-loop / tempo / bookmarks | 1 smoke each | Power-user micro-features; individually cheap, collectively they crowd the UI and the gate suite |
| Wrapped | 402 LOC, seasonal | Keep frozen until Nov 2026 build-up (Wrapped Live deadline Dec 2026) |
| Profile | 277 LOC | Unclear job; fold into Home or History? |

**How to decide honestly:** we're guessing about usage. Add an opt-in,
local-only usage counter (JSON in userData, no network) for view opens and
feature actions; read it after 30 days. Freeze the bottom of this table now
(no new work, smokes stay green), cut what the data doesn't defend.

## Structural debt that slows every future pass

- `NowPlayingView.tsx` (2,797 LOC) and `LibraryView.tsx` (2,357) are the two
  biggest files in the renderer and both need module splits before more
  features land in them (this session split the 1,613-line decks.css the
  same way).
- The smoke suite is an asset (120+ gates) but each frozen feature still
  costs CI time; a `smoke:frozen` tier that runs weekly instead of per-push
  would keep the safety without the tax.

## Suggested next beats (in order)

1. **Ship the deck showcase** — the decks are now the screenshot bait the
   marketing drafts assume; refresh README/gallery art and post the
   Deck Snapshot loop.
2. **Land the usage counter** (one afternoon) so the freeze/cut list stops
   being opinion in 30 days.
3. **Freeze now:** Podcasts, Social/Remote, Discover, DNA-class micro
   features — pending that data.
4. **Split NowPlayingView/LibraryView** before the next feature pass.
