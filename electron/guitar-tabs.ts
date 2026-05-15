import type {
  GuitarTabDocument,
  GuitarTabLine,
  GuitarTabLineType,
  GuitarTabSearchQuery,
  GuitarTabSearchResult,
  LocalGuitarTabInput,
  Track,
} from '../shared/types.js';
import { createHash } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import { join, parse } from 'node:path';

const UG_SEARCH_URL = 'https://www.ultimate-guitar.com/search.php';
const UG_HOST_RE = /(^|\.)ultimate-guitar\.com$/i;
const MAX_LOCAL_TAB_BYTES = 512 * 1024;
const CHORD_RE =
  /^([A-G](?:#|b)?)([^/\s]*)(?:\/([A-G](?:#|b)?))?$/;
const CHORD_TOKEN_RE =
  /\b([A-G](?:#|b)?)(maj|min|m|dim|aug|sus|add|M|mM|ø|o|[0-9]|[#b()+/-])*?(?:\/([A-G](?:#|b)?))?\b/g;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTE_INDEX = new Map<string, number>([
  ['C', 0],
  ['B#', 0],
  ['C#', 1],
  ['Db', 1],
  ['D', 2],
  ['D#', 3],
  ['Eb', 3],
  ['E', 4],
  ['Fb', 4],
  ['E#', 5],
  ['F', 5],
  ['F#', 6],
  ['Gb', 6],
  ['G', 7],
  ['G#', 8],
  ['Ab', 8],
  ['A', 9],
  ['A#', 10],
  ['Bb', 10],
  ['B', 11],
  ['Cb', 11],
]);

type JsonObject = Record<string, unknown>;
type TabPayload = { tab: JsonObject; song?: JsonObject | null };
type GuitarTabTrack = Pick<Track, 'path' | 'artist' | 'title' | 'album' | 'key'>;
type LocalTabParseResult = {
  lines: GuitarTabLine[];
  title: string | null;
  artist: string | null;
  key: string | null;
};

export function buildUltimateGuitarSearchUrl(query: GuitarTabSearchQuery): URL {
  const url = new URL(UG_SEARCH_URL);
  url.searchParams.set('search_type', 'title');
  url.searchParams.set('value', [query.artist, query.title].filter(Boolean).join(' ').trim());
  return url;
}

export async function searchUltimateGuitarTabs(
  query: GuitarTabSearchQuery,
): Promise<GuitarTabSearchResult[]> {
  const url = buildUltimateGuitarSearchUrl(query);
  const html = await requestUltimateGuitarText(url.toString());
  const parsed = parseUltimateGuitarSearchHtml(html);
  const limit = Math.max(1, Math.min(20, query.limit ?? 8));
  return rankSearchResults(parsed, query).slice(0, limit);
}

export async function fetchUltimateGuitarTab(url: string): Promise<GuitarTabDocument> {
  assertUltimateGuitarUrl(url);
  const candidates = buildUltimateGuitarTabUrlCandidates(url);
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const html = await requestUltimateGuitarText(candidate);
      return parseUltimateGuitarTabHtml(html, candidate);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('No Ultimate Guitar tab content found on the page');
}

export function parseUltimateGuitarSearchHtml(html: string): GuitarTabSearchResult[] {
  const out: GuitarTabSearchResult[] = [];
  for (const value of extractJsonValues(html)) collectSearchResultCandidates(value, out);
  for (const value of extractNamedJsonArrays(html, 'results')) {
    collectSearchResultCandidates(value, out);
  }
  return dedupeSearchResults(out);
}

export function parseUltimateGuitarTabHtml(html: string, url: string): GuitarTabDocument {
  assertUltimateGuitarUrl(url);

  for (const value of extractJsonValues(html)) {
    const candidate = findTabPayload(value);
    if (candidate) return tabPayloadToDocument(candidate, url);
  }

  const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)?.[1];
  if (pre) {
    return {
      source: 'ultimate-guitar',
      url,
      title: 'Ultimate Guitar Tab',
      artist: 'Unknown Artist',
      kind: 'Tab',
      author: null,
      rating: null,
      votes: null,
      key: null,
      lines: parseTabLines(cleanTabContent(pre)),
      fetchedAt: Date.now(),
    };
  }

  throw new Error('No Ultimate Guitar tab content found on the page');
}

export function buildLocalGuitarTabDocument(input: LocalGuitarTabInput): GuitarTabDocument {
  const content = input.content.trim();
  if (!content) throw new Error('Pasted tab text is empty.');
  const parsed = parseLocalTabContent(content);
  const artist = (parsed.artist ?? input.artist.trim()) || 'Unknown Artist';
  const title = (parsed.title ?? input.title.trim()) || 'Pasted Tab';
  const kind = input.kind?.trim() || 'Pasted Tab';
  const key = parsed.key ?? input.key?.trim() ?? null;
  const lines = parsed.lines;
  if (!lines.length) throw new Error('Pasted tab text did not contain playable lines.');
  const hash = createHash('sha1')
    .update([artist, title, kind, key ?? '', content].join('\n'))
    .digest('hex')
    .slice(0, 20);
  return {
    source: 'local',
    url: `newamp-local-tab://${hash}`,
    title,
    artist,
    kind,
    author: 'Newamp local',
    rating: null,
    votes: null,
    key,
    lines,
    fetchedAt: Date.now(),
  };
}

export async function findLocalGuitarTabForTrack(track: GuitarTabTrack): Promise<GuitarTabDocument | null> {
  if (!track.path) return null;
  if (!(await isReadableFile(track.path))) return null;

  for (const candidate of localGuitarTabCandidates(track)) {
    const content = await readLocalTabCandidate(candidate);
    if (!content) continue;
    if (!looksLikeLocalGuitarTab(content)) continue;
    return buildLocalGuitarTabDocument({
      artist: track.artist,
      title: track.title,
      content,
      kind: 'Sidecar Tab',
      key: track.key,
    });
  }

  return null;
}

export function localGuitarTabCandidates(track: GuitarTabTrack): string[] {
  const parsed = parse(track.path);
  const bases = uniqueNonEmpty([
    parsed.name,
    `${track.artist} - ${track.title}`,
    track.title,
    `${track.album} - ${track.title}`,
  ].map(safeNamePart));
  const suffixes = ['.chopro', '.chordpro', '.cho', '.crd', '.chords.txt', '.tab', '.tabs', '.pro', '.txt'];
  const out: string[] = [];

  for (const base of bases) {
    for (const suffix of suffixes) out.push(join(parsed.dir, `${base}${suffix}`));
  }

  for (const base of bases) {
    for (const suffix of suffixes) out.push(join(parsed.dir, 'tabs', `${base}${suffix}`));
  }

  return uniquePaths(out);
}

export function buildUltimateGuitarTabUrlCandidates(url: string): string[] {
  assertUltimateGuitarUrl(url);
  const out: string[] = [];
  const push = (value: string) => {
    if (!out.includes(value)) out.push(value);
  };

  push(url);
  const normalized = normalizeUltimateGuitarTabUrl(url);
  push(normalized);
  for (const candidate of [...out]) push(addPrintParam(candidate));
  return out;
}

export function transposeChordLine(line: string, semitones: number): string {
  if (!Number.isFinite(semitones) || semitones === 0) return line;
  return line.replace(CHORD_TOKEN_RE, (token) => transposeChordToken(token, semitones));
}

export function parseTabLines(content: string): GuitarTabLine[] {
  return cleanTabContent(content)
    .split(/\n/)
    .map((line) => {
      const text = line.trimEnd();
      return { type: classifyTabLine(text), text };
    });
}

function parseLocalTabContent(content: string): LocalTabParseResult {
  const meta = { title: null as string | null, artist: null as string | null, key: null as string | null };
  const normalized: string[] = [];
  for (const raw of decodeHtmlEntities(content).replace(/\r/g, '').trim().split(/\n/)) {
    const directive = parseChordProDirective(raw);
    if (directive) {
      if (directive.name === 'title' || directive.name === 't') meta.title = directive.value || meta.title;
      else if (directive.name === 'artist' || directive.name === 'subtitle' || directive.name === 'st') {
        meta.artist = directive.value || meta.artist;
      } else if (directive.name === 'key') meta.key = directive.value || meta.key;
      else if (directive.name.startsWith('start_of_')) normalized.push(`[${labelFromChordProDirective(directive.name)}]`);
      else if (directive.name === 'comment' || directive.name === 'c') normalized.push(`[${directive.value}]`);
      continue;
    }

    const split = splitChordProLine(raw);
    if (split) {
      if (split.chords) normalized.push(split.chords);
      normalized.push(split.lyrics);
      continue;
    }

    normalized.push(raw.trimEnd());
  }

  const lines = normalized
    .map((line) => line.trimEnd())
    .filter((line, index, linesInScope) => line.trim() || linesInScope[index - 1]?.trim())
    .map((text) => ({ type: classifyTabLine(text), text }));
  return { ...meta, lines };
}

function transposeChordToken(token: string, semitones: number): string {
  const match = token.match(CHORD_RE);
  if (!match) return token;
  const [, root, suffix = '', bass] = match;
  const nextRoot = transposeNote(root!, semitones);
  const nextBass = bass ? `/${transposeNote(bass, semitones)}` : '';
  return `${nextRoot}${suffix}${nextBass}`;
}

function transposeNote(note: string, semitones: number): string {
  const idx = NOTE_INDEX.get(note);
  if (idx == null) return note;
  const next = (idx + semitones) % 12;
  return NOTE_NAMES[(next + 12) % 12]!;
}

function classifyTabLine(line: string): GuitarTabLineType {
  const trimmed = line.trim();
  if (!trimmed) return 'blank';
  if (/^\[[^\]]+\]$/.test(trimmed)) return 'section';
  if (/[|][-\dxhbp~/\\|]+/.test(trimmed)) return 'tab';
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const chordTokens = tokens.filter((token) => isChordToken(token));
  if (tokens.length > 0 && chordTokens.length / tokens.length >= 0.68) return 'chords';
  return 'lyrics';
}

