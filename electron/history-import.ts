import {
  normalizeHistoryImportEntry,
  HISTORY_IMPORT_MAX_ENTRIES,
  parseHistoryImport,
  type HistoryImportEntry,
  type HistoryImportIssue,
  type HistoryImportParseResult,
  type LastfmHistoryProgress,
} from '../shared/history-import.js';

export {
  HISTORY_IMPORT_MAX_ENTRIES,
  parseHistoryImport,
  type HistoryImportEntry,
  type HistoryImportFormat,
  type HistoryImportIssue,
  type HistoryImportParseResult,
  type HistoryImportReport,
  type LastfmHistoryProgress,
} from '../shared/history-import.js';

export interface FetchLastfmHistoryInput {
  username: string;
  apiKey: string;
  signal?: AbortSignal;
  maxPages?: number;
  requestTimeoutMs?: number;
  // First wait before a page is asked for again; later waits double.
  retryDelayMs?: number;
  toUnixSeconds?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: LastfmHistoryProgress) => void;
}

interface LastfmRecentTracksResponse {
  recenttracks?: {
    '@attr'?: {
      page?: string | number;
      totalPages?: string | number;
    };
    track?: unknown[] | unknown;
  };
  error?: number;
  message?: string;
}

const LASTFM_API_ROOT = 'https://ws.audioscrobbler.com/2.0/';
const LASTFM_PAGE_LIMIT = 200;
const LASTFM_REQUEST_SPACING_MS = 260;
const LASTFM_REQUEST_TIMEOUT_MS = 15_000;
// A 500-page history takes minutes, so one bad page is asked for again
// (with the wait growing each time) instead of ending the whole import.
const LASTFM_PAGE_ATTEMPTS = 4;
const LASTFM_RETRY_DELAY_MS = 1_000;
const LASTFM_MAX_RETRY_WAIT_MS = 30_000;
// Backend failed, service offline, temporarily unavailable, rate limited.
const LASTFM_RETRYABLE_CODES = new Set([8, 11, 16, 29]);

class LastfmPageRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'LastfmPageRequestError';
  }
}

export class LastfmHistoryImportTruncatedError extends Error {
  constructor(
    message: string,
    public readonly partial: HistoryImportParseResult & { pagesFetched: number },
  ) {
    super(message);
    this.name = 'LastfmHistoryImportTruncatedError';
  }
}

export async function fetchLastfmHistory(input: FetchLastfmHistoryInput): Promise<HistoryImportParseResult & { pagesFetched: number }> {
  const username = input.username.trim();
  const apiKey = input.apiKey.trim();
  if (!username) throw new Error('Last.fm username is required.');
  if (!apiKey) throw new Error('Last.fm API key is required.');

  const fetcher = input.fetchImpl ?? fetch;
  const maxPages = normalizeMaxPages(input.maxPages);
  const entries: HistoryImportEntry[] = [];
  const invalidSamples: HistoryImportIssue[] = [];
  let invalid = 0;
  let totalRows = 0;
  let totalPages: number | null = null;
  let pagesFetched = 0;
  let skippedNowPlaying = 0;
  let lastRequestStarted = 0;
  const toUnixSeconds = normalizeToUnixSeconds(input.toUnixSeconds);

  for (let page = 1; page <= maxPages; page += 1) {
    input.signal?.throwIfAborted();
    await waitForLastfmRateLimit(lastRequestStarted, input.signal);
    lastRequestStarted = Date.now();
    const data = await fetchLastfmPage(fetcher, buildLastfmRecentTracksUrl({ username, apiKey, page, toUnixSeconds }), input);
    if (!isRecord(data.recenttracks) || !Object.hasOwn(data.recenttracks, 'track')) {
      throw new Error('Last.fm returned a malformed recenttracks response.');
    }

    pagesFetched = page;
    const attr = data.recenttracks?.['@attr'];
    const reportedPage = parsePositiveInt(attr?.page);
    const reportedPages = Number(attr?.totalPages);
    if (reportedPage !== page || attr?.totalPages == null || !Number.isSafeInteger(reportedPages) || reportedPages < 0 || (reportedPages > 0 && reportedPages < page)) {
      throw new Error('Last.fm returned invalid pagination. No history was imported.');
    }
    if (totalPages !== null && totalPages !== reportedPages) throw new Error('Last.fm history changed during pagination. Please retry.');
    totalPages = reportedPages;
    if (reportedPages > Math.ceil(HISTORY_IMPORT_MAX_ENTRIES / LASTFM_PAGE_LIMIT)) {
      throw new Error('Last.fm history exceeds the 500,000-play import limit. Import a CSV or JSON export in smaller files.');
    }
    const tracks = normalizeLastfmTrackArray(data.recenttracks?.track);
    if ((reportedPages === 0 && tracks.length > 0) || (page < reportedPages && tracks.length === 0)) throw new Error('Last.fm returned an incomplete history page. No history was imported.');
    totalRows += tracks.length;
    tracks.forEach((track, index) => {
      const normalized = normalizeHistoryImportEntry(track, totalRows - tracks.length + index + 1, 'lastfm');
      if ('reason' in normalized) {
        if (normalized.reason === 'now-playing-without-final-timestamp') {
          skippedNowPlaying += 1;
        } else {
          invalid += 1;
          if (invalidSamples.length < 10) invalidSamples.push(normalized);
        }
      } else {
        entries.push(normalized);
      }
    });
    if (entries.length > HISTORY_IMPORT_MAX_ENTRIES) throw new Error('Last.fm history exceeds the 500,000-play import limit.');
    input.onProgress?.({ page, totalPages, entries: entries.length, invalid, skippedNowPlaying });
    if (totalPages != null && page >= maxPages && page < totalPages) {
      throw new LastfmHistoryImportTruncatedError(
        `Last.fm history import stopped at ${page} of ${totalPages} pages.`,
        { entries, invalid, invalidSamples, totalRows, pagesFetched, skippedNowPlaying, truncated: true },
      );
    }
    if (totalPages == null || page >= totalPages) break;
  }

  return { entries, invalid, invalidSamples, totalRows, pagesFetched, skippedNowPlaying, truncated: false };
}

