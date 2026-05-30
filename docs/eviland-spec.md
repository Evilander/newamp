# Eviland — NewAmp flagship visualizer (design spec)

Eviland is NewAmp's flagship music visualizer: a **causal, frequency-true, structurally-aware** GPU reactor that renders the music as a living scene of its own instrumental voices. Named by Tyler. It sits NEXT TO butterchurn/MilkDrop (legacy kept), and is the new default flagship.

## The thesis (what makes it beat MilkDrop & everything else)
MilkDrop/butterchurn `bass/mid/treb` scalars cluster in the upper FFT register + auto-gain, so nearly every preset pulses on ONE shared envelope. Plexamp/Specterr/Synesthesia/Shadertoy all render on impoverished audio (Shadertoy = 1 FFT row). NOBODY fires distinct visual events from distinct frequency bands, NOBODY has structural memory, NOBODY anticipates the beat. Eviland does all three.

## Four pillars
1. **Causal living scene** — 24 mel-band onset bus → persistent visual VOICES (not blobs), each an instrument with a role:
   - kick→core (central spring mass + low shockwave), bass→terrain (bottom horizon line = bass env, curl-displaced),
   - snare→strike (off-center white burst + chromatic crack — driven by snare/hat ONLY, never bass),
   - hats→air (top-edge particulate, density = hat onset rate), vocal/lead→figure (mid-screen flowing SDF, vertical = vocal-band centroid contour, x = pan),
   - harmony/pads→atmosphere (feedback-field color wash, saturation = 1/flatness).
2. **Spatial truth** — frequency→vertical (low bottom, high top), pan→horizontal, so it reads like a felt spectrogram.
3. **Structural memory** — ring buffer of band-energy vectors → novelty curve (self-similarity) → section detection (verse/build/drop/chorus). Big transitions fire on STRUCTURE not beats. Section fingerprints → when a chorus RETURNS, reuse its seed/palette (visual rhyme). The moat.
4. **Anticipation** — kick inter-onset-interval → tempo+phase estimate → wind up ~80ms BEFORE the beat (negative perceived latency). Free-run when confidence low.

Four timescales layered: transient (onsets) / fast (envelopes) / slow (section mood) / song-scale (journey through flatness×centroid mood space → visual "biomes").

## Audio reactor (Part 1) — src/visualizer/eviland-audio.ts (pure TS, no WebGL)
- 24 mel-spaced bands (20Hz–16kHz, hzToMel=2595*log10(1+hz/700)), precomputed bin-range table, rectangular sum (no triangular — vanishes after threshold).
- Per band: half-wave-rectified spectral flux = Σ max(0, X_t[k]-X_{t-1}[k]); adaptive threshold = rolling mean(~1s/60fr) + 2σ; refractory 60–120ms → onset event {band, intensity, sharpness, t}.
- Semantic groups (OR of band onsets): kick(0–2 ~20–120Hz), bass(2–5), snareBody(5–9), snareCrack(14–18 ~2–5k), hihat(19–23 ~5–16k), vocalPresence(10–14 ~500–2k).
- Spectral features (broadband, smoothed): centroid(brightness→hue), flatness(tonal↔noisy→saturation/regime), crest(→bloom focus), rolloff.
- Stereo: needs L/R analysers (ADD to engine — see Part 0). width=rms(side)/rms(mid), pan=(rmsR-rmsL)/(rmsR+rmsL). Per-band pan ideal, broadband ok v1.
- Envelope followers, ASYMMETRIC (the alive-vs-seizure lever): env += k*(x-env), k = x>env ? attack : release. τ table:
  onset gates 1–5ms/100–200ms; bass-motion 10/250; vocal/mid 20/400; centroid-hue 50/800; width/pan 100/1500; tempo-conf 1000/3000.
- Tempo/phase: kick IOI histogram → BPM → phase = ((now-lastDownbeat)*bpm/60)%1. Self-contained, NO npm dep (avoid realtime-bpm-analyzer to keep deps clean). Free-run until confident.
- Structure: ring buffer ~2Hz of 24-band vectors; novelty = cosine distance(recent-avg, current); spike>thresh = boundary; store section fingerprint (mean band vec); cosine match to prior sections = return → reuse visual seed.
- Output: an event-bus object the renderer subscribes to, NOT raw FFT polling.

