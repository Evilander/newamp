// Bit-Perfect Exclusive output driver (Windows, WASAPI exclusive).
//
// Owns the native addon (native/newamp-audio): resolves a track's source
// format, negotiates a device-NATIVE exclusive format from probeDevice()
// (never trusting miniaudio's hidden converter — if the source rate isn't
// natively supported we resample EXPLICITLY in ffmpeg, soxr where the build has
// it and a high-precision swr filter otherwise, and report which one ran),
// decodes with ffmpeg to raw PCM, and pushes it into the addon's lock-free ring
// with backpressure.
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
import { resamplerFilter, resamplerKindNow } from './resampler.js';
import { INPUT_PROTOCOLS, resolveFfmpegPath, watchFfmpegInput } from './transcode.js';
import { killChild } from './kill-child.js';
import { isStorageReadFailure, probeFileRead, watchReadFailureKind } from './read-failure.js';
import type {
  ExclusiveDeviceInfo,
  ExclusiveEventPayload,
  ExclusiveNegotiated,
  ExclusiveTrackSource,
} from '../shared/types.js';

type PcmFormat = 's16' | 's24' | 's32' | 'f32';

interface DeviceProbe {
  name: string;
  formats: Array<{ format: string; channels: number; sampleRate: number }>;
}

interface NativeAddon {
  listDevices(): ExclusiveDeviceInfo[];
  probeDevice(id?: string): DeviceProbe;
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
  source: ExclusiveTrackSource;
  negotiated: ExclusiveNegotiated;
  startFrame: number;
  offsetSec: number;
}

interface OpenFormat {
  deviceId: string | null;
  format: PcmFormat;
  sampleRate: number;
  channels: number;
  deviceName: string;
  /** What the device offered when it was opened; it can't change while it's held. */
  formats: Array<{ format: string; channels: number; sampleRate: number }>;
}

/** One run of failed reads with no recovery between them. */
interface Outage {
  /** Times the decode has been started again in this outage. */
  attempt: number;
  /** When its first read failed (performance.now(), which a sleep or a clock change doesn't move). */
  since: number;
  /** The drive is what failed, as opposed to the file (see isStorageReadFailure). */
  storage: boolean;
}

/** Where a decode that a failed read stopped picks up again. */
interface DecodeResume extends Outage {
  /** Whole frames of the segment already handed to the ring. */
  frames: number;
  /** Started to find out whether a clean early exit was the end of the track (see confirmEnd). */
  confirming?: boolean;
}

/** A stopped decode, and what it needs to start again. */
interface DecodeRestart {
  source: ExclusiveTrackSource;
  startAt: number;
  gen: number;
  resampler: ExclusiveNegotiated['resampler'];
  resume: DecodeResume;
}

