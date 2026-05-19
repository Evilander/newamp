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

import { createReadStream, statSync } from 'node:fs';
import { extname } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { LibraryStore } from './library.js';

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

export interface RadioBrainOptions {
  library: LibraryStore;
  port: number;
  transcode: (path: string, signal: AbortSignal) => Response;
  ffmpegFallbackExt: (path: string) => boolean;
}

export interface RadioBrainStatus {
  enabled: boolean;
  port: number;
  baseUrl: string | null;
  endpoints: string[];
  startedAt: number | null;
  error: string | null;
}

export class RadioBrain {
  private server: Server | null = null;
  private startedAt: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly opts: RadioBrainOptions) {}

  start(): Promise<RadioBrainStatus> {
    if (this.server) {
      return Promise.resolve(this.status());
    }
    return new Promise((resolve) => {
      const server = createServer((req, res) => this.handle(req, res));
      const onError = (err: Error & { code?: string }) => {
        this.lastError = `${err.code ?? 'error'}: ${err.message}`;
        server.close();
        this.server = null;
        this.startedAt = null;
        resolve(this.status());
      };
      server.once('error', onError);
      server.listen(this.opts.port, '0.0.0.0', () => {
        this.server = server;
        this.startedAt = Date.now();
        this.lastError = null;
        server.off('error', onError);
        server.on('error', (err) => {
          this.lastError = err instanceof Error ? err.message : String(err);
        });
        resolve(this.status());
      });
    });
  }

  stop(): Promise<RadioBrainStatus> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve(this.status());
        return;
      }
      this.server.close(() => {
        this.server = null;
        this.startedAt = null;
        resolve(this.status());
      });
    });
  }

  status(): RadioBrainStatus {
    const enabled = !!this.server;
    return {
      enabled,
      port: this.opts.port,
      baseUrl: enabled ? `http://${localAddress()}:${this.opts.port}` : null,
      endpoints: enabled
        ? ['/', '/library.m3u', '/random.m3u', '/tag/:name.m3u', '/audio/:trackId']
        : [],
      startedAt: this.startedAt,
      error: this.lastError,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET, HEAD');
        res.end('Method Not Allowed');
        return;
      }
      const path = decodeURIComponent(url.pathname);
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
        lines.push(`${base}/audio/${track.id}`);
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
    res.statusCode = 200;
    res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(size));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    const stream = createReadStream(track.path);
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
