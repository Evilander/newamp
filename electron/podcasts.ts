import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import type { PodcastEpisode, PodcastFeed, PodcastProgressInput, PodcastSubscription } from '../shared/types.js';
import { NEWAMP_USER_AGENT } from '../shared/app-version.js';

export interface ParsedPodcastFeed {
  feed: PodcastFeed;
  episodes: PodcastEpisode[];
}

interface PodcastStoreFile {
  subscriptions: PodcastSubscription[];
}

const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_EPISODE_BYTES = 750 * 1024 * 1024;

export class PodcastStore {
  private data: PodcastStoreFile = { subscriptions: [] };

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.load();
  }

  listSubscriptions(): PodcastSubscription[] {
    return this.data.subscriptions.map((subscription) => ({
      feed: { ...subscription.feed },
      episodes: subscription.episodes.map((episode) => ({ ...episode })),
    }));
  }

  get(url: string): PodcastSubscription | null {
    const normalized = normalizeFeedUrl(url);
    return this.listSubscriptions().find((subscription) => subscription.feed.url === normalized) ?? null;
  }

  upsert(feed: PodcastFeed, episodes: PodcastEpisode[]): PodcastSubscription {
    const existing = this.data.subscriptions.find((subscription) => subscription.feed.url === feed.url);
    const progressById = new Map(
      (existing?.episodes ?? []).map((episode) => [
        episode.id,
        {
          progressSeconds: episode.progressSeconds,
          completed: episode.completed,
          lastPlayedAt: episode.lastPlayedAt,
          downloadPath: episode.downloadPath,
          downloadedAt: episode.downloadedAt,
          downloadBytes: episode.downloadBytes,
        },
      ]),
    );
    const next: PodcastSubscription = {
      feed: { ...feed, episodeCount: episodes.length },
      episodes: episodes.map((episode) => ({ ...episode, ...progressById.get(episode.id) })),
    };
    const index = this.data.subscriptions.findIndex((subscription) => subscription.feed.url === feed.url);
    if (index >= 0) this.data.subscriptions[index] = next;
    else this.data.subscriptions.unshift(next);
    this.persist();
    return {
      feed: { ...next.feed },
      episodes: next.episodes.map((episode) => ({ ...episode })),
    };
  }

  remove(url: string): void {
    const normalized = normalizeFeedUrl(url);
    this.data.subscriptions = this.data.subscriptions.filter((subscription) => subscription.feed.url !== normalized);
    this.persist();
  }

  updateProgress(input: PodcastProgressInput & { updatedAt?: number }): PodcastEpisode | null {
    const feedUrl = normalizeFeedUrl(input.feedUrl);
    const subscription = this.data.subscriptions.find((item) => item.feed.url === feedUrl);
    if (!subscription) return null;
    const episode = subscription.episodes.find((item) => item.id === input.episodeId);
    if (!episode) return null;

    const duration = Number.isFinite(input.duration ?? NaN)
      ? Math.max(0, Number(input.duration))
      : episode.duration;
    const completed = input.completed === true || (
      !!duration &&
      duration > 0 &&
      Math.max(0, Number(input.position) || 0) >= duration * 0.98
    );
    episode.completed = completed;
    episode.progressSeconds = completed ? 0 : Math.max(0, Math.trunc(Number(input.position) || 0));
    episode.lastPlayedAt = Math.max(0, Math.trunc(Number(input.updatedAt ?? Date.now()) || Date.now()));
    if (duration && !episode.duration) episode.duration = Math.trunc(duration);
    this.persist();
    return { ...episode };
  }

  markDownloaded(input: {
    feedUrl: string;
    episodeId: string;
    downloadPath: string;
    downloadBytes: number;
    downloadedAt?: number;
  }): PodcastEpisode | null {
    const episode = this.findEpisode(input.feedUrl, input.episodeId);
    if (!episode) return null;
    episode.downloadPath = input.downloadPath;
    episode.downloadBytes = Math.max(0, Math.trunc(Number(input.downloadBytes) || 0));
    episode.downloadedAt = Math.max(0, Math.trunc(Number(input.downloadedAt ?? Date.now()) || Date.now()));
    this.persist();
    return { ...episode };
  }

  clearDownload(feedUrl: string, episodeId: string): PodcastEpisode | null {
    const episode = this.findEpisode(feedUrl, episodeId);
    if (!episode) return null;
    const downloadPath = episode.downloadPath;
    episode.downloadPath = null;
    episode.downloadBytes = null;
    episode.downloadedAt = null;
    this.persist();
    if (downloadPath) {
      try {
        rmSync(downloadPath, { force: true });
      } catch {
        /* ignore */
      }
    }
    return { ...episode };
  }

  private findEpisode(feedUrl: string, episodeId: string): PodcastEpisode | null {
    const normalized = normalizeFeedUrl(feedUrl);
    const subscription = this.data.subscriptions.find((item) => item.feed.url === normalized);
    return subscription?.episodes.find((episode) => episode.id === episodeId) ?? null;
  }

  private load(): void {
    if (!existsSync(this.file)) {
      this.persist();
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PodcastStoreFile>;
      this.data = {
        subscriptions: Array.isArray(parsed.subscriptions)
          ? parsed.subscriptions.map(normalizeSubscription).filter((item): item is PodcastSubscription => !!item)
          : [],
      };
    } catch {
      this.data = { subscriptions: [] };
      this.persist();
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }
}

