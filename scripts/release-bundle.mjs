import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReleaseChecksums } from './release-checksums.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function releaseBundlePaths({ root = defaultRoot, version = readPackageVersion(root) } = {}) {
  const releaseRoot = join(root, 'release');
  return {
    releaseRoot,
    sourceZip: join(releaseRoot, `NewAmp-${version}-source.zip`),
    bundleZip: join(releaseRoot, `NewAmp-${version}-release-bundle.zip`),
    manifest: join(releaseRoot, 'RELEASE-MANIFEST.json'),
  };
}

export function releaseBundleFileSpecs({ root = defaultRoot, version = readPackageVersion(root) } = {}) {
  const paths = releaseBundlePaths({ root, version });
  return [
    { name: 'readme', path: join(root, 'README.md'), entryName: 'README.md' },
    { name: 'checksums', path: join(paths.releaseRoot, 'SHA256SUMS.txt'), entryName: 'SHA256SUMS.txt' },
    { name: 'provenance', path: join(paths.releaseRoot, 'BUILD-PROVENANCE.json'), entryName: 'BUILD-PROVENANCE.json' },
    { name: 'installer', path: join(paths.releaseRoot, `NewAmp Setup ${version}.exe`), entryName: `NewAmp Setup ${version}.exe` },
    { name: 'portable', path: join(paths.releaseRoot, `NewAmp Portable ${version}.exe`), entryName: `NewAmp Portable ${version}.exe` },
    { name: 'linux-tar', path: join(paths.releaseRoot, `NewAmp Linux ${version} x64.tar.gz`), entryName: `NewAmp Linux ${version} x64.tar.gz` },
    { name: 'source', path: paths.sourceZip, entryName: basename(paths.sourceZip) },
  ];
}

export function createReleaseBundle({
  root = defaultRoot,
  version = readPackageVersion(root),
  createSourceArchive = true,
  verifyChecksums = true,
  allowDirtySource = false,
} = {}) {
  const paths = releaseBundlePaths({ root, version });
  mkdirSync(paths.releaseRoot, { recursive: true });

  if (verifyChecksums) {
    const checksums = checkReleaseChecksums({ root, version });
    if (!checksums.ok) {
      return failedReport({
        root,
        version,
        reason: `release checksums are not current: ${checksums.reason}`,
        paths,
        files: [],
      });
    }
  }

  if (createSourceArchive) {
    const gitClean = gitCleanStatus(root);
    if (!allowDirtySource && (!gitClean.ok || !gitClean.clean)) {
      return failedReport({
        root,
        version,
        reason: gitCleanReason(gitClean),
        paths,
        files: [],
      });
    }
    const source = createSourceZip({ root, outputPath: paths.sourceZip });
    if (!source.ok) {
      return failedReport({ root, version, reason: source.reason, paths, files: [] });
    }
  }

  const files = releaseBundleFileSpecs({ root, version }).map((spec) => fileProof(spec, root));
  const missing = files.filter((file) => !file.ok);
  if (missing.length) {
    return failedReport({
      root,
      version,
      reason: `release bundle inputs are missing: ${missing.map((file) => file.name).join(', ')}`,
      paths,
      files,
    });
  }

  const manifest = {
    name: 'newamp-release-bundle',
    version,
    createdAt: new Date().toISOString(),
    gitHead: gitHead(root),
    files: files.map(({ ok, ...file }) => file),
  };
  writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const manifestProof = fileProof({ name: 'manifest', path: paths.manifest, entryName: 'RELEASE-MANIFEST.json' }, root);
  const bundleInputs = [...files, manifestProof];
  const compressed = compressBundle({
    inputPaths: bundleInputs.map((file) => file.absolutePath),
    outputPath: paths.bundleZip,
  });
  if (!compressed.ok) {
    return failedReport({ root, version, reason: compressed.reason, paths, files: bundleInputs });
  }

  return checkReleaseBundle({ root, version, requireCleanSource: createSourceArchive && !allowDirtySource });
}

