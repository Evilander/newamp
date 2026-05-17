import { listPackage, statFile } from '@electron/asar';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { checkReleaseChecksums } from './release-checksums.mjs';

const repoRoot = resolve('.');
const packagePath = resolve(repoRoot, 'package.json');
const packageScriptPath = resolve(repoRoot, 'scripts', 'package.mjs');
const gatePath = resolve(repoRoot, 'scripts', 'release-gate.mjs');
const mainPath = resolve(repoRoot, 'electron', 'main.ts');
const installerIncludePath = resolve(repoRoot, 'build', 'installer.nsh');
const releaseRoot = resolve(repoRoot, 'release');
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const releaseVersion = String(pkg.version ?? '').trim() || '0.0.0';
const installerPath = resolve(releaseRoot, `NewAmp Setup ${releaseVersion}.exe`);
const portablePath = resolve(releaseRoot, `NewAmp Portable ${releaseVersion}.exe`);
const blockmapPath = `${installerPath}.blockmap`;
const builderDebugPath = resolve(releaseRoot, 'builder-debug-nsis.yml');
const builderDebugLatestPath = resolve(releaseRoot, 'builder-debug.yml');
const unpackedRoot = resolve(releaseRoot, 'win-unpacked');
const exePath = resolve(unpackedRoot, 'NewAmp.exe');
const resourcesRoot = resolve(unpackedRoot, 'resources');
const appAsarPath = resolve(resourcesRoot, 'app.asar');
const extraDistIndex = resolve(resourcesRoot, 'dist', 'index.html');
const packagedLegacyLogo = resolve(resourcesRoot, 'build', 'logo.png');
const unpackedFfmpeg = resolve(resourcesRoot, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const unpackedSqlWasm = resolve(resourcesRoot, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

const requiredAudioExtensions = ['mp3', 'flac', 'wav', 'm4a', 'wma'];
const requiredPlaylistExtensions = ['m3u', 'm3u8', 'pls', 'cue'];
const requiredExtensions = [...requiredAudioExtensions, ...requiredPlaylistExtensions];

const gateSource = readFileSync(gatePath, 'utf8');
const mainSource = readFileSync(mainPath, 'utf8');
const packageScriptSource = readFileSync(packageScriptPath, 'utf8');
const installerIncludeSource = readRequiredText(installerIncludePath);
const builderDebug = readRequiredText(builderDebugPath);

assert.equal(pkg.build?.productName, 'NewAmp', 'build productName should stay NewAmp');
assert.equal(pkg.build?.appId, 'io.newamp.player', 'build appId should be stable for upgrades/file associations');
assert.ok(pkg.build?.win?.target?.includes('nsis'), 'Windows build target should include NSIS installer output');
assert.ok(pkg.build?.win?.target?.includes('portable'), 'Windows build target should include a no-install portable EXE');
assert.equal(pkg.build?.portable?.artifactName, 'NewAmp Portable ${version}.${ext}', 'portable artifact should have a stable human-readable file name');
assert.equal(pkg.build?.nsis?.include, 'build/installer.nsh', 'NSIS installer should include NewAmp repair customizations');
assert.doesNotMatch(JSON.stringify(pkg.build?.files ?? []), /build\/logo\.png/, 'packaged files should not copy the full-size renderer source logo');
assert.doesNotMatch(JSON.stringify(pkg.build?.extraResources ?? []), /logo\.png/, 'extra resources should not copy the full-size renderer source logo');
assert.match(
  JSON.stringify(pkg.scripts ?? {}),
  /smoke:installer-artifact/,
  'package.json should expose installer artifact smoke',
);
assert.match(
  JSON.stringify(pkg.scripts ?? {}),
  /package:portable/,
  'package.json should expose a portable-only package command',
);
assert.match(
  JSON.stringify(pkg.scripts ?? {}),
  /smoke:portable-app/,
  'package.json should expose a portable app startup smoke',
);
assert.match(
  JSON.stringify(pkg.scripts ?? {}),
  /smoke:packaged-normal-launch/,
  'package.json should expose a packaged normal launch smoke',
);
assert.match(
  JSON.stringify(pkg.scripts ?? {}),
  /release:checksums/,
  'package.json should expose release checksum generation',
);
assert.match(
  JSON.stringify(pkg.scripts ?? {}),
  /smoke:installed-associations/,
  'package.json should expose installed association registry proof',
);
assert.match(
  JSON.stringify(pkg.scripts ?? {}),
  /smoke:installed-app/,
  'package.json should expose installed app proof',
);
assert.match(gateSource, /smoke:installer-artifact/, 'release gate should run installer artifact smoke after packaging');
assert.match(gateSource, /smoke:packaged-normal-launch/, 'release gate should run packaged normal launch smoke after packaging');
assert.match(gateSource, /smoke:portable-app/, 'release gate should run portable app startup smoke after packaging');
assert.match(gateSource, /portablePath/, 'release gate should include portable artifact checks');
assert.match(gateSource, /checkInstalledAssociations/, 'release gate should include installed association registry proof');
assert.match(gateSource, /NEWAMP_FULL_SCAN_SKIP_ART_STORAGE/, 'release gate real-library proof should stay disk-light beside release artifacts');
assert.match(gateSource, /cleanFullLibrarySmokeRoot/, 'release gate real-library proof should clean heavyweight smoke data after probing it');
assert.match(packageScriptSource, /resetPackageTemp/, 'package script should clear its temp directory before building');
assert.match(packageScriptSource, /pruneObsoleteReleaseArtifacts/, 'package script should prune stale versioned release artifacts before building');
assert.match(packageScriptSource, /Refusing to remove outside repo/, 'package cleanup should refuse paths outside the repo');
assert.match(mainSource, /--newamp-startup-smoke/, 'packaged app should accept a startup smoke command-line switch');
assert.match(mainSource, /NEWAMP_STARTUP_SMOKE_MARKER/, 'packaged app should be able to write startup smoke marker files');
assert.match(mainSource, /app\.setPath\('sessionData'/, 'packaged app should isolate Chromium session data from durable library/settings data');
assert.match(mainSource, /disk-cache-dir/, 'packaged app should route Chromium disk cache to the isolated session data path');
assert.match(mainSource, /NEWAMP_DISABLE_HARDWARE_ACCELERATION/, 'packaged app should retain an explicit software-rendering switch');
assert.match(mainSource, /NEWAMP_ENABLE_NATIVE_GPU/, 'packaged app should allow native GPU opt-in when a host supports it');
assert.match(mainSource, /applySoftwareRenderingSwitches\('normal'\)/, 'packaged app should default to stable software rendering');
assert.match(mainSource, /MediaPlayPause/, 'global media shortcuts should use Electron accelerator names that do not crash bootstrap');
assert.match(mainSource, /crashReporter\.start\(\{\s*uploadToServer:\s*false\s*\}\)/, 'packaged app should collect local crash dumps without uploading them');
assert.match(mainSource, /app\.setPath\('crashDumps'/, 'packaged app should use a deterministic local crash dump folder');
assert.match(mainSource, /child-process-gone/, 'packaged app should record child-process failures such as GPU process exits');
assert.match(mainSource, /render-process-gone/, 'packaged app should record renderer process exits');

const configuredExtensions = (pkg.build?.fileAssociations ?? []).flatMap((association) => association.ext ?? []);
const configuredProgIds = (pkg.build?.fileAssociations ?? []).map((association) => association.name ?? '');
assert.ok(configuredProgIds.includes('NewAmp.AudioFile'), 'audio association should use stable NewAmp.AudioFile ProgID');
assert.ok(configuredProgIds.includes('NewAmp.PlaylistFile'), 'playlist association should use stable NewAmp.PlaylistFile ProgID');
for (const progId of configuredProgIds) {
  assert.match(progId, /^NewAmp\.[A-Za-z0-9_.-]+$/, `association ProgID should be stable and space-free: ${progId}`);
}
for (const extension of requiredExtensions) {
  assert.ok(configuredExtensions.includes(extension), `package config should register .${extension}`);
  assert.match(builderDebug, new RegExp(`APP_ASSOCIATE "${extension}"`), `NSIS script should register .${extension}`);
}
assert.match(builderDebug, /APP_ASSOCIATE "mp3" "NewAmp\.AudioFile"/, 'NSIS script should register audio files under NewAmp.AudioFile');
assert.match(builderDebug, /APP_ASSOCIATE "m3u" "NewAmp\.PlaylistFile"/, 'NSIS script should register playlists under NewAmp.PlaylistFile');
assert.match(builderDebug, /APP_ASSOCIATE "cue" "NewAmp\.PlaylistFile"/, 'NSIS script should register CUE sheets under NewAmp.PlaylistFile');
assert.match(builderDebug, /FileAssociation\.nsh/, 'NSIS script should include electron-builder file-association helpers');
assert.match(builderDebug, /\$appExe \$\\"%1\$\\"/, 'NSIS file-open command should pass the selected file path to NewAmp.exe');
assert.match(builderDebug, /RequestExecutionLevel user/, 'installer should support current-user install mode');
assert.match(installerIncludeSource, /NEWAMP_REFRESH_ASSOCIATION HKEY_CURRENT_USER/, 'installer include should refresh current-user associations during repair installs');
assert.match(installerIncludeSource, /NewAmp audio file/, 'installer include should repair stale Newamp audio association casing');
assert.match(installerIncludeSource, /NewAmp playlist or CUE sheet/, 'installer include should repair stale Newamp playlist association casing');
assert.match(installerIncludeSource, /DeleteRegValue[\s\S]*"Newamp\.AudioFile"/, 'installer include should remove legacy-cased audio OpenWithProgids values before repair writes');
assert.match(installerIncludeSource, /DeleteRegValue[\s\S]*"Newamp\.PlaylistFile"/, 'installer include should remove legacy-cased playlist OpenWithProgids values before repair writes');
assert.match(builderDebug, /build\\installer\.nsh/, 'packaged NSIS script should include the NewAmp installer customization file');
assert.match(installerIncludeSource, /!insertmacro UPDATEFILEASSOC/, 'installer include should notify Explorer after association repair');

const installer = artifact(installerPath, 100_000_000);
const portable = artifact(portablePath, 100_000_000);
const exe = artifact(exePath, 200_000_000);
const releaseChecksums = checkReleaseChecksums({ root: repoRoot, version: releaseVersion });
assert.equal(releaseChecksums.ok, true, releaseChecksums.reason);
const blockmap = parseBlockmap(blockmapPath);
const appAsar = artifact(appAsarPath, 25_000_000);
const distIndex = artifact(extraDistIndex, 1_000);
const ffmpeg = artifact(unpackedFfmpeg, 50_000_000);
const sqlWasm = artifact(unpackedSqlWasm, 500_000);
const asarEntries = listPackage(appAsarPath).map((entry) => entry.replaceAll('\\', '/'));
assert.equal(existsSync(packagedLegacyLogo), false, 'packaged resources should omit unused full-size logo.png');

for (const entry of ['/dist/index.html', '/dist-electron/electron/main.js', '/package.json']) {
  assert.ok(asarEntries.includes(entry), `app.asar should include ${entry}`);
  assert.ok(statFile(appAsarPath, entry.slice(1).replaceAll('/', '\\')), `app.asar should stat ${entry}`);
}

assert.equal(blockmap.version, '2', 'blockmap should use electron-builder blockmap version 2');
assert.ok(blockmap.files.length > 0, 'blockmap should list installer payload files');
assert.ok(blockmap.files[0]?.checksums?.length > 100, 'blockmap should contain many block checksums for updater integrity');

const report = {
  ok: true,
  package: {
    productName: pkg.build.productName,
    appId: pkg.build.appId,
    target: pkg.build.win.target,
    portableArtifactName: pkg.build.portable.artifactName,
    configuredAssociations: configuredExtensions.length,
    requiredExtensions,
  },
  nsis: {
    builderDebug: builderDebugPath,
    builderDebugLatest: builderDebugLatestPath,
    fileAssociationCommands: requiredExtensions.length,
    passesOpenFileArg: true,
  },
  artifacts: {
    installer,
    portable,
    blockmap: {
      path: blockmapPath,
      bytes: statSync(blockmapPath).size,
      version: blockmap.version,
      files: blockmap.files.length,
      checksums: blockmap.files.reduce((total, file) => total + (file.checksums?.length ?? 0), 0),
    },
    exe,
    checksums: releaseChecksums,
    appAsar,
    distIndex,
    ffmpeg,
    sqlWasm,
  },
  asar: {
    entries: asarEntries.length,
    required: ['/dist/index.html', '/dist-electron/electron/main.js', '/package.json'],
  },
};

console.log(JSON.stringify(report, null, 2));

function artifact(path, minimumBytes) {
  assert.ok(existsSync(path), `artifact should exist: ${path}`);
  const stat = statSync(path);
  assert.ok(stat.size >= minimumBytes, `${path} should be at least ${minimumBytes} bytes`);
  return {
    path,
    bytes: stat.size,
    minimumBytes,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase(),
  };
}

function parseBlockmap(path) {
  assert.ok(existsSync(path), `blockmap should exist: ${path}`);
  const text = gunzipSync(readFileSync(path)).toString('utf8');
  return JSON.parse(text);
}

function readRequiredText(path) {
  assert.ok(existsSync(path), `required file should exist: ${path}`);
  return readFileSync(path, 'utf8');
}
