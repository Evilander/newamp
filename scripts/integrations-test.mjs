// Last.fm signing and outbox, Ultimate Guitar and sidecar tab parsing, sidecar
// lyrics lookup and decoding, Last.fm history import retries, and the
// MusicBrainz / Cover Art Archive clients, each against the failure that was
// reported for it. Nothing here touches the network: fetch is replaced.
// Run: node scripts/integrations-test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('tmp', 'integrations-test', String(process.pid));
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const bundle = join(root, 'bundle.mjs');
await build({
  stdin: {
    contents: `
      export * from './electron/lastfm.ts';
      export * from './electron/guitar-tabs.ts';
      export * from './electron/local-lyrics.ts';
      export { fetchLastfmHistory } from './electron/history-import.ts';
      export * from './electron/musicbrainz.ts';
      export * from './electron/mp4-codec.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  packages: 'external',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: bundle,
  logLevel: 'silent',
});
const lib = await import(pathToFileURL(bundle).href);
const realFetch = globalThis.fetch;
const results = [];
const check = (name) => results.push(name);

// ---- Last.fm signs in code point order ----
{
  const params = {
    method: 'track.scrobble',
    api_key: 'KEY',
    sk: 'SK',
    'artist[0]': 'Artist',
    'track[0]': 'Song',
    'timestamp[0]': 1700000000,
    'album[0]': 'Album',
    'albumArtist[0]': 'Various',
    'duration[0]': '200',
    'trackNumber[0]': '3',
  };
  const expectedPayload =
    'albumArtist[0]Various' + 'album[0]Album' + 'api_keyKEY' + 'artist[0]Artist' + 'duration[0]200' +
    'methodtrack.scrobble' + 'skSK' + 'timestamp[0]1700000000' + 'trackNumber[0]3' + 'track[0]Song';
  const expected = createHash('md5').update(`${expectedPayload}SECRET`, 'utf8').digest('hex');
  assert.equal(lib.signLastfmParams(params, 'SECRET'), expected, 'album[0]/track[0] keys sort after albumArtist[0]/trackNumber[0]');
  assert.equal(
    lib.signLastfmParams({ ...params, format: 'json', callback: 'x', api_sig: 'old', ignored: null }, 'SECRET'),
    expected,
    'format, callback, api_sig and empty values are left out',
  );
  check('lastfm signature order');
}

// ---- which failures retry, which are credentials, which are dropped ----
{
  const err = (code, status) => new lib.LastfmApiError('x', { code, status });
  assert.equal(err(8, 200).retryable, true, 'error 8 is a backend failure that asks to be retried');
  assert.equal(err(26, 403).authFailure, true, 'a suspended key needs the user, like a bad session key');
  assert.equal(err(26, 403).retryable, false);
  assert.equal(err(null, 403).retryable, true, 'an edge proxy 403 page is not a verdict on the scrobble');
  assert.equal(err(null, 502).retryable, true);
  assert.equal(err(null, 400).retryable, false);
  assert.equal(err(null, 404).retryable, false);
  assert.equal(err(null, 422).retryable, false);
  assert.equal(lib.isPermanentLastfmRejection(err(6, 400)), true);
  assert.equal(lib.isPermanentLastfmRejection(err(7, 400)), true);
  assert.equal(lib.isPermanentLastfmRejection(err(13, 403)), false, 'an invalid signature is not proof the play is bad');
  assert.equal(lib.isPermanentLastfmRejection(err(null, 400)), false);
  assert.equal(lib.isPermanentLastfmRejection(new Error('offline')), false);
  check('lastfm failure classes');
}

// ---- a request carries a timeout; the signature on the wire is the sorted one ----
{
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ scrobbles: {} }), { status: 200 });
  };
  const settings = {
    lastfmEnabled: true,
    lastfmApiKey: 'KEY',
    lastfmSharedSecret: 'SECRET',
    lastfmSessionKey: 'SK',
  };
  await lib.scrobbleLastfmTrack(
    settings,
    { artist: 'Artist', title: 'Song', album: 'Album', albumArtist: 'Various', duration: 200, trackNumber: 3 },
    1700000000,
  );
  globalThis.fetch = realFetch;
  assert.ok(seen.init.signal instanceof AbortSignal, 'Last.fm requests are abortable');
  const body = new URLSearchParams(String(seen.init.body));
  const payload =
    'albumArtist[0]Various' + 'album[0]Album' + 'api_keyKEY' + 'artist[0]Artist' + 'duration[0]200' +
    'methodtrack.scrobble' + 'skSK' + 'timestamp[0]1700000000' + 'trackNumber[0]3' + 'track[0]Song';
  assert.equal(body.get('api_sig'), createHash('md5').update(`${payload}SECRET`, 'utf8').digest('hex'));
  check('lastfm request signal and signature');
}

// ---- a play Last.fm refuses for a reason that may be ours is kept, not dropped ----
{
  const file = join(root, 'outbox-rejected.json');
  const outbox = new lib.LastfmScrobbleOutbox(file);
  const track = (title) => ({ artist: 'Artist', title, album: null, albumArtist: null, duration: 200, trackNumber: null });
  await outbox.enqueue(track('Signed badly'), 1700000000);
  await outbox.enqueue(track('Fine'), 1700000100);
  await outbox.enqueue(track('Malformed'), 1700000200);
  const sent = [];
  const flush = () =>
    outbox.flush(async (item) => {
      sent.push(item.track.title);
      if (item.track.title === 'Signed badly') throw new lib.LastfmApiError('Invalid signature', { code: 13, status: 403 });
      if (item.track.title === 'Malformed') throw new lib.LastfmApiError('Invalid parameters', { code: 6, status: 400 });
    });
  const first = await flush();
  assert.deepEqual(sent, ['Signed badly', 'Fine', 'Malformed'], 'a refused play does not stop the ones behind it');
  assert.equal(first.sent, 1);
  const left = await outbox.list();
  assert.deepEqual(left.map((item) => item.track.title), ['Signed badly'], 'only the provably bad play is dropped');
  assert.match(left[0].lastError, /Last\.fm 13/);
  assert.equal(left[0].rejected, true);
  assert.equal(first.remaining, 0, 'a refused play is not a play waiting its turn');
  assert.match((await outbox.status()).lastError, /Last\.fm 13/, 'the error stays visible');
  sent.length = 0;
  await flush();
  assert.deepEqual(sent, [], 'a refused play is not sent again on every flush');
  const reloaded = await new lib.LastfmScrobbleOutbox(file).list();
  assert.equal(reloaded[0].rejected, true, 'the refusal survives a restart');
  check('lastfm refused plays kept');
}

// ---- an unreadable or corrupt outbox is never written over ----
{
  const track = { artist: 'Artist', title: 'Song', album: null, albumArtist: null, duration: 200, trackNumber: null };

  const corrupt = join(root, 'outbox-corrupt.json');
  await writeFile(corrupt, '{ not json');
  const afterCorrupt = new lib.LastfmScrobbleOutbox(corrupt);
  await afterCorrupt.enqueue(track, 1700000000);
  const names = await readdir(root);
  assert.ok(names.some((name) => name.startsWith('outbox-corrupt.json.corrupt-')), 'a corrupt outbox is moved aside');
  assert.equal(JSON.parse(await readFile(corrupt, 'utf8')).length, 1);

  const unreadable = join(root, 'outbox-unreadable.json');
  await mkdir(unreadable);
  const outbox = new lib.LastfmScrobbleOutbox(unreadable);
  await outbox.enqueue(track, 1700000000);
  assert.ok((await stat(unreadable)).isDirectory(), 'a file that could not be read is not replaced');
  await rm(unreadable, { recursive: true });
  await writeFile(
    unreadable,
    JSON.stringify([{ id: 'on-disk', track, timestamp: 1699999999, attempts: 0, createdAt: 1, lastAttemptAt: null, lastError: null, authFailure: false }]),
  );
  const merged = await outbox.list();
  assert.equal(merged.length, 2, 'once the file reads again, what it holds and what was queued meanwhile are both kept');
  await outbox.enqueue(track, 1700000300);
  assert.equal(JSON.parse(await readFile(unreadable, 'utf8')).length, 3, 'and the file is written again');
  check('lastfm outbox read failure');
}

// ---- words that start with A to G are not chords ----
{
  const kind = (text) => lib.parseTabLines(text)[0].type;
  for (const word of ['Chorus', 'Bridge', 'Come', 'All', 'Every', 'Good', 'Dad', 'Are', 'Fade', 'Ending']) {
    assert.equal(kind(word), 'lyrics', `${word} is a word`);
  }
  for (const chord of ['G', 'Am', 'F#m7b5', 'Cadd9', 'Dsus4', 'C/G', 'Bb', 'E7#9', 'Cmaj7', 'N.C.', 'D/F#', 'Em7(b5)', 'Gm6']) {
    assert.equal(kind(chord), 'chords', `${chord} is a chord`);
  }
  assert.equal(kind('Come As You Are'), 'lyrics');
  assert.equal(kind('G C D G'), 'chords');
  const started = Date.now();
  kind(`A${'1'.repeat(50_000)}x`);
  kind(`A${'sus4'.repeat(5_000)}x`);
  assert.ok(Date.now() - started < 1000, 'a long odd token does not make the chord match backtrack');

  const doc = lib.buildLocalGuitarTabDocument({
    artist: 'A',
    title: 'B',
    content: '{start_of_verse}\n[Am]Hello [Chorus]there\n[Bridge]Next [G]line\n',
  });
  assert.deepEqual(
    doc.lines.map((line) => [line.type, line.text]),
    [
      ['section', '[Verse]'],
      ['chords', 'Am'],
      ['lyrics', 'Hello [Chorus]there'],
      ['chords', 'G'],
      ['lyrics', '[Bridge]Next line'],
    ],
    'ChordPro tags named for sections are not read as chords',
  );
  assert.equal(lib.transposeChordLine('Am C/E', 2), 'Bm D/F#');

  // A lyrics file next to the audio is not a tab; a chord sheet in a .txt is.
  const dir = join(root, 'sidecar-tabs');
  await mkdir(dir, { recursive: true });
  const audio = join(dir, 'Song.mp3');
  await writeFile(audio, 'x');
  const track = { path: audio, artist: 'Artist', title: 'Song', album: 'Album', key: null };
  await writeFile(join(dir, 'Song.txt'), 'Come As You Are\nAs you were\nAs I want you to be\nA friend\nAnd a enemy\n');
  assert.equal(await lib.findLocalGuitarTabForTrack(track), null, 'a lyrics .txt is not shown as a tab');
  await writeFile(join(dir, 'Song.txt'), 'Am C G D\nWords go here\n');
  const found = await lib.findLocalGuitarTabForTrack(track);
  assert.equal(found?.lines[0].type, 'chords');
  // The name is found whatever its case, and as a Mac stores it.
  await rm(join(dir, 'Song.txt'));
  await writeFile(join(dir, 'SONG.CHOPRO'), '{title: Upper}\n[G]Words [C]here\n');
  assert.equal((await lib.findLocalGuitarTabForTrack(track))?.title, 'Upper', 'a differently-cased sidecar is found');
  const accent = join(dir, 'Accent.mp3');
  await writeFile(accent, 'x');
  await writeFile(join(dir, 'Beyonce\u0301 - Halo.chopro'), '[G]Halo\n');
  const halo = await lib.findLocalGuitarTabForTrack({ path: accent, artist: 'Beyoncé', title: 'Halo', album: 'X', key: null });
  assert.ok(halo, 'a decomposed name matches a composed one');

  // Tab text comes from files and sites. An opener with no closer, or a long run of chord
  // qualities, must cost time in proportion to the text, so each shape is timed against text of
  // the same length without it; a machine that is slow is slow for both.
  const measure = async (work) => {
    const started = performance.now();
    await work();
    return performance.now() - started;
  };
  const within = (label, ms, controlMs) =>
    assert.ok(ms <= Math.max(10 * controlMs, 250), `${label}: ${ms.toFixed(0)} ms, ${controlMs.toFixed(0)} ms for text of the same length`);
  const hostile = join(root, 'sidecar-hostile');
  await mkdir(hostile, { recursive: true });
  const hostileAudio = join(hostile, 'Song.mp3');
  await writeFile(hostileAudio, 'x');
  const hostileTrack = { path: hostileAudio, artist: 'Artist', title: 'Song', album: 'Album', key: null };
  const sidecarFor = async (text) => {
    await writeFile(join(hostile, 'Song.txt'), text);
    return lib.findLocalGuitarTabForTrack(hostileTrack);
  };
  assert.ok(await sidecarFor('Some words with [Am]a chord and [G7]another\n'), 'a chord tag in a .txt makes it a tab');
  assert.ok(await sidecarFor('Words [Cmaj7(add9)] and [D/F#] here\n'), 'chords with brackets and a bass note count');
  assert.equal(await sidecarFor('[Verse]\nJust words here\n[Chorus]\nAnd more words\n'), null, 'section tags are not chords');
  const noTags = await measure(() => sidecarFor('a [Verse] b '.repeat(7_500)));
  within('[A( repeated in a sidecar', await measure(() => sidecarFor('[A('.repeat(30_000))), noTags);

  for (const [opener, times] of [['[ch]', 40_000], ['<span data-name="x">', 25_000], ['<a', 40_000], ['[tab', 30_000]]) {
    const text = opener.repeat(times);
    const control = await measure(() => lib.parseTabLines('word '.repeat(Math.ceil(text.length / 5))));
    within(`${opener} repeated with no closer`, await measure(() => lib.parseTabLines(text)), control);
  }

  assert.equal(
    lib.transposeChordLine('Am C/E CmM7 Gmaj7 D/F# F#m7b5 A(add9)', 2),
    'Bm D/F# DmM7 Amaj7 E/G# G#m7b5 B(add9)',
    'chord names with the qualities the pattern knows are moved',
  );
  assert.equal(lib.transposeChordLine('F# C# G#', 1), 'G D A', 'a chord that is a bare sharp moves as one note');
  assert.equal(lib.transposeChordLine('D/A# Bb', 1), 'D#/B B', 'and so does a sharp bass note');
  const odd = await measure(() => lib.transposeChordLine(`A${'mM'.repeat(26)}z`, 2));
  within('A followed by mM pairs', odd, await measure(() => lib.transposeChordLine(`A${'mm'.repeat(26)}z`, 2)));
  check('guitar tab chord grammar and sidecars');
}

// ---- Ultimate Guitar page fetch and the js-store state ----
{
  const attr = (value) =>
    JSON.stringify(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#039;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const beacon = '<script defer src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>';
  const searchPage = `<html><head><title>Search</title>${beacon}</head><body>
    <div class="js-store" data-content="${attr({
      store: {
        page: {
          data: {
            results: [
              {
                song_name: 'Just a Moment & Then Some',
                artist_name: 'The Band',
                type: 'Chords',
                rating: 4.5,
                votes: 120,
                tab_url: 'https://tabs.ultimate-guitar.com/tab/the-band/just-a-moment-chords-111',
              },
            ],
          },
        },
      },
    })}"></div><script>window.UGAPP = {}; try { JSON.parse('x') } catch (e) {}</script></body></html>`;
  const hits = lib.parseUltimateGuitarSearchHtml(searchPage);
  assert.equal(hits.length, 1, 'search results are read from the js-store attribute');
  assert.equal(hits[0].title, 'Just a Moment & Then Some');
  assert.equal(hits[0].artist, 'The Band');
  assert.equal(hits[0].kind, 'Chords');
  assert.equal(hits[0].votes, 120);

  const tabPage = `<html><head>${beacon}</head><body><div class='js-store' data-content='${attr({
    store: {
      page: {
        data: {
          tab: {
            song_name: 'Wonderwall',
            artist_name: 'Oasis',
            type: 'Chords',
            rating: 4.6,
            votes: 9000,
            username: 'someone',
            tonality_name: 'F#m',
          },
          tab_view: {
            wiki_tab: { content: '[Intro]\r\n[ch]Em7[/ch]  [ch]G[/ch]\r\nToday is gonna be the day' },
            meta: { tonality: 'F#m' },
          },
        },
      },
    },
  })}'></div></body></html>`;
  const tabUrl = 'https://tabs.ultimate-guitar.com/tab/oasis/wonderwall-chords-6125';
  const doc = lib.parseUltimateGuitarTabHtml(tabPage, tabUrl);
  assert.equal(doc.title, 'Wonderwall');
  assert.equal(doc.artist, 'Oasis');
  assert.equal(doc.kind, 'Chords');
  assert.equal(doc.author, 'someone');
  assert.equal(doc.key, 'F#m');
  assert.deepEqual(
    doc.lines.map((line) => [line.type, line.text]),
    [['chords', 'Em7  G'], ['lyrics', 'Today is gonna be the day']],
  );

  const calls = [];
  const serve = (handler) => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init, calls.length);
    };
  };

  // The Cloudflare beacon on a page that was served is not a challenge.
  serve(() => new Response(tabPage, { status: 200 }));
  assert.equal((await lib.fetchUltimateGuitarTab(tabUrl)).title, 'Wonderwall', 'a served page with the Cloudflare script loads');
  assert.ok(calls[0].init.signal instanceof AbortSignal, 'the request has a timeout');
  assert.equal(calls[0].init.redirect, 'manual');

  // A real challenge still reads as one.
  serve(() => new Response('<html>Just a moment... challenge-platform</html>', { status: 403 }));
  await assert.rejects(() => lib.fetchUltimateGuitarTab(tabUrl), /blocked automated access/);
  serve(() => new Response('<html><title>Just a moment...</title></html>', { status: 200 }));
  await assert.rejects(() => lib.fetchUltimateGuitarTab(tabUrl), /blocked automated access/);
  serve(() => new Response('<html></html>', { status: 200, headers: { 'cf-mitigated': 'challenge' } }));
  await assert.rejects(() => lib.fetchUltimateGuitarTab(tabUrl), /blocked automated access/);
  serve(() => new Response('Cloudflare Error', { status: 500 }));
  await assert.rejects(() => lib.fetchUltimateGuitarTab(tabUrl), /request failed \(500\)/);

  // Redirects stay on the site; a page that is far too large is refused.
  serve((url) =>
    url.includes('www.')
      ? new Response(tabPage, { status: 200 })
      : new Response(null, { status: 301, headers: { location: 'https://www.ultimate-guitar.com/tab/oasis/wonderwall-chords-6125' } }),
  );
  assert.equal((await lib.fetchUltimateGuitarTab(tabUrl)).title, 'Wonderwall', 'a redirect within the site is followed');
  serve(() => new Response(null, { status: 302, headers: { location: 'https://example.com/elsewhere' } }));
  await assert.rejects(() => lib.fetchUltimateGuitarTab(tabUrl), /Only ultimate-guitar\.com/);
  serve(() => new Response('x'.repeat(16), { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } }));
  await assert.rejects(() => lib.fetchUltimateGuitarTab(tabUrl), /too large/);
  serve(() => new Response(new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(1024 * 1024)) }), { status: 200 }));
  await assert.rejects(() => lib.fetchUltimateGuitarTab(tabUrl), /too large/, 'a body with no length is cut off at the limit');
  globalThis.fetch = realFetch;

  // Entities: code points above U+FFFF, "&amp;lt;" and a bare "<3".
  const pre = lib.parseUltimateGuitarTabHtml(
    '<html><pre>Smile &#128512; and &amp;lt;b&amp;gt; and I <3 you > ok &#x1F600; &#99999999; &lt;3</pre></html>',
    tabUrl,
  );
  assert.equal(pre.lines[0].text, 'Smile \u{1F600} and &lt;b&gt; and I <3 you > ok \u{1F600} &#99999999; <3');
  check('ultimate guitar fetch and parsing');
}

