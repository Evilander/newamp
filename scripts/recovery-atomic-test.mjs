import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';

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

const {
  atomicWriteFileSync,
  findUnsavedTempCopies,
  judgeOrphanedTemp,
  renameOverExistingAsync,
  renameOverExistingSync,
  sweepOrphanedTempFiles,
} = await import(pathToFileURL(join(root, 'recovery.mjs')));

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

// A caller with a backoff of its own asks for one attempt: the refusal comes back at once, as it was thrown.
{
  const target = join(root, 'quick-target.json');
  const tmp = `${target}.tmp-complete`;
  writeFileSync(target, 'old-quick');
  writeFileSync(tmp, 'new-quick');
  let attempts = 0;
  globalThis.__renameSyncOverride = (from, to, realRename) => {
    if (to === target) {
      attempts += 1;
      throw transientLockedTarget(target);
    }
    return realRename(from, to);
  };
  const began = performance.now();
  assert.throws(() => renameOverExistingSync(tmp, target, { retry: false }), (err) => err.code === 'EPERM' && /locked/.test(err.message), 'the original error is thrown');
  assert.equal(attempts, 1, 'one attempt');
  assert.ok(performance.now() - began < 200, 'without sleeping through the backoff (the default form sleeps 240 ms)');
  assert.equal(readFileSync(target, 'utf8'), 'old-quick', 'the target is untouched');
  assert.equal(readFileSync(tmp, 'utf8'), 'new-quick', 'and the temp file is still whole');
  assert.equal(existsSync(`${target}.tmp-${process.pid}-retry`), false, 'no rewrite through a second temp file');

  // The default form is unchanged: it retries, then reports where the complete copy is.
  attempts = 0;
  assert.throws(() => renameOverExistingSync(tmp, target), /complete copy remains/);
  assert.ok(attempts > 1);

  // When the replace goes through, both forms do the same.
  globalThis.__renameSyncOverride = undefined;
  renameOverExistingSync(tmp, target, { retry: false });
  assert.equal(readFileSync(target, 'utf8'), 'new-quick');
  assert.equal(existsSync(tmp), false);
}

delete globalThis.__renameSyncOverride;
delete globalThis.__fsRenameOverride;

// ---- a failed replace leaves the only complete copy; the next launch's sweep keeps it ----
const ago = (minutes) => new Date(Date.now() - minutes * 60_000);
const stamped = (path, when) => utimesSync(path, when, when);
// The next launch has another pid, so the temp file the quit left behind is renamed to look like it.
const fromEarlierSession = (path) => {
  const earlier = path.replace(`.tmp-${process.pid}-`, '.tmp-4242424-');
  renameSync(path, earlier);
  return earlier;
};
{
  const dir = await mkdtemp(join(root, 'sweep-'));
  const target = join(dir, 'settings.json');
  writeFileSync(target, JSON.stringify({ volume: 0.2 }));
  stamped(target, ago(120));
  globalThis.__renameSyncOverride = (from, to, realRename) => {
    if (to === target) throw transientLockedTarget(target);
    return realRename(from, to);
  };
  const newest = JSON.stringify({ volume: 0.9, theme: 'ink' });
  assert.throws(() => atomicWriteFileSync(target, newest), /complete copy is at/);
  delete globalThis.__renameSyncOverride;
  assert.equal(readFileSync(target, 'utf8'), '{"volume":0.2}', 'the locked target keeps its old content');
  const leftover = fromEarlierSession(`${target}.tmp-${process.pid}-sync`);
  stamped(leftover, ago(10));

  assert.deepEqual(sweepOrphanedTempFiles(dir), [], 'the sweep removes nothing');
  assert.equal(readFileSync(leftover, 'utf8'), newest, 'the only complete copy of the newest state is still there');
  assert.deepEqual(findUnsavedTempCopies(dir), [{ tempPath: leftover, targetPath: target }], 'and it is reported');
  assert.equal(judgeOrphanedTemp(leftover, target), 'unsaved');

  // Once a later session has written the target, the copy is behind it.
  writeFileSync(target, JSON.stringify({ volume: 1 }));
  stamped(target, ago(5));
  assert.equal(judgeOrphanedTemp(leftover, target), 'superseded');
  assert.deepEqual(sweepOrphanedTempFiles(dir), [leftover], 'a copy the target has overtaken goes');
  assert.equal(existsSync(leftover), false);
}

