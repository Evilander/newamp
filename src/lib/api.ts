// Single chokepoint for IPC + global access. Components MUST import from here
// instead of touching window.newamp directly — that way a missing preload
// (browser preview, broken Electron build, etc) degrades gracefully instead
// of crashing with "Cannot read properties of undefined".

import type {
  AppSettings,
  GuitarTabLine,
  ListeningInsights,
  NewampAPI,
  SupportDiagnostics,
} from '@shared/types';
import { NEWAMP_VERSION } from '@shared/app-version';
import { normalizeAudioOutputDeviceId } from '@shared/audio-output';
import { normalizeLimiterEnabled, normalizePreampDb } from '@shared/audio-limiter';

export const DEFAULT_SETTINGS: AppSettings = {
  libraryRoots: [],
  libraryAutoWatch: true,
  theme: 'classic',
  customSkin: null,
  lastfmEnabled: false,
  lastfmApiKey: null,
  lastfmSharedSecret: null,
  lastfmSessionKey: null,
  lastfmUsername: null,
  lastfmAuthToken: null,
  crossfadeMs: 0,
  replayGain: 'off',
  limiterEnabled: true,
  preampDb: 0,
  resumeState: null,
  compactMode: false,
  visualizerPreset: 'spectrum',
  volume: 0.75,
  playbackRate: 1,
  audioOutputDeviceId: null,
  autoDjEnabled: false,
  autoDjTarget: 24,
  autoDjSmartRuleId: null,
  equalizer: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  eqEnabled: false,
};

const DEFAULT_DIAGNOSTICS: SupportDiagnostics = {
  appVersion: NEWAMP_VERSION,
  platform: 'browser',
  electronVersion: 'n/a',
  userDataPath: '',
  settingsPath: '',
  libraryPath: '',
  generatedAt: Date.now(),
  libraryStats: { tracks: 0, albums: 0, artists: 0, duration: 0 },
  lastfmOutbox: { pending: 0, oldestCreatedAt: null, lastError: null },
  recoveryEvents: [],
};

function emptyListeningInsights(now = Date.now()): ListeningInsights {
  return {
    generatedAt: now,
    total: {
      plays: 0,
      duration: 0,
      skips: 0,
      uniqueTracks: 0,
      uniqueSkippedTracks: 0,
      firstPlayedAt: null,
      lastPlayedAt: null,
      lastSkippedAt: null,
    },
    today: { plays: 0, duration: 0, skips: 0 },
    week: { plays: 0, duration: 0, skips: 0 },
    topArtists: [],
    topAlbums: [],
    recentDays: [],
  };
}

