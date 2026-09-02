import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  LibraryWatcher,
  normalizeLibraryWatchRoots,
  resolveLibraryWatchTarget,
} from '../dist-electron/electron/library-watcher.js';

const smokeRoot = resolve('tmp', 'library-watch-smoke');
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(join(smokeRoot, 'artist'), { recursive: true });

assert.deepEqual(
  normalizeLibraryWatchRoots([smokeRoot, smokeRoot, join(smokeRoot, 'missing')]),
  [smokeRoot],
  'watch roots should keep unique existing directories only',
);
assert.equal(
  resolveLibraryWatchTarget(smokeRoot, join('artist', 'new-song.mp3')),
  join(smokeRoot, 'artist', 'new-song.mp3'),
  'audio file changes should scan the changed file only',
);
assert.equal(
  resolveLibraryWatchTarget(smokeRoot, join('artist', 'cover.webp')),
  join(smokeRoot, 'artist'),
  'folder art changes should rescan that album folder',
);
assert.equal(
  resolveLibraryWatchTarget(smokeRoot, join('artist', 'notes.txt')),
  null,
  'unrelated file changes should not trigger a library scan',
);

const calls = [];
const watcher = new LibraryWatcher((targets) => {
  calls.push(targets);
}, { debounceMs: 50 });
watcher.start([smokeRoot]);
assert.ok(watcher.isWatching(), 'watcher should start for a valid root');
assert.deepEqual(watcher.getWatchedRoots(), [smokeRoot]);

const changedTrack = join(smokeRoot, 'artist', 'new-watch-track.mp3');
await writeFile(changedTrack, Buffer.from('not a real mp3; watcher only needs the path event'));
await waitFor(() => calls.flat().some((target) => target === changedTrack));
watcher.stop();
assert.equal(watcher.isWatching(), false, 'watcher should release filesystem handles');

const [typesSource, settingsSource, mainSource, settingsViewSource, packageSource] = await Promise.all([
  readText('../shared/types.ts'),
  readText('../electron/settings.ts'),
  readText('../electron/main.ts'),
  readText('../src/components/views/SettingsView.tsx'),
  readText('../package.json'),
]);

assert.match(typesSource, /libraryAutoWatch/, 'AppSettings should persist the library auto-watch toggle');
assert.match(settingsSource, /libraryAutoWatch/, 'SettingsStore should default and normalize auto-watch');
assert.match(mainSource, /LibraryWatcher/, 'main process should own the filesystem watcher');
assert.match(mainSource, /syncLibraryWatcher/, 'main process should restart watcher when settings change');
assert.match(mainSource, /scanner\.start\(targets, \{ force: true \}\)/, 'watcher rescans should force metadata and folder-art refresh');
assert.match(mainSource, /trackCount === 0 \|\| settings\.get\(\)\.libraryAutoWatch/, 'startup should refresh configured roots when auto-watch is enabled');
assert.match(settingsViewSource, /Auto-watch library/, 'Settings should expose the auto-watch toggle');
assert.match(packageSource, /"smoke:library-watch"/, 'package.json should expose library watch smoke');

console.log(JSON.stringify({ ok: true, changedTrack, watchedRootExists: existsSync(smokeRoot) }, null, 2));

async function readText(relativePath) {
  return import('node:fs/promises').then((fs) => fs.readFile(new URL(relativePath, import.meta.url), 'utf8'));
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('Timed out waiting for library watcher event');
}
