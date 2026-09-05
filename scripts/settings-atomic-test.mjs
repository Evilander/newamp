// Tests for SettingsStore crash-safety: settings.json is written via a
// Sibling temp file + fsync + rename (atomic replace), so an interrupted
// write can never truncate the file back to defaults (losing library roots,
// the Last.fm session, …). The on-disk content is therefore always either the
// old or the new complete JSON.
// Run: npm run build:electron && node scripts/settings-atomic-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SettingsStore } from '../dist-electron/electron/settings.js';
import { atomicWriteFileSync } from '../dist-electron/electron/recovery.js';
import { mkdirSync, existsSync } from 'node:fs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'settings-atomic-test');
const settingsPath = join(smokeRoot, 'settings.json');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmpSiblings = () => readdirSync(smokeRoot).filter((f) => f.includes('.tmp'));

// 1. Construction persists defaults immediately, as valid complete JSON.
{
  const store = new SettingsStore(settingsPath);
  const onDisk = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  assert.equal(onDisk.volume, 0.75, 'defaults must be persisted on construction');
  store.set({ volume: 0.5, lastfmSessionKey: 'sess-123' });

  // 2. set() is still synchronous/immediate: the NEW content is fully on disk
  //    the moment set() returns (no torn middle state).
  const afterSet = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  assert.equal(afterSet.volume, 0.5);
  assert.equal(afterSet.lastfmSessionKey, 'sess-123');
  assert.deepEqual(tmpSiblings(), [], 'sync persist must leave no temp sibling behind');
}

// 3. The debounced resumeState path also goes through a temp sibling, and
//    every state observed on disk during the write window parses as complete
//    JSON (old or new value, never a partial write).
{
  const store = new SettingsStore(settingsPath);
  let sawTmpSibling = false;
  const dirWatcher = watch(smokeRoot, (_event, fileName) => {
    if (fileName && fileName.includes('.tmp')) sawTmpSibling = true;
  });

  store.set({
    resumeState: { queueTrackIds: [1, 2, 3], index: 1, currentTime: 12.5, mode: 'normal', updatedAt: Date.now() },
  });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    // JSON.parse throws if we ever catch the file mid-write — that IS the
    // torn-write assertion.
    const snapshot = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (snapshot.resumeState?.currentTime === 12.5) break;
    if (tmpSiblings().length) sawTmpSibling = true;
    await sleep(10);
  }
  dirWatcher.close();

  assert.equal(
    JSON.parse(readFileSync(settingsPath, 'utf-8')).resumeState?.currentTime,
    12.5,
    'debounced persist must reach disk',
  );
  assert.ok(sawTmpSibling, 'async persist must be observable going through a temp sibling');
  await sleep(50);
  assert.deepEqual(tmpSiblings(), [], 'async persist must remove its temp sibling');
}

// A quit flush must preserve the only snapshot even when async persistence has
// already cleared dirty and no newer set() call happens before quitting.
{
  const file = join(smokeRoot, 'in-flight-only.json');
  const store = new SettingsStore(file);
  store.set({ resumeState: { queueTrackIds: [1], index: 0, currentTime: 123, mode: 'normal', updatedAt: 1 } });
  const pending = store.persistAsync();
  store.flushSync();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).resumeState.currentTime, 123);
  await pending;
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).resumeState.currentTime, 123, 'stale async completion cannot erase the final snapshot');
}

// 4. A stale temp sibling left by a simulated crashed process must be ignored
//    on startup (settings.json itself stays authoritative).
{
  writeFileSync(join(smokeRoot, 'settings.json.tmp-999999'), '{"volume":0', 'utf-8');
  const store = new SettingsStore(settingsPath);
  assert.equal(store.get().lastfmSessionKey, 'sess-123', 'stale temp must not leak into loaded settings');
  assert.equal(store.recoveryEvents.length, 0, 'a leftover temp sibling is not corruption');
  store.set({ volume: 0.6 });
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf-8')).volume, 0.6);
}

