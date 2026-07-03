// Ask Your Library — the local natural-language → smart-rule compiler.
//
// "warm slow stuff from the 70s I haven't played this year" becomes a
// SmartPlaylistRuleInput (year range, bpm cap, notPlayedSince) plus DNA
// re-rank targets ("warm"), fully offline, with a human-readable chip list
// showing EXACTLY what was understood — honest, teachable, correctable.
// Words nothing matches fall through as free-text search (artist/title/
// album/genre), so "sad bowie songs" still finds Bowie.
//
// Pure module: no IPC, no window, unit-tested by scripts/query-intent-test.mjs.

import type { SmartPlaylistRuleInput } from './types.js';

export interface QueryIntent {
  rule: SmartPlaylistRuleInput;
  /** Human-readable compiled interpretation, one chip per constraint. */
  chips: string[];
  /** How many vocabulary constraints matched (0 = pure free-text). */
  matched: number;
}

interface Vocab {
  pattern: RegExp;
  chip: string | ((match: RegExpMatchArray) => string);
  apply: (rule: SmartPlaylistRuleInput, match: RegExpMatchArray, now: number) => void;
}

const DAY_MS = 86_400_000;

function setDecade(rule: SmartPlaylistRuleInput, decade: number): void {
  rule.minYear = decade;
  rule.maxYear = decade + 9;
}

const DECADE_WORDS: Record<string, number> = {
  fifties: 1950, sixties: 1960, seventies: 1970, eighties: 1980,
  nineties: 1990, noughties: 2000, aughts: 2000, tens: 2010,
};

