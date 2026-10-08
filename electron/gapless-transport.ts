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
import { probeResampler, resamplerFilter } from './resampler.js';
import { resolveFfmpegPath } from './transcode.js';
import type {
  ExclusiveTrackSource,
  GaplessSegmentRequest,
  GaplessStartRequest,
  GaplessStartResult,
  ResamplerKind,
} from '../shared/types.js';

const CHANNELS = 2;
const FRAME_BYTES = CHANNELS * 4;
const HIGH_WATER_SEC = 3;
const LOW_WATER_SEC = 2;
// With nothing chained, the end-of-stream marker is held until the worklet is
// this close to running dry, so a prepareNext that lands late (a seek into the
// last seconds, a slow queue refill) still splices instead of gapping.
const END_GUARD_SEC = 0.5;
// ffmpeg's pipe reads are coalesced into messages of at least this many frames.
const MIN_POST_FRAMES = 4096;
const FIRST_AUDIO_TIMEOUT_MS = 15000;
// Only the last few segment starts can still be revoked: the producer runs at
// most HIGH_WATER_SEC ahead of the audible playhead.
const STARTED_LOG_CAP = 8;
// RIFF + fmt + data headers from ffmpeg's WAV muxer run ~100 bytes.
const MAX_WAV_HEADER_BYTES = 64 * 1024;
// ffmpeg's input dump, with -loglevel level+info.
const DURATION_LINE = /^\[info\]\s+Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;
const ERROR_LINE = /\[(?:error|fatal|panic)\] /;
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
  | { t: 'end'; gen: number };

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
  // The first segment was a seek to its end: it played out with no frames.
  private firstPlayedOut = false;
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly endGuard: number;

  constructor(
    readonly gen: number,
    private readonly port: MessagePortMain,
    private readonly rate: number,
    private readonly ffmpeg: string,
    private readonly resamplerKind: ResamplerKind,
    private readonly firstPlan: Plan,
    next: Plan | null,
  ) {
    this.out = new FrameOutput(gen, (msg) => this.post(msg));
    this.next = next;
    this.highWater = Math.round(rate * HIGH_WATER_SEC);
    this.lowWater = Math.round(rate * LOW_WATER_SEC);
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
  }

  close(): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.killDecoder();
    if (this.resampler) {
      this.resampler.onClose = null;
      killChild(this.resampler.child);
      this.resampler = null;
    }
    this.stalled = null;
    this.failFirst(new Error('Superseded by a newer request.'));
  }

  // ---------------------------------------------------------------- internals

  // Counts frames still being coalesced into a post too, so a source switch
  // can't slip a pipe read past the high-water check while they wait.
  private inflight(): number {
    return this.out.accepted - this.consumed;
  }

  private post(msg: StreamMessage): void {
    if (this.phase === 'closed') return;
    try {
      this.port.postMessage(msg);
    } catch {
      /* renderer went away; the next open() or close() cleans up */
    }
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
    if (this.resampler && this.resampler.rate !== resampleFrom) {
      // A rate change cannot share a filter with what came before: drain the
      // old resampler, then begin this segment on a fresh stage.
      this.phase = 'switching';
      this.drainResampler(() => this.placeSegment(plan, rate, go));
      return;
    }
    if (!this.resampler) {
      this.out.alignFrames();
      if (resampleFrom != null) this.resampler = this.spawnResampler(resampleFrom);
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
      resampler: rate == null || rate === this.rate ? 'none' : this.resamplerKind,
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

  private spawnDecoder(plan: Plan): void {
    const args = [
      '-hide_banner',
      '-nostdin',
      // Info level for the input's Duration line; only error lines are kept.
      '-loglevel',
      'level+info',
      '-nostats',
      ...(plan.startAt > 0 ? ['-ss', plan.startAt.toFixed(6)] : []),
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
    let bytes = 0;
    let stderr = '';
    let line = '';
    let settled = false;
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
      if (pcm.length) this.feed(pcm, child);
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
        killChild(child);
        this.failSegment(plan, 'Unreadable decoder output.');
        return;
      }
      held = [header.subarray(parsed.dataOffset)];
      header = null;
      // Hold the pipe while the segment is placed.
      child.stdout.pause();
      this.placeSegment(plan, parsed.rate, (at) => {
        // The container's end point is in decoder frames.
        const remaining = plan.playable && plan.playable.rate === parsed.rate
          ? plan.playable.frames - Math.round(plan.startAt * parsed.rate)
          : null;
        placed = { at, rate: parsed.rate, limitBytes: remaining != null && remaining > 0 ? remaining * FRAME_BYTES : null };
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
    const complete = (code: number | null, detail: string): void => {
      settled = true;
      this.decoder = null;
      this.release(child.stdout);
      if (!placed) {
        console.error(`[newamp] gapless decode produced no audio (ffmpeg ${code}) for ${plan.source.path}\n${detail}`);
        this.failSegment(plan, code === 0 ? 'The file has no decodable audio.' : 'Decode failed.');
        return;
      }
      this.onDecoded(plan, placed.at, placed.rate, bytes, code, detail);
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

  /** `plan` never produced a header: fail it where it would have started. */
  private failSegment(plan: Plan, message: string): void {
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

  private onDecoded(plan: Plan, at: number, rate: number, bytes: number, code: number | null, detail: string): void {
    const frames = Math.floor(bytes / FRAME_BYTES);
    // A clean exit with nothing after a seek is a seek to (or past) the end:
    // the track has played out, it didn't fail.
    const playedOut = frames === 0 && code === 0 && plan.startAt > 0;
    if (frames === 0 && !playedOut) {
      const message = code === 0 ? 'The file has no decodable audio.' : 'Decode failed.';
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
    if (code !== 0) {
      console.warn(`[newamp] gapless decode ended early (ffmpeg ${code}) for ${plan.source.path}; keeping ${frames} frames\n${detail}`);
    } else if (frames > 0) {
      // What the file really holds, which a stale library row or a header
      // estimate (VBR MP3 without a Xing frame) can miss by seconds.
      this.setDuration(plan, plan.startAt + frames / rate);
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
  }

  private spawnResampler(rate: number): Resampler {
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
        resamplerFilter(this.resamplerKind),
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

  private killDecoder(): void {
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
    let first: Plan;
    try {
      first = await this.plan(request);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const next = request.next ? await this.plan(request.next).catch(() => null) : null;
    const ffmpeg = resolveFfmpegPath();
    const kind = await probeResampler(ffmpeg);
    if (epoch !== this.epoch || request.gen !== this.gen || !this.port) {
      return { ok: false, error: 'Superseded by a newer request.' };
    }
    const session = new Session(request.gen, this.port, request.sampleRate, ffmpeg, kind, first, next);
    this.session = session;
    // The first segment has to exist before a prepare that arrived while
    // this start was planning can name it.
    const begun = session.begin();
    const pending = this.pendingNext;
    this.pendingNext = null;
    if (pending && pending.gen === request.gen) session.prepareNext(pending.after, pending.plan);
    try {
      await begun;
    } catch (err) {
      if (this.session === session) this.session = null;
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (this.session !== session) return { ok: false, error: 'Superseded by a newer request.' };
    const rate = session.firstRate;
    return {
      ok: true,
      durationSec: first.durationSec,
      sourceSampleRate: rate,
      resampler: rate == null || rate === request.sampleRate ? 'none' : kind,
      resamplerKind: kind,
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
      playable: await playableLength(source.path),
      durationSec: source.durationSec,
    };
  }
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
