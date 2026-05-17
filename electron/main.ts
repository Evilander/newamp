import {
  app,
  BrowserWindow,
  crashReporter,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  screen,
  shell,
  dialog,
  Tray,
  type Rectangle,
} from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { LibraryStore } from './library.js';
import { LibraryWatcher } from './library-watcher.js';
import { findLocalLyricsForTrack } from './local-lyrics.js';
import { SettingsStore } from './settings.js';
import { Scanner } from './scanner.js';
import {
  buildLocalGuitarTabDocument,
  fetchUltimateGuitarTab,
  findLocalGuitarTabForTrack,
  searchUltimateGuitarTabs,
} from './guitar-tabs.js';
import { fetchAlbumArtImage, searchAlbumArt, searchMusicBrainzMetadata } from './musicbrainz.js';
import { downloadPodcastEpisode, fetchPodcastSubscription, PodcastStore } from './podcasts.js';
import {
  completeLastfmAuth,
  LastfmScrobbleOutbox,
  scrobbleLastfmTrack,
  shouldRetryLastfmError,
  startLastfmAuth,
  updateLastfmNowPlaying,
} from './lastfm.js';
import {
  playbackMode,
  calculateAlbumReplayGainDb,
  analyzeTrackReplayGain,
  transcodeToWavResponse,
  transcodeTrackToWavFile,
  transcodeTracksToAudioFolder,
  transcodeTracksToWavFolder,
} from './transcode.js';
import { exportPlaylistFolder } from './playlist-export.js';
import { createSupportBackup, restoreSupportBackup } from './support-backup.js';
import { generateOpenAiLinerNotes } from './openai-assist.js';
import { isWinampClassicSkinArchiveName, parseWinampClassicSkinArchive } from './winamp-skin-import.js';
import { cueAudioPaths, cueEntriesToTracks, parseCueSheet, type CueSheetEntry } from './cue.js';
import { defaultMusicScanRoots, suggestMusicFolders } from './music-folders.js';
import { parseCustomSkinFile, serializeCustomSkin } from '../shared/custom-skin.js';
import type {
  CustomSkin,
  AiLinerNotesInput,
  ExportTracksFolderInput,
  AudioExportFormat,
  AlbumArtLookupInput,
  AlbumArtLookupResult,
  LastfmTrackPayload,
  GuitarTabDocument,
  LocalGuitarTabInput,
  MetadataLookupCandidate,
  OpenFilesResult,
  PlayerCommand,
  SavedPlaylist,
  ScanProgress,
  SupportDiagnostics,
  Track,
  TrackMetadataPatchInput,
} from '../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, '..', '..');
const startupSmoke = process.env.NEWAMP_STARTUP_SMOKE === '1' || process.argv.includes('--newamp-startup-smoke');
const startupSmokeMarker =
  process.env.NEWAMP_STARTUP_SMOKE_MARKER || commandLineValue('--newamp-startup-smoke-marker');
const userDataOverride =
  process.env.NEWAMP_USER_DATA_DIR || commandLineValue('--newamp-user-data-dir');
const sessionDataOverride =
  process.env.NEWAMP_SESSION_DATA_DIR || commandLineValue('--newamp-session-data-dir');
const forceNativeGpuRendering = process.env.NEWAMP_ENABLE_NATIVE_GPU === '1';
const forceSoftwareRendering =
  process.env.NEWAMP_DISABLE_HARDWARE_ACCELERATION === '1' || !forceNativeGpuRendering;
const uiPlaybackSmoke = process.env.NEWAMP_UI_PLAYBACK_SMOKE === '1';
const uiQuickPlaySmoke = process.env.NEWAMP_UI_QUICK_PLAY_SMOKE === '1';
const uiHandoffSmoke = process.env.NEWAMP_UI_HANDOFF_SMOKE === '1';
const uiGaplessSmoke = process.env.NEWAMP_UI_GAPLESS_SMOKE === '1';
const uiLyricsSmoke = process.env.NEWAMP_UI_LYRICS_SMOKE === '1';
const uiOpenFileSmoke = process.env.NEWAMP_UI_OPEN_FILE_SMOKE === '1';
const uiVisualizerSmoke = process.env.NEWAMP_UI_VISUALIZER_SMOKE === '1';
const uiDeckSmoke = process.env.NEWAMP_UI_DECK_SMOKE === '1';
const uiArtSmoke = process.env.NEWAMP_UI_ART_SMOKE === '1';
const smokeMode =
  startupSmoke ||
  uiPlaybackSmoke ||
  uiQuickPlaySmoke ||
  uiHandoffSmoke ||
  uiGaplessSmoke ||
  uiLyricsSmoke ||
  uiOpenFileSmoke ||
  uiVisualizerSmoke ||
  uiDeckSmoke ||
  uiArtSmoke;
const OPEN_AUDIO_EXTS = new Set([
  '.mp3',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
  '.m4a',
  '.aac',
  '.wma',
  '.aiff',
  '.aif',
  '.ape',
  '.wv',
  '.mpc',
  '.tta',
  '.mka',
  '.ac3',
  '.dts',
  '.dsf',
]);
const OPEN_PLAYLIST_EXTS = new Set(['.m3u', '.m3u8', '.pls', '.cue']);

if (userDataOverride) {
  const userData = resolve(userDataOverride);
  mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
}

if (smokeMode && !userDataOverride) {
  const smokeUserDataName = startupSmoke
    ? 'startup-smoke-user-data'
    : uiQuickPlaySmoke
      ? 'ui-quick-play-smoke-user-data'
      : uiHandoffSmoke
        ? 'ui-handoff-smoke-user-data'
        : uiGaplessSmoke
          ? 'ui-gapless-smoke-user-data'
          : uiLyricsSmoke
          ? 'ui-lyrics-smoke-user-data'
          : uiOpenFileSmoke
            ? 'ui-open-file-smoke-user-data'
            : uiVisualizerSmoke
              ? 'ui-visualizer-smoke-user-data'
              : uiDeckSmoke
                ? 'ui-deck-smoke-user-data'
              : uiArtSmoke
                ? 'ui-art-smoke-user-data'
                : 'ui-playback-smoke-user-data';
  const smokeUserData = process.env.NEWAMP_SMOKE_USER_DATA
    ? resolve(process.env.NEWAMP_SMOKE_USER_DATA)
    : join(appRoot, 'tmp', smokeUserDataName);
  mkdirSync(smokeUserData, { recursive: true });
  app.setPath('userData', smokeUserData);
}

const sessionData = sessionDataOverride
  ? resolve(sessionDataOverride)
  : userDataOverride || smokeMode
    ? resolve(app.getPath('userData'), 'session-data')
    : resolve(process.env.LOCALAPPDATA || process.env.APPDATA || appRoot, 'NewAmp', 'session-data');
mkdirSync(sessionData, { recursive: true });
app.setPath('sessionData', sessionData);
app.commandLine.appendSwitch('disk-cache-dir', join(sessionData, 'Cache'));

const diagnosticsDir = join(app.getPath('userData'), 'diagnostics');
const crashDumpsDir = join(diagnosticsDir, 'crash-dumps');

try {
  mkdirSync(crashDumpsDir, { recursive: true });
  app.setPath('crashDumps', crashDumpsDir);
  crashReporter.start({ uploadToServer: false });
  writeDiagnosticEvent('crash-reporter-started', { crashDumpsDir });
} catch (err) {
  console.error('[newamp] crash reporter failed to start', err);
}

if (forceSoftwareRendering) {
  applySoftwareRenderingSwitches('normal');
}

if (smokeMode) {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  applySoftwareRenderingSwitches('smoke');
}

