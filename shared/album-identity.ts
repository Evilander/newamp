// Which tracks make up one album, and why.
//
// The library used to group on the pair of strings the tags happened to carry:
// the same album under "Wilco" and "WILCO" was two albums, a compilation whose
// files name no album artist became one album per track artist, and a box set
// stored as "Disc 1" / "Disc 2" folders became two. The album here is the
// folder it sits in plus its title, with the album artist settled by looking at
// the whole folder instead of one file at a time.
//
// Everything in this file is a pure function of the track rows it is handed, so
// the library can run it in slices, tests can run it on synthetic folders, and
// the same rules produce the same keys after every scan.

/** Bumped when a rule changes; every track is grouped again on the next launch. */
export const ALBUM_IDENTITY_VERSION = 2;

/** Bumped when the scanner starts reading another tag; existing rows are read again, tags only. */
export const SCAN_SCHEMA_VERSION = 1;

export const VARIOUS_ARTISTS = 'Various Artists';

export type AlbumKind = 'album' | 'compilation' | 'bucket' | 'split';

// The ways a folder turns into an inferred album, as constants so the tests and
// the library name the same thresholds.
export const INFER_MIN_TRACKS = 4;
export const INFER_MIN_ARTISTS = 3;
export const INFER_MAX_SHARE = 0.5;
/** A folder with a few files tagged Various Artists and the rest untagged is still one compilation. */
export const INFER_MAX_TAGGED_SHARE = 0.25;
export const FLAG_MIN_SHARE = 0.5;
export const FLAG_MIN_ARTISTS = 2;
export const INHERIT_MIN_SHARE = 0.5;
export const DOMINANT_MIN_SHARE = 0.6;
export const BUCKET_MIN_FOLDERS = 2;
export const BUCKET_MIN_TRACKS = 40;

/** Tags the scanner reads beyond what a track row always had. */
export interface TrackTagExtras {
  /** The file's own ALBUMARTIST, null when it has none (album_artist then holds the track artist). */
  albumArtistTag: string | null;
  compilation: boolean;
  albumArtistSort: string | null;
  artistSort: string | null;
  discTotal: number | null;
  trackTotal: number | null;
  discSubtitle: string | null;
  mbReleaseGroupId: string | null;
  originalYear: number | null;
  /** Every artist the file names, only when it names more than one. */
  artists: string[] | null;
  /** Every genre the file names, only when it names more than one. */
  genres: string[] | null;
}

export interface StoredIdentity {
  albumKey: string | null;
  albumDisplay: string | null;
  albumArtistDisplay: string | null;
  albumKind: string | null;
  albumReason: string | null;
  albumYear: number | null;
  albumSortKey: string | null;
  discInferred: number | null;
}

export interface TrackIdentity {
  albumKey: string;
  albumDisplay: string;
  albumArtistDisplay: string;
  albumKind: AlbumKind;
  albumReason: string | null;
  albumYear: number | null;
  albumSortKey: string;
  discInferred: number | null;
}

/** What the rules need to know about one track that has an album. */
export interface IdentityTrack {
  id: number;
  path: string;
  album: string;
  artist: string;
  /** The album_artist column: the tag, an edit, or the track artist when the file named none. */
  albumArtist: string;
  /** The file's ALBUMARTIST tag; only meaningful when tagsKnown. */
  albumArtistTag: string | null;
  /** The row was read with the current tag set, so the tag fields are real and not a guess. */
  tagsKnown: boolean;
  /** The user typed the album artist, which counts as a tag. */
  albumArtistEdited: boolean;
  compilation: boolean;
  discNo: number | null;
  year: number | null;
  albumArtistSort: string | null;
  artistSort: string | null;
  prev?: StoredIdentity | null;
}

// -- folding ---------------------------------------------------------------

// Latin, Greek and Cyrillic accents only. A wider mark strip would also eat
// the dakuten of Japanese titles and the vowel signs of Indic scripts, which
// tell words apart.
const ACCENTS = /[̀-ͯ]+/g;

