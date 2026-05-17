import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkManualListeningProof, summarizeManualListeningProof } from './manual-listening-proof.mjs';
import { checkReleaseBundle } from './release-bundle.mjs';
import { checkReleaseChecksums } from './release-checksums.mjs';
import { checkLastfmLiveProof, summarizeLastfmLiveProof } from './lastfm-live-proof.mjs';

const repoRoot = resolve('.');
const packagePath = resolve(repoRoot, 'package.json');
const readmePath = resolve(repoRoot, 'README.md');
const gitDir = resolveGitDir(repoRoot, process.env);
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const releaseVersion = String(pkg.version ?? '').trim() || '0.0.0';
const artifacts = [
  { name: 'installer', path: resolve(repoRoot, 'release', `NewAmp Setup ${releaseVersion}.exe`) },
  { name: 'portable', path: resolve(repoRoot, 'release', `NewAmp Portable ${releaseVersion}.exe`) },
  { name: 'exe', path: resolve(repoRoot, 'release', 'win-unpacked', 'NewAmp.exe') },
];

const checks = [
  packageVersionCheck(),
  readmeCheck(),
  gitRepoCheck(),
  gitWritableCheck(),
  gitCleanCheck(),
  githubCliCheck(),
  githubAuthCheck(),
  signingWorkflowCheck(),
  githubPublishWorkflowCheck(),
  releaseChecksumsCheck(),
  releaseBundleCheck(),
  artifactSignatureCheck(),
  lastfmProofCheck(),
  manualProofCheck(),
];
const blockers = checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.reason}`);
const report = {
  ok: blockers.length === 0,
  target: {
    repo: process.env.NEWAMP_GITHUB_REPO || 'evilander/newamp',
    tag: `v${releaseVersion}`,
    git: {
      mode: gitDir ? 'external' : 'worktree',
      gitDir,
    },
  },
  checks,
  blockers,
  nextStepsWhenReady: [
    'confirm package.json version matches the release you want to publish',
    'npm run package',
    'npm run release:checksums',
    'npm run release:bundle',
    'npm run release:sign -- --dry-run',
    'npm run release:sign',
    'complete Last.fm live-account proof and any required Ultimate Guitar release decision',
    'complete speaker/headphone checks, then run npm run release:record-listening-proof -- --confirm-playback --confirm-output-switching --confirm-crossfade --confirm-gapless',
    'npm run release:gate',
    'commit any final source changes if git-clean fails',
    'gh auth login',
    'npm run release:publication-readiness',
    'npm run release:publish-github -- --execute',
  ],
};

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;

function packageVersionCheck() {
  const publishable = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version);
  return {
    name: 'package-version',
    ok: publishable,
    version: pkg.version,
    reason: publishable ? null : `package.json version is not a publishable semver: ${pkg.version}`,
  };
}

function readmeCheck() {
  if (!existsSync(readmePath)) {
    return { name: 'readme', ok: false, path: readmePath, reason: 'README.md is missing' };
  }
  const readme = readFileSync(readmePath, 'utf8');
  const required = ['NewAmp', 'Install', 'Build from source', 'Privacy'];
  const missing = required.filter((text) => !readme.includes(text));
  return {
    name: 'readme',
    ok: missing.length === 0,
    path: readmePath,
    missing,
    reason: missing.length ? `README.md is missing sections: ${missing.join(', ')}` : null,
  };
}

function gitRepoCheck() {
  const result = runGit(['rev-parse', '--is-inside-work-tree']);
  const ok = result.status === 0 && result.stdout.trim() === 'true';
  return {
    name: 'git-repo',
    ok,
    reason: ok ? null : 'this folder is not initialized as a usable git repository',
    output: (result.stderr || result.stdout).trim().slice(0, 1000),
  };
}

function gitWritableCheck() {
  if (!gitDir && !existsSync(resolve(repoRoot, '.git'))) {
    return { name: 'git-object-database', ok: false, reason: 'cannot check git object writes before git init' };
  }
  const result = runGit(['hash-object', '-w', '--stdin'], { input: 'newamp-publication-readiness\n' });
  const ok = result.status === 0 && /^[a-f0-9]{40}$/i.test(result.stdout.trim());
  return {
    name: 'git-object-database',
    ok,
    reason: ok ? null : 'git object database is not writable; commits/tags cannot be created on this host',
    output: (result.stderr || result.stdout).trim().slice(0, 1000),
  };
}

function gitCleanCheck() {
  if (!gitDir && !existsSync(resolve(repoRoot, '.git'))) {
    return { name: 'git-clean', ok: false, reason: 'cannot check cleanliness before git init' };
  }
  const result = runGit(['status', '--porcelain']);
  const dirty = result.status !== 0 || result.stdout.trim().length > 0;
  return {
    name: 'git-clean',
    ok: !dirty,
    reason: dirty ? 'git worktree has uncommitted changes' : null,
    status: result.status,
    output: result.stdout.trim().slice(0, 1000),
  };
}

function githubCliCheck() {
  const result = run(process.platform === 'win32' ? 'where.exe' : 'which', ['gh']);
  const ok = result.status === 0 && result.stdout.trim().length > 0;
  return {
    name: 'github-cli',
    ok,
    path: ok ? result.stdout.trim().split(/\r?\n/)[0] : null,
    reason: ok ? null : 'GitHub CLI gh was not found on PATH',
  };
}

function githubAuthCheck() {
  const result = run('gh', ['auth', 'status']);
  const ok = result.status === 0;
  return {
    name: 'github-auth',
    ok,
    reason: ok ? null : 'GitHub CLI is not authenticated; run gh auth login before publication',
    output: (result.stderr || result.stdout).trim().slice(0, 1000),
  };
}

function signingWorkflowCheck() {
  const ok =
    pkg.scripts?.['release:sign'] === 'node scripts/sign-artifacts.mjs' &&
    existsSync(resolve(repoRoot, 'scripts', 'sign-artifacts.mjs'));
  return {
    name: 'signing-workflow',
    ok,
    reason: ok ? null : 'release:sign script is missing or not wired to scripts/sign-artifacts.mjs',
  };
}

function githubPublishWorkflowCheck() {
  const ok =
    pkg.scripts?.['release:publish-github'] === 'node scripts/publish-github-release.mjs' &&
    existsSync(resolve(repoRoot, 'scripts', 'publish-github-release.mjs'));
  return {
    name: 'github-publish-workflow',
    ok,
    reason: ok ? null : 'release:publish-github script is missing or not wired to scripts/publish-github-release.mjs',
  };
}

function releaseChecksumsCheck() {
  const report = checkReleaseChecksums({ root: repoRoot, version: releaseVersion });
  return {
    name: 'release-checksums',
    ok: report.ok,
    path: report.path,
    exists: report.exists,
    reason: report.reason,
  };
}

function releaseBundleCheck() {
  const report = checkReleaseBundle({ root: repoRoot, version: releaseVersion });
  return {
    name: 'release-bundle',
    ok: report.ok,
    paths: report.paths,
    bundle: report.bundle,
    sourceArchive: report.sourceArchive,
    reason: report.reason,
  };
}

function artifactSignatureCheck() {
  const statuses = artifacts.map((artifact) => ({
    ...artifact,
    exists: existsSync(artifact.path),
    signature: signatureStatus(artifact.path),
  }));
  const unsigned = statuses.filter((artifact) => artifact.signature.status !== 'Valid');
  return {
    name: 'signed-artifacts',
    ok: unsigned.length === 0,
    artifacts: statuses,
    reason: unsigned.length ? `unsigned or invalid artifacts: ${unsigned.map((item) => `${item.name}=${item.signature.status}`).join(', ')}` : null,
  };
}

function manualProofCheck() {
  const report = checkManualListeningProof();
  return {
    name: 'manual-listening-proof',
    ok: report.ok,
    proofPath: report.proofPath,
    reason: report.ok ? null : summarizeManualListeningProof(report),
  };
}

function lastfmProofCheck() {
  const report = checkLastfmLiveProof();
  return {
    name: 'lastfm-live-proof',
    ok: report.ok,
    proofPath: report.proofPath,
    username: report.username ?? null,
    reason: report.ok ? null : summarizeLastfmLiveProof(report),
  };
}

function runGit(args, options = {}) {
  return gitDir
    ? run('git', ['--git-dir', gitDir, '--work-tree', repoRoot, ...args], options)
    : run('git', args, options);
}

function resolveGitDir(root, env) {
  const configured = typeof env.NEWAMP_GIT_DIR === 'string' && env.NEWAMP_GIT_DIR.trim()
    ? env.NEWAMP_GIT_DIR.trim()
    : '';
  if (configured) return resolve(configured);
  const localExternal = resolve(root, '.newamp-git');
  if (existsSync(localExternal)) return localExternal;
  const tmpExternal = resolve('B:/tmp/newamp-publication.git');
  if (process.platform === 'win32' && existsSync(tmpExternal)) return tmpExternal;
  return null;
}

function signatureStatus(path) {
  if (!existsSync(path)) return { status: 'Missing', statusMessage: 'Artifact does not exist.' };
  if (process.platform !== 'win32') return { status: 'Skipped', statusMessage: 'Authenticode is Windows-only.' };
  const command = [
    '$sig = Get-AuthenticodeSignature -LiteralPath',
    quoteForPowerShell(path),
    '; [pscustomobject]@{ Status = [string]$sig.Status; StatusMessage = $sig.StatusMessage } | ConvertTo-Json -Compress',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0 || result.error) {
    return { status: 'Error', statusMessage: result.error?.message || (result.stderr || result.stdout || '').trim() };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return { status: parsed.Status, statusMessage: parsed.StatusMessage ?? '' };
  } catch {
    return { status: 'Error', statusMessage: result.stdout.trim() };
  }
}

function run(command, args, options = {}) {
  const isWindows = process.platform === 'win32';
  return spawnSync(
    isWindows && command !== 'where.exe' ? 'cmd.exe' : command,
    isWindows && command !== 'where.exe'
      ? ['/d', '/s', '/c', [quoteForCmd(command), ...args.map(quoteForCmd)].join(' ')]
      : args,
    {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      ...options,
    },
  );
}

function quoteForCmd(value) {
  if (/^[A-Za-z0-9_./:\\=+-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function quoteForPowerShell(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
