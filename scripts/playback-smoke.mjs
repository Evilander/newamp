import ffmpeg from 'ffmpeg-static';
import { app, BrowserWindow, net, protocol } from 'electron';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playbackMode, transcodeToWavResponse } from '../dist-electron/electron/transcode.js';

const smokeRoot = resolve('tmp', 'playback-smoke');
const requestedFiles = process.argv.slice(2);
const fixtures = [
  {
    name: 'native.mp3',
    freq: 440,
    codec: ['-c:a', 'libmp3lame', '-q:a', '6'],
  },
  {
    name: 'fallback.wma',
    freq: 660,
    codec: ['-c:a', 'wmav2'],
  },
];

if (!ffmpeg) {
  console.error('ffmpeg-static did not resolve a binary for this platform');
  process.exit(1);
}

const hardTimeout = setTimeout(() => {
  fail(new Error('playback smoke timed out'));
}, 25000);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-rasterization');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'newamp',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

void app.whenReady().then(run).catch(fail);

async function run() {
  console.error('[newamp] electron ready');

  const targets = requestedFiles.length ? requestedFiles.map((file) => {
    const path = resolve(file);
    if (!existsSync(path)) throw new Error(`playback target does not exist: ${path}`);
    return { name: basename(path), path };
  }) : await createFixtureTargets();

  protocol.handle('newamp', (request) => {
    try {
      const url = new URL(request.url);
      const raw = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const filePath = resolve(raw);
      if (!existsSync(filePath)) return new Response('Not found', { status: 404 });
      if (playbackMode(filePath) === 'ffmpeg') return transcodeToWavResponse(filePath, request);
      return net.fetch(pathToFileURL(filePath).toString(), {
        bypassCustomProtocolHandlers: true,
      });
    } catch (err) {
      console.error('playback smoke protocol failed:', err);
      return new Response('Server Error', { status: 500 });
    }
  });

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadURL('data:text/html,<meta charset="utf-8"><title>Newamp playback smoke</title>');
  console.error('[newamp] hidden playback page loaded');

  const results = [];
  for (const target of targets) {
    const filePath = target.path;
    const normalized = filePath.replace(/\\/g, '/');
    const url = `newamp://track/${encodeURI(normalized).replace(/#/g, '%23')}`;
    console.error(`[newamp] probing ${target.name}`);
    const result = await win.webContents.executeJavaScript(playbackProbeSource(url), true);
    console.error(`[newamp] ${target.name} currentTime=${result.currentTime} ok=${result.ok}`);
    results.push({
      file: target.name,
      mode: playbackMode(filePath),
      url,
      ...result,
    });
  }

  win.close();
  app.quit();
  clearTimeout(hardTimeout);

  const ok = results.every((result) => result.ok);
  console.log(JSON.stringify({ ok, results }, null, 2));
  process.exit(ok ? 0 : 1);
}

async function createFixtureTargets() {
  await mkdir(smokeRoot, { recursive: true });
  for (const fixture of fixtures) {
    const target = join(smokeRoot, fixture.name);
    if (existsSync(target)) continue;
    runFfmpeg([
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${fixture.freq}:duration=1.2`,
      '-metadata',
      `title=${fixture.name}`,
      ...fixture.codec,
      target,
    ]);
  }

  console.error('[newamp] playback smoke fixtures ready');
  return fixtures.map((fixture) => ({
    name: fixture.name,
    path: join(smokeRoot, fixture.name),
  }));
}

function playbackProbeSource(url) {
  return `
    (async () => {
      const audio = new Audio(${JSON.stringify(url)});
      audio.muted = true;
      audio.preload = 'auto';
      const events = [];
      for (const name of ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'timeupdate', 'ended', 'error']) {
        audio.addEventListener(name, () => events.push(name));
      }
      const playProblem = await Promise.race([
        audio.play().then(() => null).catch((err) => String(err && err.message ? err.message : err)),
        new Promise((resolve) => setTimeout(() => resolve('audio.play() timed out'), 3500)),
      ]);
      if (playProblem) {
        return {
          ok: false,
          rejected: playProblem,
          currentTime: audio.currentTime,
          duration: Number.isFinite(audio.duration) ? audio.duration : null,
          readyState: audio.readyState,
          networkState: audio.networkState,
          events,
          error: audio.error ? { code: audio.error.code, message: audio.error.message } : null,
        };
      }
      const started = performance.now();
      while (performance.now() - started < 5000) {
        if (audio.currentTime > 0.15 || audio.ended) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const currentTime = audio.currentTime;
      const duration = Number.isFinite(audio.duration) ? audio.duration : null;
      const readyState = audio.readyState;
      const networkState = audio.networkState;
      const error = audio.error ? { code: audio.error.code, message: audio.error.message } : null;
      audio.pause();
      audio.src = '';
      return {
        ok: currentTime > 0.05 || events.includes('ended'),
        currentTime,
        duration,
        readyState,
        networkState,
        events,
        error,
      };
    })()
  `;
}

function runFfmpeg(args) {
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (${result.status})\n${result.stderr || result.stdout}`);
  }
}

function fail(err) {
  clearTimeout(hardTimeout);
  console.error(err instanceof Error ? err.message : err);
  try {
    app.quit();
  } catch {
    /* app may not be initialized */
  }
  process.exit(1);
}
