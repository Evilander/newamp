// Next-look and previous-look requests for Eviland, from anywhere in the app
// to every Director that is running. The on-screen visualizer and the
// projector's producer each have a Director of their own, so a request is a
// count both can read, not a call into one of them.
import type { Director } from './eviland-director';

/** Most looks one burst of presses steps back through at once. */
const MAX_BACK_STEPS = 4;

let skips = 0;
let backs = 0;

/** Ask every running Director to move on to a fresh look. */
export function requestLookSkip(): void {
  skips += 1;
}

/** Ask every running Director to fade back to the look before this one. */
export function requestLookBack(): void {
  backs += 1;
}

export interface LookRequestCursor {
  /**
   * Hand the requests made since the last call to `director`. With `active`
   * false (the Director is not driving the look) they are dropped, so a
   * skip pressed during a manual look does not fire when the Director is
   * turned back on.
   */
  drain(director: Pick<Director, 'skip' | 'previous'>, active: boolean): void;
}

/** A cursor starts at the requests made so far: a host that mounts later never replays old ones. */
export function createLookRequestCursor(): LookRequestCursor {
  let seenSkips = skips;
  let seenBacks = backs;
  return {
    drain(director, active) {
      const newSkips = skips - seenSkips;
      const newBacks = backs - seenBacks;
      if (newSkips === 0 && newBacks === 0) return;
      seenSkips = skips;
      seenBacks = backs;
      if (!active) return;
      for (let i = 0; i < Math.min(newBacks, MAX_BACK_STEPS); i++) {
        if (!director.previous()) break;
      }
      // Several skips in one frame are one fresh look.
      if (newSkips > 0) director.skip();
    },
  };
}
