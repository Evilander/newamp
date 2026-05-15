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
  crossfadeMs: 0,
  replayGain: 'off',
  limiterEnabled: true,
  preampDb: 0,
  resumeState: null,
  compactMode: false,
  volume: 0.75,
  playbackRate: 1,
  audioOutputDeviceId: null,
  autoDjEnabled: false,
  autoDjTarget: 24,
  autoDjSmartRuleId: null,
  equalizer: [...FLAT_EQ_VALUES],
  eqEnabled: false,
};

function normalizeAutoDjSmartRuleId(value: unknown): number | null {
  const id = Math.trunc(Number(value));
  return Number.isFinite(id) && id > 0 ? id : null;
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
          compactMode: parsed.compactMode === true,
          autoDjEnabled: !!parsed.autoDjEnabled,
          autoDjTarget: normalizeAutoDjTarget(parsed.autoDjTarget ?? DEFAULTS.autoDjTarget),
          autoDjSmartRuleId: normalizeAutoDjSmartRuleId(parsed.autoDjSmartRuleId),
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
      compactMode: patch.compactMode === undefined
        ? this.state.compactMode
        : patch.compactMode === true,
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
