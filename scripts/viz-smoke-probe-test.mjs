// The visualizer smokes assert on fields their in-app probes (electron/main.ts)
// report. Nothing launches Electron here: this checks that the probes still
// parse as the scripts they become, that every field a smoke reads is one the
// probe returns, and that the probes press the keys the visualizer now owns.
// Run with: npm run test:viz-smoke-probe
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [main, visualizerSmoke, detachedSmoke] = await Promise.all([
  read('electron/main.ts'),
  read('scripts/ui-visualizer-smoke.mjs'),
  read('scripts/ui-detached-viz-smoke.mjs'),
]);

// The probe is a template literal inside main.ts. Evaluating it the same way
// catches a stray ${ or escape that would change the script it produces.
function templateBody(name) {
  const start = main.indexOf(`function ${name}(): string {`);
  assert.ok(start >= 0, `${name} exists in electron/main.ts`);
  const open = main.indexOf('return `', start) + 'return `'.length;
  const end = main.indexOf('`;', open);
  assert.ok(open > start && end > open, `${name} returns a template literal`);
  return main.slice(open, end);
}

const body = templateBody('uiVisualizerProbeSource');
const script = vm.runInNewContext(`\`${body}\``, Object.create(null), { timeout: 2000 });
assert.doesNotThrow(() => new vm.Script(script), 'the visualizer probe parses as a script');

// ---- fields the visualizer smoke reads ----
const returned = (() => {
  const from = body.lastIndexOf('return {');
  const to = body.indexOf('\n      };', from);
  assert.ok(from >= 0 && to > from, 'the probe ends in a returned object');
  return new Set([...body.slice(from, to).matchAll(/^\s+(\w+)\s*[:,]/gm)].map((m) => m[1]));
})();
// Only the assertions: the fixture helpers further down have a `result` of their own.
const assertions = visualizerSmoke.slice(0, visualizerSmoke.indexOf('console.log(JSON.stringify(result'));
const asserted = new Set([...assertions.matchAll(/\bresult\.(\w+)/g)].map((m) => m[1]));
assert.ok(asserted.size > 25, 'the smoke reads a real set of fields');
for (const field of asserted) {
  assert.ok(returned.has(field), `ui-visualizer-smoke reads result.${field}, but the probe never returns it`);
}
for (const field of [
  'rightClickMenuAtCursor', 'rightClickMenuFocused', 'rightClickMenuArrowMoved', 'popoverFocusIn', 'popoverFocusReturned',
  'ctrlArrowKeepsPreset', 'plainLKeepsTier', 'plainVKeepsAutoVj', 'heldKeyIgnored', 'heldArrowSteps', 'liteBurstQuality',
  'dblclickOnControlKeepsWindow', 'meterDblclickVolume', 'artDefault',
  'sameTickArrowSteps', 'dblclickOnStageFlips', 'dblclickOnStageFlipsBack', 'popoverMouseOpenFocusOnStage',
  'stageFocusedOnOpen', 'stageFocusedOnReopen', 'stageFocusReturned',
  'menuRightOpensSubmenu', 'menuWheelKept', 'menuLeftClosesSubmenu', 'menuEndFocusesLast', 'menuHomeFocusesFirst',
  'menuTabCloses', 'menuModePicked', 'menuModeClosed', 'menuLockToggles',
]) {
  assert.ok(asserted.has(field), `the smoke asserts ${field}`);
}

// ---- keys the probe presses ----
assert.doesNotMatch(body, /pressKey\('l'\)/, 'plain L is the app-wide love key, not Lite');
assert.doesNotMatch(body, /pressKey\('v'\)/, 'plain V is the app-wide stop key, not Auto-VJ');
assert.equal((body.match(/pressKey\('L', \{ shiftKey: true \}\)/g) ?? []).length, 4, 'Lite is on Shift+L (the burst and the toggle pair)');
assert.match(body, /pressKey\('V', \{ shiftKey: true \}\)/, 'Auto-VJ is on Shift+V');
assert.match(body, /stopImmediatePropagation/, 'keys that belong to the app are stopped before the app acts on them');
assert.match(body, /artDefault = stage\.getAttribute\('data-newamp-visualizer-art'\)/, 'the cover default is read before the probe turns it on');
assert.ok(
  body.indexOf("const artDefault") < body.indexOf("pressKey('a')"),
  'and before the probe presses A',
);
assert.match(body, /\[data-newamp-viz-menu\]/, 'the right-click check looks for the menu, not the preset dialog');
assert.match(body, /toolbarToggle\.focus\(\{ focusVisible: true \}\);[\s\S]{0,160}toolbarToggle\.click\(\);/, 'the toolbar button has keyboard focus before it opens the dialog');
assert.match(body, /toolbarToggle\.focus\(\{ focusVisible: false \}\);\s*if \(toolbarToggle\.matches\(':focus-visible'\)\) toolbarToggle\.blur\(\);\s*toolbarToggle\.click\(\);/, 'and a mouse open leaves the button without focus-visible');
assert.match(body, /document\.activeElement === \(popoverOpenerFocusVisible \? toolbarToggle : liveStage\(\)\)/, 'a keyboard open returns to the button, anything else to the stage');
assert.match(body, /popoverMouseOpenFocusOnStage =[\s\S]{0,160}document\.activeElement === liveStage\(\)/, 'a mouse open ends with focus on the stage');
assert.match(body, /stageFocusedOnOpen = document\.activeElement === stage/, 'the stage takes focus as it opens');
assert.match(body, /pressKey\('ArrowLeft', \{ repeat: true \}\);\s*pressKey\('ArrowLeft', \{ repeat: true \}\);/, 'two arrow presses go in with no await between them');
assert.match(body, /menuKey\(modeItem, 'ArrowRight'\)/, 'the Mode submenu is opened from the keyboard');
assert.match(body, /menuItem\('lock'\)\.click\(\)/, 'Lock look is driven through the menu');
assert.match(body, /doubleClick\(bareStage\)/, 'a double-click on the bare stage is the positive control for the one on controls');

// ---- projector cursor ----
const detachedBody = main.slice(main.indexOf('const cursor = await detachedVizWin'), main.indexOf('// Look-ahead, end to end'));
assert.ok(detachedBody.length > 100, 'the projector cursor probe is in main.ts');
assert.match(detachedBody, /return \{ before, afterMove, afterIdle,/, 'it reports the cursor after the move and after the idle wait');
assert.match(detachedBody, /afterIdle !== 'none' && performance\.now\(\) - idleStart < 6000/, 'and waits a bounded time for the hide');
const cursorReads = new Set([...detachedSmoke.matchAll(/result\.cursor\?\.(\w+)/g)].map((m) => m[1]));
assert.deepEqual([...cursorReads].sort(), ['afterIdle', 'afterMove'], 'the projector smoke checks both halves of the cursor contract');
assert.match(detachedSmoke, /afterIdle, 'none'/, 'the cursor must be hidden after the idle timeout');

console.log(JSON.stringify({ ok: true }, null, 2));
