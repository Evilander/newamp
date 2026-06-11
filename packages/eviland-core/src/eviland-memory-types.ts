// Eviland Remembers Your Library — visual-memory plan schema.
//
// The durable contract for "the visualizer remembers your library". A plan is
// a small, JSON-safe, lineage-anchored record of how a single track has looked
// across its prior plays. The Director consumes plans on load and produces
// them on export; the renderer side persists them through library.ts.
//
// Two invariants drive the schema:
//
//   1. Identity = seed lineage. We do NOT store generated OperatorConfigs (huge,
//      brittle to algorithm tweaks). We store the deterministic *seeds* and
//      their evolutionary history. If the randomizer's algoVersion changes,
//      Director re-derives looks from those seeds — the song still "remembers"
//      without snapping, because the lineage threads forward.
//
//   2. Honesty: this file is a mirrored leaf in @eviland/core (added to the
//      MIRRORED list in packages/eviland-core/sync.mjs). So it must stay
//      DETERMINISTIC and free of `Date.now()` — timestamps for plans are
//      supplied by the BRIDGE side (renderer-only). All helpers here take an
//      explicit `now: number` when they need one.
//
// Zero dependencies. Pure TypeScript. Allocation-light helpers.

// ---------------------------------------------------------------------------
// Versioning. The two numbers move on different cadences:
//
//   schema:      the JSON shape of the plan blob. Bump on any breaking shape
//                change. Unknown fields on parsed plans are preserved on the
//                in-memory object (validators only enforce required fields).
//   algoVersion: the randomizer/director generative algorithm. Bump when ANY
//                of ARCHETYPES, TIER_ARCHETYPE_WEIGHTS, or SAFE_RANGES change
//                meaningfully — the algo-version-guard script enforces this in
//                CI. Old plans with an older algoVersion are LOADED (so the
//                user's listening history isn't discarded) but Director runs
//                in "fingerprints-only" mode: stored fingerprints still guide
//                section-return detection, but the stored seeds are NOT used
//                to re-derive looks.
// ---------------------------------------------------------------------------

export const VISUAL_MEMORY_SCHEMA_VERSION = 1;
export const VISUAL_MEMORY_ALGO_VERSION = 1;

/**
 * Per-section memory: the look the Director chose for one boundary in a song,
 * its fingerprint (used to recognise the section on return), and the counters
 * used to drive evolution.
 *
 * `fingerprint` is a plain number[] of length 24 — NOT Float32Array — because
 * Float32 doesn't round-trip through JSON (would become an object of indices).
 */
export interface VisualMemorySection {
  /** Monotonic section index from the audio reactor. */
  sectionId: number;
  /** 24-float mel-band average over this section (JSON-safe number[]). */
  fingerprint: number[];
  /** The hashSeed key used to mint this section's primary look (uint32). */
  seed: number;
  /** Picked archetype. Free-form string (the union widens over time). */
  archetype: string;
  /** Energy tier the Director assigned at this boundary. */
  tier: 'calm' | 'steady' | 'lift' | 'drop' | 'climax';
  /** 0 = primary look; >0 = forced rotation index seen. */
  rotationIndex: number;
  /** How many times we've returned to (or replayed) this section. */
  observedCount: number;
  /** Epoch ms — when first written. Supplied by the bridge, not generated here. */
  firstSeenAt: number;
  /** Epoch ms — last update. Supplied by the bridge. */
  lastSeenAt: number;
}

/**
 * Lineage: the evolutionary history of the plan's "primary look family".
 *
 * `ancestors` is mu+lambda-style elitism — once an ancestor seed is added we
 * NEVER overwrite or drop it (cap by FIFO trim of the OLDEST when length > 8).
 * `evolutionLog` is a structured journal of WHY each seed change happened, so
 * future code can reason about a track's listening history without replaying
 * audio. Pruning rule: any entry whose `toSeed` has no descendant (not the
 * current rootSeed, not in ancestors, not the seed of any section) is dropped
 * on compact — see `prunePlan` below.
 */
export interface VisualMemoryLineage {
  /** The seed that mints this track's primary look family. */
  rootSeed: number;
  /** Chronological ancestor seeds, capped at 8 (oldest trimmed first). */
  ancestors: number[];
  /** 0 = first play; ++ on each evolution event (8/32/96/256 ladder). */
  generation: number;
  /** Journal of evolution events. Capped at 32; oldest trimmed first. */
  evolutionLog: VisualMemoryEvolutionEntry[];
}

export interface VisualMemoryEvolutionEntry {
  /** Epoch ms (bridge-supplied). */
  at: number;
  trigger: 'play-count' | 'love' | 'section-return' | 'neighbor-seed';
  fromSeed: number;
  toSeed: number;
}

/** Optional borrow record when this plan was seeded from a similar track. */
export interface VisualMemoryNeighborSeed {
  fromTrackId: number;
  /** DNA cosine similarity score in [0,1]. */
  score: number;
  /** Epoch ms (bridge-supplied). */
  at: number;
}