{
  const dir = await mkdtemp(join(root, 'sweep-'));
  const target = join(dir, 'podcasts.json');
  const make = (suffix, content, when) => {
    const path = `${target}.tmp-${suffix}`;
    writeFileSync(path, content);
    stamped(path, when);
    return path;
  };

  // No target at all: the temp file is all there is.
  const alone = make('777-sync', '{"feeds":[]}', ago(10));
  assert.deepEqual(sweepOrphanedTempFiles(dir), []);
  assert.equal(existsSync(alone), true, 'a copy whose target is missing stays');

  // A write cut short is not a copy of anything.
  const cut = make('778-3', '{"feeds":[{"url":"https://exam', ago(10));
  const empty = make('779-4', '', ago(10));
  assert.equal(judgeOrphanedTemp(cut, target), 'partial');
  assert.deepEqual(sweepOrphanedTempFiles(dir).sort(), [cut, empty].sort(), 'truncated and empty files go; the whole copy stays');
  assert.equal(existsSync(alone), true);

  // A target this process wrote a moment ago does not prove the temp file is behind it.
  writeFileSync(target, '{"feeds":["written at startup"]}');
  assert.equal(judgeOrphanedTemp(alone, target), 'unsaved', 'a rewrite during startup keeps the older copy');
  assert.deepEqual(sweepOrphanedTempFiles(dir), []);

  // Several failed sessions leave several whole copies; only the newest is kept.
  stamped(target, ago(300));
  const oldest = make('780-sync', '{"feeds":["a"]}', ago(200));
  const middle = make('781-sync', '{"feeds":["a","b"]}', ago(100));
  stamped(alone, ago(50));
  assert.deepEqual(sweepOrphanedTempFiles(dir).sort(), [oldest, middle].sort());
  assert.deepEqual(findUnsavedTempCopies(dir), [{ tempPath: alone, targetPath: target }]);

  // The age floor and this process's own files are untouched.
  const fresh = make('782-sync', '{"x":', ago(0));
  const mine = make(`${process.pid}-sync`, '{"x":', ago(30));
  assert.deepEqual(sweepOrphanedTempFiles(dir), []);
  assert.deepEqual([fresh, mine].map((path) => existsSync(path)), [true, true]);
}

// A library.db temp file is whole once it is as long as its header says.
{
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  database.run('CREATE TABLE tracks (id INTEGER PRIMARY KEY, title TEXT)');
  for (let i = 0; i < 400; i += 1) database.run('INSERT INTO tracks (title) VALUES (?)', [`track ${i} ${'x'.repeat(40)}`]);
  const bytes = Buffer.from(database.export());
  database.close();
  assert.ok(bytes.length > 8192, 'the fixture spans several pages');
  const dir = await mkdtemp(join(root, 'sweep-'));
  const target = join(dir, 'library.db');
  const whole = join(dir, 'library.db.tmp-1-sync');
  const cut = join(dir, 'library.db.tmp-2-sync');
  const text = join(dir, 'library.db.tmp-3-sync');
  writeFileSync(target, bytes.subarray(0, 4096));
  stamped(target, ago(120));
  writeFileSync(whole, bytes);
  writeFileSync(cut, bytes.subarray(0, bytes.length - 100));
  writeFileSync(text, 'not a database');
  assert.equal(judgeOrphanedTemp(whole, target), 'unsaved');
  assert.equal(judgeOrphanedTemp(cut, target), 'partial', 'a database cut short');
  assert.equal(judgeOrphanedTemp(text, target), 'partial', 'something that is not a database');
  assert.deepEqual(sweepOrphanedTempFiles(dir, 0), [], 'the sweep leaves the library to the library');
}

await rm(root, { recursive: true, force: true });
console.log('[recovery-atomic-test] PASS: failed atomic replace preserves live target and complete temp');
