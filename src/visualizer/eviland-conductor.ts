// Eviland conductor — reads the song score against the playback clock.
//
// The reactor (eviland-audio.ts) can only describe audio that has already
// happened. When the playing track has a score (eviland-score.ts), the
// conductor stamps each frame with what the song is about to do:
//
//   - section changes arrive ON the bar line, carrying the tier of the section
//     that is STARTING (the live estimator picks a look for the chorus from how
//     loud the verse was, a few seconds late)
//   - sections that repeat share an id, so a chorus gets its look back however
//     the listener got there — played through, skipped ahead, or seeked back
//   - the beat phase and the beat clock come from the analysed grid, not from
//     guessing the tempo out of the last few kicks
//   - through a build, `anticipation` climbs; in the held silence before a
//     drop, `blackout` rises; when the drop lands, `impact` fires on the
//     downbeat itself
//   - `keyShift` follows the song's modulations around the circle of fifths
//
// Without a score (streams, podcasts, tracks still being analysed, anything
// under 20 seconds) conduct() leaves the frame exactly as the reactor made it.
//
// Pure TS, no DOM. One ScoreCues object is reused across frames, so the hot
// path allocates nothing.

import type { EvilandFrame, ScoreCues } from './eviland-audio';
import type { EvilandDynamics } from './eviland-operators';
import type { ScoreSection, SongScore } from './eviland-score';

export interface Conductor {
  /** Bind the score for the track now playing, or null when it has none. */
  setScore(score: SongScore | null): void;
  hasScore(): boolean;
  /**
   * Stamp cues for playback position `seconds` onto `frame` and return it.
   * Call once per analysed frame, before the Director sees the frame.
   */
  conduct(frame: EvilandFrame, seconds: number, dtMs: number): EvilandFrame;
}

/** Clamp to 0..1; NaN reads as 0, so a cue that is not a number is no cue. */
function unit(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0;
}

const NO_CUE_GAIN = { output: 1, saturation: 1 } as const;
const cueGainScratch = { output: 1, saturation: 1 };

/**
 * What the cues do to a look, shared by the engine and the Live pipeline so a
 * build feels the same in both. Mutates `dyn` (already evaluated for this
 * frame) and returns the output gain + saturation for the final pass.
 *
 *   build     the field is drawn inward and its trails lengthen, rotation
 *             winds up, event sources thin out, the picture dims and greys
 *   blackout  everything the look emits is cut for the held beat
 *   impact    the field bursts outward, bloom and events surge, the output
 *             flashes — then all of it decays with the cue
 */
export function applyScoreCues(dyn: EvilandDynamics, cues: ScoreCues | undefined): { output: number; saturation: number } {
  if (!cues) return NO_CUE_GAIN;
  const build = unit(cues.anticipation);
  const hit = unit(cues.impact);
  const blackout = unit(cues.blackout);
  if (build > 0) {
    dyn.zoom -= 0.012 * build;
    dyn.decay = Math.min(0.985, dyn.decay + 0.035 * build);
    dyn.rotate *= 1 + 0.9 * build;
    dyn.emitterGain *= 1 - 0.55 * build;
    dyn.waveIntensity *= 1 - 0.4 * build;
  }
  if (hit > 0) {
    dyn.zoom += 0.04 * hit;
    dyn.bloom += 0.9 * hit;
    dyn.emitterGain *= 1 + 1.2 * hit;
    dyn.emitterScale *= 1 + 0.6 * hit;
  }
  const dark = 1 - blackout;
  dyn.emitterGain *= dark;
  dyn.waveIntensity *= dark;
  cueGainScratch.output = (1 - 0.45 * build) * (1 - 0.94 * blackout) * (1 + 1.5 * hit);
  cueGainScratch.saturation = 1 - 0.4 * build;
  return cueGainScratch;
}

