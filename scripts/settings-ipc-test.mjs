// Settings and recovery hardening, run against the sources directly (no build):
//  - a queue longer than the resume cap keeps the window around the playing track
//  - libraryRoots, volume, crossfade, theme, replay gain and the Last.fm fields are
//    normalized on load and on every patch, and unknown keys are dropped
//  - a corrupt settings.json is replaced by the last good copy or the newest daily
//    backup before defaults; a JSON null or list is corrupt too
//  - in-session patches made while the file was unreadable survive the lift
//  - a failed write keeps the change in memory instead of throwing
//  - network-share read errors suppress saving rather than crash startup, and
//    EACCES is not retried
//  - orphaned temp files are swept, files are created owner-only
//  - restore refuses a settings.json that is not an object; daily backup can defer
// Run: node scripts/settings-ipc-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp/settings-ipc-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const entry = join(root, 'entry.ts');
writeFileSync(
  entry,
  [
    `export { SettingsStore } from '../../electron/settings';`,
    `export { atomicWriteFileSync, isUnreadableFileError, readFileSyncRetrying, sweepOrphanedTempFiles } from '../../electron/recovery';`,
    `export { createDailyBackupIfDue, createSupportBackup, restoreSupportBackup } from '../../electron/support-backup';`,
  ].join('\n'),
);
const outfile = join(root, 'bundle.mjs');
await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', target: 'es2022', packages: 'external', logLevel: 'silent' });
const {
  SettingsStore,
  atomicWriteFileSync,
  isUnreadableFileError,
  readFileSyncRetrying,
  sweepOrphanedTempFiles,
  createDailyBackupIfDue,
  createSupportBackup,
  restoreSupportBackup,
} = await import(pathToFileURL(outfile).href);

