import { create } from 'zustand';
import type {
  AppSettings,
  CustomSkin,
  LastfmTrackPayload,
  PlaybackMode as SharedPlaybackMode,
  PlaybackResumeState,
  PodcastEpisode,
  Track,
} from '@shared/types';
import { AudioEngine } from '../audio/engine';
import { api, inElectron, toAudioUrl, winctl, DEFAULT_SETTINGS } from '../lib/api';
import { decode as decodeEvilandCode } from '../visualizer/eviland-randomizer';
import {
  notifyPlayCompleted,
  notifyLove,
  notifySkip,
} from '../visualizer/eviland-memory-bridge-registry';
import { applyTheme } from '../lib/skins';
import { normalizePlaybackRate } from '@shared/tempo-trainer';
import { normalizeAudioOutputDeviceId } from '@shared/audio-output';
import { normalizePreampDb } from '@shared/audio-limiter';
import { normalizeEqValues } from '@shared/eq-presets';
import {
  autoDjSmartRuleCandidateCount,
  normalizeAutoDjTarget,
  selectAutoDjAdditions,
  shouldAutoDjRefill,
} from '@shared/auto-dj';
import { moveQueueItem, removeQueueItem } from '@shared/queue-edit';
import {
  appendTracksToQueue,
  appendTrackToQueue,
  insertTracksNext,
  insertTrackNext,
} from '@shared/queue-insert';
import { handoffKey, shouldPrepareTrackHandoff, shouldStartTrackHandoff } from '@shared/playback-handoff';
import { resolvePlaybackStartIndex } from '@shared/playback-start';
import {
  shouldStopAfterCurrent,
  shouldStopForSleepTimer,
  sleepTimerEndTime,
  stopAfterCurrentKey,
} from '@shared/playback-controls';
import { playbackErrorKey, resolvePlaybackErrorAdvance } from '@shared/playback-error';
import {
  nextSmartShuffle,
  previousSmartShuffle,
  resetSmartShuffleHistory,
} from '@shared/smart-shuffle';

export type PlaybackMode = SharedPlaybackMode;

export type ViewMode =
  | 'home'
  | 'library'
  | 'folders'
  | 'discover'
  | 'mixes'
  | 'albums'
  | 'artists'
  | 'playlist'
  | 'loved'
  | 'history'
  | 'wrapped'
  | 'profile'
  | 'tags'
  | 'podcasts'
  | 'radio'
  | 'now-playing'
  | 'about'
  | 'settings';

interface PlayerState {
  engine: AudioEngine;
  queue: Track[];
  index: number;
  current: Track | null;
  isPlaying: boolean;
  currentTime: number;
  resumeAt: number | null;
  duration: number;
  playbackError: string | null;
  volume: number;
  playbackRate: number;
  audioOutputDeviceId: string | null;
  autoDjEnabled: boolean;
  autoDjTarget: number;
  autoDjSmartRuleId: number | null;
  stopAfterCurrent: boolean;
  sleepTimerEndsAt: number | null;
  shuffleHistory: number[];
  activePodcastEpisode: { feedUrl: string; episodeId: string } | null;
  mode: PlaybackMode;
  settings: AppSettings | null;
  view: ViewMode;
  fullscreenViz: boolean;
  compactMode: boolean;
  alwaysOnTop: boolean;
  vizPreset: AppSettings['visualizerPreset'];
  /** Eviland AI Director: when on, the renderer's look conducts itself to the song. */
  evilandDirector: boolean;
  /** Last seed code applied to Eviland (display + share). Null = renderer default. */
  evilandSeed: string | null;
  /**
   * Bumped whenever the UI requests a new manual Eviland config (randomize,
   * seed paste). The Visualizer rAF loop tracks the last-applied nonce and
   * only calls renderer.setConfig() when it changes — keeps the hot loop
   * allocation-free under steady state.
   */
  evilandConfigNonce: number;
  /** Optional waveform-layer override applied on top of the active config. */
  evilandWaveMode: 'off' | 'line' | 'radial' | 'bars';
  searchQuery: string;
  showEq: boolean;
  /** One-shot navigation request consumed by destination views on mount/render. */
  pendingNavigation:
    | null
    | { kind: 'artist'; name: string }
    | { kind: 'album'; album: string; albumArtist: string }
    | {
        kind: 'album-with-track';
        album: string;
        albumArtist: string;
        trackId: number | null;
        trackTitle: string | null;
      };
  init: () => Promise<void>;
  persistPlaybackSession: () => Promise<void>;
  setView: (v: ViewMode) => void;
  navigateToArtist: (name: string) => void;
  navigateToAlbum: (album: string, albumArtist: string) => void;
  navigateToTrack: (track: {
    id?: number;
    title?: string | null;
    album?: string | null;
    albumArtist?: string | null;
    artist?: string | null;
  }) => void;
  consumePendingNavigation: () => void;
  toggleEq: () => void;
  setFullscreenViz: (on: boolean) => void;
  setCompactMode: (on: boolean) => void;
  setAlwaysOnTop: (on: boolean) => void;
  setVizPreset: (name: AppSettings['visualizerPreset']) => void;
  toggleEvilandDirector: () => void;
  /**
   * Mint a new Eviland look. When `seed` is omitted, derive it deterministically
   * from the current nonce so the result is reproducible across reloads (no
   * Math.random / Date.now in the store; the randomizer hashes the string).
   */
  randomizeEviland: (seed?: string) => void;
  /** Apply a shared seed code (e.g. "K7Q2-9XMF"). Returns true on decode success. */
  applyEvilandCode: (code: string) => boolean;
  setEvilandWaveMode: (mode: 'off' | 'line' | 'radial' | 'bars') => void;
  setSearchQuery: (q: string) => void;
  playTrack: (track: Track, queue?: Track[]) => Promise<void>;
  playPodcastEpisode: (episode: PodcastEpisode) => Promise<void>;
  playQueue: (tracks: Track[], startIndex?: number) => Promise<void>;
  loadQueue: (tracks: Track[]) => void;
  queueTrackNext: (track: Track) => void;
  addTrackToQueue: (track: Track) => void;
  queueTracksNext: (tracks: Track[]) => void;
  addTracksToQueue: (tracks: Track[]) => void;
  moveQueuedTrack: (fromIndex: number, toIndex: number) => void;
  removeQueuedTrack: (index: number) => Promise<void>;
  clearQueue: () => void;
  togglePlay: () => void;
  next: () => Promise<void>;
  prev: () => Promise<void>;
  seek: (t: number) => void;
  setVolume: (v: number) => Promise<void>;
  setPlaybackRate: (rate: number) => Promise<void>;
  setAudioOutputDevice: (deviceId: string | null) => Promise<void>;
  playOutputTestTone: () => Promise<void>;
  setAutoDjEnabled: (enabled: boolean) => Promise<void>;
  setAutoDjTarget: (target: number) => Promise<void>;
  setAutoDjSmartRuleId: (id: number | null) => Promise<void>;
  setStopAfterCurrent: (enabled: boolean) => void;
  setSleepTimerMinutes: (minutes: number | null) => void;
  clearSleepTimer: () => void;
  refillAutoDjQueue: (force?: boolean) => Promise<Track[]>;
  setMode: (m: PlaybackMode) => void;
  setEqBand: (i: number, dB: number) => Promise<void>;
  setEqPreset: (values: number[]) => Promise<void>;
  setEqEnabled: (on: boolean) => Promise<void>;
  toggleLove: (id: number) => Promise<boolean>;
  setTrackRating: (id: number, rating: number) => Promise<Track | null>;
  setTrackRatingScore: (id: number, score: number | null) => Promise<Track | null>;
  toggleAvoidAutoPlay: (id: number) => Promise<Track | null>;
  setTheme: (theme: AppSettings['theme']) => Promise<void>;
  setCrossfadeMs: (ms: number) => Promise<void>;
  setReplayGainMode: (mode: AppSettings['replayGain']) => Promise<void>;
  setLimiterEnabled: (enabled: boolean) => Promise<void>;
  setPreampDb: (db: number) => Promise<void>;
  saveCustomSkin: (skin: CustomSkin) => Promise<void>;
}

