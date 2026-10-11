// Volume up/down from the keyboard. Goes in the same steps as before, but
// shares the wheel's stop at 100%: going up from below stops there exactly,
// plain presses (and key repeat) are absorbed until the keys have been quiet
// for a moment, and Shift goes straight on into the boost range.

import { DETENT_MS, clampVolume } from './wheel-volume';

const STEP = 0.05;
const UNITY = 1;
const EPSILON = 1e-6;
/** A held key sends its first repeat only after the system's repeat delay,
 *  which can be as long as a second. Repeats get this long to arrive after the
 *  press that landed on (or was absorbed at) 100%. */
const REPEAT_DELAY_MS = 1100;

export type VolumeKeyDirection = 'up' | 'down';

export interface VolumeKeyOptions {
  shift?: boolean;
  /** KeyboardEvent.repeat: the key is being held down. */
  repeat?: boolean;
}

export class VolumeKeyInput {
  private detentUntil = -Infinity;
  private repeatUntil = -Infinity;

  /** The volume after one press. `now` is the event's own timestamp. */
  next(
    direction: VolumeKeyDirection,
    current: number,
    now: number,
    { shift = false, repeat = false }: VolumeKeyOptions = {},
  ): number {
    if (direction === 'down') return clampVolume(current - STEP);
    const target = current + STEP;
    if (shift) return clampVolume(target);
    if (current < UNITY - EPSILON && target >= UNITY - EPSILON) {
      this.hold(now);
      return UNITY;
    }
    if (Math.abs(current - UNITY) < EPSILON && (now < this.detentUntil || (repeat && now < this.repeatUntil))) {
      this.hold(now);
      return UNITY;
    }
    return clampVolume(target);
  }

  private hold(now: number): void {
    this.detentUntil = now + DETENT_MS;
    this.repeatUntil = now + REPEAT_DELAY_MS;
  }
}

export const volumeKeyInput = new VolumeKeyInput();
