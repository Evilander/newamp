import { createHash, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';
import {
  isMusicServerProvider,
  musicServerSongFilename,
  musicServerStreamPath,
  musicServerStreamUrl,
  normalizeMusicServerBaseUrl,
  normalizeMusicServerConnectionId,
  normalizeMusicServerContainer,
  normalizeMusicServerPageOptions,
  parseMusicServerStreamUrl,
  type MusicServerConnectionInput,
  type MusicServerConnectionPublic,
  type MusicServerConnectionSecret,
  type MusicServerPageOptions,
  type MusicServerProvider,
  type MusicServerRuntimeConnection,
  type MusicServerSearchOptions,
  type MusicServerSong,
  type MusicServerSongPage,
} from '../shared/music-servers.js';
import { NEWAMP_USER_AGENT, NEWAMP_VERSION } from '../shared/app-version.js';

export {
  musicServerStreamPath,
  musicServerStreamUrl,
  parseMusicServerStreamUrl,
};
export type {
  MusicServerConnectionInput,
  MusicServerConnectionPublic,
  MusicServerConnectionSecret,
  MusicServerPageOptions,
  MusicServerProvider,
  MusicServerRuntimeConnection,
  MusicServerSearchOptions,
  MusicServerSong,
  MusicServerSongPage,
};

export interface MusicServerRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: number;
}

export interface MusicServerConnectionTestResult {
  connection: MusicServerConnectionPublic;
  secret: MusicServerConnectionSecret;
}

type MusicServerConnectionLoader =
  (connectionId: string) => Promise<MusicServerRuntimeConnection | null> | MusicServerRuntimeConnection | null;

const JSON_BODY_LIMIT = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_STREAM_HEADER_TIMEOUT_MS = 20_000;
const SUBSONIC_API_VERSION = '1.16.1';
const SUBSONIC_CLIENT_NAME = 'NewAmp';

export class MusicServerRegistry {
  constructor(private readonly loadConnection: MusicServerConnectionLoader) {}

  async browse(
    connectionId: string,
    options: MusicServerPageOptions = {},
    requestOptions: MusicServerRequestOptions = {},
  ): Promise<MusicServerSongPage> {
    const connection = await this.mustLoad(connectionId);
    return browseMusicServerSongs(connection, options, requestOptions);
  }

  async search(
    connectionId: string,
    options: MusicServerSearchOptions,
    requestOptions: MusicServerRequestOptions = {},
  ): Promise<MusicServerSongPage> {
    const connection = await this.mustLoad(connectionId);
    return searchMusicServerSongs(connection, options, requestOptions);
  }

  async stream(request: Request, options: MusicServerRequestOptions = {}): Promise<Response> {
    let parsed: ReturnType<typeof parseMusicServerStreamUrl>;
    try {
      parsed = parseMusicServerStreamUrl(request.url);
    } catch {
      return textResponse('Malformed music server URL.', 400);
    }
    const connection = await this.loadConnection(parsed.connectionId);
    if (!connection) return textResponse('Music server connection not found.', 404);
    return streamMusicServerSong(connection, parsed.itemId, request, options);
  }

  private async mustLoad(connectionId: string): Promise<MusicServerRuntimeConnection> {
    const id = normalizeMusicServerConnectionId(connectionId);
    const connection = await this.loadConnection(id);
    if (!connection) throw new Error('Music server connection not found.');
    return connection;
  }
}

export async function testMusicServerConnection(
  input: MusicServerConnectionInput,
  options: MusicServerRequestOptions = {},
): Promise<MusicServerConnectionTestResult> {
  try {
    if (!isMusicServerProvider(input?.provider)) throw new Error('Music server provider is not supported.');
    if (input.provider === 'jellyfin') return await testJellyfinConnection(input, options);
    return await testSubsonicConnection(input, options);
  } catch (err) {
    throw new Error(sanitizeMusicServerError(err, [input?.password, input?.username]));
  }
}

