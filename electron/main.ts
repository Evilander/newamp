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
  powerMonitor,
  powerSaveBlocker,
  protocol,
  screen,
  session,
  shell,
  dialog,
  Tray,
  type Display,
  type MenuItemConstructorOptions,
  type Rectangle,
} from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { LibraryStore, LibraryUnavailableError } from './library.js';
import { IncrementalScanGate, LibraryWatcher, type LibraryWatchPlan } from './library-watcher.js';
import { findEmbeddedLyricsForTrack, findSidecarLyricsForTrack } from './local-lyrics.js';
import { SettingsStore, withAiAssistRuntime } from './settings.js';
import { readTrackFile, Scanner } from './scanner.js';
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
  resolvePlaybackMode,
  stopFfmpegReading,
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
import { authorizeAudioProtocolPath } from './audio-protocol-authorize.js';
import { closeAllGaplessSessions, registerGaplessTransport, releaseGaplessPaths } from './gapless-transport.js';
import { analyzeTrackDna, killAllDnaFfmpeg } from './dna-analyzer.js';
import { emptyAnalysisProgress } from '../shared/analysis.js';
import type { AnalysisQueue } from './analysis-queue.js';
import { createLibraryAnalysis } from './analysis-service.js';
import { killAllAnalysisFfmpeg } from './track-analyzer.js';
import { getSongScore, initScoreCache, killAllScoreFfmpeg } from './score-analyzer.js';
import { cancelWaveformWork, getWaveform, initWaveformCache, killAllWaveformFfmpeg } from './waveform-peaks.js';
import { RadioBrain } from './radio-brain.js';
import { ExclusiveOutput, classifyTrackSource } from './exclusive-output.js';
import { isFfmpegFallbackExtension } from '../shared/audio-quality.js';
import { exportPlaylistFolder } from './playlist-export.js';
import { createDailyBackupIfDue, createSupportBackup, listDailyBackups, restoreSupportBackup } from './support-backup.js';
import { generateOpenAiLinerNotes } from './openai-assist.js';
import {
  assertSkinImportPathAllowed,
  isWinampClassicSkinArchiveName,
  MAX_SKIN_IMPORT_FILE_BYTES,
  parseWinampClassicSkinArchive,
} from './winamp-skin-import.js';
import { createPlaylistCoverGuard } from './playlist-cover-guard.js';
import { trackContextMenuTemplate } from './track-context-menu.js';
import { moveTracksToTrash, trashableTracks } from './trash-tracks.js';
import {
  closeAction,
  crashRecoveryAction,
  revealWhenReady,
  shouldBlockDisplaySleep,
  shouldExplainTrayClose,
  shouldLeaveCompact,
  shouldStayResidentOnWindowAllClosed,
  trayCloseNotice,
} from './window-lifecycle-policy.js';
import { emptyWindowState, nextWindowState, placeOrigin, placeWindow, type WindowRect } from './window-state.js';
import { installPermissionHandlers } from './permissions.js';
import { choosePortableDataDir } from './portable-data.js';
import { createOpenFileBatcher, mergeHandedOff, type HandedOffFiles } from './open-file-batcher.js';
import { cueAudioPaths, cueEntriesToTracks, parseCueSheet, type CueSheetEntry } from './cue.js';
import { defaultMusicScanRoots, isSeededPublicMusicRoot, suggestMusicFolders } from './music-folders.js';
import { parseCustomSkinFile, serializeCustomSkin } from '../shared/custom-skin.js';
import { buildAppMenuTemplate } from './app-menu.js';
import { assertHistoryImportIdle, registerHistoryImportIpc } from './history-ipc.js';
import { registerMusicServerIpc } from './music-server-ipc.js';
import type { MusicServerRegistry } from './music-servers.js';
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
  TrackContextMenuChoice,
  TrackContextMenuRequest,
  TrashProgress,
  TrashTracksResult,
  ScanProgress,
  SupportBackupResult,
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
const uiQueueEditSmoke = process.env.NEWAMP_UI_QUEUE_EDIT_SMOKE === '1';
const uiLyricsSmoke = process.env.NEWAMP_UI_LYRICS_SMOKE === '1';
const uiOpenFileSmoke = process.env.NEWAMP_UI_OPEN_FILE_SMOKE === '1';
const uiVisualizerSmoke = process.env.NEWAMP_UI_VISUALIZER_SMOKE === '1';
const uiDetachedVizSmoke = process.env.NEWAMP_UI_DETACHED_VIZ_SMOKE === '1';
const uiDeckSmoke = process.env.NEWAMP_UI_DECK_SMOKE === '1';
const uiWheelVolumeSmoke = process.env.NEWAMP_UI_WHEEL_VOLUME_SMOKE === '1';
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
  uiQueueEditSmoke ||
  uiLyricsSmoke ||
  uiOpenFileSmoke ||
  uiVisualizerSmoke ||
  uiDetachedVizSmoke ||
  uiDeckSmoke ||
  uiWheelVolumeSmoke ||
  uiArtSmoke ||
  uiDiscoverSmoke ||
  exclusiveUiSmoke ||
  screenshotGallery;
// Smokes play real audio to prove the clock moves and track changes are clean,
// and nobody at the machine needs to hear the test tones. Muted, Chromium
// still renders and times the audio; it just never reaches the speakers.
// NEWAMP_SMOKE_AUDIBLE=1 to listen in.
if (smokeMode && process.env.NEWAMP_SMOKE_AUDIBLE !== '1') app.commandLine.appendSwitch('mute-audio');
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

// The portable build's wrapper exports the folder the exe sits in. Data goes
// beside it only when no profile exists in the default location yet, so users
// of earlier portable builds keep the library they already have.
const portableExecutableDir = process.env.PORTABLE_EXECUTABLE_DIR;
const portableDataDecision =
  portableExecutableDir && !userDataOverride && !smokeMode
    ? choosePortableDataDir(portableExecutableDir, app.getPath('userData'), {
        exists: existsSync,
        canWrite: canWriteDirectory,
      })
    : null;
if (portableDataDecision?.dir) app.setPath('userData', portableDataDecision.dir);
if (portableDataDecision) {
  console.log(`[newamp] portable data: ${portableDataDecision.reason}, userData=${app.getPath('userData')}`);
}

const sessionData = sessionDataOverride
  ? resolve(sessionDataOverride)
  : userDataOverride || smokeMode || portableDataDecision?.dir
    ? resolve(app.getPath('userData'), 'session-data')
    : process.platform === 'win32' && (process.env.LOCALAPPDATA || process.env.APPDATA)
      ? resolve(process.env.LOCALAPPDATA || process.env.APPDATA!, 'NewAmp', 'session-data')
      : resolve(app.getPath('userData'), 'session-data');
mkdirSync(sessionData, { recursive: true });
app.setPath('sessionData', sessionData);
app.commandLine.appendSwitch('disk-cache-dir', join(sessionData, 'Cache'));
// The first enumerateDevices() call (the output-device picker, device-change
// handling) otherwise starts a separate Video Capture utility process, about
// 65 MB private for the life of the session. NewAmp never opens a camera.
// Measured on Windows only; other platforms are left alone. A capture driver
// that misbehaves inside the main process can be kept out of it again with
// NEWAMP_VIDEO_CAPTURE_OUT_OF_PROCESS=1.
if (process.platform === 'win32' && process.env.NEWAMP_VIDEO_CAPTURE_OUT_OF_PROCESS !== '1') {
  appendEnabledFeature('RunVideoCaptureServiceInBrowserProcess');
}

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