export interface VisualMemoryCounters {
  plays: number;
  skips: number;
  loves: number;
  sectionReturns: number;
}

/**
 * Top-level plan blob. Persisted as `plan_json` (TEXT) in `track_visual_memory`.
 *
 * Forward-compat rule (read-side): unknown fields encountered on parse should
 * be preserved by the caller on the in-memory object — validators only enforce
 * REQUIRED fields. The schema is intended to grow append-only at major bumps.
 */
export interface VisualMemoryPlan {
  /** VISUAL_MEMORY_SCHEMA_VERSION at write time. */
  schema: number;
  /** VISUAL_MEMORY_ALGO_VERSION at write time. */
  algoVersion: number;
  /** Track row id (Library.tracks.id). */
  trackId: number;
  /** Canonical songId — `track-${trackId}`. Stored for forensic clarity. */
  songId: string;
  /** Optional borrowed-from record (DNA-neighbor path). */
  neighborSeed?: VisualMemoryNeighborSeed;
  lineage: VisualMemoryLineage;
  sections: VisualMemorySection[];
  counters: VisualMemoryCounters;
  /** Epoch ms — last write. Supplied by the bridge. */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Constants for lineage evolution (the 8/32/96/256 ladder).
// ---------------------------------------------------------------------------

/**
 * The play-count ladder at which a play-driven evolution event fires.
 *
 * Exponential-decay spacing so old tracks stabilise: a brand-new track evolves
 * fast (every few plays), a well-known track evolves rarely (every hundreds of
 * plays). Generation N is reached at plays = LADDER[N - 1].
 *
 * Generation transitions happen "at or after" — `nextGenerationAt(plays)`
 * returns the SMALLEST ladder value strictly greater than `plays` (i.e. the
 * NEXT threshold), or `null` when all rungs have been climbed.
 */
export const LINEAGE_PLAY_LADDER: readonly number[] = [8, 32, 96, 256];

/** Maximum entries kept in evolutionLog. Older entries trimmed FIFO. */
export const EVOLUTION_LOG_CAP = 32;

/** Maximum ancestor seeds retained (mu+lambda elitism cap). */
export const ANCESTORS_CAP = 8;

/** How many sections to retain. Old (least-recently-seen) sections trimmed. */
export const SECTIONS_CAP = 64;

// ---------------------------------------------------------------------------
// Pure helpers — no I/O, no Date.now, no global state.
// ---------------------------------------------------------------------------

/**
 * Construct an empty plan for a brand-new (track, song) at generation 0.
 *
 * `rootSeed` is supplied by the caller (the bridge mints it via hashSeed of
 * the songId, or borrows from a DNA-neighbor). Counters start at zero;
 * `updatedAt`/`firstSeenAt` are left as 0 — the bridge stamps them on first
 * write.
 */
export function createEmptyPlan(
  trackId: number,
  songId: string,
  rootSeed: number,
): VisualMemoryPlan {
  return {
    schema: VISUAL_MEMORY_SCHEMA_VERSION,
    algoVersion: VISUAL_MEMORY_ALGO_VERSION,
    trackId: trackId >>> 0,
    songId,
    lineage: {
      rootSeed: rootSeed >>> 0,
      ancestors: [],
      generation: 0,
      evolutionLog: [],
    },
    sections: [],
    counters: { plays: 0, skips: 0, loves: 0, sectionReturns: 0 },
    updatedAt: 0,
  };
}

/**
 * Defensive type-guard for plans parsed at JSON boundaries. We only enforce
 * REQUIRED structure — unknown extra fields are accepted (forward-compat) and
 * preserved by the caller on the in-memory object.
 */
export function validatePlan(x: unknown): x is VisualMemoryPlan {
  if (!x || typeof x !== 'object') return false;
  const p = x as Partial<VisualMemoryPlan>;
  if (typeof p.schema !== 'number') return false;
  if (typeof p.algoVersion !== 'number') return false;
  if (typeof p.trackId !== 'number' || !Number.isFinite(p.trackId)) return false;
  if (typeof p.songId !== 'string' || !p.songId) return false;
  if (typeof p.updatedAt !== 'number' || !Number.isFinite(p.updatedAt)) return false;

  const c = p.counters;
  if (!c || typeof c !== 'object') return false;
  if (typeof c.plays !== 'number' || typeof c.skips !== 'number') return false;
  if (typeof c.loves !== 'number' || typeof c.sectionReturns !== 'number') return false;

  const ln = p.lineage;
  if (!ln || typeof ln !== 'object') return false;
  if (typeof ln.rootSeed !== 'number') return false;
  if (typeof ln.generation !== 'number') return false;
  if (!Array.isArray(ln.ancestors)) return false;
  if (!ln.ancestors.every((s) => typeof s === 'number')) return false;
  if (!Array.isArray(ln.evolutionLog)) return false;
  for (const e of ln.evolutionLog) {
    if (!e || typeof e !== 'object') return false;
    if (typeof e.at !== 'number') return false;
    if (typeof e.fromSeed !== 'number' || typeof e.toSeed !== 'number') return false;
    const t = e.trigger;
    if (t !== 'play-count' && t !== 'love' && t !== 'section-return' && t !== 'neighbor-seed') {
      return false;
    }
  }

  if (!Array.isArray(p.sections)) return false;
  for (const s of p.sections) {
    if (!s || typeof s !== 'object') return false;
    if (typeof s.sectionId !== 'number') return false;
    if (typeof s.seed !== 'number') return false;
    if (typeof s.archetype !== 'string') return false;
    if (typeof s.rotationIndex !== 'number') return false;
    if (typeof s.observedCount !== 'number') return false;
    if (typeof s.firstSeenAt !== 'number' || typeof s.lastSeenAt !== 'number') return false;
    if (!Array.isArray(s.fingerprint)) return false;
    // Length-24 is the contract from the reactor. Reject other lengths so a
    // corrupted blob never silently feeds the wrong-shaped vector into the
    // recall path.
    if (s.fingerprint.length !== 24) return false;
    for (const v of s.fingerprint) if (typeof v !== 'number') return false;
    const tier = s.tier;
    if (
      tier !== 'calm' && tier !== 'steady' && tier !== 'lift' &&
      tier !== 'drop' && tier !== 'climax'
    ) {
      return false;
    }
  }

  if (p.neighborSeed != null) {
    const n = p.neighborSeed;
    if (typeof n !== 'object') return false;
    if (typeof n.fromTrackId !== 'number') return false;
    if (typeof n.score !== 'number') return false;
    if (typeof n.at !== 'number') return false;
  }

  return true;
}

/**
 * Return the NEXT play count at which a generation tick should fire, given the
 * current `plays` counter. Returns null when all rungs of the ladder have been
 * climbed (track is "stabilised").
 *
 * Examples (LINEAGE_PLAY_LADDER = [8, 32, 96, 256]):
 *   plays = 0   → 8
 *   plays = 7   → 8
 *   plays = 8   → 32
 *   plays = 31  → 32
 *   plays = 32  → 96
 *   plays = 95  → 96
 *   plays = 96  → 256
 *   plays = 255 → 256
 *   plays = 256 → null
 */
export function nextGenerationAt(plays: number): number | null {
  const p = Math.max(0, Math.floor(plays));
  for (const rung of LINEAGE_PLAY_LADDER) {
    if (p < rung) return rung;
  }
  return null;
}

/**
 * Prune a plan in place — drop orphan evolutionLog entries, enforce ancestor
 * elitism + cap, and cap evolutionLog at EVOLUTION_LOG_CAP.
 *
 * Orphan rule: an evolutionLog entry's `toSeed` is "referenced" if it appears
 * as the current rootSeed, in lineage.ancestors, or as any section.seed.
 * Entries whose toSeed is unreferenced AND whose fromSeed is also unreferenced
 * (i.e. a dead twig) are dropped. Ancestor seeds themselves are NEVER dropped
 * by this pass — elitism is mandatory; we only FIFO-trim the oldest when
 * length > ANCESTORS_CAP, never overwrite or selectively prune.
 *
 * Returns the same plan reference (in-place mutation) so callers can chain.
 */
export function prunePlan(plan: VisualMemoryPlan): VisualMemoryPlan {
  // Build the "referenced seeds" set: current root, ancestors, section seeds.
  const referenced = new Set<number>();
  referenced.add(plan.lineage.rootSeed >>> 0);
  for (const a of plan.lineage.ancestors) referenced.add(a >>> 0);
  for (const s of plan.sections) referenced.add(s.seed >>> 0);

  // Drop entries that are dead twigs — neither endpoint has any descendant
  // visible in the plan. A live `fromSeed` keeps an entry even if `toSeed`
  // has since been replaced, so the journal still tells the story.
  plan.lineage.evolutionLog = plan.lineage.evolutionLog.filter((entry) => {
    const to = entry.toSeed >>> 0;
    const from = entry.fromSeed >>> 0;
    return referenced.has(to) || referenced.has(from);
  });

  // Enforce caps. FIFO trim — oldest entries first (the array is chronological).
  if (plan.lineage.evolutionLog.length > EVOLUTION_LOG_CAP) {
    plan.lineage.evolutionLog.splice(
      0,
      plan.lineage.evolutionLog.length - EVOLUTION_LOG_CAP,
    );
  }
  if (plan.lineage.ancestors.length > ANCESTORS_CAP) {
    plan.lineage.ancestors.splice(
      0,
      plan.lineage.ancestors.length - ANCESTORS_CAP,
    );
  }

  // Sections: trim oldest by lastSeenAt when over cap. Tie-break by sectionId
  // ascending (older sectionIds dropped first).
  if (plan.sections.length > SECTIONS_CAP) {
    plan.sections.sort((a, b) => {
      if (a.lastSeenAt !== b.lastSeenAt) return a.lastSeenAt - b.lastSeenAt;
      return a.sectionId - b.sectionId;
    });
    plan.sections.splice(0, plan.sections.length - SECTIONS_CAP);
  }

  return plan;
}
