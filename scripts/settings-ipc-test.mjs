// Settings and recovery hardening, run against the sources directly (no build):
//  - a queue longer than the resume cap keeps the window around the playing track
//  - libraryRoots, volume, crossfade, theme, replay gain and the Last.fm fields are
//    normalized on load and on every patch, and unknown keys are dropped; roots
//    that are not a list keep the folders as they were, and entries that cannot be
//    folders are noted without replacing the last-good copy
//  - every key of AppSettings is one the store keeps
//  - a corrupt settings.json is replaced by the last good copy or the newest daily
//    backup before defaults, also when it only becomes readable mid-session; a
//    JSON null or list is corrupt too
//  - in-session patches made while the file was unreadable survive the lift
//  - a failed write keeps the change in memory instead of throwing, is reported
//    once per run of failures, and is retried with a growing wait
//  - network-share read errors suppress saving rather than crash startup, and
//    EACCES is not retried
//  - orphaned temp files are swept, files are created owner-only
//  - restore refuses a settings.json that is not an object; daily backup can defer
// Run: node scripts/settings-ipc-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import fsp, { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';
import ts from 'typescript';

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
  assert.deepEqual(store.get().libraryRoots, ['/Users/x/Music', 'K:/music'], 'a root list that is not a list leaves the folders as they were');
  store.set({ libraryRoots: null });
  assert.deepEqual(store.get().libraryRoots, ['/Users/x/Music', 'K:/music'], 'so does null');
  assert.equal(store.get().volume, 2, 'a junk volume keeps the previous one');
  assert.equal(store.get().crossfadeMs, 12000);
  assert.equal(store.get().theme, 'amber');
  store.set({ volume: 0.5, replayGain: 'album', theme: 'custom' });
  assert.deepEqual([store.get().volume, store.get().replayGain, store.get().theme], [0.5, 'album', 'custom']);
  store.set({ libraryRoots: [] });
  assert.deepEqual(store.get().libraryRoots, [], 'an empty list does clear them');
}
{
  const file = join(freshDir(), 'settings.json');
  writeFileSync(
    file,
    JSON.stringify({ libraryRoots: '/', volume: 9, crossfadeMs: -5, theme: 'zzz', replayGain: 3, lastfmApiKey: {}, extra: 1, eqEnabled: 'x' }),
  );
  const store = new SettingsStore(file);
  const state = store.get();
  assert.deepEqual(state.libraryRoots, [], 'a hand-edited roots string does not authorize the disk');
  assert.equal(state.volume, 2);
  assert.equal(state.crossfadeMs, 0);
  assert.equal(state.theme, 'classic');
  assert.equal(state.replayGain, 'off');
  assert.equal(state.lastfmApiKey, null);
  assert.equal('extra' in state, false);
  assert.equal(state.eqEnabled, false);
  assert.equal(store.recoveryEvents.length, 1, 'the folders that were left out are on record');
  assert.match(store.recoveryEvents[0].reason, /library folders ignored/);
  assert.equal(store.recoveryEvents[0].backupPath, file, 'the file itself is untouched');
}
{
  // Entries that cannot be folders are dropped one by one; the rest are kept,
  // and the last-good copy still holds what the edit lost.
  const dir = freshDir();
  const file = join(dir, 'settings.json');
  const good = JSON.stringify({ libraryRoots: ['/Users/x/Music', '/Users/x/More'], theme: 'amber' });
  writeFileSync(file, good);
  new SettingsStore(file);
  assert.equal(readFileSync(`${file}.last-good`, 'utf-8'), good, 'a clean load keeps the file as its last-good copy');

  writeFileSync(file, JSON.stringify({ libraryRoots: ['~/Music', '/Users/x/Music', 'relative/dir', 7], volume: 0.4 }));
  const store = new SettingsStore(file);
  assert.deepEqual(store.get().libraryRoots, ['/Users/x/Music'], 'the entry that is a folder is kept');
  assert.equal(store.get().volume, 0.4, 'and so is every other field');
  assert.equal(store.recoveryEvents.length, 1);
  assert.match(store.recoveryEvents[0].reason, /"~\/Music".*"relative\/dir".*number/);
  assert.equal(readFileSync(`${file}.last-good`, 'utf-8'), good, 'the copy that has the folders is not replaced by one without them');
}