export function checkReleaseBundle({ root = defaultRoot, version = readPackageVersion(root), requireCleanSource = false } = {}) {
  const paths = releaseBundlePaths({ root, version });
  const files = [
    ...releaseBundleFileSpecs({ root, version }).map((spec) => fileProof(spec, root)),
    fileProof({ name: 'manifest', path: paths.manifest, entryName: 'RELEASE-MANIFEST.json' }, root),
  ];
  const bundle = fileProof({ name: 'bundle', path: paths.bundleZip, entryName: basename(paths.bundleZip) }, root);
  const manifest = readManifest(paths.manifest);
  const entries = bundle.ok ? listZipEntries(paths.bundleZip) : { ok: false, entries: [], reason: 'bundle zip is missing' };
  const sourceFile = files.find((file) => file.name === 'source');
  const sourceArchive = sourceFile?.ok
    ? checkSourceArchiveHygiene(sourceFile.absolutePath)
    : { ok: false, entryCount: 0, forbiddenEntries: [], reason: 'source archive is missing' };
  const expectedEntries = files.map((file) => file.entryName);
  const actualEntries = entries.entries.map((entry) => entry.fullName);
  const missingEntries = expectedEntries.filter((entry) => !actualEntries.includes(entry));
  const unexpectedEntries = actualEntries.filter((entry) => !expectedEntries.includes(entry));
  const gitClean = requireCleanSource
    ? gitCleanStatus(root)
    : { ok: true, clean: true, changed: [], reason: null, skipped: true };
  const sizeMismatches = files
    .filter((file) => file.ok)
    .map((file) => {
      const entry = entries.entries.find((item) => item.fullName === file.entryName);
      return entry && entry.length !== file.bytes
        ? { name: file.name, entryName: file.entryName, expectedBytes: file.bytes, actualBytes: entry.length }
        : null;
    })
    .filter(Boolean);
  const manifestMismatches = manifest.ok ? compareManifestFiles(manifest.value, files.filter((file) => file.name !== 'manifest')) : [];
  const ok = files.every((file) => file.ok) &&
    bundle.ok &&
    manifest.ok &&
    entries.ok &&
    sourceArchive.ok &&
    gitClean.ok &&
    gitClean.clean &&
    missingEntries.length === 0 &&
    unexpectedEntries.length === 0 &&
    sizeMismatches.length === 0 &&
    manifestMismatches.length === 0;

  return {
    name: 'release-bundle',
    ok,
    root,
    version,
    paths: {
      sourceZip: displayPath(root, paths.sourceZip),
      bundleZip: displayPath(root, paths.bundleZip),
      manifest: displayPath(root, paths.manifest),
    },
    files: files.map(({ absolutePath, ...file }) => file),
    bundle: bundle.ok ? withoutAbsolutePath(bundle) : bundle,
    entries: entries.entries,
    sourceArchive,
    gitClean,
    missingEntries,
    unexpectedEntries,
    sizeMismatches,
    manifestMismatches,
    reason: ok
      ? null
      : releaseBundleReason({
        files,
        bundle,
        manifest,
        entries,
        sourceArchive,
        gitClean,
        missingEntries,
        unexpectedEntries,
        sizeMismatches,
        manifestMismatches,
      }),
  };
}

function createSourceZip({ root, outputPath }) {
  const gitArgs = gitBaseArgs(root);
  const result = spawnSync('git', [...gitArgs, 'archive', '--format=zip', `--output=${outputPath}`, 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    return {
      ok: false,
      reason: result.error?.message || (result.stderr || result.stdout || 'git archive failed').trim(),
    };
  }
  return { ok: true, path: outputPath };
}

function gitCleanStatus(root) {
  const result = spawnSync('git', [...gitBaseArgs(root), 'status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    return {
      ok: false,
      clean: false,
      changed: [],
      reason: result.error?.message || (result.stderr || result.stdout || 'git status failed').trim(),
    };
  }
  const changed = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    ok: true,
    clean: changed.length === 0,
    changed,
    reason: changed.length ? `working tree has uncommitted changes: ${changed.slice(0, 8).join(', ')}` : null,
  };
}

function gitCleanReason(status) {
  if (!status.ok) return `git status failed before creating source archive: ${status.reason}`;
  if (!status.clean) return `${status.reason}; commit or stash changes before creating a release bundle`;
  return null;
}

export function checkSourceArchiveHygiene(path) {
  const entries = listZipEntries(path);
  if (!entries.ok) {
    return {
      ok: false,
      entryCount: 0,
      forbiddenEntries: [],
      reason: `source archive could not be inspected: ${entries.reason}`,
    };
  }

  const forbiddenEntries = entries.entries
    .map((entry) => entry.fullName.replaceAll('\\', '/'))
    .filter(isForbiddenSourceEntry);
  return {
    ok: forbiddenEntries.length === 0,
    entryCount: entries.entries.length,
    forbiddenEntries,
    reason: forbiddenEntries.length
      ? `source archive includes forbidden public entries: ${forbiddenEntries.slice(0, 10).join(', ')}`
      : null,
  };
}