## Part 0 — engine stereo taps (src/audio/engine.ts) — LOAD-BEARING audio change, be careful
Origin engine has only `analyser` + `onsetAnalyser` (confirmed). ADD: ChannelSplitterNode off replayGain → leftAnalyser + rightAnalyser (fftSize 2048, smoothing 0), both → silentSink (keep-alive pattern, like existing). Expose getLeftFreqData(buf)/getRightFreqData(buf) (or getStereoData). Match existing getFreqData/getOnsetFreqData style. Do NOT alter the audible chain (masterGain→limiter→destination untouched).

## Renderer (Part 2) — src/visualizer/eviland.ts (WebGL2)
`createEvilandRenderer(canvas, opts) → EvilandRenderer | null` — MIRROR particle-flow.ts shape (compile/link helpers, resize/render/dispose, return null on unsupported). render(features, palette, dt).
- RGBA16F ping-pong feedback field. MUST gl.getExtension('EXT_color_buffer_float') first; sized internal format RGBA16F (not RGBA+FLOAT); CLAMP_TO_EDGE; check OES_texture_float_linear (fallback NEAREST). Never sample a texture bound as current attachment.
- Feedback pass: sample prev, *decay(0.985–0.998), curl-noise domain warp (2 octaves, 3 noise taps), + additive splats.
- Voices as SDF emitters: CPU spawns entity per confident onset (flux>mean+2σ), pool ≤32, cull on age. Ring SDF, hue per group from album palette (kick=DarkVibrant/red low, snare=LightVibrant/white off-center, hat=Vibrant/cyan top). THIS is where causal reactivity becomes visible.
- bass terrain horizon, vocal figure SDF, hat particulate (can reuse transform-feedback particles ~10k).
- Dual-Kawase bloom (4 down + 4 up, threshold→blur→additive — the cheap stunning glow; intensity slow-release env of energy+crest).
- Post: radial chromatic aberration driven by snareCrack+hihat ONLY (bass-driven = cliché), tone-map, vignette.
- Palette: reuse src/lib/albumColor.ts (dep-free, already on main) for base swatches; centroid→±30° hue excursion (slow); saturation from flatness; cross-fade 1.5s on track change.
- prefers-reduced-motion: disable shockwaves+aberration, keep slow color/glow only.

## Tiering (Tyler: ONE binary, runtime-tiered — no separate lite artifact)
Eviland returns null when WebGL2/float unavailable → Visualizer.tsx falls to butterchurn → canvas-2D MilkDrop. Throttle ladder under budget: RD/substeps→particles→resolution(1080→720→480)→bloom passes 4→2→disable aberration. Lite setting / software-renderer detection skips Eviland entirely. Visual identity survives all rungs.

## Wiring (Part 3)
4 mode lists MUST stay in sync: shared/types.ts VisualizerPreset, electron/settings.ts normalizeVisualizerPreset, src/components/Visualizer.tsx VizMode, src/components/FullscreenVisualizer.tsx PRESETS (rail + AUTO_VJ pools). New id: 'eviland' label "Eviland". Dispatch in Visualizer.tsx mode==='eviland' (mirror particle-flow block ~258). Make it the default visualizerPreset? (consider — maybe keep neon-waves default, eviland prominent in rail). Tier integration: high→full, medium→reduced, low/lite→skip to butterchurn.

## Definition of DONE (anti-spiral discipline)
v1 ships when: 24-band onset bus + ≥4 distinct voices visibly fire on distinct instruments; spatial truth (freq→vertical, pan→horizontal); structural memory detects ≥section boundaries and rhymes returns; light anticipation; feedback field+bloom+aberration render; capability-gated fallback to butterchurn works; typecheck 0/0; build green; live electron smoke proves non-blank + reactive + fallback. Deepening (RD substrate, per-band pan, full tempo lock, more biomes) = future, NOT v1 blockers. Ship as 1.7.0.

## Reuse / no-spiral rules
- Reuse: albumColor.ts (palette), particle-flow.ts (TF particle pattern + compile/link helpers as reference), createFrameGate/dprCap/maxPixels tier knobs in Visualizer.tsx, engine analyser API.
- NO new npm deps (write tempo + color ourselves). NO "pressure"/abstraction modules. Self-contained renderer module like particle-flow.
- Backup: main is at 1.6.2+reconcile (origin synced). Work on a branch; verify before merge.
