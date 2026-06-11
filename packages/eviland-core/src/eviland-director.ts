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
// Look generation is deterministic from (songId, sectionId, rotationIndex)
// PLUS a lineage salt (lineage.generation, lineage.rootSeed) when the track has
// a loaded VisualMemoryPlan with generation > 0. At generation 0 the lineage
// salt is empty and the seed key is byte-identical to the pre-memory format —
// a plan-less or first-play track renders exactly the same as before. The
// platform RNG is never read. THREE timing inputs follow the playback clock by
// design: the ~20s timer-rotation floor (so the look still changes when the
// music is structurally quiet, MilkDrop-style), the gentle intra-section
// drift, and a bounded priming-defer window (deferPrimingFrames) that lets the
// Visualizer ask the Director to hold its first-ever fresh-mint until a
// loadPlan() call arrives OR a small frame budget expires (finding #9 from
// the pre-release review). The defer fixes the "first ~500ms of a known song
// renders a fresh-mint look under the WRONG lineage, then snaps to the right
// look when the async loadOrSeed lands" race; with deferPrimingFrames=0 the
// Director's behavior is byte-identical to the pre-defer code.
//
// Zero dependencies, ES modules. The renderer owns the loop; the Director
// returns the OperatorConfig the renderer should use this frame.

import type { EvilandFrame } from './eviland-audio';
import {
  type OperatorConfig,
  cloneConfig,
  defaultConfig,
  lerpConfig,
  lerpConfigInto,
} from './eviland-operators';
import {
  ARCHETYPES,
  type Archetype,
  generate,
  mutate,
} from './eviland-randomizer';
import { Rng, hashSeed } from './eviland-rng';
import {
  VISUAL_MEMORY_ALGO_VERSION,
  type VisualMemoryLineage,
  type VisualMemoryPlan,
  type VisualMemorySection,
} from './eviland-memory-types';

// ---------------------------------------------------------------------------
// Energy tiers — how the Director categorises a section's emotional weight.
// ---------------------------------------------------------------------------

export type EnergyTier = 'calm' | 'steady' | 'lift' | 'drop' | 'climax';

/**
 * Per-tier archetype weights. Each tier biases toward archetypes that suit its
 * character. Every archetype keeps a small non-zero weight so the Director
 * never feels locked into one look family within a tier — and every tier hits
 * ≥6 archetypes with meaningful weight so the morphing rotation reads as
 * preset-grade variety, not a single look family per energy band.
 *
 * Liquid's original weights are preserved (calm 3, steady 3, lift 2, drop 1,
 * climax 0.8) so the liquid look keeps its established air time across tiers.
 */
