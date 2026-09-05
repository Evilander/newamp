export type HistoryImportFormat = 'csv' | 'json';

export interface HistoryImportEntry {
  playedAt: number;
  path?: string | null;
  artist?: string | null;
  title?: string | null;
  album?: string | null;
  source?: string | null;
  row?: number;
}

export interface HistoryImportIssue {
  row: number;
  reason: string;
  artist?: string | null;
  title?: string | null;
  album?: string | null;
  path?: string | null;
  playedAt?: number | null;
}

export interface HistoryImportParseResult {
  entries: HistoryImportEntry[];
  invalid: number;
  invalidSamples: HistoryImportIssue[];
  totalRows: number;
  skippedNowPlaying?: number;
  truncated?: boolean;
}

export interface HistoryImportReport {
  imported: number;
  duplicates: number;
  unmatched: number;
  ambiguous: number;
  invalid: number;
  total: number;
  unmatchedSamples: HistoryImportIssue[];
  ambiguousSamples: HistoryImportIssue[];
  invalidSamples: HistoryImportIssue[];
}

export interface LastfmHistoryProgress {
  page: number;
  totalPages: number | null;
  entries: number;
  invalid: number;
  skippedNowPlaying: number;
}

export const HISTORY_IMPORT_MAX_ENTRIES = 500_000;

const FIELD_ALIASES = {
  playedAt: ['played_at', 'playedat', 'timestamp', 'time', 'date', 'played', 'scrobbled_at', 'scrobbledat', 'uts', 'unix_timestamp', 'unixtimestamp'],
  path: ['path', 'file', 'file_path', 'filepath', 'location', 'filename'],
  artist: ['artist', 'track_artist', 'trackartist', 'artist_name', 'artistname'],
  title: ['title', 'track', 'track_title', 'tracktitle', 'track_name', 'trackname', 'name'],
  album: ['album', 'album_title', 'albumtitle', 'release'],
} as const;

export function parseHistoryImport(text: string, format: HistoryImportFormat): HistoryImportParseResult {
  if (format === 'csv') return parseCsvHistory(text);
  return parseJsonHistory(text);
}

export function normalizeHistoryImportText(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, ' ');
}

export function normalizeHistoryImportPath(value: string | null | undefined): string {
  const path = String(value ?? '').trim().replace(/\\/g, '/');
  return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path;
}

export function normalizeHistoryImportEntry(raw: unknown, row: number, source?: string): HistoryImportEntry | HistoryImportIssue {
  const obj = isRecord(raw) ? raw : {};
  const attr = obj['@attr'];
  if (isRecord(attr) && String(attr.nowplaying ?? '').toLowerCase() === 'true') {
    return { row, reason: 'now-playing-without-final-timestamp' };
  }
  const playedAt = parsePlayedAt(readAliased(obj, FIELD_ALIASES.playedAt));
  const path = cleanOptional(readAliased(obj, FIELD_ALIASES.path));
  const artist = cleanOptional(readArtist(obj));
  const title = cleanOptional(readTitle(obj));
  const album = cleanOptional(readAlbum(obj));
  if (playedAt == null) {
    return { row, reason: 'missing-or-invalid-timestamp', artist, title, album, path, playedAt: null };
  }
  if (!path && (!artist || !title)) {
    return { row, reason: 'missing-track-identity', artist, title, album, path, playedAt };
  }
  return { playedAt, path, artist, title, album, source: source ?? null, row };
}

function parseCsvHistory(text: string): HistoryImportParseResult {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ''));
  if (!rows.length) return { entries: [], invalid: 0, invalidSamples: [], totalRows: 0 };
  const headers = rows[0]!.map((header) => normalizeHeader(header));
  if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) throw new Error('History CSV contains duplicate columns.');
  if (rows.length - 1 > HISTORY_IMPORT_MAX_ENTRIES) throw new Error('History files are limited to 500,000 plays. Split the export into smaller files.');
  const entries: HistoryImportEntry[] = [];
  const invalidSamples: HistoryImportIssue[] = [];
  let invalid = 0;
  let skippedNowPlaying = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const values = rows[i]!;
    if (!values.some((value) => value.trim())) continue;
    if (values.length !== headers.length) {
      invalid += 1;
      if (invalidSamples.length < 10) invalidSamples.push({ row: i + 1, reason: 'column-count-mismatch' });
      continue;
    }
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) row[header] = values[index] ?? '';
    });
    const normalized = normalizeHistoryImportEntry(row, i + 1, 'csv');
    if ('reason' in normalized && normalized.reason === 'now-playing-without-final-timestamp') skippedNowPlaying += 1;
    else if ('reason' in normalized) {
      invalid += 1;
      if (invalidSamples.length < 10) invalidSamples.push(limitIssue(normalized));
    }
    else entries.push(normalized);
  }
  return { entries, invalid, invalidSamples, totalRows: rows.length - 1, skippedNowPlaying };
}

