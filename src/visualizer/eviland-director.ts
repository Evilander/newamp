// Eviland AI Director.
//
// The Director is the autonomous conductor that turns the random-but-beautiful
// OperatorConfigs minted by the randomizer into a MUSICAL ARC. The renderer
// already reacts to instruments frame-by-frame; the Director operates at the
// song-structure timescale: it picks a NEW look at each section boundary, but
// RECALLS the same look when a section returns (so a chorus visually rhymes
// with its earlier appearance), and CROSSFADES between looks across a few
// beats so transitions feel intentional rather than jump-cut.
//
// Energy tiers (calm/steady/lift/drop/climax) bias archetype + intensity, so
// an ambient intro gets a gentle nebula with low mirrorMix and slow hue cycle,
// while a drop gets a kaleidoscope or tunnel with bright waveform and high
// mirrorMix. The tier is derived from a slow moving average of energy plus a
// novelty pulse, so the Director feels the song's shape, not just its loudness.
//
// Everything is deterministic from (songId, sectionId): the same song always
// gets the same sequence of looks. The platform RNG / clock is never read.
//
// Zero dependencies, ES modules. The renderer owns the loop; the Director
// returns the OperatorConfig the renderer should use this frame.

import type { EvilandFrame } from './eviland-audio';
import {
  type OperatorConfig,
  cloneConfig,
  defaultConfig,
  lerpConfig,
} from './eviland-operators';
import {
  ARCHETYPES,
  type Archetype,
  generate,
  mutate,
} from './eviland-randomizer';
import { Rng, hashSeed } from './eviland-rng';

// ---------------------------------------------------------------------------
// Energy tiers — how the Director categorises a section's emotional weight.
// ---------------------------------------------------------------------------

export type EnergyTier = 'calm' | 'steady' | 'lift' | 'drop' | 'climax';

/**
 * Per-tier archetype weights. Each tier biases toward archetypes that suit its
 * character. Every archetype keeps a small non-zero weight so the Director
 * never feels locked into one look family within a tier.
 */
const TIER_ARCHETYPE_WEIGHTS: Record<EnergyTier, Record<Archetype, number>> = {
  calm: {
    nebula: 5,
    liquid: 3,
    kaleidoscope: 1,
    tunnel: 0.5,
    lattice: 0.3,
    strobe: 0.1,
  },
  steady: {
    liquid: 3,
    kaleidoscope: 3,
    nebula: 2,
    tunnel: 2,
    lattice: 1.5,
    strobe: 0.5,
  },
  lift: {
    tunnel: 3,
    kaleidoscope: 3,
    liquid: 2,
    lattice: 2,
    nebula: 1,
    strobe: 1,
  },
  drop: {
    kaleidoscope: 4,
    tunnel: 4,
    lattice: 3,
    strobe: 2,
    liquid: 1,
    nebula: 0.5,
  },
  climax: {
    strobe: 4,
    kaleidoscope: 4,
    tunnel: 3,
    lattice: 2,
    liquid: 0.8,
    nebula: 0.4,
  },
};

/**
 * How aggressively `mutate()` perturbs a freshly generated config to match the
 * tier's intensity. Calm tiers get a soft tone-down, climax gets a punch-up.
 * 0 means "use the generator output unchanged".
 */
const TIER_MUTATE_AMOUNT: Record<EnergyTier, number> = {
  calm: 0.18,
  steady: 0.1,
  lift: 0.12,
  drop: 0.22,
  climax: 0.3,
};

/**
 * Transition speed multiplier per tier delta. A jump from calm->climax should
 * snap faster than a glide from steady->lift. Values are multipliers on the
 * configured `transitionBeats`.
 */
function transitionSpeedFor(prev: EnergyTier | null, next: EnergyTier): number {
  if (!prev) return 1;
  const rank: Record<EnergyTier, number> = { calm: 0, steady: 1, lift: 2, drop: 3, climax: 4 };
  const delta = Math.abs(rank[next] - rank[prev]);
  if (delta >= 3) return 2.5; // big jump -> snap
  if (delta === 2) return 1.6;
  if (delta === 1) return 1.1;
  return 0.85; // same tier -> glide
}

// ---------------------------------------------------------------------------
// Timer-rotation + drift tuning (MilkDrop-like variety floor).
// ---------------------------------------------------------------------------

/** Default ms between forced look rotations when structure stays quiet. */
const ROTATE_INTERVAL_MS = 20000;
/** Default deterministic ±jitter on the rotation interval so it isn't metronomic. */
const ROTATE_JITTER_PCT = 0.15;

// ---------------------------------------------------------------------------
// Director options + state
// ---------------------------------------------------------------------------

