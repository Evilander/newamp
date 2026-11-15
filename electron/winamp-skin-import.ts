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

// A crafted zip can be nearly empty on disk (a STORED, i.e. uncompressed,
// entry sidesteps the inflate caps above entirely) while declaring metadata
// that's expensive to process. Bound both the archive's structure and any
// bitmap's declared dimensions before doing real work with either.
const MAX_SKIN_ARCHIVE_ENTRIES = 4096;
const MAX_SKIN_ENTRY_NAME_BYTES = 1024;
const MAX_SKIN_BMP_PIXELS = 1024 * 1024;
const ZIP_GENERAL_FLAG_ENCRYPTED = 0x0001;

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
  const entries = readZipEntries(input, (name) => isSkinBitmap(name) || isPlaylistText(name));
  const bmpColors = entries
    .filter((entry) => isSkinBitmap(entry.name))
    .flatMap((entry) => readBmpColors(entry.data));
  const textColors = entries
    .filter((entry) => isPlaylistText(entry.name))
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

// Only entries `wanted` accepts are inflated, and only the first of any file
// name: a skin uses four bitmaps and one text file, so everything else in the
// archive (and any repeats of those names) costs nothing.
function readZipEntries(input: Uint8Array, wanted: (name: string) => boolean): ZipEntry[] {
  const buffer = Buffer.from(input);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  requireBytes(buffer, eocdOffset, 22);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  // 0xffff/0xffffffff sentinels mean "see the ZIP64 extension" — we don't
  // parse that extension, so refuse rather than mis-read the real values.
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 Winamp skin archives are not supported.');
  }
  if (entryCount > MAX_SKIN_ARCHIVE_ENTRIES) throw new Error('This Winamp skin archive has too many entries.');
  if (centralOffset + centralSize > buffer.length) throw new Error('Invalid Winamp skin archive.');

  const entries: ZipEntry[] = [];
  const taken = new Set<string>();
  let totalInflatedBytes = 0;
  let totalDeclaredBytes = 0;
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    requireBytes(buffer, offset, 46);
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) throw new Error('Invalid Winamp skin archive.');
    const flags = buffer.readUInt16LE(offset + 8);
    if (flags & ZIP_GENERAL_FLAG_ENCRYPTED) throw new Error('Encrypted Winamp skin archives are not supported.');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('ZIP64 Winamp skin archives are not supported.');
    }
    if (nameLength > MAX_SKIN_ENTRY_NAME_BYTES) throw new Error('This Winamp skin archive has an implausibly long entry name.');
    // buffer.subarray silently clamps an out-of-range end instead of
    // throwing, which would otherwise truncate the name to something that
    // happens to still parse rather than surfacing the corruption.
    requireBytes(buffer, offset + 46, nameLength + extraLength + commentLength);
    const headerEnd = offset + 46 + nameLength + extraLength + commentLength;
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replace(/\\/g, '/');
    offset = headerEnd;
    if (!name || name.endsWith('/')) continue;
    totalDeclaredBytes += uncompressedSize;
    if (totalDeclaredBytes > MAX_SKIN_ARCHIVE_INFLATED_BYTES) {
      throw new Error('This Winamp skin archive is too large when decompressed.');
    }
    const key = basename(name).toLowerCase();
    if (!wanted(name) || taken.has(key)) continue;
    taken.add(key);
    const data = readZipEntryData(buffer, localOffset, compressedSize, method);
    totalInflatedBytes += data.length;
    if (totalInflatedBytes > MAX_SKIN_ARCHIVE_INFLATED_BYTES) {
      throw new Error('This Winamp skin archive is too large when decompressed.');
    }
    entries.push({ name, data });
  }
  return entries;
}

function requireBytes(buffer: Buffer, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error('Invalid Winamp skin archive.');
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < 22) throw new Error('This is not a readable Winamp skin archive.');
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) return offset;
  }
  throw new Error('This is not a readable Winamp skin archive.');
}

function readZipEntryData(buffer: Buffer, localOffset: number, compressedSize: number, method: number): Buffer {
  requireBytes(buffer, localOffset, 30);
  if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) throw new Error('Invalid Winamp skin archive.');
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + nameLength + extraLength;
  requireBytes(buffer, dataOffset, compressedSize);
  const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
  if (method === 0) return Buffer.from(compressed);
  if (method === 8) {
    try {
      return inflateRawSync(compressed, { maxOutputLength: MAX_SKIN_ENTRY_INFLATED_BYTES });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error('This Winamp skin archive contains an entry that is too large when decompressed.');
      }
      throw new Error('Invalid Winamp skin archive.');
    }
  }
  throw new Error('Unsupported compression method in Winamp skin archive.');
}

function isPlaylistText(name: string): boolean {
  return basename(name).toLowerCase() === 'pledit.txt';
}

function isSkinBitmap(name: string): boolean {
  const base = basename(name).toLowerCase();
  return ['main.bmp', 'pledit.bmp', 'eqmain.bmp', 'gen.bmp'].includes(base);
}

const BI_RGB = 0;
const BI_RLE8 = 1;
const BI_RLE4 = 2;
const BI_BITFIELDS = 3;