export async function fetchPodcastSubscription(url: string): Promise<PodcastSubscription> {
  const normalized = normalizeFeedUrl(url);
  const response = await fetchWithHostGuard(normalized, {
    headers: {
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
      'User-Agent': `${NEWAMP_USER_AGENT} podcast client`,
    },
  });
  if (!response.ok) throw new Error(`Podcast feed request failed: HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_FEED_BYTES) throw new Error('Podcast feed is too large.');
  // response.text() enforces MAX_FEED_BYTES itself while the body streams in,
  // so a server that lies about (or omits) Content-Length can't get the
  // whole feed fully materialized before we notice — see fetchWithHostGuard.
  const xml = await response.text(MAX_FEED_BYTES);
  return parsePodcastFeed(xml, normalized);
}

export async function downloadPodcastEpisode(
  store: PodcastStore,
  input: {
    feedUrl: string;
    episodeId: string;
    downloadsPath: string;
    downloadedAt?: number;
  },
): Promise<PodcastEpisode | null> {
  const episode = store
    .get(input.feedUrl)
    ?.episodes.find((item) => item.id === input.episodeId);
  if (!episode) return null;

  const downloadsRoot = resolve(input.downloadsPath);
  const targetDir = join(downloadsRoot, stableId(input.feedUrl));
  await mkdir(targetDir, { recursive: true });
  const targetPath = join(targetDir, `${episode.id}${audioExtension(episode.audioUrl)}`);
  ensureInside(downloadsRoot, targetPath);
  const partPath = `${targetPath}.part`;

  const response = await fetchWithHostGuard(episode.audioUrl, {
    headers: { 'User-Agent': `${NEWAMP_USER_AGENT} podcast downloader` },
    timeoutMs: EPISODE_DOWNLOAD_TIMEOUT_MS,
  });
  if (!response.ok) throw new Error(`Podcast episode download failed: HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_EPISODE_BYTES) throw new Error('Podcast episode is too large to download.');

  try {
    // Streams straight to `<final>.part`, enforcing MAX_EPISODE_BYTES as
    // bytes arrive (Content-Length above is only an early-rejection hint —
    // a server can lie about it), and fsyncs before we ever rename it into
    // place. Any failure here leaves nothing at partPath.
    await response.saveToFile(partPath, MAX_EPISODE_BYTES);
    await rename(partPath, targetPath);
  } catch (err) {
    await unlink(partPath).catch(() => {});
    throw err;
  }

  const info = await stat(targetPath);
  return store.markDownloaded({
    feedUrl: input.feedUrl,
    episodeId: input.episodeId,
    downloadPath: targetPath,
    downloadBytes: info.size,
    downloadedAt: input.downloadedAt,
  });
}

