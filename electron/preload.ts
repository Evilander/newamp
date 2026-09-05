import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { NEWAMP_VERSION } from '../shared/app-version.js';
import type {
  AddTracksToPlaylistInput,
  AiLinerNotesInput,
  AiLinerNotesResult,
  AlbumArtApplyResult,
  AlbumArtLookupInput,
  AlbumArtLookupResult,
  AlbumRating,
  AppSettings,
  AudioExportFormat,
  CachedGuitarTab,
  CustomLyricsInput,
  CustomSkin,
  DiscoverSurface,
  DiscoverSurfaceInput,
  ExclusiveDeviceInfo,
  ExclusiveEventPayload,
  ExclusivePlayResult,
  ExportTracksFolderInput,
  GuitarTabDocument,
  GuitarTabSearchQuery,
  GuitarTabSearchResult,
  HarmonicMixInput,
  LastfmAuthStart,
  LastfmOutboxStatus,
  LastfmSession,
  LastfmTrackPayload,
  LibraryHealth,
  LibraryPruneMissingResult,
  LocalGuitarTabInput,
  LocalLyricsResult,
  ListeningHistoryItem,
  ListeningInsights,
  WrappedStats,
  Review,
  ReviewInput,
  ListSummary,
  ListDetail,
  ListItem,
  ListInput,
  ListItemInput,
  UserProfile,
  MetadataLookupCandidate,
  NewAmpAPI,
  PlaylistFolderExportResult,
  PlaylistM3uImportResult,
  PodcastEpisode,
  PodcastProgressInput,
  PodcastSubscription,
  PlayerCommand,
  DnaStats,
  RadioBrainStatus,
  ReplayGainAnalysisResult,
  SavedPlaylist,
  SimilarTrack,
  TagRecomputeOptions,
  TagRecomputeResult,
  TagRule,
  TagRuleInput,
  TagRulePreviewInput,
  TagRulePreviewResult,
  TagSummary,
  TracksDnaAnalysisResult,
  SavePlaylistInput,
  SaveTrackBookmarkInput,
  ScanProgress,
  SmartPlaylistRule,
  SmartPlaylistRuleInput,
  SmartPlaylistSuggestion,
  TasteMixInput,
  SupportDiagnostics,
  SupportBackupResult,
  SupportRestoreResult,
  TrackBookmark,
  Track,
  TrackAudioBatchExportResult,
  TrackMetadataPatchInput,
  TrackWavBatchExportResult,
  TrackWavExportResult,
} from '../shared/types.js';
import type { TrackDna } from '../shared/audio-dna.js';
import type { VisualMemoryPlan, VisualMemoryStats } from '../shared/visual-memory.js';

