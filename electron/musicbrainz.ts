import type {
  AlbumArtLookupInput,
  AlbumArtLookupResult,
  MetadataLookupCandidate,
  Track,
} from '../shared/types.js';

const MUSICBRAINZ_ROOT = 'https://musicbrainz.org/ws/2/recording';
const MUSICBRAINZ_RELEASE_GROUP_ROOT = 'https://musicbrainz.org/ws/2/release-group';
const COVER_ART_RELEASE_GROUP_ROOT = 'https://coverartarchive.org/release-group';
const MUSICBRAINZ_USER_AGENT = 'Newamp/0.1.0 (https://github.com/evilander/newamp)';
const MIN_REQUEST_SPACING_MS = 1100;
const COVER_ART_ALLOWED_HOSTS = ['coverartarchive.org', 'archive.org'];
const COVER_ART_ALLOWED_SUFFIXES = ['.coverartarchive.org', '.archive.org'];

let lastMusicBrainzRequestAt = 0;

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  headers?: { get: (name: string) => string | null };
};

type FetchImpl = (
  input: string | URL,
  init?: { headers?: Record<string, string> },
) => Promise<FetchResponse>;

export interface MusicBrainzLookupOptions {
  fetchImpl?: FetchImpl;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  lastRequestAt?: () => number;
  setLastRequestAt?: (value: number) => void;
  limit?: number;
  userAgent?: string;
}

interface MusicBrainzRecording {
  id?: unknown;
  score?: unknown;
  title?: unknown;
  length?: unknown;
  'first-release-date'?: unknown;
  'artist-credit'?: unknown;
  releases?: unknown;
}

interface MusicBrainzRelease {
  id?: unknown;
  title?: unknown;
  date?: unknown;
  'artist-credit'?: unknown;
}

interface MusicBrainzReleaseGroup {
  id?: unknown;
  score?: unknown;
  title?: unknown;
  'artist-credit'?: unknown;
  'first-release-date'?: unknown;
  'primary-type'?: unknown;
}

interface CoverArtArchiveImage {
  image?: unknown;
  thumbnails?: unknown;
  front?: unknown;
  approved?: unknown;
  types?: unknown;
}

interface CoverArtArchivePayload {
  images?: unknown;
}

export interface AlbumArtImagePayload {
  candidate: AlbumArtLookupResult;
  mime: string;
  data: Buffer;
  sourceUrl: string;
}