export function parsePodcastFeed(xml: string, feedUrl: string, fetchedAt = Date.now()): PodcastSubscription {
  const normalizedFeedUrl = normalizeFeedUrl(feedUrl);
  const channelXml = firstMatch(xml, /<channel\b[^>]*>([\s\S]*?)<\/channel>/i) ?? xml;
  const title = textOf(channelXml, 'title') || hostnameTitle(normalizedFeedUrl);
  const imageUrl = attributeOf(channelXml, 'itunes:image', 'href') ?? textOf(firstMatch(channelXml, /<image\b[^>]*>([\s\S]*?)<\/image>/i) ?? '', 'url');
  const itemBlocks = blocks(channelXml, 'item');
  const atomEntryBlocks = itemBlocks.length ? [] : blocks(xml, 'entry');

  const episodes = (itemBlocks.length ? itemBlocks : atomEntryBlocks)
    .map((itemXml, index) => parseEpisode(itemXml, {
      feedUrl: normalizedFeedUrl,
      feedTitle: title,
      fallbackIndex: index,
      fallbackImageUrl: imageUrl,
      atom: itemBlocks.length === 0,
    }))
    .filter((episode): episode is PodcastEpisode => !!episode)
    .slice(0, 500);

  const feed: PodcastFeed = {
    id: stableId(normalizedFeedUrl),
    url: normalizedFeedUrl,
    title,
    description: textOf(channelXml, 'description') ?? textOf(channelXml, 'subtitle'),
    siteUrl: textOf(channelXml, 'link') ?? attributeOf(xml, 'link', 'href'),
    imageUrl,
    episodeCount: episodes.length,
    lastFetchedAt: Math.max(0, Math.trunc(fetchedAt)),
  };
  return { feed, episodes };
}

function parseEpisode(
  itemXml: string,
  options: { feedUrl: string; feedTitle: string; fallbackIndex: number; fallbackImageUrl: string | null; atom: boolean },
): PodcastEpisode | null {
  const enclosureUrl = attributeOf(itemXml, 'enclosure', 'url');
  const atomAudioUrl = options.atom ? atomAudioLink(itemXml) : null;
  const audioUrl = normalizeMaybeUrl(enclosureUrl ?? atomAudioUrl);
  if (!audioUrl) return null;
  const guid = textOf(itemXml, 'guid') ?? textOf(itemXml, 'id') ?? audioUrl;
  const title = textOf(itemXml, 'title') || `Episode ${options.fallbackIndex + 1}`;
  return {
    id: stableId(`${options.feedUrl}:${guid}`),
    feedUrl: options.feedUrl,
    feedTitle: options.feedTitle,
    title,
    description: textOf(itemXml, 'description') ?? textOf(itemXml, 'summary') ?? textOf(itemXml, 'content:encoded'),
    audioUrl,
    siteUrl: textOf(itemXml, 'link') ?? attributeOf(itemXml, 'link', 'href'),
    imageUrl: attributeOf(itemXml, 'itunes:image', 'href') ?? options.fallbackImageUrl,
    publishedAt: parseDate(textOf(itemXml, 'pubDate') ?? textOf(itemXml, 'published') ?? textOf(itemXml, 'updated')),
    duration: parseDuration(textOf(itemXml, 'itunes:duration') ?? textOf(itemXml, 'duration')),
    progressSeconds: 0,
    completed: false,
    lastPlayedAt: null,
    downloadPath: null,
    downloadedAt: null,
    downloadBytes: null,
  };
}

function normalizeSubscription(value: Partial<PodcastSubscription>): PodcastSubscription | null {
  if (!value.feed?.url || !value.feed.title || !Array.isArray(value.episodes)) return null;
  return {
    feed: {
      id: value.feed.id || stableId(value.feed.url),
      url: normalizeFeedUrl(value.feed.url),
      title: String(value.feed.title),
      description: value.feed.description ?? null,
      siteUrl: value.feed.siteUrl ?? null,
      imageUrl: value.feed.imageUrl ?? null,
      episodeCount: Math.max(0, Math.trunc(Number(value.feed.episodeCount) || value.episodes.length)),
      lastFetchedAt: Math.max(0, Math.trunc(Number(value.feed.lastFetchedAt) || 0)),
    },
    episodes: value.episodes
      .map((episode) => normalizeEpisode(episode, value.feed!.url, value.feed!.title))
      .filter((episode): episode is PodcastEpisode => !!episode),
  };
}

