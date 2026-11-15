// Renders Eviland scenes to PNGs for a look while writing one: each scene over
// black, in three palettes (green, sunset, triadic) at silence, calm and loud.
// Run: npx electron scripts/scene-shot.mjs <scene-id>[,<scene-id>...] [out-dir]
// The default out-dir is tmp/scene-shots.
import { build } from 'esbuild';
import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const ids = (args[0] ?? '').split(',').filter(Boolean);
const outDir = resolve(args[1] ?? join('tmp', 'scene-shots'));
const hardTimeout = setTimeout(() => fail(new Error('scene shot timed out')), 120000);

app.commandLine.appendSwitch('no-sandbox');
// Closing the window must not quit before the files are written.
app.on('window-all-closed', () => undefined);
void app.whenReady().then(run).catch(fail);

async function run() {
  if (!ids.length) throw new Error('usage: npx electron scripts/scene-shot.mjs <scene-id>[,<scene-id>...] [out-dir]');
  await mkdir(outDir, { recursive: true });
  const bundlePath = join(outDir, 'scene-shot.js');
  await build({ entryPoints: [resolve('scripts', 'scene-shot-entry.ts')], bundle: true, format: 'iife', outfile: bundlePath, logLevel: 'silent' });
  const htmlPath = join(outDir, 'shot.html');
  await writeFile(htmlPath, '<!doctype html><meta charset="utf-8"><title>scene shot</title><body><script src="./scene-shot.js"></script></body>', 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: false } });
  await win.loadURL(pathToFileURL(htmlPath).toString());
  const shots = await win.webContents.executeJavaScript(`window.__sceneShot(${JSON.stringify(ids)})`, true);
  for (const shot of shots) {
    const file = join(outDir, `${shot.name}.png`);
    await writeFile(file, Buffer.from(shot.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
    console.log(file);
  }
  win.close();
  clearTimeout(hardTimeout);
  app.quit();
  process.exit(0);
}

function fail(err) {
  console.error(err);
  clearTimeout(hardTimeout);
  app.exit(1);
  process.exit(1);
}
