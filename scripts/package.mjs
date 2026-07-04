import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBuildProvenance } from './build-provenance.mjs';
import { writeReleaseChecksums } from './release-checksums.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const releaseVersion = String(JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version ?? '').trim() || '0.0.0';
const packageTemp = join(repoRoot, 'tmp', 'package-temp');
const releaseRoot = join(repoRoot, 'release');
const builderDebugPath = join(releaseRoot, 'builder-debug.yml');
const nsisBuilderDebugPath = join(releaseRoot, 'builder-debug-nsis.yml');

await resetPackageTemp();
await pruneObsoleteReleaseArtifacts(releaseVersion);
await mkdir(packageTemp, { recursive: true });

run('npm', ['run', 'build']);
// Windows-only WASAPI-exclusive addon: no-ops on other platforms and when the
// staged prebuilt binary is already newer than its sources. Plain 'node' (not
// process.execPath): run() shells out, and a quoted spaces-in-path executable
// breaks cmd.exe's argument parsing.
run('node', [join(repoRoot, 'scripts', 'build-native.mjs')]);

const electronBuilder = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
);

const requestedTargets = process.argv.slice(2);
for (const args of electronBuilderTargetArgs(requestedTargets)) {
  const macArch = args.includes('--arm64') ? 'arm64' : args.includes('--x64') ? 'x64' : null;
  if (args.includes('--mac') && macArch) {
    run(process.execPath, [join(repoRoot, 'scripts', 'stage-ffmpeg-for-arch.mjs'), macArch]);
  }
  // `--publish never`: NewAmp manages its own release publishing (release
  // bundle + the CI release job + publish-github-release). Without this,
  // electron-builder auto-publishes when it sees a git tag and aborts with
  // "GitHub Personal Access Token is not set" on tagged CI builds.
  run(electronBuilder, [...args, '--publish', 'never'], {
    env: {
      ...process.env,
      TEMP: packageTemp,
      TMP: packageTemp,
      ELECTRON_CACHE: join(packageTemp, 'electron-cache'),
    },
  });
  if (args.includes('--win=nsis')) {
    await copyFile(builderDebugPath, nsisBuilderDebugPath);
  }
}

const shouldWriteChecksums = requestedTargets.length === 0 || requestedTargets.includes('--all');
if (shouldWriteChecksums) {
  const checksums = writeReleaseChecksums({ root: repoRoot });
  console.log(`release checksums: ${checksums.path}`);
  const provenance = writeBuildProvenance({ root: repoRoot });
  console.log(`build provenance: ${provenance.path}`);
}

function electronBuilderTargetArgs(args) {
  if (args.includes('--portable')) return [['--win=portable']];
  if (args.includes('--installer') || args.includes('--nsis')) return [['--win=nsis']];
  if (args.includes('--linux')) return [['--linux=tar.gz']];
  // Build each mac arch separately so we can stage the matching ffmpeg-static
  // binary before each electron-builder invocation (ffmpeg-static only installs
  // the host-arch binary; cross-arch DMGs would otherwise get a wrong-arch
  // ffmpeg → spawn fails → 503 for all transcoded formats).
  if (args.includes('--mac')) return [['--mac', '--arm64'], ['--mac', '--x64']];
  if (args.includes('--win')) return [['--win=nsis'], ['--win=portable']];
  return [['--win=nsis'], ['--win=portable'], ['--linux=tar.gz']];
}

async function resetPackageTemp() {
  await removeInsideRepo(packageTemp);
}

async function pruneObsoleteReleaseArtifacts(version) {
  await mkdir(releaseRoot, { recursive: true });
  const entries = await readdir(releaseRoot, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && isObsoleteNewampReleaseArtifact(entry.name, version))
    .map((entry) => removeInsideRepo(join(releaseRoot, entry.name))));
}

function isObsoleteNewampReleaseArtifact(name, version) {
  if (!/^NewAmp/i.test(name) && !/^Newamp/i.test(name)) return false;
  if (name.includes(version)) return false;
  return /^Newamp? (?:Setup|Portable) \d+\.\d+\.\d+/i.test(name) ||
    /^NewAmp Linux \d+\.\d+\.\d+ [^.]+\.tar\.gz$/i.test(name) ||
    /^NewAmp-\d+\.\d+\.\d+-(?:source|release-bundle)\.zip$/i.test(name);
}

async function removeInsideRepo(target) {
  const resolved = resolve(target);
  const relativePath = relative(repoRoot, resolved);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Refusing to remove outside repo: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const isWindows = process.platform === 'win32';
  const result = spawnSync(isWindows ? 'cmd.exe' : command, isWindows
    ? ['/d', '/s', '/c', [quoteForCmd(command), ...args.map(quoteForCmd)].join(' ')]
    : args, {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function quoteForCmd(value) {
  if (/^[A-Za-z0-9_./:\\=+-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
