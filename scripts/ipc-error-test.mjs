import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cleanIpcError, splitIpcErrorMessage } from '../dist-electron/shared/ipc-error.js';

// Electron's own wording for a handler that throws, as the renderer gets it.
const wrapped = (channel, rest) => `Error invoking remote method '${channel}': ${rest}`;

assert.deepEqual(splitIpcErrorMessage(wrapped('library:scan', 'Error: Folder not found')), {
  channel: 'library:scan',
  message: 'Folder not found',
});
assert.deepEqual(
  splitIpcErrorMessage(wrapped('lastfm:auth', 'Last.fm said no: bad key')),
  { channel: 'lastfm:auth', message: 'Last.fm said no: bad key' },
  'a thrown string has no Error: to drop, and a colon inside the message is not a prefix',
);
assert.deepEqual(splitIpcErrorMessage(wrapped('a:b', 'TypeError: x is not a function')), {
  channel: 'a:b',
  message: 'TypeError: x is not a function',
}, 'a typed error keeps its type');
assert.deepEqual(splitIpcErrorMessage(wrapped('a:b', 'Error: first line\nsecond line')), {
  channel: 'a:b',
  message: 'first line\nsecond line',
});
assert.deepEqual(splitIpcErrorMessage('Folder not found'), { channel: null, message: 'Folder not found' });
assert.deepEqual(
  splitIpcErrorMessage('Something said: Error invoking remote method \'x\': Error: nope'),
  { channel: null, message: 'Something said: Error invoking remote method \'x\': Error: nope' },
  'only a leading prefix is Electron\'s',
);
const empty = wrapped('a:b', 'Error: ');
assert.equal(splitIpcErrorMessage(empty).message, empty, 'an empty error leaves the wrapped text rather than nothing');

const original = new Error(wrapped('library:scan', 'Error: Folder not found'));
const clean = cleanIpcError(original);
assert.ok(clean instanceof Error);
assert.equal(clean.message, 'Folder not found');
assert.equal(clean.name, 'Error');
assert.equal(clean.cause, original, 'the wrapped error stays reachable');
assert.match(clean.stack, /Error invoking remote method 'library:scan'/, 'and so does the channel, through the stack');

const plain = new Error('Folder not found');
assert.equal(cleanIpcError(plain), plain, 'an error that was never wrapped comes back as it was');
assert.equal(cleanIpcError('a string'), 'a string');
assert.equal(cleanIpcError(undefined), undefined);

// The preload has to send every invoke through it. The smoke
// (ipc-error-smoke.mjs) runs the real preload; this keeps the wiring visible.
const preload = await readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8');
assert.match(preload, /from '\.\.\/shared\/ipc-error\.js'/, 'preload should use the shared cleaner');
assert.match(
  preload,
  /ipcRenderer\.invoke = \(channel: string, \.\.\.args: unknown\[\]\) =>[\s\S]{0,200}cleanIpcError\(err\)/,
  'preload should wrap ipcRenderer.invoke before the api object uses it',
);
assert.ok(
  preload.indexOf('ipcRenderer.invoke = ') < preload.indexOf('const api: NewAmpAPI'),
  'the wrapper has to be installed ahead of the api object',
);

console.log('[ipc-error-test] ok');
