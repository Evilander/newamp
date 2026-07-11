// Deck screenshot harness — captures one PNG per compact deck skin for
// design iteration, using the same fixture library + shot harness as
// screenshot-gallery/craft-matrix but scoped to decks only, with a playing
// track so spools/tape/knobs show real state.
//
//   node scripts/deck-shots.mjs --out=path/to/dir [skin ...]
//
// Skins default to every entry in src/components/decks/types.ts DECK_SKINS;
// sizes are parsed from that file so this script can never drift from the
// real deck window sizes.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  GALLERY_ALBUMS,
  assertFfmpegAvailable,
  createAlbumFixture,
  runElectronScreenshots,
  writeSmokeSettings,
} from './screenshot-gallery.mjs';

const outArg = process.argv.find((a) => a.startsWith('--out='));
if (!outArg) {
  console.error('Usage: node scripts/deck-shots.mjs --out=<dir> [skin ...]');
  process.exit(1);
}
const outDir = resolve(outArg.slice('--out='.length));
const requested = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const typesSrc = await readFile(resolve('src/components/decks/types.ts'), 'utf8');
const skinRe = /id:\s*'([a-z0-9-]+)'.*?size:\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}/g;
const allSkins = [...typesSrc.matchAll(skinRe)].map(([, id, width, height]) => ({
  id,
  width: Number(width),
  height: Number(height),
}));
if (!allSkins.length) {
  console.error('Could not parse DECK_SKINS from src/components/decks/types.ts');
  process.exit(1);
}
const skins = requested.length
  ? requested.map((id) => {
      const found = allSkins.find((s) => s.id === id);
      if (!found) {
        console.error(`Unknown deck skin "${id}". Known: ${allSkins.map((s) => s.id).join(', ')}`);
        process.exit(1);
      }
      return found;
    })
  : allSkins;

const smokeRoot = resolve('tmp', 'deck-shots');
const userData = join(smokeRoot, 'user-data');
const mediaDir = join(smokeRoot, 'media');
const planPath = join(smokeRoot, 'plan.json');

assertFfmpegAvailable();
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(mediaDir, { recursive: true });
await mkdir(userData, { recursive: true });
await mkdir(outDir, { recursive: true });

for (const album of GALLERY_ALBUMS) await createAlbumFixture(mediaDir, album);
await writeSmokeSettings(userData, mediaDir);

const plan = skins.map((skin, index) => ({
  file: `deck--${skin.id}.png`,
  action: [
    // First step: start real playback and let ~3s elapse so progress-driven
    // details (tape migration, tonearm angle, counters) have visible state.
    index === 0
      ? "await shot.playTrack('Dummy Discards A Heart');\nawait shot.sleep(2500);"
      : '',
    `await shot.openDeck(${JSON.stringify(skin.id)});`,
    `await shot.waitFor('deck window ${skin.width}x${skin.height}', () =>
      Math.abs(window.innerWidth - ${skin.width}) <= 2 && Math.abs(window.innerHeight - ${skin.height}) <= 2, 15000);`,
    'await shot.sleep(450);',
    `return shot.summary(${JSON.stringify(`deck--${skin.id}`)});`,
  ]
    .filter(Boolean)
    .join('\n'),
}));
await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');

console.log(`Capturing ${plan.length} deck shots -> ${outDir}`);
const result = await runElectronScreenshots({
  env: {
    NEWAMP_SCREENSHOT_GALLERY: '1',
    NEWAMP_SCREENSHOT_DIR: outDir,
    NEWAMP_SCREENSHOT_PLAN: planPath,
    NEWAMP_SMOKE_USER_DATA: userData,
  },
  timeoutMs: 300_000,
  onOutput: (line) => {
    if (line.includes('[newamp-screenshot-plan]')) console.log(line);
  },
});

if (!result?.ok) {
  console.error('Deck shots failed:', JSON.stringify(result));
  process.exit(1);
}
console.log(`Captured:\n${result.files.map((f) => `  ${f}`).join('\n')}`);
