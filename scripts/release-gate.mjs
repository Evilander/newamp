import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkAudioHardwareReadiness, summarizeAudioHardware } from './audio-hardware-readiness-smoke.mjs';
import { checkInstalledAssociations, summarizeInstalledAssociations } from './installed-associations-smoke.mjs';
import { checkLiveServicesReadiness, summarizeLiveServices } from './live-services-readiness-smoke.mjs';
import { checkManualListeningProof, summarizeManualListeningProof } from './manual-listening-proof.mjs';
import { checkBuildProvenance } from './build-provenance.mjs';
import { checkReleaseBundle } from './release-bundle.mjs';
import { checkReleaseChecksums } from './release-checksums.mjs';

const repoRoot = resolve('.');
const args = new Set(process.argv.slice(2));
const allowUnsigned = args.has('--allow-unsigned');
const ackManual = args.has('--ack-manual');
const realLibrary = args.has('--real-library');
const skipSmokes = args.has('--skip-smokes');
const skipPackage = args.has('--skip-package');

const realLibraryRoot = process.env.NEWAMP_REAL_LIBRARY_ROOT || 'K:/music';
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const releaseVersion = String(pkg.version ?? '').trim() || '0.0.0';
const installerPath = resolve(repoRoot, 'release', `NewAmp Setup ${releaseVersion}.exe`);
const portablePath = resolve(repoRoot, 'release', `NewAmp Portable ${releaseVersion}.exe`);
const exePath = resolve(repoRoot, 'release', 'win-unpacked', 'NewAmp.exe');

const checks = [];
const blockers = [];
const acceptedBlockers = [];

if (!skipSmokes) {
  for (const script of [
    'smoke:library',
    'smoke:build-lock',
    'smoke:startup-bundle',
    'smoke:transcode',
    'smoke:incremental-scan',
    'smoke:scanner-queue',
    'smoke:music-folders',
    'smoke:library-paging',
    'smoke:album-art',
    'smoke:artist',
    'smoke:home',
    'smoke:quick-play',
    'smoke:folders',
    'smoke:search',
    'smoke:smart',
    'smoke:suggested-stations',
    'smoke:harmonic',
    'smoke:auto-dj',
    'smoke:avoid-autoplay',
    'smoke:podcast',
    'smoke:podcast-progress',
    'smoke:podcast-download',
    'smoke:mixes',
    'smoke:history',
    'smoke:playlist',
    'smoke:playlist-folder-export',
    'smoke:cue',
    'smoke:metadata',
    'smoke:health',
    'smoke:crash-diagnostics',
    'smoke:skin',
    'smoke:visualizer',
    'smoke:ui-visualizer',
    'smoke:ui-deck',
    'smoke:tabs',
    'smoke:lastfm',
    'smoke:lastfm-live-proof',
    'smoke:open-files',
    'smoke:playback-start',
    'smoke:playback-error',
    'smoke:playback-controls',
    'smoke:keyboard',
    'smoke:media-session',
    'smoke:smart-shuffle',
    'smoke:queue-insert',
    'smoke:queue-edit',
    'smoke:rating',
    'smoke:bookmarks',
    'smoke:practice-loop',
    'smoke:tempo',
    'smoke:replaygain',
    'smoke:session',
    'smoke:chrome-state',
    'smoke:audio-output',
    'smoke:audio-limiter',
    'smoke:ui-playback',
    'smoke:audio-proof',
    'smoke:manual-listening-proof',
    'smoke:ai-assist',
    'smoke:listening-proof-session',
    'smoke:eq',
    'smoke:security',
    'smoke:release-secrets',
    'smoke:signing-workflow',
    'smoke:build-provenance',
    'smoke:release-checksums',
    'smoke:release-bundle',
    'smoke:publish-github',
    'smoke:reliability',
    'smoke:support-backup',
    'smoke:support-restore',
    'smoke:library-watch',
    'smoke:library-prune',
    'smoke:ui-quick-play',
    'smoke:local-lyrics',
    'smoke:ui-local-lyrics',
  ]) {
    run('npm', ['run', script], `npm run ${script}`);
    checks.push({ name: script, ok: true });
  }
}