export async function browseMusicServerSongs(
  connection: MusicServerRuntimeConnection,
  options: MusicServerPageOptions = {},
  requestOptions: MusicServerRequestOptions = {},
): Promise<MusicServerSongPage> {
  try {
    assertRuntimeConnection(connection);
    if (connection.provider === 'jellyfin') return await fetchJellyfinSongs(connection, options, null, requestOptions);
    return await fetchSubsonicSongs(connection, options, '', requestOptions);
  } catch (err) {
    throw new Error(sanitizeMusicServerError(err, connectionSecrets(connection)));
  }
}

export async function searchMusicServerSongs(
  connection: MusicServerRuntimeConnection,
  options: MusicServerSearchOptions,
  requestOptions: MusicServerRequestOptions = {},
): Promise<MusicServerSongPage> {
  try {
    assertRuntimeConnection(connection);
    const query = typeof options?.query === 'string' ? options.query.trim() : '';
    if (connection.provider === 'jellyfin') return await fetchJellyfinSongs(connection, options, query, requestOptions);
    return await fetchSubsonicSongs(connection, options, query, requestOptions);
  } catch (err) {
    throw new Error(sanitizeMusicServerError(err, connectionSecrets(connection)));
  }
}

export async function streamMusicServerSong(
  connection: MusicServerRuntimeConnection,
  itemId: string,
  request: Request,
  options: MusicServerRequestOptions = {},
): Promise<Response> {
  try {
    assertRuntimeConnection(connection);
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method not allowed.', {
        status: 405,
        headers: {
          Allow: 'GET, HEAD',
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        },
      });
    }
    const upstream = connection.provider === 'jellyfin'
      ? jellyfinStreamUrl(connection, itemId)
      : subsonicStreamUrl(connection, itemId);
    const response = await fetchStreamNoRedirect(upstream, {
      method,
      headers: streamRequestHeaders(connection, request),
      signal: request.signal,
    }, { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_STREAM_HEADER_TIMEOUT_MS });
    if (isRedirect(response.status)) {
      response.body?.cancel().catch(() => {});
      return textResponse('Music server stream redirected; refusing to forward credentials.', 502);
    }
    if (response.status >= 400 && response.status !== 416) {
      response.body?.cancel().catch(() => {});
      return textResponse(`Music server stream request failed: HTTP ${response.status}`, response.status);
    }
    const headers = copySafeResponseHeaders(response.headers);
    if (method === 'HEAD') {
      response.body?.cancel().catch(() => {});
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (err) {
    return textResponse(sanitizeMusicServerError(err, connectionSecrets(connection)), 502);
  }
}

async function testJellyfinConnection(
  input: MusicServerConnectionInput,
  options: MusicServerRequestOptions,
): Promise<MusicServerConnectionTestResult> {
  const baseUrl = normalizeMusicServerBaseUrl(input.baseUrl);
  const username = normalizeRequiredText(input.username, 'Music server username is required.');
  const password = normalizePassword(input.password);
  const connectionId = connectionIdFor(input, baseUrl, username);
  const authUrl = endpointUrl(baseUrl, '/Users/AuthenticateByName');
  const auth = await fetchJson(authUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': NEWAMP_USER_AGENT,
      'X-Emby-Authorization': jellyfinAuthorization(connectionId),
    },
    body: JSON.stringify({ Username: username, Pw: password }),
  }, options);
  const accessToken = textOf(auth, ['AccessToken']);
  const userId = textOf(auth, ['User', 'Id']);
  if (!accessToken || !userId) {
    throw new Error('Jellyfin authentication did not return an access token.');
  }
  const serverId = textOf(auth, ['ServerId']);
  const secret: MusicServerConnectionSecret = {
    provider: 'jellyfin',
    username,
    accessToken,
    userId,
    serverId,
  };
  const info = await fetchJson(endpointUrl(baseUrl, '/System/Info'), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': NEWAMP_USER_AGENT,
      ...jellyfinAuthHeaders({ id: connectionId, secret }),
    },
  }, options);
  const serverName = textOf(info, ['ServerName']) ?? textOf(info, ['Name']);
  const serverVersion = textOf(info, ['Version']);
  const connection: MusicServerConnectionPublic = {
    id: connectionId,
    provider: 'jellyfin',
    name: normalizeOptionalName(input.name) ?? serverName ?? hostnameName(baseUrl),
    baseUrl,
    username,
    serverName,
    serverVersion,
    userId,
    serverId,
    authenticatedAt: Math.max(0, Math.trunc(Number(options.now ?? Date.now()))),
  };
  return { connection, secret };
}

