// One decode, every analyzer.
//
// The library-wide analysis (electron/analysis-queue.ts) wants a track's
// loudness, tempo, key, Audio DNA and seek-bar waveform. Each of those used to
// be its own ffmpeg run over the same file; here one run feeds all of them:
//
//   - loudness is measured by ffmpeg's EBU R128 filter on the file as it is
//     (its own rate and channels), on a second branch of the same filter graph
//   - the other branch is mono PCM at 22.05 kHz, the rate the DNA and the song
//     score were built for. The waveform folds it as it streams in; the first
//     two minutes are kept for the DNA (first minute) and the tempo and key
//     (a 90 s excerpt), which run on this thread in short slices.
//
// Only what a track still lacks is asked for, so a track that has everything
// but a key costs one decode and a 90 s excerpt, not the whole set.
//
// Read-only: ffmpeg opens the file for reading and nothing is written beside it.
// A track longer than 20 minutes is analysed on its first 20 minutes, which is
// enough for tempo, key and DNA but not for loudness: that is left unmeasured
// rather than stored as the whole track's.

import { spawn, type ChildProcess } from 'node:child_process';
import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { constants as osConstants, setPriority } from 'node:os';
import {
  AUDIO_DNA_MAX_SECONDS,
  AUDIO_DNA_TARGET_SAMPLE_RATE,
  computeTrackDnaYielding,
  pcmFromInt16,
  type TrackDna,
} from '../shared/audio-dna.js';
import {
  AnalysisAbortedError,
  AnalysisCrashedError,
  AnalysisEnvironmentError,
  AnalysisReadFailedError,
  AnalysisTimedOutError,
  AnalysisUnavailableError,
  MIN_TRUSTED_BEAT_CONFIDENCE,
  MIN_TRUSTED_KEY_CONFIDENCE,
  keyName,
} from '../shared/analysis.js';
import { SONG_SCORE_SAMPLE_RATE, computeSongScore, type SongScore } from '../src/visualizer/eviland-score.js';
import { killChild } from './kill-child.js';
import {
  REPLAYGAIN_TARGET_LUFS,
  awaitChildExit,
  normalizeReplayGainDb,
  parseEbur128IntegratedLufs,
  resolveFfmpegPath,
  watchFfmpegInput,
} from './transcode.js';
import { watchReadFailures } from './read-failure.js';
import { PeakReducer, storeAnalysedWaveform } from './waveform-peaks.js';

// One PCM stream feeds both, so they must agree on the rate.
const SAMPLE_RATE = AUDIO_DNA_TARGET_SAMPLE_RATE;
if (SAMPLE_RATE !== SONG_SCORE_SAMPLE_RATE) throw new Error('DNA and song score sample rates differ.');

/** Longest stretch of one track that is read. */
export const MAX_ANALYSIS_SECONDS = 20 * 60;
// The excerpt the tempo and key are read from: 90 s starting 30 s in (past a
// slow intro), or the whole track when it is shorter than that.
const TEMPO_EXCERPT_START_SECONDS = 30;
const TEMPO_EXCERPT_SECONDS = 90;
// Kept from the front of the stream: enough for the DNA minute and the excerpt.
const HEAD_SECONDS = TEMPO_EXCERPT_START_SECONDS + TEMPO_EXCERPT_SECONDS;
// A head this long means the track runs past the start of the excerpt.
const TEMPO_MIN_HEAD_SAMPLES = HEAD_SECONDS * SAMPLE_RATE;
// Below this the loudness filter is measuring silence, not music.
const SILENCE_LUFS = -60;
// Same watchdog reasoning as the other ffmpeg runs: a malformed source can stall
// demux forever. It watches for progress, not the clock: a big lossless file on
// a slow share takes minutes and is fine as long as bytes keep arriving.
const FFMPEG_IDLE_TIMEOUT_MS = 60_000;
// A killed ffmpeg is waited for this long, so the next decode does not start while it still reads the share.
const FFMPEG_EXIT_WAIT_MS = 2500;
// A stat on a share that stopped answering never returns; the queue gives up on it after this.
const STAT_TIMEOUT_MS = 10_000;