const api: NewAmpAPI = {
  getMusicServers: () => ipcRenderer.invoke('music-servers:list'),
  connectMusicServer: (input) => ipcRenderer.invoke('music-servers:connect', input),
  disconnectMusicServer: (id) => ipcRenderer.invoke('music-servers:disconnect', id),
  getMusicServerTracks: (id, options) => ipcRenderer.invoke('music-servers:tracks', id, options),
  importHistoryFile: () => ipcRenderer.invoke('history:import-file'),
  importLastfmHistory: (username) => ipcRenderer.invoke('history:import-lastfm', username),
  cancelHistoryImport: () => ipcRenderer.invoke('history:cancel-import'),
  onHistoryImportProgress: (cb) => {
    const handler = (_e: unknown, progress: Parameters<typeof cb>[0]) => cb(progress);
    ipcRenderer.on('history:import-progress', handler);
    return () => ipcRenderer.removeListener('history:import-progress', handler);
  },
  scanLibrary: (roots) => ipcRenderer.invoke('library:scan', roots),
  cancelScan: () => ipcRenderer.invoke('library:cancel-scan'),
  onScanProgress: (cb) => {
    const handler = (_e: unknown, p: ScanProgress) => cb(p);
    ipcRenderer.on('library:scan-progress', handler);
    return () => ipcRenderer.off('library:scan-progress', handler);
  },
  getTracks: (opts) => ipcRenderer.invoke('library:get-tracks', opts) as Promise<Track[]>,
  getTrackIds: (opts) => ipcRenderer.invoke('library:get-track-ids', opts) as Promise<number[]>,
  getTrackCount: (opts) => ipcRenderer.invoke('library:get-track-count', opts) as Promise<number>,
  getAlbums: (opts) => ipcRenderer.invoke('library:get-albums', opts),
  lookupAlbumArt: (input: AlbumArtLookupInput) =>
    ipcRenderer.invoke('album-art:lookup', input) as Promise<AlbumArtLookupResult[]>,
  applyAlbumArt: (input: AlbumArtLookupInput, candidate: AlbumArtLookupResult) =>
    ipcRenderer.invoke('album-art:apply', input, candidate) as Promise<AlbumArtApplyResult | null>,
  getArtists: (opts) => ipcRenderer.invoke('library:get-artists', opts),
  getFolders: (parentPath) => ipcRenderer.invoke('library:get-folders', parentPath),
  getFolderTracks: (folderPath, opts) =>
    ipcRenderer.invoke('library:get-folder-tracks', folderPath, opts),
  getFolderTrackIds: (folderPath, opts) =>
    ipcRenderer.invoke('library:get-folder-track-ids', folderPath, opts) as Promise<number[]>,
  getAlbumTracks: (albumArtist, album) =>
    ipcRenderer.invoke('library:get-album-tracks', albumArtist, album),
  getArtistTracks: (artist) => ipcRenderer.invoke('library:get-artist-tracks', artist),
  getTrack: (id) => ipcRenderer.invoke('library:get-track', id),
  getTracksByIds: (ids) => ipcRenderer.invoke('library:get-tracks-by-ids', ids) as Promise<Track[]>,
  lookupTrackMetadata: (id: number) =>
    ipcRenderer.invoke('metadata:lookup', id) as Promise<MetadataLookupCandidate[]>,
  applyTrackMetadataPatch: (id: number, candidate: MetadataLookupCandidate) =>
    ipcRenderer.invoke('metadata:apply', id, candidate) as Promise<Track | null>,
  applyTrackMetadataEdit: (id: number, patch: TrackMetadataPatchInput) =>
    ipcRenderer.invoke('metadata:edit', id, patch) as Promise<Track | null>,
  getPlaylists: () => ipcRenderer.invoke('playlist:list') as Promise<SavedPlaylist[]>,
  savePlaylist: (input: SavePlaylistInput) =>
    ipcRenderer.invoke('playlist:save', input) as Promise<SavedPlaylist>,
  addTracksToPlaylist: (input: AddTracksToPlaylistInput) =>
    ipcRenderer.invoke('playlist:add-tracks', input) as Promise<SavedPlaylist | null>,
  deletePlaylist: (id: number) => ipcRenderer.invoke('playlist:delete', id) as Promise<void>,
  getPlaylistTracks: (id: number) =>
    ipcRenderer.invoke('playlist:get-tracks', id) as Promise<Track[]>,
  getPlaylistCoverUrl: (id: number, updatedAt?: number | null) =>
    `newplaylistart://playlist/${id}/cover${updatedAt ? `?v=${updatedAt}` : ''}`,
  pickPlaylistCoverImage: () =>
    ipcRenderer.invoke('playlist:pick-cover') as Promise<string | null>,
  exportPlaylistM3u: (id: number) =>
    ipcRenderer.invoke('playlist:export-m3u', id) as Promise<string | null>,
  exportPlaylistPls: (id: number) =>
    ipcRenderer.invoke('playlist:export-pls', id) as Promise<string | null>,
  exportPlaylistFolder: (id: number) =>
    ipcRenderer.invoke('playlist:export-folder', id) as Promise<PlaylistFolderExportResult | null>,
  exportTracksFolder: (input: ExportTracksFolderInput) =>
    ipcRenderer.invoke('playlist:export-tracks-folder', input) as Promise<PlaylistFolderExportResult | null>,
  importPlaylistM3u: () =>
    ipcRenderer.invoke('playlist:import-m3u') as Promise<PlaylistM3uImportResult | null>,
  exportLibraryMetadata: (format: 'json' | 'csv') =>
    ipcRenderer.invoke('library:export-metadata', format) as Promise<
      { path: string; tracks: number; format: 'json' | 'csv' } | null
    >,
  captureVisualizerPng: (rect?: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('media:capture-page', rect) as Promise<string | null>,
  captureDeckSnapshotPng: () =>
    ipcRenderer.invoke('deck:snapshot') as Promise<string | null>,
  copyPngToClipboard: (dataUrl: string) =>
    ipcRenderer.invoke('media:copy-png', dataUrl) as Promise<boolean>,
  saveCaptureBytes: (payload: { base64: string; defaultName: string; filterName: string; ext: string }) =>
    ipcRenderer.invoke('media:save-capture', payload) as Promise<string | null>,
  saveClipMp4: (payload: { base64: string; defaultName: string; vertical?: boolean; maxHeight?: number }) =>
    ipcRenderer.invoke('video:save-clip', payload) as Promise<string | null>,
  exportTrackWav: (id: number) =>
    ipcRenderer.invoke('track:export-wav', id) as Promise<TrackWavExportResult | null>,
  exportTracksWav: (ids: number[]) =>
    ipcRenderer.invoke('tracks:export-wav-folder', ids) as Promise<TrackWavBatchExportResult | null>,
  exportTracksAudio: (ids: number[], format: AudioExportFormat) =>
    ipcRenderer.invoke('tracks:export-audio-folder', ids, format) as Promise<TrackAudioBatchExportResult | null>,
  analyzeReplayGain: (ids: number[]) =>
    ipcRenderer.invoke('tracks:analyze-replaygain', ids) as Promise<ReplayGainAnalysisResult>,
  analyzeAlbumReplayGain: (ids: number[]) =>
    ipcRenderer.invoke('tracks:analyze-album-replaygain', ids) as Promise<ReplayGainAnalysisResult>,
  analyzeTracksDna: (ids: number[]) =>
    ipcRenderer.invoke('tracks:analyze-dna', ids) as Promise<TracksDnaAnalysisResult>,
  getTrackDna: (id: number) =>
    ipcRenderer.invoke('tracks:dna-get', id) as Promise<TrackDna | null>,
  getTrackIdsMissingDna: (limit?: number) =>
    ipcRenderer.invoke('tracks:dna-missing-ids', limit) as Promise<number[]>,
  getDnaStats: () =>
    ipcRenderer.invoke('tracks:dna-stats') as Promise<DnaStats>,
  getAllTrackDna: () =>
    ipcRenderer.invoke('tracks:dna-all') as Promise<Array<{ id: number; dna: TrackDna }>>,
  findSimilarTracks: (trackId: number, limit?: number) =>
    ipcRenderer.invoke('tracks:dna-similar', trackId, limit) as Promise<SimilarTrack[]>,
  getTrackVisualMemory: (id: number) =>
    ipcRenderer.invoke('tracks:visual-memory-get', id) as Promise<VisualMemoryPlan | null>,
  setTrackVisualMemory: (id: number, plan: VisualMemoryPlan) =>
    ipcRenderer.invoke('tracks:visual-memory-set', id, plan) as Promise<boolean>,
  clearTrackVisualMemory: (id: number) =>
    ipcRenderer.invoke('tracks:visual-memory-clear', id) as Promise<boolean>,
  getVisualMemoryStats: () =>
    ipcRenderer.invoke('tracks:visual-memory-stats') as Promise<VisualMemoryStats>,
  clearAllVisualMemory: () =>
    ipcRenderer.invoke('tracks:visual-memory-clear-all') as Promise<number>,
  getRadioBrainStatus: () => ipcRenderer.invoke('radio-brain:status') as Promise<RadioBrainStatus>,
  openFiles: (paths: string[]) => ipcRenderer.invoke('open:files', paths),
  consumePendingOpenFiles: () => ipcRenderer.invoke('open:consume-pending-files') as Promise<string[]>,
  getDroppedFilePaths: (files: unknown[]) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      try {
        const path = webUtils.getPathForFile(file as File);
        const key = path.toLowerCase();
        if (path && !seen.has(key)) {
          seen.add(key);
          out.push(path);
        }
      } catch {
        /* ignore non-file drag payloads */
      }
    }
    return out;
  },
  getSmartPlaylistRules: () =>
    ipcRenderer.invoke('smart:list') as Promise<SmartPlaylistRule[]>,
  getSuggestedSmartPlaylistRules: () =>
    ipcRenderer.invoke('smart:suggestions') as Promise<SmartPlaylistSuggestion[]>,
  getDiscoverSurface: (input?: DiscoverSurfaceInput) =>
    ipcRenderer.invoke('library:get-discover-surface', input) as Promise<DiscoverSurface>,
  saveSmartPlaylistRule: (input: SmartPlaylistRuleInput) =>
    ipcRenderer.invoke('smart:save', input) as Promise<SmartPlaylistRule>,
  deleteSmartPlaylistRule: (id: number) => ipcRenderer.invoke('smart:delete', id) as Promise<void>,
  runSmartPlaylistRule: (input: number | SmartPlaylistRuleInput) =>
    ipcRenderer.invoke('smart:run', input) as Promise<Track[]>,
  listTagRules: () => ipcRenderer.invoke('tags:list-rules') as Promise<TagRule[]>,
  saveTagRule: (input: TagRuleInput) => ipcRenderer.invoke('tags:save-rule', input) as Promise<TagRule>,
  deleteTagRule: (id: number) => ipcRenderer.invoke('tags:delete-rule', id) as Promise<void>,
  setTagRuleEnabled: (id: number, enabled: boolean) =>
    ipcRenderer.invoke('tags:set-rule-enabled', id, enabled) as Promise<TagRule | null>,
  recomputeTags: (opts?: TagRecomputeOptions) =>
    ipcRenderer.invoke('tags:recompute', opts) as Promise<TagRecomputeResult>,
  getTagsForTrack: (id: number) => ipcRenderer.invoke('tags:for-track', id) as Promise<string[]>,
  getTagSummaries: () => ipcRenderer.invoke('tags:summaries') as Promise<TagSummary[]>,
  previewTagRule: (input: TagRulePreviewInput) =>
    ipcRenderer.invoke('tags:preview-rule', input) as Promise<TagRulePreviewResult>,
  getTrackIdsByTag: (name: string) => ipcRenderer.invoke('tags:track-ids-by-tag', name) as Promise<number[]>,
  buildHarmonicMix: (input?: HarmonicMixInput) =>
    ipcRenderer.invoke('smart:harmonic-mix', input) as Promise<Track[]>,
  buildTasteMix: (input?: TasteMixInput) =>
    ipcRenderer.invoke('smart:taste-mix', input) as Promise<Track[]>,
  lastfmStartAuth: () => ipcRenderer.invoke('lastfm:start-auth') as Promise<LastfmAuthStart>,
  lastfmCompleteAuth: () =>
    ipcRenderer.invoke('lastfm:complete-auth') as Promise<LastfmSession>,
  lastfmDisconnect: () => ipcRenderer.invoke('lastfm:disconnect') as Promise<AppSettings>,
  lastfmUpdateNowPlaying: (track: LastfmTrackPayload) =>
    ipcRenderer.invoke('lastfm:update-now-playing', track) as Promise<void>,
  lastfmScrobble: (track: LastfmTrackPayload, timestamp: number) =>
    ipcRenderer.invoke('lastfm:scrobble', track, timestamp) as Promise<void>,
  lastfmGetOutboxStatus: () =>
    ipcRenderer.invoke('lastfm:outbox-status') as Promise<LastfmOutboxStatus>,
  lastfmFlushOutbox: () =>
    ipcRenderer.invoke('lastfm:flush-outbox') as Promise<LastfmOutboxStatus>,
  getLocalLyrics: (trackId: number) =>
    ipcRenderer.invoke('lyrics:local', trackId) as Promise<LocalLyricsResult | null>,
  saveCustomLyrics: (input: CustomLyricsInput) =>
    ipcRenderer.invoke('lyrics:custom:save', input) as Promise<LocalLyricsResult | null>,
  clearCustomLyrics: (trackId: number) =>
    ipcRenderer.invoke('lyrics:custom:clear', trackId) as Promise<void>,
  generateLinerNotes: (input: AiLinerNotesInput) =>
    ipcRenderer.invoke('ai:liner-notes', input) as Promise<AiLinerNotesResult>,
  listPodcastSubscriptions: () =>
    ipcRenderer.invoke('podcasts:list') as Promise<PodcastSubscription[]>,
  subscribePodcastFeed: (url: string) =>
    ipcRenderer.invoke('podcasts:subscribe', url) as Promise<PodcastSubscription>,
  refreshPodcastFeed: (url: string) =>
    ipcRenderer.invoke('podcasts:refresh', url) as Promise<PodcastSubscription>,
  removePodcastFeed: (url: string) =>
    ipcRenderer.invoke('podcasts:remove', url) as Promise<void>,
  updatePodcastEpisodeProgress: (input: PodcastProgressInput) =>
    ipcRenderer.invoke('podcasts:progress', input) as Promise<PodcastEpisode | null>,
  downloadPodcastEpisode: (feedUrl: string, episodeId: string) =>
    ipcRenderer.invoke('podcasts:download', feedUrl, episodeId) as Promise<PodcastEpisode | null>,
  removePodcastEpisodeDownload: (feedUrl: string, episodeId: string) =>
    ipcRenderer.invoke('podcasts:remove-download', feedUrl, episodeId) as Promise<PodcastEpisode | null>,
  getStats: () => ipcRenderer.invoke('library:get-stats'),
  getLibraryHealth: () => ipcRenderer.invoke('library:get-health') as Promise<LibraryHealth>,
  pruneMissingTracks: (targets?: string[]) =>
    ipcRenderer.invoke('library:prune-missing', targets) as Promise<LibraryPruneMissingResult>,
  getListeningHistory: (opts) =>
    ipcRenderer.invoke('history:get', opts) as Promise<ListeningHistoryItem[]>,
  getListeningInsights: (opts) =>
    ipcRenderer.invoke('history:insights', opts) as Promise<ListeningInsights>,
  getWrappedStats: (opts) =>
    ipcRenderer.invoke('history:wrapped', opts) as Promise<WrappedStats>,
  getReviews: (target) => ipcRenderer.invoke('social:reviews:get', target) as Promise<Review[]>,
  saveReview: (input) => ipcRenderer.invoke('social:reviews:save', input) as Promise<Review>,
  deleteReview: (id: number) => ipcRenderer.invoke('social:reviews:delete', id) as Promise<void>,
  getLists: () => ipcRenderer.invoke('social:lists:get') as Promise<ListSummary[]>,
  getList: (id: number) => ipcRenderer.invoke('social:list:get', id) as Promise<ListDetail | null>,
  saveList: (input) => ipcRenderer.invoke('social:lists:save', input) as Promise<ListSummary>,
  deleteList: (id: number) => ipcRenderer.invoke('social:lists:delete', id) as Promise<void>,
  addListItem: (input) => ipcRenderer.invoke('social:list-item:add', input) as Promise<ListItem>,
  removeListItem: (id: number) => ipcRenderer.invoke('social:list-item:remove', id) as Promise<void>,
  reorderListItems: (listId: number, orderedIds: number[]) =>
    ipcRenderer.invoke('social:list:reorder', listId, orderedIds) as Promise<void>,
  getProfile: () => ipcRenderer.invoke('social:profile:get') as Promise<UserProfile>,
  saveProfile: (input) => ipcRenderer.invoke('social:profile:save', input) as Promise<UserProfile>,
  exportProfileBundle: () => ipcRenderer.invoke('social:export-profile') as Promise<string | null>,
  clearListeningHistory: () => ipcRenderer.invoke('history:clear') as Promise<void>,
  getTrackBookmarks: (trackId: number) =>
    ipcRenderer.invoke('bookmark:list', trackId) as Promise<TrackBookmark[]>,
  saveTrackBookmark: (input: SaveTrackBookmarkInput) =>
    ipcRenderer.invoke('bookmark:save', input) as Promise<TrackBookmark>,
  deleteTrackBookmark: (id: number) => ipcRenderer.invoke('bookmark:delete', id) as Promise<void>,
  toggleLove: (id) => ipcRenderer.invoke('library:toggle-love', id),
  setTrackRating: (id: number, rating: number) =>
    ipcRenderer.invoke('library:set-rating', id, rating) as Promise<Track | null>,
  setTrackRatingScore: (id: number, score: number | null) =>
    ipcRenderer.invoke('library:set-rating-score', id, score) as Promise<Track | null>,
  setAlbumRatingScore: (albumArtist: string, album: string, score: number | null) =>
    ipcRenderer.invoke('library:set-album-rating-score', albumArtist, album, score) as Promise<AlbumRating | null>,
  getAlbumRating: (albumArtist: string, album: string) =>
    ipcRenderer.invoke('library:get-album-rating', albumArtist, album) as Promise<AlbumRating | null>,
  toggleAvoidAutoPlay: (id: number) =>
    ipcRenderer.invoke('library:toggle-avoid-autoplay', id) as Promise<Track | null>,
  recordPlay: (id) => ipcRenderer.invoke('library:record-play', id),
  recordSkip: (id, position) => ipcRenderer.invoke('library:record-skip', id, position),
  getArtUrl: (trackId: number) => `newart://track/${trackId}/art`,
  pickFolder: () => ipcRenderer.invoke('os:pick-folder'),
  getSuggestedMusicFolders: () => ipcRenderer.invoke('os:suggested-music-folders'),
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch) as Promise<AppSettings>,
  exportCustomSkin: (skin: CustomSkin) =>
    ipcRenderer.invoke('settings:skin-export', skin) as Promise<string | null>,
  importCustomSkin: () =>
    ipcRenderer.invoke('settings:skin-import') as Promise<CustomSkin | null>,
  importCustomSkinFile: (path: string) =>
    ipcRenderer.invoke('settings:skin-import-file', path) as Promise<CustomSkin | null>,
  getSupportDiagnostics: () =>
    ipcRenderer.invoke('app:support-diagnostics') as Promise<SupportDiagnostics>,
  createSupportBackup: () =>
    ipcRenderer.invoke('app:create-backup') as Promise<SupportBackupResult>,
  restoreSupportBackup: () =>
    ipcRenderer.invoke('app:restore-backup') as Promise<SupportRestoreResult | null>,
  showInFolder: (p) => ipcRenderer.invoke('os:show-in-folder', p),
  onPlayerCommand: (cb) => {
    const handler = (_e: unknown, command: PlayerCommand) => cb(command);
    ipcRenderer.on('player:command', handler);
    return () => ipcRenderer.off('player:command', handler);
  },
  onOpenFiles: (cb) => {
    const handler = (_e: unknown, paths: string[]) => cb(paths);
    ipcRenderer.on('app:open-files', handler);
    return () => ipcRenderer.off('app:open-files', handler);
  },
  searchGuitarTabs: (query: GuitarTabSearchQuery) =>
    ipcRenderer.invoke('tabs:search', query) as Promise<GuitarTabSearchResult[]>,
  getGuitarTab: (url: string) =>
    ipcRenderer.invoke('tabs:get', url) as Promise<GuitarTabDocument>,
  getCachedGuitarTabs: (trackId: number) =>
    ipcRenderer.invoke('tabs:cache:list', trackId) as Promise<CachedGuitarTab[]>,
  saveCachedGuitarTab: (trackId: number, document: GuitarTabDocument) =>
    ipcRenderer.invoke('tabs:cache:save', trackId, document) as Promise<CachedGuitarTab>,
  saveLocalGuitarTab: (trackId: number, input: LocalGuitarTabInput) =>
    ipcRenderer.invoke('tabs:local:save', trackId, input) as Promise<CachedGuitarTab>,
  findLocalGuitarTab: (trackId: number) =>
    ipcRenderer.invoke('tabs:local:find', trackId) as Promise<CachedGuitarTab | null>,
  openGuitarTabWindow: (document: GuitarTabDocument, startAutoscroll?: boolean) =>
    ipcRenderer.invoke('tabs:window:open', document, !!startAutoscroll) as Promise<void>,
  exclusiveSupported: () => ipcRenderer.invoke('exclusive:supported') as Promise<boolean>,
  exclusiveListDevices: () =>
    ipcRenderer.invoke('exclusive:list-devices') as Promise<ExclusiveDeviceInfo[]>,
  exclusivePlay: (trackId: number, startAt?: number) =>
    ipcRenderer.invoke('exclusive:play', trackId, startAt ?? 0) as Promise<ExclusivePlayResult>,
  exclusivePause: () => ipcRenderer.invoke('exclusive:pause') as Promise<void>,
  exclusiveResume: () => ipcRenderer.invoke('exclusive:resume') as Promise<void>,
  exclusiveStop: () => ipcRenderer.invoke('exclusive:stop') as Promise<void>,
  exclusiveSeek: (seconds: number) => ipcRenderer.invoke('exclusive:seek', seconds) as Promise<void>,
  exclusivePrepareNext: (trackId: number | null) =>
    ipcRenderer.invoke('exclusive:prepare-next', trackId) as Promise<void>,
  onExclusiveEvent: (cb) => {
    const handler = (_e: unknown, payload: ExclusiveEventPayload) => cb(payload);
    ipcRenderer.on('exclusive:event', handler);
    return () => ipcRenderer.off('exclusive:event', handler);
  },
  onExclusiveTap: (cb) => {
    const handler = (_e: unknown, tap: { pcm: Float32Array; channels: number; sampleRate: number }) =>
      cb(tap);
    ipcRenderer.on('exclusive:tap', handler);
    return () => ipcRenderer.off('exclusive:tap', handler);
  },
  ...readAppInfo(),
};

