import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DEFAULT_BUILD_LOCK_DIR = join(repoRoot, 'tmp', 'vite-build.lock');

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 150;
const DEFAULT_STALE_MS = 30 * 60 * 1000;
const OWNER_FILE = 'owner.json';

export async function withBuildLock(fn, options = {}) {
  const lock = await acquireBuildLock(options);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}

export async function acquireBuildLock(options = {}) {
  const lockDir = normalizeLockDir(options.lockDir ?? DEFAULT_BUILD_LOCK_DIR);
  const timeoutMs = normalizePositive(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const pollMs = normalizePositive(options.pollMs, DEFAULT_POLL_MS);
  const staleMs = normalizePositive(options.staleMs, DEFAULT_STALE_MS);
  const startedAt = Date.now();
  let recoveredStaleLocks = 0;

  await mkdir(dirname(lockDir), { recursive: true });

  while (true) {
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, OWNER_FILE), JSON.stringify(buildOwner(), null, 2), 'utf8');
      return {
        lockDir,
        waitedMs: Date.now() - startedAt,
        recoveredStaleLocks,
        release: async () => {
          await rm(lockDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;

      if (await isStaleLock(lockDir, staleMs)) {
        await rm(lockDir, { recursive: true, force: true });
        recoveredStaleLocks += 1;
        continue;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for build lock: ${lockDir}`);
      }
      await sleep(pollMs);
    }
  }
}

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function isStaleLock(lockDir, staleMs) {
  try {
    const owner = JSON.parse(await readFile(join(lockDir, OWNER_FILE), 'utf8'));
    const ageMs = Date.now() - Number(owner.startedAt ?? 0);
    if (ageMs < staleMs) return false;
    return !isProcessAlive(Number(owner.pid));
  } catch {
    return false;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function buildOwner() {
  return {
    pid: process.pid,
    startedAt: Date.now(),
    command: process.argv.join(' '),
    cwd: process.cwd(),
  };
}

function normalizeLockDir(input) {
  const lockDir = resolve(input);
  const tmpRoot = resolve(repoRoot, 'tmp');
  if (!isWithin(tmpRoot, lockDir) || !lockDir.endsWith('.lock')) {
    throw new Error(`Refusing unsafe build lock path: ${lockDir}`);
  }
  return lockDir;
}

function isWithin(parent, child) {
  const normalizedParent = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const normalizedChild = process.platform === 'win32' ? child.toLowerCase() : child;
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(normalizedParent.endsWith(sep) ? normalizedParent : `${normalizedParent}${sep}`)
  );
}

function normalizePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
