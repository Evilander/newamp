// Winamp skin import: the bitmap formats read (16 bpp, bitfields, RLE8/RLE4), stride sampling,
// and only the first bitmap of each name being decoded.
// Run: node scripts/skin-import-bitmap-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';

mkdirSync(resolve('tmp'), { recursive: true });
await build({
  entryPoints: [resolve('electron/winamp-skin-import.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: resolve('tmp/skin-import-bitmap-bundle.mjs'),
  logLevel: 'silent',
});
const { parseWinampClassicSkinArchive } = await import(pathToFileURL(resolve('tmp/skin-import-bitmap-bundle.mjs')).href);

function zip(entries) {
  const files = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = deflateRawSync(entry.content);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const head = Buffer.alloc(46 + name.length);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(8, 10);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(entry.content.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    name.copy(head, 46);
    files.push(local, data);
    central.push(head);
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, centralBuf, eocd]);
}

function header({ width, height, bpp, compression = 0, paletteSize = 0, palette = null, masks = null, dataLength }) {
  const maskBytes = masks ? 12 : 0;
  const pixelOffset = 54 + maskBytes + paletteSize * 4;
  const head = Buffer.alloc(pixelOffset);
  head.write('BM', 0, 'ascii');
  head.writeUInt32LE(pixelOffset + dataLength, 2);
  head.writeUInt32LE(pixelOffset, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(width, 18);
  head.writeInt32LE(height, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(bpp, 28);
  head.writeUInt32LE(compression, 30);
  if (masks) masks.forEach((mask, i) => head.writeUInt32LE(mask, 54 + i * 4));
  if (palette) palette.copy(head, 54);
  return head;
}

const W = 16;
const H = 16;
// Alternating bands of a dark and a bright colour, so the skin has a background and an accent.
const colorAt = (x, y) => ((x >> 2) + (y >> 2)) % 2 === 0 ? [40, 48, 56] : [248, 120, 24];
const expand5 = (v) => Math.round((v * 255) / 31);

function bmp24() {
  const stride = Math.ceil((W * 3) / 4) * 4;
  const data = Buffer.alloc(stride * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const [r, g, b] = colorAt(x, y);
      const row = (H - 1 - y) * stride + x * 3;
      data[row] = b; data[row + 1] = g; data[row + 2] = r;
    }
  }
  return Buffer.concat([header({ width: W, height: H, bpp: 24, dataLength: data.length }), data]);
}

// Colours that survive a 5-bit round trip, so every format decodes to the same pixels.
const five = (c) => c.map((v) => Math.round((v * 31) / 255));
const exact = (c) => five(c).map(expand5);

function bmp16() {
  const data = Buffer.alloc(W * 2 * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const [r, g, b] = five(colorAt(x, y));
      data.writeUInt16LE((r << 10) | (g << 5) | b, (H - 1 - y) * W * 2 + x * 2);
    }
  }
  return Buffer.concat([header({ width: W, height: H, bpp: 16, dataLength: data.length }), data]);
}

function bmp32Bitfields() {
  const data = Buffer.alloc(W * 4 * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const [r, g, b] = exact(colorAt(x, y));
      data.writeUInt32LE((r << 16) | (g << 8) | b, (H - 1 - y) * W * 4 + x * 4);
    }
  }
  return Buffer.concat([
    header({ width: W, height: H, bpp: 32, compression: 3, masks: [0xff0000, 0xff00, 0xff], dataLength: data.length }),
    data,
  ]);
}

const palette2 = () => {
  const table = Buffer.alloc(8);
  const [dr, dg, db] = exact([40, 48, 56]);
  const [lr, lg, lb] = exact([248, 120, 24]);
  table.set([db, dg, dr, 0, lb, lg, lr, 0], 0);
  return table;
};

function bmpRle8() {
  const rows = [];
  for (let y = 0; y < H; y += 1) {
    const row = [];
    for (let x = 0; x < W; x += 4) row.push(4, ((x >> 2) + (y >> 2)) % 2);
    row.push(0, 0);
    rows.unshift(row);
  }
  const data = Buffer.from([...rows.flat(), 0, 1]);
  return Buffer.concat([
    header({ width: W, height: H, bpp: 8, compression: 1, paletteSize: 2, palette: palette2(), dataLength: data.length }),
    data,
  ]);
}