function isChordToken(token: string): boolean {
  if (/^(N\.?C\.?|x)$/i.test(token)) return true;
  return CHORD_RE.test(token.replace(/[.,;:]$/g, ''));
}

async function readLocalTabCandidate(path: string): Promise<string | null> {
  let size = 0;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_LOCAL_TAB_BYTES) return null;
    size = info.size;
  } catch {
    return null;
  }

  try {
    const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '').trim();
    if (!text || Buffer.byteLength(text, 'utf8') > Math.max(size * 2, MAX_LOCAL_TAB_BYTES)) return null;
    return text;
  } catch {
    return null;
  }
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function parseChordProDirective(line: string): { name: string; value: string } | null {
  const match = line.trim().match(/^\{\s*([a-z_]+|[tc]|st)\s*(?::\s*([^}]*))?\}$/i);
  if (!match?.[1]) return null;
  return { name: match[1].toLowerCase(), value: (match[2] ?? '').trim() };
}

function splitChordProLine(line: string): { chords: string; lyrics: string } | null {
  const chordTagRe = /\[([^\]\r\n]{1,32})\]/g;
  let found = false;
  let lastIndex = 0;
  const chords: string[] = [];
  let lyrics = '';
  for (const match of line.matchAll(chordTagRe)) {
    const rawChord = match[1]?.trim() ?? '';
    lyrics += line.slice(lastIndex, match.index);
    if (isChordToken(rawChord)) {
      found = true;
      chords.push(rawChord.replace(/[.,;:]$/g, ''));
    } else {
      lyrics += match[0];
    }
    lastIndex = (match.index ?? 0) + match[0].length;
  }
  if (!found) return null;
  lyrics += line.slice(lastIndex);
  return { chords: chords.join(' '), lyrics: lyrics.trimEnd() };
}

