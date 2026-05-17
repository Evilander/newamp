import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { PlaylistFolderExportResult, SavedPlaylist, Track } from '../shared/types.js';

export async function exportPlaylistFolder(input: {
  playlist: SavedPlaylist;
  tracks: Track[];
  destinationRoot: string;
}): Promise<PlaylistFolderExportResult> {
  const root = String(input.destinationRoot ?? '').trim();
  if (!root) throw new Error('Choose a destination folder first.');

  await mkdir(root, { recursive: true });
  const exportDir = await createUniqueExportDirectory(root, safePortableStem(input.playlist.name || 'NewAmp Playlist'));
  const skipped: string[] = [];
  const lines = ['#EXTM3U', `#PLAYLIST:${input.playlist.name}`];
  let copied = 0;
  let bytes = 0;
  const usedNames = new Set<string>();

  for (const [index, track] of input.tracks.entries()) {
    const ext = extname(track.path) || '.audio';
    const sourceTitle = track.title || basename(track.path, ext);
    const fileName = uniqueFileName(
      usedNames,
      `${safePortableStem(`${String(index + 1).padStart(3, '0')} - ${track.artist || 'Unknown Artist'} - ${sourceTitle}`)}${ext}`,
    );
    const targetPath = join(exportDir, fileName);
    try {
      await copyFile(track.path, targetPath);
      const target = await stat(targetPath);
      copied += 1;
      bytes += target.size;
      const duration = track.duration ? Math.max(0, Math.round(track.duration)) : -1;
      lines.push(`#EXTINF:${duration},${track.artist} - ${track.title}`);
      lines.push(fileName.replace(/\\/g, '/'));
    } catch {
      skipped.push(track.path);
    }
  }

  const playlistPath = join(exportDir, 'playlist.m3u8');
  await writeFile(playlistPath, `${lines.join('\n')}\n`, 'utf8');
  return { path: exportDir, playlistPath, copied, skipped, bytes };
}

async function createUniqueExportDirectory(root: string, stem: string): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    const candidate = join(root, i === 0 ? stem : `${stem}-${i + 1}`);
    if (await pathExists(candidate)) continue;
    await mkdir(candidate);
    return candidate;
  }
  throw new Error(`Could not create a unique export folder for ${stem}.`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return false;
    throw err;
  }
}

function uniqueFileName(used: Set<string>, candidate: string): string {
  const ext = extname(candidate);
  const stem = basename(candidate, ext);
  for (let i = 0; i < 1000; i += 1) {
    const name = i === 0 ? candidate : `${stem}-${i + 1}${ext}`;
    const key = name.toLowerCase();
    if (used.has(key)) continue;
    used.add(key);
    return name;
  }
  throw new Error(`Could not create a unique file name for ${candidate}.`);
}

function safePortableStem(value: string): string {
  const cleaned = String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || 'NewAmp Playlist';
}
