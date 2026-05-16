import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repoRoot = resolve('.');
const pkg = JSON.parse(await readText(join(repoRoot, 'package.json')));
const bundleScriptPath = join(repoRoot, 'scripts', 'release-bundle.mjs');

assert.equal(pkg.scripts?.['release:bundle'], 'node scripts/release-bundle.mjs', 'package.json should expose release:bundle');
assert.equal(pkg.scripts?.['smoke:release-bundle'], 'node scripts/release-bundle-smoke.mjs', 'package.json should expose smoke:release-bundle');
assert.ok(existsSync(bundleScriptPath), 'scripts/release-bundle.mjs should exist');

const {
  checkReleaseBundle,
  checkSourceArchiveHygiene,
  createReleaseBundle,
  releaseBundleFileSpecs,
  releaseBundlePaths,
} = await import('./release-bundle.mjs');

const smokeRoot = join(repoRoot, 'tmp', 'release-bundle-smoke');
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(join(smokeRoot, 'release'), { recursive: true });

await writeFile(join(smokeRoot, 'package.json'), JSON.stringify({ name: 'newamp', version: '1.0.0' }), 'utf8');
await writeFile(join(smokeRoot, 'README.md'), '# Newamp\n', 'utf8');
await writeFile(join(smokeRoot, 'release', 'SHA256SUMS.txt'), 'fake checksums\n', 'utf8');
await writeFile(join(smokeRoot, 'release', 'Newamp Setup 1.0.0.exe'), 'installer', 'utf8');
await writeFile(join(smokeRoot, 'release', 'Newamp Portable 1.0.0.exe'), 'portable', 'utf8');
await mkdir(join(smokeRoot, 'source-fixture', 'build'), { recursive: true });
await writeFile(join(smokeRoot, 'source-fixture', 'README.md'), '# Source\n', 'utf8');
await writeFile(join(smokeRoot, 'source-fixture', 'build', 'icon.png'), 'icon', 'utf8');
compressDirectoryToZip(
  join(smokeRoot, 'source-fixture'),
  join(smokeRoot, 'release', 'Newamp-1.0.0-source.zip'),
);

const paths = releaseBundlePaths({ root: smokeRoot, version: '1.0.0' });
assert.match(paths.bundleZip, /Newamp-1\.0\.0-release-bundle\.zip$/);

const specs = releaseBundleFileSpecs({ root: smokeRoot, version: '1.0.0' });
assert.deepEqual(specs.map((spec) => spec.entryName), [
  'README.md',
  'SHA256SUMS.txt',
  'Newamp Setup 1.0.0.exe',
  'Newamp Portable 1.0.0.exe',
  'Newamp-1.0.0-source.zip',
]);

const created = createReleaseBundle({
  root: smokeRoot,
  version: '1.0.0',
  createSourceArchive: false,
  verifyChecksums: false,
});
assert.equal(created.ok, true, created.reason);
assert.ok(created.bundle.bytes > 0, 'bundle should have bytes');
assert.ok(created.files.every((file) => file.sha256), 'bundle files should be fingerprinted');
assert.ok(created.entries.some((entry) => entry.fullName === 'RELEASE-MANIFEST.json'), 'bundle should include release manifest');
assert.equal(created.manifestMismatches.length, 0, 'fresh manifest should match inputs');

const checked = checkReleaseBundle({ root: smokeRoot, version: '1.0.0' });
assert.equal(checked.ok, true, checked.reason);
assert.deepEqual(checked.missingEntries, []);
assert.deepEqual(checked.unexpectedEntries, []);
assert.equal(checked.sourceArchive.ok, true, checked.sourceArchive.reason);

const badSourceRoot = join(smokeRoot, 'bad-source-fixture');
const badSourceZip = join(smokeRoot, 'release', 'bad-source.zip');
await mkdir(join(badSourceRoot, 'tmp'), { recursive: true });
await writeFile(join(badSourceRoot, 'private-library.png'), 'screenshot', 'utf8');
await writeFile(join(badSourceRoot, 'tmp', 'library.db'), 'db', 'utf8');
compressDirectoryToZip(badSourceRoot, badSourceZip);
const badHygiene = checkSourceArchiveHygiene(badSourceZip);
assert.equal(badHygiene.ok, false, 'source hygiene should reject root screenshots and smoke databases');
assert.ok(
  badHygiene.forbiddenEntries.includes('private-library.png') &&
    badHygiene.forbiddenEntries.includes('tmp/library.db'),
  'source hygiene should report the rejected entries',
);

console.log(JSON.stringify({
  ok: true,
  bundle: checked.bundle.path,
  entries: checked.entries.map((entry) => entry.fullName),
}, null, 2));

async function readText(path) {
  return await import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8'));
}

function compressDirectoryToZip(sourceDir, outputPath) {
  if (process.platform !== 'win32') {
    throw new Error('release bundle smoke currently uses Windows PowerShell zip support');
  }
  const command = [
    'Compress-Archive',
    '-Path',
    quoteForPowerShell(join(sourceDir, '*')),
    '-DestinationPath',
    quoteForPowerShell(outputPath),
    '-Force',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function quoteForPowerShell(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
