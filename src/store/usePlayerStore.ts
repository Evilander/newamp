import { create } from 'zustand';
import type {
  AppSettings,
  CustomSkin,
  LastfmTrackPayload,
  PlaybackMode as SharedPlaybackMode,
  PlaybackResumeQueueEntry,
  PlaybackResumeState,
  PlaybackResumeServerTrack,
  PodcastEpisode,
  SavedMusicServer,
  Track,
} from '@shared/types';
import { combinePlaybackMode, isShuffleMode, repeatModeOf } from '@shared/types';
import { parseMusicServerStreamUrl } from '@shared/music-servers';
import { AudioEngine, type TrackRouting } from '../audio/engine';
import type { SampleTransport } from '../audio/sample-transport';
import { api, inElectron, toAudioUrl, winctl, DEFAULT_SETTINGS } from '../lib/api';
import { canonicalSeedCode, randomSeedCode, seedCodeFor } from '../visualizer/eviland-seed-code';
import { requestLookBack, requestLookSkip } from '../visualizer/look-requests';
import { requestScorePrefetch } from '../visualizer/score-prefetch';
import {
  notifyPlayCompleted,
  notifyLove,
  notifySkip,
} from '../visualizer/eviland-active-bridge';
import { applyTheme } from '../lib/skins';
import { pushToast } from '../lib/toast';
import { THEME_REGISTRY } from '@shared/custom-skin';
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
import { appendTracksToQueue, insertTracksNext, playNextInsertAt } from '@shared/queue-insert';
import {
  handoffKey,
  hasHandoffTarget,
  nextHandoffIndex,
  shouldPrepareTrackHandoff,
  shouldStartTrackHandoff,
} from '@shared/playback-handoff';
import {
  isShuffleHandoffCacheValid,
  resolveShuffleHandoffPick,
  type ShuffleHandoffCache,
} from '@shared/shuffle-handoff';
import { resolvePlaybackStartIndex, resolveResumePosition } from '@shared/playback-start';
import { createPlayIntentGate } from '@shared/play-intent';
import {
  shouldStopAfterCurrent,
  shouldStopForSleepTimer,
  sleepTimerEndTime,
  stopAfterCurrentKey,
} from '@shared/playback-controls';
import { playbackErrorKey, resolvePlaybackErrorAdvance } from '@shared/playback-error';
import {
  insertionIndexMap,
  isShuffleCycleComplete,
  moveIndexMap,
  nextSmartShuffle,
  previousSmartShuffle,
  remapShuffleHistory,
  removalIndexMap,
  removeIndexMap,
  resetSmartShuffleHistory,
  shuffleUnplayedCount,
  smartShuffleAfterRemoval,
} from '@shared/smart-shuffle';
import { STARTER_QUEUE_SIZE, buildStarterQueue, pickToday, starterQueueLead, starterQueueNeeded } from '../lib/today-pick';

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
  | 'music-servers'
  | 'now-playing'
  | 'about'
  | 'settings';

// Utility screens are a detour from wherever the listener was, not a place to
// come back to, so only the content views are remembered across launches.
const RESTORABLE_VIEWS: readonly ViewMode[] = [
  'home',
  'library',
  'folders',
  'discover',
  'mixes',
  'albums',
  'artists',
  'playlist',
  'loved',
  'history',
  'wrapped',
  'profile',
  'tags',
  'podcasts',
  'radio',
  'music-servers',
  'now-playing',
];
const PLAYBACK_MODES: readonly PlaybackMode[] = [
  'normal',
  'repeat-one',
  'repeat-all',
  'shuffle',
  'shuffle-repeat-one',
  'shuffle-repeat-all',
];
const VIEW_STORAGE_KEY = 'newamp:view';
const PLAYBACK_MODE_STORAGE_KEY = 'newamp:playback-mode';

export function parseStoredView(raw: string | null | undefined): ViewMode | null {
  return RESTORABLE_VIEWS.find((view) => view === raw) ?? null;
}

export function parseStoredPlaybackMode(raw: string | null | undefined): PlaybackMode | null {
  return PLAYBACK_MODES.find((mode) => mode === raw) ?? null;
}

function readStored(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked or full; the setting just won't survive a restart.
  }
}

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
  /**
   * The engine has been waiting on data (slow source, first-play transcode) for
   * long enough to notice; the clock is frozen until it lands. The wait that
   * opens every track does not count.
   */
  isBuffering: boolean;
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
  evilandWaveMode: 'auto' | 'off' | 'line' | 'radial' | 'bars';
  searchQuery: string;
  showEq: boolean;
  /** One-shot navigation request consumed by destination views on mount/render. */
  pendingNavigation:
    | null
    | { kind: 'artist'; name: string }
    | { kind: 'playlist'; playlistId: number }
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
  /** setView for a deliberate jump: leaves the deck and the fullscreen visualizer first so the view is actually seen. */
  openView: (v: ViewMode) => void;
  navigateToArtist: (name: string) => void;
  navigateToAlbum: (album: string, albumArtist: string) => void;
  navigateToPlaylist: (playlistId: number) => void;
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
   * Mint a new Eviland look. The look is kept as its seed code, so what the
   * seed box shows pastes back to the same look: a typed seed is turned into its
   * code, and without one a fresh code is drawn.
   */
  randomizeEviland: (seed?: string) => void;
  /**
   * Move Eviland on to a fresh look. With the Director driving, that is its next
   * rotation; with a look of your own up, it is a new random one.
   */
  skipEvilandLook: () => void;
  /** Fade Eviland back to the look before this one (Director only; a look of your own has no history). */
  previousEvilandLook: () => void;
  /** Apply a shared seed code (e.g. "K7Q2-9XMF"). Returns true on decode success. */
  applyEvilandCode: (code: string) => boolean;
  setEvilandWaveMode: (mode: 'auto' | 'off' | 'line' | 'radial' | 'bars') => void;
  setSearchQuery: (q: string) => void;
  playTrack: (track: Track, queue?: Track[]) => Promise<void>;
  playPodcastEpisode: (episode: PodcastEpisode) => Promise<void>;
  playQueue: (tracks: Track[], startIndex?: number, startAt?: number) => Promise<void>;
  /**
   * Plays tracks that were opened from outside the app (Open with, a
   * double-click, a drop). With a queue up they go in right after the current
   * track and the first one starts; the rest of the queue stays. With nothing
   * queued they become the queue.
   */
  playTracksNow: (tracks: Track[]) => Promise<void>;
  /**
   * Plays a track without touching the listener's state: no queue change, no
   * play count, no Last.fm, and the session on disk keeps the real queue.
   * endPreview() puts the previous queue back, paused.
   */
  previewTrack: (track: Track) => Promise<void>;
  endPreview: () => void;
  loadQueue: (tracks: Track[]) => void;
  queueTrackNext: (track: Track) => void;
  addTrackToQueue: (track: Track) => void;
  queueTracksNext: (tracks: Track[]) => void;
  addTracksToQueue: (tracks: Track[]) => void;
  moveQueuedTrack: (fromIndex: number, toIndex: number) => void;
  removeQueuedTrack: (index: number) => Promise<void>;
  /** Tracks that left the library: out of the queue, and off the deck if one is up. */
  dropTracks: (ids: number[]) => Promise<void>;
  /** Fresh rows for tracks whose tags changed, so the transport, Now Playing and the scrobble payload stop showing the old ones. */
  refreshTracks: (updated: Track[]) => void;
  clearQueue: () => void;
  togglePlay: () => void;
  next: () => Promise<void>;
  prev: () => Promise<void>;
  seek: (t: number) => void;
  setVolume: (v: number) => Promise<void>;
  setPlaybackRate: (rate: number) => Promise<void>;
  setAudioOutputDevice: (deviceId: string | null) => Promise<void>;
  setBitPerfectExclusive: (enabled: boolean) => Promise<AppSettings>;
  setSampleAccurateGapless: (enabled: boolean) => Promise<AppSettings>;
  setBitPerfectExclusiveDevice: (deviceId: string | null) => Promise<AppSettings>;
  playOutputTestTone: () => Promise<void>;
  setAutoDjEnabled: (enabled: boolean) => Promise<void>;
  setAutoDjTarget: (target: number) => Promise<void>;
  setAutoDjSmartRuleId: (id: number | null) => Promise<void>;
  setStopAfterCurrent: (enabled: boolean) => void;
  setSleepTimerMinutes: (minutes: number | null) => void;
  clearSleepTimer: () => void;
  refillAutoDjQueue: (force?: boolean) => Promise<Track[]>;
  setMode: (m: PlaybackMode) => void;
  /** Toggles shuffle without disturbing the current repeat setting — shuffle and repeat are independent. */
  toggleShuffle: () => void;
  /** Cycles repeat off -> all -> one -> off, preserving whatever shuffle is currently set to. */
  cycleRepeat: () => void;
  setEqBand: (i: number, dB: number) => Promise<void>;
  setEqPreset: (values: number[]) => Promise<void>;
  setEqEnabled: (on: boolean) => Promise<void>;
  toggleLove: (id: number) => Promise<boolean>;
  setTrackRating: (id: number, rating: number) => Promise<Track | null>;
  setTrackRatingScore: (id: number, score: number | null) => Promise<Track | null>;
  toggleAvoidAutoPlay: (id: number) => Promise<Track | null>;
  setTheme: (theme: AppSettings['theme']) => Promise<void>;
  cycleTheme: () => Promise<void>;
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
// Two writes can be in flight at once (the timer re-arms before the first
// settles); only the newest one's reply may replace the settings snapshot.
let volumePersistSeq = 0;
// The visualizer preset save in flight last: a held arrow key makes a save per step.
let vizPresetSeq = 0;
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
    const seq = ++volumePersistSeq;
    void api
      .setSettings({ volume: pending })
      .then((updated) => {
        if (seq === volumePersistSeq) apply(updated);
      })
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
  if (!track || !playing || activePreview || !state.settings?.lastfmEnabled || !lastfmPlayKey) return;
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
// The track the last prepare handed the engine, so the sample transport's
// splice can be re-pointed when the queue changes inside the prepare window.
let lastPreparedNextTrackId: number | null = null;
// Populated by the gapless-prepare branch below when it picks a shuffle
// candidate ahead of time; consumed by autoAdvance() so the automatic
// advance commits the exact track the engine already decoded into the idle
// deck. A manual next() always clears this instead of trusting it — see
// shared/shuffle-handoff.ts for why a stale pick cannot just be reused.
let cachedShuffleHandoff: ShuffleHandoffCache | null = null;
let lastStopAfterCurrentKey: string | null = null;
let lastPlaybackErrorKey: string | null = null;
// Dedup for the auto-advance-on-end branch. The exclusive bridge patches
// ended:true and the flag persists in merged engine state until a new play
// resolves (an async IPC round-trip), so intervening notifies would re-fire
// next() and skip tracks without this key. Cleared whenever ended is false.
let lastEndedKey: string | null = null;
// Tracks that failed one after another with no audible playback between. A
// dead drive makes every queued track fail the same way; this is what lets
// the skip-ahead loop stop instead of cycling through them forever.
let consecutivePlaybackFailures = 0;

