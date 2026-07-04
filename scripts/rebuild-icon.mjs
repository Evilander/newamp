#!/usr/bin/env node
// Rebuild build/icon.ico with the mixed frame encoding Windows actually wants:
//   - frames < 256px: raw BMP/DIB (the notification area / tray decode path
//     chokes on PNG-compressed small frames — the v1.15.0 tray fix)
//   - the 256px frame: PNG (the taskbar / high-res shell decode path officially
//     supports PNG ONLY for the 256px frame; the v1.15.0 fix converted it to
//     BMP and regressed the taskbar icon — this script restores it)
//
// Idempotent: run it any time; it only rewrites when the 256px frame is BMP.
// DO NOT use scripts/fix-logo.py for this — Pillow's ICO encoder writes EVERY
// frame as PNG, which re-breaks the tray.
//
// Usage: node scripts/rebuild-icon.mjs [path-to-ico]

import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const icoPath = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.ico')

// ---- PNG encoding (pure Node: chunks + CRC32 + zlib IDAT) -------------------
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0 // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- ICO parse / rebuild ----------------------------------------------------
const ico = readFileSync(icoPath)
if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
  console.error('[rebuild-icon] not an ICO file:', icoPath)
  process.exit(1)
}
const count = ico.readUInt16LE(4)
const frames = []
for (let i = 0; i < count; i++) {
  const off = 6 + i * 16
  frames.push({
    width: ico[off] || 256,
    height: ico[off + 1] || 256,
    entry: Buffer.from(ico.subarray(off, off + 16)),
    data: Buffer.from(ico.subarray(ico.readUInt32LE(off + 12), ico.readUInt32LE(off + 12) + ico.readUInt32LE(off + 8))),
  })
}

let changed = false
for (const frame of frames) {
  const isPng = frame.data[0] === 0x89 && frame.data[1] === 0x50
  if (frame.width < 256) {
    if (isPng) {
      console.error(`[rebuild-icon] FATAL: ${frame.width}px frame is PNG — that re-breaks the tray. Rebuild small frames as BMP first (v1.15.0 fix).`)
      process.exit(1)
    }
    continue
  }
  if (isPng) continue // already correct

  // Decode the 32bpp BMP/DIB frame (BITMAPINFOHEADER, XOR rows bottom-up).
  const biSize = frame.data.readUInt32LE(0)
  const bitCount = frame.data.readUInt16LE(14)
  const compression = frame.data.readUInt32LE(16)
  if (biSize !== 40 || bitCount !== 32 || compression !== 0) {
    console.error(`[rebuild-icon] FATAL: 256px frame is not an uncompressed 32bpp DIB (biSize=${biSize} bitCount=${bitCount} compression=${compression}).`)
    process.exit(1)
  }
  const w = frame.width
  const h = frame.height
  const rgba = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    const srcRow = 40 + (h - 1 - y) * w * 4
    for (let x = 0; x < w; x++) {
      const s = srcRow + x * 4
      const d = (y * w + x) * 4
      rgba[d] = frame.data[s + 2] // R <- B swap
      rgba[d + 1] = frame.data[s + 1]
      rgba[d + 2] = frame.data[s]
      rgba[d + 3] = frame.data[s + 3]
    }
  }
  frame.data = encodePng(rgba, w, h)
  // PNG ICONDIRENTRY convention: planes=1, bitCount=32.
  frame.entry.writeUInt16LE(1, 4)
  frame.entry.writeUInt16LE(32, 6)
  changed = true
  console.log(`[rebuild-icon] 256px frame: BMP (${w * h * 4 + 40}B+mask) -> PNG (${frame.data.length}B)`)
}

if (!changed) {
  console.log('[rebuild-icon] icon already correct (BMP <256, PNG @256) — nothing to do.')
  process.exit(0)
}

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(frames.length, 4)
let offset = 6 + frames.length * 16
const entries = []
const blobs = []
for (const frame of frames) {
  frame.entry.writeUInt32LE(frame.data.length, 8)
  frame.entry.writeUInt32LE(offset, 12)
  entries.push(frame.entry)
  blobs.push(frame.data)
  offset += frame.data.length
}
writeFileSync(icoPath, Buffer.concat([header, ...entries, ...blobs]))
console.log(`[rebuild-icon] wrote ${icoPath} (${offset} bytes, ${frames.length} frames: BMP <256 + PNG @256)`)