// Debounce settings.json writes triggered by high-frequency volume changes.
// The wheel-anywhere-over-fullscreen-viz handler (added 1.5.4) fires 60-120
// WheelEvents/sec on rapid scroll; each pre-debounce setVolume call hit
// settings.persist() which writeFileSync's the whole settings JSON. On HDD
// that meant the main process spent ~300-900ms/sec blocked in I/O. The
// Web Audio gain ramp must stay synchronous (volume is a real-time
// control), so we only debounce the persist side. AppSettings is the only
// caller path that touches disk; the in-memory store updates immediately.
let volumePersistTimer: ReturnType<typeof setTimeout> | null = null;
let volumePersistPending: number | null = null;
const VOLUME_PERSIST_DEBOUNCE_MS = 250;
function schedulePersistVolume(
  volume: number,
  apply: (updated: AppSettings) => void,
): void {
  volumePersistPending = volume;
  if (volumePersistTimer != null) return;
  volumePersistTimer = setTimeout(() => {
    const pending = volumePersistPending;
    volumePersistTimer = null;
    volumePersistPending = null;
    if (pending == null) return;
    void api
      .setSettings({ volume: pending })
      .then(apply)
      .catch((err) => console.error('[newamp] persist volume failed:', err));
  }, VOLUME_PERSIST_DEBOUNCE_MS);
}

function toLastfmTrack(track: Track): LastfmTrackPayload {
  return {
    artist: track.artist,
    title: track.title,
    album: track.album || null,
    albumArtist: track.albumArtist || null,
    duration: track.duration,
    trackNumber: track.trackNo,
  };
}

function startLastfmNowPlaying(track: Track): void {
  lastfmPlayStartedAt = Math.floor(Date.now() / 1000);
  lastfmPlayKey = `${track.id}:${lastfmPlayStartedAt}`;
  lastfmScrobbledKey = '';
  void api.lastfmUpdateNowPlaying(toLastfmTrack(track)).catch(() => undefined);
}

function maybeScrobbleToLastfm(state: PlayerState, currentTime: number, playing: boolean): void {
  const track = state.current;
  const duration = track?.duration ?? 0;
  if (!track || !playing || !state.settings?.lastfmEnabled || !lastfmPlayKey) return;
  if (!lastfmPlayKey.startsWith(`${track.id}:`) || lastfmScrobbledKey === lastfmPlayKey) return;
  if (duration <= 30 || currentTime < Math.min(duration / 2, 240)) return;

  lastfmScrobbledKey = lastfmPlayKey;
  void api.lastfmScrobble(toLastfmTrack(track), lastfmPlayStartedAt).catch(() => {
    lastfmScrobbledKey = '';
  });
}

function shouldRecordManualSkip(state: PlayerState): boolean {
  const track = state.current;
  if (!track || track.id <= 0 || !state.isPlaying) return false;
  const duration = track.duration ?? state.duration ?? 0;
  if (duration <= 30) return false;
  const currentTime = Math.max(0, state.currentTime);
  if (currentTime < 5) return false;
  return currentTime < Math.min(duration / 2, 120);
}

function recordManualSkip(state: PlayerState): void {
  if (!shouldRecordManualSkip(state) || !state.current) return;
  void api.recordSkip(state.current.id, state.currentTime).catch(() => undefined);
  // Mirror the library skip into the eviland memory bridge so the skips
  // counter advances. No lineage effect on its own (per the bridge contract)
  // but it shows up in the badge popover and feeds future heuristics.
  notifySkip(state.current.id);
}

function replayGainDbForTrack(
  track: Track | null,
  settings: AppSettings | null,
): number | null {
  if (!track || !settings || settings.replayGain === 'off') return null;
  if (settings.replayGain === 'album') {
    return track.replayGainAlbumDb ?? track.replayGainTrackDb ?? null;
  }
  return track.replayGainTrackDb ?? null;
}

function applyReplayGain(track: Track | null, settings: AppSettings | null): void {
  engine.setReplayGainDb(replayGainDbForTrack(track, settings));
}

export const engine = new AudioEngine();
const CONTEXT_EXPANSION_LIMIT = 300;

let lastfmPlayStartedAt = 0;
let lastfmPlayKey = '';
let lastfmScrobbledKey = '';
let lastSessionPersistAt = 0;
let lastPodcastProgressPersistAt = 0;
let lastHandoffKey: string | null = null;
let lastPreparedHandoffKey: string | null = null;
let lastStopAfterCurrentKey: string | null = null;
let lastPlaybackErrorKey: string | null = null;

// Shell integration (Windows thumbar, tray tooltip, NewAmp Remote): push a
// playback snapshot to the main process when the (playing, track) pair
// changes, when volume moves, on seek jumps, and otherwise at most every 5s
// of position — the engine notifies at 10Hz and neither the shell nor a
// phone remote needs that (remote clients interpolate between snapshots).
let lastShellPlaybackKey = '';
let lastShellPosition = -1;
function notifyShellPlayback(state: PlayerState): void {
  const positionBucket = Math.floor(state.currentTime / 5);
  const seekJump = Math.abs(state.currentTime - lastShellPosition) > 6;
  const key = `${state.isPlaying ? 1 : 0}|${state.current?.id ?? 'none'}|${positionBucket}|${Math.round(state.volume * 50)}`;
  if (key === lastShellPlaybackKey && !seekJump) return;
  lastShellPlaybackKey = key;
  lastShellPosition = state.currentTime;
  winctl.notifyPlayback({
    isPlaying: state.isPlaying,
    title: state.current?.title ?? null,
    artist: state.current?.artist ?? null,
    album: state.current?.album ?? null,
    trackId: state.current?.id ?? null,
    position: state.currentTime,
    duration: state.duration,
    volume: state.volume,
  });
}
let lastCueEndKey: string | null = null;
let playbackErrorAdvanceTimer: number | null = null;

