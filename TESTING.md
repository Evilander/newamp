# NewAmp v1.7.3 — bug test pass

Verifying the bugs reported during the 1.6.x / 1.7.x work, by hand on the real
installed app. Status legend: ✅ user-verified · ⬜ not yet tested · ⚠️ issue found.

## Visualizer
- ⬜ **1. Right arrow / next-preset** — `→` `]` `›` advance; `←` `[` `‹` go back; preset name updates.
- ⬜ **2. Milkdrop lag between animations** — run Milkdrop several min; transitions shouldn't hitch.
- ⬜ **3. Reactivity (mids/highs, not just bass)** — vocals/hats/kick all move the visuals.
- ⬜ **4. Visualizer controls legible** — slim bar + ⚙ settings panel + `?` help, not cryptic pills.
- ⬜ **5. Eviland not a white/cream cloud** — v1.7.4 root-caused the gold/cream look to the post palette ramp collapsing bright regions to cream; now bright = true emitter hue, decay+curl cut for crisp shapes, kaleidoscope always-on, clean centre. Capture harness confirms discrete rings/core/terrain; **needs your eyes on real music** to confirm the feel.
- ⬜ **6. Album-art overlay visible on Eviland** — cover clearly shows (opacity 0.72).
- ⬜ **7. Five new shaders present** — Kaleido Bloom, Aurora Storm, Fractal Pulse, Starfield Warp, Spectral Tunnel.

## Library / playback
- ⬜ **8. Song rating ≠ album rating** — rating a song doesn't move the album rating, and vice versa.
- ✅ **9. Volume slider even across full travel** — VERIFIED by ear (Tyler, v1.7.3): "volume up seems more consistent rather than non-functional before." Perceptual cubic taper working.
- ⬜ **10. Folders → Albums no freeze / no stutter on large library** — folder nav snappy, no frozen state.
- ⬜ **11. Clickable artist/album names** — clicking artist/album in rows navigates.

## Notes / issues found
- (add specifics here as you test — e.g. "lag still on preset N", "Eviland too fast")
