import type { Track } from '@shared/types';
import {
  buildMediaSessionMetadata,
  mediaSessionPlaybackState,
  mediaSessionPositionState,
} from '@shared/media-session';
import { api } from './api';
import type { MediaArtworkImage } from './media-artwork';

interface MediaSessionActions {
  play: () => void;
  pause: () => void;
  previous: () => void;
  next: () => void;
  stop: () => void;
  seek: (position: number) => void;
}

// The cover reader (and the canvas work behind it) is its own chunk, fetched
// the first time a track with art plays rather than carried by every start.
let artwork: typeof import('./media-artwork').mediaArtwork | null = null;
// The track whose metadata the OS shows now; a cover that arrives for any
// other one is not published.
let activeTrackId: number | null = null;

async function loadArtwork(trackId: number, coverUrl: string): Promise<MediaArtworkImage | null> {
  artwork ??= (await import('./media-artwork')).mediaArtwork;
  return artwork.load(trackId, coverUrl);
}

function publishMetadata(track: Track, image: MediaArtworkImage | null): void {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  navigator.mediaSession.metadata = new MediaMetadata(
    buildMediaSessionMetadata(track, image?.src ?? null, image ?? undefined),
  );
}

/**
 * Sync everything that only changes on track change / play-pause: playback
 * state, the six OS action handlers, and metadata (title/artist/art). Split
 * out from position sync (below) so callers can gate this behind an effect
 * keyed on track identity + isPlaying instead of the 10Hz currentTime tick —
 * rebuilding a MediaMetadata + re-registering six action handlers 10x/sec for
 * the whole session was pure churn.
 */
export function syncMediaSessionIdentity({
  current,
  isPlaying,
  actions,
}: {
  current: Track | null;
  isPlaying: boolean;
  actions: MediaSessionActions;
}): void {
  if (!('mediaSession' in navigator)) return;

  const session = navigator.mediaSession;
  session.playbackState = mediaSessionPlaybackState(isPlaying, current);
  setMediaSessionAction(session, 'play', actions.play);
  setMediaSessionAction(session, 'pause', actions.pause);
  setMediaSessionAction(session, 'previoustrack', actions.previous);
  setMediaSessionAction(session, 'nexttrack', actions.next);
  setMediaSessionAction(session, 'stop', actions.stop);
  setMediaSessionAction(session, 'seekto', (details) => {
    if (typeof details.seekTime === 'number') actions.seek(details.seekTime);
  });

  if (!current) {
    activeTrackId = null;
    artwork?.release();
    session.metadata = null;
    return;
  }

  activeTrackId = current.id;
  const coverUrl = current.hasArt ? api.getArtUrl(current.id) : null;
  const image = coverUrl ? (artwork?.peek(current.id) ?? null) : null;
  publishMetadata(current, image);
  if (coverUrl && !image) {
    // Title and artist go out now; the cover follows once it has been read.
    void loadArtwork(current.id, coverUrl)
      .then((loaded) => {
        if (loaded && activeTrackId === current.id) publishMetadata(current, loaded);
      })
      .catch(() => undefined);
  }
}

/**
 * Sync the OS scrub-bar position. Called from the 10Hz currentTime tick —
 * kept separate from syncMediaSessionIdentity so the metadata/action-handler
 * work above doesn't redo itself every tick alongside this one.
 */
export function syncMediaSessionPosition({
  current,
  currentTime,
  duration,
  playbackRate,
}: {
  current: Track | null;
  currentTime: number;
  duration: number;
  playbackRate: number;
}): void {
  if (!('mediaSession' in navigator)) return;
  if (!current) return;

  const position = mediaSessionPositionState({ duration, currentTime, playbackRate });
  if (position) {
    try {
      navigator.mediaSession.setPositionState(position);
    } catch {
      // Chromium can reject stale position states during rapid track switches.
    }
  }
}

function setMediaSessionAction(
  session: MediaSession,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler,
): void {
  try {
    session.setActionHandler(action, handler);
  } catch {
    // Older Chromium builds do not support every action on every platform.
  }
}
