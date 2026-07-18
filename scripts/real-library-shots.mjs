// Real-library marketing shots — boots the built app against an actual
// library (default K:/music) seeded from the user's existing library.db and
// art cache, then captures the scale-dependent views the README and landing
// page show: Library, Home, Albums, Now Playing, and fullscreen Eviland
// scenes, with a real track playing.
//
//   node scripts/real-library-shots.mjs [--library=K:/music] [--out=assets/screenshots/real]
//
// Runs in a throwaway userData dir — the real NewAmp profile is only read
// (library.db copied, art/ attached as a junction), never written. Safe to
// run while the real app is open; 2.1's atomic DB flushes mean the copy is
// always a consistent snapshot.

import { copyFile, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runElectronScreenshots, writeSmokeSettings } from './screenshot-gallery.mjs';

const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const libraryRoot = resolve(arg('library', 'K:/music'));
const outDir = resolve(arg('out', 'assets/screenshots/real'));
const realUserData = arg(
  'seed-user-data',
  join(process.env.APPDATA || '', 'NewAmp'),
);

const smokeRoot = resolve('tmp', 'real-library-shots');
const userData = join(smokeRoot, 'user-data');

// Inline visualizer opener — the shot harness exposes playAndVisualize but
// that re-selects a track by name; here a track is already playing, so open
// the stage (or reuse it) and switch presets directly.
const openViz = (preset) =>
  `
  const stageNow = document.querySelector('[data-newamp-fullscreen-visualizer]');
  if (!stageNow) {
    const opener = await shot.waitFor('visualizer opener', () => document.querySelector('[data-newamp-open-visualizer]'));
    opener.click();
  }
  const stage = await shot.waitFor('stage', () => document.querySelector('[data-newamp-fullscreen-visualizer]'));
  const toggle = await shot.waitFor('preset picker toggle', () => document.querySelector('[data-newamp-viz-preset-picker-toggle]'));
  toggle.click();
  const btn = await shot.waitFor('preset ${preset}', () => Array.from(document.querySelectorAll('[data-newamp-viz-preset-button]')).find((b) => b.getAttribute('data-newamp-viz-preset-button') === '${preset}'));
  btn.click();
  await shot.waitFor('preset state ${preset}', () => stage.getAttribute('data-newamp-visualizer-preset') === '${preset}');
  await shot.waitFor('canvas', () => stage.querySelector('[data-newamp-visualizer-canvas]'));
  await shot.sleep(1600);
  return shot.summary('viz-${preset}');
`.replace(/\n/g, ' ');

const plan = [
  {
    file: 'real-library.png',
    action:
      "await shot.go('Library'); const row = await shot.waitFor('track row', () => document.querySelector('[data-newamp-track-row]'), 25000); row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window })); await shot.sleep(1800); return shot.summary('library');",
  },
  {
    file: 'real-home.png',
    // Home hydrates its shelves (Highest Rated, stats) asynchronously over a
    // large library — give it time or the capture shows skeletons.
    action: "await shot.go('Home'); await shot.sleep(7000); return shot.summary('home');",
  },
  {
    file: 'real-albums.png',
    action: "await shot.go('Albums'); await shot.sleep(3500); return shot.summary('albums');",
  },
  {
    file: 'real-now-playing.png',
    action: "await shot.go('Now Playing'); await shot.sleep(1800); return shot.summary('now-playing');",
  },
  // Eviland scenes can't be forced from outside (scene-overlay.setScene is
  // unwired) — capture Eviland Live three times spaced past the Director's
  // dwell window and curate the best takes.
  { file: 'real-viz-eviland-1.png', action: openViz('eviland-live') },
  {
    file: 'real-viz-eviland-2.png',
    action: "await shot.sleep(14000); return shot.summary('eviland-2');",
  },
  {
    file: 'real-viz-eviland-3.png',
    action: "await shot.sleep(14000); return shot.summary('eviland-3');",
  },
];

const staticsOnly = process.argv.includes('--statics-only');
const vizOnly = process.argv.includes('--viz-only');
const activePlan = staticsOnly
  ? plan.slice(0, 4)
  : vizOnly
  ? [
      {
        file: 'real-viz-warmup.png',
        action:
          "await shot.go('Library'); const row = await shot.waitFor('track row', () => document.querySelector('[data-newamp-track-row]'), 25000); row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window })); await shot.sleep(1200); return shot.summary('warmup');",
      },
      ...plan.slice(4),
    ]
  : plan;

async function main() {
  if (!existsSync(libraryRoot)) throw new Error(`Library root missing: ${libraryRoot}`);

  await rm(smokeRoot, { recursive: true, force: true });
  await mkdir(userData, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const seedDb = join(realUserData, 'library.db');
  if (existsSync(seedDb)) {
    await copyFile(seedDb, join(userData, 'library.db'));
    console.log('seeded library.db from', realUserData);
  } else {
    console.warn('no seed library.db found — first full scan may exceed the harness scan window');
  }
  const seedArt = join(realUserData, 'art');
  if (existsSync(seedArt)) {
    await symlink(seedArt, join(userData, 'art'), 'junction');
    console.log('attached art cache via junction');
  }

  await writeSmokeSettings(userData, libraryRoot);

  const planPath = join(smokeRoot, 'plan.json');
  await writeFile(planPath, JSON.stringify(activePlan, null, 2), 'utf8');

  const result = await runElectronScreenshots({
    env: {
      NEWAMP_SCREENSHOT_GALLERY: '1',
      NEWAMP_SCREENSHOT_DIR: outDir,
      NEWAMP_SMOKE_USER_DATA: userData,
      NEWAMP_SCREENSHOT_PLAN: planPath,
    },
    timeoutMs: 240000,
    onOutput: (line) => console.log(line),
  });

  console.log(JSON.stringify(result, null, 2));
}

await main();