async function restorePlaybackSession(
  resumeState: PlaybackResumeState | null,
  settings: AppSettings,
  setState: (partial: Partial<PlayerState>) => void,
): Promise<void> {
  if (!resumeState?.queueTrackIds.length) return;
  const tracks = (
    await Promise.all(resumeState.queueTrackIds.map((id) => api.getTrack(id).catch(() => null)))
  ).filter((track): track is Track => !!track);
  if (!tracks.length) return;
  const index = Math.max(0, Math.min(resumeState.index, tracks.length - 1));
  const current = tracks[index] ?? null;
  setState({
    queue: tracks,
    index,
    current,
    currentTime: resumeState.currentTime,
    duration: current?.duration ?? 0,
    mode: resumeState.mode,
    shuffleHistory: resumeState.mode === 'shuffle' ? resetSmartShuffleHistory(tracks.length, index) : [],
    resumeAt: resumeState.currentTime,
  });
  applyReplayGain(current, settings);
}

async function persistPlaybackSession(state: PlayerState): Promise<void> {
  if (!state.settings) return;
  const resumeState: PlaybackResumeState | null = state.queue.length
    ? {
        queueTrackIds: state.queue.map((track) => track.id),
        index: Math.max(-1, state.index),
        currentTime: Math.max(0, state.currentTime),
        mode: state.mode,
        updatedAt: Date.now(),
      }
    : null;
  await api.setSettings({ resumeState }).catch(() => state.settings!);
}

function schedulePersistPlaybackSession(state: PlayerState, force = false): void {
  if (!state.settings) return;
  const now = Date.now();
  if (!force && now - lastSessionPersistAt < 3000) return;
  lastSessionPersistAt = now;
  void persistPlaybackSession(state);
}

function persistPodcastProgress(state: PlayerState, force = false, completed = false): void {
  if (!state.activePodcastEpisode) return;
  const now = Date.now();
  if (!force && now - lastPodcastProgressPersistAt < 5000) return;
  lastPodcastProgressPersistAt = now;
  void api.updatePodcastEpisodeProgress({
    feedUrl: state.activePodcastEpisode.feedUrl,
    episodeId: state.activePodcastEpisode.episodeId,
    position: state.currentTime,
    duration: state.duration,
    completed,
  }).catch(() => undefined);
}

function clearPlaybackErrorAdvanceTimer(): void {
  if (playbackErrorAdvanceTimer != null) {
    window.clearTimeout(playbackErrorAdvanceTimer);
    playbackErrorAdvanceTimer = null;
  }
}

function playbackFailureLabel(track: Track | null, error: string): string {
  const name = track ? `${track.artist} - ${track.title}` : 'track';
  return `Skipped ${name}: ${error}`;
}

async function advanceAfterPlaybackError(
  getState: () => PlayerState,
  setState: (partial: Partial<PlayerState>) => void,
  failedKey: string,
): Promise<void> {
  const state = getState();
  const current = state.current;
  const key = playbackErrorKey({
    error: state.playbackError,
    currentTrackId: current?.id ?? null,
    index: state.index,
  });
  if (!current || key !== failedKey || state.queue.length <= 1) {
    engine.stop();
    return;
  }

  let nextIndex = state.index + 1;
  let nextShuffleHistory = state.shuffleHistory;
  if (state.mode === 'shuffle') {
    const decision = nextSmartShuffle({
      queueLength: state.queue.length,
      currentIndex: state.index,
      history: state.shuffleHistory,
    });
    nextIndex = decision.index;
    nextShuffleHistory = decision.history;
  } else if (nextIndex >= state.queue.length && (state.mode === 'repeat-all' || state.mode === 'repeat-one')) {
    nextIndex = 0;
  }

  if (nextIndex < 0 || nextIndex >= state.queue.length || nextIndex === state.index) {
    engine.stop();
    return;
  }

  const nextTrack = state.queue[nextIndex]!;
  lastPreparedHandoffKey = null;
  lastStopAfterCurrentKey = null;
  setState({
    index: nextIndex,
    current: nextTrack,
    currentTime: 0,
    duration: nextTrack.duration ?? 0,
    resumeAt: null,
    activePodcastEpisode: null,
    shuffleHistory: nextShuffleHistory,
    playbackError: playbackFailureLabel(current, state.playbackError ?? 'Playback failed'),
  });
  applyReplayGain(nextTrack, state.settings);
  schedulePersistPlaybackSession(getState(), true);
  try {
    await playEngineTrack(nextTrack);
    lastPlaybackErrorKey = null;
    startLastfmNowPlaying(nextTrack);
    recordLibraryPlay(nextTrack);
    if (shouldAutoDjRefill({ enabled: getState().autoDjEnabled, queueLength: getState().queue.length, index: nextIndex })) {
      void getState().refillAutoDjQueue();
    }
  } catch {
    // The engine publishes the next error; the subscription schedules the next skip.
  }
}

function podcastEpisodeToTrack(episode: PodcastEpisode): Track {
  return {
    id: -Math.abs(hashEpisodeId(episode.id)),
    path: episode.downloadPath ?? episode.audioUrl,
    title: episode.title,
    artist: episode.feedTitle,
    album: episode.feedTitle,
    albumArtist: episode.feedTitle,
    trackNo: null,
    discNo: null,
    year: episode.publishedAt ? new Date(episode.publishedAt).getFullYear() : null,
    genre: 'Podcast',
    duration: episode.duration,
    bitrate: null,
    sampleRate: null,
    size: null,
    mtime: episode.publishedAt ?? Date.now(),
    hasArt: 0,
    loved: 0,
    rating: 0,
    ratingScore: null,
    avoidAutoPlay: 0,
    playCount: 0,
    lastPlayed: null,
    skipCount: 0,
    lastSkipped: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
  };
}

function hashEpisodeId(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return hash || 1;
}

function cueStart(track: Track | null): number {
  const value = track?.cueStart;
  return Number.isFinite(value) && value != null && value > 0 ? value : 0;
}

function cueEnd(track: Track | null): number | null {
  const value = track?.cueEnd;
  return Number.isFinite(value) && value != null && value > cueStart(track) ? value : null;
}

function cueRelativeTime(track: Track | null, engineTime: number): number {
  return Math.max(0, engineTime - cueStart(track));
}

function cueDuration(track: Track | null, engineDuration: number): number {
  if (track?.duration && track.duration > 0) return track.duration;
  const end = cueEnd(track);
  const start = cueStart(track);
  if (end && end > start) return end - start;
  return engineDuration;
}

function cueEndKey(track: Track | null, index: number): string | null {
  const end = cueEnd(track);
  return track && end ? `${track.id}:${index}:${end}` : null;
}

async function playEngineTrack(track: Track): Promise<void> {
  lastCueEndKey = null;
  await engine.play(toAudioUrl(track.path), track.id, cueStart(track));
}

function prepareEngineTrack(track: Track): void {
  engine.prepareNext(toAudioUrl(track.path), track.id, cueStart(track));
}

function recordLibraryPlay(track: Track): void {
  if (track.id > 0) void api.recordPlay(track.id).catch(() => undefined);
}

function searchLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function albumContextPath(track: Track): string | null {
  const parts = track.path.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return null;
  const album = track.album.trim().toLowerCase();
  if (album) {
    for (let i = parts.length - 2; i >= 0; i -= 1) {
      if (parts[i]!.toLowerCase().includes(album)) {
        const prefix = /^[A-Za-z]:/.test(track.path) ? `${parts[0]}\\` : track.path.startsWith('\\\\') ? '\\\\' : '';
        const start = prefix ? 1 : 0;
        return `${prefix}${parts.slice(start, i + 1).join('\\')}`;
      }
    }
  }
  return parts.slice(0, -1).join('\\');
}

