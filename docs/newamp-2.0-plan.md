# NewAmp 2.0 — Synthesized Build Plan

## 1. EXECUTIVE SUMMARY

- **Eviland detached projector is broken on the default preset.** `eviland-live` never publishes frames; the only fix worth doing is a headless always-on producer + moving Detach out of the fullscreen overlay. Highest-leverage single fix in the entire audit.
- **Eviland MilkDrop parity is a ~1-week / ~1,500-LoC sprint** if you do it in the right order: q-vars → radial warp profile → RGB decay + cx/cy → video-echo → field crossfade → custom shapes. Steps 1-6 demonstrably exceed Butterchurn on reactivity.
- **Two real perf leaks** running 24/7: `adaptiveQuality` rAF never stops (`adaptiveQuality.ts:56,82`) and engine audio tick rAFs at 60Hz with audio paused (`engine.ts:349-380`). Both are <10-line fixes.
- **Album search is broken in the obvious way:** "helter skelter" returns nothing because `getAlbums` doesn't look at track titles. Fixable in one SQL change + one optional field on `AlbumSummary`.
- **Link coverage is ~60% done.** `ArtistLink`/`AlbumLink` exist and work; ~25 plain-text sites need wrapping, and the store needs a `navigateToTrack` action + `TrackLink` component to close the last gap.
- **First viral wave for 2.0 is clear:** Deck Snapshot → Eviland Clip Studio → Wrapped Live → NowPlaying.live. All four produce shareable artifacts directly out of NewAmp; nothing else on the market does this.
- **Codex spiral residue still present in Visualizer.tsx** (2357 lines, three duplicate per-frame loop scaffolds, all-modes-in-one giant `frame()`). Worth a focused cleanup before 2.0 work piles on top.
- **Default visualizer preset (`eviland-live`) is the single most visible surface; every fix that touches it compounds.**

---

## 2. EVILAND → BEST-IN-CLASS MILKDROP REPLACEMENT

Ranked by impact-per-effort. Includes the detached-window architecture fix first because it unblocks all preset work for the projector.

### 2.0 — Headless Eviland producer (architectural prerequisite) — HIGH / M
Frames must publish regardless of which preset is on-screen. Today only the `eviland` branch at `Visualizer.tsx:464` calls `frameBus.publish`; the default `eviland-live` branch at `Visualizer.tsx:183` builds a reactor but never publishes.

- **NEW** `src/visualizer/eviland-producer.ts` (~80 lines): singleton reactor + rAF + `frameBus.publish`, sourced from `engine.getFreqData`/`getOnsetFreqData`/`getLeftFreqData`/`getRightFreqData`. Gate rAF on `frameBus.hasAnyConsumer()` so idle cost is ~0.05 ms.
- `src/App.tsx` ~L58: `useEffect(() => startEvilandProducer(engine), [engine])`.
- `src/visualizer/frame-bus.ts` ~L143: add `hasAnyConsumer()`; update header comment.
- `src/components/Visualizer.tsx:464`: **delete** the `frameBus.publish(...)` call.
- `src/components/FullscreenVisualizer.tsx:921-941`: **delete** the `if (activePreset !== 'eviland') setPreset('eviland')` force-switch.
- `src/components/FullscreenVisualizer.tsx:1257`: drop the `activePreset === 'eviland'` gate on the settings-row Detach.
- `src/components/Sidebar.tsx` (preferred) or `Transport.tsx`: add a primary Detach button using `useDetachedVisualizer` so the projector survives independently of fullscreen viz.

No changes needed in `electron/main.ts`, `preload.ts`, `detached/main.tsx`, or frame-bus transport. After this lands, every following Eviland upgrade is automatically visible in the detached window.

### Tier S — biggest visual-per-effort wins

### 2.1 — q-variable system (preset-internal scratch + LFOs) — HIGH / M
`src/visualizer/eviland-operators.ts:73-137, 216-259`. Add 8 declarative q-slots with `{name, base, lfo:{rate, shape}, smooth, bindings}`. `evalConfig` computes q's first, channels can reference them as features. LFOs locked to `beatPhase * rate` for tempo sync. Pure JSON-safe, no eval. **Foundation for every subsequent preset diversity gain — do first.** ~150 LoC.

