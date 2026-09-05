import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const appDir = resolve(String(args.appDir ?? join(repoRoot, 'release', 'linux-unpacked')));
const executable = resolve(appDir, 'newamp');
const timeoutMs = boundedInt(process.env.NEWAMP_LINUX_STARTUP_TIMEOUT_MS, 25000, 'NEWAMP_LINUX_STARTUP_TIMEOUT_MS', 5000, 120000);
const cleanAfter = process.env.NEWAMP_LINUX_STARTUP_CLEAN_AFTER === '1' || args.cleanAfter === true;
const disableGpu = args.disableGpu === true || process.env.NEWAMP_LINUX_STARTUP_DISABLE_GPU === '1';
const runParent = resolve(repoRoot, 'tmp', 'linux-startup-check');
const runRoot = await createRunRoot(runParent);
const homeDir = join(runRoot, 'home');
const xdgConfigHome = join(runRoot, 'xdg-config');
const stdoutPath = join(runRoot, 'stdout.log');
const stderrPath = join(runRoot, 'stderr.log');
const pidPath = join(runRoot, 'newamp.pid');

const report = {
  ok: false,
  appDir,
  executable,
  runRoot,
  timeoutMs,
  cleanAfter,
  dependencyCheck: null,
  launch: null,
  cdp: null,
  diagnostics: null,
  paths: null,
  stderrTail: '',
  stdoutTail: '',
  reportPath: join(runRoot, 'report.json'),
};

assert.ok(existsSync(executable), `Linux packaged executable should exist: ${executable}`);
await mkdir(homeDir, { recursive: true });
await mkdir(xdgConfigHome, { recursive: true });

const dependencyCheck = runWslSync(`ldd ${bashQuote(toWslPath(executable))} | grep 'not found' || true`);
report.dependencyCheck = {
  missing: dependencyCheck.stdout.trim().split(/\r?\n/).filter(Boolean),
  stderr: dependencyCheck.stderr.trim(),
  status: dependencyCheck.status,
};
if (report.dependencyCheck.missing.length) {
  await writeReport(report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(2);
}

let child = null;
let linuxPid = null;

try {
  const launchScript = `
set -eu
cd ${bashQuote(toWslPath(appDir))}
unset APPDATA LOCALAPPDATA NEWAMP_USER_DATA_DIR NEWAMP_SESSION_DATA_DIR NEWAMP_STARTUP_SMOKE NEWAMP_SMOKE_USER_DATA NEWAMP_STARTUP_SMOKE_MARKER
export HOME=${bashQuote(toWslPath(homeDir))}
export XDG_CONFIG_HOME=${bashQuote(toWslPath(xdgConfigHome))}
export ELECTRON_ENABLE_LOGGING=1
${disableGpu ? 'export NEWAMP_DISABLE_HARDWARE_ACCELERATION=1' : 'unset NEWAMP_DISABLE_HARDWARE_ACCELERATION'}
echo $$ > ${bashQuote(toWslPath(pidPath))}
exec ./newamp --no-sandbox --remote-debugging-port=0 >${bashQuote(toWslPath(stdoutPath))} 2>${bashQuote(toWslPath(stderrPath))}
`;
  child = spawn('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', launchScript], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });

  linuxPid = await waitForLinuxPid(pidPath, timeoutMs);
  report.launch = { linuxPid, args: ['--no-sandbox', '--remote-debugging-port=0'], disableGpu };

  const cdp = await waitForCdpTarget(runRoot, timeoutMs);
  report.cdp = cdp.summary;

  const runtime = await waitForRuntimeReady(cdp.target.webSocketDebuggerUrl, timeoutMs);
  report.diagnostics = runtime.supportDiagnostics;

  const userDataPath = runtime.supportDiagnostics?.userDataPath;
  const sessionDataPath = userDataPath ? `${userDataPath.replace(/\/+$/, '')}/session-data` : null;
  const sessionDataStat = sessionDataPath ? await stat(fromWslPath(sessionDataPath)).catch(() => null) : null;
  report.paths = {
    href: runtime.href,
    readyState: runtime.readyState,
    userDataPath,
    sessionDataPath,
    sessionDataExists: !!sessionDataStat?.isDirectory(),
    sessionDataOutsideAsar: !!sessionDataPath && !sessionDataPath.includes('app.asar'),
    userDataUnderTempXdg: !!userDataPath && normalizeSlash(userDataPath).startsWith(normalizeSlash(toWslPath(xdgConfigHome))),
    windowsAppDataUnset: true,
    smokeModeUnset: true,
  };

  const events = readDiagnosticsEvents(userDataPath);
  const badEvents = events.filter((event) =>
    ['main-uncaught-exception', 'main-unhandled-rejection', 'bootstrap-failed', 'app-render-process-gone', 'window-render-process-gone'].includes(String(event.kind)),
  );
  const stderr = safeReadTail(stderrPath);
  const stdout = safeReadTail(stdoutPath);
  report.stderrTail = stderr;
  report.stdoutTail = stdout;
  report.diagnostics = {
    ...report.diagnostics,
    eventCount: events.length,
    badEvents,
    stderrStartupErrors: stderr.split(/\r?\n/).filter((line) => /uncaught exception|unhandled rejection|bootstrap-failed|loadURL failed|newamp-app protocol error/i.test(line)),
  };

  report.ok =
    runtime.href?.startsWith('newamp-app://app/') &&
    runtime.readyState === 'complete' &&
    !!runtime.supportDiagnostics &&
    report.paths.sessionDataExists &&
    report.paths.sessionDataOutsideAsar &&
    report.paths.userDataUnderTempXdg &&
    badEvents.length === 0 &&
    report.diagnostics.stderrStartupErrors.length === 0;

  await writeReport(report);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
} finally {
  if (linuxPid) await terminateLinuxPid(linuxPid);
  if (child) {
    await waitForChildExit(child, 3000);
    child.kill('SIGKILL');
  }
  if (cleanAfter) await rm(runRoot, { recursive: true, force: true });
}

