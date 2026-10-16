import { extname } from 'node:path';

// How the scanner finds a cover image in an album folder. Pure: it is handed
// what a folder holds and says which image to use, so the rule can be tried
// against real folder listings without touching a disk.

export interface FolderImage {
  name: string;
  size: number;
}

export interface FolderListing {
  images: FolderImage[];
  subdirs: string[];
}

// Where two images of one name tie, the earlier format wins.
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];

// A name made only of these words is a cover on its own, best first. The first
// five are the names this rule has always taken.
const COVER_WORDS = ['cover', 'folder', 'front', 'art', 'album', 'albumart', 'artwork'];
const CLASSIC_COVER_WORDS = new Set(COVER_WORDS.slice(0, 5));
const COVER_HINTS = new Set([...COVER_WORDS, 'frontal', 'frontcover', 'albumcover', 'coverart']);
const THUMB_WORDS = new Set(['thumb', 'thumbs', 'thumbnail']);

// Parts of a release that are not its cover. These are scans of something else
// wherever they sit in a name ("booklet 3&4", "black album poster").
const PART_ANYWHERE = new Set(['booklet', 'inlay', 'tray', 'gatefold', 'spine', 'sticker', 'obi', 'poster']);
// These are only a part at the end of a name or ahead of a page number or
// side, so "Back to Black" and "Inside Out" stay album titles.
const PART_AT_END = new Set(['back', 'rear', 'insert', 'label', 'inside', 'outer', 'liner']);
const DISC_NUMBERED = /^(cd|disc|disk|dvd)\d+$/;
const DISC_BARE = /^(cd|disc|disk|dvd)$/;
const PART_TAIL = /^(\d{1,2}|[a-d]|cover|side|art|scan|image|page|pages|inner|outer|front|back)$/;

const WMP_LARGE = /^albumart_\{[0-9a-f-]+\}_large$/;
const WMP_SMALL = /^albumart(_\{[0-9a-f-]+\}_)?small$/;

// Guessed picks skip files too small to be a cover and too big to hold in
// memory for the length of a scan.
const MIN_GUESSED_BYTES = 3 * 1024;
const MAX_GUESSED_BYTES = 12 * 1024 * 1024;

// A folder holding these besides its tracks is still one album.
const EXTRAS_FOLDER = /^(scans?|artwork|art|covers?|images?|pics?|pictures?|photos?|booklets?|digital booklet|liner notes|extras?|bonus|lyrics|videos?|misc|other)$/i;

export function isDiscFolderName(name: string): boolean {
  const trimmed = name.trim();
  return (
    /^(cd|disc|disk|dvd|side|vol|volume)[\s._-]*([0-9]{1,3}|[a-d]|i{1,3}|iv|one|two|three|four|five|six)$/i.test(trimmed) ||
    // "CD 1 (Car Chase)", "Disc 2 - Live"
    /^(cd|disc|disk|dvd)[\s._-]*[0-9]{1,2}(?![0-9a-z])/i.test(trimmed)
  );
}

export function isFolderArtImage(fileName: string): boolean {
  return !fileName.startsWith('.') && IMAGE_EXTS.includes(extname(fileName).toLowerCase());
}

// A folder with albums or other folders full of music inside is a library
// root or an artist folder, not an album, and a stray image in it says nothing
// about the loose tracks beside it.
export function looksLikeAlbumFolder(subdirs: string[]): boolean {
  return subdirs.every((name) => isDiscFolderName(name) || EXTRAS_FOLDER.test(name.trim()));
}

function words(stem: string): string[] {
  return stem
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function isNotCover(tokens: string[]): boolean {
  if (tokens.length === 1 && DISC_BARE.test(tokens[0])) return true;
  if (PART_AT_END.has(tokens[tokens.length - 1] ?? '')) return true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // "booklet1" is page one of a booklet
    if (PART_ANYWHERE.has(token.replace(/\d+$/, '')) || DISC_NUMBERED.test(token)) return true;
    if (!PART_AT_END.has(token) && !DISC_BARE.test(token)) continue;
    const rest = tokens.slice(i + 1);
    if (rest.length && rest.every((t) => PART_TAIL.test(t))) return true;
  }
  return false;
}

