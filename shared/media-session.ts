import type { Track } from './types.js';

export interface NewAmpMediaImage {
  src: string;
  sizes: string;
  type: string;
}

export interface NewAmpMediaMetadata {
  title: string;
  artist: string;
  album: string;
  artwork: NewAmpMediaImage[];
}

export interface NewAmpMediaPositionState {
  duration: number;
  position: number;
  playbackRate: number;
}

export type NewAmpMediaPlaybackState = 'none' | 'paused' | 'playing';

export function buildMediaSessionMetadata(track: Track, artUrl: string | null): NewAmpMediaMetadata {
  return {
    title: track.title.trim() || 'Unknown Track',
    artist: track.artist.trim() || 'Unknown Artist',
    album: track.album.trim(),
    artwork: artUrl ? [{ src: artUrl, sizes: '512x512', type: 'image/jpeg' }] : [],
  };
}

export function mediaSessionPlaybackState(
  playing: boolean,
  current: Track | null,
): NewAmpMediaPlaybackState {
  if (!current) return 'none';
  return playing ? 'playing' : 'paused';
}

export function mediaSessionPositionState({
  duration,
  currentTime,
  playbackRate,
}: {
  duration: number | null | undefined;
  currentTime: number;
  playbackRate: number;
}): NewAmpMediaPositionState | null {
  if (!Number.isFinite(duration) || !duration || duration <= 0) return null;
  const safeDuration = Math.max(0, duration);
  const position = Math.max(0, Math.min(safeDuration, Number.isFinite(currentTime) ? currentTime : 0));
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  return { duration: safeDuration, position, playbackRate: rate };
}