export interface DirectorOptions {
  /** Stable identifier for the song; seeds all generation. Defaults to "song". */
  songId?: string;
  /** Beats over which a new section's config crossfades in. Defaults to ~2. */
  transitionBeats?: number;
  /** Fallback transition duration in ms when BPM is unknown. Defaults to 1800. */
  transitionMsFallback?: number;
  /** Initial config to display before any section fires. Defaults to defaultConfig(). */
  initial?: OperatorConfig;
  /** Director starts enabled. Set false for passthrough mode. */
  enabled?: boolean;
  /** ms between forced "timer" look rotations when no section boundary fires. Default 20000. 0 disables. */
  rotateMs?: number;
  /** Deterministic ±jitter fraction on the rotation interval (0..0.9). Default 0.15. */
  rotateJitterPct?: number;
}

export interface Director {
  /** Advance the director one frame; returns the config the renderer should use. */
  update(frame: EvilandFrame, dtMs: number): OperatorConfig;
  /** Enable/disable autonomous control. When off, update() returns the passthrough. */
  setEnabled(on: boolean): void;
  /** Is the director currently driving the look? */
  isEnabled(): boolean;
  /** Reset section memory and re-arm. Optionally rebind to a new songId. */
  reset(songId?: string): void;
  /** The active config (post-crossfade) — what update() most recently returned. */
  current(): OperatorConfig;
  /** Override the passthrough config (used when disabled, or as the "from" of next fade). */
  setCurrent(config: OperatorConfig): void;
}

interface SectionMemory {
  config: OperatorConfig;
  tier: EnergyTier;
}

