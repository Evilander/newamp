// One invalid PodcastStore subscription
// entry — a literal `null`, or a feed URL normalizeFeedUrl rejects — must not
// quarantine the whole podcasts.json. Only that entry is dropped, the valid
// ones load normally, the file is left untouched (not renamed away), and a
// recovery event says so instead of the drop being silent.
// Run: npm run build:electron && node scripts/podcast-bad-subscription-entry-test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PodcastStore } from '../dist-electron/electron/podcasts.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'podcast-bad-subscription-entry-test');
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const validSubscription = {
  feed: {
    id: 'valid-feed',
    url: 'https://example.invalid/valid-feed',
    title: 'Valid Show',
    description: null,
    siteUrl: null,
    imageUrl: null,
    episodeCount: 1,
    lastFetchedAt: 0,
  },
  episodes: [{
    id: 'ep-1',
    feedUrl: 'https://example.invalid/valid-feed',
    feedTitle: 'Valid Show',
    title: 'Episode One',
    description: null,
    audioUrl: 'https://example.invalid/ep1.mp3',
    siteUrl: null,
    imageUrl: null,
    publishedAt: null,
    duration: null,
    progressSeconds: 0,
    completed: false,
    lastPlayedAt: null,
    downloadPath: null,
    downloadedAt: null,
    downloadBytes: null,
  }],
};

// 1. A literal `null` entry in the array must not crash the whole load —
//    the old per-item normalizer threw on `null.feed` with nothing catching
//    it, which quarantined every subscription, not just the null one.
{
  const dir = join(smokeRoot, 'null-entry');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'podcasts.json');
  const original = JSON.stringify({ subscriptions: [null, validSubscription] }, null, 2);
  writeFileSync(file, original, 'utf8');

  const store = new PodcastStore(file);
  assert.equal(store.listSubscriptions().length, 1, 'the valid subscription must still load');
  assert.equal(store.listSubscriptions()[0].feed.title, 'Valid Show');
  assert.equal(store.recoveryEvents.length, 1, 'the drop must be recorded');
  assert.equal(store.recoveryEvents[0].store, 'podcasts');
  assert.equal(store.recoveryEvents[0].backupPath, file, 'nothing was quarantined — the file is untouched');
  assert.match(store.recoveryEvents[0].reason, /dropped 1 invalid subscription/);
  assert.equal(readFileSync(file, 'utf8'), original, 'the original bytes must survive dropping one bad entry');
  const quarantined = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  assert.deepEqual(quarantined, [], 'a dropped entry must not trigger a full-file quarantine');
}

// 2. A malformed feed URL (throws inside normalizeFeedUrl, which the old
//    per-item normalizer never caught) must drop only that subscription.
{
  const dir = join(smokeRoot, 'bad-url');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'podcasts.json');
  const badUrlSubscription = {
    feed: { ...validSubscription.feed, url: 'not a valid url', title: 'Broken Show' },
    episodes: validSubscription.episodes,
  };
  const original = JSON.stringify({ subscriptions: [badUrlSubscription, validSubscription] }, null, 2);
  writeFileSync(file, original, 'utf8');

  const store = new PodcastStore(file);
  assert.equal(store.listSubscriptions().length, 1);
  assert.equal(store.listSubscriptions()[0].feed.title, 'Valid Show');
  assert.equal(store.recoveryEvents.length, 1);
  assert.match(store.recoveryEvents[0].reason, /dropped 1 invalid subscription/);
  assert.equal(readFileSync(file, 'utf8'), original, 'the original bytes must survive dropping the malformed entry');
}

// 3. Two bad entries in the same file are both dropped and counted together.
{
  const dir = join(smokeRoot, 'two-bad');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'podcasts.json');
  const original = JSON.stringify({ subscriptions: [null, 'not even an object', validSubscription] }, null, 2);
  writeFileSync(file, original, 'utf8');

  const store = new PodcastStore(file);
  assert.equal(store.listSubscriptions().length, 1);
  assert.equal(store.recoveryEvents.length, 1);
  assert.match(store.recoveryEvents[0].reason, /dropped 2 invalid subscription entries/);
}

// 4. All-valid content still loads with no recovery event at all — the fix
//    must not start reporting noise for files that were never a problem.
{
  const dir = join(smokeRoot, 'all-valid');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'podcasts.json');
  writeFileSync(file, JSON.stringify({ subscriptions: [validSubscription] }, null, 2), 'utf8');
  const store = new PodcastStore(file);
  assert.equal(store.listSubscriptions().length, 1);
  assert.equal(store.recoveryEvents.length, 0);
}

// 5. A top-level shape that isn't even an array is still genuine corruption
//    and is still quarantined — the per-entry tolerance above must not widen
//    into tolerating a wholesale broken file.
{
  const dir = join(smokeRoot, 'not-an-array');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'podcasts.json');
  writeFileSync(file, JSON.stringify({ subscriptions: 'nope' }), 'utf8');
  const store = new PodcastStore(file);
  assert.equal(store.listSubscriptions().length, 0);
  assert.equal(store.recoveryEvents.length, 1);
  assert.ok(store.recoveryEvents[0].backupPath.includes('.corrupt-'), 'a genuinely broken shape must still be quarantined');
}

await rm(smokeRoot, { recursive: true, force: true });
console.log('[podcast-bad-subscription-entry-test] PASS: one bad subscription entry no longer quarantines the whole file');