const TIER_ARCHETYPE_WEIGHTS: Record<EnergyTier, Record<Archetype, number>> = {
  calm: {
    // Original six — liquid weight preserved.
    nebula: 5,
    liquid: 3,
    kaleidoscope: 1,
    tunnel: 0.5,
    lattice: 0.3,
    strobe: 0.1,
    // New: dreamy, slow, dark-field archetypes belong here.
    vortex: 0.4,
    inkwell: 4,
    supernova: 0.2,
    cathedral: 3,
    phosphor: 2,
    ribbonfall: 1.5,
    pulsar: 0.3,
    mosaic: 0.6,
    deepfield: 4,
    solarflare: 0.3,
    glasshouse: 1.5,
    stormfront: 0.3,
    heartbeat: 3.5,
    carousel: 0.8,
    firefly: 4,
    tidal: 2,
    prism: 0.6,
    echochamber: 1.5,
    wireframe: 2,
    emberveil: 3.5,
  },
  steady: {
    // Original six — liquid weight preserved.
    liquid: 3,
    kaleidoscope: 3,
    nebula: 2,
    tunnel: 2,
    lattice: 1.5,
    strobe: 0.5,
    // New: archetypes with continuous motion belong here.
    vortex: 2,
    inkwell: 2,
    supernova: 0.6,
    cathedral: 1.5,
    phosphor: 2.5,
    ribbonfall: 3,
    pulsar: 1.2,
    mosaic: 3,
    deepfield: 1.5,
    solarflare: 1.5,
    glasshouse: 3,
    stormfront: 1,
    heartbeat: 1.5,
    carousel: 3,
    firefly: 2,
    tidal: 3,
    prism: 1.5,
    echochamber: 3,
    wireframe: 2,
    emberveil: 2,
  },
  lift: {
    // Original six — liquid weight preserved.
    tunnel: 3,
    kaleidoscope: 3,
    liquid: 2,
    lattice: 2,
    nebula: 1,
    strobe: 1,
    // New: anticipation/build archetypes belong here.
    vortex: 3,
    inkwell: 0.8,
    supernova: 1.5,
    cathedral: 0.8,
    phosphor: 1.5,
    ribbonfall: 1.5,
    pulsar: 4,
    mosaic: 3,
    deepfield: 0.8,
    solarflare: 1.8,
    glasshouse: 1.5,
    stormfront: 1.5,
    heartbeat: 0.6,
    carousel: 2,
    firefly: 0.5,
    tidal: 1.5,
    prism: 3,
    echochamber: 3,
    wireframe: 1,
    emberveil: 0.8,
  },
  drop: {
    // Original six — liquid weight preserved.
    kaleidoscope: 4,
    tunnel: 4,
    lattice: 3,
    strobe: 2,
    liquid: 1,
    nebula: 0.5,
    // New: hits/explosions belong here.
    vortex: 4,
    inkwell: 0.4,
    supernova: 4,
    cathedral: 0.5,
    phosphor: 0.8,
    ribbonfall: 0.6,
    pulsar: 3,
    mosaic: 2,
    deepfield: 0.3,
    solarflare: 4,
    glasshouse: 1,
    stormfront: 3.5,
    heartbeat: 0.4,
    carousel: 1.5,
    firefly: 0.2,
    tidal: 1,
    prism: 2.5,
    echochamber: 2,
    wireframe: 0.6,
    emberveil: 0.5,
  },
  climax: {
    // Original six — liquid weight preserved.
    strobe: 4,
    kaleidoscope: 4,
    tunnel: 3,
    lattice: 2,
    liquid: 0.8,
    nebula: 0.4,
    // New: loudest, most-explosive archetypes belong here.
    vortex: 3.5,
    inkwell: 0.3,
    supernova: 4.5,
    cathedral: 0.6,
    phosphor: 0.6,
    ribbonfall: 0.4,
    pulsar: 3,
    mosaic: 2.5,
    deepfield: 0.2,
    solarflare: 4,
    glasshouse: 0.8,
    stormfront: 4,
    heartbeat: 0.3,
    carousel: 1.2,
    firefly: 0.2,
    tidal: 0.6,
    prism: 3,
    echochamber: 1.5,
    wireframe: 0.4,
    emberveil: 0.3,
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
/** Default intra-section drift strength (0 disables). */
const DRIFT_AMOUNT = 0.12;
/** Period of the drift "breathe out and back" triangle wave, ms. */
const DRIFT_PERIOD_MS = 14000;
/** Throttle: recompute the drift lerp at most this often (ms) to bound GC. */
const DRIFT_TICK_MS = 100;

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
  /** Intra-section drift strength 0..1 — held looks slowly breathe. Default 0.12. 0 disables. */
  drift?: number;
  /**
   * Pre-populated visual memory plan. When supplied, the Director re-derives
   * its sections map from `plan.sections` via the existing generator (we never
   * store full OperatorConfigs — only seeds) and folds `plan.lineage` into
   * seedFor() so the track "remembers" its evolved look family. If the plan's
   * algoVersion mismatches the current algorithm, the plan loads in
   * fingerprints-only mode: stored fingerprints still guide section-return
   * detection, but stored seeds are NOT used to re-derive looks.
   */
  plan?: VisualMemoryPlan;
  /**
   * Fires when the Director writes a new section to its in-memory map from a
   * REAL audio section boundary. The renderer-side memory bridge coalesces
   * these writes into the persistent VisualMemoryPlan. Forced timer rotations
   * NEVER trigger this callback — only true `frame.sectionChanged === true`
   * paths do. `firstSeenAt`/`lastSeenAt` are left at 0 here; the bridge stamps
   * them with its supplied epoch ms.
   */
  onSectionLearn?: (section: VisualMemorySection) => void;
  /**
   * Bounded "wait for loadPlan() before priming the first look" window
   * (finding #9 from the pre-release review). When > 0, the first-update
   * fresh-mint priming branch is suppressed until EITHER loadPlan() is called
   * (the plan landed) OR `deferPrimingFrames` updates have ticked through
   * the update loop (the bound expired and we proceed plan-less). Default 0:
   * no defer, byte-identical to the pre-defer behavior. The Visualizer sets
   * this to ~30 (about 500ms @ 60fps) when it knows a loadOrSeed IPC is in
   * flight, so a track with a persisted plan never renders its first ~500ms
   * under the WRONG lineage. The "frames" here are calls to `update()`, not
   * wall-clock — which IS the rendered-frames clock since the Visualizer
   * gates this with createFrameGate to its target frame interval.
   */
  deferPrimingFrames?: number;
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
  /**
   * Hot-load a visual memory plan mid-track. Calls reset() internally so the
   * sections map is re-derived from `plan.sections`. Mostly used by the bridge
   * when the track-load races the renderer construction; common path is to
   * supply `plan` via DirectorOptions.
   */
  loadPlan(plan: VisualMemoryPlan): void;
  /**
   * Export the current sections + lineage as a fresh VisualMemoryPlan for the
   * bridge to persist. Pure projection of in-memory state; safe to call any
   * time. `updatedAt` is supplied by the caller (the bridge stamps it from its
   * epoch ms source — keeping this function deterministic and free of
   * Date.now).
   */
  exportPlan(updatedAt?: number): VisualMemoryPlan;
}

interface SectionMemory {
  config: OperatorConfig;
  tier: EnergyTier;
  /** The seed used to mint `config` — exported on plan write, never used inside the Director. */
  seed: number;
  /** Archetype string at write time — exported on plan write. */
  archetype: string;
  /** Rotation index that produced `config`. 0 = primary look from a section boundary. */
  rotationIndex: number;
  /** Section fingerprint from the reactor; null when this entry was loaded from a plan with no fingerprint. */
  fingerprint: Float32Array | null;
  /** How many real section boundaries have written this entry (1 = first-seen). */
  observedCount: number;
}

export function createDirector(opts: DirectorOptions = {}): Director {
  const songId = opts.songId ?? 'song';
  const transitionBeats = Math.max(0.25, opts.transitionBeats ?? 2);
  const transitionMsFallback = Math.max(150, opts.transitionMsFallback ?? 1800);
  const initial = opts.initial ? cloneConfig(opts.initial) : defaultConfig();
  const rotateMs = Math.max(0, opts.rotateMs ?? ROTATE_INTERVAL_MS);
  const rotateJitterPct = Math.max(0, Math.min(0.9, opts.rotateJitterPct ?? ROTATE_JITTER_PCT));
  const driftAmount = Math.max(0, Math.min(1, opts.drift ?? DRIFT_AMOUNT));

  // ── core state ────────────────────────────────────────────────────────────
  let enabled = opts.enabled !== false;
  let activeSongId = songId;

  // The config the renderer is currently being given (post-crossfade).
  let live: OperatorConfig = cloneConfig(initial);
  // The look we're heading toward; equal to `live` when no fade in flight.
  let target: OperatorConfig = cloneConfig(initial);
  // The look we're fading from; snapshot taken when the fade starts.
  let from: OperatorConfig = cloneConfig(initial);
  // Scratch config used by the per-frame fade path via lerpConfigInto so we
  // don't allocate ~30 fresh Channel objects (+ a Map per channel) every
  // frame. `live` is reassigned to point at this scratch while a section
  // fade is in flight; it is then snapshotted by startFade()'s
  // `from = cloneConfig(live)` which deep-copies values out, so the next
  // lerpConfigInto can safely overwrite the scratch in place. The renderer's
  // read of `live` happens synchronously within the same recomputeLive call.
  const fadeScratch: OperatorConfig = cloneConfig(initial);

  // Crossfade progress 0..1. 1 = fully on target.
  let fade = 1;
  // The total duration of the in-flight fade in ms (locked at start so a
  // mid-fade BPM change doesn't warp progress).
  let fadeDurationMs = transitionMsFallback;

  // Section memory: sectionId -> stored config + tier + seed lineage.
  const sections = new Map<number, SectionMemory>();
  let lastSectionId = -1;
  let lastTier: EnergyTier | null = null;

  // ── visual-memory plan state ──────────────────────────────────────────────
  // Lineage = the evolutionary history of THIS track's primary look family.
  // Folded into seedFor() when generation > 0 so a track that's been played
  // many times slowly drifts to fresh seeds while still rhyming with itself.
  // At generation 0 (no plan, or brand-new plan) the lineage salt is empty and
  // seedFor() returns the EXACT same key as before the memory system existed —
  // plan-less tracks render byte-identically to v1.11.0.
  let lineage: VisualMemoryLineage = opts.plan?.lineage
    ? {
        rootSeed: opts.plan.lineage.rootSeed >>> 0,
        ancestors: opts.plan.lineage.ancestors.slice(),
        generation: opts.plan.lineage.generation | 0,
        evolutionLog: opts.plan.lineage.evolutionLog.slice(),
      }
    : { rootSeed: hashSeed(activeSongId), ancestors: [], generation: 0, evolutionLog: [] };
  let counters = opts.plan?.counters
    ? { ...opts.plan.counters }
    : { plays: 0, skips: 0, loves: 0, sectionReturns: 0 };
  let neighborSeed = opts.plan?.neighborSeed ? { ...opts.plan.neighborSeed } : undefined;
  let activeTrackId: number = opts.plan?.trackId ?? 0;
  // True when the plan's algoVersion doesn't match the current algorithm — in
  // that mode stored fingerprints still guide section-return detection (the
  // future bridge feature), but stored seeds are NEVER consumed to re-derive
  // looks. Re-derivation falls through to the generator's own seedFor() path.
  let staleAlgo = false;
  const staleAlgoFingerprints = new Map<number, Float32Array>();

  // Timer-rotation floor: ms since the last look switch, and a monotonic
  // rotation counter (reset on a real section boundary) folded into the seed
  // so forced looks are deterministic in sequence but vary each rotation.
  let msSinceSwitch = 0;
  let rotationIndex = 0;
  // Cached rotation threshold (depends only on rotationIndex); recomputed lazily
  // when invalidated so the 60fps steady path does no per-frame allocation.
  let cachedRotateThresholdMs: number | null = null;

  // Intra-section drift: one precomputed mutated "breathe toward" target per
  // look, a phase clock, and a throttled cache so we don't lerp every frame.
  let driftTarget: OperatorConfig = cloneConfig(initial);
  let driftPhaseMs = 0;
  let driftAccumMs = 0;
  let driftCache: OperatorConfig = cloneConfig(initial);

  // Slow-moving energy + novelty trackers used to derive tier.
  let energyAvg = 0;
  let energyPeak = 0;
  let noveltyAccum = 0;
  let framesSinceSection = 0;

  // ── bounded priming defer (finding #9) ────────────────────────────────────
  // primingDeferRemaining counts how many more update() calls will suppress
  // the first-update fresh-mint priming branch. Starts at deferPrimingFrames
  // when no plan was supplied at construction; loadPlan() forces it to 0 (the
  // plan landed, gate is open). The default 0 means "never defer" — existing
  // call sites get byte-identical behavior. Set to ~30 by the Visualizer so a
  // track with a persisted plan doesn't render its first ~500ms under the
  // wrong lineage before loadOrSeed lands.
  const deferPrimingFrames = Math.max(0, opts.deferPrimingFrames ?? 0);
  let primingDeferRemaining = opts.plan ? 0 : deferPrimingFrames;

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
    // Per-(song, section, rotation) deterministic seed, optionally lineage-
    // salted when the loaded plan has evolved past generation 0. CRITICAL
    // invariant: when generation === 0 the salt is the empty string, so the
    // key collapses to EXACTLY the pre-memory format — plan-less tracks and
    // first-play tracks render byte-identically to v1.11.0. This is the
    // No Man's Sky lesson (don't churn existing users' worlds) encoded in code.
    const lineageSalt =
      lineage.generation > 0 ? `::g${lineage.generation}::${lineage.rootSeed >>> 0}` : '';
    const key =
      rotation === 0
        ? `${activeSongId}${lineageSalt}::section::${sectionId}`
        : `${activeSongId}${lineageSalt}::section::${sectionId}::r${rotation}`;
    return hashSeed(key);
  }

  function generateForSection(sectionId: number, tier: EnergyTier, rotation = 0): OperatorConfig {
    return generateForSectionFull(sectionId, tier, rotation).config;
  }

  /**
   * Same generation pipeline as `generateForSection`, but returns the picked
   * archetype + base seed alongside the config so the caller can stamp the
   * SectionMemory entry without re-running the weighted pick. Used by both the
   * onSectionBoundary path (which writes to `sections`) and `loadPlan`/`reset`
   * (which re-derives from stored seeds).
   */
  function generateForSectionFull(
    sectionId: number,
    tier: EnergyTier,
    rotation = 0,
  ): { config: OperatorConfig; archetype: Archetype; seed: number } {
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
    return { config: tuned, archetype, seed: baseSeed };
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
    // frame.sectionReturn, which forced rotations never set. The
    // onSectionLearn callback is wired to the same gate: only real audio
    // section boundaries learn into the persistent VisualMemoryPlan. Forced
    // timer rotations are an ephemeral variety floor, not part of the song's
    // remembered shape.
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
    // Precompute one deterministic drift target for this look; reset the phase.
    if (driftAmount > 0) {
      const driftSeed =
        hashSeed(`${activeSongId}::drift::${target.seed ?? 'x'}::${rotationIndex}`) >>> 0;
      driftTarget = mutate(target, driftAmount, driftSeed);
      driftPhaseMs = 0;
      driftAccumMs = 0;
    }
  }

  function onSectionBoundary(frame: EvilandFrame): void {
    const tier = tierFor(frame);

    let nextConfig: OperatorConfig;
    let storedSeed: number;
    let storedArchetype: string;
    if (frame.sectionReturn >= 0 && sections.has(frame.sectionReturn)) {
      // Returning section — recall the stored look so the chorus visually
      // rhymes with its previous appearance. Re-stamp the current sectionId
      // into the memory map so any second return hits this same look.
      const stored = sections.get(frame.sectionReturn)!;
      nextConfig = cloneConfig(stored.config);
      storedSeed = stored.seed;
      storedArchetype = stored.archetype;
      const fp = frame.sectionFingerprint;
      sections.set(frame.sectionId, {
        config: cloneConfig(nextConfig),
        tier: stored.tier,
        seed: storedSeed,
        archetype: storedArchetype,
        rotationIndex: 0,
        fingerprint: fp ? new Float32Array(fp) : stored.fingerprint,
        observedCount: stored.observedCount + 1,
      });
      // Bump the returning-section's observedCount too so the journal reflects
      // that this look got "seen" again.
      stored.observedCount += 1;
    } else {
      const minted = generateForSectionFull(frame.sectionId, tier);
      nextConfig = minted.config;
      storedSeed = minted.seed;
      storedArchetype = String(minted.archetype);
      const fp = frame.sectionFingerprint;
      sections.set(frame.sectionId, {
        config: cloneConfig(nextConfig),
        tier,
        seed: storedSeed,
        archetype: storedArchetype,
        rotationIndex: 0,
        fingerprint: fp ? new Float32Array(fp) : null,
        observedCount: 1,
      });
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

    // Fire the learn callback ONLY from this real-boundary path. The
    // onForcedRotation function (timer-driven) deliberately does NOT call it
    // (see the gate comment in onForcedRotation). The bridge is what stamps
    // firstSeenAt/lastSeenAt; we emit zeros to keep this function deterministic.
    const cb = opts.onSectionLearn;
    if (cb) {
      const memory = sections.get(frame.sectionId)!;
      cb({
        sectionId: frame.sectionId,
        fingerprint: memory.fingerprint
          ? Array.from(memory.fingerprint)
          : new Array(24).fill(0),
        seed: memory.seed >>> 0,
        archetype: memory.archetype,
        tier: memory.tier,
        rotationIndex: memory.rotationIndex,
        observedCount: memory.observedCount,
        firstSeenAt: 0,
        lastSeenAt: 0,
      });
    }
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

  function recomputeLive(dtMs = 0): void {
    if (fade >= 1) {
      if (driftAmount <= 0) {
        // Zero-alloc fast path — `target` is read-only and never mutated in
        // place. This was the GC fix behind the "laggy visualizer".
        live = target;
        return;
      }
      // Drift: slowly breathe target<->driftTarget and back on a triangle wave.
      // Throttled to DRIFT_TICK_MS so we allocate ~10x/sec, not 60x/sec; the
      // cached config is returned by reference between ticks.
      const dt = Math.max(0, Math.min(250, dtMs));
      driftPhaseMs = (driftPhaseMs + dt) % DRIFT_PERIOD_MS;
      driftAccumMs += dt;
      if (driftAccumMs >= DRIFT_TICK_MS) {
        driftAccumMs = 0;
        const phase = driftPhaseMs / DRIFT_PERIOD_MS; // 0..1
        const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2; // 0..1..0
        const t = tri * tri * (3 - 2 * tri); // smoothstep ease
        driftCache = lerpConfig(target, driftTarget, t);
        // Drift is NOT a section transition — leave `_transition` undefined so
        // the renderer's field-buffer crossfade (plan §2.6) stays disarmed.
      }
      live = driftCache;
    } else if (fade <= 0) {
      live = from;
    } else {
      const t = fade * fade * (3 - 2 * fade);
      // Allocation-light fade path: lerpConfigInto reuses fadeScratch's
      // channels (and their bindings arrays) instead of minting fresh objects
      // every frame. Output values are byte-identical to `lerpConfig(from,
      // target, t)`. fadeScratch is the same object every frame; that's safe
      // because the renderer reads `live` synchronously and startFade()
      // deep-copies it via `from = cloneConfig(live)` before the next fade.
      lerpConfigInto(fadeScratch, from, target, t);
      live = fadeScratch;
      // Section fade — stamp the eased transition value so the renderer
      // captures a field snapshot at fade start and crossfades against it.
      // Falls back to undefined the instant fade reaches 1 (see above).
      live._transition = t;
    }
  }

  // The plan that should be replayed on the NEXT reset(). Construction reads
  // `opts.plan`; the bridge's loadPlan() rebinds this. Distinct from the
  // exported `opts.plan` so a later reset(songId) doesn't get tangled with the
  // initial-construction plan.
  let pendingPlan: VisualMemoryPlan | undefined = opts.plan;
  staleAlgo = pendingPlan != null && (pendingPlan.algoVersion | 0) !== VISUAL_MEMORY_ALGO_VERSION;
  if (pendingPlan?.trackId) activeTrackId = pendingPlan.trackId | 0;

  /**
   * Re-populate `sections` from `pendingPlan`, if any. Each section's heavy
   * OperatorConfig is RE-DERIVED via the generator using the stored seed +
   * tier — we never persist generated configs (huge, brittle to algorithm
   * tweaks). When the plan's algoVersion mismatches the current algorithm,
   * the stored seeds would map to looks the new algorithm never produces, so
   * we skip seed re-derivation entirely and only stash fingerprints into
   * `staleAlgoFingerprints` (the reactor-return detector's future use). The
   * lineage threads forward regardless; the song still "remembers" without
   * snapping.
   */
  function repopulateFromPlan(): void {
    if (!pendingPlan) return;
    if (staleAlgo) {
      for (const s of pendingPlan.sections) {
        staleAlgoFingerprints.set(
          s.sectionId,
          new Float32Array(s.fingerprint.length === 24 ? s.fingerprint : new Array(24).fill(0)),
        );
      }
      return;
    }
    for (const s of pendingPlan.sections) {
      // Re-derive the look from the stored seed via the generator. We do NOT
      // call generateForSection(sectionId, tier) here because the stored seed
      // may have been minted under an older songId/lineage path; pull the
      // exact seed from the plan and feed it directly to generate()+mutate().
      const baseSeed = s.seed >>> 0;
      const tier = s.tier;
      const lookSeed = (baseSeed ^ 0x9e3779b1) >>> 0;
      // Pick archetype with the same RNG ordering as generateForSectionFull
      // so plan-stored looks reproduce identically.
      const rng = new Rng(baseSeed);
      const weights = TIER_ARCHETYPE_WEIGHTS[tier];
      const archetype = rng.weighted(
        ARCHETYPES as readonly Archetype[],
        ARCHETYPES.map((a) => weights[a] ?? 0),
      );
      // If the stored archetype string differs from the redrawn one (e.g.
      // weights changed within an algoVersion), prefer the stored archetype —
      // the song should look the way the journal said it did.
      const finalArchetype = (s.archetype as Archetype) ?? archetype;
      const { config } = generate(lookSeed, finalArchetype);
      const amount = TIER_MUTATE_AMOUNT[tier];
      const mutateSeed = (baseSeed ^ 0x85ebca6b) >>> 0;
      const tuned = amount > 0 ? mutate(config, amount, mutateSeed) : config;
      tuned.name = `${tuned.archetype ?? 'look'} • s${s.sectionId} • ${tier}`;
      sections.set(s.sectionId, {
        config: tuned,
        tier,
        seed: baseSeed,
        archetype: String(finalArchetype),
        rotationIndex: s.rotationIndex | 0,
        fingerprint:
          s.fingerprint.length === 24 ? new Float32Array(s.fingerprint) : null,
        observedCount: s.observedCount | 0,
      });
    }
  }

  // Initial-construction plan replay. If a plan was supplied via opts.plan,
  // its sections are re-derived into `sections` now so the first
  // update(sectionChanged=true) for a known sectionId recalls the look.
  repopulateFromPlan();

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
        // This is NOT a real audio section boundary (the reactor hasn't fired
        // sectionChanged yet), so onSectionLearn is deliberately NOT called
        // here — the bridge only persists looks the reactor structurally
        // confirmed. The first real boundary that follows will overwrite this
        // entry with a fingerprint-bearing one and fire the learn callback.
        //
        // Bounded priming defer (finding #9): when the caller knows a
        // loadPlan IPC is in flight, primingDeferRemaining was seeded > 0 at
        // construction. We DEFER the priming mint until either the plan
        // lands (loadPlan() zeroes primingDeferRemaining) or the budget
        // runs out. During the defer window we keep `live` at the initial
        // config (passthrough) — the renderer paints the default look, not
        // a fresh mint under the wrong lineage. framesSinceSection stays
        // pinned to 0 so this branch re-evaluates on the next update.
        if (primingDeferRemaining > 0) {
          primingDeferRemaining--;
          framesSinceSection = 0;
          // No fade started, no section minted, no learn callback. Return
          // the current live config (the default/passthrough) via the
          // normal recomputeLive path below.
        } else {
          const tier = tierFor(frame);
          const minted = generateForSectionFull(frame.sectionId, tier);
          sections.set(frame.sectionId, {
            config: cloneConfig(minted.config),
            tier,
            seed: minted.seed,
            archetype: String(minted.archetype),
            rotationIndex: 0,
            fingerprint: null,
            observedCount: 1,
          });
          lastSectionId = frame.sectionId;
          lastTier = tier;
          startFade(minted.config, 1, frame.bpm);
        }
      }

      advanceFade(frame, dtMs);

      // Timer floor: if structure hasn't changed the look in a while, force a
      // fresh rotation (MilkDrop-style). Only when settled, never mid-fade.
      msSinceSwitch += dt;
      if (rotateMs > 0 && fade >= 1 && msSinceSwitch >= effectiveRotateMs()) {
        onForcedRotation(frame);
        advanceFade(frame, dtMs);
      }

      recomputeLive(dtMs);
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
      staleAlgoFingerprints.clear();
      lastSectionId = -1;
      lastTier = null;
      energyAvg = 0;
      energyPeak = 0;
      noveltyAccum = 0;
      framesSinceSection = 0;
      msSinceSwitch = 0;
      rotationIndex = 0;
      cachedRotateThresholdMs = null;
      driftTarget = cloneConfig(live);
      driftPhaseMs = 0;
      driftAccumMs = 0;
      // Collapse any in-flight fade to the current live config so we don't
      // start the next song mid-blend with the previous one.
      from = cloneConfig(live);
      target = cloneConfig(live);
      fade = 1;
      fadeDurationMs = transitionMsFallback;
      // CROSS-TRACK PLAN BLEED FIX (finding #3 from the pre-release review):
      // Drop the previous track's pendingPlan + lineage + counters + neighbor
      // seed BEFORE attempting any repopulation. The previous code's
      // closure-scoped pendingPlan persisted across reset() calls, so a track
      // change followed by repopulateFromPlan() could replay the OLD track's
      // sections into the NEW song's sections map — and the OLD track's
      // lineage would salt the NEW track's seeds. This produced the "track B
      // visually rhymes with track A's chorus" leak the review caught.
      //
      // After reset(), the Director is in virgin-track state for `nextSongId`:
      //   - pendingPlan: undefined (no replay until loadPlan() is called)
      //   - lineage: { rootSeed: hashSeed(songId), generation: 0, ... }
      //   - counters: zeroes
      //   - neighborSeed: undefined
      //   - activeTrackId: 0
      //   - staleAlgo: false
      // The bridge's belt-and-suspenders pass (Visualizer.tsx) calls
      // director.loadPlan(...) on every track change with the actual plan
      // (own / borrowed / empty) for the new track, so this default is only
      // observed during the brief window between reset() and loadPlan().
      pendingPlan = undefined;
      lineage = {
        rootSeed: hashSeed(activeSongId),
        ancestors: [],
        generation: 0,
        evolutionLog: [],
      };
      counters = { plays: 0, skips: 0, loves: 0, sectionReturns: 0 };
      neighborSeed = undefined;
      activeTrackId = 0;
      staleAlgo = false;
      // Re-arm the bounded priming defer (finding #9). After reset() the
      // bridge will issue a fresh loadOrSeed IPC; until that lands we want
      // the priming branch suppressed so the first ~30 frames don't render
      // the new song under default lineage when a persisted plan might be
      // about to arrive. loadPlan() zeroes this when the plan lands.
      primingDeferRemaining = deferPrimingFrames;
      // No repopulation here — repopulateFromPlan() is a no-op when
      // pendingPlan is null. Plan injection happens through loadPlan().
    },

    loadPlan(nextPlan): void {
      // A plan landed — open the bounded-priming-defer gate so the next
      // update() can mint the opening look immediately (finding #9). Without
      // this, the defer window would idle the visualizer at the default
      // config until the budget expired even when the plan arrived sooner.
      primingDeferRemaining = 0;
      // Replace lineage + counters + neighbor seed + sections from the new
      // plan; reset() does the actual section repopulation work.
      lineage = {
        rootSeed: (nextPlan.lineage.rootSeed >>> 0) || hashSeed(activeSongId),
        ancestors: nextPlan.lineage.ancestors.slice(),
        generation: nextPlan.lineage.generation | 0,
        evolutionLog: nextPlan.lineage.evolutionLog.slice(),
      };
      counters = { ...nextPlan.counters };
      neighborSeed = nextPlan.neighborSeed ? { ...nextPlan.neighborSeed } : undefined;
      activeTrackId = nextPlan.trackId | 0;
      staleAlgo = (nextPlan.algoVersion | 0) !== VISUAL_MEMORY_ALGO_VERSION;
      // Stash a reference so reset() can pull section data from it. We don't
      // mutate `opts.plan` directly; instead use a private field.
      pendingPlan = nextPlan;
      // Full reset replays the plan into sections via repopulateFromPlan().
      sections.clear();
      staleAlgoFingerprints.clear();
      lastSectionId = -1;
      lastTier = null;
      energyAvg = 0;
      energyPeak = 0;
      noveltyAccum = 0;
      framesSinceSection = 0;
      msSinceSwitch = 0;
      rotationIndex = 0;
      cachedRotateThresholdMs = null;
      repopulateFromPlan();
    },

    exportPlan(updatedAt = 0): VisualMemoryPlan {
      const sectionEntries: VisualMemorySection[] = [];
      for (const [sectionId, mem] of sections) {
        sectionEntries.push({
          sectionId,
          fingerprint: mem.fingerprint ? Array.from(mem.fingerprint) : new Array(24).fill(0),
          seed: mem.seed >>> 0,
          archetype: mem.archetype,
          tier: mem.tier,
          rotationIndex: mem.rotationIndex,
          observedCount: mem.observedCount,
          firstSeenAt: 0,
          lastSeenAt: 0,
        });
      }
      sectionEntries.sort((a, b) => a.sectionId - b.sectionId);
      const plan: VisualMemoryPlan = {
        schema: 1,
        algoVersion: VISUAL_MEMORY_ALGO_VERSION,
        trackId: activeTrackId | 0,
        songId: activeSongId,
        lineage: {
          rootSeed: lineage.rootSeed >>> 0,
          ancestors: lineage.ancestors.slice(),
          generation: lineage.generation | 0,
          evolutionLog: lineage.evolutionLog.slice(),
        },
        sections: sectionEntries,
        counters: { ...counters },
        updatedAt,
      };
      if (neighborSeed) plan.neighborSeed = { ...neighborSeed };
      return plan;
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
      // Reset the timer-rotation clock too, so a user-set preset gets its full
      // dwell before the next forced rotation rather than lurching away if
      // msSinceSwitch was already near the threshold.
      msSinceSwitch = 0;
      rotationIndex = 0;
      cachedRotateThresholdMs = null;
      // Start drift neutral for the new look (no drift until the next switch
      // computes a real driftTarget).
      driftTarget = cloneConfig(config);
      driftPhaseMs = 0;
      driftAccumMs = 0;
    },
  };
}
