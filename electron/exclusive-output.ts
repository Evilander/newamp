// Bit-Perfect Exclusive output driver (Windows, WASAPI exclusive).
//
// Owns the native addon (native/newamp-audio): resolves a track's source
// format, negotiates a device-NATIVE exclusive format from probeDevice()
// (never trusting miniaudio's hidden converter — if the source rate isn't
// natively supported we resample EXPLICITLY in ffmpeg with soxr and report it
// honestly), decodes with ffmpeg to raw PCM, and pushes it into the addon's
// lock-free ring with backpressure.
//
// Position model: the addon's framesRendered counter is monotonic for the
// lifetime of an open device and NEVER reset mid-session. A segment list maps
// rendered-frame ranges to (trackId, source-time offset), which makes seeks,
// chained gapless tracks, and pause/relinquish cycles simple arithmetic
// instead of counter-reset races.
//
// Gapless: prepareNext() pre-resolves the next track; when the current ffmpeg
// stream ends and the next track negotiates to the IDENTICAL device format,
// its PCM is spliced into the same ring at the exact frame boundary — true
// gapless over WASAPI exclusive. A later play() call for that track is ack'd
// as `chained` without touching the stream.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';
import { resolveFfmpegPath } from './transcode.js';
import type {
  ExclusiveDeviceInfo,
  ExclusiveEventPayload,
  ExclusiveNegotiated,
  ExclusiveTrackSource,
} from '../shared/types.js';

type PcmFormat = 's16' | 's24' | 's32' | 'f32';

interface NativeAddon {
  listDevices(): ExclusiveDeviceInfo[];
  probeDevice(id?: string): { name: string; formats: Array<{ format: string; channels: number; sampleRate: number }> };
  open(opts: {
    deviceId?: string;
    sampleRate: number;
    channels: number;
    format: PcmFormat;
    exclusive: boolean;
    ringMs?: number;
  }): {
    deviceName: string;
    exclusive: boolean;
    requestedFormat: string;
    requestedSampleRate: number;
    requestedChannels: number;
    internalFormat: string;
    internalSampleRate: number;
    internalChannels: number;
    periodSizeInFrames: number;
    capacityFrames: number;
  };
  start(): boolean;
  stopDevice(): boolean;
  write(buf: Buffer): number;
  clear(): boolean;
  setEos(value: boolean): boolean;
  stats(): {
    framesRendered: number;
    bufferedFrames: number;
    capacityFrames: number;
    underruns: number;
    drained: boolean;
    running: boolean;
  };
  close(): boolean;
}

interface Segment {
  trackId: number;
  startFrame: number;
  offsetSec: number;
  durationSec: number | null;
}

interface OpenFormat {
  deviceId: string | null;
  format: PcmFormat;
  sampleRate: number;
  channels: number;
  deviceName: string;
}

const BYTES_PER_SAMPLE: Record<PcmFormat, number> = { s16: 2, s24: 3, s32: 4, f32: 4 };
const FFMPEG_CODEC: Record<PcmFormat, string> = {
  s16: 'pcm_s16le',
  s24: 'pcm_s24le',
  s32: 'pcm_s32le',
  f32: 'pcm_f32le',
};
const TAP_WINDOW_FRAMES = 2048;
const TAP_INTERVAL_MS = 33;
const POSITION_INTERVAL_MS = 250;
const IDLE_RELEASE_MS = 15000;
const PUMP_INTERVAL_MS = 40;
const RING_MS = 2000;

// NOTE: .mka is deliberately absent — Matroska audio is a container that can
// hold lossy Opus/AAC/MP3; it only counts as lossless when music-metadata
// positively confirms the inner codec (the resolver overrides this default).
const LOSSLESS_EXTS = new Set(['.flac', '.alac', '.aiff', '.aif', '.ape', '.wv', '.tta', '.wav']);
const DSD_EXTS = new Set(['.dsf', '.dff']);