/** The ffmpeg decoding the segment at the end of the ring. */
interface Decode {
  child: ChildProcessByStdio<null, Readable, Readable>;
  gen: number;
  source: ExclusiveTrackSource;
  /** Where in the source the segment starts, before any resume. */
  startAt: number;
  resampler: ExclusiveNegotiated['resampler'];
  frames: number;
  resume: DecodeResume | null;
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
// Eight seconds decoded ahead rides out a share that stops answering for a
// while; two did not. The ring is rounded up to a power of two by the addon,
// and the visualizer's delay line is sized from what it reports.
const RING_MS = 8000;
const FIRST_AUDIO_TIMEOUT_MS = 15000;
// After the ring runs dry the device stays stopped until this much is back
// in it, so a source that only trickles in doesn't stutter.
const REBUFFER_MS = 500;
// The device has audio queued but isn't consuming it: it is gone or wedged.
const DEVICE_STALL_MS = 1500;
// A sink can take longer than that to deliver its first callback after a start
// (HDMI, Bluetooth), so a device that hasn't moved at all since it was started
// gets this long.
const DEVICE_START_STALL_MS = 5000;
// A decoder that hasn't produced a byte this long, with nothing left to play,
// is hung on a read; it is stopped and started again where it left off.
const DECODE_STALL_MS = 8000;
// A decode stopped by a failed read starts again where it stopped, waiting a
// little longer each time, for as long as the outage lasts up to
// DECODE_OUTAGE_MS (the same limits as the gapless path, see
// gapless-transport.ts). The count is per outage: a share that drops every so
// often can drop any number of times in a long track.
const DECODE_RESUME_DELAY_MS = 1000;
const DECODE_RESUME_MAX_DELAY_MS = 5000;
const DECODE_OUTAGE_MS = Number(process.env.NEWAMP_DECODE_OUTAGE_MS) || 60_000;
// A decoder that stopped with no sign of a failed read (a damaged file) is
// tried again only this long.
const DECODE_ERROR_MS = 10_000;
// A resumed decode that got this far before failing again recovered: the next
// failure is a new outage.
const DECODE_PROGRESS_SEC = 1;
// A decode that exits cleanly this far short of the track's length may not
// have reached its end, whatever ffmpeg's log says (the gapless transport's
// limit too). The length on record can be off by seconds (a VBR MP3 without a
// Xing frame), so less than this doesn't count. A damaged file that stops this
// close to its end did play out.
const DECODE_END_SLACK_SEC = 2;
// A resumed decode starts this far before where the last one stopped and drops
// what it repeats: the first frames after a seek are not what a decode from
// the start gives there (MP3's bit reservoir, AAC's overlap).
const RESUME_WARMUP_SEC = 0.25;
// A device's format list is kept this long; the default device is never kept,
// since what it is can change under us.
const PROBE_CACHE_MS = 30_000;
// play()/seek() reset segments to a single entry, but an unbroken same-format
// gapless chain only ever pushes — cap it so a long chain (radio mode, an
// all-FLAC album marathon) can't grow this array unbounded.
const SEGMENT_LOG_CAP = 200;

// NOTE: .mka is deliberately absent — Matroska audio is a container that can
// hold lossy Opus/AAC/MP3; it only counts as lossless when music-metadata
// positively confirms the inner codec (the resolver overrides this default).
const LOSSLESS_EXTS = new Set(['.flac', '.alac', '.aiff', '.aif', '.ape', '.wv', '.tta', '.wav']);
const DSD_EXTS = new Set(['.dsf', '.dff']);
// One channel to two at unity: the mapping the sample transport uses
// (gapless-transport.ts).
const MONO_TO_STEREO = 'aformat=channel_layouts=mono|stereo,pan=stereo|FL=FL+FC|FR=FR+FC';

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
 * The rate ffmpeg decodes a source at, null when it isn't known. Opus always
 * comes out at 48000 Hz, whatever input rate its header records.
 */
function decodedRate(source: ExclusiveTrackSource): number | null {
  if (extname(source.path).toLowerCase() === '.opus') return 48000;
  return source.sampleRate && source.sampleRate > 0 ? source.sampleRate : null;
}

/**
 * Pick a device-native exclusive format for a source. Honesty rules:
 * - the chosen (format, rate, channels) MUST come from the probe list, so the
 *   device runs it natively and nothing converts behind our back;
 * - any rate change is done explicitly in ffmpeg and flagged (the caller
 *   records which resampler, see electron/resampler.ts);
 * - bitPerfect is the strict claim: lossless source, rate preserved, bit depth
 *   preserved, stereo-to-stereo, no DSD conversion.
 */
export function chooseExclusiveFormat(
  source: ExclusiveTrackSource,
  formats: Array<{ format: string; channels: number; sampleRate: number }>,
): Omit<ExclusiveNegotiated, 'deviceName' | 'resampler'> | null {
  const usable = formats.filter(
    (f): f is { format: PcmFormat; channels: number; sampleRate: number } =>
      (f.format === 's16' || f.format === 's24' || f.format === 's32' || f.format === 'f32') &&
      (f.channels === 2 || f.channels === 0),
  );
  if (usable.length === 0) return null;

  const channels = 2;
  // DSD has no PCM rate; the app-wide policy converts it at 88.2k.
  const sourceRate = source.dsd ? 88200 : decodedRate(source);

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
    sourceSampleRate: decodedRate(source) ?? source.sampleRate ?? null,
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

/** Which resampler a negotiated conversion runs on; asks ffmpeg only when there is one. */
function resamplerFor(choice: { resampled: boolean }): ExclusiveNegotiated['resampler'] {
  return choice.resampled ? resamplerKindNow(resolveFfmpegPath()) : null;
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
  private lastEmittedSegment: Segment | null = null;
  private pendingChain: Segment | null = null;
  private waitingSince = 0;
  private framesWrittenTotal = 0;
  private pausedAtSec: number | null = null;
  // The next track's segment waits here until its decoder has produced audio,
  // so a file that never decodes doesn't leave a boundary for a track that
  // never played.
  private pendingSegment: Segment | null = null;
  private decode: Decode | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  // A failed read is being waited out: the decoder is about to start again.
  private decodeRetrying = false;
  // The file system is being asked about a file whose decoder stopped (see
  // settleFailure and confirmEnd); cleared when the answer no longer matters.
  private asking: object | null = null;
  // A decode that stopped while paused starts again once playback does, with a
  // fresh outage: the pause is not time the drive was given to answer.
  private parkedDecode: DecodeRestart | null = null;
  // The decoder ended with nothing prepared and EOS was set; a track prepared
  // before the ring has played out is still spliced on.
  private awaitingNext = false;
  private lastDecodedAt = 0;
  // The ring ran dry mid-stream: the device is stopped until it has refilled.
  private rebuffering = false;
  // `moved`: the render counter has advanced since the device was started.
  private renderMark: { frames: number; at: number; moved: boolean } | null = null;
  // The addon counts every callback that came up short; one dry spell is one.
  private underrunEpisodes = 0;
  private lastUnderruns = 0;
  private inUnderrun = false;
  private readonly probeCache = new Map<string, { at: number; probe: DeviceProbe }>();

  // Playhead-aligned visualizer delay line: decoded PCM is up to RING_MS ahead
  // of the DAC, so the tap reads at framesRendered, not at the write head.
  private tapRing: Float32Array = new Float32Array(0);
  private tapRingFrames = 0;
  private tapRemainder: Buffer = Buffer.alloc(0);

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

  probeDevice(deviceId: string | null): DeviceProbe | null {
    if (!this.addon) return null;
    // Asking the device is a CoreAudio round trip on the main thread, and an
    // album can ask at every track.
    const kept = deviceId != null ? this.probeCache.get(deviceId) : undefined;
    if (kept && Date.now() - kept.at < PROBE_CACHE_MS) return kept.probe;
    try {
      const probe = this.addon.probeDevice(deviceId ?? undefined);
      if (deviceId != null) this.probeCache.set(deviceId, { at: Date.now(), probe });
      return probe;
    } catch (err) {
      console.error('[newamp] exclusive probeDevice failed', err);
      return null;
    }
  }

  status(): { active: boolean; trackId: number | null; negotiated: ExclusiveNegotiated | null } {
    const audible = this.audibleSource();
    return {
      active: this.current != null,
      trackId: this.currentTrackIdAtPlayhead(),
      negotiated: audible?.negotiated ?? null,
    };
  }

  /**
   * Start (or chain-ack) exclusive playback of a resolved track source.
   * Returns the negotiated format, or throws with an honest reason the
   * renderer can surface and fall back on.
   */
  async play(source: ExclusiveTrackSource, startAt: number, deviceId: string | null): Promise<{ negotiated: ExclusiveNegotiated; chained: boolean }> {
    if (!this.addon) throw new Error('Exclusive output addon is not available.');
    this.clearIdleTimer();

    // Chained continuation: the store advanced its queue after our boundary
    // event; the stream is already playing this track. Ack without touching it.
    const audible = this.openFormat && this.addon ? this.activeSegmentAt(this.addon.stats().framesRendered) : null;
    if (
      this.current &&
      this.playing &&
      audible && this.pendingChain === audible &&
      source.trackId === audible.source.trackId &&
      startAt <= 0.5
    ) {
      this.pendingChain = null;
      return { negotiated: audible.negotiated, chained: true };
    }

    const probe = this.probeDevice(deviceId);
    if (!probe) throw new Error('Exclusive device probe failed.');
    const chosen = chooseExclusiveFormat(source, probe.formats);
    if (!chosen) throw new Error(`No usable exclusive format on ${probe.name}.`);
    const negotiated: ExclusiveNegotiated = { ...chosen, deviceName: probe.name, resampler: resamplerFor(chosen) };

    // Only a replacement decoder gets a new generation; a chain ack keeps
    // the callbacks of the already-running decoder valid.
    const gen = ++this.generation;
    this.killFfmpeg();
    this.stopTimers();
    this.pausedAtSec = null;
    this.pendingChain = null;
    this.prepared = null;

    const sameOpen =
      this.openFormat &&
      this.openFormat.deviceId === deviceId &&
      this.openFormat.format === negotiated.format &&
      this.openFormat.sampleRate === negotiated.sampleRate &&
      this.openFormat.channels === negotiated.channels;

    if (!sameOpen) {
      try {
        // open() lets go of the current stream itself. Closing first would
        // also hand the device back, and the next track's rate would be
        // reached through the system's own.
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
          formats: probe.formats,
        };
        this.framesWrittenTotal = 0;
        this.underrunEpisodes = 0;
        this.lastUnderruns = 0;
        this.inUnderrun = false;
        this.allocateTapRing(negotiated.sampleRate, negotiated.channels, opened.capacityFrames);
      } catch (err) {
        this.openFormat = null;
        this.current = null;
        this.probeCache.clear();
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
    this.rebuffering = false;
    this.renderMark = null;
    this.waitingSince = Date.now();
    this.playing = true;
    this.current = { source, negotiated };
    this.segments = [
      {
        source,
        negotiated,
        startFrame: this.framesWrittenTotal,
        offsetSec: Math.max(0, startAt),
      },
    ];
    this.lastEmittedSegment = this.segments[0]!;

    this.spawnDecoder(source, Math.max(0, startAt), gen, negotiated.resampler);
    this.startTimers();
    this.emitState();
    return { negotiated, chained: false };
  }

  prepareNext(source: ExclusiveTrackSource | null): void {
    this.prepared = source;
    // The ring holds seconds of audio, so the decoder can finish well before
    // the store asks for the next track. Until the ring has drained, the end
    // of stream can still be taken back and the track spliced on.
    if (source && this.addon && this.awaitingNext && !this.endedEmitted && !this.addon.stats().drained) {
      this.spliceNext(source, this.generation);
    }
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
      this.waitingSince = Date.now();
      this.lastDecodedAt = Date.now();
      // A ring that is still empty puts the device back to waiting on the
      // next poll.
      this.rebuffering = false;
      if (this.started || this.addon.stats().bufferedFrames > 0) {
        if (!this.startDevice()) return;
        this.started = true;
      }
      this.resumePump();
      this.startParkedDecode();
      this.startTimers();
      this.emitState();
      return;
    }
    // Device was relinquished during the pause — reopen and reseek.
    const source = this.audibleSource()!.source;
    const at = this.pausedAtSec ?? 0;
    try {
      await this.play(source, at, deviceId);
    } catch (err) {
      // The device can't be had again (switched off, or another app holds
      // it). The transport has been showing play since the press, so the
      // renderer is told, and plays the track from here itself.
      console.error('[newamp] exclusive could not reopen the device on resume', err);
      this.deps.send({ type: 'device-lost', trackId: source.trackId, positionSec: at });
    }
  }

  seek(seconds: number): void {
    if (!this.addon || !this.current) return;
    const audible = this.audibleSource()!;
    this.current = audible;
    if (!this.openFormat) {
      this.pausedAtSec = Math.max(0, Math.min(seconds, audible.source.durationSec ?? seconds));
      return;
    }
    const gen = ++this.generation;
    const { source, negotiated } = audible;
    const target = Math.max(0, Math.min(seconds, source.durationSec ?? seconds));
    this.killFfmpeg();
    this.addon.stopDevice();
    this.addon.clear();
    this.addon.setEos(false);
    this.eosSent = false;
    this.endedEmitted = false;
    this.started = false;
    this.rebuffering = false;
    this.renderMark = null;
    this.waitingSince = Date.now();
    this.pendingChain = null;
    this.prepared = null;
    this.framesWrittenTotal = this.addon.stats().framesRendered;
    this.segments = [
      {
        source,
        negotiated,
        startFrame: this.framesWrittenTotal,
        offsetSec: target,
      },
    ];
    this.lastEmittedSegment = this.segments[0]!;
    this.spawnDecoder(source, target, gen, negotiated.resampler);
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
    this.lastEmittedSegment = null;
    this.pendingChain = null;
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
    this.current = this.audibleSource();
    this.pendingChain = null;
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
    this.probeCache.clear();
    this.stopTimers();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private allocateTapRing(sampleRate: number, channels: number, capacityFrames: number): void {
    // The playhead trails the write head by up to a ring's worth, and the
    // addon rounds the ring up to a power of two, so the size it reports is
    // what counts; RING_MS is only the floor.
    const ringFrames = Math.max(capacityFrames || 0, Math.ceil((sampleRate * RING_MS) / 1000));
    this.tapRingFrames = Math.max(TAP_WINDOW_FRAMES * 4, ringFrames + sampleRate * 2);
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
    if (!this.addon || !this.openFormat || this.segments.length === 0) return this.current?.source.trackId ?? null;
    const frames = rendered ?? this.addon.stats().framesRendered;
    return (this.activeSegmentAt(frames) ?? this.segments[0]!).source.trackId;
  }

  private audibleSource(rendered?: number): { source: ExclusiveTrackSource; negotiated: ExclusiveNegotiated } | null {
    if (!this.addon || !this.openFormat) return this.current;
    const segment = this.activeSegmentAt(rendered ?? this.addon.stats().framesRendered);
    return segment ? { source: segment.source, negotiated: segment.negotiated } : this.current;
  }

  private positionSec(rendered?: number): number {
    if (!this.addon || !this.openFormat || this.segments.length === 0) return this.pausedAtSec ?? 0;
    const frames = rendered ?? this.addon.stats().framesRendered;
    const active = this.activeSegmentAt(frames);
    if (!active) return this.pausedAtSec ?? 0;
    return active.offsetSec + Math.max(0, frames - active.startFrame) / this.openFormat.sampleRate;
  }

  private spawnDecoder(
    source: ExclusiveTrackSource,
    startAt: number,
    gen: number,
    resampler: ExclusiveNegotiated['resampler'],
    resume: DecodeResume | null = null,
  ): void {
    if (!this.openFormat) return;
    const ffmpegPath = resolveFfmpegPath();
    const { format: fmt, sampleRate, channels } = this.openFormat;
    const frameBytes = BYTES_PER_SAMPLE[fmt] * channels;
    const sourceRate = decodedRate(source);
    const needsResample = source.dsd || sourceRate == null || sourceRate !== sampleRate;
    // The same resampler the negotiated format reports, even if the probe
    // has answered differently since. The output rate is always the device's:
    // raw PCM carries no header, so a decoder that runs at another rate than
    // the one on record would otherwise play at the wrong speed. Nothing is
    // converted when the two agree. A mono source goes to both channels as it
    // is, the way the shared player plays it; `-ac 2` on its own mixes it in
    // 3 dB down.
    const filters = [
      ...(source.channels === 1 ? [MONO_TO_STEREO] : []),
      ...(needsResample ? [resamplerFilter(resampler ?? resamplerKindNow(ffmpegPath))] : []),
    ];
    const filterArgs = [...(filters.length ? ['-af', filters.join(',')] : []), '-ar', String(sampleRate)];
    // Output frames are at the device rate, so they count source time as is.
    const from = startAt + (resume?.frames ?? 0) / sampleRate;
    // A resume seeks a little earlier and drops the overlap, so the join is
    // exact for MP3 and AAC as well.
    const warmFrames =
      resume && resume.frames > 0
        ? Math.min(Math.round(RESUME_WARMUP_SEC * sampleRate), Math.floor(from * sampleRate))
        : 0;
    const seekTo = from - warmFrames / sampleRate;
    const args = [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      ...(seekTo > 0.01 ? ['-ss', seekTo.toFixed(6)] : []),
      ...INPUT_PROTOCOLS,
      '-i',
      source.path,
      '-map',
      '0:a:0',
      '-vn',
      ...filterArgs,
      '-acodec',
      FFMPEG_CODEC[fmt],
      '-ac',
      String(channels),
      '-f',
      fmt === 's16' ? 's16le' : fmt === 's24' ? 's24le' : fmt === 's32' ? 's32le' : 'f32le',
      'pipe:1',
    ];
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    // Holds the file open for as long as the track plays; a move to the
    // Recycle Bin stops it first.
    watchFfmpegInput(child, source.path);
    // ffmpeg exits 0 after a read that failed, as it does at the end of a
    // file, so its log is what tells the two apart.
    const readFailure = watchReadFailureKind(child, source.path);
    const decode: Decode = { child, gen, source, startAt, resampler, frames: resume?.frames ?? 0, resume };
    // What the last decode hadn't yet got into the ring stays queued ahead of
    // this one's audio (play, seek and release have dropped theirs already).
    this.ffmpeg = child;
    this.decode = decode;
    this.lastDecodedAt = Date.now();

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });
    // Whole frames only: a frame cut in two by a pipe read, or by the end of
    // a decode that failed, must not shift the samples that follow.
    let partial: Buffer = Buffer.alloc(0);
    let discard = warmFrames * frameBytes;
    child.stdout.on('data', (chunk: Buffer) => {
      if (gen !== this.generation || this.ffmpeg !== child) return;
      if (discard > 0) {
        const dropped = Math.min(discard, chunk.length);
        discard -= dropped;
        chunk = chunk.subarray(dropped);
        if (chunk.length === 0) return;
      }
      const joined = partial.length ? Buffer.concat([partial, chunk]) : chunk;
      const whole = joined.length - (joined.length % frameBytes);
      partial = Buffer.from(joined.subarray(whole));
      if (whole === 0) return;
      decode.frames += whole / frameBytes;
      this.acceptChunk(joined.subarray(0, whole));
    });
    child.on('error', (err) => {
      if (gen !== this.generation || this.ffmpeg !== child) return;
      this.deps.send({ type: 'error', trackId: source.trackId, message: `ffmpeg spawn failed: ${err.message}` });
    });
    // The end of the decode is decided here, not at the end of stdout: the log
    // is complete only now, and a read that failed ends stdout like a file's
    // end does.
    child.on('close', (code) => {
      if (gen !== this.generation || this.ffmpeg !== child) return;
      // Stopped from outside (the file is about to be moved to the Recycle
      // Bin). Its stdout was destroyed with it, and a destroyed stream never
      // emits 'end', so the decode ends here. A seek or a new play already
      // replaced this.ffmpeg before it killed the old one.
      if (child.killed) {
        this.onDecoderEnd(gen);
        return;
      }
      const failure = readFailure();
      if (code === 0 && failure == null) {
        // A splice that decodes to nothing is a file with no audio, not a track.
        if (decode.frames === 0 && this.pendingSegment) {
          this.dropPendingSegment(source, `ffmpeg produced no audio for ${source.path}`);
          return;
        }
        // The log doesn't say a read failed, but not every failed read is
        // reported as one: well short of the track's length, the exit is
        // checked before it is believed. A decoder started to check, that
        // found nothing more, settles it.
        const confirmed = decode.resume?.confirming === true && decode.frames === decode.resume.frames;
        if (!confirmed && this.stoppedShort(decode)) {
          this.confirmEnd(decode, stderr);
          return;
        }
        this.onDecoderEnd(gen);
        return;
      }
      this.settleFailure(decode, failure, code, stderr);
    });
  }

  /** How far into the source a decode that stopped now has got, in seconds. */
  private stoppedAt(decode: Decode): number {
    return decode.startAt + decode.frames / (this.openFormat?.sampleRate || 1);
  }

  /** A decode that exited cleanly well short of the track's length, when that is known. */
  private stoppedShort(decode: Decode): boolean {
    const duration = decode.source.durationSec;
    return !!duration && !!this.openFormat && this.stoppedAt(decode) < duration - DECODE_END_SLACK_SEC;
  }

  /**
   * A decode that exited cleanly well short of the track's length: the end of
   * a file shorter than the library thinks, or a read that failed without
   * ffmpeg saying so. The file system is asked first, since a file whose last
   * bytes can't be read was not read to its end. If they can, one more decoder
   * is started from the same frame, and only when that one also exits cleanly
   * with nothing more is this the end. If it has more, playback carries on.
   */
  private confirmEnd(decode: Decode, detail: string): void {
    const { source, startAt, resampler, gen } = decode;
    const outage = this.outageOf(decode);
    this.waitOnFileSystem();
    const asked = (this.asking = {});
    void probeFileRead(source.path).then((probe) => {
      if (this.asking !== asked) return;
      this.asking = null;
      // Each look that finds a little more audio and another clean exit is part
      // of the same outage, and that has its limit like any other.
      if (probe === 'readable' && performance.now() - outage.since < DECODE_ERROR_MS) {
        this.decodeRetrying = false;
        const resume: DecodeResume = { frames: decode.frames, attempt: outage.attempt + 1, since: outage.since, storage: outage.storage, confirming: true };
        if (!this.playing) {
          this.parkedDecode = { source, startAt, gen, resampler, resume };
          return;
        }
        this.waitingSince = Date.now();
        this.spawnDecoder(source, startAt, gen, resampler, resume);
        return;
      }
      // Not the end, then, but a failed read like any other: waited out for as
      // long as the storage is what did not deliver.
      this.retryDecode(decode, outage, probe === 'storage', null, detail || 'stopped short of the end of the file');
    });
  }

  /**
   * A decode that a failed read, or the process failing, stopped. Whether the
   * drive or the file is to blame decides how long it is waited on: the log
   * says so when the reason can only be the drive's, and when it can't (an
   * "I/O error" is also what a file with damaged data gets) the file system is
   * asked whether the file can be read at all.
   */
  private settleFailure(decode: Decode, failure: 'storage' | 'unclear' | null, code: number | null, detail: string): void {
    const outage = this.outageOf(decode);
    if (failure !== 'unclear' || outage.storage) {
      this.retryDecode(decode, outage, failure === 'storage', code, detail);
      return;
    }
    this.waitOnFileSystem();
    const asked = (this.asking = {});
    void isStorageReadFailure(failure, decode.source.path).then((storage) => {
      if (this.asking !== asked) return;
      this.asking = null;
      this.retryDecode(decode, outage, storage, code, detail);
    });
  }

  /** The decoder has gone and the file system is being asked about the file: nothing is playing it meanwhile. */
  private waitOnFileSystem(): void {
    this.ffmpeg = null;
    this.decodeRetrying = true;
  }

  /** The run of failed reads a decode that stopped now belongs to. */
  private outageOf(decode: Decode): Outage {
    const { resume } = decode;
    const rate = this.openFormat?.sampleRate ?? 0;
    // A resumed decode that recovered before stopping again begins a new
    // outage; one that didn't carries on the old.
    if (!resume || decode.frames - resume.frames >= DECODE_PROGRESS_SEC * rate) {
      return { attempt: 0, since: performance.now(), storage: false };
    }
    return { attempt: resume.attempt, since: resume.since, storage: resume.storage };
  }

  /**
   * A decode stopped, by a failed read or by the process failing, or it hung.
   * Read the file again from the frame it reached, or give the track up once
   * the outage has lasted too long.
   */
  private retryDecode(
    decode: Decode,
    outage: Outage,
    storageFailed: boolean,
    code: number | null,
    detail: string,
  ): void {
    const { source, startAt, resampler, gen } = decode;
    this.ffmpeg = null;
    // Once a read has failed, what follows in the outage is the drive's too,
    // whatever the later attempts log.
    const storage = storageFailed || outage.storage;
    const next: DecodeResume = { frames: decode.frames, attempt: outage.attempt + 1, since: outage.since, storage };
    const restart: DecodeRestart = { source, startAt, gen, resampler, resume: next };
    // Nobody is waiting on a paused player: the decode starts again when it
    // plays. Giving the track up now would play the next one over the pause.
    if (!this.playing) {
      this.decodeRetrying = false;
      this.parkedDecode = restart;
      return;
    }
    // A drive that stopped answering gets the long wait; a decoder that
    // failed for any other reason (a damaged file) only a short one, and not
    // at all before it has produced anything.
    const limitMs = storage ? DECODE_OUTAGE_MS : DECODE_ERROR_MS;
    if ((decode.frames > 0 || storage) && performance.now() - outage.since < limitMs) {
      const rate = this.openFormat?.sampleRate ?? 1;
      console.warn(
        `[newamp] exclusive decode stopped at ${(startAt + decode.frames / rate).toFixed(2)} s (ffmpeg ${code}) for ${source.path}; reading again from there (try ${next.attempt})\n${detail}`,
      );
      this.decodeRetrying = true;
      this.resumeTimer = setTimeout(() => {
        this.resumeTimer = null;
        if (gen !== this.generation || !this.openFormat) return;
        // The first-audio timeout covers each new decoder, so one that hangs
        // before its first byte is not waited on forever.
        this.decodeRetrying = false;
        if (!this.playing) {
          this.parkedDecode = restart;
          return;
        }
        this.waitingSince = Date.now();
        this.spawnDecoder(source, startAt, gen, resampler, next);
      }, Math.min(DECODE_RESUME_DELAY_MS * next.attempt, DECODE_RESUME_MAX_DELAY_MS));
      return;
    }
    console.error(`[newamp] exclusive decode gave up on ${source.path} (ffmpeg ${code})\n${detail}`);
    this.decodeRetrying = false;
    if (this.pendingSegment) {
      this.dropPendingSegment(source, 'the next track could not be read');
      return;
    }
    // A damaged file that stops where it nearly ended anyway did play out: it
    // ends there, as it always has, and what follows goes on.
    if (!storage && decode.frames > 0 && this.stoppedAt(decode) >= (source.durationSec ?? Infinity) - DECODE_END_SLACK_SEC) {
      this.onDecoderEnd(gen);
      return;
    }
    if (storage) {
      // The track's end hasn't been reached, so it isn't over; the drive just
      // isn't answering. The shared path waits out a slow drive its own way,
      // so it is asked to take the track from where it stopped.
      this.handOver(decode.frames === 0 ? 'The drive stopped answering.' : 'The drive stopped answering partway through the track.');
      return;
    }
    // Not the end of the track, and not a device failure: say so, and let the
    // renderer decide.
    this.generation++;
    this.playing = false;
    this.releaseDevice();
    this.deps.send({
      type: 'error',
      trackId: source.trackId,
      message: decode.frames === 0 ? `Decode failed (ffmpeg ${code}).` : 'Decode failed partway through the track.',
    });
  }

  /** Start the decode that stopped during a pause, now that playback has resumed. */
  private startParkedDecode(): void {
    const parked = this.parkedDecode;
    if (!parked) return;
    this.parkedDecode = null;
    this.spawnDecoder(parked.source, parked.startAt, parked.gen, parked.resampler, {
      ...parked.resume,
      since: performance.now(),
    });
  }

  /**
   * The track spliced after this one never produced audio. What is already in
   * the ring still plays out; the store then reaches that track as an ordinary
   * play, which reports its own failure.
   */
  private dropPendingSegment(source: ExclusiveTrackSource, reason: string): void {
    console.warn(`[newamp] exclusive splice dropped for ${source.path}: ${reason}`);
    this.pendingSegment = null;
    this.decodeRetrying = false;
    this.ffmpeg = null;
    this.addon?.setEos(true);
    this.eosSent = true;
  }

  private acceptChunk(chunk: Buffer): void {
    if (!this.addon || !this.openFormat) return;
    this.lastDecodedAt = Date.now();
    this.decodeRetrying = false;
    if (this.pendingSegment) {
      this.segments.push(this.pendingSegment);
      if (this.segments.length > SEGMENT_LOG_CAP) {
        this.segments.splice(0, this.segments.length - SEGMENT_LOG_CAP);
      }
      this.current = { source: this.pendingSegment.source, negotiated: this.pendingSegment.negotiated };
      this.pendingSegment = null;
    }
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
      if (this.startDevice()) this.started = true;
    }
  }

