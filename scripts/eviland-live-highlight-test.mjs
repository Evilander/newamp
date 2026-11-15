// Checks that the Live grade's luminance evening leaves the brightest pixels at
// full brightness (see eviland-live-highlight-probe.ts). Bundles the probe with
// esbuild and runs it in an Electron window; results land in
// tmp/eviland-live-highlight/. Run with: electron scripts/eviland-live-highlight-test.mjs

import { build } from 'esbuild';
import { butterchurnMegabufEsbuildPlugin } from './butterchurn-megabuf.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const outRoot = resolve('tmp', 'eviland-live-highlight');
const softwareGl = Boolean(process.env.CI) || process.env.NEWAMP_SOFTWARE_GL === '1';
const { app, BrowserWindow } = await import('electron');
const hardTimeout = setTimeout(() => fail(new Error('eviland live highlight test timed out')), softwareGl ? 240000 : 90000);

app.commandLine.appendSwitch('no-sandbox');
if (softwareGl) {
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('disable-gpu-watchdog');
}
// Closing the probe window must not quit the app before the exit code is chosen.
app.on('window-all-closed', () => {});
void app.whenReady().then(run).then(finish).catch(fail);

async function run() {
  await mkdir(outRoot, { recursive: true });
  await build({
    entryPoints: [resolve('scripts', 'eviland-live-highlight-probe.ts')],
    bundle: true,
    format: 'iife',
    outfile: join(outRoot, 'probe.js'),
    logLevel: 'silent',
    plugins: [butterchurnMegabufEsbuildPlugin()],
  });
  const htmlPath = join(outRoot, 'probe.html');
  await writeFile(htmlPath, '<!doctype html><meta charset="utf-8"><title>eviland live highlight probe</title><body><script src="./probe.js"></script></body>', 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: false } });
  try {
    await win.loadURL(pathToFileURL(htmlPath).toString());
    return await win.webContents.executeJavaScript('window.__evilandLiveHighlight()', true);
  } finally {
    win.destroy();
  }
}

function finish(result) {
  clearTimeout(hardTimeout);
  if (result.failures?.length) throw new Error(`${result.failures.length} check(s) failed:\n  ${result.failures.join('\n  ')}\n${JSON.stringify(result)}`);
  console.log('[eviland-live-highlight] PASS', JSON.stringify(result));
  app.exit(0);
}

function fail(error) {
  clearTimeout(hardTimeout);
  console.error('[eviland-live-highlight] FAIL');
  console.error(error?.stack ?? error);
  app.exit(1);
}
