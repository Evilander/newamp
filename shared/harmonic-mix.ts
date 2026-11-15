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
// Spellings that name a note CIRCLE spells differently (flats, plus the
// enharmonic Cb/Fb/E#/B#).
const ENHARMONIC: Record<string, string> = {
  DB: 'C#',
  EB: 'D#',
  GB: 'F#',
  AB: 'G#',
  BB: 'A#',
  CB: 'B',
  FB: 'E',
  'E#': 'F',
  'B#': 'C',
};

/** A candidate with everything the scoring loop needs worked out once. */
interface MixEntry {
  track: Track;
  bpm: number;
  key: ParsedKey | null;
  metadata: number;
  jitter: number;
}

function mixEntry(track: Track): MixEntry {
  const key = parseKey(track.key);
  return {
    track,
    bpm: track.bpm && track.bpm > 0 ? track.bpm : 0,
    key,
    metadata: (track.bpm ? 4 : 0) + (key ? 6 : 0) + (track.duration && track.duration > 45 ? 1 : 0),
    jitter: stableJitter(track.id),
  };
}

export function buildHarmonicMix(tracks: Track[], input: HarmonicMixInput = {}): Track[] {
  const count = clampCount(input.count);
  // An explicit seed was picked by the listener, so a short track still seeds
  // the mix; the length filter only decides what gets queued after it.
  const candidates = dedupeTracks(tracks)
    .filter((track) => isPlayable(track) || (!!track.path && track.id === input.seedTrackId))
    .map(mixEntry);
  if (!candidates.length) return [];

  const seed = input.seedTrackId
    ? candidates.find((entry) => entry.track.id === input.seedTrackId)
    : chooseOpener(candidates);
  if (!seed) return [];

  const mix: Track[] = [seed.track];
  const remaining = candidates.filter((entry) => entry !== seed);
  const maxBpmDelta = normalizeMaxBpmDelta(input.maxBpmDelta);
  let previous = seed;

  while (mix.length < count && remaining.length) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    const previousArtist = previous.track.artist;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      const bpmDelta = bpmDistanceKnown(previous.bpm, candidate.bpm);
      const transition = transitionScore(keyCompatibilityParsed(previous.key, candidate.key), bpmDelta);
      const artistPenalty = previousArtist && previousArtist === candidate.track.artist ? 8 : 0;
      const bpmPenalty = bpmDelta > maxBpmDelta && Number.isFinite(bpmDelta) ? (bpmDelta - maxBpmDelta) * 2.5 : 0;
      const score = transition + candidate.metadata - artistPenalty - bpmPenalty + candidate.jitter;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    previous = remaining.splice(bestIndex, 1)[0]!;
    mix.push(previous.track);
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
  const score = transitionScore(keyScore, bpmDelta);
  return {
    score,
    bpmDelta,
    keyScore,
    reason: keyScore >= 0.95 ? 'relative or same key' : keyScore >= 0.75 ? 'adjacent key' : 'distant key',
  };
}

function transitionScore(keyScore: number, bpmDelta: number): number {
  const bpmScore = Number.isFinite(bpmDelta) ? Math.max(0, 30 - bpmDelta * 1.8) : 4;
  return keyScore * 55 + bpmScore;
}

function chooseOpener(entries: MixEntry[]): MixEntry {
  let best = entries[0]!;
  let bestScore = openerScore(best);
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i]!;
    const score = openerScore(entry);
    if (score > bestScore || (score === bestScore && stableSort(entry.track, best.track) < 0)) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

function openerScore(entry: MixEntry): number {
  return entry.metadata + (entry.track.loved ? 4 : 0) + Math.min(6, entry.track.playCount * 0.6) + entry.jitter;
}

// Keys are compared by key signature rather than by root note: E minor shares
// its signature with G major, so it sits one step from C, while D minor and G
// minor (one and two steps away) must not score alike. Comparing signatures
// also makes "8B" and "C" the same key whatever notation they were written in.
function keyCompatibility(a: string | null, b: string | null): number {
  return keyCompatibilityParsed(parseKey(a), parseKey(b));
}

function keyCompatibilityParsed(left: ParsedKey | null, right: ParsedKey | null): number {
  if (!left || !right) return 0.18;
  const distance = circleDistance(keySignatureIndex(left), keySignatureIndex(right));
  const sameMode = left.mode === right.mode;
  if (distance === 0) return sameMode ? 1 : 0.96;
  if (distance === 1) return sameMode ? 0.82 : 0.76;
  if (distance === 2) return sameMode ? 0.62 : 0.5;
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
  // Open Key (Traktor) numbers the same wheel six places on from Camelot, with
  // d for major and m for minor: 1d is 8B, 1m is 8A, 6d is 1B.
  const openKey = raw.match(/^([1-9]|1[0-2])([dm])$/i);
  if (openKey) {
    const camelotNumber = (Number(openKey[1]) + 6) % 12 + 1;
    return parseKeyUncached(`${camelotNumber}${openKey[2]!.toLowerCase() === 'm' ? 'A' : 'B'}`);
  }

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
  const match = normalized.match(/^([A-Ga-g])([#bB]?)(?:\s*(m|min|minor|maj|major))?$/i);
  if (!match) return null;

  const accidental = match[2] ?? '';
  const rootKey = `${match[1]!.toUpperCase()}${accidental.toUpperCase()}`;
  const root = ENHARMONIC[rootKey] ?? rootKey;
  const circleIndex = CIRCLE.indexOf(root);
  if (circleIndex < 0) return null;
  // Tags write the mode as "m", "Minor", "MIN" and so on, so the words are
  // case-insensitive; a lone capital "M" is the major shorthand, a lone "m" minor.
  const suffix = match[3] ?? '';
  const mode = suffix === 'm' || /^min(?:or)?$/i.test(suffix) ? 'minor' : 'major';
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
  return bpmDistanceKnown(a, b);
}

// Distance to b, b doubled or b halved, whichever is closest; 0 marks an unknown tempo.
function bpmDistanceKnown(a: number, b: number): number {
  if (a <= 0 || b <= 0) return Number.POSITIVE_INFINITY;
  const direct = Math.abs(a - b);
  const doubled = Math.abs(a - b * 2);
  const halved = Math.abs(a - b / 2);
  return direct < doubled ? (direct < halved ? direct : halved) : (doubled < halved ? doubled : halved);
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