// ---- sidecar lyrics lookup, decoding, and the embedded cache ----
{
  const bytes = (...parts) => Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part))));
  assert.equal(lib.decodeSidecarText(bytes([0xef, 0xbb, 0xbf], 'abc')), 'abc');
  assert.equal(lib.decodeSidecarText(Buffer.from('Café', 'utf8')), 'Café');
  assert.equal(lib.decodeSidecarText(bytes('Caf', [0xe9])), 'Café', 'Windows-1252 accents survive');
  assert.equal(lib.decodeSidecarText(bytes([0x93], 'quoted', [0x94])), '“quoted”', 'Windows-1252 quotes survive');
  assert.equal(lib.decodeSidecarText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[00:01.00]Café', 'utf16le')])), '[00:01.00]Café');
  const be = Buffer.from('[00:01.00]Café', 'utf16le').swap16();
  assert.equal(lib.decodeSidecarText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), '[00:01.00]Café');

  const dir = join(root, 'sidecar-lyrics');
  await mkdir(join(dir, 'lyrics'), { recursive: true });
  const audio = join(dir, 'Song.flac');
  await writeFile(audio, 'x');
  const track = { path: audio, artist: 'Artist', title: 'Song', album: 'Album' };
  await writeFile(join(dir, 'song.LRC'), bytes('[00:01.00]Caf', [0xe9]));
  const latin = await lib.findSidecarLyricsForTrack(track);
  assert.equal(latin?.syncedLyrics, '[00:01.00]Café', 'a Windows-1252 .lrc in a differently-cased name is found and read');
  await rm(join(dir, 'song.LRC'));
  await writeFile(join(dir, 'lyrics', 'Artist - Song.lyrics.txt'), 'Plain words');
  assert.equal((await lib.findSidecarLyricsForTrack(track))?.plainLyrics, 'Plain words', 'the lyrics/ folder is searched');
  await rm(join(dir, 'lyrics'), { recursive: true });
  assert.equal(await lib.findSidecarLyricsForTrack(track), null, 'nothing there answers null');
  await writeFile(join(dir, 'Song.lrc'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[00:02.00]Wide', 'utf16le')]));
  assert.equal((await lib.findSidecarLyricsForTrack(track))?.syncedLyrics, '[00:02.00]Wide', 'a UTF-16 .lrc is read as timed lyrics');

  // A file that can't be read right now is not remembered as one without lyrics.
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) {
    check('sidecar lyrics (embedded cache skipped: file modes are not enforced)');
  } else {
    const flac = join(root, 'embedded.flac');
    const made = spawnSync(
      ffmpeg,
      ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-metadata', 'lyrics=Words from the tags', '-c:a', 'flac', flac],
      { encoding: 'utf8' },
    );
    assert.equal(made.status, 0, made.stderr);
    await chmod(flac, 0o000);
    assert.equal(await lib.findEmbeddedLyricsForTrack({ path: flac }), null, 'an unreadable file answers null');
    await chmod(flac, 0o644);
    assert.equal(
      (await lib.findEmbeddedLyricsForTrack({ path: flac }))?.plainLyrics,
      'Words from the tags',
      'and is read again once it can be',
    );
    check('sidecar lyrics and embedded cache');
  }
}

