# NewAmp 2.0 — "Reference Grade" (design-led major release)

**Status:** executing
**Created:** 2026-07-06
**Owner:** Tyler
**Chosen by:** Fable 5 — 6 parallel research agents mapped the UI surface, 3 independent design directions were generated (craft / spectacle / first-hour lenses), 3 adversarial judges (Winamp veteran, indie marketer, staff engineer) ranked them. Reference Grade won 2 of 3; all judges converged on the same grafts.

## Goal (one sentence)

Make the app that looks like hardware finally feel machined like it — every readout true, every control sharing one action physics, every shell a genuinely different product — then ship it as NewAmp 2.0 with a human-first README.

## Direction

**Spine: Reference Grade** (craft & cohesion). Consolidation, not redesign: one token layer (type/motion/shadow/radius ramps), four shared primitives (ViewHeader, Chip, EmptyState/Skeleton, StatusToast), truth in the chrome, per-shell density, zero-hitch theming.

**Grafts (unanimous or 2-of-3 judge endorsement):**
- ON AIR: restrained Resonance Everywhere (playing-row accent bar, transport art breathing ring, scrub glow — all gated on `data-amp-reactive` + reduced-motion), Deck Snapshot polaroid, artifact stamping + skin-true share cards, attract-mode Now Playing empty stage, hero motion capture.
- Needle Drop: music-first first launch (kill the API-key-first tutorial), Ctrl+K zero-query resume row, ConfirmAction on destructive actions, Home honest loading, MixesView regen-churn fix, Q/Shift+Q queueing grammar (view-local, no TrackTable extraction).

**Explicitly deferred (judge-flagged risk):** TrackTable extraction (~700-line refactor of the 60k-track surface), auto-play during first scan, `newamp://` seed deep link (scheme collision with the internal audio protocol — needs its own scheme + security review).

## Stages

- **Stage 0 — Foundation (sequential):** split the 5,521-line index.css into modular files; add type/motion/shadow/radius/row-height tokens; global focus-visible; self-hosted fonts; color-scheme per skin; Steel AA fix; Tailwind var() bridge; single theme registry.
- **Stage 1 — Primitives:** ViewHeader/Eyebrow, Chip, EmptyState, ViewSkeleton, StatusToast, ConfirmAction, SVG icon additions.
- **Stage 2 — Fan-out (file-partitioned owners):** NowPlaying stage + truth-in-chrome; Library queueing + playing-row; Settings registry cards; catalog views; content views; chrome (Transport/Sidebar/TitleBar) + Resonance; Visualizer zero-hitch theming + Shift+S skin surf; deck snapshot; Wrapped stamping; first-run + palette.
- **Stage 3 — Harness:** shell × skin screenshot matrix (`craft:matrix`) + hero capture (built in parallel in a worktree).
- **Stage 4 — Verify:** typecheck, smoke battery subset, adversarial code review, matrix diff.
- **Stage 5 — Ship:** README rewrite (human-first, "for the nerds" section at bottom per Tyler), CHANGELOG, bump to 2.0.0, release:gate:local, publish per 1.17 precedent. Mac/Linux experimental Bit-Perfect lanes ride along in the tag.

## Frozen contracts (do not rename)

`.bevel-out .bevel-in .pxbtn .lcd-text .display .scanlines .nav-item .titlebar-drag`, `data-newamp-*` attributes, the 19 SKIN_VARIABLES, and all `--amp-*` Resonance variables (deliberately outside SKIN_VARIABLES). GL uniforms read skin vars by string — grep Visualizer.tsx before any token rename.

## Triage notes

- External PR #2 (orbisai0security) claims "API keys embedded in types.ts" — false positive: those are interface field *declarations*; the PR adds an unused Omit<> type. Not a blocker.
- Retro shell stays byte-identical as the density control; light skins (Steel/Terminal/Ice/Miami) get the shadow/contrast attention.
