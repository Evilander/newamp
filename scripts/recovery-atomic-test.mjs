import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const parent = resolve('tmp/recovery-atomic');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, 'run-'));

await build({
  entryPoints: ['electron/recovery.ts'],
  outfile: join(root, 'recovery.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  plugins: [{ name: 'rename-overrides', setup(builder) {
    builder.onLoad({ filter: /recovery\.ts$/ }, async ({ path }) => {
      const source = readFileSync(path, 'utf8')
        .replace('renameSync, unlinkSync', 'renameSync as realRenameSync, unlinkSync')
        .replace('rename as fsRename', 'rename as realFsRename')
        .replace(
          "import type { RecoveryEvent } from '../shared/types.js';",
          `import type { RecoveryEvent } from '../shared/types.js';
const renameSync = (fromPath: string, toPath: string): void => {
  const override = (globalThis as any).__renameSyncOverride;
  if (override) return override(fromPath, toPath, realRenameSync);
  return realRenameSync(fromPath, toPath);
};
const fsRename = async (fromPath: string, toPath: string): Promise<void> => {
  const override = (globalThis as any).__fsRenameOverride;
  if (override) return override(fromPath, toPath, realFsRename);
  return realFsRename(fromPath, toPath);
};`,
        );
      return { contents: source, loader: 'ts' };
    });
  } }],
});

const { renameOverExistingAsync, renameOverExistingSync } = await import(pathToFileURL(join(root, 'recovery.mjs')));

function transientLockedTarget(target) {
  const err = new Error(`locked ${target}`);
  err.code = 'EPERM';
  return err;
}

{
  const target = join(root, 'sync-target.json');
  const tmp = `${target}.tmp-complete`;
  writeFileSync(target, 'old-sync');
  writeFileSync(tmp, 'new-sync');
  let attempts = 0;
  globalThis.__renameSyncOverride = (from, to, realRename) => {
    if (to === target) {
      attempts += 1;
      throw transientLockedTarget(target);
    }
    return realRename(from, to);
  };
  assert.throws(
    () => renameOverExistingSync(tmp, target),
    /complete copy remains/,
    'sync atomic replace should report the preserved complete temp after transient retry exhaustion',
  );
  assert.ok(attempts > 1, 'sync replace should retry transient target locks before failing closed');
  assert.equal(readFileSync(target, 'utf8'), 'old-sync', 'sync replace failure must not truncate or overwrite the live target');
  assert.equal(readFileSync(tmp, 'utf8'), 'new-sync', 'sync replace failure must preserve the complete temp snapshot');
  assert.equal(existsSync(`${target}.tmp-${process.pid}-retry`), false, 'failed retry temp should be cleaned');
}

{
  const target = join(root, 'async-target.json');
  const tmp = `${target}.tmp-complete`;
  writeFileSync(target, 'old-async');
  writeFileSync(tmp, 'new-async');
  let attempts = 0;
  globalThis.__fsRenameOverride = async (from, to, realRename) => {
    if (to === target) {
      attempts += 1;
      throw transientLockedTarget(target);
    }
    return realRename(from, to);
  };
  await assert.rejects(
    () => renameOverExistingAsync(tmp, target),
    /complete copy remains/,
    'async atomic replace should report the preserved complete temp after transient retry exhaustion',
  );
  assert.ok(attempts > 1, 'async replace should retry transient target locks before failing closed');
  assert.equal(readFileSync(target, 'utf8'), 'old-async', 'async replace failure must not truncate or overwrite the live target');
  assert.equal(readFileSync(tmp, 'utf8'), 'new-async', 'async replace failure must preserve the complete temp snapshot');
  assert.equal(existsSync(`${target}.tmp-${process.pid}-retry`), false, 'failed async retry temp should be cleaned');
}

delete globalThis.__renameSyncOverride;
delete globalThis.__fsRenameOverride;
await rm(root, { recursive: true, force: true });
console.log('[recovery-atomic-test] PASS: failed atomic replace preserves live target and complete temp');
