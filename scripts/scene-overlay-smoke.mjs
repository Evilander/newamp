// Scene overlay gate: bundles the real scene-overlay runtime + all registered
// scenes (scripts/scene-probe-entry.ts) with esbuild, runs them in an Electron
// window with a real WebGL2 context, and asserts EVERY scene:
//   1. compiles + links,
//   2. paints non-black pixels on an energetic frame,
//   3. visibly reacts to audio (energetic vs silent frames differ),
//   4. moves over time (two energetic frames apart in time differ).
// Run with: npm run smoke:scene-overlay

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const smokeRoot = resolve('tmp', 'scene-overlay-smoke');
const hardTimeout = setTimeout(() => fail(new Error('scene overlay smoke timed out')), 90000);

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('no-sandbox');

void app.whenReady().then(run).catch(fail);

async function run() {
  await mkdir(smokeRoot, { recursive: true });
  const bundlePath = join(smokeRoot, 'scene-probe.js');
  await build({
    entryPoints: [resolve('scripts', 'scene-probe-entry.ts')],
    bundle: true,
    format: 'iife',
    outfile: bundlePath,
    logLevel: 'silent',
  });

  const htmlPath = join(smokeRoot, 'probe.html');
  await writeFile(
    htmlPath,
    '<!doctype html><meta charset="utf-8"><title>scene probe</title><body><script src="./scene-probe.js"></script></body>',
    'utf8',
  );

  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: false } });
  await win.loadURL(pathToFileURL(htmlPath).toString());
  const result = await win.webContents.executeJavaScript('window.__sceneProbe()', true);
  win.close();

  assert.equal(result.webgl2, true, 'probe window must provide WebGL2');
  assert.ok(result.scenes.length >= 25, `expected at least 25 scenes, got ${result.scenes.length}`);

  const failures = [];
  for (const scene of result.scenes) {
    const problems = [];
    if (scene.error) problems.push(`threw: ${scene.error}`);
    if (!scene.compiled) problems.push('failed to compile/link');
    if (scene.litFraction <= 0.002) problems.push(`black frame (litFraction=${scene.litFraction.toFixed(4)})`);
    if (scene.reactivity <= 0.5) problems.push(`audio-deaf (reactivity=${scene.reactivity.toFixed(3)})`);
    if (scene.motion <= 0.1) problems.push(`static (motion=${scene.motion.toFixed(3)})`);
    if (problems.length) failures.push(`${scene.id}: ${problems.join('; ')}`);
  }

  console.log(JSON.stringify({ ok: failures.length === 0, sceneCount: result.scenes.length, scenes: result.scenes, failures }, null, 2));
  clearTimeout(hardTimeout);
  app.quit();
  process.exit(failures.length === 0 ? 0 : 1);
}

function fail(err) {
  clearTimeout(hardTimeout);
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  try { app.quit(); } catch { /* not ready */ }
  process.exit(1);
}
