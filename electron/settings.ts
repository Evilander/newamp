import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { basename, dirname, join, posix, win32 } from 'node:path';
import type { AppSettings, PlaybackResumeQueueEntry, PlaybackResumeServerTrack, RecoveryEvent } from '../shared/types.js';
import { normalizePlaybackRate } from '../shared/tempo-trainer.js';
import { normalizeAutoDjTarget } from '../shared/auto-dj.js';
import { normalizeAudioOutputDeviceId } from '../shared/audio-output.js';
import { normalizeLimiterEnabled, normalizePreampDb } from '../shared/audio-limiter.js';
import { FLAT_EQ_VALUES, normalizeEqValues } from '../shared/eq-presets.js';
import { BUILT_IN_THEMES, normalizeCustomSkin } from '../shared/custom-skin.js';
import { parseMusicServerStreamUrl } from '../shared/music-servers.js';
import { emptyWindowState, normalizeWindowState } from './window-state.js';
import { emptyDeskWidgetState, normalizeDeskWidgetState } from './desk-widget.js';
import {
  atomicWriteFileSync,
  durableWriteFileAsync,
  findUnsavedTempCopies,
  isUnreadableFileError,
  quarantineCorruptFile,
  readFileSyncRetrying,
  recoveryReason,
  renameOverExistingSync,
  suppressedRecoveryEvent,
  sweepOrphanedTempFiles,
} from './recovery.js';

const DEFAULTS: AppSettings = {
  libraryRoots: [],
  libraryAutoWatch: true,
  theme: 'classic',
  customSkin: null,
  lastfmEnabled: false,
  lastfmApiKey: null,
  lastfmSharedSecret: null,
  lastfmSessionKey: null,
  lastfmUsername: null,
  lastfmAuthToken: null,
  openaiApiKey: null,
  openaiModel: 'gpt-5.4-mini',
  firstLaunchTutorialSeen: false,
  textScale: 1,
  crossfadeMs: 0,
  replayGain: 'off',
  limiterEnabled: true,
  preampDb: 0,
  resumeState: null,
  compactMode: false,
  alwaysOnTop: false,
  visualizerPreset: 'eviland-live',
  volume: 0.75,
  playbackRate: 1,
  audioOutputDeviceId: null,
  autoDjEnabled: false,
  autoDjTarget: 24,
  autoDjSmartRuleId: null,
  equalizer: [...FLAT_EQ_VALUES],
  eqEnabled: false,
  radioBrainEnabled: false,
  radioBrainPort: 17117,
  radioBrainToken: null,
  audioBitPerfectPath: false,
  audioPreferredSampleRate: null,
  bitPerfectExclusive: false,
  bitPerfectExclusiveDeviceId: null,
  sampleAccurateGapless: true,
  closeButtonBehavior: 'minimize-to-tray',
  trayNoticeShown: false,
  autoBackupEnabled: true,
  windowState: emptyWindowState(),
  deskWidget: emptyDeskWidgetState(),
  performanceTier: 'auto',
  ambientReactivity: 'auto',
  waveformSeekBar: true,
  backgroundAnalysis: true,
};

// A fresh copy of the defaults for a store's state, so nothing a caller does
// to the arrays and objects it gets back can reach the module-level DEFAULTS.
function freshDefaults(): AppSettings {
  return {
    ...DEFAULTS,
    libraryRoots: [],
    equalizer: [...DEFAULTS.equalizer],
    windowState: emptyWindowState(),
    deskWidget: emptyDeskWidgetState(),
  };
}

// Only keys the app defines are kept, on load and on every patch: a renderer
// call or a hand-edited file cannot grow settings.json with keys of its own.
function pickKnownSettings(source: object): Partial<AppSettings> {
  const known: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) known[key] = (source as Record<string, unknown>)[key];
  }
  return known as Partial<AppSettings>;
}

// Single-key patches that arrive many times a second (state saved as playback
// moves, a slider being dragged) and go through the debounced write; flushSync()
// writes whatever is pending on quit.
const HOT_PATCH_KEYS = new Set<string>(['resumeState', 'windowState', 'deskWidget', 'preampDb', 'textScale']);

const MAX_LIBRARY_ROOTS = 256;

// Roots decide which files the protocol handler will serve, so a value that
// is not an array of absolute paths must never get through: a string would
// throw in the authorizer's loop and a relative entry would match nothing
// sensible. Either path style counts as absolute, since a profile can come
// over from another platform and its roots should survive the trip back.
// `ignored`, when given, collects what was left out, as text for a log line.
function normalizeLibraryRoots(value: unknown, ignored?: string[]): string[] {
  if (!Array.isArray(value)) {
    if (value !== undefined) ignored?.push(`${value === null ? 'null' : typeof value} where a list of folders belongs`);
    return [];
  }
  const roots: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry || entry.length > 4096 || entry.includes('\0') || (!posix.isAbsolute(entry) && !win32.isAbsolute(entry))) {
      ignored?.push(typeof entry === 'string' ? JSON.stringify(entry.slice(0, 100)) : typeof entry);
      continue;
    }
    if (!roots.includes(entry)) roots.push(entry);
    if (roots.length >= MAX_LIBRARY_ROOTS) break;
  }
  return roots;
}

// The slider's boost range tops out at 2 (VOLUME_BOOST_MAX in the renderer).
function normalizeVolume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : fallback;
}

// Matches the engine's own clamp.
function normalizeCrossfadeMs(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(12000, Math.max(0, Math.round(value))) : fallback;
}

function normalizeReplayGain(value: unknown): AppSettings['replayGain'] {
  return value === 'track' || value === 'album' ? value : 'off';
}

function normalizeTheme(value: unknown): AppSettings['theme'] {
  return value === 'custom' || BUILT_IN_THEMES.includes(value as never) ? (value as AppSettings['theme']) : DEFAULTS.theme;
}

