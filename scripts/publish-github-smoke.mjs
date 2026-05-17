import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repoRoot = resolve('.');
const pkg = JSON.parse(await readText(join(repoRoot, 'package.json')));
const fixtureVersion = String(pkg.version);
const publishScriptPath = join(repoRoot, 'scripts', 'publish-github-release.mjs');
const publishScriptSource = await readText(publishScriptPath);
const publicationReadinessSource = await readText(join(repoRoot, 'scripts', 'publication-readiness.mjs'));

assert.equal(
  pkg.scripts?.['release:publish-github'],
  'node scripts/publish-github-release.mjs',
  'package.json should expose release:publish-github',
);
assert.ok(existsSync(publishScriptPath), 'scripts/publish-github-release.mjs should exist');
assert.match(
  publishScriptSource,
  /NEWAMP_PUBLICATION_READINESS_MODE:\s*'prepublish'/,
  'execute mode should run local prepublish readiness before it pushes remote refs',
);
assert.match(
  publishScriptSource,
  /post-publication readiness failed after GitHub publish commands/,
  'execute mode should run strict publication readiness after pushing and publishing',
);
assert.match(
  publicationReadinessSource,
  /remote source is checked after publish pushes main and the release tag/,
  'prepublish readiness should not require remote refs before the publisher pushes them',
);

const prepublishReadiness = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'publication-readiness.mjs')], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    NEWAMP_PUBLICATION_READINESS_MODE: 'prepublish',
  },
  windowsHide: true,
  timeout: 30_000,
});
const prepublishReport = JSON.parse(prepublishReadiness.stdout);
const prepublishRemoteSource = prepublishReport.checks.find((check) => check.name === 'remote-source');
assert.equal(prepublishReport.mode, 'prepublish');
assert.equal(prepublishRemoteSource?.ok, true);
assert.equal(prepublishRemoteSource?.skipped, true);
assert.ok(
  !prepublishReport.blockers.some((blocker) => blocker.startsWith('remote-source:')),
  'prepublish readiness should leave remote-source out of blockers',
);

const {
  buildGithubPublishPlan,
  publishGithubRelease,
} = await import('./publish-github-release.mjs');
const { writeBuildProvenance } = await import('./build-provenance.mjs');
const { createReleaseBundle } = await import('./release-bundle.mjs');
const { writeReleaseChecksums } = await import('./release-checksums.mjs');

const smokeRoot = join(repoRoot, 'tmp', 'publish-github-smoke');
const cleanExternalGitDir = join(repoRoot, 'tmp', 'publish-github-smoke-clean.git');
await rm(smokeRoot, { recursive: true, force: true });
await rm(cleanExternalGitDir, { recursive: true, force: true });
await mkdir(join(smokeRoot, 'release', 'win-unpacked'), { recursive: true });
await mkdir(join(smokeRoot, 'source-fixture'), { recursive: true });
await writeFile(join(smokeRoot, 'package.json'), JSON.stringify({ name: 'newamp', version: fixtureVersion }), 'utf8');
await writeFile(join(smokeRoot, 'README.md'), '# NewAmp\n', 'utf8');
await writeFile(join(smokeRoot, 'release', `NewAmp Setup ${fixtureVersion}.exe`), 'installer', 'utf8');
await writeFile(join(smokeRoot, 'release', `NewAmp Portable ${fixtureVersion}.exe`), 'portable', 'utf8');
await writeFile(join(smokeRoot, 'release', 'win-unpacked', 'NewAmp.exe'), 'exe', 'utf8');
await writeFile(join(smokeRoot, 'source-fixture', 'README.md'), '# NewAmp source fixture\n', 'utf8');
compressDirectoryToZip(
  join(smokeRoot, 'source-fixture'),
  join(smokeRoot, 'release', `NewAmp-${fixtureVersion}-source.zip`),
);
writeReleaseChecksums({ root: smokeRoot, version: fixtureVersion });
writeBuildProvenance({ root: smokeRoot, version: fixtureVersion });
const bundle = createReleaseBundle({
  root: smokeRoot,
  version: fixtureVersion,
  createSourceArchive: false,
  verifyChecksums: false,
});
assert.equal(bundle.ok, true, bundle.reason);

const plan = buildGithubPublishPlan({
  root: smokeRoot,
  env: {},
});
assert.equal(plan.ok, true, plan.reason);
assert.equal(plan.repo, 'evilander/newamp');
assert.equal(plan.tag, `v${fixtureVersion}`);
assert.ok(plan.commands.some((command) => command.label === 'ensure-repo'));
assert.ok(plan.commands.some((command) => command.label === 'publish-release' && command.createArgs.includes('--repo')));
assert.ok(plan.commands.some((command) => command.label === 'publish-release' && command.createArgs.some((arg) => /SHA256SUMS\.txt$/.test(arg))));
assert.ok(plan.commands.some((command) => command.label === 'publish-release' && command.createArgs.some((arg) => /BUILD-PROVENANCE\.json$/.test(arg))));
assert.ok(plan.commands.some((command) => command.label === 'publish-release' && command.createArgs.some((arg) => arg.endsWith(`NewAmp-${fixtureVersion}-source.zip`))));
assert.ok(plan.commands.some((command) => command.label === 'publish-release' && command.createArgs.some((arg) => /RELEASE-MANIFEST\.json$/.test(arg))));
assert.ok(plan.commands.some((command) => command.label === 'publish-release' && command.createArgs.some((arg) => arg.endsWith(`NewAmp-${fixtureVersion}-release-bundle.zip`))));
assert.ok(plan.commands.every((command) => !command.commandLine.includes('\n')));
const pushMainCommand = plan.commands.find((command) => command.label === 'push-main');
assert.ok(pushMainCommand, 'publish plan should push main');
if (process.platform === 'win32') {
  assert.deepEqual(
    pushMainCommand.args.slice(0, 2),
    ['-c', 'http.sslBackend=openssl'],
    'Windows publish git commands should avoid schannel credential-provider failures',
  );
}
assert.ok(JSON.stringify(plan).includes(`NewAmp Setup ${fixtureVersion}.exe`));
assert.ok(JSON.stringify(plan).includes(`NewAmp Portable ${fixtureVersion}.exe`));
assert.match(JSON.stringify(plan), /SHA256SUMS\.txt/);
assert.match(JSON.stringify(plan), /BUILD-PROVENANCE\.json/);
assert.match(JSON.stringify(plan), /RELEASE-MANIFEST\.json/);
assert.ok(JSON.stringify(plan).includes(`NewAmp-${fixtureVersion}-release-bundle.zip`));

