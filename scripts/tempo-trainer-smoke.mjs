import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const {
  normalizePlaybackRate,
  nudgePlaybackRate,
  playbackRateLabel,
} = await import('../dist-electron/shared/tempo-trainer.js');

assert.equal(normalizePlaybackRate(0.1), 0.5);
assert.equal(normalizePlaybackRate(2.2), 1.5);
assert.equal(normalizePlaybackRate(0.974), 0.95);
assert.equal(normalizePlaybackRate(1.026), 1.05);
assert.equal(nudgePlaybackRate(1, -1), 0.95);
assert.equal(nudgePlaybackRate(1.48, 1), 1.5);
assert.equal(nudgePlaybackRate(0.52, -1), 0.5);
assert.equal(playbackRateLabel(1), '1.00x');
assert.equal(playbackRateLabel(0.75), '0.75x');

const [engineSource, storeSource, nowPlayingSource, typesSource, packageSource] = await Promise.all([
  readFile(new URL('../src/audio/engine.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/NowPlayingView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(engineSource, /setPlaybackRate/, 'AudioEngine should expose setPlaybackRate');
assert.match(engineSource, /preservesPitch/, 'AudioEngine should preserve pitch while changing speed');
assert.match(storeSource, /setPlaybackRate/, 'Player store should persist playback rate');
assert.match(typesSource, /playbackRate/, 'AppSettings should include playbackRate');
assert.match(nowPlayingSource, /TempoTrainerPanel/, 'Now Playing should render a TempoTrainerPanel');
assert.match(nowPlayingSource, /data-newamp-tempo-trainer/, 'Tempo Trainer panel should expose a stable smoke hook');
assert.match(packageSource, /smoke:tempo/, 'package.json should expose the tempo smoke');

console.log(JSON.stringify({ ok: true, rate: normalizePlaybackRate(0.974) }, null, 2));
