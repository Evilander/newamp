import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkBuildProvenance } from './build-provenance.mjs';
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
const readinessMode = process.env.NEWAMP_PUBLICATION_READINESS_MODE === 'prepublish' ? 'prepublish' : 'strict';
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
  remoteSourceCheck(readinessMode),
  githubCliCheck(),
  githubAuthCheck(),
  signingWorkflowCheck(),
  githubPublishWorkflowCheck(),
  releaseChecksumsCheck(),
  buildProvenanceCheck(),
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
  mode: readinessMode,
  checks,
  blockers,
  nextStepsWhenReady: [
    'confirm package.json version matches the release you want to publish',
    'npm run package',
    'npm run release:sign -- --dry-run',
    'npm run release:sign',
    'npm run release:checksums',
    'npm run release:provenance',
    'npm run release:bundle',
    'complete Last.fm live-account proof',
    'complete speaker/headphone checks, then run npm run release:record-listening-proof -- --confirm-playback --confirm-output-switching --confirm-crossfade --confirm-gapless',
    'npm run release:gate',
    'commit any final source changes if git-clean fails',
    'gh auth login',
    'npm run release:publish-github -- --execute',
    'npm run release:publication-readiness',
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

function remoteSourceCheck(mode = 'strict') {
  if (mode === 'prepublish') {
    return {
      name: 'remote-source',
      ok: true,
      skipped: true,
      reason: null,
      note: 'remote source is checked after publish pushes main and the release tag',
    };
  }

  const head = runGit(['rev-parse', '--verify', 'HEAD']);
  if (head.status !== 0) {
    return {
      name: 'remote-source',
      ok: false,
      reason: 'cannot resolve local HEAD before checking remote source state',
      output: (head.stderr || head.stdout).trim().slice(0, 1000),
    };
  }

  const expected = head.stdout.trim();
  const tag = `v${releaseVersion}`;
  const refs = [`refs/heads/main`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`];
  const remote = runGit(['ls-remote', 'origin', ...refs]);
  if (remote.status !== 0) {
    return {
      name: 'remote-source',
      ok: false,
      reason: 'cannot read origin/main and release tag from GitHub',
      output: (remote.stderr || remote.stdout).trim().slice(0, 1000),
    };
  }

  const remoteRefs = parseLsRemote(remote.stdout);
  const remoteMain = remoteRefs.get('refs/heads/main') ?? null;
  const remoteTag = remoteRefs.get(`refs/tags/${tag}^{}`) ?? remoteRefs.get(`refs/tags/${tag}`) ?? null;
  const mismatches = [];
  if (remoteMain !== expected) mismatches.push(`origin/main=${shortSha(remoteMain)} expected ${shortSha(expected)}`);
  if (remoteTag !== expected) mismatches.push(`${tag}=${shortSha(remoteTag)} expected ${shortSha(expected)}`);

  return {
    name: 'remote-source',
    ok: mismatches.length === 0,
    head: expected,
    remoteMain,
    remoteTag,
    reason: mismatches.length ? `remote source is not at the release commit: ${mismatches.join('; ')}` : null,
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

function buildProvenanceCheck() {
  const report = checkBuildProvenance({ root: repoRoot, version: releaseVersion });
  return {
    name: 'build-provenance',
    ok: report.ok,
    path: report.path,
    git: report.git,
    artifactCount: report.artifactCount,
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
    ? run('git', hardenedGitArgs(['--git-dir', gitDir, '--work-tree', repoRoot, ...args]), {
        env: nonInteractiveEnv(),
        ...options,
      })
    : run('git', hardenedGitArgs(args), { env: nonInteractiveEnv(), ...options });
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

function parseLsRemote(output) {
  const refs = new Map();
  for (const line of output.trim().split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [sha, ref] = line.split(/\s+/, 2);
    if (sha && ref) refs.set(ref, sha);
  }
  return refs;
}

function shortSha(value) {
  return value ? value.slice(0, 7) : 'missing';
}

function hardenedGitArgs(args) {
  if (process.platform !== 'win32') return args;
  return ['-c', 'http.sslBackend=openssl', ...args];
}

function nonInteractiveEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  };
}

function quoteForCmd(value) {
  if (/^[A-Za-z0-9_./:\\=+-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function quoteForPowerShell(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
