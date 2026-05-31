// Live audio input via getUserMedia.
//
// MUSIC-GRADE constraints only: echoCancellation, autoGainControl, and
// noiseSuppression are ALWAYS false. The voice DSP that browsers apply by
// default (AGC pumps, noise gate eats sustain, AEC notches the spectrum)
// destroys music — so we explicitly disable them for every capture.
//
// This module is dependency-injected with an AudioContext (we never import
// the NewAmp engine, never construct an AudioContext) so it stays trivially
// testable, framework-free, and reusable from any renderer that owns a graph.
// Errors are surfaced as typed `LiveInputError` so callers can render real
// user-facing messages instead of catching opaque DOMExceptions.
//
// ES modules only. Zero deps.

/** A single enumerable audio input device. */
export interface AudioInputDevice {
  /** Opaque MediaDevices ID. Stable per-origin + per-session in Chromium. */
  deviceId: string;
  /**
   * Human label, e.g. "Focusrite Scarlett 2i2 USB (Input 1)". Empty until the
   * user has granted microphone permission at least once. Callers may show a
   * fallback like "Audio input" when this is "".
   */
  label: string;
}

/** Result of `createLiveInput` — caller owns the lifecycle. */
export interface LiveInputHandle {
  /** The Web Audio source node, ready to .connect() into the caller's graph. */
  source: MediaStreamAudioSourceNode;
  /** The underlying MediaStream (so callers can mux video, snapshot tracks, etc.). */
  stream: MediaStream;
  /**
   * Disconnect the source node, stop every track on the stream, and release
   * the device. Idempotent — safe to call more than once.
   */
  stop: () => void;
}

/** Reason an input call failed. Maps DOMException names + our own pre-checks. */
export type LiveInputErrorCode =
  | 'unsupported'        // navigator.mediaDevices.getUserMedia missing entirely
  | 'permission-denied'  // NotAllowedError / SecurityError
  | 'no-device'          // NotFoundError, or the picked deviceId no longer exists
  | 'device-busy'        // NotReadableError (driver in use by another app)
  | 'overconstrained'    // OverconstrainedError (rare with our minimal constraints)
  | 'no-audio-track'     // getUserMedia returned a stream with zero audio tracks
  | 'aborted'            // AbortError
  | 'unknown';           // any other failure

/** Typed wrapper around the variety of failures `getUserMedia` can raise. */
export class LiveInputError extends Error {
  readonly code: LiveInputErrorCode;
  readonly cause?: unknown;

  constructor(code: LiveInputErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'LiveInputError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function hasMediaDevices(): boolean {
  return typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices !== 'undefined'
    && typeof navigator.mediaDevices.getUserMedia === 'function'
    && typeof navigator.mediaDevices.enumerateDevices === 'function';
}

function toLiveInputError(err: unknown): LiveInputError {
  if (err instanceof LiveInputError) return err;
  const name = (err as { name?: string } | null)?.name ?? '';
  const message = (err as { message?: string } | null)?.message ?? String(err);
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new LiveInputError('permission-denied', 'Audio input permission was denied.', err);
    case 'NotFoundError':
      return new LiveInputError('no-device', 'No matching audio input device was found.', err);
    case 'NotReadableError':
      return new LiveInputError('device-busy', 'Audio input device is in use by another application.', err);
    case 'OverconstrainedError':
      return new LiveInputError('overconstrained', 'Audio input constraints could not be satisfied.', err);
    case 'AbortError':
      return new LiveInputError('aborted', 'Audio input request was aborted.', err);
    default:
      return new LiveInputError('unknown', message || 'Failed to open audio input.', err);
  }
}

/**
 * Enumerate available audio input devices.
 *
 * Labels are empty strings until the user has granted microphone permission at
 * least once. We do NOT silently trigger a permission prompt here — the caller
 * decides when to ask (e.g. on a user click). If you need labels eagerly, call
 * `createLiveInput` once with the default device, then re-enumerate.
 *
 * Throws `LiveInputError('unsupported', ...)` if the host lacks `mediaDevices`.
 */
export async function enumerateAudioInputs(): Promise<AudioInputDevice[]> {
  if (!hasMediaDevices()) {
    throw new LiveInputError('unsupported', 'navigator.mediaDevices is not available in this environment.');
  }
  let devices: MediaDeviceInfo[];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    throw toLiveInputError(err);
  }
  const out: AudioInputDevice[] = [];
  for (const d of devices) {
    if (d.kind !== 'audioinput') continue;
    out.push({ deviceId: d.deviceId, label: d.label });
  }
  return out;
}

/**
 * Open a music-grade live audio input and bind it to the caller's AudioContext.
 *
 * Constraints are hard-coded to:
 *   echoCancellation: false, autoGainControl: false, noiseSuppression: false
 *
 * `deviceId` is passed as an `ideal` constraint so an unplugged-then-replugged
 * interface still acquires a reasonable fallback instead of failing outright.
 * If you need strictness (e.g. multi-interface studios), wrap this and supply
 * `{ exact: deviceId }` yourself.
 *
 * Caller MUST invoke `handle.stop()` when done. The returned `source` is NOT
 * pre-connected to anything — the caller's audio engine decides the routing.
 */
export async function createLiveInput(
  ctx: AudioContext,
  deviceId?: string,
): Promise<LiveInputHandle> {
  if (!hasMediaDevices()) {
    throw new LiveInputError('unsupported', 'navigator.mediaDevices is not available in this environment.');
  }

  const audio: MediaTrackConstraints = {
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: false,
  };
  if (typeof deviceId === 'string' && deviceId.length > 0) {
    audio.deviceId = { ideal: deviceId };
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch (err) {
    throw toLiveInputError(err);
  }

  const tracks = stream.getAudioTracks();
  if (tracks.length === 0) {
    for (const t of stream.getTracks()) {
      try { t.stop(); } catch { /* noop */ }
    }
    throw new LiveInputError('no-audio-track', 'Audio input stream contained no audio tracks.');
  }

  let source: MediaStreamAudioSourceNode;
  try {
    source = ctx.createMediaStreamSource(stream);
  } catch (err) {
    for (const t of stream.getTracks()) {
      try { t.stop(); } catch { /* noop */ }
    }
    throw toLiveInputError(err);
  }

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try { source.disconnect(); } catch { /* not connected */ }
    for (const t of stream.getTracks()) {
      try { t.stop(); } catch { /* noop */ }
    }
  };

  return { source, stream, stop };
}
