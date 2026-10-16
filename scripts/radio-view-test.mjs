// Radio view behaviour that does not need a window:
//   1. the genre chips are a short fixed list of plain English tags, and the
//      raw directory tags stay reachable: free-text search matches station
//      names AND tags, chips match their tag exactly,
//   2. a station only counts as playing once play() succeeds, and each way a
//      stream can fail comes back with its own reason (an attempt that was
//      only superseded stays silent),
//   3. RadioView marks a station live only from that result.
//
// Run with: node scripts/radio-view-test.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: ['src/api/radiobrowser.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
  alias: { '@shared': resolve('shared') },
});
const {
  CURATED_RADIO_TAGS,
  interleaveStations,
  playFailureDetail,
  searchStations,
  searchStationsByText,
  tuneStation,
} = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

const station = (id, extra = {}) => ({
  stationuuid: id,
  name: `Station ${id}`,
  url_resolved: `http://example.test/${id}`,
  homepage: '',
  favicon: '',
  country: '',
  language: '',
  tags: '',
  bitrate: 128,
  codec: 'MP3',
  ...extra,
});

const realFetch = globalThis.fetch;
function mockDirectory(respond) {
  const requests = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    const rows = respond(parsed);
    if (rows === 'fail') return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => rows };
  };
  return requests;
}

// 1. Chips.
{
  assert.ok(CURATED_RADIO_TAGS.length >= 10 && CURATED_RADIO_TAGS.length <= 20, 'a short list of chips');
  assert.equal(new Set(CURATED_RADIO_TAGS).size, CURATED_RADIO_TAGS.length, 'no duplicate chips');
  for (const tag of CURATED_RADIO_TAGS) {
    assert.match(tag, /^[a-z0-9][a-z0-9 -]*$/, `"${tag}" should be a plain lowercase English tag`);
  }
  for (const genre of ['pop', 'rock', 'jazz', 'classical', 'electronic', 'hip-hop']) {
    assert.ok(CURATED_RADIO_TAGS.includes(genre), `${genre} is a common genre and should be a chip`);
  }
}

// Chips search the exact tag; the default stays a substring match.
{
  const requests = mockDirectory(() => []);
  await searchStations({ tag: 'pop', tagExact: true });
  await searchStations({ tag: 'pop' });
  assert.equal(requests[0].searchParams.get('tag'), 'pop');
  assert.equal(requests[0].searchParams.get('tagExact'), 'true');
  assert.equal(requests[1].searchParams.get('tag'), 'pop');
  assert.equal(requests[1].searchParams.has('tagExact'), false);
}

// Free text reaches station names and raw tags.
{
  const requests = mockDirectory((url) =>
    url.searchParams.has('name')
      ? [station('n1'), station('shared'), station('n2')]
      : [station('t1'), station('shared'), station('t2')],
  );
  const rows = await searchStationsByText('música regional', { limit: 80 });
  const byName = requests.find((url) => url.searchParams.has('name'));
  const byTag = requests.find((url) => url.searchParams.has('tag'));
  assert.equal(byName.searchParams.get('name'), 'música regional');
  assert.equal(byTag.searchParams.get('tag'), 'música regional', 'a raw tag typed into the box is searched as a tag');
  assert.equal(byTag.searchParams.has('tagExact'), false, 'typed tags match as substrings');
  assert.deepEqual(rows.map((r) => r.id), ['n1', 't1', 'shared', 'n2', 't2'], 'name and tag hits alternate, duplicates collapse');

  const capped = await searchStationsByText('x', { limit: 3 });
  assert.equal(capped.length, 3);

  // One lookup failing still returns the other's stations.
  mockDirectory((url) => (url.searchParams.has('name') ? 'fail' : [station('t1')]));
  assert.deepEqual((await searchStationsByText('x')).map((r) => r.id), ['t1']);

  // Both failing is an error the view can toast.
  mockDirectory(() => 'fail');
  await assert.rejects(searchStationsByText('x'));
}
globalThis.fetch = realFetch;

assert.deepEqual(
  interleaveStations([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }, { id: 'd' }], 10).map((s) => s.id),
  ['a', 'b', 'c', 'd'],
);

// 2. Tuning in.
const fakeAudio = (play, errorCode = null) => ({
  src: '',
  error: errorCode === null ? null : { code: errorCode },
  play,
});
const named = (name, extra = {}) => Object.assign(new Error(name), { name, ...extra });

{
  let release;
  const audio = fakeAudio(() => new Promise((resolve) => (release = resolve)));
  let settled = false;
  const pending = tuneStation(audio, { name: 'Jazz FM', url: 'http://jazz.test/live' }).then((r) => {
    settled = true;
    return r;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(audio.src, 'http://jazz.test/live', 'the element is pointed at the station');
  assert.equal(settled, false, 'not on air until play() has resolved');
  release();
  assert.deepEqual(await pending, { ok: true });
}

const quiet = console.error;
console.error = () => undefined;
try {
  const fail = (err, code, url = 'http://dead.test/stream') =>
    tuneStation(fakeAudio(() => Promise.reject(err), code), { name: 'Dead FM', url });

  const dead = await fail(named('NotSupportedError'), 4);
  assert.equal(dead.ok, false);
  assert.match(dead.detail, /Dead FM/);
  assert.match(dead.detail, /offline|format/);

  const hls = await fail(named('NotSupportedError'), 4, 'https://cdn.test/live/master.m3u8?token=1');
  assert.match(hls.detail, /HLS/);

  const network = await fail(named('NotSupportedError'), 2);
  assert.match(network.detail, /reach/);

  const blocked = await fail(named('NotAllowedError'), null);
  assert.match(blocked.detail, /blocked/);

  const superseded = await fail(named('AbortError'), null);
  assert.deepEqual(superseded, { ok: false, detail: null }, 'a cut-short attempt carries no message');
} finally {
  console.error = quiet;
}
assert.equal(playFailureDetail({ name: 'X', url: 'http://x.test/a.m3u8' }, new Error('x'), null).includes('HLS'), true);
assert.equal(playFailureDetail({ name: 'X', url: 'http://x.test/a' }, 'not an error object', null).includes('offline'), true);

// 3. The view only goes live from that result.
{
  const view = await readFile(new URL('../src/components/views/RadioView.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(view, /\.play\(\)\.catch/, 'play() is awaited, not fired and forgotten');
  const awaited = view.indexOf('await tuneStation(');
  const live = view.indexOf('setActive(s);', awaited);
  const refused = view.indexOf('if (!result.ok)', awaited);
  assert.ok(awaited > 0 && refused > awaited && live > refused, 'setActive(s) comes after the failure check');
  assert.match(view, /if \(mine !== attempt\.current\) return;/, 'a superseded attempt cannot mark its station live');
  assert.match(view, /CURATED_RADIO_TAGS\.map/, 'the chips come from the curated list');
  assert.doesNotMatch(view, /topTags\(40\)/, 'the raw top-40 tags are no longer the chips');
}

console.log('[radio-view-test] PASS');