// A stored skin written by an older build can hold values the current grammar
// refuses (anything that is not a colour or a bounded length). They are
// dropped, but never silently: the log names each one so a user whose skin
// changed after an upgrade can find out why.
function loadCustomSkin(raw: unknown): AppSettings['customSkin'] {
  const skin = normalizeCustomSkin(raw);
  const rawVariables = (raw as { variables?: unknown } | null)?.variables;
  if (skin && rawVariables && typeof rawVariables === 'object') {
    const dropped = Object.keys(rawVariables as Record<string, unknown>).filter((key) => !(key in skin.variables));
    if (dropped.length) {
      console.warn(`[newamp] custom skin: ${dropped.length} value(s) are not valid colours or lengths and were removed: ${dropped.join(', ')}`);
    }
  }
  return skin;
}

function normalizePreferredSampleRate(value: unknown): number | null {
  if (value == null) return null;
  const rate = Math.trunc(Number(value));
  const ALLOWED = new Set([44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000]);
  return ALLOWED.has(rate) ? rate : null;
}

function normalizeExclusiveDeviceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  // Hex-encoded ma_device_id from the native addon.
  return /^[0-9a-f]{2,1024}$/.test(trimmed) ? trimmed : null;
}

function normalizeRadioBrainPort(value: unknown): number {
  const port = Math.trunc(Number(value));
  if (Number.isFinite(port) && port >= 1024 && port <= 65535) return port;
  return DEFAULTS.radioBrainPort;
}

function normalizeAutoDjSmartRuleId(value: unknown): number | null {
  const id = Math.trunc(Number(value));
  return Number.isFinite(id) && id > 0 ? id : null;
}

function normalizeVisualizerPreset(value: unknown): AppSettings['visualizerPreset'] {
  const preset = String(value);
  return [
    'butterchurn',
    'galaxy',
    'aurora',
    'spectrum',
    'oscilloscope',
    'radial',
    'tunnel',
    'pulse',
    'orbital-rings',
    'neon-waves',
    'neon-ribbons',
    'plasma-grid',
    'prism-bars',
    'confetti',
    'burning-cloud',
    'tempo-pulse',
    'lattice-strobe',
    'liquid-mercury',
    'particle-flow',
    'eviland',
    'eviland-live',
    'kaleido-bloom',
    'liquid-aurora-storm',
    'fractal-pulse',
    'starfield-warp',
    'spectral-tunnel',
    'album-breathe',
  ].includes(preset)
    ? (preset as AppSettings['visualizerPreset'])
    : DEFAULTS.visualizerPreset;
}

function normalizeOptionalSecret(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 4096) : null;
}

function normalizeOpenAiModel(value: unknown): string {
  if (typeof value !== 'string') return DEFAULTS.openaiModel;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9._:-]{1,80}$/.test(trimmed) ? trimmed : DEFAULTS.openaiModel;
}

export function withAiAssistRuntime(settings: AppSettings, env: NodeJS.ProcessEnv = process.env): AppSettings {
  const gateway = !!env.NEWAMP_OPENAI_BASE_URL;
  const key = gateway ? env.NEWAMP_OPENAI_API_KEY : settings.openaiApiKey;
  return {
    ...settings,
    aiAssistRuntime: {
      ready: !!key?.trim(),
      mode: gateway ? 'gateway' : 'api',
      model: normalizeOpenAiModel(gateway ? env.NEWAMP_OPENAI_MODEL || settings.openaiModel : settings.openaiModel),
    },
  };
}

function normalizeTextScale(value: unknown): number {
  const scale = Number(value);
  return Number.isFinite(scale) ? Math.min(1.35, Math.max(0.85, scale)) : DEFAULTS.textScale;
}

function normalizeCloseButtonBehavior(value: unknown): AppSettings['closeButtonBehavior'] {
  return value === 'close-app' ? 'close-app' : 'minimize-to-tray';
}

function normalizePerformanceTier(value: unknown): AppSettings['performanceTier'] {
  return value === 'high' || value === 'lite' ? value : 'auto';
}

function normalizeAmbientReactivity(value: unknown): AppSettings['ambientReactivity'] {
  return value === 'on' || value === 'off' ? value : 'auto';
}

const MAX_RESUME_QUEUE_LENGTH = 5000;

// A queue longer than the cap is cut to a window centred on the current index,
// not to its head: with Play All on a big library the track that was playing
// sits far past the first 5000 entries, and keeping the head restored the
// wrong track at 0:00. Cutting before any mapping also keeps the work on the
// ~3 s autosave bounded by the cap rather than by the library. `start` is
// where the window begins in the original queue, for rebasing the index.
function windowResumeEntries<T>(entries: readonly T[], index: number): { items: T[]; start: number } {
  if (entries.length <= MAX_RESUME_QUEUE_LENGTH) return { items: [...entries], start: 0 };
  const centred = Math.max(0, index) - Math.floor(MAX_RESUME_QUEUE_LENGTH / 2);
  const start = Math.min(entries.length - MAX_RESUME_QUEUE_LENGTH, Math.max(0, centred));
  return { items: entries.slice(start, start + MAX_RESUME_QUEUE_LENGTH), start };
}

function normalizeResumeTrackId(value: unknown, allowServerTrack = false): number | null {
  const id = Math.trunc(Number(value));
  if (!Number.isSafeInteger(id)) return null;
  if (id > 0) return id;
  return allowServerTrack && id < 0 ? id : null;
}

function normalizeResumeText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return text || fallback;
}

function normalizeResumeNullableText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return text || null;
}

