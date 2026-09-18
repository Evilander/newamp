// @eviland/core — the public API surface.
//
// Eviland is an instrument-aware, self-directing generative music visual engine.
// It is framework-agnostic and dependency-free: give it an HTMLCanvasElement and
// per-frame audio data (frequency + time-domain Uint8Arrays, e.g. from a Web
// Audio AnalyserNode), and it renders. The same engine powers NewAmp.
//
// Pipeline:
//   audio bytes ──► reactor.analyze() ──► EvilandFrame
//   EvilandFrame ──► (optional) director.update() / randomizer.generate()
//                 ──► renderer.setConfig() + renderer.setWaveform()
//   renderer.render(frame, palette, dtMs) ──► canvas
//
// See README.md for a 20-line embedding example.

// ── Renderer (WebGL2) ──────────────────────────────────────────────────────
export {
  createEvilandRenderer,
  type EvilandRenderer,
  type EvilandPalette,
  type EvilandOptions,
} from './eviland';

// ── Reactor (24-band causal onset detection) ───────────────────────────────
export {
  createEvilandReactor,
  EVILAND_BANDS,
  type EvilandReactor,
  type EvilandReactorConfig,
  type EvilandFrame,
  type EvilandOnset,
  type VoiceGroup,
} from './eviland-audio';

// ── Song score + conductor (whole-track look-ahead) ────────────────────────
// Optional. Decode a track to mono PCM at SONG_SCORE_SAMPLE_RATE, run
// computeSongScore once, then call conductor.conduct(frame, positionSeconds,
// dtMs) before director.update() each frame. Frames then carry `score` cues
// and the Director and renderer act on the song's structure ahead of time.
export {
  computeSongScore,
  isValidSongScore,
  SONG_SCORE_VERSION,
  SONG_SCORE_SAMPLE_RATE,
  SONG_SCORE_MAX_SECONDS,
  type SongScore,
  type ScoreSection,
  type ScoreBuild,
  type ScoreKey,
  type ScoreTier,
  type ComputeScoreOptions,
} from './eviland-score';
export { createConductor, applyScoreCues, type Conductor } from './eviland-conductor';
export type { ScoreCues } from './eviland-audio';

// ── Operator engine (data-driven, serializable looks) ──────────────────────
export {
  evalConfig,
  createDynamics,
  defaultConfig,
  cloneConfig,
  lerpConfig,
  type OperatorConfig,
  type CompositionConfig,
  type WaveOverride,
  applyWaveformOverride,
  type EvilandDynamics,
  type Channel,
  type Binding,
  type AudioFeature,
  type Curve,
  type WaveformConfig,
  type WaveMode,
  type PaletteConfig,
  type RGB,
  type FrameLike,
  type QSlot,
  type QLfo,
  type LfoShape,
} from './eviland-operators';

// ── Deterministic RNG + shareable seed codes ───────────────────────────────
export {
  Rng,
  mulberry32,
  hashSeed,
  toSeedState,
  encodeSeedCode,
  decodeSeedCode,
} from './eviland-rng';

// ── Randomizer (generative looks from a seed) ──────────────────────────────
export {
  generate,
  mutate,
  encode,
  decode,
  classic,
  ARCHETYPES,
  type Archetype,
  type GenerateResult,
} from './eviland-randomizer';

// ── Director (autonomous conductor) ────────────────────────────────────────
export {
  createDirector,
  type Director,
  type DirectorOptions,
  type EnergyTier,
} from './eviland-director';

// ── Recorder (canvas + audio → WebM) ───────────────────────────────────────
export {
  createCanvasRecorder,
  CanvasRecorderError,
  type CanvasRecorder,
  type CanvasRecorderOptions,
  type CanvasRecorderErrorCode,
} from './eviland-recorder';
