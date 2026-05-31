// Eviland deterministic RNG toolkit.
//
// The randomizer, the Director, and "shareable seed" recall all need randomness
// that is *reproducible*: the same seed must always mint the same look, on any
// machine, forever. So we never touch Math.random() — every draw flows from a
// seeded, integer-stable PRNG (mulberry32). A short string seed is folded into
// a 32-bit state with FNV-1a so users can share/recall a look by a tiny code.
//
// Zero dependencies — this module is part of the future @eviland/core surface.

/** mulberry32: tiny, fast, well-distributed 32-bit PRNG. Returns [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash → 32-bit unsigned. Stable across runs/platforms. */
export function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Normalise any seed (string | number) to a 32-bit state. */
export function toSeedState(seed: string | number): number {
  if (typeof seed === 'number') return seed >>> 0;
  return hashSeed(seed);
}

/**
 * A small, ergonomic RNG built on mulberry32. Construct from a string or number
 * seed; every method is deterministic given the seed and call order.
 */
export class Rng {
  private readonly draw: () => number;
  readonly seed: string | number;

  constructor(seed: string | number) {
    this.seed = seed;
    this.draw = mulberry32(toSeedState(seed));
  }

  /** Float in [0,1). */
  next(): number {
    return this.draw();
  }

  /** Float in [min,max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.draw();
  }

  /** Integer in [min,max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability p (default 0.5). */
  bool(p = 0.5): boolean {
    return this.draw() < p;
  }

  /** Uniformly pick one element. Throws on empty arrays — callers guard. */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick: empty array');
    return arr[Math.floor(this.draw() * arr.length)]!;
  }

  /** Weighted pick. `weights` parallels `arr`; non-positive weights are skipped. */
  weighted<T>(arr: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) if (w > 0) total += w;
    if (total <= 0) return this.pick(arr);
    let r = this.draw() * total;
    for (let i = 0; i < arr.length; i++) {
      const w = weights[i] ?? 0;
      if (w <= 0) continue;
      r -= w;
      if (r <= 0) return arr[i]!;
    }
    return arr[arr.length - 1]!;
  }

  /** Approx. standard-normal via Box–Muller, scaled to mean/std. */
  gaussian(mean = 0, std = 1): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.draw();
    while (v === 0) v = this.draw();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + z * std;
  }

  /** Fisher–Yates shuffle (returns a new array; does not mutate input). */
  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.draw() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

const SEED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Crockford-ish, no ambiguous chars

/**
 * Encode a 32-bit number to a short human-shareable code (e.g. "K7Q2-9XMF").
 * Pairs with `decodeSeedCode`. Used for the "lock / share this look" feature.
 */
export function encodeSeedCode(state: number): string {
  let n = state >>> 0;
  let out = '';
  for (let i = 0; i < 8; i++) {
    out = SEED_ALPHABET[n & 31]! + out;
    n = n >>> 5;
  }
  return out.slice(0, 4) + '-' + out.slice(4);
}

/** Decode a code from `encodeSeedCode` back to its 32-bit state (or null). */
export function decodeSeedCode(code: string): number | null {
  const clean = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (clean.length !== 8) return null;
  let n = 0;
  for (const ch of clean) {
    const idx = SEED_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    n = ((n << 5) | idx) >>> 0;
  }
  return n >>> 0;
}
