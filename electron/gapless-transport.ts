// Sample-accurate gapless transport — the main-process half.
//
// The shared output's deck path (src/audio/engine.ts) can only start the next
// track's media element after the current one fires `ended`, which leaves
// ~20 ms of digital silence at every boundary however early the next deck
// preloads. For local tracks this module replaces that handoff: ffmpeg decodes
// each track to interleaved f32 stereo, a chained track's first frame follows
// the previous track's last frame in the same stream, and the stream goes
// straight to the renderer's AudioWorklet over a MessagePort
// (src/audio/gapless-processor.js). A segment marker travels in-band at the
// exact frame where each track starts, so the audio thread — not a timer and
// not a media event — decides when a boundary is audible.
//
// Rates: every frame on the wire is at the AudioContext rate. The decoder
// writes a WAV header before its PCM, and the rate in that header — not the
// library's metadata — decides whether a track needs resampling: Opus always
// decodes at 48 kHz whatever its OpusHead says, and HE-AAC's SBR doubles the
// core rate the container may report. Tracks at another rate go through ONE
// long-lived resampler that a same-rate chain keeps feeding across
// boundaries. Resampling each track on its own truncates the filter at both
// edges (measured at a 44.1k→48k split: a -16 dBFS error spike and a
// one-sample phase slip). Which resampler runs (soxr, or the high-precision
// swr fallback on builds without it) is decided once in electron/resampler.ts.
//
// Flow control is credit-based: the worklet reports how many frames it has
// played or dropped, and while more than HIGH_WATER_SEC is in flight the
// producer pauses its ffmpeg pipes, so memory stays bounded at any rate and
// any track length.
//
// Durations: a segment starts with the library's duration, the decoder's own
// header estimate fills it in when the library has none, and the exact
// decoded length replaces either once the decoder finishes. Each correction
// travels as a 'dur' message, so the scrubber and the renderer's prepare
// window follow what is actually playing.

import { MessageChannelMain, type IpcMain, type MessagePortMain, type WebContents } from 'electron';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { playableLength } from './gapless-trim.js';
import { killChild } from './kill-child.js';
import { reportPlaybackHunger } from './playback-io.js';
import {
  isStorageReadFailure,
  logReadFailure,
  probeFileRead,
  rememberStorageGone,
  storageAnswered,
  storageKnownGone,
} from './read-failure.js';
import { probeResampler, resamplerFilter } from './resampler.js';
import { INPUT_PROTOCOLS, awaitChildExit, ffmpegInputKey, resolveFfmpegPath } from './transcode.js';
import type {
  ExclusiveTrackSource,
  GaplessSegmentRequest,
  GaplessStartRequest,
  GaplessStartResult,
  ResamplerKind,
} from '../shared/types.js';

const CHANNELS = 2;
const FRAME_BYTES = CHANNELS * 4;
// Thirty seconds decoded ahead rides out a drive that stalls for a while (one
// busy with downloads and a media-server scan measured 450 ms per read);
// three, as this shipped with, did not. Memory is ~11 MB at 48 kHz.
const HIGH_WATER_SEC = 30;
const LOW_WATER_SEC = 20;
// Below this while still decoding, the drive is not keeping up: background
// decodes hold off until the stream is back at LOW_WATER_SEC (see
// playback-io.ts). Under the ~10 s left when the next track is chained, so
// an ordinary handoff doesn't count.
const HUNGRY_SEC = 8;
// With nothing chained, the end-of-stream marker is held until the worklet is
// this close to running dry, so a prepareNext that lands late (a seek into the
// last seconds, a slow queue refill) still splices instead of gapping.
const END_GUARD_SEC = 0.5;
// ffmpeg's pipe reads are coalesced into messages of at least this many frames.
const MIN_POST_FRAMES = 4096;
// The first plan's start() gives up at this, whatever the decoder is doing: a
// seek into a share that stays gone rejects with a timeout here rather than
// waiting out DECODE_OUTAGE_MS, and the decks take the track. Chained tracks
// and mid-track reads get the long waits. Looking the track up before any
// decoder runs is held to the same limit.
const FIRST_AUDIO_TIMEOUT_MS = Number(process.env.NEWAMP_FIRST_AUDIO_TIMEOUT_MS) || 15000;
// How long a release waits for a killed decoder to let go of its file.
const RELEASE_EXIT_TIMEOUT_MS = 2000;
// Only the last few segment starts can still be revoked: the producer runs at
// most HIGH_WATER_SEC ahead of the audible playhead.
const STARTED_LOG_CAP = 8;
// RIFF + fmt + data headers from ffmpeg's WAV muxer run ~100 bytes.
const MAX_WAV_HEADER_BYTES = 64 * 1024;
// ffmpeg's input dump, with -loglevel level+info.
const DURATION_LINE = /^\[info\]\s+Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;
const ERROR_LINE = /\[(?:error|fatal|panic)\] /;
// A decode stopped by a failed read starts again where it stopped, waiting a
// little longer each time, for as long as the outage lasts up to
// DECODE_OUTAGE_MS. The worklet holds up to HIGH_WATER_SEC of audio, so a read
// that recovers within that is not heard; past it the renderer waits (see
// 'wait') rather than giving the track up. The count is per outage, not per
// track: a share that drops every so often can drop any number of times in a
// long track, and each recovery starts the count again.
const DECODE_RESUME_DELAY_MS = 1000;
const DECODE_RESUME_MAX_DELAY_MS = 5000;
const DECODE_OUTAGE_MS = Number(process.env.NEWAMP_DECODE_OUTAGE_MS) || 60_000;
// A decoder that stopped with no sign of a failed read (a damaged file) is
// tried again only this long.
const DECODE_ERROR_MS = Number(process.env.NEWAMP_DECODE_ERROR_MS) || 10_000;
// A decoder that ends on a failed read before its first frame (the open itself
// timed out, or it sat idle until DECODE_OPEN_STALL_MS) is tried again this
// long, counted from the first stop.
const DECODE_OPEN_RETRY_MS = 12_000;
// A resumed decode that got this far before failing again recovered: the next
// failure is a new outage.
const DECODE_PROGRESS_SEC = 1;
// A decoder that neither sends audio nor exits (blocked in a read the share
// never answers) is idle. Past DECODE_WAIT_IDLE_MS, with the worklet running
// low, the renderer is told it is waiting on the drive; past the stall limit
// the decoder is stopped and read again from where it was, like one that failed
// outright. A decoder that has not named its rate yet is given longer, since
// opening a file on a slow share can take that long. Only time spent with its
// pipe open counts: flow control holding it is not a stall.
const DECODE_WAIT_IDLE_MS = 1500;
const DECODE_STALL_MS = Number(process.env.NEWAMP_DECODE_STALL_MS) || 8000;
const DECODE_OPEN_STALL_MS = Number(process.env.NEWAMP_DECODE_OPEN_STALL_MS) || 20_000;
const WATCHDOG_TICK_MS = 500;
// A decoder stopped for sending nothing has usually exited by the time the
// file is read again. One blocked in a read the system won't interrupt (a share
// that stopped answering) outlives its kill, and its replacement can end up
// the same way: with this many still running, no further one is started.
const STUCK_DECODER_LIMIT = 2;
// A track that stops on a non-storage error this close to its length is
// treated as having ended there. A decoder that exits cleanly further than
// this from the length the track is known to have is not taken at its word
// (see confirmEnd); the library's length for a VBR file can be this far off.
const DECODE_END_SLACK_SEC = 2;
// How far before the stop a resumed decode seeks, to be discarded (see spawnDecoder).
const RESUME_WARMUP_SEC = 0.25;
// How long start() waits for a container's playable length before decoding
// without it.
const PLAYABLE_LENGTH_TIMEOUT_MS = 2000;
// Smaller corrections are rounding, not news.
const DURATION_EPSILON_SEC = 0.01;

