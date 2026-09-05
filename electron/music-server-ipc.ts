import { ipcMain, safeStorage } from 'electron';
import { join } from 'node:path';
import { CredentialVault } from './credential-vault.js';
import { MusicServerRegistry, testMusicServerConnection } from './music-servers.js';
import { musicServerTrack } from './music-server-tracks.js';
import type { MusicServerConnectionInput, MusicServerRuntimeConnection } from '../shared/music-servers.js';
import type { MusicServerTrackPage, SavedMusicServer } from '../shared/types.js';

export function registerMusicServerIpc(userDataPath: string): MusicServerRegistry {
  const vault = new CredentialVault<MusicServerRuntimeConnection>(join(userDataPath, 'music-servers.json'), {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (bytes) => safeStorage.decryptString(bytes),
  });
  const registry = new MusicServerRegistry((id) => vault.get(id) ?? null);
  let connecting = false;

  ipcMain.handle('music-servers:list', (): SavedMusicServer[] => vault.list().map(({ value, remembered }) => {
    const { secret: _secret, ...connection } = value;
    return { ...connection, remembered };
  }));
  ipcMain.handle('music-servers:connect', async (_event, input: MusicServerConnectionInput & { remember: boolean }): Promise<SavedMusicServer> => {
    if (!input || typeof input !== 'object' || typeof input.remember !== 'boolean') throw new Error('Invalid connection settings.');
    if (connecting) throw new Error('A music server connection is already in progress.');
    connecting = true;
    try {
      const { connection, secret } = await testMusicServerConnection(input);
      vault.set({ ...connection, secret }, input.remember);
      return { ...connection, remembered: input.remember };
    } finally { connecting = false; }
  });
  ipcMain.handle('music-servers:disconnect', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid connection.');
    vault.remove(id);
  });
  ipcMain.handle('music-servers:tracks', async (_event, id: string, options?: { query?: string; offset?: number; limit?: number }): Promise<MusicServerTrackPage> => {
    if (options !== undefined && (!options || typeof options !== 'object')) throw new Error('Invalid music search.');
    if (options?.query !== undefined && (typeof options.query !== 'string' || options.query.length > 500)) throw new Error('Music search is too long.');
    const page = options?.query?.trim()
      ? await registry.search(id, { query: options.query.trim(), offset: options.offset, limit: options.limit })
      : await registry.browse(id, { offset: options?.offset, limit: options?.limit });
    return { tracks: page.songs.map(musicServerTrack), total: page.total, nextOffset: page.nextOffset };
  });
  return registry;
}