function normalizeEpisode(value: Partial<PodcastEpisode>, feedUrl: string, feedTitle: string): PodcastEpisode | null {
  if (!value.audioUrl || !value.title) return null;
  const audioUrl = normalizeMaybeUrl(value.audioUrl);
  if (!audioUrl) return null;
  return {
    id: value.id || stableId(`${feedUrl}:${audioUrl}`),
    feedUrl: normalizeFeedUrl(value.feedUrl ?? feedUrl),
    feedTitle: value.feedTitle ?? feedTitle,
    title: String(value.title),
    description: value.description ?? null,
    audioUrl,
    siteUrl: value.siteUrl ?? null,
    imageUrl: value.imageUrl ?? null,
    publishedAt: typeof value.publishedAt === 'number' ? value.publishedAt : null,
    duration: typeof value.duration === 'number' ? value.duration : null,
    progressSeconds: Math.max(0, Math.trunc(Number(value.progressSeconds) || 0)),
    completed: value.completed === true,
    lastPlayedAt: typeof value.lastPlayedAt === 'number' ? value.lastPlayedAt : null,
    downloadPath: typeof value.downloadPath === 'string' ? value.downloadPath : null,
    downloadedAt: typeof value.downloadedAt === 'number' ? value.downloadedAt : null,
    downloadBytes: typeof value.downloadBytes === 'number' ? value.downloadBytes : null,
  };
}

function blocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tag)}>`, 'gi'))]
    .map((match) => match[1] ?? '');
}

function textOf(xml: string, tag: string): string | null {
  const value = firstMatch(xml, new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tag)}>`, 'i'));
  return normalizeText(value);
}

function attributeOf(xml: string, tag: string, attribute: string): string | null {
  const tagMatch = xml.match(new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>`, 'i'))?.[0];
  if (!tagMatch) return null;
  const value = tagMatch.match(new RegExp(`${escapeRegExp(attribute)}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1] ?? null;
  return normalizeMaybeUrl(value);
}

function atomAudioLink(xml: string): string | null {
  for (const match of xml.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const type = tag.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? '';
    const rel = tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? '';
    if ((rel && rel !== 'enclosure') || !type.startsWith('audio/')) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
    const normalized = normalizeMaybeUrl(href);
    if (normalized) return normalized;
  }
  return null;
}

function firstMatch(value: string, pattern: RegExp): string | null {
  return value.match(pattern)?.[1] ?? null;
}

function normalizeText(value: string | null | undefined): string | null {
  if (!value) return null;
  const cdata = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const stripped = cdata.replace(/<[^>]+>/g, ' ');
  const decoded = decodeEntities(stripped).replace(/\s+/g, ' ').trim();
  return decoded || null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)));
}

function parseDuration(value: string | null): number | null {
  if (!value) return null;
  const parts = value.split(':').map((part) => Math.trunc(Number(part)));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 1) return parts[0]!;
  return null;
}

function parseDate(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Explicit test escape: the podcast smokes serve fixture feeds from a local
// http server. Never set outside test harnesses. Shared by the hostname-shape
// guard below and the DNS-answer guard in resolveGuardedAddresses, so a
// smoke that opts out gets past both layers, not just the first one.
function podcastPrivateHostsAllowedForTesting(): boolean {
  return process.env.NEWAMP_ALLOW_PRIVATE_PODCAST_HOSTS === '1';
}

/**
 * SSRF guard: block podcast fetches to loopback/private/link-local hosts so a
 * malicious feed can't probe the user's machine or LAN (e.g. 127.0.0.1,
 * 169.254.169.254, fridge.local). This only catches hosts that are already
 * IP-literal-shaped (or the localhost/.local hostname patterns); a plain DNS
 * name is caught later, once resolved, by resolveGuardedAddresses.
 * Exported for scripts/podcast-host-guard-test.mjs.
 */
export function isBlockedPodcastHost(hostname: string): boolean {
  if (podcastPrivateHostsAllowedForTesting()) return false;
  let host = String(hostname).trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  return isBlockedIpLiteral(host);
}

// Byte-level classifier for a single IPv4/IPv6 literal (not a hostname): used
// both for URL hostnames that are already IP-literal-shaped, and for the
// addresses a hostname actually resolves to (see resolveGuardedAddresses) —
// the latter is what stops a DNS name from reaching a private/link-local
// address that the URL text never mentioned.
function isBlockedIpLiteral(host: string): boolean {
  // IPv6 literals. Matching on the text shape is not enough: the URL parser
  // rewrites an IPv4-mapped literal like [::ffff:169.254.169.254] to
  // ::ffff:a9fe:a9fe, which starts with none of the blocked prefixes while
  // still dialling the embedded IPv4 address. Parse to bytes instead.
  if (host.includes(':')) {
    const bytes = ipv6ToBytes(host);
    if (!bytes) return true; // unparseable literal: refuse rather than guess
    if (bytes.every((b) => b === 0)) return true; // ::
    if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true; // ::1
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
    if ((bytes[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
    if (bytes[0] === 0xff) return true; // ff00::/8 multicast
    // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible) reach the v4 address.
    const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    const compatible = bytes.slice(0, 12).every((b) => b === 0);
    if (mapped || compatible) return isBlockedIpv4(bytes.slice(12));
    return false;
  }

  // IPv4 literals (numeric octet parse — regex alone can't express the ranges).
  const octets = host.split('.');
  if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o))) {
    const parts = octets.map((o) => Number(o));
    if (parts.every((n) => n <= 255)) return isBlockedIpv4(parts);
  }
  return false;
}

function isBlockedIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b! >= 64 && b! <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a! >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  return false;
}