async function testSubsonicConnection(
  input: MusicServerConnectionInput,
  options: MusicServerRequestOptions,
): Promise<MusicServerConnectionTestResult> {
  const baseUrl = normalizeMusicServerBaseUrl(input.baseUrl);
  const username = normalizeRequiredText(input.username, 'Music server username is required.');
  const password = normalizePassword(input.password);
  const connectionId = connectionIdFor(input, baseUrl, username);
  const secret: MusicServerConnectionSecret = { provider: 'subsonic', username, password };
  const url = subsonicEndpoint(baseUrl, '/rest/ping.view', secret);
  const response = await fetchJson(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': NEWAMP_USER_AGENT },
  }, options);
  const payload = subsonicResponse(response);
  const serverName = textOf(payload, ['type']) ?? 'Subsonic';
  const serverVersion = textOf(payload, ['serverVersion']);
  const connection: MusicServerConnectionPublic = {
    id: connectionId,
    provider: 'subsonic',
    name: normalizeOptionalName(input.name) ?? serverName ?? hostnameName(baseUrl),
    baseUrl,
    username,
    serverName,
    serverVersion,
    userId: null,
    serverId: null,
    authenticatedAt: Math.max(0, Math.trunc(Number(options.now ?? Date.now()))),
  };
  return { connection, secret };
}

async function fetchJellyfinSongs(
  connection: MusicServerRuntimeConnection,
  options: MusicServerPageOptions,
  query: string | null,
  requestOptions: MusicServerRequestOptions,
): Promise<MusicServerSongPage> {
  const { offset, limit } = normalizeMusicServerPageOptions(options);
  const url = endpointUrl(connection.baseUrl, '/Items');
  const userId = connection.secret.provider === 'jellyfin' ? connection.secret.userId : connection.userId;
  if (!userId) throw new Error('Jellyfin connection is missing its user id.');
  url.searchParams.set('userId', userId);
  url.searchParams.set('includeItemTypes', 'Audio');
  url.searchParams.set('recursive', 'true');
  url.searchParams.set('startIndex', String(offset));
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('enableTotalRecordCount', 'true');
  url.searchParams.set('fields', 'Genres,MediaSources,DateCreated,Path');
  url.searchParams.set('sortBy', 'SortName');
  url.searchParams.set('sortOrder', 'Ascending');
  if (query) url.searchParams.set('searchTerm', query);
  const json = await fetchJson(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': NEWAMP_USER_AGENT,
      ...jellyfinAuthHeaders(connection),
    },
  }, requestOptions);
  if (!json || typeof json !== 'object' || !Array.isArray((json as { Items?: unknown }).Items)) {
    throw new Error('Jellyfin Items response is invalid.');
  }
  const items = (json as { Items: unknown[] }).Items;
  const songs = items
    .map((item) => mapJellyfinSong(connection, item))
    .filter((song): song is MusicServerSong => song !== null);
  const total = finiteInt((json as { TotalRecordCount?: unknown }).TotalRecordCount);
  const nextOffset = items.length > 0 && (total == null ? items.length >= limit : offset + items.length < total)
    ? offset + items.length : null;
  return {
    provider: 'jellyfin',
    connectionId: connection.id,
    offset,
    limit,
    total,
    nextOffset,
    songs,
  };
}

