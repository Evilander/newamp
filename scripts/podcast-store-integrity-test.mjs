// Podcast store and feed parser: entity decoding, refresh keeping episodes the user has used,
// one download per episode at a time, and downloads deleted only from the downloads folder.
// Run: node scripts/podcast-store-integrity-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NEWAMP_ALLOW_PRIVATE_PODCAST_HOSTS = '1';
mkdirSync(resolve('tmp'), { recursive: true });
await build({
  entryPoints: [resolve('electron/podcasts.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: resolve('tmp/podcast-store-integrity-bundle.mjs'),
  logLevel: 'silent',
});
const { PodcastStore, parsePodcastFeed, downloadPodcastEpisode } = await import(
  pathToFileURL(resolve('tmp/podcast-store-integrity-bundle.mjs')).href
);

const feedUrl = 'https://example.com/show.xml';
const item = (guid, extra = '') => `<item><guid>${guid}</guid><title>${guid}${extra}</title><enclosure url="https://example.com/${guid}.mp3" type="audio/mpeg"/></item>`;

// A malformed numeric entity no longer fails the whole feed, and &amp; is decoded once.
{
  const xml = `<rss><channel><title>Show &#99999999999; &amp;lt;b&amp;gt; &#x1F600; &#55357;</title>${item('one')}</channel></rss>`;
  const parsed = parsePodcastFeed(xml, feedUrl);
  assert.equal(parsed.feed.title, 'Show � &lt;b&gt; \u{1F600} �');
  assert.equal(parsed.episodes.length, 1);
}

const dir = mkdtempSync(join(tmpdir(), 'podcast-integrity-'));
const file = join(dir, 'podcasts.json');
const store = new PodcastStore(file);

// Refresh keeps used episodes that left the feed, and drops unused ones.
{
  const first = parsePodcastFeed(`<rss><channel><title>Show</title>${item('keep-dl')}${item('keep-progress')}${item('gone')}${item('stay')}</channel></rss>`, feedUrl);
  store.upsert(first.feed, first.episodes);
  const byTitle = (title) => store.listSubscriptions()[0].episodes.find((episode) => episode.title === title);
  store.markDownloaded({ feedUrl, episodeId: byTitle('keep-dl').id, downloadPath: join(dir, 'podcast-downloads', 'x', 'keep.mp3'), downloadBytes: 10 });
  store.updateProgress({ feedUrl, episodeId: byTitle('keep-progress').id, position: 42, duration: 1000 });
  const second = parsePodcastFeed(`<rss><channel><title>Show</title>${item('stay')}${item('fresh')}</channel></rss>`, feedUrl);
  const next = store.upsert(second.feed, second.episodes);
  const titles = next.episodes.map((episode) => episode.title).sort();
  assert.deepEqual(titles, ['fresh', 'keep-dl', 'keep-progress', 'stay']);
  assert.equal(next.feed.episodeCount, 4);
  assert.equal(next.episodes.find((episode) => episode.title === 'keep-progress').progressSeconds, 42);
}

// clearDownload only deletes inside the downloads folder.
{
  const outside = join(dir, 'Documents.pdf');
  writeFileSync(outside, 'precious');
  const inside = join(dir, 'podcast-downloads', 'feed', 'ep.mp3');
  mkdirSync(join(dir, 'podcast-downloads', 'feed'), { recursive: true });
  writeFileSync(inside, 'audio');
  const [a, b] = store.listSubscriptions()[0].episodes.filter((episode) => !episode.downloadPath).slice(0, 2);
  store.markDownloaded({ feedUrl, episodeId: a.id, downloadPath: outside, downloadBytes: 8 });
  store.markDownloaded({ feedUrl, episodeId: b.id, downloadPath: inside, downloadBytes: 5 });
  assert.equal(store.clearDownload(feedUrl, a.id).downloadPath, null);
  assert.ok(existsSync(outside), 'a stored path outside the downloads folder must survive Remove download');
  store.clearDownload(feedUrl, b.id);
  assert.equal(existsSync(inside), false, 'a download inside the folder is removed');
}

// Two requests for one episode share a single download.
{
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    setTimeout(() => res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(Buffer.alloc(2048, 1)), 150);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const audioUrl = `http://127.0.0.1:${server.address().port}/ep.mp3`;
  try {
    const dlFeed = 'https://example.com/dl.xml';
    const parsed = parsePodcastFeed(`<rss><channel><title>DL</title><item><guid>g</guid><title>g</title><enclosure url="${audioUrl}" type="audio/mpeg"/></item></channel></rss>`, dlFeed);
    store.upsert(parsed.feed, parsed.episodes);
    const episode = store.get(dlFeed).episodes[0];
    const input = { feedUrl: dlFeed, episodeId: episode.id, downloadsPath: join(dir, 'podcast-downloads') };
    const [one, two] = await Promise.all([downloadPodcastEpisode(store, input), downloadPodcastEpisode(store, input)]);
    assert.equal(requests, 1, 'concurrent downloads of one episode should make one request');
    assert.equal(one.downloadPath, two.downloadPath);
    assert.ok(existsSync(one.downloadPath));
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

console.log('podcast-store-integrity-test: PASS');
process.exit(0);