function bmpRle4() {
  const rows = [];
  for (let y = 0; y < H; y += 1) {
    const row = [];
    for (let x = 0; x < W; x += 4) {
      const idx = ((x >> 2) + (y >> 2)) % 2;
      row.push(4, (idx << 4) | idx);
    }
    row.push(0, 0);
    rows.unshift(row);
  }
  const data = Buffer.from([...rows.flat(), 0, 1]);
  return Buffer.concat([
    header({ width: W, height: H, bpp: 4, compression: 2, paletteSize: 2, palette: palette2(), dataLength: data.length }),
    data,
  ]);
}

const skinOf = (bmp, fileName = 'x.wsz') => {
  const skin = parseWinampClassicSkinArchive(zip([{ name: 'main.bmp', content: bmp }]), fileName);
  return skin.variables;
};

// The 24-bit reference, built from the colours the 5-bit formats can represent.
const reference = (() => {
  const stride = Math.ceil((W * 3) / 4) * 4;
  const data = Buffer.alloc(stride * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const [r, g, b] = exact(colorAt(x, y));
      const row = (H - 1 - y) * stride + x * 3;
      data[row] = b; data[row + 1] = g; data[row + 2] = r;
    }
  }
  return skinOf(Buffer.concat([header({ width: W, height: H, bpp: 24, dataLength: data.length }), data]));
})();

assert.deepEqual(skinOf(bmp16()), reference, '16 bpp decodes to the same colours');
assert.deepEqual(skinOf(bmp32Bitfields()), reference, '32 bpp bitfields decodes to the same colours');
assert.deepEqual(skinOf(bmpRle8()), reference, 'RLE8 decodes to the same colours');
assert.deepEqual(skinOf(bmpRle4()), reference, 'RLE4 decodes to the same colours');
{
  const plain = skinOf(bmp24());
  assert.equal(plain['--bg'], '#283038', '24 bpp keeps the dark band exactly');
  assert.equal(plain['--accent'], '#f87818', '24 bpp keeps the bright band exactly');
}

// Absolute-mode runs (padded to an even byte count) and delta jumps.
{
  const pixels = [[0, 1, 0, 1], [1, 1, 0, 0]]; // stored bottom row first
  const colors = [exact([40, 48, 56]), exact([248, 120, 24])];
  const raw = Buffer.alloc(12 * 2);
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const [r, g, b] = colors[pixels[y][x]];
      raw.set([b, g, r], y * 12 + x * 3);
    }
  }
  const flat = skinOf(Buffer.concat([header({ width: 4, height: 2, bpp: 24, dataLength: raw.length }), raw]));
  const data = Buffer.from([
    0, 3, 0, 1, 0, 0, // three absolute pixels (0,1,0), one pad byte
    1, 1, 0, 0, // then the fourth pixel of the row
    0, 2, 0, 0, // delta to the next row start (no movement left/down 0)
    0, 0,
    2, 1, 2, 0, // row two: 1,1,0,0
    0, 1,
  ]);
  // Row one is complete after the literal; the delta (0,0) is a no-op and the end-of-line moves to row two.
  const rle = Buffer.concat([header({ width: 4, height: 2, bpp: 8, compression: 1, paletteSize: 2, palette: palette2(), dataLength: data.length }), data]);
  assert.deepEqual(skinOf(rle), flat, 'absolute mode and delta runs decode in place');
}

// A run that crosses the right edge fills the rest of its row; nothing wraps onto the next row.
{
  const colors = [exact([40, 48, 56]), exact([248, 120, 24])];
  const raw = Buffer.alloc(12 * 2);
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const [r, g, b] = colors[y === 0 ? 1 : 0]; // the first stored row is the bottom one
      raw.set([b, g, r], y * 12 + x * 3);
    }
  }
  const flat = skinOf(Buffer.concat([header({ width: 4, height: 2, bpp: 24, dataLength: raw.length }), raw]));
  const data = Buffer.from([6, 1, 0, 0, 4, 0, 0, 1]); // six of colour 1 (four fit), end of line, four of colour 0
  const rle = Buffer.concat([header({ width: 4, height: 2, bpp: 8, compression: 1, paletteSize: 2, palette: palette2(), dataLength: data.length }), data]);
  assert.deepEqual(skinOf(rle), flat, 'a long run is clipped at the edge of its row');
}