function labelFromChordProDirective(name: string): string {
  return name
    .replace(/^start_of_/, '')
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function looksLikeLocalGuitarTab(content: string): boolean {
  if (/\{\s*(?:title|t|artist|subtitle|st|key|start_of_[a-z_]+)\b/i.test(content)) return true;
  if (/\[[A-G](?:#|b)?(?:maj|min|m|dim|aug|sus|add|M|mM|[0-9#b()+/-])*(?:\/[A-G](?:#|b)?)?\]/.test(content)) {
    return true;
  }
  return parseTabLines(content).some((line) => line.type === 'chords' || line.type === 'tab');
}

function rankSearchResults(
  results: GuitarTabSearchResult[],
  query: GuitarTabSearchQuery,
): GuitarTabSearchResult[] {
  const needleTitle = normalizeSearchText(query.title);
  const needleArtist = normalizeSearchText(query.artist);
  return [...results].sort((a, b) => scoreResult(b) - scoreResult(a));

  function scoreResult(result: GuitarTabSearchResult): number {
    let score = 0;
    const title = normalizeSearchText(result.title);
    const artist = normalizeSearchText(result.artist);
    if (title === needleTitle) score += 60;
    else if (title.includes(needleTitle) || needleTitle.includes(title)) score += 25;
    if (artist === needleArtist) score += 45;
    else if (artist.includes(needleArtist) || needleArtist.includes(artist)) score += 15;
    if (/chords/i.test(result.kind)) score += 12;
    if (/tab/i.test(result.kind)) score += 7;
    score += Math.min(20, result.rating ? result.rating * 3 : 0);
    score += Math.min(12, result.votes ? Math.log10(result.votes + 1) * 4 : 0);
    return score;
  }
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function dedupeSearchResults(results: GuitarTabSearchResult[]): GuitarTabSearchResult[] {
  const seen = new Set<string>();
  const out: GuitarTabSearchResult[] = [];
  for (const result of results) {
    if (!result.url || seen.has(result.url)) continue;
    seen.add(result.url);
    out.push(result);
  }
  return out;
}

function collectSearchResultCandidates(value: unknown, out: GuitarTabSearchResult[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSearchResultCandidates(item, out);
    return;
  }
  if (!isObject(value)) return;

  const url = stringField(value, 'tab_url') ?? stringField(value, 'url') ?? stringField(value, 'share_url');
  const title = stringField(value, 'song_name') ?? stringField(value, 'title') ?? stringField(value, 'song');
  const artist = stringField(value, 'artist_name') ?? stringField(value, 'artist');
  if (url && title && artist && isUltimateGuitarUrl(url)) {
    out.push({
      id: stableTabId(url),
      source: 'ultimate-guitar',
      title: decodeHtmlEntities(title),
      artist: decodeHtmlEntities(artist),
      kind: stringField(value, 'type') ?? stringField(value, 'tab_type') ?? 'Tab',
      url,
      rating: numberField(value, 'rating'),
      votes: numberField(value, 'votes'),
    });
  }

  for (const child of Object.values(value)) collectSearchResultCandidates(child, out);
}

function findTabPayload(value: unknown): TabPayload | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTabPayload(item);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(value)) return null;

  const directTab =
    objectField(value, 'tab_view') ??
    objectField(value, 'tab') ??
    objectField(value, 'wiki_tab') ??
    objectField(value, 'tabData');
  const directSong = objectField(value, 'song') ?? objectField(value, 'song_info');
  if (directTab && isTabLike(directTab)) return { tab: directTab, song: directSong };

  const entities = objectField(objectField(objectField(value, 'initialState'), 'store'), 'entities');
  const tabViews = objectField(entities, 'tabViews');
  const songs = objectField(entities, 'songs');
  const entityTab = firstObjectValue(tabViews);
  if (entityTab && isTabLike(entityTab)) return { tab: entityTab, song: firstObjectValue(songs) };

  if (isTabLike(value)) return { tab: value, song: directSong };

  for (const child of Object.values(value)) {
    const found = findTabPayload(child);
    if (found) return found;
  }
  return null;
}

function tabPayloadToDocument(payload: TabPayload, url: string): GuitarTabDocument {
  const { tab, song } = payload;
  const rawContent =
    stringField(tab, 'content') ??
    stringField(tab, 'tab_content') ??
    stringField(tab, 'wiki_tab_content') ??
    '';
  const lines =
    normalizeStructuredTabLines(valueAtPath(tab, ['content', 'lines'])) ??
    normalizeStructuredTabLines(tab.lines) ??
    parseTabLines(rawContent);
  const meta = objectField(tab, 'meta');
  const author = objectField(tab, 'author');
  return {
    source: 'ultimate-guitar',
    url,
    title:
      decodeHtmlEntities(
        stringField(tab, 'song_name') ??
          stringField(tab, 'title') ??
          stringField(tab, 'song') ??
          stringField(song, 'name') ??
          stringField(song, 'title') ??
          stringField(song, 'song_name') ??
          'Ultimate Guitar Tab',
      ),
    artist:
      decodeHtmlEntities(
        stringField(tab, 'artist_name') ??
          stringField(tab, 'artist') ??
          stringField(song, 'artist_name') ??
          stringField(song, 'artist') ??
          'Unknown Artist',
      ),
    kind: stringField(tab, 'type') ?? stringField(tab, 'tab_type') ?? 'Tab',
    author:
      stringField(tab, 'username') ??
      stringField(tab, 'author') ??
      stringField(author, 'username') ??
      stringField(author, 'name') ??
      null,
    rating: numberField(tab, 'rating'),
    votes: numberField(tab, 'votes'),
    key:
      stringField(tab, 'tonality_name') ??
      stringField(tab, 'tonality') ??
      stringField(tab, 'key') ??
      stringField(meta, 'tonality') ??
      stringField(meta, 'key') ??
      null,
    lines,
    fetchedAt: Date.now(),
  };
}

async function requestUltimateGuitarText(url: string): Promise<string> {
  assertUltimateGuitarUrl(url);
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Newamp/0.1 Safari/537.36',
    },
  });
  const body = await response.text();
  if (!response.ok || /Just a moment|Cloudflare|challenge-platform/i.test(body)) {
    throw new Error(
      response.status === 403
        ? 'Ultimate Guitar blocked automated access from this network. Paste a tab URL or retry later.'
        : `Ultimate Guitar request failed (${response.status})`,
    );
  }
  return body;
}

