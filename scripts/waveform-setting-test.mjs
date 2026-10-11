// The "Waveform seek bar" setting: on for everyone whose settings.json predates
// it, off only when explicitly saved off, and written to disk as it changes; and
// the main-process wiring that makes off stop the background work.
// Run: node scripts/waveform-setting-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp', 'waveform-setting-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const bundle = join(root, 'settings.bundle.mjs');
await build({
  entryPoints: [resolve('electron/settings.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', packages: 'external',
  outfile: bundle, logLevel: 'silent',
});
const { SettingsStore } = await import(pathToFileURL(bundle).href);
const onDisk = async (file) => JSON.parse(await readFile(file, 'utf8'));

// A new install, and a settings.json from before the setting existed.
{
  const fresh = join(root, 'fresh.json');
  assert.equal(new SettingsStore(fresh).get().waveformSeekBar, true, 'on by default');
  assert.equal((await onDisk(fresh)).waveformSeekBar, true, 'and written out');

  const old = join(root, 'old.json');
  await writeFile(old, JSON.stringify({ theme: 'classic', volume: 0.5 }));
  const store = new SettingsStore(old);
  assert.equal(store.get().waveformSeekBar, true, 'an older file gains the setting, on');
  assert.equal(store.get().volume, 0.5, 'and keeps everything else');
}

// Off sticks, through a reload.
{
  const file = join(root, 'toggle.json');
  const store = new SettingsStore(file);
  store.set({ waveformSeekBar: false });
  assert.equal(store.get().waveformSeekBar, false);
  assert.equal((await onDisk(file)).waveformSeekBar, false, 'saved the moment it changes');
  assert.equal(new SettingsStore(file).get().waveformSeekBar, false, 'and read back');
  store.set({ volume: 0.3 });
  assert.equal(store.get().waveformSeekBar, false, 'other settings leave it alone');
  store.set({ waveformSeekBar: true });
  assert.equal(new SettingsStore(file).get().waveformSeekBar, true, 'on again');
}

// Only a real false turns it off.
{
  for (const [index, value] of [0, null, 'false', 'off', [], {}].entries()) {
    const file = join(root, `junk-${index}.json`);
    await writeFile(file, JSON.stringify({ waveformSeekBar: value }));
    assert.equal(new SettingsStore(file).get().waveformSeekBar, true, `${JSON.stringify(value)} in the file means on`);
  }
  const file = join(root, 'junk-patch.json');
  const store = new SettingsStore(file);
  store.set({ waveformSeekBar: 'nope' });
  assert.equal(store.get().waveformSeekBar, true, 'a non-boolean patch does not switch it off');
}

// main.ts can't be loaded outside Electron, so its wiring is pinned as source.
{
  const main = await readFile(resolve('electron/main.ts'), 'utf8');
  const block = (start, end) => {
    const from = main.indexOf(start);
    assert.ok(from >= 0, `${start} is in main.ts`);
    const to = main.indexOf(end, from);
    assert.ok(to > from, `${end} follows ${start}`);
    return main.slice(from, to);
  };

  const quit = block("app.on('will-quit', (event) => {", '\n});');
  assert.match(quit, /killAllWaveformFfmpeg\(\);/, 'quit stops the waveform decodes with the other ffmpeg users');
  assert.doesNotMatch(main, /app\.on\('will-quit', killAllWaveformFfmpeg\)/, 'and there is no second quit listener for it');

  const set = block("ipcMain.handle('settings:set'", '\n  });');
  assert.match(set, /'waveformSeekBar' in patch[^\n]*waveformSeekBar === false[\s\S]*cancelWaveformWork\(\)/, 'switching the waveform off cancels the running and queued decodes');

  const request = block("ipcMain.handle('tracks:waveform'", '\n  });');
  assert.match(request, /waveformSeekBar === false\) return null/, 'a request that was on its way when the setting went off is refused');
}

// The row in Settings goes through the same serialized save as its neighbours.
{
  const view = await readFile(resolve('src/components/views/SettingsView.tsx'), 'utf8');
  assert.match(view, /checked=\{settings\.waveformSeekBar !== false\}/, 'Settings has a Seek bar row, on unless saved off');
  assert.match(view, /saveSettings\(\{ waveformSeekBar: e\.target\.checked \}\)\.then\(acceptSettings\)/);
  assert.equal(await readFile(resolve('src/components/WaveformSeekSetting.tsx'), 'utf8').catch(() => null), null, 'there is no second, unmounted copy of the row');
}

console.log('waveform-setting-test: ok');