function loadAddon(): NativeAddon | null {
  // win32: WASAPI exclusive (verified). linux: ALSA direct — miniaudio opens
  // hw: devices for exclusive share mode, bypassing dmix/PulseAudio
  // (experimental). darwin: CoreAudio hog mode implemented in the addon
  // itself — device ownership + pinned nominal rate (experimental).
  if (!['win32', 'linux', 'darwin'].includes(process.platform)) return null;
  const platformArch = `${process.platform}-${process.arch}`;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dev: dist-electron/ → repo root; packaged: resources/app.asar/dist-electron
    join(here, '..', 'native', 'newamp-audio', 'prebuilt', platformArch, 'newamp_audio.node'),
    join(here, '..', '..', 'native', 'newamp-audio', 'prebuilt', platformArch, 'newamp_audio.node'),
  ].map((p) => (p.includes('app.asar') ? p.replace('app.asar', 'app.asar.unpacked') : p));
  const nativeRequire = createRequire(import.meta.url);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return nativeRequire(candidate) as NativeAddon;
    } catch (err) {
      console.error('[newamp] exclusive addon failed to load from', candidate, err);
      return null;
    }
  }
  return null;
}

export function classifyTrackSource(path: string): { lossless: boolean; dsd: boolean } {
  const ext = extname(path).toLowerCase();
  return { lossless: LOSSLESS_EXTS.has(ext) || DSD_EXTS.has(ext), dsd: DSD_EXTS.has(ext) };
}

/**
 * Pick a device-native exclusive format for a source. Honesty rules:
 * - the chosen (format, rate, channels) MUST come from the probe list, so the
 *   device runs it natively and nothing converts behind our back;
 * - any rate change is done explicitly in ffmpeg (soxr) and flagged;
 * - bitPerfect is the strict claim: lossless source, rate preserved, bit depth
 *   preserved, stereo-to-stereo, no DSD conversion.
 */
export function chooseExclusiveFormat(
  source: ExclusiveTrackSource,
  formats: Array<{ format: string; channels: number; sampleRate: number }>,
): Omit<ExclusiveNegotiated, 'deviceName'> | null {
  const usable = formats.filter(
    (f): f is { format: PcmFormat; channels: number; sampleRate: number } =>
      (f.format === 's16' || f.format === 's24' || f.format === 's32' || f.format === 'f32') && f.channels >= 1,
  );
  if (usable.length === 0) return null;

  const channels = 2;
  // DSD has no PCM rate; the app-wide policy converts it at 88.2k (soxr).
  const sourceRate = source.dsd ? 88200 : source.sampleRate && source.sampleRate > 0 ? source.sampleRate : null;

  const rates = [...new Set(usable.map((f) => f.sampleRate))];
  const wildcard = rates.includes(0);
  let targetRate: number;
  if (sourceRate && (wildcard || rates.includes(sourceRate))) {
    targetRate = sourceRate;
  } else if (sourceRate) {
    const above = rates.filter((r) => r > sourceRate).sort((a, b) => a - b)[0];
    const below = rates.filter((r) => r !== 0 && r <= sourceRate).sort((a, b) => b - a)[0];
    targetRate = above ?? below ?? 48000;
  } else {
    targetRate = rates.filter((r) => r !== 0).sort((a, b) => b - a)[0] ?? 48000;
  }

  const atRate = usable.filter((f) => f.sampleRate === 0 || f.sampleRate === targetRate);
  if (atRate.length === 0) return null;

  const depth = source.bitDepth && source.bitDepth > 0 ? source.bitDepth : source.lossless && !source.dsd ? 24 : null;
  // f32's 24-bit mantissa represents every <=24-bit int sample exactly, so it
  // preserves bit depth for everything except true 32-bit int sources.
  const ladder: PcmFormat[] =
    depth != null && depth <= 16
      ? ['s16', 's24', 's32', 'f32']
      : depth != null && depth <= 24
        ? ['s24', 's32', 'f32']
        : depth != null
          ? ['s32', 'f32', 's24', 's16']
          : ['f32', 's32', 's24', 's16'];
  const available = new Set(atRate.map((f) => f.format));
  const format = ladder.find((f) => available.has(f)) ?? atRate[0]!.format;

  // Unknown source rate means the decoder output is conservatively resampled
  // to the device rate (spawnDecoder always engages aresample in that case) —
  // report it as resampled, never as a preserved-rate path.
  const resampled = sourceRate != null ? targetRate !== sourceRate : true;
  const depthPreserved =
    depth == null
      ? format === 'f32' || format === 's32'
      : depth <= 16
        ? true
        : depth <= 24
          ? format !== 's16'
          : format === 's32';
  const channelsUnknown = source.channels == null;
  const upmixed = !channelsUnknown && source.channels !== channels;
  // Strict claim: unknown channel layout cannot be gold — ffmpeg forces -ac 2,
  // so a 5.1 file with a failed metadata probe WOULD be downmixed silently.
  const bitPerfect =
    source.lossless &&
    !source.dsd &&
    !resampled &&
    depthPreserved &&
    !upmixed &&
    !channelsUnknown &&
    sourceRate != null;

  return {
    format,
    sampleRate: targetRate,
    channels,
    sourceSampleRate: source.sampleRate ?? null,
    sourceBitDepth: source.bitDepth ?? null,
    bitPerfect,
    resampled: resampled || source.dsd,
    depthPreserved,
    upmixed,
    channelsUnknown,
    dsd: source.dsd,
    lossless: source.lossless,
  };
}

