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
import { api, inElectron, toAudioUrl, DEFAULT_SETTINGS } from '../lib/api';
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
  | 'mixes'
  | 'albums'
  | 'artists'
  | 'playlist'
  | 'loved'
  | 'history'
  | 'podcasts'
  | 'radio'
  | 'now-playing'
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
  vizPreset: string;
  searchQuery: string;
  showEq: boolean;
  init: () => Promise<void>;
  persistPlaybackSession: () => Promise<void>;
  setView: (v: ViewMode) => void;
  toggleEq: () => void;
  setFullscreenViz: (on: boolean) => void;
  setCompactMode: (on: boolean) => void;
  setVizPreset: (name: string) => void;
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
  toggleLove: (id: number) => Promise<void>;
  setTrackRating: (id: number, rating: number) => Promise<Track | null>;
  setTheme: (theme: AppSettings['theme']) => Promise<void>;
  setCrossfadeMs: (ms: number) => Promise<void>;
  setReplayGainMode: (mode: AppSettings['replayGain']) => Promise<void>;
  setLimiterEnabled: (enabled: boolean) => Promise<void>;
  setPreampDb: (db: number) => Promise<void>;
  saveCustomSkin: (skin: CustomSkin) => Promise<void>;
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

let lastfmPlayStartedAt = 0;
let lastfmPlayKey = '';
let lastfmScrobbledKey = '';
let lastSessionPersistAt = 0;
let lastPodcastProgressPersistAt = 0;
let lastHandoffKey: string | null = null;
let lastPreparedHandoffKey: string | null = null;
let lastStopAfterCurrentKey: string | null = null;

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

