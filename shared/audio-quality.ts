export type AudioQualityFamily = 'dsd' | 'lossless' | 'lossy' | 'container' | 'unknown';
export type AudioDecodePath = 'native' | 'ffmpeg-pcm-fallback';

export interface AudioQualityTrackInput {
  path: string;
  bitrate: number | null;
  sampleRate: number | null;
  duration?: number | null;
  size?: number | null;
  replayGainTrackDb?: number | null;
  replayGainAlbumDb?: number | null;
}

export interface AudioQualitySignal {
  ext: string;
  displayExt: string;
  family: AudioQualityFamily;
  decodePath: AudioDecodePath;
  label: string;
  isDsd: boolean;
  isLossless: boolean;
  isHiRes: boolean;
  isLowBitrate: boolean;
  hasReplayGain: boolean;
  densityBytesPerSecond: number | null;
  flags: string[];
}

export const DSD_EXTENSIONS = ['dsf', 'dff'] as const;

export const PCM_LOSSLESS_EXTENSIONS = [
  'flac',
  'wav',
  'aiff',
  'aif',
  'alac',
  'ape',
  'wv',
  'tta',
] as const;

export const LOSSY_EXTENSIONS = [
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'opus',
  'wma',
  'mpc',
  'ac3',
  'dts',
] as const;

export const CONTAINER_AUDIO_EXTENSIONS = ['mka'] as const;

export const FFMPEG_FALLBACK_EXTENSIONS = [
  'wma',
  'alac',
  'aiff',
  'aif',
  'dsf',
  'dff',
  'ape',
  'wv',
  'mpc',
  'tta',
  'mka',
  'ac3',
  'dts',
] as const;

const dsdSet = new Set<string>(DSD_EXTENSIONS);
const pcmLosslessSet = new Set<string>(PCM_LOSSLESS_EXTENSIONS);
const lossySet = new Set<string>(LOSSY_EXTENSIONS);
const containerSet = new Set<string>(CONTAINER_AUDIO_EXTENSIONS);
const ffmpegFallbackSet = new Set<string>(FFMPEG_FALLBACK_EXTENSIONS);

export function audioExtension(path: string): string {
  return path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? '';
}

export function isMusicServerStreamPath(path: string): boolean {
  try {
    const url = new URL(path);
    return url.protocol === 'newamp:' && url.hostname === 'server';
  } catch {
    return false;
  }
}

export function isFfmpegFallbackExtension(ext: string): boolean {
  return ffmpegFallbackSet.has(ext.toLowerCase().replace(/^\./, ''));
}

export function playbackCodecLabel(path: string): string {
  const ext = audioExtension(path);
  if (!ext) return 'AUDIO';
  const display = ext.toUpperCase();
  return isFfmpegFallbackExtension(ext) && !isMusicServerStreamPath(path) ? `${display}->WAV` : display;
}

export function classifyAudioQuality(track: AudioQualityTrackInput): AudioQualitySignal {
  const ext = audioExtension(track.path);
  const displayExt = ext ? ext.toUpperCase() : 'AUDIO';
  const isDsd = dsdSet.has(ext);
  const isPcmLossless = pcmLosslessSet.has(ext);
  const isLossy = lossySet.has(ext);
  const isContainer = containerSet.has(ext);
  const serverStream = isMusicServerStreamPath(track.path);
  const decodePath: AudioDecodePath = ffmpegFallbackSet.has(ext) && !serverStream ? 'ffmpeg-pcm-fallback' : 'native';
  const sampleRate = finitePositive(track.sampleRate);
  const bitrate = finitePositive(track.bitrate);
  const densityBytesPerSecond = track.size && track.duration && track.size > 0 && track.duration > 0
    ? track.size / track.duration
    : null;
  const isHiRes = isDsd || (isPcmLossless && sampleRate != null && sampleRate >= 88200);
  const isLowBitrate = isLossy && bitrate != null && bitrate < 192000;
  const hasReplayGain = track.replayGainTrackDb != null || track.replayGainAlbumDb != null;
  const family: AudioQualityFamily = isDsd
    ? 'dsd'
    : isPcmLossless
      ? 'lossless'
      : isLossy
        ? 'lossy'
        : isContainer
          ? 'container'
          : 'unknown';
  const flags: string[] = [];

  if (isHiRes) flags.push(isDsd ? 'DSD source' : 'Hi-res PCM');
  if (decodePath === 'ffmpeg-pcm-fallback') flags.push('FFmpeg PCM playback');
  if (isLowBitrate) flags.push('Low bitrate review');
  if (!hasReplayGain) flags.push('ReplayGain missing');
  if (family === 'unknown') flags.push('Unclassified codec');

  return {
    ext,
    displayExt,
    family,
    decodePath,
    label: qualityLabel({ family, isHiRes, decodePath, bitrate }),
    isDsd,
    isLossless: isDsd || isPcmLossless,
    isHiRes,
    isLowBitrate,
    hasReplayGain,
    densityBytesPerSecond,
    flags,
  };
}

function qualityLabel(input: {
  family: AudioQualityFamily;
  isHiRes: boolean;
  decodePath: AudioDecodePath;
  bitrate: number | null;
}): string {
  if (input.family === 'dsd') return 'DSD via PCM fallback';
  if (input.family === 'lossless' && input.isHiRes) return 'hi-res lossless';
  if (input.family === 'lossless') return 'lossless';
  if (input.family === 'lossy' && input.bitrate != null && input.bitrate >= 256000) return 'high bitrate';
  if (input.family === 'lossy') return 'lossy';
  if (input.family === 'container') return input.decodePath === 'ffmpeg-pcm-fallback' ? 'container fallback' : 'container';
  return 'unknown source';
}

function finitePositive(value: number | null | undefined): number | null {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : null;
}
