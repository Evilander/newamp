// Shared types + validator for the Eviland VisualMemoryPlan persistence layer.
//
// PARALLEL DEFINITION (the same mirror trick as shared/audio-dna.ts vs the
// per-pass DNA path):
//   - `src/visualizer/eviland-memory-types.ts` is the deterministic, mirrored,
//     algorithm-side source of truth used by the Director and the @eviland/core
//     extraction. It must stay free of Date.now and zero-dep.
//   - `shared/visual-memory.ts` (this file) mirrors the type shape so the
//     library/preload/main/renderer-API layer can persist + transport plans
//     without making `shared/` depend on `src/`. The structural type used at
//     compile time is identical; values cross the JSON boundary safely.
//
// The schema lives in the algorithm-side file; the bridge serialises it and
// these helpers re-validate it on read.

export const VISUAL_MEMORY_SCHEMA_VERSION = 1;
export const VISUAL_MEMORY_ALGO_VERSION = 1;

export type VisualMemoryTier = 'calm' | 'steady' | 'lift' | 'drop' | 'climax';
export type VisualMemoryEvolutionTrigger =
  | 'play-count'
  | 'love'
  | 'section-return'
  | 'neighbor-seed';

export interface VisualMemorySection {
  sectionId: number;
  fingerprint: number[]; // length 24
  seed: number;
  archetype: string;
  tier: VisualMemoryTier;
  rotationIndex: number;
  observedCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface VisualMemoryEvolutionEntry {
  at: number;
  trigger: VisualMemoryEvolutionTrigger;
  fromSeed: number;
  toSeed: number;
}

export interface VisualMemoryLineage {
  rootSeed: number;
  ancestors: number[];
  generation: number;
  evolutionLog: VisualMemoryEvolutionEntry[];
}

export interface VisualMemoryNeighborSeed {
  fromTrackId: number;
  score: number;
  at: number;
}

export interface VisualMemoryCounters {
  plays: number;
  skips: number;
  loves: number;
  sectionReturns: number;
}

export interface VisualMemoryPlan {
  schema: number;
  algoVersion: number;
  trackId: number;
  songId: string;
  neighborSeed?: VisualMemoryNeighborSeed;
  lineage: VisualMemoryLineage;
  sections: VisualMemorySection[];
  counters: VisualMemoryCounters;
  updatedAt: number;
}

export interface VisualMemoryStats {
  tracksWithMemory: number;
  totalSections: number;
  oldestAt: number | null;
}

/**
 * Defensive type-guard for plans crossing the JSON / IPC boundary. The renderer
 * also has a validator on the algorithm side; this one exists so the library /
 * preload layer can reject malformed blobs WITHOUT importing from
 * src/visualizer (which would inject a renderer-only dependency into electron/).
 *
 * Forward-compat: unknown extra fields are tolerated. Only required structure
 * is checked.
 */
export function isValidVisualMemoryPlan(x: unknown): x is VisualMemoryPlan {
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
  for (const a of ln.ancestors) if (typeof a !== 'number') return false;
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
    // Length-24 contract (24 mel bands). Reject other lengths so a corrupted
    // blob can't silently feed a wrong-shaped vector into the recall path.
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