function extractJsonValues(html: string): unknown[] {
  const out: unknown[] = [];
  for (const match of html.matchAll(
    /<script[^>]*(?:id=["']__NEXT_DATA__["'][^>]*)?[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    const script = decodeHtmlEntities(match[1] ?? '').trim();
    if (!script) continue;
    if (script.startsWith('{') || script.startsWith('[')) {
      pushJson(script, out);
      continue;
    }
    for (const assignment of ['window.UGAPP', 'UGAPP']) {
      const idx = script.indexOf(assignment);
      if (idx < 0) continue;
      const open = script.indexOf('{', idx);
      if (open < 0) continue;
      const balanced = extractBalanced(script, open, '{', '}');
      if (balanced) pushJson(balanced, out);
    }
  }
  return out;
}

function extractNamedJsonArrays(html: string, name: string): unknown[] {
  const out: unknown[] = [];
  const re = new RegExp(`"?${name}"?\\s*:`, 'g');
  for (const match of html.matchAll(re)) {
    const start = html.indexOf('[', match.index ?? 0);
    if (start < 0) continue;
    const balanced = extractBalanced(html, start, '[', ']');
    if (balanced) pushJson(decodeHtmlEntities(balanced), out);
  }
  return out;
}

function extractBalanced(text: string, start: number, open: string, close: string): string | null {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function pushJson(text: string, out: unknown[]): void {
  try {
    out.push(JSON.parse(text));
  } catch {
    /* ignore non-JSON script bodies */
  }
}

function cleanTabContent(content: string): string {
  return decodeHtmlEntities(content)
    .replace(/<span\b(?=[^>]*\bdata-name=["']([^"']+)["'])[^>]*>([\s\S]*?)<\/span>/gi, (_match, name: string, text: string) =>
      text.trim() ? text : name,
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[ch\]([\s\S]*?)\[\/ch\]/gi, '$1')
    .replace(/\[(?:\/)?(?:tab|chords?|verse|chorus|intro|outro|bridge|solo|riff|pre-chorus)[^\]]*\]/gi, '')
    .replace(/\r/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/\\u0026/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCharCode(parseInt(code, 16)));
}

function stringField(obj: JsonObject | null | undefined, key: string): string | null {
  if (!obj) return null;
  const value = obj[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberField(obj: JsonObject | null | undefined, key: string): number | null {
  if (!obj) return null;
  const value = obj[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function objectField(obj: JsonObject | null | undefined, key: string): JsonObject | null {
  const value = obj?.[key];
  return isObject(value) ? value : null;
}

function valueAtPath(obj: JsonObject, path: string[]): unknown {
  let value: unknown = obj;
  for (const key of path) {
    if (!isObject(value)) return undefined;
    value = value[key];
  }
  return value;
}

function firstObjectValue(obj: JsonObject | null | undefined): JsonObject | null {
  if (!obj) return null;
  for (const value of Object.values(obj)) {
    if (isObject(value)) return value;
  }
  return null;
}

function isTabLike(value: JsonObject): boolean {
  const content = value.content ?? value.tab_content ?? value.wiki_tab_content;
  return (
    (typeof content === 'string' && content.trim().length > 0) ||
    Array.isArray(valueAtPath(value, ['content', 'lines'])) ||
    Array.isArray(value.lines)
  );
}

function normalizeStructuredTabLines(value: unknown): GuitarTabLine[] | null {
  if (!Array.isArray(value)) return null;
  const lines: GuitarTabLine[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      lines.push(...parseTabLines(item));
      continue;
    }
    if (!isObject(item)) continue;
    const text = stringField(item, 'text') ?? stringField(item, 'line') ?? stringField(item, 'content') ?? '';
    const type = normalizeLineType(stringField(item, 'type'), text);
    lines.push({ type, text: cleanTabContent(text) });
  }
  return lines.length ? lines : null;
}

function normalizeLineType(value: string | null, text: string): GuitarTabLineType {
  if (value === 'chords' || value === 'lyrics' || value === 'blank' || value === 'section' || value === 'tab') {
    return value;
  }
  return classifyTabLine(text);
}

function normalizeUltimateGuitarTabUrl(value: string): string {
  const url = new URL(value);
  if (
    url.hostname === 'tabs.ultimate-guitar.com' ||
    url.hostname === 'www.tabs.ultimate-guitar.com' ||
    url.hostname === 'it.ultimate-guitar.com' ||
    url.hostname === 'www.it.ultimate-guitar.com'
  ) {
    url.hostname = 'www.ultimate-guitar.com';
  }
  return url.toString();
}

function addPrintParam(value: string): string {
  const url = new URL(value);
  url.searchParams.set('print', '1');
  return url.toString();
}

function assertUltimateGuitarUrl(value: string): void {
  if (!isUltimateGuitarUrl(value)) throw new Error('Only ultimate-guitar.com tab URLs are supported');
}

function isUltimateGuitarUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && UG_HOST_RE.test(url.hostname);
  } catch {
    return false;
  }
}

function stableTabId(url: string): string {
  const match = url.match(/-(\d+)(?:\?|#|$)/);
  if (match?.[1]) return match[1];
  return Buffer.from(url).toString('base64url').slice(0, 18);
}

function safeNamePart(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueNonEmpty(values: string[]): string[] {
  return values.filter((value, index) => !!value && values.indexOf(value) === index);
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}
