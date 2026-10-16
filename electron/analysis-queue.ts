// Background analysis of the whole library.
//
// Tempo, key, loudness and Audio DNA feed Sounds Like, harmonic mixes, tempo
// filters and Ask Your Library, and until this queue existed they were computed
// for a handful of tracks, by hand. The queue works through every track that
// still owes one of them, one file at a time, and only when that cannot get in
// the way of listening:
//
//   - it waits while playback is short of decoded audio (electron/playback-io.ts)
//     and stops a decode that is running when that starts
//   - it waits while a library scan runs, and a little after
//   - it waits on battery power, and while the machine or this app's own event
//     loop is busy
//   - it runs one ffmpeg at idle priority (electron/track-analyzer.ts)
//
// What each track owes is read from the database (shared/analysis.ts), so a
// restart picks up exactly where the last run stopped, a new or changed file is
// owed everything again, and a better analyzer later redoes only its own
// fields. Results are written in small batches on the slow flush tier: one
// library write per track would rewrite the whole database file every second.

import {
  AnalysisAbortedError,
  AnalysisTimedOutError,
  AnalysisUnavailableError,
  type AnalysisField,
  type AnalysisProgress,
  type AnalysisWork,
} from '../shared/analysis.js';
import type { TrackDna } from '../shared/audio-dna.js';
import type { AnalysisWanted, TrackAnalysisRequest, TrackAnalysisResult } from './track-analyzer.js';

/** What one finished track writes back. Fields left undefined were not asked for. */
export interface AnalysisSave {
  id: number;
  bpm?: number | null;
  key?: string | null;
  replayGainTrackDb?: number | null;
  integratedLufs?: number | null;
  dna?: TrackDna | null;
  /** Fields that were run, whether or not they produced a value. */
  touched: AnalysisField[];
}

export interface AnalysisTarget {
  id: number;
  path: string;
  work: AnalysisWork;
}

export interface AnalysisCounts {
  total: number;
  owed: number;
  coverage: AnalysisProgress['coverage'];
}

/** The slice of the library the queue needs. */
export interface AnalysisStore {
  /** Ids that still owe something, most useful first. */
  pendingAnalysisIds(): number[];
  /** One track as it is now; null when it is gone, missing, or owes nothing. */
  analysisTarget(id: number): AnalysisTarget | null;
  saveAnalysis(saves: AnalysisSave[]): void;
  analysisCounts(): AnalysisCounts;
}

export interface AnalysisLoad {
  /** 0..1, all cores. */
  cpu: number;
  /** How late timers are running on this process's main thread. */
  lagMs: number;
}

export interface AnalysisTiming {
  /** Wait after start() before the first track, so launch is not competing. */
  startDelayMs: number;
  /** Pause between tracks. */
  gapMs: number;
  /** How long a hold (scan, battery, busy) is re-checked at. */
  pollMs: number;
  /** Quiet time after a scan before analysis resumes. */
  scanCooldownMs: number;
  /** When nothing is owed, how soon the library is looked at again. */
  recheckMs: number;
  /** Saves are written after this many tracks... */
  flushEvery: number;
  /** ...or this long after the first unsaved one. */
  flushAfterMs: number;
  /** The longest a counts query result is reused. */
  countsMaxAgeMs: number;
}

export const DEFAULT_ANALYSIS_TIMING: AnalysisTiming = {
  startDelayMs: 45_000,
  gapMs: 150,
  pollMs: 5_000,
  scanCooldownMs: 15_000,
  recheckMs: 30 * 60_000,
  flushEvery: 12,
  flushAfterMs: 30_000,
  countsMaxAgeMs: 30_000,
};

/** Past either, the machine is busy and the queue holds. */
export const BUSY_CPU = 0.7;
export const BUSY_LAG_MS = 120;

/** Tries a timed-out file gets in one session before it is held against it. */
const MAX_TIMEOUTS = 3;
/** A scan that has said nothing for this long is taken to have ended. */
const SCAN_SILENCE_MS = 2 * 60_000;
const RATE_WINDOW = 30;

