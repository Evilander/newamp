import assert from 'node:assert/strict';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const appRoot = resolve('.');
const smokeRoot = resolve('tmp', 'ui-wheel-volume-smoke');
const userData = join(smokeRoot, 'user-data');
const marker = '[newamp-ui-wheel-volume-smoke] ';

await resetSmokeRoot();
await writeSmokeSettings();

const result = await runElectronSmoke();
console.log(JSON.stringify(result, null, 2));
assert.equal(result.ok, true, 'UI wheel-volume smoke should report success');
const span = result.count * result.stepPerEvent;
// One quarter-notch event after a pause is a slow click: it moves a whole
// step (0.02), not the 0.01 its distance alone would give. The first event of
// every burst below follows a pause and is floored the same way, so each burst
// lands STEP_FLOOR_EXTRA past the distance scrolled, in the direction scrolled.
// Under throttling or jank queued events merge, and a straggler can arrive on
// its own after a stall and be floored too. Those two bursts get one more
// floored step of tolerance; it is still far tighter than what a stalled or
// reversed scroll would lose (0.4 or more).
const STEP_FLOOR_EXTRA = 0.01;
const MERGING_BURST_TOLERANCE = 0.02 + STEP_FLOOR_EXTRA;
assert.ok(
  Math.abs(result.afterOne - result.start) >= 0.019,
  `a slow single wheel event should move at least one step, moved ${Math.abs(result.afterOne - result.start)}`,
);
const burstSpan = span + STEP_FLOOR_EXTRA;
assertNear(result.afterFast, result.fastStart + burstSpan, 'a burst of wheel events with the renderer idle');
assertNear(
  result.afterThrottled,
  result.throttledStart - burstSpan,
  'the same burst with the renderer CPU-throttled 16x',
  MERGING_BURST_TOLERANCE,
);
assertNear(
  result.afterJank,
  result.jankStart + burstSpan,
  'the same burst with the main thread busy 80% of the time',
  MERGING_BURST_TOLERANCE,
);
assertNear(result.afterSettings, result.settingsStart - burstSpan, 'a burst with the Settings view open');
assertNear(result.afterVisualizer, result.visualizerStart + burstSpan, 'a burst after the visualizer was opened and closed');
assertNear(result.afterDeck, result.deckStart - burstSpan, "a burst over the Retro TV deck's own slider");
assertNear(result.afterKnobDrag, result.knobStart + 0.3, 'dragging the Retro TV volume knob up 30 px');
assertNear(result.afterDoubleClick, 1, 'a double-click on the slider resets the volume to 100%');

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
        volume: 0.5,
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
        NEWAMP_UI_WHEEL_VOLUME_SMOKE: '1',
        NEWAMP_SMOKE_USER_DATA: userData,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      finish(new Error(`UI wheel-volume smoke timed out without result marker. stderr:\n${tail(stderr)}`));
    }, 120000);

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
        finish(new Error(`Electron exited ${code ?? 'without code'} before UI wheel-volume result.\nstderr:\n${tail(stderr)}`));
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

function assertNear(actual, expected, label, tolerance = 0.02) {
  // The epsilon keeps a difference of exactly one tolerance from failing on
  // float noise (0.8200000000000001 - 0.8).
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) <= tolerance + 1e-9,
    `${label}: expected ${expected.toFixed(2)} (within ${tolerance}), got ${actual}`,
  );
}

function tail(text) {
  return text.split(/\r?\n/).slice(-30).join('\n');
}
