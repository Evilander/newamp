// Playback first on a busy drive.
//
// The waveform and song-score decodes read whole files from the same disk the
// gapless stream is reading from. When that stream is still decoding but has
// fallen below a few seconds of audio, the disk is not keeping up: background
// decodes wait before they start, and prefetches for a later track are
// stopped. The stream reports itself fed again once it is back at its
// low-water mark (see electron/gapless-transport.ts).

type HungerListener = (hungry: boolean) => void;

// Most a background decode waits. Past it the decode runs anyway, so a stream
// that never refills (a drive that can't keep up at all) can't hold every
// waveform back for the whole session.
export const MAX_FED_WAIT_MS = 60_000;

const hungryStreams = new Set<object>();
const listeners = new Set<HungerListener>();
let waiters: Array<() => void> = [];

/** A gapless stream reports whether its decoder is falling behind. */
export function reportPlaybackHunger(stream: object, hungry: boolean): void {
  const before = hungryStreams.size > 0;
  if (hungry) hungryStreams.add(stream);
  else hungryStreams.delete(stream);
  const after = hungryStreams.size > 0;
  if (before === after) return;
  for (const listener of listeners) listener(after);
  if (!after) {
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  }
}

export function playbackHungry(): boolean {
  return hungryStreams.size > 0;
}

/** Resolves at once unless playback is short of audio; then when it is fed again, or after `maxWaitMs`. */
export function whenPlaybackFed(maxWaitMs = MAX_FED_WAIT_MS): Promise<void> {
  if (hungryStreams.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      waiters = waiters.filter((w) => w !== done);
      resolve();
    };
    const timer = setTimeout(done, maxWaitMs);
    waiters.push(done);
  });
}

/** Called with true when playback starts running short, false when it is fed again. */
export function onPlaybackHunger(listener: HungerListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