function compareContextTracks(a: Track, b: Track): number {
  const disc = (a.discNo ?? 9999) - (b.discNo ?? 9999);
  if (disc) return disc;
  const track = (a.trackNo ?? 9999) - (b.trackNo ?? 9999);
  if (track) return track;
  return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });
}

function dedupeTracks(tracks: Track[]): Track[] {
  const seen = new Set<number>();
  const out: Track[] = [];
  for (const track of tracks) {
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    out.push(track);
  }
  return out;
}

async function expandQueueFromCurrentContext(state: PlayerState): Promise<{ queue: Track[]; index: number } | null> {
  const current = state.current;
  if (!current || current.id <= 0) return null;
  const searches: string[] = [];
  const album = current.album.trim();
  const pathRoot = albumContextPath(current);
  if (album && pathRoot) searches.push(`album:"${searchLiteral(album)}" path:"${searchLiteral(pathRoot)}"`);
  if (album && current.albumArtist.trim()) {
    searches.push(`album:"${searchLiteral(album)}" albumartist:"${searchLiteral(current.albumArtist)}"`);
  }
  if (pathRoot) searches.push(`path:"${searchLiteral(pathRoot)}"`);

  for (const search of searches) {
    const rows = dedupeTracks(await api.getTracks({ search, sort: 'album', limit: CONTEXT_EXPANSION_LIMIT }).catch(() => []))
      .sort(compareContextTracks);
    const index = rows.findIndex((track) => track.id === current.id);
    if (index >= 0 && rows.length > 1) return { queue: rows, index };
  }
  return null;
}