async function fetchSubsonicSongs(
  connection: MusicServerRuntimeConnection,
  options: MusicServerPageOptions,
  query: string,
  requestOptions: MusicServerRequestOptions,
): Promise<MusicServerSongPage> {
  const { offset, limit } = normalizeMusicServerPageOptions(options);
  if (connection.secret.provider !== 'subsonic') throw new Error('Subsonic connection is missing its password.');
  const url = subsonicEndpoint(connection.baseUrl, '/rest/search3.view', connection.secret);
  url.searchParams.set('query', query);
  url.searchParams.set('artistCount', '0');
  url.searchParams.set('albumCount', '0');
  url.searchParams.set('songCount', String(limit));
  url.searchParams.set('songOffset', String(offset));
  const json = await fetchJson(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': NEWAMP_USER_AGENT },
  }, requestOptions);
  const payload = subsonicResponse(json);
  const searchResult = valueAt(payload, ['searchResult3']);
  const rawSongs = Array.isArray((searchResult as { song?: unknown } | null)?.song)
    ? (searchResult as { song: unknown[] }).song
    : [];
  const songs = rawSongs
    .map((song) => mapSubsonicSong(connection, song))
    .filter((song): song is MusicServerSong => song !== null);
  return {
    provider: 'subsonic',
    connectionId: connection.id,
    offset,
    limit,
    total: null,
    nextOffset: rawSongs.length >= limit ? offset + rawSongs.length : null,
    songs,
  };
}

function mapJellyfinSong(connection: MusicServerRuntimeConnection, item: unknown): MusicServerSong | null {
  if (!item || typeof item !== 'object') return null;
  const row = item as Record<string, unknown>;
  const itemId = textOf(row, ['Id']);
  if (!itemId) return null;
  const title = textOf(row, ['Name']) ?? 'Untitled';
  const artists = stringArray(row.Artists);
  const artistItems = objectArray(row.ArtistItems).map((entry) => textOf(entry, ['Name'])).filter(isPresent);
  const artist = artists[0] ?? artistItems[0] ?? textOf(row, ['AlbumArtist']) ?? 'Unknown Artist';
  const album = textOf(row, ['Album']) ?? 'Unknown Album';
  const albumArtists = stringArray(row.AlbumArtists);
  const albumArtist = textOf(row, ['AlbumArtist']) ?? albumArtists[0] ?? artist;
  const mediaSource = objectArray(row.MediaSources)[0] ?? {};
  const container = normalizeMusicServerContainer(row.Container) ?? normalizeMusicServerContainer(mediaSource.Container);
  const filename = musicServerSongFilename(title, container);
  return {
    provider: 'jellyfin',
    connectionId: connection.id,
    itemId,
    title,
    artist,
    album,
    albumArtist,
    trackNo: finiteInt(row.IndexNumber),
    discNo: finiteInt(row.ParentIndexNumber),
    year: finiteInt(row.ProductionYear),
    genre: stringArray(row.Genres)[0] ?? null,
    duration: ticksToSeconds(row.RunTimeTicks),
    bitrate: finiteInt(row.Bitrate) ?? finiteInt(mediaSource.Bitrate),
    sampleRate: jellyfinSampleRate(row),
    size: finiteInt(row.Size) ?? finiteInt(mediaSource.Size),
    container,
    contentType: textOf(row, ['MimeType']),
    streamPath: musicServerStreamPath(connection.id, itemId, filename),
    streamUrl: musicServerStreamUrl(connection.id, itemId, filename),
  };
}

function mapSubsonicSong(connection: MusicServerRuntimeConnection, value: unknown): MusicServerSong | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const itemId = textOf(row, ['id']);
  if (!itemId) return null;
  const title = textOf(row, ['title']) ?? textOf(row, ['name']) ?? 'Untitled';
  const artist = textOf(row, ['artist']) ?? 'Unknown Artist';
  const album = textOf(row, ['album']) ?? 'Unknown Album';
  const albumArtist = textOf(row, ['albumArtist']) ?? artist;
  const contentType = textOf(row, ['contentType']);
  const container = normalizeMusicServerContainer(row.suffix)
    ?? normalizeMusicServerContainer(row.type)
    ?? containerFromContentType(contentType);
  const filename = musicServerSongFilename(title, container);
  return {
    provider: 'subsonic',
    connectionId: connection.id,
    itemId,
    title,
    artist,
    album,
    albumArtist,
    trackNo: finiteInt(row.track),
    discNo: finiteInt(row.discNumber),
    year: finiteInt(row.year),
    genre: textOf(row, ['genre']),
    duration: finiteNumber(row.duration),
    bitrate: subsonicBitrate(row.bitRate),
    sampleRate: finiteInt(row.samplingRate) ?? finiteInt(row.sampleRate),
    size: finiteInt(row.size),
    container,
    contentType,
    streamPath: musicServerStreamPath(connection.id, itemId, filename),
    streamUrl: musicServerStreamUrl(connection.id, itemId, filename),
  };
}