function readAppInfo(): { platform: string; appVersion: string } {
  // Synchronous IPC: guaranteed to populate before contextBridge exposes the
  // value to the renderer. Falls back to safe defaults if the main handler
  // isn't registered (e.g. during test harnesses).
  try {
    const info = ipcRenderer.sendSync('app:get-info-sync') as
      | { platform: string; appVersion: string }
      | undefined;
    if (info && typeof info.appVersion === 'string' && typeof info.platform === 'string') {
      return info;
    }
  } catch {
    /* ignore */
  }
  return { platform: process.platform || 'unknown', appVersion: NEWAMP_VERSION };
}

contextBridge.exposeInMainWorld('newamp', api);

// Window control shortcuts (used by the custom title bar)
contextBridge.exposeInMainWorld('winctl', {
  minimize: () => ipcRenderer.invoke('win:minimize'),
  toggleMax: () => ipcRenderer.invoke('win:toggle-max'),
  setFullscreen: (on: boolean) => ipcRenderer.invoke('win:set-fullscreen', on),
  isFullscreen: () => ipcRenderer.invoke('win:is-fullscreen') as Promise<boolean>,
  setCompact: (on: boolean, size?: { width?: number; height?: number }) =>
    ipcRenderer.invoke('win:set-compact', on, size),
  setCompactSize: (size: { width: number; height: number }) =>
    ipcRenderer.invoke('win:set-compact-size', size),
  setAlwaysOnTop: (on: boolean) => ipcRenderer.invoke('win:set-always-on-top', on),
  close: () => ipcRenderer.invoke('win:close'),
  // Fire-and-forget playback snapshot for shell integrations (Windows
  // taskbar thumbnail toolbar play/pause/next, tray tooltip). The renderer
  // dedupes on (isPlaying, trackId); main applies.
  notifyPlayback: (state: {
    isPlaying: boolean;
    title: string | null;
    artist: string | null;
    album: string | null;
    trackId: number | null;
    position: number;
    duration: number;
    volume: number;
  }) => ipcRenderer.send('playback:state', state),
  onState: (cb: (s: { maximized: boolean }) => void) => {
    const handler = (_e: unknown, s: { maximized: boolean }) => cb(s);
    ipcRenderer.on('window-state', handler);
    return () => ipcRenderer.off('window-state', handler);
  },
});

