import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
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
  const xml = await response.text();
  if (xml.length > MAX_FEED_BYTES) throw new Error('Podcast feed is too large.');
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

  const response = await fetchWithHostGuard(episode.audioUrl, {
    headers: { 'User-Agent': `${NEWAMP_USER_AGENT} podcast downloader` },
  });
  if (!response.ok) throw new Error(`Podcast episode download failed: HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_EPISODE_BYTES) throw new Error('Podcast episode is too large to download.');
  const data = Buffer.from(await response.arrayBuffer());
  if (data.byteLength > MAX_EPISODE_BYTES) throw new Error('Podcast episode is too large to download.');

  const downloadsRoot = resolve(input.downloadsPath);
  const targetDir = join(downloadsRoot, stableId(input.feedUrl));
  await mkdir(targetDir, { recursive: true });
  const targetPath = join(targetDir, `${episode.id}${audioExtension(episode.audioUrl)}`);
  ensureInside(downloadsRoot, targetPath);
  await writeFile(targetPath, data);
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

/**
 * SSRF guard: block podcast fetches to loopback/private/link-local hosts so a
 * malicious feed can't probe the user's machine or LAN (e.g. 127.0.0.1,
 * 169.254.169.254, fridge.local). Hostname-literal check only — DNS-rebinding
 * defenses are out of scope for a single-user desktop app.
 * Exported for scripts/podcast-host-guard-test.mjs.
 */
export function isBlockedPodcastHost(hostname: string): boolean {
  // Explicit test escape: the podcast smokes serve fixture feeds from a local
  // http server. Never set outside test harnesses.
  if (process.env.NEWAMP_ALLOW_PRIVATE_PODCAST_HOSTS === '1') return false;
  let host = String(hostname).trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  // IPv6 literals.
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) {
      return true; // fe80::/10 link-local
    }
    if (host.startsWith('fc') || host.startsWith('fd')) return true; // fc00::/7 unique-local
    return false;
  }

  // IPv4 literals (numeric octet parse — regex alone can't express the ranges).
  const octets = host.split('.');
  if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o))) {
    const [a, b] = octets.map((o) => Number(o));
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b! >= 16 && b! <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

const MAX_PODCAST_REDIRECTS = 5;

// isBlockedPodcastHost only guards the URL a caller passes in. Node's fetch
// follows redirects by default and never re-validates the hop, so a feed
// hosted at an innocuous public URL could 302 to 127.0.0.1 or the cloud
// metadata endpoint and the guard above would never see it. Fetch with
// redirect: 'manual' and re-validate every hop (and the initial URL) against
// the same host guard, capping the number of hops so a redirect loop can't
// hang the request.
// Exported for scripts/podcast-redirect-guard-test.mjs.
export async function fetchWithHostGuard(url: string, init: RequestInit = {}): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; ; hop += 1) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') {
      throw new Error('Podcast request URL must use http:// or https://');
    }
    if (isBlockedPodcastHost(current.hostname)) {
      throw new Error('Podcast request host is not allowed (private or local address)');
    }
    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (!isRedirectStatus(response.status)) return response;
    if (hop >= MAX_PODCAST_REDIRECTS) throw new Error('Podcast request redirected too many times');
    const location = response.headers.get('location');
    if (!location) throw new Error('Podcast request redirected with no Location header');
    current = new URL(location, current);
  }
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