if (realLibrary) {
  if (!existsSync(realLibraryRoot)) {
    blockers.push(`${realLibraryRoot} is unavailable, so the real-library gate could not run.`);
  } else {
    run('npm', ['run', 'smoke:full-library', '--', realLibraryRoot], `npm run smoke:full-library -- ${realLibraryRoot}`);
    checks.push({ name: `smoke:full-library ${realLibraryRoot}`, ok: true });
    run(
      'npm',
      ['run', 'smoke:full-library', '--', realLibraryRoot],
      `npm run smoke:full-library -- ${realLibraryRoot} (incremental proof)`,
      {
        NEWAMP_FULL_SCAN_EXPECT_INCREMENTAL: '1',
        NEWAMP_FULL_SCAN_MAX_MS: process.env.NEWAMP_FULL_SCAN_INCREMENTAL_MAX_MS || '60000',
        NEWAMP_FULL_SCAN_MIN_SKIPPED: process.env.NEWAMP_FULL_SCAN_MIN_SKIPPED || '5000',
      },
    );
    checks.push({ name: `smoke:full-library ${realLibraryRoot} incremental`, ok: true });
    checks.push(await realLibraryProbe());
  }
}

if (!skipPackage) {
  run('npm', ['run', 'package'], 'npm run package');
  checks.push({ name: 'package', ok: true });
  run('npm', ['run', 'smoke:installer-artifact'], 'npm run smoke:installer-artifact');
  checks.push({ name: 'smoke:installer-artifact', ok: true });
  run('npm', ['run', 'smoke:packaged-normal-launch'], 'npm run smoke:packaged-normal-launch');
  checks.push({ name: 'smoke:packaged-normal-launch', ok: true });
  run('npm', ['run', 'smoke:packaged-open-files'], 'npm run smoke:packaged-open-files');
  checks.push({ name: 'smoke:packaged-open-files', ok: true });
  run('npm', ['run', 'smoke:portable-app'], 'npm run smoke:portable-app');
  checks.push({ name: 'smoke:portable-app', ok: true });
  run('npm', ['run', 'release:bundle'], 'npm run release:bundle');
  checks.push({ name: 'release:bundle', ok: true });
}

const artifactCheck = checkArtifacts();
checks.push(artifactCheck);

const releaseChecksumsCheck = checkReleaseChecksums({ root: repoRoot, version: releaseVersion });
checks.push(releaseChecksumsCheck);
if (!releaseChecksumsCheck.ok) blockers.push(`Release checksum manifest is not current: ${releaseChecksumsCheck.reason}`);

const buildProvenanceCheck = checkBuildProvenance({ root: repoRoot, version: releaseVersion });
checks.push(buildProvenanceCheck);
if (!buildProvenanceCheck.ok) blockers.push(`Build provenance is not current: ${buildProvenanceCheck.reason}`);

const releaseBundleCheck = checkReleaseBundle({ root: repoRoot, version: releaseVersion });
checks.push(releaseBundleCheck);
if (!releaseBundleCheck.ok) blockers.push(`Release bundle is not current: ${releaseBundleCheck.reason}`);

const associationCheck = checkFileAssociations();
checks.push(associationCheck);

const installedAssociationCheck = checkInstalledAssociations({ root: repoRoot, requiredOnly: true });
if (installedAssociationCheck.ok) {
  checks.push(installedAssociationCheck);
} else {
  const message = `Installed Explorer association proof missing: ${summarizeInstalledAssociations(installedAssociationCheck)}`;
  if (ackManual) {
    acceptedBlockers.push(message);
    checks.push({ ...installedAssociationCheck, ok: true, accepted: true });
  } else {
    blockers.push(message);
    checks.push(installedAssociationCheck);
  }
}

const startupCheck = runPackagedStartupSmoke();
checks.push(startupCheck);
const normalLaunchCheck = await runPackagedNormalLaunchSmoke();
checks.push(normalLaunchCheck);
if (!normalLaunchCheck.ok) blockers.push(`Packaged app does not stay open in normal launch mode: ${normalLaunchCheck.reason}`);

