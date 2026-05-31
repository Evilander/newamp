// Eviland canvas recorder.
//
// Wraps `HTMLCanvasElement.captureStream` + `MediaRecorder` into a tiny
// lifecycle helper that produces a WebM Blob. The lead wires the save dialog
// and Electron IPC; this module is pure browser API and has no React, no
// electron, no NewAmp engine imports — it can be lifted into @eviland/core
// unchanged.
//
// Mime fallback chain (probed via MediaRecorder.isTypeSupported):
//   1. video/webm;codecs=vp9,opus    (preferred — best quality / size)
//   2. video/webm;codecs=vp8,opus    (older Chromium, ffmpeg-friendly)
//   3. video/webm                    (UA picks codecs)
// The caller can override with `opts.preferredMimeType` (we still validate it
// before use). AV1 is intentionally omitted — Chromium's AV1 live-encode path
// is patchy and very CPU-heavy.
//
// Audio is OPTIONAL and supplied at start() as a MediaStream so the recorder
// stays decoupled from any AudioContext. Typical wiring on the caller side:
//   const dest = ctx.createMediaStreamDestination();
//   sourceNode.connect(dest); // PARALLEL — does NOT touch the speaker chain
//   recorder.start(dest.stream);
//
// ES modules only. Zero deps. No allocations during steady-state recording
// beyond the chunks the recorder itself emits.

/** Recorder construction options. All optional with sensible defaults. */
export interface CanvasRecorderOptions {
  /** Video frame rate hint for canvas.captureStream(). 30 or 60. Default 60. */
  fps?: number;
  /** Video bitrate hint passed to MediaRecorder. Default 12 Mbps. */
  videoBitsPerSecond?: number;
  /** Audio bitrate hint passed to MediaRecorder. Default 192 kbps. */
  audioBitsPerSecond?: number;
  /**
   * Override the preferred mime type. Probed first; if unsupported the
   * recorder falls back through the built-in chain. Use this when the lead
   * exposes a quality preset in the UI.
   */
  preferredMimeType?: string;
  /**
   * `MediaRecorder.start(timeslice)` value in milliseconds. Smaller values
   * mean more `dataavailable` events (good for chunked-write IPC) but slightly
   * higher overhead. Default 1000 ms.
   */
  timesliceMs?: number;
}

/** The handle returned by `createCanvasRecorder`. */
export interface CanvasRecorder {
  /**
   * Start recording. If `audioStream` is provided, its first audio track is
   * muxed alongside the canvas video. Resolves immediately (synchronous from
   * the caller's perspective — MediaRecorder.start is sync).
   *
   * Throws `CanvasRecorderError` if already recording, if the canvas cannot
   * produce a video track, or if no compatible mime type is supported.
   */
  start: (audioStream?: MediaStream) => void;
  /**
   * Stop recording. Resolves with the final WebM Blob once MediaRecorder has
   * flushed its last chunk. Idempotent: calling stop() while not recording
   * resolves with an empty Blob of the recorder's mime type.
   */
  stop: () => Promise<Blob>;
  /** True while MediaRecorder.state === 'recording' or 'paused'. */
  isRecording: () => boolean;
  /**
   * The mime type that will be (or was) used. Populated at construction time
   * after the probe chain runs; safe to read before start().
   */
  readonly mimeType: string;
}

/** Reason recorder construction or start failed. */
export type CanvasRecorderErrorCode =
  | 'unsupported'         // MediaRecorder or canvas.captureStream missing
  | 'no-mime'             // none of the probe-chain mimes are supported
  | 'capture-failed'      // canvas.captureStream() threw or returned no video track
  | 'no-audio-track'      // audioStream supplied but had no audio tracks
  | 'already-recording'   // start() called while a take is in progress
  | 'recorder-error'      // MediaRecorder fired onerror mid-take
  | 'unknown';

/** Typed error for recorder failures. */
export class CanvasRecorderError extends Error {
  readonly code: CanvasRecorderErrorCode;
  override readonly cause?: unknown;

