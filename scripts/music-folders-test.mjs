// Unit test for darwin music-folder suggestions (esbuild harness).
// Run: node scripts/music-folders-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/music-folders-test-result.txt');
writeFileSync(RESULT, '[music-folders-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('electron/music-folders.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/music-folders-bundle.mjs'), logLevel: 'silent',
});
const { suggestMusicFolders } = await import(pathToFileURL(resolve('tmp/music-folders-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const homeDir = '/Users/tester';
const existsSet = new Set([
  `${homeDir}/Music`,
  `${homeDir}/Music/Music/Media`,
  '/Volumes/BigDrive/Music',
]);
const result = suggestMusicFolders({
  platform: 'darwin',
  homeDir,
  env: {},
  exists: (p) => existsSet.has(p),
  readVolumes: () => ['BigDrive', 'Macintosh HD'],
});
const paths = result.map((r) => r.path);
log.push('darwin suggestions: ' + JSON.stringify(paths));

if (!paths.includes(`${homeDir}/Music`)) fail('expected ~/Music suggestion on darwin');
if (!paths.includes('/Volumes/BigDrive/Music')) fail('expected /Volumes external-drive suggestion');
if (paths.some((p) => p.startsWith('K:/') || p.startsWith('I:/'))) fail('Windows drive paths leaked into darwin suggestions');
if (result.some((r) => /windows/i.test(r.label))) fail('"Windows Music" label leaked into darwin suggestions');

const win = suggestMusicFolders({
  platform: 'win32',
  homeDir: 'C:/Users/tester',
  env: {},
  exists: (p) => p === 'K:/music',
});
if (!win.map((r) => r.path).includes('K:/music')) fail('win32 K:/music suggestion regressed');
log.push('win32 suggestions: ' + JSON.stringify(win.map((r) => r.path)));

const report = log.join('\n') + '\n' + (pass ? '[music-folders-test] PASS' : '[music-folders-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