if (portableDataDecision) {
  writeDiagnosticEvent('portable-data-location', {
    reason: portableDataDecision.reason,
    portableExecutableDir,
    userData: app.getPath('userData'),
  });
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

// appendSwitch replaces a switch that is already set, so a value passed on
// the command line would be lost; merge instead.
function appendEnabledFeature(feature: string): void {
  const existing = app.commandLine.getSwitchValue('enable-features');
  const features = existing ? existing.split(',').filter(Boolean) : [];
  if (!features.includes(feature)) features.push(feature);
  app.commandLine.appendSwitch('enable-features', features.join(','));
}

function canWriteDirectory(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-test-${process.pid}`);
    writeFileSync(probe, '');
    rmSync(probe);
    return true;
  } catch {
    return false;
  }
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
  // With the GPU off, Windows still gets WebGL through Direct3D's software
  // rasterizer, but macOS and Linux only have SwiftShader, which Chromium
  // withholds without this switch: MilkDrop and the projector's WebGL layer
  // then fail to start instead of running slowly.
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
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
// True from entering the deck until leaving it. The renderer asks for
// set-compact(false) on every load, which must not move or resize a window
// that never went compact.
let inCompact = false;
// True from opening straight into the deck until the renderer first asks for
// it. Its first render asks for the normal window before the saved compact
// mode has loaded; that request changes nothing while this is set.
let startupCompactPending = false;
let windowStateTimer: NodeJS.Timeout | null = null;
let displaySleepBlockerId: number | null = null;
let dockPlayingLabel: boolean | null = null;
let pinnedAcrossSpaces = false;
let mainWindowRevealed = false;
let tray: Tray | null = null;
let startupSplashWin: BrowserWindow | null = null;
let startupSplashStartedAt = 0;
let isQuitting = false;
let library: LibraryStore;
let musicServers: MusicServerRegistry;
let settings: SettingsStore;
let scanner: Scanner;
let libraryWatcher: LibraryWatcher;
let lastfmOutbox: LastfmScrobbleOutbox;
let podcastStore: PodcastStore;
let radioBrain: RadioBrain | null = null;
// Serializes calls into syncRadioBrain() so an enable/port/reload change
// that arrives while a previous one is still (dis)connecting can't race it
// into starting two servers or stranding one on an abandoned port.
let radioBrainSyncChain: Promise<void> = Promise.resolve();
let radioBrainShutdownStarted = false;
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

// Session opened-files allowlist for the `newamp:` protocol. Every
// open-file entry point (CLI argv, macOS open-file event, second-instance
// argv, drag-drop via the open:files IPC) registers its targets so
// the protocol handler can serve them even when they live outside the library.
const openedAudioFiles = new Set<string>();
// Lazily realpathed podcast downloads root. Cached on first success only —
// the directory does not exist until the first download completes, and a
// cached null would 403 podcast playback forever.
let podcastDownloadsRealRoot: string | null = null;

// Both spellings of an opened file are authorized. The renderer asks for the
// path it was handed, and the first check compares that as written, before
// anything touches the disk or network; the second compares the real path.
// A file opened through a symlink or junction (macOS /tmp is /private/tmp)
// only matches the first check by the path it was opened as.
async function allowOpenedAudioFile(path: string): Promise<void> {
  openedAudioFiles.add(resolve(path).replace(/\\/g, '/'));
  try {
    openedAudioFiles.add((await realpath(path)).replace(/\\/g, '/'));
  } catch {
    /* vanished/unreadable — the request 404s at the existence check */
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
// The splash covers the gap until the main window can paint, not a fixed
// beat: it closes as soon as the window is ready, but never sooner than this
// after it opened so it does not flash.
const STARTUP_SPLASH_MIN_MS = 600;
const WINDOW_STATE_SAVE_DEBOUNCE_MS = 500;
const DEFAULT_WINDOW_SIZE = { width: 1280, height: 820 };
const startupSplashEnabled = !smokeMode && process.env.NEWAMP_DISABLE_STARTUP_SPLASH !== '1';

function workAreas(): WindowRect[] {
  return screen.getAllDisplays().map((display) => ({ ...display.workArea }));
}

interface StartupWindowGeometry {
  bounds: { x?: number; y?: number; width: number; height: number };
  minWidth: number;
  minHeight: number;
  maximize: boolean;
}

// Where the main window opens: its last spot if that display is still
// connected, the default size otherwise. A relaunch into the deck opens at the
// deck's last spot and remembers the normal window to return to. Smokes keep
// the fixed default so their layout checks never depend on an earlier run.
function startupWindowGeometry(): StartupWindowGeometry {
  const fallback: StartupWindowGeometry = {
    bounds: { ...DEFAULT_WINDOW_SIZE },
    minWidth: NORMAL_LIMITS.minWidth,
    minHeight: NORMAL_LIMITS.minHeight,
    maximize: false,
  };
  if (smokeMode || !settings) return fallback;
  const current = settings.get();
  const saved = current.windowState ?? emptyWindowState();
  const areas = workAreas();
  const normal = placeWindow(saved.normal, areas, NORMAL_LIMITS);
  if (!current.compactMode) {
    return { ...fallback, bounds: normal, maximize: saved.maximized };
  }
  if (normal.x === undefined || normal.y === undefined) return { ...fallback, bounds: normal };
  normalBounds = { x: normal.x, y: normal.y, width: normal.width, height: normal.height };
  normalWasMaximized = saved.maximized;
  startupCompactPending = true;
  if (!saved.deck) return { ...fallback, bounds: normal };
  // The window opens deck-sized, so size changes before the renderer asks for
  // the deck must not be recorded as the normal window.
  inCompact = true;
  const deck = placeWindow(saved.deck, areas, DECK_LIMITS);
  return { bounds: deck, minWidth: DECK_LIMITS.minWidth, minHeight: DECK_LIMITS.minHeight, maximize: false };
}

function isWindowFullScreen(win: BrowserWindow): boolean {
  return win.isFullScreen() || (process.platform === 'darwin' && win.isSimpleFullScreen());
}

function persistWindowState(win: BrowserWindow): void {
  if (smokeMode || restoreInProgress || win.isDestroyed()) return;
  const prev = settings.get().windowState ?? emptyWindowState();
  const next = nextWindowState(prev, {
    compact: inCompact,
    maximized: win.isMaximized(),
    fullscreen: isWindowFullScreen(win),
    minimized: win.isMinimized(),
    bounds: win.getBounds(),
    normalBounds: win.getNormalBounds(),
  });
  if (next) settings.set({ windowState: next });
}

function scheduleWindowStateSave(win: BrowserWindow): void {
  if (smokeMode) return;
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    windowStateTimer = null;
    persistWindowState(win);
  }, WINDOW_STATE_SAVE_DEBOUNCE_MS);
  windowStateTimer.unref?.();
}

function flushWindowState(win: BrowserWindow): void {
  if (!windowStateTimer) return;
  clearTimeout(windowStateTimer);
  windowStateTimer = null;
  persistWindowState(win);
}

// hide() on a window in native macOS fullscreen leaves an empty Space behind,
// so leave fullscreen first. The visualizer hides the traffic lights while it
// is fullscreen and only restores them on its own way out, which this skips.
function hideMainWindow(win: BrowserWindow): void {
  if (process.platform === 'darwin') {
    if (win.isSimpleFullScreen()) {
      win.setSimpleFullScreen(false);
      win.setWindowButtonVisibility(!inCompact);
    }
    if (win.isFullScreen()) {
      win.once('leave-full-screen', () => {
        if (win.isDestroyed()) return;
        win.setWindowButtonVisibility(!inCompact);
        win.hide();
      });
      win.setFullScreen(false);
      return;
    }
  }
  win.hide();
}

let trayCloseNoticeOpen = false;

// The first X on Windows and Linux hides the window with nothing to say the
// app is still running. Say it once, before hiding, and let the user quit
// right there if that was what they meant. The flag is stored before the
// dialog opens so dismissing it any way counts as having seen it.
async function explainTrayClose(win: BrowserWindow): Promise<void> {
  trayCloseNoticeOpen = true;
  settings.set({ trayNoticeShown: true });
  const notice = trayCloseNotice(process.platform);
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: notice.title,
      message: notice.message,
      detail: notice.detail,
      buttons: [notice.keepLabel, notice.quitLabel],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 1) {
      isQuitting = true;
      app.quit();
      return;
    }
  } catch (err) {
    console.warn('[newamp] tray close notice failed:', err);
  } finally {
    trayCloseNoticeOpen = false;
  }
  if (!win.isDestroyed()) hideMainWindow(win);
}

function leaveFullScreen(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'darwin' && win.isSimpleFullScreen()) {
      win.setSimpleFullScreen(false);
      resolve();
      return;
    }
    if (!win.isFullScreen()) {
      resolve();
      return;
    }
    let timer: NodeJS.Timeout | null = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      if (!win.isDestroyed()) win.off('leave-full-screen', done);
      resolve();
    };
    // The event is the signal, the timer only keeps a missed one from
    // stalling the deck switch.
    timer = setTimeout(done, 1500);
    win.on('leave-full-screen', done);
    win.setFullScreen(false);
  });
}

const DECK_LIMITS = { minWidth: 280, minHeight: 100, defaultWidth: 720, defaultHeight: 152 };
const NORMAL_LIMITS = {
  minWidth: 980,
  minHeight: 640,
  defaultWidth: DEFAULT_WINDOW_SIZE.width,
  defaultHeight: DEFAULT_WINDOW_SIZE.height,
};

// Sizes the main window into the deck, or puts it back. A fullscreen window
// leaves fullscreen first: on macOS the exit animation ignores a resize issued
// mid-flight, and the "normal" bounds would capture the fullscreen frame.
async function setCompactMode(on: boolean, size?: { width?: number; height?: number }): Promise<void> {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (on) startupCompactPending = false;
  if (isWindowFullScreen(mainWin)) await leaveFullScreen(mainWin);
  const win = mainWin;
  if (!win || win.isDestroyed()) return;
  if (on) {
    flushWindowState(win);
    // Capture the previous shape once on the way into deck mode. Tracking
    // the maximized state separately lets us correctly restore a maximized
    // window — previously this was lost and the window got stuck small.
    if (!normalBounds) {
      normalWasMaximized = win.isMaximized();
      normalBounds = normalWasMaximized
        ? win.getNormalBounds?.() ?? win.getBounds()
        : win.getBounds();
    }
    inCompact = true;
    if (win.isMaximized()) win.unmaximize();
    const width = Math.max(280, Math.min(1600, Math.trunc(Number(size?.width) || 720)));
    const height = Math.max(100, Math.min(1000, Math.trunc(Number(size?.height) || 152)));
    win.setResizable(true);
    // Allow shrinking the minimum to the deck's natural size so resize cannot
    // pad the chrome with empty border. Each skin owns its aspect ratio.
    win.setMinimumSize(Math.min(280, width), Math.min(100, height));
    const origin = smokeMode
      ? null
      : placeOrigin(settings.get().windowState?.deck, { width, height }, workAreas());
    if (origin) win.setBounds({ ...origin, width, height }, true);
    else win.setSize(width, height, true);
    win.setResizable(false);
    // The traffic lights would sit on top of each skin's own chrome.
    if (process.platform === 'darwin') win.setWindowButtonVisibility(false);
    // Always-on-top is the renderer's call (the Pin button), in both modes.
    return;
  }
  // The renderer asks for the normal window on every load; a window that never
  // went compact must stay exactly where the user left it.
  if (!shouldLeaveCompact({ inCompact, hasNormalBounds: !!normalBounds, startupPending: startupCompactPending })) return;
  flushWindowState(win);
  inCompact = false;
  win.setResizable(true);
  win.setMinimumSize(NORMAL_LIMITS.minWidth, NORMAL_LIMITS.minHeight);
  // Pull the window above the minimum first if it is currently smaller, then
  // restore. Without this, Electron silently grows it to (980,640) on
  // setMinimumSize and the subsequent setBounds can race with the resize.
  if (normalBounds) {
    // The display it came from may be gone by now.
    const placed = smokeMode ? normalBounds : placeWindow(normalBounds, workAreas(), NORMAL_LIMITS);
    if (placed.x !== undefined && placed.y !== undefined) {
      win.setBounds({ x: placed.x, y: placed.y, width: placed.width, height: placed.height }, true);
    } else {
      win.setSize(placed.width, placed.height, true);
      win.center();
    }
  } else {
    // Fallback for the edge case where deck mode was entered without a saved
    // pre-deck bounds (e.g. fresh app start in compactMode from settings).
    const display = screen.getDisplayMatching(win.getBounds()).workArea;
    const fallbackWidth = Math.min(1280, Math.max(980, display.width - 200));
    const fallbackHeight = Math.min(820, Math.max(640, display.height - 200));
    win.setSize(fallbackWidth, fallbackHeight, true);
    win.center();
  }
  if (normalWasMaximized) win.maximize();
  normalBounds = null;
  normalWasMaximized = false;
  if (process.platform === 'darwin') win.setWindowButtonVisibility(true);
}

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';
  inCompact = false;
  normalBounds = null;
  normalWasMaximized = false;
  startupCompactPending = false;
  const startup = startupWindowGeometry();
  const win = new BrowserWindow({
    ...startup.bounds,
    minWidth: startup.minWidth,
    minHeight: startup.minHeight,
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

  // ready-to-show, or on Linux a timer after the load when Wayland never sends it.
  revealWhenReady(win, () => {
    if (smokeMode) return;
    const reveal = () => {
      const splashWasUp = !!startupSplashWin;
      closeStartupSplashWindow();
      if (win.isDestroyed()) return;
      if (startup.maximize) win.maximize();
      win.show();
      win.focus();
      mainWindowRevealed = true;
      applyThumbarButtons(win);
      writeDiagnosticEvent('main-window-shown', { elapsedMs: Math.round(process.uptime() * 1000), splash: splashWasUp });
      if (openDevTools) win.webContents.openDevTools({ mode: 'detach' });
    };
    const remainingSplashMs = startupSplashWin
      ? Math.max(0, STARTUP_SPLASH_MIN_MS - (Date.now() - startupSplashStartedAt))
      : 0;
    if (remainingSplashMs > 0) setTimeout(reveal, remainingSplashMs);
    else reveal();
  }, { platform: process.platform });

  win.on('maximize', () => win.webContents.send('window-state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('window-state', { maximized: false }));
  // Hiding and showing can recreate the Windows taskbar button, which drops
  // the thumbnail toolbar; it is otherwise only refreshed on a playback
  // snapshot, and none arrives while paused.
  win.on('show', () => applyThumbarButtons(win));
  win.on('restore', () => applyThumbarButtons(win));
  win.on('resize', () => scheduleWindowStateSave(win));
  win.on('move', () => scheduleWindowStateSave(win));
  win.on('enter-full-screen', refreshDisplaySleepBlocker);
  win.on('leave-full-screen', refreshDisplaySleepBlocker);
  win.on('closed', () => {
    // A destroyed window drops the stale reference so `activate` recreates
    // cleanly instead of probing a dead one.
    if (mainWin === win) mainWin = null;
    if (windowStateTimer) {
      clearTimeout(windowStateTimer);
      windowStateTimer = null;
    }
    refreshDisplaySleepBlocker();
  });
  win.on('close', (event) => {
    if (smokeMode) return;
    flushWindowState(win);
    // User-configurable close behavior. Default keeps the app running with
    // the window hidden (tray on Windows/Linux, Dock on macOS); 'close-app'
    // quits the process so the X button matches what most desktop users
    // expect.
    const action = closeAction({
      platform: process.platform,
      hasTray: !!tray && !tray.isDestroyed(),
      isQuitting,
      isMinimized: win.isMinimized(),
      behavior: settings.get().closeButtonBehavior,
    });
    if (action === 'close') return;
    if (action === 'quit') {
      isQuitting = true;
      app.quit();
      return;
    }
    event.preventDefault();
    // The first-close notice is open over this window; a second X waits for it.
    if (trayCloseNoticeOpen) return;
    if (action === 'minimize') win.minimize();
    else if (shouldExplainTrayClose({ action, platform: process.platform, alreadyExplained: settings.get().trayNoticeShown === true })) {
      void explainTrayClose(win);
    } else hideMainWindow(win);
  });

  // A reload after a renderer crash or a hot reload gets a new page; the
  // projector's frame port died with the old one. This lives here rather than
  // in bootstrap so a window recreated later is rewired too.
  win.webContents.on('did-finish-load', () => {
    if (win.isMaximized()) win.webContents.send('window-state', { maximized: true });
    if (!detachedVizWin || detachedVizWin.isDestroyed()) return;
    wireDetachedFramePort();
  });

  // The main renderer owns the audio engine. Reload it from the saved resume
  // state instead of leaving a blank window that tray, thumbbar and media-key
  // commands keep talking to; stop after repeated failures.
  const crashReloads: number[] = [];
  win.webContents.on('render-process-gone', (_event, details) => {
    if (smokeMode || win.isDestroyed()) return;
    const now = Date.now();
    const action = crashRecoveryAction({ reason: details.reason, isQuitting, recentReloads: crashReloads, now });
    if (action === 'ignore') return;
    if (action === 'reload') {
      crashReloads.push(now);
      win.webContents.reload();
      return;
    }
    void dialog
      .showMessageBox(win, {
        type: 'error',
        title: 'NewAmp stopped working',
        message: 'The NewAmp window stopped working more than once in a minute.',
        detail: 'Your queue and position were saved. Quit and start NewAmp again, or try reloading the window.',
        buttons: ['Reload', 'Quit NewAmp'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 1) {
          isQuitting = true;
          app.quit();
        } else if (!win.isDestroyed()) {
          crashReloads.length = 0;
          win.webContents.reload();
        }
      });
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

  revealWhenReady(win, () => {
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
  }, { platform: process.platform });
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
  revealWhenReady(startupSplashWin, () => {
    if (!startupSplashWin || startupSplashWin.isDestroyed()) return;
    startupSplashWin.showInactive();
  }, { platform: process.platform });
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
  animation: logo-spin 600ms cubic-bezier(.18,.86,.18,1) both, logo-hold 12000ms ease both;
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

// How long after the renderer took the launch files a later batch still
// belongs to the same selection (see mergeHandedOff).
const COLD_START_MERGE_MS = 2000;
let handedOffFiles: HandedOffFiles | null = null;

// Opening several files at once reaches a running app as separate events: one
// second-instance per file from Explorer, one open-file per file on macOS.
// Gathering them lets the renderer replace its queue once with the whole
// selection instead of once per file. A file opened on its own therefore
// starts a moment after the open, not on the spot.
const openFileBatcher = createOpenFileBatcher({
  quietMs: 400,
  maxWaitMs: 2000,
  deliver: deliverOpenFiles,
});

function deliverOpenFiles(paths: string[]): void {
  if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isLoading()) {
    const merged = mergeHandedOff(paths, handedOffFiles, Date.now(), COLD_START_MERGE_MS);
    handedOffFiles = merged.handedOff;
    mainWin.webContents.send('app:open-files', merged.files);
    return;
  }
  const seen = new Set(pendingOpenFiles.map((path) => path.toLowerCase()));
  for (const path of paths) {
    const key = path.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      pendingOpenFiles.push(path);
    }
  }
}

function enqueueOpenFiles(paths: string[]): void {
  const clean = normalizeOpenTargets(paths).map((target) => target.path);
  if (!clean.length) return;
  for (const path of clean) void allowOpenedAudioFile(path);
  openFileBatcher.push(clean);
}

function buildDockMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'Previous', click: () => sendPlayerCommand('previous') },
    { label: shellPlaybackState.isPlaying ? 'Pause' : 'Play', click: () => sendPlayerCommand('toggle-play') },
    { label: 'Next', click: () => sendPlayerCommand('next') },
    { label: 'Stop', click: () => sendPlayerCommand('stop') },
  ]);
}

// The Dock menu is the macOS counterpart of the tray menu. Its Play/Pause
// label follows the playback snapshots, rebuilding only when it flips.
function refreshDockMenu(): void {
  if (process.platform !== 'darwin' || smokeMode || !app.dock) return;
  const playing = shellPlaybackState.isPlaying;
  if (dockPlayingLabel === playing) return;
  dockPlayingLabel = playing;
  app.dock.setMenu(buildDockMenu());
  // The Controls menu's Play/Pause item says the same thing.
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate()));
}

function refreshDisplaySleepBlocker(): void {
  if (smokeMode) return;
  const detachedShown =
    !!detachedVizWin && !detachedVizWin.isDestroyed() && detachedVizWin.isVisible() && !detachedVizWin.isMinimized();
  const mainFullScreen = !!mainWin && !mainWin.isDestroyed() && isWindowFullScreen(mainWin);
  const wanted = shouldBlockDisplaySleep({
    visualizerShown: detachedShown || mainFullScreen,
    isPlaying: shellPlaybackState.isPlaying,
  });
  const active = displaySleepBlockerId !== null && powerSaveBlocker.isStarted(displaySleepBlockerId);
  if (wanted && !active) {
    displaySleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  } else if (!wanted && displaySleepBlockerId !== null) {
    powerSaveBlocker.stop(displaySleepBlockerId);
    displaySleepBlockerId = null;
  }
}

function applicationMenuTemplate(): MenuItemConstructorOptions[] {
  // app.getName() is the package name ("newamp"), which also names the
  // userData folder, so it stays as it is; the menu and the About box show
  // the product name.
  return buildAppMenuTemplate(process.platform, {
    appName: 'NewAmp',
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    onPreferences: () => {
      const hadWindow = !!mainWin && !mainWin.isDestroyed();
      showMainWindow();
      const win = mainWin;
      if (!win || win.isDestroyed()) return;
      const send = (): void => win.webContents.send('app:open-settings');
      // A window recreated from the Dock has not loaded its renderer yet.
      if (hadWindow && !win.webContents.isLoading()) send();
      else win.webContents.once('did-finish-load', send);
    },
    onOpenExternal: (url) => void shell.openExternal(url),
    playback: { isPlaying: shellPlaybackState.isPlaying, onCommand: sendPlayerCommand },
  });
}

// Chromium leaves timers alone in a hidden window only while the page is
// audible. Bit-Perfect Exclusive plays outside the page, and a quiet stretch
// of a track (a hidden track's minutes of silence) also reads as silent, so
// with the window closed the 100 ms engine tick that prepares the next track,
// scrobbles and runs the sleep timer would drop to once a second, then once a
// minute. Throttling stays on while nothing plays.
let backgroundThrottlingFor: { id: number; on: boolean } | null = null;

function refreshBackgroundThrottling(): void {
  if (smokeMode || !mainWin || mainWin.isDestroyed()) return;
  const contents = mainWin.webContents;
  const on = !shellPlaybackState.isPlaying;
  if (backgroundThrottlingFor?.id === contents.id && backgroundThrottlingFor.on === on) return;
  backgroundThrottlingFor = { id: contents.id, on };
  contents.setBackgroundThrottling(on);
}

function installApplicationMenu(): void {
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: 'NewAmp',
      applicationVersion: app.getVersion(),
      // The bundle version is the same string; shown again it read "2.8.0 (2.8.0)".
      version: '',
      copyright: 'Copyright © 2026 NewAmp contributors. MIT License.',
      website: 'https://github.com/evilander/newamp',
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate()));
    dockPlayingLabel = null;
    refreshDockMenu();
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
  refreshDockMenu();
  refreshDisplaySleepBlocker();
  refreshBackgroundThrottling();
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
 *
 * Linux: the tarball has no desktop entry to take an icon from, so without
 * the PNG the taskbar, Alt-Tab and dock show a generic one.
 */
function resolveWindowIconPath(): string | undefined {
  if (process.platform === 'linux') return resolveLinuxWindowIconPath();
  return resolveTrayIconPath() ?? undefined;
}

function resolveLinuxWindowIconPath(): string | undefined {
  const candidates = [
    join(process.resourcesPath, 'build', 'icon.png'),
    join(app.getAppPath(), 'build', 'icon.png'),
  ];
  // The window manager reads a real file; it cannot open a path inside the asar.
  return candidates.find((candidate) => !candidate.includes('app.asar') && existsSync(candidate));
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
  // On Windows any global media key, even one that fails to register because
  // another app holds it, switches off Chromium's own media-key handling, and
  // that is what feeds the system media session (volume flyout, lock screen,
  // headset buttons). Playback there goes through a media element, so the keys
  // reach the page's mediaSession handlers without us. Bit-Perfect Exclusive
  // plays outside Chromium and keeps the global keys; the page's silent session
  // anchor stays off the media controls there, because the keys turn them off.
  if (process.platform === 'win32' && !settings.get().bitPerfectExclusive) return;
  // A Mac sends the keys (and AirPods, Control Center and the Touch Bar) to
  // the app that owns Now Playing. The page publishes a session in every
  // output mode, Bit-Perfect Exclusive included, so Chromium's own handling
  // covers it. Global media keys there need Accessibility trust, and with it
  // they would take F7-F9 from Music while NewAmp sits paused in the Dock.
  if (process.platform === 'darwin') return;
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

// Radio Brain settings fields — a settings:set patch only needs to poke the
// reconciler when one of these actually changed, not on every keystroke
// elsewhere in Settings.
const RADIO_BRAIN_SETTINGS_KEYS = ['radioBrainEnabled', 'radioBrainPort', 'radioBrainToken'] as const;

function patchTouchesRadioBrain(patch: unknown): boolean {
  if (!patch || typeof patch !== 'object') return false;
  return RADIO_BRAIN_SETTINGS_KEYS.some((key) => key in (patch as Record<string, unknown>));
}

// Funnels every enable/port/reload change through one chain so overlapping
// callers converge in order instead of racing separate syncRadioBrain() runs
// into starting or stopping the same server twice.
function queueRadioBrainSync(): Promise<void> {
  radioBrainSyncChain = radioBrainSyncChain.then(syncRadioBrain, syncRadioBrain);
  return radioBrainSyncChain;
}

async function syncRadioBrain(): Promise<void> {
  const current = settings.get();
  if (!current.radioBrainEnabled) {
    if (radioBrain) {
      const status = await radioBrain.stop();
      if (status.error) console.warn('[newamp] radio brain failed to stop cleanly:', status.error);
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
    const status = await radioBrain.start();
    if (status.error) console.warn('[newamp] radio brain failed to start:', status.error);
  }
}

const LIBRARY_WATCH_SETTINGS_KEYS = ['libraryRoots', 'libraryAutoWatch'] as const;

// The renderer saves the resume position every few seconds during playback;
// only folder and auto-watch changes should reach the watcher.
function patchTouchesLibraryWatch(patch: unknown): boolean {
  if (!patch || typeof patch !== 'object') return false;
  return LIBRARY_WATCH_SETTINGS_KEYS.some((key) => key in (patch as Record<string, unknown>));
}

// Views and pickers that list saved playlists refetch on this instead of
// holding whatever list they loaded when they mounted.
function notifyTracksRemoved(ids: number[]): void {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('library:tracks-removed', ids);
}

function notifyPlaylistsChanged(): void {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('playlists:changed');
}

function showTrackContextMenu(
  win: BrowserWindow | null,
  request: TrackContextMenuRequest,
): Promise<TrackContextMenuChoice | null> {
  return new Promise((resolveChoice) => {
    let chosen = false;
    const choose = (choice: TrackContextMenuChoice) => () => {
      chosen = true;
      resolveChoice(choice);
    };
    Menu.buildFromTemplate(trackContextMenuTemplate(request, choose)).popup({
      window: win ?? undefined,
      // Fires on close, which on Windows can come before the click handler.
      // A dismissal changes nothing on screen, so report it unhurried.
      callback: () => setTimeout(() => {
        if (!chosen) resolveChoice(null);
      }, 500),
    });
  });
}

// Chromium reports software compositing until the GPU process has finished
// starting, so the status only means something after 'gpu-info-update' (or a
// few seconds after launch, for setups where that event never fires).
let gpuCompositingSettled = false;

function publishGpuCompositing(): void {
  gpuCompositingSettled = true;
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('app:gpu-compositing', gpuCompositingEnabled());
}

// 'enabled' / 'enabled_on' mean the GPU composites; anything else
// ('disabled_software', 'unavailable_software', ...) is a software fallback.
function gpuCompositingEnabled(): boolean {
  try {
    const status = (app.getGPUFeatureStatus() as unknown as Record<string, string | undefined>).gpu_compositing;
    return !status || status.startsWith('enabled');
  } catch {
    return true;
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

// Works out tempo, key, loudness and Audio DNA for the whole library in the
// background (electron/analysis-queue.ts). Not started in smoke runs.
let libraryAnalysis: AnalysisQueue | null = null;

function startLibraryAnalysis(): void {
  if (smokeMode || libraryAnalysis) return;
  libraryAnalysis = createLibraryAnalysis({
    library: () => library,
    enabled: () => !settings.isSuppressed() && settings.get().backgroundAnalysis !== false,
    waveformsEnabled: () => settings.get().waveformSeekBar !== false,
    onBattery: () => powerMonitor.isOnBatteryPower(),
  });
  libraryAnalysis.start();
}

function createScannerService(store: LibraryStore): Scanner {
  return new Scanner(store, (p: ScanProgress) => {
    libraryAnalysis?.noteScan(p);
    // The cancel at quit ends with an event, after the window may be gone.
    if (!mainWin || mainWin.isDestroyed()) return;
    mainWin.webContents.send('library:scan-progress', p);
  });
}

// Held while a backup, a trash or a prune works on an in-memory snapshot, so
// a filesystem event that lands mid-capture doesn't kick off a rescan that
// mutates the library out from under it. Counts the holders: two can overlap
// (a trash during a backup), and the watcher stays held until the last one
// resumes. Reset in reloadRuntimeStores().
let libraryMutationsQuiesced = 0;
let restoreInProgress = false;
// Operations that take a backup and then change the stores (a user backup, a
// trash, a prune), counted the same way: a restore must not start while any
// is in flight, and the last one to finish lifts the hold.
let backupInProgress = 0;

// Root walks the watcher asks for; see IncrementalScanGate. Reads `scanner` at
// call time, so a swapped store is walked by its own scanner. A batch that was
// waiting when a backup or removal took hold is dropped, as a watcher flush
// landing then would be.
const incrementalScans = new IncrementalScanGate(async (targets) => {
  if (libraryMutationsQuiesced) return;
  await scanner.start(targets);
});

function createLibraryWatcherService(): LibraryWatcher {
  return new LibraryWatcher(
    (targets, plan) => {
      if (libraryMutationsQuiesced || !settings.get().libraryAutoWatch || !targets.length) return;
      void reconcileWatchedTargets(targets, plan);
    },
    {
      // A drive or share that comes back: an ordinary (incremental) scan of it
      // clears the missing marks its tracks got while it was away.
      onRootAvailable: (root) => {
        if (libraryMutationsQuiesced || !settings.get().libraryAutoWatch) return;
        incrementalScans.request([root]);
      },
    },
  );
}

// A watched path can vanish for a while without being deleted — editor
// save-by-rename, sync clients, remounts, network drives. Deleting what was
// gone destroyed the track with its history, ratings and playlist places, and
// the file came back as a new track with none of them. Absence is never
// permission to delete: whatever is still gone after a short re-check is only
// marked unavailable, and the rescan below clears the mark (same id) for
// anything that is back. Deleting stays an explicit user action.
const MISSING_RECHECK_DELAY_MS = 1500;

let watcherReconcile: Promise<void> = Promise.resolve();

// plan splits the targets: files and folder art the watcher named are read
// again whatever their size and date say, while a root whose event carried no
// name (the watcher overflowed during a bulk copy) is walked incrementally,
// so a large library is not re-parsed top to bottom for it.
function reconcileWatchedTargets(watched: string[], plan?: LibraryWatchPlan): Promise<void> {
  const run = watcherReconcile.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, MISSING_RECHECK_DELAY_MS));
    const stillMissing = watched.filter((target) => !existsSync(target));
    if (stillMissing.length) library.markTracksMissing(stillMissing);
    const targets = plan ? plan.force : watched;
    const incremental = plan ? plan.incremental : [];
    if (targets.length) void scanner.start(targets, { force: true });
    if (incremental.length) incrementalScans.request(incremental);
  });
  watcherReconcile = run.catch((err) => {
    console.warn(`[newamp] library watcher reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  return run;
}

// A track that predates tracked edits (still queued for adoption), or holds an
// edit whose file value isn't known yet, has its file read before a metadata
// edit or lookup lands on it, so the edit records what the file really says
// and "reset to file" has something to go back to. Outside the scan queue: a
// library scan can hold that for minutes. An unreadable file just means the
// file value stays unknown for now.
async function readTrackBeforeMetadataEdit(id: number): Promise<void> {
  const path = library.pathNeedingFileRead(id);
  if (!path) return;
  const reading = await readTrackFile(path);
  if (reading) library.upsertTracks([reading]);
}

// Quiesces the two automatic sources of library mutation — the watcher's
// reconcile and the scanner — before the support-backup coordinator captures
// an in-memory snapshot. Cancelling the scanner and immediately re-starting
// it with an empty root list is a way to await "whatever is currently
// running" without Scanner exposing that directly: start() always queues
// behind its internal scanQueue, so our empty-root call only resolves once
// anything already in flight (including one the reconcile just kicked off)
// has finished.
//
// A removal (a trash, a prune) holds only the watcher: its backup snapshot
// is synchronous and its deletes go by id, so a scan in progress carries on
// instead of being cancelled and never resumed.
async function quiesceLibraryMutations(options: { keepScan?: boolean } = {}): Promise<void> {
  libraryMutationsQuiesced += 1;
  await watcherReconcile.catch(() => {});
  if (options.keepScan) return;
  scanner?.cancel();
  await scanner?.start([]).catch(() => {});
}

function resumeLibraryMutations(): void {
  libraryMutationsQuiesced = Math.max(0, libraryMutationsQuiesced - 1);
}

// Builds a support backup from the live stores' in-memory state rather than
// from library.db/settings.json on disk — see createSupportBackup's
// librarySnapshot/settingsSnapshot for why that distinction matters. The
// 'library' scope is the automatic safety copy before a removal.
async function createBackupFromLiveStores(userData: string, scope: 'full' | 'library' = 'full'): Promise<SupportBackupResult> {
  // podcasts.json is copied straight off disk by createSupportBackup (it has
  // no in-memory snapshot input like settings/library do) — land any pending
  // debounced progress write first so the backup isn't up to ~800ms stale.
  podcastStore.flushProgressSync();
  return createSupportBackup({
    userDataPath: userData,
    settingsPath: join(userData, 'settings.json'),
    libraryPath: join(userData, 'library.db'),
    librarySnapshot: library.exportSnapshot(),
    settingsSnapshot: settings.snapshotJson(),
    scope,
  });
}

// The first look is a couple of minutes in, so a launch that is quickly closed
// again does no extra work, and then every few hours for a session that stays
// in the tray for days. createDailyBackupIfDue decides whether a copy is due.
const DAILY_BACKUP_FIRST_CHECK_MS = 2 * 60 * 1000;
const DAILY_BACKUP_CHECK_MS = 6 * 60 * 60 * 1000;

function scheduleDailyBackups(): void {
  if (smokeMode) return;
  setTimeout(() => void runDailyBackup(), DAILY_BACKUP_FIRST_CHECK_MS).unref();
  setInterval(() => void runDailyBackup(), DAILY_BACKUP_CHECK_MS).unref();
}

// The rolling copy of library.db and settings.json that is there when a bad
// write, a bad migration or a slip in a cleanup takes the library. Skips
// quietly while anything else is rewriting the stores, or when the library
// session is not the real one (a failed upgrade runs on a temporary library).
async function runDailyBackup(): Promise<void> {
  if (!settings.get().autoBackupEnabled) return;
  if (restoreInProgress || backupInProgress || library.isClosed() || library.upgradeError || settings.isSuppressed()) return;
  backupInProgress += 1;
  try {
    // Landing what is batched first proves the library can still be written
    // before it is copied; a failed flush throws and no copy is made.
    await library.flushPendingWrites();
    const userData = app.getPath('userData');
    const outcome = await createDailyBackupIfDue({
      userDataPath: userData,
      settingsPath: join(userData, 'settings.json'),
      libraryPath: join(userData, 'library.db'),
      snapshot: () => ({ librarySnapshot: library.exportSnapshot(), settingsSnapshot: settings.snapshotJson() }),
    });
    if (outcome.status === 'created') {
      writeDiagnosticEvent('daily-backup-created', { path: outcome.backup.backupPath });
    } else if (outcome.reason === 'invalid' || outcome.reason === 'low-disk') {
      writeDiagnosticEvent('daily-backup-skipped', { reason: outcome.reason, detail: outcome.detail });
    }
  } catch (err) {
    console.warn('[newamp] daily backup failed:', err);
    writeDiagnosticEvent('daily-backup-failed', { error: err });
  } finally {
    backupInProgress -= 1;
  }
}

async function reloadRuntimeStores(userData: string): Promise<void> {
  // The server captures the library instance, so it must not survive a store swap.
  if (radioBrain) {
    await radioBrain.stop();
    radioBrain = null;
  }
  libraryMutationsQuiesced = 0;
  settings = new SettingsStore(join(userData, 'settings.json'));
  lastfmOutbox = new LastfmScrobbleOutbox(join(userData, 'lastfm-scrobbles.json'));
  podcastStore = new PodcastStore(join(userData, 'podcasts.json'));
  library = await LibraryStore.open(join(userData, 'library.db'));
  libraryAnalysis?.reset();
  scanner = createScannerService(library);
  libraryWatcher = createLibraryWatcherService();
  syncLibraryWatcher();
  await queueRadioBrainSync();
}

function registerAudioProtocol(): void {
  // Seekable transcode cache lives on the user-data drive (not the library drive).
  initTranscodeCache(join(app.getPath('userData'), 'transcode-cache'));
  initScoreCache(join(app.getPath('userData'), 'score-cache'));
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
      if (url.hostname === 'server') return await musicServers.stream(request);
      // Decode + resolve + two-phase allowlist authorization lives in
      // audio-protocol-authorize.ts, extracted so it's directly
      // unit-testable (scripts/audio-url-roundtrip-test.mjs) rather than
      // only reachable by booting Electron. Phase one runs on pure strings
      // BEFORE any fs call: existsSync/realpath on an unvalidated UNC path
      // alone opens an SMB session to whatever host it names — see that
      // module's header for why the ordering, not just the final verdict,
      // is what's load-bearing here.
      const authResult = await authorizeAudioProtocolPath(url, {
        libraryRoots: settings.get().libraryRoots,
        openedFiles: openedAudioFiles,
        getPodcastDownloadsRealRoot,
        getTracksByPaths: (paths) => library?.getTracksByPaths?.(paths),
      });
      if (!authResult.ok) {
        return authResult.status === 404
          ? new Response('Not found', { status: 404 })
          : new Response('Forbidden', { status: 403, headers: { 'X-Newamp-Reason': 'path-not-allowed' } });
      }
      const { real } = authResult;
      if ((await resolvePlaybackMode(real)) === 'ffmpeg') {
        // Seekable path: serve the finalized cached FLAC (range-capable) when it
        // already exists. First play streams a SEEKABLE synthesized WAV instead
        // of awaiting the full encode — audio starts in tens of ms
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
  musicServers = registerMusicServerIpc(app.getPath('userData'));
  registerHistoryImportIpc(() => {
    if (restoreInProgress) throw new Error('Wait for backup restoration to finish.');
    return library;
  }, () => settings.get().lastfmApiKey?.trim() ?? '');
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
  // The album and artist lists group on keys the grouping pass writes; the
  // first launch after an upgrade waits for it, every later one finds it done.
  ipcMain.handle('library:get-albums', async (_e, opts) => {
    await library.albumsReady();
    return library.getAlbums(opts ?? {});
  });
  ipcMain.handle('album-art:lookup', async (_e, input: AlbumArtLookupInput) =>
    searchAlbumArt(input),
  );
  ipcMain.handle('album-art:apply', async (_e, input: AlbumArtLookupInput, candidate: AlbumArtLookupResult) => {
    const image = await fetchAlbumArtImage(candidate);
    await library.albumsReady();
    return library.applyAlbumArtToAlbum(input.album, input.albumArtist, {
      mime: image.mime,
      data: image.data,
    }, image.sourceUrl);
  });
  ipcMain.handle('library:get-artists', async (_e, opts) => {
    await library.albumsReady();
    return library.getArtists(opts ?? {});
  });
  ipcMain.handle('library:get-folders', async (_e, parentPath?: string | null) =>
    library.getFoldersAsync(parentPath ?? null, settings.get().libraryRoots),
  );
  ipcMain.handle('library:get-folder-tracks', async (_e, folderPath: string, opts) =>
    library.getFolderTracksAsync(folderPath, opts ?? {}),
  );
  ipcMain.handle('library:get-folder-track-ids', async (_e, folderPath: string, opts) =>
    library.getFolderTrackIds(folderPath, opts ?? {}),
  );
  ipcMain.handle('library:get-album-tracks', async (_e, albumArtist: string, album: string) => {
    await library.albumsReady();
    return library.getAlbumTracks(albumArtist, album);
  });
  ipcMain.handle('library:get-album-tracks-by-key', async (_e, albumKey: unknown) => {
    await library.albumsReady();
    return library.getAlbumTracksByKey(typeof albumKey === 'string' ? albumKey : '');
  });
  ipcMain.handle('library:get-album-summary', async (_e, albumKey: unknown) => {
    await library.albumsReady();
    return library.getAlbumSummary(typeof albumKey === 'string' ? albumKey : '');
  });
  ipcMain.handle('library:set-album-split', async (_e, albumKey: unknown, split: unknown) =>
    library.setAlbumSplit(typeof albumKey === 'string' ? albumKey : '', split === true),
  );
  ipcMain.handle('library:get-artist-tracks', async (_e, artist: string) => {
    await library.albumsReady();
    return library.getArtistTracks(artist);
  });
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
    const saved = library.savePlaylist(input);
    notifyPlaylistsChanged();
    return saved;
  });
  ipcMain.handle('playlist:add-tracks', async (_e, input) => {
    const updated = library.addTracksToPlaylist(input);
    notifyPlaylistsChanged();
    return updated;
  });
  ipcMain.handle('playlist:delete', async (_e, id: number) => {
    library.deletePlaylist(id);
    notifyPlaylistsChanged();
  });
  ipcMain.handle('menu:track-context', (e, request: TrackContextMenuRequest) =>
    showTrackContextMenu(BrowserWindow.fromWebContents(e.sender), request),
  );
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
    const imported = library.importPlaylistM3u({ name, content, baseDir: dirname(filePath) });
    notifyPlaylistsChanged();
    return imported;
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
  ipcMain.handle('analysis:progress', async () =>
    libraryAnalysis?.progress() ?? emptyAnalysisProgress(settings.get().backgroundAnalysis !== false),
  );
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
  ipcMain.handle('tracks:song-score', async (_e, id: number, options?: { prefetch?: unknown }) => {
    const track = library.getTrack(Number(id));
    // Only local files: a remote-server track has no path ffmpeg can read here.
    if (!track?.path || /^[a-z][a-z0-9+.-]*:\/\//i.test(track.path)) return null;
    return getSongScore(
      { path: track.path, cueStart: track.cueStart, cueEnd: track.cueEnd },
      { prefetch: options?.prefetch === true },
    );
  });
  initWaveformCache(join(app.getPath('userData'), 'waveform-cache'));
  ipcMain.handle('tracks:waveform', async (_e, id: number, options?: { prefetch?: unknown }) => {
    // A request already on its way when the setting went off.
    if (settings.get().waveformSeekBar === false) return null;
    const track = library.getTrack(Number(id));
    // Only local files, as for the song score.
    if (!track?.path || /^[a-z][a-z0-9+.-]*:\/\//i.test(track.path)) return null;
    return getWaveform(
      { path: track.path, cueStart: track.cueStart, cueEnd: track.cueEnd, duration: track.duration },
      { prefetch: options?.prefetch === true },
    );
  });
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
    // Files from a launch with several selected arrive as separate events;
    // wait for the batch in flight so the renderer gets all of them at once.
    await openFileBatcher.settled();
    const files = pendingOpenFiles;
    pendingOpenFiles = [];
    if (files.length) handedOffFiles = { paths: [...files], at: Date.now() };
    return files;
  });
  ipcMain.handle('open:files', async (_e, paths: string[]) => openFiles(paths));
  ipcMain.handle('smart:list', async () => library.getSmartPlaylistRules());
  ipcMain.handle('smart:suggestions', async () => library.getSuggestedSmartPlaylistRulesAsync());
  ipcMain.handle('library:get-discover-surface', async (_e, input?: DiscoverSurfaceInput) =>
    library.getDiscoverSurfaceAsync(input ?? {}),
  );
  ipcMain.handle('smart:save', async (_e, input) => library.saveSmartPlaylistRule(input));
  ipcMain.handle('smart:delete', async (_e, id: number) => library.deleteSmartPlaylistRule(id));
  ipcMain.handle('smart:run', async (_e, input, sampleCount) =>
    library.runSmartPlaylistRuleAsync(input, Number.isFinite(sampleCount) ? Number(sampleCount) : 0),
  );
  ipcMain.handle('smart:harmonic-mix', async (_e, input) => library.buildHarmonicMixAsync(input));
  ipcMain.handle('smart:taste-mix', async (_e, input) => library.buildTasteMixAsync(input));
  ipcMain.handle('metadata:lookup', async (_e, id: number) => {
    const track = library.getTrack(id);
    if (!track) return [];
    return searchMusicBrainzMetadata(track);
  });
  ipcMain.handle('metadata:apply', async (_e, id: number, candidate: MetadataLookupCandidate) => {
    await readTrackBeforeMetadataEdit(id);
    return library.applyMetadataPatch(id, candidate);
  });
  ipcMain.handle('metadata:edit', async (_e, id: number, patch: TrackMetadataPatchInput) => {
    await readTrackBeforeMetadataEdit(id);
    return library.applyManualMetadataPatch(id, patch);
  });
  ipcMain.handle('metadata:reset-adopted', async () => library.resetAdoptedMetadataOverrides());
  // Both count albums by key, which the first launch after an upgrade has to
  // wait for; the wait is in slices, where counting without it would not be.
  ipcMain.handle('library:get-stats', async () => {
    await library.albumsReady();
    return library.getStats();
  });
  ipcMain.handle('library:get-health', async () => {
    await library.albumsReady();
    return library.getLibraryHealthAsync();
  });
  ipcMain.handle('library:prune-missing-preview', async (_e, targets?: string[]) =>
    library.previewPruneMissingTracks(Array.isArray(targets) ? targets : undefined, settings.get().libraryRoots),
  );
  ipcMain.handle('library:prune-missing', async (_e, targets?: string[]) => {
    if (restoreInProgress) throw new Error('Wait for backup restoration to finish.');
    assertHistoryImportIdle();
    const scope = Array.isArray(targets) ? targets : undefined;
    const roots = settings.get().libraryRoots;
    if (!library.previewPruneMissingTracks(scope, roots).tracks) return library.pruneMissingTracks(scope, roots);
    // Removing a track takes its plays, ratings, bookmarks, edits and playlist
    // places with it. Back the live stores up first, the same way the Support
    // backup does, and delete nothing if that fails.
    backupInProgress += 1;
    try {
      await quiesceLibraryMutations({ keepScan: true });
      const backup = await createBackupFromLiveStores(app.getPath('userData'), 'library');
      const result = library.pruneMissingTracks(scope, roots);
      // The queue and the playlist views drop what went, as after a trash.
      if (result.removedIds?.length) {
        notifyTracksRemoved(result.removedIds);
        notifyPlaylistsChanged();
      }
      return { ...result, backupPath: backup.backupPath };
    } finally {
      resumeLibraryMutations();
      backupInProgress -= 1;
    }
  });
  // Files go to the Recycle Bin / Trash, then their rows leave the library by
  // id: a backup first, and a file that could not be moved stays in both
  // places. A row whose file is already gone just leaves the library.
  const LONG_TRASH_FILES = 500;
  let trashInFlight = false;
  ipcMain.handle('tracks:trash', async (e, ids: unknown): Promise<TrashTracksResult> => {
    const { supplied, tracks } = trashableTracks(ids, (id) => library.getTrack(id));
    const nothing: TrashTracksResult = { trashed: 0, removed: 0, failed: [], cancelled: false };
    if (!supplied) return nothing;
    const bin = process.platform === 'win32' ? 'Recycle Bin' : 'Trash';
    // Streams, and CUE or podcast tracks (negative ids): nothing of theirs
    // to move, and silence would read as the action doing nothing.
    if (!tracks.length) return { ...nothing, failed: [{ path: '', error: 'Not a library file.' }] };
    if (trashInFlight) return { ...nothing, refused: `A move to the ${bin} is still running.` };
    // Why nothing may be moved right now. Asked again after the question: it
    // can stay open a while, and a restore that began meanwhile is about to
    // replace the library these rows are in.
    const refusal = (): string | null => {
      if (restoreInProgress) return 'Wait for backup restoration to finish.';
      try {
        assertHistoryImportIdle();
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      return null;
    };
    const early = refusal();
    if (early) return { ...nothing, refused: early };
    // Held from before the question: a second request while it is open would
    // ask again about the same files.
    trashInFlight = true;
    try {
      const owner = BrowserWindow.fromWebContents(e.sender);
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        buttons: [`Move to ${bin}`, 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message:
          tracks.length === 1
            ? `Move "${tracks[0]!.title}" to the ${bin}?`
            : `Move ${tracks.length.toLocaleString('en-US')} files to the ${bin}?`,
        detail: `The files leave the library too, with their plays, ratings and playlist places. A library backup is taken first, and the files can be restored from the ${bin}.${
          tracks.length > LONG_TRASH_FILES ? ' Moving this many files can take minutes.' : ''
        }`,
      };
      // A smoke can't press a native dialog's button; it says yes up front.
      const autoConfirm = smokeMode && process.env.NEWAMP_SMOKE_TRASH_CONFIRM === 'yes';
      const { response } = autoConfirm
        ? { response: 0 }
        : owner
          ? await dialog.showMessageBox(owner, options)
          : await dialog.showMessageBox(options);
      if (response !== 0) return { ...nothing, cancelled: true };
      const late = refusal();
      if (late) return { ...nothing, refused: late };
      backupInProgress += 1;
      try {
        await quiesceLibraryMutations({ keepScan: true });
        const backup = await createBackupFromLiveStores(app.getPath('userData'), 'library');
        // Windows won't move a file another process has open: the gapless
        // decoder, a cache warm or a score analysis on any of these stops first,
        // and again before each file in case playback moved on to one.
        const paths = tracks.map((track) => track.path);
        await Promise.all([releaseGaplessPaths(paths), stopFfmpegReading(paths)]);
        const { trashed, gone, failed } = await moveTracksToTrash(tracks, {
          exists: existsSync,
          trash: (path) => shell.trashItem(path),
          release: async (path) => {
            await Promise.all([releaseGaplessPaths([path]), stopFfmpegReading([path])]);
          },
          bin,
          onProgress: (done, total) => {
            if (!e.sender.isDestroyed()) e.sender.send('tracks:trash-progress', { done, total } satisfies TrashProgress);
          },
        });
        const removedIds = library.removeTracksById([...trashed, ...gone].map((track) => track.id));
        if (removedIds.length) {
          notifyTracksRemoved(removedIds);
          notifyPlaylistsChanged();
        }
        return {
          trashed: trashed.length,
          removed: removedIds.length,
          failed,
          cancelled: false,
          trashedIds: trashed.map((track) => track.id),
          removedIds,
          backupPath: backup.backupPath,
        };
      } finally {
        resumeLibraryMutations();
        backupInProgress -= 1;
      }
    } finally {
      trashInFlight = false;
    }
  });
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
  ipcMain.handle('history:clear', async () => { assertHistoryImportIdle(); library.clearListeningHistory(); });
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
    async (_e, albumArtist: string, album: string, score: number | null, albumKey?: string | null) => {
      await library.albumsReady();
      return library.setAlbumRatingScore(albumArtist, album, score, albumKey);
    },
  );
  ipcMain.handle(
    'library:get-album-rating',
    async (_e, albumArtist: string, album: string, albumKey?: string | null) => {
      await library.albumsReady();
      return library.getAlbumRating(albumArtist, album, albumKey);
    },
  );
  ipcMain.handle('library:toggle-avoid-autoplay', async (_e, id: number) =>
    library.toggleAvoidAutoPlay(id),
  );
  ipcMain.handle('library:record-play', async (_e, id: number) => {
    // What is playing is what the listener may ask about next (Sounds Like, a harmonic mix).
    libraryAnalysis?.prioritize([id]);
    return library.recordPlay(id);
  });
  ipcMain.handle('library:record-skip', async (_e, id: number, position?: number) =>
    library.recordSkip(id, Date.now(), position ?? 0),
  );

  // Sample-accurate gapless for the shared output: same library-row gate and
  // format probe as exclusive playback.
  registerGaplessTransport(
    ipcMain,
    resolveExclusiveSource,
    (sender) => !!mainWin && !mainWin.isDestroyed() && sender === mainWin.webContents,
  );

  ipcMain.handle('settings:get', async () => withAiAssistRuntime(settings.get()));
  ipcMain.handle('settings:set', async (_e, patch) => {
    if (restoreInProgress) throw new Error('Wait for backup restoration to finish.');
    settings.set(patch);
    if (patch && typeof patch === 'object' && 'radioBrainToken' in patch) radioBrain?.revokeClients();
    if (patchTouchesLibraryWatch(patch)) syncLibraryWatcher();
    if (patchTouchesRadioBrain(patch)) {
      await queueRadioBrainSync();
    }
    // Off means the background decode stops too, not only that nothing new is asked for.
    if (patch && typeof patch === 'object' && 'waveformSeekBar' in patch && settings.get().waveformSeekBar === false) {
      cancelWaveformWork();
    }
    if (patch && typeof patch === 'object' && 'backgroundAnalysis' in patch) libraryAnalysis?.refresh();
    // Turning exclusive mode off releases the WASAPI device immediately so
    // system audio (and the Web Audio path) come back without a restart.
    if (patch && typeof patch === 'object' && (patch as Partial<AppSettings>).bitPerfectExclusive === false) {
      exclusivePlaySeq++;
      exclusiveOutput?.stop();
    }
    return withAiAssistRuntime(settings.get());
  });

  // ---- Bit-Perfect Exclusive output (native WASAPI, Windows) ----------------
  ipcMain.handle('exclusive:supported', async () => getExclusiveOutput().available);
  ipcMain.handle('exclusive:list-devices', async () => getExclusiveOutput().listDevices());
  // Request-ordering guard: resolveExclusiveSource awaits a metadata probe, so
  // two rapid play requests can resolve OUT of order (track A's probe slower
  // than track B's) — without this, the STALE play would win and the audible
  // track would not match the UI.
  let exclusivePlaySeq = 0;
  let exclusivePrepareSeq = 0;
  ipcMain.handle('exclusive:play', async (_e, trackId: number, startAt?: number) => {
    const requestSeq = ++exclusivePlaySeq;
    try {
      if (Number(trackId) < 0) return { ok: false, error: 'Streamed tracks use shared audio output. Exclusive output requires a local library track.' };
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
  ipcMain.handle('exclusive:stop', async () => {
    exclusivePlaySeq++;
    getExclusiveOutput().stop();
  });
  ipcMain.handle('exclusive:seek', async (_e, seconds: number) =>
    getExclusiveOutput().seek(Number(seconds) || 0),
  );
  ipcMain.handle('exclusive:prepare-next', async (_e, trackId: number | null) => {
    const prepareSeq = ++exclusivePrepareSeq;
    const playSeq = exclusivePlaySeq;
    if (trackId == null) {
      getExclusiveOutput().prepareNext(null);
      return;
    }
    const source = await resolveExclusiveSource(Math.trunc(Number(trackId)));
    if (prepareSeq !== exclusivePrepareSeq || playSeq !== exclusivePlaySeq) return;
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
    if (restoreInProgress) throw new Error('Wait for backup restoration to finish.');
    if (backupInProgress) throw new Error('Wait for the current backup, move or cleanup to finish.');
    backupInProgress += 1;
    const userData = app.getPath('userData');
    // library.db/settings.json on disk can lag behind the live stores by up
    // to their batching window (30s for play/skip stats, 800ms for the
    // resumeState autosave) — quiesce the watcher/scanner and read the
    // snapshot straight out of memory instead of copying a possibly-stale
    // file. Resume even if the backup itself throws.
    try {
      await quiesceLibraryMutations();
      return await createBackupFromLiveStores(userData);
    } finally {
      resumeLibraryMutations();
      backupInProgress -= 1;
    }
  });
  ipcMain.handle('app:restore-backup', async () => {
    if (restoreInProgress) throw new Error('A backup restoration is already running.');
    if (backupInProgress) throw new Error('Wait for the current backup to finish.');
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
    if (restoreInProgress) throw new Error('A backup restoration is already running.');
    if (backupInProgress) throw new Error('Wait for the current backup to finish.');
    assertHistoryImportIdle();
    restoreInProgress = true;

    // Stop the two automatic mutation sources FIRST, then take the pre-restore
    // safety snapshot from the live stores — taking it before quiescing (the
    // old order) could miss whatever a scan or a batched flush hadn't written
    // to disk yet. quiesceLibraryMutations also drains the watcher's pending
    // reconcile, so a prune queued before the restore cannot land on the
    // restored library; reloadRuntimeStores below lifts the quiesce.
    let storesClosed = false;
    try {
      libraryWatcher?.stop();
      await quiesceLibraryMutations();
      const safety = await createBackupFromLiveStores(userData);

      // Drain pending renames before replacing store files. Keep the live
      // stores if the safety snapshot or either drain fails.
      await library?.waitForPendingWrites();
      await settings?.waitForPendingWrites();
      exclusiveOutput?.stop();
      closeAllGaplessSessions();
      if (radioBrain) {
        await radioBrain.stop();
        radioBrain = null;
      }
      // The podcast store outlives this function until the reload below. Land
      // its pending progress now and cancel the timer, or that write fires
      // after the restored podcasts.json is in place and puts the old one back.
      podcastStore.flushProgressSync();
      storesClosed = true;
      library?.close();
      settings?.flushSync();
      return await restoreSupportBackup({
        userDataPath: userData,
        settingsPath: join(userData, 'settings.json'),
        libraryPath: join(userData, 'library.db'),
        backupPath,
        safetyBackupPath: safety.backupPath,
      });
    } finally {
      try {
        if (storesClosed) {
          await reloadRuntimeStores(userData);
        } else {
          resumeLibraryMutations();
          syncLibraryWatcher();
          await queueRadioBrainSync();
        }
      } finally {
        restoreInProgress = false;
      }
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
  // While a backup is being restored, a change to the outgoing podcast store
  // would either be lost with it or be written over the restored file.
  const assertPodcastsWritable = (): void => {
    if (restoreInProgress) throw new Error('Wait for backup restoration to finish.');
  };
  ipcMain.handle('podcasts:list', async () => podcastStore.listSubscriptions());
  ipcMain.handle('podcasts:subscribe', async (_e, url: string) => {
    assertPodcastsWritable();
    const subscription = await fetchPodcastSubscription(url);
    assertPodcastsWritable();
    return podcastStore.upsert(subscription.feed, subscription.episodes);
  });
  ipcMain.handle('podcasts:refresh', async (_e, url: string) => {
    assertPodcastsWritable();
    const subscription = await fetchPodcastSubscription(url);
    assertPodcastsWritable();
    return podcastStore.upsert(subscription.feed, subscription.episodes);
  });
  ipcMain.handle('podcasts:remove', async (_e, url: string) => {
    assertPodcastsWritable();
    podcastStore.remove(url);
  });
  // Progress ticks arrive every few seconds during playback; dropping the ones
  // that land mid-restore is better than failing them into the renderer.
  ipcMain.handle('podcasts:progress', async (_e, input) => {
    if (restoreInProgress) return null;
    return podcastStore.updateProgress(input);
  });
  ipcMain.handle('podcasts:download', async (_e, feedUrl: string, episodeId: string) => {
    assertPodcastsWritable();
    return downloadPodcastEpisode(podcastStore, {
      feedUrl,
      episodeId,
      downloadsPath: join(app.getPath('userData'), 'podcast-downloads'),
    });
  });
  ipcMain.handle('podcasts:remove-download', async (_e, feedUrl: string, episodeId: string) => {
    assertPodcastsWritable();
    return podcastStore.clearDownload(feedUrl, episodeId);
  });
  ipcMain.handle('lyrics:local', async (_e, trackId: number) => {
    const id = Math.trunc(Number(trackId));
    if (!Number.isFinite(id) || id <= 0) return null;
    const track = library.getTrack(id);
    if (!track) return null;
    // Saved lyrics outrank the ones the file carries.
    return (await findSidecarLyricsForTrack(track)) ?? library.getCustomLyrics(id) ?? (await findEmbeddedLyricsForTrack(track));
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
        defaultPath: settings.get().libraryRoots[0] ?? app.getPath('music'),
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
  ipcMain.handle('app:get-gpu-compositing', () => (gpuCompositingSettled ? gpuCompositingEnabled() : null));

  // window controls
  ipcMain.handle('win:minimize', () => mainWin?.minimize());
  ipcMain.handle('win:toggle-max', () => {
    if (!mainWin) return;
    if (mainWin.isMaximized()) mainWin.unmaximize();
    else mainWin.maximize();
  });
  ipcMain.handle('win:set-fullscreen', (_e, on: boolean) => {
    if (!mainWin) return;
    if (process.platform === 'darwin') {
      // Native fullscreen moves the window to its own Space with a roughly
      // half-second swap on every toggle. The ambient visualizer wants an
      // instant, in-place one, so use simple fullscreen and fall back to the
      // native call only to leave a native fullscreen the user started.
      if (on) {
        if (!mainWin.isFullScreen()) mainWin.setSimpleFullScreen(true);
      } else {
        if (mainWin.isSimpleFullScreen()) mainWin.setSimpleFullScreen(false);
        if (mainWin.isFullScreen()) mainWin.setFullScreen(false);
      }
      mainWin.setWindowButtonVisibility(!on && !inCompact);
    } else {
      // Asking a transparent window that is not fullscreen to leave it makes
      // Electron resize it to a restore rectangle it never recorded: the
      // minimum size at the top-left corner, saved as the window's bounds.
      if (mainWin.isFullScreen() === !!on) return;
      mainWin.setFullScreen(!!on);
    }
    refreshDisplaySleepBlocker();
  });
  ipcMain.handle('win:is-fullscreen', () => (mainWin ? isWindowFullScreen(mainWin) : false));
  ipcMain.handle('win:set-compact', (_e, on: boolean, size?: { width?: number; height?: number }) =>
    setCompactMode(!!on, size),
  );
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
    if (!mainWin) return;
    mainWin.setAlwaysOnTop(!!on, 'floating');
    // macOS keeps a floating window in the Space it was opened in, so a pinned
    // deck would vanish on the first Space switch. Skipping the process-type
    // transform avoids hiding the window and Dock icon on every toggle.
    if (process.platform === 'darwin' && (on || pinnedAcrossSpaces)) {
      mainWin.setVisibleOnAllWorkspaces(!!on, { visibleOnFullScreen: !!on, skipTransformProcessType: true });
      pinnedAcrossSpaces = !!on;
    }
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

async function runUiQueueEditSmoke(win: BrowserWindow, scanPromise: Promise<void>): Promise<void> {
  try {
    await Promise.race([
      scanPromise,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI queue-edit smoke scan')), 15000),
      ),
    ]);
    await reloadForSmoke(win);
    const result = await Promise.race([
      win.webContents.executeJavaScript(uiQueueEditProbeSource(), true),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for UI queue-edit probe')), 25000),
      ),
    ]);
    const trashedPath = (result as { trash?: { path?: string | null } }).trash?.path;
    const trashFileGone = typeof trashedPath === 'string' ? !existsSync(trashedPath) : null;
    console.log(`[newamp-ui-queue-edit-smoke] ${JSON.stringify({ ...(result as object), trashFileGone })}`);
    isQuitting = true;
    app.quit();
  } catch (err) {
    console.error('[newamp-ui-queue-edit-smoke] failed:', err);
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
    // Raise the window, race the capture, and fall back to asking the
    // MilkDrop iframe for the lit fraction of its last composed Live frame.
    // That frame exists without compositor frames: the iframe paints from
    // the timer-driven audio messages whenever rAF has been starved.
    try {
      detachedVizWin.moveTop();
      detachedVizWin.focus();
    } catch {
      /* window manager refused; the fallback still proves pixels */
    }
    await new Promise((r) => setTimeout(r, 400));
    // MilkDrop picks a random preset, and some sit near black for a moment,
    // so one shot can catch a dark beat. Take up to five and keep the
    // brightest: a projector that really paints nothing is black in all of them.
    let capture: { width: number; height: number; lit: number; sampled: number; litFraction: number; source: string; shots?: number } | null = null;
    for (let shotIndex = 0; shotIndex < 5; shotIndex += 1) {
      if (shotIndex > 0) await new Promise((r) => setTimeout(r, 700));
      if (!detachedVizWin || detachedVizWin.isDestroyed()) break;
      const shot = await Promise.race([
        detachedVizWin.webContents.capturePage(),
        new Promise<null>((r) => setTimeout(() => r(null), 8000)),
      ]);
      if (!shot) break;
      const { width, height } = shot.getSize();
      const bitmap = shot.toBitmap(); // BGRA
      let lit = 0;
      let sampled = 0;
      for (let i = 0; i < bitmap.length; i += 64) {
        const lum = (bitmap[i] ?? 0) + (bitmap[i + 1] ?? 0) + (bitmap[i + 2] ?? 0);
        if (lum > 36) lit += 1;
        sampled += 1;
      }
      const litFraction = sampled ? lit / sampled : 0;
      if (!capture || litFraction > capture.litFraction) {
        capture = { width, height, lit, sampled, litFraction, source: 'capturePage' };
      }
      capture.shots = shotIndex + 1;
      if (litFraction > 0.05) break;
    }
    if (!capture) {
      // An occluded window also throttles the iframe's timers, so the preset
      // catalog can still be parsing here. Poll until a frame has been
      // composed instead of sampling a pipeline that doesn't exist yet.
      let litFraction = 0;
      for (let attempt = 0; attempt < 40 && litFraction <= 0; attempt += 1) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
        if (!detachedVizWin || detachedVizWin.isDestroyed()) break;
        litFraction = Number(
          await detachedVizWin.webContents.executeJavaScript(
            `(() => {
              const frame = document.getElementById('milkdrop-frame');
              const sample = frame && frame.contentWindow && frame.contentWindow.__newampLiveSample;
              return typeof sample === 'function' ? sample() : 0;
            })()`,
            true,
          ),
        ) || 0;
      }
      capture = { width: 48, height: 27, lit: Math.round(litFraction * 1296), sampled: 1296, litFraction, source: 'live-composition-readback' };
    }
    const finalStats = await detachedVizWin.webContents.executeJavaScript('window.__newampDetachedStats', true);
    // The pointer hides when idle and must come back on any movement. Left
    // alone after that, the 2 s idle timer hides it again; it gets a few
    // seconds' grace because timers in an unfocused window run late.
    const cursor = await detachedVizWin.webContents.executeJavaScript(
      `(async () => {
        const before = getComputedStyle(document.body).cursor;
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 20 }));
        await new Promise((r) => setTimeout(r, 50));
        const afterMove = getComputedStyle(document.body).cursor;
        const idleStart = performance.now();
        let afterIdle = afterMove;
        while (afterIdle !== 'none' && performance.now() - idleStart < 6000) {
          await new Promise((r) => setTimeout(r, 100));
          afterIdle = getComputedStyle(document.body).cursor;
        }
        return { before, afterMove, afterIdle, idleMs: Math.round(performance.now() - idleStart) };
      })()`,
      true,
    );

    // Look-ahead, end to end: the projector's producer asked for the fixture's
    // song score over IPC, ffmpeg decoded it, and frames now carry its cues.
    // First-play analysis takes a second or two, so give it a little room.
    let lookAhead: unknown = null;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      lookAhead = await win.webContents.executeJavaScript('window.__newampScoreFeed || null', true);
      if ((lookAhead as { status?: string } | null)?.status === 'scored') break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const result = {
      ok: true,
      ...playback,
      detached: finalStats,
      firstStats: stats,
      capture,
      cursor,
      lookAhead,
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
    // NEWAMP_SCREENSHOT_SIZE=WxH shoots at another window size (short
    // windows are where views clip).
    const sizeMatch = /^(\d+)x(\d+)$/.exec(process.env.NEWAMP_SCREENSHOT_SIZE ?? '');
    win.setSize(sizeMatch ? Number(sizeMatch[1]) : 1440, sizeMatch ? Number(sizeMatch[2]) : 940, true);
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
    // A deck floats only while pinned; the Pin button must be what pins it.
    const alwaysOnTopUnpinned = win.isAlwaysOnTop();
    await win.webContents.executeJavaScript(
      `(() => {
        const pin = Array.from(document.querySelectorAll('button')).find((el) => (el.textContent || '').trim() === 'PIN');
        if (!pin) throw new Error('deck has no PIN button');
        pin.click();
      })()`,
      true,
    );
    await new Promise((r) => setTimeout(r, 500));
    const alwaysOnTopPinned = win.isAlwaysOnTop();
    console.log(`[newamp-ui-deck-smoke] ${JSON.stringify({
      ...result,
      nativeBounds: { width: bounds.width, height: bounds.height },
      resizable: win.isResizable(),
      alwaysOnTopUnpinned,
      alwaysOnTopPinned,
    })}`);
    isQuitting = true;
    app.quit();
  } catch (err) {
    console.error('[newamp-ui-deck-smoke] failed:', err);
    app.exit(1);
  }
}

// Trusted wheel events over the transport volume slider, first with the
// renderer idle and then with its CPU throttled so React paints well behind
// the events (the Mac tester's "stops working after a while"). The volume
// must move by the distance scrolled either way. Ends with a double-click,
// which resets the slider to 100%.
async function runUiWheelVolumeSmoke(win: BrowserWindow): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const wc = win.webContents;
  const readVolume = (): Promise<number> =>
    wc.executeJavaScript('window.__newampSmoke.volume()', true) as Promise<number>;
  const locateSlider = (): Promise<{ left: number; width: number; y: number } | null> =>
    wc.executeJavaScript(
      `(() => {
        const el = document.querySelector('[data-newamp-transport] .volume-slider-input');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, width: r.width, y: r.top + r.height / 2 };
      })()`,
      true,
    ) as Promise<{ left: number; width: number; y: number } | null>;
  const wheel = (x: number, y: number, deltaY: number): void => {
    wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY, canScroll: true });
  };
  // Sends the burst, then waits until the page has received every pixel
  // of it (a throttled renderer takes a while, and merges queued events),
  // so the volume read afterwards is final.
  const burst = async (
    x: number,
    y: number,
    deltaY: number,
    count: number,
  ): Promise<{ volume: number; events: number; pixels: number }> => {
    const before = (await wc.executeJavaScript('window.__wheelLog.length', true)) as number;
    for (let i = 0; i < count; i += 1) {
      wheel(x, y, deltaY);
      await sleep(2);
    }
    const wanted = Math.abs(deltaY) * count;
    const started = Date.now();
    let delivered = { events: 0, pixels: 0 };
    while (Date.now() - started < 20000) {
      delivered = (await wc.executeJavaScript(
        `(() => { const l = window.__wheelLog.slice(${before}); return { events: l.length, pixels: l.reduce((s, e) => s + Math.abs(e.deltaY), 0) }; })()`,
        true,
      )) as { events: number; pixels: number };
      if (delivered.pixels >= wanted) break;
      await sleep(100);
    }
    await sleep(400);
    return { volume: await readVolume(), ...delivered };
  };
  let throttled = false;
  try {
    const slider = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 15000) {
        const found = await locateSlider().catch(() => null);
        if (found && found.width > 0) return found;
        await sleep(100);
      }
      throw new Error('Timed out waiting for the transport volume slider');
    })();
    const x = slider.left + slider.width / 2;
    const y = slider.y;
    // sendInputEvent only reaches a focused window.
    win.show();
    win.focus();
    wc.focus();
    await sleep(300);
    await wc.executeJavaScript(
      `window.__wheelLog = []; document.addEventListener('wheel', (e) => window.__wheelLog.push({ deltaY: e.deltaY, deltaMode: e.deltaMode, target: (e.target && e.target.className) || String(e.target), trusted: e.isTrusted, x: e.clientX, y: e.clientY }), { capture: true, passive: true });`,
      true,
    );
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    await sleep(200);
    const start = await readVolume();
    // One event of a quarter notch tells us which sign raises the volume
    // in this Chromium's wheel-delta convention.
    wheel(x, y, 25);
    await sleep(300);
    const afterOne = await readVolume();
    if (afterOne === start) {
      const log = await wc.executeJavaScript('JSON.stringify(window.__wheelLog)', true);
      throw new Error('A wheel event over the slider did not change the volume. point=' + JSON.stringify({ x, y, slider, bounds: win.getContentBounds(), zoom: wc.getZoomFactor() }) + ' wheelLog=' + log);
    }
    const raise = afterOne > start ? 25 : -25;
    const count = 40;
    const fastStart = afterOne;
    const fast = await burst(x, y, raise, count);
    wc.debugger.attach('1.3');
    throttled = true;
    await wc.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: 16 });
    const throttledStart = fast.volume;
    const slow = await burst(x, y, -raise, count);
    await wc.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: 1 });
    wc.debugger.detach();
    throttled = false;
    // A main thread that is busy most of the time: queued wheel events
    // merge into fewer, larger ones and React paints well behind them.
    await wc.executeJavaScript(
      `window.__jank = setInterval(() => { const t = performance.now(); while (performance.now() - t < 120) {} }, 150);`,
      true,
    );
    const jankStart = slow.volume;
    const jank = await burst(x, y, raise, count);
    await wc.executeJavaScript('clearInterval(window.__jank)', true);
    // The tester's path: Settings open, the visualizer opened and closed,
    // then the Retro TV deck. Each is a burst over whichever volume slider
    // is on screen; in deck mode that is the deck's own.
    const sliderAnywhere = (): Promise<{ left: number; width: number; y: number } | null> =>
      wc.executeJavaScript(
        `(() => {
          const el = document.querySelector('.volume-slider-input');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return r.width > 0 ? { left: r.left, width: r.width, y: r.top + r.height / 2 } : null;
        })()`,
        true,
      ) as Promise<{ left: number; width: number; y: number } | null>;
    const burstAnywhere = async (
      label: string,
      sign: number,
    ): Promise<{ volume: number; events: number; pixels: number; start: number }> => {
      const started = Date.now();
      let found: { left: number; width: number; y: number } | null = null;
      while (!found && Date.now() - started < 15000) {
        found = await sliderAnywhere().catch(() => null);
        if (!found) await sleep(100);
      }
      if (!found) throw new Error('No volume slider on screen for ' + label);
      const px = found.left + found.width / 2;
      wc.sendInputEvent({ type: 'mouseMove', x: px, y: found.y });
      await sleep(150);
      const start = await readVolume();
      return { start, ...(await burst(px, found.y, sign * raise, count)) };
    };
    const navigate = (name: string): Promise<void> =>
      wc.executeJavaScript(
        `(() => {
          const b = Array.from(document.querySelectorAll('button')).find((el) => (el.textContent || '').trim() === ${JSON.stringify(name)});
          if (!b) throw new Error('no nav button ' + ${JSON.stringify(name)});
          b.click();
        })()`,
        true,
      ) as Promise<void>;
    await navigate('Settings');
    await sleep(800);
    const settings = await burstAnywhere('settings', -1);
    await wc.executeJavaScript('window.__newampSmoke.setFullscreenVisualizer(true)', true);
    await sleep(1500);
    await wc.executeJavaScript('window.__newampSmoke.setFullscreenVisualizer(false)', true);
    await sleep(800);
    const afterVisualizer = await burstAnywhere('after visualizer', 1);
    await wc.executeJavaScript(
      `localStorage.setItem('newamp:deck:skinSchema', '2'); localStorage.setItem('newamp:deck:skin', 'retro-tv'); window.__newampSmoke.setCompactDeck(true);`,
      true,
    );
    await sleep(1500);
    const deck = await burstAnywhere('retro-tv deck', -1);
    // The Retro TV volume knob turns by dragging it: up is louder, 100 px
    // per 100%.
    const knob = (await wc.executeJavaScript(
      `(() => {
        const el = document.querySelector('[data-newamp-deck-volume-knob]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`,
      true,
    )) as { x: number; y: number } | null;
    if (!knob) throw new Error('The Retro TV deck has no volume knob');
    wc.sendInputEvent({ type: 'mouseMove', x: knob.x, y: knob.y });
    await sleep(150);
    const knobStart = await readVolume();
    wc.sendInputEvent({ type: 'mouseDown', x: knob.x, y: knob.y, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 6; step += 1) {
      wc.sendInputEvent({ type: 'mouseMove', x: knob.x, y: knob.y - step * 5, modifiers: ['leftbuttondown'] });
      await sleep(30);
    }
    wc.sendInputEvent({ type: 'mouseUp', x: knob.x, y: knob.y - 30, button: 'left', clickCount: 1 });
    await sleep(400);
    const afterKnobDrag = await readVolume();
    await wc.executeJavaScript('window.__newampSmoke.setCompactDeck(false)', true);
    await sleep(1200);
    const sliderAgain = await (async () => {
      const started = Date.now();
      while (Date.now() - started < 15000) {
        const found = await locateSlider().catch(() => null);
        if (found && found.width > 0) return found;
        await sleep(100);
      }
      throw new Error('Timed out waiting for the transport slider after deck mode');
    })();
    // Double-click a quarter of the way along: the clicks alone would land
    // the thumb at 50%, so 100% afterwards is the reset, not the position.
    const clickX = sliderAgain.left + sliderAgain.width * 0.25;
    for (const clickCount of [1, 2]) {
      wc.sendInputEvent({ type: 'mouseDown', x: clickX, y: sliderAgain.y, button: 'left', clickCount });
      wc.sendInputEvent({ type: 'mouseUp', x: clickX, y: sliderAgain.y, button: 'left', clickCount });
      await sleep(60);
    }
    await sleep(400);
    const afterDoubleClick = await readVolume();
    console.log(
      `[newamp-ui-wheel-volume-smoke] ${JSON.stringify({
        ok: true,
        start,
        afterOne,
        count,
        stepPerEvent: 0.01,
        fastStart,
        afterFast: fast.volume,
        fastEvents: fast.events,
        fastPixels: fast.pixels,
        throttledStart,
        afterThrottled: slow.volume,
        throttledEvents: slow.events,
        throttledPixels: slow.pixels,
        jankStart,
        afterJank: jank.volume,
        jankEvents: jank.events,
        jankPixels: jank.pixels,
        settingsStart: settings.start,
        afterSettings: settings.volume,
        visualizerStart: afterVisualizer.start,
        afterVisualizer: afterVisualizer.volume,
        deckStart: deck.start,
        afterDeck: deck.volume,
        deckEvents: deck.events,
        knobStart,
        afterKnobDrag,
        afterDoubleClick,
      })}`,
    );
    isQuitting = true;
    app.quit();
  } catch (err) {
    if (throttled) {
      try {
        await wc.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: 1 });
        wc.debugger.detach();
      } catch {
        /* the window may already be gone */
      }
    }
    console.error('[newamp-ui-wheel-volume-smoke] failed:', err);
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
      // The stage takes focus as it opens, so Tab starts inside it.
      const stageFocusedOnOpen = document.activeElement === stage;
      // A profile that never touched the album cover overlay starts with it off.
      const artDefault = stage.getAttribute('data-newamp-visualizer-art');
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
        const gl = context ? null : (canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
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
      //    succeeds on real GPU hardware but never on the smoke.
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
      const pressKey = (key, init = {}) => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
      };
      // Fires a key at the stage and reports whether the visualizer took it
      // (preventDefault). The app-wide shortcut handler sits on window in the
      // bubble phase and takes L, V and the rest itself, so a window-level
      // observer would read its verdict too, not the visualizer's. The
      // visualizer decides in the window capture phase, before the event reaches
      // the stage; the observer reads it from document and stops the event
      // there, which also keeps a skip, love or stop key from moving playback
      // under the probe.
      const keyTaken = (key, init = {}) => {
        let taken = null;
        const observe = (event) => {
          taken = event.defaultPrevented;
          event.stopImmediatePropagation();
        };
        document.addEventListener('keydown', observe);
        try {
          stage.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
        } finally {
          document.removeEventListener('keydown', observe);
        }
        return taken;
      };
      const attr = (name) => stage.getAttribute(name);
      const settles = (label, fn, timeout = 4000) => waitFor(label, fn, timeout).then(() => true, () => false);
      // The visualizer's keys: a chord belongs to the app, plain L and V stay
      // the app-wide love and stop keys, and a held key repeats only the arrows.
      const presetBefore = attr('data-newamp-visualizer-preset');
      const ctrlArrowTaken = keyTaken('ArrowRight', { ctrlKey: true });
      const metaArrowTaken = keyTaken('ArrowRight', { metaKey: true });
      await sleep(150);
      const ctrlArrowKeepsPreset =
        ctrlArrowTaken === false && metaArrowTaken === false && attr('data-newamp-visualizer-preset') === presetBefore;
      const tierBefore = attr('data-newamp-visualizer-performance');
      const plainLTaken = keyTaken('l');
      await sleep(150);
      const tierAfterL = attr('data-newamp-visualizer-performance');
      const plainLKeepsTier = plainLTaken === false && tierAfterL === tierBefore;
      const plainLDebug = { plainLTaken, tierBefore, tierAfterL };
      const autoVjBefore = attr('data-newamp-visualizer-auto-vj');
      const plainVTaken = keyTaken('v');
      await sleep(150);
      const plainVKeepsAutoVj = plainVTaken === false && attr('data-newamp-visualizer-auto-vj') === autoVjBefore;
      const paletteBefore = attr('data-newamp-visualizer-palette');
      pressKey('p', { repeat: true });
      await sleep(150);
      const heldKeyIgnored = attr('data-newamp-visualizer-palette') === paletteBefore;
      // Lite, 4K, Lite inside one frame: Q lands while Lite is on and does
      // nothing, so quality is still auto. A toggle reading last render's tier
      // would write 4K under the Lite badge.
      pressKey('L', { shiftKey: true });
      pressKey('q');
      pressKey('L', { shiftKey: true });
      await waitFor('balanced visualizer state after the burst', () =>
        attr('data-newamp-visualizer-performance') === 'balanced',
      );
      await sleep(150);
      const liteBurstQuality = attr('data-newamp-visualizer-quality');
      // Holding an arrow keeps stepping presets. Last of this block: it moves
      // the stage off the preset the rest of the probe was reading.
      const stepFrom = attr('data-newamp-visualizer-preset');
      pressKey('ArrowRight', { repeat: true });
      const stepOne = await settles('first held-arrow step', () => {
        const now = attr('data-newamp-visualizer-preset');
        return now !== stepFrom ? now : null;
      });
      const stepMid = attr('data-newamp-visualizer-preset');
      pressKey('ArrowRight', { repeat: true });
      const stepTwo = await settles('second held-arrow step', () => attr('data-newamp-visualizer-preset') !== stepMid);
      const heldArrowSteps = stepOne && stepTwo;
      // Two presses inside one tick, before React has rendered or the settings
      // write has answered, are two steps: back to where the held arrow began.
      pressKey('ArrowLeft', { repeat: true });
      pressKey('ArrowLeft', { repeat: true });
      const sameTickArrowSteps = await settles('two arrow steps in one tick', () =>
        attr('data-newamp-visualizer-preset') === stepFrom,
      );
      pressKey('q');
      await waitFor('4K visualizer quality state', () =>
        stage.getAttribute('data-newamp-visualizer-quality') === '4k',
      );
      const appliedQuality = stage.getAttribute('data-newamp-visualizer-quality');
      pressKey('L', { shiftKey: true });
      await waitFor('low-end visualizer state', () =>
        stage.getAttribute('data-newamp-visualizer-performance') === 'low' &&
        stage.getAttribute('data-newamp-visualizer-quality') === 'auto',
      );
      pressKey('L', { shiftKey: true });
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
        stage.getAttribute('data-newamp-visualizer-palette') !== 'look',
      );
      pressKey('r');
      await waitFor('visualizer reactivity state', () =>
        stage.getAttribute('data-newamp-visualizer-reactivity') !== 'punch',
      );
      pressKey('V', { shiftKey: true });
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
      transportArtButton.focus({ focusVisible: true });
      const openedFromKeyboard = transportArtButton.matches(':focus-visible');
      transportArtButton.click();
      await waitFor('fullscreen visualizer reopens', () =>
        document.querySelector('[data-newamp-fullscreen-visualizer]'),
      );
      const stageFocusedOnReopen = document.activeElement === document.querySelector('[data-newamp-fullscreen-visualizer]');
      // Right-click on the stage opens the visualizer menu at the pointer;
      // Escape closes it and leaves the stage up. Synthetic keys must be
      // cancelable, like real ones, or the visualizer's preventDefault means
      // nothing to the app-wide shortcuts behind it.
      const escape = () =>
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const liveStage = () => document.querySelector('[data-newamp-fullscreen-visualizer]');
      liveStage().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
      const menuEl = await waitFor('visualizer menu from right-click', () => {
        const el = document.querySelector('[data-newamp-viz-menu]');
        return el && getComputedStyle(el).visibility === 'visible' ? el : null;
      }, 4000).catch(() => null);
      const rightClickMenu = !!menuEl;
      const rightClickMenuRole = menuEl ? menuEl.getAttribute('role') : null;
      // At the pointer: a corner of the menu sits on it. One that would run off
      // the screen flips across the pointer, so either side counts.
      const menuBox = menuEl ? menuEl.getBoundingClientRect() : null;
      const rightClickMenuRect = menuBox
        ? { left: menuBox.left, top: menuBox.top, right: menuBox.right, bottom: menuBox.bottom }
        : null;
      const within = (a, b) => Math.abs(a - b) <= 8;
      const rightClickMenuAtCursor =
        !!menuBox &&
        (within(menuBox.left, 300) || within(menuBox.right, 300)) &&
        (within(menuBox.top, 300) || within(menuBox.bottom, 300));
      const rightClickMenuFocused = !!menuEl && menuEl.contains(document.activeElement);
      let rightClickMenuArrowMoved = false;
      if (menuEl) {
        const focusedBefore = document.activeElement;
        (focusedBefore || menuEl).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        await sleep(100);
        rightClickMenuArrowMoved = document.activeElement !== focusedBefore && menuEl.contains(document.activeElement);
      }
      await sleep(100);
      escape();
      await sleep(300);
      const rightClickMenuClosed = !document.querySelector('[data-newamp-viz-menu]');
      const stageSurvivedRightClick = !!liveStage();
      const openMenu = () => {
        liveStage().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
        return waitFor('visualizer menu', () => {
          const el = document.querySelector('[data-newamp-viz-menu]');
          return el && getComputedStyle(el).visibility === 'visible' ? el : null;
        }, 4000);
      };
      const menuKey = (target, name) =>
        target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
      const menuItem = (id) => document.querySelector('[data-newamp-viz-menu-item="' + id + '"]');
      // Right opens the Mode submenu with focus on its first entry; a list
      // taller than the window scrolls on the wheel instead of changing the
      // volume; Left closes it and puts focus back on Mode; End and Home go to
      // the last and first item; Tab closes the menu.
      await openMenu();
      const modeItem = menuItem('mode');
      modeItem.focus();
      menuKey(modeItem, 'ArrowRight');
      const submenu = await waitFor('Mode submenu', () => document.querySelector('[data-newamp-viz-submenu]'), 2000).catch(() => null);
      await sleep(100);
      const menuRightOpensSubmenu =
        !!submenu && submenu.contains(document.activeElement) && modeItem.getAttribute('aria-expanded') === 'true';
      let menuWheelKept = true;
      if (submenu && submenu.scrollHeight - submenu.clientHeight > 1) {
        const wheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
        submenu.dispatchEvent(wheel);
        menuWheelKept = !wheel.defaultPrevented;
      }
      menuKey(document.activeElement, 'ArrowLeft');
      await sleep(100);
      const menuLeftClosesSubmenu = !document.querySelector('[data-newamp-viz-submenu]') && document.activeElement === modeItem;
      menuKey(document.activeElement, 'End');
      const menuEndFocusesLast = document.activeElement === menuItem('exit');
      menuKey(document.activeElement, 'Home');
      const menuHomeFocusesFirst = document.activeElement === menuItem('next');
      menuKey(document.activeElement, 'Tab');
      await sleep(150);
      const menuTabCloses = !document.querySelector('[data-newamp-viz-menu]');
      // Picking a mode from the submenu switches to it and closes the menu.
      const modeTarget = liveStage().getAttribute('data-newamp-visualizer-preset') === 'aurora' ? 'spectrum' : 'aurora';
      await openMenu();
      menuItem('mode').focus();
      menuKey(menuItem('mode'), 'ArrowRight');
      const modeRadio = await waitFor('Mode entry', () => menuItem('mode:' + modeTarget), 2000);
      modeRadio.click();
      const menuModePicked = await settles('mode picked from the menu', () =>
        liveStage().getAttribute('data-newamp-visualizer-preset') === modeTarget,
      );
      await sleep(100);
      const menuModeClosed = !document.querySelector('[data-newamp-viz-menu]');
      // Lock look flips Auto-VJ, and flips back. (A mode that is not Eviland has no
      // Director, so the lock is Auto-VJ being off.)
      await openMenu();
      const lockedBefore = menuItem('lock').getAttribute('aria-checked') === 'true';
      menuItem('lock').click();
      await sleep(150);
      const autoVjAfterFirst = liveStage().getAttribute('data-newamp-visualizer-auto-vj');
      await openMenu();
      const lockedAfter = menuItem('lock').getAttribute('aria-checked') === 'true';
      menuItem('lock').click();
      await sleep(150);
      const autoVjAfterSecond = liveStage().getAttribute('data-newamp-visualizer-auto-vj');
      const menuLockToggles =
        lockedAfter !== lockedBefore &&
        autoVjAfterFirst === (lockedBefore ? 'on' : 'off') &&
        autoVjAfterSecond === (lockedBefore ? 'off' : 'on');
      // The same preset dialog from the toolbar button: focus moves into it,
      // Escape closes it first and hands focus back to the button, and only a
      // second Escape leaves the visualizer.
      const toolbarToggle = await waitFor('preset toggle', () => document.querySelector('[data-newamp-viz-preset-picker-toggle]'));
      // Opened from the keyboard, the toggle has focus-visible and gets focus
      // back. (focusVisible is honoured where Chromium has it; elsewhere the
      // script focus is what it is, and the check follows what :focus-visible says.)
      toolbarToggle.focus({ focusVisible: true });
      const popoverOpenerFocusVisible = toolbarToggle.matches(':focus-visible');
      toolbarToggle.click();
      const picker = await waitFor('picker via toolbar', () => document.querySelector('[data-newamp-viz-preset-picker]'), 4000).catch(() => null);
      const toolbarMenu = !!picker;
      const popoverFocusIn = !!picker && picker.contains(document.activeElement);
      await sleep(200);
      escape();
      await sleep(300);
      const toolbarMenuClosed = !document.querySelector('[data-newamp-viz-preset-picker]');
      const popoverFocusReturned = document.activeElement === (popoverOpenerFocusVisible ? toolbarToggle : liveStage());
      const stageSurvivedToolbarEscape = !!liveStage();
      // Opened with the mouse, the pressed button has focus but not focus-visible.
      // Closing must leave focus on the stage, not the button: a focused button
      // turns the next Space into a press of that button instead of a pause.
      toolbarToggle.focus({ focusVisible: false });
      if (toolbarToggle.matches(':focus-visible')) toolbarToggle.blur();
      toolbarToggle.click();
      await waitFor('picker via mouse', () => document.querySelector('[data-newamp-viz-preset-picker]'), 4000).catch(() => null);
      await sleep(200);
      escape();
      await sleep(300);
      const popoverMouseOpenFocusOnStage =
        !document.querySelector('[data-newamp-viz-preset-picker]') && document.activeElement === liveStage();
      // Double-click flips the window on the bare stage only, never on a
      // control, and on the hover volume meter it sets 100%.
      const nativeBefore = liveStage().getAttribute('data-newamp-native-fullscreen');
      const doubleClick = (el) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
      const nextButton = await waitFor('next preset button', () => document.querySelector('[data-newamp-viz-next-button]'));
      const nowBlock = document.querySelector('[data-newamp-viz-now]');
      const meterInput = await waitFor('hover volume input', () => document.querySelector('[data-newamp-viz-volume-input]'));
      doubleClick(nextButton);
      if (nowBlock) doubleClick(nowBlock);
      // React tracks the value on the element itself, so go through the
      // prototype setter for the change to be seen.
      const setMeter = (value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(meterInput, String(value));
        meterInput.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const volumeBefore = meterInput.value;
      if (volumeBefore === '100') {
        setMeter(50);
        await settles('hover meter off 100%', () => meterInput.value === '50');
      }
      doubleClick(meterInput);
      await settles('hover meter volume reset', () => meterInput.value === '100');
      const meterDblclickVolume = Number(meterInput.value);
      await sleep(150);
      const dblclickOnControlKeepsWindow = liveStage().getAttribute('data-newamp-native-fullscreen') === nativeBefore;
      // Back to where the fixture's profile had it.
      setMeter(volumeBefore);
      // Positive control: on the bare stage the same double-click does flip the
      // window, and a second one flips it back.
      const bareStage = liveStage().querySelector('[data-newamp-visualizer-canvas]') || liveStage();
      doubleClick(bareStage);
      const dblclickOnStageFlips = await settles('stage double-click flips the window', () =>
        liveStage().getAttribute('data-newamp-native-fullscreen') !== nativeBefore,
      );
      doubleClick(bareStage);
      const dblclickOnStageFlipsBack = await settles('second double-click flips it back', () =>
        liveStage().getAttribute('data-newamp-native-fullscreen') === nativeBefore,
      );
      // Closing from the keyboard hands focus back to what opened the stage
      // when that was a keyboard-focused control; otherwise it falls to the page.
      escape();
      await waitFor('fullscreen visualizer closes on Escape', () =>
        document.querySelector('[data-newamp-fullscreen-visualizer]') ? null : true,
      );
      await sleep(150);
      const stageFocusReturned =
        document.activeElement === (openedFromKeyboard ? transportArtButton : document.body);
      transportArtButton.click();
      await waitFor('fullscreen visualizer reopens for the deck check', () =>
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
        rightClickMenu,
        rightClickMenuRole,
        rightClickMenuAtCursor,
        rightClickMenuRect,
        rightClickMenuFocused,
        rightClickMenuArrowMoved,
        rightClickMenuClosed,
        stageSurvivedRightClick,
        menuRightOpensSubmenu,
        menuWheelKept,
        menuLeftClosesSubmenu,
        menuEndFocusesLast,
        menuHomeFocusesFirst,
        menuTabCloses,
        menuModePicked,
        menuModeClosed,
        menuLockToggles,
        toolbarMenu,
        popoverFocusIn,
        toolbarMenuClosed,
        popoverOpenerFocusVisible,
        popoverFocusReturned,
        popoverMouseOpenFocusOnStage,
        stageSurvivedToolbarEscape,
        stageFocusedOnOpen,
        stageFocusedOnReopen,
        stageFocusReturned,
        ctrlArrowKeepsPreset,
        plainLKeepsTier,
        plainLDebug,
        plainVKeepsAutoVj,
        heldKeyIgnored,
        heldArrowSteps,
        sameTickArrowSteps,
        liteBurstQuality,
        dblclickOnControlKeepsWindow,
        dblclickOnStageFlips,
        dblclickOnStageFlipsBack,
        meterDblclickVolume,
        artDefault,
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
      // Back to the full window, then in again the way Discover's Deck button
      // does it: skin written first, deck code already loaded. A second sizing
      // call used to land after the deck's own and shrink it to 720x152, so
      // the size has to still hold a moment after it first matches.
      window.__newampSmoke.setCompactDeck(false);
      await waitFor('full window again', () => !document.querySelector('.compact-root, .deck-winamp-classic') && window.innerWidth >= 960);
      localStorage.setItem('newamp:deck:skinSchema', '2');
      localStorage.setItem('newamp:deck:skin', 'retro-tv');
      window.__newampSmoke.setCompactDeck(true);
      await waitFor('retro-tv deck on re-entry', () => document.querySelector('.deck-retro-tv'));
      await waitFor('retro-tv size on re-entry', () => {
        const box = measure();
        return Math.abs(box.width - 520) <= 12 && Math.abs(box.height - 430) <= 12 ? box : null;
      });
      await sleep(600);
      const tvReentry = measure();
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
        tvReentry,
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
      // By attribute, not label: the "Discovery" group heading is a button too,
      // and it comes first and contains the text "Discover".
      const discoverButton = await waitFor('Discover navigation', () =>
        document.querySelector('[data-newamp-nav="discover"]'),
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
      // The "?" next to the view title toggles the intro card: a fresh
      // profile starts with the card open, so the first click hides it and
      // the second brings it back.
      const helpCard = () => !!document.querySelector('[data-newamp-view-onboarding="discover"]');
      const helpDot = await waitFor('Discover help dot', () => document.querySelector('[data-newamp-view-help]'));
      const helpCardBefore = helpCard();
      helpDot.click();
      await sleep(150);
      const helpCardAfterFirstClick = helpCard();
      helpDot.click();
      await sleep(150);
      const helpCardAfterSecondClick = helpCard();
      return {
        ok: true,
        helpCardBefore,
        helpCardAfterFirstClick,
        helpCardAfterSecondClick,
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
      // Ctrl+K toggles, and its listener attaches a beat after the transport
      // appears, so a single early press can be lost. Press again only while
      // the palette is closed, and give each press time to fetch the palette,
      // which loads on first open. chordOpened is asserted by the smoke; the
      // hook below is a fallback for the rest of the run, not a pass.
      let chordOpened = false;
      for (let attempt = 0; attempt < 5 && !chordOpened; attempt += 1) {
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'k',
          code: 'KeyK',
          // Cmd+K on a Mac, where Ctrl+K stays with text fields.
          ...(navigator.platform.startsWith('Mac') ? { metaKey: true } : { ctrlKey: true }),
          bubbles: true,
          cancelable: true,
        }));
        chordOpened = !!(await waitFor(
          'Quick Play palette from Ctrl+K',
          () => document.querySelector('[data-newamp-quick-play]'),
          1500,
        ).catch(() => null));
      }
      if (!chordOpened) {
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
        chordOpened,
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

// Edits the queue from the Now Playing panel while a track plays: keyboard
// move, button move, drag-and-drop, Delete, then Clear. Every step records the
// row order plus which track the transport says is playing, so the smoke can
// assert the edits landed AND that none of them interrupted playback.
function uiQueueEditProbeSource(): string {
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
      const nav = async (name) => {
        const button = await waitFor(name + ' navigation', () =>
          Array.from(document.querySelectorAll('button')).find((item) => (item.textContent || '').includes(name)),
        );
        button.click();
      };
      const rows = () => Array.from(document.querySelectorAll('[data-newamp-now-playing-queue] [data-newamp-queue-row]'));
      const order = () => rows().map((row) => (/Queue (One|Two|Three)/.exec(row.textContent || '') || [])[1] || '?').join(',');
      const playing = () => document.querySelector('[data-newamp-current-title]')?.getAttribute('data-newamp-current-title') || '';
      const activeRow = () => (/Queue (One|Two|Three)/.exec(rows().find((row) => (row.textContent || '').includes('▶'))?.textContent || '') || [])[1] || null;
      const clock = () => Number(document.querySelector('[data-newamp-current-time]')?.getAttribute('data-newamp-current-time') || '0');
      const rowOf = (name) => rows().find((row) => (row.textContent || '').includes('Queue ' + name));
      const waitOrder = (expected) => waitFor('queue order ' + expected, () => (order() === expected ? expected : null), 4000);

      await nav('Library');
      const libraryRows = await waitFor('queue-edit library rows', () => {
        const items = Array.from(document.querySelectorAll('[data-newamp-track-row]'));
        return items.length >= 3 ? items : null;
      });
      // Column chooser: hide Year, walk Rating left of Time, and check the
      // header follows and the layout is remembered.
      const headerKeys = () =>
        Array.from(document.querySelectorAll('th[data-newamp-track-column]')).map((th) => th.getAttribute('data-newamp-track-column'));
      const columns = { initial: headerKeys().join(',') };
      document.querySelector('[data-newamp-track-columns-open]').click();
      const columnsMenu = await waitFor('columns menu', () => document.querySelector('[data-newamp-track-columns-menu]'));
      columnsMenu.querySelector('[data-newamp-track-columns-row="year"] input').click();
      await sleep(120);
      columns.afterHideYear = headerKeys().join(',');
      for (let i = 0; i < 3; i += 1) {
        columnsMenu.querySelector('[data-newamp-track-columns-row="rating"] [data-newamp-track-columns-left]').click();
        await sleep(60);
      }
      await sleep(120);
      columns.afterMoveRating = headerKeys().join(',');
      columns.rowCellsFollow = (() => {
        const row = document.querySelector('[data-newamp-track-row]');
        return row ? row.children.length === headerKeys().length : false;
      })();
      columns.persisted = (() => {
        try {
          const saved = JSON.parse(localStorage.getItem('newamp:track-table:columns') || 'null');
          return !!saved && saved.hidden.includes('year') && saved.order.indexOf('rating') < saved.order.indexOf('time');
        } catch {
          return false;
        }
      })();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(120);
      columns.menuClosed = !document.querySelector('[data-newamp-track-columns-menu]');

      const first = libraryRows.find((item) => /Queue One/.test(item.textContent || ''));
      if (!first) throw new Error('First fixture row was not found');
      first.scrollIntoView({ block: 'center' });
      first.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
      await waitFor('first track playing', () =>
        document.querySelector('[data-newamp-transport][data-newamp-playing="true"]') && /Queue One/.test(playing()),
      );

      await nav('Now Playing');
      await waitFor('now playing queue rows', () => (rows().length === 3 ? true : null));
      const steps = { initial: order(), columns };
      const startedAt = clock();

      // Keyboard: Alt+ArrowUp on the last row; focus must follow the track.
      const last = rowOf('Three');
      last.focus();
      last.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }));
      steps.afterKeyboardMove = await waitOrder('One,Three,Two');
      await sleep(80);
      steps.focusFollowed = /Queue Three/.test(document.activeElement?.textContent || '');

      // Button: move the PLAYING track down. It must keep playing.
      rowOf('One').querySelector('button[aria-label="Move down"]').click();
      steps.afterButtonMove = await waitOrder('Three,One,Two');
      steps.activeAfterButtonMove = activeRow();

      // Drag the last row onto the first.
      const dragged = rowOf('Two');
      const target = rowOf('Three');
      const dataTransfer = new DataTransfer();
      dragged.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      dragged.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }));
      steps.afterDrag = await waitOrder('Two,Three,One');

      // Delete removes a row that is not playing.
      const doomed = rowOf('Three');
      doomed.focus();
      doomed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
      steps.afterDelete = await waitOrder('Two,One');
      steps.activeAfterDelete = activeRow();
      steps.playingAfterEdits = playing();
      // The clock can sit at zero for a moment while the audio element starts.
      steps.clockAdvanced = !!(await waitFor('clock advancing', () => (clock() > startedAt ? true : null), 4000).catch(() => false));
      steps.stillPlaying = !!document.querySelector('[data-newamp-transport][data-newamp-playing="true"]');

      // Move a queued file to the Recycle Bin / Trash from the library (the
      // right-click menu's action, called directly: the menu is native). The
      // row leaves the table, the queue drops it, and playback carries on.
      await nav('Library');
      const doomedRow = await waitFor('library row for Queue Two', () =>
        document.querySelector('[data-newamp-track-row][data-track-title="Queue Two"]'),
      );
      const doomedId = Number(doomedRow.getAttribute('data-track-id'));
      const doomedTrack = await window.newamp.getTrack(doomedId);
      const trashResult = await window.newamp.trashTracks([doomedId]);
      await waitFor('library row gone', () =>
        (document.querySelector('[data-newamp-track-row][data-track-title="Queue Two"]') ? null : true), 6000);
      steps.trash = {
        path: doomedTrack ? doomedTrack.path : null,
        trashed: trashResult.trashed,
        removed: trashResult.removed,
        failed: trashResult.failed.length,
        cancelled: trashResult.cancelled,
        libraryRowsAfter: document.querySelectorAll('[data-newamp-track-row]').length,
      };
      await nav('Now Playing');
      await waitFor('queue without Queue Two', () => (rows().length === 1 ? true : null), 6000);
      steps.trash.queueAfter = order();
      steps.trash.playingAfter = playing();
      steps.trash.stillPlayingAfter = !!document.querySelector('[data-newamp-transport][data-newamp-playing="true"]');

      // Clear is two-step (arm, then confirm). A second click inside the
      // double-click time is part of the arming gesture and must not confirm.
      const clear = () => document.querySelector('[data-newamp-now-playing-queue] [data-newamp-confirm]');
      clear().click();
      await sleep(80);
      steps.rowsWhileArmed = rows().length;
      clear().click();
      await sleep(80);
      steps.rowsAfterDoubleClick = rows().length;
      await sleep(600);
      clear().click();
      await waitFor('empty queue', () => (rows().length === 0 ? true : null), 4000);
      steps.afterClear = rows().length;
      return { ok: true, ...steps };
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
  revealWhenReady(win, () => win.show(), { platform: process.platform });
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
  const dailyBackups = await listDailyBackups(userData);
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
    recoveryEvents: [...settings.recoveryEvents, ...library.recoveryEvents, ...podcastStore.recoveryEvents],
    dailyBackups: { count: dailyBackups.length, newestAt: dailyBackups[0]?.createdAt ?? null, folder: join(userData, 'backups') },
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
  // A suppressed store (see SettingsStore.isSuppressed()) is running on
  // in-memory defaults because settings.json could not be read — its empty
  // libraryRoots is not "nothing configured", it's "unknown". Auto-seeding
  // here would scan a default folder straight into the real library.db
  // (a completely different, unsuppressed store) even though the user's
  // real settings.json was never actually read this launch.
  if (!smokeMode && !settings.isSuppressed() && !current.libraryRoots.length) {
    if (process.platform === 'darwin') {
      for (const c of [app.getPath('music'), ...safeListMacVolumesMusic()]) {
        try {
          if (existsSync(c) && statSync(c).isDirectory()) {
            settings.set({ libraryRoots: [c] });
            break;
          }
        } catch {
          /* ignore */
        }
      }
    } else {
      // The same folders the empty library offers, so what is scanned first
      // is what the screen suggests. The shared Public Music folder is never one.
      const roots = defaultMusicScanRoots({ fallbackMusicPath: app.getPath('music') });
      if (roots.length) settings.set({ libraryRoots: roots });
    }
  }

  library = await LibraryStore.open(join(userData, 'library.db'));

  // Earlier builds seeded a first run with C:/Users/Public/Music, which is
  // almost always empty. When that is all there is and nothing was ever
  // scanned, start the choice over.
  if (!smokeMode && !settings.isSuppressed()) {
    let trackCount = 0;
    try {
      trackCount = library.getTrackCount();
    } catch {
      trackCount = -1;
    }
    if (isSeededPublicMusicRoot(settings.get().libraryRoots, trackCount)) {
      settings.set({ libraryRoots: defaultMusicScanRoots({ fallbackMusicPath: app.getPath('music') }) });
    }
  }
  scanner = createScannerService(library);
  libraryWatcher = createLibraryWatcherService();

  registerAudioProtocol();
  registerIpc();
  registerDisplayWatchers();
  installPermissionHandlers(session.defaultSession, {
    allowedOrigins: isDev ? ['newamp-app://app', 'http://localhost:5173'] : ['newamp-app://app'],
    onDenied: (denial) => writeDiagnosticEvent('permission-denied', { ...denial }),
  });

  createStartupSplashWindow();
  mainWin = createWindow();
  installApplicationMenu();
  registerTray();
  registerMediaShortcuts();
  syncLibraryWatcher();
  startLibraryAnalysis();
  // Linux and macOS announce a shutdown through the power monitor instead.
  powerMonitor.on('shutdown', flushAllStores);
  // A Mac stops the sound when it sleeps and Chromium starts it again on wake,
  // so music would come back on its own when the lid opens. Pause instead, as
  // Music does.
  if (process.platform === 'darwin') {
    powerMonitor.on('suspend', () => {
      if (shellPlaybackState.isPlaying) sendPlayerCommand('pause');
    });
  }
  scheduleDailyBackups();

  // A valid library this build could not upgrade is left untouched and the
  // session runs on a temporary one. Say so up front: anything done this
  // session is not saved.
  if (library.upgradeError && !smokeMode) {
    void dialog.showMessageBox(mainWin, {
      type: 'warning',
      title: 'Library not upgraded',
      message: 'NewAmp could not upgrade your library.',
      detail: `${library.upgradeError}\n\nThis session uses a temporary library and nothing in it will be saved. NewAmp will try the upgrade again the next time it starts.`,
    });
  }

  // Same idea as the library-upgrade notice above, for a settings/podcasts
  // file that could not be read at all this launch (see isSuppressed() on
  // each store) — silent degradation here is what let a locked file quietly
  // reset volume, library roots and subscriptions in memory with nobody the
  // wiser until they noticed something was missing.
  if ((settings.isSuppressed() || podcastStore.isSuppressed()) && !smokeMode) {
    const detail = [
      settings.isSuppressed() ? `Settings: ${settings.recoveryEvents.at(-1)?.reason ?? 'file unavailable'}` : null,
      podcastStore.isSuppressed() ? `Podcasts: ${podcastStore.recoveryEvents.at(-1)?.reason ?? 'file unavailable'}` : null,
    ].filter((line): line is string => !!line).join('\n');
    void dialog.showMessageBox(mainWin, {
      type: 'warning',
      title: 'Some data could not be read',
      message: 'NewAmp could not read part of your saved data this launch.',
      detail: `${detail}\n\nThis session uses defaults for the affected data. Changing it will start saving again automatically once the file is readable; nothing already on disk has been touched.`,
    });
  }

  // Auto-scan on launch if the library is empty and roots are configured
  mainWin.webContents.once('did-finish-load', () => {
    // This runs before the window is ever shown, so anything that throws here
    // escapes as an uncaught exception and kills the app with no window and no
    // dialog — it just never opens. Treat an unreadable library as an empty one
    // and let the auto-scan below rebuild it.
    let trackCount = 0;
    try {
      trackCount = library.getTrackCount();
    } catch (err) {
      writeDiagnosticEvent('library-stats-unavailable', { error: String(err) });
    }
    const roots = settings.get().libraryRoots;
    let scanPromise = Promise.resolve();
    // A suppressed settings store never has real roots to scan (its roots
    // are always the empty default) — this guard is defense in depth against
    // scanning a phantom root into the real library.db, matching the
    // auto-seed guard above.
    if (!settings.isSuppressed() && roots.length && (trackCount === 0 || settings.get().libraryAutoWatch)) {
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
    } else if (uiQueueEditSmoke && mainWin) {
      void runUiQueueEditSmoke(mainWin, scanPromise);
    } else if (uiLyricsSmoke && mainWin) {
      void runUiLyricsSmoke(mainWin, scanPromise);
    } else if (uiVisualizerSmoke && mainWin) {
      void runUiVisualizerSmoke(mainWin, scanPromise);
    } else if (uiDetachedVizSmoke && mainWin) {
      void runUiDetachedVizSmoke(mainWin, scanPromise);
    } else if (uiDeckSmoke && mainWin) {
      void runUiDeckSmoke(mainWin);
    } else if (uiWheelVolumeSmoke && mainWin) {
      void runUiWheelVolumeSmoke(mainWin);
    } else if (uiArtSmoke && mainWin) {
      void runUiArtSmoke(mainWin, scanPromise);
    } else if (uiDiscoverSmoke && mainWin) {
      void runUiDiscoverSmoke(mainWin);
    } else if (exclusiveUiSmoke && mainWin) {
      void runExclusiveUiSmoke(mainWin, scanPromise);
    } else if (screenshotGallery && mainWin) {
      void runScreenshotGallery(mainWin, scanPromise);
    } else {
      // Home asks for the health check as soon as it opens. Once the startup
      // scan has settled, work it out in the background so that request finds
      // it done. It runs in slices, so nothing waits on it.
      void scanPromise.then(() => library.getLibraryHealthAsync()).catch(() => undefined);
    }
  });
}