function parseJsonHistory(text: string): HistoryImportParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return {
      entries: [],
      invalid: 1,
      invalidSamples: [{ row: 1, reason: 'invalid-json' }],
      totalRows: 1,
    };
  }
  const rows = extractJsonRows(parsed);
  if (rows.length > HISTORY_IMPORT_MAX_ENTRIES) throw new Error('History files are limited to 500,000 plays. Split the export into smaller files.');
  const entries: HistoryImportEntry[] = [];
  const invalidSamples: HistoryImportIssue[] = [];
  let invalid = 0;
  let skippedNowPlaying = 0;
  rows.forEach((row, index) => {
    const normalized = normalizeHistoryImportEntry(row, index + 1, 'json');
    if ('reason' in normalized && normalized.reason === 'now-playing-without-final-timestamp') skippedNowPlaying += 1;
    else if ('reason' in normalized) {
      invalid += 1;
      if (invalidSamples.length < 10) invalidSamples.push(limitIssue(normalized));
    }
    else entries.push(normalized);
  });
  return { entries, invalid, invalidSamples, totalRows: rows.length, skippedNowPlaying };
}

function extractJsonRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [value];
  for (const key of ['history', 'plays', 'scrobbles', 'tracks', 'entries']) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  const recent = value.recenttracks;
  if (isRecord(recent)) {
    if (Array.isArray(recent.track)) return recent.track;
    if (isRecord(recent.track)) return [recent.track];
  }
  return [value];
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        field += ch;
      }
      continue;
    }
    if (closedQuote && ch !== ',' && ch !== '\n' && ch !== '\r') {
      if (/\s/.test(ch)) continue;
      throw new Error('History CSV contains text after a closing quote.');
    }
    if (ch === '"') {
      if (field.trim()) throw new Error('History CSV contains a quote in an unquoted field.');
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      closedQuote = false;
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      closedQuote = false;
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (quoted) throw new Error('History CSV contains an unterminated quoted field.');
  row.push(field);
  if (row.length > 1 || row[0]!.trim()) rows.push(row);
  return rows;
}

function readArtist(obj: Record<string, unknown>): unknown {
  const direct = readAliased(obj, FIELD_ALIASES.artist);
  return readNestedText(direct ?? obj.artist);
}

function readTitle(obj: Record<string, unknown>): unknown {
  return readAliased(obj, FIELD_ALIASES.title);
}

function readAlbum(obj: Record<string, unknown>): unknown {
  const direct = readAliased(obj, FIELD_ALIASES.album);
  return readNestedText(direct ?? obj.album);
}

function readAliased(obj: Record<string, unknown>, aliases: readonly string[]): unknown {
  const date = obj.date;
  if (aliases.includes('uts') && isRecord(date)) return date.uts ?? date['#text'];
  const normalized = new Map<string, unknown>();
  for (const [key, value] of Object.entries(obj)) normalized.set(normalizeHeader(key), value);
  for (const alias of aliases) {
    if (normalized.has(alias)) return normalized.get(alias);
  }
  return null;
}

function readNestedText(value: unknown): unknown {
  return isRecord(value) ? value['#text'] ?? value.name : value;
}

function parsePlayedAt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return millisFromNumber(value);
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return millisFromNumber(Number(raw));
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return null;
  const [year, month, day] = raw.slice(0, 10).split('-').map(Number);
  if (!year || !month || !day || month > 12 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function millisFromNumber(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const millis = Math.trunc(value < 10_000_000_000 ? value * 1000 : value);
  return Number.isSafeInteger(millis) && millis <= 8_640_000_000_000_000 ? millis : null;
}

function cleanOptional(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeHeader(value: string): string {
  return value.trim().replace(/[\s-]+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
}

function limitIssue(issue: HistoryImportIssue): HistoryImportIssue {
  return {
    row: issue.row,
    reason: issue.reason,
    artist: issue.artist ?? null,
    title: issue.title ?? null,
    album: issue.album ?? null,
    path: issue.path ?? null,
    playedAt: issue.playedAt ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