// Expand an IPv6 literal to its 16 bytes, handling `::` compression, a trailing
// dotted-quad, and a zone id. Returns null when the literal is not valid.
function ipv6ToBytes(literal: string): number[] | null {
  let addr = literal.split('%')[0]!;
  const dotted = addr.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const quad = [dotted[2], dotted[3], dotted[4], dotted[5]].map((o) => Number(o));
    if (quad.some((n) => n > 255)) return null;
    const hi = ((quad[0]! << 8) | quad[1]!).toString(16);
    const lo = ((quad[2]! << 8) | quad[3]!).toString(16);
    addr = `${dotted[1]}${hi}:${lo}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string) =>
    part ? part.split(':').filter((g) => g !== '').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : [];
  const head = toGroups(halves[0]!);
  const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
  if ([...head, ...tail].some((g) => Number.isNaN(g))) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => [(g >> 8) & 0xff, g & 0xff]);
}

const MAX_PODCAST_REDIRECTS = 5;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000; // plenty for a feed capped at MAX_FEED_BYTES
const EPISODE_DOWNLOAD_TIMEOUT_MS = 30 * 60_000; // generous ceiling for a 750MB cap on a slow link

interface ResolvedAddress {
  address: string;
  family: number;
}

// Test-only escape hatch: lets a test point a "public-looking" hostname at a
// local server (lookup) and vouch for the resulting loopback/private address
// (allowAddress) without weakening the guard for anything else. Production
// call sites (fetchPodcastSubscription, downloadPodcastEpisode) never pass
// this. See scripts/podcast-http-boundary-test.mjs and
// scripts/podcast-redirect-guard-test.mjs.
export interface HostGuardOverrides {
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  allowAddress?: (address: string, family: number, hostname: string) => boolean;
}

export interface GuardedRequestInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Total operation timeout, covering every redirect hop plus the full body read. */
  timeoutMs?: number;
  /** How long to wait for response headers on a single hop before giving up. */
  connectTimeoutMs?: number;
}

export interface GuardedResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  /** Reads the whole body as utf8, aborting the instant more than maxBytes has arrived. */
  text(maxBytes: number): Promise<string>;
  /** Streams the body straight to destPath, capping bytes read and removing destPath on any failure. */
  saveToFile(destPath: string, maxBytes: number): Promise<number>;
}

// isBlockedPodcastHost only guards the URL text a caller passes in. A feed
// hosted at an innocuous public URL could 302 to 127.0.0.1 or the cloud
// metadata endpoint, or its DNS name could simply resolve to one — neither
// is visible in the URL string. This helper re-validates every hop (and the
// address each hop actually resolves to, not just its hostname) with a real
// node:http/https request instead of the global fetch, so it can also
// enforce byte caps while the body streams in rather than after the fact.
// Exported for scripts/podcast-redirect-guard-test.mjs and
// scripts/podcast-http-boundary-test.mjs.
export async function fetchWithHostGuard(
  url: string,
  init: GuardedRequestInit = {},
  overrides?: HostGuardOverrides,
): Promise<GuardedResponse> {
  const connectTimeoutMs = init.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const controller = new AbortController();
  const totalTimer = setTimeout(
    () => controller.abort(new Error('Podcast request took too long')),
    init.timeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
  );
  const onExternalAbort = () => controller.abort(init.signal?.reason ?? new Error('Podcast request was aborted'));
  if (init.signal) {
    if (init.signal.aborted) controller.abort(init.signal.reason);
    else init.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let handedOffToResponse = false;
  try {
    let current = new URL(url);
    for (let hop = 0; ; hop += 1) {
      if (current.protocol !== 'https:' && current.protocol !== 'http:') {
        throw new Error('Podcast request URL must use http:// or https://');
      }
      if (isBlockedPodcastHost(current.hostname)) {
        throw new Error('Podcast request host is not allowed (private or local address)');
      }
      // Resolve and validate the DNS answer BEFORE dialling anything, then
      // dial only those validated addresses (see pinnedLookup) — otherwise a
      // second resolution during connect could swap in a private address
      // (DNS rebinding) after the check above already passed.
      const addresses = await resolveGuardedAddresses(current.hostname, overrides);
      const res = await dialGuarded(current, addresses, init.headers, controller, connectTimeoutMs);
      if (isRedirectStatus(res.statusCode ?? 0)) {
        res.resume(); // discard the (usually empty) redirect body without buffering it
        if (hop >= MAX_PODCAST_REDIRECTS) throw new Error('Podcast request redirected too many times');
        const location = res.headers.location;
        if (!location || Array.isArray(location)) throw new Error('Podcast request redirected with no Location header');
        current = new URL(location, current);
        continue;
      }
      handedOffToResponse = true;
      return wrapGuardedResponse(res, controller, totalTimer);
    }
  } finally {
    if (init.signal) init.signal.removeEventListener('abort', onExternalAbort);
    // Once we hand a response back, wrapGuardedResponse's text()/saveToFile()
    // own clearing the timer — it has to keep running through the body read.
    if (!handedOffToResponse) clearTimeout(totalTimer);
  }
}

async function resolveGuardedAddresses(hostname: string, overrides?: HostGuardOverrides): Promise<ResolvedAddress[]> {
  const answers = overrides?.lookup ? await overrides.lookup(hostname) : await defaultDnsLookupAll(hostname);
  if (!answers.length) throw new Error('Podcast request host did not resolve to any address');
  if (podcastPrivateHostsAllowedForTesting()) return answers;
  for (const { address, family } of answers) {
    if (overrides?.allowAddress?.(address, family, hostname)) continue;
    if (isBlockedIpLiteral(address.toLowerCase())) {
      throw new Error('Podcast request host is not allowed (private or local address)');
    }
  }
  return answers;
}

async function defaultDnsLookupAll(hostname: string): Promise<ResolvedAddress[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => ({ address: result.address, family: result.family }));
}

// A custom dns-lookup function for http(s).request that always hands back
// the address list we already validated, regardless of whether Node's
// internals ask for one address or all of them (Happy Eyeballs / dual-stack
// requests {all: true}). This is what actually binds the TCP connection to
// the validated answer instead of letting the request re-resolve the
// hostname itself.
function pinnedLookup(addresses: ResolvedAddress[]): http.RequestOptions['lookup'] {
  return ((hostname: string, options: any, callback: any) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (options?.all) {
      callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
    } else {
      const [first] = addresses;
      callback(null, first!.address, first!.family);
    }
  }) as http.RequestOptions['lookup'];
}

function dialGuarded(
  target: URL,
  addresses: ResolvedAddress[],
  headers: Record<string, string> | undefined,
  controller: AbortController,
  connectTimeoutMs: number,
): Promise<http.IncomingMessage> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (controller.signal.aborted) {
      rejectPromise(describeAbort(controller, controller.signal.reason));
      return;
    }
    const connectTimer = setTimeout(
      () => controller.abort(new Error('Podcast request timed out waiting for a response')),
      connectTimeoutMs,
    );
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target, {
      method: 'GET',
      headers,
      lookup: pinnedLookup(addresses),
      signal: controller.signal,
      ...(target.protocol === 'https:' ? { servername: target.hostname } : {}),
    });
    req.on('error', (err) => {
      clearTimeout(connectTimer);
      rejectPromise(describeAbort(controller, err));
    });
    req.on('response', (res) => {
      clearTimeout(connectTimer);
      resolvePromise(res);
    });
    req.end();
  });
}

// Once the request/response has been destroyed by our own AbortController,
// the error Node hands back is not reliably the friendly message we set —
// prefer signal.reason, which is exactly what we passed to controller.abort().
function describeAbort(controller: AbortController, err: unknown): Error {
  if (controller.signal.aborted) {
    const reason = controller.signal.reason;
    if (reason instanceof Error) return reason;
  }
  return err instanceof Error ? err : new Error(String(err));
}

function wrapGuardedResponse(
  res: http.IncomingMessage,
  controller: AbortController,
  totalTimer: NodeJS.Timeout,
): GuardedResponse {
  const status = res.statusCode ?? 0;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name: string): string | null {
        const value = res.headers[name.toLowerCase()];
        if (value === undefined) return null;
        return Array.isArray(value) ? (value[0] ?? null) : value;
      },
    },
    async text(maxBytes: number): Promise<string> {
      try {
        return await readBodyText(res, maxBytes, controller);
      } finally {
        clearTimeout(totalTimer);
      }
    },
    async saveToFile(destPath: string, maxBytes: number): Promise<number> {
      try {
        return await streamBodyToFile(res, destPath, maxBytes, controller);
      } finally {
        clearTimeout(totalTimer);
      }
    },
  };
}

function readBodyText(res: http.IncomingMessage, maxBytes: number, controller: AbortController): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      res.off('data', onData);
      res.off('end', onEnd);
      res.off('error', onError);
      res.off('aborted', onAborted);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(err);
    };
    const onError = (err: Error) => fail(describeAbort(controller, err));
    const onAborted = () => fail(describeAbort(controller, new Error('Podcast request was aborted')));
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Settle with the size error BEFORE tearing the socket down — destroy()
        // fires 'aborted', and the abort message must not win the race.
        fail(new Error('Podcast feed is too large.'));
        res.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(Buffer.concat(chunks, total).toString('utf8'));
    };

    res.on('data', onData);
    res.on('end', onEnd);
    res.on('error', onError);
    res.on('aborted', onAborted);
  });
}

async function streamBodyToFile(
  res: http.IncomingMessage,
  destPath: string,
  maxBytes: number,
  controller: AbortController,
): Promise<number> {
  let total = 0;
  let failed = false;
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const writeStream = createWriteStream(destPath);
      let settled = false;

      const cleanup = () => {
        res.off('data', onData);
        res.off('end', onEnd);
        res.off('error', onResError);
        res.off('aborted', onAborted);
        writeStream.off('error', onWriteError);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        failed = true;
        cleanup();
        res.destroy();
        writeStream.destroy();
        rejectPromise(err);
      };
      const onResError = (err: Error) => fail(describeAbort(controller, err));
      const onAborted = () => fail(describeAbort(controller, new Error('Podcast request was aborted')));
      const onWriteError = (err: Error) => fail(err);
      const onData = (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          fail(new Error('Podcast episode is too large to download.'));
          return;
        }
        if (!writeStream.write(chunk)) res.pause();
      };
      const onEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        writeStream.end(() => resolvePromise());
      };

      writeStream.on('drain', () => res.resume());
      writeStream.on('error', onWriteError);
      res.on('data', onData);
      res.on('end', onEnd);
      res.on('error', onResError);
      res.on('aborted', onAborted);
    });
    // Reopen briefly just to fsync — createWriteStream's own fd is already
    // closed (autoClose) by the time 'finish' fires, and podcasts.ts renames
    // this file into place immediately after, so it needs to be durable now.
    const handle = await open(destPath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    if (failed) await unlink(destPath).catch(() => {});
  }
  return total;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function normalizeFeedUrl(url: string): string {
  const parsed = new URL(String(url).trim());
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Podcast feed URL must start with http:// or https://');
  }
  if (isBlockedPodcastHost(parsed.hostname)) {
    throw new Error('Podcast feed host is not allowed (private or local address)');
  }
  return parsed.toString();
}

function normalizeMaybeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(decodeEntities(url.trim()));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (isBlockedPodcastHost(parsed.hostname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function hostnameTitle(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Podcast';
  }
}

function stableId(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function audioExtension(url: string): string {
  const ext = extname(new URL(url).pathname).toLowerCase();
  if (['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac', '.webm'].includes(ext)) return ext;
  return '.mp3';
}

function ensureInside(root: string, child: string): void {
  const normalizedRoot = resolve(root).toLowerCase();
  const normalizedChild = resolve(child).toLowerCase();
  if (normalizedChild !== normalizedRoot && !normalizedChild.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`Podcast download escaped download root: ${child}`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