export const usePlayerStore = create<PlayerState>((set, get) => {
  engine.subscribe((s) => {
    set({
      isPlaying: s.playing,
      currentTime: s.currentTime,
      duration: s.duration,
    });
    maybeScrobbleToLastfm(get(), s.currentTime, s.playing);
    schedulePersistPlaybackSession(get());
    persistPodcastProgress(get(), s.ended, s.ended);
    const state = get();
    const queueLength = state.queue?.length ?? 0;
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
        duration: s.duration,
        currentTime: s.currentTime,
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
        engine.prepareNext(toAudioUrl(nextTrack.path), nextTrack.id);
      }
    }
    if (
      !state.stopAfterCurrent &&
      shouldStartTrackHandoff({
        playing: s.playing,
        duration: s.duration,
        currentTime: s.currentTime,
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
      // small delay to avoid re-entry
      setTimeout(() => void get().next(), 0);
    } else if (s.ended && get().mode === 'repeat-one' && get().current) {
      const c = get().current!;
      const url = toAudioUrl(c.path);
      void engine.play(url, c.id);
    }
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
    vizPreset: 'spectrum',
    searchQuery: '',
    showEq: false,

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
      });
      applyReplayGain(get().current, settings);
      applyTheme(settings.theme, settings.customSkin);
      await restorePlaybackSession(settings.resumeState, settings, set);
    },

    persistPlaybackSession: async () => persistPlaybackSession(get()),

    setView: (v) => set({ view: v }),
    toggleEq: () => set({ showEq: !get().showEq }),
    setFullscreenViz: (on) => set({ fullscreenViz: on }),
    setCompactMode: (on) => {
      set({ compactMode: on });
      void api
        .setSettings({ compactMode: on })
        .then((settings) => set({ settings, compactMode: settings.compactMode }))
        .catch(() => undefined);
    },
    setVizPreset: (name) => set({ vizPreset: name }),
    setSearchQuery: (q) => set({ searchQuery: q }),

    playTrack: async (track, queue) => {
      recordManualSkip(get());
      lastPreparedHandoffKey = null;
      lastStopAfterCurrentKey = null;
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
        activePodcastEpisode: null,
        shuffleHistory: get().mode === 'shuffle' ? resetSmartShuffleHistory(q.length, nextIndex) : [],
      });
      applyReplayGain(track, get().settings);
      schedulePersistPlaybackSession(get(), true);
      const url = toAudioUrl(track.path);
      await engine.play(url, track.id);
      startLastfmNowPlaying(track);
      void api.recordPlay(track.id).catch(() => undefined);
    },

    playPodcastEpisode: async (episode) => {
      const track = podcastEpisodeToTrack(episode);
      lastPreparedHandoffKey = null;
      lastStopAfterCurrentKey = null;
      lastPodcastProgressPersistAt = 0;
      set({
        queue: [track],
        index: 0,
        current: track,
        currentTime: 0,
        duration: track.duration ?? 0,
        resumeAt: null,
        activePodcastEpisode: { feedUrl: episode.feedUrl, episodeId: episode.id },
        shuffleHistory: [],
      });
      applyReplayGain(null, get().settings);
      schedulePersistPlaybackSession(get(), true);
      await engine.play(toAudioUrl(track.path), track.id);
      const resumeAt = episode.completed ? 0 : Math.max(0, episode.progressSeconds);
      if (resumeAt > 0) engine.seek(resumeAt);
      persistPodcastProgress(get(), true, false);
    },

    playQueue: async (tracks, startIndex = 0) => {
      if (!tracks.length) return;
      recordManualSkip(get());
      lastPreparedHandoffKey = null;
      lastStopAfterCurrentKey = null;
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
        activePodcastEpisode: null,
        shuffleHistory: get().mode === 'shuffle' ? resetSmartShuffleHistory(q.length, i) : [],
      });
      applyReplayGain(t, get().settings);
      schedulePersistPlaybackSession(get(), true);
      const url = toAudioUrl(t.path);
      await engine.play(url, t.id);
      startLastfmNowPlaying(t);
      void api.recordPlay(t.id).catch(() => undefined);
    },

    loadQueue: (tracks) => {
      set({ queue: [...tracks], index: -1, current: null, resumeAt: null, currentTime: 0, duration: 0, shuffleHistory: [], activePodcastEpisode: null });
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
      recordManualSkip(get());
      lastPreparedHandoffKey = null;
      lastStopAfterCurrentKey = null;
      engine.stop();
      set({
        queue: [],
        index: -1,
        current: null,
        currentTime: 0,
        duration: 0,
        resumeAt: null,
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
          if (resumeAt && resumeAt > 0) engine.seek(resumeAt);
          set({ resumeAt: null });
        });
        return;
      }
      engine.togglePlayPause();
    },

    next: async () => {
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
            engine.stop();
            return;
          }
          nextIdx = index + 1;
        }
      }
      const latestQueue = get().queue;
      const t = latestQueue[nextIdx]!;
      set({ index: nextIdx, current: t, currentTime: 0, duration: t.duration ?? 0, resumeAt: null, activePodcastEpisode: null, shuffleHistory: nextShuffleHistory });
      applyReplayGain(t, get().settings);
      schedulePersistPlaybackSession(get(), true);
      const url = toAudioUrl(t.path);
      await engine.play(url, t.id);
      startLastfmNowPlaying(t);
      void api.recordPlay(t.id).catch(() => undefined);
      if (shouldAutoDjRefill({ enabled: get().autoDjEnabled, queueLength: get().queue.length, index: nextIdx })) {
        void get().refillAutoDjQueue();
      }
    },

    prev: async () => {
      const { queue, index, currentTime, mode, shuffleHistory } = get();
      if (!queue.length) return;
      // if more than 3 seconds into the track, restart it
      if (currentTime > 3) {
        engine.seek(0);
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
      const url = toAudioUrl(t.path);
      await engine.play(url, t.id);
      startLastfmNowPlaying(t);
    },

    seek: (t) => engine.seek(t),

    setVolume: async (v) => {
      engine.setVolume(v);
      set({ volume: v });
      const settings = await api.setSettings({ volume: v });
      set({ settings });
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
      await api.toggleLove(id);
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
    };
  }
}