### 2.2 — Per-pixel radial/angular warp profile — HIGH / S
`src/visualizer/eviland.ts:114-205, 826-842, 1166-1185`; operator schema at `eviland-operators.ts:73-137`. Add `u_zoomRadGain, u_rotateRadGain, u_swirlRadGain, u_decayRadGain` (vec4) + optional angular gains; shader uses `u_zoom + u_zoomRadGain * radius * radius`, etc. Adds `radial`/`angular` sub-bindings to `OperatorConfig`. **Reproduces ~70% of MilkDrop's "spatial preset character" in 150 LoC.** No new FBO.

### 2.3 — Per-channel RGB decay — HIGH / XS
`FIELD_FRAG` `eviland.ts:114-205`. Replace scalar `u_decay` with `vec3 u_decayRGB`. Trails drift toward a hue over time (classic MilkDrop "everything turns blue eventually" look). Operator: `decayR/G/B: Channel`. ~30 LoC.

### 2.4 — Centre offset cx/cy for warp + emitters — HIGH / XS
`FIELD_FRAG` `eviland.ts:167` (replace `vec2 centre = vec2(0.5)` with `u_centre`). Expose `centreX/Y: Channel`. Tunnel + mirror folds around moving centre. ~40 LoC. Combined with 2.2 + 2.3 this triples the preset space at near-zero cost.

### 2.5 — Video-echo pass — HIGH / M
New module + 1 FBO (RGBA16F). Insert between field-swap and bloom at `eviland.ts:1274`. Uniforms in `POST_FRAG` `eviland.ts:471-562`: `u_echoZoom, u_echoRot, u_echoAlpha, u_echoFlipX, u_echoFlipY`. Operator: `echo:{zoom, rotate, alpha, flipX, flipY}`. **The missing MilkDrop signature** — adds depth, asymmetry, kills the "single coherent transform" feel. ~200 LoC, ~16 MB at 1080p (gate off on `low`).

### 2.6 — Field-buffer crossfade on section change — HIGH / S
`eviland-director.ts:239-292`, `eviland.ts:1107-1185`. Snapshot field to `fieldSnapshot` (RGBA16F) when Director starts a fade; post composite samples `mix(fieldA, fieldSnapshot, 1-fade)`. **Fixes the mid-fade tear** caused by `eviland-operators.ts:355` `pick = t<0.5 ? a : b` (mirror count snapping). ~120 LoC, FBO during transitions only.

### 2.7 — Custom shape system — HIGH / L
Reuse instancing at `eviland.ts:1060-1082`. Up to 8 author-defined shapes per preset with `sides`, `textured`, channel-driven position/radius/rotation/rgba. Director assigns per-archetype (lattice → hex grid, kaleidoscope → triangle ring, nebula → soft blobs). **The second biggest "looks like a different preset" lever in MilkDrop.** ~400 LoC + shader.

### 2.8 — Multi-waveform + per-sample wave colour — MED / S
`eviland.ts:371-415, 1249-1266`. Replace single waveform with `waveforms: WaveformConfig[]` (up to 4), each with own mode/position/scale/colour-source/sample-range. Add `color.from='band'` → modulate per-sample colour by dominant band at that x (mini spectrogram). ~220 LoC total.

### 2.9 — Warp-map library (CPU-uploaded mesh-style maps) — MED / M
New R32G32F 64x36 texture sampled in `FIELD_FRAG`. Bake 16 displacement maps (spiral, vortex, fisheye, X-cross, hexagonal, etc.). Director assigns per archetype. Closes the warp-mesh capability gap without GPU mesh geometry. ~250 LoC.

### Tier A — finish the MilkDrop feel

### 2.10 — Motion-vector overlay — MED / M
Sparse instanced arrow grid (16x12), positions warped by field transform, color fades with speed. Insert between emitters and spectrum at `eviland.ts:1198-1247`. ~180 LoC.

### 2.11 — Border + dot-grid pass — LOW / XS
Two single-line shaders for MilkDrop-style frame garnish. Per-preset on/off. ~60 LoC each.

### 2.12 — Time-of-section channel — MED / XS
`eviland-audio.ts:166-197` already tracks `sectionStartAt`. Expose `sectionTime` + `sectionPhase` in `EvilandFrame`; wire to `AudioFeature` union at `eviland-operators.ts:27-33`. Enables presets that unfold over a section (drop builds). ~25 LoC.

### 2.13 — Spectrogram terrain mode — LOW / S
`TERRAIN_FRAG` `eviland.ts:292-312`. Add `mode: 'horizon'|'spectrogram'|'mountain'`. ~60 LoC.

### Tier C — research, after the above lands

