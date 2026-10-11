// The Skin Workshop draft store (src/lib/skin-draft.ts): one draft behind the
// Settings page and the floating colour editor. Checks that edits live in the
// store (so they survive moving between views), preview on the page once per
// frame, end only by save or discard, and never lose colours when the saved
// skin changes underneath them.
//
// Run: node scripts/skin-draft-test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const deadline = setTimeout(() => { console.error('Skin draft test timed out'); process.exit(1); }, 30000);
deadline.unref();

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({
  stdin: {
    contents: `
      export * from './src/lib/skin-draft';
      export { SKIN_VARIABLES } from './shared/custom-skin';
      export { contrastBetween } from './shared/skin-color';
    `,
    resolveDir: repoRoot,
    loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
  alias: { '@shared': `${repoRoot}shared` },
});
const m = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const PAGE = {
  '--bg': '#0b1014', '--panel': '#11141b', '--panel-2': '#181d27', '--panel-3': '#232936', '--line': '#2a3140',
  '--accent': '#ffff00', '--accent-dim': '#b8b800', '--accent-glow': 'rgba(255, 255, 0, 0.55)', '--on-accent': '#000000',
  '--ink': '#e8ecf3', '--ink-2': '#c0c8d6', '--muted': '#9aa3b2', '--warn': '#ffb000', '--error': '#ff3d3d',
  '--display-bg': '#0a1408', '--display-fg': '#00ff66', '--bevel-light': 'rgba(255, 255, 255, 0.08)', '--bevel-dark': 'rgba(0, 0, 0, 0.5)',
  '--radius': '4px', '--radius-card': '8px',
};

// A world to run the store in: settings, a page, a shelf, a frame queue.
function world({ theme = 'midnight', customSkin = null } = {}) {
  const w = {
    settings: { theme, customSkin },
    page: { ...PAGE },
    previews: [],
    changes: [],
    restores: [],
    saves: [],
    shelf: [],
    toasts: [],
    frames: [],
    listeners: new Set(),
    clock: 1000,
    /** Set to hold a save open until the test lets it go. */
    gate: null,
  };
  w.setSettings = (next) => {
    w.settings = { ...w.settings, ...next };
    for (const listener of w.listeners) listener();
  };
  w.flush = () => { const run = w.frames.splice(0); for (const fn of run) fn(); };
  w.store = m.createSkinDraftStore({
    settings: () => w.settings,
    readCurrent: () => ({ ...w.page }),
    preview: (variables, changed) => { w.previews.push({ ...variables }); w.changes.push([...changed]); },
    restore: (settings) => { w.restores.push(settings); },
    save: async (skin) => {
      w.saves.push(skin);
      await w.gate?.();
      w.setSettings({ theme: 'custom', customSkin: skin });
    },
    shelve: (skin) => {
      const taken = w.shelf.map((entry) => entry.name);
      const name = taken.includes(skin.name) ? `${skin.name} (2)` : skin.name;
      w.shelf.push({ ...skin, name });
      return name;
    },
    onSettingsChange: (listener) => { w.listeners.add(listener); return () => w.listeners.delete(listener); },
    schedule: (run) => { w.frames.push(run); },
    notify: (toast) => { w.toasts.push(toast); },
    resolveNamed: (name) => (name === 'teal' ? 'rgb(0, 128, 128)' : null),
    now: () => (w.clock += 1),
  });
  return w;
}
const skinOf = (overrides, name = 'Mine', baseTheme = 'midnight', updatedAt = 5) => ({ name, baseTheme, variables: { ...PAGE, ...overrides }, updatedAt });

// ── starting a session ─────────────────────────────────────────────────────
{
  const w = world();
  assert.equal(w.store.getState().active, false, 'nothing is open until a view asks');
  w.store.getState().setVar('--accent', '#123456');
  assert.equal(w.store.getState().active, true, 'editing opens a session by itself');

  const v = world({ theme: 'midnight' });
  v.store.getState().begin();
  const s = v.store.getState();
  assert.equal(s.name, 'NewAmp Custom');
  assert.equal(s.baseTheme, 'midnight', 'a built-in theme is the base');
  assert.deepEqual(s.draft, PAGE, 'the draft starts as the colours on the page');
  assert.equal(s.dirty, false);
  assert.equal(s.editingCustom, false);

  const custom = world({ theme: 'custom', customSkin: skinOf({ '--accent': '#ff0000' }, 'Red Room', 'neon') });
  custom.store.getState().begin();
  const c = custom.store.getState();
  assert.equal(c.name, 'Red Room');
  assert.equal(c.baseTheme, 'neon', 'a custom skin keeps its own base theme');
  assert.equal(c.draft['--accent'], '#ff0000', 'the saved skin wins over the page');
  assert.equal(c.editingCustom, true);

  // A saved skin that predates a variable still shows its colour.
  const old = world({ theme: 'custom', customSkin: { name: 'Old', baseTheme: 'classic', variables: { '--accent': '#ff0000' }, updatedAt: 1 } });
  old.store.getState().begin();
  assert.equal(old.store.getState().draft['--on-accent'], '#000000', 'missing variables come from the page');
  assert.equal(old.store.getState().draft['--accent'], '#ff0000');

  // An inactive custom skin still gives its name to the editor, not its colours.
  const parked = world({ theme: 'steel', customSkin: skinOf({}, 'Parked') });
  parked.store.getState().begin();
  assert.equal(parked.store.getState().name, 'Parked');
  assert.equal(parked.store.getState().baseTheme, 'steel');
  assert.equal(parked.store.getState().editingCustom, false);

  // Settings not loaded yet: nothing to edit.
  const none = world();
  none.settings = null;
  none.store.getState().begin();
  assert.equal(none.store.getState().active, false);
}

// ── edits, and the preview one frame at a time ─────────────────────────────
{
  const w = world();
  const { begin, setVar } = w.store.getState();
  begin();
  setVar('--accent', '#112233');
  setVar('--accent', '#223344');
  setVar('--ink', '#ffffff');
  assert.equal(w.previews.length, 0, 'nothing reaches the page until the frame');
  assert.equal(w.frames.length, 1, 'one frame is queued however many edits come in');
  w.flush();
  assert.equal(w.previews.length, 1, 'one pass on the page per frame');
  assert.equal(w.previews[0]['--accent'], '#223344');
  assert.equal(w.previews[0]['--ink'], '#ffffff');
  assert.equal(w.previews[0]['--bg'], PAGE['--bg'], 'the pass carries the whole draft');
  assert.deepEqual(w.changes[0], ['--accent', '--ink'], 'and says which variables moved');
  assert.equal(w.store.getState().previewRev, 1);
  assert.equal(w.store.getState().dirty, true);

  setVar('--accent', '#33');
  assert.equal(w.frames.length, 0, 'a half-typed value queues nothing');
  assert.equal(w.store.getState().draft['--accent'], '#33', 'but stays in the field');
  setVar('--radius', '99999px');
  assert.equal(w.frames.length, 0, 'an unsupported length is not previewed either');
  setVar('--bg', 'red');
  w.flush();
  const last = w.previews.at(-1);
  assert.deepEqual(w.changes.at(-1), ['--bg'], 'a half-typed value is not a change; the next pass names only what really moved');
  assert.equal(last['--accent'], '#223344', 'the page keeps the last accepted accent');
  assert.equal(last['--radius'], PAGE['--radius']);
  assert.equal(last['--bg'], 'red', 'a colour name is accepted');

  // Back to where it started: clean again.
  const fresh = world();
  fresh.store.getState().begin();
  fresh.store.getState().setVar('--accent', '#000000');
  assert.equal(fresh.store.getState().dirty, true);
  fresh.store.getState().setVar('--accent', PAGE['--accent']);
  assert.equal(fresh.store.getState().dirty, false, 'putting a value back clears the mark');
  fresh.store.getState().setName('Another');
  assert.equal(fresh.store.getState().dirty, true, 'a new name is an edit');
  fresh.store.getState().setName('NewAmp Custom');
  assert.equal(fresh.store.getState().dirty, false);

  const before = fresh.store.getState().draft;
  fresh.store.getState().setVar('--not-a-variable', '#fff');
  assert.equal(fresh.store.getState().draft, before, 'unknown variables are ignored');
}

// ── the draft outlives the views ───────────────────────────────────────────
{
  const w = world();
  w.store.getState().begin();
  w.store.getState().setVar('--accent', '#abcdef');
  // A view unmounting and another mounting calls begin() again.
  w.store.getState().begin();
  assert.equal(w.store.getState().draft['--accent'], '#abcdef', 'begin() does not restart a session that is open');
  assert.equal(w.store.getState().dirty, true);
}

// ── discard ────────────────────────────────────────────────────────────────
{
  const w = world({ theme: 'custom', customSkin: skinOf({ '--accent': '#ff0000' }, 'Red Room') });
  w.store.getState().begin();
  w.store.getState().setVar('--accent', '#00ff00');
  w.store.getState().discard();
  assert.equal(w.restores.length, 1, 'the saved skin goes back on the page');
  assert.equal(w.restores[0].customSkin.name, 'Red Room');
  assert.equal(w.restores[0].theme, 'custom');
  assert.equal(w.store.getState().active, false, 'and the session ends');
  assert.equal(w.store.getState().dirty, false);
  w.flush();
  assert.equal(w.previews.length, 0, 'a frame queued before the discard does not paint over the restored page');

  w.store.getState().begin();
  assert.equal(w.store.getState().draft['--accent'], '#ff0000', 'the next session starts from the saved skin');
  w.store.getState().setVar('--ink', '#010101');
  w.flush();
  assert.equal(w.previews.length, 1, 'previews work again in the new session');
}

// ── save ───────────────────────────────────────────────────────────────────
{
  const w = world();
  const s = w.store.getState();
  s.begin();
  s.setVar('--accent', '#ff00aa');
  s.setVar('--ink', '#12');
  s.setName('  My Pink  ');
  const skin = await s.save();
  assert.equal(skin.name, 'My Pink', 'the name is trimmed');
  assert.equal(skin.baseTheme, 'midnight');
  assert.equal(skin.variables['--accent'], '#ff00aa');
  assert.equal(skin.variables['--ink'], PAGE['--ink'], 'a half-typed value is not saved; the accepted one is');
  assert.equal(skin.updatedAt, 1001);
  assert.equal(w.saves.length, 1);
  assert.equal(w.settings.theme, 'custom');
  const after = w.store.getState();
  assert.equal(after.active, true, 'the session carries on from what was saved');
  assert.equal(after.dirty, false);
  assert.equal(after.name, 'My Pink');
  assert.equal(after.draft['--accent'], '#ff00aa');
  assert.equal(after.editingCustom, true);
  assert.equal(after.savedRev, 1);
  assert.equal(w.toasts.length, 0, 'saving over the callback of its own change is not a skin change');

  // Edits to the same skin overwrite it quietly.
  after.setVar('--accent', '#00aaff');
  await after.save();
  assert.equal(w.shelf.length, 0, 'editing a skin in place keeps nothing on the shelf');
  assert.equal(w.store.getState().savedRev, 2);

  // Saving them under a new name keeps the old skin.
  w.store.getState().setName('Blue Version');
  w.store.getState().setVar('--accent', '#0000ff');
  await w.store.getState().save();
  assert.deepEqual(w.shelf.map((entry) => entry.name), ['My Pink'], 'a rename keeps the skin it replaced');
  assert.equal(w.shelf[0].variables['--accent'], '#00aaff');
}
{
  // Colours edited from a built-in theme replace the parked custom skin: keep it.
  const w = world({ theme: 'steel', customSkin: skinOf({ '--accent': '#ff0000' }, 'Parked') });
  w.store.getState().begin();
  w.store.getState().setVar('--accent', '#00ff00');
  await w.store.getState().save();
  assert.deepEqual(w.shelf.map((entry) => entry.name), ['Parked']);
  assert.equal(w.saves[0].name, 'Parked', 'the new skin takes the name the editor showed');

  // The same colours need no shelf entry.
  const same = world({ theme: 'steel', customSkin: skinOf({}, 'Parked') });
  same.store.getState().begin();
  same.store.getState().setVar('--accent', '#111111');
  same.store.getState().setVar('--accent', PAGE['--accent']);
  await same.store.getState().save();
  assert.equal(same.shelf.length, 0);
}
{
  // A failed save leaves the session alone, and the skin it would have replaced where it is.
  let thrown = null;
  const shelved = [];
  const bad = m.createSkinDraftStore({
    settings: () => ({ theme: 'steel', customSkin: skinOf({ '--accent': '#ff0000' }, 'Parked') }), readCurrent: () => ({ ...PAGE }), preview() {}, restore() {},
    save: async () => { throw new Error('disk full'); }, shelve: (skin) => { shelved.push(skin.name); return skin.name; }, onSettingsChange: () => () => {},
    schedule: () => {}, notify() {}, now: () => 1,
  });
  bad.getState().begin();
  bad.getState().setVar('--accent', '#123123');
  try { await bad.getState().save(); } catch (error) { thrown = error; }
  assert.equal(thrown?.message, 'disk full');
  assert.deepEqual(shelved, [], 'nothing goes on the shelf for a save that did not happen');
  assert.equal(bad.getState().dirty, true, 'the edits are still there to save again');
  assert.equal(bad.getState().active, true);
  bad.getState().setVar('--ink', '#000000');
  assert.equal(bad.getState().draft['--ink'], '#000000', 'and the editor still takes edits');
}
{
  // Colours dragged while the save is in flight are not in the saved skin and must not vanish.
  const w = world();
  w.store.getState().begin();
  w.store.getState().setVar('--accent', '#ff00aa');
  let release = () => {};
  w.gate = () => new Promise((resolve) => { release = resolve; });
  const saving = w.store.getState().save();
  w.store.getState().setVar('--ink', '#101010');
  w.store.getState().setName('Renamed meanwhile');
  release();
  const skin = await saving;
  const after = w.store.getState();
  assert.equal(skin.variables['--accent'], '#ff00aa');
  assert.equal(skin.variables['--ink'], PAGE['--ink'], 'the saved skin is what was there when Save was pressed');
  assert.equal(after.draft['--ink'], '#101010', 'the colour dragged during the save is still in the draft');
  assert.equal(after.name, 'Renamed meanwhile', 'and so is the name');
  assert.equal(after.dirty, true, 'as unsaved changes');
  assert.equal(after.baseline['--ink'], PAGE['--ink'], 'measured against what was saved');
  assert.equal(after.baselineName, skin.name);
  assert.equal(after.savedRev, 1);
  assert.equal(after.editingCustom, true);
  w.previews.length = 0;
  w.changes.length = 0;
  w.flush();
  assert.equal(w.previews.length, 1, 'one pass puts the draft back on the page the save repainted');
  assert.equal(w.previews[0]['--ink'], '#101010');
  assert.ok(w.changes[0].length > 1, 'as a whole draft, not a single variable');
  w.gate = null;
  await w.store.getState().save();
  assert.equal(w.store.getState().dirty, false, 'saving again takes them in');
  assert.equal(w.saves.at(-1).variables['--ink'], '#101010');

  // Discarded while the save is in flight: the saved skin stands and the session stays closed.
  const gone = world();
  gone.store.getState().begin();
  gone.store.getState().setVar('--accent', '#112233');
  let let_go = () => {};
  gone.gate = () => new Promise((resolve) => { let_go = resolve; });
  const pending = gone.store.getState().save();
  gone.store.getState().discard();
  let_go();
  await pending;
  assert.equal(gone.store.getState().active, false);
  assert.equal(gone.store.getState().savedRev, 1);
}

// ── the saved skin changes underneath an open session ──────────────────────
{
  const w = world();
  w.store.getState().begin();
  w.store.getState().setVar('--accent', '#ff00aa');
  w.setSettings({ theme: 'ice' });
  assert.equal(w.store.getState().active, false, 'the session ends when the theme changes');
  assert.equal(w.shelf.length, 1, 'unsaved colours go on the shelf');
  assert.equal(w.shelf[0].name, 'NewAmp Custom (unsaved)');
  assert.equal(w.shelf[0].variables['--accent'], '#ff00aa');
  assert.equal(w.toasts.length, 1);
  assert.match(w.toasts[0].detail, /NewAmp Custom \(unsaved\)/);
  w.flush();
  assert.equal(w.previews.length, 0, 'and nothing is painted over the new theme');

  const clean = world();
  clean.store.getState().begin();
  clean.setSettings({ theme: 'ice' });
  assert.equal(clean.store.getState().active, false);
  assert.equal(clean.shelf.length, 0, 'a clean session leaves nothing behind');
  assert.equal(clean.toasts.length, 0);
  clean.store.getState().begin();
  assert.equal(clean.store.getState().baseTheme, 'ice', 'the next session follows the new theme');

  // Unrelated settings changes (a volume, a window size) do not touch it.
  const quiet = world();
  quiet.store.getState().begin();
  quiet.store.getState().setVar('--accent', '#222222');
  quiet.setSettings({ customSkin: null });
  assert.equal(quiet.store.getState().active, true, 'the same theme and skin key keeps the session');
  assert.equal(quiet.store.getState().dirty, true);

  // The same skin applied again (choosing the card that is already chosen)
  // repaints the page from the saved skin, which wipes edits that are not saved.
  const again = world();
  again.store.getState().begin();
  again.store.getState().setVar('--accent', '#abcdef');
  again.flush();
  again.previews.length = 0;
  again.changes.length = 0;
  again.setSettings({ theme: 'midnight' });
  again.flush();
  assert.equal(again.previews.length, 1, 'the draft goes back on the page');
  assert.equal(again.previews[0]['--accent'], '#abcdef');
  assert.ok(again.changes[0].length > 1, 'as a whole draft');
  assert.equal(again.store.getState().active, true);
  assert.equal(again.shelf.length, 0, 'nothing is shelved; the skin did not change');

  const calm = world();
  calm.store.getState().begin();
  calm.setSettings({ theme: 'midnight' });
  assert.equal(calm.frames.length, 0, 'a clean session has nothing to put back');

  // A dropped skin while editing.
  const drop = world({ theme: 'custom', customSkin: skinOf({}, 'Mine') });
  drop.store.getState().begin();
  drop.store.getState().setVar('--accent', '#444444');
  drop.setSettings({ customSkin: skinOf({ '--accent': '#999999' }, 'Dropped', 'classic', 9) });
  assert.equal(drop.store.getState().active, false);
  assert.equal(drop.shelf[0].variables['--accent'], '#444444');
}

// ── hue, saturation, brightness ────────────────────────────────────────────
{
  const w = world();
  const s = w.store.getState();
  s.begin();
  s.setVar('--ink', '#f0f0f0');
  const afterInk = w.store.getState().draft;
  s.setTint({ hue: 180 });
  const turned = w.store.getState().draft;
  assert.notEqual(turned['--accent'], afterInk['--accent']);
  assert.equal(turned['--warn'], afterInk['--warn'], 'warn and error keep their hue');
  assert.equal(w.store.getState().dirty, true);
  w.flush();
  assert.equal(w.previews.length, 1);
  assert.equal(w.previews[0]['--accent'], turned['--accent'], 'the tint reaches the page');
  assert.ok(w.changes[0].length > 5 && w.changes[0].includes('--accent') && !w.changes[0].includes('--warn'), 'a tint reports every colour it moved');

  const atTwenty = (() => { w.store.getState().setTint({ hue: 20 }); return { ...w.store.getState().draft }; })();
  w.store.getState().setTint({ hue: 90 });
  w.store.getState().setTint({ hue: 20 });
  assert.deepEqual(w.store.getState().draft, atTwenty, 'a slider returning to a spot lands on the same colours');
  w.store.getState().setTint({ sat: 0.5, light: 0.8 });
  assert.equal(w.store.getState().tint.hue, 20, 'the sliders move independently');
  w.store.getState().resetTint();
  assert.deepEqual(w.store.getState().draft, afterInk, 'resetting puts the colours back exactly');
  assert.deepEqual(w.store.getState().tint, { hue: 0, sat: 1, light: 1 });
  assert.equal(w.store.getState().dirty, true, 'the earlier edit is still unsaved');

  // The automatic label follows the tinted accent.
  w.store.getState().setTint({ light: 0.2 });
  assert.equal(w.store.getState().draft['--on-accent'], '#ffffff');
  assert.ok(m.contrastBetween(w.store.getState().draft['--on-accent'], w.store.getState().draft['--accent']) >= 4.5);

  // Editing one colour by hand makes the current colours the new starting point.
  w.store.getState().setVar('--accent', '#ffcc00');
  assert.deepEqual(w.store.getState().tint, { hue: 0, sat: 1, light: 1 }, 'a manual edit puts the sliders back at neutral');
  const manual = { ...w.store.getState().draft };
  w.store.getState().setTint({ hue: 0 });
  assert.deepEqual(w.store.getState().draft, manual, 'a neutral move changes nothing');
  w.store.getState().setTint({ hue: 999, sat: -4, light: 40 });
  assert.deepEqual(w.store.getState().tint, { hue: 360, sat: 0, light: 2 }, 'sliders are clamped');

  const named = world();
  named.store.getState().begin();
  named.store.getState().setVar('--line', 'teal');
  named.store.getState().setTint({ hue: 90 });
  assert.notEqual(named.store.getState().draft['--line'], 'teal', 'names are re-tinted through the resolver');
}

// ── the text on the accent follows the accent ──────────────────────────────
{
  const readable = (state, accent = state.draft['--accent']) => m.contrastBetween(state.draft['--on-accent'], accent) >= 4.5;

  // The label that suited the old accent is dropped for the one that suits the new.
  const dark = world();
  dark.store.getState().begin();
  dark.store.getState().setVar('--accent', '#7a3dc8');
  assert.equal(dark.store.getState().draft['--on-accent'], '#ffffff', 'a dark accent takes white text');
  assert.ok(readable(dark.store.getState()));
  dark.flush();
  assert.deepEqual(dark.changes.at(-1), ['--accent'], 'one variable is edited');
  assert.equal(dark.previews.at(-1)['--on-accent'], '#ffffff', 'and the preview carries the label with it');
  dark.store.getState().setVar('--accent', '#ffee00');
  assert.equal(dark.store.getState().draft['--on-accent'], '#000000', 'and back to black on a light one');

  // A tint that flipped the label, then an accent typed in.
  const tinted = world();
  tinted.store.getState().begin();
  tinted.store.getState().setTint({ light: 0.2 });
  assert.equal(tinted.store.getState().draft['--on-accent'], '#ffffff');
  tinted.store.getState().setVar('--accent', '#ffee88');
  assert.equal(tinted.store.getState().draft['--on-accent'], '#000000', 'the label the tint chose is automatic too');
  assert.ok(readable(tinted.store.getState()));
  for (const accent of ['#7a3dc8', '#b03060', '#1f6f50', '#8844cc']) {
    tinted.store.getState().setVar('--accent', accent);
    assert.ok(readable(tinted.store.getState()), `the label reads on ${accent}`);
  }

  // Typed a digit at a time, the colours between are not accents and must not lose the label's place.
  const typed = world();
  typed.store.getState().begin();
  for (const text of ['#', '#7', '#7a3', '#7a', '#7a3d', '#7a3dc', '#7a3dc8']) typed.store.getState().setVar('--accent', text);
  assert.equal(typed.store.getState().draft['--accent'], '#7a3dc8');
  assert.equal(typed.store.getState().draft['--on-accent'], '#ffffff');
  assert.ok(readable(typed.store.getState()));

  // A label that was picked is the person's.
  const picked = world();
  picked.store.getState().begin();
  picked.store.getState().setVar('--on-accent', '#ff00ff');
  picked.store.getState().setVar('--accent', '#222222');
  assert.equal(picked.store.getState().draft['--on-accent'], '#ff00ff', 'a chosen label stays');

  // An accent that is not a colour changes nothing.
  const junk = world();
  junk.store.getState().begin();
  junk.store.getState().setVar('--accent', 'not a colour');
  assert.equal(junk.store.getState().draft['--on-accent'], '#000000');
  junk.store.getState().setVar('--accent', '#7a3dc8');
  assert.equal(junk.store.getState().draft['--on-accent'], '#ffffff', 'the next real accent still moves it');

  // After a save the label is followed from the saved accent.
  const saved = world();
  saved.store.getState().begin();
  saved.store.getState().setVar('--accent', '#7a3dc8');
  await saved.store.getState().save();
  saved.store.getState().setVar('--accent', '#ffee00');
  assert.equal(saved.store.getState().draft['--on-accent'], '#000000');

  // A skin reopened with its accent and label saved: it follows from there.
  const reopened = world({ theme: 'custom', customSkin: skinOf({ '--accent': '#102040', '--on-accent': '#ffffff' }, 'Navy') });
  reopened.store.getState().begin();
  reopened.store.getState().setVar('--accent', '#ffee88');
  assert.equal(reopened.store.getState().draft['--on-accent'], '#000000');
}

// ── what the editor's footer says ──────────────────────────────────────────
{
  const status = m.editorFooterStatus;
  assert.deepEqual(status({ dirty: false, error: null, saved: null }), { text: 'Matches the saved skin', tone: 'ok' });
  assert.deepEqual(status({ dirty: false, error: null, saved: 'Saved Mine.' }), { text: 'Saved Mine.', tone: 'ok' });
  assert.deepEqual(status({ dirty: true, error: null, saved: 'Saved Mine.' }), { text: 'Unsaved changes', tone: 'dirty' });
  assert.deepEqual(status({ dirty: true, error: 'disk full', saved: null }), { text: 'Not saved: disk full', tone: 'error' }, 'a failed save is not hidden by the unsaved mark');
  assert.equal(status({ dirty: false, error: 'disk full', saved: 'Saved Mine.' }).tone, 'error', 'nor by an older save');

  const skin = { name: 'Mine', baseTheme: 'midnight', variables: { '--bg': '#000000' }, updatedAt: 1 };
  assert.deepEqual(await m.runSkinSave(async () => skin), { skin, error: null });
  assert.deepEqual(await m.runSkinSave(async () => null), { skin: null, error: null }, 'no session is not a failure');
  assert.deepEqual(await m.runSkinSave(async () => { throw new Error('disk full'); }), { skin: null, error: 'disk full' }, 'a rejecting save comes back as a message');
  assert.deepEqual(await m.runSkinSave(async () => { throw new Error(''); }), { skin: null, error: 'Could not save the skin.' });
  assert.deepEqual(await m.runSkinSave(async () => { throw 'nope'; }), { skin: null, error: 'Could not save the skin.' }, 'whatever was thrown');
}

// ── building a skin ────────────────────────────────────────────────────────
{
  const w = world();
  assert.equal(w.store.getState().buildSkin(), null, 'no session, no skin');
  w.store.getState().begin();
  w.store.getState().setName('   ');
  assert.equal(w.store.getState().buildSkin().name, 'NewAmp Custom', 'a blank name falls back');
  w.store.getState().setName('x'.repeat(200));
  assert.equal(w.store.getState().buildSkin().name.length, 80);
  for (const key of m.SKIN_VARIABLES) assert.ok(w.store.getState().buildSkin().variables[key], `${key} is in the skin`);
}

console.log(JSON.stringify({ ok: true }, null, 2));
