import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const {
  BUILT_IN_THEMES,
  SKIN_VARIABLES,
  normalizeCustomSkin,
  parseCustomSkinFile,
  serializeCustomSkin,
  skinToFile,
} = await import('../dist-electron/shared/custom-skin.js');
const {
  isWinampClassicSkinArchiveName,
  parseWinampClassicSkinArchive,
} = await import('../dist-electron/electron/winamp-skin-import.js');
const { SettingsStore } = await import('../dist-electron/electron/settings.js');

assert.ok(BUILT_IN_THEMES.includes('classic'));
assert.ok(BUILT_IN_THEMES.includes('walnut'), 'record-player deck skin should be registered');
assert.ok(BUILT_IN_THEMES.includes('jukebox'), 'jukebox deck skin should be registered');
assert.ok(BUILT_IN_THEMES.includes('terminal'), 'vintage-computer deck skin should be registered');
assert.ok(SKIN_VARIABLES.includes('--accent'));

const skin = normalizeCustomSkin({
  name: 'Road Skin',
  baseTheme: 'oxide',
  variables: {
    '--bg': '#111111',
    '--accent': '#66ffaa',
    '--radius': '4px',
    '--unknown': '#ff0000',
    '--panel': 'red; color: red',
  },
  updatedAt: 12345,
});

assert.ok(skin, 'valid skin should normalize');
assert.equal(skin.name, 'Road Skin');
assert.equal(skin.baseTheme, 'oxide');
assert.equal(skin.variables['--accent'], '#66ffaa');
assert.equal(skin.variables['--unknown'], undefined);
assert.equal(skin.variables['--panel'], undefined, 'imported CSS variable values should reject declaration separators');

const serialized = serializeCustomSkin(skin);
const file = JSON.parse(serialized);
assert.equal(file.format, 'newamp.custom-skin');
assert.equal(file.version, 1);
assert.equal(file.skin.name, 'Road Skin');

const parsed = parseCustomSkinFile(serialized);
assert.deepEqual(parsed, skinToFile(skin).skin);

const bareParsed = parseCustomSkinFile(JSON.stringify(skin));
assert.equal(bareParsed.name, 'Road Skin', 'bare skin JSON should import for easy hand editing');

const smokeRoot = resolve('tmp', 'skin-smoke');
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });
const settingsPath = join(smokeRoot, 'settings.json');
const store = new SettingsStore(settingsPath);
store.set({ theme: 'custom', customSkin: skin });
const reloaded = new SettingsStore(settingsPath).get();
assert.equal(reloaded.theme, 'custom', 'custom skin theme choice should persist');
assert.equal(reloaded.customSkin?.name, 'Road Skin', 'custom skin should reload from settings');
assert.equal(reloaded.customSkin?.variables['--accent'], '#66ffaa');

assert.throws(
  () => parseCustomSkinFile(JSON.stringify({ name: 'Bad', variables: { '--nope': '#fff' } })),
  /valid NewAmp custom skin/,
);

assert.equal(isWinampClassicSkinArchiveName('Industrial.wsz'), true, 'WSZ should be accepted as a Winamp skin archive');
assert.equal(isWinampClassicSkinArchiveName('Industrial.zip'), true, 'ZIP should be accepted as a Winamp skin archive');
assert.equal(isWinampClassicSkinArchiveName('Industrial.json'), false, 'JSON skin files should stay on the Newamp importer path');

