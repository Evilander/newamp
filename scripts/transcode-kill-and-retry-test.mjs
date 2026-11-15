// readTrackFile's rethrow option, the retry-later error codes, and the ffmpeg
// child kills that go through killChild.
// Run: node scripts/transcode-kill-and-retry-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp', 'transcode-kill-and-retry-test', String(process.pid));
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

await build({
  entryPoints: [resolve('electron/scanner.ts')],
  outfile: join(root, 'scanner.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
});
const { readTrackFile } = await import(pathToFileURL(join(root, 'scanner.mjs')).href);

// Not a real MP3, so parsing it falls back to a filename-only row.
const readable = join(root, 'readable.mp3');
await writeFile(readable, Buffer.alloc(2048));
assert.ok(await readTrackFile(readable), 'a readable file gives a row');
assert.ok(await readTrackFile(readable, { rethrowStorageErrors: true }), 'the option changes nothing for a readable file');

const missing = join(root, 'gone.mp3');
assert.equal(await readTrackFile(missing), null, 'a missing file is null');
assert.equal(await readTrackFile(missing, { rethrowStorageErrors: true }), null, 'a missing file is still null with the option');

if (process.platform !== 'win32' && process.getuid?.() !== 0) {
  const locked = join(root, 'locked.mp3');
  await writeFile(locked, Buffer.alloc(2048));
  await chmod(locked, 0o000);
  try {
    assert.equal(await readTrackFile(locked), null, 'default: a file the process may not read is null, as before');
    await assert.rejects(
      readTrackFile(locked, { rethrowStorageErrors: true }),
      (err) => err.code === 'EACCES',
      'a refused read is thrown so the caller does not call the file unparseable',
    );
  } finally {
    await chmod(locked, 0o644);
  }
}

const scannerSource = await readFile('electron/scanner.ts', 'utf8');
for (const code of ['EMFILE', 'ENFILE', 'EACCES', 'EPERM', 'EINTR']) {
  assert.match(scannerSource, new RegExp(`UNREADABLE_FOR_NOW_CODES = new Set\\([^)]*'${code}'`), `${code} is retry-later`);
}

for (const file of ['transcode.ts', 'transcode-cache.ts', 'dna-analyzer.ts', 'score-analyzer.ts']) {
  const source = await readFile(join('electron', file), 'utf8');
  assert.doesNotMatch(source, /\bchild\.kill\(\)|decoding\.child\.kill\(\)/, `${file} stops ffmpeg through killChild`);
}

await rm(root, { recursive: true, force: true });
console.log('PASS w2-misc: readTrackFile rethrow, retry-later codes, killChild at every ffmpeg kill');
