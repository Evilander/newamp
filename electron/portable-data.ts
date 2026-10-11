import { join } from 'node:path';

// The portable build is meant to carry its library with it, but earlier
// portable releases kept everything in the profile folder like the installed
// app does. Moving those users to a folder next to the exe would make their
// library look gone, so the folder beside the exe is used only when there is
// no existing profile to lose.

export const PORTABLE_DATA_DIR_NAME = 'NewAmp Data';

export interface PortableDataDecision {
  /** Folder to use as userData, or null to keep the default profile folder. */
  dir: string | null;
  reason: 'portable-folder-exists' | 'fresh-install' | 'existing-profile' | 'folder-not-writable';
}

export interface PortableDataProbe {
  exists: (path: string) => boolean;
  /** True when the folder can be created (if needed) and written to. */
  canWrite: (dir: string) => boolean;
}

// settings.json and library.db are written on the first launch of any build,
// so either one means a profile has been in use.
const PROFILE_MARKERS = ['library.db', 'settings.json'];

export function hasExistingProfile(dir: string, probe: Pick<PortableDataProbe, 'exists'>): boolean {
  return PROFILE_MARKERS.some((name) => probe.exists(join(dir, name)));
}

export function choosePortableDataDir(
  portableExecutableDir: string,
  defaultUserData: string,
  probe: PortableDataProbe,
): PortableDataDecision {
  const beside = join(portableExecutableDir, PORTABLE_DATA_DIR_NAME);
  if (probe.exists(beside)) {
    return probe.canWrite(beside)
      ? { dir: beside, reason: 'portable-folder-exists' }
      : { dir: null, reason: 'folder-not-writable' };
  }
  if (hasExistingProfile(defaultUserData, probe)) return { dir: null, reason: 'existing-profile' };
  return probe.canWrite(beside)
    ? { dir: beside, reason: 'fresh-install' }
    : { dir: null, reason: 'folder-not-writable' };
}