function commandLineValue(name: string): string | null {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function applySoftwareRenderingSwitches(mode: 'normal' | 'smoke'): void {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-rasterization');
  app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
  app.commandLine.appendSwitch('disable-accelerated-video-decode');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,UseSkiaRenderer,VizDisplayCompositor');
  app.commandLine.appendSwitch('in-process-gpu');
  if (mode === 'smoke') {
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    app.commandLine.appendSwitch('no-sandbox');
  }
}

function writeStartupSmokeMarker(payload: Record<string, unknown>): void {
  if (!startupSmokeMarker) return;
  try {
    const markerPath = resolve(startupSmokeMarker);
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify({ ...payload, at: new Date().toISOString() })}\n`, 'utf8');
  } catch (err) {
    console.error('[newamp] startup smoke marker failed', err);
  }
}

function writeDiagnosticEvent(kind: string, payload: Record<string, unknown> = {}): void {
  try {
    mkdirSync(diagnosticsDir, { recursive: true });
    const event = {
      schemaVersion: 1,
      at: new Date().toISOString(),
      kind,
      appVersion: app.getVersion(),
      platform: process.platform,
      pid: process.pid,
      paths: {
        userData: app.getPath('userData'),
        sessionData: app.getPath('sessionData'),
        crashDumps: app.getPath('crashDumps'),
      },
      payload: normalizeDiagnosticValue(payload),
    };
    const line = `${JSON.stringify(event)}\n`;
    appendFileSync(join(diagnosticsDir, 'events.jsonl'), line, 'utf8');
    if (/crash|gone|exception|rejection|unresponsive/i.test(kind)) {
      writeFileSync(join(diagnosticsDir, 'latest-crash.json'), `${JSON.stringify(event, null, 2)}\n`, 'utf8');
    }
  } catch (err) {
    console.error('[newamp] diagnostic event failed', err);
  }
}

function normalizeDiagnosticValue(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack ?? null };
  if (Array.isArray(value)) return value.map((item) => normalizeDiagnosticValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeDiagnosticValue(item)]),
  );
}

function attachWindowDiagnostics(win: BrowserWindow, label: string): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    writeDiagnosticEvent('window-render-process-gone', {
      label,
      title: win.getTitle(),
      url: win.webContents.getURL(),
      details,
    });
  });
  win.on('unresponsive', () => {
    writeDiagnosticEvent('window-unresponsive', { label, title: win.getTitle(), url: win.webContents.getURL() });
  });
  win.on('responsive', () => {
    writeDiagnosticEvent('window-responsive', { label, title: win.getTitle(), url: win.webContents.getURL() });
  });
}

// Register custom protocol as standard + streaming before app ready, so it
// behaves like file:// for media (range requests, byte-streaming, etc.)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'newamp-app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'newamp',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: 'newart',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'newplaylistart',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

let mainWin: BrowserWindow | null = null;
const tabWindows = new Set<BrowserWindow>();
let normalBounds: Rectangle | null = null;
// Remember whether the window was maximized when entering compact, so we can
// restore that exact state when leaving compact mode. Fixes the prior bug
// where toggling DECK while maximized stranded the window at the deck size.
let normalWasMaximized = false;
let tray: Tray | null = null;
let isQuitting = false;
let library: LibraryStore;
let settings: SettingsStore;
let scanner: Scanner;
let libraryWatcher: LibraryWatcher;
let lastfmOutbox: LastfmScrobbleOutbox;
let podcastStore: PodcastStore;
let pendingOpenFiles = collectOpenFileArgs(process.argv);

const isDev = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL;
const openDevTools = isDev && process.env.OPEN_DEVTOOLS === '1';

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: !smokeMode,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0e07',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: !smokeMode,
    },
  });
  attachWindowDiagnostics(win, 'main');

  if (smokeMode) {
    win.webContents.on('console-message', (details) => {
      const source = details.sourceId ? ` ${details.sourceId}:${details.lineNumber}` : '';
      console.error(`[newamp-smoke-renderer] ${details.message}${source}`);
    });
  }

  win.once('ready-to-show', () => {
    if (smokeMode) return;
    win.show();
    if (openDevTools) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.on('maximize', () => win.webContents.send('window-state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('window-state', { maximized: false }));
  win.on('close', (event) => {
    if (smokeMode || isQuitting) return;
    if (!tray || tray.isDestroyed()) return;
    event.preventDefault();
    win.hide();
  });

  if (isDev) {
    win.loadURL('http://localhost:5173').catch((err) => console.error('loadURL failed', err));
  } else {
    const rendererUrl = new URL('newamp-app://app/index.html');
    if (smokeMode) rendererUrl.searchParams.set('newamp-smoke', '1');
    win.loadURL(rendererUrl.toString()).catch((err) => console.error('loadURL failed', err));
  }

  if (startupSmoke) {
    win.webContents.once('did-finish-load', () => {
      writeStartupSmokeMarker({ ok: true, event: 'did-finish-load', url: win.webContents.getURL() });
      console.log('[newamp] startup smoke loaded');
      app.quit();
    });
    win.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      writeStartupSmokeMarker({ ok: false, event: 'did-fail-load', errorCode, errorDescription, validatedURL });
      console.error('[newamp] startup smoke failed', { errorCode, errorDescription, validatedURL });
      app.exit(1);
    });
  }

  return win;
}

function showMainWindow(): void {
  if (!mainWin || mainWin.isDestroyed()) {
    mainWin = createWindow();
    return;
  }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function toggleMainWindow(): void {
  if (!mainWin || mainWin.isDestroyed() || !mainWin.isVisible()) {
    showMainWindow();
    return;
  }
  mainWin.hide();
}

function sendPlayerCommand(command: PlayerCommand): void {
  mainWin?.webContents.send('player:command', command);
}

function enqueueOpenFiles(paths: string[]): void {
  const clean = normalizeOpenTargets(paths).map((target) => target.path);
  if (!clean.length) return;
  if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isLoading()) {
    mainWin.webContents.send('app:open-files', clean);
    return;
  }
  const seen = new Set(pendingOpenFiles.map((path) => path.toLowerCase()));
  for (const path of clean) {
    const key = path.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      pendingOpenFiles.push(path);
    }
  }
}

function registerTray(): void {
  if (tray || smokeMode) return;

  const icon = resolveTrayIconImage();
  if (!icon) return;
  try {
    const nextTray = new Tray(icon);
    nextTray.setToolTip('NewAmp');
    nextTray.on('click', toggleMainWindow);
    nextTray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show / Hide NewAmp', click: toggleMainWindow },
      { type: 'separator' },
      { label: 'Previous', click: () => sendPlayerCommand('previous') },
      { label: 'Play / Pause', click: () => sendPlayerCommand('toggle-play') },
      { label: 'Next', click: () => sendPlayerCommand('next') },
      { label: 'Stop', click: () => sendPlayerCommand('stop') },
      { type: 'separator' },
      {
        label: 'Quit NewAmp',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]));
    tray = nextTray;
    if (process.platform === 'win32') scheduleTrayBoundsDiagnostic(nextTray);
  } catch (error) {
    tray = null;
    writeDiagnosticEvent('tray-unavailable', { error });
    console.warn('[newamp] tray icon unavailable', error);
  }
}

function scheduleTrayBoundsDiagnostic(nextTray: Tray): void {
  if (hasTrayBounds(nextTray.getBounds())) return;
  const timer = setTimeout(() => {
    if (nextTray.isDestroyed() || hasTrayBounds(nextTray.getBounds())) return;
    const error = new Error('Windows notification area did not report tray bounds.');
    writeDiagnosticEvent('tray-unavailable', { error });
    console.warn('[newamp] tray icon bounds unavailable', error);
    nextTray.destroy();
    if (tray === nextTray) tray = null;
  }, 2000);
  timer.unref?.();
}

function hasTrayBounds(bounds: Rectangle): boolean {
  return bounds.width > 0 || bounds.height > 0;
}

function resolveTrayIconImage(): Electron.NativeImage | null {
  const iconPaths = process.platform === 'win32'
    ? [
        join(process.resourcesPath, 'build', 'icon.ico'),
        join(app.getAppPath(), 'build', 'icon.ico'),
        join(process.resourcesPath, 'build', 'icon.png'),
        join(app.getAppPath(), 'build', 'icon.png'),
      ]
    : [
        join(process.resourcesPath, 'build', 'icon.png'),
        join(app.getAppPath(), 'build', 'icon.png'),
        join(process.resourcesPath, 'build', 'icon.ico'),
        join(app.getAppPath(), 'build', 'icon.ico'),
      ];
  for (const iconPath of iconPaths) {
    if (!existsSync(iconPath)) continue;
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) continue;
    const trayImage = image.resize({ width: 16, height: 16, quality: 'best' });
    if (!trayImage.isEmpty()) return trayImage;
  }
  return null;
}

function registerMediaShortcuts(): void {
  if (smokeMode) return;
  const shortcuts: Array<[string, PlayerCommand]> = [
    ['MediaPlayPause', 'toggle-play'],
    ['MediaNextTrack', 'next'],
    ['MediaPreviousTrack', 'previous'],
    ['MediaStop', 'stop'],
  ];

  for (const [accelerator, command] of shortcuts) {
    try {
      const ok = globalShortcut.register(accelerator, () => sendPlayerCommand(command));
      if (!ok && process.env.NEWAMP_VERBOSE_MEDIA_KEYS === '1') {
        console.info(`[newamp] global media shortcut unavailable: ${accelerator}`);
      }
    } catch (err) {
      console.warn(`[newamp] global media shortcut failed: ${accelerator}`, err);
    }
  }
}

function syncLibraryWatcher(): void {
  if (!libraryWatcher) return;
  const current = settings.get();
  if (smokeMode || !current.libraryAutoWatch || !current.libraryRoots.length) {
    libraryWatcher.stop();
    return;
  }
  libraryWatcher.start(current.libraryRoots);
}

function createScannerService(store: LibraryStore): Scanner {
  return new Scanner(store, (p: ScanProgress) => {
    mainWin?.webContents.send('library:scan-progress', p);
  });
}

function createLibraryWatcherService(): LibraryWatcher {
  return new LibraryWatcher((targets) => {
    if (!settings.get().libraryAutoWatch || !targets.length) return;
    library.pruneMissingTracks(targets);
    void scanner.start(targets, { force: true });
  });
}

async function reloadRuntimeStores(userData: string): Promise<void> {
  settings = new SettingsStore(join(userData, 'settings.json'));
  lastfmOutbox = new LastfmScrobbleOutbox(join(userData, 'lastfm-scrobbles.json'));
  podcastStore = new PodcastStore(join(userData, 'podcasts.json'));
  library = await LibraryStore.open(join(userData, 'library.db'));
  scanner = createScannerService(library);
  libraryWatcher = createLibraryWatcherService();
  syncLibraryWatcher();
}

function registerAudioProtocol(): void {
  protocol.handle('newamp-app', async (request) => {
    try {
      const rendererBase = rendererDistPath();
      const url = new URL(request.url);
      const rawPath = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html';
      const filePath = resolve(rendererBase, rawPath);
      const rel = relative(rendererBase, filePath);
      if (rel.startsWith('..') || resolve(rel) === rel) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!existsSync(filePath)) {
        return new Response('Not found', { status: 404 });
      }
      return new Response(await readFile(filePath), {
        status: 200,
        headers: { 'Content-Type': rendererMimeType(filePath) },
      });
    } catch (err) {
      console.error('newamp-app protocol error:', err);
      return new Response('Server Error', { status: 500 });
    }
  });

  // newamp:///full/path/to/file.mp3
  // We re-route to a streaming file: URL using Electron's net module, which
  // gives us byte-range support out of the box.
  protocol.handle('newamp', async (request) => {
    try {
      const url = new URL(request.url);
      // host is "track" or "file", pathname holds the encoded path
      const raw = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      // On Windows we get something like "K:/music/foo/bar.mp3"
      const filePath = resolve(raw);
      if (!existsSync(filePath)) {
        return new Response('Not found', { status: 404 });
      }
      if (playbackMode(filePath) === 'ffmpeg') {
        return transcodeToWavResponse(filePath, request);
      }
      const response = await net.fetch(pathToFileURL(filePath).toString(), {
        bypassCustomProtocolHandlers: true,
      });
      return withAudioCors(response);
    } catch (err) {
      console.error('newamp protocol error:', err);
      return new Response('Server Error', { status: 500 });
    }
  });

  // newart://track/<trackId>/art
  protocol.handle('newart', async (request) => {
    try {
      const id = protocolNumericId(request.url);
      if (!id) return new Response('Bad request', { status: 400 });
      const art = library.getArt(id);
      if (!art) {
        return new Response('No art', { status: 404 });
      }
      const ab = new ArrayBuffer(art.data.byteLength);
      new Uint8Array(ab).set(art.data);
      return new Response(ab, {
        status: 200,
        headers: { 'Content-Type': art.mime, 'Cache-Control': 'public, max-age=86400' },
      });
    } catch (err) {
      console.error('newart protocol error:', err);
      return new Response('Server Error', { status: 500 });
    }
  });

  protocol.handle('newplaylistart', async (request) => {
    try {
      const id = protocolNumericId(request.url);
      if (!id) return new Response('Bad request', { status: 400 });
      const art = library.getPlaylistCover(id);
      if (!art) return new Response('No art', { status: 404 });
      const ab = new ArrayBuffer(art.data.byteLength);
      new Uint8Array(ab).set(art.data);
      return new Response(ab, {
        status: 200,
        headers: { 'Content-Type': art.mime, 'Cache-Control': 'public, max-age=86400' },
      });
    } catch (err) {
      console.error('newplaylistart protocol error:', err);
      return new Response('Server Error', { status: 500 });
    }
  });
}

function protocolNumericId(rawUrl: string): number {
  const idText = rawUrl.match(/(?:^|[^\d])(\d+)(?=[^\d]|$)/)?.[1] || '';
  const id = Number.parseInt(idText, 10);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function rendererDistPath(): string {
  const packagedRenderer = join(process.resourcesPath, 'dist');
  if (app.isPackaged && existsSync(join(packagedRenderer, 'index.html'))) return packagedRenderer;
  return join(app.isPackaged ? app.getAppPath() : appRoot, 'dist');
}

function rendererMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.ico':
      return 'image/x-icon';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

function withAudioCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function registerIpc(): void {
  ipcMain.handle('library:scan', async (_e, roots?: string[]) => {
    const configuredRoots = settings.get().libraryRoots;
    const fallbackRoots = roots && roots.length
      ? []
      : defaultMusicScanRoots({ fallbackMusicPath: app.getPath('music') });
    const targets = roots && roots.length ? roots : configuredRoots.length ? configuredRoots : fallbackRoots;
    if (!targets.length) return;
    if (!configuredRoots.length) settings.set({ libraryRoots: targets });
    return scanner.start(targets);
  });

  ipcMain.handle('library:cancel-scan', async () => {
    scanner.cancel();
  });

  ipcMain.handle('library:get-tracks', async (_e, opts) => library.getTracks(opts ?? {}));
  ipcMain.handle('library:get-track-ids', async (_e, opts) => library.getTrackIds(opts ?? {}));
  ipcMain.handle('library:get-track-count', async (_e, opts) => library.getTrackCount(opts ?? {}));
  ipcMain.handle('library:get-albums', async (_e, opts) => library.getAlbums(opts ?? {}));
  ipcMain.handle('album-art:lookup', async (_e, input: AlbumArtLookupInput) =>
    searchAlbumArt(input),
  );
  ipcMain.handle('album-art:apply', async (_e, input: AlbumArtLookupInput, candidate: AlbumArtLookupResult) => {
    const image = await fetchAlbumArtImage(candidate);
    return library.applyAlbumArtToAlbum(input.album, input.albumArtist, {
      mime: image.mime,
      data: image.data,
    }, image.sourceUrl);
  });
  ipcMain.handle('library:get-artists', async (_e, opts) => library.getArtists(opts ?? {}));
  ipcMain.handle('library:get-folders', async (_e, parentPath?: string | null) =>
    library.getFolders(parentPath ?? null, settings.get().libraryRoots),
  );
  ipcMain.handle('library:get-folder-tracks', async (_e, folderPath: string, opts) =>
    library.getFolderTracks(folderPath, opts ?? {}),
  );
  ipcMain.handle('library:get-folder-track-ids', async (_e, folderPath: string, opts) =>
    library.getFolderTrackIds(folderPath, opts ?? {}),
  );
  ipcMain.handle('library:get-album-tracks', async (_e, album: string, albumArtist: string) =>
    library.getAlbumTracks(album, albumArtist),
  );
  ipcMain.handle('library:get-artist-tracks', async (_e, artist: string) =>
    library.getArtistTracks(artist),
  );
  ipcMain.handle('library:get-track', async (_e, id: number) => library.getTrack(id));
  ipcMain.handle('playlist:list', async () => library.getPlaylists());
  ipcMain.handle('playlist:save', async (_e, input) => library.savePlaylist(input));
  ipcMain.handle('playlist:add-tracks', async (_e, input) => library.addTracksToPlaylist(input));
  ipcMain.handle('playlist:delete', async (_e, id: number) => library.deletePlaylist(id));
  ipcMain.handle('playlist:get-tracks', async (_e, id: number) =>
    library.getPlaylistTracks(id),
  );
  ipcMain.handle('playlist:pick-cover', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose playlist icon',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] },
      ],
    };
    const result = mainWin ? await dialog.showOpenDialog(mainWin, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('playlist:export-m3u', async (_e, id: number) => {
    const result = await choosePlaylistExportPath(id, 'm3u8', [{ name: 'M3U playlist', extensions: ['m3u8', 'm3u'] }]);
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, library.exportPlaylistM3u(id), 'utf8');
    return result.filePath;
  });
  ipcMain.handle('playlist:export-pls', async (_e, id: number) => {
    const result = await choosePlaylistExportPath(id, 'pls', [{ name: 'PLS playlist', extensions: ['pls'] }]);
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, library.exportPlaylistPls(id), 'utf8');
    return result.filePath;
  });
  ipcMain.handle('playlist:export-folder', async (_e, id: number) => {
    const playlist = library.getPlaylists().find((item) => item.id === Math.trunc(id));
    if (!playlist) return null;
    const result = await choosePlaylistFolderExportRoot(playlist);
    const destinationRoot = result.filePaths[0];
    if (result.canceled || !destinationRoot) return null;
    return exportPlaylistFolder({
      playlist,
      tracks: library.getPlaylistTracks(playlist.id),
      destinationRoot,
    });
  });
  ipcMain.handle('playlist:export-tracks-folder', async (_e, input: ExportTracksFolderInput) => {
    const trackIds = Array.isArray(input?.trackIds) ? input.trackIds : [];
    const tracks = trackIds
      .map((id) => library.getTrack(Math.trunc(Number(id))))
      .filter((track): track is Track => !!track);
    if (!tracks.length) return null;
    const now = Date.now();
    const playlist: SavedPlaylist = {
      id: 0,
      name: normalizeExportFolderName(input?.name, now),
      trackCount: tracks.length,
      duration: tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0),
      hasCoverArt: 0,
      coverArtUpdatedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const result = await choosePlaylistFolderExportRoot(playlist);
    const destinationRoot = result.filePaths[0];
    if (result.canceled || !destinationRoot) return null;
    return exportPlaylistFolder({ playlist, tracks, destinationRoot });
  });
  ipcMain.handle('playlist:import-m3u', async () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    }
    const result = mainWin
      ? await dialog.showOpenDialog(mainWin, {
          title: 'Import playlist',
          properties: ['openFile'],
          filters: [{ name: 'Playlist', extensions: ['m3u8', 'm3u', 'pls'] }],
        })
      : await dialog.showOpenDialog({
          title: 'Import playlist',
          properties: ['openFile'],
          filters: [{ name: 'Playlist', extensions: ['m3u8', 'm3u', 'pls'] }],
        });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = result.filePaths[0]!;
    const content = await readFile(filePath, 'utf8');
    const name = basename(filePath).replace(/\.(m3u8?|pls|txt)$/i, '');
    return library.importPlaylistM3u({ name, content, baseDir: dirname(filePath) });
  });
  ipcMain.handle('track:export-wav', async (_e, id: number) => {
    const track = library.getTrack(id);
    if (!track) return null;
    const result = await chooseTrackWavExportPath(track);
    if (result.canceled || !result.filePath) return null;
    return transcodeTrackToWavFile(track.path, result.filePath);
  });
  ipcMain.handle('tracks:export-wav-folder', async (_e, ids: number[]) => {
    const tracks = resolveExportTracks(ids);
    if (!tracks.length) return null;
    const result = await chooseTracksWavExportFolder(tracks.length);
    const destinationRoot = result.filePaths[0];
    if (result.canceled || !destinationRoot) return null;
    return transcodeTracksToWavFolder(tracks, destinationRoot);
  });
  ipcMain.handle('tracks:export-audio-folder', async (_e, ids: number[], format: AudioExportFormat) => {
    const tracks = resolveExportTracks(ids);
    if (!tracks.length) return null;
    const result = await chooseTracksAudioExportFolder(tracks.length, format);
    const destinationRoot = result.filePaths[0];
    if (result.canceled || !destinationRoot) return null;
    return transcodeTracksToAudioFolder(tracks, destinationRoot, format);
  });
  ipcMain.handle('tracks:analyze-replaygain', async (_e, ids: number[]) => analyzeReplayGain(ids));
  ipcMain.handle('tracks:analyze-album-replaygain', async (_e, ids: number[]) => analyzeAlbumReplayGain(ids));
  ipcMain.handle('open:consume-pending-files', async () => {
    const files = pendingOpenFiles;
    pendingOpenFiles = [];
    return files;
  });
  ipcMain.handle('open:files', async (_e, paths: string[]) => openFiles(paths));
  ipcMain.handle('smart:list', async () => library.getSmartPlaylistRules());
  ipcMain.handle('smart:suggestions', async () => library.getSuggestedSmartPlaylistRules());
  ipcMain.handle('smart:save', async (_e, input) => library.saveSmartPlaylistRule(input));
  ipcMain.handle('smart:delete', async (_e, id: number) => library.deleteSmartPlaylistRule(id));
  ipcMain.handle('smart:run', async (_e, input) => library.runSmartPlaylistRule(input));
  ipcMain.handle('smart:harmonic-mix', async (_e, input) => library.buildHarmonicMix(input));
  ipcMain.handle('smart:taste-mix', async (_e, input) => library.buildTasteMix(input));
  ipcMain.handle('metadata:lookup', async (_e, id: number) => {
    const track = library.getTrack(id);
    if (!track) return [];
    return searchMusicBrainzMetadata(track);
  });
  ipcMain.handle('metadata:apply', async (_e, id: number, candidate: MetadataLookupCandidate) =>
    library.applyMetadataPatch(id, candidate),
  );
  ipcMain.handle('metadata:edit', async (_e, id: number, patch: TrackMetadataPatchInput) =>
    library.applyManualMetadataPatch(id, patch),
  );
  ipcMain.handle('library:get-stats', async () => library.getStats());
  ipcMain.handle('library:get-health', async () => library.getLibraryHealth());
  ipcMain.handle('library:prune-missing', async (_e, targets?: string[]) =>
    library.pruneMissingTracks(targets),
  );
  ipcMain.handle('history:get', async (_e, opts) => library.getListeningHistory(opts ?? {}));
  ipcMain.handle('history:insights', async (_e, opts) => library.getListeningInsights(opts ?? {}));
  ipcMain.handle('history:clear', async () => library.clearListeningHistory());
  ipcMain.handle('bookmark:list', async (_e, trackId: number) => library.getTrackBookmarks(trackId));
  ipcMain.handle('bookmark:save', async (_e, input) => library.saveTrackBookmark(input));
  ipcMain.handle('bookmark:delete', async (_e, id: number) => library.deleteTrackBookmark(id));
  ipcMain.handle('library:toggle-love', async (_e, id: number) => library.toggleLove(id));
  ipcMain.handle('library:set-rating', async (_e, id: number, rating: number) =>
    library.setTrackRating(id, rating),
  );
  ipcMain.handle('library:set-rating-score', async (_e, id: number, score: number | null) =>
    library.setTrackRatingScore(id, score),
  );
  ipcMain.handle('library:toggle-avoid-autoplay', async (_e, id: number) =>
    library.toggleAvoidAutoPlay(id),
  );
  ipcMain.handle('library:record-play', async (_e, id: number) => library.recordPlay(id));
  ipcMain.handle('library:record-skip', async (_e, id: number, position?: number) =>
    library.recordSkip(id, Date.now(), position ?? 0),
  );

  ipcMain.handle('settings:get', async () => settings.get());
  ipcMain.handle('settings:set', async (_e, patch) => {
    const updated = settings.set(patch);
    syncLibraryWatcher();
    return updated;
  });
  ipcMain.handle('settings:skin-export', async (_e, skin: CustomSkin) => {
    const file = serializeCustomSkin(skin);
    const result = mainWin
      ? await dialog.showSaveDialog(mainWin, {
          title: 'Export NewAmp skin',
          defaultPath: `${safeFileStem(skin.name || 'NewAmp Custom')}.newampskin.json`,
          filters: [{ name: 'NewAmp skin', extensions: ['json'] }],
        })
      : await dialog.showSaveDialog({
          title: 'Export NewAmp skin',
          defaultPath: `${safeFileStem(skin.name || 'NewAmp Custom')}.newampskin.json`,
          filters: [{ name: 'NewAmp skin', extensions: ['json'] }],
        });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, file, 'utf8');
    return result.filePath;
  });
  ipcMain.handle('settings:skin-import', async () => {
    const result = mainWin
      ? await dialog.showOpenDialog(mainWin, {
          title: 'Import NewAmp or Winamp skin',
          properties: ['openFile'],
          filters: [{ name: 'NewAmp / Winamp skin', extensions: ['json', 'wsz', 'zip'] }],
        })
      : await dialog.showOpenDialog({
          title: 'Import NewAmp or Winamp skin',
          properties: ['openFile'],
          filters: [{ name: 'NewAmp / Winamp skin', extensions: ['json', 'wsz', 'zip'] }],
        });
    if (result.canceled || !result.filePaths.length) return null;
    return importSkinFile(result.filePaths[0]!);
  });
  ipcMain.handle('settings:skin-import-file', async (_e, skinPath: string) => importSkinFile(skinPath));
  ipcMain.handle('app:support-diagnostics', async () => buildSupportDiagnostics());
  ipcMain.handle('app:create-backup', async () => {
    const userData = app.getPath('userData');
    return createSupportBackup({
      userDataPath: userData,
      settingsPath: join(userData, 'settings.json'),
      libraryPath: join(userData, 'library.db'),
    });
  });
  ipcMain.handle('app:restore-backup', async () => {
    const userData = app.getPath('userData');
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    }
    const options: Electron.OpenDialogOptions = {
      title: 'Restore NewAmp backup',
      buttonLabel: 'Restore backup',
      defaultPath: join(userData, 'backups'),
      properties: ['openDirectory'],
    };
    const picked = mainWin ? await dialog.showOpenDialog(mainWin, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths.length) return null;
    const backupPath = picked.filePaths[0]!;
    const safety = await createSupportBackup({
      userDataPath: userData,
      settingsPath: join(userData, 'settings.json'),
      libraryPath: join(userData, 'library.db'),
    });

    scanner?.cancel();
    libraryWatcher?.stop();
    library?.close();
    try {
      return await restoreSupportBackup({
        userDataPath: userData,
        settingsPath: join(userData, 'settings.json'),
        libraryPath: join(userData, 'library.db'),
        backupPath,
        safetyBackupPath: safety.backupPath,
      });
    } finally {
      await reloadRuntimeStores(userData);
    }
  });
  ipcMain.handle('lastfm:start-auth', async () => {
    const auth = await startLastfmAuth(settings.get());
    settings.set({ lastfmAuthToken: auth.token });
    await shell.openExternal(auth.authUrl);
    return auth;
  });
  ipcMain.handle('lastfm:complete-auth', async () => {
    const session = await completeLastfmAuth(settings.get());
    settings.set({
      lastfmEnabled: true,
      lastfmSessionKey: session.sessionKey,
      lastfmUsername: session.username,
      lastfmAuthToken: null,
    });
    return session;
  });
  ipcMain.handle('lastfm:disconnect', async () =>
    settings.set({
      lastfmEnabled: false,
      lastfmSessionKey: null,
      lastfmUsername: null,
      lastfmAuthToken: null,
    }),
  );
  ipcMain.handle('lastfm:update-now-playing', async (_e, track: LastfmTrackPayload) => {
    await updateLastfmNowPlaying(settings.get(), track);
  });
  ipcMain.handle('lastfm:scrobble', async (_e, track: LastfmTrackPayload, timestamp: number) => {
    const flushed = await flushLastfmOutbox();
    if (flushed.remaining > 0) {
      await lastfmOutbox.enqueue(track, timestamp, 'Waiting for older cached scrobbles.');
      return;
    }
    try {
      await scrobbleLastfmTrack(settings.get(), track, timestamp);
    } catch (err) {
      if (shouldRetryLastfmError(err)) {
        await lastfmOutbox.enqueue(track, timestamp, errorMessage(err));
      }
    }
  });
  ipcMain.handle('lastfm:outbox-status', async () => lastfmOutbox.status());
  ipcMain.handle('lastfm:flush-outbox', async () => {
    await flushLastfmOutbox();
    return lastfmOutbox.status();
  });
  ipcMain.handle('podcasts:list', async () => podcastStore.listSubscriptions());
  ipcMain.handle('podcasts:subscribe', async (_e, url: string) => {
    const subscription = await fetchPodcastSubscription(url);
    return podcastStore.upsert(subscription.feed, subscription.episodes);
  });
  ipcMain.handle('podcasts:refresh', async (_e, url: string) => {
    const subscription = await fetchPodcastSubscription(url);
    return podcastStore.upsert(subscription.feed, subscription.episodes);
  });
  ipcMain.handle('podcasts:remove', async (_e, url: string) => {
    podcastStore.remove(url);
  });
  ipcMain.handle('podcasts:progress', async (_e, input) => podcastStore.updateProgress(input));
  ipcMain.handle('podcasts:download', async (_e, feedUrl: string, episodeId: string) =>
    downloadPodcastEpisode(podcastStore, {
      feedUrl,
      episodeId,
      downloadsPath: join(app.getPath('userData'), 'podcast-downloads'),
    }),
  );
  ipcMain.handle('podcasts:remove-download', async (_e, feedUrl: string, episodeId: string) =>
    podcastStore.clearDownload(feedUrl, episodeId),
  );
  ipcMain.handle('lyrics:local', async (_e, trackId: number) => {
    const id = Math.trunc(Number(trackId));
    if (!Number.isFinite(id) || id <= 0) return null;
    const track = library.getTrack(id);
    if (!track) return null;
    return (await findLocalLyricsForTrack(track)) ?? library.getCustomLyrics(id);
  });
  ipcMain.handle('lyrics:custom:save', async (_e, input) => library.saveCustomLyrics(input));
  ipcMain.handle('lyrics:custom:clear', async (_e, trackId: number) => {
    library.clearCustomLyrics(trackId);
  });
  ipcMain.handle('ai:liner-notes', async (_e, input: AiLinerNotesInput) =>
    generateOpenAiLinerNotes(settings.get(), input),
  );
  ipcMain.handle('tabs:search', async (_e, query) => searchUltimateGuitarTabs(query));
  ipcMain.handle('tabs:get', async (_e, url: string) => fetchUltimateGuitarTab(url));
  ipcMain.handle('tabs:cache:list', async (_e, trackId: number) => library.getCachedGuitarTabs(trackId));
  ipcMain.handle('tabs:cache:save', async (_e, trackId: number, document) =>
    library.saveCachedGuitarTab(trackId, document),
  );
  ipcMain.handle('tabs:local:save', async (_e, trackId: number, input: LocalGuitarTabInput) =>
    library.saveCachedGuitarTab(trackId, buildLocalGuitarTabDocument(input)),
  );
  ipcMain.handle('tabs:local:find', async (_e, trackId: number) => {
    const id = Math.trunc(Number(trackId));
    if (!Number.isFinite(id) || id <= 0) return null;
    const track = library.getTrack(id);
    if (!track) return null;
    const document = await findLocalGuitarTabForTrack(track);
    return document ? library.saveCachedGuitarTab(id, document) : null;
  });
  ipcMain.handle('tabs:window:open', async (_e, document: GuitarTabDocument, startAutoscroll?: boolean) => {
    openGuitarTabWindow(document, !!startAutoscroll);
  });

  ipcMain.handle('os:pick-folder', async () => {
    console.log('[newamp] os:pick-folder invoked');
    try {
      // Bring window to front first; frameless windows sometimes lose focus
      // and the dialog will open behind them silently.
      if (mainWin) {
        if (mainWin.isMinimized()) mainWin.restore();
        mainWin.show();
        mainWin.focus();
      }
      const opts = {
        properties: ['openDirectory', 'createDirectory'] as Array<
          'openDirectory' | 'createDirectory'
        >,
        title: 'Choose your music folder',
        buttonLabel: 'Use this folder',
        defaultPath: 'K:/',
      };
      // Modal version when we have a window; fall back to non-modal otherwise.
      const res = mainWin
        ? await dialog.showOpenDialog(mainWin, opts)
        : await dialog.showOpenDialog(opts);
      console.log('[newamp] os:pick-folder result:', res);
      if (res.canceled || !res.filePaths.length) return null;
      return res.filePaths[0];
    } catch (err) {
      console.error('[newamp] os:pick-folder failed:', err);
      return null;
    }
  });

  ipcMain.handle('os:suggested-music-folders', async () => suggestMusicFolders());

  ipcMain.handle('os:show-in-folder', async (_e, p: string) => {
    shell.showItemInFolder(p);
  });

  // app info — synchronous so preload can populate window.newamp.appVersion
  // without a round-trip
  ipcMain.on('app:get-info-sync', (e) => {
    e.returnValue = {
      appVersion: app.getVersion(),
      platform: process.platform,
    };
  });

  // window controls
  ipcMain.handle('win:minimize', () => mainWin?.minimize());
  ipcMain.handle('win:toggle-max', () => {
    if (!mainWin) return;
    if (mainWin.isMaximized()) mainWin.unmaximize();
    else mainWin.maximize();
  });
  ipcMain.handle('win:set-compact', (_e, on: boolean, size?: { width?: number; height?: number }) => {
    if (!mainWin) return;
    if (on) {
      // Capture the previous shape once on the way into deck mode. Tracking
      // the maximized state separately lets us correctly restore a maximized
      // window — previously this was lost and the window got stuck small.
      if (!normalBounds) {
        normalWasMaximized = mainWin.isMaximized();
        normalBounds = normalWasMaximized
          ? mainWin.getNormalBounds?.() ?? mainWin.getBounds()
          : mainWin.getBounds();
      }
      if (mainWin.isMaximized()) mainWin.unmaximize();
      const width = Math.max(280, Math.min(1600, Math.trunc(Number(size?.width) || 720)));
      const height = Math.max(100, Math.min(1000, Math.trunc(Number(size?.height) || 152)));
      mainWin.setResizable(true);
      // Allow shrinking the minimum to the deck's natural size so resize cannot
      // pad the chrome with empty border. Each skin owns its aspect ratio.
      mainWin.setMinimumSize(Math.min(280, width), Math.min(100, height));
      mainWin.setSize(width, height, true);
      mainWin.setResizable(false);
      mainWin.setAlwaysOnTop(true, 'floating');
      return;
    }
    mainWin.setResizable(true);
    mainWin.setAlwaysOnTop(false);
    mainWin.setMinimumSize(980, 640);
    // Pull the window above the minimum first if it is currently smaller, then
    // restore. Without this, Electron silently grows it to (980,640) on
    // setMinimumSize and the subsequent setBounds can race with the resize.
    if (normalBounds) {
      const bounds = { ...normalBounds };
      mainWin.setBounds(bounds, true);
    } else {
      // Fallback for the edge case where deck mode was entered without a saved
      // pre-deck bounds (e.g. fresh app start in compactMode from settings).
      const display = screen.getDisplayMatching(mainWin.getBounds()).workArea;
      const fallbackWidth = Math.min(1280, Math.max(980, display.width - 200));
      const fallbackHeight = Math.min(820, Math.max(640, display.height - 200));
      mainWin.setSize(fallbackWidth, fallbackHeight, true);
      mainWin.center();
    }
    if (normalWasMaximized) mainWin.maximize();
    normalBounds = null;
    normalWasMaximized = false;
  });
  ipcMain.handle('win:set-compact-size', (_e, size: { width: number; height: number }) => {
    if (!mainWin) return;
    const width = Math.max(280, Math.min(1600, Math.trunc(Number(size?.width) || 720)));
    const height = Math.max(100, Math.min(1000, Math.trunc(Number(size?.height) || 152)));
    mainWin.setResizable(true);
    mainWin.setMinimumSize(Math.min(280, width), Math.min(100, height));
    mainWin.setSize(width, height, true);
    mainWin.setResizable(false);
  });
  ipcMain.handle('win:set-always-on-top', (_e, on: boolean) => {
    mainWin?.setAlwaysOnTop(!!on, 'floating');
  });
  ipcMain.handle('win:close', () => mainWin?.close());
}

async function runUiPlaybackSmoke(win: BrowserWindow, scanPromise: Promise<void>): Promise<void> {
  try {
    await Promise.race([
      scanPromise,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI playback smoke scan')), 15000),
      ),
    ]);
    await reloadForSmoke(win);
    const result = await Promise.race([
      win.webContents.executeJavaScript(uiPlaybackProbeSource(), true),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI playback probe')), 15000),
      ),
    ]);
    console.log(`[newamp-ui-playback-smoke] ${JSON.stringify(result)}`);
    isQuitting = true;
    app.quit();
  } catch (err) {
    console.error('[newamp-ui-playback-smoke] failed:', err);
    app.exit(1);
  }
}

async function runUiQuickPlaySmoke(win: BrowserWindow, scanPromise: Promise<void>): Promise<void> {
  try {
    await Promise.race([
      scanPromise,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI Quick Play smoke scan')), 15000),
      ),
    ]);
    await reloadForSmoke(win);
    const result = await Promise.race([
      win.webContents.executeJavaScript(uiQuickPlayProbeSource(), true),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI Quick Play probe')), 15000),
      ),
    ]);
    console.log(`[newamp-ui-quick-play-smoke] ${JSON.stringify(result)}`);
    isQuitting = true;
    app.quit();
  } catch (err) {
    console.error('[newamp-ui-quick-play-smoke] failed:', err);
    app.exit(1);
  }
}

async function runUiOpenFileSmoke(win: BrowserWindow): Promise<void> {
  try {
    const result = await Promise.race([
      win.webContents.executeJavaScript(uiOpenFileProbeSource(), true),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI open-file probe')), 20000),
      ),
    ]);
    console.log(`[newamp-ui-open-file-smoke] ${JSON.stringify(result)}`);
    isQuitting = true;
    app.quit();
  } catch (err) {
    console.error('[newamp-ui-open-file-smoke] failed:', err);
    app.exit(1);
  }
}

async function runUiHandoffSmoke(win: BrowserWindow, scanPromise: Promise<void>): Promise<void> {
  try {
    await Promise.race([
      scanPromise,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI handoff smoke scan')), 15000),
      ),
    ]);
    await reloadForSmoke(win);
    const result = await Promise.race([
      win.webContents.executeJavaScript(uiHandoffProbeSource(), true),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI handoff probe')), 15000),
      ),
    ]);
    console.log(`[newamp-ui-handoff-smoke] ${JSON.stringify(result)}`);
    isQuitting = true;
    app.quit();
  } catch (err) {
    console.error('[newamp-ui-handoff-smoke] failed:', err);
    app.exit(1);
  }
}

async function runUiGaplessSmoke(win: BrowserWindow, scanPromise: Promise<void>): Promise<void> {
  try {
    await Promise.race([
      scanPromise,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI gapless smoke scan')), 15000),
      ),
    ]);
    await reloadForSmoke(win);
    const result = await Promise.race([
      win.webContents.executeJavaScript(uiGaplessProbeSource(), true),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI gapless probe')), 15000),
      ),
    ]);
    console.log(`[newamp-ui-gapless-smoke] ${JSON.stringify(result)}`);
    isQuitting = true;
    app.quit();
  } catch (err) {
    console.error('[newamp-ui-gapless-smoke] failed:', err);
    app.exit(1);
  }
}

async function runUiLyricsSmoke(win: BrowserWindow, scanPromise: Promise<void>): Promise<void> {
  try {
    await Promise.race([
      scanPromise,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI lyrics smoke scan')), 15000),
      ),
    ]);
    await reloadForSmoke(win);
    const result = await Promise.race([
      win.webContents.executeJavaScript(uiLyricsProbeSource(), true),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI lyrics probe')), 30000),
      ),
    ]);
    console.log(`[newamp-ui-lyrics-smoke] ${JSON.stringify(result)}`);
    isQuitting = true;
    app.quit();
  } catch (err) {
    console.error('[newamp-ui-lyrics-smoke] failed:', err);
    app.exit(1);
  }
}

async function runUiVisualizerSmoke(win: BrowserWindow, scanPromise: Promise<void>): Promise<void> {
  try {
    await Promise.race([
      scanPromise,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI visualizer smoke scan')), 15000),
      ),
    ]);
    await reloadForSmoke(win);
    const result = await Promise.race([
      win.webContents.executeJavaScript(uiVisualizerProbeSource(), true),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI visualizer probe')), 20000),
      ),
    ]);
    console.log(`[newamp-ui-visualizer-smoke] ${JSON.stringify(result)}`);
    isQuitting = true;
    app.quit();
  } catch (err) {
    console.error('[newamp-ui-visualizer-smoke] failed:', err);
    app.exit(1);
  }
}

async function runUiArtSmoke(win: BrowserWindow, scanPromise: Promise<void>): Promise<void> {
  try {
    await Promise.race([
      scanPromise,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI art smoke scan')), 15000),
      ),
    ]);
    await reloadForSmoke(win);
    const result = await Promise.race([
      win.webContents.executeJavaScript(uiArtProbeSource(), true),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI art probe')), 15000),
      ),
    ]);
    console.log(`[newamp-ui-art-smoke] ${JSON.stringify(result)}`);
    isQuitting = true;
    app.quit();
  } catch (err) {
    console.error('[newamp-ui-art-smoke] failed:', err);
    app.exit(1);
  }
}

async function runUiDeckSmoke(win: BrowserWindow): Promise<void> {
  try {
    const result = await Promise.race([
      win.webContents.executeJavaScript(uiDeckProbeSource(), true),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI deck probe')), 20000),
      ),
    ]);
    const bounds = win.getBounds();
    console.log(`[newamp-ui-deck-smoke] ${JSON.stringify({
      ...result,
      nativeBounds: { width: bounds.width, height: bounds.height },
      resizable: win.isResizable(),
    })}`);
    isQuitting = true;
    app.quit();
  } catch (err) {
    console.error('[newamp-ui-deck-smoke] failed:', err);
    app.exit(1);
  }
}

function reloadForSmoke(win: BrowserWindow): Promise<void> {
  return new Promise((resolveReload, rejectReload) => {
    const cleanup = (): void => {
      win.webContents.off('did-finish-load', onFinish);
      win.webContents.off('did-fail-load', onFail);
    };
    const onFinish = (): void => {
      cleanup();
      resolveReload();
    };
    const onFail = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
    ): void => {
      cleanup();
      rejectReload(new Error(`Smoke reload failed ${errorCode} ${errorDescription} ${validatedURL}`));
    };
    win.webContents.once('did-finish-load', onFinish);
    win.webContents.once('did-fail-load', onFail);
    win.webContents.reloadIgnoringCache();
  });
}

function uiPlaybackProbeSource(): string {
  return `
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (label, fn, timeout = 10000) => {
        const start = performance.now();
        while (performance.now() - start < timeout) {
          const value = fn();
          if (value) return value;
          await sleep(75);
        }
        throw new Error('Timed out waiting for ' + label);
      };
      const libraryButton = await waitFor('Library navigation', () =>
        Array.from(document.querySelectorAll('button'))
          .find((item) => (item.textContent || '').includes('Library')),
      );
      libraryButton.click();
      const row = await waitFor('library track row', () =>
        Array.from(document.querySelectorAll('[data-newamp-track-row]'))
          .find((item) => /UI Playback Smoke/.test(item.textContent || '')),
      );
      row.scrollIntoView({ block: 'center' });
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      await waitFor('playing transport', () =>
        document.querySelector('[data-newamp-transport][data-newamp-playing="true"]'),
      );
      const timeEl = await waitFor('current time advancement', () => {
        const el = document.querySelector('[data-newamp-current-time]');
        const value = Number(el?.getAttribute('data-newamp-current-time') || '0');
        return value > 0.25 ? el : null;
      }, 8000);
      const currentTitle =
        document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
      const currentTime = Number(timeEl.getAttribute('data-newamp-current-time') || '0');
      return {
        ok: true,
        currentTitle,
        currentTime,
        rowText: (row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 180),
      };
    })()
  `;
}

function uiVisualizerProbeSource(): string {
  return `
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (label, fn, timeout = 10000) => {
        const start = performance.now();
        while (performance.now() - start < timeout) {
          const value = fn();
          if (value) return value;
          await sleep(75);
        }
        throw new Error('Timed out waiting for ' + label);
      };
      const libraryButton = await waitFor('Library navigation', () =>
        Array.from(document.querySelectorAll('button'))
          .find((item) => (item.textContent || '').includes('Library')),
      );
      libraryButton.click();
      const row = await waitFor('visualizer library track row', () =>
        Array.from(document.querySelectorAll('[data-newamp-track-row]'))
          .find((item) => /Visualizer Smoke/.test(item.textContent || '')),
      );
      row.scrollIntoView({ block: 'center' });
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      await waitFor('visualizer smoke playback', () => {
        const transport = document.querySelector('[data-newamp-transport][data-newamp-playing="true"]');
        const title = document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
        return transport && /Visualizer Smoke/.test(title) ? transport : null;
      });
      const timeEl = await waitFor('visualizer smoke time advancement', () => {
        const el = document.querySelector('[data-newamp-current-time]');
        const value = Number(el?.getAttribute('data-newamp-current-time') || '0');
        return value > 0.25 ? el : null;
      }, 8000);
      const vizButton = await waitFor('real VIZ button', () =>
        Array.from(document.querySelectorAll('[data-newamp-open-visualizer]'))
          .find((item) => (item.textContent || '').trim() === 'VIZ'),
      );
      vizButton.click();
      const stage = await waitFor('fullscreen visualizer stage', () =>
        document.querySelector('[data-newamp-fullscreen-visualizer]'),
      );
      const stageRect = stage.getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      if (stageRect.width < viewport.width * 0.9 || stageRect.height < viewport.height * 0.9) {
        throw new Error(
          'Fullscreen visualizer is not covering the viewport: ' +
            JSON.stringify({ stageRect: { width: stageRect.width, height: stageRect.height }, viewport }),
        );
      }
      const spectrumButton = await waitFor('Spectrum visualizer preset button', () =>
        Array.from(document.querySelectorAll('[data-newamp-viz-preset-button]'))
          .find((item) => item.getAttribute('data-newamp-viz-preset-button') === 'spectrum'),
      );
      spectrumButton.click();
      const sampleCanvas = (canvas) => {
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context || canvas.width < 120 || canvas.height < 80) return null;
        const width = canvas.width;
        const height = canvas.height;
        const data = context.getImageData(0, 0, width, height).data;
        let litSamples = 0;
        let totalSamples = 0;
        for (let index = 0; index < data.length; index += 16) {
          const alpha = data[index + 3] || 0;
          const luminance = (data[index] || 0) + (data[index + 1] || 0) + (data[index + 2] || 0);
          if (alpha > 0 && luminance > 30) litSamples += 1;
          totalSamples += 1;
        }
        return litSamples > 0 ? { width, height, litSamples, totalSamples } : null;
      };
      const canvas = await waitFor('fullscreen visualizer canvas', () =>
        stage.querySelector('[data-newamp-visualizer-canvas][data-newamp-visualizer-mode="spectrum"]'),
      );
      const render = await waitFor('nonblank visualizer frame', () => sampleCanvas(canvas), 8000);
      const plasmaButton = await waitFor('Plasma Grid visualizer preset button', () =>
        Array.from(document.querySelectorAll('[data-newamp-viz-preset-button]'))
          .find((item) => item.getAttribute('data-newamp-viz-preset-button') === 'plasma-grid'),
      );
      plasmaButton.click();
      await waitFor('plasma-grid visualizer stage', () =>
        stage.getAttribute('data-newamp-visualizer-preset') === 'plasma-grid',
      );
      const plasmaCanvas = await waitFor('plasma-grid canvas', () =>
        stage.querySelector('[data-newamp-visualizer-canvas][data-newamp-visualizer-mode="plasma-grid"]'),
      );
      const plasmaRender = await waitFor('nonblank plasma-grid visualizer frame', () => sampleCanvas(plasmaCanvas), 8000);
      const ribbonButton = await waitFor('Neon Ribbons visualizer preset button', () =>
        Array.from(document.querySelectorAll('[data-newamp-viz-preset-button]'))
          .find((item) => item.getAttribute('data-newamp-viz-preset-button') === 'neon-ribbons'),
      );
      ribbonButton.click();
      await waitFor('neon-ribbons visualizer stage', () =>
        stage.getAttribute('data-newamp-visualizer-preset') === 'neon-ribbons',
      );
      const ribbonCanvas = await waitFor('neon-ribbons canvas', () =>
        stage.querySelector('[data-newamp-visualizer-canvas][data-newamp-visualizer-mode="neon-ribbons"]'),
      );
      const ribbonRender = await waitFor('nonblank neon-ribbons visualizer frame', () => sampleCanvas(ribbonCanvas), 8000);
      const auroraButton = await waitFor('Aurora visualizer preset button', () =>
        Array.from(document.querySelectorAll('[data-newamp-viz-preset-button]'))
          .find((item) => item.getAttribute('data-newamp-viz-preset-button') === 'aurora'),
      );
      auroraButton.click();
      await waitFor('aurora visualizer stage', () =>
        stage.getAttribute('data-newamp-visualizer-preset') === 'aurora',
      );
      const auroraCanvas = await waitFor('aurora canvas', () =>
        stage.querySelector('[data-newamp-visualizer-canvas][data-newamp-visualizer-mode="aurora"]'),
      );
      const auroraRender = await waitFor('nonblank aurora visualizer frame', () => sampleCanvas(auroraCanvas), 8000);
      const qualityButton = await waitFor('4K quality toggle', () =>
        document.querySelector('[data-newamp-viz-quality-button]'),
      );
      qualityButton.click();
      await waitFor('4K visualizer quality state', () =>
        stage.getAttribute('data-newamp-visualizer-quality') === '4k',
      );
      const artButton = await waitFor('art overlay toggle', () =>
        document.querySelector('[data-newamp-viz-art-button]'),
      );
      artButton.click();
      await waitFor('art overlay state', () =>
        stage.getAttribute('data-newamp-visualizer-art') === 'visible',
      );
      const cleanButton = await waitFor('clean visualizer toggle', () =>
        document.querySelector('[data-newamp-viz-clean-button]'),
      );
      cleanButton.click();
      await waitFor('clean visualizer chrome state', () =>
        stage.getAttribute('data-newamp-visualizer-chrome') === 'clean',
      );
      const currentTitle =
        document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
      const currentTime = Number(timeEl.getAttribute('data-newamp-current-time') || '0');
      window.__newampSmoke?.setFullscreenVisualizer?.(false);
      await waitFor('fullscreen visualizer closes', () =>
        document.querySelector('[data-newamp-fullscreen-visualizer]') ? null : true,
      );
      const transportArtButton = await waitFor('transport visualizer opener', () =>
        document.querySelector('[data-newamp-transport] [data-newamp-open-visualizer]'),
      );
      transportArtButton.click();
      await waitFor('fullscreen visualizer reopens', () =>
        document.querySelector('[data-newamp-fullscreen-visualizer]'),
      );
      window.__newampSmoke?.setCompactDeck?.(true);
      await waitFor('compact deck opens and clears fullscreen visualizer', () => {
        const deck = document.querySelector('.compact-root, .deck-winamp-classic, .deck-record-player, .deck-jukebox, .deck-cassette, .deck-hotdog, .deck-retro-tv');
        const fullscreen = document.querySelector('[data-newamp-fullscreen-visualizer]');
        return deck && !fullscreen ? deck : null;
      });
      return {
        ok: true,
        currentTitle,
        currentTime,
        preset: 'spectrum',
        render,
        xboxRender: {
          plasmaGrid: plasmaRender,
          neonRibbons: ribbonRender,
        },
        auroraRender,
        stageRect: { width: stageRect.width, height: stageRect.height },
        viewport,
        openedViaVizButton: true,
        openedViaTransportArt: true,
        compactClearsFullscreen: true,
        qualityToggle: stage.getAttribute('data-newamp-visualizer-quality'),
        artToggle: stage.getAttribute('data-newamp-visualizer-art'),
        chromeMode: stage.getAttribute('data-newamp-visualizer-chrome'),
      };
    })()
  `;
}

function uiDeckProbeSource(): string {
  return `
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (label, fn, timeout = 10000) => {
        const start = performance.now();
        while (performance.now() - start < timeout) {
          const value = fn();
          if (value) return value;
          await sleep(75);
        }
        throw new Error('Timed out waiting for ' + label);
      };
      const measure = () => ({
        width: window.innerWidth,
        height: window.innerHeight,
        rootWidth: Math.round((document.querySelector('.compact-root, .deck-winamp-classic, .deck-record-player, .deck-jukebox, .deck-cassette, .deck-hotdog, .deck-retro-tv')?.getBoundingClientRect().width || 0)),
        rootHeight: Math.round((document.querySelector('.compact-root, .deck-winamp-classic, .deck-record-player, .deck-jukebox, .deck-cassette, .deck-hotdog, .deck-retro-tv')?.getBoundingClientRect().height || 0)),
      });
      const deckButton = await waitFor('real DECK button', () =>
        Array.from(document.querySelectorAll('button'))
          .find((item) => (item.textContent || '').trim() === 'DECK'),
      );
      deckButton.click();
      await waitFor('windowshade compact deck', () => document.querySelector('.compact-root'));
      const shade = await waitFor('windowshade size', () => {
        const box = measure();
        return Math.abs(box.width - 820) <= 12 && Math.abs(box.height - 112) <= 12 ? box : null;
      });
      const pickSkin = async (skin) => {
        const select = await waitFor('deck skin select', () => document.querySelector('[data-newamp-deck-skin-select]'));
        select.value = skin;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      await pickSkin('record-player');
      await waitFor('record-player deck', () => document.querySelector('.deck-record-player'));
      const record = await waitFor('record-player size', () => {
        const box = measure();
        return Math.abs(box.width - 540) <= 12 && Math.abs(box.height - 540) <= 12 ? box : null;
      });
      await pickSkin('hotdog');
      await waitFor('hotdog deck', () => document.querySelector('.deck-hotdog'));
      const hotdog = await waitFor('hotdog size', () => {
        const box = measure();
        return Math.abs(box.width - 740) <= 12 && Math.abs(box.height - 240) <= 12 ? box : null;
      });
      await pickSkin('retro-tv');
      await waitFor('retro-tv deck', () => document.querySelector('.deck-retro-tv'));
      const tv = await waitFor('retro-tv size', () => {
        const box = measure();
        return Math.abs(box.width - 520) <= 12 && Math.abs(box.height - 430) <= 12 ? box : null;
      });
      await pickSkin('winamp-classic');
      await waitFor('winamp-classic deck', () => document.querySelector('.deck-winamp-classic'));
      const winamp = await waitFor('winamp-classic size', () => {
        const box = measure();
        return Math.abs(box.width - 550) <= 12 && Math.abs(box.height - 232) <= 12 ? box : null;
      });
      await pickSkin('bento');
      await waitFor('windowshade deck returns', () => document.querySelector('.compact-root'));
      const shadeAgain = await waitFor('windowshade size after shape switch', () => {
        const box = measure();
        return Math.abs(box.width - 820) <= 12 && Math.abs(box.height - 112) <= 12 ? box : null;
      });
      return {
        ok: true,
        openedViaDeckButton: true,
        visibleSkinButtons: document.querySelectorAll('[data-newamp-deck-skin-select] option').length,
        shade,
        record,
        hotdog,
        tv,
        winamp,
        shadeAgain,
      };
    })()
  `;
}

function uiQuickPlayProbeSource(): string {
  return `
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (label, fn, timeout = 10000) => {
        const start = performance.now();
        while (performance.now() - start < timeout) {
          const value = fn();
          if (value) return value;
          await sleep(75);
        }
        throw new Error('Timed out waiting for ' + label);
      };
      await waitFor('app transport', () => document.querySelector('[data-newamp-transport]'));
      document.body.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k',
        code: 'KeyK',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
      await sleep(100);
      if (!document.querySelector('[data-newamp-quick-play]')) {
        if (!window.__newampSmoke?.openQuickPlay) throw new Error('Quick Play smoke hook is unavailable');
        window.__newampSmoke.openQuickPlay();
      }
      const palette = await waitFor('Quick Play palette', () =>
        document.querySelector('[data-newamp-quick-play]'),
      );
      const input = await waitFor('Quick Play input', () => palette.querySelector('input'));
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, 'Quick Play Smoke');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const row = await waitFor('Quick Play result row', () =>
        Array.from(document.querySelectorAll('[data-newamp-quick-play-row]'))
          .find((item) => /Quick Play Smoke/.test(item.textContent || '')),
      );
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      }));
      await waitFor('Quick Play transport playing', () => {
        const transport = document.querySelector('[data-newamp-transport][data-newamp-playing="true"]');
        const title = document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
        return transport && /Quick Play Smoke/.test(title) ? transport : null;
      });
      const timeEl = await waitFor('Quick Play time advancement', () => {
        const el = document.querySelector('[data-newamp-current-time]');
        const value = Number(el?.getAttribute('data-newamp-current-time') || '0');
        return value > 0.25 ? el : null;
      }, 8000);
      const currentTitle =
        document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
      const currentTime = Number(timeEl.getAttribute('data-newamp-current-time') || '0');
      return {
        ok: true,
        currentTitle,
        currentTime,
        rowText: (row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 180),
      };
    })()
  `;
}

function uiOpenFileProbeSource(): string {
  return `
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (label, fn, timeout = 15000) => {
        const start = performance.now();
        while (performance.now() - start < timeout) {
          const value = fn();
          if (value) return value;
          await sleep(75);
        }
        throw new Error('Timed out waiting for ' + label);
      };
      await waitFor('packaged open-file playback', () => {
        const transport = document.querySelector('[data-newamp-transport][data-newamp-playing="true"]');
        const title = document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
        return transport && /Packaged Open File Smoke/.test(title) ? transport : null;
      });
      const timeEl = await waitFor('packaged open-file time advancement', () => {
        const el = document.querySelector('[data-newamp-current-time]');
        const value = Number(el?.getAttribute('data-newamp-current-time') || '0');
        return value > 0.25 ? el : null;
      }, 8000);
      const currentTitle =
        document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
      const currentTime = Number(timeEl.getAttribute('data-newamp-current-time') || '0');
      return {
        ok: true,
        currentTitle,
        currentTime,
        viewHasNowPlaying: !!document.querySelector('[data-newamp-now-playing]'),
      };
    })()
  `;
}

function uiGaplessProbeSource(): string {
  return `
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (label, fn, timeout = 10000) => {
        const start = performance.now();
        while (performance.now() - start < timeout) {
          const value = fn();
          if (value) return value;
          await sleep(50);
        }
        throw new Error('Timed out waiting for ' + label);
      };
      const libraryButton = await waitFor('Library navigation', () =>
        Array.from(document.querySelectorAll('button'))
          .find((item) => (item.textContent || '').includes('Library')),
      );
      libraryButton.click();
      const rows = await waitFor('gapless library rows', () => {
        const items = Array.from(document.querySelectorAll('[data-newamp-track-row]'));
        return items.length >= 2 && items.some((item) => /Gapless First/.test(item.textContent || '')) &&
          items.some((item) => /Gapless Second/.test(item.textContent || ''))
          ? items
          : null;
      });
      const firstRow = rows.find((item) => /Gapless First/.test(item.textContent || ''));
      if (!firstRow) throw new Error('First gapless row was not found');
      firstRow.scrollIntoView({ block: 'center' });
      firstRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      await waitFor('first gapless track playing', () => {
        const transport = document.querySelector('[data-newamp-transport][data-newamp-playing="true"]');
        const title = document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
        return transport && /Gapless First/.test(title) ? transport : null;
      });
      await waitFor('first gapless time advance', () => {
        const el = document.querySelector('[data-newamp-current-time]');
        const value = Number(el?.getAttribute('data-newamp-current-time') || '0');
        return value > 0.25 ? el : null;
      });
      if (!window.__newampSmoke?.seek) throw new Error('Smoke seek hook is unavailable');
      const seekedAt = performance.now();
      window.__newampSmoke.seek(3.72);
      await waitFor('gapless advance into second track', () => {
        const title = document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
        return /Gapless Second/.test(title) ? title : null;
      }, 1500);
      const title = document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
      const currentTime = Number(document.querySelector('[data-newamp-current-time]')?.getAttribute('data-newamp-current-time') || '0');
      return {
        ok: true,
        currentTitle: title,
        currentTime,
        transitionMs: Math.round(performance.now() - seekedAt),
      };
    })()
  `;
}

function uiHandoffProbeSource(): string {
  return `
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (label, fn, timeout = 10000) => {
        const start = performance.now();
        while (performance.now() - start < timeout) {
          const value = fn();
          if (value) return value;
          await sleep(50);
        }
        throw new Error('Timed out waiting for ' + label);
      };
      const libraryButton = await waitFor('Library navigation', () =>
        Array.from(document.querySelectorAll('button'))
          .find((item) => (item.textContent || '').includes('Library')),
      );
      libraryButton.click();
      const rows = await waitFor('handoff library rows', () => {
        const items = Array.from(document.querySelectorAll('[data-newamp-track-row]'));
        return items.length >= 2 && items.some((item) => /Handoff First/.test(item.textContent || '')) &&
          items.some((item) => /Handoff Second/.test(item.textContent || ''))
          ? items
          : null;
      });
      const firstRow = rows.find((item) => /Handoff First/.test(item.textContent || ''));
      if (!firstRow) throw new Error('First handoff row was not found');
      firstRow.scrollIntoView({ block: 'center' });
      firstRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      await waitFor('first track playing', () => {
        const transport = document.querySelector('[data-newamp-transport][data-newamp-playing="true"]');
        const title = document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
        return transport && /Handoff First/.test(title) ? transport : null;
      });
      await waitFor('first track time advance', () => {
        const el = document.querySelector('[data-newamp-current-time]');
        const value = Number(el?.getAttribute('data-newamp-current-time') || '0');
        return value > 0.25 ? el : null;
      });
      if (!window.__newampSmoke?.seek) throw new Error('Smoke seek hook is unavailable');
      const seekedAt = performance.now();
      window.__newampSmoke.seek(2.35);
      await waitFor('handoff into second track before natural end', () => {
        const title = document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
        return /Handoff Second/.test(title) ? title : null;
      }, 1400);
      const title = document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
      const currentTime = Number(document.querySelector('[data-newamp-current-time]')?.getAttribute('data-newamp-current-time') || '0');
      return {
        ok: true,
        currentTitle: title,
        currentTime,
        transitionMs: Math.round(performance.now() - seekedAt),
      };
    })()
  `;
}

function uiArtProbeSource(): string {
  return `
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (label, fn, timeout = 10000) => {
        const start = performance.now();
        while (performance.now() - start < timeout) {
          const value = await fn();
          if (value) return value;
          await sleep(75);
        }
        throw new Error('Timed out waiting for ' + label);
      };
      if (!window.newamp?.getTracks || !window.newamp?.getArtUrl) {
        throw new Error('NewAmp preload API is unavailable');
      }
      const track = await waitFor('track with album art', async () => {
        const rows = await window.newamp.getTracks({ limit: 250 });
        return rows.find((item) => item.hasArt) || null;
      });
      const url = window.newamp.getArtUrl(track.id);
      const response = await fetch(url);
      if (!response.ok) throw new Error('Art fetch failed: ' + response.status + ' ' + url);
      const contentType = response.headers.get('content-type') || '';
      const bytes = (await response.arrayBuffer()).byteLength;
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        const timer = setTimeout(() => reject(new Error('Timed out decoding art image ' + url)), 8000);
        img.onload = () => {
          clearTimeout(timer);
          resolve({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, complete: img.complete });
        };
        img.onerror = () => {
          clearTimeout(timer);
          reject(new Error('Art image element failed to load ' + url));
        };
        img.src = url;
      });
      return {
        ok: true,
        trackId: track.id,
        title: track.title,
        album: track.album,
        url,
        contentType,
        bytes,
        image,
      };
    })()
  `;
}

function uiLyricsProbeSource(): string {
  return `
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (label, fn, timeout = 12000) => {
        const start = performance.now();
        while (performance.now() - start < timeout) {
          const value = fn();
          if (value) return value;
          await sleep(100);
        }
        throw new Error('Timed out waiting for ' + label);
      };
      const libraryButton = await waitFor('Library navigation', () =>
        Array.from(document.querySelectorAll('button'))
          .find((item) => (item.textContent || '').includes('Library')),
      );
      libraryButton.click();
      const row = await waitFor('Radiohead Creep library row', () =>
        Array.from(document.querySelectorAll('[data-newamp-track-row]'))
          .find((item) => /Creep/.test(item.textContent || '') && /Radiohead/.test(item.textContent || '')),
      );
      row.scrollIntoView({ block: 'center' });
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      await waitFor('playing transport', () =>
        document.querySelector('[data-newamp-transport][data-newamp-playing="true"]'),
      );
      const nowPlayingButton = await waitFor('Now Playing navigation', () =>
        Array.from(document.querySelectorAll('button'))
          .find((item) => (item.textContent || '').includes('Now Playing')),
      );
      nowPlayingButton.click();
      const lyricsTab = await waitFor('Lyrics side tab', () =>
        Array.from(document.querySelectorAll('[role="tab"], button'))
          .find((item) => (item.textContent || '').trim() === 'Lyrics'),
      );
      lyricsTab.click();
      const panel = await waitFor('lyrics panel', () =>
        document.querySelector('[data-newamp-lyrics-panel]'),
      );
      const karaokeButton = await waitFor('karaoke mode button', () =>
        Array.from(panel.querySelectorAll('button'))
          .find((item) => /karaoke/i.test(item.textContent || '')),
      );
      karaokeButton.click();
      await waitFor('karaoke lyrics mode', () =>
        panel.getAttribute('data-newamp-lyrics-karaoke') === 'true' ? panel : null,
      );
      const lyricReady = await waitFor('LRCLIB lyric content', () => {
        const status = panel.getAttribute('data-newamp-lyrics-status') || '';
        const mode = panel.getAttribute('data-newamp-lyrics-mode') || '';
        const source = panel.getAttribute('data-newamp-lyrics-source') || '';
        const lineCount = Number(panel.getAttribute('data-newamp-lyrics-line-count') || '0');
        const plainLength = Number(panel.getAttribute('data-newamp-lyrics-plain-length') || '0');
        return status === 'ok' && (lineCount > 0 || plainLength > 40)
          ? { status, mode, source, lineCount, plainLength }
          : null;
      }, 25000);
      const firstTimedLine = await waitFor('timed lyric line', () =>
        document.querySelector('[data-newamp-lyric-line][data-newamp-lyric-time]'),
      );
      const targetTime = Number(firstTimedLine.getAttribute('data-newamp-lyric-time') || '0') + 0.2;
      if (!window.__newampSmoke?.seek) throw new Error('Smoke seek hook is unavailable');
      window.__newampSmoke.seek(targetTime);
      await waitFor('transport seek into lyrics', () => {
        const el = document.querySelector('[data-newamp-current-time]');
        const value = Number(el?.getAttribute('data-newamp-current-time') || '0');
        return value >= targetTime - 0.1 ? el : null;
      }, 8000);
      const activeLine = await waitFor('active synced lyric line after seek', () =>
        document.querySelector('[data-newamp-lyric-line][data-newamp-lyric-state="current"]'),
      );
      const currentTitle =
        document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
      const cacheKeys = Object.keys(localStorage).filter((key) => key.startsWith('newamp:lyrics:v1:'));
      if (lyricReady.source !== 'sidecar' && lyricReady.source !== 'custom' && !cacheKeys.length) {
        throw new Error('Lyrics loaded but were not cached locally');
      }
      const sample =
        document.querySelector('[data-newamp-lyric-line]')?.textContent ||
        document.querySelector('[data-newamp-plain-lyrics]')?.textContent ||
        '';
      return {
        ok: true,
        currentTitle,
        lyricStatus: lyricReady.status,
        lyricMode: lyricReady.mode,
        karaokeMode: panel.getAttribute('data-newamp-lyrics-karaoke') === 'true',
        lyricSource: lyricReady.source,
        lineCount: lyricReady.lineCount,
        plainLength: lyricReady.plainLength,
        cacheKeys: cacheKeys.length,
        activeLine: (activeLine.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        sample: sample.replace(/\\s+/g, ' ').trim().slice(0, 160),
      };
    })()
  `;
}

function safeFileStem(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim() || 'NewAmp Playlist';
}

async function importSkinFile(skinPath: string): Promise<CustomSkin> {
  const content = await readFile(skinPath);
  return isWinampClassicSkinArchiveName(skinPath)
    ? parseWinampClassicSkinArchive(content, skinPath)
    : parseCustomSkinFile(content.toString('utf8'));
}

function openGuitarTabWindow(document: GuitarTabDocument, startAutoscroll: boolean): void {
  if (!['ultimate-guitar', 'local'].includes(document.source) || !document.lines.length) {
    throw new Error('Only NewAmp guitar tab documents can be opened.');
  }
  const win = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: `${document.artist} - ${document.title} - NewAmp Tab`,
    backgroundColor: '#060a0e',
    autoHideMenuBar: true,
    show: false,
    parent: mainWin ?? undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  attachWindowDiagnostics(win, 'guitar-tab');
  tabWindows.add(win);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => tabWindows.delete(win));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderGuitarTabWindowHtml(document, startAutoscroll))}`)
    .catch((err) => console.error('guitar tab window load failed', err));
}

