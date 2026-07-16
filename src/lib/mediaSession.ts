import type { Track } from '@shared/types';
import {
  buildMediaSessionMetadata,
  mediaSessionPlaybackState,
  mediaSessionPositionState,
} from '@shared/media-session';
import { api } from './api';

interface MediaSessionActions {
  play: () => void;
  pause: () => void;
  previous: () => void;
  next: () => void;
  stop: () => void;
  seek: (position: number) => void;
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
    session.metadata = null;
    return;
  }

  const artUrl = current.hasArt ? api.getArtUrl(current.id) : null;
  if (typeof MediaMetadata !== 'undefined') {
    session.metadata = new MediaMetadata(buildMediaSessionMetadata(current, artUrl));
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
