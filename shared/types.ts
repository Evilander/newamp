// Shared types between main and renderer. Keep this tiny and serializable.

import type { TrackDna as TrackDnaPublic } from './audio-dna.js';
import type { VisualMemoryPlan as VisualMemoryPlanPublic, VisualMemoryStats as VisualMemoryStatsPublic } from './visual-memory.js';

export interface TagRule {
  id: number;
  name: string;
  body: string;
  boost: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
}

export interface TagRuleInput {
  id?: number;
  name: string;
  body: string;
  boost?: number;
  enabled?: boolean;
}

export interface TagRecomputeOptions {
  trackIds?: number[];
  limit?: number;
  now?: number;
}

export interface TagRecomputeResult {
  rulesEvaluated: number;
  tracksEvaluated: number;
  tagsAssigned: number;
  errors: Record<string, string>;
}

export interface TagSummary {
  name: string;
  trackCount: number;
  boost: number;
  enabled: boolean;
}

export interface TagRulePreviewInput {
  body: string;
  limit?: number;
}

export interface TagRulePreviewResult {
  ok: boolean;
  errors: { message: string; line: number; column: number }[];
  ruleName: string | null;
  references: string[];
  matchCount: number;
  sampleTrackIds: number[];
}

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

export interface CatalogSummaryQueryOptions {
  search?: string;
  limit?: number;
  offset?: number;
  sort?: string;
  randomSeed?: number;
  missingArtOnly?: boolean;
  year?: number | null;
  yearWindow?: number;
  excludeAlbum?: string | null;
  excludeAlbumArtist?: string | null;
}

export interface AlbumSummary {
  album: string;
  albumArtist: string;
  year: number | null;
  trackCount: number;
  duration: number;
  artFromTrackId: number | null;
  /** Album-level user rating (1..5), 0 = unrated. Independent of track ratings. */
  rating: number;
  /** Album-level fine score 0..100; null when unrated. Persists separately so a rated album never overrides per-song ratings. */
  ratingScore: number | null;
  /** True when this album surfaced in a search because one of its SONGS matched (not the album/artist/year). Only set on search queries. */
  matchedOnTrack?: boolean;
  /** Up to 4 matching song titles (separator " · "), surfaced under the card when a search matched on track titles. Null otherwise. */
  matchedTrackTitles?: string | null;
}

/**
 * A stored album rating. Keyed on (albumArtist, album) — the same composite
 * the rest of the codebase uses to group tracks into albums. NOT a join row
 * with track-level rating; an album can be rated without rating any of its
 * tracks, and vice versa.
 */
