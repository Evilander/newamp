import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve('.');
const electronPath = process.platform === 'win32'
  ? resolve(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : resolve(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const smokeRoot = resolve(repoRoot, 'tmp', 'crash-diagnostics-smoke');
const userData = resolve(smokeRoot, `user-data-${process.pid}-${Date.now()}`);
const markerPath = resolve(smokeRoot, `startup-${process.pid}-${Date.now()}.json`);
const timeoutMs = 30_000;

assert.ok(existsSync(electronPath), `Electron binary should exist: ${electronPath}`);
mkdirSync(userData, { recursive: true });

const child = spawn(electronPath, [
  '.',
  '--newamp-startup-smoke',
  `--newamp-startup-smoke-marker=${markerPath}`,
  `--newamp-user-data-dir=${userData}`,
], {
  cwd: repoRoot,
  env: {
    ...process.env,
    NEWAMP_STARTUP_SMOKE: '1',
    NEWAMP_STARTUP_SMOKE_MARKER: markerPath,
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
while (Date.now() - started < timeoutMs) {
  if (existsSync(markerPath) || spawnError || exitCode !== null) break;
  await sleep(250);
}
await waitForExit(5000);

const marker = readJson(markerPath);
assert.equal(marker?.ok, true, diagnostic('startup marker should report success'));
assert.equal(exitCode, 0, diagnostic('startup smoke should exit cleanly'));

const diagnosticsDir = resolve(userData, 'diagnostics');
const crashDumpsDir = resolve(diagnosticsDir, 'crash-dumps');
const eventsPath = resolve(diagnosticsDir, 'events.jsonl');
assert.ok(existsSync(crashDumpsDir), `crash dumps directory should exist: ${crashDumpsDir}`);
assert.ok(existsSync(eventsPath), `diagnostic event log should exist: ${eventsPath}`);

const events = readFileSync(eventsPath, 'utf8')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const startEvent = events.find((event) => event.kind === 'crash-reporter-started');
assert.ok(startEvent, 'diagnostic log should include crash-reporter-started event');
assert.equal(startEvent.paths.userData, userData, 'diagnostic event should use isolated smoke user data');
assert.equal(startEvent.paths.crashDumps, crashDumpsDir, 'diagnostic event should expose the crash dump path');

const report = {
  ok: true,
  userData,
  diagnosticsDir,
  crashDumps: {
    path: crashDumpsDir,
    exists: true,
  },
  events: {
    path: eventsPath,
    bytes: statSync(eventsPath).size,
    kinds: events.map((event) => event.kind),
  },
  marker,
  elapsedMs: Date.now() - started,
  stdout: stdout.trim().slice(-600),
  stderr: stderr.trim().slice(-600),
};

console.log(JSON.stringify(report, null, 2));

function readJson(path) {
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
    `spawnError=${spawnError?.message ?? 'null'}`,
    `exitCode=${exitCode ?? 'null'}`,
    `exitSignal=${exitSignal ?? 'null'}`,
    `marker=${markerPath}`,
    `stdout=${stdout.trim().slice(-300)}`,
    `stderr=${stderr.trim().slice(-600)}`,
  ].join('\n');
}
