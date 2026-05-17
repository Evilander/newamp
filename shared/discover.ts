import type {
  DiscoverDeckSkin,
  DiscoverInsightSummary,
  DiscoverMission,
  DiscoverMissionStep,
  DiscoverMixCard,
  DiscoverSurface,
  DiscoverSurfaceInput,
  DiscoverTone,
  DiscoverVisualPlan,
  Track,
  VisualizerPreset,
} from './types.js';

interface DiscoverStats {
  tracks?: number;
  albums?: number;
  artists?: number;
  duration?: number;
}

export interface BuildDiscoverSurfaceInput extends DiscoverSurfaceInput {
  tracks: Track[];
  stats?: DiscoverStats | null;
}

interface AlbumCluster {
  album: string;
  albumArtist: string;
  year: number | null;
  genre: string | null;
  tracks: Track[];
  score: number;
}

const HEAVY_VISUAL_PRESETS = new Set<VisualizerPreset>([
  'neon-waves',
  'neon-ribbons',
  'plasma-grid',
  'burning-cloud',
]);

const LOW_END_PRESETS: VisualizerPreset[] = ['album-breathe', 'oscilloscope', 'spectrum', 'radial', 'pulse'];
const FULL_PRESETS: VisualizerPreset[] = ['album-breathe', 'spectrum', 'oscilloscope', 'radial', 'prism-bars', 'orbital-rings', 'galaxy'];
const DECK_ROTATION: DiscoverDeckSkin[] = ['bento', 'discman', 'winamp-classic', 'record-player', 'cassette', 'retro-tv'];

export function buildDiscoverSurface(input: BuildDiscoverSurfaceInput): DiscoverSurface {
  const generatedAt = normalizeTime(input.now);
  const limit = normalizeLimit(input.limit);
  const seed = normalizeSeed(input.seed, input.tracks, generatedAt);
  const rng = createSeededRandom(seed);
  const tracks = uniqueTracksById(input.tracks)
    .filter((track) => track.path && !track.avoidAutoPlay)
    .map(normalizeTrackForDiscovery);
  const albumClusters = buildAlbumClusters(tracks);

  const freshTracks = tracks
    .filter((track) => track.playCount <= 2)
    .sort((a, b) => b.mtime - a.mtime || compareTrack(a, b))
    .slice(0, limit);

  const forgottenFavorites = tracks
    .filter((track) => isPositiveSignal(track) && staleDays(track, generatedAt) >= 21)
    .map((track) => ({
      track,
      score: positiveSignalScore(track) + staleDays(track, generatedAt) * 0.08 - skipRisk(track) * 8 + stableTrackJitter(track, seed),
    }))
    .sort((a, b) => b.score - a.score || compareTrack(a.track, b.track))
    .slice(0, limit)
    .map((item) => item.track);

  const deepAlbum = albumClusters[0] ?? null;
  const deepAlbumTracks = deepAlbum?.tracks.slice(0, Math.max(3, limit)) ?? [];

  const weirdShelf = tracks
    .filter((track) => track.playCount <= 1)
    .map((track) => ({
      track,
      score: weirdnessScore(track, tracks, generatedAt) + stableTrackJitter(track, seed),
    }))
    .sort((a, b) => b.score - a.score || compareTrack(a.track, b.track))
    .slice(0, limit)
    .map((item) => item.track);

  const visualTracks = seededPick(
    tracks
      .filter((track) => skipRisk(track) < 0.45 && (isPositiveSignal(track) || track.playCount === 0))
      .sort((a, b) => positiveSignalScore(b) - positiveSignalScore(a) || compareTrack(a, b)),
    Math.max(8, limit),
    rng,
  );
  const visualPlan = buildVisualPlan(input.lowEndMode ?? false, seed);

  const cards = [
    buildCard('new-download-radar', 'New Download Radar', 'Fresh imports with room to breathe', 'Newest files NewAmp has seen on disk, biased toward albums you have not worn out yet.', 'accent', freshTracks, visualPlan),
    buildCard('forgotten-favorites', 'Forgotten Favorites', 'Loved signals that have gone quiet', 'Loved and highly rated tracks that have not had recent attention.', 'warn', forgottenFavorites, null),
    buildCard('deep-album-run', deepAlbum ? `Deep Album Run: ${deepAlbum.album}` : 'Deep Album Run', deepAlbum ? `${deepAlbum.albumArtist} / ${deepAlbum.tracks.length} tracks` : 'Full-album candidates', 'Albums with enough playable tracks, low skip risk, and a coherent listening path.', 'plain', deepAlbumTracks, null),
    buildCard('weird-shelf', 'Weird Shelf', 'Underplayed corners worth checking', 'Low-play tracks from less obvious folders, years, genres, or private-library edges.', 'accent', weirdShelf, null),
    buildCard('visual-night', 'Visual Night', input.lowEndMode ? 'Low-load visual set' : 'Fullscreen visual set', 'A ready listening set paired to deck and visualizer choices.', 'warn', visualTracks, visualPlan),
  ].filter((card) => card.tracks.length > 0);

  const missions = buildMissions({
    freshTracks,
    forgottenFavorites,
    deepAlbum,
    deepAlbumTracks,
    weirdShelf,
    visualTracks,
    visualPlan,
  });

  return {
    modeName: 'Living Library',
    generatedAt,
    seed,
    summary: buildSummary(input.stats, tracks, freshTracks, forgottenFavorites, albumClusters),
    cards,
    missions,
  };
}