type StreamMessage =
  | {
      t: 'seg';
      gen: number;
      token: number;
      trackId: number;
      startSec: number;
      durationSec: number | null;
      gain: number;
      /** The rate the decoder produced. */
      sourceRate: number | null;
      resampler: 'none' | ResamplerKind;
    }
  | { t: 'fail'; gen: number; token: number; message: string }
  | { t: 'cut'; gen: number; token: number }
  | { t: 'pcm'; gen: number; pcm: Float32Array }
  /** A better duration for a segment, wherever it is in the stream. */
  | { t: 'dur'; gen: number; token: number; durationSec: number }
  /**
   * Out of band: a read failed and the file is being read again (`on`), or
   * audio is coming again. Running dry meanwhile is waiting on the drive; the
   * track either carries on or fails in-band.
   */
  | { t: 'wait'; gen: number; on: boolean }
  | { t: 'end'; gen: number };

/** One run of failed reads with no recovery between them. */
interface Outage {
  /** Reads started again so far in this outage. */
  attempt: number;
  /** When its first read failed (performance.now(), which a sleep or a clock change doesn't move). */
  since: number;
  /** One of its failures was the storage's, so a later one that isn't recognised as that still gets the long wait. */
  storage: boolean;
}

/** Where a decode stopped by a failed read picks up again: the same segment, after `bytes`. */
interface DecodeResume extends Outage {
  at: number;
  rate: number;
  bytes: number;
  /** Started right after the file was read to its end, to find out whether a clean early exit was the end of the track. */
  confirming?: boolean;
}

// Decoders that were stopped for sending nothing and have not exited yet.
const stuckDecoders = new Set<ChildProcessByStdio<null, Readable, Readable>>();

interface Plan {
  token: number;
  source: ExclusiveTrackSource;
  startAt: number;
  gain: number;
  /** Where the music ends, when the container says so and ffmpeg won't stop there itself. */
  playable: { frames: number; rate: number } | null;
  /** The best duration known so far: the library's, then the decoder's. */
  durationSec: number | null;
}

export type GaplessSourceResolver = (trackId: number) => Promise<ExclusiveTrackSource | null>;

/** Where the music ends in the decoder's output, in bytes from `plan.startAt`, when the container says so. */
function limitBytesFor(plan: Plan, rate: number): number | null {
  // The container's end point is in decoder frames.
  const remaining = plan.playable && plan.playable.rate === rate
    ? plan.playable.frames - Math.round(plan.startAt * rate)
    : null;
  return remaining != null && remaining > 0 ? remaining * FRAME_BYTES : null;
}

/**
 * Where the PCM starts in ffmpeg's piped WAV output, and its rate. 'more'
 * until the data chunk's header has arrived; null for anything but the
 * stereo f32 the decoder was asked for.
 */
function parseWavHeader(bytes: Buffer): { rate: number; dataOffset: number } | 'more' | null {
  if (bytes.length < 12) return 'more';
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') return null;
  let rate: number | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4);
    // Sizes are 0xFFFFFFFF on a pipe; only fmt's is read.
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') return rate != null ? { rate, dataOffset: offset + 8 } : null;
    const end = offset + 8 + size + (size & 1);
    if (end > bytes.length) return 'more';
    if (id === 'fmt ') {
      if (size < 16) return null;
      const channels = bytes.readUInt16LE(offset + 10);
      const bits = bytes.readUInt16LE(offset + 22);
      rate = bytes.readUInt32LE(offset + 12);
      if (channels !== CHANNELS || bits !== 32 || rate <= 0) return null;
    }
    offset = end;
  }
  return 'more';
}

/**
 * Frame-aligned writer onto the port. Coalesces pipe reads into
 * MIN_POST_FRAMES messages and places markers at absolute frame positions, so
 * a marker computed ahead of its data (a resampler's delayed output) still
 * lands between the right two frames.
 */
class FrameOutput {
  /** Whole frames received, posted or pending. */
  accepted = 0;
  /** Frames posted to the port. */
  sent = 0;
  private carry: Buffer = Buffer.alloc(0);
  private marks: Array<{ at: number; msg: StreamMessage }> = [];
  // Frames at or past this position are dropped (a revoked chained segment).
  private limit: number | null = null;

  constructor(
    private readonly gen: number,
    private readonly post: (msg: StreamMessage) => void,
  ) {}

  push(bytes: Buffer): void {
    let carry = this.carry.length ? Buffer.concat([this.carry, bytes]) : bytes;
    if (this.limit != null) carry = carry.subarray(0, Math.max(0, this.limit - this.sent) * FRAME_BYTES);
    this.carry = carry;
    this.accepted = this.sent + Math.floor(carry.length / FRAME_BYTES);
    this.drainMarks();
    if (this.accepted - this.sent >= MIN_POST_FRAMES) this.postFrames(this.accepted - this.sent);
  }

  mark(at: number, msg: StreamMessage): void {
    this.marks.push({ at, msg });
    this.drainMarks();
  }

  /** Drop everything from frame `at` on, including markers placed there. */
  truncate(at: number): void {
    this.limit = Math.max(at, this.sent);
    this.carry = this.carry.subarray(0, (this.limit - this.sent) * FRAME_BYTES);
    this.accepted = this.sent + Math.floor(this.carry.length / FRAME_BYTES);
    this.marks = this.marks.filter((m) => m.at < at);
  }

  release(): void {
    this.limit = null;
  }

  /** A new source starts on a frame boundary: drop any partial frame the last one left. */
  alignFrames(): void {
    this.carry = this.carry.subarray(0, (this.accepted - this.sent) * FRAME_BYTES);
  }

  /** Post every pending frame, then any marker left at the tail. */
  flush(): void {
    this.drainMarks();
    if (this.accepted > this.sent) this.postFrames(this.accepted - this.sent);
    for (const { msg } of this.marks.splice(0)) this.post(msg);
  }

  private drainMarks(): void {
    while (this.marks.length && this.marks[0]!.at <= this.accepted) {
      const { at, msg } = this.marks.shift()!;
      if (at > this.sent) this.postFrames(at - this.sent);
      this.post(msg);
    }
  }

  private postFrames(frames: number): void {
    const bytes = frames * FRAME_BYTES;
    // Copy rather than view: pipe chunks are neither 4-byte aligned nor sized
    // to a frame, and structured clone would otherwise ship a pooled chunk's
    // whole backing store.
    const pcm = new Float32Array(frames * CHANNELS);
    Buffer.from(pcm.buffer).set(this.carry.subarray(0, bytes));
    this.carry = this.carry.subarray(bytes);
    this.sent += frames;
    this.post({ t: 'pcm', gen: this.gen, pcm });
  }
}

interface Resampler {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  rate: number;
  /** Stream frame where this resampler's first output frame lands. */
  base: number;
  inBytes: number;
  onClose: ((code: number | null) => void) | null;
}

/** One generation of the stream: a first segment plus whatever chains after it. */
class Session {
  private readonly out: FrameOutput;
  private consumed = 0;
  private decoder: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private decoderPlan: Plan | null = null;
  // A decode waiting to read again after a failed read, and where from.
  private resumeTimer: NodeJS.Timeout | null = null;
  private pendingResume: { plan: Plan; at: number; rate: number; bytes: number } | null = null;
  // Likewise a decode that failed before its first frame, waiting to open the file again.
  private pendingOpen: Plan | null = null;
  // The file system is being asked about a file whose decoder stopped (see
  // probeFileRead); replaced or cleared when the answer no longer matters.
  private asking: object | null = null;
  // Told the renderer a read failed and the file is being read again.
  private waiting = false;
  // A decoder releasePaths stopped on purpose: its early end is not a failed read.
  private abandoned: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private resampler: Resampler | null = null;
  private readonly started: Array<{ plan: Plan; at: number }> = [];
  private next: Plan | null;
  private deferredNext: { after: number; plan: Plan | null } | null = null;
  // 'opening': a decoder is running but hasn't named its rate yet.
  private phase: 'opening' | 'decoding' | 'switching' | 'waiting' | 'finishing' | 'done' | 'closed' = 'opening';
  private stalled: Readable | null = null;
  private first: { resolve: () => void; reject: (err: Error) => void } | null = null;
  // Set once the first segment is placed.
  firstRate: number | null = null;
  // Which resampler this ffmpeg runs, once its probe has answered. Only a
  // track at another rate than the stream's has to wait for that.
  resamplerKind: ResamplerKind | null = null;
  // The first segment was a seek to its end: it played out with no frames.
  private firstPlayedOut = false;
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly hungryBelow: number;
  private hungry = false;
  private readonly endGuard: number;