// ---- every setting the app defines is one the store keeps ----
{
  // A key missing from the store's defaults is dropped on load and on every
  // patch, so the next setting added to the interface needs its default too.
  const typesFile = ts.createSourceFile('types.ts', readFileSync(resolve('shared/types.ts'), 'utf-8'), ts.ScriptTarget.ES2022, true);
  const declared = [];
  typesFile.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== 'AppSettings') return;
    for (const member of node.members) {
      if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) declared.push(member.name.text);
    }
  });
  assert.ok(declared.length > 30, 'the AppSettings keys were found');
  const kept = Object.keys(new SettingsStore(join(freshDir(), 'settings.json')).get());
  // aiAssistRuntime is worked out when settings are read and is never stored.
  assert.deepEqual(kept.sort(), declared.filter((key) => key !== 'aiAssistRuntime').sort());
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

// ---- a replace that failed in an earlier session leaves a newer whole copy ----
{
  const minutesAgo = (n) => new Date(Date.now() - n * 60_000);
  const put = (path, content, ageMin) => {
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
    utimesSync(path, minutesAgo(ageMin), minutesAgo(ageMin));
  };

  // Older settings.json, newer unsaved copy beside it: the copy's values load.
  {
    const dir = freshDir();
    const file = join(dir, 'settings.json');
    put(file, { volume: 0.31, theme: 'amber', libraryRoots: ['/Users/x/Music'] }, 30);
    const temp = join(dir, 'settings.json.tmp-424242-sync');
    put(temp, { volume: 0.77, theme: 'ice', libraryRoots: ['/Users/x/Music', '/Users/x/More'] }, 10);
    const store = new SettingsStore(file);
    assert.equal(store.get().volume, 0.77, 'the newer copy is the one that loads');
    assert.equal(store.get().theme, 'ice');
    assert.deepEqual(store.get().libraryRoots, ['/Users/x/Music', '/Users/x/More']);
    assert.equal(onDisk(file).volume, 0.77, 'and it is written into place');
    assert.equal(store.recoveryEvents.length, 1);
    assert.equal(store.recoveryEvents[0].backupPath, temp);
    assert.match(store.recoveryEvents[0].reason, /restored from an unsaved copy/);
    assert.ok(existsSync(temp), 'the copy stays for the next launch to sweep');
  }

  // No settings.json at all: a first write that never landed.
  {
    const dir = freshDir();
    const file = join(dir, 'settings.json');
    put(join(dir, 'settings.json.tmp-424242-3'), { volume: 0.64 }, 10);
    const store = new SettingsStore(file);
    assert.equal(store.get().volume, 0.64);
    assert.equal(onDisk(file).volume, 0.64);
  }

  // A corrupt settings.json takes the unsaved copy before the last-good one.
  {
    const dir = freshDir();
    const file = join(dir, 'settings.json');
    put(`${file}.last-good`, { volume: 0.31, theme: 'amber' }, 60);
    put(file, '{"volume": 0.9, "the', 30);
    put(join(dir, 'settings.json.tmp-424242-sync'), { volume: 0.55, theme: 'ice' }, 10);
    const store = new SettingsStore(file);
    assert.equal(store.get().volume, 0.55);
    assert.equal(store.get().theme, 'ice');
    assert.equal(store.recoveryEvents.length, 1, 'one notice, not one for the copy as well');
    assert.match(store.recoveryEvents[0].reason, /restored from .*settings\.json\.tmp-424242-sync/);
  }

  // The copy goes through the same checks as any settings file, field by field.
  {
    const dir = freshDir();
    const file = join(dir, 'settings.json');
    put(file, { volume: 0.31 }, 30);
    put(join(dir, 'settings.json.tmp-424242-sync'), { volume: 9, theme: 'zzz', libraryRoots: ['relative/dir', '/Users/x/Music'], bogus: 1 }, 10);
    const store = new SettingsStore(file);
    assert.equal(store.get().volume, 2);
    assert.equal(store.get().theme, 'classic');
    assert.deepEqual(store.get().libraryRoots, ['/Users/x/Music']);
    assert.equal('bogus' in onDisk(file), false);
  }

  // A settings.json this process has just written is newer than any copy an
  // earlier session left, whatever the sweep makes of that copy.
  {
    const dir = freshDir();
    const file = join(dir, 'settings.json');
    put(file, { volume: 0.31 }, 0);
    const temp = join(dir, 'settings.json.tmp-424242-sync');
    put(temp, { volume: 0.77 }, 10);
    const store = new SettingsStore(file);
    assert.equal(store.get().volume, 0.31, 'the copy is older than the file, so the file stands');
    assert.deepEqual(store.recoveryEvents.map((event) => event.backupPath), [temp], 'and the copy is listed as kept');
  }

  // Copies that are not used are kept and listed; ones the file has passed are swept.
  {
    const dir = freshDir();
    const file = join(dir, 'settings.json');
    put(file, { volume: 0.31 }, 30);
    const notSettings = join(dir, 'settings.json.tmp-424242-4');
    const lastGoodCopy = join(dir, 'settings.json.last-good.tmp-424242-sync');
    const podcasts = join(dir, 'podcasts.json.tmp-424242-sync');
    const behind = join(dir, 'settings.json.tmp-515151-sync');
    put(notSettings, '[1,2]', 10);
    put(lastGoodCopy, { volume: 0.2 }, 10);
    put(podcasts, { subscriptions: [] }, 10);
    put(behind, { volume: 0.1 }, 90);
    const store = new SettingsStore(file);
    assert.equal(store.get().volume, 0.31, 'a copy that is not settings does not replace them');
    assert.equal(existsSync(behind), false, 'a copy older than the file is swept');
    const kept = store.recoveryEvents.map((event) => [event.store, event.filePath, event.backupPath]).sort();
    assert.deepEqual(kept, [
      ['podcasts', join(dir, 'podcasts.json'), podcasts],
      ['settings', file, notSettings],
      ['settings', `${file}.last-good`, lastGoodCopy],
    ].sort());
    for (const event of store.recoveryEvents) assert.match(event.reason, /unsaved copy of this file from an earlier session was kept/);
    for (const path of [notSettings, lastGoodCopy, podcasts]) assert.ok(existsSync(path), 'and left where they are');
  }
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

// ---- a file that turns readable but corrupt takes the last-good copy, not defaults ----
{
  const dir = freshDir();
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ volume: 0.42 }));
  writeFileSync(`${file}.last-good`, JSON.stringify({ volume: 0.31, theme: 'amber', libraryRoots: ['/Users/x/Music'] }));
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (p, ...rest) => {
    if (String(p) === file && (reads += 1) <= 4) throw errno('EBUSY'); // the startup attempts
    return realRead.call(fs, p, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const store = new SettingsStore(file);
    assert.equal(store.isSuppressed(), true);
    writeFileSync(file, '{"volume": 0.9, "theme": ');
    store.set({ crossfadeMs: 1200 });
    assert.equal(store.isSuppressed(), false, 'the lift goes ahead on the unusable file');
    const state = store.get();
    assert.equal(state.volume, 0.31, 'the last good copy is used instead of defaults');
    assert.equal(state.theme, 'amber');
    assert.deepEqual(state.libraryRoots, ['/Users/x/Music']);
    assert.equal(state.crossfadeMs, 1200, 'and the change made after it is laid on top');
    assert.match(store.recoveryEvents.at(-1).reason, /restored from .*settings\.json\.last-good/);
    assert.ok(readdirSync(dir).some((name) => name.startsWith('settings.json.corrupt-')), 'the corrupt file is kept aside');
    assert.equal(onDisk(file).volume, 0.31);
  } finally {
    fs.readFileSync = realRead;
    syncBuiltinESMExports();
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

// ---- a write that fails is reported once, and again only after one has landed ----
{
  const file = join(freshDir(), 'settings.json');
  const heard = [];
  const store = new SettingsStore(file, (event) => heard.push(event));
  const realOpen = fs.openSync;
  const breakDisk = () => {
    fs.openSync = (p, ...rest) => {
      if (String(p).startsWith(file)) throw errno('ENOSPC');
      return realOpen.call(fs, p, ...rest);
    };
    syncBuiltinESMExports();
  };
  const mendDisk = () => {
    fs.openSync = realOpen;
    syncBuiltinESMExports();
  };
  try {
    breakDisk();
    store.set({ theme: 'terminal' });
    assert.equal(heard.length, 1, 'the first failed write is reported');
    assert.equal(heard[0].store, 'settings');
    assert.match(heard[0].reason, /ENOSPC/);
    assert.equal(heard[0].backupPath, file, 'nothing was moved aside: the file is as it was');
    store.set({ theme: 'amber' });
    store.set({ lastfmEnabled: true });
    assert.equal(heard.length, 1, 'the rest of the run is not reported again');
    assert.equal(store.recoveryEvents.length, 1, 'it is on record for the diagnostics once');
    mendDisk();
    store.set({ theme: 'ice' });
    assert.equal(onDisk(file).theme, 'ice', 'a write that lands ends the run');
    breakDisk();
    store.set({ theme: 'terminal' });
    assert.equal(heard.length, 2, 'a failure after that is a new run');
  } finally {
    mendDisk();
  }
  store.flushSync();
}
{
  // The debounced write is tried again after it fails, each time later, and
  // goes back to its usual wait once a write lands.
  const file = join(freshDir(), 'settings.json');
  const heard = [];
  const store = new SettingsStore(file, (event) => heard.push(event));
  const realOpen = fsp.open;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, ms) => {
    const timer = { fn, ms };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    const at = timers.indexOf(timer);
    if (at !== -1) timers.splice(at, 1);
  };
  const fire = async () => {
    timers.shift().fn();
    await store.waitForPendingWrites();
  };
  try {
    store.set({ preampDb: 3 });
    assert.deepEqual(timers.map((timer) => timer.ms), [800], 'a hot patch is written after the usual wait');
    fsp.open = async () => {
      throw errno('ENOSPC');
    };
    syncBuiltinESMExports();
    const waits = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await fire();
      waits.push(timers.map((timer) => timer.ms));
    }
    assert.deepEqual(waits.flat(), [800, 1600, 3200, 6400, 12800, 25600, 30000, 30000], 'each failure doubles the wait, up to half a minute');
    assert.equal(heard.length, 1, 'the run is reported once');
    fsp.open = realOpen;
    syncBuiltinESMExports();
    await fire();
    assert.equal(onDisk(file).preampDb, 3, 'the retry lands the change');
    assert.equal(timers.length, 0, 'and nothing is left waiting');
    store.set({ preampDb: 4 });
    assert.deepEqual(timers.map((timer) => timer.ms), [800], 'the wait is back to normal');
  } finally {
    fsp.open = realOpen;
    syncBuiltinESMExports();
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  store.flushSync();
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
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  database.run('create table t (x)');
  const librarySnapshot = Buffer.from(database.export());
  database.close();
  let snapshots = 0;
  const options = {
    userDataPath,
    settingsPath,
    libraryPath,
    freeBytes: async () => null,
    defer: () => true,
    snapshot: () => {
      snapshots += 1;
      return { librarySnapshot, settingsSnapshot: '{}' };
    },
  };
  // A copy waits for playback only when an older one exists to fall back on.
  const first = await createDailyBackupIfDue({ ...options, now: new Date(2026, 9, 1, 9) });
  assert.equal(first.status, 'created');
  snapshots = 0;
  const outcome = await createDailyBackupIfDue({ ...options, now: new Date(2026, 9, 2, 9) });
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
