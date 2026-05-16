import ffmpegStaticImport from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { Track, TrackWavBatchExportResult } from '../shared/types.js';

const REPLAYGAIN_TARGET_LUFS = -18;

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
      '-acodec',
      'pcm_s16le',
      '-ar',
      '48000',
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

export async function transcodeTrackToWavFile(inputPath: string, outputPath: string): Promise<{ path: string; bytes: number }> {
  if (!inputPath || !outputPath) throw new Error('Input and output paths are required.');
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
    '-f',
    'wav',
    '-acodec',
    'pcm_s16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-y',
    outputPath,
  ], ffmpeg);
  const info = await stat(outputPath);
  return { path: outputPath, bytes: info.size };
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

function resolveFfmpegPath(): string {
  const candidate = process.env.NEWAMP_FFMPEG_PATH || ffmpegStatic || 'ffmpeg';
  return candidate.includes('app.asar')
    ? candidate.replace('app.asar', 'app.asar.unpacked')
    : candidate;
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

function batchWavFileName(track: Track, position: number, width: number): string {
  return `${String(position).padStart(width, '0')} - ${safeFileStem(trackLabel(track))}.wav`;
}

function trackLabel(track: Track): string {
  const title = track.title || basename(track.path, extname(track.path));
  const artist = track.artist && track.artist !== 'Unknown Artist' ? track.artist : 'Newamp';
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

function safeFileStem(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim() || 'Newamp Track';
}
