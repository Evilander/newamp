// Library Radio Brain — turns NewAmp's local library into a tunable HTTP
// station. Once enabled the user (or any client on their network) can:
//
//   GET /                       -> minimal HTML status page
//   GET /library.m3u            -> M3U8 playlist of every track
//   GET /random.m3u             -> 200-track shuffled playlist
//   GET /tag/:name.m3u          -> tracks carrying a Living Tag
//   GET /audio/:trackId         -> streams the file's audio (WAV via ffmpeg
//                                  fallback for legacy formats, raw bytes
//                                  with proper Content-Type for native)
//
// The intent is to make the library castable: open VLC on a phone, point at
// http://desktop.local:17117/random.m3u, and the queue keeps playing.

import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { extname } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { LibraryStore } from './library.js';
import { remotePageHtml } from './remote-page.js';

const M3U_LIMIT_TRACKS = 5000;

const CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
};

/** Live playback snapshot pushed from the main renderer for remote clients. */
export interface RemoteNowPlaying {
  trackId: number | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  isPlaying: boolean;
  /** Seconds. Snapshot value; clients interpolate from `at` while playing. */
  position: number;
  duration: number;
  /** Perceptual volume 0..2. */
  volume: number;
  /** Epoch ms when this snapshot was taken. */
  at: number;
}

export type RemoteCommand = 'togglePlay' | 'next' | 'prev' | 'seek' | 'setVolume';

export interface RadioBrainOptions {
  library: LibraryStore;
  port: number;
  transcode: (path: string, signal: AbortSignal) => Response;
  ffmpegFallbackExt: (path: string) => boolean;
  /**
   * Shared secret gating EVERY data route — this server binds 0.0.0.0 by
   * design (castability is the point); the token keeps that from meaning
   * "public". The server fails closed when the token is empty.
   */
  getToken: () => string;
  getNowPlaying: () => RemoteNowPlaying | null;
  onNowPlaying: (cb: (state: RemoteNowPlaying | null) => void) => () => void;
  /** Forward a validated transport command into the player. */
  control: (cmd: RemoteCommand, arg?: number) => boolean;
}

export interface RadioBrainStatus {
  enabled: boolean;
  port: number;
  baseUrl: string | null;
  /** Phone-ready URL with the auth token in the #fragment (fragments never hit server logs). */
  remoteUrl: string | null;
  endpoints: string[];
  startedAt: number | null;
  error: string | null;
}

type LifecycleState = 'stopped' | 'starting' | 'running' | 'stopping';

export class RadioBrain {
  private server: Server | null = null;
  private state: LifecycleState = 'stopped';
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly sseCleanups = new Map<ServerResponse, () => void>();
  // The single source of truth for what the server should be doing. start()
  // and stop() just flip this and nudge the reconciler; they never touch
  // `server` directly, so overlapping calls can never leave two listeners
  // or a listener stranded on an abandoned port.
  private wantRunning = false;
  private reconcileWaiters: Array<() => void> = [];
  private reconciling = false;

  constructor(private readonly opts: RadioBrainOptions) {}

  start(): Promise<RadioBrainStatus> {
    this.wantRunning = true;
    return this.kickReconcile();
  }

  stop(): Promise<RadioBrainStatus> {
    this.wantRunning = false;
    return this.kickReconcile();
  }

  private kickReconcile(): Promise<RadioBrainStatus> {
    const settled = new Promise<void>((resolve) => this.reconcileWaiters.push(resolve));
    if (!this.reconciling) {
      this.reconciling = true;
      void this.reconcile();
    }
    return settled.then(() => this.status());
  }

