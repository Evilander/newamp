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
  /** How many vocabulary constraints matched (0 = pure free-text, or mostly unrecognised words). */
  matched: number;
}

interface Vocab {
  pattern: RegExp;
  chip: string | ((match: RegExpMatchArray) => string);
  apply: (rule: SmartPlaylistRuleInput, match: RegExpMatchArray, now: number) => void;
  /** Every occurrence counts, and the years they set widen to cover all of them ("80s and 90s"). */
  repeat?: boolean;
  /** Plain words that are just as likely to be part of a title ("dark", "slow"), as opposed to request syntax ("after 1990", "loved"). */
  titleWord?: boolean;
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

// "tens" is also an ordinary word ("tens of songs"), so it only counts as a
// decade after "the" and when it is not followed by "of".
const DECADE_WORD_NAMES = Object.keys(DECADE_WORDS).filter((word) => word !== 'tens').join('|');

function decadeWord(match: RegExpMatchArray): string {
  return (match[1] ?? match[2])!;
}

const VOCAB: Vocab[] = [
  // ── era ────────────────────────────────────────────────────────────────
  {
    pattern: /\b(?:from\s+)?(?:the\s+)?(19|20)?(\d0)'?s\b/,
    chip: (m) => `${m[1] ?? (Number(m[2]) >= 30 ? '19' : '20')}${m[2]}s`,
    apply: (rule, m) => {
      const century = m[1] ?? (Number(m[2]) >= 30 ? '19' : '20');
      setDecade(rule, Number(`${century}${m[2]}`));
    },
    repeat: true,
  },
  {
    pattern: new RegExp(`\\b(?:from\\s+)?(?:(?:the\\s+)?(${DECADE_WORD_NAMES})|the\\s+(tens)(?!\\s+of\\b))\\b`),
    chip: (m) => `${DECADE_WORDS[decadeWord(m)]}s`,
    apply: (rule, m) => setDecade(rule, DECADE_WORDS[decadeWord(m)]!),
    repeat: true,
  },
  {
    pattern: /\bbefore\s+(19\d\d|20\d\d)\b/,
    chip: (m) => `before ${m[1]}`,
    apply: (rule, m) => { rule.maxYear = Number(m[1]) - 1; },
  },
  {
    pattern: /\b(?:after\s+|post[-\s]?)(19\d\d|20\d\d)\b/,
    chip: (m) => `after ${m[1]}`,
    apply: (rule, m) => { rule.minYear = Number(m[1]) + 1; },
  },
  {
    pattern: /\bsince\s+(19\d\d|20\d\d)\b/,
    chip: (m) => `since ${m[1]}`,
    apply: (rule, m) => { rule.minYear = Number(m[1]); },
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
    titleWord: true,
  },
  {
    pattern: /\b(fast|upbeat|up-tempo|uptempo|danceable|bangers?)\b/,
    chip: 'fast (bpm ≥ 118)',
    apply: (rule) => { rule.minBpm = 118; },
    titleWord: true,
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
    titleWord: true,
  },
  {
    pattern: /\b(quiet|soft|gentle|calm|chill|mellow|peaceful)\b/,
    chip: 'gentle-leaning (DNA energy)',
    apply: (rule) => { rule.dnaEnergyTarget = 0.18; },
    titleWord: true,
  },
  {
    pattern: /\bwarm\b/,
    chip: 'warm-leaning (DNA brightness)',
    apply: (rule) => { rule.dnaBrightnessTarget = 0.3; },
    titleWord: true,
  },
  {
    pattern: /\b(bright|crisp|sparkl\w*|airy)\b/,
    chip: 'bright-leaning (DNA brightness)',
    apply: (rule) => { rule.dnaBrightnessTarget = 0.75; },
    titleWord: true,
  },
  {
    pattern: /\b(dark|moody|brooding)\b/,
    chip: 'dark-leaning (DNA)',
    apply: (rule) => {
      rule.dnaBrightnessTarget = 0.28;
      if (rule.dnaEnergyTarget == null) rule.dnaEnergyTarget = 0.4;
    },
    titleWord: true,
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
    pattern: /\b(?:haven'?t|not)\s+(?:played|heard|listened(?:\s+to)?)\s+(?:in\s+|for\s+)?(?:a\s+while|ages|months|years|forever|a\s+long\s+time)\b/,
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

// A single CJK character is a whole word (an artist name can be one), so the
// one-character filter below must not drop it.
const SINGLE_CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;

function contentWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}'&-]/gu, ''))
    .filter((word) => (word.length > 1 || SINGLE_CJK.test(word)) && !STOPWORDS.has(word));
}

// A query whose only recognised words could be part of a title, and where they
// make up less than this share of it, reads as a title ("dark side of the
// moon") rather than a request, and is searched literally.
const MIN_VOCAB_COVERAGE = 0.75;

export function compileQueryIntent(text: string, now = Date.now()): QueryIntent {
  // Curly quotes arrive from phone keyboards and macOS autocorrect.
  const normalized = text.toLowerCase().replace(/[‘’]/g, "'").trim();
  let working = ` ${normalized} `;
  const rule: SmartPlaylistRuleInput = { name: 'Ask', mood: 'focus', count: 40 };
  const chips: string[] = [];
  let matched = 0;
  let structured = false;

  for (const vocab of VOCAB) {
    const chipFor = (m: RegExpMatchArray) => (typeof vocab.chip === 'function' ? vocab.chip(m) : vocab.chip);
    if (vocab.repeat) {
      // "80s and 90s": each occurrence is its own chip and the years widen to
      // the union, instead of the second one leaking into the free-text search.
      const all = [...working.matchAll(new RegExp(vocab.pattern.source, 'g'))];
      if (!all.length) continue;
      let minYear = rule.minYear ?? Infinity;
      let maxYear = rule.maxYear ?? -Infinity;
      for (const m of all) {
        vocab.apply(rule, m, now);
        minYear = Math.min(minYear, rule.minYear ?? Infinity);
        maxYear = Math.max(maxYear, rule.maxYear ?? -Infinity);
        chips.push(chipFor(m));
      }
      rule.minYear = minYear;
      rule.maxYear = maxYear;
      matched += all.length;
      structured = true;
      working = working.replace(new RegExp(vocab.pattern.source, 'g'), ' ');
      continue;
    }
    const m = working.match(vocab.pattern);
    if (!m) continue;
    vocab.apply(rule, m, now);
    chips.push(chipFor(m));
    matched += 1;
    if (!vocab.titleWord) structured = true;
    working = working.replace(vocab.pattern, ' ');
  }

  // Whatever remains that isn't filler becomes free-text search (artists,
  // genres, title words) — the escape hatch that keeps unknown vocabulary
  // useful instead of ignored.
  const residual = contentWords(working);
  const total = contentWords(normalized).length;
  if (matched > 0 && !structured && total > 0 && (total - residual.length) / total < MIN_VOCAB_COVERAGE) {
    // Only title-like words were recognised and most of the query was not: report
    // a plain search so the caller falls back to the literal title/album/artist
    // lookup instead of a half-compiled rule.
    return {
      rule: { name: 'Ask', mood: 'focus', count: 40, searchQuery: normalized },
      chips: [`“${normalized}”`],
      matched: 0,
    };
  }
  if (residual.length) {
    rule.searchQuery = residual.join(' ');
    chips.push(`“${residual.join(' ')}”`);
  }

  return { rule, chips, matched };
}

/**
 * The chips with the tempo ones saying how much of the library has a tempo. A
 * tempo filter only sees tracks whose tempo is known; until the background
 * analysis has been through the library that can be a small part of it, and the
 * chip is where the listener finds that out.
 */
export function withTempoCoverage(intent: QueryIntent, coverage: { known: number; total: number }): string[] {
  const filtersTempo = intent.rule.minBpm != null || intent.rule.maxBpm != null;
  if (!filtersTempo || coverage.total <= 0) return intent.chips;
  const known = Math.min(coverage.known, coverage.total).toLocaleString('en-US');
  const total = coverage.total.toLocaleString('en-US');
  const note = coverage.known >= coverage.total ? '' : `, tempo known for ${known} of ${total} tracks`;
  // The free-text chip is quoted; a search word like "bpm" is not a tempo constraint.
  return intent.chips.map((chip) => (/\bbpm\b/i.test(chip) && !chip.startsWith('\u201c') ? chip + note : chip));
}
