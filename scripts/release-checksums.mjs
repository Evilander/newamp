import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function releaseArtifactSpecs({ root = defaultRoot, version = readPackageVersion(root) } = {}) {
  return [
    {
      name: 'installer',
      path: join(root, 'release', `NewAmp Setup ${version}.exe`),
      checksumName: `NewAmp Setup ${version}.exe`,
      minimumBytes: 100_000_000,
    },
    {
      name: 'portable',
      path: join(root, 'release', `NewAmp Portable ${version}.exe`),
      checksumName: `NewAmp Portable ${version}.exe`,
      minimumBytes: 100_000_000,
    },
    {
      name: 'exe',
      path: join(root, 'release', 'win-unpacked', 'NewAmp.exe'),
      checksumName: 'win-unpacked/NewAmp.exe',
      minimumBytes: 200_000_000,
    },
    {
      name: 'linux-tar',
      path: join(root, 'release', `NewAmp Linux ${version} x64.tar.gz`),
      checksumName: `NewAmp Linux ${version} x64.tar.gz`,
      minimumBytes: 80_000_000,
    },
    {
      name: 'linux-binary',
      path: join(root, 'release', 'linux-unpacked', 'newamp'),
      checksumName: 'linux-unpacked/newamp',
      minimumBytes: 150_000_000,
    },
    // macOS artifacts can only be produced on a Mac. They are `optional`: hashed
    // and validated when present (a Mac build, or the CI matrix's merged release
    // job), but their absence does not invalidate a Windows/Linux-only build.
    {
      name: 'mac-dmg-arm64',
      path: join(root, 'release', `NewAmp ${version} arm64.dmg`),
      checksumName: `NewAmp ${version} arm64.dmg`,
      minimumBytes: 80_000_000,
      optional: true,
    },
    {
      name: 'mac-dmg-x64',
      path: join(root, 'release', `NewAmp ${version} x64.dmg`),
      checksumName: `NewAmp ${version} x64.dmg`,
      minimumBytes: 80_000_000,
      optional: true,
    },
    {
      name: 'mac-zip-arm64',
      path: join(root, 'release', `NewAmp ${version} arm64.zip`),
      checksumName: `NewAmp ${version} arm64.zip`,
      minimumBytes: 60_000_000,
      optional: true,
    },
    {
      name: 'mac-zip-x64',
      path: join(root, 'release', `NewAmp ${version} x64.zip`),
      checksumName: `NewAmp ${version} x64.zip`,
      minimumBytes: 60_000_000,
      optional: true,
    },
  ];
}

export function releaseChecksumsPath({ root = defaultRoot } = {}) {
  return join(root, 'release', 'SHA256SUMS.txt');
}

export function buildReleaseChecksums({ root = defaultRoot, version = readPackageVersion(root) } = {}) {
  const all = releaseArtifactSpecs({ root, version }).map((artifact) => artifactChecksum(artifact, root));
  // Drop optional artifacts (e.g. macOS, only buildable on a Mac) that are
  // absent — they neither appear in the manifest nor invalidate the release.
  const artifacts = all.filter((artifact) => artifact.exists || !artifact.optional);
  return {
    ok: artifacts.every((artifact) => artifact.ok),
    path: releaseChecksumsPath({ root }),
    version,
    artifacts,
    text: artifacts.map((artifact) => `${artifact.sha256 ?? ''.padStart(64, '0')}  ${artifact.checksumName}`).join('\n') + '\n',
  };
}

export function writeReleaseChecksums({ root = defaultRoot, version = readPackageVersion(root) } = {}) {
  const manifest = buildReleaseChecksums({ root, version });
  if (!manifest.ok) {
    const missing = manifest.artifacts
      .filter((artifact) => !artifact.ok)
      .map((artifact) => `${artifact.name}: ${artifact.reason}`)
      .join(', ');
    throw new Error(`Cannot write release checksums; artifacts are not ready (${missing})`);
  }
  writeFileSync(manifest.path, manifest.text, 'utf8');
  return checkReleaseChecksums({ root, version });
}

export function checkReleaseChecksums({ root = defaultRoot, version = readPackageVersion(root) } = {}) {
  const expected = buildReleaseChecksums({ root, version });
  const exists = existsSync(expected.path);
  const actualText = exists ? readFileSync(expected.path, 'utf8') : '';
  const expectedLines = expected.text.trim().split(/\r?\n/);
  const actualLines = actualText.trim().split(/\r?\n/).filter(Boolean);
  const missingLines = expectedLines.filter((line) => !actualLines.includes(line));
  const unexpectedLines = actualLines.filter((line) => !expectedLines.includes(line));
  const ok = expected.ok && exists && missingLines.length === 0 && unexpectedLines.length === 0;
  return {
    name: 'release-checksums',
    ok,
    path: expected.path,
    exists,
    version,
    artifacts: expected.artifacts,
    missingLines,
    unexpectedLines,
    reason: ok
      ? null
      : checksumReason({ expected, exists, missingLines, unexpectedLines }),
  };
}

function artifactChecksum(artifact, root) {
  if (!existsSync(artifact.path)) {
    return {
      ...artifact,
      path: displayPath(root, artifact.path),
      ok: false,
      exists: false,
      reason: 'missing',
    };
  }
  const stat = statSync(artifact.path);
  return {
    ...artifact,
    path: displayPath(root, artifact.path),
    ok: true,
    exists: true,
    bytes: stat.size,
    sizeOk: stat.size >= artifact.minimumBytes,
    sha256: createHash('sha256').update(readFileSync(artifact.path)).digest('hex').toUpperCase(),
    reason: null,
  };
}

function checksumReason({ expected, exists, missingLines, unexpectedLines }) {
  const artifactFailures = expected.artifacts
    .filter((artifact) => !artifact.ok)
    .map((artifact) => `${artifact.name} ${artifact.reason}`);
  if (artifactFailures.length) return `artifact checksum inputs are not ready: ${artifactFailures.join(', ')}`;
  if (!exists) return 'release/SHA256SUMS.txt is missing';
  if (missingLines.length || unexpectedLines.length) {
    return `release/SHA256SUMS.txt is stale or mismatched (${missingLines.length} missing, ${unexpectedLines.length} unexpected)`;
  }
  return 'release/SHA256SUMS.txt is not valid';
}

function readPackageVersion(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return String(pkg.version ?? '').trim() || '0.0.0';
}

function displayPath(root, path) {
  const relativePath = relative(root, path);
  return relativePath && !relativePath.startsWith('..') ? relativePath.replaceAll('\\', '/') : path;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const checkOnly = process.argv.includes('--check');
    const report = checkOnly ? checkReleaseChecksums() : writeReleaseChecksums();
    console.log(JSON.stringify({
      ...report,
      file: basename(report.path),
      nextStep: !checkOnly && report.ok ? 'npm run release:provenance' : null,
    }, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
