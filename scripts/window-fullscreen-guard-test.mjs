// Closing the fullscreen visualizer must not resize a window that was never
// fullscreen. On Windows the main window is transparent, and Electron answers
// setFullScreen(false) on such a window by resizing it to a restore rectangle
// that only setFullScreen(true) records, so a windowed close dropped the window
// to its minimum size at the top-left corner and saved that as its bounds.
// The fake window below behaves that way; the guard has to keep it out of it.
// Run: node scripts/window-fullscreen-guard-test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const deadline = setTimeout(() => { console.error('Window fullscreen guard test timed out'); process.exit(1); }, 30000);
deadline.unref();

const result = await build({
  stdin: { contents: "export * from './src/components/visualizer-input';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
});
const { setWindowFullscreen, fullscreenToRestore } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

const MIN_BOUNDS = { x: 0, y: 0, width: 980, height: 640 };

/** The main process side: IPC with a little latency, and the transparent-window rules for setFullScreen. */
function fakeWindow(bounds) {
  const win = {
    bounds: { ...bounds },
    fullscreen: false,
    restore: null,
    calls: [],
    isFullscreen: async () => { await tick(); return win.fullscreen; },
    setFullscreen: async (on) => {
      win.calls.push(on);
      await tick();
      if (on) {
        win.restore = { ...win.bounds };
        win.fullscreen = true;
        win.bounds = { x: 0, y: 0, width: 2560, height: 1440 };
      } else {
        // No restore rectangle was recorded unless the window went fullscreen first.
        win.bounds = win.restore ? { ...win.restore } : { ...MIN_BOUNDS };
        win.fullscreen = false;
      }
    },
  };
  return win;
}
const tick = () => new Promise((done) => setTimeout(done, 2));
const windowed = { x: 128, y: 0, width: 1280, height: 816 };

// ---- the failure this guards against, on the same fake ----
{
  const win = fakeWindow(windowed);
  await win.setFullscreen(false);
  assert.deepEqual(win.bounds, MIN_BOUNDS, 'a bare setFullscreen(false) collapses a windowed window (the fake models the bug)');
}

// ---- open the visualizer windowed, close it: the window does not move ----
{
  const win = fakeWindow(windowed);
  const opening = await win.isFullscreen();
  const restore = fullscreenToRestore(opening, false, false);
  assert.equal(restore, false);
  await setWindowFullscreen(restore, win);
  assert.deepEqual(win.bounds, windowed, 'bounds are untouched');
  assert.deepEqual(win.calls, [], 'the main process was never asked to leave a fullscreen it was not in');
}

// ---- popping out to the projector from a windowed app is the same close ----
{
  const win = fakeWindow(windowed);
  await setWindowFullscreen(fullscreenToRestore(null, false, true), win);
  assert.deepEqual(win.bounds, windowed);
  assert.deepEqual(win.calls, []);
}

// ---- toggle fullscreen on inside the visualizer, then close: back where it was ----
{
  const win = fakeWindow(windowed);
  const opening = await win.isFullscreen();
  await setWindowFullscreen(true, win);
  assert.equal(win.fullscreen, true);
  await setWindowFullscreen(fullscreenToRestore(opening, false, false), win);
  assert.equal(win.fullscreen, false);
  assert.deepEqual(win.bounds, windowed, 'the window comes back to the size it had');
}

// ---- an app that was already fullscreen stays that way ----
{
  const win = fakeWindow(windowed);
  await win.setFullscreen(true);
  win.calls.length = 0;
  const opening = await win.isFullscreen();
  await setWindowFullscreen(fullscreenToRestore(opening, false, false), win);
  assert.equal(win.fullscreen, true);
  assert.deepEqual(win.calls, []);
}

// ---- toggling to the state it is already in asks for nothing ----
{
  const win = fakeWindow(windowed);
  await setWindowFullscreen(false, win);
  await setWindowFullscreen(false, win);
  await setWindowFullscreen(true, win);
  await setWindowFullscreen(true, win);
  assert.deepEqual(win.calls, [true], 'one enter, no repeats');
}

// ---- F then Esc without waiting: the leave sees the enter ----
{
  const win = fakeWindow(windowed);
  const enter = setWindowFullscreen(true, win);
  const leave = setWindowFullscreen(false, win);
  await Promise.all([enter, leave]);
  assert.equal(win.fullscreen, false);
  assert.deepEqual(win.bounds, windowed, 'enter then leave restores the original bounds');
  assert.deepEqual(win.calls, [true, false]);
}

// ---- one failed call does not wedge the ones after it ----
{
  const win = fakeWindow(windowed);
  const broken = { isFullscreen: async () => { throw new Error('window destroyed'); }, setFullscreen: async () => {} };
  await assert.rejects(setWindowFullscreen(true, broken), /window destroyed/);
  await setWindowFullscreen(true, win);
  assert.equal(win.fullscreen, true, 'later calls still run');
}

// ---- the visualizer goes through it for both of its fullscreen calls ----
{
  const viz = (await readFile(new URL('../src/components/FullscreenVisualizer.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.doesNotMatch(viz, /winctl\.setFullscreen\(/, 'no direct setFullscreen: an unguarded leave resizes a windowed window');
  assert.match(viz, /setWindowFullscreen\(next, winctl\)/, 'the F toggle is guarded');
  assert.match(viz, /setWindowFullscreen\(restore, winctl\)/, 'closing the visualizer is guarded');
}

console.log('PASS window fullscreen guard: a windowed close leaves the window alone, enter and leave stay ordered');
clearTimeout(deadline);