/** Below this the analysed beat grid is not trusted over the live estimate. */
const MIN_GRID_CONFIDENCE = 0.35;
/** Below this the bar phase is a guess, and the pulse falls on every beat rather than a bar line of unknown truth. */
const MIN_DOWNBEAT_CONFIDENCE = 0.2;
/** A build weaker than this gets a crossfade, not a cut-and-flash. */
const MIN_IMPACT_STRENGTH = 0.3;
const IMPACT_DECAY_SECONDS = 0.9;
const KEY_GLIDE_SECONDS = 1.2;
// 20° of hue per step round the circle of fifths, capped at five steps: a
// modulation should read as the same palette travelling, not a new skin. Five
// reaches the semitone lift of a final chorus (+7 fifths, i.e. −5) uncut.
const TURNS_PER_FIFTH = 1 / 18;
const MAX_KEY_STEPS = 5;
/** However long the silence is, the screen is only held dark for this long. */
const MAX_BLACKOUT_SECONDS = 1.2;
/** A position change larger than this between frames is a seek, not playback. */
const SEEK_JUMP_SECONDS = 1.5;

export function createConductor(): Conductor {
  let score: SongScore | null = null;
  // Where each section's LOOK should start changing. A section that lands
  // with a build cuts on its downbeat; the rest start their crossfade a beat
  // early so the blend is centred on the bar line instead of trailing it.
  let lookStarts: number[] = [];
  // Sections that repeat each other share the index of the first one.
  let stableIds: number[] = [];
  let gridTrusted = false;

  let lastSeconds = -1;
  let lastSection = -1;
  let beatIndex = 0;
  let impact = 0;
  let keyShift = 0;

  const cues: ScoreCues = {
    anticipation: 0,
    blackout: 0,
    impact: 0,
    impactStart: false,
    tier: 'steady',
    keyShift: 0,
    arc: 0,
    downbeat: false,
    toBoundary: Infinity,
  };

  function lands(section: ScoreSection): boolean {
    return !!section.build && section.build.strength >= MIN_IMPACT_STRENGTH;
  }

  function sectionAt(seconds: number): number {
    let index = 0;
    for (let k = 1; k < lookStarts.length; k++) {
      if (seconds >= lookStarts[k]!) index = k;
      else break;
    }
    return index;
  }

  return {
    setScore(next) {
      score = next && next.sections.length > 0 ? next : null;
      lookStarts = [];
      stableIds = [];
      lastSeconds = -1;
      lastSection = -1;
      beatIndex = 0;
      impact = 0;
      keyShift = 0;
      gridTrusted = false;
      if (!score) return;
      gridTrusted = score.beatConfidence >= MIN_GRID_CONFIDENCE && score.beats.length >= 8;
      const beatSeconds = score.bpm > 1 ? 60 / score.bpm : 0.5;
      const firstOfLabel = new Map<number, number>();
      score.sections.forEach((section, k) => {
        lookStarts.push(k === 0 || lands(section) ? section.start : Math.max(0, section.start - beatSeconds));
        if (!firstOfLabel.has(section.label)) firstOfLabel.set(section.label, k);
        stableIds.push(firstOfLabel.get(section.label)!);
      });
    },

    hasScore() {
      return score !== null;
    },

    conduct(frame, seconds, dtMs) {
      if (!score || !Number.isFinite(seconds) || seconds < 0 || seconds > score.duration + 0.5) {
        // Past the scored part of a very long track, or no score at all: the
        // live estimators own the frame again.
        if (frame.score) frame.score = undefined;
        lastSeconds = -1;
        lastSection = -1;
        return frame;
      }
      const dt = Number.isFinite(dtMs) ? Math.max(0, Math.min(0.25, dtMs / 1000)) : 1 / 60;
      const seeked = lastSeconds < 0 || seconds < lastSeconds - 0.05 || seconds - lastSeconds > SEEK_JUMP_SECONDS;

      // ── Sections ─────────────────────────────────────────────────────────
      const index = sectionAt(seconds);
      const section = score.sections[index]!;
      const stableId = stableIds[index]!;
      const changed = index !== lastSection;
      frame.sectionId = stableId;
      frame.sectionChanged = changed;
      frame.sectionReturn = changed && stableId !== index ? stableId : -1;
      if (changed && !seeked) {
        // The visual-memory bridge fingerprints the section that just ENDED.
        // Only when it was played through: scrubbing across boundaries must
        // not teach the track's memory sections nobody listened to.
        const ended = lastSection >= 0 ? score.sections[lastSection] : undefined;
        frame.sectionFingerprint = ended ? Float32Array.from(ended.fingerprint) : null;
      } else {
        frame.sectionFingerprint = null;
      }

      // ── Beat grid ────────────────────────────────────────────────────────
      let downbeat = false;
      if (gridTrusted) {
        const beats = score.beats;
        const beatsPerBar = score.beatsPerBar ?? 4;
        const previousBeat = beatIndex;
        if (seeked || seconds < beats[beatIndex]!) beatIndex = 0;
        while (beatIndex + 1 < beats.length && beats[beatIndex + 1]! <= seconds) beatIndex++;
        const from = beats[beatIndex]!;
        const to = beats[beatIndex + 1] ?? from + 60 / Math.max(1, score.bpm);
        if (seconds >= from) {
          frame.beatPhase = Math.min(0.999, (seconds - from) / Math.max(0.05, to - from));
          frame.bpm = 60 / Math.max(0.05, to - from);
          frame.beatConfidence = Math.max(frame.beatConfidence, score.beatConfidence);
          // Counted from the analysed downbeat, so bar lines sit on multiples
          // of beatsPerBar; it jumps only with a seek.
          frame.beatClock = beatIndex - score.downbeat + frame.beatPhase;
        }
        if (!seeked && beatIndex !== previousBeat) {
          // Bars from the analysed downbeat. When the bar phase is unsure
          // every beat pulses instead: a look change on a beat reads right, a
          // bar line that is wrong three times in four does not.
          downbeat = score.downbeatConfidence < MIN_DOWNBEAT_CONFIDENCE
            || (((beatIndex - score.downbeat) % beatsPerBar) + beatsPerBar) % beatsPerBar === 0;
        }
      }

      // ── The lead-in to the NEXT section ──────────────────────────────────
      const next = score.sections[index + 1];
      let anticipation = 0;
      let blackout = 0;
      if (next?.build) {
        const build = next.build;
        const silenceAt = next.start - Math.min(build.gapSeconds, MAX_BLACKOUT_SECONDS);
        const rampFrom = next.start - build.seconds;
        if (seconds >= rampFrom && seconds < next.start) {
          const progress = Math.min(1, (seconds - rampFrom) / Math.max(0.1, silenceAt - rampFrom));
          // Slow start, steep finish: tension is felt most in the last bar.
          anticipation = progress * progress * unit(build.strength);
          if (build.gapSeconds > 0 && seconds >= silenceAt) blackout = Math.min(1, (seconds - silenceAt) / 0.04);
        }
      }

      // ── Impact: a built-up section landing, on its own downbeat ──────────
      const landed = changed && !seeked && lastSection >= 0 && index === lastSection + 1 && lands(section);
      if (landed) impact = unit(section.build!.strength);
      else impact *= Math.exp(-dt / IMPACT_DECAY_SECONDS);
      if (seeked) impact = 0;
      if (impact < 0.004) impact = 0;

      // ── Harmonic colour ──────────────────────────────────────────────────
      const wantedShift = (Number.isFinite(section.keyShift) ? Math.max(-MAX_KEY_STEPS, Math.min(MAX_KEY_STEPS, section.keyShift)) : 0) * TURNS_PER_FIFTH;
      keyShift = seeked ? wantedShift : keyShift + (wantedShift - keyShift) * (1 - Math.exp(-dt / KEY_GLIDE_SECONDS));

      cues.anticipation = anticipation;
      cues.blackout = blackout;
      cues.impact = impact;
      cues.impactStart = landed;
      cues.tier = section.tier;
      cues.keyShift = keyShift;
      cues.arc = Math.min(1, seconds / Math.max(1, score.duration));
      cues.downbeat = downbeat;
      cues.toBoundary = next ? Math.max(0, next.start - seconds) : Infinity;
      frame.score = cues;

      lastSeconds = seconds;
      lastSection = index;
      return frame;
    },
  };
}
