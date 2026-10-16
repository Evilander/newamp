// The player store asks for the next track's song score ahead of time, but the
// score feed (and the Eviland stack behind it) only loads with a visualizer.
// The feed registers itself here when it loads; until then there is no
// visualizer running, which is the case a prefetch has always skipped.
type ScorePrefetch = (trackId: number | null | undefined) => void;

let prefetch: ScorePrefetch | null = null;

/** Called by the score feed module as it loads. */
export function registerScorePrefetch(fn: ScorePrefetch): void {
  prefetch = fn;
}

/** Warm the score for a track that is about to play. A no-op while no visualizer has loaded. */
export function requestScorePrefetch(trackId: number | null | undefined): void {
  prefetch?.(trackId);
}
