// Exact playable length of an MP4/M4A audio track, for the sample-accurate
// gapless transport (electron/gapless-transport.ts).
//
// AAC encoders pad the last frame out to 1024 samples. The container says
// where the music really ends, but the bundled ffmpeg (6.1) only applies the
// start of the edit list (the encoder priming); it decodes the end padding as
// if it were music. Played back to back that padding is up to ~23 ms of
// near-silence at every boundary (measured: 923 samples on an ffmpeg-encoded
// 48 kHz pair). This reads the length the container declares so the producer
// can stop the decoder there.
//
// Sources, most exact first:
//   iTunSMPB     Apple's gapless atom: priming, padding, original sample count.
//                iTunes and Apple's encoders write it with no edit list; ffmpeg
//                then skips the priming it names (when under 16384 samples,
//                measured on 6.1) but still decodes the padding
//   stts − edit  sum of sample durations minus the edit list's media_time; exact
//                when the muxer shortened the last sample (ffmpeg, fdk-aac)
//   elst         the edit's segment duration, when the movie timescale can
//                express it to the sample
// Anything unusual (several edits, an empty edit, a timescale that isn't the
// sample rate, a length that disagrees with the frame table by more than two
// frames) returns null: no trim is always safe, a wrong trim cuts music.
// So does any sound track that isn't an mp4a entry: the frame size, the
// priming and iTunSMPB are AAC's, and an Apple Lossless .m4a has none of them.

import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { MP4_EXTS, boxChild, boxChildren, boxPath, readMoov, sampleEntryType, soundTrak } from './mp4-codec.js';

const AAC_FRAME = 1024;
// ffmpeg's mov demuxer takes iTunSMPB's priming only below this.
const SMPB_MAX_PRIMING = 16384;
const CACHE_CAP = 256;

export interface PlayableLength {
  /** Frames from ffmpeg's first output frame to the end of the music. */
  frames: number;
  rate: number;
  source: 'itunsmpb' | 'stts' | 'elst';
}

const cache = new Map<string, PlayableLength | null>();

export async function playableLength(path: string): Promise<PlayableLength | null> {
  if (!MP4_EXTS.has(extname(path).toLowerCase())) return null;
  let key: string;
  try {
    key = `${path}:${(await stat(path)).mtimeMs}`;
  } catch {
    return null;
  }
  if (cache.has(key)) return cache.get(key) ?? null;
  let result: PlayableLength | null = null;
  try {
    const moov = await readMoov(path);
    result = moov ? parseMoov(moov) : null;
  } catch {
    result = null;
  }
  if (cache.size >= CACHE_CAP) cache.clear();
  cache.set(key, result);
  return result;
}

function parseMoov(moov: Buffer): PlayableLength | null {
  const root = { body: 0, end: moov.length };
  const mvhd = boxChild(moov, root, 'mvhd');
  if (!mvhd) return null;
  const movieTimescale = moov.readUInt32BE(mvhd.body + (moov[mvhd.body] === 1 ? 20 : 12));
  const trak = soundTrak(moov);
  if (!trak) return null;
  const stsd = boxPath(moov, trak, 'mdia', 'minf', 'stbl', 'stsd');
  if (!stsd || sampleEntryType(moov, stsd) !== 'mp4a') return null;
  const mdhd = boxPath(moov, trak, 'mdia', 'mdhd');
  const stts = boxPath(moov, trak, 'mdia', 'minf', 'stbl', 'stts');
  if (!mdhd || !stts) return null;
  const rate = moov.readUInt32BE(mdhd.body + (moov[mdhd.body] === 1 ? 20 : 12));
  if (!rate) return null;

  let decodedTotal = 0;
  const entries = moov.readUInt32BE(stts.body + 4);
  for (let i = 0; i < entries; i++) {
    const at = stts.body + 8 + i * 8;
    if (at + 8 > stts.end) return null;
    decodedTotal += moov.readUInt32BE(at) * moov.readUInt32BE(at + 4);
  }

  let mediaTime = 0;
  let segmentFrames: number | null = null;
  const elst = boxPath(moov, trak, 'edts', 'elst');
  if (elst) {
    const version = moov[elst.body];
    const count = moov.readUInt32BE(elst.body + 4);
    // ffmpeg handles a lone edit; several (or an empty lead-in edit) mean a
    // layout this trim doesn't model.
    if (count !== 1) return null;
    const at = elst.body + 8;
    const segment = version === 1 ? Number(moov.readBigUInt64BE(at)) : moov.readUInt32BE(at);
    mediaTime = version === 1 ? Number(moov.readBigInt64BE(at + 8)) : moov.readInt32BE(at + 4);
    if (mediaTime < 0) return null;
    // Only when the movie timescale can express the end to the sample.
    if (movieTimescale >= rate && movieTimescale % rate === 0) segmentFrames = (segment * rate) / movieTimescale;
  }

  const smpb = iTunSmpb(moov);
  // No edit list (how iTunes and Apple's encoders ship AAC): ffmpeg starts
  // after the priming iTunSMPB names, as an edit's media_time would.
  if (smpb && !elst && smpb.priming < SMPB_MAX_PRIMING) mediaTime = smpb.priming;

  // What ffmpeg decodes: every sample after the edit's media_time, padding
  // included. A declared length has to sit within two frames of it.
  const decoded = decodedTotal - mediaTime;
  const plausible = (frames: number) => frames > 0 && frames <= decoded && frames >= decoded - 2 * AAC_FRAME;

  if (smpb && smpb.priming === mediaTime && plausible(smpb.frames)) {
    return { frames: smpb.frames, rate, source: 'itunsmpb' };
  }
  if (segmentFrames != null && Number.isInteger(segmentFrames) && plausible(segmentFrames) && segmentFrames < decoded) {
    return { frames: segmentFrames, rate, source: 'elst' };
  }
  // stts only says something when the muxer shortened the final sample.
  if (decodedTotal % AAC_FRAME !== 0 && plausible(decoded)) return { frames: decoded, rate, source: 'stts' };
  return null;
}

/** Apple's gapless info: " 00000000 PPPPPPPP EEEEEEEE LLLLLLLLLLLLLLLL ..." in hex. */
function iTunSmpb(moov: Buffer): { priming: number; frames: number } | null {
  const ilst = boxPath(moov, { body: 0, end: moov.length }, 'udta', 'meta');
  // meta is a full box: its children start after 4 bytes of version/flags.
  const list = ilst ? boxChild(moov, { body: ilst.body + 4, end: ilst.end }, 'ilst') : null;
  if (!list) return null;
  for (const item of boxChildren(moov, list.body, list.end)) {
    if (item.type !== '----') continue;
    const parts = boxChildren(moov, item.body, item.end);
    const name = parts.find((p) => p.type === 'name');
    const data = parts.find((p) => p.type === 'data');
    if (!name || !data) continue;
    if (moov.toString('latin1', name.body + 4, name.end) !== 'iTunSMPB') continue;
    const fields = moov.toString('latin1', data.body + 8, data.end).trim().split(/\s+/);
    if (fields.length < 4) return null;
    const priming = Number.parseInt(fields[1]!, 16);
    const frames = Number.parseInt(fields[3]!, 16);
    if (!Number.isFinite(priming) || !Number.isFinite(frames)) return null;
    return { priming, frames };
  }
  return null;
}
