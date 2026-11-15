import type {
  AlbumArtLookupInput,
  AlbumArtLookupResult,
  MetadataLookupCandidate,
  Track,
} from '../shared/types.js';
import { NEWAMP_REPO_USER_AGENT } from '../shared/app-version.js';

const MUSICBRAINZ_ROOT = 'https://musicbrainz.org/ws/2/recording';
const MUSICBRAINZ_RELEASE_GROUP_ROOT = 'https://musicbrainz.org/ws/2/release-group';
const COVER_ART_RELEASE_GROUP_ROOT = 'https://coverartarchive.org/release-group';
const MUSICBRAINZ_USER_AGENT = NEWAMP_REPO_USER_AGENT;
const MIN_REQUEST_SPACING_MS = 1100;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_MS = 10_000;
const MAX_COVER_ART_BYTES = 8 * 1024 * 1024;
const MUSICBRAINZ_HOST = 'musicbrainz.org';
const COVER_ART_ALLOWED_HOSTS = ['coverartarchive.org', 'archive.org'];
const COVER_ART_ALLOWED_SUFFIXES = ['.coverartarchive.org', '.archive.org'];

let lastMusicBrainzRequestAt = 0;
// Requests take their turn here, so a second lookup that arrives while the
// first is still waiting out the spacing waits behind it instead of firing
// at the same moment.
let requestQueueTail: Promise<void> = Promise.resolve();

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  headers?: { get: (name: string) => string | null };
  body?: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<void> } } | null;
  url?: string;
};

