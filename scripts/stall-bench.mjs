// Measures how long the main process is held up when Home, Discover, Mixes or
// Folders opens, on a copy of a real library.db. The calls each view makes are
// the ones the renderer makes, started the way ipcMain starts them (one task
// per call); the longest task is the longest gap between turns of the event
// loop while they run. Never opens the original: the copy is made here.
//
// Run: node scripts/stall-bench.mjs <library.db> [options]
//   --dist <dir>        compiled electron folder to measure (default dist-electron)
//   --baseline <dir>    a second build to measure the same way and to compare
//                       results with (see --build-baseline)
//   --build-baseline <ref>  compile the electron folder as of a git ref into
//                       tmp/stall-bench/baseline-dist and use it as --baseline
//   --runs <n>          fresh-library runs per view (default 3)
//   --roots <a,b>       library roots as the Folders view gets them
//   --seed none|auto    play a seed track for the mixes, as when something is
//                       playing (default auto: the most played track)
//   --views <list>      home,discover,mixes,folders (default all)
//   --compare           check that the two builds return the same results
//   --json <file>       write the numbers
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const source = args.find((a) => a.endsWith('.db'));
if (!source || !existsSync(source)) {
  console.error('usage: node scripts/stall-bench.mjs <library.db> [--dist dir] [--baseline dir | --build-baseline ref] [--compare]');
  process.exit(2);
}
const runs = Number(flag('--runs') ?? 3);
const roots = (flag('--roots') ?? '').split(',').filter(Boolean);
const seedMode = flag('--seed') ?? 'auto';
const viewNames = (flag('--views') ?? 'home,discover,mixes,folders').split(',');
const scratch = resolve('tmp/stall-bench');
const dist = resolve(flag('--dist') ?? 'dist-electron');

let baseline = flag('--baseline') ? resolve(flag('--baseline')) : null;
if (flag('--build-baseline')) baseline = buildBaseline(flag('--build-baseline'));