function renderGuitarTabWindowHtml(document: GuitarTabDocument, startAutoscroll: boolean): string {
  const title = `${document.artist} - ${document.title}`;
  const sourceLink = /^https:\/\//i.test(document.url)
    ? `<a class="button" href="${escapeHtml(document.url)}" target="_blank" rel="noreferrer">Source</a>`
    : `<span class="button" aria-disabled="true">Local</span>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'" />
  <title>${escapeHtml(title)} - NewAmp Tab</title>
  <style>
    :root { color-scheme: dark; --bg: #060a0e; --panel: #0d151b; --panel2: #101d25; --line: #1b3038; --ink: #e6f5ea; --muted: #8fa0aa; --accent: #34d399; --warn: #f5c451; }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--bg); color: var(--ink); font-family: "JetBrains Mono", Consolas, monospace; }
    header { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; padding: 14px 18px; background: var(--panel); border-bottom: 1px solid var(--line); }
    h1 { margin: 0; font-size: 20px; line-height: 1.15; }
    .meta { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 10px; color: var(--muted); font-size: 11px; }
    .eyebrow { margin-bottom: 5px; color: var(--accent); font-size: 10px; text-transform: uppercase; letter-spacing: .12em; }
    .toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 18px; background: var(--panel); border-bottom: 1px solid var(--line); color: var(--muted); font-size: 11px; }
    button, a.button { border: 1px solid var(--line); background: var(--panel2); color: var(--ink); padding: 5px 9px; font: inherit; text-decoration: none; cursor: pointer; }
    button:hover, a.button:hover { border-color: var(--accent); color: var(--accent); }
    label { display: inline-flex; align-items: center; gap: 6px; }
    input[type="range"] { width: 150px; accent-color: var(--accent); }
    #semitones { min-width: 42px; text-align: center; color: var(--accent); font-weight: 700; }
    #scroller { height: calc(100vh - 126px); overflow: auto; padding: 22px 28px 40vh; }
    .line { min-height: 21px; white-space: pre-wrap; font-size: 14px; line-height: 1.5; }
    .chords { color: var(--accent); font-weight: 700; }
    .tab { color: var(--warn); }
    .section { color: var(--ink); font-weight: 700; margin-top: 10px; }
    .lyrics { color: #bdcbd3; }
    .blank { color: var(--muted); }
  </style>
</head>
<body>
  <header>
    <div>
      <div class="eyebrow">NewAmp Native Guitar Tab Window</div>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">
        <span>${escapeHtml(document.kind)}</span>
        ${document.key ? `<span>Key ${escapeHtml(document.key)}</span>` : ''}
        ${document.rating ? `<span>${escapeHtml(document.rating.toFixed(1))} rating</span>` : ''}
        ${document.votes ? `<span>${escapeHtml(document.votes.toLocaleString())} votes</span>` : ''}
      </div>
    </div>
    ${sourceLink}
  </header>
  <div class="toolbar">
    <span>Transpose</span>
    <button id="down">-1</button>
    <span id="semitones">0</span>
    <button id="up">+1</button>
    <button id="reset">Reset</button>
    <label><input id="autoscroll" type="checkbox" ${startAutoscroll ? 'checked' : ''} /> Auto-scroll</label>
    <input id="speed" type="range" min="0.2" max="4" step="0.1" value="1.2" />
  </div>
  <div id="scroller"><div id="lines"></div></div>
  <script id="tab-data" type="application/json">${safeJsonForScript(document)}</script>
  <script>
    const tab = JSON.parse(document.getElementById('tab-data').textContent);
    const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const NOTE_INDEX = new Map([['C',0],['B#',0],['C#',1],['Db',1],['D',2],['D#',3],['Eb',3],['E',4],['Fb',4],['E#',5],['F',5],['F#',6],['Gb',6],['G',7],['G#',8],['Ab',8],['A',9],['A#',10],['Bb',10],['B',11],['Cb',11]]);
    const CHORD_RE = /^([A-G](?:#|b)?)([^/\\s]*)(?:\\/([A-G](?:#|b)?))?$/;
    const CHORD_TOKEN_RE = /\\b([A-G](?:#|b)?)(maj|min|m|dim|aug|sus|add|M|mM|o|[0-9]|[#b()+/-])*?(?:\\/([A-G](?:#|b)?))?\\b/g;
    const state = { semitones: 0, autoscroll: ${startAutoscroll ? 'true' : 'false'}, speed: 1.2 };
    const lines = document.getElementById('lines');
    const scroller = document.getElementById('scroller');
    const semitones = document.getElementById('semitones');
    let autoscrollTimer = null;
    function transposeNote(note, amount) {
      const idx = NOTE_INDEX.get(note);
      if (idx == null) return note;
      const next = (idx + amount) % 12;
      return NOTE_NAMES[(next + 12) % 12];
    }
    function transposeToken(token, amount) {
      const match = token.match(CHORD_RE);
      if (!match) return token;
      return transposeNote(match[1], amount) + (match[2] || '') + (match[3] ? '/' + transposeNote(match[3], amount) : '');
    }
    function transposeLine(text, amount) {
      if (!amount) return text;
      return text.replace(CHORD_TOKEN_RE, token => transposeToken(token, amount));
    }
    function renderLines() {
      lines.textContent = '';
      semitones.textContent = state.semitones > 0 ? '+' + state.semitones : String(state.semitones);
      for (const line of tab.lines) {
        const row = document.createElement('div');
        row.className = 'line ' + line.type;
        row.textContent = line.type === 'chords' ? transposeLine(line.text, state.semitones) : (line.text || ' ');
        lines.appendChild(row);
      }
    }
    function syncAutoscroll() {
      if (autoscrollTimer) window.clearInterval(autoscrollTimer);
      autoscrollTimer = null;
      if (!state.autoscroll) return;
      autoscrollTimer = window.setInterval(() => {
        scroller.scrollTop += state.speed;
      }, 120);
    }
    document.getElementById('down').addEventListener('click', () => { state.semitones = Math.max(-12, state.semitones - 1); renderLines(); });
    document.getElementById('up').addEventListener('click', () => { state.semitones = Math.min(12, state.semitones + 1); renderLines(); });
    document.getElementById('reset').addEventListener('click', () => { state.semitones = 0; renderLines(); });
    document.getElementById('autoscroll').addEventListener('change', event => { state.autoscroll = event.target.checked; syncAutoscroll(); });
    document.getElementById('speed').addEventListener('input', event => { state.speed = Number(event.target.value) || 1.2; syncAutoscroll(); });
    renderLines();
    syncAutoscroll();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

async function choosePlaylistExportPath(
  id: number,
  extension: 'm3u8' | 'pls',
  filters: Electron.FileFilter[],
): Promise<Electron.SaveDialogReturnValue> {
  const playlist = library.getPlaylists().find((item) => item.id === id);
  if (!playlist) return { canceled: true, filePath: '' };
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  }
  const options: Electron.SaveDialogOptions = {
    title: 'Export NewAmp playlist',
    defaultPath: `${safeFileStem(playlist.name)}.${extension}`,
    filters,
  };
  return mainWin ? dialog.showSaveDialog(mainWin, options) : dialog.showSaveDialog(options);
}

async function choosePlaylistFolderExportRoot(
  playlist: SavedPlaylist,
): Promise<Electron.OpenDialogReturnValue> {
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  }
  const options: Electron.OpenDialogOptions = {
    title: `Choose folder for ${playlist.name}`,
    defaultPath: app.getPath('music'),
    properties: ['openDirectory', 'createDirectory'],
  };
  return mainWin ? dialog.showOpenDialog(mainWin, options) : dialog.showOpenDialog(options);
}

function normalizeExportFolderName(name: unknown, now = Date.now()): string {
  const value = typeof name === 'string' ? name.trim() : '';
  return value || `NewAmp Queue ${new Date(now).toISOString().slice(0, 10)}`;
}

async function chooseTrackWavExportPath(track: Track): Promise<Electron.SaveDialogReturnValue> {
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  }
  const artist = track.artist && track.artist !== 'Unknown Artist' ? track.artist : 'NewAmp';
  const title = track.title || basename(track.path, extname(track.path));
  const options: Electron.SaveDialogOptions = {
    title: 'Export track as WAV',
    defaultPath: `${safeFileStem(`${artist} - ${title}`)}.wav`,
    filters: [{ name: 'WAV audio', extensions: ['wav'] }],
  };
  return mainWin ? dialog.showSaveDialog(mainWin, options) : dialog.showSaveDialog(options);
}

async function chooseTracksWavExportFolder(trackCount: number): Promise<Electron.OpenDialogReturnValue> {
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  }
  const options: Electron.OpenDialogOptions = {
    title: `Choose folder for ${trackCount.toLocaleString()} WAV export${trackCount === 1 ? '' : 's'}`,
    buttonLabel: 'Export WAVs here',
    properties: ['openDirectory', 'createDirectory'],
  };
  return mainWin ? dialog.showOpenDialog(mainWin, options) : dialog.showOpenDialog(options);
}

async function chooseTracksAudioExportFolder(
  trackCount: number,
  format: AudioExportFormat,
): Promise<Electron.OpenDialogReturnValue> {
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  }
  const label = format.toUpperCase();
  const options: Electron.OpenDialogOptions = {
    title: `Choose folder for ${trackCount.toLocaleString()} ${label} export${trackCount === 1 ? '' : 's'}`,
    buttonLabel: `Export ${label}s here`,
    properties: ['openDirectory', 'createDirectory'],
  };
  return mainWin ? dialog.showOpenDialog(mainWin, options) : dialog.showOpenDialog(options);
}

function resolveExportTracks(ids: number[]): Track[] {
  const tracks: Track[] = [];
  for (const rawId of Array.isArray(ids) ? ids : []) {
    const id = Math.trunc(Number(rawId));
    if (!Number.isFinite(id) || id <= 0) continue;
    const track = library.getTrack(id);
    if (track) tracks.push(track);
  }
  return tracks;
}

async function analyzeReplayGain(ids: number[]) {
  const tracks = resolveExportTracks(ids);
  const updated: Track[] = [];
  const skipped: string[] = [];
  for (const track of tracks) {
    try {
      const analysis = await analyzeTrackReplayGain(track.path);
      const next = library.setTrackReplayGain(track.id, analysis.replayGainTrackDb);
      if (next) updated.push(next);
      else skipped.push(`${track.artist} - ${track.title}: track was not updated`);
    } catch (err) {
      skipped.push(`${track.artist} - ${track.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { analyzed: updated.length, skipped, tracks: updated };
}

async function analyzeAlbumReplayGain(ids: number[]) {
  const groups = groupTracksForAlbumReplayGain(resolveExportTracks(ids));
  const updated: Track[] = [];
  const skipped: string[] = [];
  let albumGroups = 0;

  for (const tracks of groups.values()) {
    const analyses: Array<{ track: Track; replayGainTrackDb: number; integratedLufs: number; duration: number | null }> = [];
    for (const track of tracks) {
      try {
        const analysis = await analyzeTrackReplayGain(track.path);
        analyses.push({
          track,
          replayGainTrackDb: analysis.replayGainTrackDb,
          integratedLufs: analysis.integratedLufs,
          duration: track.duration,
        });
      } catch (err) {
        skipped.push(`${track.artist} - ${track.title}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!analyses.length) continue;
    const replayGainAlbumDb = calculateAlbumReplayGainDb(analyses);
    albumGroups += 1;
    for (const analysis of analyses) {
      const next = library.setTrackReplayGain(analysis.track.id, analysis.replayGainTrackDb, replayGainAlbumDb);
      if (next) updated.push(next);
      else skipped.push(`${analysis.track.artist} - ${analysis.track.title}: track was not updated`);
    }
  }

  return { analyzed: updated.length, skipped, tracks: updated, albumGroups };
}

function groupTracksForAlbumReplayGain(tracks: Track[]): Map<string, Track[]> {
  const groups = new Map<string, Track[]>();
  for (const track of tracks) {
    const album = normalizeAlbumReplayGainKeyPart(track.album) || `track:${track.id}`;
    const albumArtist = normalizeAlbumReplayGainKeyPart(track.albumArtist)
      || normalizeAlbumReplayGainKeyPart(track.artist)
      || 'unknown artist';
    const key = `${albumArtist}\u0000${album}`;
    const group = groups.get(key) ?? [];
    group.push(track);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) =>
      (a.discNo ?? 0) - (b.discNo ?? 0)
      || (a.trackNo ?? 0) - (b.trackNo ?? 0)
      || a.title.localeCompare(b.title)
      || a.path.localeCompare(b.path),
    );
  }
  return groups;
}

function normalizeAlbumReplayGainKeyPart(value: string | null | undefined): string {
  const text = String(value ?? '').trim().toLowerCase();
  return text && !['unknown album', 'unknown artist'].includes(text) ? text : '';
}

async function openFiles(paths: string[]): Promise<OpenFilesResult> {
  const targets = normalizeOpenTargets(paths);
  const audioPaths: string[] = [];
  const playlistPaths: string[] = [];
  const cuePaths: string[] = [];
  const folderPaths: string[] = [];
  const skipped: string[] = [];

  for (const { path, kind } of targets) {
    if (kind === 'directory') {
      folderPaths.push(path);
      continue;
    }
    const ext = extname(path).toLowerCase();
    if (OPEN_AUDIO_EXTS.has(ext)) audioPaths.push(path);
    else if (ext === '.cue') cuePaths.push(path);
    else if (OPEN_PLAYLIST_EXTS.has(ext)) playlistPaths.push(path);
    else skipped.push(path);
  }

  const cueSheets: Array<{ path: string; entries: CueSheetEntry[] }> = [];
  for (const path of cuePaths) {
    try {
      const content = await readFile(path, 'utf8');
      const entries = parseCueSheet(content, path);
      if (!entries.length) {
        skipped.push(`${path}: no playable CUE audio tracks found`);
        continue;
      }
      cueSheets.push({ path, entries });
    } catch (err) {
      skipped.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const cueAudio = cueSheets.flatMap((sheet) => cueAudioPaths(sheet.entries));
  const scanTargets = [...folderPaths, ...audioPaths, ...cueAudio];
  if (scanTargets.length) await scanner.start(scanTargets);

  const importedPlaylists = [];
  const tracks = library.getTracksByPaths(audioPaths);
  const seenTrackIds = new Set(tracks.map((track) => track.id));

  for (const folderPath of folderPaths) {
    for (const track of library.getFolderTracks(folderPath, { recursive: true, limit: 100000 })) {
      if (seenTrackIds.has(track.id)) continue;
      seenTrackIds.add(track.id);
      tracks.push(track);
    }
  }

  for (const path of playlistPaths) {
    try {
      const content = await readFile(path, 'utf8');
      const name = basename(path).replace(/\.(m3u8?|pls|txt)$/i, '');
      const imported = library.importPlaylistM3u({ name, content, baseDir: dirname(path) });
      importedPlaylists.push(imported);
      for (const track of library.getPlaylistTracks(imported.playlist.id)) {
        if (seenTrackIds.has(track.id)) continue;
        seenTrackIds.add(track.id);
        tracks.push(track);
      }
    } catch {
      skipped.push(path);
    }
  }

  for (const sheet of cueSheets) {
    const sourceTracks = library.getTracksByPaths(cueAudioPaths(sheet.entries));
    const cueTracks = cueEntriesToTracks(sheet.entries, sourceTracks);
    if (!cueTracks.length) {
      skipped.push(`${sheet.path}: CUE source audio was not cataloged`);
      continue;
    }
    for (const track of cueTracks) {
      if (seenTrackIds.has(track.id)) continue;
      seenTrackIds.add(track.id);
      tracks.push(track);
    }
  }

  return { tracks, importedPlaylists, skipped };
}

function collectOpenFileArgs(argv: string[]): string[] {
  return normalizeOpenTargets(
    argv.filter((arg) => {
      if (!arg || arg.startsWith('-') || arg.startsWith('newamp:')) return false;
      const ext = extname(arg).toLowerCase();
      return OPEN_AUDIO_EXTS.has(ext) || OPEN_PLAYLIST_EXTS.has(ext);
    }),
  ).map((target) => target.path);
}

function normalizeOpenTargets(paths: string[]): Array<{ path: string; kind: 'file' | 'directory' }> {
  const out: Array<{ path: string; kind: 'file' | 'directory' }> = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const resolved = resolve(raw);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    try {
      const stat = statSync(resolved);
      if (stat.isFile()) {
        seen.add(key);
        out.push({ path: resolved, kind: 'file' });
      } else if (stat.isDirectory()) {
        seen.add(key);
        out.push({ path: resolved, kind: 'directory' });
      }
    } catch {
      continue;
    }
  }
  return out;
}

async function flushLastfmOutbox(): Promise<{ sent: number; remaining: number }> {
  return lastfmOutbox.flush((item) =>
    scrobbleLastfmTrack(settings.get(), item.track, item.timestamp),
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function buildSupportDiagnostics(): Promise<SupportDiagnostics> {
  const userData = app.getPath('userData');
  const diagnosticsPath = join(userData, 'diagnostics');
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    electronVersion: process.versions.electron ?? 'unknown',
    userDataPath: userData,
    diagnosticsPath,
    diagnosticEventsPath: join(diagnosticsPath, 'events.jsonl'),
    latestCrashPath: join(diagnosticsPath, 'latest-crash.json'),
    crashDumpsPath: app.getPath('crashDumps'),
    settingsPath: join(userData, 'settings.json'),
    libraryPath: join(userData, 'library.db'),
    generatedAt: Date.now(),
    libraryStats: library.getStats(),
    lastfmOutbox: await lastfmOutbox.status(),
    recoveryEvents: [...settings.recoveryEvents, ...library.recoveryEvents],
  };
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  settings = new SettingsStore(join(userData, 'settings.json'));
  lastfmOutbox = new LastfmScrobbleOutbox(join(userData, 'lastfm-scrobbles.json'));
  podcastStore = new PodcastStore(join(userData, 'podcasts.json'));

  // Auto-seed default library root to K:\music if nothing configured and it exists.
  const current = settings.get();
  if (!smokeMode && !current.libraryRoots.length) {
    const candidates = ['K:/music', 'K:\\music', 'C:/Music', 'C:/Users/Public/Music'];
    for (const c of candidates) {
      try {
        if (existsSync(c) && statSync(c).isDirectory()) {
          settings.set({ libraryRoots: [c] });
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }

  library = await LibraryStore.open(join(userData, 'library.db'));
  scanner = createScannerService(library);
  libraryWatcher = createLibraryWatcherService();

  registerAudioProtocol();
  registerIpc();

  mainWin = createWindow();
  registerTray();
  registerMediaShortcuts();
  syncLibraryWatcher();

  // Auto-scan on launch if the library is empty and roots are configured
  mainWin.webContents.once('did-finish-load', () => {
    const stats = library.getStats();
    const roots = settings.get().libraryRoots;
    let scanPromise = Promise.resolve();
    if (roots.length && (stats.tracks === 0 || settings.get().libraryAutoWatch)) {
      scanPromise = scanner.start(roots);
    }
    if (uiPlaybackSmoke && mainWin) {
      void runUiPlaybackSmoke(mainWin, scanPromise);
    } else if (uiQuickPlaySmoke && mainWin) {
      void runUiQuickPlaySmoke(mainWin, scanPromise);
    } else if (uiOpenFileSmoke && mainWin) {
      void runUiOpenFileSmoke(mainWin);
    } else if (uiHandoffSmoke && mainWin) {
      void runUiHandoffSmoke(mainWin, scanPromise);
    } else if (uiGaplessSmoke && mainWin) {
      void runUiGaplessSmoke(mainWin, scanPromise);
    } else if (uiLyricsSmoke && mainWin) {
      void runUiLyricsSmoke(mainWin, scanPromise);
    } else if (uiVisualizerSmoke && mainWin) {
      void runUiVisualizerSmoke(mainWin, scanPromise);
    } else if (uiDeckSmoke && mainWin) {
      void runUiDeckSmoke(mainWin);
    } else if (uiArtSmoke && mainWin) {
      void runUiArtSmoke(mainWin, scanPromise);
    }
  });
}

const singleInstanceLock = app.requestSingleInstanceLock();

process.on('uncaughtException', (err, origin) => {
  writeDiagnosticEvent('main-uncaught-exception', { origin, error: err });
  console.error('[newamp] uncaught exception', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  writeDiagnosticEvent('main-unhandled-rejection', { reason });
  console.error('[newamp] unhandled rejection', reason);
});

app.on('child-process-gone', (_event, details) => {
  writeDiagnosticEvent('child-process-gone', details as unknown as Record<string, unknown>);
});

app.on('render-process-gone', (_event, webContents, details) => {
  writeDiagnosticEvent('app-render-process-gone', {
    url: webContents.getURL(),
    details,
  });
});

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    enqueueOpenFiles(collectOpenFileArgs(argv));
    showMainWindow();
  });

  app.on('open-file', (event, path) => {
    event.preventDefault();
    enqueueOpenFiles([path]);
  });

  app.whenReady().then(bootstrap).catch((err) => {
    console.error('Bootstrap failed:', err);
    app.exit(1);
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  libraryWatcher?.stop();
  tray?.destroy();
  tray = null;
});

app.on('window-all-closed', () => {
  if (!isQuitting && tray && process.platform !== 'darwin') return;
  scanner?.cancel();
  library?.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWin && !mainWin.isDestroyed()) {
    showMainWindow();
  } else {
    mainWin = createWindow();
  }
});
