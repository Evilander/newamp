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
//   - it backs off when the drive or share stops answering, and when ffmpeg
//     cannot be started at all
//   - it runs one ffmpeg at idle priority (electron/track-analyzer.ts)
//
// What each track owes is read from the database (shared/analysis.ts), so a
// restart picks up exactly where the last run stopped, a new or changed file is
// owed everything again, and a better analyzer later redoes only its own
// fields. Results are written in small batches on the slow flush tier: one
// library write per track would rewrite the whole database file every second.
//
// What went wrong while reading is only ever held against a track for the
// session. A read that timed out or failed on a share says nothing about the
// file, and a failure that is written down stays until an analyzer changes, so
// those are retried with growing waits and never written. A mark that a track
// will not decode is written only when ffmpeg ran, read the file and gave up.

import {
  AnalysisAbortedError,
  AnalysisCrashedError,
  AnalysisDrivePendingError,
  AnalysisEnvironmentError,
  AnalysisReadFailedError,
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
  /** The file's size and date as the row held them. A result is dropped if the row has another file by the time it is written. */
  size?: number;
  mtime?: number;
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
  /** Waits before a track that failed is tried again: first, second, and every later retry. */
  retryBackoffMs: number[];
  /** Quiet time after playback was short of audio and is fed again; longer the more often it happens. */
  hungerCooldownMs: number;
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
  retryBackoffMs: [5 * 60_000, 30 * 60_000, 3 * 60 * 60_000],
  hungerCooldownMs: 15_000,
};

/** Past either, the machine is busy and the queue holds. */
export const BUSY_CPU = 0.7;
export const BUSY_LAG_MS = 120;

/** Reads in a row that failed on the storage before the queue holds off and tries a single track as a probe. */
const STORAGE_STREAK_LIMIT = 3;
/** Tries, in one session, of a track that failed for no reason the storage explains, before it is marked as not decoding. */
const MAX_GENERIC_TRIES = 2;
/** Same for a track that ffmpeg died on. */
const MAX_CRASHES = 2;
/** Playback running short of audio is counted over this long when the quiet time after it is worked out. */
const HUNGER_WINDOW_MS = 10 * 60_000;
const MAX_HUNGER_COOLDOWN_MS = 10 * 60_000;
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

type Hold = 'playback' | 'scan' | 'busy' | 'battery' | 'storage' | 'tool';

/** Outcome of one track: it produced a result, was marked as not decoding, or nothing was learned. */
type Outcome = 'result' | 'failed' | 'skipped';

// What has gone wrong with a track in this session. Not written to the library.
interface Setback {
  storage: number;
  generic: number;
  crashes: number;
  /** Not tried again before this time. */
  notBefore: number;
}

export class AnalysisQueue {
  private readonly timing: AnalysisTiming;
  private readonly now: () => number;
  private readonly log: (message: string, error?: unknown) => void;

  private started = false;
  private stopped = false;
  // Each start() gets its own, so a loop left over from before a stop() ends instead of running beside the new one,
  // and the new loop waits for the old one to finish the decode it was in.
  private runId = 0;
  private previous: Promise<void> = Promise.resolve();
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