// Detached Eviland visualizer window bridge.
//
// This preload runs in BOTH the main renderer and the detached window. The
// IPC verbs are no-ops in the detached window (they invoke main, which only
// honors them when the main window is alive — which it always is, because
// the detached window is a child of the main session).
//
// The 'eviland:frame-port' bridge is the load-bearing piece for the detached
// window: Electron's webContents.postMessage(channel, message, transferables)
// delivers the MessagePort on event.ports[]. We MUST re-dispatch it as a
// window MessageEvent so renderer code (frame-bus.ts, src/detached/main.tsx)
// can pick it up — preload listeners are the only place those ports survive
// the contextIsolation boundary.
interface DetachedDisplayBridge {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  internal: boolean;
  primary: boolean;
}

contextBridge.exposeInMainWorld('detachedViz', {
  listDisplays: (): Promise<DetachedDisplayBridge[]> =>
    ipcRenderer.invoke('detached-viz:list-displays') as Promise<DetachedDisplayBridge[]>,
  open: (opts: { displayId?: number; fullscreen?: boolean } = {}): Promise<void> =>
    ipcRenderer.invoke('detached-viz:open', opts) as Promise<void>,
  close: (): Promise<void> => ipcRenderer.invoke('detached-viz:close') as Promise<void>,
  moveToDisplay: (displayId: number): Promise<void> =>
    ipcRenderer.invoke('detached-viz:move-to-display', displayId) as Promise<void>,
  setFullscreen: (on: boolean): Promise<void> =>
    ipcRenderer.invoke('detached-viz:set-fullscreen', on) as Promise<void>,
  // Toggle returns the resulting fullscreen state — used by the projector's
  // control bar to flip its own button without needing a separate is-fullscreen
  // probe. Falls back to false if the IPC has no win (closed mid-toggle).
  toggleFullscreen: (): Promise<boolean> =>
    ipcRenderer.invoke('detached-viz:toggle-fullscreen') as Promise<boolean>,
  isFullscreen: (): Promise<boolean> =>
    ipcRenderer.invoke('detached-viz:is-fullscreen') as Promise<boolean>,
  // Transport commands from the projector. Forwarded by the main process to
  // the MAIN window's renderer (where the AudioEngine + store live). The
  // detached window has no AudioContext of its own — without this, the
  // projector is a beautiful spectator with no way to play/pause/next/scrub.
  transportCommand: (cmd: 'togglePlay' | 'next' | 'prev' | 'seek' | 'setVolume', arg?: number): Promise<void> =>
    ipcRenderer.invoke('transport:command', cmd, arg) as Promise<void>,
  isOpen: (): Promise<boolean> =>
    ipcRenderer.invoke('detached-viz:is-open') as Promise<boolean>,
  // The detached renderer calls this AFTER its 'eviland:frame-port' listener
  // is installed. Main wires the MessageChannelMain pair only then — wiring at
  // ready-to-show raced module evaluation, and a port posted before the
  // listener existed was dropped forever (black projector, stuck on
  // "Connecting to NewAmp…").
  rendererReady: (): void => ipcRenderer.send('detached-viz:renderer-ready'),
  onOpened: (cb: () => void): (() => void) => {
    const h = () => cb();
    ipcRenderer.on('detached-viz:opened', h);
    return () => ipcRenderer.off('detached-viz:opened', h);
  },
  onClosed: (cb: () => void): (() => void) => {
    const h = () => cb();
    ipcRenderer.on('detached-viz:closed', h);
    return () => ipcRenderer.off('detached-viz:closed', h);
  },
  onCrashed: (cb: (reason: string) => void): (() => void) => {
    const h = (_e: unknown, info: { reason?: string } | undefined) => cb(info?.reason ?? 'unknown');
    ipcRenderer.on('detached-viz:crashed', h);
    return () => ipcRenderer.off('detached-viz:crashed', h);
  },
  onOpenFailed: (cb: (reason: string) => void): (() => void) => {
    const h = (_e: unknown, info: { reason?: string } | undefined) => cb(info?.reason ?? 'unknown');
    ipcRenderer.on('detached-viz:open-failed', h);
    return () => ipcRenderer.off('detached-viz:open-failed', h);
  },
  onDisplaysChanged: (cb: () => void): (() => void) => {
    const h = () => cb();
    ipcRenderer.on('displays:changed', h);
    return () => ipcRenderer.off('displays:changed', h);
  },
  // Subscribed in the MAIN window. The detached projector calls
  // transportCommand(...), the main process forwards it here, and the main
  // renderer dispatches the right store action. Same channel name as the
  // main-side IPC the projector window invokes.
  onTransportCommand: (
    cb: (cmd: 'togglePlay' | 'next' | 'prev' | 'seek' | 'setVolume', arg?: number) => void,
  ): (() => void) => {
    const h = (_e: unknown, payload: { cmd: string; arg?: number } | undefined) => {
      if (!payload) return;
      cb(payload.cmd as 'togglePlay' | 'next' | 'prev' | 'seek' | 'setVolume', payload.arg);
    };
    ipcRenderer.on('transport:command', h);
    return () => ipcRenderer.off('transport:command', h);
  },
});

// Frame-port hand-off. event.ports is a MessagePortMain[] in main-side land,
// but by the time it reaches the renderer-side ipcRenderer.on listener it is
// a DOM MessagePort[]. Re-dispatch onto window so frame-bus.ts (and the
// detached entry) can attach without crossing the context-isolation seam.
ipcRenderer.on('eviland:frame-port', (event) => {
  if (!event.ports || event.ports.length === 0) return;
  window.dispatchEvent(
    new MessageEvent('eviland:frame-port', { ports: event.ports as unknown as MessagePort[] }),
  );
});

// Helper that turns a local file path into a newamp:// URL the renderer can play.
contextBridge.exposeInMainWorld('toAudioUrl', (filePath: string) => {
  if (/^(https?:|blob:|newamp:)/i.test(filePath)) return filePath;
  const normalized = filePath.replace(/\\/g, '/');
  return `newamp://track/${encodeURI(normalized).replace(/#/g, '%23')}`;
});
