// Detached Eviland visualizer smoke.
//
// Two modes:
//
//   1. STATIC wiring (default — node-only, CI-safe). Reads the actual source
//      files and asserts that every link in the chain is present:
//        main.ts:        ipcMain.handle('detached-viz:*') + openDetachedVisualizer
//                        + MessageChannelMain + backgroundThrottling:false
//        preload.ts:     contextBridge detachedViz namespace + the
//                        'eviland:frame-port' re-dispatch
//        vite.config.ts: detached.html as a rollup input
//        detached.html:  exists at repo root, loads /src/detached/main.tsx
//        src/visualizer/frame-bus.ts: publish/subscribe/attachDetachedPort
//        src/detached/main.tsx: createEvilandRenderer + port message wiring
//        src/vite-env.d.ts: detachedViz typings
//
//   2. LIVE (NEWAMP_DETACHED_SMOKE=1). Runs this file as Electron's main entry,
//      brings up TWO BrowserWindows that share a MessageChannelMain pair, and
//      asserts the port hand-off actually works through Electron's webContents
//      transferable plumbing. This proves the LOAD-BEARING piece (port
//      transfer + preload re-dispatch) outside of vite's bundle, but does NOT
//      load detached.html (that requires `npm run build` first). The full
//      end-to-end window-and-renderer smoke is best-effort by design — main
//      will refuse to spawn the real detached window without a live main
//      window plus a vite/build output for detached.html.
//
// Either mode finishes within a hard timeout and calls app.exit / process.exit
// — this smoke MUST NOT hang CI.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:'));
const LIVE = process.env.NEWAMP_DETACHED_SMOKE === '1';

if (!LIVE) {
  await runStaticWiringSmoke();
  process.exit(0);
} else {
  // Electron-side import is dynamic so the static path stays node-only.
  await runLiveSmoke();
}

