// Eviland Replay — the retroactive clip ring ("save what just happened").
//
// ShadowPlay for your music: while armed, a WebCodecs VideoEncoder/AudioEncoder
// pair continuously encodes the composited Eviland Live canvas + engine audio
// into a bounded in-memory ring of encoded chunks (VP9/Opus — stock Electron
// ships no H.264/AAC WebCodecs encode). Pressing save muxes ONLY the retained
// window into a playable WebM via mediabunny, which the main process can then
// finish to MP4 with the bundled ffmpeg.
//
// Why not MediaRecorder? Dropping old timeslice chunks yields an unparseable
// file (later WebM clusters depend on the header/Tracks info in the first
// chunk — W3C mediacapture-record #178), and dual alternating recorders have
// audible/visible seams at every restart boundary. A chunk ring with
// KEYFRAME-ALIGNED eviction (never drop a delta frame's reference) is the
// pattern game DVRs use: ~20 MB steady memory for a 15 s 1080p window, one
// continuous hardware-preferred encode, zero seams.
//
// Failure posture: feature-detects WebCodecs + MediaStreamTrackProcessor and
// returns null when absent; a mid-flight encoder error disarms the ring and
// reports via stats() — it must never take the visualizer down.

import {
  Output,
  WebMOutputFormat,
  BufferTarget,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
  EncodedPacket,
} from 'mediabunny';

export interface ReplayRingOptions {
  /** How far back a save reaches. Default 15_000. */
  windowMs?: number;
  /** Capture/encode frame rate. Default 30 — plenty for share clips. */
  fps?: number;
  /** Video bitrate hint. Default 8 Mbps. */
  videoBitsPerSecond?: number;
  /** Parallel engine-audio tap (MediaStreamAudioDestinationNode.stream). */
  audioStream?: MediaStream;
  /** Forced keyframe cadence — bounds both eviction granularity and how much
   * more than windowMs the ring must retain. Default 2_000. */
  keyframeIntervalMs?: number;
}

export interface ReplayRingStats {
  armed: boolean;
  videoChunks: number;
  audioChunks: number;
  /** Milliseconds actually reachable right now (grows toward windowMs+key interval). */
  bufferedMs: number;
  droppedFrames: number;
  lastError: string | null;
}

export interface ReplayRing {
  arm(): void;
  disarm(): void;
  /** Mux the retained window to a playable WebM. Null when nothing is buffered. */
  saveClip(): Promise<Blob | null>;
  stats(): ReplayRingStats;
}

interface RingEntry {
  chunk: EncodedVideoChunk | EncodedAudioChunk;
  key: boolean;
  /** µs, from the encoder clock. */
  ts: number;
}