interface ChannelMasks {
  r: number;
  g: number;
  b: number;
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
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(rawHeight)) return [];
  if (planes !== 1 || width <= 0 || rawHeight === 0) return [];
  const rle = (compression === BI_RLE8 && bpp === 8) || (compression === BI_RLE4 && bpp === 4);
  const bitfields = compression === BI_BITFIELDS && (bpp === 16 || bpp === 32);
  if (compression === BI_RGB ? ![4, 8, 16, 24, 32].includes(bpp) : !rle && !bitfields) return [];
  // Run-length data is stored bottom-up only.
  if (rle && rawHeight < 0) return [];

  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  // A crafted header can declare dimensions the actual pixel buffer doesn't
  // back at all (e.g. 100000x100000 in a 55-byte file) — sampling that would
  // run the loop below billions of times on the main process before ever
  // touching real bytes. Reject implausible sizes and any row/height math
  // that would reach past the end of the buffer before looping at all.
  if (width * height > MAX_SKIN_BMP_PIXELS) return [];
  const rowStride = Math.floor((bpp * width + 31) / 32) * 4;
  if (!rle && pixelOffset + rowStride * height > buffer.length) return [];
  let masks: ChannelMasks | null = null;
  if (bitfields) {
    // The three masks follow the 40-byte header, whether or not a larger one is in use.
    if (buffer.length < 66) return [];
    masks = { r: buffer.readUInt32LE(54), g: buffer.readUInt32LE(58), b: buffer.readUInt32LE(62) };
  } else if (bpp === 16) {
    masks = { r: 0x7c00, g: 0x03e0, b: 0x001f };
  }
  const palette = bpp <= 8 ? readBmpPalette(buffer, dibSize, bpp) : [];
  const indices = rle ? decodeRle(buffer, pixelOffset, width, height, bpp) : null;
  const colors: Rgb[] = [];
  // About 12000 pixels are enough to find the skin's colours, so step to each
  // sampled position instead of visiting every pixel.
  const total = width * height;
  const sampleEvery = Math.max(1, Math.floor(total / 12000));
  for (let index = sampleEvery - 1; index < total; index += sampleEvery) {
    const y = Math.floor(index / width);
    const x = index % width;
    const bmpY = topDown ? y : height - 1 - y;
    const color = indices
      ? palette[indices[bmpY * width + x]!] ?? null
      : readBmpPixel(buffer, pixelOffset + bmpY * rowStride, x, bpp, palette, masks);
    if (color && !isTransparentMask(color)) colors.push(color);
  }
  return colors;
}

// Expands RLE8/RLE4 data to one palette index per pixel, in stored row order
// (the bottom row first). Anything the stream says that falls outside the
// bitmap is dropped, and it stops at the end of the data.
function decodeRle(buffer: Buffer, pixelOffset: number, width: number, height: number, bpp: number): Uint8Array {
  const indices = new Uint8Array(width * height);
  let x = 0;
  let y = 0;
  const put = (value: number): void => {
    if (x < width && y < height) indices[y * width + x] = value;
    x += 1;
  };
  let pos = pixelOffset;
  while (pos + 1 < buffer.length && y < height) {
    const count = buffer[pos]!;
    const value = buffer[pos + 1]!;
    pos += 2;
    if (count > 0) {
      for (let i = 0; i < count; i += 1) {
        put(bpp === 8 ? value : i % 2 === 0 ? value >> 4 : value & 0x0f);
      }
      continue;
    }
    if (value === 0) {
      x = 0;
      y += 1;
    } else if (value === 1) {
      break;
    } else if (value === 2) {
      if (pos + 1 >= buffer.length) break;
      x += buffer[pos]!;
      y += buffer[pos + 1]!;
      pos += 2;
    } else {
      const bytes = bpp === 8 ? value : Math.ceil(value / 2);
      for (let i = 0; i < value && pos + (bpp === 8 ? i : i >> 1) < buffer.length; i += 1) {
        const byte = buffer[pos + (bpp === 8 ? i : i >> 1)]!;
        put(bpp === 8 ? byte : i % 2 === 0 ? byte >> 4 : byte & 0x0f);
      }
      pos += bytes + (bytes % 2);
    }
  }
  return indices;
}

function maskedChannel(value: number, mask: number): number {
  if (!mask) return 0;
  const shift = 31 - Math.clz32(mask & -mask);
  const max = (mask >>> shift) >>> 0;
  return Math.round((((value & mask) >>> shift) * 255) / max);
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

function readBmpPixel(
  buffer: Buffer,
  rowOffset: number,
  x: number,
  bpp: number,
  palette: Rgb[],
  masks: ChannelMasks | null,
): Rgb | null {
  if (bpp === 16 || (bpp === 32 && masks)) {
    const offset = rowOffset + x * (bpp / 8);
    if (offset + bpp / 8 > buffer.length) return null;
    const value = bpp === 16 ? buffer.readUInt16LE(offset) : buffer.readUInt32LE(offset);
    return { r: maskedChannel(value, masks!.r), g: maskedChannel(value, masks!.g), b: maskedChannel(value, masks!.b) };
  }
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
