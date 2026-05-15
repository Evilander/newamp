import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (version !== '1.0.0') {
    return failedPlan(root, env, `package.json version is ${version}; GitHub publication is reserved for 1.0.0`);
  }

  const readmePath = resolve(root, 'README.md');
  if (!existsSync(readmePath)) return failedPlan(root, env, 'README.md is missing');

  const repo = text(env.NEWAMP_GITHUB_REPO) || 'evilander/newamp';
  const tag = `v${version}`;
  const installer = resolve(root, 'release', `Newamp Setup ${version}.exe`);
  const portable = resolve(root, 'release', `Newamp Portable ${version}.exe`);
  const missingArtifacts = [
    ['installer', installer],
    ['portable', portable],
  ].filter(([, path]) => !existsSync(path));
  if (missingArtifacts.length) {
    return failedPlan(root, env, `missing release artifacts: ${missingArtifacts.map(([name]) => name).join(', ')}`, {
      repo,
      tag,
      installer,
      portable,
    });
  }

  const gitDir = resolveGitDir(root, env);
  const commands = [];
  if (gitDir) {
    if (!existsSync(gitDir)) {
      commands.push(command('git-init-external', 'git', ['init', '--bare', gitDir]));
      commands.push(command('git-main-branch', 'git', ['--git-dir', gitDir, 'symbolic-ref', 'HEAD', 'refs/heads/main']));
    }
    commands.push(gitCommand('stage', root, gitDir, ['add', '.']));
    commands.push(gitCommand('commit', root, gitDir, ['-c', 'user.name=evilander', '-c', 'user.email=evilander@users.noreply.github.com', 'commit', '-m', `Release Newamp ${version}`]));
    commands.push(command('create-repo', 'gh', ['repo', 'create', repo, '--public']));
    commands.push(gitCommand('add-origin', root, gitDir, ['remote', 'add', 'origin', `https://github.com/${repo}.git`]));
    commands.push(gitCommand('push-main', root, gitDir, ['push', '-u', 'origin', 'main']));
    commands.push(gitCommand('tag', root, gitDir, ['tag', tag]));
    commands.push(gitCommand('push-tag', root, gitDir, ['push', 'origin', tag]));
  } else {
    if (!existsSync(resolve(root, '.git'))) {
      commands.push(command('git-init', 'git', ['init']));
    }
    commands.push(command('stage', 'git', ['add', '.']));
    commands.push(command('commit', 'git', ['commit', '-m', `Release Newamp ${version}`]));
    commands.push(command('create-repo', 'gh', ['repo', 'create', repo, '--source', '.', '--public', '--push']));
    commands.push(command('tag', 'git', ['tag', tag]));
    commands.push(command('push-tag', 'git', ['push', 'origin', tag]));
  }
  commands.push(command('create-release', 'gh', [
    'release',
    'create',
    tag,
    installer,
    portable,
    '--title',
    `Newamp ${version}`,
    '--notes-file',
    readmePath,
  ]));

  return {
    name: 'github-publication',
    ok: true,
    root,
    repo,
    tag,
    version,
    artifacts: { installer, portable },
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
      windowsHide: true,
      timeout: 30_000,
    });
    if (readiness.status !== 0 || readiness.error) {
      return {
        ...plan,
        ok: false,
        executed: false,
        results: [],
        reason: 'publication readiness failed; refusing to create GitHub repo/release',
        readiness: {
          exitCode: readiness.status,
          error: readiness.error?.message ?? null,
          stdout: tail(readiness.stdout),
          stderr: tail(readiness.stderr),
        },
      };
    }
  }

  const results = [];
  for (const item of plan.commands) {
    const result = spawnSync(item.command, item.args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    results.push({
      label: item.label,
      ok: result.status === 0 && !result.error,
      exitCode: result.status,
      error: result.error?.message ?? null,
      stdout: tail(result.stdout),
      stderr: tail(result.stderr),
    });
    if (result.status !== 0 || result.error) {
      return { ...plan, ok: false, executed: true, results, reason: `${item.label} failed` };
    }
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
    version: null,
    artifacts: {
      installer: extra.installer ?? null,
      portable: extra.portable ?? null,
    },
    commands: [],
    reason,
  };
}

function command(label, commandName, args) {
  return {
    label,
    command: commandName,
    args,
    commandLine: [commandName, ...args].map(quoteForDisplay).join(' '),
  };
}

function gitCommand(label, root, gitDir, args) {
  return command(label, 'git', ['--git-dir', gitDir, '--work-tree', root, ...args]);
}

function resolveGitDir(root, env) {
  const configured = text(env.NEWAMP_GIT_DIR);
  if (configured) return resolve(configured);
  const localExternal = resolve(root, '.newamp-git');
  if (existsSync(localExternal)) return localExternal;
  const tmpExternal = resolve('B:/tmp/newamp-publication.git');
  if (process.platform === 'win32' && existsSync(tmpExternal)) return tmpExternal;
  return null;
}

function quoteForDisplay(value) {
  if (/^[A-Za-z0-9_./:\\=+-]+$/.test(value)) return value;
  return `"${String(value).replace(/"/g, '\\"')}"`;
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
