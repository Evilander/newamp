// Six SettingsView.tsx handlers (theme, custom-skin, crossfade, replayGain,
// limiter, preamp) rebuilt local settings state as `{ ...settings, field }`
// where `settings` was the value captured in the closure at render time —
// not the latest state. Two of these firing back-to-back before either's
// round trip resolved meant whichever resolved first got silently
// overwritten by the other's stale spread, visually reverting a change that
// had actually persisted correctly. The sibling handlers already fixed
// elsewhere in the same file (BitPerfectRow, textScale, performanceTier,
// ...) use api.setSettings(patch).then(setSettings) instead, which doesn't
// have this problem — but those store actions return Promise<void> (they
// update the zustand store's own settings, not this component's separate
// local copy), so widening their signature would be a bigger change than
// this fix needs; a functional updater on setSettings is fully self-
// contained to this component and equally race-free. Verified against
// source — no DOM/React harness is wired up in this repo, matching this
// repo's own convention for such fixes (see queue-edit-smoke.mjs).
// Run: node scripts/settings-view-stale-closure-test.mjs
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = true;
const log = [];
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const source = readFileSync(resolve('src/components/views/SettingsView.tsx'), 'utf8');

const FIELDS = ['theme: t.id', "theme: 'custom'", 'crossfadeMs: v', 'replayGain', 'limiterEnabled', 'preampDb'];
for (const field of FIELDS) {
  const pattern = new RegExp(`setSettings\\(\\(prev\\) => \\(prev \\? \\{ \\.\\.\\.prev, ${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\} : prev\\)\\)`);
  if (!pattern.test(source)) {
    fail(`the ${field} handler should update settings via a functional updater reading the latest prev state, not a closure-captured snapshot`);
  }
}

if (/setSettings\(\{ \.\.\.settings, theme: t\.id \}\)/.test(source)) fail('the old stale-closure spread for theme should be gone');
if (/setSettings\(\{ \.\.\.settings, crossfadeMs: v \}\)/.test(source)) fail('the old stale-closure spread for crossfadeMs should be gone');
if (/setSettings\(\{ \.\.\.settings, limiterEnabled \}\)/.test(source)) fail('the old stale-closure spread for limiterEnabled should be gone');

const packageSource = readFileSync(resolve('package.json'), 'utf8');
if (!/"test:settings-view-stale-closure"/.test(packageSource)) fail('package.json should expose the SettingsView stale-closure test');

console.log(log.join('\n') + '\n' + (pass ? '[settings-view-stale-closure-test] PASS' : '[settings-view-stale-closure-test] FAIL'));
process.exitCode = pass ? 0 : 1;
