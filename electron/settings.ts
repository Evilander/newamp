import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppSettings, RecoveryEvent } from '../shared/types.js';
import { normalizePlaybackRate } from '../shared/tempo-trainer.js';
import { normalizeAutoDjTarget } from '../shared/auto-dj.js';
import { normalizeAudioOutputDeviceId } from '../shared/audio-output.js';
import { normalizeLimiterEnabled, normalizePreampDb } from '../shared/audio-limiter.js';
import { FLAT_EQ_VALUES, normalizeEqValues } from '../shared/eq-presets.js';
import { quarantineCorruptFile, recoveryReason } from './recovery.js';

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
  closeButtonBehavior: 'minimize-to-tray',
  performanceTier: 'auto',
  ambientReactivity: 'auto',
};

function normalizePreferredSampleRate(value: unknown): number | null {
  if (value == null) return null;
  const rate = Math.trunc(Number(value));
  const ALLOWED = new Set([44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000]);
  return ALLOWED.has(rate) ? rate : null;
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

export class SettingsStore {
  public readonly recoveryEvents: RecoveryEvent[] = [];
  private state: AppSettings;

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      try {
        const raw = readFileSync(file, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        this.state = {
          ...DEFAULTS,
          ...parsed,
          libraryAutoWatch: parsed.libraryAutoWatch !== false,
          equalizer: normalizeEqValues(parsed.equalizer),
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
          closeButtonBehavior: normalizeCloseButtonBehavior(parsed.closeButtonBehavior),
          performanceTier: normalizePerformanceTier(parsed.performanceTier),
          ambientReactivity: normalizeAmbientReactivity(parsed.ambientReactivity),
        };
      } catch (err) {
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

  get(): AppSettings {
    return { ...this.state, equalizer: [...this.state.equalizer] };
  }

  set(patch: Partial<AppSettings>): AppSettings {
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
    this.persist();
    return this.get();
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  private normalizeResume(value: AppSettings['resumeState'] | undefined): AppSettings['resumeState'] {
    if (!value || !Array.isArray(value.queueTrackIds)) return null;
    const queueTrackIds = value.queueTrackIds
      .map((id) => Math.trunc(Number(id)))
      .filter((id) => Number.isFinite(id) && id > 0)
      .slice(0, 5000);
    if (!queueTrackIds.length) return null;
    const mode = ['normal', 'repeat-one', 'repeat-all', 'shuffle'].includes(value.mode)
      ? value.mode
      : 'normal';
    return {
      queueTrackIds,
      index: Math.max(0, Math.min(queueTrackIds.length - 1, Math.trunc(Number(value.index) || 0))),
      currentTime: Math.max(0, Number(value.currentTime) || 0),
      mode,
      updatedAt: Math.max(0, Number(value.updatedAt) || Date.now()),
    };
  }
}
