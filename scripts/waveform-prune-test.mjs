// Cache files written before the last WAVEFORM_VERSION are removed at startup and do
// not count against the room the library-wide analysis may fill.
// Run: node scripts/waveform-prune-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp', 'waveform-prune-test');
await rm(root, { recursive: true, force: true });
const cache = join(root, 'cache');
await mkdir(cache, { recursive: true });

const bundlePath = join(root, 'waveform-peaks.bundle.mjs');
await build({
  stdin: { contents: `export * from './electron/waveform-peaks';`, resolveDir: resolve('.'), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', packages: 'external',
  outfile: bundlePath, logLevel: 'silent',
});
const { WAVEFORM_VERSION, getWaveform, initWaveformCache, waveformCacheHasRoom, killAllWaveformFfmpeg } = await import(pathToFileURL(bundlePath).href);

const older = [];
for (let i = 0; i < 5000; i++) older.push(`${String(i).padStart(40, '0')}.json`);
await Promise.all(older.map((name) => writeFile(join(cache, name), `{"v":${WAVEFORM_VERSION - 1},"buckets":2048,"duration":1}`)));
const current = 'c'.repeat(40) + '.json';
await writeFile(join(cache, current), `{"v":${WAVEFORM_VERSION},"buckets":2048,"duration":1}`);
const unknown = 'd'.repeat(40) + '.json';
await writeFile(join(cache, unknown), '{}');

initWaveformCache(cache);
await getWaveform({ path: join(root, 'missing.flac') }); // resolves once the cache is ready
assert.deepEqual((await readdir(cache)).filter((name) => name.endsWith('.json')).sort(), [current, unknown].sort(), 'only files of other versions were removed');
assert.ok(waveformCacheHasRoom(), 'the old files no longer count against the background fill');
killAllWaveformFfmpeg();
console.log('[waveform-prune-a7] PASS');
