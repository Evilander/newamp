// The seed-code helpers the player store needs at launch, kept out of the
// randomizer so the store does not drag the look tables (60 KB) into the
// startup chunk. They give the same codes as randomSeedCode, seedCodeFor and
// decode(code).seed in eviland-randomizer; scripts/viz-store-wiring-test.mjs
// checks the two stay in step.
import { decodeSeedCode, encodeSeedCode, toSeedState } from './eviland-rng';

/** A seed code nobody has used: 32 bits from the platform's entropy source. */
export function randomSeedCode(): string {
  const entropy = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  const state = entropy?.getRandomValues
    ? entropy.getRandomValues(new Uint32Array(1))[0]!
    : (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0;
  return encodeSeedCode(state);
}

/** The code a seed of any shape turns into: what the seed box shows. */
export function seedCodeFor(seed: string | number): string {
  return encodeSeedCode(toSeedState(seed));
}

/** The code `code` pastes back to (case and dashes normalised), or null when it is not a seed code. */
export function canonicalSeedCode(code: string): string | null {
  const state = decodeSeedCode(code);
  return state === null ? null : encodeSeedCode(state);
}
