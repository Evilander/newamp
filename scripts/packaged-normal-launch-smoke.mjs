import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve('.');
const exePath = resolve(repoRoot, 'release', 'win-unpacked', 'Newamp.exe');
const smokeRoot = resolve(repoRoot, 'tmp', 'packaged-normal-launch-smoke');
const userData = resolve(smokeRoot, `user-data-${process.pid}-${Date.now()}`);
const minAliveMs = Number(process.env.NEWAMP_NORMAL_LAUNCH_MIN_ALIVE_MS ?? 4000);
const timeoutMs = Number(process.env.NEWAMP_NORMAL_LAUNCH_TIMEOUT_MS ?? 15000);

assert.ok(existsSync(exePath), `packaged exe should exist: ${exePath}`);
mkdirSync(userData, { recursive: true });

const launchArgs = [
  `--newamp-user-data-dir=${userData}`,
];

const child = spawn(exePath, launchArgs, {
  cwd: dirname(exePath),
  env: {
    ...process.env,
    NEWAMP_USER_DATA_DIR: userData,
    ELECTRON_ENABLE_LOGGING: '1',
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

const started = Date.now();
while (Date.now() - started < minAliveMs) {
  if (spawnError || exitCode !== null) break;
  await sleep(250);
}

const elapsedMs = Date.now() - started;
const aliveLongEnough = !spawnError && exitCode === null && elapsedMs >= minAliveMs;
if (exitCode === null && Date.now() - started < timeoutMs) await cleanupLaunchedProcess(child.pid);

assert.ok(aliveLongEnough, diagnostic('packaged app should remain alive in normal launch mode'));
const launchDiagnostics = readLaunchDiagnostics(userData);
assert.ok(
  launchDiagnostics.events > 0,
  diagnostic('packaged app should write launch diagnostics during normal launch') +
    `\ndiagnostics=${JSON.stringify(launchDiagnostics, null, 2)}`,
);
assert.equal(
  launchDiagnostics.crashedChildren,
  0,
  diagnostic('packaged app should not crash child processes during idle normal launch') +
    `\ndiagnostics=${JSON.stringify(launchDiagnostics, null, 2)}`,
);

const artifactStat = statSync(exePath);
const report = {
  ok: true,
  minAliveMs,
  elapsedMs,
  artifact: {
    path: exePath,
    bytes: artifactStat.size,
    sha256: createHash('sha256').update(readFileSync(exePath)).digest('hex').toUpperCase(),
  },
  userData,
  exitCode,
  exitSignal,
  diagnostics: launchDiagnostics,
  stdout: stdout.trim().slice(-600),
  stderr: stderr.trim().slice(-1200),
};

console.log(JSON.stringify(report, null, 2));

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

async function cleanupLaunchedProcess(pid) {
  cleanupProcessTree(pid);
  await waitForExit(2000);
  if (exitCode === null) {
    child.kill('SIGKILL');
    await waitForExit(1000);
  }
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
}

function waitForExit(ms) {
  if (exitCode !== null) return Promise.resolve();
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

function diagnostic(message) {
  return [
    message,
    `minAliveMs=${minAliveMs}`,
    `elapsedMs=${elapsedMs}`,
    `spawnError=${spawnError?.message ?? 'null'}`,
    `exitCode=${exitCode ?? 'null'}`,
    `exitSignal=${exitSignal ?? 'null'}`,
    `stdout=${stdout.trim().slice(-300)}`,
    `stderr=${stderr.trim().slice(-900)}`,
  ].join('\n');
}

function readLaunchDiagnostics(path) {
  const eventsPath = resolve(path, 'diagnostics', 'events.jsonl');
  if (!existsSync(eventsPath)) {
    return { eventsPath, events: 0, crashedChildren: 0, crashedChildSamples: [] };
  }

  const events = readFileSync(eventsPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const crashed = events.filter((event) => {
    return (
      event.kind === 'child-process-gone' &&
      event.payload?.reason === 'crashed' &&
      ['Audio Service', 'GPU'].includes(String(event.payload?.name ?? event.payload?.serviceName ?? ''))
    );
  });

  return {
    eventsPath,
    events: events.length,
    crashedChildren: crashed.length,
    crashedChildSamples: crashed.slice(0, 5),
  };
}
