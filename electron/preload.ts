import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { NEWAMP_VERSION } from '../shared/app-version.js';
import type {
  AddTracksToPlaylistInput,
  AiLinerNotesInput,
  AiLinerNotesResult,
  AlbumArtApplyResult,
  AlbumArtLookupInput,
  AlbumArtLookupResult,
  AppSettings,
  AudioExportFormat,
  CachedGuitarTab,
  CustomLyricsInput,
  CustomSkin,
  DiscoverSurface,
  DiscoverSurfaceInput,
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
  MetadataLookupCandidate,
  NewAmpAPI,
  PlaylistFolderExportResult,
  PlaylistM3uImportResult,
  PodcastEpisode,
  PodcastProgressInput,
  PodcastSubscription,
  PlayerCommand,
  DnaStats,
  ReplayGainAnalysisResult,
  SavedPlaylist,
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

const api: NewAmpAPI = {
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
  getAlbumTracks: (album, albumArtist) =>
    ipcRenderer.invoke('library:get-album-tracks', album, albumArtist),
  getArtistTracks: (artist) => ipcRenderer.invoke('library:get-artist-tracks', artist),
  getTrack: (id) => ipcRenderer.invoke('library:get-track', id),
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
  onState: (cb: (s: { maximized: boolean }) => void) => {
    const handler = (_e: unknown, s: { maximized: boolean }) => cb(s);
    ipcRenderer.on('window-state', handler);
    return () => ipcRenderer.off('window-state', handler);
  },
});

// Helper that turns a local file path into a newamp:// URL the renderer can play.
contextBridge.exposeInMainWorld('toAudioUrl', (filePath: string) => {
  if (/^(https?:|blob:|newamp:)/i.test(filePath)) return filePath;
  const normalized = filePath.replace(/\\/g, '/');
  return `newamp://track/${encodeURI(normalized).replace(/#/g, '%23')}`;
});
