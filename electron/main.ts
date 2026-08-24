import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  globalShortcut,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeImage,
  protocol,
  screen,
  shell,
  dialog,
  Tray,
  type Display,
  type Rectangle,
} from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
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
  isLastfmAuthFailure,
  startLastfmAuth,
  updateLastfmNowPlaying,
  type LastfmOutboxFlushResult,
} from './lastfm.js';
import {
  playbackMode,
  calculateAlbumReplayGainDb,
  analyzeTrackReplayGain,
  transcodeToWavResponse,
  transcodeTrackToWavFile,
  transcodeTracksToAudioFolder,
  transcodeTracksToWavFolder,
  killAllTranscodeFfmpeg,
} from './transcode.js';
import { fileRangeResponse, seekableTranscodeResponse } from './audio-serve.js';
import { initTranscodeCache, getOrTranscodeToFlac, peekCachedFlac, transcodeCacheStatus } from './transcode-cache.js';
import { finishWebmToMp4 } from './video-mux.js';
import { isAllowedAudioPath } from './audio-path-policy.js';
import { analyzeTrackDna, killAllDnaFfmpeg } from './dna-analyzer.js';
import { RadioBrain } from './radio-brain.js';
import { ExclusiveOutput, classifyTrackSource } from './exclusive-output.js';
import { isFfmpegFallbackExtension } from '../shared/audio-quality.js';
import { exportPlaylistFolder } from './playlist-export.js';
import { createSupportBackup, restoreSupportBackup } from './support-backup.js';
import { generateOpenAiLinerNotes } from './openai-assist.js';
import {
  assertSkinImportPathAllowed,
  isWinampClassicSkinArchiveName,
  MAX_SKIN_IMPORT_FILE_BYTES,
  parseWinampClassicSkinArchive,
} from './winamp-skin-import.js';
import { createPlaylistCoverGuard } from './playlist-cover-guard.js';
import { shouldStayResidentOnWindowAllClosed } from './window-lifecycle-policy.js';
import { cueAudioPaths, cueEntriesToTracks, parseCueSheet, type CueSheetEntry } from './cue.js';
import { defaultMusicScanRoots, suggestMusicFolders } from './music-folders.js';
import { parseCustomSkinFile, serializeCustomSkin } from '../shared/custom-skin.js';
import { buildAppMenuTemplate } from './app-menu.js';
import type {
  AppSettings,
  CustomSkin,
  DiscoverSurfaceInput,
  ExclusiveTrackSource,
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
  SavePlaylistInput,
  ScanProgress,
  SupportDiagnostics,
  Track,
  TrackMetadataPatchInput,
} from '../shared/types.js';
import type { VisualMemoryPlan } from '../shared/visual-memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, '..', '..');
const startupSmoke = process.env.NEWAMP_STARTUP_SMOKE === '1' || process.argv.includes('--newamp-startup-smoke');
const startupSmokeMarker =
  process.env.NEWAMP_STARTUP_SMOKE_MARKER || commandLineValue('--newamp-startup-smoke-marker');
const userDataOverride =
  process.env.NEWAMP_USER_DATA_DIR || commandLineValue('--newamp-user-data-dir');
const sessionDataOverride =
  process.env.NEWAMP_SESSION_DATA_DIR || commandLineValue('--newamp-session-data-dir');
const uiPlaybackSmoke = process.env.NEWAMP_UI_PLAYBACK_SMOKE === '1';
const uiQuickPlaySmoke = process.env.NEWAMP_UI_QUICK_PLAY_SMOKE === '1';
const uiHandoffSmoke = process.env.NEWAMP_UI_HANDOFF_SMOKE === '1';
const uiGaplessSmoke = process.env.NEWAMP_UI_GAPLESS_SMOKE === '1';
const uiLyricsSmoke = process.env.NEWAMP_UI_LYRICS_SMOKE === '1';
const uiOpenFileSmoke = process.env.NEWAMP_UI_OPEN_FILE_SMOKE === '1';
const uiVisualizerSmoke = process.env.NEWAMP_UI_VISUALIZER_SMOKE === '1';
const uiDetachedVizSmoke = process.env.NEWAMP_UI_DETACHED_VIZ_SMOKE === '1';
const uiDeckSmoke = process.env.NEWAMP_UI_DECK_SMOKE === '1';
const uiArtSmoke = process.env.NEWAMP_UI_ART_SMOKE === '1';
const uiDiscoverSmoke = process.env.NEWAMP_UI_DISCOVER_SMOKE === '1';
const exclusiveUiSmoke = process.env.NEWAMP_EXCLUSIVE_UI_SMOKE === '1';
const screenshotGallery = process.env.NEWAMP_SCREENSHOT_GALLERY === '1';
const smokeMode =
  startupSmoke ||
  uiPlaybackSmoke ||
  uiQuickPlaySmoke ||
  uiHandoffSmoke ||
  uiGaplessSmoke ||
  uiLyricsSmoke ||
  uiOpenFileSmoke ||
  uiVisualizerSmoke ||
  uiDetachedVizSmoke ||
  uiDeckSmoke ||
  uiArtSmoke ||
  uiDiscoverSmoke ||
  exclusiveUiSmoke ||
  screenshotGallery;
// Hardware acceleration defaults ON. NewAmp is a real-time WebGL visualizer
// (Butterchurn) plus GPU-composited, audio-reactive chrome — it MUST run on the
// GPU to feel light. The historical default of software rendering was a
// holdover from the GPU-less sandbox the app was built in; it forced
// Butterchurn onto SwiftShader and CPU-composited the entire UI, the single
// biggest "feels heavy" cause on every machine. Software is now used only for:
// smokes (often headless / no GPU), an explicit opt-out, or auto-recovery
// after a prior GPU-process crash (sentinel resolved below, once userData is
// set up). Chromium's GPU blocklist still handles known-bad drivers.
const gpuForcedOff = process.env.NEWAMP_DISABLE_HARDWARE_ACCELERATION === '1';
const gpuForcedOn = process.env.NEWAMP_ENABLE_HARDWARE_ACCELERATION === '1';
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
  '.dff',
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
              : uiDiscoverSmoke
                ? 'ui-discover-smoke-user-data'
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

if (smokeMode) {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
}

// Auto-recovery: if a previous launch crashed the GPU process, this launch
// falls back to software and clears the flag so the NEXT launch retries the
// GPU. A genuinely broken driver will rewrite the sentinel and stay on
// software; a one-off transient crash recovers automatically. Chromium's own
// GPU blocklist still handles known-bad drivers even with HW accel on.
const gpuCrashSentinel = join(app.getPath('userData'), 'gpu-crash-recovery');
let gpuCrashedLastLaunch = false;
if (!gpuForcedOn && existsSync(gpuCrashSentinel)) {
  gpuCrashedLastLaunch = true;
  try {
    rmSync(gpuCrashSentinel);
  } catch {
    /* best effort — next launch will still retry */
  }
}
const forceSoftwareRendering = smokeMode || gpuForcedOff || gpuCrashedLastLaunch;

if (forceSoftwareRendering) {
  applySoftwareRenderingSwitches(smokeMode ? 'smoke' : 'normal');
}