const dryRun = publishGithubRelease({
  root: smokeRoot,
  env: {},
  execute: false,
  skipReadiness: true,
});
assert.equal(dryRun.ok, true);
assert.equal(dryRun.executed, false);
assert.equal(dryRun.commands.length, plan.commands.length);

const overridePlan = buildGithubPublishPlan({
  root: smokeRoot,
  env: { NEWAMP_GITHUB_REPO: 'evilander/newamp-test' },
});
assert.equal(overridePlan.ok, true, overridePlan.reason);
assert.equal(overridePlan.repo, 'evilander/newamp-test');

const externalGitDir = join(smokeRoot, 'external.git');
const externalPlan = buildGithubPublishPlan({
  root: smokeRoot,
  env: {
    NEWAMP_GIT_DIR: externalGitDir,
  },
});
assert.equal(externalPlan.ok, true, externalPlan.reason);
assert.equal(externalPlan.repo, 'evilander/newamp');
assert.ok(
  externalPlan.commands.some((command) => command.label === 'git-init-external'),
  'external git plan should initialize the configured git dir',
);
assert.ok(
  externalPlan.commands.filter((command) => command.command === 'git').every((command) => command.args.includes(externalGitDir)),
  'external git plan should route git commands through NEWAMP_GIT_DIR',
);
if (process.platform === 'win32') {
  assert.ok(
    externalPlan.commands.filter((command) => command.command === 'git').every((command) => command.args[0] === '-c'),
    'external git publish commands should also use hardened git transport settings',
  );
}

run('git', ['init', '--bare', cleanExternalGitDir], repoRoot);
run('git', ['--git-dir', cleanExternalGitDir, 'symbolic-ref', 'HEAD', 'refs/heads/main'], repoRoot);
run('git', ['--git-dir', cleanExternalGitDir, '--work-tree', smokeRoot, 'add', '.'], repoRoot);
run('git', [
  '--git-dir',
  cleanExternalGitDir,
  '--work-tree',
  smokeRoot,
  '-c',
  'user.name=evilander',
  '-c',
  'user.email=evilander@users.noreply.github.com',
  'commit',
  '-m',
  'Existing release base',
], repoRoot);
const cleanExistingPlan = buildGithubPublishPlan({
  root: smokeRoot,
  env: { NEWAMP_GIT_DIR: cleanExternalGitDir },
});
assert.equal(cleanExistingPlan.ok, true, cleanExistingPlan.reason);
assert.ok(!cleanExistingPlan.commands.some((command) => command.label === 'stage'));
assert.ok(!cleanExistingPlan.commands.some((command) => command.label === 'commit'));
assert.ok(cleanExistingPlan.commands.some((command) => command.label === 'add-origin'));

run('git', [
  '--git-dir',
  cleanExternalGitDir,
  '--work-tree',
  smokeRoot,
  'remote',
  'add',
  'origin',
  'https://github.com/evilander/old-newamp.git',
], repoRoot);
const retargetOriginPlan = buildGithubPublishPlan({
  root: smokeRoot,
  env: { NEWAMP_GIT_DIR: cleanExternalGitDir },
});
assert.equal(retargetOriginPlan.ok, true, retargetOriginPlan.reason);
assert.ok(retargetOriginPlan.commands.some((command) => command.label === 'set-origin'));
assert.ok(!retargetOriginPlan.commands.some((command) => command.label === 'add-origin'));

run('git', ['--git-dir', cleanExternalGitDir, '--work-tree', smokeRoot, 'tag', `v${fixtureVersion}`], repoRoot);
const existingTagPlan = buildGithubPublishPlan({
  root: smokeRoot,
  env: { NEWAMP_GIT_DIR: cleanExternalGitDir },
});
assert.equal(existingTagPlan.ok, true, existingTagPlan.reason);
assert.ok(!existingTagPlan.commands.some((command) => command.label === 'tag'));

const missingReadme = buildGithubPublishPlan({
  root: join(smokeRoot, 'missing-root'),
  env: {},
});
assert.equal(missingReadme.ok, false);
assert.match(missingReadme.reason, /package\.json/i);

console.log(JSON.stringify({
  ok: true,
  repo: plan.repo,
  tag: plan.tag,
  commands: plan.commands.map((command) => command.label),
}, null, 2));

async function readText(path) {
  return await import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8'));
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stderr || result.stdout || result.error?.message || ''}`);
  }
}

function compressDirectoryToZip(sourceDir, outputPath) {
  if (process.platform !== 'win32') {
    throw new Error('publish GitHub smoke currently uses Windows PowerShell zip support');
  }
  const command = [
    'Compress-Archive',
    '-Path',
    quoteForPowerShell(join(sourceDir, '*')),
    '-DestinationPath',
    quoteForPowerShell(outputPath),
    '-Force',
  ].join(' ');
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], repoRoot);
}

function quoteForPowerShell(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