// ---- the MP4 codec reader fills its reads and bounds what a hostile moov can build ----
{
  const box = (type, ...children) => {
    const body = Buffer.concat(children);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
  };
  const handler = Buffer.concat([Buffer.alloc(8), Buffer.from('soun', 'latin1'), Buffer.alloc(8)]);
  const entries = Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), box('alac', Buffer.alloc(28))]);
  const moov = box(
    'moov',
    box('free', Buffer.alloc(10_000)),
    box('trak', box('mdia', box('hdlr', handler), box('minf', box('stbl', box('stsd', entries))))),
  );
  const m4a = join(root, 'synthetic.m4a');
  await writeFile(m4a, Buffer.concat([box('ftyp', Buffer.from('M4A \0\0\0\0', 'latin1')), moov]));

  // Reads that return at most 4 KB at a time, as a share can: the sound track sits past the first 4 KB of moov.
  const handle = await open(m4a);
  const proto = Object.getPrototypeOf(handle);
  await handle.close();
  const originalRead = proto.read;
  proto.read = function read(buffer, offset, length, position) {
    return originalRead.call(this, buffer, offset, Math.min(length, 4096), position);
  };
  try {
    assert.equal(lib.soundSampleEntry(await lib.readMoov(m4a)), 'alac', 'a moov that arrives in pieces is read whole');
    assert.equal(await lib.mp4SoundCodec(m4a), 'alac');
  } finally {
    proto.read = originalRead;
  }

  const tiny = Buffer.alloc(lib.MAX_BOX_CHILDREN * 3 * 8);
  for (let at = 0; at < tiny.length; at += 8) {
    tiny.writeUInt32BE(8, at);
    tiny.write('free', at + 4, 'latin1');
  }
  assert.equal(lib.boxChildren(tiny, 0, tiny.length).length, lib.MAX_BOX_CHILDREN, 'a box with millions of children yields a bounded list');
  assert.equal(lib.boxChildren(moov, 0, moov.length).length, 1, 'an ordinary box lists its children');
  check('mp4 codec reads and bounds');
}