// A stream made of long runs that never reach an end-of-line marker costs no more than one of
// short runs of the same size, whatever the machine's speed: the two are timed side by side.
{
  const runs = (count, value, bytes) => {
    const out = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i += 2) {
      out[i] = count;
      out[i + 1] = value;
    }
    return out;
  };
  const rleBitmap = (bpp, data) => Buffer.concat([
    header({ width: W, height: H, bpp, compression: bpp === 8 ? 1 : 2, paletteSize: 2, palette: palette2(), dataLength: data.length }),
    data,
  ]);
  const timeOf = (bmp) => {
    const archive = zip([{ name: 'main.bmp', content: bmp }]);
    const started = performance.now();
    parseWinampClassicSkinArchive(archive, 'x.wsz');
    return performance.now() - started;
  };
  const bytes = 8 * 1024 * 1024;
  for (const [label, bpp, value] of [['RLE8', 8, 1], ['RLE4', 4, 0x11]]) {
    timeOf(rleBitmap(bpp, runs(1, value, bytes))); // warm-up
    const long = timeOf(rleBitmap(bpp, runs(255, value, bytes)));
    const short = timeOf(rleBitmap(bpp, runs(1, value, bytes)));
    assert.ok(
      long <= Math.max(10 * short, 250),
      `${label}: ${bytes} bytes of 255-pixel runs took ${long.toFixed(0)} ms, 1-pixel runs ${short.toFixed(0)} ms`,
    );
  }
}

// pledit.txt: keys and colours are read from lines with padding around them, and a line padded
// with whitespace in the middle is read in one pass, timed against a line of the same length.
{
  const parse = (text) => parseWinampClassicSkinArchive(zip([{ name: 'pledit.txt', content: Buffer.from(text) }]), 'x.wsz');
  const padded = parse('[Text]\r\n  Normal =   #112233   \r\ncurrent=#abcdef\r\nNormalBG = 1, 2, 3\r\n').variables;
  assert.equal(padded['--ink'], '#112233');
  assert.equal(padded['--accent'], '#abcdef');
  assert.equal(padded['--display-bg'], '#010203');

  const timeOf = (value) => {
    const archive = zip([{ name: 'pledit.txt', content: Buffer.from(`Normal=${value}\r\nCurrent=#abcdef\r\n`) }]);
    const started = performance.now();
    const skin = parseWinampClassicSkinArchive(archive, 'x.wsz');
    return { ms: performance.now() - started, accent: skin.variables['--accent'] };
  };
  const width = 60_000;
  timeOf(`a${'b'.repeat(width)}`); // warm-up
  const spread = timeOf(`a${' '.repeat(width)}b`);
  const solid = timeOf(`a${'b'.repeat(width)}`);
  assert.equal(spread.accent, '#abcdef', 'the line after a padded one is still read');
  assert.ok(
    spread.ms <= Math.max(10 * solid.ms, 250),
    `a ${width}-space line took ${spread.ms.toFixed(0)} ms, a line without spaces ${solid.ms.toFixed(0)} ms`,
  );
}

// Without pledit.txt an unreadable bitmap still ends in the clear error.
{
  const junk = Buffer.from(bmp24());
  junk.writeUInt32LE(5, 30); // an unsupported compression
  assert.throws(
    () => parseWinampClassicSkinArchive(zip([{ name: 'main.bmp', content: junk }]), 'x.wsz'),
    /did not contain readable classic skin colors/,
  );
}

// Only the first bitmap of a name is decoded; later ones, however many, are ignored. The later
// ones are valid bitmaps of another colour, so decoding any of them would change the result.
{
  const first = bmp24();
  const stride = Math.ceil((W * 3) / 4) * 4;
  const green = Buffer.alloc(stride * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) green[y * stride + x * 3 + 1] = 255;
  }
  const decoy = Buffer.concat([header({ width: W, height: H, bpp: 24, dataLength: green.length }), green]);
  const entries = [{ name: 'main.bmp', content: first }];
  for (let i = 0; i < 300; i += 1) entries.push({ name: `skin${i}/Main.BMP`, content: decoy });
  assert.deepEqual(parseWinampClassicSkinArchive(zip(entries), 'x.wsz').variables, skinOf(first));
}

// A large bitmap is sampled, not walked pixel by pixel.
{
  const width = 1024;
  const height = 1024;
  const data = Buffer.alloc(width * height * 3, 90);
  const started = Date.now();
  skinOf(Buffer.concat([header({ width, height, bpp: 24, dataLength: data.length }), data]));
  assert.ok(Date.now() - started < 1000, 'a 1M-pixel bitmap should import quickly');
}

console.log('skin-import-bitmap-test: PASS');
