import assert from 'node:assert/strict';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Boots the real app, opens the desktop widget with the title bar's WIDGET
// button and checks the window it gets (runUiWidgetSmoke in electron/main.ts).
const appRoot = resolve('.');
const smokeRoot = resolve('tmp', 'ui-widget-smoke');
const userData = join(smokeRoot, 'user-data');
const marker = '[newamp-ui-widget-smoke] ';

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await writeFile(
  join(userData, 'settings.json'),
  JSON.stringify({ libraryRoots: [], libraryAutoWatch: false, firstLaunchTutorialSeen: true, autoBackupEnabled: false }, null, 2),
);

const result = await runElectronSmoke();
assert.equal(result.ok, true, 'UI widget smoke should report success');
assert.equal(result.buttonPressed, 'true', 'the WIDGET button should read as pressed while the widget is open');
assert.equal(result.platter.layout, 'platter', 'a new widget opens as the record');
assertWindow(result.platter, 240, 240, 'record layout');
assert.equal(result.platter.title, 'Widget Smoke Title', 'the widget should show the title it was sent');
assert.equal(result.platter.artist, 'Widget Smoke Artist', 'the widget should show the artist it was sent');
assert.equal(result.platter.playing, 'true', 'the widget should show that the track is playing');
assertWindow(result.card, 380, 128, 'card layout');
// The record is a circle in a square window: most of the window is drawn and
// its corners are not. A window that lost its transparency has no clear pixels.
assert.ok(result.solidShare > 0.4, `the record should fill most of its window, got ${result.solidShare}`);
assert.ok(result.clearShare > 0.08, `the corners outside the record should be see-through, got ${result.clearShare}`);
assert.deepEqual(
  result.transport,
  [{ cmd: 'togglePlay' }, { cmd: 'togglePlay' }],
  'the play button and a click on the record should each send one togglePlay to the transport channel',
);
assert.ok(
  Math.abs(result.dragBy.x + 32) <= 2 && Math.abs(result.dragBy.y + 16) <= 2,
  `dragging the record 32 left and 16 up should move the window by that much, got ${JSON.stringify(result.dragBy)}`,
);
assert.equal(result.transportAfterDrag, 2, 'a drag should not also count as a click on the record');
assertWindow(result.draggedSize, 240, 240, 'the window after a drag');
assert.equal(result.floatingOnTop, true, 'Always on Top should raise the window');
assert.equal(result.normalOnTop, false, 'Normal Window should lower it again');
// Under ordinary windows is a level of its own on macOS, which Electron also
// reports as "always on top"; elsewhere it is an ordinary window.
assert.equal(result.desktopOnTop, result.platform === 'darwin', 'On the Desktop should change the level only on macOS');
assert.equal(result.openSaved, true, 'an open widget should be saved as open');
assert.equal(result.closedSaved, true, 'closing the widget should be saved');
assert.equal(result.layoutSaved, 'card', 'the layout should be saved');
assert.equal(result.levelSaved, 'desktop', 'the level should be saved');
console.log(JSON.stringify(result, null, 2));

function runElectronSmoke() {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(electronPath, [appRoot], {
      cwd: appRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEWAMP_UI_WIDGET_SMOKE: '1',
        NEWAMP_SMOKE_USER_DATA: userData,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      finish(new Error(`UI widget smoke timed out without result marker. stderr:\n${tail(stderr)}`));
    }, 60000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.startsWith(marker)) continue;
        try {
          finish(null, JSON.parse(line.slice(marker.length)));
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => finish(err));
    child.on('exit', (code) => {
      if (!settled && code !== 0) {
        finish(new Error(`Electron exited ${code ?? 'without code'} before UI widget result.\nstderr:\n${tail(stderr)}`));
      }
    });

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!child.killed) child.kill();
      if (err) rejectPromise(err);
      else resolvePromise(value);
    }
  });
}

function assertWindow(value, width, height, label) {
  assert.ok(value, `${label} should report a measured window`);
  assert.equal(value.width, width, `${label} width`);
  assert.equal(value.height, height, `${label} height`);
}

function tail(text) {
  return text.split(/\r?\n/).slice(-60).join('\n');
}
