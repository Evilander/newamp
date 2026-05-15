import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PodcastStore, parsePodcastFeed } from '../dist-electron/electron/podcasts.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'podcast-smoke');
const storePath = join(smokeRoot, 'podcasts.json');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const feedUrl = 'https://example.com/newamp.xml';
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title><![CDATA[Newamp Sessions]]></title>
    <description>Deep listening for desktop people.</description>
    <link>https://example.com/show</link>
    <itunes:image href="https://example.com/show.jpg" />
    <item>
      <guid>episode-one</guid>
      <title><![CDATA[The First Set]]></title>
      <description><![CDATA[Intro and long-form playback.]]></description>
      <pubDate>Fri, 15 May 2026 05:00:00 GMT</pubDate>
      <itunes:duration>01:02:03</itunes:duration>
      <enclosure url="https://cdn.example.com/first.mp3" type="audio/mpeg" length="123" />
    </item>
    <item>
      <guid>episode-two</guid>
      <title>The Second Set</title>
      <link>https://example.com/second</link>
      <pubDate>Fri, 15 May 2026 06:00:00 GMT</pubDate>
      <enclosure url="https://cdn.example.com/second.ogg" type="audio/ogg" />
    </item>
  </channel>
</rss>`;

const parsed = parsePodcastFeed(xml, feedUrl, Date.parse('2026-05-15T07:00:00.000Z'));
assert.equal(parsed.feed.title, 'Newamp Sessions');
assert.equal(parsed.feed.url, feedUrl);
assert.equal(parsed.feed.imageUrl, 'https://example.com/show.jpg');
assert.equal(parsed.feed.episodeCount, 2);
assert.equal(parsed.episodes.length, 2);
assert.equal(parsed.episodes[0].title, 'The First Set');
assert.equal(parsed.episodes[0].audioUrl, 'https://cdn.example.com/first.mp3');
assert.equal(parsed.episodes[0].duration, 3723);
assert.equal(parsed.episodes[1].audioUrl, 'https://cdn.example.com/second.ogg');

const store = new PodcastStore(storePath);
store.upsert(parsed.feed, parsed.episodes);
let subscriptions = store.listSubscriptions();
assert.equal(subscriptions.length, 1);
assert.equal(subscriptions[0].feed.title, 'Newamp Sessions');
assert.equal(subscriptions[0].episodes.length, 2);

const refreshed = parsePodcastFeed(xml.replace('The First Set', 'The First Set Edited'), feedUrl, Date.parse('2026-05-15T07:30:00.000Z'));
store.upsert(refreshed.feed, refreshed.episodes);
subscriptions = new PodcastStore(storePath).listSubscriptions();
assert.equal(subscriptions[0].episodes[0].title, 'The First Set Edited');
assert.equal(subscriptions[0].feed.lastFetchedAt, Date.parse('2026-05-15T07:30:00.000Z'));

store.remove(feedUrl);
assert.equal(store.listSubscriptions().length, 0);

const [typesSource, mainSource, preloadSource, apiSource, appSource, sidebarSource, podcastViewSource, indexHtml, backupSource, packageSource] =
  await Promise.all([
    readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/views/PodcastView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../electron/support-backup.ts', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);

assert.match(typesSource, /PodcastEpisode/, 'shared types should expose podcast episodes');
assert.match(typesSource, /subscribePodcastFeed/, 'shared API should expose podcast subscription');
assert.match(mainSource, /podcasts:subscribe/, 'main process should register podcast subscription IPC');
assert.match(preloadSource, /subscribePodcastFeed/, 'preload should expose podcast APIs');
assert.match(apiSource, /listPodcastSubscriptions/, 'browser-safe API should include podcast APIs');
assert.match(appSource, /PodcastView/, 'App should route to PodcastView');
assert.match(sidebarSource, /Podcasts/, 'Sidebar should expose Podcasts');
assert.match(podcastViewSource, /playEpisode/, 'PodcastView should play episodes through Newamp');
assert.match(podcastViewSource, /Add feed/, 'PodcastView should let users add RSS feeds');
assert.match(indexHtml, /media-src[^"]*https:/, 'CSP media-src should allow HTTPS podcast audio');
assert.match(backupSource, /podcasts\.json/, 'support backups should include podcast subscriptions');
assert.match(packageSource, /smoke:podcast/, 'package scripts should include podcast smoke');

console.log(JSON.stringify({ ok: true, feed: parsed.feed, episodeCount: parsed.episodes.length }, null, 2));
