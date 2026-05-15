import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PodcastStore, parsePodcastFeed } from '../dist-electron/electron/podcasts.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'podcast-progress-smoke');
const storePath = join(smokeRoot, 'podcasts.json');
const feedUrl = 'https://example.com/progress.xml';

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

function feedXml(title = 'Long Drive') {
  return `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
    <channel>
      <title>Progress Show</title>
      <item>
        <guid>same-guid</guid>
        <title>${title}</title>
        <itunes:duration>3600</itunes:duration>
        <enclosure url="https://cdn.example.com/long-drive.mp3" type="audio/mpeg" />
      </item>
    </channel>
  </rss>`;
}

const store = new PodcastStore(storePath);
const parsed = parsePodcastFeed(feedXml(), feedUrl, Date.parse('2026-05-15T08:00:00.000Z'));
store.upsert(parsed.feed, parsed.episodes);

const episode = store.listSubscriptions()[0].episodes[0];
assert.equal(episode.progressSeconds, 0);
assert.equal(episode.completed, false);

const progressed = store.updateProgress({
  feedUrl,
  episodeId: episode.id,
  position: 1875.4,
  duration: 3600,
  completed: false,
  updatedAt: Date.parse('2026-05-15T08:30:00.000Z'),
});
assert.equal(progressed?.progressSeconds, 1875);
assert.equal(progressed?.completed, false);
assert.equal(progressed?.lastPlayedAt, Date.parse('2026-05-15T08:30:00.000Z'));

store.upsert(
  parsePodcastFeed(feedXml('Long Drive Edited'), feedUrl, Date.parse('2026-05-15T09:00:00.000Z')).feed,
  parsePodcastFeed(feedXml('Long Drive Edited'), feedUrl, Date.parse('2026-05-15T09:00:00.000Z')).episodes,
);

const refreshed = new PodcastStore(storePath).listSubscriptions()[0].episodes[0];
assert.equal(refreshed.title, 'Long Drive Edited');
assert.equal(refreshed.progressSeconds, 1875, 'feed refresh should preserve episode progress');
assert.equal(refreshed.completed, false);

const completed = store.updateProgress({
  feedUrl,
  episodeId: episode.id,
  position: 3599,
  duration: 3600,
  completed: true,
});
assert.equal(completed?.progressSeconds, 0, 'completed episodes should reset resume position');
assert.equal(completed?.completed, true);

const [typesSource, mainSource, preloadSource, apiSource, storeSource, podcastViewSource, packageSource] = await Promise.all([
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/PodcastView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(typesSource, /PodcastProgressInput/, 'shared types should expose podcast progress input');
assert.match(typesSource, /progressSeconds/, 'podcast episodes should expose resume progress');
assert.match(mainSource, /podcasts:progress/, 'main process should register podcast progress IPC');
assert.match(preloadSource, /updatePodcastEpisodeProgress/, 'preload should expose podcast progress updates');
assert.match(apiSource, /updatePodcastEpisodeProgress/, 'browser-safe API should include podcast progress updates');
assert.match(storeSource, /playPodcastEpisode/, 'player store should have a podcast-aware play action');
assert.match(storeSource, /activePodcastEpisode/, 'player store should remember the active podcast episode');
assert.match(podcastViewSource, /Continue/, 'Podcast view should expose episode continuation');
assert.match(podcastViewSource, /Progress/, 'Podcast view should show progress');
assert.match(packageSource, /smoke:podcast-progress/, 'package scripts should include podcast progress smoke');

console.log(JSON.stringify({ ok: true, episodeId: episode.id, completed }, null, 2));
