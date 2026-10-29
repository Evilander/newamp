import { extname } from 'node:path';

// What a library walk never reads, shared by the scanner and the watcher so a
// change inside one of these doesn't rescan what a scan skips.

// macOS packages. Finder shows each as a single file, and what is inside
// belongs to the app that made it: Logic projects, the Logic sound library
// (thousands of loops and impulse responses under ~/Music), the Music and
// Photos libraries, apps and plug-ins.
const PACKAGE_EXTENSIONS = new Set([
  '.app',
  '.bundle',
  '.framework',
  '.plugin',
  '.component',
  '.vst',
  '.vst3',
  '.aaxplugin',
  '.logicx',
  '.musiclibrary',
  '.photoslibrary',
  '.tvlibrary',
  '.imovielibrary',
  '.fcpbundle',
  '.sparsebundle',
  '.pkg',
  '.mpkg',
]);

// Folders by name, wherever they are.
const SKIPPED_FOLDERS = new Set([
  // Windows' per-drive system folders; the recycle bin holds deleted music.
  'system volume information',
  '$recycle.bin',
  // Resource forks a Mac-made zip carries, one "._" file per real file.
  '__macosx',
  // Logic Pro and GarageBand content in ~/Music: sampler instruments, Apple
  // Loops, impulse responses and channel strip settings.
  'audio music apps',
  'apple loops',
]);

// Ableton Live's packs and sample library, in ~/Music/Ableton.
const SKIPPED_ABLETON_FOLDERS = new Set(['factory packs', 'user library']);

// A folder whose contents belong to another app, never music.
function isForeignFolder(name: string, parentName: string): boolean {
  const lower = name.toLowerCase();
  if (SKIPPED_FOLDERS.has(lower)) return true;
  if (PACKAGE_EXTENSIONS.has(extname(lower))) return true;
  const parent = parentName.toLowerCase();
  // GarageBand projects are packages too, but ".band" also ends folder names
  // such as "Big.Band", so only the ones in GarageBand's own folder count.
  if (parent === 'garageband' && extname(lower) === '.band') return true;
  return parent === 'ableton' && SKIPPED_ABLETON_FOLDERS.has(lower);
}

/** True for a folder the walk should not enter. `parentName` is the name of the folder holding it. */
export function isSkippedLibraryFolder(name: string, parentName = ''): boolean {
  return name.startsWith('.') || isForeignFolder(name, parentName);
}

/**
 * True for a file the walk should not read. Hidden files include the "._"
 * AppleDouble files macOS writes next to every file it copies to an SMB, NFS
 * or exFAT volume: they carry an audio extension but hold no audio.
 */
export function isSkippedLibraryFile(name: string): boolean {
  return name.startsWith('.');
}

function pathParts(relativePath: string): string[] {
  return relativePath.split(/[\\/]+/).filter(Boolean);
}

/**
 * True when a path below a library root passes through a skipped folder or
 * names a skipped file. `rootName` is the root folder's own name, the parent
 * of the path's first part.
 */
export function isSkippedLibraryPath(relativePath: string, rootName = ''): boolean {
  const parts = pathParts(relativePath);
  if (!parts.length) return false;
  const parentOf = (i: number): string => (i > 0 ? parts[i - 1] : rootName);
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (isSkippedLibraryFolder(parts[i], parentOf(i))) return true;
  }
  const last = parts.length - 1;
  return isSkippedLibraryFile(parts[last]) || isSkippedLibraryFolder(parts[last], parentOf(last));
}

/**
 * The part of the skipped set that is never music: a path through another
 * app's folders, or an AppleDouble "._" file. A track the library holds from
 * there was indexed by an earlier version and can go. A file in a hidden
 * folder is skipped by the walk too, but someone may have opened it on
 * purpose, so it is not counted here.
 */
export function isForeignLibraryPath(relativePath: string, rootName = ''): boolean {
  const parts = pathParts(relativePath);
  if (!parts.length) return false;
  const parentOf = (i: number): string => (i > 0 ? parts[i - 1] : rootName);
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (isForeignFolder(parts[i], parentOf(i))) return true;
  }
  const last = parts.length - 1;
  return parts[last].startsWith('._') || isForeignFolder(parts[last], parentOf(last));
}