function isForbiddenSourceEntry(entryName) {
  const name = entryName.replaceAll('\\', '/');
  return /^[^/]+\.png$/i.test(name) ||
    /^(release|tmp|node_modules|dist|dist-electron|\.git|\.newamp-git)\//i.test(name) ||
    /^studio\/renders\//i.test(name) ||
    /^codex\.md$/i.test(name) ||
    /(^|\/)library\.db$/i.test(name) ||
    /(^|\/)(manual-listening-proof|lastfm-live-proof)\.json$/i.test(name) ||
    /(^|\/)\.env(\.|$)/i.test(name) ||
    /\.(pfx|p12|pem|key|cer|crt)$/i.test(name);
}

function gitBaseArgs(root) {
  const externalGit = join(root, '.newamp-git');
  if (existsSync(externalGit)) return ['--git-dir', externalGit, '--work-tree', root];
  return ['-C', root];
}

function gitHead(root) {
  const result = spawnSync('git', [...gitBaseArgs(root), 'rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function compressBundle({ inputPaths, outputPath }) {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'release bundle zip creation currently uses Windows PowerShell .NET zip support' };
  }
  const maxAttempts = 4;
  const command = dotNetZipCommand(inputPaths, outputPath);

  let lastReason = 'PowerShell .NET zip creation did not produce a bundle zip';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const cleared = removeExistingFile(outputPath);
    if (!cleared.ok) return cleared;

    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      cwd: defaultRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
    });
    if (result.status !== 0 || result.error) {
      lastReason = result.error?.message || (result.stderr || result.stdout || 'PowerShell .NET zip creation failed').trim();
    } else {
      const proof = fileExistsWithBytes(outputPath);
      if (proof.ok) return { ok: true };
      lastReason = proof.reason;
    }
    if (attempt < maxAttempts) sleepSync(1500);
  }
  return { ok: false, reason: `${lastReason}; failed after ${maxAttempts} attempts` };
}

function dotNetZipCommand(inputPaths, outputPath) {
  const fileObjects = inputPaths
    .map((path) => `@{ Path = ${quoteForPowerShell(path)}; Name = ${quoteForPowerShell(basename(path))} }`)
    .join(',');
  return [
    "$ErrorActionPreference = 'Stop';",
    'Add-Type -AssemblyName System.IO.Compression;',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
    `$dest = ${quoteForPowerShell(outputPath)};`,
    "if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force; }",
    `$files = @(${fileObjects});`,
    '$zip = [System.IO.Compression.ZipFile]::Open($dest, [System.IO.Compression.ZipArchiveMode]::Create);',
    'try {',
    'foreach ($file in $files) {',
    '[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.Path, $file.Name, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null;',
    '}',
    '} finally { $zip.Dispose(); }',
  ].join(' ');
}

function removeExistingFile(path) {
  if (!existsSync(path)) return { ok: true };
  try {
    unlinkSync(path);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `could not remove stale release bundle before compression: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function fileExistsWithBytes(path) {
  if (!existsSync(path)) return { ok: false, reason: 'PowerShell zip creation exited successfully but bundle zip is missing' };
  try {
    const stat = statSync(path);
    return stat.size > 0
      ? { ok: true }
      : { ok: false, reason: 'PowerShell zip creation produced an empty bundle zip' };
  } catch (error) {
    return {
      ok: false,
      reason: `could not inspect compressed bundle: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function listZipEntries(path) {
  if (process.platform !== 'win32') {
    return { ok: false, entries: [], reason: 'zip inspection currently uses Windows PowerShell' };
  }
  const command = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
    `$zip = [System.IO.Compression.ZipFile]::OpenRead(${quoteForPowerShell(path)});`,
    'try {',
    '@($zip.Entries | ForEach-Object { [pscustomobject]@{ FullName = $_.FullName; Length = $_.Length } }) | ConvertTo-Json -Compress',
    '} finally { $zip.Dispose() }',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: defaultRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.status !== 0 || result.error) {
    return { ok: false, entries: [], reason: result.error?.message || (result.stderr || result.stdout || 'zip inspection failed').trim() };
  }
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    const entries = (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
      fullName: entry.FullName,
      length: Number(entry.Length),
    }));
    return { ok: true, entries, reason: null };
  } catch {
    return { ok: false, entries: [], reason: `zip inspection returned invalid JSON: ${result.stdout.trim().slice(0, 300)}` };
  }
}