  constructor(
    readonly gen: number,
    private readonly port: MessagePortMain,
    private readonly rate: number,
    private readonly ffmpeg: string,
    private readonly probing: Promise<ResamplerKind>,
    private readonly firstPlan: Plan,
    next: Plan | null,
  ) {
    this.out = new FrameOutput(gen, (msg) => this.post(msg));
    void probing.then((kind) => {
      this.resamplerKind = kind;
    });
    this.next = next;
    this.highWater = Math.round(rate * HIGH_WATER_SEC);
    this.lowWater = Math.round(rate * LOW_WATER_SEC);
    this.hungryBelow = Math.round(rate * HUNGRY_SEC);
    this.endGuard = Math.round(rate * END_GUARD_SEC);
  }

  /** Resolves once the first frames are on the port; rejects if the first segment yields none. */
  begin(): Promise<void> {
    const started = new Promise<void>((resolve, reject) => {
      this.first = { resolve, reject };
    });
    const timer = setTimeout(() => this.failFirst(new Error('Timed out waiting for decoded audio.')), FIRST_AUDIO_TIMEOUT_MS);
    this.startSegment(this.firstPlan);
    return started.finally(() => clearTimeout(timer));
  }

  /**
   * Set what follows segment `after`. When something else was already spliced
   * in after it (a queue edit or Stop-after-current landed inside the prepare
   * window), that splice is cut out of the stream first.
   */
  prepareNext(after: number, plan: Plan | null): void {
    if (this.phase === 'opening' || this.phase === 'switching') {
      this.deferredNext = { after, plan };
      return;
    }
    if (this.phase !== 'decoding' && this.phase !== 'waiting') return;
    const index = this.started.findIndex((s) => s.plan.token === after);
    if (index < 0) return;
    const following = this.started[index + 1];
    if (!following) {
      if (this.phase === 'waiting') {
        if (plan) this.startSegment(plan);
      } else {
        this.next = plan;
      }
      return;
    }
    if (following.plan.token === plan?.token) return;
    this.cutAfter(index, plan);
  }

  credit(consumed: number): void {
    if (consumed > this.consumed) this.consumed = consumed;
    if (this.stalled && this.inflight() <= this.lowWater) {
      const source = this.stalled;
      this.stalled = null;
      source.resume();
    }
    this.checkEndGuard();
    this.reportPressure();
  }