const VOCAB: Vocab[] = [
  // ── era ────────────────────────────────────────────────────────────────
  {
    pattern: /\b(?:from\s+)?(?:the\s+)?(19|20)?(\d0)'?s\b/,
    chip: (m) => `${m[1] ?? (Number(m[2]) >= 30 ? '19' : '20')}${m[2]}s`,
    apply: (rule, m) => {
      const century = m[1] ?? (Number(m[2]) >= 30 ? '19' : '20');
      setDecade(rule, Number(`${century}${m[2]}`));
    },
  },
  {
    pattern: new RegExp(`\\b(?:from\\s+)?(?:the\\s+)?(${Object.keys(DECADE_WORDS).join('|')})\\b`),
    chip: (m) => `${DECADE_WORDS[m[1]!]}s`,
    apply: (rule, m) => setDecade(rule, DECADE_WORDS[m[1]!]!),
  },
  {
    pattern: /\bbefore\s+(19\d\d|20\d\d)\b/,
    chip: (m) => `before ${m[1]}`,
    apply: (rule, m) => { rule.maxYear = Number(m[1]) - 1; },
  },
  {
    pattern: /\b(?:after|since|post)\s+(19\d\d|20\d\d)\b/,
    chip: (m) => `after ${m[1]}`,
    apply: (rule, m) => { rule.minYear = Number(m[1]) + 1; },
  },
  {
    pattern: /\b(19\d\d|20\d\d)\s*(?:-|to|through)\s*(19\d\d|20\d\d)\b/,
    chip: (m) => `${m[1]}–${m[2]}`,
    apply: (rule, m) => {
      rule.minYear = Math.min(Number(m[1]), Number(m[2]));
      rule.maxYear = Math.max(Number(m[1]), Number(m[2]));
    },
  },
  // ── tempo ─────────────────────────────────────────────────────────────
  {
    pattern: /\b(slow|sleepy|downtempo|down-tempo)\b/,
    chip: 'slow (bpm ≤ 95)',
    apply: (rule) => { rule.maxBpm = 95; },
  },
  {
    pattern: /\b(fast|upbeat|up-tempo|uptempo|danceable|bangers?)\b/,
    chip: 'fast (bpm ≥ 118)',
    apply: (rule) => { rule.minBpm = 118; },
  },
  {
    pattern: /\bmid-?tempo\b/,
    chip: 'mid-tempo (90–125 bpm)',
    apply: (rule) => { rule.minBpm = 90; rule.maxBpm = 125; },
  },
  // ── texture / mood → DNA targets ──────────────────────────────────────
  {
    pattern: /\b(loud|heavy|aggressive|intense|hard)\b/,
    chip: 'loud-leaning (DNA energy)',
    apply: (rule) => { rule.dnaEnergyTarget = 0.85; },
  },
  {
    pattern: /\b(quiet|soft|gentle|calm|chill|mellow|peaceful)\b/,
    chip: 'gentle-leaning (DNA energy)',
    apply: (rule) => { rule.dnaEnergyTarget = 0.18; },
  },
  {
    pattern: /\bwarm\b/,
    chip: 'warm-leaning (DNA brightness)',
    apply: (rule) => { rule.dnaBrightnessTarget = 0.3; },
  },
  {
    pattern: /\b(bright|crisp|sparkl\w*|airy)\b/,
    chip: 'bright-leaning (DNA brightness)',
    apply: (rule) => { rule.dnaBrightnessTarget = 0.75; },
  },
  {
    pattern: /\b(dark|moody|brooding)\b/,
    chip: 'dark-leaning (DNA)',
    apply: (rule) => {
      rule.dnaBrightnessTarget = 0.28;
      if (rule.dnaEnergyTarget == null) rule.dnaEnergyTarget = 0.4;
    },
  },
  // ── recency ───────────────────────────────────────────────────────────
  {
    pattern: /\b(?:haven'?t|not|never)\s+(?:played|heard|listened(?:\s+to)?)\s+(?:in\s+|for\s+)?(?:this\s+year|since\s+january)\b/,
    chip: 'not played this year',
    apply: (rule, _m, now) => {
      const jan1 = new Date(new Date(now).getFullYear(), 0, 1).getTime();
      rule.notPlayedSinceMs = jan1;
    },
  },
  {
    pattern: /\b(?:haven'?t|not)\s+(?:played|heard|listened(?:\s+to)?)\s+(?:in\s+|for\s+)?(?:a\s+while|ages|months|forever|a\s+long\s+time)\b/,
    chip: 'not played in 90+ days',
    apply: (rule, _m, now) => { rule.notPlayedSinceMs = now - 90 * DAY_MS; },
  },
  {
    pattern: /\b(?:haven'?t|not)\s+(?:played|heard|listened(?:\s+to)?)\s+(?:in\s+|for\s+)?(?:this\s+month|weeks)\b/,
    chip: 'not played in 30+ days',
    apply: (rule, _m, now) => { rule.notPlayedSinceMs = now - 30 * DAY_MS; },
  },
  {
    pattern: /\bnever\s+played\b/,
    chip: 'never played',
    apply: (rule) => { rule.unplayedOnly = true; },
  },
  {
    pattern: /\bforgotten\b/,
    chip: 'not played in 180+ days',
    apply: (rule, _m, now) => { rule.notPlayedSinceMs = now - 180 * DAY_MS; },
  },
  // ── signals ───────────────────────────────────────────────────────────
  {
    pattern: /\b(?:loved|favorites?|favourites?|hearted)\b/,
    chip: 'loved only',
    apply: (rule) => { rule.lovedOnly = true; },
  },
  {
    pattern: /\b(?:highly\s+rated|top\s+rated|best\s+rated|rated\s+(\d)\s*\+?|(\d)\s+stars?(?:\s+and\s+up)?)\b/,
    chip: (m) => `rated ${m[1] ?? m[2] ?? 4}+`,
    apply: (rule, m) => { rule.minRating = Math.min(5, Math.max(1, Number(m[1] ?? m[2] ?? 4))); },
  },
];

/** Filler that should never leak into free-text search. */
const STOPWORDS = new Set([
  'stuff', 'songs', 'song', 'tracks', 'track', 'music', 'something', 'anything',
  'some', 'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'me', 'i', 'my', 'that', 'this', 'play', 'give', 'find', 'show', 'want',
  'like', 'sounding', 'sounds', 'vibes', 'vibe', 'feel', 'feels', 'feeling',
  'please', 'from', 'have',
]);

/**
 * True when the text reads like natural language rather than a direct
 * title/artist search: 3+ words, no explicit field:value tokens.
 */
export function looksLikeNaturalQuery(text: string): boolean {
  const trimmed = text.trim();
  if (/[a-z]+:/i.test(trimmed)) return false; // field:value grammar — let it through untouched
  return trimmed.split(/\s+/).length >= 3;
}

export function compileQueryIntent(text: string, now = Date.now()): QueryIntent {
  // Curly quotes arrive from phone keyboards and macOS autocorrect.
  let working = ` ${text.toLowerCase().replace(/[‘’]/g, "'").trim()} `;
  const rule: SmartPlaylistRuleInput = { name: 'Ask', mood: 'focus', count: 40 };
  const chips: string[] = [];
  let matched = 0;

  for (const vocab of VOCAB) {
    const m = working.match(vocab.pattern);
    if (!m) continue;
    vocab.apply(rule, m, now);
    chips.push(typeof vocab.chip === 'function' ? vocab.chip(m) : vocab.chip);
    matched += 1;
    working = working.replace(vocab.pattern, ' ');
  }

  // Whatever remains that isn't filler becomes free-text search (artists,
  // genres, title words) — the escape hatch that keeps unknown vocabulary
  // useful instead of ignored.
  const residual = working
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}'&-]/gu, ''))
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
  if (residual.length) {
    rule.searchQuery = residual.join(' ');
    chips.push(`“${residual.join(' ')}”`);
  }

  return { rule, chips, matched };
}