export class ExclusiveOutput {
  private readonly addon: NativeAddon | null;
  private generation = 0;
  private openFormat: OpenFormat | null = null;
  private segments: Segment[] = [];
  private current: { source: ExclusiveTrackSource; negotiated: ExclusiveNegotiated } | null = null;
  private prepared: ExclusiveTrackSource | null = null;
  private ffmpeg: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private pendingChunk: Buffer | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;
  private positionTimer: NodeJS.Timeout | null = null;
  private tapTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private playing = false;
  private started = false;
  private eosSent = false;
  private endedEmitted = false;
  private lastEmittedTrackId: number | null = null;
  private framesWrittenTotal = 0;
  private pausedAtSec: number | null = null;

  // Playhead-aligned visualizer delay line: decoded PCM is up to RING_MS ahead
  // of the DAC, so the tap reads at framesRendered, not at the write head.
  private tapRing: Float32Array = new Float32Array(0);
  private tapRingFrames = 0;

  constructor(
    private readonly deps: {
      send: (payload: ExclusiveEventPayload) => void;
      sendTap: (pcm: Float32Array, channels: number, sampleRate: number) => void;
    },
  ) {
    this.addon = loadAddon();
  }

  get available(): boolean {
    return this.addon != null;
  }

  listDevices(): ExclusiveDeviceInfo[] {
    if (!this.addon) return [];
    try {
      return this.addon.listDevices();
    } catch (err) {
      console.error('[newamp] exclusive listDevices failed', err);
      return [];
    }
  }

  probeDevice(deviceId: string | null): { name: string; formats: Array<{ format: string; channels: number; sampleRate: number }> } | null {
    if (!this.addon) return null;
    try {
      return this.addon.probeDevice(deviceId ?? undefined);
    } catch (err) {
      console.error('[newamp] exclusive probeDevice failed', err);
      return null;
    }
  }

  status(): { active: boolean; trackId: number | null; negotiated: ExclusiveNegotiated | null } {
    return {
      active: this.current != null,
      trackId: this.currentTrackIdAtPlayhead(),
      negotiated: this.current?.negotiated ?? null,
    };
  }

