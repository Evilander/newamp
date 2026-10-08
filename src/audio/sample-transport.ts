// Engine side of the sample-accurate gapless transport.
//
// Owns the AudioWorkletNode (gapless-processor.js) that feeds the graph where
// the decks do, hands it the MessagePort the main-process producer
// (electron/gapless-transport.ts) writes PCM into, and turns the worklet's
// frame reports into track ids and positions. The engine drives it like a
// third deck — start, seek, pause, stop, prepareNext — and hears back through
// one listener when a chained track becomes audible, when the stream drains,
// or when the audible track fails. Only the worklet decides when a boundary
// happens; nothing here runs on requestAnimationFrame.

import { api } from '../lib/api';
import type { GaplessSegmentRequest, GaplessStartResult, ResamplerKind } from '@shared/types';

export interface SampleSegment {
  token: number;
  trackId: number;
  src: string;
  startSec: number;
  durationSec: number | null;
  gain: number;
  /** The rate its decoder ran at and what converted it; known once it is audible. */
  sourceRate: number | null;
  resampler: 'none' | ResamplerKind | null;
}

export type SampleTransportEvent =
  /** `to` is audible from its first frame on; `failed` when it could not be decoded. */
  | { type: 'boundary'; from: SampleSegment; to: SampleSegment; failed: string | null }
  /** The end of the stream played out; nothing was chained after `segment`. */
  | { type: 'drained'; segment: SampleSegment | null; positionSec: number }
  /** The audible segment (or a seek restart of it) could not be decoded, or its stream stalled. */
  | { type: 'failed'; segment: SampleSegment; positionSec: number; message: string }
  /** The worklet ran dry while playing (`on`), or has audio again. */
  | { type: 'buffering'; on: boolean };

/** `superseded`: a newer start, seek or stop took the stream over before this one resolved. */
export type SampleStartResult = GaplessStartResult & { superseded?: boolean };

export interface SampleStartRequest {
  trackId: number;
  src: string;
  startAt: number;
  gain: number;
  playing: boolean;
}

const PORT_TIMEOUT_MS = 5000;
// Position is carried forward on the context clock between worklet reports
// (every ~43 ms); capped so a stalled report can't run the clock away.
const MAX_EXTRAPOLATE_SEC = 0.25;
// A scrub drag seeks on every input event, and each seek is a new ffmpeg
// run. The first seek of a burst goes out at once; the rest coalesce, and the
// latest target plays once input has been quiet this long.
const SEEK_SETTLE_MS = 120;
// A pause this long releases the decoders, and with them their file handles:
// Windows won't let anything rename or delete a file ffmpeg holds open.
// Resuming restarts the stream at the paused position.
const PARK_AFTER_MS = 5000;
// Running dry this long while playing (a stalled disk, a hung decoder) hands
// the track to the decks at the audible position.
const STALL_FALLBACK_MS = 4000;

interface WorkletReport {
  segmentFrames: number;
  frame: number;
  starving: boolean;
}

function wire(segment: SampleSegment): GaplessSegmentRequest {
  return { token: segment.token, trackId: segment.trackId, startAt: segment.startSec, gain: segment.gain };
}

