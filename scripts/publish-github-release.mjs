import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProvenancePath, checkBuildProvenance } from './build-provenance.mjs';
import { checkReleaseBundle, releaseBundlePaths } from './release-bundle.mjs';
import { checkReleaseChecksums, releaseChecksumsPath } from './release-checksums.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve('.');

export function buildGithubPublishPlan({
  root = repoRoot,
  env = process.env,
} = {}) {
  const packagePath = resolve(root, 'package.json');
  if (!existsSync(packagePath)) {
    return failedPlan(root, env, 'package.json is missing');
  }

  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const version = String(pkg.version ?? '').trim();
  if (!version) return failedPlan(root, env, 'package.json has no version');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    return failedPlan(root, env, `package.json version is not a publishable semver: ${version}`);
  }

  const readmePath = resolve(root, 'README.md');
  if (!existsSync(readmePath)) return failedPlan(root, env, 'README.md is missing');

  const repo = text(env.NEWAMP_GITHUB_REPO) || 'evilander/newamp';
  const tag = `v${version}`;
  const installer = resolve(root, 'release', `NewAmp Setup ${version}.exe`);
  const portable = resolve(root, 'release', `NewAmp Portable ${version}.exe`);
  const checksums = releaseChecksumsPath({ root });
  const provenance = buildProvenancePath({ root });
  const bundlePaths = releaseBundlePaths({ root, version });
  const artifacts = {
    installer,
    portable,
    checksums,
    provenance,
    source: bundlePaths.sourceZip,
    manifest: bundlePaths.manifest,
    bundle: bundlePaths.bundleZip,
  };
  const missingArtifacts = [
    ['installer', installer],
    ['portable', portable],
  ].filter(([, path]) => !existsSync(path));
  if (missingArtifacts.length) {
    return failedPlan(root, env, `missing release artifacts: ${missingArtifacts.map(([name]) => name).join(', ')}`, {
      repo,
      tag,
      ...artifacts,
    });
  }
  const checksumReport = checkReleaseChecksums({ root, version });
  if (!checksumReport.ok) {
    return failedPlan(root, env, checksumReport.reason ?? 'release checksum manifest is not current', {
      repo,
      tag,
      ...artifacts,
      version,
    });
  }
  const provenanceReport = checkBuildProvenance({ root, version });
  if (!provenanceReport.ok) {
    return failedPlan(root, env, provenanceReport.reason ?? 'release build provenance is not current', {
      repo,
      tag,
      ...artifacts,
      version,
    });
  }
  const bundleReport = checkReleaseBundle({ root, version });
  if (!bundleReport.ok) {
    return failedPlan(root, env, bundleReport.reason ?? 'release bundle is not current', {
      repo,
      tag,
      ...artifacts,
      version,
    });
  }

  const gitDir = resolveGitDir(root, env);
  const commands = [];
  const originUrl = `https://github.com/${repo}.git`;
  if (gitDir) {
    const gitDirExists = existsSync(gitDir);
    const hasHead = gitDirExists && hasGitHead(root, gitDir);
    const needsCommit = !gitDirExists || !hasHead || isGitDirty(root, gitDir);
    if (!gitDirExists) {
      commands.push(gitCliCommand('git-init-external', ['init', '--bare', gitDir]));
    }
    if (!gitDirExists || !hasHead) {
      commands.push(gitCommand('git-main-branch', root, gitDir, ['symbolic-ref', 'HEAD', 'refs/heads/main']));
    }
    if (needsCommit) {
      commands.push(gitCommand('stage', root, gitDir, ['add', '.']));
      commands.push(gitCommand('commit', root, gitDir, ['-c', 'user.name=evilander', '-c', 'user.email=evilander@users.noreply.github.com', 'commit', '-m', `Release NewAmp ${version}`]));
    }
    commands.push(ensureGithubRepoCommand(repo));
    commands.push(originCommand(root, gitDir, originUrl));
    commands.push(gitCommand('push-main', root, gitDir, ['push', '-u', 'origin', 'HEAD:main']));
    const tagState = gitTagState(root, gitDir, tag);
    if (tagState === 'different' || (tagState === 'current' && needsCommit)) {
      return failedPlan(root, env, `local tag ${tag} already exists and does not match the planned release HEAD`, {
        repo,
        tag,
        ...artifacts,
        version,
      });
    }
    if (tagState !== 'current') {
      commands.push(gitCommand('tag', root, gitDir, ['tag', tag]));
    }
    commands.push(gitCommand('push-tag', root, gitDir, ['push', 'origin', tag]));
  } else {
    const gitRootExists = existsSync(resolve(root, '.git'));
    const hasHead = gitRootExists && hasGitHead(root, null);
    const needsCommit = !gitRootExists || !hasHead || isGitDirty(root, null);
    if (!gitRootExists) {
      commands.push(gitCliCommand('git-init', ['init']));
    }
    if (!gitRootExists || !hasHead) {
      commands.push(gitCliCommand('git-main-branch', ['symbolic-ref', 'HEAD', 'refs/heads/main']));
    }
    if (needsCommit) {
      commands.push(gitCliCommand('stage', ['add', '.']));
      commands.push(gitCliCommand('commit', ['commit', '-m', `Release NewAmp ${version}`]));
    }
    commands.push(ensureGithubRepoCommand(repo));
    commands.push(originCommand(root, null, originUrl));
    commands.push(gitCliCommand('push-main', ['push', '-u', 'origin', 'HEAD:main']));
    const tagState = gitTagState(root, null, tag);
    if (tagState === 'different' || (tagState === 'current' && needsCommit)) {
      return failedPlan(root, env, `local tag ${tag} already exists and does not match the planned release HEAD`, {
        repo,
        tag,
        ...artifacts,
        version,
      });
    }
    if (tagState !== 'current') {
      commands.push(gitCliCommand('tag', ['tag', tag]));
    }
    commands.push(gitCliCommand('push-tag', ['push', 'origin', tag]));
  }
  commands.push(publishReleaseCommand({ repo, tag, version, readmePath, ...artifacts }));

  return {
    name: 'github-publication',
    ok: true,
    root,
    repo,
    tag,
    version,
    artifacts,
    git: {
      mode: gitDir ? 'external' : 'worktree',
      gitDir,
    },
    commands,
    reason: null,
  };
}