export const usePlayerStore = create<PlayerState>((set, get) => {
  // AudioEngine.subscribe emits immediately; defer until Zustand has installed the initial state.
  queueMicrotask(() => {
    engine.subscribe((s) => {
      const activeTrack = get().current;
      const relativeTime = cueRelativeTime(activeTrack, s.currentTime);
      const displayDuration = cueDuration(activeTrack, s.duration);
      set({
        isPlaying: s.playing,
        currentTime: relativeTime,
        duration: displayDuration,
        playbackError: s.error,
      });
      maybeScrobbleToLastfm(get(), relativeTime, s.playing);
      schedulePersistPlaybackSession(get());
      persistPodcastProgress(get(), s.ended, s.ended);
      notifyShellPlayback(get());
      const state = get();
      if (s.error) {
        const decision = resolvePlaybackErrorAdvance({
          error: s.error,
          currentTrackId: state.current?.id ?? s.trackId,
          index: state.index,
          queueLength: state.queue.length,
          mode: state.mode,
          lastErrorKey: lastPlaybackErrorKey,
        });
        if (decision.key && (decision.shouldAdvance || decision.shouldStop)) lastPlaybackErrorKey = decision.key;
        if (decision.shouldAdvance && decision.key) {
          clearPlaybackErrorAdvanceTimer();
          playbackErrorAdvanceTimer = window.setTimeout(() => {
            playbackErrorAdvanceTimer = null;
            void advanceAfterPlaybackError(get, set, decision.key!);
          }, 350);
        }
        return;
      }
      const queueLength = state.queue?.length ?? 0;
      const segmentEndKey = cueEndKey(state.current, state.index);
      const segmentEnd = cueEnd(state.current);
      if (s.playing && segmentEndKey && segmentEnd && s.currentTime >= segmentEnd - 0.04 && lastCueEndKey !== segmentEndKey) {
        lastCueEndKey = segmentEndKey;
        // The cued segment finished — count that as a completed play for the
        // eviland memory bridge's lineage ladder. Mirrors the natural-end
        // path below for plain track playback.
        notifyPlayCompleted(state.current?.id ?? null);
        if (state.stopAfterCurrent) {
          set({ stopAfterCurrent: false });
          engine.stop();
        } else if (state.mode === 'repeat-one' && state.current) {
          void playEngineTrack(state.current);
        } else {
          window.setTimeout(() => void get().next(), 0);
        }
        return;
      }
      if (
        shouldStopForSleepTimer({
          playing: s.playing,
          sleepTimerEndsAt: state.sleepTimerEndsAt,
        })
      ) {
        set({ sleepTimerEndsAt: null, stopAfterCurrent: false });
        engine.stop();
        return;
      }
      if (
        !state.stopAfterCurrent &&
        shouldPrepareTrackHandoff({
          playing: s.playing,
          duration: displayDuration,
          currentTime: relativeTime,
          crossfadeMs: state.settings?.crossfadeMs ?? 0,
          queueLength,
          index: state.index ?? -1,
          mode: state.mode ?? 'normal',
          currentTrackId: state.current?.id ?? null,
          lastHandoffKey: lastPreparedHandoffKey,
        }) &&
        state.current
      ) {
        const nextIndex = state.mode === 'repeat-all' && state.index >= queueLength - 1 ? 0 : state.index + 1;
        const nextTrack = state.queue[nextIndex] ?? null;
        if (nextTrack) {
          lastPreparedHandoffKey = handoffKey(state.current.id, state.index);
          prepareEngineTrack(nextTrack);
        }
      }
      if (
        !state.stopAfterCurrent &&
        shouldStartTrackHandoff({
          playing: s.playing,
          duration: displayDuration,
          currentTime: relativeTime,
          crossfadeMs: state.settings?.crossfadeMs ?? 0,
          queueLength,
          index: state.index ?? -1,
          mode: state.mode ?? 'normal',
          currentTrackId: state.current?.id ?? null,
          lastHandoffKey,
        }) &&
        state.current
      ) {
        lastHandoffKey = handoffKey(state.current.id, state.index);
        void state.next();
        return;
      }
      if (
        shouldStopAfterCurrent({
          ended: s.ended,
          stopAfterCurrent: state.stopAfterCurrent,
          currentTrackId: state.current?.id ?? null,
          index: state.index,
          lastStopKey: lastStopAfterCurrentKey,
        })
      ) {
        lastStopAfterCurrentKey = stopAfterCurrentKey(state.current?.id ?? null, state.index);
        set({ stopAfterCurrent: false });
        engine.stop();
        return;
      }
      // auto-advance on end
      if (s.ended && get().mode !== 'repeat-one') {
        // The engine reached the end of this track. Notify the eviland memory
        // bridge so the play counter ticks (drives the 8/32/96/256 generation
        // ladder). The registry routes to the active bridge IFF its trackId
        // matches — wrong-track and no-bridge are cheap no-ops.
        notifyPlayCompleted(state.current?.id ?? null);
        // small delay to avoid re-entry
        setTimeout(() => void get().next(), 0);
      } else if (s.ended && get().mode === 'repeat-one' && get().current) {
        // repeat-one: the same track is about to play again. From the player's
        // POV that's a completed play, so the counter ticks here too.
        notifyPlayCompleted(state.current?.id ?? null);
        const c = get().current!;
        void playEngineTrack(c);
      }
    });
  });

  return {
    engine,
    queue: [],
    index: -1,
    current: null,
    isPlaying: false,
    currentTime: 0,
    resumeAt: null,
    duration: 0,
    playbackError: null,
    volume: 0.75,
    playbackRate: 1,
    audioOutputDeviceId: null,
    autoDjEnabled: false,
    autoDjTarget: 24,
    autoDjSmartRuleId: null,
    stopAfterCurrent: false,
    sleepTimerEndsAt: null,
    shuffleHistory: [],
    activePodcastEpisode: null,
    mode: 'normal',
    settings: null,
    view: 'home',
    fullscreenViz: false,
    compactMode: false,
    alwaysOnTop: false,
    vizPreset: 'spectrum',
    evilandDirector: true,
    evilandSeed: null,
    evilandConfigNonce: 0,
    evilandWaveMode: 'off',
    searchQuery: '',
    showEq: false,
    pendingNavigation: null,

    init: async () => {
      let settings = inElectron
        ? await api.getSettings().catch(() => DEFAULT_SETTINGS)
        : DEFAULT_SETTINGS;
      try {
        await engine.setOutputDevice(settings.audioOutputDeviceId);
      } catch {
        settings = await api
          .setSettings({ audioOutputDeviceId: null })
          .catch(() => ({ ...settings, audioOutputDeviceId: null }));
        await engine.setOutputDevice(null).catch(() => undefined);
      }
      engine.setPreferredSampleRate(
        settings.audioBitPerfectPath ? settings.audioPreferredSampleRate : null,
      );
      engine.setVolume(settings.volume);
      engine.setPlaybackRate(settings.playbackRate);
      engine.setCrossfadeMs(settings.crossfadeMs);
      engine.setLimiterEnabled(settings.limiterEnabled);
      engine.setPreampDb(settings.preampDb);
      settings.equalizer.forEach((v, i) => engine.setEqBand(i, settings.eqEnabled ? v : 0));
      set({
        settings,
        volume: settings.volume,
        playbackRate: settings.playbackRate,
        audioOutputDeviceId: settings.audioOutputDeviceId,
        autoDjEnabled: settings.autoDjEnabled,
        autoDjTarget: normalizeAutoDjTarget(settings.autoDjTarget),
        autoDjSmartRuleId: settings.autoDjSmartRuleId ?? null,
        compactMode: settings.compactMode,
        alwaysOnTop: settings.alwaysOnTop,
        vizPreset: settings.visualizerPreset,
      });
      applyReplayGain(get().current, settings);
      applyTheme(settings.theme, settings.customSkin);
      await restorePlaybackSession(settings.resumeState, settings, set);
    },

    persistPlaybackSession: async () => persistPlaybackSession(get()),

    setView: (v) => set({ view: v }),
    navigateToArtist: (name) => {
      const cleaned = (name ?? '').trim();
      if (!cleaned) return;
      set({ view: 'artists', pendingNavigation: { kind: 'artist', name: cleaned } });
    },
    navigateToAlbum: (album, albumArtist) => {
      const a = (album ?? '').trim();
      if (!a) return;
      set({
        view: 'albums',
        pendingNavigation: { kind: 'album', album: a, albumArtist: (albumArtist ?? '').trim() },
      });
    },
    navigateToTrack: (track) => {
      // Track navigation lands on the album detail with the row highlighted;
      // a track with no album falls back to its artist page (better than a
      // dead end for loose singles).
      const album = (track.album ?? '').trim();
      if (album) {
        set({
          view: 'albums',
          pendingNavigation: {
            kind: 'album-with-track',
            album,
            albumArtist: (track.albumArtist ?? track.artist ?? '').trim(),
            trackId: track.id ?? null,
            trackTitle: (track.title ?? '').trim() || null,
          },
        });
        return;
      }
      const artist = (track.artist ?? '').trim();
      if (artist) get().navigateToArtist(artist);
    },
    consumePendingNavigation: () => set({ pendingNavigation: null }),
    toggleEq: () => set({ showEq: !get().showEq }),
    setFullscreenViz: (on) => {
      const wasCompact = get().compactMode;
      set({ fullscreenViz: on, compactMode: on ? false : wasCompact });
      if (on && wasCompact) {
        void api
          .setSettings({ compactMode: false })
          .then((settings) => set({ settings, compactMode: settings.compactMode }))
          .catch(() => undefined);
      }
    },
    setCompactMode: (on) => {
      set({ compactMode: on, fullscreenViz: on ? false : get().fullscreenViz });
      void api
        .setSettings({ compactMode: on })
        .then((settings) => set({ settings, compactMode: settings.compactMode }))
        .catch(() => undefined);
    },
    setAlwaysOnTop: (on) => {
      set({ alwaysOnTop: on });
      void api
        .setSettings({ alwaysOnTop: on })
        .then((settings) => set({ settings, alwaysOnTop: settings.alwaysOnTop }))
        .catch(() => undefined);
    },
    setVizPreset: (name) => {
      set({ vizPreset: name });
      void api
        .setSettings({ visualizerPreset: name })
        .then((settings) => set({ settings, vizPreset: settings.visualizerPreset }))
        .catch(() => undefined);
    },
    toggleEvilandDirector: () => {
      // Toggling the director is a pure UI flag — the Visualizer rAF loop
      // consults state.evilandDirector each frame and either uses
      // director.update() or the manually-applied config. No persistence:
      // the director is an in-session "auto-VJ for one preset" affordance,
      // mirroring how the Auto-VJ toggle in FullscreenVisualizer is local
      // (localStorage) rather than settings.json.
      set((s) => ({ evilandDirector: !s.evilandDirector }));
    },
    randomizeEviland: (seed) => {
      // Derive a seed from the next nonce when none is supplied — deterministic
      // and reproducible across reloads. The randomizer hashes the string via
      // FNV-1a, so any non-empty value is fine. Compute the nonce inside the
      // functional updater so two rapid calls can't both read the same value
      // and clobber each other's bump.
      set((s) => {
        const nextNonce = s.evilandConfigNonce + 1;
        const requested = seed && seed.trim() ? seed.trim() : `seed-${nextNonce}`;
        return {
          evilandSeed: requested,
          evilandConfigNonce: nextNonce,
          // Manual look — let it stick. The Director toggle is a separate axis;
          // the user can re-enable it explicitly when they want the song back
          // in charge.
          evilandDirector: false,
        };
      });
    },
    applyEvilandCode: (code) => {
      const trimmed = (code ?? '').trim();
      if (!trimmed) return false;
      // decode() returns null for unrecognisable codes — surface that to the
      // caller so the UI can toast/inline-error without us having to throw.
      const decoded = decodeEvilandCode(trimmed);
      if (!decoded) return false;
      set((s) => ({
        evilandSeed: decoded.seed ?? trimmed,
        evilandConfigNonce: s.evilandConfigNonce + 1,
        evilandDirector: false,
      }));
      return true;
    },
    setEvilandWaveMode: (mode) => {
      // Bump the nonce so the rAF loop re-applies the active config with the
      // new waveform override on its next frame.
      set((s) => ({
        evilandWaveMode: mode,
        evilandConfigNonce: s.evilandConfigNonce + 1,
      }));
    },
    setSearchQuery: (q) => set({ searchQuery: q }),

    playTrack: async (track, queue) => {
      clearPlaybackErrorAdvanceTimer();
      recordManualSkip(get());
      lastPreparedHandoffKey = null;
      lastStopAfterCurrentKey = null;
      lastPlaybackErrorKey = null;
      const q = queue && queue.length ? queue : [track];
      const idx = q.findIndex((t) => t.id === track.id);
      const nextIndex = idx >= 0 ? idx : 0;
      set({
        queue: q,
        index: nextIndex,
        current: track,
        currentTime: 0,
        duration: track.duration ?? 0,
        resumeAt: null,
        playbackError: null,
        activePodcastEpisode: null,
        shuffleHistory: get().mode === 'shuffle' ? resetSmartShuffleHistory(q.length, nextIndex) : [],
      });
      applyReplayGain(track, get().settings);
      schedulePersistPlaybackSession(get(), true);
      await playEngineTrack(track);
      lastPlaybackErrorKey = null;
      startLastfmNowPlaying(track);
      recordLibraryPlay(track);
    },

    playPodcastEpisode: async (episode) => {
      clearPlaybackErrorAdvanceTimer();
      const track = podcastEpisodeToTrack(episode);
      lastPreparedHandoffKey = null;
      lastStopAfterCurrentKey = null;
      lastPlaybackErrorKey = null;
      lastPodcastProgressPersistAt = 0;
      set({
        queue: [track],
        index: 0,
        current: track,
        currentTime: 0,
        duration: track.duration ?? 0,
        resumeAt: null,
        playbackError: null,
        activePodcastEpisode: { feedUrl: episode.feedUrl, episodeId: episode.id },
        shuffleHistory: [],
      });
      applyReplayGain(null, get().settings);
      schedulePersistPlaybackSession(get(), true);
      await playEngineTrack(track);
      const resumeAt = episode.completed ? 0 : Math.max(0, episode.progressSeconds);
      if (resumeAt > 0) engine.seek(resumeAt);
      persistPodcastProgress(get(), true, false);
    },

    playQueue: async (tracks, startIndex = 0) => {
      if (!tracks.length) return;
      clearPlaybackErrorAdvanceTimer();
      recordManualSkip(get());
      lastPreparedHandoffKey = null;
      lastStopAfterCurrentKey = null;
      lastPlaybackErrorKey = null;
      const q = [...tracks];
      const i = Math.max(0, Math.min(startIndex, q.length - 1));
      const t = q[i]!;
      set({
        queue: q,
        index: i,
        current: t,
        currentTime: 0,
        duration: t.duration ?? 0,
        resumeAt: null,
        playbackError: null,
        activePodcastEpisode: null,
        shuffleHistory: get().mode === 'shuffle' ? resetSmartShuffleHistory(q.length, i) : [],
      });
      applyReplayGain(t, get().settings);
      schedulePersistPlaybackSession(get(), true);
      await playEngineTrack(t);
      lastPlaybackErrorKey = null;
      startLastfmNowPlaying(t);
      recordLibraryPlay(t);
    },

    loadQueue: (tracks) => {
      clearPlaybackErrorAdvanceTimer();
      set({ queue: [...tracks], index: -1, current: null, resumeAt: null, currentTime: 0, duration: 0, playbackError: null, shuffleHistory: [], activePodcastEpisode: null });
      schedulePersistPlaybackSession(get(), true);
      if (get().autoDjEnabled) void get().refillAutoDjQueue(true);
    },

    queueTrackNext: (track) => {
      const result = insertTrackNext(get().queue, get().index, track);
      set({ queue: result.queue, index: result.index, shuffleHistory: resetSmartShuffleHistory(result.queue.length, result.index) });
      schedulePersistPlaybackSession(get(), true);
    },

    addTrackToQueue: (track) => {
      const result = appendTrackToQueue(get().queue, get().index, track);
      set({ queue: result.queue, index: result.index, shuffleHistory: resetSmartShuffleHistory(result.queue.length, result.index) });
      schedulePersistPlaybackSession(get(), true);
    },

    queueTracksNext: (tracks) => {
      if (!tracks.length) return;
      const result = insertTracksNext(get().queue, get().index, tracks);
      set({ queue: result.queue, index: result.index, shuffleHistory: resetSmartShuffleHistory(result.queue.length, result.index) });
      schedulePersistPlaybackSession(get(), true);
    },

    addTracksToQueue: (tracks) => {
      if (!tracks.length) return;
      const result = appendTracksToQueue(get().queue, get().index, tracks);
      set({ queue: result.queue, index: result.index, shuffleHistory: resetSmartShuffleHistory(result.queue.length, result.index) });
      schedulePersistPlaybackSession(get(), true);
    },

    moveQueuedTrack: (fromIndex, toIndex) => {
      const result = moveQueueItem(get().queue, get().index, fromIndex, toIndex);
      set({ queue: result.queue, index: result.index, shuffleHistory: resetSmartShuffleHistory(result.queue.length, result.index) });
      schedulePersistPlaybackSession(get(), true);
    },

    removeQueuedTrack: async (removeIndex) => {
      const state = get();
      const result = removeQueueItem(state.queue, state.index, removeIndex);
      if (!result.queue.length) {
        engine.stop();
        set({ queue: [], index: -1, current: null, currentTime: 0, duration: 0, resumeAt: null, stopAfterCurrent: false, shuffleHistory: [], activePodcastEpisode: null });
        schedulePersistPlaybackSession(get(), true);
        return;
      }
      if (result.removedCurrent) {
        const nextCurrent = result.queue[result.index] ?? null;
        if (state.isPlaying && nextCurrent) {
          await get().playQueue(result.queue, result.index);
          return;
        }
        set({
          queue: result.queue,
          index: result.index,
          current: nextCurrent,
          currentTime: 0,
          duration: nextCurrent?.duration ?? 0,
          resumeAt: null,
          activePodcastEpisode: null,
          shuffleHistory: resetSmartShuffleHistory(result.queue.length, result.index),
        });
        applyReplayGain(nextCurrent, get().settings);
      } else {
        set({ queue: result.queue, index: result.index, shuffleHistory: resetSmartShuffleHistory(result.queue.length, result.index) });
      }
      schedulePersistPlaybackSession(get(), true);
    },

    clearQueue: () => {
      clearPlaybackErrorAdvanceTimer();
      recordManualSkip(get());
      lastPreparedHandoffKey = null;
      lastStopAfterCurrentKey = null;
      lastPlaybackErrorKey = null;
      engine.stop();
      set({
        queue: [],
        index: -1,
        current: null,
        currentTime: 0,
        duration: 0,
        resumeAt: null,
        playbackError: null,
        stopAfterCurrent: false,
        sleepTimerEndsAt: null,
        shuffleHistory: [],
        activePodcastEpisode: null,
      });
      schedulePersistPlaybackSession(get(), true);
    },

    togglePlay: () => {
      const state = get();
      if (!engine.getState().src) {
        const startIndex = resolvePlaybackStartIndex(state.queue.length || (state.current ? 1 : 0), state.index);
        if (startIndex < 0) return;
        const resumeAt = state.resumeAt;
        const playbackQueue = state.queue.length ? state.queue : state.current ? [state.current] : [];
        void state.playQueue(playbackQueue, startIndex).then(() => {
          if (resumeAt && resumeAt > 0) get().seek(resumeAt);
          set({ resumeAt: null });
        });
        return;
      }
      engine.togglePlayPause();
    },

    next: async () => {
      clearPlaybackErrorAdvanceTimer();
      const state = get();
      recordManualSkip(state);
      const { queue, index, mode, shuffleHistory } = state;
      if (!queue.length) return;
      let nextIdx = index + 1;
      let nextShuffleHistory = shuffleHistory;
      if (mode === 'shuffle') {
        const decision = nextSmartShuffle({ queueLength: queue.length, currentIndex: index, history: shuffleHistory });
        nextIdx = decision.index;
        nextShuffleHistory = decision.history;
      }
      if (nextIdx >= queue.length) {
        if (mode === 'repeat-all') nextIdx = 0;
        else {
          const additions = await get().refillAutoDjQueue(true);
          if (!additions.length) {
            const expanded = await expandQueueFromCurrentContext(state);
            if (!expanded || expanded.index >= expanded.queue.length - 1) {
              engine.pause();
              set({ isPlaying: false });
              schedulePersistPlaybackSession(get(), true);
              return;
            }
            nextIdx = expanded.index + 1;
            const contextShuffleHistory = mode === 'shuffle'
              ? resetSmartShuffleHistory(expanded.queue.length, expanded.index)
              : [];
            set({
              queue: expanded.queue,
              index: expanded.index,
              shuffleHistory: contextShuffleHistory,
            });
            nextShuffleHistory = contextShuffleHistory;
          } else {
            nextIdx = index + 1;
          }
        }
      }
      const latestQueue = get().queue;
      const t = latestQueue[nextIdx]!;
      set({ index: nextIdx, current: t, currentTime: 0, duration: t.duration ?? 0, resumeAt: null, activePodcastEpisode: null, shuffleHistory: nextShuffleHistory });
      applyReplayGain(t, get().settings);
      schedulePersistPlaybackSession(get(), true);
      await playEngineTrack(t);
      lastPlaybackErrorKey = null;
      startLastfmNowPlaying(t);
      recordLibraryPlay(t);
      if (shouldAutoDjRefill({ enabled: get().autoDjEnabled, queueLength: get().queue.length, index: nextIdx })) {
        void get().refillAutoDjQueue();
      }
    },

    prev: async () => {
      clearPlaybackErrorAdvanceTimer();
      const { queue, index, currentTime, mode, shuffleHistory } = get();
      if (!queue.length) return;
      // if more than 3 seconds into the track, restart it
      if (currentTime > 3) {
        get().seek(0);
        return;
      }
      const shuffleDecision = mode === 'shuffle'
        ? previousSmartShuffle({ queueLength: queue.length, currentIndex: index, history: shuffleHistory })
        : null;
      const prevIdx = shuffleDecision ? shuffleDecision.index : Math.max(0, index - 1);
      const t = queue[prevIdx]!;
      set({
        index: prevIdx,
        current: t,
        currentTime: 0,
        duration: t.duration ?? 0,
        resumeAt: null,
        activePodcastEpisode: null,
        shuffleHistory: shuffleDecision?.history ?? shuffleHistory,
      });
      applyReplayGain(t, get().settings);
      schedulePersistPlaybackSession(get(), true);
      await playEngineTrack(t);
      lastPlaybackErrorKey = null;
      startLastfmNowPlaying(t);
    },

    seek: (t) => engine.seek(cueStart(get().current) + Math.max(0, t)),

    setVolume: async (v) => {
      // Real-time path: gain ramp + in-memory store update fire immediately
      // so the UI and the audio output respond on the very next frame.
      engine.setVolume(v);
      set({ volume: v });
      // Persist path: coalesce bursts (wheel scroll, slider drag) onto a
      // single trailing-edge writeFileSync. Last value wins.
      schedulePersistVolume(v, (settings) => set({ settings }));
    },

    setPlaybackRate: async (rate) => {
      const playbackRate = normalizePlaybackRate(rate);
      engine.setPlaybackRate(playbackRate);
      set({ playbackRate });
      const settings = await api.setSettings({ playbackRate });
      set({ settings, playbackRate: settings.playbackRate });
    },

    setAudioOutputDevice: async (deviceId) => {
      const audioOutputDeviceId = normalizeAudioOutputDeviceId(deviceId);
      await engine.setOutputDevice(audioOutputDeviceId);
      const settings = await api.setSettings({ audioOutputDeviceId });
      set({ settings, audioOutputDeviceId: settings.audioOutputDeviceId });
    },

    playOutputTestTone: async () => {
      await engine.playOutputTestTone();
    },

    setAutoDjEnabled: async (enabled) => {
      const settings = await api.setSettings({ autoDjEnabled: enabled });
      set({
        settings,
        autoDjEnabled: settings.autoDjEnabled,
        autoDjTarget: normalizeAutoDjTarget(settings.autoDjTarget),
        autoDjSmartRuleId: settings.autoDjSmartRuleId ?? null,
      });
      if (settings.autoDjEnabled) void get().refillAutoDjQueue(true);
    },

    setAutoDjTarget: async (target) => {
      const autoDjTarget = normalizeAutoDjTarget(target);
      const settings = await api.setSettings({ autoDjTarget });
      set({
        settings,
        autoDjTarget: normalizeAutoDjTarget(settings.autoDjTarget),
        autoDjSmartRuleId: settings.autoDjSmartRuleId ?? null,
      });
      if (get().autoDjEnabled) void get().refillAutoDjQueue(true);
    },

    setAutoDjSmartRuleId: async (id) => {
      const autoDjSmartRuleId = id && Number.isFinite(id) && id > 0 ? Math.trunc(id) : null;
      const settings = await api.setSettings({ autoDjSmartRuleId });
      set({
        settings,
        autoDjSmartRuleId: settings.autoDjSmartRuleId ?? null,
      });
      if (get().autoDjEnabled) void get().refillAutoDjQueue(true);
    },

    setStopAfterCurrent: (enabled) => {
      lastStopAfterCurrentKey = null;
      set({ stopAfterCurrent: !!enabled });
    },

    setSleepTimerMinutes: (minutes) => {
      set({ sleepTimerEndsAt: sleepTimerEndTime(minutes) });
    },

    clearSleepTimer: () => set({ sleepTimerEndsAt: null }),

    refillAutoDjQueue: async (force = false) => {
      const state = get();
      if (!state.autoDjEnabled || (!state.queue.length && !state.autoDjSmartRuleId)) return [];
      if (
        !force &&
        !shouldAutoDjRefill({
          enabled: state.autoDjEnabled,
          queueLength: state.queue.length,
          index: state.index,
        })
      ) {
        return [];
      }
      const candidates = state.autoDjSmartRuleId
        ? await api
            .getSmartPlaylistRules()
            .then((rules) => rules.find((rule) => rule.id === state.autoDjSmartRuleId) ?? null)
            .then((rule) =>
              rule
                ? api.runSmartPlaylistRule({
                    ...rule,
                    count: autoDjSmartRuleCandidateCount(rule.count, state.autoDjTarget, state.queue.length),
                  })
                : api.runSmartPlaylistRule(state.autoDjSmartRuleId!),
            )
            .catch(() => [])
        : await (() => {
            const seed = state.current ?? state.queue[Math.max(0, state.index)] ?? state.queue[state.queue.length - 1]!;
            return api
              .buildHarmonicMix({
                seedTrackId: seed?.id ?? null,
                count: state.autoDjTarget + state.queue.length,
              })
              .catch(() => []);
          })();
      const additions = selectAutoDjAdditions(state.queue, candidates, state.autoDjTarget);
      if (!additions.length) return [];
      set({ queue: [...state.queue, ...additions] });
      schedulePersistPlaybackSession(get(), true);
      return additions;
    },

    setMode: (m) => {
      const state = get();
      set({
        mode: m,
        shuffleHistory: m === 'shuffle'
          ? resetSmartShuffleHistory(state.queue.length, state.index)
          : [],
      });
      schedulePersistPlaybackSession(get(), true);
    },

    setEqBand: async (i, dB) => {
      const cur = get().settings;
      if (!cur) return;
      const next = [...cur.equalizer];
      next[i] = dB;
      const normalized = normalizeEqValues(next);
      engine.setEqBand(i, normalized[i] ?? 0);
      const settings = await api.setSettings({ equalizer: normalized });
      set({ settings });
    },

    setEqPreset: async (values) => {
      const next = normalizeEqValues(values);
      engine.setEqBands(next);
      const settings = await api.setSettings({ equalizer: next, eqEnabled: true });
      set({ settings });
    },

    setEqEnabled: async (on) => {
      const cur = get().settings;
      if (!cur) return;
      if (on) engine.setEqBands(cur.equalizer);
      else engine.setEqEnabled(false);
      const settings = await api.setSettings({ eqEnabled: on });
      set({ settings });
    },

    toggleLove: async (id) => {
      const loved = await api.toggleLove(id);
      const nextLoved: 0 | 1 = loved ? 1 : 0;
      set((state) => ({
        current: state.current?.id === id ? { ...state.current, loved: nextLoved } : state.current,
        queue: state.queue.map((track) => (track.id === id ? { ...track, loved: nextLoved } : track)),
      }));
      // Eviland memory bridge: love-tick forces a generation evolution when
      // the lineage is < gen 3 (per the blueprint §1.6.4 rule). Only fire on
      // the rising edge (toggling loved ON) — un-loving must not advance.
      if (loved) notifyLove(id);
      return loved;
    },

    setTrackRating: async (id, rating) => {
      const updated = await api.setTrackRating(id, rating);
      if (!updated) return null;
      set((state) => ({
        current: state.current?.id === updated.id ? updated : state.current,
        queue: state.queue.map((track) => (track.id === updated.id ? updated : track)),
      }));
      return updated;
    },

    setTrackRatingScore: async (id, score) => {
      const updated = await api.setTrackRatingScore(id, score);
      if (!updated) return null;
      set((state) => ({
        current: state.current?.id === updated.id ? updated : state.current,
        queue: state.queue.map((track) => (track.id === updated.id ? updated : track)),
      }));
      return updated;
    },

    toggleAvoidAutoPlay: async (id) => {
      const updated = await api.toggleAvoidAutoPlay(id);
      if (!updated) return null;
      set((state) => ({
        current: state.current?.id === updated.id ? updated : state.current,
        queue: state.queue.map((track) => (track.id === updated.id ? updated : track)),
      }));
      return updated;
    },

    setTheme: async (theme) => {
      const settings = await api.setSettings({ theme });
      set({ settings });
      applyTheme(theme, settings.customSkin);
    },

    setCrossfadeMs: async (ms) => {
      const crossfadeMs = Math.max(0, Math.min(12000, Math.round(ms)));
      engine.setCrossfadeMs(crossfadeMs);
      const settings = await api.setSettings({ crossfadeMs });
      set({ settings });
    },

    setReplayGainMode: async (mode) => {
      const settings = await api.setSettings({ replayGain: mode });
      set({ settings });
      applyReplayGain(get().current, settings);
    },

    setLimiterEnabled: async (enabled) => {
      engine.setLimiterEnabled(enabled);
      const settings = await api.setSettings({ limiterEnabled: enabled });
      set({ settings });
    },

    setPreampDb: async (db) => {
      const preampDb = normalizePreampDb(db);
      engine.setPreampDb(preampDb);
      const settings = await api.setSettings({ preampDb });
      set({ settings });
    },

    saveCustomSkin: async (skin) => {
      const settings = await api.setSettings({ customSkin: skin, theme: 'custom' });
      set({ settings });
      applyTheme('custom', skin);
    },
  };
});