const onDisk = (file) => JSON.parse(readFileSync(file, 'utf-8'));
let dirId = 0;
function freshDir() {
  const dir = join(root, `case-${(dirId += 1)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function errno(code) {
  const err = new Error(`fixture ${code}`);
  err.code = code;
  return err;
}

// ---- resume queue window (ipc-settings-2, -3) ----
const local = (n) => Array.from({ length: n }, (_, i) => ({ kind: 'local', trackId: i + 1 }));
const resume = (extra) => ({ queueTrackIds: [], index: 0, currentTime: 41, mode: 'shuffle', updatedAt: 1, ...extra });
{
  const store = new SettingsStore(join(freshDir(), 'settings.json'));
  const queue = local(6000);
  store.set({ resumeState: resume({ queue, queueTrackIds: queue.map((e) => e.trackId), index: 5500, currentTrackId: 5501 }) });
  const saved = store.get().resumeState;
  assert.equal(saved.queue.length, 5000, 'the queue is cut to the cap');
  assert.equal(saved.queue[saved.index].trackId, 5501, 'the index still points at the track that was playing');
  assert.equal(saved.currentTrackId, 5501, 'the current track id survives');
  assert.equal(saved.queueTrackIds.length, 5000);
  assert.equal(saved.currentTime, 41);

  const big = local(57000);
  store.set({ resumeState: resume({ queue: big, index: 12000, currentTrackId: 12001 }) });
  const mid = store.get().resumeState;
  assert.equal(mid.queue[mid.index].trackId, 12001, 'a 57k queue keeps the playing track in the middle of the library');
  assert.ok(mid.index > 0 && mid.index < mid.queue.length - 1, 'the playing track sits inside the window, not at an edge');

  store.set({ resumeState: resume({ queue: big, index: 0, currentTrackId: 1 }) });
  assert.equal(store.get().resumeState.index, 0, 'a queue at its head keeps its head');
  store.set({ resumeState: resume({ queue: big, index: 56999, currentTrackId: 57000 }) });
  const tail = store.get().resumeState;
  assert.equal(tail.queue[tail.index].trackId, 57000, 'a queue at its tail keeps its tail');
  store.set({ resumeState: resume({ queue: big, index: -1 }) });
  assert.equal(store.get().resumeState.index, -1, 'nothing current stays nothing current');
}
{
  // A queue within the cap is untouched, and a legacy ids-only queue is windowed too.
  const store = new SettingsStore(join(freshDir(), 'settings.json'));
  store.set({ resumeState: resume({ queue: local(10), index: 7, currentTrackId: 8 }) });
  assert.equal(store.get().resumeState.index, 7);
  assert.equal(store.get().resumeState.queue.length, 10);
  const ids = Array.from({ length: 9000 }, (_, i) => i + 1);
  store.set({ resumeState: resume({ queueTrackIds: ids, index: 8000, currentTrackId: 8001 }) });
  const legacy = store.get().resumeState;
  assert.equal(legacy.queue[legacy.index].trackId, 8001, 'an ids-only queue is windowed around the index');
}
{
  const dir = freshDir();
  const file = join(dir, 'settings.json');
  const store = new SettingsStore(file);
  store.set({ resumeState: resume({ queue: local(6000), index: 5500, currentTrackId: 5501 }) });
  store.flushSync();
  const again = new SettingsStore(file).get().resumeState;
  assert.equal(again.queue[again.index].trackId, 5501, 'a reload of the saved window restores the same track');
}

// ---- normalizers (ipc-settings-5) ----
{
  const file = join(freshDir(), 'settings.json');
  const store = new SettingsStore(file);
  store.set({
    libraryRoots: ['/Users/x/Music', '/Users/x/Music', 'relative/dir', '', 5, null, 'K:/music', '/bad\0path'],
    volume: 7,
    crossfadeMs: 999999,
    replayGain: 'loud',
    theme: 'not-a-theme',
    eqEnabled: 'yes',
    lastfmEnabled: 1,
    lastfmApiKey: 42,
    lastfmSessionKey: '  abc  ',
    radioBrainEnabled: 'true',
    audioBitPerfectPath: 1,
    bogusKey: 'x',
  });
  const state = store.get();
  assert.deepEqual(state.libraryRoots, ['/Users/x/Music', 'K:/music'], 'roots are absolute strings, deduped');
  assert.equal(state.volume, 2, 'volume is clamped to the boost range');
  assert.equal(state.crossfadeMs, 12000);
  assert.equal(state.replayGain, 'off');
  assert.equal(state.theme, 'classic', 'an unknown theme falls back');
  assert.equal(state.eqEnabled, false);
  assert.equal(state.lastfmEnabled, false);
  assert.equal(state.lastfmApiKey, null);
  assert.equal(state.lastfmSessionKey, 'abc');
  assert.equal(state.radioBrainEnabled, false);
  assert.equal(state.audioBitPerfectPath, false);
  assert.equal('bogusKey' in state, false);
  assert.equal('bogusKey' in onDisk(file), false, 'unknown keys never reach the file');

  store.set({ libraryRoots: 'not-an-array', volume: 'loud', crossfadeMs: 'x', theme: 'amber' });
  assert.deepEqual(store.get().libraryRoots, [], 'a non-array root list empties instead of poisoning the authorizer');
  assert.equal(store.get().volume, 2, 'a junk volume keeps the previous one');
  assert.equal(store.get().crossfadeMs, 12000);
  assert.equal(store.get().theme, 'amber');
  store.set({ volume: 0.5, replayGain: 'album', theme: 'custom' });
  assert.deepEqual([store.get().volume, store.get().replayGain, store.get().theme], [0.5, 'album', 'custom']);
}
{
  const file = join(freshDir(), 'settings.json');
  writeFileSync(
    file,
    JSON.stringify({ libraryRoots: '/', volume: 9, crossfadeMs: -5, theme: 'zzz', replayGain: 3, lastfmApiKey: {}, extra: 1, eqEnabled: 'x' }),
  );
  const state = new SettingsStore(file).get();
  assert.deepEqual(state.libraryRoots, [], 'a hand-edited roots string does not authorize the disk');
  assert.equal(state.volume, 2);
  assert.equal(state.crossfadeMs, 0);
  assert.equal(state.theme, 'classic');
  assert.equal(state.replayGain, 'off');
  assert.equal(state.lastfmApiKey, null);
  assert.equal('extra' in state, false);
  assert.equal(state.eqEnabled, false);
}

// ---- defaults are not shared (ipc-settings-17) ----
{
  const first = new SettingsStore(join(freshDir(), 'settings.json'));
  first.get().libraryRoots.push('/mutated');
  assert.deepEqual(first.get().libraryRoots, [], 'get() hands out a copy of the roots');
  first.set({ libraryRoots: ['/a'] });
  const second = new SettingsStore(join(freshDir(), 'settings.json'));
  assert.deepEqual(second.get().libraryRoots, [], 'a second store starts from untouched defaults');
  assert.notEqual(first.get().windowState, second.get().windowState);
}

// ---- corrupt settings recovery (ipc-settings-8) ----
{
  const dir = freshDir();
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ volume: 0.31, theme: 'amber', libraryRoots: ['/Users/x/Music'] }));
  new SettingsStore(file);
  assert.ok(existsSync(`${file}.last-good`), 'a clean load keeps a last-good copy');

  writeFileSync(file, '{"volume": 0.9, "theme": ');
  const store = new SettingsStore(file);
  assert.equal(store.get().volume, 0.31, 'the last good copy is used instead of defaults');
  assert.deepEqual(store.get().libraryRoots, ['/Users/x/Music']);
  assert.equal(store.recoveryEvents.length, 1);
  assert.match(store.recoveryEvents[0].reason, /restored from .*settings\.json\.last-good/);
  assert.equal(onDisk(file).theme, 'amber', 'the recovered state is written back');
  assert.ok(readdirSync(dir).some((name) => name.startsWith('settings.json.corrupt-')), 'the corrupt file is still quarantined');

  // JSON null and a list are corrupt, not silently adopted.
  writeFileSync(file, 'null');
  assert.equal(new SettingsStore(file).get().volume, 0.31);
  writeFileSync(file, '[1,2]');
  assert.equal(new SettingsStore(file).get().theme, 'amber');
}
{
  const dir = freshDir();
  const file = join(dir, 'settings.json');
  mkdirSync(join(dir, 'backups', 'newamp-daily-20261001-090000'), { recursive: true });
  mkdirSync(join(dir, 'backups', 'newamp-daily-20261002-090000'), { recursive: true });
  writeFileSync(join(dir, 'backups', 'newamp-daily-20261001-090000', 'settings.json'), JSON.stringify({ volume: 0.11 }));
  writeFileSync(join(dir, 'backups', 'newamp-daily-20261002-090000', 'settings.json'), JSON.stringify({ volume: 0.22, theme: 'ice' }));
  writeFileSync(file, 'garbage');
  const store = new SettingsStore(file);
  assert.equal(store.get().volume, 0.22, 'without a last-good copy the newest daily backup is used');
  assert.equal(store.get().theme, 'ice');
  assert.match(store.recoveryEvents[0].reason, /newamp-daily-20261002-090000/);

  const empty = join(freshDir(), 'settings.json');
  writeFileSync(empty, 'garbage');
  const defaults = new SettingsStore(empty);
  assert.equal(defaults.get().volume, 0.75, 'with nothing to recover from the defaults apply');
  assert.doesNotMatch(defaults.recoveryEvents[0].reason, /restored from/);
}

// ---- patches made while the file was unreadable (ipc-settings-10) ----
{
  const file = join(freshDir(), 'settings.json');
  writeFileSync(file, JSON.stringify({ volume: 0.42, theme: 'amber', libraryRoots: ['/Users/x/Music'] }));
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (p, ...rest) => {
    if (String(p) === file && (reads += 1) <= 5) throw errno('EBUSY'); // 4 startup attempts, then the first lift attempt
    return realRead.call(fs, p, ...rest);
  };
  syncBuiltinESMExports();
  const realNow = performance.now.bind(performance);
  try {
    const store = new SettingsStore(file);
    assert.equal(store.isSuppressed(), true);
    store.set({ volume: 0.9 });
    assert.equal(store.isSuppressed(), true, 'still locked on the first attempt');
    performance.now = () => realNow() + 11_000;
    store.set({ crossfadeMs: 1200 });
    assert.equal(store.isSuppressed(), false, 'the lift succeeds after the cooldown');
    const state = store.get();
    assert.equal(state.theme, 'amber', 'the real file is loaded');
    assert.equal(state.volume, 0.9, 'the change made while locked is laid over it');
    assert.equal(state.crossfadeMs, 1200);
    assert.deepEqual(state.libraryRoots, ['/Users/x/Music']);
    assert.equal(onDisk(file).volume, 0.9);
  } finally {
    fs.readFileSync = realRead;
    syncBuiltinESMExports();
    performance.now = realNow;
  }
}

// ---- a failed write is kept in memory (ipc-settings-11) ----
{
  const dir = freshDir();
  const file = join(dir, 'settings.json');
  const store = new SettingsStore(file);
  const realOpen = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (String(p).startsWith(file)) throw errno('ENOSPC');
    return realOpen.call(fs, p, ...rest);
  };
  syncBuiltinESMExports();
  try {
    let result;
    assert.doesNotThrow(() => {
      result = store.set({ theme: 'terminal' });
    }, 'a failed write does not reject the caller');
    assert.equal(result.theme, 'terminal');
    assert.equal(store.get().theme, 'terminal', 'main keeps the value it applied');
  } finally {
    fs.openSync = realOpen;
    syncBuiltinESMExports();
  }
  store.flushSync();
  assert.equal(onDisk(file).theme, 'terminal', 'the change lands once the disk accepts writes again');
}
{
  // An unwritable profile no longer takes down the constructor.
  const dir = freshDir();
  const realOpen = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (String(p).startsWith(dir)) throw errno('EROFS');
    return realOpen.call(fs, p, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const store = new SettingsStore(join(dir, 'settings.json'));
    assert.equal(store.get().volume, 0.75);
    fs.openSync = realOpen;
    syncBuiltinESMExports();
    store.flushSync();
    assert.equal(onDisk(join(dir, 'settings.json')).volume, 0.75, 'the deferred first write lands on the next flush');
  } finally {
    fs.openSync = realOpen;
    syncBuiltinESMExports();
  }
}

// ---- storage read errors and EACCES (ipc-settings-19) ----
for (const code of ['ETIMEDOUT', 'ENOTCONN', 'ESTALE', 'ENXIO', 'EIO', 'EACCES']) {
  assert.equal(isUnreadableFileError(errno(code)), true, `${code} is an unreadable-file error`);
}
assert.equal(isUnreadableFileError(errno('ENOENT')), false);
{
  const file = join(freshDir(), 'settings.json');
  writeFileSync(file, JSON.stringify({ volume: 0.4 }));
  const realRead = fs.readFileSync;
  for (const [code, expectedCalls] of [['ETIMEDOUT', 1], ['EACCES', 1], ['EBUSY', 4]]) {
    let calls = 0;
    fs.readFileSync = (p, ...rest) => {
      if (String(p) === file) {
        calls += 1;
        throw errno(code);
      }
      return realRead.call(fs, p, ...rest);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => readFileSyncRetrying(file), (err) => err.code === code);
      assert.equal(calls, expectedCalls, `${code} is attempted ${expectedCalls} time(s)`);
      calls = 0;
      const store = new SettingsStore(file);
      assert.equal(store.isSuppressed(), true, `${code} at startup suppresses saving instead of crashing`);
      assert.equal(store.recoveryEvents.length, 1);
    } finally {
      fs.readFileSync = realRead;
      syncBuiltinESMExports();
    }
  }
  assert.equal(onDisk(file).volume, 0.4, 'the untouched original is never written over');
}

// ---- temp files: sweep, error text, owner-only mode (ipc-settings-12, -7) ----
{
  const dir = freshDir();
  const old = new Date(Date.now() - 10 * 60_000);
  const stale = join(dir, 'podcasts.json.tmp-424242-7');
  const staleLibrary = join(dir, 'library.db.tmp-424242-7');
  const staleSync = join(dir, 'settings.json.tmp-424242-sync');
  const fresh = join(dir, 'library.db.tmp-424243-8');
  const mine = join(dir, `library.db.tmp-${process.pid}-9`);
  const keep = join(dir, 'settings.json.last-good');
  const unrelated = join(dir, 'notes.tmp-draft');
  for (const path of [stale, staleLibrary, staleSync, fresh, mine, keep, unrelated]) writeFileSync(path, 'x');
  for (const path of [stale, staleLibrary, staleSync, mine, keep, unrelated]) utimesSync(path, old, old);
  const removed = sweepOrphanedTempFiles(dir);
  assert.deepEqual(removed.sort(), [stale, staleSync].sort());
  assert.deepEqual(
    [fresh, mine, keep, unrelated, staleLibrary].map((path) => existsSync(path)),
    [true, true, true, true, true],
    'recent files, this process\'s own, unrelated names and the library\'s temps stay',
  );
  assert.deepEqual(sweepOrphanedTempFiles(join(dir, 'missing')), [], 'a missing folder is not an error');

  // A SettingsStore starting up sweeps its own folder.
  const orphan = join(dir, 'settings.json.tmp-515151-3');
  writeFileSync(orphan, 'x');
  utimesSync(orphan, old, old);
  new SettingsStore(join(dir, 'settings.json'));
  assert.equal(existsSync(orphan), false, 'startup removes an orphaned temp file');
}
{
  const dir = freshDir();
  const target = join(dir, 'out.json');
  atomicWriteFileSync(target, '{}');
  if (process.platform !== 'win32') assert.equal(statSync(target).mode & 0o777, 0o600, 'files are written owner-only');
  const missing = join(dir, 'no-such-folder', 'out.json');
  assert.throws(() => atomicWriteFileSync(missing, '{}'), (err) => /left unchanged/.test(err.message) && !/complete copy/.test(err.message));
  assert.equal(existsSync(`${missing}.tmp-${process.pid}-sync`), false);
  // A rename that fails after a complete write still names the surviving copy.
  const asDirectory = join(dir, 'blocked.json');
  mkdirSync(asDirectory);
  assert.throws(() => atomicWriteFileSync(asDirectory, '{}'), /complete copy is at/);
}

// ---- restore and daily backup (ipc-settings-18, -1) ----
{
  const userDataPath = freshDir();
  const settingsPath = join(userDataPath, 'settings.json');
  const libraryPath = join(userDataPath, 'library.db');
  writeFileSync(settingsPath, JSON.stringify({ theme: 'amber' }));
  for (const bad of ['null', '[1]', '5']) {
    const made = await createSupportBackup({ userDataPath, settingsPath, libraryPath, settingsSnapshot: bad });
    await assert.rejects(
      () => restoreSupportBackup({ userDataPath, settingsPath, libraryPath, backupPath: made.backupPath }),
      /not a settings object/,
      `a backup whose settings.json is ${bad} is refused`,
    );
    assert.equal(onDisk(settingsPath).theme, 'amber', 'nothing live is displaced');
  }
  const good = await createSupportBackup({ userDataPath, settingsPath, libraryPath, settingsSnapshot: '{"theme":"ice"}' });
  await restoreSupportBackup({ userDataPath, settingsPath, libraryPath, backupPath: good.backupPath });
  assert.equal(onDisk(settingsPath).theme, 'ice', 'an object settings.json still restores');
}
{
  const userDataPath = freshDir();
  const settingsPath = join(userDataPath, 'settings.json');
  const libraryPath = join(userDataPath, 'library.db');
  writeFileSync(settingsPath, '{}');
  let snapshots = 0;
  const outcome = await createDailyBackupIfDue({
    userDataPath,
    settingsPath,
    libraryPath,
    freeBytes: async () => null,
    defer: () => true,
    snapshot: () => {
      snapshots += 1;
      return { librarySnapshot: Buffer.alloc(0), settingsSnapshot: '{}' };
    },
  });
  assert.deepEqual(outcome, { status: 'skipped', reason: 'deferred' });
  assert.equal(snapshots, 0, 'a deferred backup takes no snapshot');
}

// ---- slider drags are debounced, not written per input event ----
{
  const dir = freshDir();
  const file = join(dir, 'settings.json');
  const store = new SettingsStore(file);
  store.set({ theme: 'terminal' });
  assert.equal(onDisk(file).theme, 'terminal', 'an ordinary setting is on disk when set() returns');
  store.set({ preampDb: 3 });
  store.set({ textScale: 1.2 });
  assert.notEqual(onDisk(file).preampDb, 3, 'a preamp drag is not written per event');
  assert.notEqual(onDisk(file).textScale, 1.2, 'a text size drag is not written per event');
  assert.equal(store.get().preampDb, 3, 'the preamp change is live in memory');
  store.flushSync();
  assert.equal(onDisk(file).preampDb, 3, 'quit flushes the pending preamp');
  assert.equal(onDisk(file).textScale, 1.2, 'quit flushes the pending text size');
}

await rm(root, { recursive: true, force: true });
console.log('PASS settings/ipc hardening: resume window, normalizers, last-good recovery, pending patches, failed writes, storage errors, temp sweep, restore check');
