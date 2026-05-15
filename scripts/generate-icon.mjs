import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = join(repoRoot, 'build');
const png = createPng(256, 256, drawIcon);
const ico = createIco(png, 256, 256);

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'icon.png'), png);
await writeFile(join(outDir, 'icon.ico'), ico);

function drawIcon(x, y, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy) / (width / 2);
  const angle = Math.atan2(dy, dx);
  const scan = Math.sin(y * 0.32) * 0.035;
  const glow = Math.max(0, 1 - dist);
  const ring = Math.abs(dist - 0.73) < 0.035 ? 1 : 0;
  const knob = Math.abs(dist - 0.37) < 0.08 && Math.abs(angle + 0.72) < 0.44 ? 1 : 0;
  const bolt = x > 101 + y * 0.08 && x < 142 + y * 0.15 && y > 48 && y < 205;

  if (dist > 0.96) return [0, 0, 0, 0];

  let r = 8 + glow * 34;
  let g = 15 + glow * 56;
  let b = 18 + glow * 30;
  let a = 255;

  if (dist < 0.82) {
    r += 8;
    g += 20;
    b += 10;
  }

  if (ring) {
    r = 55;
    g = 235;
    b = 154;
  }

  if (knob) {
    r = 210;
    g = 255;
    b = 136;
  }

  if (bolt) {
    r = 248;
    g = 70;
    b = 168;
  }

  const glass = Math.max(0, 1 - Math.hypot(x - 82, y - 66) / 120);
  r += glass * 24;
  g += glass * 32;
  b += glass * 20;

  return [
    clamp(r + scan * 255),
    clamp(g + scan * 255),
    clamp(b + scan * 255),
    a,
  ];
}

function createPng(width, height, painter) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let offset = 0;

  for (let y = 0; y < height; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = painter(x, y, width, height);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.concat([
      u32(width),
      u32(height),
      Buffer.from([8, 6, 0, 0, 0]),
    ])),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function createIco(pngBuffer, width, height) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry.writeUInt8(width === 256 ? 0 : width, 0);
  entry.writeUInt8(height === 256 ? 0 : height, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, pngBuffer]);
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  return Buffer.concat([
    u32(data.length),
    typeBuffer,
    data,
    u32(crc32(Buffer.concat([typeBuffer, data]))),
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}
