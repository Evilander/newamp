import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve('tmp/history-import-boundaries');
await mkdir(root, { recursive: true });
await build({ entryPoints: ['electron/history-import.ts', 'shared/history-import.ts'], outbase: '.', outdir: root, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { fetchLastfmHistory, parseHistoryImport } = await import(pathToFileURL(resolve(root, 'electron/history-import.js')));
const { normalizeHistoryImportPath } = await import(pathToFileURL(resolve(root, 'shared/history-import.js')));

assert.throws(() => parseHistoryImport('artist,title,played_at\nArtist,"unfinished,2025-01-01T00:00:00Z', 'csv'), /unterminated|quote/i);
assert.equal(parseHistoryImport(JSON.stringify([{ artist: 'A', title: 'B', played_at: '2025-01-01T12:00:00' }]), 'json').invalid, 1, 'timezone-free dates are ambiguous');
assert.equal(parseHistoryImport(JSON.stringify([{ artist: 'A', title: 'B', played_at: 1e30 }]), 'json').invalid, 1, 'timestamps must fit the date range');
assert.equal(parseHistoryImport(JSON.stringify([{ artist: 'A', title: 'B', played_at: '2025-02-30T12:00:00Z' }]), 'json').invalid, 1, 'invalid calendar dates must not roll into another month');
assert.equal(parseHistoryImport('\uFEFF' + JSON.stringify([{ artist: 'A', title: 'B', played_at: '2025-01-01T00:00:00Z' }]), 'json').entries.length, 1, 'UTF-8 BOM exports should import');
assert.notEqual(normalizeHistoryImportPath('/music/Track.mp3'), normalizeHistoryImportPath('/music/track.mp3'), 'case-sensitive POSIX paths must stay distinct');
assert.equal(normalizeHistoryImportPath('K:\\MUSIC\\Track.mp3'), normalizeHistoryImportPath('k:/music/track.mp3'));

for (const attr of [{}, { page: '2', totalPages: '2' }, { page: '1', totalPages: 'invalid' }]) {
  await assert.rejects(() => fetchLastfmHistory({
    username: 'fixture', apiKey: 'fixture-key',
    fetchImpl: async () => new Response(JSON.stringify({ recenttracks: { '@attr': attr, track: [] } })),
  }), /pagination|page/i, 'a missing or incorrect page must not report a complete import');
}
const empty = await fetchLastfmHistory({ username: 'fixture', apiKey: 'fixture-key', fetchImpl: async () => new Response(JSON.stringify({ recenttracks: { '@attr': { page: '1', totalPages: '0', total: '0' }, track: [] } })) });
assert.equal(empty.entries.length, 0);
await assert.rejects(() => fetchLastfmHistory({ username: 'fixture', apiKey: 'fixture-key', fetchImpl: async () => new Response(JSON.stringify({ recenttracks: { '@attr': { page: '1', totalPages: '3000', total: '600000' }, track: [] } })) }), /500,000|limit/i);
console.log('History import malformed files, dates, path casing, and incomplete pagination guards passed.');