interface PlaybackSnapshot {
  queue: Track[];
  index: number;
  current: Track | null;
  currentTime: number;
  duration: number;
  resumeAt: number | null;
  mode: PlaybackMode;
  shuffleHistory: number[];
  activePodcastEpisode: PlayerState['activePodcastEpisode'];
}

// While a preview plays (the Wrapped export scoring itself with a track), the
// listener's real queue waits here: nothing the preview does is counted,
// scrobbled or written to the saved session.
let activePreview: { snapshot: PlaybackSnapshot } | null = null;
let starterQueuePending = false;
let tracksRemovedOff: (() => void) | null = null;

// The view restored at launch, kept so init can fall back to Home when there
// is no library for it to show.
let launchView: ViewMode | null = null;

/** The shuffle history after tracks were spliced into the queue: played tracks stay played. */
function historyAfterInsert(state: PlayerState, insertAt: number, count: number): number[] {
  return isShuffleMode(state.mode)
    ? remapShuffleHistory(state.shuffleHistory, insertionIndexMap(insertAt, count))
    : [];
}

/** The same history with `index` as the track now playing. */
function historyEndingAt(history: number[], index: number): number[] {
  return [...history.filter((entry) => entry !== index), index];
}

/**
 * What a shuffle plays when its playing track left the queue: a track this
 * cycle has not played, not whichever one slid into the gap. Null when the
 * cycle is over and repeat-all is not starting another.
 */
function shuffleAfterRemoval(mode: PlaybackMode, queueLength: number, survivingHistory: number[]): { index: number; history: number[] } | null {
  const pick = smartShuffleAfterRemoval({ queueLength, history: survivingHistory });
  if (pick.index < 0 || (pick.exhausted && repeatModeOf(mode) !== 'all')) return null;
  return { index: pick.index, history: pick.history };
}

/** A track started from scratch is eligible for its own crossfade and gapless prepare again. */
function resetHandoffState(): void {
  lastHandoffKey = null;
  lastPreparedHandoffKey = null;
  lastPreparedNextTrackId = null;
  cachedShuffleHandoff = null;
}

/** Something else took over playback: the preview is no longer ours to put back. Reports whether one was running. */
function abandonPreview(): boolean {
  const wasPreviewing = activePreview !== null;
  activePreview = null;
  return wasPreviewing;
}

export interface PlaybackSessionPersistSnapshot {
  currentTrackId: number | null;
  currentTime: number;
  isPlaying: boolean;
}

export function shouldForcePlaybackSessionPersist(
  previous: PlaybackSessionPersistSnapshot,
  next: PlaybackSessionPersistSnapshot,
): boolean {
  if (previous.currentTrackId === null || previous.currentTrackId !== next.currentTrackId) return false;
  if (previous.isPlaying && !next.isPlaying) return true;
  return !previous.isPlaying && !next.isPlaying && Math.abs(next.currentTime - previous.currentTime) >= 0.25;
}

function playbackResumeEntryTrackId(entry: PlaybackResumeQueueEntry): number {
  return entry.kind === 'local' ? entry.trackId : entry.track.id;
}

function isValidResumeServerPath(path: string, connectionId: string, itemId: string): boolean {
  try {
    const url = new URL(path);
    if (url.search || url.hash) return false;
    const parsed = parseMusicServerStreamUrl(path);
    return parsed.connectionId === connectionId && parsed.itemId === itemId;
  } catch {
    return false;
  }
}

function playbackResumeServerTrackPayload(track: Track): PlaybackResumeServerTrack {
  return {
    id: track.id,
    path: track.path,
    title: track.title,
    artist: track.artist,
    album: track.album,
    albumArtist: track.albumArtist,
    trackNo: track.trackNo,
    discNo: track.discNo,
    year: track.year,
    genre: track.genre,
    duration: track.duration,
    bitrate: track.bitrate,
    sampleRate: track.sampleRate,
    size: track.size,
  };
}

export function playbackResumeQueueEntryForTrack(track: Track): PlaybackResumeQueueEntry | null {
  if (Number.isSafeInteger(track.id) && track.id > 0) return { kind: 'local', trackId: track.id };
  if (!Number.isSafeInteger(track.id) || track.id >= 0) return null;
  try {
    const url = new URL(track.path);
    if (url.search || url.hash) return null;
    const parsed = parseMusicServerStreamUrl(track.path);
    return {
      kind: 'music-server',
      connectionId: parsed.connectionId,
      itemId: parsed.itemId,
      track: playbackResumeServerTrackPayload(track),
    };
  } catch {
    return null;
  }
}

export function playbackResumeStateForQueueSnapshot(input: {
  queue: Track[];
  index: number;
  current: Track | null;
  currentTime: number;
  mode: PlaybackMode;
  updatedAt?: number;
}): PlaybackResumeState | null {
  const queue = input.queue
    .map(playbackResumeQueueEntryForTrack)
    .filter((entry): entry is PlaybackResumeQueueEntry => entry !== null);
  if (!queue.length) return null;
  const queueTrackIds = queue.map(playbackResumeEntryTrackId);
  const rawIndex = Math.trunc(Number(input.index));
  const index = Number.isFinite(rawIndex) ? Math.max(-1, Math.min(queue.length - 1, rawIndex)) : 0;
  const currentId = input.current?.id ?? null;
  const currentTrackId = currentId !== null && queueTrackIds.includes(currentId) ? currentId : null;
  const updatedAt = Number(input.updatedAt ?? Date.now());
  return {
    queueTrackIds,
    queue,
    index,
    currentTrackId,
    currentTime: Math.max(0, Number(input.currentTime) || 0),
    mode: input.mode,
    updatedAt: Number.isFinite(updatedAt) ? Math.max(0, updatedAt) : Date.now(),
  };
}

function playbackResumeQueueEntries(resumeState: PlaybackResumeState): PlaybackResumeQueueEntry[] {
  if (resumeState.queue?.length) return resumeState.queue;
  return resumeState.queueTrackIds
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .map((trackId) => ({ kind: 'local' as const, trackId }));
}

