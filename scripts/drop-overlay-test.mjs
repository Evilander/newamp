// Regression proof for a reported bug: the drag-and-drop border stuck on screen.
//
// Reproduces the terminal-gesture paths that used to leave the drop chrome
// stuck or double-import a drop (Library+App both handling one drop, a
// nested dropzone stopping propagation, Escape/blur mid-drag, an empty/error
// drop) against the actual renderer bundle, driven by a hidden Electron
// window the same way scripts/playback-smoke.mjs drives audio playback.
// No external browser and no extra tooling: esbuild and electron are
// both real project dependencies, and src/lib/api.ts already exposes
// window.__api for in-browser mocking when built with import.meta.env.DEV.
import { app, BrowserWindow } from 'electron';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const outDir = resolve(root, 'tmp', 'drop-overlay-test');

const hardTimeout = setTimeout(() => fail(new Error('drop overlay test timed out')), 60000);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-rasterization');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');

void app.whenReady().then(run).catch(fail);

async function run() {
  console.error('[newamp] electron ready');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await build({
    entryPoints: [resolve(root, 'src/main.tsx')],
    bundle: true,
    outfile: resolve(outDir, 'bundle.js'),
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    tsconfig: resolve(root, 'tsconfig.json'),
    define: {
      'process.env.NODE_ENV': '"development"',
      'import.meta.env.DEV': 'true',
      'import.meta.env.PROD': 'false',
    },
    loader: { '.png': 'dataurl', '.webp': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl' },
    plugins: [
      {
        name: 'strip-css',
        setup(b) {
          b.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'css' }));
        },
      },
    ],
  });
  console.error('[newamp] renderer bundle built');

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
        return;
      }
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await readFile(resolve(outDir, '.' + path)));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;

  const win = new BrowserWindow({
    show: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    // Electron's own "no CSP set" advisory is expected for this bare dev
    // harness (no packaged app, no CSP meta tag) and isn't a renderer fault.
    if (level >= 2 && !/Electron Security Warning/.test(message)) consoleErrors.push(message);
  });

  await win.loadURL(`http://127.0.0.1:${port}/`);
  console.error('[newamp] renderer loaded');

  const evalJs = (expr) => win.webContents.executeJavaScript(expr, true);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (label) =>
    evalJs(
      `(()=>{const el=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});el?.click();return !!el})()`,
    );
  const observe = () =>
    evalJs(
      `(()=>{return {
        appBorder: !!document.querySelector('[data-newamp-app-drop-overlay]'),
        appStatus: document.querySelector('[data-newamp-drop-status]')?.textContent ?? null,
        libraryBorder: !!document.querySelector('[data-newamp-library-drop-overlay]'),
        libraryStatus: document.querySelector('[data-newamp-library-drop-status]')?.textContent ?? null,
        calls: window.__dropCalls,
      }})()`,
    );
  const dragEnter = (selector) =>
    evalJs(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing target '+${JSON.stringify(selector)});const dt=new DataTransfer();dt.items.add(new File(['x'],'fixture.wav',{type:'audio/wav'}));el.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:dt}));})()`,
    );
  const drop = (selector) =>
    evalJs(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing target '+${JSON.stringify(selector)});const dt=new DataTransfer();dt.items.add(new File(['x'],'fixture.wav',{type:'audio/wav'}));el.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:dt}));el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));})()`,
    );
  const escapeKey = () => evalJs(`(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));})()`);
  const blurWindow = () => evalJs(`(()=>{window.dispatchEvent(new Event('blur'));})()`);
  const mockApi = (body) =>
    evalJs(`(()=>{try{${body}}catch(e){return 'MOCK_API_ERROR: ' + (e && e.stack || e);} return true;})()`);

  await wait(1000);
  await click('Start listening');
  await wait(250);

  const results = {};

  // Scenario 1 — drop on Library: import must run exactly once, never
  // bubbling into App's own openFiles for the same paths.
  await click('Library');
  await wait(350);
  await mockApi(`
    window.__dropCalls = { scan: 0, open: 0 };
    window.__api.getDroppedFilePaths = () => ['/drop-overlay-test/fixture.wav'];
    window.__api.scanLibrary = () => { window.__dropCalls.scan++; return new Promise((r) => setTimeout(r, 60)); };
    window.__api.openFiles = () => { window.__dropCalls.open++; return new Promise((r) => setTimeout(() => r({ tracks: [], importedPlaylists: [], skipped: [] }), 60)); };
  `);
  await drop('[placeholder^="artist:radiohead"]');
  await wait(20);
  results.libraryDrop = await observe();
  await wait(400);
  results.libraryDropSettled = await observe();

  // Scenario 2 — drop on the playlist icon dropzone, whose own drop handler
  // stops propagation. The App-level border must still clear: the window
  // capture-phase listener runs before any bubble-phase stopPropagation.
  await click('Playlists');
  await wait(350);
  await dragEnter('[data-newamp-drop-zone]');
  await wait(20);
  const beforeIconDrop = await observe();
  await drop('[data-playlist-icon-dropzone]');
  await wait(20);
  results.playlistIconDrop = { before: beforeIconDrop, after: await observe() };

  // Scenario 3 — Escape mid-drag clears both border and any pending status.
  await dragEnter('[data-newamp-drop-zone]');
  await wait(20);
  const beforeEscape = await observe();
  await escapeKey();
  await wait(20);
  results.escape = { before: beforeEscape, after: await observe() };

  // Scenario 4 — a drop with no readable local path shows a message that
  // expires on its own instead of sitting there forever.
  await mockApi(`window.__api.getDroppedFilePaths = () => [];`);
  await drop('[data-newamp-drop-zone]');
  await wait(50);
  results.emptyDropImmediate = await observe();
  await wait(3900);
  results.emptyDropExpired = await observe();

  // Scenario 5 — a drop that opens/plays on the app itself must not keep the
  // full-window border up for the duration of that async work; only a
  // nonblocking status readout should be visible.
  await mockApi(`
    window.__dropCalls = { scan: 0, open: 0 };
    window.__api.getDroppedFilePaths = () => ['/drop-overlay-test/fixture.wav'];
    window.__api.openFiles = () => { window.__dropCalls.open++; return new Promise((r) => setTimeout(() => r({ tracks: [], importedPlaylists: [], skipped: [] }), 400)); };
  `);
  await drop('[data-newamp-drop-zone]');
  await wait(150);
  results.appDropPending = await observe();
  await wait(500);
  results.appDropSettled = await observe();

  // Scenario 6 — alt-tab/window blur mid-drag must not leave the border up.
  await dragEnter('[data-newamp-drop-zone]');
  await wait(20);
  const beforeBlur = await observe();
  await blurWindow();
  await wait(20);
  results.blur = { before: beforeBlur, after: await observe() };

  // Scenario 7: dropping OS files on a SAVED PLAYLIST track row must
  // not reorder or persist that playlist. Decision: a file drop on a
  // reorder row falls through to App's normal open, same as dropping
  // anywhere else that isn't Library — it does not scope-import into that
  // playlist at that position.
  await mockApi(`
    window.__api.getPlaylists = () => Promise.resolve([
      { id: 9001, name: 'Drop Target Playlist', hasCoverArt: false, trackCount: 2, duration: 360, coverArtUpdatedAt: null },
    ]);
    window.__api.getPlaylistTracks = () => Promise.resolve([
      { id: 9101, title: 'Row Zero', artist: 'Artist A', album: 'Album A', albumArtist: 'Artist A', duration: 180, missingSince: null, path: '/fixtures/row-zero.flac' },
      { id: 9102, title: 'Row One', artist: 'Artist B', album: 'Album B', albumArtist: 'Artist B', duration: 200, missingSince: null, path: '/fixtures/row-one.flac' },
    ]);
    window.__savePlaylistCalls = 0;
    window.__api.savePlaylist = (input) => { window.__savePlaylistCalls++; return Promise.resolve(input); };
    window.__dropCalls = { scan: 0, open: 0 };
    window.__api.getDroppedFilePaths = () => ['/drop-overlay-test/fixture.wav'];
    window.__api.openFiles = () => { window.__dropCalls.open++; return Promise.resolve({ tracks: [], importedPlaylists: [], skipped: [] }); };
  `);
  // PlaylistView already mounted back in scenario 2 and fetched playlists
  // then, before this mock existed — remount it (navigate away and back) so
  // its mount effect calls the now-mocked api.getPlaylists().
  await click('Library');
  await wait(150);
  await click('Playlists');
  await wait(350);
  await evalJs(
    `(()=>{const el=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Drop Target Playlist'));el?.click();return !!el})()`,
  );
  await wait(300);
  const playlistRows = () =>
    evalJs(`[...document.querySelectorAll('[data-newamp-playlist-track-row]')].map((r) => r.textContent)`);
  const beforePlaylistRows = await playlistRows();
  await drop('[data-newamp-playlist-track-row="1"]');
  await wait(150);
  results.playlistRowFileDrop = {
    beforeRows: beforePlaylistRows,
    afterRows: await playlistRows(),
    savePlaylistCalls: await evalJs('window.__savePlaylistCalls'),
    openCalls: await evalJs('window.__dropCalls.open'),
  };

  // Scenario 8: dropping OS files on an ACTIVE QUEUE row (rendered
  // in the Playlists view) must not reorder the queue either, and must also
  // fall through to App's normal open exactly once. The queue panel and a
  // selected playlist's panel are mutually exclusive — switch back first.
  await click('SHOW QUEUE');
  await wait(150);
  await mockApi(`
    window.__store.setState({
      queue: [
        { id: 9201, title: 'Queue Zero', artist: 'Artist C', album: 'Album C', albumArtist: 'Artist C', duration: 150, missingSince: null, path: '/fixtures/queue-zero.flac' },
        { id: 9202, title: 'Queue One', artist: 'Artist D', album: 'Album D', albumArtist: 'Artist D', duration: 170, missingSince: null, path: '/fixtures/queue-one.flac' },
      ],
      current: null,
      queueIndex: null,
    });
    window.__dropCalls = { scan: 0, open: 0 };
    window.__api.getDroppedFilePaths = () => ['/drop-overlay-test/fixture.wav'];
    window.__api.openFiles = () => { window.__dropCalls.open++; return Promise.resolve({ tracks: [], importedPlaylists: [], skipped: [] }); };
  `);
  await wait(250);
  const queueRows = () =>
    evalJs(`[...document.querySelectorAll('[data-newamp-queue-track-row]')].map((r) => r.textContent)`);
  const beforeQueueRows = await queueRows();
  await drop('[data-newamp-queue-track-row="1"]');
  await wait(150);
  results.queueRowFileDrop = {
    beforeRows: beforeQueueRows,
    afterRows: await queueRows(),
    openCalls: await evalJs('window.__dropCalls.open'),
  };

  win.close();
  app.quit();
  clearTimeout(hardTimeout);

  try {
    assert.deepEqual(consoleErrors, [], `renderer logged console errors/warnings: ${JSON.stringify(consoleErrors)}`);

    assert.equal(results.libraryDrop.calls.scan, 1, 'Library drop should scan exactly once');
    assert.equal(results.libraryDrop.calls.open, 0, 'Library drop must not bubble into App.openFiles');
    assert.equal(results.libraryDrop.appBorder, false, 'App overlay must not show for a drop handled by Library');
    assert.equal(results.libraryDrop.libraryBorder, false, 'Library border should clear immediately on drop');
    assert.equal(results.libraryDropSettled.libraryStatus, 'Scanned 1 dropped item.', 'Library status should report the completed scan');

    assert.equal(beforeIconDrop.appBorder, true, 'dragging a file over the app should raise the app border');
    assert.equal(results.playlistIconDrop.after.appBorder, false, 'app border must clear even though the icon dropzone stops propagation on drop');

    assert.equal(beforeEscape.appBorder, true, 'dragging should raise the app border before Escape');
    assert.equal(results.escape.after.appBorder, false, 'Escape must clear the app border');
    assert.equal(results.escape.after.appStatus, null, 'Escape must clear any pending drop status too');

    assert.equal(results.emptyDropExpired.appStatus, null, 'an empty-drop message must expire on its own');

    assert.equal(results.appDropPending.appBorder, false, 'the full-window border must not persist for the duration of a pending open');
    assert.match(results.appDropPending.appStatus ?? '', /Opening/, 'a pending open should show a nonblocking status instead');
    assert.equal(results.appDropSettled.calls.open, 1, 'App-level drop should open exactly once');

    assert.equal(beforeBlur.appBorder, true, 'dragging should raise the app border before a blur');
    assert.equal(results.blur.after.appBorder, false, 'window blur mid-drag must clear the app border');

    assert.equal(results.playlistRowFileDrop.beforeRows.length, 2, 'fixture playlist must render both rows before the drop');
    assert.deepEqual(
      results.playlistRowFileDrop.afterRows,
      results.playlistRowFileDrop.beforeRows,
      'a file drop on a playlist row must not reorder it',
    );
    assert.equal(results.playlistRowFileDrop.savePlaylistCalls, 0, 'a file drop on a playlist row must never persist a reorder');
    assert.equal(results.playlistRowFileDrop.openCalls, 1, 'a file drop on a playlist row must fall through to App.openFiles exactly once');

    assert.equal(results.queueRowFileDrop.beforeRows.length, 2, 'fixture queue must render both rows before the drop');
    assert.deepEqual(
      results.queueRowFileDrop.afterRows,
      results.queueRowFileDrop.beforeRows,
      'a file drop on a queue row must not reorder the queue',
    );
    assert.equal(results.queueRowFileDrop.openCalls, 1, 'a file drop on a queue row must fall through to App.openFiles exactly once');

    console.log(JSON.stringify({ ok: true, results }, null, 2));
    process.exit(0);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, results, consoleErrors }, null, 2));
    throw error;
  }
}

function fail(err) {
  clearTimeout(hardTimeout);
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  try {
    app.quit();
  } catch {
    /* app may not be initialized */
  }
  process.exit(1);
}
