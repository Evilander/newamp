// Shared types between main and renderer. Keep this tiny and serializable.

export interface Track {
  id: number;
  path: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  genre: string | null;
  duration: number | null; // seconds
  bitrate: number | null;
  sampleRate: number | null;
  size: number | null; // bytes
  mtime: number; // ms
  hasArt: 0 | 1;
  loved: 0 | 1;
  rating: number;
  /**
   * Fine-grained score 0..100 with decimals (e.g. 88.3). Optional companion to
   * the integer `rating` (0..5). When set, `rating` is kept in sync as
   * round(ratingScore / 20) so existing star UI/sorts keep working.
   */
  ratingScore: number | null;
  avoidAutoPlay: 0 | 1;
  playCount: number;
  lastPlayed: number | null;
  skipCount: number;
  lastSkipped: number | null;
  bpm: number | null;
  key: string | null;
  replayGainTrackDb: number | null;
  replayGainAlbumDb: number | null;
  cuePath?: string | null;
  cueStart?: number | null;
  cueEnd?: number | null;
}

export interface MetadataLookupCandidate {
  source: 'musicbrainz';
  recordingId: string;
  releaseId: string | null;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  year: number | null;
  trackNo: number | null;
  discNo: number | null;
  duration: number | null; // seconds
  score: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface TrackMetadataPatchInput {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  albumArtist?: string | null;
  genre?: string | null;
  year?: number | null;
  trackNo?: number | null;
  discNo?: number | null;
}

export interface TrackQueryOptions {
  search?: string;
  limit?: number;
  offset?: number;
  sort?: string;
}

export interface AlbumSummary {
  album: string;
  albumArtist: string;
  year: number | null;
  trackCount: number;
  duration: number;
  artFromTrackId: number | null;
}

export interface AlbumArtLookupInput {
  album: string;
  albumArtist: string;
}

export interface AlbumArtLookupResult {
  source: 'cover-art-archive';
  releaseGroupId: string;
  releaseGroupTitle: string;
  artist: string;
  firstReleaseDate: string | null;
  primaryType: string | null;
  score: number;
  imageUrl: string;
  thumbnailUrl: string | null;
}

export interface AlbumArtApplyResult {
  album: string;
  albumArtist: string;
  artFromTrackId: number | null;
  appliedTrackCount: number;
  mime: string;
  bytes: number;
  sourceUrl: string;
  appliedAt: number;
}

export interface ArtistSummary {
  artist: string;
  trackCount: number;
  albumCount: number;
}

export interface FolderSummary {
  path: string;
  name: string;
  parentPath: string | null;
  childFolderCount: number;
  trackCount: number;
  totalTrackCount: number;
  duration: number;
  artFromTrackId: number | null;
}

export interface SavedPlaylist {
  id: number;
  name: string;
  trackCount: number;
  duration: number;
  hasCoverArt: 0 | 1;
  coverArtUpdatedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SavePlaylistInput {
  id?: number;
  name: string;
  trackIds: number[];
  coverImagePath?: string | null;
  clearCoverImage?: boolean;
}

export interface AddTracksToPlaylistInput {
  playlistId: number;
  trackIds: number[];
}

export interface PlaylistM3uImportResult {
  playlist: SavedPlaylist;
  matched: number;
  skipped: number;
}

export interface PlaylistFolderExportResult {
  path: string;
  playlistPath: string;
  copied: number;
  skipped: string[];
  bytes: number;
}

export interface ExportTracksFolderInput {
  name: string;
  trackIds: number[];
}

export interface OpenFilesResult {
  tracks: Track[];
  importedPlaylists: PlaylistM3uImportResult[];
  skipped: string[];
}

export interface TrackWavExportResult {
  path: string;
  bytes: number;
}

export interface TrackWavBatchExportResult {
  path: string;
  exported: number;
  skipped: string[];
  bytes: number;
  files: TrackWavExportResult[];
}

export type AudioExportFormat = 'wav' | 'mp3' | 'flac' | 'opus';

export interface TrackAudioExportResult {
  path: string;
  bytes: number;
  format: AudioExportFormat;
}

export interface TrackAudioBatchExportResult {
  path: string;
  exported: number;
  skipped: string[];
  bytes: number;
  format: AudioExportFormat;
  files: TrackAudioExportResult[];
}

export interface ReplayGainAnalysisResult {
  analyzed: number;
  skipped: string[];
  tracks: Track[];
  albumGroups?: number;
}

export interface LibraryDuplicateGroup {
  artist: string;
  title: string;
  count: number;
  exactMatchCount: number;
  tracks: Track[];
}

export interface LibraryFormatCount {
  ext: string;
  count: number;
}

export interface LibraryHealth {
  totals: { tracks: number; albums: number; artists: number; duration: number };
  missing: {
    artist: number;
    album: number;
    year: number;
    art: number;
    duration: number;
  };
  duplicateGroups: LibraryDuplicateGroup[];
  legacyFormats: LibraryFormatCount[];
  recentlyAdded: Track[];
  generatedAt: number;
}

export interface LibraryPruneMissingResult {
  checked: number;
  removed: number;
}

export interface ListeningHistoryItem {
  id: number;
  playedAt: number;
  track: Track;
}

export interface ListeningInsightBucket {
  plays: number;
  duration: number;
  skips: number;
}

export interface ListeningInsightArtist extends ListeningInsightBucket {
  artist: string;
}

export interface ListeningInsightAlbum extends ListeningInsightBucket {
  album: string;
  albumArtist: string;
}

export interface ListeningInsightDay extends ListeningInsightBucket {
  date: string;
}

export interface ListeningInsights {
  generatedAt: number;
  total: ListeningInsightBucket & {
    uniqueTracks: number;
    uniqueSkippedTracks: number;
    firstPlayedAt: number | null;
    lastPlayedAt: number | null;
    lastSkippedAt: number | null;
  };
  today: ListeningInsightBucket;
  week: ListeningInsightBucket;
  topArtists: ListeningInsightArtist[];
  topAlbums: ListeningInsightAlbum[];
  recentDays: ListeningInsightDay[];
}

export interface SaveTrackBookmarkInput {
  id?: number;
  trackId: number;
  position: number;
  label?: string | null;
}

export interface TrackBookmark {
  id: number;
  trackId: number;
  position: number;
  label: string;
  createdAt: number;
  updatedAt: number;
}

export type SmartPlaylistMood = 'focus' | 'drive' | 'night' | 'deep-cuts';

export interface SmartPlaylistRuleInput {
  id?: number;
  name: string;
  mood: SmartPlaylistMood;
  count: number;
  genreQuery?: string | null;
  searchQuery?: string | null;
  minYear?: number | null;
  maxYear?: number | null;
  minBpm?: number | null;
  maxBpm?: number | null;
  minRating?: number | null;
  lovedOnly?: boolean;
  unplayedOnly?: boolean;
}

export interface SmartPlaylistRule extends Required<Omit<SmartPlaylistRuleInput, 'id'>> {
  id: number;
  createdAt: number;
  updatedAt: number;
}

export interface SmartPlaylistSuggestion {
  id: string;
  title: string;
  subtitle: string;
  reason: string;
  sampleCount: number;
  rule: SmartPlaylistRuleInput;
}

export interface HarmonicMixInput {
  seedTrackId?: number | null;
  count?: number;
  genreQuery?: string | null;
  maxBpmDelta?: number | null;
}

export interface TasteMixInput {
  seedTrackId?: number | null;
  count?: number | null;
}

export interface LastfmAuthStart {
  authUrl: string;
  token: string;
}

export interface LastfmSession {
  username: string;
  sessionKey: string;
}

export interface LastfmTrackPayload {
  artist: string;
  title: string;
  album?: string | null;
  albumArtist?: string | null;
  duration?: number | null;
  trackNumber?: number | null;
}

export interface LastfmOutboxStatus {
  pending: number;
  oldestCreatedAt: number | null;
  lastError: string | null;
}

export type LocalLyricsSource = 'sidecar' | 'custom';

export interface LocalLyricsResult {
  source: LocalLyricsSource;
  path: string;
  plainLyrics: string | null;
  syncedLyrics: string | null;
  updatedAt?: number | null;
}

export interface CustomLyricsInput {
  trackId: number;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export interface AiLinerNotesTrack {
  id: number;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  genre: string | null;
  year: number | null;
  duration: number | null;
  rating: number;
  ratingScore: number | null;
  bpm: number | null;
  key: string | null;
  playCount: number;
  skipCount: number;
}

export interface AiLinerNotesInput {
  track: AiLinerNotesTrack;
  lyricHighlights: string[];
  lyricsPreview: string | null;
  localContext: string[];
}

export interface AiLinerNotesResult {
  headline: string;
  summary: string;
  listeningNotes: string[];
  contextCards: { label: string; value: string }[];
  caution: string | null;
  generatedAt: number;
  model: string;
}

export type PlaybackMode = 'normal' | 'repeat-one' | 'repeat-all' | 'shuffle';

export interface PlaybackResumeState {
  queueTrackIds: number[];
  index: number;
  currentTime: number;
  mode: PlaybackMode;
  updatedAt: number;
}

export interface ScanProgress {
  scanned: number;
  total: number;
  current: string;
  done: boolean;
  startedAt: number;
  parsed?: number;
  skipped?: number;
}

export interface RadioStation {
  id: string;
  name: string;
  url: string;
  homepage?: string;
  favicon?: string;
  country?: string;
  language?: string;
  tags?: string;
  bitrate?: number;
  codec?: string;
}

export interface PodcastFeed {
  id: string;
  url: string;
  title: string;
  description: string | null;
  siteUrl: string | null;
  imageUrl: string | null;
  episodeCount: number;
  lastFetchedAt: number;
}

export interface PodcastEpisode {
  id: string;
  feedUrl: string;
  feedTitle: string;
  title: string;
  description: string | null;
  audioUrl: string;
  siteUrl: string | null;
  imageUrl: string | null;
  publishedAt: number | null;
  duration: number | null;
  progressSeconds: number;
  completed: boolean;
  lastPlayedAt: number | null;
  downloadPath: string | null;
  downloadedAt: number | null;
  downloadBytes: number | null;
}

export interface PodcastSubscription {
  feed: PodcastFeed;
  episodes: PodcastEpisode[];
}

export interface PodcastProgressInput {
  feedUrl: string;
  episodeId: string;
  position: number;
  duration?: number | null;
  completed?: boolean;
}

export type BuiltInTheme =
  | 'classic'
  | 'midnight'
  | 'neon'
  | 'amber'
  | 'ops'
  | 'oxide'
  | 'steel'
  | 'walnut'
  | 'jukebox'
  | 'terminal'
  | 'ice'
  | 'miami'
  | 'mono';
export type Theme = BuiltInTheme | 'custom';

export interface CustomSkin {
  name: string;
  baseTheme: BuiltInTheme;
  variables: Record<string, string>;
  updatedAt: number;
}

export interface AppSettings {
  libraryRoots: string[];
  libraryAutoWatch: boolean;
  theme: Theme;
  customSkin: CustomSkin | null;
  lastfmEnabled: boolean;
  lastfmApiKey: string | null;
  lastfmSharedSecret: string | null;
  lastfmSessionKey: string | null;
  lastfmUsername: string | null;
  lastfmAuthToken: string | null;
  openaiApiKey: string | null;
  openaiModel: string;
  firstLaunchTutorialSeen: boolean;
  textScale: number;
  crossfadeMs: number;
  replayGain: 'off' | 'track' | 'album';
  limiterEnabled: boolean;
  preampDb: number;
  resumeState: PlaybackResumeState | null;
  compactMode: boolean;
  alwaysOnTop: boolean;
  visualizerPreset: VisualizerPreset;
  volume: number;
  playbackRate: number;
  audioOutputDeviceId: string | null;
  autoDjEnabled: boolean;
  autoDjTarget: number;
  autoDjSmartRuleId: number | null;
  equalizer: number[]; // 10 bands, -12..+12 dB
  eqEnabled: boolean;
}

export type PlayerCommand = 'toggle-play' | 'next' | 'previous' | 'stop';
export type VisualizerPreset =
  | 'butterchurn'
  | 'galaxy'
  | 'aurora'
  | 'spectrum'
  | 'oscilloscope'
  | 'radial'
  | 'tunnel'
  | 'pulse'
  | 'neon-waves'
  | 'neon-ribbons'
  | 'plasma-grid'
  | 'prism-bars'
  | 'confetti'
  | 'burning-cloud';
export type GuitarTabLineType = 'chords' | 'lyrics' | 'blank' | 'section' | 'tab';
export type GuitarTabSource = 'ultimate-guitar' | 'local';

export interface GuitarTabSearchQuery {
  artist: string;
  title: string;
  limit?: number;
}

export interface GuitarTabSearchResult {
  id: string;
  source: 'ultimate-guitar';
  title: string;
  artist: string;
  kind: string;
  url: string;
  rating: number | null;
  votes: number | null;
}

export interface GuitarTabLine {
  type: GuitarTabLineType;
  text: string;
}

export interface LocalGuitarTabInput {
  artist: string;
  title: string;
  content: string;
  kind?: string | null;
  key?: string | null;
}

export interface GuitarTabDocument {
  source: GuitarTabSource;
  url: string;
  title: string;
  artist: string;
  kind: string;
  author: string | null;
  rating: number | null;
  votes: number | null;
  key: string | null;
  lines: GuitarTabLine[];
  fetchedAt: number;
}

export interface CachedGuitarTab {
  id: number;
  trackId: number;
  url: string;
  title: string;
  artist: string;
  kind: string;
  document: GuitarTabDocument;
  createdAt: number;
  updatedAt: number;
}

export interface RecoveryEvent {
  store: 'settings' | 'library';
  filePath: string;
  backupPath: string;
  reason: string;
  recoveredAt: number;
}

export interface SupportDiagnostics {
  appVersion: string;
  platform: string;
  electronVersion: string;
  userDataPath: string;
  diagnosticsPath: string;
  diagnosticEventsPath: string;
  latestCrashPath: string;
  crashDumpsPath: string;
  settingsPath: string;
  libraryPath: string;
  generatedAt: number;
  libraryStats: { tracks: number; albums: number; artists: number; duration: number };
  lastfmOutbox: LastfmOutboxStatus;
  recoveryEvents: RecoveryEvent[];
}

export interface SupportBackupResult {
  backupPath: string;
  createdAt: number;
  filesCopied: number;
  included: string[];
}

export interface SupportRestoreResult {
  backupPath: string;
  safetyBackupPath: string | null;
  restoredAt: number;
  restored: string[];
  restartRequired: boolean;
}

export interface MusicFolderSuggestion {
  path: string;
  label: string;
  reason: string;
}

export interface NewampAPI {
  // library
  scanLibrary: (roots?: string[]) => Promise<void>;
  cancelScan: () => Promise<void>;
  onScanProgress: (cb: (p: ScanProgress) => void) => () => void;
  getTracks: (opts?: TrackQueryOptions) => Promise<Track[]>;
  getTrackCount: (opts?: Pick<TrackQueryOptions, 'search' | 'sort'>) => Promise<number>;
  getAlbums: () => Promise<AlbumSummary[]>;
  lookupAlbumArt: (input: AlbumArtLookupInput) => Promise<AlbumArtLookupResult[]>;
  applyAlbumArt: (input: AlbumArtLookupInput, candidate: AlbumArtLookupResult) => Promise<AlbumArtApplyResult | null>;
  getArtists: () => Promise<ArtistSummary[]>;
  getFolders: (parentPath?: string | null) => Promise<FolderSummary[]>;
  getFolderTracks: (
    folderPath: string,
    opts?: { recursive?: boolean; limit?: number; offset?: number },
  ) => Promise<Track[]>;
  getAlbumTracks: (album: string, albumArtist: string) => Promise<Track[]>;
  getArtistTracks: (artist: string) => Promise<Track[]>;
  getTrack: (id: number) => Promise<Track | null>;
  lookupTrackMetadata: (id: number) => Promise<MetadataLookupCandidate[]>;
  applyTrackMetadataPatch: (id: number, candidate: MetadataLookupCandidate) => Promise<Track | null>;
  applyTrackMetadataEdit: (id: number, patch: TrackMetadataPatchInput) => Promise<Track | null>;
  getPlaylists: () => Promise<SavedPlaylist[]>;
  savePlaylist: (input: SavePlaylistInput) => Promise<SavedPlaylist>;
  addTracksToPlaylist: (input: AddTracksToPlaylistInput) => Promise<SavedPlaylist | null>;
  deletePlaylist: (id: number) => Promise<void>;
  getPlaylistTracks: (id: number) => Promise<Track[]>;
  getPlaylistCoverUrl: (id: number, updatedAt?: number | null) => string;
  pickPlaylistCoverImage: () => Promise<string | null>;
  exportPlaylistM3u: (id: number) => Promise<string | null>;
  exportPlaylistPls: (id: number) => Promise<string | null>;
  exportPlaylistFolder: (id: number) => Promise<PlaylistFolderExportResult | null>;
  exportTracksFolder: (input: ExportTracksFolderInput) => Promise<PlaylistFolderExportResult | null>;
  importPlaylistM3u: () => Promise<PlaylistM3uImportResult | null>;
  exportTrackWav: (id: number) => Promise<TrackWavExportResult | null>;
  exportTracksWav: (ids: number[]) => Promise<TrackWavBatchExportResult | null>;
  exportTracksAudio: (ids: number[], format: AudioExportFormat) => Promise<TrackAudioBatchExportResult | null>;
  analyzeReplayGain: (ids: number[]) => Promise<ReplayGainAnalysisResult>;
  analyzeAlbumReplayGain: (ids: number[]) => Promise<ReplayGainAnalysisResult>;
  openFiles: (paths: string[]) => Promise<OpenFilesResult>;
  consumePendingOpenFiles: () => Promise<string[]>;
  getDroppedFilePaths: (files: unknown[]) => string[];
  getSmartPlaylistRules: () => Promise<SmartPlaylistRule[]>;
  getSuggestedSmartPlaylistRules: () => Promise<SmartPlaylistSuggestion[]>;
  saveSmartPlaylistRule: (input: SmartPlaylistRuleInput) => Promise<SmartPlaylistRule>;
  deleteSmartPlaylistRule: (id: number) => Promise<void>;
  runSmartPlaylistRule: (input: number | SmartPlaylistRuleInput) => Promise<Track[]>;
  buildHarmonicMix: (input?: HarmonicMixInput) => Promise<Track[]>;
  buildTasteMix: (input?: TasteMixInput) => Promise<Track[]>;
  lastfmStartAuth: () => Promise<LastfmAuthStart>;
  lastfmCompleteAuth: () => Promise<LastfmSession>;
  lastfmDisconnect: () => Promise<AppSettings>;
  lastfmUpdateNowPlaying: (track: LastfmTrackPayload) => Promise<void>;
  lastfmScrobble: (track: LastfmTrackPayload, timestamp: number) => Promise<void>;
  lastfmGetOutboxStatus: () => Promise<LastfmOutboxStatus>;
  lastfmFlushOutbox: () => Promise<LastfmOutboxStatus>;
  getLocalLyrics: (trackId: number) => Promise<LocalLyricsResult | null>;
  saveCustomLyrics: (input: CustomLyricsInput) => Promise<LocalLyricsResult | null>;
  clearCustomLyrics: (trackId: number) => Promise<void>;
  generateLinerNotes: (input: AiLinerNotesInput) => Promise<AiLinerNotesResult>;
  listPodcastSubscriptions: () => Promise<PodcastSubscription[]>;
  subscribePodcastFeed: (url: string) => Promise<PodcastSubscription>;
  refreshPodcastFeed: (url: string) => Promise<PodcastSubscription>;
  removePodcastFeed: (url: string) => Promise<void>;
  updatePodcastEpisodeProgress: (input: PodcastProgressInput) => Promise<PodcastEpisode | null>;
  downloadPodcastEpisode: (feedUrl: string, episodeId: string) => Promise<PodcastEpisode | null>;
  removePodcastEpisodeDownload: (feedUrl: string, episodeId: string) => Promise<PodcastEpisode | null>;
  getStats: () => Promise<{ tracks: number; albums: number; artists: number; duration: number }>;
  getLibraryHealth: () => Promise<LibraryHealth>;
  pruneMissingTracks: (targets?: string[]) => Promise<LibraryPruneMissingResult>;
  getListeningHistory: (opts?: { limit?: number; offset?: number }) => Promise<ListeningHistoryItem[]>;
  getListeningInsights: (opts?: { now?: number }) => Promise<ListeningInsights>;
  clearListeningHistory: () => Promise<void>;
  getTrackBookmarks: (trackId: number) => Promise<TrackBookmark[]>;
  saveTrackBookmark: (input: SaveTrackBookmarkInput) => Promise<TrackBookmark>;
  deleteTrackBookmark: (id: number) => Promise<void>;
  toggleLove: (id: number) => Promise<boolean>;
  setTrackRating: (id: number, rating: number) => Promise<Track | null>;
  setTrackRatingScore: (id: number, score: number | null) => Promise<Track | null>;
  toggleAvoidAutoPlay: (id: number) => Promise<Track | null>;
  recordPlay: (id: number) => Promise<void>;
  recordSkip: (id: number, position?: number) => Promise<void>;
  getArtUrl: (trackId: number) => string;
  pickFolder: () => Promise<string | null>;
  getSuggestedMusicFolders: () => Promise<MusicFolderSuggestion[]>;