type FetchImpl = (
  input: string | URL,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
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

  const limit = Math.max(1, Math.min(10, Math.trunc(options.limit ?? 5)));
  const query = buildRecordingQuery(track);
  if (!query) return [];

  const url = new URL(MUSICBRAINZ_ROOT);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fmt', 'json');

  const response = await fetchMusicBrainz(url.toString(), fetchImpl, options);

  if (!response.ok) throw await musicBrainzFailure('MusicBrainz lookup failed', response);

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

  const limit = Math.max(1, Math.min(8, Math.trunc(options.limit ?? 5)));
  const query = buildReleaseGroupQuery(input);
  if (!query) return [];

  const url = new URL(MUSICBRAINZ_RELEASE_GROUP_ROOT);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fmt', 'json');

  const response = await fetchMusicBrainz(url.toString(), fetchImpl, options);
  if (!response.ok) throw await musicBrainzFailure('MusicBrainz album lookup failed', response);

  const data = await response.json();
  const groups = Array.isArray((data as { 'release-groups'?: unknown })['release-groups'])
    ? ((data as { 'release-groups': unknown[] })['release-groups'] as MusicBrainzReleaseGroup[])
    : [];
  const candidates: AlbumArtLookupResult[] = [];
  for (const group of groups) {
    const base = releaseGroupToAlbumArtCandidate(group);
    if (!base) continue;
    let art: Awaited<ReturnType<typeof lookupCoverArt>>;
    try {
      art = await lookupCoverArt(base.releaseGroupId, fetchImpl, options.userAgent ?? MUSICBRAINZ_USER_AGENT);
    } catch (err) {
      // The archive stopped answering partway through: the covers already found
      // are kept, and only a search that found none reports the failure.
      if (!candidates.length) throw err;
      break;
    }
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

  const userAgent = options.userAgent ?? MUSICBRAINZ_USER_AGENT;
  const preferredUrl = requireCoverArtDownloadUrl(candidate);
  // The large thumbnail is preferred; a release that doesn't have one stored,
  // or whose copy is too big to cache, falls back to the 500 px size.
  const smallerUrl = smallerCoverArtUrl(preferredUrl);
  let failure: Error | null = null;
  for (const sourceUrl of smallerUrl ? [preferredUrl, smallerUrl] : [preferredUrl]) {
    const response = await fetchCoverArt(sourceUrl, fetchImpl, userAgent);
    if (!response.ok || (!response.arrayBuffer && !response.body)) {
      const detail = response.text ? await response.text().catch(() => '') : '';
      failure = new Error(`Cover art download failed (${response.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
      continue;
    }
    const declaredMime = mimeFromResponse(response, sourceUrl);
    let data: Buffer;
    try {
      data = await readCappedBody(response, MAX_COVER_ART_BYTES);
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
      continue;
    }
    if (data.byteLength < 256) throw new Error('Cover art download returned an empty image.');
    const mime = sniffImageMime(data);
    if (!mime) throw new Error(`Cover art download is not a JPEG, PNG or WebP image (${declaredMime}).`);
    return { candidate, mime, data, sourceUrl };
  }
  throw failure ?? new Error('Cover art download failed.');
}

async function fetchCoverArt(url: string, fetchImpl: FetchImpl, userAgent: string): Promise<FetchResponse> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'image/*',
      'User-Agent': userAgent,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assertCoverArtHost(response);
  return response;
}

// The CAA answers with a redirect to archive.org; wherever a request ended
// up has to be on the same list as the address it started from.
function assertCoverArtHost(response: FetchResponse): void {
  if (response.url && !normalizeCoverArtUrl(response.url)) {
    throw new Error('Cover art came from a host that is not allowed.');
  }
}

function smallerCoverArtUrl(url: string): string | null {
  return /-1200\.(jpe?g|png|webp)(?:$|\?)/i.test(url) ? url.replace(/-1200\./, '-500.') : null;
}

// At most `limit` bytes of the body, checked before it is all read: a
// declared length that is too large fails at once and a stream that runs
// over is cut off.
async function readCappedBody(response: FetchResponse, limit: number): Promise<Buffer> {
  const tooLarge = () => new Error('Cover art image is too large to cache.');
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  const reader = response.body?.getReader();
  if (!reader) {
    const data = Buffer.from(await response.arrayBuffer!());
    if (data.byteLength > limit) throw tooLarge();
    return data;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// What the bytes are, not what the server said they were.
function sniffImageMime(data: Buffer): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

// One MusicBrainz request, after its turn. The service allows one request a
// second; when it still answers 503 or 429 it is asked again once, after the
// time it names.
async function fetchMusicBrainz(
  url: string,
  fetchImpl: FetchImpl,
  options: MusicBrainzLookupOptions,
): Promise<FetchResponse> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    await waitForMusicBrainzTurn(options);
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': options.userAgent ?? MUSICBRAINZ_USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if ((response.status === 503 || response.status === 429) && attempt === 0) {
      await response.text?.().catch(() => '');
      await sleep(retryAfterMs(response));
      continue;
    }
    if (response.url) {
      let host = '';
      try {
        host = new URL(response.url).hostname.toLowerCase();
      } catch {
        /* an unparseable address fails the check below */
      }
      if (host !== MUSICBRAINZ_HOST && !host.endsWith(`.${MUSICBRAINZ_HOST}`)) {
        throw new Error('MusicBrainz answered from a host that is not allowed.');
      }
    }
    return response;
  }
}

// Waits until this request may go out and records the time it did, one
// request at a time.
async function waitForMusicBrainzTurn(options: MusicBrainzLookupOptions): Promise<void> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const getLastRequestAt = options.lastRequestAt ?? (() => lastMusicBrainzRequestAt);
  const setLastRequestAt = options.setLastRequestAt ?? ((value: number) => {
    lastMusicBrainzRequestAt = value;
  });
  const previous = requestQueueTail;
  let release: () => void = () => {};
  requestQueueTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const waitMs = Math.max(0, MIN_REQUEST_SPACING_MS - (now() - getLastRequestAt()));
    if (waitMs > 0) await sleep(waitMs);
    setLastRequestAt(now());
  } finally {
    release();
  }
}

function retryAfterMs(response: FetchResponse): number {
  const header = response.headers?.get('retry-after')?.trim();
  const seconds = header ? Number(header) : NaN;
  const waitMs = Number.isFinite(seconds)
    ? seconds * 1000
    : header && Number.isFinite(Date.parse(header))
      ? Date.parse(header) - Date.now()
      : MIN_REQUEST_SPACING_MS * 2;
  return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, waitMs));
}

async function musicBrainzFailure(what: string, response: FetchResponse): Promise<Error> {
  if (response.status === 503 || response.status === 429) {
    return new Error(`MusicBrainz is busy right now (${response.status}). Try again in a minute.`);
  }
  const detail = response.text ? await response.text().catch(() => '') : '';
  return new Error(`${what} (${response.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assertCoverArtHost(response);
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
      normalizeCoverArtUrl(thumbnails['1200']) ||
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
