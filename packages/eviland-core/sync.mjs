// Sync (or verify) the @eviland/core source from NewAmp's src/visualizer/*.
//
// STAGING NOTE: during the extraction, NewAmp's src/visualizer/eviland*.ts is
// the source of truth, and this package's src/ is a copy. This keeps NewAmp
// working untouched while @eviland/core proves out as a standalone, publishable
// boundary. The final consolidation (NewAmp importing FROM @eviland/core, single
// source of truth) is a tracked follow-up. Until then:
//
//   node packages/eviland-core/sync.mjs            # copy src/visualizer → package
//   node packages/eviland-core/sync.mjs --check    # FAIL if the copy has drifted
//   node packages/eviland-core/sync.mjs --force    # copy over package-side edits too
//
// The --check mode runs in NewAmp's `prebuild` so a release can never ship a
// stale duplicate: edit an engine module without re-syncing and the build fails
// loudly instead of silently packaging divergent copies.
//
// Edit src/visualizer, never the package copy. A copy that was edited here
// anyway would be thrown away by the next sync, so each sync records the hash
// of every file it wrote (tmp/eviland-core-sync.json, which is local and
// ignored by git) and refuses to overwrite a package file that no longer
// matches its record. --check uses the same record to say which side moved.
// With no record (a fresh clone, or tmp/ cleared) the app copy wins.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const checkOnly = process.argv.includes('--check');
const force = process.argv.includes('--force');
const FILES = [
  'eviland.ts',
  'scene-overlay.ts',
  'eviland-gl.ts',
  'eviland-reaction-diffusion.ts',
  'eviland-morph.ts',
  'eviland-physarum.ts',
  'eviland-appearance.ts',
  // Every scene module: the renderer draws them as selectable sources.
  ...readdirSync(resolve(repo, 'src/visualizer/scenes'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `scenes/${name}`),
  'eviland-audio.ts',
  'eviland-score.ts',
  'eviland-conductor.ts',
  'eviland-fluid.ts',
  'eviland-operators.ts',
  'eviland-randomizer.ts',
  'eviland-rng.ts',
  'eviland-director.ts',
  'eviland-recorder.ts',
  'eviland-memory-types.ts',
];

const stateFile = resolve(repo, 'tmp', 'eviland-core-sync.json');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let lastSynced = {};
try {
  lastSynced = JSON.parse(readFileSync(stateFile, 'utf8'));
} catch {
  /* first sync here, or tmp/ was cleared */
}

const targetDir = resolve(here, 'src');
if (!existsSync(targetDir)) {
  if (checkOnly) {
    console.error('[eviland-core/sync] package src/ missing — run `node packages/eviland-core/sync.mjs` to seed it.');
    process.exit(1);
  }
  mkdirSync(targetDir, { recursive: true });
}

const diffCommand = (f) => `git diff --no-index src/visualizer/${f} packages/eviland-core/src/${f}`;
let ok = 0;
const drifted = [];
const refused = [];
const written = {};
for (const f of FILES) {
  const from = resolve(repo, 'src', 'visualizer', f);
  const to = resolve(targetDir, f);
  if (!existsSync(from)) {
    console.error(`[eviland-core/sync] missing source: ${from}`);
    process.exitCode = 1;
    continue;
  }
  const source = readFileSync(from);
  const copy = existsSync(to) ? readFileSync(to) : null;
  const sourceHash = sha(source);
  const copyHash = copy ? sha(copy) : null;
  const synced = lastSynced[f];
  if (copyHash === sourceHash) {
    written[f] = sourceHash;
    ok++;
    continue;
  }
  // The copy differs. It was edited here if it no longer matches what the
  // last sync wrote; the source moved if it no longer matches that either.
  const copyEdited = copy !== null && synced !== undefined && copyHash !== synced;
  const sourceMoved = synced === undefined || sourceHash !== synced;
  if (checkOnly) {
    const why = copy === null ? 'missing from the package'
      : synced === undefined ? 'differs from src/visualizer'
        : copyEdited && sourceMoved ? 'edited on both sides'
          : copyEdited ? 'package copy edited'
            : 'src/visualizer changed';
    drifted.push(`${f} (${why})`);
    continue;
  }
  if (copyEdited && !force) {
    refused.push(f);
    continue;
  }
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, source);
  written[f] = sourceHash;
  ok++;
}

if (checkOnly) {
  if (drifted.length > 0) {
    console.error(
      `[eviland-core/sync] DRIFT: ${drifted.join(', ')}.\n` +
        '  Run `node packages/eviland-core/sync.mjs` to resync before building/releasing.',
    );
    process.exit(1);
  }
  console.log(`[eviland-core/sync] in sync: ${ok}/${FILES.length} modules match src/visualizer`);
} else {
  // Another sync may have finished while this one was copying. Merge into the
  // record as it is now, and skip a file whose copy changed since this run
  // wrote it: the sync that changed it holds the newer hash.
  let record = {};
  try {
    record = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    record = { ...lastSynced };
  }
  for (const [f, hash] of Object.entries(written)) {
    const to = resolve(targetDir, f);
    if (existsSync(to) && sha(readFileSync(to)) === hash) record[f] = hash;
  }
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(record, null, 2));
  if (refused.length > 0) {
    console.error(
      `[eviland-core/sync] REFUSED to overwrite ${refused.length} package file(s) edited since the last sync: ${refused.join(', ')}.\n` +
        '  The engine source is src/visualizer; an edit made only in the package would be lost. To see it:\n' +
        refused.map((f) => `    ${diffCommand(f)}`).join('\n') +
        '\n  Port the change into src/visualizer, or run `node packages/eviland-core/sync.mjs --force` to discard it.',
    );
    process.exitCode = 1;
  }
  console.log(`[eviland-core/sync] synced ${ok}/${FILES.length} modules from src/visualizer → packages/eviland-core/src`);
}