  close(): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.hungry = false;
    reportPlaybackHunger(this, false);
    this.cancelResume();
    this.killDecoder();
    if (this.resampler) {
      this.resampler.onClose = null;
      killChild(this.resampler.child);
      this.resampler = null;
    }
    this.stalled = null;
    this.failFirst(new Error('Superseded by a newer request.'));
  }

  /**
   * Stop reading the files `held` names, so they can be moved: a plan on one
   * that hasn't started is dropped, as is a decoder on one that hasn't placed
   * its segment yet, and a decoder on one that has is killed and treated as a
   * decode that ended early, so the stream carries on with whatever follows.
   * Resolves once that decoder has exited.
   */
  releasePaths(held: (path: string) => boolean): Promise<void> {
    if (this.next && held(this.next.source.path)) this.next = null;
    if (this.deferredNext?.plan && held(this.deferredNext.plan.source.path)) {
      this.deferredNext = { after: this.deferredNext.after, plan: null };
    }
    const pending = this.pendingResume;
    if (pending && held(pending.plan.source.path)) {
      // Waiting to read the file again after a failed read: it ends early
      // here instead, with what it has.
      this.cancelResume();
      this.onDecoded(pending.plan, pending.at, pending.rate, pending.bytes, null, 'released', null);
      return Promise.resolve();
    }
    const opening = this.pendingOpen;
    if (opening && held(opening.source.path)) {
      // Waiting to open the file again after a failed first read: nothing of
      // it has reached the stream.
      this.cancelResume();
      this.forgetOpening(opening);
      return Promise.resolve();
    }
    const decoder = this.decoder;
    const plan = this.decoderPlan;
    if (!decoder || !plan || !held(plan.source.path)) return Promise.resolve();
    const exited = awaitChildExit(decoder, RELEASE_EXIT_TIMEOUT_MS);
    if (this.phase !== 'opening') {
      // Left in place: its close handler runs the ended-early path, and does
      // not read the file again.
      this.abandoned = decoder;
      killChild(decoder);
      return exited;
    }
    // Nothing of it has reached the stream (a chained decoder sits here,
    // paused, through the last seconds of every track), so there is nothing
    // to end early and nothing to fail in-band: forgotten before the kill, so
    // what its pipe flushes on exit and its close land on a stale child, and
    // the stream waits for whatever is named next, as after a cut. The first
    // segment has no stream to go on with.
    this.killDecoder();
    this.forgetOpening(plan);
    return exited;
  }

  /** `plan` was dropped before any of it reached the stream (its file is being moved). */
  private forgetOpening(plan: Plan): void {
    if (plan === this.firstPlan) {
      this.failFirst(new Error('The file is being moved.'));
      return;
    }
    this.phase = 'waiting';
    const deferred = this.deferredNext;
    this.deferredNext = null;
    if (deferred) this.prepareNext(deferred.after, deferred.plan);
    this.checkEndGuard();
  }

  // ---------------------------------------------------------------- internals

  // Counts frames still being coalesced into a post too, so a source switch
  // can't slip a pipe read past the high-water check while they wait.
  private inflight(): number {
    return this.out.accepted - this.consumed;
  }

  // Hungry from under hungryBelow until back at lowWater, and only while a
  // decoder is still filling: the drain after a track's last frame is not.
  private reportPressure(): void {
    if (this.phase === 'closed') return;
    const filling = this.phase === 'opening' || this.phase === 'decoding' || this.phase === 'switching';
    const queued = this.inflight();
    const hungry = filling && queued < (this.hungry ? this.lowWater : this.hungryBelow);
    if (hungry === this.hungry) return;
    this.hungry = hungry;
    reportPlaybackHunger(this, hungry);
  }

  private post(msg: StreamMessage): void {
    if (this.phase === 'closed') return;
    try {
      this.port.postMessage(msg);
    } catch {
      /* renderer went away; the next open() or close() cleans up */
    }
  }

  private setWaiting(on: boolean): void {
    if (this.waiting === on) return;
    this.waiting = on;
    this.post({ t: 'wait', gen: this.gen, on });
  }

  private failFirst(err: Error): void {
    if (!this.first) return;
    const { reject } = this.first;
    this.first = null;
    reject(err);
    if (this.phase !== 'closed') this.close();
  }

  /** The stream frame the next input would land on. */
  private writeHead(): number {
    const resampler = this.resampler;
    return resampler
      ? resampler.base + Math.round((Math.floor(resampler.inBytes / FRAME_BYTES) * this.rate) / resampler.rate)
      : this.out.accepted;
  }

  /** A pipe that stopped feeding can no longer hold the stall. */
  private release(source: Readable): void {
    if (this.stalled === source) this.stalled = null;
  }

  private startSegment(plan: Plan): void {
    // Nothing is placed until the decoder's header says what rate it runs at.
    this.phase = 'opening';
    this.spawnDecoder(plan);
  }

  /**
   * Put `plan` on the stream now that its decoder rate is known, then call
   * `go` with the frame it starts at.
   */
  private placeSegment(plan: Plan, rate: number, go: (at: number) => void): void {
    const resampleFrom = rate !== this.rate ? rate : null;
    const kind = this.resamplerKind;
    if (resampleFrom != null && kind == null) {
      // The first track to need a resampler waits for the probe; one at the
      // stream's own rate never does.
      this.phase = 'switching';
      void this.probing.then((answer) => {
        this.resamplerKind = answer;
        if (this.phase !== 'closed') this.placeSegment(plan, rate, go);
      });
      return;
    }
    if (this.resampler && this.resampler.rate !== resampleFrom) {
      // A rate change cannot share a filter with what came before: drain the
      // old resampler, then begin this segment on a fresh stage.
      this.phase = 'switching';
      this.drainResampler(() => this.placeSegment(plan, rate, go));
      return;
    }
    if (!this.resampler) {
      this.out.alignFrames();
      if (resampleFrom != null && kind != null) this.resampler = this.spawnResampler(resampleFrom, kind);
    }
    const at = this.writeHead();
    if (plan === this.firstPlan) this.firstRate = rate;
    this.phase = 'decoding';
    this.started.push({ plan, at });
    if (this.started.length > STARTED_LOG_CAP) this.started.splice(0, this.started.length - STARTED_LOG_CAP);
    this.markSegment(plan, at, rate);
    go(at);
    const deferred = this.deferredNext;
    this.deferredNext = null;
    if (deferred) this.prepareNext(deferred.after, deferred.plan);
  }

  private markSegment(plan: Plan, at: number, rate: number | null): void {
    this.out.mark(at, {
      t: 'seg',
      gen: this.gen,
      token: plan.token,
      trackId: plan.source.trackId,
      startSec: plan.startAt,
      durationSec: plan.durationSec,
      gain: plan.gain,
      sourceRate: rate,
      resampler: rate == null || rate === this.rate ? 'none' : (this.resamplerKind ?? 'none'),
    });
  }

  /**
   * A better duration for `plan`. It goes out at once rather than in-band:
   * the worklet applies it to the segment whether it is audible, queued, or
   * not on the port yet.
   */
  private setDuration(plan: Plan, durationSec: number): void {
    if (!(durationSec > 0)) return;
    if (plan.durationSec != null && Math.abs(plan.durationSec - durationSec) < DURATION_EPSILON_SEC) return;
    plan.durationSec = durationSec;
    this.post({ t: 'dur', gen: this.gen, token: plan.token, durationSec });
  }

  /**
   * Decode `plan` into the stream. With `resume`, carry on a segment that is
   * already placed, from the frame a failed read stopped it at. `opening` is
   * the outage a segment that has not been placed yet is being opened again
   * after.
   */
  private spawnDecoder(plan: Plan, resume: DecodeResume | null = null, opening: Outage | null = null): void {
    const from = resume ? plan.startAt + resume.bytes / FRAME_BYTES / resume.rate : plan.startAt;
    // The first frames decoded after a seek are not what a decode from the
    // start would give there (MP3's bit reservoir and AAC's overlap have no
    // history to work from). A resume therefore seeks a little earlier and
    // discards what it repeats.
    const warmFrames = resume && resume.bytes > 0 ? Math.min(Math.round(RESUME_WARMUP_SEC * resume.rate), Math.floor(from * resume.rate)) : 0;
    const seekTo = resume ? from - warmFrames / resume.rate : from;
    const args = [
      '-hide_banner',
      '-nostdin',
      // Info level for the input's Duration line; only error lines are kept.
      '-loglevel',
      'level+info',
      '-nostats',
      ...(seekTo > 0 ? ['-ss', seekTo.toFixed(6)] : []),
      ...INPUT_PROTOCOLS,
      '-i',
      plan.source.path,
      '-map',
      '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      // Mono goes to both channels at unity, the way Chromium's decoders
      // upmix it; `-ac 2` would mix it in 3 dB down. Anything wider still
      // downmixes exactly as `-ac 2` does, and stereo passes through as is.
      '-af',
      'aformat=channel_layouts=mono|stereo,pan=stereo|FL=FL+FC|FR=FR+FC',
      '-c:a',
      'pcm_f32le',
      // No tags in the WAV header. A large one (a long FLAC comment) outgrows
      // ffmpeg's IO buffer, and on a pipe it can't seek back to fix the chunk
      // size, which leaves the header unreadable.
      '-map_metadata',
      '-1',
      '-fflags',
      '+bitexact',
      // No -ar: the decoder runs at its own rate and says so in the header.
      '-f',
      'wav',
      'pipe:1',
    ];
    const child = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.decoder = child;
    this.decoderPlan = plan;
    // Chained while the worklet is already full: read nothing, not even the
    // header, until credit comes back.
    if (!this.stalled && this.inflight() >= this.highWater) {
      child.stdout.pause();
      this.stalled = child.stdout;
    }
    let header: Buffer | null = Buffer.alloc(0);
    // PCM that arrives after the header and before the segment is placed (a
    // rate switch drains the previous resampler first; an exited decoder's
    // paused pipe is flushed by Node regardless), and an exit that came then.
    let held: Buffer[] | null = null;
    let exited: { code: number | null; detail: string } | null = null;
    let placed: { at: number; rate: number; limitBytes: number | null } | null = null;
    let partial: Buffer = Buffer.alloc(0);
    let bytes = resume?.bytes ?? 0;
    // The front of a resumed decode that the stream already has.
    let discard = warmFrames * FRAME_BYTES;
    let stderr = '';
    let line = '';
    let settled = false;
    // Time with its pipe open and nothing arriving (see DECODE_STALL_MS).
    let idleMs = 0;
    let lastTick = performance.now();
    const watchdog = setInterval(() => {
      const now = performance.now();
      // Capped, so a tick that fires late (this process was stalled or asleep) isn't counted as the decoder's silence.
      const elapsed = Math.min(now - lastTick, WATCHDOG_TICK_MS * 2);
      lastTick = now;
      if (settled || this.decoder !== child) {
        clearInterval(watchdog);
        return;
      }
      if (child.stdout.isPaused()) {
        idleMs = 0;
        return;
      }
      idleMs += elapsed;
      // The first segment has no stream to run dry yet, and its start() has
      // its own timeout; a chained one is what the worklet runs dry for.
      const audible = placed != null || resume != null || plan !== this.firstPlan;
      if (idleMs >= DECODE_WAIT_IDLE_MS && audible && this.inflight() < this.hungryBelow) this.setWaiting(true);
      // A decoder that reads the file again after a failed read is opening it
      // too, until its header arrives.
      if (idleMs < (placed != null ? DECODE_STALL_MS : DECODE_OPEN_STALL_MS)) return;
      if (placed == null && resume == null && plan === this.firstPlan) return;
      clearInterval(watchdog);
      console.warn(`[newamp] gapless decoder sent nothing for ${Math.round(idleMs / 1000)} s for ${plan.source.path}`);
      this.decoder = null;
      this.release(child.stdout);
      if (child.exitCode == null && child.signalCode == null) {
        stuckDecoders.add(child);
        child.once('exit', () => stuckDecoders.delete(child));
      }
      killChild(child);
      complete(1, stderr, idleMs);
    }, WATCHDOG_TICK_MS);
    watchdog.unref();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const lines = (line + chunk).split(/\r?\n|\r/);
      // Bounded: a tag dump can run to tens of kilobytes on one line.
      line = lines.pop()!.slice(-4000);
      for (const text of lines) {
        if (ERROR_LINE.test(text)) {
          stderr = (stderr + text + '\n').slice(-4000);
          continue;
        }
        // The input's header length stands in only where the library has none.
        const match = DURATION_LINE.exec(text);
        if (match && !(plan.durationSec != null && plan.durationSec > 0) && this.decoder === child) {
          this.setDuration(plan, Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
        }
      }
    });
    const take = (chunk: Buffer, where: { at: number; rate: number; limitBytes: number | null }): void => {
      if (discard > 0) {
        const dropped = Math.min(discard, chunk.length);
        discard -= dropped;
        chunk = chunk.subarray(dropped);
      }
      // Whole frames only, so a partial frame at the end of one decoder
      // can never shift the samples of the next.
      const joined = partial.length ? Buffer.concat([partial, chunk]) : chunk;
      const whole = joined.length - (joined.length % FRAME_BYTES);
      partial = joined.subarray(whole);
      let pcm = joined.subarray(0, whole);
      const { limitBytes } = where;
      const atEnd = limitBytes != null && bytes + pcm.length >= limitBytes;
      if (atEnd) pcm = pcm.subarray(0, limitBytes - bytes);
      bytes += pcm.length;
      if (pcm.length) {
        this.feed(pcm, child);
        this.setWaiting(false);
        storageAnswered(plan.source.path);
      }
      if (!atEnd) return;
      // Everything past this point is the encoder's end padding.
      this.decoder = null;
      settled = true;
      this.release(child.stdout);
      killChild(child);
      this.onDecoded(plan, where.at, where.rate, bytes, 0, '');
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.decoder !== child) return;
      idleMs = 0;
      if (placed) {
        take(chunk, placed);
        return;
      }
      if (held) {
        held.push(chunk);
        return;
      }
      header = Buffer.concat([header!, chunk]);
      const parsed = parseWavHeader(header);
      if (parsed === 'more' && header.length <= MAX_WAV_HEADER_BYTES) return;
      if (parsed === 'more' || parsed === null) {
        settled = true;
        this.decoder = null;
        this.release(child.stdout);
        killChild(child);
        if (resume) {
          // The segment is on the stream already, so it can't fail as one
          // that never started: this is a failed read like any other, tried
          // again or given up on where its audio stops.
          this.onDecoded(plan, resume.at, resume.rate, bytes, 1, 'unreadable decoder output', {
            attempt: resume.attempt,
            since: resume.since,
            storage: resume.storage,
          });
          return;
        }
        this.failSegment(plan, 'Unreadable decoder output.');
        return;
      }
      const pcmAfterHeader = header.subarray(parsed.dataOffset);
      header = null;
      if (resume) {
        // The segment is on the stream already; this decoder only continues it.
        if (parsed.rate !== resume.rate) {
          // Nothing it decodes can follow what the stream already has. Not
          // the end of the track either: it fails where its audio stops.
          settled = true;
          this.decoder = null;
          this.release(child.stdout);
          killChild(child);
          console.warn(`[newamp] gapless decode of ${plan.source.path} came back at ${parsed.rate} Hz after a failed read, not ${resume.rate} Hz`);
          this.failPartway(plan, 'Decode failed partway through the track.', 'Decode failed.');
          return;
        }
        placed = { at: resume.at, rate: parsed.rate, limitBytes: limitBytesFor(plan, parsed.rate) };
        take(pcmAfterHeader, placed);
        return;
      }
      held = [pcmAfterHeader];
      // Hold the pipe while the segment is placed.
      child.stdout.pause();
      this.placeSegment(plan, parsed.rate, (at) => {
        placed = { at, rate: parsed.rate, limitBytes: limitBytesFor(plan, parsed.rate) };
        const waiting = held ?? [];
        held = null;
        for (const pcm of waiting) {
          if (this.decoder !== child) return;
          take(pcm, placed);
        }
        if (this.decoder !== child) return;
        if (exited) complete(exited.code, exited.detail);
        // Unless that already filled the worklet.
        else if (this.stalled !== child.stdout) child.stdout.resume();
      });
    });
    // `stalledMs` is how long the decoder sat idle when it was stopped for that.
    const complete = (code: number | null, detail: string, stalledMs = 0): void => {
      settled = true;
      clearInterval(watchdog);
      this.decoder = null;
      this.release(child.stdout);
      const abandoned = this.abandoned === child;
      if (abandoned) this.abandoned = null;
      const now = performance.now();
      const stalled = stalledMs > 0;
      // A resumed decode that recovered before stopping again begins a new
      // outage if this stop is a failed read; one that didn't carries on the old.
      const recovered = !resume || bytes - resume.bytes >= DECODE_PROGRESS_SEC * resume.rate * FRAME_BYTES;
      const outage: Outage | null = abandoned
        ? null
        : recovered
          ? { attempt: 0, since: now - stalledMs, storage: stalled }
          : { attempt: resume.attempt, since: resume.since, storage: resume.storage || stalled };
      // Started to find out whether a clean early exit was the end of the
      // track, and added nothing beyond what it was asked to repeat.
      const confirmed =
        resume?.confirming === true && bytes - resume.bytes < RESUME_WARMUP_SEC * resume.rate * FRAME_BYTES;
      if (resume && !placed) {
        // Gave out again before its first frame: the segment carries on from
        // the same place on the next try.
        this.onDecoded(plan, resume.at, resume.rate, bytes, code ?? 1, detail, outage, confirmed);
        return;
      }
      if (!placed) {
        // A failed read before the first frame (the open itself timed out) is
        // the drive's, not the file's: opened again for a while before the
        // segment fails.
        const failure = logReadFailure(detail, plan.source.path);
        const storageFailed = stalled || failure === 'storage' || (opening?.storage === true && code !== 0);
        const settle = (storage: boolean): void => {
          // Measured from now, not from when a stalled decoder went quiet: the
          // stall already used its own budget, and the open gets its tries after.
          const since = opening?.since ?? now;
          // A drive that was given up on a moment ago for another track is
          // not waited on again for this one.
          const gone = storage && storageKnownGone(plan.source.path);
          if (gone) rememberStorageGone(plan.source.path);
          if (storage && !gone && !abandoned && this.phase !== 'closed' && performance.now() - since < DECODE_OPEN_RETRY_MS) {
            this.retryOpen(plan, { attempt: (opening?.attempt ?? 0) + 1, since, storage: true });
            return;
          }
          console.error(`[newamp] gapless decode produced no audio (ffmpeg ${code}) for ${plan.source.path}\n${detail}`);
          this.failSegment(
            plan,
            storage ? 'The drive stopped answering.' : code === 0 ? 'The file has no decodable audio.' : 'Decode failed.',
          );
        };
        if (storageFailed || abandoned || this.phase === 'closed' || (code === 0 && failure == null)) {
          settle(storageFailed);
          return;
        }
        // ffmpeg could not open the file, and what it says does not settle
        // whose doing that is. It calls a drive letter or a share that has
        // gone a missing file, and it answers "I/O error" both for a read the
        // system failed and for a file that is not audio at all. The file
        // system is asked which this is; a file that really is gone, or really
        // is damaged, still fails at once.
        this.pendingOpen = plan;
        const asked = (this.asking = {});
        void probeFileRead(plan.source.path).then((probe) => {
          if (this.asking !== asked) return;
          this.asking = null;
          this.pendingOpen = null;
          settle(probe === 'storage');
        });
        return;
      }
      this.onDecoded(plan, placed.at, placed.rate, bytes, code, detail, outage, confirmed);
    };
    const done = (code: number | null, detail: string): void => {
      if (settled || this.decoder !== child) return;
      // The header arrived but the segment isn't placed yet: finish then.
      if (held) {
        exited = { code, detail };
        return;
      }
      complete(code, detail);
    };
    child.on('error', (err) => done(null, err.message));
    child.on('close', (code) => done(code, stderr));
  }

  /** Open `plan`'s file again after a failed read before its first frame. */
  private retryOpen(plan: Plan, outage: Outage): void {
    console.warn(
      `[newamp] gapless decode of ${plan.source.path} failed before any audio; opening it again (try ${outage.attempt})`,
    );
    // The stream is about to run dry for a chained track; the first has no stream yet.
    if (plan !== this.firstPlan) this.setWaiting(true);
    this.pendingOpen = plan;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.pendingOpen = null;
      if (this.phase === 'closed') return;
      if (stuckDecoders.size >= STUCK_DECODER_LIMIT) {
        // Not another decoder beside the ones that won't stop: later, if there is time left.
        if (performance.now() - outage.since < DECODE_OPEN_RETRY_MS) this.retryOpen(plan, { ...outage, attempt: outage.attempt + 1 });
        else this.failSegment(plan, 'The drive stopped answering.');
        return;
      }
      this.phase = 'opening';
      this.spawnDecoder(plan, null, outage);
    }, Math.min(DECODE_RESUME_DELAY_MS * outage.attempt, DECODE_RESUME_MAX_DELAY_MS));
  }

  /** `plan` never produced a header: fail it where it would have started. */
  private failSegment(plan: Plan, message: string): void {
    this.setWaiting(false);
    if (plan === this.firstPlan) {
      this.failFirst(new Error(message));
      return;
    }
    // In-band, at the frame the track would have started: the renderer
    // hears about it exactly when playback gets there.
    const at = this.writeHead();
    this.phase = 'decoding';
    this.markSegment(plan, at, null);
    this.out.mark(at, { t: 'fail', gen: this.gen, token: plan.token, message });
    this.next = null;
    this.deferredNext = null;
    this.finish();
  }

  private feed(chunk: Buffer, decoder: ChildProcessByStdio<null, Readable, Readable>): void {
    const resampler = this.resampler;
    if (!resampler) {
      this.emit(chunk, decoder.stdout);
      return;
    }
    resampler.inBytes += chunk.length;
    if (!resampler.child.stdin.write(chunk)) {
      decoder.stdout.pause();
      resampler.child.stdin.once('drain', () => {
        if (this.decoder === decoder) decoder.stdout.resume();
      });
    }
  }

  /**
   * `plan`'s decoder has stopped. `outage` is the run of failed reads this
   * stop belongs to if it is one; null when the file must not be read again.
   * `confirmed`: the decoder had been started to find out whether a clean
   * early exit was the end of the track (see confirmEnd), and found no more.
   */
  private onDecoded(
    plan: Plan,
    at: number,
    rate: number,
    bytes: number,
    code: number | null,
    detail: string,
    outage: Outage | null = null,
    confirmed = false,
  ): void {
    const frames = Math.floor(bytes / FRAME_BYTES);
    const failure = logReadFailure(detail, plan.source.path);
    const logged = failure != null;
    const stoppedSec = plan.startAt + frames / rate;
    // A clean exit is the end of the file only if the decoder was told so by
    // the file. Not every failed read is reported as one, and then the exit is
    // as clean as at the real end: when it comes well short of the length the
    // track is known to have, it is checked before it is believed.
    const short =
      code === 0 && !logged && plan.durationSec != null && stoppedSec < plan.durationSec - DECODE_END_SLACK_SEC;
    if (short && !confirmed && outage && this.phase !== 'closed') {
      this.confirmEnd(plan, at, rate, bytes, detail, outage);
      return;
    }
    // Once an outage has been the drive's, a later stop in it that the log
    // doesn't explain is still waited out the same way.
    const storageFailed = failure === 'storage' || outage?.storage === true;
    if (failure === 'unclear' && !storageFailed && outage && this.phase !== 'closed') {
      // A read failed, for a reason that a drive which stopped delivering gives
      // and that a file with damaged data gets too. The file system says
      // which, and with it how long this is worth waiting on.
      this.phase = 'decoding';
      this.pendingResume = { plan, at, rate, bytes };
      const asked = (this.asking = {});
      void isStorageReadFailure(failure, plan.source.path).then((storage) => {
        if (this.asking !== asked) return;
        this.asking = null;
        this.pendingResume = null;
        this.afterStop(plan, at, rate, bytes, code, detail, outage, storage);
      });
      return;
    }
    this.afterStop(plan, at, rate, bytes, code, detail, outage, storageFailed);
  }

  /**
   * What follows a decoder's stop once it is known whether the storage is
   * what stopped it: the file is read again from there, the track fails where
   * its audio stops, or it has ended.
   */
  private afterStop(
    plan: Plan,
    at: number,
    rate: number,
    bytes: number,
    code: number | null,
    detail: string,
    outage: Outage | null,
    storageFailed: boolean,
  ): void {
    const frames = Math.floor(bytes / FRAME_BYTES);
    const logged = logReadFailure(detail, plan.source.path) != null;
    const stoppedSec = plan.startAt + frames / rate;
    const readFailed = code !== 0 || logged;
    // With no audio at all this only retries a failure that is the drive's:
    // a damaged file that never decodes is not worth waiting on.
    if ((frames > 0 || storageFailed) && readFailed && outage && this.phase !== 'closed') {
      // A drive that stopped answering gets the long wait; a decoder that
      // failed for any other reason (a damaged file) only a short one.
      const limitMs = storageFailed ? DECODE_OUTAGE_MS : DECODE_ERROR_MS;
      const stoppedAt = stoppedSec.toFixed(2);
      // Unless that drive was given up on a moment ago for another track and
      // nothing has been read from it since: this one is not waited on in turn.
      const gone = storageFailed && storageKnownGone(plan.source.path);
      if (!gone && performance.now() - outage.since < limitMs) {
        console.warn(
          `[newamp] gapless decode stopped at ${stoppedAt} s (ffmpeg ${code}) for ${plan.source.path}; reading again from there (try ${outage.attempt + 1})\n${detail}`,
        );
        // Still filling this segment: the end guard waits, and playback stays
        // marked as short of audio while it runs low.
        this.phase = 'decoding';
        this.setWaiting(true);
        this.pendingResume = { plan, at, rate, bytes };
        const next: DecodeResume = { at, rate, bytes, attempt: outage.attempt + 1, since: outage.since, storage: storageFailed };
        this.resumeTimer = setTimeout(() => {
          this.resumeTimer = null;
          this.pendingResume = null;
          if (this.phase === 'closed') return;
          if (stuckDecoders.size >= STUCK_DECODER_LIMIT) {
            // Not another decoder beside the ones that won't stop. It counts
            // as one more read that got nowhere: later, or not at all once
            // the outage has lasted too long.
            this.onDecoded(plan, at, rate, bytes, null, 'earlier decoders have not exited', next);
            return;
          }
          this.spawnDecoder(plan, next);
        }, Math.min(DECODE_RESUME_DELAY_MS * next.attempt, DECODE_RESUME_MAX_DELAY_MS));
        return;
      }
      // A damaged file that stops where it nearly ended anyway did play out:
      // it ends there, as it always has, and what follows goes on.
      const nearEnd = plan.durationSec != null && stoppedSec >= plan.durationSec - DECODE_END_SLACK_SEC;
      if (storageFailed || !nearEnd) {
        // The drive has been gone too long. Not the end of the track: fail it
        // in-band where its audio stops, so the renderer takes it from there
        // (the decks try the file again) instead of moving on as if it played out.
        console.warn(
          `[newamp] gapless decode gave up on ${plan.source.path} after ${Math.round((performance.now() - outage.since) / 1000)} s of failed reads at ${stoppedAt} s\n${detail}`,
        );
        if (storageFailed) rememberStorageGone(plan.source.path);
        this.failPartway(
          plan,
          storageFailed ? 'The drive stopped answering partway through the track.' : 'Decode failed partway through the track.',
          storageFailed ? 'The drive stopped answering.' : 'Decode failed.',
        );
        return;
      }
    }
    this.setWaiting(false);
    // A clean exit with nothing after a seek is a seek to (or past) the end:
    // the track has played out, it didn't fail. One that logged a failed read
    // is a seek the drive didn't answer, and one to well before the end was
    // checked before it got here.
    const playedOut = frames === 0 && code === 0 && plan.startAt > 0 && !logged;
    if (frames === 0 && !playedOut) {
      const message = storageFailed
        ? 'The drive stopped answering.'
        : code === 0 && !logged ? 'The file has no decodable audio.' : 'Decode failed.';
      console.error(`[newamp] gapless decode produced no audio (ffmpeg ${code}) for ${plan.source.path}\n${detail}`);
      if (plan === this.firstPlan) {
        this.failFirst(new Error(message));
        return;
      }
      // In-band, at the frame the track would have started: the renderer
      // hears about it exactly when playback gets there.
      this.out.mark(at, { t: 'fail', gen: this.gen, token: plan.token, message });
      this.next = null;
      this.finish();
      return;
    }
    if (playedOut && plan === this.firstPlan) this.firstPlayedOut = true;
    if (readFailed) {
      // Not the file's length: the track keeps the one it has.
      console.warn(`[newamp] gapless decode ended early (ffmpeg ${code}) for ${plan.source.path}; keeping ${frames} frames\n${detail}`);
    } else if (frames > 0) {
      // What the file really holds, which a stale library row or a header
      // estimate (VBR MP3 without a Xing frame) can miss by seconds.
      this.setDuration(plan, stoppedSec);
    }
    const next = this.next;
    this.next = null;
    if (next) {
      this.startSegment(next);
      return;
    }
    this.phase = 'waiting';
    this.checkEndGuard();
  }

  /**
   * `plan`'s decoder exited cleanly at `bytes`, well short of the length the
   * track is known to have. That is the end of a file shorter than the library
   * thinks, or a read that failed without ffmpeg saying so. The file system
   * is asked first: a file whose last bytes can't be read was not read to its
   * end. If they can, one more decoder is started from the same frame; only
   * when that one also exits cleanly with no more audio is this the end (it
   * comes back through onDecoded as `confirmed`). If it has more, the stream
   * simply carries on.
   */
  private confirmEnd(plan: Plan, at: number, rate: number, bytes: number, detail: string, outage: Outage): void {
    // Still filling this segment: the end guard waits meanwhile.
    this.phase = 'decoding';
    this.pendingResume = { plan, at, rate, bytes };
    const asked = (this.asking = {});
    void probeFileRead(plan.source.path).then((probe) => {
      if (this.asking !== asked) return;
      this.asking = null;
      this.pendingResume = null;
      // Each look that finds a little more audio and another clean exit is
      // part of the same outage, and that has its limit like any other.
      if (probe === 'readable' && performance.now() - outage.since < DECODE_ERROR_MS) {
        this.spawnDecoder(plan, { at, rate, bytes, attempt: outage.attempt + 1, since: outage.since, storage: outage.storage, confirming: true });
        return;
      }
      // Not the end, then, but a failed read like any other: waited out if
      // the storage is what did not deliver.
      this.onDecoded(plan, at, rate, bytes, null, detail || 'stopped short of the end of the file', {
        ...outage,
        storage: outage.storage || probe === 'storage',
      });
    });
  }

  /**
   * `plan` can't be decoded any further and has not reached its end: it fails
   * in-band where its audio stops, so the renderer takes it from there (the
   * decks try the file again) instead of moving on as if it had played out.
   * `unheard` is the error when nothing of it has reached the stream.
   */
  private failPartway(plan: Plan, message: string, unheard: string): void {
    this.setWaiting(false);
    if (plan === this.firstPlan && this.first && this.out.accepted === 0) {
      // Nothing of it was ever heard, so start() itself fails and the decks
      // take the track; a stream that only fails and ends is not something
      // the renderer has anything to play for.
      this.failFirst(new Error(unheard));
      return;
    }
    this.out.mark(this.writeHead(), { t: 'fail', gen: this.gen, token: plan.token, message });
    this.next = null;
    this.deferredNext = null;
    this.finish();
  }

  private emit(chunk: Buffer, source: Readable): void {
    this.out.push(chunk);
    if (this.first && this.out.sent > 0) {
      this.first.resolve();
      this.first = null;
    }
    // Whichever pipe is feeding now gets paused. Checking only whether
    // anything is stalled let a pipe that stalled just before it finished
    // (the last chunk of a chained track) disable flow control for good.
    if (this.stalled !== source && this.inflight() >= this.highWater) {
      source.pause();
      this.stalled = source;
    }
    this.reportPressure();
  }

  private spawnResampler(rate: number, kind: ResamplerKind): Resampler {
    const child = spawn(
      this.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        // The input format is given in full, so don't probe it. Probing held
        // back all output until ~1.25 s of input had arrived (6.1, Windows)
        // or ~4.75 s (7.0, Linux), audio that flow control and the end guard
        // can't see: a short resampled chain ended before a prepare that
        // came after it could splice in.
        '-probesize',
        '32',
        '-analyzeduration',
        '0',
        '-f',
        'f32le',
        '-ar',
        String(rate),
        '-ac',
        String(CHANNELS),
        '-i',
        'pipe:0',
        '-af',
        resamplerFilter(kind),
        '-ar',
        String(this.rate),
        '-c:a',
        'pcm_f32le',
        '-f',
        'f32le',
        '-flush_packets',
        '1',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    const resampler: Resampler = { child, rate, base: this.out.accepted, inBytes: 0, onClose: null };
    let stderr = '';
    let settled = false;
    // A resampler killed mid-write must not take down main with EPIPE.
    child.stdin.on('error', () => undefined);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.resampler !== resampler) return;
      this.emit(chunk, child.stdout);
    });
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      this.release(child.stdout);
      if (this.resampler !== resampler) return;
      if (code !== 0) console.error(`[newamp] gapless resampler exited ${code}\n${stderr}`);
      if (resampler.onClose) {
        resampler.onClose(code);
        return;
      }
      // Died on its own while a segment was feeding it.
      this.resampler = null;
      this.killDecoder();
      if (this.first) {
        this.failFirst(new Error('Resampling failed.'));
        return;
      }
      const current = this.started[this.started.length - 1];
      if (current) this.out.mark(this.out.accepted, { t: 'fail', gen: this.gen, token: current.plan.token, message: 'Resampling failed.' });
      this.next = null;
      this.finish();
    };
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
    return resampler;
  }

  /** Close the resampler's input so it flushes its tail, then continue. */
  private drainResampler(then: () => void): void {
    const resampler = this.resampler!;
    resampler.onClose = () => {
      if (this.resampler === resampler) this.resampler = null;
      if (this.phase !== 'closed') then();
    };
    resampler.child.stdin.end();
  }

  private cutAfter(index: number, then: Plan | null): void {
    const cut = this.started[index + 1]!;
    this.started.length = index + 1;
    this.next = null;
    this.killDecoder();
    this.out.truncate(cut.at);
    // In-band: anything of the revoked segment that already crossed the port
    // sits in the worklet's queue ahead of this message.
    this.post({ t: 'cut', gen: this.gen, token: cut.plan.token });
    const resume = (): void => {
      this.out.release();
      this.phase = 'waiting';
      if (then) {
        // startSegment applies anything deferred once `then` is placed.
        this.startSegment(then);
        return;
      }
      // A re-point that landed while the resampler drained is newer than
      // this cut; it applies now.
      const deferred = this.deferredNext;
      this.deferredNext = null;
      if (deferred) this.prepareNext(deferred.after, deferred.plan);
      this.checkEndGuard();
    };
    if (this.resampler) {
      // Its filter still holds the tail of the segment before the cut.
      this.phase = 'switching';
      this.drainResampler(resume);
    } else {
      resume();
    }
  }

  private checkEndGuard(): void {
    if (this.phase === 'waiting' && this.inflight() <= this.endGuard) this.finish();
  }

  private finish(): void {
    if (this.phase === 'finishing' || this.phase === 'done' || this.phase === 'closed') return;
    this.phase = 'finishing';
    const done = (): void => {
      if (this.phase !== 'finishing') return;
      this.out.flush();
      this.post({ t: 'end', gen: this.gen });
      this.phase = 'done';
      if (this.first) {
        if (this.out.sent > 0 || this.firstPlayedOut) {
          this.first.resolve();
          this.first = null;
        } else {
          this.failFirst(new Error('The file has no decodable audio.'));
        }
      }
    };
    if (this.resampler) this.drainResampler(done);
    else done();
  }

  private cancelResume(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.pendingResume = null;
    this.pendingOpen = null;
    this.asking = null;
    // Whatever was being waited on is not any more: a replacement decoder
    // that isn't a resume would otherwise leave the renderer waiting for the
    // whole of its track.
    this.setWaiting(false);
  }

  private killDecoder(): void {
    this.cancelResume();
    const decoder = this.decoder;
    if (!decoder) return;
    this.decoder = null;
    this.release(decoder.stdout);
    killChild(decoder);
  }
}

