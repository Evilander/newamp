import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve('.');
const releaseRoot = resolve(repoRoot, 'release');
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const releaseVersion = String(pkg.version ?? '').trim() || '0.0.0';
const portablePath = resolve(releaseRoot, `NewAmp Portable ${releaseVersion}.exe`);
const smokeRoot = resolve(repoRoot, 'tmp', 'portable-app-smoke');
const markerPath = resolve(smokeRoot, `startup-${process.pid}-${Date.now()}.json`);
const wrapperTemp = resolve(smokeRoot, `wrapper-temp-${process.pid}-${Date.now()}`);
const smokeUserData = resolve(smokeRoot, `user-data-${process.pid}-${Date.now()}`);
const timeoutMs = Number(process.env.NEWAMP_PORTABLE_SMOKE_TIMEOUT_MS ?? 120_000);

assert.ok(existsSync(portablePath), `portable artifact should exist: ${portablePath}`);
mkdirSync(smokeRoot, { recursive: true });
mkdirSync(wrapperTemp, { recursive: true });
mkdirSync(smokeUserData, { recursive: true });

const startupArgs = [
  '--newamp-startup-smoke',
  `--newamp-startup-smoke-marker=${markerPath}`,
  '--disable-gpu',
  '--disable-gpu-compositing',
  '--disable-software-rasterizer',
  '--disable-accelerated-2d-canvas',
  '--disable-features=CalculateNativeWinOcclusion,UseSkiaRenderer,VizDisplayCompositor',
  '--in-process-gpu',
  '--no-sandbox',
];

const child = spawn(portablePath, startupArgs, {
  cwd: dirname(portablePath),
  env: {
    ...process.env,
    NEWAMP_STARTUP_SMOKE: '1',
    NEWAMP_STARTUP_SMOKE_MARKER: markerPath,
    NEWAMP_SMOKE_USER_DATA: smokeUserData,
    TEMP: wrapperTemp,
    TMP: wrapperTemp,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let stdout = '';
let stderr = '';
let exitCode = null;
let exitSignal = null;
let spawnError = null;
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});
child.once('error', (err) => {
  spawnError = err;
});
child.once('exit', (code, signal) => {
  exitCode = code;
  exitSignal = signal;
});

let marker = null;
let timedOut = false;
const started = Date.now();
while (Date.now() - started < timeoutMs) {
  marker = readMarker(markerPath);
  if (marker) break;
  if (spawnError) break;
  if (exitCode !== null) break;
  await sleep(500);
}
if (!marker && exitCode === null) timedOut = true;

if (marker || timedOut || exitCode !== 0) cleanupProcessTree(child.pid);

assert.ok(marker, diagnostic('portable startup marker should be written'));
assert.equal(marker.ok, true, diagnostic('portable startup marker should report success'));

const defaultTemp = checkDefaultTempUsable();
const plainLaunch = defaultTemp.ok
  ? await runPlainPortableLaunch()
  : { ok: true, skipped: true, reason: 'default temp is not writable in this host session', defaultTemp };
assert.equal(plainLaunch.ok, true, plainLaunchDiagnostic(plainLaunch));

const artifactStat = statSync(portablePath);
const report = {
  ok: true,
  artifact: {
    path: portablePath,
    bytes: artifactStat.size,
    sha256: createHash('sha256').update(readFileSync(portablePath)).digest('hex').toUpperCase(),
  },
  marker,
  elapsedMs: Date.now() - started,
  exitCode,
  exitSignal,
  stdout: stdout.trim().slice(-600),
  stderr: stderr.trim().slice(-600),
  plainLaunch,
};

console.log(JSON.stringify(report, null, 2));

function readMarker(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function cleanupProcessTree(pid) {
  if (!pid || process.platform !== 'win32') return;
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    cwd: repoRoot,
    stdio: 'ignore',
    windowsHide: true,
  });
}