  /**
   * Start (or chain-ack) exclusive playback of a resolved track source.
   * Returns the negotiated format, or throws with an honest reason the
   * renderer can surface and fall back on.
   */
  async play(source: ExclusiveTrackSource, startAt: number, deviceId: string | null): Promise<{ negotiated: ExclusiveNegotiated; chained: boolean }> {
    if (!this.addon) throw new Error('Exclusive output addon is not available.');
    const gen = ++this.generation;

    // Chained continuation: the store advanced its queue after our boundary
    // event; the stream is already playing this track. Ack without touching it.
    if (
      this.current &&
      this.playing &&
      source.trackId === this.currentTrackIdAtPlayhead() &&
      this.segments.some((s) => s.trackId === source.trackId) &&
      startAt <= 0.5
    ) {
      return { negotiated: this.current.negotiated, chained: true };
    }

    const probe = this.probeDevice(deviceId);
    if (!probe) throw new Error('Exclusive device probe failed.');
    const chosen = chooseExclusiveFormat(source, probe.formats);
    if (!chosen) throw new Error(`No usable exclusive format on ${probe.name}.`);
    const negotiated: ExclusiveNegotiated = { ...chosen, deviceName: probe.name };

    this.killFfmpeg();
    this.stopTimers();
    this.pausedAtSec = null;

    const sameOpen =
      this.openFormat &&
      this.openFormat.deviceId === deviceId &&
      this.openFormat.format === negotiated.format &&
      this.openFormat.sampleRate === negotiated.sampleRate &&
      this.openFormat.channels === negotiated.channels;

    if (!sameOpen) {
      try {
        this.addon.close();
        const opened = this.addon.open({
          deviceId: deviceId ?? undefined,
          sampleRate: negotiated.sampleRate,
          channels: negotiated.channels,
          format: negotiated.format,
          exclusive: true,
          ringMs: RING_MS,
        });
        // Never ship a hidden conversion: if WASAPI/miniaudio negotiated
        // something else internally, the requested path is not what plays.
        if (
          opened.internalSampleRate !== negotiated.sampleRate ||
          opened.internalFormat !== negotiated.format ||
          opened.internalChannels !== negotiated.channels
        ) {
          this.addon.close();
          throw new Error(
            `Device negotiated ${opened.internalFormat}@${opened.internalSampleRate} instead of ${negotiated.format}@${negotiated.sampleRate} — refusing dishonest path.`,
          );
        }
        this.openFormat = {
          deviceId,
          format: negotiated.format,
          sampleRate: negotiated.sampleRate,
          channels: negotiated.channels,
          deviceName: opened.deviceName,
        };
        this.framesWrittenTotal = 0;
        this.allocateTapRing(negotiated.sampleRate, negotiated.channels);
      } catch (err) {
        this.openFormat = null;
        this.current = null;
        throw err instanceof Error ? err : new Error(String(err));
      }
    } else {
      this.addon.stopDevice();
      this.addon.clear();
      // Ring cleared: rendered counter stays where it is; writes restart at it.
      this.framesWrittenTotal = this.addon.stats().framesRendered;
    }

    this.addon.setEos(false);
    this.eosSent = false;
    this.endedEmitted = false;
    this.started = false;
    this.playing = true;
    this.current = { source, negotiated };
    this.lastEmittedTrackId = source.trackId;
    this.segments = [
      {
        trackId: source.trackId,
        startFrame: this.framesWrittenTotal,
        offsetSec: Math.max(0, startAt),
        durationSec: source.durationSec,
      },
    ];

    this.spawnDecoder(source, Math.max(0, startAt), gen);
    this.startTimers();
    this.emitState();
    return { negotiated, chained: false };
  }

  prepareNext(source: ExclusiveTrackSource | null): void {
    this.prepared = source;
  }