// 5. Genuinely corrupt settings.json is still quarantined (existing behavior
//    preserved alongside the atomic-write change).
{
  const corruptPath = join(smokeRoot, 'corrupt-settings.json');
  writeFileSync(corruptPath, '{"libraryRoots": [truncated', 'utf-8');
  const store = new SettingsStore(corruptPath);
  assert.equal(store.recoveryEvents.length, 1, 'unparseable settings should record one recovery event');
  assert.ok(store.recoveryEvents[0].backupPath.includes('.corrupt-'), 'bad file must be quarantined, kept as backup');
}

// 6. A quit-path synchronous persist while the debounced async persist is
//    still writing must not corrupt settings.json or strand a temp file. The two
//    writers used to share one `.tmp-<pid>` path (same collision library.db had):
//    the sync write could truncate the inode the async write still held, rename
//    it into place, and let the async bytes land inside the live file.
{
  const raceRoot = join(smokeRoot, 'race');
  await mkdir(raceRoot, { recursive: true });
  const racePath = join(raceRoot, 'settings.json');
  const store = new SettingsStore(racePath);
  store.set({ resumeState: { queueTrackIds: [7, 8, 9], index: 2, currentTime: 99.5, mode: 'normal', updatedAt: Date.now() } });
  const inFlight = store.persistAsync?.(); // start the debounced write now instead of waiting for its timer
  store.set({ volume: 0.42, lastfmSessionKey: 'race-key' }); // quit-path style synchronous write
  store.flushSync();
  await Promise.resolve(inFlight).catch(() => {});
  await sleep(250); // let any stray threadpool write land

  const onDisk = JSON.parse(readFileSync(racePath, 'utf-8')); // throws if the file is torn
  assert.equal(onDisk.volume, 0.42, 'the synchronous write must win');
  assert.equal(onDisk.lastfmSessionKey, 'race-key');
  assert.equal(onDisk.resumeState?.currentTime, 99.5, 'the earlier resumeState must not be lost either');
  const strays = readdirSync(raceRoot).filter((f) => f.includes('.tmp'));
  assert.deepEqual(strays, [], `no temp files should survive the race, found ${strays.join(', ')}`);

  // The property the race above can only sample: the two writers cannot pick
  // the same temp path in the first place.
  const settingsSrc = readFileSync(join(repoRoot, 'electron', 'settings.ts'), 'utf-8');
  const recoverySrc = readFileSync(join(repoRoot, 'electron', 'recovery.ts'), 'utf-8');
  assert.match(recoverySrc, /\.tmp-\$\{process\.pid\}-sync/, 'the synchronous writer needs its own temp suffix');
  assert.match(settingsSrc, /\.tmp-\$\{process\.pid\}-\$\{seq\}/, 'the async persist must use a per-persist temp path');
}

