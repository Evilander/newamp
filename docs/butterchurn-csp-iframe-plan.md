# Butterchurn CSP iframe sandbox — deferred

## Context

1.5.2 relaxed the renderer CSP to add `'unsafe-eval'` to script-src so
Butterchurn's preset shader compiler can run (it parses MilkDrop preset math
via the Function constructor at preset load). The eval'd code only comes from
the locally-bundled `butterchurn-presets` package, but the relaxation applies
to the entire renderer, not just the visualizer subtree.

## The fix

Scope Butterchurn into a separate iframe with its own CSP that permits
`'unsafe-eval'` only for that frame. The main renderer can go back to
`script-src 'self'` and the visualizer becomes the only place where eval is
allowed.

## Sketch

1. **Iframe page** at `dist/butterchurn-iframe.html` with its own scoped CSP.
   The iframe loads butterchurn + butterchurn-presets via dynamic import.
2. **postMessage IPC** between parent (Visualizer.tsx) and iframe:
   - Parent → iframe: `{ kind: 'setPreset', preset: ButterchurnPreset }`
   - Parent → iframe: `{ kind: 'resize', width, height }`
   - Iframe → parent: `{ kind: 'ready' }`
3. **AudioContext sharing**: pass the AudioContext into the iframe via
   `OfflineAudioContext.audioWorklet`? Or stream PCM frames via SharedArrayBuffer?
   Either approach is significant work and would change the audio path's
   latency characteristics.
4. **Canvas transfer**: use `OffscreenCanvas.transferControlToOffscreen()` to
   hand the canvas to the iframe so the iframe owns rendering.

## Why deferred

- Audio routing is the hard part. Butterchurn needs access to live audio
  data. Splitting the audio graph across a frame boundary risks adding
  latency or losing access to the analyser.
- The current `'unsafe-eval'` relaxation is bounded: the only eval source is
  the bundled preset package, not the network (connect-src still restricts
  external fetches).
- Effort vs. risk: 1-2 days of careful work for a defense-in-depth measure
  that's already mitigated by other CSP directives.

## Triggers to revisit

- Adding any third-party preset / shader loader (would expand the eval surface).
- A user-loadable preset feature where presets come from disk paths the user
  controls (would mean user-supplied code lands in eval).
- A code audit finds an actual exploit path in the current CSP.

## Owner

Tyler to schedule. Tracked in CHANGELOG 1.5.3 as a known follow-up.