  private unsaved: Array<{ save: AnalysisSave; target: AnalysisTarget }> = [];
  private unsavedSince = 0;
  // Tracks whose results wait in `unsaved`. The store lists them as owed until
  // the batch is written, so without this a track analysed first because it
  // was played came round again when the list reached it.
  private readonly settled = new Set<number>();
  // Kept across passes: a scan or a rescan rebuilds the list but must not shorten the waits.
  private readonly setbacks = new Map<number, Setback>();
  // Tracks the pass already looked at and could not open: not offered again
  // until the next pass, so one unreachable drive cannot spin the loop.
  private readonly passed = new Set<number>();
  private storageStreak = 0;
  private storageTrips = 0;
  private toolStreak = 0;
  private readonly holdUntil = { storage: 0, tool: 0 };
  private playbackQuietUntil = 0;
  private hungerAt: number[] = [];

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
      if (hungry) {
        this.hungerAt.push(this.now());
        this.current?.abort.abort();
        return;
      }
      // Fed is about 20 s of audio buffered, not a drive that has recovered: a decode that starts at once
      // reads a whole file from it and can starve playback again, so analysis stays out of the way a while.
      this.playbackQuietUntil = this.now() + this.hungerCooldown();
      this.nudge();
    });
    const run = ++this.runId;
    this.loop = this.previous.then(() => this.run(run)).catch((err) => this.log('queue stopped on an unexpected error', err));
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
    const ending = this.loop ?? this.previous;
    this.previous = ending;
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
    this.settled.clear();
    this.passed.clear();
    this.setbacks.clear();
    this.storageStreak = 0;
    this.storageTrips = 0;
    this.toolStreak = 0;
    this.holdUntil.storage = 0;
    this.holdUntil.tool = 0;
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
    let waitingFor: AnalysisProgress['waitingFor'] = null;
    if (!enabled) state = 'off';
    else if (!this.started || this.now() - this.startedAt < this.timing.startDelayMs) state = 'starting';
    else if ((remaining === 0 || this.drained) && !this.current) {
      // Tracks left over because the drive would not answer are not "could not read": they are tried again.
      if (remaining > 0 && this.storageTroubled()) {
        state = 'waiting';
        waitingFor = 'storage';
      } else state = 'done';
    } else if (this.hold) state = 'waiting';
    else state = 'running';
    if (state === 'waiting' && !waitingFor) waitingFor = this.hold;
    return {
      enabled,
      state,
      waitingFor,
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
    if (this.deps.playbackHungry() || this.now() < this.playbackQuietUntil) return 'playback';
    if (this.deps.onBattery()) return 'battery';
    const load = this.deps.load();
    if (load.cpu > BUSY_CPU || load.lagMs > BUSY_LAG_MS) return 'busy';
    if (this.now() < this.holdUntil.tool) return 'tool';
    if (this.now() < this.holdUntil.storage) return 'storage';
    return null;
  }

  // The quiet time after playback ran short of audio: doubles with each time it did so in the last ten minutes.
  private hungerCooldown(): number {
    const since = this.now() - HUNGER_WINDOW_MS;
    this.hungerAt = this.hungerAt.filter((at) => at > since);
    const recent = Math.max(1, this.hungerAt.length);
    return Math.min(MAX_HUNGER_COOLDOWN_MS, this.timing.hungerCooldownMs * 2 ** (recent - 1));
  }

  private backoff(step: number): number {
    const steps = this.timing.retryBackoffMs;
    return steps[Math.min(step, steps.length - 1)] ?? 0;
  }

  // Some track is waiting out a failed read, and nothing else is left to do.
  private storageTroubled(): boolean {
    for (const setback of this.setbacks.values()) if (setback.storage > 0) return true;
    return false;
  }

  private async run(run: number): Promise<void> {
    while (!this.stopped && this.runId === run) {
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
      let id: number | null;
      try {
        id = this.nextId(store);
      } catch (err) {
        // The library could not list what is owed (out of memory on a big one, say): look again later rather than end the queue.
        this.log('could not list the tracks that owe analysis', err);
        await this.nap(this.timing.pollMs);
        continue;
      }
      if (id == null) {
        // Nothing left to try. Look again later: new files, or a track whose wait is over.
        this.drained = true;
        this.writeUnsaved();
        const wait = Math.min(this.timing.recheckMs, Math.max(this.untilNextRetry(), this.timing.pollMs));
        await this.nap(wait);
        // A wait cut short for a retry needs no new look at the library: that is a query over every owed track.
        if (wait === this.timing.recheckMs) this.listStale = true;
        this.drained = false;
        continue;
      }
      const started = this.now();
      let outcome: Outcome;
      try {
        outcome = await this.analyseOne(store, id);
      } catch (err) {
        this.log(`could not analyse track ${id}`, err);
        this.passed.add(id);
        outcome = 'skipped';
      }
      // An abort, an unreachable file and a retry-later take next to no time and say nothing about the pace.
      if (outcome !== 'skipped') this.noteCycle(this.now() - started + this.timing.gapMs);
      this.flushIfDue();
      await this.nap(this.timing.gapMs);
    }
    this.writeUnsaved();
  }

  private untilNextRetry(): number {
    // Only waits still to come: one that is over belongs to a track parked for this round, and must not shorten the recheck.
    const now = this.now();
    let soonest = Infinity;
    for (const { notBefore } of this.setbacks.values()) if (notBefore > now) soonest = Math.min(soonest, notBefore - now);
    return soonest;
  }

  private backingOff(id: number): boolean {
    const setback = this.setbacks.get(id);
    return setback != null && setback.notBefore > this.now();
  }

  private nextId(store: AnalysisStore): number | null {
    // A track whose wait is over is tried again now, wherever the list has got to.
    const now = this.now();
    for (const [id, setback] of this.setbacks) {
      if (setback.notBefore <= now && !this.settled.has(id) && !this.urgent.includes(id)) this.urgent.push(id);
    }
    while (this.urgent.length) {
      const id = this.urgent.shift()!;
      if (!this.passed.has(id) && !this.settled.has(id)) return id;
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
      if (!this.passed.has(id) && !this.settled.has(id) && !this.backingOff(id)) return id;
    }
    return null;
  }

  private async analyseOne(store: AnalysisStore, id: number): Promise<Outcome> {
    const target = store.analysisTarget(id);
    if (!target) {
      this.setbacks.delete(id);
      return 'skipped';
    }
    const abort = new AbortController();
    const generation = this.generation;
    this.current = { id, abort };
    const want = await this.wantedFor(target);
    const touched = fieldsOf(target.work);
    try {
      const result = await this.deps.analyze({ path: target.path, want, signal: abort.signal });
      if (generation !== this.generation) return 'skipped';
      this.recordResult(target, result);
      this.noteDecoded(id);
      return 'result';
    } catch (err) {
      if (generation !== this.generation) return 'skipped';
      if (err instanceof AnalysisAbortedError && abort.signal.aborted) {
        // Playback needed the drive, or the queue was switched off: not the track's fault.
        if (!this.stopped) this.urgent.unshift(id);
        return 'skipped';
      }
      if (err instanceof AnalysisDrivePendingError) {
        // An earlier stat has not come back. This track did nothing wrong: it keeps its place, and the queue waits for the drive.
        this.urgent.unshift(id);
        this.holdUntil.storage = this.now() + this.timing.pollMs;
        return 'skipped';
      }
      if (err instanceof AnalysisUnavailableError) {
        this.passed.add(id);
        return 'skipped';
      }
      if (err instanceof AnalysisEnvironmentError) {
        this.noteEnvironmentFailure(err);
        this.passed.add(id);
        return 'skipped';
      }
      this.toolStreak = 0;
      if (err instanceof AnalysisTimedOutError || err instanceof AnalysisReadFailedError) {
        // The share, not the file. Never written down: it is tried again, later each time.
        this.noteStorageFailure(id);
        return 'skipped';
      }
      if (err instanceof AnalysisAbortedError || err instanceof AnalysisCrashedError) {
        // ffmpeg was killed by something else. A file that does it twice is not worth a third try.
        if (this.setback(id, 'crashes') < MAX_CRASHES) return 'skipped';
      } else if (this.setback(id, 'generic') < MAX_GENERIC_TRIES) {
        // The failure may be a read cut short that the log did not say so about: once more, after a wait.
        return 'skipped';
      }
      // ffmpeg ran, read the file and gave up. Remember that, so it is not tried again until an analyzer changes.
      this.log(`could not analyse ${target.path}`, err);
      this.queueSave({ id, touched }, target);
      this.noteDecoded(id);
      return 'failed';
    } finally {
      if (this.current?.abort === abort) this.current = null;
    }
  }

  // ffmpeg got through a file, so the drive and the program are working.
  private noteDecoded(id: number): void {
    this.setbacks.delete(id);
    this.storageStreak = 0;
    this.storageTrips = 0;
    this.toolStreak = 0;
  }

  // Adds a failure to the track's session record and sets when it may be tried again; returns how many of that kind.
  private setback(id: number, kind: 'storage' | 'generic' | 'crashes'): number {
    const setback = this.setbacks.get(id) ?? { storage: 0, generic: 0, crashes: 0, notBefore: 0 };
    setback[kind] += 1;
    setback.notBefore = this.now() + this.backoff(setback.storage + setback.generic + setback.crashes - 1);
    this.setbacks.set(id, setback);
    return setback[kind];
  }

  private noteStorageFailure(id: number): void {
    this.setback(id, 'storage');
    this.storageStreak += 1;
    if (this.storageStreak < STORAGE_STREAK_LIMIT) return;
    // Several tracks in a row: the drive is the problem. Hold off, then let one track probe it: the streak
    // stays one short of the limit, so that track failing again holds the queue again, for longer.
    this.storageStreak = STORAGE_STREAK_LIMIT - 1;
    this.holdUntil.storage = this.now() + this.backoff(this.storageTrips);
    this.storageTrips += 1;
    this.log('the drive is not answering reads; analysis waits before it tries again');
  }

  private noteEnvironmentFailure(err: unknown): void {
    this.toolStreak += 1;
    this.holdUntil.tool = this.now() + this.backoff(this.toolStreak - 1);
    if (this.toolStreak === 1) this.log('ffmpeg could not be started; analysis waits before it tries again', err);
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
    this.queueSave(save, target);
  }

  private queueSave(save: AnalysisSave, target: AnalysisTarget): void {
    if (!this.unsaved.length) this.unsavedSince = this.now();
    this.unsaved.push({ save, target });
    this.settled.add(save.id);
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
      const store = this.deps.store();
      if (store) {
        const current = batch.flatMap(({ save, target }) => this.stillOwed(store, save, target) ?? []);
        if (current.length) store.saveAnalysis(current);
      }
    } catch (err) {
      this.log('could not write analysis results', err);
    } finally {
      // Written, the store no longer lists them; not written, they are owed again.
      for (const { save } of batch) this.settled.delete(save.id);
    }
  }

  // The result against the row as it is now. Decoding takes seconds to minutes and a
  // result can wait another half minute for its batch, so the row may have changed:
  // a file replaced in the meantime must not take the old file's tempo and loudness,
  // and a value filled in since (a tempo typed into the editor, a retagged file)
  // must not be overwritten by an estimate. Null when nothing is left to write.
  private stillOwed(store: AnalysisStore, save: AnalysisSave, target: AnalysisTarget): AnalysisSave | null {
    const now = store.analysisTarget(save.id);
    if (!now) return null;
    if (now.path !== target.path || now.size !== target.size || now.mtime !== target.mtime) {
      // A different file under the same row: it owes everything again, and is looked at soon.
      this.urgent.push(save.id);
      return null;
    }
    const touched = save.touched.filter((field) => now.work[field]);
    if (touched.length === save.touched.length) return save;
    if (!touched.length) return null;
    const kept: AnalysisSave = { id: save.id, touched };
    if (touched.includes('loud')) {
      kept.replayGainTrackDb = save.replayGainTrackDb;
      kept.integratedLufs = save.integratedLufs;
    }
    if (touched.includes('bpm')) kept.bpm = save.bpm;
    if (touched.includes('key')) kept.key = save.key;
    if (touched.includes('dna')) kept.dna = save.dna;
    return kept;
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
