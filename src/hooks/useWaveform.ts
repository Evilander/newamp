import { useEffect, useRef, useState } from 'react';
import { isShuffleMode, repeatModeOf } from '@shared/types';
import type { PlaybackMode, Track, WaveformData } from '@shared/types';
import { api } from '../lib/api';
import { isWaveformData } from '../lib/waveform-path';

export type WaveformTrack = Pick<Track, 'id' | 'path' | 'size' | 'mtime' | 'cueStart' | 'cueEnd'>;

export type WaveformStatus =
  /** The seek bar is set to plain. */
  | 'off'
  /** Being decoded; the bar shows a flat line meanwhile. */
  | 'loading'
  | 'ready'
  /** A stream, a server track or a file that can't be decoded. */
  | 'none';

export interface WaveformState {
  status: WaveformStatus;
  data: WaveformData | null;
}

/** Waveforms kept for tracks heard lately, so going back a track costs no round trip. */
const REMEMBERED = 12;
const remembered = new Map<string, WaveformData>();
const loading = new Map<string, Promise<WaveformData | null>>();
const prefetching = new Set<string>();

/**
 * What identifies a waveform: the track and the file it was built from. Null
 * for a track the main process can't decode (podcast episodes have negative
 * ids; server tracks and streams carry a URL).
 */
export function waveformKey(track: WaveformTrack | null | undefined): string | null {
  if (!track || track.id <= 0 || !track.path || /^[a-z][a-z0-9+.-]*:\/\//i.test(track.path)) return null;
  return `${track.id}|${track.size ?? ''}|${track.mtime ?? ''}|${track.cueStart ?? ''}|${track.cueEnd ?? ''}`;
}

export function peekWaveform(key: string): WaveformData | null {
  const hit = remembered.get(key);
  if (!hit) return null;
  // Most recently used goes last, so the oldest is the first to go.
  remembered.delete(key);
  remembered.set(key, hit);
  return hit;
}

function remember(key: string, data: WaveformData): void {
  remembered.delete(key);
  remembered.set(key, data);
  while (remembered.size > REMEMBERED) remembered.delete(remembered.keys().next().value as string);
}

async function fetchWaveform(track: WaveformTrack, key: string, prefetch: boolean): Promise<WaveformData | null> {
  try {
    const raw = await api.getTrackWaveform(track.id, prefetch ? { prefetch: true } : undefined);
    if (!isWaveformData(raw)) return null;
    remember(key, raw);
    return raw;
  } catch {
    return null;
  }
}

/**
 * The waveform for a track, asked for at once. A miss is not remembered: the
 * main process may have dropped the request for a newer one, and it keeps its
 * own note of tracks that can't be decoded.
 */
export function loadWaveform(track: WaveformTrack): Promise<WaveformData | null> {
  const key = waveformKey(track);
  if (!key) return Promise.resolve(null);
  const hit = peekWaveform(key);
  if (hit) return Promise.resolve(hit);
  let pending = loading.get(key);
  if (!pending) {
    pending = fetchWaveform(track, key, false).finally(() => loading.delete(key));
    loading.set(key, pending);
  }
  return pending;
}

/** Warm the waveform for a track that is likely to play next. It queues behind the current one. */
export function prefetchWaveform(track: WaveformTrack): void {
  const key = waveformKey(track);
  if (!key || remembered.has(key) || loading.has(key) || prefetching.has(key)) return;
  prefetching.add(key);
  void fetchWaveform(track, key, true).finally(() => prefetching.delete(key));
}

/**
 * The track that follows in the queue, if it can be known: a shuffle picks at
 * the handoff, so there is nothing to warm ahead of time.
 */
export function nextQueuedTrack(queue: readonly Track[], index: number, mode: PlaybackMode): Track | null {
  if (isShuffleMode(mode) || index < 0) return null;
  const repeat = repeatModeOf(mode);
  if (repeat === 'one') return queue[index] ?? null;
  return queue[index + 1] ?? (repeat === 'all' ? queue[0] ?? null : null);
}

/**
 * The waveform of `track` for the seek bar, and a warm-up of `next`. With
 * `enabled` false nothing is requested. Re-renders only when the status or
 * data changes, not on every playhead tick.
 */
export function useWaveform(
  track: WaveformTrack | null,
  enabled: boolean,
  next: WaveformTrack | null = null,
): WaveformState {
  const key = enabled ? waveformKey(track) : null;
  const trackRef = useRef(track);
  trackRef.current = track;
  const nextRef = useRef(next);
  nextRef.current = next;
  const [settled, setSettled] = useState<{ key: string; data: WaveformData | null } | null>(null);

  useEffect(() => {
    const wanted = trackRef.current;
    if (!key || !wanted || peekWaveform(key)) return undefined;
    let live = true;
    void loadWaveform(wanted).then((data) => {
      if (live) setSettled({ key, data });
    });
    return () => {
      live = false;
    };
  }, [key]);

  const cached = key ? peekWaveform(key) : null;
  const state: WaveformState = !enabled
    ? { status: 'off', data: null }
    : !key
      ? { status: 'none', data: null }
      : cached
        ? { status: 'ready', data: cached }
        : settled?.key === key
          ? { status: 'none', data: null }
          : { status: 'loading', data: null };

  const nextKey = enabled ? waveformKey(next) : null;
  const settledNow = state.status !== 'loading';
  useEffect(() => {
    if (nextKey && nextRef.current && settledNow) prefetchWaveform(nextRef.current);
  }, [nextKey, settledNow]);

  return state;
}
