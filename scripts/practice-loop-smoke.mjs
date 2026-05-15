import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const {
  canEnablePracticeLoop,
  normalizePracticeLoop,
  loopProgressPercent,
  shouldRestartPracticeLoop,
} = await import('../dist-electron/shared/practice-loop.js');

const normalized = normalizePracticeLoop(
  { start: -4, end: 999, enabled: true },
  240,
);
assert.deepEqual(normalized, { start: 0, end: 240, enabled: true });

const incomplete = normalizePracticeLoop({ start: 32, end: null, enabled: true }, 240);
assert.equal(canEnablePracticeLoop(incomplete), false);
assert.equal(incomplete.enabled, false);

const loop = normalizePracticeLoop({ start: 12.345, end: 18.999, enabled: true }, 240);
assert.deepEqual(loop, { start: 12.35, end: 19, enabled: true });
assert.equal(canEnablePracticeLoop(loop), true);
assert.equal(shouldRestartPracticeLoop(loop, 18.9), false);
assert.equal(shouldRestartPracticeLoop(loop, 19), true);
assert.equal(shouldRestartPracticeLoop(loop, 21), true);
assert.equal(loopProgressPercent(loop, 12.35), 0);
assert.equal(loopProgressPercent(loop, 19), 100);
assert.equal(loopProgressPercent(loop, 15.675), 50);

const backwards = normalizePracticeLoop({ start: 31, end: 18, enabled: true }, 240);
assert.deepEqual(backwards, { start: 18, end: 31, enabled: true });

const [nowPlayingSource, sharedSource, packageSource] = await Promise.all([
  readFile(new URL('../src/components/views/NowPlayingView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../shared/practice-loop.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(sharedSource, /shouldRestartPracticeLoop/, 'shared loop helper should expose restart decision');
assert.match(nowPlayingSource, /PracticeLoopPanel/, 'Now Playing should render PracticeLoopPanel');
assert.match(nowPlayingSource, /shouldRestartPracticeLoop/, 'Now Playing should use shared restart helper');
assert.match(nowPlayingSource, /data-newamp-practice-loop/, 'Practice Loop panel should expose a stable smoke hook');
assert.match(packageSource, /smoke:practice-loop/, 'package.json should expose the practice-loop smoke');

console.log(JSON.stringify({ ok: true, loop }, null, 2));