export interface AnalysisWanted {
  loud: boolean;
  /** Tempo and key come from one pass; either one wanted runs it. */
  tempo: boolean;
  dna: boolean;
  peaks: boolean;
}

export interface TrackAnalysisRequest {
  path: string;
  want: AnalysisWanted;
  /** Stops the decode; the call rejects with an AnalysisAbortedError. */
  signal?: AbortSignal;
  /** Awaited between slices of work on this thread. */
  pause?: () => Promise<void>;
}

export interface TrackAnalysisResult {
  /** Seconds of the track that were decoded. */
  seconds: number;
  /** Present when loudness was asked for and could be measured. */
  loudness: { integratedLufs: number; replayGainTrackDb: number } | null;
  /** Present when the tempo pass ran; either member is null when it is not trusted. */
  tempo: { bpm: number | null; key: string | null } | null;
  dna: TrackDna | null;
  /** True when a waveform was added to the seek-bar cache. */
  peaksStored: boolean;
}

const liveAnalysisFfmpeg = new Set<ChildProcess>();

export function killAllAnalysisFfmpeg(): void {
  for (const child of liveAnalysisFfmpeg) killChild(child);
}

/** ffmpeg processes the analysis has running (at most one). */
export function activeAnalysisDecodes(): number {
  return liveAnalysisFfmpeg.size;
}

// The libuv thread a stat is blocked on is not freed by giving up on it, so
// while one is still hanging no more are started: a dead mount costs one thread, not the pool.
let hungStats = 0;