let signatureCheck = checkSignatures();
if (!signatureCheck.ok) {
  const message = `Authenticode signatures are not valid: ${signatureCheck.statuses.map((item) => `${item.name}=${item.status}`).join(', ')}`;
  if (allowUnsigned) {
    acceptedBlockers.push(message);
    signatureCheck = { ...signatureCheck, ok: true, accepted: true };
  } else {
    blockers.push(message);
  }
}
checks.push(signatureCheck);

const liveServicesCheck = await checkLiveServicesReadiness();
if (liveServicesCheck.ok) {
  checks.push(liveServicesCheck);
} else {
  const message = `Live service proof missing: ${summarizeLiveServices(liveServicesCheck)}`;
  if (ackManual) {
    acceptedBlockers.push(message);
    checks.push({ ...liveServicesCheck, ok: true, accepted: true });
  } else {
    blockers.push(message);
    checks.push(liveServicesCheck);
  }
}

const audioHardwareCheck = await checkAudioHardwareReadiness();
if (audioHardwareCheck.ok) {
  checks.push(audioHardwareCheck);
} else {
  const message = `Audio hardware readiness missing: ${summarizeAudioHardware(audioHardwareCheck)}`;
  if (ackManual) acceptedBlockers.push(message);
  else blockers.push(message);
  checks.push(audioHardwareCheck);
}

const manualListeningCheck = checkManualListeningProof();
if (manualListeningCheck.ok) {
  checks.push(manualListeningCheck);
} else {
  const message = `Human audible playback, output-device switching, crossfade, and gapless proof still require a speaker/headphone pass (${summarizeAudioHardware(audioHardwareCheck)}; ${summarizeManualListeningProof(manualListeningCheck)}).`;
  if (ackManual) {
    acceptedBlockers.push(message);
    checks.push({ ...manualListeningCheck, ok: true, accepted: true });
  } else {
    blockers.push(message);
    checks.push(manualListeningCheck);
  }
}

const automatedOk = checks.every((check) => check.ok);
const releaseReady = automatedOk && blockers.length === 0 && acceptedBlockers.length === 0;
const localOk = automatedOk && blockers.length === 0;
const report = {
  ok: releaseReady || localOk,
  automatedOk,
  releaseReady,
  mode: {
    allowUnsigned,
    ackManual,
    realLibrary,
    realLibraryRoot,
    skipSmokes,
    skipPackage,
  },
  checks,
  blockers,
  acceptedBlockers,
};

console.log(JSON.stringify(report, null, 2));
process.exitCode = localOk ? 0 : 1;

