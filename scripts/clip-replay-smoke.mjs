// Clip Studio gate: proves the retroactive replay pipeline end to end —
//   1. the WebCodecs ring encodes a live canvas (frames are NOT blank),
//   2. keyframe-aligned eviction keeps roughly the configured window,
//   3. saveClip() muxes a playable WebM (mediabunny),
//   4. finishWebmToMp4 produces H.264 MP4 via the bundled ffmpeg,
//   5. the MP4's duration matches the retained window and a decoded frame
//      has real luminance.
// Run with: npm run smoke:clip-replay  (build:electron must have run — the
// node side imports dist-electron/electron/video-mux.js)

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const smokeRoot = resolve('tmp', 'clip-replay-smoke');
const hardTimeout = setTimeout(() => fail(new Error('clip replay smoke timed out')), 120000);

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('no-sandbox');

// The probe window closes before the ffmpeg finishing steps run — without
// this listener Electron's default quit-on-last-window-closed kills the
// process (exit 0!) mid-mux.
app.on('window-all-closed', () => {
  /* keep running; run() exits explicitly */
});

void app.whenReady().then(run).catch(fail);

async function run() {
  await mkdir(smokeRoot, { recursive: true });
  const bundlePath = join(smokeRoot, 'replay-probe.js');
  await build({
    entryPoints: [resolve('scripts', 'replay-probe-entry.ts')],
    bundle: true,
    format: 'iife',
    outfile: bundlePath,
    logLevel: 'silent',
  });

  const htmlPath = join(smokeRoot, 'probe.html');
  await writeFile(
    htmlPath,
    '<!doctype html><meta charset="utf-8"><title>replay probe</title><body><script src="./replay-probe.js"></script></body>',
    'utf8',
  );

  // show:false still renders (rAF flows for hidden-but-unoccluded windows in
  // smokes elsewhere in this repo); backgroundThrottling off to be safe.
  // Shown (tiny, unfocusable): canvas.captureStream frame delivery is
  // compositor-fed and stalls in fully hidden windows.
  const win = new BrowserWindow({
    show: true,
    width: 320,
    height: 200,
    x: 0,
    y: 0,
    focusable: false,
    alwaysOnTop: false,
    webPreferences: { backgroundThrottling: false, sandbox: false },
  });
  await win.loadURL(pathToFileURL(htmlPath).toString());
  const result = await win.webContents.executeJavaScript('window.__replayProbe()', true);
  win.close();

  assert.equal(result.supported, true, 'WebCodecs + MediaStreamTrackProcessor must be available');
  console.log('[clip-replay-smoke] ring stats:', JSON.stringify(result.stats));
  assert.ok(result.blobSize > 20_000, `WebM should be non-trivial, got ${result.blobSize} bytes`);

  const webm = Buffer.from(result.base64, 'base64');
  const webmPath = join(smokeRoot, 'clip.webm');
  await writeFile(webmPath, webm);

  const { finishWebmToMp4 } = await import(
    pathToFileURL(resolve('dist-electron', 'electron', 'video-mux.js')).toString()
  );
  const mp4Path = join(smokeRoot, 'clip.mp4');
  await finishWebmToMp4(webm, mp4Path);

  const { resolveFfmpegPath } = await import(
    pathToFileURL(resolve('dist-electron', 'electron', 'transcode.js')).toString()
  );
  const ffmpeg = resolveFfmpegPath();

  // Stream + duration assertions from ffmpeg's own stderr.
  const info = await captureStderr(ffmpeg, ['-i', mp4Path]);
  assert.match(info, /Video: h264/, 'MP4 must carry H.264 video');
  const durationMatch = info.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  assert.ok(durationMatch, 'ffmpeg must report a duration');
  const seconds =
    Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
  assert.ok(
    seconds >= 2.5 && seconds <= 7,
    `clip duration should be ~the 4s window (+keyframe slack), got ${seconds}s`,
  );

  // Non-blank proof: decode one mid-clip frame to raw gray and check the mean.
  const gray = await captureStdout(ffmpeg, [
    '-ss', '1', '-i', mp4Path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ]);
  assert.ok(gray.length > 10_000, 'decoded frame should have pixels');
  let sum = 0;
  for (const byte of gray) sum += byte;
  const mean = sum / gray.length;
  assert.ok(mean > 24, `decoded frame should not be black (mean luma ${mean.toFixed(1)})`);

  console.log(
    JSON.stringify({
      ok: true,
      webmBytes: webm.length,
      mp4Seconds: seconds,
      meanLuma: Number(mean.toFixed(1)),
    }),
  );
  clearTimeout(hardTimeout);
  app.exit(0);
}

function captureStderr(bin, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let out = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    // `ffmpeg -i file` exits non-zero by design (no output specified).
    child.on('close', () => resolvePromise(out));
  });
}

function captureStdout(bin, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg frame decode exited ${code}`));
    });
  });
}

function fail(err) {
  console.error('[clip-replay-smoke] FAILED:', err);
  clearTimeout(hardTimeout);
  app.exit(1);
}