const singleInstanceLock = app.requestSingleInstanceLock();

let flushingStores = false;

// The stores batch their writes: edits and the resume position wait 800 ms, plays
// and skips up to 30 s. A log-off, a shutdown or a crash does not wait for those
// timers, so each of those paths lands everything first. One store failing must
// not keep the others from being written, and a throw inside a flush must not
// bring the handler that called it back here.
function flushAllStores(): void {
  if (flushingStores) return;
  flushingStores = true;
  try {
    const flushes: Array<[string, () => void]> = [
      ['library', () => library?.flushNow()],
      ['settings', () => settings?.flushSync()],
      ['podcasts', () => podcastStore?.flushProgressSync()],
    ];
    for (const [name, flush] of flushes) {
      try {
        flush();
      } catch (err) {
        console.error(`[newamp] ${name} flush failed`, err);
      }
    }
  } finally {
    flushingStores = false;
  }
}

process.on('uncaughtException', (err, origin) => {
  writeDiagnosticEvent('main-uncaught-exception', { origin, error: err });
  console.error('[newamp] uncaught exception', err);
  flushAllStores();
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
  // software rendering instead of crash-looping on the GPU. A clean exit, or
  // one during quit, is not a crash and must not cost the next launch its GPU.
  if (details.type === 'GPU' && !smokeMode && !isQuitting && details.reason !== 'clean-exit') {
    try {
      writeFileSync(gpuCrashSentinel, `${new Date().toISOString()} ${details.reason}\n`, 'utf8');
    } catch {
      /* best effort */
    }
  }
});