- **Mini expression language for q-vars** (RPN, ~500 LoC) — unlocks user-authored presets approaching MilkDrop authoring.
- **`.milk` preset import** — translator from MilkDrop preset format to OperatorConfig. Only feasible after 2.7 + expression lang. Justifies "MilkDrop replacement WITH the same visuals" claim.

**Build order (1 → 6 = the visible MilkDrop killer in ~1 week):**
1. 2.0 (producer + detach)
2. 2.1 (q-vars)
3. 2.2 (radial warp)
4. 2.3 + 2.4 (RGB decay + cx/cy)
5. 2.5 (video-echo)
6. 2.6 (field crossfade)
7. 2.7 (custom shapes)
8. 2.8 + 2.9 (waveforms + warp maps)
9. 2.10 / 2.11 / 2.12 / 2.13 (garnish)

After 1-6 (~1,500 LoC), Eviland exceeds Butterchurn on reactivity while matching MilkDrop's core primitives.

---

## 3. CONCRETE FIXES NEEDED NOW

### 3.1 — Perf / correctness bugs (do these before any 2.0 work)

| # | Severity | Location | Fix |
|---|---|---|---|
| A | bug | `adaptiveQuality.ts:56,82` | `monitorRunning` never resets. In the subscribe cleanup, when `subscribers.size === 0`, set `monitorRunning = false` so `tick` exits next frame. |
| B | bug | `audio/engine.ts:349-380` | `tick()` re-RAFs forever. Bail if `!el.src \|\| el.paused \|\| el.ended`; re-arm from `play`/`playing` listeners. Biggest idle-battery win. |
| C | perf | `Visualizer.tsx:617-618, 702-704, 843, 882, 932, 1026, 1032, 1166, 1288, 1749, 558` | Hoist `getCssVar('--accent'/'--ink-2')` + `parseRgb`/`parseRgbVec` out of every per-frame loop. Eviland already does this (L391-394); other branches don't. Forces style recalc 60×/s. |
| D | perf | `eviland-operators.ts:308-310` | Replace `cloneConfig`'s `JSON.parse(JSON.stringify(...))` with `structuredClone(c)`. Called 5+ times per section boundary. |
| E | perf | `Visualizer.tsx:1617` | Canvas `key` includes palette/quality/performance/reactivity → theme change rebuilds entire WebGL2 renderer (100+ms hitch). Scope key to `mode` only; propagate other deltas via existing `setConfig`. |
| F | perf | `NowPlayingView.tsx:1913-1940` | `VuMeter` calls `querySelector('[data-vu="L"]')` every frame and runs while paused. Use `useRef` + gate on `isPlaying`. Also use real L/R analysers (`getLeftFreqData`/`getRightFreqData`) instead of fake `*0.96`/`*1.02` mono split. |
| G | perf | `NowPlayingView.tsx:1370-1408` | Spectrum bar rAF runs while paused. Gate on `isPlaying`. |
| H | perf | `Visualizer.tsx:424-438` | `applyWaveformOverride` rebuilds config every frame; rebuild once when `ui.waveMode` changes. |
| I | bug | `Visualizer.tsx:1566` | Delete `getCssVar('--ink-2')` at L704 and `void ink2;` at L1566 — dead variable masked by suppression. |
| J | cruft | `eviland.ts:674-675` | Delete the placeholder program — compiles a full shader pair only to throw it away at boot. |
| K | cruft | `src/audio/live-input.ts` | Entire 188-line file is unused; only docs import. Delete or wire the feature. |
| L | cruft | `eviland-randomizer.ts:1049-1055` | `classic()` is a 1-line wrapper with no callers. Delete. |
| M | perf | `frame-bus.ts:108-115` | Early-return when `state.listeners.size === 0 && !state.port` (cheap, fires 60×/s currently). |

### 3.2 — Album search: match on track title (`getAlbums`)

Searching "helter skelter" in Albums returns nothing because `getAlbums` ignores `title`. One SQL change:

- `electron/library.ts:1216-1283`: replace the search `WHERE` with a `HAVING (MAX(CASE WHEN album/artist/year fields match) = 1 OR MAX(CASE WHEN title matches) = 1)`. Add aggregates to SELECT: `matched_on_track` flag + capped `GROUP_CONCAT` of up to 4 matching titles. Order pure-track-only matches to the bottom of their letter group.
- `shared/types.ts:144` `AlbumSummary`: add optional `matchedOnTrack?: boolean` + `matchedTrackTitles?: string | null`.
- `src/components/views/AlbumsView.tsx:574-591`: render a third line under each grid card when `a.matchedTrackTitles` present: `♪ {titles}`.
- `src/components/views/AlbumsView.tsx:515`: change placeholder to `"Filter albums or songs…"`.