function buildMissions(input: {
  freshTracks: Track[];
  forgottenFavorites: Track[];
  deepAlbum: AlbumCluster | null;
  deepAlbumTracks: Track[];
  weirdShelf: Track[];
  visualTracks: Track[];
  visualPlan: DiscoverVisualPlan;
}): DiscoverMission[] {
  const missions: DiscoverMission[] = [];
  const dailySteps = compactSteps([
    buildStep('fresh-start', 'Start with something new', 'Open with fresh files NewAmp has barely seen.', 'Play fresh openers', input.freshTracks.slice(0, 3)),
    buildStep('lost-signal', 'Recover a favorite', 'Pull a strong loved or rated signal back into rotation.', 'Play recovered favorites', input.forgottenFavorites.slice(0, 3)),
    buildStep('odd-corner', 'Check the weird shelf', 'End with an underplayed corner of the library.', 'Play weird shelf', input.weirdShelf.slice(0, 3)),
  ]);
  if (dailySteps.length) {
    missions.push(buildMission(
      'daily-crate',
      'Daily Crate Mission',
      'A fast crate-digging route through new, loved, and overlooked music.',
      'Built to answer the hardest local-library question: what should I play right now?',
      'accent',
      dailySteps,
      null,
    ));
  }

  if (input.deepAlbum && input.deepAlbumTracks.length >= 3) {
    missions.push(buildMission(
      'album-session',
      `Album Session: ${input.deepAlbum.album}`,
      `${input.deepAlbum.albumArtist} / ${input.deepAlbum.year ?? 'year unknown'}`,
      'A full-album path selected for track count, ratings, and low skip pressure.',
      'plain',
      [buildStep('album-run', 'Play the album lane', 'Let the album play as a focused block.', 'Play album run', input.deepAlbumTracks)],
      null,
    ));
  }

  if (input.visualTracks.length) {
    missions.push(buildMission(
      'visual-night',
      'Visual Night',
      input.visualPlan.lowEndMode ? 'Low-load fullscreen session' : 'Fullscreen visual session',
      'Pairs a playable set with visualizer presets and a deck skin instead of leaving visuals as a separate toy.',
      'warn',
      compactSteps([
        buildStep('visual-open', 'Start the visual set', 'Queue the first wave and open fullscreen visuals.', 'Play visual set', input.visualTracks.slice(0, 8)),
        buildStep('visual-extend', 'Keep the room moving', 'Add the remaining visual-safe tracks after the opener.', 'Queue visual tail', input.visualTracks.slice(8, 16)),
      ]),
      input.visualPlan,
    ));
  }

  return missions;
}

