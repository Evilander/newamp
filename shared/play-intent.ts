/**
 * Numbers every request to start playback so a request that has been
 * superseded can tell. The audio engine already refuses to touch its own
 * state for a stale request, but it resolves the caller's promise either way;
 * the store used to run its side effects — Last.fm now-playing, the play
 * count, Auto DJ refill — for whichever request happened to finish, so two
 * quick clicks recorded and scrobbled both tracks. A caller takes an id
 * before awaiting the engine and checks it is still the newest afterwards.
 */
export interface PlayIntentGate {
  /** Registers a new request and returns its id. */
  begin(): number;
  /** True while no newer request has begun since `id`. */
  isCurrent(id: number): boolean;
}

export function createPlayIntentGate(): PlayIntentGate {
  let latest = 0;
  return {
    begin: () => ++latest,
    isCurrent: (id) => id === latest,
  };
}