function normalizeResumeOptionalNumber(value: unknown): number | null {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function normalizeResumeOptionalInteger(value: unknown): number | null {
  if (value == null) return null;
  const num = Math.trunc(Number(value));
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function parseResumeMusicServerPath(value: unknown): { path: string; connectionId: string; itemId: string } | null {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  if (!path) return null;
  try {
    const url = new URL(path);
    if (url.search || url.hash) return null;
    const parsed = parseMusicServerStreamUrl(path);
    return { path, connectionId: parsed.connectionId, itemId: parsed.itemId };
  } catch {
    return null;
  }
}

function normalizeResumeServerTrack(value: unknown, parsedPath: { path: string; connectionId: string; itemId: string }): PlaybackResumeServerTrack | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = normalizeResumeTrackId(raw.id, true);
  if (id === null || id > 0) return null;
  return {
    id,
    path: parsedPath.path,
    title: normalizeResumeText(raw.title, 'Unknown Title'),
    artist: normalizeResumeText(raw.artist, 'Unknown Artist'),
    album: normalizeResumeText(raw.album, 'Unknown Album'),
    albumArtist: normalizeResumeText(raw.albumArtist, 'Unknown Artist'),
    trackNo: normalizeResumeOptionalInteger(raw.trackNo),
    discNo: normalizeResumeOptionalInteger(raw.discNo),
    year: normalizeResumeOptionalInteger(raw.year),
    genre: normalizeResumeNullableText(raw.genre),
    duration: normalizeResumeOptionalNumber(raw.duration),
    bitrate: normalizeResumeOptionalNumber(raw.bitrate),
    sampleRate: normalizeResumeOptionalNumber(raw.sampleRate),
    size: normalizeResumeOptionalNumber(raw.size),
  };
}

function normalizeResumeQueueEntry(value: unknown): PlaybackResumeQueueEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'local') {
    const trackId = normalizeResumeTrackId(raw.trackId);
    return trackId === null ? null : { kind: 'local', trackId };
  }
  if (raw.kind !== 'music-server') return null;
  const parsedPath = parseResumeMusicServerPath((raw.track as Record<string, unknown> | null | undefined)?.path);
  if (!parsedPath || raw.connectionId !== parsedPath.connectionId || raw.itemId !== parsedPath.itemId) return null;
  const track = normalizeResumeServerTrack(raw.track, parsedPath);
  return track ? { kind: 'music-server', connectionId: parsedPath.connectionId, itemId: parsedPath.itemId, track } : null;
}

function resumeEntryTrackId(entry: PlaybackResumeQueueEntry): number {
  return entry.kind === 'local' ? entry.trackId : entry.track.id;
}

const SUPPRESSION_RETRY_INTERVAL_MS = 10_000;

const PERSIST_DELAY_MS = 800;
const PERSIST_RETRY_MAX_MS = 30_000;

// Name prefix of the rolling copies support-backup.ts writes under
// <userData>/backups; the stamp in the name sorts oldest to newest.
const DAILY_BACKUP_PREFIX = 'newamp-daily-';

// settings.json from each daily backup, newest first.
function dailyBackupSettingsFiles(userDataPath: string): string[] {
  const backupsRoot = join(userDataPath, 'backups');
  try {
    return readdirSync(backupsRoot)
      .filter((name) => name.startsWith(DAILY_BACKUP_PREFIX))
      .sort()
      .reverse()
      .map((name) => join(backupsRoot, name, 'settings.json'));
  } catch {
    return [];
  }
}

export class SettingsStore {
  public readonly recoveryEvents: RecoveryEvent[] = [];
  private state: AppSettings;
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  // Guards the async (tmp+rename) persist path: at most one write in flight,
  // with a flag to re-run immediately after if more changes land while it's
  // writing (same pattern as LibraryStore's flushAsync).
  private persistInFlight: Promise<void> | null = null;
  private persistAgain = false;
  // Bumped by every persist (sync or async) that captures a state snapshot, so
  // a synchronous quit-path flush (newer data) can never be clobbered by a
  // slower async write (older data) landing after it.
  private persistSeq = 0;
  // Writes that failed since one last landed; the first of a run is reported.
  private failedWrites = 0;
  // Set when the file stayed locked through the whole startup retry budget
  // in the constructor below: it was never actually read, so `state` is
  // in-memory defaults only. persist()/persistAsync()/flushSync() all check
  // this and skip the write for the rest of the session — writing here would
  // bury the untouched original under a state that never really loaded it.
  private persistenceSuppressed = false;
  // The lock that caused the above may have cleared by the time the user
  // changes anything, so set() tries tryLiftSuppression() again — but at most
  // once per SUPPRESSION_RETRY_INTERVAL_MS. The first set() is often the
  // resume-state autosave a few seconds after launch, while the lock is still
  // held; one failed attempt used to leave the whole session unsaved.
  private lastSuppressionRetryAt: number | null = null;
  // Patches made while suppressed change `state` but are never written. When
  // the file becomes readable again they are laid back over what it holds, so
  // the real settings don't replace them silently.
  private suppressedPatch: Partial<AppSettings> = {};
  // The copy of an earlier session that this session's settings were taken from.
  private restoredFrom: string | null = null;