function cleanupPortableSnapshot(snapshot) {
  const ids = (snapshot?.processes ?? [])
    .map((item) => Number(item.Id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length || process.platform !== 'win32') return;
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Stop-Process -Id ${ids.join(',')} -Force -ErrorAction SilentlyContinue`,
    ],
    {
      cwd: repoRoot,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
}

function waitForExit(child, ms) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

function checkDefaultTempUsable() {
  const tempRoot = tmpdir();
  let proofDir = null;
  try {
    proofDir = mkdtempSync(resolve(tempRoot, 'newamp-portable-temp-proof-'));
    return { ok: true, tempRoot, proofDir };
  } catch (err) {
    return { ok: false, tempRoot, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (proofDir) rmSync(proofDir, { recursive: true, force: true });
  }
}

async function runPlainPortableLaunch() {
  const child = spawn(portablePath, [], {
    cwd: dirname(portablePath),
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '1',
      NEWAMP_USER_DATA_DIR: resolve(smokeRoot, `plain-user-data-${process.pid}-${Date.now()}`),
      TEMP: wrapperTemp,
      TMP: wrapperTemp,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  let plainStdout = '';
  let plainStderr = '';
  let plainExitCode = null;
  let plainExitSignal = null;
  let plainSpawnError = null;
  let snapshot = null;
  child.stdout.on('data', (chunk) => {
    plainStdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    plainStderr += chunk;
  });
  child.once('error', (err) => {
    plainSpawnError = err;
  });
  child.once('exit', (code, signal) => {
    plainExitCode = code;
    plainExitSignal = signal;
  });

  const plainStarted = Date.now();
  while (Date.now() - plainStarted < 25_000) {
    snapshot = readPortableProcessSnapshot(child.pid);
    if (hasNsisErrorWindow(snapshot) || hasNewAmpMainWindow(snapshot)) break;
    if (plainSpawnError || plainExitCode !== null) break;
    await sleep(500);
  }

  const elapsedMs = Date.now() - plainStarted;
  const ok = !plainSpawnError && plainExitCode === null && hasNewAmpMainWindow(snapshot) && !hasNsisErrorWindow(snapshot);
  cleanupPortableSnapshot(snapshot);
  cleanupProcessTree(child.pid);
  await waitForExit(child, 3000);
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();

  return {
    ok,
    elapsedMs,
    pid: child.pid,
    exitCode: plainExitCode,
    exitSignal: plainExitSignal,
    spawnError: plainSpawnError?.message ?? null,
    snapshot,
    stdout: plainStdout.trim().slice(-600),
    stderr: plainStderr.trim().slice(-600),
  };
}

function readPortableProcessSnapshot(pid) {
  if (!pid || process.platform !== 'win32') return { processes: [] };
  const script = `
$targetPid = ${Number(pid)}
$items = @()
try { $items += Get-Process -Id $targetPid -ErrorAction SilentlyContinue } catch {}
try { $items += Get-Process -Name 'NewAmp*' -ErrorAction SilentlyContinue } catch {}
$items |
  Sort-Object Id -Unique |
  Select-Object Id, ProcessName, MainWindowTitle, Responding, @{ Name = 'Path'; Expression = { try { $_.Path } catch { $null } } } |
  ConvertTo-Json -Compress
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    return { processes: [], error: (result.stderr || result.stdout || '').trim().slice(-600) };
  }
  const raw = result.stdout.trim();
  if (!raw) return { processes: [] };
  try {
    const parsed = JSON.parse(raw);
    return { processes: Array.isArray(parsed) ? parsed : [parsed] };
  } catch (err) {
    return { processes: [], error: err instanceof Error ? err.message : String(err), raw: raw.slice(-600) };
  }
}

function hasNsisErrorWindow(snapshot) {
  return (snapshot?.processes ?? []).some((item) => /NSIS Error/i.test(String(item.MainWindowTitle ?? '')));
}

function hasNewAmpMainWindow(snapshot) {
  return (snapshot?.processes ?? []).some((item) => String(item.MainWindowTitle ?? '') === 'NewAmp');
}

function diagnostic(message) {
  return [
    message,
    `marker=${markerPath}`,
    `timedOut=${timedOut}`,
    `spawnError=${spawnError?.message ?? 'null'}`,
    `exitCode=${exitCode ?? 'null'}`,
    `exitSignal=${exitSignal ?? 'null'}`,
    `stdout=${stdout.trim().slice(-300)}`,
    `stderr=${stderr.trim().slice(-300)}`,
  ].join('\n');
}

function plainLaunchDiagnostic(plainLaunch) {
  return [
    'portable artifact should open the NewAmp window in plain double-click mode',
    `ok=${plainLaunch.ok}`,
    `elapsedMs=${plainLaunch.elapsedMs}`,
    `pid=${plainLaunch.pid}`,
    `spawnError=${plainLaunch.spawnError ?? 'null'}`,
    `exitCode=${plainLaunch.exitCode ?? 'null'}`,
    `exitSignal=${plainLaunch.exitSignal ?? 'null'}`,
    `snapshot=${JSON.stringify(plainLaunch.snapshot)}`,
    `stdout=${plainLaunch.stdout}`,
    `stderr=${plainLaunch.stderr}`,
  ].join('\n');
}