function safeListMacVolumesMusic(): string[] {
  try {
    return readdirSync('/Volumes')
      .filter((vol) => vol !== 'Macintosh HD' && !vol.startsWith('.'))
      .map((vol) => `/Volumes/${vol}/Music`);
  } catch {
    return [];
  }
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

// This diagnostic log is appended to on every tracked event for the lifetime
// of the install; without a cap it grows forever.
const DIAGNOSTIC_LOG_MAX_BYTES = 5 * 1024 * 1024;

function rotateDiagnosticLogIfNeeded(eventsPath: string): void {
  try {
    if (statSync(eventsPath).size <= DIAGNOSTIC_LOG_MAX_BYTES) return;
    const rotatedPath = `${eventsPath}.1`;
    if (existsSync(rotatedPath)) rmSync(rotatedPath);
    renameSync(eventsPath, rotatedPath);
  } catch {
    // events.jsonl doesn't exist yet (first run) — nothing to rotate.
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
    const eventsPath = join(diagnosticsDir, 'events.jsonl');
    rotateDiagnosticLogIfNeeded(eventsPath);
    appendFileSync(eventsPath, line, 'utf8');
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

function attachExternalLinkHandler(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isExternalUrl(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
}

function isExternalUrl(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url);
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
let startupSplashWin: BrowserWindow | null = null;
let startupSplashStartedAt = 0;
let isQuitting = false;
let library: LibraryStore;
let settings: SettingsStore;
let scanner: Scanner;
let libraryWatcher: LibraryWatcher;
let lastfmOutbox: LastfmScrobbleOutbox;
let podcastStore: PodcastStore;
let radioBrain: RadioBrain | null = null;
let exclusiveOutput: ExclusiveOutput | null = null;

function getExclusiveOutput(): ExclusiveOutput {
  if (!exclusiveOutput) {
    exclusiveOutput = new ExclusiveOutput({
      send: (payload) => {
        if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('exclusive:event', payload);
      },
      sendTap: (pcm, channels, sampleRate) => {
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send('exclusive:tap', { pcm, channels, sampleRate });
        }
      },
    });
  }
  return exclusiveOutput;
}

// Per-file format probe cache (bit depth / channel count aren't in the library
// DB). Keyed on path+mtime so edits invalidate naturally.
const exclusiveSourceCache = new Map<string, ExclusiveTrackSource>();
// playlist:save only accepts a coverImagePath that playlist:pick-cover just
// approved via a real dialog.showOpenDialog() result — see
// electron/playlist-cover-guard.ts.
const playlistCoverGuard = createPlaylistCoverGuard();

async function resolveExclusiveSource(trackId: number): Promise<ExclusiveTrackSource | null> {
  // The library lookup IS the access gate: only real DB rows resolve, same
  // trust level as 'library:get-track'.
  const track = library?.getTrack(trackId);
  if (!track) return null;
  const cacheKey = `${track.path}:${track.mtime}`;
  const cached = exclusiveSourceCache.get(cacheKey);
  if (cached) return { ...cached, trackId };
  const classified = classifyTrackSource(track.path);
  const source: ExclusiveTrackSource = {
    trackId,
    path: track.path,
    sampleRate: track.sampleRate,
    bitDepth: null,
    channels: null,
    durationSec: track.duration,
    ...classified,
  };
  try {
    const { parseFile } = await import('music-metadata');
    const meta = await parseFile(track.path, { duration: false, skipCovers: true });
    source.bitDepth = meta.format.bitsPerSample ?? null;
    source.channels = meta.format.numberOfChannels ?? null;
    source.sampleRate = meta.format.sampleRate ?? track.sampleRate;
    if (typeof meta.format.lossless === 'boolean' && !classified.dsd) {
      source.lossless = meta.format.lossless;
    }
  } catch {
    // DB metadata + extension classification is an honest fallback.
  }
  if (exclusiveSourceCache.size > 500) exclusiveSourceCache.clear();
  exclusiveSourceCache.set(cacheKey, source);
  return source;
}
let pendingOpenFiles = collectOpenFileArgs(process.argv);

// Session opened-files allowlist for the `newamp:` protocol (todo 005). Every
// open-file entry point (CLI argv, macOS open-file event, second-instance
// argv, drag-drop via the open:files IPC) registers its realpathed targets so
// the protocol handler can serve them even when they live outside the library.
const openedAudioFiles = new Set<string>();
// Lazily realpathed podcast downloads root. Cached on first success only —
// the directory does not exist until the first download completes, and a
// cached null would 403 podcast playback forever.
let podcastDownloadsRealRoot: string | null = null;

async function allowOpenedAudioFile(path: string): Promise<void> {
  try {
    openedAudioFiles.add((await realpath(path)).replace(/\\/g, '/'));
  } catch {
    /* vanished/unreadable — stays unauthorized */
  }
}

async function getPodcastDownloadsRealRoot(): Promise<string | null> {
  if (podcastDownloadsRealRoot) return podcastDownloadsRealRoot;
  try {
    podcastDownloadsRealRoot = await realpath(join(app.getPath('userData'), 'podcast-downloads'));
  } catch {
    return null;
  }
  return podcastDownloadsRealRoot;
}

for (const initialOpenFile of pendingOpenFiles) {
  void allowOpenedAudioFile(initialOpenFile);
}

const isDev = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL;
const openDevTools = isDev && process.env.OPEN_DEVTOOLS === '1';
const STARTUP_SPLASH_HOLD_MS = 5600;
const startupSplashEnabled = !smokeMode && process.env.NEWAMP_DISABLE_STARTUP_SPLASH !== '1';

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    icon: resolveWindowIconPath(),
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 13 }, backgroundColor: '#0b0b10' }
      : { transparent: true, backgroundColor: '#00000000' }),
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
  attachExternalLinkHandler(win);

  if (smokeMode) {
    win.webContents.on('console-message', (details) => {
      const source = details.sourceId ? ` ${details.sourceId}:${details.lineNumber}` : '';
      console.error(`[newamp-smoke-renderer] ${details.message}${source}`);
    });
  }

  win.once('ready-to-show', () => {
    if (smokeMode) return;
    const reveal = () => {
      closeStartupSplashWindow();
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
      applyThumbarButtons(win);
      if (openDevTools) win.webContents.openDevTools({ mode: 'detach' });
    };
    const remainingSplashMs = startupSplashWin
      ? Math.max(0, STARTUP_SPLASH_HOLD_MS - (Date.now() - startupSplashStartedAt))
      : 0;
    setTimeout(reveal, remainingSplashMs);
  });

  win.on('maximize', () => win.webContents.send('window-state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('window-state', { maximized: false }));
  win.on('closed', () => {
    // On macOS (no tray) closing actually destroys the window; drop the stale
    // reference so `activate` recreates cleanly instead of probing a dead one.
    if (mainWin === win) mainWin = null;
  });
  win.on('close', (event) => {
    if (smokeMode || isQuitting) return;
    if (!tray || tray.isDestroyed()) return;
    // User-configurable close behavior. Default preserves the legacy
    // minimize-to-tray flow; 'close-app' actually quits the process so the
    // X button matches what most desktop users expect.
    const behavior = settings.get().closeButtonBehavior;
    if (behavior === 'close-app') {
      isQuitting = true;
      app.quit();
      return;
    }
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

// --- Detached Eviland visualizer window (pop-out to projector / 2nd monitor) ---
//
// One reactor lives in the main renderer. The detached window is a thin
// EvilandFrame consumer connected via a MessageChannelMain port pair, so
// per-frame data flows renderer ↔ renderer without round-tripping through
// main. The window MUST have backgroundThrottling:false — a projector
// display loses focus and Chromium would otherwise drop its rAF to ~1 Hz.

let detachedVizWin: BrowserWindow | null = null;
let displayWatcherRegistered = false;

interface DetachedDisplay {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  internal: boolean;
  primary: boolean;
}

function mapDisplay(display: Display, primaryId: number): DetachedDisplay {
  return {
    id: display.id,
    label: display.label || `Display ${display.id}`,
    bounds: { ...display.bounds },
    workArea: { ...display.workArea },
    scaleFactor: display.scaleFactor,
    internal: Boolean((display as Display & { internal?: boolean }).internal),
    primary: display.id === primaryId,
  };
}

function listDetachedDisplays(): DetachedDisplay[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d) => mapDisplay(d, primaryId));
}

function pickDetachedDisplay(displayId?: number): Display {
  const all = screen.getAllDisplays();
  if (displayId !== undefined) {
    const match = all.find((d) => d.id === displayId);
    if (match) return match;
  }
  const primary = screen.getPrimaryDisplay();
  // Default to the first non-primary display (typical projector / 2nd monitor
  // case); fall back to primary if only one display exists.
  return all.find((d) => d.id !== primary.id) ?? primary;
}

function getRendererBaseUrl(): URL {
  return isDev
    ? new URL('http://localhost:5173/')
    : new URL('newamp-app://app/');
}

// Tear down a half-opened detached window and tell the main renderer why, so
// the UI toggle never gets stuck "open" against a phantom/black window the user
// can't recover without restarting NewAmp.
function failDetachedOpen(reason: string, err: unknown): void {
  console.error(`[newamp] detached visualizer ${reason}`, err);
  writeDiagnosticEvent('detached-viz-open-failed', { reason, error: err });
  restoreMainWindowThrottling();
  const win = detachedVizWin;
  detachedVizWin = null;
  if (win && !win.isDestroyed()) {
    try { win.destroy(); } catch { /* already gone */ }
  }
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('detached-viz:open-failed', { reason });
  }
}

function openDetachedVisualizer(opts: { displayId?: number; fullscreen?: boolean } = {}): void {
  if (detachedVizWin && !detachedVizWin.isDestroyed()) {
    detachedVizWin.show();
    detachedVizWin.focus();
    if (opts.fullscreen !== undefined) {
      detachedVizWin.setFullScreen(Boolean(opts.fullscreen));
    }
    return;
  }
  if (!mainWin || mainWin.isDestroyed()) return;

  const target = pickDetachedDisplay(opts.displayId);
  const width = Math.min(1280, Math.max(480, target.bounds.width - 80));
  const height = Math.min(720, Math.max(320, target.bounds.height - 80));

  const win = new BrowserWindow({
    x: target.bounds.x + 40,
    y: target.bounds.y + 40,
    width,
    height,
    show: false,
    frame: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'NewAmp — Eviland',
    icon: resolveWindowIconPath(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      // LOAD-BEARING: without this, Chromium throttles requestAnimationFrame
      // to ~1 Hz when the detached window's display is not focused — exactly
      // the projector case.
      backgroundThrottling: false,
    },
  });
  detachedVizWin = win;
  attachWindowDiagnostics(win, 'detached-viz');
  attachExternalLinkHandler(win);

  win.on('closed', () => {
    if (detachedVizWin === win) detachedVizWin = null;
    restoreMainWindowThrottling();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('detached-viz:closed');
    }
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    restoreMainWindowThrottling();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('detached-viz:crashed', { reason: details.reason });
    }
    // A crashed renderer can leave the BrowserWindow alive-but-stuck; the
    // 'closed' event is NOT guaranteed to fire. Destroy it ourselves so the
    // next open() doesn't short-circuit on a zombie window.
    if (detachedVizWin === win) detachedVizWin = null;
    if (!win.isDestroyed()) {
      try { win.destroy(); } catch { /* already gone */ }
    }
  });

  const rendererUrl = new URL('detached.html', getRendererBaseUrl());
  win.loadURL(rendererUrl.toString()).catch((err) => {
    failDetachedOpen('loadURL failed', err);
  });

  win.once('ready-to-show', () => {
    if (!detachedVizWin || detachedVizWin.isDestroyed()) return;
    detachedVizWin.show();
    // Pull the projector to the front so it isn't lost behind the (often
    // maximized / fullscreen) main window when both share one display.
    detachedVizWin.focus();
    if (opts.fullscreen) detachedVizWin.setFullScreen(true);
    // NOTE: the frame port is NOT wired here. ready-to-show fires around
    // first paint, which races the detached entry module's evaluation — a
    // MessagePort posted before its window listener existed was dropped
    // forever (black projector stuck on "Connecting to NewAmp…"). The
    // detached renderer signals 'detached-viz:renderer-ready' once its
    // listener is installed; wireDetachedFramePort() runs then.
  });
}

// Wire the per-frame transport once BOTH renderers can receive postMessage
// events. port1 → main renderer (producer), port2 → detached renderer
// (consumer). Transferring ownership requires the ports be listed in the
// third arg of webContents.postMessage; the channel name matches the preload
// bridge in electron/preload.ts. Called from the renderer-ready IPC and from
// the main-window reload re-wire.
function wireDetachedFramePort(): void {
  if (!detachedVizWin || detachedVizWin.isDestroyed()) return;
  if (!mainWin || mainWin.isDestroyed()) {
    // The main renderer (the frame producer) is gone — a detached window with
    // no peer would just sit black. Don't claim success.
    failDetachedOpen('port wiring failed: main window unavailable', null);
    return;
  }
  try {
    // NOTE: main-window background throttling is deliberately LEFT ON now.
    // It was disabled here in 1.13.0 because the frame producer ran on rAF —
    // but the producer, the audio-engine clock, and all playback bookkeeping
    // have since moved to timers, and Chromium exempts audibly-playing pages
    // from timer throttling. Leaving throttling on means an occluded/
    // minimized main window stops all its rAF UI rendering while the
    // projector runs — which is most of the "suffers mightily when detached"
    // GPU/CPU bill. When playback is paused AND the main window is hidden,
    // the producer drops to ~1Hz and the projector's own status layer
    // truthfully reports "Paused".
    const channel = new MessageChannelMain();
    mainWin.webContents.postMessage('eviland:frame-port', null, [channel.port1]);
    detachedVizWin.webContents.postMessage('eviland:frame-port', null, [channel.port2]);
    mainWin.webContents.send('detached-viz:opened');
  } catch (err) {
    failDetachedOpen('port wiring failed', err);
  }
}

function restoreMainWindowThrottling(): void {
  // Throttling is never disabled anymore (see wireDetachedFramePort), but
  // re-asserting the default on projector close keeps this path harmless and
  // self-healing if some future code toggles it.
  if (mainWin && !mainWin.isDestroyed()) {
    try {
      mainWin.webContents.setBackgroundThrottling(true);
    } catch {
      /* shutting down */
    }
  }
}

function closeDetachedVisualizer(): void {
  if (!detachedVizWin || detachedVizWin.isDestroyed()) {
    detachedVizWin = null;
    return;
  }
  try {
    detachedVizWin.close();
  } catch (err) {
    console.error('[newamp] detached visualizer close failed', err);
  }
}

function moveDetachedVisualizerToDisplay(displayId: number): void {
  if (!detachedVizWin || detachedVizWin.isDestroyed()) return;
  const target = pickDetachedDisplay(displayId);
  const wasFullscreen = detachedVizWin.isFullScreen();
  if (wasFullscreen) detachedVizWin.setFullScreen(false);
  const width = Math.min(1280, Math.max(480, target.bounds.width - 80));
  const height = Math.min(720, Math.max(320, target.bounds.height - 80));
  detachedVizWin.setBounds({
    x: target.bounds.x + 40,
    y: target.bounds.y + 40,
    width,
    height,
  });
  if (wasFullscreen) detachedVizWin.setFullScreen(true);
}

function setDetachedVisualizerFullscreen(on: boolean): void {
  if (!detachedVizWin || detachedVizWin.isDestroyed()) return;
  detachedVizWin.setFullScreen(Boolean(on));
}

// Toggle returns the resulting state so the projector's control bar can update
// its button without a separate round-trip. Without this, callers had to know
// the current fullscreen state before they could ask to leave it — the
// projector window has no way to discover that on its own.
function toggleDetachedVisualizerFullscreen(): boolean {
  if (!detachedVizWin || detachedVizWin.isDestroyed()) return false;
  const next = !detachedVizWin.isFullScreen();
  detachedVizWin.setFullScreen(next);
  return next;
}

function isDetachedVisualizerFullscreen(): boolean {
  if (!detachedVizWin || detachedVizWin.isDestroyed()) return false;
  return detachedVizWin.isFullScreen();
}

function registerDisplayWatchers(): void {
  if (displayWatcherRegistered) return;
  displayWatcherRegistered = true;
  const broadcast = () => {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('displays:changed');
    }
  };
  screen.on('display-added', broadcast);
  screen.on('display-removed', () => {
    broadcast();
    if (!detachedVizWin || detachedVizWin.isDestroyed()) return;
    // If the detached window lived on the removed display, snap it home so
    // the user doesn't lose track of it. By the time this event fires the
    // removed display is already gone from getAllDisplays(), so matching the
    // removed display's id via getDisplayMatching can never succeed (it only
    // returns displays that still exist). Instead ask whether the window's
    // bounds still overlap ANY remaining display; if not, it's stranded on
    // the unplugged monitor.
    const bounds = detachedVizWin.getBounds();
    const stillVisible = screen.getAllDisplays().some((d) => {
      const area = d.workArea ?? d.bounds;
      return (
        bounds.x < area.x + area.width &&
        bounds.x + bounds.width > area.x &&
        bounds.y < area.y + area.height &&
        bounds.y + bounds.height > area.y
      );
    });
    if (!stillVisible) {
      const fallback = screen.getPrimaryDisplay();
      detachedVizWin.setFullScreen(false);
      detachedVizWin.setBounds({
        x: fallback.bounds.x + 40,
        y: fallback.bounds.y + 40,
        width: Math.min(1280, Math.max(480, fallback.bounds.width - 80)),
        height: Math.min(720, Math.max(320, fallback.bounds.height - 80)),
      });
    }
  });
  screen.on('display-metrics-changed', broadcast);
}