function openDataPort(): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    // Main posts the port before the invoke answers. Ports are told apart by
    // the id open() returned: when the setting flips off and on inside the
    // round trip, the first open's port is already dead.
    let id: number | null = null;
    const early: Array<{ id: unknown; port: MessagePort }> = [];
    const cleanup = (): void => {
      window.clearTimeout(timer);
      window.removeEventListener('newamp:gapless-port', onPort);
    };
    const onPort = (event: Event): void => {
      const message = event as MessageEvent;
      const port = message.ports[0];
      if (!port) return;
      const portId = (message.data as { id?: unknown } | null)?.id;
      if (id == null) {
        early.push({ id: portId, port });
        return;
      }
      if (portId !== id) return;
      cleanup();
      resolve(port);
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the PCM port.'));
    }, PORT_TIMEOUT_MS);
    window.addEventListener('newamp:gapless-port', onPort);
    api.gaplessOpen().then(
      (opened) => {
        if (opened) {
          id = opened;
          const arrived = early.find((entry) => entry.id === opened);
          if (!arrived) return;
          cleanup();
          resolve(arrived.port);
          return;
        }
        cleanup();
        reject(new Error('The gapless producer is unavailable.'));
      },
      (err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export class SampleTransport {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private attaching: Promise<boolean> | null = null;
  // Bumped by attach and detach, so a connect that a detach overtook
  // doesn't wire its node into the graph afterwards.
  private attachSeq = 0;
  private listener: ((event: SampleTransportEvent) => void) | null = null;
  private seekTimer: number | null = null;
  private pendingSeek: number | null = null;
  private lastSeekAt = Number.NEGATIVE_INFINITY;
  private parkTimer: number | null = null;
  // Paused long enough that the stream was released: the position to resume from.
  private parkedAt: number | null = null;
  private starveTimer: number | null = null;
  private gen = 0;
  private nextToken = 1;
  private readonly segments = new Map<number, SampleSegment>();
  // The segment a prepareNext follows: the generation's first segment, then
  // each chained segment once it becomes audible.
  private tail: SampleSegment | null = null;
  private chained: SampleSegment | null = null;
  private audible: SampleSegment | null = null;
  // A chained segment that became audible and has not yet been acknowledged
  // by the engine's play() for it.
  private unacked: SampleSegment | null = null;
  // Chained segments that failed before they were audible, by token: their
  // boundary hands them to the decks.
  private readonly queuedFailures = new Map<number, string>();
  private report: WorkletReport = { segmentFrames: 0, frame: 0, starving: false };
  private live = false;
  private playing = false;
  underruns = 0;
  lastResult: SampleStartResult | null = null;
  unavailableReason: string | null = null;

  setListener(listener: ((event: SampleTransportEvent) => void) | null): void {
    this.listener = listener;
  }

  /** Load the worklet into `ctx` and connect it to `destination`; false if that can't be done. */
  attach(ctx: AudioContext, destination: AudioNode): Promise<boolean> {
    if (this.ctx === ctx && this.attaching) return this.attaching;
    this.detach();
    this.ctx = ctx;
    const seq = ++this.attachSeq;
    this.attaching = this.connect(ctx, destination, seq).catch((err: unknown) => {
      if (seq !== this.attachSeq) return false;
      this.unavailableReason = err instanceof Error ? err.message : String(err);
      console.warn('[newamp] sample-accurate gapless unavailable; local tracks use the deck path', err);
      return false;
    });
    return this.attaching;
  }

  detach(): void {
    this.attachSeq++;
    if (this.live) this.stop();
    this.clearTimers();
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.port.postMessage({ t: 'dispose' });
      try {
        this.node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.node = null;
    this.ctx = null;
    this.attaching = null;
  }

  /** Flush and start `request` as a new stream; resolves once its first frames are queued. */
  async start(request: SampleStartRequest): Promise<SampleStartResult> {
    const gen = this.beginGeneration(request.playing);
    const first = this.segment(request.trackId, request.src, request.startAt, request.gain, null);
    this.tail = first;
    return this.request(gen, first, null);
  }

  /**
   * Restart the audible track at `seconds`, keeping whatever was chained after
   * it. A burst of seeks (a scrub drag) restarts the stream for its first
   * and its last target only.
   */
  seek(seconds: number): void {
    const target = Math.max(0, seconds);
    const now = performance.now();
    const burst = now - this.lastSeekAt < SEEK_SETTLE_MS;
    this.lastSeekAt = now;
    if (!burst && this.seekTimer == null) {
      this.seekNow(target);
      return;
    }
    this.pendingSeek = target;
    if (this.seekTimer != null) window.clearTimeout(this.seekTimer);
    this.seekTimer = window.setTimeout(() => {
      this.seekTimer = null;
      const latest = this.pendingSeek;
      this.pendingSeek = null;
      if (latest != null && this.live) this.seekNow(latest);
    }, SEEK_SETTLE_MS);
  }

  /**
   * The audible segment — not the decoder's head, which may already be in
   * the next track — decides which file the seek applies to.
   */
  private seekNow(seconds: number): void {
    const base = this.audible ?? this.tail;
    if (!base) return;
    const chained = base === this.tail ? this.chained : null;
    const gen = this.beginGeneration(this.playing);
    const first = this.segment(base.trackId, base.src, Math.max(0, seconds), base.gain, base.durationSec);
    this.tail = first;
    this.chained = chained ? this.segment(chained.trackId, chained.src, 0, chained.gain, null) : null;
    void this.request(gen, first, this.chained).then((result) => {
      if (result.ok || gen !== this.gen) return;
      this.listener?.({
        type: 'failed',
        segment: first,
        positionSec: first.startSec,
        message: result.error ?? 'Seek failed.',
      });
    });
  }

  /** What should follow the current track; null un-chains it. */
  prepareNext(next: { trackId: number; src: string; gain: number } | null): void {
    if (!this.live || !this.tail) return;
    const current = this.chained;
    if (next && current && current.trackId === next.trackId && current.src === next.src) {
      // Same track, new ReplayGain: the mode changed inside the prepare
      // window. The worklet holds it for the marker if that hasn't arrived.
      if (current.gain !== next.gain) {
        current.gain = next.gain;
        this.node?.port.postMessage({ t: 'gain', token: current.token, gain: next.gain });
      }
      return;
    }
    if (!next && !current) return;
    if (current) this.segments.delete(current.token);
    this.chained = next ? this.segment(next.trackId, next.src, 0, next.gain, null) : null;
    // A released stream restarts with whatever is chained then.
    if (this.parkedAt != null) return;
    void api
      .gaplessPrepareNext(this.gen, this.tail.token, this.chained ? wire(this.chained) : null)
      .catch(() => undefined);
  }

  pause(): void {
    this.report = { ...this.report, segmentFrames: this.segmentFramesNow() };
    this.playing = false;
    this.node?.port.postMessage({ t: 'pause' });
    this.watchStarving(false);
    this.armPark();
  }

  resume(): void {
    this.playing = true;
    this.clearPark();
    // A seek still settling, or a released stream, restarts right here.
    const restartAt = this.pendingSeek ?? this.parkedAt;
    if (restartAt != null) {
      this.seekNow(restartAt);
      return;
    }
    this.report = { ...this.report, frame: this.contextFrame() };
    this.node?.port.postMessage({ t: 'play' });
  }

  stop(): void {
    const gen = this.beginGeneration(false);
    this.live = false;
    this.clearTimers();
    void api.gaplessStop(gen).catch(() => undefined);
  }

  /** Retarget the audible segment's ReplayGain (a settings change mid-track). */
  setAudibleGain(gain: number): void {
    const segment = this.audible ?? this.tail;
    if (!segment || segment.gain === gain) return;
    segment.gain = gain;
    this.node?.port.postMessage({ t: 'gain', token: segment.token, gain });
  }

  /** True when `trackId` became audible through a chained boundary and play() has not claimed it yet. */
  isUnackedChain(trackId: number, src: string): boolean {
    return this.unacked != null && this.unacked.trackId === trackId && this.unacked.src === src;
  }

  ack(): void {
    this.unacked = null;
  }

  hasStream(): boolean {
    return this.live;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  audibleTrackId(): number | null {
    return (this.audible ?? this.tail)?.trackId ?? null;
  }

  /** The audible segment's decoder rate and what converted it; null until one is audible. */
  audibleSignal(): { sourceRate: number | null; resampler: 'none' | ResamplerKind | null } | null {
    return this.audible ? { sourceRate: this.audible.sourceRate, resampler: this.audible.resampler } : null;
  }

  /** Audible position in file seconds, carried forward on the context clock while playing. */
  position(): { currentTime: number; duration: number | null } {
    const segment = this.audible ?? this.tail;
    if (!segment) return { currentTime: 0, duration: null };
    // A seek that is still settling, or a released stream, is where playback resumes.
    const held = this.pendingSeek ?? this.parkedAt;
    if (held != null) return { currentTime: held, duration: segment.durationSec };
    if (segment !== this.audible) return { currentTime: segment.startSec, duration: segment.durationSec };
    return { currentTime: segment.startSec + this.segmentFramesNow() / this.rate(), duration: segment.durationSec };
  }

  // ---------------------------------------------------------------- internals

  private async connect(ctx: AudioContext, destination: AudioNode, seq: number): Promise<boolean> {
    await ctx.audioWorklet.addModule(new URL('./gapless-processor.js', import.meta.url));
    if (seq !== this.attachSeq) return false;
    const node = new AudioWorkletNode(ctx, 'newamp-gapless', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = this.onMessage;
    // A throwing process() leaves the node silent for good: give the audible
    // track to the decks and stop offering this transport.
    node.onprocessorerror = () => {
      if (this.node !== node) return;
      this.unavailableReason = 'The gapless worklet stopped.';
      this.attaching = Promise.resolve(false);
      const segment = this.audible ?? this.tail;
      const positionSec = this.position().currentTime;
      this.live = false;
      this.clearTimers();
      if (segment) this.listener?.({ type: 'failed', segment, positionSec, message: this.unavailableReason });
    };
    const port = await openDataPort();
    if (seq !== this.attachSeq) {
      // Detached while the port was on its way: this node never joins the graph.
      port.close();
      node.port.onmessage = null;
      node.port.postMessage({ t: 'dispose' });
      return false;
    }
    // The PCM port goes straight into the audio thread: main-process frames
    // never wait on this renderer's event loop.
    node.port.postMessage({ t: 'data-port' }, [port]);
    node.connect(destination);
    this.node = node;
    return true;
  }

  private clearTimers(): void {
    if (this.seekTimer != null) window.clearTimeout(this.seekTimer);
    this.seekTimer = null;
    this.pendingSeek = null;
    this.clearPark();
    this.watchStarving(false);
  }

  private armPark(): void {
    this.clearPark();
    if (!this.live) return;
    const gen = this.gen;
    this.parkTimer = window.setTimeout(() => {
      this.parkTimer = null;
      if (gen !== this.gen || this.playing || !this.live || this.parkedAt != null) return;
      const at = this.position().currentTime;
      // Retire the stream on both sides; what's audible stays described so
      // resume() can restart it, chained track included.
      const retired = ++this.gen;
      this.node?.port.postMessage({ t: 'flush', gen: retired, playing: false });
      void api.gaplessStop(retired).catch(() => undefined);
      this.parkedAt = at;
    }, PARK_AFTER_MS);
  }

  private clearPark(): void {
    if (this.parkTimer != null) window.clearTimeout(this.parkTimer);
    this.parkTimer = null;
  }

  private watchStarving(starving: boolean): void {
    if (starving === (this.starveTimer != null)) return;
    if (!starving) {
      window.clearTimeout(this.starveTimer!);
      this.starveTimer = null;
      this.listener?.({ type: 'buffering', on: false });
      return;
    }
    const gen = this.gen;
    this.starveTimer = window.setTimeout(() => {
      this.starveTimer = null;
      const segment = this.audible;
      if (gen !== this.gen || !this.playing || !segment) return;
      const positionSec = this.position().currentTime;
      this.stop();
      this.listener?.({
        type: 'failed',
        segment,
        positionSec,
        message: `The gapless stream stalled for ${STALL_FALLBACK_MS / 1000} s.`,
      });
    }, STALL_FALLBACK_MS);
    this.listener?.({ type: 'buffering', on: true });
  }

  private rate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  private contextFrame(): number {
    return this.ctx ? Math.round(this.ctx.currentTime * this.ctx.sampleRate) : 0;
  }

  private segmentFramesNow(): number {
    const { segmentFrames, frame, starving } = this.report;
    if (!this.playing || starving || !this.audible) return segmentFrames;
    const ahead = Math.min(Math.max(0, this.contextFrame() - frame), MAX_EXTRAPOLATE_SEC * this.rate());
    return segmentFrames + ahead;
  }

  private beginGeneration(playing: boolean): number {
    const gen = ++this.gen;
    this.node?.port.postMessage({ t: 'flush', gen, playing });
    this.clearTimers();
    this.parkedAt = null;
    this.segments.clear();
    this.queuedFailures.clear();
    this.tail = null;
    this.chained = null;
    this.audible = null;
    this.unacked = null;
    this.report = { segmentFrames: 0, frame: this.contextFrame(), starving: false };
    this.live = true;
    this.playing = playing;
    if (!playing) this.armPark();
    return gen;
  }

  private segment(trackId: number, src: string, startSec: number, gain: number, durationSec: number | null): SampleSegment {
    const segment: SampleSegment = {
      token: this.nextToken++,
      trackId,
      src,
      startSec,
      durationSec,
      gain,
      sourceRate: null,
      resampler: null,
    };
    this.segments.set(segment.token, segment);
    return segment;
  }

  private async request(gen: number, first: SampleSegment, next: SampleSegment | null): Promise<SampleStartResult> {
    const ctx = this.ctx;
    let result: GaplessStartResult;
    if (!ctx || !this.node) {
      result = { ok: false, error: this.unavailableReason ?? 'The gapless worklet is not attached.' };
    } else {
      try {
        result = await api.gaplessStart({
          ...wire(first),
          gen,
          sampleRate: ctx.sampleRate,
          next: next ? wire(next) : null,
        });
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    if (gen !== this.gen) return { ok: false, error: 'Superseded by a newer request.', superseded: true };
    this.lastResult = result;
    if (!result.ok) {
      this.live = false;
      this.clearTimers();
      return result;
    }
    if (result.durationSec != null && result.durationSec > 0) first.durationSec = result.durationSec;
    return result;
  }

  private onMessage = (event: MessageEvent): void => {
    const msg = event.data as {
      t: string;
      gen: number;
      token?: number | null;
      durationSec?: number | null;
      first?: boolean;
      frame?: number;
      failed?: string | null;
      segmentFrames?: number;
      starving?: boolean;
      playing?: boolean;
      underruns?: number;
      message?: string;
      audible?: boolean;
      sourceRate?: number | null;
      resampler?: 'none' | ResamplerKind | null;
    };
    if (msg.gen !== this.gen) return;
    switch (msg.t) {
      case 'segment': {
        const segment = msg.token != null ? this.segments.get(msg.token) : undefined;
        if (!segment) return;
        if (msg.durationSec != null && msg.durationSec > 0) segment.durationSec = msg.durationSec;
        segment.sourceRate = msg.sourceRate ?? null;
        segment.resampler = msg.resampler ?? null;
        // Tokens only grow: nothing older than the audible segment can be heard again.
        for (const token of this.segments.keys()) {
          if (token < segment.token) this.segments.delete(token);
        }
        const queuedFailure = this.queuedFailures.get(segment.token) ?? null;
        for (const token of this.queuedFailures.keys()) {
          if (token <= segment.token) this.queuedFailures.delete(token);
        }
        const from = this.audible;
        this.audible = segment;
        this.report = { segmentFrames: 0, frame: msg.frame ?? this.contextFrame(), starving: false };
        if (msg.first || !from) return;
        this.tail = segment;
        this.chained = null;
        const failed = msg.failed ?? queuedFailure;
        this.unacked = failed ? null : segment;
        this.listener?.({ type: 'boundary', from, to: segment, failed });
        // What the stream holds of it is only its head; silence beats
        // hearing that head and then the decks starting the track over.
        if (queuedFailure && !msg.failed) this.stop();
        return;
      }
      case 'dur': {
        const segment = msg.token != null ? this.segments.get(msg.token) : undefined;
        if (segment && msg.durationSec != null && msg.durationSec > 0) segment.durationSec = msg.durationSec;
        return;
      }
      case 'pos':
        if (msg.token == null || msg.token !== this.audible?.token) return;
        // A pause report that lands after a quick resume carries the paused
        // frame count but an old clock; restart the carry-forward from now.
        this.report = {
          segmentFrames: msg.segmentFrames ?? 0,
          frame: msg.playing === false && this.playing ? this.contextFrame() : msg.frame ?? 0,
          starving: !!msg.starving,
        };
        this.underruns = msg.underruns ?? this.underruns;
        this.watchStarving(this.report.starving && this.playing);
        return;
      case 'drained': {
        this.live = false;
        this.clearTimers();
        const segment = this.audible;
        const positionSec = segment ? segment.startSec + (msg.segmentFrames ?? 0) / this.rate() : 0;
        this.report = { segmentFrames: msg.segmentFrames ?? 0, frame: msg.frame ?? 0, starving: false };
        this.playing = false;
        this.listener?.({ type: 'drained', segment, positionSec });
        return;
      }
      case 'fail': {
        if (!msg.audible) {
          // A chained segment failed while still queued (its resampler died
          // under it): it can't play out whole here, so its boundary will
          // report it failed and the decks will play it instead.
          const segment = msg.token != null ? this.segments.get(msg.token) : undefined;
          if (segment && segment !== this.audible) this.queuedFailures.set(segment.token, msg.message ?? 'Decode failed.');
          return;
        }
        if (!this.audible) return;
        this.live = false;
        this.clearTimers();
        this.listener?.({
          type: 'failed',
          segment: this.audible,
          positionSec: this.position().currentTime,
          message: msg.message ?? 'Decode failed.',
        });
        return;
      }
    }
  };
}
