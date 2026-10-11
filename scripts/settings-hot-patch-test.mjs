// SettingsStore writes the two hot, lone-key patches (resumeState and
// windowState) on a debounce instead of an fsync inside set(), and everything
// else stays synchronous. A pending write still lands on flushSync().
// Run: npm run build:electron && node scripts/settings-hot-patch-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore } from '../dist-electron/electron/settings.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'settings-hot-patch-test');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const onDisk = (file) => JSON.parse(readFileSync(file, 'utf-8'));

const deck = { x: 40, y: 60, width: 720, height: 152 };
const normal = { x: 100, y: 80, width: 1280, height: 820 };
const state = (rect) => ({ normal: rect, maximized: false, deck: null });

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

// A lone windowState patch is held back; the in-memory value is current.
{
  const file = join(root, 'lone.json');
  const store = new SettingsStore(file);
  store.set({ windowState: state(normal) });
  assert.equal(store.get().windowState.normal.width, 1280, 'the live value updates at once');
  assert.equal(onDisk(file).windowState.normal, null, 'the file is not rewritten inside set()');
  store.flushSync();
  assert.deepEqual(onDisk(file).windowState.normal, normal, 'flushSync lands the pending window state');
}

// It reaches the disk on its own once the debounce elapses.
{
  const file = join(root, 'timer.json');
  const store = new SettingsStore(file);
  store.set({ windowState: state(normal) });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && onDisk(file).windowState.normal === null) await sleep(50);
  assert.deepEqual(onDisk(file).windowState.normal, normal, 'the debounced write lands');
}

// resumeState keeps its debounce.
{
  const file = join(root, 'resume.json');
  const store = new SettingsStore(file);
  store.set({ resumeState: { queueTrackIds: [1, 2], index: 0, currentTime: 3, mode: 'normal', updatedAt: Date.now() } });
  assert.equal(onDisk(file).resumeState, null, 'resumeState is still not written inside set()');
  store.flushSync();
  assert.deepEqual(onDisk(file).resumeState.queueTrackIds, [1, 2]);
}

// Any other patch, or windowState bundled with one, writes synchronously and
// carries the pending window state with it.
{
  const file = join(root, 'mixed.json');
  const store = new SettingsStore(file);
  store.set({ windowState: state(normal) });
  store.set({ volume: 0.4 });
  const written = onDisk(file);
  assert.equal(written.volume, 0.4, 'a regular setting is on disk the instant set() returns');
  assert.deepEqual(written.windowState.normal, normal, 'the synchronous write includes the pending window state');

  store.set({ windowState: state(deck), volume: 0.3 });
  assert.equal(onDisk(file).volume, 0.3, 'a patch with more than one key is not debounced');
  assert.deepEqual(onDisk(file).windowState.normal, deck);
}

await rm(root, { recursive: true, force: true });
console.log('PASS settings hot patches: windowState and resumeState are debounced, other settings stay synchronous, flushSync lands pending writes');
