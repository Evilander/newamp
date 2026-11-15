// The Cymatic Plate's re-tune: on the frame the twelfth counted kick lands the
// picture is still the old figure, hard kick or soft (see
// eviland-cymatic-kick-probe.ts). Bundles the probe with esbuild and runs it in
// an Electron window with a real WebGL2 context; results land in
// tmp/eviland-cymatic-kick/. Run with: npx electron scripts/eviland-cymatic-kick-test.mjs

import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const outRoot = resolve('tmp', 'eviland-cymatic-kick');
const softwareGl = Boolean(process.env.CI) || process.env.NEWAMP_SOFTWARE_GL === '1';
const { app, BrowserWindow } = await import('electron');
const hardTimeout = setTimeout(() => fail(new Error('eviland cymatic kick test timed out')), softwareGl ? 240000 : 90000);

app.commandLine.appendSwitch('no-sandbox');
if (softwareGl) {
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('disable-gpu-watchdog');
}
// Closing the probe window must not quit the app before the exit code is chosen.
app.on('window-all-closed', () => {});
// No top-level await on ready: Electron holds `ready` until this module
// finishes evaluating, so awaiting it here deadlocks the process.
void app.whenReady().then(run).then(finish).catch(fail);

async function run() {
  await mkdir(outRoot, { recursive: true });
  await build({
    entryPoints: [resolve('scripts', 'eviland-cymatic-kick-probe.ts')],
    bundle: true,
    format: 'iife',
    outfile: join(outRoot, 'probe.js'),
    logLevel: 'silent',
  });
  const htmlPath = join(outRoot, 'probe.html');
  await writeFile(htmlPath, '<!doctype html><meta charset="utf-8"><title>eviland cymatic kick probe</title><body><script src="./probe.js"></script></body>', 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: false } });
  try {
    await win.loadURL(pathToFileURL(htmlPath).toString());
    return await win.webContents.executeJavaScript('window.__cymaticKick()', true);
  } finally {
    win.destroy();
  }
}

function finish(result) {
  clearTimeout(hardTimeout);
  if (result.failures?.length) throw new Error(`${result.failures.length} check(s) failed:\n  ${result.failures.join('\n  ')}\n${JSON.stringify(result)}`);
  console.log('[eviland-cymatic-kick] PASS', JSON.stringify(result));
  app.exit(0);
}

function fail(error) {
  clearTimeout(hardTimeout);
  console.error('[eviland-cymatic-kick] FAIL');
  console.error(error?.stack ?? error);
  app.exit(1);
}