export interface AnalysisQueueDeps {
  store: () => AnalysisStore | null;
  analyze: (request: TrackAnalysisRequest) => Promise<TrackAnalysisResult>;
  isEnabled: () => boolean;
  playbackHungry: () => boolean;
  /** Called with true when playback starts running short of audio, false when it is fed again. */
  onPlaybackHunger: (listener: (hungry: boolean) => void) => () => void;
  load: () => AnalysisLoad;
  onBattery: () => boolean;
  /** Whether the seek-bar cache has room for waveforms nobody has asked for. */
  peaksWanted: (path: string) => Promise<boolean>;
  now?: () => number;
  timing?: Partial<AnalysisTiming>;
  log?: (message: string, error?: unknown) => void;
}

type Hold = 'playback' | 'scan' | 'busy' | 'battery';

export class AnalysisQueue {
  private readonly timing: AnalysisTiming;
  private readonly now: () => number;
  private readonly log: (message: string, error?: unknown) => void;

  private started = false;
  private stopped = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private unsubscribeHunger: (() => void) | null = null;

  private list: number[] = [];
  private position = 0;
  private listBuilt = false;
  private listStale = true;
  private urgent: number[] = [];
  // Bumped when the library is swapped, so a result for the old one is not written into the new one.
  private generation = 0;
  // The list has been gone through and nothing is left that can be tried now.
  private drained = false;
  private current: { id: number; abort: AbortController } | null = null;

  private scanning = false;
  private lastScanEventAt = 0;
  private scanQuietUntil = 0;
  private startedAt = 0;
  private hold: Hold | null = null;

  private unsaved: AnalysisSave[] = [];
  private unsavedSince = 0;
  private readonly timeouts = new Map<number, number>();
  // Tracks the pass already looked at and could not read: not offered again
  // until the next pass, so one unreachable drive cannot spin the loop.
  private readonly passed = new Set<number>();

  private cycleMs: number[] = [];
  private counts: { at: number; value: AnalysisCounts; doneSince: number } | null = null;

  constructor(private readonly deps: AnalysisQueueDeps) {
    this.timing = { ...DEFAULT_ANALYSIS_TIMING, ...deps.timing };
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((message, error) => console.warn(`[analysis] ${message}`, error ?? ''));
  }

  /** Starts working through the library. Safe to call again. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.startedAt = this.now();
    this.unsubscribeHunger = this.deps.onPlaybackHunger((hungry) => {
      // A decode already running gives way at once; the track is tried again once playback is fed.
      if (hungry) this.current?.abort.abort();
      else this.nudge();
    });
    this.loop = this.run().catch((err) => this.log('queue stopped on an unexpected error', err));
  }

  /** Ends the queue: the decode in flight is stopped and finished results are written. */
  stop(): Promise<void> {
    this.stopped = true;
    this.current?.abort.abort();
    this.nudge();
    this.unsubscribeHunger?.();
    this.unsubscribeHunger = null;
    // Written now, while the library is still open; the quit path does not wait for the loop.
    this.writeUnsaved();
    const ending = this.loop ?? Promise.resolve();
    this.loop = null;
    this.started = false;
    return ending;
  }

  /** The setting changed, or something else the queue waits on did: look again now. */
  refresh(): void {
    if (!this.deps.isEnabled()) this.current?.abort.abort();
    this.nudge();
  }

  /** The library was swapped (a restore): forget the list and start over on the new one. */
  reset(): void {
    this.list = [];
    this.position = 0;
    this.listBuilt = false;
    this.listStale = true;
    this.urgent = [];
    this.unsaved = [];
    this.passed.clear();
    this.timeouts.clear();
    this.counts = null;
    this.drained = false;
    this.generation += 1;
    this.current?.abort.abort();
    this.nudge();
  }

  /** Fed from the scanner's progress events: the queue stays out of a scan's way. */
  noteScan(progress: { done: boolean }): void {
    this.lastScanEventAt = this.now();
    if (!progress.done) {
      this.scanning = true;
      return;
    }
    this.scanning = false;
    this.scanQuietUntil = this.now() + this.timing.scanCooldownMs;
    // The scan may have added or changed tracks.
    this.listStale = true;
    this.drained = false;
    this.nudge();
  }

