import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repoRoot = resolve('.');
const pkg = JSON.parse(await readText(join(repoRoot, 'package.json')));
const signScriptPath = join(repoRoot, 'scripts', 'sign-artifacts.mjs');

assert.equal(pkg.scripts?.['release:sign'], 'node scripts/sign-artifacts.mjs', 'package.json should expose release:sign');
assert.ok(existsSync(signScriptPath), 'scripts/sign-artifacts.mjs should exist');

const {
  buildSigningPlan,
  defaultSigningArtifacts,
  signArtifacts,
} = await import('./sign-artifacts.mjs');

const smokeRoot = join(repoRoot, 'tmp', 'signing-workflow-smoke');
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const artifacts = [
  { name: 'installer', path: join(smokeRoot, 'NewAmp Setup 1.0.0.exe') },
  { name: 'portable', path: join(smokeRoot, 'NewAmp Portable 1.0.0.exe') },
  { name: 'exe', path: join(smokeRoot, 'NewAmp.exe') },
];
await Promise.all(artifacts.map((artifact, index) => writeFile(artifact.path, `artifact-${index}`, 'utf8')));

assert.equal(defaultSigningArtifacts(repoRoot).length, 3, 'default signing artifacts should include installer, portable, and unpacked exe');

if (process.platform === 'win32') {
  const kitsRoot = join(smokeRoot, 'Windows Kits');
  const kitToolDir = join(kitsRoot, '10', 'bin', '10.0.99999.0', 'x64');
  await mkdir(kitToolDir, { recursive: true });
  await writeFile(join(kitToolDir, 'signtool.exe'), 'fake signtool', 'utf8');
  const kitPlan = buildSigningPlan({
    artifacts,
    env: {
      NEWAMP_WINDOWS_KITS_ROOT: kitsRoot,
      NEWAMP_SIGN_SUBJECT: 'NewAmp Release',
    },
    requireExistingTool: true,
  });
  assert.equal(kitPlan.ok, true, kitPlan.reason);
  assert.equal(kitPlan.signtool, 'signtool.exe');
}

const pfxPlan = buildSigningPlan({
  artifacts,
  env: {
    NEWAMP_SIGNTOOL_PATH: join(smokeRoot, 'signtool.exe'),
    CSC_LINK: join(smokeRoot, 'newamp-release.pfx'),
    CSC_KEY_PASSWORD: 'super-secret-password',
    NEWAMP_TIMESTAMP_URL: 'http://timestamp.test',
  },
  requireExistingTool: false,
});
assert.equal(pfxPlan.ok, true, pfxPlan.reason);
assert.equal(pfxPlan.mode, 'pfx');
assert.equal(pfxPlan.commands.length, 3);
assert.ok(pfxPlan.commands.every((command) => command.displayArgs.includes('<redacted>')), 'display args should redact certificate password');
assert.ok(!JSON.stringify(pfxPlan).includes('super-secret-password'), 'signing plan must not expose certificate password');
assert.ok(pfxPlan.commands.every((command) => command.artifact?.sha256), 'dry-run plan should fingerprint artifacts');

const storePlan = buildSigningPlan({
  artifacts,
  env: {
    NEWAMP_SIGNTOOL_PATH: join(smokeRoot, 'signtool.exe'),
    NEWAMP_SIGN_SHA1: 'ABCDEF123456',
  },
  requireExistingTool: false,
});
assert.equal(storePlan.ok, true, storePlan.reason);
assert.equal(storePlan.mode, 'store');
assert.ok(storePlan.commands.every((command) => command.displayArgs.includes('/sha1')));

const missingPassword = buildSigningPlan({
  artifacts,
  env: {
    NEWAMP_SIGNTOOL_PATH: join(smokeRoot, 'signtool.exe'),
    CSC_LINK: join(smokeRoot, 'newamp-release.pfx'),
  },
  requireExistingTool: false,
});
assert.equal(missingPassword.ok, false);
assert.match(missingPassword.reason, /password/i);

const missingArtifact = buildSigningPlan({
  artifacts: [{ name: 'installer', path: join(smokeRoot, 'missing.exe') }],
  env: {
    NEWAMP_SIGNTOOL_PATH: join(smokeRoot, 'signtool.exe'),
    NEWAMP_SIGN_SHA1: 'ABCDEF123456',
  },
  requireExistingTool: false,
});
assert.equal(missingArtifact.ok, false);
assert.match(missingArtifact.reason, /missing/i);

const dryRun = signArtifacts({
  dryRun: true,
  artifacts,
  env: {
    NEWAMP_SIGNTOOL_PATH: join(smokeRoot, 'signtool.exe'),
    NEWAMP_SIGN_SUBJECT: 'NewAmp Release',
  },
  requireExistingTool: false,
});
assert.equal(dryRun.ok, true);
assert.equal(dryRun.executed, false);
assert.equal(dryRun.commands.length, 3);

console.log(JSON.stringify({
  ok: true,
  pfxCommands: pfxPlan.commands.length,
  storeMode: storePlan.mode,
  dryRunExecuted: dryRun.executed,
}, null, 2));

async function readText(path) {
  return await import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8'));
}