  // `onWriteFailed` hears about the first failed write of a run of them (a full
  // or read-only disk, a lock that outlasts the retries), so the user can be told.
  constructor(
    private readonly file: string,
    private readonly onWriteFailed?: (event: RecoveryEvent) => void,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      let raw: string;
      try {
        raw = readFileSyncRetrying(file);
      } catch (err) {
        if (!isUnreadableFileError(err)) throw err;
        // The file stayed locked (EBUSY/EPERM/EAGAIN/EACCES/EMFILE), or is
        // unreadable for a filesystem reason that won't clear on retry
        // (EIO/EISDIR). Neither is evidence of corruption — the old catch
        // below used to quarantine on exactly this and adopt DEFAULTS,
        // resetting volume, library roots and account state on an ordinary
        // transient lock, or crash bootstrap outright on EIO/EISDIR. Run
        // this session on in-memory defaults instead and never persist over
        // the untouched original.
        console.warn(`[newamp] settings: ${file} could not be read; running this session without saving.`, err);
        this.state = freshDefaults();
        this.persistenceSuppressed = true;
        this.recoveryEvents.push(suppressedRecoveryEvent('settings', file, err));
        return;
      }
      let corrupt = false;
      const ignoredRoots: string[] = [];
      try {
        this.state = this.parseSettingsJson(raw, ignoredRoots);
      } catch (err) {
        corrupt = true;
        this.state = this.recoverFromCorruptFile(err);
        this.persistOrDefer();
      }
      if (!corrupt) {
        const unsaved = this.loadUnsavedCopy();
        if (unsaved) {
          this.state = this.adoptUnsavedCopy(unsaved);
          this.persistOrDefer();
        } else if (ignoredRoots.length) {
          this.noteIgnoredRoots(ignoredRoots);
        } else {
          this.saveLastGood(raw);
        }
      }
    } else {
      const unsaved = this.loadUnsavedCopy();
      this.state = unsaved ? this.adoptUnsavedCopy(unsaved) : freshDefaults();
      this.persistOrDefer();
    }
    // Writes that were cut short by a crash leave temp files whose pid no
    // later launch matches. The library sweeps its own, once library.db loads.
    sweepOrphanedTempFiles(dirname(file));
    this.noteKeptCopies();
  }

  // A replace that failed in an earlier session (antivirus, a sync client)
  // leaves a whole copy of the file beside it, newer than the file itself (see
  // recovery.ts). The newest such copy of settings.json that is newer than the
  // file and loads like any settings file, field by field.
  private loadUnsavedCopy(): { state: AppSettings; source: string } | null {
    let fileModifiedAt = -1;
    try {
      fileModifiedAt = statSync(this.file).mtimeMs;
    } catch {
      /* no file: any copy is newer */
    }
    for (const { tempPath, targetPath } of findUnsavedTempCopies(dirname(this.file))) {
      if (basename(targetPath) !== basename(this.file)) continue;
      try {
        if (statSync(tempPath).mtimeMs <= fileModifiedAt) continue;
        return { state: this.parseSettingsJson(readFileSync(tempPath, 'utf-8')), source: tempPath };
      } catch {
        // Unreadable or not settings: it is reported with the other copies kept.
      }
    }
    return null;
  }

  // The copy stays where it is: the next launch sweeps it once the file it
  // would have replaced is newer.
  private adoptUnsavedCopy(unsaved: { state: AppSettings; source: string }): AppSettings {
    this.restoredFrom = unsaved.source;
    this.recoveryEvents.push({
      store: 'settings',
      filePath: this.file,
      backupPath: unsaved.source,
      reason: 'settings were restored from an unsaved copy left by an earlier session',
      recoveredAt: Date.now(),
    });
    return unsaved.state;
  }

  // Whole copies of the profile's files that an earlier session could not move
  // into place and that nothing here used: they may hold the only copy of
  // something, so they are left and listed.
  private noteKeptCopies(): void {
    for (const { tempPath, targetPath } of findUnsavedTempCopies(dirname(this.file))) {
      if (tempPath === this.restoredFrom) continue;
      this.recoveryEvents.push({
        store: basename(targetPath) === 'podcasts.json' ? 'podcasts' : 'settings',
        filePath: targetPath,
        backupPath: tempPath,
        reason: 'an unsaved copy of this file from an earlier session was kept',
        recoveredAt: Date.now(),
      });
    }
  }

  // Reaching here means the bytes were actually read — this is confirmed
  // invalid content (bad JSON, or a shape normalize/parse can't make sense of
  // at all), not an I/O error, so quarantining is the right call. The user's
  // roots and keys are still worth more than defaults, so the newest copy that
  // parses is used before those.
  private recoverFromCorruptFile(err: unknown): AppSettings {
    const event = quarantineCorruptFile(this.file, 'settings', recoveryReason(err));
    const recovered = this.loadRecoveredSettings();
    if (recovered) this.restoredFrom = recovered.source;
    if (event) {
      if (recovered) event.reason = `${event.reason}; settings were restored from ${recovered.source}`;
      this.recoveryEvents.push(event);
    }
    return recovered?.state ?? freshDefaults();
  }

  // Library folders the file named that cannot be folders (a relative path, a
  // "~/Music") are left out of the settings. The file stays as it is so they
  // can be corrected by hand, and the last-good copy, which may still hold the
  // folders, is not replaced by a state without them.
  private noteIgnoredRoots(ignored: string[]): void {
    const shown = ignored.slice(0, 5).join(', ') + (ignored.length > 5 ? ` and ${ignored.length - 5} more` : '');
    console.warn(`[newamp] settings: ${this.file}: library folders ignored: ${shown}`);
    this.recoveryEvents.push({
      store: 'settings',
      filePath: this.file,
      backupPath: this.file,
      reason: `library folders ignored (each must be an absolute path): ${shown}`,
      recoveredAt: Date.now(),
    });
  }

  // The last settings.json that loaded cleanly, kept beside it so a file that
  // later turns up corrupt does not cost the user everything in it. Best
  // effort: failing to write it must never fail startup.
  private saveLastGood(raw: string): void {
    try {
      atomicWriteFileSync(`${this.file}.last-good`, raw);
    } catch (err) {
      console.warn(`[newamp] settings: could not keep ${this.file}.last-good:`, err);
    }
  }

  // The newest copy that parses: an unsaved one from an earlier session, which
  // holds the latest state, then the last good file, then the daily backups.
  private loadRecoveredSettings(): { state: AppSettings; source: string } | null {
    const unsaved = this.loadUnsavedCopy();
    if (unsaved) return unsaved;
    for (const source of [`${this.file}.last-good`, ...dailyBackupSettingsFiles(dirname(this.file))]) {
      try {
        return { state: this.parseSettingsJson(readFileSync(source, 'utf-8')), source };
      } catch {
        // Missing or unusable: try the next, older copy.
      }
    }
    return null;
  }

  // Shared by the constructor and tryLiftSuppression() below — parses and
  // normalizes settings.json content. Throws on bad JSON or content a
  // normalizer genuinely can't make sense of; both callers treat that as
  // confirmed-invalid content, never as an I/O problem.
  private parseSettingsJson(raw: string, ignoredRoots?: string[]): AppSettings {
    const json: unknown = JSON.parse(raw);
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error('settings.json does not hold a JSON object');
    }
    const parsed = pickKnownSettings(json);
    return {
      ...freshDefaults(),
      ...parsed,
      libraryRoots: normalizeLibraryRoots(parsed.libraryRoots, ignoredRoots),
      theme: normalizeTheme(parsed.theme),
      lastfmEnabled: parsed.lastfmEnabled === true,
      lastfmApiKey: normalizeOptionalSecret(parsed.lastfmApiKey),
      lastfmSharedSecret: normalizeOptionalSecret(parsed.lastfmSharedSecret),
      lastfmSessionKey: normalizeOptionalSecret(parsed.lastfmSessionKey),
      lastfmUsername: normalizeOptionalSecret(parsed.lastfmUsername),
      lastfmAuthToken: normalizeOptionalSecret(parsed.lastfmAuthToken),
      crossfadeMs: normalizeCrossfadeMs(parsed.crossfadeMs, DEFAULTS.crossfadeMs),
      replayGain: normalizeReplayGain(parsed.replayGain),
      volume: normalizeVolume(parsed.volume, DEFAULTS.volume),
      eqEnabled: parsed.eqEnabled === true,
      libraryAutoWatch: parsed.libraryAutoWatch !== false,
      equalizer: normalizeEqValues(parsed.equalizer),
      customSkin: loadCustomSkin(parsed.customSkin),
      resumeState: this.normalizeResume(parsed.resumeState),
      playbackRate: normalizePlaybackRate(parsed.playbackRate ?? DEFAULTS.playbackRate),
      audioOutputDeviceId: normalizeAudioOutputDeviceId(parsed.audioOutputDeviceId),
      limiterEnabled: normalizeLimiterEnabled(parsed.limiterEnabled),
      preampDb: normalizePreampDb(parsed.preampDb),
      openaiApiKey: normalizeOptionalSecret(parsed.openaiApiKey),
      openaiModel: normalizeOpenAiModel(parsed.openaiModel),
      firstLaunchTutorialSeen: parsed.firstLaunchTutorialSeen === true,
      textScale: normalizeTextScale(parsed.textScale),
      compactMode: parsed.compactMode === true,
      alwaysOnTop: parsed.alwaysOnTop === true,
      visualizerPreset: normalizeVisualizerPreset(parsed.visualizerPreset),
      autoDjEnabled: !!parsed.autoDjEnabled,
      autoDjTarget: normalizeAutoDjTarget(parsed.autoDjTarget ?? DEFAULTS.autoDjTarget),
      autoDjSmartRuleId: normalizeAutoDjSmartRuleId(parsed.autoDjSmartRuleId),
      radioBrainEnabled: parsed.radioBrainEnabled === true,
      radioBrainPort: normalizeRadioBrainPort(parsed.radioBrainPort),
      radioBrainToken: normalizeOptionalSecret(parsed.radioBrainToken),
      audioBitPerfectPath: parsed.audioBitPerfectPath === true,
      audioPreferredSampleRate: normalizePreferredSampleRate(parsed.audioPreferredSampleRate),
      bitPerfectExclusive: parsed.bitPerfectExclusive === true,
      bitPerfectExclusiveDeviceId: normalizeExclusiveDeviceId(parsed.bitPerfectExclusiveDeviceId),
      sampleAccurateGapless: typeof parsed.sampleAccurateGapless === 'boolean'
        ? parsed.sampleAccurateGapless
        : DEFAULTS.sampleAccurateGapless,
      closeButtonBehavior: normalizeCloseButtonBehavior(parsed.closeButtonBehavior),
      // A profile saved before this notice existed has been closing to the
      // tray all along, so only new profiles get the one-time explanation.
      trayNoticeShown: parsed.trayNoticeShown === undefined
        ? Object.keys(json).length > 0
        : parsed.trayNoticeShown === true,
      autoBackupEnabled: parsed.autoBackupEnabled !== false,
      windowState: normalizeWindowState(parsed.windowState),
      deskWidget: normalizeDeskWidgetState(parsed.deskWidget),
      performanceTier: normalizePerformanceTier(parsed.performanceTier),
      ambientReactivity: normalizeAmbientReactivity(parsed.ambientReactivity),
      waveformSeekBar: parsed.waveformSeekBar !== false,
      backgroundAnalysis: parsed.backgroundAnalysis !== false,
    };
  }

  // True while this store is running on in-memory defaults because the file
  // could not be read at startup — callers (bootstrap's auto-seed/auto-scan,
  // the "could not read settings" dialog) use this to avoid acting on
  // defaults as if they were the user's real, saved state.
  isSuppressed(): boolean {
    return this.persistenceSuppressed;
  }

  // Called from set() while suppressed, at most once per
  // SUPPRESSION_RETRY_INTERVAL_MS: the lock that blocked startup may have
  // cleared. A successful re-read replaces `state` with the real file BEFORE
  // set() merges the caller's patch on top of it — so the user's in-session
  // change lands on the real settings, not on DEFAULTS. A file that is now
  // readable but genuinely corrupt is quarantined here exactly as the
  // constructor would; there is no longer an untouched original to protect
  // once that happens, so suppression lifts either way. A file that is still
  // unreadable leaves state untouched and nothing is written. Patches made
  // while it was unreadable (suppressedPatch) are laid over the loaded state,
  // so a volume or theme change from earlier in the session is not dropped.
  //
  // One read, no backoff: the cooldown does the waiting, so a session that
  // stays locked doesn't stall the main thread on the autosave cadence.
  private tryLiftSuppression(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf-8');
    } catch {
      return; // still unavailable — try again after the cooldown
    }
    try {
      this.state = this.parseSettingsJson(raw);
    } catch (err) {
      this.state = this.recoverFromCorruptFile(err);
    }
    this.state = this.applyPatch(this.state, this.suppressedPatch);
    this.suppressedPatch = {};
    this.persistenceSuppressed = false;
    console.warn(`[newamp] settings: ${this.file} is readable again; resuming normal saves.`);
  }

  get(): AppSettings {
    return { ...this.state, equalizer: [...this.state.equalizer], libraryRoots: [...this.state.libraryRoots] };
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const { aiAssistRuntime: _runtime, ...persistedPatch } = patch;
    patch = persistedPatch;
    if (this.persistenceSuppressed) {
      // Monotonic, so a wall-clock change can't stop the retries.
      const now = performance.now();
      if (this.lastSuppressionRetryAt === null || now - this.lastSuppressionRetryAt >= SUPPRESSION_RETRY_INTERVAL_MS) {
        this.lastSuppressionRetryAt = now;
        this.tryLiftSuppression();
      }
    }
    this.state = this.applyPatch(this.state, patch);
    if (this.persistenceSuppressed) this.suppressedPatch = { ...this.suppressedPatch, ...pickKnownSettings(patch) };
    // resumeState is the ~3s playback-position autosave (see
    // schedulePersistPlaybackSession in usePlayerStore.ts) and windowState
    // follows every window move and resize — the only settings written on a
    // hot cadence, each always as a lone key in its own patch. Those get
    // debounced/async; a synchronous fsync after every window drag can stall
    // the main thread for a while on a slow or removable data folder. Every
    // other setting keeps writing synchronously and immediately, same as
    // before: callers (and smoke:audio-limiter) depend on a setting being on
    // disk the instant set() returns, and losing a rare user-toggled setting
    // to a crash-window debounce isn't an acceptable trade for a save that
    // isn't hot anyway. flushSync() on quit still lands whatever is pending.
    if (this.isHotPatch(patch)) {
      this.schedulePersist();
    } else {
      this.persistOrDefer();
    }
    return this.get();
  }

  private applyPatch(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
    return {
      ...base,
      ...pickKnownSettings(patch),
      // Something that is not a list leaves the folders as they were; only a
      // list, an empty one included, replaces them.
      libraryRoots: Array.isArray(patch.libraryRoots)
        ? normalizeLibraryRoots(patch.libraryRoots)
        : base.libraryRoots,
      theme: patch.theme === undefined
        ? base.theme
        : normalizeTheme(patch.theme),
      lastfmEnabled: patch.lastfmEnabled === undefined
        ? base.lastfmEnabled
        : patch.lastfmEnabled === true,
      lastfmApiKey: patch.lastfmApiKey === undefined
        ? base.lastfmApiKey
        : normalizeOptionalSecret(patch.lastfmApiKey),
      lastfmSharedSecret: patch.lastfmSharedSecret === undefined
        ? base.lastfmSharedSecret
        : normalizeOptionalSecret(patch.lastfmSharedSecret),
      lastfmSessionKey: patch.lastfmSessionKey === undefined
        ? base.lastfmSessionKey
        : normalizeOptionalSecret(patch.lastfmSessionKey),
      lastfmUsername: patch.lastfmUsername === undefined
        ? base.lastfmUsername
        : normalizeOptionalSecret(patch.lastfmUsername),
      lastfmAuthToken: patch.lastfmAuthToken === undefined
        ? base.lastfmAuthToken
        : normalizeOptionalSecret(patch.lastfmAuthToken),
      crossfadeMs: patch.crossfadeMs === undefined
        ? base.crossfadeMs
        : normalizeCrossfadeMs(patch.crossfadeMs, base.crossfadeMs),
      replayGain: patch.replayGain === undefined
        ? base.replayGain
        : normalizeReplayGain(patch.replayGain),
      volume: patch.volume === undefined
        ? base.volume
        : normalizeVolume(patch.volume, base.volume),
      eqEnabled: patch.eqEnabled === undefined
        ? base.eqEnabled
        : patch.eqEnabled === true,
      radioBrainEnabled: patch.radioBrainEnabled === undefined
        ? base.radioBrainEnabled
        : patch.radioBrainEnabled === true,
      radioBrainPort: patch.radioBrainPort === undefined
        ? base.radioBrainPort
        : normalizeRadioBrainPort(patch.radioBrainPort),
      radioBrainToken: patch.radioBrainToken === undefined
        ? base.radioBrainToken
        : normalizeOptionalSecret(patch.radioBrainToken),
      audioBitPerfectPath: patch.audioBitPerfectPath === undefined
        ? base.audioBitPerfectPath
        : patch.audioBitPerfectPath === true,
      audioPreferredSampleRate: patch.audioPreferredSampleRate === undefined
        ? base.audioPreferredSampleRate
        : normalizePreferredSampleRate(patch.audioPreferredSampleRate),
      libraryAutoWatch: patch.libraryAutoWatch === undefined
        ? base.libraryAutoWatch
        : patch.libraryAutoWatch !== false,
      equalizer: patch.equalizer ? normalizeEqValues(patch.equalizer) : base.equalizer,
      playbackRate: patch.playbackRate === undefined
        ? base.playbackRate
        : normalizePlaybackRate(patch.playbackRate),
      audioOutputDeviceId: patch.audioOutputDeviceId === undefined
        ? base.audioOutputDeviceId
        : normalizeAudioOutputDeviceId(patch.audioOutputDeviceId),
      limiterEnabled: patch.limiterEnabled === undefined
        ? base.limiterEnabled
        : normalizeLimiterEnabled(patch.limiterEnabled),
      preampDb: patch.preampDb === undefined
        ? base.preampDb
        : normalizePreampDb(patch.preampDb),
      openaiApiKey: patch.openaiApiKey === undefined
        ? base.openaiApiKey
        : normalizeOptionalSecret(patch.openaiApiKey),
      openaiModel: patch.openaiModel === undefined
        ? base.openaiModel
        : normalizeOpenAiModel(patch.openaiModel),
      firstLaunchTutorialSeen: patch.firstLaunchTutorialSeen === undefined
        ? base.firstLaunchTutorialSeen
        : patch.firstLaunchTutorialSeen === true,
      textScale: patch.textScale === undefined
        ? base.textScale
        : normalizeTextScale(patch.textScale),
      compactMode: patch.compactMode === undefined
        ? base.compactMode
        : patch.compactMode === true,
      alwaysOnTop: patch.alwaysOnTop === undefined
        ? base.alwaysOnTop
        : patch.alwaysOnTop === true,
      visualizerPreset: patch.visualizerPreset === undefined
        ? base.visualizerPreset
        : normalizeVisualizerPreset(patch.visualizerPreset),
      autoDjEnabled: patch.autoDjEnabled === undefined
        ? base.autoDjEnabled
        : !!patch.autoDjEnabled,
      autoDjTarget: patch.autoDjTarget === undefined
        ? base.autoDjTarget
        : normalizeAutoDjTarget(patch.autoDjTarget),
      autoDjSmartRuleId: patch.autoDjSmartRuleId === undefined
        ? base.autoDjSmartRuleId
        : normalizeAutoDjSmartRuleId(patch.autoDjSmartRuleId),
      resumeState: patch.resumeState === undefined
        ? base.resumeState
        : this.normalizeResume(patch.resumeState),
      // Skin values are re-checked at the DOM write too, but a hand-edited or
      // crafted settings patch should never land an unsafe value on disk.
      customSkin: patch.customSkin === undefined
        ? base.customSkin
        : normalizeCustomSkin(patch.customSkin),
      bitPerfectExclusive: patch.bitPerfectExclusive === undefined
        ? base.bitPerfectExclusive
        : patch.bitPerfectExclusive === true,
      bitPerfectExclusiveDeviceId: patch.bitPerfectExclusiveDeviceId === undefined
        ? base.bitPerfectExclusiveDeviceId
        : normalizeExclusiveDeviceId(patch.bitPerfectExclusiveDeviceId),
      sampleAccurateGapless: patch.sampleAccurateGapless === undefined
        ? base.sampleAccurateGapless
        : patch.sampleAccurateGapless === true,
      closeButtonBehavior: patch.closeButtonBehavior === undefined
        ? base.closeButtonBehavior
        : normalizeCloseButtonBehavior(patch.closeButtonBehavior),
      trayNoticeShown: patch.trayNoticeShown === undefined
        ? base.trayNoticeShown
        : patch.trayNoticeShown === true,
      autoBackupEnabled: patch.autoBackupEnabled === undefined
        ? base.autoBackupEnabled
        : patch.autoBackupEnabled !== false,
      windowState: patch.windowState === undefined
        ? base.windowState
        : normalizeWindowState(patch.windowState),
      deskWidget: patch.deskWidget === undefined
        ? base.deskWidget
        : normalizeDeskWidgetState(patch.deskWidget),
      performanceTier: patch.performanceTier === undefined
        ? base.performanceTier
        : normalizePerformanceTier(patch.performanceTier),
      ambientReactivity: patch.ambientReactivity === undefined
        ? base.ambientReactivity
        : normalizeAmbientReactivity(patch.ambientReactivity),
      waveformSeekBar: patch.waveformSeekBar === undefined
        ? base.waveformSeekBar
        : patch.waveformSeekBar !== false,
      backgroundAnalysis: patch.backgroundAnalysis === undefined
        ? base.backgroundAnalysis
        : patch.backgroundAnalysis !== false,
    };
  }

  private isHotPatch(patch: Partial<AppSettings>): boolean {
    const keys = Object.keys(patch);
    return keys.length === 1 && HOT_PATCH_KEYS.has(keys[0]);
  }

  // The change is already live in memory by the time it is written. A write
  // that fails (full disk, read-only volume) must not throw that back at the
  // caller as if the change had not happened: main keeps using the new value
  // either way. Keep it dirty and let the debounced path retry, and flushSync()
  // on quit tries once more. The first failure of a run is reported, since
  // nothing else tells the user the settings are not on disk.
  private persistOrDefer(): void {
    try {
      this.persist();
    } catch (err) {
      this.noteWriteFailed(err);
      this.schedulePersist();
    }
  }

  private noteWriteFailed(err: unknown): void {
    this.failedWrites += 1;
    if (this.failedWrites > 1) return;
    console.error('[newamp] settings: could not save; keeping the change in memory and retrying', err);
    const event: RecoveryEvent = {
      store: 'settings',
      filePath: this.file,
      backupPath: this.file,
      reason: `${recoveryReason(err)}; changes are kept in memory and NewAmp keeps trying to save them`,
      recoveredAt: Date.now(),
    };
    this.recoveryEvents.push(event);
    try {
      this.onWriteFailed?.(event);
    } catch (callbackErr) {
      console.error('[newamp] settings: the write-failure notice failed', callbackErr);
    }
  }

  // Immediate, synchronous, unconditional write. Also cancels any pending
  // debounced resumeState write and bumps persistSeq so that write's rename
  // (if already in flight) drops itself as stale instead of clobbering this
  // fresher, synchronously-written state — see persistAsync. Lands via tmp
  // file + fsync + rename so a crash mid-write can never truncate
  // settings.json back to defaults (losing library roots, Last.fm session…).
  private persist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistSeq += 1;
    this.dirty = false;
    // The original was never actually read this session (see the
    // constructor) — writing now would overwrite it with a state that only
    // ever saw defaults.
    if (this.persistenceSuppressed) return;
    atomicWriteFileSync(this.file, JSON.stringify(this.state, null, 2));
    this.failedWrites = 0;
  }

  // Debounced path for the resumeState autosave and the window geometry —
  // writing the full settings JSON synchronously every ~3s during playback was
  // a real main-thread cost. After failed writes the wait doubles each time, up
  // to half a minute, so a disk that stays full is not hit by every autosave.
  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    const delay = Math.min(PERSIST_DELAY_MS * 2 ** Math.max(0, this.failedWrites - 1), PERSIST_RETRY_MAX_MS);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistAsync();
    }, delay);
    // A retry after a failed write goes on for as long as the write keeps
    // failing. It must not be what keeps the process alive: quitting flushes
    // synchronously and reports what could not be saved.
    if (this.failedWrites > 0) this.persistTimer.unref?.();
  }

  private async persistAsync(): Promise<void> {
    if (!this.dirty) return;
    if (this.persistInFlight) {
      this.persistAgain = true;
      return;
    }
    this.dirty = false;
    // See persist(): the original was never actually read this session, so
    // there is nothing safe to write it over with.
    if (this.persistenceSuppressed) return;
    const seq = ++this.persistSeq;
    const payload = JSON.stringify(this.state, null, 2);
    // Unique per persist, for the same reason as the library flush: the
    // quit-path synchronous write uses its own "-sync" temp path.
    const tmp = `${this.file}.tmp-${process.pid}-${seq}`;
    let tmpHasCompleteSnapshot = false;
    let tmpHandled = false;
    this.persistInFlight = (async () => {
      try {
        await durableWriteFileAsync(tmp, payload);
        tmpHasCompleteSnapshot = true;
        if (seq !== this.persistSeq) {
          // A synchronous quit-path flush captured newer state while this
          // write was in flight — drop the stale copy instead of racing it.
          tmpHandled = true;
          await unlink(tmp).catch(() => {});
          return;
        }
        // Keep the final replace synchronous after the sequence check so an
        // immediate flushSync() cannot land newer settings while this async
        // path is suspended inside the replace.
        renameOverExistingSync(tmp, this.file);
        tmpHandled = true;
        this.failedWrites = 0;
      } catch (err) {
        this.noteWriteFailed(err);
        this.schedulePersist();
      } finally {
        if (!tmpHandled && !tmpHasCompleteSnapshot) {
          await unlink(tmp).catch(() => {});
        }
      }
    })();
    try {
      await this.persistInFlight;
    } finally {
      this.persistInFlight = null;
      if (this.persistAgain) {
        this.persistAgain = false;
        void this.persistAsync();
      }
    }
  }

  // Immutable JSON snapshot of the live settings object. this.state is always
  // current — only the write to settings.json is debounced (the resumeState
  // autosave) — so this reflects the newest value regardless of what a
  // pending persist has or hasn't landed on disk yet. The support-backup
  // coordinator uses this instead of reading settings.json off disk, which
  // can lag behind by up to that debounce window.
  //
  // While suppressed, `state` is DEFAULTS, not the real file — handing that
  // to a backup or a pre-restore safety snapshot used to silently bury the
  // user's real settings under defaults the moment it was written out. Try
  // the read once more (this does not lift suppression for the rest of the
  // session — that only happens through tryLiftSuppression() on set()); if
  // it still can't be read, refuse instead of lying about what's in the file.
  snapshotJson(): string {
    if (this.persistenceSuppressed) {
      try {
        return readFileSyncRetrying(this.file);
      } catch (err) {
        throw new Error(`settings.json is unavailable (${recoveryReason(err)}); refusing to back it up with defaults`);
      }
    }
    return JSON.stringify(this.state, null, 2);
  }

  // Waits out any async persist already in flight. A caller that is about to
  // replace settings.json out from under this store (support-backup restore)
  // needs this before doing so: persistAsync's persistSeq check only stops a
  // stale write from starting its rename late — it can't stop one that was
  // already dispatched to the OS from racing a rename issued afterwards by
  // this process. Draining the in-flight write removes that race instead of
  // relying on the sequence check to win it.
  async waitForPendingWrites(): Promise<void> {
    while (this.persistInFlight) {
      await this.persistInFlight.catch(() => {});
    }
  }

  // Truly synchronous flush for the quit path — the process may exit
  // immediately after, so this cannot rely on an async write completing.
  // Also used before file-level operations (e.g. backup restore) that would
  // otherwise race a pending debounced write — pair with waitForPendingWrites()
  // first if an in-flight persist may already be running (see there).
  flushSync(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistSeq += 1;
    // The async writer clears dirty before its snapshot reaches disk. Once
    // invalidated above, an in-flight write must be replaced synchronously.
    if (this.dirty || this.persistInFlight) {
      this.dirty = false;
      // See persist(): never write over an original this session never read.
      if (this.persistenceSuppressed) return;
      atomicWriteFileSync(this.file, JSON.stringify(this.state, null, 2));
      this.failedWrites = 0;
    }
  }

  private normalizeResume(value: AppSettings['resumeState'] | undefined): AppSettings['resumeState'] {
    if (!value) return null;
    // Read ahead of the queue: the window below is centred on it.
    const rawIndex = Math.trunc(Number(value.index));
    const around = Number.isFinite(rawIndex) ? rawIndex : 0;
    const queueWindow = Array.isArray(value.queue) ? windowResumeEntries(value.queue, around) : { items: [], start: 0 };
    const queue = queueWindow.items.map(normalizeResumeQueueEntry).filter((entry): entry is PlaybackResumeQueueEntry => !!entry);
    let resumeQueue = queue;
    let windowStart = queueWindow.start;
    if (!queue.length && Array.isArray(value.queueTrackIds)) {
      const idWindow = windowResumeEntries(value.queueTrackIds, around);
      windowStart = idWindow.start;
      resumeQueue = idWindow.items
        .map((id) => normalizeResumeTrackId(id))
        .filter((id): id is number => id !== null)
        .map((trackId) => ({ kind: 'local' as const, trackId }));
    }
    if (!resumeQueue.length) return null;
    const queueTrackIds = resumeQueue.map(resumeEntryTrackId);
    // Shuffle and repeat are independent, so the combined modes are real states
    // the transport produces on an ordinary click. Leaving them out of this
    // whitelist silently reset BOTH toggles on the next launch.
    const mode = ['normal', 'repeat-one', 'repeat-all', 'shuffle', 'shuffle-repeat-one', 'shuffle-repeat-all']
      .includes(value.mode)
      ? value.mode
      : 'normal';
    // -1 is a real value here (queue loaded, nothing current) and must survive
    // the round trip; clamping it to 0 is what made an idle queue come back
    // with its first track selected.
    const index = Number.isFinite(rawIndex) ? Math.max(-1, Math.min(queueTrackIds.length - 1, rawIndex - windowStart)) : 0;
    const rawCurrent = value.currentTrackId;
    const normalizedCurrent = normalizeResumeTrackId(rawCurrent, true);
    const currentTrackId =
      rawCurrent === undefined
        ? undefined
        : normalizedCurrent !== null && queueTrackIds.includes(normalizedCurrent)
          ? normalizedCurrent
          : null;
    return {
      queueTrackIds,
      queue: resumeQueue,
      index,
      ...(currentTrackId !== undefined ? { currentTrackId } : {}),
      currentTime: Math.max(0, Number(value.currentTime) || 0),
      mode,
      updatedAt: Math.max(0, Number(value.updatedAt) || Date.now()),
    };
  }
}