async function waitForLinuxPid(path, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (existsSync(path)) {
      const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Linux pid file: ${path}`);
}

async function waitForCdpTarget(root, timeout) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const portFile = await findFirstFile(root, 'DevToolsActivePort');
      if (portFile) {
        const [portLine] = (await readFile(portFile, 'utf8')).split(/\r?\n/);
        const port = Number.parseInt(portLine, 10);
        if (Number.isInteger(port) && port > 0) {
          const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
          const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
          const target = targets.find((item) => item.type === 'page' && String(item.url).startsWith('newamp-app://app/'));
          if (target?.webSocketDebuggerUrl) {
            return {
              target,
              summary: {
                port,
                browser: version.Browser,
                protocolVersion: version['Protocol-Version'],
                targetId: target.id,
                targetUrl: target.url,
                targetTitle: target.title,
              },
            };
          }
        }
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for NewAmp CDP target${lastError ? `: ${lastError.message}` : ''}`);
}

async function evaluateCdp(webSocketDebuggerUrl, expression) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('Timed out opening CDP websocket')), 5000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolveOpen();
    }, { once: true });
    ws.addEventListener('error', (event) => {
      clearTimeout(timer);
      rejectOpen(event.error ?? new Error('CDP websocket failed'));
    }, { once: true });
  });
  try {
    const result = await cdpRequest(ws, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`CDP evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result?.value;
  } finally {
    ws.close();
  }
}

async function waitForRuntimeReady(webSocketDebuggerUrl, timeout) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < timeout) {
    latest = await evaluateCdp(
      webSocketDebuggerUrl,
      `(async () => ({
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        hasNewAmpApi: !!window.newamp,
        supportDiagnostics: window.newamp ? await window.newamp.getSupportDiagnostics() : null
      }))()`,
    );
    if (latest?.readyState === 'complete' && latest?.supportDiagnostics) return latest;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for NewAmp runtime readiness after ${timeout}ms; last snapshot: ${JSON.stringify(latest)}`);
}

function cdpRequest(ws, method, params) {
  const id = cdpRequest.nextId = (cdpRequest.nextId ?? 0) + 1;
  return new Promise((resolveRequest, rejectRequest) => {
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (message.error) rejectRequest(new Error(JSON.stringify(message.error)));
      else resolveRequest(message.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function findFirstFile(root, name) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = await findFirstFile(path, name);
      if (found) return found;
    }
  }
  return null;
}

async function terminateLinuxPid(pid) {
  runWslSync(`
if kill -0 ${pid} 2>/dev/null; then
  kill -TERM ${pid} 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 ${pid} 2>/dev/null || exit 0
    sleep 0.2
  done
  kill -KILL ${pid} 2>/dev/null || true
fi
`);
}

function waitForChildExit(child, timeout) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, timeout);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

function readDiagnosticsEvents(userDataPath) {
  if (!userDataPath) return [];
  const eventsPath = join(fromWslPath(userDataPath), 'diagnostics', 'events.jsonl');
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, 'utf8')
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
}

function safeReadTail(path) {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8').trim().slice(-4000);
}

async function writeReport(report) {
  await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function runWslSync(script) {
  return spawnSync('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function parseArgs(argv) {
  const out = {};
  const allowed = new Set(['app-dir']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--clean-after') {
      out.cleanAfter = true;
      continue;
    }
    if (arg === '--disable-gpu') {
      out.disableGpu = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    if (!allowed.has(arg.slice(2))) throw new Error(`Unknown argument: ${arg}`);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    out.appDir = next;
    i += 1;
  }
  return out;
}

async function createRunRoot(parent) {
  await ensurePlainDirectoryChain(parent);
  return mkdtemp(join(parent, 'run-'));
}

async function ensurePlainDirectoryChain(target) {
  const rel = relative(repoRoot, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Run directory must stay under repository tmp: ${target}`);
  }
  await assertPlainDirectory(repoRoot);
  let current = repoRoot;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) await mkdir(current);
    await assertPlainDirectory(current);
  }
}

async function assertPlainDirectory(path) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Run directory ancestor must be a real directory: ${path}`);
  }
}

function toWslPath(path) {
  const match = resolve(path).match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) throw new Error(`Cannot convert Windows path to WSL path: ${path}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

function fromWslPath(path) {
  const match = String(path).match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (!match) return path;
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`;
}

function bashQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizeSlash(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '');
}

function boundedInt(value, fallback, label, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be an integer.`);
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