// One page, asked for again after a transient failure. The same URL is used
// each time, so a retried page carries the same `to` snapshot as the rest.
async function fetchLastfmPage(
  fetcher: typeof fetch,
  url: string,
  input: FetchLastfmHistoryInput,
): Promise<LastfmRecentTracksResponse> {
  const baseDelay = Number.isFinite(input.retryDelayMs) ? Math.max(0, Number(input.retryDelayMs)) : LASTFM_RETRY_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await requestLastfmPage(fetcher, url, input);
    } catch (err) {
      // A cancelled import stops here, whatever the error looks like.
      input.signal?.throwIfAborted();
      if (!isRetryablePageFailure(err) || attempt >= LASTFM_PAGE_ATTEMPTS) throw err;
      const retryAfter = err instanceof LastfmPageRequestError ? err.retryAfterMs : null;
      const wait = Math.min(LASTFM_MAX_RETRY_WAIT_MS, retryAfter ?? baseDelay * 2 ** (attempt - 1));
      await abortableDelay(wait, input.signal);
    }
  }
}

async function requestLastfmPage(
  fetcher: typeof fetch,
  url: string,
  input: FetchLastfmHistoryInput,
): Promise<LastfmRecentTracksResponse> {
  const response = await fetcher(url, {
    signal: buildRequestSignal(input.signal, input.requestTimeoutMs),
    redirect: 'error',
  });
  // Last.fm explains a refusal in the body (a private profile, an unknown
  // user), so the body is read before the status is held against it.
  let data: LastfmRecentTracksResponse | null = null;
  try {
    data = await response.json() as LastfmRecentTracksResponse;
  } catch {
    /* not JSON: an error page from something in front of Last.fm */
  }
  const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
  const code = data && Number(data.error) ? Number(data.error) : null;
  if (code !== null) {
    throw new LastfmPageRequestError(
      lastfmHistoryErrorMessage(code, data?.message),
      LASTFM_RETRYABLE_CODES.has(code),
      retryAfterMs,
    );
  }
  if (!response.ok) {
    throw new LastfmPageRequestError(
      `Last.fm recent tracks request failed (${response.status}).`,
      response.status === 408 || response.status === 429 || response.status >= 500,
      retryAfterMs,
    );
  }
  if (!data) throw new LastfmPageRequestError('Last.fm returned a page that is not valid JSON.', true, retryAfterMs);
  return data;
}

// Timeouts and dropped connections are worth another try; so are the
// failures Last.fm marks as temporary. A bad name, a private profile or a bad
// key are not.
function isRetryablePageFailure(err: unknown): boolean {
  if (err instanceof LastfmPageRequestError) return err.retryable;
  if (!(err instanceof Error)) return false;
  return err.name === 'TimeoutError' || err.name === 'AbortError' || err instanceof TypeError;
}

function lastfmHistoryErrorMessage(code: number, message: string | undefined): string {
  if (code === 6) return 'Last.fm has no user with that name.';
  if (code === 17) {
    return 'That Last.fm profile is private. Allow recent listening to be shown in its privacy settings, then try again.';
  }
  return message || `Last.fm error ${code}.`;
}

function parseRetryAfter(value: string | null | undefined): number | null {
  const header = value?.trim();
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function buildLastfmRecentTracksUrl(input: { username: string; apiKey: string; page: number; toUnixSeconds: number }): string {
  const url = new URL(LASTFM_API_ROOT);
  url.searchParams.set('method', 'user.getrecenttracks');
  url.searchParams.set('user', input.username);
  url.searchParams.set('api_key', input.apiKey);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(LASTFM_PAGE_LIMIT));
  url.searchParams.set('page', String(input.page));
  url.searchParams.set('extended', '1');
  url.searchParams.set('to', String(input.toUnixSeconds));
  return url.toString();
}

function normalizeLastfmTrackArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function parsePositiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function normalizeMaxPages(value: number | undefined): number {
  if (value == null) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.trunc(value));
}

function normalizeToUnixSeconds(value: number | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : Math.floor(Date.now() / 1000);
}

function buildRequestSignal(cancelSignal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1000, Math.trunc(Number(timeoutMs))) : LASTFM_REQUEST_TIMEOUT_MS;
  const timeoutSignal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeout) : undefined;
  if (cancelSignal && timeoutSignal && typeof AbortSignal.any === 'function') return AbortSignal.any([cancelSignal, timeoutSignal]);
  return cancelSignal ?? timeoutSignal;
}

async function waitForLastfmRateLimit(lastRequestStarted: number, signal: AbortSignal | undefined): Promise<void> {
  if (!lastRequestStarted) return;
  const waitMs = LASTFM_REQUEST_SPACING_MS - (Date.now() - lastRequestStarted);
  if (waitMs <= 0) return;
  await abortableDelay(waitMs, signal);
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    function done(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
