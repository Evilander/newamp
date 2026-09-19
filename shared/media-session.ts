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

export interface MediaSessionPositionSnapshot {
  trackId: number;
  duration: number;
  position: number;
  playbackRate: number;
  playing: boolean;
  atMs: number;
}

// The OS extrapolates the scrub position from the last state it was given,
// so it only needs a new one when that extrapolation goes wrong: track,
// duration, rate or play/pause changed, or the playhead jumped (a seek).
// Pushing it on every 10 Hz tick was an IPC hop (and on Linux, MPRIS D-Bus
// traffic) ten times a second for the whole session.
export function mediaSessionPositionNeedsSync(
  prev: MediaSessionPositionSnapshot | null,
  next: MediaSessionPositionSnapshot,
  toleranceSec = 1,
): boolean {
  if (!prev) return true;
  // Object.is, not !==: duration is NaN until the track's metadata lands, and
  // NaN !== NaN would report a change on every tick through that window.
  if (
    prev.trackId !== next.trackId ||
    !Object.is(prev.duration, next.duration) ||
    prev.playbackRate !== next.playbackRate ||
    prev.playing !== next.playing
  ) {
    return true;
  }
  const elapsedSec = prev.playing ? ((next.atMs - prev.atMs) / 1000) * prev.playbackRate : 0;
  return Math.abs(next.position - (prev.position + elapsedSec)) > toleranceSec;
}
