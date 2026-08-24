// loadTab/openCachedTab/savePastedTab had no guard against the user
// skipping to a new track while their async request was in flight — a slow
// or Cloudflare-blocked Ultimate Guitar request resolving late would
// unconditionally setTab/setWindowOpen(true), reopening the OLD track's
// chords over whatever is now playing. This can only be exercised for real
// with a DOM/React harness this repo doesn't have wired up (matching this
// repo's own convention — see queue-edit-smoke.mjs — for such fixes), so
// this verifies every await-continuation in all three functions checks the
// live currentIdRef before touching state.
// Run: node scripts/guitar-tab-track-switch-guard-test.mjs
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = true;
const log = [];
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const source = readFileSync(resolve('src/components/GuitarTabCompanion.tsx'), 'utf8');

if (!/const currentIdRef = useRef\(current\.id\);/.test(source)) {
  fail('a currentIdRef should track the live current.id (closures over the `current` prop stay stale)');
}
if (!/currentIdRef\.current = current\.id;/.test(source)) {
  fail('currentIdRef should be kept in sync with current.id via its own effect');
}

function extractFn(name) {
  const match = source.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n {2}\\}`));
  return match?.[0] ?? '';
}

const loadTab = extractFn('loadTab');
const openCachedTab = extractFn('openCachedTab');
const savePastedTab = extractFn('savePastedTab');

if (!loadTab) fail('loadTab should exist');
if (!openCachedTab) fail('openCachedTab should exist');
if (!savePastedTab) fail('savePastedTab should exist');

// Every await in each function must be followed by a currentIdRef check
// before the next state-mutating call — count them and compare.
for (const [name, fn] of [['loadTab', loadTab], ['openCachedTab', openCachedTab], ['savePastedTab', savePastedTab]]) {
  const awaitCount = (fn.match(/await api\./g) ?? []).length;
  const guardCount = (fn.match(/if \(currentIdRef\.current !== trackId\) return;/g) ?? []).length;
  log.push(`${name}: ${awaitCount} await(s), ${guardCount} guard(s)`);
  if (awaitCount === 0) fail(`${name}: test assumption broken — expected at least one await api.* call`);
  if (guardCount < awaitCount) {
    fail(`${name}: expected at least one currentIdRef guard per await (${awaitCount} awaits, only ${guardCount} guards)`);
  }
  if (!/const trackId = current\.id;/.test(fn)) {
    fail(`${name} should capture trackId at call time, before any await`);
  }
}

const packageSource = readFileSync(resolve('package.json'), 'utf8');
if (!/"test:guitar-tab-track-switch-guard"/.test(packageSource)) fail('package.json should expose the guitar tab track-switch guard test');

console.log(log.join('\n') + '\n' + (pass ? '[guitar-tab-guard-test] PASS' : '[guitar-tab-guard-test] FAIL'));
process.exitCode = pass ? 0 : 1;