  // settings
  getSettings: () => Promise<AppSettings>;
  setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  exportCustomSkin: (skin: CustomSkin) => Promise<string | null>;
  importCustomSkin: () => Promise<CustomSkin | null>;
  importCustomSkinFile: (path: string) => Promise<CustomSkin | null>;
  getSupportDiagnostics: () => Promise<SupportDiagnostics>;
  createSupportBackup: () => Promise<SupportBackupResult>;
  restoreSupportBackup: () => Promise<SupportRestoreResult | null>;

  // os
  showInFolder: (path: string) => Promise<void>;
  onPlayerCommand: (cb: (command: PlayerCommand) => void) => () => void;
  onOpenFiles: (cb: (paths: string[]) => void) => () => void;

  // play-along tabs
  searchGuitarTabs: (query: GuitarTabSearchQuery) => Promise<GuitarTabSearchResult[]>;
  getGuitarTab: (url: string) => Promise<GuitarTabDocument>;
  getCachedGuitarTabs: (trackId: number) => Promise<CachedGuitarTab[]>;
  saveCachedGuitarTab: (trackId: number, document: GuitarTabDocument) => Promise<CachedGuitarTab>;
  saveLocalGuitarTab: (trackId: number, input: LocalGuitarTabInput) => Promise<CachedGuitarTab>;
  findLocalGuitarTab: (trackId: number) => Promise<CachedGuitarTab | null>;
  openGuitarTabWindow: (document: GuitarTabDocument, startAutoscroll?: boolean) => Promise<void>;
  platform: string;
  appVersion: string;
}

declare global {
  interface Window {
    newamp: NewampAPI;
  }
}
