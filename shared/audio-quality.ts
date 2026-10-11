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
  // What the file says about its own codec (see Track.codec). Only containers
  // that can hold either family (.m4a, .mka) use it to settle lossy vs lossless.
  codec?: string | null;
  codecLossless?: boolean | null;
  bitsPerSample?: number | null;
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
  'aac',
  'ogg',
  'oga',
  'opus',
  'wma',
  'mpc',
  'ac3',
  'dts',
] as const;

export const CONTAINER_AUDIO_EXTENSIONS = ['mka', 'm4a', 'm4b', 'mp4'] as const;

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

// Lossless or lossy, from what a container's own header says: the codec's
// lossless flag when the file gave one, otherwise the codec's name. Null when
// neither settles it, which leaves the file classified by its container alone.
export function codecFamilyFromCodec(
  codec: string | null | undefined,
  lossless?: boolean | null,
): 'lossless' | 'lossy' | null {
  if (lossless === true) return 'lossless';
  if (lossless === false) return 'lossy';
  const name = (codec ?? '').toLowerCase();
  if (!name) return null;
  // ADPCM is lossy and MPEG-4 ALS lossless, though one holds "pcm" and the
  // other "mpeg".
  if (/adpcm/.test(name)) return 'lossy';
  if (/alac|flac|pcm|wavpack|monkey|\btta\b|truehd|lpcm|\bals\b/.test(name)) return 'lossless';
  if (/aac|mp4a|mpeg|mp3|opus|vorbis|ac-?3|ima4|ulaw|alaw/.test(name)) return 'lossy';
  return null;
}

// What Chromium's MP4 demuxer decodes (electron/mp4-codec.ts): AAC, MP3, FLAC
// and Opus. A container whose first track names any other codec (Apple
// Lossless, AC-3, uLaw, ...) plays through FFmpeg, as playback decides by
// the sample entry. Several tracks are joined with "+", and the first plays.
const CHROMIUM_CONTAINER_CODEC = /aac|mp4a|mp3|layer ?3|flac|opus/;

export function containerCodecNeedsFfmpeg(codec: string | null | undefined): boolean {
  const first = (codec ?? '').split('+')[0]!.trim().toLowerCase();
  return first !== '' && !CHROMIUM_CONTAINER_CODEC.test(first);
}

export function classifyAudioQuality(track: AudioQualityTrackInput): AudioQualitySignal {
  const ext = audioExtension(track.path);
  const displayExt = ext ? ext.toUpperCase() : 'AUDIO';
  const isDsd = dsdSet.has(ext);
  const containerCodecFamily = containerSet.has(ext) ? codecFamilyFromCodec(track.codec, track.codecLossless) : null;
  const isPcmLossless = pcmLosslessSet.has(ext) || containerCodecFamily === 'lossless';
  const isLossy = lossySet.has(ext) || containerCodecFamily === 'lossy';
  const isContainer = containerSet.has(ext);
  const serverStream = isMusicServerStreamPath(track.path);
  // Chromium's MP4 demuxer has no Apple Lossless (or AC-3, or PCM), so an .m4a
  // that holds one plays through the FFmpeg PCM path like an .alac file does.
  const ffmpegInContainer = isContainer && containerCodecNeedsFfmpeg(track.codec);
  const decodePath: AudioDecodePath = (ffmpegFallbackSet.has(ext) || ffmpegInContainer) && !serverStream
    ? 'ffmpeg-pcm-fallback'
    : 'native';
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
