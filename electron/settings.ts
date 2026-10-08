import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AppSettings, PlaybackResumeQueueEntry, PlaybackResumeServerTrack, RecoveryEvent } from '../shared/types.js';
import { normalizePlaybackRate } from '../shared/tempo-trainer.js';
import { normalizeAutoDjTarget } from '../shared/auto-dj.js';
import { normalizeAudioOutputDeviceId } from '../shared/audio-output.js';
import { normalizeLimiterEnabled, normalizePreampDb } from '../shared/audio-limiter.js';
import { FLAT_EQ_VALUES, normalizeEqValues } from '../shared/eq-presets.js';
import { normalizeCustomSkin } from '../shared/custom-skin.js';
import { parseMusicServerStreamUrl } from '../shared/music-servers.js';
import {
  atomicWriteFileSync,
  durableWriteFileAsync,
  isUnreadableFileError,
  quarantineCorruptFile,
  readFileSyncRetrying,
  recoveryReason,
  renameOverExistingSync,
  suppressedRecoveryEvent,
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
  performanceTier: 'auto',
  ambientReactivity: 'auto',
};

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

  constructor(private readonly file: string) {
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
        this.state = { ...DEFAULTS };
        this.persistenceSuppressed = true;
        this.recoveryEvents.push(suppressedRecoveryEvent('settings', file, err));
        return;
      }
      try {
        this.state = this.parseSettingsJson(raw);
      } catch (err) {
        // Reaching here means the bytes were actually read — this is
        // confirmed invalid content (bad JSON, or a shape normalize/parse
        // can't make sense of at all), not an I/O error, so quarantining is
        // the right call.
        const event = quarantineCorruptFile(this.file, 'settings', recoveryReason(err));
        if (event) this.recoveryEvents.push(event);
        this.state = { ...DEFAULTS };
        this.persist();
      }
    } else {
      this.state = { ...DEFAULTS };
      this.persist();
    }
  }

  // Shared by the constructor and tryLiftSuppression() below — parses and
  // normalizes settings.json content. Throws on bad JSON or content a
  // normalizer genuinely can't make sense of; both callers treat that as
  // confirmed-invalid content, never as an I/O problem.
  private parseSettingsJson(raw: string): AppSettings {
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...DEFAULTS,
      ...parsed,
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
      performanceTier: normalizePerformanceTier(parsed.performanceTier),
      ambientReactivity: normalizeAmbientReactivity(parsed.ambientReactivity),
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
  // unreadable leaves state untouched and nothing is written.
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
      const event = quarantineCorruptFile(this.file, 'settings', recoveryReason(err));
      if (event) this.recoveryEvents.push(event);
      this.state = { ...DEFAULTS };
    }
    this.persistenceSuppressed = false;
    console.warn(`[newamp] settings: ${this.file} is readable again; resuming normal saves.`);
  }

  get(): AppSettings {
    return { ...this.state, equalizer: [...this.state.equalizer] };
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
    const next: AppSettings = {
      ...this.state,
      ...patch,
      libraryAutoWatch: patch.libraryAutoWatch === undefined
        ? this.state.libraryAutoWatch
        : patch.libraryAutoWatch !== false,
      equalizer: patch.equalizer ? normalizeEqValues(patch.equalizer) : this.state.equalizer,
      playbackRate: patch.playbackRate === undefined
        ? this.state.playbackRate
        : normalizePlaybackRate(patch.playbackRate),
      audioOutputDeviceId: patch.audioOutputDeviceId === undefined
        ? this.state.audioOutputDeviceId
        : normalizeAudioOutputDeviceId(patch.audioOutputDeviceId),
      limiterEnabled: patch.limiterEnabled === undefined
        ? this.state.limiterEnabled
        : normalizeLimiterEnabled(patch.limiterEnabled),
      preampDb: patch.preampDb === undefined
        ? this.state.preampDb
        : normalizePreampDb(patch.preampDb),
      openaiApiKey: patch.openaiApiKey === undefined
        ? this.state.openaiApiKey
        : normalizeOptionalSecret(patch.openaiApiKey),
      openaiModel: patch.openaiModel === undefined
        ? this.state.openaiModel
        : normalizeOpenAiModel(patch.openaiModel),
      firstLaunchTutorialSeen: patch.firstLaunchTutorialSeen === undefined
        ? this.state.firstLaunchTutorialSeen
        : patch.firstLaunchTutorialSeen === true,
      textScale: patch.textScale === undefined
        ? this.state.textScale
        : normalizeTextScale(patch.textScale),
      compactMode: patch.compactMode === undefined
        ? this.state.compactMode
        : patch.compactMode === true,
      alwaysOnTop: patch.alwaysOnTop === undefined
        ? this.state.alwaysOnTop
        : patch.alwaysOnTop === true,
      visualizerPreset: patch.visualizerPreset === undefined
        ? this.state.visualizerPreset
        : normalizeVisualizerPreset(patch.visualizerPreset),
      autoDjEnabled: patch.autoDjEnabled === undefined
        ? this.state.autoDjEnabled
        : !!patch.autoDjEnabled,
      autoDjTarget: patch.autoDjTarget === undefined
        ? this.state.autoDjTarget
        : normalizeAutoDjTarget(patch.autoDjTarget),
      autoDjSmartRuleId: patch.autoDjSmartRuleId === undefined
        ? this.state.autoDjSmartRuleId
        : normalizeAutoDjSmartRuleId(patch.autoDjSmartRuleId),
      resumeState: patch.resumeState === undefined
        ? this.state.resumeState
        : this.normalizeResume(patch.resumeState),
      // Skin values are re-checked at the DOM write too, but a hand-edited or
      // crafted settings patch should never land an unsafe value on disk.
      customSkin: patch.customSkin === undefined
        ? this.state.customSkin
        : normalizeCustomSkin(patch.customSkin),
      bitPerfectExclusive: patch.bitPerfectExclusive === undefined
        ? this.state.bitPerfectExclusive
        : patch.bitPerfectExclusive === true,
      bitPerfectExclusiveDeviceId: patch.bitPerfectExclusiveDeviceId === undefined
        ? this.state.bitPerfectExclusiveDeviceId
        : normalizeExclusiveDeviceId(patch.bitPerfectExclusiveDeviceId),
      sampleAccurateGapless: patch.sampleAccurateGapless === undefined
        ? this.state.sampleAccurateGapless
        : patch.sampleAccurateGapless === true,
      closeButtonBehavior: patch.closeButtonBehavior === undefined
        ? this.state.closeButtonBehavior
        : normalizeCloseButtonBehavior(patch.closeButtonBehavior),
      performanceTier: patch.performanceTier === undefined
        ? this.state.performanceTier
        : normalizePerformanceTier(patch.performanceTier),
      ambientReactivity: patch.ambientReactivity === undefined
        ? this.state.ambientReactivity
        : normalizeAmbientReactivity(patch.ambientReactivity),
    };
    this.state = next;
    // resumeState is the ~3s playback-position autosave (see
    // schedulePersistPlaybackSession in usePlayerStore.ts) — the only setting
    // written on a hot, high-frequency cadence, and always as a lone key in
    // its own patch. That one gets debounced/async. Every other setting keeps
    // writing synchronously and immediately, same as before: callers (and
    // smoke:audio-limiter) depend on a setting being on disk the instant
    // set() returns, and losing a rare user-toggled setting to a crash-window
    // debounce isn't an acceptable trade for a save that isn't hot anyway.
    if (this.isResumeStateOnlyPatch(patch)) {
      this.schedulePersist();
    } else {
      this.persist();
    }
    return this.get();
  }

  private isResumeStateOnlyPatch(patch: Partial<AppSettings>): boolean {
    const keys = Object.keys(patch);
    return keys.length === 1 && keys[0] === 'resumeState';
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
  }

  // Debounced path for the resumeState autosave only — writing the full
  // settings JSON synchronously every ~3s during playback was a real
  // main-thread cost.
  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistAsync();
    }, 800);
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
      } catch (err) {
        console.error('settings persist failed', err);
        this.dirty = true; // retry on the next scheduled persist
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
    }
  }

  private normalizeResume(value: AppSettings['resumeState'] | undefined): AppSettings['resumeState'] {
    if (!value) return null;
    const queue = Array.isArray(value.queue)
      ? value.queue.map(normalizeResumeQueueEntry).filter((entry): entry is PlaybackResumeQueueEntry => !!entry).slice(0, MAX_RESUME_QUEUE_LENGTH)
      : [];
    const legacyQueue = !queue.length && Array.isArray(value.queueTrackIds)
      ? value.queueTrackIds
          .map((id) => normalizeResumeTrackId(id))
          .filter((id): id is number => id !== null)
          .slice(0, MAX_RESUME_QUEUE_LENGTH)
          .map((trackId) => ({ kind: 'local' as const, trackId }))
      : [];
    const resumeQueue = queue.length ? queue : legacyQueue;
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
    const rawIndex = Math.trunc(Number(value.index));
    const index = Number.isFinite(rawIndex) ? Math.max(-1, Math.min(queueTrackIds.length - 1, rawIndex)) : 0;
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
