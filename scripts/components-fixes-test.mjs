// Checks for the renderer component fixes: the scrub bar seeks once per input
// event, the wheel never seeks backwards near the end, the entity links keep
// real artists whose names start with "Unknown", the Quick Play list keeps
// room for tracks and leads with an exact title, the palette lists what was
// typed before the Ask answers, the decks cycle repeat the way the transport
// does, a rule's discard warning follows its edits, the Settings slider keeps
// its place until the last save lands, and the share card leaves a color it
// cannot read alone.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { bundleComponent, findAll, mount } from './lib/hook-harness.mjs';

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

async function bundle(entry, { append = '', stubs = {} } = {}) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false', 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
    plugins: [{
      name: 'a14',
      setup(b) {
        const names = Object.keys(stubs);
        if (names.length) {
          b.onResolve({ filter: new RegExp(`^(${names.map((n) => n.replace(/[.\\/]/g, '\\$&')).join('|')})$`) }, (args) => ({ path: args.path, namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path], loader: 'js' }));
        }
        if (append) {
          // Matched on the resolved path: esbuild hands onLoad backslashes on Windows.
          b.onLoad({ filter: /\.tsx?$/ }, async (args) => {
            if (resolve(args.path) !== resolve(entry)) return undefined;
            return {
              contents: `${await readFile(args.path, 'utf8')}\n${append}`,
              loader: args.path.endsWith('x') ? 'tsx' : 'ts',
            };
          });
        }
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

const storeStub = "export const usePlayerStore = Object.assign(() => ({}), { getState: () => ({}) });";
const apiStub = "export const api = { platform: 'darwin' };";

// --- ScrubBar: one seek per input event -------------------------------------------------
{
  const source = await read('src/components/ScrubBar.tsx');
  assert.doesNotMatch(source, /onInput=/, 'onChange already fires for every input event of a range input');
  assert.equal(source.match(/onChange=/g)?.length, 1, 'the slider commits from onChange only');

  // Render the slider and fire every commit handler it carries once for one input event, the way React
  // does for a range input. Whatever the handlers are called, the engine must see a single seek.
  const { ScrubBar } = await bundle('src/components/ScrubBar.tsx', {
    stubs: {
      react: 'export const useRef = (initial) => ({ current: initial }); export const useEffect = () => {};',
      'react/jsx-runtime': 'export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx; export const Fragment = Symbol("Fragment");',
      '../hooks/useWheelSeek': 'export const useWheelSeek = () => {};',
      './WaveformSeek': 'export const WaveformSeek = () => null;',
    },
  });
  const seeks = [];
  const slider = ScrubBar({ value: 10, max: 200, onSeek: (seconds) => seeks.push(seconds) });
  assert.equal(slider.type, 'input');
  const input = { value: '42' };
  for (const name of ['onInput', 'onChange']) slider.props[name]?.({ currentTarget: input });
  assert.deepEqual(seeks, [42], 'one input event commits one seek');
}

// --- Wheel seek near the end of the track ------------------------------------------------
{
  const { createWheelSeek } = await bundle('src/lib/wheel-seek.ts');
  const notch = (deltaY) => ({ deltaY, deltaX: 0, deltaMode: 0 });
  // A step forward inside the last second does not pull the playhead back to the margin.
  let seek = createWheelSeek();
  assert.deepEqual(seek.handle(notch(-100), 1000, 359.5, 360), { consumed: true, target: null });
  assert.deepEqual(seek.handle(notch(-100), 1040, 359.5, 360), { consumed: true, target: null }, 'and neither does the next one');
  seek = createWheelSeek();
  assert.deepEqual(seek.handle(notch(-100), 1000, 360, 360), { consumed: true, target: null });
  // Backwards still works from there, and forwards still stops at the margin.
  seek = createWheelSeek();
  assert.equal(seek.handle(notch(100), 1000, 359.5, 360).target, 354.5);
  seek = createWheelSeek();
  assert.equal(seek.handle(notch(-100), 1000, 357, 360).target, 359, 'a step that crosses the margin stops on it');
}

// --- EntityLink: only the placeholder names are unlinked ---------------------------------
{
  const { ArtistLink, AlbumLink } = await bundle('src/components/EntityLink.tsx', { stubs: { '../store/usePlayerStore': storeStub } });
  const typeOf = (element) => element.type;
  for (const name of ['Unknown Mortal Orchestra', 'Unknown Pleasures']) {
    assert.equal(typeOf(ArtistLink({ artist: name })), 'button', `${name} is a real artist`);
    assert.equal(typeOf(AlbumLink({ album: name, albumArtist: 'x' })), 'button', `${name} is a real album`);
  }
  for (const name of ['', '  ', 'Unknown', 'unknown artist', 'Unknown Album', '<unknown>', '[Unknown]']) {
    assert.equal(typeOf(ArtistLink({ artist: name })), 'span', `${JSON.stringify(name)} stays plain text`);
  }
}

// --- Quick Play: ranking and room for tracks ---------------------------------------------
{
  const { buildPaletteItems } = await bundle('src/components/QuickPlayPalette.tsx', {
    append: 'export { buildPaletteItems };',
    stubs: { '../store/usePlayerStore': storeStub, '../lib/api': apiStub },
  });
  const track = (id, title) => ({ id, title, artist: 'A', album: 'B', albumArtist: 'A', duration: 100 });
  const tracks = Array.from({ length: 24 }, (_, i) => track(i + 1, `Song ${i + 1}`));
  const playlists = Array.from({ length: 8 }, (_, i) => ({ id: i, name: `Mix playlist ${i}`, updatedAt: i, trackCount: 1, duration: 1 }));
  const albums = Array.from({ length: 8 }, (_, i) => ({ albumKey: `k${i}`, album: `Mix album ${i}`, albumArtist: 'A', trackCount: 1 }));
  const artists = Array.from({ length: 8 }, (_, i) => ({ artist: `Mix artist ${i}`, albumCount: 1, trackCount: 1 }));
  const kinds = (items) => items.map((item) => item.kind);
  const count = (items, kind) => kinds(items).filter((k) => k === kind).length;

  // A broad query matches views and commands as well as everything else; tracks still get their rows.
  const broad = buildPaletteItems('a', tracks, playlists, [], albums, artists, 48);
  assert.ok(broad.length <= 48);
  assert.ok(count(broad, 'track') >= 12, `a broad query keeps at least 12 tracks, got ${count(broad, 'track')}`);
  assert.ok(count(broad, 'view') + count(broad, 'command') <= 6, 'views and commands share six rows');

  // An exact title leads, ahead of any view that also matches.
  const exact = buildPaletteItems('library', [track(1, 'Other'), track(2, 'Library')], [], [], [], [], 48);
  assert.equal(exact[0].kind, 'track');
  assert.equal(exact[0].title, 'Library');
  assert.equal(exact[1].kind, 'view', 'the Library view follows');

  // The prefix match of a view outranks a substring match when the six are cut.
  const menu = buildPaletteItems('li', [], [], [], [], [], 48).filter((item) => item.kind === 'view');
  assert.equal(menu[0].title, 'Library');

  // With nothing typed every view stays listed, and the limit leaves the tracks their share.
  const idle = buildPaletteItems('', tracks, playlists, [], [], [], 44);
  assert.equal(count(idle, 'view'), 16);
  assert.ok(count(idle, 'track') >= 12);
  assert.ok(idle.length <= 44);
}

// --- Quick Play: the search lists before the Ask answers ---------------------------------
{
  const { searchPalette, ASK_SETTLE_MS } = await bundle('src/components/QuickPlayPalette.tsx', {
    append: 'export { searchPalette, ASK_SETTLE_MS };',
    stubs: {
      '../store/usePlayerStore': "export const usePlayerStore = Object.assign(() => ({}), { getState: () => ({ isPlaying: false, current: null, currentTime: 0 }) });",
      '../lib/api': "export const api = new Proxy({ platform: 'darwin' }, { get: (target, key) => (key in target ? target[key] : (...args) => globalThis.__quickPlay[key](...args)) });",
    },
  });
  const track = (id, title) => ({ id, title, artist: 'A', album: 'B', albumArtist: 'A', duration: 100 });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Resolves the moment the search has listed its first step, so checks about what has not happened yet
  // run before the Ask's settle time can pass, however slow the machine is.
  const listed = async (run, count = 1) => {
    while (run.steps.length < count) await new Promise((resolve) => setImmediate(resolve));
  };
  const sentence = 'slow warm stuff from the 70s';

  // The answers the main process gives, with the Ask under the test's control.
  function library(ask) {
    const calls = { ask: 0, progress: 0 };
    globalThis.__quickPlay = {
      getTracks: async () => [track(1, 'Warm Slow Stuff')],
      getPlaylists: async () => [],
      getSmartPlaylistRules: async () => [],
      getAlbums: async () => [],
      getArtists: async () => [],
      getListeningHistory: async () => [],
      runSmartPlaylistRule: () => {
        calls.ask += 1;
        return ask();
      },
      getAnalysisProgress: async () => {
        calls.progress += 1;
        return { total: 10, coverage: { tempo: 5 } };
      },
    };
    return calls;
  }
  function search(query) {
    const run = { steps: [], current: true };
    run.done = searchPalette(query, () => run.current, (step) => run.steps.push(step));
    return run;
  }

  // A slow Ask holds nothing up: the rows for what was typed are listed at once, and the Ask is not even sent yet.
  {
    let answer;
    const calls = library(() => new Promise((resolve) => { answer = resolve; }));
    const run = search(sentence);
    await listed(run);
    assert.equal(run.steps.length, 1, 'the search is listed without waiting for the Ask');
    assert.deepEqual(run.steps[0].items.map((item) => item.id), ['track:1']);
    assert.equal(run.steps[0].append, false);
    assert.equal(run.steps[0].status, 'Asking your library...');
    assert.ok(run.steps[0].askChips.includes('1970s'), 'what was understood shows straight away');
    assert.equal(calls.ask, 0, 'the Ask waits for the query to settle');
    assert.equal(calls.progress, 0);

    await wait(ASK_SETTLE_MS + 40);
    assert.equal(calls.ask, 1, 'then it is sent');
    assert.equal(run.steps.length, 1, 'and while it runs the list stays as it was');

    answer([track(7, 'Seventies Slow'), track(8, 'Sunday Warm')]);
    await run.done;
    assert.equal(run.steps.length, 2);
    const asked = run.steps[1];
    assert.equal(asked.append, true, 'the Ask adds its section under the rows already listed');
    assert.deepEqual(asked.items.map((item) => item.id), ['ask:7', 'ask:8']);
    assert.deepEqual(asked.askTracks.map((row) => row.id), [7, 8], 'playing an Ask row queues the whole answer');
    assert.equal(asked.status, null);
    assert.equal(asked.selectedIndex, 1, 'nothing found reads as the sentence, so the Ask is selected');
  }

  // Typing on supersedes the Ask: before it is sent it never is, and an answer that comes late is not listed.
  {
    const calls = library(() => Promise.resolve([track(7, 'Seventies Slow')]));
    const typedOn = search(sentence);
    await listed(typedOn);
    typedOn.current = false;
    await wait(ASK_SETTLE_MS + 40);
    await typedOn.done;
    assert.equal(calls.ask, 0, 'a query that was typed over never reaches the main process');
    assert.equal(typedOn.steps.length, 1);

    let answer;
    library(() => new Promise((resolve) => { answer = resolve; }));
    const late = search(sentence);
    await wait(ASK_SETTLE_MS + 40);
    late.current = false;
    answer([track(7, 'Seventies Slow')]);
    await late.done;
    assert.equal(late.steps.length, 1, 'an answer for an older query lands nowhere');
  }

  // A tempo word asks how much of the library has a tempo, after the search is listed.
  {
    const calls = library(() => Promise.resolve([]));
    const run = search('fast songs from the 80s');
    await listed(run);
    assert.equal(calls.progress, 0, 'the coverage read is not on the way to the first rows');
    await run.done;
    assert.equal(calls.progress, 1);
    assert.ok(run.steps[1].askChips.some((chip) => /tempo known for 5 of 10 tracks/.test(chip)), 'the chip says how many tracks have a tempo');
  }

  // A failed Ask leaves the search as it was, and a plain query never asks.
  {
    const calls = library(() => Promise.reject(new Error('rule failed')));
    const failed = search(sentence);
    await failed.done;
    assert.deepEqual(failed.steps.map((step) => step.items.length), [1, 0]);
    assert.equal(failed.steps[1].status, null, 'the rows found are still there to use');

    const plain = search('warm');
    await plain.done;
    assert.equal(plain.steps.length, 1);
    assert.equal(plain.steps[0].status, null);
    assert.equal(plain.steps[0].askChips, null);
    assert.equal(calls.ask, 1, 'only the sentence asked');
  }
}

// --- Tags: a second press discards only what the warning was about -----------------------
{
  globalThis.window = { setTimeout: () => 1, clearTimeout: () => undefined };
  const rules = [
    { id: 1, name: 'late_night', body: 'tag(late_night) when bpm < 90', boost: 1, enabled: true, lastError: null },
    { id: 2, name: 'deep_cuts', body: 'tag(deep_cuts) when playcount = 0', boost: 1, enabled: true, lastError: null },
  ];
  const { TagsView } = await bundleComponent('src/components/views/TagsView.tsx', {
    '../../lib/api': `export const api = {
      listTagRules: async () => globalThis.__tagRules,
      getTagSummaries: async () => [],
      previewTagRule: () => new Promise(() => {}),
    };`,
    '../../store/usePlayerStore': 'export const usePlayerStore = (select) => select({ playQueue: () => {} });',
    '../ViewOnboarding': 'export const ViewOnboarding = () => null; export const HelpDot = () => null; export const useViewHelp = () => ({ open: false, close: () => {} });',
    '../EntityLink': 'export const ArtistLink = () => null; export const TrackLink = () => null;',
    '../ViewHeader': 'export const ViewHeader = () => null;',
    '../Chip': 'export const Chip = () => null;',
    '../ConfirmAction': 'export const ConfirmAction = () => null;',
  });
  globalThis.__tagRules = rules;
  const view = mount(() => TagsView());
  view.flush();
  await new Promise((resolve) => setImmediate(resolve));
  const child = (prop) => findAll(view.flush(), (node) => node.props && prop in node.props)[0].props;
  const draft = () => child('setDraft').draft;
  const status = () => child('summaries').status;
  const edit = (body) => child('setDraft').setDraft((d) => ({ ...d, body }));

  child('onPick').onPick(rules[0]);
  assert.equal(draft().id, 1);
  edit('tag(late_night) when bpm < 80');
  child('onPick').onPick(rules[1]);
  assert.match(status(), /unsaved edits/, 'choosing another rule over an edit warns first');
  assert.equal(draft().id, 1, 'and keeps the edit');
  child('onPick').onPick(rules[1]);
  assert.equal(draft().id, 2, 'choosing it again discards');

  // Edit on after the warning: the next press warns again rather than throwing the newer edit away.
  edit('tag(deep_cuts) when playcount = 1');
  child('onPick').onPick(rules[0]);
  assert.equal(draft().id, 2, 'the warning is up');
  edit('tag(deep_cuts) when playcount = 2');
  child('onPick').onPick(rules[0]);
  assert.equal(draft().id, 2, 'an edit made after the warning is warned about too');
  assert.equal(draft().body, 'tag(deep_cuts) when playcount = 2');
  child('onPick').onPick(rules[0]);
  assert.equal(draft().id, 1, 'a second press after that discards');

  // The rule that is already open is guarded too: a stray click on it does not reload it over an edit.
  edit('tag(late_night) when bpm < 70');
  child('onPick').onPick(rules[0]);
  assert.match(status(), /unsaved edits/, 'choosing the open rule over its edits warns first');
  assert.equal(draft().body, 'tag(late_night) when bpm < 70', 'and keeps them');
  child('onPick').onPick(rules[0]);
  assert.equal(draft().body, rules[0].body, 'a second press reloads the saved rule');
  child('onPick').onPick(rules[0]);
  assert.equal(draft().body, rules[0].body, 'with nothing edited it just reloads');
  assert.equal(status(), null);
  view.unmount();
  delete globalThis.window;
  delete globalThis.__tagRules;
}

// --- Wrapped share card: a color the canvas cannot read comes back unchanged -------------
{
  const { withAlpha } = await bundle('src/components/views/WrappedView.tsx', {
    append: 'export { withAlpha };',
    stubs: {
      '../WrappedLiveExport': 'export const WrappedLiveExport = () => null;',
      '../../lib/api': 'export const api = {};',
      '../../lib/toast': 'export const pushToast = () => {};',
      '../ViewSkeleton': 'export const ViewSkeleton = () => null;',
      '../EntityLink': 'export const ArtistLink = () => null;',
    },
  });
  // A canvas that reads six-digit hex only. Like a real one, it ignores a fill it cannot parse and keeps the last.
  const canvases = () => {
    let fill = '#000000';
    let painted = [0, 0, 0, 0];
    return {
      width: 0,
      height: 0,
      getContext: () => ({
        get fillStyle() { return fill; },
        set fillStyle(value) { if (/^#[0-9a-f]{6}$/i.test(value)) fill = value.toLowerCase(); },
        fillRect() { painted = [1, 3, 5].map((at) => parseInt(fill.slice(at, at + 2), 16)).concat(255); },
        getImageData: () => ({ data: painted }),
      }),
    };
  };
  globalThis.document = { createElement: canvases };
  try {
    assert.equal(withAlpha('#ff8800', 0.2), 'rgba(255, 136, 0, 0.2)', 'a color it reads takes the opacity');
    assert.equal(withAlpha('#0a0b0c', 0), 'rgba(10, 11, 12, 0)');
    assert.equal(withAlpha('oklch(0.7 0.1 200)', 0.2), 'oklch(0.7 0.1 200)', 'one it cannot read is not turned into black');
    assert.equal(withAlpha('', 0.2), '');
  } finally {
    delete globalThis.document;
  }
}

// --- Settings sliders: the thumb stays put until the last commit lands -------------------
{
  globalThis.window = { setTimeout: () => 1, clearTimeout: () => undefined };
  const { CommitSlider } = await bundleComponent('src/components/CommitSlider.tsx');
  const commits = [];
  const props = {
    label: 'Text size', min: 0, max: 10, step: 1, value: 5,
    onCommit: (next) => new Promise((resolve) => commits.push({ next, resolve })),
  };
  const view = mount(() => CommitSlider(props));
  const thumb = () => findAll(view.flush(), (node) => node.type === 'input')[0].props;
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  const dragTo = (value) => thumb().onChange({ target: { valueAsNumber: value } });

  assert.equal(thumb().value, 5, 'the thumb shows the saved value at rest');
  dragTo(7);
  thumb().onPointerUp({});
  dragTo(9);
  thumb().onPointerUp({});
  assert.deepEqual(commits.map((commit) => commit.next), [7, 9], 'each release commits where the thumb stopped');
  assert.equal(thumb().value, 9);

  commits[0].resolve();
  await settled();
  assert.equal(thumb().value, 9, 'the first save landing does not pull the thumb back while the second is in flight');
  commits[1].resolve();
  await settled();
  props.value = 4;
  assert.equal(thumb().value, 4, 'once every commit has landed the thumb follows the saved value again');

  // Dragging on while a commit is in flight keeps the draft too.
  dragTo(2);
  thumb().onPointerUp({});
  dragTo(3);
  commits[2].resolve();
  await settled();
  assert.equal(thumb().value, 3, 'a drag that has not been released yet keeps its place');
  view.unmount();
  delete globalThis.window;
}

// --- Scan banner: a scan that could not reach a folder says so ---------------------------
{
  const { folderLabel, unreachableNotice } = await bundle('src/components/scanNotice.ts');
  const win = (...parts) => parts.join(String.fromCharCode(92));
  assert.equal(folderLabel(win('K:', 'Music')), 'Music (K:)', 'a Windows folder carries its drive');
  assert.equal(folderLabel(win('K:', 'Music', '')), 'Music (K:)');
  assert.equal(folderLabel('k:/Music/Rock'), 'Rock (k:)');
  assert.equal(folderLabel(win('K:', '')), 'K:', 'a drive on its own is shown as written');
  assert.equal(folderLabel(win('', '', 'nas', 'share', 'Rock')), 'Rock');
  assert.equal(folderLabel('/Volumes/Music/'), 'Music');
  assert.equal(folderLabel('/'), '/');

  assert.equal(unreachableNotice(undefined), null);
  assert.equal(unreachableNotice([]), null);
  assert.deepEqual(unreachableNotice([win('K:', 'Music')]), {
    text: "Couldn't reach Music (K:). Nothing was changed for that folder.",
    title: win('K:', 'Music'),
  });
  const several = unreachableNotice([win('K:', 'Music'), '/Volumes/Archive', win('D:', 'Albums')]);
  assert.equal(several.text, "Couldn't reach 3 folders, starting with Music (K:). Nothing was changed for those folders.");
  assert.equal(several.title, [win('K:', 'Music'), '/Volumes/Archive', win('D:', 'Albums')].join('\n'), 'the tooltip has every full path');

  // The banner shows it instead of an ordinary finish, and leaves every other case as it was.
  globalThis.__scan = null;
  const { ScanBanner } = await bundleComponent('src/components/ScanBanner.tsx', {
    '../lib/api': 'export const api = { onScanProgress: (listener) => { globalThis.__scan = listener; return () => {}; }, cancelScan() {} };',
  });
  const view = mount(() => ScanBanner());
  view.flush();
  const text = (node) => (node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join(' ') : text(node.props?.children));
  const show = (progress) => {
    globalThis.__scan({ scanned: 10, total: 10, current: '', done: true, startedAt: 0, ...progress });
    return text(view.flush());
  };

  const unreachable = show({ unreachable: [win('K:', 'Music')] });
  assert.match(unreachable, /Couldn't reach Music \(K:\)\. Nothing was changed for that folder\./);
  assert.doesNotMatch(unreachable, /Scan complete/, 'it does not read as an ordinary finish');
  const titled = findAll(view.output, (node) => node.props?.title === win('K:', 'Music'));
  assert.equal(titled.length, 1, 'the full path is the tooltip');

  assert.match(show({ unreachable: [win('K:', 'Music'), win('D:', 'Albums')] }),/Couldn't reach 2 folders, starting with Music \(K:\)/);
  assert.match(show({ parsed: 3, skipped: 7 }), /Scan complete\s+indexed 10 files\s+3 parsed \| 7 skipped/, 'a scan that reached everything is unchanged');
  assert.match(show({ unreachable: [] }), /Scan complete/);
  assert.match(show({ cancelled: true, unreachable: [win('K:', 'Music')] }),/Scan stopped/, 'a stopped scan keeps its own wording');
  view.unmount();
  delete globalThis.__scan;
}

// --- Signal path badge: macOS is told what is asked of the device, not what it delivers --
{
  const { SignalPathBadge } = await bundleComponent('src/components/SignalPathBadge.tsx', {
    '../store/usePlayerStore': `export const engine = {
      subscribe: () => () => {},
      getSampleTransportInfo: () => ({ active: false }),
      getActualSampleRate: () => 96000,
      getSampleRateFallback: () => null,
      getExclusiveInfo: () => ({ active: true, negotiated: { bitPerfect: true, deviceName: 'DAC', format: 'S32', sampleRate: 96000 } }),
    };
    export const usePlayerStore = Object.assign((select) => select({ current: { sampleRate: 96000 }, isPlaying: true, setView() {} }), { getState: () => ({ current: { sampleRate: 96000 } }) });`,
    '../lib/api': "export const api = { get platform() { return globalThis.__platform; } }; export const exclusiveBackendLabel = () => 'Backend';",
    '../lib/resampler-name': 'export const resamplerName = (name) => name;',
  });
  const badgeTitle = (platform) => {
    globalThis.__platform = platform;
    const view = mount(() => SignalPathBadge());
    const title = view.flush().props.title;
    view.unmount();
    return title;
  };
  const claim = 'Untouched samples, no OS mixer, no DSP';
  assert.match(badgeTitle('win32'), new RegExp(claim), 'Windows keeps the exclusive-mode claim');
  assert.match(badgeTitle('linux'), new RegExp(claim));
  assert.match(badgeTitle('win32'), /S32 @ 96k, bit-perfect\./);
  assert.match(badgeTitle('linux'), /S32 @ 96k, bit-perfect\./);
  const mac = badgeTitle('darwin');
  assert.doesNotMatch(mac, new RegExp(claim));
  assert.doesNotMatch(mac, /bit-perfect/i, 'nothing on a Mac says the samples are bit-perfect');
  assert.match(mac, /S32 @ 96k, exclusive, source rate and depth requested\./);
  assert.match(mac, /Exclusive device, with the source's rate and depth requested\. macOS can still convert to the device's own format, and NewAmp does not check that\./);
  delete globalThis.__platform;
}

// --- Decks: repeat cycles off, all, one --------------------------------------------------
{
  const { ClassicBentoDeck } = await bundle('src/components/decks/ClassicBentoDeck.tsx', {
    stubs: { '../Visualizer': 'export const Visualizer = () => null;', '../VolumeSlider': 'export const VolumeSlider = () => null;', '../BrandLogo': 'export const BrandLogo = () => null;', './DeckSkinPicker': 'export const DeckSkinPicker = () => null;', '../ScrubBar': 'export const ScrubBar = () => null;', './DeckWindowButtons': 'export const DeckWindowButtons = () => null;', '../../lib/format': 'export const formatTime = () => "0:00";' },
  });
  const modes = [];
  const find = (node, test, found = []) => {
    if (node == null || typeof node !== 'object') return found;
    if (Array.isArray(node)) { node.forEach((child) => find(child, test, found)); return found; }
    if (test(node)) found.push(node);
    find(node.props?.children, test, found);
    return found;
  };
  const props = (mode) => ({ track: null, isPlaying: false, currentTime: 0, duration: 0, volume: 1, mode, alwaysOnTop: false, artUrl: null, vizExpanded: false, onSetMode: (next) => modes.push(next), onPickSkin() {} });
  const press = (mode) => {
    const tree = ClassicBentoDeck(props(mode));
    const rep = find(tree, (node) => node.type === 'button' && typeof node.props.title === 'string' && node.props.title.startsWith('Repeat'));
    assert.equal(rep.length, 1, 'the windowshade has one repeat button');
    rep[0].props.onClick();
  };
  press('normal');
  press('repeat-all');
  press('repeat-one');
  press('shuffle');
  assert.deepEqual(modes, ['repeat-all', 'repeat-one', 'normal', 'shuffle-repeat-all'], 'off, all, one, off, and shuffle is kept');
}

console.log('components-fixes-test: ok');
