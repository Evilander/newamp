import assert from 'node:assert/strict';
import electronPath from 'electron';
import ffmpeg from 'ffmpeg-static';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const appRoot = resolve('.');
const appPath = process.env.NEWAMP_UI_ART_APP_PATH ? resolve(process.env.NEWAMP_UI_ART_APP_PATH) : null;
const smokeRoot = resolve('tmp', 'ui-art-smoke');
const userData = join(smokeRoot, 'user-data');
const mediaDir = join(smokeRoot, 'media');
const fixturePath = join(mediaDir, 'Newamp UI Art Smoke.mp3');
const marker = '[newamp-ui-art-smoke] ';

if (!ffmpeg) {
  console.error('ffmpeg-static did not resolve a binary for this platform');
  process.exit(1);
}

await resetSmokeRoot();
await createFixture();
await writeSmokeSettings();

const result = await runElectronSmoke();
assert.equal(result.ok, true, 'UI art smoke should report success');
assert.match(result.title, /Art Smoke/, 'art smoke should inspect the generated fixture');
assert.match(result.contentType, /^image\//, `art content type should be an image: ${result.contentType}`);
assert.ok(result.bytes > 50, `art response should include image bytes: ${result.bytes}`);
assert.ok(result.image.naturalWidth > 0, 'image element should decode custom-protocol album art');
assert.ok(result.image.naturalHeight > 0, 'image element should decode custom-protocol album art');
console.log(JSON.stringify(result, null, 2));

async function resetSmokeRoot() {
  await rm(smokeRoot, { recursive: true, force: true });
  await mkdir(mediaDir, { recursive: true });
  await mkdir(userData, { recursive: true });
}

async function createFixture() {
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=523:duration=3',
    '-metadata',
    'title=Art Smoke',
    '-metadata',
    'artist=Newamp QA',
    '-metadata',
    'album=Cover Protocol',
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

  await writeFile(
    join(mediaDir, 'cover.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAKklEQVR4nGP8z8Dwn4ECwESJ5lEDRg0YNWDUgFEDRg0YNWDUgAEA2SMDIR9ueXgAAAAASUVORK5CYII=',
      'base64',
    ),
  );
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
    const child = spawn(appPath || String(electronPath), appPath ? [] : ['.'], {
      cwd: appPath ? dirname(appPath) : appRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEWAMP_UI_ART_SMOKE: '1',
        NEWAMP_SMOKE_USER_DATA: userData,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      finish(new Error(`UI art smoke timed out without result marker. stderr:\n${tail(stderr)}`));
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
        finish(new Error(`Electron exited ${code ?? 'without code'} before UI art result.\nstderr:\n${tail(stderr)}`));
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
  return text.split(/\r?\n/).slice(-60).join('\n');
}
