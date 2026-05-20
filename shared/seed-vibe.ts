import type { Track } from './types.js';
import { dnaCosineSimilarity, type TrackDna } from './audio-dna.js';

/**
 * Precomputed seed-side context. Build once per mix call (NOT per candidate)
 * via `createSeedVibeContext`; reuse for every candidate. This hoists three
 * per-call costs that used to happen per-candidate in the old API:
 *   - `genreTokens(seed.genre)` allocation
 *   - The seed-side `Set` build for Jaccard
 *   - `normalize(seed.artist)` / `normalize(seed.album)`
 *
 * On a 10k-candidate mix that saves ~30k allocations per call.
 */
export interface SeedVibeContext {
  seed: Track;
  seedDna: TrackDna | null;
  /** @internal */ readonly seedGenres: string[];
  /** @internal */ readonly seedGenreSet: Set<string>;
  /** @internal */ readonly seedArtist: string;
  /** @internal */ readonly seedAlbum: string;
  /** @internal */ readonly hasGenreSignal: boolean;
}

export function createSeedVibeContext(seed: Track, seedDna: TrackDna | null = null): SeedVibeContext {
  const seedGenres = genreTokens(seed.genre);
  return {
    seed,
    seedDna,
    seedGenres,
    seedGenreSet: new Set(seedGenres),
    seedArtist: normalize(seed.artist),
    seedAlbum: normalize(seed.album),
    hasGenreSignal: seedGenres.length > 0,
  };
}

/**
 * Score how vibe-similar a candidate is to the mix seed. Returns 0..1.
 *
 * The score blends multiple soft signals so missing metadata never zeros it
 * out:
 *   - DNA cosine (strongest when both tracks are analyzed)
 *   - Genre token Jaccard
 *   - Artist match
 *   - Same album
 *   - Era proximity (release year window)
 *   - BPM proximity
 *
 * Weights are normalized so the result lands in [0, 1]. When neither seed nor
 * candidate has DNA, genre carries the most weight; same-artist always returns
 * at least 0.55 so a mix can deepen into an artist when the seed asks for it.
 */
export function seedVibeSimilarity(
  candidate: Track,
  ctx: SeedVibeContext,
  candidateDna: TrackDna | null = null,
): number {
  let dna = 0;
  let hasDnaSignal = false;
  if (ctx.seedDna && candidateDna) {
    dna = dnaCosineSimilarity(ctx.seedDna, candidateDna);
    hasDnaSignal = true;
  }

  const candidateGenres = genreTokens(candidate.genre);
  const genre = jaccardAgainstSeed(candidateGenres, ctx.seedGenreSet);
  const hasGenreSignal = ctx.hasGenreSignal && candidateGenres.length > 0;

  const candidateArtist = normalize(candidate.artist);
  const candidateAlbum = normalize(candidate.album);
  const artist = candidateArtist && candidateArtist === ctx.seedArtist ? 1 : 0;
  const album = candidateAlbum && candidateAlbum === ctx.seedAlbum ? 1 : 0;

  const era = eraProximity(ctx.seed.year, candidate.year);
  const bpm = bpmProximity(ctx.seed.bpm, candidate.bpm);

  let total: number;
  if (hasDnaSignal && hasGenreSignal) {
    total = 0.42 * dna + 0.28 * genre + 0.14 * era + 0.1 * artist + 0.04 * album + 0.02 * bpm;
  } else if (hasDnaSignal) {
    total = 0.55 * dna + 0.2 * era + 0.18 * artist + 0.05 * album + 0.02 * bpm;
  } else if (hasGenreSignal) {
    total = 0.5 * genre + 0.22 * era + 0.2 * artist + 0.06 * album + 0.02 * bpm;
  } else {
    total = 0.4 * era + 0.4 * artist + 0.15 * album + 0.05 * bpm;
  }

  if (artist === 1) total = Math.max(total, 0.55);

  return clamp01(total);
}

/**
 * Apply the multiplicative seed-vibe gate on top of a base taste/harmonic
 * score. Off-vibe tracks (vibe ≈ 0) keep 15% of their base score so the mix
 * still has some serendipity; on-vibe tracks (vibe ≈ 1) get full credit. This
 * was previously inlined in `electron/library.ts` — moved here so the gate
 * constant lives with the formula it gates.
 */
export function applySeedVibeGate(baseScore: number, vibe: number): number {
  return baseScore * (0.15 + 0.85 * vibe);
}

function genreTokens(value: string | null): string[] {
  return (value ?? '')
    .toLowerCase()
    .split(/[;,/|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Jaccard similarity of a fresh candidate token list against a precomputed
 * seed Set. We only build one Set per candidate (instead of two like the old
 * `jaccard(a, b)`), which halves the per-candidate allocation pressure.
 */
function jaccardAgainstSeed(candidateGenres: string[], seedSet: Set<string>): number {
  if (candidateGenres.length === 0 || seedSet.size === 0) return 0;
  let intersect = 0;
  const candidateSet = new Set(candidateGenres);
  for (const t of candidateSet) if (seedSet.has(t)) intersect += 1;
  const union = seedSet.size + candidateSet.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function normalize(value: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

function eraProximity(a: number | null, b: number | null): number {
  if (!a || !b) return 0;
  const diff = Math.abs(a - b);
  if (diff <= 2) return 1;
  if (diff <= 5) return 0.85;
  if (diff <= 10) return 0.65;
  if (diff <= 20) return 0.35;
  if (diff <= 30) return 0.15;
  return 0;
}

function bpmProximity(a: number | null, b: number | null): number {
  if (!a || !b || a <= 0 || b <= 0) return 0;
  const diff = Math.min(Math.abs(a - b), Math.abs(a - b * 2), Math.abs(a - b / 2));
  if (diff <= 3) return 1;
  if (diff <= 6) return 0.75;
  if (diff <= 10) return 0.5;
  if (diff <= 16) return 0.25;
  return 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