const winampArchive = createZipArchive([
  {
    name: 'Industrial/main.bmp',
    content: createBmp24(4, 4, (x, y) => {
      if (x === 0 && y === 0) return [5, 7, 9];
      if (x === 1 && y === 0) return [236, 245, 255];
      if (x === 2 && y === 0) return [0, 210, 255];
      return [28 + x * 12, 34 + y * 16, 42 + x * 8];
    }),
  },
  {
    name: 'Industrial/pledit.txt',
    content: Buffer.from('[Text]\nNormal=#d8f8ff\nCurrent=#ffbb33\nNormalBG=#101316\nSelectedBG=#2c5366\n', 'utf8'),
  },
]);
const importedWinampSkin = parseWinampClassicSkinArchive(winampArchive, 'Industrial.wsz');
assert.equal(importedWinampSkin.name, 'Industrial');
assert.equal(importedWinampSkin.baseTheme, 'classic');
assert.equal(importedWinampSkin.variables['--display-fg'], '#d8f8ff');
assert.equal(importedWinampSkin.variables['--accent'], '#ffbb33');
assert.equal(importedWinampSkin.variables['--display-bg'], '#101316');
assert.ok(importedWinampSkin.variables['--bg'], 'Winamp BMP colors should produce a Newamp background variable');
assert.ok(importedWinampSkin.variables['--panel'], 'Winamp BMP colors should produce a Newamp panel variable');

const [
  typesSource,
  preloadSource,
  apiSource,
  mainSource,
  settingsViewSource,
  appSource,
  skinsSource,
  styleSource,
  deckTypesSource,
  deckPickerSource,
  recordDeckSource,
  hotdogDeckSource,
  hotdogShellPng,
  hotdogMaskPng,
  packageSource,
  gateSource,
] =
  await Promise.all([
    readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/views/SettingsView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/skins.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/index.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/decks/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/decks/DeckSkinPicker.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/decks/RecordPlayerDeck.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/decks/HotdogDeck.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/assets/decks/hotdog-shell.png', import.meta.url)),
    readFile(new URL('../src/assets/decks/hotdog-mask.png', import.meta.url)),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8'),
  ]);