  /** Tracks the listener is about to need (the one that just started) go to the front. */
  prioritize(ids: number[]): void {
    for (const raw of ids) {
      const id = Math.trunc(Number(raw));
      if (!Number.isFinite(id) || id <= 0 || this.current?.id === id) continue;
      this.urgent = [id, ...this.urgent.filter((other) => other !== id)];
      this.drained = false;
    }
    this.nudge();
  }

  progress(): AnalysisProgress {
    const store = this.deps.store();
    const enabled = this.deps.isEnabled();
    const counts = store ? this.readCounts(store) : null;
    const remaining = counts ? Math.max(0, counts.owed - (this.counts?.doneSince ?? 0)) : 0;
    const total = counts?.total ?? 0;
    const cycle = this.averageCycleMs();
    let state: AnalysisProgress['state'];
    if (!enabled) state = 'off';
    else if (!this.started || this.now() - this.startedAt < this.timing.startDelayMs) state = 'starting';
    else if ((remaining === 0 || this.drained) && !this.current) state = 'done';
    else if (this.hold) state = 'waiting';
    else state = 'running';
    return {
      enabled,
      state,
      waitingFor: state === 'waiting' ? this.hold : null,
      total,
      done: Math.max(0, total - remaining),
      remaining,
      tracksPerHour: cycle ? Math.round(3_600_000 / cycle) : null,
      etaSeconds: cycle && remaining ? Math.round((remaining * cycle) / 1000) : null,
      coverage: counts?.coverage ?? { tempo: 0, key: 0, loudness: 0, dna: 0 },
    };
  }

  // -------------------------------------------------------------------------