export function publishGithubRelease({
  root = repoRoot,
  env = process.env,
  execute = false,
  skipReadiness = false,
} = {}) {
  const plan = buildGithubPublishPlan({ root, env });
  if (!plan.ok) return { ...plan, executed: false, results: [] };
  if (!execute) return { ...plan, executed: false, results: [] };

  if (!skipReadiness) {
    const readiness = spawnSync(process.execPath, [resolve(root, 'scripts', 'publication-readiness.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: nonInteractivePublishEnv(env, { NEWAMP_PUBLICATION_READINESS_MODE: 'prepublish' }),
      windowsHide: true,
      timeout: 30_000,
    });
    if (readiness.status !== 0 || readiness.error) {
      const readinessReport = readinessResultFromSpawn(readiness);
      return {
        ...plan,
        ok: false,
        executed: false,
        results: [],
        reason: readinessFailureReason('prepublish readiness failed; refusing to create GitHub repo/release', readinessReport),
        readiness: readinessReport,
      };
    }
  }

  const results = [];
  for (const item of plan.commands) {
    const result = runPublishStep(item, root, env);
    results.push({ label: item.label, ...result });
    if (!result.ok) {
      return { ...plan, ok: false, executed: true, results, reason: `${item.label} failed` };
    }
  }

  if (!skipReadiness) {
    const postReadiness = spawnSync(process.execPath, [resolve(root, 'scripts', 'publication-readiness.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: nonInteractivePublishEnv(env),
      windowsHide: true,
      timeout: 30_000,
    });
    if (postReadiness.status !== 0 || postReadiness.error) {
      const postReadinessReport = readinessResultFromSpawn(postReadiness);
      return {
        ...plan,
        ok: false,
        executed: true,
        results,
        reason: readinessFailureReason('post-publication readiness failed after GitHub publish commands', postReadinessReport),
        postReadiness: postReadinessReport,
      };
    }
    return {
      ...plan,
      executed: true,
      results,
      postReadiness: readinessResultFromSpawn(postReadiness),
    };
  }

  return { ...plan, executed: true, results };
}

function failedPlan(root, env, reason, extra = {}) {
  return {
    name: 'github-publication',
    ok: false,
    root,
    repo: (extra.repo ?? text(env.NEWAMP_GITHUB_REPO)) || 'evilander/newamp',
    tag: extra.tag ?? null,
    version: extra.version ?? null,
    artifacts: {
      installer: extra.installer ?? null,
      portable: extra.portable ?? null,
      checksums: extra.checksums ?? null,
      provenance: extra.provenance ?? null,
      source: extra.source ?? null,
      manifest: extra.manifest ?? null,
      bundle: extra.bundle ?? null,
    },
    commands: [],
    reason,
  };
}

function command(label, commandName, args) {
  const commandLine = displayCommand(commandName, args);
  return {
    label,
    command: commandName,
    args,
    commandLine,
  };
}

function gitCommand(label, root, gitDir, args) {
  return gitCliCommand(label, ['--git-dir', gitDir, '--work-tree', root, ...args]);
}

function gitCliCommand(label, args) {
  return command(label, 'git', hardenedGitArgs(args));
}

function ensureGithubRepoCommand(repo) {
  const args = ['repo', 'view', repo];
  const create = command('create-repo', 'gh', ['repo', 'create', repo, '--public']);
  return {
    ...command('ensure-repo', 'gh', args),
    repo,
    create,
    commandLine: `${displayCommand('gh', args)} || ${create.commandLine}`,
  };
}

function originCommand(root, gitDir, originUrl) {
  const currentOrigin = getGitRemoteUrl(root, gitDir, 'origin');
  const args = currentOrigin
    ? ['remote', 'set-url', 'origin', originUrl]
    : ['remote', 'add', 'origin', originUrl];
  const label = currentOrigin ? 'set-origin' : 'add-origin';
  return gitDir ? gitCommand(label, root, gitDir, args) : gitCliCommand(label, args);
}

function publishReleaseCommand({ repo, tag, version, installer, portable, checksums, provenance, source, manifest, bundle, readmePath }) {
  const viewArgs = ['release', 'view', tag, '--repo', repo];
  const editArgs = ['release', 'edit', tag, '--repo', repo, '--title', `NewAmp ${version}`, '--notes-file', readmePath];
  const releaseAssets = [installer, portable, checksums, provenance, source, manifest, bundle];
  const uploadArgs = ['release', 'upload', tag, ...releaseAssets, '--repo', repo, '--clobber'];
  const createArgs = [
    'release',
    'create',
    tag,
    ...releaseAssets,
    '--repo',
    repo,
    '--title',
    `NewAmp ${version}`,
    '--notes-file',
    readmePath,
  ];
  return {
    ...command('publish-release', 'gh', viewArgs),
    repo,
    tag,
    editArgs,
    uploadArgs,
    createArgs,
    commandLine: [
      displayCommand('gh', viewArgs),
      '&&',
      displayCommand('gh', editArgs),
      '&&',
      displayCommand('gh', uploadArgs),
      '||',
      displayCommand('gh', createArgs),
    ].join(' '),
  };
}

function hasGitHead(root, gitDir) {
  const result = runGit(root, gitDir, ['rev-parse', '--verify', 'HEAD']);
  return result.status === 0;
}

function isGitDirty(root, gitDir) {
  const result = runGit(root, gitDir, ['status', '--porcelain']);
  return result.status !== 0 || (result.stdout ?? '').trim().length > 0;
}

function runGit(root, gitDir, args) {
  const commandArgs = hardenedGitArgs(gitDir ? ['--git-dir', gitDir, '--work-tree', root, ...args] : args);
  return spawnSync('git', commandArgs, {
    cwd: root,
    encoding: 'utf8',
    env: gitDir
      ? nonInteractivePublishEnv()
      : nonInteractivePublishEnv(process.env, { GIT_CEILING_DIRECTORIES: dirname(resolve(root)) }),
    windowsHide: true,
    timeout: 30_000,
  });
}

function getGitRemoteUrl(root, gitDir, remote) {
  const result = runGit(root, gitDir, ['remote', 'get-url', remote]);
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitTagState(root, gitDir, tag) {
  const tagResult = runGit(root, gitDir, ['rev-parse', '--verify', `${tag}^{}`]);
  if (tagResult.status !== 0) return 'missing';
  const headResult = runGit(root, gitDir, ['rev-parse', '--verify', 'HEAD']);
  if (headResult.status !== 0) return 'different';
  return tagResult.stdout.trim() === headResult.stdout.trim() ? 'current' : 'different';
}

function runPublishStep(item, root, env) {
  if (item.label === 'ensure-repo') return runEnsureRepoStep(item, root, env);
  if (item.label === 'publish-release') return runPublishReleaseStep(item, root, env);
  return resultFromSpawn(spawnPublishCommand(item.command, item.args, root, env));
}

function runEnsureRepoStep(item, root, env) {
  const view = spawnPublishCommand(item.command, item.args, root, env);
  if (view.status === 0 && !view.error) {
    return { ...resultFromSpawn(view), action: 'repo-exists' };
  }
  const create = spawnPublishCommand(item.create.command, item.create.args, root, env);
  return {
    ...resultFromSpawn(create),
    action: 'repo-created',
    viewExitCode: view.status,
    viewError: view.error?.message ?? null,
    viewStderr: tail(view.stderr),
  };
}

function runPublishReleaseStep(item, root, env) {
  const view = spawnPublishCommand(item.command, item.args, root, env);
  if (view.status === 0 && !view.error) {
    const edit = spawnPublishCommand('gh', item.editArgs, root, env);
    if (edit.status !== 0 || edit.error) {
      return {
        ...resultFromSpawn(edit),
        action: 'release-edit-failed',
        viewExitCode: view.status,
      };
    }
    const upload = spawnPublishCommand('gh', item.uploadArgs, root, env);
    return {
      ...resultFromSpawn(upload),
      action: 'release-updated',
      viewExitCode: view.status,
      editExitCode: edit.status,
      editStdout: tail(edit.stdout),
      editStderr: tail(edit.stderr),
    };
  }

  const create = spawnPublishCommand('gh', item.createArgs, root, env);
  return {
    ...resultFromSpawn(create),
    action: 'release-created',
    viewExitCode: view.status,
    viewError: view.error?.message ?? null,
    viewStderr: tail(view.stderr),
  };
}

function spawnPublishCommand(commandName, args, root, env = process.env) {
  return spawnSync(commandName, args, {
    cwd: root,
    encoding: 'utf8',
    env: nonInteractivePublishEnv(env),
    windowsHide: true,
    timeout: 60_000,
  });
}

function resultFromSpawn(result) {
  return {
    ok: result.status === 0 && !result.error,
    exitCode: result.status,
    error: result.error?.message ?? null,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr),
  };
}

function readinessResultFromSpawn(result) {
  const parsed = parseJsonReport(result.stdout);
  const base = {
    exitCode: result.status,
    error: result.error?.message ?? null,
    stderr: tail(result.stderr),
  };
  if (!parsed) {
    return {
      ...base,
      stdout: tail(result.stdout),
    };
  }
  return {
    ...base,
    mode: parsed.mode ?? null,
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
    failedChecks: Array.isArray(parsed.checks)
      ? parsed.checks
          .filter((check) => check && check.ok === false)
          .map((check) => ({
            name: check.name ?? 'unknown',
            reason: check.reason ?? null,
          }))
      : [],
  };
}

function readinessFailureReason(prefix, readinessReport) {
  return readinessReport.blockers?.length
    ? `${prefix}: ${readinessReport.blockers.join('; ')}`
    : prefix;
}

function parseJsonReport(output) {
  const textValue = String(output ?? '').trim();
  if (!textValue) return null;
  const start = textValue.indexOf('{');
  const end = textValue.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(textValue.slice(start, end + 1));
  } catch {
    return null;
  }
}

function resolveGitDir(root, env) {
  const configured = text(env.NEWAMP_GIT_DIR);
  if (configured) return resolve(configured);
  const localExternal = resolve(root, '.newamp-git');
  if (existsSync(localExternal)) return localExternal;
  const tmpExternal = resolve('B:/tmp/newamp-publication.git');
  if (process.platform === 'win32' && resolve(root) === repoRoot && existsSync(tmpExternal)) return tmpExternal;
  return null;
}

function quoteForDisplay(value) {
  if (/^[A-Za-z0-9_./:\\=+-]+$/.test(value)) return value;
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function displayCommand(commandName, args) {
  return [commandName, ...args].map(quoteForDisplay).join(' ');
}

function hardenedGitArgs(args) {
  if (process.platform !== 'win32') return args;
  return ['-c', 'http.sslBackend=openssl', ...args];
}

function nonInteractivePublishEnv(baseEnv = process.env, extra = {}) {
  return {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GH_PROMPT_DISABLED: '1',
    ...extra,
  };
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function tail(value) {
  return (value ?? '').trim().split(/\r?\n/).slice(-30).join('\n');
}

function parseCli(argv) {
  const flags = new Set(argv);
  return {
    execute: flags.has('--execute'),
    help: flags.has('--help') || flags.has('-h'),
  };
}

function printUsage() {
  console.log([
    'Usage:',
    '  npm run release:publish-github',
    '  npm run release:publish-github -- --execute',
    '',
    'Default mode is a dry run. Execution refuses to continue unless release:publication-readiness passes.',
  ].join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    printUsage();
  } else {
    const report = publishGithubRelease({ execute: cli.execute });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  }
}
