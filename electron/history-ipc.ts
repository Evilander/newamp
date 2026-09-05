import { dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import type { LibraryStore } from './library.js';
import { fetchLastfmHistory, parseHistoryImport, type HistoryImportParseResult, type HistoryImportReport } from './history-import.js';

let activeImport: AbortController | null = null;

export function assertHistoryImportIdle(): void {
  if (activeImport) throw new Error('Wait for the history import to finish or cancel it first.');
}

export function registerHistoryImportIpc(getLibrary: () => LibraryStore, getApiKey: () => string): void {
  async function runImport(read: (signal: AbortSignal) => Promise<HistoryImportParseResult | null>): Promise<HistoryImportReport | null> {
    assertHistoryImportIdle();
    const controller = new AbortController();
    activeImport = controller;
    const library = getLibrary();
    let committed = false;
    try {
      const parsed = await read(controller.signal);
      controller.signal.throwIfAborted();
      if (!parsed) return null;
      if (getLibrary() !== library) throw new Error('The library changed during import. Please try again.');
      const report = library.importListeningHistory(parsed.entries);
      committed = true;
      report.invalid += parsed.invalid;
      report.total += parsed.invalid;
      report.invalidSamples = [...parsed.invalidSamples, ...report.invalidSamples].slice(0, 10);
      await library.flushPendingWrites();
      return report;
    } catch (err) {
      if (controller.signal.aborted && !committed) throw new Error('History import cancelled. No plays were imported.');
      throw err;
    } finally {
      activeImport = null;
    }
  }

  ipcMain.handle('history:import-file', () => runImport(async (signal) => {
    const picked = await dialog.showOpenDialog({
      title: 'Import listening history',
      properties: ['openFile'],
      filters: [{ name: 'Listening history', extensions: ['csv', 'json'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    signal.throwIfAborted();
    const path = picked.filePaths[0];
    const extension = extname(path).toLowerCase();
    if (extension !== '.csv' && extension !== '.json') throw new Error('Choose a CSV or JSON history export.');
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      const limit = 64 * 1024 * 1024;
      if (!info.isFile() || info.size > limit) throw new Error('History files must be regular files smaller than 64 MB.');
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        signal.throwIfAborted();
        length += chunk.length;
        if (length > limit) throw new Error('History files must be smaller than 64 MB.');
        chunks.push(chunk);
      }
      return parseHistoryImport(Buffer.concat(chunks).toString('utf8'), extension === '.csv' ? 'csv' : 'json');
    } finally {
      await file.close();
    }
  }));

  ipcMain.handle('history:import-lastfm', (event: IpcMainInvokeEvent, username: unknown) => runImport(async (signal) => {
    if (typeof username !== 'string' || !username.trim() || username.length > 256) throw new Error('Enter a Last.fm username.');
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('Add your API key in Settings → Last.fm first.');
    return fetchLastfmHistory({
      username, apiKey, signal,
      onProgress: (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('history:import-progress', progress);
      },
    });
  }));
  ipcMain.handle('history:cancel-import', () => { activeImport?.abort(); });
}