  /**
   * Run the device. Starting can fail (it was unplugged, or another process
   * took it), and a throw out of a stream listener would be an uncaught
   * exception in main, so a failure is reported as the device being lost.
   */
  private startDevice(): boolean {
    if (!this.addon) return false;
    try {
      this.addon.start();
    } catch (err) {
      console.error('[newamp] exclusive start failed', err);
      this.deviceLost();
      return false;
    }
    this.renderMark = null;
    return true;
  }

  /**
   * The stream can't go on. Invalidate the generation FIRST so any straggling
   * ffmpeg stdout data is dropped by the gen guards instead of racing the
   * device teardown.
   */
  private deviceLost(rendered?: number): void {
    if (!this.current) return;
    const frames = rendered ?? this.addon?.stats().framesRendered;
    this.generation++;
    this.playing = false;
    this.deps.send({
      type: 'device-lost',
      trackId: this.currentTrackIdAtPlayhead(frames) ?? this.current.source.trackId,
      positionSec: this.positionSec(frames),
    });
    this.stopTimers();
    this.releaseDevice();
  }

  /**
   * The track can't be read here and now, though it isn't broken: the drive
   * stopped answering, or a read hangs. The device is let go and the error
   * says where the playhead was, so the renderer carries the track on with the
   * shared player from there instead of skipping it.
   */
  private handOver(message: string, rendered?: number): void {
    if (!this.current) return;
    const frames = rendered ?? this.addon?.stats().framesRendered;
    this.generation++;
    this.playing = false;
    this.deps.send({
      type: 'error',
      trackId: this.currentTrackIdAtPlayhead(frames) ?? this.current.source.trackId,
      message,
      positionSec: this.positionSec(frames),
    });
    this.stopTimers();
    this.releaseDevice();
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
    // Both stdout chunks and native backpressure can split a PCM frame.
    // Count and decode it only after all its bytes have been accepted.
    if (this.tapRemainder.length) bytes = Buffer.concat([this.tapRemainder, bytes]);
    const frameBytes = bps * channels;
    const frames = Math.floor(bytes.length / frameBytes);
    this.tapRemainder = Buffer.from(bytes.subarray(frames * frameBytes));
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
    this.decodeRetrying = false;
    const next = this.prepared;
    if (next && this.spliceNext(next, gen)) return;
    this.addon.setEos(true);
    this.eosSent = true;
    this.awaitingNext = true;
  }