No IPC changes, no new endpoint, ~25 net LoC, backwards-compatible (empty search skips the new SQL fragments).

### 3.3 — Link coverage checklist

`ArtistLink`/`AlbumLink` (`src/components/EntityLink.tsx`) exist and handle `stopPropagation`. Required wrap sites (highest-value first):

**Top of list (always-visible chrome):**
- `Transport.tsx:99` — marquee `★ {artist} — {title} ({album})`. Wrap artist + album. Keep `whiteSpace: nowrap`.
- `TitleBar.tsx:45-48` — window-title marquee. Wrap artist.

**NowPlayingView:**
- `views/NowPlayingView.tsx:480` — album-art overlay credit line; wrap `albumArtist || artist`.
- `views/NowPlayingView.tsx:482-484` — album name buried under "open fullscreen viz" button; extract into `AlbumLink`.
- `views/NowPlayingView.tsx:1131-1137` — `QueueRow` is title-only; append ` · <ArtistLink>`.
- `views/NowPlayingView.tsx:1644, 1654, 1662, 1673, 1676-1685` — `AlbumContextPanel` plain-text lists (same-year, credits, bookends, longest, mini tracklist). Wrap; mini tracklist also wants double-click-to-play.
- `views/NowPlayingView.tsx:1880-1881` — `SoundsLikePanel` row artist.
- `views/NowPlayingView.tsx:2411` — `KaraokeOverlay` header (call `onExit()` then navigate, or leave plain).

**HomeView:**
- `views/HomeView.tsx:278, 458, 638-643, 859, 889/906-907, 998-1001, 1018, 977-978` — rails, news card, hero, "today's pick". Promote `subtitle`/`HomeRail` prop type from `string` to `ReactNode`.

**HistoryView, MixesView, PlaylistView, AlbumsView, AtlasView, TagsView, WrappedView:**
- `HistoryView.tsx:167, 178-179` — `InsightList.primary` plain; promote to `ReactNode`.
- `MixesView.tsx:70-71, 78-80, 169` — seed labels.
- `PlaylistView.tsx:973, 1080` — already use `ArtistLink`; **append `AlbumLink`** for parity with LibraryView.
- `AlbumsView.tsx:427-431` — selected-album header artist.
- `AlbumsView.tsx:584-588` — grid card: split artist out of card-opening button into its own `ArtistLink`.
- `AtlasView.tsx:355, 358` — hover tooltip is `pointer-events-none`; either fix that or skip.
- `TagsView.tsx:482` — smart-rule preview row.
- `WrappedView.tsx:255, 298` — top tracks/artists. (Lines 91, 104 are `canvas.fillText` — leave.)

**FullscreenVisualizer / Liner Notes / Palette:**
- `FullscreenVisualizer.tsx:1452` — cinema "now-playing" overlay; click should `setFullscreenViz(false)` before navigating.
- `LinerNotesPanel.tsx:238-249` — `CreditRow` currently links Artist field to Wikipedia. Replace with `ArtistLink`/`AlbumLink`; keep Wikipedia ↗ as secondary.
- `QuickPlayPalette.tsx:492` — `subtitle` is a baked string; re-render as JSX.

**Decks (`decks/*`):**
Leave plain text. Skeuomorphic skins shouldn't carry underlined links. Document that exiting compact mode is the path to navigation.

### 3.4 — TrackLink + `navigateToTrack` (close the last gap)

1. Store: add `pendingNavigation` variant `{ kind: 'album-with-track', album, albumArtist, trackId }` + `navigateToTrack(track)` action.
2. `AlbumsView.tsx:84-136`: handle the new variant — open album, then highlight matching row via a transient `highlightedTrackId` state passed into `TrackTable`.
3. `EntityLink.tsx`: add `TrackLink` (falls back to `ArtistLink` when `track.album` empty).
4. Drop into all sites flagged "wants `TrackLink`": NowPlaying `AlbumContextPanel` (opener/closer/longest/tracklist), HomeView rails/news/hero, MixesView, TagsView preview, WrappedView top tracks, LinerNotesPanel title, QuickPlayPalette subtitle.
5. Modifier semantics: single-click title → navigate; double-click row → play (existing); Ctrl/Cmd-click → play immediately.