function run(command, commandArgs, label, extraEnv = {}) {
  console.error(`[release-gate] ${label}`);
  const isWindows = process.platform === 'win32';
  const result = spawnSync(
    isWindows ? 'cmd.exe' : command,
    isWindows
      ? ['/d', '/s', '/c', [quoteForCmd(command), ...commandArgs.map(quoteForCmd)].join(' ')]
      : commandArgs,
    {
      cwd: repoRoot,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
    },
  );
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function checkArtifacts() {
  const installer = artifact(installerPath, 100_000_000);
  const portable = artifact(portablePath, 100_000_000);
  const exe = artifact(exePath, 200_000_000);
  return {
    name: 'artifacts',
    ok: installer.ok && portable.ok && exe.ok,
    installer,
    portable,
    exe,
  };
}

function artifact(path, minimumBytes) {
  if (!existsSync(path)) {
    return { ok: false, path, exists: false, minimumBytes };
  }
  const stat = statSync(path);
  return {
    ok: stat.size >= minimumBytes,
    path,
    exists: true,
    bytes: stat.size,
    minimumBytes,
    sha256: sha256(path),
  };
}

function checkFileAssociations() {
  const associations = pkg.build?.fileAssociations ?? [];
  const extGroups = associations.map((item) => item.ext ?? []).flat();
  const required = ['mp3', 'flac', 'wav', 'm4a', 'wma', 'm3u', 'm3u8', 'pls', 'cue'];
  const missing = required.filter((ext) => !extGroups.includes(ext));
  return {
    name: 'file-association-config',
    ok: missing.length === 0,
    required,
    missing,
    configured: extGroups.length,
  };
}

function runPackagedStartupSmoke() {
  if (!existsSync(exePath)) {
    return { name: 'packaged-startup-smoke', ok: false, reason: 'packaged exe missing' };
  }
  const smokeUserData = resolve(repoRoot, 'tmp', `release-gate-packaged-smoke-user-data-${process.pid}-${Date.now()}`);
  mkdirSync(smokeUserData, { recursive: true });
  const startupMarker = '[newamp] startup smoke loaded';
  const startupArgs = [
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-software-rasterizer',
    '--disable-accelerated-2d-canvas',
    '--disable-features=CalculateNativeWinOcclusion,UseSkiaRenderer,VizDisplayCompositor',
    '--in-process-gpu',
    '--no-sandbox',
  ];
  const result = spawnSync(exePath, startupArgs, {
    cwd: dirname(exePath),
    encoding: 'utf8',
    env: {
      ...process.env,
      NEWAMP_STARTUP_SMOKE: '1',
      NEWAMP_SMOKE_USER_DATA: smokeUserData,
    },
    windowsHide: true,
    timeout: 20_000,
  });
  if (result.error) cleanupPackagedSmokeProcess();
  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();
  const stderrAnalysis = analyzePackagedLaunchStderr(stderr);
  return {
    name: 'packaged-startup-smoke',
    ok: result.status === 0 && !result.error && stdout.includes(startupMarker),
    exitCode: result.status,
    error: result.error?.message ?? null,
    requiredStdout: startupMarker,
    stdout: stdout.slice(-600),
    stderr: stderrAnalysis.unexpected.join('\n').slice(-600),
    acceptedStderr: stderrAnalysis.accepted,
    unexpectedStderr: stderrAnalysis.unexpected,
  };
}

async function runPackagedNormalLaunchSmoke() {
  if (!existsSync(exePath)) {
    return { name: 'packaged-normal-launch-smoke', ok: false, reason: 'packaged exe missing' };
  }
  const smokeUserData = resolve(repoRoot, 'tmp', `release-gate-normal-launch-user-data-${process.pid}-${Date.now()}`);
  mkdirSync(smokeUserData, { recursive: true });
  const minAliveMs = 4000;
  const launchArgs = [
    `--newamp-user-data-dir=${smokeUserData}`,
  ];
  const child = spawn(exePath, launchArgs, {
    cwd: dirname(exePath),
    env: {
      ...process.env,
      NEWAMP_USER_DATA_DIR: smokeUserData,
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
  const ok = !spawnError && exitCode === null && elapsedMs >= minAliveMs;
  if (exitCode === null) {
    cleanupProcessTree(child.pid);
    await waitForChildExit(child, () => exitCode !== null, 2000);
    if (exitCode === null) {
      child.kill('SIGKILL');
      await waitForChildExit(child, () => exitCode !== null, 1000);
    }
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
  const stderrAnalysis = analyzePackagedLaunchStderr(stderr);
  return {
    name: 'packaged-normal-launch-smoke',
    ok,
    minAliveMs,
    elapsedMs,
    exitCode,
    exitSignal,
    error: spawnError?.message ?? null,
    stdout: stdout.trim().slice(-600),
    stderr: stderrAnalysis.unexpected.join('\n').slice(-1200),
    acceptedStderr: stderrAnalysis.accepted,
    unexpectedStderr: stderrAnalysis.unexpected,
    reason: ok ? null : `exited before ${minAliveMs}ms`,
  };
}

function analyzePackagedLaunchStderr(raw) {
  const accepted = [];
  const unexpected = [];
  let acceptingTrayStack = false;
  for (const line of raw.trim().split(/\r?\n/).filter(Boolean)) {
    if (isExpectedPackagedLaunchWarning(line) || (acceptingTrayStack && /^\s+at\s/.test(line))) {
      accepted.push(line);
      acceptingTrayStack = line.includes('[newamp] tray icon unavailable') || (acceptingTrayStack && /^\s+at\s/.test(line));
      continue;
    }
    acceptingTrayStack = false;
    unexpected.push(line);
  }
  return {
    accepted: accepted.slice(-20),
    unexpected: unexpected.slice(-20),
  };
}

function isExpectedPackagedLaunchWarning(line) {
  return (
    /notify_icon\.cc/.test(line) ||
    /Failed to create shared context for virtualization/.test(line) ||
    /\[newamp\] tray icon unavailable/.test(line) ||
    /\[newamp\] global media shortcut not registered:/.test(line) ||
    /\[newamp\] global media shortcut unavailable:/.test(line) ||
    /Windows notification area did not accept the tray icon/.test(line)
  );
}

function checkSignatures() {
  const statuses = [
    { name: 'installer', path: installerPath },
    { name: 'portable', path: portablePath },
    { name: 'exe', path: exePath },
  ].map((item) => ({ ...item, ...signatureStatus(item.path) }));
  return {
    name: 'authenticode',
    ok: statuses.every((item) => item.status === 'Valid'),
    statuses,
  };
}

function signatureStatus(path) {
  if (process.platform !== 'win32') return { status: 'Skipped', statusMessage: 'Authenticode is Windows-only.' };
  const command = [
    '$sig = Get-AuthenticodeSignature -LiteralPath',
    quoteForPowerShell(path),
    '; [pscustomobject]@{ Status = [string]$sig.Status; StatusMessage = $sig.StatusMessage } | ConvertTo-Json -Compress',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    return { status: 'Error', statusMessage: (result.stderr || result.stdout || '').trim() };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      status: parsed.Status,
      statusMessage: parsed.StatusMessage ?? '',
    };
  } catch {
    return { status: 'Error', statusMessage: result.stdout.trim() };
  }
}

function cleanupPackagedSmokeProcess() {
  if (process.platform !== 'win32') return;
  const command = [
    'Get-Process NewAmp -ErrorAction SilentlyContinue',
    `| Where-Object { $_.Path -eq ${quoteForPowerShell(exePath)} }`,
    '| Stop-Process -Force',
  ].join(' ');
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function cleanupProcessTree(pid) {
  if (!pid || process.platform !== 'win32') return;
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    cwd: repoRoot,
    stdio: 'ignore',
    windowsHide: true,
  });
}

function waitForChildExit(child, isExited, ms) {
  if (isExited()) return Promise.resolve();
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function realLibraryProbe() {
  const { LibraryStore } = await import(pathToFileURL(resolve(repoRoot, 'dist-electron', 'electron', 'library.js')));
  const library = await LibraryStore.open(resolve(repoRoot, 'tmp', 'full-library-smoke', 'library.db'));
  const started = Date.now();
  try {
    const stats = library.getStats();
    const fresh = library.getTracks({ sort: 'added', limit: 12, offset: 0 });
    const harmonic = library.buildHarmonicMix({ count: 12 });
    const taste = library.buildTasteMix({ count: 12 });
    const query = 'deftones';
    const tracks = library.getTracks({ search: query, sort: 'artist', limit: 24, offset: 0 });
    const albums = library
      .getAlbums()
      .filter((album) => `${album.album} ${album.albumArtist}`.toLowerCase().includes(query))
      .slice(0, 8);
    const artists = library
      .getArtists()
      .filter((artist) => artist.artist.toLowerCase().includes(query))
      .slice(0, 8);
    const elapsedMs = Date.now() - started;
    return {
      name: 'real-library-probe',
      ok: stats.tracks >= 5000 && fresh.length > 0 && harmonic.length > 0 && taste.length > 0 && tracks.length > 0 && elapsedMs < 5000,
      elapsedMs,
      stats,
      rails: {
        fresh: fresh.length,
        harmonic: harmonic.length,
        taste: taste.length,
      },
      commandPaletteQuery: {
        query,
        tracks: tracks.length,
        albums: albums.length,
        artists: artists.length,
      },
    };
  } finally {
    library.close();
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}

function quoteForCmd(value) {
  if (/^[A-Za-z0-9_./:\\=+-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function quoteForPowerShell(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
