// Radio view behaviour that does not need a window:
//   1. the genre chips are a short fixed list of plain English tags, and the
//      raw directory tags stay reachable: free-text search matches station
//      names AND tags, chips match their tag exactly,
//   2. a station only counts as playing once play() succeeds, and each way a
//      stream can fail comes back with its own reason (an attempt that was
//      only superseded stays silent),
//   3. RadioView marks a station live only from that result,
//   4. a dropped stream is retried twice, each retry counted once however many
//      ways the element reports its failure, and then ends with a message,
//   5. the shared element follows the player's volume and output device.
//
// Run with: node scripts/radio-view-test.mjs

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { createRadioRig, directoryStation, unsupportedError } from './lib/radio-view-rig.mjs';

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
const stations = [directoryStation('a'), directoryStation('b')];

// The chips are the curated list, and a chip searches that exact tag.
{
  const rig = await createRadioRig({ stations });
  for (const tag of CURATED_RADIO_TAGS) assert.ok(rig.buttonByText(tag), `${tag} is offered as a chip`);
  rig.click(rig.buttonByText('jazz'));
  rig.clock.advance(0);
  await rig.flush();
  const search = rig.requests.filter((request) => request.pathname === '/json/stations/search').at(-1);
  assert.equal(search.searchParams.get('tag'), 'jazz');
  assert.equal(search.searchParams.get('tagExact'), 'true', 'a chip matches its tag exactly');
  assert.equal(rig.rows().length, 2);
  rig.dispose();
}

{
  const rig = await createRadioRig({ stations });
  await rig.search('jazz');
  assert.equal(rig.rows().length, 2, 'the directory answer is listed');

  // A refused stream never reads LIVE, and says why.
  const quietError = console.error;
  console.error = () => undefined;
  try {
    rig.click(rig.rowButton(0));
    await rig.flush();
    assert.equal(rig.isConnecting(), true, 'connecting until play() answers');
    assert.equal(rig.isLive(), false);
    rig.audio.answer(0, unsupportedError());
    await rig.flush();
  } finally {
    console.error = quietError;
  }
  assert.equal(rig.isLive(), false);
  assert.equal(rig.isConnecting(), false);
  assert.deepEqual(rig.toasts.map((toast) => toast.title), ['Station failed to play']);
  assert.match(rig.toasts[0].detail, /Station a/);

  // A stream that plays goes live, and the directory is told.
  rig.click(rig.rowButton(1));
  await rig.flush();
  assert.equal(rig.audio.src, 'http://example.test/b', 'the element is pointed at the station');
  rig.audio.answer(1);
  await rig.flush();
  assert.equal(rig.isLive(), true);
  assert.equal(rig.isConnecting(), false);
  assert.deepEqual(rig.clicks, ['b']);

  // Stop ends it.
  rig.click(rig.rowButton(1));
  await rig.flush();
  assert.equal(rig.isLive(), false);
  assert.equal(rig.audio.paused, true);
  assert.equal(rig.audio.src, '');
  rig.dispose();
}

// A station picked while another is still connecting wins, however the first one's late answer arrives.
for (const abortOnLoad of [true, false]) {
  const rig = await createRadioRig({ stations });
  await rig.search('jazz');
  rig.audio.abortOnLoad = abortOnLoad;
  rig.click(rig.rowButton(0));
  await rig.flush();
  rig.click(rig.rowButton(1));
  await rig.flush();
  assert.equal(rig.audio.src, 'http://example.test/b');
  if (!abortOnLoad) {
    rig.audio.answer(0);
    await rig.flush();
    assert.equal(rig.isLive(), false, 'the first station answering late does not go on air');
  }
  rig.audio.answer(1);
  await rig.flush();
  assert.equal(rig.isLive(), true);
  assert.deepEqual(rig.clicks, ['b'], 'only the station that went on air is reported');
  assert.deepEqual(rig.toasts, [], 'a superseded attempt says nothing');
  rig.dispose();
}

// Cancel while connecting: the late answer cannot put the station on air.
{
  const rig = await createRadioRig({ stations });
  await rig.search('jazz');
  rig.audio.abortOnLoad = false;
  rig.click(rig.rowButton(0));
  await rig.flush();
  rig.click(rig.rowButton(0));
  await rig.flush();
  assert.equal(rig.isConnecting(), false, 'Cancel clears the connecting bar');
  rig.audio.answer(0);
  await rig.flush();
  assert.equal(rig.isLive(), false);
  assert.deepEqual(rig.clicks, []);
  rig.dispose();
}

