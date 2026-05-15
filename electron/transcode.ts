import ffmpegStaticImport from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import { Readable } from 'node:stream';

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

function resolveFfmpegPath(): string {
  const candidate = process.env.NEWAMP_FFMPEG_PATH || ffmpegStatic || 'ffmpeg';
  return candidate.includes('app.asar')
    ? candidate.replace('app.asar', 'app.asar.unpacked')
    : candidate;
}
