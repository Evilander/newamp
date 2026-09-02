// Stale play requests must not run the store's side effects.
//
// Clicking track A and then track B before A has started used to record a
// play and a Last.fm now-playing for both: AudioEngine.play refused to touch
// its own state for the superseded request but resolved normally, and every
// store action ran startLastfmNowPlaying/recordLibraryPlay after the await
// regardless. The fix has two halves — the engine reports 'started' or 'stale',
// and the store hands out an intent ticket per request (shared/play-intent.ts)
// and only acts when its ticket is still the newest and the engine said
// 'started'. The engine and store need a DOM to run, so the ticket logic is
// exercised for real here with a fake engine and the wiring is pinned by
// source assertions, the same way the queue-edit and badge tests do it.
//
// Run: npm run build:electron && node scripts/play-intent-test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPlayIntentGate } from '../dist-electron/shared/play-intent.js';

// ---- 1. The ticket gate, driven the way playEngineTrack drives it ----------

// A fake engine whose play() resolves when the test says so, reporting
// 'stale' for any request that is no longer its newest — mirroring
// AudioEngine.play's contract.
function fakeEngine() {
  let seq = 0;
  const pending = [];
  return {
    play(name) {
      const mine = ++seq;
      return new Promise((resolve) => {
        pending.push({ name, finish: () => resolve(mine === seq ? 'started' : 'stale') });
      });
    },
    finish(name) {
      const idx = pending.findIndex((p) => p.name === name);
      assert.ok(idx >= 0, `no pending play for ${name}`);
      pending.splice(idx, 1)[0].finish();
    },
  };
}

// playEngineTrack, as written in usePlayerStore.ts: ticket before the await,
// live only if the engine started it AND no newer ticket exists.
function makePlayEngineTrack(engine, gate) {
  return async (name) => {
    const intent = gate.begin();
    const outcome = await engine.play(name);
    return outcome === 'started' && gate.isCurrent(intent);
  };
}

{
  const engine = fakeEngine();
  const gate = createPlayIntentGate();
  const playEngineTrack = makePlayEngineTrack(engine, gate);
  const sideEffects = [];
  const playTrack = async (name) => {
    if (!(await playEngineTrack(name))) return;
    sideEffects.push(name);
  };

  // A is requested, then B; B finishes first, then A finishes late.
  const a = playTrack('A');
  const b = playTrack('B');
  engine.finish('B');
  engine.finish('A');
  await Promise.all([a, b]);
  assert.deepEqual(sideEffects, ['B'], 'only the newest request may run side effects when an older one finishes late');

  // The reverse order: A finishes before B is even requested — A is live.
  sideEffects.length = 0;
  const a2 = playTrack('A2');
  engine.finish('A2');
  await a2;
  const b2 = playTrack('B2');
  engine.finish('B2');
  await b2;
  assert.deepEqual(sideEffects, ['A2', 'B2'], 'sequential requests each run their side effects');

  // Same track twice (repeat-one, or a restart) is a new intent each time and is not mistaken for stale.
  sideEffects.length = 0;
  const r1 = playTrack('R');
  engine.finish('R');
  await r1;
  const r2 = playTrack('R');
  engine.finish('R');
  await r2;
  assert.deepEqual(sideEffects, ['R', 'R'], 'replaying the same track is a fresh request, not a stale one');

  // A request the engine itself marks stale (superseded inside the engine) is not live even if it is the newest ticket.
  const gate2 = createPlayIntentGate();
  const staleEngine = { play: async () => 'stale' };
  const playStale = makePlayEngineTrack(staleEngine, gate2);
  assert.equal(await playStale('X'), false, "an engine 'stale' answer is never live");
}

// ---- 2. The wiring: engine contract and every store call site ------------

const engineSource = await readFile(new URL('../src/audio/engine.ts', import.meta.url), 'utf8');
assert.match(engineSource, /export type PlayOutcome = 'started' \| 'stale';/, 'the engine must export the PlayOutcome contract');
assert.match(engineSource, /async play\(src: string, trackId: number \| null, startAt = 0\): Promise<PlayOutcome>/, 'AudioEngine.play must report started/stale');
assert.match(engineSource, /private async awaitDeckPlay\(deck: Deck, seq: number\): Promise<PlayOutcome>/, 'deck starts must recheck the request sequence after the await');
assert.match(engineSource, /private async crossfadeTo\([^)]*seq: number\): Promise<PlayOutcome>/, 'the crossfade path must carry the request sequence');
assert.match(engineSource, /private async playPreparedDeck\([^)]*seq: number\): Promise<PlayOutcome>/, 'the prepared-deck path must carry the request sequence');
assert.match(engineSource, /if \(outcome === 'accepted'\) return 'started';\s*if \(outcome === 'stale'\) return 'stale';/, 'the exclusive-transport path must map its outcome onto the contract');

const storeSource = await readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8');
assert.match(storeSource, /const playIntents = createPlayIntentGate\(\);/, 'the store must own one intent gate');
assert.match(storeSource, /async function playEngineTrack\(track: Track\): Promise<boolean> \{[\s\S]*?const intent = playIntents\.begin\(\);[\s\S]*?return outcome === 'started' && playIntents\.isCurrent\(intent\);/, 'playEngineTrack must take a ticket before the await and check it after');

// Every awaited play must be guarded: the only allowed awaited form is the
// `if (!(await playEngineTrack(x))) return;` guard. Fire-and-forget `void`
// calls (repeat-one replay) have no side effects after them and are fine.
const awaited = [...storeSource.matchAll(/^.*await playEngineTrack\(.*$/gm)].map((m) => m[0].trim());
assert.ok(awaited.length >= 6, `expected the store to await playEngineTrack at several sites, found ${awaited.length}`);
for (const line of awaited) {
  if (line.startsWith('const outcome = await engine.play')) continue;
  assert.match(line, /^if \(!\(await playEngineTrack\([^)]*\)\)\) return;$/, `unguarded play await in the store: ${line}`);
}
// The exclusive-route restart bypasses playEngineTrack and must still invalidate older tickets.
assert.match(storeSource, /playIntents\.begin\(\);\s*await engine\.play\(toAudioUrl\(current\.path\), current\.id, resumeAt\)/, 'the route restart must take a ticket too');
// No side-effect call may follow a bare (unguarded) play.
for (const fn of ['startLastfmNowPlaying', 'recordLibraryPlay']) {
  const bareFollow = new RegExp(`await playEngineTrack\\([^)]*\\);\\s*(?:lastPlaybackErrorKey = null;\\s*)?${fn}\\(`);
  assert.doesNotMatch(storeSource, bareFollow, `${fn} must not follow an unguarded play`);
}

const packageSource = await readFile(new URL('../package.json', import.meta.url), 'utf8');
assert.match(packageSource, /"test:play-intent"/, 'package.json should expose the play-intent test');

console.log(JSON.stringify({ ok: true, awaitedPlaySites: awaited.length }, null, 2));
