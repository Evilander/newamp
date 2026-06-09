// Unit test for detectMachOArch. Verifies it reads the Mach-O header and, on
// macOS, that the installed ffmpeg-static binary reports the host arch.
// Run: node scripts/macho-arch-test.mjs
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { arch as hostArch, platform as hostPlatform } from 'node:os';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/macho-arch-test-result.txt');
writeFileSync(RESULT, '[macho-arch-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

const { detectMachOArch, detectMachOArchFromBytes } = await import(pathToFileURL(resolve('scripts/lib/macho-arch.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

function machoLE(cputype) {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(cputype >>> 0, 4);
  return b;
}
const arm64Bytes = machoLE(0x0100000c);
const x64Bytes = machoLE(0x01000007);
const fatBytes = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);

if (detectMachOArchFromBytes(arm64Bytes) !== 'arm64') fail('arm64 header → arm64');
if (detectMachOArchFromBytes(x64Bytes) !== 'x64') fail('x86_64 header → x64');
if (detectMachOArchFromBytes(fatBytes) !== 'universal') fail('fat header → universal');
if (detectMachOArchFromBytes(Buffer.from([0, 1, 2, 3])) !== 'unknown') fail('garbage → unknown');
log.push('synthetic header checks done');

const ff = resolve('node_modules/ffmpeg-static/ffmpeg');
if (hostPlatform() === 'darwin' && existsSync(ff)) {
  const got = detectMachOArch(ff);
  const want = hostArch() === 'arm64' ? 'arm64' : 'x64';
  log.push(`installed ffmpeg arch: ${got} (host ${want})`);
  if (got !== want && got !== 'universal') fail(`installed ffmpeg arch ${got} != host ${want}`);
} else {
  log.push('skipping real-binary check (not darwin or ffmpeg-static absent)');
}

const report = log.join('\n') + '\n' + (pass ? '[macho-arch-test] PASS' : '[macho-arch-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
