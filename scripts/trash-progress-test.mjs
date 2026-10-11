// A large move to the Recycle Bin reports as it goes, and the menu shows it in
// one toast that is replaced rather than stacked.
//  - the move reports after every 25 files and at the end, counting files that
//    were already gone and files that could not be moved
//  - the progress toast: its wording, silent for the final report, replaced on
//    each report, left closed once the user closes it, put back when a burst of
//    other toasts pushes it off the stack, gone when the move ends
//  - every file is released (decoders stopped) right before each attempt to move
//    it, so a decoder that started on a later file in the batch is stopped too
//  - the preload listener passes well-formed reports through and unsubscribes
//  - the main process and the preload use the same channel
// Run: npm run build:electron && node scripts/trash-progress-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const deadline = setTimeout(() => { console.error('trash-progress-test timed out'); process.exit(1); }, 60_000);
deadline.unref();

const { moveTracksToTrash, TRASH_PROGRESS_EVERY } = await import(pathToFileURL(resolve('dist-electron/electron/trash-tracks.js')).href);

const track = (id) => ({ id, title: `Track ${id}`, path: `K:/music/${id}.flac` });
const tracks = (n) => Array.from({ length: n }, (_, i) => track(i + 1));

// --- the move ----------------------------------------------------------------------
{
  assert.equal(TRASH_PROGRESS_EVERY, 25);
  const run = async (list, io = {}) => {
    const reports = [];
    const outcome = await moveTracksToTrash(list, {
      exists: () => true,
      trash: async () => {},
      bin: 'Recycle Bin',
      retryDelayMs: 1,
      onProgress: (done, total) => reports.push([done, total]),
      ...io,
    });
    return { reports, outcome };
  };

  assert.deepEqual((await run(tracks(60))).reports, [[25, 60], [50, 60], [60, 60]], 'every 25 files and at the end');
  assert.deepEqual((await run(tracks(50))).reports, [[25, 50], [50, 50]], 'the end is reported once when it falls on a multiple');
  assert.deepEqual((await run(tracks(3))).reports, [[3, 3]], 'a small move reports only that it finished');
  assert.deepEqual((await run([])).reports, [], 'nothing to move, nothing to report');

  // Gone files and failures count as handled, and are sorted as before.
  const missing = new Set([`K:/music/2.flac`]);
  const refused = new Set([`K:/music/3.flac`]);
  const mixed = await run(tracks(4), {
    exists: (path) => !missing.has(path),
    trash: async (path) => { if (refused.has(path)) throw new Error('Operation was aborted'); },
  });
  assert.deepEqual(mixed.reports, [[4, 4]]);
  assert.deepEqual(mixed.outcome.trashed.map((t) => t.id), [1, 4]);
  assert.deepEqual(mixed.outcome.gone.map((t) => t.id), [2], 'a row whose file is gone is not a failure');
  assert.deepEqual(mixed.outcome.failed.map((f) => f.path), ['K:/music/3.flac']);
  assert.match(mixed.outcome.failed[0].error, /in use, or its drive has no Recycle Bin/);

  // The reports arrive while the move is under way, not after it.
  let moved = 0;
  const during = [];
  await moveTracksToTrash(tracks(30), {
    exists: () => true,
    trash: async () => { moved += 1; },
    bin: 'Trash',
    onProgress: (done) => during.push([done, moved]),
  });
  assert.deepEqual(during, [[25, 25], [30, 30]]);

  // No listener is fine.
  const quiet = await moveTracksToTrash(tracks(26), { exists: () => true, trash: async () => {}, bin: 'Trash' });
  assert.equal(quiet.trashed.length, 26);

  // Each file is released right before its own move. Playback moves on when
  // the first file's decoder stops, so a decoder starts on the next file in the
  // batch after the batch-wide stop; the release before that file frees it.
  const calls = [];
  const held = new Set();
  const released = await moveTracksToTrash(tracks(3), {
    exists: (path) => path !== 'K:/music/3.flac',
    release: async (path) => {
      calls.push(`release ${path}`);
      held.delete(path);
    },
    trash: async (path) => {
      calls.push(`trash ${path}`);
      if (path === 'K:/music/1.flac') held.add('K:/music/2.flac');
      if (held.has(path)) throw new Error('Operation was aborted');
    },
    bin: 'Recycle Bin',
    retryDelayMs: 1,
  });
  assert.deepEqual(calls, [
    'release K:/music/1.flac',
    'trash K:/music/1.flac',
    'release K:/music/2.flac',
    'trash K:/music/2.flac',
  ], 'released before the move, none for a file that is already gone');
  assert.deepEqual(released.trashed.map((t) => t.id), [1, 2], 'the file the next decoder held is free by its turn');
  assert.deepEqual(released.gone.map((t) => t.id), [3]);
  assert.deepEqual(released.failed, []);

  // The retry releases again, for a decoder that started in between.
  const retried = [];
  let busy = true;
  const second = await moveTracksToTrash(tracks(1), {
    exists: () => true,
    release: async (path) => { retried.push(`release ${path}`); },
    trash: async (path) => {
      retried.push(`trash ${path}`);
      if (busy) {
        busy = false;
        throw new Error('Operation was aborted');
      }
    },
    bin: 'Trash',
    retryDelayMs: 1,
  });
  assert.deepEqual(retried, ['release K:/music/1.flac', 'trash K:/music/1.flac', 'release K:/music/1.flac', 'trash K:/music/1.flac']);
  assert.equal(second.trashed.length, 1);

  // A release that throws does not stop the move.
  const stubborn = await moveTracksToTrash(tracks(2), {
    exists: () => true,
    release: async () => { throw new Error('child would not exit'); },
    trash: async () => {},
    bin: 'Trash',
  });
  assert.equal(stubborn.trashed.length, 2);
  assert.deepEqual(stubborn.failed, []);
}