function jellyfinStreamUrl(connection: MusicServerRuntimeConnection, itemId: string): URL {
  const url = endpointUrl(connection.baseUrl, `/Audio/${encodeURIComponent(itemId)}/stream`);
  url.searchParams.set('static', 'true');
  return url;
}

function subsonicStreamUrl(connection: MusicServerRuntimeConnection, itemId: string): URL {
  if (connection.secret.provider !== 'subsonic') throw new Error('Subsonic connection is missing its password.');
  const url = subsonicEndpoint(connection.baseUrl, '/rest/stream.view', connection.secret);
  url.searchParams.set('id', itemId);
  url.searchParams.set('format', 'raw');
  return url;
}

function streamRequestHeaders(connection: MusicServerRuntimeConnection, request: Request): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'audio/*, application/octet-stream;q=0.9, */*;q=0.1',
    'Accept-Encoding': 'identity',
    'User-Agent': NEWAMP_USER_AGENT,
  };
  const range = request.headers.get('Range');
  if (range) headers.Range = range;
  const ifRange = request.headers.get('If-Range');
  if (ifRange) headers['If-Range'] = ifRange;
  if (connection.provider === 'jellyfin') Object.assign(headers, jellyfinAuthHeaders(connection));
  return headers;
}

function jellyfinAuthHeaders(connection: Pick<MusicServerRuntimeConnection, 'id' | 'secret'>): Record<string, string> {
  if (connection.secret.provider !== 'jellyfin') throw new Error('Jellyfin connection is missing its access token.');
  return {
    'X-Emby-Authorization': jellyfinAuthorization(connection.id, connection.secret.accessToken),
    'X-MediaBrowser-Token': connection.secret.accessToken,
  };
}

function jellyfinAuthorization(deviceId: string, token?: string): string {
  const parts = [
    `MediaBrowser Client="NewAmp"`,
    `Device="NewAmp"`,
    `DeviceId="${headerToken(deviceId)}"`,
    `Version="${headerToken(NEWAMP_VERSION)}"`,
  ];
  if (token) parts.push(`Token="${headerToken(token)}"`);
  return parts.join(', ');
}

function subsonicEndpoint(baseUrl: string, path: string, secret: Extract<MusicServerConnectionSecret, { provider: 'subsonic' }>): URL {
  const url = endpointUrl(baseUrl, path);
  const salt = randomBytes(8).toString('hex');
  const token = createHash('md5').update(`${secret.password}${salt}`).digest('hex');
  url.searchParams.set('u', secret.username);
  url.searchParams.set('t', token);
  url.searchParams.set('s', salt);
  url.searchParams.set('v', SUBSONIC_API_VERSION);
  url.searchParams.set('c', SUBSONIC_CLIENT_NAME);
  url.searchParams.set('f', 'json');
  return url;
}

async function fetchJson(url: URL, init: RequestInit, options: MusicServerRequestOptions): Promise<unknown> {
  const response = await fetchNoRedirect(url, init, options);
  if (isRedirect(response.status)) {
    response.body?.cancel().catch(() => {});
    throw new Error('Music server request redirected; refusing to forward credentials.');
  }
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    throw new Error(`Music server request failed: HTTP ${response.status}`);
  }
  return JSON.parse(await readTextCapped(response, JSON_BODY_LIMIT));
}

