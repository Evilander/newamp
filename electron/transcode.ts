import ffmpegStaticImport from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import type {
  AudioExportFormat,
  Track,
  TrackAudioBatchExportResult,
  TrackWavBatchExportResult,
} from '../shared/types.js';

const REPLAYGAIN_TARGET_LUFS = -18;
const SUPPORTED_AUDIO_EXPORT_FORMATS = new Set<AudioExportFormat>(['wav', 'mp3', 'flac', 'opus']);

const CHROMIUM_NATIVE_EXTS = new Set([
  '.mp3',
  '.m4a',
  '.m4b',
  '.mp4',
  '.aac',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
]);

const FFMPEG_FALLBACK_EXTS = new Set([
  '.wma',
  '.alac',
  '.aiff',
  '.aif',
  '.dsf',
  '.dff',
  '.ape',
  '.wv',
  '.mpc',
  '.tta',
  '.mka',
  '.ac3',
  '.dts',
]);

const ffmpegStatic = ffmpegStaticImport as unknown as string | null;

export function playbackMode(filePath: string): 'native' | 'ffmpeg' {
  const ext = extname(filePath).toLowerCase();
  if (FFMPEG_FALLBACK_EXTS.has(ext)) return 'ffmpeg';
  if (CHROMIUM_NATIVE_EXTS.has(ext)) return 'native';
  return 'ffmpeg';
}

export function transcodeToWavResponse(filePath: string, request: Request): Response {
  const ffmpeg = resolveFfmpegPath();
  const ext = extname(filePath).toLowerCase();
  const isDsd = ext === '.dsf' || ext === '.dff';
  // Preserve source fidelity. The old path hardcoded `pcm_s16le -ar 48000`,
  // which irreversibly crushed 24/96 ALAC/AIFF/APE/WV down to 16-bit/48kHz on
  // every play. We now emit 32-bit float PCM — the only lossless PCM-in-WAV
  // format Chromium's <audio> actually decodes (24-bit int WAV is NOT
  // supported) — at the SOURCE sample rate (no forced -ar), so no bit-depth
  // truncation and no pre-resample before Chromium's own output stage.
  // DSD has no native browser path and ffmpeg's default DSD→PCM filter is
  // uncontrolled, so we pin a high-precision SoX resampler to a DSD-friendly
  // 88.2 kHz instead of leaving the modulator/decimation to chance.
  const codecArgs = isDsd
    ? ['-af', 'aresample=resampler=soxr:precision=28', '-ar', '88200', '-acodec', 'pcm_f32le']
    : ['-acodec', 'pcm_f32le'];
  const child = spawn(
    ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      filePath,
      '-map',
      '0:a:0',
      '-vn',
      '-f',
      'wav',
      ...codecArgs,
      // Keep a stereo fold — the deck graph + per-channel analysers are stereo,
      // and forcing 2ch is a no-op for the (overwhelmingly stereo) source set
      // while giving rare multichannel DTS/AC3 a sane downmix.
      '-ac',
      '2',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 6000) stderr = stderr.slice(-6000);
  });
  child.on('error', (err) => {
    console.error('[newamp] ffmpeg spawn failed:', err);
  });
  child.on('close', (code) => {
    if (code && code !== 0) {
      console.error(`[newamp] ffmpeg exited ${code} for ${filePath}\n${stderr}`);
    }
  });
  request.signal.addEventListener('abort', () => {
    if (!child.killed) child.kill();
  }, { once: true });

  const body = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'none',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Newamp-Playback': 'ffmpeg-transcode',
    },
  });
}

// Build the ffmpeg argument vector that transcodes an ffmpeg-mode source into a
// SEEKABLE, lossless FLAC FILE for the transcode cache (see transcode-cache.ts).
//
// Why FLAC-to-file instead of the live pcm_f32le WAV pipe: Chromium's <audio>
// can only seek a resource that is byte-range addressable with a known total
// size. The live pipe (transcodeToWavResponse) sends Accept-Ranges: none with no
// Content-Length, so scrubbing snaps to 0. A finalized FLAC file on disk has a
// real Content-Length and STREAMINFO total-samples, so net.fetch(file://) serves
// 206 Partial Content and seek works.
//
// Fidelity (verified by audiophile review):
//  - `-sample_fmt s32` preserves native bit depth up to 24-bit (the realistic
//    range for ALAC/AIFF/APE/WV/WMA-lossless): bitwise lossless. (A true 32-bit
//    source would encode 32-bit FLAC; if any such file fails to decode in
//    Chromium, drop this to s16/24-bit — not expected in practice.)
//  - No forced `-ar` outside DSD: source sample rate is preserved.
//  - DSD keeps the high-precision soxr→88.2 kHz step (no lossless DSD→PCM exists).
//  - `-ac 2` matches the stereo deck graph, downmixing rare multichannel sources.
export function buildPlaybackFlacArgs(inputPath: string, outputPath: string): string[] {
  const ext = extname(inputPath).toLowerCase();
  const isDsd = ext === '.dsf' || ext === '.dff';
  // compression_level 1 (not the default 5): FLAC is lossless at every level, so
  // the decoded samples are bit-identical — but level 1 encodes ~2-4x faster,
  // which directly cuts the first-play wait (the handler awaits the full encode).
  // Disk is cheap relative to the 8 GB LRU cap; encode wall-clock is what hurts.
  const codecArgs = isDsd
    ? ['-af', 'aresample=resampler=soxr:precision=28', '-ar', '88200', '-c:a', 'flac', '-compression_level', '1', '-sample_fmt', 's32']
    : ['-c:a', 'flac', '-compression_level', '1', '-sample_fmt', 's32'];
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-map',
    '0:a:0',
    '-vn',
    ...codecArgs,
    '-ac',
    '2',
    // Force the FLAC muxer explicitly: the cache writes to a per-job temp name
    // ending in `.part`, so ffmpeg cannot infer the format from the extension.
    '-f',
    'flac',
    '-y',
    outputPath,
  ];
}