  /**
   * Chain a track onto the end of the ring when the open device already plays
   * its format. Returns false when it can't be chained.
   */
  private spliceNext(next: ExclusiveTrackSource, gen: number): boolean {
    if (!this.addon || !this.openFormat) return false;
    const nextChoice = chooseExclusiveFormat(next, this.openFormat.formats);
    if (
      !nextChoice ||
      nextChoice.format !== this.openFormat.format ||
      nextChoice.sampleRate !== this.openFormat.sampleRate ||
      nextChoice.channels !== this.openFormat.channels
    ) {
      return false;
    }
    // Splice the next track into the same ring at the exact frame boundary.
    // The segment only counts once its decoder has produced audio.
    this.prepared = null;
    this.awaitingNext = false;
    if (this.eosSent) {
      this.addon.setEos(false);
      this.eosSent = false;
    }
    const negotiated = { ...nextChoice, deviceName: this.openFormat.deviceName, resampler: resamplerFor(nextChoice) };
    // The last of the previous track may still be waiting to go into the ring
    // (or sit in it as part of a frame the rest of which hasn't followed): the
    // next track's first frame comes after all of it.
    const frameBytes = BYTES_PER_SAMPLE[this.openFormat.format] * this.openFormat.channels;
    const unwritten = (this.tapRemainder.length + (this.pendingChunk?.length ?? 0)) / frameBytes;
    this.pendingSegment = { source: next, negotiated, startFrame: this.framesWrittenTotal + unwritten, offsetSec: 0 };
    this.spawnDecoder(next, 0, gen, negotiated.resampler);
    return true;
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
    const seg = this.activeSegmentAt(stats.framesRendered);
    if (seg && seg !== this.lastEmittedSegment) {
      this.lastEmittedSegment = seg;
      this.pendingChain = seg;
      this.deps.send({
        type: 'boundary',
        trackId: seg.source.trackId,
        positionSec: this.positionSec(stats.framesRendered),
        durationSec: seg.source.durationSec,
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

    if (this.playing && !this.started && !this.decodeRetrying && Date.now() - this.waitingSince >= FIRST_AUDIO_TIMEOUT_MS) {
      // A read that hangs (a seek into a share that isn't answering) is the
      // drive's, not the track's: the shared path is asked to take it from here.
      this.handOver('Timed out waiting for decoded audio.', stats.framesRendered);
      return;
    }

    const underran = stats.underruns > this.lastUnderruns;
    this.trackUnderruns(stats);

    // A ring that ran dry holds the device stopped until it has refilled.
    if (this.playing && this.started && this.rebuffering) {
      if (this.eosSent || stats.bufferedFrames >= this.rebufferFrames()) {
        this.rebuffering = false;
        // The snapshot predates the start: judge the device on the next poll.
        if (this.startDevice()) this.emitPosition(stats);
        return;
      }
    }

    if (this.playing && this.started && !this.rebuffering && !stats.drained) {
      // Expected running but the stream halted — device lost (unplugged, taken
      // by another exclusive app, rate changed externally).
      if (!stats.running) {
        this.deviceLost(stats.framesRendered);
        return;
      }
      // CoreAudio keeps reporting a device that went away as started, so a
      // stream that holds audio and isn't consuming it counts as halted too.
      if (stats.bufferedFrames > 0) {
        const mark = this.renderMark;
        if (!mark || mark.frames !== stats.framesRendered) {
          this.renderMark = { frames: stats.framesRendered, at: Date.now(), moved: mark != null };
        } else if (Date.now() - mark.at >= (mark.moved ? DEVICE_STALL_MS : DEVICE_START_STALL_MS)) {
          this.deviceLost(stats.framesRendered);
          return;
        }
      } else {
        this.renderMark = null;
      }
    }

    // The ring is empty, or it ran short in the last poll and holds less than
    // a refill: a source that trickles can leave it just above empty at every
    // poll while the device keeps coming up short between them.
    const starved = stats.bufferedFrames === 0 || (underran && stats.bufferedFrames < this.rebufferFrames());
    if (this.playing && this.started && !this.eosSent && starved) {
      if (this.decode && this.ffmpeg && !this.pendingChunk && Date.now() - this.lastDecodedAt >= DECODE_STALL_MS) {
        // Nothing left to play and the decoder hasn't produced a byte in all
        // this time: hung on a read. Start it again where it got to.
        const decode = this.decode;
        const outage = this.outageOf(decode);
        killChild(decode.child);
        this.retryDecode(decode, outage, true, null, 'the decoder stopped producing audio');
        return;
      }
      if (!this.rebuffering && (this.ffmpeg || this.resumeTimer || this.asking)) {
        // Underrun with more still to come: wait for it rather than play it
        // out a few milliseconds at a time.
        try {
          this.addon.stopDevice();
        } catch {
          /* closed under us; the next poll sees it */
        }
        this.rebuffering = true;
        this.renderMark = null;
      }
    }

    this.emitPosition(stats);
  }

  private rebufferFrames(): number {
    return Math.round(((this.openFormat?.sampleRate ?? 44100) * REBUFFER_MS) / 1000);
  }

  private trackUnderruns(stats: { underruns: number }): void {
    if (stats.underruns > this.lastUnderruns) {
      if (!this.inUnderrun) this.underrunEpisodes++;
      this.inUnderrun = true;
    } else if (!this.rebuffering) {
      this.inUnderrun = false;
    }
    this.lastUnderruns = stats.underruns;
  }

  private emitPosition(statsSnapshot?: { framesRendered: number; underruns: number; bufferedFrames: number }): void {
    if (!this.addon || !this.current) return;
    const stats = statsSnapshot ?? this.addon.stats();
    const trackId = this.currentTrackIdAtPlayhead(stats.framesRendered);
    // Waiting on audio: the ring ran dry, or a read is being waited out and
    // what is queued is running low (while it holds a refill, the audio plays).
    const buffering = this.rebuffering || (this.decodeRetrying && stats.bufferedFrames < this.rebufferFrames());
    this.deps.send({
      type: 'position',
      trackId,
      positionSec: this.positionSec(stats.framesRendered),
      durationSec:
        this.activeSegmentAt(stats.framesRendered)?.source.durationSec ??
        this.current.source.durationSec,
      underruns: this.underrunEpisodes,
      bufferedFrames: stats.bufferedFrames,
      buffering,
    });
  }

  private emitState(): void {
    const audible = this.audibleSource();
    if (!audible) return;
    this.deps.send({
      type: 'state',
      trackId: audible.source.trackId,
      playing: this.playing,
      negotiated: audible.negotiated,
      positionSec: this.positionSec(),
      durationSec: audible.source.durationSec,
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
    this.tapRemainder = Buffer.alloc(0);
    this.stopPump(false);
    this.pendingChunk = null;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.parkedDecode = null;
    this.asking = null;
    this.decodeRetrying = false;
    this.awaitingNext = false;
    this.pendingSegment = null;
    this.decode = null;
    if (this.ffmpeg && !this.ffmpeg.killed) killChild(this.ffmpeg);
    this.ffmpeg = null;
  }
}
