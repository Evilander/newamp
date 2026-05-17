import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReleaseChecksums } from './release-checksums.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function buildProvenancePath({ root = defaultRoot } = {}) {
  return join(root, 'release', 'BUILD-PROVENANCE.json');
}

export function buildProvenance({ root = defaultRoot, version = readPackageVersion(root), now = new Date() } = {}) {
  const checksums = buildReleaseChecksums({ root, version });
  return {
    name: 'newamp-build-provenance',
    version,
    createdAt: now.toISOString(),
    git: gitState(root, version),
    artifacts: checksums.artifacts.map((artifact) => ({
      name: artifact.name,
      path: artifact.path,
      checksumName: artifact.checksumName,
      exists: artifact.exists,
      bytes: artifact.bytes ?? null,
      sha256: artifact.sha256 ?? null,
    })),
  };
}

export function writeBuildProvenance({ root = defaultRoot, version = readPackageVersion(root), now = new Date() } = {}) {
  const provenance = buildProvenance({ root, version, now });
  const path = buildProvenancePath({ root });
  const missingArtifacts = provenance.artifacts.filter((artifact) => !artifact.exists || !artifact.sha256);
  if (missingArtifacts.length) {
    throw new Error(`Cannot write build provenance; artifacts are not ready (${missingArtifacts.map((artifact) => artifact.name).join(', ')})`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  return checkBuildProvenance({ root, version });
}

export function checkBuildProvenance({ root = defaultRoot, version = readPackageVersion(root) } = {}) {
  const path = buildProvenancePath({ root });
  if (!existsSync(path)) {
    return {
      name: 'build-provenance',
      ok: false,
      path: displayPath(root, path),
      version,
      git: gitState(root, version),
      artifactCount: 0,
      mismatches: [{ field: 'file', reason: 'missing' }],
      artifactMismatches: [],
      reason: 'release/BUILD-PROVENANCE.json is missing',
    };
  }

  let actual;
  try {
    actual = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      name: 'build-provenance',
      ok: false,
      path: displayPath(root, path),
      version,
      git: gitState(root, version),
      artifactCount: 0,
      mismatches: [{ field: 'json', reason: error instanceof Error ? error.message : String(error) }],
      artifactMismatches: [],
      reason: 'release/BUILD-PROVENANCE.json is not valid JSON',
    };
  }

  const expected = buildProvenance({ root, version, now: new Date(actual.createdAt || Date.now()) });
  const mismatches = compareTopLevel(actual, expected);
  const artifactMismatches = compareArtifacts(actual.artifacts, expected.artifacts);
  const ok = mismatches.length === 0 && artifactMismatches.length === 0;
  return {
    name: 'build-provenance',
    ok,
    path: displayPath(root, path),
    version,
    git: expected.git,
    artifactCount: expected.artifacts.length,
    mismatches,
    artifactMismatches,
    reason: ok
      ? null
      : `release/BUILD-PROVENANCE.json is stale or mismatched (${mismatches.length} metadata, ${artifactMismatches.length} artifacts)`,
  };
}

function compareTopLevel(actual, expected) {
  const mismatches = [];
  for (const field of ['name', 'version']) {
    if (actual?.[field] !== expected[field]) {
      mismatches.push({ field, expected: expected[field], actual: actual?.[field] });
    }
  }
  for (const field of ['mode', 'head', 'tag', 'tagHead', 'tagMatchesHead', 'clean']) {
    if (actual?.git?.[field] !== expected.git[field]) {
      mismatches.push({ field: `git.${field}`, expected: expected.git[field], actual: actual?.git?.[field] });
    }
  }
  return mismatches;
}

function compareArtifacts(actualArtifacts, expectedArtifacts) {
  const actual = Array.isArray(actualArtifacts) ? actualArtifacts : [];
  const mismatches = expectedArtifacts.flatMap((expected) => {
    const found = actual.find((artifact) => artifact.name === expected.name);
    if (!found) return [{ name: expected.name, field: 'artifact', reason: 'missing from provenance' }];
    const fieldMismatches = [];
    for (const field of ['path', 'checksumName', 'exists', 'bytes', 'sha256']) {
      if (found[field] !== expected[field]) {
        fieldMismatches.push({ name: expected.name, field, expected: expected[field], actual: found[field] });
      }
    }
    return fieldMismatches;
  });
  const expectedNames = new Set(expectedArtifacts.map((artifact) => artifact.name));
  for (const artifact of actual) {
    if (!expectedNames.has(artifact.name)) {
      mismatches.push({ name: artifact.name, field: 'artifact', reason: 'unexpected in provenance' });
    }
  }
  return mismatches;
}

function gitState(root, version) {
  const mode = gitMode(root);
  if (mode === 'none') {
    return {
      mode,
      head: null,
      tag: `v${version}`,
      tagHead: null,
      tagMatchesHead: false,
      clean: null,
    };
  }

  const head = runGit(root, ['rev-parse', 'HEAD']);
  const clean = runGit(root, ['status', '--porcelain']);
  const tag = `v${version}`;
  const tagHead = runGit(root, ['rev-parse', '--verify', `${tag}^{}`]);
  const headValue = head.status === 0 ? head.stdout.trim() : null;
  const tagHeadValue = tagHead.status === 0 ? tagHead.stdout.trim() : null;
  return {
    mode,
    head: headValue,
    tag,
    tagHead: tagHeadValue,
    tagMatchesHead: Boolean(headValue && tagHeadValue && headValue === tagHeadValue),
    clean: clean.status === 0 ? clean.stdout.trim().length === 0 : false,
  };
}

function gitMode(root) {
  if (existsSync(join(root, '.newamp-git'))) return 'external';
  if (existsSync(join(root, '.git'))) return 'worktree';
  return 'none';
}

function runGit(root, args) {
  const externalGit = join(root, '.newamp-git');
  const gitArgs = existsSync(externalGit)
    ? ['--git-dir', externalGit, '--work-tree', root, ...args]
    : ['-C', root, ...args];
  return spawnSync('git', gitArgs, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
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
    const report = process.argv.includes('--check')
      ? checkBuildProvenance()
      : writeBuildProvenance();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