// 7. A short write from the OS must not be treated as complete: the durable
//    sync writer loops until every byte is on disk before it fsyncs.
{
  const recoverySrc = readFileSync(join(repoRoot, 'electron', 'recovery.ts'), 'utf-8');
  assert.match(recoverySrc, /while \(written < buf\.length\) \{\s*written \+= writeSync\(fd, buf, written, buf\.length - written\);/, 'durableWriteFileSync must loop on the bytes actually written');
  // And a rename that keeps failing must never fall back to truncating the
  // live target. The complete temp is the recovery artifact.
  assert.doesNotMatch(recoverySrc, /writing in place/, 'atomic replace must not fall back to writing the live target');
  assert.doesNotMatch(recoverySrc, /writeFileSync\(toPath, readFileSync\(fromPath\)\)/, 'the rename fallback must not be a plain in-place writeFileSync');
  assert.doesNotMatch(recoverySrc, /durableWriteFile(?:Sync|Async)\(toPath/, 'the rename fallback must not open the live target for write');
  assert.match(recoverySrc, /complete copy remains at \${fromPath}/, 'failed atomic replace should report the preserved complete temp');
}

// 8. When the replace cannot complete at all, the complete copy survives. The
//    destination here is a directory, so the replace fails; the temp file must
//    still be there afterwards and the error must say where it is.
{
  const stuckRoot = join(smokeRoot, 'stuck');
  const target = join(stuckRoot, 'settings.json');
  mkdirSync(target, { recursive: true }); // a directory where the file should be
  const payload = JSON.stringify({ volume: 0.33, libraryRoots: ['K:/music'] });
  let thrown = null;
  const started = Date.now();
  try {
    atomicWriteFileSync(target, payload);
  } catch (err) {
    thrown = err;
  }
  const elapsed = Date.now() - started;
  assert.ok(thrown, 'replacing a path that cannot be replaced must throw');
  assert.match(thrown.message, /complete copy is at/, 'the error must name the surviving copy');
  const survivor = `${target}.tmp-${process.pid}-sync`;
  assert.ok(existsSync(survivor), 'the temp file with the complete data must survive a failed replace');
  assert.equal(readFileSync(survivor, 'utf-8'), payload, 'the surviving copy must be the complete payload');
  assert.ok(elapsed < 3000, `the synchronous retry backoff must stay short, took ${elapsed}ms`);
}

// 9. The debounced settings path must preserve its completed temp snapshot
//    when the final replace exhausts transient rename retries. This catches an
//    unconditional `finally unlink(tmp)`, which deletes the only complete copy
//    of the failed async save.
{
  const failRoot = await mkdtemp(join(smokeRoot, 'settings-rename-fail-'));
  await build({
    entryPoints: ['electron/settings.ts'],
    outfile: join(failRoot, 'settings.mjs'),
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

  const { SettingsStore: FailingSettingsStore } = await import(pathToFileURL(join(failRoot, 'settings.mjs')));
  const failPath = join(failRoot, 'settings.json');
  const store = new FailingSettingsStore(failPath);
  store.set({
    resumeState: { queueTrackIds: [11, 12], index: 1, currentTime: 321.5, mode: 'normal', updatedAt: Date.now() },
  });
  if (store.persistTimer) {
    clearTimeout(store.persistTimer);
    store.persistTimer = null;
  }

  const transient = (target) => {
    const err = new Error(`locked ${target}`);
    err.code = 'EPERM';
    return err;
  };
  globalThis.__renameSyncOverride = (from, to, realRenameSync) => {
    if (to === failPath) throw transient(failPath);
    return realRenameSync(from, to);
  };
  globalThis.__fsRenameOverride = async (from, to, realFsRename) => {
    if (to === failPath) throw transient(failPath);
    return realFsRename(from, to);
  };

  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => {
    loggedErrors.push(args);
  };
  try {
    await Promise.resolve(store.persistAsync?.()).catch(() => {});
  } finally {
    console.error = originalConsoleError;
    delete globalThis.__renameSyncOverride;
    delete globalThis.__fsRenameOverride;
  }

  const onDisk = JSON.parse(readFileSync(failPath, 'utf-8'));
  assert.equal(onDisk.resumeState, null, 'failed async replace must leave the live settings file untouched');
  assert.match(
    String(loggedErrors[0]?.[1]?.message ?? loggedErrors[0]?.join(' ') ?? ''),
    /complete copy remains/,
    'failed async replace should surface the preserved temp path in its error',
  );
  const survivors = readdirSync(failRoot).filter((file) => file.startsWith(`settings.json.tmp-${process.pid}-`) && !file.endsWith('-retry'));
  assert.equal(survivors.length, 1, `failed async replace should preserve exactly one complete temp, found ${survivors.join(', ')}`);
  const survivor = JSON.parse(readFileSync(join(failRoot, survivors[0]), 'utf-8'));
  assert.equal(survivor.resumeState?.currentTime, 321.5, 'the preserved async temp must contain the complete failed payload');
  assert.equal(existsSync(`${failPath}.tmp-${process.pid}-retry`), false, 'failed async retry temp should be cleaned');
}

await rm(smokeRoot, { recursive: true, force: true });
console.log('[settings-atomic-test] PASS: atomic settings persistence verified');
