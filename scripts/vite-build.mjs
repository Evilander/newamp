import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot, sleep, withBuildLock } from './build-lock.mjs';

const args = process.argv.slice(2);
const holdMs = readNumberArg('--hold-ms', 0);
const smokeLockOnly = args.includes('--smoke-lock-only');
const viteArgs = args.filter((arg) => arg !== '--smoke-lock-only' && !arg.startsWith('--hold-ms='));

const status = await withBuildLock(async (lock) => {
  console.error(`[newamp-build] renderer build lock acquired after ${lock.waitedMs}ms`);
  if (smokeLockOnly) {
    await sleep(holdMs);
    return 0;
  }
  return runViteBuild(viteArgs);
});
// Fail only once withBuildLock has released the lock. Exiting inside the
// callback skipped its release and left tmp/vite-build.lock blocking every
// other build until the 30-minute stale window ran out.
if (status !== 0) process.exitCode = status;

function runViteBuild(extraArgs) {
  const viteBin = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');
  const commandArgs = ['build', ...extraArgs];
  const result = spawnSync(process.platform === 'win32' ? 'cmd.exe' : viteBin, process.platform === 'win32'
    ? ['/d', '/s', '/c', [quoteForCmd(viteBin), ...commandArgs.map(quoteForCmd)].join(' ')]
    : commandArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: process.env,
  });

  if (result.error) console.error('[newamp-build] vite could not be started:', result.error);
  return result.status ?? 1;
}

function readNumberArg(name, fallback) {
  const prefix = `${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  if (!match) return fallback;
  const value = Number(match.slice(prefix.length));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function quoteForCmd(value) {
  if (/^[A-Za-z0-9_./:\\=+-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