export async function searchMusicBrainzMetadata(
  track: Track,
  options: MusicBrainzLookupOptions = {},
): Promise<MetadataLookupCandidate[]> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  if (!fetchImpl) throw new Error('MusicBrainz lookup requires fetch support.');

  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const getLastRequestAt = options.lastRequestAt ?? (() => lastMusicBrainzRequestAt);
  const setLastRequestAt = options.setLastRequestAt ?? ((value: number) => {
    lastMusicBrainzRequestAt = value;
  });

  const limit = Math.max(1, Math.min(10, Math.trunc(options.limit ?? 5)));
  const query = buildRecordingQuery(track);
  if (!query) return [];

  const waitMs = Math.max(0, MIN_REQUEST_SPACING_MS - (now() - getLastRequestAt()));
  if (waitMs > 0) await sleep(waitMs);
  setLastRequestAt(now());

  const url = new URL(MUSICBRAINZ_ROOT);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fmt', 'json');

  const response = await fetchImpl(url.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': options.userAgent ?? MUSICBRAINZ_USER_AGENT,
    },
  });

  if (!response.ok) {
    const detail = response.text ? await response.text().catch(() => '') : '';
    throw new Error(`MusicBrainz lookup failed (${response.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
  }

  const data = await response.json();
  const rows = Array.isArray((data as { recordings?: unknown }).recordings)
    ? ((data as { recordings: unknown[] }).recordings as MusicBrainzRecording[])
    : [];

  return dedupeCandidates(rows.map(recordingToCandidate).filter(Boolean) as MetadataLookupCandidate[])
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function searchAlbumArt(
  input: AlbumArtLookupInput,
  options: MusicBrainzLookupOptions = {},
): Promise<AlbumArtLookupResult[]> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  if (!fetchImpl) throw new Error('Album art lookup requires fetch support.');

  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const getLastRequestAt = options.lastRequestAt ?? (() => lastMusicBrainzRequestAt);
  const setLastRequestAt = options.setLastRequestAt ?? ((value: number) => {
    lastMusicBrainzRequestAt = value;
  });
  const limit = Math.max(1, Math.min(8, Math.trunc(options.limit ?? 5)));
  const query = buildReleaseGroupQuery(input);
  if (!query) return [];

  const waitMs = Math.max(0, MIN_REQUEST_SPACING_MS - (now() - getLastRequestAt()));
  if (waitMs > 0) await sleep(waitMs);
  setLastRequestAt(now());

  const url = new URL(MUSICBRAINZ_RELEASE_GROUP_ROOT);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fmt', 'json');

  const response = await fetchImpl(url.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': options.userAgent ?? MUSICBRAINZ_USER_AGENT,
    },
  });
  if (!response.ok) {
    const detail = response.text ? await response.text().catch(() => '') : '';
    throw new Error(`MusicBrainz album lookup failed (${response.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
  }

  const data = await response.json();
  const groups = Array.isArray((data as { 'release-groups'?: unknown })['release-groups'])
    ? ((data as { 'release-groups': unknown[] })['release-groups'] as MusicBrainzReleaseGroup[])
    : [];
  const candidates: AlbumArtLookupResult[] = [];
  for (const group of groups) {
    const base = releaseGroupToAlbumArtCandidate(group);
    if (!base) continue;
    const art = await lookupCoverArt(base.releaseGroupId, fetchImpl, options.userAgent ?? MUSICBRAINZ_USER_AGENT);
    if (!art) continue;
    candidates.push({ ...base, imageUrl: art.imageUrl, thumbnailUrl: art.thumbnailUrl });
    if (candidates.length >= limit) break;
  }
  return dedupeAlbumArtCandidates(candidates).sort((a, b) => b.score - a.score);
}

export async function fetchAlbumArtImage(
  candidate: AlbumArtLookupResult,
  options: MusicBrainzLookupOptions = {},
): Promise<AlbumArtImagePayload> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  if (!fetchImpl) throw new Error('Album art download requires fetch support.');

  const sourceUrl = requireCoverArtDownloadUrl(candidate);
  const response = await fetchImpl(sourceUrl, {
    headers: {
      Accept: 'image/*',
      'User-Agent': options.userAgent ?? MUSICBRAINZ_USER_AGENT,
    },
  });
  if (!response.ok || !response.arrayBuffer) {
    const detail = response.text ? await response.text().catch(() => '') : '';
    throw new Error(`Cover art download failed (${response.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
  }
  const mime = mimeFromResponse(response, sourceUrl);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.byteLength < 256) throw new Error('Cover art download returned an empty image.');
  if (data.byteLength > 8 * 1024 * 1024) throw new Error('Cover art image is too large to cache.');
  return {
    candidate,
    mime,
    data,
    sourceUrl,
  };
}

function buildRecordingQuery(track: Track): string {
  const clauses: string[] = [];
  const title = cleanText(track.title);
  const artist = cleanText(track.artist);
  const album = cleanText(track.album);

  if (title) clauses.push(`recording:${quoteQuery(title)}`);
  if (artist && !isUnknownArtist(artist)) clauses.push(`artistname:${quoteQuery(artist)}`);
  if (album) clauses.push(`release:${quoteQuery(album)}`);
  if (track.duration && Number.isFinite(track.duration)) {
    clauses.push(`qdur:${Math.round((track.duration * 1000) / 2000)}`);
  }

  return clauses.join(' AND ');
}

function buildReleaseGroupQuery(input: AlbumArtLookupInput): string {
  const clauses: string[] = [];
  const album = cleanText(input.album);
  const artist = cleanText(input.albumArtist);
  if (album) clauses.push(`releasegroup:${quoteQuery(album)}`);
  if (artist && !isUnknownArtist(artist)) clauses.push(`artist:${quoteQuery(artist)}`);
  clauses.push('primarytype:album');
  return album ? clauses.join(' AND ') : '';
}

function releaseGroupToAlbumArtCandidate(group: MusicBrainzReleaseGroup): Omit<AlbumArtLookupResult, 'imageUrl' | 'thumbnailUrl'> | null {
  const releaseGroupId = cleanText(group.id);
  const releaseGroupTitle = cleanText(group.title);
  const artist = creditName(group['artist-credit']);
  if (!releaseGroupId || !releaseGroupTitle) return null;
  return {
    source: 'cover-art-archive',
    releaseGroupId,
    releaseGroupTitle,
    artist,
    firstReleaseDate: cleanText(group['first-release-date']) || null,
    primaryType: cleanText(group['primary-type']) || null,
    score: clampScore(group.score),
  };
}

async function lookupCoverArt(
  releaseGroupId: string,
  fetchImpl: FetchImpl,
  userAgent: string,
): Promise<{ imageUrl: string; thumbnailUrl: string | null } | null> {
  const response = await fetchImpl(`${COVER_ART_RELEASE_GROUP_ROOT}/${encodeURIComponent(releaseGroupId)}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': userAgent,
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) return null;
  const data = await response.json().catch(() => null) as CoverArtArchivePayload | null;
  const images = Array.isArray(data?.images) ? data.images as CoverArtArchiveImage[] : [];
  const image = chooseCoverArtImage(images);
  if (!image) return null;
  return image;
}

function chooseCoverArtImage(images: CoverArtArchiveImage[]): { imageUrl: string; thumbnailUrl: string | null } | null {
  const sorted = [...images].sort((a, b) => coverArtRank(b) - coverArtRank(a));
  for (const image of sorted) {
    const imageUrl = normalizeCoverArtUrl(image.image);
    if (!imageUrl) continue;
    const thumbnails = image.thumbnails && typeof image.thumbnails === 'object'
      ? image.thumbnails as Record<string, unknown>
      : {};
    const thumbnailUrl =
      normalizeCoverArtUrl(thumbnails['500']) ||
      normalizeCoverArtUrl(thumbnails.large) ||
      normalizeCoverArtUrl(thumbnails['250']) ||
      normalizeCoverArtUrl(thumbnails.small) ||
      null;
    return { imageUrl, thumbnailUrl };
  }
  return null;
}

function coverArtRank(image: CoverArtArchiveImage): number {
  const types = Array.isArray(image.types) ? image.types.map((type) => cleanText(type).toLowerCase()) : [];
  return (image.front ? 10 : 0) + (types.includes('front') ? 5 : 0) + (image.approved === false ? -2 : 0);
}

function dedupeAlbumArtCandidates(candidates: AlbumArtLookupResult[]): AlbumArtLookupResult[] {
  const seen = new Set<string>();
  const out: AlbumArtLookupResult[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.releaseGroupId)) continue;
    seen.add(candidate.releaseGroupId);
    out.push(candidate);
  }
  return out;
}

