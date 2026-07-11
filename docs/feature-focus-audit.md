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
| Eviland + detached projector | Flagship and the app's largest code cluster (7+ dedicated test suites); green artifact fixed this pass; keep investing in scenes over new modes |
| Resonance | Unique; self-throttling already solved the perf objection |
| Bit-perfect / signal-path honesty | First-party native WASAPI/CoreAudio/ALSA inside Electron; the trust story that converts audiophiles — document it louder |
| Living Tags + Audio DNA | A reactive tag-rule DSL (`tag(x) when bpm>110 boost 1.5`) over local perceptual fingerprints — no mainstream player has this; underexposed in the UI relative to its uniqueness |
| Wrapped / Wrapped Live + Radio Brain | Fully local Wrapped with video export, and LAN broadcast of your own library — "social" features with zero cloud; both earned named releases. Wrapped stays frozen until the Nov 2026 build-up |
| Perceived performance | This pass: virtualized album grid, no whole-app re-render on the clock, instant album-open, async art serving. Continue: LibraryView rows, art thumbnail sizes |

## Keep (table stakes — maintain, don't grow)

Queue/playlists/smart rules/Auto DJ, EQ, ReplayGain, gapless/crossfade,
Last.fm, lyrics (local + fetched), watch folders, metadata editing, media
keys/tray/thumbar, themes/shells, Home/History/Mixes, first-launch flow.
These are done and gated; new work here should be bug-fix only.

## Audit list (most code, least evidence — decide with data)

Ranked by footprint vs. verification/iteration evidence (git history +
smoke coverage), worst first:

| Feature | Footprint | Evidence problem |
|---|---|---|
| Guitar tools (tabs, practice loop, tempo trainer) | GuitarTabCompanion.tsx (530) + electron/guitar-tabs.ts (833) ≈ 1,363 LOC | Largest niche cluster in the app; real smokes exist, but it's orthogonal to the player pitch. Freeze candidate — or spin it as a named "Practice Mode" if data shows use |
| OpenAI liner notes | openai-assist.ts + LinerNotesPanel ≈ 610 LOC | One commit ever, never revisited; requires the user's paid API key inside a product whose pitch is "no cloud, no subscription". Cut or clearly ghetto-ize behind Settings |
| Profile | ProfileView.tsx (277) | The only nav view with zero dedicated smoke; README itself calls it a "foundation". Fold into Home/History or finish it deliberately |
| Winamp .wsz import | winamp-skin-import.ts (310) | One commit since inception — but it's on-brand and README-advertised. Keep frozen; it costs nothing until it breaks |
| library-watcher.ts | 152 LOC, last real touch v1.4 | Scanner kept evolving while the watcher froze — verify watch-folders still behaves with 2.0 scanning, then fold into scanner or leave |
| Podcasts | PodcastView (347) + 4 smokes (incl. SSRF hardening) | Actively maintained, but it's a subscription/download subsystem dedicated apps do better. Freeze after next bug pass |
| Discover | 381 LOC + 2 smokes | Keep only if it drives library engagement (it's crate-digging missions over your own files — that IS local-first; verify usage) |

**How to decide honestly:** we're guessing about usage. Add an opt-in,
local-only usage counter (JSON in userData, no network) for view opens and
feature actions; read it after 30 days. Freeze the top of this table now
(no new work, smokes stay green), cut what the data doesn't defend.

Corrections from the code inventory worth naming: Radio is not "net radio" —
it's **Radio Brain**, LAN broadcast of your own library (differentiator, moved
up); Living Tags/DNA is a real DSL, not a micro-feature (moved up); the README
claimed "9 deck modes… even a hotdog" two releases after the Hotdog deck was
removed (fixed this pass).

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
