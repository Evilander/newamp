// The pieces around the analysis queue that a listener sees or that wire it in:
//  - the tempo chip says how much of the library has a tempo
//  - the progress line reads plainly in each state
//  - the Background analysis setting: on by default, saved, never switched off by a stray value
//  - main.ts starts it outside smoke runs, tells it about scans and plays,
//    stops it before the library closes; Settings and Quick Play use it
// Run: npm run build:electron && node scripts/analysis-ui-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const entry = resolve('tmp/analysis-ui-test-entry.ts');
writeFileSync(entry, `export * from '../shared/query-intent';\nexport * from '../shared/analysis';\n`);
const outfile = resolve('tmp/analysis-ui-test-bundle.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile, logLevel: 'silent' });
const { compileQueryIntent, withTempoCoverage, describeAnalysis, formatAnalysisEta, emptyAnalysisProgress } = await import(pathToFileURL(outfile).href);

// 1. Tempo chips carry the coverage.
{
  const slow = compileQueryIntent('warm slow stuff from the 70s');
  const chips = withTempoCoverage(slow, { known: 1204, total: 58001 });
  assert.ok(chips.some((chip) => chip === 'slow (bpm ≤ 95), tempo known for 1,204 of 58,001 tracks'), chips.join(' | '));
  assert.equal(chips.length, slow.chips.length);
  assert.ok(chips.includes('1970s'), 'other chips are left alone');

  const noTempo = compileQueryIntent('loud stuff from the nineties');
  assert.deepEqual(withTempoCoverage(noTempo, { known: 10, total: 100 }), noTempo.chips, 'no tempo filter, nothing to say');

  const all = compileQueryIntent('fast loved bangers');
  assert.deepEqual(withTempoCoverage(all, { known: 5, total: 5 }), all.chips, 'when every track has a tempo there is nothing to qualify');
  assert.deepEqual(withTempoCoverage(all, { known: 0, total: 0 }), all.chips, 'an empty library says nothing');

  const search = compileQueryIntent('slow songs about bpm counters');
  const searchChips = withTempoCoverage(search, { known: 1, total: 2 });
  assert.ok(searchChips.some((chip) => chip.startsWith('“') && !chip.includes('tempo known')), 'a quoted search word is not a tempo chip');
}

// 2. The progress line.
{
  const base = { ...emptyAnalysisProgress(true), total: 58017, done: 12402, remaining: 45615, tracksPerHour: 2400, etaSeconds: 45615 * 1.5, state: 'running', coverage: { tempo: 1204, key: 902, loudness: 2395, dna: 12000 } };
  const running = describeAnalysis(base);
  assert.equal(running.counts, '12,402 of 58,017 tracks analysed');
  assert.equal(running.eta, 'about 19 hours left');
  assert.equal(running.status, 'Working in the background.');
  assert.equal(running.coverage, 'Tempo 1,204 · key 902 · loudness 2,395 · sound 12,000');
  assert.ok(Math.abs(running.fraction - 12402 / 58017) < 1e-9);

  assert.equal(describeAnalysis({ ...base, state: 'waiting', waitingFor: 'playback' }).status, 'Paused so the music keeps playing smoothly.');
  assert.equal(describeAnalysis({ ...base, state: 'waiting', waitingFor: 'scan' }).status, 'Paused while the library scans.');
  assert.equal(describeAnalysis({ ...base, state: 'waiting', waitingFor: 'battery' }).status, 'Paused on battery power.');
  assert.equal(describeAnalysis({ ...base, state: 'waiting', waitingFor: 'busy' }).status, 'Paused while the computer is busy.');
  assert.equal(describeAnalysis({ ...base, state: 'off', enabled: false }).status, 'Off.');
  assert.equal(describeAnalysis({ ...base, state: 'off', enabled: false }).eta, null, 'no estimate when it is off');
  const done = describeAnalysis({ ...base, state: 'done', done: 58017, remaining: 0, etaSeconds: null });
  assert.equal(done.status, 'Every track is analysed.');
  assert.equal(describeAnalysis({ ...base, state: 'done', done: 58010, remaining: 7, etaSeconds: null }).status, 'Done, apart from 7 tracks it could not read.');
  assert.equal(done.eta, null);
  assert.equal(describeAnalysis(emptyAnalysisProgress(false)).counts, 'No tracks yet');

  assert.equal(formatAnalysisEta(20), 'under a minute');
  assert.equal(formatAnalysisEta(40 * 60), 'about 40 minutes');
  assert.equal(formatAnalysisEta(31 * 3600), 'about 31 hours');
  assert.equal(formatAnalysisEta(5 * 86400), 'about 5 days');
  assert.equal(formatAnalysisEta(null), null);
}

// 3. The setting.
{
  const { SettingsStore } = await import(pathToFileURL(resolve('dist-electron/electron/settings.js')).href);
  const dir = resolve('tmp', 'analysis-ui-test');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  const onDisk = async () => JSON.parse(await readFile(file, 'utf8'));

  assert.equal(new SettingsStore(join(dir, 'fresh.json')).get().backgroundAnalysis, true, 'on by default');
  writeFileSync(file, JSON.stringify({ libraryRoots: [] }));
  assert.equal(new SettingsStore(file).get().backgroundAnalysis, true, 'an older settings file gains the setting, on');
  const store = new SettingsStore(file);
  store.set({ backgroundAnalysis: false });
  assert.equal(store.get().backgroundAnalysis, false);
  assert.equal((await onDisk()).backgroundAnalysis, false, 'saved when it changes');
  assert.equal(new SettingsStore(file).get().backgroundAnalysis, false, 'and read back');
  store.set({ theme: 'midnight' });
  assert.equal(store.get().backgroundAnalysis, false, 'other settings leave it alone');
  store.set({ backgroundAnalysis: 'nope' });
  assert.equal(store.get().backgroundAnalysis, true, 'a stray value does not switch it off');
}

// 4. Wiring, pinned to the source the way the other settings tests do.
{
  const read = (path) => readFileSync(resolve(path), 'utf8');
  const main = read('electron/main.ts');
  assert.match(main, /if \(smokeMode \|\| libraryAnalysis\) return;/, 'smoke runs do not start it');
  assert.match(main, /libraryAnalysis\?\.noteScan\(p\);/, 'the scanner tells it when a scan is running');
  assert.match(main, /libraryAnalysis\?\.prioritize\(\[id\]\);[\s\S]*library\.recordPlay\(id\)/, 'a track that starts playing goes to the front');
  assert.match(main, /'backgroundAnalysis' in patch\) libraryAnalysis\?\.refresh\(\)/, 'the setting is picked up at once');
  assert.match(main, /ipcMain\.handle\('analysis:progress'/);
  assert.match(main, /libraryAnalysis\?\.reset\(\);/, 'a restored library starts a fresh list');
  const stop = main.indexOf('void libraryAnalysis?.stop();');
  const close = main.indexOf('library?.close();', stop);
  assert.ok(stop > 0 && close > stop, 'results are written before the library closes at quit');
  assert.match(main, /killAllAnalysisFfmpeg\(\);/, 'no ffmpeg outlives the app');

  const settings = read('src/components/views/SettingsView.tsx');
  assert.match(settings, /saveSettings\(\{ backgroundAnalysis \}\)\.then\(acceptSettings\)/);
  assert.match(settings, /api\.getAnalysisProgress\(\)/);

  const palette = read('src/components/QuickPlayPalette.tsx');
  assert.match(palette, /withTempoCoverage\(intent, \{ known: progress\.coverage\.tempo, total: progress\.total \}\)/);
}

console.log('[analysis-ui] PASS');
