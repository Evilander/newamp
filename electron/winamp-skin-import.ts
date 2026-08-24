import { inflateRawSync } from 'node:zlib';
import { basename, extname, isAbsolute } from 'node:path';
import type { CustomSkin } from '../shared/types.js';

interface ZipEntry {
  name: string;
  data: Buffer;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface PlaylistTextColors {
  normal?: string;
  current?: string;
  normalBg?: string;
  selectedBg?: string;
}

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const WINAMP_ARCHIVE_EXTENSIONS = new Set(['.wsz', '.zip']);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

// Classic Winamp skin bitmaps are tiny (skin assets are well under 1MB
// each). A crafted archive that inflates to hundreds of MB/GB would run
// inflateRawSync synchronously on the main process, blocking IPC/UI/audio
// for the duration and risking OOM — cap both per-entry and total
// decompressed size. maxOutputLength aborts decompression before it exceeds
// the per-entry cap; the running total in readZipEntries catches many
// entries that individually stay under that cap but sum to something huge.
const MAX_SKIN_ENTRY_INFLATED_BYTES = 24 * 1024 * 1024;
const MAX_SKIN_ARCHIVE_INFLATED_BYTES = 64 * 1024 * 1024;

// Import IPC hardening: settings:skin-import-file is wired to app-wide
// drag/drop, but it's also exposed directly on window.newamp, so any
// renderer script — not just the drop handler — can call it with an
// arbitrary path. Restrict to plausible skin files of a bounded size before
// any read happens; content still has to parse as a real custom skin or
// classic skin archive (parseCustomSkinFile / parseWinampClassicSkinArchive
// both throw on anything that doesn't match).
const SKIN_IMPORT_EXTENSIONS = new Set(['.json', '.wsz', '.zip']);
export const MAX_SKIN_IMPORT_FILE_BYTES = 20 * 1024 * 1024;

export function isWinampClassicSkinArchiveName(fileName: string): boolean {
  return WINAMP_ARCHIVE_EXTENSIONS.has(extname(fileName).toLowerCase());
}

export function assertSkinImportPathAllowed(filePath: string): void {
  if (typeof filePath !== 'string' || !filePath.trim() || !isAbsolute(filePath)) {
    throw new Error('Skin file path is invalid.');
  }
  if (!SKIN_IMPORT_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    throw new Error('Skins must be a .json, .wsz, or .zip file.');
  }
}

export function parseWinampClassicSkinArchive(input: Uint8Array, fileName = 'Winamp Skin.wsz'): CustomSkin {
  const entries = readZipEntries(input);
  const bmpColors = entries
    .filter((entry) => isSkinBitmap(entry.name))
    .flatMap((entry) => readBmpColors(entry.data));
  const textColors = entries
    .filter((entry) => entry.name.toLowerCase().endsWith('pledit.txt'))
    .map((entry) => parsePlaylistTextColors(entry.data.toString('utf8')))
    .reduce<PlaylistTextColors>((merged, colors) => ({ ...merged, ...colors }), {});

  if (!bmpColors.length && !Object.keys(textColors).length) {
    throw new Error('This Winamp skin archive did not contain readable classic skin colors.');
  }

  const bg = pickDarkColor(bmpColors) ?? textColors.normalBg ?? '#101418';
  const panel = pickPanelColor(bmpColors, bg) ?? mixHex(bg, '#ffffff', 0.1);
  const panel2 = mixHex(panel, '#ffffff', 0.08);
  const panel3 = mixHex(panel, '#000000', 0.1);
  const ink = textColors.normal ?? readableInk(bg);
  const ink2 = mixHex(ink, bg, 0.24);
  const accent = textColors.current ?? pickAccentColor(bmpColors, bg) ?? '#33d6ff';
  const selectedBg = textColors.selectedBg ?? mixHex(accent, bg, 0.55);
  const displayBg = textColors.normalBg ?? mixHex(bg, '#000000', 0.2);
  const displayFg = textColors.normal ?? readableInk(displayBg);

  return {
    name: skinNameFromFile(fileName),
    baseTheme: 'classic',
    variables: {
      '--bg': bg,
      '--panel': panel,
      '--panel-2': panel2,
      '--panel-3': panel3,
      '--line': mixHex(panel, ink, 0.18),
      '--accent': accent,
      '--accent-dim': mixHex(accent, bg, 0.48),
      '--accent-glow': mixHex(accent, '#ffffff', 0.16),
      '--ink': ink,
      '--ink-2': ink2,
      '--muted': mixHex(ink, bg, 0.42),
      '--warn': textColors.current ?? '#ffbb33',
      '--error': '#ff5c5c',
      '--display-bg': displayBg,
      '--display-fg': displayFg,
      '--bevel-light': mixHex(selectedBg, '#ffffff', 0.22),
      '--bevel-dark': mixHex(selectedBg, '#000000', 0.38),
      '--radius': '4px',
      '--radius-card': '6px',
    },
    updatedAt: Date.now(),
  };
}

function readZipEntries(input: Uint8Array): ZipEntry[] {
  const buffer = Buffer.from(input);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (centralOffset + centralSize > buffer.length) throw new Error('Invalid Winamp skin archive.');

  const entries: ZipEntry[] = [];
  let totalInflatedBytes = 0;
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) throw new Error('Invalid Winamp skin archive.');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replace(/\\/g, '/');
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name || name.endsWith('/')) continue;
    const data = readZipEntryData(buffer, localOffset, compressedSize, method);
    totalInflatedBytes += data.length;
    if (totalInflatedBytes > MAX_SKIN_ARCHIVE_INFLATED_BYTES) {
      throw new Error('This Winamp skin archive is too large when decompressed.');
    }
    entries.push({ name, data });
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) return offset;
  }
  throw new Error('This is not a readable Winamp skin archive.');
}