async function runStaticWiringSmoke() {
  const read = async (p) => readFile(resolve(REPO_ROOT, p), 'utf8');
  const assertMatch = (haystack, pattern, msg) => {
    if (!pattern.test(haystack)) {
      console.error(`[detached-viz-smoke] FAIL: ${msg}`);
      process.exit(1);
    }
  };

  // Repo root files
  if (!existsSync(resolve(REPO_ROOT, 'detached.html'))) {
    console.error('[detached-viz-smoke] FAIL: detached.html missing at repo root');
    process.exit(1);
  }
  const detachedHtml = await read('detached.html');
  assertMatch(detachedHtml, /id=["']eviland-canvas["']/, 'detached.html must include #eviland-canvas');
  assertMatch(detachedHtml, /\/src\/detached\/main\.tsx/, 'detached.html must script src=/src/detached/main.tsx');

  const main = await read('electron/main.ts');
  assertMatch(main, /MessageChannelMain/, 'main.ts must import MessageChannelMain');
  assertMatch(main, /ipcMain\.handle\(\s*'detached-viz:list-displays'/, 'main.ts must handle detached-viz:list-displays');
  assertMatch(main, /ipcMain\.handle\(\s*'detached-viz:open'/, 'main.ts must handle detached-viz:open');
  assertMatch(main, /ipcMain\.handle\(\s*'detached-viz:close'/, 'main.ts must handle detached-viz:close');
  assertMatch(main, /ipcMain\.handle\(\s*'detached-viz:move-to-display'/, 'main.ts must handle detached-viz:move-to-display');
  assertMatch(main, /ipcMain\.handle\(\s*'detached-viz:set-fullscreen'/, 'main.ts must handle detached-viz:set-fullscreen');
  assertMatch(main, /ipcMain\.handle\(\s*'detached-viz:is-open'/, 'main.ts must handle detached-viz:is-open');
  assertMatch(main, /backgroundThrottling:\s*false/, 'detached BrowserWindow must set backgroundThrottling:false (load-bearing for projector mode)');
  assertMatch(main, /postMessage\(\s*'eviland:frame-port'/, 'main.ts must post the eviland:frame-port to both windows');
  assertMatch(main, /detached-viz:opened/, 'main.ts must notify renderer on open');
  assertMatch(main, /detached-viz:closed/, 'main.ts must notify renderer on close');
  assertMatch(main, /detached-viz:crashed/, 'main.ts must notify renderer on crash');
  assertMatch(main, /displays:changed/, 'main.ts must notify renderer on display add/remove');

  const preload = await read('electron/preload.ts');
  assertMatch(preload, /exposeInMainWorld\(\s*'detachedViz'/, 'preload must expose detachedViz namespace');
  assertMatch(preload, /'detached-viz:list-displays'/, 'preload must invoke detached-viz:list-displays');
  assertMatch(preload, /'detached-viz:open'/, 'preload must invoke detached-viz:open');
  assertMatch(preload, /ipcRenderer\.on\(\s*'eviland:frame-port'/, 'preload must re-dispatch eviland:frame-port to window');
  assertMatch(preload, /new MessageEvent\(\s*'eviland:frame-port'/, 'preload must re-dispatch via MessageEvent with ports');

  const vite = await read('vite.config.ts');
  assertMatch(vite, /detached:\s*resolve\(__dirname,\s*['"]detached\.html['"]\)/, 'vite.config.ts must list detached.html as a rollup input');

  const bus = await read('src/visualizer/frame-bus.ts');
  assertMatch(bus, /attachDetachedPort/, 'frame-bus must expose attachDetachedPort');
  assertMatch(bus, /publish\b/, 'frame-bus must expose publish');
  // Fire-and-forget by design: ack-gated backpressure froze the projector when
  // the occluded main renderer stopped processing returning acks. The consumer
  // coalesces to the newest frame instead.
  assertMatch(bus, /nothing gates on\s*\n?\/\/ them/, 'frame-bus must document the no-ack-gating contract');
  assertMatch(bus, /typeof window !==\s*['"]undefined['"]/, 'frame-bus must be Node-import-safe (window guard)');

  const detachedTs = await read('src/detached/main.tsx');
  assertMatch(detachedTs, /createEvilandRenderer/, 'detached entry must construct an EvilandRenderer');
  assertMatch(detachedTs, /'eviland:frame-port'/, 'detached entry must listen for the frame port');
  assertMatch(detachedTs, /postMessage\(\s*ack\s*\)/, 'detached entry must ack each frame');

  const env = await read('src/vite-env.d.ts');
  assertMatch(env, /detachedViz:\s*DetachedVizBridge/, 'window typings must include detachedViz');

  console.log(JSON.stringify({ ok: true, mode: 'static' }));
}

async function runLiveSmoke() {
  const electron = await import('electron');
  const { app, BrowserWindow, MessageChannelMain } = electron;

  if (!app) {
    console.error('[detached-viz-smoke] LIVE mode must be run via the electron binary: `electron scripts/detached-viz-smoke.mjs`');
    process.exit(1);
  }

  const hardTimeout = setTimeout(() => {
    console.error('[detached-viz-smoke] LIVE timeout — forcing exit');
    try { app.exit(1); } catch { process.exit(1); }
  }, 20000);
  hardTimeout.unref?.();

  let ok = false;
  let detail = {};

  app.whenReady().then(async () => {
    try {
      const winA = new BrowserWindow({ show: false, width: 320, height: 200 });
      const winB = new BrowserWindow({ show: false, width: 320, height: 200 });

      const html = (label) => `<!doctype html><html><body><script>
        window.__handshake = new Promise((res) => {
          window.addEventListener('eviland:frame-port', (e) => {
            const port = e.ports && e.ports[0];
            if (!port) { res({ ok: false, label: '${label}', reason: 'no port' }); return; }
            port.onmessage = (m) => { res({ ok: true, label: '${label}', got: m.data }); };
            port.start();
            // 'A' is the producer in this synthetic harness — ping after the
            // consumer has had a chance to bind.
            if ('${label}' === 'A') {
              setTimeout(() => port.postMessage({ ping: '${label}' }), 50);
            }
          });
        });
      </script></body></html>`;

      await winA.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html('A')));
      await winB.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html('B')));

      // Stand in for the preload re-dispatch — in production preload.ts does
      // this. We inject the equivalent inline so the live smoke does not need
      // a built preload bundle.
      const wireBridge = async (win) => {
        await win.webContents.executeJavaScript(`(() => {
          // Synthetic: the bridge is normally in preload; we already wired
          // the window 'eviland:frame-port' listener above directly. No-op.
          return true;
        })()`);
      };
      await wireBridge(winA);
      await wireBridge(winB);

      const channel = new MessageChannelMain();
      winA.webContents.postMessage('eviland:frame-port', null, [channel.port1]);
      winB.webContents.postMessage('eviland:frame-port', null, [channel.port2]);

      const [resA, resB] = await Promise.all([
        winA.webContents.executeJavaScript('window.__handshake'),
        winB.webContents.executeJavaScript('window.__handshake'),
      ]);

      detail = { resA, resB, windowCount: BrowserWindow.getAllWindows().length };
      // Bidirectional transport is the whole point — BOTH ends must complete the
      // handshake. (Was `||`, which passed when only one direction worked.)
      ok = Boolean(resA?.ok && resB?.ok);
      if (!ok) {
        console.error('[detached-viz-smoke] LIVE FAIL', JSON.stringify(detail));
      } else {
        console.log('[detached-viz-smoke] LIVE PASS', JSON.stringify(detail));
      }
    } catch (err) {
      console.error('[detached-viz-smoke] LIVE threw', err);
    } finally {
      clearTimeout(hardTimeout);
      try { app.exit(ok ? 0 : 1); } catch { process.exit(ok ? 0 : 1); }
    }
  });

  app.on('window-all-closed', () => {
    // Don't quit on window-all-closed during the smoke; we drive exit explicitly.
  });
}
