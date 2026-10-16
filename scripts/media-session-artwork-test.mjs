// Cover art for the OS media controls. The OS takes only http(s), data and blob
// URLs and drops the newart:// one the app uses, so the cover is read through
// that protocol in the page, scaled down, and handed over as a blob URL with its
// real size and type. Covers the loader on its own (fakes for the browser
// parts) and syncMediaSessionIdentity end to end against a fake mediaSession.
// Run: node scripts/media-session-artwork-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const deadline = setTimeout(() => { console.error('Media session artwork test timed out'); process.exit(1); }, 30000);
deadline.unref();

const root = resolve('tmp/media-session-artwork-test');
mkdirSync(root, { recursive: true });
const bundlePath = resolve(root, 'bundle.mjs');
await build({
  stdin: {
    contents: `export * from './src/lib/mediaSession';
      export * from './src/lib/media-artwork';
      export * from './shared/media-session';
      export { api } from './src/lib/api';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: bundlePath, define: { 'import.meta.env.DEV': 'false' }, logLevel: 'silent',
});

// ---- browser pieces the module reaches for ----
const urlLog = { created: [], revoked: [] };
const realCreate = URL.createObjectURL.bind(URL);
const realRevoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob) => { const url = realCreate(blob); urlLog.created.push(url); return url; };
URL.revokeObjectURL = (url) => { urlLog.revoked.push(url); realRevoke(url); };

const fetched = [];
let coverBehaviour = 'ok';
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  if (coverBehaviour === 'reject') throw new Error('network');
  if (coverBehaviour === 'missing') return new Response('No art', { status: 404 });
  return new Response(new Blob([new Uint8Array(64)], { type: 'image/png' }), { status: 200 });
};
let coverSize = { width: 1200, height: 800 };
globalThis.createImageBitmap = async () => ({ ...coverSize, close() {} });
globalThis.OffscreenCanvas = class {
  constructor(width, height) { this.width = width; this.height = height; }
  getContext() { return { fillRect() {}, drawImage() {}, set fillStyle(_) {}, set imageSmoothingQuality(_) {} }; }
  async convertToBlob({ type }) { return new Blob([new Uint8Array(32)], { type }); }
};
class FakeMediaMetadata { constructor(init) { Object.assign(this, init); } }
globalThis.MediaMetadata = FakeMediaMetadata;
const fakeSession = { metadata: undefined, playbackState: 'none', setActionHandler() {} };
Object.defineProperty(globalThis, 'navigator', { value: { mediaSession: fakeSession }, configurable: true });

const mod = await import(pathToFileURL(bundlePath).href);
const { createMediaArtworkLoader, syncMediaSessionIdentity, fitMediaArtwork, buildMediaSessionMetadata, api } = mod;
api.getArtUrl = (id) => `newart://track/${id}/art`;

const settle = () => new Promise((done) => setTimeout(done, 5));
const track = (id, extra = {}) => ({
  id, title: `Song ${id}`, artist: 'Artist', album: 'Album', hasArt: 1, ...extra,
});
const actions = { play() {}, pause() {}, previous() {}, next() {}, stop() {}, seek() {} };
const sync = (current, isPlaying = true) => syncMediaSessionIdentity({ current, isPlaying, actions });

// ---- sizes ----
assert.deepEqual(fitMediaArtwork(3000, 3000), { width: 512, height: 512 });
assert.deepEqual(fitMediaArtwork(1200, 800), { width: 512, height: 341 }, 'the shape is kept');
assert.deepEqual(fitMediaArtwork(300, 200), { width: 300, height: 200 }, 'a small cover is not enlarged');
assert.deepEqual(fitMediaArtwork(2000, 3), { width: 512, height: 1 }, 'a sliver never reaches zero');
assert.equal(fitMediaArtwork(0, 100), null);
assert.equal(fitMediaArtwork(Number.NaN, 100), null);
{
  const meta = buildMediaSessionMetadata(track(1), 'blob:x', { width: 512, height: 341, type: 'image/jpeg' });
  assert.deepEqual(meta.artwork, [{ src: 'blob:x', sizes: '512x341', type: 'image/jpeg' }], 'the entry says what the image is');
  assert.deepEqual(buildMediaSessionMetadata(track(1), null).artwork, []);
}

// ---- the loader, with its own fakes ----
{
  const calls = { fetch: [], shrink: 0, created: [], revoked: [] };
  let gate = null;
  const io = {
    fetchCover: async (url) => { calls.fetch.push(url); if (gate) await gate; return url.includes('/9/') ? null : new Blob(['x']); },
    shrink: async () => { calls.shrink += 1; return { blob: new Blob(['y'], { type: 'image/jpeg' }), width: 400, height: 300 }; },
    createUrl: () => { const url = `blob:fake-${calls.created.length}`; calls.created.push(url); return url; },
    revokeUrl: (url) => { calls.revoked.push(url); },
  };
  const loader = createMediaArtworkLoader(io);

  const first = await loader.load(1, 'newart://track/1/art');
  assert.deepEqual(first, { src: 'blob:fake-0', width: 400, height: 300, type: 'image/jpeg' });
  assert.equal(loader.peek(1), first);
  assert.equal(loader.peek(2), null);
  assert.equal(await loader.load(1, 'newart://track/1/art'), first, 'the same track again costs nothing');
  assert.equal(calls.fetch.length, 1);

  const second = await loader.load(2, 'newart://track/2/art');
  assert.equal(second.src, 'blob:fake-1');
  assert.deepEqual(calls.revoked, ['blob:fake-0'], 'the cover it replaces is released');
  assert.equal(loader.peek(1), null);

  assert.equal(await loader.load(9, 'newart://track/9/art'), null, 'no cover, no image');
  assert.equal(loader.peek(2), second, 'a miss leaves the kept cover alone');

  // A skip while a cover is still loading: the late one is dropped and never gets a URL.
  let open;
  gate = new Promise((resolveGate) => { open = resolveGate; });
  const slow = loader.load(3, 'newart://track/3/art');
  const fast = loader.load(4, 'newart://track/4/art');
  open();
  gate = null;
  assert.equal(await slow, null, 'the track that was skipped gets nothing');
  assert.equal((await fast).src, 'blob:fake-2');
  assert.equal(calls.created.length, 3, 'one URL per cover that was used');

  // Two asks for the same track while it loads are one fetch.
  const fetchesBefore = calls.fetch.length;
  gate = new Promise((resolveGate) => { open = resolveGate; });
  const a = loader.load(5, 'newart://track/5/art');
  const b = loader.load(5, 'newart://track/5/art');
  open();
  gate = null;
  assert.equal(await a, await b);
  assert.equal(calls.fetch.length, fetchesBefore + 1);

  const revokedBefore = calls.revoked.length;
  loader.release();
  assert.equal(calls.revoked.length, revokedBefore + 1, 'release gives the kept URL back');
  assert.equal(loader.peek(5), null);

  // Reads that fail answer null instead of throwing.
  const broken = createMediaArtworkLoader({ ...io, fetchCover: async () => { throw new Error('boom'); } });
  assert.equal(await broken.load(1, 'newart://track/1/art'), null);
  const undecodable = createMediaArtworkLoader({ ...io, shrink: async () => { throw new Error('bad image'); } });
  assert.equal(await undecodable.load(1, 'newart://track/1/art'), null);
}

// ---- end to end through the real browser path ----
{
  const meta = () => fakeSession.metadata;
  sync(track(1));
  assert.equal(meta().title, 'Song 1');
  assert.deepEqual(meta().artwork, [], 'title and artist go out before the cover is read');
  await settle();
  assert.equal(fetched.at(-1), 'newart://track/1/art', 'the cover is read through the app protocol');
  assert.equal(meta().artwork.length, 1);
  const [art] = meta().artwork;
  assert.match(art.src, /^blob:/, 'the OS is given a blob URL, not newart://');
  assert.equal(art.sizes, '512x341', 'the entry carries the size of the image that was made');
  assert.equal(art.type, 'image/jpeg');

  // Pause and play on the same track: the cover is there at once and is not fetched again.
  const fetchedBefore = fetched.length;
  sync(track(1), false);
  assert.equal(meta().artwork[0].src, art.src);
  await settle();
  assert.equal(fetched.length, fetchedBefore);

  // Next track: first its text, then its cover, and the old URL is released.
  sync(track(2));
  assert.equal(meta().title, 'Song 2');
  assert.deepEqual(meta().artwork, []);
  await settle();
  assert.match(meta().artwork[0].src, /^blob:/);
  assert.notEqual(meta().artwork[0].src, art.src);
  assert.ok(urlLog.revoked.includes(art.src), 'the previous cover URL is revoked');

  // A track without art publishes none.
  sync(track(3, { hasArt: 0 }));
  await settle();
  assert.deepEqual(meta().artwork, []);

  // Skipping on before a cover arrives: the late cover never lands on the new track.
  coverSize = { width: 600, height: 600 };
  sync(track(4));
  sync(track(5, { hasArt: 0 }));
  await settle();
  assert.equal(meta().title, 'Song 5');
  assert.deepEqual(meta().artwork, [], 'track 4 is no longer the one playing');

  // A cover that cannot be read leaves the text alone.
  coverBehaviour = 'missing';
  sync(track(6));
  await settle();
  assert.equal(meta().title, 'Song 6');
  assert.deepEqual(meta().artwork, []);
  coverBehaviour = 'reject';
  sync(track(7));
  await settle();
  assert.equal(meta().title, 'Song 7');
  assert.deepEqual(meta().artwork, []);
  coverBehaviour = 'ok';

  // Nothing playing: no metadata, no cover kept.
  sync(track(8));
  await settle();
  const kept = meta().artwork[0].src;
  sync(null, false);
  assert.equal(meta(), null);
  assert.ok(urlLog.revoked.includes(kept), 'the kept cover is released when playback ends');
}

console.log('PASS media session artwork: cover read through newart, handed over as a blob with its real size and type');
clearTimeout(deadline);
