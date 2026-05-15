import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTO_DJ_REFILL_THRESHOLD,
  AUTO_DJ_SMART_RULE_LOOKAHEAD,
  autoDjSmartRuleCandidateCount,
  MAX_AUTO_DJ_SMART_RULE_CANDIDATES,
  normalizeAutoDjTarget,
  selectAutoDjAdditions,
  shouldAutoDjRefill,
} from '../dist-electron/shared/auto-dj.js';
import { SettingsStore } from '../dist-electron/electron/settings.js';

const queue = [
  track(1, 'Seed'),
  track(2, 'Already queued'),
];
const candidates = [
  track(1, 'Seed duplicate'),
  track(2, 'Queued duplicate'),
  track(3, 'Next compatible'),
  track(4, 'Bridge compatible'),
  track(5, 'Closer'),
];

assert.equal(AUTO_DJ_REFILL_THRESHOLD, 1, 'Auto DJ should refill when the queue has one or fewer tracks left');
assert.equal(shouldAutoDjRefill({ enabled: true, queueLength: 2, index: 1 }), true);
assert.equal(shouldAutoDjRefill({ enabled: true, queueLength: 5, index: 1 }), false);
assert.equal(shouldAutoDjRefill({ enabled: false, queueLength: 2, index: 1 }), false);
assert.equal(normalizeAutoDjTarget(2), 6);
assert.equal(normalizeAutoDjTarget(500), 80);
assert.equal(AUTO_DJ_SMART_RULE_LOOKAHEAD, 80);
assert.equal(autoDjSmartRuleCandidateCount(10, 24, 2), 106);
assert.equal(autoDjSmartRuleCandidateCount(180, 24, 2), 180);
assert.equal(autoDjSmartRuleCandidateCount(20, 80, 200), MAX_AUTO_DJ_SMART_RULE_CANDIDATES);
assert.deepEqual(
  selectAutoDjAdditions(queue, candidates, 5).map((item) => item.id),
  [3, 4, 5],
  'Auto DJ additions should skip duplicates and fill to the target queue length',
);
assert.deepEqual(
  selectAutoDjAdditions(queue, candidates, 3).map((item) => item.id),
  [3],
  'Auto DJ additions should only add what is needed to reach target length',
);

const settingsDir = await mkdtemp(fileURLToPath(new URL('../.tmp-auto-dj-', import.meta.url)));
try {
  const settings = new SettingsStore(join(settingsDir, 'settings.json'));
  assert.equal(settings.get().autoDjSmartRuleId, null);
  assert.equal(settings.set({ autoDjSmartRuleId: 42 }).autoDjSmartRuleId, 42);
  assert.equal(settings.set({ autoDjSmartRuleId: -9 }).autoDjSmartRuleId, null);
} finally {
  await rm(settingsDir, { recursive: true, force: true });
}

const [typesSource, settingsSource, storeSource, playlistSource, nowPlayingSource, packageSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/settings.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/PlaylistView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/NowPlayingView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(typesSource, /autoDjEnabled/, 'settings types should persist Auto DJ enablement');
assert.match(typesSource, /autoDjSmartRuleId/, 'settings types should persist Auto DJ smart rule source');
assert.match(settingsSource, /autoDjTarget/, 'settings defaults should include Auto DJ target');
assert.match(settingsSource, /autoDjSmartRuleId/, 'settings should persist Auto DJ smart rule source');
assert.match(storeSource, /refillAutoDjQueue/, 'player store should refill queue through Auto DJ');
assert.match(storeSource, /!state\.queue\.length && !state\.autoDjSmartRuleId/, 'Auto DJ should allow Smart Rule sources to seed an empty queue');
assert.match(storeSource, /buildHarmonicMix/, 'player store should use Harmonic Mix for Auto DJ candidates');
assert.match(storeSource, /setAutoDjSmartRuleId/, 'player store should select Auto DJ smart rule source');
assert.match(storeSource, /runSmartPlaylistRule/, 'Auto DJ should use saved smart rules as candidate sources');
assert.match(storeSource, /autoDjSmartRuleCandidateCount/, 'Auto DJ should ask saved Smart Rules for deeper refill candidates');
assert.match(storeSource, /getSmartPlaylistRules/, 'Auto DJ should expand saved Smart Rule count before refill');
assert.match(playlistSource, /AUTO DJ/, 'Now Queue should expose Auto DJ controls');
assert.match(playlistSource, /Auto DJ source/, 'Now Queue should expose Auto DJ source selection');
assert.match(playlistSource, /wasEmpty && added\.length/, 'Now Queue should start playback when Smart Rule Auto DJ seeds an empty queue');
assert.match(playlistSource, /Harmonic Mix/, 'Now Queue should keep Harmonic Mix as default Auto DJ source');
assert.match(nowPlayingSource, /STOP RADIO/, 'Now Playing should expose active station stop controls');
assert.match(nowPlayingSource, /autoDjSmartRuleId/, 'Now Playing should show active Smart Rule station state');
assert.match(packageSource, /"smoke:auto-dj"/, 'package.json should expose the Auto DJ smoke');

console.log(JSON.stringify({ ok: true, additions: [3, 4, 5] }, null, 2));

function track(id, title) {
  return {
    id,
    title,
    artist: 'Auto DJ',
    album: 'Continuity',
    albumArtist: 'Auto DJ',
    path: `B:/music/${id}.mp3`,
    trackNo: null,
    discNo: null,
    year: 2026,
    genre: 'Electronic',
    duration: 180,
    bitrate: 320000,
    sampleRate: 44100,
    size: 1,
    mtime: 1,
    hasArt: 0,
    loved: 0,
    playCount: 0,
    lastPlayed: null,
    skipCount: 0,
    lastSkipped: null,
    bpm: 120 + id,
    key: id % 2 ? 'C' : 'A minor',
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
  };
}
