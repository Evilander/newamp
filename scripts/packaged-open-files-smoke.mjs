import ffmpeg from 'ffmpeg-static';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const appRoot = resolve('.');
const smokeRoot = resolve('tmp', 'packaged-open-files-smoke');
const userData = join(smokeRoot, 'user-data');
const mediaDir = join(smokeRoot, 'media');
const fixturePath = join(mediaDir, 'Newamp Packaged Open File Smoke.mp3');
const exePath = resolve('release', 'win-unpacked', 'NewAmp.exe');
const marker = '[newamp-ui-open-file-smoke] ';

if (!ffmpeg) {
  console.error('ffmpeg-static did not resolve a binary for this platform');
  process.exit(1);
}
if (!existsSync(exePath)) {
  console.error(`Packaged executable is missing: ${exePath}`);
  console.error('Run npm run package before npm run smoke:packaged-open-files.');
  process.exit(1);
}

await resetSmokeRoot();
await createFixture();
await writeSmokeSettings();

const result = await runPackagedSmoke();
console.log(JSON.stringify(result, null, 2));

async function resetSmokeRoot() {
  await rm(smokeRoot, { recursive: true, force: true });
  await mkdir(mediaDir, { recursive: true });
  await mkdir(userData, { recursive: true });
}

async function createFixture() {
  const result = spawnSync(
    ffmpeg,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=587.33:duration=3.2',
      '-metadata',
      'title=Packaged Open File Smoke',
      '-metadata',
      'artist=Newamp QA',
      '-metadata',
      'album=Packaged Open With',
      '-metadata',
      'date=2026',
      '-c:a',
      'libmp3lame',
      '-q:a',
      '6',
      fixturePath,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0 || !existsSync(fixturePath)) {
    throw new Error(`ffmpeg fixture generation failed (${result.status})\n${result.stderr || result.stdout}`);
  }
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
        openaiModel: 'gpt-4.1-mini',
        firstLaunchTutorialSeen: true,
        crossfadeMs: 0,
        replayGain: 'off',
        resumeState: null,
        volume: 0,
        equalizer: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        eqEnabled: false,
      },
      null,
      2,
    ),
    'utf8',
  );
}

function runPackagedSmoke() {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(exePath, [fixturePath], {
      cwd: appRoot,
      env: {
        ...process.env,
        NEWAMP_UI_OPEN_FILE_SMOKE: '1',
        NEWAMP_SMOKE_USER_DATA: userData,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      finish(new Error(`Packaged open-file smoke timed out without result marker. stderr:\n${tail(stderr)}`));
    }, 35000);

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
        finish(new Error(`Packaged app exited ${code ?? 'without code'} before open-file result.\nstderr:\n${tail(stderr)}`));
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
