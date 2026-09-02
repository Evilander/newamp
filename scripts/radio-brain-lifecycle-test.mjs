// Radio Brain lifecycle regression test — proves the server survives the
// races settings changes and app shutdown can throw at it:
//   1. a start immediately followed by a stop leaves no listening port,
//   2. two concurrent starts never race into two listeners (or an
//      EADDRINUSE failure on the loser),
//   3. changing the desired port mid-start converges on the final port
//      only (modeling how main.ts recreates the instance on a port change),
//   4. stopping while a /now/events SSE client is connected still resolves
//      quickly instead of waiting forever for that deliberately-open socket,
//   5. stop() is idempotent and actually clears its connection bookkeeping.
//
// Run with: npm run test:radio-brain-lifecycle  (requires build:electron)

import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { RadioBrain } = await import(
  pathToFileURL(resolve('dist-electron', 'electron', 'radio-brain.js')).toString()
);

const TOKEN = 'lifecycle-test-token';

function fakeLibrary() {
  return {
    getStats: () => ({ tracks: 0, albums: 0, artists: 0 }),
    getTagSummaries: () => [],
    getTrackIds: () => [],
    getTrackIdsByTag: () => [],
    getTracksByIdsInOrder: () => [],
    getTrack: () => null,
    getArt: () => null,
  };
}

function makeBrain(port) {
  return new RadioBrain({
    library: fakeLibrary(),
    port,
    transcode: () => new Response('nope', { status: 500 }),
    ffmpegFallbackExt: () => false,
    getToken: () => TOKEN,
    getNowPlaying: () => null,
    onNowPlaying: () => () => undefined,
    control: () => true,
  });
}

const usedPorts = new Set();
function pickPort() {
  let port;
  do {
    port = 17400 + Math.floor(Math.random() * 900);
  } while (usedPorts.has(port));
  usedPorts.add(port);
  return port;
}

function isListening(port) {
  return new Promise((res) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const timer = setTimeout(() => {
      socket.destroy();
      res(false);
    }, 1000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      res(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      res(false);
    });
  });
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function openSseClient(port) {
  const res = await fetch(`http://127.0.0.1:${port}/now/events?token=${TOKEN}`, {
    headers: { accept: 'text/event-stream' },
  });
  assert.equal(res.status, 200, 'SSE endpoint should accept the connection');
  const reader = res.body.getReader();
  await reader.read(); // wait for the initial snapshot so the socket is actually established
  return reader;
}

// --- 1. start immediately followed by stop leaves no listening port -------
{
  const port = pickPort();
  const brain = makeBrain(port);
  const startPromise = brain.start();
  const stopPromise = brain.stop();
  await Promise.all([startPromise, stopPromise]);
  assert.equal(await isListening(port), false, 'start-then-immediate-stop should not leak a listener');
  console.log('[radio-brain-lifecycle] PASS: start immediately followed by stop leaves no listener');
}

// --- 2. two concurrent starts create exactly one listener ------------------
{
  const port = pickPort();
  const brain = makeBrain(port);
  const [s1, s2] = await Promise.all([brain.start(), brain.start()]);
  assert.equal(s1.enabled, true, `first concurrent start should succeed: ${s1.error}`);
  assert.equal(s2.enabled, true, `second concurrent start should succeed, not race into EADDRINUSE: ${s2.error}`);
  assert.equal(await isListening(port), true, 'port should be listening after concurrent starts');
  await brain.stop();
  assert.equal(await isListening(port), false);
  console.log('[radio-brain-lifecycle] PASS: two concurrent starts create exactly one listener');
}

// --- 3. port change during start leaves only the final port listening -----
// RadioBrain instances are one-per-port (main.ts recreates the instance when
// the configured port changes), so a "port change mid-start" is modeled as:
// the old instance's start gets superseded by a stop, while the replacement
// instance for the new port starts up — same as a settings handler reacting
// to two rapid changes without waiting for the first to settle.
{
  const portA = pickPort();
  const portB = pickPort();
  const brainA = makeBrain(portA);
  const brainB = makeBrain(portB);
  const startA = brainA.start();
  const stopA = brainA.stop();
  const startB = brainB.start();
  await Promise.all([startA, stopA, startB]);
  assert.equal(await isListening(portA), false, 'superseded port should not remain bound');
  assert.equal(await isListening(portB), true, 'final port should be listening');
  await brainB.stop();
  console.log('[radio-brain-lifecycle] PASS: port change during start leaves only the final port listening');
}

// --- 4. stop with a connected SSE client resolves within 1s ---------------
{
  const port = pickPort();
  const brain = makeBrain(port);
  await brain.start();
  const reader = await openSseClient(port);
  const startedAt = Date.now();
  await withTimeout(brain.stop(), 1000, 'stop with an open /now/events client');
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1000, `stop took ${elapsed}ms with an open SSE client — should be bounded, not wait on it`);
  assert.equal(await isListening(port), false);
  await reader.cancel().catch(() => undefined);
  console.log(`[radio-brain-lifecycle] PASS: stop with an open SSE client resolved in ${elapsed}ms`);
}

// --- 5. repeated stop is harmless; bookkeeping is actually cleared --------
{
  const port = pickPort();
  const brain = makeBrain(port);
  await brain.start();
  const reader = await openSseClient(port);
  await brain.stop();
  const afterFirstStop = brain.debugConnectionCounts();
  assert.equal(afterFirstStop.sseClients, 0, 'SSE client bookkeeping should be cleared after stop');
  assert.equal(afterFirstStop.sockets, 0, 'socket bookkeeping should be cleared after stop');
  const repeatStatus = await withTimeout(brain.stop(), 1000, 'repeated stop');
  assert.equal(repeatStatus.enabled, false, 'repeated stop should stay a no-op');
  const afterSecondStop = brain.debugConnectionCounts();
  assert.equal(afterSecondStop.sseClients, 0);
  assert.equal(afterSecondStop.sockets, 0);
  assert.equal(await isListening(port), false);
  await reader.cancel().catch(() => undefined);
  console.log('[radio-brain-lifecycle] PASS: repeated stop is harmless and clears connection bookkeeping');
}

console.log(JSON.stringify({ ok: true, tests: 5 }, null, 2));
