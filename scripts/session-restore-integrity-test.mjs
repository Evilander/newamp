import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remapResumeIndex, resolveResumePosition } from '../dist-electron/shared/playback-start.js';
import { SettingsStore } from '../dist-electron/electron/settings.js';

// Reproduces the exact A/B/C/D scenario from the audit: queue was
// [A, B, C, D] with the saved index pointing at C (index 2). Track A gets
// deleted before restore. The old code clamped the raw saved index against
// the post-filter length (3) and landed on D — the wrong track. Remapping by
// id must land back on C.
const ids = [101, 102, 103, 104]; // A, B, C, D
const survivingAfterADeleted = new Set([102, 103, 104]); // B, C, D
assert.equal(
  remapResumeIndex(ids, 2, survivingAfterADeleted),
  1, // B=0, C=1, D=2 in the surviving order — C is at index 1
  'deleting an earlier track must not shift the resumed index onto an unrelated track',
);

// Nothing deleted: index passes through unchanged.
assert.equal(remapResumeIndex(ids, 2, new Set(ids)), 2, 'index should be unchanged when nothing was deleted');

// The saved current track itself is gone: fall back to the count of
// surviving entries before the saved position (nearest equivalent spot),
// not a flat clamp against the final length.
const survivingWithCurrentGone = new Set([101, 102, 104]); // A, B, D (C deleted)
assert.equal(
  remapResumeIndex(ids, 2, survivingWithCurrentGone),
  2, // A=0, B=1, D=2 — two tracks (A, B) survived before the saved position
  'when the saved track itself is gone, land on the position after however many earlier tracks survived',
);

// Everything before the saved index is gone: lands at 0, not negative.
assert.equal(
  remapResumeIndex(ids, 3, new Set([104])),
  0,
  'if every earlier track is gone the remap should clamp to the start of the surviving list, not go negative',
);

// No survivors at all: -1 (caller treats this as "nothing to restore").
assert.equal(remapResumeIndex(ids, 1, new Set()), -1, 'no surviving tracks should report -1');

// ---- resolveResumePosition: identity first, idle stays idle -----------------

// The saved current track is followed by id, even when the saved index no
// longer points at it.
assert.deepEqual(
  resolveResumePosition(ids, 2, 103, survivingAfterADeleted),
  { index: 1, currentSurvived: true },
  'the current track is found by id after an earlier deletion',
);
// The saved position is only meaningful when that exact track survived.
assert.deepEqual(
  resolveResumePosition(ids, 2, 103, survivingWithCurrentGone),
  { index: 2, currentSurvived: false },
  'when the current track is gone, fall back to the nearest survivor and drop the saved position',
);
// A queue that was loaded but idle (index -1 / null id) comes back idle instead
// of with track 0 selected.
assert.deepEqual(
  resolveResumePosition(ids, -1, null, new Set(ids)),
  { index: -1, currentSurvived: false },
  'an idle queue must restore idle',
);
assert.deepEqual(
  resolveResumePosition(ids, 0, null, new Set(ids)),
  { index: -1, currentSurvived: false },
  'a null current id means idle even if an index was saved',
);
// A record written before currentTrackId existed still follows the saved index.
assert.deepEqual(
  resolveResumePosition(ids, 2, undefined, survivingAfterADeleted),
  { index: 1, currentSurvived: true },
  'legacy records resolve through the saved index and keep their position when that track survived',
);
assert.deepEqual(
  resolveResumePosition(ids, 2, undefined, survivingWithCurrentGone),
  { index: 2, currentSurvived: false },
  'legacy records lose the saved position when the indexed track is gone',
);
assert.deepEqual(
  resolveResumePosition(ids, 1, 102, new Set()),
  { index: -1, currentSurvived: false },
  'no survivors at all restores nothing',
);

// ---- normalizeResume keeps -1 and currentTrackId through settings.json -------

