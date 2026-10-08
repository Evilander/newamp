// Physarum simulation gate: bundles eviland-physarum-probe.ts with esbuild,
// runs it in an Electron window with a real WebGL2 context, and asserts on
// rendered pixels: lit without white-out, a branching network with loops
// rather than blobs, all three species visible, growth from the seed colonies,
// attraction to bright feedback, a dim standing network in silence, and no
// wash-out when its output feeds back into itself.
// Captures and a JSON summary land in tmp/eviland-physarum/.
//
// Run with: npm run test:eviland-physarum
// Headless hosts without Electron can point NEWAMP_PLAYWRIGHT_MODULE at a
// Playwright install and run this file with plain node.

import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const outRoot = resolve('tmp', 'eviland-physarum');
const probeCall = 'window.__physarumProbe()';
const playwrightModule = process.env.NEWAMP_PLAYWRIGHT_MODULE;
const softwareGl = Boolean(process.env.CI) || process.env.NEWAMP_SOFTWARE_GL === '1';

let electronApp = null;
const hardTimeout = setTimeout(() => fail(new Error('eviland physarum test timed out')), 240000);

if (playwrightModule) {
  void runPlaywright().then(finish).catch(fail);
} else {
  const { app } = await import('electron');
  electronApp = app;
  app.commandLine.appendSwitch('no-sandbox');
  if (softwareGl) {
    app.commandLine.appendSwitch('use-gl', 'angle');
    app.commandLine.appendSwitch('use-angle', 'swiftshader');
    app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  }
  app.on('window-all-closed', () => {});
  // No top-level await on ready: Electron holds `ready` until this module
  // finishes evaluating, so awaiting it here deadlocks the process.
  void app.whenReady().then(runElectron).then(finish).catch(fail);
}

async function bundleProbe() {
  await mkdir(outRoot, { recursive: true });
  await build({
    entryPoints: [resolve('scripts', 'eviland-physarum-probe.ts')],
    bundle: true,
    format: 'iife',
    outfile: join(outRoot, 'probe.js'),
    logLevel: 'silent',
  });
  const htmlPath = join(outRoot, 'probe.html');
  await writeFile(htmlPath, '<!doctype html><meta charset="utf-8"><title>physarum probe</title><body><script src="./probe.js"></script></body>', 'utf8');
  return pathToFileURL(htmlPath).toString();
}

async function runElectron() {
  const { BrowserWindow } = await import('electron');
  const url = await bundleProbe();
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: false } });
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') console.error(event.message);
  });
  try {
    await win.loadURL(url);
    return await win.webContents.executeJavaScript(probeCall, true);
  } finally {
    win.destroy();
  }
}

async function runPlaywright() {
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  const url = await bundleProbe();
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') console.error(message.text());
    });
    await page.goto(url);
    return await page.evaluate(probeCall);
  } finally {
    await browser.close();
  }
}

async function finish(result) {
  for (const capture of result.captures) {
    await writeFile(join(outRoot, `${capture.name}.png`), Buffer.from(capture.png.split(',')[1], 'base64'));
  }
  result = { ...result, captures: result.captures.map((capture) => `${capture.name}.png`) };
  await writeFile(join(outRoot, 'summary.json'), JSON.stringify(result, null, 2), 'utf8');
  if (result.failures.length) {
    throw new Error(`${result.failures.length} check(s) failed:\n  ${result.failures.join('\n  ')}`);
  }
  clearTimeout(hardTimeout);
  console.log('[eviland-physarum] PASS', JSON.stringify(result));
  if (electronApp) electronApp.exit(0);
  else process.exit(0);
}

function fail(error) {
  clearTimeout(hardTimeout);
  console.error('[eviland-physarum] FAIL');
  console.error(error?.stack ?? error);
  if (electronApp) electronApp.exit(1);
  else process.exit(1);
}