class GaplessProducer {
  private port: MessagePortMain | null = null;
  private owner: WebContents | null = null;
  private readonly watched = new WeakSet<WebContents>();
  private gen = 0;
  // Bumped per open(): a request still in flight from before a renderer
  // reload must not bind to the new port (both count generations from 1).
  // The renderer matches the port it receives to the epoch open() returned.
  private epoch = 0;
  private session: Session | null = null;
  private pendingNext: { gen: number; after: number; plan: Plan | null } | null = null;
  private prepareSeq = 0;

  constructor(
    private readonly resolveSource: GaplessSourceResolver,
    private readonly allowSender: (sender: WebContents) => boolean,
  ) {}

  /** Hand the renderer a fresh PCM port; the engine moves it into its worklet. Returns its id, 0 when refused. */
  open(sender: WebContents): number {
    // One window owns the shared output; a second renderer opening here
    // would silently take the stream away from it.
    if (!this.allowSender(sender)) return 0;
    this.closeSession();
    this.port?.close();
    const { port1, port2 } = new MessageChannelMain();
    this.port = port1;
    this.owner = sender;
    const epoch = ++this.epoch;
    this.gen = 0;
    if (!this.watched.has(sender)) {
      this.watched.add(sender);
      sender.once('destroyed', () => {
        if (this.owner === sender) this.dispose();
      });
      // A crashed renderer's worklet is gone; its reload opens a new port.
      sender.on('render-process-gone', () => {
        if (this.owner === sender) this.dispose();
      });
    }
    port1.on('message', (event) => this.onPortMessage(event.data));
    // The worklet end went away (renderer reload, node torn down): nothing
    // is listening, so stop decoding for it.
    port1.on('close', () => {
      if (this.port === port1) this.dispose();
    });
    port1.start();
    sender.postMessage('gapless:port', { id: epoch }, [port2]);
    return epoch;
  }