// --- the toast ---------------------------------------------------------------------
const bundled = await build({
  stdin: {
    contents: `
      export { trashTracksWithProgress, openTrackContextMenu } from './src/lib/trackMenu';
      export { describeTrashProgress } from './src/lib/trashResult';
      export { getToasts, dismissToast, clearToasts, pushToast } from './src/lib/toast';
      export { api } from './src/lib/api';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  define: { 'import.meta.env.DEV': 'false' },
  logLevel: 'silent',
  plugins: [
    {
      name: 'stub-player-store',
      setup(b) {
        b.onResolve({ filter: /store\/usePlayerStore$/ }, () => ({ path: 'usePlayerStore', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const usePlayerStore = { getState: () => ({ queueTracksNext() {}, addTracksToQueue() {}, navigateToPlaylist() {} }) };',
          loader: 'js',
        }));
      },
    },
  ],
});
const { trashTracksWithProgress, openTrackContextMenu, describeTrashProgress, getToasts, dismissToast, clearToasts, pushToast, api } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

{
  assert.deepEqual(describeTrashProgress({ done: 25, total: 3000 }, 'Recycle Bin'), {
    tone: 'info',
    title: 'Moving files to the Recycle Bin',
    detail: '25 of 3,000',
  });
  assert.equal(describeTrashProgress({ done: 3000, total: 3000 }, 'Trash'), null, 'the last report is followed by the result toasts');
  assert.equal(describeTrashProgress({ done: 5, total: 0 }, 'Trash'), null);
  assert.equal(describeTrashProgress({ done: Number.NaN, total: Number.NaN }, 'Trash'), null);
}

const progressToasts = () => getToasts().filter((toast) => /^Moving files to the/.test(toast.title));

// A fake main process: subscribers, and a trashTracks that reports as it goes.
function fakeMain(reports, result) {
  const listeners = new Set();
  const seen = [];
  api.onTrashProgress = (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  api.trashTracks = async (ids) => {
    seen.push(ids);
    for (const report of reports) {
      if (typeof report === 'function') report();
      else {
        for (const cb of [...listeners]) cb(report);
        await new Promise(setImmediate);
      }
    }
    if (result instanceof Error) throw result;
    return result;
  };
  return { listeners, seen };
}

const done = (extra = {}) => ({ trashed: 0, removed: 0, failed: [], cancelled: false, ...extra });

{
  // One toast, replaced on each report, gone when the move ends.
  clearToasts();
  const titles = [];
  const main = fakeMain(
    [
      { done: 25, total: 100 },
      () => titles.push(progressToasts().map((t) => t.detail)),
      { done: 50, total: 100 },
      () => titles.push(progressToasts().map((t) => t.detail)),
      { done: 100, total: 100 },
      () => titles.push(progressToasts().map((t) => t.detail)),
    ],
    done({ trashed: 100, removed: 100, trashedIds: [1], removedIds: [1] }),
  );
  const result = await trashTracksWithProgress([1, 2, 3], 'Recycle Bin');
  assert.equal(result.trashed, 100);
  assert.deepEqual(main.seen, [[1, 2, 3]]);
  assert.deepEqual(titles, [['25 of 100'], ['50 of 100'], ['50 of 100']], 'one toast at a time; the final report does not replace it');
  assert.equal(progressToasts().length, 0, 'gone once the move has ended');
  assert.equal(main.listeners.size, 0, 'and the listener with it');
  assert.ok(getToasts().every((toast) => toast.durationMs > 0 || !/^Moving/.test(toast.title)));
}

{
  // The progress toast does not expire on its own while the move runs.
  clearToasts();
  let sticky = null;
  fakeMain([{ done: 25, total: 100 }, () => { sticky = progressToasts()[0]?.durationMs; }], done());
  await trashTracksWithProgress([1], 'Trash');
  assert.equal(sticky, 0, 'sticky until the move ends');
}

{
  // A toast the user closed stays closed.
  clearToasts();
  const after = [];
  fakeMain(
    [
      { done: 25, total: 100 },
      () => dismissToast(progressToasts()[0].id),
      { done: 50, total: 100 },
      () => after.push(progressToasts().length),
    ],
    done(),
  );
  await trashTracksWithProgress([1], 'Trash');
  assert.deepEqual(after, [0]);
}

{
  // Four other toasts push the progress toast off the stack: it comes back.
  clearToasts();
  const counts = [];
  fakeMain(
    [
      { done: 25, total: 100 },
      () => {
        for (const title of ['Playback error', 'Now playing', 'Scrobbled', 'Could not move one file']) pushToast({ tone: 'warn', title });
        counts.push(progressToasts().length);
      },
      { done: 50, total: 100 },
      () => {
        counts.push(progressToasts().map((t) => t.detail));
        assert.ok(getToasts().length <= 4);
      },
      () => dismissToast(progressToasts()[0].id),
      { done: 75, total: 100 },
      () => counts.push(progressToasts().length),
    ],
    done(),
  );
  await trashTracksWithProgress([1], 'Trash');
  assert.deepEqual(counts, [0, ['50 of 100'], 0], 'evicted by newer toasts, put back; then closed by the user, stays closed');
  clearToasts();
}

{
  // The user closes it while other toasts are up, and more arrive after:
  // those arrivals are not a reason to bring it back.
  clearToasts();
  const after = [];
  pushToast({ tone: 'ok', title: 'Something else', durationMs: 0 });
  fakeMain(
    [
      { done: 25, total: 100 },
      () => dismissToast(progressToasts()[0].id),
      () => { for (const title of ['A', 'B', 'C']) pushToast({ tone: 'info', title }); },
      { done: 50, total: 100 },
      () => after.push(progressToasts().length),
    ],
    done(),
  );
  await trashTracksWithProgress([1], 'Trash');
  assert.deepEqual(after, [0]);
  clearToasts();
}

{
  // A small move never shows one.
  clearToasts();
  const during = [];
  fakeMain([{ done: 10, total: 10 }, () => during.push(getToasts().length)], done());
  await trashTracksWithProgress([1], 'Trash');
  assert.deepEqual(during, [0]);
}

{
  // A failed call still cleans up and still fails.
  clearToasts();
  const main = fakeMain([{ done: 25, total: 100 }], new Error('ipc closed'));
  await assert.rejects(trashTracksWithProgress([1], 'Trash'), /ipc closed/);
  assert.equal(progressToasts().length, 0);
  assert.equal(main.listeners.size, 0);
}

{
  // Through the menu, with the result toasts after it.
  clearToasts();
  const trackList = [
    { id: 11, title: 'Alpha', artist: 'A', album: 'B', path: 'K:/music/alpha.flac' },
    { id: 12, title: 'Beta', artist: 'A', album: 'B', path: 'K:/music/beta.flac' },
  ];
  api.getPlaylists = async () => [];
  api.showTrackContextMenu = async () => ({ action: 'trash' });
  const main = fakeMain(
    [{ done: 25, total: 60 }, () => assert.equal(progressToasts().length, 1), { done: 60, total: 60 }],
    done({ trashed: 2, removed: 2, trashedIds: [11, 12], removedIds: [11, 12] }),
  );
  await openTrackContextMenu(trackList);
  assert.deepEqual(main.seen, [[11, 12]]);
  assert.equal(progressToasts().length, 0);
  const titles = getToasts().map((toast) => toast.title);
  assert.equal(titles.length, 1);
  assert.match(titles[0], /^Moved to the (Recycle Bin|Trash)$/);
  clearToasts();
}

// --- the preload listener --------------------------------------------------------------
{
  const exposed = {};
  const handlers = new Map();
  const removed = [];
  globalThis.__electronStub = {
    exposed,
    ipcRenderer: {
      invoke: async () => undefined,
      send() {},
      sendSync: () => undefined,
      on(channel, handler) { handlers.set(channel, handler); },
      off(channel, handler) { removed.push([channel, handler]); },
    },
  };
  const preload = await build({
    entryPoints: [resolve('electron/preload.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    logLevel: 'silent',
    plugins: [
      {
        name: 'stub-electron',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: `
              const stub = globalThis.__electronStub;
              export const contextBridge = { exposeInMainWorld: (name, value) => { stub.exposed[name] = value; } };
              export const ipcRenderer = stub.ipcRenderer;
              export const webUtils = { getPathForFile: () => '' };
            `,
            loader: 'js',
          }));
        },
      },
    ],
  });
  globalThis.window ??= { addEventListener() {}, dispatchEvent() {} };
  await import(`data:text/javascript;base64,${Buffer.from(preload.outputFiles[0].text).toString('base64')}`);

  const received = [];
  const stop = exposed.newamp.onTrashProgress((progress) => received.push(progress));
  const handler = handlers.get('tracks:trash-progress');
  assert.equal(typeof handler, 'function', 'listens on the trash progress channel');
  handler({}, { done: 25, total: 100 });
  handler({}, null);
  handler({}, { done: 'x', total: 100 });
  handler({}, { done: 50 });
  handler({}, { done: 100, total: 100, extra: 'ignored' });
  assert.deepEqual(received, [{ done: 25, total: 100 }, { done: 100, total: 100 }], 'only well-formed reports reach the page');
  stop();
  assert.deepEqual(removed, [['tracks:trash-progress', handler]], 'the same listener is removed');
  delete globalThis.__electronStub;
}

// --- the main process uses the same channel ------------------------------------------------
{
  const main = await readFile(resolve('electron/main.ts'), 'utf8');
  const preload = await readFile(resolve('electron/preload.ts'), 'utf8');
  assert.match(main, /e\.sender\.send\('tracks:trash-progress', \{ done, total \}/, 'the trash handler reports to the window that asked');
  assert.match(main, /await moveTracksToTrash\(tracks,/);
  assert.match(
    main,
    /release: async \(path\) => \{\s*await Promise\.all\(\[releaseGaplessPaths\(\[path\]\), stopFfmpegReading\(\[path\]\)\]\);/,
    'and stops the decoders on each file right before moving it',
  );
  assert.match(preload, /ipcRenderer\.on\('tracks:trash-progress'/);
}

console.log('trash-progress-test: ok');
