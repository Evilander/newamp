// Radio Brain playlists must reach the whole library. /random.m3u used to
// shuffle only the first 5,000 tracks by artist (about the first tenth of a
// 58k library), and /library.m3u stopped at the same 5,000 with no way to ask
// for more. Runs the real request handler against a fake library, no listener:
//   1. /random.m3u draws from every page of ids, including past the 100k
//      single-query cap,
//   2. /library.m3u and /tag/<name>.m3u are served in pages (?offset=&limit=),
//      the limit is clamped, bad values fall back to the first page, and a page
//      that has more says where it continues,
//   3. the status page links carry the token so they open from the browser.
//
// Run with: node scripts/radio-brain-pages-test.mjs

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: ['electron/radio-brain.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
});
const { RadioBrain } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64')
);

const TOKEN = 'pages-test-token';
const ids = (n) => Array.from({ length: n }, (_, i) => i + 1);

function makeBrain({ trackCount, tagTrackCount = 0 }) {
  const all = ids(trackCount);
  const tagIds = ids(tagTrackCount);
  const library = {
    getStats: () => ({ tracks: trackCount, albums: 1, artists: 1 }),
    getTagSummaries: () => [{ name: 'big_tag', trackCount: tagTrackCount }],
    // Same clamp the real LibraryStore applies to a single query.
    getTrackIds: ({ limit = 1000, offset = 0 } = {}) => {
      const capped = Math.max(1, Math.min(limit, 100000));
      return all.slice(offset, offset + capped);
    },
    getTrackIdsByTag: () => tagIds,
    getTracksByIdsInOrder: (wanted) =>
      wanted.map((id) => ({ id, title: `T${id}`, artist: 'A', duration: 60, path: `/x/${id}.mp3` })),
    getTrack: () => null,
    getArt: () => null,
  };
  return new RadioBrain({
    library,
    port: 17999,
    getToken: () => TOKEN,
    getNowPlaying: () => null,
    onNowPlaying: () => () => undefined,
    control: () => true,
  });
}

async function get(brain, path, { token = true } = {}) {
  const url = token ? `${path}${path.includes('?') ? '&' : '?'}token=${TOKEN}` : path;
  const req = new EventEmitter();
  Object.assign(req, { method: 'GET', url, headers: { host: '127.0.0.1:17999' } });
  const out = { status: 0, body: '' };
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader() {},
    end(chunk) {
      out.status = this.statusCode;
      out.body = chunk === undefined ? '' : String(chunk);
    },
  };
  await brain.handle(req, res);
  return out;
}

const trackIdsIn = (body) =>
  body
    .split('\n')
    .map((line) => /\/audio\/(\d+)\?token=/.exec(line))
    .filter(Boolean)
    .map((match) => Number(match[1]));
const nextPageLine = (body) => body.split('\n').find((line) => line.startsWith('# Next page:'));

// 1. Random draws from the whole library, across id pages.
{
  const brain = makeBrain({ trackCount: 230_000 });
  const seenAcrossFetches = new Set();
  for (let run = 0; run < 3; run++) {
    const { status, body } = await get(brain, '/random.m3u');
    assert.equal(status, 200);
    const picked = trackIdsIn(body);
    assert.equal(picked.length, 200, 'random playlist is 200 tracks');
    assert.equal(new Set(picked).size, 200, 'random playlist has no repeats');
    const beyondFirstPage = picked.filter((id) => id > 5000).length;
    assert.ok(beyondFirstPage > 150, `most of a 230k library lies past track 5,000 (got ${beyondFirstPage} of 200)`);
    assert.ok(picked.some((id) => id > 100_000), 'ids past the 100k single-query cap are reachable');
    assert.ok(picked.some((id) => id > 200_000), 'ids from the third id page are reachable');
    for (const id of picked) seenAcrossFetches.add(id);
  }
  assert.ok(seenAcrossFetches.size > 500, 'each fetch is a fresh draw');
}

// Small libraries still return every track.
{
  const brain = makeBrain({ trackCount: 7 });
  const { body } = await get(brain, '/random.m3u');
  assert.deepEqual(trackIdsIn(body).sort((a, b) => a - b), ids(7));
}

// 2. Library pages.
{
  const brain = makeBrain({ trackCount: 12_000 });

  const first = await get(brain, '/library.m3u');
  assert.deepEqual(trackIdsIn(first.body), ids(5000), 'default page is the first 5,000');
  const next = nextPageLine(first.body);
  assert.ok(next, 'a page with more says where it continues');
  assert.match(next, /\/library\.m3u\?offset=5000&limit=5000&token=pages-test-token$/);

  const second = await get(brain, '/library.m3u?offset=5000');
  assert.deepEqual(trackIdsIn(second.body), ids(10_000).slice(5000), 'offset reaches the second page');
  assert.match(nextPageLine(second.body) ?? '', /offset=10000&limit=5000/);

  const last = await get(brain, '/library.m3u?offset=10000');
  assert.deepEqual(trackIdsIn(last.body), ids(12_000).slice(10_000), 'last page holds the remainder');
  assert.equal(nextPageLine(last.body), undefined, 'the last page has no next-page line');

  const past = await get(brain, '/library.m3u?offset=50000');
  assert.equal(past.status, 200);
  assert.deepEqual(trackIdsIn(past.body), [], 'an offset past the end is an empty playlist');

  const small = await get(brain, '/library.m3u?offset=100&limit=10');
  assert.deepEqual(trackIdsIn(small.body), ids(110).slice(100));
  assert.match(nextPageLine(small.body) ?? '', /offset=110&limit=10/);

  const clamped = await get(brain, '/library.m3u?limit=999999');
  assert.equal(trackIdsIn(clamped.body).length, 5000, 'limit is clamped to the page cap');

  for (const bad of ['offset=-5', 'offset=abc&limit=xyz', 'limit=0']) {
    const fallback = await get(brain, `/library.m3u?${bad}`);
    assert.deepEqual(trackIdsIn(fallback.body), ids(5000), `${bad} falls back to the first page`);
  }

  const exact = makeBrain({ trackCount: 5000 });
  assert.equal(nextPageLine((await get(exact, '/library.m3u')).body), undefined, 'a library of exactly one page has no next page');
}

// Tag playlists page the same way.
{
  const brain = makeBrain({ trackCount: 10, tagTrackCount: 7000 });
  const first = await get(brain, '/tag/big_tag.m3u');
  assert.deepEqual(trackIdsIn(first.body), ids(5000));
  assert.match(nextPageLine(first.body) ?? '', /\/tag\/big_tag\.m3u\?offset=5000&limit=5000&token=/);
  const second = await get(brain, '/tag/big_tag.m3u?offset=5000');
  assert.deepEqual(trackIdsIn(second.body), ids(7000).slice(5000));
  assert.equal(nextPageLine(second.body), undefined);
}

// 3. Status page links open without a header.
{
  const brain = makeBrain({ trackCount: 10, tagTrackCount: 3 });
  const page = await get(brain, '/');
  assert.equal(page.status, 200);
  assert.match(page.body, new RegExp(`href="/library\\.m3u\\?token=${TOKEN}"`));
  assert.match(page.body, new RegExp(`href="/random\\.m3u\\?token=${TOKEN}"`));
  assert.match(page.body, new RegExp(`href="/tag/big_tag\\.m3u\\?token=${TOKEN}"`));
  const anonymous = await get(brain, '/library.m3u', { token: false });
  assert.equal(anonymous.status, 401, 'playlists stay token-gated');
}

console.log('[radio-brain-pages-test] PASS');