  async start(sender: WebContents, request: GaplessStartRequest): Promise<GaplessStartResult> {
    if (sender !== this.owner || !this.port) return { ok: false, error: 'Gapless transport is not connected.' };
    if (request.gen <= this.gen) return { ok: false, error: 'Superseded by a newer request.' };
    this.gen = request.gen;
    const epoch = this.epoch;
    this.closeSession();
    const ffmpeg = resolveFfmpegPath();
    // Nothing here depends on the track: the probe runs while it is planned,
    // and the session waits for its answer only if a track turns out to need
    // a resampler. A slow first run of the binary holds up nothing else.
    const probing = probeResampler(ffmpeg);
    let first: Plan;
    try {
      // The lookup reads the file's metadata from the same drive as the audio,
      // and a drive that has stopped answering holds it as long as it holds a
      // decoder: past the limit the start fails, and the decks take the track.
      first = await orFailAfter(this.plan(request), FIRST_AUDIO_TIMEOUT_MS, 'Timed out reading the track.');
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (epoch !== this.epoch || request.gen !== this.gen || !this.port) {
      return { ok: false, error: 'Superseded by a newer request.' };
    }
    const session = new Session(request.gen, this.port, request.sampleRate, ffmpeg, probing, first, null);
    this.session = session;
    // The first segment has to exist before a prepare that arrived while
    // this start was planning can name it.
    const begun = session.begin();
    const pending = this.pendingNext;
    this.pendingNext = null;
    if (request.next) {
      // Planned while the first track decodes, not before: its metadata is
      // read from the same drive, and a slow answer must not hold up the
      // track the listener is waiting on. A prepare that lands first is newer.
      const seq = this.prepareSeq;
      void this.plan(request.next).then(
        (plan) => {
          if (this.session === session && seq === this.prepareSeq) session.prepareNext(request.token, plan);
        },
        () => undefined,
      );
    }
    if (pending && pending.gen === request.gen) session.prepareNext(pending.after, pending.plan);
    try {
      await begun;
    } catch (err) {
      if (this.session === session) this.session = null;
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (this.session !== session) return { ok: false, error: 'Superseded by a newer request.' };
    const rate = session.firstRate;
    // Known by now if the first track needed it; otherwise only if the probe has answered.
    const kind = session.resamplerKind;
    return {
      ok: true,
      durationSec: first.durationSec,
      sourceSampleRate: rate,
      resampler: rate == null || rate === request.sampleRate ? 'none' : (kind ?? 'none'),
      ...(kind ? { resamplerKind: kind } : {}),
    };
  }

  async prepareNext(sender: WebContents, gen: number, after: number, segment: GaplessSegmentRequest | null): Promise<void> {
    if (sender !== this.owner) return;
    const seq = ++this.prepareSeq;
    const epoch = this.epoch;
    const plan = segment ? await this.plan(segment).catch(() => null) : null;
    if (seq !== this.prepareSeq || epoch !== this.epoch || gen !== this.gen) return;
    if (this.session?.gen === gen) this.session.prepareNext(after, plan);
    else this.pendingNext = { gen, after, plan };
  }

  stop(sender: WebContents, gen: number): void {
    if (sender !== this.owner) return;
    this.gen = Math.max(this.gen, gen);
    this.closeSession();
  }

  dispose(): void {
    this.closeSession();
    this.port?.close();
    this.port = null;
    this.owner = null;
  }

  releasePaths(held: (path: string) => boolean): Promise<void> {
    if (this.pendingNext?.plan && held(this.pendingNext.plan.source.path)) {
      this.pendingNext = { ...this.pendingNext, plan: null };
    }
    return this.session?.releasePaths(held) ?? Promise.resolve();
  }

  private closeSession(): void {
    this.pendingNext = null;
    this.session?.close();
    this.session = null;
  }

  private onPortMessage(data: unknown): void {
    const msg = data as { t?: unknown; gen?: unknown; consumed?: unknown } | null;
    if (!msg || msg.t !== 'credit' || typeof msg.consumed !== 'number') return;
    if (this.session && this.session.gen === msg.gen) this.session.credit(msg.consumed);
  }

  private async plan(segment: GaplessSegmentRequest): Promise<Plan> {
    // The library lookup is the access gate: only real DB rows resolve, the
    // same trust level as 'library:get-track' and exclusive playback.
    const source = await this.resolveSource(segment.trackId);
    if (!source) throw new Error('Track is not in the library.');
    if (source.dsd) throw new Error('DSD sources play through the transcode path.');
    return {
      token: segment.token,
      source,
      startAt: segment.startAt,
      gain: segment.gain,
      // A slow read of the container is not worth holding the track for: it
      // plays untrimmed, and the read finishes into playableLength's cache
      // for the next plan.
      playable: await orNullAfter(playableLength(source.path), PLAYABLE_LENGTH_TIMEOUT_MS),
      durationSec: source.durationSec,
    };
  }
}

/** `promise`'s value, or null if it hasn't settled in `ms`; it carries on regardless. */
function orNullAfter<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    const settle = (value: T | null): void => {
      clearTimeout(timer);
      resolve(value);
    };
    promise.then(settle, () => settle(null));
  });
}