export interface AlbumRating {
  albumArtist: string;
  album: string;
  rating: number;
  ratingScore: number | null;
  updatedAt: number;
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

export interface TracksDnaAnalysisResult {
  analyzed: number;
  skipped: string[];
  total: number;
}

export interface DnaStats {
  analyzed: number;
  missing: number;
  total: number;
}

export interface SimilarTrack {
  track: Track;
  score: number;
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

export interface LibraryQualityHealth {
  lossless: number;
  lossy: number;
  hiRes: number;
  dsd: number;
  ffmpegFallback: number;
  lowBitrate: number;
  replayGainReady: number;
  replayGainMissing: number;
  unknown: number;
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
  quality: LibraryQualityHealth;
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

// --- NewAmp Wrapped -------------------------------------------------------
export type WrappedRange = 'day' | 'week' | 'month' | 'year' | 'all';

export interface WrappedTopTrack {
  id: number;
  title: string;
  artist: string;
  plays: number;
}
export interface WrappedTopArtist {
  artist: string;
  plays: number;
  durationSec: number;
}
export interface WrappedTopAlbum {
  album: string;
  albumArtist: string;
  plays: number;
}
export interface WrappedGenre {
  genre: string;
  plays: number;
}
export interface WrappedTaste {
  energy: number; // 0..1
  brightness: number; // 0..1
  mood: string;
}
export interface WrappedStats {
  range: WrappedRange;
  label: string;
  generatedAt: number;
  rangeStart: number;
  rangeEnd: number;
  totals: {
    plays: number;
    durationSec: number;
    uniqueTracks: number;
    uniqueArtists: number;
    discoveries: number;
    loved: number;
  };
  topTracks: WrappedTopTrack[];
  topArtists: WrappedTopArtist[];
  topAlbums: WrappedTopAlbum[];
  genres: WrappedGenre[];
  listeningClock: number[]; // 24 entries, plays per local hour-of-day
  peakHour: number | null;
  busiestDay: { date: string; plays: number } | null;
  longestStreakDays: number;
  taste: WrappedTaste | null;
}

// --- Local-first social objects (Letterboxd-for-listening foundation) -----
export type SocialPrivacy = 'local' | 'friends' | 'public';
export type ReviewTargetType = 'track' | 'album' | 'artist';

export interface Review {
  id: number;
  targetType: ReviewTargetType;
  targetKey: string;
  title: string;
  body: string;
  rating: number | null;
  privacy: SocialPrivacy;
  createdAt: number;
  updatedAt: number;
}
export interface ReviewInput {
  id?: number;
  targetType: ReviewTargetType;
  targetKey: string;
  title?: string;
  body?: string;
  rating?: number | null;
  privacy?: SocialPrivacy;
}
export interface ListItem {
  id: number;
  listId: number;
  trackId: number | null;
  label: string;
  note: string;
  position: number;
}
export interface ListItemInput {
  listId: number;
  trackId?: number | null;
  label?: string;
  note?: string;
}
export interface ListSummary {
  id: number;
  title: string;
  description: string;
  ranked: boolean;
  privacy: SocialPrivacy;
  itemCount: number;
  createdAt: number;
  updatedAt: number;
}
export interface ListDetail extends ListSummary {
  items: ListItem[];
}
export interface ListInput {
  id?: number;
  title?: string;
  description?: string;
  ranked?: boolean;
  privacy?: SocialPrivacy;
}
export interface UserProfile {
  displayName: string;
  bio: string;
  favorites: string[];
  defaultPrivacy: SocialPrivacy;
  updatedAt: number;
}
export interface UserProfileInput {
  displayName?: string;
  bio?: string;
  favorites?: string[];
  defaultPrivacy?: SocialPrivacy;
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
  /** Exclude tracks played at/after this epoch-ms ("haven't played since…"). */
  notPlayedSinceMs?: number | null;
  /** DNA re-rank target 0..1 (perceptual loudness) — boosts ordering, never filters. */
  dnaEnergyTarget?: number | null;
  /** DNA re-rank target 0..1 (spectral brightness) — boosts ordering, never filters. */
  dnaBrightnessTarget?: number | null;
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

export type DiscoverTone = 'accent' | 'warn' | 'plain';

export type DiscoverDeckSkin =
  | 'bento'
  | 'winamp-classic'
  | 'winamp-industrial'
  | 'record-player'
  | 'jukebox'
  | 'cassette'
  | 'discman'
  | 'retro-tv';

export interface DiscoverSurfaceInput {
  seed?: string | null;
  limit?: number | null;
  lowEndMode?: boolean | null;
  now?: number | null;
  seedTrackId?: number | null;
}

export interface DiscoverInsightSummary {
  trackCount: number;
  albumCount: number;
  artistCount: number;
  lovedCount: number;
  highRatedCount: number;
  unplayedCount: number;
  recentlyAddedCount: number;
  forgottenFavoriteCount: number;
}

export interface DiscoverVisualPlan {
  title: string;
  subtitle: string;
  presets: VisualizerPreset[];
  deckSkin: DiscoverDeckSkin;
  lowEndMode: boolean;
  albumOverlay: boolean;
}

export interface DiscoverMixCard {
  id: string;
  title: string;
  subtitle: string;
  reason: string;
  tone: DiscoverTone;
  tracks: Track[];
  scoreLabel: string;
  visualPlan: DiscoverVisualPlan | null;
}

export interface DiscoverMissionStep {
  id: string;
  title: string;
  instruction: string;
  actionLabel: string;
  tracks: Track[];
}

export interface DiscoverMission {
  id: string;
  title: string;
  subtitle: string;
  reason: string;
  tone: DiscoverTone;
  steps: DiscoverMissionStep[];
  tracks: Track[];
  visualPlan: DiscoverVisualPlan | null;
}

export interface DiscoverSurface {
  modeName: 'Living Library';
  generatedAt: number;
  seed: string;
  summary: DiscoverInsightSummary;
  cards: DiscoverMixCard[];
  missions: DiscoverMission[];
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
  // True when the outbox is stalled behind an invalid Last.fm session
  // (revoked access, expired key) rather than a transient outage — the UI
  // should prompt the user to reconnect instead of just showing "pending".
  needsReconnect: boolean;
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
  radioBrainEnabled: boolean;
  radioBrainPort: number;
  /** Shared secret for Radio Brain / NewAmp Remote — every HTTP route requires it. Auto-generated on first server start. */
  radioBrainToken: string | null;
  audioBitPerfectPath: boolean;
  audioPreferredSampleRate: number | null;
  /**
   * Bit-Perfect Exclusive: native WASAPI-exclusive output (Windows only).
   * While a track plays through it the renderer's Web Audio graph is bypassed
   * entirely — no EQ, ReplayGain, crossfade, limiter, or software volume.
   */
  bitPerfectExclusive: boolean;
  /**
   * Native playback device for exclusive output (hex-encoded ma_device_id
   * from the addon); null = system default. NOT the same id-space as
   * audioOutputDeviceId (which is Chromium's virtualized device list).
   */
  bitPerfectExclusiveDeviceId: string | null;
  /**
   * What the window's X (close) button should do. `minimize-to-tray` (default)
   * preserves the legacy behavior — hides the window so playback continues
   * with a tray icon. `close-app` actually quits the process, matching what
   * users expect from a desktop close button.
   */
  closeButtonBehavior: 'minimize-to-tray' | 'close-app';
  /**
   * Adaptive rendering quality. `auto` measures the machine at runtime and
   * scales the visualizer + ambient reactivity; `high` forces full richness;
   * `lite` forces the lightest path for weak hardware.
   */
  performanceTier: 'auto' | 'high' | 'lite';
  /**
   * "Resonance" — the UI chrome reacting to the live audio. `auto` enables it
   * on capable hardware and disables it on weak machines; `on`/`off` force it.
   */
  ambientReactivity: 'auto' | 'on' | 'off';
}

export interface RadioBrainStatus {
  enabled: boolean;
  port: number;
  baseUrl: string | null;
  /** Phone-ready NewAmp Remote URL (token in the #fragment). Null when stopped. */
  remoteUrl: string | null;
  endpoints: string[];
  startedAt: number | null;
  error: string | null;
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
  | 'orbital-rings'
  | 'neon-waves'
  | 'neon-ribbons'
  | 'plasma-grid'
  | 'prism-bars'
  | 'confetti'
  | 'burning-cloud'
  | 'tempo-pulse'
  | 'lattice-strobe'
  | 'liquid-mercury'
  | 'particle-flow'
  | 'eviland'
  | 'eviland-live'
  | 'kaleido-bloom'
  | 'liquid-aurora-storm'
  | 'fractal-pulse'
  | 'starfield-warp'
  | 'spectral-tunnel'
  | 'album-breathe';
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

// ---- Bit-Perfect Exclusive output (native WASAPI, Windows) ------------------

export interface ExclusiveDeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
}

/** Resolved per-track decode source for the exclusive driver. */
export interface ExclusiveTrackSource {
  trackId: number;
  path: string;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  durationSec: number | null;
  lossless: boolean;
  dsd: boolean;
}

/**
 * What actually plays, chosen from the device's NATIVE exclusive formats.
 * `bitPerfect` is the strict claim (lossless source, rate + depth + channel
 * layout preserved, no DSD conversion); the other flags explain any gap so
 * the UI never has to guess why the badge isn't gold.
 */
export interface ExclusiveNegotiated {
  deviceName: string;
  format: 's16' | 's24' | 's32' | 'f32';
  sampleRate: number;
  channels: number;
  sourceSampleRate: number | null;
  sourceBitDepth: number | null;
  bitPerfect: boolean;
  resampled: boolean;
  depthPreserved: boolean;
  upmixed: boolean;
  /** Channel layout couldn't be verified (metadata probe failed) — ffmpeg
   *  still forces stereo, so gold is withheld conservatively. */
  channelsUnknown: boolean;
  dsd: boolean;
  lossless: boolean;
}

export type ExclusiveEventPayload =
  | {
      type: 'state';
      trackId: number | null;
      playing: boolean;
      negotiated: ExclusiveNegotiated;
      positionSec: number;
      durationSec: number | null;
    }
  | {
      type: 'position';
      trackId: number | null;
      positionSec: number;
      durationSec: number | null;
      underruns: number;
      bufferedFrames: number;
    }
  | { type: 'boundary'; trackId: number; positionSec: number; durationSec: number | null }
  | { type: 'ended'; trackId: number }
  | { type: 'device-lost'; trackId: number; positionSec: number }
  | { type: 'error'; trackId: number | null; message: string };

export interface ExclusivePlayResult {
  ok: boolean;
  chained?: boolean;
  negotiated?: ExclusiveNegotiated;
  error?: string;
}

export interface NewAmpAPI {
  // library
  scanLibrary: (roots?: string[]) => Promise<void>;
  cancelScan: () => Promise<void>;
  onScanProgress: (cb: (p: ScanProgress) => void) => () => void;
  getTracks: (opts?: TrackQueryOptions) => Promise<Track[]>;
  getTrackIds: (opts?: TrackQueryOptions) => Promise<number[]>;
  getTrackCount: (opts?: Pick<TrackQueryOptions, 'search' | 'sort'>) => Promise<number>;
  getAlbums: (opts?: CatalogSummaryQueryOptions) => Promise<AlbumSummary[]>;
  lookupAlbumArt: (input: AlbumArtLookupInput) => Promise<AlbumArtLookupResult[]>;
  applyAlbumArt: (input: AlbumArtLookupInput, candidate: AlbumArtLookupResult) => Promise<AlbumArtApplyResult | null>;
  getArtists: (opts?: CatalogSummaryQueryOptions) => Promise<ArtistSummary[]>;
  getFolders: (parentPath?: string | null) => Promise<FolderSummary[]>;
  getFolderTracks: (
    folderPath: string,
    opts?: { recursive?: boolean; limit?: number; offset?: number },
  ) => Promise<Track[]>;
  getFolderTrackIds: (
    folderPath: string,
    opts?: { recursive?: boolean; limit?: number; offset?: number },
  ) => Promise<number[]>;
  getAlbumTracks: (albumArtist: string, album: string) => Promise<Track[]>;
  getArtistTracks: (artist: string) => Promise<Track[]>;
  getTrack: (id: number) => Promise<Track | null>;
  getTracksByIds: (ids: number[]) => Promise<Track[]>;
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
  exportLibraryMetadata: (
    format: 'json' | 'csv',
  ) => Promise<{ path: string; tracks: number; format: 'json' | 'csv' } | null>;
  captureVisualizerPng: (rect?: { x: number; y: number; width: number; height: number }) => Promise<string | null>;
  /** Deck Snapshot: capture the composited compact deck window as a PNG data URL. */
  captureDeckSnapshotPng: () => Promise<string | null>;
  copyPngToClipboard: (dataUrl: string) => Promise<boolean>;
  saveCaptureBytes: (payload: { base64: string; defaultName: string; filterName: string; ext: string }) => Promise<string | null>;
  saveClipMp4: (payload: { base64: string; defaultName: string; vertical?: boolean; maxHeight?: number }) => Promise<string | null>;
  exportTrackWav: (id: number) => Promise<TrackWavExportResult | null>;
  exportTracksWav: (ids: number[]) => Promise<TrackWavBatchExportResult | null>;
  exportTracksAudio: (ids: number[], format: AudioExportFormat) => Promise<TrackAudioBatchExportResult | null>;
  analyzeReplayGain: (ids: number[]) => Promise<ReplayGainAnalysisResult>;
  analyzeAlbumReplayGain: (ids: number[]) => Promise<ReplayGainAnalysisResult>;
  analyzeTracksDna: (ids: number[]) => Promise<TracksDnaAnalysisResult>;
  getTrackDna: (id: number) => Promise<TrackDnaPublic | null>;
  getTrackIdsMissingDna: (limit?: number) => Promise<number[]>;
  getDnaStats: () => Promise<DnaStats>;
  getAllTrackDna: () => Promise<Array<{ id: number; dna: TrackDnaPublic }>>;
  findSimilarTracks: (trackId: number, limit?: number) => Promise<SimilarTrack[]>;
  getTrackVisualMemory: (id: number) => Promise<VisualMemoryPlanPublic | null>;
  setTrackVisualMemory: (id: number, plan: VisualMemoryPlanPublic) => Promise<boolean>;
  clearTrackVisualMemory: (id: number) => Promise<boolean>;
  getVisualMemoryStats: () => Promise<VisualMemoryStatsPublic>;
  clearAllVisualMemory: () => Promise<number>;
  getRadioBrainStatus: () => Promise<RadioBrainStatus>;
  openFiles: (paths: string[]) => Promise<OpenFilesResult>;
  consumePendingOpenFiles: () => Promise<string[]>;
  getDroppedFilePaths: (files: unknown[]) => string[];
  getSmartPlaylistRules: () => Promise<SmartPlaylistRule[]>;
  getSuggestedSmartPlaylistRules: () => Promise<SmartPlaylistSuggestion[]>;
  getDiscoverSurface: (input?: DiscoverSurfaceInput) => Promise<DiscoverSurface>;
  saveSmartPlaylistRule: (input: SmartPlaylistRuleInput) => Promise<SmartPlaylistRule>;
  deleteSmartPlaylistRule: (id: number) => Promise<void>;
  runSmartPlaylistRule: (input: number | SmartPlaylistRuleInput) => Promise<Track[]>;
  listTagRules: () => Promise<TagRule[]>;
  saveTagRule: (input: TagRuleInput) => Promise<TagRule>;
  deleteTagRule: (id: number) => Promise<void>;
  setTagRuleEnabled: (id: number, enabled: boolean) => Promise<TagRule | null>;
  recomputeTags: (opts?: TagRecomputeOptions) => Promise<TagRecomputeResult>;
  getTagsForTrack: (id: number) => Promise<string[]>;
  getTagSummaries: () => Promise<TagSummary[]>;
  previewTagRule: (input: TagRulePreviewInput) => Promise<TagRulePreviewResult>;
  getTrackIdsByTag: (name: string) => Promise<number[]>;
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
  getWrappedStats: (opts?: { range?: WrappedRange; now?: number }) => Promise<WrappedStats>;
  getReviews: (target?: { type: ReviewTargetType; key: string }) => Promise<Review[]>;
  saveReview: (input: ReviewInput) => Promise<Review>;
  deleteReview: (id: number) => Promise<void>;
  getLists: () => Promise<ListSummary[]>;
  getList: (id: number) => Promise<ListDetail | null>;
  saveList: (input: ListInput) => Promise<ListSummary>;
  deleteList: (id: number) => Promise<void>;
  addListItem: (input: ListItemInput) => Promise<ListItem>;
  removeListItem: (id: number) => Promise<void>;
  reorderListItems: (listId: number, orderedIds: number[]) => Promise<void>;
  getProfile: () => Promise<UserProfile>;
  saveProfile: (input: UserProfileInput) => Promise<UserProfile>;
  exportProfileBundle: () => Promise<string | null>;
  clearListeningHistory: () => Promise<void>;
  getTrackBookmarks: (trackId: number) => Promise<TrackBookmark[]>;
  saveTrackBookmark: (input: SaveTrackBookmarkInput) => Promise<TrackBookmark>;
  deleteTrackBookmark: (id: number) => Promise<void>;
  toggleLove: (id: number) => Promise<boolean>;
  setTrackRating: (id: number, rating: number) => Promise<Track | null>;
  setTrackRatingScore: (id: number, score: number | null) => Promise<Track | null>;
  setAlbumRatingScore: (
    albumArtist: string,
    album: string,
    score: number | null,
  ) => Promise<AlbumRating | null>;
  getAlbumRating: (albumArtist: string, album: string) => Promise<AlbumRating | null>;
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

  // bit-perfect exclusive output (native WASAPI, Windows)
  exclusiveSupported: () => Promise<boolean>;
  exclusiveListDevices: () => Promise<ExclusiveDeviceInfo[]>;
  exclusivePlay: (trackId: number, startAt?: number) => Promise<ExclusivePlayResult>;
  exclusivePause: () => Promise<void>;
  exclusiveResume: () => Promise<void>;
  exclusiveStop: () => Promise<void>;
  exclusiveSeek: (seconds: number) => Promise<void>;
  exclusivePrepareNext: (trackId: number | null) => Promise<void>;
  onExclusiveEvent: (cb: (payload: ExclusiveEventPayload) => void) => () => void;
  onExclusiveTap: (
    cb: (tap: { pcm: Float32Array; channels: number; sampleRate: number }) => void,
  ) => () => void;

  platform: string;
  appVersion: string;
}

declare global {
  interface Window {
    newamp: NewAmpAPI;
  }
}
