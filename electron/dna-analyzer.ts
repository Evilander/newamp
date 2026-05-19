import ffmpegStaticImport from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  AUDIO_DNA_MAX_SECONDS,
  AUDIO_DNA_TARGET_SAMPLE_RATE,
  computeTrackDna,
  pcmFromInt16,
  type TrackDna,
} from '../shared/audio-dna.js';

const ffmpegStatic = ffmpegStaticImport as unknown as string | null;

export async function analyzeTrackDna(inputPath: string, opts?: { maxSeconds?: number }): Promise<TrackDna> {
  if (!inputPath) throw new Error('analyzeTrackDna requires an input path.');
  const maxSeconds = opts?.maxSeconds ?? AUDIO_DNA_MAX_SECONDS;
  const buffer = await decodeMonoPcm(inputPath, maxSeconds);
  const samples = pcmFromInt16(buffer);
  return computeTrackDna(samples, {
    sampleRate: AUDIO_DNA_TARGET_SAMPLE_RATE,
    maxSeconds,
  });
}

function decodeMonoPcm(inputPath: string, maxSeconds: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = resolveFfmpegPath();
    const child = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-i',
        inputPath,
        '-t',
        String(maxSeconds),
        '-vn',
        '-map',
        '0:a:0',
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        '-ac',
        '1',
        '-ar',
        String(AUDIO_DNA_TARGET_SAMPLE_RATE),
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg dna decode exited ${code ?? 'unknown'}${stderr ? `\n${stderr}` : ''}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

function resolveFfmpegPath(): string {
  if (process.env.NEWAMP_FFMPEG_PATH) return process.env.NEWAMP_FFMPEG_PATH;
  const staticCandidate = ffmpegStatic?.includes('app.asar')
    ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
    : ffmpegStatic;
  return staticCandidate && existsSync(staticCandidate) ? staticCandidate : 'ffmpeg';
}