/** `promise`'s outcome, or a rejection with `message` if it hasn't settled in `ms`; it carries on regardless. */
function orFailAfter<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseSegment(value: unknown): GaplessSegmentRequest | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const token = positiveInt(raw.token);
  const trackId = positiveInt(raw.trackId);
  const startAt = typeof raw.startAt === 'number' && Number.isFinite(raw.startAt) ? Math.max(0, raw.startAt) : null;
  const gain = typeof raw.gain === 'number' && Number.isFinite(raw.gain) && raw.gain >= 0 && raw.gain <= 16 ? raw.gain : null;
  if (token == null || trackId == null || startAt == null || gain == null) return null;
  return { token, trackId, startAt, gain };
}

function parseStart(value: unknown): GaplessStartRequest | null {
  const segment = parseSegment(value);
  if (!segment) return null;
  const raw = value as Record<string, unknown>;
  const gen = positiveInt(raw.gen);
  const sampleRate = positiveInt(raw.sampleRate);
  if (gen == null || sampleRate == null || sampleRate < 8000 || sampleRate > 768000) return null;
  const next = raw.next == null ? null : parseSegment(raw.next);
  if (raw.next != null && !next) return null;
  return { ...segment, gen, sampleRate, next };
}

const producers = new Set<GaplessProducer>();

