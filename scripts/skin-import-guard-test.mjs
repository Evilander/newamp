// Unit tests for electron/winamp-skin-import.ts's import-path guard and
// zip-bomb decompression caps.
//
// assertSkinImportPathAllowed backs settings:skin-import-file, which is
// wired to app-wide drag/drop but is also exposed directly on
// window.newamp — any renderer script can call it with an arbitrary path,
// so main must reject anything that isn't a plausible absolute skin path
// before doing any I/O.
//
// The zip-bomb caps guard readZipEntryData/readZipEntries: a crafted
// .wsz/.zip skin archive could declare a small compressed entry that
// inflates to hundreds of MB/GB, running inflateRawSync synchronously on
// the main process (blocking IPC/UI/audio) and risking OOM.
//
// Run: npm run build:electron && node scripts/skin-import-guard-test.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import {
  assertSkinImportPathAllowed,
  parseWinampClassicSkinArchive,
  MAX_SKIN_IMPORT_FILE_BYTES,
} from '../dist-electron/electron/winamp-skin-import.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
mkdirSync(resolve(repoRoot, 'tmp'), { recursive: true });
const RESULT = resolve(repoRoot, 'tmp/skin-import-guard-test-result.txt');
writeFileSync(RESULT, '[skin-import-guard-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// --- assertSkinImportPathAllowed -------------------------------------------

if (!throws(() => assertSkinImportPathAllowed('relative/skin.json'))) {
  fail('a relative path must be rejected');
}
if (!throws(() => assertSkinImportPathAllowed(join(repoRoot, 'tmp', 'secrets.env')))) {
  fail('a disallowed extension must be rejected');
}
if (!throws(() => assertSkinImportPathAllowed(''))) {
  fail('an empty path must be rejected');
}
for (const ext of ['.json', '.wsz', '.zip']) {
  const err = throws(() => assertSkinImportPathAllowed(join(repoRoot, 'tmp', `skin${ext}`)));
  if (err) fail(`an absolute .${ext} path should be allowed, got: ${err.message}`);
}
log.push('assertSkinImportPathAllowed: relative/bad-extension rejected, allowed extensions pass');

if (!(MAX_SKIN_IMPORT_FILE_BYTES > 0 && MAX_SKIN_IMPORT_FILE_BYTES <= 64 * 1024 * 1024)) {
  fail(`MAX_SKIN_IMPORT_FILE_BYTES should be a small positive bound, got ${MAX_SKIN_IMPORT_FILE_BYTES}`);
}

// --- zip-bomb caps -----------------------------------------------------

function createZipArchive(entries) {
  const fileParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const source = entry.content;
    // `stored: true` writes the entry uncompressed (method 0) — the shape a
    // crafted archive uses to bypass every inflate-based cap.
    const method = entry.stored ? 0 : 8;
    const compressed = entry.stored ? Buffer.from(source) : deflateRawSync(source);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    fileParts.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }
  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...fileParts, ...centralParts, end]);
}

function createBmp24(width, height, getPixel) {
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const headerBytes = 54;
  const buffer = Buffer.alloc(headerBytes + pixelBytes);
  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(headerBytes, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(0, 30);
  buffer.writeUInt32LE(pixelBytes, 34);
  for (let y = 0; y < height; y += 1) {
    const bmpY = height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = getPixel(x, y);
      const off = headerBytes + bmpY * rowStride + x * 3;
      buffer[off] = b;
      buffer[off + 1] = g;
      buffer[off + 2] = r;
    }
  }
  return buffer;
}

// A single entry that inflates well past the per-entry cap. All-zero content
// is highly compressible, so the archive itself stays tiny while claiming a
// huge decompressed size — exactly the zip-bomb shape.
{
  const bomb = createZipArchive([{ name: 'main.bmp', content: Buffer.alloc(40 * 1024 * 1024) }]);
  log.push(`single-entry bomb archive size: ${bomb.length} bytes (declares 40MB decompressed)`);
  const err = throws(() => parseWinampClassicSkinArchive(bomb, 'bomb.wsz'));
  if (!err) fail('a single entry inflating past the per-entry cap must throw');
  else if (!/too large/i.test(err.message)) fail(`expected a "too large" error, got: ${err.message}`);
  else log.push(`per-entry cap enforced: ${err.message}`);
}

