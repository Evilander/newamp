// Electron half of scripts/gapless-pcm-boundary-test.mjs (run through
// scripts/gapless-pcm-app). Registers the SHIPPED gapless IPC
// (dist-electron/electron/gapless-transport.js) with a fixture resolver that
// mirrors main.ts's resolveExclusiveSource, serves local tracks through the
// shipped range responder for the deck path, loads the shipped preload, and
// runs each case from the plan in one hidden window. Captures land next to
// the plan as raw f32; the orchestrator does the analysis.

import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const marker = '[newamp-gapless-pcm] ';
const plan = JSON.parse(readFileSync(process.env.NEWAMP_GAPLESS_PLAN ?? '', 'utf8'));

protocol.registerSchemesAsPrivileged([
  { scheme: 'newamp-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'newamp', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Every check here reads the graph, not the device, and Chromium's fake output
// stream still pulls the graph in real time. So the fake stream is the default:
// a CI runner has no sound card, and nobody at a desk needs to hear the test
// tones. NEWAMP_SMOKE_AUDIBLE=1 plays them through the real device.
if (process.env.CI || process.env.NEWAMP_SMOKE_AUDIBLE !== '1') {
  app.commandLine.appendSwitch('disable-audio-output');
}
// Closing the probe window must not quit before the results are written.
app.on('window-all-closed', () => {});

const hardTimeout = setTimeout(() => fail(new Error('gapless PCM harness timed out')), plan.timeoutMs);
// No top-level await on ready: Electron holds `ready` until this module has
// finished evaluating.
void app.whenReady().then(run).catch(fail);

async function run() {
  const dist = (path) => pathToFileURL(join(repoRoot, 'dist-electron', path)).href;
  const { registerGaplessTransport } = await import(dist('electron/gapless-transport.js'));
  const { fileRangeResponse } = await import(dist('electron/audio-serve.js'));
  const { parseFile } = await import('music-metadata');

  ipcMain.on('app:get-info-sync', (event) => {
    event.returnValue = { platform: process.platform, appVersion: 'gapless-pcm-test' };
  });

  const fixtures = new Map(plan.fixtures.map((fixture) => [fixture.id, fixture]));
  registerGaplessTransport(ipcMain, async (trackId) => {
    const fixture = fixtures.get(trackId);
    if (!fixture) return null;
    // A slow library lookup, for a prepare that has to overtake a start.
    if (fixture.resolveDelayMs) await new Promise((resolve) => setTimeout(resolve, fixture.resolveDelayMs));
    // Same shape and fallbacks as main.ts: library values first, then the
    // music-metadata probe; a probe failure keeps the library values.
    const source = {
      trackId,
      path: fixture.path,
      sampleRate: fixture.sampleRate,
      bitDepth: null,
      channels: null,
      durationSec: fixture.duration,
      lossless: extname(fixture.path) === '.flac',
      dsd: false,
    };
    try {
      const meta = await parseFile(fixture.path, { duration: false, skipCovers: true });
      source.sampleRate = meta.format.sampleRate ?? fixture.sampleRate;
      source.channels = meta.format.numberOfChannels ?? null;
    } catch {
      /* corrupt fixture: keep the library values */
    }
    return source;
  });

  protocol.handle('newamp-app', (request) => {
    const name = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ''));
    const file = resolve(plan.pageDir, name);
    if (!file.startsWith(resolve(plan.pageDir))) return new Response('Forbidden', { status: 403 });
    const type = file.endsWith('.html') ? 'text/html' : 'text/javascript';
    try {
      return new Response(readFileSync(file), { headers: { 'Content-Type': type } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  protocol.handle('newamp', (request) => {
    const path = resolve(decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, '')));
    return fileRangeResponse(path, request);
  });

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(repoRoot, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (details) => {
    if (details.level === 'warning' || details.level === 'error') console.error(`[renderer] ${details.message}`);
  });
  await win.loadURL('newamp-app://app/probe.html');

  for (const spec of plan.cases) {
    console.error(`[gapless-pcm] running ${spec.name}`);
    const result = await win.webContents.executeJavaScript(`window.__gaplessProbe.run(${JSON.stringify(spec)})`, true);
    writeFileSync(join(plan.outDir, `${spec.name}.f32`), Buffer.from(result.pcm, 'base64'));
    delete result.pcm;
    writeFileSync(join(plan.outDir, `${spec.name}.json`), JSON.stringify(result, null, 2));
  }
  win.destroy();
  clearTimeout(hardTimeout);
  console.log(`${marker}${JSON.stringify({ ok: true, cases: plan.cases.length })}`);
  app.exit(0);
}

function fail(error) {
  clearTimeout(hardTimeout);
  console.error(error?.stack ?? String(error));
  console.log(`${marker}${JSON.stringify({ ok: false, error: String(error?.message ?? error) })}`);
  app.exit(1);
}
