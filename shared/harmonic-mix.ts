import type { HarmonicMixInput, Track } from './types.js';

export interface HarmonicTransitionScore {
  score: number;
  bpmDelta: number;
  keyScore: number;
  reason: string;
}

interface ParsedKey {
  root: string;
  circleIndex: number;
  mode: 'major' | 'minor';
}

const CIRCLE = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#', 'F'];
const FLATS: Record<string, string> = {
  DB: 'C#',
  EB: 'D#',
  GB: 'F#',
  AB: 'G#',
  BB: 'A#',
};

export function buildHarmonicMix(tracks: Track[], input: HarmonicMixInput = {}): Track[] {
  const count = clampCount(input.count);
  const candidates = dedupeTracks(tracks).filter((track) => isPlayable(track));
  if (!candidates.length) return [];

  const seed = input.seedTrackId
    ? candidates.find((track) => track.id === input.seedTrackId)
    : chooseOpener(candidates);
  if (!seed) return [];

  const mix: Track[] = [seed];
  const remaining = candidates.filter((track) => track.id !== seed.id);
  const maxBpmDelta = normalizeMaxBpmDelta(input.maxBpmDelta);

  while (mix.length < count && remaining.length) {
    const previous = mix[mix.length - 1]!;
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      const transition = harmonicTransitionScore(previous, candidate);
      const metadata = metadataScore(candidate);
      const artistPenalty = previous.artist && previous.artist === candidate.artist ? 8 : 0;
      const bpmPenalty =
        Number.isFinite(transition.bpmDelta) && transition.bpmDelta > maxBpmDelta
          ? (transition.bpmDelta - maxBpmDelta) * 2.5
          : 0;
      const score = transition.score + metadata - artistPenalty - bpmPenalty + stableJitter(candidate.id);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    mix.push(remaining.splice(bestIndex, 1)[0]!);
  }

  return mix;
}

export function harmonicTransitionScore(
  from: Track | null | undefined,
  to: Track | null | undefined,
): HarmonicTransitionScore {
  if (!from || !to) return { score: 0, bpmDelta: Number.POSITIVE_INFINITY, keyScore: 0, reason: 'missing track' };
  const bpmDelta = bpmDistance(from.bpm, to.bpm);
  const keyScore = keyCompatibility(from.key, to.key);
  const bpmScore = Number.isFinite(bpmDelta) ? Math.max(0, 30 - bpmDelta * 1.8) : 4;
  const score = keyScore * 55 + bpmScore;
  return {
    score,
    bpmDelta,
    keyScore,
    reason: keyScore >= 0.95 ? 'relative or same key' : keyScore >= 0.75 ? 'adjacent key' : 'distant key',
  };
}

function chooseOpener(tracks: Track[]): Track {
  return [...tracks].sort((a, b) => openerScore(b) - openerScore(a) || stableSort(a, b))[0]!;
}

function openerScore(track: Track): number {
  return metadataScore(track) + (track.loved ? 4 : 0) + Math.min(6, track.playCount * 0.6) + stableJitter(track.id);
}

function metadataScore(track: Track): number {
  return (track.bpm ? 4 : 0) + (parseKey(track.key) ? 6 : 0) + (track.duration && track.duration > 45 ? 1 : 0);
}

function keyCompatibility(a: string | null, b: string | null): number {
  const left = parseKey(a);
  const right = parseKey(b);
  if (!left || !right) return 0.18;
  if (left.root === right.root && left.mode === right.mode) return 1;
  if (keySignatureIndex(left) === keySignatureIndex(right)) return 0.96;
  const distance = circleDistance(left.circleIndex, right.circleIndex);
  if (left.mode === right.mode && distance === 1) return 0.82;
  if (distance <= 2) return 0.62;
  return 0.24;
}

const parseKeyCache = new Map<string, ParsedKey | null>();

