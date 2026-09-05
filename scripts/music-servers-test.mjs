// Protocol-level smoke for Jellyfin and Subsonic/Navidrome music-server adapters.
// Run: node scripts/music-servers-test.mjs
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/music-servers-test-result.txt');
writeFileSync(RESULT, '[music-servers-test] starting\n');
process.on('uncaughtException', (e) => {
  writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n');
  process.exitCode = 1;
});

await build({
  entryPoints: [resolve('electron/music-servers.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: resolve('tmp/music-servers-bundle.mjs'),
  logLevel: 'silent',
});
const {
  MusicServerRegistry,
  browseMusicServerSongs,
  parseMusicServerStreamUrl,
  searchMusicServerSongs,
  testMusicServerConnection,
} = await import(pathToFileURL(resolve('tmp/music-servers-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (message) => {
  pass = false;
  log.push('FAIL: ' + message);
};

for (const url of [
  'newamp://user:secret@server/connection/item/song.wav',
  'newamp://server:1234/connection/item/song.wav',
  'newamp://server/connection/item/song.wav?token=secret',
  'newamp://server/connection/item/song.wav#secret',
]) {
  try {
    parseMusicServerStreamUrl(url);
    fail('Playback URLs must reject credentials, ports, queries and fragments');
  } catch {}
}

const streamBytes = Buffer.from('abcdefghij');
const seen = [];
let port = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  seen.push({
    method: req.method,
    path: url.pathname,
    search: Object.fromEntries(url.searchParams.entries()),
    headers: req.headers,
  });

  const collectJson = async () => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  };

  const authParamsOk = () => {
    const salt = url.searchParams.get('s') ?? '';
    const token = url.searchParams.get('t') ?? '';
    const expected = createHash('md5').update(`nav-pass${salt}`).digest('hex');
    return (
      url.searchParams.get('u') === 'nav-user'
      && url.searchParams.get('v') === '1.16.1'
      && url.searchParams.get('c') === 'NewAmp'
      && url.searchParams.get('f') === 'json'
      && salt.length >= 6
      && token === expected
      && !url.searchParams.has('p')
      && !String(req.url).includes('nav-pass')
    );
  };

  if (url.pathname === '/jellyfin/Users/AuthenticateByName') {
    void collectJson().then((body) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
      } else if (body.Username !== 'jf-user' || body.Pw !== 'jf-pass') {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad jf-pass' }));
      } else {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({
            AccessToken: 'jf-token',
            ServerId: 'server-a',
            User: { Id: 'user-1', Name: 'Jelly User' },
          }));
      }
    });
    return;
  }

  if (url.pathname === '/jellyfin/System/Info') {
    if (!String(req.headers['x-emby-authorization'] ?? '').includes('Token="jf-token"')) {
      res.writeHead(401).end('missing token');
      return;
    }
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ServerName: 'Tyler Jellyfin', Version: '10.11.0' }));
    return;
  }

  if (url.pathname === '/jellyfin/Items') {
    if (!String(req.headers['x-emby-authorization'] ?? '').includes('Token="jf-token"')) {
      res.writeHead(401).end('missing token');
      return;
    }
    const startIndex = Number(url.searchParams.get('startIndex'));
    const limit = Number(url.searchParams.get('limit'));
    if (url.searchParams.get('userId') !== 'user-1') fail('Jellyfin items query should include the authenticated userId');
    if (url.searchParams.get('includeItemTypes') !== 'Audio') fail('Jellyfin items query should request only audio items');
    if (url.searchParams.get('recursive') !== 'true') fail('Jellyfin items query should be recursive');
    if (url.searchParams.get('searchTerm') === 'needle') {
      if (startIndex !== 0 || limit !== 2) fail(`Jellyfin search should pass pagination, got ${startIndex}/${limit}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        Items: [{
          Id: 'needle-id',
          Name: 'Needle Song',
          Artists: ['Finder'],
          Album: 'Search Record',
          RunTimeTicks: 500000000,
          Container: 'm4a',
        }],
        TotalRecordCount: 1,
        StartIndex: 0,
      }));
      return;
    }
    if (startIndex !== 1 || limit !== 2) fail(`Jellyfin browse should pass pagination, got ${startIndex}/${limit}`);
    const items = [
      {
        Id: 'song/1?',
        Name: 'Alpha',
        Artists: ['The Band'],
        Album: 'Record One',
        AlbumArtist: 'The Band',
        IndexNumber: 7,
        ParentIndexNumber: 2,
        ProductionYear: 1999,
        Genres: ['Indie', 'Rock'],
        RunTimeTicks: 2100000000,
        Bitrate: 987000,
        Container: 'flac',
        Size: 123456,
        DateCreated: '2026-01-02T03:04:05.0000000Z',
      },
      {
        Id: 'song-2',
        Name: 'Bravo',
        ArtistItems: [{ Name: 'Second Artist' }],
        Album: 'Second Record',
        AlbumArtist: 'Various Artists',
        RunTimeTicks: 650000000,
        Container: 'mp3',
      },
    ];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      Items: items,
      TotalRecordCount: 3,
      StartIndex: startIndex,
    }));
    return;
  }

  if (url.pathname === '/jellyfin/Audio/song%2F1%3F/stream') {
    if (url.searchParams.get('static') !== 'true') fail('Jellyfin stream should request the original static stream');
    if (String(req.url).includes('jf-token')) fail('Jellyfin token must be carried in headers, not the stream URL');
    if (req.headers.range !== 'bytes=2-5') fail(`Jellyfin stream should preserve Range, got ${req.headers.range}`);
    if (req.headers['accept-encoding'] !== 'identity') fail('Jellyfin stream should request identity encoding for byte-range preservation');
    res.writeHead(206, {
      'content-type': 'audio/flac',
      'content-range': 'bytes 2-5/10',
      'content-length': '4',
      'accept-ranges': 'bytes',
      'etag': '"song-1"',
      'set-cookie': 'session=secret',
    }).end(streamBytes.subarray(2, 6));
    return;
  }

  if (url.pathname === '/jellyfin/Audio/redirect-song/stream') {
    res.writeHead(302, { location: `http://127.0.0.1:${port}/leak?token=jf-token` }).end();
    return;
  }

  if (url.pathname === '/nav/rest/ping.view') {
    if (!authParamsOk()) {
      res.writeHead(401).end('bad nav-pass');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      'subsonic-response': {
        status: 'ok',
        version: '1.16.1',
        type: 'navidrome',
        serverVersion: '0.55.0',
        openSubsonic: true,
      },
    }));
    return;
  }

  if (url.pathname === '/nav/rest/search3.view') {
    if (!authParamsOk()) {
      res.writeHead(401).end('bad nav-pass');
      return;
    }
    if (url.searchParams.get('query') === 'leaky-error') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        'subsonic-response': {
          status: 'failed',
          error: { code: 40, message: 'bad nav-pass for nav-user with u=ed&t=secret-token' },
        },
      }));
      return;
    }
    if (url.searchParams.get('artistCount') !== '0' || url.searchParams.get('albumCount') !== '0') {
      fail('Subsonic search3 should request songs only');
    }
    const query = url.searchParams.get('query') ?? '';
    if (query === '') {
      if (url.searchParams.get('songOffset') !== '1' || url.searchParams.get('songCount') !== '2') {
        fail('Subsonic browse should pass song pagination');
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        'subsonic-response': {
          status: 'ok',
          searchResult3: {
            song: [{
              id: 'sub/1?',
              title: 'Folder Alpha',
              artist: 'Nav Artist',
              album: 'Nav Album',
              albumArtist: 'Nav Album Artist',
              track: 3,
              discNumber: 1,
              year: 2001,
              genre: 'Electronic',
              duration: 123,
              bitRate: 320,
              suffix: 'mp3',
              contentType: 'audio/mpeg',
              size: 4444,
            }],
          },
        },
      }));
      return;
    }
    if (query !== 'needle') fail(`Subsonic search should pass the query, got ${query}`);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      'subsonic-response': {
        status: 'ok',
        searchResult3: {
          song: [{
            id: 'sub-needle',
            title: 'Needle Sub',
            artist: 'Search Artist',
            album: 'Search Album',
            duration: 52,
            suffix: 'flac',
          }],
        },
      },
    }));
    return;
  }

  if (url.pathname === '/nav/rest/stream.view') {
    if (!authParamsOk()) {
      res.writeHead(401).end('bad nav-pass');
      return;
    }
    if (url.searchParams.get('id') !== 'sub/1?' && url.searchParams.get('id') !== 'redirect-sub') {
      fail(`Subsonic stream should pass decoded id, got ${url.searchParams.get('id')}`);
    }
    if (url.searchParams.get('format') !== 'raw') fail('Subsonic stream should request raw original format');
    if (String(req.url).includes('nav-pass') || url.searchParams.has('p')) fail('Subsonic stream URL must not carry a clear password');
    if (url.searchParams.get('id') === 'redirect-sub') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/leak?token=${url.searchParams.get('t')}` }).end();
      return;
    }
    if (req.method === 'HEAD') {
      if (req.headers.range !== 'bytes=0-0') fail(`Subsonic HEAD stream should preserve Range, got ${req.headers.range}`);
      if (req.headers['accept-encoding'] !== 'identity') fail('Subsonic HEAD stream should request identity encoding');
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': '10',
        'accept-ranges': 'bytes',
      }).end();
      return;
    }
    if (req.headers.range !== 'bytes=4-') fail(`Subsonic stream should preserve Range, got ${req.headers.range}`);
    if (req.headers['accept-encoding'] !== 'identity') fail('Subsonic stream should request identity encoding for byte-range preservation');
    res.writeHead(206, {
      'content-type': 'audio/mpeg',
      'content-range': 'bytes 4-9/10',
      'content-length': '6',
      'accept-ranges': 'bytes',
      'x-audio-source': 'navidrome',
    }).end(streamBytes.subarray(4));
    return;
  }

  if (url.pathname === '/leak') {
    fail('adapter must not follow upstream redirects because credentials could leak');
    res.writeHead(200).end('leaked');
    return;
  }

  if (url.pathname === '/slow/Users/AuthenticateByName') {
    return;
  }

  if (url.pathname === '/slow-body/Users/AuthenticateByName') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"AccessToken":"partial');
    return;
  }

  if (url.pathname === '/bad-jellyfin/Items') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ TotalRecordCount: 2 }));
    return;
  }

  if (url.pathname === '/blank-jellyfin/Users/AuthenticateByName') {
    void collectJson().then((body) => {
      if (body.Username !== 'space-user' || body.Pw !== '  ') {
        fail(`Jellyfin blank/space password should be sent exactly, got ${JSON.stringify(body.Pw)}`);
        res.writeHead(401).end();
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ AccessToken: 'blank-token', User: { Id: 'blank-user' } }));
    });
    return;
  }

  if (url.pathname === '/blank-jellyfin/System/Info') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ServerName: 'Blank Jellyfin' }));
    return;
  }

  res.writeHead(404).end(`missing ${url.pathname}`);
});

await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
port = server.address().port;

async function responseText(response) {
  return await response.text();
}

async function withGuard(promise, ms, message) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

try {
  const jf = await testMusicServerConnection({
    provider: 'jellyfin',
    connectionId: 'jf-local',
    baseUrl: `http://127.0.0.1:${port}/jellyfin/`,
    username: 'jf-user',
    password: 'jf-pass',
  }, { timeoutMs: 5000 });

  if (jf.connection.baseUrl !== `http://127.0.0.1:${port}/jellyfin`) fail(`Jellyfin base URL should be normalized, got ${jf.connection.baseUrl}`);
  if (jf.connection.serverName !== 'Tyler Jellyfin') fail('Jellyfin server name should come from System/Info');
  if (jf.connection.username !== 'jf-user') fail('Jellyfin public connection should keep username');
  if ('password' in jf.connection || JSON.stringify(jf.connection).includes('jf-pass') || JSON.stringify(jf.connection).includes('jf-token')) {
    fail('Jellyfin public connection must not expose password or token');
  }
  if (jf.secret.accessToken !== 'jf-token' || jf.secret.userId !== 'user-1') fail('Jellyfin secret should hold accessToken and userId for main-process storage');
  log.push('Jellyfin auth returns public connection plus main-process secret');

  try {
    await testMusicServerConnection({
      provider: 'jellyfin',
      baseUrl: `http://jf-user:jf-pass@127.0.0.1:${port}/jellyfin`,
      username: 'jf-user',
      password: 'jf-pass',
    }, { timeoutMs: 5000 });
    fail('base URLs with embedded credentials must be rejected');
  } catch (err) {
    if (!/credential/i.test(err.message)) fail(`expected URL credential rejection, got: ${err.message}`);
  }

  try {
    await testMusicServerConnection({
      provider: 'jellyfin',
      baseUrl: 'ftp://music.example.test',
      username: 'jf-user',
      password: 'jf-pass',
    }, { timeoutMs: 5000 });
    fail('non-http base URLs must be rejected');
  } catch (err) {
    if (!/http/i.test(err.message)) fail(`expected non-http rejection, got: ${err.message}`);
  }

  const jfRuntime = { ...jf.connection, secret: jf.secret };
  const jfBrowse = await browseMusicServerSongs(jfRuntime, { offset: 1, limit: 2 }, { timeoutMs: 5000 });
  const jfFirst = jfBrowse.songs[0];
  if (jfBrowse.total !== 3 || jfBrowse.nextOffset !== null) fail('Jellyfin browse should expose total and stop at the last page');
  if (jfFirst.itemId !== 'song/1?' || jfFirst.title !== 'Alpha' || jfFirst.artist !== 'The Band') fail('Jellyfin item metadata mapping is wrong');
  if (jfFirst.trackNo !== 7 || jfFirst.discNo !== 2 || jfFirst.year !== 1999 || jfFirst.genre !== 'Indie') fail('Jellyfin numeric metadata mapping is wrong');
  if (jfFirst.duration !== 210 || jfFirst.bitrate !== 987000 || jfFirst.size !== 123456) fail('Jellyfin technical metadata mapping is wrong');
  if (jfFirst.container !== 'flac') fail(`Jellyfin container should be flac, got ${jfFirst.container}`);
  if (jfFirst.streamUrl !== `newamp://server/jf-local/${encodeURIComponent('song/1?')}/Alpha.flac`) fail(`Jellyfin stream marker mismatch: ${jfFirst.streamUrl}`);
  if (JSON.stringify(jfBrowse).includes('jf-pass') || JSON.stringify(jfBrowse).includes('jf-token')) fail('Jellyfin song page must not contain credentials');
  log.push('Jellyfin browse maps paged audio items to credential-free songs');

  try {
    await browseMusicServerSongs({
      ...jfRuntime,
      id: 'bad-jf',
      baseUrl: `http://127.0.0.1:${port}/bad-jellyfin`,
    }, { offset: 0, limit: 2 }, { timeoutMs: 5000 });
    fail('Jellyfin Items responses without an Items array must fail instead of returning an empty page');
  } catch (err) {
    if (!/invalid|malformed|Items/i.test(err.message)) fail(`expected invalid Jellyfin Items error, got: ${err.message}`);
    else log.push(`Jellyfin malformed Items response rejected: ${err.message}`);
  }

  const jfSearch = await searchMusicServerSongs(jfRuntime, { query: 'needle', offset: 0, limit: 2 }, { timeoutMs: 5000 });
  if (jfSearch.songs[0]?.itemId !== 'needle-id') fail('Jellyfin search should return mapped search results');
  log.push('Jellyfin search uses server paging and searchTerm');

  const parsedJfUrl = parseMusicServerStreamUrl(jfFirst.streamUrl);
  if (parsedJfUrl.connectionId !== 'jf-local' || parsedJfUrl.itemId !== 'song/1?') fail('stream marker parsing should round-trip encoded ids');

  const registry = new MusicServerRegistry(async (connectionId) => (connectionId === 'jf-local' ? jfRuntime : null));
  const jfStream = await registry.stream(new Request(jfFirst.streamUrl, { headers: { Range: 'bytes=2-5' } }), { timeoutMs: 5000 });
  if (jfStream.status !== 206) fail(`Jellyfin stream should preserve upstream status 206, got ${jfStream.status}`);
  if (jfStream.headers.get('content-range') !== 'bytes 2-5/10') fail('Jellyfin stream should preserve Content-Range');
  if (jfStream.headers.get('etag') !== '"song-1"') fail('Jellyfin stream should preserve safe entity headers');
  if (jfStream.headers.get('set-cookie')) fail('Jellyfin stream proxy must strip Set-Cookie');
  if ((await responseText(jfStream)) !== 'cdef') fail('Jellyfin stream proxy should pass upstream bytes through');
  log.push('Jellyfin stream proxy preserves Range, status, safe headers, and bytes');

  const jfRedirect = await registry.stream(new Request('newamp://server/jf-local/redirect-song/redirect.flac'), { timeoutMs: 5000 });
  const jfRedirectBody = await jfRedirect.text();
  if (jfRedirect.status !== 502) fail(`Jellyfin redirect should fail closed with 502, got ${jfRedirect.status}`);
  if (/jf-token|jf-pass|token=/.test(jfRedirectBody)) fail('redirect error body must be sanitized');
  log.push('Jellyfin stream redirect fails closed without leaking credentials');

  const sub = await testMusicServerConnection({
    provider: 'subsonic',
    connectionId: 'nav-local',
    baseUrl: `http://127.0.0.1:${port}/nav`,
    username: 'nav-user',
    password: 'nav-pass',
  }, { timeoutMs: 5000 });
  if (sub.connection.serverName !== 'navidrome' || sub.connection.serverVersion !== '0.55.0') fail('Subsonic connection should expose server type/version');
  if (JSON.stringify(sub.connection).includes('nav-pass')) fail('Subsonic public connection must not expose password');
  if (sub.secret.password !== 'nav-pass') fail('Subsonic secret should retain password for salted token requests');
  log.push('Subsonic auth uses salted token auth and keeps password main-process only');

  const subRuntime = { ...sub.connection, secret: sub.secret };
  const subBrowse = await browseMusicServerSongs(subRuntime, { offset: 1, limit: 2 }, { timeoutMs: 5000 });
  const subFirst = subBrowse.songs[0];
  if (subBrowse.nextOffset !== null) fail('Subsonic browse should stop at a short final page');
  if (subFirst.itemId !== 'sub/1?' || subFirst.container !== 'mp3' || subFirst.bitrate !== 320000) fail('Subsonic metadata mapping is wrong');
  if (subFirst.streamUrl !== `newamp://server/nav-local/${encodeURIComponent('sub/1?')}/Folder%20Alpha.mp3`) fail(`Subsonic stream marker mismatch: ${subFirst.streamUrl}`);
  if (JSON.stringify(subBrowse).includes('nav-pass') || /[?&][ts]=/.test(subFirst.streamUrl)) fail('Subsonic song page must not contain credentials or auth params');
  log.push('Subsonic browse maps search3 song pages to credential-free songs');

  const subSearch = await searchMusicServerSongs(subRuntime, { query: 'needle', offset: 0, limit: 1 }, { timeoutMs: 5000 });
  if (subSearch.songs[0]?.itemId !== 'sub-needle') fail('Subsonic search should return mapped search3 songs');
  if (subSearch.nextOffset !== 1) fail('A full Subsonic page should advance its offset');
  log.push('Subsonic search uses search3 song paging');

  try {
    await searchMusicServerSongs(subRuntime, { query: 'leaky-error', offset: 0, limit: 1 }, { timeoutMs: 5000 });
    fail('Subsonic protocol error should throw');
  } catch (err) {
    if (/nav-pass|nav-user|secret-token|u=ed/.test(err.message)) fail(`Subsonic error leaked credentials: ${err.message}`);
    else log.push(`Subsonic error was sanitized: ${err.message}`);
  }

  const subRegistry = new MusicServerRegistry(async (connectionId) => (connectionId === 'nav-local' ? subRuntime : null));
  const subStream = await subRegistry.stream(new Request(subFirst.streamUrl, { headers: { Range: 'bytes=4-' } }), { timeoutMs: 5000 });
  if (subStream.status !== 206) fail(`Subsonic stream should preserve upstream 206, got ${subStream.status}`);
  if (subStream.headers.get('content-range') !== 'bytes 4-9/10') fail('Subsonic stream should preserve Content-Range');
  if ((await responseText(subStream)) !== 'efghij') fail('Subsonic stream proxy should pass upstream bytes through');
  log.push('Subsonic stream proxy uses raw format with Range forwarding');

  const subHead = await subRegistry.stream(new Request(subFirst.streamUrl, { method: 'HEAD', headers: { Range: 'bytes=0-0' } }), { timeoutMs: 5000 });
  if (subHead.status !== 200) fail(`Subsonic HEAD stream should preserve upstream status, got ${subHead.status}`);
  if (subHead.headers.get('content-length') !== '10') fail('Subsonic HEAD stream should preserve Content-Length');
  if ((await subHead.text()) !== '') fail('Subsonic HEAD stream response must not expose a body');
  log.push('Subsonic HEAD stream preserves method and headers without a body');

  const subPost = await subRegistry.stream(new Request(subFirst.streamUrl, { method: 'POST' }), { timeoutMs: 5000 });
  if (subPost.status !== 405 || subPost.headers.get('allow') !== 'GET, HEAD') fail('server stream URLs should reject methods other than GET/HEAD');
  log.push('server stream method guard rejects non-media methods');

  const subRedirect = await subRegistry.stream(new Request('newamp://server/nav-local/redirect-sub/redirect.mp3'), { timeoutMs: 5000 });
  const subRedirectBody = await subRedirect.text();
  if (subRedirect.status !== 502) fail(`Subsonic redirect should fail closed with 502, got ${subRedirect.status}`);
  if (/nav-pass|token=|[?&]t=/.test(subRedirectBody)) fail('Subsonic redirect error body must be sanitized');
  log.push('Subsonic stream redirect fails closed without following auth query params');

  try {
    parseMusicServerStreamUrl('newamp://server/only-connection');
    fail('malformed server URLs must be rejected');
  } catch (err) {
    if (!/malformed/i.test(err.message)) fail(`expected malformed server URL error, got: ${err.message}`);
  }

  try {
    await testMusicServerConnection({
      provider: 'jellyfin',
      baseUrl: `http://127.0.0.1:${port}/slow`,
      username: 'jf-user',
      password: 'jf-pass',
    }, { timeoutMs: 250 });
    fail('hung server connection test must time out');
  } catch (err) {
    if (!/timed out|aborted|too long/i.test(err.message)) fail(`expected timeout error, got: ${err.message}`);
  }
  log.push('malformed inputs and timeouts return bounded sanitized errors');

  {
    const controller = new AbortController();
    const slowBody = testMusicServerConnection({
      provider: 'jellyfin',
      baseUrl: `http://127.0.0.1:${port}/slow-body`,
      username: 'jf-user',
      password: 'jf-pass',
    }, { timeoutMs: 250, signal: controller.signal });
    slowBody.catch(() => {});
    try {
      await withGuard(slowBody, 1200, 'slow partial JSON body ignored the configured timeout');
      fail('slow partial JSON body must time out');
    } catch (err) {
      if (/ignored the configured timeout/i.test(err.message)) fail(err.message);
      else if (!/timed out|aborted|too long/i.test(err.message)) fail(`expected body timeout error, got: ${err.message}`);
      else log.push(`slow partial JSON body timed out: ${err.message}`);
    } finally {
      controller.abort(new Error('test cleanup'));
    }
  }

  const blankJellyfin = await testMusicServerConnection({
    provider: 'jellyfin',
    connectionId: 'blank-local',
    baseUrl: `http://127.0.0.1:${port}/blank-jellyfin`,
    username: 'space-user',
    password: '  ',
  }, { timeoutMs: 5000 });
  if (blankJellyfin.connection.serverName !== 'Blank Jellyfin') fail('Jellyfin should allow blank passwords when the server accepts them');
  log.push('Jellyfin connection keeps blank passwords exact for auth');
} finally {
  server.closeAllConnections?.();
  server.close();
}

const leakedRequests = seen.filter((entry) => entry.path === '/leak');
if (leakedRequests.length) fail(`redirect leak endpoint was requested ${leakedRequests.length} time(s)`);

const report = log.join('\n') + '\n' + (pass ? '[music-servers-test] PASS' : '[music-servers-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