function buildBaseline(ref) {
  const src = join(scratch, 'baseline-src');
  rmSync(src, { recursive: true, force: true });
  mkdirSync(src, { recursive: true });
  const tarball = join(scratch, 'baseline.tar');
  mkdirSync(scratch, { recursive: true });
  const git = (gitArgs) => {
    const r = spawnSync('git', gitArgs, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${gitArgs.join(' ')}: ${r.stderr}`);
  };
  git(['archive', '--format=tar', `--output=${tarball}`, ref, 'electron', 'shared', 'src', 'package.json']);
  // Relative paths: GNU tar reads a drive letter as a host name.
  const tar = spawnSync('tar', ['-xf', relative(src, tarball)], { cwd: src, encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`tar: ${tar.stderr}`);
  symlinkSync(resolve('node_modules'), join(src, 'node_modules'), 'junction');
  const tsc = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'electron/tsconfig.json'], {
    cwd: src,
    encoding: 'utf8',
  });
  if (tsc.status !== 0) throw new Error(`tsc: ${tsc.stdout}${tsc.stderr}`);
  // dist-electron lands inside the source folder (outDir ../dist-electron).
  return join(src, 'dist-electron');
}

async function openStore(distDir, tag) {
  const { LibraryStore } = await import(pathToFileURL(join(distDir, 'electron', 'library.js')).href);
  const folder = join(scratch, tag);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  copyFileSync(source, join(folder, 'library.db'));
  const library = await LibraryStore.open(join(folder, 'library.db'));
  await library.albumsReady?.();
  return library;
}

// Prefers the sliced form of a method when the build has one, the way the IPC
// handlers do; an older build only has the synchronous one.
function call(library, name, ...input) {
  const sliced = library[`${name}Async`];
  return typeof sliced === 'function' ? sliced.apply(library, input) : library[name](...input);
}

function plan(library) {
  const seedTrackId = seedMode === 'none' ? null : library.getTracks({ sort: 'plays', limit: 1, offset: 0 })[0]?.id ?? null;
  const tracks = (sort) => ['getTracks', { sort, limit: 12, offset: 0 }];
  const mixes = [
    ['buildHarmonicMix', { seedTrackId, count: 12 }],
    ['buildTasteMix', { seedTrackId, count: 12 }],
  ];
  // The folders a user clicks into from the root list: the root, an artist, an
  // album. Looking them up through getFolders would warm what the first visit
  // is meant to measure cold.
  const albumDir = dirname(library.getTracks({ limit: 1 })[0]?.path ?? '');
  const artistDir = dirname(albumDir);
  const rootDir = roots[0] ?? dirname(artistDir);
  const browse = (dir) => [['getFolders', dir, roots], ['getFolderTracks', dir, { recursive: false, limit: 5000 }]];
  return {
    seedTrackId,
    views: {
      home: [
        // Above the fold, then the batch the view starts when the page is idle.
        [['getStats'], tracks('added'), tracks('loved'), ['getListeningHistory', { limit: 30, offset: 0 }], tracks('plays'), ['getPlaylists']],
        [
          ['getLibraryHealth'],
          ['getListeningInsights', {}],
          ...mixes,
          tracks('rating'),
          ['getSmartPlaylistRules'],
          ['getSuggestedSmartPlaylistRules'],
        ],
      ],
      discover: [[['getDiscoverSurface', { seed: 'bench', limit: 12, lowEndMode: false, seedTrackId, now: 1_790_000_000_000 }]]],
      mixes: [
        [
          ...mixes,
          tracks('added'),
          tracks('loved'),
          tracks('recent'),
          tracks('plays'),
          ['runSmartPlaylistRule', { name: 'Mixes Deep Cuts', mood: 'deep-cuts', count: 12, unplayedOnly: true }],
          ['runSmartPlaylistRule', { name: 'Mixes Night Drive', mood: 'night', count: 12, minRating: 3 }],
        ],
      ],
      folders: [
        [['getFolders', null, roots]],
        browse(rootDir),
        browse(artistDir),
        browse(albumDir),
      ],
    },
  };
}

// Runs one stage the way ipcMain would: every call arrives as its own task.
async function visit(library, stages) {
  let longest = 0;
  let last = performance.now();
  let watching = true;
  const tick = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (watching) setImmediate(tick);
  };
  setImmediate(tick);
  const started = performance.now();
  const outputs = [];
  for (const stage of stages) {
    const results = await Promise.all(
      stage.map(
        ([name, ...input]) =>
          new Promise((done, fail) => {
            setImmediate(() => {
              try {
                Promise.resolve(call(library, name, ...input)).then(done, fail);
              } catch (err) {
                fail(err);
              }
            });
          }),
      ),
    );
    outputs.push(...results);
  }
  const total = performance.now() - started;
  watching = false;
  await new Promise((done) => setImmediate(done));
  return { longest, total, outputs };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function measure(distDir, label) {
  const table = {};
  for (const view of viewNames) table[view] = { first: [], revisit: [], afterPlay: [], firstTotal: [], afterPlayTotal: [] };
  for (let run = 0; run < runs; run += 1) {
    for (const view of viewNames) {
      // A fresh library per view, so the first visit is cold, as after launch.
      const library = await openStore(distDir, `${label}-${view}`);
      const { views, seedTrackId } = plan(library);
      const stages = views[view];
      const first = await visit(library, stages);
      const revisit = await visit(library, stages);
      // A play changes play counts, last played and the history: whatever was
      // kept for the view has to be rebuilt on the next visit.
      if (seedTrackId) library.recordPlay(seedTrackId, Date.now());
      else library.recordPlay(library.getTracks({ sort: 'artist', limit: 1, offset: 0 })[0].id, Date.now());
      const afterPlay = await visit(library, stages);
      table[view].first.push(first.longest);
      table[view].revisit.push(revisit.longest);
      table[view].afterPlay.push(afterPlay.longest);
      table[view].firstTotal.push(first.total);
      table[view].afterPlayTotal.push(afterPlay.total);
      library.close();
    }
  }
  return table;
}

function report(label, table) {
  console.log(`\n${label}  (${runs} runs, medians in ms; longest = longest single task, total = view ready)`);
  console.log('view'.padEnd(10), 'first longest'.padStart(14), 'revisit longest'.padStart(16), 'after play longest'.padStart(19), 'first total'.padStart(12), 'after play total'.padStart(17));
  const summary = {};
  for (const view of viewNames) {
    const t = table[view];
    summary[view] = {
      firstLongestMs: Math.round(median(t.first)),
      revisitLongestMs: Math.round(median(t.revisit)),
      afterPlayLongestMs: Math.round(median(t.afterPlay)),
      firstTotalMs: Math.round(median(t.firstTotal)),
      afterPlayTotalMs: Math.round(median(t.afterPlayTotal)),
      runs: { first: t.first.map(Math.round), afterPlay: t.afterPlay.map(Math.round) },
    };
    const s = summary[view];
    console.log(
      view.padEnd(10),
      String(s.firstLongestMs).padStart(14),
      String(s.revisitLongestMs).padStart(16),
      String(s.afterPlayLongestMs).padStart(19),
      String(s.firstTotalMs).padStart(12),
      String(s.afterPlayTotalMs).padStart(17),
    );
  }
  return summary;
}

// Values that legitimately differ between two runs of the same call.
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'generatedAt') continue;
      out[key] = scrub(inner);
    }
    return out;
  }
  return value;
}

function firstDifference(a, b, path = '$') {
  if (isDeepStrictEqual(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i += 1) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDifference(a[key], b[key], `${path}.${key}`);
      if (d) return d;
    }
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`;
}

async function compare(baseDist) {
  const before = await openStore(baseDist, 'compare-before');
  const after = await openStore(dist, 'compare-after');
  const { views, seedTrackId } = plan(after);
  const mixSeeds = [null, seedTrackId].filter((v, i, all) => all.indexOf(v) === i);
  const calls = [];
  for (const stages of Object.values(views)) for (const stage of stages) calls.push(...stage);
  for (const seed of mixSeeds) {
    for (const mode of ['buildHarmonicMix', 'buildTasteMix']) {
      for (const count of [12, 30, 200]) calls.push([mode, { seedTrackId: seed, count }]);
    }
  }
  calls.push(['buildHarmonicMix', { seedTrackId: seedTrackId, count: 40, genreQuery: 'rock' }]);
  // Folders: the roots, then every folder two levels down.
  const queue = [[null, 0]];
  const seen = new Set();
  while (queue.length && seen.size < 150) {
    const [parent, depth] = queue.shift();
    const key = String(parent);
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push(['getFolders', parent, roots]);
    if (parent && seen.size < 40) calls.push(['getFolderTracks', parent, { recursive: false, limit: 5000 }], ['getFolderTracks', parent, { recursive: true, limit: 100000 }]);
    if (depth < 3) for (const child of after.getFolders(parent, roots).slice(0, 12)) queue.push([child.path, depth + 1]);
  }
  calls.push(['getFolders', null, []]);

  let same = 0;
  let different = 0;
  for (const [name, ...input] of calls) {
    const expected = scrub(await before[name](...input));
    const sync = scrub(after[name](...input));
    const sliced = scrub(await call(after, name, ...input));
    for (const [what, got] of [['sync', sync], ['sliced', sliced]]) {
      const diff = firstDifference(expected, got);
      if (diff) {
        different += 1;
        console.log(`DIFF ${name}(${JSON.stringify(input).slice(0, 70)}) ${what}: ${diff}`);
      } else {
        same += 1;
      }
    }
  }
  console.log(`\ncompared ${calls.length} calls, sync and sliced each: ${same} identical, ${different} different`);
  before.close();
  after.close();
  return different === 0;
}

mkdirSync(scratch, { recursive: true });
const summary = { source, runs, seedMode, after: report(`after: ${dist}`, await measure(dist, 'after')) };
if (baseline) summary.before = report(`before: ${baseline}`, await measure(baseline, 'before'));
if (args.includes('--compare') && baseline) summary.identical = await compare(baseline);
if (flag('--json')) writeFileSync(flag('--json'), JSON.stringify(summary, null, 2));
if (summary.identical === false) process.exit(1);