function parseKey(value: string | null): ParsedKey | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  // harmonicTransitionScore re-parses both tracks' key strings on every
  // (previous, candidate) pairing buildHarmonicMix scores — `previous` is
  // constant across the whole inner loop, so this was redundant regex work
  // repeated once per candidate. Key strings are few and fixed (~24-48
  // standard notations), and parseKey is a pure function of the string, so
  // caching indefinitely at module scope is safe and never goes stale.
  const cached = parseKeyCache.get(raw);
  if (cached !== undefined) return cached;
  const result = parseKeyUncached(raw);
  parseKeyCache.set(raw, result);
  return result;
}

function parseKeyUncached(raw: string): ParsedKey | null {
  const camelot = raw.match(/^([1-9]|1[0-2])([ab])$/i);
  if (camelot) {
    const number = Number(camelot[1]);
    const mode = camelot[2]!.toUpperCase() === 'A' ? 'minor' : 'major';
    // Camelot numbers already follow the circle of fifths (8B=C major,
    // 9B=G major, ...) but offset from CIRCLE's own C-rooted index — 8B (C
    // major) must land on the SAME circleIndex parsing "C" would produce, or
    // keyCompatibility can never recognise them as the same key. The minor
    // (A) row needs another +3: circleIndex always represents the literal
    // root note regardless of mode (mirroring the letter-name path below,
    // where "Am" and "A" share circleIndex — they differ only in `mode`),
    // and A minor's root (A) sits 3 positions from its relative major's
    // root (C) on the circle of fifths.
    const circleIndex = mod(number - 8 + (mode === 'minor' ? 3 : 0), CIRCLE.length);
    return { root: `camelot-${number}${mode}`, circleIndex, mode };
  }

  const normalized = raw
    .replace(/♭/g, 'b')
    .replace(/♯/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  const match = normalized.match(/^([A-Ga-g])([#bB]?)(?:\s*(m|min|minor|maj|major))?$/);
  if (!match) return null;

  const accidental = match[2] ?? '';
  const rootKey = `${match[1]!.toUpperCase()}${accidental.toUpperCase()}`;
  const root = FLATS[rootKey] ?? rootKey.replace('B', 'b').replace('b', 'b').toUpperCase();
  const circleIndex = CIRCLE.indexOf(root);
  if (circleIndex < 0) return null;
  const suffix = (match[3] ?? '').toLowerCase();
  const mode = suffix === 'm' || suffix === 'min' || suffix === 'minor' ? 'minor' : 'major';
  return { root, circleIndex, mode };
}

function keySignatureIndex(key: ParsedKey): number {
  return key.mode === 'major' ? key.circleIndex : mod(key.circleIndex - 3, CIRCLE.length);
}

function circleDistance(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return Math.min(diff, CIRCLE.length - diff);
}

function bpmDistance(a: number | null, b: number | null): number {
  if (!a || !b || a <= 0 || b <= 0) return Number.POSITIVE_INFINITY;
  const variants = [b, b * 2, b / 2];
  return Math.min(...variants.map((candidate) => Math.abs(a - candidate)));
}

function dedupeTracks(tracks: Track[]): Track[] {
  const seen = new Set<number>();
  const out: Track[] = [];
  for (const track of tracks) {
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    out.push(track);
  }
  return out;
}

function isPlayable(track: Track): boolean {
  return !!track.path && (!track.duration || track.duration > 20);
}

function clampCount(value: number | null | undefined): number {
  return Math.max(1, Math.min(200, Math.trunc(Number(value) || 30)));
}

function normalizeMaxBpmDelta(value: number | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(48, parsed) : 12;
}

function stableSort(a: Track, b: Track): number {
  return (a.artist || '').localeCompare(b.artist || '') || (a.title || '').localeCompare(b.title || '');
}

function stableJitter(id: number): number {
  const x = Math.sin(id * 999.331) * 10000;
  return (x - Math.floor(x)) * 0.05;
}

function mod(value: number, size: number): number {
  return ((value % size) + size) % size;
}