function createStartupSplashWindow(): void {
  if (!startupSplashEnabled || startupSplashWin) return;
  const logoPath = resolveStartupSplashLogoPath();
  if (!logoPath) return;
  const splashHtmlPath = writeStartupSplashHtml(logoPath);
  if (!splashHtmlPath) return;
  startupSplashStartedAt = Date.now();
  startupSplashWin = new BrowserWindow({
    width: 340,
    height: 340,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: 'NewAmp',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  startupSplashWin.once('ready-to-show', () => {
    if (!startupSplashWin || startupSplashWin.isDestroyed()) return;
    startupSplashWin.showInactive();
  });
  startupSplashWin.on('closed', () => {
    startupSplashWin = null;
  });
  startupSplashWin.loadFile(splashHtmlPath).catch((err) => {
    writeDiagnosticEvent('startup-splash-unavailable', { error: err });
    closeStartupSplashWindow();
  });
}

function closeStartupSplashWindow(): void {
  if (!startupSplashWin || startupSplashWin.isDestroyed()) {
    startupSplashWin = null;
    return;
  }
  startupSplashWin.close();
  startupSplashWin = null;
}

function resolveStartupSplashLogoPath(): string | null {
  const candidates = [
    resolveBundledRendererLogoPath(),
    join(process.resourcesPath, 'build', 'logo-app.webp'),
    join(app.getAppPath(), 'build', 'logo-app.webp'),
    join(appRoot, 'build', 'logo-app.webp'),
    join(appRoot, 'build', 'logo.png'),
  ].filter((value): value is string => !!value);
  for (const logoPath of candidates) {
    try {
      if (!existsSync(logoPath)) continue;
      return logoPath;
    } catch {
      continue;
    }
  }
  return null;
}

function resolveBundledRendererLogoPath(): string | null {
  try {
    const assetsDir = join(rendererDistPath(), 'assets');
    const logoAsset = readdirSync(assetsDir).find((name) => /^logo-app-.*\.webp$/i.test(name));
    return logoAsset ? join(assetsDir, logoAsset) : null;
  } catch {
    return null;
  }
}

function writeStartupSplashHtml(logoPath: string): string | null {
  try {
    const splashDir = join(app.getPath('userData'), 'startup');
    mkdirSync(splashDir, { recursive: true });
    const splashHtmlPath = join(splashDir, 'startup-splash.html');
    writeFileSync(splashHtmlPath, buildStartupSplashHtml(pathToFileURL(logoPath).toString()), 'utf8');
    return splashHtmlPath;
  } catch (err) {
    writeDiagnosticEvent('startup-splash-unavailable', { error: err });
    return null;
  }
}

function buildStartupSplashHtml(logoUrl: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html, body {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: transparent;
}
body {
  display: grid;
  place-items: center;
}
img {
  width: 240px;
  height: 240px;
  object-fit: contain;
  animation: logo-spin 2600ms cubic-bezier(.18,.86,.18,1) both, logo-hold 5600ms ease both;
}
@keyframes logo-spin {
  0% { transform: rotate(0deg) scale(.72); opacity: 0; filter: blur(8px); }
  18% { opacity: 1; filter: blur(0); }
  72% { transform: rotate(360deg) scale(1.08); }
  100% { transform: rotate(360deg) scale(1); opacity: 1; filter: blur(0); }
}
@keyframes logo-hold {
  0%, 88% { opacity: 1; }
  100% { opacity: 0; }
}
</style>
</head>
<body>
  <img alt="NewAmp" src="${escapeHtml(logoUrl)}">
</body>
</html>`;
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
  for (const path of clean) void allowOpenedAudioFile(path);
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

function installApplicationMenu(): void {
  const template = buildAppMenuTemplate(process.platform, {
    appName: app.getName(),
    appVersion: app.getVersion(),
  });
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: app.getName(),
      applicationVersion: app.getVersion(),
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } else {
    // Keep the existing chromeless custom-titlebar look on Windows/Linux.
    Menu.setApplicationMenu(null);
  }
}

function registerTray(): void {
  // macOS uses the Dock lifecycle (close hides the window, app stays in the
  // Dock, Cmd-Q quits) — a persistent menu-bar icon is non-idiomatic, so skip it.
  if (process.platform === 'darwin') return;
  if (tray || smokeMode) return;

  // On Windows, hand the tray the .ico FILE PATH when we can: the shell then
  // selects the correctly-sized frame for the current DPI natively, which is
  // both crisper and more robust than pre-resizing a decoded bitmap. (The
  // historical white-square tray icon was PNG-compressed small frames inside
  // icon.ico — Windows' notification area can't decode those; the ico now
  // ships classic BMP frames, and the path-based Tray keeps us on the shell's
  // own well-tested loading path.)
  const icon = resolveTrayIconPath() ?? resolveTrayIconImage();
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

// --- Windows taskbar thumbnail toolbar (prev / play-pause / next) ----------
//
// The mark of a native-feeling Windows player: transport controls in the
// taskbar hover preview. Glyphs are rasterized programmatically into BGRA
// buffers — no icon assets to ship, always theme-neutral white like the
// system's own thumbar glyphs.

const TRANSPORT_CMDS = new Set([
  'togglePlay',
  'next',
  'prev',
  'seek',
  'setVolume',
]);

interface ShellPlaybackState {
  isPlaying: boolean;
  title: string | null;
  artist: string | null;
  album: string | null;
  trackId: number | null;
  /** Seconds at snapshot time. */
  position: number;
  duration: number;
  volume: number;
  /** Epoch ms of the snapshot — remote clients interpolate from this. */
  at: number;
}

let shellPlaybackState: ShellPlaybackState = {
  isPlaying: false,
  title: null,
  artist: null,
  album: null,
  trackId: null,
  position: 0,
  duration: 0,
  volume: 0.75,
  at: 0,
};

// NewAmp Remote / Radio Brain live-state fan-out.
const shellPlaybackSubscribers = new Set<(state: ShellPlaybackState) => void>();
function subscribeShellPlayback(cb: (state: ShellPlaybackState) => void): () => void {
  shellPlaybackSubscribers.add(cb);
  return () => {
    shellPlaybackSubscribers.delete(cb);
  };
}

function thumbGlyph(inside: (x: number, y: number) => boolean): Electron.NativeImage {
  const S = 32;
  const buf = Buffer.alloc(S * S * 4);
  // 2x2 supersampling for smooth edges at this tiny size.
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let hits = 0;
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) {
        if (inside((x + dx) / S, (y + dy) / S)) hits += 1;
      }
      if (!hits) continue;
      const i = (y * S + x) * 4;
      const a = Math.round((hits / 4) * 255);
      // BGRA, premultiplied white.
      buf[i] = a;
      buf[i + 1] = a;
      buf[i + 2] = a;
      buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S });
}

const inTriangle = (x: number, y: number, x0: number, x1: number, apexRight: boolean): boolean => {
  if (x < x0 || x > x1) return false;
  const u = (x - x0) / (x1 - x0);
  const half = 0.30 * (apexRight ? 1 - u : u);
  return Math.abs(y - 0.5) <= half;
};
const inBar = (x: number, y: number, x0: number, x1: number): boolean =>
  x >= x0 && x <= x1 && y >= 0.2 && y <= 0.8;

let thumbarIcons: { prev: Electron.NativeImage; play: Electron.NativeImage; pause: Electron.NativeImage; next: Electron.NativeImage } | null = null;

function getThumbarIcons() {
  if (!thumbarIcons) {
    thumbarIcons = {
      prev: thumbGlyph((x, y) => inBar(x, y, 0.22, 0.32) || inTriangle(x, y, 0.36, 0.78, false)),
      play: thumbGlyph((x, y) => inTriangle(x, y, 0.3, 0.78, true)),
      pause: thumbGlyph((x, y) => inBar(x, y, 0.3, 0.44) || inBar(x, y, 0.56, 0.7)),
      next: thumbGlyph((x, y) => inTriangle(x, y, 0.22, 0.64, true) || inBar(x, y, 0.68, 0.78)),
    };
  }
  return thumbarIcons;
}

function applyThumbarButtons(win: BrowserWindow | null = mainWin): void {
  if (process.platform !== 'win32' || smokeMode) return;
  if (!win || win.isDestroyed()) return;
  const icons = getThumbarIcons();
  try {
    win.setThumbarButtons([
      { tooltip: 'Previous track', icon: icons.prev, click: () => sendPlayerCommand('previous') },
      shellPlaybackState.isPlaying
        ? { tooltip: 'Pause', icon: icons.pause, click: () => sendPlayerCommand('toggle-play') }
        : { tooltip: 'Play', icon: icons.play, click: () => sendPlayerCommand('toggle-play') },
      { tooltip: 'Next track', icon: icons.next, click: () => sendPlayerCommand('next') },
    ]);
  } catch (err) {
    console.warn('[newamp] thumbar buttons unavailable', err);
  }
}

/**
 * Renderer→shell playback snapshot: swaps the thumbar play/pause glyph and
 * keeps the tray tooltip naming what's actually playing.
 */
function applyShellPlaybackState(state: ShellPlaybackState): void {
  shellPlaybackState = state;
  for (const cb of shellPlaybackSubscribers) {
    try {
      cb(state);
    } catch (err) {
      console.warn('[newamp] shell playback subscriber threw', err);
    }
  }
  applyThumbarButtons();
  if (tray && !tray.isDestroyed()) {
    const label = state.title
      ? `NewAmp — ${state.artist ? `${state.artist} – ` : ''}${state.title}${state.isPlaying ? '' : ' (paused)'}`
      : 'NewAmp';
    try {
      tray.setToolTip(label);
    } catch {
      /* tray torn down mid-update */
    }
  }
}

/**
 * Windows-only: explicit BrowserWindow icon so the taskbar renders our icon
 * directly instead of falling back to the exe resource through the shell's
 * (cache-prone) associated-icon path. Same mixed-format ICO the tray uses:
 * BMP frames <256 for the tray decode path, PNG at 256 for the taskbar/
 * high-res shell path (see scripts/rebuild-icon.mjs).
 */
function resolveWindowIconPath(): string | undefined {
  return resolveTrayIconPath() ?? undefined;
}

/** Windows-only: the packaged/dev .ico path, for shell-native frame selection. */
function resolveTrayIconPath(): string | null {
  if (process.platform !== 'win32') return null;
  const candidates = [
    join(process.resourcesPath, 'build', 'icon.ico'),
    join(app.getAppPath(), 'build', 'icon.ico'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    // Asar paths exist for fs but the Windows shell can't open them — only
    // hand back real on-disk paths.
    if (candidate.includes('app.asar')) continue;
    return candidate;
  }
  return null;
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

async function syncRadioBrain(): Promise<void> {
  const current = settings.get();
  if (!current.radioBrainEnabled) {
    if (radioBrain) {
      await radioBrain.stop();
      radioBrain = null;
    }
    return;
  }
  // The server never runs without a shared secret — it exposes the whole
  // library to the LAN. Generated once, persisted; Settings regenerates by
  // nulling the token, which re-mints here on the very next sync (getToken()
  // reads live settings, so the running server picks it up immediately).
  if (!settings.get().radioBrainToken) {
    settings.set({ radioBrainToken: randomBytes(16).toString('hex') });
  }
  if (radioBrain && radioBrain.status().port !== current.radioBrainPort) {
    await radioBrain.stop();
    radioBrain = null;
  }
  if (!radioBrain) {
    radioBrain = new RadioBrain({
      library,
      port: current.radioBrainPort,
      transcode: (path, signal) => transcodeToWavResponse(path, new Request('http://localhost/audio', { signal })),
      ffmpegFallbackExt: (path) => isFfmpegFallbackExtension(path.split('.').pop() ?? ''),
      getToken: () => settings.get().radioBrainToken ?? '',
      getNowPlaying: () =>
        shellPlaybackState.at > 0
          ? {
              trackId: shellPlaybackState.trackId,
              title: shellPlaybackState.title,
              artist: shellPlaybackState.artist,
              album: shellPlaybackState.album,
              isPlaying: shellPlaybackState.isPlaying,
              position: shellPlaybackState.position,
              duration: shellPlaybackState.duration,
              volume: shellPlaybackState.volume,
              at: shellPlaybackState.at,
            }
          : null,
      onNowPlaying: (cb) =>
        subscribeShellPlayback((state) =>
          cb({
            trackId: state.trackId,
            title: state.title,
            artist: state.artist,
            album: state.album,
            isPlaying: state.isPlaying,
            position: state.position,
            duration: state.duration,
            volume: state.volume,
            at: state.at,
          }),
        ),
      control: (cmd, arg) => {
        // Same whitelist + forwarding path the projector's control bar uses.
        if (!TRANSPORT_CMDS.has(cmd)) return false;
        if (!mainWin || mainWin.isDestroyed()) return false;
        mainWin.webContents.send('transport:command', { cmd, arg });
        return true;
      },
    });
    await radioBrain.start();
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
    void reconcileWatchedTargets(targets);
  });
}

// A watched path can vanish for a moment without being deleted — editor
// save-by-rename, sync clients, network drives. Pruning on first sight
// destroyed the track and all of its play history/ratings for a file that
// came right back. Re-check after a short debounce: only prune what is still
// gone, and let anything that reappeared go through the rescan below as an
// ordinary modification.
const PRUNE_RECHECK_DELAY_MS = 1500;

let watcherReconcile: Promise<void> = Promise.resolve();

function reconcileWatchedTargets(targets: string[]): Promise<void> {
  const run = watcherReconcile.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, PRUNE_RECHECK_DELAY_MS));
    const stillMissing = targets.filter((target) => !existsSync(target));
    if (stillMissing.length) library.pruneMissingTracks(stillMissing);
    void scanner.start(targets, { force: true });
  });
  watcherReconcile = run.catch((err) => {
    console.warn(`[newamp] library watcher reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  return run;
}

async function reloadRuntimeStores(userData: string): Promise<void> {
  settings = new SettingsStore(join(userData, 'settings.json'));
  lastfmOutbox = new LastfmScrobbleOutbox(join(userData, 'lastfm-scrobbles.json'));
  podcastStore = new PodcastStore(join(userData, 'podcasts.json'));
  library = await LibraryStore.open(join(userData, 'library.db'));
  scanner = createScannerService(library);
  libraryWatcher = createLibraryWatcherService();
  syncLibraryWatcher();
  void syncRadioBrain();
}

function registerAudioProtocol(): void {
  // Seekable transcode cache lives on the user-data drive (not the library drive).
  initTranscodeCache(join(app.getPath('userData'), 'transcode-cache'));
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
      // Allowlist gate (todo 005): only paths that arrived through the app's
      // own flows — library roots, library DB, session open-with/drag-drop,
      // podcast downloads — may be served. Decided BEFORE any ffmpeg/cache
      // work so an unauthorized path never reaches the persistent cache.
      // TOCTOU: every downstream consumer gets `real`, the exact validated
      // target, so a symlink swap cannot cache another file under this key.
      let real: string;
      try {
        real = await realpath(filePath);
      } catch {
        return new Response('Not found', { status: 404 });
      }
      const libraryRoots: string[] = [];
      for (const root of settings.get().libraryRoots) {
        try {
          libraryRoots.push(await realpath(root));
        } catch {
          /* missing/unreadable root contributes nothing */
        }
      }
      let isLibraryTrack = false;
      try {
        isLibraryTrack = (library?.getTracksByPaths?.([filePath, real])?.length ?? 0) > 0;
      } catch {
        /* library DB not open yet → not a library track */
      }
      const allowed = isAllowedAudioPath({
        realPath: real,
        libraryRoots,
        openedFiles: openedAudioFiles,
        podcastRoot: await getPodcastDownloadsRealRoot(),
        isLibraryTrack,
      });
      if (!allowed) {
        return new Response('Forbidden', {
          status: 403,
          headers: { 'X-Newamp-Reason': 'path-not-allowed' },
        });
      }
      if (playbackMode(real) === 'ffmpeg') {
        // Seekable path: serve the finalized cached FLAC (range-capable) when it
        // already exists. First play streams a SEEKABLE synthesized WAV instead
        // of awaiting the full encode (todo 001) — audio starts in tens of ms
        // AND scrubbing works (PCM byte offsets map linearly to seconds, so a
        // Range request becomes an `ffmpeg -ss` spawn) — while the FLAC cache
        // warms in the background for cheap repeat plays.
        // NOTE: peek runs FIRST because it awaits the cache's ensureReady(),
        // which is what populates the ffmpeg probe — checking the status before
        // peek would falsely 503 the first request after app start.
        const ready = await peekCachedFlac(real);
        // Preserve the clean 503 contract when ffmpeg is genuinely unavailable.
        if (!ready && !transcodeCacheStatus().ffmpeg) {
          return new Response('ffmpeg unavailable', {
            status: 503,
            headers: { 'X-Newamp-Reason': 'ffmpeg-missing' },
          });
        }
        if (ready) {
          return fileRangeResponse(ready, request, {
            'Content-Type': 'audio/flac',
            'X-Newamp-Playback': 'ffmpeg-cached-flac',
          });
        }
        // Cache miss: warm it in the background (semaphore-bounded, inflight-
        // deduped — duplicate warms coalesce) and stream immediately.
        void getOrTranscodeToFlac(real).catch(() => {});
        return seekableTranscodeResponse(real, request);
      }
      // Native formats: answer byte ranges ourselves. Electron's
      // net.fetch(file://) slices the body per the Range header but reports a
      // bare 200 with no Content-Range/Content-Length/Accept-Ranges, which
      // Chromium's media stack reads as "non-seekable live stream" — that one
      // missing status line is why every scrub snapped back to 0:00.
      return fileRangeResponse(real, request);
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
      // Async read: cover bursts from the album grid must not stall the
      // single main-process thread (and every pending IPC behind it).
      const art = await library.getArtAsync(id);
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

  // Full-library metadata export (JSON or CSV) — tag auditing, spreadsheets,
  // and player migration without losing ratings/plays/loves.
  ipcMain.handle('library:export-metadata', async (_e, format: unknown) => {
    const fmt = format === 'csv' ? 'csv' : 'json';
    const stamp = new Date().toISOString().slice(0, 10);
    const opts: Electron.SaveDialogOptions = {
      title: 'Export library metadata',
      defaultPath: `newamp-library-${stamp}.${fmt}`,
      filters: fmt === 'csv'
        ? [{ name: 'CSV', extensions: ['csv'] }]
        : [{ name: 'JSON', extensions: ['json'] }],
    };
    const result = mainWin ? await dialog.showSaveDialog(mainWin, opts) : await dialog.showSaveDialog(opts);
    if (result.canceled || !result.filePath) return null;
    const rows = library.exportTrackMetadata();
    let payload: string;
    if (fmt === 'json') {
      payload = JSON.stringify(
        { app: 'NewAmp', version: app.getVersion(), exportedAt: new Date().toISOString(), tracks: rows },
        null,
        2,
      );
    } else {
      const headers = Object.keys(
        rows[0] ?? { path: '', title: '', artist: '', album: '' },
      );
      const escape = (value: unknown): string => {
        if (value === null || value === undefined) return '';
        const s = String(value);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [headers.join(',')];
      for (const row of rows) {
        lines.push(headers.map((h) => escape((row as Record<string, unknown>)[h])).join(','));
      }
      payload = lines.join('\r\n');
    }
    await writeFile(result.filePath, payload, 'utf8');
    return { path: result.filePath, tracks: rows.length, format: fmt };
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
  ipcMain.handle('library:get-album-tracks', async (_e, albumArtist: string, album: string) =>
    library.getAlbumTracks(albumArtist, album),
  );
  ipcMain.handle('library:get-artist-tracks', async (_e, artist: string) =>
    library.getArtistTracks(artist),
  );
  ipcMain.handle('library:get-track', async (_e, id: number) => library.getTrack(id));
  ipcMain.handle('library:get-tracks-by-ids', async (_e, ids: unknown) => {
    if (!Array.isArray(ids)) return [];
    const cleanIds = ids
      .map((id) => Math.trunc(Number(id)))
      .filter((id) => Number.isFinite(id) && id > 0);
    return library.getTracksByIdsInOrder(cleanIds);
  });
  ipcMain.handle('playlist:list', async () => library.getPlaylists());
  ipcMain.handle('playlist:save', async (_e, input: SavePlaylistInput) => {
    if (input?.coverImagePath && !playlistCoverGuard.isApproved(input.coverImagePath)) {
      throw new Error('Choose the playlist icon with the picker before saving.');
    }
    return library.savePlaylist(input);
  });
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
    if (result.canceled || !result.filePaths[0]) return null;
    playlistCoverGuard.approve(result.filePaths[0]);
    return result.filePaths[0];
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
  ipcMain.handle('tracks:analyze-dna', async (_e, ids: number[]) => analyzeTracksDna(ids));
  ipcMain.handle('tracks:dna-get', async (_e, id: number) => library.getTrackDna(id));
  ipcMain.handle('tracks:dna-missing-ids', async (_e, limit?: number) => library.getTrackIdsMissingDna(limit ?? 100));
  ipcMain.handle('tracks:dna-stats', async () => library.getDnaStats());
  ipcMain.handle('tracks:dna-all', async () => library.getAllTrackDna());
  ipcMain.handle('tracks:dna-similar', async (_e, id: number, limit?: number) => library.findSimilarTracks(id, limit ?? 20));
  ipcMain.handle('tracks:visual-memory-get', async (_e, id: number) => library.getTrackVisualMemory(id));
  ipcMain.handle('tracks:visual-memory-set', async (_e, id: number, plan: unknown) =>
    library.setTrackVisualMemory(id, plan as VisualMemoryPlan | null),
  );
  ipcMain.handle('tracks:visual-memory-clear', async (_e, id: number) =>
    library.clearTrackVisualMemory(id),
  );
  ipcMain.handle('tracks:visual-memory-stats', async () => library.getVisualMemoryStats());
  ipcMain.handle('tracks:visual-memory-clear-all', async () => library.clearAllVisualMemory());
  ipcMain.handle('tags:list-rules', async () => library.listTagRules());
  ipcMain.handle('tags:save-rule', async (_e, input) => {
    const saved = library.saveTagRule(input);
    library.recomputeTags();
    return saved;
  });
  ipcMain.handle('tags:delete-rule', async (_e, id: number) => {
    library.deleteTagRule(id);
  });
  ipcMain.handle('tags:set-rule-enabled', async (_e, id: number, enabled: boolean) => {
    const rule = library.setTagRuleEnabled(id, enabled);
    library.recomputeTags();
    return rule;
  });
  ipcMain.handle('tags:recompute', async (_e, opts) => library.recomputeTags(opts));
  ipcMain.handle('tags:for-track', async (_e, id: number) => library.getTagsForTrack(id));
  ipcMain.handle('tags:summaries', async () => library.getTagSummaries());
  ipcMain.handle('tags:preview-rule', async (_e, input) => library.previewTagRule(input));
  ipcMain.handle('tags:track-ids-by-tag', async (_e, name: string) => library.getTrackIdsByTag(name));
  ipcMain.handle('open:consume-pending-files', async () => {
    const files = pendingOpenFiles;
    pendingOpenFiles = [];
    return files;
  });
  ipcMain.handle('open:files', async (_e, paths: string[]) => openFiles(paths));
  ipcMain.handle('smart:list', async () => library.getSmartPlaylistRules());
  ipcMain.handle('smart:suggestions', async () => library.getSuggestedSmartPlaylistRules());
  ipcMain.handle('library:get-discover-surface', async (_e, input?: DiscoverSurfaceInput) =>
    library.getDiscoverSurface(input ?? {}),
  );
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
  ipcMain.handle('history:wrapped', async (_e, opts) => library.getWrappedStats(opts ?? {}));

  // --- Local-first social objects ---
  ipcMain.handle('social:reviews:get', async (_e, target) => library.getReviews(target ?? undefined));
  ipcMain.handle('social:reviews:save', async (_e, input) => library.saveReview(input));
  ipcMain.handle('social:reviews:delete', async (_e, id: number) => library.deleteReview(id));
  ipcMain.handle('social:lists:get', async () => library.getLists());
  ipcMain.handle('social:list:get', async (_e, id: number) => library.getList(id));
  ipcMain.handle('social:lists:save', async (_e, input) => library.saveList(input));
  ipcMain.handle('social:lists:delete', async (_e, id: number) => library.deleteList(id));
  ipcMain.handle('social:list-item:add', async (_e, input) => library.addListItem(input));
  ipcMain.handle('social:list-item:remove', async (_e, id: number) => library.removeListItem(id));
  ipcMain.handle('social:list:reorder', async (_e, listId: number, orderedIds: number[]) =>
    library.reorderListItems(listId, orderedIds ?? []),
  );
  ipcMain.handle('social:profile:get', async () => library.getProfile());
  ipcMain.handle('social:profile:save', async (_e, input) => library.saveProfile(input ?? {}));
  ipcMain.handle('social:export-profile', async () => {
    const html = library.buildProfileBundleHtml();
    const profile = library.getProfile();
    const opts = {
      title: 'Export NewAmp profile',
      defaultPath: `${safeFileStem(profile.displayName || 'NewAmp profile')}.html`,
      filters: [{ name: 'HTML page', extensions: ['html'] }],
    };
    const result = mainWin ? await dialog.showSaveDialog(mainWin, opts) : await dialog.showSaveDialog(opts);
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, html, 'utf8');
    return result.filePath;
  });
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
  ipcMain.handle(
    'library:set-album-rating-score',
    async (_e, albumArtist: string, album: string, score: number | null) =>
      library.setAlbumRatingScore(albumArtist, album, score),
  );
  ipcMain.handle(
    'library:get-album-rating',
    async (_e, albumArtist: string, album: string) => library.getAlbumRating(albumArtist, album),
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
    void syncRadioBrain();
    // Turning exclusive mode off releases the WASAPI device immediately so
    // system audio (and the Web Audio path) come back without a restart.
    if (patch && typeof patch === 'object' && (patch as Partial<AppSettings>).bitPerfectExclusive === false) {
      exclusiveOutput?.stop();
    }
    return updated;
  });

  // ---- Bit-Perfect Exclusive output (native WASAPI, Windows) ----------------
  ipcMain.handle('exclusive:supported', async () => getExclusiveOutput().available);
  ipcMain.handle('exclusive:list-devices', async () => getExclusiveOutput().listDevices());
  // Request-ordering guard: resolveExclusiveSource awaits a metadata probe, so
  // two rapid play requests can resolve OUT of order (track A's probe slower
  // than track B's) — without this, the STALE play would win and the audible
  // track would not match the UI.
  let exclusivePlaySeq = 0;
  ipcMain.handle('exclusive:play', async (_e, trackId: number, startAt?: number) => {
    const requestSeq = ++exclusivePlaySeq;
    try {
      const source = await resolveExclusiveSource(Math.trunc(Number(trackId)));
      if (requestSeq !== exclusivePlaySeq) return { ok: false, error: 'Superseded by a newer play request.' };
      if (!source) return { ok: false, error: 'Track not found or not playable.' };
      const deviceId = settings.get().bitPerfectExclusiveDeviceId;
      const result = await getExclusiveOutput().play(source, Number(startAt) || 0, deviceId);
      return { ok: true, chained: result.chained, negotiated: result.negotiated };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('exclusive:pause', async () => getExclusiveOutput().pause());
  ipcMain.handle('exclusive:resume', async () =>
    getExclusiveOutput().resume(settings.get().bitPerfectExclusiveDeviceId),
  );
  ipcMain.handle('exclusive:stop', async () => getExclusiveOutput().stop());
  ipcMain.handle('exclusive:seek', async (_e, seconds: number) =>
    getExclusiveOutput().seek(Number(seconds) || 0),
  );
  ipcMain.handle('exclusive:prepare-next', async (_e, trackId: number | null) => {
    if (trackId == null) {
      getExclusiveOutput().prepareNext(null);
      return;
    }
    const source = await resolveExclusiveSource(Math.trunc(Number(trackId)));
    getExclusiveOutput().prepareNext(source);
  });

  ipcMain.handle('radio-brain:status', async () => {
    if (!radioBrain) return { enabled: false, port: settings.get().radioBrainPort, baseUrl: null, endpoints: [], startedAt: null, error: null };
    return radioBrain.status();
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
  // --- Visualizer capture / share ---------------------------------------
  // capturePage works for every visualizer mode (including the sandboxed
  // Butterchurn iframe and the WebGL2 particle field) because it reads the
  // composited page, not a single canvas' drawing buffer.
  ipcMain.handle(
    'media:capture-page',
    async (_e, rect?: { x: number; y: number; width: number; height: number }) => {
      if (!mainWin) return null;
      const image =
        rect && rect.width > 1 && rect.height > 1
          ? await mainWin.webContents.capturePage({
              x: Math.max(0, Math.round(rect.x)),
              y: Math.max(0, Math.round(rect.y)),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            })
          : await mainWin.webContents.capturePage();
      return image.isEmpty() ? null : image.toDataURL();
    },
  );
  // Deck Snapshot (compact player polaroid). Captures the composited compact
  // window — the compact deck IS the main window resized (win:set-compact), so
  // capturePage reads exactly what the user sees for every registered deck
  // skin, whatever native size it reshaped the window to. The renderer prints
  // the polaroid frame around it (src/lib/deck-snapshot.ts) and reuses
  // media:copy-png / media:save-capture for delivery.
  ipcMain.handle('deck:snapshot', async () => {
    if (!mainWin) return null;
    const image = await mainWin.webContents.capturePage();
    return image.isEmpty() ? null : image.toDataURL();
  });
  ipcMain.handle('media:copy-png', async (_e, dataUrl: string) => {
    const image = nativeImage.createFromDataURL(String(dataUrl ?? ''));
    if (image.isEmpty()) return false;
    clipboard.writeImage(image);
    return true;
  });
  ipcMain.handle(
    'media:save-capture',
    async (_e, payload: { base64: string; defaultName: string; filterName: string; ext: string }) => {
      const buf = Buffer.from(String(payload?.base64 ?? ''), 'base64');
      if (!buf.length) return null;
      const ext = String(payload?.ext || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
      const opts = {
        title: 'Save capture',
        defaultPath: `${safeFileStem(payload?.defaultName || 'NewAmp')}.${ext}`,
        filters: [{ name: payload?.filterName || ext.toUpperCase(), extensions: [ext] }],
      };
      const result = mainWin ? await dialog.showSaveDialog(mainWin, opts) : await dialog.showSaveDialog(opts);
      if (result.canceled || !result.filePath) return null;
      await writeFile(result.filePath, buf);
      return result.filePath;
    },
  );

  // WebM (VP9/Opus, the renderer's only encode stack) → shareable MP4
  // (H.264/AAC via bundled ffmpeg — NVENC first, libx264 fallback). Used by
  // Clip Studio and Wrapped Live.
  ipcMain.handle(
    'video:save-clip',
    async (_e, payload: { base64: string; defaultName: string; vertical?: boolean; maxHeight?: number }) => {
      const buf = Buffer.from(String(payload?.base64 ?? ''), 'base64');
      if (!buf.length) return null;
      const opts = {
        title: 'Save clip',
        defaultPath: `${safeFileStem(payload?.defaultName || 'NewAmp Clip')}.mp4`,
        filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
      };
      const result = mainWin ? await dialog.showSaveDialog(mainWin, opts) : await dialog.showSaveDialog(opts);
      if (result.canceled || !result.filePath) return null;
      await finishWebmToMp4(buf, result.filePath, {
        vertical: payload?.vertical === true,
        maxHeight: typeof payload?.maxHeight === 'number' ? payload.maxHeight : undefined,
      });
      return result.filePath;
    },
  );

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
    // Now that settings.json writes are debounced/async, a pending write on
    // the old store could otherwise land after restoreSupportBackup replaces
    // the file — flush it out first so that race can't happen.
    settings?.flushSync();
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
      // An auth failure is not retryable, but the play still has to be kept:
      // dropping it here would lose every scrobble made while the session key
      // is dead, and with nothing queued the outbox could never report that a
      // reconnect is needed. Queue it so it survives and stays visible.
      if (shouldRetryLastfmError(err) || isLastfmAuthFailure(err)) {
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
  ipcMain.handle('win:set-fullscreen', (_e, on: boolean) => {
    mainWin?.setFullScreen(!!on);
  });
  ipcMain.handle('win:is-fullscreen', () => mainWin?.isFullScreen() ?? false);
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

  // detached visualizer window
  ipcMain.handle('detached-viz:list-displays', () => listDetachedDisplays());
  ipcMain.handle('detached-viz:open', (_e, opts?: { displayId?: number; fullscreen?: boolean }) => {
    openDetachedVisualizer(opts ?? {});
  });
  ipcMain.handle('detached-viz:close', () => {
    closeDetachedVisualizer();
  });
  ipcMain.handle('detached-viz:move-to-display', (_e, displayId: number) => {
    moveDetachedVisualizerToDisplay(Math.trunc(Number(displayId)));
  });
  ipcMain.handle('detached-viz:set-fullscreen', (_e, on: boolean) => {
    setDetachedVisualizerFullscreen(Boolean(on));
  });
  ipcMain.handle('detached-viz:toggle-fullscreen', () => toggleDetachedVisualizerFullscreen());
  ipcMain.handle('detached-viz:is-fullscreen', () => isDetachedVisualizerFullscreen());
  // Transport commands originate in the detached projector window's floating
  // control bar. They are forwarded to the MAIN window's renderer because that
  // is where the AudioEngine + store live; the projector is a pure consumer.
  // Caps the surface: only known verbs reach the renderer.
  ipcMain.handle('transport:command', (_e, cmd: string, arg?: number) => {
    if (!TRANSPORT_CMDS.has(cmd)) return;
    if (!mainWin || mainWin.isDestroyed()) return;
    mainWin.webContents.send('transport:command', { cmd, arg });
  });
  ipcMain.handle('detached-viz:is-open', () =>
    Boolean(detachedVizWin && !detachedVizWin.isDestroyed()),
  );
  // Deterministic port handshake: fires when the detached renderer's
  // 'eviland:frame-port' listener is provably installed (it sends this from
  // its entry module), so the MessagePort can never be dropped by an
  // evaluation race. Guarded: only honor the signal from the actual detached
  // window's webContents.
  ipcMain.on('detached-viz:renderer-ready', (event) => {
    if (!detachedVizWin || detachedVizWin.isDestroyed()) return;
    if (event.sender !== detachedVizWin.webContents) return;
    wireDetachedFramePort();
  });

  // Playback snapshot from the main renderer → Windows thumbar + tray tooltip.
  // Sender-guarded like the other renderer-originated signals.
  ipcMain.on('playback:state', (event, state: unknown) => {
    if (!mainWin || mainWin.isDestroyed() || event.sender !== mainWin.webContents) return;
    if (!state || typeof state !== 'object') return;
    const s = state as {
      isPlaying?: unknown;
      title?: unknown;
      artist?: unknown;
      album?: unknown;
      trackId?: unknown;
      position?: unknown;
      duration?: unknown;
      volume?: unknown;
    };
    const num = (value: unknown, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    applyShellPlaybackState({
      isPlaying: s.isPlaying === true,
      title: typeof s.title === 'string' && s.title.trim() ? s.title : null,
      artist: typeof s.artist === 'string' && s.artist.trim() ? s.artist : null,
      album: typeof s.album === 'string' && s.album.trim() ? s.album : null,
      trackId: typeof s.trackId === 'number' && Number.isFinite(s.trackId) ? s.trackId : null,
      position: Math.max(0, num(s.position, 0)),
      duration: Math.max(0, num(s.duration, 0)),
      volume: Math.min(2, Math.max(0, num(s.volume, 0.75))),
      at: Date.now(),
    });
  });
}

async function runExclusiveUiSmoke(win: BrowserWindow, scanPromise: Promise<void>): Promise<void> {
  try {
    await Promise.race([
      scanPromise,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for exclusive UI smoke scan')), 15000),
      ),
    ]);
    await reloadForSmoke(win);
    const result = await Promise.race([
      win.webContents.executeJavaScript(exclusiveUiProbeSource(), true),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for exclusive UI probe')), 25000),
      ),
    ]);
    console.log(`[newamp-exclusive-ui-smoke] ${JSON.stringify(result)}`);
    isQuitting = true;
    app.quit();
  } catch (err) {
    console.error('[newamp-exclusive-ui-smoke] failed:', err);
    app.exit(1);
  }
}

function exclusiveUiProbeSource(): string {
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
          .find((item) => /Exclusive Smoke/.test(item.textContent || '')),
      );
      row.scrollIntoView({ block: 'center' });
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      // The native path must actually engage — not fall back silently.
      await waitFor(
        'exclusive path active',
        () => (window.__newampSmoke?.exclusiveInfo?.().active === true ? true : null),
        12000,
      );
      const info = window.__newampSmoke.exclusiveInfo();
      // Position must advance from the native framesRendered counter.
      await waitFor('exclusive clock advancement', () => {
        const el = document.querySelector('[data-newamp-current-time]');
        return Number(el?.getAttribute('data-newamp-current-time') || '0') > 0.8 ? true : null;
      }, 10000);
      // The Web Audio graph is silent in exclusive mode, so ANY analyser
      // energy proves the 30Hz native PCM tap -> AnalyserNode emulation path.
      let fftSum = 0;
      for (let i = 0; i < 40 && fftSum === 0; i++) {
        fftSum = window.__newampSmoke.analyserFftSum();
        if (fftSum === 0) await sleep(100);
      }
      const currentTime = Number(
        document.querySelector('[data-newamp-current-time]')?.getAttribute('data-newamp-current-time') || '0',
      );
      const playing = !!document.querySelector('[data-newamp-transport][data-newamp-playing="true"]');
      return {
        ok: true,
        exclusiveActive: info.active,
        negotiated: info.negotiated,
        fallbackReason: info.fallbackReason,
        currentTime,
        playing,
        fftSum,
      };
    })()
  `;
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
        // 60s — needs headroom for butterchurn shader compilation + Liquid
        // Mercury setup on top of the existing preset battery. Was 20s
        // before, which assumed canvas-2D only.
        setTimeout(() => reject(new Error('Timed out waiting for UI visualizer probe')), 60000),
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

// Detached projector gate: plays a fixture in the REAL app, proves scrubbing
// lands (production protocol + engine + store stack, not a harness replica),
// opens the detached visualizer, and asserts the projector (a) completes the
// renderer-ready port handshake, (b) renders frames, and (c) actually paints
// non-black pixels (capturePage) — the literal "black screen" regression.
async function runUiDetachedVizSmoke(win: BrowserWindow, scanPromise: Promise<void>): Promise<void> {
  const phase = (name: string): void => console.log(`[newamp-ui-detached-viz-smoke-phase] ${name}`);
  try {
    phase('scan');
    await Promise.race([
      scanPromise,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for detached viz smoke scan')), 15000),
      ),
    ]);
    phase('reload');
    await Promise.race([
      reloadForSmoke(win),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for smoke reload')), 30000),
      ),
    ]);
    phase('playback-probe');

    // Phase 1 (main window): play the fixture, then scrub it and read the REAL
    // engine playhead after the smoke bridge's 1s pinned clock expires.
    const playback = (await Promise.race([
      win.webContents.executeJavaScript(uiDetachedPlaybackProbeSource(), true),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for detached viz playback probe')), 45000),
      ),
    ])) as { title: string; scrubTarget: number; scrubLanded: number };

    // Phase 2: open the projector and wait for its self-reported stats.
    phase('open-projector');
    openDetachedVisualizer({});
    let stats: unknown;
    try {
      stats = await waitForDetachedStats(30000);
    } catch (err) {
      // Diagnose the producer side before failing: is the MAIN renderer's rAF
      // alive, and what does the page think its visibility is?
      const mainDiag = await win.webContents.executeJavaScript(
        `(async () => {
          const start = performance.now();
          let frames = 0;
          await new Promise((done) => {
            const tick = () => { frames++; if (performance.now() - start < 2000) requestAnimationFrame(tick); else done(); };
            requestAnimationFrame(tick);
            setTimeout(done, 2500);
          });
          return {
            rafPerSec: Math.round(frames / 2),
            visibility: document.visibilityState,
            hidden: document.hidden,
            producer: window.__newampProducerDiag ?? null,
          };
        })()`,
        true,
      ).catch((diagErr) => ({ diagFailed: String(diagErr) }));
      throw new Error(`${(err as Error).message} | mainRendererDiag: ${JSON.stringify(mainDiag)}`);
    }

    // Phase 2.5: wait (bounded) for MilkDrop to mount or fail over. The full
    // preset catalog takes a few seconds to parse; on an occluded window its
    // timers are throttled so this can stay "booting" — proceed regardless
    // and let the runner judge the final state.
    phase('milkdrop-wait');
    {
      const start = Date.now();
      while (Date.now() - start < 20000) {
        if (!detachedVizWin || detachedVizWin.isDestroyed()) break;
        try {
          const s = (await detachedVizWin.webContents.executeJavaScript('window.__newampDetachedStats', true)) as {
            bcMounted?: boolean;
            bcFailed?: boolean;
            webglFallback?: boolean;
          };
          if (s?.bcMounted || s?.bcFailed || s?.webglFallback) break;
        } catch {
          /* booting */
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    // Phase 3: give butterchurn a beat to paint, then capture real pixels.
    phase('capture');
    await new Promise((r) => setTimeout(r, 3000));
    if (!detachedVizWin || detachedVizWin.isDestroyed()) {
      throw new Error('detached window disappeared before capture');
    }
    // capturePage waits for a compositor frame and HANGS FOREVER when the
    // window is occluded (e.g. the user's other windows cover the smoke run).
    // Raise the window, race the capture, and fall back to an in-renderer
    // readback of the reactor-overlay 2D canvas — which paints regardless of
    // compositor frames because the whole pipeline is timer/message driven.
    try {
      detachedVizWin.moveTop();
      detachedVizWin.focus();
    } catch {
      /* window manager refused; the fallback still proves pixels */
    }
    await new Promise((r) => setTimeout(r, 400));
    const shot = await Promise.race([
      detachedVizWin.webContents.capturePage(),
      new Promise<null>((r) => setTimeout(() => r(null), 8000)),
    ]);
    let capture: { width: number; height: number; lit: number; sampled: number; litFraction: number; source: string };
    if (shot) {
      const { width, height } = shot.getSize();
      const bitmap = shot.toBitmap(); // BGRA
      let lit = 0;
      let sampled = 0;
      for (let i = 0; i < bitmap.length; i += 64) {
        const lum = (bitmap[i] ?? 0) + (bitmap[i + 1] ?? 0) + (bitmap[i + 2] ?? 0);
        if (lum > 36) lit += 1;
        sampled += 1;
      }
      capture = { width, height, lit, sampled, litFraction: sampled ? lit / sampled : 0, source: 'capturePage' };
    } else {
      capture = (await detachedVizWin.webContents.executeJavaScript(
        `(() => {
          const c = document.getElementById('reactor-overlay');
          const ctx = c.getContext('2d');
          const { width, height } = c;
          const d = ctx.getImageData(0, 0, Math.max(1, width), Math.max(1, height)).data;
          let lit = 0, sampled = 0;
          for (let i = 0; i < d.length; i += 64) {
            if ((d[i] + d[i + 1] + d[i + 2]) > 36 && d[i + 3] > 0) lit++;
            sampled++;
          }
          return { width, height, lit, sampled, litFraction: sampled ? lit / sampled : 0, source: 'reactor-overlay-readback' };
        })()`,
        true,
      )) as typeof capture;
    }
    const finalStats = await detachedVizWin.webContents.executeJavaScript('window.__newampDetachedStats', true);

    const result = {
      ok: true,
      ...playback,
      detached: finalStats,
      firstStats: stats,
      capture,
    };
    console.log(`[newamp-ui-detached-viz-smoke] ${JSON.stringify(result)}`);
    isQuitting = true;
    app.quit();
  } catch (err) {
    console.error('[newamp-ui-detached-viz-smoke] failed:', err);
    app.exit(1);
  }
}

async function waitForDetachedStats(timeoutMs: number): Promise<unknown> {
  const start = Date.now();
  let last: unknown = null;
  while (Date.now() - start < timeoutMs) {
    if (detachedVizWin && !detachedVizWin.isDestroyed()) {
      try {
        last = await detachedVizWin.webContents.executeJavaScript('window.__newampDetachedStats', true);
        const stats = last as { portAttached?: boolean; framesRendered?: number } | null;
        if (stats?.portAttached && (stats.framesRendered ?? 0) > 30) return stats;
      } catch {
        /* window still booting */
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`detached projector never reached 30 rendered frames; last stats: ${JSON.stringify(last)}`);
}

function uiDetachedPlaybackProbeSource(): string {
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
      const row = await waitFor('detached smoke track row', () =>
        Array.from(document.querySelectorAll('[data-newamp-track-row]'))
          .find((item) => /Detached Smoke/.test(item.textContent || '')),
      );
      row.scrollIntoView({ block: 'center' });
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      await waitFor('detached smoke playback', () => {
        const transport = document.querySelector('[data-newamp-transport][data-newamp-playing="true"]');
        const title = document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
        return transport && /Detached Smoke/.test(title) ? transport : null;
      });
      await waitFor('time advancement', () => window.__newampSmoke.engineCurrentTime() > 0.5, 8000);
      // Scrub proof on the production stack: seek to 20s, wait out the smoke
      // bridge's 1s pinned clock, then read the REAL media-element playhead.
      // A restart-on-seek regression reads ~1.7s here; a working seek ~20.5s.
      const scrubTarget = 20;
      window.__newampSmoke.seek(scrubTarget);
      await sleep(1700);
      const scrubLanded = window.__newampSmoke.engineCurrentTime();
      if (!(scrubLanded > scrubTarget - 3 && scrubLanded < scrubTarget + 5)) {
        throw new Error('scrub failed: target=' + scrubTarget + ' landed=' + scrubLanded);
      }
      const title = document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
      return { title, scrubTarget, scrubLanded: Number(scrubLanded.toFixed(2)) };
    })()
  `;
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

async function runUiDiscoverSmoke(win: BrowserWindow): Promise<void> {
  try {
    const result = await Promise.race([
      win.webContents.executeJavaScript(uiDiscoverProbeSource(), true),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI Discover probe')), 20000),
      ),
    ]);
    console.log(`[newamp-ui-discover-smoke] ${JSON.stringify(result)}`);
    isQuitting = true;
    app.quit();
  } catch (err) {
    console.error('[newamp-ui-discover-smoke] failed:', err);
    app.exit(1);
  }
}

async function runScreenshotGallery(win: BrowserWindow, scanPromise: Promise<void>): Promise<void> {
  try {
    await Promise.race([
      scanPromise,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for screenshot gallery scan')), 20000),
      ),
    ]);
    await reloadForSmoke(win);
    win.setResizable(true);
    win.setMinimumSize(980, 640);
    win.setSize(1440, 940, true);
    win.center();
    win.show();
    win.focus();

    const screenshotDir = process.env.NEWAMP_SCREENSHOT_DIR
      ? resolve(process.env.NEWAMP_SCREENSHOT_DIR)
      : join(appRoot, 'assets', 'screenshots');
    mkdirSync(screenshotDir, { recursive: true });

    const files: string[] = [];
    const captured: unknown[] = [];
    const capture = async (filename: string, action: string): Promise<void> => {
      const result = await Promise.race([
        win.webContents.executeJavaScript(screenshotGalleryActionSource(action), true),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error(`Timed out preparing screenshot ${filename}`)), 20000),
        ),
      ]);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
      const image = await win.webContents.capturePage();
      const outPath = join(screenshotDir, filename);
      await writeFile(outPath, image.toPNG());
      files.push(relative(appRoot, outPath).replace(/\\/g, '/'));
      captured.push(result);
    };

    // Scripted mode: when NEWAMP_SCREENSHOT_PLAN points at a JSON file of
    // { file, action } steps (see scripts/craft-matrix.mjs), run that plan
    // through the same shot harness instead of the built-in gallery list.
    const planPath = process.env.NEWAMP_SCREENSHOT_PLAN;
    if (planPath) {
      const plan = JSON.parse(readFileSync(resolve(planPath), 'utf8')) as Array<{
        file: string;
        action: string;
      }>;
      for (const [index, step] of plan.entries()) {
        await capture(step.file, step.action);
        console.log(`[newamp-screenshot-plan] ${index + 1}/${plan.length} ${step.file}`);
      }
      console.log(`[newamp-screenshot-gallery] ${JSON.stringify({ ok: true, files, captured })}`);
      isQuitting = true;
      app.quit();
      return;
    }

    await capture(
      'feature-home-deerhoof.png',
      "await shot.playTrack('Dummy Discards A Heart'); await shot.go('Home'); await shot.sleep(1000); return shot.summary('home');",
    );
    await capture(
      'feature-albums-wilco.png',
      "await shot.playTrack('I Am Trying to Break Your Heart'); await shot.go('Albums'); await shot.sleep(900); return shot.summary('albums');",
    );
    await capture(
      'feature-now-playing-hella.png',
      "await shot.playTrack('Biblical Violence'); await shot.go('Now Playing'); await shot.sleep(900); return shot.summary('now-playing');",
    );
    await capture(
      'feature-library-dave-brubeck.png',
      "await shot.playTrack('Take Five'); await shot.go('Library'); await shot.sleep(800); return shot.summary('library');",
    );
    await capture(
      'visualizer-tempo-pulse-deerhoof.png',
      "await shot.playAndVisualize('Dummy Discards A Heart', 'tempo-pulse'); return shot.summary('visualizer-tempo-pulse');",
    );
    await capture(
      'visualizer-lattice-strobe-wilco.png',
      "await shot.playAndVisualize('I Am Trying to Break Your Heart', 'lattice-strobe'); return shot.summary('visualizer-lattice-strobe');",
    );
    await capture(
      'visualizer-aurora-hella.png',
      "await shot.playAndVisualize('Biblical Violence', 'aurora'); return shot.summary('visualizer-aurora');",
    );
    await capture(
      'visualizer-spectrum-dave-brubeck.png',
      "await shot.playAndVisualize('Take Five', 'spectrum'); return shot.summary('visualizer-spectrum');",
    );

    console.log(`[newamp-screenshot-gallery] ${JSON.stringify({ ok: true, files, captured })}`);
    isQuitting = true;
    app.quit();
  } catch (err) {
    console.error('[newamp-screenshot-gallery] failed:', err);
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

function screenshotGalleryActionSource(action: string): string {
  return `
    (async () => {
      const shot = (() => {
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
        const resetScroll = () => {
          window.scrollTo(0, 0);
          if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
          document.querySelectorAll('*').forEach((item) => {
            item.scrollTop = 0;
            item.scrollLeft = 0;
          });
        };
        const go = async (label) => {
          const button = await waitFor(label + ' navigation', () =>
            Array.from(document.querySelectorAll('button'))
              .find((item) => (item.textContent || '').toLowerCase().includes(label.toLowerCase())),
          );
          button.click();
          await sleep(450);
          resetScroll();
          return button;
        };
        const closeVisualizer = async () => {
          window.__newampSmoke?.setFullscreenVisualizer?.(false);
          await sleep(250);
        };
        const playTrack = async (needle) => {
          await closeVisualizer();
          await go('Library');
          const row = await waitFor('track row ' + needle, () =>
            Array.from(document.querySelectorAll('[data-newamp-track-row]'))
              .find((item) => (item.textContent || '').includes(needle)),
            15000,
          );
          row.scrollIntoView({ block: 'center' });
          row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
          await waitFor('current track ' + needle, () => {
            const title = document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
            return title.includes(needle) ? title : null;
          }, 10000);
          await sleep(700);
          return row;
        };
        const openVisualizer = async (preset) => {
          const opener = await waitFor('visualizer opener', () =>
            Array.from(document.querySelectorAll('[data-newamp-open-visualizer]'))
              .find((item) => (item.textContent || '').trim() === 'VIZ') ||
            document.querySelector('[data-newamp-open-visualizer]'),
          );
          opener.click();
          const stage = await waitFor('fullscreen visualizer stage', () =>
            document.querySelector('[data-newamp-fullscreen-visualizer]'),
          );
          // 2.x moved presets into a popover — open the picker before the
          // preset buttons exist in the DOM.
          const pickerToggle = await waitFor('preset picker toggle', () =>
            document.querySelector('[data-newamp-viz-preset-picker-toggle]'),
          );
          pickerToggle.click();
          const presetButton = await waitFor('visualizer preset ' + preset, () =>
            Array.from(document.querySelectorAll('[data-newamp-viz-preset-button]'))
              .find((item) => item.getAttribute('data-newamp-viz-preset-button') === preset),
          );
          presetButton.click();
          await waitFor('visualizer preset state ' + preset, () =>
            stage.getAttribute('data-newamp-visualizer-preset') === preset,
          );
          await waitFor('visualizer canvas ' + preset, () =>
            stage.querySelector('[data-newamp-visualizer-canvas]'),
          );
          await sleep(1000);
          return stage;
        };
        const playAndVisualize = async (needle, preset) => {
          await playTrack(needle);
          return openVisualizer(preset);
        };
        const openDeck = async (skin) => {
          await closeVisualizer();
          window.__newampSmoke?.setCompactDeck?.(true);
          await waitFor('compact deck', () =>
            document.querySelector('.compact-root, .deck-winamp-classic, .deck-record-player, .deck-jukebox, .deck-cassette, .deck-discman, .deck-retro-tv'),
          );
          const select = await waitFor('deck skin select', () =>
            document.querySelector('[data-newamp-deck-skin-select]'),
          );
          select.value = skin;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          await waitFor(skin + ' deck', () =>
            document.querySelector('.compact-root, .deck-winamp-classic, .deck-record-player, .deck-jukebox, .deck-cassette, .deck-discman, .deck-retro-tv'),
          );
          await sleep(700);
          return document.querySelector('.compact-root, .deck-winamp-classic, .deck-record-player, .deck-jukebox, .deck-cassette, .deck-discman, .deck-retro-tv');
        };
        const summary = (surface) => ({
          ok: true,
          surface,
          title: document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '',
          preset: document.querySelector('[data-newamp-fullscreen-visualizer]')?.getAttribute('data-newamp-visualizer-preset') || null,
          bodyText: (document.body.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
        });
        return { sleep, waitFor, go, playTrack, playAndVisualize, openDeck, summary };
      })();
      ${action}
    })()
  `;
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
      // Substring match. The transport Next button title carries the
      // keyboard hint, so a strict title="Next" selector never matched.
      // Anchor on the prefix instead.
      const nextButton = await waitFor('transport next button', () =>
        document.querySelector('[data-newamp-transport] button[title^="Next"]'),
      );
      nextButton.click();
      await sleep(450);
      const afterTerminalNextTitle =
        document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
      const afterTerminalNextTime = Number(
        document.querySelector('[data-newamp-current-time]')?.getAttribute('data-newamp-current-time') || '0',
      );
      return {
        ok: true,
        currentTitle,
        currentTime,
        afterTerminalNextTitle,
        afterTerminalNextTime,
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
      // Preset buttons live inside the collapsible picker panel; picking a
      // preset closes it, so reopen via the toolbar toggle before each pick.
      const openPresetPanel = async () => {
        if (document.querySelector('[data-newamp-viz-preset-button]')) return;
        const toggle = await waitFor('preset picker toggle', () =>
          document.querySelector('[data-newamp-viz-preset-picker-toggle]'),
        );
        toggle.click();
      };
      await openPresetPanel();
      const spectrumButton = await waitFor('Spectrum visualizer preset button', () =>
        Array.from(document.querySelectorAll('[data-newamp-viz-preset-button]'))
          .find((item) => item.getAttribute('data-newamp-viz-preset-button') === 'spectrum'),
      );
      spectrumButton.click();
      const sampleCanvas = (canvas) => {
        const width = canvas.width;
        const height = canvas.height;
        if (width < 120 || height < 80) return null;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const gl = context ? null : (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
        const data = new Uint8Array(width * height * 4);
        if (context) data.set(context.getImageData(0, 0, width, height).data);
        else if (gl) gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        else return null;
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
      await openPresetPanel();
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
      await openPresetPanel();
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
      await openPresetPanel();
      const orbitalButton = await waitFor('Orbital Rings visualizer preset button', () =>
        Array.from(document.querySelectorAll('[data-newamp-viz-preset-button]'))
          .find((item) => item.getAttribute('data-newamp-viz-preset-button') === 'orbital-rings'),
      );
      orbitalButton.click();
      await waitFor('orbital-rings visualizer stage', () =>
        stage.getAttribute('data-newamp-visualizer-preset') === 'orbital-rings',
      );
      const orbitalCanvas = await waitFor('orbital-rings canvas', () =>
        stage.querySelector('[data-newamp-visualizer-canvas][data-newamp-visualizer-mode="orbital-rings"]'),
      );
      const orbitalRender = await waitFor('nonblank orbital-rings visualizer frame', () => sampleCanvas(orbitalCanvas), 8000);
      await openPresetPanel();
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
      // Verify Milkdrop (butterchurn) actually mounts without a CSP eval
      // failure. We CAN'T reliably check non-zero pixels in software-WebGL
      // (which the smoke runs under via disable-hardware-acceleration);
      // shader presets compile and link differently on SwiftShader. The
      // production check is "does butterchurn boot without the CSP error
      // that previously bombed it?" — we verify that by capturing console
      // errors and asserting no eval-policy failures fire.
      await openPresetPanel();
      const milkdropButton = await waitFor('Milkdrop visualizer preset button', () =>
        Array.from(document.querySelectorAll('[data-newamp-viz-preset-button]'))
          .find((item) => item.getAttribute('data-newamp-viz-preset-button') === 'butterchurn'),
      );
      const consoleErrors = [];
      const originalError = console.error;
      console.error = function (...args) {
        const text = args.map(String).join(' ');
        consoleErrors.push(text);
        return originalError.apply(console, args);
      };
      milkdropButton.click();
      await waitFor('butterchurn visualizer stage', () =>
        stage.getAttribute('data-newamp-visualizer-preset') === 'butterchurn',
      );
      const milkdropCanvas = await waitFor('butterchurn canvas', () =>
        stage.querySelector('[data-newamp-visualizer-canvas][data-newamp-visualizer-mode="butterchurn"]'),
      );
      // Give butterchurn 4s to compile shaders + load a preset, then check
      // for CSP/eval failures. Pixel output is best-effort.
      await sleep(4000);
      console.error = originalError;
      const milkdropEvalError = consoleErrors.find((line) =>
        /unsafe-eval|EvalError|Evaluating a string as JavaScript|butterchurn failed to start/.test(line),
      );
      // Try to sample pixels, but don't require — software WebGL may not
      // render butterchurn shaders even when the code itself works.
      let milkdropRender = null;
      const sampleStart = Date.now();
      while (Date.now() - sampleStart < 5000) {
        const sample = sampleCanvas(milkdropCanvas);
        if (sample) { milkdropRender = sample; break; }
        await sleep(120);
      }
      // Positive boot signal — Visualizer.tsx sets this attribute the
      // moment butterchurn.createVisualizer + connectAudio succeed. The
      // older smoke only proved that NO eval error fired, which a silently
      // gated catch could fake; this distinguishes "really mounted" from
      // "canvas alive but factory threw".
      const milkdropMounted = milkdropCanvas.getAttribute('data-newamp-butterchurn-mounted');
      // Frame-delta check: a "mounted=true" flag set BEFORE the render
      // loop runs is not enough to prove butterchurn is actually
      // producing frames — that's exactly how 1.5.5 shipped a dead
      // visualizer. Two-pronged check:
      //
      // 1. Sample litSamples 4 times across ~1.2s. Hardware-accelerated
      //    butterchurn produces non-zero pixels here; software WebGL
      //    (which the smoke runs under) drops shader paint and returns
      //    zero pixels regardless of render-loop liveness. So this
      //    succeeds on Tyler's hardware but never on the smoke.
      // 2. Sample the engine's FFT sum twice ~600ms apart. This is the
      //    actually load-bearing signal — the silent-sink fix exists to
      //    make these bytes non-zero. If the analyser subtree is alive
      //    (silentSink wired, audio flowing) the sum is non-zero;
      //    1.5.3-era graph culling produced zero here.
      //
      // milkdropAlive = either condition passes. The smoke asserts on
      // the OR, so it works under software WebGL (FFT signal) AND
      // catches a future regression that breaks butterchurn but not the
      // audio path (pixel signal).
      const milkdropFrameSamples = [];
      for (let i = 0; i < 4; i++) {
        const sample = sampleCanvas(milkdropCanvas);
        milkdropFrameSamples.push(sample ? sample.litSamples : 0);
        await sleep(380);
      }
      const milkdropFrameDeltas = [];
      for (let i = 1; i < milkdropFrameSamples.length; i++) {
        milkdropFrameDeltas.push(Math.abs(milkdropFrameSamples[i] - milkdropFrameSamples[i - 1]));
      }
      const analyserFftSamples = [];
      for (let i = 0; i < 3; i++) {
        const fn = window.__newampSmoke?.analyserFftSum;
        analyserFftSamples.push(typeof fn === 'function' ? fn() : 0);
        await sleep(300);
      }
      const pixelsAlive =
        milkdropFrameSamples.some((s) => s > 0) ||
        milkdropFrameDeltas.some((d) => d > 0);
      const analyserAlive = analyserFftSamples.some((s) => s > 0);
      const milkdropAlive = pixelsAlive || analyserAlive;
      // Now Liquid Mercury — the new 1.5.2 preset. Verify it renders too.
      await openPresetPanel();
      const mercuryButton = await waitFor('Liquid Mercury visualizer preset button', () =>
        Array.from(document.querySelectorAll('[data-newamp-viz-preset-button]'))
          .find((item) => item.getAttribute('data-newamp-viz-preset-button') === 'liquid-mercury'),
      );
      mercuryButton.click();
      await waitFor('liquid-mercury visualizer stage', () =>
        stage.getAttribute('data-newamp-visualizer-preset') === 'liquid-mercury',
      );
      const mercuryCanvas = await waitFor('liquid-mercury canvas', () =>
        stage.querySelector('[data-newamp-visualizer-canvas][data-newamp-visualizer-mode="liquid-mercury"]'),
      );
      const mercuryRender = await waitFor('nonblank liquid-mercury visualizer frame', () => sampleCanvas(mercuryCanvas), 8000);
      // The per-control toolbar buttons were consolidated into the Settings
      // panel; each control's contract is now its keyboard shortcut, so the
      // probe drives the same path a user's fingers do.
      const pressKey = (key) => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      };
      pressKey('q');
      await waitFor('4K visualizer quality state', () =>
        stage.getAttribute('data-newamp-visualizer-quality') === '4k',
      );
      const appliedQuality = stage.getAttribute('data-newamp-visualizer-quality');
      pressKey('l');
      await waitFor('low-end visualizer state', () =>
        stage.getAttribute('data-newamp-visualizer-performance') === 'low' &&
        stage.getAttribute('data-newamp-visualizer-quality') === 'auto',
      );
      pressKey('l');
      await waitFor('balanced visualizer state', () =>
        stage.getAttribute('data-newamp-visualizer-performance') === 'balanced',
      );
      if (stage.getAttribute('data-newamp-visualizer-art') === 'hidden') pressKey('a');
      await waitFor('art pulse armed state', () =>
        ['armed', 'pulse'].includes(stage.getAttribute('data-newamp-visualizer-art') || ''),
      );
      // Native (OS) fullscreen is not observable under the smoke's hidden
      // window: the renderer flips optimistically but main pushes the real
      // window state back, which can never be fullscreen with windowsHide.
      // The F-key wiring is covered by the keyboard-shortcuts smoke instead.
      pressKey('h');
      await waitFor('clean visualizer chrome state', () =>
        stage.getAttribute('data-newamp-visualizer-chrome') === 'clean',
      );
      pressKey('p');
      await waitFor('visualizer palette state', () =>
        stage.getAttribute('data-newamp-visualizer-palette') !== 'theme',
      );
      pressKey('r');
      await waitFor('visualizer reactivity state', () =>
        stage.getAttribute('data-newamp-visualizer-reactivity') !== 'punch',
      );
      pressKey('v');
      await waitFor('auto VJ enabled state', () =>
        stage.getAttribute('data-newamp-visualizer-auto-vj') === 'on',
      );
      // Auto-hide nav contract: moving the cursor away from the top edge
      // hides the toolbar after the hide delay (1.4s in product). Moving
      // the cursor back into the reveal band (<=110px from the top) makes
      // it visible again. The persistent "TOP NAV" storage toggle was
      // removed — auto-hide is the only mode now, and it must always be
      // recoverable from cursor movement alone.
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 700, bubbles: true }));
      await waitFor('top navigation hides on cursor idle', () =>
        stage.getAttribute('data-newamp-visualizer-nav') === 'hidden',
        4000,
      );
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 40, bubbles: true }));
      await waitFor('top navigation reappears on hover', () =>
        stage.getAttribute('data-newamp-visualizer-nav') === 'visible',
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
        const deck = document.querySelector('.compact-root, .deck-winamp-classic, .deck-record-player, .deck-jukebox, .deck-cassette, .deck-discman, .deck-retro-tv');
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
          orbitalRings: orbitalRender,
        },
        auroraRender,
        milkdropRender,
        milkdropEvalError: milkdropEvalError ?? null,
        milkdropMounted: milkdropMounted ?? null,
        milkdropFrameSamples,
        milkdropFrameDeltas,
        analyserFftSamples,
        milkdropAlive,
        mercuryRender,
        stageRect: { width: stageRect.width, height: stageRect.height },
        viewport,
        openedViaVizButton: true,
        openedViaTransportArt: true,
        compactClearsFullscreen: true,
        qualityToggle: appliedQuality,
        artToggle: stage.getAttribute('data-newamp-visualizer-art'),
        screenToggle: true,
        chromeMode: stage.getAttribute('data-newamp-visualizer-chrome'),
        palette: stage.getAttribute('data-newamp-visualizer-palette'),
        reactivityMode: stage.getAttribute('data-newamp-visualizer-reactivity'),
        autoVjMode: stage.getAttribute('data-newamp-visualizer-auto-vj'),
        navMode: stage.getAttribute('data-newamp-visualizer-nav'),
        performanceMode: stage.getAttribute('data-newamp-visualizer-performance'),
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
        rootWidth: Math.round((document.querySelector('.compact-root, .deck-winamp-classic, .deck-record-player, .deck-jukebox, .deck-cassette, .deck-discman, .deck-retro-tv')?.getBoundingClientRect().width || 0)),
        rootHeight: Math.round((document.querySelector('.compact-root, .deck-winamp-classic, .deck-record-player, .deck-jukebox, .deck-cassette, .deck-discman, .deck-retro-tv')?.getBoundingClientRect().height || 0)),
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
      await pickSkin('discman');
      await waitFor('discman deck', () => document.querySelector('.deck-discman'));
      const discman = await waitFor('discman size', () => {
        const box = measure();
        return Math.abs(box.width - 620) <= 12 && Math.abs(box.height - 460) <= 12 ? box : null;
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
      const finalSelect = await waitFor('final deck skin select', () => document.querySelector('[data-newamp-deck-skin-select]'));
      const finalPicker = finalSelect.closest('[data-newamp-deck-skin-picker]');
      const selectAppRegion = getComputedStyle(finalSelect).webkitAppRegion || '';
      const pickerAppRegion = finalPicker ? getComputedStyle(finalPicker).webkitAppRegion || '' : '';
      return {
        ok: true,
        openedViaDeckButton: true,
        visibleSkinButtons: document.querySelectorAll('[data-newamp-deck-skin-select] option').length,
        selectAppRegion,
        pickerAppRegion,
        shade,
        record,
        discman,
        tv,
        winamp,
        shadeAgain,
      };
    })()
  `;
}

function uiDiscoverProbeSource(): string {
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
      const discoverButton = await waitFor('Discover navigation', () =>
        Array.from(document.querySelectorAll('button'))
          .find((item) => (item.textContent || '').includes('Discover')),
      );
      discoverButton.click();
      const view = await waitFor('Discover view', () => document.querySelector('[data-newamp-discover]'), 12000);
      const mission = await waitFor('Discover mission', () =>
        document.querySelector('[data-newamp-discover-mission]'),
      );
      const saveButton = await waitFor('Discover save button', () =>
        document.querySelector('[data-newamp-discover-save]'),
      );
      const stepAction = await waitFor('Discover step action', () =>
        document.querySelector('[data-newamp-discover-step-action]'),
      );
      const fullVisButton = await waitFor('Discover full visualizer button', () =>
        document.querySelector('[data-newamp-discover-full-vis]'),
      );
      const deckButton = await waitFor('Discover deck button', () =>
        document.querySelector('[data-newamp-discover-deck]'),
      );
      saveButton.click();
      await waitFor('Discover save status', () => /Saved /.test(view.textContent || '') ? view : null);
      return {
        ok: true,
        missionCount: document.querySelectorAll('[data-newamp-discover-mission]').length,
        trackRows: document.querySelectorAll('[data-newamp-track-row]').length,
        hasSave: !!saveButton,
        hasStepAction: !!stepAction,
        hasFullVisualizer: !!fullVisButton,
        hasDeck: !!deckButton,
        missionText: (mission.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 180),
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
      const karaokeStage = await waitFor('fullscreen karaoke stage', () =>
        document.querySelector('[data-newamp-karaoke-fullscreen]'),
      );
      const karaokeSizeSlider = await waitFor('karaoke text-size slider', () =>
        karaokeStage.querySelector('[data-newamp-karaoke-size-slider]'),
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
        karaokeFullscreen: !!karaokeStage,
        karaokeSize: Number(karaokeSizeSlider.value || '0'),
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
  // settings:skin-import-file is wired to app-wide drag/drop, but it's also
  // exposed directly on window.newamp, so any renderer script can call it
  // with an arbitrary path — validate before touching the filesystem.
  assertSkinImportPathAllowed(skinPath);
  const info = await stat(skinPath);
  if (!info.isFile()) throw new Error('Skin path must be a file.');
  if (info.size > MAX_SKIN_IMPORT_FILE_BYTES) throw new Error('Skin file is too large.');
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
    icon: resolveWindowIconPath(),
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

async function analyzeTracksDna(ids: number[]): Promise<{ analyzed: number; skipped: string[]; total: number }> {
  const tracks = resolveExportTracks(ids);
  // Decode-then-FFT is mostly IO-bound on the ffmpeg side, so 3 concurrent
  // workers gives a real 2.5× speedup on multi-core machines without
  // saturating low-end laptops. Above 3 we hit diminishing returns and
  // start to contend with playback if the user is listening while batching.
  const CONCURRENCY = 3;
  let cursor = 0;
  let analyzed = 0;
  const skipped: string[] = [];
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= tracks.length) return;
      const track = tracks[idx]!;
      try {
        const dna = await analyzeTrackDna(track.path);
        if (library.setTrackDna(track.id, dna)) analyzed += 1;
        else skipped.push(`${track.artist} - ${track.title}: not updated`);
      } catch (err) {
        skipped.push(`${track.artist} - ${track.title}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tracks.length) }, () => worker()));
  return { analyzed, skipped, total: tracks.length };
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
  // Authorize before any scan/lookup so playback can never race the allowlist.
  await Promise.all(
    targets.filter((target) => target.kind === 'file').map((target) => allowOpenedAudioFile(target.path)),
  );
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

