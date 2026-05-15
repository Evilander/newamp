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

export function syncMediaSession({
  current,
  isPlaying,
  currentTime,
  duration,
  playbackRate,
  actions,
}: {
  current: Track | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
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

  const position = mediaSessionPositionState({ duration, currentTime, playbackRate });
  if (position) {
    try {
      session.setPositionState(position);
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