// 4. A dropped stream is retried twice, then ends.
const RETRY_DELAYS = [1500, 4000];

async function liveStation() {
  const rig = await createRadioRig({ stations });
  await rig.search('jazz');
  rig.click(rig.rowButton(0));
  await rig.flush();
  rig.audio.answer(0);
  await rig.flush();
  assert.equal(rig.isLive(), true);
  return rig;
}

// A failed retry is announced by the element's error event and by the rejected
// play(), in either order; it uses up one retry, not two.
for (const order of ['event first', 'rejection first']) {
  const rig = await liveStation();
  const { audio, clock } = rig;
  const failRetry = async (index) => {
    if (order === 'event first') audio.emit('error');
    audio.answer(index, unsupportedError());
    await rig.settle();
    if (order === 'rejection first') audio.emit('error');
  };

  const quietError = console.error;
  console.error = () => undefined;
  try {
    audio.emit('error');
    clock.advance(RETRY_DELAYS[0] - 1);
    assert.equal(audio.plays.length, 1, 'the first retry waits its delay');
    clock.advance(1);
    assert.equal(audio.plays.length, 2, 'then reconnects');
    assert.equal(audio.src, 'http://example.test/a');

    await failRetry(1);
    assert.deepEqual(rig.toasts, [], `${order}: still trying after the first retry fails`);
    clock.advance(RETRY_DELAYS[1] - 1);
    assert.equal(audio.plays.length, 2);
    clock.advance(1);
    assert.equal(audio.plays.length, 3, `${order}: a second retry runs after the first one failed`);

    await failRetry(2);
    await rig.flush();
  } finally {
    console.error = quietError;
  }
  assert.deepEqual(rig.toasts.map((toast) => toast.title), ['Radio stream lost'], `${order}: the station ends once both retries failed`);
  assert.equal(rig.isLive(), false);
  assert.equal(audio.src, '');
  clock.advance(60000);
  assert.equal(audio.plays.length, 3, 'and nothing keeps retrying');
  rig.dispose();
}

// A retry that gets audio flowing again earns the full two retries for the next drop.
{
  const rig = await liveStation();
  const { audio, clock } = rig;
  audio.emit('error');
  clock.advance(RETRY_DELAYS[0]);
  audio.answer(1);
  audio.emit('playing');
  await rig.flush();
  assert.equal(rig.isLive(), true, 'back on air after one retry');

  const quietError = console.error;
  console.error = () => undefined;
  try {
    audio.emit('error');
    clock.advance(RETRY_DELAYS[0]);
    assert.equal(audio.plays.length, 3);
    audio.emit('error');
    audio.answer(2, unsupportedError());
    await rig.settle();
    clock.advance(RETRY_DELAYS[1]);
    assert.equal(audio.plays.length, 4, 'a second drop gets both retries again');
  } finally {
    console.error = quietError;
  }
  rig.dispose();
}

// Going quiet counts as a drop once it has lasted long enough, and audio resuming cancels it.
{
  const rig = await liveStation();
  const { audio, clock } = rig;
  audio.emit('waiting');
  clock.advance(19999);
  audio.emit('timeupdate');
  clock.advance(60000);
  assert.equal(audio.plays.length, 1, 'a stall that clears is not a drop');
  audio.emit('stalled');
  clock.advance(20000);
  clock.advance(RETRY_DELAYS[0]);
  assert.equal(audio.plays.length, 2, 'a stall that lasts reconnects');
  rig.dispose();
}

// 5. The element outside the audio graph follows the transport's volume and output device.
{
  const rig = await createRadioRig({ stations });
  assert.equal(rig.audio.volume, 0.5, 'the volume carries over when the element is created');
  rig.store.set({ volume: 0.25 });
  assert.equal(rig.audio.volume, 0.25, 'and follows the transport');
  rig.store.set({ volume: 4 });
  assert.equal(rig.audio.volume, 1, 'never past unity');
  assert.deepEqual(rig.audio.sinks, []);
  rig.store.set({ settings: { audioOutputDeviceId: 'speakers' } });
  assert.deepEqual(rig.audio.sinks, ['speakers'], 'the chosen output device is applied');
  rig.store.set({ settings: { audioOutputDeviceId: null } });
  assert.deepEqual(rig.audio.sinks, ['speakers', ''], 'and released');
  rig.dispose();
}

console.log('[radio-view-test] PASS');
