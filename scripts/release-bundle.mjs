import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReleaseChecksums } from './release-checksums.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function releaseBundlePaths({ root = defaultRoot, version = readPackageVersion(root) } = {}) {
  const releaseRoot = join(root, 'release');
  return {
    releaseRoot,
    sourceZip: join(releaseRoot, `Newamp-${version}-source.zip`),
    bundleZip: join(releaseRoot, `Newamp-${version}-release-bundle.zip`),
    manifest: join(releaseRoot, 'RELEASE-MANIFEST.json'),
  };
}

export function releaseBundleFileSpecs({ root = defaultRoot, version = readPackageVersion(root) } = {}) {
  const paths = releaseBundlePaths({ root, version });
  return [
    { name: 'readme', path: join(root, 'README.md'), entryName: 'README.md' },
    { name: 'checksums', path: join(paths.releaseRoot, 'SHA256SUMS.txt'), entryName: 'SHA256SUMS.txt' },
    { name: 'installer', path: join(paths.releaseRoot, `Newamp Setup ${version}.exe`), entryName: `Newamp Setup ${version}.exe` },
    { name: 'portable', path: join(paths.releaseRoot, `Newamp Portable ${version}.exe`), entryName: `Newamp Portable ${version}.exe` },
    { name: 'source', path: paths.sourceZip, entryName: basename(paths.sourceZip) },
  ];
}

export function createReleaseBundle({
  root = defaultRoot,
  version = readPackageVersion(root),
  createSourceArchive = true,
  verifyChecksums = true,
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

  return checkReleaseBundle({ root, version });
}

export function checkReleaseBundle({ root = defaultRoot, version = readPackageVersion(root) } = {}) {
  const paths = releaseBundlePaths({ root, version });
  const files = [
    ...releaseBundleFileSpecs({ root, version }).map((spec) => fileProof(spec, root)),
    fileProof({ name: 'manifest', path: paths.manifest, entryName: 'RELEASE-MANIFEST.json' }, root),
  ];
  const bundle = fileProof({ name: 'bundle', path: paths.bundleZip, entryName: basename(paths.bundleZip) }, root);
  const manifest = readManifest(paths.manifest);
  const entries = bundle.ok ? listZipEntries(paths.bundleZip) : { ok: false, entries: [], reason: 'bundle zip is missing' };
  const expectedEntries = files.map((file) => file.entryName);
  const actualEntries = entries.entries.map((entry) => entry.fullName);
  const missingEntries = expectedEntries.filter((entry) => !actualEntries.includes(entry));
  const unexpectedEntries = actualEntries.filter((entry) => !expectedEntries.includes(entry));
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
    missingEntries,
    unexpectedEntries,
    sizeMismatches,
    manifestMismatches,
    reason: ok
      ? null
      : releaseBundleReason({ files, bundle, manifest, entries, missingEntries, unexpectedEntries, sizeMismatches, manifestMismatches }),
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
    return { ok: false, reason: 'release bundle zip creation currently uses Windows PowerShell Compress-Archive' };
  }
  const command = [
    'Compress-Archive',
    '-LiteralPath',
    `@(${inputPaths.map(quoteForPowerShell).join(',')})`,
    '-DestinationPath',
    quoteForPowerShell(outputPath),
    '-CompressionLevel',
    'Optimal',
    '-Force',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: defaultRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.status !== 0 || result.error) {
    return { ok: false, reason: result.error?.message || (result.stderr || result.stdout || 'Compress-Archive failed').trim() };
  }
  return { ok: true };
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

function releaseBundleReason({ files, bundle, manifest, entries, missingEntries, unexpectedEntries, sizeMismatches, manifestMismatches }) {
  const missingFiles = files.filter((file) => !file.ok).map((file) => `${file.name}: ${file.reason}`);
  if (missingFiles.length) return `release bundle inputs are not ready: ${missingFiles.join(', ')}`;
  if (!bundle.ok) return `release bundle zip is not ready: ${bundle.reason}`;
  if (!manifest.ok) return `release bundle manifest is not ready: ${manifest.reason}`;
  if (!entries.ok) return `release bundle entries could not be inspected: ${entries.reason}`;
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
    '  release/Newamp-<version>-source.zip',
    '  release/RELEASE-MANIFEST.json',
    '  release/Newamp-<version>-release-bundle.zip',
  ].join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    printUsage();
  } else {
    const report = cli.check ? checkReleaseBundle() : createReleaseBundle();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  }
}
