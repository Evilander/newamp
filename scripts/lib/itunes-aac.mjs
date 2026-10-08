// Rewrites an ffmpeg AAC encode into the layout iTunes and Apple's encoders
// ship: no edit list, every packet 1024 samples long in stts, and the
// gapless facts only in an iTunSMPB atom. The bundled ffmpeg can't write
// iTunSMPB, so the gapless tests build it here.
//
// The input must come from ffmpeg's native AAC encoder with `-use_editlist 0`
// (and `-map_metadata -1 -fflags +bitexact`, which keeps its udta trivial),
// muxed with moov after mdat.

import { readFileSync, writeFileSync } from 'node:fs';

// ffmpeg's native AAC encoder primes this many samples.
const PRIMING = 1024;

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
const fullBox = (type, ...parts) => box(type, Buffer.alloc(4), ...parts);

function children(buf, start, end) {
  const out = [];
  for (let p = start; p + 8 <= end; ) {
    const size = buf.readUInt32BE(p);
    if (size < 8) break;
    out.push({ type: buf.toString('latin1', p + 4, p + 8), start: p, end: p + size, body: p + 8 });
    p += size;
  }
  return out;
}

function find(buf, parent, ...types) {
  let found = parent;
  for (const type of types) found = found && children(buf, found.body, found.end).find((b) => b.type === type);
  return found ?? null;
}

/**
 * Rewrite `path` in place for a source of `frames` samples. Returns the
 * priming and padding iTunSMPB now declares.
 */
export function makeItunesStyle(path, frames) {
  const file = readFileSync(path);
  const moov = children(file, 0, file.length).find((b) => b.type === 'moov');
  if (!moov || moov.end !== file.length) throw new Error(`${path}: moov is not the last box`);
  const trak = find(file, moov, 'trak');
  if (find(file, trak, 'edts')) throw new Error(`${path}: has an edit list`);
  const stts = find(file, trak, 'mdia', 'minf', 'stbl', 'stts');
  let packets = 0;
  for (let i = 0; i < file.readUInt32BE(stts.body + 4); i++) {
    packets += file.readUInt32BE(stts.body + 8 + i * 8);
    // Apple never shortens the last packet; ffmpeg does.
    file.writeUInt32BE(1024, stts.body + 12 + i * 8);
  }
  const padding = packets * 1024 - PRIMING - frames;
  if (padding < 0) throw new Error(`${path}: ${packets} packets can't hold ${frames} frames`);
  const hex = (v, width) => v.toString(16).toUpperCase().padStart(width, '0');
  const smpb = ` 00000000 ${hex(PRIMING, 8)} ${hex(padding, 8)} ${hex(frames, 16)}${' 00000000'.repeat(8)}`;
  const udta = box('udta', fullBox('meta',
    fullBox('hdlr', Buffer.alloc(4), Buffer.from('mdirappl', 'latin1'), Buffer.alloc(9)),
    box('ilst', box('----',
      fullBox('mean', Buffer.from('com.apple.iTunes', 'latin1')),
      fullBox('name', Buffer.from('iTunSMPB', 'latin1')),
      box('data', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from(smpb, 'latin1')),
    )),
  ));
  // moov is last, so growing it moves no chunk offsets.
  const old = find(file, moov, 'udta');
  const kept = old
    ? Buffer.concat([file.subarray(moov.start, old.start), file.subarray(old.end, moov.end)])
    : file.subarray(moov.start, moov.end);
  const rebuilt = Buffer.concat([kept, udta]);
  rebuilt.writeUInt32BE(rebuilt.length, 0);
  writeFileSync(path, Buffer.concat([file.subarray(0, moov.start), rebuilt]));
  return { priming: PRIMING, padding };
}
