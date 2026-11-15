import type { OpenFilesResult } from '@shared/types';

// `leftToScanner` is how many files of an opened folder were not queued: past the
// cap, the library scanner adds them. A result that does not carry it held
// nothing back.
type OpenedFiles = Pick<OpenFilesResult, 'tracks' | 'importedPlaylists' | 'leftToScanner'>;

function leftToScanner(result: OpenedFiles): number {
  const left = result.leftToScanner;
  return typeof left === 'number' && Number.isFinite(left) && left > 0 ? left : 0;
}

/** The status line after files or folders were dropped on the window. */
export function openedItemsStatus(
  result: OpenedFiles | null,
  { queueKept, skinName }: { queueKept: boolean; skinName: string | null },
): string {
  const skinSuffix = skinName ? ` Applied skin ${skinName}.` : '';
  if (!result) return 'Could not open the dropped items.';
  const queued = result.tracks.length;
  if (queued) {
    const kept = queueKept ? ', queue kept' : '';
    if (leftToScanner(result) > 0) {
      return `Playing the first ${queued.toLocaleString()} tracks${kept}. The rest of the folder is being added to the library.${skinSuffix}`;
    }
    return `Playing ${queued.toLocaleString()} track${queued === 1 ? '' : 's'}${kept}.${skinSuffix}`;
  }
  const playlists = result.importedPlaylists.length;
  if (playlists) return `Imported ${playlists.toLocaleString()} playlist${playlists === 1 ? '' : 's'}.${skinSuffix}`;
  return skinName ? `Applied skin ${skinName}.` : 'No playable audio was found in the dropped items.';
}

/** The notice for files opened from the menu or the command line, which say nothing otherwise: only a folder that was cut short has one. */
export function partialFolderNotice(result: OpenedFiles | null): { title: string; detail: string } | null {
  if (!result || !result.tracks.length || leftToScanner(result) <= 0) return null;
  return {
    title: `Playing the first ${result.tracks.length.toLocaleString()} tracks`,
    detail: 'The rest of the folder is being added to the library.',
  };
}