function readZipEntryData(buffer: Buffer, localOffset: number, compressedSize: number, method: number): Buffer {
  if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) throw new Error('Invalid Winamp skin archive.');
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
  if (method === 0) return Buffer.from(compressed);
  if (method === 8) {
    try {
      return inflateRawSync(compressed, { maxOutputLength: MAX_SKIN_ENTRY_INFLATED_BYTES });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error('This Winamp skin archive contains an entry that is too large when decompressed.');
      }
      throw err;
    }
  }
  throw new Error('Unsupported compression method in Winamp skin archive.');
}

function isSkinBitmap(name: string): boolean {
  const base = basename(name).toLowerCase();
  return ['main.bmp', 'pledit.bmp', 'eqmain.bmp', 'gen.bmp'].includes(base);
}

function readBmpColors(buffer: Buffer): Rgb[] {
  if (buffer.length < 54 || buffer.toString('ascii', 0, 2) !== 'BM') return [];
  const pixelOffset = buffer.readUInt32LE(10);
  const dibSize = buffer.readUInt32LE(14);
  if (dibSize < 40 || pixelOffset >= buffer.length) return [];
  const width = buffer.readInt32LE(18);
  const rawHeight = buffer.readInt32LE(22);
  const planes = buffer.readUInt16LE(26);
  const bpp = buffer.readUInt16LE(28);
  const compression = buffer.readUInt32LE(30);
  if (planes !== 1 || width <= 0 || rawHeight === 0 || compression !== 0) return [];
  if (![4, 8, 24, 32].includes(bpp)) return [];

  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const rowStride = Math.floor((bpp * width + 31) / 32) * 4;
  const palette = bpp <= 8 ? readBmpPalette(buffer, dibSize, bpp) : [];
  const colors: Rgb[] = [];
  const sampleEvery = Math.max(1, Math.floor((width * height) / 12000));
  let seen = 0;
  for (let y = 0; y < height; y += 1) {
    const bmpY = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      seen += 1;
      if (seen % sampleEvery !== 0) continue;
      const color = readBmpPixel(buffer, pixelOffset + bmpY * rowStride, x, bpp, palette);
      if (color && !isTransparentMask(color)) colors.push(color);
    }
  }
  return colors;
}

function readBmpPalette(buffer: Buffer, dibSize: number, bpp: number): Rgb[] {
  const paletteOffset = 14 + dibSize;
  const count = 1 << bpp;
  const palette: Rgb[] = [];
  for (let i = 0; i < count; i += 1) {
    const offset = paletteOffset + i * 4;
    if (offset + 3 >= buffer.length) break;
    palette.push({ b: buffer[offset]!, g: buffer[offset + 1]!, r: buffer[offset + 2]! });
  }
  return palette;
}