/** `allowSender` names the one renderer that may own the transport (the main window). */
export function registerGaplessTransport(
  ipc: IpcMain,
  resolveSource: GaplessSourceResolver,
  allowSender: (sender: WebContents) => boolean = () => true,
): void {
  const producer = new GaplessProducer(resolveSource, allowSender);
  ipc.handle('gapless:open', (event) => producer.open(event.sender));
  ipc.handle('gapless:start', (event, request: unknown) => {
    const parsed = parseStart(request);
    if (!parsed) return { ok: false, error: 'Invalid gapless start request.' } satisfies GaplessStartResult;
    return producer.start(event.sender, parsed);
  });
  ipc.handle('gapless:prepare-next', async (event, gen: unknown, after: unknown, next: unknown) => {
    const parsedGen = positiveInt(gen);
    const parsedAfter = positiveInt(after);
    const parsedNext = next == null ? null : parseSegment(next);
    if (parsedGen == null || parsedAfter == null || (next != null && !parsedNext)) return;
    await producer.prepareNext(event.sender, parsedGen, parsedAfter, parsedNext);
  });
  ipc.handle('gapless:stop', (event, gen: unknown) => {
    const parsed = positiveInt(gen);
    if (parsed != null) producer.stop(event.sender, parsed);
  });
  producers.add(producer);
}

/** Kill every gapless decoder and resampler. On Windows a child ffmpeg outlives main unless killed. */
export function closeAllGaplessSessions(): void {
  for (const producer of producers) producer.dispose();
}

/**
 * Stop every gapless decoder reading one of these files and forget plans on
 * them, so the files can be moved; the stream itself keeps going.
 */
export async function releaseGaplessPaths(paths: string[]): Promise<void> {
  const keys = new Set(paths.map(ffmpegInputKey));
  const held = (path: string): boolean => keys.has(ffmpegInputKey(path));
  await Promise.all([...producers].map((producer) => producer.releasePaths(held)));
}