### 3.5 — Visualizer.tsx cleanup (Codex residue, do before 2.0)

- Split the 858-line `frame()` into per-mode init/loop functions dispatched once by `mode` (`Visualizer.tsx:706-1564`). Removes ~50% of dead local state.
- Collapse the three duplicate per-frame loop scaffolds (`createFrameGate`, `startShaderVisualizer`, canvas-2D inline frame at `Visualizer.tsx:106-117 + 1655-1666 + 587-1572`) into one `createVisualizerLoop({mode, render})` dispatcher. Cuts ~150-200 lines.
- Delete duplicate `getCssVar` (`Visualizer.tsx:1967-1979` vs `:617-618`); unify `parseRgb` + `parseRgbVec`.

---

## 4. NEWAMP 2.0 FEATURE SET

Ranked by **virality × feasibility**. Recommended first wave marked **★**.

| # | Feature | Effort | Virality | Notes |
|---|---|---|---|---|
| **★1** | **Deck Snapshot — Polaroid mode** | S | High | Right-click any deck → 1080×1350 themed PNG. 9 decks each export a unique aesthetic. Cassette deck gets a hand-lettered J-card. Lowest effort, immediate share artifact. `decks/*.tsx` + new `lib/deckSnapshot.ts`. |
| **★2** | **Eviland Clip Studio (retroactive 15s clips)** | M | Very High | One-button MP4/GIF of last 15s of Eviland with audio + watermark. `eviland-recorder.ts` (extend) + new `ClipStudio.tsx` + `electron/main.ts` mux. 9:16 vertical preset for TikTok. *Accept: press `R` mid-playback → ≤4s export on M2.* |
| **★3** | **Wrapped Live — Wrapped as animated video** | M | Very High | Today's Wrapped becomes 20s animated MP4 scored to user's top track. Reuse `eviland-recorder.ts`. 1080×1920, ≤8MB, <10s render. |
| **★4** | **NowPlaying.live — shareable status URL** | M | High | `radio-brain.ts` adds `/now.json` + `/now.html`; opt-in Cloudflare tunnel. Live SSE Resonance pulse. Last.fm killer for 2026. |
| **★5** | **Eviland Director (per-track structural choreography)** | L | High | Promote `eviland-director.ts` from heuristic to per-track plan. Pre-analyze sections, anticipate drops 2 bars early, explode on transient. Synergizes with all Tier-S engine upgrades in §2. |
| 6 | Memory Lane (on-this-day-Y-ago) | S | High | Home rail using existing play-history. Nostalgia tweets. `electron/library.ts` date-aware query. |
| 7 | NL Command Palette ("loud sad songs", "more like this but slower") | M | High | Route Ctrl+K through Tags DSL + DNA + smart-rule synth. Optional LLM hint via existing `openai-assist.ts`. 8/10 canonical queries should work offline. |
| 8 | Skip Confessional | S | High | Honest "you say you love X but skip 60%" insights. Self-roast screenshots are catnip + genuinely improves Discover. |
| 9 | Auto-DJ Cinema Mode | M | Med | Fullscreen Eviland + harmonic mix + 5s chapter cards on transition. NewAmp becomes a channel. |
| 10 | Resonance Outwards (OpenRGB + menubar/taskbar pulse) | L | Very High | Per-instrument color routing to Govee/Hue/OpenRGB via SDK socket (no native deps). Setup-video gold. Only player doing per-band, not envelope. |
| 11 | Liquid Tabs (drag decks out as always-on-top widgets) | M | Med | Reuse detached-window infra. Spinning record on second monitor = recordable. |
| 12 | Sonic Atlas Constellations (draw a path → play it) | M | Med | AtlasView already projects DNA-space. Make path-drawing enqueue 40min mix. Demo-worthy. |
| 13 | Time-of-Day DJ (learned daily shape) | M | Med | After 14 days, learn morning/work/evening DNA windows. "Right now: deep work" pill. |
| 14 | Album Story (generative liner notes from your data) | M | Med | LLM optional; offline template version using real stats. Letterboxd-shape for music. |
| 15 | Onboarding Pulse (library portrait on first scan) | S | Med | DNA-aggregated sharable PNG at end of first scan. Sets tone. |
| 16 | Listening Rooms (LAN-synced + chat) | L | Med | mDNS discovery + `radio-brain.ts` + sync clock. <250ms drift over 5min. |
| 17 | Per-album EQ + EQ Match | M | Low-Med | Audiophile blog-post bait. Per-album DSP table in SQLite. |
| 18 | Headphone Profile Matcher (bundled AutoEQ data) | S | Med | Bundle ~3000 profiles, no API. r/audiophile credibility. |
| 19 | Bit-Perfect Path + Signal Chain Inspector | L | Low-Med | WASAPI exclusive (Windows) + CoreAudio exclusive (macOS), green-light bit-perfect indicator. Permanent audiophile moat. |
| 20 | VJ Mode (Web MIDI → Eviland operators) | M | Niche | Plug MIDI controller, learn-map CC# to operator. Pairs with Clip Studio. |
| 21 | Concert Mode (WebRTC Eviland to remote viewers) | L | Med | Mirror visualizer only via WebRTC; audio plays from viewer's device (DRM-friendly). |
| 22 | Living Tags Marketplace (.newamptag) | S-M | Low-Med | Share Tags DSL rules as JSON; GitHub-Pages hosted manifest. Power-user community. |

