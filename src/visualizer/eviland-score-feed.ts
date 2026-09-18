// Score feed — the app-side glue between the player and the conductor.
//
// The conductor (eviland-conductor.ts) is pure: give it a score and a playback
// position and it stamps cues on a frame. This module is what knows about
// NewAmp: which track is playing, where the engine's clock is, that a
// cue-sheet track's clock is offset into a longer file, and that scores come
// over IPC and take a second or two the first time a track is seen.
//
// Every Eviland consumer (the docked/fullscreen visualizer in both Eviland
// modes, and the headless producer feeding the projector) creates one feed and
// calls conduct() on each analysed frame. Scores are fetched once per track
// and shared between feeds.

import { api } from '../lib/api';
import { lookAheadEnabled } from '../lib/vizPrefs';
import type { EvilandFrame } from './eviland-audio';
import { createConductor } from './eviland-conductor';
import type { SongScore } from './eviland-score';

export interface ScoreFeedTrack {
  id: number;
  cueStart?: number | null;
}

export interface ScoreFeedDeps {
  /** The track now playing, or null (idle, radio, podcast). */
  getTrack(): ScoreFeedTrack | null;
  /** Engine playback position in seconds, in FILE time. */
  getPosition(): number;
}

export interface ScoreFeed {
  /** Stamp look-ahead cues on `frame` (in place) when the track has a score. */
  conduct(frame: EvilandFrame, dtMs: number): EvilandFrame;
  dispose(): void;
}

/**
 * What the look-ahead is doing for the track on screen — for the toolbar.
 *   off          the user disabled it
 *   idle         no Eviland visualizer is running, or nothing is playing
 *   analysing    first play of this track; cues start when the score arrives
 *   scored       conducting from the score
 *   unavailable  this source can't be scored (stream, very short, unreadable)
 */
export type SongScoreStatus = 'off' | 'idle' | 'analysing' | 'scored' | 'unavailable';
let status: SongScoreStatus = 'idle';
export function songScoreStatus(): SongScoreStatus {
  if (!lookAheadEnabled()) return 'off';
  return activeFeeds > 0 ? status : 'idle';
}

// A handful of recent tracks: the current one, the prefetched next one, and
// whatever the listener skips back to.
const RECENT_SCORES = 8;
const recent = new Map<number, Promise<SongScore | null>>();
let activeFeeds = 0;

function scoreFor(trackId: number): Promise<SongScore | null> {
  const known = recent.get(trackId);
  if (known) {
    // Re-insert so the map's insertion order stays least-recently-used first.
    recent.delete(trackId);
    recent.set(trackId, known);
    return known;
  }
  const request = api.getSongScore(trackId).catch(() => null);
  recent.set(trackId, request);
  // A failed or empty answer may only mean "file was busy"; let a later play retry.
  void request.then((score) => {
    if (!score && recent.get(trackId) === request) recent.delete(trackId);
  });
  while (recent.size > RECENT_SCORES) recent.delete(recent.keys().next().value as number);
  return request;
}

// Live diagnostics for smokes/DevTools (same idea as __newampProducerDiag).
let lastCues: EvilandFrame['score'];
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__newampScoreFeed', {
    configurable: true,
    get: () => ({
      status: songScoreStatus(),
      activeFeeds,
      tier: lastCues?.tier ?? null,
      arc: lastCues ? Math.round(lastCues.arc * 1000) / 1000 : null,
    }),
  });
}

/**
 * Warm the score for a track that is about to play (the gapless prepare calls
 * this). Does nothing unless an Eviland visualizer is actually running, so
 * listeners who never open one never pay for the analysis.
 */
export function prefetchSongScore(trackId: number | null | undefined): void {
  if (activeFeeds > 0 && lookAheadEnabled() && trackId != null && trackId > 0) void scoreFor(trackId);
}

/**
 * The feed every NewAmp consumer wants: track identity and position both come
 * from the ENGINE, so they can never disagree across a gapless or crossfaded
 * handoff (the store's `current` flips a moment before or after the deck
 * does). `getCurrent` only supplies the cue-sheet offset for that track.
 */
export function createEngineScoreFeed(
  engine: { getState(): { trackId: number | null }; getPlaybackPosition(): number },
  getCurrent: () => ScoreFeedTrack | null,
): ScoreFeed {
  return createScoreFeed({
    getTrack() {
      const id = engine.getState().trackId;
      if (id == null) return null;
      const current = getCurrent();
      return { id, cueStart: current?.id === id ? current.cueStart : null };
    },
    getPosition: () => engine.getPlaybackPosition(),
  });
}

export function createScoreFeed(deps: ScoreFeedDeps): ScoreFeed {
  const conductor = createConductor();
  let boundTrackId: number | null = null;
  let disposed = false;
  // The preference is a localStorage read; check it twice a second, not per frame.
  let enabled = lookAheadEnabled();
  let enabledCheckedAt = 0;
  activeFeeds += 1;

  function bind(track: ScoreFeedTrack | null): void {
    boundTrackId = track?.id ?? null;
    conductor.setScore(null);
    if (!track) {
      status = 'idle';
      return;
    }
    const id = track.id;
    status = 'analysing';
    void scoreFor(id).then((score) => {
      if (disposed || boundTrackId !== id) return;
      conductor.setScore(score);
      status = score ? 'scored' : 'unavailable';
    });
  }

  return {
    conduct(frame, dtMs) {
      const now = performance.now();
      if (now - enabledCheckedAt > 500) {
        enabledCheckedAt = now;
        const next = lookAheadEnabled();
        if (next !== enabled) {
          enabled = next;
          // Force a rebind so turning it back on fetches the current track.
          boundTrackId = null;
          conductor.setScore(null);
        }
      }
      if (!enabled) {
        if (frame.score) frame.score = undefined;
        return frame;
      }
      const track = deps.getTrack();
      if ((track?.id ?? null) !== boundTrackId) bind(track);
      if (!track || !conductor.hasScore()) {
        // The reactor hands out the SAME frame object every call, so the last
        // track's cues are still on it. Without this, its dimming, blackout,
        // hue shift and tier bleed into the next track until a score arrives
        // (or for the whole track, when it never gets one).
        if (frame.score) frame.score = undefined;
        lastCues = undefined;
        return frame;
      }
      const cueStart = Number.isFinite(track.cueStart) && track.cueStart! > 0 ? track.cueStart! : 0;
      conductor.conduct(frame, deps.getPosition() - cueStart, dtMs);
      lastCues = frame.score;
      return frame;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      activeFeeds = Math.max(0, activeFeeds - 1);
      conductor.setScore(null);
    },
  };
}
