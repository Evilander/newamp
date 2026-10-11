// Unit tests for electron/portable-data.ts: where the portable build keeps its
// data. Existing portable users keep the profile they already have.
// Run: node scripts/portable-data-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/portable-data-test-result.txt');
writeFileSync(RESULT, '[portable-data-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('electron/portable-data.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/portable-data-bundle.mjs'), logLevel: 'silent',
});
const { choosePortableDataDir, hasExistingProfile, PORTABLE_DATA_DIR_NAME } =
  await import(pathToFileURL(resolve('tmp/portable-data-bundle.mjs')).href);

const log = [];
let pass = true;
const same = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  log.push(`${label}: ${a}`);
  if (a !== e) { pass = false; log.push(`FAIL: ${label} expected ${e}, got ${a}`); }
};

const exeDir = '/media/usb/NewAmp';
const beside = join(exeDir, PORTABLE_DATA_DIR_NAME);
const profile = '/home/me/.config/NewAmp';
// A fake disk: the set of paths that exist and the folders that refuse writes.
const probeFor = (paths, readOnly = []) => ({
  exists: (path) => paths.includes(path),
  canWrite: (dir) => !readOnly.includes(dir),
});

same('fresh machine: data goes beside the exe',
  choosePortableDataDir(exeDir, profile, probeFor([])),
  { dir: beside, reason: 'fresh-install' });
same('settings.json already in the profile folder: keep it',
  choosePortableDataDir(exeDir, profile, probeFor([join(profile, 'settings.json')])),
  { dir: null, reason: 'existing-profile' });
same('library.db already in the profile folder: keep it',
  choosePortableDataDir(exeDir, profile, probeFor([join(profile, 'library.db')])),
  { dir: null, reason: 'existing-profile' });
same('an empty profile folder is not a profile',
  choosePortableDataDir(exeDir, profile, probeFor([profile])),
  { dir: beside, reason: 'fresh-install' });
same('the folder from an earlier launch keeps being used',
  choosePortableDataDir(exeDir, profile, probeFor([beside])),
  { dir: beside, reason: 'portable-folder-exists' });
same('both exist: the folder beside the exe wins (it was chosen first)',
  choosePortableDataDir(exeDir, profile, probeFor([beside, join(profile, 'library.db')])),
  { dir: beside, reason: 'portable-folder-exists' });
same('exe on read-only media: fall back to the profile folder',
  choosePortableDataDir(exeDir, profile, probeFor([], [beside])),
  { dir: null, reason: 'folder-not-writable' });
same('existing folder that became read-only: fall back',
  choosePortableDataDir(exeDir, profile, probeFor([beside], [beside])),
  { dir: null, reason: 'folder-not-writable' });
same('profile markers', [
  hasExistingProfile(profile, probeFor([join(profile, 'settings.json')])),
  hasExistingProfile(profile, probeFor([join(profile, 'library.db')])),
  hasExistingProfile(profile, probeFor([join(profile, 'diagnostics')])),
], [true, true, false]);

const report = log.join('\n') + '\n' + (pass ? '[portable-data-test] PASS' : '[portable-data-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