{
  const dir = mkdtempSync(join(tmpdir(), 'newamp-resume-'));
  try {
    const store = new SettingsStore(join(dir, 'settings.json'));
    store.set({ resumeState: { queueTrackIds: [11, 12, 13], index: -1, currentTrackId: null, currentTime: 0, mode: 'normal', updatedAt: 1 } });
    const idle = store.get().resumeState;
    assert.equal(idle.index, -1, 'settings must keep an idle -1 index instead of clamping it to 0');
    assert.equal(idle.currentTrackId, null, 'settings must keep a null current id');

    store.set({ resumeState: { queueTrackIds: [11, 12, 13], index: 1, currentTrackId: 12, currentTime: 30, mode: 'normal', updatedAt: 1 } });
    const active = store.get().resumeState;
    assert.equal(active.index, 1);
    assert.equal(active.currentTrackId, 12, 'settings must round-trip the current track id');

    store.set({ resumeState: { queueTrackIds: [11, 12, 13], index: 1, currentTime: 30, mode: 'normal', updatedAt: 1 } });
    const legacy = store.get().resumeState;
    assert.equal(legacy.index, 1);
    assert.equal('currentTrackId' in legacy, false, 'a record without currentTrackId stays without it, so restore takes the legacy path');

    store.set({ resumeState: { queueTrackIds: [11, 12, 13], index: 7, currentTrackId: -4, currentTime: 30, mode: 'normal', updatedAt: 1 } });
    const clamped = store.get().resumeState;
    assert.equal(clamped.index, 2, 'an index past the end is still clamped');
    assert.equal(clamped.currentTrackId, null, 'a nonsense current id normalizes to idle rather than a bogus id');

    const serverTrack = {
      id: -44,
      path: 'newamp://server/remembered/remote%2F1/Remote.flac',
      title: 'Remote',
      artist: 'Remote Artist',
      album: 'Remote Album',
      albumArtist: 'Remote Album Artist',
      trackNo: null,
      discNo: null,
      year: null,
      genre: null,
      duration: 200,
      bitrate: 1411000,
      sampleRate: 48000,
      size: 34_000_000,
    };
    store.set({
      resumeState: {
        queueTrackIds: [11, -44],
        queue: [
          { kind: 'local', trackId: 11 },
          { kind: 'music-server', connectionId: 'remembered', itemId: 'remote/1', track: serverTrack },
        ],
        index: 1,
        currentTrackId: -44,
        currentTime: 12,
        mode: 'shuffle-repeat-all',
        updatedAt: 1,
      },
    });
    const serverResume = store.get().resumeState;
    assert.deepEqual(serverResume.queueTrackIds, [11, -44], 'settings must preserve mixed local/server resume order');
    assert.equal(serverResume.currentTrackId, -44, 'settings must keep a server currentTrackId that belongs to the queue');
    assert.equal(serverResume.queue[1].kind, 'music-server');
    assert.equal(serverResume.queue[1].connectionId, 'remembered');
    assert.equal(serverResume.queue[1].itemId, 'remote/1');
    assert.deepEqual(
      Object.keys(serverResume.queue[1].track).sort(),
      [
        'album',
        'albumArtist',
        'artist',
        'bitrate',
        'discNo',
        'duration',
        'genre',
        'id',
        'path',
        'sampleRate',
        'size',
        'title',
        'trackNo',
        'year',
      ],
      'server resume descriptors should stay credential-free metadata, not full connection/session state',
    );

    store.set({
      resumeState: {
        queueTrackIds: [-45],
        queue: [{
          kind: 'music-server',
          connectionId: 'remembered',
          itemId: 'remote/1',
          track: { ...serverTrack, id: -45, path: 'file:///C:/Users/evela/Music/secret.flac' },
        }],
        index: 0,
        currentTrackId: -45,
        currentTime: 12,
        mode: 'normal',
        updatedAt: 1,
      },
    });
    assert.equal(store.get().resumeState, null, 'settings must reject server resume entries that point at arbitrary paths');
    store.flushSync();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Empty saved queue: -1.
assert.equal(remapResumeIndex([], 0, new Set()), -1, 'an empty saved queue should report -1');

// --- Source assertions for the two glue-code fixes that can't run outside
// a DOM/Electron renderer (batch IPC call + engine release-on-remove).
const [storeSource, settingsSource, engineSource, packageSource] = await Promise.all([
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/settings.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/audio/engine.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(
  storeSource,
  /resolveResumePosition\(\s*savedIds,\s*resumeState\.index,\s*resumeState\.currentTrackId,\s*new Set\(tracks\.map\(\(track\) => track\.id\)\),?\s*\)/,
  'restorePlaybackSession should resolve the resume position by track id (idle stays idle)',
);
assert.match(storeSource, /playbackResumeStateForQueueSnapshot/, 'persistPlaybackSession should build a sanitized resume snapshot');
assert.match(storeSource, /currentTrackId = currentId !== null && queueTrackIds\.includes\(currentId\)/, 'persisted currentTrackId should belong to the saved queue');
assert.match(storeSource, /localIds\.length \? api\.getTracksByIds\(localIds\)/, 'restorePlaybackSession should batch-fetch only local tracks');
assert.match(storeSource, /hasServerEntries \? api\.getMusicServers\(\)/, 'restorePlaybackSession should read available remembered server connections');
assert.doesNotMatch(
  storeSource,
  /queueTrackIds\.map\(\(id\) => api\.getTrack\(id\)/,
  'restorePlaybackSession should no longer fire one getTrack() IPC call per queued track',
);
assert.match(settingsSource, /normalizeResumeQueueEntry/, 'settings should normalize structured resume queue entries');
assert.match(settingsSource, /parseMusicServerStreamUrl/, 'settings should reject arbitrary paths for server resume entries');

assert.match(engineSource, /unload\(\): void \{/, 'AudioEngine should expose an unload() that releases src/trackId');
assert.match(
  engineSource.match(/unload\(\): void \{[\s\S]*?\n {2}\}/)?.[0] ?? '',
  /src: null,\s*\n\s*trackId: null,/,
  'unload() should clear src and trackId so a later togglePlay() cold-starts instead of resuming a released track',
);

const removeQueuedTrackBody = storeSource.match(/removeQueuedTrack: async \(removeIndex\) => \{[\s\S]*?\n {4}\},/)?.[0] ?? '';
assert.ok(removeQueuedTrackBody, 'removeQueuedTrack action should be present');
assert.match(
  removeQueuedTrackBody,
  /engine\.unload\(\)/,
  'removing the current track while paused must release the engine instead of leaving it holding the removed track',
);

const refillBody = storeSource.match(/refillAutoDjQueue: async \(force = false\) => \{[\s\S]*?\n {4}\},/)?.[0] ?? '';
assert.ok(refillBody, 'refillAutoDjQueue action should be present');
assert.match(
  refillBody,
  /const fresh = get\(\);/,
  'refillAutoDjQueue should re-read state after its await instead of committing onto the pre-await snapshot',
);
assert.match(
  refillBody,
  /set\(\{ queue: \[\.\.\.fresh\.queue, \.\.\.additions\] \}\)/,
  'refillAutoDjQueue should commit its additions onto the freshly re-read queue',
);

assert.match(packageSource, /"test:session-restore-integrity"/, 'package.json should expose the session restore integrity test');

console.log(JSON.stringify({ ok: true }, null, 2));
