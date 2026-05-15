import ffmpeg from 'ffmpeg-static';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInstalledAssociations, summarizeInstalledAssociations } from './installed-associations-smoke.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const releaseVersion = String(pkg.version ?? '').trim() || '0.0.0';
const installerPath = resolve(repoRoot, 'release', `Newamp Setup ${releaseVersion}.exe`);
const smokeRoot = resolve(repoRoot, 'tmp', 'installed-app-smoke');
const installerTemp = join(smokeRoot, 'installer-temp');
const userData = join(smokeRoot, 'user-data');
const mediaDir = join(smokeRoot, 'media');
const fixturePath = join(mediaDir, 'Newamp Installed App Smoke.mp3');
const marker = '[newamp-ui-open-file-smoke] ';
const installDirArg = args.find((arg) => arg.startsWith('--install-dir='));
const installDir = installDirArg ? resolve(installDirArg.slice('--install-dir='.length)) : '';
const skipInstall = args.includes('--skip-install');
const skipOpenFile = args.includes('--skip-open-file');

if (process.platform !== 'win32') {
  throw new Error('Installed app smoke is Windows-only because it verifies Explorer registry associations.');
}
if (!ffmpeg) {
  throw new Error('ffmpeg-static did not resolve a binary for this platform.');
}
if (!existsSync(installerPath)) {
  throw new Error(`Installer is missing: ${installerPath}. Run npm run package first.`);
}

await resetSmokeRoot();
await createFixture();
await writeSmokeSettings();

const install = skipInstall ? { skipped: true } : runInstaller();
const associationProof = await waitForInstalledAssociations();
const installedExe = associationProof.ok ? installedExeFromProof(associationProof) : null;
const openFile = !installedExe
  ? { skipped: true, reason: summarizeInstalledAssociations(associationProof) }
  : skipOpenFile
    ? { skipped: true }
    : await runInstalledOpenFileSmoke(installedExe);
const report = {
  ok: associationProof.ok && (skipOpenFile || openFile.ok),
  installer: {
    path: installerPath,
    installDir: installDir || null,
  },
  install,
  associationProof,
  installedExe,
  openFile,
};

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;

async function resetSmokeRoot() {
  await rm(smokeRoot, { recursive: true, force: true });
  await mkdir(mediaDir, { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(installerTemp, { recursive: true });
}

function runInstaller() {
  const installerArgs = ['/S', '/currentuser'];
  if (installDir) installerArgs.push(`/D=${installDir}`);
  const result = spawnSync(installerPath, installerArgs, {
    cwd: dirname(installerPath),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    env: {
      ...process.env,
      TEMP: installerTemp,
      TMP: installerTemp,
    },
  });
  return {
    ok: result.status === 0 && !result.error,
    exitCode: result.status,
    error: result.error?.message ?? null,
    args: installerArgs,
    temp: installerTemp,
    stdout: (result.stdout ?? '').trim().slice(-1000),
    stderr: (result.stderr ?? '').trim().slice(-1000),
  };
}

async function waitForInstalledAssociations() {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < 45_000) {
    latest = checkInstalledAssociations({ root: repoRoot, requiredOnly: true });
    if (latest.ok) return { ...latest, elapsedMs: Date.now() - started };
    await delay(1000);
  }
  return {
    ...(latest ?? checkInstalledAssociations({ root: repoRoot, requiredOnly: true })),
    elapsedMs: Date.now() - started,
    summary: latest ? summarizeInstalledAssociations(latest) : 'installed association proof did not run',
  };
}

function installedExeFromProof(proof) {
  const commands = (proof.registry?.proven ?? [])
    .map((item) => item.commandExe)
    .filter((value) => typeof value === 'string' && value.length > 0);
  const unique = [...new Set(commands.map((value) => value.toLowerCase()))];
  if (!proof.ok || commands.length === 0) {
    throw new Error(`Installed association proof failed: ${summarizeInstalledAssociations(proof)}`);
  }
  if (unique.length !== 1) {
    throw new Error(`Installed associations point at multiple executables: ${commands.join(', ')}`);
  }
  const exePath = commands[0];
  if (!existsSync(exePath)) throw new Error(`Installed executable is missing: ${exePath}`);
  return exePath;
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
      'sine=frequency=659.25:duration=3.2',
      '-metadata',
      'title=Packaged Open File Smoke',
      '-metadata',
      'artist=Newamp QA',
      '-metadata',
      'album=Installed Open With',
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

function runInstalledOpenFileSmoke(exePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(exePath, [fixturePath], {
      cwd: dirname(exePath),
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
      finish(new Error(`Installed open-file smoke timed out without result marker. stderr:\n${tail(stderr)}`));
    }, 35_000);

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
        finish(new Error(`Installed app exited ${code ?? 'without code'} before open-file result.\nstderr:\n${tail(stderr)}`));
      }
    });

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!child.killed) child.kill();
      if (err) rejectPromise(err);
      else {
        resolvePromise({
          ok: true,
          exePath,
          fixturePath,
          result: value,
        });
      }
    }
  });
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function tail(text) {
  return text.split(/\r?\n/).slice(-40).join('\n');
}
