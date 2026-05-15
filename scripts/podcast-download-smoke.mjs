import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  downloadPodcastEpisode,
  PodcastStore,
  parsePodcastFeed,
} from '../dist-electron/electron/podcasts.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'podcast-download-smoke');
const storePath = join(smokeRoot, 'podcasts.json');
const downloadsPath = join(smokeRoot, 'podcast-downloads');
const feedUrl = 'https://example.com/download.xml';

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });

const audio = Buffer.from('newamp podcast download fixture');
const server = createServer((request, response) => {
  if (request.url !== '/episode.mp3') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'content-type': 'audio/mpeg',
    'content-length': String(audio.byteLength),
  });
  response.end(audio);
});

await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const port = server.address().port;
const audioUrl = `http://127.0.0.1:${port}/episode.mp3`;

try {
  const xml = `<rss version="2.0"><channel><title>Download Show</title><item><guid>download-one</guid><title>Download One</title><enclosure url="${audioUrl}" type="audio/mpeg" /></item></channel></rss>`;
  const store = new PodcastStore(storePath);
  const parsed = parsePodcastFeed(xml, feedUrl, Date.parse('2026-05-15T10:00:00.000Z'));
  store.upsert(parsed.feed, parsed.episodes);
  const episode = store.listSubscriptions()[0].episodes[0];

  const downloaded = await downloadPodcastEpisode(store, {
    feedUrl,
    episodeId: episode.id,
    downloadsPath,
    downloadedAt: Date.parse('2026-05-15T10:05:00.000Z'),
  });

  assert.ok(downloaded?.downloadPath?.endsWith('.mp3'), 'download should keep a useful audio extension');
  assert.equal(downloaded?.downloadBytes, audio.byteLength);
  assert.equal(downloaded?.downloadedAt, Date.parse('2026-05-15T10:05:00.000Z'));
  assert.ok(downloaded?.downloadPath && existsSync(downloaded.downloadPath));
  assert.equal(String(await readFile(downloaded.downloadPath)), String(audio));

  const reloaded = new PodcastStore(storePath).listSubscriptions()[0].episodes[0];
  assert.equal(reloaded.downloadPath, downloaded.downloadPath, 'download path should persist');
  assert.equal(reloaded.downloadBytes, audio.byteLength);

  const cleared = store.clearDownload(feedUrl, episode.id);
  assert.equal(cleared?.downloadPath, null);
  assert.equal(cleared?.downloadBytes, null);
  assert.equal(existsSync(downloaded.downloadPath), false, 'clearing a download should remove the local audio file');

  const [typesSource, mainSource, preloadSource, apiSource, podcastViewSource, playerStoreSource, packageSource] =
    await Promise.all([
      readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
      readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
      readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/views/PodcastView.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ]);

  assert.match(typesSource, /downloadPodcastEpisode/, 'shared API should expose podcast downloads');
  assert.match(typesSource, /downloadPath/, 'podcast episodes should expose download path');
  assert.match(mainSource, /podcasts:download/, 'main process should register podcast download IPC');
  assert.match(preloadSource, /downloadPodcastEpisode/, 'preload should expose podcast downloads');
  assert.match(apiSource, /removePodcastEpisodeDownload/, 'browser-safe API should include podcast download removal');
  assert.match(podcastViewSource, /Download/, 'Podcast view should expose downloads');
  assert.match(podcastViewSource, /Remove file/, 'Podcast view should expose download removal');
  assert.match(playerStoreSource, /downloadPath \?\? episode\.audioUrl/, 'podcast playback should prefer downloaded files');
  assert.match(packageSource, /smoke:podcast-download/, 'package scripts should include podcast download smoke');

  console.log(JSON.stringify({ ok: true, downloaded }, null, 2));
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