### Recommended first wave (★1-5)

All five compound: the engine work in §2 lights up #5 (Director) and makes #1-4 visually richer; #1-4 produce share artifacts that drive 2.0 launch reach.

**Execution order:**
1. Land §2.0 (headless producer + Detach move) and §3.1 perf fixes.
2. Land §3.2 album search and §3.3-3.4 link coverage.
3. Ship Tier-S Eviland engine work in order 2.1 → 2.6.
4. Ship ★1 → ★2 → ★3 → ★4 (share loop).
5. Ship ★5 (Director) on top of the new engine primitives.
6. Continue with #6-#11.

---

## 5. RISKS / WATCH-OUTS

- **`ui-visualizer` smoke is pre-existing-stale** (per `newamp-eviland.md`). Verify the new headless producer doesn't trip headless smokes — gate producer rAF on `!__newampSmoke` or on `frameBus.hasAnyConsumer()` so smokes see no extra work unless they attach a listener.
- **Default preset is `eviland-live`** — every regression in §2.0 lands on every user immediately. Manual checks: open NewAmp, leave preset on `eviland-live`, open Detach from sidebar, navigate Library/Albums/Queue while projector runs, switch preset to `butterchurn` — projector must keep painting.
- **Field-buffer crossfade (§2.6) adds an FBO during transitions only** — gate off on `quality === 'low'` to keep low-tier hardware safe.
- **Video-echo (§2.5) is ~16 MB at 1080p** — disable by default (alpha=0), force-off on `low` quality tier.
- **Album search SQL change** (§3.2) introduces aggregates with `LIKE` sub-selects. Bounded by `ALBUM_PAGE_SIZE` (~240 rows) so worst case ~240 indexed `LIKE` lookups — verify under load on a 50k+ track library before merging.
- **Two `getAlbums` callers depend on schema stability**: `openCurrentAlbum`, `openSurpriseAlbum`, Quick Play with `CATALOG_LIMIT`. All keep working because new `AlbumSummary` fields are optional, but confirm in smoke.
- **`TrackLink` modifier semantics changes Home rail behavior** — single-click on title in `RatedHighlightRail`/`HomeRail` currently plays via parent button; `TrackLink`'s `stopPropagation` will suppress play on title click and route to album instead. This is intentional but is a behavior change; document in release notes.
- **Codex residue still active** — the all-modes-in-one giant `frame()` in `Visualizer.tsx` and the three duplicate per-frame scaffolds will keep accumulating drift. Resist piling 2.0 features on top without §3.5 cleanup first.
- **`live-input.ts` was deleted** as dead code (§3.1 K) — if Listening Rooms (#16) or Resonance Outwards (#10) need mic capture, re-introduce it intentionally, not from git history.
- **MilkDrop preset import (§2 Tier C)** is the only feature in the plan that risks legal/IP friction (existing `.milk` preset packs). Treat as ship-with-our-own-presets; community import is opt-in via file picker.
- **Cloudflare tunnel for NowPlaying.live** is opt-in but quick-tunnel URLs rotate. Document this; consider letting users bring their own named tunnel.
- **`adaptiveQuality` fix (§3.1 A) changes idle behavior** — confirm no consumer subscribes-then-immediately-unsubscribes in a tight loop expecting `monitorRunning` to stay live.
- **Detached projector currently runs Eviland WebGL2 renderer, not MilkDrop.** Per the viz-architecture report, keep it that way; mirroring `eviland-live` (MilkDrop + reactor overlay) into the detached window doubles compositor cost and needs a parallel audio port. Defer.