  /**
   * Converges the live server toward `wantRunning`, looping until nothing
   * changed underneath it while it worked. A start immediately followed by
   * a stop (or vice versa) just gets resolved by the next pass instead of
   * racing an in-flight one — this is the only place that ever creates or
   * tears down `server`.
   */
  private async reconcile(): Promise<void> {
    for (;;) {
      const target = this.wantRunning;
      const waiters = this.reconcileWaiters.splice(0, this.reconcileWaiters.length);
      try {
        if (target && !this.server) {
          await this.bringUp();
        } else if (!target && this.server) {
          await this.teardown();
        }
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
      for (const resolve of waiters) resolve();
      if (this.wantRunning === target && this.reconcileWaiters.length === 0) break;
    }
    this.reconciling = false;
  }

  private bringUp(): Promise<void> {
    this.state = 'starting';
    return new Promise((resolve) => {
      const server = createServer((req, res) => this.handle(req, res));
      // Recorded before listen() resolves so a stop that lands mid-start
      // still has a server object to close instead of leaking one.
      this.server = server;
      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
      });
      const onError = (err: Error & { code?: string }) => {
        this.lastError = `${err.code ?? 'error'}: ${err.message}`;
        this.server = null;
        this.state = 'stopped';
        resolve();
      };
      server.once('error', onError);
      server.listen(this.opts.port, '0.0.0.0', () => {
        server.off('error', onError);
        server.on('error', (err) => {
          this.lastError = err instanceof Error ? err.message : String(err);
        });
        this.startedAt = Date.now();
        this.lastError = null;
        this.state = 'running';
        resolve();
      });
    });
  }

  private async teardown(): Promise<void> {
    const server = this.server;
    if (!server) {
      this.state = 'stopped';
      return;
    }
    this.state = 'stopping';
    // server.close() waits for every open connection to end on its own,
    // and /now/events clients are deliberately long-lived — left alone this
    // hangs forever. End the SSE streams and drop any remaining sockets
    // ourselves first so close() has nothing left to wait on.
    for (const [res, cleanup] of this.sseCleanups) {
      cleanup();
      try {
        res.end();
      } catch {
        /* client already gone */
      }
    }
    this.sseCleanups.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    this.server = null;
    this.startedAt = null;
    this.state = 'stopped';
  }

  status(): RadioBrainStatus {
    const enabled = this.state === 'running';
    const baseUrl = enabled ? `http://${localAddress()}:${this.opts.port}` : null;
    return {
      enabled,
      port: this.opts.port,
      baseUrl,
      remoteUrl: baseUrl ? `${baseUrl}/remote#${this.opts.getToken()}` : null,
      endpoints: enabled
        ? ['/remote', '/now', '/now/events', '/control', '/art/:trackId', '/library.m3u', '/random.m3u', '/tag/:name.m3u', '/audio/:trackId']
        : [],
      startedAt: this.startedAt,
      error: this.lastError,
    };
  }

  /** Test-only window into live connection bookkeeping — not used at runtime. */
  debugConnectionCounts(): { sockets: number; sseClients: number } {
    return { sockets: this.sockets.size, sseClients: this.sseCleanups.size };
  }

  /**
   * Constant-time token check. Accepts `?token=` (playlist/audio URLs — VLC
   * cannot send headers) or the `x-newamp-token` header (the remote page).
   */
  private authorized(url: URL, req: IncomingMessage): boolean {
    const expected = this.opts.getToken();
    if (!expected) return false; // fail closed
    const presented = url.searchParams.get('token') ?? String(req.headers['x-newamp-token'] ?? '');
    if (!presented) return false;
    const a = createHash('sha256').update(presented).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = decodeURIComponent(url.pathname);

      // The remote page shell is the ONLY unauthenticated route — it contains
      // no data (the token rides the URL #fragment, which never reaches the
      // server; the page presents it per-request as a header).
      if ((req.method === 'GET' || req.method === 'HEAD') && path === '/remote') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(remotePageHtml());
        return;
      }

      // Everything else — the status page and every stream included — is
      // token-gated.
      if (!this.authorized(url, req)) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Unauthorized. Open Settings -> Radio Brain in NewAmp for the link.');
        return;
      }

      if (req.method === 'POST' && path === '/control') {
        return await this.respondControl(req, res);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET, HEAD, POST');
        res.end('Method Not Allowed');
        return;
      }
      if (path === '/now') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(this.opts.getNowPlaying()));
        return;
      }
      if (path === '/now/events') {
        return this.respondNowEvents(req, res);
      }
      const artMatch = /^\/art\/(\d+)$/.exec(path);
      if (artMatch) {
        const art = this.opts.library.getArt(Number(artMatch[1]));
        if (!art) {
          res.statusCode = 404;
          res.end('No art');
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', art.mime);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.end(Buffer.from(art.data));
        return;
      }
      if (path === '/' || path === '/index.html') {
        return this.respondStatusPage(res);
      }
      if (path === '/library.m3u') {
        const ids = this.opts.library.getTrackIds({ sort: 'artist', limit: M3U_LIMIT_TRACKS });
        return this.respondM3u(res, req, ids, 'library');
      }
      if (path === '/random.m3u') {
        const all = this.opts.library.getTrackIds({ sort: 'artist', limit: M3U_LIMIT_TRACKS });
        shuffleInPlace(all);
        return this.respondM3u(res, req, all.slice(0, 200), 'random');
      }
      const tagMatch = /^\/tag\/([a-z0-9_-]+)\.m3u$/i.exec(path);
      if (tagMatch) {
        const name = tagMatch[1]!.toLowerCase();
        const ids = this.opts.library.getTrackIdsByTag(name);
        return this.respondM3u(res, req, ids.slice(0, M3U_LIMIT_TRACKS), `tag/${name}`);
      }
      const audioMatch = /^\/audio\/(\d+)$/.exec(path);
      if (audioMatch) {
        const id = Number(audioMatch[1]);
        return await this.respondAudio(res, req, id);
      }
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`Not found: ${path}\n\nSee / for endpoints.`);
    } catch (err) {
      if (res.headersSent) {
        // Already streaming a response (likely audio) - just drop the socket
        // so the client doesn't receive a chimera of audio bytes + error text.
        res.destroy();
        return;
      }
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private respondNowEvents(req: IncomingMessage, res: ServerResponse): void {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (state: RemoteNowPlaying | null): void => {
      res.write(`data: ${JSON.stringify(state)}\n\n`);
    };
    send(this.opts.getNowPlaying());
    const off = this.opts.onNowPlaying(send);
    // Heartbeat keeps proxies/phone radios from reaping the idle socket.
    const heartbeat = setInterval(() => res.write(': hb\n\n'), 25_000);
    heartbeat.unref?.();
    const cleanup = (): void => {
      clearInterval(heartbeat);
      off();
      this.sseCleanups.delete(res);
    };
    // Tracked so stop() can end these deliberately-long-lived streams
    // itself instead of waiting on the client to disconnect.
    this.sseCleanups.set(res, cleanup);
    req.on('close', cleanup);
  }

  private async respondControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 4096) {
        res.statusCode = 413;
        res.end('Payload too large');
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let cmd: string | undefined;
    let arg: number | undefined;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        cmd?: unknown;
        arg?: unknown;
      };
      cmd = typeof body.cmd === 'string' ? body.cmd : undefined;
      arg = typeof body.arg === 'number' && Number.isFinite(body.arg) ? body.arg : undefined;
    } catch {
      /* falls through to 400 */
    }
    const allowed: RemoteCommand[] = ['togglePlay', 'next', 'prev', 'seek', 'setVolume'];
    if (!cmd || !allowed.includes(cmd as RemoteCommand)) {
      res.statusCode = 400;
      res.end('Bad command');
      return;
    }
    const ok = this.opts.control(cmd as RemoteCommand, arg);
    res.statusCode = ok ? 200 : 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok }));
  }

  private respondStatusPage(res: ServerResponse): void {
    const stats = this.opts.library.getStats();
    const tagSummaries = this.opts.library.getTagSummaries();
    const baseUrl = this.status().baseUrl ?? '';
    const tagLinks = tagSummaries.length
      ? tagSummaries
          .slice(0, 12)
          .map((s) => `<a href="/tag/${encodeURIComponent(s.name)}.m3u">${escapeHtml(s.name)} (${s.trackCount})</a>`)
          .join(' · ')
      : '<em>No Living Tags computed yet — define a rule in NewAmp to enable tag streams.</em>';
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>NewAmp Radio Brain</title>
<style>
  body { background: #0e0d10; color: #e3e1e6; font: 14px/1.5 -apple-system, system-ui, "Segoe UI", sans-serif; margin: 0 auto; max-width: 700px; padding: 32px; }
  h1 { font-size: 18px; letter-spacing: 0.06em; text-transform: uppercase; color: #98ffd1; margin: 0 0 6px; }
  .sub { color: #6f6a78; font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 24px; }
  .grid { display: grid; gap: 14px; }
  .card { background: #1a181d; border: 1px solid #2b2731; border-radius: 10px; padding: 14px 16px; }
  .card h2 { font-size: 12px; margin: 0 0 6px; color: #b8b1c1; text-transform: uppercase; letter-spacing: 0.08em; }
  .card a { color: #98ffd1; text-decoration: none; font-family: ui-monospace, monospace; }
  .card a:hover { text-decoration: underline; }
  .card p { margin: 0; color: #918aa0; font-size: 12px; }
  .stats { display: flex; gap: 24px; font-family: ui-monospace, monospace; color: #b8b1c1; }
  .stats b { color: #98ffd1; }
  code { color: #d5cee0; }
</style>
<h1>NewAmp Radio Brain</h1>
<div class="sub">${escapeHtml(baseUrl)}</div>
<div class="stats">
  <span><b>${stats.tracks.toLocaleString()}</b> tracks</span>
  <span><b>${stats.albums.toLocaleString()}</b> albums</span>
  <span><b>${stats.artists.toLocaleString()}</b> artists</span>
</div>
<div class="grid" style="margin-top: 24px;">
  <div class="card">
    <h2>Whole library</h2>
    <a href="/library.m3u">/library.m3u</a>
    <p>Every track, sorted by artist. Limited to ${M3U_LIMIT_TRACKS.toLocaleString()} entries per playlist.</p>
  </div>
  <div class="card">
    <h2>Shuffle</h2>
    <a href="/random.m3u">/random.m3u</a>
    <p>200 tracks, freshly shuffled on every fetch.</p>
  </div>
  <div class="card">
    <h2>Living Tag streams</h2>
    <p>${tagLinks}</p>
  </div>
  <div class="card">
    <h2>Track audio</h2>
    <code>/audio/{trackId}</code>
    <p>Each M3U entry resolves to this endpoint. Native formats stream raw; legacy formats stream WAV via ffmpeg.</p>
  </div>
</div>`);
  }

  private respondM3u(res: ServerResponse, req: IncomingMessage, trackIds: number[], label: string): void {
    const host = req.headers.host ?? `localhost:${this.opts.port}`;
    const base = `http://${host}`;
    const tokenQuery = `?token=${encodeURIComponent(this.opts.getToken())}`;
    const lines: string[] = ['#EXTM3U', `#PLAYLIST:NewAmp Radio Brain — ${label}`];
    if (trackIds.length) {
      const tracks = this.opts.library.getTracksByIdsInOrder(trackIds);
      for (const track of tracks) {
        const duration = track.duration ? Math.max(1, Math.round(track.duration)) : -1;
        // Strip newlines + carriage returns so malformed tags can't smuggle
        // extra #EXTINF lines or absolute URLs into the playlist.
        const sanitizedArtist = (track.artist ?? 'Unknown').replace(/[\r\n]+/g, ' ');
        const sanitizedTitle = (track.title ?? 'Unknown').replace(/[\r\n]+/g, ' ');
        lines.push(`#EXTINF:${duration},${sanitizedArtist} - ${sanitizedTitle}`);
        lines.push(`${base}/audio/${track.id}${tokenQuery}`);
      }
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(lines.join('\n'));
  }

  private async respondAudio(res: ServerResponse, req: IncomingMessage, id: number): Promise<void> {
    const track = this.opts.library.getTrack(id);
    if (!track) {
      res.statusCode = 404;
      res.end('Track not found');
      return;
    }
    const ext = extname(track.path).toLowerCase();
    if (this.opts.ffmpegFallbackExt(track.path)) {
      const controller = new AbortController();
      req.on('close', () => controller.abort());
      const response = this.opts.transcode(track.path, controller.signal);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        if (!res.headersSent) res.setHeader(key, value);
      });
      if (!response.body) {
        res.end();
        return;
      }
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
      res.end();
      return;
    }
    let size = 0;
    try {
      size = statSync(track.path).size;
    } catch {
      res.statusCode = 404;
      res.end('Track file missing');
      return;
    }
    // Real single-range support — the Accept-Ranges header used to be
    // advertised without honoring Range at all, so every phone-scrubber seek
    // re-downloaded the whole file.
    const rangeHeader = String(req.headers.range ?? '');
    const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    let start = 0;
    let end = size - 1;
    let partial = false;
    if (rangeMatch && (rangeMatch[1] || rangeMatch[2])) {
      if (rangeMatch[1]) {
        start = Number(rangeMatch[1]);
        end = rangeMatch[2] ? Math.min(size - 1, Number(rangeMatch[2])) : size - 1;
      } else {
        // suffix range: last N bytes
        start = Math.max(0, size - Number(rangeMatch[2]));
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${size}`);
        res.end();
        return;
      }
      partial = true;
    }
    res.statusCode = partial ? 206 : 200;
    res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(end - start + 1));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    if (partial) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    const stream = createReadStream(track.path, { start, end });
    req.on('close', () => stream.destroy());
    stream.on('error', () => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
    stream.pipe(res);
  }
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

function localAddress(): string {
  const interfaces = networkInterfaces();
  for (const list of Object.values(interfaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );
}