function buildSummary(
  stats: DiscoverStats | null | undefined,
  tracks: Track[],
  freshTracks: Track[],
  forgottenFavorites: Track[],
  albumClusters: AlbumCluster[],
): DiscoverInsightSummary {
  const artists = new Set(tracks.map((track) => track.artist.toLowerCase()).filter(Boolean));
  return {
    trackCount: stats?.tracks ?? tracks.length,
    albumCount: stats?.albums ?? albumClusters.length,
    artistCount: stats?.artists ?? artists.size,
    lovedCount: tracks.filter((track) => track.loved).length,
    highRatedCount: tracks.filter((track) => ratingScore(track) >= 80).length,
    unplayedCount: tracks.filter((track) => track.playCount <= 0).length,
    recentlyAddedCount: freshTracks.length,
    forgottenFavoriteCount: forgottenFavorites.length,
  };
}

function buildVisualPlan(lowEndMode: boolean, seed: string): DiscoverVisualPlan {
  const presets = lowEndMode
    ? LOW_END_PRESETS.filter((preset) => !HEAVY_VISUAL_PRESETS.has(preset))
    : FULL_PRESETS;
  const deckSkin = DECK_ROTATION[Math.abs(hashString(`${seed}:deck`)) % DECK_ROTATION.length] ?? 'bento';
  return {
    title: lowEndMode ? 'Low-Load Visual Set' : 'Fullscreen Visual Set',
    subtitle: lowEndMode ? 'Album breathe, scope, and spectrum first' : '4K-ready presets with album cover intervals',
    presets: presets.slice(0, 5),
    deckSkin,
    lowEndMode,
    albumOverlay: true,
  };
}

function buildCard(
  id: string,
  title: string,
  subtitle: string,
  reason: string,
  tone: DiscoverTone,
  tracks: Track[],
  visualPlan: DiscoverVisualPlan | null,
): DiscoverMixCard {
  const duration = tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0);
  return {
    id,
    title,
    subtitle,
    reason,
    tone,
    tracks: uniqueTracksById(tracks),
    scoreLabel: `${tracks.length} tracks / ${formatHours(duration)}`,
    visualPlan,
  };
}

function buildMission(
  id: string,
  title: string,
  subtitle: string,
  reason: string,
  tone: DiscoverTone,
  steps: DiscoverMissionStep[],
  visualPlan: DiscoverVisualPlan | null,
): DiscoverMission {
  const tracks = uniqueTracksById(steps.flatMap((step) => step.tracks));
  return { id, title, subtitle, reason, tone, steps, tracks, visualPlan };
}

function buildStep(
  id: string,
  title: string,
  instruction: string,
  actionLabel: string,
  tracks: Track[],
): DiscoverMissionStep {
  return { id, title, instruction, actionLabel, tracks: uniqueTracksById(tracks) };
}

function compactSteps(steps: DiscoverMissionStep[]): DiscoverMissionStep[] {
  return steps.filter((step) => step.tracks.length > 0);
}

function buildAlbumClusters(tracks: Track[]): AlbumCluster[] {
  const groups = new Map<string, AlbumCluster>();
  for (const track of tracks) {
    const album = cleanText(track.album) || 'Unknown Album';
    const albumArtist = cleanText(track.albumArtist) || cleanText(track.artist) || 'Unknown Artist';
    const key = `${albumArtist.toLowerCase()}\u0000${album.toLowerCase()}`;
    const current = groups.get(key) ?? {
      album,
      albumArtist,
      year: track.year,
      genre: track.genre,
      tracks: [],
      score: 0,
    };
    current.tracks.push(track);
    current.year ??= track.year;
    current.genre ??= track.genre;
    groups.set(key, current);
  }

  return [...groups.values()]
    .map((album) => {
      const tracksByDisc = [...album.tracks].sort((a, b) =>
        (a.discNo ?? 1) - (b.discNo ?? 1) ||
        (a.trackNo ?? 999) - (b.trackNo ?? 999) ||
        compareTrack(a, b),
      );
      const avgRating = average(tracksByDisc.map(ratingScore));
      const avgSkipRisk = average(tracksByDisc.map(skipRisk));
      const unplayedShare = tracksByDisc.filter((track) => track.playCount <= 0).length / Math.max(1, tracksByDisc.length);
      return {
        ...album,
        tracks: tracksByDisc,
        score: tracksByDisc.length * 5 + avgRating * 0.2 + unplayedShare * 12 - avgSkipRisk * 20,
      };
    })
    .filter((album) => album.tracks.length >= 3)
    .sort((a, b) => b.score - a.score || a.albumArtist.localeCompare(b.albumArtist) || a.album.localeCompare(b.album));
}

