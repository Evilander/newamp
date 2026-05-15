import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve('.');
const releaseRoot = resolve(repoRoot, 'release');
const portablePath = resolve(releaseRoot, 'Newamp Portable 0.1.0.exe');
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