export async function transcodeTrackToWavFile(inputPath: string, outputPath: string): Promise<{ path: string; bytes: number }> {
  const result = await transcodeTrackToAudioFile(inputPath, outputPath, 'wav');
  return { path: result.path, bytes: result.bytes };
}

export async function transcodeTracksToWavFolder(
  tracks: Track[],
  outputDir: string,
): Promise<TrackWavBatchExportResult> {
  if (!outputDir) throw new Error('Output folder is required.');
  await mkdir(outputDir, { recursive: true });

  const width = Math.max(2, String(Math.max(1, tracks.length)).length);
  const usedNames = new Set<string>();
  const files: TrackWavBatchExportResult['files'] = [];
  const skipped: string[] = [];
  let bytes = 0;

  for (const [index, track] of tracks.entries()) {
    try {
      const fileName = uniqueWavFileName(outputDir, batchWavFileName(track, index + 1, width), usedNames);
      const result = await transcodeTrackToWavFile(track.path, join(outputDir, fileName));
      files.push(result);
      bytes += result.bytes;
    } catch (err) {
      skipped.push(`${trackLabel(track)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    path: outputDir,
    exported: files.length,
    skipped,
    bytes,
    files,
  };
}

export async function transcodeTrackToAudioFile(
  inputPath: string,
  outputPath: string,
  format: AudioExportFormat,
): Promise<{ path: string; bytes: number; format: AudioExportFormat }> {
  if (!inputPath || !outputPath) throw new Error('Input and output paths are required.');
  const normalizedFormat = normalizeAudioExportFormat(format);
  const ffmpeg = resolveFfmpegPath();
  await runFfmpeg([
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-map',
    '0:a:0',
    '-vn',
    ...audioExportArgs(normalizedFormat),
    '-y',
    outputPath,
  ], ffmpeg);
  const info = await stat(outputPath);
  return { path: outputPath, bytes: info.size, format: normalizedFormat };
}

export async function transcodeTracksToAudioFolder(
  tracks: Track[],
  outputDir: string,
  format: AudioExportFormat,
): Promise<TrackAudioBatchExportResult> {
  if (!outputDir) throw new Error('Output folder is required.');
  const normalizedFormat = normalizeAudioExportFormat(format);
  await mkdir(outputDir, { recursive: true });

  const width = Math.max(2, String(Math.max(1, tracks.length)).length);
  const usedNames = new Set<string>();
  const files: TrackAudioBatchExportResult['files'] = [];
  const skipped: string[] = [];
  let bytes = 0;

  for (const [index, track] of tracks.entries()) {
    try {
      const fileName = uniqueAudioFileName(
        outputDir,
        batchAudioFileName(track, index + 1, width, normalizedFormat),
        normalizedFormat,
        usedNames,
      );
      const result = await transcodeTrackToAudioFile(
        track.path,
        join(outputDir, fileName),
        normalizedFormat,
      );
      files.push(result);
      bytes += result.bytes;
    } catch (err) {
      skipped.push(`${trackLabel(track)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    path: outputDir,
    exported: files.length,
    skipped,
    bytes,
    format: normalizedFormat,
    files,
  };
}

export async function analyzeTrackReplayGain(inputPath: string): Promise<{ replayGainTrackDb: number; integratedLufs: number }> {
  if (!inputPath) throw new Error('Input path is required.');
  const ffmpeg = resolveFfmpegPath();
  const stderr = await runFfmpegCapture([
    '-hide_banner',
    '-nostdin',
    '-i',
    inputPath,
    '-filter:a',
    'ebur128=peak=true',
    '-f',
    'null',
    '-',
  ], ffmpeg);
  const integratedLufs = parseEbur128IntegratedLufs(stderr);
  const replayGainTrackDb = normalizeReplayGainDb(REPLAYGAIN_TARGET_LUFS - integratedLufs);
  return { replayGainTrackDb, integratedLufs };
}

export function calculateAlbumReplayGainDb(
  analyses: Array<{ integratedLufs: number; duration?: number | null }>,
): number {
  let weightedEnergy = 0;
  let totalDuration = 0;
  for (const analysis of analyses) {
    if (!Number.isFinite(analysis.integratedLufs)) continue;
    const duration = analysis.duration && Number.isFinite(analysis.duration) && analysis.duration > 0
      ? analysis.duration
      : 1;
    weightedEnergy += duration * Math.pow(10, analysis.integratedLufs / 10);
    totalDuration += duration;
  }
  if (weightedEnergy <= 0 || totalDuration <= 0) {
    throw new Error('Album ReplayGain analysis did not produce finite loudness.');
  }
  const albumLufs = 10 * Math.log10(weightedEnergy / totalDuration);
  return normalizeReplayGainDb(REPLAYGAIN_TARGET_LUFS - albumLufs);
}

export function resolveFfmpegPath(): string {
  if (process.env.NEWAMP_FFMPEG_PATH) return process.env.NEWAMP_FFMPEG_PATH;
  const staticCandidate = ffmpegStatic?.includes('app.asar')
    ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
    : ffmpegStatic;
  return staticCandidate && existsSync(staticCandidate) ? staticCandidate : 'ffmpeg';
}

function runFfmpeg(args: string[], ffmpeg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code ?? 'unknown'}${stderr ? `\n${stderr}` : ''}`));
    });
  });
}

function runFfmpegCapture(args: string[], ffmpeg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 30000) stderr = stderr.slice(-30000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited ${code ?? 'unknown'}${stderr ? `\n${stderr}` : ''}`));
    });
  });
}