function normalizeTrackForDiscovery(track: Track): Track {
  return {
    ...track,
    artist: cleanText(track.artist) || 'Unknown Artist',
    album: cleanText(track.album) || 'Unknown Album',
    albumArtist: cleanText(track.albumArtist) || cleanText(track.artist) || 'Unknown Artist',
    title: cleanText(track.title) || 'Untitled',
  };
}

function isPositiveSignal(track: Track): boolean {
  return !!track.loved || ratingScore(track) >= 75 || track.playCount >= 4;
}

function positiveSignalScore(track: Track): number {
  return ratingScore(track) + (track.loved ? 25 : 0) + Math.min(20, track.playCount * 3);
}

function weirdnessScore(track: Track, tracks: Track[], now: number): number {
  const genreCount = track.genre
    ? tracks.filter((item) => (item.genre ?? '').toLowerCase() === track.genre!.toLowerCase()).length
    : 1;
  const yearDistance = track.year ? Math.min(20, Math.abs(new Date(now).getUTCFullYear() - track.year) / 2) : 8;
  const privateLibrarySignal = /home|demo|private|field|basement|recording|voice|memo/i.test(`${track.genre ?? ''} ${track.album} ${track.artist}`) ? 18 : 0;
  return 30 - Math.min(18, genreCount) + yearDistance + privateLibrarySignal + (track.playCount <= 0 ? 10 : 0);
}

function skipRisk(track: Track): number {
  return track.skipCount / Math.max(1, track.playCount + track.skipCount);
}

function staleDays(track: Track, now: number): number {
  if (!track.lastPlayed) return 999;
  return Math.max(0, (now - track.lastPlayed) / 86400000);
}

function ratingScore(track: Track): number {
  return track.ratingScore ?? track.rating * 20;
}

function normalizeLimit(limit: number | null | undefined): number {
  if (!Number.isFinite(limit ?? NaN)) return 12;
  return Math.max(4, Math.min(40, Math.trunc(limit!)));
}

function normalizeTime(now: number | null | undefined): number {
  return Number.isFinite(now ?? NaN) ? Math.max(0, Math.trunc(now!)) : Date.now();
}

function normalizeSeed(seed: string | null | undefined, tracks: Track[], now: number): string {
  const trimmed = seed?.trim();
  if (trimmed) return trimmed;
  const day = new Date(now).toISOString().slice(0, 10);
  const maxMtime = tracks.reduce((max, track) => Math.max(max, track.mtime), 0);
  return `${day}:${tracks.length}:${maxMtime}`;
}

function uniqueTracksById(tracks: Track[]): Track[] {
  const seen = new Set<number>();
  const out: Track[] = [];
  for (const track of tracks) {
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    out.push(track);
  }
  return out;
}

function seededPick<T>(items: T[], count: number, rng: () => number): T[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
}

function createSeededRandom(seed: string): () => number {
  let state = hashString(seed) || 1;
  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    return ((state >>> 0) / 4294967296);
  };
}

function stableTrackJitter(track: Track, seed: string): number {
  return (Math.abs(hashString(`${seed}:${track.id}`)) % 1000) / 1000;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

function compareTrack(a: Track, b: Track): number {
  return (a.artist || '').localeCompare(b.artist || '') ||
    (a.album || '').localeCompare(b.album || '') ||
    (a.trackNo ?? 999) - (b.trackNo ?? 999) ||
    (a.title || '').localeCompare(b.title || '');
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function formatHours(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}
