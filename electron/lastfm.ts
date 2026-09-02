import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { durableWriteFileAsync, renameOverExistingAsync } from './recovery.js';
import type {
  AppSettings,
  LastfmAuthStart,
  LastfmOutboxStatus,
  LastfmSession,
  LastfmTrackPayload,
} from '../shared/types.js';

const LASTFM_API_ROOT = 'https://ws.audioscrobbler.com/2.0/';
const LASTFM_AUTH_ROOT = 'https://www.last.fm/api/auth/';

type LastfmParams = Record<string, string | number | null | undefined>;

interface LastfmSessionResponse {
  session?: {
    name?: string;
    key?: string;
  };
  error?: number;
  message?: string;
}

interface LastfmTokenResponse {
  token?: string;
  error?: number;
  message?: string;
}

export interface LastfmCachedScrobble {
  id: string;
  track: LastfmTrackPayload;
  timestamp: number;
  attempts: number;
  createdAt: number;
  lastAttemptAt: number | null;
  lastError: string | null;
  // Set when the item's last attempt failed because the Last.fm session
  // itself is invalid (revoked access, expired key), not because of a
  // transient outage. See flush() below.
  authFailure: boolean;
}

export interface LastfmOutboxFlushResult {
  sent: number;
  remaining: number;
  needsReconnect: boolean;
}

export class LastfmApiError extends Error {
  readonly code: number | null;
  readonly status: number;
  readonly retryable: boolean;
  readonly authFailure: boolean;

  constructor(message: string, { code, status }: { code: number | null; status: number }) {
    super(code ? `Last.fm ${code}: ${message}` : message);
    this.name = 'LastfmApiError';
    this.code = code;
    this.status = status;
    this.retryable = isRetryableLastfmFailure(code, status);
    this.authFailure = isAuthLastfmFailure(code);
  }
}

