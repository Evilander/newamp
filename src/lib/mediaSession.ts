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
  /** Move by this many seconds, negative to go back. */
  seekBy: (seconds: number) => void;
}

// What the OS asks for when the headphones or the lock screen skip within a
// track and name no distance.
const DEFAULT_SEEK_OFFSET_S = 10;

const APP_TITLE = 'NewAmp';

/**
 * The window's title: the playing track, or the app's name with nothing
 * loaded. The title bar is hidden, but the Window menu, Mission Control, the
 * Cmd+Tab list and VoiceOver read it.
 */
export function windowTitleFor(current: Track | null): string {
  if (!current) return APP_TITLE;
  const title = current.title.trim() || 'Unknown Track';
  const artist = current.artist.trim();
  return artist ? `${title} - ${artist}` : title;
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
 * state, the OS action handlers, and metadata (title/artist/art). Split
 * out from position sync (below) so callers can gate this behind an effect
 * keyed on track identity + isPlaying instead of the 10Hz currentTime tick —
 * rebuilding a MediaMetadata + re-registering the action handlers 10x/sec for
 * the whole session was pure churn.
 *
 * The OS shows Previous and Next enabled only while they have a handler, so
 * they are registered only when they would go somewhere. Both default to
 * available.
 */
export function syncMediaSessionIdentity({
  current,
  isPlaying,
  actions: requested,
  hasPrevious = true,
  hasNext = true,
}: {
  current: Track | null;
  isPlaying: boolean;
  actions: MediaSessionActions;
  hasPrevious?: boolean;
  hasNext?: boolean;
}): void {
  if (!('mediaSession' in navigator)) return;

  const session = navigator.mediaSession;
  const actions = {
    ...requested,
    previous: hasPrevious ? requested.previous : null,
    next: hasNext ? requested.next : null,
  };
  session.playbackState = mediaSessionPlaybackState(isPlaying, current);
  setMediaSessionAction(session, 'play', actions.play);
  setMediaSessionAction(session, 'pause', actions.pause);
  setMediaSessionAction(session, 'previoustrack', actions.previous);
  setMediaSessionAction(session, 'nexttrack', actions.next);
  setMediaSessionAction(session, 'stop', actions.stop);
  setMediaSessionAction(session, 'seekto', (details) => {
    if (typeof details.seekTime === 'number') actions.seek(details.seekTime);
  });
  setMediaSessionAction(session, 'seekbackward', (details) => {
    actions.seekBy(-seekOffset(details.seekOffset));
  });
  setMediaSessionAction(session, 'seekforward', (details) => {
    actions.seekBy(seekOffset(details.seekOffset));
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

function seekOffset(requested: number | undefined): number {
  return typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_SEEK_OFFSET_S;
}

function setMediaSessionAction(
  session: MediaSession,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
): void {
  try {
    session.setActionHandler(action, handler);
  } catch {
    // Older Chromium builds do not support every action on every platform.
  }
}
