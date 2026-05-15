import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot, sleep, withBuildLock } from './build-lock.mjs';

const smokeRoot = fileURLToPath(new URL('../tmp/build-lock-smoke/', import.meta.url));
const lockDir = join(smokeRoot, 'vite-build.lock');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const events = [];
let releaseFirst;
let resolveFirstEntered;
const firstEntered = new Promise((resolvePromise) => {
  resolveFirstEntered = resolvePromise;
});
const first = withBuildLock(async () => {
  events.push('first-enter');
  resolveFirstEntered();
  await new Promise((release) => {
    releaseFirst = release;
  });
  events.push('first-exit');
}, { lockDir, pollMs: 20, timeoutMs: 5000 });

await firstEntered;
let secondEntered = false;
const second = withBuildLock(async (lock) => {
  secondEntered = true;
  events.push('second-enter');
  return lock.waitedMs;
}, { lockDir, pollMs: 20, timeoutMs: 5000 });

await sleep(120);
assert.equal(secondEntered, false, 'second lock holder should wait while first holder is active');
releaseFirst();
const [, secondWaitMs] = await Promise.all([first, second]);

assert.deepEqual(events, ['first-enter', 'first-exit', 'second-enter']);
assert.ok(secondWaitMs >= 100, `second holder should report waiting for the first holder, got ${secondWaitMs}ms`);

await mkdir(lockDir, { recursive: true });
await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: -1, startedAt: 0 }), 'utf8');
const recoveredStaleLocks = await withBuildLock(async (lock) => lock.recoveredStaleLocks, {
  lockDir,
  pollMs: 10,
  timeoutMs: 1000,
  staleMs: 1,
});
assert.equal(recoveredStaleLocks, 1, 'dead stale build locks should be recovered');

const [packageSource, gateSource, viteBuildSource] = await Promise.all([
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/vite-build.mjs', import.meta.url), 'utf8'),
]);

assert.match(packageSource, /node scripts\/vite-build\.mjs/, 'package scripts should route Vite builds through the lock wrapper');
assert.match(packageSource, /smoke:build-lock/, 'package scripts should expose build lock smoke coverage');
assert.match(gateSource, /smoke:build-lock/, 'release gate should include build lock smoke coverage');
assert.match(viteBuildSource, /withBuildLock/, 'Vite wrapper should acquire the shared build lock');

console.log(JSON.stringify({
  ok: true,
  repoRoot,
  events,
  secondWaitMs,
  recoveredStaleLocks,
}, null, 2));