async function flushLastfmOutbox(): Promise<LastfmOutboxFlushResult> {
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

  // Auto-seed the default library root from the first existing platform
  // candidate when nothing is configured (macOS: ~/Music + /Volumes/*; Windows:
  // K:/C: drive paths).
  const current = settings.get();
  if (!smokeMode && !current.libraryRoots.length) {
    const candidates = process.platform === 'darwin'
      ? [app.getPath('music'), ...safeListMacVolumesMusic()]
      : ['K:/music', 'K:\\music', 'C:/Music', 'C:/Users/Public/Music'];
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
  registerDisplayWatchers();

  createStartupSplashWindow();
  mainWin = createWindow();
  installApplicationMenu();
  registerTray();
  registerMediaShortcuts();
  syncLibraryWatcher();

  // If the main renderer reloads (crash recovery, dev hot-reload) while a
  // detached visualizer window is open, the old MessageChannel port dies with
  // the previous renderer and the projector feed would go permanently static.
  // Re-issue a fresh port pair on every (re)load so the feed resumes. No-op on
  // the initial load (no detached window yet) and when nothing is detached.
  mainWin.webContents.on('did-finish-load', () => {
    if (!detachedVizWin || detachedVizWin.isDestroyed()) return;
    wireDetachedFramePort();
  });

  // Auto-scan on launch if the library is empty and roots are configured
  mainWin.webContents.once('did-finish-load', () => {
    // This runs before the window is ever shown, so anything that throws here
    // escapes as an uncaught exception and kills the app with no window and no
    // dialog — it just never opens. Treat an unreadable library as an empty one
    // and let the auto-scan below rebuild it.
    let trackCount = 0;
    try {
      trackCount = library.getStats().tracks;
    } catch (err) {
      writeDiagnosticEvent('library-stats-unavailable', { error: String(err) });
    }
    const roots = settings.get().libraryRoots;
    let scanPromise = Promise.resolve();
    if (roots.length && (trackCount === 0 || settings.get().libraryAutoWatch)) {
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
    } else if (uiDetachedVizSmoke && mainWin) {
      void runUiDetachedVizSmoke(mainWin, scanPromise);
    } else if (uiDeckSmoke && mainWin) {
      void runUiDeckSmoke(mainWin);
    } else if (uiArtSmoke && mainWin) {
      void runUiArtSmoke(mainWin, scanPromise);
    } else if (uiDiscoverSmoke && mainWin) {
      void runUiDiscoverSmoke(mainWin);
    } else if (exclusiveUiSmoke && mainWin) {
      void runExclusiveUiSmoke(mainWin, scanPromise);
    } else if (screenshotGallery && mainWin) {
      void runScreenshotGallery(mainWin, scanPromise);
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
  // A crashed GPU process means hardware acceleration is unstable on this
  // machine. Drop the recovery sentinel so the next launch falls back to
  // software rendering instead of crash-looping on the GPU.
  if (details.type === 'GPU' && !smokeMode) {
    try {
      writeFileSync(gpuCrashSentinel, `${new Date().toISOString()} ${details.reason}\n`, 'utf8');
    } catch {
      /* best effort */
    }
  }
});

app.on('render-process-gone', (_event, webContents, details) => {
  writeDiagnosticEvent('app-render-process-gone', {
    url: webContents.getURL(),
    details,
  });
});

// Explicit AppUserModelID (matches build.appId / the NSIS shortcut) so the
// Windows taskbar groups NewAmp windows under our identity and resolves the
// icon from our shortcut instead of a stale shell-cache entry.
if (process.platform === 'win32') {
  app.setAppUserModelId('io.newamp.player');
}

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
  closeStartupSplashWindow();
  libraryWatcher?.stop();
  exclusiveOutput?.dispose();
  tray?.destroy();
  tray = null;
  // No orphan ffmpeg.exe should outlive the app.
  killAllDnaFfmpeg();
  killAllTranscodeFfmpeg();
});

app.on('window-all-closed', () => {
  if (shouldStayResidentOnWindowAllClosed({ isQuitting, hasTray: !!tray, platform: process.platform })) return;
  scanner?.cancel();
  library?.close();
  settings?.flushSync();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWin && !mainWin.isDestroyed()) {
    showMainWindow();
  } else {
    mainWin = createWindow();
  }
});