  private nudge(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  // Sleeps, but wakes early when something changes (setting, scan end, urgent track, stop).
  private nap(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        if (this.wake === wake) this.wake = null;
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.wake = wake;
    });
  }

  private heldBy(): Hold | null {
    // A scan that died without its final event must not hold the queue for good.
    const scanLive = this.scanning && this.now() - this.lastScanEventAt < SCAN_SILENCE_MS;
    if (scanLive || this.now() < this.scanQuietUntil) return 'scan';
    if (this.deps.playbackHungry()) return 'playback';
    if (this.deps.onBattery()) return 'battery';
    const load = this.deps.load();
    if (load.cpu > BUSY_CPU || load.lagMs > BUSY_LAG_MS) return 'busy';
    return null;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const untilStart = this.startedAt + this.timing.startDelayMs - this.now();
      if (untilStart > 0) {
        await this.nap(untilStart);
        continue;
      }
      if (!this.deps.isEnabled()) {
        this.hold = null;
        this.writeUnsaved();
        await this.nap(this.timing.recheckMs);
        continue;
      }
      const store = this.deps.store();
      if (!store) {
        await this.nap(this.timing.pollMs);
        continue;
      }
      const held = this.heldBy();
      this.hold = held;
      if (held) {
        this.writeUnsaved();
        // Playback being fed again wakes the nap; the other holds are polled.
        await this.nap(this.timing.pollMs);
        continue;
      }
      const id = this.nextId(store);
      if (id == null) {
        // Nothing left to try. Look again later: new files, or a transient failure that passed.
        this.drained = true;
        this.writeUnsaved();
        await this.nap(this.timing.recheckMs);
        this.listStale = true;
        this.drained = false;
        continue;
      }
      const started = this.now();
      await this.analyseOne(store, id);
      this.noteCycle(this.now() - started + this.timing.gapMs);
      this.flushIfDue();
      await this.nap(this.timing.gapMs);
    }
    this.writeUnsaved();
  }

  private nextId(store: AnalysisStore): number | null {
    while (this.urgent.length) {
      const id = this.urgent.shift()!;
      if (!this.passed.has(id)) return id;
    }
    if (this.listStale || !this.listBuilt) {
      this.list = store.pendingAnalysisIds();
      this.position = 0;
      this.listBuilt = true;
      this.listStale = false;
      this.passed.clear();
      this.counts = null;
    }
    while (this.position < this.list.length) {
      const id = this.list[this.position++]!;
      if (!this.passed.has(id)) return id;
    }
    return null;
  }

  private async analyseOne(store: AnalysisStore, id: number): Promise<void> {
    const target = store.analysisTarget(id);
    if (!target) return;
    const abort = new AbortController();
    const generation = this.generation;
    this.current = { id, abort };
    const want = await this.wantedFor(target);
    const touched = fieldsOf(target.work);
    try {
      const result = await this.deps.analyze({ path: target.path, want, signal: abort.signal });
      if (generation === this.generation) this.recordResult(target, result);
    } catch (err) {
      if (generation !== this.generation) return;
      if (err instanceof AnalysisAbortedError) {
        // Playback needed the drive, or the queue was switched off: not the track's fault.
        if (!this.stopped) this.urgent.unshift(id);
        return;
      }
      if (err instanceof AnalysisUnavailableError) {
        this.passed.add(id);
        return;
      }
      if (err instanceof AnalysisTimedOutError) {
        const tries = (this.timeouts.get(id) ?? 0) + 1;
        this.timeouts.set(id, tries);
        if (tries < MAX_TIMEOUTS) {
          this.passed.add(id);
          return;
        }
      }
      // The file will not decode. Remember that, so it is not tried again until an analyzer changes.
      this.log(`could not analyse ${target.path}`, err);
      this.queueSave({ id, touched });
    } finally {
      this.current = null;
    }
  }

  private async wantedFor(target: AnalysisTarget): Promise<AnalysisWanted> {
    const { work } = target;
    const peaks = await this.deps.peaksWanted(target.path).catch(() => false);
    return { loud: work.loud, tempo: work.bpm || work.key, dna: work.dna, peaks };
  }

  private recordResult(target: AnalysisTarget, result: TrackAnalysisResult): void {
    const { work } = target;
    const save: AnalysisSave = { id: target.id, touched: fieldsOf(work) };
    if (work.loud) {
      save.replayGainTrackDb = result.loudness?.replayGainTrackDb ?? null;
      save.integratedLufs = result.loudness?.integratedLufs ?? null;
    }
    if (work.bpm) save.bpm = result.tempo?.bpm ?? null;
    if (work.key) save.key = result.tempo?.key ?? null;
    if (work.dna) save.dna = result.dna;
    this.queueSave(save);
  }

  private queueSave(save: AnalysisSave): void {
    if (!this.unsaved.length) this.unsavedSince = this.now();
    this.unsaved.push(save);
    if (this.counts) this.counts.doneSince += 1;
  }

  private flushIfDue(): void {
    if (!this.unsaved.length) return;
    if (this.unsaved.length >= this.timing.flushEvery || this.now() - this.unsavedSince >= this.timing.flushAfterMs) {
      this.writeUnsaved();
    }
  }

  private writeUnsaved(): void {
    if (!this.unsaved.length) return;
    const batch = this.unsaved;
    this.unsaved = [];
    try {
      this.deps.store()?.saveAnalysis(batch);
    } catch (err) {
      this.log('could not write analysis results', err);
    }
  }

  private noteCycle(ms: number): void {
    this.cycleMs.push(ms);
    if (this.cycleMs.length > RATE_WINDOW) this.cycleMs.shift();
  }

  private averageCycleMs(): number | null {
    if (this.cycleMs.length < 3) return null;
    return this.cycleMs.reduce((sum, ms) => sum + ms, 0) / this.cycleMs.length;
  }

  private readCounts(store: AnalysisStore): AnalysisCounts {
    const age = this.counts ? this.now() - this.counts.at : Infinity;
    if (!this.counts || age > this.timing.countsMaxAgeMs) {
      // Unsaved results count as done in the figures but not in the database yet.
      this.counts = { at: this.now(), value: store.analysisCounts(), doneSince: this.unsaved.length };
    }
    return this.counts.value;
  }
}

function fieldsOf(work: AnalysisWork): AnalysisField[] {
  const fields: AnalysisField[] = [];
  if (work.loud) fields.push('loud');
  if (work.bpm) fields.push('bpm');
  if (work.key) fields.push('key');
  if (work.dna) fields.push('dna');
  return fields;
}