app.on('gpu-info-update', publishGpuCompositing);
void app.whenReady().then(() => {
  setTimeout(() => {
    if (!gpuCompositingSettled) publishGpuCompositing();
  }, 5000);
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
    // The window is usually hidden in the Dock now; a document that starts
    // playing should bring it forward. Not before the first reveal, though:
    // that would skip the splash.
    if (mainWindowRevealed) showMainWindow();
  });

  app.whenReady().then(bootstrap).catch((err) => {
    console.error('Bootstrap failed:', err);
    const message = err instanceof Error ? err.message : String(err);
    writeDiagnosticEvent('bootstrap-failed', { error: message });
    // A packaged app has no console — without this, a failure here (e.g. a
    // locked library.db that stayed busy through every retry) just closes
    // silently and looks like the app never launched at all.
    dialog.showErrorBox(
      'NewAmp could not start',
      err instanceof LibraryUnavailableError ? message : `NewAmp could not start: ${message}`,
    );
    app.exit(1);
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

// The display-sleep blocker follows which windows are on screen, including the
// detached projector, which is created far from here.
app.on('browser-window-created', (_event, created) => {
  // Windows tells each window when the user is logging off or the machine is
  // restarting, and ends the process soon after.
  created.on('session-end', flushAllStores);
  created.on('show', refreshDisplaySleepBlocker);
  created.on('hide', refreshDisplaySleepBlocker);
  created.on('minimize', refreshDisplaySleepBlocker);
  created.on('restore', refreshDisplaySleepBlocker);
  created.on('closed', refreshDisplaySleepBlocker);
});

app.on('will-quit', (event) => {
  globalShortcut.unregisterAll();
  closeStartupSplashWindow();
  if (displaySleepBlockerId !== null) {
    powerSaveBlocker.stop(displaySleepBlockerId);
    displaySleepBlockerId = null;
  }
  libraryWatcher?.stop();
  scanner?.cancel();
  void libraryAnalysis?.stop();
  // Explicit Quit / Cmd+Q bypass window-all-closed. Flush on the actual quit
  // path, after renderer windows have had their final chance to save state.
  // A library that cannot flush (its file is locked) must not take the
  // settings and podcast writes down with it.
  try {
    library?.close();
  } catch (err) {
    console.error('[newamp] library close failed', err);
  }
  settings?.flushSync();
  podcastStore?.flushProgressSync();
  exclusiveOutput?.dispose();
  tray?.destroy();
  tray = null;
  // No orphan ffmpeg.exe should outlive the app.
  killAllDnaFfmpeg();
  killAllAnalysisFfmpeg();
  killAllScoreFfmpeg();
  killAllWaveformFfmpeg();
  killAllTranscodeFfmpeg();
  closeAllGaplessSessions();
  // radioBrain.stop() is async but bounded (a few hundred ms even with a
  // connected /now/events client) — hold the quit open just long enough to
  // release its listening socket instead of leaving it bound past exit.
  if (radioBrain && !radioBrainShutdownStarted) {
    radioBrainShutdownStarted = true;
    event.preventDefault();
    radioBrain
      .stop()
      .catch((err) => console.warn('[newamp] radio brain failed to stop on quit:', err))
      .finally(() => app.quit());
  }
});

app.on('window-all-closed', () => {
  if (shouldStayResidentOnWindowAllClosed({ isQuitting, hasTray: !!tray, platform: process.platform })) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWin && !mainWin.isDestroyed()) {
    showMainWindow();
  } else {
    mainWin = createWindow();
  }
});
