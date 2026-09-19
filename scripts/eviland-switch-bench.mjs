// How long the frame that changes Eviland's look takes, on the real GPU.
// Prints first-use vs cached draw times for every engine scene and the cost
// of Butterchurn preset loads (Eviland Live). A measurement, not a gate.
// Run: npm run bench:eviland-switch
import { build } from 'esbuild';
import { butterchurnMegabufEsbuildPlugin } from './butterchurn-megabuf.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';

const outRoot = resolve('tmp', 'eviland-switch-bench');
// A fresh profile per run: Chromium caches compiled GPU programs on disk, and
// a warm cache hides exactly the first-use compile cost this measures.
app.setPath('userData', join(outRoot, `profile-${Date.now()}`));
app.on('window-all-closed', () => {});
const hardTimeout = setTimeout(() => {
  console.error('eviland switch bench timed out');
  app.exit(1);
}, 180000);

void app.whenReady().then(async () => {
  try {
    await mkdir(outRoot, { recursive: true });
    await build({
      entryPoints: [resolve('scripts', 'eviland-switch-probe.ts')],
      bundle: true,
      format: 'iife',
      outfile: join(outRoot, 'probe.js'),
      logLevel: 'silent',
      plugins: [butterchurnMegabufEsbuildPlugin()],
    });
    const html = join(outRoot, 'probe.html');
    await writeFile(html, '<!doctype html><meta charset="utf-8"><body><script src="./probe.js"></script></body>', 'utf8');
    const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: false } });
    await win.loadURL(pathToFileURL(html).toString());
    const engine = await win.webContents.executeJavaScript('window.__evilandSwitchBench.engine()', true);
    const live = await win.webContents.executeJavaScript('window.__evilandSwitchBench.live()', true);
    win.destroy();
    console.log(JSON.stringify({ engine, live }, null, 2));
    clearTimeout(hardTimeout);
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