// Dev-only: expose the store on window for visual QA / debugging.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __store?: unknown }).__store = usePlayerStore;
}

if (typeof window !== 'undefined') {
  const params = new URLSearchParams(window.location.search);
  if (params.get('newamp-smoke') === '1') {
    (window as unknown as {
      __newampSmoke?: {
        seek: (seconds: number) => void;
        setFullscreenVisualizer: (on: boolean) => void;
        setCompactDeck: (on: boolean) => void;
        analyserFftSum: () => number;
        engineCurrentTime: () => number;
      };
    }).__newampSmoke = {
      seek: (seconds: number) => {
        const trackId = usePlayerStore.getState().current?.id ?? null;
        usePlayerStore.getState().seek(seconds);
        let ticks = 0;
        const holdClock = window.setInterval(() => {
          if ((usePlayerStore.getState().current?.id ?? null) !== trackId) {
            window.clearInterval(holdClock);
            return;
          }
          usePlayerStore.setState({ currentTime: seconds });
          ticks += 1;
          if (ticks >= 20) window.clearInterval(holdClock);
        }, 50);
      },
      setFullscreenVisualizer: (on: boolean) => {
        usePlayerStore.getState().setFullscreenViz(on);
      },
      setCompactDeck: (on: boolean) => {
        usePlayerStore.getState().setCompactMode(on);
      },
      // Sum of byte-frequency-data over all bins. Returns 0 when the
      // analyser subtree is culled by Chrome's audio graph optimizer
      // (the 1.5.3-1.5.4 silent-sink bug) AND when no audio is playing.
      // Smokes use this to prove the FFT path is live independent of
      // butterchurn pixel output — software WebGL drops shader paint
      // but the analyser still receives audio.
      analyserFftSum: () => {
        const engine = usePlayerStore.getState().engine;
        const buf = new Uint8Array(engine.frequencyBinCount) as Uint8Array<ArrayBuffer>;
        engine.getFreqData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i]!;
        return sum;
      },
      // The REAL media-element playhead — unlike the store's currentTime,
      // which __newampSmoke.seek pins to the target for ~1s. Seek smokes
      // read this to prove a scrub actually landed instead of restarting.
      engineCurrentTime: () => usePlayerStore.getState().engine.getState().currentTime,
    };
  }
}