type Fit =
  | { kind: 'cover'; rank: number; classic: boolean }
  | { kind: 'likely' }
  | { kind: 'plain' }
  | { kind: 'thumb' }
  | { kind: 'other' };

function fit(fileName: string): Fit {
  const stem = fileName.slice(0, fileName.length - extname(fileName).length).toLowerCase();
  if (WMP_LARGE.test(stem)) return { kind: 'cover', rank: COVER_WORDS.indexOf('albumart'), classic: false };
  const tokens = words(stem);
  if (!tokens.length) return { kind: 'plain' };
  if (isNotCover(tokens)) return { kind: 'other' };
  if (WMP_SMALL.test(stem) || tokens.some((t) => THUMB_WORDS.has(t))) return { kind: 'thumb' };
  if (tokens.every((t) => COVER_WORDS.includes(t))) {
    return {
      kind: 'cover',
      rank: Math.min(...tokens.map((t) => COVER_WORDS.indexOf(t))),
      classic: tokens.every((t) => CLASSIC_COVER_WORDS.has(t)),
    };
  }
  if (tokens.some((t) => COVER_HINTS.has(t) || t.startsWith('front'))) return { kind: 'likely' };
  return { kind: 'plain' };
}

function extOrder(fileName: string): number {
  const at = IMAGE_EXTS.indexOf(extname(fileName).toLowerCase());
  return at < 0 ? IMAGE_EXTS.length : at;
}

function byName(a: FolderImage, b: FolderImage): number {
  return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0;
}

// A file named like a cover. It is trusted whatever its size. The names this
// rule always took apply wherever the folder sits, so the loose tracks of a
// library root still share its cover.jpg; the newer ones (AlbumArt_{...}_Large,
// artwork) belong to one album and only count in an album's own folder.
function namedCover(listing: FolderListing): FolderImage | null {
  const albumFolder = looksLikeAlbumFolder(listing.subdirs);
  const covers: Array<{ image: FolderImage; rank: number }> = [];
  for (const image of listing.images) {
    const f = fit(image.name);
    if (f.kind === 'cover' && (f.classic || albumFolder)) covers.push({ image, rank: f.rank });
  }
  covers.sort((a, b) => a.rank - b.rank || extOrder(a.image.name) - extOrder(b.image.name) || byName(a.image, b.image));
  return covers[0]?.image ?? null;
}

// A guess from a folder that has no file named like a cover: the biggest image
// with a cover-like word in its name, else the only image that is not a back
// or a booklet page. Two equally plausible images are not a reason to pick one.
function guessedCover(listing: FolderListing): FolderImage | null {
  const usable = listing.images.filter((image) => image.size >= MIN_GUESSED_BYTES && image.size <= MAX_GUESSED_BYTES);
  const likely: FolderImage[] = [];
  const plain: FolderImage[] = [];
  const thumbs: FolderImage[] = [];
  for (const image of usable) {
    const f = fit(image.name);
    if (f.kind === 'likely') likely.push(image);
    else if (f.kind === 'plain') plain.push(image);
    else if (f.kind === 'thumb') thumbs.push(image);
  }
  if (likely.length) return [...likely].sort((a, b) => b.size - a.size || byName(a, b))[0];
  if (plain.length === 1) return plain[0];
  if (!plain.length && thumbs.length === 1) return thumbs[0];
  return null;
}

// The image to use for the tracks of `own`; `parent` is the folder above it
// when `own` is one disc of a set. Returns the listing the image came from.
export function chooseFolderArt(
  own: FolderListing,
  parent: FolderListing | null = null,
): { from: 'own' | 'parent'; image: FolderImage } | null {
  const sources: Array<{ from: 'own' | 'parent'; listing: FolderListing }> = [{ from: 'own', listing: own }];
  if (parent) sources.push({ from: 'parent', listing: parent });
  for (const { from, listing } of sources) {
    const image = namedCover(listing);
    if (image) return { from, image };
  }
  for (const { from, listing } of sources) {
    if (!looksLikeAlbumFolder(listing.subdirs)) continue;
    const image = guessedCover(listing);
    if (image) return { from, image };
  }
  return null;
}
