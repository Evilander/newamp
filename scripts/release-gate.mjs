import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkAudioHardwareReadiness, summarizeAudioHardware } from './audio-hardware-readiness-smoke.mjs';
import { checkInstalledAssociations, summarizeInstalledAssociations } from './installed-associations-smoke.mjs';
import { checkLiveServicesReadiness, summarizeLiveServices } from './live-services-readiness-smoke.mjs';
import { checkManualListeningProof, summarizeManualListeningProof } from './manual-listening-proof.mjs';

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
const installerPath = resolve(repoRoot, 'release', `Newamp Setup ${releaseVersion}.exe`);
const portablePath = resolve(repoRoot, 'release', `Newamp Portable ${releaseVersion}.exe`);
const exePath = resolve(repoRoot, 'release', 'win-unpacked', 'Newamp.exe');

const checks = [];
const blockers = [];
const acceptedBlockers = [];

if (!skipSmokes) {
  for (const script of [
    'smoke:library',
    'smoke:transcode',
    'smoke:incremental-scan',
    'smoke:scanner-queue',
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
    'smoke:podcast',
    'smoke:podcast-progress',
    'smoke:podcast-download',
    'smoke:mixes',
    'smoke:history',
    'smoke:playlist',
    'smoke:metadata',
    'smoke:health',
    'smoke:skin',
    'smoke:visualizer',
    'smoke:tabs',
    'smoke:lastfm',
    'smoke:open-files',
    'smoke:playback-start',
    'smoke:playback-controls',
    'smoke:smart-shuffle',
    'smoke:queue-insert',
    'smoke:queue-edit',
    'smoke:rating',
    'smoke:bookmarks',
    'smoke:practice-loop',
    'smoke:tempo',
    'smoke:replaygain',
    'smoke:session',
    'smoke:audio-output',
    'smoke:audio-limiter',
    'smoke:ui-playback',
    'smoke:audio-proof',
    'smoke:manual-listening-proof',
    'smoke:eq',
    'smoke:security',
    'smoke:signing-workflow',
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
    checks.push(await realLibraryProbe());
  }
}

if (!skipPackage) {
  run('npm', ['run', 'package'], 'npm run package');
  checks.push({ name: 'package', ok: true });
  run('npm', ['run', 'smoke:installer-artifact'], 'npm run smoke:installer-artifact');
  checks.push({ name: 'smoke:installer-artifact', ok: true });
  run('npm', ['run', 'smoke:packaged-open-files'], 'npm run smoke:packaged-open-files');
  checks.push({ name: 'smoke:packaged-open-files', ok: true });
  run('npm', ['run', 'smoke:portable-app'], 'npm run smoke:portable-app');
  checks.push({ name: 'smoke:portable-app', ok: true });
}

const artifactCheck = checkArtifacts();
checks.push(artifactCheck);

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

function run(command, commandArgs, label) {
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
      env: process.env,
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
  const required = ['mp3', 'flac', 'wav', 'm4a', 'wma', 'm3u', 'm3u8', 'pls'];
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
  return {
    name: 'packaged-startup-smoke',
    ok: result.status === 0 && !result.error && stdout.includes(startupMarker),
    exitCode: result.status,
    error: result.error?.message ?? null,
    requiredStdout: startupMarker,
    stdout: stdout.slice(-600),
    stderr: stderr.slice(-600),
  };
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
    'Get-Process Newamp -ErrorAction SilentlyContinue',
    `| Where-Object { $_.Path -eq ${quoteForPowerShell(exePath)} }`,
    '| Stop-Process -Force',
  ].join(' ');
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
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