function recordingToCandidate(recording: MusicBrainzRecording): MetadataLookupCandidate | null {
  const recordingId = cleanText(recording.id);
  const title = cleanText(recording.title);
  const artist = creditName(recording['artist-credit']);
  const releases = Array.isArray(recording.releases)
    ? (recording.releases as MusicBrainzRelease[])
    : [];
  const release = chooseRelease(releases);
  const album = cleanText(release?.title);
  const albumArtist = creditName(release?.['artist-credit']) || artist;
  const year = parseYear(cleanText(release?.date) || cleanText(recording['first-release-date']));
  const duration = secondsFromMs(recording.length);
  const score = clampScore(recording.score);

  if (!recordingId || !title || !artist) return null;

  return {
    source: 'musicbrainz',
    recordingId,
    releaseId: cleanText(release?.id) || null,
    title,
    artist,
    album,
    albumArtist: albumArtist || artist,
    year,
    trackNo: null,
    discNo: null,
    duration,
    score,
    confidence: score >= 90 ? 'high' : score >= 75 ? 'medium' : 'low',
  };
}

function chooseRelease(releases: MusicBrainzRelease[]): MusicBrainzRelease | null {
  return releases.find((release) => cleanText(release.title) && cleanText(release.date)) ??
    releases.find((release) => cleanText(release.title)) ??
    null;
}

function dedupeCandidates(candidates: MetadataLookupCandidate[]): MetadataLookupCandidate[] {
  const seen = new Set<string>();
  const out: MetadataLookupCandidate[] = [];
  for (const candidate of candidates) {
    const key = [
      candidate.recordingId,
      candidate.releaseId ?? '',
      candidate.title.toLowerCase(),
      candidate.artist.toLowerCase(),
      candidate.album.toLowerCase(),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function creditName(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const item = part as { name?: unknown; artist?: { name?: unknown }; joinphrase?: unknown };
      const name = cleanText(item.name) || cleanText(item.artist?.name);
      const joinphrase = cleanText(item.joinphrase);
      return `${name}${joinphrase}`;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function quoteQuery(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function isUnknownArtist(value: string): boolean {
  return /^(unknown artist|unknown|various)$/i.test(value.trim());
}

function parseYear(value: string): number | null {
  const match = /^(\d{4})/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isFinite(year) && year >= 1877 && year <= 3000 ? year : null;
}

function secondsFromMs(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 1000) : null;
}

function clampScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function mimeFromUrl(url: string): string {
  if (/\.png(?:$|\?)/i.test(url)) return 'image/png';
  if (/\.webp(?:$|\?)/i.test(url)) return 'image/webp';
  return 'image/jpeg';
}

function requireCoverArtDownloadUrl(candidate: AlbumArtLookupResult): string {
  if (candidate.source !== 'cover-art-archive') {
    throw new Error('Unsupported album art source.');
  }
  const sourceUrl = normalizeCoverArtUrl(candidate.thumbnailUrl) || normalizeCoverArtUrl(candidate.imageUrl);
  if (!sourceUrl) throw new Error('Cover art candidate has an unsupported image URL.');
  return sourceUrl;
}

function normalizeCoverArtUrl(value: unknown): string {
  const raw = cleanText(value);
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') return '';
  const hostname = url.hostname.toLowerCase();
  const allowed =
    COVER_ART_ALLOWED_HOSTS.includes(hostname) ||
    COVER_ART_ALLOWED_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  return allowed ? url.toString() : '';
}

function mimeFromResponse(response: FetchResponse, url: string): string {
  const contentType = response.headers?.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType) {
    if (!contentType.startsWith('image/')) {
      throw new Error(`Cover art download returned ${contentType} instead of an image.`);
    }
    return contentType;
  }
  return mimeFromUrl(url);
}
