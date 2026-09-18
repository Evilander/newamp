import electronPath from 'electron';
import ffmpeg from 'ffmpeg-static';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const appRoot = resolve('.');
const smokeRoot = resolve('tmp', 'ui-queue-edit-smoke');
const userData = join(smokeRoot, 'user-data');
const mediaDir = join(smokeRoot, 'media');
const marker = '[newamp-ui-queue-edit-smoke] ';

if (!ffmpeg) {
  console.error('ffmpeg-static did not resolve a binary for this platform');
  process.exit(1);
}

await resetSmokeRoot();
// Long enough that the first track is still playing when the edits are done.
await createFixture('01 - Queue One.mp3', 'Queue One', 392, 40, 1);
await createFixture('02 - Queue Two.mp3', 'Queue Two', 494, 40, 2);
await createFixture('03 - Queue Three.mp3', 'Queue Three', 587.33, 40, 3);
await writeSmokeSettings();

const result = await runElectronSmoke();
console.log(JSON.stringify(result, null, 2));
assertQueueEdit(result);

function assertQueueEdit(r) {
  const problems = [];
  const expect = (key, value) => {
    if (r[key] !== value) problems.push(`${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(r[key])}`);
  };
  expect('ok', true);
  expect('initial', 'One,Two,Three');
  expect('afterKeyboardMove', 'One,Three,Two'); // Alt+ArrowUp on the last row
  expect('focusFollowed', true); // focus stays on the track that moved
  expect('afterButtonMove', 'Three,One,Two'); // "Move down" on the playing row
  expect('activeAfterButtonMove', 'One'); // the play marker moved with it
  expect('afterDrag', 'Two,Three,One'); // drag the last row onto the first
  expect('afterDelete', 'Two,One'); // Delete on a row that is not playing
  expect('activeAfterDelete', 'One');
  // None of the edits may interrupt the track that is playing.
  if (!/Queue One/.test(String(r.playingAfterEdits))) problems.push(`playback jumped to ${JSON.stringify(r.playingAfterEdits)}`);
  expect('stillPlaying', true);
  expect('clockAdvanced', true);
  expect('rowsWhileArmed', 2); // the first Clear click only arms
  expect('afterClear', 0);
  if (problems.length) {
    console.error(`[ui-queue-edit-smoke] FAIL: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.error('[ui-queue-edit-smoke] PASS');
}

async function resetSmokeRoot() {
  await rm(smokeRoot, { recursive: true, force: true });
  await mkdir(mediaDir, { recursive: true });
  await mkdir(userData, { recursive: true });
}

async function createFixture(name, title, frequency, duration, trackNo) {
  const fixturePath = join(mediaDir, name);
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:duration=${duration}`,
    '-metadata',
    `title=${title}`,
    '-metadata',
    'artist=Newamp QA',
    '-metadata',
    'album=Queue Edit Smoke',
    '-metadata',
    `track=${trackNo}`,
    '-metadata',
    'date=2026',
    '-c:a',
    'libmp3lame',
    '-q:a',
    '6',
    fixturePath,
  ];
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !existsSync(fixturePath)) {
    throw new Error(`ffmpeg fixture generation failed (${result.status})\n${result.stderr || result.stdout}`);
  }
}

async function writeSmokeSettings() {
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify(
      {
        libraryRoots: [mediaDir],
        libraryAutoWatch: false,
        theme: 'classic',
        customSkin: null,
        lastfmEnabled: false,
        lastfmApiKey: null,
        lastfmSharedSecret: null,
        lastfmSessionKey: null,
        lastfmUsername: null,
        lastfmAuthToken: null,
        crossfadeMs: 0,
        replayGain: 'off',
        limiterEnabled: true,
        preampDb: 0,
        resumeState: null,
        volume: 0,
        playbackRate: 1,
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
        NEWAMP_UI_QUEUE_EDIT_SMOKE: '1',
        NEWAMP_SMOKE_USER_DATA: userData,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      finish(new Error(`UI queue-edit smoke timed out without result marker. stderr:\n${tail(stderr)}`));
    }, 30000);

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
        finish(new Error(`Electron exited ${code ?? 'without code'} before UI queue-edit result.\nstderr:\n${tail(stderr)}`));
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

function tail(text) {
  return text.split(/\r?\n/).slice(-40).join('\n');
}