// Several entries, each individually under the per-entry cap, that sum past
// the total archive cap — the running-total check must still catch this.
{
  const entries = Array.from({ length: 5 }, (_, i) => ({
    name: `filler-${i}.bin`,
    content: Buffer.alloc(15 * 1024 * 1024), // 15MB each, under a 24MB per-entry cap; 75MB total
  }));
  const bomb = createZipArchive(entries);
  log.push(`multi-entry bomb archive size: ${bomb.length} bytes (5 x 15MB = 75MB decompressed)`);
  const err = throws(() => parseWinampClassicSkinArchive(bomb, 'bomb2.wsz'));
  if (!err) fail('entries that individually pass but sum past the total cap must throw');
  else if (!/too large/i.test(err.message)) fail(`expected a "too large" error, got: ${err.message}`);
  else log.push(`total-archive cap enforced: ${err.message}`);
}

// Regression: a normal, small classic skin archive must still import fine.
{
  const bmp = createBmp24(4, 4, (x, y) => [(x * 40) % 255, (y * 40) % 255, 120]);
  const pledit = 'Normal=#33d6ff\nCurrent=#ffffff\nNormalBG=#101418\nSelectedBG=#224488\n';
  const zip = createZipArchive([
    { name: 'main.bmp', content: bmp },
    { name: 'pledit.txt', content: Buffer.from(pledit, 'utf8') },
  ]);
  const err = throws(() => {
    const result = parseWinampClassicSkinArchive(zip, 'ok.wsz');
    if (!result || typeof result.variables !== 'object') throw new Error('no skin variables returned');
  });
  if (err) fail(`a normal small skin archive should still import, got: ${err.message}`);
  else log.push('legitimate small skin archive still imports: ok');
}

// --- structural bounds: STORED entries and crafted headers ---------------
//
// A 169-byte archive whose single STORED main.bmp is 55 bytes long but declares
// 100000x100000 pixels used to run the colour-sampling loop ten billion times
// on the main process. None of the inflate caps apply because nothing inflates.
{
  const bogusBmp = Buffer.alloc(55);
  bogusBmp.write('BM', 0, 'ascii');
  bogusBmp.writeUInt32LE(bogusBmp.length, 2);
  bogusBmp.writeUInt32LE(54, 10);      // pixel data offset
  bogusBmp.writeUInt32LE(40, 14);      // BITMAPINFOHEADER
  bogusBmp.writeInt32LE(100000, 18);   // width
  bogusBmp.writeInt32LE(100000, 22);   // height
  bogusBmp.writeUInt16LE(1, 26);       // planes
  bogusBmp.writeUInt16LE(24, 28);      // bpp
  bogusBmp.writeUInt32LE(0, 30);       // BI_RGB
  const archive = createZipArchive([{ name: 'main.bmp', content: bogusBmp, stored: true }]);
  if (archive.length > 512) fail(`the huge-dimension fixture should be tiny on disk, got ${archive.length} bytes`);
  const started = Date.now();
  const outcome = throws(() => parseWinampClassicSkinArchive(archive, 'huge.wsz'));
  const elapsed = Date.now() - started;
  if (elapsed > 200) fail(`a BMP declaring 100000x100000 in ${archive.length} bytes took ${elapsed}ms to reject — the pixel loop ran`);
  else log.push(`huge-dimension stored BMP handled in ${elapsed}ms (${outcome ? 'rejected: ' + outcome.message : 'ignored'})`);
}

// A truncated central directory surfaces as the friendly archive error, never
// as a raw RangeError from an unchecked header read.
{
  const good = createZipArchive([{ name: 'main.bmp', content: createBmp24(4, 4, () => [1, 2, 3]) }]);
  const eocd = good.length - 22;
  const truncated = Buffer.concat([good.subarray(0, eocd - 20), good.subarray(eocd)]);
  // Keep the EOCD's central-directory offset/size pointing past what is left.
  const err = throws(() => parseWinampClassicSkinArchive(truncated, 'truncated.wsz'));
  if (!err) fail('a truncated central directory must be rejected');
  else if (/RangeError|out of range/i.test(err.message) || err instanceof RangeError) fail(`truncated archive leaked a raw error: ${err.message}`);
  else if (!/winamp skin archive/i.test(err.message)) fail(`unexpected error for a truncated archive: ${err.message}`);
  else log.push(`truncated central directory rejected cleanly: ${err.message}`);
}