async function fetchNoRedirect(url: URL, init: RequestInit, options: MusicServerRequestOptions): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.trunc(Number(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)));
  const timer = setTimeout(() => controller.abort(new Error('Music server request timed out.')), timeoutMs);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
    init.signal?.removeEventListener('abort', onInitAbort);
  };
  const onExternalAbort = () => controller.abort(options.signal?.reason ?? new Error('Music server request was aborted.'));
  const onInitAbort = () => controller.abort(init.signal?.reason ?? new Error('Music server request was aborted.'));
  if (options.signal) {
    if (options.signal.aborted) onExternalAbort();
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  if (init.signal) {
    if (init.signal.aborted) onInitAbort();
    else init.signal.addEventListener('abort', onInitAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!response.body) {
      cleanup();
      return response;
    }
    return new Response(streamBodyWithCleanup(response.body, cleanup, (err) => {
      if (!controller.signal.aborted) return err;
      const reason = controller.signal.reason;
      return reason instanceof Error ? reason : new Error('Music server request was aborted.');
    }), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (err) {
    cleanup();
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      throw reason instanceof Error ? reason : new Error('Music server request was aborted.');
    }
    throw err;
  }
}

async function fetchStreamNoRedirect(url: URL, init: RequestInit, options: MusicServerRequestOptions): Promise<Response> {
  return new Promise<Response>((resolvePromise, rejectPromise) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    const timeoutMs = Math.max(1, Math.trunc(Number(options.timeoutMs ?? DEFAULT_STREAM_HEADER_TIMEOUT_MS)));
    const transport = url.protocol === 'https:' ? https : http;
    let request: http.ClientRequest | null = null;
    let response: http.IncomingMessage | null = null;
    let settled = false;
    let handedOff = false;
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
      init.signal?.removeEventListener('abort', onInitAbort);
    };
    const failBeforeHeaders = (err: Error) => {
      cleanup();
      if (settled) return;
      settled = true;
      rejectPromise(err);
    };
    const abort = (reason: unknown) => {
      const err = reason instanceof Error ? reason : new Error('Music server request was aborted.');
      if (!handedOff) failBeforeHeaders(err);
      request?.destroy(err);
      response?.destroy(err);
    };
    const onExternalAbort = () => abort(options.signal?.reason ?? new Error('Music server request was aborted.'));
    const onInitAbort = () => abort(init.signal?.reason ?? new Error('Music server request was aborted.'));
    const timer = setTimeout(() => abort(new Error('Music server request timed out.')), timeoutMs);

    if (options.signal) {
      if (options.signal.aborted) onExternalAbort();
      else options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    if (init.signal) {
      if (init.signal.aborted) onInitAbort();
      else init.signal.addEventListener('abort', onInitAbort, { once: true });
    }
    if (settled) return;

    request = transport.request(url, {
      method,
      headers: headersRecord(init.headers),
    }, (res) => {
      response = res;
      handedOff = true;
      settled = true;
      clearTimeout(timer);
      const headers = incomingHeaders(res);
      if (method === 'HEAD') {
        res.resume();
        cleanup();
        resolvePromise(new Response(null, {
          status: res.statusCode ?? 502,
          statusText: res.statusMessage,
          headers,
        }));
        return;
      }
      const body = Readable.toWeb(res) as ReadableStream<Uint8Array>;
      resolvePromise(new Response(streamBodyWithCleanup(body, cleanup), {
        status: res.statusCode ?? 502,
        statusText: res.statusMessage,
        headers,
      }));
    });

    request.on('error', (err) => {
      if (handedOff) return;
      failBeforeHeaders(err instanceof Error ? err : new Error(String(err)));
    });
    request.end();
  });
}

function streamBodyWithCleanup(
  body: ReadableStream<Uint8Array>,
  cleanup: () => void,
  mapReadError: (err: unknown) => unknown = (err) => err,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (err) {
        cleanup();
        controller.error(mapReadError(err));
      }
    },
    async cancel(reason) {
      cleanup();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

function headersRecord(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => { out[key] = value; });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  }
  return Object.fromEntries(
    Object.entries(headers as Record<string, string | number | readonly string[]>)
      .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)]),
  );
}

function incomingHeaders(response: http.IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }
  return headers;
}

async function readTextCapped(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error('Music server response is too large.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('Music server response is too large.');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function endpointUrl(baseUrl: string, path: string): URL {
  const base = new URL(normalizeMusicServerBaseUrl(baseUrl));
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '');
  const childPath = path.replace(/^\/+/, '');
  base.pathname = `${basePath}/${childPath}`;
  base.search = '';
  base.hash = '';
  return base;
}

function assertRuntimeConnection(connection: MusicServerRuntimeConnection): void {
  if (!connection || typeof connection !== 'object') throw new Error('Music server connection is required.');
  if (!isMusicServerProvider(connection.provider)) throw new Error('Music server provider is not supported.');
  normalizeMusicServerConnectionId(connection.id);
  normalizeMusicServerBaseUrl(connection.baseUrl);
  if (!connection.secret || connection.secret.provider !== connection.provider) {
    throw new Error('Music server credentials are missing.');
  }
}