const stub: NewampAPI = {
  scanLibrary: async () => undefined,
  cancelScan: async () => undefined,
  onScanProgress: () => () => undefined,
  getTracks: async () => [],
  getAlbums: async () => [],
  lookupAlbumArt: async () => [],
  applyAlbumArt: async (input, candidate) => ({
    album: input.album,
    albumArtist: input.albumArtist,
    artFromTrackId: null,
    appliedTrackCount: 0,
    mime: 'image/jpeg',
    bytes: 0,
    sourceUrl: candidate.imageUrl,
    appliedAt: Date.now(),
  }),
  getArtists: async () => [],
  getFolders: async () => [],
  getFolderTracks: async () => [],
  getAlbumTracks: async () => [],
  getArtistTracks: async () => [],
  getTrack: async () => null,
  lookupTrackMetadata: async () => [],
  applyTrackMetadataPatch: async () => null,
  getPlaylists: async () => [],
  savePlaylist: async (input) => ({
    id: input.id ?? 0,
    name: input.name,
    trackCount: input.trackIds.length,
    duration: 0,
    hasCoverArt: input.coverImagePath && !input.clearCoverImage ? 1 : 0,
    coverArtUpdatedAt: input.coverImagePath && !input.clearCoverImage ? Date.now() : null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }),
  addTracksToPlaylist: async (input) => ({
    id: input.playlistId,
    name: 'Playlist',
    trackCount: input.trackIds.length,
    duration: 0,
    hasCoverArt: 0,
    coverArtUpdatedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }),
  deletePlaylist: async () => undefined,
  getPlaylistTracks: async () => [],
  getPlaylistCoverUrl: () => '',
  pickPlaylistCoverImage: async () => null,
  exportPlaylistM3u: async () => null,
  exportPlaylistPls: async () => null,
  importPlaylistM3u: async () => null,
  openFiles: async () => ({ tracks: [], importedPlaylists: [], skipped: [] }),
  consumePendingOpenFiles: async () => [],
  getDroppedFilePaths: (files) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      const path = (file as { path?: unknown })?.path;
      if (typeof path !== 'string' || !path) continue;
      const key = path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(path);
    }
    return out;
  },
  getSmartPlaylistRules: async () => [],
  getSuggestedSmartPlaylistRules: async () => [],
  saveSmartPlaylistRule: async (input) => ({
    id: input.id ?? 0,
    name: input.name,
    mood: input.mood,
    count: input.count,
    genreQuery: input.genreQuery ?? null,
    searchQuery: input.searchQuery ?? null,
    minYear: input.minYear ?? null,
    maxYear: input.maxYear ?? null,
    minBpm: input.minBpm ?? null,
    maxBpm: input.maxBpm ?? null,
    minRating: input.minRating ?? null,
    lovedOnly: !!input.lovedOnly,
    unplayedOnly: !!input.unplayedOnly,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }),
  deleteSmartPlaylistRule: async () => undefined,
  runSmartPlaylistRule: async () => [],
  buildHarmonicMix: async () => [],
  buildTasteMix: async () => [],
  lastfmStartAuth: async () => {
    throw new Error('Last.fm auth is only available in the Electron app.');
  },
  lastfmCompleteAuth: async () => {
    throw new Error('Last.fm auth is only available in the Electron app.');
  },
  lastfmDisconnect: async () => DEFAULT_SETTINGS,
  lastfmUpdateNowPlaying: async () => undefined,
  lastfmScrobble: async () => undefined,
  lastfmGetOutboxStatus: async () => ({ pending: 0, oldestCreatedAt: null, lastError: null }),
  lastfmFlushOutbox: async () => ({ pending: 0, oldestCreatedAt: null, lastError: null }),
  getLocalLyrics: async () => null,
  saveCustomLyrics: async (input) => {
    const plainLyrics = input.plainLyrics?.trim() || null;
    const syncedLyrics = input.syncedLyrics?.trim() || null;
    if (!plainLyrics && !syncedLyrics) return null;
    return {
      source: 'custom',
      path: `browser:lyrics:custom:${input.trackId}`,
      plainLyrics,
      syncedLyrics,
      updatedAt: Date.now(),
    };
  },
  clearCustomLyrics: async () => undefined,
  listPodcastSubscriptions: async () => [],
  subscribePodcastFeed: async () => {
    throw new Error('Podcast subscriptions are only available in the Electron app.');
  },
  refreshPodcastFeed: async () => {
    throw new Error('Podcast refresh is only available in the Electron app.');
  },
  removePodcastFeed: async () => undefined,
  updatePodcastEpisodeProgress: async () => null,
  downloadPodcastEpisode: async () => null,
  removePodcastEpisodeDownload: async () => null,
  getStats: async () => ({ tracks: 0, albums: 0, artists: 0, duration: 0 }),
  getLibraryHealth: async () => ({
    totals: { tracks: 0, albums: 0, artists: 0, duration: 0 },
    missing: { artist: 0, album: 0, year: 0, art: 0, duration: 0 },
    duplicateGroups: [],
    legacyFormats: [],
    recentlyAdded: [],
    generatedAt: Date.now(),
  }),
  pruneMissingTracks: async () => ({ checked: 0, removed: 0 }),
  getListeningHistory: async () => [],
  getListeningInsights: async (opts) => emptyListeningInsights(opts?.now),
  clearListeningHistory: async () => undefined,
  getTrackBookmarks: async () => [],
  saveTrackBookmark: async (input) => ({
    id: input.id ?? 0,
    trackId: input.trackId,
    position: input.position,
    label: input.label ?? 'Bookmark',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }),
  deleteTrackBookmark: async () => undefined,
  toggleLove: async () => false,
  setTrackRating: async () => null,
  recordPlay: async () => undefined,
  recordSkip: async () => undefined,
  getArtUrl: () => '',
  pickFolder: async () => null,
  getSettings: async () => DEFAULT_SETTINGS,
  setSettings: async (patch) => ({
    ...DEFAULT_SETTINGS,
    ...patch,
    audioOutputDeviceId: normalizeAudioOutputDeviceId(patch.audioOutputDeviceId),
    limiterEnabled: patch.limiterEnabled === undefined
      ? DEFAULT_SETTINGS.limiterEnabled
      : normalizeLimiterEnabled(patch.limiterEnabled),
    preampDb: patch.preampDb === undefined
      ? DEFAULT_SETTINGS.preampDb
      : normalizePreampDb(patch.preampDb),
  }),
  exportCustomSkin: async () => null,
  importCustomSkin: async () => null,
  importCustomSkinFile: async () => null,
  getSupportDiagnostics: async () => ({ ...DEFAULT_DIAGNOSTICS, generatedAt: Date.now() }),
  createSupportBackup: async () => ({
    backupPath: '',
    createdAt: Date.now(),
    filesCopied: 0,
    included: [],
  }),
  restoreSupportBackup: async () => null,
  showInFolder: async () => undefined,
  onPlayerCommand: () => () => undefined,
  onOpenFiles: () => () => undefined,
  searchGuitarTabs: async () => [],
  getGuitarTab: async () => {
    throw new Error('Guitar tabs are only available in the Electron app.');
  },
  getCachedGuitarTabs: async () => [],
  saveCachedGuitarTab: async (trackId, document) => ({
    id: 0,
    trackId,
    url: document.url,
    title: document.title,
    artist: document.artist,
    kind: document.kind,
    document,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }),
  saveLocalGuitarTab: async (trackId, input) => {
    const now = Date.now();
    const document = {
      source: 'local' as const,
      url: `newamp-local-tab://browser-${now}`,
      title: input.title || 'Pasted Tab',
      artist: input.artist || 'Unknown Artist',
      kind: input.kind || 'Pasted Tab',
      author: 'Newamp local',
      rating: null,
      votes: null,
      key: input.key ?? null,
      lines: input.content.split(/\r?\n/).map((text): GuitarTabLine => ({ type: text.trim() ? 'lyrics' : 'blank', text })),
      fetchedAt: now,
    };
    return {
      id: 0,
      trackId,
      url: document.url,
      title: document.title,
      artist: document.artist,
      kind: document.kind,
      document,
      createdAt: now,
      updatedAt: now,
    };
  },
  findLocalGuitarTab: async () => null,
  openGuitarTabWindow: async () => undefined,
  platform: 'browser',
  appVersion: NEWAMP_VERSION,
};

export const inElectron = typeof window !== 'undefined' && !!window.newamp;

export const api: NewampAPI =
  typeof window !== 'undefined' && window.newamp ? window.newamp : stub;

// Dev-only: expose for in-browser mocking & QA.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __api?: unknown }).__api = api;
}

export const winctl = {
  minimize: () => window.winctl?.minimize() ?? Promise.resolve(),
  toggleMax: () => window.winctl?.toggleMax() ?? Promise.resolve(),
  setCompact: (on: boolean) => window.winctl?.setCompact(on) ?? Promise.resolve(),
  close: () => window.winctl?.close() ?? Promise.resolve(),
  onState: (cb: (s: { maximized: boolean }) => void) =>
    window.winctl?.onState(cb) ?? (() => undefined),
};

export function toAudioUrl(filePath: string): string {
  if (/^(https?:|blob:|newamp:)/i.test(filePath)) return filePath;
  if (typeof window !== 'undefined' && window.toAudioUrl) {
    return window.toAudioUrl(filePath);
  }
  return filePath;
}