  pause(): void {
    if (!this.addon || !this.current || !this.playing) return;
    this.playing = false;
    this.pausedAtSec = this.positionSec();
    this.addon.stopDevice();
    this.stopPump(false);
    this.emitState();
    // Relinquish the exclusive device after a grace period so system audio
    // returns while NewAmp sits paused.
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.releaseDevice(), IDLE_RELEASE_MS);
  }

  async resume(deviceId: string | null): Promise<void> {
    if (!this.addon || !this.current) return;
    this.clearIdleTimer();
    if (this.openFormat) {
      this.playing = true;
      this.addon.start();
      this.resumePump();
      this.startTimers();
      this.emitState();
      return;
    }
    // Device was relinquished during the pause — reopen and reseek.
    const source = this.current.source;
    const at = this.pausedAtSec ?? 0;
    await this.play(source, at, deviceId);
  }

  seek(seconds: number): void {
    if (!this.addon || !this.current) return;
    const gen = ++this.generation;
    const source = this.current.source;
    const target = Math.max(0, Math.min(seconds, source.durationSec ?? seconds));
    this.killFfmpeg();
    this.addon.stopDevice();
    this.addon.clear();
    this.addon.setEos(false);
    this.eosSent = false;
    this.endedEmitted = false;
    this.started = false;
    this.framesWrittenTotal = this.addon.stats().framesRendered;
    this.segments = [
      {
        trackId: source.trackId,
        startFrame: this.framesWrittenTotal,
        offsetSec: target,
        durationSec: source.durationSec,
      },
    ];
    this.spawnDecoder(source, target, gen);
    if (this.playing) {
      this.startTimers();
    } else {
      this.pausedAtSec = target;
    }
    this.emitPosition();
  }

  stop(): void {
    this.generation++;
    this.killFfmpeg();
    this.stopTimers();
    this.clearIdleTimer();
    this.playing = false;
    this.current = null;
    this.prepared = null;
    this.segments = [];
    this.pausedAtSec = null;
    this.releaseDevice();
  }

  dispose(): void {
    this.stop();
  }

  // ---------------------------------------------------------------- internals

  private releaseDevice(): void {
    if (!this.addon) return;
    // A paused/ended decode is useless once the device is relinquished —
    // resume always respawns ffmpeg at the saved position. Without this the
    // idle-release path would keep a suspended ffmpeg child alive forever.
    this.killFfmpeg();
    try {
      this.addon.close();
    } catch {
      /* already closed */
    }
    this.openFormat = null;
    this.stopTimers();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private allocateTapRing(sampleRate: number, channels: number): void {
    this.tapRingFrames = Math.max(TAP_WINDOW_FRAMES * 4, Math.ceil(sampleRate * 4));
    this.tapRing = new Float32Array(this.tapRingFrames * channels);
  }

  private activeSegmentAt(rendered: number): Segment | null {
    if (this.segments.length === 0) return null;
    let active: Segment = this.segments[0]!;
    for (const seg of this.segments) {
      if (rendered >= seg.startFrame) active = seg;
    }
    return active;
  }

  private currentTrackIdAtPlayhead(rendered?: number): number | null {
    if (!this.addon || this.segments.length === 0) return this.current?.source.trackId ?? null;
    const frames = rendered ?? this.addon.stats().framesRendered;
    return (this.activeSegmentAt(frames) ?? this.segments[0]!).trackId;
  }

  private positionSec(rendered?: number): number {
    if (!this.addon || !this.openFormat || this.segments.length === 0) return this.pausedAtSec ?? 0;
    const frames = rendered ?? this.addon.stats().framesRendered;
    const active = this.activeSegmentAt(frames);
    if (!active) return this.pausedAtSec ?? 0;
    return active.offsetSec + Math.max(0, frames - active.startFrame) / this.openFormat.sampleRate;
  }

  private spawnDecoder(source: ExclusiveTrackSource, startAt: number, gen: number): void {
    if (!this.openFormat) return;
    const ffmpegPath = resolveFfmpegPath();
    const fmt = this.openFormat.format;
    const needsResample =
      source.dsd ||
      (source.sampleRate != null && source.sampleRate > 0 && source.sampleRate !== this.openFormat.sampleRate) ||
      source.sampleRate == null;
    const resampleArgs = needsResample
      ? ['-af', 'aresample=resampler=soxr:precision=28', '-ar', String(this.openFormat.sampleRate)]
      : [];
    const args = [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      ...(startAt > 0.01 ? ['-ss', startAt.toFixed(3)] : []),
      '-i',
      source.path,
      '-map',
      '0:a:0',
      '-vn',
      ...resampleArgs,
      '-acodec',
      FFMPEG_CODEC[fmt],
      '-ac',
      String(this.openFormat.channels),
      '-f',
      fmt === 's16' ? 's16le' : fmt === 's24' ? 's24le' : fmt === 's32' ? 's32le' : 'f32le',
      'pipe:1',
    ];
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.ffmpeg = child;
    this.pendingChunk = null;

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (gen !== this.generation) return;
      this.acceptChunk(chunk);
    });
    child.stdout.on('end', () => {
      if (gen !== this.generation) return;
      this.onDecoderEnd(gen);
    });
    child.on('error', (err) => {
      if (gen !== this.generation) return;
      this.deps.send({ type: 'error', trackId: source.trackId, message: `ffmpeg spawn failed: ${err.message}` });
    });
    child.on('close', (code) => {
      if (gen !== this.generation) return;
      if (code && code !== 0) {
        console.error(`[newamp] exclusive decode exited ${code} for ${source.path}\n${stderr}`);
        this.deps.send({ type: 'error', trackId: source.trackId, message: `Decode failed (ffmpeg ${code}).` });
      }
    });
  }

  private acceptChunk(chunk: Buffer): void {
    if (!this.addon || !this.openFormat) return;
    const buf = this.pendingChunk ? Buffer.concat([this.pendingChunk, chunk]) : chunk;
    let accepted = 0;
    try {
      accepted = this.addon.write(buf);
    } catch {
      // Device closed under us (device-lost teardown racing a queued stdout
      // chunk) — drop the bytes; an uncaught throw here would take down main.
      this.pendingChunk = null;
      return;
    }
    this.recordTap(buf.subarray(0, accepted));
    if (accepted < buf.length) {
      this.pendingChunk = buf.subarray(accepted);
      this.ffmpeg?.stdout.pause();
      this.startPump();
    } else {
      this.pendingChunk = null;
    }
    if (!this.started && this.playing) {
      // Start the device only once real data is in the ring — pre-roll silence
      // never reaches the DAC and the underrun counter stays honest.
      this.started = true;
      this.addon.start();
    }
  }

  private startPump(): void {
    if (this.pumpTimer) return;
    this.pumpTimer = setInterval(() => {
      if (!this.addon) return;
      if (!this.pendingChunk) {
        this.stopPump(true);
        return;
      }
      if (!this.playing) return; // paused: hold backpressure, keep the chunk
      let accepted = 0;
      try {
        accepted = this.addon.write(this.pendingChunk);
      } catch {
        this.pendingChunk = null;
        this.stopPump(false);
        return;
      }
      this.recordTap(this.pendingChunk.subarray(0, accepted));
      if (accepted >= this.pendingChunk.length) {
        this.pendingChunk = null;
        this.stopPump(true);
      } else if (accepted > 0) {
        this.pendingChunk = this.pendingChunk.subarray(accepted);
      }
    }, PUMP_INTERVAL_MS);
  }

  private stopPump(resumeStdout: boolean): void {
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
    if (resumeStdout) this.ffmpeg?.stdout.resume();
  }

  private resumePump(): void {
    if (this.pendingChunk) this.startPump();
    else this.ffmpeg?.stdout.resume();
  }

  private recordTap(bytes: Buffer): void {
    if (!this.openFormat || bytes.length === 0 || this.tapRing.length === 0) return;
    const { format, channels } = this.openFormat;
    const bps = BYTES_PER_SAMPLE[format];
    const frames = Math.floor(bytes.length / (bps * channels));
    const ring = this.tapRing;
    const cap = this.tapRingFrames;
    for (let f = 0; f < frames; f++) {
      const frameIndex = (this.framesWrittenTotal + f) % cap;
      for (let c = 0; c < channels; c++) {
        const off = (f * channels + c) * bps;
        let v: number;
        if (format === 'f32') v = bytes.readFloatLE(off);
        else if (format === 's16') v = bytes.readInt16LE(off) / 32768;
        else if (format === 's32') v = bytes.readInt32LE(off) / 2147483648;
        else {
          const raw = bytes[off]! | (bytes[off + 1]! << 8) | (bytes[off + 2]! << 16);
          v = (raw > 0x7fffff ? raw - 0x1000000 : raw) / 8388608;
        }
        ring[frameIndex * channels + c] = v;
      }
    }
    this.framesWrittenTotal += frames;
  }

  private onDecoderEnd(gen: number): void {
    if (!this.addon || gen !== this.generation) return;
    this.ffmpeg = null;
    const next = this.prepared;
    const probeFormats = this.openFormat ? this.probeDevice(this.openFormat.deviceId)?.formats : null;
    if (next && this.openFormat && probeFormats) {
      const nextChoice = chooseExclusiveFormat(next, probeFormats);
      const chainable =
        nextChoice &&
        nextChoice.format === this.openFormat.format &&
        nextChoice.sampleRate === this.openFormat.sampleRate &&
        nextChoice.channels === this.openFormat.channels;
      if (chainable) {
        // Splice the next track into the same ring at the exact frame boundary.
        this.prepared = null;
        this.segments.push({
          trackId: next.trackId,
          startFrame: this.framesWrittenTotal,
          offsetSec: 0,
          durationSec: next.durationSec,
        });
        this.current = { source: next, negotiated: { ...nextChoice, deviceName: this.openFormat.deviceName } };
        this.spawnDecoder(next, 0, gen);
        return;
      }
    }
    this.addon.setEos(true);
    this.eosSent = true;
  }

  private startTimers(): void {
    if (!this.positionTimer) {
      this.positionTimer = setInterval(() => this.pollPlayback(), POSITION_INTERVAL_MS);
    }
    if (!this.tapTimer) {
      this.tapTimer = setInterval(() => this.emitTap(), TAP_INTERVAL_MS);
    }
  }

  private stopTimers(): void {
    if (this.positionTimer) {
      clearInterval(this.positionTimer);
      this.positionTimer = null;
    }
    if (this.tapTimer) {
      clearInterval(this.tapTimer);
      this.tapTimer = null;
    }
    this.stopPump(false);
  }

  private pollPlayback(): void {
    if (!this.addon || !this.current) return;
    // ONE stats snapshot per poll: every derived value (track at playhead,
    // position, drained) reads the same framesRendered, so a boundary crossing
    // can never produce a torn trackId/position pair.
    const stats = this.addon.stats();

    // Track-boundary crossing (chained gapless): the playhead entered the next
    // segment — tell the renderer so the queue/UI advance while audio never gaps.
    const playheadTrack = this.currentTrackIdAtPlayhead(stats.framesRendered);
    if (playheadTrack != null && playheadTrack !== this.lastEmittedTrackId) {
      this.lastEmittedTrackId = playheadTrack;
      const seg = this.segments.find((s) => s.trackId === playheadTrack);
      this.deps.send({
        type: 'boundary',
        trackId: playheadTrack,
        positionSec: this.positionSec(stats.framesRendered),
        durationSec: seg?.durationSec ?? null,
      });
      // No position event this tick: a 'position' arriving in the same beat
      // as the boundary/ended state change is what made the renderer's stuck
      // ended flag re-fire queue advances.
      return;
    }

    if (stats.drained && this.eosSent && !this.endedEmitted) {
      this.endedEmitted = true;
      this.playing = false;
      this.deps.send({ type: 'ended', trackId: this.current.source.trackId });
      // Nothing meaningful to report while ended-idle — and continuing to
      // stream position events would keep re-notifying the renderer against a
      // terminal state. play()/seek()/resume() re-arm the timers.
      this.stopTimers();
      // Keep the device open briefly — the store usually starts the next track
      // immediately; the idle timer relinquishes if nothing follows.
      this.clearIdleTimer();
      this.idleTimer = setTimeout(() => this.releaseDevice(), IDLE_RELEASE_MS);
      return;
    }

    if (this.playing && !stats.running && !stats.drained) {
      // Expected running but the stream halted — device lost (unplugged, taken
      // by another exclusive app, rate changed externally). Invalidate the
      // generation FIRST so any straggling ffmpeg stdout data is dropped by
      // the gen guards instead of racing the device teardown.
      this.generation++;
      this.playing = false;
      this.deps.send({
        type: 'device-lost',
        trackId: this.current.source.trackId,
        positionSec: this.positionSec(stats.framesRendered),
      });
      this.stopTimers();
      this.releaseDevice();
      return;
    }

    this.emitPosition(stats);
  }

  private emitPosition(statsSnapshot?: { framesRendered: number; underruns: number; bufferedFrames: number }): void {
    if (!this.addon || !this.current) return;
    const stats = statsSnapshot ?? this.addon.stats();
    const trackId = this.currentTrackIdAtPlayhead(stats.framesRendered);
    this.deps.send({
      type: 'position',
      trackId,
      positionSec: this.positionSec(stats.framesRendered),
      durationSec:
        this.segments.find((s) => s.trackId === trackId)?.durationSec ??
        this.current.source.durationSec,
      underruns: stats.underruns,
      bufferedFrames: stats.bufferedFrames,
    });
  }

  private emitState(): void {
    if (!this.current) return;
    this.deps.send({
      type: 'state',
      trackId: this.current.source.trackId,
      playing: this.playing,
      negotiated: this.current.negotiated,
      positionSec: this.positionSec(),
      durationSec: this.current.source.durationSec,
    });
  }

  private emitTap(): void {
    if (!this.addon || !this.openFormat || !this.playing || this.tapRing.length === 0) return;
    const { channels, sampleRate } = this.openFormat;
    const rendered = this.addon.stats().framesRendered;
    if (rendered <= 0) return;
    const cap = this.tapRingFrames;
    // Window ending at the playhead. Guard: never read frames we haven't written.
    const end = Math.min(rendered, this.framesWrittenTotal);
    const start = Math.max(0, end - TAP_WINDOW_FRAMES);
    const frames = end - start;
    if (frames <= 0) return;
    const out = new Float32Array(TAP_WINDOW_FRAMES * channels);
    const offset = TAP_WINDOW_FRAMES - frames;
    for (let f = 0; f < frames; f++) {
      const src = ((start + f) % cap) * channels;
      const dst = (offset + f) * channels;
      for (let c = 0; c < channels; c++) out[dst + c] = this.tapRing[src + c]!;
    }
    this.deps.sendTap(out, channels, sampleRate);
  }

  private killFfmpeg(): void {
    this.stopPump(false);
    this.pendingChunk = null;
    if (this.ffmpeg && !this.ffmpeg.killed) {
      try {
        this.ffmpeg.kill();
      } catch {
        /* already gone */
      }
    }
    this.ffmpeg = null;
  }
}