function trackFromPlaybackResumeServerEntry(entry: PlaybackResumeQueueEntry): Track | null {
  if (entry.kind !== 'music-server') return null;
  const track = entry.track;
  if (!Number.isSafeInteger(track.id) || track.id >= 0) return null;
  if (!isValidResumeServerPath(track.path, entry.connectionId, entry.itemId)) return null;
  return {
    id: track.id,
    path: track.path,
    title: track.title,
    artist: track.artist,
    album: track.album,
    albumArtist: track.albumArtist,
    trackNo: track.trackNo,
    discNo: track.discNo,
    year: track.year,
    genre: track.genre,
    duration: track.duration,
    bitrate: track.bitrate,
    sampleRate: track.sampleRate,
    size: track.size,
    mtime: 0,
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

export function restoreTracksFromPlaybackResumeState(
  resumeState: PlaybackResumeState | null,
  localTracks: Track[],
  musicServers: Pick<SavedMusicServer, 'id' | 'remembered'>[],
): { savedIds: number[]; tracks: Track[] } {
  if (!resumeState) return { savedIds: [], tracks: [] };
  const entries = playbackResumeQueueEntries(resumeState);
  const savedIds = entries.map(playbackResumeEntryTrackId);
  const localById = new Map(localTracks.map((track) => [track.id, track]));
  const rememberedConnections = new Set(musicServers.filter((server) => server.remembered).map((server) => server.id));
  const tracks: Track[] = [];
  for (const entry of entries) {
    if (entry.kind === 'local') {
      const track = localById.get(entry.trackId);
      if (track) tracks.push(track);
      continue;
    }
    if (!rememberedConnections.has(entry.connectionId)) continue;
    const track = trackFromPlaybackResumeServerEntry(entry);
    if (track) tracks.push(track);
  }
  return { savedIds, tracks };
}

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

// The engine reports buffering for the first moments of every track, so the
// indicator only comes up when the wait outlasts this.
const BUFFERING_NOTICE_MS = 300;
let bufferingNoticeTimer: number | null = null;

function reflectBuffering(waiting: boolean, getState: () => PlayerState, setState: (partial: Partial<PlayerState>) => void): void {
  if (!waiting) {
    if (bufferingNoticeTimer != null) {
      window.clearTimeout(bufferingNoticeTimer);
      bufferingNoticeTimer = null;
    }
    if (getState().isBuffering) setState({ isBuffering: false });
    return;
  }
  if (bufferingNoticeTimer != null || getState().isBuffering) return;
  bufferingNoticeTimer = window.setTimeout(() => {
    bufferingNoticeTimer = null;
    setState({ isBuffering: true });
  }, BUFFERING_NOTICE_MS);
}

async function restorePlaybackSession(
  resumeState: PlaybackResumeState | null,
  settings: AppSettings,
  setState: (partial: Partial<PlayerState>) => void,
  canRestore: () => boolean,
  storedMode: PlaybackMode | null = null,
): Promise<void> {
  if (!resumeState) return;
  const entries = playbackResumeQueueEntries(resumeState);
  if (!entries.length) return;
  const localIds = entries
    .filter((entry): entry is Extract<PlaybackResumeQueueEntry, { kind: 'local' }> => entry.kind === 'local')
    .map((entry) => entry.trackId);
  const hasServerEntries = entries.some((entry) => entry.kind === 'music-server');
  // Single batch IPC call instead of one getTrack() round trip per queued
  // track — the batch endpoint already exists and is preload-wired.
  const [fetched, musicServers] = await Promise.all([
    localIds.length ? api.getTracksByIds(localIds).catch(() => []) : Promise.resolve([]),
    hasServerEntries ? api.getMusicServers().catch(() => []) : Promise.resolve([]),
  ]);
  if (!canRestore()) return;
  const { savedIds, tracks } = restoreTracksFromPlaybackResumeState(resumeState, fetched, musicServers);
  if (!tracks.length) return;
  const { index, currentSurvived } = resolveResumePosition(
    savedIds,
    resumeState.index,
    resumeState.currentTrackId,
    new Set(tracks.map((track) => track.id)),
  );
  const current = index >= 0 ? tracks[index] ?? null : null;
  // The saved position only means anything on the track it was saved for; a
  // nearest-survivor fallback starts from the top, and an idle queue has none.
  const resumeTime = current && currentSurvived ? resumeState.currentTime : 0;
  const mode = storedMode ?? resumeState.mode;
  setState({
    queue: tracks,
    index,
    current,
    currentTime: resumeTime,
    duration: current?.duration ?? 0,
    mode,
    shuffleHistory: isShuffleMode(mode) ? resetSmartShuffleHistory(tracks.length, index) : [],
    resumeAt: current ? resumeTime : null,
  });
  applyReplayGain(current, settings);
}

async function persistPlaybackSession(state: PlayerState): Promise<void> {
  if (!state.settings) return;
  // A preview borrows the queue; the saved session stays the listener's own.
  const source = activePreview?.snapshot ?? state;
  const resumeState = playbackResumeStateForQueueSnapshot({
    queue: source.queue,
    index: source.index,
    current: source.current,
    currentTime: source.currentTime,
    mode: source.mode,
  });
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

export interface QueueAdvance {
  index: number;
  history: number[];
  /** Nothing follows: the queue ran out, or a shuffle cycle finished, and repeat is not wrapping. */
  atEnd: boolean;
}

// Passing over missing tracks is bounded so a mostly-offline library cannot
// turn one Next press into a walk through the whole queue.
const MAX_MISSING_SKIPS = 32;

/**
 * What plays after the current track. Entries flagged missing are passed over
 * while a playable one exists, so an unplugged drive is not walked through one
 * failure at a time. After an error repeat-one moves on as well, since
 * replaying the track that just failed would loop forever.
 */
export function resolveQueueAdvance(input: {
  queue: ReadonlyArray<Pick<Track, 'missingSince'>>;
  index: number;
  mode: PlaybackMode;
  history: number[];
  afterError?: boolean;
  random?: () => number;
}): QueueAdvance {
  const { queue, index, mode } = input;
  const length = queue.length;
  if (!length) return { index: -1, history: [], atEnd: true };
  const repeat = repeatModeOf(mode);
  const wraps = repeat === 'all' || (input.afterError === true && repeat === 'one');
  const isMissing = (i: number): boolean => queue[i]?.missingSince != null;

  if (isShuffleMode(mode)) {
    let history = input.history;
    let from = index;
    let skipped: number[] = [];
    let first: QueueAdvance | null = null;
    for (let attempt = 0; attempt <= MAX_MISSING_SKIPS; attempt += 1) {
      const decision = nextSmartShuffle({ queueLength: length, currentIndex: from, history }, input.random);
      // Every track has played and repeat is not asking for another cycle. On
      // a later attempt it only means no playable track was left.
      if (decision.exhausted && !wraps) return first ?? { index: -1, history: input.history, atEnd: true };
      if (decision.exhausted) skipped = [];
      const pick: QueueAdvance = { index: decision.index, history: decision.history, atEnd: false };
      first ??= pick;
      if (!isMissing(decision.index)) {
        if (!skipped.length) return pick;
        // Passed-over tracks count as played but sit at the far end of the
        // history, so Prev does not step back onto them.
        const passed = new Set(skipped);
        return { ...pick, history: [...skipped, ...pick.history.filter((i) => !passed.has(i))] };
      }
      skipped.push(decision.index);
      history = decision.history;
      from = decision.index;
    }
    return first ?? { index: -1, history: input.history, atEnd: true };
  }

  let next = index + 1;
  if (next >= length) {
    if (!wraps) return { index: -1, history: input.history, atEnd: true };
    next = 0;
  }
  let candidate = next;
  for (let step = 0; step < length; step += 1) {
    if (!isMissing(candidate)) return { index: candidate, history: input.history, atEnd: false };
    candidate += 1;
    if (candidate >= length) {
      if (!wraps) break;
      candidate = 0;
    }
  }
  return { index: next, history: input.history, atEnd: false };
}

/** Tracks still to come: what follows the index, or what a shuffle cycle has not played yet. */
function remainingAheadOf(state: PlayerState): number {
  if (isShuffleMode(state.mode) && state.index >= 0) {
    return shuffleUnplayedCount(state.shuffleHistory, state.queue.length, state.index);
  }
  return Math.max(0, state.queue.length - state.index - 1);
}

/** shouldAutoDjRefill measures from an index; in shuffle that is however far the cycle has got. */
function autoDjRefillIndex(state: PlayerState): number {
  return state.queue.length - 1 - remainingAheadOf(state);
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

  const advance = resolveQueueAdvance({
    queue: state.queue,
    index: state.index,
    mode: state.mode,
    history: state.shuffleHistory,
    afterError: true,
  });
  const nextIndex = advance.index;
  const nextShuffleHistory = advance.history;
  if (advance.atEnd || nextIndex < 0 || nextIndex >= state.queue.length || nextIndex === state.index) {
    engine.stop();
    return;
  }

  const nextTrack = state.queue[nextIndex]!;
  resetHandoffState();
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
    if (!(await playEngineTrack(nextTrack))) return;
    lastPlaybackErrorKey = null;
    startLastfmNowPlaying(nextTrack);
    recordLibraryPlay(nextTrack);
    if (shouldAutoDjRefill({ enabled: getState().autoDjEnabled, queueLength: getState().queue.length, index: autoDjRefillIndex(getState()) })) {
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
  // The sample transport reports the length its decoder found, which a
  // missing or stale library row can't match; the prepare window for the
  // next track is timed off this too.
  if (track && engineDuration > 0 && engine.isSampleTransportActive() && engine.getState().trackId === track.id) {
    return engineDuration;
  }
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

/** What the engine needs to know to keep CUE segments and missing files off the sample transport. */
function trackRouting(track: Track): TrackRouting {
  return {
    cue: !!track.cuePath || cueStart(track) > 0 || cueEnd(track) != null,
    missing: track.missingSince != null,
  };
}

// Every request to start a track takes a ticket here; only the newest ticket
// gets to run the store's side effects once the engine answers. Without it,
// clicking A then B before A had started recorded and scrobbled both.
const playIntents = createPlayIntentGate();
let queueRevision = 0;
let eqRevision = 0;

/**
 * Starts `track` and reports whether it is now the live one: false when a
 * newer request superseded it while the engine was working (or the engine
 * itself reported the request stale). Callers run Last.fm, play-count,
 * podcast-progress and Auto DJ side effects only on true. A playback failure
 * of the current request still throws, as before.
 */
async function playEngineTrack(track: Track, startAt = 0): Promise<boolean> {
  queueRevision++;
  lastCueEndKey = null;
  const intent = playIntents.begin();
  const outcome = await engine.play(toAudioUrl(track.path), track.id, cueStart(track) + startAt, trackRouting(track));
  return outcome === 'started' && playIntents.isCurrent(intent);
}

/**
 * Bit-Perfect Exclusive is opt-in audiophile territory — lazy-load the bridge
 * (and its FFT tap tables) so the main renderer chunk pays nothing for it.
 */
async function loadExclusiveBridge(): Promise<
  typeof import('../audio/exclusive-bridge').exclusiveBridge
> {
  const module = await import('../audio/exclusive-bridge');
  return module.exclusiveBridge;
}

let sampleTransport: SampleTransport | null = null;

/** Sample-accurate gapless gets its own chunk too; it only loads when the setting is on. */
async function loadSampleTransport(): Promise<SampleTransport> {
  const module = await import('../audio/sample-transport');
  sampleTransport ??= new module.SampleTransport();
  return sampleTransport;
}

/**
 * Live output-route switch (Bit-Perfect Exclusive toggled or its device
 * changed): restart the playing track at its current position so audio moves
 * to the newly-selected path without waiting for the next track.
 */
async function restartCurrentTrackThroughActivePath(
  get: () => PlayerState,
): Promise<void> {
  const { current, currentTime, isPlaying } = get();
  if (!current || !isPlaying) return;
  const resumeAt = cueStart(current) + Math.max(0, currentTime);
  // A route restart is a new play request like any other: it must invalidate
  // an older request that is still waiting on the engine.
  playIntents.begin();
  await engine.play(toAudioUrl(current.path), current.id, resumeAt, trackRouting(current)).catch(() => undefined);
}

/**
 * Repeat-one on the sample transport chains the track to itself, so each
 * loop starts on the sample after the last one ended. The decks rewind in
 * place instead.
 */
function loopsOnTransport(state: PlayerState): boolean {
  return repeatModeOf(state.mode) === 'one' && engine.isSampleTransportActive();
}

/** Shuffle with repeat off plays each queued track once; true once it has. */
function shuffleCycleDone(state: PlayerState): boolean {
  return (
    isShuffleMode(state.mode) &&
    repeatModeOf(state.mode) === 'off' &&
    isShuffleCycleComplete(state.shuffleHistory, state.queue.length, state.index)
  );
}

/** What an automatic advance from the current position would play next, if anything. */
function desiredHandoffTrack(state: PlayerState): Track | null {
  if (loopsOnTransport(state)) return state.current;
  const queueLength = state.queue.length;
  if (isShuffleMode(state.mode)) {
    const shuffleCycleComplete = shuffleCycleDone(state);
    if (!state.current || !hasHandoffTarget({ queueLength, index: state.index, mode: state.mode, shuffleCycleComplete })) return null;
    // Same cached pick autoAdvance() will commit; re-picked only when the
    // queue or history it was validated against has changed.
    cachedShuffleHandoff = resolveShuffleHandoffPick(cachedShuffleHandoff, {
      trackId: state.current.id,
      index: state.index,
      queueLength,
      history: state.shuffleHistory,
    });
    return state.queue[cachedShuffleHandoff.index] ?? null;
  }
  const nextIndex = nextHandoffIndex({ queueLength, index: state.index, mode: state.mode });
  return nextIndex == null ? null : state.queue[nextIndex] ?? null;
}

function prepareEngineTrack(track: Track, settings: AppSettings | null): void {
  engine.prepareNext(
    toAudioUrl(track.path),
    track.id,
    cueStart(track),
    replayGainDbForTrack(track, settings),
    trackRouting(track),
  );
  // The visualizer's look-ahead needs the next track analysed before it starts.
  requestScorePrefetch(track.id);
}

async function commitPlaybackAdvance(
  getState: () => PlayerState,
  setState: (partial: Partial<PlayerState>) => void,
  nextIdx: number,
  nextShuffleHistory: number[],
): Promise<void> {
  const latestQueue = getState().queue;
  const t = latestQueue[nextIdx]!;
  setState({
    index: nextIdx,
    current: t,
    currentTime: 0,
    duration: t.duration ?? 0,
    resumeAt: null,
    activePodcastEpisode: null,
    shuffleHistory: nextShuffleHistory,
  });
  applyReplayGain(t, getState().settings);
  schedulePersistPlaybackSession(getState(), true);
  if (!(await playEngineTrack(t))) return;
  lastPlaybackErrorKey = null;
  startLastfmNowPlaying(t);
  recordLibraryPlay(t);
  if (shouldAutoDjRefill({ enabled: getState().autoDjEnabled, queueLength: getState().queue.length, index: autoDjRefillIndex(getState()) })) {
    void getState().refillAutoDjQueue();
  }
}

/**
 * Automatic advance — natural end-of-track, a cued segment ending, or an
 * early crossfade start — as opposed to a direct user/UI call to next().
 * Consumes a cached shuffle handoff pick when the gapless-prepare step
 * already computed and validated one for this exact position, so the
 * commit matches whatever the engine decoded into the idle deck; otherwise
 * falls through to the normal (and, for shuffle, freshly-randomized)
 * next(). Keeping this split — rather than branching inside next() on a
 * "how was I called" flag — is what lets a manual next() unconditionally
 * invalidate the cache without also having to guess whether the call in
 * flight was really automatic.
 */
async function autoAdvance(
  getState: () => PlayerState,
  setState: (partial: Partial<PlayerState>) => void,
): Promise<void> {
  const state = getState();
  if (
    state.current &&
    isShuffleHandoffCacheValid(cachedShuffleHandoff, {
      trackId: state.current.id,
      index: state.index,
      queueLength: state.queue.length,
      history: state.shuffleHistory,
    })
  ) {
    const { index: nextIdx, history: nextShuffleHistory } = cachedShuffleHandoff;
    cachedShuffleHandoff = null;
    clearPlaybackErrorAdvanceTimer();
    recordManualSkip(state);
    await commitPlaybackAdvance(getState, setState, nextIdx, nextShuffleHistory);
    return;
  }
  cachedShuffleHandoff = null;
  await getState().next();
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

/**
 * Replaces the queue and starts one of its tracks. `skipRecord` is for a
 * track that left the library: it did not stop early, it stopped existing.
 */
async function startQueuePlayback(
  getState: () => PlayerState,
  setState: (partial: Partial<PlayerState>) => void,
  tracks: Track[],
  startIndex: number,
  startAt: number,
  options: { skipRecord?: boolean; shuffleHistory?: number[] } = {},
): Promise<void> {
  if (!tracks.length) return;
  const wasPreviewing = abandonPreview();
  clearPlaybackErrorAdvanceTimer();
  if (!wasPreviewing && !options.skipRecord) recordManualSkip(getState());
  resetHandoffState();
  lastStopAfterCurrentKey = null;
  lastPlaybackErrorKey = null;
  consecutivePlaybackFailures = 0;
  const q = [...tracks];
  const i = Math.max(0, Math.min(startIndex, q.length - 1));
  const t = q[i]!;
  const position = Number.isFinite(startAt) ? Math.max(0, Math.min(t.duration || Infinity, startAt)) : 0;
  setState({
    queue: q,
    index: i,
    current: t,
    currentTime: position,
    duration: t.duration ?? 0,
    resumeAt: null,
    playbackError: null,
    activePodcastEpisode: null,
    shuffleHistory: options.shuffleHistory ?? (isShuffleMode(getState().mode) ? resetSmartShuffleHistory(q.length, i) : []),
  });
  applyReplayGain(t, getState().settings);
  schedulePersistPlaybackSession(getState(), true);
  if (!(await playEngineTrack(t, position))) return;
  lastPlaybackErrorKey = null;
  startLastfmNowPlaying(t);
  recordLibraryPlay(t);
}

/**
 * Play with nothing loaded: queue a taste mix from the library, led by
 * today's pick when there is one, and say so. A choice the listener makes
 * while the tracks are being fetched wins.
 */
async function playStarterQueue(getState: () => PlayerState): Promise<void> {
  starterQueuePending = true;
  const revision = queueRevision;
  const intent = playIntents.begin();
  try {
    const [mix, history] = await Promise.all([
      api.buildTasteMix({ seedTrackId: null, count: STARTER_QUEUE_SIZE }).catch((): Track[] => []),
      api.getListeningHistory({ limit: 30 }).catch(() => []),
    ]);
    const candidates = mix.length
      ? mix
      : await api.getTracks({ sort: 'added', limit: STARTER_QUEUE_SIZE }).catch((): Track[] => []);
    const pick = pickToday(candidates, history.map((item) => item.track), null)?.track ?? null;
    const lead = starterQueueLead(pick);
    const queue = buildStarterQueue(candidates, pick);
    if (!queue.length) return;
    const now = getState();
    if (queueRevision !== revision || !playIntents.isCurrent(intent) || now.queue.length || now.current) return;
    await now.playQueue(queue, 0);
    pushToast({
      title: 'Nothing was queued',
      detail: lead
        ? `Playing today's pick, ${lead.title}, then a shuffle of your library.`
        : 'Playing a shuffle of your library.',
    });
  } finally {
    starterQueuePending = false;
  }
}

export const usePlayerStore = create<PlayerState>((set, get) => {
  // AudioEngine.subscribe emits immediately; defer until Zustand has installed the initial state.
  queueMicrotask(() => {
    engine.subscribe((s) => {
      const previousState = get();
      const activeTrack = previousState.current;
      const relativeTime = cueRelativeTime(activeTrack, s.currentTime);
      const displayDuration = cueDuration(activeTrack, s.duration);
      const forceSessionPersist = shouldForcePlaybackSessionPersist(
        {
          currentTrackId: activeTrack?.id ?? null,
          currentTime: previousState.currentTime,
          isPlaying: previousState.isPlaying,
        },
        {
          currentTrackId: activeTrack?.id ?? s.trackId ?? null,
          currentTime: relativeTime,
          isPlaying: s.playing,
        },
      );
      set({
        isPlaying: s.playing,
        currentTime: relativeTime,
        duration: displayDuration,
        playbackError: s.error,
      });
      reflectBuffering(s.buffering && !s.error, get, set);
      maybeScrobbleToLastfm(get(), relativeTime, s.playing);
      schedulePersistPlaybackSession(get(), forceSessionPersist);
      persistPodcastProgress(get(), s.ended, s.ended);
      notifyShellPlayback(get());
      // A preview only borrows the engine: it never advances, hands off, trips
      // the sleep timer or feeds the memory bridge.
      if (activePreview) return;
      if (s.playing && !s.error && relativeTime >= 0.5) consecutivePlaybackFailures = 0;
      const state = get();
      if (s.error) {
        const decision = resolvePlaybackErrorAdvance({
          error: s.error,
          currentTrackId: state.current?.id ?? s.trackId,
          index: state.index,
          queueLength: state.queue.length,
          mode: state.mode,
          lastErrorKey: lastPlaybackErrorKey,
          shuffleCycleComplete: shuffleCycleDone(state),
          consecutiveFailures: consecutivePlaybackFailures,
        });
        if (decision.key && (decision.shouldAdvance || decision.shouldStop)) {
          lastPlaybackErrorKey = decision.key;
          consecutivePlaybackFailures += 1;
        }
        if (decision.gaveUp) {
          pushToast({
            tone: 'error',
            title: 'Playback stopped',
            detail: `${consecutivePlaybackFailures.toLocaleString()} tracks in a row could not be played. If they are on a drive or a server, check that it is connected.`,
            durationMs: 8000,
          });
        }
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
        } else if (repeatModeOf(state.mode) === 'one' && state.current) {
          resetHandoffState();
          void playEngineTrack(state.current);
        } else {
          window.setTimeout(() => void autoAdvance(get, set), 0);
        }
        return;
      }
      if (
        shouldStopForSleepTimer({
          playing: s.playing,
          sleepTimerEndsAt: state.sleepTimerEndsAt,
        })
      ) {
        // Pause, not stop: stop() rewinds to 0:00 and persists that, which
        // costs a podcast listener their place.
        set({ sleepTimerEndsAt: null, stopAfterCurrent: false });
        engine.pause();
        return;
      }
      // Crossfade is structurally bypassed while Bit-Perfect Exclusive owns
      // the output: treat it as 0 here or a persisted crossfade setting would
      // (a) hard-cut tracks early via shouldStartTrackHandoff (no fade exists
      // to cover the jump) and (b) suppress the gapless prepare window that
      // drives exclusive-stream chaining.
      const effectiveCrossfadeMs = engine.getExclusiveInfo().active
        ? 0
        : state.settings?.crossfadeMs ?? 0;
      const loops = loopsOnTransport(state);
      const shuffleCycleComplete = shuffleCycleDone(state);
      if (
        !state.stopAfterCurrent &&
        shouldPrepareTrackHandoff({
          playing: s.playing,
          duration: displayDuration,
          currentTime: relativeTime,
          crossfadeMs: effectiveCrossfadeMs,
          queueLength,
          index: state.index ?? -1,
          mode: state.mode ?? 'normal',
          shuffleCycleComplete,
          currentTrackId: state.current?.id ?? null,
          lastHandoffKey: lastPreparedHandoffKey,
          loopsCurrent: loops,
        }) &&
        state.current
      ) {
        let nextTrack: Track | null;
        if (loops) {
          nextTrack = state.current;
        } else if (isShuffleMode(state.mode)) {
          // Cache the pick so autoAdvance() commits the exact track decoded
          // into the idle deck here — otherwise the prepare is wasted and
          // gapless playback silently falls back to today's hard cut.
          cachedShuffleHandoff = resolveShuffleHandoffPick(cachedShuffleHandoff, {
            trackId: state.current.id,
            index: state.index,
            queueLength: state.queue.length,
            history: state.shuffleHistory,
          });
          nextTrack = state.queue[cachedShuffleHandoff.index] ?? null;
        } else {
          const nextIndex = repeatModeOf(state.mode) === 'all' && state.index >= queueLength - 1 ? 0 : state.index + 1;
          nextTrack = state.queue[nextIndex] ?? null;
        }
        if (nextTrack) {
          lastPreparedHandoffKey = handoffKey(state.current.id, state.index);
          lastPreparedNextTrackId = nextTrack.id;
          prepareEngineTrack(nextTrack, state.settings);
        }
      }
      // The sample transport splices the prepared track into its stream ahead
      // of the boundary, so a queue edit, Stop after current, or a mode change
      // inside the prepare window has to re-point it; otherwise the stale pick
      // is heard for a moment before the store moves on. A stale deck preload
      // is simply never played, so the deck path doesn't need this.
      if (
        engine.isSampleTransportActive() &&
        state.current &&
        lastPreparedHandoffKey === handoffKey(state.current.id, state.index)
      ) {
        const desired = state.stopAfterCurrent ? null : desiredHandoffTrack(state);
        if ((desired?.id ?? null) !== lastPreparedNextTrackId) {
          lastPreparedNextTrackId = desired?.id ?? null;
          if (desired) prepareEngineTrack(desired, state.settings);
          else engine.clearPreparedNext();
        }
      }
      if (
        !state.stopAfterCurrent &&
        shouldStartTrackHandoff({
          playing: s.playing,
          duration: displayDuration,
          currentTime: relativeTime,
          crossfadeMs: effectiveCrossfadeMs,
          queueLength,
          index: state.index ?? -1,
          mode: state.mode ?? 'normal',
          shuffleCycleComplete,
          currentTrackId: state.current?.id ?? null,
          lastHandoffKey,
        }) &&
        state.current
      ) {
        lastHandoffKey = handoffKey(state.current.id, state.index);
        void autoAdvance(get, set);
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
      // auto-advance on end — key-guarded like every other branch above:
      // ended:true can persist across multiple notifies (exclusive mode holds
      // it until the next play's IPC ack), and next() advances index
      // synchronously, so an unguarded re-fire skips tracks.
      if (!s.ended) {
        lastEndedKey = null;
      } else {
        const endedKey = `${state.current?.id ?? 'x'}:${state.index}`;
        if (lastEndedKey !== endedKey) {
          lastEndedKey = endedKey;
          if (repeatModeOf(get().mode) !== 'one') {
            // The engine reached the end of this track. Notify the eviland
            // memory bridge so the play counter ticks (drives the 8/32/96/256
            // generation ladder). The registry routes to the active bridge IFF
            // its trackId matches — wrong-track and no-bridge are cheap no-ops.
            notifyPlayCompleted(state.current?.id ?? null);
            // small delay to avoid re-entry
            setTimeout(() => void autoAdvance(get, set), 0);
          } else if (get().current) {
            // repeat-one: the same track is about to play again. From the
            // player's POV that's a completed play, so the counter ticks too.
            notifyPlayCompleted(state.current?.id ?? null);
            // Every loop has its own prepare window: the next one chains the
            // track to itself again on the sample transport.
            resetHandoffState();
            const c = get().current!;
            void playEngineTrack(c);
          }
        }
      }
    });
  });

  // A view changes behind a deck or the fullscreen visualizer without anyone
  // seeing it, so a deliberate jump leaves them first.
  const leaveStage = (): void => {
    if (get().fullscreenViz) set({ fullscreenViz: false });
    if (get().compactMode) get().setCompactMode(false);
  };
  const commitView = (view: ViewMode, extra: Partial<PlayerState> = {}): void => {
    set({ view, ...extra });
    if (parseStoredView(view)) writeStored(VIEW_STORAGE_KEY, view);
  };

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
    isBuffering: false,
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
    evilandWaveMode: 'auto',
    searchQuery: '',
    showEq: false,
    pendingNavigation: null,

    init: async () => {
      const initialRevision = queueRevision;
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
      if (settings.bitPerfectExclusive) {
        void loadExclusiveBridge().then(async (bridge) => {
          const active = await bridge.setEnabled(engine, true);
          if (!active) {
            // Setting persisted on a machine where the addon can't load —
            // surface reality instead of a dead toggle.
            const reverted = await api
              .setSettings({ bitPerfectExclusive: false })
              .catch(() => null);
            if (reverted) set({ settings: reverted });
          }
        });
      }
      if (inElectron && settings.sampleAccurateGapless) {
        void loadSampleTransport().then((transport) => {
          if (get().settings?.sampleAccurateGapless !== false) engine.setSampleTransport(transport);
        });
      }
      engine.setVolume(settings.volume);
      engine.setPlaybackRate(settings.playbackRate);
      engine.setCrossfadeMs(settings.crossfadeMs);
      engine.setLimiterEnabled(settings.limiterEnabled);
      engine.setPreampDb(settings.preampDb);
      engine.setEqBands(settings.equalizer);
      engine.setEqEnabled(settings.eqEnabled);
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
      // A repeated init replaces the listener instead of stacking another.
      tracksRemovedOff?.();
      const removedOff = api.onTracksRemoved((ids) => void get().dropTracks(ids));
      tracksRemovedOff = typeof removedOff === 'function' ? removedOff : null;
      applyTheme(settings.theme, settings.customSkin);
      // The remembered view only makes sense with a library to look at, and
      // the first-launch tour starts from Home.
      if (launchView && get().view === launchView && (!settings.libraryRoots?.length || !settings.firstLaunchTutorialSeen)) {
        set({ view: 'home' });
      }
      launchView = null;
      // Kept apart from the resume state, which is empty whenever the queue is.
      const storedMode = parseStoredPlaybackMode(readStored(PLAYBACK_MODE_STORAGE_KEY));
      if (storedMode) set({ mode: storedMode });
      await restorePlaybackSession(settings.resumeState, settings, set, () => queueRevision === initialRevision, storedMode);
    },

    persistPlaybackSession: async () => persistPlaybackSession(get()),

    setView: (v) => commitView(v),
    openView: (v) => {
      leaveStage();
      commitView(v);
    },
    navigateToArtist: (name) => {
      const cleaned = (name ?? '').trim();
      if (!cleaned) return;
      leaveStage();
      commitView('artists', { pendingNavigation: { kind: 'artist', name: cleaned } });
    },
    navigateToAlbum: (album, albumArtist) => {
      const a = (album ?? '').trim();
      if (!a) return;
      leaveStage();
      commitView('albums', {
        pendingNavigation: { kind: 'album', album: a, albumArtist: (albumArtist ?? '').trim() },
      });
    },
    navigateToPlaylist: (playlistId) => {
      if (!(playlistId > 0)) return;
      leaveStage();
      commitView('playlist', { pendingNavigation: { kind: 'playlist', playlistId } });
    },
    navigateToTrack: (track) => {
      // Track navigation lands on the album detail with the row highlighted;
      // a track with no album falls back to its artist page (better than a
      // dead end for loose singles).
      const album = (track.album ?? '').trim();
      if (album) {
        leaveStage();
        commitView('albums', {
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
      const seq = ++vizPresetSeq;
      set({ vizPreset: name });
      void api
        .setSettings({ visualizerPreset: name })
        .then((settings) => {
          // Each save echoes the preset it stored. With a newer pick already on
          // screen, an older echo must not put the state back to where it was.
          if (seq === vizPresetSeq) set({ settings, vizPreset: settings.visualizerPreset });
          else set((s) => ({ settings: { ...settings, visualizerPreset: s.vizPreset } }));
        })
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
      // The seed is kept as a code in the randomizer's format, so the seed box
      // shows something that pastes back to the same look. Text that is
      // already a code stays that code; any other text is hashed into one.
      const typed = seed?.trim();
      const code = typed ? (canonicalSeedCode(typed) ?? seedCodeFor(typed)) : randomSeedCode();
      // The nonce is bumped inside the functional updater so two rapid calls
      // can't both read the same value and clobber each other's bump.
      set((s) => ({
        evilandSeed: code,
        evilandConfigNonce: s.evilandConfigNonce + 1,
        // Manual look — let it stick. The Director toggle is a separate axis;
        // the user can re-enable it explicitly when they want the song back
        // in charge.
        evilandDirector: false,
      }));
    },
    skipEvilandLook: () => {
      if (get().evilandDirector) requestLookSkip();
      else get().randomizeEviland();
    },
    previousEvilandLook: () => {
      if (get().evilandDirector) requestLookBack();
    },
    applyEvilandCode: (code) => {
      const trimmed = (code ?? '').trim();
      if (!trimmed) return false;
      // Null for unrecognisable codes — surface that to the caller so the UI
      // can toast/inline-error without us having to throw.
      const canonical = canonicalSeedCode(trimmed);
      if (!canonical) return false;
      set((s) => ({
        evilandSeed: canonical,
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
      if (!abandonPreview()) recordManualSkip(get());
      resetHandoffState();
      lastStopAfterCurrentKey = null;
      lastPlaybackErrorKey = null;
      consecutivePlaybackFailures = 0;
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
        shuffleHistory: isShuffleMode(get().mode) ? resetSmartShuffleHistory(q.length, nextIndex) : [],
      });
      applyReplayGain(track, get().settings);
      schedulePersistPlaybackSession(get(), true);
      if (!(await playEngineTrack(track))) return;
      lastPlaybackErrorKey = null;
      startLastfmNowPlaying(track);
      recordLibraryPlay(track);
    },

    playPodcastEpisode: async (episode) => {
      clearPlaybackErrorAdvanceTimer();
      const track = podcastEpisodeToTrack(episode);
      abandonPreview();
      resetHandoffState();
      lastStopAfterCurrentKey = null;
      lastPlaybackErrorKey = null;
      consecutivePlaybackFailures = 0;
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
      if (!(await playEngineTrack(track))) return;
      const resumeAt = episode.completed ? 0 : Math.max(0, episode.progressSeconds);
      if (resumeAt > 0) engine.seek(resumeAt);
      persistPodcastProgress(get(), true, false);
    },

    playQueue: (tracks, startIndex = 0, startAt = 0) => startQueuePlayback(get, set, tracks, startIndex, startAt),

    playTracksNow: async (tracks) => {
      if (!tracks.length) return;
      const state = get();
      // A podcast episode is not a queue the listener built, so it is replaced
      // like an empty one rather than left behind as a track.
      if (!state.queue.length || state.activePodcastEpisode) {
        await startQueuePlayback(get, set, tracks, 0, 0);
        return;
      }
      queueRevision++;
      const insertAt = playNextInsertAt(state.queue.length, state.index);
      const result = insertTracksNext(state.queue, state.index, tracks);
      await startQueuePlayback(get, set, result.queue, insertAt, 0, {
        shuffleHistory: isShuffleMode(state.mode)
          ? historyEndingAt(historyAfterInsert(state, insertAt, tracks.length), insertAt)
          : [],
      });
    },

    previewTrack: async (track) => {
      const state = get();
      // A second preview keeps the first one's snapshot: that is the real queue.
      activePreview ??= {
        snapshot: {
          queue: state.queue,
          index: state.index,
          current: state.current,
          currentTime: state.currentTime,
          duration: state.duration,
          resumeAt: state.resumeAt,
          mode: state.mode,
          shuffleHistory: state.shuffleHistory,
          activePodcastEpisode: state.activePodcastEpisode,
        },
      };
      clearPlaybackErrorAdvanceTimer();
      resetHandoffState();
      lastStopAfterCurrentKey = null;
      lastPlaybackErrorKey = null;
      set({
        queue: [track],
        index: 0,
        current: track,
        currentTime: 0,
        duration: track.duration ?? 0,
        resumeAt: null,
        playbackError: null,
        activePodcastEpisode: null,
        shuffleHistory: [],
      });
      applyReplayGain(track, get().settings);
      try {
        if (!(await playEngineTrack(track))) return;
      } catch (err) {
        get().endPreview();
        throw err;
      }
    },

    endPreview: () => {
      const preview = activePreview;
      if (!preview) return;
      const snapshot = preview.snapshot;
      queueRevision++;
      playIntents.begin();
      clearPlaybackErrorAdvanceTimer();
      resetHandoffState();
      lastStopAfterCurrentKey = null;
      lastPlaybackErrorKey = null;
      // Unloading notifies the engine subscription synchronously. While the
      // preview flag is still up it saves the real queue, not the preview's.
      engine.unload();
      activePreview = null;
      // Put back the way Undo clear does: paused, at the place it was left.
      const position = snapshot.current ? snapshot.resumeAt ?? snapshot.currentTime : 0;
      set({
        queue: snapshot.queue,
        index: snapshot.index,
        current: snapshot.current,
        currentTime: position,
        duration: snapshot.duration,
        resumeAt: snapshot.current ? position : null,
        isPlaying: false,
        playbackError: null,
        stopAfterCurrent: false,
        shuffleHistory: snapshot.shuffleHistory,
        activePodcastEpisode: snapshot.activePodcastEpisode,
      });
      applyReplayGain(snapshot.current, get().settings);
      schedulePersistPlaybackSession(get(), true);
      notifyShellPlayback(get());
    },

    loadQueue: (tracks) => {
      queueRevision++;
      abandonPreview();
      clearPlaybackErrorAdvanceTimer();
      playIntents.begin();
      resetHandoffState();
      lastStopAfterCurrentKey = null;
      lastPlaybackErrorKey = null;
      consecutivePlaybackFailures = 0;
      engine.unload();
      set({ isPlaying: false, stopAfterCurrent: false, queue: [...tracks], index: -1, current: null, resumeAt: null, currentTime: 0, duration: 0, playbackError: null, shuffleHistory: [], activePodcastEpisode: null });
      schedulePersistPlaybackSession(get(), true);
      if (get().autoDjEnabled) void get().refillAutoDjQueue(true);
    },

    queueTrackNext: (track) => get().queueTracksNext([track]),

    addTrackToQueue: (track) => get().addTracksToQueue([track]),

    queueTracksNext: (tracks) => {
      if (!tracks.length) return;
      queueRevision++;
      const state = get();
      const result = insertTracksNext(state.queue, state.index, tracks);
      set({
        queue: result.queue,
        index: result.index,
        shuffleHistory: historyAfterInsert(state, playNextInsertAt(state.queue.length, state.index), tracks.length),
      });
      schedulePersistPlaybackSession(get(), true);
    },

    addTracksToQueue: (tracks) => {
      if (!tracks.length) return;
      queueRevision++;
      const state = get();
      const result = appendTracksToQueue(state.queue, state.index, tracks);
      set({
        queue: result.queue,
        index: result.index,
        shuffleHistory: historyAfterInsert(state, state.queue.length, tracks.length),
      });
      schedulePersistPlaybackSession(get(), true);
    },

    moveQueuedTrack: (fromIndex, toIndex) => {
      queueRevision++;
      const state = get();
      const result = moveQueueItem(state.queue, state.index, fromIndex, toIndex);
      set({
        queue: result.queue,
        index: result.index,
        shuffleHistory: isShuffleMode(state.mode)
          ? remapShuffleHistory(state.shuffleHistory, moveIndexMap(state.queue.length, fromIndex, toIndex))
          : [],
      });
      schedulePersistPlaybackSession(get(), true);
    },

    removeQueuedTrack: async (removeIndex) => {
      queueRevision++;
      const state = get();
      const result = removeQueueItem(state.queue, state.index, removeIndex);
      const shuffling = isShuffleMode(state.mode);
      const survivingHistory = shuffling
        ? remapShuffleHistory(state.shuffleHistory, removeIndexMap(state.queue.length, removeIndex))
        : [];
      if (!result.queue.length) {
        // Removing the last track is also a removed-current case, so it needs
        // the same unload() as the branch below: stop() leaves src/trackId on
        // the deck, and a later Play would resume the track just removed.
        engine.unload();
        set({ queue: [], index: -1, current: null, currentTime: 0, duration: 0, resumeAt: null, stopAfterCurrent: false, shuffleHistory: [], activePodcastEpisode: null });
        schedulePersistPlaybackSession(get(), true);
        return;
      }
      if (result.removedCurrent) {
        const nextCurrent = result.queue[result.index] ?? null;
        const shuffleHistory = shuffling ? historyEndingAt(survivingHistory, result.index) : [];
        // Nothing follows the last entry unless repeat-all wraps around to the
        // top, so playback ends rather than falling back onto the track before.
        const nothingFollows = !shuffling && state.index >= state.queue.length - 1;
        const wraps = repeatModeOf(state.mode) === 'all';
        const shufflePick = shuffling && state.isPlaying ? shuffleAfterRemoval(state.mode, result.queue.length, survivingHistory) : null;
        if (shufflePick) {
          await startQueuePlayback(get, set, result.queue, shufflePick.index, 0, { shuffleHistory: shufflePick.history });
          return;
        }
        if (!shuffling && state.isPlaying && nextCurrent && (!nothingFollows || wraps)) {
          await startQueuePlayback(get, set, result.queue, nothingFollows ? 0 : result.index, 0, { shuffleHistory });
          return;
        }
        // Not continuing: startQueuePlayback() above won't run to hand the
        // engine a fresh src, so without this the engine keeps holding the
        // just-removed track (stop() alone doesn't clear src/trackId) — a
        // later Play would resume the removed track instead of loading
        // nextCurrent.
        engine.unload();
        set({
          queue: result.queue,
          index: result.index,
          current: nextCurrent,
          currentTime: 0,
          duration: nextCurrent?.duration ?? 0,
          resumeAt: null,
          isPlaying: false,
          activePodcastEpisode: null,
          shuffleHistory,
        });
        applyReplayGain(nextCurrent, get().settings);
      } else {
        set({ queue: result.queue, index: result.index, shuffleHistory: survivingHistory });
      }
      schedulePersistPlaybackSession(get(), true);
    },

    dropTracks: async (ids) => {
      const gone = new Set(ids);
      const state = get();
      const currentGone = !!state.current && gone.has(state.current.id);
      if (!currentGone && !state.queue.some((track) => gone.has(track.id))) return;
      queueRevision++;
      const queue = state.queue.filter((track) => !gone.has(track.id));
      if (!queue.length) {
        engine.unload();
        set({ queue: [], index: -1, current: null, currentTime: 0, duration: 0, resumeAt: null, stopAfterCurrent: false, shuffleHistory: [], activePodcastEpisode: null });
        schedulePersistPlaybackSession(get(), true);
        return;
      }
      // The current track's place among the survivors, or the survivor
      // right after it when it went too.
      const before = state.queue.slice(0, Math.max(0, state.index)).filter((track) => !gone.has(track.id)).length;
      const index = Math.min(queue.length - 1, before);
      const shuffling = isShuffleMode(state.mode);
      const goneAt: number[] = [];
      state.queue.forEach((track, at) => {
        if (gone.has(track.id)) goneAt.push(at);
      });
      const survivingHistory = shuffling
        ? remapShuffleHistory(state.shuffleHistory, removalIndexMap(state.queue.length, goneAt))
        : [];
      if (!currentGone) {
        set({ queue, index, shuffleHistory: survivingHistory });
        schedulePersistPlaybackSession(get(), true);
        return;
      }
      const nextCurrent = queue[index] ?? null;
      const shuffleHistory = shuffling ? historyEndingAt(survivingHistory, index) : [];
      // The playing track is the last one and nothing follows it: stop there
      // instead of restarting the track before it from 0:00. Repeat-all
      // carries on from the top.
      const nothingFollows = !shuffling && before >= queue.length;
      const wraps = repeatModeOf(state.mode) === 'all';
      // The removed track did not stop early, it stopped existing, so no skip is recorded for it.
      const shufflePick = shuffling && state.isPlaying ? shuffleAfterRemoval(state.mode, queue.length, survivingHistory) : null;
      if (shufflePick) {
        await startQueuePlayback(get, set, queue, shufflePick.index, 0, { skipRecord: true, shuffleHistory: shufflePick.history });
        return;
      }
      if (!shuffling && state.isPlaying && nextCurrent && (!nothingFollows || wraps)) {
        await startQueuePlayback(get, set, queue, nothingFollows ? 0 : index, 0, { skipRecord: true, shuffleHistory });
        return;
      }
      engine.unload();
      set({
        queue,
        index,
        current: nextCurrent,
        currentTime: 0,
        duration: nextCurrent?.duration ?? 0,
        resumeAt: null,
        isPlaying: false,
        activePodcastEpisode: null,
        shuffleHistory,
      });
      applyReplayGain(nextCurrent, get().settings);
      schedulePersistPlaybackSession(get(), true);
    },

    refreshTracks: (updated) => {
      if (!updated.length) return;
      const byId = new Map(updated.map((track) => [track.id, track]));
      set((state) => {
        const fresh = state.current ? byId.get(state.current.id) : undefined;
        const queued = state.queue.some((track) => byId.has(track.id));
        if (!fresh && !queued) return state;
        return {
          current: fresh && state.current ? { ...state.current, ...fresh } : state.current,
          queue: queued
            ? state.queue.map((track) => {
                const next = byId.get(track.id);
                return next ? { ...track, ...next } : track;
              })
            : state.queue,
        };
      });
    },

    clearQueue: () => {
      queueRevision++;
      const previous = get();
      const emptyQueue: Track[] = [];
      clearPlaybackErrorAdvanceTimer();
      if (!abandonPreview()) recordManualSkip(get());
      resetHandoffState();
      lastStopAfterCurrentKey = null;
      lastPlaybackErrorKey = null;
      consecutivePlaybackFailures = 0;
      playIntents.begin();
      engine.unload();
      set({
        isPlaying: false,
        queue: emptyQueue,
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
      if (previous.queue.length) {
        pushToast({
          title: 'Queue cleared',
          detail: `${previous.queue.length.toLocaleString()} tracks removed. Undo restores your place, paused.`,
          durationMs: 10000,
          action: {
            label: 'Undo clear',
            onClick: () => {
              // A queue edit or new play takes precedence over this old undo.
              if (get().queue !== emptyQueue || get().current) {
                pushToast({ title: 'Queue has changed', detail: 'The cleared queue was not restored.' });
                return;
              }
              const position = previous.current ? previous.resumeAt ?? previous.currentTime : 0;
              queueRevision++;
              set({
                queue: previous.queue,
                index: previous.index,
                current: previous.current,
                currentTime: position,
                duration: previous.duration,
                resumeAt: previous.current ? position : null,
                isPlaying: false,
                // Shuffle and repeat stay as the listener has them now; only a
                // history from a shuffled queue is worth carrying back.
                shuffleHistory: !isShuffleMode(get().mode)
                  ? []
                  : isShuffleMode(previous.mode)
                    ? previous.shuffleHistory
                    : resetSmartShuffleHistory(previous.queue.length, previous.index),
                activePodcastEpisode: previous.activePodcastEpisode,
              });
              applyReplayGain(previous.current, get().settings);
              schedulePersistPlaybackSession(get(), true);
              notifyShellPlayback(get());
            },
          },
        });
      }
    },

    togglePlay: () => {
      const state = get();
      if (!engine.getState().src) {
        const startIndex = resolvePlaybackStartIndex(state.queue.length || (state.current ? 1 : 0), state.index);
        if (startIndex < 0) {
          // Nothing loaded: with a library to draw from, Play starts something
          // instead of doing nothing.
          const libraryRootCount = state.settings?.libraryRoots?.length ?? 0;
          if (starterQueueNeeded({ startIndex, libraryRootCount, pending: starterQueuePending })) {
            void playStarterQueue(get);
          }
          return;
        }
        const resumeAt = state.resumeAt;
        const playbackQueue = state.queue.length ? state.queue : state.current ? [state.current] : [];
        // Carry the saved position in the play request itself. A late
        // completion must never seek a newer track after Stop/queue changes.
        void state.playQueue(playbackQueue, startIndex, resumeAt ?? 0);
        return;
      }
      engine.togglePlayPause();
    },

    next: async () => {
      if (activePreview) return;
      clearPlaybackErrorAdvanceTimer();
      const intent = playIntents.begin();
      const revision = queueRevision;
      const isCurrent = () => playIntents.isCurrent(intent) && queueRevision === revision;
      const state = get();
      recordManualSkip(state);
      // A direct call to next() — user skip, keyboard/media shortcut, or
      // autoAdvance()'s own fallback when no cached pick applies — always
      // computes its own fresh pick rather than trusting a background
      // prepare; see shared/shuffle-handoff.ts for why a stale one cannot
      // just be reused.
      cachedShuffleHandoff = null;
      const { queue, index, mode, shuffleHistory } = state;
      if (!queue.length) return;
      consecutivePlaybackFailures = 0;
      const advance = resolveQueueAdvance({ queue, index, mode, history: shuffleHistory });
      let nextIdx = advance.index;
      let nextShuffleHistory = advance.history;
      if (advance.atEnd) {
        // The end of the queue, or of a shuffle cycle with repeat off.
        const additions = await get().refillAutoDjQueue(true);
        if (!isCurrent()) return;
        let resumed: QueueAdvance | null = null;
        if (additions.length) {
          const grown = get();
          resumed = resolveQueueAdvance({ queue: grown.queue, index: grown.index, mode: grown.mode, history: grown.shuffleHistory });
        } else {
          const expanded = await expandQueueFromCurrentContext(state);
          if (!isCurrent()) return;
          if (expanded) {
            const contextShuffleHistory = isShuffleMode(mode)
              ? resetSmartShuffleHistory(expanded.queue.length, expanded.index)
              : [];
            resumed = resolveQueueAdvance({ queue: expanded.queue, index: expanded.index, mode, history: contextShuffleHistory });
            if (!resumed.atEnd) {
              set({ queue: expanded.queue, index: expanded.index, shuffleHistory: contextShuffleHistory });
            }
          }
        }
        if (!resumed || resumed.atEnd) {
          engine.pause();
          set({ isPlaying: false });
          schedulePersistPlaybackSession(get(), true);
          return;
        }
        nextIdx = resumed.index;
        nextShuffleHistory = resumed.history;
      }
      if (!isCurrent()) return;
      await commitPlaybackAdvance(get, set, nextIdx, nextShuffleHistory);
    },

    prev: async () => {
      if (activePreview) return;
      clearPlaybackErrorAdvanceTimer();
      const { queue, index, currentTime, mode, shuffleHistory } = get();
      if (!queue.length) return;
      // if more than 3 seconds into the track, restart it
      if (currentTime > 3) {
        get().seek(0);
        return;
      }
      const shuffleDecision = isShuffleMode(mode)
        ? previousSmartShuffle({ queueLength: queue.length, currentIndex: index, history: shuffleHistory })
        : null;
      // Repeat-all wraps backwards from the first track like Next wraps forwards.
      const prevIdx = shuffleDecision
        ? shuffleDecision.index
        : index === 0 && repeatModeOf(mode) === 'all'
          ? queue.length - 1
          : Math.max(0, index - 1);
      const t = queue[prevIdx]!;
      resetHandoffState();
      consecutivePlaybackFailures = 0;
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
      if (!(await playEngineTrack(t))) return;
      lastPlaybackErrorKey = null;
      startLastfmNowPlaying(t);
      // Landing on another track counts as a play the same way Next does.
      if (prevIdx !== index) recordLibraryPlay(t);
    },

    seek: (t) => {
      if (!Number.isFinite(t)) return;
      const state = get();
      const current = state.current;
      const duration = cueDuration(current, state.duration);
      const target = Math.max(0, duration > 0 ? Math.min(duration, t) : t);
      engine.seek(cueStart(current) + target);
      if (!current) return;
      set({ currentTime: target, ...(!engine.getState().src ? { resumeAt: target } : {}) });
      if (!state.isPlaying) schedulePersistPlaybackSession(get(), true);
    },

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

    setBitPerfectExclusive: async (enabled) => {
      let settings = await api.setSettings({ bitPerfectExclusive: enabled });
      set({ settings });
      const bridge = await loadExclusiveBridge();
      const active = await bridge.setEnabled(engine, settings.bitPerfectExclusive);
      if (settings.bitPerfectExclusive && !active) {
        // Addon unavailable (non-Windows, missing binary) — revert honestly
        // instead of showing a toggle that does nothing.
        settings = await api.setSettings({ bitPerfectExclusive: false });
        set({ settings });
        return settings;
      }
      await restartCurrentTrackThroughActivePath(get);
      return settings;
    },

    setSampleAccurateGapless: async (enabled) => {
      const settings = await api.setSettings({ sampleAccurateGapless: enabled });
      set({ settings });
      if (settings.sampleAccurateGapless) {
        const transport = await loadSampleTransport();
        // Takes over from the next track change; the playing one carries on.
        if (get().settings?.sampleAccurateGapless) engine.setSampleTransport(transport);
      } else {
        const wasActive = engine.isSampleTransportActive();
        engine.setSampleTransport(null);
        if (wasActive) await restartCurrentTrackThroughActivePath(get);
      }
      return settings;
    },

    setBitPerfectExclusiveDevice: async (deviceId) => {
      const settings = await api.setSettings({ bitPerfectExclusiveDeviceId: deviceId });
      set({ settings });
      if (settings.bitPerfectExclusive) await restartCurrentTrackThroughActivePath(get);
      return settings;
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
      const revision = queueRevision;
      const isCurrent = () => queueRevision === revision && get().autoDjSmartRuleId === state.autoDjSmartRuleId;
      if (!state.autoDjEnabled || (!state.queue.length && !state.autoDjSmartRuleId)) return [];
      if (
        !force &&
        !shouldAutoDjRefill({
          enabled: state.autoDjEnabled,
          queueLength: state.queue.length,
          index: autoDjRefillIndex(state),
        })
      ) {
        return [];
      }
      // A folder rule ignores `count` (it is the whole folder), so it is
      // bounded with a random sample instead. Deep into a folder that has
      // mostly been played, a sample can come back entirely made of tracks
      // already in the queue, so a starved refill asks again for all of it.
      let sampledFolderRule = false;
      const runRule = async (sample: boolean): Promise<Track[]> => {
        const rules = await api.getSmartPlaylistRules().catch(() => []);
        const rule = rules.find((item) => item.id === state.autoDjSmartRuleId) ?? null;
        if (!rule) return api.runSmartPlaylistRule(state.autoDjSmartRuleId!).catch(() => []);
        const candidateCount = autoDjSmartRuleCandidateCount(
          rule.count,
          state.autoDjTarget,
          state.queue.length,
        );
        sampledFolderRule = sample && !!rule.folderPath;
        return api
          .runSmartPlaylistRule({ ...rule, count: candidateCount }, sample ? candidateCount : 0)
          .catch(() => []);
      };
      const candidates = state.autoDjSmartRuleId
        ? await runRule(true)
        : await (() => {
            const seed = state.current ?? state.queue[Math.max(0, state.index)] ?? state.queue[state.queue.length - 1]!;
            return api
              .buildHarmonicMix({
                seedTrackId: seed?.id ?? null,
                count: state.autoDjTarget + state.queue.length,
              })
              .catch(() => []);
          })();
      // Re-read state after the await instead of reusing the pre-await
      // snapshot: the candidate IPC can take a while, and a Clear Queue (or
      // any other queue edit) that lands during that window must not be
      // silently undone by committing onto the stale queue captured above.
      const fresh = get();
      if (!fresh.autoDjEnabled || !isCurrent()) return [];
      const remainingAhead = remainingAheadOf(fresh);
      let additions = selectAutoDjAdditions(fresh.queue, candidates, fresh.autoDjTarget, remainingAhead);
      if (!additions.length && sampledFolderRule) {
        const everything = await runRule(false);
        if (!get().autoDjEnabled || !isCurrent()) return [];
        const latest = get();
        additions = selectAutoDjAdditions(
          latest.queue,
          everything,
          latest.autoDjTarget,
          remainingAheadOf(latest),
        );
      }
      if (!additions.length) return [];
      // Same reason as above, and the retry above is a second window: commit
      // onto the queue as it stands now, not the one the additions were
      // chosen against.
      const atCommit = get();
      if (!atCommit.autoDjEnabled || !isCurrent()) return [];
      set({ queue: [...atCommit.queue, ...additions] });
      schedulePersistPlaybackSession(get(), true);
      return additions;
    },

    setMode: (m) => {
      queueRevision++;
      const state = get();
      set({
        mode: m,
        // Changing repeat while shuffle stays on keeps what has already played
        // (as a new array, which drops any handoff pick cached against the old one).
        shuffleHistory: !isShuffleMode(m)
          ? []
          : isShuffleMode(state.mode)
            ? [...state.shuffleHistory]
            : resetSmartShuffleHistory(state.queue.length, state.index),
      });
      writeStored(PLAYBACK_MODE_STORAGE_KEY, m);
      schedulePersistPlaybackSession(get(), true);
    },

    // Shuffle and repeat are rendered as two independent buttons (Transport
    // and every deck skin), so toggling one must never clobber the other —
    // combinePlaybackMode/isShuffleMode/repeatModeOf keep them orthogonal
    // while still funneling through the single persisted PlaybackMode.
    toggleShuffle: () => {
      const state = get();
      get().setMode(combinePlaybackMode(!isShuffleMode(state.mode), repeatModeOf(state.mode)));
    },

    cycleRepeat: () => {
      const state = get();
      const repeat = repeatModeOf(state.mode);
      const nextRepeat = repeat === 'all' ? 'one' : repeat === 'one' ? 'off' : 'all';
      get().setMode(combinePlaybackMode(isShuffleMode(state.mode), nextRepeat));
    },

    setEqBand: async (i, dB) => {
      const cur = get().settings;
      if (!cur) return;
      const next = [...cur.equalizer];
      next[i] = dB;
      const normalized = normalizeEqValues(next);
      const revision = ++eqRevision;
      set({ settings: { ...cur, equalizer: normalized } });
      engine.setEqBand(i, normalized[i] ?? 0);
      const settings = await api.setSettings({ equalizer: normalized });
      if (revision === eqRevision) set({ settings: { ...get().settings!, equalizer: settings.equalizer } });
    },

    setEqPreset: async (values) => {
      const next = normalizeEqValues(values);
      const revision = ++eqRevision;
      if (get().settings) set({ settings: { ...get().settings!, equalizer: next, eqEnabled: true } });
      engine.setEqBands(next);
      engine.setEqEnabled(true); // a preset picked while the EQ is off turns it on
      const settings = await api.setSettings({ equalizer: next, eqEnabled: true });
      if (revision === eqRevision) set({ settings: { ...get().settings!, equalizer: settings.equalizer, eqEnabled: settings.eqEnabled } });
    },

    setEqEnabled: async (on) => {
      const cur = get().settings;
      if (!cur) return;
      const revision = ++eqRevision;
      set({ settings: { ...cur, eqEnabled: on } });
      // The engine ignores band values while it is disabled, so the flag has
      // to flip in the engine too, not just in settings — "on" used to only
      // push the bands, which left the EQ dead after the first off.
      engine.setEqBands(cur.equalizer);
      engine.setEqEnabled(on);
      const settings = await api.setSettings({ eqEnabled: on });
      if (revision === eqRevision) set({ settings: { ...get().settings!, eqEnabled: settings.eqEnabled } });
    },

    toggleLove: async (id) => {
      const loved = await api.toggleLove(id);
      const nextLoved: 0 | 1 = loved ? 1 : 0;
      set((state) => ({
        current: state.current?.id === id ? { ...state.current, loved: nextLoved } : state.current,
        queue: state.queue.map((track) => (track.id === id ? { ...track, loved: nextLoved } : track)),
      }));
      // Eviland memory bridge: love-tick forces a generation evolution when
      // the lineage is < gen 3. Only fire on
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

    cycleTheme: async () => {
      // Shift+S skin surf: advance to the next built-in skin in THEME_REGISTRY
      // order. When a custom skin (or an unknown id) is active there is no
      // "next", so surfing restarts from the first registry entry — always a
      // deterministic landing spot. Toast the landed skin so surfing with the
      // eyes on the visualizer still tells you where you are.
      const active = get().settings?.theme;
      const index = THEME_REGISTRY.findIndex((entry) => entry.id === active);
      const next = THEME_REGISTRY[index < 0 ? 0 : (index + 1) % THEME_REGISTRY.length]!;
      await get().setTheme(next.id);
      pushToast({ title: `Skin — ${next.label}` });
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
      // The sample transport spliced the next track in with the old mode's
      // gain; hand it the new one before its first frame plays.
      const state = get();
      if (
        engine.isSampleTransportActive() &&
        state.current &&
        lastPreparedHandoffKey === handoffKey(state.current.id, state.index)
      ) {
        const next = desiredHandoffTrack(state);
        if (next && next.id === lastPreparedNextTrackId) prepareEngineTrack(next, settings);
      }
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

// The last content view comes back at launch. It is applied here, before
// anything renders, so Home is never mounted just to be replaced.
launchView = parseStoredView(readStored(VIEW_STORAGE_KEY));
if (launchView) usePlayerStore.setState({ view: launchView });

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
        volume: () => number;
        analyserFftSum: () => number;
        engineCurrentTime: () => number;
        exclusiveInfo: () => ReturnType<AudioEngine['getExclusiveInfo']>;
        sampleTransportInfo: () => ReturnType<AudioEngine['getSampleTransportInfo']>;
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
      // The live slider position, read straight from the store so a wheel
      // smoke sees every change, not only the ones the UI has painted.
      volume: () => usePlayerStore.getState().volume,
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
      // Bit-Perfect Exclusive status: the exclusive-ui smoke asserts the
      // native path engaged and (via analyserFftSum) that the external tap
      // feeds visualizers while the Web Audio graph is silent.
      exclusiveInfo: () => usePlayerStore.getState().engine.getExclusiveInfo(),
      // Sample-accurate gapless status: which path the current track took.
      sampleTransportInfo: () => usePlayerStore.getState().engine.getSampleTransportInfo(),
    };
  }
}
