import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Launches the packaged macOS .app through NewAmp's startup-smoke mode: the app
// boots the real packaged renderer over the newamp-app:// protocol, writes an
// {ok:true} marker on did-finish-load, and quits. This proves the packaged
// bundle (icon, entitlements, hardened runtime, CSP, protocol handler) actually
// launches — the macOS analog of packaged-normal-launch-smoke.mjs (Windows).
//
// Requires a display, so it runs locally / in the release workflow's macOS leg,
// not in the headless push CI.

const repoRoot = resolve('.');
const appCandidates = [
  resolve(repoRoot, 'release', 'mac-arm64', 'NewAmp.app'),
  resolve(repoRoot, 'release', 'mac', 'NewAmp.app'),
  resolve(repoRoot, 'release', 'mac-x64', 'NewAmp.app'),
];
const appPath = appCandidates.find((candidate) => existsSync(candidate));
assert.ok(appPath, `packaged macOS .app should exist (run \`npm run package:mac\` first); looked in: ${appCandidates.join(', ')}`);

const binPath = join(appPath, 'Contents', 'MacOS', 'NewAmp');
assert.ok(existsSync(binPath), `app executable should exist: ${binPath}`);

const bundledFfmpeg = join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg');
assert.ok(existsSync(bundledFfmpeg), `bundled ffmpeg should exist: ${bundledFfmpeg}`);
const ff = spawnSync(bundledFfmpeg, ['-version'], { encoding: 'utf8' });
assert.equal(ff.status, 0, `bundled ffmpeg -version should exit 0, got ${ff.status} (${ff.stderr || ''})`);

const smokeRoot = resolve(repoRoot, 'tmp', 'packaged-mac-launch-smoke');
const userData = join(smokeRoot, `user-data-${process.pid}-${process.hrtime.bigint()}`);
const marker = join(smokeRoot, `marker-${process.pid}.json`);
mkdirSync(userData, { recursive: true });
mkdirSync(dirname(marker), { recursive: true });

const timeoutMs = Number(process.env.NEWAMP_MAC_LAUNCH_TIMEOUT_MS ?? 30000);

const child = spawn(binPath, [`--newamp-user-data-dir=${userData}`], {
  cwd: dirname(binPath),
  env: {
    ...process.env,
    NEWAMP_STARTUP_SMOKE: '1',
    NEWAMP_STARTUP_SMOKE_MARKER: marker,
    NEWAMP_USER_DATA_DIR: userData,
    ELECTRON_ENABLE_LOGGING: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

const killTimer = setTimeout(() => {
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}, timeoutMs);

const { code, signal } = await new Promise((resolveExit) => {
  child.once('exit', (c, s) => resolveExit({ code: c, signal: s }));
  child.once('error', (err) => {
    clearTimeout(killTimer);
    console.error('[newamp] failed to spawn packaged app:', err);
    process.exit(1);
  });
});
clearTimeout(killTimer);

const markerData = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null;

assert.ok(markerData, `startup-smoke marker should be written: ${marker}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
assert.equal(markerData.ok, true, `packaged app should load the renderer (event=${markerData.event}); marker=${JSON.stringify(markerData)}`);
assert.equal(markerData.event, 'did-finish-load', `renderer should finish loading; marker=${JSON.stringify(markerData)}`);
assert.equal(signal, null, `app should exit cleanly, not be killed (signal=${signal})`);

console.log(JSON.stringify({ ok: true, appPath, exitCode: code, marker: markerData }, null, 2));
