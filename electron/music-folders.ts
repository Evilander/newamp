import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { MusicFolderSuggestion } from '../shared/types.js';

type EnvLike = Record<string, string | undefined>;

function listVolumes(): string[] {
  try {
    return readdirSync('/Volumes');
  } catch {
    return [];
  }
}

export interface MusicFolderSuggestionOptions {
  homeDir?: string;
  env?: EnvLike;
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  readVolumes?: () => string[];
}

export interface DefaultMusicScanRootOptions extends MusicFolderSuggestionOptions {
  fallbackMusicPath?: string;
}

export function suggestMusicFolders({
  homeDir = homedir(),
  env = process.env,
  exists = existsSync,
  platform = process.platform,
  readVolumes = listVolumes,
}: MusicFolderSuggestionOptions = {}): MusicFolderSuggestion[] {
  const candidates: MusicFolderSuggestion[] = [];
  const configuredRoot = cleanPath(env.NEWAMP_REAL_LIBRARY_ROOT);
  if (configuredRoot) {
    candidates.push({
      path: configuredRoot,
      label: 'Configured music root',
      reason: 'NEWAMP_REAL_LIBRARY_ROOT is set',
    });
  }

  if (platform === 'darwin') {
    const home = cleanPath(homeDir);
    if (home) {
      candidates.push(
        { path: childPath(home, 'Music'), label: 'Music', reason: 'Default macOS user music folder' },
        { path: childPath(home, 'Music/Music/Media'), label: 'Apple Music library', reason: 'Apple Music media folder' },
        { path: childPath(home, 'Music/iTunes/iTunes Media'), label: 'iTunes library', reason: 'iTunes media folder' },
      );
    }
    for (const vol of readVolumes()) {
      if (vol === 'Macintosh HD' || vol.startsWith('.')) continue;
      candidates.push({
        path: `/Volumes/${vol}/Music`,
        label: `${vol} music`,
        reason: 'External volume music folder',
      });
    }
  } else {
    candidates.push(
      { path: 'K:/music', label: 'K drive music', reason: 'Detected common external music library path' },
      { path: 'I:/music', label: 'I drive music', reason: 'Detected common external music library path' },
    );

    const profileMusic = cleanPath(homeDir) ? childPath(homeDir, 'Music') : '';
    if (profileMusic) {
      candidates.push({
        path: profileMusic,
        label: 'Windows Music',
        reason: 'Default Windows profile music folder',
      });
    }

    for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      const root = cleanPath(env[key]);
      if (!root) continue;
      candidates.push({
        path: childPath(root, 'Music'),
        label: key === 'OneDriveCommercial' ? 'Work OneDrive Music' : 'OneDrive Music',
        reason: `${key} music folder`,
      });
    }
  }

  const seen = new Set<string>();
  const out: MusicFolderSuggestion[] = [];
  for (const candidate of candidates) {
    const path = cleanPath(candidate.path);
    if (!path) continue;
    const dedupeKey = normalizeKey(path);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (!safeExists(path, exists)) continue;
    out.push({ ...candidate, path });
  }
  return out;
}

export function defaultMusicScanRoots({
  fallbackMusicPath,
  exists = existsSync,
  ...options
}: DefaultMusicScanRootOptions = {}): string[] {
  const [firstSuggestion] = suggestMusicFolders({ ...options, exists });
  if (firstSuggestion) return [firstSuggestion.path];

  const fallback = cleanPath(fallbackMusicPath);
  if (fallback && safeExists(fallback, exists)) return [fallback];
  return [];
}

function childPath(parent: string, child: string): string {
  const trimmed = parent.replace(/[\\/]+$/, '');
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/';
  return `${trimmed}${separator}${child}`;
}

function cleanPath(path: string | undefined): string {
  return typeof path === 'string' ? path.trim() : '';
}

function normalizeKey(path: string): string {
  return path.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function safeExists(path: string, exists: (path: string) => boolean): boolean {
  try {
    return exists(path);
  } catch {
    return false;
  }
}