function fileProof(spec, root) {
  if (!existsSync(spec.path)) {
    return {
      name: spec.name,
      path: displayPath(root, spec.path),
      absolutePath: spec.path,
      entryName: spec.entryName,
      ok: false,
      exists: false,
      reason: 'missing',
    };
  }
  const stat = statSync(spec.path);
  return {
    name: spec.name,
    path: displayPath(root, spec.path),
    absolutePath: spec.path,
    entryName: spec.entryName,
    ok: true,
    exists: true,
    bytes: stat.size,
    sha256: sha256(spec.path),
    reason: null,
  };
}

function readManifest(path) {
  if (!existsSync(path)) return { ok: false, value: null, reason: 'manifest is missing' };
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')), reason: null };
  } catch (error) {
    return { ok: false, value: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

function compareManifestFiles(manifest, files) {
  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];
  return files.flatMap((file) => {
    const manifestFile = manifestFiles.find((item) => item.name === file.name);
    if (!manifestFile) return [{ name: file.name, reason: 'missing from manifest' }];
    const mismatches = [];
    for (const key of ['entryName', 'bytes', 'sha256']) {
      if (manifestFile[key] !== file[key]) {
        mismatches.push({ name: file.name, field: key, expected: file[key], actual: manifestFile[key] });
      }
    }
    return mismatches;
  });
}

function releaseBundleReason({
  files,
  bundle,
  manifest,
  entries,
  sourceArchive,
  gitClean,
  missingEntries,
  unexpectedEntries,
  sizeMismatches,
  manifestMismatches,
}) {
  const missingFiles = files.filter((file) => !file.ok).map((file) => `${file.name}: ${file.reason}`);
  if (missingFiles.length) return `release bundle inputs are not ready: ${missingFiles.join(', ')}`;
  if (!bundle.ok) return `release bundle zip is not ready: ${bundle.reason}`;
  if (!manifest.ok) return `release bundle manifest is not ready: ${manifest.reason}`;
  if (!entries.ok) return `release bundle entries could not be inspected: ${entries.reason}`;
  if (!sourceArchive.ok) return sourceArchive.reason;
  if (gitClean && (!gitClean.ok || !gitClean.clean)) return gitCleanReason(gitClean);
  if (missingEntries.length || unexpectedEntries.length) {
    return `release bundle entries are mismatched (${missingEntries.length} missing, ${unexpectedEntries.length} unexpected)`;
  }
  if (sizeMismatches.length) return `release bundle entry sizes are mismatched (${sizeMismatches.length})`;
  if (manifestMismatches.length) return `release bundle manifest is stale (${manifestMismatches.length} mismatches)`;
  return 'release bundle is not valid';
}

function failedReport({ root, version, reason, paths, files }) {
  return {
    name: 'release-bundle',
    ok: false,
    root,
    version,
    paths: {
      sourceZip: displayPath(root, paths.sourceZip),
      bundleZip: displayPath(root, paths.bundleZip),
      manifest: displayPath(root, paths.manifest),
    },
    files: files.map(({ absolutePath, ...file }) => file),
    bundle: null,
    entries: [],
    missingEntries: [],
    unexpectedEntries: [],
    sizeMismatches: [],
    manifestMismatches: [],
    reason,
  };
}

function withoutAbsolutePath(file) {
  const { absolutePath, ...rest } = file;
  return rest;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}

function readPackageVersion(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return String(pkg.version ?? '').trim() || '0.0.0';
}

function displayPath(root, path) {
  const relativePath = relative(root, path);
  return relativePath && !relativePath.startsWith('..') ? relativePath.replaceAll('\\', '/') : path;
}

function quoteForPowerShell(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseCli(argv) {
  const flags = new Set(argv);
  return {
    check: flags.has('--check'),
    help: flags.has('--help') || flags.has('-h'),
  };
}

function printUsage() {
  console.log([
    'Usage:',
    '  npm run release:bundle',
    '  npm run release:bundle -- --check',
    '',
    'Creates and verifies:',
    '  release/NewAmp-<version>-source.zip',
    '  release/RELEASE-MANIFEST.json',
    '  release/NewAmp-<version>-release-bundle.zip',
    '',
    'The source archive is built from git HEAD and refuses a dirty worktree.',
  ].join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    printUsage();
  } else {
    const report = cli.check ? checkReleaseBundle({ requireCleanSource: true }) : createReleaseBundle();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  }
}