export function createDirector(opts: DirectorOptions = {}): Director {
  const songId = opts.songId ?? 'song';
  const transitionBeats = Math.max(0.25, opts.transitionBeats ?? 2);
  const transitionMsFallback = Math.max(150, opts.transitionMsFallback ?? 1800);
  const initial = opts.initial ? cloneConfig(opts.initial) : defaultConfig();
  const rotateMs = Math.max(0, opts.rotateMs ?? ROTATE_INTERVAL_MS);
  const rotateJitterPct = Math.max(0, Math.min(0.9, opts.rotateJitterPct ?? ROTATE_JITTER_PCT));

  // ── core state ────────────────────────────────────────────────────────────
  let enabled = opts.enabled !== false;
  let activeSongId = songId;

  // The config the renderer is currently being given (post-crossfade).
  let live: OperatorConfig = cloneConfig(initial);
  // The look we're heading toward; equal to `live` when no fade in flight.
  let target: OperatorConfig = cloneConfig(initial);
  // The look we're fading from; snapshot taken when the fade starts.
  let from: OperatorConfig = cloneConfig(initial);

  // Crossfade progress 0..1. 1 = fully on target.
  let fade = 1;
  // The total duration of the in-flight fade in ms (locked at start so a
  // mid-fade BPM change doesn't warp progress).
  let fadeDurationMs = transitionMsFallback;

  // Section memory: sectionId -> stored config + tier.
  const sections = new Map<number, SectionMemory>();
  let lastSectionId = -1;
  let lastTier: EnergyTier | null = null;

  // Timer-rotation floor: ms since the last look switch, and a monotonic
  // rotation counter (reset on a real section boundary) folded into the seed
  // so forced looks are deterministic in sequence but vary each rotation.
  let msSinceSwitch = 0;
  let rotationIndex = 0;
  // Cached rotation threshold (depends only on rotationIndex); recomputed lazily
  // when invalidated so the 60fps steady path does no per-frame allocation.
  let cachedRotateThresholdMs: number | null = null;

  // Slow-moving energy + novelty trackers used to derive tier.
  let energyAvg = 0;
  let energyPeak = 0;
  let noveltyAccum = 0;
  let framesSinceSection = 0;

  // ── helpers ───────────────────────────────────────────────────────────────

  function tierFor(frame: EvilandFrame): EnergyTier {
    // Use the slow average so a single loud frame doesn't promote us to climax,
    // but blend in the in-section peak so an obvious drop still registers fast.
    const sustained = energyAvg;
    const peak = energyPeak;
    const novelty = Math.min(1, noveltyAccum);
    // beatConfidence helps separate "drop" (groove locked + loud) from "climax"
    // (loud regardless of groove — orchestral swell, vocal belt, etc.).
    const grooved = frame.beatConfidence;

    if (sustained < 0.18 && peak < 0.35) return 'calm';
    if (sustained < 0.32 && peak < 0.55) return 'steady';
    if (sustained < 0.5 && peak < 0.75) return novelty > 0.4 ? 'lift' : 'steady';
    if (peak >= 0.78 && grooved > 0.55) return 'drop';
    if (peak >= 0.82) return 'climax';
    return 'lift';
  }

  function seedFor(sectionId: number, rotation = 0): number {
    // Per-(song, section, rotation) deterministic seed. rotation 0 keeps the
    // original key so a song's first look per section is unchanged; forced
    // timer rotations (rotation > 0) derive distinct looks.
    const key =
      rotation === 0
        ? `${activeSongId}::section::${sectionId}`
        : `${activeSongId}::section::${sectionId}::r${rotation}`;
    return hashSeed(key);
  }

  function generateForSection(sectionId: number, tier: EnergyTier, rotation = 0): OperatorConfig {
    const baseSeed = seedFor(sectionId, rotation);
    const rng = new Rng(baseSeed);
    const weights = TIER_ARCHETYPE_WEIGHTS[tier];
    const archetype = rng.weighted(
      ARCHETYPES as readonly Archetype[],
      ARCHETYPES.map((a) => weights[a] ?? 0),
    );
    // Generate from a derived seed so the (tier, archetype) pick doesn't burn
    // the randomizer's draws; the look itself depends only on the seed.
    const lookSeed = (baseSeed ^ 0x9e3779b1) >>> 0;
    const { config } = generate(lookSeed, archetype);

    // Tier-driven intensity: nudge with a deterministic mutate seeded by the
    // section, so re-running the same song gets the same nudge.
    const amount = TIER_MUTATE_AMOUNT[tier];
    const mutateSeed = (baseSeed ^ 0x85ebca6b) >>> 0;
    const tuned = amount > 0 ? mutate(config, amount, mutateSeed) : config;
    // Stamp section info onto the config for downstream tooling/UI.
    tuned.name = `${tuned.archetype ?? 'look'} • s${sectionId} • ${tier}`;
    return tuned;
  }

  function effectiveRotateMs(): number {
    if (rotateMs <= 0) return Infinity;
    if (cachedRotateThresholdMs === null) {
      // Deterministic jitter for the *next* rotation so the cadence varies but
      // replays identically. Cached until rotationIndex changes.
      const r = new Rng(hashSeed(`${activeSongId}::rot::${rotationIndex + 1}`));
      const signed = (r.next() * 2 - 1) * rotateJitterPct;
      cachedRotateThresholdMs = rotateMs * (1 + signed);
    }
    return cachedRotateThresholdMs;
  }

  function onForcedRotation(frame: EvilandFrame): void {
    rotationIndex++;
    cachedRotateThresholdMs = null;
    const tier = tierFor(frame);
    const nextConfig = generateForSection(frame.sectionId, tier, rotationIndex);
    // Forced rotations deliberately do NOT write the `sections` recall map or
    // touch the audio sectionId — chorus recall stays driven by
    // frame.sectionReturn, which forced rotations never set.
    const speed = transitionSpeedFor(lastTier, tier);
    startFade(nextConfig, speed, frame.bpm);
    lastTier = tier;
  }

  function startFade(next: OperatorConfig, speedMul: number, bpm: number): void {
    // Snapshot the live config as the new "from"; the current fade progress
    // collapses into that snapshot (because live IS the lerp(from,target,fade)
    // we just produced last frame), so the new fade starts from where the eye
    // already is — no visual jump.
    from = cloneConfig(live);
    target = cloneConfig(next);
    fade = 0;
    const beatMs = bpm > 1 ? 60000 / bpm : 0;
    const beats = transitionBeats / Math.max(0.25, speedMul);
    fadeDurationMs = beatMs > 0 ? beatMs * beats : transitionMsFallback / Math.max(0.25, speedMul);
    // Reset the timer-rotation clock on every switch (section- or timer-driven).
    msSinceSwitch = 0;
  }

  function onSectionBoundary(frame: EvilandFrame): void {
    const tier = tierFor(frame);

    let nextConfig: OperatorConfig;
    if (frame.sectionReturn >= 0 && sections.has(frame.sectionReturn)) {
      // Returning section — recall the stored look so the chorus visually
      // rhymes with its previous appearance. Re-stamp the current sectionId
      // into the memory map so any second return hits this same look.
      const stored = sections.get(frame.sectionReturn)!;
      nextConfig = cloneConfig(stored.config);
      sections.set(frame.sectionId, { config: cloneConfig(nextConfig), tier: stored.tier });
    } else {
      nextConfig = generateForSection(frame.sectionId, tier);
      sections.set(frame.sectionId, { config: cloneConfig(nextConfig), tier });
    }

    const speed = transitionSpeedFor(lastTier, tier);
    startFade(nextConfig, speed, frame.bpm);

    lastTier = tier;
    // Reset in-section trackers so the next tier estimate is based on fresh
    // material, not bleed-through from the prior section.
    energyPeak = 0;
    noveltyAccum = 0;
    framesSinceSection = 0;
    // A real structural change resets the timer cadence — structure leads.
    rotationIndex = 0;
    cachedRotateThresholdMs = null;
  }

  function advanceFade(frame: EvilandFrame, dtMs: number): void {
    if (fade >= 1) return;
    // Prefer beat-phase progress when a beat is locked — fades land on a beat.
    // Otherwise fall back to wall-clock dt so silent / arrhythmic passages
    // still resolve their fades.
    const dt = Math.max(0, Math.min(250, dtMs));
    let step: number;
    if (frame.bpm > 1 && frame.beatConfidence > 0.35 && fadeDurationMs > 0) {
      step = dt / fadeDurationMs;
    } else {
      step = dt / Math.max(150, fadeDurationMs);
    }
    fade = Math.min(1, fade + step);
  }

  function recomputeLive(): void {
    if (fade >= 1) {
      // Steady state (the ~99% of frames between section boundaries): return the
      // owned `target` by reference. No per-frame clone — `target`/`from` are only
      // ever reassigned to fresh clones in startFade/reset/setCurrent and are never
      // mutated in place, and the renderer treats the config as read-only. Cloning
      // here every frame was the dominant GC source behind the "laggy visualizer".
      live = target;
    } else if (fade <= 0) {
      live = from;
    } else {
      // Smoothstep gives an ease-in/out feel — much more musical than linear.
      // lerpConfig allocates, but only during the brief beat-synced crossfade.
      const t = fade * fade * (3 - 2 * fade);
      live = lerpConfig(from, target, t);
    }
  }

  // Prime the first frame so callers see `current()` even before update().
  recomputeLive();

  // ── public API ────────────────────────────────────────────────────────────

  return {
    update(frame, dtMs): OperatorConfig {
      if (!enabled) {
        // Passthrough — keep section memory dormant; the externally provided
        // `live` (via setCurrent) is what we show.
        return live;
      }

      // Track in-section energy & novelty for tier estimation.
      framesSinceSection++;
      // EMA on energy. Time constant ~2s @ 60fps -> alpha ≈ 0.008/ms * dt.
      const dt = Math.max(0, Math.min(250, dtMs));
      const alpha = 1 - Math.exp(-dt / 2000);
      energyAvg += (frame.energy - energyAvg) * alpha;
      if (frame.energy > energyPeak) energyPeak = frame.energy;
      // Novelty accumulates with decay, peaks ~1.
      noveltyAccum = Math.min(1, noveltyAccum * 0.985 + frame.novelty * 0.05);

      if (frame.sectionChanged && frame.sectionId !== lastSectionId) {
        lastSectionId = frame.sectionId;
        onSectionBoundary(frame);
      } else if (lastSectionId < 0 && framesSinceSection === 1) {
        // First-ever update on a brand-new song: don't wait for the first
        // section boundary (which can take 6+ seconds) to start adapting —
        // generate an opening look immediately based on the priming tier.
        const tier = tierFor(frame);
        const nextConfig = generateForSection(frame.sectionId, tier);
        sections.set(frame.sectionId, { config: cloneConfig(nextConfig), tier });
        lastSectionId = frame.sectionId;
        lastTier = tier;
        startFade(nextConfig, 1, frame.bpm);
      }

      advanceFade(frame, dtMs);

      // Timer floor: if structure hasn't changed the look in a while, force a
      // fresh rotation (MilkDrop-style). Only when settled, never mid-fade.
      msSinceSwitch += dt;
      if (rotateMs > 0 && fade >= 1 && msSinceSwitch >= effectiveRotateMs()) {
        onForcedRotation(frame);
        advanceFade(frame, dtMs);
      }

      recomputeLive();
      return live;
    },

    setEnabled(on): void {
      enabled = !!on;
    },

    isEnabled(): boolean {
      return enabled;
    },

    reset(nextSongId?: string): void {
      if (nextSongId) activeSongId = nextSongId;
      sections.clear();
      lastSectionId = -1;
      lastTier = null;
      energyAvg = 0;
      energyPeak = 0;
      noveltyAccum = 0;
      framesSinceSection = 0;
      msSinceSwitch = 0;
      rotationIndex = 0;
      cachedRotateThresholdMs = null;
      // Collapse any in-flight fade to the current live config so we don't
      // start the next song mid-blend with the previous one.
      from = cloneConfig(live);
      target = cloneConfig(live);
      fade = 1;
      fadeDurationMs = transitionMsFallback;
    },

    current(): OperatorConfig {
      return live;
    },

    setCurrent(config): void {
      // External override (e.g. user picked a preset, or the Director is
      // disabled and the host is feeding configs through). Snap state so the
      // next enabled update() doesn't lurch back to the prior look.
      live = cloneConfig(config);
      from = cloneConfig(config);
      target = cloneConfig(config);
      fade = 1;
    },
  };
}