  constructor(code: CanvasRecorderErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'CanvasRecorderError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

const PREFERRED_MIMES: readonly string[] = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function isMediaRecorderSupported(): boolean {
  return typeof MediaRecorder !== 'undefined'
    && typeof MediaRecorder.isTypeSupported === 'function';
}

function pickMime(preferred?: string): string {
  if (!isMediaRecorderSupported()) {
    throw new CanvasRecorderError('unsupported', 'MediaRecorder is not available in this environment.');
  }
  const candidates: string[] = [];
  if (preferred && preferred.length > 0) candidates.push(preferred);
  for (const m of PREFERRED_MIMES) candidates.push(m);
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      // Some hosts throw on malformed type strings — ignore and continue.
    }
  }
  throw new CanvasRecorderError('no-mime', 'No supported MediaRecorder mime type (need at minimum video/webm).');
}

function baseMime(full: string): string {
  // 'video/webm;codecs=vp9,opus' -> 'video/webm'
  const semi = full.indexOf(';');
  return semi >= 0 ? full.slice(0, semi).trim() : full;
}

/**
 * Build a canvas recorder. The recorder is in a stopped state until you call
 * `start()`. The mime type is selected at construction time so the caller can
 * surface it in the UI (e.g. "Recording — vp9").
 */