// ---- history import retries a bad page and explains a refusal ----
{
  const entry = (title, uts) => ({ artist: { '#text': 'Artist' }, name: title, album: { '#text': 'Album' }, date: { uts: String(uts) } });
  const page = (n, total, tracks) => ({ recenttracks: { '@attr': { page: String(n), totalPages: String(total) }, track: tracks } });
  const run = (fetchImpl, extra = {}) =>
    lib.fetchLastfmHistory({ username: 'u', apiKey: 'k', toUnixSeconds: 1700000000, retryDelayMs: 1, fetchImpl, ...extra });
  const json = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected token <');
      return body;
    },
  });

  // A page that fails once (5xx, rate limit, error 8, an HTML page, a dropped connection) is asked again.
  for (const [label, failure] of [
    ['503', () => json(503, { error: 11, message: 'Service Offline' })],
    ['429 with Retry-After', () => json(429, undefined, { 'retry-after': '0' })],
    ['error 8', () => json(200, { error: 8, message: 'Operation failed' })],
    ['html 502', () => json(502, undefined)],
    ['dropped connection', () => { throw new TypeError('fetch failed'); }],
    ['truncated 200 body', () => json(200, undefined)],
  ]) {
    const asked = [];
    const result = await run(async (url) => {
      const p = Number(new URL(url).searchParams.get('page'));
      asked.push(p);
      if (p === 2 && asked.filter((n) => n === 2).length === 1) return failure();
      return json(200, page(p, 3, [entry(`T${p}`, 1699990000 + p)]));
    });
    assert.equal(result.pagesFetched, 3, `${label}: the import carries on`);
    assert.equal(result.entries.length, 3, `${label}: no page was lost`);
    assert.deepEqual(asked, [1, 2, 2, 3], `${label}: only the failed page was asked for again`);
  }

  // A page that keeps failing ends the import after its tries.
  let attempts = 0;
  await assert.rejects(() => run(async () => { attempts += 1; return json(503, { error: 16, message: 'Temporarily unavailable' }); }), /Temporarily unavailable/);
  assert.equal(attempts, 4, 'a page is tried four times, then the import stops');

  // Refusals that won't change are not retried, and say why.
  let calls = 0;
  await assert.rejects(
    () => run(async () => { calls += 1; return json(403, { error: 17, message: 'Login: User required to be logged in' }); }),
    /profile is private/,
  );
  await assert.rejects(
    () => run(async () => { calls += 1; return json(404, { error: 6, message: 'User not found' }); }),
    /no user with that name/,
  );
  await assert.rejects(
    () => run(async () => { calls += 1; return json(403, { error: 10, message: 'Invalid API key - You must be granted a valid key by last.fm' }); }),
    /Invalid API key/,
  );
  await assert.rejects(() => run(async () => { calls += 1; return json(403, undefined); }), /request failed \(403\)/);
  assert.equal(calls, 4, 'each permanent refusal is asked once');

  // Cancelling during the wait between tries stops at once.
  const controller = new AbortController();
  const started = Date.now();
  await assert.rejects(
    () => run(async () => { setTimeout(() => controller.abort(), 20); return json(503, undefined); }, { signal: controller.signal, retryDelayMs: 60_000 }),
  );
  assert.ok(Date.now() - started < 5000, 'a cancelled import does not wait out its backoff');
  check('history import retries');
}