export function signLastfmParams(params: LastfmParams, sharedSecret: string): string {
  const payload = Object.entries(params)
    .filter(([key, value]) =>
      key !== 'format' && key !== 'callback' && key !== 'api_sig' && value !== null && value !== undefined,
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}${String(value)}`)
    .join('');
  return createHash('md5').update(`${payload}${sharedSecret}`, 'utf8').digest('hex');
}

export function buildLastfmTrackParams(track: LastfmTrackPayload): Record<string, string> {
  const params: Record<string, string> = {
    artist: track.artist,
    track: track.title,
  };
  if (track.album) params.album = track.album;
  if (track.albumArtist) params.albumArtist = track.albumArtist;
  if (track.duration && track.duration > 0) params.duration = String(Math.round(track.duration));
  if (track.trackNumber && track.trackNumber > 0) params.trackNumber = String(track.trackNumber);
  return params;
}

export function shouldScrobble({
  duration,
  currentTime,
}: {
  duration: number | null | undefined;
  currentTime: number;
}): boolean {
  if (!duration || duration <= 30) return false;
  return currentTime >= Math.min(duration / 2, 240);
}

export class LastfmScrobbleOutbox {
  // The one authoritative copy of the queue once loaded. Every mutation
  // (enqueue, flush's reconcile step, and any future destructive op) reads
  // and writes THIS array — never a fresh read of the file. That's what
  // closes the old data-loss race: enqueue() and flush() used to each do
  // their own read-file -> mutate -> write-file round trip, so an item
  // enqueue()d while an earlier flush() was still awaiting send() got
  // silently erased when that flush finished and wrote its now-stale
  // snapshot back over it.
  private state: LastfmCachedScrobble[] | null = null;
  private loading: Promise<LastfmCachedScrobble[]> | null = null;
  // Serializes every mutation against `state` behind a promise chain so
  // overlapping enqueue()/flush() calls can never interleave their
  // read-modify-write. Deliberately NOT held across the network wait in
  // flush() (see below) — that would stall every enqueue() for as long as a
  // Last.fm request takes.
  private mutex: Promise<void> = Promise.resolve();
  // Ids a flush() call is currently sending. A second flush that starts
  // while the first is still in its network phase skips these, so the same
  // scrobble can never be POSTed to Last.fm twice.
  private readonly sending = new Set<string>();
  private writeSeq = 0;

  constructor(private readonly file: string) {}

  private async ensureLoaded(): Promise<LastfmCachedScrobble[]> {
    if (this.state) return this.state;
    if (!this.loading) this.loading = this.readFromDisk();
    this.state = await this.loading;
    return this.state;
  }

  private async readFromDisk(): Promise<LastfmCachedScrobble[]> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((item) => {
        const scrobble = normalizeCachedScrobble(item);
        return scrobble ? [scrobble] : [];
      });
    } catch {
      return [];
    }
  }

  // Runs `fn` with exclusive access to `state`, queued behind whatever
  // mutation (if any) is already in progress.
  private async withState<T>(fn: () => Promise<T> | T): Promise<T> {
    const prior = this.mutex;
    let release: () => void = () => {};
    this.mutex = new Promise((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      await this.ensureLoaded();
      return await fn();
    } finally {
      release();
    }
  }

  async list(): Promise<LastfmCachedScrobble[]> {
    return this.withState(() => [...this.state!]);
  }

  async status(): Promise<LastfmOutboxStatus> {
    return this.withState(() => {
      const items = this.state!;
      return {
        pending: items.length,
        oldestCreatedAt: items[0]?.createdAt ?? null,
        lastError: [...items].reverse().find((item) => item.lastError)?.lastError ?? null,
        needsReconnect: items.some((item) => item.authFailure),
      };
    });
  }

  async enqueue(
    track: LastfmTrackPayload,
    timestamp: number,
    lastError: string | null = null,
  ): Promise<LastfmCachedScrobble> {
    return this.withState(async () => {
      const item: LastfmCachedScrobble = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        track: sanitizeTrack(track),
        timestamp: Math.max(0, Math.trunc(timestamp)),
        attempts: 0,
        createdAt: Date.now(),
        lastAttemptAt: null,
        lastError,
        authFailure: false,
      };
      // Bounded from the current authoritative state, not a stale snapshot.
      this.state = [...this.state!, item].slice(-500);
      await this.persist();
      return item;
    });
  }

  async flush(
    send: (item: LastfmCachedScrobble) => Promise<void>,
  ): Promise<LastfmOutboxFlushResult> {
    // Phase 1: snapshot the batch to send and mark it as in-flight, then
    // release the lock immediately. Items already claimed by another
    // in-progress flush are excluded so they're never sent twice; anything
    // enqueued after this snapshot is simply not part of this flush's batch
    // and is left alone.
    const batch = await this.withState(() => {
      const candidates = this.state!.filter((item) => !this.sending.has(item.id));
      for (const item of candidates) this.sending.add(item.id);
      return candidates;
    });

    const sentIds = new Set<string>();
    // Permanently-invalid, non-auth failures (e.g. malformed request) are
    // dropped outright rather than retried — tracked separately from
    // `failures` because a dropped item is removed from the queue, not kept
    // with a bumped attempt count.
    const droppedIds = new Set<string>();
    const failures = new Map<string, { lastError: string; authFailure: boolean }>();
    let sent = 0;
    let needsReconnect = false;
    let blocked = false;
    let remaining = 0;

    try {
      // Phase 2: the actual network sends, entirely OUTSIDE the mutex, so
      // enqueue() (and any concurrent flush's phase 1) can run freely while
      // this is in flight.
      for (const item of batch) {
        if (blocked) continue;
        try {
          await send(item);
          sentIds.add(item.id);
          sent += 1;
        } catch (err) {
          const authFailure = err instanceof LastfmApiError && err.authFailure;
          if (authFailure) {
            // The session itself is invalid (revoked access, expired key) —
            // every later item would fail the exact same way, so there's no
            // point burning requests on them. Keep this item (and everything
            // behind it) queued rather than dropping it, stop the flush, and
            // tell the caller to prompt a reconnect instead of quietly
            // blocking forever with no way for the user to find out. Once
            // the user reconnects, the next flush retries from the top.
            failures.set(item.id, { lastError: errorMessage(err), authFailure: true });
            needsReconnect = true;
            blocked = true;
            continue;
          }
          if (!shouldRetryLastfmError(err)) {
            droppedIds.add(item.id); // permanently invalid: drop it
            continue;
          }
          failures.set(item.id, {
            lastError: errorMessage(err),
            // A transient failure this time clears any stale auth-failure
            // flag from an earlier round, so needsReconnect always reflects
            // the most recent reason this item didn't send.
            authFailure: false,
          });
          blocked = true;
        }
      }
    } finally {
      // Phase 3: reconcile against whatever the CURRENT authoritative state
      // is — which may now include items enqueued while phase 2 was
      // running — instead of overwriting it with a stale snapshot. Only ids
      // this flush actually sent or failed are touched; everything else
      // (untouched batch items behind a block, and anything enqueued
      // meanwhile) passes through unchanged.
      await this.withState(async () => {
        for (const item of batch) this.sending.delete(item.id);
        const next = this.state!.flatMap((item) => {
          if (sentIds.has(item.id) || droppedIds.has(item.id)) return [];
          const failure = failures.get(item.id);
          if (!failure) return [item];
          return [
            {
              ...item,
              attempts: item.attempts + 1,
              lastAttemptAt: Date.now(),
              lastError: failure.lastError,
              authFailure: failure.authFailure,
            },
          ];
        });
        this.state = next.slice(-500);
        remaining = this.state.length;
        await this.persist();
      });
    }

    return { sent, remaining, needsReconnect };
  }

  // Crash-safe write: tmp file + fsync + atomic rename over the target (see
  // electron/recovery.ts), so a crash mid-write can only ever lose the temp
  // file, never truncate or corrupt the last good outbox on disk.
  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const payload = JSON.stringify(this.state, null, 2);
    const tmp = `${this.file}.tmp-${process.pid}-${++this.writeSeq}`;
    try {
      await durableWriteFileAsync(tmp, payload);
      await renameOverExistingAsync(tmp, this.file);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
}

export async function startLastfmAuth(settings: AppSettings): Promise<LastfmAuthStart> {
  const { apiKey, sharedSecret } = requireLastfmCredentials(settings);
  const token = await getLastfmToken(apiKey, sharedSecret);
  const authUrl = `${LASTFM_AUTH_ROOT}?${new URLSearchParams({ api_key: apiKey, token })}`;
  return { authUrl, token };
}

export async function completeLastfmAuth(settings: AppSettings): Promise<LastfmSession> {
  const { apiKey, sharedSecret } = requireLastfmCredentials(settings);
  const token = settings.lastfmAuthToken?.trim();
  if (!token) throw new Error('Start Last.fm authorization before completing it.');
  const params = {
    method: 'auth.getSession',
    api_key: apiKey,
    token,
  };
  const data = await lastfmPost<LastfmSessionResponse>({
    ...params,
    api_sig: signLastfmParams(params, sharedSecret),
  });
  const username = data.session?.name;
  const sessionKey = data.session?.key;
  if (!username || !sessionKey) throw new Error('Last.fm did not return a session key.');
  return { username, sessionKey };
}

export async function updateLastfmNowPlaying(
  settings: AppSettings,
  track: LastfmTrackPayload,
): Promise<void> {
  if (!isLastfmReady(settings) || !isScrobbleableTrack(track)) return;
  await signedLastfmPost(settings, {
    method: 'track.updateNowPlaying',
    ...buildLastfmTrackParams(track),
  });
}

export async function scrobbleLastfmTrack(
  settings: AppSettings,
  track: LastfmTrackPayload,
  timestamp: number,
): Promise<void> {
  if (!isLastfmReady(settings) || !isScrobbleableTrack(track)) return;
  const params = buildLastfmTrackParams(track);
  await signedLastfmPost(settings, {
    method: 'track.scrobble',
    'artist[0]': params.artist,
    'track[0]': params.track,
    'timestamp[0]': Math.max(0, Math.trunc(timestamp)),
    ...(params.album ? { 'album[0]': params.album } : {}),
    ...(params.albumArtist ? { 'albumArtist[0]': params.albumArtist } : {}),
    ...(params.duration ? { 'duration[0]': params.duration } : {}),
    ...(params.trackNumber ? { 'trackNumber[0]': params.trackNumber } : {}),
  });
}

async function getLastfmToken(apiKey: string, sharedSecret: string): Promise<string> {
  const params = {
    method: 'auth.getToken',
    api_key: apiKey,
  };
  const data = await lastfmPost<LastfmTokenResponse>({
    ...params,
    api_sig: signLastfmParams(params, sharedSecret),
  });
  if (!data.token) throw new Error('Last.fm did not return an authorization token.');
  return data.token;
}

async function signedLastfmPost(settings: AppSettings, params: LastfmParams): Promise<void> {
  const { apiKey, sharedSecret, sessionKey } = requireLastfmSession(settings);
  await lastfmPost({
    ...params,
    api_key: apiKey,
    sk: sessionKey,
    api_sig: signLastfmParams({ ...params, api_key: apiKey, sk: sessionKey }, sharedSecret),
  });
}

async function lastfmPost<T>(params: LastfmParams): Promise<T> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, format: 'json' })) {
    if (value !== null && value !== undefined) body.set(key, String(value));
  }
  const response = await fetch(LASTFM_API_ROOT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body,
  });
  const text = await response.text();
  let data: { error?: number | string; message?: string };
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new LastfmApiError(`Last.fm returned a non-JSON response (${response.status}).`, {
      code: null,
      status: response.status,
    });
  }
  const code = normalizeLastfmErrorCode(data.error);
  if (!response.ok || code) {
    throw new LastfmApiError(data.message || `Last.fm request failed (${response.status}).`, {
      code,
      status: response.status,
    });
  }
  return data as T;
}

export function shouldRetryLastfmError(err: unknown): boolean {
  if (err instanceof LastfmApiError) return err.retryable;
  return true;
}

// Terminal credential failure: retrying is pointless, but callers still need to
// tell it apart from an ordinary rejection so the play can be preserved and the
// "reconnect Last.fm" state can surface.
export function isLastfmAuthFailure(err: unknown): boolean {
  return err instanceof LastfmApiError && err.authFailure;
}

// Authentication Failed / Invalid session key / Invalid API key: the
// credentials themselves are bad, not the service. Retrying with the same
// session key can never succeed — every scrobble will fail identically
// until the user reconnects — so these are terminal, not transient.
const LASTFM_AUTH_FAILURE_CODES = new Set([4, 9, 10]);

function isAuthLastfmFailure(code: number | null): boolean {
  return code !== null && LASTFM_AUTH_FAILURE_CODES.has(code);
}

function isRetryableLastfmFailure(code: number | null, status: number): boolean {
  if (code !== null) {
    if (LASTFM_AUTH_FAILURE_CODES.has(code)) return false;
    return code === 11 || code === 16 || code === 29;
  }
  return status === 200 || status === 408 || status === 429 || status >= 500;
}

function normalizeLastfmErrorCode(value: number | string | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

function isLastfmReady(settings: AppSettings): boolean {
  return !!(
    settings.lastfmEnabled &&
    settings.lastfmApiKey &&
    settings.lastfmSharedSecret &&
    settings.lastfmSessionKey
  );
}

function isScrobbleableTrack(track: LastfmTrackPayload): boolean {
  return !!(track.artist.trim() && track.title.trim() && track.artist !== 'Unknown Artist');
}

function requireLastfmCredentials(settings: AppSettings): {
  apiKey: string;
  sharedSecret: string;
} {
  const apiKey = settings.lastfmApiKey?.trim();
  const sharedSecret = settings.lastfmSharedSecret?.trim();
  if (!apiKey || !sharedSecret) {
    throw new Error('Add a Last.fm API key and shared secret first.');
  }
  return { apiKey, sharedSecret };
}

function requireLastfmSession(settings: AppSettings): {
  apiKey: string;
  sharedSecret: string;
  sessionKey: string;
} {
  const { apiKey, sharedSecret } = requireLastfmCredentials(settings);
  const sessionKey = settings.lastfmSessionKey?.trim();
  if (!sessionKey) throw new Error('Connect a Last.fm account first.');
  return { apiKey, sharedSecret, sessionKey };
}

function normalizeCachedScrobble(item: unknown): LastfmCachedScrobble | null {
  if (!item || typeof item !== 'object') return null;
  const raw = item as Partial<LastfmCachedScrobble>;
  if (!raw.track || typeof raw.timestamp !== 'number') return null;
  const track = sanitizeTrack(raw.track);
  if (!isScrobbleableTrack(track)) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `${Date.now()}-${Math.random()}`,
    track,
    timestamp: Math.max(0, Math.trunc(raw.timestamp)),
    attempts: Math.max(0, Math.trunc(raw.attempts ?? 0)),
    createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now(),
    lastAttemptAt: Number.isFinite(raw.lastAttemptAt) ? Number(raw.lastAttemptAt) : null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    // Outbox files written before this field existed default to false —
    // treated as "unknown, not currently known to be an auth problem",
    // which is exactly right: the next flush attempt re-classifies it.
    authFailure: raw.authFailure === true,
  };
}

function sanitizeTrack(track: LastfmTrackPayload): LastfmTrackPayload {
  return {
    artist: String(track.artist ?? '').trim(),
    title: String(track.title ?? '').trim(),
    album: track.album ? String(track.album).trim() : null,
    albumArtist: track.albumArtist ? String(track.albumArtist).trim() : null,
    duration: typeof track.duration === 'number' && Number.isFinite(track.duration)
      ? Math.max(0, track.duration)
      : null,
    trackNumber: typeof track.trackNumber === 'number' && Number.isFinite(track.trackNumber)
      ? Math.max(0, Math.trunc(track.trackNumber))
      : null,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
