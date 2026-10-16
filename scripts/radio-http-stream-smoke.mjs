// Plays a plain-http audio stream inside a real renderer page that carries the
// app's own Content-Security-Policy (read from index.html), served from the
// same kind of privileged custom scheme as the packaged app. The stream server
// sends no CORS headers and no Content-Length, like most internet radio.
//
//   - with the shipped CSP, tuneStation() reports playback started and the
//     clock moves,
//   - with http: taken out of media-src, the same call fails and the stream
//     server never sees a request (so the CSP, not the network, is what the
//     http: source decides).
//
// Run with: npm run smoke:radio-http-stream  (needs no build)

import { app, BrowserWindow, protocol } from 'electron';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

protocol.registerSchemesAsPrivileged([
  { scheme: 'newamp-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const userData = mkdtempSync(join(tmpdir(), 'newamp-radio-http-'));
app.setPath('userData', userData);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => undefined);

const watchdog = setTimeout(() => {
  console.error('[radio-http-stream-smoke] FAIL: timed out');
  app.exit(1);
}, 90_000);

function silenceWav() {
  // 8 kHz mono 16-bit PCM. The data length claims far more than we send, the
  // way a live stream's header does.
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(0x7fffffff, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(0x7fffffff, 40);
  return header;
}

async function main() {
  const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const shippedCsp = indexHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
  assert.ok(shippedCsp, 'index.html must carry a CSP');
  assert.match(shippedCsp, /media-src[^;]*\shttp:/, 'the shipped CSP allows http: media');
  const withoutHttp = shippedCsp.replace(/(media-src[^;]*?)\shttp:/, '$1');
  assert.doesNotMatch(withoutHttp, /media-src[^;]*\shttp:/);

  const bundle = await build({
    entryPoints: [resolve('src/api/radiobrowser.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'radio',
    write: false,
    logLevel: 'silent',
    alias: { '@shared': resolve('shared') },
  });
  const script = bundle.outputFiles[0].text;

  let streamRequests = 0;
  const wav = silenceWav();
  const server = createServer((req, res) => {
    streamRequests++;
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'icy-name': 'Probe FM' });
    res.write(wav);
    const silence = Buffer.alloc(16000);
    res.write(silence);
    const timer = setInterval(() => res.write(Buffer.alloc(1600)), 100);
    req.on('close', () => clearInterval(timer));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();

  let csp = shippedCsp;
  await app.whenReady();
  protocol.handle('newamp-app', (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/radio.js') return new Response(script, { headers: { 'Content-Type': 'text/javascript' } });
    return new Response(
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><title>radio</title><script src="radio.js"></script>`,
      { headers: { 'Content-Type': 'text/html' } },
    );
  });

  async function attempt(policy) {
    csp = policy;
    streamRequests = 0;
    const win = new BrowserWindow({ show: false, webPreferences: { autoplayPolicy: 'no-user-gesture-required' } });
    await win.loadURL('newamp-app://app/index.html');
    const outcome = await win.webContents.executeJavaScript(`
      (async () => {
        const audio = new Audio();
        const result = await radio.tuneStation(audio, { name: 'Probe FM', url: 'http://127.0.0.1:${port}/stream' });
        await new Promise((done) => setTimeout(done, 1500));
        return { result, currentTime: audio.currentTime, paused: audio.paused };
      })()
    `);
    const seen = streamRequests;
    win.destroy();
    return { ...outcome, seen };
  }

  const allowed = await attempt(shippedCsp);
  assert.deepEqual(allowed.result, { ok: true }, `shipped CSP should let an http stream start: ${JSON.stringify(allowed)}`);
  assert.ok(allowed.currentTime > 0.3 && !allowed.paused, `the stream should be playing: ${JSON.stringify(allowed)}`);
  assert.ok(allowed.seen >= 1, 'the stream server should have been reached');

  const blocked = await attempt(withoutHttp);
  assert.equal(blocked.result.ok, false, `without http: in media-src the stream must be refused: ${JSON.stringify(blocked)}`);
  assert.equal(blocked.seen, 0, 'the CSP stops the request before it leaves the renderer');

  server.close();
  console.log(JSON.stringify({ ok: true, playedSeconds: Number(allowed.currentTime.toFixed(2)), blockedWithoutHttp: true }));
}

let code = 0;
main()
  .catch((err) => {
    console.error('[radio-http-stream-smoke] FAIL:', err);
    code = 1;
  })
  .finally(async () => {
    clearTimeout(watchdog);
    await rm(userData, { recursive: true, force: true }).catch(() => undefined);
    app.exit(code);
  });