/** stat() for the background analysis, which must not wait for ever on a share that stopped answering. */
export async function statWithin(path: string, ms = STAT_TIMEOUT_MS, read: (path: string) => Promise<Stats> = stat): Promise<Stats> {
  if (hungStats > 0) throw new AnalysisUnavailableError(path, new Error('an earlier stat is still waiting on the drive'));
  const pending = read(path);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      hungStats += 1;
      void pending.then(() => undefined, () => undefined).then(() => {
        hungStats -= 1;
      });
      reject(new AnalysisUnavailableError(path, new Error(`no answer from the drive in ${ms / 1000} s`)));
    }, ms);
  });
  try {
    return await Promise.race([pending, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export async function analyzeTrack(request: TrackAnalysisRequest): Promise<TrackAnalysisResult> {
  const { path, want, signal } = request;
  if (!path) throw new Error('analyzeTrack requires an input path.');
  if (!want.loud && !want.tempo && !want.dna && !want.peaks) {
    return { seconds: 0, loudness: null, tempo: null, dna: null, peaksStored: false };
  }
  if (signal?.aborted) throw new AnalysisAbortedError();
  let info;
  try {
    info = await statWithin(path);
  } catch (err) {
    throw err instanceof AnalysisUnavailableError ? err : new AnalysisUnavailableError(path, err);
  }
  const pause = request.pause ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const decoded = await decode(path, want, signal);
  if (signal?.aborted) throw new AnalysisAbortedError();

  let loudness: TrackAnalysisResult['loudness'] = null;
  // A decode that ran into the cap heard only the start of a long track.
  if (want.loud && decoded.seconds < MAX_ANALYSIS_SECONDS - 0.5) {
    try {
      const integratedLufs = parseEbur128IntegratedLufs(decoded.stderr);
      if (integratedLufs > SILENCE_LUFS) {
        loudness = { integratedLufs, replayGainTrackDb: normalizeReplayGainDb(REPLAYGAIN_TARGET_LUFS - integratedLufs) };
      }
    } catch {
      /* no loudness in the output: a file with no audible signal */
    }
  }

  let dna: TrackDna | null = null;
  let tempo: TrackAnalysisResult['tempo'] = null;
  let peaksStored = false;
  const head = decoded.head;
  if (head && head.length) {
    if (want.dna) {
      const front = head.subarray(0, Math.floor(AUDIO_DNA_MAX_SECONDS * SAMPLE_RATE));
      const vector = await computeTrackDnaYielding(front, {
        sampleRate: SAMPLE_RATE,
        maxSeconds: AUDIO_DNA_MAX_SECONDS,
        pause,
      });
      dna = vector.framesAnalyzed > 0 ? roundDna(vector) : null;
      if (signal?.aborted) throw new AnalysisAbortedError();
    }
    if (want.tempo) {
      tempo = await readTempo(head, pause);
      if (signal?.aborted) throw new AnalysisAbortedError();
    }
  }
  if (want.peaks && decoded.reducer && decoded.seconds < MAX_ANALYSIS_SECONDS - 0.5) {
    const waveform = decoded.reducer.finish(SAMPLE_RATE);
    if (waveform) {
      await storeAnalysedWaveform({ path, size: info.size, mtimeMs: info.mtimeMs }, waveform);
      peaksStored = true;
    }
  }
  return { seconds: decoded.seconds, loudness, tempo, dna, peaksStored };
}

/** The tempo and key worth keeping from a song score: a guess is stored as unknown. */
export function trustedTempo(score: SongScore | null): { bpm: number | null; key: string | null } {
  if (!score) return { bpm: null, key: null };
  const bpm =
    Number.isFinite(score.bpm) && score.bpm > 0 && score.beatConfidence >= MIN_TRUSTED_BEAT_CONFIDENCE
      ? Math.round(score.bpm * 10) / 10
      : null;
  const home = score.homeKey;
  const key = home && home.confidence >= MIN_TRUSTED_KEY_CONFIDENCE ? keyName(home.tonic, home.minor) : null;
  return { bpm, key };
}

async function readTempo(
  head: Float32Array,
  pause: () => Promise<void>,
): Promise<{ bpm: number | null; key: string | null }> {
  // Judged from what was kept, not from the track's length: a decode that only
  // wanted the head stops there, and the result must not depend on which fields were owed.
  const from = head.length >= TEMPO_MIN_HEAD_SAMPLES ? TEMPO_EXCERPT_START_SECONDS : 0;
  const excerpt = head.subarray(from * SAMPLE_RATE, Math.min(head.length, (from + TEMPO_EXCERPT_SECONDS) * SAMPLE_RATE));
  const score = await computeSongScore(excerpt, { sampleRate: SAMPLE_RATE, pause });
  return trustedTempo(score);
}

// Four decimals are far finer than the cosine over eleven numbers can tell
// apart, and they keep the column about 40% smaller across a whole library.
function roundDna(dna: TrackDna): TrackDna {
  const r = (value: number): number => Math.round(value * 10_000) / 10_000;
  return {
    ...dna,
    rms: r(dna.rms),
    dynamicRange: r(dna.dynamicRange),
    brightness: r(dna.brightness),
    flatness: r(dna.flatness),
    bands: dna.bands.map(r),
    onsetDensity: r(dna.onsetDensity),
    rolloff: r(dna.rolloff),
  };
}

interface Decoded {
  seconds: number;
  /** The first HEAD_SECONDS as floats; null when no PCM was asked for. */
  head: Float32Array | null;
  reducer: PeakReducer | null;
  /** The tail of ffmpeg's log, where the loudness summary is. */
  stderr: string;
}

function ffmpegArgs(path: string, want: AnalysisWanted): string[] {
  const needPcm = want.tempo || want.dna || want.peaks;
  // Loudness and the waveform need the whole stretch; tempo, key and DNA only the head, and
  // reading more from a slow share just to discard it holds the drive for nothing.
  const seconds = want.loud || want.peaks ? MAX_ANALYSIS_SECONDS : HEAD_SECONDS;
  const args = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', want.loud ? 'info' : 'error', '-t', String(seconds), '-i', path];
  const pcmOut = ['-f', 's16le', 'pipe:1'];
  if (want.loud && needPcm) {
    // One decode, two branches: the loudness filter sees the file as it is,
    // the PCM is mixed down and resampled for the analyzers.
    args.push(
      '-filter_complex',
      `[0:a:0]asplit=2[loud][pcm];[loud]ebur128=framelog=quiet[lufs];[pcm]aformat=sample_fmts=s16:sample_rates=${SAMPLE_RATE}:channel_layouts=mono[mono]`,
      '-map', '[mono]', ...pcmOut,
      '-map', '[lufs]', '-f', 'null', '-',
    );
  } else if (want.loud) {
    // Nothing else uses stdout here, so ffmpeg's progress goes there: it is how a stalled read is told from a slow one.
    args.push('-progress', 'pipe:1', '-map', '0:a:0', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-');
  } else {
    args.push('-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), ...pcmOut);
  }
  return args;
}

function decode(path: string, want: AnalysisWanted, signal?: AbortSignal): Promise<Decoded> {
  return new Promise((resolve, reject) => {
    const needPcm = want.tempo || want.dna || want.peaks;
    const child = spawn(resolveFfmpegPath(), ffmpegArgs(path, want), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    liveAnalysisFfmpeg.add(child);
    // Counted as running until the process is gone, not until the decode is given up on.
    child.once('exit', () => liveAnalysisFfmpeg.delete(child));
    watchFfmpegInput(child, path);
    // Idle priority: it takes the cores nobody else wants.
    if (child.pid != null) {
      try {
        setPriority(child.pid, osConstants.priority.PRIORITY_LOW);
      } catch {
        /* it runs at normal priority */
      }
    }
    const reducer = want.peaks ? new PeakReducer() : null;
    const readFailed = watchReadFailures(child, path);
    const headBytes = HEAD_SECONDS * SAMPLE_RATE * 2;
    const headChunks: Buffer[] = [];
    let headLength = 0;
    let pcmBytes = 0;
    // How far into the file the loudness-only decode got, from ffmpeg's progress report.
    let progressMicros = 0;
    let progressPartial = '';
    let stderr = '';
    let settled = false;
    // Set when this module ended the decode (abort, no progress): the close that follows is its doing.
    let stopping: Error | null = null;
    let timer: NodeJS.Timeout | undefined;
    const settle = (err?: Error, result?: Decoded): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(result!);
    };
    // The decode is over when the process is: until then it still holds the file open and reads the share.
    const stop = (err: Error): void => {
      if (settled || stopping) return;
      stopping = err;
      clearTimeout(timer);
      killChild(child);
      void awaitChildExit(child, FFMPEG_EXIT_WAIT_MS).then(() => settle(err));
    };
    const onAbort = (): void => stop(new AnalysisAbortedError());
    const watch = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => stop(new AnalysisTimedOutError(path)), FFMPEG_IDLE_TIMEOUT_MS);
    };
    watch();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    if (needPcm) {
      child.stdout.on('data', (chunk: Buffer) => {
        if (!stopping) watch();
        pcmBytes += chunk.length;
        reducer?.push(chunk);
        if (headLength < headBytes) {
          const take = chunk.subarray(0, headBytes - headLength);
          // A copy: the reducer reads chunks in place and Node reuses their memory.
          headChunks.push(Buffer.from(take));
          headLength += take.length;
        }
      });
    } else {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (!stopping) watch();
        const lines = (progressPartial + chunk).split('\n');
        progressPartial = lines.pop()!;
        for (const line of lines) {
          const reported = /^out_time_us=(\d+)$/.exec(line);
          if (reported) progressMicros = Number(reported[1]);
        }
      });
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (!stopping) watch();
      stderr += chunk;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (err) => {
      // No exit event follows a process that never started.
      liveAnalysisFfmpeg.delete(child);
      settle(new AnalysisEnvironmentError(err));
    });
    child.on('close', (code, closeSignal) => {
      if (stopping) {
        settle(stopping);
        return;
      }
      // Killed by something else (a crash on the file, the system out of memory, a move to the Recycle
      // Bin that stops readers of the file): nothing is learned about the track, and it is not the queue's stop.
      if (code === null) {
        settle(new AnalysisCrashedError(path, closeSignal));
        return;
      }
      // Loudness, tempo and peaks from the part before a failed read would be kept as the whole track's.
      if (readFailed()) {
        settle(new AnalysisReadFailedError(path));
        return;
      }
      if (code !== 0) {
        settle(new Error(`ffmpeg exited ${code ?? 'unknown'} analysing ${path}${stderr ? `\n${stderr.slice(-600)}` : ''}`));
        return;
      }
      const seconds = needPcm ? pcmBytes / 2 / SAMPLE_RATE : progressMicros / 1e6;
      const head = needPcm ? pcmFromInt16(Buffer.concat(headChunks)) : null;
      settle(undefined, { seconds, head, reducer, stderr });
    });
  });
}
