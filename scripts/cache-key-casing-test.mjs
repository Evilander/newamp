// Unit test for caseFoldCachePath (esbuild harness).
// Run: node scripts/cache-key-casing-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/cache-key-casing-test-result.txt');
writeFileSync(RESULT, '[cache-key-casing-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('electron/cache-key-casing.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/cache-key-casing-bundle.mjs'), logLevel: 'silent',
});
const { caseFoldCachePath } = await import(pathToFileURL(resolve('tmp/cache-key-casing-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const p = '/Music/Song.FLAC';
const eq = (got, want, msg) => { log.push(`${msg}: ${got}`); if (got !== want) fail(`${msg} — expected ${want}`); };

eq(caseFoldCachePath(p, 'darwin'), '/music/song.flac', 'darwin folds case (APFS)');
eq(caseFoldCachePath(p, 'win32'), '/music/song.flac', 'win32 folds case');
eq(caseFoldCachePath(p, 'linux'), p, 'linux preserves case');

const report = log.join('\n') + '\n' + (pass ? '[cache-key-casing-test] PASS' : '[cache-key-casing-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
