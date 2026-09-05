export type MusicServerProvider = 'jellyfin' | 'subsonic';

export interface MusicServerConnectionInput {
  provider: MusicServerProvider;
  connectionId?: string;
  name?: string | null;
  baseUrl: string;
  username: string;
  password: string;
}

export interface MusicServerConnectionPublic {
  id: string;
  provider: MusicServerProvider;
  name: string;
  baseUrl: string;
  username: string;
  serverName: string | null;
  serverVersion: string | null;
  userId: string | null;
  serverId: string | null;
  authenticatedAt: number;
}

export type MusicServerConnectionSecret =
  | {
      provider: 'jellyfin';
      username: string;
      accessToken: string;
      userId: string;
      serverId: string | null;
    }
  | {
      provider: 'subsonic';
      username: string;
      password: string;
    };

export interface MusicServerRuntimeConnection extends MusicServerConnectionPublic {
  secret: MusicServerConnectionSecret;
}

export interface MusicServerPageOptions {
  offset?: number;
  limit?: number;
}

export interface MusicServerSearchOptions extends MusicServerPageOptions {
  query: string;
}

export interface MusicServerSong {
  provider: MusicServerProvider;
  connectionId: string;
  itemId: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  genre: string | null;
  duration: number | null;
  bitrate: number | null;
  sampleRate: number | null;
  size: number | null;
  container: string | null;
  contentType: string | null;
  streamPath: string;
  streamUrl: string;
}

export interface MusicServerSongPage {
  provider: MusicServerProvider;
  connectionId: string;
  offset: number;
  limit: number;
  total: number | null;
  nextOffset: number | null;
  songs: MusicServerSong[];
}

export interface ParsedMusicServerStreamUrl {
  connectionId: string;
  itemId: string;
  filename: string | null;
}

export function isMusicServerProvider(value: unknown): value is MusicServerProvider {
  return value === 'jellyfin' || value === 'subsonic';
}

export function normalizeMusicServerConnectionId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Music server connection id is required.');
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(trimmed)) {
    throw new Error('Music server connection id is invalid.');
  }
  return trimmed;
}

export function normalizeMusicServerBaseUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('Music server URL is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Music server URL is invalid.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Music server URL must start with http:// or https://.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Music server URL must not include embedded credentials.');
  }
  // User-configured music servers commonly live on LAN HTTP or private IPs.
  // The guard here rejects dangerous URL shapes while intentionally allowing
  // those hosts; credentials are added only by the main-process adapter.
  if (parsed.search || parsed.hash) {
    throw new Error('Music server URL must not include a query string or fragment.');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  if (parsed.pathname === '') parsed.pathname = '/';
  const text = parsed.toString();
  return text.endsWith('/') && parsed.pathname === '/' ? text.slice(0, -1) : text.replace(/\/$/, '');
}

export function normalizeMusicServerPageOptions(options: MusicServerPageOptions = {}): Required<Pick<MusicServerPageOptions, 'offset' | 'limit'>> {
  const rawOffset = Math.trunc(Number(options.offset ?? 0));
  const rawLimit = Math.trunc(Number(options.limit ?? 100));
  return {
    offset: Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0,
    limit: Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, rawLimit)) : 100,
  };
}

export function musicServerStreamPath(connectionId: string, itemId: string, filename?: string | null): string {
  const id = normalizeMusicServerConnectionId(connectionId);
  const cleanName = sanitizeMusicServerFilename(filename);
  const suffix = cleanName ? `/${encodeURIComponent(cleanName)}` : '';
  return `/server/${encodeURIComponent(id)}/${encodeURIComponent(itemId)}${suffix}`;
}

export function musicServerStreamUrl(connectionId: string, itemId: string, filename?: string | null): string {
  return `newamp:/${musicServerStreamPath(connectionId, itemId, filename)}`;
}

export function parseMusicServerStreamUrl(rawUrl: string): ParsedMusicServerStreamUrl {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Malformed music server URL.');
  }
  if (parsed.protocol !== 'newamp:' || parsed.hostname !== 'server'
    || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw new Error('Malformed music server URL.');
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || parts.length > 3) {
    throw new Error('Malformed music server URL.');
  }
  try {
    const connectionId = normalizeMusicServerConnectionId(decodeURIComponent(parts[0]!));
    const itemId = decodeURIComponent(parts[1]!);
    const filename = parts[2] ? sanitizeMusicServerFilename(decodeURIComponent(parts[2]!)) : null;
    if (!itemId) throw new Error('missing item id');
    return { connectionId, itemId, filename };
  } catch {
    throw new Error('Malformed music server URL.');
  }
}

export function sanitizeMusicServerFilename(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return trimmed ? trimmed.slice(0, 160) : null;
}

export function musicServerSongFilename(title: string, container: string | null): string | null {
  const stem = sanitizeMusicServerFilename(title) ?? 'track';
  const ext = normalizeMusicServerContainer(container);
  return ext ? `${stem}.${ext}` : stem;
}

export function normalizeMusicServerContainer(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/^\.+/, '');
  if (!/^[a-z0-9][a-z0-9._-]{0,15}$/.test(normalized)) return null;
  if (normalized === 'mpeg') return 'mp3';
  if (normalized === 'x-flac') return 'flac';
  return normalized;
}
