// Regression checks for the shared helpers: the Ask compiler, the tag DSL and
// its regex matcher, harmonic mixes, Discover ranking, quality badges, shortcut
// letters, DNA averaging and the shuffle replay stack. Bundles the modules
// itself, so it needs no prior build.
// Run with: node scripts/shared-helpers-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const outDir = resolve('tmp', 'shared-helpers-test');
await mkdir(outDir, { recursive: true });
const names = [
  'query-intent', 'tag-dsl', 'safe-regex', 'harmonic-mix', 'discover', 'audio-quality',
  'format-badge', 'keyboard-shortcuts', 'audio-dna', 'smart-shuffle',
];
await build({
  entryPoints: names.map((name) => resolve('shared', `${name}.ts`)),
  bundle: true,
  format: 'esm',
  platform: 'node',
  outdir: outDir,
  logLevel: 'silent',
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.js`)).toString());
const intent = await load('query-intent');
const dsl = await load('tag-dsl');
const regex = await load('safe-regex');
const mix = await load('harmonic-mix');
const discover = await load('discover');
const quality = await load('audio-quality');
const badges = await load('format-badge');
const shortcuts = await load('keyboard-shortcuts');
const dna = await load('audio-dna');
const shuffle = await load('smart-shuffle');

// ---- query-intent ----------------------------------------------------------
const NOW = new Date(2026, 6, 2, 12).getTime();
{
  const both = intent.compileQueryIntent('80s and 90s rock', NOW);
  assert.equal(both.rule.minYear, 1980);
  assert.equal(both.rule.maxYear, 1999);
  assert.equal(both.rule.searchQuery, 'rock', 'the second decade must not leak into the text search');
  const mixed = intent.compileQueryIntent('songs from the 80s and the nineties', NOW);
  assert.equal(mixed.rule.minYear, 1980);
  assert.equal(mixed.rule.maxYear, 1999);

  assert.equal(intent.compileQueryIntent('since 1990', NOW).rule.minYear, 1990);
  assert.equal(intent.compileQueryIntent('after 1990', NOW).rule.minYear, 1991);
  assert.equal(intent.compileQueryIntent('post-2000 indie', NOW).rule.minYear, 2001);
  assert.equal(intent.compileQueryIntent('post 2000 indie', NOW).rule.minYear, 2001);

  const tens = intent.compileQueryIntent('tens of songs', NOW);
  assert.equal(tens.rule.minYear, undefined, '"tens of songs" is not a decade');
  assert.equal(intent.compileQueryIntent('hits from the tens', NOW).rule.minYear, 2010);

  const years = intent.compileQueryIntent('stuff I haven’t played in years', NOW);
  assert.ok(Math.abs(years.rule.notPlayedSinceMs - (NOW - 90 * 86_400_000)) < 86_400_000);

  assert.equal(intent.compileQueryIntent('calm 坂 songs from the 70s', NOW).rule.searchQuery, '坂', 'a one-character CJK name survives');

  // Titles that happen to contain a vocabulary word stay a literal search.
  for (const title of ['dark side of the moon', 'bright eyes lover you', 'slow dancing in the dark']) {
    const result = intent.compileQueryIntent(title, NOW);
    assert.equal(result.matched, 0, title);
    assert.equal(result.rule.searchQuery, title);
  }
  const ask = intent.compileQueryIntent('warm slow stuff from the 70s', NOW);
  assert.ok(ask.matched >= 3, 'a request made of recognised words is still compiled');
}

// ---- tag-dsl ---------------------------------------------------------------
const env = dsl.buildEvalEnvironment(NOW);
function ctx(overrides = {}) {
  return {
    id: 7, title: 'Song', artist: 'Artist', album: 'Album', albumArtist: 'Artist', genre: 'pop',
    year: 2020, duration: 200, bitrate: 320000, sampleRate: 44100, size: 1024, mtime: 5, bpm: 120,
    key: null, format: 'flac', rating: 0, ratingScore: null, playCount: 0, skipCount: 0,
    lastPlayed: null, lastSkipped: null, loved: false, avoidAutoPlay: false,
    replayGainTrack: null, replayGainAlbum: null, dna: null, tags: new Set(),
    ...overrides,
  };
}
const matches = (body, overrides) => {
  const parsed = dsl.parseRule(body);
  assert.ok(parsed.rule, `${body}: ${JSON.stringify(parsed.errors)}`);
  return dsl.evaluateRule(parsed.rule, ctx(overrides), env);
};
{
  // Regex escapes reach the matcher intact.
  assert.equal(matches('tag(a) when title matches "\\bremix\\b"', { title: 'The Remix Edit' }).matched, true);
  assert.equal(matches('tag(a) when title matches "\\bremix\\b"', { title: 'Remixed' }).matched, false);
  assert.equal(matches('tag(a) when title matches "^\\d+$"', { title: '1234' }).matched, true);
  assert.equal(matches('tag(a) when title matches "\\."', { title: 'abc' }).matched, false);
  assert.equal(matches('tag(a) when title matches "\\\\d"', { title: '5' }).matched, true, 'a doubled backslash still works');
  assert.equal(matches('tag(a) when title == "say \\"hi\\""', { title: 'say "hi"' }).matched, true);

  // Signed ranges.
  assert.equal(matches('tag(a) when replaygain in -12..-6', { replayGainTrack: -8 }).matched, true);
  assert.equal(matches('tag(a) when replaygain in -12..-6', { replayGainTrack: -3 }).matched, false);
  assert.equal(matches('tag(a) when bpm in -5..500', { bpm: 120 }).matched, true);
  assert.equal(matches('tag(a) when bpm - -20 == 140', { bpm: 120 }).matched, true);
  assert.equal(matches('tag(a) when -bpm < 0', { bpm: 120 }).matched, true);
  const backwards = dsl.parseRule('tag(a) when bpm in 120..90');
  assert.equal(backwards.rule, null);
  assert.match(backwards.errors[0].message, /runs backwards/);

  // Three-valued AND/OR under NOT.
  assert.equal(matches('tag(a) when not (dna.energy > 0.5 and genre == "rock")').matched, true);
  assert.equal(matches('tag(a) when not (dna.energy > 0.5 or genre == "rock")').matched, false);
  assert.equal(matches('tag(a) when dna.energy > 0.5 or genre == "pop"').matched, true);
  assert.equal(matches('tag(a) when dna.energy > 0.5 and genre == "pop"').matched, false);

  // Strings and numbers.
  assert.equal(matches('tag(a) when title < 5', { title: '' }).matched, false);
  assert.equal(matches('tag(a) when genre + 1 == 1', { genre: '' }).matched, false);
  assert.equal(matches('tag(a) when genre + 1 == 17', { genre: '0x10' }).matched, false);
  assert.equal(matches('tag(a) when genre + 1 == 4', { genre: ' 3.0 ' }).matched, true);
  assert.equal(matches('tag(a) when artist >= "b"', { artist: 'Beatles' }).matched, true);
  assert.equal(matches('tag(a) when artist >= "b"', { artist: 'beatles' }).matched, true);

  // New context fields.
  assert.equal(matches('tag(a) when id == 7 and mtime == 5').matched, true);

  // Identifier list.
  const idents = dsl.listIdentifiers();
  assert.ok(idents.includes('bpm') && idents.includes('dna.energy') && !idents.includes('energy'));
  for (const name of idents) {
    const body = name.includes('.') ? `tag(t) when ${name} > -1000` : `tag(t) when ${name} == ${name}`;
    const rule = dsl.parseRule(body).rule;
    assert.deepEqual(dsl.evaluateRule(rule, ctx(), env).errors, [], `${name} must evaluate`);
  }

  // Strict mode: typos are reported with a position.
  const lax = dsl.parseRule('tag(t) when lowr(title) == "x"');
  assert.ok(lax.rule, 'default parsing still accepts any identifier');
  for (const [body, message] of [
    ['tag(t) when lowr(title) == "x"', /unknown function "lowr"/],
    ['tag(t) when enery > 3', /unknown identifier "enery"/],
    ['tag(t) when dna.enrgy > 3', /unknown dna field "enrgy"/],
    ['tag(t) when track.mtimee > 3', /unknown track field "mtimee"/],
    ['tag(t) when lower(title, artist) == "x"', /takes 1 argument/],
    ['tag(t) when hour(1) > 3', /takes 0 arguments/],
  ]) {
    const strict = dsl.parseRule(body, { strict: true });
    assert.equal(strict.rule, null, body);
    assert.match(strict.errors[0].message, message);
    assert.ok(strict.errors[0].column > 1, `${body} should report the column of the name`);
  }
  assert.ok(dsl.parseRule('tag(t) when dna.energy > 0.5 and min(bpm, 100) > 3 and mtime > 0', { strict: true }).rule);

  // Per-track evaluation reuses the sorted rules and still follows tag references.
  const rules = ['tag(a) when bpm > 100', 'tag(b) when tag(a) and bpm < 200'].map((body) => dsl.parseRule(body).rule);
  const first = dsl.prepareRules(rules);
  assert.equal(dsl.prepareRules(rules), first, 'the same rules array is sorted once');
  const evaluated = dsl.evaluateRulesForTrack({ rules, context: ctx(), env });
  assert.deepEqual([...evaluated.tags].sort(), ['a', 'b']);
  rules.reverse();
  assert.deepEqual(dsl.prepareRules(rules).ordered.map((rule) => rule.name), ['a', 'b'], 'an edited array is sorted again');
}

// ---- safe-regex ------------------------------------------------------------
{
  const yes = (pattern, input) => assert.equal(regex.SafeRegex.compile(pattern).test(input), true, `${pattern} ~ ${input}`);
  const no = (pattern, input) => assert.equal(regex.SafeRegex.compile(pattern).test(input), false, `${pattern} !~ ${input}`);
  yes('σ', 'ς'); yes('ς', 'Σ'); yes('Σ', 'ς'); yes('ΟΔΟΣ', 'οδος'); yes('[ς]', 'Σ');
  no('[a-z]', 'ı'); no('i', 'ı'); no('k', 'K');
  yes('café', 'CAFÉ'); yes('[à-ö]+', 'ÀÖ'); yes('漢字', '漢字'); no('漢字', '漢語');
  yes('😀', 'a 😀 b');

  // One instance, many inputs of varying length, hits and misses interleaved.
  const re = regex.SafeRegex.compile('^(ab)+c$');
  for (let i = 0; i < 2000; i++) {
    assert.equal(re.test('ab'.repeat((i % 40) + 1) + 'c'), true);
    assert.equal(re.test('ab'.repeat((i % 40) + 1) + 'd'), false);
  }
  assert.equal(re.test('ab'.repeat(3000) + 'c'), true, 'a long input after short ones');

  assert.throws(() => regex.SafeRegex.compile('(.{60}){60}x'), (err) => err.code === 'too-complex');
  assert.ok(regex.SafeRegex.compile('(a{1,16}){1,16}$'));
}

// ---- harmonic-mix ----------------------------------------------------------
function track(id, overrides = {}) {
  return {
    id, path: `/m/${id}.mp3`, title: `t${id}`, artist: `a${id}`, album: 'al', albumArtist: 'a',
    trackNo: 1, discNo: null, year: null, genre: null, duration: 200, bitrate: 320000,
    sampleRate: 44100, size: 1, mtime: 1, hasArt: 0, loved: 0, rating: 0, ratingScore: null,
    avoidAutoPlay: 0, playCount: 0, lastPlayed: null, skipCount: 0, lastSkipped: null,
    bpm: 120, key: null, replayGainTrackDb: null, replayGainAlbumDb: null,
    ...overrides,
  };
}
{
  const keyScore = (a, b) => mix.harmonicTransitionScore(track(1, { key: a }), track(2, { key: b })).keyScore;
  assert.equal(keyScore('C', 'C Major'), 1);
  assert.equal(keyScore('C', 'C'), 1);
  assert.ok(keyScore('C', 'A Minor') >= 0.95);
  assert.notEqual(keyScore('C', 'AM'), 0.18, '"AM" parses');
  assert.notEqual(keyScore('C', 'A Minor'), 0.18, 'A Minor parses');
  assert.equal(keyScore('C', 'Am'), keyScore('C', 'A MINOR'));
  assert.equal(keyScore('C', '8B'), 1, 'the same key in Camelot notation');
  assert.equal(keyScore('Am', '1m'), 1, 'Open Key 1m is A minor');
  assert.equal(keyScore('C', '1d'), 1, 'Open Key 1d is C major');
  assert.equal(keyScore('B', 'Cb'), 1);
  assert.equal(keyScore('E', 'Fb'), 1);
  assert.equal(keyScore('F', 'E#'), 1);
  assert.equal(keyScore('C', 'B#'), 1);
  assert.equal(keyScore('Bb Minor', 'A# minor'), 1);
  // E minor is G major's relative, one step from C; D minor and G minor differ.
  assert.ok(keyScore('C', 'Em') > 0.7, `C to Em should be close, got ${keyScore('C', 'Em')}`);
  assert.ok(keyScore('C', 'Dm') > keyScore('C', 'Gm'));
  assert.ok(keyScore('C', 'F#') < 0.3);

  // An explicit seed shorter than 20 s still seeds the mix.
  const seed = track(1, { duration: 15, key: 'C' });
  const rest = [2, 3, 4].map((id) => track(id, { key: 'G' }));
  const result = mix.buildHarmonicMix([seed, ...rest], { seedTrackId: 1, count: 3 });
  assert.equal(result[0].id, 1);
  assert.equal(result.length, 3);
  // Without an explicit seed the short track is still left out.
  assert.ok(!mix.buildHarmonicMix([seed, ...rest], { count: 4 }).some((t) => t.id === 1));

  // Big no-seed mix stays quick and deterministic.
  const many = Array.from({ length: 10_000 }, (_, i) => track(i + 1, { bpm: 80 + (i % 90), key: ['C', 'Am', 'G', '8B', '3A', null][i % 6] }));
  const started = performance.now();
  const big = mix.buildHarmonicMix(many, { count: 200 });
  const elapsed = performance.now() - started;
  assert.equal(big.length, 200);
  assert.deepEqual(mix.buildHarmonicMix(many, { count: 200 }).map((t) => t.id), big.map((t) => t.id));
  assert.ok(elapsed < 600, `10k-candidate mix took ${elapsed.toFixed(0)} ms`);
}

// ---- discover --------------------------------------------------------------
{
  const NOW_D = Date.UTC(2026, 9, 1);
  const base = (id, overrides = {}) => track(id, { mtime: NOW_D - id * 1000, ...overrides });
  const tracks = [];
  // 30 tracks by one artist with no album tag, and a real 12-track album.
  for (let i = 0; i < 30; i++) tracks.push(base(100 + i, { artist: 'Loose', albumArtist: '', album: '', trackNo: i + 1 }));
  for (let i = 0; i < 18; i++) tracks.push(base(200 + i, { artist: 'Band', albumArtist: 'Band', album: 'Real Album', trackNo: i + 1, playCount: 0 }));
  const surface = discover.buildDiscoverSurface({ tracks, now: NOW_D, seed: 's', limit: 12 });
  const deep = surface.cards.find((card) => card.id === 'deep-album-run');
  assert.ok(deep.title.includes('Real Album'), deep.title);
  assert.equal(deep.tracks.length, 18, 'the whole album, not the first 12');
  const session = surface.missions.find((mission) => mission.id === 'album-session');
  assert.equal(session.steps[0].tracks.length, 18);

  // Words that merely contain "home", "field" or "memo" are not private recordings.
  const normal = [1, 2, 3].map((i) => base(300 + i, { title: `Homecoming ${i}`, album: 'Springfield', artist: 'Memories', genre: 'Rock', playCount: 0, year: 2020 }));
  const demo = [1, 2, 3].map((i) => base(400 + i, { title: `Sketch ${i}`, album: 'Basement Tapes', artist: 'Someone', genre: 'Rock', playCount: 0, year: 2020 }));
  const weird = discover.buildDiscoverSurface({ tracks: [...normal, ...demo], now: NOW_D, seed: 'w', limit: 4 }).cards.find((card) => card.id === 'weird-shelf');
  assert.ok(weird.tracks.slice(0, 3).every((t) => t.album === 'Basement Tapes'), 'the demo tapes outrank ordinary titles');

  // The quiet-time bonus stops at a year, and a never-played favorite counts as a year quiet.
  const loved = (id, lastPlayed, playCount) => base(id, { loved: 1, playCount, lastPlayed });
  const DAY = 86_400_000;
  const quiet = discover.buildDiscoverSurface({
    tracks: [
      loved(501, null, 4),
      loved(502, NOW_D - 90 * DAY, 4),
      loved(503, NOW_D - 1095 * DAY, 4),
      loved(504, NOW_D - 400 * DAY, 7),
      loved(505, NOW_D - 90 * DAY, 7),
    ],
    now: NOW_D, seed: 'f', limit: 8,
  }).cards.find((card) => card.id === 'forgotten-favorites');
  const order = quiet.tracks.map((t) => t.id);
  // Uncapped, three years quiet would add about 55 points over 400 days and put 503 first;
  // capped, the stronger signal of 504 wins and 501 and 503 tie apart from the seeded jitter.
  assert.equal(order[0], 504, order.join());
  assert.deepEqual(order.slice(1, 3).sort(), [501, 503], order.join());
  assert.deepEqual(order.slice(3), [505, 502], order.join());

  // Visual plans: every deck skin is reachable and the flagship is always featured.
  const decks = new Set();
  for (let i = 0; i < 400; i++) {
    const plan = discover.buildDiscoverSurface({ tracks: tracks.slice(0, 20), now: NOW_D, seed: `seed-${i}`, limit: 8 })
      .missions.find((mission) => mission.id === 'visual-night').visualPlan;
    decks.add(plan.deckSkin);
    assert.ok(plan.presets.includes('eviland'));
    assert.equal(new Set(plan.presets).size, plan.presets.length);
    assert.equal(plan.presets.length, 5);
  }
  assert.ok(decks.has('jukebox') && decks.has('winamp-industrial'), [...decks].join());
  const low = discover.buildDiscoverSurface({ tracks: tracks.slice(0, 20), now: NOW_D, seed: 'x', limit: 8, lowEndMode: true })
    .missions.find((mission) => mission.id === 'visual-night').visualPlan;
  assert.ok(!low.presets.includes('eviland') && !low.presets.includes('neon-waves'));
}

// ---- audio-quality / format-badge -------------------------------------------
{
  const flac = { path: '/m/a.flac', bitrate: 900000, sampleRate: 48000, duration: 200, size: 1 };
  assert.equal(quality.classifyAudioQuality({ ...flac, bitsPerSample: 24 }).isHiRes, true, '24-bit/48k counts as hi-res');
  assert.equal(quality.classifyAudioQuality({ ...flac, bitsPerSample: 16 }).isHiRes, false);
  assert.equal(quality.classifyAudioQuality(flac).isHiRes, false);
  assert.equal(quality.classifyAudioQuality({ ...flac, sampleRate: 96000, bitsPerSample: 16 }).isHiRes, true);

  const lossy = (path, bitrate, codec) => quality.classifyAudioQuality({ path, bitrate, sampleRate: 44100, codec }).isLowBitrate;
  assert.equal(lossy('/m/a.mp3', 160000), true);
  assert.equal(lossy('/m/a.mp3', 192000), false);
  assert.equal(lossy('/m/a.opus', 128000), false);
  assert.equal(lossy('/m/a.opus', 64000), true);
  assert.equal(lossy('/m/a.m4a', 160000, 'MPEG-4/AAC'), false);
  assert.equal(lossy('/m/a.m4a', 96000, 'MPEG-4/AAC'), true);
  assert.equal(lossy('/m/a.ogg', 128000, 'Vorbis I'), false);

  assert.equal(quality.isMusicServerStreamPath('/Users/me/Music/a.flac'), false);
  assert.equal(quality.isMusicServerStreamPath('newamp://server/nav/1/Track.flac'), true);
  assert.equal(quality.isMusicServerStreamPath('NEWAMP://server/x'), true);
  assert.equal(quality.isMusicServerStreamPath('newamp://other/x'), false);

  const stream = { path: 'newamp://server/stream/1', bitrate: 900000, sampleRate: 44100 };
  assert.ok(!badges.formatBadgesForTrack(stream, { verbose: true }).some((badge) => badge.kind === 'lossy' || /lossy/i.test(badge.title)));
  assert.deepEqual(badges.formatBadgesForTrack(stream), []);
  assert.equal(badges.formatBadgesForTrack(stream, { verbose: true })[0].kind, 'container');
  const warn = badges.formatBadgesForTrack({ path: '/m/a.mp3', bitrate: 128000, sampleRate: 44100 })[0];
  assert.equal(warn.tone, 'warn');
}

// ---- keyboard-shortcuts ----------------------------------------------------
{
  const press = (key, code, extra = {}) => shortcuts.resolvePlayerShortcut({ key, code, ...extra });
  assert.equal(press('z', 'KeyZ'), 'previous');
  assert.equal(press('я', 'KeyZ'), 'previous', 'Russian layout');
  assert.equal(press('ζ', 'KeyZ'), 'previous', 'Greek layout');
  assert.equal(press('ч', 'KeyX'), 'play');
  assert.equal(press('л', 'KeyL'), 'toggle-love');
  assert.equal(press('а', 'KeyF'), 'toggle-fullscreen-visualizer');
  assert.equal(press('Ы', 'KeyS', { shiftKey: true }), 'cycle-skin');
  // A Latin layout keeps the letter printed on the key: Dvorak's "z" key sits where QWERTY has "/".
  assert.equal(press('z', 'Slash'), 'previous');
  assert.equal(press(';', 'KeyZ'), null);
  assert.equal(press('я', 'KeyZ', { targetEditable: true }), null);
}

// ---- audio-dna -------------------------------------------------------------
{
  const rate = 22050;
  const loud = new Float32Array(rate * 4);
  for (let i = 0; i < loud.length; i++) loud[i] = 0.5 * Math.sin((2 * Math.PI * 3000 * i) / rate);
  const padded = new Float32Array(rate * 8);
  padded.set(loud, rate * 2);
  const plain = dna.computeTrackDna(loud, { sampleRate: rate });
  const withSilence = dna.computeTrackDna(padded, { sampleRate: rate });
  assert.ok(Math.abs(plain.brightness - withSilence.brightness) < 0.02, `${plain.brightness} vs ${withSilence.brightness}`);
  const sum = withSilence.bands.reduce((a, b) => a + b, 0);
  assert.ok(sum > 0.97 && sum < 1.03, `bands sum to ${sum}`);

  const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff]);
  const pcm = dna.pcmFromInt16(bytes);
  assert.deepEqual([...pcm], [0.5, -0.5]);
  const slice = Buffer.from([9, 9, 0x00, 0x40]).subarray(2);
  assert.deepEqual([...dna.pcmFromInt16(slice)], [0.5], 'a view into a larger buffer');
}

// ---- smart-shuffle ---------------------------------------------------------
{
  const length = 10;
  let history = shuffle.resetSmartShuffleHistory(length, 0);
  let current = 0;
  let forward = [];
  const step = (fn) => { const r = fn(); current = r.index; history = r.history; forward = r.forward ?? []; return r; };
  step(() => shuffle.nextSmartShuffle({ queueLength: length, currentIndex: current, history, forward }, () => 0.3));
  step(() => shuffle.nextSmartShuffle({ queueLength: length, currentIndex: current, history, forward }, () => 0.6));
  const left = current;
  const back = step(() => shuffle.previousSmartShuffle({ queueLength: length, currentIndex: current, history, forward }));
  assert.notEqual(back.index, left);
  const again = step(() => shuffle.nextSmartShuffle({ queueLength: length, currentIndex: current, history, forward }, () => 0.9));
  assert.equal(again.index, left, 'Next after Previous returns to the track that was left');
  assert.deepEqual(again.forward, []);
  assert.equal(new Set(history).size, history.length, 'no track twice in a cycle');
  // With nothing to replay, Next is a random pick and carries no replay stack.
  const fresh = shuffle.nextSmartShuffle({ queueLength: length, currentIndex: current, history, forward }, () => 0);
  assert.equal(fresh.forward, undefined);
  // Several Previous steps replay in the order they were undone.
  const a = shuffle.nextSmartShuffle({ queueLength: length, currentIndex: 0, history: [0] }, () => 0.2);
  const b = shuffle.nextSmartShuffle({ queueLength: length, currentIndex: a.index, history: a.history }, () => 0.5);
  const c = shuffle.nextSmartShuffle({ queueLength: length, currentIndex: b.index, history: b.history }, () => 0.8);
  const p1 = shuffle.previousSmartShuffle({ queueLength: length, currentIndex: c.index, history: c.history });
  const p2 = shuffle.previousSmartShuffle({ queueLength: length, currentIndex: p1.index, history: p1.history, forward: p1.forward });
  const n1 = shuffle.nextSmartShuffle({ queueLength: length, currentIndex: p2.index, history: p2.history, forward: p2.forward });
  const n2 = shuffle.nextSmartShuffle({ queueLength: length, currentIndex: n1.index, history: n1.history, forward: n1.forward });
  assert.deepEqual([n1.index, n2.index], [b.index, c.index]);
  // Previous at the start of history keeps the replay stack, so Next still goes forward.
  const start = shuffle.previousSmartShuffle({ queueLength: length, currentIndex: 0, history: [0], forward: [4, 2] });
  assert.equal(start.index, 0);
  assert.deepEqual(start.forward, [4, 2]);
  const s0 = shuffle.nextSmartShuffle({ queueLength: length, currentIndex: 5, history: [5] }, () => 0.4);
  const s1 = shuffle.nextSmartShuffle({ queueLength: length, currentIndex: s0.index, history: s0.history }, () => 0.7);
  const q1 = shuffle.previousSmartShuffle({ queueLength: length, currentIndex: s1.index, history: s1.history });
  const q2 = shuffle.previousSmartShuffle({ queueLength: length, currentIndex: q1.index, history: q1.history, forward: q1.forward });
  const q3 = shuffle.previousSmartShuffle({ queueLength: length, currentIndex: q2.index, history: q2.history, forward: q2.forward });
  assert.equal(q3.index, 5);
  const q4 = shuffle.nextSmartShuffle({ queueLength: length, currentIndex: q3.index, history: q3.history, forward: q3.forward });
  assert.equal(q4.index, s0.index, 'Next after Previous past the start replays the stepped-over track');
  // A stale replay position that already played is skipped.
  const stale = shuffle.nextSmartShuffle({ queueLength: length, currentIndex: 0, history: [0, 3], forward: [3] }, () => 0);
  assert.notEqual(stale.index, 3);
}

console.log('[shared-helpers-test] PASS');
