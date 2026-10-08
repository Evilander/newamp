// SettingsStore startup reads under a lock: a locked
// read at startup (EBUSY, EPERM, EAGAIN, EACCES, EMFILE, EIO, EISDIR) is
// retried with backoff instead of being treated as corruption. If the lock
// clears within the budget, the real settings load normally. If it never
// clears, the store runs the session on in-memory defaults, never writes
// over the untouched original, and self-heals on a later set() once the lock
// has cleared (retrying at most every 10 s, and merging the caller's patch
// onto the real file instead of onto defaults). Genuinely invalid JSON is
// still quarantined — the carve-out above must not swallow real corruption.
// Run: npm run build:electron && node scripts/settings-transient-read-test.mjs
import assert from 'node:assert/strict';
import fs, { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore } from '../dist-electron/electron/settings.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'settings-transient-read-test');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lockedError(code) {
  const err = new Error(`fixture ${code} lock`);
  err.code = code;
  return err;
}

const realReadFileSync = fs.readFileSync;
function patchRead(targetFile, code, failTimes) {
  let calls = 0;
  fs.readFileSync = (p, ...rest) => {
    if (String(p) === targetFile) {
      calls += 1;
      if (calls <= failTimes) throw lockedError(code);
    }
    return realReadFileSync.call(fs, p, ...rest);
  };
  syncBuiltinESMExports();
}
function unpatchRead() {
  fs.readFileSync = realReadFileSync;
  syncBuiltinESMExports();
}

// 1. A single transient EBUSY that clears on the first retry: the real
//    settings load, with no recovery event and nothing suppressed — an
//    ordinary set() afterward persists normally.
{
  const dir = join(smokeRoot, 'clears');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  const original = JSON.stringify({ volume: 0.42, theme: 'amber', libraryRoots: ['K:/music'] });
  writeFileSync(file, original, 'utf-8');

  patchRead(file, 'EBUSY', 1);
  let store;
  try {
    store = new SettingsStore(file);
  } finally {
    unpatchRead();
  }
  assert.equal(store.recoveryEvents.length, 0, 'a lock that clears on retry is not a recovery event');
  assert.equal(store.isSuppressed(), false);
  assert.equal(store.get().volume, 0.42, 'the real volume must load once the lock clears');
  assert.equal(store.get().theme, 'amber');
  assert.deepEqual(store.get().libraryRoots, ['K:/music']);
  assert.equal(readFileSync(file, 'utf-8'), original, 'the original must be untouched by the retry itself');

  store.set({ volume: 0.5 });
  assert.equal(JSON.parse(readFileSync(file, 'utf-8')).volume, 0.5, 'a live store must persist normally afterward');
}

// 2. EBUSY on every attempt through the whole retry budget, AND still
//    locked through the first mutation (a resumeState-only patch, which
//    takes the debounced async path): the original file stays untouched,
//    the store falls back to in-memory defaults, exactly one recovery event
//    is recorded, and no write ever lands — sync or async, even past the
//    debounce window.
{
  const dir = join(smokeRoot, 'stays-locked');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  const original = JSON.stringify({ volume: 0.91, theme: 'mono', libraryRoots: ['D:/albums'] });
  writeFileSync(file, original, 'utf-8');

  patchRead(file, 'EBUSY', 999);
  let store;
  try {
    store = new SettingsStore(file);
  } finally {
    unpatchRead();
  }
  assert.equal(store.recoveryEvents.length, 1, 'a lock that never clears must be recorded');
  assert.equal(store.recoveryEvents[0].store, 'settings');
  assert.equal(store.recoveryEvents[0].backupPath, file, 'nothing was quarantined — the original was never read');
  assert.match(store.recoveryEvents[0].reason, /EBUSY/);
  assert.equal(store.isSuppressed(), true);
  assert.equal(store.get().volume, 0.75, 'an unreadable file must fall back to defaults, not the real value');
  assert.equal(readFileSync(file, 'utf-8'), original, 'the untouched original must survive a permanently locked read');

  // Keep the lock down through the first mutation too, so tryLiftSuppression()
  // (triggered by this same set() call) also fails and leaves state exactly
  // as it was — this is the resumeState-only patch, which schedules the
  // debounced async write instead of persisting synchronously.
  patchRead(file, 'EBUSY', 999);
  try {
    store.set({ resumeState: { queueTrackIds: [1], index: 0, currentTime: 12, mode: 'normal', updatedAt: Date.now() } });
  } finally {
    unpatchRead();
  }
  assert.equal(store.isSuppressed(), true, 'a set() while still locked must not lift suppression');
  assert.equal(store.recoveryEvents.length, 1, 'a failed self-heal attempt must not add a second recovery event');
  assert.equal(readFileSync(file, 'utf-8'), original, 'the sync path must not have written yet');

  await sleep(1000); // past the 800ms resumeState debounce
  assert.equal(readFileSync(file, 'utf-8'), original, 'the debounced async path must also honor suppression');
  const strays = readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(strays, [], 'a suppressed async persist must not leave a temp file behind either');

  // And the synchronous quit-path flush must not write over it either.
  store.flushSync();
  assert.equal(readFileSync(file, 'utf-8'), original, 'a suppressed store must never write over the untouched original');
}

