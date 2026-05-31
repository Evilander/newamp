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
//
// The --check mode runs in NewAmp's `prebuild` so a release can never ship a
// stale duplicate: edit an engine module without re-syncing and the build fails
// loudly instead of silently packaging divergent copies.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const checkOnly = process.argv.includes('--check');
const FILES = [
  'eviland.ts',
  'eviland-audio.ts',
  'eviland-operators.ts',
  'eviland-randomizer.ts',
  'eviland-rng.ts',
  'eviland-director.ts',
  'eviland-recorder.ts',
];

const targetDir = resolve(here, 'src');
if (!existsSync(targetDir)) {
  if (checkOnly) {
    console.error('[eviland-core/sync] package src/ missing — run `node packages/eviland-core/sync.mjs` to seed it.');
    process.exit(1);
  }
  mkdirSync(targetDir, { recursive: true });
}

let ok = 0;
const drifted = [];
for (const f of FILES) {
  const from = resolve(repo, 'src', 'visualizer', f);
  const to = resolve(targetDir, f);
  if (!existsSync(from)) {
    console.error(`[eviland-core/sync] missing source: ${from}`);
    process.exitCode = 1;
    continue;
  }
  if (checkOnly) {
    const srcText = readFileSync(from, 'utf8');
    const pkgText = existsSync(to) ? readFileSync(to, 'utf8') : null;
    if (pkgText === srcText) {
      ok++;
    } else {
      drifted.push(f);
    }
  } else {
    copyFileSync(from, to);
    ok++;
  }
}

if (checkOnly) {
  if (drifted.length > 0) {
    console.error(
      `[eviland-core/sync] DRIFT: ${drifted.join(', ')} differ from src/visualizer.\n` +
        '  Run `node packages/eviland-core/sync.mjs` to resync before building/releasing.',
    );
    process.exit(1);
  }
  console.log(`[eviland-core/sync] in sync: ${ok}/${FILES.length} modules match src/visualizer`);
} else {
  console.log(`[eviland-core/sync] synced ${ok}/${FILES.length} modules from src/visualizer → packages/eviland-core/src`);
}
