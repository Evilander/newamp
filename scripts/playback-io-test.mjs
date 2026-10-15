// The "playback first" signal background decodes wait on (electron/playback-io.ts):
// hungry while any gapless stream says so, listeners told once per change,
// waiters released when the last stream is fed or when their wait runs out.
// Run: node scripts/playback-io-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const outfile = resolve('tmp/playback-io-test-bundle.mjs');
await build({
  entryPoints: [resolve('electron/playback-io.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile,
  logLevel: 'silent',
});
const { onPlaybackHunger, playbackHungry, reportPlaybackHunger, whenPlaybackFed } = await import(pathToFileURL(outfile).href);

const settled = async (promise, ms = 30) => {
  let done = false;
  void promise.then(() => { done = true; });
  await new Promise((r) => setTimeout(r, ms));
  return done;
};

// Nothing playing: fed, and a wait resolves at once.
assert.equal(playbackHungry(), false);
assert.equal(await settled(whenPlaybackFed()), true, 'fed with no stream');

const heard = [];
const stopListening = onPlaybackHunger((hungry) => heard.push(hungry));
const a = {};
const b = {};

// One stream short of audio: hungry, and a wait holds.
reportPlaybackHunger(a, true);
assert.equal(playbackHungry(), true);
const waiting = whenPlaybackFed();
assert.equal(await settled(waiting), false, 'a wait holds while a stream is hungry');

// A second hungry stream, and the same stream reported twice, are not news.
reportPlaybackHunger(b, true);
reportPlaybackHunger(a, true);
assert.deepEqual(heard, [true]);

// Fed only when every stream is.
reportPlaybackHunger(a, false);
assert.equal(playbackHungry(), true, 'still hungry while b is');
assert.equal(await settled(waiting), false);
reportPlaybackHunger(b, false);
assert.equal(playbackHungry(), false);
assert.equal(await settled(waiting), true, 'the wait is released when the last stream is fed');
assert.deepEqual(heard, [true, false]);

// A stream that never refills can't hold background work forever.
reportPlaybackHunger(a, true);
const capped = whenPlaybackFed(60);
assert.equal(await settled(capped, 20), false);
assert.equal(await settled(capped, 80), true, 'the wait gives up after its limit');
assert.equal(playbackHungry(), true, 'giving up does not clear the signal');
reportPlaybackHunger(a, false);

// A listener that unsubscribed hears nothing more.
stopListening();
reportPlaybackHunger(a, true);
reportPlaybackHunger(a, false);
assert.deepEqual(heard, [true, false, true, false]);

console.log('[playback-io] PASS');
