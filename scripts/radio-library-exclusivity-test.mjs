// RadioView.playStation() pauses the library engine when a station starts,
// but that was one-directional: nothing paused/stopped the radio stream when
// library playback became active from elsewhere (Transport, Space, a media
// key). A user could end up with the radio stream and a library track
// playing simultaneously. RadioView.tsx is a React component wired to a real
// <audio> element and the zustand store, so this is verified against source
// (matching this repo's existing convention for store/component-level fixes
// that can't run outside a DOM — see queue-edit-smoke.mjs's own
// usePlayerStore.ts/PlaylistView.tsx source assertions).
// Run with: npm run test:radio-library-exclusivity

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [radioSource, packageSource] = await Promise.all([
  readFile(new URL('../src/components/views/RadioView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

// The existing one-directional half (station start pauses the library engine).
assert.match(radioSource, /if \(isPlayingLibrary\) pauseLibrary\(\);/, 'starting a station should still pause library playback');

// The fix: a library-playback-became-active effect that stops the radio.
const effectMatch = radioSource.match(/useEffect\(\(\) => \{\s*if \(isPlayingLibrary[\s\S]*?\}, \[isPlayingLibrary\]\);/);
assert.ok(effectMatch, 'RadioView should react to isPlayingLibrary turning on by stopping the radio stream');
const effectBody = effectMatch[0];
assert.match(effectBody, /audio\.current\.paused/, 'the effect should check the radio audio element\'s own paused state');
assert.match(effectBody, /stopRadio\(\)/, 'library playback becoming active should stop the radio (matching the explicit Stop button behavior), not just pause it silently');

// isPlayingLibrary must be sourced from the real store, not a local stub —
// otherwise the effect would never actually fire on real Transport/Space input.
assert.match(radioSource, /const isPlayingLibrary = usePlayerStore\(\(s\) => s\.isPlaying\);/, 'isPlayingLibrary should subscribe to the store\'s live isPlaying flag');

assert.match(packageSource, /"test:radio-library-exclusivity"/, 'package.json should expose the radio/library exclusivity test');

console.log(JSON.stringify({ ok: true }, null, 2));
