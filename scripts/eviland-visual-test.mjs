// Eviland renderer gate: bundles the real engine (or the real Butterchurn +
// Live pipeline with --live) with esbuild, runs it in an Electron window with
// a real WebGL2 context, and asserts on rendered pixels rather than on config
// numbers:
//   (default)    appearance controls change pixels, dye visibility is
//                independent of the feedback field, trails and motion hold
//                across 30/60/120 fps, audio changes never teleport a scene
//   --diversity  every archetype paints a structured frame, and no two
//                archetypes share both geometry and motion under one palette
//   --live       Eviland sources persist in MilkDrop's feedback, the selected
//                palette owns the final image, resize keeps the frame intact
// Captures and a contact sheet land in tmp/eviland-visual-tests/.
//
// Run with: npm run test:eviland-visual | test:eviland-diversity | test:eviland-live
// Headless hosts without Electron can point NEWAMP_PLAYWRIGHT_MODULE at a
// Playwright install and run this file with plain node.

import { build } from 'esbuild';
import { butterchurnMegabufEsbuildPlugin } from './butterchurn-megabuf.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const mode = process.argv.includes('--live') ? 'live' : process.argv.includes('--diversity') ? 'diversity' : 'controls';
const outRoot = resolve('tmp', 'eviland-visual-tests');
const probeCall = mode === 'live' ? 'window.__evilandLiveProbe()' : `window.__evilandVisualProbe.${mode}()`;
const playwrightModule = process.env.NEWAMP_PLAYWRIGHT_MODULE;

let electronApp = null;
const hardTimeout = setTimeout(() => fail(new Error(`eviland visual ${mode} test timed out`)), 240000);

if (playwrightModule) {
  void runPlaywright().then(finish).catch(fail);
} else {
  const { app } = await import('electron');
  electronApp = app;
  app.commandLine.appendSwitch('no-sandbox');
  // Closing the probe window must not quit the app before finish() has
  // written the captures and chosen the exit code.
  app.on('window-all-closed', () => {});
  // No top-level await on ready: Electron holds `ready` until this module
  // finishes evaluating, so awaiting it here deadlocks the process.
  void app.whenReady().then(runElectron).then(finish).catch(fail);
}

async function bundleProbe() {
  await mkdir(outRoot, { recursive: true });
  const bundlePath = join(outRoot, `${mode}-probe.js`);
  await build({
    entryPoints: [resolve('scripts', mode === 'live' ? 'eviland-live-probe.ts' : 'eviland-visual-probe.ts')],
    bundle: true,
    format: 'iife',
    outfile: bundlePath,
    logLevel: 'silent',
    plugins: [butterchurnMegabufEsbuildPlugin()],
  });
  const htmlPath = join(outRoot, `${mode}-probe.html`);
  await writeFile(
    htmlPath,
    `<!doctype html><meta charset="utf-8"><title>eviland ${mode} probe</title><body><script src="./${mode}-probe.js"></script></body>`,
    'utf8',
  );
  return pathToFileURL(htmlPath).toString();
}

async function runElectron() {
  const { BrowserWindow } = await import('electron');
  const url = await bundleProbe();
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: false } });
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
  if (result.snapshot) {
    await writeFile(join(outRoot, 'live.png'), Buffer.from(result.snapshot.split(',')[1], 'base64'));
    delete result.snapshot;
  }
  if (result.captures) {
    for (const capture of result.captures) {
      for (let i = 0; i < capture.pngs.length; i++) {
        await writeFile(join(outRoot, `${capture.name}-${i}.png`), Buffer.from(capture.pngs[i].split(',')[1], 'base64'));
      }
    }
    const rows = result.captures
      .map((capture) => `<figure><figcaption>${capture.name}</figcaption>${capture.pngs.map((_, i) => `<img src="${capture.name}-${i}.png">`).join('')}</figure>`)
      .join('');
    await writeFile(
      join(outRoot, 'contact-sheet.html'),
      `<!doctype html><meta charset="utf-8"><title>Eviland geometry and motion</title><style>body{background:#151515;color:#eee;font:14px sans-serif}main{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}figure{margin:0}img{width:32%}</style><p>${result.caption ?? ''}</p><main>${rows}</main>`,
      'utf8',
    );
    result = { ...result, captures: result.captures.map((capture) => ({ name: capture.name, frames: capture.pngs.length })) };
  }
  await writeFile(join(outRoot, `${mode}.json`), JSON.stringify(result, null, 2), 'utf8');
  if (result.failures?.length) {
    throw new Error(`${result.failures.length} check(s) failed:\n  ${result.failures.join('\n  ')}`);
  }
  clearTimeout(hardTimeout);
  console.log(`[eviland-visual-${mode}] PASS`, JSON.stringify(result));
  if (electronApp) electronApp.exit(0);
  else process.exit(0);
}

function fail(error) {
  clearTimeout(hardTimeout);
  console.error(`[eviland-visual-${mode}] FAIL`);
  console.error(error?.stack ?? error);
  if (electronApp) electronApp.exit(1);
  else process.exit(1);
}