export function createReplayRing(
  canvas: HTMLCanvasElement,
  options: ReplayRingOptions = {},
): ReplayRing | null {
  if (
    typeof VideoEncoder === 'undefined' ||
    typeof MediaStreamTrackProcessor === 'undefined' ||
    typeof canvas.captureStream !== 'function'
  ) {
    return null;
  }

  const windowMs = options.windowMs ?? 15_000;
  const fps = options.fps ?? 30;
  const videoBitrate = options.videoBitsPerSecond ?? 8_000_000;
  const keyframeIntervalMs = options.keyframeIntervalMs ?? 2_000;
  const windowUs = windowMs * 1000;

  let armed = false;
  let lastError: string | null = null;
  let droppedFrames = 0;

  let videoRing: RingEntry[] = [];
  let audioRing: RingEntry[] = [];
  let videoDecoderConfig: VideoDecoderConfig | null = null;
  let audioDecoderConfig: AudioDecoderConfig | null = null;

  let stream: MediaStream | null = null;
  let videoEncoder: VideoEncoder | null = null;
  let audioEncoder: AudioEncoder | null = null;
  let videoReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  let audioReader: ReadableStreamDefaultReader<AudioData> | null = null;
  let configuredW = 0;
  let configuredH = 0;
  let lastKeyUs = -Infinity;

  const fail = (context: string, err: unknown): void => {
    lastError = `${context}: ${String((err as Error)?.message ?? err)}`;
    console.error('[eviland-replay]', lastError);
    disarm();
  };

  function evictVideo(): void {
    if (!videoRing.length) return;
    const newest = videoRing[videoRing.length - 1]!.ts;
    // Find the LATEST keyframe that still gives us a full window behind the
    // newest chunk, then drop everything before it — delta frames never lose
    // their reference.
    let cut = -1;
    for (let i = videoRing.length - 1; i >= 0; i--) {
      const entry = videoRing[i]!;
      if (entry.key && newest - entry.ts >= windowUs) {
        cut = i;
        break;
      }
    }
    if (cut > 0) videoRing = videoRing.slice(cut);
    // Audio follows the video window (opus packets are independent).
    const start = videoRing[0]?.ts ?? 0;
    if (audioRing.length && audioRing[0]!.ts < start) {
      audioRing = audioRing.filter((entry) => entry.ts >= start);
    }
  }

  let chosenConfig: VideoEncoderConfig | null = null;

  /**
   * Negotiate a supported encoder config via isConfigSupported — configure()
   * failures surface asynchronously through the error callback, so probing
   * first is the only reliable fallback path. VP9 level 4.1 covers 1080p60;
   * VP8 is the always-there safety net.
   */
  async function pickVideoConfig(width: number, height: number): Promise<VideoEncoderConfig> {
    const base: VideoEncoderConfig = {
      codec: 'vp09.00.41.08',
      width,
      height,
      bitrate: videoBitrate,
      framerate: fps,
      latencyMode: 'realtime',
    };
    const candidates: VideoEncoderConfig[] = [
      { ...base, hardwareAcceleration: 'prefer-hardware' },
      { ...base },
      { ...base, codec: 'vp8' },
    ];
    for (const candidate of candidates) {
      try {
        const support = await VideoEncoder.isConfigSupported(candidate);
        if (support.supported) return candidate;
      } catch {
        /* try the next candidate */
      }
    }
    throw new Error('no supported VideoEncoder config (VP9/VP8)');
  }

  function configureVideo(config: VideoEncoderConfig): void {
    chosenConfig = config;
    configuredW = config.width;
    configuredH = config.height;
    videoEncoder!.configure(config);
  }

  async function runVideoLoop(track: MediaStreamVideoTrack): Promise<void> {
    const processor = new MediaStreamTrackProcessor({ track });
    videoReader = processor.readable.getReader();
    const reader = videoReader;
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done || !armed) {
        frame?.close();
        break;
      }
      try {
        if (frame.codedWidth !== configuredW || frame.codedHeight !== configuredH) {
          // Dimension change (window resize) invalidates the stream — restart
          // the window rather than corrupt it. Reuse the negotiated codec.
          videoRing = [];
          audioRing = [];
          configureVideo({
            ...(chosenConfig as VideoEncoderConfig),
            width: frame.codedWidth,
            height: frame.codedHeight,
          });
          lastKeyUs = -Infinity;
        }
        if (videoEncoder!.encodeQueueSize > 4) {
          droppedFrames += 1;
        } else {
          const key = frame.timestamp - lastKeyUs >= keyframeIntervalMs * 1000;
          if (key) lastKeyUs = frame.timestamp;
          videoEncoder!.encode(frame, { keyFrame: key });
        }
      } catch (err) {
        frame.close();
        fail('video encode', err);
        return;
      }
      frame.close();
    }
  }

  async function runAudioLoop(track: MediaStreamAudioTrack): Promise<void> {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig) audioDecoderConfig = meta.decoderConfig;
        audioRing.push({ chunk, key: true, ts: chunk.timestamp });
      },
      error: (err) => fail('audio encoder', err),
    });
    const processor = new MediaStreamTrackProcessor({ track });
    audioReader = processor.readable.getReader();
    const reader = audioReader;
    let configured = false;
    for (;;) {
      const { value: data, done } = await reader.read();
      if (done || !armed) {
        data?.close();
        break;
      }
      try {
        if (!configured) {
          audioEncoder!.configure({
            codec: 'opus',
            sampleRate: data.sampleRate,
            numberOfChannels: data.numberOfChannels,
            bitrate: 128_000,
          });
          configured = true;
        }
        audioEncoder!.encode(data);
      } catch (err) {
        data.close();
        fail('audio encode', err);
        return;
      }
      data.close();
    }
  }

  function arm(): void {
    if (armed) return;
    armed = true;
    lastError = null;
    void (async () => {
      try {
        stream = canvas.captureStream(fps);
        const videoTrack = stream.getVideoTracks()[0] as MediaStreamVideoTrack | undefined;
        if (!videoTrack) throw new Error('canvas.captureStream produced no video track');
        const config = await pickVideoConfig(Math.max(2, canvas.width), Math.max(2, canvas.height));
        if (!armed) return; // disarmed while negotiating
        videoEncoder = new VideoEncoder({
          output: (chunk, meta) => {
            if (meta?.decoderConfig) videoDecoderConfig = meta.decoderConfig;
            videoRing.push({ chunk, key: chunk.type === 'key', ts: chunk.timestamp });
            evictVideo();
          },
          error: (err) => fail('video encoder', err),
        });
        configureVideo(config);
        void runVideoLoop(videoTrack).catch((err) => fail('video loop', err));
        const audioTrack = options.audioStream?.getAudioTracks()[0] as
          | MediaStreamAudioTrack
          | undefined;
        if (audioTrack) void runAudioLoop(audioTrack).catch((err) => fail('audio loop', err));
      } catch (err) {
        fail('arm', err);
      }
    })();
  }

  function disarm(): void {
    armed = false;
    try {
      void videoReader?.cancel().catch(() => undefined);
      void audioReader?.cancel().catch(() => undefined);
      for (const track of stream?.getTracks() ?? []) track.stop();
      videoEncoder?.close();
      audioEncoder?.close();
    } catch {
      /* teardown best-effort */
    }
    videoReader = null;
    audioReader = null;
    stream = null;
    videoEncoder = null;
    audioEncoder = null;
    videoRing = [];
    audioRing = [];
    videoDecoderConfig = null;
    audioDecoderConfig = null;
    lastKeyUs = -Infinity;
  }

  async function saveClip(): Promise<Blob | null> {
    // Snapshot so ongoing encoding can't mutate mid-mux. The window must
    // start on a keyframe; trim to the first key at or after (newest - window).
    const video = videoRing.slice();
    if (!video.length || !videoDecoderConfig) return null;
    const newest = video[video.length - 1]!.ts;
    let startIdx = 0;
    for (let i = 0; i < video.length; i++) {
      const entry = video[i]!;
      if (!entry.key) continue;
      if (newest - entry.ts <= windowUs) {
        startIdx = i;
        break;
      }
      startIdx = i; // latest key seen so far — best fallback
    }
    const retained = video.slice(startIdx);
    if (!retained.length || !retained[0]!.key) return null;
    const baseTs = retained[0]!.ts;
    const audio = audioRing.filter((entry) => entry.ts >= baseTs);

    const target = new BufferTarget();
    const output = new Output({ format: new WebMOutputFormat(), target });
    const videoSource = new EncodedVideoPacketSource('vp9');
    output.addVideoTrack(videoSource);
    let audioSource: EncodedAudioPacketSource | null = null;
    if (audio.length && audioDecoderConfig) {
      audioSource = new EncodedAudioPacketSource('opus');
      output.addAudioTrack(audioSource);
    }
    await output.start();

    const toPacket = (entry: RingEntry): EncodedPacket => {
      const bytes = new Uint8Array(entry.chunk.byteLength);
      entry.chunk.copyTo(bytes);
      return new EncodedPacket(
        bytes,
        entry.key ? 'key' : 'delta',
        (entry.ts - baseTs) / 1e6,
        (entry.chunk.duration ?? 1e6 / fps) / 1e6,
      );
    };

    // Interleave adds by timestamp — muxers want per-track monotonic input and
    // behave best with roughly interleaved tracks.
    let vi = 0;
    let ai = 0;
    let firstVideo = true;
    let firstAudio = true;
    while (vi < retained.length || ai < audio.length) {
      const nextVideo = vi < retained.length ? retained[vi]!.ts : Infinity;
      const nextAudio = ai < audio.length ? audio[ai]!.ts : Infinity;
      if (nextVideo <= nextAudio) {
        await videoSource.add(
          toPacket(retained[vi]!),
          firstVideo ? { decoderConfig: videoDecoderConfig } : undefined,
        );
        firstVideo = false;
        vi += 1;
      } else {
        await audioSource!.add(
          toPacket(audio[ai]!),
          firstAudio ? { decoderConfig: audioDecoderConfig! } : undefined,
        );
        firstAudio = false;
        ai += 1;
      }
    }

    await output.finalize();
    return target.buffer ? new Blob([target.buffer], { type: 'video/webm' }) : null;
  }

  return {
    arm,
    disarm,
    saveClip,
    stats() {
      const oldest = videoRing[0]?.ts;
      const newest = videoRing[videoRing.length - 1]?.ts;
      return {
        armed,
        videoChunks: videoRing.length,
        audioChunks: audioRing.length,
        bufferedMs: oldest !== undefined && newest !== undefined ? Math.round((newest - oldest) / 1000) : 0,
        droppedFrames,
        lastError,
      };
    },
  };
}
