import assert from 'node:assert/strict';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const appRoot = resolve('.');
const smokeRoot = resolve('tmp', 'ui-deck-smoke');
const userData = join(smokeRoot, 'user-data');
const marker = '[newamp-ui-deck-smoke] ';

await resetSmokeRoot();
await writeSmokeSettings();

const result = await runElectronSmoke();
assert.equal(result.ok, true, 'UI deck smoke should report success');
assert.equal(result.openedViaDeckButton, true, 'real DECK button should enter compact mode');
assert.ok(result.visibleSkinButtons >= 9, 'deck should expose all shape-changing skin buttons');
assert.equal(result.selectAppRegion, 'no-drag', 'deck skin dropdown should not be swallowed by window dragging');
assert.equal(result.pickerAppRegion, 'no-drag', 'deck skin picker should remain clickable in deck titlebars');
assertWindow(result.shade, 820, 112, 'default windowshade deck');
assertWindow(result.record, 540, 540, 'record-player deck');
assertWindow(result.hotdog, 740, 240, 'hotdog deck');
assertWindow(result.discman, 620, 460, 'discman deck');
assertWindow(result.tv, 520, 430, 'retro TV deck');
assertWindow(result.winamp, 550, 232, 'Winamp classic deck');
assertWindow(result.shadeAgain, 820, 112, 'windowshade deck after skin switch');
assertWindow(result.nativeBounds, 820, 112, 'native BrowserWindow after returning to windowshade');
assert.equal(result.resizable, false, 'compact deck BrowserWindow should not be user-resizable');
console.log(JSON.stringify(result, null, 2));

async function resetSmokeRoot() {
  await rm(smokeRoot, { recursive: true, force: true });
  await mkdir(userData, { recursive: true });
}

async function writeSmokeSettings() {
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify(
      {
        libraryRoots: [],
        libraryAutoWatch: false,
        theme: 'classic',
        customSkin: null,
        lastfmEnabled: false,
        lastfmApiKey: null,
        lastfmSharedSecret: null,
        lastfmSessionKey: null,
        lastfmUsername: null,
        lastfmAuthToken: null,
        openaiApiKey: null,
        openaiModel: 'gpt-5.4-mini',
        firstLaunchTutorialSeen: true,
        crossfadeMs: 0,
        replayGain: 'off',
        limiterEnabled: true,
        preampDb: 0,
        resumeState: null,
        compactMode: false,
        alwaysOnTop: false,
        visualizerPreset: 'neon-waves',
        volume: 0,
        playbackRate: 1,
        audioOutputDeviceId: null,
        autoDjEnabled: false,
        autoDjTarget: 24,
        autoDjSmartRuleId: null,
        equalizer: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        eqEnabled: false,
      },
      null,
      2,
    ),
    'utf8',
  );
}

function runElectronSmoke() {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(String(electronPath), ['.'], {
      cwd: appRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEWAMP_UI_DECK_SMOKE: '1',
        NEWAMP_SMOKE_USER_DATA: userData,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      finish(new Error(`UI deck smoke timed out without result marker. stderr:\n${tail(stderr)}`));
    }, 45000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.startsWith(marker)) continue;
        try {
          const parsed = JSON.parse(line.slice(marker.length));
          finish(null, parsed);
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
        finish(new Error(`Electron exited ${code ?? 'without code'} before UI deck result.\nstderr:\n${tail(stderr)}`));
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
  assert.ok(Math.abs(value.width - width) <= 12, `${label} width expected ${width}, got ${value.width}`);
  assert.ok(Math.abs(value.height - height) <= 12, `${label} height expected ${height}, got ${value.height}`);
}

function tail(text) {
  return text.split(/\r?\n/).slice(-60).join('\n');
}
