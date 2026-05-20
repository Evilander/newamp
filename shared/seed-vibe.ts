import type { Track } from './types.js';
import { dnaCosineSimilarity, type TrackDna } from './audio-dna.js';

export interface SeedVibeOptions {
  seed: Track;
  seedDna?: TrackDna | null;
  /** Lookup function for candidate DNA. May return null if unanalyzed. */
  getDna?: (trackId: number) => TrackDna | null;
}

export interface SeedVibeBreakdown {
  total: number;
  dna: number;
  genre: number;
  artist: number;
  album: number;
  era: number;
  bpm: number;
  hasDnaSignal: boolean;
  hasGenreSignal: boolean;
}

/**
 * Score how vibe-similar a candidate is to the mix seed. Returns 0..1.
 *
 * The score blends multiple soft signals so missing metadata never zeros it out:
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
  options: SeedVibeOptions,
): SeedVibeBreakdown {
  const { seed, seedDna = null, getDna } = options;
  const candidateDna = getDna ? getDna(candidate.id) : null;

  let dna = 0;
  let hasDnaSignal = false;
  if (seedDna && candidateDna) {
    dna = dnaCosineSimilarity(seedDna, candidateDna);
    hasDnaSignal = true;
  }

  const seedGenres = genreTokens(seed.genre);
  const candidateGenres = genreTokens(candidate.genre);
  const genre = jaccard(seedGenres, candidateGenres);
  const hasGenreSignal = seedGenres.length > 0 && candidateGenres.length > 0;

  const artist =
    normalize(candidate.artist) && normalize(candidate.artist) === normalize(seed.artist) ? 1 : 0;
  const album =
    normalize(candidate.album) && normalize(candidate.album) === normalize(seed.album) ? 1 : 0;

  const era = eraProximity(seed.year, candidate.year);
  const bpm = bpmProximity(seed.bpm, candidate.bpm);

  // Adaptive blending: if we have DNA for both, lean on it; otherwise lean on
  // genre + era. Artist match is always a strong anchor.
  let total: number;
  if (hasDnaSignal && hasGenreSignal) {
    total = 0.42 * dna + 0.28 * genre + 0.14 * era + 0.1 * artist + 0.04 * album + 0.02 * bpm;
  } else if (hasDnaSignal) {
    total = 0.55 * dna + 0.2 * era + 0.18 * artist + 0.05 * album + 0.02 * bpm;
  } else if (hasGenreSignal) {
    total = 0.5 * genre + 0.22 * era + 0.2 * artist + 0.06 * album + 0.02 * bpm;
  } else {
    // No DNA, no genre — fall back to era + artist + bpm so we don't return 0
    // for everything (which would make the seed gate useless).
    total = 0.4 * era + 0.4 * artist + 0.15 * album + 0.05 * bpm;
  }

  // Artist match should always be a strong floor.
  if (artist === 1) total = Math.max(total, 0.55);

  return {
    total: clamp01(total),
    dna,
    genre,
    artist,
    album,
    era,
    bpm,
    hasDnaSignal,
    hasGenreSignal,
  };
}

function genreTokens(value: string | null): string[] {
  return (value ?? '')
    .toLowerCase()
    .split(/[;,/|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  for (const t of setA) if (setB.has(t)) intersect += 1;
  const union = setA.size + setB.size - intersect;
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