assert.match(typesSource, /exportCustomSkin/, 'shared API should expose skin export');
assert.match(typesSource, /importCustomSkin/, 'shared API should expose skin import');
assert.match(typesSource, /importCustomSkinFile/, 'shared API should expose direct skin-file import for drag/drop');
assert.match(preloadSource, /settings:skin-export/, 'preload should expose skin export IPC');
assert.match(preloadSource, /settings:skin-import/, 'preload should expose skin import IPC');
assert.match(preloadSource, /settings:skin-import-file/, 'preload should expose direct skin-file import IPC');
assert.match(apiSource, /exportCustomSkin/, 'browser-safe API should include skin export fallback');
assert.match(apiSource, /importCustomSkin/, 'browser-safe API should include skin import fallback');
assert.match(apiSource, /importCustomSkinFile/, 'browser-safe API should include direct skin-file import fallback');
assert.match(mainSource, /serializeCustomSkin/, 'main process should serialize skin exports');
assert.match(mainSource, /parseCustomSkinFile/, 'main process should parse skin imports');
assert.match(mainSource, /parseWinampClassicSkinArchive/, 'main process should parse Winamp classic WSZ skin imports');
assert.match(mainSource, /settings:skin-import-file/, 'main process should expose direct skin-file import IPC');
assert.match(mainSource, /extensions: \['json', 'wsz', 'zip'\]/, 'native import dialog should accept Newamp JSON and Winamp WSZ/ZIP skins');
assert.match(settingsViewSource, /Import skin/, 'Settings Skin Workshop should expose import');
assert.match(settingsViewSource, /Export skin/, 'Settings Skin Workshop should expose export');
assert.match(settingsViewSource, /Record Deck/, 'Settings should expose the record-player deck body');
assert.match(settingsViewSource, /Jukebox/, 'Settings should expose the jukebox deck body');
assert.match(settingsViewSource, /Vintage Computer/, 'Settings should expose the vintage-computer deck body');
assert.match(appSource, /isDroppedSkinFile/, 'app-wide drop handling should classify dropped skin files');
assert.match(appSource, /importCustomSkinFile/, 'app-wide drop handling should import dropped skin files');
assert.match(appSource, /Applied skin/, 'app-wide drop handling should report applied skins');
assert.match(skinsSource, /@shared\/custom-skin/, 'renderer skin constants should come from shared validation');
assert.match(deckTypesSource, /Windowshade/, 'deck skins should include a slim default windowshade bar');
assert.match(deckTypesSource, /size: \{ width: 820, height: 112 \}/, 'default deck skin should keep the slimmer fixed windowshade native size');
assert.match(deckPickerSource, /data-newamp-deck-skin-select/, 'compact deck should expose skin switching without consuming the whole bar');
assert.match(deckPickerSource, /deck-skin-picker is-compact titlebar-nodrag/, 'compact deck skin picker must stay clickable inside draggable deck chrome');
assert.match(deckPickerSource, /deck-skin-select titlebar-nodrag/, 'deck skin select must opt out of Electron window dragging');
assert.match(styleSource, /\.deck-skin-picker[\s\S]*?-webkit-app-region: no-drag/, 'deck skin picker CSS should force no-drag behavior');
assert.match(styleSource, /\.deck-record-player/, 'record deck should be a real shaped deck skin');
assert.match(recordDeckSource, /10 \+ progress \* 24/, 'record-player tonearm should stay on the playable band');
assert.doesNotMatch(recordDeckSource, /-34 \+ progress \* 26/, 'record-player tonearm should not drift off the right side of the record');
assert.match(styleSource, /\.deck-jukebox/, 'jukebox should be a real shaped deck skin');
assert.match(styleSource, /\.deck-cassette/, 'cassette should be a real shaped deck skin');
assert.match(styleSource, /\.deck-discman/, 'discman should be a real shaped deck skin');
assert.match(styleSource, /\.deck-hotdog/, 'hotdog deck should be a real shaped deck skin');
assert.match(styleSource, /\.deck-hd-art/, 'hotdog deck should render the shaped bun art layer');
assert.match(styleSource, /mask-image: url\('\.\.\/assets\/decks\/hotdog-mask\.png'\)/, 'hotdog deck should use the food-only PNG alpha as the visible window mask');
assert.match(hotdogDeckSource, /hotdog-shell\.png/, 'hotdog deck should render the realistic PNG shell asset');
assert.doesNotMatch(hotdogDeckSource, /<svg/, 'hotdog deck should not regress to the old rectangular inline SVG shell');
assert.ok(hotdogShellPng.length > 50000, 'hotdog shell PNG should be a real raster shell, not a placeholder');
assert.equal(hotdogShellPng.subarray(1, 4).toString('ascii'), 'PNG', 'hotdog shell should be a PNG asset');
assert.ok(hotdogMaskPng.length > 10000, 'hotdog mask PNG should be a real alpha mask, not a placeholder');
assert.equal(hotdogMaskPng.subarray(1, 4).toString('ascii'), 'PNG', 'hotdog mask should be a PNG asset');
assert.match(styleSource, /\.deck-hd-screen/, 'hotdog deck should expose the visualizer/album-art screen baked into the bun');
assert.match(styleSource, /\.deck-hd-transport/, 'hotdog deck should keep transport controls embedded in the bun');
assert.match(styleSource, /\.deck-retro-tv/, 'retro TV deck should be a real shaped deck skin');
assert.match(styleSource, /\.deck-winamp-classic/, 'classic Winamp deck should be a real shaped deck skin');
assert.match(packageSource, /"smoke:skin"/, 'package scripts should expose skin smoke');
assert.match(gateSource, /smoke:skin/, 'release gate should include skin smoke');

console.log(
  JSON.stringify(
    {
      ok: true,
      variables: Object.keys(skin.variables).length,
      winampImportVariables: Object.keys(importedWinampSkin.variables).length,
      exportedFormat: file.format,
    },
    null,
    2,
  ),
);

function createBmp24(width, height, getPixel) {
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const headerBytes = 54;
  const buffer = Buffer.alloc(headerBytes + pixelBytes);
  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(headerBytes, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(0, 30);
  buffer.writeUInt32LE(pixelBytes, 34);
  for (let y = 0; y < height; y += 1) {
    const bmpY = height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = getPixel(x, y);
      const offset = headerBytes + bmpY * rowStride + x * 3;
      buffer[offset] = b;
      buffer[offset + 1] = g;
      buffer[offset + 2] = r;
    }
  }
  return buffer;
}

function createZipArchive(entries) {
  const fileParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const source = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    const compressed = deflateRawSync(source);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    fileParts.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }
  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...fileParts, ...centralParts, end]);
}