function parseEbur128IntegratedLufs(stderr: string): number {
  const matches = [...stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
  const last = matches[matches.length - 1];
  const value = last ? Number(last[1]) : NaN;
  if (!Number.isFinite(value)) throw new Error('ffmpeg did not report integrated loudness.');
  return value;
}

function normalizeReplayGainDb(value: number): number {
  if (!Number.isFinite(value)) throw new Error('ReplayGain analysis did not produce a finite value.');
  return Math.max(-30, Math.min(30, Number(value.toFixed(2))));
}

function normalizeAudioExportFormat(format: AudioExportFormat): AudioExportFormat {
  if (SUPPORTED_AUDIO_EXPORT_FORMATS.has(format)) return format;
  throw new Error(`Unsupported audio export format: ${String(format)}`);
}

function audioExportArgs(format: AudioExportFormat): string[] {
  if (format === 'wav') {
    // Preserve source fidelity on export too: 24-bit at the source sample rate
    // (no forced 16-bit/48k crush). 24-bit int WAV is the standard interchange
    // format for hi-res files written to disk (unlike the streaming-playback
    // path, which must use float because Chromium's <audio> won't decode 24-bit
    // int — here the file is for the user/other tools, not Chromium).
    return ['-f', 'wav', '-acodec', 'pcm_s24le', '-ac', '2'];
  }
  if (format === 'mp3') {
    return ['-codec:a', 'libmp3lame', '-b:a', '320k', '-ar', '48000', '-ac', '2'];
  }
  if (format === 'flac') {
    return ['-codec:a', 'flac', '-compression_level', '8'];
  }
  return ['-codec:a', 'libopus', '-b:a', '192k', '-vbr', 'on'];
}

function batchWavFileName(track: Track, position: number, width: number): string {
  return `${String(position).padStart(width, '0')} - ${safeFileStem(trackLabel(track))}.wav`;
}

function batchAudioFileName(
  track: Track,
  position: number,
  width: number,
  format: AudioExportFormat,
): string {
  return `${String(position).padStart(width, '0')} - ${safeFileStem(trackLabel(track))}.${format}`;
}

function trackLabel(track: Track): string {
  const title = track.title || basename(track.path, extname(track.path));
  const artist = track.artist && track.artist !== 'Unknown Artist' ? track.artist : 'NewAmp';
  return `${artist} - ${title}`;
}

function uniqueWavFileName(outputDir: string, fileName: string, usedNames: Set<string>): string {
  const ext = '.wav';
  const stem = fileName.toLowerCase().endsWith(ext) ? fileName.slice(0, -ext.length) : fileName;
  let candidate = `${stem}${ext}`;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase()) || existsSync(join(outputDir, candidate))) {
    candidate = `${stem} (${suffix})${ext}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function uniqueAudioFileName(
  outputDir: string,
  fileName: string,
  format: AudioExportFormat,
  usedNames: Set<string>,
): string {
  const ext = `.${format}`;
  const stem = fileName.toLowerCase().endsWith(ext) ? fileName.slice(0, -ext.length) : fileName;
  let candidate = `${stem}${ext}`;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase()) || existsSync(join(outputDir, candidate))) {
    candidate = `${stem} (${suffix})${ext}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function safeFileStem(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim() || 'NewAmp Track';
}