// An entry whose local header points past the end of the file is rejected the
// same way instead of reading whatever happens to be there.
{
  const good = createZipArchive([{ name: 'main.bmp', content: createBmp24(4, 4, () => [1, 2, 3]) }]);
  const eocd = good.length - 22;
  const centralOffset = good.readUInt32LE(eocd + 16);
  good.writeUInt32LE(good.length + 4096, centralOffset + 42); // local header offset -> beyond EOF
  const err = throws(() => parseWinampClassicSkinArchive(good, 'past-eof.wsz'));
  if (!err || !/winamp skin archive/i.test(err.message) || err instanceof RangeError) {
    fail(`an entry pointing past EOF must be rejected cleanly, got: ${err ? err.message : 'no error'}`);
  } else log.push(`entry data past EOF rejected cleanly: ${err.message}`);
}

// A central directory claiming more entries than the cap is refused before any
// entry is read.
{
  const good = createZipArchive([{ name: 'main.bmp', content: createBmp24(4, 4, () => [1, 2, 3]) }]);
  const eocd = good.length - 22;
  good.writeUInt16LE(60000, eocd + 8);
  good.writeUInt16LE(60000, eocd + 10);
  const err = throws(() => parseWinampClassicSkinArchive(good, 'many.wsz'));
  if (!err || !/too many entries/i.test(err.message)) fail(`an implausible entry count must be rejected, got: ${err ? err.message : 'no error'}`);
  else log.push(`excessive entry count rejected: ${err.message}`);
}

// Encrypted entries are refused with a clear message. Data-descriptor entries
// (general-purpose bit 3, set by streaming zip writers) are fine: sizes are read
// from the central directory, never from the local header, so nothing about
// them needs the descriptor.
{
  const good = createZipArchive([{ name: 'main.bmp', content: createBmp24(4, 4, () => [1, 2, 3]) }]);
  const eocd = good.length - 22;
  const centralOffset = good.readUInt32LE(eocd + 16);
  const encrypted = Buffer.from(good);
  encrypted.writeUInt16LE(0x0001, centralOffset + 8);
  const encErr = throws(() => parseWinampClassicSkinArchive(encrypted, 'enc.wsz'));
  if (!encErr || !/encrypted/i.test(encErr.message)) fail(`an encrypted entry must be refused, got: ${encErr ? encErr.message : 'no error'}`);
  else log.push(`encrypted entry refused: ${encErr.message}`);
  const descriptor = Buffer.from(good);
  descriptor.writeUInt16LE(0x0008, centralOffset + 8);
  const descErr = throws(() => {
    const skin = parseWinampClassicSkinArchive(descriptor, 'desc.wsz');
    if (!skin || !Object.keys(skin.variables ?? {}).length) throw new Error('data-descriptor skin produced no palette');
  });
  if (descErr) fail(`a data-descriptor entry must still import: ${descErr.message}`);
  else log.push('data-descriptor entry imports normally');
}

// A well-formed STORED skin still parses and yields its palette.
{
  const bmp = createBmp24(8, 8, (x) => (x < 4 ? [200, 30, 30] : [30, 30, 200]));
  const archive = createZipArchive([{ name: 'main.bmp', content: bmp, stored: true }]);
  const err = throws(() => {
    const skin = parseWinampClassicSkinArchive(archive, 'stored-ok.wsz');
    if (!skin || !skin.variables || !Object.keys(skin.variables).length) throw new Error('stored skin produced no palette');
  });
  if (err) fail(`a valid stored-entry skin should still parse: ${err.message}`);
  else log.push('valid stored-entry skin parses to a palette');
}

const report = log.join('\n') + '\n' + (pass ? '[skin-import-guard-test] PASS' : '[skin-import-guard-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
