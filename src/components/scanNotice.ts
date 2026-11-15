export interface UnreachableNotice {
  /** What the banner says. */
  text: string;
  /** Every folder's full path, one per line, for the tooltip. */
  title: string;
}

/**
 * A folder as the banner names it: its last path segment, with the drive after
 * it on Windows ("Music (K:)"). A drive on its own, or a path with no segment,
 * is shown as written.
 */
export function folderLabel(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return path;
  const drive = /^([A-Za-z]:)(?:[\\/]|$)/.exec(path)?.[1];
  return drive && last !== drive ? `${last} (${drive})` : last;
}

/**
 * What to tell the user when a finished scan could not look inside some of its
 * roots (missing, unreachable, or an empty mount point), or null when it could
 * reach all of them.
 */
export function unreachableNotice(roots: readonly string[] | undefined): UnreachableNotice | null {
  const unreachable = (roots ?? []).filter((root) => typeof root === 'string' && root.length > 0);
  const first = unreachable[0];
  if (first === undefined) return null;
  const title = unreachable.join('\n');
  if (unreachable.length === 1) {
    return { text: `Couldn't reach ${folderLabel(first)}. Nothing was changed for that folder.`, title };
  }
  return {
    text: `Couldn't reach ${unreachable.length} folders, starting with ${folderLabel(first)}. Nothing was changed for those folders.`,
    title,
  };
}
