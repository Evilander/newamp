// Wrapped Live gate: the 30s chapter renderer paints every chapter with real
// pixels and the film visibly changes between chapters. (The record→MP4 leg
// is shared with Clip Studio and gated by smoke:clip-replay.)
// Run with: npm run smoke:wrapped-live

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const smokeRoot = resolve('tmp', 'wrapped-live-smoke');
const hardTimeout = setTimeout(() => fail(new Error('wrapped live smoke timed out')), 90000);

app.commandLine.appendSwitch('no-sandbox');
app.on('window-all-closed', () => {
  /* run() exits explicitly */
});

void app.whenReady().then(run).catch(fail);

async function run() {
  await mkdir(smokeRoot, { recursive: true });
  const bundlePath = join(smokeRoot, 'wrapped-probe.js');
  await build({
    entryPoints: [resolve('scripts', 'wrapped-live-probe-entry.ts')],
    bundle: true,
    format: 'iife',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const htmlPath = join(smokeRoot, 'probe.html');
  await writeFile(
    htmlPath,
    '<!doctype html><meta charset="utf-8"><title>wrapped probe</title><body><script src="./wrapped-probe.js"></script></body>',
    'utf8',
  );

  const win = new BrowserWindow({
    show: true,
    width: 320,
    height: 240,
    x: 0,
    y: 0,
    focusable: false,
    webPreferences: { backgroundThrottling: false, sandbox: false },
  });
  await win.loadURL(pathToFileURL(htmlPath).toString());
  const result = await win.webContents.executeJavaScript('window.__wrappedLiveProbe()', true);
  win.close();

  assert.equal(result.created, true, 'scene must construct');
  assert.equal(result.chapters.length, 6, 'six chapters sampled');
  const failures = [];
  for (const chapter of result.chapters) {
    if (chapter.litFraction < 0.02) {
      failures.push(`chapter ${chapter.index} nearly black (lit=${chapter.litFraction.toFixed(3)})`);
    }
  }
  if (result.interChapterDiff < 0.01) {
    failures.push(`chapters 1 and 3 are near-identical (diff=${result.interChapterDiff.toFixed(4)})`);
  }
  assert.equal(failures.length, 0, `wrapped-live scene problems:\n${failures.join('\n')}`);

  console.log(JSON.stringify({ ok: true, chapters: result.chapters, interChapterDiff: result.interChapterDiff }));
  clearTimeout(hardTimeout);
  app.exit(0);
}

function fail(err) {
  console.error('[wrapped-live-smoke] FAILED:', err);
  clearTimeout(hardTimeout);
  app.exit(1);
}
