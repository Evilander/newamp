// Tests for SettingsStore crash-safety: settings.json is written via a
// Sibling temp file + fsync + rename (atomic replace), so an interrupted
// write can never truncate the file back to defaults (losing library roots,
// the Last.fm session, …). The on-disk content is therefore always either the
// old or the new complete JSON.
// Run: npm run build:electron && node scripts/settings-atomic-test.mjs
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { watch } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore } from '../dist-electron/electron/settings.js';

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

await rm(smokeRoot, { recursive: true, force: true });
console.log('[settings-atomic-test] PASS: atomic settings persistence verified');
