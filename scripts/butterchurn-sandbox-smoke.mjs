import { app, BrowserWindow, protocol } from 'electron';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

// Deterministic, audio-free check that the sandboxed Butterchurn frame really
// works: load butterchurn-iframe.html under its real (eval-permitting) CSP via
// the newamp-app:// protocol, post the init message, and confirm the frame
// reports `mounted` — proving (1) the iframe CSP allows the preset-shader eval,
// (2) butterchurn + presets load through the protocol, and (3) createVisualizer
// succeeds. Needs a display + WebGL, so it runs locally / in the release
// per-OS legs, not in the headless push CI.

const repoRoot = resolve('.');
const distDir = resolve(repoRoot, 'dist');
const iframeHtml = resolve(distDir, 'butterchurn-iframe.html');

if (!existsSync(iframeHtml)) {
  console.error(`[butterchurn-sandbox-smoke] missing ${iframeHtml} — run \`npm run build\` first`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'newamp-app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function fail(message, extra) {
  console.error(`[butterchurn-sandbox-smoke] FAIL: ${message}`, extra ?? '');
  if (app.isReady()) app.exit(1);
  else process.exit(1);
}

app.whenReady().then(async () => {
  protocol.handle('newamp-app', async (request) => {
    try {
      const url = new URL(request.url);
      const rawPath = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html';
      const filePath = resolve(distDir, rawPath);
      const rel = relative(distDir, filePath);
      if (rel.startsWith('..')) return new Response('Forbidden', { status: 403 });
      if (!existsSync(filePath)) return new Response('Not found', { status: 404 });
      return new Response(await readFile(filePath), {
        status: 200,
        headers: { 'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream' },
      });
    } catch (err) {
      return new Response(`Server Error: ${err}`, { status: 500 });
    }
  });

  const win = new BrowserWindow({
    width: 640,
    height: 360,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, webSecurity: true },
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });

  try {
    await win.loadURL('newamp-app://app/butterchurn-iframe.html');
  } catch (err) {
    return fail('iframe page failed to load', err);
  }

  // Post init and collect the frame messages the module posts back to `parent`
  // (which is `window` when the page is loaded top-level).
  let types;
  try {
    types = await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const seen = [];
        window.addEventListener('message', (e) => {
          if (e && e.data && typeof e.data === 'object' && typeof e.data.type === 'string') seen.push(e.data.type);
        });
        window.postMessage({ type: 'init', sampleRate: 44100, dpr: 1 }, '*');
        setTimeout(() => resolve(seen), 7000);
      });
    `);
  } catch (err) {
    return fail('executeJavaScript probe threw', err);
  }

  // The frame's own 'failed'/'mounted' message is the source of truth (its
  // catch posts 'failed' if the eval is blocked). The console scan is a
  // secondary guard for a genuine CSP *violation* — NOT Electron's benign
  // dev-mode "policy with unsafe-eval enabled" warning, which the iframe
  // triggers on purpose and must be ignored.
  const evalBlocked = consoleErrors.some((line) =>
    /Refused to evaluate|is not an allowed source of script|EvalError/i.test(line),
  );
  if (evalBlocked) return fail('a real CSP/eval violation fired inside the sandboxed frame', consoleErrors);
  if (types.includes('failed')) return fail('frame reported butterchurn startup failure', { types, consoleErrors });
  if (!types.includes('mounted')) {
    return fail('frame did not report butterchurn mounted within timeout', { types, consoleErrors });
  }

  console.log(JSON.stringify({ ok: true, types }, null, 2));
  app.exit(0);
});

// Hard cap so a hung GPU/compile never wedges CI.
setTimeout(() => fail('overall timeout'), 30000);
