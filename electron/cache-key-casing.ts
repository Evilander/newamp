// Whether the transcode-cache key should be case-folded for the given platform.
// Windows (NTFS) and macOS default (APFS, case-INSENSITIVE) treat /A and /a as
// the same file, so the cache key must fold case there to avoid duplicate
// transcodes. Linux (ext4, case-sensitive) must not fold. Pure for testing.

export function caseFoldCachePath(canon: string, platform: NodeJS.Platform): string {
  return platform === 'win32' || platform === 'darwin' ? canon.toLowerCase() : canon;
}