function readBmpPixel(buffer: Buffer, rowOffset: number, x: number, bpp: number, palette: Rgb[]): Rgb | null {
  if (bpp === 32) {
    const offset = rowOffset + x * 4;
    if (offset + 3 >= buffer.length) return null;
    return { b: buffer[offset]!, g: buffer[offset + 1]!, r: buffer[offset + 2]! };
  }
  if (bpp === 24) {
    const offset = rowOffset + x * 3;
    if (offset + 2 >= buffer.length) return null;
    return { b: buffer[offset]!, g: buffer[offset + 1]!, r: buffer[offset + 2]! };
  }
  if (bpp === 8) {
    const index = buffer[rowOffset + x];
    return index === undefined ? null : palette[index] ?? null;
  }
  const byte = buffer[rowOffset + Math.floor(x / 2)];
  if (byte === undefined) return null;
  const index = x % 2 === 0 ? byte >> 4 : byte & 0x0f;
  return palette[index] ?? null;
}

function parsePlaylistTextColors(content: string): PlaylistTextColors {
  const colors: PlaylistTextColors = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(Normal|Current|NormalBG|SelectedBG)\s*=\s*(.+?)\s*$/i.exec(line);
    if (!match) continue;
    const value = normalizeColorToken(match[2]!);
    if (!value) continue;
    if (/^normal$/i.test(match[1]!)) colors.normal = value;
    if (/^current$/i.test(match[1]!)) colors.current = value;
    if (/^normalbg$/i.test(match[1]!)) colors.normalBg = value;
    if (/^selectedbg$/i.test(match[1]!)) colors.selectedBg = value;
  }
  return colors;
}

function normalizeColorToken(value: string): string | null {
  const hex = value.match(/#[0-9a-f]{6}/i)?.[0];
  if (hex) return hex.toLowerCase();
  const rgb = value.match(/\b(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\b/);
  if (!rgb) return null;
  const [r, g, b] = rgb.slice(1).map((part) => clamp(Number(part), 0, 255));
  return rgbToHex({ r: r!, g: g!, b: b! });
}

function skinNameFromFile(fileName: string): string {
  const base = basename(fileName).replace(/\.(wsz|zip)$/i, '').trim();
  return base || 'Imported Winamp Skin';
}

function pickDarkColor(colors: Rgb[]): string | null {
  if (!colors.length) return null;
  return rgbToHex([...colors].sort((a, b) => luminance(a) - luminance(b))[Math.floor(colors.length * 0.08)] ?? colors[0]!);
}

function pickPanelColor(colors: Rgb[], bgHex: string): string | null {
  if (!colors.length) return null;
  const bg = hexToRgb(bgHex);
  const candidates = [...colors].sort((a, b) => luminance(a) - luminance(b));
  const start = Math.floor(candidates.length * 0.24);
  const end = Math.max(start + 1, Math.floor(candidates.length * 0.62));
  const picked = candidates.slice(start, end).find((color) => contrastDistance(color, bg) > 24) ?? candidates[start] ?? candidates[0];
  return picked ? rgbToHex(picked) : null;
}

function pickAccentColor(colors: Rgb[], bgHex: string): string | null {
  if (!colors.length) return null;
  const bg = hexToRgb(bgHex);
  const picked = colors
    .filter((color) => luminance(color) > 0.12 && contrastDistance(color, bg) > 44)
    .sort((a, b) => accentScore(b, bg) - accentScore(a, bg))[0];
  return picked ? rgbToHex(picked) : null;
}

function accentScore(color: Rgb, bg: Rgb): number {
  return saturation(color) * 1.8 + Math.min(1, contrastDistance(color, bg) / 180);
}

function saturation(color: Rgb): number {
  const max = Math.max(color.r, color.g, color.b) / 255;
  const min = Math.min(color.r, color.g, color.b) / 255;
  if (max === 0) return 0;
  return (max - min) / max;
}

function luminance(color: Rgb): number {
  return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
}

function contrastDistance(a: Rgb, b: Rgb): number {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

function readableInk(bgHex: string): string {
  return luminance(hexToRgb(bgHex)) > 0.52 ? '#081014' : '#f3fbff';
}

function mixHex(aHex: string, bHex: string, amount: number): string {
  const a = hexToRgb(aHex);
  const b = hexToRgb(bHex);
  return rgbToHex({
    r: Math.round(a.r + (b.r - a.r) * amount),
    g: Math.round(a.g + (b.g - a.g) * amount),
    b: Math.round(a.b + (b.b - a.b) * amount),
  });
}

function hexToRgb(value: string): Rgb {
  const normalized = HEX_COLOR.test(value) ? value.slice(1) : '101418';
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbToHex(color: Rgb): string {
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function toHex(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isTransparentMask(color: Rgb): boolean {
  return color.r > 245 && color.g < 10 && color.b > 245;
}