// ---- MusicBrainz spacing, retry, timeouts, cover art ----
{
  let clock = 1_000_000;
  let last = 0;
  const sleeps = [];
  const timing = {
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      await new Promise((resolve) => setImmediate(resolve));
      clock += ms;
    },
    lastRequestAt: () => last,
    setLastRequestAt: (value) => {
      last = value;
    },
  };
  const track = { title: 'Song', artist: 'Artist', album: 'Album', duration: 200 };
  const recordings = { recordings: [{ id: 'r1', score: 100, title: 'Song', 'artist-credit': [{ name: 'Artist' }], releases: [] }] };
  const reply = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  // Two lookups at once go out at least a spacing apart.
  const firedAt = [];
  const signals = [];
  const fetchImpl = async (_url, init) => {
    firedAt.push(clock);
    signals.push(init?.signal);
    return reply(200, recordings);
  };
  await Promise.all([
    lib.searchMusicBrainzMetadata(track, { ...timing, fetchImpl }),
    lib.searchMusicBrainzMetadata(track, { ...timing, fetchImpl }),
    lib.searchMusicBrainzMetadata(track, { ...timing, fetchImpl }),
  ]);
  assert.equal(firedAt.length, 3);
  assert.ok(firedAt[1] - firedAt[0] >= 1100 && firedAt[2] - firedAt[1] >= 1100, `requests are spaced out, got ${firedAt}`);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal), 'every request has a timeout');

  // A 503 is asked again once after the time it names; a second one is reported plainly.
  let answered = 0;
  sleeps.length = 0;
  const flaky = await lib.searchMusicBrainzMetadata(track, {
    ...timing,
    fetchImpl: async () => (++answered === 1 ? reply(503, { error: 'busy' }, { 'retry-after': '2' }) : reply(200, recordings)),
  });
  assert.equal(flaky.length, 1);
  assert.equal(answered, 2);
  assert.ok(sleeps.includes(2000), 'the Retry-After wait is honoured');
  answered = 0;
  await assert.rejects(
    () => lib.searchMusicBrainzMetadata(track, { ...timing, fetchImpl: async () => { answered += 1; return reply(503, { error: 'busy' }); } }),
    /busy right now \(503\)/,
  );
  assert.equal(answered, 2, 'a busy service is asked twice, not more');
  await assert.rejects(
    () => lib.searchMusicBrainzMetadata(track, { ...timing, fetchImpl: async () => reply(400, { error: 'bad query' }) }),
    /lookup failed \(400\)/,
  );
  await assert.rejects(
    () => lib.searchMusicBrainzMetadata(track, { ...timing, fetchImpl: async () => ({ ...reply(200, recordings), url: 'https://example.com/ws/2/recording' }) }),
    /not allowed/,
  );

  // Cover art: the large thumbnail is preferred and the 500 px one is the fallback.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 1)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600, 2)]);
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(600)}</svg>`);
  const ab = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const imageReply = (buffer, headers = { 'content-type': 'image/jpeg' }, extra = {}) => ({
    ok: true,
    status: 200,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => ({}),
    arrayBuffer: async () => ab(buffer),
    ...extra,
  });
  const found = await lib.searchAlbumArt(
    { album: 'Kid A', albumArtist: 'Radiohead' },
    {
      ...timing,
      fetchImpl: async (url, init) => {
        assert.ok(init?.signal instanceof AbortSignal, 'cover art lookups have a timeout');
        if (String(url).startsWith('https://musicbrainz.org/')) {
          return reply(200, { 'release-groups': [{ id: 'g1', score: 100, title: 'Kid A', 'artist-credit': [{ name: 'Radiohead' }] }] });
        }
        return reply(200, {
          images: [{
            image: 'https://coverartarchive.org/release/x/1.jpg',
            front: true,
            thumbnails: {
              250: 'https://coverartarchive.org/release/x/1-250.jpg',
              500: 'https://coverartarchive.org/release/x/1-500.jpg',
              1200: 'https://coverartarchive.org/release/x/1-1200.jpg',
            },
          }],
        });
      },
    },
  );
  const candidate = found[0];
  assert.equal(candidate.thumbnailUrl, 'https://coverartarchive.org/release/x/1-1200.jpg', 'the 1200 px thumbnail is preferred');

  // The archive timing out partway through keeps the covers already found; with none found, it is the error.
  const twoGroups = {
    'release-groups': [
      { id: 'g1', score: 100, title: 'Kid A', 'artist-credit': [{ name: 'Radiohead' }] },
      { id: 'g2', score: 90, title: 'Kid A Mnesia', 'artist-credit': [{ name: 'Radiohead' }] },
    ],
  };
  const cover = { images: [{ image: 'https://coverartarchive.org/release/x/1.jpg', front: true, thumbnails: {} }] };
  const timedOut = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const lookups = [];
  const partial = await lib.searchAlbumArt(
    { album: 'Kid A', albumArtist: 'Radiohead' },
    {
      ...timing,
      fetchImpl: async (url) => {
        if (String(url).startsWith('https://musicbrainz.org/')) return reply(200, twoGroups);
        lookups.push(String(url));
        if (lookups.length === 2) throw timedOut();
        return reply(200, cover);
      },
    },
  );
  assert.equal(partial.length, 1, 'the cover found before the timeout is returned');
  assert.equal(lookups.length, 2, 'the search stops at the lookup that failed');
  await assert.rejects(
    () => lib.searchAlbumArt(
      { album: 'Kid A', albumArtist: 'Radiohead' },
      {
        ...timing,
        fetchImpl: async (url) => {
          if (String(url).startsWith('https://musicbrainz.org/')) return reply(200, twoGroups);
          throw timedOut();
        },
      },
    ),
    /timeout/,
  );

  const fetched = [];
  const image = await lib.fetchAlbumArtImage(candidate, {
    fetchImpl: async (url, init) => {
      fetched.push(String(url));
      assert.ok(init?.signal instanceof AbortSignal);
      return String(url).includes('-1200.') ? { ...imageReply(Buffer.alloc(0)), ok: false, status: 404, text: async () => 'Not Found' } : imageReply(jpeg);
    },
  });
  assert.deepEqual(fetched, [
    'https://coverartarchive.org/release/x/1-1200.jpg',
    'https://coverartarchive.org/release/x/1-500.jpg',
  ]);
  assert.equal(image.sourceUrl, 'https://coverartarchive.org/release/x/1-500.jpg');
  assert.equal(image.mime, 'image/jpeg');

  const sniffed = await lib.fetchAlbumArtImage(candidate, { fetchImpl: async () => imageReply(png, { 'content-type': 'image/jpeg' }) });
  assert.equal(sniffed.mime, 'image/png', 'the type comes from the bytes, not the header');
  await assert.rejects(
    () => lib.fetchAlbumArtImage(candidate, { fetchImpl: async () => imageReply(svg, { 'content-type': 'image/svg+xml' }) }),
    /not a JPEG, PNG or WebP/,
  );
  await assert.rejects(
    () => lib.fetchAlbumArtImage(candidate, { fetchImpl: async () => imageReply(jpeg, { 'content-type': 'image/jpeg', 'content-length': String(64 * 1024 * 1024) }) }),
    /too large/,
  );
  // A huge body with no declared length is cut off by the stream cap.
  let pulled = 0;
  const endless = {
    getReader: () => ({
      read: async () => {
        pulled += 1;
        return { done: false, value: new Uint8Array(1024 * 1024) };
      },
      cancel: async () => undefined,
    }),
  };
  await assert.rejects(
    () => lib.fetchAlbumArtImage(candidate, { fetchImpl: async () => imageReply(jpeg, { 'content-type': 'image/jpeg' }, { arrayBuffer: undefined, body: endless }) }),
    /too large/,
  );
  // Two tries (1200 px, then 500 px), each cut off just past 8 MB.
  assert.ok(pulled <= 18, `the body is not read past the limit, read ${pulled} MB`);
  await assert.rejects(
    () => lib.fetchAlbumArtImage(candidate, { fetchImpl: async () => imageReply(jpeg, { 'content-type': 'image/jpeg' }, { url: 'https://evil.example/cover.jpg' }) }),
    /not allowed/,
    'a redirect to another host is refused',
  );
  const viaArchive = await lib.fetchAlbumArtImage(candidate, {
    fetchImpl: async () => imageReply(jpeg, { 'content-type': 'image/jpeg' }, { url: 'https://ia800000.us.archive.org/1/items/x/1-1200.jpg' }),
  });
  assert.equal(viaArchive.mime, 'image/jpeg', 'the redirect the CAA itself makes is allowed');
  check('musicbrainz limiter, retry, timeouts and cover art');
}

globalThis.fetch = realFetch;
await rm(root, { recursive: true, force: true });
console.log(`[integrations-test] ok: ${results.length} groups\n  ${results.join('\n  ')}`);