/** Case, accents and spacing. What "the same text" means for names the user sees. */
export function baseFold(value: string | null | undefined): string {
  if (!value) return '';
  return value.normalize('NFKD').replace(ACCENTS, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * baseFold plus the differences nobody means as a different album: a leading
 * "The" (or "..., The"), "&" against "and", punctuation, apostrophes, dots
 * inside an abbreviation. Falls back to baseFold for a title that is nothing
 * but punctuation, so "!!!" and "???" stay two names.
 *
 * The same folds join two album artists that differ only by them ("The Who"
 * and "Who", "M.I.A." and "Mia") when they share a title; the Artists list
 * (artistKeyOf) folds less and keeps them apart. Accepted: two different
 * artists whose names fold together and who each made an album of the same
 * title are rarer than the spellings of one artist these folds join.
 */
export function keyFold(value: string | null | undefined): string {
  const base = baseFold(value);
  if (!base) return '';
  const folded = base
    .replace(/^the\s+/, '')
    .replace(/,\s*the$/, '')
    .replace(/['’`´]/g, '')
    .replace(/(?<=\p{L})\.(?=\p{L})/gu, '')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[^\p{L}\p{N}\p{M} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return folded || base;
}

/** The key an artist is listed under in the Artists view. */
export function artistKeyOf(artist: string | null | undefined): string {
  return baseFold(artist);
}

/**
 * Order for the Artists view and album sort: the file's sort name when it has
 * one, else the name without a leading "The". A sort tag is the name reordered
 * ("Beatles, The"), so it has to share a word with the name; one that does not
 * is a tag written into the wrong field (an album title in ALBUMARTISTSORT) and
 * would file the artist under an unrelated letter.
 */
export function artistSortKey(name: string | null | undefined, sortTag?: string | null): string {
  const tag = baseFold(sortTag);
  if (tag && sharesWord(tag, name)) return tag;
  return baseFold(name).replace(/^the\s+/, '');
}

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

function wordsOf(value: string | null | undefined): Set<string> {
  const words = new Set<string>();
  for (const word of baseFold(value).split(WORD_SPLIT)) {
    if (word && word !== 'the') words.add(word);
  }
  return words;
}

function sharesWord(foldedTag: string, name: string | null | undefined): boolean {
  const nameWords = wordsOf(name);
  if (!nameWords.size) return true;
  for (const word of wordsOf(foldedTag)) if (nameWords.has(word)) return true;
  return false;
}

const VARIOUS_KEYS = new Set([
  'various',
  'various artists',
  'va',
  'v a',
  'varios',
  'varios artistas',
  'verschiedene',
  'verschiedene interpreten',
  'artistes divers',
  'divers',
]);

export function isVariousKey(key: string): boolean {
  return VARIOUS_KEYS.has(key);
}

const UNKNOWN_KEYS = new Set(['', 'unknown artist', 'unknown', 'artist unknown']);

export function isUnknownArtist(name: string | null | undefined): boolean {
  return UNKNOWN_KEYS.has(baseFold(name));
}

export const VA_ARTIST_KEY = '~va';
const UNKNOWN_ARTIST_KEY = 'unknown artist';

// -- titles, discs and folders ---------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

// "(Disc 2)", "[CD1 Bonus]" at the end of a title.
const DISC_TAIL_BRACKET = /\s*[([]\s*(?:disc|disk|cd)\s*[-#.]?\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b[^)\]]*[)\]]\s*$/i;
// "CD2", "- Disc 3: Jefferson" at the end of a title.
const DISC_TAIL_PLAIN = /\s*[-–—:,]?\s*\b(?:disc|disk|cd)\s*[-#.]?\s*(\d+|one|two|three|four)\b(?:\s*[:–—-]\s*.*)?$/i;
// A folder that is a disc or part of a set rather than an album of its own.
const DISC_FOLDER = /^(?:cd|disc|disk|dvd|side|vol|volume)[\s._-]*0*(?:\d+|[a-d])\b.*$/i;
const DISC_FOLDER_NUMBER = /^(?:cd|disc|disk|dvd)[\s._-]*0*(\d+)\b/i;

function discNumberOf(token: string | undefined): number | null {
  if (!token) return null;
  const n = /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS[token.toLowerCase()];
  return Number.isFinite(n) && n! > 0 && n! < 100 ? (n as number) : null;
}

/** The title with a trailing disc marker taken off, and the disc number the marker named. */
export function stripDiscMarker(title: string): { stem: string; disc: number | null } {
  let stem = title.trim();
  let disc: number | null = null;
  for (const re of [DISC_TAIL_BRACKET, DISC_TAIL_PLAIN]) {
    const m = re.exec(stem);
    if (!m) continue;
    // "Dance Disc 1999" is a title, not disc 1999.
    const n = discNumberOf(m[1]);
    if (n === null) continue;
    const next = stem.slice(0, m.index).trim();
    if (next.length < 2) continue;
    stem = next;
    disc = disc ?? n;
  }
  return { stem, disc };
}

export function normalizeFolder(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  const cut = slashed.lastIndexOf('/');
  return (cut > 0 ? slashed.slice(0, cut) : '').toLowerCase();
}

/** The album's folder: a trailing disc folder (CD1, Disc 2, Side A) is part of its parent's album. */
export function albumRootOf(folder: string): { root: string; disc: number | null } {
  const cut = folder.lastIndexOf('/');
  const base = cut >= 0 ? folder.slice(cut + 1) : folder;
  if (cut > 0 && DISC_FOLDER.test(base)) {
    const m = DISC_FOLDER_NUMBER.exec(base);
    return { root: folder.slice(0, cut), disc: m ? discNumberOf(m[1]) : null };
  }
  return { root: folder, disc: null };
}

/** A title and folder, reduced to what stays the same across rescans and re-tags of the same files. */
export function containerFingerprint(path: string, album: string): string {
  const { root } = albumRootOf(normalizeFolder(path));
  return `${root}\u001f${keyFold(stripDiscMarker(album).stem)}`;
}

// A feat. tail on a track artist is a guest, not a different album artist.
const FEAT_TAIL = /(?:\s+|\s*[([]\s*)(?:featuring|feat\.?|ft\.?)\s+.+$/i;

export function stripFeatTail(artist: string): string {
  const cleaned = artist.replace(FEAT_TAIL, '').trim();
  return cleaned || artist.trim();
}

const GENERIC_TITLE = /^(unreleased|unknown|untitled|misc|miscellaneous|singles?|demos?|loosies|b-?sides|other|no album|\d{4}(\/\d{2,4})?|new folder|music|downloads?|tracks|songs|mixtapes?|leaks?|rarities|bootlegs?|sessions?)$/i;

export function isGenericAlbumTitle(stem: string): boolean {
  return GENERIC_TITLE.test(stem.trim());
}

// Titles every label has used for a different compilation. Two folders of
// Various Artists tracks under one of these are two records, not one split
// across folders. Matched on the folded title, so a leading "The" is gone.
const GENERIC_COMPILATION_TITLE = /^(greatest hits|best of|best|very best of|very best|hits|collection|essentials?|classics|anthology|compilation|soundtrack|original soundtrack|ost)$/;

export function isGenericCompilationTitle(stemKey: string): boolean {
  return GENERIC_COMPILATION_TITLE.test(stemKey);
}

export function validYear(year: number | null | undefined): number | null {
  return typeof year === 'number' && Number.isFinite(year) && year >= 1000 && year <= 2100 ? Math.trunc(year) : null;
}

/** FNV-1a over two seeds: short, stable, and good enough to tell a few thousand folders apart. */
export function shortHash(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x1b873593;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = (Math.imul(b + c, 0x85ebca6b) ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

function mostFrequent(values: Iterable<string>): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = '';
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function mostFrequentNumber(values: Iterable<number>): number | null {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

// -- one track on its own (before the folder is looked at) -------------------

/**
 * The identity a track gets when it is written, before the pass that looks at
 * its folder has run: the plain title-and-album-artist grouping with the
 * folds applied. The pass refines it.
 */
export function provisionalIdentity(track: Pick<IdentityTrack, 'path' | 'album' | 'artist' | 'albumArtist' | 'year' | 'albumArtistSort' | 'artistSort' | 'discNo'>): TrackIdentity {
  const { stem, disc } = stripDiscMarker(track.album);
  const artistText = (track.albumArtist || track.artist).trim() || 'Unknown Artist';
  const artistKey = keyFold(artistText) || UNKNOWN_ARTIST_KEY;
  const va = isVariousKey(artistKey);
  const folderDisc = albumRootOf(normalizeFolder(track.path)).disc;
  return {
    albumKey: `${keyFold(stem) || baseFold(stem)}|${va ? VA_ARTIST_KEY : artistKey}`,
    albumDisplay: stem,
    albumArtistDisplay: va ? VARIOUS_ARTISTS : artistText,
    albumKind: va ? 'compilation' : 'album',
    albumReason: null,
    albumYear: validYear(track.year),
    albumSortKey: va ? 'various artists' : artistSortKey(artistText, track.albumArtistSort),
    discInferred: track.discNo == null ? (disc ?? folderDisc) : null,
  };
}

// -- the pass ----------------------------------------------------------------

type Mode = 'plain' | 'tag' | 'inherit' | 'dominant' | 'flag' | 'infer' | 'adopt';

interface PassTrack {
  src: IdentityTrack;
  root: string;
  folderDisc: number | null;
  stem: string;
  titleDisc: number | null;
  stemKey: string;
  artistText: string;
  artistKey: string;
  tagText: string | null;
  tagKey: string | null;
  aaKey: string;
  aaText: string;
  aaFromTag: boolean;
  mode: Mode;
  container: Container;
  out: TrackIdentity | null;
}

interface ContainerFacts {
  tracks: number;
  artists: number;
  flagged: number;
  tagged: number;
  inheritedFrom: string | null;
  inherited: number;
  dominant: string | null;
  dominantShare: number;
}

interface Container {
  fingerprint: string;
  root: string;
  tracks: PassTrack[];
  split: boolean;
  facts: ContainerFacts;
}

export interface IdentitySummary {
  tracks: number;
  albums: number;
  changed: number;
  compilations: number;
  buckets: number;
}

/**
 * One grouping pass over every track that has an album. Load the tracks with
 * add(), then call resolve() and finalize() until each reports it is done; each
 * call does a bounded amount of work so a caller can give the thread back in
 * between. Nothing here touches a database.
 */
export class IdentityPass {
  private readonly tracks: PassTrack[] = [];
  private readonly containers = new Map<string, Container>();
  private queue: Container[] = [];
  private queueAt = 0;
  private groups: Array<{ preKey: string; tracks: PassTrack[]; split: boolean }> = [];
  private groupAt = 0;
  private preGroups = new Map<string, { preKey: string; tracks: PassTrack[]; split: boolean }>();
  private readonly finalKeys = new Set<string>();
  private compilations = 0;
  private buckets = 0;

  constructor(private readonly splits: ReadonlySet<string> = new Set()) {}

  add(src: IdentityTrack): void {
    const folder = normalizeFolder(src.path);
    const { root, disc: folderDisc } = albumRootOf(folder);
    const { stem, disc: titleDisc } = stripDiscMarker(src.album);
    const stemKey = keyFold(stem) || baseFold(stem);
    const artistText = stripFeatTail(src.artist || '');
    const artistKey = isUnknownArtist(artistText) ? '' : keyFold(artistText) || baseFold(artistText);
    const tagText = taggedAlbumArtist(src);
    const tagKey = tagText ? keyFold(tagText) || baseFold(tagText) : null;
    const fingerprint = `${root}\u001f${stemKey}`;
    let container = this.containers.get(fingerprint);
    if (!container) {
      container = {
        fingerprint,
        root,
        tracks: [],
        split: this.splits.has(fingerprint),
        facts: { tracks: 0, artists: 0, flagged: 0, tagged: 0, inheritedFrom: null, inherited: 0, dominant: null, dominantShare: 0 },
      };
      this.containers.set(fingerprint, container);
    }
    const track: PassTrack = {
      src,
      root,
      folderDisc,
      stem,
      titleDisc,
      stemKey,
      artistText,
      artistKey,
      tagText,
      tagKey,
      aaKey: '',
      aaText: '',
      aaFromTag: false,
      mode: 'plain',
      container,
      out: null,
    };
    container.tracks.push(track);
    this.tracks.push(track);
  }

  get trackCount(): number {
    return this.tracks.length;
  }

  /** Resolves up to `limit` folders. True when every folder is done. */
  resolve(limit: number): boolean {
    if (!this.queue.length && this.queueAt === 0) this.queue = [...this.containers.values()];
    const end = Math.min(this.queue.length, this.queueAt + limit);
    for (; this.queueAt < end; this.queueAt++) this.resolveContainer(this.queue[this.queueAt]!);
    if (this.queueAt < this.queue.length) return false;
    if (!this.groups.length) this.groups = [...this.preGroups.values()];
    return true;
  }

  /** Settles up to `limit` groups: bucket check, display text, year, sort order, reason. True when done. */
  finalize(limit: number): boolean {
    const end = Math.min(this.groups.length, this.groupAt + limit);
    for (; this.groupAt < end; this.groupAt++) this.finalizeGroup(this.groups[this.groupAt]!);
    return this.groupAt >= this.groups.length;
  }

  /** Every track whose identity differs from the one it came in with. */
  *changed(): Generator<{ track: IdentityTrack; identity: TrackIdentity }> {
    for (const t of this.tracks) {
      const out = t.out;
      if (!out) continue;
      const prev = t.src.prev;
      if (prev && sameIdentity(prev, out)) continue;
      yield { track: t.src, identity: out };
    }
  }

  /** Every track with the identity the pass settled on. */
  *all(): Generator<{ track: IdentityTrack; identity: TrackIdentity }> {
    for (const t of this.tracks) if (t.out) yield { track: t.src, identity: t.out };
  }

  summary(): IdentitySummary {
    let changed = 0;
    for (const t of this.tracks) {
      if (t.out && !(t.src.prev && sameIdentity(t.src.prev, t.out))) changed++;
    }
    return {
      tracks: this.tracks.length,
      albums: this.finalKeys.size,
      changed,
      compilations: this.compilations,
      buckets: this.buckets,
    };
  }

  // -- one folder -----------------------------------------------------------

  private resolveContainer(c: Container): void {
    const ts = c.tracks;
    const n = ts.length;
    const facts = c.facts;
    facts.tracks = n;

    if (c.split) {
      // The user asked for this folder's tracks apart: each keeps the album
      // artist its own tags give, which is what the library did before.
      for (const t of ts) {
        const text = (t.src.albumArtist || t.src.artist).trim() || 'Unknown Artist';
        t.aaKey = keyFold(text) || baseFold(text) || UNKNOWN_ARTIST_KEY;
        t.aaText = text;
        this.addToGroup(t, true);
      }
      return;
    }

    const tagCounts = new Map<string, { count: number; texts: string[] }>();
    let tagged = 0;
    let flagged = 0;
    let variousTagged = 0;
    const artistCounts = new Map<string, number>();
    let voters = 0;
    for (const t of ts) {
      if (t.tagKey) {
        tagged++;
        if (isVariousKey(t.tagKey)) variousTagged++;
        const entry = tagCounts.get(t.tagKey);
        if (entry) {
          entry.count++;
          entry.texts.push(t.tagText!);
        } else tagCounts.set(t.tagKey, { count: 1, texts: [t.tagText!] });
      }
      if (t.src.tagsKnown && t.src.compilation) flagged++;
      if (t.artistKey) {
        voters++;
        artistCounts.set(t.artistKey, (artistCounts.get(t.artistKey) ?? 0) + 1);
      }
    }
    let topTagKey: string | null = null;
    let topTagCount = 0;
    for (const [key, entry] of tagCounts) {
      if (entry.count > topTagCount || (entry.count === topTagCount && topTagKey !== null && key < topTagKey)) {
        topTagKey = key;
        topTagCount = entry.count;
      }
    }
    let topArtistShare = 0;
    for (const count of artistCounts.values()) topArtistShare = Math.max(topArtistShare, voters ? count / voters : 0);
    facts.tagged = tagged;
    facts.flagged = flagged;
    facts.artists = artistCounts.size;

    // The compilation flag alone does not make a folder Various Artists: one
    // artist's own album that iTunes marked "part of a compilation" is still
    // theirs, and two such albums must not merge.
    let mode: Mode = 'plain';
    if (
      flagged / n >= FLAG_MIN_SHARE
      && ((tagged === 0 && artistCounts.size >= FLAG_MIN_ARTISTS)
        || (topTagKey !== null && isVariousKey(topTagKey))
        || tagCounts.size >= 3)
    ) {
      mode = 'flag';
    } else if (
      (tagged === 0 || (variousTagged === tagged && tagged / n <= INFER_MAX_TAGGED_SHARE))
      && n >= INFER_MIN_TRACKS
      && artistCounts.size >= INFER_MIN_ARTISTS
      && topArtistShare <= INFER_MAX_SHARE
    ) {
      mode = 'infer';
    }

    const topTag = topTagKey !== null ? tagCounts.get(topTagKey)! : null;
    const inheritFrom = topTag && topTag.count / n >= INHERIT_MIN_SHARE ? topTagKey : null;
    for (const t of ts) {
      if (mode !== 'plain') {
        t.aaKey = VA_ARTIST_KEY;
        t.aaText = VARIOUS_ARTISTS;
        t.mode = mode;
      } else if (t.tagKey) {
        t.aaFromTag = true;
        t.aaKey = isVariousKey(t.tagKey) ? VA_ARTIST_KEY : t.tagKey;
        t.aaText = isVariousKey(t.tagKey) ? VARIOUS_ARTISTS : t.tagText!;
        t.mode = 'tag';
      } else if (inheritFrom) {
        t.aaKey = isVariousKey(inheritFrom) ? VA_ARTIST_KEY : inheritFrom;
        t.aaText = isVariousKey(inheritFrom) ? VARIOUS_ARTISTS : mostFrequent(topTag!.texts);
        t.mode = 'inherit';
        facts.inherited++;
        facts.inheritedFrom = t.aaText;
      } else {
        t.aaKey = t.artistKey || UNKNOWN_ARTIST_KEY;
        t.aaText = t.artistKey ? t.artistText : 'Unknown Artist';
        t.mode = 'plain';
      }
    }

    // A track with no artist at all casts no vote; it joins the folder's one real artist.
    if (mode === 'plain') {
      const real = new Set<string>();
      let adopt: { key: string; text: string } | null = null;
      for (const t of ts) {
        if (t.tagKey || !t.artistKey) continue;
        real.add(t.aaKey);
        adopt = { key: t.aaKey, text: t.aaText };
      }
      if (real.size === 1 && adopt) {
        for (const t of ts) {
          if (t.tagKey || t.artistKey) continue;
          t.aaKey = adopt.key;
          t.aaText = adopt.text;
          t.mode = 'adopt';
        }
      }
    }

    // One artist on most of an untagged folder, the rest guests: it is theirs.
    // Only artists the files name vote; "Unknown Artist" on most of a folder
    // must not win it from the one real artist on the rest.
    if (mode === 'plain' && n >= INFER_MIN_TRACKS && tagged < n) {
      const counts = new Map<string, { count: number; text: string }>();
      let hasVarious = false;
      let named = 0;
      for (const t of ts) {
        if (t.aaKey === VA_ARTIST_KEY) hasVarious = true;
        if (t.aaKey === UNKNOWN_ARTIST_KEY) continue;
        named++;
        const entry = counts.get(t.aaKey);
        if (entry) entry.count++;
        else counts.set(t.aaKey, { count: 1, text: t.aaText });
      }
      if (counts.size >= 2 && !hasVarious && named >= INFER_MIN_TRACKS) {
        let topKey = '';
        let top = { count: 0, text: '' };
        for (const [key, entry] of counts) {
          if (entry.count > top.count || (entry.count === top.count && key < topKey)) {
            topKey = key;
            top = entry;
          }
        }
        if (top.count / named >= DOMINANT_MIN_SHARE && !isSharedRelease(c, topKey, counts.keys())) {
          for (const t of ts) {
            if (t.tagKey) continue;
            t.aaKey = topKey;
            t.aaText = top.text;
            t.mode = 'dominant';
          }
          facts.dominant = top.text;
          facts.dominantShare = top.count / named;
        }
      }
    }

    for (const t of ts) this.addToGroup(t, false);
  }

  private addToGroup(t: PassTrack, split: boolean): void {
    const preKey = split
      ? `${t.stemKey}|${t.aaKey}|!${shortHash(t.container.fingerprint)}`
      : `${t.stemKey}|${t.aaKey}`;
    let group = this.preGroups.get(preKey);
    if (!group) {
      group = { preKey, tracks: [], split };
      this.preGroups.set(preKey, group);
    }
    group.tracks.push(t);
  }

  // -- one album --------------------------------------------------------------

  private finalizeGroup(group: { preKey: string; tracks: PassTrack[]; split: boolean }): void {
    const roots = new Set<string>();
    for (const t of group.tracks) roots.add(t.root);
    const first = group.tracks[0]!;
    const demote = !group.split
      && isGenericAlbumTitle(first.stem)
      && (roots.size >= BUCKET_MIN_FOLDERS || group.tracks.length >= BUCKET_MIN_TRACKS);
    if (demote) {
      const byRoot = new Map<string, PassTrack[]>();
      for (const t of group.tracks) {
        const list = byRoot.get(t.root);
        if (list) list.push(t);
        else byRoot.set(t.root, [t]);
      }
      for (const [root, list] of byRoot) this.settle(`${group.preKey}|@${shortHash(root)}`, list, 'bucket', roots.size);
      this.buckets += byRoot.size;
      return;
    }
    // "Greatest Hits" by Various Artists in two folders is two compilations,
    // unless the titles themselves name discs of one set.
    const separateComps = !group.split
      && first.aaKey === VA_ARTIST_KEY
      && roots.size >= 2
      && isGenericCompilationTitle(first.stemKey)
      && !group.tracks.some((t) => t.titleDisc !== null);
    if (separateComps) {
      const byRoot = new Map<string, PassTrack[]>();
      for (const t of group.tracks) {
        const list = byRoot.get(t.root);
        if (list) list.push(t);
        else byRoot.set(t.root, [t]);
      }
      for (const [root, list] of byRoot) this.settle(`${group.preKey}|@${shortHash(root)}`, list, 'compilation', 1);
      this.compilations += byRoot.size;
      return;
    }
    const kind: AlbumKind = group.split ? 'split' : first.aaKey === VA_ARTIST_KEY ? 'compilation' : 'album';
    if (kind === 'compilation') this.compilations++;
    this.settle(group.preKey, group.tracks, kind, roots.size);
  }

  private settle(key: string, tracks: PassTrack[], kind: AlbumKind, rootCount: number): void {
    this.finalKeys.add(key);
    const first = tracks[0]!;
    const albumDisplay = mostFrequent(tracks.map((t) => t.stem)) || first.stem;
    const various = first.aaKey === VA_ARTIST_KEY;
    const artistDisplay = various ? VARIOUS_ARTISTS : mostFrequent(tracks.map((t) => t.aaText)) || first.aaText;
    const years: number[] = [];
    for (const t of tracks) {
      const y = validYear(t.src.year);
      if (y !== null) years.push(y);
    }
    const albumYear = mostFrequentNumber(years);
    const sortKey = various ? 'various artists' : groupSortKey(tracks, artistDisplay);
    const reason = groupReason(tracks, kind, albumDisplay, rootCount);
    // Files that all say disc 1 under titles or folders naming discs 1 and 2
    // are mistagged, and the disc the title names keeps the album in order.
    const named = new Set<number>();
    const filed = new Set<number>();
    for (const t of tracks) {
      const marked = t.titleDisc ?? t.folderDisc;
      if (marked !== null) named.add(marked);
      if (t.src.discNo != null) filed.add(t.src.discNo);
    }
    const markersWin = named.size >= 2 && filed.size < named.size;
    for (const t of tracks) {
      t.out = {
        albumKey: key,
        albumDisplay,
        albumArtistDisplay: artistDisplay,
        albumKind: kind,
        albumReason: reason,
        albumYear,
        albumSortKey: sortKey,
        discInferred: t.src.discNo == null || markersWin ? (t.titleDisc ?? t.folderDisc ?? null) : null,
      };
    }
  }
}

// Two bands on one record: a title that says "split", or a title and folder
// that between them name the leading artist and another one. Neither band owns
// it, so the dominant-artist rule leaves it alone and each band keeps its own
// tracks. An artist whose name sits inside the leader's, or the other way round
// ("Future" in "Future & Young Thug", "Frank Zappa" in "Frank Zappa And The
// Mothers Of Invention"), is the same act under another spelling, not a second band.
function isSharedRelease(c: Container, leader: string, artistKeys: Iterable<string>): boolean {
  const first = c.tracks[0]!;
  if (/\bsplit\b/i.test(first.stem)) return true;
  const where = ` ${first.stemKey} ${keyFold(c.root.slice(c.root.lastIndexOf('/') + 1))} `;
  const named = (key: string): boolean => key.length >= 3 && where.includes(` ${key} `);
  if (!named(leader)) return false;
  for (const key of artistKeys) {
    if (key === leader || !named(key)) continue;
    if (` ${leader} `.includes(` ${key} `) || ` ${key} `.includes(` ${leader} `)) continue;
    return true;
  }
  return false;
}

function taggedAlbumArtist(src: IdentityTrack): string | null {
  if (src.albumArtistEdited) {
    const edited = src.albumArtist.trim();
    return edited || null;
  }
  if (src.tagsKnown) {
    const tag = (src.albumArtistTag ?? '').trim();
    return tag || null;
  }
  // Not read for the tag yet: an album artist that differs from the track
  // artist can only have come from a tag, so it stands in until the file is read.
  const aa = (src.albumArtist ?? '').trim();
  if (!aa || baseFold(aa) === baseFold(src.artist)) return null;
  return aa;
}

function groupSortKey(tracks: PassTrack[], artistDisplay: string): string {
  const sorts: string[] = [];
  for (const t of tracks) {
    const tag = t.aaFromTag ? t.src.albumArtistSort : t.src.artistSort;
    const folded = baseFold(tag);
    if (folded && sharesWord(folded, artistDisplay)) sorts.push(folded);
  }
  if (sorts.length) return mostFrequent(sorts);
  return artistSortKey(artistDisplay);
}

function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

function groupReason(tracks: PassTrack[], kind: AlbumKind, albumDisplay: string, rootCount: number): string | null {
  const n = tracks.length;
  const where = rootCount > 1 ? ` across ${plural(rootCount, 'folder')}` : '';
  if (kind === 'split') return 'Shown as separate albums at your request.';
  if (kind === 'bucket') {
    return `Several folders use the generic title "${albumDisplay}", so each folder is its own album.`;
  }
  const modes = new Map<Mode, number>();
  for (const t of tracks) modes.set(t.mode, (modes.get(t.mode) ?? 0) + 1);
  if (kind === 'compilation') {
    const flag = modes.get('flag') ?? 0;
    const infer = modes.get('infer') ?? 0;
    if (infer >= flag && infer > 0) {
      const artists = new Set(tracks.map((t) => t.artistKey).filter(Boolean)).size;
      const named = tracks.filter((t) => t.tagKey).length;
      const files = named
        ? `${plural(named, 'file')} name${named === 1 ? 's' : ''} Various Artists as the album artist and the rest name none`
        : 'with no album artist in the files';
      return `Grouped as a compilation: ${plural(n, 'track')} by ${plural(artists, 'different artist')}${where}, ${files}.`;
    }
    if (flag > 0) {
      return `Grouped as a compilation: ${plural(flag, 'track')} carry the compilation flag and the files name no single album artist${where}.`;
    }
    return `Grouped under Various Artists because the files name it as the album artist${where}.`;
  }
  const adopted = modes.get('adopt') ?? 0;
  if (adopted > 0) {
    return `Grouped under ${tracks.find((t) => t.mode === 'adopt')!.aaText}, the only artist named in this folder. ${plural(adopted, 'track')} named none.`;
  }
  const dominant = modes.get('dominant') ?? 0;
  if (dominant > 0) {
    const c = tracks.find((t) => t.mode === 'dominant')!.container.facts;
    return `Grouped under ${c.dominant}, who is on ${Math.round(c.dominantShare * 100)}% of these tracks. The other artists are guests.`;
  }
  const inherit = modes.get('inherit') ?? 0;
  if (inherit > 0) {
    const c = tracks.find((t) => t.mode === 'inherit')!.container.facts;
    return `Grouped under ${c.inheritedFrom}, the album artist most of these files name. ${plural(inherit, 'track')} had none.`;
  }
  if (rootCount > 1) {
    return `Joined ${plural(rootCount, 'folder')} that hold the same album: same title, same artist.`;
  }
  if (tracks.some((t) => t.titleDisc !== null && t.stem !== t.src.album.trim())) {
    const discs = new Set(tracks.map((t) => t.titleDisc ?? t.folderDisc ?? 1)).size;
    return `Joined ${plural(Math.max(discs, 2), 'disc')}: the album titles differed only by a disc number.`;
  }
  const spellings = [...new Set(tracks.map((t) => t.stem))];
  if (spellings.length > 1) {
    return `Merged spellings of the same album: ${spellings.slice(0, 2).map((s) => `"${s}"`).join(' and ')}.`;
  }
  const artistSpellings = [...new Set(tracks.map((t) => t.aaText))];
  if (artistSpellings.length > 1) {
    return `Merged spellings of the same album artist: ${artistSpellings.slice(0, 2).map((s) => `"${s}"`).join(' and ')}.`;
  }
  return null;
}

function sameIdentity(a: StoredIdentity, b: TrackIdentity): boolean {
  return a.albumKey === b.albumKey
    && a.albumDisplay === b.albumDisplay
    && a.albumArtistDisplay === b.albumArtistDisplay
    && a.albumKind === b.albumKind
    && (a.albumReason ?? null) === b.albumReason
    && (a.albumYear ?? null) === b.albumYear
    && a.albumSortKey === b.albumSortKey
    && (a.discInferred ?? null) === b.discInferred;
}

/** The whole pass in one call, for tests and for callers with nothing to yield to. */
export function computeAlbumIdentities(
  tracks: Iterable<IdentityTrack>,
  splits: ReadonlySet<string> = new Set(),
): { pass: IdentityPass; identities: Map<number, TrackIdentity>; summary: IdentitySummary } {
  const pass = new IdentityPass(splits);
  for (const t of tracks) pass.add(t);
  while (!pass.resolve(2000)) { /* keep going */ }
  while (!pass.finalize(2000)) { /* keep going */ }
  const identities = new Map<number, TrackIdentity>();
  for (const { track, identity } of pass.all()) identities.set(track.id, identity);
  return { pass, identities, summary: pass.summary() };
}

/**
 * The album key for a (album artist, album) pair as a user or an older caller
 * would write it, with no folder to look at: the plain grouping, folds applied.
 */
export function keyForPair(albumArtist: string, album: string): string {
  const { stem } = stripDiscMarker(album);
  const artistKey = keyFold(albumArtist) || UNKNOWN_ARTIST_KEY;
  return `${keyFold(stem) || baseFold(stem)}|${isVariousKey(artistKey) ? VA_ARTIST_KEY : artistKey}`;
}
