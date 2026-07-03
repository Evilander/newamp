// WebM → MP4 finishing step for share exports (Clip Studio, Wrapped Live).
//
// The renderer's WebCodecs/MediaRecorder captures are VP9/Opus WebM — the
// only encode stack stock Electron ships. Sharing targets (TikTok upload,
// mobile Discord, iMessage) want MP4 H.264/AAC, so the main process finishes
// clips with the bundled ffmpeg: NVENC hardware encode when the GPU offers
// it, libx264 otherwise. The fallback is automatic — NVENC failure re-runs
// with the software encoder rather than surfacing an error.

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFfmpegPath, runFfmpeg } from './transcode.js';

export interface Mp4FinishOptions {
  /** Crop the center to 9:16 for vertical/shorts formats. */
  vertical?: boolean;
  /** Cap output height (e.g. 1080). Applied after crop. */
  maxHeight?: number;
}

function buildArgs(input: string, output: string, encoder: 'h264_nvenc' | 'libx264', opts: Mp4FinishOptions): string[] {
  const filters: string[] = [];
  if (opts.vertical) filters.push('crop=ih*9/16:ih');
  if (opts.maxHeight) filters.push(`scale=-2:'min(${opts.maxHeight},ih)'`);
  // yuv420p + faststart are the compatibility handshake: every consumer
  // (QuickTime included) decodes 4:2:0, and moov-up-front makes streaming
  // previews start instantly.
  const quality = encoder === 'h264_nvenc'
    ? ['-preset', 'p5', '-rc', 'vbr', '-cq', '19', '-b:v', '0']
    : ['-preset', 'fast', '-crf', '18'];
  return [
    '-y',
    '-i', input,
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    '-c:v', encoder,
    ...quality,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    output,
  ];
}

/**
 * Encode a WebM buffer to an MP4 file at outputPath. Tries NVENC first,
 * falls back to libx264. Throws with ffmpeg's stderr tail on total failure.
 */
export async function finishWebmToMp4(
  webm: Buffer,
  outputPath: string,
  opts: Mp4FinishOptions = {},
): Promise<void> {
  const ffmpeg = resolveFfmpegPath();
  const workDir = join(tmpdir(), 'newamp-clips');
  await mkdir(workDir, { recursive: true });
  const inputPath = join(workDir, `${randomUUID()}.webm`);
  await writeFile(inputPath, webm);
  try {
    try {
      await runFfmpeg(buildArgs(inputPath, outputPath, 'h264_nvenc', opts), ffmpeg);
    } catch {
      await runFfmpeg(buildArgs(inputPath, outputPath, 'libx264', opts), ffmpeg);
    }
  } finally {
    await rm(inputPath, { force: true }).catch(() => undefined);
  }
}