// 3. Self-heal: still locked at boot, but the lock clears before the first
//    set() — tryLiftSuppression() re-reads the real file, and the caller's
//    patch merges onto it (not onto DEFAULTS). Suppression lifts.
{
  const dir = join(smokeRoot, 'self-heal');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  const original = JSON.stringify({ volume: 0.31, theme: 'amber', libraryRoots: ['D:/RealMusic'], lastfmSessionKey: 'real-session' });
  writeFileSync(file, original, 'utf-8');

  patchRead(file, 'EBUSY', 999);
  let store;
  try {
    store = new SettingsStore(file);
  } finally {
    unpatchRead();
  }
  assert.equal(store.isSuppressed(), true);
  assert.equal(store.get().volume, 0.75, 'in-memory state must still be defaults before the first mutation');

  // Read is NOT re-locked this time: the first set() retries and succeeds.
  const result = store.set({ theme: 'terminal' });
  assert.equal(store.isSuppressed(), false, 'a set() while the lock has cleared must lift suppression');
  assert.equal(result.volume, 0.31, "the caller's patch must merge onto the REAL file, not onto defaults");
  assert.equal(result.theme, 'terminal', "the caller's own change must still apply");
  assert.equal(result.libraryRoots[0], 'D:/RealMusic');

  const onDisk = JSON.parse(readFileSync(file, 'utf-8'));
  assert.equal(onDisk.volume, 0.31);
  assert.equal(onDisk.theme, 'terminal');
  assert.deepEqual(onDisk.libraryRoots, ['D:/RealMusic']);
  assert.equal(onDisk.lastfmSessionKey, 'real-session', 'fields the patch never touched must survive from the real file');
}

// 3b. Still locked at the first set(), which is usually the resume-state
//     autosave a few seconds after launch, and clear by a later one: set()
//     tries again, at most once every 10 seconds, and lifts suppression once
//     the real file reads. Until that read succeeds nothing is written, and
//     inside the cooldown set() doesn't touch the file at all.
{
  const dir = join(smokeRoot, 'late-heal');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  const original = JSON.stringify({ volume: 0.27, theme: 'amber', libraryRoots: ['E:/Music'], lastfmUsername: 'real-user' });
  writeFileSync(file, original, 'utf-8');

  patchRead(file, 'EBUSY', 999);
  let store;
  try {
    store = new SettingsStore(file);
  } finally {
    unpatchRead();
  }
  assert.equal(store.isSuppressed(), true);

  let clock = 1_000_000;
  const ownNow = Object.getOwnPropertyDescriptor(performance, 'now');
  performance.now = () => clock;
  let locked = true;
  let reads = 0;
  fs.readFileSync = (p, ...rest) => {
    if (String(p) === file) {
      reads += 1;
      if (locked) throw lockedError('EBUSY');
    }
    return realReadFileSync.call(fs, p, ...rest);
  };
  syncBuiltinESMExports();
  try {
    store.set({ resumeState: { queueTrackIds: [7], index: 0, currentTime: 3, mode: 'normal', updatedAt: Date.now() } });
    assert.equal(store.isSuppressed(), true, 'still locked at the first set()');
    assert.equal(realReadFileSync.call(fs, file, 'utf-8'), original);

    locked = false;
    clock += 5_000;
    const readsBefore = reads;
    store.set({ volume: 0.6 });
    assert.equal(reads, readsBefore, 'inside the cooldown set() does not read the file again');
    assert.equal(store.isSuppressed(), true);
    assert.equal(realReadFileSync.call(fs, file, 'utf-8'), original, 'nothing is written before a read of the real file succeeds');

    clock += 5_000;
    const result = store.set({ theme: 'terminal' });
    assert.equal(store.isSuppressed(), false, 'a later set() once the lock has cleared must lift suppression');
    assert.equal(result.volume, 0.27, 'the patch merges onto the real file');
    assert.equal(result.theme, 'terminal');
    const onDisk = JSON.parse(realReadFileSync.call(fs, file, 'utf-8'));
    assert.equal(onDisk.theme, 'terminal', 'and the session saves again');
    assert.deepEqual(onDisk.libraryRoots, ['E:/Music']);
    assert.equal(onDisk.lastfmUsername, 'real-user');
  } finally {
    if (ownNow) Object.defineProperty(performance, 'now', ownNow);
    else delete performance.now;
    unpatchRead();
  }
}

// 4. Genuinely corrupt JSON is still quarantined and recovered with defaults.
{
  const dir = join(smokeRoot, 'corrupt');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  writeFileSync(file, '{"volume": 0.5, "libraryRoots": [truncated', 'utf-8');
  const store = new SettingsStore(file);
  assert.equal(store.recoveryEvents.length, 1, 'unparseable settings should still record one recovery event');
  assert.ok(store.recoveryEvents[0].backupPath.includes('.corrupt-'), 'bad file must be quarantined, kept as backup');
  assert.equal(store.get().volume, 0.75, 'quarantine must fall back to defaults');
}

// 5. Bootstrap must not act on a suppressed store's empty defaults as if
//    they were the user's real, saved state — the level this can be tested
//    at without a live Electron app is asserting the guard exists in source,
//    same technique the existing settings-atomic-test.mjs suite uses.
{
  const mainSrc = readFileSync(join(repoRoot, 'electron', 'main.ts'), 'utf-8');
  assert.match(
    mainSrc,
    /!smokeMode && !settings\.isSuppressed\(\) && !current\.libraryRoots\.length/,
    'bootstrap must skip auto-seeding a library root while settings are suppressed',
  );
  assert.match(
    mainSrc,
    /!settings\.isSuppressed\(\) && roots\.length && \(trackCount === 0/,
    'bootstrap must skip the launch auto-scan while settings are suppressed',
  );
  assert.match(
    mainSrc,
    /settings\.isSuppressed\(\) \|\| podcastStore\.isSuppressed\(\)/,
    'bootstrap must warn when settings or podcasts started suppressed',
  );
}

await rm(smokeRoot, { recursive: true, force: true });
console.log('[settings-transient-read-test] PASS: transient reads retry/self-heal correctly and never get mistaken for corruption');