export function createCanvasRecorder(
  canvas: HTMLCanvasElement,
  opts: CanvasRecorderOptions = {},
): CanvasRecorder {
  if (typeof canvas.captureStream !== 'function') {
    throw new CanvasRecorderError(
      'unsupported',
      'HTMLCanvasElement.captureStream is not available in this environment.',
    );
  }

  const fps = typeof opts.fps === 'number' && opts.fps > 0 ? opts.fps : 60;
  const videoBitsPerSecond = typeof opts.videoBitsPerSecond === 'number' && opts.videoBitsPerSecond > 0
    ? opts.videoBitsPerSecond
    : 12_000_000;
  const audioBitsPerSecond = typeof opts.audioBitsPerSecond === 'number' && opts.audioBitsPerSecond > 0
    ? opts.audioBitsPerSecond
    : 192_000;
  const timesliceMs = typeof opts.timesliceMs === 'number' && opts.timesliceMs > 0
    ? opts.timesliceMs
    : 1000;

  const mimeType = pickMime(opts.preferredMimeType);

  // Per-take state. Reset on every start() so the recorder is reusable.
  let recorder: MediaRecorder | null = null;
  let captureStream: MediaStream | null = null;
  let videoTrack: MediaStreamTrack | null = null;
  let audioTrack: MediaStreamTrack | null = null;
  let suppliedAudioStream: MediaStream | null = null;
  let chunks: BlobPart[] = [];
  let stopPromise: Promise<Blob> | null = null;
  let stopResolve: ((blob: Blob) => void) | null = null;
  let stopReject: ((err: unknown) => void) | null = null;
  let recording = false;

  const teardownTracks = (): void => {
    if (videoTrack) {
      try { videoTrack.stop(); } catch { /* noop */ }
      videoTrack = null;
    }
    if (audioTrack && suppliedAudioStream) {
      // Do NOT stop tracks we did not own — they belong to the caller's
      // MediaStreamAudioDestinationNode, which the caller will tear down.
      audioTrack = null;
    }
    captureStream = null;
    suppliedAudioStream = null;
  };

  const start = (audioStream?: MediaStream): void => {
    if (recording) {
      throw new CanvasRecorderError('already-recording', 'Recorder is already running. Call stop() first.');
    }

    // Build the capture stream fresh each take. captureStream() can return a
    // stream with no video tracks if the canvas hasn't been painted yet —
    // detect and surface that explicitly.
    let video: MediaStream;
    try {
      video = canvas.captureStream(fps);
    } catch (err) {
      throw new CanvasRecorderError('capture-failed', 'canvas.captureStream() threw.', err);
    }
    const videoTracks = video.getVideoTracks();
    if (videoTracks.length === 0) {
      throw new CanvasRecorderError('capture-failed', 'canvas.captureStream() returned no video tracks.');
    }
    const vTrack = videoTracks[0];
    if (!vTrack) {
      throw new CanvasRecorderError('capture-failed', 'canvas.captureStream() returned an empty video track slot.');
    }

    const tracks: MediaStreamTrack[] = [vTrack];
    let aTrack: MediaStreamTrack | null = null;
    if (audioStream) {
      const aTracks = audioStream.getAudioTracks();
      if (aTracks.length === 0) {
        try { vTrack.stop(); } catch { /* noop */ }
        throw new CanvasRecorderError('no-audio-track', 'Provided audioStream has no audio tracks.');
      }
      const candidate = aTracks[0];
      if (candidate) {
        aTrack = candidate;
        tracks.push(candidate);
      }
    }

    const muxed = new MediaStream(tracks);

    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(muxed, {
        mimeType,
        videoBitsPerSecond,
        audioBitsPerSecond,
      });
    } catch (err) {
      try { vTrack.stop(); } catch { /* noop */ }
      throw new CanvasRecorderError('unknown', 'Failed to construct MediaRecorder.', err);
    }

    // Wire state. Promise + resolver are set up BEFORE start() so a stop()
    // racing right after start() always has somewhere to resolve to.
    chunks = [];
    stopPromise = new Promise<Blob>((resolve, reject) => {
      stopResolve = resolve;
      stopReject = reject;
    });

    rec.ondataavailable = (event): void => {
      const data = event.data;
      if (data && data.size > 0) chunks.push(data);
    };

    rec.onerror = (event): void => {
      const inner = (event as unknown as { error?: unknown }).error;
      const err = new CanvasRecorderError(
        'recorder-error',
        'MediaRecorder reported an error.',
        inner ?? event,
      );
      recording = false;
      try { rec.stop(); } catch { /* noop */ }
      teardownTracks();
      if (stopReject) {
        const reject = stopReject;
        stopResolve = null;
        stopReject = null;
        reject(err);
      }
    };

    rec.onstop = (): void => {
      recording = false;
      const blob = new Blob(chunks, { type: baseMime(mimeType) });
      chunks = [];
      teardownTracks();
      if (stopResolve) {
        const resolve = stopResolve;
        stopResolve = null;
        stopReject = null;
        resolve(blob);
      }
    };

    // Commit refs.
    recorder = rec;
    captureStream = video;
    videoTrack = vTrack;
    audioTrack = aTrack;
    suppliedAudioStream = audioStream ?? null;
    recording = true;

    try {
      rec.start(timesliceMs);
    } catch (err) {
      recording = false;
      teardownTracks();
      recorder = null;
      const reject = stopReject;
      stopResolve = null;
      stopReject = null;
      stopPromise = null;
      if (reject) reject(err);
      throw new CanvasRecorderError('unknown', 'MediaRecorder.start() threw.', err);
    }
  };

  const stop = (): Promise<Blob> => {
    if (!recording || !recorder) {
      // Nothing to flush — return an empty Blob in the right mime so callers
      // can branch on size without null checks.
      return Promise.resolve(new Blob([], { type: baseMime(mimeType) }));
    }
    const pending = stopPromise ?? Promise.resolve(new Blob([], { type: baseMime(mimeType) }));
    try {
      // MediaRecorder.stop() triggers a final ondataavailable then onstop.
      if (recorder.state !== 'inactive') recorder.stop();
    } catch (err) {
      const reject = stopReject;
      stopResolve = null;
      stopReject = null;
      stopPromise = null;
      recording = false;
      teardownTracks();
      if (reject) reject(err);
      return Promise.reject(new CanvasRecorderError('unknown', 'MediaRecorder.stop() threw.', err));
    }
    return pending;
  };

  const isRecording = (): boolean => recording;

  // Suppress unused-warning for captureStream binding (it's intentionally kept
  // alive so the video track stays open for the duration of the take).
  void captureStream;

  return {
    start,
    stop,
    isRecording,
    mimeType,
  };
}
