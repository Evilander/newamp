import electronPath from 'electron';
import ffmpeg from 'ffmpeg-static';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const appRoot = resolve('.');
const smokeRoot = resolve('tmp', 'ui-lyrics-smoke');
const userData = join(smokeRoot, 'user-data');
const mediaDir = join(smokeRoot, 'media');
const fixturePath = join(mediaDir, 'Radiohead - Creep.mp3');
const marker = '[newamp-ui-lyrics-smoke] ';

if (!ffmpeg) {
  console.error('ffmpeg-static did not resolve a binary for this platform');
  process.exit(1);
}

await resetSmokeRoot();
await createFixture();
await writeSmokeSettings();

const result = await runElectronSmoke();
console.log(JSON.stringify(result, null, 2));
assertLyrics(result);

function assertLyrics(r) {
  const problems = [];
  if (r.ok !== true) problems.push(`probe reported ok=${r.ok}`);
  // Real synced lyrics arrived and were parsed into lines, not an empty panel.
  if (!(Number.isFinite(r.lineCount) && r.lineCount > 1)) {
    problems.push(`expected parsed lyric lines, got lineCount=${r.lineCount}`);
  }
  if (!(typeof r.activeLine === 'string' && r.activeLine.trim().length > 0)) {
    problems.push(`expected a highlighted active line, got ${JSON.stringify(r.activeLine)}`);
  }
  if (r.lyricSource !== 'lrclib') {
    problems.push(`expected lyrics from lrclib, got ${JSON.stringify(r.lyricSource)}`);
  }
  if (problems.length) {
    console.error(`[ui-lyrics-smoke] FAIL: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.error('[ui-lyrics-smoke] PASS');
}

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
    'sine=frequency=392:duration=42',
    '-metadata',
    'title=Creep',
    '-metadata',
    'artist=Radiohead',
    '-metadata',
    'album=Pablo Honey',
    '-metadata',
    'date=1993',
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

function runElectronSmoke() {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(String(electronPath), ['.'], {
      cwd: appRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEWAMP_UI_LYRICS_SMOKE: '1',
        NEWAMP_SMOKE_USER_DATA: userData,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      finish(new Error(`UI lyrics smoke timed out without result marker. stderr:\n${tail(stderr)}`));
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
        finish(new Error(`Electron exited ${code ?? 'without code'} before UI lyrics result.\nstderr:\n${tail(stderr)}`));
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