function subsonicResponse(json: unknown): Record<string, unknown> {
  const payload = valueAt(json, ['subsonic-response']);
  if (!payload || typeof payload !== 'object') throw new Error('Subsonic server returned an invalid response.');
  const row = payload as Record<string, unknown>;
  if (row.status !== 'ok') {
    const message = textOf(row, ['error', 'message']);
    throw new Error(message ? `Subsonic server rejected the request: ${message}` : 'Subsonic server rejected the request.');
  }
  return row;
}

function copySafeResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  upstream.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === 'connection'
      || lower === 'transfer-encoding'
      || lower === 'keep-alive'
      || lower === 'proxy-authenticate'
      || lower === 'proxy-authorization'
      || lower === 'te'
      || lower === 'trailer'
      || lower === 'upgrade'
      || lower === 'set-cookie'
      || lower === 'set-cookie2'
      || lower === 'authorization'
      || lower === 'www-authenticate'
    ) {
      return;
    }
    headers.set(key, value);
  });
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  return headers;
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
}

function sanitizeMusicServerError(err: unknown, secrets: Array<string | null | undefined> = []): string {
  let message = err instanceof Error ? err.message : String(err);
  message = message
    .replace(/([?&](?:u|p|t|s|token|api_key|apikey|access_token|session|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b((?:u|p|t|s|token|api_key|apikey|access_token|session|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(Token=")[^"]+(")/gi, '$1[redacted]$2')
    .replace(/(Authorization:\s*)[^\r\n]+/gi, '$1[redacted]');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 2) continue;
    message = message.split(secret).join('[redacted]');
  }
  return message || 'Music server request failed.';
}

function connectionSecrets(connection: Partial<MusicServerRuntimeConnection> | null | undefined): string[] {
  if (!connection?.secret) return [];
  if (connection.secret.provider === 'jellyfin') {
    return [connection.secret.accessToken, connection.secret.username, connection.secret.userId].filter(isPresent);
  }
  return [connection.secret.password, connection.secret.username].filter(isPresent);
}

function connectionIdFor(input: MusicServerConnectionInput, baseUrl: string, username: string): string {
  if (input.connectionId) return normalizeMusicServerConnectionId(input.connectionId);
  return `ms-${createHash('sha256').update(`${input.provider}\n${baseUrl}\n${username}`).digest('hex').slice(0, 24)}`;
}

function normalizeRequiredText(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(message);
  return trimmed;
}

function normalizePassword(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Music server password is required.');
  return value;
}

function normalizeOptionalName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 120) : null;
}

function hostnameName(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname || 'Music server';
  } catch {
    return 'Music server';
  }
}

function headerToken(value: string): string {
  return value.replace(/["\\\r\n]/g, '');
}

function valueAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function textOf(value: unknown, path: string[]): string | null {
  const current = valueAt(value, path);
  if (typeof current !== 'string') return null;
  const trimmed = current.trim();
  return trimmed || null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(isPresent);
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
}

function isPresent(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function finiteInt(value: unknown): number | null {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function ticksToSeconds(value: unknown): number | null {
  const ticks = Number(value);
  if (!Number.isFinite(ticks) || ticks <= 0) return null;
  return Math.round(ticks / 10_000_000);
}

function subsonicBitrate(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n < 5000 ? n * 1000 : n);
}

function jellyfinSampleRate(row: Record<string, unknown>): number | null {
  for (const source of objectArray(row.MediaSources)) {
    for (const stream of objectArray(source.MediaStreams)) {
      const type = textOf(stream, ['Type']);
      if (type && type.toLowerCase() !== 'audio') continue;
      const rate = finiteInt(stream.SampleRate);
      if (rate) return rate;
    }
  }
  return null;
}

function containerFromContentType(value: string | null): string | null {
  if (!value) return null;
  const subtype = value.split(';')[0]!.trim().toLowerCase().split('/')[1];
  return normalizeMusicServerContainer(subtype);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
